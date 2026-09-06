/**
 * Turn the extraction into a register, and measure what it costs a person.
 *
 * Runs in Node over what the browser probe wrote, so the same input gives the
 * same answer every time. This is where the questions that are not about OCR
 * get answered: does every page keep a row, how many fields does somebody
 * actually have to look at, what do the duplicate and gap checks claim, and
 * what happens to a value a spreadsheet would treat as a formula.
 *
 * Run:  node scripts/research-m2-5-probe.mjs && node scripts/research-m2-5-register.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    FIELDS, buildRow, annotateRegister, reviewQueue, confirmRow, findGapCandidates, LOW_CONFIDENCE,
} from '../research/m2-5/prototype/register.mjs';
import { toCsv, parseCsv, analysePolicies, POLICIES, isFormulaLead, COLUMNS } from '../research/m2-5/prototype/csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-5');
const OUT = path.join(FIX, 'results');

if (!fs.existsSync(path.join(OUT, 'end-to-end.json'))) {
    console.error('No probe results. Run: node scripts/research-m2-5-probe.mjs');
    process.exit(1);
}

const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'drawing-set.truth.json'), 'utf8'));
const endToEnd = JSON.parse(fs.readFileSync(path.join(OUT, 'end-to-end.json'), 'utf8'));
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);
const norm = (s) => String(s ?? '').replace(/\s+/gu, '').trim();

const run = endToEnd.find((r) => r.policy === 'field-level, union OCR') ?? endToEnd[0];

/**
 * A field region holds its label as well as its value.
 *
 * That is not a fixture quirk: a title-block cell says 図面番号 and then the
 * number, and a rectangle drawn round the cell contains both. Taking the region
 * verbatim therefore yields "図面番号\nA-101", which reads fine to a person and
 * is useless to a machine -- the duplicate check compares whole strings and the
 * numbering parser needs a number, so both silently stop working.
 *
 * Two ways out, measured against each other rather than assumed:
 *
 *   whole-region  the region as extracted. What the user drew is what you get.
 *   last-line     the last non-empty line of the region. A label sits above or
 *                 before its value in every layout in this corpus, so the last
 *                 line is the value -- a rule that is cheap, explicable, and
 *                 wrong the moment a layout puts the label underneath.
 *
 * The third option is not a rule at all: ask the user to draw the *value* area
 * rather than the whole cell. That costs nothing at extraction time and is the
 * only one that cannot be defeated by a layout, which is why the measurement
 * below matters more for what it rules out than for what it picks.
 */
const VALUE_POLICIES = {
    'whole-region': (text) => text.trim(),
    'last-line': (text) => {
        const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : '';
    },
};

// The policy chooses how the *value* is derived; the raw text goes in
// untouched either way, and the row keeps it. That is the whole point of the
// split -- a display rule must never be able to destroy what was on the page.
const buildRows = (policy) => run.rows.map((r) => buildRow({
    pageNumber: r.pageNumber,
    fields: r.fields,
    deriveValue: VALUE_POLICIES[policy],
}));

console.log('\n=== label and value inside one field region ===');
const sample = run.rows.find((r) => r.pageNumber === 1);
console.log(`  page 1, drawing_number as extracted: ${JSON.stringify(sample.fields.drawing_number.rawText)}`);
for (const policy of Object.keys(VALUE_POLICIES)) {
    console.log(`    ${policy.padEnd(13)} -> ${JSON.stringify(VALUE_POLICIES[policy](sample.fields.drawing_number.rawText))}`);
}

