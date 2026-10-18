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
 * -- here, in intake or in extraction -- stops every later open everywhere.
 * Without a gate the owner behaves exactly as above.
 *
 * The preview's own read is a check of the File (M7-P2-B): what it found --
 * the digest of the bytes it read, or why it read nothing -- is handed to
 * `onRead`, for the workspace to settle into the session's runtime bindings.
 * A read that was stopped because the document was no longer wanted reports
 * nothing. The document is opened with M7's own PDF.js data files (CMaps,
 * standard fonts, the image decoders, from this origin), as intake and
 * extraction open theirs, so a page is drawn as it was read.
 *
 * Pages (M7-P2-B2). Whatever draws from the document -- the viewer, and the
 * original-drawing crops a confirmation is made against -- does so inside a
 * page section (withPage): one section at a time per document, each handed a
 * page that can only be measured and drawn. Every render a section starts is
 * the owner's to know about, so the owner, not the caller, stops it.
 *
 * Closing releases in a fixed order: stop the read and every section; wait
 * until every render they started has ended, and clean the page up; only
 * then ask PDF.js to destroy the document. Each step is recorded on its own
 * (releaseRecords): that the renders ended, what page.cleanup() said before
 * the destruction, and that the destruction finished with no page request
 * left unanswered. A cleanup that says "not yet" is recorded as exactly that
 * and is never counted as done; the release is judged by what follows it.
 * Anything that cannot be shown -- a destruction that failed, a page request
 * still unanswered once the document is gone, a cleanup or a cancellation
 * that threw, or a release that has not finished within RELEASE_DEADLINE_MS
 * -- is RELEASE_UNCONFIRMED, as a failed destruction always was: nothing opens
 * again until the page is reloaded. The deadline only ever detects a failure;
 * running out of time is never taken as a release, and what finishes after it
 * changes nothing.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PageViewport, PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import type { SourceFileCheck } from './currency';
import { readFileDigest } from './file-evidence';
import { IntakeStop, READ_CHUNK_BYTES } from './intake-policy';
import type { Uuid } from './model';
import { m7PdfDocumentAssets } from './pdf-document-assets';
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

/**
 * How long a release may take before it is recorded as unconfirmed (N-A12).
 * Only a failure is ever concluded from it: a release that finishes in time
 * is judged by its own evidence, and one that finishes later stays
 * unconfirmed.
 */
export const RELEASE_DEADLINE_MS = 5000;

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
    /** Renders begun through a page section; each then ends as exactly one of the next three. */
    renderStarted: number;
    renderCompleted: number;
    /** Renders stopped part-way. */
    renderCancelled: number;
    renderFailed: number;
    /** Page sections begun, and ended. */
    sectionsStarted: number;
    sectionsEnded: number;
    /** Page sections refused, or dropped while waiting, before they asked for a page. */
    sectionsRefused: number;
    /** page.cleanup() calls that reported the page cleaned. */
    cleanupConfirmed: number;
    /** ...that reported it could not be cleaned yet (a render of it still winding down). Never counted as cleaned. */
    cleanupDeferred: number;
    /** ...that threw. Each one stops every later open. */
    cleanupFailed: number;
    /** getPage() calls asked for and not answered yet. */
    pageRequestsPending: number;
    /** getPage() calls a section stopped waiting for. */
    pageRequestsAbandoned: number;
    /** Releases that did not finish within RELEASE_DEADLINE_MS. */
    releaseDeadlineExpired: number;
    /** Releases recorded as unconfirmed, for any reason. */
    releasesUnconfirmed: number;
}

/** Why a release could not be confirmed. */
export type ReleaseFailure =
    | 'DESTROY_FAILED'
    /** A getPage() was still unanswered when PDF.js reported the document destroyed. */
    | 'PAGE_REQUEST_PENDING'
    | 'CLEANUP_THREW'
    | 'CANCEL_THREW'
    | 'DEADLINE'
    | 'UNEXPECTED';

