/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * A Portable Project JSON is a file from outside. Each test here hands the
 * importer something it must not accept, and checks three things: that it is
 * refused, *where* it is refused (the earliest stage that could have known),
 * and that the refusal carries no project.
 *
 * The large inputs are generated here and never written to disk.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanJsonBounds } from '../prototype/bounded-json.mjs';
import { CANDIDATE_LIMITS, limitsWith } from '../prototype/limits.proposed.mjs';
import { importProject } from '../prototype/project-io.mjs';
import {
    CHAR, cloneDocument, expectAccepted, expectRejected, importDocument, importText, smallProject, utf8,
} from './helpers.mjs';

const { document: VALID, importNow: NOW } = smallProject();
const options = { now: NOW };
const doc = () => cloneDocument(VALID);
const damaged = (mutate) => { const copy = doc(); mutate(copy); return importDocument(copy, options); };

// -- not JSON at all --------------------------------------------------------

test('invalid JSON is refused before any schema is consulted', () => {
    const text = JSON.stringify(VALID);
    expectRejected(assert, importText(text.slice(0, -40), options), 'scan', 'UNTERMINATED');
    expectRejected(assert, importText(text.replace('"schemaVersion":1', '"schemaVersion":1,,'), options), 'parse', 'INVALID_JSON');
    expectRejected(assert, importText(`${text}}`, options), 'scan', 'INVALID_JSON');
    expectRejected(assert, importText('{"format": tru}', options), 'parse', 'INVALID_JSON');
    expectRejected(assert, importText('not json', options), 'scan', 'NOT_AN_OBJECT');
});

test('an empty file, a non-object and a non-UTF-8 file are each named', () => {
    expectRejected(assert, importProject(new Uint8Array(0), options), 'bytes', 'EMPTY_INPUT');
    expectRejected(assert, importText('   \n  ', options), 'scan', 'EMPTY_INPUT');
    expectRejected(assert, importText('[1,2,3]', options), 'scan', 'NOT_AN_OBJECT');
    expectRejected(assert, importText('"just a string"', options), 'scan', 'NOT_AN_OBJECT');
    const bytes = utf8(JSON.stringify(VALID));
    bytes[20] = 0xff; // never valid in UTF-8
    expectRejected(assert, importProject(bytes, options), 'encoding', 'NOT_UTF8');
    // UTF-16, as Windows tools sometimes save. Its bytes happen to be valid
    // UTF-8 (every other one is NUL), so it gets as far as the scan.
    const utf16 = new Uint8Array(new Uint16Array([...'{"format":"x"}'].map((c) => c.charCodeAt(0))).buffer);
    expectRejected(assert, importProject(utf16, options), 'scan', 'INVALID_JSON');
});

test('a leading BOM is tolerated; it carries no content', () => {
    expectAccepted(assert, importText(CHAR.BOM + JSON.stringify(VALID), options));
});

// -- size, before anything is allocated -------------------------------------

test('a file over the byte bound is refused on its length alone', () => {
    const limits = limitsWith({ maxProjectBytes: 1000 });
    const verdict = importProject(utf8(JSON.stringify(VALID)), { ...options, limits });
    expectRejected(assert, verdict, 'bytes', 'PROJECT_TOO_LARGE');
    // Not decoded, not scanned, not parsed.
    assert.deepEqual(verdict.timings, {});
});

test('excessive nesting is refused by the scan, at any depth, without a stack', () => {
    for (const depth of [CANDIDATE_LIMITS.maxNestingDepth + 1, 1000, 200_000]) {
        const text = `{"a":${'['.repeat(depth)}${']'.repeat(depth)}}`;
        const started = performance.now();
        const verdict = importText(text, options);
        expectRejected(assert, verdict, 'scan', 'NESTING_TOO_DEEP');
        assert.ok(performance.now() - started < 2000, `depth ${depth} took too long`);
    }
    // Exactly at the limit, the scan itself has no objection.
    const depth = CANDIDATE_LIMITS.maxNestingDepth - 1;
    const atLimit = scanJsonBounds(`{"a":${'['.repeat(depth)}${']'.repeat(depth)}}`, CANDIDATE_LIMITS);
    assert.equal(atLimit.ok, true);
    assert.equal(atLimit.stats.maxDepth, CANDIDATE_LIMITS.maxNestingDepth);
});

