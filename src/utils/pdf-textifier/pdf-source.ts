import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { TextifyError } from './types';

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

/**
 * Open the document with PDF.js, turning its failures into codes the UI can act
 * on. A password-protected file and a corrupt one are different problems for the
 * person holding the PDF, so they must not collapse into one message.
 */
export async function loadWithPdfJs(data: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
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

/**
 * Rasterise one page for the OCR engine.
 *
 * intent 'print', not the default 'display'. pdf.js schedules display rendering
 * with requestAnimationFrame (`useRequestAnimationFrame: !intentPrint`), and rAF
 * does not fire while a tab is hidden -- so the render promise simply never
 * settles and the whole pipeline stalls with no error. This canvas is never
 * shown to anyone; it exists only to feed the OCR engine, so it must not depend
 * on the page being visible. Print intent schedules on microtasks instead.
 */
export async function renderPageForOcr(page: PDFPageProxy, scale: number) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // Ask for the read-friendly context first: pdf.js reuses whatever context
    // the canvas already has, and Tesseract reads the pixels back out.
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new TextifyError('ocr-page', 'ページの描画に失敗しました。');
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    return { canvas, viewport };
}

/** Drop the backing store immediately; one page at a time is the whole point. */
export function releaseCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}
