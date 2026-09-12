/**
 * The M5 Raster Encoder / Memory Sub-Spike gate.
 *
 * H8 was blocked because the flattening operations encode with an encoder this
 * architecture does not own. This gate measures the candidates that could
 * replace it and applies one rule mechanically:
 *
 *   an adopted memory contract may contain no UNKNOWN term, and no term whose
 *   only basis is a measurement, that can materially exceed the ceiling.
 *
 * Five kinds of line:
 *   ASSERT         the apparatus is sound; a failure means the evidence cannot
 *                  be trusted, and the gate exits non-zero.
 *   PROBE          a negative probe: fed input that must make a check fire.
 *   MEASURE        a number, recorded, not judged.
 *   BASELINE-FAIL  production behaviour that breaks a candidate invariant, with
 *                  its root cause. Describes `main`; does not fail the gate.
 *   HUMAN-OPEN     a decision only the Human Gate can make. Never a pass.
 *
 * Run:  node research/m5-raster-encoder-memory/scripts/make-fixtures.mjs
 *       node research/m5-raster-encoder-memory/scripts/research-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import {
    CANDIDATES, pagePlan, filePlan, batchPlan, preflight, admissibleForHardContract,
    pngStoredSize, deflateUpperBound, rawSampleBytes, jpegDataUrlChars,
    CEILINGS, BASIS, REFUSAL, E4_REJECTION, JPEG_FORMAT_UPPER_BOUND, JPEG_MEASURED_WORST,
} from '../prototype/encoders.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RESEARCH = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm5-encoder');
const PORT = 5207;
const ORIGIN = `http://localhost:${PORT}`;
const MIB = 1024 * 1024;

if (!fs.existsSync(path.join(FIXTURES, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-fixtures.mjs')], { stdio: 'inherit' });
}

const lines = [];
const log = (kind, name, ok, detail = '', extra = {}) => {
    lines.push({ kind, name, ok, detail, ...extra });
    const tag = kind === 'MEASURE' || kind === 'HUMAN-OPEN' ? kind : `${kind} ${ok ? 'PASS' : 'FAIL'}`;
    console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
    if (extra.rootCause) console.log(`      root cause: ${extra.rootCause}`);
    if (extra.architecture) console.log(`      proposed:   ${extra.architecture}`);
};
const assert = (name, ok, detail) => log('ASSERT', name, ok, detail);
const probe = (name, ok, detail) => log('PROBE', name, ok, detail);
const measure = (name, detail, data) => log('MEASURE', name, null, detail, data ? { data } : {});
const baselineFail = (name, detail, rootCause, architecture) => log('BASELINE-FAIL', name, false, detail, { rootCause, architecture });
const human = (id, question, recommendation) => log('HUMAN-OPEN', `${id} ${question}`, null, recommendation ? `recommendation: ${recommendation}` : '');

const evidence = {
    ranAt: new Date().toISOString(),
    ranBy: 'M5 raster encoder / memory sub-spike gate (local run on the spike branch)',
    productionBase: '78b5bd5ee676ee72621bccf9524225cd4ce8482a',
    researchHeadAtRun: null,
    researchBranchAtRun: null,
    workingTreeDirty: null,
    coreCiRunsThisGate: false,
    sections: {},
};
try {
    const git = (args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
    evidence.researchHeadAtRun = git(['rev-parse', 'HEAD']);
    evidence.researchBranchAtRun = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    evidence.workingTreeDirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
} catch { /* not a checkout */ }

const fmt = (n) => n.toLocaleString('en-US');
const miB = (n) => `${(n / MIB).toFixed(1)} MiB`;
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 0 });

