/**
 * The Excel export workflow, driven through the real UI.
 *
 * Production build, served by `vite preview`, driven with a real pointer. The
 * point of this gate is everything the module-level one cannot see: that a drag
 * on a canvas reaches the right grid, that no download exists before somebody
 * has confirmed the contents, and that changing the page or the format does not
 * leave a stale file behind under a heading that no longer describes it.
 *
 * Run:  npm run build && node scripts/smoke-excel-export-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'excel');
const PORT = 5188;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No production build. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIX, 'native-ruled-simple.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-excel-fixtures.mjs')], { stdio: 'inherit' });
}

const truthOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8'));

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-ui-'));
const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
await page.setViewport({ width: 1400, height: 1000 });

const external = [];
const ocrAssets = [];
const pageErrors = [];
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
    } catch { /* gone */ }
});
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Open PDFテキスト化, switch to Text Extraction, choose Excel. */
async function openExcelMode(fixture) {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
            .find((x) => (x.textContent || '').includes('PDFテキスト化'));
        if (!button) throw new Error('button not found: PDFテキスト化');
        button.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));

    const input = await page.$('input[type="file"]');
    await input.uploadFile(path.join(FIX, `${fixture}.pdf`));
    await page.waitForSelector('input[name="mode"][value="extract"]');
    await page.click('input[name="mode"][value="extract"]');
    await page.select('select', 'excel');
    await page.waitForSelector('[data-usage-target="excel-page-canvas"]');
    await wait(900);
}

/** Drag on the page canvas, in canvas pixels, with a real pointer. */
async function dragOnCanvas(rect) {
    // The pointer works in viewport coordinates, so the canvas has to be on
    // screen first. The app scrolls inside its own panel rather than the
    // window, so scrollIntoView is what moves it -- window.scrollTo does
    // nothing here.
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="excel-page-canvas"]')
            .scrollIntoView({ block: 'start' });
    });
    await wait(250);
    const box = await page.$eval('[data-usage-target="excel-page-canvas"]', (canvas) => {
        const r = canvas.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, pixelWidth: canvas.width };
    });
    const ratio = box.width / box.pixelWidth;
    const from = { x: box.x + rect.left * ratio, y: box.y + rect.top * ratio };
    const to = { x: box.x + rect.right * ratio, y: box.y + rect.bottom * ratio };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await wait(700);
}

/**
 * The answer key's table box, in canvas pixels.
 *
 * The key is in upright points; the canvas shows display space at a render
 * scale. For a quarter-turned page those are not the same, which is exactly why
 * the drag is worth exercising rather than only the function beneath it.
 */
function canvasRectFor(fixture, canvasPixelWidth, index = 0, pageIndex = 0) {
    const truth = truthOf(fixture);
    const box = truth.pages[pageIndex].tables[index].bbox;
    const rotate = truth.pages[pageIndex].rotate ?? 0;
    const W = 595.28;
    const H = 841.89;
    const grown = { left: box.left - 6, top: box.top - 6, right: box.right + 6, bottom: box.bottom + 6 };
    // Upright -> display, the inverse of what the app does when it reads a drag.
    const toDisplay = (x, y) => {
        switch (((rotate % 360) + 360) % 360) {
            case 90: return { x: H - y, y: x };
            case 180: return { x: W - x, y: H - y };
            case 270: return { x: y, y: W - x };
            default: return { x, y };
        }
    };
    const corners = [toDisplay(grown.left, grown.top), toDisplay(grown.right, grown.bottom)];
    const displayWidth = rotate % 180 === 90 ? H : W;
    const scale = canvasPixelWidth / displayWidth;
    return {
        left: Math.min(corners[0].x, corners[1].x) * scale,
        top: Math.min(corners[0].y, corners[1].y) * scale,
        right: Math.max(corners[0].x, corners[1].x) * scale,
        bottom: Math.max(corners[0].y, corners[1].y) * scale,
    };
}

const canvasPixelWidth = () => page.$eval('[data-usage-target="excel-page-canvas"]', (c) => c.width);
const previewGrid = () => page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-usage-target="excel-preview"] textarea[data-cell]')];
    if (!cells.length) return null;
    const rows = new Map();
    for (const cell of cells) {
        const [r, c] = cell.dataset.cell.split(',').map(Number);
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r)[c] = cell.value;
    }
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
});
const confirmEnabled = () => page.$eval('[data-usage-target="excel-confirm"]', (b) => !b.disabled).catch(() => false);
const downloadPresent = () => page.$('[data-usage-target="excel-download"]').then(Boolean);

