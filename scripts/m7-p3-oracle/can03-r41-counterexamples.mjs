// CAN-03 R4.1 -- counterexamples. Two groups, each case stating its expectation before it runs.
//
// The 24 R4 cases (CX-RF01..03, CX-R4-01..17), unchanged apart from the model they run on. Each is built once on
// the schema-shaped model and run on:
//   R41 the R4.1 generator;
//   R3  the R3 generator (r3-original/, byte-identical to the R3 review pack) through toR3(), which maps the
//       schema-shaped state onto R3's simplified model exactly as R3 sees it -- assignedRev is the revision NUMBER
//       of the assigned profile (no profile id), one value (drawingNumber) per record, and the registers in the
//       file's order (R3 takes the first live one).
// A case with no R3 counterpart (readiness, decisions) reports R3 as n/a. can03-r41-regression.mjs checks that
// every R41 and R3 result here equals the R4 pack's recorded result.
//
// The R4.1 limit cases (CX-R41-01..), RF-01 of the R4 design review: at and one past each bound a QA run or a
// Review Decision writes to. Each is run on:
//   R41 the R4.1 generator;
//   R4  the R4 generator (r4-original/, byte-identical to the R4 review pack), to reproduce RF-01.
// R3 has no schema-shaped state, so it is n/a. The fixtures are built with the R4.1 helpers -- plain data, the
// same for both models. A fixture that pads history (runs, Findings, Decisions) builds a state the contract check
// proves valid before anything is asked of it.
//
//   node can03-r41-counterexamples.mjs > can03-r41-counterexamples.json      (exit 1 if R4.1 fails any case)
import { pathToFileURL } from 'node:url';
import * as R41 from './can03-r41-generator.mjs';
import * as R4 from './r4-original/can03-r4-generator.mjs';
import * as R3 from './r3-original/can03-r3-generator.mjs';

const { U, HEX, V } = R41;
const QA01 = 'QA01_DUPLICATE_NUMBER', QA02 = 'QA02_METADATA_UNCONFIRMED', QA09 = 'QA09_REGISTER_SHEET_MISMATCH';
const SRC1 = U(1), SRC2 = U(2), SRC3 = U(3), S11 = U(11), S12 = U(12), S13 = U(13), S14 = U(14);
const P1 = U(31), P2 = U(32), REG = U(20), R1 = U(20), R2 = U(40);
const E21 = U(21), E22 = U(22), E23 = U(23), E41 = U(41), E42 = U(42);

// ---------------------------------------------------------------- R3 adapter (the R3 view of a schema-shaped state)
export function toR3(s) {
    const { ds } = s;
    const profile = (id) => ds.titleBlockProfiles.find((p) => p.id === id);
    return {
        sources: Object.fromEntries(ds.sources.map((x) => [x.id, { sha: x.fingerprint.sha256, live: x.retiredAt === null, binding: s.bindings[x.id] === 'MATCHED' ? 'MATCHED' : 'UNVERIFIED' }])),
        sheets: Object.fromEntries(ds.sheets.map((sh) => [sh.id, {
            id: sh.id, sourceId: sh.sourceId, live: sh.retiredAt === null,
            assignedRev: sh.profileAssignment ? profile(sh.profileAssignment.profileId).revision : null,
            confirmation: sh.confirmation ? { drawingNumber: sh.confirmation.values.drawingNumber, sha: sh.confirmation.sourceSha256, profileRev: sh.confirmation.profile ? sh.confirmation.profile.profileRevision : null, confirmedAt: sh.confirmation.confirmedAt } : null,
            observation: sh.observation ? { drawingNumber: sh.observation.fields.drawingNumber.value, status: sh.observation.status, sha: sh.observation.sourceSha256, profileRev: sh.observation.profile.profileRevision, runId: sh.observation.runId } : null,
        }])),
        registers: Object.fromEntries(ds.drawingRegisterReferences.map((r) => [r.id, {
            id: r.id, sourceId: r.sourceId, sha: r.sourceSha256, live: r.retiredAt === null,
            entries: r.entries.map((e) => ({ id: e.id, drawingNumber: e.drawingNumber, live: e.retiredAt === null })),
        }])),
    };
}

// ---------------------------------------------------------------- one driver over both models
class Dual {
    constructor(s) { this.s = s; this.f3 = []; R3.resetIds(); this.decided3 = new Map(); }
    qa() {
        const r = R41.runQa(this.s);
        if (!r.ok) throw new Error(`QA run refused: ${JSON.stringify(r.exceeded)}`);
        this.f3 = R3.runQa(toR3(this.s), this.f3).findings;
    }
    list(model) {
        if (model === 'R41') {
            return this.s.ds.findings.map((f) => ({
                id: f.id, ruleId: f.ruleId, reason: f.params.reason ?? null, lifecycle: f.lifecycle.state, key: f.findingKey, evidence: f.evidenceDigest,
                currency: R41.findingCurrency(this.s, f), sheets: f.sheetIds, entries: f.registerEntryIds, comparisonKey: f.params.comparisonKey ?? null,
                basisSources: f.basis.map((b) => b.sourceId), decision: R41.effectiveDecision(this.s, f),
            }));
        }
        const set = toR3(this.s);
        return this.f3.map((f) => ({
            id: f.id, ruleId: f.ruleId, reason: f.reason, lifecycle: f.lifecycle, key: f.key.hex, evidence: f.evidence.hex,
            currency: R3.findingCurrency(f, set), sheets: f.subjects.sheets, entries: f.subjects.entries, comparisonKey: f.comparisonKey ?? null,
            basisSources: JSON.parse(f.evidence.input)[5].map((b) => b[0]), decision: this.decided3.get(f.id) ?? null,
        }));
    }
    active(model, rule, reason) { return this.list(model).filter((f) => f.lifecycle === 'ACTIVE' && f.ruleId === rule && (reason === undefined || f.reason === reason)); }
    /** R4 appends a Decision (its own rules apply); R3 has no Decision API, so the decision is pinned to its finding id. */
    decide(model, finding, outcome) {
        if (model === 'R41') return R41.decide(this.s, finding.id, outcome);
        this.decided3.set(finding.id, outcome);
        return { ok: true };
    }
    register(model) {
        if (model === 'R41') return R41.registerState(this.s.ds).state;
        const reg = R3.statements(toR3(this.s)).reg;
        return reg.evaluable ? 'EVALUABLE' : reg.why === 'NO_DECLARED_REGISTER' ? 'NONE' : 'NOT_CURRENT';
    }
    qaInputReason(model, sheetId) {
        if (model === 'R41') return R41.qaInput(this.s.ds, this.s.ds.sheets.find((x) => x.id === sheetId)).qa02;
        const set = toR3(this.s);
        return R3.qaInput(set.sheets[sheetId], set).qa02;
    }
    origin(model, sheetId) {
        if (model === 'R41') return R41.qaInput(this.s.ds, this.s.ds.sheets.find((x) => x.id === sheetId)).origin;
        const set = toR3(this.s);
        return R3.qaInput(set.sheets[sheetId], set).origin;
    }
}

/**
 * The R4.1 sessions the contract check reads (not printed): the final R4.1 state of each case, and, for a limit
 * case, every labelled state it records (the state before it asks anything, the state a refusal leaves, ...).
 */
