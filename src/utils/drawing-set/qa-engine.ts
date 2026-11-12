/**
 * QA over a Drawing Set (M7-P3, first scope): QA01 duplicate drawing numbers,
 * QA02 metadata no person stands behind, and QA09 the declared drawing register
 * against the Sheets -- as the canonical contract states them (semantic
 * contract, CAN-03 R4-A to R4-I and R4.1-L). Nothing here infers what a drawing
 * should say; a Finding is a fact about the set as it is.
 *
 * Every function is pure: it reads the Drawing Set it is given and what this
 * session knows about each Source's File (a `BindingOf`), and returns what it
 * would write as a new Drawing Set. Nothing derived is stored: a statement's
 * key and evidence input strings, a Finding's currency, the register's state,
 * readiness and a refusal are worked out again from the stored fields each time
 * they are asked for (R4-I). A caller may hand the same `QaEvaluation` to
 * several questions about one unchanged Drawing Set; it must not hand it on
 * once the set has changed.
 *
 * A QA run is planned in full, checked against every bound it would write past,
 * and only then built and handed back in one piece (R4.1-L). Past any bound it
 * is refused and nothing is written -- no run, no Finding, no lifecycle change,
 * and the clock and the id source are not even asked. Nothing is cut short,
 * left out or deleted to make room. A Review Decision is refused the same way.
 *
 * The reference model the contract was adopted with (the CAN-03 R4.1 pack's
 * generator) is a test oracle, not this code: scripts/smoke-m7-p3-qa.mjs runs
 * its vectors and counterexamples against these functions.
 */
import { manifestDigest } from './analysis-run';
import type { SourceBinding } from './currency';
import { staleReasonsOf } from './currency';
import { P3_QA_LIMITS, checkComment } from './field-bounds';
import { sha256Hex } from './incremental-sha256';
import type {
    AnalysisRun, DrawingRegisterReference, DrawingSet, Finding, FindingParams, FindingScope, QaRuleId, ReviewDecision,
    ReviewOutcome, Sha256Hex, Sheet, Source, Timestamp, Uuid,
} from './model';
import { FIELD_NAMES, QA_RULE_IDS, REVIEW_OUTCOMES, isLive } from './model';

/** The QA engine as a run names it. It moves when a run would state something else for the same Drawing Set. */
export const QA_ENGINE = { name: 'drawing-set-qa', version: '1.0.0' } as const;
/** CAN-03 R4-B: the three rules' version, in every key and every evidence digest. */
export const QA_RULE_VERSION = 1;

export const QA01 = 'QA01_DUPLICATE_NUMBER' as const;
export const QA02 = 'QA02_METADATA_UNCONFIRMED' as const;
export const QA09 = 'QA09_REGISTER_SHEET_MISMATCH' as const;
/** What M7-P3's first scope implements. Every other rule is reported as not implemented. */
export const IMPLEMENTED_QA_RULES: readonly QaRuleId[] = [QA01, QA02, QA09];

/** What this session knows about a Source's File now. Only MATCHED vouches for anything. */
export type Binding = SourceBinding | 'UNBOUND';
export type BindingOf = (sourceId: Uuid) => Binding;

