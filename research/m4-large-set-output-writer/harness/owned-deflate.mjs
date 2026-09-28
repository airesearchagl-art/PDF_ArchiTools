/**
 * A bounded, owned zlib/DEFLATE encoder (RFC 1950/1951) for raster rows.
 *
 * Safety-authoritative by construction, independent of any platform
 * compressor:
 *   - Input is cut into blocks of at most 65,535 bytes. Each block is
 *     tokenised (literals; matches at distance 1 = run of the previous byte,
 *     and at distance `rowDistance` = the byte above), its exact fixed-Huffman
 *     cost in bits is computed, and it is emitted as whichever of fixed-Huffman
 *     or stored is smaller. So the output never exceeds the stored size.
 *   - `ownedDeflateBound(n)` is that stored size plus framing: an exact upper
 *     bound known before any byte is encoded.
 *   - Working memory is fixed: history (rowDistance bytes) + one block (64 KiB)
 *     + its token list (4 bytes per byte) + one 64 KiB output chunk.
 *     `ownedDeflateScratchBytes(rowDistance)`.
 * No hash tables, no dynamic Huffman, no allocation proportional to the page.
 */
const BLOCK = 65535;
const OUT_CHUNK = 65536;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Fixed Huffman literal/length code (RFC 1951 3.2.6), pre-reversed for LSB-first output.
const LIT_CODE = new Uint16Array(288);
const LIT_LEN = new Uint8Array(288);
const reverse = (code, len) => {
    let r = 0;
    for (let i = 0; i < len; i += 1) { r = (r << 1) | (code & 1); code >>= 1; }
    return r;
};
for (let s = 0; s < 288; s += 1) {
    let code;
    let len;
    if (s < 144) { code = 0x30 + s; len = 8; } else if (s < 256) { code = 0x190 + s - 144; len = 9; } else if (s < 280) { code = s - 256; len = 7; } else { code = 0xC0 + s - 280; len = 8; }
    LIT_CODE[s] = reverse(code, len);
    LIT_LEN[s] = len;
}
const LEN_SYM = new Uint16Array(259);
const LEN_SYM_EXTRA = new Uint8Array(259);
for (let l = 3; l <= 258; l += 1) {
    let i = LEN_BASE.length - 1;
    while (LEN_BASE[i] > l) i -= 1;
    LEN_SYM[l] = 257 + i;
    LEN_SYM_EXTRA[l] = LEN_EXTRA[i];
}
function distSym(d) {
    let i = DIST_BASE.length - 1;
    while (DIST_BASE[i] > d) i -= 1;
    return i;
}

/** Exact worst case of the zlib stream for `n` input bytes. */
export function ownedDeflateBound(n) {
    const blocks = Math.max(1, Math.ceil(n / BLOCK));
    // 2 zlib header + per block (3 header bits + <=7 pad bits -> <=2 bytes, LEN/NLEN 4) + data + adler 4.
    return 2 + blocks * 6 + n + 4;
}

export function ownedDeflateScratchBytes(rowDistance) {
    return (rowDistance + BLOCK) + BLOCK * 4 + OUT_CHUNK;
}

export class OwnedZlib {
    /** `rowDistance`: bytes per (filtered) row; used as the second match distance when <= 32768. */
    constructor(rowDistance, onChunk) {
        this.L = rowDistance <= 32768 ? rowDistance : 0;
        this.hist = this.L > 0 ? this.L : 1;
        this.buf = new Uint8Array(this.hist + BLOCK);
        this.have = 0; // history bytes valid (0 at stream start)
        this.fill = 0; // bytes in the current block
        this.tokens = new Uint32Array(BLOCK);
        this.onChunk = onChunk;
        this.out = new Uint8Array(OUT_CHUNK);
        this.outPos = 0;
        this.bitBuf = 0;
        this.bitCnt = 0;
        this.a = 1;
        this.b = 0;
        this.total = 0;
        this.written = 0;
        this.blocksFixed = 0;
        this.blocksStored = 0;
        this.byte(0x78);
        this.byte(0x01);
    }

    byte(v) {
        this.out[this.outPos] = v;
        this.outPos += 1;
        this.written += 1;
        if (this.outPos === OUT_CHUNK) {
            this.onChunk(this.out);
            this.out = new Uint8Array(OUT_CHUNK);
            this.outPos = 0;
        }
    }

    bits(value, n) {
        this.bitBuf |= value << this.bitCnt;
        this.bitCnt += n;
        while (this.bitCnt >= 8) {
            this.byte(this.bitBuf & 0xFF);
            this.bitBuf >>>= 8;
            this.bitCnt -= 8;
        }
    }

