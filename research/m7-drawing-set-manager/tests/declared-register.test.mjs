/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * QA09 as it was meant: a Drawing Register a person DECLARED, against the
 * sheets that are actually there. (Independent Architecture Review, RF-33-02.)
 *
 * Three things are held here. That a register exists only because a person
 * declared one, and that with none QA09 says nothing -- which is "not
 * evaluable", not "pass". That the two findings mean what they say. And that
 * the rows can come from the existing table engine through an adapter, with the
 * engine unchanged: the last tests run Production's `reconstructSelection` on a
 * synthetic list page and declare a register from what it returns.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import './ts-resolve-hook.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BINDING, FINAL_BLOCKER, FINDING_CURRENCY, REGISTER_STATUS, finalReadiness, findingCurrency, indexModel, registerCurrency, setCurrency } from '../prototype/currency.mjs';
import { seededUuidSource } from '../prototype/ids.mjs';
import {
    addProfile, addRegisterEntry, addSource, assignProfile, confirmSheet, decide, declareDrawingRegister, editRegisterEntry, effectiveDecisions,
    liveSheets, newProject, recordExtraction, replaceSourceFingerprint, retireDrawingRegister, retireRegisterEntry, retireSource,
} from '../prototype/model-ops.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { runQa } from '../prototype/qa-rules.mjs';
import { rowsFromTableCandidate, rowsFromTableGrid } from '../prototype/register-list-adapter.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';

const A1 = { uprightWidthPt: 2383.94, uprightHeightPt: 1683.78 };
const RECTS = {
    drawingNumber: { left: 2150, top: 1600, right: 2360, bottom: 1640 },
    drawingTitle: { left: 1850, top: 1600, right: 2140, bottom: 1640 },
    revision: { left: 2150, top: 1645, right: 2250, bottom: 1675 },
    issueDate: { left: 2255, top: 1645, right: 2360, bottom: 1675 },
};
const REGION = { left: 100, top: 100, right: 1400, bottom: 900 };

/** A confirmed Drawing Set whose sheets carry the given numbers, all in one source. */
function setOf(numbers) {
    const newId = seededUuidSource(numbers.length * 104729 + 7);
    let now = Date.UTC(2026, 9, 6);
    const tick = () => { now += 1000; return now; };
    const model = newProject({ name: 'QA09 test', now: tick(), newId });
    const profile = addProfile(model, { name: 'p', transferModel: 'corner-anchored', referencePage: A1, fields: RECTS, now: tick(), newId });
    const { source } = addSource(model, { displayName: 'set.pdf', sha256: sha256HexOfText(`qa09:${numbers.join('|')}`), byteLength: 4321, pageCount: numbers.length, now: tick(), newId });
    const sheets = liveSheets(model);
    assignProfile(model, sheets.map((s) => s.id), profile.id, tick());
    const field = (value) => ({ value, rawText: value, source: 'native', ocrScore: null });
    recordExtraction(model, {
        results: sheets.map((sheet, i) => ({
            sheetId: sheet.id, status: 'READ', pageFacts: { ...A1, rotate: 0, kind: 'text-native' },
            fields: { drawingNumber: field(numbers[i]), drawingTitle: field(`title ${i + 1}`), revision: field('A'), issueDate: field('2026.10.06') },
        })),
        engineVersion: 't', now: tick(), newId,
    });
    for (const sheet of sheets) confirmSheet(model, sheet.id, {}, tick());
    const bindings = new Map([[source.id, BINDING.MATCHED]]);
    const run = (options = {}) => runQa(model, bindings, { now: tick(), newId, ...options });
    const declare = (rows, extra = {}) => declareDrawingRegister(model, { sourceId: source.id, pageNumber: 1, region: REGION, rows: rows.map((r) => (typeof r === 'string' ? { drawingNumber: r } : r)), now: tick(), newId, ...extra });
    const qa09 = (state = 'ACTIVE') => model.drawingSet.findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && f.lifecycle.state === state);
    const currency = (finding) => { const index = indexModel(model); return findingCurrency(finding, index, bindings, setCurrency(model, index)); };
    return { model, bindings, source, sheets, profile, newId, tick, run, declare, qa09, currency };
}
const reasons = (findings) => findings.map((f) => [f.params.reason, f.params.number]).sort();

// -- nothing is inferred ------------------------------------------------------