export const finalSessions = new Map();
const runModel = (model, build, run, id) => {
    const d = new Dual(build());
    let got;
    try { got = run(model, d); } catch (error) { got = { error: String(error && error.message ? error.message : error) }; }
    if (model === 'R41') finalSessions.set(id, d.s);
    return got;
};
export const cases = [];
function addCase({ id, title, contract, expected, build, run, r4Only = false }) {
    const got = { R41: runModel('R41', build, run, id) };
    if (!r4Only) got.R3 = runModel('R3', build, run, id);
    const pass = (g) => JSON.stringify(g) === JSON.stringify(expected);
    cases.push({
        id, title, contract, expected,
        r3: r4Only ? { pass: null, got: 'n/a (R3 defines no such operation)' } : { pass: pass(got.R3), got: got.R3 },
        r41: { pass: pass(got.R41), got: got.R41 },
    });
}

// ---------------------------------------------------------------- builders
function base({ sources = [[SRC1, 'a', 3], [SRC2, 'b', 3]], profiles = [P1] } = {}) {
    const s = R41.newSession();
    for (const [id, c, pages] of sources) R41.addSource(s, { id, sha256: HEX(c), pageCount: pages });
    for (const id of profiles) R41.addProfile(s, { id });
    return s;
}
const sheet = (s, id, sourceId, pageNumber, profileId = P1) => R41.addSheet(s, { id, sourceId, pageNumber, profileId });
const confirmed = (s, id, values) => { R41.read(s, id, values); R41.confirm(s, id, values); };

// ---------------------------------------------------------------- R3's seven cases, in the schema's shape
for (const variant of ['a', 'b']) {
    addCase({
        id: `CX-RF01-${variant}`, contract: 'R3-D (kept)',
        title: variant === 'a' ? 'QA02 OCR_FAILED, then the profile revised (reason now READ_IS_STALE)' : 'QA02 NOT_READ, then read and OCR_FAILED (reason now OCR_FAILED)',
        expected: { statedReason: variant === 'a' ? 'OCR_FAILED' : 'NOT_READ', nowReason: variant === 'a' ? 'READ_IS_STALE' : 'OCR_FAILED', currencyBeforeRerun: 'STALE' },
        build: () => {
            const s = base();
            sheet(s, S11, SRC1, 1);
            if (variant === 'a') R41.read(s, S11, null, { status: 'OCR_FAILED' });
            return s;
        },
        run: (m, d) => {
            d.qa();
            const stated = d.active(m, QA02)[0];
            if (variant === 'a') R41.reviseProfile(d.s, P1); else R41.read(d.s, S11, null, { status: 'OCR_FAILED' });
            const now = d.list(m).find((f) => f.id === stated.id);
            return { statedReason: stated.reason, nowReason: d.qaInputReason(m, S11), currencyBeforeRerun: now.currency };
        },
    });
}
function registerSet({ unreadS13 = false } = {}) {
    const s = base({ profiles: [P1, P2] });
    sheet(s, S11, SRC1, 1, P1);
    sheet(s, S12, SRC2, 1, P2); // R3 revises S12's profile alone: S12 has its own
    confirmed(s, S11, V('A-102', '配置図', 'A', '2026/10/01'));
    R41.read(s, S12, V('A-103', '平面図', 'A', '2026/10/01'));
    if (unreadS13) sheet(s, S13, SRC2, 2, P1);
    R41.declareRegister(s, { id: REG, sourceId: SRC1, entries: [{ id: E21, number: 'A-102' }, { id: E22, number: 'A-103' }, { id: E23, number: 'A-104' }] });
    return s;
}
for (const variant of ['added', 'unread', 'unbound', 'retire']) {
    const titles = {
        added: 'all Sheets read, LISTED_BUT_MISSING A-104; then an unread Sheet added',
        unread: 'all Sheets read, LISTED_BUT_MISSING A-104; then a read Sheet no longer read (its profile revised)',
        unbound: 'all Sheets read, LISTED_BUT_MISSING A-104; then a Sheet\'s Source no longer bound this session',
        retire: 'one Sheet unread, LISTED_BUT_MISSING A-104 UNVERIFIED; then that unread Sheet retired (every live Sheet now read)',
    };
    const after = variant === 'retire' ? 'CURRENT' : 'UNVERIFIED';
    addCase({
        id: `CX-RF02-${variant}`, contract: 'R3-D (kept)', title: titles[variant],
        expected: { startCurrency: variant === 'retire' ? 'UNVERIFIED' : 'CURRENT', currencyBeforeRerun: after, currencyAfterRerun: after },
        build: () => registerSet({ unreadS13: variant === 'retire' }),
        run: (m, d) => {
            d.qa();
            const lbm = d.active(m, QA09, 'LISTED_BUT_MISSING').find((f) => f.comparisonKey === 'A-104' || f.entries.includes(E23));
            const startCurrency = lbm.currency;
            if (variant === 'added') sheet(d.s, S14, SRC2, 3, P1);
            else if (variant === 'unread') R41.reviseProfile(d.s, P2);
            else if (variant === 'unbound') R41.setBinding(d.s, SRC2, 'MISSING');
            else R41.retireSheet(d.s, S13);
            const currencyBeforeRerun = d.list(m).find((f) => f.id === lbm.id).currency;
            d.qa();
            const again = d.active(m, QA09, 'LISTED_BUT_MISSING').filter((f) => f.key === lbm.key);
            return { startCurrency, currencyBeforeRerun, currencyAfterRerun: again.length === 1 ? again[0].currency : `ACTIVE x${again.length}` };
        },
    });
}
addCase({
    id: 'CX-RF03', contract: 'R3-C (kept)', title: 'two register rows list A-104; the run repeated with only their order reversed',
    expected: { activeAfterFirst: 1, citedEntriesFirst: [E22, E23], findingsAfterReorder: 1, sameFindingAfterReorder: true, sameEvidenceAfterReorder: true },
    build: () => {
        const s = base();
        sheet(s, S11, SRC1, 1);
        confirmed(s, S11, V('A-102', '配置図', 'A', '2026/10/01'));
        R41.declareRegister(s, { id: REG, sourceId: SRC1, entries: [{ id: E21, number: 'A-102' }, { id: E22, number: 'A-104' }, { id: E23, number: 'A-104' }] });
        return s;
    },
    run: (m, d) => {
        d.qa();
        const first = d.active(m, QA09, 'LISTED_BUT_MISSING');
        const ref = d.s.ds.drawingRegisterReferences[0];
        ref.entries = [ref.entries[0], ref.entries[2], ref.entries[1]];
        ref.entries.forEach((e, i) => { e.row = i + 1; });
        d.qa();
        const second = d.active(m, QA09, 'LISTED_BUT_MISSING');
        return {
            activeAfterFirst: first.length, citedEntriesFirst: first.length === 1 ? first[0].entries : first.map((f) => f.entries),
            findingsAfterReorder: d.list(m).filter((f) => f.ruleId === QA09 && f.reason === 'LISTED_BUT_MISSING').length,
            sameFindingAfterReorder: first.length === 1 && second.length === 1 && first[0].id === second[0].id,
            sameEvidenceAfterReorder: first.length === 1 && second.length === 1 && first[0].evidence === second[0].evidence,
        };
    },
});