    align() {
        if (this.bitCnt > 0) this.bits(0, 8 - this.bitCnt);
    }

    push(data) {
        let i = 0;
        while (i < data.length) {
            const take = Math.min(BLOCK - this.fill, data.length - i);
            this.buf.set(data.subarray(i, i + take), this.hist + this.fill);
            let a = this.a;
            let b = this.b;
            for (let k = i; k < i + take;) {
                const stop = Math.min(i + take, k + 5552);
                for (; k < stop; k += 1) { a += data[k]; b += a; }
                a %= 65521;
                b %= 65521;
            }
            this.a = a;
            this.b = b;
            this.fill += take;
            i += take;
            if (this.fill === BLOCK) this.block(false);
        }
        this.total += data.length;
    }

    /** Tokenise the current block and emit it as fixed-Huffman or stored, whichever is smaller. */
    block(final) {
        const buf = this.buf;
        const H = this.hist;
        const n = this.fill;
        const end = H + n;
        const L = this.L;
        const tokens = this.tokens;
        let t = 0;
        let fixedBits = 7; // end-of-block
        let p = H;
        while (p < end) {
            const avail = p - H + this.have;
            const maxLen = Math.min(258, end - p);
            let best = 0;
            let dist = 0;
            if (avail >= 1 && maxLen >= 3) {
                let k = 0;
                while (k < maxLen && buf[p + k] === buf[p + k - 1]) k += 1;
                if (k >= 3) { best = k; dist = 1; }
            }
            if (L > 0 && avail >= L && maxLen >= 3 && best < maxLen) {
                let k = 0;
                while (k < maxLen && buf[p + k] === buf[p + k - L]) k += 1;
                if (k >= 3 && k > best) { best = k; dist = L; }
            }
            if (best >= 3) {
                const ds = distSym(dist);
                tokens[t] = 0x80000000 | (dist << 9) | best;
                fixedBits += LIT_LEN[LEN_SYM[best]] + LEN_SYM_EXTRA[best] + 5 + DIST_EXTRA[ds];
                p += best;
            } else {
                tokens[t] = buf[p];
                fixedBits += LIT_LEN[buf[p]];
                p += 1;
            }
            t += 1;
        }
        const pad = (8 - ((this.bitCnt + 3) % 8)) % 8;
        const storedBits = 3 + pad + 32 + n * 8;
        if (fixedBits + 3 <= storedBits) {
            this.blocksFixed += 1;
            this.bits(final ? 1 : 0, 1);
            this.bits(1, 2);
            for (let j = 0; j < t; j += 1) {
                const tok = tokens[j];
                if (tok & 0x80000000) {
                    const len = tok & 0x1FF;
                    const d = (tok >>> 9) & 0x3FFFFF;
                    const ls = LEN_SYM[len];
                    this.bits(LIT_CODE[ls], LIT_LEN[ls]);
                    const le = LEN_SYM_EXTRA[len];
                    if (le) this.bits(len - LEN_BASE[ls - 257], le);
                    const ds = distSym(d);
                    this.bits(reverse(ds, 5), 5);
                    if (DIST_EXTRA[ds]) this.bits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
                } else {
                    this.bits(LIT_CODE[tok], LIT_LEN[tok]);
                }
            }
            this.bits(LIT_CODE[256], LIT_LEN[256]);
        } else {
            this.blocksStored += 1;
            this.bits(final ? 1 : 0, 1);
            this.bits(0, 2);
            this.align();
            this.byte(n & 0xFF);
            this.byte(n >>> 8);
            this.byte(~n & 0xFF);
            this.byte((~n >>> 8) & 0xFF);
            for (let q = H; q < end; q += 1) this.byte(buf[q]);
        }
        // Keep the last `hist` bytes as history for the next block.
        const keep = Math.min(H, this.have + n);
        buf.copyWithin(H - keep, end - keep, end);
        this.have = keep;
        this.fill = 0;
    }

    finish() {
        this.block(true);
        this.align();
        this.byte((this.b >>> 8) & 0xFF);
        this.byte(this.b & 0xFF);
        this.byte((this.a >>> 8) & 0xFF);
        this.byte(this.a & 0xFF);
        if (this.outPos > 0) this.onChunk(this.out.slice(0, this.outPos));
        const bound = ownedDeflateBound(this.total);
        if (this.written > bound) {
            throw new Error(`owned deflate wrote ${this.written} > bound ${bound}`);
        }
        return { encodedBytes: this.written, inputBytes: this.total, bound, blocksFixed: this.blocksFixed, blocksStored: this.blocksStored };
    }
}
