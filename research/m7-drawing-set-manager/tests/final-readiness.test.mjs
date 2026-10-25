/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * When a QA Report may be called Final -- and in particular what does, and what
 * does not, lift the requirement that a sheet's metadata be confirmed.
 *
 * QA02 states a fact: nobody has confirmed this sheet's metadata. Only one
 * decision answers that fact without confirming the sheet -- INTENTIONAL, a
 * person saying the metadata is deliberately not applicable here. FALSE_POSITIVE
 * does not: if the finding really is wrong, the sheet is confirmed and the next
 * run does not state it. (Independent Architecture Review, RF-33-01.)
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BINDING, FINAL_BLOCKER, finalReadiness } from '../prototype/currency.mjs';
import { confirmSheet, decide, effectiveDecisions, liveSheets, replaceSourceFingerprint, updateProfile } from '../prototype/model-ops.mjs';
import { runQa } from '../prototype/qa-rules.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';
import { buildSyntheticProject } from '../prototype/synthetic-project.mjs';

/** Six sheets, read by the machine, none confirmed, nothing else wrong: only QA02 is outstanding. */
function unconfirmed() {
    const built = buildSyntheticProject({ sheets: 6, pagesPerSource: 6, confirmedShare: 0, decidedShare: 0, duplicateEvery: 0, gapEvery: 0, variantEvery: 0, outlierEvery: 0 });
    let now = built.now;
    const tick = () => { now += 1000; return now; };
    const qa02 = () => built.model.drawingSet.findings.filter((f) => f.ruleId === 'QA02_METADATA_UNCONFIRMED' && f.lifecycle.state === 'ACTIVE');
    const decideAll = (outcome) => { for (const finding of qa02()) decide(built.model, finding.id, { outcome, now: tick(), newId: built.newId }); };
    const rerun = () => runQa(built.model, built.bindings, { now: tick(), newId: built.newId });
    return { ...built, tick, qa02, decideAll, rerun };
}
const blockerCodes = (readiness) => readiness.blockers.map((b) => b.code).sort();
const count = (readiness, code) => readiness.blockers.find((b) => b.code === code)?.count ?? 0;

test('the starting point: six unconfirmed sheets, six QA02 findings, nothing decided', () => {
    const { model, bindings, qa02 } = unconfirmed();
    assert.equal(qa02().length, 6);
    assert.deepEqual(model.drawingSet.findings.map((f) => f.ruleId), Array(6).fill('QA02_METADATA_UNCONFIRMED'));
    const readiness = finalReadiness(model, bindings);
    assert.equal(readiness.final, false);
    assert.deepEqual(blockerCodes(readiness), [FINAL_BLOCKER.FINDINGS_UNREVIEWED, FINAL_BLOCKER.METADATA_NOT_CONFIRMED]);
});

test('1. unconfirmed + FALSE_POSITIVE: Final is blocked by METADATA_NOT_CONFIRMED', () => {
    const { model, bindings, decideAll } = unconfirmed();
    decideAll('FALSE_POSITIVE');
    const readiness = finalReadiness(model, bindings);
    assert.equal(readiness.final, false);
    // Every finding has been decided, so nothing is unreviewed -- and the metadata is still unconfirmed.
    assert.deepEqual(blockerCodes(readiness), [FINAL_BLOCKER.METADATA_NOT_CONFIRMED]);
    assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);
});

test('2. unconfirmed + INTENTIONAL: the metadata blocker clears, by a recorded decision', () => {
    const { model, bindings, decideAll } = unconfirmed();
    decideAll('INTENTIONAL');
    const readiness = finalReadiness(model, bindings);
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.final, true);
    // The sheets are still unconfirmed in the model; what changed is that a person said so on the record.
    for (const sheet of liveSheets(model)) assert.equal(sheet.confirmation, null);
    assert.equal(model.drawingSet.decisions.filter((d) => d.outcome === 'INTENTIONAL').length, 6);
});

test('ACTION_REQUIRED and HOLD do not lift the metadata requirement either', () => {
    for (const outcome of ['ACTION_REQUIRED', 'HOLD']) {
        const { model, bindings, decideAll } = unconfirmed();
        decideAll(outcome);
        const readiness = finalReadiness(model, bindings);
        assert.equal(readiness.final, false, outcome);
        assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6, outcome);
    }
});

test('the exemption is per sheet: one INTENTIONAL does not cover a sheet decided FALSE_POSITIVE', () => {
    const { model, bindings, qa02, tick, newId } = unconfirmed();
    const [first, ...rest] = qa02();
    decide(model, first.id, { outcome: 'INTENTIONAL', now: tick(), newId });
    for (const finding of rest) decide(model, finding.id, { outcome: 'FALSE_POSITIVE', now: tick(), newId });
    const readiness = finalReadiness(model, bindings);
    assert.equal(readiness.final, false);
    assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 5);
});

test('the decision in force is the latest: INTENTIONAL withdrawn to FALSE_POSITIVE blocks again', () => {
    const { model, bindings, decideAll } = unconfirmed();
    decideAll('INTENTIONAL');
    assert.equal(finalReadiness(model, bindings).final, true);
    decideAll('FALSE_POSITIVE');
    assert.equal(count(finalReadiness(model, bindings), FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);
    decideAll('INTENTIONAL');
    assert.equal(finalReadiness(model, bindings).final, true);
    // All three rounds are on record.
    assert.equal(model.drawingSet.decisions.length, 18);
});

test('3. actual confirmation: QA02 is NOT_REPRODUCED and the Final path works with no decision on it', () => {
    const { model, bindings, qa02, tick, rerun } = unconfirmed();
    const findings = qa02();
    for (const sheet of liveSheets(model)) confirmSheet(model, sheet.id, {}, tick());
    const { summary } = rerun();
    assert.equal(summary.notReproduced, 6);
    for (const finding of findings) assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    // Nobody decided anything. Confirming the sheets was the answer.
    assert.equal(model.drawingSet.decisions.length, 0);
    const readiness = finalReadiness(model, bindings);
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.final, true);
});