test('with no declared register QA09 states nothing, and that is "not evaluable", not a pass', () => {
    const fixture = setOf(['A-101', 'A-102', 'A-103']);
    fixture.run();
    assert.equal(fixture.model.drawingSet.findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH').length, 0);
    assert.equal(registerCurrency(fixture.model).status, REGISTER_STATUS.NOT_DESIGNATED);
    const readiness = finalReadiness(fixture.model, fixture.bindings);
    // The register is optional, so its absence does not block...
    assert.equal(readiness.final, true);
    // ...and the report is told, in so many words, that the comparison was not made.
    assert.deepEqual(readiness.notEvaluable, [{ ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'NO_DECLARED_REGISTER' }]);
});

test('a register exists only because a person declared one', () => {
    const fixture = setOf(['A-101', 'A-102']);
    // A list page being in the set, and its text having been read, declares nothing.
    fixture.run();
    assert.deepEqual(fixture.model.drawingSet.drawingRegisterReferences, []);
    const declared = fixture.declare(['A-101', 'A-102']);
    assert.equal(declared.ok, true);
    const reference = declared.reference;
    assert.equal(reference.sourceId, fixture.source.id);
    assert.equal(reference.pageNumber, 1);
    assert.deepEqual(reference.region, REGION);
    assert.equal(reference.sourceSha256, fixture.source.fingerprint.sha256);
    assert.equal(reference.method, 'TABLE_NATIVE');
    assert.deepEqual(reference.entries.map((e) => [e.row, e.drawingNumber, e.origin, e.retiredAt]), [[1, 'A-101', 'EXTRACTED', null], [2, 'A-102', 'EXTRACTED', null]]);
});

test('a declaration is refused if it names no source, no page, no region, no rows, or a row with no number', () => {
    const fixture = setOf(['A-101']);
    const base = { sourceId: fixture.source.id, pageNumber: 1, region: REGION, rows: [{ drawingNumber: 'A-101' }], now: fixture.tick(), newId: fixture.newId };
    assert.equal(declareDrawingRegister(fixture.model, { ...base, sourceId: fixture.newId() }).code, 'NO_SUCH_SOURCE');
    assert.equal(declareDrawingRegister(fixture.model, { ...base, pageNumber: 2 }).code, 'NO_SUCH_PAGE');
    assert.equal(declareDrawingRegister(fixture.model, { ...base, region: null }).code, 'REGION_REQUIRED');
    assert.equal(declareDrawingRegister(fixture.model, { ...base, rows: [] }).code, 'EMPTY_REGISTER');
    assert.deepEqual(declareDrawingRegister(fixture.model, { ...base, rows: [{ drawingNumber: 'A-101' }, { drawingNumber: '  ' }] }), { ok: false, code: 'EMPTY_NUMBER', row: 2 });
    assert.deepEqual(fixture.model.drawingSet.drawingRegisterReferences, []);
    // Typed by a person, a register needs no region.
    const manual = declareDrawingRegister(fixture.model, { ...base, region: null, method: 'MANUAL' });
    assert.equal(manual.ok, true);
    assert.equal(manual.reference.entries[0].origin, 'MANUAL');
});

// -- the two findings ---------------------------------------------------------

test('LISTED_BUT_MISSING: an entry of the declared register with no live sheet carrying its number', () => {
    const fixture = setOf(['A-101', 'A-102']);
    const { reference } = fixture.declare(['A-101', 'A-102', 'A-103', 'S-201']);
    fixture.run();
    const findings = fixture.qa09();
    assert.deepEqual(reasons(findings), [['LISTED_BUT_MISSING', 'A-103'], ['LISTED_BUT_MISSING', 'S-201']]);
    const [missing] = findings.filter((f) => f.params.number === 'A-103');
    assert.equal(missing.determinism, 'DETERMINISTIC');
    assert.equal(missing.scope, 'REGISTER_ENTRY');
    assert.deepEqual(missing.registerEntryIds, [reference.entries[2].id]);
    assert.deepEqual(missing.sheetIds, []);
    // It is stated against the bytes the register was declared from.
    assert.deepEqual(missing.basis, [{ sourceId: fixture.source.id, sha256: fixture.source.fingerprint.sha256 }]);
    assert.equal(fixture.currency(missing).currency, FINDING_CURRENCY.CURRENT);
});

test('ACTUAL_NOT_LISTED: a live sheet whose number no entry of the declared register carries', () => {
    const fixture = setOf(['A-101', 'A-102', 'A-999']);
    fixture.declare(['A-101', 'A-102']);
    fixture.run();
    const findings = fixture.qa09();
    assert.deepEqual(reasons(findings), [['ACTUAL_NOT_LISTED', 'A-999']]);
    assert.equal(findings[0].scope, 'SHEET');
    assert.deepEqual(findings[0].sheetIds, [fixture.sheets[2].id]);
    assert.deepEqual(findings[0].registerEntryIds, []);
});

test('a register that matches the set exactly produces no QA09 finding -- and this time that is a result', () => {
    const fixture = setOf(['A-101', 'A-102', 'A-103']);
    fixture.declare(['A-103', 'A-101', 'A-102']);
    fixture.run();
    assert.equal(fixture.qa09().length, 0);
    const readiness = finalReadiness(fixture.model, fixture.bindings);
    assert.equal(readiness.final, true);
    assert.deepEqual(readiness.notEvaluable, []);
});

test('correspondence is the exact drawing number; a spelling that would match once folded is a hint, never a match', () => {
    const fixture = setOf(['A-101', 'Ａ－１０２', 'a-103']);
    fixture.declare(['A-101', 'A-102', 'A-103']);
    fixture.run();
    const findings = fixture.qa09();
    assert.deepEqual(reasons(findings), [
        ['ACTUAL_NOT_LISTED', 'a-103'], ['ACTUAL_NOT_LISTED', 'Ａ－１０２'],
        ['LISTED_BUT_MISSING', 'A-102'], ['LISTED_BUT_MISSING', 'A-103'],
    ].sort());
    // Each says which spelling on the other side it nearly is.
    const by = (reason, number) => findings.find((f) => f.params.reason === reason && f.params.number === number);
    assert.deepEqual(by('LISTED_BUT_MISSING', 'A-102').params.values, ['Ａ－１０２']);
    assert.deepEqual(by('ACTUAL_NOT_LISTED', 'a-103').params.values, ['A-103']);
    // A plain miss carries no hint.
    const plain = setOf(['A-101']);
    plain.declare(['B-500']);
    plain.run();
    for (const finding of plain.qa09()) assert.equal(finding.params.values, undefined);
});

test('a sheet with no drawing number is outside QA09; a sheet nobody has read is left to QA02', () => {
    const fixture = setOf(['A-101', '', 'A-103']);
    fixture.declare(['A-101', 'A-103']);
    fixture.run();
    assert.equal(fixture.qa09().length, 0);
});

test('two sheets with one unlisted number are two findings; two entries with one missing number are two findings', () => {
    const fixture = setOf(['A-101', 'A-900', 'A-900']);
    const { reference } = fixture.declare(['A-101', 'A-500', 'A-500']);
    fixture.run();
    assert.deepEqual(reasons(fixture.qa09()), [['ACTUAL_NOT_LISTED', 'A-900'], ['ACTUAL_NOT_LISTED', 'A-900'], ['LISTED_BUT_MISSING', 'A-500'], ['LISTED_BUT_MISSING', 'A-500']]);
    assert.deepEqual(fixture.qa09().flatMap((f) => f.registerEntryIds).sort(), [reference.entries[1].id, reference.entries[2].id].sort());
});

test('a register may be declared from several pages; QA09 compares with all of them together', () => {
    const fixture = setOf(['A-101', 'A-102', 'A-103', 'A-104']);
    fixture.declare(['A-101', 'A-102']);
    fixture.run();
    assert.deepEqual(reasons(fixture.qa09()), [['ACTUAL_NOT_LISTED', 'A-103'], ['ACTUAL_NOT_LISTED', 'A-104']]);
    // The list continues on another page.
    fixture.declare(['A-103', 'A-104'], { pageNumber: 2 });
    fixture.run();
    assert.equal(fixture.qa09().length, 0);
    assert.equal(fixture.model.drawingSet.drawingRegisterReferences.length, 2);
});

// -- a person edits the register ----------------------------------------------

test('correcting an entry keeps its identity, marks it edited, and resolves what it caused', () => {
    const fixture = setOf(['A-101', 'A-102']);
    const { reference } = fixture.declare(['A-101', 'A-1O2']); // the table was misread: letter O
    fixture.run();
    const before = fixture.qa09();
    assert.deepEqual(reasons(before), [['ACTUAL_NOT_LISTED', 'A-102'], ['LISTED_BUT_MISSING', 'A-1O2']]);

    const entry = reference.entries[1];
    assert.deepEqual(editRegisterEntry(fixture.model, entry.id, { drawingNumber: 'A-102' }, fixture.tick()).ok, true);
    assert.equal(entry.origin, 'EDITED');
    assert.equal(editRegisterEntry(fixture.model, entry.id, { drawingNumber: ' ' }, fixture.tick()).code, 'EMPTY_NUMBER');
    fixture.run();
    assert.equal(fixture.qa09().length, 0);
    for (const finding of before) assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    // Nothing was deleted.
    assert.equal(fixture.model.drawingSet.findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH').length, 2);
});

test('a person can add a row the table did not yield, and remove one that is not a drawing', () => {
    const fixture = setOf(['A-101', 'A-102']);
    const { reference } = fixture.declare(['図面番号', 'A-101']); // the heading row was read as an entry
    fixture.run();
    assert.deepEqual(reasons(fixture.qa09()), [['ACTUAL_NOT_LISTED', 'A-102'], ['LISTED_BUT_MISSING', '図面番号']]);
    const heading = fixture.qa09().find((f) => f.params.reason === 'LISTED_BUT_MISSING');

    assert.equal(retireRegisterEntry(fixture.model, reference.entries[0].id, fixture.tick()).ok, true);
    const added = addRegisterEntry(fixture.model, reference.id, { drawingNumber: 'A-102', drawingTitle: 'typed in' }, { now: fixture.tick(), newId: fixture.newId });
    assert.equal(added.entry.origin, 'MANUAL');
    assert.equal(added.entry.row, 3);
    // Until a run looks again, the finding about the retired row is stale, not gone.
    assert.deepEqual(fixture.currency(heading), { currency: FINDING_CURRENCY.STALE, reasons: ['REGISTER_ENTRY_RETIRED'] });
    fixture.run();
    assert.equal(fixture.qa09().length, 0);
    assert.equal(heading.lifecycle.state, 'NOT_REPRODUCED');
    // The retired row is still in the file, so the finding's reference still resolves.
    const ids = seededUuidSource(5);
    assert.equal(importProject(exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() }).bytes, { now: fixture.tick() }).status, 'ACCEPTED');
});

