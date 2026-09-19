/**
 * The limits M6 enforces — and the reason every number in this file is
 * provisional.
 *
 * Two different things are written down here, and conflating them is exactly
 * what the Human Gate forbade:
 *
 *   the MECHANISM   where a limit is checked, what happens when it is exceeded,
 *                   and that exceeding it is a typed refusal raised before the
 *                   work rather than an error after it. ADOPTED
 *                   (H11-B3-1, H11-EXTRACT-3, H11-MERGE-4).
 *
 *   the VALUES      what each limit actually is. NOT ADOPTED. They are product
 *                   choices, they are decided at blocker B4, and B4 is OPEN.
 *
 * So the values below are `PROVISIONAL_POLICY`, they are named that everywhere
 * they are used, and `policy.provisional` is true. Nothing in this codebase may
 * treat them as final, and B4's `forbiddenBeforeClosure` puts Ready, merge,
 * release and production enablement behind closing it.
 *
 * Three rules the values obey, from the record:
 *
 *   - They are NOT the research test values promoted to product defaults
 *     (H11-B3-2). Where a provisional value coincides with one, it is because
 *     the same order of magnitude is the only defensible starting point, and it
 *     is still labelled provisional rather than adopted.
 *   - They are NOT derived from browser heap sizes, page counts, file sizes, or
 *     M5's 512 MiB / 1 GiB / 2 GiB memory presets. Those presets stay
 *     DO NOT ADOPT (H11-MERGE-5, H11-EXTRACT-3).
 *   - They are injectable. A gate drives its own limits so a fixture can reach
 *     a boundary case without the product shipping a fixture's number, and B4
 *     can replace the whole policy without touching a check.
 */

/**
 * What the pre-parse Load Boundary bounds, before `PDFDocument.load()` is
 * called at all.
 *
 * Every term is structural — bytes, declared counts, nesting — and none of them
 * is a heap figure. B3 proved the load's structural expansion can be bounded
 * before the load; it did not turn heap bytes per parsed object into a number,
 * and it makes no memory preset adoptable.
 */
export interface LoadBoundaryLimits {
    /** The raw ceiling, on the file as it arrives. */
    maxInputBytes: number;
    /** Decoded bytes one object or cross-reference stream may produce. */
    maxDecodedBytesPerStream: number;
    /** Decoded bytes the whole document may produce, cumulatively. */
    maxDecodedBytesTotal: number;
    /** How many object or cross-reference streams may appear at all. */
    maxDecodeStreams: number;
    /** Cross-reference entries declared, summed across every XRef stream. */
    maxXrefEntries: number;
    /** Objects one object stream may declare in its `/N`. */
    maxObjectsPerObjectStream: number;
    /** How deep a value may nest before the document is refused. */
    maxNestingDepth: number;
    /**
     * The inflate chunk. Not a safety limit: it is what decides how far past
     * the cap a refused decode may materialise, which is cap + one chunk.
     */
    inflateChunkBytes: number;
}

/**
 * What the post-load structural caps bound, after the source is loaded and
 * before `copyPages` is called.
 *
 * Each of these is one of the terms B2 proved EXACT before the copy happens.
 * They are counts and byte totals, not memory figures — which is precisely why
 * none of them may be back-derived from a heap size.
 */
export interface StructuralCaps {
    /** Indirect objects one Extract may copy. */
    maxCopiedObjects: number;
    /** Raw stream bytes one Extract may duplicate. */
    maxDuplicatedStreamBytes: number;
    /** The largest single reachable raw stream. */
    maxSingleStreamBytes: number;
    /** Copier map entries, which grow with the graph rather than with pages. */
    maxCopierEntries: number;
    /** Objects a whole Merge may accumulate across all its sources. */
    maxCumulativeCopiedObjects: number;
    /** Stream bytes a whole Merge may accumulate across all its sources. */
    maxCumulativeStreamBytes: number;
}

