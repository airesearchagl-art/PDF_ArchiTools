/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * A dedicated Worker that fingerprints a File two ways:
 *
 *   subtle   read the whole file, hand it to crypto.subtle.digest
 *   stream   read it slice by slice into the incremental SHA-256
 *   byob     the same hash fed by a BYOB reader over file.stream(), which
 *            fills ONE buffer over and over instead of allocating a new one
 *            per slice
 *
 * The File arrives by structured clone, which copies the reference and not the
 * bytes, so nothing is read on the page's thread at all. A `cancel` message is
 * honoured between chunks of the streaming method; the one-shot method has
 * nothing to interrupt, and its only cancellation is the page terminating this
 * Worker.
 */

import { FingerprintCancelled, Sha256, fingerprintBlobStreaming, toHex } from '../../prototype/sha256-stream.mjs';

const cancelled = new Set();

self.onmessage = async (event) => {
    const message = event.data;
    if (message.kind === 'cancel') { cancelled.add(message.id); return; }
    if (message.kind === 'probe') {
        self.postMessage({
            kind: 'probe', id: message.id,
            isSecureContext: self.isSecureContext,
            subtle: typeof self.crypto?.subtle?.digest,
            randomUUID: typeof self.crypto?.randomUUID,
            getRandomValues: typeof self.crypto?.getRandomValues,
        });
        return;
    }

    const { id, method, file, chunkBytes } = message;
    const started = performance.now();
    try {
        if (method === 'subtle') {
            const buffer = await file.arrayBuffer();
            const read = performance.now();
            const digest = await self.crypto.subtle.digest('SHA-256', buffer);
            const done = performance.now();
            self.postMessage({ kind: 'done', id, sha256: toHex(new Uint8Array(digest)), byteLength: buffer.byteLength, readMs: read - started, digestMs: done - read, totalMs: done - started });
            return;
        }
        if (method === 'byob') {
            const reader = file.stream().getReader({ mode: 'byob' });
            const hash = new Sha256();
            let buffer = new ArrayBuffer(chunkBytes);
            let reads = 0;
            for (;;) {
                if (cancelled.has(id)) { await reader.cancel(); throw new FingerprintCancelled(); }
                // `min` asks for a full buffer per read; without it a read returns
                // whatever happens to be queued, often a few tens of KiB.
                const { value, done } = await reader.read(new Uint8Array(buffer), { min: chunkBytes });
                if (value && value.byteLength > 0) { hash.update(value); reads += 1; }
                if (done) break;
                buffer = value.buffer; // the same memory, handed back
            }
            self.postMessage({ kind: 'done', id, algorithm: 'SHA-256', sha256: hash.digestHex(), byteLength: hash.totalBytes, chunks: reads, totalMs: performance.now() - started });
            return;
        }
        let chunks = 0;
        const result = await fingerprintBlobStreaming(file, {
            chunkBytes,
            shouldCancel: () => cancelled.has(id),
            onProgress: () => { chunks += 1; },
        });
        self.postMessage({ kind: 'done', id, ...result, chunks, totalMs: performance.now() - started });
    } catch (error) {
        if (error instanceof FingerprintCancelled) self.postMessage({ kind: 'cancelled', id, afterMs: performance.now() - started });
        else self.postMessage({ kind: 'failed', id, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 200) });
    } finally {
        cancelled.delete(id);
    }
};
