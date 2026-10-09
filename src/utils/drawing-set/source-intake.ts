/**
 * One file into the Drawing Set, as one transaction.
 *
 *   preflight (name, size, room left -- nothing read, nothing allocated)
 *   -> allocate the one analysis buffer, exactly file.size
 *   -> read in bounded chunks into it, fingerprinting each chunk in the Worker
 *   -> duplicate check: SHA-256 against the live Sources
 *   -> PDF.js opens the analysis buffer (it is transferred to PDF.js, not copied)
 *   -> page-count gate, before any page is read
 *   -> inventory every page, one at a time
 *   -> destroy the intake document, release the bytes
 *   -> a Source with all its Sheets, built off to the side
 *
 * Nothing here touches the Drawing Set. The caller commits the candidate in a
 * single step (commitSourceCandidate) or not at all, so a file that fails at
 * any point leaves no Source and no Sheet behind, and the Sources already
 * accepted are untouched.
 *
 * file.type is never consulted: it can be empty or wrong. PDF.js accepting the
 * bytes is the proof that they are a PDF. file.name is a display label only.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import { fingerprintIntoBuffer } from './fingerprint-client';
import type { IntakeRefusal } from './intake-policy';
import { cancelledStop, checkPageCount, IntakeStop, preflight, refusal } from './intake-policy';
import type { DrawingSet, InventoriedPage, Source, SourceCandidate } from './model';
import { buildSourceCandidate, heldCounts, liveSourceWithContent, nowTimestamp } from './model';
import { hasMeaningfulText, pageBoxFacts, pageKindFor } from './page-facts';

export type IntakeProgress =
    | { phase: 'reading'; bytesDone: number; bytesTotal: number }
    | { phase: 'opening' }
    | { phase: 'inventory'; pagesDone: number; pagesTotal: number };

export type IntakeOutcome =
    | { kind: 'candidate'; candidate: SourceCandidate }
    | { kind: 'duplicate'; sha256: string; existing: Source }
    | { kind: 'refused'; refusal: IntakeRefusal }
    | { kind: 'cancelled' };

export interface IntakeContext {
    signal: AbortSignal;
    /** The Drawing Set as it is now; read at each gate rather than captured once. */
    current: () => DrawingSet;
    onProgress?: (progress: IntakeProgress) => void;
    /** Bytes per read; tests vary it. */
    chunkBytes?: number;
    /** How the analysis buffer is allocated; tests observe it. */
    allocate?: (size: number) => Uint8Array;
}

/** Timings of the last intake, for local performance evidence. Durations only. */
const measure = (name: string, start: number): void => {
    try {
        performance.clearMeasures(name);
        performance.measure(name, { start, end: performance.now() });
    } catch {
        // User Timing is a convenience, never a requirement.
    }
};

/**
 * Whether the page's native text has at least one meaningful character.
 *
 * The page's text is read whole and dropped as soon as it has been looked at;
 * none of it is kept. (Cancelling PDF.js's text stream part-way makes PDF.js
 * throw uncaught errors from inside its message handler, so the stream is not
 * cut short.)
 */
async function pageHasNativeText(page: PDFPageProxy, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) throw cancelledStop();
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: true });
    if (signal.aborted) throw cancelledStop();
    for (const item of content.items) {
        const text = (item as { str?: unknown }).str;
        if (typeof text === 'string' && hasMeaningfulText(text)) return true;
    }
    return false;
}

async function inventory(
    doc: PDFDocumentProxy,
    signal: AbortSignal,
    onProgress: IntakeContext['onProgress'],
): Promise<InventoriedPage[]> {
    const pages: InventoriedPage[] = [];
    const total = doc.numPages;
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
        if (signal.aborted) throw cancelledStop();
        let page: PDFPageProxy;
        try {
            page = await doc.getPage(pageNumber);
        } catch {
            if (signal.aborted) throw cancelledStop();
            throw new IntakeStop(refusal('PAGE_READ_FAILED', `${pageNumber}ページ目を読み取れないため、このファイルは読み込めません。`));
        }
        try {
            const box = pageBoxFacts({ view: page.view, rotate: page.rotate, userUnit: page.userUnit, pageNumber });
            if (!box.ok) throw new IntakeStop(box.refusal);
            let hasText: boolean;
            try {
                hasText = await pageHasNativeText(page, signal);
            } catch (error) {
                if (error instanceof IntakeStop) throw error;
                if (signal.aborted) throw cancelledStop();
                throw new IntakeStop(refusal('PAGE_READ_FAILED', `${pageNumber}ページ目の内容を読み取れないため、このファイルは読み込めません。`));
            }
            pages.push({
                uprightWidthPt: box.uprightWidthPt,
                uprightHeightPt: box.uprightHeightPt,
                rotate: box.rotate,
                kind: pageKindFor(hasText),
            });
        } finally {
            page.cleanup();
        }
        onProgress?.({ phase: 'inventory', pagesDone: pageNumber, pagesTotal: total });
    }
    return pages;
}

