/**
 * The one PDF.js document the read-only viewer may hold.
 *
 * Intake never keeps a document: it reads the pages it needs and destroys the
 * document. The viewer opens a Source again, from its File, only when one of
 * its Sheets is selected, and holds at most one document at a time. Opening
 * another Source destroys the previous document first; closing (reset, the
 * Source being removed, the workspace going away) destroys it too. That trades
 * some repeated local reading for memory that stays bounded however many
 * Sources the Drawing Set holds.
 *
 * Reading for the preview goes through the same chunked, cancellable path as
 * intake, and the bytes are fingerprinted again on the way: a File that no
 * longer holds the fingerprinted bytes is not shown as if it were the Source.
 * A read that is no longer wanted stops at the next chunk.
 *
 * PDF.js destroys a document asynchronously. Nothing is read for the next
 * document, and no document is opened, until every one closed before it has
 * stopped reading and PDF.js has finished destroying it -- so two full-size
 * preview reads, or two preview documents, never overlap. The counts tell a
 * destruction asked for apart from one PDF.js has finished.
 *
 * A destruction PDF.js reports as failed leaves its document running (PDF.js
 * keeps that document's worker), so nothing says it is gone. From then on the
 * owner opens no document at all: every preview is refused with how to
 * recover -- reload the page, which ends every worker. The workspace keeps one
 * owner for the whole page, so leaving it and coming back does not get round
 * this.
 *
 * Given a PdfDocumentGate (M7-P2), the owner also yields to title-block
 * extraction: the gate closes it before extraction opens its own document, no
 * preview opens while extraction runs, and a destruction that failed anywhere
 * -- here or in extraction -- stops every later open on both sides. Without a
 * gate the owner behaves exactly as above.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import { fingerprintIntoBuffer } from './fingerprint-client';
import { IntakeStop, READ_CHUNK_BYTES } from './intake-policy';
import type { PdfDocumentGate } from './pdf-document-gate';

export type PreviewErrorCode = 'READ_FAILED' | 'SOURCE_CHANGED' | 'OPEN_FAILED' | 'CLOSED' | 'RELEASE_UNCONFIRMED' | 'EXTRACTION_ACTIVE';

export class PreviewError extends Error {
    readonly code: PreviewErrorCode;
    constructor(code: PreviewErrorCode, message: string) {
        super(message);
        this.name = 'PreviewError';
        this.code = code;
    }
}

/** Counts only, for tests and evidence; nothing about any file. */
export interface PreviewCounts {
    /** Documents handed to PDF.js. */
    opened: number;
    /** Documents whose destruction has been asked for. */
    destroyRequested: number;
    /** Documents PDF.js has finished destroying. */
    destroyed: number;
    /** Destructions PDF.js reported as failed. */
    destroyFailed: number;
    /** opened - destroyed: documents not known to be gone. */
    live: number;
    /** Reads stopped part-way because the document was no longer wanted. */
    readsStopped: number;
    /** Renders begun; each then ends as exactly one of the next three. */
    renderStarted: number;
    renderCompleted: number;
    /** Renders stopped part-way. */
    renderCancelled: number;
    renderFailed: number;
}

/** What the viewer knows about the Source it wants shown. */
export interface ExpectedContent {
    sha256: string;
    byteLength: number;
}

interface Entry {
    sourceId: string;
    promise: Promise<PDFDocumentProxy>;
    task: PDFDocumentLoadingTask | null;
    closed: boolean;
    controller: AbortController;
    /** Settles once the read has stopped, however it ended. */
    readStopped: Promise<void>;
}

const closedError = (): PreviewError => new PreviewError('CLOSED', 'closed');
const changedError = (): PreviewError => new PreviewError('SOURCE_CHANGED', '読み込んだ後にファイルの内容が変わったため、表示できません。');
const readError = (): PreviewError => new PreviewError('READ_FAILED', 'ファイルを読み込めませんでした。ファイルが移動・変更されていないか確認してください。');
const unconfirmedError = (): PreviewError => new PreviewError(
    'RELEASE_UNCONFIRMED',
    '前に表示していたPDFを閉じられたか確認できないため、プレビューを表示できません。ページを再読み込みしてください。図面一式は保存されていないため、再読み込みの後でファイルを追加し直してください。',
);
const extractionActiveError = (): PreviewError => new PreviewError(
    'EXTRACTION_ACTIVE',
    '表題欄の読み取り中はプレビューを表示しません。読み取りが終わると表示できます。',
);

export class PreviewDocumentOwner {
    private entry: Entry | null = null;
    /**
     * Settles once every entry closed so far has stopped reading and its
     * document, if it had one, has been destroyed -- or PDF.js has reported
     * that it could not be, which `releaseUnconfirmed` records. Never rejects.
     */
    private released: Promise<void> = Promise.resolve();
    /** Set for good once PDF.js could not destroy a document: none is opened after it. */
    private releaseUnconfirmed = false;
    private readonly chunkBytes: number;
    private readonly gate: PdfDocumentGate | null;
    private readonly tally = {
        opened: 0, destroyRequested: 0, destroyed: 0, destroyFailed: 0, readsStopped: 0,
        renderStarted: 0, renderCompleted: 0, renderCancelled: 0, renderFailed: 0,
    };

