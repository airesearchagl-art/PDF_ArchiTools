/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The ten QA rules, one small hand-built Drawing Set at a time, and the
 * reconciliation that carries a Human decision across re-runs.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BINDING } from '../prototype/currency.mjs';
import { seededUuidSource } from '../prototype/ids.mjs';
import {
    addProfile, addSource, assignProfile, confirmSheet, decide, effectiveDecisions, liveSheets, newProject, recordExtraction,
} from '../prototype/model-ops.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import {
    MAX_REPORTED_GAP_RUN, RULES, comparisonKey, displayedOrientation, evaluateRules, exactKey, normaliseDate, parseSeries, runQa, sizeClass,
} from '../prototype/qa-rules.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';
import { CHAR } from './helpers.mjs';

const A1 = { uprightWidthPt: 2383.94, uprightHeightPt: 1683.78 };
const A3 = { uprightWidthPt: 1190.55, uprightHeightPt: 841.89 };
const RECTS = {
    drawingNumber: { left: 2150, top: 1600, right: 2360, bottom: 1640 },
    drawingTitle: { left: 1850, top: 1600, right: 2140, bottom: 1640 },
    revision: { left: 2150, top: 1645, right: 2250, bottom: 1675 },
    issueDate: { left: 2255, top: 1645, right: 2360, bottom: 1675 },
};

/**
 * A Drawing Set from a list of rows, one sheet per row, all in one source.
 * A row is `[number, title, revision, date, options]`; `confirmed: false`
 * leaves it observed only, `facts` overrides the page.
 */
function setOf(rows, { bindingState = BINDING.MATCHED } = {}) {
    const newId = seededUuidSource(rows.length * 7919 + 13);
    let now = Date.UTC(2026, 9, 5);
    const tick = () => { now += 1000; return now; };
    const model = newProject({ name: 'QA test', now: tick(), newId });
    const profile = addProfile(model, { name: 'p', transferModel: 'corner-anchored', referencePage: A1, fields: RECTS, now: tick(), newId });
    const { source } = addSource(model, { displayName: 'set.pdf', sha256: sha256HexOfText(`qa:${rows.length}`), byteLength: 1234, pageCount: rows.length, now: tick(), newId });
    const sheets = liveSheets(model);
    assignProfile(model, sheets.map((s) => s.id), profile.id, tick());
    recordExtraction(model, {
        results: sheets.map((sheet, i) => {
            const [number, title = 'title', revision = 'A', date = '2026.10.05', options = {}] = rows[i];
            const field = (value) => ({ value, rawText: value, source: 'native', ocrScore: null });
            return {
                sheetId: sheet.id, status: options.status ?? 'READ',
                pageFacts: { ...A1, rotate: 0, kind: 'text-native', ...(options.facts ?? {}) },
                fields: { drawingNumber: field(number), drawingTitle: field(title), revision: field(revision), issueDate: field(date) },
            };
        }),
        engineVersion: 't', now: tick(), newId,
    });
    sheets.forEach((sheet, i) => { if ((rows[i][4] ?? {}).confirmed !== false) confirmSheet(model, sheet.id, {}, tick()); });
    const bindings = new Map([[source.id, bindingState]]);
    return { model, bindings, sheets, source, profile, newId, tick };
}

const active = (model, ruleId) => model.drawingSet.findings.filter((f) => f.ruleId === ruleId && f.lifecycle.state === 'ACTIVE');
const run = (fixture, options = {}) => runQa(fixture.model, fixture.bindings, { now: fixture.tick(), newId: fixture.newId, ...options });

// -- normalisation ----------------------------------------------------------

test('exactKey trims and does nothing else, exactly like the existing register', () => {
    assert.equal(exactKey('  A-101 '), 'A-101');
    assert.notEqual(exactKey('A-101'), exactKey('A101'));
    assert.notEqual(exactKey('A-101'), exactKey('a-101'));
});

