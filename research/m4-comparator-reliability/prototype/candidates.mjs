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
    /** The finished output the operation would hold is over the ceiling. */
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
    /** The temporary bytes the operation needs will not fit in storage. */
    OVER_STORAGE_CAPACITY: 'OVER_STORAGE_CAPACITY',
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
 * The picture, painted from the masks alone.
 *
 * This is what makes the memory model below possible, and it is a property of
 * the shipped compositor rather than a simplification of it:
 * `computeMultiPdfComposite` starts each pixel white and multiplies in a *flat*
 * colour wherever `isInk` is true. It never reads the source pixel's intensity.
 * So the composite is a function of the ink masks, the dilated masks, the layer
 * colours, the match colour and the match opacity — and of nothing else.
 *
 * The consequence: once every member's mask has been extracted, no member's
 * RGBA is needed again, by the verdict or by the picture. Four bytes per pixel
 * per member stop being co-resident with anything.
 *
 * Asserted byte-for-byte against the production compositor rather than argued.
 *
 * **This paints the any-other-member rule**, which is what ships. With two
 * members that is the same as "they agree" and it is correct. With more, it is
 * the rule the verdict rejects — so it must not be used to present a
 * reference-pairs result, or the structured status would say CHANGE over a
 * picture in which every mark found a partner. Use `presentReferencePairs`.
 */
export function compositeFromMasks({
    masks, dilated, colors, width, height,
    matchColor = [0, 0, 0], matchOpacity = 1,
}) {
    const out = new Uint8ClampedArray(width * height * 4);
    const members = masks.length;
    for (let p = 0; p < width * height; p++) {
        let r = 255;
        let g = 255;
        let b = 255;
        for (let l = 0; l < members; l++) {
            if (!masks[l][p]) continue;
            let isMatch = false;
            for (let k = 0; k < members; k++) {
                if (k === l) continue;
                if (dilated[k][p]) { isMatch = true; break; }
            }
            const inkR = isMatch ? matchColor[0] : colors[l][0];
            const inkG = isMatch ? matchColor[1] : colors[l][1];
            const inkB = isMatch ? matchColor[2] : colors[l][2];
            if (isMatch && matchOpacity < 1.0) {
                const matchedR = r * inkR;
                const matchedG = g * inkG;
                const matchedB = b * inkB;
                r = r * (1 - matchOpacity) + matchedR * matchOpacity;
                g = g * (1 - matchOpacity) + matchedG * matchOpacity;
                b = b * (1 - matchOpacity) + matchedB * matchOpacity;
            } else {
                r *= inkR;
                g *= inkG;
                b *= inkB;
            }
        }
        const i = p * 4;
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = 255;
    }
    return out;
}

/**
 * What a reference-pairs comparison looks like.
 *
 * The verdict and the picture have to be produced by the same rule, and the
 * previous round left them disagreeing. `reference-pairs` correctly reported
 * CHANGE on the two-against-two set — and the picture was still painted by the
 * any-other-member rule, in which A finds B at one wall and C finds D at the
 * other, every mark finds a partner, and the user is shown a clean sheet under
 * a status that says something changed. A correct status over a misleading
 * picture is not better than the shipped behaviour; it is the same wrong answer
 * with a label the user cannot see.
 *
 * So a reference-pairs result is **one visual per pair**, each painted by the
 * two-member rule that is coherent: slot 1 against member *n*, and nothing
 * else. The overall verdict is MATCH only when every pair matches, which is
 * already the contract — this is the same decomposition applied to what is
 * shown rather than only to what is decided. It also answers the question the
 * user actually has, which is not "did anything differ" but "**which** of these
 * differs from the reference, and where".
 *
 * Pairs are produced serially, so only the reference's dilation and the current
 * member's are live at once. The memory model depends on that.
 */
export function presentReferencePairs({
    masks, dilated, colors, width, height,
    matchColor = [0, 0, 0], matchOpacity = 1,
}) {
    const visuals = [];
    for (let i = 1; i < masks.length; i++) {
        visuals.push({
            member: i,
            pixels: compositeFromMasks({
                masks: [masks[0], masks[i]],
                dilated: [dilated[0], dilated[i]],
                colors: [colors[0], colors[i]],
                width,
                height,
                matchColor,
                matchOpacity,
            }),
        });
    }
    return visuals;
}

/**
 * How many pixels a painted result actually shows as changed.
 *
 * Taken from the picture rather than from the masks, deliberately: the point is
 * what reaches the user's eye. A matched pixel is painted in the match colour,
 * which is neutral; an unmatched one is painted in its layer's colour, which is
 * not. Cross-checked against the mask count by the gate.
 */
export function visiblyChangedPixels(pixels) {
    let shown = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        if (r > 245 && g > 245 && b > 245) continue;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 30) shown += 1;
    }
    return shown;
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

/**
 * A real task boundary.
 *
 * `setTimeout(…, 0)` rather than a microtask or a `MessageChannel` message,
 * deliberately. A microtask drains before the task queue is touched, so
 * awaiting one proves nothing: nothing a user did can have been delivered yet.
 * Timers are one task source and are served in the order they became due, so a
 * cancellation scheduled *before* this yield is guaranteed to have run by the
 * time it resolves. That determinism is the whole point of the probe.
 */
