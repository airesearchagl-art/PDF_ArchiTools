/**
 * Who may hold a PDF.js document, and when -- across intake, the preview and
 * title-block extraction.
 *
 * Each PDF.js document is a worker holding a whole file. M7-P1 bounds the
 * preview to one document and has intake destroy each document it opens.
 * Extraction is exclusive on top of that: while it runs, it is the only
 * holder, and it holds at most one document at a time.
 *  - It does not start while intake is taking a file in, and intake does not
 *    start while it runs.
 *  - Starting it closes the preview and waits until PDF.js has destroyed the
 *    preview's document (or reported that it could not); no preview opens
 *    until it ends.
 *  - It opens one document, and the next only once PDF.js has destroyed the
 *    previous one.
 *
 * A destruction PDF.js reports as failed leaves its document running, so
 * nothing says it is gone. From then on the gate opens nothing for anyone:
 * extraction, the preview and intake are all refused, with the same way out
 * as M7-P1 -- reload the page, which ends every worker. One gate serves the
 * whole page, so leaving the workspace and coming back does not get round it.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import { m7PdfDocumentAssets } from './pdf-document-assets';

export type GateRefusalCode = 'INTAKE_ACTIVE' | 'EXTRACTION_ACTIVE' | 'RELEASE_UNCONFIRMED';

/** A preview owner, as the gate needs it: something it can close and wait for. */
export interface PreviewHolder {
    /** Resolves once the held document is destroyed, or its destruction failed. Never rejects. */
    close(): Promise<void>;
}

/** Counts only, for tests and evidence; nothing about any file. */
export interface GateCounts {
    extractionsStarted: number;
    extractionsRefused: number;
    intakesStarted: number;
    intakesRefused: number;
    /** Extraction documents handed to PDF.js. */
    opened: number;
    destroyRequested: number;
    /** Extraction documents PDF.js has finished destroying. */
    destroyed: number;
    destroyFailed: number;
    /** Extraction documents not known to be gone. */
    live: number;
    peakLive: number;
}

export interface ExtractionDocument {
    doc: PDFDocumentProxy;
    /** Destroy it and wait for PDF.js. False: PDF.js reported the destruction failed. Idempotent. */
    close(): Promise<boolean>;
}

export type OpenOutcome =
    | { ok: true; document: ExtractionDocument }
    | { ok: false; code: 'RELEASE_UNCONFIRMED' | 'OPEN_FAILED' | 'DOCUMENT_ALREADY_OPEN' | 'LEASE_ENDED' };

/** Extraction's hold on the gate, from start to end. */
export interface ExtractionLease {
    /** Open one extraction document from bytes PDF.js takes over. */
    openDocument(bytes: Uint8Array): Promise<OpenOutcome>;
    /** Give the gate back. The caller closes its document first. */
    end(): void;
}

export const GATE_MESSAGES: Record<GateRefusalCode, string> = {
    INTAKE_ACTIVE: 'ファイルの読み込み中は表題欄を読み取れません。読み込みが終わってから実行してください。',
    EXTRACTION_ACTIVE: '表題欄の読み取り中は、この操作はできません。',
    RELEASE_UNCONFIRMED: '前に開いたPDFを閉じられたか確認できないため、処理できません。ページを再読み込みしてください。図面一式は保存されていないため、再読み込みの後でファイルを追加し直してください。',
};

export class PdfDocumentGate {
    private phase: 'idle' | 'starting' | 'active' = 'idle';
    private intakes = 0;
    private unconfirmed = false;
    private readonly previews = new Set<PreviewHolder>();
    private readonly tally = {
        extractionsStarted: 0, extractionsRefused: 0, intakesStarted: 0, intakesRefused: 0,
        opened: 0, destroyRequested: 0, destroyed: 0, destroyFailed: 0, live: 0, peakLive: 0,
    };

    /** True from the moment extraction asks to start until it ends. */
    get extractionActive(): boolean {
        return this.phase !== 'idle';
    }

