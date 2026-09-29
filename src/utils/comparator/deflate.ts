/**
 * A bounded zlib / DEFLATE encoder (RFC 1950 / 1951), owned so that its worst
 * case is a property of this file rather than of a browser.
 *
 * The Comparison PDF's output bound and the encoder's working memory are part
 * of the preflight, so neither may rest on a platform compressor whose
 * internals are not a contract. Everything here is arithmetic the budget can
 * repeat:
 *
 *   - Input is cut into blocks of at most 65,535 bytes. Each block is
 *     tokenised using exactly two match distances -- 1 (a run of the previous
 *     byte) and `rowDistance` (the byte one row above) -- its fixed-Huffman
 *     cost is computed exactly, and it is written as fixed-Huffman or stored,
 *     whichever is smaller. So no block is ever larger than stored.
 *   - `ownedDeflateBound(n)` is therefore an upper bound on the whole stream,
 *     known before a byte is encoded, and `finish()` asserts it.
 *   - Working memory is fixed buffers only (`ownedDeflateScratchBytes`): no
 *     hash tables, no dynamic Huffman, nothing proportional to the image.
 *
 * Adopted from `research/m4-large-set-output-writer/harness/owned-deflate.mjs`
 * (PR #28, RF-01), where it was round-tripped through zlib on adversarial
 * inputs and the A1 corpus.
 */

/** Largest stored block DEFLATE allows, and the size every block is cut to. */
export const DEFLATE_BLOCK_BYTES = 65535;
/** Output is handed on in chunks of this size (the last may be shorter). */
export const DEFLATE_OUTPUT_CHUNK_BYTES = 65536;
/** Matches may reach back at most this far (RFC 1951 3.2.5). */
const WINDOW = 32768;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function reverseBits(code: number, length: number): number {
    let r = 0;
    let c = code;
    for (let i = 0; i < length; i += 1) {
        r = (r << 1) | (c & 1);
        c >>= 1;
    }
    return r;
}

// The fixed literal/length code (RFC 1951 3.2.6), reversed for LSB-first output.
const LIT_CODE = new Uint16Array(288);
const LIT_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s += 1) {
    let code: number;
    let length: number;
    if (s < 144) { code = 0x30 + s; length = 8; } else if (s < 256) { code = 0x190 + s - 144; length = 9; } else if (s < 280) { code = s - 256; length = 7; } else { code = 0xC0 + s - 280; length = 8; }
    LIT_CODE[s] = reverseBits(code, length);
    LIT_LEN[s] = length;
}
const LEN_SYM = new Uint16Array(259);
const LEN_SYM_EXTRA = new Uint8Array(259);
for (let l = 3; l <= 258; l += 1) {
    let i = LEN_BASE.length - 1;
    while (LEN_BASE[i] > l) i -= 1;
    LEN_SYM[l] = 257 + i;
    LEN_SYM_EXTRA[l] = LEN_EXTRA[i];
}
function distanceSymbol(d: number): number {
    let i = DIST_BASE.length - 1;
    while (DIST_BASE[i] > d) i -= 1;
    return i;
}

/**
 * The most bytes the zlib stream for `inputBytes` can take.
 *
 * Per block: at most 2 bytes for the 3 header bits and the padding a stored
 * block needs to reach a byte boundary, 4 for LEN / NLEN, then the data. Plus
 * the 2-byte zlib header and the 4-byte Adler-32. A block written as
 * fixed-Huffman was only chosen because it was no larger than this.
 *
 * The block count is every full block plus the final one, which `finish()`
 * always writes and which is empty when the input is an exact multiple of the
 * block size: floor(n / 65535) + 1, not ceil(n / 65535).
 */
export function ownedDeflateBound(inputBytes: number): number {
    const blocks = Math.floor(inputBytes / DEFLATE_BLOCK_BYTES) + 1;
    return 2 + blocks * 6 + inputBytes + 4;
}

/**
 * Every buffer the encoder allocates: history + one block, the block's token
 * list, and one output chunk.
 */
