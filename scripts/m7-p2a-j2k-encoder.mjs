/**
 * A minimal JPEG 2000 (ITU-T T.800 / ISO 15444-1) codestream encoder, for test
 * fixtures only.
 *
 * The M7-P2-A gate has to show that a JPX-compressed scan renders and can be
 * read once PDF.js has its decoder files, and does not without them. That
 * needs a JPX image whose content is known, generated in CI like every other
 * fixture, without a network or a native tool. Nothing in the repository or
 * its dependencies encodes JPEG 2000, so this does, in the simplest legal
 * form: one tile, one 8-bit grey component, no wavelet decomposition (the
 * reversible 5-3 path with zero levels, so the coefficients are the
 * level-shifted samples), no quantization, 64x64 code-blocks, one quality
 * layer, every coding pass in one MQ codeword per code-block. The result is
 * lossless; the gate checks that by decoding it back.
 *
 * Section references are to T.800 (Annex B: packets, C: the MQ coder,
 * D: coefficient bit modelling).
 */

// ---------------------------------------------------------------------------
// C.2: the MQ arithmetic encoder
// ---------------------------------------------------------------------------

// Table C.2: Qe, NMPS, NLPS, SWITCH for each of the 47 states.
const QE = [
    [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0],
    [0x0221, 38, 33, 0], [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0],
    [0x3001, 11, 17, 0], [0x2401, 12, 18, 0], [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1],
    [0x5401, 16, 14, 0], [0x5101, 17, 15, 0], [0x4801, 18, 16, 0], [0x3801, 19, 17, 0], [0x3401, 20, 18, 0],
    [0x3001, 21, 19, 0], [0x2801, 22, 19, 0], [0x2401, 23, 20, 0], [0x2201, 24, 21, 0], [0x1c01, 25, 22, 0],
    [0x1801, 26, 23, 0], [0x1601, 27, 24, 0], [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0],
    [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0], [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0],
    [0x02a1, 36, 33, 0], [0x0221, 37, 34, 0], [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0],
    [0x0049, 41, 38, 0], [0x0025, 42, 39, 0], [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0],
    [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];

const CTX_RUN = 17;
const CTX_UNIFORM = 18;

class MqEncoder {
    constructor() {
        this.state = new Uint8Array(19);
        this.mps = new Uint8Array(19);
        // Table D.7: the uniform, run-length and all-zero contexts start elsewhere.
        this.state[CTX_UNIFORM] = 46;
        this.state[CTX_RUN] = 3;
        this.state[0] = 4;
        this.a = 0x8000;
        this.c = 0;
        this.ct = 12;
        // out[0] is the byte "before" the codeword (C.2.8); it is never emitted.
        this.out = [0];
        this.bp = 0;
    }

    byteOut() {
        if (this.out[this.bp] === 0xff) {
            this.bp += 1;
            this.out[this.bp] = this.c >>> 20;
            this.c &= 0xfffff;
            this.ct = 7;
        } else if ((this.c & 0x8000000) === 0) {
            this.bp += 1;
            this.out[this.bp] = this.c >>> 19;
            this.c &= 0x7ffff;
            this.ct = 8;
        } else {
            this.out[this.bp] += 1;
            if (this.out[this.bp] === 0xff) {
                this.c &= 0x7ffffff;
                this.bp += 1;
                this.out[this.bp] = this.c >>> 20;
                this.c &= 0xfffff;
                this.ct = 7;
            } else {
                this.bp += 1;
                this.out[this.bp] = this.c >>> 19;
                this.c &= 0x7ffff;
                this.ct = 8;
            }
        }
    }

    renormalise() {
        do {
            this.a = (this.a << 1) & 0xffff;
            this.c = (this.c << 1) >>> 0;
            this.ct -= 1;
            if (this.ct === 0) this.byteOut();
        } while ((this.a & 0x8000) === 0);
    }

    encode(ctx, bit) {
        const [qe, nmps, nlps, sw] = QE[this.state[ctx]];
        this.a -= qe;
        if (bit === this.mps[ctx]) {
            if ((this.a & 0x8000) === 0) {
                if (this.a < qe) this.a = qe;
                else this.c += qe;
                this.state[ctx] = nmps;
                this.renormalise();
            } else {
                this.c += qe;
            }
        } else {
            if (this.a < qe) this.c += qe;
            else this.a = qe;
            if (sw) this.mps[ctx] = 1 - this.mps[ctx];
            this.state[ctx] = nlps;
            this.renormalise();
        }
    }

    /** C.2.9, as OpenJPEG does it: the codeword never ends with 0xFF. */
    flush() {
        const temp = this.c + this.a;
        this.c |= 0xffff;
        if (this.c >= temp) this.c -= 0x8000;
        this.c = (this.c << this.ct) >>> 0;
        this.byteOut();
        this.c = (this.c << this.ct) >>> 0;
        this.byteOut();
        if (this.out[this.bp] !== 0xff) this.bp += 1;
        return Uint8Array.from(this.out.slice(1, this.bp));
    }
}

// ---------------------------------------------------------------------------
// Annex D: one code-block, every coding pass
// ---------------------------------------------------------------------------

/** Table D.1 for the LL band: significance context from neighbour counts. */
function significanceContext(h, v, d) {
    if (h === 2) return 8;
    if (h === 1) return v >= 1 ? 7 : d >= 1 ? 6 : 5;
    if (v === 2) return 4;
    if (v === 1) return 3;
    return d >= 2 ? 2 : d === 1 ? 1 : 0;
}

/** Table D.3: [context, XOR bit] for the clamped horizontal and vertical sign contributions. */
const SIGN_CONTEXT = {
    '1,1': [13, 0], '1,0': [12, 0], '1,-1': [11, 0],
    '0,1': [10, 0], '0,0': [9, 0], '0,-1': [10, 1],
    '-1,1': [11, 1], '-1,0': [12, 1], '-1,-1': [13, 1],
};

/** Encode one code-block of signed coefficients. Null when every coefficient is zero. */
function encodeCodeBlock(coefficients, w, h) {
    let maxMagnitude = 0;
    for (const value of coefficients) maxMagnitude = Math.max(maxMagnitude, Math.abs(value));
    if (maxMagnitude === 0) return null;
    const planes = 32 - Math.clz32(maxMagnitude);

    const stride = w + 2;
    const at = (x, y) => (y + 1) * stride + (x + 1);
    const magnitude = new Uint32Array((h + 2) * stride);
    const negative = new Uint8Array((h + 2) * stride);
    const significant = new Uint8Array((h + 2) * stride);
    const visited = new Uint8Array((h + 2) * stride);
    const refined = new Uint8Array((h + 2) * stride);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const value = coefficients[y * w + x];
            magnitude[at(x, y)] = Math.abs(value);
            negative[at(x, y)] = value < 0 ? 1 : 0;
        }
    }

    const mq = new MqEncoder();
    const counts = (i) => ({
        h: significant[i - 1] + significant[i + 1],
        v: significant[i - stride] + significant[i + stride],
        d: significant[i - stride - 1] + significant[i - stride + 1] + significant[i + stride - 1] + significant[i + stride + 1],
    });
    const contextOf = (i) => {
        const { h: hh, v, d } = counts(i);
        return significanceContext(hh, v, d);
    };
    const contribution = (i) => (significant[i] ? (negative[i] ? -1 : 1) : 0);
    const clamp = (n) => Math.max(-1, Math.min(1, n));
    const encodeSign = (i) => {
        const hc = clamp(contribution(i - 1) + contribution(i + 1));
        const vc = clamp(contribution(i - stride) + contribution(i + stride));
        const [ctx, xor] = SIGN_CONTEXT[`${hc},${vc}`];
        mq.encode(ctx, negative[i] ^ xor);
    };
    const bitOf = (i, plane) => (magnitude[i] >>> plane) & 1;

    const significancePass = (plane) => {
        for (let y0 = 0; y0 < h; y0 += 4) {
            for (let x = 0; x < w; x++) {
                for (let y = y0; y < Math.min(y0 + 4, h); y++) {
                    const i = at(x, y);
                    if (significant[i]) continue;
                    const ctx = contextOf(i);
                    if (ctx === 0) continue;
                    const bit = bitOf(i, plane);
                    mq.encode(ctx, bit);
                    if (bit) {
                        encodeSign(i);
                        significant[i] = 1;
                    }
                    visited[i] = 1;
                }
            }
        }
    };

    const refinementPass = (plane) => {
        for (let y0 = 0; y0 < h; y0 += 4) {
            for (let x = 0; x < w; x++) {
                for (let y = y0; y < Math.min(y0 + 4, h); y++) {
                    const i = at(x, y);
                    if (!significant[i] || visited[i]) continue;
                    let ctx = 16;
                    if (!refined[i]) {
                        const { h: hh, v, d } = counts(i);
                        ctx = hh + v + d > 0 ? 15 : 14;
                    }
                    mq.encode(ctx, bitOf(i, plane));
                    refined[i] = 1;
                }
            }
        }
    };

    const cleanupPass = (plane) => {
        for (let y0 = 0; y0 < h; y0 += 4) {
            for (let x = 0; x < w; x++) {
                let y = y0;
                if (y0 + 4 <= h) {
                    let runnable = true;
                    for (let k = 0; k < 4 && runnable; k++) {
                        const i = at(x, y0 + k);
                        runnable = !significant[i] && !visited[i] && contextOf(i) === 0;
                    }
                    if (runnable) {
                        let first = -1;
                        for (let k = 0; k < 4; k++) {
                            if (bitOf(at(x, y0 + k), plane)) {
                                first = k;
                                break;
                            }
                        }
                        if (first < 0) {
                            mq.encode(CTX_RUN, 0);
                            continue;
                        }
                        mq.encode(CTX_RUN, 1);
                        mq.encode(CTX_UNIFORM, first >> 1);
                        mq.encode(CTX_UNIFORM, first & 1);
                        const i = at(x, y0 + first);
                        encodeSign(i);
                        significant[i] = 1;
                        y = y0 + first + 1;
                    }
                }
                for (; y < Math.min(y0 + 4, h); y++) {
                    const i = at(x, y);
                    if (significant[i] || visited[i]) continue;
                    const bit = bitOf(i, plane);
                    mq.encode(contextOf(i), bit);
                    if (bit) {
                        encodeSign(i);
                        significant[i] = 1;
                    }
                }
            }
        }
        visited.fill(0);
    };

    cleanupPass(planes - 1);
    for (let plane = planes - 2; plane >= 0; plane--) {
        significancePass(plane);
        refinementPass(plane);
        cleanupPass(plane);
    }
    return { data: mq.flush(), planes, passes: 3 * planes - 2 };
}

