/**
 * Score the table-detection prototypes against the corpus.
 *
 * Runs in Node over the token dumps the browser probe wrote, so the same input
 * is scored the same way every time.
 *
 * The report is split into four sections that must not be read as one:
 *
 *   1. Full-auto baseline          nothing asked of the user
 *   2. Oracle region baseline      the exact truth box handed over. An upper
 *                                  bound on reconstruction, and no evidence at
 *                                  all about what a user would get.
 *   3. User-selection robustness   the same box missed by a few points, drawn
 *                                  too wide, drawn too tight
 *   4. Adversarial explicit        a box drawn deliberately around a title
 *                                  block, a legend, a keynote list
 *
 * The first version of this script conflated 2 with 3 and reported "region mode
 * has zero false positives". On a page with no table there was no truth box, so
 * nothing was selected and no false positive was possible. That number measured
 * the harness, not the reconstructor. This one does not.
 *
 * Run:  node scripts/research-m2-4-geometry.mjs && node scripts/research-m2-4-tables.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES, statusFor, normaliseTokens, normaliseSegments, normaliseRect } from '../research/m2-4/prototype/detect.mjs';
import { scorePage, totals, scoreCells, scoreText, iou } from '../research/m2-4/prototype/metrics.mjs';
import { selectionsForTable, selectionForPage, tokensIn, segmentsIn } from '../research/m2-4/prototype/selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-4');
const TOKENS = path.join(FIX, 'tokens');
const OUT = path.join(FIX, 'results');

if (!fs.existsSync(TOKENS)) {
    console.error('No token dumps. Run: node scripts/research-m2-4-geometry.mjs');
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const names = fs.readdirSync(FIX).filter((f) => f.endsWith('.truth.json'))
    .map((f) => f.replace(/\.truth\.json$/, '')).sort();
const read = (file) => JSON.parse(fs.readFileSync(path.join(TOKENS, file), 'utf8'));
const has = (file) => fs.existsSync(path.join(TOKENS, file));
const truthOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8'));

const OCR_VARIANT = process.argv.includes('--ocr-auto') ? 'psm-auto' : 'shipped';
const suffix = OCR_VARIANT === 'shipped' ? '' : '-ocr-auto';

/** The tokens a reconstructor would be handed for each page of a document. */
function pagesFor(name) {
    const native = read(`native-${name}.json`);
    const prefix = OCR_VARIANT === 'shipped' ? 'ocr' : 'ocrpsm';
    const ocr = has(`${prefix}-${name}.json`) ? read(`${prefix}-${name}.json`) : null;
    const paths = read(`paths-${name}.json`);
    return native.pages.map((p, i) => {
        const useOcr = p.tokens.length === 0 && ocr?.pages?.[i];
        const tokens = useOcr ? ocr.pages[i].tokens : p.tokens;
        const segments = paths.pages[i]?.segments ?? [];
        const rotate = p.rotate ?? 0;
        return {
            page: p.page,
            rotate,
            width: p.width,
            height: p.height,
            source: useOcr ? 'ocr' : 'native',
            // Reconstruction happens in the page's upright space. Everything --
            // tokens, ruling lines and the answer key alike -- goes through the
            // same map, so a rotated page is compared like for like instead of
            // against a grid that is merely its transpose.
            tokens: normaliseTokens(tokens, rotate, p.width, p.height),
            segments: normaliseSegments(segments, rotate, p.width, p.height),
        };
    });
}

const SIGNALS = ['geometry', 'ruling', 'hybrid'];

// ---------------------------------------------------------------------------
// 1. Full-auto baseline
// ---------------------------------------------------------------------------