    get releaseUnconfirmed(): boolean {
        return this.unconfirmed;
    }

    /** A document somewhere could not be destroyed: open nothing again. */
    noteReleaseUnconfirmed(): void {
        this.unconfirmed = true;
    }

    /** Let the gate close this preview before extraction starts. Returns the unregister call. */
    registerPreview(holder: PreviewHolder): () => void {
        this.previews.add(holder);
        return () => { this.previews.delete(holder); };
    }

    /** Intake's hold, for the duration of taking one file in. */
    beginIntake(): { ok: true; end: () => void } | { ok: false; code: GateRefusalCode } {
        const refusal = this.unconfirmed ? 'RELEASE_UNCONFIRMED' : this.phase !== 'idle' ? 'EXTRACTION_ACTIVE' : null;
        if (refusal) {
            this.tally.intakesRefused += 1;
            return { ok: false, code: refusal };
        }
        this.intakes += 1;
        this.tally.intakesStarted += 1;
        let ended = false;
        return {
            ok: true,
            end: () => {
                if (ended) return;
                ended = true;
                this.intakes -= 1;
            },
        };
    }

    /**
     * Start extraction: refused while intake runs, another extraction runs, or
     * a document could not be destroyed. Otherwise the previews are closed and
     * waited for before the lease is handed over.
     */
    async beginExtraction(): Promise<{ ok: true; lease: ExtractionLease } | { ok: false; code: GateRefusalCode }> {
        const refusal = this.unconfirmed ? 'RELEASE_UNCONFIRMED'
            : this.phase !== 'idle' ? 'EXTRACTION_ACTIVE'
                : this.intakes > 0 ? 'INTAKE_ACTIVE' : null;
        if (refusal) {
            this.tally.extractionsRefused += 1;
            return { ok: false, code: refusal };
        }
        this.phase = 'starting';
        await Promise.all([...this.previews].map((preview) => preview.close()));
        if (this.unconfirmed) {
            this.phase = 'idle';
            this.tally.extractionsRefused += 1;
            return { ok: false, code: 'RELEASE_UNCONFIRMED' };
        }
        this.phase = 'active';
        this.tally.extractionsStarted += 1;
        return { ok: true, lease: this.lease() };
    }

    counts(): GateCounts {
        return { ...this.tally };
    }

    private lease(): ExtractionLease {
        let ended = false;
        return {
            openDocument: async (bytes) => {
                if (ended) return { ok: false, code: 'LEASE_ENDED' };
                if (this.unconfirmed) return { ok: false, code: 'RELEASE_UNCONFIRMED' };
                if (this.tally.live > 0) return { ok: false, code: 'DOCUMENT_ALREADY_OPEN' };
                configurePdfWorker();
                // Transferred to PDF.js; the caller keeps no copy.
                const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, ...m7PdfDocumentAssets() });
                this.tally.opened += 1;
                this.tally.live += 1;
                this.tally.peakLive = Math.max(this.tally.peakLive, this.tally.live);
                let closing: Promise<boolean> | null = null;
                const close = (): Promise<boolean> => {
                    closing ??= this.destroy(task);
                    return closing;
                };
                try {
                    const doc = await task.promise;
                    return { ok: true, document: { doc, close } };
                } catch {
                    return (await close()) ? { ok: false, code: 'OPEN_FAILED' } : { ok: false, code: 'RELEASE_UNCONFIRMED' };
                }
            },
            end: () => {
                if (ended) return;
                ended = true;
                this.phase = 'idle';
            },
        };
    }

    /** Counted as destroyed only when PDF.js says it is; a failure stops every later open. */
    private destroy(task: PDFDocumentLoadingTask): Promise<boolean> {
        this.tally.destroyRequested += 1;
        return task.destroy().then(
            () => {
                this.tally.destroyed += 1;
                this.tally.live -= 1;
                return true;
            },
            () => {
                this.tally.destroyFailed += 1;
                this.unconfirmed = true;
                return false;
            },
        );
    }
}
