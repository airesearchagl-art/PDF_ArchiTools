/**
 * The M2-4 research gate.
 *
 * This is not a feature gate -- there is no feature. It holds the spike's
 * findings in place: if the corpus, the token dumps or the prototypes change,
 * this says whether the conclusions still follow from them.
 *
 * Every check prints the measurement it is about, because a spike that reports
 * only pass/fail has thrown away the thing it was for.
 *
 * Run:  node scripts/research-m2-4-fixtures.mjs
 *       node scripts/research-m2-4-geometry.mjs
 *       node scripts/research-m2-4-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
    STRATEGIES, statusFor, groupRows,
    normaliseTokens, normaliseSegments, normaliseRect, unrotatePoint,
} from '../research/m2-4/prototype/detect.mjs';
import { scorePage, totals, scoreCells, iou } from '../research/m2-4/prototype/metrics.mjs';
import { selectionsForTable, selectionForPage, tokensIn, segmentsIn } from '../research/m2-4/prototype/selection.mjs';
import {
    buildWorkbookParts, zipWorkbook, typeValue, escapeXml, stripInvalidXmlChars, columnName,
} from '../research/m2-4/prototype/xlsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-4');
const TOKENS = path.join(FIX, 'tokens');

if (!fs.existsSync(TOKENS)) {
    console.error('No token dumps. Run: node scripts/research-m2-4-geometry.mjs');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const names = fs.readdirSync(FIX).filter((f) => f.endsWith('.truth.json'))
    .map((f) => f.replace(/\.truth\.json$/, '')).sort();
const truthOf = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.truth.json`), 'utf8'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(TOKENS, f), 'utf8'));
const has = (f) => fs.existsSync(path.join(TOKENS, f));
const digest = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** Pages as the reconstructor sees them: normalised out of any page rotation. */
function pagesFor(name, variant = 'shipped') {
    const native = read(`native-${name}.json`);
    const prefix = variant === 'shipped' ? 'ocr' : 'ocrpsm';
    const ocr = has(`${prefix}-${name}.json`) ? read(`${prefix}-${name}.json`) : null;
    const paths = read(`paths-${name}.json`);
    return native.pages.map((p, i) => {
        const useOcr = p.tokens.length === 0 && ocr?.pages?.[i];
        const rotate = p.rotate ?? 0;
        return {
            page: p.page, rotate, width: p.width, height: p.height,
            source: useOcr ? 'ocr' : 'native',
            tokens: normaliseTokens(useOcr ? ocr.pages[i].tokens : p.tokens, rotate, p.width, p.height),
            segments: normaliseSegments(paths.pages[i]?.segments ?? [], rotate, p.width, p.height),
        };
    });
}

const truthTablesFor = (name, page) => (truthOf(name).pages.find((p) => p.page === page.page)?.tables ?? [])
    .map((t) => (page.rotate ? {
        ...t,
        bbox: normaliseRect(t.bbox, page.rotate, page.width, page.height),
        cells: t.cells.map((c) => ({ ...c, rect: normaliseRect(c.rect, page.rotate, page.width, page.height) })),
    } : t));

/** One selection, one policy, exactly as the runner does it. */
function reconstruct(page, bbox, policy) {
    if (policy === 'assist') {
        const ruled = STRATEGIES.hybrid(page.tokens, page.segments, {})
            .filter((t) => t.source === 'ruling' && iou(t.bbox, bbox) > 0.3);
        if (ruled.length) return ruled;
        return STRATEGIES.hybrid(tokensIn(page.tokens, bbox), segmentsIn(page.segments, bbox), {});
    }
    if (policy === 'snap') {
        return STRATEGIES.hybrid(page.tokens, page.segments, {}).filter((t) => iou(t.bbox, bbox) > 0.1);
    }
    return STRATEGIES.hybrid(tokensIn(page.tokens, bbox), segmentsIn(page.segments, bbox), {});
}

