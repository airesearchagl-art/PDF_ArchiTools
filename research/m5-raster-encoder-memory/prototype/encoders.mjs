/**
 * The encoding paths a flattening Processor operation could use, priced against
 * what the code actually does.
 *
 * The first round of this spike priced the *steps* and quietly assumed the
 * canvas was gone by the time the samples were allocated. It was not: the
 * prototype released it only after the stream had been written, so the real
 * live set during conversion was canvas + ImageData + samples. Both orderings
 * are modelled here, kept apart by name, and the gate proves which one the code
 * performs.
 *
 * Every term carries its basis, and one rule decides adoption:
 *
 *   an adopted H8 model may contain no UNKNOWN term, and no term whose only
 *   basis is a measurement.
 *
 * Sources are pinned and cited per term: pdf-lib 1.17.1, its nested pako
 * 1.0.11, JSZip 3.10.1 (nested pako 1.0.11), jsPDF 3.0.4.
 */

export const BASIS = {
    EXACT: 'EXACT',
    SOURCE_DERIVED_BOUND: 'SOURCE_DERIVED_BOUND',
    CONSERVATIVE_BOUND: 'CONSERVATIVE_BOUND',
    MEASURED_ONLY: 'MEASURED_ONLY',
    UNKNOWN: 'UNKNOWN',
};

export const term = (name, bytes, basis, source) => ({ name, bytes, basis, source });

// ---------------------------------------------------------------------------
// Format and library arithmetic
// ---------------------------------------------------------------------------

/**
 * Baseline JPEG's own worst case, per pixel (ITU-T T.81): per 8x8 block a DC
 * coefficient of at most 16 + 11 bits and 63 ACs of at most 16 + 10 bits each,
 * doubled by 0xFF byte stuffing, three blocks per 64 pixels without
 * subsampling. Independent of any encoder.
 */
export const JPEG_FORMAT_UPPER_BOUND = 20;
/** M5's measured worst case at q0.8. Performance evidence, never a bound. */
export const JPEG_MEASURED_WORST = 0.783;
export const JPEG_PLANNING_RATIO = 1.0;

/**
 * pako 1.0.11, as pdf-lib and JSZip both resolve it, at pdf-lib's defaults
 * (level 6, windowBits 15, memLevel 8). Every constant below is an assignment
 * in that source, not a guess:
 *
 *   w_size      = 1 << 15                        deflate.js:1368
 *   hash_size   = 1 << (memLevel + 7) = 1 << 15  deflate.js:1371-1372
 *   window      = Buf8(w_size * 2)               deflate.js:1376   65,536 B
 *   head        = Buf16(hash_size)               deflate.js:1377   65,536 B
 *   prev        = Buf16(w_size)                  deflate.js:1378   65,536 B
 *   lit_bufsize = 1 << (memLevel + 6) = 16,384   deflate.js:1383
 *   pending_buf = Buf8(lit_bufsize * 4)          deflate.js:1385-1389  65,536 B
 *   chunkSize   = 16,384                         deflate.js (Deflate):126
 */
export const PAKO = {
    version: '1.0.11',
    windowBytes: 65536,
    headBytes: 65536,
    prevBytes: 65536,
    pendingBufBytes: 65536,
    litBufsize: 16384,
    outputChunkBytes: 16384,
};
/** The fixed deflate state, allocated once per `pako.deflate()` call. */
export const PAKO_STATE_BYTES = PAKO.windowBytes + PAKO.headBytes
    + PAKO.prevBytes + PAKO.pendingBufBytes; // 262,144

/**
 * The upper bound on what pako 1.0.11 emits, derived from its own block
 * lifecycle rather than from DEFLATE's 65,535-byte stored-block limit.
 *
 * `_tr_flush_block` (trees.js:1073-1131) computes `opt_lenb` and `static_lenb`
 * and emits a **stored** block whenever `stored_len + 4 <= opt_lenb`, so no
 * block is ever worse than stored: 5 bytes of framing (3-bit header padded to a
 * byte, then LEN and NLEN) over the block's own bytes. A block is flushed at
 * the latest when `lit_bufsize` literals have accumulated — 16,384 of them,
 * which for incompressible input is 16,384 input bytes — so that is the
 * smallest span the bound may assume. The zlib wrapper adds a 2-byte header and
 * a 4-byte Adler-32.
 */
