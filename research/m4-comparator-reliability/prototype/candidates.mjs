/**
 * The four ways a comparison could decide what to compare.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * Candidate 0 is a replica of what ships today, kept honest rather than
 * flattering: it is the thing the others are measured against, and its failures
 * are the reason this spike exists.
 */
import {
    pageGeometry, compareGeometry, uprightGeometry, canonicalMapping,
} from './geometry.mjs';

/**
 * Two stages, not one vocabulary.
 *
 * The first version of this returned `CHANGE` the moment a comparison was
 * eligible, which meant `CHANGE` was doing two jobs: "the geometry is fine,
 * carry on" and "the drawing differs". An identical drawing came back as
 * `CHANGE`, which is exactly the kind of answer this whole spike is about.
 *
 * A plan says whether the comparison can be made. A result says what it found.
 * Only the second may say MATCH or CHANGE, and it can only be reached by
 * actually comparing pixels.
 */
export const PLAN = {
    READY_TO_COMPARE: 'READY_TO_COMPARE',
    MISSING_PAGE: 'MISSING_PAGE',
    GEOMETRY_MISMATCH: 'GEOMETRY_MISMATCH',
    ALIGNMENT_REQUIRED: 'ALIGNMENT_REQUIRED',
    RENDER_FAILED: 'RENDER_FAILED',
    UNSUPPORTED: 'UNSUPPORTED',
    CANCELLED: 'CANCELLED',
    /** The working set the comparison would hold at once is over the ceiling. */
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    /** The work the comparison would do is over the ceiling. */
    OVER_WORK_BUDGET: 'OVER_WORK_BUDGET',
};

export const RESULT = {
    MATCH: 'MATCH',
    CHANGE: 'CHANGE',
};

// ---------------------------------------------------------------------------
// What a change is
// ---------------------------------------------------------------------------

/**
 * The two ink tests that ship today, which do not agree with each other.
 *
 * `computeMultiPdfComposite` takes the mean of the channels;
 * `detectChangeBounds` takes any channel. A colour between the two is painted
 * as a change and then left out of the reported change area. Which one becomes
 * *the* canonical predicate is a product decision, not a research one, and it
 * is on the Human Gate as **H8**. Everything below takes the predicate as an
 * argument so that the choice stays open and the measurement stays comparable.
 */
export const INK_PREDICATES = {
    /** computeMultiPdfComposite: the mean of the three channels. */
    mean: (buf, i) => (buf[i] + buf[i + 1] + buf[i + 2]) / 3 < 200,
    /** detectChangeBounds: any one channel. */
    anyChannel: (buf, i) => buf[i] < 200 || buf[i + 1] < 200 || buf[i + 2] < 200,
};

/** One member's ink, as a flat 0/1 mask. The only thing a verdict may read. */
export function inkMask(buffer, width, height, isInk = INK_PREDICATES.mean) {
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < mask.length; p++) mask[p] = isInk(buffer, p * 4) ? 1 : 0;
    return mask;
}

/**
 * The spatial tolerance, applied to the mask rather than to a ratio.
 *
 * "Matched if the other member has ink within `radius`" over a square box is a
 * dilation, and a dilation over a square is separable: any-in-the-box is
 * any-in-the-row-span followed by any-in-the-column-span. That makes it two
 * passes over the pixels regardless of how wide the box is, where the shipped
 * nested loop is `(2r+1)²` reads per ink pixel.
 *
 * Exact, not approximate: the result is the same mask the nested loop produces,
 * which is asserted against the scan below rather than claimed here.
 */
export function dilateMask(mask, width, height, radius) {
    if (radius <= 0) return mask;
    const horizontal = new Uint8Array(width * height);
    const rowSum = new Int32Array(width + 1);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) rowSum[x + 1] = rowSum[x] + mask[row + x];
        for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - radius);
            const x1 = Math.min(width - 1, x + radius);
            horizontal[row + x] = rowSum[x1 + 1] - rowSum[x0] > 0 ? 1 : 0;
        }
    }
    const out = new Uint8Array(width * height);
    const colSum = new Int32Array(height + 1);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) colSum[y + 1] = colSum[y] + horizontal[y * width + x];
        for (let y = 0; y < height; y++) {
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(height - 1, y + radius);
            out[y * width + x] = colSum[y1 + 1] - colSum[y0] > 0 ? 1 : 0;
        }
    }
    return out;
}

