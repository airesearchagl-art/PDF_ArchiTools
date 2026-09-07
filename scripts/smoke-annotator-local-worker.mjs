/**
 * Deterministic smoke verification that the Annotator's PDF.js worker is local.
 *
 * The Annotator used to assign `GlobalWorkerOptions.workerSrc` to unpkg at
 * module scope, so opening a PDF fetched worker code from a CDN. The document
 * itself never left the browser, but the request did, and this product's
 * contract is that nothing leaves.
 *
 * Two things make a source diff insufficient evidence here:
 *
 *   1. The defect was a *runtime request*. The fix has to be shown the same way.
 *   2. `workerSrc` is a single global, and two other modules in this app still
 *      assign it to a CDN when they load. Which worker gets fetched therefore
 *      depends on module evaluation order in the bundle -- something only the
 *      built artifact can tell us. So this drives `dist/`, not the dev server.
 *
 * Run:  npm run build && node scripts/smoke-annotator-local-worker.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5182;
const ORIGIN = `http://localhost:${PORT}`;
const WORKER_PATH = '/pdf.worker.min.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so it can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// The artifact under test
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}

console.log('\n=== the worker ships with the app ===');
check('public/pdf.worker.min.mjs exists in the repository',
    fs.existsSync(path.join(ROOT, 'public', 'pdf.worker.min.mjs')));
check('and the build copies it into dist/',
    fs.existsSync(path.join(ROOT, 'dist', 'pdf.worker.min.mjs')),
    'so /pdf.worker.min.mjs is same-origin at runtime');

// ---------------------------------------------------------------------------
// A synthetic document, generated here and never committed
// ---------------------------------------------------------------------------

async function syntheticPdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    page.drawText('ANNOTATOR LOCAL WORKER SMOKE', {
        x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0),
    });
    page.drawRectangle({
        x: 60, y: 300, width: 400, height: 320,
        borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 2,
    });
    return Buffer.from(await doc.save());
}

const pdfBytes = await syntheticPdf();
const uploadPath = path.join(ROOT, 'test-fixtures', 'annotator-worker-smoke.pdf');
fs.mkdirSync(path.dirname(uploadPath), { recursive: true });
fs.writeFileSync(uploadPath, pdfBytes);

// ---------------------------------------------------------------------------
// Serve the build and drive it
// ---------------------------------------------------------------------------

const server = await preview({
    root: ROOT,
    preview: { port: PORT, strictPort: true },
    logLevel: 'warn',
});

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);

/** Every request the page or its workers make, from any context. */
const requests = [];
const pageErrors = [];
const record = (url) => {
    if (!url) return;
    requests.push(url);
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
// PdfPage catches a failed render and only logs it, so the console is the one
// place a render failure is visible at all.
const consoleErrors = [];
page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
});
// PDF.js runs in a Web Worker, and page-level events do not see the worker's
// own traffic -- including the request that fetches the worker's dependencies.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* target already gone */ }
});

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    // ---- into the Annotator ----------------------------------------------
    console.log('\n=== opening a PDF in the Annotator ===');
    const opened = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF加筆'));
        if (!button) return false;
        button.click();
        return true;
    });
    check('the Annotator opens', opened);

    await page.waitForSelector('input[type="file"][accept="application/pdf"]');

    // Everything from here is what opening a document costs, so the count
    // starts clean: requests made while the app was merely loading are not
    // what this gate is about.
    const beforeUpload = requests.length;

    const input = await page.$('input[type="file"][accept="application/pdf"]');
    await input.uploadFile(uploadPath);

    // ---- it has to actually render ---------------------------------------
    // The page canvas specifically. There is an annotation canvas stacked over
    // it, and `querySelector('canvas')` would happily settle for that one --
    // which is empty by design and says nothing about whether the PDF rendered.
    await page.waitForSelector('canvas.pdf-canvas', { timeout: 60000 });
    await page.waitForFunction(() => {
        const c = document.querySelector('canvas.pdf-canvas');
        return c && c.width > 0 && c.height > 0;
    }, { timeout: 60000 });
    // Let any late worker traffic arrive before the counting starts.
    await new Promise((resolve) => { setTimeout(resolve, 1500); });

    const rendered = await page.evaluate(() => {
        /**
         * Pixels that are actually marked.
         *
         * Transparency is the trap. An un-rendered canvas is (0,0,0,0)
         * everywhere, and a test that only asks "is this all white?" reads
         * those zeroed colour channels as dark ink and calls the blank canvas
         * painted. PdfPage catches a render failure and only logs it, leaving
         * exactly that canvas behind at full size -- so the wrong question
         * passes on the real failure.
         *
         * Alpha first, then colour.
         */
        const inkPixels = (canvas) => {
            if (!canvas || !canvas.width || !canvas.height) return 0;
            const { data } = canvas.getContext('2d')
                .getImageData(0, 0, canvas.width, canvas.height);
            let ink = 0;
            for (let i = 0; i < data.length; i += 4) {
                const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
                if (a > 0 && (r < 245 || g < 245 || b < 245)) ink++;
            }
            return ink;
        };

        // Controls for the classifier itself, so the measurement above is not
        // taken on trust: an untouched canvas must read as 0, and a canvas with
        // one known black mark must not.
        const scratch = document.createElement('canvas');
        scratch.width = 40;
        scratch.height = 40;
        const untouched = inkPixels(scratch);
        const ctx = scratch.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(4, 4, 10, 10);
        const marked = inkPixels(scratch);

        const white = document.createElement('canvas');
        white.width = 40;
        white.height = 40;
        const wctx = white.getContext('2d');
        wctx.fillStyle = '#ffffff';
        wctx.fillRect(0, 0, 40, 40);
        const whiteOnly = inkPixels(white);

        const pdfCanvas = document.querySelector('canvas.pdf-canvas');
        const err = document.querySelector('.error-message');
        return {
            canvasCount: document.querySelectorAll('canvas').length,
            pdfCanvasFound: pdfCanvas !== null,
            width: pdfCanvas?.width ?? 0,
            height: pdfCanvas?.height ?? 0,
            ink: inkPixels(pdfCanvas),
            control: { untouched, marked, whiteOnly },
            errorText: err?.textContent ?? '',
            stillLoading: document.body.textContent?.includes('Loading PDF...') ?? false,
        };
    });

    // A gate that only counted requests would pass just as happily on a broken
    // upload that never fetched anything at all.
    console.log('\n=== the document actually opened ===');
    check('the upload was accepted and the page canvas exists',
        rendered.pdfCanvasFound, `${rendered.canvasCount} canvas element(s), one of them .pdf-canvas`);
    check('the page canvas has real dimensions',
        rendered.width > 0 && rendered.height > 0, `${rendered.width}x${rendered.height}`);

    // The classifier before its verdict. An un-rendered canvas is transparent,
    // not white, and a check that misses that reads (0,0,0,0) as black ink and
    // passes on a page that never drew.
    probe('an untouched transparent canvas counts as no ink',
        rendered.control.untouched === 0, `${rendered.control.untouched} ink pixels`);
    probe('and so does a plain white one',
        rendered.control.whiteOnly === 0, `${rendered.control.whiteOnly} ink pixels`);
    check('while a canvas with one known black mark does not',
        rendered.control.marked === 100, `${rendered.control.marked} ink pixels for a 10x10 fill`);

    // The fixture is black text plus a 400x320 rectangle outline, so a rendered
    // page is thousands of marked pixels. The threshold is far below that and
    // far above nothing, rather than tuned to this fixture's exact output.
    check('and the page canvas was actually painted',
        rendered.ink > 500, `${rendered.ink} ink pixels`);
    check('no loading error is shown',
        rendered.errorText === '', rendered.errorText || 'no error message');
    check('and it is not still loading', rendered.stillLoading === false);
    probe('PdfPage logged no render error, which is the only place one appears',
        consoleErrors.filter((t) => t.includes('Render error:')).length === 0,
        consoleErrors.filter((t) => t.includes('Render error:')).join(' | ') || '0 render errors');

    // ---- where the worker came from --------------------------------------
    const duringOpen = requests.slice(beforeUpload);
    const localWorker = duringOpen.filter((u) => u === `${ORIGIN}${WORKER_PATH}`);
    const unpkg = requests.filter((u) => /^https?:\/\/(www\.)?unpkg\.com\//.test(u));
    const isExternal = (u) => {
        if (u.startsWith(ORIGIN)) return false;
        try {
            const { protocol } = new URL(u);
            return protocol === 'http:' || protocol === 'https:';
        } catch {
            return false; // relative, data:, blob: -- none of these touch the network
        }
    };
    const external = requests.filter(isExternal);

    console.log('\n=== where the worker came from ===');
    check('the worker was fetched from our own origin',
        localWorker.length >= 1,
        `${localWorker.length} request(s) to ${WORKER_PATH}`);
    probe('and not once from unpkg', unpkg.length === 0,
        unpkg.length === 0 ? '0 requests' : unpkg.join(' '));
    probe('nor from anywhere else off-origin', external.length === 0,
        external.length === 0
            ? '0 external HTTP(S) requests across the whole session'
            : external.join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('and no console errors at all',
        consoleErrors.length === 0, consoleErrors.join(' | ') || '0 console errors');

    // ---- the part a source diff cannot show ------------------------------
    //
    // The fix is not "the assignment was deleted". Two other modules -- the
    // split/merge tool and the PDF processor -- still assign this same global to
    // a CDN at module scope, and they sit in the app's entry chunk, so they
    // evaluate on load, before anyone opens a document. The global really is
    // pointing at unpkg by the time the Annotator runs.
    //
    // That makes the import-order protection testable with nothing but the
    // shipped artifact: no test hook, no injected URL. If the Annotator were
    // still relying on a module-scope assignment, whichever module evaluated
    // last would decide, and the request above could have been the CDN's.
    console.log('\n=== no CDN worker is left anywhere in the bundle ===');
    const bundleJs = fs.readdirSync(path.join(ROOT, 'dist', 'assets'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(ROOT, 'dist', 'assets', name), 'utf8'))
        .join('\n');
    const cdnAssignments = bundleJs.match(/unpkg\.com\/pdfjs-dist/g) ?? [];
    // This used to assert the opposite: two other modules still assigned this
    // global to a CDN, and the Annotator's point-of-use call was what kept its
    // own request local regardless. Those two have since been fixed, so the
    // expectation is now that nothing in the bundle points a PDF.js worker at a
    // CDN at all.
    //
    // The point-of-use contract is still what makes the Annotator's result
    // independent of module evaluation order, and it is still asserted below --
    // it is the reason a future module-scope assignment elsewhere could not
    // reach this feature.
    check('no PDF.js worker is pointed at a CDN anywhere in the bundle',
        cdnAssignments.length === 0,
        cdnAssignments.length === 0 ? '0 assignments' : `${cdnAssignments.length} left`);
    probe('and the Annotator fetched its worker from this app',
        localWorker.length >= 1 && unpkg.length === 0,
        `${localWorker.length} local, ${unpkg.length} unpkg`);

    const viewerSource = fs.readFileSync(
        path.join(ROOT, 'src', 'components', 'PdfViewer.tsx'), 'utf8');
    // Assignments, not mentions -- the file explains the global in a comment.
    const viewerCode = viewerSource.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    check('the Annotator no longer assigns the global itself',
        !/workerSrc\s*=/.test(viewerCode) && !viewerCode.includes('unpkg'),
        'it calls configurePdfWorker() at the point of use instead');
    check('and it calls that helper immediately before getDocument',
        /configurePdfWorker\(\);\s*\n\s*const loadedPdf = await pdfjsLib\.getDocument/
            .test(viewerSource),
        'not at module scope, where import order would decide');

    console.log('\n=== requests made while opening the document ===');
    for (const u of [...new Set(duringOpen)]) {
        console.log(`  ${u.startsWith(ORIGIN) ? 'local   ' : 'EXTERNAL'} ${u}`);
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`
        + `, ${checks.filter((c) => c.name.startsWith('negative probe')).length} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nThe Annotator fetches its PDF.js worker from this app, and nothing else.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nSmoke run failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
    fs.rmSync(uploadPath, { force: true });
}

process.exit(exitCode);
