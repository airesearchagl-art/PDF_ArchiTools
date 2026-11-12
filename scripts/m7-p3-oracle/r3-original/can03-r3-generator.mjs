// CAN-03 R3 — proposal reference generator (NOT the adopted contract; contracts/m7 is unchanged).
// R3 = R2 + CAN-RF-01 / 02 / 03 (independent review counterexamples):
//   RF-01  a finding's currency follows its statement as the current state would make it (reason and
//          validity included): STALE when the run would no longer state it, or would state it on other evidence;
//   RF-02  a set-wide finding's evaluability (LISTED_BUT_MISSING) is derived from the current state every time
//          -- new Sheets, retired Sheets, Sheets no longer read, Sources no longer bound -- never stored;
//   RF-03  register entries with the same comparison key are one statement: every such live entry is cited, in
//          entryId order, so the order of the rows does not change the evidence.
//
// A pure, dependency-free model of the proposed D rules for QA01 / QA02 / QA09:
//   - QA input = value validity (basis comparisons) kept apart from Source binding (runtime ledger);
//   - findingKey / evidenceDigest byte derivations (UTF-8 JSON, no whitespace, SHA-256, lower-case hex);
//   - per-rule evaluation sets and closing conditions; a finding about an unevaluated subject is never closed;
//   - re-run: same key + same evidence -> same finding; same key + new evidence -> new finding, old SUPERSEDED;
//     evaluable and not stated -> NOT_REPRODUCED; not evaluable -> stays ACTIVE (currency derived);
//   - Decisions belong to one finding for life and are never carried to another.
//
//   node can03-r3-generator.mjs > can03-r3-vectors.json
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byFirst = (a, b) => cmp(a[0], b[0]);
/** comparisonKey: ECMAScript String.prototype.trim() only. Internal spaces kept; no width / case / dash folding. */
export const comparisonKey = (value) => value.trim();
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HEX = (c) => c.repeat(64);

// ---------------------------------------------------------------- byte derivations (R2-B1, R2-B2)
export function findingKey(ruleId, reason, parts) {
    const input = JSON.stringify(['m7.findingKey', 1, ruleId, reason, ...parts]);
    return { input, hex: sha(input) };
}
export function evidenceDigest({ ruleId, ruleVersion = 1, reason, basis, sheets, entries, extra }) {
    const input = JSON.stringify(['m7.evidenceDigest', 1, ruleId, ruleVersion, reason,
        [...basis].sort(byFirst), [...sheets].sort(byFirst), [...entries].sort(byFirst), extra]);
    return { input, hex: sha(input) };
}

// ---------------------------------------------------------------- QA input (R2-A)
// Validity of a record is decided by its basis only (fingerprint, profile revision); binding is a separate axis.
const validRecord = (record, sheet, set) => {
    if (!record) return false;
    const source = set.sources[sheet.sourceId];
    if (!source.live || record.sha !== source.sha) return false;
    if (record.profileRev === null) return true; // a confirmation typed with no profile: profile changes do not touch it
    return sheet.assignedRev === record.profileRev;
};
export function qaInput(sheet, set) {
    const confirmationValid = validRecord(sheet.confirmation, sheet, set);
    const observationValid = validRecord(sheet.observation, sheet, set);
    let origin = 'NONE';
    let value = null;
    if (confirmationValid) { origin = 'CONFIRMED'; value = sheet.confirmation.drawingNumber; }
    else if (observationValid && sheet.observation.status === 'READ') { origin = 'OBSERVED'; value = sheet.observation.drawingNumber; }
    // QA02's reason, by precedence. null: a valid confirmation stands, nothing to state.
    let qa02 = null;
    if (!confirmationValid) {
        if (sheet.confirmation) qa02 = 'RECONFIRM_REQUIRED';
        else if (!sheet.observation) qa02 = 'NOT_READ';
        else if (!observationValid) qa02 = 'READ_IS_STALE';
        else if (sheet.observation.status === 'OCR_FAILED') qa02 = 'OCR_FAILED';
        else qa02 = 'UNCONFIRMED';
    }
    return { origin, value, qa02, binding: set.sources[sheet.sourceId].binding };
}

