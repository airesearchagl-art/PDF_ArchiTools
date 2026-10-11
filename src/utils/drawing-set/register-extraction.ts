/**
 * Reading the title blocks of chosen Sheets: one operation, one EXTRACTION run.
 *
 * The order is fixed (HDR-36-02):
 *  1. Under the document gate, take a snapshot of what is to be read -- the
 *     Sheets, their Sources' fingerprints, the profile and revision each is
 *     assigned -- and the manifest digest of every live Source.
 *  2. For each Source in turn: read its File again and check it still holds
 *     the fingerprinted bytes; open one PDF.js document from those bytes; run
 *     the Drawing Register's `extractRegister` on exactly the targeted pages;
 *     turn each row into an observation (register-adapter.ts); keep the
 *     Source's results to one side; destroy the document and wait for PDF.js
 *     before the next Source.
 *  3. When the operation ends -- completed, cancelled or failed -- append the
 *     run once, with its terminal outcome, and write every observation kept
 *     from fully processed Sources, in a single change to the model.
 *
 * Nothing is written to the model before step 3. A Source that was being read
 * when the operation was cancelled or failed contributes nothing: its partial
 * results never become partial observations. A Sheet that could not be read
 * keeps whatever observation it had. Coverage counts the targeted Sheets
 * only: evaluated are those that got an observation (OCR_FAILED included),
 * excluded are all the others -- skipped, interrupted or refused.
 *
 * Nothing here confirms anything. An observation is what the machine read;
 * only a person confirms (metadata-confirmation.ts).
 *
 * Cancelling stops the engine between pages, and stops waiting for it at
 * once: the recogniser is terminated (a recognition in flight cannot be
 * interrupted any other way), the document is destroyed, and the engine's own
 * promise is left to settle into nothing.
 */
import { extractRegister } from '../pdf-textifier/drawing-register-extract';
import { RegisterOcrEngine } from '../pdf-textifier/drawing-register-ocr';
import type { RegisterExtractionResult, TemplateProfile } from '../pdf-textifier/drawing-register-types';
import { REGISTER_EXTRACTION_ENGINE, hasRoomForRun, manifestDigest } from './analysis-run';
import type { SourceBinding } from './currency';
import type { FieldProblem } from './field-bounds';
import { MAX_ANALYSIS_RUNS } from './field-bounds';
import { fingerprintIntoBuffer } from './fingerprint-client';
import { IntakeStop, READ_CHUNK_BYTES } from './intake-policy';
import type {
    AnalysisRun, AnalysisRunOutcome, DrawingSet, Observation, ProfileBasis, Sha256Hex, Timestamp, Uuid,
} from './model';
import { isLive, mintUuid, nowTimestamp } from './model';
import type { ExtractionLease, GateRefusalCode, PdfDocumentGate } from './pdf-document-gate';
import { GATE_MESSAGES } from './pdf-document-gate';
import { assignmentsFor, observationFromRow, toTemplateProfile } from './register-adapter';

/**
 * The Drawing Register's recogniser, closable for good.
 *
 * A recognition in flight cannot be aborted, and tesseract.js does not settle
 * one whose worker is terminated, so cancelling means terminating the worker
 * and no longer waiting. Once closed, the engine refuses to start a new
 * worker -- including one whose start was already under way when it closed --
 * so a cancelled run cannot leave a worker behind.
 *
 * It also keeps nothing. M7 writes nothing to browser storage, and
 * tesseract.js by default stores the language data it downloads in IndexedDB
 * from inside its worker; `'none'` makes this engine's worker neither read nor
 * write that cache, so each run fetches the language data from this origin
 * again. The Drawing Register tool and the other pipelines construct their own
 * engines and keep tesseract.js's default.
 */
export class GuardedRegisterOcr extends RegisterOcrEngine {
    private closed = false;
    private readonly tally = { workersStarted: 0, closes: 0, refusedAfterClose: 0 };

    constructor() {
        // The languages stay the Drawing Register's own default.
        super(undefined, { cacheMethod: 'none' });
    }

