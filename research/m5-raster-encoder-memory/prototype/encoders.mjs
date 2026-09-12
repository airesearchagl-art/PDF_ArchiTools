/**
 * The encoding paths a flattening Processor operation could use, priced.
 *
 * H8 was blocked because production encodes with `canvas.toDataURL('image/jpeg',
 * 0.8)`: an encoder this architecture does not own, whose output size is bounded
 * only by the JPEG *format* (20 B/px) and whose working memory is bounded by
 * nothing. This module prices the alternatives the same way for all of them, so
 * the comparison is between models of the same shape rather than between a
 * measurement and a bound.
 *
 * Every term carries its basis. The rule this spike is held to:
 *
 *   an adopted H8 model may contain no UNKNOWN term that can materially
 *   exceed the selected memory ceiling.
 *
 * Nothing here changes production. Sizes are arithmetic; the harness measures
 * the same quantities against the real pipeline and the gate compares them.
 */

export const BASIS = {
    EXACT: 'EXACT',
    SOURCE_DERIVED_BOUND: 'SOURCE_DERIVED_BOUND',
    CONSERVATIVE_BOUND: 'CONSERVATIVE_BOUND',
    MEASURED_ONLY: 'MEASURED_ONLY',
    UNKNOWN: 'UNKNOWN',
};

/** A term in a memory or size model: what it is, how big, and why we believe it. */
export const term = (name, bytes, basis, source) => ({ name, bytes, basis, source });

// ---------------------------------------------------------------------------
// Format arithmetic
// ---------------------------------------------------------------------------

/**
 * Baseline JPEG's own worst case, per pixel (ITU-T T.81).
 *
 * Per 8x8 block: a DC coefficient of at most 16 bits of Huffman code plus 11
 * bits of value, and 63 AC coefficients of at most 16 + 10 bits each — 1665
 * bits, 208.2 B — doubled by 0xFF byte stuffing, three blocks per 64 pixels
 * without subsampling: 19.52 B/px. Rounded up. Independent of any encoder.
 */
export const JPEG_FORMAT_UPPER_BOUND = 20;

/** M5's measured worst case at q0.8. Performance evidence, never a bound. */
export const JPEG_MEASURED_WORST = 0.783;
export const JPEG_PLANNING_RATIO = 1.0;

/**
 * DEFLATE's own worst case: every block stored.
 *
 * A deflate stream can always fall back to stored blocks, so no conforming
 * encoder — pako inside pdf-lib included — can exceed this. Five bytes of
 * block header per 65535 bytes, plus zlib's two-byte header and four-byte
 * Adler-32. This is a bound on the *format*, not a measurement of pako.
 */
export function deflateUpperBound(n) {
    const blocks = Math.max(1, Math.ceil(n / 65535));
    return 2 + blocks * 5 + n + 4;
}

/** The M4 stored-PNG contract, restated so this model can price it. */
export const PNG_STORED = { maxDeflateBlockBytes: 65535, maxIdatChunkBytes: 1 << 20 };

/** Exact, by construction. The harness asserts production agrees, byte for byte. */
export function pngStoredSize(width, height) {
    const raster = height * (1 + width * 4);
    const blocks = Math.max(1, Math.ceil(raster / PNG_STORED.maxDeflateBlockBytes));
    const zlib = 2 + blocks * 5 + raster + 4;
    const idatChunks = Math.max(1, Math.ceil(zlib / PNG_STORED.maxIdatChunkBytes));
    return 8 + (12 + 13) + idatChunks * 12 + zlib + 12;
}

/** The owned PNG encoder streams: one row, written in place. */
export function pngStoredScratch(width) { return 1 + width * 4; }

/** A base64 payload's characters, and a data URL's, for the JPEG path. */
export const base64Chars = (n) => 4 * Math.ceil(n / 3);
export const jpegDataUrlChars = (n) => base64Chars(n) + 23; // "data:image/jpeg;base64,"

/** Raw 8-bit samples: the whole point of an owned image XObject. */
export const rawSampleBytes = (width, height, components) => width * height * components;

/**
 * What a PDF stream costs in the file beyond its bytes: dictionary, `stream`
 * and `endstream`, the object header and the xref entry. Conservative.
 */
export const STREAM_OVERHEAD_BYTES = 512;

