// CAN-03 R4 -- proposal reference generator (NOT the adopted contract; contracts/m7 is unchanged).
// R4 = R3 aligned with the adopted contract at app main 2e33fcf3b80591b3567645f6749e8570e7dbb740:
//   A1  semantic-contract §E: QA09 compares the Sheets with the live entries of EVERY live Drawing Register
//       Reference together. No reference is chosen or silently ignored; if any live reference is not current, the
//       declared register is not current as a whole (REGISTER_NOT_CURRENT) and QA09 is not evaluated.
//   A2  the model is the schema's own shape (DrawingSet, Sheet.observation / confirmation, profileAssignment,
//       TitleBlockProfile, DrawingRegisterReference, AnalysisRun, Finding, ReviewDecision). Validity follows
//       currencyOf in src/utils/drawing-set/currency.ts (profile id AND revision AND a live profile). QA02's
//       evidence carries the four title-block values. key / evidence input strings are runtime diagnostics only:
//       nothing that decides (currency, closing, readiness) reads them, and they are never stored.
//   A3  Final readiness keeps every §J blocker and adds QA_RESULT_NOT_CURRENT; while a rule is not implemented
//       the result is never READY.
//
// A pure, dependency-free model (Node 18+):
//   node can03-r4-generator.mjs > can03-r4-vectors.json
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byFirst = (a, b) => cmp(a[0], b[0]);
const byId = (a, b) => cmp(a.id, b.id);
export const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const HEX = (c) => c.repeat(64);
export const FIELD_NAMES = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
export const ENGINE_VERSION = '0.0.0-can03-r4';
const QA01 = 'QA01_DUPLICATE_NUMBER';
const QA02 = 'QA02_METADATA_UNCONFIRMED';
const QA09 = 'QA09_REGISTER_SHEET_MISMATCH';
/** The schema's ruleId enum, in its order. */
export const ALL_RULES = [
    QA01, 'QA01B_DUPLICATE_NUMBER_VARIANT', QA02, 'QA03_NUMBER_GAP', 'QA04_SAME_NUMBER_DIFFERENT_TITLE',
    'QA05_REVISION_MISMATCH', 'QA06_ISSUE_DATE_MISMATCH', 'QA07_SHEET_SIZE_OUTLIER', 'QA08_ORIENTATION_OUTLIER',
    QA09, 'QA10_INTEGRITY',
];
/** The P3 first-scope candidate (H2). */
export const P3_INITIAL_RULES = [QA01, QA02, QA09];
/** comparisonKey: ECMAScript String.prototype.trim() only. Internal spaces kept; no width / case / dash folding. */
export const comparisonKey = (value) => value.trim();
export const V = (drawingNumber, drawingTitle = '', revision = '', issueDate = '') => ({ drawingNumber, drawingTitle, revision, issueDate });

// ---------------------------------------------------------------- byte derivations (R4-B)
export function findingKey(ruleId, reason, parts) {
    const input = JSON.stringify(['m7.findingKey', 1, ruleId, reason, ...parts]);
    return { input, hex: sha(input) };
}
export function evidenceDigest({ ruleId, ruleVersion = 1, reason, basis, sheets, entries, extra }) {
    const input = JSON.stringify(['m7.evidenceDigest', 1, ruleId, ruleVersion, reason,
        [...basis].sort(byFirst), [...sheets].sort(byFirst), [...entries].sort(byFirst), extra]);
    return { input, hex: sha(input) };
}
/** semantic-contract §F, unchanged. */
export const manifestDigest = (ds) => sha(JSON.stringify(ds.sources.filter(isLive).map((s) => [s.id, s.fingerprint.sha256]).sort(byFirst)));

// ---------------------------------------------------------------- the model's own small helpers
export const isLive = (e) => e.retiredAt === null;
const find = (list, id) => list.find((x) => x.id === id) ?? null;
const sourceOf = (ds, id) => find(ds.sources, id);
const sheetOf = (ds, id) => find(ds.sheets, id);
/** A Register Entry is live when it and its reference are both live (R4-C). */
export const liveEntry = (ds, id) => ds.drawingRegisterReferences.some((r) => isLive(r) && r.entries.some((e) => e.id === id && isLive(e)));
/** Runtime binding (never stored). Anything but MATCHED is not MATCHED. */
export const bindingOf = (s, sourceId) => s.bindings[sourceId] ?? 'UNBOUND';

// ---------------------------------------------------------------- QA input (R4-A)
/**
 * Validity axis: the record's basis is the model's now. Same tests as currencyOf (src/utils/drawing-set/currency.ts):
 * the Source is live and has the recorded bytes; a profile basis needs the Sheet still assigned to THAT profile id,
 * the profile live, and its revision equal. A confirmation typed with no profile (profile: null) is untouched by
 * profile changes. Binding is a separate axis and is not read here.
 */
export function recordValid(ds, sheet, record) {
    if (!record) return false;
    const source = sourceOf(ds, sheet.sourceId);
    if (!source || !isLive(source) || source.fingerprint.sha256 !== record.sourceSha256) return false;
    if (record.profile === null) return true;
    const assigned = sheet.profileAssignment;
    const profile = find(ds.titleBlockProfiles, record.profile.profileId);
    return assigned !== null && assigned.profileId === record.profile.profileId
        && profile !== null && isLive(profile) && profile.revision === record.profile.profileRevision;
}
export function qaInput(ds, sheet) {
    const confirmationValid = recordValid(ds, sheet, sheet.confirmation);
    const observationValid = recordValid(ds, sheet, sheet.observation);
    let origin = 'NONE';
    let values = null; // the four values in FIELD_NAMES order, or null
    if (confirmationValid) {
        origin = 'CONFIRMED';
        values = FIELD_NAMES.map((f) => sheet.confirmation.values[f]);
    } else if (observationValid && sheet.observation.status === 'READ') {
        origin = 'OBSERVED';
        values = FIELD_NAMES.map((f) => sheet.observation.fields[f].value);
    }
    let qa02 = null;
    if (!confirmationValid) {
        if (sheet.confirmation) qa02 = 'RECONFIRM_REQUIRED';
        else if (!sheet.observation) qa02 = 'NOT_READ';
        else if (!observationValid) qa02 = 'READ_IS_STALE';
        else if (sheet.observation.status === 'OCR_FAILED') qa02 = 'OCR_FAILED';
        else qa02 = 'UNCONFIRMED';
    }
    return { origin, values, number: values ? values[0] : null, qa02 };
}

