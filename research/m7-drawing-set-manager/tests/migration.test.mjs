/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Old, current and future schema versions. There is no real predecessor of
 * version 1, so the old-version path is exercised with the synthetic v0 of
 * prototype/migrate.mjs -- a harness-only format nothing has ever written.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { seededUuidSource } from '../prototype/ids.mjs';
import { OPEN_STATUS, migrateV0toV1, openProject, syntheticV0Schema } from '../prototype/migrate.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { compileSchema } from '../prototype/schema-subset.mjs';
import { cloneDocument, smallProject, utf8 } from './helpers.mjs';

const { document: V1, importNow: NOW } = smallProject();

/** The same Project as a synthetic v0 file would have held it. */
function asV0(v1) {
    const old = cloneDocument(v1);
    old.schemaVersion = 0;
    old.saveSequence = old.lineage.saveSequence;
    old.previousProjectFileId = old.lineage.previousProjectFileId;
    delete old.lineage;
    for (const sheet of old.drawingSet.sheets) { sheet.pageIndex = sheet.pageNumber - 1; delete sheet.pageNumber; }
    return old;
}
const V0 = asV0(V1);
const bytesOf = (document) => utf8(JSON.stringify(document));

test('the synthetic v0 schema is a real schema and the v0 fixture conforms to it', () => {
    const problems = compileSchema(syntheticV0Schema()).validate(V0);
    assert.deepEqual(problems, []);
    // And v0 is genuinely not v1: the current reader will not take it.
    const direct = importProject(bytesOf(V0), { now: NOW });
    assert.equal(direct.status, 'REJECTED');
    assert.equal(direct.code, 'OLD_VERSION_REQUIRES_MIGRATION');
});

test('a current file opens as OPENED', () => {
    const opened = openProject(bytesOf(V1), { now: NOW });
    assert.equal(opened.status, OPEN_STATUS.OPENED);
    assert.deepEqual(opened.project, V1);
    assert.equal(opened.migration, undefined);
});

test('an old file is validated as old, converted in memory, and reported -- a distinct outcome', () => {
    const input = bytesOf(V0);
    const snapshot = input.slice();
    const opened = openProject(input, { now: NOW });
    assert.equal(opened.status, OPEN_STATUS.MIGRATED_IN_MEMORY);
    assert.deepEqual(opened.migration, {
        fromVersion: 0, toVersion: 1,
        steps: [{
            from: 0, to: 1, changes: [
                { code: 'LINEAGE_GROUPED', count: 1, detail: 'save sequence and previous file id moved into "lineage"' },
                { code: 'PAGE_NUMBERING', count: V1.drawingSet.sheets.length, detail: 'sheet pages renumbered from 0-based to 1-based' },
            ],
        }],
    });
    // The bytes that were read are untouched.
    assert.deepEqual(input, snapshot);

    // The content is the v1 Project, plus the record of where it came from.
    assert.equal(opened.project.schemaVersion, 1);
    assert.deepEqual(opened.project.drawingSet, V1.drawingSet);
    assert.deepEqual(opened.project.lineage.migratedFrom, {
        schemaVersion: 0, projectFileId: V0.projectFileId, migratedAt: new Date(NOW).toISOString(),
    });
});

test('a migrated Project leaves only as a new file that names the file it came from', () => {
    const opened = openProject(bytesOf(V0), { now: NOW });
    const ids = seededUuidSource(808);
    const saved = exportProject(opened.project, { now: NOW + 5000, newFileId: ids() });
    assert.notEqual(saved.document.projectFileId, V0.projectFileId);
    assert.equal(saved.document.lineage.previousProjectFileId, V0.projectFileId);
    assert.equal(saved.document.lineage.saveSequence, V0.saveSequence + 1);
    assert.equal(saved.document.lineage.migratedFrom.schemaVersion, 0);
    // And what was saved is an ordinary current file.
    const reopened = openProject(saved.bytes, { now: NOW + 6000 });
    assert.equal(reopened.status, OPEN_STATUS.OPENED);
});

test('an old file is held to its own schema before anything is converted', () => {
    const unknownField = cloneDocument(V0);
    unknownField.drawingSet.sheets[0].thumbnail = 'x';
    const a = openProject(bytesOf(unknownField), { now: NOW });
    assert.equal(a.status, OPEN_STATUS.REJECTED);
    assert.equal(a.stage, 'schema');
    assert.equal(a.code, 'SCHEMA_UNKNOWN_FIELD');
    assert.equal(a.version, 0);

    // A v0 file carrying a v1 field is not "nearly v1"; it is an invalid v0.
    const mixed = cloneDocument(V0);
    mixed.drawingSet.sheets[0].pageNumber = 1;
    assert.equal(openProject(bytesOf(mixed), { now: NOW }).code, 'SCHEMA_UNKNOWN_FIELD');

    const missing = cloneDocument(V0);
    delete missing.saveSequence;
    assert.equal(openProject(bytesOf(missing), { now: NOW }).code, 'SCHEMA_REQUIRED');
});

test('conversion earns no trust: the converted document is validated again as current', () => {
    // Structurally a perfect v0, relationally broken. Only the post-migration check can see it.
    const dangling = cloneDocument(V0);
    dangling.drawingSet.sheets[0].sourceId = seededUuidSource(1)();
    const opened = openProject(bytesOf(dangling), { now: NOW });
    assert.equal(opened.status, OPEN_STATUS.REJECTED);
    assert.equal(opened.stage, 'relations');
    assert.equal(opened.code, 'REL_DANGLING_SOURCE');
    assert.equal(opened.afterMigration, true);
    assert.equal(opened.project, undefined);
});

test('a future version is refused whatever else the file contains', () => {
    for (const version of [2, 7, 1000]) {
        const future = cloneDocument(V1);
        future.schemaVersion = version;
        const opened = openProject(bytesOf(future), { now: NOW });
        assert.equal(opened.status, OPEN_STATUS.REJECTED);
        assert.equal(opened.stage, 'version');
        assert.equal(opened.code, 'UNSUPPORTED_FUTURE_VERSION');
        assert.equal(opened.version, version);
        assert.equal(opened.project, undefined);
    }
});

test('an old version with no migration path is refused, not guessed at', () => {
    // Negative versions are unreadable; there is no version below 0 to have a path from.
    const negative = cloneDocument(V0);
    negative.schemaVersion = -1;
    assert.equal(openProject(bytesOf(negative), { now: NOW }).code, 'VERSION_UNREADABLE');
});

test('the migration is a pure function of its input', () => {
    const before = JSON.stringify(V0);
    const once = migrateV0toV1(V0, { now: NOW });
    const twice = migrateV0toV1(V0, { now: NOW });
    assert.equal(JSON.stringify(V0), before);
    assert.deepEqual(once, twice);
});

test('the bounds apply to an old file exactly as to a current one', () => {
    const deep = `{"format":"pdf-architools/drawing-set-project","schemaVersion":0,"x":${'['.repeat(500)}${']'.repeat(500)}}`;
    const opened = openProject(utf8(deep), { now: NOW });
    assert.equal(opened.status, OPEN_STATUS.REJECTED);
    assert.equal(opened.stage, 'scan');
    assert.equal(opened.code, 'NESTING_TOO_DEEP');
});