/**
 * One release, as it happened: the evidence kept apart (A-D1). Plain data,
 * nothing about any file.
 *  - E-END `renderEnded`: every render begun on the document had ended before
 *    its destruction was asked for.
 *  - E-PRE `cleanupBeforeDestroy`: what page.cleanup() said for the section
 *    that was running, before the destruction (null: none was running).
 *    'deferred' is "not cleaned yet", never "cleaned".
 *  - E-REL `outcome`: the destruction resolved, with no page request left
 *    unanswered, and nothing else failed; otherwise 'unconfirmed'.
 */
export interface ReleaseRecord {
    renderEnded: boolean;
    cleanupBeforeDestroy: 'confirmed' | 'deferred' | 'threw' | null;
    /** Page requests not answered when the destruction was asked for, and when it resolved (null: not reached). */
    pageRequestsAtDestroy: number | null;
    pageRequestsAtRelease: number | null;
    destroy: 'none' | 'asked' | 'resolved' | 'failed';
    outcome: 'pending' | 'released' | 'unconfirmed';
    failure: ReleaseFailure | null;
    /** In the order they happened. */
    steps: string[];
}

/** What the viewer knows about the Source it wants shown. */
export interface ExpectedContent {
    sha256: string;
    byteLength: number;
}

/** What a caller wants told about the read behind an open. */
export interface OpenHooks {
    /** The session the read is made for (its Drawing Set id). */
    scope?: Uuid | null;
    /**
     * Called once, at the moment the read begins -- after every earlier
     * document has been released, so it may be well after open() -- before a
     * byte of the File is looked at. A check of the File is begun here, so it
     * is ordered by when the File was really read.
     */
    beginRead?: () => void;
    /** What the read found about the File, once it is known. Not called for a read that was stopped. */
    onRead?: (check: SourceFileCheck) => void;
}

/** A render a section started, as the caller sees it. */
export interface PreviewRender {
    readonly promise: Promise<void>;
    cancel(): void;
}

/**
 * The page a section is handed: it can be measured and drawn into a canvas,
 * and nothing else. Anything else asked of it throws -- so code that wants
 * more of the page than this (to clean it up, to keep it) finds out at once.
 */
export interface PreviewPage {
    getViewport(params: Parameters<PDFPageProxy['getViewport']>[0]): PageViewport;
    render(params: Parameters<PDFPageProxy['render']>[0]): PreviewRender;
}

/** Where a section's page comes from: the document's own getPage() unless a test says otherwise. */
export type PageSource = (doc: PDFDocumentProxy, pageNumber: number) => Promise<PDFPageProxy>;
/** Arms the release deadline; returns how to disarm it. */
export type ReleaseDeadline = (expire: () => void) => () => void;

const defaultPageSource: PageSource = (doc, pageNumber) => doc.getPage(pageNumber);
const defaultDeadline: ReleaseDeadline = (expire) => {
    const timer = setTimeout(expire, RELEASE_DEADLINE_MS);
    return () => clearTimeout(timer);
};

interface Registered {
    task: RenderTask;
    canvas: HTMLCanvasElement;
    settled: boolean;
}

interface Section {
    readonly pageNumber: number;
    readonly run: (page: PreviewPage, signal: AbortSignal) => Promise<unknown>;
    /** Aborted when the caller's signal aborts or the document closes. */
    readonly controller: AbortController;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
    stopListening: () => void;
    readonly renders: Set<Registered>;
    ended: boolean;
}

