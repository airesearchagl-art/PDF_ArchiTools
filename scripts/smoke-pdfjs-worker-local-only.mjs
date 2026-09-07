/**
 * Every PDF.js worker in this app comes from this app.
 *
 * The Annotator was fixed first and has its own gate. Two production paths kept
 * assigning `GlobalWorkerOptions.workerSrc` to unpkg at module scope — the
 * split/merge tool and the PDF processor — so opening a PDF in either of them
 * still fetched worker code from a CDN. The document never left the browser,
 * but the request did.
 *
 * A source diff cannot close this. `workerSrc` is a single global that several
 * modules write to, and in a bundle they all evaluate on load with the last one
 * winning, so which worker is actually fetched is a property of the built
 * artifact and of the order things run in. This drives `dist/` through the real
 * UI and counts requests.
 *
 * Run:  npm run build
 *       node scripts/make-annotator-save-fixtures.mjs
 *       node scripts/smoke-pdfjs-worker-local-only.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5185;
const ORIGIN = `http://localhost:${PORT}`;
const WORKER = '/pdf.worker.min.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// The bundle, before anything runs
// ---------------------------------------------------------------------------

console.log('\n=== the shipped bundle ===');
const bundle = fs.readdirSync(path.join(ROOT, 'dist', 'assets'))
    .filter((n) => n.endsWith('.js'))
    .map((n) => fs.readFileSync(path.join(ROOT, 'dist', 'assets', n), 'utf8'))
    .join('\n');
const cdnAssignments = bundle.match(/unpkg\.com\/pdfjs-dist/g) ?? [];
check('no PDF.js worker is pointed at a CDN anywhere in the bundle',
    cdnAssignments.length === 0,
    cdnAssignments.length === 0 ? '0 assignments' : `${cdnAssignments.length} left`);
check('the worker ships with the app',
    fs.existsSync(path.join(ROOT, 'dist', WORKER.slice(1))),
    `dist${WORKER}`);
// Static text is where this defect used to be visible, but it is not where it
// lives: the rest of this file is the evidence that matters.
console.log('  (static only — the runtime checks below are the evidence)');

// ---------------------------------------------------------------------------
// Synthetic documents
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjs-worker-'));
async function makePdf(name, pages, label) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= pages; n++) {
        const page = doc.addPage([420, 595]);
        page.drawText(`${label} ${n}/${pages}`, {
            x: 50, y: 500, size: 18, font, color: rgb(0, 0, 0),
        });
        page.drawRectangle({
            x: 40, y: 60, width: 340, height: 400,
            borderColor: rgb(0, 0, 0), borderWidth: 1.5,
        });
    }
    const file = path.join(tmp, name);
    fs.writeFileSync(file, await doc.save());
    return file;
}
const threePager = await makePdf('three.pdf', 3, 'WORKER SMOKE');
const twoPager = await makePdf('two.pdf', 2, 'SECOND DOC');
const onePager = await makePdf('one.pdf', 1, 'PROCESS ME');

// ---------------------------------------------------------------------------
// Serve the build and drive it
// ---------------------------------------------------------------------------

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjs-worker-dl-'));
const server = await preview({
    root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn',
});
const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);
await page.setViewport({ width: 1400, height: 1000 });

const requests = [];
const pageErrors = [];
const consoleErrors = [];
page.on('request', (r) => requests.push(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => requests.push(e.request?.url));
    } catch { /* gone */ }
});
const cdp = await page.target().createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const openTool = async (label) => {
    const clicked = await page.evaluate((t) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(t));
        if (!b) return false;
        b.click();
        return true;
    }, label);
    await settle(500);
    return clicked;
};
const localWorkerCount = () => requests.filter((u) => u === `${ORIGIN}${WORKER}`).length;
const unpkgCount = () => requests.filter((u) => /^https?:\/\/(www\.)?unpkg\.com\//.test(u)).length;

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    // ---- split / merge: extract ------------------------------------------
    console.log('\n=== split and merge: extract ===');
    check('the tool opens', await openTool('PDF抽出・統合'));
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF抽出'))?.click();
    });
    await settle(300);

    let before = localWorkerCount();
    const extractInput = await page.$('input[type="file"]');
    await extractInput.uploadFile(threePager);
    await page.waitForFunction(() => document.querySelectorAll('canvas, img').length >= 3,
        { timeout: 60000 }).catch(() => {});
    await settle(1500);

    const extracted = await page.evaluate(() => {
        const previews = [...document.querySelectorAll('canvas, img')]
            .filter((el) => (el.width ?? el.naturalWidth ?? 0) > 0);
        return {
            previews: previews.length,
            firstWidth: previews[0]?.width ?? previews[0]?.naturalWidth ?? 0,
            bodyText: document.body.textContent?.slice(0, 0) ?? '',
        };
    });
    check('the PDF loaded and its pages were previewed',
        extracted.previews >= 3, `${extracted.previews} page previews`);
    check('the previews have real dimensions', extracted.firstWidth > 0,
        `${extracted.firstWidth}px`);
    check('and the worker came from this app',
        localWorkerCount() > before,
        `${localWorkerCount() - before} request(s) to ${WORKER}`);

    // ---- split / merge: merge ---------------------------------------------
    console.log('\n=== split and merge: merge ===');
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF統合'))?.click();
    });
    await settle(400);
    before = localWorkerCount();
    const mergeInput = await page.$('input[type="file"]');
    await mergeInput.uploadFile(threePager, twoPager);
    await settle(2500);

    const merged = await page.evaluate(() => document.body.textContent ?? '');
    // The page counts of the two documents are what the merge path reads
    // through PDF.js, so seeing them is seeing the worker having run.
    check('both documents were read and their page counts shown',
        /3\s*(ページ|page)/i.test(merged) && /2\s*(ページ|page)/i.test(merged),
        merged.includes('3') && merged.includes('2') ? 'page counts present' : 'NOT FOUND');
    check('and the worker came from this app',
        localWorkerCount() > before,
        `${localWorkerCount() - before} request(s) to ${WORKER}`);

    // ---- the processor: monochrome and optimize --------------------------
    for (const [label, tool] of [['モノクロ化', 'monochrome'], ['最適化', 'optimize']]) {
        console.log(`\n=== the processor: ${tool} ===`);
        check('the processor opens', await openTool('PDF加工'));
        await page.evaluate((t) => {
            [...document.querySelectorAll('.tool-btn')]
                .find((b) => b.textContent?.includes(t))?.click();
        }, label);
        await settle(300);

        before = localWorkerCount();
        const beforeFiles = fs.readdirSync(downloads);
        const upload = await page.$('[data-usage-target="processor-upload"] input[type="file"]')
            ?? await page.$('input[type="file"]');
        await upload.uploadFile(onePager);
        await settle(800);
        await page.evaluate(() => {
            document.querySelector('[data-usage-target="processor-run"]')?.click();
        });

        let produced = null;
        for (let i = 0; i < 120 && !produced; i++) {
            await settle(500);
            const now = fs.readdirSync(downloads)
                .filter((f) => !beforeFiles.includes(f) && f.toLowerCase().endsWith('.pdf'));
            if (now.length > 0) produced = now[0];
        }
        check(`${tool}: it produced a file`, produced !== null, produced ?? 'nothing appeared');
        if (produced) {
            const out = new Uint8Array(fs.readFileSync(path.join(downloads, produced)));
            check(`${tool}: the output has bytes`, out.length > 0, `${out.length} bytes`);
            const reopened = await PDFDocument.load(out, { updateMetadata: false });
            check(`${tool}: the output reopens`, reopened.getPageCount() > 0);
            check(`${tool}: the page count is preserved`,
                reopened.getPageCount() === 1, `${reopened.getPageCount()} page`);
            fs.rmSync(path.join(downloads, produced));
        }
        check(`${tool}: the worker came from this app`,
            localWorkerCount() > before,
            `${localWorkerCount() - before} request(s) to ${WORKER}`);
    }

    // ---- where every request went ----------------------------------------
    console.log('\n=== every request the session made ===');
    const isExternal = (u) => {
        if (!u || u.startsWith(ORIGIN)) return false;
        try {
            const { protocol } = new URL(u);
            return protocol === 'http:' || protocol === 'https:';
        } catch { return false; }
    };
    const external = requests.filter(isExternal);
    check('every worker request was same-origin', localWorkerCount() >= 4,
        `${localWorkerCount()} request(s) to ${WORKER} across four PDF.js paths`);
    probe('not one went to unpkg', unpkgCount() === 0,
        unpkgCount() === 0 ? '0 requests' : `${unpkgCount()} requests`);
    probe('nor anywhere else off-origin', external.length === 0,
        external.length === 0 ? '0 external HTTP(S) requests' : external.join(' '));
    probe('and nothing logged a render error',
        consoleErrors.filter((t) => /render error/i.test(t)).length === 0,
        consoleErrors.filter((t) => /render error/i.test(t)).join(' | ') || '0');
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    // ---- the contract in source ------------------------------------------
    //
    // Not the main evidence — the request counts above are — but it states
    // which call sites the runtime result depends on, so a later change that
    // moves one back to module scope is visible here rather than only as a
    // silent regression on somebody's network tab.
    console.log('\n=== where the worker is configured ===');
    const sourceOf = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const strip = (t) => t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const [file, calls] of [
        ['src/components/PdfSplitMerge.tsx', 2],
        ['src/utils/pdf-processor.ts', 2],
        ['src/components/PdfViewer.tsx', 1],
    ]) {
        const code = strip(sourceOf(file));
        const configured = (code.match(/configurePdfWorker\(\)/g) ?? []).length;
        check(`${file.split('/').pop()}: configures the worker at each use`,
            configured >= calls && !/workerSrc\s*=/.test(code) && !code.includes('unpkg'),
            `${configured} point-of-use call(s), no module-scope assignment`);
    }

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nEvery PDF.js worker in this app comes from this app.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nSmoke run failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
}

process.exit(exitCode);
