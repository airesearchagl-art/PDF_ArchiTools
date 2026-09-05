/**
 * Measure what geometry the current pipeline can actually give a table
 * reconstructor, for native pages and for scanned ones.
 *
 * Nothing here is described from memory. The TextItem field set is read off a
 * real item, the ruling lines are read out of a real operator list, and the OCR
 * boxes come through the app's own render -> preprocess -> recognise path.
 *
 * Output lands in test-fixtures/m2-4/tokens/ as JSON, which the detection and
 * metric work then reads. Keeping the two apart is what makes the detection
 * side deterministic: it scores the same tokens every time, in Node, with no
 * browser in the loop.
 *
 * Run:  node scripts/research-m2-4-fixtures.mjs && node scripts/research-m2-4-geometry.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-4');
const TOKENS = path.join(FIX, 'tokens');
const PORT = 5186;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIX, 'native-ruled-simple.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'research-m2-4-fixtures.mjs')], { stdio: 'inherit' });
}
fs.mkdirSync(TOKENS, { recursive: true });

const names = fs.readdirSync(FIX).filter((f) => f.endsWith('.pdf')).map((f) => f.replace(/\.pdf$/, '')).sort();
const truthOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8'));

/** Pages that must be recognised rather than read. */
const scannedFixtures = names.filter((n) => truthOf(n).source === 'scanned');
/** The mixed document has one scanned page in the middle of native ones. */
const mixedWithScan = ['mixed-document'];

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
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
    } catch { /* target already gone */ }
});