test('a huge array is refused by count before JSON.parse builds it', () => {
    const limits = limitsWith({ maxJsonValues: 10_000 });
    const text = `{"format":"x","junk":[${'0,'.repeat(50_000)}0]}`;
    const verdict = importText(text, { ...options, limits });
    expectRejected(assert, verdict, 'scan', 'TOO_MANY_VALUES');
    assert.equal(verdict.timings.parseMs, undefined);
});

test('a huge string is refused by the scan; one just over a field bound by the schema', () => {
    // 10 MiB of base64-like payload where a comment should be.
    const payload = 'QUJD'.repeat((10 * 1024 * 1024) / 4);
    const big = doc();
    big.drawingSet.decisions[0].comment = payload;
    const started = performance.now();
    const verdict = importDocument(big, options);
    expectRejected(assert, verdict, 'scan', 'STRING_TOO_LONG');
    assert.ok(performance.now() - started < 3000);
    assert.equal(verdict.timings.parseMs, undefined);

    expectRejected(assert, damaged((d) => { d.drawingSet.decisions[0].comment = 'x'.repeat(CANDIDATE_LIMITS.maxCommentLength + 1); }), 'schema', 'SCHEMA_STRING_LENGTH');
    expectRejected(assert, damaged((d) => { d.project.name = 'x'.repeat(CANDIDATE_LIMITS.maxNameLength + 1); }), 'schema', 'SCHEMA_STRING_LENGTH');
    // At the bound exactly, it is a legal value.
    expectAccepted(assert, damaged((d) => { d.drawingSet.decisions[0].comment = 'x'.repeat(CANDIDATE_LIMITS.maxCommentLength); }));
});

test('a collection over its bound is refused without being walked', () => {
    const limits = limitsWith({ maxSheets: 10 });
    const verdict = importDocument(VALID, { ...options, limits });
    expectRejected(assert, verdict, 'schema', 'SCHEMA_ARRAY_LENGTH');
    assert.equal(verdict.problems[0].path, '/drawingSet/sheets');
    // The over-long array is reported once and none of its items is visited.
    assert.ok(verdict.problems.every((p) => !p.path.startsWith('/drawingSet/sheets/')));
});

test('a refusal lists a bounded number of problems, however many there are', () => {
    const verdict = damaged((d) => { for (const sheet of d.drawingSet.sheets) sheet.pageNumber = 'one'; });
    expectRejected(assert, verdict, 'schema', 'SCHEMA_TYPE');
    assert.ok(verdict.problems.length <= CANDIDATE_LIMITS.maxReportedProblems);
});

// -- keys -------------------------------------------------------------------

test('a duplicate key is refused, at any depth, however it is spelled', () => {
    const text = JSON.stringify(VALID);
    // JSON.parse alone would silently read this as version 2.
    const dup = text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":2');
    assert.equal(JSON.parse(dup).schemaVersion, 2);
    expectRejected(assert, importText(dup, options), 'scan', 'DUPLICATE_KEY');

    // The same key written with an escape is still the same key.
    const escaped = text.replace('"schemaVersion":1', `"schemaVersion":1,"schemaVersio${CHAR.BACKSLASH}u006e":2`);
    expectRejected(assert, importText(escaped, options), 'scan', 'DUPLICATE_KEY');

    const nested = text.replace('"saveSequence":1', '"saveSequence":1,"saveSequence":1');
    expectRejected(assert, importText(nested, options), 'scan', 'DUPLICATE_KEY');
});

