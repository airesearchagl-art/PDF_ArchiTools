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
    buildRow, findDuplicates, findGapCandidates, confirmRow, displayValue,
    reviewSurface, attentionQueue, REVIEW_REASONS, FIELDS,
} from '../research/m2-5/prototype/register.mjs';
import {
    createAssignment, defineProfile, assignPages, profileFor, unassignedPages,
} from '../research/m2-5/prototype/template.mjs';
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
    'gap-sweep.json', 'csv-analysis.json', 'psm-enum.json', 'network.json',
    'rotated-scanned.json', 'profile-assignment.json'];
const missing = required.filter((f) => !has(f));
if (missing.length) {
    console.error(`Missing results: ${missing.join(', ')}`);
    console.error('Run the fixture, probe and register scripts first.');
    process.exit(1);
}

console.log('=== corpus ===');
const geometry = read('geometry.json');
check('every page in the set was measured', geometry.length === 25, `${geometry.length} pages`);
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
const denominator = perField.pages.length * perField.fieldsPerPage;
const byMode = (mode) => perField.runs.filter((p) => p.mode === mode).reduce((n, p) => n + p.hits, 0);
check('the segmentation denominator is a stated rule, not a slice',
    perField.rule.includes('scanned') && perField.rule.includes('layout === A'),
    `${perField.rule} -> pages ${perField.pages.join(', ')} = ${denominator} fields per mode`);
check('that rule excludes the layout-B scanned page the template does not address',
    !perField.pages.includes(11), 'p11 is layout B; the profile-A template does not apply to it');
check('and it includes every rotation, not only /Rotate 0',
    [90, 180, 270].every((r) => geometry.some((g) => perField.pages.includes(g.pageNumber) && g.rotate === r)),
    'the rotated scanned sheets are in the denominator');
check(`SINGLE_BLOCK reads the field regions`, byMode('SINGLE_BLOCK') > 0,
    `${byMode('SINGLE_BLOCK')}/${denominator}`);
mustFire('AUTO reads fewer of them, so the choice is doing work',
    byMode('AUTO') < byMode('SINGLE_BLOCK'),
    `AUTO ${byMode('AUTO')}/${denominator} vs SINGLE_BLOCK ${byMode('SINGLE_BLOCK')}/${denominator}`);

console.log('');
console.log('=== one row per page ===');
const register = read('register.json');
check('the register has a row for every page', register.rows.length === 25, `${register.rows.length} rows`);
check('no page number is missing from it',
    geometry.every((g) => register.rows.some((r) => r.pageNumber === g.pageNumber)));
const endToEnd = read('end-to-end.json');
check('every end-to-end policy produced a row for every page',
    endToEnd.every((e) => e.rows.length === 25), endToEnd.map((e) => `${e.policy} ${e.rows.length}`).join(', '));
const dropped = buildRow({ pageNumber: 99, fields: {}, templateFitted: false });
mustFire('a page that fails entirely still produces a row',
    dropped.pageNumber === 99 && dropped.reviewReasons.length > 0,
    `${dropped.reviewReasons.length} reasons`);
mustFire('and that row is not silently marked usable',
    dropped.reviewStatus === 'unconfirmed' && FIELDS.every((f) => dropped[f] === ''));

console.log('');
console.log('=== the page-level policy is actually page-level ===');
const byPolicy = (name) => endToEnd.find((e) => e.policy === name);
const pageLevel = byPolicy('page-level');
const fieldPerField = byPolicy('field-level, per-field OCR');
const fieldUnion = byPolicy('field-level, union OCR');
check('the page-level policy exists and decides per page',
    pageLevel && pageLevel.decide === 'page');
const mixedPage = 12;
const sourcesOn = (run) => FIELDS.map((f) => run.rows.find((r) => r.pageNumber === mixedPage).fields[f]?.source);
check('on a native-classified page it uses native for every field, with no OCR fallback',
    sourcesOn(pageLevel).every((src) => src === 'native'),
    sourcesOn(pageLevel).join(', '));
mustFire('the field-level policy does not, so the two really differ',
    new Set(sourcesOn(fieldPerField)).size > 1, sourcesOn(fieldPerField).join(', '));