// ---------------------------------------------------------------- one QA run over the set (R2-C)
const liveSheets = (set) => Object.values(set.sheets).filter((s) => s.live);
const registerState = (set) => {
    const refs = Object.values(set.registers).filter((r) => r.live);
    if (refs.length === 0) return { evaluable: false, why: 'NO_DECLARED_REGISTER' };
    const ref = refs[0];
    const source = set.sources[ref.sourceId];
    if (!source.live || source.sha !== ref.sha) return { evaluable: false, why: 'REGISTER_NOT_CURRENT', ref };
    return { evaluable: true, ref, entries: ref.entries.filter((e) => e.live) };
};

/**
 * R3 (RF-02): every live Sheet has a QA input and its Source is bound this session. Derived from the current
 * state each time it is asked -- never carried on a finding.
 */
export function setFullyEvaluable(set) {
    return liveSheets(set).every((s) => qaInput(s, set).origin !== 'NONE' && set.sources[s.sourceId].binding === 'MATCHED');
}

/** The statements a run makes now: { key, evidence, ruleId, reason, subjects, comparisonKey? }. One per key (R3). */
export function statements(set) {
    const out = [];
    const live = liveSheets(set);
    const input = Object.fromEntries(live.map((s) => [s.id, qaInput(s, set)]));
    const basisOf = (sheetIds, extraSources = []) => [...new Set([...sheetIds.map((id) => set.sheets[id].sourceId), ...extraSources])]
        .map((sid) => [sid, set.sources[sid].sha]);
    // QA02: every live Sheet is evaluated -- unread, OCR_FAILED and stale included.
    for (const s of live) {
        const q = input[s.id];
        if (!q.qa02) continue;
        out.push({
            ruleId: 'QA02_METADATA_UNCONFIRMED', reason: q.qa02, subjects: { sheets: [s.id], entries: [] },
            key: findingKey('QA02_METADATA_UNCONFIRMED', null, [s.id]),
            evidence: evidenceDigest({ ruleId: 'QA02_METADATA_UNCONFIRMED', reason: q.qa02, basis: basisOf([s.id]), sheets: [[s.id, q.origin, q.value]], entries: [], extra: null }),
        });
    }
    // QA01: evaluated = live Sheets with a QA input (origin != NONE) and a non-empty comparison key.
    const groups = new Map();
    for (const s of live) {
        const q = input[s.id];
        if (q.origin === 'NONE' || comparisonKey(q.value) === '') continue;
        const k = comparisonKey(q.value);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s.id);
    }
    for (const [k, ids] of groups) {
        if (ids.length < 2) continue;
        out.push({
            ruleId: 'QA01_DUPLICATE_NUMBER', reason: null, subjects: { sheets: ids, entries: [] }, comparisonKey: k,
            key: findingKey('QA01_DUPLICATE_NUMBER', null, [k]),
            evidence: evidenceDigest({ ruleId: 'QA01_DUPLICATE_NUMBER', reason: null, basis: basisOf(ids), sheets: ids.map((id) => [id, input[id].origin, input[id].value]), entries: [], extra: null }),
        });
    }
    // QA09: only against one current declared register.
    const reg = registerState(set);
    if (reg.evaluable) {
        const listed = new Set(reg.entries.map((e) => comparisonKey(e.drawingNumber)));
        const evaluated = live.filter((s) => input[s.id].origin !== 'NONE');
        const carried = new Set(evaluated.map((s) => comparisonKey(input[s.id].value)).filter((k) => k !== ''));
        const complete = evaluated.length === live.length;
        const extra = [reg.ref.id, reg.ref.sha];
        for (const s of evaluated) {
            const k = comparisonKey(input[s.id].value);
            if (k === '' || listed.has(k)) continue;
            out.push({
                ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'ACTUAL_NOT_LISTED', subjects: { sheets: [s.id], entries: [] },
                key: findingKey('QA09_REGISTER_SHEET_MISMATCH', 'ACTUAL_NOT_LISTED', [s.id]),
                evidence: evidenceDigest({ ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'ACTUAL_NOT_LISTED', basis: basisOf([s.id], [reg.ref.sourceId]), sheets: [[s.id, input[s.id].origin, input[s.id].value]], entries: [], extra }),
            });
        }
        // R3 (RF-03): one statement per comparison key, citing every live entry that lists it, in entryId order.
        const byKey = new Map();
        for (const e of reg.entries) {
            const k = comparisonKey(e.drawingNumber);
            if (carried.has(k)) continue;
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(e);
        }
        for (const [k, entries] of byKey) {
            const cited = [...entries].sort((a, b) => cmp(a.id, b.id));
            out.push({
                ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'LISTED_BUT_MISSING', subjects: { sheets: [], entries: cited.map((e) => e.id) }, comparisonKey: k,
                key: findingKey('QA09_REGISTER_SHEET_MISMATCH', 'LISTED_BUT_MISSING', [k]),
                evidence: evidenceDigest({ ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'LISTED_BUT_MISSING', basis: basisOf([], [reg.ref.sourceId]), sheets: [], entries: cited.map((e) => [e.id, reg.ref.id, e.drawingNumber]), extra }),
            });
        }
        void complete; // R3: completeness is derived at currency time (setFullyEvaluable), not carried on a statement
    }
    // R3 invariant: a run states each question once.
    const keys = out.map((st) => st.key.hex);
    if (new Set(keys).size !== keys.length) throw new Error('a run stated the same findingKey twice');
    return { out, input, reg, live };
}