function fullAutoRun(signal, gated) {
    const perFixture = [];
    for (const name of names) {
        const truth = truthOf(name);
        const scored = [];
        let held = 0;
        for (const page of pagesFor(name)) {
            const truthTables = (truth.pages.find((p) => p.page === page.page)?.tables ?? [])
                .map((t) => (page.rotate ? {
                    ...t,
                    bbox: normaliseRect(t.bbox, page.rotate, page.width, page.height),
                    cells: t.cells.map((c) => ({ ...c, rect: normaliseRect(c.rect, page.rotate, page.width, page.height) })),
                } : t));
            const all = STRATEGIES[signal](page.tokens, page.segments, {});
            const kept = gated ? all.filter((t) => statusFor(t) === 'TABLE_CONFIDENT') : all;
            held += all.length - kept.length;
            scored.push(scorePage({ detected: kept, truthTables }));
        }
        perFixture.push({ name, kind: truth.kind, pages: scored, held });
    }
    return perFixture;
}

const fullAuto = Object.fromEntries(SIGNALS.map((s) => [s, fullAutoRun(s, false)]));
const fullAutoGated = Object.fromEntries(SIGNALS.map((s) => [s, fullAutoRun(s, true)]));

// ---------------------------------------------------------------------------
// 2-4. Selections
// ---------------------------------------------------------------------------

/**
 * Reconstruct inside one selection and record everything about the attempt.
 *
 * Scored against the table the selection was drawn for, when there is one. When
 * there is not -- an adversarial page -- what matters is simply what came back,
 * because the user is going to be shown it.
 */
function runSelection({ page, selection, truthTable, signal, policy = 'strict' }) {
    let detected;
    let tokens;
    if (policy === 'assist') {
        // Snap to a ruled grid when the selection is sitting on one, and fall
        // back to reading inside the rectangle when it is not. A ruled table
        // has edges of its own to snap to; a borderless one has only the box
        // the user drew, so that box has to be believed.
        tokens = tokensIn(page.tokens, selection.bbox);
        const ruled = STRATEGIES[signal](page.tokens, page.segments, {})
            .filter((t) => t.source === 'ruling' && iou(t.bbox, selection.bbox) > 0.3);
        if (ruled.length) {
            detected = ruled;
        } else {
            detected = STRATEGIES[signal](tokens, segmentsIn(page.segments, selection.bbox), {});
        }
    } else if (policy === 'snap') {
        // What an implementation would actually do: find the grids on the page,
        // then take the one the user pointed at. The selection says *which*
        // table, not where its edges are -- so a box drawn four points off does
        // not amputate the table's own border.
        tokens = tokensIn(page.tokens, selection.bbox);
        const all = STRATEGIES[signal](page.tokens, page.segments, {});
        detected = all.filter((t) => iou(t.bbox, selection.bbox) > 0.1);
    } else {
        // Strict: the rectangle is the world. Everything outside it, including
        // the table's own ruling lines, is invisible.
        tokens = tokensIn(page.tokens, selection.bbox);
        const segments = segmentsIn(page.segments, selection.bbox);
        detected = STRATEGIES[signal](tokens, segments, {});
    }
    // A selection is one gesture at one table, so the largest candidate inside
    // it is the one the user meant. Any others are recorded and count against
    // the selection rather than being quietly dropped.
    const best = detected.slice().sort((a, b) =>
        ((b.bbox.right - b.bbox.left) * (b.bbox.bottom - b.bbox.top))
        - ((a.bbox.right - a.bbox.left) * (a.bbox.bottom - a.bbox.top)))[0] ?? null;

    const record = {
        selection: selection.name,
        family: selection.family,
        policy,
        note: selection.note,
        bbox: selection.bbox,
        tokensInside: tokens.length,
        candidates: detected.length,
        status: best ? statusFor(best) : 'NO_TABLE',
        rows: best?.rows ?? 0,
        cols: best?.cols ?? 0,
        confidence: best?.confidence ?? null,
        source: best?.source ?? null,
    };

    if (truthTable) {
        record.iouWithTruth = +iou(selection.bbox, truthTable.bbox).toFixed(3);
        if (best) {
            const cells = scoreCells(best, truthTable);
            const text = scoreText(best, truthTable);
            Object.assign(record, {
                expected: cells.expected,
                correct: cells.correct,
                wrongCell: cells.wrongCell,
                missed: cells.missed,
                fabricated: cells.fabricated,
                blanks: cells.blanks,
                blanksFilled: cells.blanksFilled,
                exactGrid: cells.exactGrid,
                rowsMatch: cells.rowsMatch,
                colsMatch: cells.colsMatch,
                tokenRetention: +text.retention.toFixed(3),
                detectedIou: +iou(best.bbox, truthTable.bbox).toFixed(3),
            });
        } else {
            const expected = truthTable.cells.filter((c) => String(c.text).trim() !== '').length;
            Object.assign(record, {
                expected, correct: 0, wrongCell: 0, missed: expected, fabricated: 0,
                blanks: truthTable.cells.length - expected, blanksFilled: 0,
                exactGrid: false, rowsMatch: false, colsMatch: false,
                tokenRetention: 0, detectedIou: 0,
            });
        }
    }
    return record;
}

