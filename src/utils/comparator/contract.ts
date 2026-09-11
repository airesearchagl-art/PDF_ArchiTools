/**
 * What a comparison promises, and what it refuses.
 *
 * The comparator's old contract was "every input produces a picture", which is
 * why a different sheet size and a moved wall looked the same to a reviewer.
 * This file is the vocabulary that replaces it: a plan that says whether the
 * comparison can be made, and a result that says what it found. Nothing may
 * produce the second without having earned the first.
 *
 * Adopted from `research/m4-comparator-reliability/` (PR #21).
 */

/**
 * Whether a comparison can be made at all.
 *
 * Every refusal names itself. A user who is told `GEOMETRY_MISMATCH` knows the
 * tool declined; a user shown 99.4% of ink in red does not.
 */
export const PLAN = {
    READY_TO_COMPARE: 'READY_TO_COMPARE',
    MISSING_PAGE: 'MISSING_PAGE',
    GEOMETRY_MISMATCH: 'GEOMETRY_MISMATCH',
    RENDER_FAILED: 'RENDER_FAILED',
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    OVER_WORK_BUDGET: 'OVER_WORK_BUDGET',
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
    UNSUPPORTED: 'UNSUPPORTED',
    CANCELLED: 'CANCELLED',
} as const;

export type PlanStatus = (typeof PLAN)[keyof typeof PLAN];

/** What was found, reachable only from a comparison that actually ran. */
export const RESULT = {
    MATCH: 'MATCH',
    CHANGE: 'CHANGE',
} as const;

export type ResultStatus = (typeof RESULT)[keyof typeof RESULT];

/**
 * How far two sheets may differ and still be the same sheet.
 *
 * One point. Not three: a 3 pt difference is about a millimetre, and a
 * millimetre of drift across a sheet produced 75.9% false change on the
 * research corpus. A point is below anything a generator disagreement produces.
 */
export const GEOMETRY_TOLERANCE_PT = 1;

/**
 * The share of ink below which a comparison would be called a match anyway.
 *
 * Zero, and fixed. Every control reaches exactly 0 differing pixels, so a floor
 * is not needed to make MATCH reachable — and the 0.5% floor the research
 * started with converted six of seven true changes into matches. This is not a
 * setting.
 */
export const MATCH_RATIO_FLOOR = 0;

/**
 * The spatial tolerance, as a product contract rather than a unit.
 *
 * A tolerance suppresses true changes as well as noise: measured, a dimension
 * reading 1200 against one reading 1300 becomes a MATCH at 0.2 mm at 72 dpi.
 * 72 dpi is what sets the ceiling — a millimetre is fewer pixels there and the
 * mark is smaller — so the maximum is the *minimum* safe bound across every
 * resolution the tool offers, not what the middle of the range would allow.
 */
export const SPATIAL_TOLERANCE_POLICY = {
    unit: 'mm',
    default: 0,
    minimum: 0,
    maximum: 0.15,
    step: 0.05,
    /** Zero is selectable at every resolution, always. */
    zeroAlwaysAvailable: true,
    supportedDpi: [72, 150, 300, 450] as readonly number[],
} as const;

/**
 * What the user is told when they move it off zero.
 *
 * It must not say "ignores small shifts". Measured, a non-zero tolerance also
 * erases a changed digit and a swapped symbol, and a user who turned it on
 * expecting a positional-noise filter would be misled by their own setting.
 */
export const SPATIAL_TOLERANCE_DISCLOSURE =
    '許容値を大きくすると微小な位置差を吸収できますが、'
    + '小さな文字・寸法・記号・形状の変更も検出されにくくなる場合があります。';

/** True when the comparison is running at the contract's default. */
export function isDefaultSpatialTolerance(millimetres: number): boolean {
    return millimetres === SPATIAL_TOLERANCE_POLICY.default;
}

/** Millimetres to a whole-pixel radius, at the resolution actually rendered. */
export function pixelRadiusFor(millimetres: number, dpi: number): number {
    return Math.max(0, Math.round((millimetres * dpi) / 25.4));
}