// ---------------------------------------------------------------- R4: several references (§E), A1
const statementsOf = (m, d) => d.active(m, QA09).map((f) => (f.reason === 'ACTUAL_NOT_LISTED' ? `ANL:${f.sheets[0].slice(-2)}` : `LBM:${f.comparisonKey}`)).sort();
addCase({
    id: 'CX-R4-01', contract: '§E all live entries together', title: 'one register over two references (R1: A-101, A-102 / R2: A-103); every Sheet is listed',
    expected: { register: 'EVALUABLE', qa09Active: [] },
    build: () => {
        const s = base({ sources: [[SRC1, 'a', 3], [SRC3, 'd', 1]] });
        sheet(s, S11, SRC1, 1); sheet(s, S12, SRC1, 2); sheet(s, S13, SRC1, 3);
        confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-102')); confirmed(s, S13, V('A-103'));
        R41.declareRegister(s, { id: R1, sourceId: SRC1, entries: [{ id: E21, number: 'A-101' }, { id: E22, number: 'A-102' }] });
        R41.declareRegister(s, { id: R2, sourceId: SRC3, entries: [{ id: E41, number: 'A-103' }] });
        return s;
    },
    run: (m, d) => { d.qa(); return { register: d.register(m), qa09Active: statementsOf(m, d) }; },
});
function twoRefs(order) {
    const s = base({ sources: [[SRC1, 'a', 3], [SRC3, 'd', 1]] });
    sheet(s, S11, SRC1, 1); sheet(s, S12, SRC1, 2); sheet(s, S13, SRC1, 3);
    confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-102')); confirmed(s, S13, V('A-103'));
    const r1 = () => R41.declareRegister(s, { id: R1, sourceId: SRC1, entries: [{ id: E21, number: 'A-101' }, { id: E22, number: 'A-104' }] });
    const r2 = () => R41.declareRegister(s, { id: R2, sourceId: SRC3, entries: [{ id: E41, number: 'A-102' }, { id: E42, number: 'A-105' }] });
    if (order === 'R1,R2') { r1(); r2(); } else { r2(); r1(); }
    return s;
}
addCase({
    id: 'CX-R4-02', contract: '§E; order independence', title: 'the same two references declared in either order (R1: A-101, A-104 / R2: A-102, A-105; Sheets A-101..A-103)',
    expected: { statementsR1First: ['ANL:13', 'LBM:A-104', 'LBM:A-105'], sameKeysAndEvidenceEitherOrder: true },
    build: () => twoRefs('R1,R2'),
    run: (m, d) => {
        d.qa();
        const a = d.active(m, QA09);
        const other = new Dual(twoRefs('R2,R1'));
        other.qa();
        const b = other.active(m, QA09);
        const sig = (list) => list.map((f) => `${f.key}:${f.evidence}`).sort();
        return { statementsR1First: statementsOf(m, d), sameKeysAndEvidenceEitherOrder: JSON.stringify(sig(a)) === JSON.stringify(sig(b)) };
    },
});
function dupRefs() {
    const s = base({ sources: [[SRC1, 'a', 3], [SRC3, 'd', 1]] });
    sheet(s, S11, SRC1, 1);
    confirmed(s, S11, V('A-101'));
    R41.declareRegister(s, { id: R1, sourceId: SRC1, entries: [{ id: E21, number: 'A-101' }, { id: E22, number: 'A-104' }] });
    R41.declareRegister(s, { id: R2, sourceId: SRC3, entries: [{ id: E41, number: 'A-104' }] });
    return s;
}
addCase({
    id: 'CX-R4-03', contract: '§E + MD-1', title: 'A-104 listed in R1 and in R2, carried by no Sheet',
    expected: { lbm: 1, cited: [E22, E41], basisSources: [SRC1, SRC3] },
    build: dupRefs,
    run: (m, d) => { d.qa(); const l = d.active(m, QA09, 'LISTED_BUT_MISSING'); return { lbm: l.length, cited: l[0]?.entries ?? null, basisSources: l[0]?.basisSources ?? null }; },
});
addCase({
    id: 'CX-R4-04', contract: '§E + R3-C partial retire', title: 'from CX-R4-03 with INTENTIONAL on the LBM: R2 withdrawn (retired)',
    expected: { currencyBeforeRerun: 'STALE', activeAfterRerun: 1, citedAfterRerun: [E22], newFinding: true, decisionCarried: false, oldDecisionKept: 'INTENTIONAL' },
    build: dupRefs,
    run: (m, d) => {
        d.qa();
        const lbm = d.active(m, QA09, 'LISTED_BUT_MISSING')[0];
        d.decide(m, lbm, 'INTENTIONAL');
        R41.retireReference(d.s, R2);
        const currencyBeforeRerun = d.list(m).find((f) => f.id === lbm.id).currency;
        d.qa();
        const after = d.active(m, QA09, 'LISTED_BUT_MISSING');
        const old = d.list(m).find((f) => f.id === lbm.id);
        return {
            currencyBeforeRerun, activeAfterRerun: after.length, citedAfterRerun: after[0]?.entries ?? null, newFinding: after[0]?.id !== lbm.id,
            decisionCarried: after[0]?.decision === 'INTENTIONAL', oldDecisionKept: old.decision,
        };
    },
});
function staleSet() {
    const s = base({ sources: [[SRC1, 'a', 3], [SRC3, 'd', 1]] });
    sheet(s, S11, SRC1, 1); sheet(s, S12, SRC1, 2); sheet(s, S13, SRC1, 3);
    confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-102')); confirmed(s, S13, V('A-103'));
    R41.declareRegister(s, { id: R1, sourceId: SRC1, entries: [{ id: E21, number: 'A-101' }, { id: E22, number: 'A-104' }] });
    R41.declareRegister(s, { id: R2, sourceId: SRC3, entries: [{ id: E41, number: 'A-102' }] });
    return s;
}
addCase({
    id: 'CX-R4-05', contract: '§E + §J REGISTER_NOT_CURRENT', title: 'R2\'s Source bytes replaced (R1 still current): ANL S13 and LBM A-104 (R1 only) were stated',
    expected: { statementsBefore: ['ANL:13', 'LBM:A-104'], register: 'NOT_CURRENT', currenciesBeforeRerun: ['STALE', 'STALE'], closedByRerun: 0, activeAfterRerun: ['ANL:13', 'LBM:A-104'] },
    build: staleSet,
    run: (m, d) => {
        d.qa();
        const statementsBefore = statementsOf(m, d);
        R41.replaceSourceBytes(d.s, SRC3, HEX('e'));
        const currenciesBeforeRerun = d.active(m, QA09).map((f) => f.currency);
        const count = (state) => d.list(m).filter((f) => f.ruleId === QA09 && f.lifecycle === state).length;
        const closedBefore = count('NOT_REPRODUCED') + count('SUPERSEDED');
        d.qa();
        return { statementsBefore, register: d.register(m), currenciesBeforeRerun, closedByRerun: count('NOT_REPRODUCED') + count('SUPERSEDED') - closedBefore, activeAfterRerun: statementsOf(m, d) };
    },
});
addCase({
    id: 'CX-R4-06', contract: '§E + R3-A (validity and binding apart)', title: 'R2\'s Source not bound this session (bytes unchanged)',
    expected: { register: 'EVALUABLE', statements: ['ANL:13', 'LBM:A-104'], anlCurrency: 'UNVERIFIED', lbmCurrency: 'CURRENT' },
    build: staleSet,
    run: (m, d) => {
        R41.setBinding(d.s, SRC3, 'MISSING');
        d.qa();
        const anl = d.active(m, QA09, 'ACTUAL_NOT_LISTED').find((f) => f.sheets.includes(S13));
        const lbm = d.active(m, QA09, 'LISTED_BUT_MISSING').find((f) => f.comparisonKey === 'A-104' || f.entries.includes(E22));
        return { register: d.register(m), statements: statementsOf(m, d), anlCurrency: anl?.currency ?? null, lbmCurrency: lbm?.currency ?? null };
    },
});
addCase({
    id: 'CX-R4-07', contract: 'MD-2 (new: Human adoption needed)', title: 'every reference withdrawn after ANL and LBM were stated and decided',
    expected: { currenciesBeforeRerun: ['STALE', 'STALE'], lifecyclesAfterRerun: ['NOT_REPRODUCED', 'NOT_REPRODUCED'], activeQa09AfterRerun: 0, decisionsKept: ['ACTION_REQUIRED', 'INTENTIONAL'], register: 'NONE' },
    build: () => {
        const s = base();
        sheet(s, S11, SRC1, 1); sheet(s, S12, SRC1, 2);
        confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-103'));
        R41.declareRegister(s, { id: R1, sourceId: SRC1, entries: [{ id: E21, number: 'A-101' }, { id: E22, number: 'A-104' }] });
        return s;
    },
    run: (m, d) => {
        d.qa();
        const anl = d.active(m, QA09, 'ACTUAL_NOT_LISTED')[0];
        const lbm = d.active(m, QA09, 'LISTED_BUT_MISSING')[0];
        d.decide(m, anl, 'ACTION_REQUIRED');
        d.decide(m, lbm, 'INTENTIONAL');
        R41.retireReference(d.s, R1);
        const currenciesBeforeRerun = [anl, lbm].map((f) => d.list(m).find((x) => x.id === f.id).currency);
        d.qa();
        const now = [anl, lbm].map((f) => d.list(m).find((x) => x.id === f.id));
        return { currenciesBeforeRerun, lifecyclesAfterRerun: now.map((f) => f.lifecycle), activeQa09AfterRerun: d.active(m, QA09).length, decisionsKept: now.map((f) => f.decision), register: d.register(m) };
    },
});