test('an object wider than any the schema declares is refused by the scan, before its keys are collected', () => {
    const keys = Array.from({ length: CANDIDATE_LIMITS.maxObjectKeys + 1 }, (_, i) => `"k${i}":0`).join(',');
    const verdict = importText(`{${keys}}`, options);
    expectRejected(assert, verdict, 'scan', 'TOO_MANY_KEYS');
    assert.equal(verdict.timings.parseMs, undefined);
    // Two million keys cost no more than thirty-three.
    const many = Array.from({ length: 200_000 }, (_, i) => `"k${i}":0`).join(',');
    const started = performance.now();
    expectRejected(assert, importText(`{"format":"x","junk":{${many}}}`, options), 'scan', 'TOO_MANY_KEYS');
    assert.ok(performance.now() - started < 500);
    // The schema's own widest object fits with room to spare.
    assert.ok(Object.keys(VALID.drawingSet.findings[0]).length * 2 <= CANDIDATE_LIMITS.maxObjectKeys);
});

test('an unexpected key is refused, including the ones that are special in JavaScript', () => {
    expectRejected(assert, damaged((d) => { d.extra = 1; }), 'schema', 'SCHEMA_UNKNOWN_FIELD');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].thumbnail = 'data:image/png;base64,AAAA'; }), 'schema', 'SCHEMA_UNKNOWN_FIELD');
    expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].path = 'C:/work/a.pdf'; }), 'schema', 'SCHEMA_UNKNOWN_FIELD');

    const text = JSON.stringify(VALID);
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
        const verdict = importText(text.replace('"project":{', `"project":{"${key}":{"polluted":true},`), options);
        expectRejected(assert, verdict, 'schema', 'SCHEMA_UNKNOWN_FIELD');
    }
    // Nothing reached Object.prototype.
    assert.equal({}.polluted, undefined);
});

test('a missing required field is refused, and named', () => {
    const verdict = damaged((d) => { delete d.drawingSet.sheets[0].sourceId; });
    expectRejected(assert, verdict, 'schema', 'SCHEMA_REQUIRED');
    assert.equal(verdict.problems[0].path, '/drawingSet/sheets/0/sourceId');
    expectRejected(assert, damaged((d) => { delete d.drawingSet; }), 'schema', 'SCHEMA_REQUIRED');
    expectRejected(assert, damaged((d) => { delete d.lineage.migratedFrom; }), 'schema', 'SCHEMA_REQUIRED');
});

// -- versions ---------------------------------------------------------------

test('a future schema version is refused outright, not read as far as it goes', () => {
    for (const version of [2, 3, 999]) {
        const verdict = damaged((d) => { d.schemaVersion = version; d.somethingNew = { looks: 'harmless' }; });
        expectRejected(assert, verdict, 'version', 'UNSUPPORTED_FUTURE_VERSION');
        assert.equal(verdict.version, version);
    }
});

test('an unreadable version, an old version and a foreign file are told apart', () => {
    for (const bad of ['1', 1.5, -1, null, true, [1], 1e400]) {
        expectRejected(assert, damaged((d) => { d.schemaVersion = bad; }), 'version', 'VERSION_UNREADABLE');
    }
    expectRejected(assert, damaged((d) => { delete d.schemaVersion; }), 'version', 'VERSION_UNREADABLE');
    expectRejected(assert, damaged((d) => { d.schemaVersion = 0; }), 'version', 'OLD_VERSION_REQUIRES_MIGRATION');
    expectRejected(assert, damaged((d) => { d.format = 'something-else'; }), 'version', 'NOT_A_PROJECT_FILE');
    expectRejected(assert, importText('{"name":"package","version":"1.0.0"}', options), 'version', 'NOT_A_PROJECT_FILE');
});

// -- values with a fixed form -----------------------------------------------

test('a malformed SHA-256 is refused', () => {
    const good = VALID.drawingSet.sources[0].fingerprint.sha256;
    for (const bad of [good.toUpperCase(), good.slice(1), `${good}0`, good.replace(/.$/, 'g'), '', ` ${good.slice(1)}`]) {
        const verdict = damaged((d) => { d.drawingSet.sources[0].fingerprint.sha256 = bad; });
        assert.equal(verdict.status, 'REJECTED', JSON.stringify(bad));
        assert.equal(verdict.stage, 'schema');
        assert.ok(['SCHEMA_PATTERN', 'SCHEMA_STRING_LENGTH'].includes(verdict.code), verdict.code);
    }
    expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].fingerprint.algorithm = 'MD5'; }), 'schema', 'SCHEMA_CONST');
});

