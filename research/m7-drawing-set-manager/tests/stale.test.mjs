/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Stale propagation: what a change makes untrustworthy, and -- as important --
 * what it leaves alone. Each test makes one change to a reviewed Project and
 * reads the consequences back, row by row against STALE_MATRIX.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BINDING, DATA_CURRENCY, FINAL_BLOCKER, FINDING_CURRENCY, STALE_MATRIX, finalReadiness, findingCurrency, indexModel, setCurrency,
} from '../prototype/currency.mjs';
import { seededUuidSource } from '../prototype/ids.mjs';
import {
    addSource, assignProfile, confirmSheet, decide, effectiveDecisions, liveSheets, recordExtraction, replaceSourceFingerprint,
    retireProfile, retireSource, updateProfile,
} from '../prototype/model-ops.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { runQa } from '../prototype/qa-rules.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';
import { buildSyntheticProject } from '../prototype/synthetic-project.mjs';

/** A fully confirmed, fully decided Project of four 6-page sources. */
function reviewed() {
    const built = buildSyntheticProject({
        sheets: 24, pagesPerSource: 6, confirmedShare: 1, decidedShare: 1, duplicateEvery: 5, gapEvery: 7, variantEvery: 0, outlierEvery: 8,
    });
    let now = built.now;
    return { ...built, tick: () => { now += 1000; return now; } };
}

const currencyOf = (model) => setCurrency(model, indexModel(model));
const findingStates = (model, bindings) => {
    const index = indexModel(model);
    const coverage = setCurrency(model, index);
    return new Map(model.drawingSet.findings.map((f) => [f.id, findingCurrency(f, index, bindings, coverage)]));
};
const sheetsOf = (model, sourceId) => liveSheets(model).filter((s) => s.sourceId === sourceId);
const readiness = (model, bindings, options = {}) => finalReadiness(model, bindings, options);

test('baseline: a fully confirmed, fully decided, fully bound Project is Final', () => {
    const { model, bindings } = reviewed();
    const coverage = currencyOf(model);
    for (const currency of coverage.bySheet.values()) {
        assert.equal(currency.pageFacts, DATA_CURRENCY.CURRENT);
        assert.equal(currency.observation, DATA_CURRENCY.CURRENT);
        assert.equal(currency.confirmation, DATA_CURRENCY.CURRENT);
    }
    assert.ok(model.drawingSet.findings.length > 0, 'Final is not "no findings"');
    assert.deepEqual(readiness(model, bindings), { final: true, blockers: [] });
});

test('completion is "no unreviewed current finding", not "no findings"', () => {
    const { model, bindings, tick, newId } = reviewed();
    // Withdraw one decision's effect by adding an undecided finding: confirm a sheet to a duplicate number.
    const [first, second] = liveSheets(model);
    confirmSheet(model, second.id, { ...first.confirmation.values }, tick());
    runQa(model, bindings, { now: tick(), newId });
    const before = readiness(model, bindings);
    assert.equal(before.final, false);
    assert.ok(before.blockers.some((b) => b.code === FINAL_BLOCKER.FINDINGS_UNREVIEWED));
    for (const finding of model.drawingSet.findings) {
        if (finding.lifecycle.state === 'ACTIVE' && !effectiveDecisions(model).has(finding.id)) {
            decide(model, finding.id, { outcome: 'ACTION_REQUIRED', comment: 'fix before issue', now: tick(), newId });
        }
    }
    // Findings remain, every one of them decided -- and that is complete.
    assert.ok(model.drawingSet.findings.some((f) => f.lifecycle.state === 'ACTIVE'));
    assert.equal(readiness(model, bindings).final, true);
});