/** Could this run evaluate the question an ACTIVE finding asks? (R2-C closing conditions.) */
function evaluable(finding, set, ctx) {
    const sheetLive = (id) => set.sheets[id]?.live === true;
    const read = (id) => sheetLive(id) && ctx.input[id].origin !== 'NONE';
    switch (finding.ruleId) {
        case 'QA02_METADATA_UNCONFIRMED':
            return true; // every live Sheet is evaluated; a retired subject is evaluated as gone (proposal, H-R2-5)
        case 'QA01_DUPLICATE_NUMBER':
            // every Sheet it cites was read in this run (a retired one counts as evaluated: it is gone)
            return finding.subjects.sheets.every((id) => !sheetLive(id) || read(id));
        case 'QA09_REGISTER_SHEET_MISMATCH':
            if (!ctx.reg.evaluable) return false;
            if (finding.reason === 'ACTUAL_NOT_LISTED') return finding.subjects.sheets.every((id) => !sheetLive(id) || read(id));
            // LISTED_BUT_MISSING: found on a read Sheet, or every live Sheet read, or no live entry lists it any more
            {
                const k = finding.comparisonKey;
                const found = ctx.live.some((s) => read(s.id) && comparisonKey(ctx.input[s.id].value) === k);
                const allRead = ctx.live.every((s) => read(s.id));
                const stillListed = ctx.reg.entries.some((e) => comparisonKey(e.drawingNumber) === k);
                return found || allRead || !stillListed;
            }
        default:
            return false;
    }
}

let findingCounter = 100;
let runCounter = 900;
/** Restart the ids this model mints (for scenarios that need their own numbering). */
export function resetIds(finding = 100, run = 900) { findingCounter = finding; runCounter = run; }
/** One QA run: the findings after it (append-only; lifecycle is the only change to an old finding). */
export function runQa(set, findings) {
    const runId = U(++runCounter);
    const ctx = statements(set);
    const next = findings.map((f) => ({ ...f }));
    const active = (key) => next.find((f) => f.lifecycle === 'ACTIVE' && f.key.hex === key);
    const stated = new Set();
    for (const st of ctx.out) {
        stated.add(st.key.hex);
        const prior = active(st.key.hex);
        if (prior && prior.evidence.hex === st.evidence.hex) continue; // same finding: nothing written
        const created = { id: U(++findingCounter), runId, ...st, lifecycle: 'ACTIVE', supersededBy: null, closedByRunId: null };
        if (prior) { prior.lifecycle = 'SUPERSEDED'; prior.supersededBy = created.id; prior.closedByRunId = runId; }
        next.push(created);
    }
    for (const f of next) {
        if (f.lifecycle !== 'ACTIVE' || stated.has(f.key.hex) || f.runId === runId) continue;
        if (evaluable(f, set, ctx)) { f.lifecycle = 'NOT_REPRODUCED'; f.closedByRunId = runId; }
    }
    return { runId, findings: next, ctx };
}