// -- decisions ---------------------------------------------------------------

test('a decision on a QA09 finding survives re-runs, and survives edits that do not touch its evidence', () => {
    const fixture = setOf(['A-101', 'A-102', 'A-900']);
    const { reference } = fixture.declare(['A-101', 'A-102', 'A-300']);
    fixture.run();
    const notListed = fixture.qa09().find((f) => f.params.reason === 'ACTUAL_NOT_LISTED');
    const missing = fixture.qa09().find((f) => f.params.reason === 'LISTED_BUT_MISSING');
    decide(fixture.model, notListed.id, { outcome: 'INTENTIONAL', comment: 'reference sheet, deliberately not in the list', now: fixture.tick(), newId: fixture.newId });
    decide(fixture.model, missing.id, { outcome: 'ACTION_REQUIRED', comment: 'A-300 has not been issued yet', now: fixture.tick(), newId: fixture.newId });
    fixture.run();
    // An unrelated row is corrected.
    editRegisterEntry(fixture.model, reference.entries[0].id, { drawingTitle: 'corrected title' }, fixture.tick());
    fixture.run();
    assert.deepEqual(fixture.qa09().map((f) => f.id).sort(), [notListed.id, missing.id].sort());
    assert.equal(effectiveDecisions(fixture.model).get(notListed.id).outcome, 'INTENTIONAL');
    assert.equal(finalReadiness(fixture.model, fixture.bindings).final, true);
});