export function ownedDeflateScratchBytes(rowDistance: number): number {
    const history = rowDistance <= WINDOW ? Math.max(1, rowDistance) : 1;
    return (history + DEFLATE_BLOCK_BYTES) + DEFLATE_BLOCK_BYTES * 4 + DEFLATE_OUTPUT_CHUNK_BYTES;
}

export interface OwnedDeflateResult {
    inputBytes: number;
    encodedBytes: number;
    bound: number;
    blocksFixed: number;
    blocksStored: number;
}

export class DeflateBoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeflateBoundError';
    }
}

export class OwnedZlib {
    private readonly rowDistance: number;
    private readonly history: number;
    private readonly buf: Uint8Array;
    private readonly tokens: Uint32Array;
    private readonly onChunk: (chunk: Uint8Array) => void;
    private out: Uint8Array;
    private outPos = 0;
    private have = 0;
    private fill = 0;
    private bitBuf = 0;
    private bitCnt = 0;
    private adlerA = 1;
    private adlerB = 0;
    private total = 0;
    private written = 0;
    private fixed = 0;
    private stored = 0;
    private finished = false;

    /**
     * @param rowDistance bytes per (filtered) row; the second match distance,
     *   used only when it fits the 32 KiB window.
     * @param onChunk receives each full output chunk, and the last partial
     *   one; ownership passes to the callee.
     */
    constructor(rowDistance: number, onChunk: (chunk: Uint8Array) => void) {
        if (!Number.isInteger(rowDistance) || rowDistance < 1) {
            throw new RangeError(`rowDistance must be a positive integer: ${rowDistance}`);
        }
        this.rowDistance = rowDistance <= WINDOW ? rowDistance : 0;
        this.history = this.rowDistance > 0 ? this.rowDistance : 1;
        this.buf = new Uint8Array(this.history + DEFLATE_BLOCK_BYTES);
        this.tokens = new Uint32Array(DEFLATE_BLOCK_BYTES);
        this.onChunk = onChunk;
        this.out = new Uint8Array(DEFLATE_OUTPUT_CHUNK_BYTES);
        this.byte(0x78);
        this.byte(0x01);
    }

    /** Blocks written so far: a caller may yield when this advances. */
    get blocksWritten(): number {
        return this.fixed + this.stored;
    }

    /** Output bytes produced so far, including ones not yet handed on. */
    get bytesWritten(): number {
        return this.written;
    }

    push(data: Uint8Array): void {
        if (this.finished) throw new Error('deflate stream already finished');
        let i = 0;
        while (i < data.length) {
            const take = Math.min(DEFLATE_BLOCK_BYTES - this.fill, data.length - i);
            this.buf.set(data.subarray(i, i + take), this.history + this.fill);
            let a = this.adlerA;
            let b = this.adlerB;
            for (let k = i; k < i + take;) {
                const stop = Math.min(i + take, k + 5552);
                for (; k < stop; k += 1) {
                    a += data[k];
                    b += a;
                }
                a %= 65521;
                b %= 65521;
            }
            this.adlerA = a;
            this.adlerB = b;
            this.fill += take;
            i += take;
            if (this.fill === DEFLATE_BLOCK_BYTES) this.block(false);
        }
        this.total += data.length;
    }

    finish(): OwnedDeflateResult {
        if (this.finished) throw new Error('deflate stream already finished');
        this.block(true);
        this.align();
        this.byte((this.adlerB >>> 8) & 0xFF);
        this.byte(this.adlerB & 0xFF);
        this.byte((this.adlerA >>> 8) & 0xFF);
        this.byte(this.adlerA & 0xFF);
        if (this.outPos > 0) this.onChunk(this.out.slice(0, this.outPos));
        this.outPos = 0;
        this.finished = true;
        const bound = ownedDeflateBound(this.total);
        if (this.written > bound) {
            throw new DeflateBoundError(`deflate wrote ${this.written} bytes over its bound ${bound}`);
        }
        return {
            inputBytes: this.total,
            encodedBytes: this.written,
            bound,
            blocksFixed: this.fixed,
            blocksStored: this.stored,
        };
    }

