/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * A Project that is saved and opened again is the same Project.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { seededUuidSource } from '../prototype/ids.mjs';
import { ExportRefused, exportProject, importProject } from '../prototype/project-io.mjs';
import { limitsWith } from '../prototype/limits.proposed.mjs';
import { addSource, pruneUnreferencedRuns } from '../prototype/model-ops.mjs';
import { runQa } from '../prototype/qa-rules.mjs';
import { expectAccepted, smallProject, utf8 } from './helpers.mjs';

test('export -> import returns exactly the document that was written', () => {
    const { exported, importNow } = smallProject();
    const verdict = importProject(exported.bytes, { now: importNow });
    expectAccepted(assert, verdict);
    assert.deepEqual(verdict.project, exported.document);
    assert.deepEqual(verdict.warnings, []);
});

test('import -> export -> import is stable apart from the file identity and lineage', () => {
    const { exported, importNow } = smallProject();
    const first = importProject(exported.bytes, { now: importNow });
    const ids = seededUuidSource(9);
    const second = exportProject(first.project, { now: importNow + 1000, newFileId: ids() });
    const reopened = importProject(second.bytes, { now: importNow + 2000 });
    expectAccepted(assert, reopened);

    // Every save is a new file, one step along the lineage.
    assert.notEqual(reopened.project.projectFileId, first.project.projectFileId);
    assert.equal(reopened.project.lineage.previousProjectFileId, first.project.projectFileId);
    assert.equal(reopened.project.lineage.saveSequence, first.project.lineage.saveSequence + 1);

    // Nothing else moved.
    assert.deepEqual(reopened.project.project, first.project.project);
    assert.deepEqual(reopened.project.drawingSet, first.project.drawingSet);
});

test('the serialisation is canonical: the same model always gives the same bytes', () => {
    const a = smallProject();
    const b = smallProject();
    assert.equal(a.exported.text, b.exported.text);

    // And key order in memory does not leak into the file.
    const shuffled = JSON.parse(JSON.stringify(a.model));
    shuffled.drawingSet.sheets = shuffled.drawingSet.sheets.map((sheet) => Object.fromEntries(Object.entries(sheet).reverse()));
    const ids = seededUuidSource(4242);
    const again = exportProject(shuffled, { now: a.now, newFileId: ids() });
    assert.equal(again.text, a.exported.text);
});

test('a first save has sequence 1 and no previous file', () => {
    const { document } = smallProject();
    assert.equal(document.lineage.saveSequence, 1);
    assert.equal(document.lineage.previousProjectFileId, null);
    assert.equal(document.lineage.migratedFrom, null);
});

test('a Project can be saved in the middle of a review', () => {
    // No confirmations, no decisions, findings outstanding: still a valid file.
    const { model, now } = smallProject({ confirmedShare: 0, decidedShare: 0 });
    const ids = seededUuidSource(1);
    const exported = exportProject(model, { now, newFileId: ids() });
    expectAccepted(assert, importProject(exported.bytes, { now: now + 1 }));
    assert.equal(exported.document.drawingSet.decisions.length, 0);
    assert.ok(exported.document.drawingSet.findings.length > 0);
});

test('an empty Project round-trips', async () => {
    const { newProject } = await import('../prototype/model-ops.mjs');
    const ids = seededUuidSource(77);
    const now = Date.UTC(2026, 9, 5);
    const model = newProject({ name: 'Empty', now, newId: ids });
    const exported = exportProject(model, { now, newFileId: ids() });
    const verdict = importProject(exported.bytes, { now });
    expectAccepted(assert, verdict);
    assert.deepEqual(verdict.project.drawingSet.sheets, []);
});

test('the writer refuses to write what the reader would refuse', () => {
    const { model, now } = smallProject();
    const ids = seededUuidSource(3);

    const dangling = JSON.parse(JSON.stringify(model));
    dangling.drawingSet.sheets[0].sourceId = ids();
    assert.throws(() => exportProject(dangling, { now, newFileId: ids() }), (error) => {
        assert.ok(error instanceof ExportRefused);
        assert.equal(error.stage, 'relations');
        assert.equal(error.problems[0].code, 'REL_DANGLING_SOURCE');
        return true;
    });

    const tooLong = JSON.parse(JSON.stringify(model));
    tooLong.project.name = 'x'.repeat(201);
    assert.throws(() => exportProject(tooLong, { now, newFileId: ids() }), (error) => error instanceof ExportRefused && error.stage === 'schema');
});

test('the writer refuses a file larger than the reader would open', () => {
    const { model, now } = smallProject();
    const ids = seededUuidSource(5);
    const tiny = limitsWith({ maxProjectBytes: 1024 });
    assert.throws(() => exportProject(model, { now, newFileId: ids(), limits: tiny }), (error) => error instanceof ExportRefused && error.stage === 'bytes');
});

test('re-running QA with nothing changed writes nothing, so the file does not grow', () => {
    const { model, bindings, now, newId } = smallProject();
    const before = JSON.stringify(model.drawingSet);
    for (let i = 0; i < 5; i += 1) {
        const result = runQa(model, bindings, { now: now + i, newId });
        assert.equal(result.run, null);
        assert.deepEqual(result.summary, { kept: result.summary.kept, created: 0, superseded: 0, notReproduced: 0, leftStale: 0 });
    }
    assert.equal(JSON.stringify(model.drawingSet), before);
});

test('runs nothing refers to are pruned; Human history is not', () => {
    const { model, bindings, now, newId } = smallProject();
    const decisions = model.drawingSet.decisions.length;
    // A change that produces a new run...
    addSource(model, { displayName: 'extra.pdf', sha256: 'a'.repeat(64), byteLength: 5, pageCount: 1, now, newId });
    bindings.set(model.drawingSet.sources.at(-1).id, 'MATCHED');
    const changed = runQa(model, bindings, { now: now + 1, newId });
    assert.ok(changed.run);
    // ...and every run still referenced survives a prune.
    const runs = model.drawingSet.analysisRuns.length;
    assert.equal(pruneUnreferencedRuns(model), 0);
    assert.equal(model.drawingSet.analysisRuns.length, runs);
    assert.equal(model.drawingSet.decisions.length, decisions);
    const ids = seededUuidSource(8);
    expectAccepted(assert, importProject(exportProject(model, { now: now + 2, newFileId: ids() }).bytes, { now: now + 3 }));
});

test('pretty-printed and CRLF-terminated copies of a file are the same Project', () => {
    const { document, importNow } = smallProject();
    const pretty = JSON.stringify(document, null, 2);
    const crlf = pretty.replace(/\n/g, '\r\n');
    for (const text of [pretty, crlf]) {
        const verdict = importProject(utf8(text), { now: importNow });
        expectAccepted(assert, verdict);
        assert.deepEqual(verdict.project, document);
    }
});