// -- staleness ---------------------------------------------------------------

test('a register is bound to the bytes it was declared from: replace them and QA09 is not evaluated', () => {
    const fixture = setOf(['A-101', 'A-102']);
    fixture.declare(['A-101', 'A-102', 'A-103']);
    fixture.run();
    const [missing] = fixture.qa09();
    decide(fixture.model, missing.id, { outcome: 'ACTION_REQUIRED', now: fixture.tick(), newId: fixture.newId });

    replaceSourceFingerprint(fixture.model, fixture.source.id, { sha256: sha256HexOfText('reissued'), byteLength: 99, pageCount: 2, now: fixture.tick(), newId: fixture.newId });
    assert.equal(registerCurrency(fixture.model).status, REGISTER_STATUS.STALE);
    assert.equal(fixture.currency(missing).currency, FINDING_CURRENCY.STALE);

    // Re-read and re-confirm the sheets, so only the register is behind.
    recordExtraction(fixture.model, {
        results: fixture.sheets.map((s) => ({ sheetId: s.id, status: 'READ', pageFacts: { ...A1, rotate: 0, kind: 'text-native' }, fields: Object.fromEntries(Object.entries(s.observation.fields).map(([k, v]) => [k, { ...v }])) })),
        engineVersion: 't', now: fixture.tick(), newId: fixture.newId,
    });
    for (const sheet of fixture.sheets) confirmSheet(fixture.model, sheet.id, {}, fixture.tick());
    const { summary } = fixture.run();
    // The run compared nothing with the stale register: it neither restated the finding nor closed it.
    assert.equal(missing.lifecycle.state, 'ACTIVE');
    assert.ok(summary.leftStale >= 1);
    assert.equal(fixture.qa09().length, 1);

    const readiness = finalReadiness(fixture.model, fixture.bindings);
    assert.equal(readiness.final, false);
    assert.ok(readiness.blockers.some((b) => b.code === FINAL_BLOCKER.REGISTER_NOT_CURRENT && b.count === 1));
    assert.deepEqual(readiness.notEvaluable, [{ ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'DECLARED_REGISTER_NOT_CURRENT' }]);
});

