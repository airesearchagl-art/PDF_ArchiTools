/**
 * The main-thread half of the disposable Worker.
 *
 * One worker per operation, terminated when the operation ends however it ends:
 * success, refusal, timeout, cancellation or failure. "Disposable" is the
 * contract — a worker that is reused accumulates whatever the last run left in
 * its heap, and the whole reason the Worker is here is to make a failure
 * disposable.
 *
 * Contract items this implements, all from H11-B3-4:
 *   transferable input, transferable output, cancellation,
 *   timeout counted from operation start, typed worker failures,
 *   no late publish after cancellation, termination and cleanup.
 */
import type { ExtractResult, IntakeRecord, MergePlan, MergeResult } from '../contracts';
import { M6_STATUS } from '../contracts';
import type { M6PolicyOverrides } from '../policy';
import type {
    DestinationPolicy,
    FieldCollisionPolicy,
    MergeMetadataPolicy,
} from '../contracts';
import type { DistributiveOmit, WorkerRequest, WorkerResponse } from './protocol';
import { WORKER_TIMEOUT_MS } from './protocol';

/** Whether this environment can run the M6 worker at all. */
export const workerAvailable = (): boolean => typeof Worker !== 'undefined';

let runCounter = 0;
const nextRunId = (): string => {
    runCounter += 1;
    return `m6-${Date.now().toString(36)}-${runCounter}`;
};

interface RunHandle<T> {
    promise: Promise<T>;
    /** Ask the run to stop. Idempotent, and safe after it has already ended. */
    cancel: () => void;
}

/**
 * Drive one operation in a fresh worker.
 *
 * The timeout is counted from the moment the request is posted, which is the
 * operation's start — not from the last message, which would let a worker that
 * keeps talking run forever.
 */
function runInWorker<T>(
    request: DistributiveOmit<WorkerRequest, 'runId'> & { runId?: string },
    transfer: Transferable[],
    interpret: (response: WorkerResponse) => { done: true; value: T } | { done: false },
    onTimeoutOrFailure: (code: string, reason: string, detail?: string) => T,
    timeoutMs = WORKER_TIMEOUT_MS,
): RunHandle<T> {
    const runId = request.runId ?? nextRunId();
    let settled = false;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /**
     * How the run is settled from outside, notably by `cancel`.
     *
     * A cancel that tore the worker down without settling the promise would
     * leave every caller awaiting it forever — and the caller is a component
     * whose `finally` clears the busy flag, so the UI would sit at "処理中"
     * with nothing running. Cancellation is an answer, and it is delivered.
     */
    let settle: ((value: T) => void) | null = null;

    const cleanup = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (worker) {
            worker.terminate();
            worker = null;
        }
    };

    const promise = new Promise<T>((resolve) => {
        const finish = (value: T): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        settle = finish;

        try {
            worker = new Worker(new URL('./split-merge.worker.ts', import.meta.url), {
                type: 'module',
            });
        } catch (error) {
            finish(onTimeoutOrFailure(
                'WORKER_FAILED',
                'この処理を実行できませんでした。',
                String((error as Error)?.message ?? error),
            ));
            return;
        }

        worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
            const response = event.data;
            if (response.runId !== runId && response.kind !== 'failed') return;
            if (response.kind === 'failed') {
                finish(onTimeoutOrFailure(response.code, response.reason, response.detail));
                return;
            }
            const verdict = interpret(response);
            if (verdict.done) finish(verdict.value);
        });

        // An error that escapes the worker arrives as an opaque event. It is
        // turned into a typed failure here rather than surfaced as one.
        worker.addEventListener('error', (event: ErrorEvent) => {
            finish(onTimeoutOrFailure('WORKER_FAILED', 'この処理を完了できませんでした。', event.message));
        });
        worker.addEventListener('messageerror', () => {
            finish(onTimeoutOrFailure('WORKER_FAILED', 'この処理の結果を受け取れませんでした。'));
        });

        timer = setTimeout(() => {
            finish(onTimeoutOrFailure(
                'WORKER_FAILED',
                '処理に時間がかかりすぎたため中止しました。',
                `timeout after ${timeoutMs} ms`,
            ));
        }, timeoutMs);

        worker.postMessage({ ...request, runId } as WorkerRequest, transfer);
    });

    return {
        promise,
        cancel: () => {
            if (settled) return;
            // Told first, then torn down: the cooperative check is what makes
            // "no late publish" hold in the window before terminate() lands.
            try {
                worker?.postMessage({ kind: 'cancel', runId } satisfies WorkerRequest);
            } catch {
                // The worker may already be gone. Cancelling it twice is fine.
            }
            settle?.(onTimeoutOrFailure(
                'CANCELLED',
                '操作が変更されたため、この処理は中止しました。',
            ));
        },
    };
}

