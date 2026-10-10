/**
 * The dedicated Worker that fingerprints one Source at a time.
 *
 * It receives a Source's bytes as they are read, in order, one transferred
 * chunk at a time, folds each into an incremental SHA-256 and lets the chunk
 * go. It never holds more than the hash state and the chunk in hand, and never
 * a copy of the file. The client starts one Worker per Source and terminates it
 * when the run ends, however it ends.
 */
import { IncrementalSha256 } from './incremental-sha256';
import type { FingerprintRequest, FingerprintResponse } from './fingerprint-protocol';

interface Run {
    runId: string;
    hash: IncrementalSha256;
    nextSeq: number;
}

let run: Run | null = null;

const post = (message: FingerprintResponse): void => {
    (self as unknown as Worker).postMessage(message);
};

const fail = (runId: string, code: 'PROTOCOL_VIOLATION' | 'BYTE_COUNT_MISMATCH' | 'WORKER_FAILED', detail: string): void => {
    run = null;
    post({ kind: 'failed', runId, code, detail });
};

self.addEventListener('message', (event: MessageEvent<FingerprintRequest>) => {
    const request = event.data;
    try {
        switch (request.kind) {
            case 'start':
                // One Source at a time: a new run replaces whatever was there.
                run = { runId: request.runId, hash: new IncrementalSha256(), nextSeq: 0 };
                return;
            case 'chunk': {
                if (!run || run.runId !== request.runId || request.seq !== run.nextSeq) {
                    fail(request.runId, 'PROTOCOL_VIOLATION', `unexpected chunk ${request.seq}`);
                    return;
                }
                run.hash.update(new Uint8Array(request.chunk));
                run.nextSeq += 1;
                post({ kind: 'accepted', runId: run.runId, seq: request.seq, byteLength: run.hash.byteLength });
                return;
            }
            case 'finish': {
                if (!run || run.runId !== request.runId) {
                    fail(request.runId, 'PROTOCOL_VIOLATION', 'finish without a run');
                    return;
                }
                const { hash, runId } = run;
                if (hash.byteLength !== request.expectedBytes) {
                    fail(runId, 'BYTE_COUNT_MISMATCH', `hashed ${hash.byteLength} of ${request.expectedBytes} bytes`);
                    return;
                }
                const byteLength = hash.byteLength;
                const sha256 = hash.digestHex();
                run = null;
                post({ kind: 'digest', runId, sha256, byteLength });
                return;
            }
            case 'cancel':
                if (run && run.runId === request.runId) run = null;
                post({ kind: 'cancelled', runId: request.runId });
                return;
        }
    } catch (error) {
        fail(request.runId, 'WORKER_FAILED', String((error as Error)?.message ?? error));
    }
});