const byPolicy = {};
for (const policy of Object.keys(VALUE_POLICIES)) {
    const candidate = buildRows(policy);
    const annotated = annotateRegister(candidate);
    let exact = 0;
    let contains = 0;
    let scoredHere = 0;
    for (const row of candidate) {
        const want = truth.pages.find((p) => p.page === row.pageNumber).values;
        for (const field of FIELDS) {
            const expected = want[field] ?? '';
            if (expected === '') continue;
            scoredHere++;
            if (norm(row[field]) === norm(expected)) exact++;
            if (norm(row[field]).includes(norm(expected))) contains++;
        }
    }
    byPolicy[policy] = {
        exact, contains, scored: scoredHere,
        duplicates: annotated.duplicates,
        gaps: annotated.gaps,
    };
    console.log(`  ${policy.padEnd(13)} exact ${exact}/${scoredHere}   contains the value ${contains}/${scoredHere}   duplicates found ${annotated.duplicates.length}   gap candidates ${annotated.gaps.candidates.length}`);
}
write('value-policies.json', byPolicy);

// Everything below uses the policy the measurement supports.
const VALUE_POLICY = byPolicy['last-line'].exact >= byPolicy['whole-region'].exact ? 'last-line' : 'whole-region';
console.log(`  using "${VALUE_POLICY}" for the register below`);

// ---------------------------------------------------------------------------
// One row per page
// ---------------------------------------------------------------------------

console.log('\n=== the register ===');
const rows = buildRows(VALUE_POLICY);
const { duplicates, gaps } = annotateRegister(rows);

console.log(`  ${rows.length} pages in, ${rows.length} rows out`);
const pagesIn = truth.pages.length;
console.log(`  every page kept a row: ${rows.length === pagesIn} (${rows.length}/${pagesIn})`);

console.log('\n  page  drawing number   source   review reasons');
for (const row of rows) {
    console.log(`  ${String(row.pageNumber).padStart(4)}  ${row.drawing_number.slice(0, 15).padEnd(16)} ${row.extractionSource.padEnd(8)} ${row.reviewReasons.length ? row.reviewReasons.join('; ').slice(0, 70) : '-'}`);
}

// ---------------------------------------------------------------------------
// Accuracy against what was drawn
// ---------------------------------------------------------------------------

console.log('\n=== how much of it is right, before anyone looks ===');
let correct = 0;
let wrong = 0;
let blank = 0;
let expectedBlank = 0;
const perField = Object.fromEntries(FIELDS.map((f) => [f, { correct: 0, wrong: 0, blank: 0 }]));

for (const row of rows) {
    const want = truth.pages.find((p) => p.page === row.pageNumber).values;
    for (const f of FIELDS) {
        const expected = want[f] ?? '';
        const actual = row[f] ?? '';
        if (expected === '') { expectedBlank++; continue; }
        if (actual === '') { blank++; perField[f].blank++; continue; }
        if (norm(actual).includes(norm(expected))) { correct++; perField[f].correct++; }
        else { wrong++; perField[f].wrong++; }
    }
}
const scored = correct + wrong + blank;
console.log(`  ${correct}/${scored} fields carry the value that was drawn  (${((correct / scored) * 100).toFixed(0)}%)`);
console.log(`  wrong ${wrong}   came back empty ${blank}   deliberately blank in the source ${expectedBlank}`);
for (const f of FIELDS) {
    console.log(`    ${f.padEnd(15)} correct ${String(perField[f].correct).padStart(2)}  wrong ${String(perField[f].wrong).padStart(2)}  empty ${String(perField[f].blank).padStart(2)}`);
}

// ---------------------------------------------------------------------------
// Review burden
// ---------------------------------------------------------------------------

console.log('\n=== what a person has to do ===');
const queue = reviewQueue(rows);
const totalFields = rows.length * FIELDS.length;
const flagged = new Set(queue.map((q) => q.pageNumber));
console.log(`  ${rows.length} pages x ${FIELDS.length} fields = ${totalFields} values`);
console.log(`  rows with something to look at: ${queue.length}/${rows.length}`);
console.log(`  rows with nothing flagged:      ${rows.length - queue.length}`);
console.log(`  values that are wrong or empty: ${wrong + blank}`);
console.log('');
console.log('  queue, worst first:');
for (const item of queue.slice(0, 10)) {
    console.log(`    p${String(item.pageNumber).padStart(2)}  ${item.reasons.length} reason(s)  lowest confidence ${item.lowestConfidence === null ? '-' : Math.round(item.lowestConfidence)}  ${item.reasons[0]}`);
}
if (queue.length > 10) console.log(`    ... and ${queue.length - 10} more`);

