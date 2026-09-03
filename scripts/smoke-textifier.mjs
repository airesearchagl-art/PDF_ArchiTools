/**
 * Deterministic smoke verification for the Textifier OCR pipeline.
 *
 * Drives the production module in a real browser against synthetic fixtures.
 * Small on purpose: this is a gate, not a test framework. It exits non-zero if
 * any check fails.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/smoke-textifier.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5177;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'scanned-ja.pdf'))) {
    console.error('Fixtures missing. Run: node scripts/make-test-fixtures.mjs');
    process.exit(1);
}

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

/** Anything that is not our own origin. data:/blob: never touch the network. */
const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
};
page.on('response', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
// OCR runs inside a Web Worker, and page-level events do not see its traffic.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* target already gone */ }
});

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__smoke?.ready === true, { timeout: 120000 });

    // ---- classification ---------------------------------------------------
    console.log('\n=== page classification ===');
    const native = await page.evaluate(() => window.__smoke.classify('text-native-ja-en.pdf'));
    check('text-native page classified as text-native', native[0]?.kind === 'text-native',
        `interiorChars=${native[0]?.interiorChars}`);

    const mixedClass = await page.evaluate(() => window.__smoke.classify('mixed-multipage.pdf'));
    check('mixed document classified per page',
        mixedClass.map((c) => c.kind).join(',') === 'text-native,scanned,text-native',
        mixedClass.map((c) => `p${c.pageNumber}=${c.kind}`).join(' '));

    // ---- pipeline runs ----------------------------------------------------
    const runs = {};
    for (const [fixture, checkPage] of [
        ['text-native-ja-en.pdf', 1],
        ['scanned-en.pdf', 1],
        ['scanned-ja.pdf', 1],
        ['scanned-ja-en.pdf', 1],
        ['mixed-multipage.pdf', 2],
        ['scanned-rotated.pdf', 1],
    ]) {
        console.log(`\n=== ${fixture} ===`);
        const r = await page.evaluate((f, p) => window.__smoke.run(f, p), fixture, checkPage);
        runs[fixture] = r;
        for (const p of r.pages) {
            console.log(`  p${p.pageNumber}: ${p.kind.padEnd(12)} ocrWords=${String(p.ocrWords).padStart(3)} placed=${String(p.placed).padStart(3)} conf=${p.meanConfidence ?? '-'} ${p.ms}ms${p.error ? `  ERROR ${p.error}` : ''}`);
        }
        console.log(`  extracted: ${(r.extracted[checkPage - 1] || '').slice(0, 110)}`);
        console.log(`  appearance identical=${r.appearance.identical} diff=${r.appearance.differingPixels ?? '-'}  selection spans=${r.placement.spans} chars=${r.placement.selectedChars} containedInInk=${r.placement.containedInInk}`);
        console.log(`  placement: text=${JSON.stringify(r.placement.textBox)} ink=${JSON.stringify(r.placement.inkBox)} samples=${JSON.stringify(r.placement.samples)}`);
        console.log(`  size ${r.inputBytes} -> ${r.outputBytes}  fontEmbedded=${r.fontEmbedded}  ${r.totalMs}ms`);
    }

    // ---- assertions -------------------------------------------------------
    console.log('\n=== checks ===');
    const tn = runs['text-native-ja-en.pdf'];
    check('text-native page never reaches the OCR engine',
        tn.pages.every((p) => p.kind === 'text-native' && p.ocrWords === 0));
    check('text-native output does NOT embed the OCR font (lazy embed)',
        tn.fontEmbedded === false && tn.outputBytes <= tn.inputBytes + 50_000,
        `${tn.inputBytes} -> ${tn.outputBytes}`);
    check('text-native text still extracts', (tn.extracted[0] || '').includes('建築図面'));

    const en = runs['scanned-en.pdf'];
    check('scanned English recognised', /Architectural/.test(en.extracted[0] || '') && /Drawing/.test(en.extracted[0] || ''));

    const ja = runs['scanned-ja.pdf'];
    check('scanned Japanese recognised', /建築/.test(ja.extracted[0] || '') && /図面/.test(ja.extracted[0] || ''));

    const mix = runs['scanned-ja-en.pdf'];
    check('mixed Japanese + English recognised',
        /建築/.test(mix.extracted[0] || '') && /Architectural/.test(mix.extracted[0] || ''));

    const multi = runs['mixed-multipage.pdf'];
    check('mixed multi-page: 3 pages processed', multi.pages.length === 3);
    check('mixed multi-page: only the scanned page was OCR\'d',
        multi.pages[0].ocrWords === 0 && multi.pages[1].ocrWords > 0 && multi.pages[2].ocrWords === 0,
        multi.pages.map((p) => p.ocrWords).join('/'));
    check('mixed multi-page: scanned page text extracts', /建築|Architectural/.test(multi.extracted[1] || ''));

    const rot = runs['scanned-rotated.pdf'];
    check('rotated page recognised', /建築|Architectural/.test(rot.extracted[0] || ''));
    check('rotated page: invisible text lands on the ink (rotation-aware matrix)',
        rot.placement.containedInInk >= 0.85,
        `containedInInk=${rot.placement.containedInInk} text=${JSON.stringify(rot.placement.textBox)} ink=${JSON.stringify(rot.placement.inkBox)}`);
    check('upright page: invisible text lands on the ink (control)',
        runs['scanned-ja-en.pdf'].placement.containedInInk >= 0.85,
        `containedInInk=${runs['scanned-ja-en.pdf'].placement.containedInInk}`);

    for (const [name, r] of Object.entries(runs)) {
        if (name === 'text-native-ja-en.pdf') continue;
        check(`${name}: appearance preserved`, r.appearance.identical === true,
            `diff=${r.appearance.differingPixels}`);
        check(`${name}: output text is selectable`, r.placement.selectable === true,
            `${r.placement.selectedChars} chars`);
    }

    check('scanned runs embed the Japanese font',
        ['scanned-en.pdf', 'scanned-ja.pdf', 'scanned-ja-en.pdf', 'scanned-rotated.pdf']
            .every((f) => runs[f].fontEmbedded === true));

    check('no page reported an OCR error',
        Object.values(runs).every((r) => r.pages.every((p) => !p.error)));

    // ---- cancellation -----------------------------------------------------
    console.log('\n=== cancellation ===');
    const cancel = await page.evaluate(() => window.__smoke.cancelProbe('mixed-multipage.pdf'));
    console.log(`  ${JSON.stringify(cancel)}`);
    check('cancel rejects instead of returning a partial document',
        cancel.threw === true && cancel.code === 'cancelled');

    // ---- network ----------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external request during OCR', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    fs.mkdirSync(path.join(ROOT, 'test-fixtures'), { recursive: true });
    fs.writeFileSync(
        path.join(ROOT, 'test-fixtures', 'smoke-results.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), checks, external: [...new Set(external)], pageErrors }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