/**
 * Derived, never stored (R3-D). `set` is the current state; nothing a finding carries but its statement is used.
 *   STALE       a cited fingerprint moved, a cited subject or Source retired, (QA09) no current register, or --
 *               RF-01 -- the run would now not state this key, or would state it on other evidence (reason,
 *               validity, origin, value or cited entries changed);
 *   UNVERIFIED  a cited Source is not bound this session, or -- RF-02 -- a set-wide finding (LISTED_BUT_MISSING)
 *               while the set is not fully evaluable now (setFullyEvaluable);
 *   CURRENT     otherwise.
 */
export function findingCurrency(f, set) {
    if (f.lifecycle !== 'ACTIVE') return 'HISTORICAL';
    const now = statements(set);
    const parsed = JSON.parse(f.evidence.input);
    const basis = parsed[5];
    const subjectRetired = f.subjects.sheets.some((id) => !set.sheets[id]?.live)
        || f.subjects.entries.some((id) => !Object.values(set.registers).some((r) => r.live && r.entries.some((e) => e.id === id && e.live)));
    const basisMoved = basis.some(([sid, h]) => !set.sources[sid]?.live || set.sources[sid].sha !== h);
    const registerGone = f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && !now.reg.evaluable;
    const restated = now.out.find((st) => st.key.hex === f.key.hex) ?? null;
    if (subjectRetired || basisMoved || registerGone || !restated || restated.evidence.hex !== f.evidence.hex) return 'STALE';
    const unbound = basis.some(([sid]) => set.sources[sid].binding !== 'MATCHED');
    const setWide = f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && f.reason === 'LISTED_BUT_MISSING';
    if (unbound || (setWide && !setFullyEvaluable(set))) return 'UNVERIFIED';
    return 'CURRENT';
}

// ---------------------------------------------------------------- scenario
const clone = (x) => JSON.parse(JSON.stringify(x));
const SRC1 = U(1), SRC2 = U(2), SH11 = U(11), SH12 = U(12), SH13 = U(13), REG = U(20), E21 = U(21), E22 = U(22);
const base = {
    sources: { [SRC1]: { sha: HEX('a'), live: true, binding: 'MATCHED' }, [SRC2]: { sha: HEX('b'), live: true, binding: 'MATCHED' } },
    sheets: {
        [SH11]: { id: SH11, sourceId: SRC1, live: true, assignedRev: 1, confirmation: { drawingNumber: 'A-102', sha: HEX('a'), profileRev: 1, confirmedAt: '2026-10-25T00:00:00Z' }, observation: { drawingNumber: 'A-102', status: 'READ', sha: HEX('a'), profileRev: 1, runId: U(801) } },
        [SH12]: { id: SH12, sourceId: SRC2, live: true, assignedRev: 1, confirmation: null, observation: { drawingNumber: ' A-102', status: 'READ', sha: HEX('b'), profileRev: 1, runId: U(802) } },
        [SH13]: { id: SH13, sourceId: SRC2, live: true, assignedRev: 1, confirmation: null, observation: null },
    },
    registers: {},
};
const decisions = [];
const decide = (finding, outcome) => {
    const seq = decisions.filter((d) => d.findingId === finding.id).length + 1;
    decisions.push({ findingId: finding.id, sequence: seq, outcome, evidenceDigest: finding.evidence.hex });
};
const effective = (finding) => decisions.filter((d) => d.findingId === finding.id).at(-1)?.outcome ?? null;

