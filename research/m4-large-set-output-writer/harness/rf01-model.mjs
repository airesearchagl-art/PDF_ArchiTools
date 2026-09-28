/**
 * RF-01: the two-layer budget with every deterministic term construction-owned.
 *
 * Separates four kinds of claim:
 *   OWNED       arithmetic on code this design owns (bounds hold by construction)
 *   PRODUCTION  the unmodified production kernel model (estimatePhaseMemory,
 *               engineLiveDuringSink), already the M4 contract
 *   PLATFORM    browser capabilities assumed, not bounded here (canvas, Blob)
 *   MEASURED    CompressionStream / RSS behaviour: evidence, never a bound
 *
 * The output bound is ownedDeflateBound() of the 4-bit (or RGB, for notices)
 * filtered raster; it does not depend on any platform compressor. The
 * compressor scratch is the owned encoder's fixed buffers. CompressionStream,
 * if ever enabled as an optimiser, sits outside this budget (see report RF-01).
 *
 * Run: node harness/rf01-model.mjs  -> evidence/rf01-model.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownedDeflateBound, ownedDeflateScratchBytes } from './owned-deflate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
const MiB = 2 ** 20;
const PAGE_OBJECTS = 4096; // page dict + content stream + xref line: a bound on the few hundred bytes written
const DOC_OVERHEAD = 16 * 1024;

/** OWNED: one image stream, worst case, before any pixel exists. */
export function imageBound(rowBytes, height) {
    return ownedDeflateBound((rowBytes + 1) * height) + PAGE_OBJECTS; // +1: Up predictor byte
}
/** OWNED: encoder working buffers for one image (row source, filtered line, previous row, deflate). */
export function encoderScratch(rowBytes) {
    return rowBytes * 3 + 1 + ownedDeflateScratchBytes(rowBytes + 1);
}

const notice = prod.NOTICE_RASTER.COMPARISON_PDF;
const noticeRgba = notice.width * notice.height * 4;
const noticeBound = imageBound(notice.width * 3, notice.height);
// draw (canvas) -> readback (canvas released, artifacts.ts:137-141) -> encode from the readback.
const noticePeak = Math.max(noticeRgba * 2, noticeRgba + encoderScratch(notice.width * 3) + noticeBound);

const rows = [];
for (const dpi of [150, 300, 450]) {
    const metas = [1, 2, 3, 4, 5].map((n) => JSON.parse(fs.readFileSync(
        path.join(ROOT, 'out', 'composites', `dpi${dpi}`, `p${n}`, 'meta.json'), 'utf8')));
    for (const members of [2, 3, 4]) {
        for (let count = 1; count <= 5; count += 1) {
            let kernel = 0;
            let sink = 0;
            let outputBound = DOC_OVERHEAD;
            let items = 0;
            for (const m of metas.slice(0, count)) {
                const job = { width: m.width, height: m.height, members, radiusPx: 0 };
                kernel = Math.max(kernel, prod.estimatePhaseMemory(job).peakWorkingSet);
                const rowBytes = (m.width + 1) >> 1;
                const b = imageBound(rowBytes, m.height);
                sink = Math.max(sink, prod.engineLiveDuringSink(job) + encoderScratch(rowBytes) + b);
                outputBound += b * (members - 1);
                items += members - 1;
            }
            const duringRun = Math.max(kernel, sink) + outputBound;
            const atPublish = outputBound * 2; // chunks + Blob copy (PLATFORM: one copy assumed)
            const jobPeak = Math.max(duringRun, atPublish);
            rows.push({
                dpi, members, pages: count, items,
                kernelPeakMiB: +(kernel / MiB).toFixed(1),
                sinkPeakMiB: +(sink / MiB).toFixed(1),
                outputBoundMiB: +(outputBound / MiB).toFixed(1),
                jobPeakMiB: +(jobPeak / MiB).toFixed(1),
                memoryAccepts: prod.MEMORY_BUDGET_PRESETS.map((p) => jobPeak <= p.bytes),
                outputBoundWithinMaxOutput: outputBound <= prod.MAX_OUTPUT_BYTES,
            });
        }
    }
}
const result = {
    classes: {
        OWNED: ['per-image output bound (ownedDeflateBound of the filtered raster + page objects)', 'encoder scratch (fixed buffers)', 'runtime ceiling check before each append', 'stored-block fallback'],
        PRODUCTION: ['kernel phases (estimatePhaseMemory)', 'engine-held masks during the sink (engineLiveDuringSink)', 'notice raster size (NOTICE_RASTER)'],
        PLATFORM: ['canvas allocation up to the frame (checked in Chrome 143 at 450 dpi A1)', 'new Blob(chunks) makes at most one copy', 'CompressionStream: NOT assumed by the safety path'],
        MEASURED: ['CompressionStream output sizes and fallback behaviour', 'RSS / timings (MeasuredOnly)'],
    },
    constants: { PAGE_OBJECTS, DOC_OVERHEAD, noticeBound, noticePeak, noticeScratch: encoderScratch(notice.width * 3) },
    rows,
};
fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence', 'rf01-model.json'), JSON.stringify(result, null, 1));
for (const r of rows) {
    console.log(`${r.dpi} ${r.members}m ${r.pages}p kernel ${r.kernelPeakMiB} sink ${r.sinkPeakMiB} outBound ${r.outputBoundMiB} peak ${r.jobPeakMiB} | mem ${r.memoryAccepts.map((a) => (a ? 'Y' : 'n')).join('')} | out<=256 ${r.outputBoundWithinMaxOutput}`);
}