// ---------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------
//
// Each prices one page of W x H device pixels through the whole lifetime:
// render, read back, convert, encode, embed, retain, save, publish. `steps` is
// what is live at once at each point; `peak` is the largest of them. `retained`
// is what survives the page, because a multi-page document holds every page's
// image until it is saved.

const CANVAS = (w, h) => term('canvas (PDF.js render target)', 4 * w * h, BASIS.EXACT, 'canvas.width * height * RGBA');
const READBACK = (w, h) => term('getImageData readback', 4 * w * h, BASIS.EXACT, 'ImageData.data');

/**
 * E1 — the production path: canvas JPEG, base64, pdf-lib embedJpg.
 *
 * `encodedBytes` is not knowable before the fact. The model therefore carries
 * two numbers and never mixes them: a fail-closed one from the format, and a
 * planning one from M5's measurements, which is evidence and not a bound. The
 * encoder's own working memory is UNKNOWN in both.
 */
function e1(width, height, mode = 'hard') {
    const px = width * height;
    const jpeg = Math.ceil(px * (mode === 'hard' ? JPEG_FORMAT_UPPER_BOUND : JPEG_PLANNING_RATIO));
    const url = jpegDataUrlChars(jpeg);
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term('JPEG bytes', jpeg, mode === 'hard' ? BASIS.SOURCE_DERIVED_BOUND : BASIS.MEASURED_ONLY,
            mode === 'hard' ? 'ITU-T T.81 entropy coding + byte stuffing' : 'M5 measured worst case x1.28'),
        term('data URL string', url, BASIS.EXACT, '4*ceil(J/3) + 23, one byte per character'),
        term('embedJpg decoded bytes', jpeg, BASIS.EXACT, 'pdf-lib decodes the base64 back to Uint8Array'),
        term('JpegEmbedder retains imageData', jpeg, BASIS.SOURCE_DERIVED_BOUND, 'JpegEmbedder.js:30, kept until save'),
        term("the browser JPEG encoder's working memory", 0, BASIS.UNKNOWN,
            'canvas.toDataURL is not owned; nothing here bounds its scratch'),
    ];
    const steps = {
        render: 4 * px,
        readback: 4 * px + 4 * px,
        encode: 4 * px + jpeg + url,
        embed: url + jpeg + jpeg,
    };
    return { terms, steps, encodedBytes: jpeg, retained: jpeg, fileBytes: jpeg + STREAM_OVERHEAD_BYTES };
}

/**
 * E2 — the owned M4 stored PNG, embedded with pdf-lib's `embedPng`.
 *
 * The encoder is owned and its output exact. The *embedding* is not: pdf-lib
 * hands the PNG to UPNG, which copies it, inflates it and expands it to RGBA,
 * pdf-lib copies that frame again and splits it into RGB and alpha, and only
 * then deflates. Every one of those allocations is readable in a pinned
 * dependency — so the path is bounded — but the exactness the owned encoder
 * bought is spent at the door, and the peak is the largest of any candidate.
 */
function e2(width, height) {
    const px = width * height;
    const png = pngStoredSize(width, height);
    const inflated = height * (1 + width * 4);
    const rgb = 3 * px;
    const alpha = px;
    const deflated = deflateUpperBound(rgb);
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term('owned stored PNG', png, BASIS.EXACT, 'pngStoredSize; encodePngStored asserts it'),
        term('PNG encoder scratch', pngStoredScratch(width), BASIS.CONSERVATIVE_BOUND, 'writes one row in place'),
        term('UPNG copy of the PNG', png, BASIS.SOURCE_DERIVED_BOUND, 'UPNG.js:211 new Uint8Array(buff)'),
        term('inflated IDAT raster', inflated, BASIS.SOURCE_DERIVED_BOUND, 'UPNG decode; stored blocks inflate to the raster'),
        term('UPNG RGBA frame', 4 * px, BASIS.SOURCE_DERIVED_BOUND, 'UPNG.js:48 new Uint8Array(area*4)'),
        term("pdf-lib's copy of the frame", 4 * px, BASIS.SOURCE_DERIVED_BOUND, 'png.js:48 new Uint8Array(frames[0])'),
        term('rgbChannel', rgb, BASIS.SOURCE_DERIVED_BOUND, 'png.js:21 splitAlphaChannel'),
        term('alphaChannel', alpha, BASIS.SOURCE_DERIVED_BOUND, 'png.js:22; dropped when fully opaque'),
        term('deflated image stream', deflated, BASIS.SOURCE_DERIVED_BOUND, 'pako.deflate; stored-block worst case'),
    ];
    const steps = {
        render: 4 * px,
        readback: 4 * px + 4 * px,
        encode: 4 * px + png + pngStoredScratch(width),
        decode: png + png + inflated + 4 * px,
        split: png + 4 * px + 4 * px + rgb + alpha,
        deflate: rgb + alpha + deflated,
    };
    return { terms, steps, encodedBytes: png, retained: deflated, fileBytes: deflated + STREAM_OVERHEAD_BYTES };
}