test('comparisonKey folds width, case, dash variants, spacing and invisible characters', () => {
    // Dash look-alikes are built from code points so a reader can tell them apart:
    // HYPHEN, EN DASH, MINUS SIGN, KATAKANA-HIRAGANA PROLONGED SOUND MARK.
    const dashes = [0x2010, 0x2013, 0x2212, 0x30fc].map((c) => `A${String.fromCodePoint(c)}101`);
    const variants = ['A-101', 'a-101', 'Ａ－１０１', 'A - 101', `A-1${CHAR.ZWSP}01`, ...dashes];
    for (const variant of variants) assert.equal(comparisonKey(variant), 'A-101', JSON.stringify(variant));
    // It does not invent equalities the characters do not support.
    assert.notEqual(comparisonKey('A-101'), comparisonKey('A101'));
    assert.notEqual(comparisonKey('A-101'), comparisonKey('A-0101'));
    assert.notEqual(comparisonKey('A-101'), comparisonKey('A-1O1'));
});

test('parseSeries splits a number into what stays and what counts', () => {
    assert.deepEqual(parseSeries('A-101'), { prefix: 'A-', digits: '101', number: 101, suffix: '' });
    assert.deepEqual(parseSeries('Ａ－００７ａ'), { prefix: 'A-', digits: '007', number: 7, suffix: 'A' });
    assert.deepEqual(parseSeries('S2-015'), { prefix: 'S2-', digits: '015', number: 15, suffix: '' });
    assert.equal(parseSeries('COVER'), null);
    assert.equal(parseSeries(''), null);
});

test('normaliseDate reads only unambiguous numeric dates', () => {
    for (const same of ['2026.10.05', '2026/10/5', '2026-10-05', '２０２６．１０．５', '2026年10月5日']) assert.equal(normaliseDate(same), '2026-10-05', same);
    for (const left of ['R8.10.5', '令和8年10月5日', '10/05/2026', '2026.13.01', '2026.02.30', 'Oct 5 2026', '']) assert.equal(normaliseDate(left), null, left);
});

test('sizeClass and displayedOrientation', () => {
    assert.equal(sizeClass(2383.94, 1683.78), 'A1');
    assert.equal(sizeClass(1683.78, 2383.94), 'A1');
    assert.equal(sizeClass(1190.55, 841.89), 'A3');
    assert.equal(sizeClass(1000, 1000), 'OTHER');
    assert.equal(displayedOrientation({ ...A1, rotate: 0 }), 'landscape');
    assert.equal(displayedOrientation({ ...A1, rotate: 90 }), 'portrait');
    assert.equal(displayedOrientation({ uprightWidthPt: 500, uprightHeightPt: 500, rotate: 0 }), 'landscape');
});

// -- the rules --------------------------------------------------------------

test('QA01: an exact duplicate number is a deterministic finding over the whole group', () => {
    const fixture = setOf([['A-101'], ['A-102'], [' A-101 '], ['A-103'], ['A-101']]);
    run(fixture);
    const [finding] = active(fixture.model, 'QA01_DUPLICATE_NUMBER');
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 1);
    assert.equal(finding.determinism, 'DETERMINISTIC');
    assert.equal(finding.scope, 'SHEET_GROUP');
    assert.deepEqual([...finding.sheetIds].sort(), [fixture.sheets[0].id, fixture.sheets[2].id, fixture.sheets[4].id].sort());
    assert.deepEqual(finding.params, { number: 'A-101', count: 3 });
    assert.deepEqual(finding.basis, [{ sourceId: fixture.source.id, sha256: fixture.source.fingerprint.sha256 }]);
});

test('QA01 does not merge A-101 with A101, or with its full-width spelling; QA01B asks about the latter', () => {
    const fixture = setOf([['A-101'], ['A101'], ['Ａ－１０１'], ['a-101']]);
    run(fixture);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 0);
    const [variant] = active(fixture.model, 'QA01B_DUPLICATE_NUMBER_VARIANT');
    assert.equal(variant.determinism, 'CANDIDATE');
    assert.equal(variant.params.comparisonKey, 'A-101');
    assert.deepEqual(variant.params.values, ['A-101', 'a-101', 'Ａ－１０１'].sort());
    assert.equal(variant.sheetIds.length, 3);
    // A101 is in neither: no fold makes a missing hyphen appear.
    assert.ok(!variant.sheetIds.includes(fixture.sheets[1].id));
});

