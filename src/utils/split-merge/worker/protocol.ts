/**
 * What crosses the Worker boundary, stated as types.
 *
 * The Worker is **defence in depth, not the safety boundary** (H11-B3-4). A
 * Worker has no standard per-worker hard memory ceiling, nothing guarantees a
 * typed refusal before an out-of-memory failure, renderer failure isolation is
 * not a hard safety contract, and a timeout is not a memory bound. The pre-parse
 * Load Boundary is what bounds the load; the Worker contains the failure after
 * the fact and keeps the page responsive.
 *
 * Everything here is structured-cloneable, and the payloads that matter —
 * source bytes in, artifact bytes out — are `ArrayBuffer`s that get
 * **transferred** rather than copied, so a large drawing does not exist twice.
 */
import type { ExtractResult, IntakeRecord, MergePlan, MergeResult } from '../contracts';
import type { M6PolicyOverrides } from '../policy';
import type { DestinationPolicy, FieldCollisionPolicy, MergeMetadataPolicy } from '../contracts';

/** The operations the worker will run. */
export type WorkerRequest =
    | {
        kind: 'extract';
        runId: string;
        bytes: ArrayBuffer;
        sourceName: string;
        selection: number[];
        destinationPolicy: DestinationPolicy;
        confirmedLosses: string[];
        policy?: M6PolicyOverrides;
    }
    | {
        kind: 'merge-intake';
        runId: string;
        inputs: { id: string; name: string; type?: string; bytes: ArrayBuffer }[];
        policy?: M6PolicyOverrides;
    }
    | {
        kind: 'merge-run';
        runId: string;
        inputs: { id: string; name: string; type?: string; bytes: ArrayBuffer }[];
        plan: MergePlan;
        metadataPolicy: MergeMetadataPolicy;
        collisionPolicy: FieldCollisionPolicy;
        confirmedLosses?: string[];
        /** The plan those losses were agreed to for. RF-R3-3. */
        confirmedFingerprint?: string;
        policy?: M6PolicyOverrides;
    }
    | { kind: 'cancel'; runId: string };

/**
 * A worker's answer.
 *
 * `failed` carries a typed code rather than an exception: a worker that throws
 * across the boundary arrives as an opaque `ErrorEvent`, and "something went
 * wrong in a worker" is not a thing to show a person holding a drawing.
 */
export type WorkerResponse =
    | {
        kind: 'extract-done';
        runId: string;
        /** `bytes` is null on the wire; the artifact travels in `transferBytes`. */
        result: ExtractResult;
        transferBytes?: ArrayBuffer;
    }
    | { kind: 'intake-done'; runId: string; intake: IntakeRecord[] }
    | { kind: 'merge-done'; runId: string; result: MergeResult; transferBytes?: ArrayBuffer }
    | { kind: 'cancelled'; runId: string }
    | { kind: 'failed'; runId: string; code: string; reason: string; detail?: string };

/**
 * `Omit` over a union collapses it to the keys they share, which would make a
 * request type that no branch satisfies. Distributing keeps the branches.
 */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** How long an operation may run before the worker is torn down. */
export const WORKER_TIMEOUT_MS = 180_000;