/**
 * The working set one comparison may hold.
 *
 * 512 MiB is the recommended default and not a fixed limit: a user may choose
 * more, explicitly. Nothing raises it automatically — a budget that grows to
 * fit the job is not a budget.
 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

export const MEMORY_BUDGET_PRESETS: readonly { bytes: number; label: string }[] = [
    { bytes: 512 * 1024 * 1024, label: '512 MiB（推奨）' },
    { bytes: 1024 * 1024 * 1024, label: '1 GiB' },
    { bytes: 2048 * 1024 * 1024, label: '2 GiB' },
];

/**
 * The whole-job comparison-**kernel** work ceiling.
 *
 * Twelve billion pixel reads, summed over every requested page and every
 * required reference pair — not per page, because the export and the change
 * report run over ranges and a hundred pages that each pass are a hundred times
 * the work.
 *
 * The research projected roughly 22 seconds for this, and that figure covers
 * the comparison kernel only: not rendering, not readback, not mask extraction,
 * not scheduling, not painting, not encoding, not assembly. It is not a
 * promise about how long anyone waits, and nothing in the UI may present it as
 * one.
 */
export const MAX_COMPARISON_WORK_UNITS = 12_000_000_000;

/**
 * The algorithm the planner is bound to.
 *
 * A work unit means about forty-two times more work under the shipped nested
 * scan than under a separable dilation, so a ceiling in units is meaningless
 * until the algorithm is named. There is no silent default.
 */
export const COMPARISON_ALGORITHM = 'separable-dilation' as const;

/**
 * The finished output one operation may hold.
 *
 * The M4 sink is the memory-resident container, so every produced visual is
 * live until the artifact is saved. Under the owned encoder's ~4.001 bytes per
 * pixel that is about seven A4 pages at 300 dpi with two members — a known
 * limitation, and not one to be solved by quietly switching to an encoder whose
 * size cannot be bounded.
 *
 * Every item the artifact will contain counts against it, not only the
 * comparisons: a page nobody could compare is written as a notice image, and a
 * notice costs what any other image of its size costs.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * What a run is producing, because the cost of a run depends on it.
 *
 * The preview keeps its visuals as pixels on screen; the two files hold every
 * image in a jsPDF document until it is saved, and write notices of different
 * sizes. A plan that did not know which one it was for would be pricing a
 * different job from the one that runs.
 */
export const ARTIFACT = {
    PREVIEW: 'PREVIEW',
    COMPARISON_PDF: 'COMPARISON_PDF',
    CHANGE_REPORT: 'CHANGE_REPORT',
} as const;

export type ArtifactKind = (typeof ARTIFACT)[keyof typeof ARTIFACT];

/** One thing an artifact will contain, named by why it is there. */
export const ARTIFACT_ITEM = {
    /** A compared pair. In the Change Report it is written only on CHANGE, cropped. */
    PAIR_VISUAL: 'PAIR_VISUAL',
    MISSING_PAGE_NOTICE: 'MISSING_PAGE_NOTICE',
    GEOMETRY_MISMATCH_NOTICE: 'GEOMETRY_MISMATCH_NOTICE',
} as const;

export type ArtifactItemKind = (typeof ARTIFACT_ITEM)[keyof typeof ARTIFACT_ITEM];

/**
 * The raster a notice is drawn into, per file.
 *
 * One source for the planner and for the code that draws it: the preflight has
 * to price the notice the file actually receives, and the two files do not
 * receive the same one.
 */
export const NOTICE_RASTER: Readonly<Record<
    Exclude<ArtifactKind, 'PREVIEW'>, { width: number; height: number }
>> = {
    COMPARISON_PDF: { width: 1240, height: 1754 },
    CHANGE_REPORT: { width: 1240, height: 620 },
};

/** Which member is compared against which. Slot 1 is the reference. */
export const MULTI_MEMBER_CONTRACT = 'reference-pairs' as const;

/** A refusal, with the numbers that produced it. */
export interface Refusal {
    status: PlanStatus;
    /** One line, in the user's language. */
    reason: string;
    /** What the user asked for, and what would fit, where that is computable. */
    requested?: string;
    achievable?: string;
}