/**
 * The canonical semantic change mask for one pair.
 *
 * A pixel is a change when one member has ink there and the other has no ink
 * anywhere within the physical tolerance. That is the whole definition, and it
 * is computed from the two ink masks — never from the composite the user is
 * shown, which is a picture and carries layer colours, a match colour, a match
 * opacity and an encoder.
 *
 * The verdict is taken from this and then the picture is painted. Doing it the
 * other way round makes the answer a property of the palette.
 */
export function pairChangeMask({ a, b, width, height, radius = 0 }) {
    const dilatedA = dilateMask(a, width, height, radius);
    const dilatedB = dilateMask(b, width, height, radius);
    let changePixels = 0;
    let inkPixels = 0;
    for (let p = 0; p < a.length; p++) {
        const inkA = a[p];
        const inkB = b[p];
        if (inkA || inkB) inkPixels += 1;
        if ((inkA && !dilatedB[p]) || (inkB && !dilatedA[p])) changePixels += 1;
    }
    return { changePixels, inkPixels, changed: changePixels > 0 };
}

/**
 * The same mask, computed the way the shipped comparator computes it.
 *
 * Kept only so the separable version can be shown to produce the identical
 * answer rather than asserted to. This is the `(2r+1)²`-per-ink-pixel loop.
 */
export function pairChangeMaskScan({ a, b, width, height, radius = 0 }) {
    const hasNeighbour = (mask, x, y) => {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(height - 1, y + radius);
        for (let ny = y0; ny <= y1; ny++) {
            for (let nx = x0; nx <= x1; nx++) if (mask[ny * width + nx]) return true;
        }
        return false;
    };
    let changePixels = 0;
    let inkPixels = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const inkA = a[p];
            const inkB = b[p];
            if (!inkA && !inkB) continue;
            inkPixels += 1;
            const unmatchedA = inkA && !(radius === 0 ? b[p] : hasNeighbour(b, x, y));
            const unmatchedB = inkB && !(radius === 0 ? a[p] : hasNeighbour(a, x, y));
            if (unmatchedA || unmatchedB) changePixels += 1;
        }
    }
    return { changePixels, inkPixels, changed: changePixels > 0 };
}

// ---------------------------------------------------------------------------
// Being able to stop
// ---------------------------------------------------------------------------

/**
 * The same comparison, in bounded bands, so it can be abandoned.
 *
 * A synchronous nested loop over an A1 cannot observe a cancellation: by the
 * time it returns, the answer it was asked to stop producing is already
 * produced. Every phase here is a band of rows or columns, and control returns
 * to the caller between bands, which is what makes an accepted job abandonable
 * as well as bounded.
 *
 * Written as a generator because that is the smallest thing that shows the
 * property. In production the same shape is a worker loop that checks a
 * generation token between bands.
 */
export function* pairChangeMaskSteps({ a, b, width, height, radius = 0, band = 256 }) {
    function* dilateInBands(mask, label) {
        if (radius <= 0) return mask;
        const horizontal = new Uint8Array(width * height);
        const rowSum = new Int32Array(width + 1);
        for (let yStart = 0; yStart < height; yStart += band) {
            const yEnd = Math.min(height, yStart + band);
            for (let y = yStart; y < yEnd; y++) {
                const row = y * width;
                for (let x = 0; x < width; x++) rowSum[x + 1] = rowSum[x] + mask[row + x];
                for (let x = 0; x < width; x++) {
                    const x0 = Math.max(0, x - radius);
                    const x1 = Math.min(width - 1, x + radius);
                    horizontal[row + x] = rowSum[x1 + 1] - rowSum[x0] > 0 ? 1 : 0;
                }
            }
            yield { phase: `${label}-rows`, done: yEnd, total: height };
        }
        const out = new Uint8Array(width * height);
        const colSum = new Int32Array(height + 1);
        for (let xStart = 0; xStart < width; xStart += band) {
            const xEnd = Math.min(width, xStart + band);
            for (let x = xStart; x < xEnd; x++) {
                for (let y = 0; y < height; y++) {
                    colSum[y + 1] = colSum[y] + horizontal[y * width + x];
                }
                for (let y = 0; y < height; y++) {
                    const y0 = Math.max(0, y - radius);
                    const y1 = Math.min(height - 1, y + radius);
                    out[y * width + x] = colSum[y1 + 1] - colSum[y0] > 0 ? 1 : 0;
                }
            }
            yield { phase: `${label}-columns`, done: xEnd, total: width };
        }
        return out;
    }

    const dilatedA = yield* dilateInBands(a, 'dilate-a');
    const dilatedB = yield* dilateInBands(b, 'dilate-b');
    let changePixels = 0;
    let inkPixels = 0;
    for (let yStart = 0; yStart < height; yStart += band) {
        const yEnd = Math.min(height, yStart + band);
        for (let p = yStart * width; p < yEnd * width; p++) {
            const inkA = a[p];
            const inkB = b[p];
            if (inkA || inkB) inkPixels += 1;
            if ((inkA && !dilatedB[p]) || (inkB && !dilatedA[p])) changePixels += 1;
        }
        yield { phase: 'compare', done: yEnd, total: height };
    }
    return { changePixels, inkPixels, changed: changePixels > 0 };
}