test('an empty drawing number is never a duplicate of another empty one', () => {
    const fixture = setOf([[''], [''], ['  ']]);
    run(fixture);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 0);
    assert.equal(active(fixture.model, 'QA01B_DUPLICATE_NUMBER_VARIANT').length, 0);
});

test('QA02: one finding per sheet no person currently stands behind, with the reason', () => {
    const fixture = setOf([['A-101'], ['A-102', 't', 'A', 'd', { confirmed: false }], ['A-103', 't', 'A', 'd', { confirmed: false, status: 'OCR_FAILED' }]]);
    run(fixture);
    const findings = active(fixture.model, 'QA02_METADATA_UNCONFIRMED');
    assert.deepEqual(findings.map((f) => [f.sheetIds[0], f.params.reason]).sort(), [
        [fixture.sheets[1].id, 'UNCONFIRMED'], [fixture.sheets[2].id, 'OCR_FAILED'],
    ].sort());
    for (const finding of findings) { assert.equal(finding.scope, 'SHEET'); assert.equal(finding.determinism, 'DETERMINISTIC'); }

    // Confirming resolves it; nobody had to "close" the finding.
    confirmSheet(fixture.model, fixture.sheets[1].id, {}, fixture.tick());
    run(fixture);
    assert.equal(findings.find((f) => f.sheetIds[0] === fixture.sheets[1].id).lifecycle.state, 'NOT_REPRODUCED');
});

test('QA02 reports a sheet that was never read at all', () => {
    const fixture = setOf([['A-101'], ['A-102']]);
    const added = addSource(fixture.model, { displayName: 'more.pdf', sha256: sha256HexOfText('more'), byteLength: 9, pageCount: 1, now: fixture.tick(), newId: fixture.newId });
    fixture.bindings.set(added.source.id, BINDING.MATCHED);
    run(fixture);
    const [finding] = active(fixture.model, 'QA02_METADATA_UNCONFIRMED');
    assert.equal(finding.params.reason, 'NOT_READ');
    assert.equal(finding.sheetIds[0], added.sheets[0].id);
});

test('QA03: a short run of missing numbers inside a series is a candidate; a long jump is not', () => {
    const fixture = setOf([['A-101'], ['A-102'], ['A-104'], ['A-105'], ['A-201'], ['A-202'], ['S-01'], ['S-04']]);
    run(fixture);
    const gaps = active(fixture.model, 'QA03_NUMBER_GAP');
    assert.deepEqual(gaps.map((f) => [f.params.rangeFrom, f.params.rangeTo, f.params.count]).sort(), [['A-103', 'A-103', 1], ['S-02', 'S-03', 2]]);
    for (const gap of gaps) { assert.equal(gap.determinism, 'CANDIDATE'); assert.equal(gap.scope, 'SET'); }
    // The neighbours are the evidence.
    const a103 = gaps.find((f) => f.params.rangeFrom === 'A-103');
    assert.deepEqual([...a103.sheetIds].sort(), [fixture.sheets[1].id, fixture.sheets[2].id].sort());
    // 105 -> 201 is 95 missing numbers: a new group, not a gap.
    assert.ok(105 + MAX_REPORTED_GAP_RUN < 201);
});

test('QA03 keeps series apart and is not confused by a suffix or by width', () => {
    const fixture = setOf([['A-101'], ['S-103'], ['A-101a'], ['A-103a'], ['Ａ－１０３']]);
    run(fixture);
    const gaps = active(fixture.model, 'QA03_NUMBER_GAP');
    // A-101 .. A-103 (full-width) is one series; A-101a .. A-103a another; S alone has no pair.
    assert.deepEqual(gaps.map((f) => f.params.rangeFrom).sort(), ['A-102', 'A-102A']);
});