test('declaring the register again is a new reference; the old one is retired and its findings are closed, with their decisions kept', () => {
    const fixture = setOf(['A-101', 'A-102']);
    const first = fixture.declare(['A-101', 'A-102', 'A-103']).reference;
    fixture.run();
    const [old] = fixture.qa09();
    decide(fixture.model, old.id, { outcome: 'HOLD', now: fixture.tick(), newId: fixture.newId });

    assert.equal(retireDrawingRegister(fixture.model, first.id, fixture.tick()).ok, true);
    const second = fixture.declare(['A-101', 'A-102', 'A-103']).reference;
    assert.notEqual(second.id, first.id);
    fixture.run();
    assert.equal(old.lifecycle.state, 'NOT_REPRODUCED');
    const [fresh] = fixture.qa09();
    assert.notEqual(fresh.id, old.id);
    assert.deepEqual(fresh.registerEntryIds, [second.entries[2].id]);
    // A decision about the old declaration is not a decision about the new one.
    assert.equal(effectiveDecisions(fixture.model).has(fresh.id), false);
    assert.equal(effectiveDecisions(fixture.model).get(old.id).outcome, 'HOLD');
    assert.ok(fixture.model.drawingSet.drawingRegisterReferences.includes(first));
});

test('withdrawing the register closes its findings: with nothing declared there is no QA09 finding', () => {
    const fixture = setOf(['A-101', 'A-900']);
    const { reference } = fixture.declare(['A-101', 'A-300']);
    fixture.run();
    const findings = fixture.qa09();
    assert.equal(findings.length, 2);
    retireDrawingRegister(fixture.model, reference.id, fixture.tick());
    // Before a run looks again they are stale...
    for (const finding of findings) assert.equal(fixture.currency(finding).currency, FINDING_CURRENCY.STALE);
    fixture.run();
    // ...and then closed, not deleted.
    assert.equal(fixture.qa09().length, 0);
    for (const finding of findings) assert.equal(finding.lifecycle.state, 'NOT_REPRODUCED');
    assert.deepEqual(finalReadiness(fixture.model, fixture.bindings).notEvaluable, [{ ruleId: 'QA09_REGISTER_SHEET_MISMATCH', reason: 'NO_DECLARED_REGISTER' }]);
});

test('"listed but missing" is unverified while a sheet has not been read: the unread sheet might be the one', () => {
    const fixture = setOf(['A-101', 'A-102']);
    fixture.declare(['A-101', 'A-102', 'A-103']);
    // A third sheet arrives and nobody has read it yet.
    const added = addSource(fixture.model, { displayName: 'late.pdf', sha256: sha256HexOfText('late'), byteLength: 5, pageCount: 1, now: fixture.tick(), newId: fixture.newId });
    fixture.bindings.set(added.source.id, BINDING.MATCHED);
    fixture.run();
    const missing = fixture.qa09().find((f) => f.params.reason === 'LISTED_BUT_MISSING');
    assert.deepEqual(fixture.currency(missing), { currency: FINDING_CURRENCY.UNVERIFIED, reasons: ['SET_NOT_FULLY_EVALUATED'] });
});

test('a register goes with its Source when the Source is retired', () => {
    const fixture = setOf(['A-101']);
    const { reference } = fixture.declare(['A-101', 'A-102']);
    retireSource(fixture.model, fixture.source.id, fixture.tick());
    assert.notEqual(reference.retiredAt, null);
    assert.equal(registerCurrency(fixture.model).status, REGISTER_STATUS.NOT_DESIGNATED);
});

// -- the file ---------------------------------------------------------------

