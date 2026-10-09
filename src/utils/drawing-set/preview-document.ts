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
 * A read that is no longer wanted stops at the next chunk, and the next one
 * does not start until it has, so two full-size preview reads never overlap.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import { fingerprintIntoBuffer } from './fingerprint-client';
import { IntakeStop, READ_CHUNK_BYTES } from './intake-policy';

export type PreviewErrorCode = 'READ_FAILED' | 'SOURCE_CHANGED' | 'OPEN_FAILED' | 'CLOSED';

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
    /** Documents destroyed again. */
    destroyed: number;
    /** opened - destroyed: never more than 1. */
    live: number;
    /** Reads stopped part-way because the document was no longer wanted. */
    readsStopped: number;
    renderStarted: number;
    renderCompleted: number;
    renderCancelled: number;
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
}

const closedError = (): PreviewError => new PreviewError('CLOSED', 'closed');
const changedError = (): PreviewError => new PreviewError('SOURCE_CHANGED', '読み込んだ後にファイルの内容が変わったため、表示できません。');
const readError = (): PreviewError => new PreviewError('READ_FAILED', 'ファイルを読み込めませんでした。ファイルが移動・変更されていないか確認してください。');

export class PreviewDocumentOwner {
    private entry: Entry | null = null;
    /** Settles once the previous entry has stopped reading. */
    private previousRead: Promise<void> = Promise.resolve();
    private readonly chunkBytes: number;
    private readonly tally = { opened: 0, destroyed: 0, readsStopped: 0, renderStarted: 0, renderCompleted: 0, renderCancelled: 0 };

    constructor(options: { chunkBytes?: number } = {}) {
        this.chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES;
    }

    /** The Source whose document is open or opening, if any. */
    get sourceId(): string | null {
        return this.entry?.sourceId ?? null;
    }

    /** The document of `sourceId`, opening it from `file` if it is not the one already held. */
    open(sourceId: string, file: Blob, expected: ExpectedContent): Promise<PDFDocumentProxy> {
        if (this.entry && this.entry.sourceId === sourceId) return this.entry.promise;
        this.close();
        const waitFor = this.previousRead;
        let readDone: () => void = () => { };
        this.previousRead = new Promise<void>((resolve) => { readDone = resolve; });
        const entry: Entry = {
            sourceId,
            promise: Promise.resolve(null as unknown as PDFDocumentProxy),
            task: null,
            closed: false,
            controller: new AbortController(),
        };

        const load = async (): Promise<PDFDocumentLoadingTask> => {
            try {
                await waitFor;
                if (entry.closed) throw closedError();
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
            if (this.entry === entry) this.close();
        });
        this.entry = entry;
        return entry.promise;
    }

    /** Destroy the held document, or stop the read in progress. Idempotent. */
    close(): void {
        const entry = this.entry;
        if (!entry) return;
        this.entry = null;
        entry.closed = true;
        entry.controller.abort();
        if (entry.task) {
            this.tally.destroyed += 1;
            entry.task.destroy().catch(() => { });
        }
    }

    /** Close only if the held document belongs to `sourceId`. */
    closeIfSource(sourceId: string): void {
        if (this.entry?.sourceId === sourceId) this.close();
    }

    noteRender(event: 'started' | 'completed' | 'cancelled'): void {
        if (event === 'started') this.tally.renderStarted += 1;
        else if (event === 'completed') this.tally.renderCompleted += 1;
        else this.tally.renderCancelled += 1;
    }

    counts(): PreviewCounts {
        return { ...this.tally, live: this.tally.opened - this.tally.destroyed };
    }
}