    override async start(): Promise<void> {
        if (this.closed) {
            this.tally.refusedAfterClose += 1;
            throw new Error('OCR closed');
        }
        const wasStarted = this.started;
        await super.start();
        if (!wasStarted && this.started) this.tally.workersStarted += 1;
        if (this.closed) {
            await super.terminate().catch(() => { });
            throw new Error('OCR closed');
        }
    }

    override async terminate(): Promise<void> {
        await this.close();
    }

    /** Terminate the worker, if any, and refuse every later start. Never rejects. */
    async close(): Promise<void> {
        this.closed = true;
        this.tally.closes += 1;
        await super.terminate().catch(() => { });
    }

    counts(): { workersStarted: number; closes: number; refusedAfterClose: number; started: boolean } {
        return { ...this.tally, started: this.started };
    }
}

export type StartRefusalCode =
    | 'EMPTY_REQUEST'
    | 'DUPLICATE_TARGET'
    | 'SHEET_NOT_FOUND'
    | 'SHEET_RETIRED'
    | 'NOT_ASSIGNED'
    | 'PROFILE_RETIRED'
    | 'RUN_LIMIT'
    | 'UNAVAILABLE'
    | GateRefusalCode;

export interface StartRefusal {
    code: StartRefusalCode;
    message: string;
    sheetIds?: Uuid[];
}

export type ExclusionCode =
    /** This session holds no File for the Source. */
    | 'SOURCE_MISSING'
    /** The File could not be read. */
    | 'SOURCE_UNREADABLE'
    /** The File no longer holds the fingerprinted bytes; nothing of it was opened. */
    | 'SOURCE_CHANGED'
    | 'PDF_OPEN_FAILED'
    /** The engine failed on this document. */
    | 'EXTRACTION_FAILED'
    | 'PAGE_NOT_IN_DOCUMENT'
    /** A field could not be recorded (too long, or a character the contract refuses). */
    | 'FIELD_UNRECORDABLE'
    /** Interrupted, or never reached, because the operation was cancelled. */
    | 'CANCELLED'
    /** Interrupted, or never reached, because the operation failed. */
    | 'RUN_FAILED'
    /** The Sheet, its Source or its profile moved before the operation ended. */
    | 'CHANGED_DURING_RUN';

/** Why a targeted Sheet got no observation. Codes, field names and counts only -- never text. */
export interface SheetExclusion {
    sheetId: Uuid;
    code: ExclusionCode;
    problems?: FieldProblem[];
}

export type ExtractionProgress =
    | { phase: 'source'; sourceIndex: number; sourceTotal: number; targetSheets: number }
    | { phase: 'page'; pageNumber: number; pageTotal: number }
    | { phase: 'source-done'; sourceIndex: number; staged: number; excluded: number };

export interface ExtractionContext {
    /** The Drawing Set as it is now. */
    current(): DrawingSet;
    /** Replace the Drawing Set. Called at most once per operation, synchronously after current(). */
    apply(next: DrawingSet): void;
    /** The File this session holds for a Source, or null. */
    fileFor(sourceId: Uuid): Blob | null;
    gate: PdfDocumentGate;
    signal?: AbortSignal;
    /** The recogniser for this operation; one is made per operation and always closed. */
    createOcr?: () => GuardedRegisterOcr;
    chunkBytes?: number;
    onProgress?: (event: ExtractionProgress) => void;
}

/** Counts only. */
export interface ExtractionStats {
    sourcesRead: number;
    documentsOpened: number;
    pagesAnalysed: number;
    ocrCalls: number;
    maxRegionPixels: number;
}

export type ExtractionReport =
    | { kind: 'refused'; refusal: StartRefusal }
    | {
        kind: 'finished';
        /** False: the model was left exactly as it was (the session was replaced, or no run could be added). */
        applied: boolean;
        notApplied: 'SESSION_REPLACED' | 'RUN_LIMIT' | null;
        outcome: AnalysisRunOutcome;
        failure: 'RELEASE_UNCONFIRMED' | 'UNEXPECTED' | null;
        run: AnalysisRun | null;
        committedSheetIds: Uuid[];
        excluded: SheetExclusion[];
        /** What this operation learned about each Source's File. Runtime only. */
        bindings: Map<Uuid, SourceBinding>;
        stats: ExtractionStats;
        ocr: ReturnType<GuardedRegisterOcr['counts']>;
    };

