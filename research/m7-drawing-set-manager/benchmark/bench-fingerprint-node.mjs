/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * SHA-256 throughput in Node, as a cross-check on the browser figures.
 *
 * NODE EVIDENCE, and deliberately kept apart from bench-browser.mjs. It answers
 * a narrower question than the browser run does: how fast is each *hash
 * implementation* on this CPU, with file reading either removed or done by
 * Node's own I/O. Nothing here says how a browser reads a File, what a tab's
 * memory does, or whether a page stays responsive.
 *
 *   native stream      node:crypto over a read stream (OpenSSL; the ceiling)
 *   webcrypto one-shot  node's crypto.subtle.digest over a whole buffer
 *   js incremental      prototype/sha256-stream.mjs, buffer already in memory
 *   js one-shot         Production's sha256Js (src/utils/split-merge/digest.ts)
 *   js from Blob        the incremental hash fed by blob.slice() chunks, the
 *                       same function the browser Worker runs
 *
 * Run: node research/m7-drawing-set-manager/benchmark/bench-fingerprint-node.mjs
 */

import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sha256, fingerprintBlobStreaming, toHex } from '../prototype/sha256-stream.mjs';
import { contentDigestJs } from '../../../src/utils/split-merge/digest.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'results', 'fingerprint-node.json');
const MiB = 1024 * 1024;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-fingerprint-node-'));

function syntheticFile(name, bytes, seed) {
    const file = path.join(TMP, name);
    const block = new Uint32Array(MiB / 4);
    const view = new Uint8Array(block.buffer);
    let state = (seed >>> 0) || 1;
    const fd = fs.openSync(file, 'w');
    for (let written = 0; written < bytes; written += MiB) {
        for (let i = 0; i < block.length; i += 1) {
            state ^= state << 13; state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5; state >>>= 0;
            block[i] = state;
        }
        fs.writeSync(fd, view.subarray(0, Math.min(MiB, bytes - written)));
    }
    fs.closeSync(fd);
    return file;
}

const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function timed(fn, repeats) {
    const samples = [];
    let value;
    for (let i = 0; i < repeats; i += 1) {
        const started = performance.now();
        value = await fn();
        samples.push(performance.now() - started);
    }
    return { ms: Number(median(samples).toFixed(1)), value };
}

const nativeStream = (file) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * MiB }).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const rows = [];
try {
    for (const [index, size] of [1, 10, 50, 100, 250].entries()) {
        const file = syntheticFile(`node-${size}MiB.bin`, size * MiB, 9000 + index);
        const repeats = size >= 100 ? 3 : 5;
        const buffer = new Uint8Array(fs.readFileSync(file));

        const native = await timed(() => nativeStream(file), repeats);
        const subtle = await timed(async () => toHex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', buffer))), repeats);
        const incremental = await timed(() => {
            const hash = new Sha256();
            for (let offset = 0; offset < buffer.length; offset += 4 * MiB) hash.update(buffer.subarray(offset, offset + 4 * MiB));
            return hash.digestHex();
        }, repeats);
        const oneShot = await timed(() => contentDigestJs(buffer), repeats);
        const blob = await fs.openAsBlob(file);
        const fromBlob = await timed(async () => (await fingerprintBlobStreaming(blob, { chunkBytes: 4 * MiB })).sha256, repeats);

        const digests = new Set([native.value, subtle.value, incremental.value, oneShot.value, fromBlob.value]);
        if (digests.size !== 1) throw new Error(`${size} MiB: the implementations disagree`);
        const rate = (ms) => Number((size / (ms / 1000)).toFixed(0));
        const row = {
            sizeMiB: size, repeats, allFiveDigestsAgree: true,
            nativeStream: { ms: native.ms, MiBPerSecond: rate(native.ms) },
            webcryptoOneShot: { ms: subtle.ms, MiBPerSecond: rate(subtle.ms) },
            jsIncrementalInMemory: { ms: incremental.ms, MiBPerSecond: rate(incremental.ms) },
            jsOneShotProductionDigestTs: { ms: oneShot.ms, MiBPerSecond: rate(oneShot.ms) },
            jsIncrementalFromBlob: { ms: fromBlob.ms, MiBPerSecond: rate(fromBlob.ms) },
        };
        rows.push(row);
        console.log(`${String(size).padStart(3)} MiB  native ${String(native.ms).padStart(7)} ms | webcrypto ${String(subtle.ms).padStart(7)} ms | js incremental ${String(incremental.ms).padStart(7)} ms (${row.jsIncrementalInMemory.MiBPerSecond} MiB/s) | js one-shot ${String(oneShot.ms).padStart(7)} ms (${row.jsOneShotProductionDigestTs.MiBPerSecond} MiB/s) | js from Blob ${String(fromBlob.ms).padStart(7)} ms`);
    }
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

const report = {
    notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic files in the OS temp directory. NODE evidence -- not a browser measurement.',
    runtime: 'node',
    environment: { node: process.version, v8: process.versions.v8, openssl: process.versions.openssl, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model },
    units: 'milliseconds, median of `repeats` runs; MiB per second derived from the median',
    rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nwritten: ${path.relative(process.cwd(), OUT)}`);