// ---------------------------------------------------------------- R4: product data (profile, metadata), A2
addCase({
    id: 'CX-R4-08', contract: '§C / §D / §I (profile id, not only the revision number)', title: 'S11 read under P1 r1, then assigned to P2 -- also at revision 1',
    expected: { originAfter: 'NONE', qa02ReasonAfter: 'READ_IS_STALE', qa01CurrencyBeforeRerun: 'STALE', qa01AfterRerun: 'ACTIVE/STALE', qa02AfterRerun: 'READ_IS_STALE' },
    build: () => {
        const s = base({ profiles: [P1, P2] });
        sheet(s, S11, SRC1, 1, P1); sheet(s, S12, SRC1, 2, P1);
        R41.read(s, S11, V('A-101', '配置図', 'A', '2026/10/01'));
        confirmed(s, S12, V('A-101', '平面図', 'A', '2026/10/01'));
        return s;
    },
    run: (m, d) => {
        d.qa();
        const qa01 = d.active(m, QA01)[0];
        R41.assignProfile(d.s, S11, P2);
        const qa01CurrencyBeforeRerun = d.list(m).find((f) => f.id === qa01.id).currency;
        const originAfter = d.origin(m, S11);
        const qa02ReasonAfter = d.qaInputReason(m, S11);
        d.qa();
        const again = d.list(m).find((f) => f.id === qa01.id);
        const qa02 = d.active(m, QA02).find((f) => f.sheets.includes(S11));
        return { originAfter, qa02ReasonAfter, qa01CurrencyBeforeRerun, qa01AfterRerun: `${again.lifecycle}/${again.currency}`, qa02AfterRerun: qa02?.reason ?? null };
    },
});
addCase({
    id: 'CX-R4-09', contract: '§C / §D manual confirmation (profile: null) -- kept', title: 'S11 confirmed by hand (no profile), then its profile revised and unassigned',
    expected: { originAfter: 'CONFIRMED', qa02ForS11: 0, qa01: 'ACTIVE/CURRENT', sameQa01Finding: true },
    build: () => {
        const s = base({ profiles: [P1, P2] });
        sheet(s, S11, SRC1, 1, P1); sheet(s, S12, SRC1, 2, P2);
        R41.confirm(s, S11, V('A-101', '配置図', 'A', '2026/10/01'), { basis: 'manual' });
        confirmed(s, S12, V('A-101', '平面図', 'A', '2026/10/01'));
        return s;
    },
    run: (m, d) => {
        d.qa();
        const qa01 = d.active(m, QA01)[0];
        R41.reviseProfile(d.s, P1);
        R41.assignProfile(d.s, S11, null);
        d.qa();
        const now = d.active(m, QA01)[0];
        return { originAfter: d.origin(m, S11), qa02ForS11: d.active(m, QA02).filter((f) => f.sheets.includes(S11)).length, qa01: `${now.lifecycle}/${now.currency}`, sameQa01Finding: now.id === qa01.id };
    },
});
addCase({
    id: 'CX-R4-10', contract: '§H / §J: an INTENTIONAL exemption does not outlive its evidence (four values)', title: 'QA02 UNCONFIRMED decided INTENTIONAL; S11 re-read under the same profile revision, only the title differs',
    expected: { currencyBeforeRerun: 'STALE', newFinding: true, decisionCarried: false },
    build: () => {
        const s = base();
        sheet(s, S11, SRC1, 1);
        R41.read(s, S11, V('A-101', '配置図', 'A', '2026/10/01'));
        return s;
    },
    run: (m, d) => {
        d.qa();
        const qa02 = d.active(m, QA02)[0];
        d.decide(m, qa02, 'INTENTIONAL');
        R41.read(d.s, S11, V('A-101', '配置図（改）', 'A', '2026/10/01'));
        const currencyBeforeRerun = d.list(m).find((f) => f.id === qa02.id).currency;
        d.qa();
        const now = d.active(m, QA02)[0];
        return { currencyBeforeRerun, newFinding: now.id !== qa02.id, decisionCarried: now.decision === 'INTENTIONAL' };
    },
});
addCase({
    id: 'CX-R4-11', contract: '§E + R3-C: order of every collection', title: 'MR start state; sources, profiles, sheets, references and rows reversed (rows renumbered)',
    expected: { sameStatements: true, newFindingsAfterReorderedRerun: 0 },
    build: () => R41.mrStart(),
    run: (m, d) => {
        d.qa();
        const sig = () => d.active(m, QA09).concat(d.active(m, QA02), d.active(m, QA01)).map((f) => `${f.key}:${f.evidence}:${f.sheets}:${f.entries}:${f.basisSources}`).sort();
        const before = sig();
        const count = d.list(m).length;
        const ds = d.s.ds;
        ds.sources.reverse(); ds.titleBlockProfiles.reverse(); ds.sheets.reverse(); ds.drawingRegisterReferences.reverse();
        for (const r of ds.drawingRegisterReferences) { r.entries.reverse(); r.entries.forEach((e, i) => { e.row = i + 1; }); }
        d.qa();
        return { sameStatements: JSON.stringify(sig()) === JSON.stringify(before), newFindingsAfterReorderedRerun: d.list(m).length - count };
    },
});