test('a declared register round-trips, and holds field-level rows and nothing else', () => {
    const fixture = setOf(['A-101', 'A-102']);
    fixture.declare([{ drawingNumber: 'A-101', drawingTitle: '1階平面図', revision: 'B', issueDate: '2026.10.06' }, { drawingNumber: 'A-103' }]);
    fixture.run();
    const ids = seededUuidSource(77);
    const exported = exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() });
    const reopened = importProject(exported.bytes, { now: fixture.tick() });
    assert.equal(reopened.status, 'ACCEPTED');
    const [reference] = reopened.project.drawingSet.drawingRegisterReferences;
    assert.deepEqual(Object.keys(reference), ['id', 'sourceId', 'pageNumber', 'region', 'sourceSha256', 'method', 'declaredAt', 'updatedAt', 'retiredAt', 'entries']);
    assert.deepEqual(Object.keys(reference.entries[0]), ['id', 'row', 'drawingNumber', 'drawingTitle', 'revision', 'issueDate', 'origin', 'retiredAt']);
    assert.deepEqual(reference.entries[1], { ...reference.entries[1], drawingTitle: null, revision: null, issueDate: null });
    // The first run after resume recognises the QA09 findings it finds in the file.
    const before = JSON.stringify(reopened.project.drawingSet);
    const result = runQa(reopened.project, fixture.bindings, { now: fixture.tick(), newId: fixture.newId });
    assert.equal(result.run, null);
    assert.equal(JSON.stringify(reopened.project.drawingSet), before);
});

test('a file whose declared register does not hold together is refused whole', () => {
    const fixture = setOf(['A-101', 'A-102']);
    fixture.declare(['A-101', 'A-103', 'A-104']);
    fixture.run();
    const ids = seededUuidSource(80);
    const now = fixture.tick();
    const valid = exportProject(fixture.model, { now, newFileId: ids() }).document;
    const damaged = (mutate) => {
        const copy = JSON.parse(JSON.stringify(valid));
        mutate(copy.drawingSet, copy);
        return importProject(new TextEncoder().encode(JSON.stringify(copy)), { now: now + 1000 });
    };
    const refused = (mutate, stage, code) => {
        const verdict = damaged(mutate);
        assert.equal(verdict.status, 'REJECTED', code);
        assert.equal(verdict.stage, stage, JSON.stringify(verdict.problems?.slice(0, 2)));
        assert.equal(verdict.code, code, JSON.stringify(verdict.problems?.slice(0, 2)));
        assert.equal(verdict.project, undefined);
    };
    assert.equal(damaged(() => {}).status, 'ACCEPTED');

    // A finding about a register entry that is not there.
    refused((set) => { set.findings.find((f) => f.registerEntryIds.length > 0).registerEntryIds[0] = ids(); }, 'relations', 'REL_DANGLING_REGISTER_ENTRY');
    // A REGISTER_ENTRY finding that cites no entry.
    refused((set) => { set.findings.find((f) => f.scope === 'REGISTER_ENTRY').registerEntryIds = []; }, 'relations', 'REL_FINDING_SUBJECT');
    // An entry that names no drawing; two entries on one row; an entry sharing an id with a sheet.
    refused((set) => { set.drawingRegisterReferences[0].entries[0].drawingNumber = ' '; }, 'relations', 'REL_REGISTER');
    refused((set) => { set.drawingRegisterReferences[0].entries[1].row = set.drawingRegisterReferences[0].entries[0].row; }, 'relations', 'REL_REGISTER');
    refused((set) => { set.drawingRegisterReferences[0].entries[0].id = set.sheets[0].id; }, 'relations', 'REL_DUPLICATE_ID');
    // A register declared from a source that is not in the manifest, or that has been retired.
    refused((set) => { set.drawingRegisterReferences[0].sourceId = ids(); }, 'relations', 'REL_DANGLING_SOURCE');
    refused((set) => {
        set.sources[0].retiredAt = valid.savedAt;
        for (const sheet of set.sheets) sheet.retiredAt = valid.savedAt;
    }, 'relations', 'REL_RETIRED_STATE');
    // Read from a table, it says where the table was -- and where is a real rectangle.
    refused((set) => { set.drawingRegisterReferences[0].region = null; }, 'relations', 'REL_REGISTER');
    refused((set) => { set.drawingRegisterReferences[0].region.right = set.drawingRegisterReferences[0].region.left; }, 'relations', 'REL_RECT_INVALID');
    // A register with no rows, or with anything but rows, is not a shape the schema has.
    refused((set) => { set.drawingRegisterReferences[0].entries = []; }, 'schema', 'SCHEMA_ARRAY_LENGTH');
    refused((set) => { set.drawingRegisterReferences[0].entries[0].cellText = 'x'; }, 'schema', 'SCHEMA_UNKNOWN_FIELD');
    refused((set) => { set.drawingRegisterReferences[0].method = 'OCR'; }, 'schema', 'SCHEMA_ENUM');
    refused((set) => { set.drawingRegisterReferences[0].entries[0].origin = 'GUESSED'; }, 'schema', 'SCHEMA_ENUM');
    refused((set) => { delete set.drawingRegisterReferences; }, 'schema', 'SCHEMA_REQUIRED');
    // Retired properly -- the register with its source -- it is an ordinary file.
    assert.equal(damaged((set) => {
        set.sources[0].retiredAt = valid.savedAt;
        for (const sheet of set.sheets) sheet.retiredAt = valid.savedAt;
        set.drawingRegisterReferences[0].retiredAt = valid.savedAt;
    }).status, 'ACCEPTED');
});