test('SOURCE_CONTENT_REPLACED: only that source\'s sheets go stale; the other sources are untouched', () => {
    const { model, bindings, tick, newId } = reviewed();
    const [changed, ...others] = model.drawingSet.sources;
    const before = currencyOf(model);
    const beforeFindings = findingStates(model, bindings);

    const result = replaceSourceFingerprint(model, changed.id, {
        sha256: sha256HexOfText('revised bytes'), byteLength: 2_000_000, pageCount: changed.fingerprint.pageCount, now: tick(), newId,
    });
    assert.equal(result.ok, true);
    assert.equal(changed.fingerprintHistory.length, 1);
    assert.equal(changed.fingerprintHistory[0].reason, 'REPLACED_BY_HUMAN');

    const after = currencyOf(model);
    const row = STALE_MATRIX.SOURCE_CONTENT_REPLACED;
    for (const sheet of sheetsOf(model, changed.id)) {
        const currency = after.bySheet.get(sheet.id);
        assert.equal(currency.pageFacts, DATA_CURRENCY.STALE_SOURCE, row.pageFacts);
        assert.equal(currency.observation, DATA_CURRENCY.STALE_SOURCE, row.observation);
        assert.equal(currency.confirmation, DATA_CURRENCY.STALE_SOURCE, row.confirmation);
        // Nothing is read from a stale sheet: it has no effective values.
        assert.equal(currency.effective, null);
        // And nothing was erased: what a person confirmed is still there to be re-confirmed.
        assert.ok(sheet.confirmation && sheet.observation && sheet.pageFacts);
    }
    for (const other of others) {
        for (const sheet of sheetsOf(model, other.id)) assert.deepEqual(after.bySheet.get(sheet.id), before.bySheet.get(sheet.id), row.otherSources);
    }

    // Findings: stale exactly where they cite the replaced bytes.
    const afterFindings = findingStates(model, bindings);
    let stale = 0;
    let untouched = 0;
    for (const finding of model.drawingSet.findings) {
        const citesChanged = finding.basis.some((b) => b.sourceId === changed.id);
        const state = afterFindings.get(finding.id);
        if (citesChanged) { assert.equal(state.currency, FINDING_CURRENCY.STALE); assert.deepEqual(state.reasons, ['SOURCE_REPLACED']); stale += 1; }
        else if (state.currency === FINDING_CURRENCY.CURRENT) { assert.equal(beforeFindings.get(finding.id).currency, FINDING_CURRENCY.CURRENT); untouched += 1; }
        else assert.deepEqual(state.reasons, ['SET_NOT_FULLY_EVALUATED'], row.setGlobalFindings);
    }
    assert.ok(stale > 0 && untouched > 0, `stale ${stale}, untouched ${untouched}`);

    // Decisions are all still there. Not one was removed or rewritten.
    assert.equal(model.drawingSet.decisions.length, beforeFindings.size);
    assert.equal(readiness(model, bindings).final, false);
});

test('after a replacement, a QA run does not close what it could not look at', () => {
    const { model, bindings, tick, newId } = reviewed();
    const changed = model.drawingSet.sources[0];
    const citing = model.drawingSet.findings.filter((f) => f.basis.some((b) => b.sourceId === changed.id) && f.ruleId !== 'QA02_METADATA_UNCONFIRMED');
    assert.ok(citing.length > 0);
    replaceSourceFingerprint(model, changed.id, { sha256: sha256HexOfText('revised'), byteLength: 9, pageCount: changed.fingerprint.pageCount, now: tick(), newId });

    const { summary } = runQa(model, bindings, { now: tick(), newId });
    // The stale sheets have no values to evaluate, so findings about them are
    // neither re-stated nor declared gone.
    assert.ok(summary.leftStale > 0);
    for (const finding of citing) assert.equal(finding.lifecycle.state, 'ACTIVE', finding.ruleId);
    // What the run *can* say is that those sheets now have nobody standing behind their metadata.
    const reconfirm = model.drawingSet.findings.filter((f) => f.ruleId === 'QA02_METADATA_UNCONFIRMED' && f.lifecycle.state === 'ACTIVE' && f.params.reason === 'RECONFIRM_REQUIRED');
    assert.equal(reconfirm.length, sheetsOf(model, changed.id).length);
});

