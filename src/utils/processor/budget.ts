/**
 * The adopted H8 memory contract, as arithmetic.
 *
 * H8 was blocked for a round because production encoded with
 * `canvas.toDataURL('image/jpeg', 0.8)`: an encoder this codebase does not own,
 * whose output size can only be observed and whose working memory is bounded by
 * nothing. The Gate closed it by removing the encoder rather than bounding it —
 * the samples the page already holds become the image XObject — so every term
 * below is EXACT or derived from a pinned source, and none of them is a
 * measurement standing in for a bound.
 *
 * Sources, all pinned: pdf-lib 1.17.1 and the pako 1.0.11 it resolves from its
 * own node_modules, JSZip 3.10.1.
 *
 * Adopted: H8 (H8-A DeviceGray + FlateDecode, H8-B DeviceRGB raw), H9 ceilings.
 */

/** Ceilings. H9 adopted the first and the third; H8 adopted the second. */
export const MAX_RASTER_PIXELS = 134_217_728;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MEMORY_PRESETS = [512 * 1024 * 1024, 1024 * 1024 * 1024, 2048 * 1024 * 1024] as const;
export const DEFAULT_MEMORY_BUDGET = MEMORY_PRESETS[0];

export type MemoryPreset = typeof MEMORY_PRESETS[number];

/**
 * pako 1.0.11 at pdf-lib's defaults (level 6, windowBits 15, memLevel 8).
 *
 * `literalsPerBlock` is `lit_bufsize - 1`, not `lit_bufsize`: `_tr_tally`
 * increments `last_lit` and *then* returns `(s.last_lit === s.lit_bufsize - 1)`
 * (trees.js:1171, 1211), so a block is flushed on the 16,383rd literal. The
 * earlier `/16384` divisor counted one block too few at multiples of the
 * buffer size — probed at 16,382/16,383/16,384/32,766/32,767/32,768 bytes, it
 * was never exceeded but was met with zero slack three times.
 */
export const PAKO = {
    version: '1.0.11',
    litBufsize: 16_384,
    literalsPerBlock: 16_383,
    outputChunkBytes: 16_384,
} as const;

/**
 * Every array a DeflateState allocates, per call (deflate.js:1195-1221,
 * 1376-1389). Ten of them, not the four large ones alone.
 */
export const PAKO_STATE_BYTES =
    65_536 // window        Buf8(w_size * 2)
    + 65_536 // head        Buf16(hash_size)
    + 65_536 // prev        Buf16(w_size)
    + 65_536 // pending_buf Buf8(lit_bufsize * 4)
    + 573 * 2 * 2 // dyn_ltree
    + (2 * 30 + 1) * 2 * 2 // dyn_dtree
    + (2 * 19 + 1) * 2 * 2 // bl_tree
    + 16 * 2 // bl_count
    + 573 * 2 // heap
    + 573 * 2; // depth

/**
 * What pako 1.0.11 can emit for `n` bytes.
 *
 * `_tr_flush_block` falls back to a stored block whenever
 * `stored_len + 4 <= opt_lenb` (trees.js:1122-1131), so no block is worse than
 * stored: five bytes of framing over its own bytes. Plus zlib's two-byte
 * header and four-byte Adler-32.
 */
export function deflateUpperBound(n: number): number {
    const blocks = Math.max(1, Math.ceil(n / PAKO.literalsPerBlock));
    return n + 5 * blocks + 6;
}

/**
 * What pako holds while it runs, beyond its output.
 *
 * `shrinkBuf` returns `buf.subarray(0, size)` without copying (common.js:34-38),
 * so each accumulated chunk pins a whole 16 KiB buffer; `flattenChunks`
 * allocates the result while they are all still live (common.js:54-72).
 */
export function deflateWorkingBytes(n: number): number {
    const bound = deflateUpperBound(n);
    const chunks = Math.max(1, Math.ceil(bound / PAKO.outputChunkBytes));
    return PAKO_STATE_BYTES + chunks * PAKO.outputChunkBytes + bound;
}

/** Dictionary, `stream`/`endstream`, object header and xref entry. Conservative. */
const STREAM_OVERHEAD_BYTES = 512;

export type ColourSpace = 'DeviceGray' | 'DeviceRGB';
export type StreamFilter = 'flate' | 'none';

export const COMPONENTS: Record<ColourSpace, number> = { DeviceGray: 1, DeviceRGB: 3 };

export interface PageCost {
    widthPx: number;
    heightPx: number;
    pixels: number;
    /** What the PDF carries for this page. Exact when unfiltered. */
    streamBytes: number;
    outputBytes: number;
    peakBytes: number;
    peakStep: string;
}

export const pagePixels = (widthPt: number, heightPt: number, dpi: number) => {
    const widthPx = Math.floor((widthPt * dpi) / 72);
    const heightPx = Math.floor((heightPt * dpi) / 72);
    return { widthPx, heightPx, pixels: widthPx * heightPx };
};