/** The ceiling checked on the artifact itself, after `save()` and before handoff. */
export interface OutputCeiling {
    maxOutputBytes: number;
}

export interface M6Policy {
    loadBoundary: LoadBoundaryLimits;
    structural: StructuralCaps;
    output: OutputCeiling;
    /**
     * True for every policy this repository ships today. It stays true until
     * B4 closes and a Human adopts values. Code may read it; code may not
     * branch on it to relax a check.
     */
    provisional: boolean;
    /** Where these numbers came from, for the manifest and the gate. */
    origin: string;
}

/**
 * Provisional limits — NOT ADOPTED PRODUCT VALUES.
 *
 * Chosen to be safe rather than permissive, because a conservative refusal is a
 * compatibility cost and an under-count is a safety failure. Which of them a
 * real architectural drawing trips is unmeasured; that measurement is B4's
 * closure evidence, and it is the reason these are not final.
 */
export const PROVISIONAL_LOAD_BOUNDARY_LIMITS: LoadBoundaryLimits = {
    maxInputBytes: 256 * 1024 * 1024,
    maxDecodedBytesPerStream: 128 * 1024 * 1024,
    maxDecodedBytesTotal: 512 * 1024 * 1024,
    maxDecodeStreams: 4096,
    maxXrefEntries: 2_000_000,
    maxObjectsPerObjectStream: 100_000,
    maxNestingDepth: 64,
    inflateChunkBytes: 16384,
};

/**
 * Provisional structural caps — NOT ADOPTED PRODUCT VALUES.
 *
 * B4 `mustDecide` names four of these explicitly: max copied object count, max
 * duplicated or reachable stream bytes, max single reachable stream bytes per
 * Extract, and the Merge cumulative structural cap values.
 */
export const PROVISIONAL_STRUCTURAL_CAPS: StructuralCaps = {
    maxCopiedObjects: 2_000_000,
    maxDuplicatedStreamBytes: 1024 * 1024 * 1024,
    maxSingleStreamBytes: 256 * 1024 * 1024,
    maxCopierEntries: 4_000_000,
    maxCumulativeCopiedObjects: 4_000_000,
    maxCumulativeStreamBytes: 2 * 1024 * 1024 * 1024,
};

/**
 * The provisional actual-output ceiling — mechanism ADOPTED, value NOT.
 *
 * M6-H11 adopted an actual-artifact output ceiling and deferred one question:
 * whether M6 shares M5's `MAX_OUTPUT_BYTES` or takes an independently gated
 * value. The research recommended sharing; the Human has not decided, and A7
 * moved the numeric value into B4. So this constant is deliberately declared
 * here rather than imported from M5's `budget.ts`: importing it would make the
 * two share a value by construction and quietly answer the deferred question.
 */
export const PROVISIONAL_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export const PROVISIONAL_POLICY: M6Policy = {
    loadBoundary: PROVISIONAL_LOAD_BOUNDARY_LIMITS,
    structural: PROVISIONAL_STRUCTURAL_CAPS,
    output: { maxOutputBytes: PROVISIONAL_MAX_OUTPUT_BYTES },
    provisional: true,
    origin: 'PROVISIONAL_PRE_B4',
};

/** A deep partial, so a caller can override one limit without restating a policy. */
export interface M6PolicyOverrides {
    loadBoundary?: Partial<LoadBoundaryLimits>;
    structural?: Partial<StructuralCaps>;
    output?: Partial<OutputCeiling>;
    origin?: string;
}

/**
 * Build a policy from the provisional one plus overrides.
 *
 * This is how a gate reaches a boundary case: it lowers a limit until a fixture
 * trips it, and the product never ships that number. `provisional` stays true
 * whatever is passed, because nothing a caller supplies is an adoption either.
 */