test('re-reading and re-confirming the replaced source supersedes its findings; the old decisions become history', () => {
    const { model, bindings, tick, newId } = reviewed();
    const changed = model.drawingSet.sources[0];
    const decisionsBefore = structuredClone(model.drawingSet.decisions);
    const citing = model.drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === 'QA01_DUPLICATE_NUMBER' && f.basis.some((b) => b.sourceId === changed.id));
    assert.ok(citing.length > 0, 'fixture needs a duplicate that cites the changed source');

    replaceSourceFingerprint(model, changed.id, { sha256: sha256HexOfText('revised'), byteLength: 9, pageCount: changed.fingerprint.pageCount, now: tick(), newId });
    // Re-extract with the same values, then a person re-confirms each sheet.
    const sheets = sheetsOf(model, changed.id);
    recordExtraction(model, {
        results: sheets.map((s) => ({
            sheetId: s.id, status: 'READ',
            pageFacts: { uprightWidthPt: s.pageFacts.uprightWidthPt, uprightHeightPt: s.pageFacts.uprightHeightPt, rotate: s.pageFacts.rotate, kind: s.pageFacts.kind },
            fields: Object.fromEntries(Object.entries(s.observation.fields).map(([k, v]) => [k, { ...v }])),
        })),
        engineVersion: '0.1.0-research', now: tick(), newId,
    });
    for (const sheet of sheets) confirmSheet(model, sheet.id, { ...sheet.confirmation.values }, tick());
    for (const sheet of sheets) {
        assert.equal(sheet.confirmationHistory.length, 1);
        assert.equal(sheet.confirmationHistory[0].reason, 'RECONFIRMED');
    }
    runQa(model, bindings, { now: tick(), newId });

    for (const old of citing) {
        // Same question, same values -- but read from different bytes. That is
        // new evidence, so it is a new finding and the old decision does not
        // carry over on its own.
        assert.equal(old.lifecycle.state, 'SUPERSEDED');
        const next = model.drawingSet.findings.find((f) => f.id === old.lifecycle.supersededByFindingId);
        assert.equal(next.findingKey, old.findingKey);
        assert.notEqual(next.evidenceDigest, old.evidenceDigest);
        assert.equal(effectiveDecisions(model).has(next.id), false);
        // The old decision is still on record, attached to the old finding.
        assert.ok(model.drawingSet.decisions.some((d) => d.findingId === old.id));
    }
    // No decision was removed or altered by any of this.
    assert.deepEqual(model.drawingSet.decisions, decisionsBefore);
    assert.ok(readiness(model, bindings).blockers.some((b) => b.code === FINAL_BLOCKER.FINDINGS_UNREVIEWED));
});

test('SOURCE_RENAMED_SAME_CONTENT: nothing at all goes stale', () => {
    const { model, bindings } = reviewed();
    const before = JSON.stringify([...currencyOf(model).bySheet]);
    model.drawingSet.sources[0].displayName = 'renamed by the user.pdf';
    assert.equal(JSON.stringify([...currencyOf(model).bySheet]), before);
    for (const state of findingStates(model, bindings).values()) assert.equal(state.currency, FINDING_CURRENCY.CURRENT);
    assert.equal(readiness(model, bindings).final, true);
});

test('SOURCE_NOT_PROVIDED: the data is not stale, it is unverified -- and only for that source', () => {
    const { model, bindings } = reviewed();
    const missing = model.drawingSet.sources[1];
    const session = new Map(bindings);
    session.set(missing.id, BINDING.MISSING);

    // Nothing recorded is contradicted, so nothing is stale.
    for (const currency of currencyOf(model).bySheet.values()) assert.equal(currency.confirmation, DATA_CURRENCY.CURRENT);
    let unverified = 0;
    for (const [id, state] of findingStates(model, session)) {
        const finding = model.drawingSet.findings.find((f) => f.id === id);
        if (finding.basis.some((b) => b.sourceId === missing.id)) { assert.equal(state.currency, FINDING_CURRENCY.UNVERIFIED); unverified += 1; }
        else assert.equal(state.currency, FINDING_CURRENCY.CURRENT);
    }
    assert.ok(unverified > 0);
    const ready = readiness(model, session);
    assert.equal(ready.final, false);
    assert.ok(ready.blockers.some((b) => b.code === FINAL_BLOCKER.SOURCES_NOT_MATCHED && b.count === 1));
});