/**
 * One flattened page, priced through its whole lifetime.
 *
 * The ordering is part of the contract, not an implementation detail: the
 * canvas is released as soon as `getImageData` has returned, *before* any
 * sample buffer is allocated. Holding it costs 11 B/px at conversion instead of
 * 7, and moves the A4 300 dpi peak from 66.4 MiB to 91.2.
 *
 * The deflate step keeps the readback live. The converter hands `flateStream`
 * its samples while the `ImageData` is still referenced by the calling frame,
 * and nothing in JavaScript promises it has been collected by then.
 */
export function pageCost(
    widthPt: number,
    heightPt: number,
    dpi: number,
    colourSpace: ColourSpace,
    filter: StreamFilter,
): PageCost {
    const { widthPx, heightPx, pixels } = pagePixels(widthPt, heightPt, dpi);
    const canvas = 4 * pixels;
    const readback = 4 * pixels;
    const samples = pixels * COMPONENTS[colourSpace];
    const streamBytes = filter === 'flate' ? deflateUpperBound(samples) : samples;

    const steps: Record<string, number> = {
        render: canvas,
        readback: canvas + readback,
        convert: readback + samples,
        embed: filter === 'flate'
            ? readback + samples + deflateWorkingBytes(samples)
            : samples,
    };
    let peakStep = 'render';
    let peakBytes = 0;
    for (const [step, live] of Object.entries(steps)) {
        if (live > peakBytes) {
            peakBytes = live;
            peakStep = step;
        }
    }
    return {
        widthPx,
        heightPx,
        pixels,
        streamBytes,
        outputBytes: streamBytes + STREAM_OVERHEAD_BYTES,
        peakBytes,
        peakStep,
    };
}

/**
 * A whole file. pdf-lib holds every page's stream until `save()`, and `save()`
 * assembles the document in one buffer.
 */
export function fileCost(pages: PageCost[]): { peakBytes: number; outputBytes: number } {
    const retained = pages.reduce((n, p) => n + p.streamBytes, 0);
    const outputBytes = pages.reduce((n, p) => n + p.outputBytes, 0) + 1024;
    const lastPagePeak = pages.length > 0 ? Math.max(...pages.map((p) => p.peakBytes)) : 0;
    return {
        peakBytes: Math.max(retained + lastPagePeak, retained + outputBytes, outputBytes * 2),
        outputBytes,
    };
}

// ---------------------------------------------------------------------------
// The batch, priced from JSZip's own path
// ---------------------------------------------------------------------------

/**
 * ZIP overhead for one entry, from the format rather than from a round number.
 *
 * A local file header is 30 bytes plus the entry name; the central directory
 * record is 46 plus the name again. JSZip writes UTF-8 names, so the name is
 * measured in **bytes**, not characters — a Japanese filename is three bytes a
 * character, and pricing it as one would let a perfectly ordinary set of files
 * walk past the ceiling.
 */
export const ZIP_LOCAL_HEADER_BYTES = 30;
export const ZIP_CENTRAL_RECORD_BYTES = 46;
export const ZIP_END_OF_DIRECTORY_BYTES = 22;

const utf8 = new TextEncoder();
export const entryNameBytes = (name: string): number => utf8.encode(name).length;

/**
 * Whether JSZip will treat this name as UTF-8.
 *
 * `generateZipParts` decides with `utfEncodedFileName.length !== file.name.length`
 * (ZipFileWorker.js:89) — true exactly when a character costs more than one
 * byte, which for a Japanese filename is every character.
 */
export const needsUnicodePath = (name: string): boolean => entryNameBytes(name) !== name.length;

/**
 * The Info-ZIP Unicode Path extra field JSZip writes for such a name:
 * `"up"` (2) + size (2) + version (1) + NameCRC32 (4) + the UTF-8 name
 * (ZipFileWorker.js:158-183). It is appended to `extraFields`, which goes into
 * **both** the local header and the central-directory record (:228, :248).
 */
export const unicodePathExtraBytes = (name: string): number => (
    needsUnicodePath(name) ? 2 + 2 + 1 + 4 + entryNameBytes(name) : 0
);

/**
 * What one entry costs beyond its content, priced against what JSZip actually
 * writes rather than against a round number.
 *
 * The name appears in both records, and so does the extra field. Pricing only
 * `2 × name` under-charges every non-ASCII filename by `2 × (9 + name)` — which
 * is the difference between a batch that fits and a batch that does not.
 */
export const zipEntryOverhead = (name: string): number =>
    ZIP_LOCAL_HEADER_BYTES + ZIP_CENTRAL_RECORD_BYTES
    + 2 * entryNameBytes(name)
    + 2 * unicodePathExtraBytes(name);

