/**
 * Smoke 図面サイズ統一 against the PRODUCTION build, through the real UI.
 *
 * `smoke-page-size-normalizer.mjs` drives the module on the dev server. This
 * closes the other half: build, serve dist/, open the app, click through
 * PDF加工 -> 図面サイズ統一, drop a mixed A1/A3 PDF in, press 実行開始, catch
 * the browser download and re-open it to confirm every page really is A1.
 *
 * Run:  npm run build && node scripts/make-size-fixtures.mjs && node scripts/smoke-production-size-normalizer.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5179;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE = path.join(ROOT, 'test-fixtures', 'size-mixed.pdf');
const BATCH_SECOND = path.join(ROOT, 'test-fixtures', 'size-a3-landscape.pdf');
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'size-smoke-'));

const mm = (v) => (v * 72) / 25.4;
const A1 = { width: mm(841), height: mm(594) };

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(FIXTURE)) {
    console.error('Fixtures missing. Run: node scripts/make-size-fixtures.mjs');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Click the first button whose visible label contains `label`. */
const clickButton = (page, label) => page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text));
    if (!button) throw new Error(`button not found: ${text}`);
    button.click();
}, label);

const waitForDownload = async (timeoutMs = 60_000, ext = '.pdf') => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const entries = fs.readdirSync(DOWNLOADS);
        const done = entries.filter((f) => f.endsWith(ext));
        if (done.length && !entries.some((f) => f.endsWith('.crdownload'))) return done[0];
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
};

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const client = await page.createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    await clickButton(page, 'PDF加工');
    await page.waitForSelector('.tools-sidebar');
    check('PDF加工 opens', true);

    await clickButton(page, '図面サイズ統一');
    await page.waitForSelector('.tools-settings select');
    const activeTool = await page.evaluate(() =>
        document.querySelector('.tool-btn.active')?.textContent?.trim() ?? null);
    check('図面サイズ統一 is the active tool', activeTool === '図面サイズ統一', String(activeTool));

    const targetOptions = await page.evaluate(() =>
        [...document.querySelectorAll('.tools-settings select option')].map((o) => o.value));
    check('target list offers A0-A4 plus 最初のページに合わせる',
        JSON.stringify(targetOptions) === JSON.stringify(['A0', 'A1', 'A2', 'A3', 'A4', 'first-page']),
        JSON.stringify(targetOptions));

    const defaultTarget = await page.evaluate(() => document.querySelector('.tools-settings select').value);
    check('default target is A1', defaultTarget === 'A1', defaultTarget);

    const input = await page.$('#file-input');
    await input.uploadFile(FIXTURE);
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1);
    check('mixed A1/A3 fixture accepted', true, path.basename(FIXTURE));

    await clickButton(page, '実行開始');
    await page.waitForFunction(() => document.querySelector('.file-summary') !== null, { timeout: 60_000 });

    const summaryText = await page.evaluate(() => document.querySelector('.file-summary').textContent.trim());
    console.log(`  summary  : ${summaryText}`);
    check('result summary reports the pages, the target and the source sizes',
        /4ページ処理/.test(summaryText) && /A1へ統一/.test(summaryText)
        && /A1 × 2/.test(summaryText) && /A3 × 2/.test(summaryText), summaryText);

    const status = await page.evaluate(() => document.querySelector('.file-status')?.textContent?.trim());
    check('file finished without error', status === 'done', String(status));

    const downloaded = await waitForDownload();
    check('PDF downloads directly for a single file', downloaded !== null, String(downloaded));
    check('output filename carries the target sheet', downloaded === 'size-mixed_A1.pdf', String(downloaded));

    if (downloaded) {
        const bytes = fs.readFileSync(path.join(DOWNLOADS, downloaded));
        const doc = await PDFDocument.load(bytes);
        const sizes = doc.getPages().map((p) => {
            const media = p.getMediaBox();
            const crop = p.getCropBox();
            return {
                media: [Number(media.width.toFixed(3)), Number(media.height.toFixed(3))],
                crop: [Number(crop.width.toFixed(3)), Number(crop.height.toFixed(3))],
            };
        });
        console.log(`  reopened : ${doc.getPageCount()} pages ${JSON.stringify(sizes)}`);
        check('downloaded PDF still has 4 pages', doc.getPageCount() === 4, String(doc.getPageCount()));
        check('every downloaded page is exactly A1',
            sizes.every((s) => near(s.media[0], A1.width, 0.01) && near(s.media[1], A1.height, 0.01)
                && near(s.crop[0], A1.width, 0.01) && near(s.crop[1], A1.height, 0.01)),
            JSON.stringify(sizes));
    }

    // ---- multi-file batch: the existing ZIP flow must keep working ---------
    console.log('\n=== multi-file batch ===');
    fs.rmSync(path.join(DOWNLOADS, downloaded ?? ''), { force: true });
    await page.reload({ waitUntil: 'networkidle0' });
    await clickButton(page, 'PDF加工');
    await page.waitForSelector('.tools-sidebar');
    await clickButton(page, '図面サイズ統一');
    await page.waitForSelector('.tools-settings select');

    const batchInput = await page.$('#file-input');
    await batchInput.uploadFile(FIXTURE, BATCH_SECOND);
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2);
    await clickButton(page, '実行開始');
    await page.waitForFunction(() => document.querySelectorAll('.file-summary').length === 2, { timeout: 60_000 });

    const zipName = await waitForDownload(60_000, '.zip');
    check('multiple files download as one ZIP', zipName === 'processed_files.zip', String(zipName));

    if (zipName) {
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(DOWNLOADS, zipName)));
        const names = Object.keys(zip.files).sort();
        console.log(`  zip      : ${names.join(', ')}`);
        check('ZIP holds one normalised PDF per input',
            JSON.stringify(names) === JSON.stringify(['size-a3-landscape_A1.pdf', 'size-mixed_A1.pdf']),
            JSON.stringify(names));
        for (const name of names) {
            const doc = await PDFDocument.load(await zip.files[name].async('uint8array'));
            const ok = doc.getPages().every((p) => {
                const m = p.getMediaBox();
                return near(m.width, A1.width, 0.01) && near(m.height, A1.height, 0.01);
            });
            check(`ZIP entry ${name}: every page is A1`, ok, `${doc.getPageCount()} pages`);
        }
    }

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
    fs.rmSync(DOWNLOADS, { recursive: true, force: true });
    process.exit(exitCode);
}