test('on resume everything is UNVERIFIED until the sources are bound, then exactly as it was saved', () => {
    const { model, bindings, tick } = reviewed();
    const ids = seededUuidSource(55);
    const exported = exportProject(model, { now: tick(), newFileId: ids() });
    const reopened = importProject(exported.bytes, { now: tick() }).project;

    // No bindings yet: every source is UNBOUND.
    const unbound = new Map();
    for (const state of findingStates(reopened, unbound).values()) assert.equal(state.currency, FINDING_CURRENCY.UNVERIFIED);
    assert.equal(readiness(reopened, unbound).final, false);
    // The same Project, bound again by fingerprint.
    for (const state of findingStates(reopened, bindings).values()) assert.equal(state.currency, FINDING_CURRENCY.CURRENT);
    assert.equal(readiness(reopened, bindings).final, true);
});

test('PROFILE_GEOMETRY_CHANGED: observations and profile-based confirmations of that profile\'s sheets, nothing else', () => {
    const { model, tick, newId, profile } = reviewed();
    // Give the last source a profile of its own, and confirm one sheet by hand with no profile involved.
    const lastSource = model.drawingSet.sources.at(-1);
    const own = sheetsOf(model, lastSource.id);
    const second = structuredClone(profile);
    second.id = newId();
    second.name = 'second profile';
    model.drawingSet.titleBlockProfiles.push(second);
    assignProfile(model, own.map((s) => s.id), second.id, tick());
    recordExtraction(model, {
        results: own.map((s) => ({ sheetId: s.id, status: 'READ', fields: Object.fromEntries(Object.entries(s.observation.fields).map(([k, v]) => [k, { ...v }])) })),
        engineVersion: '0.1.0-research', now: tick(), newId,
    });
    for (const sheet of own) confirmSheet(model, sheet.id, {}, tick());
    const manual = liveSheets(model).find((s) => s.sourceId !== lastSource.id);
    assignProfile(model, [manual.id], null, tick());
    confirmSheet(model, manual.id, { drawingNumber: 'X-900', drawingTitle: 'typed by hand', revision: 'A', issueDate: '2026.01.01' }, tick());
    assert.equal(manual.confirmation.profile, null);
    for (const currency of currencyOf(model).bySheet.values()) assert.equal(currency.confirmation, DATA_CURRENCY.CURRENT);

    const changed = updateProfile(model, profile.id, { fields: { revision: { left: 2100, top: 1645, right: 2250, bottom: 1675 } } }, tick());
    assert.equal(changed.geometryChanged, true);
    assert.equal(profile.revision, 2);

    const after = currencyOf(model);
    for (const sheet of liveSheets(model)) {
        const currency = after.bySheet.get(sheet.id);
        assert.equal(currency.pageFacts, DATA_CURRENCY.CURRENT, 'page facts do not depend on a profile');
        if (sheet.id === manual.id) {
            assert.equal(currency.confirmation, DATA_CURRENCY.CURRENT, 'a confirmation made without a profile is not touched');
        } else if (sheet.sourceId === lastSource.id) {
            assert.equal(currency.observation, DATA_CURRENCY.CURRENT, 'another profile\'s sheets are not touched');
            assert.equal(currency.confirmation, DATA_CURRENCY.CURRENT);
        } else {
            assert.equal(currency.observation, DATA_CURRENCY.STALE_PROFILE);
            assert.equal(currency.confirmation, DATA_CURRENCY.STALE_PROFILE);
        }
    }
    // Renaming a profile is not a change to what it reads.
    const renamed = updateProfile(model, second.id, { name: 'renamed' }, tick());
    assert.equal(renamed.geometryChanged, false);
    assert.equal(second.revision, 1);
});

test('SHEET_REASSIGNED_TO_ANOTHER_PROFILE: that one sheet', () => {
    const { model, tick, newId, profile } = reviewed();
    const second = structuredClone(profile);
    second.id = newId();
    model.drawingSet.titleBlockProfiles.push(second);
    const [target, ...rest] = liveSheets(model);
    assignProfile(model, [target.id], second.id, tick());
    const after = currencyOf(model);
    assert.equal(after.bySheet.get(target.id).observation, DATA_CURRENCY.STALE_PROFILE);
    assert.equal(after.bySheet.get(target.id).confirmation, DATA_CURRENCY.STALE_PROFILE);
    for (const sheet of rest) assert.equal(after.bySheet.get(sheet.id).confirmation, DATA_CURRENCY.CURRENT);
});