// ---------------------------------------------------------------------------
// B.10: the packet header (bit-stuffed), tag trees
// ---------------------------------------------------------------------------

class BitWriter {
    constructor() {
        this.bytes = [];
        this.buf = 0;
        this.ct = 8;
    }

    byteOut() {
        this.buf = (this.buf << 8) & 0xffff;
        this.ct = this.buf === 0xff00 ? 7 : 8;
        this.bytes.push(this.buf >>> 8);
    }

    putBit(bit) {
        if (this.ct === 0) this.byteOut();
        this.ct -= 1;
        this.buf |= bit << this.ct;
    }

    write(value, bits) {
        for (let i = bits - 1; i >= 0; i--) this.putBit((value >>> i) & 1);
    }

    flush() {
        this.byteOut();
        if (this.ct === 7) this.byteOut();
        return Uint8Array.from(this.bytes);
    }
}

/** B.10.2. Leaves in raster order; each node's value is the minimum below it. */
class TagTree {
    constructor(width, height, values) {
        this.levels = [];
        let w = width;
        let h = height;
        let level = values.map((value) => ({ value, low: 0, known: false, parent: null }));
        this.leaves = level;
        for (;;) {
            this.levels.push({ nodes: level, w, h });
            if (w === 1 && h === 1) break;
            const pw = Math.ceil(w / 2);
            const ph = Math.ceil(h / 2);
            const parents = Array.from({ length: pw * ph }, () => ({ value: Infinity, low: 0, known: false, parent: null }));
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const node = level[y * w + x];
                    const parent = parents[(y >> 1) * pw + (x >> 1)];
                    node.parent = parent;
                    parent.value = Math.min(parent.value, node.value);
                }
            }
            level = parents;
            w = pw;
            h = ph;
        }
    }

    encode(writer, leaf, threshold) {
        const stack = [];
        let node = this.leaves[leaf];
        while (node.parent) {
            stack.push(node);
            node = node.parent;
        }
        let low = 0;
        for (;;) {
            if (low > node.low) node.low = low;
            else low = node.low;
            while (low < threshold) {
                if (low >= node.value) {
                    if (!node.known) {
                        writer.write(1, 1);
                        node.known = true;
                    }
                    break;
                }
                writer.write(0, 1);
                low += 1;
            }
            node.low = low;
            if (stack.length === 0) break;
            node = stack.pop();
        }
    }
}