/**
 * Drive a banded comparison, stopping the moment it is told to.
 *
 * A cancelled comparison returns `CANCELLED` and no verdict. It does not return
 * a partial one: half a change mask is not a smaller change, it is a different
 * drawing.
 */
export function runCancellable(steps, shouldContinue = () => true) {
    let bands = 0;
    let step = steps.next();
    while (!step.done) {
        bands += 1;
        if (!shouldContinue(step.value, bands)) {
            steps.return(undefined);
            return { status: PLAN.CANCELLED, bands, result: null };
        }
        step = steps.next();
    }
    return { status: PLAN.READY_TO_COMPARE, bands, result: step.value };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * The share of ink below which a comparison would be called a match anyway.
 *
 * **Zero.** Not a small number chosen to look safe.
 *
 * The previous round set this to 0.5% on the reasoning that rendering is not
 * bit-exact. The measurements do not support that: every control on the corpus
 * — an identical drawing, a rotation-only pair rendered upright, a crop-origin
 * pair — comes back at exactly **0 differing pixels**, so a zero floor does not
 * make MATCH unreachable. What 0.5% did do is convert a real change into a
 * match: the pale-hatch fixture is a genuine addition to the drawing and
 * reports 43 pixels, 0.054% of the ink, which the floor swallowed.
 *
 * Render variance, where it exists, is a *spatial* disagreement of a pixel or
 * two along a line. The tolerance for that is the physical radius, in
 * millimetres, applied to the mask — not a share of the page applied to the
 * total. A ratio floor cannot tell a hairline everywhere from a wall in one
 * place, and the second is the thing the tool is for.
 *
 * If a noise floor is wanted anyway it is a product decision with a corpus
 * behind it, listed for the Human Gate as **H10**, not a default.
 */
export const MATCH_RATIO_FLOOR = 0;

/**
 * The verdict, from a comparison that actually ran.
 *
 * `changePixels` must come from the canonical semantic mask above. Nothing
 * about how the result is *shown* — layer colours, the match colour, the match
 * opacity, JPEG against PNG, the preview's styling — may reach this function.
 */
export function verdictFor({ changePixels, inkPixels, tolerance = MATCH_RATIO_FLOOR }) {
    if (inkPixels === 0) {
        return {
            status: RESULT.MATCH, ratio: 0, changePixels, inkPixels, tolerance,
        };
    }
    const ratio = changePixels / inkPixels;
    return {
        status: ratio <= tolerance ? RESULT.MATCH : RESULT.CHANGE,
        ratio,
        changePixels,
        inkPixels,
        tolerance,
    };
}

/** The verdict with no floor at all, stated separately so it can be asserted. */
export function canonicalVerdict({ changePixels, inkPixels }) {
    return verdictFor({ changePixels, inkPixels, tolerance: 0 });
}

/**
 * How far two sheets may differ and still be called the same sheet.
 *
 * **One point**, applied independently to width and height.
 *
 * Not three. A 3pt difference -- about a millimetre -- produced 75.9% false
 * change on the measured corpus, so it is not rounding noise to absorb; it is
 * the smallest paper difference in the corpus and it already wrecks the answer.
 * A point is about a third of a millimetre, which is below anything a generator
 * disagreement in this corpus produces and far below anything that matters.
 */
export const GEOMETRY_TOLERANCE_PT = 1;

// ---------------------------------------------------------------------------
// The render budget
// ---------------------------------------------------------------------------

/**
 * What a comparison actually holds in memory at once.
 *
 * The Annotator's 8 Mpx ceiling does not transfer. That bounds one transparent
 * fragment; this holds every layer's RGBA at full page size *simultaneously*,
 * plus a normalising canvas, plus the composite, plus whatever the JPEG encoder
 * needs. Counting one canvas would understate a two-layer A0 comparison by
 * about four times.
 *
 * Returned in bytes, so the number can be compared with something.
 */
export function estimateMemory({ width, height, layers }) {
    const pixels = width * height;
    const rgba = pixels * 4;
    return {
        pixels,
        perLayerCanvas: rgba,
        // Each layer is rendered, then normalised into a shared canvas and read
        // back out as an ImageData copy that is kept for the whole composite.
        layerCanvases: rgba * layers,
        normalisedCopies: rgba * layers,
        normalisingCanvas: rgba,
        composite: rgba,
        // toDataURL('image/jpeg') materialises a base64 string; roughly 4/3 of
        // the encoded size, and the encoder holds a bitmap while it works.
        encoder: rgba,
        get total() {
            return this.layerCanvases + this.normalisedCopies
                + this.normalisingCanvas + this.composite + this.encoder;
        },
    };
}

/**
 * The comparison's own ceiling, expressed per comparison rather than per canvas.
 *
 * Deliberately not a number carried over from another feature: the shape of the
 * cost is different, and section 22 of the brief says so. What is proposed here
 * is a *total working set*, because that is what the browser has to find.
 */
export const MAX_COMPARISON_BYTES = 512 * 1024 * 1024;

export function checkBudget({ width, height, layers, limit = MAX_COMPARISON_BYTES }) {
    const estimate = estimateMemory({ width, height, layers });
    return {
        ...estimate,
        limit,
        withinBudget: estimate.total <= limit,
    };
}

// ---------------------------------------------------------------------------
// The work budget
// ---------------------------------------------------------------------------

/**
 * Memory and work are two ceilings, and passing one says nothing about the
 * other. An A4 at 300 dpi is 234 MB of working set — comfortable — and, at a
 * half-millimetre tolerance, three billion neighbourhood reads.
 */
export const COMPARISON_ALGORITHM = {
    /** What ships: a `(2r+1)²` box scan per ink pixel, per other member. */
    ANY_NEIGHBOUR_SCAN: 'any-neighbour-scan',
    /** Proposed: two separable dilation passes, flat in the radius. */
    SEPARABLE_DILATION: 'separable-dilation',
};

/**
 * Integer arithmetic that refuses to lie.
 *
 * A work estimate that silently loses precision is worse than no estimate: it
 * would pass a job whose real size is unrepresentable. Anything that leaves the
 * safe-integer range comes back as `null`, and `null` is a refusal.
 */
function safeProduct(...factors) {
    let acc = 1;
    for (const f of factors) {
        if (!Number.isInteger(f) || f < 0) return null;
        acc *= f;
        if (!Number.isSafeInteger(acc)) return null;
    }
    return acc;
}

function safeSum(...terms) {
    let acc = 0;
    for (const t of terms) {
        if (t === null || !Number.isSafeInteger(t)) return null;
        acc += t;
        if (!Number.isSafeInteger(acc)) return null;
    }
    return acc;
}

/**
 * Which members are actually compared against which, under each contract.
 *
 * The work a comparison does is a property of this, not of the member count:
 * four members under `reference-pairs` is three two-member comparisons, and
 * four members under `two-only` is not a comparison at all.
 *
 * `consensus` returns `null` — no bound is derived for it, because no
 * implementation of it has been measured. See **H9**.
 */
export function comparisonGroups({ members, contract }) {
    if (!Number.isInteger(members) || members < 2) return null;
    if (contract === MULTI_MEMBER.TWO_ONLY) {
        return members === 2 ? [{ sourceMembers: 2, comparedOtherMembers: 1 }] : null;
    }
    if (contract === MULTI_MEMBER.REFERENCE_PAIRS) {
        return Array.from(
            { length: members - 1 },
            () => ({ sourceMembers: 2, comparedOtherMembers: 1 }),
        );
    }
    return null;
}

/**
 * What a comparison would cost, in work units, before anything is allocated.
 *
 * A work unit is one pixel read. The previous shape — `pixels x radius² x
 * members` — was described as an upper bound and is not one: at radius 0 it is
 * zero, and a radius-0 comparison still reads every pixel of every member. It
 * also left the multi-member contract out, so four members under
 * `reference-pairs` costed the same as two.
 *
 * The shape here, per compared group:
 *
 *     pixels x sourceMembers                              every pixel, read once
 *   + pixels x sourceMembers x comparedOtherMembers x (2r+1)²   the neighbourhood
 *
 * The second term is conservative by design. The shipped loop only runs the
 * neighbourhood on *ink*, and it exits on the first ink it finds, so a sparse
 * drawing costs a fraction of this. But the ink fraction is not knowable before
 * rendering, and a scanned sheet can be ink nearly everywhere, so the bound
 * assumes it is. A bound that is only true for sparse drawings is not a bound.
 *
 * Under `separable-dilation` the neighbourhood term disappears: two passes over
 * the pixels regardless of the radius. The bound has to be derived for the
 * algorithm that is actually chosen, so it is a parameter rather than a
 * constant.
 */
export function estimateComparisonWork({
    width, height, members, contract,
    radiusPx = 0,
    algorithm = COMPARISON_ALGORITHM.ANY_NEIGHBOUR_SCAN,
    requested = {},
}) {
    const groups = comparisonGroups({ members, contract });
    const pixels = safeProduct(width, height);
    const box = safeProduct(2 * radiusPx + 1, 2 * radiusPx + 1);
    const base = {
        width,
        height,
        pixels,
        members,
        contract,
        algorithm,
        radiusPx,
        neighbourhoodBox: box,
        groups: groups ? groups.length : 0,
        // Requested and effective are recorded together so that a comparison
        // can never be quietly run at settings other than the ones asked for.
        requested: {
            widthPx: width, heightPx: height, members, contract, algorithm,
            radiusPx, ...requested,
        },
        effective: {
            widthPx: width, heightPx: height, members, contract, algorithm, radiusPx,
        },
        degraded: false,
    };
    if (groups === null || pixels === null || box === null) {
        return { ...base, units: null, representable: false };
    }

    let units = 0;
    for (const g of groups) {
        const baseline = safeProduct(pixels, g.sourceMembers);
        const neighbourhood = algorithm === COMPARISON_ALGORITHM.SEPARABLE_DILATION
            // Two separable passes plus the compare pass, per member. Flat in r.
            ? safeProduct(pixels, g.sourceMembers, 3)
            : safeProduct(pixels, g.sourceMembers, g.comparedOtherMembers, box);
        units = safeSum(units, baseline, neighbourhood);
        if (units === null) return { ...base, units: null, representable: false };
    }
    return { ...base, units, representable: true };
}

/**
 * The work ceiling.
 *
 * **12,000,000,000 work units — a recommendation requiring human approval, not
 * a measured threshold.** It is user-visible, because it refuses comparisons.
 *
 * Where it comes from: the highest measured cost per work unit on the corpus is
 * the A4 300 dpi radius-0 pair, at 158 ms for 34,789,440 units — 4.5e-6 ms per
 * unit. That case is the one where the bound is *tightest*, so using it is the
 * pessimistic choice. Twelve billion units at that rate projects to about 55
 * seconds of comparison on the measured machine.
 *
 * What it permits and refuses, at a half-millimetre tolerance and two members:
 * A4 at 300 dpi (2.96e9) and A3 at 300 dpi (5.92e9) are within it; an A1 at
 * 300 dpi (2.37e10) is not, and neither is the largest sheet the memory budget
 * allows once the radius reaches 0.5 mm at 600 dpi (2.4e10).
 *
 * Fifty-five seconds is a long time to wait, which is why it is a ceiling on
 * *refusal* rather than a target: a job under it is expected to be
 * interruptible, and one over it is refused rather than started. The number is
 * a judgement about how much of a person's afternoon one comparison may claim,
 * and the machine it was calibrated on is one machine. Human Gate **H10**.
 */
export const MAX_COMPARISON_WORK_UNITS = 12_000_000_000;

/**
 * The check, run before a single canvas is allocated.
 *
 * Over the ceiling is a **typed refusal**, not a quieter comparison. Reducing
 * the DPI or the tolerance to fit would be the silent-downgrade failure the
 * export path already has, where an A0 asked for at 600 dpi delivers 227 and is
 * still named `_600dpi.pdf`.
 */
export function checkComparisonWork(job, { limit = MAX_COMPARISON_WORK_UNITS } = {}) {
    const estimate = estimateComparisonWork(job);
    if (!estimate.representable) {
        return {
            ...estimate,
            limit,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_WORK_BUDGET,
                reason: estimate.groups === 0
                    ? 'no work bound is derived for this contract'
                    : 'the work this comparison would do is not representable',
            },
        };
    }
    const withinBudget = estimate.units <= limit;
    return {
        ...estimate,
        limit,
        withinBudget,
        refusal: withinBudget ? null : {
            status: PLAN.OVER_WORK_BUDGET,
            reason: `${estimate.units.toLocaleString('en-US')} work units against a `
                + `ceiling of ${limit.toLocaleString('en-US')}`,
        },
    };
}

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