test('a retired profile unassigns its sheets, stays in the file, and what was read under it is stale', () => {
    const { model, tick, newId, profile } = reviewed();
    const result = retireProfile(model, profile.id, tick());
    assert.equal(result.ok, true);
    assert.equal(result.unassignedSheetIds.length, liveSheets(model).length);
    assert.ok(model.drawingSet.titleBlockProfiles.includes(profile));
    for (const currency of currencyOf(model).bySheet.values()) {
        assert.equal(currency.observation, DATA_CURRENCY.STALE_PROFILE);
        assert.equal(currency.confirmation, DATA_CURRENCY.STALE_PROFILE);
        assert.equal(currency.pageFacts, DATA_CURRENCY.CURRENT);
    }
    // The file is still valid: the bases that name the profile still resolve.
    const ids = seededUuidSource(21);
    const exported = exportProject(model, { now: tick(), newFileId: ids() });
    assert.equal(importProject(exported.bytes, { now: tick() }).status, 'ACCEPTED');
    assert.equal(retireProfile(model, profile.id, tick()).code, 'NO_SUCH_PROFILE');
    void newId;
});

test('SHEET_METADATA_CONFIRMED_OR_EDITED: findings are re-evaluated; a decision survives only if its evidence did', () => {
    const { model, bindings, tick, newId } = reviewed();
    const duplicate = model.drawingSet.findings.find((f) => f.ruleId === 'QA01_DUPLICATE_NUMBER' && f.lifecycle.state === 'ACTIVE');
    const unrelated = model.drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && !f.sheetIds.some((id) => duplicate.sheetIds.includes(id)));
    const decisions = effectiveDecisions(model);
    assert.ok(decisions.has(duplicate.id));

    // A person corrects one of the two numbers. The duplicate is gone.
    const sheet = model.drawingSet.sheets.find((s) => s.id === duplicate.sheetIds[0]);
    confirmSheet(model, sheet.id, { ...sheet.confirmation.values, drawingNumber: 'Z-999' }, tick());
    runQa(model, bindings, { now: tick(), newId });

    assert.equal(duplicate.lifecycle.state, 'NOT_REPRODUCED');
    // The decision made about it is still on record.
    assert.ok(model.drawingSet.decisions.some((d) => d.findingId === duplicate.id));
    // Findings that cite neither sheet kept their identity and their decisions.
    for (const finding of unrelated) {
        if (['QA03_NUMBER_GAP'].includes(finding.ruleId)) continue; // a gap may legitimately move with the number
        assert.equal(finding.lifecycle.state, 'ACTIVE', finding.ruleId);
        assert.equal(effectiveDecisions(model).get(finding.id), decisions.get(finding.id));
    }
});

test('SOURCE_ADDED_OR_RETIRED: per-sheet data untouched, set-wide findings re-evaluated', () => {
    const { model, bindings, tick, newId } = reviewed();
    const before = JSON.stringify([...currencyOf(model).bySheet]);
    const retired = model.drawingSet.sources.at(-1);
    const retiredSheets = new Set(sheetsOf(model, retired.id).map((s) => s.id));
    assert.equal(retireSource(model, retired.id, tick()).ok, true);

    // The surviving sheets' own data did not move.
    const after = currencyOf(model);
    for (const [id, currency] of JSON.parse(before)) {
        if (!retiredSheets.has(id)) assert.deepEqual(after.bySheet.get(id), currency);
    }
    // Findings that cite a retired sheet are stale until a run looks again...
    for (const [id, state] of findingStates(model, bindings)) {
        const finding = model.drawingSet.findings.find((f) => f.id === id);
        if (finding.sheetIds.some((s) => retiredSheets.has(s))) assert.equal(state.currency, FINDING_CURRENCY.STALE);
    }
    // ...and then they are closed, not deleted.
    const count = model.drawingSet.findings.length;
    runQa(model, bindings, { now: tick(), newId });
    assert.ok(model.drawingSet.findings.length >= count);
    for (const finding of model.drawingSet.findings) {
        if (finding.sheetIds.length > 0 && finding.sheetIds.every((s) => retiredSheets.has(s)) && finding.lifecycle.state === 'ACTIVE') {
            assert.fail(`${finding.ruleId} about retired sheets is still active`);
        }
    }
    // Retired, not gone: the entities and their history are all still in the model.
    assert.ok(model.drawingSet.sources.includes(retired));

    const added = addSource(model, { displayName: 'late addition.pdf', sha256: sha256HexOfText('late'), byteLength: 77, pageCount: 2, now: tick(), newId });
    assert.equal(added.ok, true);
    assert.equal(currencyOf(model).metadataComplete, false, 'two new sheets have nothing read yet');
});

