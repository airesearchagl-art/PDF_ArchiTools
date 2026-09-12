/**
 * The M5 Raster Encoder / Memory Sub-Spike gate.
 *
 * H8 was blocked because the flattening operations encode with an encoder this
 * architecture does not own. This gate measures the candidates that could
 * replace it, prices each one's whole lifetime from pinned sources, and applies
 * one rule mechanically:
 *
 *   an adopted memory contract may contain no UNKNOWN term, and no term whose
 *   only basis is a measurement.
 *
 * Five kinds of line: ASSERT and PROBE are the apparatus (a failure exits
 * non-zero), MEASURE records, BASELINE-FAIL describes production, HUMAN-OPEN is
 * never a pass.
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
    CANDIDATES, pagePlan, filePlan, batchPlan, naiveBatchPlan, preflight, admissibleForHardContract,
    deflateUpperBound, pakoDeflateTerms, rawSampleBytes, ORDERING,
    CEILINGS, REFUSAL, PAKO, PAKO_STATE_BYTES,
} from '../prototype/encoders.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RESEARCH = path.resolve(HERE, '..');
const RESEARCH_REL = 'research/m5-raster-encoder-memory';
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

/**
 * Provenance, bound to committed source.
 *
 * Dirtiness is computed over the research package **including untracked
 * files** — an uncommitted new prototype is exactly the case the old check
 * missed, because it excluded untracked files and so called a tree clean that
 * contained the whole spike.
 */
const evidence = {
    ranAt: new Date().toISOString(),
    ranBy: 'M5 raster encoder / memory sub-spike gate (local run on the spike branch)',
    productionBase: '78b5bd5ee676ee72621bccf9524225cd4ce8482a',
    testedResearchHead: null,
    researchBranchAtRun: null,
    workingTreeDirty: null,
    dirtinessScope: `${RESEARCH_REL}, untracked files included`,
    dirtyPaths: [],
    coreCiRunsThisGate: false,
    sections: {},
};
try {
    const git = (args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
    evidence.testedResearchHead = git(['rev-parse', 'HEAD']);
    evidence.researchBranchAtRun = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = git(['status', '--porcelain', '--', RESEARCH_REL]);
    // Everything in the package counts, untracked files included — an
    // uncommitted prototype is exactly the case that must make a run dirty.
    // The one exclusion is this gate's own output: `evidence.json` is written
    // at the end of every run and committed afterwards as an evidence-only
    // child commit, so counting it would make the second of two consecutive
    // runs dirty by construction and no run could ever be clean.
    evidence.dirtyPaths = (status ? status.split('\n') : [])
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.endsWith(`${RESEARCH_REL}/evidence.json`));
    evidence.workingTreeDirty = evidence.dirtyPaths.length > 0;
} catch { /* not a checkout */ }