// ---------------------------------------------------------------- the declared register (R4-C)
/**
 * NONE         no live reference (none declared, or every one withdrawn): QA09 NOT_EVALUABLE, not a blocker;
 * NOT_CURRENT  at least one live reference is not current (its Source retired or its bytes replaced): QA09 is
 *              not evaluated, REGISTER_NOT_CURRENT blocks Final; no reference is chosen out of the others;
 * EVALUABLE    every live reference is current: the live entries of all of them are compared together.
 */
export function registerState(ds) {
    const refs = ds.drawingRegisterReferences.filter(isLive).sort(byId);
    if (refs.length === 0) return { state: 'NONE', refs: [], notCurrent: [], entries: [] };
    const notCurrent = refs.filter((r) => {
        const source = sourceOf(ds, r.sourceId);
        return !source || !isLive(source) || source.fingerprint.sha256 !== r.sourceSha256;
    }).map((r) => r.id);
    const entries = refs.flatMap((r) => r.entries.filter(isLive).map((e) => ({ id: e.id, referenceId: r.id, drawingNumber: e.drawingNumber }))).sort(byId);
    return { state: notCurrent.length > 0 ? 'NOT_CURRENT' : 'EVALUABLE', refs, notCurrent, entries };
}

const liveSheets = (ds) => ds.sheets.filter(isLive).sort(byId);
/** Every live Sheet has a QA input and its Source is MATCHED this session. Derived each time; never stored (R3-D). */
export function setFullyEvaluable(s) {
    return liveSheets(s.ds).every((sh) => qaInput(s.ds, sh).origin !== 'NONE' && bindingOf(s, sh.sourceId) === 'MATCHED');
}

// ---------------------------------------------------------------- one QA run's statements (R4-D)
function statement(p) {
    // The key names the question: QA09's reason is part of it; QA02's reason is part of the evidence only, so a
    // changed reason restates the same question (R3: READ_IS_STALE supersedes UNCONFIRMED).
    const key = findingKey(p.ruleId, p.ruleId === QA09 ? p.reason : null, p.keyParts);
    const evidence = evidenceDigest({ ruleId: p.ruleId, reason: p.reason, basis: p.basis, sheets: p.sheets, entries: p.entries, extra: p.extra });
    return {
        ruleId: p.ruleId, scope: p.scope, sheetIds: p.sheetIds, sourceIds: [], registerEntryIds: p.registerEntryIds,
        basis: [...p.basis].sort(byFirst).map(([sourceId, sha256]) => ({ sourceId, sha256 })), params: p.params, key, evidence,
    };
}
/** What a run would state now, in a canonical order (QA02 by Sheet id, QA01 by key, ANL by Sheet id, LBM by key). */
export function statements(s) {
    const { ds } = s;
    const live = liveSheets(ds);
    const input = new Map(live.map((sh) => [sh.id, qaInput(ds, sh)]));
    const shaOf = (id) => sourceOf(ds, id).fingerprint.sha256;
    const basisOf = (sourceIds) => [...new Set(sourceIds)].sort(cmp).map((id) => [id, shaOf(id)]);
    const out = [];
    for (const sh of live) {
        const q = input.get(sh.id);
        if (!q.qa02) continue;
        out.push(statement({
            ruleId: QA02, reason: q.qa02, scope: 'SHEET', sheetIds: [sh.id], registerEntryIds: [], params: { reason: q.qa02 },
            keyParts: [sh.id], basis: basisOf([sh.sourceId]), sheets: [[sh.id, q.origin, q.values]], entries: [], extra: null,
        }));
    }
    const groups = new Map();
    for (const sh of live) {
        const q = input.get(sh.id);
        if (q.origin === 'NONE') continue;
        const k = comparisonKey(q.number);
        if (k === '') continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(sh.id);
    }
    for (const k of [...groups.keys()].sort(cmp)) {
        const ids = groups.get(k);
        if (ids.length < 2) continue;
        out.push(statement({
            ruleId: QA01, reason: null, scope: 'SHEET_GROUP', sheetIds: ids, registerEntryIds: [], params: { comparisonKey: k },
            keyParts: [k], basis: basisOf(ids.map((id) => sheetOf(ds, id).sourceId)),
            sheets: ids.map((id) => [id, input.get(id).origin, input.get(id).number]), entries: [], extra: null,
        }));
    }
    const reg = registerState(ds);
    if (reg.state === 'EVALUABLE') {
        const listed = new Set(reg.entries.map((e) => comparisonKey(e.drawingNumber)));
        const evaluated = live.filter((sh) => input.get(sh.id).origin !== 'NONE');
        const carried = new Set(evaluated.map((sh) => comparisonKey(input.get(sh.id).number)).filter((k) => k !== ''));
        const allRefs = reg.refs.map((r) => [r.id, r.sourceSha256]);
        for (const sh of evaluated) {
            const q = input.get(sh.id);
            const k = comparisonKey(q.number);
            if (k === '' || listed.has(k)) continue;
            out.push(statement({
                ruleId: QA09, reason: 'ACTUAL_NOT_LISTED', scope: 'SHEET', sheetIds: [sh.id], registerEntryIds: [],
                params: { reason: 'ACTUAL_NOT_LISTED', comparisonKey: k }, keyParts: [sh.id],
                basis: basisOf([sh.sourceId, ...reg.refs.map((r) => r.sourceId)]), sheets: [[sh.id, q.origin, q.number]], entries: [], extra: allRefs,
            }));
        }
        const byKey = new Map();
        for (const e of reg.entries) {
            const k = comparisonKey(e.drawingNumber);
            if (carried.has(k)) continue;
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(e);
        }
        for (const k of [...byKey.keys()].sort(cmp)) {
            const cited = byKey.get(k); // already in entryId order
            const refs = [...new Set(cited.map((e) => e.referenceId))].sort(cmp).map((id) => find(reg.refs, id));
            out.push(statement({
                ruleId: QA09, reason: 'LISTED_BUT_MISSING', scope: 'REGISTER_ENTRY', sheetIds: [], registerEntryIds: cited.map((e) => e.id),
                params: { reason: 'LISTED_BUT_MISSING', comparisonKey: k }, keyParts: [k],
                basis: basisOf(refs.map((r) => r.sourceId)), sheets: [], entries: cited.map((e) => [e.id, e.referenceId, e.drawingNumber]),
                extra: refs.map((r) => [r.id, r.sourceSha256]),
            }));
        }
    }
    const keys = out.map((st) => st.key.hex);
    if (new Set(keys).size !== keys.length) throw new Error('a run stated the same findingKey twice');
    return { out, input, reg, live };
}

