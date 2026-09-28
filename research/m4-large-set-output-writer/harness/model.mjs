/**
 * (1) Worst-case compressed size: how far can Deflate expand the 4-bit state
 *     raster? Measured on adversarial inputs for fflate (levels 1/6/9) and the
 *     zlib behind CompressionStream (node:zlib, the same library Chrome uses).
 * (2) The proposed two-layer budget, evaluated with the production kernel
 *     model (estimatePhaseMemory / engineLiveDuringSink) over the synthetic A1
 *     frames, next to today's preflight verdicts (evidence/budget-matrix.json).
 *
 * Run: node harness/model.mjs  -> evidence/model.json
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zlibSync } from 'fflate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
const MiB = 2 ** 20;

// ---------------------------------------------------------------- (1) bound
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const N = 8 * MiB;
const r = rng(7);
const inputs = {
    'uniform random bytes (no raster can be worse)': Uint8Array.from({ length: N }, () => Math.floor(r() * 256)),
    'random 9-state nibbles (worst legal state raster)': Uint8Array.from({ length: N }, () => (Math.floor(r() * 9) << 4) | Math.floor(r() * 9)),
    'all paper (best case)': new Uint8Array(N),
};
/** zlib's documented deflateBound for default windowBits/memLevel, plus the 6-byte zlib wrapper. */
const zlibBound = (n) => n + (n >> 12) + (n >> 14) + (n >> 25) + 13 - 6 + 6;
const bound = [];
for (const [name, data] of Object.entries(inputs)) {
    const row = { input: name, rawBytes: data.length, zlibBound: zlibBound(data.length) };
    for (const level of [1, 6, 9]) row[`fflateL${level}`] = zlibSync(data, { level }).length;
    row.nodeZlibDefault = zlib.deflateSync(data).length;
    row.maxOverRaw = Math.max(row.fflateL1, row.fflateL6, row.fflateL9, row.nodeZlibDefault) / data.length;
    row.withinZlibBound = Math.max(row.fflateL1, row.fflateL6, row.fflateL9, row.nodeZlibDefault) <= row.zlibBound;
    bound.push(row);
}

// ---------------------------------------------------------- (2) the model
/**
 * Worst-case bytes one page may add, known before any pixel exists:
 * 4-bit rows + one predictor byte per row, through Deflate at its bound; if
 * an encoder ever exceeded it the writer would re-emit the page as stored
 * blocks (exact size, png.ts-style), so the bound holds by construction.
 */
function pageBound(w, h) {
    const raw = ((w + 1) >> 1) * h + h;
    const storedFallback = raw + 5 * Math.ceil(raw / 65535) + 6;
    return Math.max(zlibBound(raw), storedFallback) + 4096;
}
const COMPRESSOR_STATE = 4 * MiB; // fflate/zlib window + hash + band buffers, conservative
const DOC_OVERHEAD = 16 * 1024;

const presets = prod.MEMORY_BUDGET_PRESETS;
const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'budget-matrix.json'), 'utf8'));
const model = [];
for (const dpi of [150, 300, 450]) {
    const metas = [1, 2, 3, 4, 5].map((n) => JSON.parse(fs.readFileSync(
        path.join(ROOT, 'out', 'composites', `dpi${dpi}`, `p${n}`, 'meta.json'), 'utf8')));
    for (let count = 1; count <= 5; count += 1) {
        const used = metas.slice(0, count);
        let kernel = 0;
        let sink = 0;
        let retained = DOC_OVERHEAD;
        for (const m of used) {
            const job = { width: m.width, height: m.height, members: 2, radiusPx: 0 };
            kernel = Math.max(kernel, prod.estimatePhaseMemory(job).peakWorkingSet);
            const b = pageBound(m.width, m.height);
            sink = Math.max(sink, prod.engineLiveDuringSink(job) + COMPRESSOR_STATE + b);
            retained += b;
        }
        const duringRun = Math.max(kernel, sink) + retained;
        const atPublish = retained /* chunks */ + retained /* Blob copy */;
        const jobPeak = Math.max(duringRun, atPublish);
        const row = {
            dpi, pages: count, frame: `${used[0].width}x${used[0].height}`,
            kernelPeakMiB: +(kernel / MiB).toFixed(1),
            sinkPeakMiB: +(sink / MiB).toFixed(1),
            outputWorstCaseMiB: +(retained / MiB).toFixed(1),
            // Option A: the worst case itself is checked against today's ceiling, before any work.
            outputBoundWithinMaxOutput: retained <= prod.MAX_OUTPUT_BYTES,
            duringRunMiB: +(duringRun / MiB).toFixed(1),
            atPublishMiB: +(atPublish / MiB).toFixed(1),
            jobPeakMiB: +(jobPeak / MiB).toFixed(1),
            acceptsAt: {},
            todayAt: {},
        };
        for (const p of presets) {
            row.acceptsAt[p.label] = jobPeak <= p.bytes;
            const c = current.find((x) => x.dpi === dpi && x.pages === count && x.preset === p.label);
            row.todayAt[p.label] = c.accepted ? 'ACCEPT' : c.refusal;
        }
        model.push(row);
    }
}
fs.writeFileSync(path.join(ROOT, 'evidence', 'model.json'), JSON.stringify({ bound, model, constants: { COMPRESSOR_STATE, DOC_OVERHEAD } }, null, 1));
console.table(bound.map((b) => ({ input: b.input.slice(0, 34), raw: b.rawBytes, L1: b.fflateL1, L6: b.fflateL6, L9: b.fflateL9, zlib: b.nodeZlibDefault, bound: b.zlibBound, within: b.withinZlibBound })));
for (const m of model) {
    console.log(`${m.dpi} ${m.pages}p kernel ${m.kernelPeakMiB} sink ${m.sinkPeakMiB} outWorst ${m.outputWorstCaseMiB} peak ${m.jobPeakMiB} MiB | new ${Object.values(m.acceptsAt).map((a) => (a ? 'Y' : 'n')).join('/')} | today ${Object.values(m.todayAt).join('/')}`);
}