const selectionRuns = [];
for (const name of names) {
    const truth = truthOf(name);
    for (const page of pagesFor(name)) {
        const truthTables = (truth.pages.find((p) => p.page === page.page)?.tables ?? [])
            .map((t) => (page.rotate ? {
                ...t,
                bbox: normaliseRect(t.bbox, page.rotate, page.width, page.height),
                cells: t.cells.map((c) => ({ ...c, rect: normaliseRect(c.rect, page.rotate, page.width, page.height) })),
            } : t));

        for (const [index, table] of truthTables.entries()) {
            for (const selection of selectionsForTable(table)) {
                for (const policy of ['strict', 'snap', 'assist']) {
                    selectionRuns.push({
                        fixture: name, kind: truth.kind, page: page.page, table: index,
                        pageSource: page.source,
                        ...runSelection({ page, selection, truthTable: table, signal: 'hybrid', policy }),
                    });
                }
            }
        }

        // A page with no table is still a page a user can drag a box on.
        if (truthTables.length === 0) {
            const selection = selectionForPage(page.tokens);
            if (selection) {
                for (const policy of ['strict', 'snap', 'assist']) {
                    selectionRuns.push({
                        fixture: name, kind: truth.kind, page: page.page, table: null,
                        pageSource: page.source,
                        ...runSelection({ page, selection, truthTable: null, signal: 'hybrid', policy }),
                    });
                }
            }
        }
    }
}