test('QA04 / QA05 / QA06: within one number, differing titles, revisions and dates are each stated', () => {
    const fixture = setOf([
        ['A-101', '1階平面図', 'A', '2026.10.05'],
        ['A-101', '1階平面図', 'B', '2026/10/5'],
        ['A-102', '立面図', 'A', '2026.10.05'],
        ['A-102', '断面図', 'A', '2026.11.01'],
        ['A-103', '同じ', 'A', 'R8.10.5'],
        ['A-103', '同じ', 'A', 'R8.10.5'],
    ]);
    run(fixture);
    const params = (ruleId) => active(fixture.model, ruleId).map((f) => [f.params.number, f.params.values]);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 3);
    assert.deepEqual(params('QA04_SAME_NUMBER_DIFFERENT_TITLE'), [['A-102', ['断面図', '立面図'].sort()]]);
    assert.deepEqual(params('QA05_REVISION_MISMATCH'), [['A-101', ['A', 'B']]]);
    // 2026.10.05 and 2026/10/5 are one date; A-102's two dates are two.
    assert.deepEqual(params('QA06_ISSUE_DATE_MISMATCH'), [['A-102', ['2026-10-05', '2026-11-01']]]);
    for (const ruleId of ['QA04_SAME_NUMBER_DIFFERENT_TITLE', 'QA05_REVISION_MISMATCH', 'QA06_ISSUE_DATE_MISMATCH']) {
        assert.equal(RULES[ruleId].determinism, 'DETERMINISTIC');
    }
});

test('a blank title, revision or date is unknown, not different', () => {
    const fixture = setOf([['A-101', 'plan', 'A', '2026.10.05'], ['A-101', '', '', '']]);
    run(fixture);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 1);
    for (const ruleId of ['QA04_SAME_NUMBER_DIFFERENT_TITLE', 'QA05_REVISION_MISMATCH', 'QA06_ISSUE_DATE_MISMATCH']) assert.equal(active(fixture.model, ruleId).length, 0);
});

test('QA07 / QA08: sheets outside a class more than half the set shares; no majority, no outlier', () => {
    const a3 = { facts: { ...A3 } };
    const portrait = { facts: { uprightWidthPt: A1.uprightHeightPt, uprightHeightPt: A1.uprightWidthPt } };
    const rotated = { facts: { rotate: 90 } };
    const fixture = setOf([['A-1'], ['A-2'], ['A-3'], ['A-4'], ['A-5', 't', 'A', 'd', a3], ['A-6', 't', 'A', 'd', portrait], ['A-7', 't', 'A', 'd', rotated]]);
    run(fixture);
    const [size] = active(fixture.model, 'QA07_SHEET_SIZE_OUTLIER');
    assert.deepEqual(size.params, { sizeClass: 'A3', majoritySizeClass: 'A1', count: 1, majorityCount: 6 });
    assert.deepEqual(size.sheetIds, [fixture.sheets[4].id]);
    assert.equal(size.determinism, 'CANDIDATE');
    const [orientation] = active(fixture.model, 'QA08_ORIENTATION_OUTLIER');
    assert.deepEqual(orientation.params, { orientation: 'portrait', majorityOrientation: 'landscape', count: 2, majorityCount: 5 });
    assert.deepEqual([...orientation.sheetIds].sort(), [fixture.sheets[5].id, fixture.sheets[6].id].sort());

    const split = setOf([['A-1'], ['A-2'], ['A-3', 't', 'A', 'd', a3], ['A-4', 't', 'A', 'd', a3]]);
    run(split);
    assert.equal(active(split.model, 'QA07_SHEET_SIZE_OUTLIER').length, 0, 'two against two has no majority');
});

