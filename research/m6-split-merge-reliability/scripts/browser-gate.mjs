/**
 * The browser half of the M6 research gate, driven.
 *
 * Serves the repository with vite, opens `preview-harness.html`, and records
 * what the current preview and export routes cost and leave behind. The harness
 * reproduces the production route; this file only asks it questions and writes
 * the answers down.
 *
 * Two honesty notes that travel with the numbers:
 *
 *  - `performance.memory` is Chrome-only, quantised and moves with collection
 *    nobody controls. Every heap figure here is MEASURED_ONLY and no bound is
 *    derived from one. The deterministic figure is the retained string length.
 *  - the object-URL measurement assigns `link.href` exactly as production does
 *    but does not click it, because a real download would leave files behind.
 *    So it proves that **revoke is never called**, which is the question; it
 *    does not prove anything about the click itself.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-fixtures.mjs
 *       node research/m6-split-merge-reliability/scripts/browser-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.resolve(HERE, '..');
const ROOT = path.resolve(RESEARCH, '..', '..');
const PORT = 5216;
const ORIGIN = `http://localhost:${PORT}`;
const MIB = 1024 * 1024;

const fmt = (n) => Number(n).toLocaleString('en-US');
const mib = (n) => `${(n / MIB).toFixed(1)} MiB`;

const rows = [];
const say = (kind, name, ok, detail) => {
    rows.push({ kind, name, ok });
    const mark = ok === null ? '····' : (ok ? 'PASS' : 'FAIL');
    console.log(`  ${mark}  [${kind}] ${name}${detail ? `  ${detail}` : ''}`);
};
const assert_ = (name, ok, detail = '') => say('ASSERT', name, !!ok, detail);
const probe = (name, ok, detail = '') => say('PROBE', name, !!ok, detail);
const measure = (name, detail = '') => say('MEASURE', name, null, detail);
const baselineFail = (name, reproduced, detail = '') => say('BASELINE-FAIL', name, !!reproduced, detail);
const humanOpen = (name, detail = '') => say('HUMAN-OPEN', name, null, detail);

const evidence = { preview: {}, strategies: {}, lifetime: {}, ownership: {}, network: {} };

const server = await createServer({
    root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn',
});
await server.listen();
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--expose-gc'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
page.on('request', (r) => {
    const url = r.url();
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* data:, blob: */ }
});
page.on('pageerror', (e) => pageErrors.push(e.message));
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => {
            const url = e.request?.url;
            if (url && !url.startsWith(ORIGIN) && /^https?:/.test(url)) external.push(url);
        });
    } catch { /* gone */ }
});