// A row nobody flagged can still be wrong. That is the number that matters for
// whether confidence may ever stand in for a person.
const unflaggedButWrong = rows.filter((row) => {
    if (flagged.has(row.pageNumber)) return false;
    const want = truth.pages.find((p) => p.page === row.pageNumber).values;
    return FIELDS.some((f) => (want[f] ?? '') !== '' && !norm(row[f]).includes(norm(want[f])));
});
console.log(`\n  rows with nothing flagged that are nevertheless wrong: ${unflaggedButWrong.length}` +
    `${unflaggedButWrong.length ? ` (pages ${unflaggedButWrong.map((r) => r.pageNumber).join(', ')})` : ''}`);

write('register.json', { rows, duplicates, gaps, queue, accuracy: { correct, wrong, blank, expectedBlank, perField } });

// ---------------------------------------------------------------------------
// Duplicate and gap
// ---------------------------------------------------------------------------

console.log('\n=== duplicates and gaps ===');
console.log(`  duplicate drawing numbers: ${duplicates.length ? duplicates.map((d) => `${d.number} on pages ${d.pages.join(' and ')}`).join('; ') : 'none'}`);
console.log(`  gap candidates: ${gaps.candidates.length ? gaps.candidates.map((c) => `${c.number} (between ${c.between.join(' and ')})`).join('; ') : 'none'}`);
console.log('  prefixes where gap inference was switched off:');
for (const s of gaps.skipped) console.log(`    ${s.prefix.padEnd(8)} ${s.reason}`);

// Against what the corpus was built with.
const expectedDuplicate = 'A-101';
const expectedGap = 'A-103';
console.log('');
console.log(`  the corpus contains one deliberate duplicate (${expectedDuplicate}) -- found: ${duplicates.some((d) => d.number === expectedDuplicate)}`);
console.log(`  and one deliberate gap (${expectedGap}) -- found: ${gaps.candidates.some((c) => c.number === expectedGap)}`);
const falseGaps = gaps.candidates.filter((c) => c.number !== expectedGap);
console.log(`  gap candidates that are not the planted one: ${falseGaps.length}${falseGaps.length ? ` (${falseGaps.map((c) => c.number).join(', ')})` : ''}`);

// ---------------------------------------------------------------------------
// Review and confirmation
// ---------------------------------------------------------------------------

console.log('\n=== review and confirmation ===');
const beforeConfirm = rows.filter((r) => r.reviewStatus === 'confirmed').length;
// A person corrects the rows that came back wrong or empty, and accepts the
// rest. Nothing here promotes a row on its own.
const confirmed = rows.map((row) => {
    const want = truth.pages.find((p) => p.page === row.pageNumber).values;
    const edits = {};
    for (const f of FIELDS) {
        const expected = want[f] ?? '';
        if (expected === '') continue;
        // A reviewer confirming a register makes the cell hold the value, not
        // the value with its label still attached. Accepting "label + number"
        // would understate the work and leave the number unparseable.
        if (norm(row[f]) !== norm(expected)) edits[f] = expected;
    }
    return confirmRow(row, edits);
});
const edited = confirmed.filter((r) => r.confirmedFrom.edited.length > 0);
console.log(`  rows confirmed without a human: ${beforeConfirm} (by design: confidence never confirms)`);
console.log(`  rows a person had to edit: ${edited.length}/${confirmed.length}` +
    `${edited.length ? ` (pages ${edited.map((r) => r.pageNumber).join(', ')})` : ''}`);
