/**
 * What crosses the boundary between the Drawing Set and its fingerprint Worker.
 *
 *   start  -> one run begins; the Worker holds one hash state, for one Source
 *   chunk  -> the next bytes, in order; the ArrayBuffer is transferred, not copied
 *   finish -> the Worker checks it saw exactly the expected number of bytes
 *             and answers with the digest
 *   cancel -> the run's state is dropped; nothing more is published for it
 *
 * Every chunk is answered (`accepted`) before the next is sent, so at most one
 * chunk is ever waiting in the Worker: the queue is bounded by construction,
 * not by hoping the Worker keeps up.
 */

export type FingerprintRequest =
    | { kind: 'start'; runId: string }
    | { kind: 'chunk'; runId: string; seq: number; chunk: ArrayBuffer }
    | { kind: 'finish'; runId: string; expectedBytes: number }
    | { kind: 'cancel'; runId: string };

export type FingerprintFailureCode =
    /** A message arrived for a run that is not the one in progress, or out of order. */
    | 'PROTOCOL_VIOLATION'
    /** The bytes hashed are not the number of bytes the file has. */
    | 'BYTE_COUNT_MISMATCH'
    /** The Worker could not be started, threw, or could not be heard from. */
    | 'WORKER_FAILED'
    /** No answer within the allowed time. */
    | 'TIMEOUT';

export type FingerprintResponse =
    | { kind: 'accepted'; runId: string; seq: number; byteLength: number }
    | { kind: 'digest'; runId: string; sha256: string; byteLength: number }
    | { kind: 'cancelled'; runId: string }
    | { kind: 'failed'; runId: string; code: FingerprintFailureCode; detail: string };

/**
 * How long one step -- a chunk, or the finish -- may take before the run is
 * abandoned. Generous: a 4 MiB chunk hashes in tens of milliseconds.
 */
export const FINGERPRINT_STEP_TIMEOUT_MS = 60_000;
