/**
 * The main-thread half of Source fingerprinting.
 *
 * One file is read in bounded chunks. Each chunk is copied into the one
 * analysis buffer the file will be parsed from, and then the chunk itself is
 * transferred to the fingerprint Worker. So the digest is over exactly the
 * bytes PDF.js will be given, computed before PDF.js owns them, and no second
 * full-size copy of the file ever exists for the sake of hashing.
 *
 * At most two chunks are in flight: the one the Worker is folding in and the
 * next one being read. The Worker is disposable -- one per Source, terminated
 * when the run ends, whether it completed, failed or was cancelled.
 */
import type { FingerprintFailureCode, FingerprintRequest, FingerprintResponse } from './fingerprint-protocol';
import { FINGERPRINT_STEP_TIMEOUT_MS } from './fingerprint-protocol';
import { cancelledStop, IntakeStop, READ_CHUNK_BYTES, refusal } from './intake-policy';

export class FingerprintError extends Error {
    readonly code: FingerprintFailureCode | 'CANCELLED';
    constructor(code: FingerprintFailureCode | 'CANCELLED', detail: string) {
        super(detail);
        this.name = 'FingerprintError';
        this.code = code;
    }
}

/**
 * Worker bookkeeping, so tests can see that no fingerprint Worker outlives its
 * run. Counts only; nothing about any file.
 */
const workerCounts = { started: 0, terminated: 0 };
export const fingerprintWorkerCounts = (): { started: number; terminated: number; live: number } => ({
    ...workerCounts,
    live: workerCounts.started - workerCounts.terminated,
});

export interface FingerprintRun {
    /** Hand over the next chunk (it is transferred). Resolves once the Worker has folded it in. */
    push(chunk: ArrayBuffer): Promise<void>;
    /** Resolves with the digest once the Worker confirms it saw exactly `expectedBytes`. */
    finish(expectedBytes: number): Promise<{ sha256: string; byteLength: number }>;
    /** Stop now. Idempotent; safe after the run has ended. */
    cancel(): void;
}

let runCounter = 0;

/** Start one fingerprint run in a fresh dedicated Worker. */
export function startFingerprintRun(stepTimeoutMs = FINGERPRINT_STEP_TIMEOUT_MS): FingerprintRun {
    runCounter += 1;
    const runId = `m7-fp-${Date.now().toString(36)}-${runCounter}`;
    let worker: Worker | null = null;
    let ended = false;
    /**
     * Why the run ended, kept so a later push or finish reports the real cause
     * (a Worker that failed between steps must not read as a cancellation).
     */
    let failure: FingerprintError | null = null;
    let seq = 0;
    let pending: {
        expect: 'accepted' | 'digest';
        seq: number;
        resolve: (value: { sha256: string; byteLength: number } | void) => void;
        reject: (error: FingerprintError) => void;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;

    const terminate = (): void => {
        if (worker) {
            worker.terminate();
            worker = null;
            workerCounts.terminated += 1;
        }
    };

    const end = (error: FingerprintError | null): void => {
        if (ended) return;
        ended = true;
        failure = error;
        terminate();
        if (pending) {
            clearTimeout(pending.timer);
            const { reject } = pending;
            pending = null;
            if (error) reject(error);
        }
    };

    try {
        worker = new Worker(new URL('./drawing-set-fingerprint.worker.ts', import.meta.url), { type: 'module' });
        workerCounts.started += 1;
    } catch (error) {
        ended = true;
        const startFailure = new FingerprintError('WORKER_FAILED', String((error as Error)?.message ?? error));
        return {
            push: () => Promise.reject(startFailure),
            finish: () => Promise.reject(startFailure),
            cancel: () => { },
        };
    }

    worker.addEventListener('message', (event: MessageEvent<FingerprintResponse>) => {
        const response = event.data;
        if (ended || response.runId !== runId) return;
        if (response.kind === 'failed') {
            end(new FingerprintError(response.code, response.detail));
            return;
        }
        if (!pending) return;
        const current = pending;
        if (response.kind === 'accepted' && current.expect === 'accepted' && response.seq === current.seq) {
            clearTimeout(current.timer);
            pending = null;
            current.resolve();
            return;
        }
        if (response.kind === 'digest' && current.expect === 'digest') {
            clearTimeout(current.timer);
            pending = null;
            ended = true;
            terminate();
            current.resolve({ sha256: response.sha256, byteLength: response.byteLength });
            return;
        }
        end(new FingerprintError('PROTOCOL_VIOLATION', `unexpected ${response.kind}`));
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
        event.preventDefault();
        end(new FingerprintError('WORKER_FAILED', event.message || 'worker error'));
    });
    worker.addEventListener('messageerror', () => {
        end(new FingerprintError('WORKER_FAILED', 'unreadable worker message'));
    });

    const send = (request: FingerprintRequest, transfer: Transferable[] = []): void => {
        try {
            worker?.postMessage(request, transfer);
        } catch (error) {
            end(new FingerprintError('WORKER_FAILED', String((error as Error)?.message ?? error)));
        }
    };
    send({ kind: 'start', runId });

    const expectAnswer = <T>(expect: 'accepted' | 'digest', expectSeq: number): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                end(new FingerprintError('TIMEOUT', `no answer within ${stepTimeoutMs} ms`));
            }, stepTimeoutMs);
            pending = {
                expect,
                seq: expectSeq,
                resolve: resolve as (value: { sha256: string; byteLength: number } | void) => void,
                reject,
                timer,
            };
        });

    return {
        push(chunk) {
            if (ended) return Promise.reject(failure ?? new FingerprintError('CANCELLED', 'run has ended'));
            if (pending) return Promise.reject(new FingerprintError('PROTOCOL_VIOLATION', 'one chunk at a time'));
            const current = seq;
            seq += 1;
            const answer = expectAnswer<void>('accepted', current);
            send({ kind: 'chunk', runId, seq: current, chunk }, [chunk]);
            return answer;
        },
        finish(expectedBytes) {
            if (ended) return Promise.reject(failure ?? new FingerprintError('CANCELLED', 'run has ended'));
            if (pending) return Promise.reject(new FingerprintError('PROTOCOL_VIOLATION', 'finish while a chunk is pending'));
            const answer = expectAnswer<{ sha256: string; byteLength: number }>('digest', -1);
            send({ kind: 'finish', runId, expectedBytes });
            return answer;
        },
        cancel() {
            if (ended) return;
            // Told first, then torn down: terminating is what guarantees it.
            send({ kind: 'cancel', runId });
            end(new FingerprintError('CANCELLED', 'cancelled'));
        },
    };
}

