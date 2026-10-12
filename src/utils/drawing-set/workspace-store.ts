/**
 * The one writer of a 図面管理 session.
 *
 * Everything that decides what the session holds lives here, and changes only
 * here, synchronously: the Project and its Drawing Set, the runtime binding
 * ledger with the File held for each Source, and the lifecycle epochs that say
 * which work in flight still belongs to this session. React renders a
 * snapshot of it (useSyncExternalStore) and never holds a copy of its own to
 * rebuild from, so a late callback cannot write back an older state.
 *
 * Work that takes time -- intake, the preview's read, extraction -- takes a
 * ticket when it starts and is let to write only while that ticket is
 * current:
 *  - starting a new Drawing Set (reset) or leaving the workspace ends every
 *    ticket and aborts the work behind it;
 *  - stopping intake ends intake's tickets only.
 * What such work finishes afterwards changes nothing.
 *
 * The PDF.js document gate and the preview owner are the page's
 * (page-documents.ts), passed in, so a new session never gets a fresh gate
 * that has forgotten a document PDF.js could not destroy.
 *
 * Nothing here is stored or sent anywhere. Files, the ledger and the epochs
 * are runtime only and never enter the model.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BindingCheck, BindingSettlement, RuntimeBindings, SourceFileCheck } from './currency';
import { RuntimeBindingLedger, verifiedBinding } from './currency';
import type { FileDigest } from './file-evidence';
import type { IntakeRefusal } from './intake-policy';
import { IntakeStop, refusal } from './intake-policy';
import type { DrawingSet, DrawingSetSession, Sheet, Source, Uuid } from './model';
import { commitSourceCandidate, createSession, liveSourceWithContent, retireSource } from './model';
import type { PdfDocumentGate } from './pdf-document-gate';
import type { ExpectedContent, PreviewDocumentOwner } from './preview-document';
import { PreviewError } from './preview-document';
import type { ExtractionContext, ExtractionProgress, ExtractionReport, GuardedRegisterOcr } from './register-extraction';
import { extractTitleBlocks } from './register-extraction';
import type { IntakeOutcome, IntakeProgress } from './source-intake';
import { intakeSource } from './source-intake';

export type SessionState = { ok: true; session: DrawingSetSession } | { ok: false; message: string };

/** What React renders. A new object whenever anything in it changes. */
export interface StoreSnapshot {
    readonly version: number;
    readonly state: SessionState;
    /** For display only: what currency and confirmation decide by is the ledger itself. */
    readonly bindings: RuntimeBindings;
}

/** How one file's intake ended, as the session took it. */
export type StoreIntakeResult =
    | { kind: 'accepted'; source: Source; sheets: Sheet[] }
    /** The bytes are a live Source's whose File this session could not vouch for; this File now stands for it. */
    | { kind: 'reconnected'; existing: Source }
    /** The bytes are a live Source's that already has a File holding them; nothing changed. */
    | { kind: 'duplicate'; existing: Source }
    | { kind: 'refused'; refusal: IntakeRefusal }
    /** Stopped, or no longer this session's: nothing was published. */
    | { kind: 'cancelled' };

type WorkKind = 'intake' | 'extraction';

/** A Drawing Set no session has: what gates and commits see once there is none, so nothing commits into it. */
const NO_SESSION_SET: DrawingSet = Object.freeze({
    id: '',
    name: '',
    createdAt: '',
    sources: [],
    titleBlockProfiles: [],
    sheets: [],
    drawingRegisterReferences: [],
    analysisRuns: [],
    findings: [],
    decisions: [],
}) as DrawingSet;

/**
 * Per page gate, settles when the last intake begun on it has finished --
 * including one abandoned by a stop, a reset or leaving the workspace and still
 * letting go of its buffer and its document. Every store on the gate waits its
 * turn here, a store made by a remount included, so two intakes never overlap.
 */
const intakeChains = new WeakMap<PdfDocumentGate, Promise<void>>();

const startMessage = (error: unknown): string =>
    error instanceof IntakeStop && error.refusal ? error.refusal.message : '図面一式を開始できませんでした。';

export class DrawingSetStore {
    readonly gate: PdfDocumentGate;
    readonly owner: PreviewDocumentOwner;