/** Could this run evaluate the question a stored ACTIVE Finding asks? Reads stored fields only. */
function evaluable(f, s, ctx) {
    const sheetLive = (id) => { const sh = sheetOf(s.ds, id); return sh !== null && isLive(sh); };
    const read = (id) => sheetLive(id) && ctx.input.get(id).origin !== 'NONE';
    switch (f.ruleId) {
        case QA02:
            return true; // every live Sheet is evaluated; a retired subject is evaluated as gone (H-R2-5)
        case QA01:
            return f.sheetIds.every((id) => !sheetLive(id) || read(id));
        case QA09:
            if (ctx.reg.state === 'NONE') return true; // R4 MD-2: every reference withdrawn, nothing is declared to compare
            if (ctx.reg.state !== 'EVALUABLE') return false;
            if (f.params.reason === 'ACTUAL_NOT_LISTED') return f.sheetIds.every((id) => !sheetLive(id) || read(id));
            {
                const k = f.params.comparisonKey;
                const found = ctx.live.some((sh) => read(sh.id) && comparisonKey(ctx.input.get(sh.id).number) === k);
                const allRead = ctx.live.every((sh) => read(sh.id));
                const stillListed = ctx.reg.entries.some((e) => comparisonKey(e.drawingNumber) === k);
                return found || allRead || !stillListed;
            }
        default:
            return false;
    }
}

// ---------------------------------------------------------------- session (schema-shaped DrawingSet + runtime)
const tick = (s) => { s.t += 60000; return new Date(s.t).toISOString(); };
const mint = (s, kind) => U(++s.counters[kind]);
/** A session: the stored DrawingSet, plus runtime-only bindings and diagnostics (aux). Plain data: JSON-cloneable. */
export function newSession({ start = '2026-10-27T00:00:00.000Z', counters = {} } = {}) {
    const t = Date.parse(start);
    const at = new Date(t).toISOString();
    return {
        project: { id: U(9001), name: 'CAN-03 R4 synthetic', createdAt: at },
        ds: {
            id: U(9002), name: 'CAN-03 R4 synthetic set', createdAt: at,
            sources: [], titleBlockProfiles: [], sheets: [], drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [],
        },
        bindings: {},
        aux: {}, // findingId -> { keyInput, evidenceInput }: runtime diagnostics for the vectors; never stored, never read to decide
        t,
        counters: { run: 900, extraction: 800, finding: 100, decision: 500, ...counters },
    };
}
export const cloneSession = (s) => JSON.parse(JSON.stringify(s));