/**
 * E3 — an owned raw image XObject: `context.stream` with no filter.
 *
 * There is no encoder and no decoder. The samples the page already holds are
 * written into the PDF as they are, so the stream's size is the sample count:
 * exact before the page is rendered, and independent of content. `components`
 * is 1 for DeviceGray (Monochrome's output is grey) and 3 for DeviceRGB.
 *
 * `filter: 'flate'` is the same path with pdf-lib's pako in front of it: the
 * file gets much smaller on real drawings, and the size stops being exact but
 * stays bounded by DEFLATE's own stored-block worst case.
 */
function e3(width, height, components, filter) {
    const px = width * height;
    const samples = rawSampleBytes(width, height, components);
    const stored = filter === 'flate' ? deflateUpperBound(samples) : samples;
    const terms = [
        CANVAS(width, height), READBACK(width, height),
        term(`${components === 1 ? 'DeviceGray' : 'DeviceRGB'} samples`, samples, BASIS.EXACT,
            `width * height * ${components}, taken from the readback`),
    ];
    if (filter === 'flate') {
        terms.push(term('deflated stream', stored, BASIS.SOURCE_DERIVED_BOUND, 'pako.deflate; stored-block worst case'));
    } else {
        terms.push(term('stream bytes (retained until save)', stored, BASIS.EXACT, 'context.stream keeps the array as given'));
    }
    const steps = {
        render: 4 * px,
        readback: 4 * px + 4 * px,
        convert: 4 * px + samples,
        embed: filter === 'flate' ? samples + stored : stored,
    };
    return { terms, steps, encodedBytes: stored, retained: stored, fileBytes: stored + STREAM_OVERHEAD_BYTES };
}

/**
 * E4 — a bounded JPEG inside the current dependencies.
 *
 * Rejected before measurement, on a fact rather than a preference: no
 * dependency in `package.json` contains a JPEG *encoder*. pdf-lib parses JPEG
 * (JpegEmbedder) and never writes one; jsPDF embeds; pdfjs-dist decodes;
 * pako is DEFLATE. Writing one inside this spike would be adopting an encoder
 * with no independent conformance testing, and installing one is a dependency
 * decision that belongs to a Human Gate, not to a research branch.
 */
export const E4_REJECTION = {
    id: 'E4',
    rejected: true,
    reason: 'no JPEG encoder exists in the pinned dependencies, and adding or writing one '
        + 'is a dependency decision for a Human Gate; bounding an unowned encoder is what '
        + 'blocked H8 in the first place',
};