export function policyFrom(overrides: M6PolicyOverrides = {}): M6Policy {
    return {
        loadBoundary: { ...PROVISIONAL_LOAD_BOUNDARY_LIMITS, ...overrides.loadBoundary },
        structural: { ...PROVISIONAL_STRUCTURAL_CAPS, ...overrides.structural },
        output: { maxOutputBytes: PROVISIONAL_MAX_OUTPUT_BYTES, ...overrides.output },
        provisional: true,
        origin: overrides.origin ?? 'INJECTED',
    };
}

/**
 * Reject a policy that cannot be enforced.
 *
 * The prototype validated nothing, so a caller passing `Infinity` or a negative
 * cap silently disabled a check. A limit that cannot refuse is not a limit, and
 * a boundary that cannot be trusted to hold is worse than none because it reads
 * as protection.
 */
export function assertEnforceablePolicy(policy: M6Policy): void {
    const positiveFinite = (value: number, name: string): void => {
        if (!Number.isFinite(value) || value <= 0) {
            throw new RangeError(`M6 policy: ${name} must be a positive finite number, got ${String(value)}`);
        }
    };
    const l = policy.loadBoundary;
    positiveFinite(l.maxInputBytes, 'loadBoundary.maxInputBytes');
    positiveFinite(l.maxDecodedBytesPerStream, 'loadBoundary.maxDecodedBytesPerStream');
    positiveFinite(l.maxDecodedBytesTotal, 'loadBoundary.maxDecodedBytesTotal');
    positiveFinite(l.maxDecodeStreams, 'loadBoundary.maxDecodeStreams');
    positiveFinite(l.maxXrefEntries, 'loadBoundary.maxXrefEntries');
    positiveFinite(l.maxObjectsPerObjectStream, 'loadBoundary.maxObjectsPerObjectStream');
    positiveFinite(l.maxNestingDepth, 'loadBoundary.maxNestingDepth');
    positiveFinite(l.inflateChunkBytes, 'loadBoundary.inflateChunkBytes');

    const s = policy.structural;
    positiveFinite(s.maxCopiedObjects, 'structural.maxCopiedObjects');
    positiveFinite(s.maxDuplicatedStreamBytes, 'structural.maxDuplicatedStreamBytes');
    positiveFinite(s.maxSingleStreamBytes, 'structural.maxSingleStreamBytes');
    positiveFinite(s.maxCopierEntries, 'structural.maxCopierEntries');
    positiveFinite(s.maxCumulativeCopiedObjects, 'structural.maxCumulativeCopiedObjects');
    positiveFinite(s.maxCumulativeStreamBytes, 'structural.maxCumulativeStreamBytes');

    positiveFinite(policy.output.maxOutputBytes, 'output.maxOutputBytes');
}

/**
 * Bounds that are part of the mechanism, not of the product policy.
 *
 * These two were adopted with the detectors that use them — 24 resource scopes
 * for the optional-content walk (M6-H9b) and 32 for an action chain (M6-H9c) —
 * and B4 does not list either. They are here so they are not mistaken for
 * limits awaiting a decision.
 */
export const MECHANISM_BOUNDS = {
    /** M6-H9b: resource scopes followed before a document is refused. */
    maxResourceDepth: 24,
    /** M6-H9c: action-chain and field-tree depth before UNSCANNABLE_ACTIONS. */
    maxActionDepth: 32,
    /** M6-H9b: how deep a nested `/Order` is followed. */
    maxOrderDepth: 32,
    /** How far a `/Parent` chain is resolved when reading an inheritable key. */
    maxInheritanceDepth: 32,
    /**
     * M6-H6: how deep a `/Names` tree is followed, and how many of its nodes
     * are visited, before the reader stops claiming to have read it.
     *
     * Same shape and same reason as the two above: reaching either is a typed
     * refusal from the named-destination reader, never an empty list. A name
     * tree that cannot be read completely is a document whose navigation this
     * tool cannot describe, not a document with no named destinations.
     */
    maxNameTreeDepth: 32,
    maxNameTreeNodes: 100_000,
} as const;
