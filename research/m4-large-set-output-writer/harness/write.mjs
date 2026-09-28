/**
 * Stage 2: one writer candidate, one DPI, in its own process.
 *
 * Reads the stage-1 composite (or masks) page by page, builds the Comparison
 * PDF, records process.resourceUsage().maxRSS *before* any verification, then
 * reopens the file independently (verify.mjs). Prints one JSON line.
 *
 * Run: node harness/write.mjs --tag dpi150 --writer idx4m-flate [--pages 1-5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { ChunkedPdfWriter } from './pdf-writer.mjs';
import {
    rgbRows, statePalette, stateRowsFromMasks, indexedRowsFromComposite,
    encodeRgb, encodeIndexed, encodeIndexedCompressionStream, encodeJpeg, downsampledStateRows,
} from './encoders.mjs';
import { verifyPdf } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'out');
const prod = await import(pathToFileURL(path.join(OUT, 'prod.mjs')).href);

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const TAG = arg('tag', 'dpi150');
const WRITER = arg('writer', 'idx4m-flate');
const [P0, P1] = arg('pages', '1-5').split('-').map(Number);
const SKIP_VERIFY = process.argv.includes('--no-verify');
const DIR = path.join(OUT, 'composites', TAG);
const RESULT_DIR = path.join(OUT, 'pdf', TAG);
fs.mkdirSync(RESULT_DIR, { recursive: true });

const REF_COLOR = [0, 0, 1];
const OTH_COLOR = [1, 0, 0];
const MATCH_COLOR = [0xC0 / 255, 0xC0 / 255, 0xC0 / 255];
const MATCH_OPACITY = 0.7;
const palette = statePalette(prod.paintPair, REF_COLOR, OTH_COLOR, MATCH_COLOR, MATCH_OPACITY);

const mib = (b) => +(b / 2 ** 20).toFixed(2);
const rssNow = () => process.memoryUsage().rss;
const maxRss = () => process.resourceUsage().maxRSS * 1024;

const pages = [];
for (let n = P0; n <= P1; n += 1) {
    pages.push(JSON.parse(fs.readFileSync(path.join(DIR, `p${n}`, 'meta.json'), 'utf8')));
}
const title = (m) => `p${m.page}: a1-set-A.pdf vs a1-set-B.pdf — ${m.verdict}`;
const loadComposite = (m) => new Uint8ClampedArray(fs.readFileSync(path.join(DIR, `p${m.page}`, 'composite.rgba')));
const loadMasks = (m) => {
    const ref = new Uint8Array(fs.readFileSync(path.join(DIR, `p${m.page}`, 'ref.mask')));
    const oth = new Uint8Array(fs.readFileSync(path.join(DIR, `p${m.page}`, 'oth.mask')));
    const dRef = prod.dilateMask(ref, m.width, m.height, m.radiusPx);
    const dOth = prod.dilateMask(oth, m.width, m.height, m.radiusPx);
    return { ref, oth, dRef, dOth };
};

// --sink-only: every page's input (what the engine would already be holding
// when it calls the sink) is loaded before the baseline, so the high-water mark
// above it is the writer's own: encode buffers, compressor state, retained
// output, publication. Needs --expose-gc to settle the loads first.
const SINK_ONLY = process.argv.includes('--sink-only');
const preloaded = new Map();
if (SINK_ONLY) {
    for (const m of pages) {
        preloaded.set(m.page, WRITER.startsWith('idx4m-') ? loadMasks(m) : loadComposite(m));
    }
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 50));
    globalThis.gc?.();
}
const take = (m) => {
    const v = preloaded.get(m.page);
    preloaded.delete(m.page);
    return v;
};
const readComposite = (m) => (SINK_ONLY ? take(m) : loadComposite(m));
const readMasks = (m) => (SINK_ONLY ? take(m) : loadMasks(m));

// maxRSS is a high-water mark; in sink-only mode it is reset to "now" by
// measuring the current RSS after preloading, since earlier file-read
// transients (Buffer + copy) already raised the process peak.
const baselineRss = SINK_ONLY ? process.memoryUsage().rss : maxRss();

// A sampler thread polls process RSS every 2 ms while the writer runs, so the
// peak of the write window is observed directly (the main thread is busy in
// synchronous loops and cannot sample itself).
const shared = new BigInt64Array(new SharedArrayBuffer(16));
const sampler = new Worker(`
    const { workerData } = require('node:worker_threads');
    const s = workerData;
    while (Atomics.load(s, 1) === 0n) {
        const r = BigInt(process.memoryUsage.rss());
        if (r > Atomics.load(s, 0)) Atomics.store(s, 0, r);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
`, { eval: true, workerData: shared });
await new Promise((r) => setTimeout(r, 30));
const file = path.join(RESULT_DIR, `${WRITER}_p${P0}-${P1}${arg('ceiling', null) ? `_ceil${arg('ceiling')}` : ''}.pdf`);
// No stale artifact can stand in for this run's.
fs.rmSync(file, { force: true });
const perPage = [];
let mode = 'lossless';
let refused = null;
let jsPdfOutput = null;
const t0 = performance.now();

if (WRITER === 'current') {
    // The production sink, unmodified (artifacts.ts), then what save() does
    // before the Blob: jsPDF's own output('arraybuffer').
    const dpi = pages[0].dpi;
    const sink = prod.createComparisonPdf(dpi);
    for (const m of pages) {
        const ts = performance.now();
        const pair = {
            page: m.page, slot: 2, label: 'a1-set-B.pdf', referenceLabel: 'a1-set-A.pdf',
            title: `p${m.page}: a1-set-A.pdf vs a1-set-B.pdf`, verdict: m.verdict,
            changePixels: m.changePixels, inkPixels: m.inkPixels,
            width: m.width, height: m.height, pixels: readComposite(m), bounds: m.bounds,
        };
        sink.onPair(pair);
        const a = sink.appended[sink.appended.length - 1];
        perPage.push({ page: m.page, encodedBytes: a.encodedBytes, ms: Math.round(performance.now() - ts), rssAfter: mib(rssNow()) });
    }
    const ts = performance.now();
    const ab = sink.doc.output('arraybuffer');
    const saveMs = Math.round(performance.now() - ts);
    // jsPDF catches its own errors in output() and returns undefined.
    jsPdfOutput = ab === undefined ? 'undefined (error swallowed by jsPDF)' : `${ab.byteLength} bytes`;
    if (ab !== undefined) fs.writeFileSync(file, new Uint8Array(ab));
    perPage.push({ save: true, ms: saveMs });
} else {
    const CEILING = Number(arg("ceiling", "Infinity"));
    const writer = new ChunkedPdfWriter({ maxBytes: CEILING });
    let retained = 0;
    for (const m of pages) {
        const ts = performance.now();
        const scale = m.dpi / 72;
        let image;
        let widthPt = m.width / scale;
        let heightPt = m.height / scale;
        if (WRITER.startsWith('rgb-')) {
            const pred = { 'rgb-flate': 0, 'rgb-sub': 1, 'rgb-up': 2, 'rgb-paeth': 4, 'rgb-adaptive': 'adaptive' }[WRITER];
            image = encodeRgb(rgbRows(readComposite(m), m.width, m.height), { predictor: pred });
        } else if (WRITER.startsWith('idx4c-')) {
            // Indexed from the RGBA composite (sink keeps today's input).
            const level = Number(WRITER.split('-L')[1] ?? 6);
            const pred = WRITER.includes('-up') ? 2 : 0;
            image = encodeIndexed(indexedRowsFromComposite(readComposite(m), m.width, m.height, palette, 4), palette, 4, { predictor: pred, level });
        } else if (WRITER.startsWith('idx4m-')) {
            // Indexed straight from the masks: no RGBA composite is ever built.
            const k = readMasks(m);
            if (WRITER === 'idx4m-cs' || WRITER === 'idx4m-cs-up') {
                image = await encodeIndexedCompressionStream(
                    stateRowsFromMasks(k.ref, k.oth, k.dRef, k.dOth, m.width, m.height), palette, 4,
                    { predictor: WRITER === 'idx4m-cs-up' ? 2 : 0 },
                );
            } else if (WRITER.startsWith('idx4m-down')) {
                const f = Number(WRITER.slice('idx4m-down'.length));
                image = encodeIndexed(downsampledStateRows(k.ref, k.oth, k.dRef, k.dOth, m.width, m.height, f), palette, 4, {});
                mode = 'reduced';
            } else {
                const level = Number(WRITER.split('-L')[1] ?? 6);
                const pred = WRITER.includes('-up') ? 2 : 0;
                image = encodeIndexed(stateRowsFromMasks(k.ref, k.oth, k.dRef, k.dOth, m.width, m.height), palette, 4, { predictor: pred, level });
            }
        } else if (WRITER.startsWith('jpeg-q')) {
            const q = Number(WRITER.slice('jpeg-q'.length));
            const canvas = createCanvas(m.width, m.height);
            canvas.getContext('2d').putImageData(new ImageData(readComposite(m), m.width, m.height), 0, 0);
            const jpg = canvas.encodeSync('jpeg', q);
            canvas.width = 1;
            image = encodeJpeg(jpg, m.width, m.height);
            mode = 'lossy';
        } else {
            throw new Error(`unknown writer ${WRITER}`);
        }
        let r;
        try {
            r = writer.addImagePage({ widthPt, heightPt, image, title: title(m) });
        } catch (e) {
            if (e.name !== 'OutputCeilingError') throw e;
            refused = {
                status: 'OVER_OUTPUT_BUDGET (runtime)', message: e.message,
                requested: `pages ${P0}-${P1} at ${m.dpi} dpi`, pagesCompleted: e.pagesDone,
                projectedBytes: e.bytes, ceilingBytes: e.ceiling,
            };
            break;
        }
        retained = r.bytesSoFar;
        perPage.push({
            page: m.page, rawBytes: image.rawBytes, encodedBytes: image.encodedBytes,
            ratio: +(image.rawBytes / image.encodedBytes).toFixed(1),
            filterTypes: image.filterTypes ?? undefined,
            ms: Math.round(performance.now() - ts), retainedAfter: retained, rssAfter: mib(rssNow()),
        });
        image = null;
    }
    if (!refused) {
        const chunks = writer.finish();
        // Published chunk by chunk, as new Blob(chunks) would: no concatenated copy.
        const fd = fs.openSync(file, 'w');
        for (const c of chunks) fs.writeSync(fd, c);
        fs.closeSync(fd);
    }
}

const totalMs = Math.round(performance.now() - t0);
await new Promise((r) => setTimeout(r, 10));
Atomics.store(shared, 1, 1n);
await sampler.terminate();
const sampledPeak = Number(shared[0]);
const peak = maxRss();
const published = fs.existsSync(file);
const fileBytes = published ? fs.statSync(file).size : 0;
const result = {
    tag: TAG, writer: WRITER, pages: `${P0}-${P1}`, dpi: pages[0].dpi, mode,
    published, refused, jsPdfOutput,
    fileBytes, fileMiB: mib(fileBytes), perPageMiB: mib(fileBytes / pages.length),
    totalMs, sinkOnly: SINK_ONLY, baselineRssMiB: mib(baselineRss), peakRssMiB: mib(peak), writerPeakOverBaselineMiB: mib(peak - baselineRss),
    sampledPeakRssMiB: mib(sampledPeak), sampledWriterPeakMiB: mib(sampledPeak - baselineRss),
    perPage,
};
if (!SKIP_VERIFY && published) {
    const expected = {
        mode, palette,
        pages: pages.map((m) => ({
            page: m.page, verdict: m.verdict, width: m.width, height: m.height,
            widthPt: m.width / (m.dpi / 72), heightPt: m.height / (m.dpi / 72), inkPixels: m.inkPixels,
            compositeFile: path.join(DIR, `p${m.page}`, 'composite.rgba'),
        })),
    };
    try {
        result.verify = await verifyPdf(file, expected);
    } catch (e) {
        result.verify = { ok: false, errors: [String(e?.stack ?? e)] };
    }
}
console.log(JSON.stringify(result));
