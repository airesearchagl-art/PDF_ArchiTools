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
    const fixtures = ['native', 'rotated', 'boxes', 'croprot', 'features', 'scanned', 'a0'];
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

    console.log('\n=== what a substituted font actually costs ===');
    const placement = await page.evaluate(() => window.__m3.textPlacement('hybrid'));
    if (placement.failed) {
        console.log(`  REFUSED  ${placement.failed}`);
    } else {
        console.log('    object                  as placed   best shift   at that shift');
        for (const [id, r] of Object.entries(placement.out)) {
            console.log(`    ${id.padEnd(22)} ${(r.atZero * 100).toFixed(1).padStart(6)}%`
                + `   ${String(r.bestOffsetPoints).padStart(5)}pt`
                + `   ${(r.best * 100).toFixed(1).padStart(6)}%`);
        }
    }
    write('text-placement.json', placement);

    // ---- RF-1: does a mark end up where the user put it? ---------------------
    console.log('\n=== a mark placed where the user sees it, saved and reopened ===');
    const markers = {};
    for (const fixture of ['rotated', 'croprot']) {
        markers[fixture] = {};
        for (const candidate of ['overlay', 'hybrid', 'baseline']) {
            const result = await page.evaluate(
                (fx, c) => window.__m3.markerRoundTrip(fx, c), fixture, candidate,
            );
            markers[fixture][candidate] = result;
            if (result.failed) {
                console.log(`  ${fixture.padEnd(8)} ${candidate.padEnd(9)} REFUSED  ${result.failed}`);
                continue;
            }
            const lost = result.pages.filter((p) => p.found === null).length;
            const resized = result.pages.some((p) => p.pageSize.width > 1000);
            console.log(`  ${fixture.padEnd(8)} ${candidate.padEnd(9)}`
                + ` ${result.pages.map((p) => `r${p.rotate}:${p.found ? `${p.error.toFixed(1)}pt` : 'NOT FOUND'}`).join('  ')}`
                + `${lost ? `  (${lost} not found)` : ''}`
                // The baseline rewrites the page in capture pixels, so its
                // numbers are in a different unit system and are not comparable
                // as point errors. Said, rather than quietly tabulated.
                + `${resized ? `  [page rewritten to ${result.pages[0].pageSize.width}x${result.pages[0].pageSize.height}; not point-comparable]` : ''}`);
        }
    }
    write('markers.json', markers);

    // ---- RF-2: painter order -------------------------------------------------
    console.log('\n=== does the saved layer stack the way the canvas does? ===');
    const ordered = {};
    for (const candidate of ['overlay', 'hybrid']) {
        ordered[candidate] = await page.evaluate((c) => window.__m3.orderedComposition(c), candidate);
        console.log(`\n  ${candidate}:`);
        for (const [label, r] of Object.entries(ordered[candidate].results)) {
            if (r.failed) { console.log(`    ${label.padEnd(36)} REFUSED  ${r.failed}`); continue; }
            console.log(`    ${label.padEnd(36)} ${(r.differingFraction * 100).toFixed(2).padStart(6)}% differing`
                + `   ${r.runs.join(' -> ')}`);
        }
    }
    write('ordered.json', ordered);

    // ---- annotations a save must refuse --------------------------------------
    console.log('\n=== annotations a save must refuse, not skip ===');
    const pre = await page.evaluate(() => window.__m3.preflightCases());
    for (const [label, r] of Object.entries(pre)) {
        const verdicts = ['overlay', 'vector', 'hybrid']
            .map((c) => `${c}:${r.results[c].refused ? 'refused' : `${r.results[c].produced}B`}`)
            .join('  ');
        console.log(`  ${label.padEnd(26)} ${String(r.problems.length).padStart(2)} problem(s)   ${verdicts}`);
    }
    write('preflight.json', pre);

    console.log('\n=== a character the embedded font cannot draw ===');
    const glyph = await page.evaluate(() => window.__m3.glyphCoverage());
    console.log(`  missing glyphs: ${glyph.missing.join(' ') || 'none'}`);
    for (const c of ['vector', 'hybrid']) {
        const r = glyph[c];
        console.log(`  ${c.padEnd(9)} ${r.refused ? `refused  ${r.refused.slice(0, 70)}` : `produced ${r.produced}B, rastered ${r.rasteredForGlyphs.join(',') || 'nothing'}, text extractable ${r.textExtracted}`}`);
    }
    write('glyphs.json', glyph);

    console.log('\n=== how large a raster fragment may be ===');
    const budget = await page.evaluate(() => window.__m3.rasterBudget());
    console.log(`  limit: ${(budget.limit / 1e6).toFixed(1)} Mpx (${(budget.limit * 4 / 1e6).toFixed(0)} MB of RGBA)`);
    console.log('    span                 predicted    RGBA      result');
    for (const r of budget.rows) {
        const outcome = r.refused
            ? `refused (${r.budget ? `${(r.budget.pixels / 1e6).toFixed(1)} Mpx needed` : 'no budget'})`
            : `${(r.maxPixels / 1e6).toFixed(2)} Mpx, ${(r.produced / 1024).toFixed(0)} KB, ${r.ms}ms`;
        console.log(`    ${r.label.padEnd(20)} ${(r.predictedPixels / 1e6).toFixed(2).padStart(6)} Mpx`
            + ` ${(r.predictedRgbaBytes / 1e6).toFixed(0).padStart(5)} MB   ${outcome}`);
    }
    console.log(`  just under the limit: ${budget.edges.justUnder}`);
    console.log(`  just over the limit:  ${budget.edges.justOver}`);
    write('raster-budget.json', budget);

    // ---- RF-4: which documents this will not write ---------------------------
    console.log('\n=== documents this design refuses ===');
    const boundary = await page.evaluate(() => window.__m3.supportBoundary());
    for (const [name, r] of Object.entries(boundary)) {
        console.log(`  ${name.padEnd(9)} supported=${String(r.supported).padEnd(6)}`
            + ` ${r.problems.map((p) => p.code).join(', ') || '-'}`
            + `  save: ${r.save.refused ? `refused (${r.save.refused.slice(0, 40)}...)` : `produced ${r.save.produced} bytes`}`);
    }
    write('boundary.json', boundary);

    // ---- the source file is not touched --------------------------------------
    console.log('\n=== the bytes the candidate was handed ===');
    for (const candidate of CANDIDATES) {
        const perFixture = fixtures
            .map((fx) => ({ fx, unchanged: matrix[fx][candidate]?.sourceUnchanged }))
            .filter((r) => r.unchanged !== undefined);
        const allUnchanged = perFixture.every((r) => r.unchanged === true);
        console.log(`  ${candidate.padEnd(9)} unchanged on ${perFixture.filter((r) => r.unchanged).length}`
            + `/${perFixture.length} fixtures  (byte-for-byte)`);
        void allUnchanged;
    }

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