export interface BatchEntry {
    /** The name as it will appear in the archive. */
    name: string;
    bytes: number;
}

export interface BatchCost {
    sourcesBytes: number;
    archiveBytes: number;
    peakBytes: number;
    peakStep: string;
}

/**
 * B2 is a whole-job contract, and the widest moment is the handoff.
 *
 * `StreamHelper.accumulate` collects every emitted chunk in `dataArray`,
 * `concat` allocates the whole archive with `new Uint8Array(totalLength)` while
 * that array is still live, and the Blob is constructed inside the same `end`
 * handler — before `dataArray` is cleared (StreamHelper.js:46-104). So the
 * sources, the chunks, the archive and the Blob copy are live together. A model
 * that prices `sources + 2 x archive` while claiming a Blob copy elsewhere is
 * describing two different moments as one.
 */
export function batchCost(entries: BatchEntry[], manifestBytes: number): BatchCost {
    const sourcesBytes = entries.reduce((n, e) => n + e.bytes, 0);
    const overhead = entries.reduce((n, e) => n + zipEntryOverhead(e.name), 0)
        + zipEntryOverhead(MANIFEST_NAME)
        + manifestBytes
        + ZIP_END_OF_DIRECTORY_BYTES;
    const archiveBytes = sourcesBytes + overhead;
    const largestFile = entries.reduce((n, e) => Math.max(n, e.bytes), 0);

    const steps: Record<string, number> = {
        'last file produced': sourcesBytes,
        'zip accumulating': sourcesBytes + largestFile + archiveBytes,
        'zip concat': sourcesBytes + archiveBytes + archiveBytes,
        'blob handoff': sourcesBytes + archiveBytes + archiveBytes + archiveBytes,
    };
    let peakStep = 'last file produced';
    let peakBytes = 0;
    for (const [step, live] of Object.entries(steps)) {
        if (live > peakBytes) {
            peakBytes = live;
            peakStep = step;
        }
    }
    return { sourcesBytes, archiveBytes, peakBytes, peakStep };
}

export const MANIFEST_NAME = 'manifest.json';

/**
 * The longest entry name the hard model is willing to price.
 *
 * Names come from user filenames, so without a stated maximum the accounting
 * above is open-ended. 255 UTF-8 bytes is the common filesystem limit and is
 * priced in full; anything longer is refused rather than silently squeezed past
 * the ceiling.
 */
export const MAX_ENTRY_NAME_BYTES = 255;

export interface Ceilings {
    maxRasterPixels: number;
    memoryBytes: number;
    maxOutputBytes: number;
}

export const defaultCeilings = (memoryBytes: number = DEFAULT_MEMORY_BUDGET): Ceilings => ({
    maxRasterPixels: MAX_RASTER_PIXELS,
    memoryBytes,
    maxOutputBytes: MAX_OUTPUT_BYTES,
});

export type BudgetRefusal =
    | 'OVER_RASTER_LIMIT'
    | 'OVER_MEMORY_BUDGET'
    | 'OVER_OUTPUT_BUDGET'
    | null;

/**
 * The three ceilings, checked in order and independent of one another.
 *
 * Raising the memory preset can never admit a raster or an output the other two
 * refuse — which is the property the gate probes by isolating each one with the
 * other two unbounded.
 */
export function checkCeilings(
    { pixels, peakBytes, outputBytes }: { pixels: number; peakBytes: number; outputBytes: number },
    ceilings: Ceilings,
): BudgetRefusal {
    if (pixels > ceilings.maxRasterPixels) return 'OVER_RASTER_LIMIT';
    if (peakBytes > ceilings.memoryBytes) return 'OVER_MEMORY_BUDGET';
    if (outputBytes > ceilings.maxOutputBytes) return 'OVER_OUTPUT_BUDGET';
    return null;
}

/**
 * The output ceiling, applied to the artifact that actually exists.
 *
 * Planning estimates what a file will cost; this is the only check that knows.
 * Every operation passes its finished bytes through here — including 最適化
 * when it elects to hand back the source unchanged, because "we did not make it
 * bigger" is not the same claim as "this is inside the ceiling" — and the
 * answer gates the row turning green, the Blob, the download, and the file's
 * admission to a B2 archive. The archive itself is measured again on its own.
 */
export function checkActualOutput(
    actualBytes: number,
    ceilings: Ceilings,
): { ok: true } | { ok: false; reason: string } {
    if (actualBytes <= ceilings.maxOutputBytes) return { ok: true };
    return {
        ok: false,
        reason: `出力が${(actualBytes / 1048576).toFixed(1)} MiBとなり、`
            + `上限の${(ceilings.maxOutputBytes / 1048576).toFixed(0)} MiBを超えます。`
            + '書き出しは行いませんでした。',
    };
}
