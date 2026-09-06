/**
 * The research gate: re-checks the claims this spike is going to make.
 *
 * RESEARCH ONLY. This does not gate the app; it gates the write-up. Every
 * assertion here is one that appears as a sentence in research/m2-5/, so a
 * measurement that stops holding turns into a failing gate rather than a
 * paragraph that quietly goes stale.
 *
 * Half of it is negative probes. An assertion that a check found nothing is
 * worth very little on its own -- it passes just as happily when the check is
 * broken -- so each one is paired with a case that must make it fire.
 *
 * Run:  node scripts/research-m2-5-fixtures.mjs
 *       node scripts/research-m2-5-probe.mjs
 *       node scripts/research-m2-5-register.mjs
 *       node scripts/research-m2-5-export-application.mjs   (optional, needs Excel)
 *       node scripts/research-m2-5-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildRow, findDuplicates, findGapCandidates, confirmRow, FIELDS,
} from '../research/m2-5/prototype/register.mjs';
import { toCsv, parseCsv, isFormulaLead } from '../research/m2-5/prototype/csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-5', 'results');

let failures = 0;
const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const has = (name) => fs.existsSync(path.join(OUT, name));

function check(label, ok, detail = '') {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

/**
 * A negative probe: the same check, on input that must make it fire.
 *
 * Written as its own helper so the write-up can point at a line and say the
 * check is capable of failing, rather than asking the reader to take it on
 * trust.
 */
function mustFire(label, ok, detail = '') {
    check(`negative probe: ${label}`, ok, detail);
}

const required = ['geometry.json', 'template-transfer.json', 'native-extraction.json',
    'render-cost.json', 'ocr-per-field.json', 'mixed-pages.json',
    'end-to-end.json', 'value-policies.json', 'register.json', 'register-after-review.json',
    'gap-sweep.json', 'csv-analysis.json', 'psm-enum.json', 'network.json'];
const missing = required.filter((f) => !has(f));
if (missing.length) {
    console.error(`Missing results: ${missing.join(', ')}`);
    console.error('Run the fixture, probe and register scripts first.');
    process.exit(1);
}

console.log('=== corpus ===');
const geometry = read('geometry.json');
check('every page in the set was measured', geometry.length === 22, `${geometry.length} pages`);
check('all four rotations appear', new Set(geometry.map((g) => g.rotate)).size === 4,
    [...new Set(geometry.map((g) => g.rotate))].sort((a, b) => a - b).join(', '));
check('all four sheet sizes appear', new Set(geometry.map((g) => g.size)).size === 4,
    [...new Set(geometry.map((g) => g.size))].join(', '));
check('the set contains scanned pages as well as native ones',
    geometry.some((g) => g.scanned) && geometry.some((g) => !g.scanned),
    `${geometry.filter((g) => g.scanned).length} scanned, ${geometry.filter((g) => !g.scanned).length} native`);

console.log('');
console.log('=== the template models disagree, which is the point ===');
const native = read('native-extraction.json');
const hits = (rows, model) => rows.reduce((n, p) => n + (p.models[model]?.hits ?? 0), 0);
const scaled = native.filter((p) => p.blockScaling === 'proportional' && p.size !== 'A3');
const fixed = native.filter((p) => p.blockScaling === 'fixed-physical-size');
check('a title block that scales with the sheet is read by the normalised model',
    hits(scaled, 'normalised') > 0, `${hits(scaled, 'normalised')} fields`);
mustFire('the absolute model cannot read those same pages',
    hits(scaled, 'absolute') === 0, `${hits(scaled, 'absolute')} fields`);
check('a title block of fixed physical size is read by the corner-anchored model',
    hits(fixed, 'corner-anchored') > 0, `${hits(fixed, 'corner-anchored')} fields`);
mustFire('the normalised model largely cannot read those',
    hits(fixed, 'normalised') < hits(fixed, 'corner-anchored'),
    `normalised ${hits(fixed, 'normalised')} vs corner-anchored ${hits(fixed, 'corner-anchored')}`);

const transfer = read('template-transfer.json');
mustFire('templateFits does not catch the mismatch on its own',
    transfer.transfer.every((t) => t.fits), 'every A-series sheet shares an aspect ratio');

