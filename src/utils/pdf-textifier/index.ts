import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { classifyDocument } from './classify';
import { OcrEngine } from './ocr';
import { configurePdfWorker, loadWithPdfJs, releaseCanvas, renderPageForOcr } from './pdf-source';
import { preprocessForOcr } from './preprocess';
import { drawInvisibleWords } from './searchable-pdf';
import { TextifyError } from './types';
import type { PageResult, PagePreprocessInfo, TextifyOptions, TextifyResult } from './types';
import type { OcrPreprocessResult } from './preprocess';

const FONT_URL = '/ocr/fonts/MPLUS1p-Regular.ttf';
const DEFAULT_DPI = 150;

export * from './types';
export { classifyPage, classifyDocument } from './classify';
export { configurePdfWorker } from './pdf-source';
export { extractTextPdf, PAGE_HEADER_PREFIX, pageHeader } from './extract';
export { preprocessForOcr } from './preprocess';
export type { OcrPreprocessOptions, OcrPreprocessResult } from './preprocess';

/** Report only what preprocessing actually did, not the internals of how. */
export function summarise(prep: OcrPreprocessResult): PagePreprocessInfo {
    return {
        ...(prep.skipped ? { skipped: prep.skipped } : {}),
        deskewApplied: prep.deskewApplied,
        detectedAngle: prep.detectedAngle,
        deskewConfidence: prep.deskewConfidence,
        noiseReductionApplied: prep.noiseReductionApplied,
        removedSpecks: prep.removedSpecks,
        processingMs: prep.processingMs,
    };
}

/**
 * Tell the user when preprocessing was asked for and could not be given.
 *
 * A page past the size budget is still recognised -- from the image exactly as
 * rendered -- so the run succeeds and the file is downloadable. What must not
 * happen is the screen reporting success while quietly having skipped the very
 * thing the user ticked a box for. Returns null when there is nothing to say.
 *
 * Pure, and exported here rather than from the component, so the gate can hold
 * it to a table of cases without driving a browser.
 */
export function preprocessSkipNotice(
    pages: readonly { preprocess?: PagePreprocessInfo }[],
): string | null {
    const skipped = pages.filter((p) => p.preprocess?.skipped === 'page-too-large').length;
    if (skipped === 0) return null;
    return `ページサイズが大きいため、${skipped} ページではOCR前処理を行わず文字認識しました。元PDFは変更されていません。`;
}

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
        preprocess,
        onProgress = () => { },
        shouldCancel = () => false,
    } = options;

    // Off unless asked for: M1 behaved a certain way before this existed and a
    // run that was not asked to clean anything must still behave that way.
    const preprocessOptions = {
        deskew: preprocess?.deskew === true,
        noiseReduction: preprocess?.noiseReduction === true,
    };
    const preprocessRequested = preprocessOptions.deskew || preprocessOptions.noiseReduction;

    configurePdfWorker();

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
            let processed: HTMLCanvasElement | null = null;
            try {
                const rendered = await renderPageForOcr(page, scale);
                canvas = rendered.canvas;

                // Cleaned for recognition only, and nothing produced here
                // reaches the document. Speckle removal writes onto this canvas
                // in place rather than copying a whole A0 sheet; that is safe
                // because the text layer is placed from `rendered.viewport`,
                // never from these pixels.
                const prep = await preprocessForOcr(canvas, preprocessOptions);
                if (prep.ownsCanvas) processed = prep.canvas;

                // A boundary of its own. Preprocessing can take a moment on a
                // large sheet, and recognition cannot be interrupted once it
                // starts, so this is the last chance to stop cheaply.
                if (shouldCancel()) { cancelled = true; break; }

                const ocr = await engine.recognisePage(prep.canvas);
                const fontName = outPages[pageNumber - 1].node.newFontDictionary('OcrFont', font.ref);
                const placed = drawInvisibleWords(
                    outPages[pageNumber - 1], fontName, font, ocr.words, rendered.viewport,
                    prep.mapToRenderSpace,
                );

                pages.push({
                    pageNumber, kind,
                    ocrWords: ocr.words.length,
                    placed,
                    meanConfidence: ocr.meanConfidence,
                    textSample: ocr.text.replace(/\s+/g, ' ').trim().slice(0, 200),
                    ms: Math.round(performance.now() - pageStart),
                    ...(preprocessRequested ? { preprocess: summarise(prep) } : {}),
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
                // Both images go at the end of the page. `processed` is set
                // only when preprocessing made a second canvas; when it did
                // not, the OCR image is `canvas` itself and there is nothing
                // extra to free. One page at a time is the whole point.
                releaseCanvas(processed);
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
