/**
 * One (fixture, candidate) in its own process: optimize, measure, verify.
 *
 *   current            production runOptimizeLossless (structural re-save)
 *   ll-pdflib          R1+R2 lossless, pdf-lib save (useObjectStreams)
 *   ll-chunked         R1+R2 lossless, chunked writer, node zlib level 9
 *   ll-chunked-owned   R1+R2 lossless, chunked writer, production owned DEFLATE
 *   r1-chunked         R1 only (same samples, better Flate), chunked writer
 *   struct-chunked     no image changes, chunked writer (writer baseline)
 *   lossy-q85 / lossy-q75 / lossy-down2   opt-in lossy (DCT; 2x downsample+DCT)
 *
 * Flags: --drop-source releases the caller's source buffer after parsing (the
 * UI would re-read the File for the unchanged-fallback). --no-verify.
 * Prints one JSON line. The RSS of the write window is sampled every 2 ms by a
 * worker thread (MeasuredOnly).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { optimize } from './optimizer.mjs';
import { compare } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };
const FIXTURE = arg('fixture', 'f01-comparator-a1-150');
const CAND = arg('candidate', 'll-chunked');
const DROP = process.argv.includes('--drop-source');
const VERIFY = !process.argv.includes('--no-verify');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(REPO, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')).href;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'manifest.json'), 'utf8'))[FIXTURE];
const srcFile = path.join(ROOT, 'out', 'corpus', `${FIXTURE}.pdf`);
const OUTDIR = path.join(ROOT, 'out', 'results', FIXTURE);
fs.mkdirSync(OUTDIR, { recursive: true });
const outFile = path.join(OUTDIR, `${CAND}.pdf`);
fs.rmSync(outFile, { force: true });

/** Opt-in lossy encoder: DCT at quality q, optionally after a 2x box downsample. */
function lossyEncoder(q, down) {
    return {
        async encode(samples, comps, w, h) {
            let W = w; let H = h;
            let rgba = new Uint8ClampedArray(w * h * 4);
            for (let p = 0; p < w * h; p += 1) {
                const r = samples[p * comps]; const g = comps === 3 ? samples[p * 3 + 1] : r; const b = comps === 3 ? samples[p * 3 + 2] : r;
                rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = 255;
            }
            if (down) {
                W = Math.ceil(w / 2); H = Math.ceil(h / 2);
                const d = new Uint8ClampedArray(W * H * 4);
                for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) for (let c = 0; c < 4; c += 1) {
                    let s = 0; let k = 0;
                    for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) { const yy = y * 2 + dy; const xx = x * 2 + dx; if (yy < h && xx < w) { s += rgba[(yy * w + xx) * 4 + c]; k += 1; } }
                    d[(y * W + x) * 4 + c] = s / k;
                }
                rgba = d;
            }
            const canvas = createCanvas(W, H);
            canvas.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
            const jpg = canvas.encodeSync('jpeg', q);
            canvas.width = 1;
            return { data: Buffer.from(jpg), width: W, height: H, label: `DCT q${q}${down ? ' after 2x downsample' : ''}` };
        },
    };
}

const shared = new BigInt64Array(new SharedArrayBuffer(16));
const sampler = new Worker(`
    const s = require('node:worker_threads').workerData;
    while (Atomics.load(s, 1) === 0n) {
        const r = BigInt(process.memoryUsage.rss());
        if (r > Atomics.load(s, 0)) Atomics.store(s, 0, r);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
`, { eval: true, workerData: shared });

globalThis.gc?.();
let source = new Uint8Array(fs.readFileSync(srcFile));
const sourceBytes = source.length;
await new Promise((r) => setTimeout(r, 30));
const baseline = process.memoryUsage().rss;
const t0 = performance.now();
let result;
let chunks;
let total;
let changed = true;
if (CAND === 'current') {
    const r = await prod.processor.runOptimizeLossless(source);
    chunks = [r.bytes]; total = r.bytes.length; changed = r.changed;
    result = { report: [], ms: {} };
} else {
    const opts = {
        writer: CAND.includes('pdflib') ? 'pdflib' : 'chunked',
        backend: CAND.includes('owned') ? 'owned' : CAND.includes('pako') ? 'pako9' : 'zlib9',
        fast: CAND.includes('fast'),
        owned: prod.comparator,
        lossy: CAND === 'lossy-q85' ? lossyEncoder(85, false) : CAND === 'lossy-q75' ? lossyEncoder(75, false) : CAND === 'lossy-down2' ? lossyEncoder(85, true) : null,
        r1Only: CAND === 'r1-chunked',
        noImages: CAND === 'struct-chunked',
    };
    const input = source;
    if (DROP) source = null; // the parser holds it only until load() returns
    result = await optimize(input, opts);
    ({ chunks, total } = result);
    // The adopted rule: never hand back a larger "optimized" file.
    if (total >= sourceBytes) { changed = false; chunks = null; total = sourceBytes; }
}
const ms = Math.round(performance.now() - t0);
await new Promise((r) => setTimeout(r, 20));
Atomics.store(shared, 1, 1n);
await sampler.terminate();
const peak = Number(shared[0]);

const outBytes = changed ? Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length))) : fs.readFileSync(srcFile);
fs.writeFileSync(outFile, outBytes);
const rec = {
    fixture: FIXTURE, candidate: CAND, dropSource: DROP, sourceBytes, outputBytes: outBytes.length, changed,
    reduction: +(1 - outBytes.length / sourceBytes).toFixed(4), ms, analyseMs: result.ms.analyse, writeMs: result.ms.write,
    rssBaselineMiB: +(baseline / 2 ** 20).toFixed(1), sampledPeakMiB: +(peak / 2 ** 20).toFixed(1), peakOverBaselineMiB: +((peak - baseline) / 2 ** 20).toFixed(1),
    images: result.report.map((r) => ({
        ref: r.ref, w: r.width, h: r.height, cs: r.colourSpace, bpc: r.bpc, filters: r.filters.join('+') || 'none',
        decision: r.decision.class, why: r.decision.why, before: r.before, after: r.after, chosen: r.chosen, lossy: r.lossy ?? false,
        usedBy: r.usedBy, smask: r.smask, isSMask: r.isSMask,
    })),
    outputSha: crypto.createHash('sha256').update(outBytes).digest('hex').slice(0, 16),
};
if (VERIFY) {
    const src = new Uint8Array(fs.readFileSync(srcFile));
    const isLossy = CAND.startsWith('lossy');
    rec.verify = await compare(src, new Uint8Array(outBytes), { mode: isLossy ? 'lossy' : 'lossless', manifest });
    const srcFields = (await compare(src, src, { mode: 'lossless' })).fields;
    rec.verify.fieldsPreserved = JSON.stringify(srcFields) === JSON.stringify(rec.verify.fields);
    if (!rec.verify.fieldsPreserved) { rec.verify.ok = false; rec.verify.errors.push('form fields differ'); }
    rec.verify.images = rec.verify.images.map(({ hash, ...keep }) => keep);
}
console.log(JSON.stringify(rec));