    private session: DrawingSetSession | null = null;
    private ledger: RuntimeBindingLedger | null = null;
    private failure = '';
    /** Moves on reset and when the workspace is left: ends every ticket. */
    private sessionEpoch = 0;
    /** Moves when intake is stopped, and with every sessionEpoch move. */
    private intakeEpoch = 0;
    /** True between leave() and the next enter(). */
    private left = false;
    private version = 0;
    private snapshot: StoreSnapshot;
    private readonly listeners = new Set<() => void>();
    private readonly work = new Map<AbortController, WorkKind>();

    constructor(options: { gate: PdfDocumentGate; owner: PreviewDocumentOwner }) {
        this.gate = options.gate;
        this.owner = options.owner;
        this.startSession();
        this.snapshot = this.project();
    }

    // ---------------------------------------------------------------- React

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    readonly getSnapshot = (): StoreSnapshot => this.snapshot;

    private project(): StoreSnapshot {
        const state: SessionState = this.session ? { ok: true, session: this.session } : { ok: false, message: this.failure };
        const bindings = this.session && this.ledger ? this.ledger.bindings(this.session.drawingSet) : new Map();
        return { version: this.version, state, bindings };
    }

    private publish(): void {
        this.version += 1;
        this.snapshot = this.project();
        for (const listener of [...this.listeners]) listener();
    }

    // ------------------------------------------------------------- reading

    /** The Drawing Set as it is now: what every gate and every commit reads. */
    currentSet(): DrawingSet {
        return !this.left && this.session ? this.session.drawingSet : NO_SESSION_SET;
    }

    /** The File this session holds for a Source. */
    heldFile(sourceId: Uuid): Blob | null {
        return this.ledger?.heldFile(sourceId) ?? null;
    }

    /** What the ledger knows about a Source's File now. */
    bindingOf(sourceId: Uuid): ReturnType<typeof verifiedBinding> {
        return this.ledger && this.session ? verifiedBinding(this.ledger, this.session.drawingSet, sourceId) : 'UNBOUND';
    }

    /** This session's ledger, for what decides (currency, confirmation). Null when no session could start. */
    bindingLedger(): RuntimeBindingLedger | null {
        return this.ledger;
    }

    // ------------------------------------------------------------ lifecycle

    private startSession(): void {
        try {
            const session = createSession();
            this.session = session;
            this.ledger = new RuntimeBindingLedger(session.drawingSet.id);
            this.failure = '';
        } catch (error) {
            this.session = null;
            this.ledger = null;
            this.failure = startMessage(error);
        }
    }

    private abort(kind: WorkKind | 'all'): void {
        for (const [controller, k] of [...this.work]) {
            if (kind === 'all' || k === kind) {
                controller.abort();
                this.work.delete(controller);
            }
        }
    }

    private track(kind: WorkKind): AbortController {
        const controller = new AbortController();
        this.work.set(controller, kind);
        return controller;
    }

    /** The workspace is shown (again). */
    enter(): void {
        this.left = false;
    }

    /** The workspace went away: end everything it started and close the preview. */
    leave(): void {
        this.left = true;
        this.sessionEpoch += 1;
        this.intakeEpoch += 1;
        this.abort('all');
        void this.owner.close();
    }

    /** Stop the intake in progress. The Drawing Set is kept. */
    stopIntake(): void {
        this.intakeEpoch += 1;
        this.abort('intake');
    }

    /** End every piece of work and start a new, empty session. Nothing of the old one is kept. */
    reset(): void {
        this.sessionEpoch += 1;
        this.intakeEpoch += 1;
        this.abort('all');
        void this.owner.close();
        this.startSession();
        this.publish();
    }

    // ------------------------------------------------------------- writing

    private write(next: DrawingSet): void {
        if (!this.session) return;
        this.session = { ...this.session, drawingSet: next };
        this.ledger?.releaseRetired(next);
        this.publish();
    }

    /**
     * Change the Drawing Set, synchronously, from what it is now. `mutate`
     * returns the next set, or null to change nothing. The one way any later
     * operation on the model (profiles, assignment, confirmation) writes.
     */
    update(mutate: (set: DrawingSet) => DrawingSet | null): DrawingSet | null {
        if (this.left || !this.session) return null;
        const before = this.session.drawingSet;
        const next = mutate(before);
        if (!next || next === before) return null;
        if (next.id !== before.id) throw new Error('update() cannot replace the Drawing Set with another');
        this.write(next);
        return next;
    }