/** A cancelled or failed run, shaped as the refusal the UI already knows. */
const failedExtract = (code: string, reason: string, detail?: string): ExtractResult => ({
    status: code === 'CANCELLED' ? M6_STATUS.CANCELLED : M6_STATUS.WORKER_FAILED,
    reason,
    bytes: null,
    outputName: '',
    losses: [],
    planned: null,
    actual: null,
    readback: null,
    detail: detail ? { detail } : undefined,
});

const failedMerge = (code: string, reason: string, detail?: string): MergeResult => ({
    status: code === 'CANCELLED' ? M6_STATUS.CANCELLED : M6_STATUS.WORKER_FAILED,
    reason,
    bytes: null,
    outputName: '',
    intake: [],
    losses: [],
    renamedFields: [],
    cumulative: null,
    readback: null,
    detail: detail ? { detail } : undefined,
});

/** Re-attach transferred bytes to the result they belong to. */
const withBytes = <T extends { bytes: Uint8Array | null }>(
    result: T,
    response: WorkerResponse,
): T => {
    const buffer = 'transferBytes' in response ? response.transferBytes : undefined;
    return buffer ? { ...result, bytes: new Uint8Array(buffer) } : result;
};

export function extractInWorker(
    bytes: Uint8Array,
    options: {
        sourceName: string;
        selection: number[];
        destinationPolicy: DestinationPolicy;
        confirmedLosses?: string[];
        policy?: M6PolicyOverrides;
    },
): RunHandle<ExtractResult> {
    // The caller's bytes are copied once, here, so the transfer does not detach
    // a buffer the UI still needs for a preview.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return runInWorker<ExtractResult>(
        {
            kind: 'extract',
            bytes: copy.buffer,
            sourceName: options.sourceName,
            selection: options.selection,
            destinationPolicy: options.destinationPolicy,
            confirmedLosses: options.confirmedLosses ?? [],
            policy: options.policy,
        },
        [copy.buffer],
        (response) => {
            if (response.kind === 'extract-done') {
                return { done: true, value: withBytes(response.result, response) };
            }
            if (response.kind === 'cancelled') {
                return {
                    done: true,
                    value: failedExtract('CANCELLED', '操作が変更されたため、この処理は中止しました。'),
                };
            }
            return { done: false };
        },
        failedExtract,
    );
}

export function intakeInWorker(
    inputs: { id: string; name: string; type?: string; bytes: Uint8Array }[],
    policy?: M6PolicyOverrides,
): RunHandle<IntakeRecord[]> {
    const copies = inputs.map((i) => {
        const copy = new Uint8Array(i.bytes.length);
        copy.set(i.bytes);
        return { id: i.id, name: i.name, type: i.type, bytes: copy.buffer };
    });
    return runInWorker<IntakeRecord[]>(
        { kind: 'merge-intake', inputs: copies, policy },
        copies.map((c) => c.bytes),
        (response) => {
            if (response.kind === 'intake-done') return { done: true, value: response.intake };
            if (response.kind === 'cancelled') return { done: true, value: [] };
            return { done: false };
        },
        () => [],
    );
}

export function mergeInWorker(
    inputs: { id: string; name: string; type?: string; bytes: Uint8Array }[],
    plan: MergePlan,
    options: {
        metadataPolicy: MergeMetadataPolicy;
        collisionPolicy: FieldCollisionPolicy;
        policy?: M6PolicyOverrides;
    },
): RunHandle<MergeResult> {
    const copies = inputs.map((i) => {
        const copy = new Uint8Array(i.bytes.length);
        copy.set(i.bytes);
        return { id: i.id, name: i.name, type: i.type, bytes: copy.buffer };
    });
    return runInWorker<MergeResult>(
        {
            kind: 'merge-run',
            inputs: copies,
            plan,
            metadataPolicy: options.metadataPolicy,
            collisionPolicy: options.collisionPolicy,
            policy: options.policy,
        },
        copies.map((c) => c.bytes),
        (response) => {
            if (response.kind === 'merge-done') {
                return { done: true, value: withBytes(response.result, response) };
            }
            if (response.kind === 'cancelled') {
                return {
                    done: true,
                    value: failedMerge('CANCELLED', '操作が変更されたため、この処理は中止しました。'),
                };
            }
            return { done: false };
        },
        failedMerge,
    );
}
