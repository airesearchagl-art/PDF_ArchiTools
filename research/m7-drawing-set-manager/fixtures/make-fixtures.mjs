/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The committed fixtures, and the one place they come from.
 *
 * Every fixture is synthetic. No customer drawing, no real project, no real
 * file name, no path and no secret goes into any of them: the Projects are
 * built by prototype/synthetic-project.mjs from a seed, and the invalid ones
 * are that same output with one thing broken.
 *
 * Only small, readable fixtures are committed. The large adversarial inputs
 * (megabytes of string, millions of values, a million levels of nesting) are
 * generated inside the tests and the benchmarks and never written to disk.
 *
 * tests/fixtures.test.mjs regenerates everything here and compares it with what
 * is committed, so a fixture cannot drift from its generator unnoticed.
 *
 * Run: node research/m7-drawing-set-manager/fixtures/make-fixtures.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seededUuidSource } from '../prototype/ids.mjs';
import { exportProject } from '../prototype/project-io.mjs';
import { SYNTHETIC_EPOCH_MS, buildSyntheticProject } from '../prototype/synthetic-project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The clock every fixture is checked against: a day after the synthetic epoch. */
export const FIXTURE_NOW = SYNTHETIC_EPOCH_MS + 24 * 60 * 60 * 1000;

const BACKSLASH = String.fromCodePoint(0x5c);
const pretty = (document) => `${JSON.stringify(document, null, 2)}\n`;

function baseDocument(options) {
    const built = buildSyntheticProject(options);
    const ids = seededUuidSource(options.seed ?? 1);
    return exportProject(built.model, { now: built.now, newFileId: ids() }).document;
}

/**
 * Every fixture as `{ file, text, expect }`.
 *
 * `expect` is `{ status: 'ACCEPTED', warnings: [...] }` or
 * `{ status: 'REJECTED', stage, code }`.
 */