const hitsOn = (run, pageNumber) => {
    const row = run.rows.find((r) => r.pageNumber === pageNumber);
    return FIELDS.filter((f) => {
        const want = row.expected[f] ?? '';
        const got = row.fields[f]?.rawText ?? '';
        return want !== '' && got.replace(/\s+/gu, '').includes(want.replace(/\s+/gu, ''));
    }).length;
};
mustFire('and on the mixed-source page the difference shows up as fields read',
    hitsOn(fieldPerField, mixedPage) > hitsOn(pageLevel, mixedPage),
    `page-level ${hitsOn(pageLevel, mixedPage)}/4 vs field-level ${hitsOn(fieldPerField, mixedPage)}/4`);
check('page-level scores lower overall, which is the cost of the page-level shortcut',
    pageLevel.exact < fieldPerField.exact,
    `${pageLevel.exact}/${pageLevel.total} vs ${fieldPerField.exact}/${fieldPerField.total}`);

console.log('');
console.log('=== the OCR path the architecture proposes, end to end ===');
check('the proposed per-field pipeline was run over the whole set',
    fieldPerField.ocr === 'per-field' && fieldPerField.rows.length === 25,
    `${fieldPerField.ocrCalls} OCR calls, ${(fieldPerField.ocrPixels / 1e6).toFixed(2)} Mpx`);
check('the union path was run over the same set for comparison',
    fieldUnion.ocr === 'union' && fieldUnion.rows.length === 25,
    `${fieldUnion.ocrCalls} OCR calls, ${(fieldUnion.ocrPixels / 1e6).toFixed(2)} Mpx`);
check('union assigns every recognised word to a field on this corpus',
    fieldUnion.unplacedWords === 0, `${fieldUnion.unplacedWords} words unplaced`);
check('union is not worse than per-field, so per-field cannot be adopted for accuracy',
    fieldUnion.exact >= fieldPerField.exact,
    `union ${fieldUnion.exact}/${fieldUnion.total} vs per-field ${fieldPerField.exact}/${fieldPerField.total}`);
check('union uses far fewer calls',
    fieldUnion.ocrCalls < fieldPerField.ocrCalls / 3,
    `${fieldUnion.ocrCalls} vs ${fieldPerField.ocrCalls}`);
check('and more pixels, which is the real trade',
    fieldUnion.ocrPixels > fieldPerField.ocrPixels,
    `${(fieldUnion.ocrPixels / 1e6).toFixed(2)} vs ${(fieldPerField.ocrPixels / 1e6).toFixed(2)} Mpx`);
mustFire('union does produce a per-field confidence, so "it cannot attribute" is false',
    FIELDS.every((f) => {
        const row = fieldUnion.rows.find((r) => r.pageNumber === 9);
        return row.fields[f]?.source !== 'ocr' || typeof row.fields[f].confidence === 'number';
    }), 'every OCR field on p9 carries its own confidence');

console.log('');
console.log('=== scanned regions, through every rotation ===');
const rotated = read('rotated-scanned.json');
const rotatedOnly = rotated.correct.filter((r) => r.rotate !== 0);
const correctHits = rotatedOnly.reduce((n, r) => n + r.hits, 0);
const wrongHits = rotated.wrong.reduce((n, r) => n + r.hits, 0);
check('the scanned ROI path was exercised at 90, 180 and 270',
    [90, 180, 270].every((r) => rotatedOnly.some((x) => x.rotate === r)),
    rotatedOnly.map((r) => `${r.rotate}:${r.hits}/${r.of}`).join('  '));
check('the same upright rectangles read the fields at every rotation',
    rotatedOnly.every((r) => r.hits >= 3),
    `${correctHits}/${rotatedOnly.length * FIELDS.length} fields`);
mustFire('rendering the same regions through the page rotation reads nothing',
    wrongHits === 0 && rotated.wrong.length > 0,
    `${wrongHits}/${rotated.wrong.length * FIELDS.length} fields -- the crop is right and the glyphs are sideways`);

console.log('');
console.log('=== per-field provenance survives display and confirmation ===');
const raw = '\u56f3\u9762\u756a\u53f7\nA-101';
const provRow = buildRow({
    pageNumber: 1,
    fields: {
        drawing_number: { rawText: raw, source: 'native' },
        drawing_title: { rawText: 'PLAN', source: 'ocr', confidence: 55 },
    },
});
check('the display value is derived from the raw text',
    provRow.fields.drawing_number.value === 'A-101');
