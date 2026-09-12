/**
 * The encoding paths a flattening Processor operation could use, priced against
 * what the code actually does.
 *
 * Two rounds of correction are baked in here, and both are worth stating
 * because both were cases of the model being tidier than the program:
 *
 *  - the canvas was released only after the stream was written, so the live set
 *    during conversion was canvas + ImageData + samples, not the readback alone;
 *  - the deflate path was priced as if the readback were already gone and as if
 *    pako's state were four arrays and its blocks 16,384 literals long. None of
 *    those was true.
 *
 * Every term carries its basis, and one rule decides adoption:
 *
 *   an adopted H8 model may contain no UNKNOWN term, and no term whose only
 *   basis is a measurement.
 *
 * Sources are pinned and cited per term: pdf-lib 1.17.1, the pako 1.0.11 it
 * resolves from its own node_modules, JSZip 3.10.1, jsPDF 3.0.4.
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

export const JPEG_FORMAT_UPPER_BOUND = 20;
export const JPEG_MEASURED_WORST = 0.783;
export const JPEG_PLANNING_RATIO = 1.0;

/**
 * pako 1.0.11 at pdf-lib's defaults (level 6, windowBits 15, memLevel 8).
 * Every constant is an assignment in that source.
 *
 *   w_size          = 1 << 15                       deflate.js:1368
 *   hash_size       = 1 << (memLevel + 7)           deflate.js:1371-1372
 *   lit_bufsize     = 1 << (memLevel + 6) = 16,384  deflate.js:1383
 *   LENGTH_CODES 29, LITERALS 256 → L_CODES 286, HEAP_SIZE 573
 *                                                   deflate.js:89-99
 *   chunkSize       = 16,384                        lib/deflate.js:126
 */
export const PAKO = {
    version: '1.0.11',
    litBufsize: 16384,
    /**
     * How many literals a block actually holds.
     *
     * `_tr_tally` increments `last_lit` and then returns
     * `(s.last_lit === s.lit_bufsize - 1)` (trees.js:1171, 1211), so the flush
     * is requested on the **16,383rd** literal, not the 16,384th. For
     * incompressible input — one literal per byte — that is the largest number
     * of input bytes a block can cover, and it is the divisor the block count
     * has to use.
     */
    literalsPerBlock: 16383,
    outputChunkBytes: 16384,
    windowBytes: 65536,      // Buf8(w_size * 2)                  deflate.js:1376
    headBytes: 65536,        // Buf16(hash_size)                  deflate.js:1377
    prevBytes: 65536,        // Buf16(w_size)                     deflate.js:1378
    pendingBufBytes: 65536,  // Buf8(lit_bufsize * 4)             deflate.js:1385-1389
};

/**
 * Every array a DeflateState allocates, not only the four large ones.
 *
 * The first round called 262,144 B "the pako state"; it is the four big
 * buffers and nothing else. These six Huffman-tree arrays are allocated per
 * call too (deflate.js:1195-1221), all `Buf16`, two bytes an element.
 */
export const PAKO_STATE_TERMS = [
    term('window', PAKO.windowBytes, BASIS.EXACT, 'deflate.js:1376, Buf8(w_size * 2)'),
    term('head', PAKO.headBytes, BASIS.EXACT, 'deflate.js:1377, Buf16(hash_size)'),
    term('prev', PAKO.prevBytes, BASIS.EXACT, 'deflate.js:1378, Buf16(w_size)'),
    term('pending_buf', PAKO.pendingBufBytes, BASIS.EXACT, 'deflate.js:1385-1389, Buf8(lit_bufsize * 4)'),
    term('dyn_ltree', 573 * 2 * 2, BASIS.EXACT, 'deflate.js:1195, Buf16(HEAP_SIZE * 2)'),
    term('dyn_dtree', (2 * 30 + 1) * 2 * 2, BASIS.EXACT, 'deflate.js:1196, Buf16((2*D_CODES+1) * 2)'),
    term('bl_tree', (2 * 19 + 1) * 2 * 2, BASIS.EXACT, 'deflate.js:1197, Buf16((2*BL_CODES+1) * 2)'),
    term('bl_count', 16 * 2, BASIS.EXACT, 'deflate.js:1207, Buf16(MAX_BITS + 1)'),
    term('heap', 573 * 2, BASIS.EXACT, 'deflate.js:1211, Buf16(2*L_CODES + 1)'),
    term('depth', 573 * 2, BASIS.EXACT, 'deflate.js:1220, Buf16(2*L_CODES + 1)'),
];
export const PAKO_STATE_BYTES = PAKO_STATE_TERMS.reduce((n, t) => n + t.bytes, 0);