export function buildFixtures() {
    const fixtures = [];
    const unused = seededUuidSource(990099);

    const minimal = () => baseDocument({ sheets: 3, pagesPerSource: 3, seed: 11, confirmedShare: 0.67, decidedShare: 1, duplicateEvery: 0, gapEvery: 0, variantEvery: 0, outlierEvery: 0 });
    const withRegister = () => baseDocument({ sheets: 8, pagesPerSource: 4, seed: 13, confirmedShare: 1, decidedShare: 0.5, duplicateEvery: 0, gapEvery: 0, variantEvery: 0, outlierEvery: 0, declaredRegister: true, unlistedEvery: 4, missingEvery: 3 });
    const reviewed = () => baseDocument({ sheets: 12, pagesPerSource: 4, seed: 12, confirmedShare: 0.75, decidedShare: 0.6, duplicateEvery: 5, gapEvery: 4, variantEvery: 7, outlierEvery: 6 });
    const clone = (document) => JSON.parse(JSON.stringify(document));

    const valid = (file, document, why, warnings = []) => fixtures.push({ file: `valid/${file}`, text: pretty(document), why, expect: { status: 'ACCEPTED', warnings } });
    const invalidDocument = (file, mutate, stage, code, why) => {
        const document = minimal();
        mutate(document);
        fixtures.push({ file: `invalid/${file}`, text: pretty(document), why, expect: { status: 'REJECTED', stage, code } });
    };
    const invalidText = (file, edit, stage, code, why) => {
        fixtures.push({ file: `invalid/${file}`, text: edit(pretty(minimal())), why, expect: { status: 'REJECTED', stage, code } });
    };

    // -- valid --------------------------------------------------------------
    valid('minimal.project.json', minimal(), 'The smallest Project that has one of everything: a source, a profile, sheets, a run, a finding, a decision.');
    valid('reviewed-12-sheets.project.json', reviewed(), 'A small Drawing Set part-way through review, with planted duplicates, a gap, a width variant and a size outlier.');

    valid('declared-register.project.json', withRegister(), 'A Drawing Set with a declared Drawing Register: rows a person accepted from a table on one page. Some listed drawings have no sheet and some sheets are not listed, so QA09 has both kinds of finding.');

    const hostileText = minimal();
    hostileText.project.name = '<script>alert(1)</script> & "quotes"';
    hostileText.drawingSet.decisions[0].comment = `<img src=x onerror=alert(1)>\njavascript:alert(1)\nhttps://example.invalid/collect\nC:${BACKSLASH}Users${BACKSLASH}someone${BACKSLASH}set.pdf`;
    valid('inert-hostile-text.project.json', hostileText, 'Markup, a script URL, a web URL and a Windows path inside free text. Accepted: free text is data, and is only ever rendered as text.');

    const future = minimal();
    future.drawingSet.sheets[0].createdAt = '2036-10-05T00:00:00.000Z';
    valid('clock-ten-years-ahead.project.json', future, 'One timestamp ten years ahead. Strange but possible (a wrong clock), so it is accepted and surfaced, not refused.', ['WARN_TIMESTAMP_IN_FUTURE', 'WARN_TIMESTAMP_ORDER']);

    // -- invalid: not a readable file ---------------------------------------
    invalidText('truncated.json', (text) => text.slice(0, Math.floor(text.length * 0.6)).trimEnd(), 'scan', 'UNTERMINATED', 'Cut off mid-way, as an interrupted download or copy would be.');
    invalidText('trailing-comma.json', (text) => text.replace('"schemaVersion": 1,', '"schemaVersion": 1,,'), 'parse', 'INVALID_JSON', 'Not JSON.');
    invalidText('duplicate-key.json', (text) => text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 2,'), 'scan', 'DUPLICATE_KEY', 'JSON.parse would silently read this as version 2; a parser that keeps the first key would read 1.');
    invalidText('nesting-too-deep.json', (text) => text.replace('"schemaVersion": 1,', `"schemaVersion": 1,\n  "junk": ${'['.repeat(40)}${']'.repeat(40)},`), 'scan', 'NESTING_TOO_DEEP', 'Forty levels where the schema has seven.');
    invalidText('number-infinity.json', (text) => text.replace(/"byteLength": \d+/, '"byteLength": 1e400'), 'schema', 'SCHEMA_NUMBER_NOT_FINITE', 'JSON.parse turns 1e400 into Infinity without a word.');

    // -- invalid: version ---------------------------------------------------
    invalidDocument('future-schema-version.json', (d) => { d.schemaVersion = 2; }, 'version', 'UNSUPPORTED_FUTURE_VERSION', 'A version this build has never been told about. Refused outright, not read as far as it goes.');
    invalidDocument('not-a-project-file.json', (d) => { d.format = 'something-else'; }, 'version', 'NOT_A_PROJECT_FILE', 'Well-formed JSON that is not one of ours.');

    // -- invalid: shape -----------------------------------------------------
    invalidDocument('unknown-field.json', (d) => { d.drawingSet.sheets[0].thumbnail = 'data:image/png;base64,AAAA'; }, 'schema', 'SCHEMA_UNKNOWN_FIELD', 'A field the schema does not declare -- here, the kind of thing that must never be in the file.');
    invalidDocument('missing-required.json', (d) => { delete d.drawingSet.sheets[0].sourceId; }, 'schema', 'SCHEMA_REQUIRED', 'A sheet with no source.');
    invalidDocument('malformed-sha256.json', (d) => { d.drawingSet.sources[0].fingerprint.sha256 = d.drawingSet.sources[0].fingerprint.sha256.toUpperCase(); }, 'schema', 'SCHEMA_PATTERN', 'Upper-case hex. The fingerprint has exactly one written form.');
    invalidDocument('path-in-display-name.json', (d) => { d.drawingSet.sources[0].displayName = `C:${BACKSLASH}Users${BACKSLASH}someone${BACKSLASH}Documents${BACKSLASH}set.pdf`; }, 'schema', 'SCHEMA_PATTERN', 'An absolute Windows path where a bare file name belongs.');
    invalidDocument('unc-path-in-display-name.json', (d) => { d.drawingSet.sources[0].displayName = `${BACKSLASH}${BACKSLASH}fileserver${BACKSLASH}projects${BACKSLASH}set.pdf`; }, 'schema', 'SCHEMA_PATTERN', 'A UNC path where a bare file name belongs.');
    invalidDocument('unknown-enum.json', (d) => { d.drawingSet.decisions[0].outcome = 'RESOLVED'; }, 'schema', 'SCHEMA_ENUM', 'An outcome that is not one of the four.');
    invalidDocument('comment-too-long.json', (d) => { d.drawingSet.decisions[0].comment = 'too long. '.repeat(401).slice(0, 4001); }, 'schema', 'SCHEMA_STRING_LENGTH', 'One character over the bound.');

    // -- invalid: meaning ---------------------------------------------------
    invalidDocument('duplicate-sheet-id.json', (d) => { d.drawingSet.sheets[1].id = d.drawingSet.sheets[0].id; }, 'relations', 'REL_DUPLICATE_ID', 'Two sheets with one identity.');
    invalidDocument('duplicate-source-id.json', (d) => { d.drawingSet.sheets[0].id = d.drawingSet.sources[0].id; }, 'relations', 'REL_DUPLICATE_ID', 'A sheet and a source with one identity: ids are one namespace.');
    invalidDocument('dangling-source-id.json', (d) => { d.drawingSet.sheets[0].sourceId = unused(); }, 'relations', 'REL_DANGLING_SOURCE', 'A sheet of a source that is not in the manifest.');
    invalidDocument('dangling-sheet-id.json', (d) => { d.drawingSet.findings[0].sheetIds[0] = unused(); }, 'relations', 'REL_DANGLING_SHEET', 'A finding about a sheet that does not exist.');
    invalidDocument('dangling-finding-id.json', (d) => { d.drawingSet.decisions[0].findingId = unused(); }, 'relations', 'REL_DANGLING_FINDING', 'A decision about a finding that does not exist.');
    invalidDocument('decision-on-other-evidence.json', (d) => { d.drawingSet.decisions[0].evidenceDigest = '0'.repeat(64); }, 'relations', 'REL_DECISION_EVIDENCE', 'A decision whose evidence digest is not its finding\'s.');
    invalidDocument('dangling-register-entry-id.json', (d) => { d.drawingSet.findings[0].registerEntryIds = [unused()]; }, 'relations', 'REL_DANGLING_REGISTER_ENTRY', 'A finding about a register entry that does not exist.');
    fixtures.push((() => {
        const document = withRegister();
        document.drawingSet.drawingRegisterReferences[0].entries[0].drawingNumber = '   ';
        return { file: 'invalid/register-entry-without-number.json', text: pretty(document), why: 'A declared register row that names no drawing.', expect: { status: 'REJECTED', stage: 'relations', code: 'REL_REGISTER' } };
    })());
    fixtures.push((() => {
        const document = withRegister();
        document.drawingSet.drawingRegisterReferences[0].pageText = 'every word on the list page';
        return { file: 'invalid/register-with-page-text.json', text: pretty(document), why: 'A declared register carrying the page\'s text. The register holds field-level rows and has no property for anything else.', expect: { status: 'REJECTED', stage: 'schema', code: 'SCHEMA_UNKNOWN_FIELD' } };
    })());
    invalidDocument('timestamp-impossible.json', (d) => { d.savedAt = '2026-13-45T00:00:00.000Z'; }, 'relations', 'REL_TIMESTAMP_INVALID', 'The right shape, and no such day.');
    invalidDocument('lifecycle-contradiction.json', (d) => { d.drawingSet.findings[0].lifecycle.state = 'SUPERSEDED'; }, 'relations', 'REL_FINDING_LIFECYCLE', 'Superseded, by nothing.');

    return fixtures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const fixtures = buildFixtures();
    for (const dir of ['valid', 'invalid']) fs.rmSync(path.join(HERE, dir), { recursive: true, force: true });
    for (const fixture of fixtures) {
        const target = path.join(HERE, fixture.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fixture.text);
    }
    const expected = fixtures.map(({ file, why, expect }) => ({ file, why, expect }));
    fs.writeFileSync(path.join(HERE, 'expected.json'), `${JSON.stringify({
        notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic fixtures generated by make-fixtures.mjs. What the importer must say about each file.',
        checkedAgainstClock: new Date(FIXTURE_NOW).toISOString(),
        fixtures: expected,
    }, null, 2)}\n`);
    console.log(`wrote ${fixtures.length} fixtures and expected.json`);
}
