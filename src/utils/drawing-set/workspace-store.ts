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
 * Commands (M7-P2-B2). What a person does to the session -- profiles and
 * their assignment, extraction, confirmation, checking a File -- is a command
 * here that answers `{ ok: true, ... }` or `{ ok: false, refusal }`, decided
 * from the session as it is at that moment. The screen calls commands and
 * never update(), which cannot tell a refusal from "nothing changed".
 *  - Operation lock (B2-D02): while extraction runs, every command that
 *    would change what it reads is refused (OPERATION_LOCKED); cancel, reset
 *    and leaving are not. The lock is taken synchronously when extraction is
 *    asked for and let go once the run has ended -- its document destroyed,
 *    its lease given back -- and only by that run.
 *  - Confirmation evidence (B2-D01, HD-B-03 A+B+C): a Sheet is confirmed one
 *    at a time, against its CURRENT observation, and only with an
 *    EvidenceHandle this store issued after the original-drawing crops of
 *    that Sheet's field rectangles were drawn from the preview's own document
 *    and placed in the confirmation panel. The handle remembers what they
 *    were drawn against -- the session, the Sheet, the File presented and
 *    the check of it (the ledger's stamp), the binding, the profile revision
 *    and the assignment, the observation, the values and how each was read,
 *    the rectangles, the document, and the display generation -- and
 *    confirming checks every one against the session as it is then. Anything
 *    that moved, a crop no longer on screen, or a handle this store did not
 *    issue, is refused. A handle confirms once. The screen never states that
 *    anything was shown: there is nothing in a command to state it with.
 *    The handle shows what the app put on the screen, not that anyone looked.
 *  - Values a person corrects are recorded against the observation they
 *    corrected (editedFields, HDR-36-01). This store never confirms with
 *    `basis: 'manual'`: a confirmation made here always names its profile.
 *
 * Nothing here is stored or sent anywhere. Files, the ledger, the epochs,
 * evidence and crops are runtime only and never enter the model.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { CROP_MESSAGES, CropError, cropShown, mountCrop, planCrop, releaseCrop, renderCrop } from './crop-service';
import type { BindingCheck, BindingSettlement, RecordCurrency, RuntimeBindings, SourceFileCheck } from './currency';
import { RuntimeBindingLedger, confirmationCurrency, observationCurrency, verifiedBinding, verifyHeldFile } from './currency';
import type { FieldProblem } from './field-bounds';
import type { FileDigest } from './file-evidence';
import type { IntakeRefusal } from './intake-policy';
import { IntakeStop, refusal } from './intake-policy';
import { confirmSheet as confirmSheetValues, withdrawConfirmation as withdrawSheetConfirmation } from './metadata-confirmation';
import type {
    AnalysisRunOutcome, DrawingSet, DrawingSetSession, FieldName, FieldValues, PageRotation, Rect, Sheet, Source, TitleBlockProfile, TransferModel, Uuid,
} from './model';
import { FIELD_NAMES, commitSourceCandidate, createSession, isLive, liveSourceWithContent, retireSource } from './model';
import type { PdfDocumentGate } from './pdf-document-gate';
import { GATE_MESSAGES } from './pdf-document-gate';
import type { ExpectedContent, PreviewDocumentOwner } from './preview-document';
import { PreviewError } from './preview-document';
import type { ExclusionCode, ExtractionContext, ExtractionProgress, ExtractionReport, GuardedRegisterOcr } from './register-extraction';
import { extractTitleBlocks } from './register-extraction';
import type { IntakeOutcome, IntakeProgress } from './source-intake';
import { intakeSource } from './source-intake';
import type { ProfileGeometry, ProfileRefusalCode } from './title-block-profiles';
import {
    assignProfile as assignSheets, createProfile as createTitleBlockProfile, findProfile, renameProfile as renameTitleBlockProfile,
    retireProfile as retireTitleBlockProfile, reviseProfile as reviseTitleBlockProfile, unassignProfile as unassignSheets,
} from './title-block-profiles';

export type SessionState = { ok: true; session: DrawingSetSession } | { ok: false; message: string };

/** Extraction's report, or the store's own refusal: another operation holds the lock. */
export type StoreExtractionReport = ExtractionReport | { kind: 'refused'; refusal: { code: 'OPERATION_LOCKED'; message: string } };

/** The operation that locks the session, while it runs. */
export interface StoreOperation {
    readonly kind: 'extraction';
    /** This store's own count; not a model id. */
    readonly runId: number;
    readonly phase: 'starting' | 'running' | 'cancelling';
    readonly sheetCount: number;
    readonly progress: null | {
        readonly sourceIndex: number;
        readonly sourceTotal: number;
        readonly pageNumber: number | null;
        readonly pageTotal: number | null;
    };
}

/** How the last extraction ended, for the screen. Counts and codes only. */
export interface ExtractionSummary {
    readonly runId: number;
    readonly kind: 'refused' | 'finished';
    readonly refusal: { code: string; message: string } | null;
    readonly outcome: AnalysisRunOutcome | null;
    readonly applied: boolean;
    readonly committed: number;
    readonly excluded: ReadonlyArray<{ code: ExclusionCode; count: number }>;
    readonly failure: 'RELEASE_UNCONFIRMED' | 'UNEXPECTED' | null;
}

/** What React renders. A new object whenever anything in it changes. */
export interface StoreSnapshot {
    readonly version: number;
    readonly state: SessionState;
    /** For display only: what currency and confirmation decide by is the ledger itself. */
    readonly bindings: RuntimeBindings;
    /** The operation in progress, if any: what the screen locks for. */
    readonly operation: StoreOperation | null;
    readonly lastExtraction: ExtractionSummary | null;
    /**
     * Moves whenever anything here changes, and whenever evidence was taken
     * back: evidence issued before it no longer confirms. The confirmation
     * panel draws its crops again when it moves.
     */
    readonly evidenceGeneration: number;
    /** A PDF.js document could not be released: nothing opens until the page is reloaded. */
    readonly documentsUnavailable: boolean;
    /** Moves when extraction gives the documents back, so a closed preview opens again. */
    readonly previewEpoch: number;
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

export type StoreRefusalCode =
    | 'UNAVAILABLE'
    | 'OPERATION_LOCKED'
    | 'RELEASE_UNCONFIRMED'
    | ProfileRefusalCode
    | 'NO_OBSERVATION'
    | 'OBSERVATION_NOT_CURRENT'
    | 'SOURCE_NOT_MATCHED'
    | 'SHEET_RETIRED'
    | 'VALUE_INVALID'
    | 'HISTORY_LIMIT'
    | 'NO_CONFIRMATION'
    /** The Sheet has no profile: there are no field rectangles to show the original drawing of (H-13). */
    | 'CROP_NOT_AVAILABLE'
    | 'CROP_TOO_LARGE'
    | 'CROP_NOT_SHOWN'
    /** The evidence is not this store's, was taken back, or something it was drawn against has moved. */
    | 'EVIDENCE_STALE'
    | 'VERIFY_IN_PROGRESS'
    | 'SOURCE_NOT_LIVE';

export interface StoreRefusal {
    code: StoreRefusalCode;
    message: string;
    field?: FieldName;
    sheetIds?: Uuid[];
    problems?: FieldProblem[];
}

export type Refused = { ok: false; refusal: StoreRefusal };

const MESSAGES = {
    UNAVAILABLE: '図面一式がないため、操作できません。',
    OPERATION_LOCKED: '表題欄の読み取り中は、この操作はできません。読み取りが終わるか、中止してから操作してください。',
    CROP_NOT_AVAILABLE: 'プロファイルが割り当てられていないページは確定できません。プロファイルを割り当てて読み取ると確定できます。',
    NO_OBSERVATION: 'このページはまだ読み取られていません。読み取りを実行してください。',
    OBSERVATION_NOT_CURRENT: '読み取り値が、現在のプロファイルやファイルと一致しません。読み取りを実行し直してください。',
    SOURCE_NOT_MATCHED: 'ファイルの内容（SHA-256）をこの画面で確認できていないため、確定できません。「ファイルを照合」で確認してください。',
    EVIDENCE_STALE: '表示した原図が最新ではありません。原図を表示し直してから確定してください。',
    VERIFY_IN_PROGRESS: 'このファイルは照合中です。',
    SOURCE_NOT_LIVE: 'ファイルが見つかりません。',
} as const;

const refuse = (code: StoreRefusalCode, message: string, extra: Partial<StoreRefusal> = {}): Refused =>
    ({ ok: false, refusal: { code, message, ...extra } });

type WorkKind = 'intake' | 'extraction' | 'evidence' | 'verify';

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

/** Only this module mints evidence. */
const MINT = Symbol('evidence');

/**
 * What a confirmation is made against: issued by DrawingSetStore once the
 * crops of one Sheet were drawn and placed, and recognised only by the store
 * that issued it. It carries nothing a caller can read or change; an object
 * shaped like it is not one.
 */
export class EvidenceHandle {
    readonly #sheetId: Uuid;
    constructor(mint: symbol, sheetId: Uuid) {
        if (mint !== MINT) throw new TypeError('evidence is issued by the session store');
        this.#sheetId = sheetId;
    }

    /** The Sheet it was issued for. */
    get sheetId(): Uuid {
        return this.#sheetId;
    }
}

/** Everything one handle was issued against. Runtime only. */
interface EvidenceRecord {
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly setId: Uuid;
    readonly sheetId: Uuid;
    readonly sourceId: Uuid;
    readonly pageNumber: number;
    readonly sourceSha256: string;
    readonly stamp: { presentedAt: number; checkedAt: number | null };
    readonly profileId: Uuid;
    readonly profileRevision: number;
    readonly assignedAt: string;
    readonly runId: Uuid;
    readonly digest: string;
    readonly upright: { width: number; height: number };
    readonly rects: Record<FieldName, Rect>;
    readonly doc: PDFDocumentProxy;
    readonly panel: HTMLElement;
    readonly canvases: Record<FieldName, HTMLCanvasElement>;
    observer: ResizeObserver | null;
    /** Null while it stands. */
    revoked: null | 'EVIDENCE_STALE' | 'CROP_NOT_SHOWN';
}

/** What the crops were drawn for, as the screen shows it beside them. */
export interface EvidenceView {
    sheetId: Uuid;
    rotate: PageRotation;
    fields: Record<FieldName, { rect: Rect; width: number; height: number }>;
}

/** What a person reads for one field: the value, and how the machine got it. Display text only. */
export const valuesDigest = (sheet: Sheet): string =>
    JSON.stringify(FIELD_NAMES.map((name) => {
        const field = sheet.observation?.fields[name];
        return [name, field?.value ?? null, field?.source ?? null];
    }));

const sameRect = (a: Rect, b: Rect): boolean => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

const nextFrame = (): Promise<void> => new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
});

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

    private operation: StoreOperation | null = null;
    private operationController: AbortController | null = null;
    private runCounter = 0;
    private lastExtraction: ExtractionSummary | null = null;
    private evidenceGeneration = 0;
    private previewEpoch = 0;
    private readonly evidence = new WeakMap<EvidenceHandle, EvidenceRecord>();
    /** At most one Sheet's crops are held at a time. */
    private standing: EvidenceRecord | null = null;
    private readonly verifying = new Set<Uuid>();

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
        return {
            version: this.version,
            state,
            bindings,
            operation: this.operation,
            lastExtraction: this.lastExtraction,
            evidenceGeneration: this.evidenceGeneration,
            documentsUnavailable: this.owner.documentsUnavailable || this.gate.releaseUnconfirmed,
            previewEpoch: this.previewEpoch,
        };
    }

    private publish(): void {
        this.version += 1;
        // Whatever changed, evidence issued before it does not confirm.
        this.evidenceGeneration += 1;
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

    /**
     * How a Sheet's reading and confirmation stand now, as the ledger knows
     * its Source's File -- for the screen, which never holds the ledger itself.
     */
    currencyOf(sheet: Sheet): { observation: RecordCurrency; confirmation: RecordCurrency } | null {
        const set = this.currentSet();
        if (!this.ledger || set === NO_SESSION_SET) return null;
        return { observation: observationCurrency(set, sheet, this.ledger), confirmation: confirmationCurrency(set, sheet, this.ledger) };
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

    /** End every operation and every piece of evidence: the session they were for is over. */
    private endSessionWork(): void {
        this.operation = null;
        this.operationController = null;
        this.verifying.clear();
        this.revokeStanding('EVIDENCE_STALE');
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
        this.endSessionWork();
        this.evidenceGeneration += 1;
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
        this.endSessionWork();
        void this.owner.close();
        this.startSession();
        this.lastExtraction = null;
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
     * returns the next set, or null to change nothing. The foundation's raw
     * writer: the screen uses the commands below instead, which refuse while
     * an operation holds the lock and say why.
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

    /** The session as a command sees it, or why there is none to act on. */
    private commandable(): { set: DrawingSet; ledger: RuntimeBindingLedger } | Refused {
        if (this.left || !this.session || !this.ledger) return refuse('UNAVAILABLE', MESSAGES.UNAVAILABLE);
        if (this.operation) return refuse('OPERATION_LOCKED', MESSAGES.OPERATION_LOCKED);
        return { set: this.session.drawingSet, ledger: this.ledger };
    }

    /** Retire a Source and its Sheets, close its preview and let go of its File. */
    removeSource(sourceId: Uuid): { ok: true; removed: Source | null } | { ok: false; message: string; code?: 'OPERATION_LOCKED' } {
        if (this.left || !this.session) return { ok: false, message: 'ファイルを外せませんでした。' };
        if (this.operation) return { ok: false, message: MESSAGES.OPERATION_LOCKED, code: 'OPERATION_LOCKED' };
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

    // ------------------------------------------------------------- profiles

    /** Write a profile operation's result, or pass its refusal on. */
    private applyProfileResult<T extends { ok: true; drawingSet: DrawingSet }>(
        result: T | { ok: false; refusal: { code: ProfileRefusalCode; message: string; field?: FieldName; sheetIds?: Uuid[] } },
    ): T | Refused {
        if (!result.ok) return { ok: false, refusal: { ...result.refusal } };
        if (this.session && result.drawingSet !== this.session.drawingSet) this.write(result.drawingSet);
        return result;
    }

    createProfile(input: { name: string; transferModel: TransferModel; referencePage: ProfileGeometry['referencePage']; fields: Record<FieldName, Rect> }) {
        const at = this.commandable();
        if ('ok' in at) return at;
        try {
            return this.applyProfileResult(createTitleBlockProfile(at.set, input));
        } catch (error) {
            return refuse('UNAVAILABLE', startMessage(error));
        }
    }

    renameProfile(profileId: Uuid, name: string) {
        const at = this.commandable();
        if ('ok' in at) return at;
        try {
            return this.applyProfileResult(renameTitleBlockProfile(at.set, profileId, name));
        } catch (error) {
            return refuse('UNAVAILABLE', startMessage(error));
        }
    }

    reviseProfile(profileId: Uuid, change: Partial<ProfileGeometry>) {
        const at = this.commandable();
        if ('ok' in at) return at;
        try {
            return this.applyProfileResult(reviseTitleBlockProfile(at.set, profileId, change));
        } catch (error) {
            return refuse('UNAVAILABLE', startMessage(error));
        }
    }

    retireProfile(profileId: Uuid) {
        const at = this.commandable();
        if ('ok' in at) return at;
        try {
            return this.applyProfileResult(retireTitleBlockProfile(at.set, profileId));
        } catch (error) {
            return refuse('UNAVAILABLE', startMessage(error));
        }
    }

    /** Put the named Sheets under a profile; a Sheet on another profile moves only with `replace`. */
    assignProfile(sheetIds: readonly Uuid[], profileId: Uuid, options: { replace?: boolean } = {}) {
        const at = this.commandable();
        if ('ok' in at) return at;
        try {
            return this.applyProfileResult(assignSheets(at.set, sheetIds, profileId, options));
        } catch (error) {
            return refuse('UNAVAILABLE', startMessage(error));
        }
    }

    unassignProfile(sheetIds: readonly Uuid[]) {
        const at = this.commandable();
        if ('ok' in at) return at;
        return this.applyProfileResult(unassignSheets(at.set, sheetIds));
    }

    // --------------------------------------------------------------- intake

    /**
     * Take one file in, as one transaction through the page's gate, and
     * settle the outcome into the session in one step: a new Source with its
     * File bound by the intake's own read, the File reconnected to the live
     * Source that has its bytes, or nothing.
     */
    async intake(file: File, options: { onProgress?: (progress: IntakeProgress) => void } = {}): Promise<StoreIntakeResult> {
        if (this.operation) return { kind: 'refused', refusal: refusal('OPERATION_LOCKED', MESSAGES.OPERATION_LOCKED) };
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

    /**
     * Check the File held for one Source again, now (B2-D04): only when a
     * person asks, never on a timer. One check per Source at a time.
     */
    async verifyFile(sourceId: Uuid): Promise<{ ok: true; settlement: BindingSettlement | 'CANCELLED' } | Refused> {
        const at = this.commandable();
        if ('ok' in at) return at;
        if (!at.set.sources.some((source) => source.id === sourceId && isLive(source))) return refuse('SOURCE_NOT_LIVE', MESSAGES.SOURCE_NOT_LIVE);
        if (this.verifying.has(sourceId)) return refuse('VERIFY_IN_PROGRESS', MESSAGES.VERIFY_IN_PROGRESS);
        const ledger = at.ledger;
        const sessionEpoch = this.sessionEpoch;
        const controller = this.track('verify');
        this.verifying.add(sourceId);
        try {
            const settlement = await verifyHeldFile(ledger, () => this.currentSet(), sourceId, { signal: controller.signal });
            if (sessionEpoch === this.sessionEpoch && !this.left && settlement === 'APPLIED') this.publish();
            return { ok: true, settlement };
        } finally {
            this.work.delete(controller);
            if (sessionEpoch === this.sessionEpoch) this.verifying.delete(sourceId);
        }
    }

    // ----------------------------------------------------------- extraction

    /** Ask the extraction in progress to stop. Idempotent; nothing to stop is fine. */
    cancelExtraction(): void {
        const operation = this.operation;
        if (!operation || !this.operationController) return;
        this.operationController.abort();
        if (operation.phase !== 'cancelling') {
            this.operation = { ...operation, phase: 'cancelling' };
            this.publish();
        }
    }

    /** Read the title blocks of the named Sheets, from the screen. The report is kept for display. */
    async startExtraction(sheetIds: readonly Uuid[]): Promise<ExtractionSummary> {
        const runId = this.runCounter + 1;
        const { report } = await this.extract({ sheetIds });
        const summary = summarise(runId, report);
        if (report.kind !== 'refused' || report.refusal.code !== 'OPERATION_LOCKED') {
            this.lastExtraction = summary;
            if (!this.left) this.publish();
        }
        return summary;
    }

    /**
     * Read the title blocks of the named Sheets through the page's gate, with
     * this session's Files, and settle what the run found about each File into
     * the ledger. Holds the operation lock from the moment it is asked for
     * until the run has ended; refused (OPERATION_LOCKED) while another holds it.
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
    ): Promise<{ report: StoreExtractionReport; settled: Map<Uuid, BindingSettlement> | null }> {
        const ledger = this.ledger;
        if (this.left || !this.session || !ledger) {
            return { report: { kind: 'refused', refusal: { code: 'UNAVAILABLE', message: '図面一式がないため、読み取れません。' } }, settled: null };
        }
        if (this.operation) {
            return { report: { kind: 'refused', refusal: { code: 'OPERATION_LOCKED', message: MESSAGES.OPERATION_LOCKED } }, settled: null };
        }
        const sessionEpoch = this.sessionEpoch;
        const current = (): boolean => !this.left && sessionEpoch === this.sessionEpoch && this.ledger === ledger;
        const controller = this.track('extraction');
        const runId = ++this.runCounter;
        const mine = (): boolean => current() && this.operation?.runId === runId;
        // Locked before anything else can be asked: the screen and every command see it at once.
        this.operation = { kind: 'extraction', runId, phase: 'starting', sheetCount: request.sheetIds.length, progress: null };
        this.operationController = controller;
        this.revokeStanding('EVIDENCE_STALE');
        this.publish();
        const forward = (): void => controller.abort();
        options.signal?.addEventListener('abort', forward, { once: true });
        if (options.signal?.aborted) controller.abort();
        let published = false;
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
                // Progress of a run that is no longer this session's, or was stopped, is never shown.
                onProgress: (event) => {
                    if (!mine() || controller.signal.aborted) return;
                    this.noteProgress(runId, event);
                    options.onProgress?.(event);
                },
            });
            let settled: Map<Uuid, BindingSettlement> | null = null;
            if (report.kind === 'finished' && current()) {
                settled = ledger.settle(this.currentSet(), check, report.fileChecks);
                published = true;
            }
            return { report, settled };
        } finally {
            options.signal?.removeEventListener('abort', forward);
            this.work.delete(controller);
            // Only the run that took the lock lets it go: its document is destroyed and its lease given back by now.
            if (this.operation?.runId === runId) {
                this.operation = null;
                this.operationController = null;
                published = true;
            }
            if (current()) {
                this.previewEpoch += 1;
                if (published) this.publish();
            }
        }
    }

    private noteProgress(runId: number, event: ExtractionProgress): void {
        const operation = this.operation;
        if (!operation || operation.runId !== runId) return;
        const progress = operation.progress;
        let next: StoreOperation['progress'];
        switch (event.phase) {
            case 'source':
                next = { sourceIndex: event.sourceIndex, sourceTotal: event.sourceTotal, pageNumber: null, pageTotal: null };
                break;
            case 'page':
                next = { sourceIndex: progress?.sourceIndex ?? 0, sourceTotal: progress?.sourceTotal ?? 1, pageNumber: event.pageNumber, pageTotal: event.pageTotal };
                break;
            default:
                next = progress;
        }
        this.operation = { ...operation, phase: operation.phase === 'cancelling' ? 'cancelling' : 'running', progress: next };
        this.publish();
    }

    // --------------------------------------------------------- confirmation

    /** Why `sheet` cannot be confirmed now, before any crop is drawn; null when it can. */
    private confirmable(set: DrawingSet, ledger: RuntimeBindingLedger, sheet: Sheet | undefined): Refused | { sheet: Sheet; profile: TitleBlockProfile } {
        if (!sheet || !isLive(sheet)) return refuse('SHEET_RETIRED', '外したファイルのページは確定できません。');
        if (this.owner.documentsUnavailable || this.gate.releaseUnconfirmed) return refuse('RELEASE_UNCONFIRMED', GATE_MESSAGES.RELEASE_UNCONFIRMED);
        if (!sheet.profileAssignment) return refuse('CROP_NOT_AVAILABLE', MESSAGES.CROP_NOT_AVAILABLE);
        const profile = findProfile(set, sheet.profileAssignment.profileId);
        if (!profile || !isLive(profile)) return refuse('CROP_NOT_AVAILABLE', MESSAGES.CROP_NOT_AVAILABLE);
        if (!sheet.observation) return refuse('NO_OBSERVATION', MESSAGES.NO_OBSERVATION);
        if (verifiedBinding(ledger, set, sheet.sourceId) !== 'MATCHED') return refuse('SOURCE_NOT_MATCHED', MESSAGES.SOURCE_NOT_MATCHED);
        if (observationCurrency(set, sheet, ledger).state !== 'CURRENT') return refuse('OBSERVATION_NOT_CURRENT', MESSAGES.OBSERVATION_NOT_CURRENT);
        return { sheet, profile };
    }

    /**
     * Draw the original-drawing crops of one Sheet's four fields and place
     * them in the panel's slots, then -- once the next frame shows them in
     * place -- issue the evidence a confirmation of that Sheet needs. The
     * crops of any other Sheet are taken back first: one Sheet's are held at
     * a time. Refused when the Sheet cannot be confirmed (no profile, no
     * CURRENT observation, the File not MATCHED), the crops cannot be drawn
     * (CROP_TOO_LARGE, CROP_NOT_SHOWN), or anything moved meanwhile
     * (EVIDENCE_STALE).
     */
    async prepareEvidence(
        sheetId: Uuid,
        mount: { panel: HTMLElement; slots: Record<FieldName, HTMLElement> },
        options: { signal?: AbortSignal } = {},
    ): Promise<{ ok: true; handle: EvidenceHandle; view: EvidenceView } | Refused> {
        const at = this.commandable();
        if ('ok' in at) return at;
        const ready = this.confirmable(at.set, at.ledger, at.set.sheets.find((s) => s.id === sheetId));
        if ('ok' in ready) return ready;
        const { sheet, profile } = ready;
        const source = at.set.sources.find((s) => s.id === sheet.sourceId)!;
        const held = at.ledger.heldFile(source.id);
        const stamp = at.ledger.presentationStamp(source.id);
        if (!held || !stamp) return refuse('SOURCE_NOT_MATCHED', MESSAGES.SOURCE_NOT_MATCHED);
        this.revokeStanding('EVIDENCE_STALE');
        const issuedFor = {
            generation: this.evidenceGeneration,
            sessionEpoch: this.sessionEpoch,
            setId: at.set.id,
            ledger: at.ledger,
        };
        const stillCurrent = (): boolean => !this.left && issuedFor.sessionEpoch === this.sessionEpoch && issuedFor.generation === this.evidenceGeneration
            && this.ledger === issuedFor.ledger && this.session?.drawingSet.id === issuedFor.setId && !this.operation;
        const controller = this.track('evidence');
        const stop = (): void => controller.abort();
        options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) controller.abort();
        let crop: Awaited<ReturnType<typeof renderCrop>> | null = null;
        try {
            let doc: PDFDocumentProxy;
            try {
                doc = await this.openPreview(source.id, held, { sha256: source.fingerprint.sha256, byteLength: source.fingerprint.byteLength });
            } catch (error) {
                return this.previewRefusal(error);
            }
            if (!stillCurrent() || controller.signal.aborted) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
            try {
                crop = await renderCrop(this.owner, doc, sheet.pageNumber, profile, { signal: controller.signal });
            } catch (error) {
                if (error instanceof CropError) return refuse(error.code, error.message);
                return this.previewRefusal(error);
            }
            if (!stillCurrent() || controller.signal.aborted || !this.owner.holds(doc)) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
            const rotate = sheet.pageFacts?.rotate ?? 0;
            for (const name of FIELD_NAMES) mountCrop(crop.canvases[name], mount.slots[name], rotate);
            // Shown means: in place, on the next frame, inside the panel.
            await nextFrame();
            if (!stillCurrent() || controller.signal.aborted || !this.owner.holds(doc)) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
            if (!FIELD_NAMES.every((name) => cropShown(crop!.canvases[name], mount.panel))) return refuse('CROP_NOT_SHOWN', CROP_MESSAGES.CROP_NOT_SHOWN);

            const handle = new EvidenceHandle(MINT, sheet.id);
            const record: EvidenceRecord = {
                generation: issuedFor.generation,
                sessionEpoch: issuedFor.sessionEpoch,
                setId: issuedFor.setId,
                sheetId: sheet.id,
                sourceId: source.id,
                pageNumber: sheet.pageNumber,
                sourceSha256: source.fingerprint.sha256,
                stamp: { presentedAt: stamp.presentedAt, checkedAt: stamp.checkedAt },
                profileId: profile.id,
                profileRevision: profile.revision,
                assignedAt: sheet.profileAssignment!.confirmedAt,
                runId: sheet.observation!.runId,
                digest: valuesDigest(sheet),
                upright: { width: crop.plan.uprightWidthPt, height: crop.plan.uprightHeightPt },
                rects: Object.fromEntries(FIELD_NAMES.map((name) => [name, { ...crop!.plan.fields[name].rect }])) as Record<FieldName, Rect>,
                doc,
                panel: mount.panel,
                canvases: crop.canvases,
                observer: null,
                revoked: null,
            };
            // Taken off the screen, or hidden so it has no size: the evidence is taken back.
            if (typeof ResizeObserver === 'function') {
                const observer = new ResizeObserver((entries) => {
                    if (entries.some((entry) => entry.contentRect.width === 0 || entry.contentRect.height === 0)) this.revoke(record, 'CROP_NOT_SHOWN');
                });
                for (const name of FIELD_NAMES) observer.observe(crop.canvases[name]);
                record.observer = observer;
            }
            this.evidence.set(handle, record);
            this.standing = record;
            const view: EvidenceView = {
                sheetId: sheet.id,
                rotate,
                fields: Object.fromEntries(FIELD_NAMES.map((name) => [name, { ...crop!.plan.fields[name] }])) as EvidenceView['fields'],
            };
            crop = null;
            return { ok: true, handle, view };
        } finally {
            options.signal?.removeEventListener('abort', stop);
            this.work.delete(controller);
            // Not issued: nothing of it is kept.
            if (crop) releaseCrop(crop.canvases);
        }
    }

    private previewRefusal(error: unknown): Refused {
        if (error instanceof PreviewError && error.code === 'RELEASE_UNCONFIRMED') return refuse('RELEASE_UNCONFIRMED', error.message);
        if (error instanceof PreviewError && error.code === 'EXTRACTION_ACTIVE') return refuse('OPERATION_LOCKED', MESSAGES.OPERATION_LOCKED);
        if (error instanceof PreviewError && (error.code === 'SOURCE_CHANGED' || error.code === 'READ_FAILED')) return refuse('SOURCE_NOT_MATCHED', error.message);
        if (error instanceof PreviewError && error.code === 'CLOSED') return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        return refuse('CROP_NOT_SHOWN', CROP_MESSAGES.CROP_NOT_SHOWN);
    }

    private revoke(record: EvidenceRecord, why: 'EVIDENCE_STALE' | 'CROP_NOT_SHOWN'): void {
        if (record.revoked) return;
        record.revoked = why;
        record.observer?.disconnect();
        if (this.standing === record) this.standing = null;
        if (why === 'CROP_NOT_SHOWN') this.publish();
    }

    private revokeStanding(why: 'EVIDENCE_STALE' | 'CROP_NOT_SHOWN'): void {
        const standing = this.standing;
        if (!standing) return;
        this.revoke(standing, why);
        releaseCrop(standing.canvases);
    }

    /** The panel is done with this evidence: take it back and release its crops. Idempotent. */
    releaseEvidence(handle: EvidenceHandle | null): void {
        const record = handle ? this.evidence.get(handle) : undefined;
        if (!record) return;
        if (!record.revoked) this.revoke(record, 'EVIDENCE_STALE');
        releaseCrop(record.canvases);
    }

    /**
     * Confirm one Sheet's four values, against its CURRENT observation and the
     * evidence issued for it. Every element the evidence was issued against is
     * checked again, from the session as it is now; then the confirmation
     * itself is the pure confirmSheet's, with `basis: 'observation'` --
     * values a person changed are recorded in editedFields. One Sheet per
     * call; the evidence confirms once.
     */
    confirmSheet(request: { sheetId: Uuid; values: FieldValues; evidence: EvidenceHandle }) {
        const at = this.commandable();
        if ('ok' in at) return at;
        const { set, ledger } = at;
        const sheet = set.sheets.find((s) => s.id === request.sheetId);
        if (sheet && isLive(sheet) && !sheet.profileAssignment) return refuse('CROP_NOT_AVAILABLE', MESSAGES.CROP_NOT_AVAILABLE);
        const record = request.evidence instanceof EvidenceHandle ? this.evidence.get(request.evidence) : undefined;
        if (!record) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        if (record.revoked === 'CROP_NOT_SHOWN') return refuse('CROP_NOT_SHOWN', CROP_MESSAGES.CROP_NOT_SHOWN);
        if (record.revoked) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        if (this.owner.documentsUnavailable || this.gate.releaseUnconfirmed) return refuse('RELEASE_UNCONFIRMED', GATE_MESSAGES.RELEASE_UNCONFIRMED);
        if (!sheet || record.sheetId !== sheet.id || !isLive(sheet)) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        // The binding first: a File no longer vouched for is said so, whatever else moved.
        if (verifiedBinding(ledger, set, sheet.sourceId) !== 'MATCHED') return refuse('SOURCE_NOT_MATCHED', MESSAGES.SOURCE_NOT_MATCHED);
        const source = set.sources.find((s) => s.id === sheet.sourceId);
        const profile = sheet.profileAssignment ? findProfile(set, sheet.profileAssignment.profileId) : null;
        const stamp = ledger.presentationStamp(sheet.sourceId);
        const unchanged = record.generation === this.evidenceGeneration
            && record.sessionEpoch === this.sessionEpoch
            && record.setId === set.id
            && record.sourceId === sheet.sourceId
            && record.pageNumber === sheet.pageNumber
            && source !== undefined && record.sourceSha256 === source.fingerprint.sha256
            && stamp !== null && stamp.presentedAt === record.stamp.presentedAt && stamp.checkedAt === record.stamp.checkedAt
            && profile !== null && isLive(profile) && record.profileId === profile.id && record.profileRevision === profile.revision
            && record.assignedAt === sheet.profileAssignment!.confirmedAt
            && this.owner.holds(record.doc);
        if (!unchanged) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        // The rectangles drawn are the ones this profile places on that page now.
        const plan = planCrop(profile!, record.upright);
        if (!FIELD_NAMES.every((name) => sameRect(plan.fields[name].rect, record.rects[name]))) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        if (!sheet.observation || sheet.observation.runId !== record.runId || observationCurrency(set, sheet, ledger).state !== 'CURRENT') {
            return refuse('OBSERVATION_NOT_CURRENT', MESSAGES.OBSERVATION_NOT_CURRENT);
        }
        if (valuesDigest(sheet) !== record.digest) return refuse('EVIDENCE_STALE', MESSAGES.EVIDENCE_STALE);
        if (!FIELD_NAMES.every((name) => cropShown(record.canvases[name], record.panel))) {
            this.revoke(record, 'CROP_NOT_SHOWN');
            return refuse('CROP_NOT_SHOWN', CROP_MESSAGES.CROP_NOT_SHOWN);
        }
        const result = confirmSheetValues(set, { sheetId: sheet.id, values: request.values, basis: 'observation' }, ledger);
        if (!result.ok) return { ok: false as const, refusal: { ...result.refusal } };
        // Confirmed once: this evidence is spent, and the panel draws afresh.
        this.revoke(record, 'EVIDENCE_STALE');
        this.write(result.drawingSet);
        return result;
    }

    /** Withdraw the confirmation that stands for one Sheet, keeping it in the history. */
    withdrawConfirmation(sheetId: Uuid) {
        const at = this.commandable();
        if ('ok' in at) return at;
        const result = withdrawSheetConfirmation(at.set, sheetId);
        if (!result.ok) return { ok: false as const, refusal: { ...result.refusal } };
        this.write(result.drawingSet);
        return result;
    }
}

function summarise(runId: number, report: StoreExtractionReport): ExtractionSummary {
    if (report.kind === 'refused') {
        return { runId, kind: 'refused', refusal: { ...report.refusal }, outcome: null, applied: false, committed: 0, excluded: [], failure: null };
    }
    const counts = new Map<ExclusionCode, number>();
    for (const exclusion of report.excluded) counts.set(exclusion.code, (counts.get(exclusion.code) ?? 0) + 1);
    return {
        runId,
        kind: 'finished',
        refusal: null,
        outcome: report.outcome,
        applied: report.applied,
        committed: report.committedSheetIds.length,
        excluded: [...counts].map(([code, count]) => ({ code, count })),
        failure: report.failure,
    };
}