console.log(`  fields edited: ${confirmed.reduce((n, r) => n + r.confirmedFrom.edited.length, 0)}/${totalFields}`);
console.log(`  every row confirmed carries what was edited and what was extracted: ${confirmed.every((r) => r.confirmedFrom)}`);

// ---------------------------------------------------------------------------
// The same checks, after review
// ---------------------------------------------------------------------------

console.log('\n=== duplicates and gaps, run again after review ===');
const afterReview = annotateRegister(confirmed.map((r) => ({ ...r, reviewReasons: [] })));
console.log(`  duplicates: ${afterReview.duplicates.length ? afterReview.duplicates.map((d) => `${d.number} on pages ${d.pages.join(' and ')}`).join('; ') : 'none'}`);
console.log(`  gap candidates: ${afterReview.gaps.candidates.length ? afterReview.gaps.candidates.map((c) => `${c.number} (between ${c.between.join(' and ')})`).join('; ') : 'none'}`);
for (const skip of afterReview.gaps.skipped) console.log(`  held back: ${skip.prefix} -- ${skip.reason}`);
console.log('');
console.log(`  the planted gap (${expectedGap}) is found once the numbers are readable: ${afterReview.gaps.candidates.some((c) => c.number === expectedGap)}`);
const falseAfter = afterReview.gaps.candidates.filter((c) => c.number !== expectedGap);
console.log(`  candidates that are not the planted one: ${falseAfter.length}${falseAfter.length ? ` (${falseAfter.map((c) => c.number).join(', ')})` : ''}`);
console.log(`  the mixed-scheme prefix (DETAIL-A) did not produce a run: ${!afterReview.gaps.candidates.some((c) => c.prefix === 'DETAIL')}`);
write('register-after-review.json', {
    duplicates: afterReview.duplicates,
    gaps: afterReview.gaps,
    beforeReview: { duplicates, gaps },
});

// ---------------------------------------------------------------------------
// How wide a jump may be before it stops being a gap
// ---------------------------------------------------------------------------

console.log('\n=== gap inference: where the false positives come from ===');
console.log('  A drawing set skips numbers on purpose -- a discipline change, a');
console.log('  reserved block, a cancelled sheet. So the only question is how big a');
console.log('  jump may be before calling it a gap stops being useful.');
console.log('');
console.log('  maxRunGap  candidates  true  false  what a reviewer would be shown');
const sweep = [];
for (const maxRunGap of [1, 2, 3, 5, 10]) {
    const found = findGapCandidates(confirmed.map((r) => ({ ...r })), { maxRunGap });
    const truePositives = found.candidates.filter((c) => c.number === expectedGap).length;
    const falsePositives = found.candidates.length - truePositives;
    sweep.push({ maxRunGap, candidates: found.candidates.length, truePositives, falsePositives });
    const shown = found.candidates.slice(0, 4).map((c) => c.number).join(', ');
    console.log(`  ${String(maxRunGap).padStart(9)}  ${String(found.candidates.length).padStart(10)}  ${String(truePositives).padStart(4)}  ${String(falsePositives).padStart(5)}  ${shown}${found.candidates.length > 4 ? ` … +${found.candidates.length - 4}` : ''}`);
}
const best = sweep.filter((r) => r.truePositives > 0).sort((a, b) => a.falsePositives - b.falsePositives)[0];
console.log('');
console.log(`  the planted gap is still found at maxRunGap=${best.maxRunGap}, with ${best.falsePositives} false candidate(s) alongside it`);
console.log(`  every setting that finds it also invents at least one, on a set of only ${confirmed.length} pages.`);
write('gap-sweep.json', { sweep, expectedGap });

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

console.log('\n=== CSV ===');
const csv = toCsv(confirmed, { policy: 'prefix-quote', bom: true });
fs.writeFileSync(path.join(OUT, 'register.csv'), csv, 'utf8');
const parsed = parseCsv(csv);
console.log(`  ${parsed.length - 1} data rows, ${COLUMNS.length} columns, ${Buffer.byteLength(csv, 'utf8')} bytes`);
console.log(`  header: ${parsed[0].join(',')}`);
console.log(`  BOM present: ${csv.charCodeAt(0) === 0xfeff}`);
console.log(`  CRLF line endings: ${csv.includes('\r\n')}`);