interface Entry {
    sourceId: string;
    file: Blob;
    promise: Promise<PDFDocumentProxy>;
    task: PDFDocumentLoadingTask | null;
    /** The document, once PDF.js has opened it: the only one a section may use. */
    doc: PDFDocumentProxy | null;
    closed: boolean;
    controller: AbortController;
    /** Settles once the read has stopped, however it ended. */
    readStopped: Promise<void>;
    waiting: Section[];
    running: Section | null;
    /** Settles once the running section has ended: its renders ended, its page cleaned up. */
    runningEnded: Promise<void> | null;
    /** Pages that arrived after their section had stopped waiting, to clean up once no section runs. */
    latePages: PDFPageProxy[];
    pageRequestsPending: number;
    /** Asked for at most once. */
    destroying: Promise<void> | null;
    release: ReleaseRecord | null;
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

const isCancelled = (error: unknown): boolean => (error as { name?: string } | null)?.name === 'RenderingCancelledException';

/** How many release records are kept, newest last. */
const RELEASE_RECORDS_KEPT = 32;

export class PreviewDocumentOwner {
    private entry: Entry | null = null;
    /**
     * Settles once every entry closed so far has stopped reading and its
     * document, if it had one, has been destroyed -- or its release was
     * recorded as unconfirmed, which `releaseUnconfirmed` records. Never
     * rejects, and never waits past an entry's deadline.
     */
    private released: Promise<void> = Promise.resolve();
    /** Set for good once a release could not be confirmed: nothing is opened after it. */
    private releaseUnconfirmed = false;
    private readonly chunkBytes: number;
    private readonly gate: PdfDocumentGate | null;
    private readonly pageSource: PageSource;
    private readonly deadline: ReleaseDeadline;
    private readonly records: ReleaseRecord[] = [];
    private readonly tally = {
        opened: 0, destroyRequested: 0, destroyed: 0, destroyFailed: 0, readsStopped: 0,
        renderStarted: 0, renderCompleted: 0, renderCancelled: 0, renderFailed: 0,
        sectionsStarted: 0, sectionsEnded: 0, sectionsRefused: 0,
        cleanupConfirmed: 0, cleanupDeferred: 0, cleanupFailed: 0,
        pageRequestsPending: 0, pageRequestsAbandoned: 0,
        releaseDeadlineExpired: 0, releasesUnconfirmed: 0,
    };

    /**
     * `pageSource` and `releaseDeadline` exist for the foundation tests only:
     * they let a test hold a page request or a render open, and say when the
     * deadline has passed, without timers. They are read once, here; the
     * page's owner (page-documents.ts) passes neither, which the M7-P2-B2
     * static gate checks. Neither can widen what is trusted: a page is asked
     * for only for the document this owner opened from bytes whose SHA-256 it
     * checked, under the gate, and the deadline can only ever end a release as
     * unconfirmed.
     */
    constructor(options: { chunkBytes?: number; gate?: PdfDocumentGate; pageSource?: PageSource; releaseDeadline?: ReleaseDeadline } = {}) {
        this.chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES;
        this.gate = options.gate ?? null;
        this.pageSource = options.pageSource ?? defaultPageSource;
        this.deadline = options.releaseDeadline ?? defaultDeadline;
        this.gate?.registerPreview(this);
    }

    /** A document anywhere could not be released: this owner's own, or one the gate knows of. */
    private get refusesAll(): boolean {
        return this.releaseUnconfirmed || this.gate?.releaseUnconfirmed === true;
    }

    /** True once any release, here or anywhere the gate knows of, could not be confirmed. */
    get documentsUnavailable(): boolean {
        return this.refusesAll;
    }

    /** The Source whose document is open or opening, if any. */
    get sourceId(): string | null {
        return this.entry?.sourceId ?? null;
    }

    /** Whether `doc` is the document this owner holds now and a section may use it. */
    holds(doc: PDFDocumentProxy): boolean {
        const entry = this.entry;
        return entry !== null && !entry.closed && entry.doc === doc && !doc.loadingTask.destroyed;
    }