export function taskBoundary() {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * The banded comparison, driven so that a cancellation can actually arrive.
 *
 * `runCancellable` above proves a *decision point* exists between bands. It
 * does not prove that anything can reach that decision point: it never returns
 * to the event loop, so a click, a settings change or a `postMessage` that
 * arrives while it runs is still sitting in a queue when it finishes. A Web
 * Worker has the same problem — one long synchronous message handler that never
 * yields cannot process the next message.
 *
 * The production scheduling contract, and what this implements:
 *
 *     process one bounded band
 *       -> yield to a task boundary        (queued work is delivered here)
 *       -> read cancellation / generation  (updated by that queued work)
 *       -> verify ownership
 *       -> continue, or stop with no result
 *
 * `owner` carries the M3 rule: a token captured at the start and re-read
 * between bands *and* immediately before publishing. A superseded run returns
 * nothing to publish, which is a different statement from a cancelled one only
 * in why it stopped.
 */
export async function runCancellableAsync(steps, {
    shouldContinue = () => true,
    yieldToTask = taskBoundary,
    owner = null,
} = {}) {
    const superseded = () => owner !== null && owner.current() !== owner.token;
    let bands = 0;
    let step = steps.next();
    while (!step.done) {
        bands += 1;
        await yieldToTask();
        if (!shouldContinue(step.value, bands)) {
            steps.return(undefined);
            return {
                status: PLAN.CANCELLED, bands, result: null,
                reason: 'cancelled', publishable: false,
            };
        }
        if (superseded()) {
            steps.return(undefined);
            return {
                status: PLAN.CANCELLED, bands, result: null,
                reason: 'superseded', publishable: false,
            };
        }
        step = steps.next();
    }
    // Re-checked immediately before publishing, not only during: a run can be
    // superseded by the last thing that happened while its final band ran.
    if (superseded()) {
        return {
            status: PLAN.CANCELLED, bands, result: null,
            reason: 'superseded at publish', publishable: false,
        };
    }
    return {
        status: PLAN.READY_TO_COMPARE, bands, result: step.value,
        reason: 'completed', publishable: true,
    };
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
 * The M4 contract is that there is **no ratio floor at all**, fixed at zero
 * rather than offered as a setting: the corpus shows no control that needs one
 * and six revisions that it hides. It is not a Human Gate item — H10 is the
 * whole-job work ceiling and nothing else. The setting that does this job, in a
 * unit a user can reason about, is the spatial tolerance under H6.
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
// The working set of the proposed architecture
// ---------------------------------------------------------------------------

/**
 * The encoder the bound belongs to.
 *
 * Two rounds of this got the encoding allowance wrong in two different ways.
 * First it was 0.15 bytes per pixel, measured on four composites — a
 * compression *ratio*, which a fail-closed gate may not rest on, because a
 * scanned or hatched sheet need not compress the way these drawings do. Then it
 * was PNG's stored-block worst case, which is a real bound but **not a bound on
 * `canvas.toBlob('image/png')`**: the browser chooses its own DEFLATE strategy,
 * its own block layout, its own IDAT chunking and its own internal scratch, and
 * exposes none of it. A formula for an encoder nobody controls is not a
 * guarantee about the encoder that runs.
 *
 * So the encoder is **owned**. `encodePngStored` below writes RGBA8 with filter
 * 0 on every row, into DEFLATE *stored* blocks of a stated maximum size, inside
 * IDAT chunks of a stated maximum size. Every one of those is a constant here
 * rather than a browser's choice, so the output size is not merely bounded —
 * it is **exactly** `pngStoredSize`, which the gate asserts by encoding real
 * composites and comparing lengths.
 *
 * No new dependency. Stored blocks mean no compression, which is the price:
 * about four bytes per pixel of output where the browser's PNG produced 0.03.
 * That is a deliberate trade of file size for a memory guarantee, and it is the
 * kind of trade a Human Gate should see rather than inherit — **H5**.
 */
export const PNG_STORED_CONTRACT = {
    colourType: 6, // RGBA
    bitDepth: 8,
    filter: 0, // None, on every row
    deflateStrategy: 'stored',
    maxDeflateBlockBytes: 65535,
    maxIdatChunkBytes: 1 << 20,
};

/**
 * The exact encoded size, for the encoder above. Not an estimate.
 *
 * The raster is one filter byte per row plus RGBA. DEFLATE stored blocks add
 * five bytes of header per block; zlib adds a two-byte header and a four-byte
 * Adler-32; the container adds a signature, IHDR, IDAT framing per chunk, and
 * IEND.
 */
export function pngStoredSize({ width, height }) {
    const raster = height * (1 + width * 4);
    const blocks = Math.max(1, Math.ceil(raster / PNG_STORED_CONTRACT.maxDeflateBlockBytes));
    const zlib = 2 + blocks * 5 + raster + 4;
    const idatChunks = Math.max(1, Math.ceil(zlib / PNG_STORED_CONTRACT.maxIdatChunkBytes));
    const signature = 8;
    const ihdr = 12 + 13;
    const iend = 12;
    return signature + ihdr + idatChunks * 12 + zlib + iend;
}

/**
 * What the encoder itself holds while it runs, beyond its output.
 *
 * It streams: it walks the composite a row at a time and writes filter byte and
 * row bytes straight into the stored-block payload. There is no intermediate
 * filtered raster and no intermediate zlib buffer — which is the other half of
 * owning the encoder, because a browser's may well allocate both.
 */
export function encoderScratchUpperBound({ width }) {
    return 1 + width * 4;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * RGBA8 to PNG, deterministically.
 *
 * RESEARCH ONLY, and deliberately small: it exists so that the memory model
 * describes an encoder whose behaviour is stated rather than inferred.
 */
export function encodePngStored({ pixels, width, height }) {
    const out = new Uint8Array(pngStoredSize({ width, height }));
    let pos = 0;
    const u32 = (value) => {
        out[pos++] = (value >>> 24) & 0xFF;
        out[pos++] = (value >>> 16) & 0xFF;
        out[pos++] = (value >>> 8) & 0xFF;
        out[pos++] = value & 0xFF;
    };
    for (const b of [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) out[pos++] = b;

    const chunk = (type, write) => {
        const lengthAt = pos;
        pos += 4;
        const dataStart = pos;
        for (let i = 0; i < 4; i++) out[pos++] = type.charCodeAt(i);
        write();
        const dataEnd = pos;
        const saved = pos;
        pos = lengthAt;
        u32(dataEnd - dataStart - 4);
        pos = saved;
        let crc = 0xFFFFFFFF;
        for (let i = dataStart; i < dataEnd; i++) {
            crc = CRC_TABLE[(crc ^ out[i]) & 0xFF] ^ (crc >>> 8);
        }
        u32((crc ^ 0xFFFFFFFF) >>> 0);
    };

    chunk('IHDR', () => {
        u32(width);
        u32(height);
        out[pos++] = PNG_STORED_CONTRACT.bitDepth;
        out[pos++] = PNG_STORED_CONTRACT.colourType;
        out[pos++] = 0;
        out[pos++] = 0;
        out[pos++] = 0;
    });

    // The zlib stream, written straight into IDAT chunks as it is produced.
    const raster = height * (1 + width * 4);
    const blockMax = PNG_STORED_CONTRACT.maxDeflateBlockBytes;
    const blocks = Math.max(1, Math.ceil(raster / blockMax));
    const zlibLength = 2 + blocks * 5 + raster + 4;
    const idatMax = PNG_STORED_CONTRACT.maxIdatChunkBytes;
    const idatChunks = Math.max(1, Math.ceil(zlibLength / idatMax));

    let zlibWritten = 0;
    let chunkRemaining = 0;
    let chunkStart = 0;
    let chunkLengthAt = 0;
    let chunksOpened = 0;

    const closeChunk = () => {
        const dataEnd = pos;
        const saved = pos;
        pos = chunkLengthAt;
        u32(dataEnd - chunkStart - 4);
        pos = saved;
        let crc = 0xFFFFFFFF;
        for (let i = chunkStart; i < dataEnd; i++) {
            crc = CRC_TABLE[(crc ^ out[i]) & 0xFF] ^ (crc >>> 8);
        }
        u32((crc ^ 0xFFFFFFFF) >>> 0);
    };
    const openChunk = () => {
        chunkLengthAt = pos;
        pos += 4;
        chunkStart = pos;
        for (let i = 0; i < 4; i++) out[pos++] = 'IDAT'.charCodeAt(i);
        chunksOpened += 1;
        chunkRemaining = Math.min(idatMax, zlibLength - zlibWritten);
    };
    const push = (byte) => {
        if (chunkRemaining === 0) {
            if (chunksOpened > 0) closeChunk();
            openChunk();
        }
        out[pos++] = byte;
        chunkRemaining -= 1;
        zlibWritten += 1;
    };

    push(0x78);
    push(0x01);
    let adlerA = 1;
    let adlerB = 0;
    let blockRemaining = 0;
    let rasterRemaining = raster;
    const pushRaster = (byte) => {
        if (blockRemaining === 0) {
            const take = Math.min(blockMax, rasterRemaining);
            // BFINAL is set on the block that carries the last raster byte.
            push(rasterRemaining === take ? 1 : 0);
            push(take & 0xFF);
            push((take >>> 8) & 0xFF);
            push(~take & 0xFF);
            push((~take >>> 8) & 0xFF);
            blockRemaining = take;
        }
        push(byte);
        blockRemaining -= 1;
        rasterRemaining -= 1;
        adlerA = (adlerA + byte) % 65521;
        adlerB = (adlerB + adlerA) % 65521;
    };

    for (let y = 0; y < height; y++) {
        pushRaster(0);
        const rowStart = y * width * 4;
        for (let i = 0; i < width * 4; i++) pushRaster(pixels[rowStart + i]);
    }
    for (const byte of [(adlerB >>> 8) & 0xFF, adlerB & 0xFF,
        (adlerA >>> 8) & 0xFF, adlerA & 0xFF]) push(byte);
    closeChunk();
    void idatChunks;
    void blocks;

    chunk('IEND', () => {});
    return out.subarray(0, pos);
}

/**
 * How the encoded bytes leave the encoder, and what that costs to hold.
 *
 * `toDataURL` returns a **string**: the encoded bytes, then base64 at 4/3 the
 * size, then whatever the engine charges per character — and the encoded buffer
 * is still live while the string is built. A `Blob` built from a typed array
 * copies it once. Neither is free; one is much less free than the other.
 */
export const EXPORT_STRATEGIES = {
    blob: { label: 'Blob([bytes])', base64: false, bytesPerCharacter: 0, copiesOutput: true },
    dataUrl: { label: 'base64 data URL', base64: true, bytesPerCharacter: 2, copiesOutput: false },
};

/** The recommended path, and the one the budget is taken on. */
export const BUDGETED_EXPORT_STRATEGY = 'blob';

/**
 * The working set, phase by phase, for the architecture that was selected.
 *
 * `estimateMemory` above models the **shipped** pipeline, where every member's
 * RGBA is held at once because the compositor is handed all of them. That is
 * the right model for the baseline and the wrong one for the proposal, and
 * keeping the old model while adopting the new architecture would have left the
 * budget claim resting on buffers the design no longer allocates — and omitting
 * the ones it does.
 *
 * The proposed pipeline is five phases, and buffers do not outlive the phase
 * that needs them:
 *
 *     1  render          one member's canvas, and the pixels read back from it
 *     2  mask extraction that readback becomes a 1-byte-per-pixel ink mask
 *     3  dilation        the spatial tolerance, applied to the masks
 *     4  comparison      the semantic change mask, and the verdict
 *     5  presentation    the picture, painted from the masks alone
 *
 * The load-bearing fact is phase 5: `compositeFromMasks` is asserted to produce
 * the identical image to the shipped compositor, so no member RGBA survives
 * phase 2. What is co-resident at the peak is masks, not canvases.
 *
 * Members are rendered **serially**, and under `reference-pairs` the pairs are
 * processed **serially** with the reference mask and its dilation computed once
 * and reused across every pair. Both are part of the contract, not an
 * implementation detail: a parallel implementation has a different peak and
 * would need this recomputed.
 */
export function estimatePhaseMemory({
    width, height, members,
    contract = MULTI_MEMBER.REFERENCE_PAIRS,
    radiusPx = 0,
    exportStrategy = BUDGETED_EXPORT_STRATEGY,
    materialiseChangeMask = true,
}) {
    const pixels = width * height;
    const rgba = pixels * 4;
    const mask = pixels;
    const dilating = radiusPx > 0;
    // Two Int32 running-sum arrays, one per axis. Small, and counted anyway.
    const dilationIndex = dilating ? (width + 1) * 4 + (height + 1) * 4 : 0;
    const strategy = EXPORT_STRATEGIES[exportStrategy]
        ?? EXPORT_STRATEGIES[BUDGETED_EXPORT_STRATEGY];
    // Exact, for the encoder this architecture owns.
    const encodedOutput = pngStoredSize({ width, height });
    const encoderScratch = encoderScratchUpperBound({ width });
    // The encoded bytes are still live while the string is built from them, or
    // while the Blob copies them.
    const encodedHandoff = strategy.base64
        ? Math.ceil(encodedOutput * 4 / 3) * strategy.bytesPerCharacter
        : encodedOutput;

    const phases = {
        // The canvas, the pixels read back from it, and the masks of the
        // members already done.
        render: {
            live: {
                memberCanvas: rgba,
                pixelReadback: rgba,
                masksAlreadyExtracted: mask * Math.max(0, members - 1),
            },
        },
        // The canvas is released; the readback is still live while it is read.
        'mask-extraction': {
            live: { pixelReadback: rgba, masks: mask * members },
        },
        // The reference's dilation is computed once and reused, so only the
        // other member's dilation and one scratch band are transient.
        dilation: {
            live: {
                masks: mask * members,
                dilatedReference: dilating ? mask : 0,
                dilatedOther: dilating ? mask : 0,
                dilationScratch: dilating ? mask : 0,
                dilationIndex,
            },
        },
        comparison: {
            live: {
                masks: mask * members,
                dilated: dilating ? mask * 2 : 0,
                changeMask: materialiseChangeMask ? mask : 0,
            },
        },
        // Under reference-pairs the picture is produced one pair at a time, so
        // only the reference's dilation and the current member's are live —
        // not every member's. That is a consequence of the presentation
        // contract, not an optimisation: an all-member composite would need
        // them all, and would also paint the wrong answer (see
        // `presentReferencePairs`).
        presentation: {
            live: {
                masks: mask * members,
                dilated: dilating ? mask * 2 : 0,
                composite: rgba,
                encoderScratch,
                encodedOutput,
                encodedHandoff,
            },
        },
    };

    let peakPhase = null;
    let peakWorkingSet = 0;
    for (const [name, phase] of Object.entries(phases)) {
        phase.total = Object.values(phase.live).reduce((n, v) => n + v, 0);
        if (phase.total > peakWorkingSet) {
            peakWorkingSet = phase.total;
            peakPhase = name;
        }
    }

    return {
        pixels,
        members,
        contract,
        radiusPx,
        exportStrategy,
        encoder: 'png-stored (owned)',
        encodedOutputIsExact: true,
        presentationContract: contract === MULTI_MEMBER.REFERENCE_PAIRS
            ? 'reference-pairs, one visual per pair, serial'
            : 'two members, one visual',
        memberProcessing: 'serial',
        pairProcessing: contract === MULTI_MEMBER.REFERENCE_PAIRS ? 'serial' : 'single',
        referenceMaskReused: contract === MULTI_MEMBER.REFERENCE_PAIRS,
        phases,
        peakPhase,
        peakWorkingSet,
        bytesPerPixel: peakWorkingSet / pixels,
    };
}

/**
 * The peak, checked before the expensive buffers are allocated.
 *
 * Phase 1 is where the first 4-bytes-per-pixel canvas appears, so the check has
 * to happen before it — which is possible precisely because every term above is
 * arithmetic on the page size, the member count and the tolerance.
 */
export function checkPhaseBudget(job, { limit = MAX_COMPARISON_BYTES } = {}) {
    const estimate = estimatePhaseMemory(job);
    const withinBudget = estimate.peakWorkingSet <= limit;
    return {
        ...estimate,
        limit,
        withinBudget,
        refusal: withinBudget ? null : {
            status: PLAN.OVER_MEMORY_BUDGET,
            reason: `${(estimate.peakWorkingSet / 1e6).toFixed(0)} MB at the `
                + `${estimate.peakPhase} phase, against a ceiling of `
                + `${(limit / 1e6).toFixed(0)} MB`,
        },
    };
}

// ---------------------------------------------------------------------------
// Where the finished bytes live
// ---------------------------------------------------------------------------

/**
 * The phase model bounds one page. It does not bound the **operation**.
 *
 * Two things this architecture already committed to make that a separate
 * problem. Nothing is published until every requested page has succeeded — a
 * partial comparison that looks complete is the failure the whole design exists
 * to prevent. And under `reference-pairs` one source page produces *n − 1*
 * visuals, not one.
 *
 * At A4 300 dpi the owned encoder writes 34.8 MB per visual, so four members
 * are about 104 MB of finished output per source page, and five source pages
 * are **522 MB** — past the 512 MiB ceiling before the container, the writer's
 * own state, or anything still being compared. Every page passes its own peak
 * check and the operation does not fit.
 *
 * The work ceiling does not catch this either: 12e9 units is about 173 A4
 * pages, and this fails at five.
 *
 * So where finished bytes live is part of the architecture:
 */
export const OUTPUT_SINK = {
    /**
     * Everything retained in RAM until the final save. **This is what ships**:
     * `jsPDF.addImage` is handed a base64 data URL per page and the document
     * accumulates them all before `save()` serialises the lot.
     */
    MEMORY: 'memory',
    /**
     * Each visual encoded, written to browser-local storage, and released.
     * RAM holds one write chunk. The final artifact is assembled from the spool
     * and only becomes visible once every page has succeeded.
     */
    SPOOL: 'spool',
};

/**
 * The two paths, and what each one is ready for.
 *
 * The spool prototype establishes real properties — browser-local staging, no
 * external service, nothing published on a cancellation or a supersession,
 * cleanup on the measured paths — and it does **not** establish a comparison
 * PDF. The parts are concatenated into one file to prove the lifecycle; a
 * container has structure, and `jsPDF` as used today builds the whole document
 * in memory. Presenting the spool path as ready to build would be the Candidate
 * C mistake again: a plan claiming a thing it has no contract for.
 */
export const OUTPUT_PATHS = {
    [OUTPUT_SINK.MEMORY]: {
        implementationReady: true,
        ceiling: 'MAX_OUTPUT_BYTES, checked in preflight',
        establishes: [
            'the container that ships today',
            'an explicit output ceiling',
            'atomic publish, since nothing exists until save()',
        ],
        missing: [],
    },
    [OUTPUT_SINK.SPOOL]: {
        implementationReady: false,
        requires: 'output-writer-sub-spike',
        establishes: [
            'browser-local staging with no external service',
            'bounded chunked write and bounded chunked read',
            'no artifact after a cancellation',
            'no artifact after a supersession',
            'run-scoped namespaces and ownership-aware cleanup',
        ],
        missing: [
            'a real comparison PDF assembled from the spool',
            'a bounded streaming container writer',
            'storage-quota preflight against a real quota',
            'crash and tab-close orphan recovery',
            'reopen validation: page count, dimensions, orientation',
            'production integration',
        ],
    },
};

/**
 * The recommended M4 MVP sink.
 *
 * **Memory**, and deliberately the smaller feature. It is the path that can be
 * built now: an explicit ceiling, a fail-closed preflight, and a container that
 * already exists. The spool is the answer for large jobs and it needs an Output
 * Writer Sub-Spike first.
 */
export const M4_OUTPUT_SINK = OUTPUT_SINK.MEMORY;

/** The sink the large-job path would use, once the sub-spike is done. */
export const DEFERRED_OUTPUT_SINK = OUTPUT_SINK.SPOOL;

/** What a spooling writer may hold in RAM at once, writing *to* the spool. */
export const MAX_SPOOL_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * And reading back *from* it.
 *
 * A separate constant because it bounds a separate allocation, and because the
 * first version of the prototype bounded only the write side: it staged in
 * 4 MiB chunks and then assembled with `file.arrayBuffer()`, pulling a whole
 * 8.7 MB part into RAM at once. The measurement said "publish ≤ 4 MiB" because
 * it was measuring the wrong side of the same file.
 */
export const MAX_PUBLISH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * The ceiling on finished output, for a container that stays in RAM.
 *
 * **256 MiB — a recommendation requiring human approval.** It exists so that a
 * refusal can name the output rather than a total the user cannot decompose:
 * "this comparison would produce more finished output than one operation may
 * hold" is actionable in a way that "over the working-set budget" is not.
 *
 * What it means depends entirely on **H5**, which is the dependency to see
 * before choosing here. Under the owned encoder's exact 4.001 bytes per pixel
 * an A4 visual at 300 dpi is 34.8 MB, so 256 MiB is about **seven visuals** —
 * seven pages of a two-member comparison, or two pages of a four-member one.
 * Under a compressing encoder the same ceiling would hold hundreds, and the
 * bound would no longer be exact. The trade is the decision.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * The pair-result lifetime contract.
 *
 * ```
 *   compare pair -> paint visual -> encode -> append to the sink -> release
 * ```
 *
 * A visual's RGBA and its encoded bytes are both released before the next pair
 * is painted. Nothing accumulates a list of finished images, which is the
 * difference between an operation that is bounded and one that merely starts
 * that way.
 */
export const PAIR_RESULT_LIFETIME = [
    'compare pair',
    'paint visual',
    'encode',
    'append to sink',
    'release RGBA and encoded bytes',
];

/**
 * What a whole operation's output costs, and how much of it is in RAM.
 *
 * `pages` is the number of **source** pages requested — an export of pages 3–5
 * is three. `members` gives the pair count per page under the contract.
 */
export function estimateOutputState({
    pages, members, contract, width, height,
    sink = M4_OUTPUT_SINK,
    encodeAsDataUrl = false,
}) {
    const pairsPerPage = contract === MULTI_MEMBER.REFERENCE_PAIRS
        ? Math.max(1, members - 1)
        : 1;
    const perVisualBytes = pngStoredSize({ width, height });
    const visuals = safeProduct(pages, pairsPerPage);
    const totalEncodedBytes = visuals === null
        ? null : safeProduct(visuals, perVisualBytes);
    const base = {
        pages,
        members,
        contract,
        pairsPerPage,
        visuals,
        perVisualBytes,
        totalEncodedBytes,
        sink,
        lifetime: PAIR_RESULT_LIFETIME,
    };
    if (totalEncodedBytes === null) {
        return { ...base, retainedInRam: null, spooledBytes: 0, representable: false };
    }
    if (sink === OUTPUT_SINK.SPOOL) {
        return {
            ...base,
            representable: true,
            // The bytes are on disk. RAM holds one write chunk while staging
            // and one read chunk while assembling — never a whole part.
            retainedInRam: MAX_SPOOL_CHUNK_BYTES,
            publishReadChunk: MAX_PUBLISH_CHUNK_BYTES,
            retainedPerCompletedPage: 0,
            spooledBytes: totalEncodedBytes,
        };
    }
    // Everything resident: the encoded images the container is holding, plus
    // the container's own assembled copy. A data-URL handoff pays base64 on
    // top of that, at two bytes a character, which is what ships.
    const perVisualHeld = encodeAsDataUrl
        ? Math.ceil(perVisualBytes * 4 / 3) * 2
        : perVisualBytes;
    const held = perVisualHeld * visuals;
    return {
        ...base,
        representable: true,
        retainedInRam: held + totalEncodedBytes,
        // What one finished page costs to keep while the next one is compared.
        retainedPerCompletedPage: perVisualHeld * pairsPerPage,
        publishReadChunk: 0,
        spooledBytes: 0,
        encodeAsDataUrl,
    };
}

/**
 * The operation's peak: the larger of one page's working set and what the
 * publish step is holding while it finishes.
 *
 * Checked before the first canvas, like the others — every term is arithmetic
 * on the page size, the member count, the tolerance and the page count.
 */
export function estimateJobMemory({
    pages, members, contract, width, height,
    radiusPx = 0,
    sink = M4_OUTPUT_SINK,
    encodeAsDataUrl = false,
    exportStrategy = BUDGETED_EXPORT_STRATEGY,
}) {
    const perPage = estimatePhaseMemory({
        width, height, members, contract, radiusPx, exportStrategy,
    });
    const output = estimateOutputState({
        pages, members, contract, width, height, sink, encodeAsDataUrl,
    });
    if (!output.representable) {
        return {
            pages,
            perPagePeak: perPage.peakWorkingSet,
            perPagePeakPhase: perPage.peakPhase,
            output,
            duringLastPage: null,
            publishPhase: null,
            jobPeak: null,
            peakPhase: null,
            representable: false,
        };
    }
    // The output of every finished page is live *while* the next one is being
    // compared, so these are not alternatives to be maximised over — they
    // overlap. Taking max() of the page peak and the publish peak, as an
    // earlier version did, understates a memory-resident job by the whole of
    // its finished output.
    const duringLastPage = perPage.peakWorkingSet
        + output.retainedPerCompletedPage * Math.max(0, pages - 1);
    const publish = output.retainedInRam
        + (output.publishReadChunk ?? 0);
    const jobPeak = Math.max(duringLastPage, publish);
    return {
        pages,
        perPagePeak: perPage.peakWorkingSet,
        perPagePeakPhase: perPage.peakPhase,
        output,
        duringLastPage,
        publishPhase: publish,
        jobPeak,
        peakPhase: publish >= duringLastPage ? 'publish' : 'the last page',
        representable: true,
    };
}

export function checkJobMemory(job, {
    limit = MAX_COMPARISON_BYTES,
    outputLimit = MAX_OUTPUT_BYTES,
} = {}) {
    const estimate = estimateJobMemory(job);
    if (estimate.representable && estimate.output.sink === OUTPUT_SINK.MEMORY
        && estimate.output.totalEncodedBytes > outputLimit) {
        // Named as an output refusal rather than a total, because that is the
        // thing the user can do something about.
        return {
            ...estimate,
            limit,
            outputLimit,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_OUTPUT_BUDGET,
                reason: `${estimate.output.visuals} visual(s) totalling `
                    + `${(estimate.output.totalEncodedBytes / 1e6).toFixed(0)} MB of `
                    + `finished output, against a ceiling of `
                    + `${(outputLimit / 1e6).toFixed(0)} MB`,
            },
        };
    }
    if (!estimate.representable) {
        return {
            ...estimate,
            limit,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_MEMORY_BUDGET,
                reason: 'the output this job would produce is not representable',
            },
        };
    }
    const withinBudget = estimate.jobPeak <= limit;
    return {
        ...estimate,
        limit,
        withinBudget,
        refusal: withinBudget ? null : {
            status: PLAN.OVER_MEMORY_BUDGET,
            reason: `${(estimate.jobPeak / 1e6).toFixed(0)} MB at the `
                + `${estimate.peakPhase} phase across ${estimate.pages} page(s), `
                + `against a ceiling of ${(limit / 1e6).toFixed(0)} MB`,
        },
    };
}

/**
 * Storage is a third budget, and it is not RAM.
 *
 * A spooled 200-page four-member job is **20.9 GB of temporary bytes**. The
 * previous round reported that row as "within" because the *RAM* peak was
 * 4 MiB, which is true and is not the whole sentence: nothing had asked
 * whether 20.9 GB would fit anywhere. A budget that answers a question nobody
 * asked reads like a budget that answered this one.
 *
 * `totalEncodedBytes` is known before anything is rendered, so the check can be
 * a preflight like the others. What it can compare against is whatever the
 * browser will say — `navigator.storage.estimate()` is advisory, may be
 * quantised for privacy, and may be absent entirely. So there are three
 * outcomes and only one of them is "fits":
 */
export const STORAGE_VERDICT = {
    WITHIN: 'within',
    INSUFFICIENT: 'insufficient',
    /** No quota could be read. Not the same as room, and not the same as none. */
    UNKNOWN: 'unknown',
};

/**
 * How much of a reported quota one operation may claim.
 *
 * Half, because the quota is shared with everything else the origin has stored
 * and a comparison that fills it is a comparison that breaks the next one.
 */
export const STORAGE_HEADROOM = 0.5;

export function checkStorageCapacity({
    requiredBytes,
    quotaBytes = null,
    usageBytes = 0,
    headroom = STORAGE_HEADROOM,
}) {
    if (quotaBytes === null || !Number.isFinite(quotaBytes)) {
        return {
            requiredBytes,
            verdict: STORAGE_VERDICT.UNKNOWN,
            availableBytes: null,
            refusal: null,
            reported: `${(requiredBytes / 1e9).toFixed(1)} GB of temporary output `
                + 'required; the browser reported no storage estimate',
        };
    }
    const availableBytes = Math.max(0, (quotaBytes - usageBytes) * headroom);
    if (requiredBytes > availableBytes) {
        return {
            requiredBytes,
            availableBytes,
            quotaBytes,
            usageBytes,
            verdict: STORAGE_VERDICT.INSUFFICIENT,
            refusal: {
                status: PLAN.OVER_STORAGE_CAPACITY,
                reason: `${(requiredBytes / 1e9).toFixed(1)} GB of temporary output `
                    + `against ${(availableBytes / 1e9).toFixed(1)} GB this origin `
                    + 'may claim',
            },
        };
    }
    return {
        requiredBytes,
        availableBytes,
        quotaBytes,
        usageBytes,
        verdict: STORAGE_VERDICT.WITHIN,
        refusal: null,
    };
}

/**
 * Two tabs, two runs, one origin.
 *
 * The prototype's first spool used a fixed `m4-spool` and cleaned it at start.
 * That is fine for one run and wrong for two: the second tab deletes the
 * first's staged pages, and whichever publishes last publishes over the other.
 * Nothing about the atomic-publish contract survives that.
 *
 * So temporary space is **run-scoped**, and cleanup is **ownership-aware**: a
 * run removes its own namespace and nothing else. Abandoned namespaces are a
 * recovery problem, not a start-up problem — a later run may sweep them, but
 * only ones no live run claims.
 */
export function spoolNamespace({ runId, generation }) {
    return `m4-spool-${runId}-g${generation}`;
}

export function ownsNamespace(name, { runId }) {
    return name.startsWith(`m4-spool-${runId}-`);
}

/**
 * Which abandoned namespaces a recovery pass may remove.
 *
 * Never one a live run claims, however old it looks: a long comparison is
 * indistinguishable from an abandoned one by age alone.
 */
export function reclaimableNamespaces(names, { liveRunIds }) {
    const live = new Set(liveRunIds);
    return names.filter((name) => {
        const match = /^m4-spool-([^-]+)-g\d+$/.exec(name);
        return match !== null && !live.has(match[1]);
    });
}

/**
 * What a reference-pairs artifact contains, and in what order.
 *
 * One source page becomes *n − 1* pair results, and a person has to be able to
 * tell which is which without counting. Slot order, reference first, member
 * identity carried on every one — in the preview, in the comparison PDF and in
 * the change report alike, because they are three presentations of one result
 * and disagreeing about ordering would make them three answers again.
 */
export function pairResultShape({ page, members, labels }) {
    const results = [];
    for (let i = 1; i < members; i++) {
        results.push({
            page,
            index: i - 1,
            reference: labels[0],
            member: labels[i],
            // Deterministic and stated, not incidental to a loop.
            title: `p${page}: ${labels[0]} vs ${labels[i]}`,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// The spatial tolerance, as a product contract
// ---------------------------------------------------------------------------

/**
 * How far apart two marks may be and still be the same mark.
 *
 * Removing the ratio floor did not remove the way a comparison can be made to
 * say MATCH about a drawing that changed. It moved it here. Measured on the
 * dimension-string fixture, changed pixels for 1200 against 1300, at every
 * resolution the Comparator offers:
 *
 *              0    0.05  0.1   0.15  0.2   0.25  0.3   0.4   0.5  mm
 *      72 dpi   10   10    10    10     0     0     0     0     0
 *     150 dpi   51   51    14    14    14    14     0     0     0
 *     300 dpi  186   96    96    49    49    18     1     0     0
 *     450 dpi  401  248   166   113    73    73    38     0     0
 *
 * So this is not a rendering detail with a unit attached. It is a setting that
 * can turn a changed dimension into an unchanged one, and it needs a product
 * contract rather than a default someone picked.
 *
 * **72 dpi is the resolution that sets the ceiling**, and it would have been
 * missed by sweeping only the middle of the range: a millimetre is fewer pixels
 * there, so the same setting is a coarser search *and* the mark it is searching
 * for is smaller. The change survives to 0.15 mm at 72 dpi, 0.25 mm at 150 and
 * 0.3 mm at 300 and 450.
 *
 * **Default zero.** A comparison a user has not configured must report every
 * difference it can see. A non-zero tolerance is an explicit opt-in, and the
 * words offered with it must not say "ignores small shifts" — measured, it also
 * makes a changed digit match.
 *
 * Everything here is the research recommendation for **H6**, not a decision.
 */
export const SPATIAL_TOLERANCE_POLICY = {
    unit: 'mm',
    default: 0,
    minimum: 0,
    /**
     * 0.15 mm: the **minimum** safe bound across every supported resolution,
     * not the average and not the one the middle of the range would allow.
     * 72 dpi loses the changed digit at 0.2 mm, so a ceiling of 0.25 mm — which
     * the 150/300 dpi sweep alone would have justified — would have shipped a
     * setting that silently hides a revision at the resolution most likely to
     * be left on for a quick check.
     *
     * The alternative was a DPI-dependent ceiling. Rejected: it would mean the
     * same number in the same box meaning different things depending on a
     * separate setting, which is the defect this whole spike is about.
     */
    maximum: 0.15,
    step: 0.05,
    zeroAlwaysAvailable: true,
    requiresExplicitOptIn: true,
    /** The resolutions the shipped Comparator offers. The bound holds at all of them. */
    supportedDpi: [72, 150, 300, 450],
    meaningShownToTheUser:
        '同じ位置とみなす距離（mm）。0 は完全一致のみを一致とみなします。',
    /**
     * This must not say "ignores small shifts". Measured, a non-zero tolerance
     * also makes a changed digit, a swapped symbol and an altered shape match —
     * it is not a positional-noise filter, and describing it as one would let a
     * user turn it on expecting something it does not do.
     */
    disclosureWhenNonZero:
        '位置ずれだけでなく、寸法値・文字・記号・形状の変更も'
        + '「一致」と判定される場合があります。',
};

/** True when the comparison is running at the contract's default. */
export function isDefaultSpatialTolerance(millimetres) {
    return millimetres === SPATIAL_TOLERANCE_POLICY.default;
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
 * The algorithm the M4 planner is bound to.
 *
 * A work unit means a different amount of work under each algorithm — about
 * forty times as much under the scan as under the dilation, on the same job —
 * so a ceiling in units is meaningless until the algorithm is named. The
 * previous round left `estimateComparisonWork` defaulting to the *shipped*
 * scan while recommending the dilation, which meant every worked example and
 * the wall-clock reading of the ceiling described an algorithm the design was
 * not going to use.
 *
 * There is now **no default**. A job without an algorithm is refused rather
 * than costed against a guess, and M4 binds here.
 */
export const M4_PLANNER_ALGORITHM = COMPARISON_ALGORITHM.SEPARABLE_DILATION;

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
    algorithm,
    requested = {},
}) {
    const known = Object.values(COMPARISON_ALGORITHM).includes(algorithm);
    const groups = known ? comparisonGroups({ members, contract }) : null;
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
        algorithmSelected: known,
    };
    if (!known || groups === null || pixels === null || box === null) {
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
 * The **whole-job comparison-kernel** work ceiling.
 *
 * **12,000,000,000 comparison-work units — a recommendation requiring human
 * approval, not a measured threshold.** It is user-visible, because it refuses
 * comparisons.
 *
 * *Comparison-kernel* is doing real work in that name. What is measured is
 * `pairChangeMask` — the ink-mask comparison — on masks that have already been
 * produced. It does not include PDF.js rendering, the RGBA readback, ink-mask
 * extraction, the task-boundary yields, painting the pair visuals, PNG
 * encoding, container assembly or the final artifact. So this ceiling bounds
 * the comparison, not the wait, and the seconds below are kernel seconds.
 * Bounding total wall-clock would need an end-to-end calibration from render
 * through publish, which this research has not done — and mixing the two
 * meanings under one number is how a ceiling stops meaning anything.
 *
 * One ceiling, applied to the total, rather than one per page. A per-page
 * ceiling bounds nothing a user actually asks for: an export of a hundred pages
 * that each pass comfortably is a hundred times the work, and the "about 55
 * seconds" below would be about an hour and a half. Applied to the job, the
 * number means what it says — and a single page is bounded by it as a
 * consequence, since one page is a job of one.
 *
 * **Calibrated against `M4_PLANNER_ALGORITHM`, and only meaningful with it.** A
 * work unit is not a fixed amount of work: the same A1 at the same tolerance is
 * 23,694,575,520 units under the shipped scan and 557,519,424 under the
 * separable dilation, about forty-two times fewer. An earlier version of this
 * comment read the ceiling against the scan while the design recommended the
 * dilation, so every figure in it described an algorithm that was not going to
 * ship.
 *
 * Measured, under the dilation: the worst cost per unit over five sizes and
 * radii is 1.9e-6 ms — an A1 at 150 dpi, 139,393,888 units in 263 ms. Twelve
 * billion units at that rate is about **22 seconds of comparison-kernel time**
 * for the whole job. Not 23 seconds of waiting.
 *
 * What that is, in work a user can picture: **about 173 A4 pages at 300 dpi and
 * a 0.5 mm tolerance**, at 69,578,880 units each. Under this algorithm no
 * *single* sheet in the corpus reaches the ceiling — an A1 at 300 dpi is 5% of
 * it — so on one page the memory budget is what refuses first, and the work
 * ceiling exists for ranges.
 *
 * The number is a judgement about how much comparison one operation may claim,
 * and the machine it was calibrated on is one machine. **Human Gate H10**, and
 * the conversion is the point of stating it this way:
 * each additional A4 page at 300 dpi is 69,578,880 units, about 0.13 seconds.
 * If a drawing set that people actually compare runs past ~170 sheets, this
 * number should go up, and the Gate now has what it needs to say so.
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
                reason: estimate.algorithmSelected === false
                    ? 'no comparison algorithm was selected, so no work bound exists'
                    : (estimate.groups === 0
                        ? 'no work bound is derived for this contract'
                        : 'the work this comparison would do is not representable'),
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

/**
 * What the whole operation costs, not what one page costs.
 *
 * Memory is a **peak**: pages are rendered one after another, so a two-hundred
 * page export never holds more than one page's buffers and the page-level model
 * is the right one. Work is **cumulative**: two hundred pages that each pass the
 * ceiling comfortably are two hundred times the work, and a ceiling checked per
 * page would wave that through. The export and the change report both run over
 * ranges, so this is not a hypothetical.
 *
 * Pages that cannot be compared — a page one document does not have, a page
 * that failed to render, a page whose geometry was refused — are **kept in the
 * plan** with zero work and the reason recorded. Dropping them from the
 * estimate would make the job look cheaper for the same reason the shipped
 * comparator makes a missing page look like agreement: by not mentioning it.
 *
 * Only pages that were actually requested are costed. An export of pages 3-5
 * pays for three pages.
 */
export function estimateJobWork({
    pages,
    algorithm,
    limit = MAX_COMPARISON_WORK_UNITS,
}) {
    const costed = [];
    let jobWorkUnits = 0;
    let representable = true;

    for (const page of pages) {
        if (page.comparable === false) {
            costed.push({
                label: page.label,
                comparable: false,
                reason: page.reason ?? 'not comparable',
                units: 0,
            });
            continue;
        }
        const estimate = estimateComparisonWork({ ...page, algorithm });
        costed.push({
            label: page.label,
            comparable: true,
            reason: null,
            units: estimate.units,
            groups: estimate.groups,
            pixels: estimate.pixels,
            representable: estimate.representable,
            withinPageCeiling: estimate.representable && estimate.units <= limit,
        });
        if (!estimate.representable) { representable = false; continue; }
        jobWorkUnits = safeSum(jobWorkUnits, estimate.units);
        if (jobWorkUnits === null) { representable = false; jobWorkUnits = 0; }
    }

    const comparablePages = costed.filter((p) => p.comparable).length;
    const skippedPages = costed.filter((p) => !p.comparable);
    if (!representable) {
        return {
            pages: costed,
            comparablePages,
            skippedPages,
            jobWorkUnits: null,
            representable: false,
            limit,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_WORK_BUDGET,
                reason: Object.values(COMPARISON_ALGORITHM).includes(algorithm)
                ? 'the work this job would do is not representable'
                : 'no comparison algorithm was selected, so no work bound exists',
            },
        };
    }

    const withinBudget = jobWorkUnits <= limit;
    // Which page pushed it over, when no single page did.
    const overOnItsOwn = costed.find((p) => p.comparable && p.withinPageCeiling === false);
    return {
        pages: costed,
        comparablePages,
        skippedPages,
        jobWorkUnits,
        representable: true,
        limit,
        withinBudget,
        refusal: withinBudget ? null : {
            status: PLAN.OVER_WORK_BUDGET,
            reason: overOnItsOwn
                ? `${overOnItsOwn.label} alone is `
                    + `${overOnItsOwn.units.toLocaleString('en-US')} work units, over a `
                    + `ceiling of ${limit.toLocaleString('en-US')}`
                : `${comparablePages} pages total `
                    + `${jobWorkUnits.toLocaleString('en-US')} work units, over a `
                    + `ceiling of ${limit.toLocaleString('en-US')}; no single page is`,
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
