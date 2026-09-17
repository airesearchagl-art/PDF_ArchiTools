/**
 * The M6 UI gate.
 *
 * The module gate proves the contract; this proves the wiring. Four of the
 * Independent FULL Review's findings were only visible by driving the built app:
 *
 *   - a slow upload finishing after a fast one, so the screen said B and the
 *     exported file was A;
 *   - a confirmation that asked someone to agree to losing an attachment without
 *     naming it;
 *   - PDF.js parsing untrusted input before the Load Boundary had passed it;
 *   - a B4 notice the footer sat on top of.
 *
 * Each is asserted on something observable: the bytes of the downloaded file,
 * the text on screen before the click, the requests the page made, and the
 * measured geometry of two elements.
 *
 * Run:  npm run build
 *       node scripts/make-m6-split-merge-fixtures.mjs
 *       node scripts/make-m6-remediation-fixtures.mjs
 *       node scripts/smoke-split-merge-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5187;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
const WORKER = '/pdf.worker.min.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(FIXTURES)) {
    console.error('No fixtures. Run: node scripts/make-m6-split-merge-fixtures.mjs');
    process.exit(1);
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-ui-'));
const fixture = (name) => path.join(FIXTURES, `${name}.pdf`);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await preview({
    root: ROOT,
    preview: { port: PORT, strictPort: true },
    logLevel: 'warn',
});
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

let exitCode = 1;
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 1400, height: 900 });

    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const workerRequests = () => requests.filter((u) => u.includes(WORKER)).length;

    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
    });

    /**
     * Make one named file slow to read.
     *
     * `File.prototype.arrayBuffer` is patched before any app code runs, so the
     * race BLK-3 is about can be produced on demand instead of hoped for.
     */
    await page.evaluateOnNewDocument(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function (...args) {
            const delay = window.__m6SlowFiles?.[this.name] ?? 0;
            const result = original.apply(this, args);
            if (!delay) return result;
            return new Promise((resolve, reject) => {
                setTimeout(() => result.then(resolve, reject), delay);
            });
        };
    });

    const openSplitMerge = async () => {
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
            [...document.querySelectorAll('button')]
                .find((b) => b.textContent?.includes('PDF抽出・統合'))?.click();
        });
        await settle(400);
    };

    const bodyText = () => page.evaluate(() => document.body.textContent ?? '');
    const waitForText = async (needle, timeout = 15000) => {
        const started = Date.now();
        for (;;) {
            if ((await bodyText()).includes(needle)) return true;
            if (Date.now() - started > timeout) return false;
            await settle(200);
        }
    };

    // ---- 1. the preview never sees untrusted input first ---------------------
    //
    // A file the Load Boundary refuses must produce no PDF.js parse at all. The
    // observable form of "PDF.js did not run" is that its worker was never
    // fetched.
    console.log('\n=== 1. preview only after Load Boundary PASS ===');
    await openSplitMerge();
    requests.length = 0;

    let input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('decode-bomb-large'));
    await settle(2500);

    const refusedText = await bodyText();
    check('a refused file is reported, not previewed',
        refusedText.includes('安全に処理できることを確認できなかった'),
        refusedText.includes('安全に処理できることを確認できなかった') ? 'typed refusal shown' : 'NOT SHOWN');
    check('and PDF.js was never asked to parse it',
        workerRequests() === 0, `${workerRequests()} request(s) to ${WORKER}`);

    // The control: a file that passes does reach PDF.js, so the check above is
    // measuring the boundary rather than a page that never previews anything.
    requests.length = 0;
    await openSplitMerge();
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('nav-4p'));
    await settle(3000);
    check('a file that passes the boundary is previewed',
        workerRequests() > 0 && (await bodyText()).includes('Page 1'),
        `${workerRequests()} request(s) to ${WORKER}`);

    // ---- 2. BLK-3: the upload race -------------------------------------------
    console.log('\n=== 2. BLK-3 upload race ===');
    await openSplitMerge();

    // `merge-a` is 3 pages and made slow; `nav-4p` is 4 pages and is chosen
    // second. If the late run wins, the screen shows 3 pages and the export
    // carries merge-a's content under nav-4p's name.
    await page.evaluate(() => {
        window.__m6SlowFiles = { 'merge-a.pdf': 2500 };
    });
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('merge-a'));
    await settle(200);
    await input.uploadFile(fixture('nav-4p'));
    await settle(6000);

    const raceText = await bodyText();
    check('the screen shows the file chosen last',
        raceText.includes('nav-4p.pdf') && !raceText.includes('merge-a.pdf'),
        raceText.includes('nav-4p.pdf') ? 'nav-4p.pdf' : 'WRONG FILE');
    const pageCells = await page.$$eval('[data-usage-target="extract-pages"] > div',
        (els) => els.length);
    check('and its page count, not the slow file\'s',
        pageCells === 4, `${pageCells} page cells (nav-4p has 4, merge-a has 3)`);

    // Select every page and export, then read the artifact that came out.
    await page.evaluate(() => {
        for (const cell of document.querySelectorAll('[data-usage-target="extract-pages"] > div')) {
            cell.click();
        }
    });
    await settle(500);
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-export"]')?.click();
    });
    await settle(6000);

    const files = fs.readdirSync(downloads).filter((f) => f.endsWith('.pdf'));
    const exported = files.find((f) => f.startsWith('nav-4p'));
    check('the exported file is named for the file chosen last',
        Boolean(exported), files.join(', ') || 'no download');
    if (exported) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(downloads, exported)));
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        check('and its CONTENT is that file, not the slow one',
            doc.getPageCount() === 4, `${doc.getPageCount()} pages`);
    } else {
        check('and its CONTENT is that file, not the slow one', false, 'no artifact to read');
    }

    // ---- 3. RF-7: the confirmation names what it is asking about -------------
    console.log('\n=== 3. RF-7 confirmation shows the real losses ===');
    await openSplitMerge();
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('rem-js-fileattachment-aa'));
    await settle(3000);

    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-pages"] > div')?.click();
    });
    await settle(400);
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-export"]')?.click();
    });
    const named = await waitForText('secret-notes.txt');
    check('the attachment filename is on screen BEFORE the confirmation is given',
        named, named ? 'secret-notes.txt shown' : 'NOT SHOWN');
    const confirmText = await bodyText();
    check('and the confirmation button says it is a confirmation',
        confirmText.includes('内容を了承して書き出し'),
        confirmText.includes('内容を了承して書き出し') ? 'shown' : 'NOT SHOWN');

    // ---- 4. the B4 notice is visible ----------------------------------------
    console.log('\n=== 4. B4 notice visibility ===');

    const noticeGeometry = async () => page.evaluate(() => {
        const notice = document.querySelector('[data-usage-target="m6-b4-notice"]');
        if (!notice) return null;
        const rect = notice.getBoundingClientRect();
        const style = getComputedStyle(notice);
        // Whatever is painted at the middle of the notice: if it is not the
        // notice or one of its children, something is covering it.
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
            width: rect.width,
            height: rect.height,
            visible: style.visibility !== 'hidden'
                && style.display !== 'none'
                && Number(style.opacity) > 0,
            covered: !(hit === notice || notice.contains(hit)),
            text: notice.textContent ?? '',
        };
    });

    for (const [label, width, height] of [['desktop', 1400, 900], ['narrow', 390, 780]]) {
        await page.setViewport({ width, height });
        await openSplitMerge();
        await settle(400);
        const geo = await noticeGeometry();
        check(`the B4 notice is present and readable at ${label} (${width}px)`,
            Boolean(geo) && geo.visible && geo.width > 0 && geo.height > 0
            && geo.text.includes('B4 未決定'),
            geo ? `${Math.round(geo.width)}x${Math.round(geo.height)}` : 'NOT FOUND');
        check(`and nothing covers it at ${label}`,
            Boolean(geo) && geo.covered === false,
            geo ? `covered=${geo.covered}` : 'NOT FOUND');
    }
    await page.setViewport({ width: 1400, height: 900 });

    // ---- 5. BLK-4: every requested merge source is listed --------------------
    console.log('\n=== 5. BLK-4 every requested source is listed ===');
    await openSplitMerge();
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF統合'))?.click();
    });
    await settle(400);

    const mergeInput = await page.$('input[type="file"]');
    await mergeInput.uploadFile(
        fixture('merge-a'),
        fixture('xfa'),
        fixture('signature-applied'),
        fixture('no-header'),
    );
    await settle(6000);

    const mergeText = await bodyText();
    const rows = await page.$$eval('[data-usage-target="merge-list"] > div', (els) => els.length);
    check('every chosen file has a row, including the ones that cannot be merged',
        rows === 4, `${rows} rows for 4 files`);
    for (const [name, label] of [
        ['xfa.pdf', 'XFAフォームを含みます'],
        ['signature-applied.pdf', '電子署名が適用されています'],
        ['no-header.pdf', '安全に読み込めることを確認できませんでした'],
    ]) {
        check(`${name} is shown with its reason`,
            mergeText.includes(name) && mergeText.includes(label),
            mergeText.includes(name) ? 'named' : 'MISSING');
    }

    check('no uncaught page error during any of it',
        pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.httpServer.close();
    fs.rmSync(downloads, { recursive: true, force: true });
}
process.exit(exitCode);