const RECT = (left, top, right, bottom) => ({ left, top, right, bottom });
export function addSource(s, { id, sha256, pageCount = 2, displayName = null }) {
    const at = tick(s);
    s.ds.sources.push({
        id, displayName: displayName ?? `source-${id.slice(-3)}.pdf`, addedAt: at, retiredAt: null,
        fingerprint: { algorithm: 'SHA-256', sha256, byteLength: 4096, pageCount, recordedAt: at }, fingerprintHistory: [],
    });
    s.bindings[id] = 'MATCHED';
}
export function addProfile(s, { id, name = null }) {
    const at = tick(s);
    s.ds.titleBlockProfiles.push({
        id, name: name ?? `profile-${id.slice(-3)}`, revision: 1, transferModel: 'normalised',
        referencePage: { uprightWidthPt: 1190.55, uprightHeightPt: 841.89 },
        fields: { drawingNumber: RECT(1000, 780, 1180, 800), drawingTitle: RECT(1000, 800, 1180, 815), revision: RECT(1000, 815, 1090, 830), issueDate: RECT(1090, 815, 1180, 830) },
        createdAt: at, updatedAt: at, retiredAt: null,
    });
}
/** A geometry change: the revision counts it (semantic-contract §D). */
export function reviseProfile(s, id) {
    const p = find(s.ds.titleBlockProfiles, id);
    p.revision += 1;
    p.fields.drawingNumber = { ...p.fields.drawingNumber, left: p.fields.drawingNumber.left - 1 };
    p.updatedAt = tick(s);
}
export function addSheet(s, { id, sourceId, pageNumber, profileId = null }) {
    const at = tick(s);
    s.ds.sheets.push({
        id, sourceId, pageNumber, createdAt: at, retiredAt: null, pageFacts: null,
        profileAssignment: profileId ? { profileId, confirmedAt: at } : null, observation: null, confirmation: null, confirmationHistory: [],
    });
}
export function assignProfile(s, sheetId, profileId) {
    sheetOf(s.ds, sheetId).profileAssignment = profileId ? { profileId, confirmedAt: tick(s) } : null;
}
/** One EXTRACTION run that reads one Sheet under its current assignment (status READ or OCR_FAILED). */
export function read(s, sheetId, values, { status = 'READ' } = {}) {
    const sh = sheetOf(s.ds, sheetId);
    if (!sh.profileAssignment) throw new Error('read needs a profile assignment');
    const profile = find(s.ds.titleBlockProfiles, sh.profileAssignment.profileId);
    const at = tick(s);
    const run = {
        id: mint(s, 'extraction'), kind: 'EXTRACTION', startedAt: at, completedAt: at, outcome: 'COMPLETED',
        engine: { name: 'register-extraction', version: ENGINE_VERSION }, manifestDigest: manifestDigest(s.ds), coverage: { sheetsEvaluated: 1, sheetsExcluded: 0 },
    };
    s.ds.analysisRuns.push(run);
    const fields = Object.fromEntries(FIELD_NAMES.map((f) => [f, status === 'READ'
        ? { value: values[f], rawText: values[f], source: 'native', ocrScore: null }
        : { value: '', rawText: '', source: 'none', ocrScore: null }]));
    sh.observation = { runId: run.id, sourceSha256: sourceOf(s.ds, sh.sourceId).fingerprint.sha256, profile: { profileId: profile.id, profileRevision: profile.revision }, status, fields };
    return run.id;
}
/** HDR-36-01 (semantic-contract §C), as metadata-confirmation.ts computes it. */
export function editedFieldsFor(values, observation) {
    if (!observation) return [...FIELD_NAMES];
    return FIELD_NAMES.filter((f) => observation.fields[f].source === 'none' || values[f] !== observation.fields[f].value);
}
/** basis 'observation': takes the valid observation's own basis; 'manual': typed with no profile (profile: null). */
export function confirm(s, sheetId, values, { basis = 'observation' } = {}) {
    const sh = sheetOf(s.ds, sheetId);
    const source = sourceOf(s.ds, sh.sourceId);
    if (bindingOf(s, source.id) !== 'MATCHED') throw new Error('confirm needs the Source MATCHED (metadata-confirmation.ts)');
    let observation = null;
    if (basis === 'observation') {
        if (!recordValid(s.ds, sh, sh.observation)) throw new Error('confirm from an observation needs a valid one');
        observation = sh.observation;
    }
    const at = tick(s);
    const confirmation = {
        confirmedAt: at, sourceSha256: observation ? observation.sourceSha256 : source.fingerprint.sha256,
        profile: observation ? { ...observation.profile } : null, values: { ...values }, editedFields: editedFieldsFor(values, observation),
    };
    if (sh.confirmation) sh.confirmationHistory.push({ confirmation: sh.confirmation, retiredAt: at, reason: 'RECONFIRMED' });
    sh.confirmation = confirmation;
}
export function withdraw(s, sheetId) {
    const sh = sheetOf(s.ds, sheetId);
    sh.confirmationHistory.push({ confirmation: sh.confirmation, retiredAt: tick(s), reason: 'WITHDRAWN' });
    sh.confirmation = null;
}
/** A person accepts new bytes for a Source (semantic-contract §B). */
export function replaceSourceBytes(s, sourceId, sha256) {
    const source = sourceOf(s.ds, sourceId);
    const at = tick(s);
    source.fingerprintHistory.push({ fingerprint: source.fingerprint, retiredAt: at, reason: 'REPLACED_BY_HUMAN' });
    source.fingerprint = { ...source.fingerprint, sha256, recordedAt: at };
}
export function retireSheet(s, sheetId) { sheetOf(s.ds, sheetId).retiredAt = tick(s); }
export function retireReference(s, referenceId) { find(s.ds.drawingRegisterReferences, referenceId).retiredAt = tick(s); }
export function retireEntry(s, entryId) {
    for (const r of s.ds.drawingRegisterReferences) {
        const e = find(r.entries, entryId);
        if (e) { e.retiredAt = tick(s); r.updatedAt = e.retiredAt; }
    }
}
/** A typed (MANUAL) register reference on one page of a Source: semantic-contract §E. */
export function declareRegister(s, { id, sourceId, pageNumber = 1, entries }) {
    const at = tick(s);
    s.ds.drawingRegisterReferences.push({
        id, sourceId, pageNumber, region: null, sourceSha256: sourceOf(s.ds, sourceId).fingerprint.sha256, method: 'MANUAL',
        declaredAt: at, updatedAt: at, retiredAt: null,
        entries: entries.map((e, i) => ({ id: e.id, row: e.row ?? i + 1, drawingNumber: e.number, drawingTitle: null, revision: null, issueDate: null, origin: 'MANUAL', retiredAt: null })),
    });
}
export function setBinding(s, sourceId, state) { s.bindings[sourceId] = state; }