interface Target {
    sheetId: Uuid;
    pageNumber: number;
    basis: ProfileBasis;
}

interface SourcePlan {
    sourceId: Uuid;
    sha256: Sha256Hex;
    byteLength: number;
    targets: Target[];
    engineProfiles: Map<string, TemplateProfile>;
}

const startRefusal = (code: StartRefusalCode, message: string, sheetIds?: Uuid[]): { ok: false; refusal: StartRefusal } =>
    ({ ok: false, refusal: sheetIds ? { code, message, sheetIds } : { code, message } });

/**
 * What the request asks to read, checked against the Drawing Set as it is.
 * Every named Sheet must be live and on a live profile; the request is refused
 * whole otherwise, so the run's scope is exactly what a person chose.
 */
export function planExtraction(
    set: DrawingSet, sheetIds: readonly Uuid[],
): { ok: true; sources: SourcePlan[]; targets: Target[] } | { ok: false; refusal: StartRefusal } {
    if (sheetIds.length === 0) return startRefusal('EMPTY_REQUEST', '読み取るページを選んでください。');
    if (new Set(sheetIds).size !== sheetIds.length) return startRefusal('DUPLICATE_TARGET', '同じページが2回指定されています。');
    const sheets = new Map(set.sheets.map((sheet) => [sheet.id, sheet]));
    const sources = new Map(set.sources.map((source) => [source.id, source]));
    const profiles = new Map(set.titleBlockProfiles.map((profile) => [profile.id, profile]));
    const bySource = new Map<Uuid, Target[]>();
    for (const id of sheetIds) {
        const sheet = sheets.get(id);
        if (!sheet) return startRefusal('SHEET_NOT_FOUND', 'ページが見つかりません。', [id]);
        const source = sources.get(sheet.sourceId);
        if (!isLive(sheet) || !source || !isLive(source)) return startRefusal('SHEET_RETIRED', '外したファイルのページは読み取れません。', [id]);
        if (!sheet.profileAssignment) return startRefusal('NOT_ASSIGNED', 'プロファイルが割り当てられていないページは読み取れません。', [id]);
        const profile = profiles.get(sheet.profileAssignment.profileId);
        if (!profile || !isLive(profile)) return startRefusal('PROFILE_RETIRED', '廃止したプロファイルでは読み取れません。', [id]);
        const targets = bySource.get(source.id) ?? [];
        targets.push({ sheetId: id, pageNumber: sheet.pageNumber, basis: { profileId: profile.id, profileRevision: profile.revision } });
        bySource.set(source.id, targets);
    }
    const plans: SourcePlan[] = [];
    for (const source of set.sources) {
        const targets = bySource.get(source.id);
        if (!targets) continue;
        targets.sort((a, b) => a.pageNumber - b.pageNumber);
        const engineProfiles = new Map<string, TemplateProfile>();
        for (const target of targets) {
            if (!engineProfiles.has(target.basis.profileId)) {
                engineProfiles.set(target.basis.profileId, toTemplateProfile(profiles.get(target.basis.profileId)!));
            }
        }
        plans.push({ sourceId: source.id, sha256: source.fingerprint.sha256, byteLength: source.fingerprint.byteLength, targets, engineProfiles });
    }
    return { ok: true, sources: plans, targets: plans.flatMap((plan) => plan.targets) };
}

type Settled<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'aborted' };

