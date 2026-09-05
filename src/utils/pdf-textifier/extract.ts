import type { PDFPageProxy } from 'pdfjs-dist';

import { classifyDocument } from './classify';
import { OcrEngine } from './ocr';
import { configurePdfWorker, loadWithPdfJs, releaseCanvas, renderPageForOcr } from './pdf-source';
import { TextifyError } from './types';
import type { ExtractedPage, TextExtractionResult, TextifyOptions } from './types';

const DEFAULT_DPI = 150;

/**
 * Marker that opens every page block in the exported TXT.
 *
 * A plain text file has no pages, so without this the boundary between one
 * sheet and the next is simply gone -- and for a drawing set, "which sheet did
 * this note come from" is most of the value. Exported so the smoke gates assert
 * the exact string the app writes rather than a copy of it.
 */
export const PAGE_HEADER_PREFIX = '===== Page ';

export function pageHeader(pageNumber: number): string {
    return `${PAGE_HEADER_PREFIX}${pageNumber} =====`;
}

/** getTextContent returns text items mixed with marked-content markers. */
interface TextItemLike {
    str: string;
    hasEOL?: boolean;
}

function isTextItem(item: unknown): item is TextItemLike {
    return typeof item === 'object' && item !== null
        && typeof (item as Partial<TextItemLike>).str === 'string';
}

/**
 * Tidy the line endings without touching the characters themselves.
 *
 * A drawing's text is the deliverable here: Japanese punctuation, full-width
 * digits and part numbers all have to come out exactly as the PDF holds them.
 * So this normalises CRLF to LF and drops whitespace sitting at the end of a
 * line, and nothing else. No transliteration, no width folding, no "smart"
 * substitution.
 */
function normaliseText(raw: string): string {
    return raw
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\u00a0]+$/gm, '')
        .replace(/^\n+|\n+$/g, '');
}

/**
 * Read the text PDF.js already holds for a page.
 *
 * The item order pdf.js reports is taken as the reading order. That is the MVP
 * rule, and it is honest about its limits: a complex multi-column sheet or a
 * table can come out in an order that does not match how the page looks.
 * Improving on that means reconstructing layout, which this deliberately is not.
 */
async function extractNativeText(page: PDFPageProxy): Promise<string> {
    const content = await page.getTextContent();
    let out = '';
    for (const item of content.items) {
        if (!isTextItem(item)) continue;
        out += item.str;
        // pdf.js marks the item that ends a line. Where that is available it is
        // a better line break than one guessed from coordinates.
        if (item.hasEOL) out += '\n';
    }
    return normaliseText(out);
}

/**
 * Extract the text of a PDF as plain text, entirely in the browser.
 *
 * Pages that already carry text are read straight from the PDF and never reach
 * the OCR engine; scanned pages are rendered and recognised. The OCR result is
 * used directly -- there is deliberately no detour through a searchable PDF,
 * which would mean writing a file and embedding a Japanese font only to read
 * the same text back out again.
 *
 * Fails closed. A page that cannot be read is not silently dropped: missing
 * characters in a TXT look exactly like a page that had none, so a partial
 * result would be indistinguishable from a correct one.
 */