let exitCode = 1;
try {
    // ---- a real drag on a native page --------------------------------------
    console.log('\n=== selection by pointer ===');
    await openExcelMode('native-ruled-simple');
    check('the Excel option is offered and selected', await page.$eval('select', (s) => s.value) === 'excel');
    check('the page canvas is shown for a native page', await page.$('[data-usage-target="excel-page-canvas"]') !== null);
    check('no download exists before anything has been selected', !(await downloadPresent()));

    await dragOnCanvas(canvasRectFor('native-ruled-simple', await canvasPixelWidth()));
    const grid = await previewGrid();
    console.log(`  preview grid: ${grid?.length}x${grid?.[0]?.length}`);
    check('a pointer drag produces a preview grid', Array.isArray(grid) && grid.length === 4 && grid[0].length === 3,
        `${grid?.length}x${grid?.[0]?.length}`);
    check('the preview holds the table\'s own text',
        grid?.[0]?.[0] === '室名' && grid?.[1]?.[1] === 'タイルカーペット',
        `${grid?.[0]?.[0]} / ${grid?.[1]?.[1]}`);
    check('the status shown names structure, never correctness',
        (await page.$eval('[data-usage-target="excel-preview"]', (el) => el.textContent))?.includes('構造の整合性'));
    check('the screen says the meaning has not been judged',
        (await page.$eval('[data-usage-target="excel-confirm-warning"]', (el) => el.textContent))?.includes('内容の意味は自動判定していません'));
    check('still no download, with a grid on screen but nothing confirmed', !(await downloadPresent()));

    // ---- editing ------------------------------------------------------------
    console.log('\n=== editing before confirming ===');
    await page.click('[data-usage-target="excel-preview"] textarea[data-cell="1,0"]', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('[data-usage-target="excel-preview"] textarea[data-cell="1,0"]', '編集済みセル');
    await wait(200);
    const edited = await previewGrid();
    check('a cell can be edited', edited?.[1]?.[0] === '編集済みセル', edited?.[1]?.[0]);

    check('the confirm control is available', await confirmEnabled());
    await page.click('[data-usage-target="excel-confirm"]');
    await wait(400);
    const confirmedText = await page.$eval('[data-usage-target="excel-confirmed"]', (el) => el.textContent);
    console.log(`  confirmed list: ${confirmedText.replace(/\s+/g, ' ').slice(0, 90)}`);
    check('the confirmed table is listed', confirmedText.includes('Page_1_Table_1'));
    check('and there is still no download until the workbook is asked for', !(await downloadPresent()));

    // ---- a second table, from another page -----------------------------------
    console.log('\n=== a second table ===');
    await openExcelMode('mixed-native-scanned');
    await dragOnCanvas(canvasRectFor('mixed-native-scanned', await canvasPixelWidth()));
    await page.click('[data-usage-target="excel-confirm"]');
    await wait(300);

    // Page 2 is scanned: it must decline, and never start OCR.
    const ocrBefore = ocrAssets.length;
    await page.click('[aria-label="次のページ"]');
    await wait(1200);
    const scannedNotice = await page.$('[data-usage-target="excel-scanned-notice"]');
    check('a scanned page says so instead of offering an empty table', scannedNotice !== null);
    check('the notice explains it is an image PDF and OCR is not yet supported',
        (await page.$eval('[data-usage-target="excel-scanned-notice"]', (el) => el.textContent)).includes('画像PDF'));
    check('reaching a scanned page in Excel mode starts no OCR',
        ocrAssets.length === ocrBefore, `${ocrAssets.length - ocrBefore} OCR requests`);

    await page.click('[aria-label="次のページ"]');
    await wait(1200);
    await dragOnCanvas(canvasRectFor('mixed-native-scanned', await canvasPixelWidth(), 0, 2));
    const thirdGrid = await previewGrid();
    check('the native page after the scanned one still reconstructs',
        Array.isArray(thirdGrid) && thirdGrid.length === 5, `${thirdGrid?.length} rows`);
    await page.click('[data-usage-target="excel-confirm"]');
    await wait(300);
    const twoConfirmed = await page.$$eval('[data-usage-target="excel-confirmed"] button[aria-label$="を削除"]', (els) => els.length);
    check('two tables from two pages are confirmed', twoConfirmed === 2, String(twoConfirmed));

    // ---- the workbook, downloaded and opened ----------------------------------
    console.log('\n=== the downloaded workbook ===');
    await page.click('[data-usage-target="excel-export"]');
    await page.waitForSelector('[data-usage-target="excel-download"]');
    const fileName = await page.$eval('[data-usage-target="excel-download"]', (a) => a.getAttribute('download'));
    check('the download is named for the tables that were chosen',
        fileName === 'mixed-native-scanned_tables.xlsx', fileName);

    await page.click('[data-usage-target="excel-download"]');
    let downloaded = null;
    for (let i = 0; i < 60 && !downloaded; i++) {
        const found = fs.readdirSync(downloads).find((f) => f === fileName);
        if (found) downloaded = path.join(downloads, found);
        else await wait(200);
    }
    check('the workbook actually downloads', downloaded !== null, downloaded ?? 'not found');

    if (downloaded) {
        const zip = await JSZip.loadAsync(fs.readFileSync(downloaded));
        const parts = Object.keys(zip.files).sort();
        const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
        const sheet2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
        const workbookXml = await zip.file('xl/workbook.xml').async('string');
        console.log(`  ${fs.statSync(downloaded).size} bytes, parts: ${parts.length}`);
        check('the downloaded file has one worksheet per confirmed table',
            (workbookXml.match(/<sheet /g) ?? []).length === 2,
            String((workbookXml.match(/<sheet /g) ?? []).length));
        check('every value in the downloaded file is text',
            !sheet1.includes('<v>') && !sheet2.includes('<v>')
            && sheet1.includes('t="inlineStr"'));
        check('Japanese text survives the whole round trip', sheet1.includes('室名'));
        check('drawing identifiers keep their form',
            sheet2.includes('>001<') && sheet2.includes('>1:100<') && sheet2.includes('>12<'));
        // Neither confirmed table here has an empty cell, so the blank-cell
        // contract is checked below on the fixture that actually has some.
        check('the two sheets carry the two confirmed grids',
            sheet1.includes('室名') && sheet2.includes('部材'));
        check('no merge, no formula, no macro, no external relationship',
            !sheet1.includes('mergeCell') && !sheet1.includes('<f>')
            && !parts.some((p) => /vbaProject|\.bin$/i.test(p))
            && !(await zip.file('xl/_rels/workbook.xml.rels').async('string')).includes('TargetMode="External"'));
    }

    // ---- blank cells, all the way to a downloaded file --------------------------
    console.log('\n=== blank cells through the whole workflow ===');
    await openExcelMode('native-blank-cells');
    await dragOnCanvas(canvasRectFor('native-blank-cells', await canvasPixelWidth()));
    const blankPreview = await previewGrid();
    const blanksOnScreen = blankPreview?.flat().filter((c) => c === '').length ?? 0;
    console.log(`  preview shows ${blanksOnScreen} empty cells`);
    check('empty cells are shown as empty in the preview, not filled in',
        blanksOnScreen === 3, String(blanksOnScreen));
    await page.click('[data-usage-target="excel-confirm"]');
    await wait(300);
    await page.click('[data-usage-target="excel-export"]');
    await page.waitForSelector('[data-usage-target="excel-download"]');
    await page.click('[data-usage-target="excel-download"]');
    let blankFile = null;
    for (let i = 0; i < 60 && !blankFile; i++) {
        const found = fs.readdirSync(downloads).find((f) => f === 'native-blank-cells_tables.xlsx');
        if (found) blankFile = path.join(downloads, found);
        else await wait(200);
    }
    check('the blank-cell workbook downloads', blankFile !== null);
    if (blankFile) {
        const zip = await JSZip.loadAsync(fs.readFileSync(blankFile));
        const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
        const emptyCells = (sheet.match(/<c r="[A-Z]+\d+"\/>/g) ?? []).length;
        console.log(`  downloaded sheet holds ${emptyCells} addressed empty cells`);
        check('a blank cell keeps its address in the downloaded file, so nothing shifts left',
            emptyCells === 3 && sheet.includes('r="D2"'), `${emptyCells} empty cells`);
    }

    // ---- rotated pages, dragged for real ---------------------------------------
    console.log('\n=== rotated pages ===');
    for (const rot of ['090', '180', '270']) {
        const fixture = `native-rotate-${rot}`;
        await openExcelMode(fixture);
        await dragOnCanvas(canvasRectFor(fixture, await canvasPixelWidth()));
        const rotated = await previewGrid();
        console.log(`  /Rotate ${rot}: ${rotated?.length}x${rotated?.[0]?.length} first cell ${JSON.stringify(rotated?.[0]?.[0])}`);
        check(`/Rotate ${rot}: a real drag reaches the right grid`,
            rotated?.length === 4 && rotated?.[0]?.length === 3 && rotated?.[0]?.[0] === '室名',
            `${rotated?.length}x${rotated?.[0]?.length}`);
    }

    // ---- a title block does not bypass anything ---------------------------------
    console.log('\n=== adversarial selection ===');
    await openExcelMode('adversarial-title-block');
    const adv = truthOf('adversarial-title-block').regions.titleBlock;
    const advWidth = await canvasPixelWidth();
    const advScale = advWidth / 595.28;
    await dragOnCanvas({
        left: (adv.left - 6) * advScale, top: (adv.top - 6) * advScale,
        right: (adv.right + 6) * advScale, bottom: (adv.bottom + 6) * advScale,
    });
    const advGrid = await previewGrid();
    check('selecting a title block produces a proposal, because structurally it is a grid',
        Array.isArray(advGrid) && advGrid.length >= 2, `${advGrid?.length} rows`);
    check('and it still has to be confirmed like anything else', !(await downloadPresent()));
    const advText = await page.$eval('[data-usage-target="excel-preview"], body', (el) => el.textContent);
    check('nothing on screen says the selection was verified to be a table',
        !advText.includes('表であることを確認') && !advText.includes('正しい表'));

    // ---- state invalidation -------------------------------------------------------
    console.log('\n=== stale state ===');
    await openExcelMode('native-ruled-simple');
    await dragOnCanvas(canvasRectFor('native-ruled-simple', await canvasPixelWidth()));
    await page.click('[data-usage-target="excel-confirm"]');
    await wait(300);
    await page.click('[data-usage-target="excel-export"]');
    await page.waitForSelector('[data-usage-target="excel-download"]');
    check('a workbook exists once a table is confirmed and exported', await downloadPresent());

    await page.select('select', 'txt');
    await wait(400);
    check('switching to TXT takes the Excel workflow off the screen',
        (await page.$('[data-usage-target="excel-workflow"]')) === null);
    await page.select('select', 'excel');
    await wait(900);
    check('and coming back to Excel does not restore the old download', !(await downloadPresent()));

    const inputAgain = await page.$('input[type="file"]');
    await inputAgain.uploadFile(path.join(FIX, 'native-sparse.pdf'));
    await wait(1400);
    const afterReplace = await page.$eval('[data-usage-target="excel-confirmed"]', (el) => el.textContent);
    check('replacing the file clears every confirmed table',
        afterReplace.includes('確定した表: 0'), afterReplace.replace(/\s+/g, ' ').slice(0, 60));
    check('and leaves no download behind', !(await downloadPresent()));

    // ---- accessibility and privacy --------------------------------------------------
    console.log('\n=== accessibility and network ===');
    // Checked with a proposal on screen, because that is when the confirm
    // control exists at all.
    await openExcelMode('native-ruled-simple');
    await dragOnCanvas(canvasRectFor('native-ruled-simple', await canvasPixelWidth()));
    const labels = await page.evaluate(() => {
        const confirm = document.querySelector('[data-usage-target="excel-confirm"]');
        const cell = document.querySelector('[data-usage-target="excel-preview"] textarea[data-cell]');
        const notice = document.querySelector('[data-usage-target="excel-confirm-warning"]');
        return {
            prev: document.querySelector('[aria-label="前のページ"]')?.tagName === 'BUTTON',
            next: document.querySelector('[aria-label="次のページ"]')?.tagName === 'BUTTON',
            confirmIsButton: confirm?.tagName === 'BUTTON',
            exportIsButton: document.querySelector('[data-usage-target="excel-export"]')?.tagName === 'BUTTON',
            cellLabelled: Boolean(cell?.getAttribute('aria-label')),
            noticeHasText: (notice?.textContent ?? '').trim().length > 0,
            removeLabelled: [...document.querySelectorAll('[data-usage-target="excel-confirmed"] button')]
                .every((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length > 0),
        };
    });
    check('page navigation controls are labelled buttons', labels.prev && labels.next);
    check('confirm and export are real buttons', labels.confirmIsButton && labels.exportIsButton);
    check('every editable cell has an accessible label', labels.cellLabelled);
    check('the warning is words, not only a colour', labels.noticeHasText);
    check('controls in the confirmed list are labelled', labels.removeLabelled);

    console.log(`  external HTTP(S) requests: ${external.length}`);
    console.log(`  OCR asset requests:        ${ocrAssets.length}`);
    check('nothing left this machine', external.length === 0, external.slice(0, 3).join(' '));
    check('the OCR engine was never started anywhere in the Excel workflow',
        ocrAssets.length === 0, ocrAssets.slice(0, 3).join(' '));
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
    fs.rmSync(downloads, { recursive: true, force: true });
}

console.log('');
process.exit(exitCode);