/**
 * The tolerance a user means, in units they can reason about.
 *
 * Today the threshold is a pixel radius, so the same setting means a different
 * physical distance at every DPI: `threshold = 2` is 0.34 mm at 150 DPI and
 * 0.08 mm at 600. A drawing office that calibrates its tolerance at one
 * resolution silently gets a different comparison at another.
 */
export function pixelRadiusFor(millimetres, dpi) {
    const pixelsPerMm = dpi / 25.4;
    return Math.max(0, Math.round(millimetres * pixelsPerMm));
}

export function millimetresFor(pixelRadius, dpi) {
    return (pixelRadius * 25.4) / dpi;
}

// ---------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------

/**
 * Candidate 0 — what ships today.
 *
 * Each page rendered on its own terms, the canvases sized to the largest, the
 * smaller ones drawn at the top-left of a white field. No geometry is examined,
 * a missing page is skipped, and a layer that fails to render is dropped with a
 * console warning while the rest continue.
 *
 * It always produces a picture. That is the problem.
 */
export function candidateBaseline({ pages }) {
    const present = pages.filter((p) => p.available && !p.renderError);
    if (present.length === 0) return { status: PLAN.RENDER_FAILED, pages: [] };
    const width = Math.max(...present.map((p) => p.displayWidth));
    const height = Math.max(...present.map((p) => p.displayHeight));
    return {
        // Not a plan status at all in the shipped design: there is one outcome,
        // and it is "here is a picture". Reported as READY_TO_COMPARE because
        // that is the only thing it ever says, whatever it was given.
        status: PLAN.READY_TO_COMPARE,
        // Whatever is left, aligned at the top-left corner.
        members: present.length,
        droppedMembers: pages.length - present.length,
        width,
        height,
        alignment: 'top-left',
        // Nothing downstream is told any of this happened.
        reported: [],
    };
}