test('what a session hangs on a register does not reach the file', () => {
    const fixture = setOf(['A-101']);
    const { reference } = fixture.declare(['A-101']);
    reference.pageText = 'every word on the list page';
    reference.tokens = [{ text: 'A-101', x0: 0, y0: 0, x1: 1, y1: 1 }];
    reference.grid = [['図面番号', '図面名称'], ['A-101', '平面図']];
    reference.candidate = { status: 'GRID_CONFIDENT', structureScore: 91 };
    reference.entries[0].cellImage = 'data:image/png;base64,AAAA';
    const ids = seededUuidSource(78);
    const { text } = exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() });
    for (const leak of ['every word on the list page', 'pageText', 'tokens', '"grid"', 'candidate', 'structureScore', 'cellImage', 'data:image']) {
        assert.ok(!text.includes(leak), `"${leak}" reached the file`);
    }
});

// -- the existing table engine, unchanged, through the adapter ----------------

const tableEngine = await import('../../../src/utils/pdf-textifier/table-reconstruct.ts');

/** A synthetic drawing-list page as the table engine sees one: tokens and ruling lines, upright points. */
function listPage(cells, { ruled = true, scanned = false } = {}) {
    const columnEdges = [100, 260, 700, 800, 960];
    const rowHeight = 24;
    const top = 120;
    const token = (text, x, y) => ({ text, x0: x, y0: y, x1: x + Math.max(8, text.length * 7), y1: y + 10, width: Math.max(8, text.length * 7), height: 10, direction: { x: 1, y: 0 } });
    const tokens = [];
    cells.forEach((row, r) => row.forEach((text, c) => { if (text !== '') tokens.push(token(text, columnEdges[c] + 6, top + r * rowHeight + 7)); }));
    const segments = [];
    if (ruled) {
        const bottom = top + cells.length * rowHeight;
        for (let r = 0; r <= cells.length; r += 1) segments.push({ orientation: 'h', x0: columnEdges[0], y0: top + r * rowHeight, x1: columnEdges.at(-1), y1: top + r * rowHeight, length: columnEdges.at(-1) - columnEdges[0] });
        for (const x of columnEdges) segments.push({ orientation: 'v', x0: x, y0: top, x1: x, y1: bottom, length: bottom - top });
    }
    const chars = tokens.reduce((sum, t) => sum + t.text.length, 0);
    return {
        page: { pageNumber: 1, rotate: 0, displayWidth: 1190.55, displayHeight: 841.89, uprightWidth: 1190.55, uprightHeight: 841.89, tokens: scanned ? [] : tokens, segments: scanned ? [] : segments, scanned, allChars: chars, interiorChars: scanned ? 0 : chars },
        selection: { left: 90, top: 110, right: 970, bottom: top + cells.length * rowHeight + 10 },
    };
}
const LIST = [
    ['図面番号', '図面名称', '版', '日付'],
    ['A-101', '1階平面図', 'B', '2026.10.06'],
    ['A-102', '2階平面図', 'A', '2026.10.06'],
    ['A-103', '立面図', '', ''],
    ['', '（以下余白）', '', ''],
    ['S-201', '基礎伏図', 'A', '2026.09.30'],
];
const MAPPING = { columns: { drawingNumber: 0, drawingTitle: 1, revision: 2, issueDate: 3 }, skipRows: 1 };

