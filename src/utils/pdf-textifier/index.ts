import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { classifyDocument } from './classify';
import { OcrEngine } from './ocr';
import { drawInvisibleWords } from './searchable-pdf';
import { TextifyError } from './types';
import { resetTrace, trace, getTrace } from './diagnostics';   // TEMPORARY
import type { PageResult, TextifyOptions, TextifyResult } from './types';

/** Worker bundled with the app, never a CDN. */
const PDF_WORKER_URL = '/pdf.worker.min.mjs';

/**
 * Point PDF.js at our own worker.
 *
 * `GlobalWorkerOptions.workerSrc` is one global, and several components in this
 * app assign it at module scope -- three of them to unpkg. In a production
 * bundle they all evaluate on load and the last one wins, which is how the
 * shipped app ended up fetching its PDF.js worker from a CDN. Setting it at the
 * point of use makes this feature's behaviour independent of import order, and
 * keeps every request same-origin.
 */
export function configurePdfWorker(): void {
    if (pdfjsLib.GlobalWorkerOptions.workerSrc !== PDF_WORKER_URL) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    }
}

// Set a sane default the moment this module is imported, so any caller that
// reaches pdf.js directly (the classifier, a test harness) still gets our
// worker. The point-of-use call above is what survives another module
// overwriting the global afterwards.
configurePdfWorker();

const FONT_URL = '/ocr/fonts/MPLUS1p-Regular.ttf';
const DEFAULT_DPI = 150;

export * from './types';
export { getTrace } from './diagnostics';   // TEMPORARY
export { classifyPage, classifyDocument } from './classify';

/**
 * Turn a PDF into a searchable PDF, entirely in the browser.
 *
 * Pages that already carry text are left untouched and never reach the OCR
 * engine. Scanned pages are rendered, recognised, and given an invisible text
 * layer positioned over the original image. The original page content is never
 * rasterised or replaced, so the output looks exactly like the input.
 */