export function deflateUpperBound(n) {
    const blocks = Math.max(1, Math.ceil(n / PAKO.litBufsize));
    return n + 5 * blocks + 6;
}

/**
 * What pako holds while deflating `n` bytes down to at most `bound`.
 *
 * `Deflate.push` allocates a fresh `Buf8(chunkSize)` every time the output
 * fills (deflate.js:243) and hands it to `onData` through `shrinkBuf`, which
 * returns **`buf.subarray(0, size)` without copying** (common.js:34-38) — so
 * every accumulated chunk pins its whole 16 KiB buffer, not just its bytes.
 * `onEnd` then calls `flattenChunks`, which allocates the result **while all
 * chunks are still live** (common.js:54-72).
 */
export function pakoDeflateTerms(n) {
    const bound = deflateUpperBound(n);
    const chunks = Math.max(1, Math.ceil(bound / PAKO.outputChunkBytes));
    const pinned = chunks * PAKO.outputChunkBytes;
    return [
        term('pako deflate state (window, head, prev, pending_buf)', PAKO_STATE_BYTES, BASIS.EXACT,
            'pako 1.0.11 deflate.js:1376-1389 at level 6 / windowBits 15 / memLevel 8'),
        term('output chunks, each pinning a full 16 KiB buffer', pinned, BASIS.SOURCE_DERIVED_BOUND,
            'deflate.js:243 + common.js:34-38 — shrinkBuf returns a subarray, so the buffer stays'),
        term('flattenChunks result, allocated while the chunks are live', bound, BASIS.SOURCE_DERIVED_BOUND,
            'common.js:54-72'),
    ];
}

/** The M4 stored-PNG contract, restated so this model can price it. */
export const PNG_STORED = { maxDeflateBlockBytes: 65535, maxIdatChunkBytes: 1 << 20 };

export function pngStoredSize(width, height) {
    const raster = height * (1 + width * 4);
    const blocks = Math.max(1, Math.ceil(raster / PNG_STORED.maxDeflateBlockBytes));
    const zlib = 2 + blocks * 5 + raster + 4;
    const idatChunks = Math.max(1, Math.ceil(zlib / PNG_STORED.maxIdatChunkBytes));
    return 8 + (12 + 13) + idatChunks * 12 + zlib + 12;
}
export const pngStoredScratch = (width) => 1 + width * 4;

export const base64Chars = (n) => 4 * Math.ceil(n / 3);
export const jpegDataUrlChars = (n) => base64Chars(n) + 23;
export const rawSampleBytes = (width, height, components) => width * height * components;

/** Dictionary, `stream`/`endstream`, object header and xref entry. Conservative. */
export const STREAM_OVERHEAD_BYTES = 512;

/**
 * V8's heap cost for an ordinary JS array of small integers, per element.
 *
 * Used only to *show* that a term is engine-dependent, never to bound one: a
 * packed SMI array stores tagged values and grows by reallocation, and neither
 * the factor nor the growth policy is specified anywhere this architecture
 * controls. Any term priced with it is UNKNOWN by construction.
 */
export const JS_ARRAY_ELEMENT_BYTES_V8 = 8;

// ---------------------------------------------------------------------------
// The per-page pipelines
// ---------------------------------------------------------------------------

const CANVAS = (w, h) => term('canvas (PDF.js render target)', 4 * w * h, BASIS.EXACT, 'canvas.width * height * RGBA');
const READBACK = (w, h) => term('getImageData readback', 4 * w * h, BASIS.EXACT, 'ImageData.data');

/**
 * Two orderings, because they are two different live sets.
 *
 * `canvas-held`   — convert and write while the canvas is still allocated.
 *                   This is what the first prototype did.
 * `canvas-released` — release the canvas (width = height = 0) as soon as the
 *                   readback exists, before any sample buffer is allocated.
 */
export const ORDERING = { HELD: 'canvas-held', RELEASED: 'canvas-released' };