/**
 * Candidate A — strict geometry match.
 *
 * Compares only when the pages describe the same visible sheet. Anything else
 * is refused by name, with the difference stated, so the user knows the tool
 * declined rather than that the drawing changed.
 */
export function candidateStrict({ pages, tolerancePt = GEOMETRY_TOLERANCE_PT }) {
    const missing = pages.filter((p) => !p.available);
    if (missing.length > 0) {
        return {
            status: PLAN.MISSING_PAGE,
            reported: missing.map((p) => `${p.label}: この文書にこのページはありません`),
        };
    }
    const failed = pages.filter((p) => p.renderError);
    if (failed.length > 0) {
        return {
            status: PLAN.RENDER_FAILED,
            reported: failed.map((p) => `${p.label}: ページを描画できませんでした`),
        };
    }

    const [reference, ...others] = pages.map((p) => pageGeometry(p));
    const problems = [];
    others.forEach((g, i) => {
        const verdict = compareGeometry(reference, g, { tolerancePt });
        // A rotation alone is arithmetic; anything else is a question about
        // what "the same place" means, and that is not the tool's to answer.
        const blocking = verdict.differences.filter((d) => d.recoverable !== 'automatic');
        if (blocking.length > 0) {
            problems.push({ member: pages[i + 1].label, differences: blocking });
        }
    });
    if (problems.length > 0) {
        return {
            status: PLAN.GEOMETRY_MISMATCH,
            problems,
            reported: problems.map((p) => `${p.member}: `
                + p.differences.map((d) => d.detail).join(', ')),
        };
    }
    return {
        status: PLAN.READY_TO_COMPARE,
        members: pages.length,
        droppedMembers: 0,
        // Rendering upright removes the only difference that was left.
        width: reference.displayWidth,
        height: reference.displayHeight,
        alignment: 'upright-page-space',
        reported: [],
    };
}