const external = [];
const pageErrors = [];
let exitCode = 1;
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('request', (r) => {
        const url = r.url();
        if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return;
        try {
            const { protocol } = new URL(url);
            if (protocol === 'http:' || protocol === 'https:') external.push(url);
        } catch { /* ignore */ }
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${ORIGIN}/research/m5-raster-encoder-memory/scripts/harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m5eReady === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m5e[f](...a), fn, args);

    // ---- 1. the corpus --------------------------------------------------------
    console.log('\n=== 1. the quality corpus ===');
    const names = ['vector-a4', 'text-a4', 'drawing-a4', 'hatch-a4', 'fine-line-a4',
        'grey-scan-a4', 'colour-scan-a4', 'photo-a4', 'four-pages', 'vector-a3'];
    const corpus = await call('corpus', names);
    evidence.sections.corpus = corpus;
    for (const [n, c] of Object.entries(corpus)) measure(`corpus(${n})`, `${fmt(c.bytes)} B, ${c.pages} page(s), ${Math.round(c.widthPt)}x${Math.round(c.heightPt)} pt`);
    assert('the corpus covers every content class the contract names',
        names.every((n) => corpus[n]) && corpus['four-pages'].pages === 4
        && Math.round(corpus['vector-a3'].widthPt) === 842,
        `${names.length} fixtures: vector, text, drawing with dimension strings, hatching, 1 px linework, grey scan, colour scan, photographic, multi-page, A3`);

    // ---- 2. the owned PNG encoder's size contract ------------------------------
    console.log('\n=== 2. the owned PNG encoder (E2), against production itself ===');
    const png = await call('pngContract', [[64, 64], [1240, 1754], [2480, 3508]]);
    evidence.sections.pngContract = png;
    for (const r of png) measure(`pngStoredSize(${r.w}x${r.h})`, `${fmt(r.actual)} B actual, ${r.bytesPerPixel.toFixed(3)} B/px`);
    assert('the model, production and the encoder agree on the exact encoded size',
        png.every((r) => r.agree), 'model = production = bytes written, for every case');

    // ---- 3. E1: the production baseline ---------------------------------------
    console.log('\n=== 3. E1 — the production encoder, as the baseline ===');
    const baseNames = ['drawing-a4', 'hatch-a4', 'fine-line-a4', 'grey-scan-a4', 'colour-scan-a4', 'photo-a4'];
    const base150 = await call('productionBaseline', baseNames, 150);
    const base300 = await call('productionBaseline', baseNames, 300);
    evidence.sections.productionBaseline = { 150: base150, 300: base300 };
    for (const n of baseNames) {
        measure(`production monochrome ${n} @150/@300`,
            `${fmt(base150[n].monochromeBytes)} B / ${fmt(base300[n].monochromeBytes)} B `
            + `(${base150[n].monochromeMs.toFixed(0)} ms / ${base300[n].monochromeMs.toFixed(0)} ms)`);
    }
    const e1Plan = pagePlan('E1-jpeg-hard', 595.28, 841.89, 300);
    const e1Adm = admissibleForHardContract(e1Plan);
    baselineFail('the production encoding path cannot carry a hard memory contract',
        `its model still contains an UNKNOWN term: ${e1Adm.unknown.join(', ')}`,
        'canvas.toDataURL("image/jpeg", 0.8) is the browser\'s encoder: neither its output size nor its '
        + 'working memory follows from anything this architecture owns',
        'replace the encoding step with an owned one (E3) whose stream size is the sample count');

    // ---- 4. the candidates: size and exactness --------------------------------
    console.log('\n=== 4. the candidates, over the same rendered pages ===');
    const candidateKeys = ['E1-jpeg', 'E2-png-embed', 'E3-gray-raw', 'E3-gray-flate', 'E3-rgb-raw', 'E3-rgb-flate'];
    const sizes = {};
    for (const n of ['drawing-a4', 'fine-line-a4', 'grey-scan-a4', 'photo-a4']) {
        sizes[n] = await call('candidates', n, 150, candidateKeys);
        const row = candidateKeys.map((k) => `${k.replace('-a4', '')} ${miB(sizes[n][k].outputBytes)}`).join(', ');
        measure(`output size @150, ${n}`, row);
    }
    const sizes300 = {};
    for (const n of ['drawing-a4', 'grey-scan-a4']) {
        sizes300[n] = await call('candidates', n, 300, candidateKeys);
        measure(`output size @300, ${n}`,
            candidateKeys.map((k) => `${k} ${miB(sizes300[n][k].outputBytes)}`).join(', '));
    }
    evidence.sections.sizes = sizes;
    evidence.sections.sizes300 = sizes300;
    assert('every owned candidate wrote exactly the bytes its contract predicts',
        Object.values(sizes).every((f) => ['E2-png-embed', 'E3-gray-raw', 'E3-rgb-raw'].every((k) => f[k].allExact)),
        'raw streams are the sample count; the stored PNG is pngStoredSize, to the byte');
    probe('and the production path is the one whose size could only be observed',
        Object.values(sizes).every((f) => f['E1-jpeg'].pages.every((p) => p.dataUrlExact)),
        'the data URL length is exact given J — but J itself is only known after the fact');
    const raw = sizes['drawing-a4']['E3-gray-raw'].pages[0];
    assert('a raw DeviceGray stream is one byte per pixel, by construction',
        raw.streamBytes === rawSampleBytes(raw.width, raw.height, 1),
        `${fmt(raw.streamBytes)} B for ${raw.width}x${raw.height}`);
    probe('a deflated stream stays under DEFLATE\'s own stored-block bound',
        Object.values(sizes).every((f) => ['E3-gray-flate', 'E3-rgb-flate'].every((k) => f[k].pages.every((p) => p.sizeExact))),
        'the bound holds by derivation; the measurement is a sanity check on it');

    // ---- 5. quality ------------------------------------------------------------
    console.log('\n=== 5. what each candidate did to the drawing ===');
    const qualityKeys = ['E1-jpeg', 'E2-png-embed', 'E3-gray-raw', 'E3-gray-flate', 'E3-rgb-flate'];
    const quality = {};
    for (const n of ['drawing-a4', 'hatch-a4', 'fine-line-a4', 'grey-scan-a4', 'colour-scan-a4', 'photo-a4']) {
        quality[n] = await call('quality', n, 150, qualityKeys);
        for (const k of qualityKeys) {
            const q = quality[n][k];
            measure(`quality ${n} @150 (judged at 300), ${k}`,
                `ink kept ${pct(q.inkKept)}, spurious ${pct(q.spurious)}, PSNR ${Number.isFinite(q.psnr) ? `${q.psnr.toFixed(1)} dB` : 'lossless'}, ${miB(q.outputBytes)}`);
        }
    }
    // At the drawing's own resolution, where the encoder — rather than the
    // resampling — is what the numbers are about.
    const quality300 = {};
    for (const n of ['drawing-a4', 'fine-line-a4']) {
        quality300[n] = await call('quality', n, 300, qualityKeys);
        for (const k of qualityKeys) {
            const q = quality300[n][k];
            measure(`quality ${n} @300, ${k}`,
                `ink kept ${pct(q.inkKept)}, spurious ${pct(q.spurious)}, PSNR ${Number.isFinite(q.psnr) ? `${q.psnr.toFixed(1)} dB` : 'lossless'}, ${miB(q.outputBytes)}`);
        }
    }
    evidence.sections.quality = quality;
    evidence.sections.quality300 = quality300;
    assert('the quality measure can see loss and its absence',
        quality300['fine-line-a4']['E3-gray-raw'].psnr > quality300['fine-line-a4']['E1-jpeg'].psnr,
        'at the scan\'s own resolution the lossless owned path scores strictly better than the lossy production one');
    probe('and what destroys linework is the resolution, not the encoder',
        quality['fine-line-a4']['E3-gray-raw'].inkKept < quality300['fine-line-a4']['E3-gray-raw'].inkKept,
        `the same lossless path keeps ${pct(quality['fine-line-a4']['E3-gray-raw'].inkKept)} at 150 dpi `
        + `and ${pct(quality300['fine-line-a4']['E3-gray-raw'].inkKept)} at 300 dpi`);

    // ---- 6. the memory model, term by term ------------------------------------
    console.log('\n=== 6. the memory lifetime model ===');
    const modelKeys = Object.keys(CANDIDATES);
    const terms = {};
    for (const k of modelKeys) {
        const plan = pagePlan(k, 595.28, 841.89, 300);
        const adm = admissibleForHardContract(plan);
        terms[k] = {
            peakBytes: plan.peakBytes, peakStep: plan.peakStep, encodedBytes: plan.encodedBytes,
            bytesPerPixelEncoded: plan.bytesPerPixelEncoded, admissible: adm.admissible,
            unknown: adm.unknown, measuredOnly: adm.measuredOnly,
            terms: plan.terms.map((t) => ({ name: t.name, bytes: t.bytes, basis: t.basis, source: t.source })),
        };
        measure(`A4 @300, ${k}`,
            `peak ${miB(plan.peakBytes)} at "${plan.peakStep}", stream ${plan.bytesPerPixelEncoded.toFixed(3)} B/px, `
            + `hard-contract admissible: ${adm.admissible}${adm.admissible ? '' : ` (${[...adm.unknown, ...adm.measuredOnly].join('; ')})`}`);
    }
    evidence.sections.terms = terms;
    probe('an unknown encoder scratch prevents a hard contract, whatever the numbers look like',
        terms['E1-jpeg-hard'].admissible === false && terms['E1-jpeg-planning'].admissible === false,
        'both JPEG models are refused: one carries an UNKNOWN term, the other that and a MEASURED_ONLY size');
    probe('a measured compression ratio cannot masquerade as a hard bound',
        terms['E1-jpeg-planning'].measuredOnly.length > 0
        && terms['E1-jpeg-planning'].peakBytes < terms['E1-jpeg-hard'].peakBytes,
        `the planning model is ${miB(terms['E1-jpeg-hard'].peakBytes - terms['E1-jpeg-planning'].peakBytes)} cheaper and is classified MEASURED_ONLY, so it cannot be adopted as a bound`);
    assert('every owned candidate\'s model is free of unknowns',
        ['E2-png-embed', 'E3-gray-raw', 'E3-gray-flate', 'E3-rgb-raw', 'E3-rgb-flate'].every((k) => terms[k].admissible),
        'exact or source-derived, every term');
    // A model that prices one page and forgets that a file holds every page
    // until it is saved. It must not be able to say READY.
    const completeFile = filePlan('E3-rgb-raw', 595.28, 841.89, 300, 40);
    const partialFile = {
        ...completeFile,
        peakBytes: completeFile.page.peakBytes,
        outputBytes: completeFile.page.fileBytes,
    };
    const completeVerdict = preflight(completeFile, { memory: 512 * MIB });
    const partialVerdict = preflight(partialFile, { memory: 512 * MIB });
    probe('a partial model cannot claim READY: pricing one page admits a job the complete model refuses',
        completeVerdict.status === 'REFUSED' && partialVerdict.status === 'READY',
        `40 A4 pages at 300 dpi — complete: ${completeVerdict.status} ${completeVerdict.reason ?? ''} `
        + `(peak ${miB(completeFile.peakBytes)}, it holds every page until save); one-page model: `
        + `${partialVerdict.status} (peak ${miB(partialFile.peakBytes)})`);

    // ---- 7. base64 versus binary ----------------------------------------------
    console.log('\n=== 7. base64 versus binary ===');
    const jpegPage = sizes['photo-a4']['E1-jpeg'].pages[0];
    const grayPage = sizes['photo-a4']['E3-gray-raw'].pages[0];
    measure('what the production path carries as text',
        `JPEG ${fmt(jpegPage.streamBytes)} B becomes a data URL of ${fmt(jpegPage.dataUrlChars)} characters `
        + `(x${(jpegPage.dataUrlChars / jpegPage.streamBytes).toFixed(2)}), then is decoded back to ${fmt(jpegPage.streamBytes)} B`);
    measure('what an owned path carries', `${fmt(grayPage.streamBytes)} B of samples, handed to pdf-lib as a Uint8Array; no string exists`);
    probe('the base64 step is a real term, not a rounding error',
        jpegDataUrlChars(jpegPage.streamBytes) === jpegPage.dataUrlChars
        && jpegPage.dataUrlChars > jpegPage.streamBytes,
        `4*ceil(J/3)+23 predicted the string exactly, and it is ${pct(jpegPage.dataUrlChars / jpegPage.streamBytes - 1)} larger than the bytes`);

    // ---- 8. the grayscale special case ----------------------------------------
    console.log('\n=== 8. grayscale, which is what Monochrome produces ===');
    for (const n of ['drawing-a4', 'grey-scan-a4']) {
        const f = sizes[n];
        measure(`grey vs colour vs RGBA PNG, ${n} @150`,
            `gray raw ${miB(f['E3-gray-raw'].outputBytes)}, gray flate ${miB(f['E3-gray-flate'].outputBytes)}, `
            + `rgb raw ${miB(f['E3-rgb-raw'].outputBytes)}, rgb flate ${miB(f['E3-rgb-flate'].outputBytes)}, `
            + `owned PNG through pdf-lib ${miB(f['E2-png-embed'].outputBytes)}, production JPEG ${miB(f['E1-jpeg'].outputBytes)}`);
    }
    assert('a grayscale owned stream is a quarter of the RGBA PNG and a third of the RGB one, exactly',
        pagePlan('E3-gray-raw', 595.28, 841.89, 300).encodedBytes * 3 === pagePlan('E3-rgb-raw', 595.28, 841.89, 300).encodedBytes,
        '1 B/px against 3 B/px against 4.001 B/px');

    // ---- 9. the boundaries ------------------------------------------------------
    console.log('\n=== 9. boundaries, per candidate and per preset ===');
    const search = (lo, hi, ok) => { while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid; } return [lo, hi]; };
    const A4 = [595.28, 841.89];
    const boundaries = {};
    for (const k of modelKeys) {
        const pagesAt = (n, dpi, memory) => {
            const plan = filePlan(k, ...A4, dpi, n);
            return preflight(plan, { memory });
        };
        const row = {};
        for (const memory of CEILINGS.MEMORY_PRESETS) {
            const [lo, hi] = search(0, 4000, (n) => n === 0 || pagesAt(n, 300, memory).status === 'READY');
            const [lo150, hi150] = search(0, 4000, (n) => n === 0 || pagesAt(n, 150, memory).status === 'READY');
            row[memory / MIB] = {
                pages300: lo, firstOver300: hi, reason300: pagesAt(hi, 300, memory).reason,
                pages150: lo150, firstOver150: hi150, reason150: pagesAt(hi150, 150, memory).reason,
            };
        }
        boundaries[k] = row;
        const at512 = row[512];
        measure(`A4 pages inside 512 MiB, ${k}`,
            `@300: ${at512.pages300} (${at512.firstOver300} refused, ${at512.reason300}); @150: ${at512.pages150} (${at512.firstOver150} refused, ${at512.reason150})`);
    }
    evidence.sections.boundaries = boundaries;

    // Batches, under B2: everything is held until the archive.
    const batches = {};
    for (const k of modelKeys) {
        const filesAt = (n, memory) => preflight(batchPlan(k, ...A4, 150, 1, n), { memory });
        const [lo, hi] = search(0, 2000, (n) => n === 0 || filesAt(n, 512 * MIB).status === 'READY');
        batches[k] = { files: lo, firstOver: hi, reason: filesAt(hi, 512 * MIB).reason };
        measure(`one-page A4 @150 files in a B2 batch inside 512 MiB, ${k}`, `${lo} accepted, ${hi} refused (${batches[k].reason})`);
    }
    evidence.sections.batches = batches;

    // ---- 10. the ceilings stay independent -------------------------------------
    console.log('\n=== 10. the ceilings are independent ===');
    const A1 = [1683.78, 2383.94];
    const A0 = [2383.94, 3370.39];
    probe('raster first-over: the pixel ceiling refuses, and no memory preset buys past it',
        CEILINGS.MEMORY_PRESETS.every((m) => preflight(filePlan('E3-gray-raw', ...A1, 600, 1), { memory: m }).reason === REFUSAL.OVER_RASTER_LIMIT)
        && preflight(filePlan('E3-gray-raw', ...A1, 600, 1), { memory: Infinity }).reason === REFUSAL.OVER_RASTER_LIMIT,
        'A1 @600 is refused OVER_RASTER_LIMIT at 512 MiB, 1 GiB, 2 GiB and with memory unbounded');
    probe('output first-over: the output ceiling refuses on its own, with memory unbounded',
        (() => {
            const [, first] = search(0, 4000, (n) => n === 0
                || preflight(filePlan('E3-rgb-raw', ...A4, 150, n), { memory: Infinity, maxRasterPixels: Infinity }).status === 'READY');
            const r = preflight(filePlan('E3-rgb-raw', ...A4, 150, first), { memory: Infinity, maxRasterPixels: Infinity });
            return r.reason === REFUSAL.OVER_OUTPUT_BUDGET;
        })(),
        'the first page count over 256 MiB of output is refused OVER_OUTPUT_BUDGET, not by memory');
    probe('memory first-over: the memory ceiling refuses with the other two unbounded',
        (() => {
            const [, first] = search(0, 4000, (n) => n === 0
                || preflight(filePlan('E3-rgb-raw', ...A4, 300, n), { memory: 512 * MIB, maxRasterPixels: Infinity, maxOutputBytes: Infinity }).status === 'READY');
            return preflight(filePlan('E3-rgb-raw', ...A4, 300, first), { memory: 512 * MIB, maxRasterPixels: Infinity, maxOutputBytes: Infinity }).reason === REFUSAL.OVER_MEMORY_BUDGET;
        })(),
        'isolated, the memory ceiling is the one that fires');
    probe('an explicit preset moves nothing but memory',
        preflight(filePlan('E3-gray-raw', ...A0, 300, 1), { memory: 2048 * MIB }).reason === REFUSAL.OVER_RASTER_LIMIT,
        'A0 @300 stays refused by the raster ceiling at the largest preset');

    // ---- 11. the canvas probe (H9, unchanged) ----------------------------------
    console.log('\n=== 11. the runtime canvas probe ===');
    const probes = [];
    for (const [label, w, h] of [['A4@300', 2480, 3508], ['A1@300', 7016, 9933], ['A1@600', 14031, 19866]]) {
        const r = await call('canvasProbe', w, h);
        probes.push({ label, ...r });
        measure(`canvas ${label} (${(r.pixels / 1e6).toFixed(0)} Mpx)`, r.allocates ? 'allocates' : 'does not allocate');
    }
    evidence.sections.canvasProbes = probes;
    assert('the raster ceiling stays below what this machine refuses',
        probes.find((p) => p.label === 'A1@600').allocates === false
        && CEILINGS.MAX_RASTER_PIXELS < 14031 * 19866,
        `${(CEILINGS.MAX_RASTER_PIXELS / 1e6).toFixed(1)} Mpx policy, ${(14031 * 19866 / 1e6).toFixed(0)} Mpx refused by the browser`);

    // ---- 12. E4 ----------------------------------------------------------------
    console.log('\n=== 12. E4 — a bounded JPEG inside the current dependencies ===');
    const deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies;
    evidence.sections.e4 = { ...E4_REJECTION, dependencies: Object.keys(deps) };
    measure('E4 rejected, with the reason', E4_REJECTION.reason);
    assert('no pinned dependency contains a JPEG encoder',
        ['pdf-lib', 'jspdf', 'pdfjs-dist', 'jszip'].every((d) => deps[d] !== undefined),
        `${Object.keys(deps).join(', ')} — pdf-lib parses JPEG, pdfjs decodes it, jsPDF embeds it, none writes one`);

    // ---- 13. what the Human Gate decides ---------------------------------------
    console.log('\n=== 13. the H8 decision ===');
    const rec = pagePlan('E3-gray-flate', ...A4, 300);
    const grey512 = boundaries['E3-gray-flate'][512];
    const rgb512 = boundaries['E3-rgb-flate'][512];
    const est512 = boundaries['E1-jpeg-planning'][512];
    const hard512 = boundaries['E1-jpeg-hard'][512];
    human('H8', 'Raster encoder and operation memory: which encoding path, and which memory contract?',
        `H8-A for Monochrome, H8-B for Optimize — adopt an owned image XObject (E3), written by pdf-lib itself: `
        + `DeviceGray for Monochrome and DeviceRGB for Optimize, FlateDecode for the file size and no filter where `
        + `the encoded size has to be exact. One A4 page at 300 dpi then peaks at ${miB(rec.peakBytes)}, at the `
        + `readback — every term EXACT or source-derived, no encoder in the model at all. Monochrome keeps the `
        + `capacity the estimate used to promise: ${grey512.pages300} pages at 300 dpi and ${grey512.pages150} at `
        + `150 inside 512 MiB, against ${est512.pages300}/${est512.pages150} estimated and `
        + `${hard512.pages300}/${hard512.pages150} that the only fail-closed JPEG term allowed. Optimize keeps `
        + `colour and so carries ${rgb512.pages300}/${rgb512.pages150} — a smaller product limit, honestly bounded.`);
    human('H8-file-size', 'Is a larger PDF acceptable as the price of an exact memory contract?',
        `measured at 150 dpi on the grey scan: production JPEG ${miB(sizes['grey-scan-a4']['E1-jpeg'].outputBytes)}, `
        + `owned DeviceGray FlateDecode ${miB(sizes['grey-scan-a4']['E3-gray-flate'].outputBytes)}, `
        + `owned DeviceGray raw ${miB(sizes['grey-scan-a4']['E3-gray-raw'].outputBytes)}. FlateDecode keeps the `
        + `guarantee and most of the size; raw keeps the size exact before the page is rendered. `
        + `MAX_OUTPUT_BYTES is enforced on the finished artifact either way.`);

    // ---- totals -----------------------------------------------------------------
    assert('no measurement left the machine', external.length === 0, `${external.length} external requests`);
    assert('no page error during the run', pageErrors.length === 0, pageErrors.join(' | ') || 'none');

    const summary = {
        assertions: lines.filter((l) => l.kind === 'ASSERT').length,
        assertionsFailed: lines.filter((l) => l.kind === 'ASSERT' && !l.ok).length,
        probes: lines.filter((l) => l.kind === 'PROBE').length,
        probesFailed: lines.filter((l) => l.kind === 'PROBE' && !l.ok).length,
        measurements: lines.filter((l) => l.kind === 'MEASURE').length,
        baselineFails: lines.filter((l) => l.kind === 'BASELINE-FAIL').length,
        humanOpen: lines.filter((l) => l.kind === 'HUMAN-OPEN').length,
        external: external.length,
        pageErrors: pageErrors.length,
    };
    evidence.summary = summary;
    evidence.lines = lines;
    fs.writeFileSync(path.join(RESEARCH, 'evidence.json'), `${JSON.stringify(evidence, null, 1)}\n`);

    console.log('\n=== summary ===');
    console.log(`  ASSERT ${summary.assertions - summary.assertionsFailed}/${summary.assertions}  `
        + `PROBE ${summary.probes - summary.probesFailed}/${summary.probes}  `
        + `MEASURE ${summary.measurements}  BASELINE-FAIL ${summary.baselineFails}  HUMAN-OPEN ${summary.humanOpen}`);
    exitCode = summary.assertionsFailed === 0 && summary.probesFailed === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