    private byte(value: number): void {
        this.out[this.outPos] = value;
        this.outPos += 1;
        this.written += 1;
        if (this.outPos === DEFLATE_OUTPUT_CHUNK_BYTES) {
            this.onChunk(this.out);
            this.out = new Uint8Array(DEFLATE_OUTPUT_CHUNK_BYTES);
            this.outPos = 0;
        }
    }

    private bits(value: number, count: number): void {
        this.bitBuf |= value << this.bitCnt;
        this.bitCnt += count;
        while (this.bitCnt >= 8) {
            this.byte(this.bitBuf & 0xFF);
            this.bitBuf >>>= 8;
            this.bitCnt -= 8;
        }
    }

    private align(): void {
        if (this.bitCnt > 0) this.bits(0, 8 - this.bitCnt);
    }

    /** Tokenise the pending block and write it as fixed-Huffman or stored, whichever is smaller. */
    private block(final: boolean): void {
        const buf = this.buf;
        const start = this.history;
        const n = this.fill;
        const end = start + n;
        const row = this.rowDistance;
        const tokens = this.tokens;
        let count = 0;
        let fixedBits = LIT_LEN[256];
        let p = start;
        while (p < end) {
            const available = p - start + this.have;
            const maxLength = Math.min(258, end - p);
            let best = 0;
            let distance = 0;
            if (available >= 1 && maxLength >= 3) {
                let k = 0;
                while (k < maxLength && buf[p + k] === buf[p + k - 1]) k += 1;
                if (k >= 3) {
                    best = k;
                    distance = 1;
                }
            }
            if (row > 0 && available >= row && maxLength >= 3 && best < maxLength) {
                let k = 0;
                while (k < maxLength && buf[p + k] === buf[p + k - row]) k += 1;
                if (k >= 3 && k > best) {
                    best = k;
                    distance = row;
                }
            }
            if (best >= 3) {
                const ds = distanceSymbol(distance);
                tokens[count] = 0x80000000 | (distance << 9) | best;
                fixedBits += LIT_LEN[LEN_SYM[best]] + LEN_SYM_EXTRA[best] + 5 + DIST_EXTRA[ds];
                p += best;
            } else {
                tokens[count] = buf[p];
                fixedBits += LIT_LEN[buf[p]];
                p += 1;
            }
            count += 1;
        }

        const pad = (8 - ((this.bitCnt + 3) % 8)) % 8;
        const storedBits = 3 + pad + 32 + n * 8;
        this.bits(final ? 1 : 0, 1);
        if (fixedBits + 2 <= storedBits - 1) {
            this.fixed += 1;
            this.bits(1, 2);
            for (let j = 0; j < count; j += 1) {
                const token = tokens[j];
                if (token & 0x80000000) {
                    const length = token & 0x1FF;
                    const d = (token >>> 9) & 0x3FFFFF;
                    const ls = LEN_SYM[length];
                    this.bits(LIT_CODE[ls], LIT_LEN[ls]);
                    const le = LEN_SYM_EXTRA[length];
                    if (le) this.bits(length - LEN_BASE[ls - 257], le);
                    const ds = distanceSymbol(d);
                    this.bits(reverseBits(ds, 5), 5);
                    if (DIST_EXTRA[ds]) this.bits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
                } else {
                    this.bits(LIT_CODE[token], LIT_LEN[token]);
                }
            }
            this.bits(LIT_CODE[256], LIT_LEN[256]);
        } else {
            this.stored += 1;
            this.bits(0, 2);
            this.align();
            this.byte(n & 0xFF);
            this.byte((n >>> 8) & 0xFF);
            this.byte(~n & 0xFF);
            this.byte((~n >>> 8) & 0xFF);
            for (let q = start; q < end; q += 1) this.byte(buf[q]);
        }

        // The last `history` bytes stay behind for the next block's matches.
        const keep = Math.min(start, this.have + n);
        buf.copyWithin(start - keep, end - keep, end);
        this.have = keep;
        this.fill = 0;
    }
}