test('QA10 (manifest): M7\'s own Sheet list against the pages the source actually has', () => {
    const fixture = setOf([['A-101'], ['A-102'], ['A-103']]);
    run(fixture);
    const mismatch = () => active(fixture.model, 'QA10_INTEGRITY').filter((f) => f.params.reason.endsWith('_PAGE') || f.params.reason.endsWith('_SHEET'));
    assert.equal(mismatch().length, 0);

    // A page with no sheet (a sheet was retired by hand)...
    fixture.sheets[2].retiredAt = new Date(fixture.tick()).toISOString();
    run(fixture);
    const [missing] = mismatch();
    assert.deepEqual(missing.params, { reason: 'PAGE_WITHOUT_SHEET', count: 1 });
    assert.equal(missing.scope, 'SOURCE');
    assert.equal(missing.determinism, 'DETERMINISTIC');

    // ...and a sheet with no page (the manifest says the file is shorter).
    fixture.source.fingerprint.pageCount = 1;
    run(fixture);
    assert.deepEqual(mismatch().map((f) => f.params.reason), ['SHEET_WITHOUT_PAGE']);
    // It is bookkeeping, and it does not need the Source to be bound to be known.
    assert.equal(missing.lifecycle.state, 'NOT_REPRODUCED');
    // None of this is QA09: with no declared register QA09 says nothing at all.
    assert.equal(fixture.model.drawingSet.findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH').length, 0);
});

test('QA10: a source that is not the bytes the project remembers, and a file with a strange history', () => {
    for (const state of [BINDING.MISSING, BINDING.CHANGED, BINDING.AMBIGUOUS]) {
        const fixture = setOf([['A-101']], { bindingState: state });
        run(fixture);
        const [finding] = active(fixture.model, 'QA10_INTEGRITY');
        assert.equal(finding.params.reason, `SOURCE_${state}`);
        assert.deepEqual(finding.sourceIds, [fixture.source.id]);
        // Bound correctly, the condition is gone -- and is recorded as gone.
        fixture.bindings.set(fixture.source.id, BINDING.MATCHED);
        run(fixture);
        assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    }

    const warned = setOf([['A-101']]);
    const warnings = [{ code: 'WARN_TIMESTAMP_IN_FUTURE', path: '/savedAt', message: '' }];
    run(warned, { importWarnings: warnings });
    const [project] = active(warned.model, 'QA10_INTEGRITY');
    assert.equal(project.scope, 'PROJECT');
    assert.deepEqual(project.params, { reason: 'PROJECT_FILE_ANOMALY', count: 1 });
    // A run that was not told the warnings has not looked at the file, and closes nothing.
    run(warned);
    assert.equal(project.lifecycle.state, 'ACTIVE');
    // A run told the same warnings recognises the same finding.
    run(warned, { importWarnings: warnings });
    assert.equal(active(warned.model, 'QA10_INTEGRITY')[0].id, project.id);
    // A run told there are none has looked, and the condition is gone.
    run(warned, { importWarnings: [] });
    assert.equal(project.lifecycle.state, 'NOT_REPRODUCED');
});

test('QA10 does not call an unlooked-for source abnormal, and does not close a finding it did not re-check', () => {
    const fixture = setOf([['A-101']], { bindingState: BINDING.MISSING });
    run(fixture);
    const [finding] = active(fixture.model, 'QA10_INTEGRITY');
    // Next session: nothing selected yet.
    fixture.bindings.set(fixture.source.id, BINDING.UNBOUND);
    const { summary } = run(fixture);
    assert.equal(finding.lifecycle.state, 'ACTIVE');
    assert.equal(summary.leftStale, 1);
    const fresh = setOf([['A-101']], { bindingState: BINDING.UNBOUND });
    run(fresh);
    assert.equal(active(fresh.model, 'QA10_INTEGRITY').length, 0);
});

// -- machine values vs. Human values ----------------------------------------

test('a confirmed value overrides the observed one; an unconfirmed observation is still evaluated', () => {
    const fixture = setOf([['A-101'], ['A-1O1', 't', 'A', 'd', { confirmed: false }]]);
    run(fixture);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 0);
    // A person reads the sheet and corrects the OCR's letter O to a zero.
    confirmSheet(fixture.model, fixture.sheets[1].id, { drawingNumber: 'A-101' }, fixture.tick());
    run(fixture);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER').length, 1);
    assert.deepEqual(fixture.sheets[1].confirmation.editedFields, ['drawingNumber']);
    // The machine's reading is not overwritten by the correction.
    assert.equal(fixture.sheets[1].observation.fields.drawingNumber.value, 'A-1O1');
});

test('an OCR score never confirms anything', () => {
    const fixture = setOf([['A-101', 't', 'A', 'd', { confirmed: false }]]);
    fixture.sheets[0].observation.fields.drawingNumber.ocrScore = 100;
    fixture.sheets[0].observation.fields.drawingNumber.source = 'ocr';
    run(fixture);
    assert.equal(fixture.sheets[0].confirmation, null);
    assert.equal(active(fixture.model, 'QA02_METADATA_UNCONFIRMED').length, 1);
});