export interface FingerprintIntoBufferOptions {
    signal: AbortSignal;
    /** Bytes per read. Production uses READ_CHUNK_BYTES; tests vary it. */
    chunkBytes?: number;
    /** Bytes read and fingerprinted so far. */
    onProgress?: (bytesDone: number) => void;
}

/**
 * Read `file` into `target` chunk by chunk and fingerprint exactly those bytes.
 *
 * `target` must be exactly `file.size` long. Throws `IntakeStop`: with a
 * refusal when the file cannot be read, changes while being read, or cannot be
 * fingerprinted; with no refusal when `signal` aborts.
 */
export async function fingerprintIntoBuffer(
    file: Blob,
    target: Uint8Array,
    options: FingerprintIntoBufferOptions,
): Promise<string> {
    const { signal } = options;
    const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? READ_CHUNK_BYTES));
    const size = file.size;
    if (target.length !== size) throw new IntakeStop(refusal('FILE_READ_FAILED', 'ファイルを読み込めませんでした。'));
    if (signal.aborted) throw cancelledStop();

    const run = startFingerprintRun();
    const onAbort = (): void => run.cancel();
    signal.addEventListener('abort', onAbort, { once: true });

    const stopFor = (error: unknown): IntakeStop => {
        if (error instanceof IntakeStop) return error;
        if (signal.aborted || (error instanceof FingerprintError && error.code === 'CANCELLED')) return cancelledStop();
        if (error instanceof FingerprintError && error.code === 'BYTE_COUNT_MISMATCH') {
            return new IntakeStop(refusal('FILE_CHANGED', '読み込み中にファイルの内容が変わったため、読み込めません。'));
        }
        return new IntakeStop(refusal('FINGERPRINT_FAILED', 'ファイルの識別情報（SHA-256）を計算できなかったため、読み込めません。'));
    };

    try {
        let inFlight: Promise<void> | null = null;
        for (let offset = 0; offset < size; offset += chunkBytes) {
            const endOffset = Math.min(size, offset + chunkBytes);
            let chunk: ArrayBuffer;
            try {
                chunk = await file.slice(offset, endOffset).arrayBuffer();
            } catch {
                if (signal.aborted) throw cancelledStop();
                throw new IntakeStop(refusal('FILE_READ_FAILED', 'ファイルを読み込めませんでした。ファイルが移動・変更されていないか確認してください。'));
            }
            if (signal.aborted) throw cancelledStop();
            if (chunk.byteLength !== endOffset - offset) {
                throw new IntakeStop(refusal('FILE_CHANGED', '読み込み中にファイルの大きさが変わったため、読み込めません。'));
            }
            target.set(new Uint8Array(chunk), offset);
            if (inFlight) await inFlight;
            if (signal.aborted) throw cancelledStop();
            inFlight = run.push(chunk);
            // Observed here so a failure while the next chunk is being read is
            // not reported as unhandled; it is still thrown at the next await.
            inFlight.catch(() => { });
            options.onProgress?.(endOffset);
        }
        if (inFlight) await inFlight;
        const { sha256, byteLength } = await run.finish(size);
        if (signal.aborted) throw cancelledStop();
        if (byteLength !== size || !/^[0-9a-f]{64}$/.test(sha256)) {
            throw new IntakeStop(refusal('FINGERPRINT_FAILED', 'ファイルの識別情報（SHA-256）を計算できなかったため、読み込めません。'));
        }
        return sha256;
    } catch (error) {
        throw stopFor(error);
    } finally {
        signal.removeEventListener('abort', onAbort);
        run.cancel();
    }
}
