/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Candidate resource limits for a Portable Project JSON.
 *
 * Every number here is a *research candidate*. None is a Production constant,
 * and none was chosen by feel: each is tied to a measurement recorded under
 * benchmark/results/ and argued in architecture-research.md (R4, R9). The
 * shape of the argument is the same for all of them --
 *
 *   1. measure what the largest Drawing Set this research was asked to consider
 *      (5000 sheets) actually needs;
 *   2. give that a stated headroom;
 *   3. confirm the import pipeline still finishes inside a stated budget when an
 *      input sits exactly at the limit.
 *
 * The limits are an object, not module constants, on purpose: the tests inject
 * small ones to exercise the refusals without generating huge inputs, the same
 * way M6 injects its load-boundary limits.
 */

const MiB = 1024 * 1024;

export const CANDIDATE_LIMITS = Object.freeze({
    /**
     * Checked against `file.size` before a single byte is read. A 5000-sheet
     * set measured 8.7 to 10.4 MiB; this is about six times the largest. A file
     * at the bound opens in ~0.2 s (hostile-node.json, largestAccepted).
     */
    maxProjectBytes: 64 * MiB,

    // -- lexical pre-scan, before JSON.parse allocates anything ---------------
    /** A real document nests 7 containers deep (measured; scale-*.json, maxDepth). */
    maxNestingDepth: 16,
    /**
     * Every JSON value: containers and primitives alike. A 5000-sheet set
     * measured 335 000 to 395 000; the entity-count limits below, all reached
     * at once, admit roughly 2.4 million.
     */
    maxJsonValues: 4_000_000,
    /**
     * The longest string token as written in the file, escapes included. The
     * longest field the schema allows is 4000 code units; written entirely as
     * \uXXXX escapes that is 24 000.
     */
    maxStringSourceLength: 24_000,
    /** The longest key in the schema is 21 characters. */
    maxKeySourceLength: 64,
    /**
     * The widest object in the schema has 14 properties. Without this bound an
     * object with two million distinct keys stayed under every other limit and
     * cost two seconds and 600 MiB before the schema refused it (the first
     * run of bench-hostile.mjs; the figures are kept in limitations.md).
     */
    maxObjectKeys: 32,

    // -- entity counts, enforced by the schema's maxItems ---------------------
    /** One PDF per sheet is a real way drawing sets arrive, so Sources may equal Sheets. */
    maxSources: 5_000,
    /** The largest set this research was asked to consider. */
    maxSheets: 5_000,
    maxProfiles: 64,
    maxAnalysisRuns: 2_000,
    /**
     * A 5000-sheet set measured 2534 to 5607 findings. Findings are never
     * deleted, so this leaves about nine times that for a Project's lifetime.
     */
    maxFindings: 50_000,
    /** Two decisions per finding at the finding limit. */
    maxDecisions: 100_000,
    maxFingerprintHistoryPerSource: 64,
    maxConfirmationHistoryPerSheet: 32,
    maxSubjectsPerFinding: 5_000,

    // -- strings, enforced by the schema's maxLength (UTF-16 code units) ------
    maxNameLength: 200,
    maxFileNameLength: 255,
    maxFieldValueLength: 300,
    maxFieldRawTextLength: 1_000,
    maxCommentLength: 4_000,

    // -- numbers ----------------------------------------------------------------
    /** M6's adopted per-source input cap (ADOPTED_LOAD_BOUNDARY_LIMITS). */
    maxSourceBytes: 256 * MiB,
    maxPagesPerSource: 5_000,
    /** 200 inches: the largest page a PDF may declare without /UserUnit. */
    maxPagePoints: 14_400,

    /** How many problems a refusal lists before it stops looking. */
    maxReportedProblems: 20,
});

/** A copy with some limits replaced. Unknown names are a programming error. */
export function limitsWith(overrides = {}) {
    for (const name of Object.keys(overrides)) {
        if (!Object.hasOwn(CANDIDATE_LIMITS, name)) throw new RangeError(`unknown limit: ${name}`);
        const value = overrides[name];
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`limit ${name} must be a non-negative integer`);
    }
    return Object.freeze({ ...CANDIDATE_LIMITS, ...overrides });
}