/** E1 — production: canvas JPEG, base64, pdf-lib `embedJpg`. */
function e1(width, height, mode, ordering) {
    const px = width * height;
    const jpeg = Math.ceil(px * (mode === 'hard' ? JPEG_FORMAT_UPPER_BOUND : JPEG_PLANNING_RATIO));
    const url = jpegDataUrlChars(jpeg);
    const canvasLive = ordering === ORDERING.RELEASED ? 0 : 4 * px;
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term('JPEG bytes', jpeg, mode === 'hard' ? BASIS.SOURCE_DERIVED_BOUND : BASIS.MEASURED_ONLY,
            mode === 'hard' ? 'ITU-T T.81 entropy coding + byte stuffing' : 'M5 measured worst case, evidence only'),
        term('data URL string', url, BASIS.EXACT, '4*ceil(J/3) + 23, one byte per character'),
        term('embedJpg decoded bytes', jpeg, BASIS.EXACT, 'pdf-lib decodes the base64 back to a Uint8Array'),
        term('JpegEmbedder retains imageData until save', jpeg, BASIS.SOURCE_DERIVED_BOUND, 'JpegEmbedder.js:30'),
        term("the browser JPEG encoder's working memory", 0, BASIS.UNKNOWN,
            'canvas.toDataURL is not owned; nothing here bounds its scratch'),
    ];
    const steps = {
        render: 4 * px,
        readback: 8 * px,
        // toDataURL reads the canvas, so the canvas cannot be released first.
        encode: 4 * px + 4 * px + jpeg + url,
        embed: url + jpeg + jpeg,
    };
    return { terms, steps, encodedBytes: jpeg, retained: jpeg, fileBytes: jpeg + STREAM_OVERHEAD_BYTES, canvasLive };
}

/** E2 — the owned stored PNG, embedded through pdf-lib's PNG path. */
function e2(width, height, ordering) {
    const px = width * height;
    const png = pngStoredSize(width, height);
    const inflated = height * (1 + width * 4);
    const rgb = 3 * px;
    const alpha = px;
    const deflated = deflateUpperBound(rgb);
    const held = ordering === ORDERING.RELEASED ? 0 : 4 * px;
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term('owned stored PNG', png, BASIS.EXACT, 'pngStoredSize; encodePngStored asserts it'),
        term('PNG encoder scratch (one row, in place)', pngStoredScratch(width), BASIS.EXACT, 'encoderScratchBytes'),
        term('UPNG copy of the PNG', png, BASIS.SOURCE_DERIVED_BOUND, 'UPNG.js:211 new Uint8Array(buff)'),
        term('inflated IDAT raster', inflated, BASIS.SOURCE_DERIVED_BOUND, 'UPNG decode; stored blocks inflate to the raster'),
        term('UPNG RGBA frame', 4 * px, BASIS.SOURCE_DERIVED_BOUND, 'UPNG.js:48 new Uint8Array(area*4)'),
        term("pdf-lib's copy of the frame", 4 * px, BASIS.SOURCE_DERIVED_BOUND, 'png.js:48 new Uint8Array(frames[0])'),
        term('rgbChannel', rgb, BASIS.SOURCE_DERIVED_BOUND, 'png.js:21 splitAlphaChannel'),
        term('alphaChannel', alpha, BASIS.SOURCE_DERIVED_BOUND, 'png.js:22; dropped when fully opaque'),
        ...pakoDeflateTerms(rgb),
    ];
    const pako = pakoDeflateTerms(rgb).reduce((n, t) => n + t.bytes, 0);
    const steps = {
        render: 4 * px,
        readback: 8 * px,
        encode: held + 4 * px + png + pngStoredScratch(width),
        decode: png + png + inflated + 4 * px,
        split: png + 4 * px + 4 * px + rgb + alpha,
        deflate: rgb + alpha + pako,
    };
    return { terms, steps, encodedBytes: png, retained: deflated, fileBytes: deflated + STREAM_OVERHEAD_BYTES, canvasLive: held };
}

/**
 * E3 — an owned image XObject.
 *
 * `context.stream(bytes, dict)` stores the array **as given**: `typedArrayFor`
 * returns a Uint8Array unchanged (arrays.js:9-11) and `PDFRawStream` assigns it
 * to `contents` (PDFRawStream.js:10). Nothing copies it on the write path, so
 * the retained term is the samples themselves.
 */