test('a QA02 that really was a false positive is answered by confirming the sheet, not by the decision', () => {
    const { model, bindings, qa02, tick, newId, rerun } = unconfirmed();
    const [finding] = qa02();
    decide(model, finding.id, { outcome: 'FALSE_POSITIVE', comment: 'this sheet was already checked on paper', now: tick(), newId });
    assert.ok(count(finalReadiness(model, bindings), FINAL_BLOCKER.METADATA_NOT_CONFIRMED) >= 1);
    confirmSheet(model, finding.sheetIds[0], {}, tick());
    rerun();
    assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    // The decision is still on record, attached to the finding it was made about.
    assert.equal(effectiveDecisions(model).get(finding.id).outcome, 'FALSE_POSITIVE');
    assert.equal(count(finalReadiness(model, bindings), FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 5);
});

test('4. stale confirmation: still blocked -- by a replaced source, and by a changed profile', () => {
    // A fully confirmed set first.
    const confirmedSet = () => {
        const fixture = unconfirmed();
        for (const sheet of liveSheets(fixture.model)) confirmSheet(fixture.model, sheet.id, {}, fixture.tick());
        fixture.rerun();
        assert.equal(finalReadiness(fixture.model, fixture.bindings).final, true);
        return fixture;
    };

    const replaced = confirmedSet();
    const source = replaced.model.drawingSet.sources[0];
    replaceSourceFingerprint(replaced.model, source.id, { sha256: sha256HexOfText('new bytes'), byteLength: 9, pageCount: source.fingerprint.pageCount, now: replaced.tick(), newId: replaced.newId });
    replaced.rerun();
    let readiness = finalReadiness(replaced.model, replaced.bindings);
    assert.equal(readiness.final, false);
    assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);
    // The stale confirmations are still in the model; they are just not trusted.
    for (const sheet of liveSheets(replaced.model)) assert.ok(sheet.confirmation);
    assert.deepEqual([...new Set(replaced.qa02().map((f) => f.params.reason))], ['RECONFIRM_REQUIRED']);
    // FALSE_POSITIVE on those does not help either.
    replaced.decideAll('FALSE_POSITIVE');
    assert.equal(count(finalReadiness(replaced.model, replaced.bindings), FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);

    const reprofiled = confirmedSet();
    updateProfile(reprofiled.model, reprofiled.profile.id, { fields: { revision: { left: 2100, top: 1645, right: 2250, bottom: 1675 } } }, reprofiled.tick());
    reprofiled.rerun();
    readiness = finalReadiness(reprofiled.model, reprofiled.bindings);
    assert.equal(readiness.final, false);
    assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);
});

test('an INTENTIONAL decision does not outlive the evidence it was made on', () => {
    const { model, bindings, decideAll, tick, newId, rerun } = unconfirmed();
    decideAll('INTENTIONAL');
    assert.equal(finalReadiness(model, bindings).final, true);
    // The source is replaced. The exemption was a decision about the old bytes.
    const source = model.drawingSet.sources[0];
    replaceSourceFingerprint(model, source.id, { sha256: sha256HexOfText('revised'), byteLength: 9, pageCount: source.fingerprint.pageCount, now: tick(), newId });
    rerun();
    const readiness = finalReadiness(model, bindings);
    assert.equal(readiness.final, false);
    assert.equal(count(readiness, FINAL_BLOCKER.METADATA_NOT_CONFIRMED), 6);
    assert.equal(count(readiness, FINAL_BLOCKER.FINDINGS_UNREVIEWED), 6);
});

test('5. a Source that is not MATCHED blocks Final independently of every decision', () => {
    for (const state of [BINDING.UNBOUND, BINDING.MISSING, BINDING.CHANGED, BINDING.AMBIGUOUS]) {
        const { model, bindings, decideAll } = unconfirmed();
        decideAll('INTENTIONAL');
        assert.equal(finalReadiness(model, bindings).final, true);
        const session = new Map(bindings);
        session.set(model.drawingSet.sources[0].id, state);
        const readiness = finalReadiness(model, session);
        assert.equal(readiness.final, false, state);
        assert.equal(count(readiness, FINAL_BLOCKER.SOURCES_NOT_MATCHED), 1, state);
    }
    // And with nothing bound at all, as on resume.
    const { model, decideAll } = unconfirmed();
    decideAll('INTENTIONAL');
    assert.ok(count(finalReadiness(model, new Map()), FINAL_BLOCKER.SOURCES_NOT_MATCHED) === 1);
});

test('a decided QA10 finding about a missing Source does not waive the Source', () => {
    const { model, bindings, decideAll, tick, newId } = unconfirmed();
    decideAll('INTENTIONAL');
    const session = new Map(bindings);
    session.set(model.drawingSet.sources[0].id, BINDING.MISSING);
    runQa(model, session, { now: tick(), newId });
    const missing = model.drawingSet.findings.find((f) => f.ruleId === 'QA10_INTEGRITY' && f.params.reason === 'SOURCE_MISSING');
    decide(model, missing.id, { outcome: 'INTENTIONAL', comment: 'we no longer have this file', now: tick(), newId });
    const readiness = finalReadiness(model, session);
    assert.equal(readiness.final, false);
    assert.ok(blockerCodes(readiness).includes(FINAL_BLOCKER.SOURCES_NOT_MATCHED));
});