test('pathological numbers are refused: Infinity, fractions, unsafe integers, negatives, the wrong type', () => {
    const text = JSON.stringify(VALID);
    // JSON.parse turns 1e400 into Infinity without a word.
    const infinite = text.replace(/"byteLength":\d+/, '"byteLength":1e400');
    assert.equal(JSON.parse(infinite).drawingSet.sources[0].fingerprint.byteLength, Infinity);
    expectRejected(assert, importText(infinite, options), 'schema', 'SCHEMA_NUMBER_NOT_FINITE');

    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].pageNumber = 1.5; }), 'schema', 'SCHEMA_NUMBER_NOT_INTEGER');
    expectRejected(assert, importText(text.replace('"saveSequence":1', '"saveSequence":9007199254740993'), options), 'schema', 'SCHEMA_NUMBER_NOT_INTEGER');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].pageNumber = 0; }), 'schema', 'SCHEMA_NUMBER_RANGE');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].pageNumber = -3; }), 'schema', 'SCHEMA_NUMBER_RANGE');
    // 1e-400 underflows to 0, which is below the minimum of a byte length.
    expectRejected(assert, importText(text.replace(/"byteLength":\d+/, '"byteLength":1e-400'), options), 'schema', 'SCHEMA_NUMBER_RANGE');
    expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].fingerprint.byteLength = CANDIDATE_LIMITS.maxSourceBytes + 1; }), 'schema', 'SCHEMA_NUMBER_RANGE');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].pageNumber = '1'; }), 'schema', 'SCHEMA_TYPE');
    expectRejected(assert, damaged((d) => { d.drawingSet.titleBlockProfiles[0].fields.revision.left = -1; }), 'schema', 'SCHEMA_NUMBER_RANGE');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].pageFacts.rotate = 45; }), 'schema', 'SCHEMA_ENUM');
});

test('an unknown enum value is refused, not carried along', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.decisions[0].outcome = 'RESOLVED'; }), 'schema', 'SCHEMA_ENUM');
    expectRejected(assert, damaged((d) => { d.drawingSet.findings[0].ruleId = 'QA99_FUTURE_RULE'; }), 'schema', 'SCHEMA_ENUM');
    expectRejected(assert, damaged((d) => { d.drawingSet.findings[0].lifecycle.state = 'STALE'; }), 'schema', 'SCHEMA_ENUM');
    expectRejected(assert, damaged((d) => { d.drawingSet.titleBlockProfiles[0].transferModel = 'guess'; }), 'schema', 'SCHEMA_ENUM');
});

test('timestamp anomalies: a malformed one is refused, an implausible one is surfaced', () => {
    const stamp = (value) => damaged((d) => { d.drawingSet.sheets[0].createdAt = value; });
    for (const malformed of ['2026-10-05', '2026-10-05T00:00:00Z', '2026-10-05T09:00:00.000+09:00', '2026/10/05 00:00', 'now', '']) {
        const verdict = stamp(malformed);
        assert.equal(verdict.status, 'REJECTED', malformed);
        assert.equal(verdict.stage, 'schema');
        assert.ok(['SCHEMA_PATTERN', 'SCHEMA_STRING_LENGTH'].includes(verdict.code), verdict.code);
    }
    expectRejected(assert, stamp(1759622400000), 'schema', 'SCHEMA_TYPE');
    // Right shape, no such instant.
    for (const impossible of ['2026-13-45T00:00:00.000Z', '2026-02-30T00:00:00.000Z', '2026-10-05T25:00:00.000Z', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
        expectRejected(assert, stamp(impossible), 'relations', 'REL_TIMESTAMP_INVALID');
    }
    // A clock set ten years ahead is strange but possible. Accepted, and said.
    const future = stamp('2036-10-05T00:00:00.000Z');
    expectAccepted(assert, future);
    assert.ok(future.warnings.some((w) => w.code === 'WARN_TIMESTAMP_IN_FUTURE'));
    assert.ok(future.warnings.some((w) => w.code === 'WARN_TIMESTAMP_ORDER'));
});

// -- text -------------------------------------------------------------------

test('a file name cannot hold a path: Windows, UNC, POSIX and traversal are all refused', () => {
    const B = CHAR.BACKSLASH;
    const paths = [
        `C:${B}Users${B}someone${B}Documents${B}set.pdf`,
        `${B}${B}fileserver${B}projects${B}set.pdf`,
        '/home/someone/set.pdf',
        `..${B}..${B}set.pdf`,
        '../set.pdf',
        'file:///C:/set.pdf',
        'https://example.invalid/set.pdf',
        'C:set.pdf',
    ];
    for (const path of paths) {
        const verdict = damaged((d) => { d.drawingSet.sources[0].displayName = path; });
        expectRejected(assert, verdict, 'schema', 'SCHEMA_PATTERN');
    }
    for (const notAName of ['.', '..', '   ']) {
        expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].displayName = notAName; }), 'relations', 'REL_FILE_NAME');
    }
    expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].displayName = ''; }), 'schema', 'SCHEMA_STRING_LENGTH');
    // An ordinary name, in any script, is fine.
    expectAccepted(assert, damaged((d) => { d.drawingSet.sources[0].displayName = '意匠図 第3版 (final).pdf'; }));
});

