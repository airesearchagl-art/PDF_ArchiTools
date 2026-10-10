/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The incremental SHA-256 against decoders it shares no code with: the NIST
 * vectors, node:crypto, and Production's own one-shot implementation.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
    DEFAULT_CHUNK_BYTES, FingerprintCancelled, Sha256, fingerprintBlobStreaming, sha256Hex, sha256HexOfText, toHex,
} from '../prototype/sha256-stream.mjs';
// Production's SHA-256, read-only. Node strips the types; the module has no imports.
import { contentDigestJs } from '../../../src/utils/split-merge/digest.ts';

const nodeHex = (bytes) => createHash('sha256').update(bytes).digest('hex');

function pseudoRandomBytes(length, seed) {
    const out = new Uint8Array(length);
    let s = seed >>> 0;
    for (let i = 0; i < length; i += 1) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        out[i] = s >>> 24;
    }
    return out;
}

test('NIST vectors', () => {
    assert.equal(sha256HexOfText(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256HexOfText('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(
        sha256HexOfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    const millionA = new Uint8Array(1_000_000).fill(0x61);
    assert.equal(sha256Hex(millionA), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('every length around the block and padding boundaries agrees with node:crypto', () => {
    for (let length = 0; length <= 260; length += 1) {
        const bytes = pseudoRandomBytes(length, 1000 + length);
        assert.equal(sha256Hex(bytes), nodeHex(bytes), `length ${length}`);
    }
});

test('the digest does not depend on how the input is cut into chunks', () => {
    const bytes = pseudoRandomBytes(200_003, 7);
    const expected = nodeHex(bytes);
    for (const chunk of [1, 3, 55, 56, 63, 64, 65, 127, 128, 4096, 65_537, 200_003]) {
        const hash = new Sha256();
        for (let offset = 0; offset < bytes.length; offset += chunk) hash.update(bytes.subarray(offset, offset + chunk));
        assert.equal(hash.digestHex(), expected, `chunk ${chunk}`);
    }
});

test('agrees with Production digest.ts, so a fingerprint does not depend on which one ran', () => {
    for (const length of [0, 1, 55, 64, 1000, 70_001]) {
        const bytes = pseudoRandomBytes(length, 99 + length);
        assert.equal(sha256Hex(bytes), contentDigestJs(bytes), `length ${length}`);
    }
});

test('agrees with Web Crypto', async () => {
    const bytes = pseudoRandomBytes(3 * 1024 * 1024 + 17, 3);
    const subtle = toHex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)));
    assert.equal(sha256Hex(bytes), subtle);
});

test('a Blob is fingerprinted slice by slice, and the size covered is reported', async () => {
    const bytes = pseudoRandomBytes(5 * 1024 * 1024 + 123, 11);
    const blob = new Blob([bytes]);
    const progress = [];
    const result = await fingerprintBlobStreaming(blob, { chunkBytes: 1024 * 1024, onProgress: (done, total) => progress.push([done, total]) });
    assert.deepEqual(result, { algorithm: 'SHA-256', sha256: nodeHex(bytes), byteLength: bytes.length });
    assert.equal(progress.length, 6);
    assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
    assert.ok(DEFAULT_CHUNK_BYTES >= 1024 * 1024);
});

test('an empty Blob has the empty digest and length 0 -- which is why a caller must compare lengths', async () => {
    const result = await fingerprintBlobStreaming(new Blob([]));
    assert.equal(result.byteLength, 0);
    assert.equal(result.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('cancellation is honoured between chunks and leaves no result', async () => {
    const blob = new Blob([pseudoRandomBytes(4 * 1024 * 1024, 5)]);
    let chunks = 0;
    await assert.rejects(
        fingerprintBlobStreaming(blob, { chunkBytes: 1024 * 1024, onProgress: () => { chunks += 1; }, shouldCancel: () => chunks >= 2 }),
        FingerprintCancelled,
    );
    assert.equal(chunks, 2);
});

test('a hash instance cannot be reused after it has produced a digest', () => {
    const hash = new Sha256();
    hash.update(new Uint8Array(10));
    hash.digest();
    assert.throws(() => hash.update(new Uint8Array(1)));
    assert.throws(() => hash.digest());
});