// ---------------------------------------------------------------- one QA run (R4-F, R4-G)
/** Atomic: the run, its new findings and its closings are appended together, or nothing is. */
export function runQa(s) {
    const ctx = statements(s);
    const at = tick(s);
    const evaluatedCount = ctx.live.filter((sh) => ctx.input.get(sh.id).origin !== 'NONE').length;
    const run = {
        id: mint(s, 'run'), kind: 'QA', startedAt: at, completedAt: at, outcome: 'COMPLETED',
        engine: { name: 'drawing-set-qa', version: ENGINE_VERSION }, manifestDigest: manifestDigest(s.ds),
        coverage: { sheetsEvaluated: evaluatedCount, sheetsExcluded: ctx.live.length - evaluatedCount },
    };
    const findings = s.ds.findings;
    const active = (keyHex) => findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.findingKey === keyHex);
    const stated = new Set();
    const created = [];
    for (const st of ctx.out) {
        stated.add(st.key.hex);
        const prior = active(st.key.hex);
        if (prior && prior.evidenceDigest === st.evidence.hex) continue; // same finding: nothing written
        const f = {
            id: mint(s, 'finding'), runId: run.id, ruleId: st.ruleId, ruleVersion: 1, determinism: 'DETERMINISTIC', scope: st.scope,
            sheetIds: st.sheetIds, sourceIds: st.sourceIds, registerEntryIds: st.registerEntryIds,
            findingKey: st.key.hex, evidenceDigest: st.evidence.hex, basis: st.basis, params: st.params, createdAt: at,
            lifecycle: { state: 'ACTIVE', supersededByFindingId: null, closedByRunId: null, closedAt: null },
        };
        if (prior) prior.lifecycle = { state: 'SUPERSEDED', supersededByFindingId: f.id, closedByRunId: run.id, closedAt: at };
        s.aux[f.id] = { keyInput: st.key.input, evidenceInput: st.evidence.input };
        findings.push(f);
        created.push(f.id);
    }
    for (const f of findings) {
        if (f.lifecycle.state !== 'ACTIVE' || stated.has(f.findingKey) || f.runId === run.id) continue;
        if (evaluable(f, s, ctx)) f.lifecycle = { state: 'NOT_REPRODUCED', supersededByFindingId: null, closedByRunId: run.id, closedAt: at };
    }
    s.ds.analysisRuns.push(run);
    return { run, created, register: ctx.reg.state };
}

// ---------------------------------------------------------------- currency (R4-E): stored fields + current state only
export function findingCurrency(s, f) {
    if (f.lifecycle.state !== 'ACTIVE') return 'HISTORICAL';
    const { ds } = s;
    const now = statements(s);
    const subjectRetired = f.sheetIds.some((id) => { const sh = sheetOf(ds, id); return sh === null || !isLive(sh); })
        || f.registerEntryIds.some((id) => !liveEntry(ds, id));
    const basisMoved = f.basis.some(({ sourceId, sha256 }) => { const src = sourceOf(ds, sourceId); return !src || !isLive(src) || src.fingerprint.sha256 !== sha256; });
    const registerGone = f.ruleId === QA09 && now.reg.state !== 'EVALUABLE';
    const restated = now.out.find((st) => st.key.hex === f.findingKey) ?? null;
    if (subjectRetired || basisMoved || registerGone || !restated || restated.evidence.hex !== f.evidenceDigest) return 'STALE';
    const unbound = f.basis.some(({ sourceId }) => bindingOf(s, sourceId) !== 'MATCHED');
    const setWide = f.ruleId === QA09 && f.params.reason === 'LISTED_BUT_MISSING';
    if (unbound || (setWide && !setFullyEvaluable(s))) return 'UNVERIFIED';
    return 'CURRENT';
}

// ---------------------------------------------------------------- Review Decision (R4-F)
export const decisionsOf = (s, findingId) => s.ds.decisions.filter((d) => d.findingId === findingId).sort((a, b) => a.sequence - b.sequence);
export const effectiveDecision = (s, f) => decisionsOf(s, f.id).at(-1)?.outcome ?? null;
/** Append-only; only on an ACTIVE and CURRENT Finding (R4 MD-4); evidenceDigest copied from the Finding. */
export function decide(s, findingId, outcome, comment = '') {
    const f = find(s.ds.findings, findingId);
    if (!f) return { ok: false, refusal: 'NO_SUCH_FINDING' };
    if (f.lifecycle.state !== 'ACTIVE') return { ok: false, refusal: 'FINDING_NOT_ACTIVE' };
    const currency = findingCurrency(s, f);
    if (currency !== 'CURRENT') return { ok: false, refusal: 'FINDING_NOT_CURRENT', currency };
    const decision = {
        id: mint(s, 'decision'), findingId: f.id, sequence: decisionsOf(s, f.id).length + 1, outcome, comment,
        decidedAt: tick(s), evidenceDigest: f.evidenceDigest,
    };
    s.ds.decisions.push(decision);
    return { ok: true, decision };
}

