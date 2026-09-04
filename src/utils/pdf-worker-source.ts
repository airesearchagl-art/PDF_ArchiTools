import * as pdfjsLib from 'pdfjs-dist';

/** Worker bundled with the app, never a CDN. */
export const PDF_WORKER_URL = '/pdf.worker.min.mjs';

/**
 * Point PDF.js at our own worker, immediately before it is used.
 *
 * `GlobalWorkerOptions.workerSrc` is a single global and several modules in this
 * app assign it at module scope, three of them to unpkg. In a production bundle
 * they all evaluate on load and the last one wins, so a feature that only sets
 * the global at import time can silently end up fetching its worker from a CDN
 * depending on import order. M1 hit exactly that and fixed it the same way.
 *
 * Calling this right before `getDocument` makes the behaviour independent of
 * import order and keeps every request same-origin. The Textifier keeps its own
 * copy of this helper; unifying them would mean touching modules this change has
 * no business in.
 */
export function configurePdfWorker(): void {
    if (pdfjsLib.GlobalWorkerOptions.workerSrc !== PDF_WORKER_URL) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    }
}

// A sane default at import time as well, so anything reaching pdf.js without
// going through the call above still gets our worker. The point-of-use call is
// what survives another module overwriting the global afterwards.
configurePdfWorker();