    constructor(options: { chunkBytes?: number; gate?: PdfDocumentGate } = {}) {
        this.chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES;
        this.gate = options.gate ?? null;
        this.gate?.registerPreview(this);
    }

    /** A document anywhere could not be destroyed: this owner's own, or one the gate knows of. */
    private get refusesAll(): boolean {
        return this.releaseUnconfirmed || this.gate?.releaseUnconfirmed === true;
    }

    /** The Source whose document is open or opening, if any. */
    get sourceId(): string | null {
        return this.entry?.sourceId ?? null;
    }

    /** The document of `sourceId`, opening it from `file` if it is not the one already held. */
    open(sourceId: string, file: Blob, expected: ExpectedContent): Promise<PDFDocumentProxy> {
        if (this.gate?.extractionActive) return Promise.reject(extractionActiveError());
        if (this.entry && this.entry.sourceId === sourceId) return this.entry.promise;
        void this.close();
        const waitFor = this.released;
        let readDone: () => void = () => { };
        const entry: Entry = {
            sourceId,
            promise: Promise.resolve(null as unknown as PDFDocumentProxy),
            task: null,
            closed: false,
            controller: new AbortController(),
            readStopped: new Promise<void>((resolve) => { readDone = resolve; }),
        };

        const load = async (): Promise<PDFDocumentLoadingTask> => {
            try {
                // Nothing is read, and no document opened, while an earlier
                // one is still reading or still being destroyed -- nor at all
                // once one could not be destroyed.
                await waitFor;
                if (entry.closed) throw closedError();
                if (this.refusesAll) throw unconfirmedError();
                if (this.gate?.extractionActive) throw extractionActiveError();
                if (file.size !== expected.byteLength) throw changedError();
                let bytes: Uint8Array | null;
                try {
                    bytes = new Uint8Array(expected.byteLength);
                } catch {
                    throw new PreviewError('READ_FAILED', 'このファイルを表示するためのメモリを確保できませんでした。');
                }
                let sha256: string;
                try {
                    sha256 = await fingerprintIntoBuffer(file, bytes, { signal: entry.controller.signal, chunkBytes: this.chunkBytes });
                } catch (error) {
                    if (entry.closed) {
                        this.tally.readsStopped += 1;
                        throw closedError();
                    }
                    throw error instanceof IntakeStop && error.refusal?.code === 'FILE_CHANGED' ? changedError() : readError();
                }
                if (entry.closed) throw closedError();
                if (sha256 !== expected.sha256) throw changedError();
                configurePdfWorker();
                // Transferred to PDF.js; the main thread keeps no copy.
                const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
                bytes = null;
                entry.task = task;
                this.tally.opened += 1;
                return task;
            } finally {
                readDone();
            }
        };

        entry.promise = (async () => {
            const task = await load();
            try {
                return await task.promise;
            } catch {
                if (entry.closed) throw closedError();
                throw new PreviewError('OPEN_FAILED', 'このページを表示できませんでした。');
            }
        })();
        // A failed open is not kept: its document is destroyed and choosing
        // the Source again tries again.
        entry.promise.catch((error: unknown) => {
            if (error instanceof PreviewError && error.code === 'CLOSED') return;
            if (this.entry === entry) void this.close();
        });
        this.entry = entry;
        return entry.promise;
    }

    /**
     * Destroy the held document, or stop the read in progress. Idempotent.
     * Resolves once everything closed so far has stopped reading and been
     * destroyed by PDF.js, or PDF.js has reported a destruction failed -- after
     * which no document is opened again.
     */
    close(): Promise<void> {
        const entry = this.entry;
        if (entry) {
            this.entry = null;
            entry.closed = true;
            entry.controller.abort();
            // A read checks `closed` after every wait and opens its document
            // in the same step, so once closed, the entry either has its
            // document already or never will.
            const destroyed = entry.task ? this.destroy(entry.task) : Promise.resolve();
            this.released = Promise.all([this.released, entry.readStopped, destroyed]).then(() => undefined);
        }
        return this.released;
    }

    /** Close only if the held document belongs to `sourceId`. */
    closeIfSource(sourceId: string): Promise<void> {
        return this.entry?.sourceId === sourceId ? this.close() : this.released;
    }

    noteRender(event: 'started' | 'completed' | 'cancelled' | 'failed'): void {
        if (event === 'started') this.tally.renderStarted += 1;
        else if (event === 'completed') this.tally.renderCompleted += 1;
        else if (event === 'cancelled') this.tally.renderCancelled += 1;
        else this.tally.renderFailed += 1;
    }

    counts(): PreviewCounts {
        return { ...this.tally, live: this.tally.opened - this.tally.destroyed };
    }

    /**
     * Counted as destroyed only when PDF.js says it is. A failure stops every
     * later open, and is recorded before any waiting open goes on.
     */
    private destroy(task: PDFDocumentLoadingTask): Promise<void> {
        this.tally.destroyRequested += 1;
        return task.destroy().then(
            () => { this.tally.destroyed += 1; },
            () => {
                this.tally.destroyFailed += 1;
                this.releaseUnconfirmed = true;
                this.gate?.noteReleaseUnconfirmed();
            },
        );
    }
}