/**
 * The upper bound on what pako 1.0.11 emits, from its own block lifecycle.
 *
 * `_tr_flush_block` emits a **stored** block whenever `stored_len + 4 <=
 * opt_lenb` (trees.js:1122-1131), so no block is worse than stored: five bytes
 * of framing over its own bytes. A block covers at most `literalsPerBlock`
 * input bytes when nothing compresses (trees.js:1211). The zlib wrapper adds a
 * two-byte header and a four-byte Adler-32.
 */
export function deflateUpperBound(n) {
    const blocks = Math.max(1, Math.ceil(n / PAKO.literalsPerBlock));
    return n + 5 * blocks + 6;
}

/**
 * The bound as the previous round stated it, dividing by `lit_bufsize` itself.
 * Kept so the gate can show where the two differ and whether any measured case
 * actually breaks it.
 */
export function oldDeflateUpperBound(n) {
    const blocks = Math.max(1, Math.ceil(n / PAKO.litBufsize));
    return n + 5 * blocks + 6;
}

/**
 * What pako holds while deflating `n` bytes.
 *
 * `Deflate.push` allocates a fresh `Buf8(chunkSize)` every time the output
 * fills (lib/deflate.js:243) and hands it on through `shrinkBuf`, which returns
 * `buf.subarray(0, size)` **without copying** (common.js:34-38) — so every
 * accumulated chunk pins its whole 16 KiB buffer. `onEnd` then calls
 * `flattenChunks`, which allocates the result while all the chunks are still
 * live (common.js:54-72).
 */
export function pakoDeflateTerms(n) {
    const bound = deflateUpperBound(n);
    const chunks = Math.max(1, Math.ceil(bound / PAKO.outputChunkBytes));
    return [
        term('pako per-call state (10 arrays)', PAKO_STATE_BYTES, BASIS.EXACT,
            'pako 1.0.11 deflate.js:1195-1221, 1376-1389'),
        term('output chunks, each pinning a full 16 KiB buffer', chunks * PAKO.outputChunkBytes,
            BASIS.SOURCE_DERIVED_BOUND, 'lib/deflate.js:243 + common.js:34-38, subarray not copy'),
        term('flattenChunks result, allocated while the chunks are live', bound,
            BASIS.SOURCE_DERIVED_BOUND, 'common.js:54-72'),
    ];
}
const pakoDeflateBytes = (n) => pakoDeflateTerms(n).reduce((acc, t) => acc + t.bytes, 0);

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

export const STREAM_OVERHEAD_BYTES = 512;
export const JS_ARRAY_ELEMENT_BYTES_V8 = 8;

// ---------------------------------------------------------------------------
// The per-page pipelines
// ---------------------------------------------------------------------------

const CANVAS = (w, h) => term('canvas (PDF.js render target)', 4 * w * h, BASIS.EXACT, 'canvas.width * height * RGBA');
const READBACK = (w, h) => term('getImageData readback', 4 * w * h, BASIS.EXACT, 'ImageData.data');

export const ORDERING = { HELD: 'canvas-held', RELEASED: 'canvas-released' };

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
        encode: 4 * px + 4 * px + jpeg + url,
        embed: url + jpeg + jpeg,
    };
    return { terms, steps, encodedBytes: jpeg, retained: jpeg, fileBytes: jpeg + STREAM_OVERHEAD_BYTES, canvasLive };
}

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
    const steps = {
        render: 4 * px,
        readback: 8 * px,
        encode: held + 4 * px + png + pngStoredScratch(width),
        decode: png + png + inflated + 4 * px,
        split: png + 4 * px + 4 * px + rgb + alpha,
        deflate: rgb + alpha + pakoDeflateBytes(rgb),
    };
    return { terms, steps, encodedBytes: png, retained: deflated, fileBytes: deflated + STREAM_OVERHEAD_BYTES, canvasLive: held };
}