fs.writeFileSync(path.join(OUT, `selections${suffix}.json`), `${JSON.stringify(selectionRuns, null, 1)}\n`);
fs.writeFileSync(path.join(OUT, `detection${suffix}.json`), `${JSON.stringify({ fullAuto, fullAutoGated }, null, 1)}\n`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (v) => `${(v * 100).toFixed(0)}%`;
const sum = (rows, kind) => totals(rows.filter((r) => (kind === 'adversarial'
    ? r.kind === 'adversarial' : r.kind !== 'adversarial')).flatMap((r) => r.pages));

const positives = names.filter((n) => truthOf(n).kind !== 'adversarial');
const adversarials = names.filter((n) => truthOf(n).kind === 'adversarial');
const tableCount = positives.reduce((n, name) =>
    n + truthOf(name).pages.reduce((m, p) => m + p.tables.length, 0), 0);

console.log(`\n  OCR tokens: ${OCR_VARIANT === 'shipped' ? 'as the app produces them today' : 'segmentation set to AUTO (research only)'}`);
console.log(`  corpus: ${tableCount} tables across ${positives.length} fixtures, plus ${adversarials.length} adversarial sheets`);

console.log('\n=== 1. FULL-AUTO BASELINE -- nothing asked of the user ===');
console.log('  signal        found  matched  missed   FP   cell acc   exact  |  adversarial FP  sheets');
for (const signal of SIGNALS) {
    const p = sum(fullAuto[signal], 'positive');
    const a = sum(fullAuto[signal], 'adversarial');
    const sheets = fullAuto[signal].filter((f) => f.kind === 'adversarial' && f.pages.some((x) => x.falsePositives > 0)).length;
    console.log(`  ${signal.padEnd(13)} ${String(p.detected).padStart(5)} ${String(p.matched).padStart(8)} ${String(p.falseNegatives).padStart(7)} ${String(p.falsePositives).padStart(4)}   ${pct(p.cellAccuracy).padStart(7)}   ${String(p.exactGrid).padStart(5)}  |  ${String(a.falsePositives).padStart(13)}  ${String(sheets).padStart(6)}`);
}
console.log('  the same detections behind a confidence gate:');
for (const signal of SIGNALS) {
    const p = sum(fullAutoGated[signal], 'positive');
    const a = sum(fullAutoGated[signal], 'adversarial');
    const held = fullAutoGated[signal].reduce((n, f) => n + f.held, 0);
    console.log(`  ${signal.padEnd(13)} ${String(p.detected).padStart(5)} ${String(p.matched).padStart(8)} ${String(p.falseNegatives).padStart(7)} ${String(p.falsePositives).padStart(4)}   ${pct(p.cellAccuracy).padStart(7)}   ${String(p.exactGrid).padStart(5)}  |  ${String(a.falsePositives).padStart(13)}  (${held} held)`);
}

const byFamily = (family, policy = 'strict') => selectionRuns.filter((r) => r.family === family && r.policy === policy);
const agg = (rows) => {
    const withTruth = rows.filter((r) => r.expected !== undefined);
    const expected = withTruth.reduce((n, r) => n + r.expected, 0);
    const correct = withTruth.reduce((n, r) => n + r.correct, 0);
    return {
        n: rows.length,
        expected,
        correct,
        accuracy: expected ? correct / expected : 0,
        exact: withTruth.filter((r) => r.exactGrid).length,
        fabricated: withTruth.reduce((n, r) => n + r.fabricated, 0),
        missed: withTruth.reduce((n, r) => n + r.missed, 0),
        wrongCell: withTruth.reduce((n, r) => n + r.wrongCell, 0),
        blanksFilled: withTruth.reduce((n, r) => n + r.blanksFilled, 0),
        retention: withTruth.length ? withTruth.reduce((n, r) => n + r.tokenRetention, 0) / withTruth.length : 0,
        nothing: rows.filter((r) => r.status === 'NO_TABLE' || r.status === 'UNSUPPORTED_LAYOUT').length,
        confident: rows.filter((r) => r.status === 'TABLE_CONFIDENT').length,
        needsConfirm: rows.filter((r) => r.status === 'TABLE_NEEDS_CONFIRMATION').length,
    };
};

console.log('\n=== 2. ORACLE REGION BASELINE -- the exact truth box, an upper bound only ===');
for (const policy of ['strict', 'snap', 'assist']) {
    const a = agg(byFamily('oracle', policy));
    console.log(`  ${policy.padEnd(6)} ${a.n} selections   cells ${a.correct}/${a.expected} (${pct(a.accuracy)})   exact ${a.exact}   fabricated ${a.fabricated}   blanks filled ${a.blanksFilled}   retention ${pct(a.retention)}`);
    console.log(`         status: ${a.confident} confident, ${a.needsConfirm} need confirmation, ${a.nothing} nothing found`);
}
console.log('  This says nothing about what a user would get. It is the ceiling the reconstructor can reach.');

console.log('\n=== 3. USER-SELECTION ROBUSTNESS -- the same tables, selected imperfectly ===');
console.log('  STRICT treats the rectangle as the world, so a box drawn a few points off cuts the');
console.log('  table\'s own border away. SNAP finds the grids on the page and takes the one the');
console.log('  user pointed at, which is what an implementation would do.');
console.log('');
console.log('  selection          strict cells  exact  |   snap cells   exact  |  assist cells  exact  fabricated');
const perSelection = new Map();
for (const r of selectionRuns.filter((x) => ['robustness', 'over', 'under'].includes(x.family))) {
    if (!perSelection.has(r.selection)) perSelection.set(r.selection, { strict: [], snap: [], assist: [] });
    perSelection.get(r.selection)[r.policy].push(r);
}
for (const [name, rows] of perSelection) {
    const st = agg(rows.strict);
    const sn = agg(rows.snap);
    const as = agg(rows.assist);
    console.log(`  ${name.padEnd(17)} ${String(st.correct).padStart(4)}/${String(st.expected).padEnd(4)} ${pct(st.accuracy).padStart(5)} ${String(st.exact).padStart(5)}  |  ${String(sn.correct).padStart(4)}/${String(sn.expected).padEnd(4)} ${pct(sn.accuracy).padStart(5)} ${String(sn.exact).padStart(5)}  |  ${String(as.correct).padStart(4)}/${String(as.expected).padEnd(4)} ${pct(as.accuracy).padStart(5)} ${String(as.exact).padStart(5)} ${String(as.fabricated).padStart(10)}`);
}
for (const family of ['robustness', 'over', 'under']) {
    const st = agg(byFamily(family, 'strict'));
    const sn = agg(byFamily(family, 'snap'));
    const as = agg(byFamily(family, 'assist'));
    console.log(`  -- ${family.padEnd(12)} ${String(st.n).padStart(3)} selections   strict ${pct(st.accuracy).padStart(4)}   snap ${pct(sn.accuracy).padStart(4)}   assist ${pct(as.accuracy).padStart(4)} (exact ${as.exact}, fabricated ${as.fabricated})`);
}

console.log('\n=== 4. ADVERSARIAL EXPLICIT SELECTION -- a box drawn around something that is not a schedule ===');
console.log('  fixture                        policy  tokens  candidates  grid    confidence  status');
for (const policy of ['strict', 'snap', 'assist']) {
    for (const r of byFamily('adversarial', policy)) {
        console.log(`  ${r.fixture.padEnd(30)} ${policy.padEnd(6)} ${String(r.tokensInside).padStart(6)}  ${String(r.candidates).padStart(10)}  ${`${r.rows}x${r.cols}`.padEnd(6)}  ${String(r.confidence ?? '-').padStart(10)}  ${r.status}`);
    }
    const a = agg(byFamily('adversarial', policy));
    console.log(`  -- ${policy}: ${a.confident} of ${a.n} reach TABLE_CONFIDENT, ${a.needsConfirm} held, ${a.nothing} produce nothing.`);
}

console.log('\n=== per fixture: the oracle, and the worst a user could do ===');
console.log('  (assist policy)');
console.log('  fixture                        src     oracle cells   worst selection      cells');
for (const name of names) {
    const rows = selectionRuns.filter((r) => r.fixture === name && r.expected !== undefined && r.policy === 'assist');
    if (!rows.length) continue;
    const oracle = rows.find((r) => r.family === 'oracle');
    const others = rows.filter((r) => r.family !== 'oracle');
    if (!oracle || !others.length) continue;
    const worst = others.slice().sort((a, b) => (a.correct / Math.max(1, a.expected)) - (b.correct / Math.max(1, b.expected)))[0];
    console.log(`  ${name.padEnd(30)} ${String(oracle.pageSource).padEnd(7)} ${String(oracle.correct).padStart(3)}/${String(oracle.expected).padEnd(4)}      ${worst.selection.padEnd(17)} ${String(worst.correct).padStart(4)}/${worst.expected}`);
}

const summary = {
    corpus: { fixtures: names.length, positives: positives.length, adversarial: adversarials.length, tables: tableCount },
    fullAuto: Object.fromEntries(SIGNALS.map((s) => [s, { positive: sum(fullAuto[s], 'positive'), adversarial: sum(fullAuto[s], 'adversarial') }])),
    fullAutoGated: Object.fromEntries(SIGNALS.map((s) => [s, { positive: sum(fullAutoGated[s], 'positive'), adversarial: sum(fullAutoGated[s], 'adversarial') }])),
    selections: Object.fromEntries(['oracle', 'robustness', 'over', 'under', 'adversarial'].map((f) => [f, {
        strict: agg(byFamily(f, 'strict')), snap: agg(byFamily(f, 'snap')), assist: agg(byFamily(f, 'assist')),
    }])),
    perSelection: Object.fromEntries([...perSelection].map(([k, v]) => [k, { strict: agg(v.strict), snap: agg(v.snap), assist: agg(v.assist) }])),
};
fs.writeFileSync(path.join(OUT, `detection-summary${suffix}.json`), `${JSON.stringify(summary, null, 1)}\n`);
console.log('\n  results written to test-fixtures/m2-4/results/\n');
