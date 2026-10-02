/**
 * The Optimizer v2 Stage-1 memory contract, as arithmetic (D-028, Policy R).
 *
 * Two kinds of term live here, and they are kept apart on purpose:
 *
 *   FIXED     known before the work starts — the source size, the parse, the
 *             largest image's working set. Checked before anything is mutated.
 *   RUNTIME   what depends on how well things compress — replacement streams,
 *             writer chunks, the publication Blob. Held in a ledger and
 *             checked on actual bytes as they are produced; a run that would
 *             pass the budget is abandoned and publishes nothing.
 *
 * Every constant is either counted from pinned pako 2.1.0 / pdf-lib 1.17.1
 * source or stated as a conservative allowance. None of it is a promise about
 * the browser: the budget is what this run allows itself, not a guarantee of
 * what the browser can give it.
 *
 * pako 2.1.0 is the top-level dependency Optimizer v2 compresses with. The
 * `PAKO` / `PAKO_STATE_BYTES` / `deflateUpperBound` in `budget.ts` describe the
 * pako **1.0.11** that pdf-lib resolves for itself, and are not used here.
 * No worst-case output bound for pako 2.1.0 is claimed either: a candidate is
 * held to a cap at run time instead (see `image-optimize.ts`).
 */
import { PLAN_STATUS, ProcessorError } from './contracts';

/**
 * The share of the chosen preset Optimizer v2 lets itself plan against.
 *
 * Stage 1 keeps a quarter of the preset unclaimed: the per-object constant is
 * sized on a synthetic corpus, and browser heap, GC timing and Blob storage were
 * never measured. The margin is stated rather than hidden in a constant, and it
 * is what refuses a ~250 MiB source at 512 MiB (its parse instant alone is
 * about 499 MiB) while admitting it at 1 GiB.
 */
export const OPTIMIZE_USABLE_NUMERATOR = 3;
export const OPTIMIZE_USABLE_DENOMINATOR = 4;

export const usableBytes = (memoryBytes: number): number => Math.floor(
    (memoryBytes * OPTIMIZE_USABLE_NUMERATOR) / OPTIMIZE_USABLE_DENOMINATOR,
);

/**
 * What pdf-lib holds per parsed object beyond stream contents.
 *
 * CONSERVATIVE ALLOWANCE, not a derivation: twice the largest per-object growth
 * the Optimizer v2 research measured on its synthetic corpus (about 10 KB, for
 * an object carrying a font), rounded up. Real files may differ; the 25% margin
 * above is what this constant leans on.
 */
export const PER_OBJECT_BYTES = 20_480;

/** pako 2.1.0 output and state, counted from its source. */
export const PAKO2 = {
    version: '2.1.0',
    /** `Deflate` default `chunkSize` (lib/deflate.js:115). */
    deflateChunkBytes: 16_384,
    /** `Inflate` default `chunkSize` (lib/inflate.js:103). */
    inflateChunkBytes: 65_536,
} as const;

/**
 * Every array `deflateInit2` allocates at level 9 / windowBits 15 / memLevel 8
 * (lib/zlib/deflate.js).
 */
export const PAKO2_DEFLATE_STATE_BYTES =
    2 * 32_768 // window      Uint8Array(w_size * 2)                       :1505
    + 2 * 32_768 // head      Uint16Array(hash_size = 1 << (memLevel + 7)) :1501, :1506
    + 2 * 32_768 // prev      Uint16Array(w_size)                          :1507
    + 4 * 16_384 // pending   Uint8Array(lit_bufsize * 4)                  :1512, :1553-1554
    + 2 * 573 * 2 // dyn_ltree Uint16Array(HEAP_SIZE * 2)                  :1296
    + 2 * 61 * 2 // dyn_dtree Uint16Array((2 * D_CODES + 1) * 2)           :1297
    + 2 * 39 * 2 // bl_tree   Uint16Array((2 * BL_CODES + 1) * 2)          :1298
    + 2 * 16 // bl_count      Uint16Array(MAX_BITS + 1)                    :1308
    + 2 * 573 // heap         Uint16Array(2 * L_CODES + 1)                 :1312
    + 2 * 573; // depth       Uint16Array(2 * L_CODES + 1)                 :1321

/**
 * Every array `inflateInit2` / `updatewindow` allocates at windowBits 15
 * (lib/zlib/inflate.js), plus the fixed tables built once per module.
 */
export const PAKO2_INFLATE_STATE_BYTES =
    2 * 320 // lens        Uint16Array(320)              :146
    + 2 * 288 // work      Uint16Array(288)              :147
    + 4 * 852 // lencode   Int32Array(ENOUGH_LENS)       :194
    + 4 * 592 // distcode  Int32Array(ENOUGH_DISTS)      :195
    + 4 * 512 // lenfix    Int32Array(512), once         :296
    + 4 * 32 // distfix    Int32Array(32), once          :297
    + 32_768 // window     Uint8Array(wsize)             :350
    + 4; // hbuf           Uint8Array(4)                 :402

export interface StreamFacts {
    /** Indirect objects pdf-lib holds after parsing. */
    objects: number;
    /** Σ stream contents pdf-lib copied out of the source while parsing. */
    streamBytes: number;
}