export async function textifyPdf(
    file: File | ArrayBuffer,
    options: TextifyOptions = {},
): Promise<TextifyResult> {
    const {
        langs = 'jpn+eng',
        dpi = DEFAULT_DPI,
        onProgress = () => { },
        shouldCancel = () => false,
    } = options;

    configurePdfWorker();
    resetTrace();   // TEMPORARY: trace lands on window.__textifierTrace

    const startedAt = performance.now();
    const source = file instanceof File ? await file.arrayBuffer() : file;
    const inputBytes = source.byteLength;

    onProgress({ phase: 'loading', message: 'PDFを読み込み中...' });

    // pdf.js detaches the buffer it is given, so each library gets its own copy.
    const doc = await loadWithPdfJs(source.slice(0));
    const out = await loadWithPdfLib(source.slice(0));

    const totalPages = doc.numPages;

    onProgress({ phase: 'classifying', totalPages, message: 'ページを判定中...' });
    const classifications = await classifyDocument(doc, (page) => {
        onProgress({
            phase: 'classifying',
            page,
            totalPages,
            message: `ページを判定中... ${page} / ${totalPages}`,
        });
    });

    const scannedPages = classifications.filter((c) => c.kind === 'scanned');
    const pages: PageResult[] = [];
    let cancelled = false;
    let fontEmbedded = false;

    // Nothing to OCR: return the document untouched rather than embedding a
    // ~1.7 MB Japanese font that would never be used. This is why the font is
    // loaded here and not when the file is opened.
    if (scannedPages.length === 0) {
        for (const c of classifications) {
            pages.push({
                pageNumber: c.pageNumber,
                kind: c.kind,
                ocrWords: 0,
                placed: 0,
                meanConfidence: null,
                textSample: '',
                ms: 0,
            });
        }
        const untouched = await save(out);
        onProgress({ phase: 'done', totalPages, message: '完了しました。' });
        return {
            bytes: untouched,
            pages,
            cancelled: false,
            fontEmbedded: false,
            inputBytes,
            outputBytes: untouched.length,
            totalMs: Math.round(performance.now() - startedAt),
        };
    }

    let pageProgress = 0;
    const engine = new OcrEngine(langs, (p) => { pageProgress = p; });
    const outPages = out.getPages();
    const scale = dpi / 72;

    try {
        onProgress({ phase: 'ocr-init', totalPages, message: 'OCRエンジンを準備中...' });
        await engine.start();

        // Correctness first: subset:false. @pdf-lib/fontkit 1.1.1 has a known CJK
        // subsetting bug that drops glyphs, and while an invisible layer happens
        // to survive it, M1 does not depend on a font-corruption bug staying
        // harmless. The size cost is accepted.
        const font = await out.embedFont(await fetchFont(), { subset: false });
        fontEmbedded = true;

        for (const classification of classifications) {
            if (shouldCancel()) { cancelled = true; break; }

            const { pageNumber, kind } = classification;
            const pageStart = performance.now();

            if (kind === 'text-native') {
                pages.push({
                    pageNumber, kind, ocrWords: 0, placed: 0,
                    meanConfidence: null, textSample: '',
                    ms: Math.round(performance.now() - pageStart),
                });
                continue;
            }

            pageProgress = 0;
            onProgress({
                phase: 'ocr-page',
                page: pageNumber,
                totalPages,
                pageProgress: 0,
                message: `文字認識中... ページ ${pageNumber} / ${totalPages}`,
            });

            const page = await doc.getPage(pageNumber);
            let canvas: HTMLCanvasElement | null = null;
            try {
                const rendered = await renderPage(page, scale);
                canvas = rendered.canvas;

                const ocr = await engine.recognisePage(canvas);
                const fontName = outPages[pageNumber - 1].node.newFontDictionary('OcrFont', font.ref);
                const placed = drawInvisibleWords(
                    outPages[pageNumber - 1], fontName, font, ocr.words, rendered.viewport,
                );

                pages.push({
                    pageNumber, kind,
                    ocrWords: ocr.words.length,
                    placed,
                    meanConfidence: ocr.meanConfidence,
                    textSample: ocr.text.replace(/\s+/g, ' ').trim().slice(0, 200),
                    ms: Math.round(performance.now() - pageStart),
                });

                onProgress({
                    phase: 'ocr-page',
                    page: pageNumber,
                    totalPages,
                    pageProgress: Math.max(pageProgress, 1),
                    message: `文字認識中... ページ ${pageNumber} / ${totalPages}`,
                });
            } catch (error) {
                // A stalled page kills the worker, so there is nothing left to
                // continue with -- surface it instead of pretending otherwise.
                if (error instanceof TextifyError && error.fatal) throw error;
                // Otherwise one bad page should not cost the whole document.
                // Record it and carry on; the caller surfaces it.
                pages.push({
                    pageNumber, kind, ocrWords: 0, placed: 0,
                    meanConfidence: null, textSample: '',
                    ms: Math.round(performance.now() - pageStart),
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                releaseCanvas(canvas);
                page.cleanup();
            }
        }
    } finally {
        // Always tear the worker down, including on cancellation: it holds the
        // WASM heap and there is no way to abort a recognition in flight.
        await engine.terminate();
    }

    if (cancelled) {
        onProgress({ phase: 'cancelled', totalPages, message: 'キャンセルされました。' });
        throw new TextifyError('cancelled', '処理をキャンセルしました。');
    }

    onProgress({ phase: 'writing', totalPages, message: '検索可能PDFを生成中...' });
    const bytes = await save(out);
    onProgress({ phase: 'done', totalPages, message: '完了しました。' });

    trace('run:done', { events: getTrace().length });   // TEMPORARY
    return {
        bytes,
        pages,
        cancelled: false,
        fontEmbedded,
        inputBytes,
        outputBytes: bytes.length,
        totalMs: Math.round(performance.now() - startedAt),
    };
}

async function loadWithPdfJs(data: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
    try {
        return await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'PasswordException') {
            throw new TextifyError('pdf-encrypted', 'このPDFはパスワードで保護されているため処理できません。');
        }
        throw new TextifyError(
            'pdf-load',
            'PDFを読み込めませんでした。ファイルが破損している可能性があります。',
            error instanceof Error ? error.message : String(error),
        );
    }
}

async function loadWithPdfLib(data: ArrayBuffer): Promise<PDFDocument> {
    try {
        const doc = await PDFDocument.load(data);
        doc.registerFontkit(fontkit);
        return doc;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/encrypt/i.test(message)) {
            throw new TextifyError('pdf-encrypted', 'このPDFはパスワードで保護されているため処理できません。');
        }
        throw new TextifyError('pdf-load', 'PDFを読み込めませんでした。', message);
    }
}

async function fetchFont(): Promise<ArrayBuffer> {
    const response = await fetch(FONT_URL);
    if (!response.ok) {
        throw new TextifyError(
            'ocr-assets',
            '日本語フォントの読み込みに失敗しました。',
            `${FONT_URL} -> HTTP ${response.status}`,
        );
    }
    return response.arrayBuffer();
}

async function renderPage(page: PDFPageProxy, scale: number) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    trace('render:start', { page: page.pageNumber, scale, width: canvas.width, height: canvas.height });   // TEMPORARY
    // Ask for the read-friendly context first: pdf.js reuses whatever context
    // the canvas already has, and Tesseract reads the pixels back out.
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new TextifyError('ocr-page', 'ページの描画に失敗しました。');
    await page.render({ canvas, viewport }).promise;
    trace('render:done', { page: page.pageNumber });   // TEMPORARY
    return { canvas, viewport };
}

/** Drop the backing store immediately; one page at a time is the whole point. */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
    try {
        return await doc.save();
    } catch (error) {
        throw new TextifyError(
            'output',
            '検索可能PDFの生成に失敗しました。',
            error instanceof Error ? error.message : String(error),
        );
    }
}
