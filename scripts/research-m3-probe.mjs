/**
 * Measure the four save candidates against the synthetic corpus.
 *
 * Research only. This writes JSON into test-fixtures/m3/results/ for the gate
 * and the write-up to assert against; it decides nothing on its own.
 *
 * Run:  node scripts/research-m3-fixtures.mjs
 *       node scripts/research-m3-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm3');
const OUT = path.join(FIX, 'results');
const PORT = 5194;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIX, 'native.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'research-m3-fixtures.mjs')], { stdio: 'inherit' });
}
fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
page.on('requestfinished', (req) => {
    const url = req.url();
    if (!url.startsWith(ORIGIN) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

const CANDIDATES = ['baseline', 'overlay', 'vector', 'hybrid'];
let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/research-m3-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m3Ready === true, { timeout: 180000 });

    // ---- what the corpus is ------------------------------------------------
    console.log('=== the corpus, before anything touches it ===');
    const fixtures = ['native', 'rotated', 'boxes', 'features', 'scanned', 'a0'];
    const before = {};
    for (const name of fixtures) {
        before[name] = await page.evaluate((n) => window.__m3.before(n), name);
        const b = before[name];
        console.log(`  ${name.padEnd(9)} ${b.pageCount} page(s)  `
            + `chars ${b.pages.reduce((s, p) => s + p.charCount, 0)}  `
            + `paths ${b.pages.reduce((s, p) => s + p.pathOps, 0)}  `
            + `images ${b.pages.reduce((s, p) => s + p.imageOps, 0)}  `
            + `annots ${b.pages.reduce((s, p) => s + p.annotationCount, 0)}  `
            + `form ${b.form.fields.length}`);
    }
    write('before.json', before);

    // ---- the preservation matrix -------------------------------------------
    console.log('\n=== what survives a save ===');
    const matrix = {};
    for (const name of fixtures) {
        matrix[name] = {};
        for (const candidate of CANDIDATES) {
            const bare = name === 'native' ? [3] : [];
            const result = await page.evaluate(
                (n, c, b) => window.__m3.save(n, c, { bare: b }), name, candidate, bare,
            );
            matrix[name][candidate] = result;
            if (result.failed) {
                console.log(`  ${name.padEnd(9)} ${candidate.padEnd(9)} REFUSED  ${result.message}`);
                continue;
            }
            // The worst verdict any page got -- but "not applicable" is not a
            // verdict, it is the absence of one, so a page that had nothing to
            // preserve must not outrank a page that lost something or mask a
            // page that kept it.
            const worst = (key) => {
                const order = ['lost', 'changed', 'preserved'];
                const real = result.perPage.map((p) => p[key]).filter((v) => order.includes(v));
                if (real.length === 0) return 'not applicable';
                return real.sort((a, b2) => order.indexOf(a) - order.indexOf(b2))[0];
            };
            console.log(`  ${name.padEnd(9)} ${candidate.padEnd(9)}`
                + ` text ${worst('sourceText').padEnd(15)}`
                + ` vector ${worst('vector').padEnd(15)}`
                + ` rotate ${worst('rotation').padEnd(15)}`
                + ` crop ${worst('cropBox').padEnd(15)}`
                + ` ${(result.bytes / 1024).toFixed(0)}KB ${result.ms}ms`);
        }
    }
    write('matrix.json', matrix);

    // ---- saving nothing ------------------------------------------------------
    console.log('\n=== saving with no annotations at all ===');
    const noop = {};
    for (const candidate of CANDIDATES) {
        noop[candidate] = await page.evaluate((c) => window.__m3.noop('native', c), candidate);
        const r = noop[candidate];
        console.log(`  ${candidate.padEnd(9)} pages ${r.pageCount.before}->${r.pageCount.after}`
            + `  chars ${r.chars.before}->${r.chars.after}`
            + `  paths ${r.pathOps.before}->${r.pathOps.after}`
            + `  bytes ${r.bytes.before}->${r.bytes.after}`
            + `  byte-identical ${r.byteIdentical}`);
    }
    write('noop.json', noop);

    // ---- coordinates ---------------------------------------------------------
    console.log('\n=== zoom ===');
    const zoom = await page.evaluate(() => window.__m3.zoomInvariance());
    for (const r of zoom.results) {
        console.log(`  zoom ${String(r.scale).padStart(4)}x  stored (${r.stored.x}, ${r.stored.y})`
            + `  pdf (${r.pdf.x}, ${r.pdf.y})  4px pen = ${r.widthPoints}pt`);
    }
    console.log(`  every zoom gives the same PDF coordinate: ${zoom.allIdentical}`);
    console.log(`  and the same line width: ${zoom.widthsIdentical}`);
    write('zoom.json', zoom);

    console.log('\n=== rotation ===');
    const rotation = await page.evaluate(() => window.__m3.rotationMapping());
    for (const r of rotation) {
        console.log(`  /Rotate ${String(r.rotate).padStart(3)}  display ${r.displayWidth}x${r.displayHeight}`
            + `  upright (${r.upright.x}, ${r.upright.y})  pdf (${r.pdf.x}, ${r.pdf.y})`
            + `  round-trips ${r.roundTrips}  on the page ${r.insidePage}`);
    }
    write('rotation.json', rotation);

    console.log('\n=== page boxes ===');
    const crop = await page.evaluate(() => window.__m3.cropBoxMapping());
    for (const c of crop) {
        console.log(`  page ${c.page}  crop ${c.cropBox.x},${c.cropBox.y} ${c.cropBox.width}x${c.cropBox.height}`
            + `  getSize ${c.reportedSize.width}x${c.reportedSize.height}`
            + `  correct (${c.correct.x}, ${c.correct.y})  naive (${c.naive.x}, ${c.naive.y})`
            + `${c.differs ? `  OFF BY (${c.offBy.x}, ${c.offBy.y})` : ''}`);
    }
    write('cropbox.json', crop);

    // ---- the largest sheet ---------------------------------------------------
    console.log('\n=== A0 ===');
    const a0 = await page.evaluate(() => window.__m3.a0Cost());
    console.log(`  a full-page raster at 2x would be ${(a0.fullPageAt2x.pixels / 1e6).toFixed(1)} Mpx`
        + ` = ${(a0.fullPageAt2x.rgbaBytes / 1e6).toFixed(0)} MB of RGBA`);
    for (const candidate of CANDIDATES) {
        const r = a0[candidate];
        if (r.failed) { console.log(`  ${candidate.padEnd(9)} REFUSED  ${r.failed}`); continue; }
        console.log(`  ${candidate.padEnd(9)} max raster ${(r.maxPixels / 1e6).toFixed(2)} Mpx`
            + ` (${(r.rgbaBytes / 1e6).toFixed(1)} MB)  output ${(r.outputBytes / 1024).toFixed(0)} KB  ${r.ms}ms`);
    }
    write('a0.json', a0);

    // ---- hybrid split --------------------------------------------------------
    console.log('\n=== what the hybrid sends where ===');
    const split = await page.evaluate(() => window.__m3.hybridSplit());
    console.log(`  operators: ${split.vector.join(', ')}`);
    console.log(`  pixels:    ${split.raster.join(', ') || 'none'}`);
    console.log(`  refused by the vector-only candidate: ${split.unsupportedForVector.join(', ') || 'none'}`);
    for (const l of split.labels) console.log(`  ${l.id} labels: ${l.labels.join(' | ')}`);
    write('hybrid-split.json', split);

    // ---- fidelity ------------------------------------------------------------
    console.log('\n=== how closely each candidate matches what the user saw ===');
    const fidelity = {};
    for (const candidate of CANDIDATES) {
        fidelity[candidate] = await page.evaluate((c) => window.__m3.fidelity(c), candidate);
        const f = fidelity[candidate];
        if (f.failed) { console.log(`  ${candidate.padEnd(9)} REFUSED  ${f.failed}`); continue; }
        const worst = Object.entries(f.perTool)
            .sort((a, b) => b[1].differingFraction - a[1].differingFraction)[0];
        console.log(`  ${candidate.padEnd(9)} whole page ${(f.whole.differingFraction * 100).toFixed(2)}% differing`
            + `  worst tool: ${worst[0]} ${(worst[1].differingFraction * 100).toFixed(1)}%`);
    }
    for (const candidate of CANDIDATES) {
        const f = fidelity[candidate];
        if (f.failed) continue;
        console.log(`\n  ${candidate} by tool (% of pixels differing):`);
        for (const [id, r] of Object.entries(f.perTool)) {
            console.log(`    ${id.padEnd(22)} ${(r.differingFraction * 100).toFixed(1).padStart(6)}%`);
        }
    }
    write('fidelity.json', fidelity);

    // ---- determinism ---------------------------------------------------------
    console.log('\n=== the same input, twice ===');
    const determinism = {};
    for (const candidate of CANDIDATES) {
        determinism[candidate] = await page.evaluate((c) => window.__m3.determinism(c), candidate);
        const d = determinism[candidate];
        if (d.refused) { console.log(`  ${candidate.padEnd(9)} REFUSED  ${d.refused}`); continue; }
        console.log(`  ${candidate.padEnd(9)} same bytes ${String(d.byteIdentical).padEnd(6)}`
            + `  same content ${d.semanticallyIdentical}`);
    }
    write('determinism.json', determinism);

    // ---- failure behaviour ---------------------------------------------------
    console.log('\n=== what happens when a save cannot do what it was asked ===');
    const failure = await page.evaluate(() => window.__m3.failureBehaviour());
    console.log(`  vector, with a pixel eraser: ${failure.withEraser.refused ?? `PRODUCED ${failure.withEraser.produced} BYTES`}`);
    for (const r of failure.withEraser.reasons ?? []) console.log(`    ${r.id}: ${r.reason}`);
    console.log(`  vector, without one: produced ${failure.withoutEraser.produced} bytes, ${failure.withoutEraser.ops} operators`);
    console.log(`  a NaN coordinate: ${failure.nanCoordinate.refused ?? `produced ${failure.nanCoordinate.produced} bytes, ${failure.nanCoordinate.pathOps} path ops`}`);
    write('failure.json', failure);

    // ---- network -------------------------------------------------------------
    console.log('\n=== network ===');
    console.log(`  external requests from the research harness: ${external.length}`);
    for (const url of external.slice(0, 5)) console.log(`    ${url}`);
    console.log(`  page errors: ${pageErrors.length}`);
    write('network.json', { external, pageErrors });

    exitCode = 0;
} catch (error) {
    console.error(`\nFAILED: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}

console.log(`\n  results written to test-fixtures/m3/results/\n`);
process.exit(exitCode);