/**
 * Candidate B — canonical upright normalisation.
 *
 * Slot 1 is the reference. Every member is rendered in the canonical upright
 * frame — `getViewport({ scale, rotation: 0 })`, from its own visible box —
 * and mapped into the reference's by the **identity**.
 *
 * The earlier version of this computed a scale from the *display* dimensions,
 * which meant an A4 at `/Rotate 0` against the same A4 at `/Rotate 90` produced
 * x = 0.707, y = 1.414, `rigid: false` — and still returned
 * `READY_TO_COMPARE`. It was offering to compare a drawing it had squashed in
 * one axis and stretched in the other, on two pages that are the same piece of
 * paper. The rotation was never a scale; it was a rotation, and it belongs to
 * the renderer.
 *
 * So there are two cases and no third: the same physical sheet within
 * `tolerancePt`, mapped by the identity, or a different sheet, refused. The
 * invariant `status === READY_TO_COMPARE ⇒ every mapping.rigid` therefore holds
 * by construction, and `assertRigidPlan` below states it as a check anyway,
 * because an invariant nobody tests is a comment.
 */
export function candidateNormalise({ pages, tolerancePt = GEOMETRY_TOLERANCE_PT }) {
    // Presence and render failures first, with the geometry tolerance switched
    // off, so that a missing page is reported as a missing page.
    const present = candidateStrict({ pages, tolerancePt: Infinity });
    if (present.status !== PLAN.READY_TO_COMPARE) return present;

    const geometries = pages.map((p) => pageGeometry(p));
    const [reference, ...others] = geometries;
    const mappings = [];
    for (let i = 0; i < others.length; i++) {
        const label = pages[i + 1].label;
        const differences = compareGeometry(reference, others[i], { tolerancePt });
        const sizeDiff = differences.differences.find((d) => d.kind === 'sheet-size');
        if (sizeDiff) {
            return {
                status: PLAN.GEOMETRY_MISMATCH,
                problems: [{ member: label, differences: [sizeDiff] }],
                reported: [`${label}: ${sizeDiff.detail}`
                    + '（用紙が異なるため、拡大して重ねると寸法が変わります）'],
            };
        }
        const mapping = canonicalMapping(reference, others[i], { tolerancePt });
        if (!mapping.rigid) {
            // Unreachable given the sheet-size check above, and kept anyway:
            // this is the line that makes the invariant a property of the code
            // rather than of the reasoning about the code.
            return {
                status: PLAN.GEOMETRY_MISMATCH,
                problems: [{ member: label, differences: [{ kind: 'non-rigid-mapping' }] }],
                reported: [`${label}: 剛体変換で重ねられないため比較できません`],
            };
        }
        mappings.push({ member: label, ...mapping });
    }

    const upright = uprightGeometry(reference);
    return {
        status: PLAN.READY_TO_COMPARE,
        members: pages.length,
        droppedMembers: 0,
        // The canonical upright frame, in points. Not the display plane.
        width: upright.width,
        height: upright.height,
        renderRotation: 0,
        renderScaleX: 1,
        renderScaleY: 1,
        alignment: 'canonical-upright-page-space',
        mappings,
        reported: [],
    };
}