    /** Retire a Source and its Sheets, close its preview and let go of its File. */
    removeSource(sourceId: Uuid): { ok: true; removed: Source | null } | { ok: false; message: string } {
        if (this.left || !this.session) return { ok: false, message: 'ファイルを外せませんでした。' };
        const before = this.session.drawingSet;
        let next: DrawingSet;
        try {
            next = retireSource(before, sourceId);
        } catch (error) {
            return { ok: false, message: error instanceof IntakeStop && error.refusal ? error.refusal.message : 'ファイルを外せませんでした。' };
        }
        void this.owner.closeIfSource(sourceId);
        const removed = before.sources.find((source) => source.id === sourceId) ?? null;
        if (next !== before) this.write(next);
        return { ok: true, removed };
    }

    // --------------------------------------------------------------- intake

    /**
     * Take one file in, as one transaction through the page's gate, and
     * settle the outcome into the session in one step: a new Source with its
     * File bound by the intake's own read, the File reconnected to the live
     * Source that has its bytes, or nothing.
     */
    async intake(file: File, options: { onProgress?: (progress: IntakeProgress) => void } = {}): Promise<StoreIntakeResult> {
        const ticket = { session: this.sessionEpoch, intake: this.intakeEpoch };
        const current = (): boolean => !this.left && ticket.session === this.sessionEpoch && ticket.intake === this.intakeEpoch;
        const controller = this.track('intake');
        // Take a place in the page's queue before waiting, so no later call can start first.
        const previous = intakeChains.get(this.gate) ?? Promise.resolve();
        let done: () => void = () => { };
        intakeChains.set(this.gate, new Promise<void>((resolve) => { done = resolve; }));
        try {
            await previous;
            if (!current() || controller.signal.aborted || !this.session) return { kind: 'cancelled' };
            const outcome = await intakeSource(file, {
                signal: controller.signal,
                current: () => this.currentSet(),
                gate: this.gate,
                onProgress: (progress) => { if (current()) options.onProgress?.(progress); },
            });
            if (!current() || controller.signal.aborted) return { kind: 'cancelled' };
            return this.settleIntake(outcome);
        } finally {
            this.work.delete(controller);
            done();
        }
    }

    private settleIntake(outcome: IntakeOutcome): StoreIntakeResult {
        const session = this.session;
        const ledger = this.ledger;
        if (!session || !ledger) return { kind: 'cancelled' };
        switch (outcome.kind) {
            case 'candidate': {
                const result = commitSourceCandidate(session.drawingSet, outcome.candidate);
                if (result.kind === 'refused') return { kind: 'refused', refusal: result.refusal };
                if (result.kind === 'duplicate') return this.reconnect(result.existing, outcome.evidence);
                const { source, sheets } = outcome.candidate;
                this.session = { ...session, drawingSet: result.drawingSet };
                // The intake read every byte: its digest binds the File it read.
                ledger.presentVerified(result.drawingSet, source.id, outcome.evidence);
                this.publish();
                return { kind: 'accepted', source, sheets };
            }
            case 'duplicate': {
                const existing = liveSourceWithContent(session.drawingSet, outcome.sha256);
                if (existing) return this.reconnect(existing, outcome.evidence);
                // The Source with these bytes was removed while this file was read.
                return {
                    kind: 'refused',
                    refusal: refusal('DUPLICATE_REMOVED', `同じ内容のファイル「${outcome.existing.displayName}」が読み込み中に外されたため、追加しませんでした。もう一度選んでください。`),
                };
            }
            case 'refused':
                return { kind: 'refused', refusal: outcome.refusal };
            case 'cancelled':
                return { kind: 'cancelled' };
        }
    }

    /**
     * The selected File has the bytes of a live Source (HD-B-05). A Source
     * whose File this session already vouches for keeps it; the selection is
     * the spare, reported and not added. Otherwise the File the intake read is
     * presented for that Source, with the digest of that read -- the same
     * Source, its Sheets and its fingerprint untouched.
     */
    private reconnect(existing: Source, evidence: FileDigest): StoreIntakeResult {
        const session = this.session;
        const ledger = this.ledger;
        if (!session || !ledger) return { kind: 'cancelled' };
        if (verifiedBinding(ledger, session.drawingSet, existing.id) === 'MATCHED') return { kind: 'duplicate', existing };
        if (ledger.presentVerified(session.drawingSet, existing.id, evidence) !== 'APPLIED') return { kind: 'duplicate', existing };
        this.publish();
        return { kind: 'reconnected', existing };
    }