console.log('');
console.log('=== region rendering ===');
const cost = read('render-cost.json');
for (const c of cost) {
    check(`${c.size}: the region is a fraction of the full page`, c.ratio < 0.1,
        `${(c.ratio * 100).toFixed(2)}% of ${(c.fullPage.pixels / 1e6).toFixed(1)} Mpx`);
}
mustFire('the full page really would be too large to rasterise',
    cost.some((c) => c.fullPage.pixels > 100e6),
    `largest ${(Math.max(...cost.map((c) => c.fullPage.pixels)) / 1e6).toFixed(1)} Mpx`);

console.log('');
console.log('=== segmentation ===');
const perField = read('ocr-per-field.json');
const byMode = (mode) => perField.filter((p) => p.mode === mode).reduce((n, p) => n + p.hits, 0);
check('SINGLE_BLOCK reads the field regions', byMode('SINGLE_BLOCK') > 0, `${byMode('SINGLE_BLOCK')} hits`);
mustFire('AUTO reads fewer of them, so the choice is doing work',
    byMode('AUTO') < byMode('SINGLE_BLOCK'), `AUTO ${byMode('AUTO')} vs SINGLE_BLOCK ${byMode('SINGLE_BLOCK')}`);

console.log('');
console.log('=== one row per page ===');
const register = read('register.json');
check('the register has a row for every page', register.rows.length === 22, `${register.rows.length} rows`);
check('no page number is missing from it',
    geometry.every((g) => register.rows.some((r) => r.pageNumber === g.pageNumber)));
const endToEnd = read('end-to-end.json');
check('every end-to-end policy produced a row for every page',
    endToEnd.every((e) => e.rows.length === 22), endToEnd.map((e) => `${e.policy} ${e.rows.length}`).join(', '));
const dropped = buildRow({ pageNumber: 99, fields: {}, templateFitted: false });
mustFire('a page that fails entirely still produces a row',
    dropped.pageNumber === 99 && dropped.reviewReasons.length > 0,
    `${dropped.reviewReasons.length} reasons`);
mustFire('and that row is not silently marked usable',
    dropped.reviewStatus === 'unconfirmed' && FIELDS.every((f) => dropped[f] === ''));

console.log('');
console.log('=== duplicates ===');
const dupRows = [
    { pageNumber: 1, drawing_number: 'A-101', extractionSource: 'native' },
    { pageNumber: 8, drawing_number: 'A-101', extractionSource: 'native' },
    { pageNumber: 2, drawing_number: 'A-102', extractionSource: 'native' },
];
check('two pages sharing a number are reported', findDuplicates(dupRows).length === 1);
mustFire('changing one of them clears the report',
    findDuplicates(dupRows.map((r) => (r.pageNumber === 8 ? { ...r, drawing_number: 'A-108' } : r))).length === 0);
mustFire('A-101 and A101 are not quietly merged',
    findDuplicates([{ pageNumber: 1, drawing_number: 'A-101', extractionSource: 'native' },
        { pageNumber: 2, drawing_number: 'A101', extractionSource: 'native' }]).length === 0);

console.log('');
console.log('=== gap inference stands down when it should ===');
const run = [101, 102, 104, 105].map((n, i) => ({
    pageNumber: i + 1, drawing_number: `A-${n}`, extractionSource: 'native',
}));
const found = findGapCandidates(run, { maxRunGap: 2 });
check('a single missing number in a run is offered as a candidate',
    found.candidates.length === 1 && found.candidates[0].number === 'A-103',
    found.candidates.map((c) => c.number).join(', '));
const withUnreadable = [...run, { pageNumber: 5, drawing_number: 'A-1O7', extractionSource: 'ocr' }];
mustFire('one unreadable number holds the whole check back',
    findGapCandidates(withUnreadable, { maxRunGap: 2 }).candidates.length === 0,
    'a misread number might be the one that looks missing');
const withOtherScheme = [...run, { pageNumber: 5, drawing_number: 'DETAIL-A', extractionSource: 'native' }];
const other = findGapCandidates(withOtherScheme, { maxRunGap: 2 });
mustFire('a different numbering scheme read straight off the page does not hold it back',
    other.candidates.length === 1 && other.otherScheme.length === 1,
    `${other.candidates.length} candidate(s), ${other.otherScheme.length} other-scheme value(s)`);