// ---------------------------------------------------------------- Final readiness (R4-H)
export const J_BLOCKERS = ['SOURCES_NOT_MATCHED', 'METADATA_NOT_CONFIRMED', 'REGISTER_NOT_CURRENT', 'FINDINGS_NOT_CURRENT', 'FINDINGS_UNREVIEWED', 'FINDINGS_ON_HOLD'];
export function readiness(s, { implementedRules = P3_INITIAL_RULES } = {}) {
    const { ds } = s;
    const blockers = [];
    const add = (code, subjects) => { if (subjects.length > 0) blockers.push({ code, subjects: [...subjects].sort(cmp) }); };
    add('SOURCES_NOT_MATCHED', ds.sources.filter(isLive).filter((x) => bindingOf(s, x.id) !== 'MATCHED').map((x) => x.id));
    const active = ds.findings.filter((f) => f.lifecycle.state === 'ACTIVE');
    const currency = new Map(active.map((f) => [f.id, findingCurrency(s, f)]));
    const effective = new Map(active.map((f) => [f.id, effectiveDecision(s, f)]));
    add('METADATA_NOT_CONFIRMED', liveSheets(ds).filter((sh) => {
        if (recordValid(ds, sh, sh.confirmation)) return false;
        const key = findingKey(QA02, null, [sh.id]).hex;
        const qa02 = active.find((f) => f.findingKey === key) ?? null;
        return !(qa02 && currency.get(qa02.id) === 'CURRENT' && effective.get(qa02.id) === 'INTENTIONAL');
    }).map((sh) => sh.id));
    const reg = registerState(ds);
    add('REGISTER_NOT_CURRENT', reg.notCurrent);
    add('FINDINGS_NOT_CURRENT', active.filter((f) => currency.get(f.id) !== 'CURRENT').map((f) => f.id));
    add('FINDINGS_UNREVIEWED', active.filter((f) => currency.get(f.id) === 'CURRENT' && effective.get(f.id) === null).map((f) => f.id));
    add('FINDINGS_ON_HOLD', active.filter((f) => effective.get(f.id) === 'HOLD').map((f) => f.id));
    // R4 MD-3: the findings must be the current state's own statements, made by a QA run over the current bytes.
    const qaRuns = ds.analysisRuns.filter((r) => r.kind === 'QA' && r.outcome === 'COMPLETED');
    const latest = qaRuns.at(-1) ?? null;
    const notCurrent = [];
    if (latest === null) notCurrent.push('NO_QA_RUN');
    else {
        if (latest.manifestDigest !== manifestDigest(ds)) notCurrent.push('MANIFEST_CHANGED');
        for (const st of statements(s).out) {
            if (!active.some((f) => f.findingKey === st.key.hex && f.evidenceDigest === st.evidence.hex)) notCurrent.push(`UNSTATED:${st.key.hex}`);
        }
    }
    add('QA_RESULT_NOT_CURRENT', notCurrent);
    // §J: beside the blockers, what was not evaluated -- so nothing unevaluated reads as a pass. Information, not
    // a blocker: a Sheet with no QA input is outside QA01 / QA09 (QA02 and METADATA_NOT_CONFIRMED cover it).
    const noInput = liveSheets(ds).filter((sh) => qaInput(ds, sh).origin === 'NONE').map((sh) => sh.id);
    const notEvaluated = [
        ...ALL_RULES.filter((r) => !implementedRules.includes(r)).map((ruleId) => ({ ruleId, why: 'NOT_IMPLEMENTED' })),
        ...(reg.state === 'NONE' ? [{ ruleId: QA09, why: 'NO_DECLARED_REGISTER' }] : []),
        ...(reg.state === 'NOT_CURRENT' ? [{ ruleId: QA09, why: 'REGISTER_NOT_CURRENT' }] : []),
        ...(noInput.length > 0 ? [QA01, ...(reg.state === 'EVALUABLE' ? [QA09] : [])].map((ruleId) => ({ ruleId, why: 'SHEETS_WITHOUT_QA_INPUT', subjects: noInput })) : []),
    ];
    const status = notEvaluated.some((n) => n.why === 'NOT_IMPLEMENTED') ? 'FINAL_UNAVAILABLE' : blockers.length > 0 ? 'BLOCKED' : 'READY';
    return { status, blockers, notEvaluated };
}

// ---------------------------------------------------------------- views and the file envelope
export function viewFinding(s, f) {
    return {
        id: f.id, ruleId: f.ruleId, reason: f.params.reason ?? null, lifecycle: f.lifecycle.state, supersededBy: f.lifecycle.supersededByFindingId,
        currency: findingCurrency(s, f), findingKey: f.findingKey, evidenceDigest: f.evidenceDigest,
        keyInput: s.aux[f.id]?.keyInput ?? null, evidenceInput: s.aux[f.id]?.evidenceInput ?? null,
        effectiveDecision: effectiveDecision(s, f),
        decisions: decisionsOf(s, f.id).map((d) => ({ findingId: d.findingId, sequence: d.sequence, outcome: d.outcome, evidenceDigest: d.evidenceDigest })),
        stored: f,
    };
}
/** TEST ONLY: the minimum file envelope the schema requires around a model (as scripts/smoke-m7-p1.mjs does). Not a save format. */
export function toProjectFile(s) {
    const latest = Math.max(s.t, ...JSON.stringify(s.ds).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g).map(Date.parse));
    return {
        format: 'pdf-architools/drawing-set-project', schemaVersion: 1, projectFileId: U(9003),
        lineage: { saveSequence: 1, previousProjectFileId: null, migratedFrom: null },
        savedAt: new Date(latest + 60000).toISOString(), writer: { app: 'PDF_ArchiTools', toolVersion: ENGINE_VERSION },
        project: s.project, drawingSet: s.ds,
    };
}

// ---------------------------------------------------------------- scenario 1: R3's 13 steps, in the schema's shape
const SRC1 = U(1), SRC2 = U(2), SRC3 = U(3), SH11 = U(11), SH12 = U(12), SH13 = U(13), SH14 = U(14);
const P1 = U(31), P2 = U(32), REG = U(20), E21 = U(21), E22 = U(22);
export const IDS = { SRC1, SRC2, SRC3, SH11, SH12, SH13, SH14, P1, P2, REG, E21, E22 };

function recorder(s, onStep) {
    const steps = [];
    const record = (name, note) => {
        const r = runQa(s);
        steps.push({
            step: steps.length + 1, name, note, qaRun: r.run, register: r.register,
            findings: s.ds.findings.map((f) => viewFinding(s, f)), readinessP3: readiness(s),
        });
        if (onStep) onStep(s, name);
        return r;
    };
    const of = (rule, reason = null, k = null) => s.ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === rule
        && (reason === null || f.params.reason === reason) && (k === null || f.params.comparisonKey === k || f.sheetIds.includes(k)));
    const must = (result) => { if (!result.ok) throw new Error(`decision refused: ${result.refusal}`); return result; };
    return { steps, record, of, must };
}