// The 13-step scenario of R2, unchanged (the regression), run only when this file is run directly.
export function scenario() {
resetIds();
decisions.length = 0;
const steps = [];
let set = clone(base);
let findings = [];
const record = (name, note) => {
    const r = runQa(set, findings);
    findings = r.findings;
    steps.push({
        step: steps.length + 1, name, note,
        findings: findings.map((f) => ({
            id: f.id, ruleId: f.ruleId, reason: f.reason, lifecycle: f.lifecycle, supersededBy: f.supersededBy,
            currency: findingCurrency(f, set), findingKey: f.key.hex, evidenceDigest: f.evidence.hex,
            keyInput: f.key.input, evidenceInput: f.evidence.input, effectiveDecision: effective(f),
            decisions: decisions.filter((d) => d.findingId === f.id),
        })),
        register: r.ctx.reg.evaluable ? 'EVALUABLE' : r.ctx.reg.why,
    });
    return r;
};
const of = (rule, reason = null, k = null) => findings.find((f) => f.lifecycle === 'ACTIVE' && f.ruleId === rule && (reason === null || f.reason === reason) && (k === null || f.comparisonKey === k || f.subjects.sheets.includes(k)));

// 1. QA01 A-102 on S11 (confirmed) and S12 (observed, ' A-102'); QA02 for S12 (UNCONFIRMED) and S13 (NOT_READ).
record('1 initial', 'QA01 on A-102 (confirmed + observed); QA02 S12 UNCONFIRMED, S13 NOT_READ; no register: QA09 not evaluated');
decide(of('QA01_DUPLICATE_NUMBER'), 'INTENTIONAL');
decide(of('QA02_METADATA_UNCONFIRMED', 'UNCONFIRMED'), 'HOLD');
// 2. S11 re-confirmed with the same value (new confirmedAt): same evidence -> same finding, decision stands.
set.sheets[SH11].confirmation.confirmedAt = '2026-10-25T01:00:00Z';
record('2 re-confirm same value', 'confirmedAt is not evidence: same QA01 finding, INTENTIONAL stands');
// 3. S12 re-extracted with the same value (new runId): same evidence, decisions stand.
set.sheets[SH12].observation.runId = U(803);
record('3 same-value re-extraction', 'runId is not evidence: same QA01 / QA02 findings, decisions stand');
// 4. S12 confirmed as ' A-102': QA01 evidence changes (OBSERVED -> CONFIRMED) -> new finding, old SUPERSEDED, no decision; QA02 S12 closed.
set.sheets[SH12].confirmation = { drawingNumber: ' A-102', sha: HEX('b'), profileRev: 1, confirmedAt: '2026-10-25T02:00:00Z' };
record('4 S12 confirmed', 'QA01 superseded (decision stays with the old finding); QA02 S12 NOT_REPRODUCED');
// 5. S12's confirmation withdrawn: back to OBSERVED -> evidence as in step 1, but a NEW finding (decisions are never carried).
set.sheets[SH12].confirmation = null;
record('5 S12 confirmation withdrawn', 'QA01 superseded again; its evidence equals step 1\'s, but it is a new finding with no decision; QA02 S12 UNCONFIRMED again (new finding)');
// 6. S12's profile revised: its observation is stale -> S12 not read for QA01 -> the QA01 finding is NOT closed; currency STALE.
set.sheets[SH12].assignedRev = 2;
record('6 S12 profile revised', 'S12 has no QA input: QA01 not evaluable for it, finding stays ACTIVE and STALE; QA02 S12 READ_IS_STALE supersedes UNCONFIRMED');
// 7. S12 read again under r2 as 'A-102': QA01 restated with new evidence -> supersede; QA02 S12 UNCONFIRMED.
set.sheets[SH12].observation = { drawingNumber: 'A-102', status: 'READ', sha: HEX('b'), profileRev: 2, runId: U(804) };
record('7 S12 re-read under r2', 'QA01 restated on new evidence (value no longer has the leading space) -> superseded');
// 8. A register declared on Source 1: A-102, A-104. S13 still unread -> LISTED_BUT_MISSING A-104 UNVERIFIED (set incomplete).
set.registers[REG] = { id: REG, sourceId: SRC1, sha: HEX('a'), live: true, entries: [{ id: E21, drawingNumber: 'A-102', live: true }, { id: E22, drawingNumber: 'A-104', live: true }] };
record('8 register declared', 'QA09 LISTED_BUT_MISSING A-104 stated, UNVERIFIED (S13 unread); no ACTUAL_NOT_LISTED');
// 9. S13 read: OCR_FAILED -> still unread for QA09; QA02 S13 OCR_FAILED supersedes NOT_READ.
set.sheets[SH13].observation = { drawingNumber: '', status: 'OCR_FAILED', sha: HEX('b'), profileRev: 1, runId: U(805) };
record('9 S13 OCR_FAILED', 'QA02 S13 OCR_FAILED supersedes NOT_READ; QA09 A-104 stays UNVERIFIED');
// 10. S13 read again as 'A-105' (observed): A-104 still missing, now with every Sheet read -> same key, same evidence -> CURRENT; ACTUAL_NOT_LISTED S13 (observed).
set.sheets[SH13].observation = { drawingNumber: 'A-105', status: 'READ', sha: HEX('b'), profileRev: 1, runId: U(806) };
record('10 S13 read A-105', 'QA09 A-104 same finding, now CURRENT; ACTUAL_NOT_LISTED S13 stated on an observed value');
decide(of('QA09_REGISTER_SHEET_MISMATCH', 'ACTUAL_NOT_LISTED'), 'ACTION_REQUIRED');
// 11. S13 confirmed as 'A-104': A-104 now carried -> LISTED_BUT_MISSING NOT_REPRODUCED; ACTUAL_NOT_LISTED S13 NOT_REPRODUCED.
set.sheets[SH13].confirmation = { drawingNumber: 'A-104', sha: HEX('b'), profileRev: 1, confirmedAt: '2026-10-25T03:00:00Z' };
record('11 S13 confirmed A-104', 'both QA09 findings NOT_REPRODUCED (evaluated, no longer stated)');
// 12. The register's Source replaced (new bytes): register not current -> QA09 not evaluated; nothing closed; a QA09 finding would be STALE.
set.sources[SRC1].sha = HEX('c');
record('12 register Source replaced', 'QA09 not evaluable (REGISTER_NOT_CURRENT); S11 confirmation stale too -> QA01 not evaluable for S11, QA02 S11 RECONFIRM_REQUIRED');
// 13. Source 2 not bound this session: values still valid (basis unchanged) -> findings citing it are UNVERIFIED, not STALE.
set.sources[SRC2].binding = 'UNVERIFIED';
record('13 Source 2 unbound', 'validity and binding apart: QA02 findings on Source 2 sheets UNVERIFIED');

return steps;
}