/**
 * E3 — an owned image XObject.
 *
 * `context.stream(bytes, dict)` stores the array as given: `typedArrayFor`
 * returns a Uint8Array unchanged (arrays.js:9-11) and `PDFRawStream` assigns it
 * to `contents` (PDFRawStream.js:10).
 *
 * The deflate step is priced with the **readback still live**. The prototype
 * converts the readback into samples and then calls `flateStream` with the
 * `ImageData` still referenced by the calling frame; nothing in JavaScript
 * promises it is collected in between, so a fail-closed model must assume it is
 * not. Releasing it is a restructuring a production implementation could make —
 * and would have to make explicitly, and prove — before claiming the smaller
 * number.
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
        terms.push(...pakoDeflateTerms(samples));
        terms.push(term('the readback, still reachable while deflate runs', 4 * px, BASIS.CONSERVATIVE_BOUND,
            'the prototype holds the ImageData across the flateStream call'));
        steps.deflate = 4 * px + samples + pakoDeflateBytes(samples);
        steps.retain = stored;
    } else {
        terms.push(term('stream bytes, retained until save', samples, BASIS.EXACT,
            'context.stream keeps the array as given: arrays.js:9-11, PDFRawStream.js:10'));
        steps.embed = samples;
    }
    return { terms, steps, encodedBytes: stored, retained: stored, fileBytes: stored + STREAM_OVERHEAD_BYTES, canvasLive: held };
}

/**
 * E4 — jsPDF 3.0.4's bundled `JPEGEncoder` (jspdf.es.js:15515).
 *
 * It exists. It is inadmissible for two reasons, neither of them absence: no
 * supported path reaches it with raw pixels (not exported at :24183, called
 * only by processGIF89A/processBMP/processWEBP, each taking an encoded image
 * file, while `processRGBA` does not use it), and its output is built in an
 * ordinary JS array one byte at a time (15529, 15651) before
 * `new Uint8Array(byteout)` (16016).
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
 * `generateInternalStream` defaults to `compression: "STORE"` and
 * `streamFiles: false` (object.js:320-321). `StreamHelper.accumulate` collects
 * every emitted chunk in `dataArray`, `concat` allocates the whole archive with
 * `new Uint8Array(totalLength)` **while `dataArray` is still live**, and only
 * the `end` handler afterwards clears it (StreamHelper.js:46-104). The Blob is
 * constructed inside that same handler, from `input.buffer` — which copies
 * nothing (utils.js:273-275) — but the Blob itself is the browser's own copy.
 *
 * So the widest live set is all four at once: the sources the batch still
 * holds, the accumulated chunks, the concatenated archive, and the Blob copy.
 * Pricing `sources + 2 × archive` while separately claiming a Blob copy
 * describes two different moments as if they were one.
 */
export function batchPlan(candidate, widthPt, heightPt, dpi, pagesPerFile, files, ordering = ORDERING.RELEASED) {
    const file = filePlan(candidate, widthPt, heightPt, dpi, pagesPerFile, ordering);
    const sources = file.outputBytes * files;
    const archive = sources + 1024 * files + 1024;
    const largestFile = file.outputBytes;
    const steps = {
        'last file produced': file.outputBytes * (files - 1) + file.peakBytes,
        'zip accumulating': sources + largestFile + archive,
        'zip concat': sources + archive + archive,
        'blob handoff': sources + archive + archive + archive,
    };
    const { step, live } = peakOf(steps);
    const terms = [
        term('output PDFs held as ZIP sources', sources, BASIS.EXACT, 'B2 holds every success until the archive'),
        term("ZipFileWorker.contentBuffer, one file's chunks", largestFile, BASIS.CONSERVATIVE_BOUND,
            'ZipFileWorker.js:337-339, 365-366 with streamFiles false'),
        term('StreamHelper dataArray, every emitted chunk', archive, BASIS.SOURCE_DERIVED_BOUND,
            'StreamHelper.js:79-104; cleared only in the end handler'),
        term('concat result, allocated while dataArray is live', archive, BASIS.SOURCE_DERIVED_BOUND, 'StreamHelper.js:46-62'),
        term('arraybuffer view for the Blob', 0, BASIS.EXACT, 'utils.js:273-275 returns input.buffer, no copy'),
        term('Blob copy, built before dataArray is cleared', archive, BASIS.CONSERVATIVE_BOUND, "the browser's own copy of the archive"),
    ];
    return { candidate, ordering, files, file, heldBytes: sources, outputBytes: archive, steps, terms, peakStep: step, peakBytes: live };
}

/**
 * The batch model the previous round used: sources plus two archives, with a
 * Blob copy listed as a term but never in any step. Kept so the gate can show
 * the file count where the two disagree.
 */
export function oldBatchPlan(candidate, widthPt, heightPt, dpi, pagesPerFile, files, ordering = ORDERING.RELEASED) {
    const file = filePlan(candidate, widthPt, heightPt, dpi, pagesPerFile, ordering);
    const sources = file.outputBytes * files;
    const archive = sources + 1024 * files + 1024;
    const steps = {
        'last file produced': file.outputBytes * (files - 1) + file.peakBytes,
        'zip accumulating': sources + file.outputBytes + archive,
        'zip concat': sources + archive + archive,
    };
    const { step, live } = peakOf(steps);
    return { candidate, files, file, outputBytes: archive, steps, peakStep: step, peakBytes: live, old: true };
}

/** One page priced as if a file were one page: the simplest wrong model. */
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

export function admissibleForHardContract(plan) {
    const unknown = plan.terms.filter((t) => t.basis === BASIS.UNKNOWN);
    const measured = plan.terms.filter((t) => t.basis === BASIS.MEASURED_ONLY);
    return {
        admissible: unknown.length === 0 && measured.length === 0,
        unknown: unknown.map((t) => t.name),
        measuredOnly: measured.map((t) => t.name),
    };
}
