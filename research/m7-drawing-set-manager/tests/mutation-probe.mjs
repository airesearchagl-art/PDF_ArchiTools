/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Shows each test suite something broken and checks that it notices.
 *
 * A suite that passes proves little until it has been seen to fail for the
 * right reason. Each probe below removes ONE safeguard from the prototype --
 * the duplicate-key check, the future-version refusal, the rule that a name
 * match is not a content match -- runs the whole suite, and requires a failure.
 * A probe that still passes is a hole in the tests, and this exits non-zero.
 *
 * The prototype files are edited in place and restored in a `finally`, one
 * probe at a time; a final check confirms every file is byte-identical to how
 * it started. Do not run this while a benchmark is serving the same files.
 *
 * Run: node research/m7-drawing-set-manager/tests/mutation-probe.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const OUT = path.join(ROOT, 'evidence', 'mutation-probe.json');
const BS = String.fromCodePoint(0x5c);

/** [what is removed, file, exact text to find, replacement] */
const PROBES = [
    ['duplicate JSON keys are accepted', 'prototype/bounded-json.mjs',
        'if (frame.keys.has(key)) return refuse(SCAN_REFUSAL.DUPLICATE_KEY, start, stats, key);', 'if (false) return refuse(SCAN_REFUSAL.DUPLICATE_KEY, start, stats, key);'],
    ['nesting depth is not bounded', 'prototype/bounded-json.mjs',
        'if (frames.length > limits.maxNestingDepth) {', 'if (false) {'],
    ['an object may have any number of keys', 'prototype/bounded-json.mjs',
        'if (frame.keys.size >= limits.maxObjectKeys) return', 'if (false) return'],
    ['the byte bound is not checked', 'prototype/bounded-json.mjs',
        'if (bytes.length > limits.maxProjectBytes) {', 'if (false) {'],
    ['unknown fields are ignored', 'prototype/schema-subset.mjs',
        "if (!property) run.report(SCHEMA_PROBLEM.UNKNOWN_FIELD, 'field is not part of this schema version');", 'if (!property) { /* probe: ignored */ }'],
    ['Infinity is a number like any other', 'prototype/schema-subset.mjs',
        "if (!Number.isFinite(value)) { run.report(SCHEMA_PROBLEM.NUMBER_NOT_FINITE, 'not a finite number'); return; }", ''],
    ['an unknown schema keyword is ignored', 'prototype/schema-subset.mjs',
        'throw new SchemaError(`${where}: unsupported keyword "${keyword}"`);', 'continue;'],
    ['duplicate ids are accepted', 'prototype/semantic.mjs',
        'if (owners.has(id)) report.problem(RELATION_PROBLEM.DUPLICATE_ID', 'if (false) report.problem(RELATION_PROBLEM.DUPLICATE_ID'],
    ['a dangling decision is accepted', 'prototype/semantic.mjs',
        "if (!finding) { report.problem(RELATION_PROBLEM.DANGLING_FINDING, `${path}/findingId`, 'no such finding'); return; }", 'if (!finding) return;'],
    ['a decision need not match its finding\'s evidence', 'prototype/semantic.mjs',
        'if (decision.evidenceDigest !== finding.evidenceDigest) {', 'if (false) {'],
    ['an impossible timestamp is accepted', 'prototype/semantic.mjs',
        'if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {', 'if (false) {'],
    ['a future schema version is read as far as it goes', 'prototype/project-io.mjs',
        'if (version > SUPPORTED_SCHEMA_VERSION) return { ok: false, code: VERSION_REFUSAL.UNSUPPORTED_FUTURE_VERSION, version };', ''],
    ['the writer is not an allow-list', 'prototype/project-io.mjs',
        'const ordered = compiled.project(document);', 'const ordered = Object.assign(document, { drawingSet: model.drawingSet });'],
    ['the writer does not check what it writes', 'prototype/project-io.mjs',
        "if (verdict.status !== 'ACCEPTED') throw new ExportRefused(verdict.stage, verdict.problems);", ''],
    ['a file name match counts as a content match', 'prototype/rebind.mjs',
        "result.set(source.id, { state: BINDING.CHANGED, candidateId: files[0].candidateId, nominees: [files[0].candidateId], nominatedBy: 'NAME' });",
        "result.set(source.id, { state: BINDING.MATCHED, candidateId: files[0].candidateId, nominees: [files[0].candidateId], nominatedBy: 'NAME' });"],
    ['two name candidates are resolved by taking the first', 'prototype/rebind.mjs',
        '} else if (files.length === 1 && rivals.length === 1) {', '} else if (files.length >= 1) {'],
    ['a replaced source does not make its observations stale', 'prototype/currency.mjs',
        'if (sheet.observation.sourceSha256 !== sha) observation = DATA_CURRENCY.STALE_SOURCE;', 'if (false) observation = DATA_CURRENCY.STALE_SOURCE;'],
    ['a replaced source does not ask for re-confirmation', 'prototype/currency.mjs',
        'if (sheet.confirmation.sourceSha256 !== sha) confirmation = DATA_CURRENCY.STALE_SOURCE;', 'if (false) confirmation = DATA_CURRENCY.STALE_SOURCE;'],
    ['a profile change does not reach its sheets', 'prototype/currency.mjs',
        'return !!profile && profile.revision === basis.profileRevision;', 'return !!profile;'],
    ['an unbound source counts as verified', 'prototype/currency.mjs',
        "if (bindingOf(bindings, basis.sourceId) !== BINDING.MATCHED) { reasons.push('SOURCE_NOT_MATCHED'); break; }", ''],
    ['FALSE_POSITIVE on QA02 lifts the metadata-confirmation requirement', 'prototype/currency.mjs',
        "const EXEMPTS_FROM_METADATA_CONFIRMATION = new Set(['INTENTIONAL']);", "const EXEMPTS_FROM_METADATA_CONFIRMATION = new Set(['INTENTIONAL', 'FALSE_POSITIVE']);"],
    ['any decision on QA02 lifts the metadata-confirmation requirement', 'prototype/currency.mjs',
        '&& decision && EXEMPTS_FROM_METADATA_CONFIRMATION.has(decision.outcome)) exemptSheets.add(finding.sheetIds[0]);', '&& decision) exemptSheets.add(finding.sheetIds[0]);'],
    ['a stale declared register still counts as current', 'prototype/currency.mjs',
        'return !source || source.retiredAt !== null || source.fingerprint.sha256 !== reference.sourceSha256;', 'return !source || source.retiredAt !== null;'],
    ['a stale declared register does not block Final', 'prototype/currency.mjs',
        'for (const reference of coverage.register.staleReferences) { void reference; block(FINAL_BLOCKER.REGISTER_NOT_CURRENT); }', ''],
    ['Final does not say that QA09 was not evaluated', 'prototype/currency.mjs',
        'if (coverage.register.status !== REGISTER_STATUS.CURRENT) {\n        notEvaluable.push({', 'if (false) {\n        notEvaluable.push({'],
    ['Final does not require every finding to be decided', 'prototype/currency.mjs',
        'if (!decision) block(FINAL_BLOCKER.FINDINGS_UNREVIEWED);', 'if (false) block(FINAL_BLOCKER.FINDINGS_UNREVIEWED);'],
    ['changed evidence keeps the old finding and its decision', 'prototype/qa-rules.mjs',
        'if (previous && previous.evidenceDigest === draft.evidenceDigest) { summary.kept += 1; continue; }', 'if (previous) { summary.kept += 1; continue; }'],
    ['a run that never saw the import warnings closes the project-file finding', 'prototype/qa-rules.mjs',
        'projectFile: importWarnings !== undefined,', 'projectFile: true,'],
    ['QA09 is evaluated against a register that is not current', 'prototype/qa-rules.mjs',
        'if (register.status === REGISTER_STATUS.CURRENT) {', 'if (register.status !== REGISTER_STATUS.NOT_DESIGNATED) {'],
    ['a withdrawn register leaves its QA09 findings open', 'prototype/qa-rules.mjs',
        'if (evaluated.register === REGISTER_STATUS.NOT_DESIGNATED) return true;', 'if (evaluated.register === REGISTER_STATUS.NOT_DESIGNATED) return false;'],
    ['a QA09 finding is closed by a run that compared nothing', 'prototype/qa-rules.mjs',
        'if (evaluated.register !== REGISTER_STATUS.CURRENT) return false;', ''],
    ['a folded spelling counts as listed', 'prototype/qa-rules.mjs',
        'if (listed.has(exact)) continue;', 'if (listed.has(exact) || listedSpellings.has(comparisonKey(exact))) continue;'],
    ['the Sheet list / page inventory mismatch is filed as QA09', 'prototype/qa-rules.mjs',
        "            draft('QA10_INTEGRITY', {\n                sheets: orphaned,", "            draft('QA09_REGISTER_SHEET_MISMATCH', {\n                sheets: orphaned,"],
    ['a run closes findings it could not look at', 'prototype/qa-rules.mjs',
        'if (couldEvaluate(finding, evaluation, index)) {', 'if (true) {'],
    ['evidence ignores which bytes a sheet was read from', 'prototype/qa-rules.mjs',
        'evidenceDigest: digest([ruleId, rule.version, orderedSheets.map((s) => [s.id, shaOf(s)]), orderedEntries.map((item) => item.entry.id), basis, evidence]),',
        'evidenceDigest: digest([ruleId, rule.version, orderedSheets.map((s) => s.id), orderedEntries.map((item) => item.entry.id), evidence]),'],
    ['A-101 and a-101 are certainly the same number', 'prototype/qa-rules.mjs',
        'export const exactKey = (value) => value.trim();', 'export const exactKey = (value) => value.trim().toUpperCase();'],
    ['a blank title counts as a different title', 'prototype/qa-rules.mjs',
        "const distinct = (group, read) => [...new Set(group.map(read).filter((v) => v !== ''))].sort();", 'const distinct = (group, read) => [...new Set(group.map(read))].sort();'],
    ['a path separator survives in a display name', 'prototype/model-ops.mjs',
        `.replace(/[/${BS}${BS}:]/g, '_')`, ''],
    ['the same bytes can be added as two sources', 'prototype/model-ops.mjs',
        "if (existing) return { ok: false, code: 'DUPLICATE_CONTENT', existingSourceId: existing.id };", ''],
    ['a live sheet may point at a retired profile', 'prototype/semantic.mjs',
        '} else if (assigned.retiredAt !== null && sheet.retiredAt === null) {', '} else if (false) {'],
    ['a register row with no drawing number is declared anyway', 'prototype/model-ops.mjs',
        "if (drawingNumber === '') return { ok: false, code: 'EMPTY_NUMBER', row: i + 1 };", ''],
    ['a register can be declared with no rows', 'prototype/model-ops.mjs',
        "if (!Array.isArray(rows) || rows.length === 0) return { ok: false, code: 'EMPTY_REGISTER' };", ''],
    ['a dangling register entry is accepted', 'prototype/semantic.mjs',
        "unique(finding.registerEntryIds, 'registerEntryIds', (id) => registerEntries.has(id), RELATION_PROBLEM.DANGLING_REGISTER_ENTRY);", ''],
    ['a register row naming no drawing is accepted from a file', 'prototype/semantic.mjs',
        "if (entry.drawingNumber.trim() === '') report.problem(RELATION_PROBLEM.REGISTER, `${at}/drawingNumber`, 'a register entry names a drawing');", ''],
    ['a live register may hang off a retired source', 'prototype/semantic.mjs',
        'else if (source.retiredAt !== null && reference.retiredAt === null) {\n            report.problem(RELATION_PROBLEM.RETIRED_STATE, `${path}/retiredAt`, \'a register declared from a retired source is retired\');', 'else if (false) {\n            report.problem(RELATION_PROBLEM.RETIRED_STATE, `${path}/retiredAt`, \'a register declared from a retired source is retired\');'],
    ['an empty drawing-number cell becomes a register row', 'prototype/register-list-adapter.mjs',
        "if (drawingNumber === '') { skipped.push({ gridRow: r + 1, reason: 'EMPTY_NUMBER' }); continue; }", ''],
    ['a grid the engine could not read is offered for declaration', 'prototype/register-list-adapter.mjs',
        'if (!USABLE_STATUS.has(candidate.status)) return { ok: false, code: candidate.status };', ''],
    ['a re-confirmation overwrites the earlier one', 'prototype/model-ops.mjs',
        "if (sheet.confirmation) sheet.confirmationHistory.push({ confirmation: sheet.confirmation, retiredAt: at, reason: 'RECONFIRMED' });", ''],
    ['SHA-256 padding is wrong at one length', 'prototype/sha256-stream.mjs',
        'const tail = new Uint8Array(this.pendingLength < 56 ? 64 : 128);', 'const tail = new Uint8Array(this.pendingLength < 57 ? 64 : 128);'],
    ['a migrated document is not validated again', 'prototype/migrate.mjs',
        "if (verdict.status !== 'ACCEPTED') return reject(verdict.stage, verdict.code, verdict.problems, { version: version.version, afterMigration: true });", ''],
    ['an old file is converted without being validated as old', 'prototype/migrate.mjs',
        'if (problems.length > 0) return reject(IMPORT_STAGE.SCHEMA, problems[0].code, problems, { version: from });', ''],
];

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const touched = [...new Set(PROBES.map((p) => path.join(ROOT, p[1])))];
const before = new Map(touched.map((file) => [file, sha(file)]));