export async function extractTextPdf(
    file: File | ArrayBuffer,
    options: TextifyOptions = {},
): Promise<TextExtractionResult> {
    const {
        langs = 'jpn+eng',
        dpi = DEFAULT_DPI,
        onProgress = () => { },
        shouldCancel = () => false,
    } = options;

    configurePdfWorker();

    const startedAt = performance.now();
    const source = file instanceof File ? await file.arrayBuffer() : file;

    onProgress({ phase: 'loading', message: 'PDFを読み込み中...' });
    const doc = await loadWithPdfJs(source.slice(0));
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

    const needsOcr = classifications.some((c) => c.kind === 'scanned');
    const pages: ExtractedPage[] = [];
    let cancelled = false;

    // A document with no scanned page must not pay for the OCR engine: the
    // worker, the WASM core and two language files are several megabytes that
    // would never be used. That is why the engine is only created below.
    let engine: OcrEngine | null = null;
    let pageProgress = 0;
    const scale = dpi / 72;

    try {
        if (needsOcr) {
            onProgress({ phase: 'ocr-init', totalPages, message: 'OCRエンジンを準備中...' });
            engine = new OcrEngine(langs, (p) => { pageProgress = p; });
            await engine.start();
        }

        for (const classification of classifications) {
            if (shouldCancel()) { cancelled = true; break; }

            const { pageNumber, kind } = classification;
            const pageStart = performance.now();

            if (kind === 'text-native') {
                onProgress({
                    phase: 'extracting',
                    page: pageNumber,
                    totalPages,
                    message: `文字を抽出中... ${pageNumber} / ${totalPages}`,
                });
                const page = await doc.getPage(pageNumber);
                try {
                    const text = await extractNativeText(page);
                    pages.push({
                        pageNumber, kind, text,
                        charCount: text.length,
                        ocrWords: 0,
                        meanConfidence: null,
                        ms: Math.round(performance.now() - pageStart),
                    });
                } catch (error) {
                    throw new TextifyError(
                        'text-extract',
                        `${pageNumber} ページの文字を取得できませんでした。`,
                        error instanceof Error ? error.message : String(error),
                    );
                } finally {
                    page.cleanup();
                }
                continue;
            }

            pageProgress = 0;
            onProgress({
                phase: 'ocr-page',
                page: pageNumber,
                totalPages,
                pageProgress: 0,
                message: `文字認識中... ${pageNumber} / ${totalPages}`,
            });

            const page = await doc.getPage(pageNumber);
            let canvas: HTMLCanvasElement | null = null;
            try {
                const rendered = await renderPageForOcr(page, scale);
                canvas = rendered.canvas;

                // Non-null: `engine` is created whenever any page is scanned,
                // and this branch only runs for a scanned page.
                const ocr = await engine!.recognisePage(canvas);
                const text = normaliseText(ocr.text ?? '');
                pages.push({
                    pageNumber, kind, text,
                    charCount: text.length,
                    ocrWords: ocr.words.length,
                    meanConfidence: ocr.meanConfidence,
                    ms: Math.round(performance.now() - pageStart),
                });

                onProgress({
                    phase: 'ocr-page',
                    page: pageNumber,
                    totalPages,
                    pageProgress: Math.max(pageProgress, 1),
                    message: `文字認識中... ${pageNumber} / ${totalPages}`,
                });
            } finally {
                // One page at a time: the raster goes as soon as it is read.
                releaseCanvas(canvas);
                page.cleanup();
            }
        }

        // The end of the last page is a page boundary too.
        //
        // The check at the top of the loop only ever runs before a page, so on
        // its own it cannot see a cancel that arrived while the final page was
        // being recognised -- and for a single-page scan there is no "final
        // page" but the first. Recognition cannot be aborted in flight, so that
        // page finishes either way; what must not happen is the run then
        // reporting success and handing back an export the user cancelled.
        if (!cancelled && shouldCancel()) cancelled = true;
    } finally {
        // Always tear the worker down, including on cancellation: it holds the
        // WASM heap and there is no way to abort a recognition in flight.
        await engine?.terminate();
    }

    if (cancelled) {
        onProgress({ phase: 'cancelled', totalPages, message: 'キャンセルされました。' });
        throw new TextifyError('cancelled', '処理をキャンセルしました。');
    }

    onProgress({ phase: 'writing', totalPages, message: 'テキストを書き出し中...' });
    const text = buildDocumentText(pages);
    onProgress({ phase: 'done', totalPages, message: '完了しました。' });

    return {
        text,
        pages,
        totalChars: pages.reduce((sum, p) => sum + p.charCount, 0),
        totalMs: Math.round(performance.now() - startedAt),
        ocrUsed: needsOcr,
    };
}

/**
 * Assemble the pages into one document, in the order the PDF has them.
 *
 * A page that yielded nothing still gets its header: dropping it would silently
 * renumber everything after it, and the reader would have no way to tell.
 */
function buildDocumentText(pages: ExtractedPage[]): string {
    return pages
        .map((p) => `${pageHeader(p.pageNumber)}\n${p.text ? `\n${p.text}\n` : '\n'}`)
        .join('\n');
}
