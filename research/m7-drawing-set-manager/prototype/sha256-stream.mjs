/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * An incremental SHA-256, so a source can be fingerprinted without ever holding
 * the whole file in memory.
 *
 * Production already owns a one-shot SHA-256 (`src/utils/split-merge/digest.ts`)
 * and the reason it exists matters here too: Web Crypto is only exposed to
 * secure contexts, and this app is also served over plain HTTP on a LAN. What
 * that module cannot do is take its input in pieces -- `sha256Js(bytes)` and
 * `crypto.subtle.digest()` both need every byte at once. This is the same
 * compression function with the buffering moved inside, so the caller can feed
 * it chunks read from a `Blob`.
 *
 * It is a research instrument. It is checked against node:crypto and the NIST
 * vectors by tests/sha256.test.mjs, and it is not imported by anything in src/.
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += HEX[bytes[i]];
    return out;
}

export class Sha256 {
    constructor() {
        this.h = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]);
        this.w = new Uint32Array(64);
        /** Bytes of an incomplete block carried between updates. */
        this.pending = new Uint8Array(64);
        this.pendingLength = 0;
        /**
         * Total bytes seen. A double holds integers exactly to 2^53, which is
         * far past any file a browser will hand over.
         */
        this.totalBytes = 0;
        this.finished = false;
    }

    compress(source, offset) {
        const { h, w } = this;
        for (let i = 0; i < 16; i += 1) {
            const j = offset + i * 4;
            w[i] = (source[j] << 24) | (source[j + 1] << 16) | (source[j + 2] << 8) | source[j + 3];
        }
        for (let i = 16; i < 64; i += 1) {
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0] | 0;
        let b = h[1] | 0;
        let c = h[2] | 0;
        let d = h[3] | 0;
        let e = h[4] | 0;
        let f = h[5] | 0;
        let g = h[6] | 0;
        let k = h[7] | 0;
        for (let i = 0; i < 64; i += 1) {
            const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (k + s1 + ch + K[i] + w[i]) | 0;
            const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) | 0;
            k = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += k;
    }

    /** Feed more bytes. The chunk is read, never kept. */
    update(chunk) {
        if (this.finished) throw new Error('Sha256: update after digest');
        let offset = 0;
        const length = chunk.length;
        this.totalBytes += length;

        if (this.pendingLength > 0) {
            const take = Math.min(64 - this.pendingLength, length);
            this.pending.set(chunk.subarray(0, take), this.pendingLength);
            this.pendingLength += take;
            offset = take;
            if (this.pendingLength < 64) return this;
            this.compress(this.pending, 0);
            this.pendingLength = 0;
        }
        const whole = offset + Math.floor((length - offset) / 64) * 64;
        for (; offset < whole; offset += 64) this.compress(chunk, offset);
        if (offset < length) {
            this.pending.set(chunk.subarray(offset), 0);
            this.pendingLength = length - offset;
        }
        return this;
    }

    /** Finish and return the 32-byte digest. The instance cannot be reused. */
    digest() {
        if (this.finished) throw new Error('Sha256: digest called twice');
        this.finished = true;
        const bitLengthHigh = Math.floor(this.totalBytes / 0x20000000);
        const bitLengthLow = (this.totalBytes * 8) >>> 0;

        // 0x80, zeros, then the 64-bit length: one block if it fits, else two.
        const tail = new Uint8Array(this.pendingLength < 56 ? 64 : 128);
        tail.set(this.pending.subarray(0, this.pendingLength));
        tail[this.pendingLength] = 0x80;
        const view = new DataView(tail.buffer);
        view.setUint32(tail.length - 8, bitLengthHigh);
        view.setUint32(tail.length - 4, bitLengthLow);
        for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);

        const out = new Uint8Array(32);
        const outView = new DataView(out.buffer);
        for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.h[i]);
        return out;
    }

    digestHex() {
        return toHex(this.digest());
    }
}

/** One-shot convenience, for small inputs such as evidence digests. */
export function sha256Hex(bytes) {
    return new Sha256().update(bytes).digestHex();
}

const encoder = new TextEncoder();

/** SHA-256 of a string's UTF-8 bytes. */
export function sha256HexOfText(text) {
    return sha256Hex(encoder.encode(text));
}

/**
 * The default slice a streaming fingerprint reads at a time.
 *
 * A candidate, chosen by measurement (benchmark/results/): large enough that
 * the per-chunk promise overhead disappears, small enough that the peak is a
 * few MiB whatever the file size.
 */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

export class FingerprintCancelled extends Error {
    constructor() {
        super('fingerprint cancelled');
        this.name = 'FingerprintCancelled';
    }
}

/**
 * Fingerprint a Blob/File by reading it slice by slice.
 *
 * Peak memory is one chunk plus the hash state, whatever `blob.size` is. It is
 * cancellable between chunks, so the cancellation latency is the time one chunk
 * takes. The size the digest covered is returned and must equal the size the
 * caller was told, which is the guard against a file that changed underneath
 * the read.
 *
 * Works on a browser `File` and on Node's `Blob` alike; that is what lets one
 * function be measured in both and the two results be told apart.
 */
export async function fingerprintBlobStreaming(blob, options = {}) {
    const { chunkBytes = DEFAULT_CHUNK_BYTES, shouldCancel, onProgress } = options;
    const hash = new Sha256();
    const size = blob.size;
    for (let offset = 0; offset < size; offset += chunkBytes) {
        if (shouldCancel?.()) throw new FingerprintCancelled();
        const end = Math.min(size, offset + chunkBytes);
        const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        if (chunk.length !== end - offset) {
            throw new Error(`short read at ${offset}: wanted ${end - offset}, got ${chunk.length}`);
        }
        hash.update(chunk);
        onProgress?.(end, size);
    }
    if (shouldCancel?.()) throw new FingerprintCancelled();
    return { algorithm: 'SHA-256', sha256: hash.digestHex(), byteLength: hash.totalBytes };
}