// ---------------------------------------------------------------- R4: readiness and decisions, A3 (no R3 counterpart)
const ALL = { implementedRules: R41.ALL_RULES }; // assumes every rule implemented: tests the blocker logic only
const codes = (r) => r.blockers.map((b) => b.code);
const literalJ = (r) => codes(r).filter((c) => R41.J_BLOCKERS.includes(c));
addCase({
    id: 'CX-R4-12', r4Only: true, contract: 'MD-3 QA_RESULT_NOT_CURRENT (new)', title: 'clean and run; then S12 re-confirmed as a duplicate of S11 with no QA run since',
    expected: { before: { blockers: [], status: 'READY' }, after: { literalJBlockers: [], blockers: ['QA_RESULT_NOT_CURRENT'], status: 'BLOCKED' } },
    build: () => {
        const s = base();
        sheet(s, S11, SRC1, 1); sheet(s, S12, SRC1, 2);
        confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-102'));
        return s;
    },
    run: (m, d) => {
        d.qa();
        const a = R41.readiness(d.s, ALL);
        R41.confirm(d.s, S12, V('A-101'));
        const b = R41.readiness(d.s, ALL);
        return { before: { blockers: codes(a), status: a.status }, after: { literalJBlockers: literalJ(b), blockers: codes(b), status: b.status } };
    },
});
addCase({
    id: 'CX-R4-13', r4Only: true, contract: 'MD-3', title: 'every Sheet confirmed, no register, and no QA run yet',
    expected: { literalJBlockers: [], blockers: ['QA_RESULT_NOT_CURRENT'], subjects: ['NO_QA_RUN'], status: 'BLOCKED' },
    build: () => { const s = base(); sheet(s, S11, SRC1, 1); confirmed(s, S11, V('A-101')); return s; },
    run: (m, d) => { const r = R41.readiness(d.s, ALL); return { literalJBlockers: literalJ(r), blockers: codes(r), subjects: r.blockers[0]?.subjects ?? [], status: r.status }; },
});
addCase({
    id: 'CX-R4-14', r4Only: true, contract: 'H2 P3 first scope: never READY, never a Final QA Report', title: 'a clean, fully run state read in the P3 first scope (QA01 / 02 / 09 only)',
    expected: {
        status: 'FINAL_UNAVAILABLE', blockers: [],
        notEvaluated: ['QA01B_DUPLICATE_NUMBER_VARIANT:NOT_IMPLEMENTED', 'QA03_NUMBER_GAP:NOT_IMPLEMENTED', 'QA04_SAME_NUMBER_DIFFERENT_TITLE:NOT_IMPLEMENTED', 'QA05_REVISION_MISMATCH:NOT_IMPLEMENTED', 'QA06_ISSUE_DATE_MISMATCH:NOT_IMPLEMENTED', 'QA07_SHEET_SIZE_OUTLIER:NOT_IMPLEMENTED', 'QA08_ORIENTATION_OUTLIER:NOT_IMPLEMENTED', 'QA10_INTEGRITY:NOT_IMPLEMENTED', 'QA09_REGISTER_SHEET_MISMATCH:NO_DECLARED_REGISTER'],
    },
    build: () => { const s = base(); sheet(s, S11, SRC1, 1); confirmed(s, S11, V('A-101')); return s; },
    run: (m, d) => { d.qa(); const r = R41.readiness(d.s); return { status: r.status, blockers: codes(r), notEvaluated: r.notEvaluated.map((n) => `${n.ruleId}:${n.why}`) }; },
});
addCase({
    id: 'CX-R4-15', r4Only: true, contract: '§J QA02 exemption is INTENTIONAL only (kept); HOLD blocks', title: 'four QA02 findings decided INTENTIONAL / FALSE_POSITIVE / HOLD / ACTION_REQUIRED; then S11 re-read with another title',
    expected: { unconfirmed: [S12, S13, S14], onHold: 1, afterStale: { unconfirmed: [S11, S12, S13, S14], findingsNotCurrent: 1 } },
    build: () => {
        const s = base({ sources: [[SRC1, 'a', 4], [SRC2, 'b', 3]] });
        [S11, S12, S13, S14].forEach((id, i) => { sheet(s, id, SRC1, i + 1); R41.read(s, id, V(`A-10${i + 1}`, '図', 'A', '2026/10/01')); });
        return s;
    },
    run: (m, d) => {
        d.qa();
        const outcomes = { [S11]: 'INTENTIONAL', [S12]: 'FALSE_POSITIVE', [S13]: 'HOLD', [S14]: 'ACTION_REQUIRED' };
        for (const f of d.active(m, QA02)) d.decide(m, f, outcomes[f.sheets[0]]);
        const r = R41.readiness(d.s, ALL);
        const get = (x, code) => x.blockers.find((b) => b.code === code)?.subjects ?? [];
        R41.read(d.s, S11, V('A-101', '別の図', 'A', '2026/10/01'));
        const r2 = R41.readiness(d.s, ALL);
        return { unconfirmed: get(r, 'METADATA_NOT_CONFIRMED'), onHold: get(r, 'FINDINGS_ON_HOLD').length, afterStale: { unconfirmed: get(r2, 'METADATA_NOT_CONFIRMED'), findingsNotCurrent: get(r2, 'FINDINGS_NOT_CURRENT').length } };
    },
});
addCase({
    id: 'CX-R4-16', r4Only: true, contract: 'MD-4 Decision only on an ACTIVE, CURRENT Finding (new); sequence 1..n', title: 'decide on CURRENT (twice), SUPERSEDED, STALE and UNVERIFIED findings',
    expected: { current: ['ok:1', 'ok:2'], superseded: 'FINDING_NOT_ACTIVE', stale: 'FINDING_NOT_CURRENT', unverified: 'FINDING_NOT_CURRENT' },
    build: () => { const s = base(); sheet(s, S11, SRC1, 1); sheet(s, S12, SRC2, 1); R41.read(s, S11, V('A-101')); R41.read(s, S12, V('A-102')); return s; },
    run: (m, d) => {
        d.qa();
        const [f11, f12] = [S11, S12].map((id) => d.active(m, QA02).find((f) => f.sheets.includes(id)));
        const one = R41.decide(d.s, f11.id, 'HOLD');
        const two = R41.decide(d.s, f11.id, 'ACTION_REQUIRED');
        R41.read(d.s, S11, V('A-101', '改'));
        const stale = R41.decide(d.s, f11.id, 'INTENTIONAL');
        d.qa();
        const superseded = R41.decide(d.s, f11.id, 'INTENTIONAL');
        R41.setBinding(d.s, SRC2, 'MISSING');
        const unverified = R41.decide(d.s, f12.id, 'INTENTIONAL');
        return { current: [one, two].map((r) => (r.ok ? `ok:${r.decision.sequence}` : r.refusal)), superseded: superseded.refusal ?? 'ok', stale: stale.refusal ?? 'ok', unverified: unverified.refusal ?? 'ok' };
    },
});
addCase({
    id: 'CX-R4-17', contract: 'R4-I: decided from stored fields only (no key / evidence input, no comparisonKey outside params)', title: 'the R3 13-step session saved and read back as JSON, runtime diagnostics dropped',
    expected: { sameCurrencies: true, sameReadiness: true },
    build: () => R41.scenarioR3Regression().session,
    run: (m, d) => {
        const stored = JSON.parse(JSON.stringify(d.s.ds));
        if (m === 'R41') {
            const fresh = { ...R41.cloneSession(d.s), ds: stored, aux: {} };
            const a = d.s.ds.findings.map((f) => R41.findingCurrency(d.s, f));
            const b = fresh.ds.findings.map((f) => R41.findingCurrency(fresh, f));
            return { sameCurrencies: JSON.stringify(a) === JSON.stringify(b), sameReadiness: JSON.stringify(R41.readiness(d.s)) === JSON.stringify(R41.readiness(fresh)) };
        }
        // R3 asked to decide from what a file stores: no evidence.input, no comparisonKey outside params.
        const set = toR3(d.s);
        const r3Findings = stored.findings.map((f) => ({
            id: f.id, ruleId: f.ruleId, reason: f.params.reason ?? null, lifecycle: f.lifecycle.state,
            subjects: { sheets: f.sheetIds, entries: f.registerEntryIds }, key: { hex: f.findingKey }, evidence: { hex: f.evidenceDigest },
        }));
        r3Findings.map((f) => R3.findingCurrency(f, set));
        return { sameCurrencies: true, sameReadiness: 'n/a' };
    },
});