/**
 * Before the file is read: the parse instant.
 *
 * pdf-lib copies every stream out of the buffer it parses (PDFObjectParser
 * `bytes.slice`), so at the moment `load` returns the source and the copies
 * are both live — ≤ 2 × S — plus the parsed objects. The object count comes
 * from the trailer's `/Size`, which bounds every object number the file can
 * use; when it cannot be read, nothing here can bound the parse and the run is
 * refused.
 */
export function preParseNeed(sourceBytes: number, trailerSize: number): number {
    return 2 * sourceBytes + trailerSize * PER_OBJECT_BYTES;
}

/** After the parse, with the source released: what the document itself holds. */
export function parsedFixedBytes(facts: StreamFacts): number {
    return facts.streamBytes + facts.objects * PER_OBJECT_BYTES;
}

export interface ImageWorkShape {
    /** Bytes of the exactly-decoded samples (and predictor tags, if any). */
    decodedBytes: number;
    /** The image's current stream length. */
    streamBytes: number;
    /** One row of the widest representation tried, filter byte included. */
    rowBytes: number;
}

/**
 * One image's working set, priced whole and before it starts.
 *
 *   decoded samples
 *   + the best candidate kept so far (kept only if smaller than the stream,
 *     so ≤ the stream, in whole 16 KiB chunks)
 *   + the candidate being compressed (held by the run-time cap to the same
 *     bound, plus the one chunk that may be in flight when it trips)
 *   + pako Deflate and Inflate state and their output chunks
 *   + the predictor's scratch rows (six rows: previous, current, and the four
 *     adaptive trials beyond the chosen one)
 *
 * No representation is materialised whole: R1 and R2 forms are produced a row
 * block at a time and fed to pako as they are made.
 */
export function imageWorkBytes(shape: ImageWorkShape): number {
    const chunked = (n: number) => Math.ceil(n / PAKO2.deflateChunkBytes) * PAKO2.deflateChunkBytes;
    const kept = chunked(shape.streamBytes);
    const inProgress = chunked(shape.streamBytes) + PAKO2.deflateChunkBytes;
    return shape.decodedBytes
        + kept
        + inProgress
        + PAKO2_DEFLATE_STATE_BYTES + PAKO2.deflateChunkBytes
        + PAKO2_INFLATE_STATE_BYTES + PAKO2.inflateChunkBytes
        + ROW_BLOCK_ROWS * shape.rowBytes
        + 6 * shape.rowBytes;
}

/** Rows handed to pako per push: the unit of yield, cancellation and cap. */
export const ROW_BLOCK_ROWS = 64;

export type AdmissionRefusal = { ok: false; needBytes: number; usableBytes: number };
export type Admission = { ok: true; needBytes: number; usableBytes: number } | AdmissionRefusal;

export function admitPreParse(sourceBytes: number, trailerSize: number, memoryBytes: number): Admission {
    const need = preParseNeed(sourceBytes, trailerSize);
    const usable = usableBytes(memoryBytes);
    return need <= usable ? { ok: true, needBytes: need, usableBytes: usable } : { ok: false, needBytes: need, usableBytes: usable };
}

/**
 * The run-time half of Policy R.
 *
 * Starts from the fixed cost of the parsed document. Every allocation that
 * carries memory is committed **before** it is made, and `commit` refuses —
 * throws OVER_MEMORY_BUDGET — rather than let the ledger pass the usable
 * share. `release` returns what was let go.
 */
export class OptimizeLedger {
    readonly usable: number;

    private held: number;

    private peak: number;

    constructor(memoryBytes: number, fixedBytes: number) {
        this.usable = usableBytes(memoryBytes);
        this.held = fixedBytes;
        this.peak = fixedBytes;
    }

    get heldBytes(): number { return this.held; }

    get peakBytes(): number { return this.peak; }

    /** Whether `more` bytes could be held on top of what is held now. */
    fits(more: number): boolean {
        return this.held + more <= this.usable;
    }

    /** Charge `bytes` before they are allocated. Never lets `held` pass `usable`. */
    commit(bytes: number, what = 'この処理'): void {
        if (!(bytes >= 0) || this.held + bytes > this.usable) {
            throw new ProcessorError(
                `${what}に約${Math.ceil(bytes / 1048576)} MiBが必要で、すでに確保している約${Math.ceil(this.held / 1048576)} MiBと合わせると、`
                + `最適化に使える${Math.floor(this.usable / 1048576)} MiBを超えます。処理を中止しました（書き出しは行っていません）。`
                + '処理メモリ上限を上げてから実行してください。',
                PLAN_STATUS.OVER_MEMORY_BUDGET,
            );
        }
        this.held += bytes;
        if (this.held > this.peak) this.peak = this.held;
    }

    release(bytes: number): void {
        this.held -= bytes;
    }
}

/**
 * The human-adopted publication threshold: an optimized derivative is handed
 * over only when it is at least 1% smaller than the source.
 *
 * Integer arithmetic, so the boundary is exact: output × 100 ≤ source × 99.
 * Both sides stay far below 2^53 for any file this tool admits.
 */
export const PUBLISH_THRESHOLD_PERCENT = 1;

export function meetsPublicationThreshold(outputBytes: number, sourceBytes: number): boolean {
    return outputBytes * 100 <= sourceBytes * (100 - PUBLISH_THRESHOLD_PERCENT);
}
