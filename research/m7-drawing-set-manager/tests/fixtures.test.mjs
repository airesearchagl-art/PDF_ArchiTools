/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The committed fixtures: each is what its generator produces, and the importer
 * says about each exactly what expected.json says it must.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_NOW, buildFixtures } from '../fixtures/make-fixtures.mjs';
import { importProject } from '../prototype/project-io.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
// A checkout with core.autocrlf rewrites line endings; the content is what is compared.
const read = (file) => fs.readFileSync(path.join(FIXTURES, file), 'utf8').replace(/\r\n/g, '\n');
const generated = buildFixtures();
const expected = JSON.parse(read('expected.json'));

test('the committed fixtures are exactly what make-fixtures.mjs generates', () => {
    assert.ok(generated.length >= 20);
    for (const fixture of generated) assert.equal(read(fixture.file), fixture.text, `${fixture.file} has drifted from its generator`);
    assert.deepEqual(expected.fixtures, generated.map(({ file, why, expect }) => ({ file, why, expect })));
    // And nothing is committed that the generator does not know about.
    const onDisk = ['valid', 'invalid'].flatMap((dir) => fs.readdirSync(path.join(FIXTURES, dir)).map((name) => `${dir}/${name}`)).sort();
    assert.deepEqual(onDisk, generated.map((f) => f.file).sort());
});

test('the importer says about every fixture what expected.json says it must', () => {
    for (const { file, expect } of expected.fixtures) {
        const verdict = importProject(fs.readFileSync(path.join(FIXTURES, file)), { now: FIXTURE_NOW });
        assert.equal(verdict.status, expect.status, `${file}: ${JSON.stringify(verdict.problems?.slice(0, 2))}`);
        if (expect.status === 'REJECTED') {
            assert.equal(verdict.stage, expect.stage, file);
            assert.equal(verdict.code, expect.code, file);
            assert.equal(verdict.project, undefined, file);
        } else {
            assert.deepEqual([...new Set(verdict.warnings.map((w) => w.code))].sort(), [...expect.warnings].sort(), file);
        }
    }
});

test('the fixtures cover every stage of the import pipeline', () => {
    const stages = new Set(expected.fixtures.filter((f) => f.expect.status === 'REJECTED').map((f) => f.expect.stage));
    for (const stage of ['scan', 'parse', 'version', 'schema', 'relations']) assert.ok(stages.has(stage), `no fixture is refused at ${stage}`);
});

test('no fixture holds anything but synthetic data', () => {
    for (const { file } of expected.fixtures) {
        const text = read(file);
        // Small enough to read; nothing embedded.
        assert.ok(text.length < 200_000, `${file} is ${text.length} characters`);
        assert.ok(!/"(pageText|ocrText|tokens|thumbnail)"/.test(text) || file.startsWith('invalid/'), `${file} holds a forbidden property`);
        assert.ok(!/[A-Za-z0-9+/]{400,}/.test(text), `${file} holds a long encoded run`);
        // The only source names are the generator's.
        for (const match of text.matchAll(/"displayName": "([^"]*)"/g)) {
            assert.ok(/^synthetic-set-\d{4}\.pdf$/.test(match[1]) || /someone|fileserver/.test(match[1]), `${file}: unexpected source name ${match[1]}`);
        }
    }
});
