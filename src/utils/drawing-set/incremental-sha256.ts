/**
 * SHA-256 (FIPS 180-4), fed in pieces.
 *
 * The Drawing Set fingerprints a Source while its bytes are being read, one
 * bounded chunk at a time, so the digest has to be incremental: Web Crypto's
 * `subtle.digest` only takes the whole input at once, which would mean holding
 * a second full copy of a file of up to 256 MiB just to hash it. This is the
 * Production fingerprint path; Web Crypto is used only as test evidence.
 *
 * Owned rather than imported so that adding it changes no dependency. It is
 * verified against published vectors and, differentially, against Node's
 * `crypto` at every chunk split around the 64-byte block boundary
 * (scripts/smoke-m7-p1.mjs).
 *
 * The digest is a fact about bytes for telling files apart. It is not a
 * signature and proves nothing about who made a file.
 */

const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/**
 * The most bytes one digest may cover: 2^53 - 1 bits' worth would still be
 * exact, but nothing here comes near it, and a bound that is checked is better
 * than one that is assumed.
 */
export const SHA256_MAX_INPUT_BYTES = 2 ** 50;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export class IncrementalSha256 {
    private readonly state = new Int32Array(8);
    private readonly schedule = new Int32Array(64);
    private readonly pending = new Uint8Array(64);
    private pendingLength = 0;
    private totalBytes = 0;
    private finished = false;

    constructor() {
        this.reset();
    }

    /** Back to the empty message, ready to be used again. */
    reset(): this {
        this.state.set(INITIAL_STATE);
        this.pending.fill(0);
        this.pendingLength = 0;
        this.totalBytes = 0;
        this.finished = false;
        return this;
    }

    /** How many bytes the digest covers so far. */
    get byteLength(): number {
        return this.totalBytes;
    }

    /**
     * Add the next bytes of the message. Refuses after the digest has been
     * taken: a digest is final, and quietly extending it would make it a digest
     * of something nobody asked about.
     */
    update(data: Uint8Array): this {
        if (this.finished) {
            throw new Error('SHA-256: update after digest; call reset() first');
        }
        const length = data.length;
        if (this.totalBytes + length > SHA256_MAX_INPUT_BYTES) {
            throw new Error('SHA-256: input exceeds the supported length');
        }
        this.totalBytes += length;

        let offset = 0;
        if (this.pendingLength > 0) {
            const take = Math.min(64 - this.pendingLength, length);
            this.pending.set(data.subarray(0, take), this.pendingLength);
            this.pendingLength += take;
            offset = take;
            if (this.pendingLength < 64) return this;
            this.compress(this.pending, 0);
            this.pendingLength = 0;
        }
        while (length - offset >= 64) {
            this.compress(data, offset);
            offset += 64;
        }
        if (offset < length) {
            this.pending.set(data.subarray(offset), 0);
            this.pendingLength = length - offset;
        }
        return this;
    }

    /** The 32-byte digest. Once only; `reset()` starts a new message. */
    digest(): Uint8Array {
        if (this.finished) {
            throw new Error('SHA-256: digest already taken; call reset() first');
        }
        const totalBytes = this.totalBytes;
        const block = this.pending;
        let used = this.pendingLength;
        block[used++] = 0x80;
        if (used > 56) {
            block.fill(0, used);
            this.compress(block, 0);
            used = 0;
        }
        block.fill(0, used, 56);
        // Message length in bits, big-endian, as two 32-bit halves.
        const high = Math.floor(totalBytes / 0x20000000);
        const low = (totalBytes % 0x20000000) * 8;
        block[56] = high >>> 24;
        block[57] = high >>> 16;
        block[58] = high >>> 8;
        block[59] = high;
        block[60] = low >>> 24;
        block[61] = low >>> 16;
        block[62] = low >>> 8;
        block[63] = low;
        this.compress(block, 0);

        const out = new Uint8Array(32);
        for (let i = 0; i < 8; i++) {
            const word = this.state[i];
            out[i * 4] = word >>> 24;
            out[i * 4 + 1] = word >>> 16;
            out[i * 4 + 2] = word >>> 8;
            out[i * 4 + 3] = word;
        }
        this.finished = true;
        this.pending.fill(0);
        this.pendingLength = 0;
        return out;
    }

    /** The digest as 64 lower-case hex characters. Once only, like `digest()`. */
    digestHex(): string {
        const bytes = this.digest();
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i]];
        return hex;
    }

    private compress(bytes: Uint8Array, offset: number): void {
        const w = this.schedule;
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        const s = this.state;
        let a = s[0];
        let b = s[1];
        let c = s[2];
        let d = s[3];
        let e = s[4];
        let f = s[5];
        let g = s[6];
        let h = s[7];
        for (let i = 0; i < 64; i++) {
            const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const choose = (e & f) ^ (~e & g);
            const t1 = (h + sum1 + choose + K[i] + w[i]) | 0;
            const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (sum0 + majority) | 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        s[0] = (s[0] + a) | 0;
        s[1] = (s[1] + b) | 0;
        s[2] = (s[2] + c) | 0;
        s[3] = (s[3] + d) | 0;
        s[4] = (s[4] + e) | 0;
        s[5] = (s[5] + f) | 0;
        s[6] = (s[6] + g) | 0;
        s[7] = (s[7] + h) | 0;
    }
}

/** One-shot convenience over the same implementation (tests, small inputs). */
export function sha256Hex(data: Uint8Array): string {
    return new IncrementalSha256().update(data).digestHex();
}