const bitLength = (n) => 32 - Math.clz32(n);

function putPassCount(writer, n) {
    if (n === 1) writer.write(0, 1);
    else if (n === 2) writer.write(2, 2);
    else if (n <= 5) writer.write(0xc | (n - 3), 4);
    else if (n <= 36) writer.write(0x1e0 | (n - 6), 9);
    else writer.write(0xff80 | (n - 37), 16);
}

// ---------------------------------------------------------------------------
// The codestream
// ---------------------------------------------------------------------------

const GUARD_BITS = 2;
const BIT_DEPTH = 8;
/** E.1: Mb = G + epsilon - 1, with epsilon = the bit depth for the LL band of a reversible transform. */
const MAX_PLANES = GUARD_BITS + BIT_DEPTH - 1;
const CODE_BLOCK = 64;

const u16 = (n) => [(n >>> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/**
 * Encode an 8-bit grey image (row-major, `width * height` bytes) as a raw
 * JPEG 2000 codestream (.j2k), losslessly.
 */
export function encodeJ2k(pixels, width, height) {
    if (pixels.length !== width * height) throw new Error('pixel count does not match the size');
    const blocksX = Math.ceil(width / CODE_BLOCK);
    const blocksY = Math.ceil(height / CODE_BLOCK);
    const blocks = [];
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const x0 = bx * CODE_BLOCK;
            const y0 = by * CODE_BLOCK;
            const w = Math.min(CODE_BLOCK, width - x0);
            const h = Math.min(CODE_BLOCK, height - y0);
            const coefficients = new Int32Array(w * h);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) coefficients[y * w + x] = pixels[(y0 + y) * width + x0 + x] - 128;
            }
            blocks.push(encodeCodeBlock(coefficients, w, h));
        }
    }

    // One packet: layer 0, resolution 0, the one component and precinct.
    const inclusion = new TagTree(blocksX, blocksY, blocks.map((b) => (b ? 0 : 999)));
    const zeroPlanes = new TagTree(blocksX, blocksY, blocks.map((b) => (b ? MAX_PLANES - b.planes : 0)));
    const header = new BitWriter();
    header.write(1, 1);
    blocks.forEach((block, index) => {
        inclusion.encode(header, index, 1);
        if (!block) return;
        if (block.planes > MAX_PLANES) throw new Error('more bit-planes than the quantization allows');
        zeroPlanes.encode(header, index, 999);
        putPassCount(header, block.passes);
        let lblock = 3;
        const passBits = bitLength(block.passes) - 1;
        const increment = Math.max(0, bitLength(block.data.length) - (lblock + passBits));
        for (let i = 0; i < increment; i++) header.write(1, 1);
        header.write(0, 1);
        lblock += increment;
        header.write(block.data.length, lblock + passBits);
    });
    const packet = [...header.flush()];
    for (const block of blocks) if (block) packet.push(...block.data);

    const siz = [
        0xff, 0x51, ...u16(41), ...u16(0),
        ...u32(width), ...u32(height), ...u32(0), ...u32(0),
        ...u32(width), ...u32(height), ...u32(0), ...u32(0),
        ...u16(1), BIT_DEPTH - 1, 1, 1,
    ];
    // LRCP, one layer, no colour transform; zero decomposition levels,
    // 64x64 code-blocks (exponent 4 + 2), default style, 5-3 reversible.
    const cod = [0xff, 0x52, ...u16(12), 0x00, 0x00, ...u16(1), 0x00, 0, 4, 4, 0x00, 0x01];
    // No quantization, two guard bits; one band, exponent = bit depth.
    const qcd = [0xff, 0x5c, ...u16(4), GUARD_BITS << 5, BIT_DEPTH << 3];
    const tilePartLength = 12 + 2 + packet.length;
    const sot = [0xff, 0x90, ...u16(10), ...u16(0), ...u32(tilePartLength), 0, 1];
    return Uint8Array.from([0xff, 0x4f, ...siz, ...cod, ...qcd, ...sot, 0xff, 0x93, ...packet, 0xff, 0xd9]);
}