const keyVectors = {
    'A-102': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey('A-102')]),
    '" A-102 " (trimmed)': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey(' A-102 ')]),
    '"A-102\\u3000" (ideographic space trimmed)': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey('A-102　')]),
    'A 102 (internal space kept)': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey('A 102')]),
    'A102': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey('A102')]),
    'Ａ－１０２ (full width: hint only, never the same key)': findingKey('QA01_DUPLICATE_NUMBER', null, [comparisonKey('Ａ－１０２')]),
};
const invariants = {
    trimmedEqual: keyVectors['A-102'].hex === keyVectors['" A-102 " (trimmed)'].hex && keyVectors['A-102'].hex === keyVectors['"A-102\\u3000" (ideographic space trimmed)'].hex,
    internalSpaceKept: keyVectors['A 102 (internal space kept)'].hex !== keyVectors['A102'].hex,
    fullWidthDistinct: keyVectors['Ａ－１０２ (full width: hint only, never the same key)'].hex !== keyVectors['A-102'].hex,
    emptyArrayMatchesContract: sha('[]') === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
};
export { keyVectors, invariants, U, HEX, clone };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const steps = scenario();
    process.stdout.write(`${JSON.stringify({ what: 'CAN-03 R3 proposal vectors (not adopted)', generator: 'can03-r3-generator.mjs', invariants, keyVectors, steps }, null, 1)}\n`);
}