mustFire('and the raw text is not replaced by it',
    provRow.fields.drawing_number.rawText === raw,
    JSON.stringify(provRow.fields.drawing_number.rawText));
mustFire('a different display policy changes the value and not the raw text',
    (() => {
        const verbatim = buildRow({
            pageNumber: 1,
            fields: { drawing_number: { rawText: raw, source: 'native' } },
            deriveValue: (t) => t.trim(),
        });
        return verbatim.fields.drawing_number.value === raw
            && verbatim.fields.drawing_number.rawText === raw
            && verbatim.fields.drawing_number.value !== provRow.fields.drawing_number.value;
    })(), 'same raw text, two different values');
check('each field carries its own source and confidence',
    provRow.fields.drawing_number.source === 'native'
    && provRow.fields.drawing_title.source === 'ocr'
    && provRow.fields.drawing_title.confidence === 55);
mustFire('a row-level summary alone would lose that',
    provRow.extractionSource === 'mixed'
    && provRow.fields.drawing_number.source !== provRow.fields.drawing_title.source,
    'row says "mixed"; only the fields say which is which');
const mixedRow = read('register.json').rows.find((r) => r.pageNumber === mixedPage);
check('the mixed-source page keeps a per-field source in the register',
    new Set(FIELDS.map((f) => mixedRow.fields[f].source)).size > 1,
    FIELDS.map((f) => `${f}=${mixedRow.fields[f].source}`).join(' '));
const confirmedProv = confirmRow(provRow, { drawing_number: 'A-108' });
check('confirmation keeps the raw text, the proposed value and the final value',
    confirmedProv.confirmedFrom.raw.drawing_number === raw
    && confirmedProv.confirmedFrom.proposed.drawing_number === 'A-101'
    && confirmedProv.confirmedFrom.final.drawing_number === 'A-108');
mustFire('and says which fields a person actually changed',
    confirmedProv.confirmedFrom.edited.length === 1
    && confirmedProv.confirmedFrom.edited[0] === 'drawing_number',
    confirmedProv.confirmedFrom.edited.join(', '));
mustFire('the raw text is still there after confirmation',
    confirmedProv.fields.drawing_number.rawText === raw
    && confirmedProv.fields.drawing_number.value === 'A-108');
check('displayValue is the rule being applied, and it is reversible only via rawText',
    displayValue(raw) === 'A-101' && displayValue('') === '');

console.log('');
console.log('=== every row reaches a person ===');
const registerFile = read('register.json');
const surface = registerFile.reviewSurface;
const attention = registerFile.attentionQueue;
check('the review surface holds one entry for every page in',
    surface.length === geometry.length,
    `${surface.length} rows on the surface, ${geometry.length} pages in`);
check('the attention queue is a strict subset of it, not the surface itself',
    attention.length < surface.length && attention.every((a) => surface.some((r) => r.pageNumber === a.pageNumber)),
    `${attention.length} flagged of ${surface.length}`);
check('nothing on the surface is confirmed without a person',
    surface.every((r) => r.reviewStatus === 'unconfirmed'));

// The row this whole distinction exists for: wrong, and carrying no flag.
const wrongUnflagged = registerFile.unflaggedButWrong;
check('the corpus still contains a row that is wrong and unflagged',
    wrongUnflagged.length > 0, `pages ${wrongUnflagged.join(', ')}`);
for (const pageNumber of wrongUnflagged) {
    const entry = surface.find((r) => r.pageNumber === pageNumber);
    check(`page ${pageNumber} is wrong, unflagged, and still on the review surface`,
        Boolean(entry) && entry.reasons.length === 0,
        entry ? `position ${surface.indexOf(entry) + 1} of ${surface.length}` : 'MISSING');
    mustFire(`filtering the surface by flags would drop page ${pageNumber}`,
        !attention.some((a) => a.pageNumber === pageNumber),
        'which is exactly what the old queue did');
}
mustFire('an all-clear row is still on the surface',
    (() => {
        const clean = [buildRow({
            pageNumber: 1,
            fields: Object.fromEntries(FIELDS.map((f) => [f, { rawText: 'x', source: 'native', confidence: 99 }])),
        })];
        return reviewSurface(clean).length === 1 && attentionQueue(clean).length === 0;
    })(), 'surface 1, attention 0');