test('Production reconstructSelection reads a ruled list page; the adapter turns its grid into register rows', async () => {
    const { page, selection } = listPage(LIST);
    const candidate = await tableEngine.reconstructSelection(page, selection);
    // A list with blank cells is, structurally, a grid that "needs review" -- the engine's
    // own judgement, and exactly why a person looks at the rows before declaring them.
    assert.equal(candidate.status, 'GRID_NEEDS_REVIEW');
    assert.equal(candidate.source, 'ruling');
    assert.deepEqual(candidate.grid, LIST);

    const adapted = rowsFromTableCandidate(candidate, MAPPING);
    assert.equal(adapted.ok, true);
    assert.equal(adapted.structureStatus, candidate.status);
    assert.deepEqual(adapted.rows.map((r) => [r.drawingNumber, r.drawingTitle, r.revision, r.issueDate]), [
        ['A-101', '1階平面図', 'B', '2026.10.06'],
        ['A-102', '2階平面図', 'A', '2026.10.06'],
        ['A-103', '立面図', null, null],
        ['S-201', '基礎伏図', 'A', '2026.09.30'],
    ]);
    // The row with no drawing number is not an entry, and is not dropped without a word either.
    assert.deepEqual(adapted.skipped, [{ gridRow: 5, reason: 'EMPTY_NUMBER' }]);
    // Where the table was is the engine's own grid box, in the same upright space as everything else.
    assert.deepEqual(adapted.region, candidate.bbox);
});

test('from a table a person pointed at to QA09, with the engine untouched', async () => {
    const fixture = setOf(['A-101', 'A-102', 'A-104']);
    const { page, selection } = listPage(LIST);
    const adapted = rowsFromTableCandidate(await tableEngine.reconstructSelection(page, selection), MAPPING);
    const declared = declareDrawingRegister(fixture.model, { sourceId: fixture.source.id, pageNumber: 1, region: adapted.region, rows: adapted.rows, now: fixture.tick(), newId: fixture.newId });
    assert.equal(declared.ok, true);
    fixture.run();
    assert.deepEqual(reasons(fixture.qa09()), [['ACTUAL_NOT_LISTED', 'A-104'], ['LISTED_BUT_MISSING', 'A-103'], ['LISTED_BUT_MISSING', 'S-201']]);
    // What is kept is the rows. The page's tokens and the grid are not on the model at all.
    assert.equal(JSON.stringify(fixture.model).includes('以下余白'), false);
    const ids = seededUuidSource(79);
    assert.equal(importProject(exportProject(fixture.model, { now: fixture.tick(), newFileId: ids() }).bytes, { now: fixture.tick() }).status, 'ACCEPTED');
});

test('an unruled list is read by the engine\'s geometry route, and adapts the same way', async () => {
    const { page, selection } = listPage(LIST.filter((row) => row[0] !== ''), { ruled: false });
    const candidate = await tableEngine.reconstructSelection(page, selection);
    assert.equal(candidate.source, 'geometry');
    assert.ok(['GRID_CONFIDENT', 'GRID_NEEDS_REVIEW'].includes(candidate.status), candidate.status);
    const adapted = rowsFromTableCandidate(candidate, MAPPING);
    assert.equal(adapted.ok, true);
    assert.deepEqual(adapted.rows.map((r) => r.drawingNumber), ['A-101', 'A-102', 'A-103', 'S-201']);
});

test('a scanned list page is refused by the engine, and nothing is declared from it', async () => {
    const { page, selection } = listPage(LIST, { scanned: true });
    const candidate = await tableEngine.reconstructSelection(page, selection);
    assert.equal(candidate.status, 'UNSUPPORTED_LAYOUT');
    assert.deepEqual(rowsFromTableCandidate(candidate, MAPPING), { ok: false, code: 'UNSUPPORTED_LAYOUT' });
    // Nothing table-shaped in the selection is refused the same way.
    const empty = await tableEngine.reconstructSelection(listPage(LIST).page, { left: 1000, top: 700, right: 1100, bottom: 800 });
    assert.equal(rowsFromTableCandidate(empty, MAPPING).ok, false);
});

test('the adapter keeps a cell on one line, bounds it, and insists on a drawing-number column', () => {
    const grid = [['No', 'Title'], ['A-101', 'line one\nline two'], ['A-102', 'x'.repeat(500)], ['  ', 'no number']];
    const { rows, skipped } = rowsFromTableGrid(grid, { columns: { drawingNumber: 0, drawingTitle: 1 }, skipRows: 1 });
    assert.equal(rows[0].drawingTitle, 'line one line two');
    assert.equal(rows[1].drawingTitle.length, 300);
    assert.deepEqual(rows.map((r) => [r.revision, r.issueDate]), [[null, null], [null, null]]);
    assert.deepEqual(skipped, [{ gridRow: 4, reason: 'EMPTY_NUMBER' }]);
    assert.throws(() => rowsFromTableGrid(grid, { columns: {} }), RangeError);
    assert.deepEqual(rowsFromTableCandidate({ status: 'GRID_CONFIDENT', grid: [['No'], ['']], bbox: REGION }, { columns: { drawingNumber: 0 }, skipRows: 1 }), { ok: false, code: 'NO_ROWS' });
});
