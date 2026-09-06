/**
 * Deterministic smoke verification for native table -> Excel export.
 *
 * Drives the production modules in a real browser against synthetic fixtures.
 * Small on purpose: this is a gate, not a test framework. It exits non-zero if
 * any check fails.
 *
 * The two things this feature can get wrong and still look fine are covered
 * explicitly: a cell that quietly changes meaning on its way into a
 * spreadsheet, and a structural score being mistaken for a statement that the
 * selection was a table. Everything else follows from those.
 *
 * Run:  node scripts/make-excel-fixtures.mjs && node scripts/smoke-excel-export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'excel');
const PORT = 5187;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIX, 'native-ruled-simple.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-excel-fixtures.mjs')], { stdio: 'inherit' });
}

const truthOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8'));

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
/** Any OCR asset request at all, so "Excel never starts OCR" is provable. */
const ocrAssets = [];
const record = (url) => {
    if (!url) return;
    if (url.startsWith(`${ORIGIN}/ocr/`)) ocrAssets.push(url.slice(ORIGIN.length));
    if (url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* target already gone */ }
});

/** The answer key's table box, padded the way a hand would draw it. */
const boxOf = (truth, pageNumber = 1, index = 0) => truth.pages.find((p) => p.page === pageNumber).tables[index].bbox;
const grow = (b, d) => ({ left: b.left - d, top: b.top - d, right: b.right + d, bottom: b.bottom + d });
const move = (b, dx, dy) => ({ left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy });
const gridEquals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-excel-export-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__excelReady === true, { timeout: 120000 });

    // ---- geometry ----------------------------------------------------------
    console.log('\n=== page geometry ===');
    const simpleGeom = await page.evaluate(() => window.__excel.geometry('native-ruled-simple'));
    console.log(`  native-ruled-simple: ${simpleGeom.tokens} tokens, ${simpleGeom.segments} ruling segments, scanned=${simpleGeom.scanned}`);
    check('a native page yields tokens and ruling lines',
        simpleGeom.tokens > 0 && simpleGeom.segments > 0 && !simpleGeom.scanned);
    check('whitespace-only items never reach the reconstructor',
        simpleGeom.whitespaceTokens === 0 && simpleGeom.zeroHeight === 0,
        `${simpleGeom.whitespaceTokens} whitespace, ${simpleGeom.zeroHeight} zero-height`);

    const borderlessGeom = await page.evaluate(() => window.__excel.geometry('native-borderless'));
    console.log(`  native-borderless:   ${borderlessGeom.tokens} tokens, ${borderlessGeom.segments} ruling segments`);
    check('a borderless table has tokens and no ruling lines',
        borderlessGeom.tokens > 0 && borderlessGeom.segments === 0);

    const scannedGeom = await page.evaluate(() => window.__excel.geometry('scanned-ruled'));
    check('a scanned page reports itself as scanned, with no tokens',
        scannedGeom.scanned && scannedGeom.tokens === 0);

    // A run's box has to follow the text, not the screen.
    const quads = await page.evaluate(() => ({
        upright: window.__excel.quad([10, 0, 0, 10, 100, 700], 50, 10, [1, 0, 0, -1, 0, 841.89]),
        rotated: window.__excel.quad([10, 0, 0, 10, 100, 700], 50, 10, [0, 1, 1, 0, 0, 0]),
    }));
    const spanX = (q) => Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x));
    const spanY = (q) => Math.max(...q.map((p) => p.y)) - Math.min(...q.map((p) => p.y));
    console.log(`  run quad: upright spans ${spanX(quads.upright).toFixed(1)}x${spanY(quads.upright).toFixed(1)}, rotated ${spanX(quads.rotated).toFixed(1)}x${spanY(quads.rotated).toFixed(1)}`);
    check('a run laid out on a quarter-turned page runs down the display, not across it',
        spanX(quads.upright) > spanY(quads.upright) && spanY(quads.rotated) > spanX(quads.rotated),
        'width follows the text');

    // ---- reconstruction, exact selection -------------------------------------
    console.log('\n=== reconstruction ===');
    const CASES = ['ruled-simple', 'ruled-identifiers', 'borderless', 'blank-cells', 'multiline', 'sparse'];
    for (const name of CASES) {
        const fixture = `native-${name}`;
        const truth = truthOf(fixture);
        const table = truth.pages[0].tables[0];
        const result = await page.evaluate((n, r) => window.__excel.reconstruct(n, r), fixture, grow(table.bbox, 4));
        const exact = gridEquals(result.grid, table.expected);
        console.log(`  ${fixture.padEnd(28)} ${result.rows}x${result.cols} ${result.status} score ${result.structureScore} source ${result.source}`);
        check(`${name}: the grid has the shape it was drawn with`,
            result.rows === table.rows && result.cols === table.cols,
            `${result.rows}x${result.cols} vs ${table.rows}x${table.cols}`);
        check(`${name}: every cell comes back with the text it was drawn with`, exact,
            exact ? '' : JSON.stringify(result.grid));
    }

    // Japanese and English both survive, and are checked by value.
    const simpleTruth = truthOf('native-ruled-simple');
    const simple = await page.evaluate((r) => window.__excel.reconstruct('native-ruled-simple', r),
        grow(boxOf(simpleTruth), 4));
    check('Japanese text is preserved exactly',
        simple.grid[1][1] === 'タイルカーペット' && simple.grid[0][0] === '室名',
        `${simple.grid[0][0]} / ${simple.grid[1][1]}`);
    check('English text is preserved exactly',
        simple.grid[2][0] === 'Meeting Room' && simple.grid[2][2] === 'Plaster Board');

    // Blank cells and multiline are the two that are easy to lose.
    const blankTruth = truthOf('native-blank-cells');
    const blanks = await page.evaluate((r) => window.__excel.reconstruct('native-blank-cells', r),
        grow(boxOf(blankTruth), 4));
    const blankCount = blanks.grid.flat().filter((c) => c === '').length;
    console.log(`  blank cells preserved: ${blankCount}`);
    check('a deliberately empty cell stays empty and keeps its place',
        blankCount === 3 && blanks.grid[1][2] === '' && blanks.grid[1][3] === '4',
        `${blankCount} blanks`);

    const multilineTruth = truthOf('native-multiline');
    const multiline = await page.evaluate((r) => window.__excel.reconstruct('native-multiline', r),
        grow(boxOf(multilineTruth), 4));
    check('both lines of a two-line cell are kept',
        multiline.grid[1][1].includes('床仕上げは施工前に') && multiline.grid[1][1].includes('監理者の承認を得ること'),
        JSON.stringify(multiline.grid[1][1]));

    // ---- rotation -------------------------------------------------------------
    console.log('\n=== rotation ===');
    const rotationGrids = {};
    for (const rot of ['000', '090', '180', '270']) {
        const fixture = `native-rotate-${rot}`;
        const truth = truthOf(fixture);
        const table = truth.pages[0].tables[0];
        const geom = await page.evaluate((n) => window.__excel.geometry(n), fixture);
        const result = await page.evaluate((n, r) => window.__excel.reconstruct(n, r), fixture, grow(table.bbox, 4));
        rotationGrids[rot] = result.grid;
        console.log(`  /Rotate ${rot}: display ${geom.displayWidth.toFixed(0)}x${geom.displayHeight.toFixed(0)} upright ${geom.uprightWidth.toFixed(0)}x${geom.uprightHeight.toFixed(0)} -> ${result.rows}x${result.cols}, cells match ${gridEquals(result.grid, table.expected)}`);
        check(`/Rotate ${rot}: the same table reconstructs exactly`,
            gridEquals(result.grid, table.expected),
            `${result.rows}x${result.cols}`);
    }
    check('all four rotations produce the identical grid',
        new Set(Object.values(rotationGrids).map((g) => JSON.stringify(g))).size === 1);

    // The drag itself is in canvas pixels, and that path has to agree.
    for (const rot of ['000', '090', '270']) {
        const fixture = `native-rotate-${rot}`;
        const table = truthOf(fixture).pages[0].tables[0];
        const geom = await page.evaluate((n) => window.__excel.geometry(n), fixture);
        const scale = 720 / geom.displayWidth;
        // Convert the upright answer box back into display space, then into
        // canvas pixels: exactly the trip a real pointer drag makes in reverse.
        const displayBox = await page.evaluate((r, rotate, w, h) => {
            // toUprightRect is its own inverse for 0/180, and swaps for 90/270.
            const inverse = { 0: 0, 90: 270, 180: 180, 270: 90 }[rotate];
            return window.__excel.upright(r, inverse, rotate % 180 === 90 ? h : w, rotate % 180 === 90 ? w : h);
        }, grow(table.bbox, 4), Number(rot), geom.displayWidth, geom.displayHeight);
        const canvasRect = {
            left: displayBox.left * scale, top: displayBox.top * scale,
            right: displayBox.right * scale, bottom: displayBox.bottom * scale,
        };
        const viaCanvas = await page.evaluate((n, r, s) => window.__excel.reconstructFromCanvas(n, r, s), fixture, canvasRect, scale);
        check(`/Rotate ${rot}: a canvas-pixel selection reaches the same grid`,
            gridEquals(viaCanvas.result.grid, table.expected),
            `${viaCanvas.result.rows}x${viaCanvas.result.cols}`);
    }

    // ---- selection robustness --------------------------------------------------
    console.log('\n=== selection robustness ===');
    const box = boxOf(simpleTruth);
    const expected = simpleTruth.pages[0].tables[0].expected;
    const VARIANTS = [
        ['exact', box],
        ['expand +4', grow(box, 4)],
        ['expand +24', grow(box, 24)],
        ['shrink -2', grow(box, -2)],
        ['shrink -4', grow(box, -4)],
        ['shift x +4', move(box, 4, 0)],
        ['shift x -4', move(box, -4, 0)],
        ['shift y +4', move(box, 0, 4)],
        ['shift y -4', move(box, 0, -4)],
        ['over-select +60', grow(box, 60)],
        ['under: omit left', { ...box, left: box.left + 40 }],
        ['under: omit first row', { ...box, top: box.top + 12 }],
    ];
    for (const [label, rect] of VARIANTS) {
        const result = await page.evaluate((r) => window.__excel.reconstruct('native-ruled-simple', r), rect);
        const same = gridEquals(result.grid, expected);
        console.log(`  ${label.padEnd(18)} ${result.rows}x${result.cols}  ${same ? 'exact' : 'DIFFERS'}  source ${result.source}`);
        check(`selection "${label}" still reads the whole table`, same,
            same ? '' : `${result.rows}x${result.cols}`);
    }

    const snap = await page.evaluate((r) => window.__excel.snap('native-ruled-simple', r), move(box, 4, 0));
    check('the snap uses the ruled grid\'s own edges, not the rectangle\'s',
        snap.snapped !== null && Math.abs(snap.snapped.bbox.left - box.left) < 1,
        `snapped left ${snap.snapped?.bbox.left?.toFixed(1)} vs table ${box.left}`);

    // ---- borderless goes down the geometry route --------------------------------
    const borderlessTruth = truthOf('native-borderless');
    const borderless = await page.evaluate((r) => window.__excel.reconstruct('native-borderless', r),
        grow(boxOf(borderlessTruth), 4));
    check('a borderless table is reconstructed from token geometry',
        borderless.source === 'geometry' && gridEquals(borderless.grid, borderlessTruth.pages[0].tables[0].expected),
        borderless.source ?? 'none');

    // ---- ambiguity ---------------------------------------------------------------
    console.log('\n=== ambiguous and adversarial selections ===');
    const twoGrids = truthOf('native-two-grids');
    const both = {
        left: Math.min(twoGrids.pages[0].tables[0].bbox.left, twoGrids.pages[0].tables[1].bbox.left) - 6,
        top: twoGrids.pages[0].tables[0].bbox.top - 6,
        right: Math.max(twoGrids.pages[0].tables[0].bbox.right, twoGrids.pages[0].tables[1].bbox.right) + 6,
        bottom: twoGrids.pages[0].tables[1].bbox.bottom + 6,
    };
    const ambiguous = await page.evaluate((r) => window.__excel.reconstruct('native-two-grids', r), both);
    const snapBoth = await page.evaluate((r) => window.__excel.snap('native-two-grids', r), both);
    console.log(`  two grids on the page: ${snapBoth.gridsOnPage.length} found, ${snapBoth.candidates} overlap the selection -> ${ambiguous.status}`);
    console.log(`  grids: ${JSON.stringify(snapBoth.gridsOnPage.map((g) => [g.rows, g.cols, Math.round(g.bbox.top)]))}  selection top ${both.top} bottom ${both.bottom}`);
    check('a selection covering two comparable grids fails closed',
        ambiguous.status === 'AMBIGUOUS_SELECTION' && ambiguous.rows === 0,
        ambiguous.status);
    check('and it says what to do about it',
        typeof ambiguous.message === 'string' && ambiguous.message.includes('範囲'),
        ambiguous.message);

    const one = await page.evaluate((r) => window.__excel.reconstruct('native-two-grids', r),
        grow(twoGrids.pages[0].tables[0].bbox, 4));
    check('selecting just one of them reconstructs it',
        gridEquals(one.grid, twoGrids.pages[0].tables[0].expected), one.status);

    // A title block is structurally a grid. That is the point.
    const adversarial = truthOf('adversarial-title-block');
    const titleBlock = await page.evaluate((r) => window.__excel.reconstruct('adversarial-title-block', r),
        grow(adversarial.regions.titleBlock, 4));
    console.log(`  title block selected deliberately: ${titleBlock.rows}x${titleBlock.cols} ${titleBlock.status} score ${titleBlock.structureScore}`);
    check('a title block does produce a grid, because structurally it is one',
        titleBlock.rows >= 2 && titleBlock.cols >= 2, `${titleBlock.rows}x${titleBlock.cols}`);
    check('STRUCTURE IS NOT MEANING: the status names structure only, never correctness',
        ['GRID_CONFIDENT', 'GRID_NEEDS_REVIEW'].includes(titleBlock.status)
        && !JSON.stringify(titleBlock).includes('TABLE_CONFIDENT'),
        titleBlock.status);

    // ---- scanned pages, without OCR -----------------------------------------------
    console.log('\n=== scanned pages ===');
    const ocrBefore = ocrAssets.length;
    const scanned = await page.evaluate(() => window.__excel.reconstruct('scanned-ruled', { left: 40, top: 60, right: 560, bottom: 400 }));
    console.log(`  scanned page -> ${scanned.status}`);
    check('a scanned page is declined rather than half-reconstructed',
        scanned.status === 'UNSUPPORTED_LAYOUT' && scanned.rows === 0, scanned.status);
    check('and the notice says the page is an image PDF',
        (scanned.message ?? '').includes('画像PDF'), scanned.message);
    check('no OCR asset is fetched for an Excel run',
        ocrAssets.length === ocrBefore, `${ocrAssets.length - ocrBefore} requests`);

    const mixedPage2 = await page.evaluate(() => window.__excel.geometry('mixed-native-scanned', 2));
    const mixedPage3 = await page.evaluate(() => window.__excel.geometry('mixed-native-scanned', 3));
    check('in a mixed document each page is judged on its own',
        mixedPage2.scanned === true && mixedPage3.scanned === false);
    const mixedTruth = truthOf('mixed-native-scanned');
    const page3 = await page.evaluate((r) => window.__excel.reconstruct('mixed-native-scanned', r, { pageNumber: 3 }),
        grow(mixedTruth.pages[2].tables[0].bbox, 4));
    check('a native page after a scanned one still reconstructs',
        gridEquals(page3.grid, mixedTruth.pages[2].tables[0].expected), `${page3.rows}x${page3.cols}`);

    // ---- the native/scanned boundary is the classifier's, not a token count --
    console.log('\n=== classification boundary ===');
    const marginGeom = await page.evaluate(() => window.__excel.geometry('scanned-margin-text'));
    const interiorGeom = await page.evaluate(() => window.__excel.geometry('native-interior-text'));
    console.log(`  scanned-margin-text : scanned=${marginGeom.scanned} allChars=${marginGeom.allChars} interiorChars=${marginGeom.interiorChars} tokens=${marginGeom.tokens}`);
    console.log(`  native-interior-text: scanned=${interiorGeom.scanned} allChars=${interiorGeom.allChars} interiorChars=${interiorGeom.interiorChars} tokens=${interiorGeom.tokens}`);

    check('a scanned sheet with vector text in the margin still counts as scanned',
        marginGeom.scanned === true, `scanned=${marginGeom.scanned}`);
    check('and it really does carry that marginal text, so the case is the hard one',
        marginGeom.allChars > 0, `${marginGeom.allChars} characters on the page`);
    check('none of that text is in the content region, which is what decides',
        marginGeom.interiorChars === 0, `${marginGeom.interiorChars} interior characters`);
    check('a scanned page hands over no tokens at all, so nothing can be built from a stamp',
        marginGeom.tokens === 0, `${marginGeom.tokens} tokens`);

    const ocrBeforeMargin = ocrAssets.length;
    const marginResult = await page.evaluate(() => window.__excel.reconstruct('scanned-margin-text',
        { left: 40, top: 60, right: 560, bottom: 700 }));
    check('selecting on it is declined, not half-answered',
        marginResult.status === 'UNSUPPORTED_LAYOUT' && marginResult.rows === 0, marginResult.status);
    check('and no OCR is started for it either',
        ocrAssets.length === ocrBeforeMargin, `${ocrAssets.length - ocrBeforeMargin} OCR requests`);

    // The control: the same marginal furniture, with a real table in the body.
    const interiorTruth = truthOf('native-interior-text');
    const interior = await page.evaluate((r) => window.__excel.reconstruct('native-interior-text', r),
        grow(boxOf(interiorTruth), 4));
    check('a genuine native table with the same margin furniture is still supported',
        interiorGeom.scanned === false
        && gridEquals(interior.grid, interiorTruth.pages[0].tables[0].expected),
        `${interior.rows}x${interior.cols}`);
    check('the two fixtures differ only in whether the body has text',
        marginGeom.allChars > 0 && interiorGeom.allChars > marginGeom.allChars
        && interiorGeom.interiorChars > 0,
        `margin ${marginGeom.allChars}/${marginGeom.interiorChars}, interior ${interiorGeom.allChars}/${interiorGeom.interiorChars}`);

    // ---- the geometry bound ---------------------------------------------------------
    console.log('\n=== dense selection ===');
    const denseTruth = truthOf('native-dense-borderless');
    const denseBox = denseTruth.pages[0].bbox;
    const bounded = await page.evaluate((r) => window.__excel.denseProbe('native-dense-borderless', r, 100), denseBox);
    console.log(`  ${bounded.stats.tokensInSelection} tokens against a bound of 100 -> ${bounded.status} in ${bounded.ms}ms`);
    check('a selection past the bound is refused, not truncated',
        bounded.status === 'TOO_DENSE' && bounded.stats.tokensInSelection > 100, bounded.status);
    check('and the message says how dense it was',
        (bounded.message ?? '').includes(String(bounded.stats.tokensInSelection)), bounded.message);

    const yielded = await page.evaluate((r) => window.__excel.yieldProbe('native-dense-borderless', r), denseBox);
    console.log(`  unbounded run over the same selection: ${yielded.yields} yields, ${yielded.ticks} timer ticks during ${yielded.ms}ms`);
    check('the geometry route hands control back while it works',
        yielded.yields > 0 && yielded.ticks > 0, `${yielded.yields} yields, ${yielded.ticks} ticks`);

    const defaultBound = await page.evaluate(() => window.__excel.MAX_GEOMETRY_TOKENS);
    check('the shipped bound is set, and well below the research worst case',
        defaultBound > 0 && defaultBound <= 20000, String(defaultBound));

    // ---- stale results -----------------------------------------------------------------
    const stale = await page.evaluate(() => window.__excel.staleRun('native-borderless'));
    console.log(`\n  cancellation: abandoned run -> ${stale.abandoned} (${stale.abandonedRows} rows), a fresh run -> ${stale.kept} (${stale.keptRows} rows)`);
    check('a run told it has been superseded abandons its work rather than returning a grid',
        stale.abandonedRows === 0, `${stale.abandoned}, ${stale.abandonedRows} rows`);
    check('and abandoning one run does not spoil the next',
        stale.keptRows > 0, `${stale.kept}, ${stale.keptRows} rows`);

    // ---- the workbook --------------------------------------------------------------------
    console.log('\n=== workbook ===');
    const wb = await page.evaluate((grid) => window.__excel.workbook([
        { pageNumber: 1, grid },
        { pageNumber: 3, grid: [['部材', '数量'], ['H形鋼', '12'], ['アンカー', '001']] },
    ], 'drawing.pdf'), simple.grid);
    console.log(`  ${wb.parts.length} parts, ${wb.bytes} bytes, sheets ${JSON.stringify(wb.sheetNames)}`);
    check('one worksheet per confirmed table', wb.sheetCount === 2, String(wb.sheetCount));
    check('the package holds exactly the parts it needs',
        wb.parts.length === 6
        && wb.parts.includes('[Content_Types].xml')
        && wb.parts.includes('_rels/.rels')
        && wb.parts.includes('xl/workbook.xml')
        && wb.parts.includes('xl/_rels/workbook.xml.rels')
        && wb.parts.includes('xl/worksheets/sheet1.xml')
        && wb.parts.includes('xl/worksheets/sheet2.xml'),
        wb.parts.join(' '));
    check('the same tables produce the same bytes', wb.deterministic);
    check('the download carries the spreadsheet MIME type',
        wb.blobType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', wb.blobType);
    check('the file is named for the tables that were chosen, not the whole PDF',
        wb.fileName === 'drawing_tables.xlsx', wb.fileName);
    check('worksheet names are safe and deterministic',
        wb.sheetNames.every((n) => n.length > 0 && n.length <= 31 && !/[[\]:*?/\\]/.test(n))
        && new Set(wb.sheetNames).size === wb.sheetNames.length,
        wb.sheetNames.join(','));

    const sheet1 = wb.contents['xl/worksheets/sheet1.xml'];
    const sheet2 = wb.contents['xl/worksheets/sheet2.xml'];
    check('every value is written as text',
        !/<v>/.test(sheet1) && !/<v>/.test(sheet2) && (sheet1.match(/t="inlineStr"/g) ?? []).length > 0,
        `${(sheet1.match(/t="inlineStr"/g) ?? []).length} inline strings, 0 numeric cells`);
    check('12 is text, and 001 keeps its leading zero',
        sheet2.includes('>12<') && sheet2.includes('>001<'));
    check('Japanese text survives into the sheet', sheet1.includes('室名') && sheet1.includes('タイルカーペット'));
    check('no merge is ever written, because none is inferred',
        !sheet1.includes('mergeCell') && !sheet2.includes('mergeCell'));
    check('no formula, no macro, no external relationship',
        !sheet1.includes('<f>') && !wb.parts.some((p) => /vbaProject|\.bin$/i.test(p))
        && !wb.contents['xl/_rels/workbook.xml.rels'].includes('TargetMode="External"'));

    const blankWb = await page.evaluate(() => window.__excel.workbook([
        { pageNumber: 1, grid: [['A', '', 'C'], ['1', '2', '3']] },
    ]));
    const blankSheet = blankWb.contents['xl/worksheets/sheet1.xml'];
    check('a blank cell is written with its address, so the column after it does not shift',
        /<c r="B1"\/>/.test(blankSheet) && blankSheet.includes('r="C1"'),
        blankSheet.includes('<c r="B1"/>') ? 'B1 present and empty' : 'B1 missing');
    check('the blank is counted as a blank, not as a value',
        blankWb.blankCount === 1 && blankWb.cellCount === 5,
        `${blankWb.cellCount} cells, ${blankWb.blankCount} blank`);

    const escaped = await page.evaluate(() => window.__excel.workbook([
        { pageNumber: 1, grid: [['A & B', '<未定>'], ['"quoted"', "it's"]] },
    ]));
    const escapedSheet = escaped.contents['xl/worksheets/sheet1.xml'];
    check('reserved characters are escaped rather than breaking the package',
        escapedSheet.includes('A &amp; B') && escapedSheet.includes('&lt;未定&gt;')
        && escapedSheet.includes('&quot;quoted&quot;') && escapedSheet.includes('&apos;'));

    const identifiersTruth = truthOf('native-ruled-identifiers');
    const identifiers = await page.evaluate((r) => window.__excel.reconstruct('native-ruled-identifiers', r),
        grow(boxOf(identifiersTruth), 4));
    const idWb = await page.evaluate((grid) => window.__excel.workbook([{ pageNumber: 1, grid }]), identifiers.grid);
    const idSheet = idWb.contents['xl/worksheets/sheet1.xml'];
    const SAMPLES = ['001', '1:100', '2026.09', '2026.09.01', 'D13@200', '150A', '+3', '1-2', '12', '18500.50'];
    const survived = SAMPLES.filter((s) => idSheet.includes(`>${s}<`));
    console.log(`  drawing values round-tripping as text: ${survived.length}/${SAMPLES.length}`);
    check('every drawing identifier reaches the sheet as the text it was',
        survived.length === SAMPLES.length,
        SAMPLES.filter((s) => !survived.includes(s)).join(' ') || 'all');

    // ---- a workbook on disk, for the spreadsheet-application check ----------
    //
    // Written by the production writer through the production path, so what a
    // real spreadsheet is asked to open is the file this feature produces --
    // not a copy of it assembled by the gate.
    const verifyBase64 = await page.evaluate(() => window.__excel.verificationWorkbook());
    const verifyPath = path.join(FIX, 'verification.xlsx');
    fs.writeFileSync(verifyPath, Buffer.from(verifyBase64, 'base64'));
    console.log(`\n  wrote ${path.relative(ROOT, verifyPath)} (${fs.statSync(verifyPath).size} bytes) for scripts/verify-excel-application.mjs`);
    check('a workbook is left on disk for a real spreadsheet to open',
        fs.statSync(verifyPath).size > 0);

    // ---- privacy -------------------------------------------------------------------------
    console.log('\n=== network ===');
    console.log(`  external HTTP(S) requests: ${external.length}`);
    console.log(`  OCR asset requests:        ${ocrAssets.length}`);
    check('nothing left this machine', external.length === 0, external.slice(0, 3).join(' '));
    check('the OCR engine was never started', ocrAssets.length === 0, ocrAssets.slice(0, 3).join(' '));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors[0] ?? '');

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) for (const f of failed) console.log(`    FAILED: ${f.name} ${f.detail}`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\n  gate failed:', error?.stack ?? error);
} finally {
    await browser.close();
    await server.close();
}

console.log('');
process.exit(exitCode);
