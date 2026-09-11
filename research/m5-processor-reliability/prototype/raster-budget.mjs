/**
 * The Raster Budget for the flattening operations — RF-K5.
 *
 * Monochrome (A), Optimize (O1) and Both render every page to a canvas and
 * write a document of JPEGs. What that costs is decidable before the first
 * page: pixel counts follow from the page boxes and the DPI; everything else
 * is a named term below, each marked by what it rests on.
 *
 * Three ceilings, as in M4, checked in this order and independently:
 *
 *   MAX_RASTER_PIXELS     per page — the canvas a page needs
 *   MAX_OPERATION_MEMORY  per run  — the peak of everything live at once
 *   MAX_OUTPUT_BYTES      per run  — the finished file or archive
 *
 * An explicit larger memory budget is a choice a person makes; it never moves
 * either of the other two. Nothing lowers the DPI to make a job fit.
 *
 * The raster ceiling is a *policy*, not the largest canvas one machine
 * allocated: that is measured (139 Mpx allocated, 279 Mpx did not, headless
 * Chrome here) and is exactly what must not be shipped as a portable limit.
 * The candidates below sit under it, and a production implementation would
 * still probe each canvas before drawing into it and refuse if it did not
 * allocate.
 *
 * Research code. Not part of the app.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } from 'pdf-lib';

const MIB = 1024 * 1024;

export const RASTER_MODEL = Object.freeze({
    /**
     * JPEG bytes per pixel at quality 0.8 (production's setting) on the worst
     * content found: binary RGB noise, 0.783 B/px, the highest of six
     * adversarial contents (uniform and binary noise, grey and colour, and
     * one-pixel checkerboards) at two sizes on this Chrome's encoder. Rounded
     * up to at least 1.25x that for other encoders. The gate re-measures it
     * every run and fails the apparatus if it is ever exceeded.
     */
    jpegBytesPerPixelBound: 1.0,
    /** `data:image/jpeg;base64,` */
    dataUrlPrefix: 23,
    /** Page object, content stream and xref overhead per output page. A bound. */
    perPageOverhead: 2048,
    /** Header, catalog, trailer. A bound. */
    documentOverhead: 8192,
    /** JSZip STORE: local header + central directory per entry, with a long name. A bound. */
    zipEntryOverhead: 1024,
    zipOverhead: 1024,
});

export const RASTER_LIMIT_CANDIDATES = Object.freeze({
    MAX_RASTER_PIXELS: [64 * 2 ** 20, 128 * 2 ** 20, 256 * 2 ** 20],
    MAX_OPERATION_MEMORY: { default: 512 * MIB, explicit: [1024 * MIB, 2048 * MIB] },
    MAX_OUTPUT_BYTES: [256 * MIB, 512 * MIB],
});

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
 * page-sized scratch canvases (groups, soft masks, patterns).
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
 * the file's peak and its output bound.
 */
export function filePlan(facts, op, dpi, model = RASTER_MODEL) {
    const readbackPerPixel = op === 'optimize' ? 0 : 4; // Monochrome's getImageData copy
    const pages = facts.pages.map((p) => {
        const { w, h, pixels } = pagePixels(p.wPt, p.hPt, dpi);
        const jpeg = Math.ceil(pixels * model.jpegBytesPerPixelBound);
        const terms = {
            canvas: pixels * 4,                                  // exact: production's canvas
            pdfjsScratch: p.transparency ? pixels * 8 : 0,       // conservative: two page-sized PDF.js scratch canvases
            sourceImageDecode: p.imagePixels * 12,               // conservative: decode + bitmap + downscale scratch
            readback: pixels * readbackPerPixel,                 // exact: getImageData (Monochrome, Both)
            jpeg,                                                // conservative: measured worst-case bound
            dataUrl: 4 * Math.ceil(jpeg / 3) + model.dataUrlPrefix, // exact given the JPEG
            embedded: jpeg,                                      // inferred: pdf-lib JpegEmbedder keeps the bytes
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
    // pdf-lib save: every retained JPEG plus one buffer of the whole file
    // (PDFWriter.serializeToBuffer allocates `new Uint8Array(size)`).
    const save = source + retained + output;
    // Both: Layer loads Monochrome's output, keeps it, and writes a new one.
    const bothPhase = op === 'both' ? output * 3 : 0;
    const maxPixels = Math.max(0, ...pages.map((p) => p.pixels));
    return {
        op, dpi, pages, maxPixels,
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
export function runPlan(files, op, dpi, limits, model = RASTER_MODEL) {
    const plans = files.map((f) => ({ name: f.name, ...filePlan(f.facts, op, dpi, model) }));
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
    return { status, reason, peak, output, maxPixels, during, publish, files: plans };
}

/** The named terms and what each rests on — for the documents and the gate. */
export const RASTER_TERMS = Object.freeze([
    ['canvas (4·W·H)', 'exact', 'pdf-processor.ts:75-82, 117-124; canvas.width truncates'],
    ['getImageData readback (4·W·H, Monochrome/Both)', 'exact', 'pdf-processor.ts:126; modified in place, no third buffer'],
    ['PDF.js scratch canvases (8·W·H when groups, soft masks, patterns or shadings)', 'conservative', 'pdf.mjs cachedCanvases: transparent, groupAt, maskCanvas, pattern'],
    ['source image decode (12 B per source-image pixel)', 'conservative', 'decode buffer + bitmap + downscale scratch'],
    ['JPEG (≤ 1.0 B/px)', 'conservative', 'measured worst case (binary RGB noise, 0.783 B/px) × ≥1.25; re-measured every run'],
    ['data URL (4·⌈J/3⌉ + 23)', 'exact', 'toDataURL; one byte per base64 character'],
    ['embedded JPEG kept until save (J)', 'inferred', 'pdf-lib JpegEmbedder keeps imageData'],
    ['save buffer (whole output)', 'inferred', 'pdf-lib PDFWriter.serializeToBuffer: new Uint8Array(size)'],
    ['source bytes ×2', 'conservative', 'File.arrayBuffer() + PDF.js getDocument copy'],
    ['Both: Layer phase (3 × output)', 'conservative', 'load + parsed streams + new output'],
    ['single file publish (2 × output)', 'exact', 'Uint8Array + Blob'],
    ['batch: outputs kept by JSZip, then 4 × archive', 'conservative', 'StreamHelper accumulate + concat + ArrayBuffer + Blob'],
]);