function e3(width, height, components, filter, ordering) {
    const px = width * height;
    const samples = rawSampleBytes(width, height, components);
    const held = ordering === ORDERING.RELEASED ? 0 : 4 * px;
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term(`${components === 1 ? 'DeviceGray' : 'DeviceRGB'} samples`, samples, BASIS.EXACT,
            `width * height * ${components}, converted from the readback`),
    ];
    let stored = samples;
    const steps = { render: 4 * px, readback: 8 * px, convert: held + 4 * px + samples };
    if (filter === 'flate') {
        stored = deflateUpperBound(samples);
        const pako = pakoDeflateTerms(samples);
        terms.push(...pako);
        steps.deflate = samples + pako.reduce((n, t) => n + t.bytes, 0);
        steps.retain = stored;
    } else {
        terms.push(term('stream bytes, retained until save', samples, BASIS.EXACT,
            'context.stream keeps the array as given: arrays.js:9-11, PDFRawStream.js:10'));
        steps.embed = samples;
    }
    return { terms, steps, encodedBytes: stored, retained: stored, fileBytes: stored + STREAM_OVERHEAD_BYTES, canvasLive: held };
}

/**
 * E4 — jsPDF 3.0.4's bundled `JPEGEncoder`.
 *
 * It exists (jspdf.es.js:15515). Two facts decide its admissibility, and
 * neither is "it does not exist":
 *
 *  - **no supported path reaches it.** `jspdf.es.js` exports only AcroForm*,
 *    GState, ShadingPattern, TilingPattern and jsPDF (line 24183). The encoder
 *    is module-internal, called only by `processGIF89A` (16067), `processBMP`
 *    (16354) and `processWEBP` (20194) — i.e. reachable only by handing jsPDF a
 *    GIF, BMP or WEBP *file*. `processRGBA`, the one that takes canvas pixels,
 *    does not use it (20241-20272). Reuse would mean depending on an unexported
 *    bundled internal.
 *  - **its output cannot be bounded in memory.** `byteout = []` is an ordinary
 *    JS array pushed one byte at a time (15529, 15651) and converted with
 *    `new Uint8Array(byteout)` at the end (16016). Its heap cost is the
 *    engine's, and its growth policy is the engine's.
 */
function e4(width, height, mode, ordering) {
    const px = width * height;
    const jpeg = Math.ceil(px * (mode === 'hard' ? JPEG_FORMAT_UPPER_BOUND : JPEG_PLANNING_RATIO));
    const held = ordering === ORDERING.RELEASED ? 0 : 4 * px;
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term('rawImageData the encoder reads', 4 * px, BASIS.EXACT, 'the RGBA readback, handed in as {data, width, height}'),
        term('bitcode + category lookup arrays', 2 * 65535 * JS_ARRAY_ELEMENT_BYTES_V8, BASIS.UNKNOWN,
            'jspdf.es.js:15525-15526 new Array(65535) x2 — ordinary JS arrays'),
        term('byteout, one JS array element per output byte', jpeg * JS_ARRAY_ELEMENT_BYTES_V8, BASIS.UNKNOWN,
            'jspdf.es.js:15529, 15651 — engine-dependent storage and growth'),
        term('new Uint8Array(byteout)', jpeg, BASIS.SOURCE_DERIVED_BOUND, 'jspdf.es.js:16016'),
        term('reachable only through an unexported internal', 0, BASIS.UNKNOWN,
            'jspdf.es.js:24183 exports; call sites 16067 / 16354 / 20194 are GIF, BMP and WEBP'),
    ];
    const steps = {
        render: 4 * px,
        readback: 8 * px,
        encode: held + 4 * px + jpeg * JS_ARRAY_ELEMENT_BYTES_V8 + 2 * 65535 * JS_ARRAY_ELEMENT_BYTES_V8,
        convert: jpeg * JS_ARRAY_ELEMENT_BYTES_V8 + jpeg,
    };
    return { terms, steps, encodedBytes: jpeg, retained: jpeg, fileBytes: jpeg + STREAM_OVERHEAD_BYTES, canvasLive: held };
}