// -- reconciliation ---------------------------------------------------------

test('a re-run that finds the same thing keeps the finding, its identity and its decision', () => {
    const fixture = setOf([['A-101'], ['A-101'], ['A-102']]);
    run(fixture);
    const [finding] = active(fixture.model, 'QA01_DUPLICATE_NUMBER');
    const { decision } = decide(fixture.model, finding.id, { outcome: 'INTENTIONAL', comment: 'key plan repeated on purpose', now: fixture.tick(), newId: fixture.newId });
    const findingsBefore = fixture.model.drawingSet.findings.length;
    for (let i = 0; i < 3; i += 1) run(fixture);
    assert.equal(fixture.model.drawingSet.findings.length, findingsBefore);
    assert.equal(active(fixture.model, 'QA01_DUPLICATE_NUMBER')[0].id, finding.id);
    assert.equal(effectiveDecisions(fixture.model).get(finding.id), decision);
});

test('changed evidence supersedes: a third sheet joining a duplicate asks the question again', () => {
    const fixture = setOf([['A-101'], ['A-101'], ['A-102']]);
    run(fixture);
    const [first] = active(fixture.model, 'QA01_DUPLICATE_NUMBER');
    decide(fixture.model, first.id, { outcome: 'INTENTIONAL', now: fixture.tick(), newId: fixture.newId });

    confirmSheet(fixture.model, fixture.sheets[2].id, { drawingNumber: 'A-101' }, fixture.tick());
    run(fixture);
    const [second] = active(fixture.model, 'QA01_DUPLICATE_NUMBER');
    assert.notEqual(second.id, first.id);
    assert.equal(second.findingKey, first.findingKey);
    assert.equal(first.lifecycle.state, 'SUPERSEDED');
    assert.equal(first.lifecycle.supersededByFindingId, second.id);
    assert.equal(second.sheetIds.length, 3);
    // "Two on purpose" was not a decision about three.
    assert.equal(effectiveDecisions(fixture.model).has(second.id), false);
    assert.equal(effectiveDecisions(fixture.model).get(first.id).outcome, 'INTENTIONAL');
});

test('a finding is never deleted to resolve it, and a decision can be changed without losing the earlier one', () => {
    const fixture = setOf([['A-101'], ['A-101']]);
    run(fixture);
    const [finding] = active(fixture.model, 'QA01_DUPLICATE_NUMBER');
    decide(fixture.model, finding.id, { outcome: 'HOLD', comment: 'asking the architect', now: fixture.tick(), newId: fixture.newId });
    decide(fixture.model, finding.id, { outcome: 'ACTION_REQUIRED', comment: 'renumber the second sheet', now: fixture.tick(), newId: fixture.newId });
    const history = fixture.model.drawingSet.decisions.filter((d) => d.findingId === finding.id);
    assert.deepEqual(history.map((d) => [d.sequence, d.outcome]), [[1, 'HOLD'], [2, 'ACTION_REQUIRED']]);
    assert.equal(effectiveDecisions(fixture.model).get(finding.id).outcome, 'ACTION_REQUIRED');

    // The drawing is fixed. The finding stops being reproduced; it and both decisions remain.
    confirmSheet(fixture.model, fixture.sheets[1].id, { drawingNumber: 'A-102' }, fixture.tick());
    run(fixture);
    assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    assert.ok(fixture.model.drawingSet.findings.includes(finding));
    assert.equal(fixture.model.drawingSet.decisions.filter((d) => d.findingId === finding.id).length, 2);
});

test('findings and decisions survive save and resume, and the first run after resume recognises them', () => {
    const fixture = setOf([['A-101'], ['A-101'], ['A-103'], ['A-105']]);
    run(fixture);
    for (const finding of fixture.model.drawingSet.findings) decide(fixture.model, finding.id, { outcome: 'FALSE_POSITIVE', now: fixture.tick(), newId: fixture.newId });
    const ids = seededUuidSource(1);
    const bytes = exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() }).bytes;
    const reopened = importProject(bytes, { now: fixture.tick() }).project;

    const before = JSON.stringify(reopened.drawingSet);
    const result = runQa(reopened, fixture.bindings, { now: fixture.tick(), newId: fixture.newId });
    assert.equal(result.run, null);
    assert.equal(result.summary.kept, reopened.drawingSet.findings.length);
    assert.equal(JSON.stringify(reopened.drawingSet), before);
});

