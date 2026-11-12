/**
 * TEST ONLY. The CAN-03 R4.1 generator's API (scripts/m7-p3-oracle/can03-r41-generator.mjs) with every
 * operation that decides something answered by the Production QA engine (src/utils/drawing-set/qa-engine.ts)
 * instead of the generator: a QA run and its refusal, a Finding's currency, a Review Decision, the effective
 * Decision, readiness, the register state, a Sheet's QA input, the byte derivations and the bounds.
 *
 * Everything else is the generator's, re-exported unchanged: the fixture builders (sources, profiles, sheets,
 * readings, confirmations, typed registers, retirement, bindings) only build schema-shaped states for the
 * engine to judge, and the generator's clock and id counters stay the ones a write consumes -- the engine is
 * handed them as its seams, so a run that is refused leaves them as they were.
 *
 * smoke-m7-p3-qa.mjs loads the Production modules through Vite and sets globalThis.__m7p3Product before it
 * imports this module, and runs the pack's counterexample file unchanged with its generator import pointed here.
 */
import * as G from './m7-p3-oracle/can03-r41-generator.mjs';

export * from './m7-p3-oracle/can03-r41-generator.mjs';

const P = globalThis.__m7p3Product;
if (!P) throw new Error('the Production QA engine is not loaded (scripts/smoke-m7-p3-qa.mjs loads it first)');
const { qa, bounds, analysisRun } = P;

/** The engine's seams on the generator's own clock and counters. */
const seams = (s) => ({
    now: () => { s.t += 60000; return new Date(s.t).toISOString(); },
    newId: (kind) => G.U(++s.counters[kind]),
});
const bindingOf = (s) => (sourceId) => s.bindings[sourceId] ?? 'UNBOUND';

/** The Production bounds, by x-limit name (the gate checks them against the schema). */
export const LIMITS = Object.freeze(Object.fromEntries(
    ['maxAnalysisRuns', 'maxFindings', 'maxDecisions', 'maxSubjectsPerFinding', 'maxSources', 'maxSheets']
        .map((name) => [name, bounds.P3_QA_LIMITS[name].value]),
));

export const comparisonKey = (value) => qa.comparisonKey(value);
export const findingKey = (ruleId, reason, parts) => qa.findingKeyOf(ruleId, reason, parts);
export function evidenceDigest({ ruleId, ruleVersion = 1, reason, basis, sheets, entries, extra }) {
    if (ruleVersion !== qa.QA_RULE_VERSION) throw new Error(`ruleVersion ${ruleVersion} is not the engine's`);
    return qa.evidenceDigestOf({ ruleId, reason, basis, sheets, entries, extra });
}
export const manifestDigest = (ds) => analysisRun.manifestDigest(ds);

export const qaInput = (ds, sheet) => qa.qaInputOf(ds, sheet);
export function registerState(ds) {
    const view = qa.registerStateOf(ds);
    return { state: view.state, refs: view.references, notCurrent: view.notCurrent, entries: view.entries };
}
export const setFullyEvaluable = (s) => qa.setFullyEvaluable(qa.evaluateQa(s.ds), bindingOf(s));

export function runQa(s) {
    const evaluation = qa.evaluateQa(s.ds);
    const result = qa.runQa(s.ds, seams(s), evaluation);
    if (!result.ok) return { ok: false, refusal: result.refusal, exceeded: result.exceeded };
    s.ds = result.drawingSet;
    const byId = new Map(s.ds.findings.map((finding) => [finding.id, finding]));
    for (const id of result.created) {
        const st = evaluation.byKey.get(byId.get(id).findingKey);
        s.aux[id] = { keyInput: st.keyInput, evidenceInput: st.evidenceInput };
    }
    return { ok: true, run: result.run, created: result.created, register: evaluation.register.state };
}
export const qaRefusal = (s) => qa.qaRefusalOf(s.ds);

export const findingCurrency = (s, finding) => qa.findingCurrencyOf(finding, qa.evaluateQa(s.ds), bindingOf(s));
export const decisionsOf = (s, findingId) => qa.decisionsOf(s.ds, findingId);
export const effectiveDecision = (s, finding) => qa.effectiveOf(qa.decisionsOf(s.ds, finding.id));

export function decide(s, findingId, outcome, comment = '') {
    const result = qa.addDecision(s.ds, { findingId, outcome, comment }, bindingOf(s), seams(s));
    if (!result.ok) {
        return {
            ok: false,
            refusal: result.refusal,
            ...(result.currency ? { currency: result.currency } : {}),
            ...(result.exceeded ? { exceeded: result.exceeded } : {}),
        };
    }
    s.ds = result.drawingSet;
    return { ok: true, decision: result.decision };
}

export const readiness = (s, { implementedRules = G.P3_INITIAL_RULES } = {}) =>
    qa.readinessOf(s.ds, bindingOf(s), undefined, { implementedRules });