/**
 * The invariant, as a check rather than a sentence.
 *
 * `READY_TO_COMPARE` from Candidate B means every member is mapped by a rigid
 * transform. Anything else is a plan that has promised a comparison it cannot
 * make honestly.
 */
export function assertRigidPlan(plan) {
    if (plan.status !== PLAN.READY_TO_COMPARE) {
        return { holds: true, reason: 'not a ready plan', mappings: 0 };
    }
    const mappings = plan.mappings ?? [];
    const violations = mappings.filter(
        (m) => m.rigid !== true || m.scaleX !== 1 || m.scaleY !== 1 || m.scaleDelta !== 0
            || m.renderRotation !== 0,
    );
    return {
        holds: violations.length === 0,
        mappings: mappings.length,
        violations,
        reason: violations.length === 0 ? 'every mapping is the identity, rendered upright'
            : `${violations.length} mapping(s) are not rigid`,
    };
}

/**
 * Candidate C — human alignment. **Not implementation-ready.**
 *
 * When the geometry cannot be settled by arithmetic, the tool says so rather
 * than guessing, and that half of this is real: `ALIGNMENT_REQUIRED` names the
 * refusal and invites a person to supply the alignment.
 *
 * What is not real is the other half. Supplying `{ x, y, rotation, scale }`
 * records an object; it does not define one. Nothing here states the coordinate
 * space those numbers are in, their units, the order the transform is applied
 * in, what a rotation pivots about, whether the scale may be non-uniform, what
 * bounds are valid, how any of it interacts with a CropBox or with the upright
 * normalisation above, what the work and memory estimates become afterwards, or
 * how the alignment is carried on a saved result. No aligned comparison has
 * been run end to end.
 *
 * So the honest plan status for "an alignment was supplied" is not
 * `READY_TO_COMPARE`. It is a refusal that names what is missing. This is a
 * deliberate change from the previous round, made for the same reason as the
 * Candidate B one: a plan may not claim a comparison it cannot perform.
 */