/** Where a write gets its time and its ids. The store passes the real clock and crypto.randomUUID. */
export interface QaSeams {
    now: () => Timestamp;
    newId: (kind: 'run' | 'finding' | 'decision') => Uuid;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byFirst = (a: readonly unknown[], b: readonly unknown[]): number => cmp(a[0] as string, b[0] as string);
const encoder = new TextEncoder();
const hashText = (text: string): Sha256Hex => sha256Hex(encoder.encode(text));

/** CAN-03 R4-B: String.prototype.trim() only. Internal spaces stay; width, case and dashes are never folded. */
export const comparisonKey = (value: string): string => value.trim();

// ------------------------------------------------------------------ QA input (R4-A)

export type QaInputOrigin = 'CONFIRMED' | 'OBSERVED' | 'NONE';
export type Qa02Reason = 'RECONFIRM_REQUIRED' | 'NOT_READ' | 'READ_IS_STALE' | 'OCR_FAILED' | 'UNCONFIRMED';
export type FourValues = [string, string, string, string];

export interface QaInput {
    origin: QaInputOrigin;
    /** The four values in the canonical field order, or null for NONE. */
    values: FourValues | null;
    /** The drawing number as stored (not trimmed), or null for NONE. */
    number: string | null;
    /** Why QA02 states this Sheet, or null when a valid confirmation stands. */
    qa02: Qa02Reason | null;
}

/**
 * Whether a record still stands on the validity axis: its Source is live and
 * has the recorded bytes, and a profile basis is the Sheet's assigned, live
 * profile at the recorded revision (currency.ts, staleReasonsOf). Whether this
 * session can vouch for the File is a separate axis and is not read here.
 */
function recordValid(set: DrawingSet, sheet: Sheet, source: Source | undefined, record: Parameters<typeof staleReasonsOf>[2] | null): boolean {
    return record !== null && source !== undefined && isLive(source) && staleReasonsOf(set, sheet, record).length === 0;
}

/** The one QA input of a Sheet: a valid confirmation, else a valid READ observation, else nothing (R4-A). */
export function qaInputOf(set: DrawingSet, sheet: Sheet, source: Source | undefined = set.sources.find((s) => s.id === sheet.sourceId)): QaInput {
    const confirmationValid = recordValid(set, sheet, source, sheet.confirmation);
    const observationValid = recordValid(set, sheet, source, sheet.observation);
    let origin: QaInputOrigin = 'NONE';
    let values: FourValues | null = null;
    if (confirmationValid) {
        origin = 'CONFIRMED';
        values = FIELD_NAMES.map((name) => sheet.confirmation!.values[name]) as FourValues;
    } else if (observationValid && sheet.observation!.status === 'READ') {
        origin = 'OBSERVED';
        values = FIELD_NAMES.map((name) => sheet.observation!.fields[name].value) as FourValues;
    }
    let qa02: Qa02Reason | null = null;
    if (!confirmationValid) {
        if (sheet.confirmation) qa02 = 'RECONFIRM_REQUIRED';
        else if (!sheet.observation) qa02 = 'NOT_READ';
        else if (!observationValid) qa02 = 'READ_IS_STALE';
        else if (sheet.observation.status === 'OCR_FAILED') qa02 = 'OCR_FAILED';
        else qa02 = 'UNCONFIRMED';
    }
    return { origin, values, number: values ? values[0] : null, qa02 };
}

// ------------------------------------------------------------- the declared register (R4-C)

export type RegisterStateName = 'NONE' | 'NOT_CURRENT' | 'EVALUABLE';

export interface RegisterEntryRef {
    id: Uuid;
    referenceId: Uuid;
    drawingNumber: string;
}

export interface RegisterView {
    /**
     * NONE: no live reference (none declared, or every one withdrawn).
     * NOT_CURRENT: a live reference's Source is retired or no longer has its bytes; nothing of QA09 is evaluated.
     * EVALUABLE: every live reference is current; the live rows of all of them are one register.
     */
    state: RegisterStateName;
    /** The live references, by id. */
    references: DrawingRegisterReference[];
    /** The live references that are not current, by id. */
    notCurrent: Uuid[];
    /** Every live row of every live reference, by id. */
    entries: RegisterEntryRef[];
}

export function registerStateOf(set: DrawingSet): RegisterView {
    const references = set.drawingRegisterReferences.filter(isLive).sort((a, b) => cmp(a.id, b.id));
    if (references.length === 0) return { state: 'NONE', references: [], notCurrent: [], entries: [] };
    const notCurrent = references.filter((reference) => {
        const source = set.sources.find((s) => s.id === reference.sourceId);
        return !source || !isLive(source) || source.fingerprint.sha256 !== reference.sourceSha256;
    }).map((reference) => reference.id);
    const entries = references
        .flatMap((reference) => reference.entries.filter(isLive).map((entry) => ({ id: entry.id, referenceId: reference.id, drawingNumber: entry.drawingNumber })))
        .sort((a, b) => cmp(a.id, b.id));
    return { state: notCurrent.length > 0 ? 'NOT_CURRENT' : 'EVALUABLE', references, notCurrent, entries };
}

// ------------------------------------------------------------- one run's statements (R4-B, R4-D)

export interface QaStatement {
    ruleId: QaRuleId;
    scope: FindingScope;
    sheetIds: Uuid[];
    /** Always empty for these three rules. */
    sourceIds: Uuid[];
    registerEntryIds: Uuid[];
    basis: { sourceId: Uuid; sha256: Sha256Hex }[];
    params: FindingParams;
    findingKey: Sha256Hex;
    evidenceDigest: Sha256Hex;
    /** The exact strings hashed. Runtime diagnostics only: never stored, never read to decide anything. */
    keyInput: string;
    evidenceInput: string;
}

/** What a run would state of one unchanged Drawing Set, and what it took to say it. Binding plays no part. */
export interface QaEvaluation {
    readonly set: DrawingSet;
    /** In the canonical order: QA02 by Sheet id, QA01 by key, ACTUAL_NOT_LISTED by Sheet id, LISTED_BUT_MISSING by key. */
    readonly statements: readonly QaStatement[];
    readonly byKey: ReadonlyMap<Sha256Hex, QaStatement>;
    /** The live Sheets, by id. */
    readonly liveSheets: readonly Sheet[];
    readonly inputs: ReadonlyMap<Uuid, QaInput>;
    readonly register: RegisterView;
    /** A row is live when it and its reference are both live (R4-C). */
    readonly liveEntryIds: ReadonlySet<Uuid>;
    /** The comparison key of every live Sheet that has a QA input. */
    readonly carriedKeys: ReadonlySet<string>;
    /** The comparison key of every live row, when the register is EVALUABLE; empty otherwise (QA09 reads none then). */
    readonly listedKeys: ReadonlySet<string>;
    readonly coverage: { sheetsEvaluated: number; sheetsExcluded: number };
    readonly manifestDigest: Sha256Hex;
    /** Every Sheet and Source, retired ones included, by id. */
    readonly sheetsById: ReadonlyMap<Uuid, Sheet>;
    readonly sourcesById: ReadonlyMap<Uuid, Source>;
}

interface StatementParts {
    ruleId: QaRuleId;
    reason: string | null;
    scope: FindingScope;
    sheetIds: Uuid[];
    registerEntryIds: Uuid[];
    params: FindingParams;
    keyParts: string[];
    basis: [Uuid, Sha256Hex][];
    sheets: unknown[][];
    entries: unknown[][];
    extra: [Uuid, Sha256Hex][] | null;
}

/**
 * CAN-03 R4-B: the question a Finding asks. `["m7.findingKey",1,ruleId,keyReason,...keyParts]` as JSON, UTF-8,
 * SHA-256, lower-case hex. Only QA09 puts its reason in the key.
 */
export function findingKeyOf(ruleId: QaRuleId, keyReason: string | null, keyParts: readonly string[]): { input: string; hex: Sha256Hex } {
    const input = JSON.stringify(['m7.findingKey', 1, ruleId, keyReason, ...keyParts]);
    return { input, hex: hashText(input) };
}

/**
 * CAN-03 R4-B: the grounds a Finding states.
 * `["m7.evidenceDigest",1,ruleId,ruleVersion,reasonOrNull,basis,sheets,entries,extra]` as JSON, UTF-8, SHA-256,
 * with basis, sheets and entries sorted by their first element (the id).
 */
export function evidenceDigestOf(parts: {
    ruleId: QaRuleId;
    reason: string | null;
    basis: readonly (readonly [Uuid, Sha256Hex])[];
    sheets: readonly (readonly unknown[])[];
    entries: readonly (readonly unknown[])[];
    extra: readonly (readonly [Uuid, Sha256Hex])[] | null;
}): { input: string; hex: Sha256Hex } {
    const input = JSON.stringify(['m7.evidenceDigest', 1, parts.ruleId, QA_RULE_VERSION, parts.reason,
        [...parts.basis].sort(byFirst), [...parts.sheets].sort(byFirst), [...parts.entries].sort(byFirst), parts.extra]);
    return { input, hex: hashText(input) };
}

function statement(parts: StatementParts): QaStatement {
    // QA09's reason names the question; QA02's reason is part of its evidence only, so a changed reason restates
    // the same question on new evidence (R4-B).
    const key = findingKeyOf(parts.ruleId, parts.ruleId === QA09 ? parts.reason : null, parts.keyParts);
    const evidence = evidenceDigestOf(parts);
    return {
        ruleId: parts.ruleId,
        scope: parts.scope,
        sheetIds: parts.sheetIds,
        sourceIds: [],
        registerEntryIds: parts.registerEntryIds,
        basis: [...parts.basis].sort(byFirst).map(([sourceId, sha256]) => ({ sourceId, sha256 })),
        params: parts.params,
        findingKey: key.hex,
        evidenceDigest: evidence.hex,
        keyInput: key.input,
        evidenceInput: evidence.input,
    };
}

/** What a QA run would state now. Asked of one Drawing Set, the answer is the same every time. */
export function evaluateQa(set: DrawingSet): QaEvaluation {
    const sourcesById = new Map(set.sources.map((source) => [source.id, source]));
    const sheetsById = new Map(set.sheets.map((sheet) => [sheet.id, sheet]));
    const live = set.sheets.filter(isLive).sort((a, b) => cmp(a.id, b.id));
    const inputs = new Map(live.map((sheet) => [sheet.id, qaInputOf(set, sheet, sourcesById.get(sheet.sourceId))]));
    const shaOf = (id: Uuid): Sha256Hex => sourcesById.get(id)!.fingerprint.sha256;
    const basisOf = (sourceIds: Uuid[]): [Uuid, Sha256Hex][] => [...new Set(sourceIds)].sort(cmp).map((id) => [id, shaOf(id)]);
    const out: QaStatement[] = [];

    // QA02: every live Sheet no valid confirmation stands for.
    for (const sheet of live) {
        const input = inputs.get(sheet.id)!;
        if (!input.qa02) continue;
        out.push(statement({
            ruleId: QA02, reason: input.qa02, scope: 'SHEET', sheetIds: [sheet.id], registerEntryIds: [], params: { reason: input.qa02 },
            keyParts: [sheet.id], basis: basisOf([sheet.sourceId]), sheets: [[sheet.id, input.origin, input.values]], entries: [], extra: null,
        }));
    }

    // QA01: Sheets with an input and a non-empty key, grouped by equal key.
    const groups = new Map<string, Uuid[]>();
    for (const sheet of live) {
        const input = inputs.get(sheet.id)!;
        if (input.origin === 'NONE') continue;
        const key = comparisonKey(input.number!);
        if (key === '') continue;
        const group = groups.get(key);
        if (group) group.push(sheet.id);
        else groups.set(key, [sheet.id]);
    }
    for (const key of [...groups.keys()].sort(cmp)) {
        const ids = groups.get(key)!;
        if (ids.length < 2) continue;
        out.push(statement({
            ruleId: QA01, reason: null, scope: 'SHEET_GROUP', sheetIds: ids, registerEntryIds: [], params: { comparisonKey: key },
            keyParts: [key], basis: basisOf(ids.map((id) => sheetsById.get(id)!.sourceId)),
            sheets: ids.map((id) => [id, inputs.get(id)!.origin, inputs.get(id)!.number]), entries: [], extra: null,
        }));
    }

    // QA09: only when every live reference is current, against all their live rows together.
    const register = registerStateOf(set);
    const evaluated = live.filter((sheet) => inputs.get(sheet.id)!.origin !== 'NONE');
    // An empty key is in these sets too; every statement below skips an empty key before it looks.
    const carried = new Set(evaluated.map((sheet) => comparisonKey(inputs.get(sheet.id)!.number!)));
    const listed = new Set(register.state === 'EVALUABLE' ? register.entries.map((entry) => comparisonKey(entry.drawingNumber)) : []);
    if (register.state === 'EVALUABLE') {
        const allReferences: [Uuid, Sha256Hex][] = register.references.map((reference) => [reference.id, reference.sourceSha256]);
        for (const sheet of evaluated) {
            const input = inputs.get(sheet.id)!;
            const key = comparisonKey(input.number!);
            if (key === '' || listed.has(key)) continue;
            out.push(statement({
                ruleId: QA09, reason: 'ACTUAL_NOT_LISTED', scope: 'SHEET', sheetIds: [sheet.id], registerEntryIds: [],
                params: { reason: 'ACTUAL_NOT_LISTED', comparisonKey: key }, keyParts: [sheet.id],
                basis: basisOf([sheet.sourceId, ...register.references.map((reference) => reference.sourceId)]),
                sheets: [[sheet.id, input.origin, input.number]], entries: [], extra: allReferences,
            }));
        }
        // One statement per listed number no evaluated Sheet carries, citing every live row with it (MD-1).
        const byKey = new Map<string, RegisterEntryRef[]>();
        for (const entry of register.entries) {
            const key = comparisonKey(entry.drawingNumber);
            if (key === '' || carried.has(key)) continue;
            const cited = byKey.get(key);
            if (cited) cited.push(entry);
            else byKey.set(key, [entry]);
        }
        const referencesById = new Map(register.references.map((reference) => [reference.id, reference]));
        for (const key of [...byKey.keys()].sort(cmp)) {
            const cited = byKey.get(key)!; // already in entry id order
            const references = [...new Set(cited.map((entry) => entry.referenceId))].sort(cmp).map((id) => referencesById.get(id)!);
            out.push(statement({
                ruleId: QA09, reason: 'LISTED_BUT_MISSING', scope: 'REGISTER_ENTRY', sheetIds: [], registerEntryIds: cited.map((entry) => entry.id),
                params: { reason: 'LISTED_BUT_MISSING', comparisonKey: key }, keyParts: [key],
                basis: basisOf(references.map((reference) => reference.sourceId)), sheets: [],
                entries: cited.map((entry) => [entry.id, entry.referenceId, entry.drawingNumber]),
                extra: references.map((reference) => [reference.id, reference.sourceSha256]),
            }));
        }
    }

    const byKey = new Map(out.map((st) => [st.findingKey, st]));
    // By construction no question is asked twice in one run (R4-D); a second one would be a defect here.
    if (byKey.size !== out.length) throw new Error('a QA run stated the same findingKey twice');
    const sheetsEvaluated = evaluated.length;
    return {
        set,
        statements: out,
        byKey,
        liveSheets: live,
        inputs,
        register,
        liveEntryIds: new Set(register.entries.map((entry) => entry.id)),
        carriedKeys: carried,
        listedKeys: listed,
        coverage: { sheetsEvaluated, sheetsExcluded: live.length - sheetsEvaluated },
        manifestDigest: manifestDigest(set),
        sheetsById,
        sourcesById,
    };
}

// ------------------------------------------------------------- planning and the bounds (R4-G, R4.1-L)

export interface QaPlan {
    evaluation: QaEvaluation;
    coverage: { sheetsEvaluated: number; sheetsExcluded: number };
    /** The statements that become new Findings; `prior` is the ACTIVE Finding of the same question it supersedes. */
    writes: { statement: QaStatement; prior: Finding | null }[];
    /** The ACTIVE Findings the run would close NOT_REPRODUCED. */
    closes: Finding[];
}

/** Could a run now evaluate the question a stored ACTIVE Finding asks? Stored fields and the current set only. */
function couldEvaluate(finding: Finding, evaluation: QaEvaluation): boolean {
    const sheetLive = (id: Uuid): boolean => {
        const sheet = evaluation.sheetsById.get(id);
        return sheet !== undefined && isLive(sheet);
    };
    const read = (id: Uuid): boolean => sheetLive(id) && evaluation.inputs.get(id)!.origin !== 'NONE';
    switch (finding.ruleId) {
        case QA02:
            return true; // every live Sheet is evaluated; a retired subject is evaluated as gone
        case QA01:
            return finding.sheetIds.every((id) => !sheetLive(id) || read(id));
        case QA09: {
            if (evaluation.register.state === 'NONE') return true; // MD-2 A: every reference withdrawn
            if (evaluation.register.state !== 'EVALUABLE') return false;
            if (finding.params.reason === 'ACTUAL_NOT_LISTED') return finding.sheetIds.every((id) => !sheetLive(id) || read(id));
            // Looked up in the evaluation's sets, built once per run: closing many Findings after part of a large
            // register is withdrawn stays one pass, not a pass over every Sheet and row per Finding.
            const key = finding.params.comparisonKey;
            const found = key !== undefined && evaluation.carriedKeys.has(key); // a live Sheet with an input carries it
            const allRead = evaluation.coverage.sheetsExcluded === 0; // every live Sheet has a QA input
            const stillListed = key !== undefined && evaluation.listedKeys.has(key); // a live row still lists it
            return found || allRead || !stillListed;
        }
        default:
            return false;
    }
}

/** Everything a run would write now, with nothing written (R4.1-L, phase 1). */
export function planQa(set: DrawingSet, evaluation: QaEvaluation = evaluateQa(set)): QaPlan {
    const active = new Map<Sha256Hex, Finding>();
    for (const finding of set.findings) {
        if (finding.lifecycle.state === 'ACTIVE' && !active.has(finding.findingKey)) active.set(finding.findingKey, finding);
    }
    const writes: QaPlan['writes'] = [];
    for (const st of evaluation.statements) {
        const prior = active.get(st.findingKey) ?? null;
        if (prior && prior.evidenceDigest === st.evidenceDigest) continue; // the same Finding: nothing written
        writes.push({ statement: st, prior });
    }
    const closes = set.findings.filter((finding) =>
        finding.lifecycle.state === 'ACTIVE' && !evaluation.byKey.has(finding.findingKey) && couldEvaluate(finding, evaluation));
    return { evaluation, coverage: evaluation.coverage, writes, closes };
}

export type QaLimitName = 'maxAnalysisRuns' | 'maxFindings' | 'maxSheets' | 'maxSubjectsPerFinding' | 'maxSources' | 'maxDecisions';

/** One bound a write would go past. Runtime only; never stored. */
export interface LimitExcess {
    limit: QaLimitName;
    max: number;
    planned: number;
    at: string;
    ruleId?: QaRuleId;
    reason?: string | null;
    comparisonKey?: string | null;
    findingKey?: Sha256Hex;
}

const LIMIT_VALUE: Record<QaLimitName, number> = {
    maxAnalysisRuns: P3_QA_LIMITS.maxAnalysisRuns.value,
    maxFindings: P3_QA_LIMITS.maxFindings.value,
    maxSheets: P3_QA_LIMITS.maxSheets.value,
    maxSubjectsPerFinding: P3_QA_LIMITS.maxSubjectsPerFinding.value,
    maxSources: P3_QA_LIMITS.maxSources.value,
    maxDecisions: P3_QA_LIMITS.maxDecisions.value,
};

/**
 * Every bound a plan would write past, in the contract's fixed order: runs, Findings, coverage evaluated and
 * excluded, then each statement in the canonical order (sheetIds, registerEntryIds, sourceIds, basis). Every
 * statement is measured, including one that would leave its Finding as it is. Empty when the plan fits.
 */
export function planExcess(set: DrawingSet, plan: QaPlan): LimitExcess[] {
    const over: LimitExcess[] = [];
    const check = (limit: QaLimitName, planned: number, at: Omit<LimitExcess, 'limit' | 'max' | 'planned'>): void => {
        if (planned > LIMIT_VALUE[limit]) over.push({ limit, max: LIMIT_VALUE[limit], planned, ...at });
    };
    check('maxAnalysisRuns', set.analysisRuns.length + 1, { at: 'drawingSet.analysisRuns' });
    check('maxFindings', set.findings.length + plan.writes.length, { at: 'drawingSet.findings' });
    check('maxSheets', plan.coverage.sheetsEvaluated, { at: 'analysisRun.coverage.sheetsEvaluated' });
    check('maxSheets', plan.coverage.sheetsExcluded, { at: 'analysisRun.coverage.sheetsExcluded' });
    for (const st of plan.evaluation.statements) {
        const about = { ruleId: st.ruleId, reason: st.params.reason ?? null, comparisonKey: st.params.comparisonKey ?? null, findingKey: st.findingKey };
        check('maxSubjectsPerFinding', st.sheetIds.length, { at: 'finding.sheetIds', ...about });
        check('maxSubjectsPerFinding', st.registerEntryIds.length, { at: 'finding.registerEntryIds', ...about });
        check('maxSources', st.sourceIds.length, { at: 'finding.sourceIds', ...about });
        check('maxSources', st.basis.length, { at: 'finding.basis', ...about });
    }
    return over;
}

/** Would a QA run be refused now, and why? Derived from the current set, so the screen can say so before anyone asks. */
export const qaRefusalOf = (set: DrawingSet, evaluation: QaEvaluation = evaluateQa(set)): LimitExcess[] =>
    planExcess(set, planQa(set, evaluation));

export type QaRunResult =
    | { ok: true; drawingSet: DrawingSet; run: AnalysisRun; created: Uuid[]; closed: Uuid[]; superseded: Uuid[] }
    | { ok: false; refusal: 'QA_LIMIT_EXCEEDED'; exceeded: LimitExcess[] };

/**
 * One QA run, atomic (R4-G, R4.1-L): planned, checked against every bound, then built as the complete next
 * Drawing Set -- the run, its new Findings, the ones they supersede and the ones it closes. A refusal is not a
 * completed run: it carries no run, and nothing about the set changed.
 */
export function runQa(set: DrawingSet, seams: QaSeams, evaluation: QaEvaluation = evaluateQa(set)): QaRunResult {
    const plan = planQa(set, evaluation);
    const exceeded = planExcess(set, plan);
    if (exceeded.length > 0) return { ok: false, refusal: 'QA_LIMIT_EXCEEDED', exceeded };
    // The run is one synchronous step: it starts and completes at one instant.
    const at = seams.now();
    const run: AnalysisRun = {
        id: seams.newId('run'),
        kind: 'QA',
        startedAt: at,
        completedAt: at,
        outcome: 'COMPLETED',
        engine: { name: QA_ENGINE.name, version: QA_ENGINE.version },
        manifestDigest: evaluation.manifestDigest,
        coverage: { sheetsEvaluated: plan.coverage.sheetsEvaluated, sheetsExcluded: plan.coverage.sheetsExcluded },
    };
    const made = plan.writes.map(({ statement: st, prior }): { prior: Finding | null; finding: Finding } => ({
        prior,
        finding: {
            id: seams.newId('finding'),
            runId: run.id,
            ruleId: st.ruleId,
            ruleVersion: QA_RULE_VERSION,
            determinism: 'DETERMINISTIC',
            scope: st.scope,
            sheetIds: st.sheetIds,
            sourceIds: st.sourceIds,
            registerEntryIds: st.registerEntryIds,
            findingKey: st.findingKey,
            evidenceDigest: st.evidenceDigest,
            basis: st.basis,
            params: st.params,
            createdAt: at,
            lifecycle: { state: 'ACTIVE', supersededByFindingId: null, closedByRunId: null, closedAt: null },
        },
    }));
    const supersededBy = new Map<Uuid, Uuid>();
    for (const { prior, finding } of made) if (prior) supersededBy.set(prior.id, finding.id);
    const closing = new Set(plan.closes.map((finding) => finding.id));
    const findings = set.findings.map((finding): Finding => {
        const by = supersededBy.get(finding.id);
        if (by) return { ...finding, lifecycle: { state: 'SUPERSEDED', supersededByFindingId: by, closedByRunId: run.id, closedAt: at } };
        if (closing.has(finding.id)) return { ...finding, lifecycle: { state: 'NOT_REPRODUCED', supersededByFindingId: null, closedByRunId: run.id, closedAt: at } };
        return finding;
    });
    return {
        ok: true,
        drawingSet: {
            ...set,
            analysisRuns: [...set.analysisRuns, run],
            findings: [...findings, ...made.map(({ finding }) => finding)],
        },
        run,
        created: made.map(({ finding }) => finding.id),
        closed: plan.closes.map((finding) => finding.id),
        superseded: [...supersededBy.keys()],
    };
}

// ------------------------------------------------------------- currency (R4-E)

export type FindingCurrency = 'CURRENT' | 'UNVERIFIED' | 'STALE' | 'HISTORICAL';

/** Every live Sheet has a QA input and its Source is MATCHED this session (the LBM whole-set condition). */
export const setFullyEvaluable = (evaluation: QaEvaluation, bindingOf: BindingOf): boolean =>
    evaluation.liveSheets.every((sheet) => evaluation.inputs.get(sheet.id)!.origin !== 'NONE' && bindingOf(sheet.sourceId) === 'MATCHED');

/**
 * Whether an ACTIVE Finding is what a run would state now, and whether this session can vouch for what it
 * cites. Reads the stored Finding (lifecycle, rule, subjects, basis, key, evidence, params) and the current set
 * only -- never a key or evidence input string (R4-E, R4-I).
 */
export function findingCurrencyOf(
    finding: Finding, evaluation: QaEvaluation, bindingOf: BindingOf, fullyEvaluable?: () => boolean,
): FindingCurrency {
    if (finding.lifecycle.state !== 'ACTIVE') return 'HISTORICAL';
    const subjectRetired = finding.sheetIds.some((id) => {
        const sheet = evaluation.sheetsById.get(id);
        return sheet === undefined || !isLive(sheet);
    }) || finding.registerEntryIds.some((id) => !evaluation.liveEntryIds.has(id));
    const basisMoved = finding.basis.some(({ sourceId, sha256 }) => {
        const source = evaluation.sourcesById.get(sourceId);
        return source === undefined || !isLive(source) || source.fingerprint.sha256 !== sha256;
    });
    const registerGone = finding.ruleId === QA09 && evaluation.register.state !== 'EVALUABLE';
    const restated = evaluation.byKey.get(finding.findingKey);
    if (subjectRetired || basisMoved || registerGone || !restated || restated.evidenceDigest !== finding.evidenceDigest) return 'STALE';
    const unbound = finding.basis.some(({ sourceId }) => bindingOf(sourceId) !== 'MATCHED');
    const setWide = finding.ruleId === QA09 && finding.params.reason === 'LISTED_BUT_MISSING';
    if (unbound || (setWide && !(fullyEvaluable ? fullyEvaluable() : setFullyEvaluable(evaluation, bindingOf)))) return 'UNVERIFIED';
    return 'CURRENT';
}

// ------------------------------------------------------------- Review Decisions (R4-F)

/** A Finding's Decisions, in sequence order. */
export const decisionsOf = (set: DrawingSet, findingId: Uuid): ReviewDecision[] =>
    set.decisions.filter((decision) => decision.findingId === findingId).sort((a, b) => a.sequence - b.sequence);

/** Every Finding's Decisions, in sequence order: one pass over the collection. */
export function decisionsByFinding(set: DrawingSet): Map<Uuid, ReviewDecision[]> {
    const by = new Map<Uuid, ReviewDecision[]>();
    for (const decision of set.decisions) {
        const list = by.get(decision.findingId);
        if (list) list.push(decision);
        else by.set(decision.findingId, [decision]);
    }
    for (const list of by.values()) list.sort((a, b) => a.sequence - b.sequence);
    return by;
}

/** The Decision with the highest sequence: the one in effect. */
export const effectiveOf = (decisions: readonly ReviewDecision[] | undefined): ReviewOutcome | null =>
    decisions && decisions.length > 0 ? decisions[decisions.length - 1].outcome : null;

export type DecisionRefusalCode =
    | 'NO_SUCH_FINDING' | 'FINDING_NOT_ACTIVE' | 'FINDING_NOT_CURRENT' | 'OUTCOME_INVALID' | 'COMMENT_INVALID' | 'DECISION_LIMIT_EXCEEDED';

export type DecisionResult =
    | { ok: true; drawingSet: DrawingSet; decision: ReviewDecision }
    | { ok: false; refusal: DecisionRefusalCode; currency?: FindingCurrency; exceeded?: LimitExcess[] };

/**
 * Append a Review Decision (R4-F, R4.1-L): only to an ACTIVE Finding whose currency is CURRENT (MD-4), with the
 * Finding's evidenceDigest copied in, the next sequence of that Finding, and no author. Past maxDecisions --
 * counted over the whole collection -- it is refused and nothing is written, not even an id or a time.
 */
export function addDecision(
    set: DrawingSet,
    request: { findingId: Uuid; outcome: ReviewOutcome; comment: string },
    bindingOf: BindingOf,
    seams: QaSeams,
    evaluation: QaEvaluation = evaluateQa(set),
): DecisionResult {
    const finding = set.findings.find((f) => f.id === request.findingId);
    if (!finding) return { ok: false, refusal: 'NO_SUCH_FINDING' };
    if (finding.lifecycle.state !== 'ACTIVE') return { ok: false, refusal: 'FINDING_NOT_ACTIVE' };
    const currency = findingCurrencyOf(finding, evaluation, bindingOf);
    if (currency !== 'CURRENT') return { ok: false, refusal: 'FINDING_NOT_CURRENT', currency };
    if (!(REVIEW_OUTCOMES as readonly string[]).includes(request.outcome)) return { ok: false, refusal: 'OUTCOME_INVALID' };
    if (typeof request.comment !== 'string' || checkComment(request.comment)) return { ok: false, refusal: 'COMMENT_INVALID' };
    if (set.decisions.length + 1 > LIMIT_VALUE.maxDecisions) {
        return {
            ok: false,
            refusal: 'DECISION_LIMIT_EXCEEDED',
            exceeded: [{ limit: 'maxDecisions', max: LIMIT_VALUE.maxDecisions, planned: set.decisions.length + 1, at: 'drawingSet.decisions' }],
        };
    }
    const id = seams.newId('decision');
    const now = seams.now();
    const decision: ReviewDecision = {
        id,
        findingId: finding.id,
        sequence: set.decisions.filter((d) => d.findingId === finding.id).length + 1,
        outcome: request.outcome,
        comment: request.comment,
        // At or after the Finding it is about, even on a clock set back since.
        decidedAt: now < finding.createdAt ? finding.createdAt : now,
        evidenceDigest: finding.evidenceDigest,
    };
    return { ok: true, drawingSet: { ...set, decisions: [...set.decisions, decision] }, decision };
}

// ------------------------------------------------------------- Final readiness (§J, R4-H)

export type ReadinessBlockerCode =
    | 'SOURCES_NOT_MATCHED' | 'METADATA_NOT_CONFIRMED' | 'REGISTER_NOT_CURRENT' | 'FINDINGS_NOT_CURRENT'
    | 'FINDINGS_UNREVIEWED' | 'FINDINGS_ON_HOLD' | 'QA_RESULT_NOT_CURRENT';
export type NotEvaluatedWhy = 'NOT_IMPLEMENTED' | 'NO_DECLARED_REGISTER' | 'REGISTER_NOT_CURRENT' | 'SHEETS_WITHOUT_QA_INPUT';

export interface Readiness {
    /** FINAL_UNAVAILABLE while any rule is not implemented: always so in M7-P3's first scope. */
    status: 'FINAL_UNAVAILABLE' | 'BLOCKED' | 'READY';
    /** Each with its subjects, ascending. QA_RESULT_NOT_CURRENT's are NO_QA_RUN, MANIFEST_CHANGED and UNSTATED:<findingKey>. */
    blockers: { code: ReadinessBlockerCode; subjects: string[] }[];
    /** What was not evaluated, beside the blockers: nothing unevaluated reads as a pass. */
    notEvaluated: { ruleId: QaRuleId; why: NotEvaluatedWhy; subjects?: Uuid[] }[];
}

/** Everything the screen asks about one state at once: one evaluation, one currency per Finding. */
export interface QaAssessment {
    evaluation: QaEvaluation;
    currency: ReadonlyMap<Uuid, FindingCurrency>;
    decisions: ReadonlyMap<Uuid, ReviewDecision[]>;
    effective: ReadonlyMap<Uuid, ReviewOutcome | null>;
    fullyEvaluable: boolean;
    readiness: Readiness;
    /** The bounds a run would go past now; empty when a run would be accepted. */
    refusal: LimitExcess[];
}

export function assessQa(
    set: DrawingSet, bindingOf: BindingOf, evaluation: QaEvaluation = evaluateQa(set),
    options: { implementedRules?: readonly QaRuleId[] } = {},
): QaAssessment {
    const fullyEvaluable = setFullyEvaluable(evaluation, bindingOf);
    const decisions = decisionsByFinding(set);
    const active = set.findings.filter((finding) => finding.lifecycle.state === 'ACTIVE');
    const currency = new Map<Uuid, FindingCurrency>();
    const effective = new Map<Uuid, ReviewOutcome | null>();
    for (const finding of set.findings) {
        currency.set(finding.id, findingCurrencyOf(finding, evaluation, bindingOf, () => fullyEvaluable));
        effective.set(finding.id, effectiveOf(decisions.get(finding.id)));
    }
    const readiness = readinessFrom(set, evaluation, bindingOf, active, currency, effective, options.implementedRules ?? IMPLEMENTED_QA_RULES);
    return { evaluation, currency, decisions, effective, fullyEvaluable, readiness, refusal: qaRefusalOf(set, evaluation) };
}

/** §J readiness with CAN-03 MD-3, for one state. */
export function readinessOf(
    set: DrawingSet, bindingOf: BindingOf, evaluation: QaEvaluation = evaluateQa(set),
    options: { implementedRules?: readonly QaRuleId[] } = {},
): Readiness {
    return assessQa(set, bindingOf, evaluation, options).readiness;
}

function readinessFrom(
    set: DrawingSet, evaluation: QaEvaluation, bindingOf: BindingOf, active: Finding[],
    currency: ReadonlyMap<Uuid, FindingCurrency>, effective: ReadonlyMap<Uuid, ReviewOutcome | null>, implementedRules: readonly QaRuleId[],
): Readiness {
    const blockers: Readiness['blockers'] = [];
    const add = (code: ReadinessBlockerCode, subjects: string[]): void => {
        if (subjects.length > 0) blockers.push({ code, subjects: [...subjects].sort(cmp) });
    };
    add('SOURCES_NOT_MATCHED', set.sources.filter(isLive).filter((source) => bindingOf(source.id) !== 'MATCHED').map((source) => source.id));
    // A Sheet with no valid confirmation always has a QA02 statement now; its key names the Sheet alone.
    const qa02KeyOf = new Map<Uuid, Sha256Hex>();
    for (const st of evaluation.statements) if (st.ruleId === QA02) qa02KeyOf.set(st.sheetIds[0], st.findingKey);
    // One ACTIVE Finding per key (REL_FINDING_KEY_NOT_UNIQUE); the first is the one asked.
    const activeByKey = new Map<Sha256Hex, Finding>();
    for (const finding of active) if (!activeByKey.has(finding.findingKey)) activeByKey.set(finding.findingKey, finding);
    add('METADATA_NOT_CONFIRMED', evaluation.liveSheets.filter((sheet) => {
        if (evaluation.inputs.get(sheet.id)!.origin === 'CONFIRMED') return false;
        const key = qa02KeyOf.get(sheet.id);
        const qa02 = key ? activeByKey.get(key) : undefined;
        return !(qa02 && currency.get(qa02.id) === 'CURRENT' && effective.get(qa02.id) === 'INTENTIONAL');
    }).map((sheet) => sheet.id));
    add('REGISTER_NOT_CURRENT', evaluation.register.notCurrent);
    add('FINDINGS_NOT_CURRENT', active.filter((finding) => currency.get(finding.id) !== 'CURRENT').map((finding) => finding.id));
    add('FINDINGS_UNREVIEWED', active.filter((finding) => currency.get(finding.id) === 'CURRENT' && effective.get(finding.id) === null).map((finding) => finding.id));
    add('FINDINGS_ON_HOLD', active.filter((finding) => effective.get(finding.id) === 'HOLD').map((finding) => finding.id));
    // MD-3: the Findings are the current state's own statements, made by a QA run over the current bytes.
    const latest = set.analysisRuns.filter((run) => run.kind === 'QA' && run.outcome === 'COMPLETED').at(-1) ?? null;
    const notCurrent: string[] = [];
    if (latest === null) notCurrent.push('NO_QA_RUN');
    else {
        if (latest.manifestDigest !== evaluation.manifestDigest) notCurrent.push('MANIFEST_CHANGED');
        for (const st of evaluation.statements) {
            const finding = activeByKey.get(st.findingKey);
            if (!finding || finding.evidenceDigest !== st.evidenceDigest) notCurrent.push(`UNSTATED:${st.findingKey}`);
        }
    }
    add('QA_RESULT_NOT_CURRENT', notCurrent);
    const register = evaluation.register;
    const noInput = evaluation.liveSheets.filter((sheet) => evaluation.inputs.get(sheet.id)!.origin === 'NONE').map((sheet) => sheet.id);
    const notEvaluated: Readiness['notEvaluated'] = [
        ...QA_RULE_IDS.filter((ruleId) => !implementedRules.includes(ruleId)).map((ruleId) => ({ ruleId, why: 'NOT_IMPLEMENTED' as const })),
        ...(register.state === 'NONE' ? [{ ruleId: QA09, why: 'NO_DECLARED_REGISTER' as const }] : []),
        ...(register.state === 'NOT_CURRENT' ? [{ ruleId: QA09, why: 'REGISTER_NOT_CURRENT' as const }] : []),
        ...(noInput.length > 0
            ? [QA01, ...(register.state === 'EVALUABLE' ? [QA09] : [])].map((ruleId) => ({ ruleId: ruleId as QaRuleId, why: 'SHEETS_WITHOUT_QA_INPUT' as const, subjects: noInput }))
            : []),
    ];
    const status = notEvaluated.some((entry) => entry.why === 'NOT_IMPLEMENTED') ? 'FINAL_UNAVAILABLE' : blockers.length > 0 ? 'BLOCKED' : 'READY';
    return { status, blockers, notEvaluated };
}