/** Wait for a promise, or stop waiting the moment the signal aborts. The promise is never left unhandled. */
function settleOrAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<Settled<T>> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (result: Settled<T>): void => {
            if (done) return;
            done = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = (): void => finish({ kind: 'aborted' });
        promise.then((value) => finish({ kind: 'value', value }), (error: unknown) => finish({ kind: 'error', error }));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

const isEngineCancel = (error: unknown): boolean => error instanceof Error && error.message === 'cancelled';

type SourceResult =
    | { kind: 'read'; staged: Map<Uuid, Observation>; excluded: SheetExclusion[] }
    | { kind: 'excluded'; code: ExclusionCode }
    | { kind: 'cancelled' }
    | { kind: 'run-failed' };

interface SourceEnv {
    runId: Uuid;
    lease: ExtractionLease;
    ocr: GuardedRegisterOcr;
    signal: AbortSignal;
    chunkBytes: number;
    fileFor: ExtractionContext['fileFor'];
    progress: (event: ExtractionProgress) => void;
    stats: ExtractionStats;
}

/** Read one Source's targeted pages. Returns what to keep, and what its File turned out to be. */
async function readSource(plan: SourcePlan, env: SourceEnv): Promise<{ result: SourceResult; binding: SourceBinding | null }> {
    const aborted = (): boolean => env.signal.aborted;
    const file = env.fileFor(plan.sourceId);
    if (!file) return { result: { kind: 'excluded', code: 'SOURCE_MISSING' }, binding: 'MISSING' };
    if (file.size !== plan.byteLength) return { result: { kind: 'excluded', code: 'SOURCE_CHANGED' }, binding: 'CHANGED' };
    let bytes: Uint8Array | null;
    try {
        bytes = new Uint8Array(plan.byteLength);
    } catch {
        return { result: { kind: 'excluded', code: 'SOURCE_UNREADABLE' }, binding: null };
    }
    let sha256: string;
    try {
        sha256 = await fingerprintIntoBuffer(file, bytes, { signal: env.signal, chunkBytes: env.chunkBytes });
    } catch (error) {
        if (aborted()) return { result: { kind: 'cancelled' }, binding: null };
        if (error instanceof IntakeStop && error.refusal?.code === 'FILE_CHANGED') {
            return { result: { kind: 'excluded', code: 'SOURCE_CHANGED' }, binding: 'CHANGED' };
        }
        return { result: { kind: 'excluded', code: 'SOURCE_UNREADABLE' }, binding: 'MISSING' };
    }
    if (sha256 !== plan.sha256) return { result: { kind: 'excluded', code: 'SOURCE_CHANGED' }, binding: 'CHANGED' };
    if (aborted()) return { result: { kind: 'cancelled' }, binding: 'MATCHED' };

    const opened = await env.lease.openDocument(bytes);
    bytes = null;
    if (!opened.ok) {
        if (opened.code === 'OPEN_FAILED') return { result: { kind: 'excluded', code: 'PDF_OPEN_FAILED' }, binding: 'MATCHED' };
        if (opened.code === 'LEASE_ENDED') throw new Error('extraction document opened after its lease ended');
        return { result: { kind: 'run-failed' }, binding: 'MATCHED' };
    }
    env.stats.documentsOpened += 1;
    const { doc, close } = opened.document;

    let result: SourceResult;
    try {
        const engine = extractRegister({
            doc,
            profiles: plan.engineProfiles,
            assignments: assignmentsFor(plan.targets.map((t) => ({ pageNumber: t.pageNumber, profileId: t.basis.profileId }))),
            ocr: env.ocr,
            shouldCancel: aborted,
            onProgress: (pageNumber, pageTotal) => env.progress({ phase: 'page', pageNumber, pageTotal }),
        });
        const settled = await settleOrAbort<RegisterExtractionResult>(engine, env.signal);
        if (settled.kind === 'aborted' || (settled.kind === 'error' && isEngineCancel(settled.error)) || aborted()) {
            // Nothing more is wanted from the recogniser; this also ends a
            // recognition that is still running.
            await env.ocr.close();
            result = { kind: 'cancelled' };
        } else if (settled.kind === 'error') {
            result = { kind: 'excluded', code: 'EXTRACTION_FAILED' };
        } else {
            const { rows, stats } = settled.value;
            env.stats.pagesAnalysed += stats.assignedPages;
            env.stats.ocrCalls += stats.ocrCalls;
            env.stats.maxRegionPixels = Math.max(env.stats.maxRegionPixels, stats.maxRegionPixels);
            const byPage = new Map(rows.map((row) => [row.pageNumber, row]));
            const staged = new Map<Uuid, Observation>();
            const excluded: SheetExclusion[] = [];
            for (const target of plan.targets) {
                const row = byPage.get(target.pageNumber);
                if (!row) {
                    excluded.push({ sheetId: target.sheetId, code: 'PAGE_NOT_IN_DOCUMENT' });
                    continue;
                }
                const conversion = observationFromRow(row, { runId: env.runId, sourceSha256: plan.sha256, profile: target.basis });
                if (conversion.ok) staged.set(target.sheetId, conversion.observation);
                else excluded.push({ sheetId: target.sheetId, code: 'FIELD_UNRECORDABLE', problems: conversion.problems });
            }
            result = { kind: 'read', staged, excluded };
        }
    } catch (error) {
        await close();
        throw error;
    }
    const released = await close();
    // A Source read to the end keeps its results even if its document could
    // not be destroyed; the operation then stops, and opens nothing more.
    if (!released && result.kind !== 'read') return { result: { kind: 'run-failed' }, binding: 'MATCHED' };
    return { result, binding: 'MATCHED' };
}

/**
 * Write a finished operation into the Drawing Set: the run, once, and the
 * observations kept from fully processed Sources, each checked again against
 * the set as it is now. Pure; the set passed in is not modified.
 */
export function commitExtractionRun(
    set: DrawingSet,
    input: {
        drawingSetId: Uuid;
        run: Omit<AnalysisRun, 'coverage'>;
        targets: readonly Target[];
        staged: ReadonlyMap<Uuid, Observation>;
    },
): { applied: true; drawingSet: DrawingSet; run: AnalysisRun; committedSheetIds: Uuid[]; changed: Uuid[] }
    | { applied: false; reason: 'SESSION_REPLACED' | 'RUN_LIMIT' } {
    if (set.id !== input.drawingSetId) return { applied: false, reason: 'SESSION_REPLACED' };
    if (!hasRoomForRun(set)) return { applied: false, reason: 'RUN_LIMIT' };
    const sources = new Map(set.sources.map((source) => [source.id, source]));
    const profiles = new Map(set.titleBlockProfiles.map((profile) => [profile.id, profile]));
    const writes = new Map<Uuid, Observation>();
    const changed: Uuid[] = [];
    const sheetsById = new Map(set.sheets.map((sheet) => [sheet.id, sheet]));
    for (const [sheetId, observation] of input.staged) {
        const sheet = sheetsById.get(sheetId);
        const source = sheet ? sources.get(sheet.sourceId) : undefined;
        const profile = profiles.get(observation.profile.profileId);
        const stillValid = sheet !== undefined && isLive(sheet)
            && source !== undefined && isLive(source) && source.fingerprint.sha256 === observation.sourceSha256
            && sheet.profileAssignment?.profileId === observation.profile.profileId
            && profile !== undefined && isLive(profile) && profile.revision === observation.profile.profileRevision;
        if (stillValid) writes.set(sheetId, observation);
        else changed.push(sheetId);
    }
    const run: AnalysisRun = {
        ...input.run,
        coverage: { sheetsEvaluated: writes.size, sheetsExcluded: input.targets.length - writes.size },
    };
    const committedSheetIds: Uuid[] = [];
    const sheets = set.sheets.map((sheet) => {
        const observation = writes.get(sheet.id);
        if (!observation) return sheet;
        committedSheetIds.push(sheet.id);
        return { ...sheet, observation };
    });
    return {
        applied: true,
        drawingSet: { ...set, sheets, analysisRuns: [...set.analysisRuns, run] },
        run,
        committedSheetIds,
        changed,
    };
}

/** Read the title blocks of the named Sheets, as one operation. */
export async function extractTitleBlocks(
    request: { sheetIds: readonly Uuid[] },
    context: ExtractionContext,
): Promise<ExtractionReport> {
    if (!hasRoomForRun(context.current())) {
        return { kind: 'refused', refusal: { code: 'RUN_LIMIT', message: `読み取りの記録が上限（${MAX_ANALYSIS_RUNS}件）に達しているため、読み取れません。` } };
    }
    const begun = await context.gate.beginExtraction();
    if (!begun.ok) return { kind: 'refused', refusal: { code: begun.code, message: GATE_MESSAGES[begun.code] } };
    const { lease } = begun;

    // The snapshot is taken under the gate: this is the moment the run starts.
    const startSet = context.current();
    const plan = planExtraction(startSet, request.sheetIds);
    if (!plan.ok) {
        lease.end();
        return { kind: 'refused', refusal: plan.refusal };
    }
    let runId: Uuid;
    let startedAt: Timestamp;
    try {
        runId = mintUuid();
        startedAt = nowTimestamp();
    } catch (error) {
        lease.end();
        if (error instanceof IntakeStop && error.refusal) {
            return { kind: 'refused', refusal: { code: 'UNAVAILABLE', message: error.refusal.message } };
        }
        throw error;
    }
    const digest = manifestDigest(startSet);

    const ocr = (context.createOcr ?? (() => new GuardedRegisterOcr()))();
    const staged = new Map<Uuid, Observation>();
    const excluded: SheetExclusion[] = [];
    const bindings = new Map<Uuid, SourceBinding>();
    const stats: ExtractionStats = { sourcesRead: 0, documentsOpened: 0, pagesAnalysed: 0, ocrCalls: 0, maxRegionPixels: 0 };
    const progress = (event: ExtractionProgress): void => { context.onProgress?.(event); };
    let cancelled = false;
    let failure: 'RELEASE_UNCONFIRMED' | 'UNEXPECTED' | null = null;
    const env: SourceEnv = {
        runId, lease, ocr, signal: context.signal ?? new AbortController().signal,
        chunkBytes: context.chunkBytes ?? READ_CHUNK_BYTES,
        fileFor: (sourceId) => context.fileFor(sourceId),
        progress, stats,
    };
    try {
        for (const [index, source] of plan.sources.entries()) {
            if (failure || cancelled) break;
            if (env.signal.aborted) {
                cancelled = true;
                break;
            }
            progress({ phase: 'source', sourceIndex: index, sourceTotal: plan.sources.length, targetSheets: source.targets.length });
            const { result, binding } = await readSource(source, env);
            if (binding) bindings.set(source.sourceId, binding);
            switch (result.kind) {
                case 'read':
                    stats.sourcesRead += 1;
                    for (const [sheetId, observation] of result.staged) staged.set(sheetId, observation);
                    excluded.push(...result.excluded);
                    progress({ phase: 'source-done', sourceIndex: index, staged: result.staged.size, excluded: result.excluded.length });
                    break;
                case 'excluded':
                    excluded.push(...source.targets.map((t) => ({ sheetId: t.sheetId, code: result.code })));
                    break;
                case 'cancelled':
                    cancelled = true;
                    break;
                case 'run-failed':
                    failure = 'RELEASE_UNCONFIRMED';
                    break;
            }
            if (context.gate.releaseUnconfirmed) failure ??= 'RELEASE_UNCONFIRMED';
        }
    } catch {
        failure = 'UNEXPECTED';
    } finally {
        await ocr.close();
        lease.end();
    }

    // Every targeted Sheet with neither an observation nor a reason was not
    // reached, or was interrupted: the operation's own ending is the reason.
    const accounted = new Set([...staged.keys(), ...excluded.map((e) => e.sheetId)]);
    for (const target of plan.targets) {
        if (!accounted.has(target.sheetId)) excluded.push({ sheetId: target.sheetId, code: failure ? 'RUN_FAILED' : 'CANCELLED' });
    }

    let completedAt: Timestamp | null = null;
    try {
        completedAt = nowTimestamp();
    } catch {
        failure ??= 'UNEXPECTED';
    }
    const outcome: AnalysisRunOutcome = failure ? 'FAILED' : cancelled ? 'CANCELLED' : 'COMPLETED';
    const commit = commitExtractionRun(context.current(), {
        drawingSetId: startSet.id,
        run: {
            id: runId,
            kind: 'EXTRACTION',
            startedAt,
            completedAt,
            outcome,
            engine: { ...REGISTER_EXTRACTION_ENGINE },
            manifestDigest: digest,
        },
        targets: plan.targets,
        staged,
    });
    if (commit.applied) {
        context.apply(commit.drawingSet);
        excluded.push(...commit.changed.map((sheetId) => ({ sheetId, code: 'CHANGED_DURING_RUN' as const })));
    }
    return {
        kind: 'finished',
        applied: commit.applied,
        notApplied: commit.applied ? null : commit.reason,
        outcome,
        failure,
        run: commit.applied ? commit.run : null,
        committedSheetIds: commit.applied ? commit.committedSheetIds : [],
        excluded,
        bindings,
        stats,
        ocr: ocr.counts(),
    };
}