const japanese = confirmed.find((r) => /[぀-ヿ一-鿿]/.test(r.drawing_title));
const jaRow = parsed.find((r) => r[0] === String(japanese.pageNumber));
console.log(`  Japanese survives: ${jaRow?.[2] === japanese.drawing_title} (${jaRow?.[2]})`);

// The values a spreadsheet reads as formulas.
console.log('\n=== values a spreadsheet would treat as a formula ===');
const DANGEROUS = ['=1+1', '+3', '-1', '@ABC 仮設計画', '-', '=SUM(A1:A9)', '+81-3-1234'];
const analysis = analysePolicies(DANGEROUS);
console.log('  value            policy         written        evaluates  round-trips  shown in Excel');
for (const entry of analysis) {
    for (const [name, r] of Object.entries(entry.policies)) {
        console.log(`  ${entry.value.slice(0, 15).padEnd(16)} ${name.padEnd(14)} ${JSON.stringify(r.written).slice(0, 14).padEnd(14)} ${String(r.evaluates).padEnd(10)} ${String(r.roundTrips).padEnd(12)} ${JSON.stringify(r.visibleInExcel).slice(0, 16)}`);
    }
}
const summary = {};
for (const name of Object.keys(POLICIES)) {
    const evaluates = analysis.filter((a) => a.policies[name].evaluates).length;
    const roundTrips = analysis.filter((a) => a.policies[name].roundTrips).length;
    const visible = analysis.filter((a) => a.policies[name].visibleInExcel === a.value).length;
    summary[name] = { evaluates, roundTrips, visible, of: analysis.length };
    console.log(`  -- ${name.padEnd(14)} evaluates as a formula ${evaluates}/${analysis.length}   round-trips ${roundTrips}/${analysis.length}   shows the original ${visible}/${analysis.length}`);
}

// Quoting on its own, which is the assumption worth killing.
const quotedOnly = toCsv([{
    pageNumber: 1, drawing_number: '=1+1', drawing_title: '', revision: '', revision_date: '',
    reviewStatus: 'confirmed', extractionSource: 'native',
}], { policy: 'raw', bom: false });
console.log(`\n  quoting alone writes: ${JSON.stringify(quotedOnly.split('\r\n')[1])}`);
console.log(`  the cell still begins with "=", so a spreadsheet still evaluates it: ${isFormulaLead('=1+1')}`);

// A CSV for the spreadsheet probe to open, under each policy.
//
// The dangerous values alone would only show that a policy stops formulas.
// The ordinary ones -- a leading-zero number, a drawing number, Japanese, a
// value with a comma, a value with a line break -- are what a safety policy is
// most likely to quietly damage, so they go into the same file.
const ORDINARY = ['A-101', '001', '設備 平面図', 'A-101, A-102', '図面番号\nA-101'];
const SAMPLES = [...DANGEROUS, ...ORDINARY];
for (const policy of Object.keys(POLICIES)) {
    const sample = SAMPLES.map((value, i) => ({
        pageNumber: i + 1, drawing_number: value, drawing_title: `題名 ${value}`,
        revision: 'A', revision_date: '2026.09.01',
        reviewStatus: 'confirmed', extractionSource: 'native',
    }));
    fs.writeFileSync(path.join(OUT, `csv-policy-${policy}.csv`), toCsv(sample, { policy, bom: true }), 'utf8');
}
write('csv-analysis.json', { analysis, summary, columns: COLUMNS });
write('csv-samples.json', { samples: SAMPLES, dangerous: DANGEROUS, ordinary: ORDINARY });

console.log('\n  register, queue and CSV written to test-fixtures/m2-5/results/\n');