/** R3's 13-step scenario (R3 generator lines 284-324), step for step, on the schema-shaped model. */
export function scenarioR3Regression({ onStep = null } = {}) {
    const s = newSession();
    addSource(s, { id: SRC1, sha256: HEX('a') });
    addSource(s, { id: SRC2, sha256: HEX('b') });
    addProfile(s, { id: P1 }); // S11, S13
    addProfile(s, { id: P2 }); // S12 -- R3 revises "S12's profile" alone, so S12 has a profile of its own
    addSheet(s, { id: SH11, sourceId: SRC1, pageNumber: 1, profileId: P1 });
    addSheet(s, { id: SH12, sourceId: SRC2, pageNumber: 1, profileId: P2 });
    addSheet(s, { id: SH13, sourceId: SRC2, pageNumber: 2, profileId: P1 });
    read(s, SH11, V('A-102', '配置図', 'A', '2026/10/01')); // run 801
    confirm(s, SH11, V('A-102', '配置図', 'A', '2026/10/01'));
    read(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01')); // run 802
    const { steps, record, of, must } = recorder(s, onStep);
    record('1 initial', 'QA01 on A-102 (confirmed + observed); QA02 S12 UNCONFIRMED, S13 NOT_READ; no register: QA09 not evaluated');
    must(decide(s, of(QA01).id, 'INTENTIONAL'));
    must(decide(s, of(QA02, 'UNCONFIRMED').id, 'HOLD'));
    confirm(s, SH11, V('A-102', '配置図', 'A', '2026/10/01')); // re-confirmed with the same values: a new confirmedAt only
    record('2 re-confirm same value', 'confirmedAt is not evidence: same QA01 finding, INTENTIONAL stands');
    read(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01')); // run 803: same values, a new runId
    record('3 same-value re-extraction', 'runId is not evidence: same QA01 / QA02 findings, decisions stand');
    confirm(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01'));
    record('4 S12 confirmed', 'QA01 superseded (decision stays with the old finding); QA02 S12 NOT_REPRODUCED');
    withdraw(s, SH12);
    record('5 S12 confirmation withdrawn', 'QA01 superseded again; its evidence equals step 1\'s, but it is a new finding with no decision; QA02 S12 UNCONFIRMED again (new finding)');
    reviseProfile(s, P2);
    record('6 S12 profile revised', 'S12 has no QA input: QA01 not evaluable for it, finding stays ACTIVE and STALE; QA02 S12 READ_IS_STALE supersedes UNCONFIRMED');
    read(s, SH12, V('A-102', '平面図', 'A', '2026/10/01')); // run 804 under P2 r2
    record('7 S12 re-read under r2', 'QA01 restated on new evidence (value no longer has the leading space) -> superseded');
    declareRegister(s, { id: REG, sourceId: SRC1, entries: [{ id: E21, number: 'A-102' }, { id: E22, number: 'A-104' }] });
    record('8 register declared', 'QA09 LISTED_BUT_MISSING A-104 stated, UNVERIFIED (S13 unread); no ACTUAL_NOT_LISTED');
    read(s, SH13, null, { status: 'OCR_FAILED' }); // run 805
    record('9 S13 OCR_FAILED', 'QA02 S13 OCR_FAILED supersedes NOT_READ; QA09 A-104 stays UNVERIFIED');
    read(s, SH13, V('A-105', '立面図', 'A', '2026/10/01')); // run 806
    record('10 S13 read A-105', 'QA09 A-104 same finding, now CURRENT; ACTUAL_NOT_LISTED S13 stated on an observed value');
    must(decide(s, of(QA09, 'ACTUAL_NOT_LISTED').id, 'ACTION_REQUIRED'));
    confirm(s, SH13, V('A-104', '立面図', 'A', '2026/10/01'));
    record('11 S13 confirmed A-104', 'both QA09 findings NOT_REPRODUCED (evaluated, no longer stated)');
    replaceSourceBytes(s, SRC1, HEX('c'));
    record('12 register Source replaced', 'QA09 not evaluable (REGISTER_NOT_CURRENT); S11 confirmation stale too -> QA01 not evaluable for S11, QA02 S11 RECONFIRM_REQUIRED');
    setBinding(s, SRC2, 'MISSING');
    record('13 Source 2 unbound', 'validity and binding apart: QA02 findings on Source 2 sheets UNVERIFIED');
    return { steps, session: s };
}

// ---------------------------------------------------------------- scenario 2: several references (R4-C)
const R1 = U(20), R2 = U(40), R3REF = U(60);
const E_R1 = { A101: U(21), A102: U(22), A104: U(23) }, E_R2 = { A103: U(41), A104: U(42) }, E_R3 = { A103: U(61) };
export const MR_IDS = { R1, R2, R3REF, E_R1, E_R2, E_R3 };
/** Builds the MR start state; exported for the counterexamples. */
export function mrStart() {
    const s = newSession();
    addSource(s, { id: SRC1, sha256: HEX('a') }); // drawings, and register page R1
    addSource(s, { id: SRC2, sha256: HEX('b') }); // drawings
    addSource(s, { id: SRC3, sha256: HEX('d'), pageCount: 1 }); // a list-only PDF: register page R2
    addProfile(s, { id: P1 });
    addSheet(s, { id: SH11, sourceId: SRC1, pageNumber: 1, profileId: P1 });
    addSheet(s, { id: SH12, sourceId: SRC1, pageNumber: 2, profileId: P1 });
    addSheet(s, { id: SH13, sourceId: SRC2, pageNumber: 1, profileId: P1 });
    addSheet(s, { id: SH14, sourceId: SRC2, pageNumber: 2, profileId: P1 });
    read(s, SH11, V('A-101', '配置図', 'A', '2026/10/01'));
    confirm(s, SH11, V('A-101', '配置図', 'A', '2026/10/01'));
    read(s, SH12, V('A-102', '平面図', 'A', '2026/10/01'));
    confirm(s, SH12, V('A-102', '平面図', 'A', '2026/10/01'));
    read(s, SH13, V('A-103', '立面図', 'A', '2026/10/01'));
    read(s, SH14, V('A-105', '断面図', 'A', '2026/10/01'));
    declareRegister(s, { id: R1, sourceId: SRC1, pageNumber: 1, entries: [{ id: E_R1.A101, number: 'A-101' }, { id: E_R1.A102, number: 'A-102' }, { id: E_R1.A104, number: 'A-104' }] });
    declareRegister(s, { id: R2, sourceId: SRC3, pageNumber: 1, entries: [{ id: E_R2.A103, number: 'A-103' }, { id: E_R2.A104, number: 'A-104 ' }] });
    return s;
}
export function scenarioMultiReference({ onStep = null } = {}) {
    const s = mrStart();
    const { steps, record, of, must } = recorder(s, onStep);
    record('MR1 two references', 'one register over R1 + R2: A-103 is listed (R2) so no ACTUAL_NOT_LISTED for S13; ANL S14 (A-105); one LBM A-104 citing E23 (R1) and E42 (R2, "A-104 " trimmed); QA02 S13 / S14 UNCONFIRMED');
    must(decide(s, of(QA09, 'ACTUAL_NOT_LISTED').id, 'ACTION_REQUIRED'));
    must(decide(s, of(QA09, 'LISTED_BUT_MISSING').id, 'INTENTIONAL'));
    // MR2: only the order of references and rows changes (row numbers too).
    s.ds.drawingRegisterReferences.reverse();
    for (const r of s.ds.drawingRegisterReferences) { r.entries.reverse(); r.entries.forEach((e, i) => { e.row = i + 1; }); }
    record('MR2 references and rows reordered', 'same keys, same evidence, same findings; decisions stand');
    retireEntry(s, E_R2.A104);
    const lbm = of(QA09, 'LISTED_BUT_MISSING');
    const beforeRerun = findingCurrency(s, lbm);
    record('MR3 R2 row A-104 retired', `before the run: LBM A-104 ${beforeRerun} (a cited entry retired); the run restates it citing E23 only -> new finding, INTENTIONAL stays with the old one`);
    setBinding(s, SRC3, 'MISSING');
    record('MR4 R2 Source not bound', 'QA09 still evaluated (validity and binding apart); ANL S14 UNVERIFIED (its basis has every reference Source); LBM A-104 cites R1 only -> CURRENT');
    setBinding(s, SRC3, 'MATCHED');
    replaceSourceBytes(s, SRC3, HEX('e'));
    record('MR5 R2 Source bytes replaced', 'R2 not current -> the register is not current: QA09 not evaluated, nothing closed, every QA09 finding STALE (R1-only LBM too); REGISTER_NOT_CURRENT');
    retireReference(s, R2);
    declareRegister(s, { id: R3REF, sourceId: SRC3, pageNumber: 1, entries: [{ id: E_R3.A103, number: 'A-103' }] });
    record('MR6 R2 declared again from the new bytes (R3)', 'register EVALUABLE over R1 + R3: ANL S14 restated on another reference set -> new finding; LBM A-104 (R1 only) same evidence -> same finding');
    retireReference(s, R1);
    retireReference(s, R3REF);
    const qa09Before = s.ds.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === QA09).map((f) => findingCurrency(s, f));
    record('MR7 every reference withdrawn', `before the run: QA09 findings ${qa09Before.join(' / ')}; the run closes them NOT_REPRODUCED (R4 MD-2); QA09 NOT_EVALUABLE (NO_DECLARED_REGISTER), not a blocker`);
    return { steps, session: s };
}

// ---------------------------------------------------------------- vectors and invariants
const keyVectors = {
    'A-102': findingKey(QA01, null, [comparisonKey('A-102')]),
    '" A-102 " (trimmed)': findingKey(QA01, null, [comparisonKey(' A-102 ')]),
    '"A-102\\u3000" (ideographic space trimmed)': findingKey(QA01, null, [comparisonKey('A-102　')]),
    'A 102 (internal space kept)': findingKey(QA01, null, [comparisonKey('A 102')]),
    'A102': findingKey(QA01, null, [comparisonKey('A102')]),
    'Ａ－１０２ (full width: hint only, never the same key)': findingKey(QA01, null, [comparisonKey('Ａ－１０２')]),
};
const manifestVectors = {
    empty: manifestDigest({ sources: [] }),
    twoSourcesEitherOrder: [
        manifestDigest({ sources: [{ id: U(1), retiredAt: null, fingerprint: { sha256: HEX('a') } }, { id: U(2), retiredAt: null, fingerprint: { sha256: HEX('b') } }] }),
        manifestDigest({ sources: [{ id: U(2), retiredAt: null, fingerprint: { sha256: HEX('b') } }, { id: U(1), retiredAt: null, fingerprint: { sha256: HEX('a') } }] }),
    ],
};
export const invariants = {
    trimmedEqual: keyVectors['A-102'].hex === keyVectors['" A-102 " (trimmed)'].hex && keyVectors['A-102'].hex === keyVectors['"A-102\\u3000" (ideographic space trimmed)'].hex,
    internalSpaceKept: keyVectors['A 102 (internal space kept)'].hex !== keyVectors['A102'].hex,
    fullWidthDistinct: keyVectors['Ａ－１０２ (full width: hint only, never the same key)'].hex !== keyVectors['A-102'].hex,
    emptyArrayMatchesContract: sha('[]') === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    manifestEmptyMatchesContract: manifestVectors.empty === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    manifestTwoSourcesMatchesContract: manifestVectors.twoSourcesEitherOrder.every((h) => h === '8fdeea72a821499e08e043456eff0e02008b83fce8bad8905a34535e4727fed0'),
};
export { keyVectors, manifestVectors };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const r3 = scenarioR3Regression();
    const mr = scenarioMultiReference();
    process.stdout.write(`${JSON.stringify({
        what: 'CAN-03 R4 proposal vectors (not adopted)', generator: 'can03-r4-generator.mjs',
        contractBaseline: 'app main 2e33fcf3b80591b3567645f6749e8570e7dbb740 contracts/m7 (unchanged)',
        invariants, keyVectors, manifestVectors,
        scenarios: { r3Regression: r3.steps, multiReference: mr.steps },
        finalProjectFiles: { r3Regression: toProjectFile(r3.session), multiReference: toProjectFile(mr.session) },
    }, null, 1)}\n`);
}