export const CANDIDATES = {
    'E1-jpeg-hard': { id: 'E1', label: 'browser JPEG (production), format bound', owned: false, components: 3, plan: (w, h, o) => e1(w, h, 'hard', o) },
    'E1-jpeg-planning': { id: 'E1', label: 'browser JPEG (production), planning estimate', owned: false, components: 3, plan: (w, h, o) => e1(w, h, 'planning', o) },
    'E2-png-embed': { id: 'E2', label: 'owned stored PNG through pdf-lib embedPng', owned: true, components: 4, plan: (w, h, o) => e2(w, h, o) },
    'E3-gray-raw': { id: 'E3', label: 'owned DeviceGray image XObject, no filter', owned: true, components: 1, plan: (w, h, o) => e3(w, h, 1, 'none', o) },
    'E3-gray-flate': { id: 'E3', label: 'owned DeviceGray image XObject, FlateDecode', owned: true, components: 1, plan: (w, h, o) => e3(w, h, 1, 'flate', o) },
    'E3-rgb-raw': { id: 'E3', label: 'owned DeviceRGB image XObject, no filter', owned: true, components: 3, plan: (w, h, o) => e3(w, h, 3, 'none', o) },
    'E3-rgb-flate': { id: 'E3', label: 'owned DeviceRGB image XObject, FlateDecode', owned: true, components: 3, plan: (w, h, o) => e3(w, h, 3, 'flate', o) },
    'E4-jspdf-hard': { id: 'E4', label: "jsPDF's bundled JPEGEncoder, format bound", owned: false, components: 3, plan: (w, h, o) => e4(w, h, 'hard', o) },
    'E4-jspdf-planning': { id: 'E4', label: "jsPDF's bundled JPEGEncoder, planning estimate", owned: false, components: 3, plan: (w, h, o) => e4(w, h, 'planning', o) },
};

// ---------------------------------------------------------------------------
// Pages, files and batches
// ---------------------------------------------------------------------------

export const pagePixels = (widthPt, heightPt, dpi) => {
    const w = Math.floor(widthPt * dpi / 72);
    const h = Math.floor(heightPt * dpi / 72);
    return { width: w, height: h, pixels: w * h };
};

const peakOf = (steps) => Object.entries(steps).reduce(
    (best, [step, live]) => (live > best.live ? { step, live } : best), { step: 'none', live: 0 },
);

export function pagePlan(candidate, widthPt, heightPt, dpi, ordering = ORDERING.RELEASED) {
    const { width, height, pixels } = pagePixels(widthPt, heightPt, dpi);
    const plan = CANDIDATES[candidate].plan(width, height, ordering);
    const { step, live } = peakOf(plan.steps);
    return {
        candidate, ordering, width, height, pixels, ...plan,
        peakStep: step,
        peakBytes: live,
        bytesPerPixelEncoded: plan.encodedBytes / pixels,
        bytesPerPixelPeak: live / pixels,
    };
}

/**
 * A file of N identical pages. pdf-lib holds every page's stream until
 * `save()`, and `save()` assembles the whole document in one buffer.
 */
export function filePlan(candidate, widthPt, heightPt, dpi, pages, ordering = ORDERING.RELEASED) {
    const page = pagePlan(candidate, widthPt, heightPt, dpi, ordering);
    const retained = page.retained * pages;
    const output = page.fileBytes * pages + 1024;
    const steps = {
        'last page': retained + page.peakBytes,
        save: retained + output,
        publish: output * 2,
    };
    const { step, live } = peakOf(steps);
    return { candidate, ordering, pages, page, retainedBytes: retained, outputBytes: output, steps, peakStep: step, peakBytes: live };
}

/**
 * A B2 batch, priced from JSZip 3.10.1's own generation path.
 *
 * `generateInternalStream` defaults to `compression: "STORE"` (object.js:321),
 * so nothing is deflated; what accumulates is copies. With `streamFiles` false
 * (object.js:320) `ZipFileWorker` buffers each file's chunks in `contentBuffer`
 * to compute its size and CRC before writing it (ZipFileWorker.js:337-339,
 * 365-366). `StreamHelper.accumulate` collects every emitted chunk in
 * `dataArray` (StreamHelper.js:79-104) and then `concat` allocates the whole
 * archive with `new Uint8Array(totalLength)` **while `dataArray` is still live**
 * (StreamHelper.js:46-62). For a Blob, `transformTo('arraybuffer', …)` returns
 * `input.buffer` without copying (utils.js:273-275); the Blob constructor then
 * copies, which is the browser's and is priced conservatively.
 */