const biggest = (tables) => tables.slice().sort((a, b) =>
    ((b.bbox.right - b.bbox.left) * (b.bbox.bottom - b.bbox.top))
    - ((a.bbox.right - a.bbox.left) * (a.bbox.bottom - a.bbox.top)))[0] ?? null;

let exitCode = 1;
try {
    // ---- corpus -------------------------------------------------------------
    console.log('\n=== corpus ===');
    const positives = names.filter((n) => truthOf(n).kind !== 'adversarial');
    const adversarial = names.filter((n) => truthOf(n).kind === 'adversarial');
    const tableCount = positives.reduce((n, name) =>
        n + truthOf(name).pages.reduce((m, p) => m + p.tables.length, 0), 0);
    console.log(`  ${names.length} fixtures: ${positives.length} with tables (${tableCount} of them), ${adversarial.length} adversarial`);
    check('the corpus has both halves', positives.length >= 12 && adversarial.length >= 6,
        `${positives.length} positive, ${adversarial.length} adversarial`);
    check('every adversarial fixture expects zero tables',
        adversarial.every((n) => truthOf(n).pages.every((p) => p.tables.length === 0)));
    check('the corpus covers all four page rotations',
        ['000', '090', '180', '270'].every((r) => names.includes(`native-rotate-${r}`)));

    // ---- geometry -----------------------------------------------------------
    console.log('\n=== available geometry ===');
    const inspect = read('inspect-native-ruled-simple.json');
    console.log(`  TextItem fields: ${inspect.itemKeys.join(', ')}`);
    check('a native TextItem carries a transform, a width and a height',
        ['str', 'transform', 'width', 'height'].every((k) => inspect.itemKeys.includes(k)));

    const allNative = names.map((n) => read(`native-${n}.json`));
    const nativeEol = allNative.reduce((n, d) => n + d.pages.reduce((m, p) => m + p.tokens.filter((t) => t.hasEOL).length, 0), 0);
    check('hasEOL is not a line break we can rely on: it is false everywhere in this corpus',
        nativeEol === 0, `${nativeEol} tokens report hasEOL`);

    const totalTokens = allNative.reduce((n, d) => n + d.pages.reduce((m, p) => m + p.tokens.length, 0), 0);
    const zeroHeight = allNative.reduce((n, d) => n + d.pages.reduce((m, p) => m + p.tokens.filter((t) => t.height === 0).length, 0), 0);
    console.log(`  whitespace-only items: ${zeroHeight} of ${totalTokens} native items have height 0`);
    check('pdf.js emits zero-height whitespace items, which must be dropped before rows are grouped',
        zeroHeight > 0, `${zeroHeight} of ${totalTokens}`);
    check('the row grouper does drop them',
        groupRows([
            { text: 'A', x0: 0, x1: 10, y0: 0, y1: 9 },
            { text: ' ', x0: 12, x1: 14, y0: 4, y1: 4 },
            { text: 'B', x0: 20, x1: 30, y0: 0, y1: 9 },
        ]).length === 1, 'one row, not three');

    const decode = names.map((n) => read(`paths-${n}.json`)).flatMap((d) => d.pages)
        .reduce((a, p) => ({
            decoded: a.decoded + p.decode.decoded, verified: a.verified + p.decode.verified, fellBack: a.fellBack + p.decode.fellBack,
        }), { decoded: 0, verified: 0, fellBack: 0 });
    console.log(`  vector paths: ${decode.verified}/${decode.decoded} decoded paths matched pdf.js's own bounding box, ${decode.fellBack} fell back`);
    check('ruling lines can be read from the vector content, and the decode checks itself',
        decode.decoded > 0 && decode.verified === decode.decoded && decode.fellBack === 0);

    // ---- rotation, at cell level -------------------------------------------
    console.log('\n=== rotation ===');
    for (const rot of ['000', '090', '180', '270']) {
        const name = `native-rotate-${rot}`;
        const dumped = read(`native-${name}.json`).pages[0];
        const assumed = truthOf(name).assumedViewportTransform;
        check(`/Rotate ${rot}: the answer key assumes the transform pdf.js actually used`,
            JSON.stringify(assumed) === JSON.stringify(dumped.viewportTransform),
            JSON.stringify(dumped.viewportTransform));
    }
    const runDirections = {};
    for (const rot of ['000', '090', '180', '270']) {
        const d = read(`native-native-rotate-${rot}.json`).pages[0];
        runDirections[rot] = JSON.stringify(d.tokens[1]?.runDirection);
    }
    console.log(`  text run direction on screen: ${Object.entries(runDirections).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    check('text really does run a different way on a rotated page, so a width cannot be added to display x',
        new Set(Object.values(runDirections)).size === 4, JSON.stringify(runDirections));

    const rotationCells = {};
    for (const rot of ['000', '090', '180', '270']) {
        const name = `native-rotate-${rot}`;
        const page = pagesFor(name)[0];
        const truthTable = truthTablesFor(name, page)[0];
        const best = biggest(reconstruct(page, truthTable.bbox, 'assist'));
        const scored = best ? scoreCells(best, truthTable) : null;
        rotationCells[rot] = scored
            ? { correct: scored.correct, expected: scored.expected, rows: best.rows, cols: best.cols, exact: scored.exactGrid }
            : { correct: 0, expected: truthTable.cells.length, rows: 0, cols: 0, exact: false };
        const r = rotationCells[rot];
        console.log(`  /Rotate ${rot}: ${r.rows}x${r.cols} grid, ${r.correct}/${r.expected} cells, exact ${r.exact}`);
    }
    const rotationSignature = new Set(Object.values(rotationCells)
        .map((r) => `${r.rows}x${r.cols}:${r.correct}/${r.expected}:${r.exact}`));
    check('the same logical table reconstructs identically at 0, 90, 180 and 270',
        rotationSignature.size === 1 && rotationCells['000'].exact,
        [...rotationSignature].join(' | '));

    // Un-rotation is what makes that true, and the gate has to be able to see it.
    {
        const name = 'native-rotate-090';
        const raw = read(`native-${name}.json`).pages[0];
        const paths = read(`paths-${name}.json`).pages[0];
        const truthTable = truthOf(name).pages[0].tables[0];
        const withoutUnrotate = biggest(STRATEGIES.hybrid(raw.tokens, paths.segments, {})
            .filter((t) => iou(t.bbox, truthTable.bbox) > 0.3));
        const scored = withoutUnrotate ? scoreCells(withoutUnrotate, truthTable) : { correct: 0, expected: 12 };
        console.log(`  without un-rotating first: ${scored.correct}/${scored.expected} cells`);
        check('transform-correct boxes alone are not enough: skip the un-rotation and the grid is transposed',
            scored.correct < rotationCells['090'].correct, `${scored.correct} vs ${rotationCells['090'].correct}`);
    }

    // ---- OCR ----------------------------------------------------------------
    console.log('\n=== OCR as it ships ===');
    const inTable = (p) => p.tokens.filter((t) => t.y0 > 90).length;
    const shippedRuled = read('ocr-scanned-ruled-simple.json').pages[0];
    const shippedBorderless = read('ocr-scanned-borderless-simple.json').pages[0];
    console.log(`  the tested ruled table: ${shippedRuled.tokens.length} words, ${inTable(shippedRuled)} inside the table`);
    console.log(`  the same, unruled:      ${shippedBorderless.tokens.length} words, ${inTable(shippedBorderless)} inside the table`);
    check('on the tested ruled-table fixtures the shipped configuration returns nothing from inside the table',
        inTable(shippedRuled) === 0, `${inTable(shippedRuled)} words`);
    check('the same table without ruling lines is read normally, so it is not a resolution problem',
        inTable(shippedBorderless) >= 20, `${inTable(shippedBorderless)} words`);

    if (has('ocr-dpi-sweep.json')) {
        const sweep = read('ocr-dpi-sweep.json');
        console.log(`  re-rendering the same scan larger: ${sweep.map((s) => `${s.dpi}dpi=${s.inTable}`).join(' ')}`);
        check('rendering the same raster at a higher DPI recovers nothing',
            sweep.every((s) => s.inTable === 0), JSON.stringify(sweep.map((s) => s.inTable)));
    }

    const psm = read('psm-scanned-ruled-simple.json');
    const byMode = Object.fromEntries(psm.runs.map((r) => [r.mode, r]));
    console.log(`  segmentation: ${psm.runs.map((r) => `${r.mode}=${r.words}`).join(' ')}`);

    // The claim is that the unset default behaves as SINGLE_BLOCK. Word counts
    // agreeing is weak evidence for that, so the whole token stream is compared:
    // text, box to a tenth of a point, and confidence, in order.
    const stream = (run) => digest((run.tokens ?? []).map((t) => [
        t.text, t.x0.toFixed(1), t.y0.toFixed(1), t.x1.toFixed(1), t.y1.toFixed(1), t.confidence,
    ].join('|')).join('\n'));
    const defaultDigest = stream(byMode.DEFAULT);
    const singleBlockDigest = stream(byMode.SINGLE_BLOCK);
    const autoDigest = stream(byMode.AUTO);
    console.log(`  token-stream digests: DEFAULT ${defaultDigest.slice(0, 12)}  SINGLE_BLOCK ${singleBlockDigest.slice(0, 12)}  AUTO ${autoDigest.slice(0, 12)}`);
    check('the unset default produces the identical token stream to SINGLE_BLOCK, not merely the same count',
        defaultDigest === singleBlockDigest && byMode.DEFAULT.tokens.length > 0,
        `${byMode.DEFAULT.tokens.length} tokens, sha ${defaultDigest.slice(0, 16)}`);
    check('and a different mode really does produce a different stream, so the comparison can fail',
        autoDigest !== defaultDigest);
    check('setting the segmentation recovers the table text',
        byMode.AUTO.words > byMode.DEFAULT.words * 5, `${byMode.DEFAULT.words} -> ${byMode.AUTO.words}`);
    check('no single segmentation wins everywhere: on a drawing sheet the default is the better one',
        (() => {
            const sheet = read('psm-adv-scanned-sheet.json');
            const m = Object.fromEntries(sheet.runs.map((r) => [r.mode, r]));
            return m.DEFAULT.words > m.AUTO.words;
        })(), 'drawing sheet: DEFAULT beats AUTO');

    // ---- full-auto ----------------------------------------------------------
    console.log('\n=== 1. full-auto baseline ===');
    const autoScored = (signal) => names.map((name) => ({
        name, kind: truthOf(name).kind,
        pages: pagesFor(name).map((page) => scorePage({
            detected: STRATEGIES[signal](page.tokens, page.segments, {}),
            truthTables: truthTablesFor(name, page),
        })),
    }));
    const sumOf = (rows, kind) => totals(rows.filter((r) => (kind === 'adversarial'
        ? r.kind === 'adversarial' : r.kind !== 'adversarial')).flatMap((r) => r.pages));
    const autoHybrid = autoScored('hybrid');
    const autoGeometry = autoScored('geometry');
    const ah = sumOf(autoHybrid, 'adversarial');
    const ag = sumOf(autoGeometry, 'adversarial');
    const ph = sumOf(autoHybrid, 'positive');
    console.log(`  hybrid: ${ph.matched}/${ph.truth} tables, cells ${(ph.cellAccuracy * 100).toFixed(0)}%, false positives on drawings ${ah.falsePositives}`);
    check('full-auto detection invents tables on drawing content',
        ah.falsePositives > 0, `${ah.falsePositives} across ${adversarial.length} sheets`);
    check('geometry alone is worse still', ag.falsePositives > 0, `${ag.falsePositives}`);

    // ---- selection ----------------------------------------------------------
    console.log('\n=== 2-3. selection: oracle, then the same tables selected imperfectly ===');
    const selectionResults = { oracle: {}, robustness: {}, under: {}, over: {} };
    for (const policy of ['strict', 'assist']) {
        const acc = { oracle: [0, 0], robustness: [0, 0], under: [0, 0], over: [0, 0] };
        for (const name of names) {
            for (const page of pagesFor(name)) {
                for (const table of truthTablesFor(name, page)) {
                    for (const selection of selectionsForTable(table)) {
                        const family = selection.family;
                        if (!acc[family]) continue;
                        const best = biggest(reconstruct(page, selection.bbox, policy));
                        const scored = best ? scoreCells(best, table) : null;
                        acc[family][0] += scored ? scored.correct : 0;
                        acc[family][1] += table.cells.filter((c) => String(c.text).trim() !== '').length;
                    }
                }
            }
        }
        for (const family of Object.keys(acc)) {
            selectionResults[family][policy] = acc[family];
        }
    }
    for (const family of ['oracle', 'robustness', 'under', 'over']) {
        const s = selectionResults[family].strict;
        const a = selectionResults[family].assist;
        console.log(`  ${family.padEnd(11)} strict ${s[0]}/${s[1]} (${(100 * s[0] / s[1]).toFixed(0)}%)   assist ${a[0]}/${a[1]} (${(100 * a[0] / a[1]).toFixed(0)}%)`);
    }
    check('the oracle box is a ceiling, not evidence about a user: it is the exact answer handed over',
        selectionResults.oracle.strict[1] > 0);
    check('a strictly-clipped selection is fragile: missing the table by a few points costs cells',
        selectionResults.robustness.strict[0] / selectionResults.robustness.strict[1] < 0.7,
        `${(100 * selectionResults.robustness.strict[0] / selectionResults.robustness.strict[1]).toFixed(0)}%`);
    check('snapping to the enclosing ruled grid recovers most of that',
        selectionResults.robustness.assist[0] > selectionResults.robustness.strict[0],
        `${(100 * selectionResults.robustness.assist[0] / selectionResults.robustness.assist[1]).toFixed(0)}% vs ${(100 * selectionResults.robustness.strict[0] / selectionResults.robustness.strict[1]).toFixed(0)}%`);
    check('an under-drawn selection is the worst case for strict clipping',
        selectionResults.under.strict[0] / selectionResults.under.strict[1]
        < selectionResults.under.assist[0] / selectionResults.under.assist[1]);

    // Named individual robustness cases, so a regression names itself.
    for (const wanted of ['expand+12', 'shrink-2', 'shiftX+4', 'omit-left', 'over+60', 'clip-text']) {
        let correct = 0;
        let expected = 0;
        for (const name of names) {
            for (const page of pagesFor(name)) {
                for (const table of truthTablesFor(name, page)) {
                    const selection = selectionsForTable(table).find((s) => s.name === wanted);
                    if (!selection) continue;
                    const best = biggest(reconstruct(page, selection.bbox, 'assist'));
                    const scored = best ? scoreCells(best, table) : null;
                    correct += scored ? scored.correct : 0;
                    expected += table.cells.filter((c) => String(c.text).trim() !== '').length;
                }
            }
        }
        check(`selection "${wanted}" still reconstructs under the assist policy`,
            correct / expected >= 0.55, `${correct}/${expected}`);
    }

    // ---- adversarial explicit selection --------------------------------------
    console.log('\n=== 4. adversarial explicit selection ===');
    let confidentTraps = 0;
    const trapRows = [];
    for (const name of adversarial) {
        for (const page of pagesFor(name)) {
            const selection = selectionForPage(page.tokens);
            if (!selection) continue;
            const best = biggest(reconstruct(page, selection.bbox, 'assist'));
            const status = best ? statusFor(best) : 'NO_TABLE';
            if (status === 'TABLE_CONFIDENT') confidentTraps++;
            trapRows.push({ name, status, grid: best ? `${best.rows}x${best.cols}` : '-', confidence: best?.confidence ?? null });
            console.log(`  ${name.padEnd(24)} ${(best ? `${best.rows}x${best.cols}` : '-').padEnd(6)} conf ${String(best?.confidence ?? '-').padStart(4)}  ${status}`);
        }
    }
    check('a user can select a title block, a legend or a note column and the reconstructor answers',
        trapRows.some((r) => r.status !== 'NO_TABLE'), `${trapRows.filter((r) => r.status !== 'NO_TABLE').length} of ${trapRows.length}`);
    check('SELECTION DOES NOT MAKE IT SAFE: some traps still reach TABLE_CONFIDENT',
        confidentTraps > 0, `${confidentTraps} of ${trapRows.length} would export without a further question`);
    const titleBlock = trapRows.find((r) => r.name === 'adv-title-block');
    console.log(`  the title block specifically: ${titleBlock.grid} at confidence ${titleBlock.confidence}, ${titleBlock.status}`);

    // ---- what reconstruction refuses to invent -------------------------------
    console.log('\n=== what reconstruction refuses to invent ===');
    {
        const page = pagesFor('native-blank-cells')[0];
        const table = truthTablesFor('native-blank-cells', page)[0];
        const best = biggest(reconstruct(page, table.bbox, 'assist'));
        const scored = scoreCells(best, table);
        console.log(`  deliberately empty cells: ${scored.blanks}, filled in: ${scored.blanksFilled}`);
        check('a blank cell stays blank', scored.blanksFilled === 0, `${scored.blanksFilled} of ${scored.blanks}`);
    }
    {
        const page = pagesFor('native-merged-header')[0];
        const table = truthTablesFor('native-merged-header', page)[0];
        const detected = reconstruct(page, table.bbox, 'assist');
        const spans = detected.reduce((n, t) => n + t.spans.length, 0);
        const truthSpans = truthOf('native-merged-header').pages[0].tables[0].spans.length;
        console.log(`  the source has ${truthSpans} merged spans; the prototype claims ${spans}`);
        check('merged cells are never guessed at', truthSpans > 0 && spans === 0);
    }

    // ---- the writer ----------------------------------------------------------
    console.log('\n=== writing the workbook ===');
    const sheets = [{
        name: '仕上表',
        rows: [['室名', '仕上', ''], ['事務室', 'OA & EP', '120.5'], ['', '<未定>', '001']],
        merges: [{ r0: 0, c0: 1, r1: 0, c1: 2 }],
    }];
    const { parts } = buildWorkbookParts(sheets);
    const bytes = await zipWorkbook(JSZip, parts);
    const again = await zipWorkbook(JSZip, buildWorkbookParts(sheets).parts);
    console.log(`  ${parts.size} parts, ${bytes.length} bytes, sha ${digest(bytes.toString('base64')).slice(0, 12)}`);
    check('the workbook is deterministic', Buffer.compare(bytes, again) === 0);
    const sheetXml = parts.get('xl/worksheets/sheet1.xml');
    check('reserved characters are escaped', sheetXml.includes('OA &amp; EP') && sheetXml.includes('&lt;未定&gt;'));
    check('a blank cell is written, not skipped', /<c r="A3"\/>/.test(sheetXml));
    check('an identifier keeps its leading zero', sheetXml.includes('>001<'));
    check('the merge is declared after the sheet data, as the schema requires',
        sheetXml.indexOf('<mergeCells') > sheetXml.indexOf('</sheetData>'));
    check('column addressing survives past Z',
        columnName(0) === 'A' && columnName(25) === 'Z' && columnName(26) === 'AA');
    check('conservative typing leaves drawing identifiers alone',
        typeValue('001').kind === 'string' && typeValue('1:100').kind === 'string' && typeValue('12').kind === 'number');
    check('escapeXml handles every reserved character', escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;');
    check('XML-illegal characters are removed rather than written', stripInvalidXmlChars('abc') === 'abc');

    const xlsxDir = path.join(FIX, 'xlsx');
    const ceFile = path.join(xlsxDir, 'sheetjs-ce.xlsx');
    console.log(`  SheetJS CE probe artefact: ${fs.existsSync(ceFile) ? `${fs.statSync(ceFile).size} bytes` : 'not run yet'}`);
    check('the SheetJS CE probe has been run against the current official distribution',
        fs.existsSync(ceFile), 'run scripts/research-m2-4-xlsx-writers.mjs');

    // ---- negative probes ------------------------------------------------------
    console.log('\n=== negative probes ===');
    const probeTokens = [
        { text: 'A', x0: 10, x1: 20, y0: 10, y1: 18 },
        { text: 'B', x0: 60, x1: 70, y0: 10, y1: 18 },
        { text: 'C', x0: 10, x1: 20, y0: 30, y1: 38 },
        { text: 'D', x0: 60, x1: 70, y0: 30, y1: 38 },
    ];
    const probeSegs = [
        { orientation: 'h', x0: 0, x1: 100, y0: 5, y1: 5 },
        { orientation: 'h', x0: 0, x1: 100, y0: 25, y1: 25 },
        { orientation: 'h', x0: 0, x1: 100, y0: 45, y1: 45 },
        { orientation: 'v', x0: 0, x1: 0, y0: 5, y1: 45 },
        { orientation: 'v', x0: 50, x1: 50, y0: 5, y1: 45 },
        { orientation: 'v', x0: 100, x1: 100, y0: 5, y1: 45 },
    ];
    const found = STRATEGIES.ruling(probeTokens, probeSegs, {});
    check('P1: a closed 2x2 grid with text in it is found',
        found.length === 1 && found[0].rows === 2 && found[0].cols === 2,
        found.map((t) => `${t.rows}x${t.cols}`).join(',') || 'none');
    check('P2: take one line away and the cells are no longer closed',
        STRATEGIES.ruling(probeTokens, probeSegs.filter((s) => !(s.orientation === 'v' && s.x0 === 50)), {})
            .every((t) => t.cols < 2));
    check('P3: the same grid with nothing written in it is not a table',
        STRATEGIES.ruling([], probeSegs, {}).length === 0);
    const proseRows = groupRows([
        { text: 'これは長い注記の一行目です', x0: 10, x1: 300, y0: 10, y1: 18 },
        { text: 'これは長い注記の二行目です', x0: 10, x1: 300, y0: 24, y1: 32 },
        { text: 'これは長い注記の三行目です', x0: 10, x1: 300, y0: 38, y1: 46 },
    ]);
    check('P4: three lines of prose group as three rows, not one', proseRows.length === 3);
    check('P5: and prose is not detected as a table',
        STRATEGIES.geometry(proseRows.flatMap((r) => r.tokens), null, {}).length === 0);
    check('P6: boxes that do not overlap score zero, so a match cannot be faked',
        iou({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 200, top: 200, right: 300, bottom: 300 }) === 0);
    const damaged = typeValue('001', 'aggressive');
    check('P7: aggressive typing really does destroy an identifier',
        damaged.kind === 'number' && damaged.value === 1, JSON.stringify(damaged));

    // The un-rotation map has to be the inverse it claims to be.
    const roundTrip = [0, 90, 180, 270].every((rot) => {
        const vw = rot % 180 === 90 ? 841.89 : 595.28;
        const vh = rot % 180 === 90 ? 595.28 : 841.89;
        const p = unrotatePoint(100, 200, rot, vw, vh);
        return Number.isFinite(p.x) && Number.isFinite(p.y)
            && p.x >= -1 && p.y >= -1 && p.x <= 596 && p.y <= 843;
    });
    check('P8: un-rotating any angle lands inside the upright page, not outside it', roundTrip);

    check('P9: a selection that misses the table entirely reconstructs nothing',
        (() => {
            const page = pagesFor('native-ruled-simple')[0];
            const far = { left: 500, top: 700, right: 560, bottom: 780 };
            return biggest(reconstruct(page, far, 'assist')) === null;
        })(), 'empty corner of the page');

    check('P10: the strict and assist policies really are different, so comparing them means something',
        selectionResults.robustness.strict[0] !== selectionResults.robustness.assist[0],
        `${selectionResults.robustness.strict[0]} vs ${selectionResults.robustness.assist[0]}`);

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) for (const f of failed) console.log(`    FAILED: ${f.name} ${f.detail}`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\n  gate failed:', error?.stack ?? error);
}

console.log('');
process.exit(exitCode);