export function candidateHumanAlignment({
    pages, alignment = null, tolerancePt = GEOMETRY_TOLERANCE_PT,
}) {
    const strict = candidateStrict({ pages, tolerancePt });
    if (strict.status !== PLAN.GEOMETRY_MISMATCH) return strict;
    if (!alignment) {
        return {
            ...strict,
            status: PLAN.ALIGNMENT_REQUIRED,
            implementationReady: false,
            reported: strict.reported.map((r) => `${r}（位置合わせを指定すると比較できます）`),
        };
    }
    return {
        ...strict,
        status: PLAN.UNSUPPORTED,
        implementationReady: false,
        requires: 'alignment-architecture-sub-spike',
        // Recorded, not applied. The distinction is the point.
        recordedAlignment: alignment,
        appliedAlignment: null,
        missingContract: [
            'coordinate space', 'units', 'transform order', 'rotation pivot',
            'uniform vs non-uniform scaling', 'bounds', 'validation',
            'CropBox / upright interaction', 'memory and work after alignment',
            'saved provenance', 'aligned MATCH/CHANGE round trip',
        ],
        reported: ['位置合わせ後の比較契約が未定義のため、この研究では比較できません'],
    };
}

// ---------------------------------------------------------------------------
// More than two members
// ---------------------------------------------------------------------------

/**
 * What "matched" means when three or four documents are compared.
 *
 * The shipped rule is *any other layer*: a pixel is matched if any other member
 * has ink near it. With two members that is the same as "they agree". With four
 * it is not, and the difference is not academic -- two agreeing pairs cancel out.
 * A and B put a wall in one place, C and D put it somewhere else, every pixel
 * finds a partner, and the comparison comes back clean.
 *
 * Two contracts are implemented and measured. The third is described and not
 * implemented, and describing a contract is not the same as offering it.
 */
export const MULTI_MEMBER = {
    /** Two members only; three or more is refused. Measured. */
    TWO_ONLY: 'two-only',
    /** Every non-reference member compared against slot 1, independently. Measured. */
    REFERENCE_PAIRS: 'reference-pairs',
    /**
     * A location matches only when *every* member agrees about it.
     *
     * **Deferred.** No implementation of this has been run against the corpus,
     * so nothing is known about what it does with a blank member, a missing
     * member, a member that failed to render, or a reference against three
     * different documents. It is not a selectable option in this round.
     */
    CONSENSUS: 'consensus',
};

/** Contracts a comparison may actually be planned under in this round. */
export const IMPLEMENTED_CONTRACTS = [MULTI_MEMBER.TWO_ONLY, MULTI_MEMBER.REFERENCE_PAIRS];

/**
 * Whether a set of members can be compared under a given contract.
 *
 * `REFERENCE_PAIRS` needs the diff itself to change, which is why this returns
 * a plan rather than a verdict: the point here is what the architecture
 * promises, not how the pixels are counted.
 */
export function planMultiMember({ members, contract }) {
    if (members < 2) {
        return {
            status: PLAN.UNSUPPORTED,
            reported: ['比較するには2つ以上のPDFが必要です'],
        };
    }
    if (contract === MULTI_MEMBER.CONSENSUS) {
        // Refused at any member count, including two, because "every member
        // agrees" has not been implemented or measured at any member count.
        return {
            status: PLAN.UNSUPPORTED,
            contract,
            deferred: true,
            reported: ['全員一致（consensus）契約は未実装・未計測のため選択できません'],
        };
    }
    if (members === 2) return { status: PLAN.READY_TO_COMPARE, contract, pairs: 1 };

    if (contract === MULTI_MEMBER.TWO_ONLY) {
        return {
            status: PLAN.UNSUPPORTED,
            reported: [`同時に比較できるのは2つまでです（現在 ${members} 件）`],
        };
    }
    if (contract === MULTI_MEMBER.REFERENCE_PAIRS) {
        // Slot 1 against each of the others, and the overall verdict is MATCH
        // only if every pair matches. No pair can be cancelled by another.
        return { status: PLAN.READY_TO_COMPARE, contract, pairs: members - 1 };
    }
    return { status: PLAN.UNSUPPORTED, contract, reported: ['未知の比較契約です'] };
}