export function batchPlan(candidate, widthPt, heightPt, dpi, pagesPerFile, files, ordering = ORDERING.RELEASED) {
    const file = filePlan(candidate, widthPt, heightPt, dpi, pagesPerFile, ordering);
    const sources = file.outputBytes * files;          // the PDFs, held until the archive
    const archive = sources + 1024 * files + 1024;     // STORE: the archive is the sources plus records
    const largestFile = file.outputBytes;              // ZipFileWorker.contentBuffer, one file at a time
    const steps = {
        'last file produced': file.outputBytes * (files - 1) + file.peakBytes,
        'zip accumulating': sources + largestFile + archive,
        'zip concat': sources + archive + archive,
        'blob handoff': sources + archive + archive,
    };
    const { step, live } = peakOf(steps);
    const terms = [
        term('output PDFs held as ZIP sources', sources, BASIS.EXACT, 'B2 holds every success until the archive'),
        term("ZipFileWorker.contentBuffer, one file's chunks", largestFile, BASIS.CONSERVATIVE_BOUND,
            'ZipFileWorker.js:337-339, 365-366 with streamFiles false'),
        term('StreamHelper dataArray, every emitted chunk', archive, BASIS.SOURCE_DERIVED_BOUND, 'StreamHelper.js:79-104'),
        term('concat result, allocated while dataArray is live', archive, BASIS.SOURCE_DERIVED_BOUND, 'StreamHelper.js:46-62'),
        term('arraybuffer view for the Blob', 0, BASIS.EXACT, 'utils.js:273-275 returns input.buffer, no copy'),
        term('Blob copy', archive, BASIS.CONSERVATIVE_BOUND, "the browser's own copy of the archive"),
    ];
    return { candidate, ordering, files, file, heldBytes: sources, outputBytes: archive, steps, terms, peakStep: step, peakBytes: live };
}

/**
 * The batch model the first round used: the largest file plus one archive.
 * Kept so the gate can show it says READY where the full model refuses.
 */
export function naiveBatchPlan(candidate, widthPt, heightPt, dpi, pagesPerFile, files, ordering = ORDERING.RELEASED) {
    const file = filePlan(candidate, widthPt, heightPt, dpi, pagesPerFile, ordering);
    const held = file.outputBytes * files;
    const steps = { 'last file': file.peakBytes, 'zip output': held + held };
    const { step, live } = peakOf(steps);
    return { candidate, files, file, outputBytes: held + 1024 * files, steps, peakStep: step, peakBytes: live, naive: true };
}

export const CEILINGS = {
    MAX_RASTER_PIXELS: 134217728,
    MAX_OUTPUT_BYTES: 256 * 1024 * 1024,
    MEMORY_PRESETS: [512 * 1024 * 1024, 1024 * 1024 * 1024, 2048 * 1024 * 1024],
};

export const REFUSAL = {
    OVER_RASTER_LIMIT: 'OVER_RASTER_LIMIT',
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
};

export function preflight(plan, { maxRasterPixels, memory, maxOutputBytes } = {}) {
    const limits = {
        maxRasterPixels: maxRasterPixels ?? CEILINGS.MAX_RASTER_PIXELS,
        memory: memory ?? CEILINGS.MEMORY_PRESETS[0],
        maxOutputBytes: maxOutputBytes ?? CEILINGS.MAX_OUTPUT_BYTES,
    };
    const pixels = plan.page ? plan.page.pixels : plan.pixels;
    if (pixels > limits.maxRasterPixels) return { status: 'REFUSED', reason: REFUSAL.OVER_RASTER_LIMIT, pixels, limits };
    if (plan.peakBytes > limits.memory) return { status: 'REFUSED', reason: REFUSAL.OVER_MEMORY_BUDGET, peak: plan.peakBytes, limits };
    if (plan.outputBytes > limits.maxOutputBytes) return { status: 'REFUSED', reason: REFUSAL.OVER_OUTPUT_BUDGET, output: plan.outputBytes, limits };
    return { status: 'READY', peak: plan.peakBytes, output: plan.outputBytes, limits };
}

/** An UNKNOWN term is not a small term; it is an unbounded one. */
export function admissibleForHardContract(plan) {
    const unknown = plan.terms.filter((t) => t.basis === BASIS.UNKNOWN);
    const measured = plan.terms.filter((t) => t.basis === BASIS.MEASURED_ONLY);
    return {
        admissible: unknown.length === 0 && measured.length === 0,
        unknown: unknown.map((t) => t.name),
        measuredOnly: measured.map((t) => t.name),
    };
}
