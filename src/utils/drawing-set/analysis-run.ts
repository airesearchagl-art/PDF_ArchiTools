/**
 * Analysis runs: the record of one execution of an analyser, and the digest
 * that binds it to the bytes it saw.
 *
 * A run is append-only (semantic contract §F; HDR-36-02). Work in progress
 * stays outside the model; when the operation ends -- completed, cancelled or
 * failed -- the run is appended once, with its terminal outcome, and is never
 * rewritten or deleted afterwards, not even when nothing refers to it any
 * more. Leaving an unreferenced run out of a saved file is M7-P4's save-time
 * exception, and nothing in M7-P2 does it.
 */
import { sha256Hex } from './incremental-sha256';
import { MAX_ANALYSIS_RUNS } from './field-bounds';
import type { AnalysisRun, DrawingSet, Sha256Hex } from './model';
import { isLive } from './model';

/**
 * The extraction engine as a run names it. The version is this adapter's own
 * (M7-P2-A); the engine underneath is the Drawing Register's extractRegister,
 * unchanged. It moves when what the adapter records for the same bytes and
 * profile would differ.
 */
export const REGISTER_EXTRACTION_ENGINE = { name: 'register-extraction', version: '1.0.0' } as const;

/**
 * SHA-256 of the sorted `[sourceId, sha256]` pairs of every live Source
 * (semantic contract §F, CAN-02): pairs sorted by the lower-case UUID in
 * ascending code-point order, serialized with JSON.stringify and no added
 * whitespace, hashed as UTF-8, written as lower-case hex. A live Source counts
 * whether or not any Sheet of it is part of the run; names, bytes, the
 * selection and the outcome do not.
 */
export function manifestDigest(set: DrawingSet): Sha256Hex {
    const pairs = set.sources
        .filter(isLive)
        .map((source): [string, string] => [source.id, source.fingerprint.sha256])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return sha256Hex(new TextEncoder().encode(JSON.stringify(pairs)));
}

/** Whether one more run fits (DrawingSet.analysisRuns.maxItems). */
export const hasRoomForRun = (set: DrawingSet): boolean => set.analysisRuns.length < MAX_ANALYSIS_RUNS;

/** The set with one more run. The runs already there are carried over as they are. */
export function appendRun(set: DrawingSet, run: AnalysisRun): DrawingSet | null {
    if (!hasRoomForRun(set)) return null;
    return { ...set, analysisRuns: [...set.analysisRuns, run] };
}