test('the same bytes cannot be added twice, or installed as another source\'s replacement', () => {
    const { model, tick, newId } = reviewed();
    const [first, second] = model.drawingSet.sources;
    assert.deepEqual(
        addSource(model, { displayName: 'copy.pdf', sha256: first.fingerprint.sha256, byteLength: 1, pageCount: 1, now: tick(), newId }),
        { ok: false, code: 'DUPLICATE_CONTENT', existingSourceId: first.id },
    );
    assert.equal(replaceSourceFingerprint(model, second.id, { sha256: first.fingerprint.sha256, byteLength: 1, pageCount: 1, now: tick(), newId }).code, 'DUPLICATE_CONTENT');
    assert.equal(replaceSourceFingerprint(model, second.id, { ...second.fingerprint, now: tick(), newId }).code, 'SAME_CONTENT');
});

test('a replacement with a different page count leaves the mismatch for a person and reports it', () => {
    const { model, bindings, tick, newId } = reviewed();
    const source = model.drawingSet.sources[0];
    const result = replaceSourceFingerprint(model, source.id, { sha256: sha256HexOfText('shorter'), byteLength: 5, pageCount: 4, now: tick(), newId });
    assert.equal(result.addedSheets.length, 0);
    // The two sheets whose pages no longer exist were not retired behind anyone's back.
    assert.equal(sheetsOf(model, source.id).length, 6);
    runQa(model, bindings, { now: tick(), newId });
    const orphan = model.drawingSet.findings.find((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && f.lifecycle.state === 'ACTIVE');
    assert.equal(orphan.params.reason, 'SHEET_WITHOUT_PAGE');
    assert.equal(orphan.params.count, 2);

    const longer = replaceSourceFingerprint(model, source.id, { sha256: sha256HexOfText('longer'), byteLength: 6, pageCount: 8, now: tick(), newId });
    assert.equal(longer.addedSheets.length, 2);
    assert.deepEqual(longer.addedSheets.map((s) => s.pageNumber), [7, 8]);
});

test('HOLD: by the letter of the adopted contract it is a decision; the stricter reading is one option away', () => {
    const { model, bindings, tick, newId } = reviewed();
    const finding = model.drawingSet.findings.find((f) => f.lifecycle.state === 'ACTIVE');
    decide(model, finding.id, { outcome: 'HOLD', comment: 'waiting for the consultant', now: tick(), newId });
    assert.equal(readiness(model, bindings).final, true);
    const strict = readiness(model, bindings, { holdBlocksFinal: true });
    assert.equal(strict.final, false);
    assert.ok(strict.blockers.some((b) => b.code === FINAL_BLOCKER.FINDINGS_ON_HOLD));
});

test('a sheet a person deliberately leaves unconfirmed is exempt only by a recorded decision', () => {
    const built = buildSyntheticProject({ sheets: 6, pagesPerSource: 6, confirmedShare: 0, decidedShare: 0, duplicateEvery: 0, gapEvery: 0, variantEvery: 0, outlierEvery: 0 });
    const { model, bindings, newId } = built;
    let now = built.now;
    const unconfirmed = model.drawingSet.findings.filter((f) => f.ruleId === 'QA02_METADATA_UNCONFIRMED');
    assert.equal(unconfirmed.length, 6);
    for (const finding of unconfirmed) decide(model, finding.id, { outcome: 'ACTION_REQUIRED', now: now += 1, newId });
    // Decided, but the decision says the work is still to do.
    assert.ok(readiness(model, bindings).blockers.some((b) => b.code === FINAL_BLOCKER.METADATA_NOT_CONFIRMED && b.count === 6));
    for (const finding of unconfirmed) decide(model, finding.id, { outcome: 'INTENTIONAL', comment: 'cover sheet, no title block', now: now += 1, newId });
    assert.equal(readiness(model, bindings).final, true);
    // Both decisions per finding are on record, in order.
    assert.equal(model.drawingSet.decisions.length, 12);
});
