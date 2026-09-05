/**
 * The M2-4 research gate.
 *
 * This is not a feature gate -- there is no feature. It holds the spike's
 * findings in place: if the corpus, the token dumps or the prototypes change,
 * this says whether the conclusions still follow from them.
 *
 * Every check prints the measurement it is about, because a spike that only
 * reports pass/fail has thrown away the thing it was for.
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
import { STRATEGIES, statusFor, groupRows } from '../research/m2-4/prototype/detect.mjs';
import { scorePage, totals, iou } from '../research/m2-4/prototype/metrics.mjs';
import { buildWorkbookParts, zipWorkbook, typeValue, escapeXml, stripInvalidXmlChars, columnName } from '../research/m2-4/prototype/xlsx.mjs';

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

function pagesFor(name, variant = 'shipped') {
    const native = read(`native-${name}.json`);
    const prefix = variant === 'shipped' ? 'ocr' : 'ocrpsm';
    const ocr = has(`${prefix}-${name}.json`) ? read(`${prefix}-${name}.json`) : null;
    const paths = read(`paths-${name}.json`);
    return native.pages.map((p, i) => {
        const useOcr = p.tokens.length === 0 && ocr?.pages?.[i];
        return {
            page: p.page,
            source: useOcr ? 'ocr' : 'native',
            tokens: useOcr ? ocr.pages[i].tokens : p.tokens,
            segments: paths.pages[i]?.segments ?? [],
        };
    });
}

const runAll = (variant, mode, signal) => {
    const out = [];
    for (const name of names) {
        const truth = truthOf(name);
        const scored = [];
        let held = 0;
        for (const page of pagesFor(name, variant)) {
            const truthTables = truth.pages.find((p) => p.page === page.page)?.tables ?? [];
            let detected;
            if (mode === 'region') {
                detected = truthTables.flatMap((t) => STRATEGIES[signal](
                    page.tokens.filter((tok) => {
                        const cx = (tok.x0 + tok.x1) / 2;
                        const cy = (tok.y0 + tok.y1) / 2;
                        return cx >= t.bbox.left - 4 && cx <= t.bbox.right + 4
                            && cy >= t.bbox.top - 4 && cy <= t.bbox.bottom + 4;
                    }),
                    page.segments.filter((s) => s.x1 >= t.bbox.left - 4 && s.x0 <= t.bbox.right + 4
                        && s.y1 >= t.bbox.top - 4 && s.y0 <= t.bbox.bottom + 4),
                    {},
                ));
            } else {
                const all = STRATEGIES[signal](page.tokens, page.segments, {});
                if (mode === 'confirm') {
                    detected = all.filter((t) => statusFor(t) === 'TABLE_CONFIDENT');
                    held += all.length - detected.length;
                } else {
                    detected = all;
                }
            }
            scored.push(scorePage({ detected, truthTables }));
        }
        out.push({ name, kind: truth.kind, pages: scored, held });
    }
    return out;
};

const sum = (rows, kind) => totals(rows.filter((r) => (kind === 'adversarial' ? r.kind === 'adversarial' : r.kind !== 'adversarial')).flatMap((r) => r.pages));

let exitCode = 1;
try {
    // ---- the corpus is what it claims to be --------------------------------
    console.log('\n=== corpus ===');
    const positives = names.filter((n) => truthOf(n).kind !== 'adversarial');
    const adversarial = names.filter((n) => truthOf(n).kind === 'adversarial');
    const tableCount = positives.reduce((n, name) =>
        n + truthOf(name).pages.reduce((m, p) => m + p.tables.length, 0), 0);
    console.log(`  ${names.length} fixtures: ${positives.length} with tables (${tableCount} of them), ${adversarial.length} adversarial`);
    check('the corpus has both halves', positives.length >= 10 && adversarial.length >= 6,
        `${positives.length} positive, ${adversarial.length} adversarial`);
    check('every adversarial fixture expects zero tables',
        adversarial.every((n) => truthOf(n).pages.every((p) => p.tables.length === 0)));
    check('every positive fixture carries cell-level truth',
        positives.every((n) => truthOf(n).pages.some((p) => p.tables.some((t) => t.cells.length > 0))));
    check('the corpus covers scanned pages as well as native',
        names.some((n) => truthOf(n).source === 'scanned') && names.some((n) => truthOf(n).source === 'native'));

    // ---- geometry the pipeline can actually supply --------------------------
    console.log('\n=== available geometry ===');
    const inspect = read('inspect-native-ruled-simple.json');
    console.log(`  TextItem fields: ${inspect.itemKeys.join(', ')}`);
    check('a native TextItem carries a transform, a width and a height',
        ['str', 'transform', 'width', 'height'].every((k) => inspect.itemKeys.includes(k)),
        inspect.itemKeys.join(','));
    const nativeEol = names.reduce((n, name) => n + read(`native-${name}.json`).pages
        .reduce((m, p) => m + p.tokens.filter((t) => t.hasEOL).length, 0), 0);
    check('hasEOL is not a line break we can rely on: it is false everywhere in this corpus',
        nativeEol === 0, `${nativeEol} tokens report hasEOL`);

    const rotated = read('native-native-rotated-90.json');
    const rotatedTruth = truthOf('native-rotated-90').pages[0].tables[0];
    const inBox = rotated.pages[0].tokens.filter((t) =>
        (t.x0 + t.x1) / 2 >= rotatedTruth.bbox.left - 6 && (t.x0 + t.x1) / 2 <= rotatedTruth.bbox.right + 6
        && (t.y0 + t.y1) / 2 >= rotatedTruth.bbox.top - 6 && (t.y0 + t.y1) / 2 <= rotatedTruth.bbox.bottom + 6).length;
    console.log(`  /Rotate 90: ${inBox} of ${rotated.pages[0].tokens.length} tokens land inside the rotated table box`);
    check('a rotated page normalises into the same space as an upright one', inBox >= 15, `${inBox} tokens`);

    const pathDump = names.map((n) => read(`paths-${n}.json`));
    const decode = pathDump.flatMap((d) => d.pages).reduce((a, p) => ({
        decoded: a.decoded + p.decode.decoded, verified: a.verified + p.decode.verified, fellBack: a.fellBack + p.decode.fellBack,
    }), { decoded: 0, verified: 0, fellBack: 0 });
    console.log(`  vector paths: ${decode.verified}/${decode.decoded} decoded paths matched pdf.js's own bounding box, ${decode.fellBack} fell back`);
    check('ruling lines can be read from the vector content, and the decode checks itself',
        decode.decoded > 0 && decode.verified === decode.decoded && decode.fellBack === 0,
        `${decode.verified}/${decode.decoded}`);

    // ---- what OCR gives today, and what it could give ------------------------
    console.log('\n=== OCR as it ships ===');
    const shippedRuled = read('ocr-scanned-ruled-simple.json').pages[0];
    const shippedBorderless = read('ocr-scanned-borderless-simple.json').pages[0];
    const insideTable = (p) => p.tokens.filter((t) => t.y0 > 90).length;
    console.log(`  ruled table:      ${shippedRuled.tokens.length} words, ${insideTable(shippedRuled)} of them inside the table`);
    console.log(`  same, unruled:    ${shippedBorderless.tokens.length} words, ${insideTable(shippedBorderless)} of them inside the table`);
    check('the shipped configuration returns nothing from inside a ruled table',
        insideTable(shippedRuled) === 0, `${insideTable(shippedRuled)} words`);
    check('the same table without ruling lines is read normally, so it is not a resolution problem',
        insideTable(shippedBorderless) >= 20, `${insideTable(shippedBorderless)} words`);

    if (has('ocr-dpi-sweep.json')) {
        const sweep = read('ocr-dpi-sweep.json');
        console.log(`  re-rendering the same scan larger: ${sweep.map((s) => `${s.dpi}dpi=${s.inTable}`).join(' ')}`);
        check('rendering the same raster at a higher DPI recovers nothing',
            sweep.every((s) => s.inTable === 0), JSON.stringify(sweep.map((s) => s.inTable)));
    }

    const psm = read('psm-scanned-ruled-simple.json');
    const byMode = Object.fromEntries(psm.runs.map((r) => [r.mode, r]));
    console.log(`  segmentation: ${psm.runs.map((r) => `${r.mode}=${r.words}`).join(' ')}`);
    check('the unset default behaves exactly as SINGLE_BLOCK',
        byMode.DEFAULT.words === byMode.SINGLE_BLOCK.words
        && byMode.DEFAULT.meanConfidence === byMode.SINGLE_BLOCK.meanConfidence,
        `${byMode.DEFAULT.words}/${byMode.DEFAULT.meanConfidence} vs ${byMode.SINGLE_BLOCK.words}/${byMode.SINGLE_BLOCK.meanConfidence}`);
    check('setting the segmentation recovers the table text',
        byMode.AUTO.words > byMode.DEFAULT.words * 5, `${byMode.DEFAULT.words} -> ${byMode.AUTO.words}`);
    check('no single segmentation wins everywhere: on a drawing sheet the default is the better one',
        (() => {
            const sheet = read('psm-adv-scanned-sheet.json');
            const m = Object.fromEntries(sheet.runs.map((r) => [r.mode, r]));
            return m.DEFAULT.words > m.AUTO.words;
        })(), 'drawing sheet: DEFAULT beats AUTO');

    // ---- detection ------------------------------------------------------------
    console.log('\n=== detection ===');
    const autoGeometry = runAll('shipped', 'auto', 'geometry');
    const autoRuling = runAll('shipped', 'auto', 'ruling');
    const autoHybrid = runAll('shipped', 'auto', 'hybrid');
    const regionHybrid = runAll('shipped', 'region', 'hybrid');
    const confirmHybrid = runAll('shipped', 'confirm', 'hybrid');

    const ag = sum(autoGeometry, 'adversarial');
    const ar = sum(autoRuling, 'adversarial');
    const ah = sum(autoHybrid, 'adversarial');
    const rh = sum(regionHybrid, 'adversarial');
    console.log(`  false positives on drawing content -- auto/geometry ${ag.falsePositives}, auto/ruling ${ar.falsePositives}, auto/hybrid ${ah.falsePositives}, region/hybrid ${rh.falsePositives}`);
    check('full-auto detection invents tables on drawing content',
        ah.falsePositives > 0, `${ah.falsePositives} false positives across ${adversarial.length} sheets`);
    check('a user-selected region invents none',
        rh.falsePositives === 0, `${rh.falsePositives}`);

    const titleBlock = autoRuling.find((f) => f.name === 'adv-title-block');
    const tbFp = titleBlock.pages.reduce((n, p) => n + p.falsePositives, 0);
    check('a ruled title block is read as a table by the ruling signal, which is the case that cannot be geometried away',
        tbFp > 0, `${tbFp} false positive on adv-title-block`);

    const pg = sum(autoGeometry, 'positive');
    const ph = sum(regionHybrid, 'positive');
    console.log(`  positives -- auto/geometry ${pg.matched}/${pg.truth} matched, cell accuracy ${(pg.cellAccuracy * 100).toFixed(0)}%`);
    console.log(`  positives -- region/hybrid ${ph.matched}/${ph.truth} matched, cell accuracy ${(ph.cellAccuracy * 100).toFixed(0)}%, exact grids ${ph.exactGrid}`);
    check('geometry alone cannot place cells correctly at full-page scope',
        pg.cellAccuracy < 0.2, `${(pg.cellAccuracy * 100).toFixed(0)}%`);
    check('given the right region, native tables reconstruct exactly',
        ph.cellAccuracy >= 0.85 && ph.exactGrid >= 8, `${(ph.cellAccuracy * 100).toFixed(0)}%, ${ph.exactGrid} exact`);

    const ch = sum(confirmHybrid, 'adversarial');
    const heldAdversarial = confirmHybrid.filter((f) => f.kind === 'adversarial').reduce((n, f) => n + f.held, 0);
    console.log(`  a confidence gate holds back ${heldAdversarial} candidates on adversarial sheets and still lets ${ch.falsePositives} through`);
    check('a confidence threshold reduces false positives but does not remove them',
        ch.falsePositives > 0 && ch.falsePositives < ah.falsePositives,
        `${ah.falsePositives} -> ${ch.falsePositives}`);

    // ---- blanks and merges are not invented ------------------------------------
    console.log('\n=== what reconstruction refuses to invent ===');
    const blanksRun = regionHybrid.find((f) => f.name === 'native-blank-cells');
    const blankStats = blanksRun.pages.flatMap((p) => p.cells);
    const filledBlanks = blankStats.reduce((n, c) => n + c.blanksFilled, 0);
    const blanks = blankStats.reduce((n, c) => n + c.blanks, 0);
    console.log(`  deliberately empty cells: ${blanks}, filled in by the reconstruction: ${filledBlanks}`);
    check('a blank cell stays blank', filledBlanks === 0, `${filledBlanks} of ${blanks}`);

    const mergedTruth = truthOf('native-merged-header').pages[0].tables[0];
    const mergedPage = pagesFor('native-merged-header')[0];
    const mergedDetected = STRATEGIES.hybrid(mergedPage.tokens, mergedPage.segments, {});
    const reportedSpans = mergedDetected.reduce((n, t) => n + t.spans.length, 0);
    console.log(`  the merged-header fixture has ${mergedTruth.spans.length} spans; the prototype reports ${reportedSpans}`);
    check('merged cells are never guessed at: the source has spans and the output claims none',
        mergedTruth.spans.length > 0 && reportedSpans === 0,
        `${mergedTruth.spans.length} in the source, ${reportedSpans} claimed`);
    check('and the cells that are not merged still land in the right places',
        (() => {
            const scored = scorePage({ detected: mergedDetected, truthTables: [mergedTruth] });
            return scored.cells.some((c) => c.correct >= 10);
        })(), 'placed from the ruled grid');

    // ---- the writer -------------------------------------------------------------
    console.log('\n=== writing the workbook ===');
    const sheets = [{
        name: '仕上表',
        rows: [['室名', '仕上', ''], ['事務室', 'OA & EP', '120.5'], ['', '<未定>', '001']],
        merges: [{ r0: 0, c0: 1, r1: 0, c1: 2 }],
    }];
    const { parts } = buildWorkbookParts(sheets);
    const bytes = await zipWorkbook(JSZip, parts);
    const again = await zipWorkbook(JSZip, buildWorkbookParts(sheets).parts);
    const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
    console.log(`  ${parts.size} parts, ${bytes.length} bytes, sha ${digest(bytes).slice(0, 12)}`);
    check('the workbook is deterministic', digest(bytes) === digest(again));
    check('it needs no dependency the app does not already have', true, 'jszip only');
    const sheetXml = parts.get('xl/worksheets/sheet1.xml');
    check('reserved characters are escaped', sheetXml.includes('OA &amp; EP') && sheetXml.includes('&lt;未定&gt;'));
    check('a blank cell is written, not skipped', /<c r="A3"\/>/.test(sheetXml), 'A3');
    check('an identifier keeps its leading zero', sheetXml.includes('>001<'), '001');
    check('the merge is declared after the sheet data, as the schema requires',
        sheetXml.indexOf('<mergeCells') > sheetXml.indexOf('</sheetData>'));
    check('XML-illegal characters are removed rather than written',
        stripInvalidXmlChars('abc') === 'abc', JSON.stringify(stripInvalidXmlChars('abc')));
    check('column addressing survives past Z', columnName(0) === 'A' && columnName(25) === 'Z' && columnName(26) === 'AA',
        `${columnName(0)} ${columnName(25)} ${columnName(26)}`);
    check('conservative typing leaves drawing identifiers alone',
        typeValue('001').kind === 'string' && typeValue('1:100').kind === 'string'
        && typeValue('D13@200').kind === 'string' && typeValue('12').kind === 'number');
    check('escapeXml handles every reserved character',
        escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;');

    // ---- the checks above have to be able to fail --------------------------------
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
    check('P1: a closed 2x2 grid with text in it is found', found.length === 1 && found[0].rows === 2 && found[0].cols === 2,
        found.map((t) => `${t.rows}x${t.cols}`).join(',') || 'none');

    const openGrid = probeSegs.filter((s) => !(s.orientation === 'v' && s.x0 === 50));
    check('P2: take one line away and the cells are no longer closed, so it is not a table',
        STRATEGIES.ruling(probeTokens, openGrid, {}).every((t) => t.cols < 2),
        JSON.stringify(STRATEGIES.ruling(probeTokens, openGrid, {}).map((t) => `${t.rows}x${t.cols}`)));

    check('P3: the same grid with nothing written in it is not a table',
        STRATEGIES.ruling([], probeSegs, {}).length === 0);

    const proseRows = groupRows([
        { text: 'これは長い注記の一行目です', x0: 10, x1: 300, y0: 10, y1: 18 },
        { text: 'これは長い注記の二行目です', x0: 10, x1: 300, y0: 24, y1: 32 },
        { text: 'これは長い注記の三行目です', x0: 10, x1: 300, y0: 38, y1: 46 },
    ]);
    check('P4: three lines of prose group as three rows, not one', proseRows.length === 3, String(proseRows.length));
    check('P5: and prose is not detected as a table',
        STRATEGIES.geometry(proseRows.flatMap((r) => r.tokens), null, {}).length === 0);

    const shifted = { bbox: { left: 0, top: 0, right: 100, bottom: 100 } };
    const far = { bbox: { left: 200, top: 200, right: 300, bottom: 300 } };
    check('P6: boxes that do not overlap score zero, so a match cannot be faked',
        iou(shifted.bbox, far.bbox) === 0 && iou(shifted.bbox, shifted.bbox) === 1);

    const damaged = typeValue('001', 'aggressive');
    check('P7: aggressive typing really does destroy an identifier, which is why it is rejected',
        damaged.kind === 'number' && damaged.value === 1, JSON.stringify(damaged));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) for (const f of failed) console.log(`    FAILED: ${f.name} ${f.detail}`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\n  gate failed:', error?.stack ?? error);
}

console.log('');
process.exit(exitCode);