function runSuite() {
    const result = spawnSync(process.execPath, ['--test', 'research/m7-drawing-set-manager/tests/*.test.mjs'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout}\n${result.stderr}`;
    const count = (label) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(output)?.[1] ?? NaN);
    const failed = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]);
    return { exitCode: result.status, pass: count('pass'), fail: count('fail'), failed: [...new Set(failed)] };
}

const baseline = runSuite();
if (baseline.exitCode !== 0) {
    console.error('the unmodified suite does not pass; fix that first');
    process.exit(2);
}
console.log(`baseline: ${baseline.pass} pass, ${baseline.fail} fail\n`);

const results = [];
for (const [what, relative, find, replacement] of PROBES) {
    const file = path.join(ROOT, relative);
    const original = fs.readFileSync(file, 'utf8');
    const occurrences = original.split(find).length - 1;
    if (occurrences !== 1) {
        results.push({ what, file: relative, applied: false, reason: `anchor found ${occurrences} times` });
        console.log(`NOT APPLIED  ${what}  (${relative}: anchor found ${occurrences} times)`);
        continue;
    }
    let outcome;
    try {
        fs.writeFileSync(file, original.replace(find, () => replacement));
        outcome = runSuite();
    } finally {
        fs.writeFileSync(file, original);
    }
    const caught = outcome.exitCode !== 0 && outcome.fail > 0;
    results.push({ what, file: relative, applied: true, caught, failingTests: outcome.fail, firstFailing: outcome.failed.slice(0, 3) });
    console.log(`${caught ? 'CAUGHT ' : 'MISSED '}  ${what}  (${outcome.fail} failing)`);
}

const restored = touched.every((file) => sha(file) === before.get(file));
const after = runSuite();
const missed = results.filter((r) => !r.applied || !r.caught);
const report = {
    notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Each probe removes one safeguard from the prototype and requires the test suite to fail.',
    baseline: { pass: baseline.pass, fail: baseline.fail },
    probes: results.length, caught: results.filter((r) => r.caught).length, missedOrNotApplied: missed.length,
    prototypeFilesRestoredByteIdentical: restored,
    suiteAfterRestore: { pass: after.pass, fail: after.fail },
    results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.caught}/${report.probes} probes caught; files restored byte-identical: ${restored}; suite after restore: ${after.pass} pass, ${after.fail} fail`);
console.log(`written: ${path.relative(REPO, OUT)}`);
process.exit(missed.length === 0 && restored && after.fail === 0 ? 0 : 1);