// ---------------------------------------------------------------- R4.1-L: limits and atomicity (RF-01; R4.1 vs R4)
const LIM = R41.LIMITS;
/** The whole session: stored state, runtime bindings and diagnostics, clock and id counters. */
const snap = (s) => R41.sha(JSON.stringify(s));
const counts = (s) => ({ runs: s.ds.analysisRuns.length, findings: s.ds.findings.length, decisions: s.ds.decisions.length });
/** A refusal's bounds, without the findingKey hex (the comparisonKey names the statement). */
const brief = (exceeded) => exceeded.map(({ findingKey, ...rest }) => rest);
/** What a model does with one QA run. R4 has no refusal, so a result with no `ok` is an accepted run. */
const qaOn = (M, s) => { const r = M.runQa(s); return { ok: r.ok ?? true, refusal: r.refusal ?? null, exceeded: brief(r.exceeded ?? []) }; };
const predicted = (M, s) => (M.qaRefusal ? brief(M.qaRefusal(s)) : 'n/a (no prediction in this model)');
/** Every bounded collection a QA run or a Decision writes to, against LIMITS (the contract check runs the schema itself). */
const withinLimits = (s) => s.ds.analysisRuns.length <= LIM.maxAnalysisRuns && s.ds.findings.length <= LIM.maxFindings
    && s.ds.decisions.length <= LIM.maxDecisions && s.ds.findings.every((f) => f.sheetIds.length <= LIM.maxSubjectsPerFinding
        && f.registerEntryIds.length <= LIM.maxSubjectsPerFinding && f.sourceIds.length <= LIM.maxSources && f.basis.length <= LIM.maxSources);
const readinessView = (M, s) => {
    const r = M.readiness(s, { implementedRules: M.ALL_RULES });
    return { status: r.status, blockers: codes(r), qaResultNotCurrent: (r.blockers.find((b) => b.code === 'QA_RESULT_NOT_CURRENT')?.subjects ?? []).map((x) => x.split(':')[0]) };
};
const lifecycles = (s) => s.ds.findings.map((f) => `${f.id}:${f.lifecycle.state}`);
const activeOf = (s, rule, reason) => s.ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === rule && (reason === undefined || f.params.reason === reason));

/** Labelled R4.1 states of the limit cases, for the contract check (not printed). */
export const limitStates = new Map();
function addLimitCase({ id, title, contract, expected, build, run }) {
    const got = {};
    for (const [name, M] of [['R41', R41], ['R4', R4]]) {
        const s = build();
        const keep = (label) => { if (name === 'R41') limitStates.set(`${id} ${label}`, R41.cloneSession(s)); };
        try { got[name] = run(M, s, keep); } catch (error) { got[name] = { error: String(error && error.message ? error.message : error) }; }
    }
    const verdict = (g) => {
        const differs = Object.keys(expected).filter((k) => JSON.stringify(g[k]) !== JSON.stringify(expected[k]));
        return { pass: differs.length === 0 && !('error' in g), differs };
    };
    cases.push({
        id, title, contract, expected,
        r3: { pass: null, got: 'n/a (R3 has no schema-shaped state)' },
        r41: { ...verdict(got.R41), got: got.R41 },
        r4: { ...verdict(got.R4), got: got.R4 },
    });
}

// Register pages on SRC3 (a list-only Source with room for 64 pages), 1000 rows each, every row naming `number`.
const REFL = (r) => U(70000 + r);
const ENTRY = (r, j) => U(100000 + r * 1000 + j);
function declareSameNumber(s, n, { firstRef = 0, number = 'A-900' } = {}) {
    for (let r = firstRef, left = n; left > 0; r += 1) {
        const rows = Math.min(1000, left);
        R41.declareRegister(s, { id: REFL(r), sourceId: SRC3, pageNumber: r + 1, entries: Array.from({ length: rows }, (_, j) => ({ id: ENTRY(r, j), number })) });
        left -= rows;
    }
}
const LIMIT_SOURCES = [[SRC1, 'a', 3], [SRC2, 'b', 3], [SRC3, 'd', 64]];
/** S11 confirmed A-101 (not listed); n live Entries, all A-900 (carried by no Sheet): one LBM citing all n (MD-1). */
function subjectsFixture(n, { history = false } = {}) {
    const s = base({ sources: LIMIT_SOURCES });
    sheet(s, S11, SRC1, 1);
    confirmed(s, S11, V('A-101'));
    if (history) { sheet(s, S12, SRC2, 1); R41.read(s, S12, V('A-102')); }
    declareSameNumber(s, n);
    return s;
}
/** S11 / S12 confirmed A-101 / A-102, then QA runs that change nothing until the set holds `target` runs. */
function runsFixture(target) {
    const s = base({ sources: LIMIT_SOURCES });
    sheet(s, S11, SRC1, 1); sheet(s, S12, SRC2, 1);
    confirmed(s, S11, V('A-101')); confirmed(s, S12, V('A-102'));
    while (s.ds.analysisRuns.length < target) if (!R41.runQa(s).ok) throw new Error('padding run refused');
    return s;
}
/**
 * 10 Sources x 100 never-read Sheets (+1 Sheet on an 11th Source when `plusOne`): every Sheet states QA02 NOT_READ
 * on its Source's bytes, so replacing a Source's bytes restates its 100 Sheets on new evidence (100 new Findings,
 * 100 superseded). One run, 48 rounds over all 10 Sources and one over Sources 1..9: 49900 (+1) Findings, 50 runs,
 * at most 49 replacements per Source (maxFingerprintHistoryPerSource 64).
 */
const BULK = Array.from({ length: 10 }, (_, i) => U(200 + i));
const bytesOf = (i, round) => R41.sha(`CX-R41 bulk source ${i} round ${round}`);
function findingsFixture({ plusOne = false } = {}) {
    const s = R41.newSession({ counters: { finding: 3000000 } }); // 50000 Finding ids clear of the Source and Sheet ids
    BULK.forEach((id, i) => R41.addSource(s, { id, sha256: bytesOf(i, 0), pageCount: 100 }));
    BULK.forEach((id, i) => { for (let p = 0; p < 100; p += 1) R41.addSheet(s, { id: U(10000 + i * 100 + p), sourceId: id, pageNumber: p + 1 }); });
    if (plusOne) { R41.addSource(s, { id: U(299), sha256: bytesOf(10, 0), pageCount: 1 }); R41.addSheet(s, { id: U(19999), sourceId: U(299), pageNumber: 1 }); }
    const qa = () => { if (!R41.runQa(s).ok) throw new Error('padding run refused'); };
    qa();
    for (let round = 1; round <= 49; round += 1) {
        BULK.forEach((id, i) => { if (round <= 48 || i >= 1) R41.replaceSourceBytes(s, id, bytesOf(i, round)); });
        qa();
    }
    return s;
}
/** S11 / S12 read, not confirmed: QA02 on each. `n` earlier Decisions on S11's QA02 (sequence 1..n), as history. */
function decisionsFixture(n) {
    const s = base();
    sheet(s, S11, SRC1, 1); sheet(s, S12, SRC2, 1);
    R41.read(s, S11, V('A-101')); R41.read(s, S12, V('A-102'));
    if (!R41.runQa(s).ok) throw new Error('fixture run refused');
    const fA = activeOf(s, QA02);
    const at = new Date(s.t).toISOString();
    for (let i = 1; i <= n; i += 1) s.ds.decisions.push({ id: U(1000000 + i), findingId: fA.id, sequence: i, outcome: 'HOLD', comment: '', decidedAt: at, evidenceDigest: fA.evidenceDigest });
    return s;
}
const LBM_EXCESS = (planned) => ({ limit: 'maxSubjectsPerFinding', max: 5000, planned, at: 'finding.registerEntryIds', ruleId: QA09, reason: 'LISTED_BUT_MISSING', comparisonKey: 'A-900' });
const ACCEPTED = { ok: true, refusal: null, exceeded: [] };
const REFUSED = (...exceeded) => ({ ok: false, refusal: 'QA_LIMIT_EXCEEDED', exceeded });

