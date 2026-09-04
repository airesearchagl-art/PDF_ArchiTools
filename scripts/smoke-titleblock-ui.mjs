/**
 * UI gate for 図枠一括更新 against the PRODUCTION build.
 *
 * The module gate covers the transform. What only the UI can show is the
 * readiness rule: the representative page's geometry and orientation must be
 * measured afresh before anything can be selected or run, because a stale
 * orientation would put every region on the wrong part of the sheet.
 *
 * Run:  npm run build && node scripts/smoke-titleblock-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5187;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, 'tb-portrait.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-titleblock-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.setDefaultTimeout(30_000);

const pageErrors = [];
const external = [];
const workerRequests = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => {
    const url = r.url();
    if (url.includes('pdf.worker')) workerRequests.push(url);
    if (!url.startsWith(ORIGIN) && /^https?:/.test(url)) external.push(url);
});
// A PDF.js worker runs in its own target, whose traffic page-level events miss.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    workerRequests.push(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => {
            const url = e.request?.url ?? '';
            if (url.includes('pdf.worker')) workerRequests.push(url);
            if (url && !url.startsWith(ORIGIN) && /^https?:/.test(url)) external.push(url);
        });
    } catch { /* target already gone */ }
});

const clickButton = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(t));
    if (!b) throw new Error(`button not found: ${t}`);
    b.click();
}, text);

/** What the UI is willing to let the user do right now. */
const readiness = () => page.evaluate(() => {
    const surface = document.querySelector('.tb-surface');
    const run = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('実行開始'));
    return {
        selectable: surface ? getComputedStyle(surface).cursor === 'crosshair' : null,
        hintReady: document.querySelector('.tb-hint')?.getAttribute('data-ready') ?? null,
        runDisabled: run ? run.disabled : null,
        pageIndicator: document.querySelector('.tb-page-indicator')?.textContent?.trim() ?? null,
    };
});

/** Add one fixture to whatever is already loaded, without waiting for it. */
const uploadNow = async (name) => {
    const input = await page.$('#file-input');
    await input.uploadFile(path.join(FIXTURES, name));
};

const clearFiles = () => page.evaluate(() => {
    document.querySelectorAll('.remove-btn').forEach((b) => b.click());
});

const fileNames = () => page.evaluate(() =>
    [...document.querySelectorAll('.file-name')].map((e) => e.textContent.trim()));

/** Remove one file by its displayed name, leaving the others alone. */
const removeFileNamed = (name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('.file-row')]
        .find((r) => r.querySelector('.file-name')?.textContent.trim() === n);
    if (!row) throw new Error(`file row not found: ${n}`);
    row.querySelector('.remove-btn').click();
}, name);

const waitReady = async () => {
    await page.waitForFunction(() => {
        const s = document.querySelector('.tb-surface');
        return s && getComputedStyle(s).cursor === 'crosshair';
    }, { timeout: 30_000 });
};

const drag = (x0, y0, x1, y1) => page.evaluate(async (a, b, c, d) => {
    const surface = document.querySelector('.tb-surface');
    const r = surface.getBoundingClientRect();
    const opts = (x, y) => ({ bubbles: true, clientX: r.left + r.width * x, clientY: r.top + r.height * y, pointerId: 1 });
    const tick = () => new Promise((res) => setTimeout(res, 60));
    surface.dispatchEvent(new PointerEvent('pointerdown', opts(a, b)));
    await tick();
    surface.dispatchEvent(new PointerEvent('pointermove', opts(c, d)));
    await tick();
    surface.dispatchEvent(new PointerEvent('pointerup', opts(c, d)));
    await tick();
}, x0, y0, x1, y1);

