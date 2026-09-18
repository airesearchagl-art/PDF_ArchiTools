/**
 * The disposable Worker that runs one M6 operation and is then thrown away.
 *
 * Adopted production shape (H11-B3-4):
 *
 *   Main/UI -> input ArrayBuffer transfer -> disposable Worker
 *           -> pre-parse Load Boundary -> PDFDocument.load() on PASS only
 *           -> planning -> copy/save -> output ArrayBuffer transfer
 *           -> Worker cleanup / terminate
 *
 * The Load Boundary runs **inside** here, immediately before the load, because
 * that is where the bytes are. Running it on the main thread and trusting the
 * verdict across the boundary would make the check a message rather than a
 * gate.
 *
 * Cancellation is cooperative and checked at every boundary control returns from
 * an `await`: a cancelled run publishes nothing. The client terminates the
 * worker as well, so a run that ignores cancellation cannot outlive it either —
 * but the cooperative check is what makes "no late publish" true even in the
 * window before `terminate()` takes effect.
 */
import { runExtract } from '../extract';
import { intakeSources, planMerge, runMerge } from '../merge';
import type { MergeInput } from '../merge';
import { policyFrom } from '../policy';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** Runs the client has asked to stop. Checked at every await boundary. */
const cancelled = new Set<string>();

const post = (message: WorkerResponse, transfer: Transferable[] = []): void => {
    (self as unknown as Worker).postMessage(message, transfer);
};

/** Bytes out of a worker travel as a transferable, never as a copy. */
const detach = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
};

const toInputs = (
    raw: { id: string; name: string; type?: string; bytes: ArrayBuffer }[],
): MergeInput[] => raw.map((i) => ({
    id: i.id,
    name: i.name,
    type: i.type,
    bytes: new Uint8Array(i.bytes),
}));

async function handle(request: WorkerRequest): Promise<void> {
    if (request.kind === 'cancel') {
        cancelled.add(request.runId);
        post({ kind: 'cancelled', runId: request.runId });
        return;
    }

    const { runId } = request;
    const stillOurs = (): boolean => !cancelled.has(runId);
    const policy = policyFrom(request.policy ?? {});

    try {
        if (request.kind === 'extract') {
            const result = await runExtract(new Uint8Array(request.bytes), {
                selection: request.selection,
                sourceName: request.sourceName,
                destinationPolicy: request.destinationPolicy,
                confirmedLosses: request.confirmedLosses,
                policy,
                stillOurs,
            });
            if (!stillOurs()) {
                post({ kind: 'cancelled', runId });
                return;
            }
            // The bytes are moved out of the result so the response can transfer
            // them; leaving them on the object would post a copy alongside.
            const buffer = result.bytes ? detach(result.bytes) : undefined;
            post(
                {
                    kind: 'extract-done',
                    runId,
                    result: { ...result, bytes: null },
                    transferBytes: buffer,
                },
                buffer ? [buffer] : [],
            );
            return;
        }

        if (request.kind === 'merge-intake') {
            const intake = await intakeSources(toInputs(request.inputs), { policy, stillOurs });
            if (!stillOurs()) {
                post({ kind: 'cancelled', runId });
                return;
            }
            post({ kind: 'intake-done', runId, intake });
            return;
        }

        if (request.kind === 'merge-run') {
            const inputs = toInputs(request.inputs);
            const plan = planMerge(request.plan.intake, {
                metadataPolicy: request.metadataPolicy,
                collisionPolicy: request.collisionPolicy,
                policy,
            });
            const result = await runMerge(inputs, plan, {
                metadataPolicy: request.metadataPolicy,
                collisionPolicy: request.collisionPolicy,
                confirmedLosses: request.confirmedLosses,
                confirmedFingerprint: request.confirmedFingerprint,
                policy,
                stillOurs,
            });
            if (!stillOurs()) {
                post({ kind: 'cancelled', runId });
                return;
            }
            const buffer = result.bytes ? detach(result.bytes) : undefined;
            post(
                {
                    kind: 'merge-done',
                    runId,
                    result: { ...result, bytes: null },
                    transferBytes: buffer,
                },
                buffer ? [buffer] : [],
            );
            return;
        }
    } catch (error) {
        post({
            kind: 'failed',
            runId,
            code: 'WORKER_FAILED',
            reason: 'この処理を完了できませんでした。',
            detail: String((error as Error)?.message ?? error),
        });
    } finally {
        cancelled.delete(runId);
    }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    void handle(event.data);
});

/**
 * An unhandled rejection inside the worker must not be silence.
 *
 * Without this the page would see a worker that simply stopped answering, and
 * the client's timeout would report it as a timeout — a different and less
 * useful statement than "it failed".
 */
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    post({
        kind: 'failed',
        runId: 'unknown',
        code: 'WORKER_FAILED',
        reason: 'この処理を完了できませんでした。',
        detail: String(event.reason),
    });
});