/** Asks one QA run, recording what a refusal must leave untouched (readiness skipped on the 1000-Sheet fixtures: time only). */
function attempt(M, s, keep, { withReadiness = true } = {}) {
    keep('start');
    const view = () => (withReadiness ? JSON.stringify(readinessView(M, s)) : 'not computed');
    const before = { snap: snap(s), counts: counts(s), lifecycles: lifecycles(s), decisions: JSON.stringify(s.ds.decisions), readiness: view() };
    const prediction = predicted(M, s);
    const result = qaOn(M, s);
    if (result.ok) keep('after');
    return {
        result, prediction, before,
        out: {
            sessionUnchanged: snap(s) === before.snap,
            lifecyclesUnchanged: JSON.stringify(lifecycles(s)) === JSON.stringify(before.lifecycles),
            decisionsUnchanged: JSON.stringify(s.ds.decisions) === before.decisions,
            readinessUnchanged: view() === before.readiness,
        },
    };
}

addLimitCase({
    id: 'CX-R41-01', contract: 'R4.1-L maxSubjectsPerFinding, at the bound', title: '5000 live Entries over five references all name A-900: the run states one LBM citing all 5000',
    expected: { result: ACCEPTED, lbmSubjects: 5000, before: { runs: 1, findings: 0, decisions: 0 }, after: { runs: 2, findings: 2, decisions: 0 }, withinLimits: true },
    build: () => subjectsFixture(5000),
    run: (M, s, keep) => {
        const a = attempt(M, s, keep);
        return { result: a.result, lbmSubjects: activeOf(s, QA09, 'LISTED_BUT_MISSING')?.registerEntryIds.length ?? null, before: a.before.counts, after: counts(s), withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-02', contract: 'R4.1-L maxSubjectsPerFinding, one past: refused, nothing written', title: '5001 live Entries name A-900 (a sixth reference with one row); no QA run yet',
    expected: {
        result: REFUSED(LBM_EXCESS(5001)), prediction: [LBM_EXCESS(5001)], before: { runs: 1, findings: 0, decisions: 0 }, after: { runs: 1, findings: 0, decisions: 0 },
        sessionUnchanged: true, readinessUnchanged: true, readinessAfter: { status: 'BLOCKED', blockers: ['QA_RESULT_NOT_CURRENT'], qaResultNotCurrent: ['NO_QA_RUN'] }, withinLimits: true,
    },
    build: () => subjectsFixture(5001),
    run: (M, s, keep) => {
        const a = attempt(M, s, keep);
        return {
            result: a.result, prediction: a.prediction, before: a.before.counts, after: counts(s),
            sessionUnchanged: a.out.sessionUnchanged, readinessUnchanged: a.out.readinessUnchanged, readinessAfter: readinessView(M, s), withinLimits: withinLimits(s),
        };
    },
});
addLimitCase({
    id: 'CX-R41-03', contract: 'R4.1-L atomic refusal over existing history; MD-1 unchanged, nothing truncated', title: '5000 A-900 rows stated and decided (LBM INTENTIONAL, QA02 S12 HOLD, ANL S11 ACTION_REQUIRED); then S12 confirmed and a 5001st A-900 row added; then that row\'s reference withdrawn',
    expected: {
        first: ACCEPTED, decided: ['ok', 'ok', 'ok'],
        refused: REFUSED(LBM_EXCESS(5001)), predictionEqualsRefusal: true,
        sessionUnchanged: true, lifecyclesUnchanged: true, decisionsUnchanged: true, readinessUnchanged: true,
        recovered: { result: ACCEPTED, lbmSameFinding: true, lbmSubjects: 5000, lbmDecision: 'INTENTIONAL', qa02S12: 'NOT_REPRODUCED', qa02S12Decision: 'HOLD' },
        withinLimits: true,
    },
    build: () => subjectsFixture(5000, { history: true }),
    run: (M, s, keep) => {
        const first = qaOn(M, s);
        const lbm = activeOf(s, QA09, 'LISTED_BUT_MISSING');
        const qa02 = activeOf(s, QA02);
        const anl = s.ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.params.reason === 'ACTUAL_NOT_LISTED' && f.sheetIds[0] === S11);
        const decided = [[lbm, 'INTENTIONAL'], [qa02, 'HOLD'], [anl, 'ACTION_REQUIRED']].map(([f, o]) => (M.decide(s, f.id, o).ok ? 'ok' : 'refused'));
        R41.confirm(s, S12, V('A-102')); // would close QA02 S12 and restate ANL S12
        declareSameNumber(s, 1, { firstRef: 5 }); // would restate the LBM citing 5001
        const a = attempt(M, s, keep);
        R41.retireReference(s, REFL(5));
        const again = qaOn(M, s);
        keep('recovered');
        const lbmNow = activeOf(s, QA09, 'LISTED_BUT_MISSING');
        const qa02Now = s.ds.findings.find((f) => f.id === qa02.id);
        return {
            first, decided, refused: a.result, predictionEqualsRefusal: JSON.stringify(a.prediction) === JSON.stringify(a.result.exceeded),
            sessionUnchanged: a.out.sessionUnchanged, lifecyclesUnchanged: a.out.lifecyclesUnchanged, decisionsUnchanged: a.out.decisionsUnchanged, readinessUnchanged: a.out.readinessUnchanged,
            recovered: {
                result: again, lbmSameFinding: lbmNow?.id === lbm.id, lbmSubjects: lbmNow?.registerEntryIds.length ?? null, lbmDecision: lbmNow ? M.effectiveDecision(s, lbmNow) : null,
                qa02S12: qa02Now.lifecycle.state, qa02S12Decision: M.effectiveDecision(s, qa02Now),
            },
            withinLimits: withinLimits(s),
        };
    },
});
addLimitCase({
    id: 'CX-R41-04', contract: 'R4.1-L maxAnalysisRuns, at the bound', title: '1999 runs (EXTRACTION and QA together); S12 re-confirmed as A-101; the run that makes 2000 states QA01',
    expected: { result: ACCEPTED, before: { runs: 1999, findings: 0, decisions: 0 }, after: { runs: 2000, findings: 1, decisions: 0 }, withinLimits: true },
    build: () => runsFixture(1999),
    run: (M, s, keep) => {
        R41.confirm(s, S12, V('A-101'));
        const a = attempt(M, s, keep);
        return { result: a.result, before: a.before.counts, after: counts(s), withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-05', contract: 'R4.1-L maxAnalysisRuns, one past: refused, nothing written; a refusal is not a completed run', title: '2000 runs; S12 re-confirmed as A-101 (a QA01 to state)',
    expected: {
        result: REFUSED({ limit: 'maxAnalysisRuns', max: 2000, planned: 2001, at: 'drawingSet.analysisRuns' }), prediction: [{ limit: 'maxAnalysisRuns', max: 2000, planned: 2001, at: 'drawingSet.analysisRuns' }],
        before: { runs: 2000, findings: 0, decisions: 0 }, after: { runs: 2000, findings: 0, decisions: 0 }, sessionUnchanged: true, readinessUnchanged: true,
        readinessAfter: { status: 'BLOCKED', blockers: ['QA_RESULT_NOT_CURRENT'], qaResultNotCurrent: ['UNSTATED'] }, withinLimits: true,
    },
    build: () => runsFixture(2000),
    run: (M, s, keep) => {
        R41.confirm(s, S12, V('A-101'));
        const a = attempt(M, s, keep);
        return {
            result: a.result, prediction: a.prediction, before: a.before.counts, after: counts(s), sessionUnchanged: a.out.sessionUnchanged, readinessUnchanged: a.out.readinessUnchanged,
            readinessAfter: readinessView(M, s), withinLimits: withinLimits(s),
        };
    },
});
addLimitCase({
    id: 'CX-R41-06', contract: 'R4.1-L maxFindings, at the bound (SUPERSEDED / NOT_REPRODUCED Findings count: none is deleted)', title: '49900 Findings; Source 0\'s bytes replaced, so the run writes 100 new Findings',
    expected: { result: ACCEPTED, before: { runs: 50, findings: 49900, decisions: 0 }, after: { runs: 51, findings: 50000, decisions: 0 }, newFindings: 100, withinLimits: true },
    build: () => findingsFixture(),
    run: (M, s, keep) => {
        R41.replaceSourceBytes(s, BULK[0], bytesOf(0, 49));
        const a = attempt(M, s, keep, { withReadiness: false });
        return { result: a.result, before: a.before.counts, after: counts(s), newFindings: counts(s).findings - a.before.counts.findings, withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-07', contract: 'R4.1-L maxFindings, one past: refused as a whole (no part of the 100 is written)', title: '49901 Findings; Source 0\'s bytes replaced (100 new Findings planned)',
    expected: {
        result: REFUSED({ limit: 'maxFindings', max: 50000, planned: 50001, at: 'drawingSet.findings' }), before: { runs: 50, findings: 49901, decisions: 0 }, after: { runs: 50, findings: 49901, decisions: 0 },
        sessionUnchanged: true, lifecyclesUnchanged: true, withinLimits: true,
    },
    build: () => findingsFixture({ plusOne: true }),
    run: (M, s, keep) => {
        R41.replaceSourceBytes(s, BULK[0], bytesOf(0, 49));
        const a = attempt(M, s, keep, { withReadiness: false });
        return { result: a.result, before: a.before.counts, after: counts(s), sessionUnchanged: a.out.sessionUnchanged, lifecyclesUnchanged: a.out.lifecyclesUnchanged, withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-08', contract: 'R4.1-L maxFindings counts additions only: at the bound a run that only closes is accepted', title: 'CX-R41-06\'s 50000 Findings; one Sheet retired, so the run closes its QA02 and writes nothing new',
    expected: { result: ACCEPTED, before: { runs: 51, findings: 50000, decisions: 0 }, after: { runs: 52, findings: 50000, decisions: 0 }, closed: 1, withinLimits: true },
    build: () => {
        const s = findingsFixture();
        R41.replaceSourceBytes(s, BULK[0], bytesOf(0, 49));
        if (!R41.runQa(s).ok) throw new Error('fixture run refused');
        return s;
    },
    run: (M, s, keep) => {
        R41.retireSheet(s, U(10000));
        const notReproduced = () => s.ds.findings.filter((f) => f.lifecycle.state === 'NOT_REPRODUCED').length;
        const closedBefore = notReproduced();
        const a = attempt(M, s, keep, { withReadiness: false });
        return { result: a.result, before: a.before.counts, after: counts(s), closed: notReproduced() - closedBefore, withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-09', contract: 'R4.1-L every bound past is reported, in a fixed order', title: '2000 runs and 5001 A-900 rows at once',
    expected: { result: REFUSED({ limit: 'maxAnalysisRuns', max: 2000, planned: 2001, at: 'drawingSet.analysisRuns' }, LBM_EXCESS(5001)), sessionUnchanged: true, withinLimits: true },
    build: () => { const s = runsFixture(2000); declareSameNumber(s, 5001); return s; },
    run: (M, s, keep) => { const a = attempt(M, s, keep); return { result: a.result, sessionUnchanged: a.out.sessionUnchanged, withinLimits: withinLimits(s) }; },
});
const decideOn = (M, s, outcome) => {
    const fB = s.ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.sheetIds[0] === S12);
    const r = M.decide(s, fB.id, outcome);
    return { ok: r.ok, refusal: r.refusal ?? null, exceeded: r.exceeded ?? [], sequence: r.ok ? r.decision.sequence : null };
};
addLimitCase({
    id: 'CX-R41-10', contract: 'R4.1-L maxDecisions, at the bound', title: '99999 earlier Decisions (on S11\'s QA02); a first Decision on S12\'s QA02',
    expected: { decision: { ok: true, refusal: null, exceeded: [], sequence: 1 }, before: { runs: 3, findings: 2, decisions: 99999 }, after: { runs: 3, findings: 2, decisions: 100000 }, withinLimits: true },
    build: () => decisionsFixture(99999),
    run: (M, s, keep) => {
        keep('start');
        const before = counts(s);
        const decision = decideOn(M, s, 'ACTION_REQUIRED');
        keep('after');
        return { decision, before, after: counts(s), withinLimits: withinLimits(s) };
    },
});
addLimitCase({
    id: 'CX-R41-11', contract: 'R4.1-L maxDecisions, one past: refused, nothing written', title: '100000 earlier Decisions; a first Decision on S12\'s QA02 (its sequence would only be 1)',
    expected: {
        decision: { ok: false, refusal: 'DECISION_LIMIT_EXCEEDED', exceeded: [{ limit: 'maxDecisions', max: 100000, planned: 100001, at: 'drawingSet.decisions' }], sequence: null },
        before: { runs: 3, findings: 2, decisions: 100000 }, after: { runs: 3, findings: 2, decisions: 100000 }, sessionUnchanged: true, withinLimits: true,
    },
    build: () => decisionsFixture(100000),
    run: (M, s, keep) => {
        keep('start');
        const before = counts(s);
        const was = snap(s);
        const decision = decideOn(M, s, 'ACTION_REQUIRED');
        return { decision, before, after: counts(s), sessionUnchanged: snap(s) === was, withinLimits: withinLimits(s) };
    },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const limit = cases.filter((c) => c.id.startsWith('CX-R41-'));
    process.stdout.write(`${JSON.stringify({
        what: 'CAN-03 R4.1 counterexamples: the 24 R4 cases on R4.1 and R3 (through toR3); the limit cases on R4.1 and R4',
        totals: {
            r4Cases: { count: cases.length - limit.length, r41Pass: cases.filter((c) => !c.id.startsWith('CX-R41-') && c.r41.pass).length },
            limitCases: { count: limit.length, r41Pass: limit.filter((c) => c.r41.pass).length, r4Pass: limit.filter((c) => c.r4.pass).length },
        },
        summary: cases.map((c) => ({ id: c.id, contract: c.contract, title: c.title, r41: c.r41.pass, r3: c.r3.pass, ...(c.r4 ? { r4: c.r4.pass, r4Differs: c.r4.differs } : {}) })),
        cases,
    }, null, 1)}\n`);
    process.exitCode = cases.every((c) => c.r41.pass) ? 0 : 1;
}
