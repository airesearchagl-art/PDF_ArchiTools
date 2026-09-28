/**
 * The owned bounded DEFLATE (src/utils/comparator/deflate.ts), against
 * decoders it shares no code with.
 *
 * Every encoded stream is inflated by node:zlib and by pako, independently,
 * and must reproduce its input byte for byte; every stream must be within
 * `ownedDeflateBound`, and some must sit exactly at it (an incompressible
 * input is all stored blocks). The encoder is deterministic: the same input
 * gives the same bytes however it is pushed. A corrupted stream is rejected by
 * both decoders, so the Adler-32 and block structure are real.
 *
 * Node 24 strips the module's types natively; nothing is bundled.
 *
 * Run: node scripts/smoke-comparator-deflate.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pako from 'pako';
import {
    OwnedZlib, ownedDeflateBound, ownedDeflateScratchBytes,
    DEFLATE_BLOCK_BYTES, DEFLATE_OUTPUT_CHUNK_BYTES,
} from '../src/utils/comparator/deflate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return s / 4294967296;
    };
}

function encode(data, rowDistance, pushSize = 7919) {
    const chunks = [];
    const z = new OwnedZlib(rowDistance, (c) => chunks.push(c.slice()));
    for (let i = 0; i < data.length; i += pushSize) z.push(data.subarray(i, i + pushSize));
    if (data.length === 0) z.push(new Uint8Array(0));
    const r = z.finish();
    const out = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
    return { out, r, chunks };
}

const r = rng(20260929);
const width = 4969;
const rowBytes = Math.ceil(width / 2) + 1;
const nineState = new Uint8Array(rowBytes * 40);
for (let y = 0; y < 40; y += 1) {
    nineState[y * rowBytes] = 2; // the Up predictor tag every row carries
    for (let x = 1; x < rowBytes; x += 1) {
        // Mostly paper, sparse ink runs: what a drawing's state rows look like.
        nineState[y * rowBytes + x] = r() < 0.03 ? ((((r() * 9) | 0) << 4) | ((r() * 9) | 0)) : 0;
    }
}
const CASES = [
    ['empty input', new Uint8Array(0), 100],
    ['one byte', new Uint8Array([7]), 100],
    ['uniform random (incompressible)', Uint8Array.from({ length: 300000 }, () => (r() * 256) | 0), 2485],
    ['random 9-state nibbles', Uint8Array.from({ length: 300000 }, () => ((((r() * 9) | 0) << 4) | ((r() * 9) | 0))), 2485],
    ['sparse 9-state rows (drawing-like)', nineState, rowBytes],
    ['repeated byte', new Uint8Array(250000).fill(0x33), 2485],
    ['repeated row (row-distance matches)', Uint8Array.from({ length: 250000 }, (_, i) => (i % 2485) & 0xFF), 2485],
    ['exactly one block', new Uint8Array(DEFLATE_BLOCK_BYTES).fill(5), 100],
    ['one block + 1 byte', new Uint8Array(DEFLATE_BLOCK_BYTES + 1).fill(5), 100],
    ['two blocks exactly, incompressible', Uint8Array.from({ length: DEFLATE_BLOCK_BYTES * 2 }, () => (r() * 256) | 0), 100],
    ['row wider than the 32 KiB window', Uint8Array.from({ length: 200000 }, (_, i) => (i % 40001) & 3), 40001],
    ['row exactly the 32 KiB window', Uint8Array.from({ length: 200000 }, (_, i) => ((i % 32768) * 13) & 0xFF), 32768],
];

for (const [name, data, rowDistance] of CASES) {
    const { out, r: res } = encode(data, rowDistance);
    const bound = ownedDeflateBound(data.length);
    let viaZlib = null;
    let viaPako = null;
    try { viaZlib = zlib.inflateSync(out); } catch (e) { viaZlib = e; }
    try { viaPako = pako.inflate(out); } catch (e) { viaPako = e; }
    const same = (x) => x && !(x instanceof Error) && Buffer.compare(Buffer.from(x), Buffer.from(data)) === 0;
    check(`${name}: node:zlib round trip`, same(viaZlib), `${data.length} -> ${out.length} bytes`);
    check(`${name}: pako round trip`, same(viaPako));
    check(`${name}: within ownedDeflateBound`, out.length <= bound && res.encodedBytes === out.length, `${out.length} <= ${bound}`);
}

// The bound is tight where it should be: incompressible input is all stored.
{
    const data = Uint8Array.from({ length: DEFLATE_BLOCK_BYTES * 3 }, () => (r() * 256) | 0);
    const { out, r: res } = encode(data, 2485);
    // Three full blocks, all stored, then the empty final block finish() always writes.
    check('incompressible input is written as stored blocks (plus the empty final block)', res.blocksStored === 3 && res.blocksFixed === 1, `${res.blocksStored} stored, ${res.blocksFixed} fixed`);
    check('the bound is tight for incompressible input (within 2 bytes a block)', ownedDeflateBound(data.length) - out.length <= 4 * 2, `${ownedDeflateBound(data.length) - out.length} bytes under`);
    check('the bound counts the final block of an exact-multiple input', ownedDeflateBound(DEFLATE_BLOCK_BYTES * 3) === 2 + 4 * 6 + DEFLATE_BLOCK_BYTES * 3 + 4);
}

// Deterministic, and independent of how the input is pushed.
{
    const data = CASES[4][1];
    const a = encode(data, rowBytes, 1).out;
    const b = encode(data, rowBytes, rowBytes).out;
    const c = encode(data, rowBytes, 1 << 20).out;
    check('same input, same bytes, however it is pushed', Buffer.compare(a, b) === 0 && Buffer.compare(b, c) === 0);
}

// Output chunks are the size the budget prices.
{
    const data = CASES[2][1];
    const { chunks } = encode(data, 2485);
    const full = chunks.slice(0, -1).every((c) => c.length === DEFLATE_OUTPUT_CHUNK_BYTES);
    check('output chunks are 64 KiB except the last', full && chunks.at(-1).length <= DEFLATE_OUTPUT_CHUNK_BYTES, `${chunks.length} chunks`);
}

// Scratch arithmetic is what the encoder allocates (history + block, tokens, one chunk).
check('scratch bound for a 2486-byte row', ownedDeflateScratchBytes(2486) === (2486 + 65535) + 65535 * 4 + 65536);
check('scratch bound for a row wider than the window uses no row history', ownedDeflateScratchBytes(40001) === (1 + 65535) + 65535 * 4 + 65536);

// Negative: corruption is detected by both independent decoders.
{
    const { out } = encode(CASES[4][1], rowBytes);
    const flipped = Buffer.from(out);
    flipped[flipped.length - 2] ^= 0x01; // inside the Adler-32
    let zlibRejects = false;
    let pakoRejects = false;
    try { zlib.inflateSync(flipped); } catch { zlibRejects = true; }
    try { pako.inflate(flipped); } catch { pakoRejects = true; }
    check('negative probe: a corrupted checksum is rejected by node:zlib', zlibRejects);
    check('negative probe: a corrupted checksum is rejected by pako', pakoRejects);
    const truncated = out.subarray(0, out.length - 7);
    let truncatedRejected = false;
    try { zlib.inflateSync(truncated); } catch { truncatedRejected = true; }
    check('negative probe: a truncated stream is rejected', truncatedRejected);
}

// Negative: misuse is refused, not ignored.
{
    let afterFinish = false;
    const z = new OwnedZlib(100, () => {});
    z.finish();
    try { z.push(new Uint8Array(1)); } catch { afterFinish = true; }
    check('negative probe: push after finish is refused', afterFinish);
    let badRow = false;
    try { new OwnedZlib(0, () => {}); } catch { badRow = true; }
    check('negative probe: a zero row distance is refused', badRow);
}

const out = path.join(ROOT, 'test-fixtures', 'smoke-comparator-deflate-results.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