/** Rules are a template that outlives a file change, so reset them explicitly. */
const resetRules = async () => {
    await page.evaluate(() => {
        const removes = [...document.querySelectorAll('.tb-rule-remove')];
        removes.slice(1).forEach((b) => b.click());
    });
    await page.waitForFunction(() => document.querySelectorAll('.tb-rule').length === 1);
    await page.evaluate(() => {
        const input = document.querySelector('.tb-rule-text');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

const typeRule = (index, value) => page.evaluate((i, v) => {
    const input = document.querySelectorAll('.tb-rule-text')[i];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}, index, value);

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await clickButton('PDF加工');
    await page.waitForSelector('.tools-sidebar');
    await clickButton('図枠一括更新');
    await page.waitForSelector('.tb-updater');
    check('図枠一括更新 opens', true);

    const noFile = await readiness();
    console.log(`  no file      : ${JSON.stringify(noFile)}`);
    check('A0: with no file at all, nothing can be selected or run',
        noFile.selectable === false && noFile.runDisabled === true, JSON.stringify(noFile));

    // ---- A. right after a file arrives, before geometry is measured --------
    await uploadNow('tb-mixed.pdf');
    const justUploaded = await readiness();
    console.log(`  just uploaded: ${JSON.stringify(justUploaded)}`);
    check('A: selection is closed until the representative page is measured',
        justUploaded.selectable === false, JSON.stringify(justUploaded));
    check('A: 実行開始 is disabled until the representative page is measured',
        justUploaded.runDisabled === true, JSON.stringify(justUploaded));

    await waitReady();
    const ready1 = await readiness();
    console.log(`  ready        : ${JSON.stringify(ready1)}`);
    check('D: once the page is measured, selecting and running open up',
        ready1.selectable === true && ready1.runDisabled === false && ready1.hintReady === 'yes',
        JSON.stringify(ready1));
    check('page indicator reflects the loaded document', ready1.pageIndicator === '1 / 5 ページ',
        String(ready1.pageIndicator));

    // ---- B. switching page closes the door again ---------------------------
    await clickButton('次');
    const justPaged = await readiness();
    console.log(`  just paged   : ${JSON.stringify(justPaged)}`);
    check('B: switching to another page closes selection until it is measured',
        justPaged.selectable === false && justPaged.runDisabled === true, JSON.stringify(justPaged));
    await waitReady();
    const ready2 = await readiness();
    check('B: the new page reopens once measured',
        ready2.selectable === true && ready2.pageIndicator === '2 / 5 ページ', JSON.stringify(ready2));
    await clickButton('前');
    await waitReady();

    // ---- C. replacing the representative file ------------------------------
    await clearFiles();
    const afterRemove = await readiness();
    console.log(`  after remove : ${JSON.stringify(afterRemove)}`);
    check('C: removing the representative file closes selection immediately',
        afterRemove.selectable === false && afterRemove.runDisabled === true, JSON.stringify(afterRemove));

    await uploadNow('tb-portrait.pdf');
    const justSwapped = await readiness();
    console.log(`  just swapped : ${JSON.stringify(justSwapped)}`);
    check('C: a newly chosen file cannot be run against the old geometry',
        justSwapped.selectable === false && justSwapped.runDisabled === true, JSON.stringify(justSwapped));
    await waitReady();
    const portraitReady = await readiness();
    check('C: the page indicator never shows a page the document does not have',
        portraitReady.pageIndicator === '1 / 1 ページ', String(portraitReady.pageIndicator));

    // ---- E. a portrait representative is treated as portrait ---------------
    await drag(0.720, 0.828, 0.960, 0.888);
    await typeRule(0, '竣工図');
    await page.waitForFunction(() => document.querySelectorAll('.tb-region').length === 1);
    await clickButton('実行開始');
    await page.waitForFunction(() => document.querySelector('.file-summary') || document.querySelector('.file-error'),
        { timeout: 60_000 });
    const portraitResult = await page.evaluate(() => ({
        summary: document.querySelector('.file-summary')?.textContent?.trim() ?? null,
        error: document.querySelector('.file-error')?.textContent?.trim() ?? null,
        status: document.querySelector('.file-status')?.textContent?.trim() ?? null,
    }));
    console.log(`  portrait run : ${JSON.stringify(portraitResult)}`);
    check('E: a portrait representative page processes as portrait, not as a landscape guess',
        portraitResult.error === null && portraitResult.status === 'done'
        && /1ページへ1か所/.test(portraitResult.summary ?? ''), JSON.stringify(portraitResult));

    // ---- D. the normal flow still produces a correct file -------------------
    const downloads = fs.mkdtempSync(path.join(ROOT, 'test-fixtures', 'ui-'));
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    await clearFiles();
    await uploadNow('tb-mixed.pdf');
    await waitReady();
    await drag(0.720, 0.828, 0.960, 0.888);
    await typeRule(0, '竣工図');
    await clickButton('更新領域を追加');
    await page.waitForFunction(() => document.querySelectorAll('.tb-rule').length === 2);
    await drag(0.720, 0.900, 0.960, 0.950);
    await typeRule(1, '2026.09.04');
    await page.waitForFunction(() => document.querySelectorAll('.tb-region').length === 2);
    await clickButton('実行開始');
    await page.waitForFunction(() => document.querySelector('.file-summary') !== null, { timeout: 120_000 });

    const summary = await page.evaluate(() => document.querySelector('.file-summary').textContent.trim());
    console.log(`  summary      : ${summary}`);
    check('D: the mixed A1/A3 run reports every page and both rules',
        /5ページへ2か所/.test(summary), summary);

    const deadline = Date.now() + 60_000;
    let downloaded = null;
    while (Date.now() < deadline) {
        const entries = fs.readdirSync(downloads);
        const done = entries.filter((f) => f.endsWith('.pdf'));
        if (done.length && !entries.some((f) => f.endsWith('.crdownload'))) { downloaded = done[0]; break; }
        await new Promise((r) => setTimeout(r, 200));
    }
    check('D: the updated PDF downloads', downloaded === 'tb-mixed_title-updated.pdf', String(downloaded));

    if (downloaded) {
        const doc = await PDFDocument.load(fs.readFileSync(path.join(downloads, downloaded)));
        const sizes = doc.getPages().map((p) => [Number(p.getMediaBox().width.toFixed(2)), Number(p.getMediaBox().height.toFixed(2))]);
        console.log(`  reopened     : ${doc.getPageCount()} pages ${JSON.stringify(sizes)}`);
        check('D: page count is unchanged', doc.getPageCount() === 5, String(doc.getPageCount()));
        check('D: page sizes are unchanged (A1 / A3 / A1 / A3 / A1)',
            near(sizes[0][0], 2383.94, 0.05) && near(sizes[1][0], 1190.55, 0.05)
            && near(sizes[4][0], 2383.94, 0.05), JSON.stringify(sizes));
    }
    fs.rmSync(downloads, { recursive: true, force: true });

    // ---- RF3. adding or removing a NON-representative file must not disturb
    //           the measurement already taken from the representative one -----
    console.log('\n=== multi-file readiness ===');
    await clearFiles();
    await uploadNow('tb-a1.pdf');
    await waitReady();
    const oneFile = await readiness();
    console.log(`  one file     : ${JSON.stringify(oneFile)} ${JSON.stringify(await fileNames())}`);
    check('RF3 setup: a single file measures and opens up', oneFile.selectable === true);

    // B. incremental add, keeping the representative in place.
    await uploadNow('tb-a3.pdf');
    const justAdded = await readiness();
    const namesAfterAdd = await fileNames();
    console.log(`  after add    : ${JSON.stringify(justAdded)} ${JSON.stringify(namesAfterAdd)}`);
    check('RF3-B: adding a second file keeps the first as representative',
        namesAfterAdd.length === 2 && namesAfterAdd[0] === 'tb-a1.pdf', JSON.stringify(namesAfterAdd));
    check('RF3-B: readiness survives the add, immediately',
        justAdded.selectable === true && justAdded.runDisabled === false
        && justAdded.pageIndicator === oneFile.pageIndicator, JSON.stringify(justAdded));
    await new Promise((r) => setTimeout(r, 1200));
    const settledAfterAdd = await readiness();
    check('RF3-B: readiness survives the add, once settled',
        settledAfterAdd.selectable === true && settledAfterAdd.runDisabled === false
        && settledAfterAdd.pageIndicator === oneFile.pageIndicator, JSON.stringify(settledAfterAdd));

    // C. both files process from the one rule set, and arrive as a ZIP.
    const batchDir = fs.mkdtempSync(path.join(ROOT, 'test-fixtures', 'ui-batch-'));
    const batchClient = await page.createCDPSession();
    await batchClient.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: batchDir });

    await resetRules();
    await drag(0.720, 0.828, 0.960, 0.888);
    await typeRule(0, '竣工図');
    await page.waitForFunction(() => document.querySelectorAll('.tb-region').length === 1);
    await clickButton('実行開始');
    await page.waitForFunction(() => document.querySelectorAll('.file-summary').length === 2, { timeout: 120_000 });
    const batchSummaries = await page.evaluate(() =>
        [...document.querySelectorAll('.file-summary')].map((e) => e.textContent.trim()));
    console.log(`  batch        : ${JSON.stringify(batchSummaries)}`);
    check('RF3-C: both files in the batch were processed', batchSummaries.length === 2
        && batchSummaries.every((t) => /1ページへ1か所/.test(t)), JSON.stringify(batchSummaries));

    let zipName = null;
    const zipDeadline = Date.now() + 60_000;
    while (Date.now() < zipDeadline) {
        const entries = fs.readdirSync(batchDir);
        const done = entries.filter((f) => f.endsWith('.zip'));
        if (done.length && !entries.some((f) => f.endsWith('.crdownload'))) { zipName = done[0]; break; }
        await new Promise((r) => setTimeout(r, 200));
    }
    check('RF3-C: two files download as one ZIP', zipName === 'processed_files.zip', String(zipName));
    if (zipName) {
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(batchDir, zipName)));
        const names = Object.keys(zip.files).sort();
        console.log(`  zip          : ${names.join(', ')}`);
        check('RF3-C: the ZIP holds one updated PDF per input',
            JSON.stringify(names) === JSON.stringify(['tb-a1_title-updated.pdf', 'tb-a3_title-updated.pdf']),
            JSON.stringify(names));
    }
    fs.rmSync(batchDir, { recursive: true, force: true });

    // D. removing the file that is NOT the representative changes nothing.
    await removeFileNamed('tb-a3.pdf');
    const afterNonRepRemoval = await readiness();
    const namesAfterRemoval = await fileNames();
    console.log(`  after rm B   : ${JSON.stringify(afterNonRepRemoval)} ${JSON.stringify(namesAfterRemoval)}`);
    check('RF3-D: removing a non-representative file leaves it ready',
        namesAfterRemoval.length === 1 && namesAfterRemoval[0] === 'tb-a1.pdf'
        && afterNonRepRemoval.selectable === true && afterNonRepRemoval.runDisabled === false,
        JSON.stringify(afterNonRepRemoval));

    // E. removing the representative closes the door until the next one is read.
    await uploadNow('tb-portrait.pdf');
    await new Promise((r) => setTimeout(r, 800));
    await removeFileNamed('tb-a1.pdf');
    const afterRepRemoval = await readiness();
    console.log(`  after rm A   : ${JSON.stringify(afterRepRemoval)} ${JSON.stringify(await fileNames())}`);
    check('RF3-E: removing the representative file closes selection at once',
        afterRepRemoval.selectable === false && afterRepRemoval.runDisabled === true,
        JSON.stringify(afterRepRemoval));
    await waitReady();
    const afterRepMeasured = await readiness();
    check('RF3-E: the new representative reopens only after it is measured',
        afterRepMeasured.selectable === true && afterRepMeasured.runDisabled === false
        && afterRepMeasured.pageIndicator === '1 / 1 ページ', JSON.stringify(afterRepMeasured));

    // ---- RF1: the worker really came from our own origin --------------------
    console.log('\n=== PDF.js worker requests ===');
    const uniqueWorkers = [...new Set(workerRequests)];
    for (const w of uniqueWorkers) console.log(`  worker: ${w}`);
    check('RF1: a PDF.js worker was actually requested', uniqueWorkers.length > 0, String(uniqueWorkers.length));
    check('RF1: every PDF.js worker request is same-origin',
        uniqueWorkers.every((u) => u.startsWith(`${ORIGIN}/pdf.worker.min.mjs`)), uniqueWorkers.join(' | '));
    check('RF1: no unpkg request at all', !uniqueWorkers.some((u) => u.includes('unpkg.com'))
        && !external.some((u) => u.includes('unpkg.com')), external.slice(0, 3).join(' | '));

    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external HTTP request during the whole flow', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