/** Take one file through the whole transaction. Never throws; every ending is an outcome. */
export async function intakeSource(file: File, context: IntakeContext): Promise<IntakeOutcome> {
    const { signal, onProgress } = context;
    try {
        if (signal.aborted) throw cancelledStop();
        const gate = preflight(file, heldCounts(context.current()));
        if (gate) return { kind: 'refused', refusal: gate };

        // The one full-size buffer: allocated only now that the size is known
        // to be within the ceiling.
        let analysis: Uint8Array | null;
        try {
            analysis = (context.allocate ?? ((size: number) => new Uint8Array(size)))(file.size);
        } catch {
            return { kind: 'refused', refusal: refusal('MEMORY_UNAVAILABLE', 'このファイルを読み込むためのメモリを確保できませんでした。ほかのタブやアプリを閉じてからやり直してください。') };
        }

        const readStart = performance.now();
        onProgress?.({ phase: 'reading', bytesDone: 0, bytesTotal: file.size });
        const sha256 = await fingerprintIntoBuffer(file, analysis, {
            signal,
            chunkBytes: context.chunkBytes,
            onProgress: (bytesDone) => onProgress?.({ phase: 'reading', bytesDone, bytesTotal: file.size }),
        });
        const recordedAt = nowTimestamp();
        measure('drawing-set:read-and-fingerprint', readStart);

        const existing = liveSourceWithContent(context.current(), sha256);
        if (existing) return { kind: 'duplicate', sha256, existing };
        if (signal.aborted) throw cancelledStop();

        onProgress?.({ phase: 'opening' });
        const openStart = performance.now();
        configurePdfWorker();
        // PDF.js takes the buffer itself (it is transferred to its worker), so
        // the main thread keeps no copy; the reference is dropped as well.
        const task = pdfjsLib.getDocument({ data: analysis, isEvalSupported: false, disableFontFace: true });
        analysis = null;
        const abortTask = (): void => {
            task.destroy().catch(() => { });
        };
        signal.addEventListener('abort', abortTask, { once: true });
        try {
            let doc: PDFDocumentProxy;
            try {
                doc = await task.promise;
            } catch (error) {
                if (signal.aborted) throw cancelledStop();
                if ((error as { name?: string })?.name === 'PasswordException') {
                    throw new IntakeStop(refusal('PASSWORD_PROTECTED', 'パスワードで保護されたPDFは読み込めません。'));
                }
                throw new IntakeStop(refusal('NOT_A_PDF', 'PDFとして読み取れないため、読み込めません。ファイルが壊れていないか確認してください。'));
            }
            measure('drawing-set:pdf-open', openStart);
            if (signal.aborted) throw cancelledStop();

            const pageGate = checkPageCount(doc.numPages, heldCounts(context.current()));
            if (pageGate) return { kind: 'refused', refusal: pageGate };

            const inventoryStart = performance.now();
            onProgress?.({ phase: 'inventory', pagesDone: 0, pagesTotal: doc.numPages });
            const pages = await inventory(doc, signal, onProgress);
            measure('drawing-set:inventory', inventoryStart);
            if (signal.aborted) throw cancelledStop();

            return {
                kind: 'candidate',
                candidate: buildSourceCandidate({
                    displayName: file.name,
                    sha256,
                    byteLength: file.size,
                    recordedAt,
                    pages,
                }),
            };
        } finally {
            signal.removeEventListener('abort', abortTask);
            // The intake document is never kept: the preview opens its own,
            // one at a time, when a Sheet is selected.
            await task.destroy().catch(() => { });
        }
    } catch (error) {
        if (error instanceof IntakeStop) {
            return error.refusal ? { kind: 'refused', refusal: error.refusal } : { kind: 'cancelled' };
        }
        if (signal.aborted) return { kind: 'cancelled' };
        return { kind: 'refused', refusal: refusal('FILE_READ_FAILED', 'このファイルを読み込めませんでした。') };
    }
}