test('a finding in a file is only ever recognised, never believed: a forged one is closed by the first run', () => {
    const fixture = setOf([['A-101'], ['A-102']]);
    run(fixture);
    const ids = seededUuidSource(2);
    const document = exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() }).document;
    // Someone edits the file to claim a duplicate that the metadata does not show.
    const qaRun = document.drawingSet.analysisRuns.find((r) => r.kind === 'QA') ?? document.drawingSet.analysisRuns[0];
    const forgedRun = { ...qaRun, id: ids(), kind: 'QA', engine: { name: 'drawing-set-qa', version: 't' } };
    document.drawingSet.analysisRuns.push(forgedRun);
    const forged = {
        id: ids(), runId: forgedRun.id, ruleId: 'QA01_DUPLICATE_NUMBER', ruleVersion: 1, determinism: 'DETERMINISTIC', scope: 'SHEET_GROUP',
        sheetIds: document.drawingSet.sheets.map((s) => s.id), sourceIds: [], registerEntryIds: [],
        findingKey: sha256HexOfText('forged-key'), evidenceDigest: sha256HexOfText('forged-evidence'),
        basis: [{ sourceId: document.drawingSet.sources[0].id, sha256: document.drawingSet.sources[0].fingerprint.sha256 }],
        params: { number: 'A-101', count: 2 }, createdAt: document.savedAt,
        lifecycle: { state: 'ACTIVE', supersededByFindingId: null, closedByRunId: null, closedAt: null },
    };
    document.drawingSet.findings.push(forged);
    const verdict = importProject(new TextEncoder().encode(JSON.stringify(document)), { now: fixture.tick() });
    assert.equal(verdict.status, 'ACCEPTED', 'well-formed, so it is read');
    runQa(verdict.project, fixture.bindings, { now: fixture.tick(), newId: fixture.newId });
    const after = verdict.project.drawingSet.findings.find((f) => f.id === forged.id);
    assert.equal(after.lifecycle.state, 'NOT_REPRODUCED');
});

test('the evaluation is a pure function: it does not change the model and does not depend on sheet order', () => {
    const fixture = setOf([['A-101'], ['A-101'], ['A-103'], ['A-104', 't', 'A', 'd', { facts: { ...A3 } }], ['Ａ－１０３']]);
    const frozen = JSON.stringify(fixture.model);
    const forward = evaluateRules(fixture.model, fixture.bindings).drafts;
    assert.equal(JSON.stringify(fixture.model), frozen);

    const shuffled = structuredClone(fixture.model);
    shuffled.drawingSet.sheets.reverse();
    const backward = evaluateRules(shuffled, fixture.bindings).drafts;
    const identity = (drafts) => drafts.map((d) => `${d.findingKey}:${d.evidenceDigest}`).sort();
    assert.deepEqual(identity(backward), identity(forward));
});

test('every rule the schema names is implemented, and every finding states only what the schema allows', () => {
    const fixture = setOf([['A-101'], ['A-101', 'x', 'B', '2026.01.01'], ['A-103'], ['Ａ－１０３'], ['A-9', 't', 'A', 'd', { facts: { ...A3 } }], ['A-8', 't', 'A', 'd', { confirmed: false }]]);
    run(fixture);
    const ids = seededUuidSource(3);
    // The export validates every finding against the schema; this would throw.
    const { document } = exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() });
    const produced = new Set(document.drawingSet.findings.map((f) => f.ruleId));
    for (const ruleId of ['QA01_DUPLICATE_NUMBER', 'QA01B_DUPLICATE_NUMBER_VARIANT', 'QA02_METADATA_UNCONFIRMED', 'QA03_NUMBER_GAP', 'QA04_SAME_NUMBER_DIFFERENT_TITLE', 'QA05_REVISION_MISMATCH', 'QA06_ISSUE_DATE_MISMATCH', 'QA07_SHEET_SIZE_OUTLIER']) {
        assert.ok(produced.has(ruleId), ruleId);
    }
});