    // -------------------------------------------------------------- preview

    /**
     * Open the preview document of a Source from the File held for it, and
     * take the preview's read as a check of that File. Passed to the viewer.
     */
    readonly openPreview = (sourceId: Uuid, _file: Blob, expected: ExpectedContent): Promise<PDFDocumentProxy> => {
        const ledger = this.ledger;
        const set = this.currentSet();
        // Left, or no session: nothing is opened that no session would check.
        if (!ledger || set === NO_SESSION_SET) return Promise.reject(new PreviewError('CLOSED', 'closed'));
        const sessionEpoch = this.sessionEpoch;
        const current = (): boolean => sessionEpoch === this.sessionEpoch && this.ledger === ledger && !this.left;
        const settle = (check: BindingCheck, result: SourceFileCheck): void => {
            if (!current()) return;
            const settled = ledger.settle(this.currentSet(), check, new Map([[sourceId, result]]));
            if (settled.get(sourceId) === 'APPLIED') this.publish();
        };
        const held = ledger.heldFile(sourceId);
        if (!held) {
            const check = ledger.beginCheck(set);
            check.fileFor(sourceId);
            settle(check, { kind: 'NOT_READ', file: null, reason: 'NO_FILE' });
            return Promise.reject(new PreviewError('READ_FAILED', 'ファイルを読み込めませんでした。ファイルが移動・変更されていないか確認してください。'));
        }
        // The check is begun when the read begins, not now: the owner may first
        // wait for an earlier document to be released, and a check is ordered by
        // when its File was handed out.
        let check: BindingCheck | null = null;
        return this.owner.open(sourceId, held, expected, {
            scope: set.id,
            beginRead: () => {
                if (!current()) return;
                const begun = ledger.beginCheck(this.currentSet());
                // Another File presented meanwhile: this read is not a check of the File held.
                check = begun.fileFor(sourceId) === held ? begun : null;
            },
            onRead: (result) => { if (check) settle(check, result); },
        });
    };

    // ----------------------------------------------------------- extraction

    /**
     * Read the title blocks of the named Sheets through the page's gate, with
     * this session's Files, and settle what the run found about each File into
     * the ledger. M7-P2-B wires it here so intake, the preview and extraction
     * share one gate; no screen starts it yet.
     */
    async extract(
        request: { sheetIds: readonly Uuid[] },
        options: {
            signal?: AbortSignal;
            onProgress?: (event: ExtractionProgress) => void;
            createOcr?: () => GuardedRegisterOcr;
            chunkBytes?: number;
            /** Wraps the check's hand-out, for tests that need to watch it. */
            fileFor?: (sourceId: Uuid, handOut: ExtractionContext['fileFor']) => Blob | null;
        } = {},
    ): Promise<{ report: ExtractionReport; settled: Map<Uuid, BindingSettlement> | null }> {
        const ledger = this.ledger;
        if (this.left || !this.session || !ledger) {
            return { report: { kind: 'refused', refusal: { code: 'UNAVAILABLE', message: '図面一式がないため、読み取れません。' } }, settled: null };
        }
        const sessionEpoch = this.sessionEpoch;
        const current = (): boolean => !this.left && sessionEpoch === this.sessionEpoch && this.ledger === ledger;
        const controller = this.track('extraction');
        const forward = (): void => controller.abort();
        options.signal?.addEventListener('abort', forward, { once: true });
        if (options.signal?.aborted) controller.abort();
        try {
            const check = ledger.beginCheck(this.currentSet());
            const report = await extractTitleBlocks(request, {
                current: () => this.currentSet(),
                apply: (next) => { if (current() && this.session && next.id === this.session.drawingSet.id) this.write(next); },
                fileFor: options.fileFor ? (sourceId) => options.fileFor!(sourceId, check.fileFor) : check.fileFor,
                gate: this.gate,
                signal: controller.signal,
                createOcr: options.createOcr,
                chunkBytes: options.chunkBytes,
                onProgress: options.onProgress,
            });
            let settled: Map<Uuid, BindingSettlement> | null = null;
            if (report.kind === 'finished' && current()) {
                settled = ledger.settle(this.currentSet(), check, report.fileChecks);
                this.publish();
            }
            return { report, settled };
        } finally {
            options.signal?.removeEventListener('abort', forward);
            this.work.delete(controller);
        }
    }
}