const writeJson = (file, data) => fs.writeFileSync(path.join(TOKENS, file), `${JSON.stringify(data, null, 1)}\n`);

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/research-m2-4-geometry-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m24Ready === true, { timeout: 120000 });

    // ---- what a TextItem carries -------------------------------------------
    console.log('\n=== native TextItem surface (measured, not recalled) ===');
    const inspected = await page.evaluate(() => window.__m24.inspect('native-ruled-simple'));
    writeJson('inspect-native-ruled-simple.json', inspected);
    console.log(`  fields on a TextItem : ${inspected.itemKeys.join(', ')}`);
    console.log(`  items on the page    : ${inspected.itemCount}`);
    console.log(`  page /Rotate         : ${inspected.rotate}`);
    console.log(`  viewport transform   : [${inspected.viewport.transform.join(', ')}]`);
    console.log(`  first item           : ${JSON.stringify(inspected.firstItems[0])}`);
    console.log(`  style entry          : ${JSON.stringify(inspected.styleSample)}`);
    console.log(`  operators on the page: ${Object.entries(inspected.opNames).map(([k, v]) => `${k}x${v}`).join(' ')}`);
    console.log(`  constructPath args   : ${JSON.stringify(inspected.pathSample)}`);

    const rotated = await page.evaluate(() => window.__m24.inspect('native-rotated-90'));
    writeJson('inspect-native-rotated-90.json', rotated);
    console.log(`  /Rotate 90 page      : rotate=${rotated.rotate} viewport=${rotated.viewport.width}x${rotated.viewport.height} transform=[${rotated.viewport.transform.join(', ')}]`);

    // ---- native tokens for every fixture ------------------------------------
    console.log('\n=== native tokens ===');
    for (const name of names) {
        const dump = await page.evaluate((n) => window.__m24.nativeTokens(n), name);
        writeJson(`native-${name}.json`, dump);
        const total = dump.pages.reduce((n, p) => n + p.tokens.length, 0);
        const eol = dump.pages.reduce((n, p) => n + p.tokens.filter((t) => t.hasEOL).length, 0);
        console.log(`  ${name.padEnd(28)} ${String(total).padStart(5)} tokens  ${String(eol).padStart(3)} hasEOL  ${dump.ms}ms`);
    }

    // ---- ruling lines from the operator list ---------------------------------
    console.log('\n=== ruling-line candidates from the vector content ===');
    for (const name of names) {
        const dump = await page.evaluate((n) => window.__m24.rulingLines(n), name);
        writeJson(`paths-${name}.json`, dump);
        const h = dump.pages.reduce((n, p) => n + p.segments.filter((s) => s.orientation === 'h').length, 0);
        const v = dump.pages.reduce((n, p) => n + p.segments.filter((s) => s.orientation === 'v').length, 0);
        const d = dump.pages.reduce((a, p) => ({
            decoded: a.decoded + p.decode.decoded, verified: a.verified + p.decode.verified,
            fellBack: a.fellBack + p.decode.fellBack, diagonal: a.diagonal + p.decode.diagonal,
        }), { decoded: 0, verified: 0, fellBack: 0, diagonal: 0 });
        console.log(`  ${name.padEnd(28)} ${String(h).padStart(4)}h ${String(v).padStart(4)}v  decoded ${d.verified}/${d.decoded} verified  ${d.fellBack} fell back  ${d.diagonal} diagonal  ${dump.ms}ms`);
    }

    // ---- OCR tokens ------------------------------------------------------------
    console.log('\n=== OCR word boxes, through the pipeline as it ships ===');
    const ocrTargets = [
        ...scannedFixtures.map((name) => ({ name, opts: {} })),
        ...mixedWithScan.map((name) => ({ name, opts: {} })),
        { name: 'scanned-skew-noisy-table', opts: { deskew: true, noiseReduction: true }, tag: 'preprocessed' },
        // The two controls for the empty-table result: a sheet scanned at twice
        // the resolution and rendered to match it, and the same table with its
        // ruling lines taken away.
        { name: 'scanned-ruled-hires', opts: { dpi: 300 }, tag: 'dpi300' },
    ];
    for (const target of ocrTargets) {
        const dump = await page.evaluate((n, o) => window.__m24.ocrTokens(n, o), target.name, target.opts);
        const file = `ocr-${target.name}${target.tag ? `-${target.tag}` : ''}.json`;
        writeJson(file, dump);
        const total = dump.pages.reduce((n, p) => n + p.tokens.length, 0);
        const conf = dump.pages.map((p) => p.meanConfidence).filter((c) => c !== null);
        const mean = conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length) : null;
        const prep = dump.pages[0]?.preprocess;
        console.log(`  ${(target.name + (target.tag ? ` (${target.tag})` : '')).padEnd(40)} ${String(total).padStart(4)} words  conf ${String(mean).padStart(3)}  ${dump.ms}ms  ${prep?.deskewApplied ? `deskew ${prep.detectedAngle}deg mapped=${prep.mapped}` : 'no deskew'}`);
    }

    // ---- the same pages, recognised with the segmentation set --------------
    console.log('\n=== OCR word boxes with segmentation set to AUTO (research only) ===');
    for (const name of [...scannedFixtures, ...mixedWithScan]) {
        const dump = await page.evaluate((n) => window.__m24.ocrTokensPsm(n, { psm: 'AUTO' }), name);
        writeJson(`ocrpsm-${name}.json`, dump);
        const total = dump.pages.reduce((n, p) => n + p.tokens.length, 0);
        console.log(`  ${name.padEnd(30)} ${String(total).padStart(4)} words  ${dump.ms}ms`);
    }

    // ---- is the low word count a resolution effect, or a layout one? --------
    //
    // The first run recognised the sheet title and nothing inside the table.
    // That is either "the cell text is too small at 150 DPI" or "Tesseract's
    // layout analysis does not descend into a ruled box", and the two lead to
    // completely different architectures. So it is measured, not argued.
    console.log('\n=== OCR against render resolution ===');
    const dpiRuns = [];
    for (const dpi of [150, 300, 400]) {
        const dump = await page.evaluate((n, o) => window.__m24.ocrTokens(n, o), 'scanned-ruled-simple', { dpi });
        writeJson(`ocr-dpi-${dpi}-scanned-ruled-simple.json`, dump);
        const p = dump.pages[0];
        const inTable = p.tokens.filter((t) => t.y0 > 90).length;
        dpiRuns.push({ dpi, words: p.tokens.length, inTable, ms: dump.ms, canvas: p.canvas });
        console.log(`  ${String(dpi).padStart(3)} DPI  canvas ${p.canvas.width}x${p.canvas.height}  ${String(p.tokens.length).padStart(3)} words  ${String(inTable).padStart(3)} inside the table  conf ${p.meanConfidence}  ${dump.ms}ms`);
    }
    writeJson('ocr-dpi-sweep.json', dpiRuns);

    // ---- can a parameter recover the text inside a ruled table? -------------
    console.log('\n=== page-segmentation sweep (research only; ocr.ts is not changed) ===');
    for (const name of ['scanned-ruled-simple', 'adv-scanned-sheet']) {
        const sweep = await page.evaluate((n) => window.__m24.psmSweep(n), name);
        writeJson(`psm-${name}.json`, sweep);
        console.log(`  ${name}`);
        for (const run of sweep.runs) {
            const inside = (run.tokens ?? []).filter((t) => t.y0 > 90).length;
            console.log(`    ${String(run.mode).padEnd(16)} psm=${String(run.psm).padStart(2)}  ${String(run.words).padStart(3)} words  ${String(inside).padStart(3)} below the title  conf ${String(run.meanConfidence).padStart(3)}  ${run.ms}ms`);
        }
    }

    console.log(`\n  external HTTP(S) requests during the probe: ${external.length}${external.length ? ` -- ${external.slice(0, 3).join(', ')}` : ''}`);
    console.log(`  page errors: ${pageErrors.length}${pageErrors.length ? ` -- ${pageErrors[0]}` : ''}`);
    exitCode = pageErrors.length === 0 && external.length === 0 ? 0 : 1;
    console.log(`\n  token dumps written to test-fixtures/m2-4/tokens/\n`);
} catch (error) {
    console.error('\n  probe failed:', error?.message ?? error);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