const sweep = read('gap-sweep.json');
const atTwo = sweep.sweep.find((s) => s.maxRunGap === 2);
const atTen = sweep.sweep.find((s) => s.maxRunGap === 10);
check('on the real set, the setting that finds the planted gap also invents at least one',
    atTwo.truePositives === 1 && atTwo.falsePositives >= 1,
    `${atTwo.falsePositives} false at maxRunGap=2`);
mustFire('a loose threshold is far worse, so the threshold is load-bearing',
    atTen.falsePositives > atTwo.falsePositives * 5,
    `${atTen.falsePositives} false at maxRunGap=10`);

console.log('');
console.log('=== confirmation is the only way a row becomes confirmed ===');
const candidate = buildRow({
    pageNumber: 3,
    fields: { drawing_number: { text: 'A-103', source: 'ocr', confidence: 41 } },
});
check('a low-confidence value is still extracted, not discarded', candidate.drawing_number === 'A-103');
mustFire('but it is queued for review',
    candidate.reviewReasons.some((r) => r.includes('low confidence')),
    candidate.reviewReasons.join('; '));
const allHigh = buildRow({
    pageNumber: 4,
    fields: Object.fromEntries(FIELDS.map((f) => [f, { text: 'x', source: 'native', confidence: 99 }])),
});
mustFire('and high confidence on every field still does not confirm it',
    allHigh.reviewStatus === 'unconfirmed' && allHigh.reviewReasons.length === 0,
    'nothing to review, and still unconfirmed');
const wasConfirmed = confirmRow(candidate, { drawing_number: 'A-108' });
check('an edit is recorded as an edit', wasConfirmed.reviewStatus === 'confirmed'
    && wasConfirmed.drawing_number === 'A-108'
    && wasConfirmed.confirmedFrom.extracted.drawing_number === 'A-103');

console.log('');
console.log('=== CSV ===');
const csv = toCsv([{
    pageNumber: 1, drawing_number: '=1+1', drawing_title: 'x', revision: '', revision_date: '',
    reviewStatus: 'confirmed', extractionSource: 'native',
}], { policy: 'raw', bom: true });
check('quoting alone does not stop a formula', isFormulaLead(parseCsv(csv)[1][1]),
    'the cell still begins with an equals sign');
mustFire('an ordinary value is not flagged as one', !isFormulaLead('A-101'));
const analysis = read('csv-analysis.json');
check('the strip policy loses a value outright',
    analysis.analysis.some((a) => a.value === '-' && a.policies.strip.written === ''),
    'a lone hyphen is a legitimate "no revision"');

if (has('csv-excel-verification.json')) {
    const excel = read('csv-excel-verification.json');
    console.log(`  (Microsoft Excel ${excel.excelVersion})`);
    const raw = excel.summary.raw;
    const xlsx = excel.summary['xlsx (app writer)'];
    const csvPolicies = Object.entries(excel.summary).filter(([k]) => k !== 'xlsx (app writer)');
    check('Excel evaluates formulas out of the raw CSV', raw.evaluated.length > 0,
        raw.evaluated.join(', '));
    check('every CSV policy alters or destroys an ordinary value',
        csvPolicies.every(([, r]) => r.altered.length + r.emptied.length > 0));
    check('001 loses its leading zeros under every CSV policy',
        csvPolicies.every(([, r]) => r.altered.some((a) => a.wrote === '001')));
    if (xlsx) {
        check('the workbook writer already in the app preserves all of them',
            xlsx.evaluated.length === 0 && xlsx.altered.length === 0 && xlsx.emptied.length === 0,
            `${xlsx.intact}/${xlsx.cells} intact`);
        mustFire('and that is not because the check cannot see a change',
            raw.altered.length > 0, 'the same check reports alterations for CSV');
    }
} else {
    console.log('  SKIP  actual spreadsheet verification (no results file; run the export probe)');
}

console.log('');
console.log('=== no network, no service ===');
const network = read('network.json');
check('OCR made no external requests', network.external.length === 0);
check('the OCR assets came from this repository', network.ocrAssets.length > 0
    && network.ocrAssets.every((u) => u.includes('/tesseract/') || u.includes('/tessdata/')),
    `${network.ocrAssets.length} local assets`);
check('no page errored during the probes', network.pageErrors.length === 0);

console.log('');
console.log(failures === 0
    ? 'All research assertions hold.'
    : `${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
