/**
 * The Raster Budget for the flattening operations — RF-K5, corrected by RF-L2.
 *
 * Monochrome (A), Optimize (O1) and Both render every page to a canvas and
 * write a document of JPEGs. Pixel counts follow from the page boxes and the
 * DPI, and most of the pipeline's buffers follow from the code. One term does
 * not: **how large the browser's JPEG encoder makes its output, and what it
 * allocates while making it.** That encoder is not owned by this
 * architecture, and no finite sweep of fixtures can bound either.
 *
 * So this module keeps two models apart, and never lets one stand in for the
 * other:
 *
 *   'planning'  — the JPEG term is a *measured performance ratio* (the worst
 *                 of six adversarial contents on one encoder, with margin).
 *                 Useful for what a run will probably cost. **Not a safety
 *                 proof**, and not a fail-closed guarantee.
 *   'hard'      — the JPEG term is the *format's own upper bound*, derived
 *                 from baseline JPEG entropy coding (ITU-T T.81) rather than
 *                 from any encoder's behaviour. Fail-closed, and — as the
 *                 gate shows — so large that the flattening operations barely
 *                 fit at all.
 *
 * Even under 'hard', the encoder's internal working memory is unknown, so the
 * memory ceiling is still not a proof. That is why H8 is blocked pending a
 * Raster Encoder / Memory Sub-Spike (see architecture.md), while H9 — the
 * raster-pixel ceiling and the runtime canvas probe, both computed from
 * pixels the architecture does own — can be adopted.
 *
 * Research code. Not part of the app.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } from 'pdf-lib';

const MIB = 1024 * 1024;

/**
 * Baseline sequential JPEG, worst case per 8x8 block (ITU-T T.81):
 *   DC: a Huffman code of at most 16 bits + at most 11 extra bits
 *   AC: 63 coefficients, each at most 16 + 10 bits
 *   → (27 + 63x26) bits = 1665 bits = 208.2 bytes
 * Entropy-coded bytes equal to 0xFF are followed by a stuffed 0x00, which at
 * worst doubles that: 416.4 bytes per block. Without chroma subsampling a
 * pixel belongs to three blocks of 64 pixels: 3 x 416.4 / 64 = 19.52 B/px.
 * Rounded up, with headers and restart markers absorbed: 20 B/px.
 */
const JPEG_FORMAT_BOUND_BYTES_PER_PIXEL = 20;

export const RASTER_MODEL = Object.freeze({
    jpeg: Object.freeze({
        /** Fail-closed, derived from the format, not from an encoder. */
        formatUpperBound: JPEG_FORMAT_BOUND_BYTES_PER_PIXEL,
        /**
         * Measured worst case over six adversarial contents (uniform and
         * binary noise, grey and colour, and one-pixel checkerboards) at two
         * sizes on this Chrome's encoder at q0.8: 0.783 B/px, rounded up to at
         * least 1.25x. Performance evidence only.
         */
        measuredPerformanceBound: 1.0,
        measuredWorst: 0.783,
    }),
    /** `data:image/jpeg;base64,` */
    dataUrlPrefix: 23,
    /** Page object, content stream and xref overhead per output page. A bound. */
    perPageOverhead: 2048,
    /** Header, catalog, trailer. A bound. */
    documentOverhead: 8192,
    /** JSZip STORE: local header + central directory per entry. A bound. */
    zipEntryOverhead: 1024,
    zipOverhead: 1024,
});

export const RASTER_LIMIT_CANDIDATES = Object.freeze({
    MAX_RASTER_PIXELS: [64 * 2 ** 20, 128 * 2 ** 20, 256 * 2 ** 20],
    MAX_OPERATION_MEMORY: { default: 512 * MIB, explicit: [1024 * MIB, 2048 * MIB] },
    MAX_OUTPUT_BYTES: [256 * MIB, 512 * MIB],
});

export const jpegBytesPerPixel = (mode) => (mode === 'hard'
    ? RASTER_MODEL.jpeg.formatUpperBound : RASTER_MODEL.jpeg.measuredPerformanceBound);

/** The canvas production creates: `canvas.width = viewport.width` truncates. */
export function pagePixels(wPt, hPt, dpi) {
    const s = dpi / 72;
    const w = Math.floor(wPt * s);
    const h = Math.floor(hPt * s);
    return { w, h, pixels: w * h };
}

/**
 * What a plan needs to know about a source, read without rendering: the
 * visible box of each page, how many source-image pixels it draws, and
 * whether it has the transparency constructs that make PDF.js allocate
 * page-sized scratch canvases (groups, soft masks, patterns, shadings).
 */
