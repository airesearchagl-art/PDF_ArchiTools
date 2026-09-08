import * as pdfjsLib from 'pdfjs-dist';

/** Worker bundled with the app, never a CDN. */
export const PDF_WORKER_URL = '/pdf.worker.min.mjs';

/**
 * Point PDF.js at our own worker, immediately before it is used.
 *
 * `GlobalWorkerOptions.workerSrc` is a single global that several modules in
 * this app write to. In a production bundle they all evaluate on load and the
 * last one wins, so a feature that only sets the global at import time has no
 * control over which worker it actually fetches -- it depends on module
 * evaluation order. Three of them used to assign a CDN, and the shipped app
 * really did fetch its worker from unpkg because of it.
 *
 * Every known production PDF.js entry point now calls this immediately before
 * `getDocument`, so the outcome no longer depends on import order and every
 * worker request is same-origin. The Textifier keeps its own copy of this
 * helper with the same contract; unifying the two would mean touching modules
 * this has no business in.
 *
 * There is deliberately no CDN fallback. If the bundled worker is missing, the
 * right outcome is a failure, not a quiet request to somebody else's server.
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