test('control and direction-override characters are refused in every text field', () => {
    for (const bad of [CHAR.NUL, CHAR.BEL, CHAR.RLO, CHAR.LINE_SEPARATOR]) {
        expectRejected(assert, damaged((d) => { d.project.name = `a${bad}b`; }), 'schema', 'SCHEMA_PATTERN');
        expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].displayName = `a${bad}b.pdf`; }), 'schema', 'SCHEMA_PATTERN');
        expectRejected(assert, damaged((d) => { d.drawingSet.decisions[0].comment = `a${bad}b`; }), 'schema', 'SCHEMA_PATTERN');
    }
    // A line break belongs in a comment and not in a name.
    expectAccepted(assert, damaged((d) => { d.drawingSet.decisions[0].comment = 'line one\nline two'; }));
    expectRejected(assert, damaged((d) => { d.project.name = 'line one\nline two'; }), 'schema', 'SCHEMA_PATTERN');
    // A lone surrogate can only arrive as an escape, and is refused.
    const text = JSON.stringify(VALID).replace(`"name":"${VALID.project.name}"`, `"name":"a${CHAR.BACKSLASH}ud800b"`);
    expectRejected(assert, importText(text, options), 'schema', 'SCHEMA_STRING_NOT_WELL_FORMED');
});

test('markup, script, URLs and paths in free text are accepted as text and nothing else', () => {
    const B = CHAR.BACKSLASH;
    const hostile = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
        'https://example.invalid/collect?d=1',
        `see C:${B}Users${B}someone${B}set.pdf and ${B}${B}server${B}share`,
        '=HYPERLINK("http://example.invalid","x")',
        '${7*7} {{7*7}} %s %n',
        "'; DROP TABLE sheets; --",
    ];
    for (const text of hostile) {
        const verdict = damaged((d) => {
            d.project.name = text;
            d.drawingSet.decisions[0].comment = text;
            d.drawingSet.sheets[0].confirmation = d.drawingSet.sheets.find((s) => s.confirmation).confirmation;
            d.drawingSet.sheets[0].confirmation.values.drawingTitle = text;
        });
        // Accepted: a person may write anything in a comment or a title. The
        // contract is on the other side -- it is only ever shown as text.
        expectAccepted(assert, verdict);
        assert.equal(verdict.project.project.name, text);
        assert.equal(verdict.project.drawingSet.decisions[0].comment, text);
    }
    // And there is nowhere in the schema for a URL or a path to be a *value*:
    // no property is typed as one, so nothing downstream can be handed one to open.
    const schemaText = JSON.stringify(VALID);
    assert.ok(!/"(url|href|path|uri|link)"/i.test(schemaText));
});

test('a refusal never echoes more than a short excerpt of the input', () => {
    const verdict = importText(`{"format": ${'x'.repeat(5000)}`, options);
    assert.equal(verdict.status, 'REJECTED');
    assert.ok(JSON.stringify(verdict.problems).length < 1000);
});