    /**
     * The document of `sourceId`, opening it from `file` if it is not the one
     * already held -- for this Source, from this very File.
     */
    open(sourceId: string, file: Blob, expected: ExpectedContent, hooks: OpenHooks = {}): Promise<PDFDocumentProxy> {
        if (this.gate?.extractionActive) return Promise.reject(extractionActiveError());
        if (this.entry && this.entry.sourceId === sourceId && this.entry.file === file) return this.entry.promise;
        void this.close();
        const waitFor = this.released;
        let readDone: () => void = () => { };
        const report = (check: SourceFileCheck): void => {
            try {
                hooks.onRead?.(check);
            } catch {
                // What the caller does with a report never changes the preview.
            }
        };
        const beginRead = (): void => {
            try {
                hooks.beginRead?.();
            } catch {
                // Nor what it does when the read begins.
            }
        };
        const entry: Entry = {
            sourceId,
            file,
            promise: Promise.resolve(null as unknown as PDFDocumentProxy),
            task: null,
            doc: null,
            closed: false,
            controller: new AbortController(),
            readStopped: new Promise<void>((resolve) => { readDone = resolve; }),
            waiting: [],
            running: null,
            runningEnded: null,
            latePages: [],
            pageRequestsPending: 0,
            destroying: null,
            release: null,
        };

        const load = async (): Promise<PDFDocumentLoadingTask> => {
            try {
                // Nothing is read, and no document opened, while an earlier
                // one is still reading or still being destroyed -- nor at all
                // once one could not be released.
                await waitFor;
                if (entry.closed) throw closedError();
                if (this.refusesAll) throw unconfirmedError();
                if (this.gate?.extractionActive) throw extractionActiveError();
                beginRead();
                if (file.size !== expected.byteLength) {
                    report({ kind: 'NOT_READ', file, reason: 'SIZE_DIFFERS' });
                    throw changedError();
                }
                let bytes: Uint8Array | null;
                try {
                    bytes = new Uint8Array(expected.byteLength);
                } catch {
                    throw new PreviewError('READ_FAILED', 'このファイルを表示するためのメモリを確保できませんでした。');
                }
                let sha256: string;
                try {
                    const digest = await readFileDigest(file, bytes, { signal: entry.controller.signal, chunkBytes: this.chunkBytes, scope: hooks.scope ?? null });
                    sha256 = digest.sha256;
                    if (!entry.closed) report({ kind: 'READ', digest });
                } catch (error) {
                    if (entry.closed) {
                        this.tally.readsStopped += 1;
                        throw closedError();
                    }
                    const changed = error instanceof IntakeStop && error.refusal?.code === 'FILE_CHANGED';
                    report({ kind: 'NOT_READ', file, reason: changed ? 'CHANGED_WHILE_READ' : 'UNREADABLE' });
                    throw changed ? changedError() : readError();
                }
                if (entry.closed) throw closedError();
                if (sha256 !== expected.sha256) throw changedError();
                // A document somewhere could not be released while this one was read.
                if (this.refusesAll) throw unconfirmedError();
                if (this.gate?.extractionActive) throw extractionActiveError();
                configurePdfWorker();
                // Transferred to PDF.js; the main thread keeps no copy.
                const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, ...m7PdfDocumentAssets() });
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
            let doc: PDFDocumentProxy;
            try {
                doc = await task.promise;
            } catch {
                if (entry.closed) throw closedError();
                throw new PreviewError('OPEN_FAILED', 'このページを表示できませんでした。');
            }
            if (entry.closed) throw closedError();
            entry.doc = doc;
            return doc;
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

    // ------------------------------------------------------------ sections

    /**
     * Use one page of the document this owner holds, inside a section.
     *
     * Sections run one at a time, in the order asked. `run` is handed the
     * page -- measurable and drawable only -- and a signal that aborts when
     * the caller's signal does or the document closes. Every render it starts
     * is registered here: when the section is stopped, the owner cancels them
     * and waits for them to end, and a render asked for after that is refused.
     * Once the section's renders have ended, the owner cleans the page up.
     *
     * Refused (CLOSED) when `doc` is not the document held now, or the caller
     * gave up first; EXTRACTION_ACTIVE while extraction holds the gate;
     * RELEASE_UNCONFIRMED once a release could not be confirmed. A section
     * that was stopped rejects CLOSED even if `run` resolved: what it produced
     * after it was stopped is not handed on.
     */
    withPage<T>(
        doc: PDFDocumentProxy,
        pageNumber: number,
        run: (page: PreviewPage, signal: AbortSignal) => Promise<T>,
        options: { signal?: AbortSignal } = {},
    ): Promise<T> {
        const entry = this.entry;
        const refusal = this.sectionRefusal(entry, doc) ?? (options.signal?.aborted ? closedError() : null);
        if (refusal || !entry) {
            this.tally.sectionsRefused += 1;
            return Promise.reject(refusal ?? closedError());
        }
        return new Promise<T>((resolve, reject) => {
            const section: Section = {
                pageNumber,
                run,
                controller: new AbortController(),
                resolve: resolve as (value: unknown) => void,
                reject,
                stopListening: () => { },
                renders: new Set(),
                ended: false,
            };
            const callerSignal = options.signal;
            if (callerSignal) {
                const onAbort = (): void => this.stopSection(entry, section);
                callerSignal.addEventListener('abort', onAbort, { once: true });
                section.stopListening = () => callerSignal.removeEventListener('abort', onAbort);
            }
            entry.waiting.push(section);
            this.pump(entry);
        });
    }

    private sectionRefusal(entry: Entry | null, doc: PDFDocumentProxy): PreviewError | null {
        if (this.refusesAll) return unconfirmedError();
        if (this.gate?.extractionActive) return extractionActiveError();
        if (!entry || entry.closed || entry.doc !== doc || doc.loadingTask.destroyed) return closedError();
        return null;
    }

    /** Start the next waiting section, if none is running. */
    private pump(entry: Entry): void {
        while (!entry.running && !entry.closed) {
            const next = entry.waiting.shift();
            if (!next) return;
            const refusal = next.controller.signal.aborted ? closedError() : this.sectionRefusal(entry, entry.doc!);
            if (refusal) {
                this.refuseSection(next, refusal);
                continue;
            }
            this.startSection(entry, next);
        }
    }

    private refuseSection(section: Section, error: PreviewError): void {
        section.stopListening();
        section.ended = true;
        this.tally.sectionsRefused += 1;
        section.reject(error);
    }

    /** The caller gave up, or the document is closing: drop a waiting section, stop a running one. */
    private stopSection(entry: Entry, section: Section): void {
        const at = entry.waiting.indexOf(section);
        if (at >= 0) {
            entry.waiting.splice(at, 1);
            this.refuseSection(section, closedError());
            return;
        }
        if (entry.running !== section || section.controller.signal.aborted) return;
        section.controller.abort();
        // PDF.js calls a cancelled render back synchronously.
        for (const render of section.renders) {
            if (render.settled) continue;
            try {
                render.task.cancel();
            } catch {
                this.failClosed(entry.release, 'CANCEL_THREW');
            }
        }
    }

    private startSection(entry: Entry, section: Section): void {
        entry.running = section;
        this.tally.sectionsStarted += 1;
        entry.runningEnded = (async () => {
            let page: PDFPageProxy | null = null;
            let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
            try {
                page = await this.requestPage(entry, section);
                outcome = { ok: true, value: await section.run(this.pageFor(section, page), section.controller.signal) };
            } catch (error) {
                outcome = { ok: false, error };
            }
            // Every render this section started has ended before anything else happens to the page.
            await Promise.allSettled([...section.renders].map((render) => render.task.promise));
            section.ended = true;
            const stopped = section.controller.signal.aborted;
            if (stopped) {
                // What a stopped section drew is no one's: let the browser have the memory back.
                for (const render of section.renders) {
                    render.canvas.width = 0;
                    render.canvas.height = 0;
                }
            }
            if (page) {
                const result = this.cleanupPage(entry, page);
                if (entry.closed && entry.release && entry.release.cleanupBeforeDestroy === null) {
                    entry.release.cleanupBeforeDestroy = result;
                    entry.release.steps.push(`cleanup-${result}`);
                }
            }
            section.stopListening();
            entry.running = null;
            this.tally.sectionsEnded += 1;
            this.cleanLatePages(entry);
            if (stopped) section.reject(closedError());
            else if (outcome.ok) section.resolve(outcome.value);
            else section.reject(outcome.error);
            this.pump(entry);
        })();
    }

    /** The section's page, or CLOSED as soon as the section is stopped -- without waiting for the request. */
    private requestPage(entry: Entry, section: Section): Promise<PDFPageProxy> {
        const signal = section.controller.signal;
        if (signal.aborted) return Promise.reject(closedError());
        let request: Promise<PDFPageProxy>;
        try {
            request = this.pageSource(entry.doc!, section.pageNumber);
        } catch (error) {
            return Promise.reject(error);
        }
        entry.pageRequestsPending += 1;
        this.tally.pageRequestsPending += 1;
        let gaveUp = false;
        return new Promise<PDFPageProxy>((resolve, reject) => {
            const onAbort = (): void => {
                gaveUp = true;
                this.tally.pageRequestsAbandoned += 1;
                reject(closedError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            const answered = (): void => {
                entry.pageRequestsPending -= 1;
                this.tally.pageRequestsPending -= 1;
                signal.removeEventListener('abort', onAbort);
            };
            Promise.resolve(request).then(
                (page) => {
                    answered();
                    if (!gaveUp) {
                        resolve(page);
                        return;
                    }
                    // Never drawn from. Cleaned up once no section is running,
                    // so never while a render of it is.
                    if (entry.closed) return;
                    entry.latePages.push(page);
                    if (!entry.running) this.cleanLatePages(entry);
                },
                (error: unknown) => {
                    answered();
                    if (!gaveUp) reject(error);
                },
            );
        });
    }

    private cleanLatePages(entry: Entry): void {
        if (entry.closed) {
            entry.latePages.length = 0;
            return;
        }
        for (const page of entry.latePages.splice(0)) this.cleanupPage(entry, page);
    }

    /** What page.cleanup() said, counted as said. A throw stops every later open. */
    private cleanupPage(entry: Entry, page: PDFPageProxy): 'confirmed' | 'deferred' | 'threw' {
        let cleaned: boolean;
        try {
            cleaned = page.cleanup() === true;
        } catch {
            this.tally.cleanupFailed += 1;
            this.failClosed(entry.release, 'CLEANUP_THREW');
            return 'threw';
        }
        if (cleaned) this.tally.cleanupConfirmed += 1;
        else this.tally.cleanupDeferred += 1;
        return cleaned ? 'confirmed' : 'deferred';
    }

    /** The page as a section may use it. */
    private pageFor(section: Section, page: PDFPageProxy): PreviewPage {
        const offered = Object.freeze({
            getViewport: (params: Parameters<PDFPageProxy['getViewport']>[0]): PageViewport => page.getViewport(params),
            render: (params: Parameters<PDFPageProxy['render']>[0]): PreviewRender => this.renderIn(section, page, params),
        });
        return new Proxy(offered, {
            get(target, property) {
                if (property === 'getViewport' || property === 'render') return target[property];
                // Not a thenable, and nothing else a runtime asks of an object by symbol.
                if (typeof property === 'symbol' || property === 'then') return undefined;
                throw new TypeError(`a preview page can be measured and drawn only, not asked for "${property}"`);
            },
            set() {
                return false;
            },
        });
    }

    private renderIn(section: Section, page: PDFPageProxy, params: Parameters<PDFPageProxy['render']>[0]): PreviewRender {
        if (section.ended || section.controller.signal.aborted) throw closedError();
        const canvas = params?.canvas;
        if (!(canvas instanceof HTMLCanvasElement) || params.canvasContext !== undefined) {
            throw new TypeError('a preview render draws into a canvas it is given');
        }
        const task = page.render(params);
        const render: Registered = { task, canvas, settled: false };
        section.renders.add(render);
        this.tally.renderStarted += 1;
        task.promise.then(
            () => {
                render.settled = true;
                this.tally.renderCompleted += 1;
            },
            (error: unknown) => {
                render.settled = true;
                if (isCancelled(error)) this.tally.renderCancelled += 1;
                else this.tally.renderFailed += 1;
            },
        );
        return Object.freeze({
            promise: task.promise,
            cancel: (): void => {
                if (!render.settled) task.cancel();
            },
        });
    }

    // ------------------------------------------------------------- closing

    /**
     * Destroy the held document, or stop the read in progress. Idempotent.
     * Resolves once everything closed so far has stopped reading and been
     * destroyed by PDF.js, or its release was recorded as unconfirmed -- after
     * which no document is opened again. Never later than the deadline.
     */
    close(): Promise<void> {
        const entry = this.entry;
        if (entry) {
            this.entry = null;
            entry.closed = true;
            entry.controller.abort();
            const record: ReleaseRecord = {
                renderEnded: false, cleanupBeforeDestroy: null, pageRequestsAtDestroy: null, pageRequestsAtRelease: null,
                destroy: 'none', outcome: 'pending', failure: null, steps: ['abort'],
            };
            entry.release = record;
            this.records.push(record);
            if (this.records.length > RELEASE_RECORDS_KEPT) this.records.shift();
            // Waiting sections never ask for a page.
            for (const section of entry.waiting.splice(0)) this.refuseSection(section, closedError());
            if (entry.running) this.stopSection(entry, entry.running);
            const released = this.release(entry, record);
            this.released = Promise.all([this.released, released]).then(() => undefined);
        }
        return this.released;
    }

    /** Close only if the held document belongs to `sourceId`. */
    closeIfSource(sourceId: string): Promise<void> {
        return this.entry?.sourceId === sourceId ? this.close() : this.released;
    }

    /**
     * Release one closed entry: drain, clean up, destroy, confirm -- or record
     * why it cannot be confirmed. Resolves (never rejects) once that is known,
     * or the deadline has passed.
     *
     * With no section running there is nothing to drain, and the destruction
     * is asked for at once, as close() always did.
     */
    private release(entry: Entry, record: ReleaseRecord): Promise<void> {
        let finish: () => void = () => { };
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        let over = false;
        let disarm: () => void = () => { };
        const conclude = (): void => {
            if (over) return;
            over = true;
            disarm();
            if (record.failure === null) {
                record.outcome = 'released';
                record.steps.push('released');
            }
            finish();
        };
        disarm = this.deadline(() => {
            if (over) return;
            over = true;
            this.tally.releaseDeadlineExpired += 1;
            record.steps.push('deadline');
            // Recorded before anything waiting on the release goes on.
            this.failClosed(record, 'DEADLINE');
            // Asked for anyway, if it was not yet; it proves nothing now.
            if (entry.task) this.requestDestroy(entry, record);
            finish();
        });
        const work = async (): Promise<void> => {
            if (entry.running && entry.runningEnded) await entry.runningEnded;
            record.renderEnded = true;
            record.steps.push('drained');
            let destroyed: Promise<void> = Promise.resolve();
            if (entry.task) {
                record.pageRequestsAtDestroy = entry.pageRequestsPending;
                destroyed = this.requestDestroy(entry, record);
            }
            await Promise.all([entry.readStopped, destroyed]);
            if (entry.task) {
                record.pageRequestsAtRelease = entry.pageRequestsPending;
                // A page request PDF.js never answers would leave nothing to say the document is gone.
                if (entry.pageRequestsPending > 0) this.failClosed(record, 'PAGE_REQUEST_PENDING');
            }
        };
        work().then(conclude, () => {
            this.failClosed(record, 'UNEXPECTED');
            conclude();
        });
        return finished;
    }

    /** Asks PDF.js to destroy the entry's document, once. */
    private requestDestroy(entry: Entry, record: ReleaseRecord): Promise<void> {
        if (!entry.destroying) {
            record.destroy = 'asked';
            record.steps.push('destroy-asked');
            entry.destroying = this.destroy(entry.task!).then((ok) => {
                record.destroy = ok ? 'resolved' : 'failed';
                record.steps.push(ok ? 'destroy-resolved' : 'destroy-failed');
                if (!ok) this.failClosed(record, 'DESTROY_FAILED');
            });
        }
        return entry.destroying;
    }

    /** Nothing is opened again: here, or anywhere the gate serves. Recorded on the release it concerns, if any. */
    private failClosed(record: ReleaseRecord | null, failure: ReleaseFailure): void {
        if (record && record.failure === null) {
            record.failure = failure;
            record.outcome = 'unconfirmed';
            record.steps.push(`unconfirmed:${failure}`);
            this.tally.releasesUnconfirmed += 1;
        }
        this.releaseUnconfirmed = true;
        this.gate?.noteReleaseUnconfirmed();
    }

    counts(): PreviewCounts {
        return { ...this.tally, live: this.tally.opened - this.tally.destroyed };
    }

    /** The latest releases, oldest first. Copies. */
    releaseRecords(): ReleaseRecord[] {
        return this.records.map((record) => ({ ...record, steps: [...record.steps] }));
    }

    /**
     * Counted as destroyed only when PDF.js says it is. False: PDF.js reported
     * the destruction failed, and nothing is opened after it.
     */
    private destroy(task: PDFDocumentLoadingTask): Promise<boolean> {
        this.tally.destroyRequested += 1;
        return task.destroy().then(
            () => {
                this.tally.destroyed += 1;
                return true;
            },
            () => {
                this.tally.destroyFailed += 1;
                this.releaseUnconfirmed = true;
                this.gate?.noteReleaseUnconfirmed();
                return false;
            },
        );
    }
}