export async function rasterFacts(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const resolve = (v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
    const pages = doc.getPages().map((page) => {
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const wPt = Math.min(media.x + media.width, crop.x + crop.width) - Math.max(media.x, crop.x);
        const hPt = Math.min(media.y + media.height, crop.y + crop.height) - Math.max(media.y, crop.y);
        let imagePixels = 0;
        let transparency = page.node.get(PDFName.of('Group')) !== undefined;
        const seen = new Set();
        const visit = (res, depth) => {
            const r = resolve(res);
            if (!(r instanceof PDFDict) || depth > 12) return;
            const gs = resolve(r.get(PDFName.of('ExtGState')));
            if (gs instanceof PDFDict) {
                for (const [, g] of gs.entries()) {
                    const smask = resolve(resolve(g)?.get?.(PDFName.of('SMask')));
                    if (smask instanceof PDFDict) transparency = true;
                }
            }
            if (resolve(r.get(PDFName.of('Pattern'))) instanceof PDFDict) transparency = true;
            if (resolve(r.get(PDFName.of('Shading'))) instanceof PDFDict) transparency = true;
            const xo = resolve(r.get(PDFName.of('XObject')));
            if (!(xo instanceof PDFDict)) return;
            for (const [, ref] of xo.entries()) {
                const s = resolve(ref);
                if (!(s instanceof PDFStream) || seen.has(s)) continue;
                seen.add(s);
                const subtype = s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.();
                if (subtype === 'Image') {
                    imagePixels += (s.dict.lookup(PDFName.of('Width'))?.asNumber?.() ?? 0)
                        * (s.dict.lookup(PDFName.of('Height'))?.asNumber?.() ?? 0);
                    if (s.dict.get(PDFName.of('SMask')) !== undefined) transparency = true;
                } else if (subtype === 'Form') {
                    if (s.dict.get(PDFName.of('Group')) !== undefined) transparency = true;
                    visit(s.dict.get(PDFName.of('Resources')), depth + 1);
                }
            }
        };
        visit(page.node.Resources(), 0);
        const annots = page.node.lookup(PDFName.of('Annots'));
        return { wPt, hPt, imagePixels, transparency, annotations: annots instanceof PDFArray ? annots.size() : 0 };
    });
    return { sourceBytes: bytes.length, pages };
}

/**
 * One file through one flattening operation: named terms, a per-page peak,
 * the file's peak and its output bound, under the chosen model.
 */
export function filePlan(facts, op, dpi, mode = 'hard', model = RASTER_MODEL) {
    const perPixel = jpegBytesPerPixel(mode);
    const readbackPerPixel = op === 'optimize' ? 0 : 4; // Monochrome's getImageData copy
    const pages = facts.pages.map((p) => {
        const { w, h, pixels } = pagePixels(p.wPt, p.hPt, dpi);
        const jpeg = Math.ceil(pixels * perPixel);
        const terms = {
            canvas: pixels * 4,                                  // exact
            pdfjsScratch: p.transparency ? pixels * 8 : 0,       // conservative upper bound
            sourceImageDecode: p.imagePixels * 12,               // conservative upper bound
            readback: pixels * readbackPerPixel,                 // exact
            jpeg,                                                // hard: format bound; planning: measured ratio
            dataUrl: 4 * Math.ceil(jpeg / 3) + model.dataUrlPrefix, // exact given the JPEG
            embedded: jpeg,                                      // source-derived (pdf-lib keeps the bytes)
        };
        return { w, h, pixels, terms, peak: Object.values(terms).reduce((n, v) => n + v, 0), jpeg };
    });
    const source = facts.sourceBytes * 2; // the File's ArrayBuffer and PDF.js's copy
    let retained = 0;
    let duringPages = 0;
    for (const p of pages) {
        duringPages = Math.max(duringPages, source + retained + p.peak);
        retained += p.jpeg + model.perPageOverhead;
    }
    const output = retained + model.documentOverhead;
    const save = source + retained + output;
    const bothPhase = op === 'both' ? output * 3 : 0;
    const maxPixels = Math.max(0, ...pages.map((p) => p.pixels));
    return {
        op, dpi, mode, pages, maxPixels,
        terms: { source, duringPages, save, bothPhase },
        peak: Math.max(duringPages, save, bothPhase),
        output: op === 'both' ? output + model.perPageOverhead * pages.length : output,
    };
}

/**
 * A run over several files, published the way production publishes: one
 * file → a Blob of it; several → every output kept by JSZip until
 * `generateAsync`, which accumulates chunks, concatenates them, converts to an
 * ArrayBuffer and makes a Blob (jszip/lib/stream/StreamHelper.js:46-68, 28-31).
 */
export function runPlan(files, op, dpi, limits, mode = 'hard', model = RASTER_MODEL) {
    const plans = files.map((f) => ({ name: f.name, ...filePlan(f.facts, op, dpi, mode, model) }));
    let kept = 0;
    let during = 0;
    for (const p of plans) {
        during = Math.max(during, (plans.length > 1 ? kept : 0) + p.peak);
        kept += p.output;
    }
    let publish;
    let output;
    if (plans.length === 1) {
        output = plans[0].output;
        publish = output * 2; // the bytes and the Blob made of them
    } else {
        output = kept + plans.length * model.zipEntryOverhead + model.zipOverhead;
        publish = kept + output * 4; // inputs + chunks + concatenation + ArrayBuffer/Blob
    }
    const peak = Math.max(during, publish);
    const maxPixels = Math.max(0, ...plans.map((p) => p.maxPixels));
    let status = 'READY';
    let reason = null;
    if (maxPixels > limits.maxRasterPixels) {
        status = 'OVER_RASTER_LIMIT';
        reason = `a page needs ${(maxPixels / 1e6).toFixed(1)} Mpx; the limit is ${(limits.maxRasterPixels / 1e6).toFixed(1)} Mpx`;
    } else if (peak > limits.memory) {
        status = 'OVER_MEMORY_BUDGET';
        reason = `needs ${(peak / MIB).toFixed(0)} MiB; the budget is ${(limits.memory / MIB).toFixed(0)} MiB`;
    } else if (output > limits.maxOutputBytes) {
        status = 'OVER_OUTPUT_BUDGET';
        reason = `output up to ${(output / MIB).toFixed(0)} MiB; the limit is ${(limits.maxOutputBytes / MIB).toFixed(0)} MiB`;
    }
    return { status, reason, peak, output, maxPixels, during, publish, mode, files: plans };
}

/**
 * Every term and what it rests on. Four bases, kept apart on purpose:
 *
 *   exact                      arithmetic on the code that runs
 *   source-derived upper bound read out of a pinned implementation or a format
 *   conservative upper bound   a bound chosen above anything observed, where
 *                              the implementation does not state one
 *   measured performance       observed behaviour; useful, never a guarantee
 */
export const RASTER_TERMS = Object.freeze([
    ['canvas (4·W·H)', 'exact', 'pdf-processor.ts:75-82, 117-124; canvas.width truncates'],
    ['getImageData readback (4·W·H, Monochrome/Both)', 'exact', 'pdf-processor.ts:126; modified in place'],
    ['data URL (4·⌈J/3⌉ + 23)', 'exact', 'toDataURL; one byte per base64 character'],
    ['embedded JPEG kept until save (J)', 'source-derived upper bound', 'pdf-lib JpegEmbedder keeps imageData'],
    ['save buffer (whole output)', 'source-derived upper bound', 'pdf-lib PDFWriter.serializeToBuffer: new Uint8Array(size)'],
    ['JPEG, hard model (≤ 20 B/px)', 'source-derived upper bound', 'ITU-T T.81 baseline entropy coding + byte stuffing, no subsampling'],
    ['JPEG, planning model (≤ 1.0 B/px)', 'measured performance', 'worst of six adversarial contents on one encoder (0.783 B/px) × ≥1.25 — not a bound'],
    ['JPEG encoder internal working memory', 'unknown', 'the browser encoder is not owned; nothing here bounds its scratch'],
    ['PDF.js scratch canvases (8·W·H with groups/soft masks/patterns/shadings)', 'conservative upper bound', 'pdf.mjs cachedCanvases'],
    ['source image decode (12 B per source-image pixel)', 'conservative upper bound', 'decode + bitmap + downscale scratch'],
    ['source bytes ×2', 'conservative upper bound', 'File.arrayBuffer() + PDF.js getDocument copy'],
    ['Both: Layer phase (3 × output)', 'conservative upper bound', 'load + parsed streams + new output'],
    ['single file publish (2 × output)', 'exact', 'Uint8Array + Blob'],
    ['batch: outputs kept by JSZip, then 4 × archive', 'conservative upper bound', 'StreamHelper accumulate + concat + ArrayBuffer + Blob'],
]);