export const CANDIDATES = {
    'E1-jpeg-hard': { id: 'E1', label: 'browser JPEG (production), format bound', owned: false, components: 3, plan: (w, h) => e1(w, h, 'hard') },
    'E1-jpeg-planning': { id: 'E1', label: 'browser JPEG (production), planning estimate', owned: false, components: 3, plan: (w, h) => e1(w, h, 'planning') },
    'E2-png-embed': { id: 'E2', label: 'owned stored PNG through pdf-lib embedPng', owned: true, components: 4, plan: (w, h) => e2(w, h) },
    'E3-gray-raw': { id: 'E3', label: 'owned DeviceGray image XObject, no filter', owned: true, components: 1, plan: (w, h) => e3(w, h, 1, 'none') },
    'E3-gray-flate': { id: 'E3', label: 'owned DeviceGray image XObject, FlateDecode', owned: true, components: 1, plan: (w, h) => e3(w, h, 1, 'flate') },
    'E3-rgb-raw': { id: 'E3', label: 'owned DeviceRGB image XObject, no filter', owned: true, components: 3, plan: (w, h) => e3(w, h, 3, 'none') },
    'E3-rgb-flate': { id: 'E3', label: 'owned DeviceRGB image XObject, FlateDecode', owned: true, components: 3, plan: (w, h) => e3(w, h, 3, 'flate') },
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

/** One page, priced end to end. */
export function pagePlan(candidate, widthPt, heightPt, dpi) {
    const { width, height, pixels } = pagePixels(widthPt, heightPt, dpi);
    const plan = CANDIDATES[candidate].plan(width, height);
    const { step, live } = peakOf(plan.steps);
    return {
        candidate, width, height, pixels,
        ...plan,
        peakStep: step,
        peakBytes: live,
        bytesPerPixelEncoded: plan.encodedBytes / pixels,
        unknownTerms: plan.terms.filter((t) => t.basis === BASIS.UNKNOWN).map((t) => t.name),
    };
}

/**
 * A file of N identical pages.
 *
 * pdf-lib holds every page's image stream until `save()`, and `save()`
 * assembles the whole document in one buffer, so the peak is the last page's
 * own peak on top of everything retained, and then the save buffer on top of
 * the retained streams.
 */
export function filePlan(candidate, widthPt, heightPt, dpi, pages) {
    const page = pagePlan(candidate, widthPt, heightPt, dpi);
    const retained = page.retained * pages;
    const output = page.fileBytes * pages + 1024;
    const steps = {
        'last page': retained + page.peakBytes,
        save: retained + output,
        publish: output * 2,
    };
    const { step, live } = peakOf(steps);
    return { candidate, pages, page, retainedBytes: retained, outputBytes: output, steps, peakStep: step, peakBytes: live };
}

/**
 * A B2 batch: every successful output is held until the last file, then the
 * archive is built from all of them at once.
 */
export function batchPlan(candidate, widthPt, heightPt, dpi, pagesPerFile, files) {
    const file = filePlan(candidate, widthPt, heightPt, dpi, pagesPerFile);
    const held = file.outputBytes * files;
    const archive = held + 1024 * files;
    const steps = {
        'last file': file.outputBytes * (files - 1) + file.peakBytes,
        'zip sources': held,
        'zip output': held + archive,
        publish: archive * 2,
    };
    const { step, live } = peakOf(steps);
    return { candidate, files, file, heldBytes: held, outputBytes: archive, steps, peakStep: step, peakBytes: live };
}

/** The ceilings H9 adopted, which no memory preset may bypass. */
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

/**
 * The preflight, in the order the ceilings are checked. Each is independent:
 * raising the memory preset can never admit a raster or an output the other
 * two ceilings refuse.
 */
export function preflight(plan, { maxRasterPixels, memory, maxOutputBytes } = {}) {
    const limits = {
        maxRasterPixels: maxRasterPixels ?? CEILINGS.MAX_RASTER_PIXELS,
        memory: memory ?? CEILINGS.MEMORY_PRESETS[0],
        maxOutputBytes: maxOutputBytes ?? CEILINGS.MAX_OUTPUT_BYTES,
    };
    const pixels = plan.page ? plan.page.pixels : plan.pixels;
    if (pixels > limits.maxRasterPixels) {
        return { status: 'REFUSED', reason: REFUSAL.OVER_RASTER_LIMIT, pixels, limits };
    }
    if (plan.peakBytes > limits.memory) {
        return { status: 'REFUSED', reason: REFUSAL.OVER_MEMORY_BUDGET, peak: plan.peakBytes, limits };
    }
    if (plan.outputBytes > limits.maxOutputBytes) {
        return { status: 'REFUSED', reason: REFUSAL.OVER_OUTPUT_BUDGET, output: plan.outputBytes, limits };
    }
    return { status: 'READY', peak: plan.peakBytes, output: plan.outputBytes, limits };
}

/**
 * Whether a candidate may carry a hard memory contract at all.
 *
 * This is the rule that blocked H8, applied mechanically rather than argued:
 * an UNKNOWN term is not a small term, it is an unbounded one, and no ceiling
 * can be honoured while one is in the model.
 */
export function admissibleForHardContract(plan) {
    const unknown = plan.terms.filter((t) => t.basis === BASIS.UNKNOWN);
    const measured = plan.terms.filter((t) => t.basis === BASIS.MEASURED_ONLY);
    return {
        admissible: unknown.length === 0 && measured.length === 0,
        unknown: unknown.map((t) => t.name),
        measuredOnly: measured.map((t) => t.name),
    };
}