const fmt = (n) => n.toLocaleString('en-US');
const miB = (n) => `${(n / MIB).toFixed(1)} MiB`;
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const search = (lo, hi, ok) => { while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid; } return [lo, hi]; };

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
    await page.goto(`${ORIGIN}/${RESEARCH_REL}/scripts/harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m5eReady === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m5e[f](...a), fn, args);

    const A4 = [595.28, 841.89];
    const A1 = [1683.78, 2383.94];
    const A0 = [2383.94, 3370.39];

    // ---- 1. the corpus --------------------------------------------------------
    console.log('\n=== 1. the quality corpus ===');
    const names = ['vector-a4', 'text-a4', 'drawing-a4', 'hatch-a4', 'fine-line-a4',
        'grey-scan-a4', 'colour-scan-a4', 'photo-a4', 'four-pages', 'vector-a3'];
    const corpus = await call('corpus', names);
    evidence.sections.corpus = corpus;
    for (const [n, c] of Object.entries(corpus)) measure(`corpus(${n})`, `${fmt(c.bytes)} B, ${c.pages} page(s), ${Math.round(c.widthPt)}x${Math.round(c.heightPt)} pt`);
    assert('the corpus covers every content class the contract names',
        names.every((n) => corpus[n]) && corpus['four-pages'].pages === 4 && Math.round(corpus['vector-a3'].widthPt) === 842,
        `${names.length} fixtures: vector, text, drawing with dimension strings, hatching, 1 px linework, grey scan, colour scan, photographic, multi-page, A3`);

    // ---- 2. the owned PNG encoder's size contract ------------------------------
    console.log('\n=== 2. the owned PNG encoder (E2), against production itself ===');
    const png = await call('pngContract', [[64, 64], [1240, 1754], [2480, 3508]]);
    evidence.sections.pngContract = png;
    for (const r of png) measure(`pngStoredSize(${r.w}x${r.h})`, `${fmt(r.actual)} B actual, ${r.bytesPerPixel.toFixed(3)} B/px`);
    assert('the model, production and the encoder agree on the exact encoded size', png.every((r) => r.agree),
        'model = production = bytes written, for every case');

    // ---- 3. E1, the production baseline ---------------------------------------
    console.log('\n=== 3. E1 — the production encoder, as the baseline ===');
    const baseNames = ['drawing-a4', 'hatch-a4', 'fine-line-a4', 'grey-scan-a4', 'colour-scan-a4', 'photo-a4'];
    const base150 = await call('productionBaseline', baseNames, 150);
    const base300 = await call('productionBaseline', baseNames, 300);
    evidence.sections.productionBaseline = { 150: base150, 300: base300 };
    for (const n of baseNames) {
        measure(`production monochrome ${n} @150/@300`,
            `${fmt(base150[n].monochromeBytes)} B / ${fmt(base300[n].monochromeBytes)} B`);
    }
    const e1Adm = admissibleForHardContract(pagePlan('E1-jpeg-hard', ...A4, 300));
    baselineFail('the production encoding path cannot carry a hard memory contract',
        `its model still contains an UNKNOWN term: ${e1Adm.unknown.join(', ')}`,
        'canvas.toDataURL("image/jpeg", 0.8) is the browser\'s encoder: neither its output size nor its working memory follows from anything this architecture owns',
        'replace the encoding step with an owned one (E3) whose stream size is the sample count');

    // ---- 4. RF-M1A: the ordering, measured -------------------------------------
    console.log('\n=== 4. what is actually live while the samples are made (RF-M1A) ===');
    const ord = await call('orderings', 'drawing-a4', 300, 'DeviceRGB', 'none');
    evidence.sections.orderings = ord;
    for (const [k, v] of Object.entries(ord)) {
        measure(`conversion live set, ${k}`,
            `${miB(v.convertLiveBytes)} = ${v.convertLiveBytesPerPixel.toFixed(1)} B/px `
            + `(canvas released first: ${v.canvasReleasedBeforeConvert})`);
    }
    const held = ord[ORDERING.HELD];
    const released = ord[ORDERING.RELEASED];
    assert('the released ordering really does drop the canvas before converting',
        released.canvasReleasedBeforeConvert === true && held.canvasReleasedBeforeConvert === false,
        'measured on the prototype, not assumed');
    assert('the model matches the code, in both orderings',
        pagePlan('E3-rgb-raw', ...A4, 300, ORDERING.HELD).steps.convert === held.convertLiveBytes
        && pagePlan('E3-rgb-raw', ...A4, 300, ORDERING.RELEASED).steps.convert === released.convertLiveBytes,
        `held ${fmt(held.convertLiveBytes)} B, released ${fmt(released.convertLiveBytes)} B — both predicted exactly`);
    probe('the first round\'s model fails against the ordering the first round\'s code performed',
        held.convertLiveBytesPerPixel > 8 && released.convertLiveBytesPerPixel <= 8,
        `holding the canvas costs ${held.convertLiveBytesPerPixel.toFixed(1)} B/px at conversion, not the 8 B/px the readback alone suggests`);
    measure('what the restructuring is worth, A4 @300 DeviceRGB',
        `${miB(pagePlan('E3-rgb-raw', ...A4, 300, ORDERING.HELD).peakBytes)} held vs `
        + `${miB(pagePlan('E3-rgb-raw', ...A4, 300, ORDERING.RELEASED).peakBytes)} released`);

    // ---- 5. RF-M1B/E: what the PDF object actually carries ----------------------
    console.log('\n=== 5. the stream, read from the object (RF-M1B, RF-M1E) ===');
    const streams = await call('streamSizes', 1240, 1754);
    evidence.sections.streams = streams;
    for (const r of streams) {
        measure(`${r.colourSpace} ${r.content} ${r.filter}`,
            `samples ${fmt(r.sampleBytes)} B, stored ${fmt(r.storedBytes)} B (x${r.ratio.toFixed(3)}), bound ${fmt(r.modelBound)} B`);
    }
    const raws = streams.filter((r) => r.filter === 'none');
    const flates = streams.filter((r) => r.filter === 'flate');
    assert('a raw stream is the samples, and pdf-lib keeps the very array it was handed',
        raws.every((r) => r.storedBytes === r.sampleBytes && r.sameArray === true),
        'context.stream: typedArrayFor returns a Uint8Array unchanged (arrays.js:9-11), PDFRawStream assigns it (PDFRawStream.js:10)');
    assert('every deflated stream is under the pako-derived bound',
        flates.every((r) => r.storedBytes <= r.modelBound),
        `bound = n + 5*ceil(n/${fmt(PAKO.litBufsize)}) + 6, from pako 1.0.11's own block lifecycle`);
    const noisyFlate = flates.filter((r) => r.content === 'noise');
    probe('the measurement is of the compressed stream, not of the samples: a substitution would be caught',
        noisyFlate.every((r) => r.storedBytes !== r.sampleBytes)
        && flates.some((r) => r.content === 'uniform' && r.storedBytes < r.sampleBytes / 100),
        `noise deflates to x${noisyFlate[0].ratio.toFixed(3)} and uniform to x${flates.find((r) => r.content === 'uniform').ratio.toFixed(4)} — `
        + 'a check that read samples.length would report the same number for both');
    probe('and incompressible content stays inside the bound rather than merely inside the samples',
        noisyFlate.every((r) => r.storedBytes > r.sampleBytes && r.storedBytes <= r.modelBound),
        `noise expands to ${fmt(noisyFlate[0].storedBytes)} B from ${fmt(noisyFlate[0].sampleBytes)} B, under ${fmt(noisyFlate[0].modelBound)} B`);
    measure('the pako state every deflate allocates, whatever the input',
        `${fmt(PAKO_STATE_BYTES)} B = window ${fmt(PAKO.windowBytes)} + head ${fmt(PAKO.headBytes)} + prev ${fmt(PAKO.prevBytes)} + pending_buf ${fmt(PAKO.pendingBufBytes)}`);

    // ---- 6. candidates, end to end ---------------------------------------------
    console.log('\n=== 6. the candidates over the same rendered pages ===');
    const candidateKeys = ['E1-jpeg', 'E2-png-embed', 'E3-gray-raw', 'E3-gray-flate', 'E3-rgb-raw', 'E3-rgb-flate'];
    const sizes = {};
    for (const n of ['drawing-a4', 'fine-line-a4', 'grey-scan-a4', 'photo-a4']) {
        sizes[n] = await call('candidates', n, 150, candidateKeys);
        measure(`output size @150, ${n}`, candidateKeys.map((k) => `${k} ${miB(sizes[n][k].outputBytes)}`).join(', '));
    }
    const sizes300 = {};
    for (const n of ['drawing-a4', 'grey-scan-a4']) {
        sizes300[n] = await call('candidates', n, 300, candidateKeys);
        measure(`output size @300, ${n}`, candidateKeys.map((k) => `${k} ${miB(sizes300[n][k].outputBytes)}`).join(', '));
    }
    evidence.sections.sizes = sizes;
    evidence.sections.sizes300 = sizes300;
    assert('every owned candidate wrote exactly what its contract predicts',
        Object.values(sizes).every((f) => ['E2-png-embed', 'E3-gray-raw', 'E3-rgb-raw'].every((k) => f[k].allExact)),
        'raw streams are the sample count; the stored PNG is pngStoredSize, to the byte');

    // ---- 7. quality --------------------------------------------------------------
    console.log('\n=== 7. what each candidate did to the drawing ===');
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
        `the same lossless path keeps ${pct(quality['fine-line-a4']['E3-gray-raw'].inkKept)} at 150 dpi and ${pct(quality300['fine-line-a4']['E3-gray-raw'].inkKept)} at 300 dpi`);

    // ---- 8. the memory model, term by term ------------------------------------
    console.log('\n=== 8. the memory lifetime model ===');
    const modelKeys = Object.keys(CANDIDATES);
    const terms = {};
    for (const k of modelKeys) {
        const plan = pagePlan(k, ...A4, 300, ORDERING.RELEASED);
        const adm = admissibleForHardContract(plan);
        terms[k] = {
            peakBytes: plan.peakBytes, peakStep: plan.peakStep, encodedBytes: plan.encodedBytes,
            bytesPerPixelEncoded: plan.bytesPerPixelEncoded, bytesPerPixelPeak: plan.bytesPerPixelPeak,
            admissible: adm.admissible, unknown: adm.unknown, measuredOnly: adm.measuredOnly,
            terms: plan.terms.map((t) => ({ name: t.name, bytes: t.bytes, basis: t.basis, source: t.source })),
        };
        measure(`A4 @300, ${k}`,
            `peak ${miB(plan.peakBytes)} at "${plan.peakStep}" (${plan.bytesPerPixelPeak.toFixed(1)} B/px), stream ${plan.bytesPerPixelEncoded.toFixed(3)} B/px, `
            + `admissible: ${adm.admissible}${adm.admissible ? '' : ` (${[...adm.unknown, ...adm.measuredOnly].join('; ')})`}`);
    }
    evidence.sections.terms = terms;
    probe('an unknown encoder scratch prevents a hard contract, whatever the numbers look like',
        terms['E1-jpeg-hard'].admissible === false && terms['E1-jpeg-planning'].admissible === false,
        'both JPEG models are refused: one carries an UNKNOWN term, the other that and a MEASURED_ONLY size');
    probe('a measured compression ratio cannot masquerade as a hard bound',
        terms['E1-jpeg-planning'].measuredOnly.length > 0,
        'the planning model is cheaper on the same page and is classified MEASURED_ONLY, so it cannot be adopted as a bound');
    assert('every owned candidate\'s model is free of unknowns, deflate included',
        ['E2-png-embed', 'E3-gray-raw', 'E3-gray-flate', 'E3-rgb-raw', 'E3-rgb-flate'].every((k) => terms[k].admissible),
        'exact or source-derived, every term — the pako state and its chunk pinning included');

    // ---- 9. RF-M2: jsPDF's bundled encoder --------------------------------------
    console.log('\n=== 9. E4 — jsPDF 3.0.4 does contain a JPEG encoder (RF-M2) ===');
    const js = await call('jspdfEncoder');
    evidence.sections.jspdf = js;
    measure('what jsPDF exports', js.exported.join(', '));
    measure('where its JPEGEncoder is reachable from',
        `exported: ${js.jpegEncoderExported}; on jsPDF.API: ${js.jpegEncoderOnApi}; on an instance: ${js.jpegEncoderOnInstance}; `
        + `plugins that call it: ${js.processorsReachingIt.join(', ')} (each takes an encoded image file)`);
    assert('the encoder exists in the bundle but no supported path reaches it with raw pixels',
        js.jpegEncoderExported === false && js.jpegEncoderOnApi === false
        && js.processorsReachingIt.length === 3 && js.processRGBA === true,
        'jspdf.es.js:15515 defines it; :24183 does not export it; processGIF89A/processBMP/processWEBP call it with decoded image files; '
        + 'processRGBA, the one that takes canvas pixels, does not (20241-20272)');
    const e4 = terms['E4-jspdf-hard'];
    probe('and its output representation cannot be bounded either',
        e4.admissible === false && e4.unknown.some((u) => u.includes('byteout')),
        'byteout is an ordinary JS array pushed one byte at a time (15529, 15651) before new Uint8Array(byteout) (16016)');
    measure('E4 verdict', 'the encoder exists and is real; it is inadmissible for a hard H8 contract on two independent grounds — '
        + 'no stable public API reaches it, and its working memory is the engine\'s, not ours');

    // ---- 10. RF-M3: the whole B2 job -------------------------------------------
    console.log('\n=== 10. the B2 archive, from JSZip\'s own path (RF-M3) ===');
    const zip = await call('zipBatch', 'drawing-a4', 150, 'E3-gray-flate', 3);
    evidence.sections.zip = zip;
    measure('a real B2 archive',
        `${zip.files} files, sources ${fmt(zip.sourceBytesTotal)} B, archive ${fmt(zip.archiveBytes)} B `
        + `(+${Math.round(zip.archiveOverPerFile)} B per file of records)`);
    assert('STORE means the archive is the sources plus records, which is what the model assumes',
        zip.archiveBytes >= zip.sourceBytesTotal && zip.archiveBytes < zip.sourceBytesTotal * 1.02 + 4096,
        'JSZip generateInternalStream defaults to compression STORE (object.js:321)');
    // The largest batch the simplified model would accept, then the same batch
    // priced from JSZip's own path. The count is searched, not chosen, so the
    // probe cannot be tuned to pass.
    const batchLimits = { memory: 512 * MIB, maxOutputBytes: Infinity };
    const [naiveLargest] = search(0, 2000, (n) => n === 0
        || preflight(naiveBatchPlan('E3-rgb-raw', ...A4, 300, 1, n), batchLimits).status === 'READY');
    const naiveBatch = naiveBatchPlan('E3-rgb-raw', ...A4, 300, 1, naiveLargest);
    const fullBatch = batchPlan('E3-rgb-raw', ...A4, 300, 1, naiveLargest);
    const naiveVerdict = preflight(naiveBatch, batchLimits);
    const fullVerdict = preflight(fullBatch, batchLimits);
    probe('the simplified batch model claims READY where the source-derived one refuses',
        naiveVerdict.status === 'READY' && fullVerdict.status === 'REFUSED',
        `${naiveLargest} one-page A4 @300 files, the most the simplified model accepts — simplified: `
        + `${naiveVerdict.status} at ${miB(naiveBatch.peakBytes)}; full: ${fullVerdict.status} `
        + `${fullVerdict.reason ?? ''} at ${miB(fullBatch.peakBytes)} (sources + accumulated chunks + the concat result)`);
    for (const t of fullBatch.terms) measure(`B2 term: ${t.name}`, `${miB(t.bytes)} — ${t.basis} (${t.source})`);

    // ---- 11. boundaries ---------------------------------------------------------
    console.log('\n=== 11. boundaries, per candidate and per preset ===');
    const boundaries = {};
    const batches = {};
    for (const k of modelKeys) {
        const row = {};
        const brow = {};
        for (const memory of CEILINGS.MEMORY_PRESETS) {
            const pagesAt = (n, dpi) => preflight(filePlan(k, ...A4, dpi, n), { memory });
            const [lo3, hi3] = search(0, 4000, (n) => n === 0 || pagesAt(n, 300).status === 'READY');
            const [lo1, hi1] = search(0, 4000, (n) => n === 0 || pagesAt(n, 150).status === 'READY');
            const filesAt = (n) => preflight(batchPlan(k, ...A4, 150, 1, n), { memory });
            const [flo, fhi] = search(0, 2000, (n) => n === 0 || filesAt(n).status === 'READY');
            row[memory / MIB] = {
                pages300: lo3, firstOver300: hi3, reason300: pagesAt(hi3, 300).reason,
                pages150: lo1, firstOver150: hi1, reason150: pagesAt(hi1, 150).reason,
            };
            brow[memory / MIB] = { files: flo, firstOver: fhi, reason: filesAt(fhi).reason };
        }
        boundaries[k] = row;
        batches[k] = brow;
        measure(`A4 pages inside 512 MiB, ${k}`,
            `@300: ${row[512].pages300} (${row[512].firstOver300} refused, ${row[512].reason300}); `
            + `@150: ${row[512].pages150} (${row[512].firstOver150} refused, ${row[512].reason150})`);
        measure(`B2 one-page A4 @150 files, ${k}`,
            `512 MiB: ${brow[512].files} (${brow[512].firstOver} refused, ${brow[512].reason}); `
            + `1 GiB: ${brow[1024].files}; 2 GiB: ${brow[2048].files}`);
    }
    evidence.sections.boundaries = boundaries;
    evidence.sections.batches = batches;

    // ---- 12. the ceilings stay independent --------------------------------------
    console.log('\n=== 12. the ceilings are independent ===');
    probe('raster first-over: the pixel ceiling refuses, and no memory preset buys past it',
        CEILINGS.MEMORY_PRESETS.every((m) => preflight(filePlan('E3-gray-raw', ...A1, 600, 1), { memory: m }).reason === REFUSAL.OVER_RASTER_LIMIT)
        && preflight(filePlan('E3-gray-raw', ...A1, 600, 1), { memory: Infinity }).reason === REFUSAL.OVER_RASTER_LIMIT,
        'A1 @600 is refused OVER_RASTER_LIMIT at 512 MiB, 1 GiB, 2 GiB and with memory unbounded');
    probe('output first-over: the output ceiling refuses on its own, with memory unbounded',
        (() => {
            const [, first] = search(0, 4000, (n) => n === 0
                || preflight(filePlan('E3-rgb-raw', ...A4, 150, n), { memory: Infinity, maxRasterPixels: Infinity }).status === 'READY');
            return preflight(filePlan('E3-rgb-raw', ...A4, 150, first), { memory: Infinity, maxRasterPixels: Infinity }).reason === REFUSAL.OVER_OUTPUT_BUDGET;
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

    // ---- 13. the canvas probe ---------------------------------------------------
    console.log('\n=== 13. the runtime canvas probe ===');
    const probes = [];
    for (const [label, w, h] of [['A4@300', 2480, 3508], ['A1@300', 7016, 9933], ['A1@600', 14031, 19866]]) {
        const r = await call('canvasProbe', w, h);
        probes.push({ label, ...r });
        measure(`canvas ${label} (${(r.pixels / 1e6).toFixed(0)} Mpx)`, r.allocates ? 'allocates' : 'does not allocate');
    }
    evidence.sections.canvasProbes = probes;
    assert('the raster ceiling stays below what this machine refuses',
        probes.find((p) => p.label === 'A1@600').allocates === false && CEILINGS.MAX_RASTER_PIXELS < 14031 * 19866,
        `${(CEILINGS.MAX_RASTER_PIXELS / 1e6).toFixed(1)} Mpx policy, ${(14031 * 19866 / 1e6).toFixed(0)} Mpx refused by the browser`);

    // ---- 14. the decision -------------------------------------------------------
    console.log('\n=== 14. the H8 decision ===');
    const rec = pagePlan('E3-gray-raw', ...A4, 300, ORDERING.RELEASED);
    const g512 = boundaries['E3-gray-raw'][512];
    const gf512 = boundaries['E3-gray-flate'][512];
    const r512 = boundaries['E3-rgb-raw'][512];
    const est512 = boundaries['E1-jpeg-planning'][512];
    const hard512 = boundaries['E1-jpeg-hard'][512];
    human('H8', 'Raster encoder and operation memory: which encoding path, and which memory contract?',
        `H8-A for Monochrome, H8-B for Optimize — an owned image XObject, written by pdf-lib itself, with the canvas released `
        + `before the samples are allocated. One A4 page at 300 dpi peaks at ${miB(rec.peakBytes)} (${rec.bytesPerPixelPeak.toFixed(1)} B/px) at "${rec.peakStep}", `
        + `every term EXACT or source-derived. Inside 512 MiB: DeviceGray raw ${g512.pages300} pages @300 and ${g512.pages150} @150, `
        + `DeviceGray FlateDecode ${gf512.pages300}/${gf512.pages150}, DeviceRGB ${r512.pages300}/${r512.pages150}; `
        + `against ${est512.pages300}/${est512.pages150} that the unadoptable estimate promised and ${hard512.pages300}/${hard512.pages150} `
        + `that the only fail-closed JPEG term allowed.`);
    human('H8-file-size', 'Is a larger PDF acceptable as the price of an exact memory contract?',
        `measured at 150 dpi on the grey scan: production JPEG ${miB(sizes['grey-scan-a4']['E1-jpeg'].outputBytes)}, `
        + `owned DeviceGray FlateDecode ${miB(sizes['grey-scan-a4']['E3-gray-flate'].outputBytes)}, `
        + `owned DeviceGray raw ${miB(sizes['grey-scan-a4']['E3-gray-raw'].outputBytes)}. FlateDecode keeps the guarantee — its `
        + `whole lifetime is now source-derived — and most of the size; raw keeps the size exact before the page is rendered.`);

    // ---- totals -----------------------------------------------------------------
    assert('no measurement left the machine', external.length === 0, `${external.length} external requests`);
    assert('no page error during the run', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
    assert('the evidence is bound to committed source: the research tree is clean, untracked files included',
        evidence.workingTreeDirty === false,
        evidence.workingTreeDirty === false
            ? `tested head ${evidence.testedResearchHead}`
            : `dirty: ${evidence.dirtyPaths.join(', ')}`);

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
    console.log(`  tested head ${evidence.testedResearchHead}  dirty ${evidence.workingTreeDirty}`);
    exitCode = summary.assertionsFailed === 0 && summary.probesFailed === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