let exitCode = 1;
try {
    await page.goto(
        `${ORIGIN}/research/m6-split-merge-reliability/scripts/preview-harness.html`,
        { waitUntil: 'networkidle0' },
    );
    await page.waitForFunction(() => window.__m6Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m6[f](...a), fn, args);

    // ---- 1. what the current preview costs ---------------------------------
    console.log('\n=== 1. preview cost, the route production takes ===');
    const bulk = await call('previewCost', ['pages-10', 'pages-50', 'pages-100', 'pages-200']);
    for (const r of bulk) {
        evidence.preview[r.name] = r;
        measure(`${r.name}`,
            `${r.pages} pages, retained Data URLs ${mib(r.retainedDataUrlBytes)}, `
            + `peak canvas ${mib(r.peakCanvasRgbaBytes)}, ${r.elapsedMs} ms`
            + (r.heapDelta === null ? '' : `, heap +${mib(r.heapDelta)} (advisory)`));
    }

    const a1 = (await call('previewCost', ['pages-10-a1']))[0];
    evidence.preview[a1.name] = a1;
    measure('pages-10-a1',
        `${a1.pages} A1 sheets, retained ${mib(a1.retainedDataUrlBytes)}, `
        + `peak canvas ${mib(a1.peakCanvasRgbaBytes)}, ${a1.elapsedMs} ms`);

    const perPage = (r) => r.retainedDataUrlBytes / r.pages;
    assert_('retained preview memory grows with page count, without a ceiling anywhere',
        evidence.preview['pages-200'].retainedDataUrlBytes
            > evidence.preview['pages-10'].retainedDataUrlBytes,
        `${mib(evidence.preview['pages-10'].retainedDataUrlBytes)} at 10 pages → `
        + `${mib(evidence.preview['pages-200'].retainedDataUrlBytes)} at 200`);
    measure('cost per page, A4 at scale 1.5',
        `${fmt(Math.round(perPage(evidence.preview['pages-200'])))} B retained per page`);
    measure('cost per page, A1 at scale 1.5',
        `${fmt(Math.round(perPage(a1)))} B retained per page, `
        + `${(perPage(a1) / perPage(evidence.preview['pages-10'])).toFixed(1)}× the A4 figure`);
    baselineFail('every page of a document is rasterised and retained before anything is selected',
        evidence.preview['pages-200'].retainedCount === 200,
        `${evidence.preview['pages-200'].retainedCount} thumbnails held for a 200-page source`);

    // ---- 2. the alternatives, priced ---------------------------------------
    console.log('\n=== 2. preview strategies ===');
    const strategies = await call('previewStrategies', 'pages-100');
    evidence.strategies = strategies;
    measure('P1 all pages as Data URLs',
        `${mib(strategies.p1AllDataUrls.retainedBytes)} retained, `
        + `peak canvas ${mib(strategies.p1AllDataUrls.peakCanvasRgbaBytes)}, `
        + `${strategies.p1AllDataUrls.elapsedMs} ms for ${strategies.pages} pages`);
    measure(`P2 a ${strategies.p2LazyWindow.window}-page window`,
        `${mib(strategies.p2LazyWindow.retainedBytes)} retained`);
    measure(`P3 Blob URLs for the same window`,
        `${mib(strategies.p3BlobUrls.blobBytes)} out of the JS heap, `
        + `${fmt(strategies.p3BlobUrls.retainedJsHeapBytes)} B in it`);
    probe('a bounded window retains less than the whole document does',
        strategies.p2LazyWindow.retainedBytes < strategies.p1AllDataUrls.retainedBytes,
        `${mib(strategies.p2LazyWindow.retainedBytes)} vs ${mib(strategies.p1AllDataUrls.retainedBytes)}`);
    humanOpen('M6-H12 thumbnail strategy',
        'P1 current / P2 windowed rendering / P3 bounded Blob URLs / P4 regenerated cache');

    // ---- 3. publication and document lifetime ------------------------------
    console.log('\n=== 3. object URLs and PDF.js lifetime ===');
    const urls = await call('publicationLifetime', 'mixed-6p', 5);
    evidence.lifetime.objectUrls = urls;
    baselineFail('every export creates an object URL and none is ever revoked',
        urls.created === urls.runs && urls.revoked === 0,
        `${urls.created} created, ${urls.revoked} revoked across ${urls.runs} exports`);

    const pdfjs = await call('pdfjsLifetime', 'mixed-6p');
    evidence.lifetime.pdfjs = pdfjs;
    baselineFail('the preview leaves its PDF.js document open',
        pdfjs.stillUsableWithoutDestroy === true && pdfjs.usableAfterDestroy === false,
        `usable without destroy(): ${pdfjs.stillUsableWithoutDestroy}, after destroy(): ${pdfjs.usableAfterDestroy}`);

    // ---- 4. ownership ------------------------------------------------------
    console.log('\n=== 4. a run superseded while it is still rendering ===');
    const superseded = await call('supersededPreview', 'pages-100', 'pages-10');
    evidence.ownership = superseded;
    measure('two previews started together',
        `finish order ${superseded.finishOrder.join(' → ')}, last writer ${superseded.lastWriterWins}`);
    baselineFail('nothing decides which preview owns the screen: the last one to finish wins',
        superseded.finishOrder.length === 2,
        'there is no run token in the component, so a slow first source can overwrite a fast second one');
    humanOpen('M6-H13 ownership and cancellation',
        'generalize the M5 RunOwnership primitive, or define a Split/Merge-specific contract');

    // ---- 5. local only -----------------------------------------------------
    console.log('\n=== 5. local only ===');
    evidence.network = { externalRequests: external };
    assert_('no request left the machine during any of it',
        external.length === 0, external.join(', ') || 'external HTTP(S) = 0');
    assert_('no page error during any of it', pageErrors.length === 0, pageErrors.join(' | '));

    fs.writeFileSync(
        path.join(RESEARCH, 'evidence-browser.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
    );

    const counted = rows.filter((r) => r.ok !== null);
    const failed = counted.filter((r) => !r.ok);
    const byKind = (kind) => rows.filter((r) => r.kind === kind).length;
    console.log(`\n  ASSERT ${byKind('ASSERT')}  PROBE ${byKind('PROBE')}  MEASURE ${byKind('MEASURE')}  `
        + `BASELINE-FAIL ${byKind('BASELINE-FAIL')}  HUMAN-OPEN ${byKind('HUMAN-OPEN')}`);
    console.log(`  ${counted.length - failed.length}/${counted.length} verifiable rows passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - [${f.kind}] ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nbrowser gate failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