console.log('');
console.log('=== a template profile is assigned, never inferred ===');
const assignmentFile = read('profile-assignment.json');
const probe = assignmentFile.unassignedProbe;
check('every assignment records who confirmed it',
    assignmentFile.assignedPages.every((a) => Boolean(a.confirmedBy)),
    `${assignmentFile.assignedPages.length} assignments`);
check('the corpus has two layouts on one sheet size, so size cannot decide it',
    probe.rows.every((r) => r.size === 'A2') && probe.sameSizeAssigned.length > 0,
    `unassigned ${probe.unassigned.join(', ')} share A2 with assigned ${probe.sameSizeAssigned.join(', ')}`);
check('a page nobody assigned has no profile',
    probe.rows.every((r) => !r.hasConfirmedProfile));
mustFire('templateFits would have waved those very pages through',
    probe.rows.every((r) => r.templateFitsAnyway),
    'which is why it is not the assignment gate');
mustFire('and auto-continuing on it reads nothing',
    probe.rows.reduce((n, r) => n + r.fieldsReadIfAutoContinued, 0) === 0,
    `0/${probe.rows.length * FIELDS.length} fields`);
const liveAssignment = createAssignment();
defineProfile(liveAssignment, 'A', { template: { source: {} }, model: 'normalised' });
assignPages(liveAssignment, [1, 2], 'A', { confirmedBy: 'gate' });
check('an assigned page resolves to its profile', profileFor(liveAssignment, 1)?.name === 'A');
mustFire('an unassigned page resolves to null rather than to the only profile there is',
    profileFor(liveAssignment, 7) === null && unassignedPages(liveAssignment, [1, 7]).join() === '7');
mustFire('an assignment with nobody behind it is refused',
    (() => {
        try {
            assignPages(liveAssignment, [3], 'A', { confirmedBy: '' });
            return false;
        } catch {
            return true;
        }
    })(), 'assignPages throws without confirmedBy');
const unassignedRow = buildRow({ pageNumber: 7, fields: {}, profileAssigned: false });
check('an unassigned page still produces a row, with its own reason',
    unassignedRow.pageNumber === 7
    && unassignedRow.reviewReasons[0] === REVIEW_REASONS.NO_PROFILE_ASSIGNED
    && unassignedRow.extractionSource === 'unassigned');
mustFire('and that reason is not the same as a template that missed',
    REVIEW_REASONS.NO_PROFILE_ASSIGNED !== REVIEW_REASONS.TEMPLATE_DID_NOT_FIT);

console.log('');
console.log('=== rawText is what the extraction layer said, unchanged ===');
const messy = '  \u56f3\u9762\u756a\u53f7 \n  A-101  \n';
const messyRow = buildRow({
    pageNumber: 1,
    fields: { drawing_number: { rawText: messy, source: 'native' } },
});
check('leading and trailing whitespace survives into the row',
    messyRow.fields.drawing_number.rawText === messy,
    JSON.stringify(messyRow.fields.drawing_number.rawText));
mustFire('the row did not trim it on the way in',
    messyRow.fields.drawing_number.rawText !== messy.trim(),
    'buildRow used to call .trim() here');
check('the display value is still clean',
    messyRow.fields.drawing_number.value === 'A-101',
    JSON.stringify(messyRow.fields.drawing_number.value));
mustFire('two display rules give two values and one identical raw text',
    (() => {
        const verbatim = buildRow({
            pageNumber: 1,
            fields: { drawing_number: { rawText: messy, source: 'native' } },
            deriveValue: (t) => t,
        });
        return verbatim.fields.drawing_number.value === messy
            && verbatim.fields.drawing_number.value !== messyRow.fields.drawing_number.value
            && verbatim.fields.drawing_number.rawText === messyRow.fields.drawing_number.rawText;
    })());
const messyConfirmed = confirmRow(messyRow, { drawing_number: 'A-108' });
mustFire('and confirmation does not touch it either',
    messyConfirmed.fields.drawing_number.rawText === messy
    && messyConfirmed.confirmedFrom.raw.drawing_number === messy
    && messyConfirmed.fields.drawing_number.value === 'A-108');

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
