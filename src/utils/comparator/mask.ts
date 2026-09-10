/**
 * What a change is, computed from ink rather than from the picture.
 *
 * The old comparator decided what had changed by looking at the composite it
 * had just painted, which made the verdict a property of the palette: give both
 * layers the same grey and a genuinely changed pair counts zero. Here the
 * verdict comes from ink masks, and only then is anything painted.
 *
 * Adopted from `research/m4-comparator-reliability/prototype/candidates.mjs`.
 */

/**
 * The canonical ink predicate: **any channel**.
 *
 * Two functions used to decide this and they disagreed — one took the mean of
 * the channels, the other took any channel — so a colour between them was
 * painted as a change and then left out of the reported change area. One
 * definition now serves the mask, the verdict, the composite, the change bounds
 * and the report.
 */
export const INK_THRESHOLD = 200;

export function isInk(buffer: Uint8ClampedArray, index: number): boolean {
    return buffer[index] < INK_THRESHOLD
        || buffer[index + 1] < INK_THRESHOLD
        || buffer[index + 2] < INK_THRESHOLD;
}

/** One member's ink, as a flat 0/1 mask. The only thing a verdict may read. */
export function inkMask(
    buffer: Uint8ClampedArray,
    width: number,
    height: number,
): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < mask.length; p += 1) mask[p] = isInk(buffer, p * 4) ? 1 : 0;
    return mask;
}

/**
 * The spatial tolerance, applied to the mask rather than to a ratio.
 *
 * "Matched if the other member has ink within `radius`" over a square box is a
 * dilation, and a dilation over a square is separable: any-in-the-box is
 * any-in-the-row-span followed by any-in-the-column-span. Two passes over the
 * pixels regardless of how wide the box is, where the old nested loop was
 * `(2r+1)²` reads per ink pixel — and, more importantly, a cost that is a
 * property of the sheet rather than of the drawing, which is what a ceiling
 * checked before rendering needs.
 *
 * Exact, not approximate: this produces the same mask the nested loop does.
 */
export function dilateMask(
    mask: Uint8Array,
    width: number,
    height: number,
    radius: number,
): Uint8Array {
    if (radius <= 0) return mask;
    const horizontal = new Uint8Array(width * height);
    const rowSum = new Int32Array(width + 1);
    for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) rowSum[x + 1] = rowSum[x] + mask[row + x];
        for (let x = 0; x < width; x += 1) {
            const x0 = Math.max(0, x - radius);
            const x1 = Math.min(width - 1, x + radius);
            horizontal[row + x] = rowSum[x1 + 1] - rowSum[x0] > 0 ? 1 : 0;
        }
    }
    const out = new Uint8Array(width * height);
    const colSum = new Int32Array(height + 1);
    for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
            colSum[y + 1] = colSum[y] + horizontal[y * width + x];
        }
        for (let y = 0; y < height; y += 1) {
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(height - 1, y + radius);
            out[y * width + x] = colSum[y1 + 1] - colSum[y0] > 0 ? 1 : 0;
        }
    }
    return out;
}

export interface ChangeMask {
    changePixels: number;
    inkPixels: number;
    changed: boolean;
}

/**
 * The canonical semantic change mask for one pair.
 *
 * A pixel is a change when one member has ink there and the other has no ink
 * anywhere within the physical tolerance. That is the whole definition.
 */
export function pairChangeMask(
    a: Uint8Array,
    b: Uint8Array,
    dilatedA: Uint8Array,
    dilatedB: Uint8Array,
): ChangeMask {
    let changePixels = 0;
    let inkPixels = 0;
    for (let p = 0; p < a.length; p += 1) {
        const inkA = a[p];
        const inkB = b[p];
        if (inkA || inkB) inkPixels += 1;
        if ((inkA && !dilatedB[p]) || (inkB && !dilatedA[p])) changePixels += 1;
    }
    return { changePixels, inkPixels, changed: changePixels > 0 };
}

/**
 * The same comparison, in bounded bands, so it can be abandoned.
 *
 * A synchronous loop over an A1 cannot observe a cancellation: by the time it
 * returns, the answer it was asked to stop producing is already produced. Every
 * phase here is a band of rows or columns and control returns to the caller
 * between bands — which is only half of it. The other half is the caller, which
 * has to yield to a task boundary so that whatever the user did can actually
 * arrive. See `runBanded`.
 */
export function* pairChangeMaskSteps(
    a: Uint8Array,
    b: Uint8Array,
    width: number,
    height: number,
    radius: number,
    band = 256,
): Generator<{ phase: string; done: number; total: number }, ChangeMask, void> {
    function* dilateInBands(
        mask: Uint8Array,
        label: string,
    ): Generator<{ phase: string; done: number; total: number }, Uint8Array, void> {
        if (radius <= 0) return mask;
        const horizontal = new Uint8Array(width * height);
        const rowSum = new Int32Array(width + 1);
        for (let yStart = 0; yStart < height; yStart += band) {
            const yEnd = Math.min(height, yStart + band);
            for (let y = yStart; y < yEnd; y += 1) {
                const row = y * width;
                for (let x = 0; x < width; x += 1) rowSum[x + 1] = rowSum[x] + mask[row + x];
                for (let x = 0; x < width; x += 1) {
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
            for (let x = xStart; x < xEnd; x += 1) {
                for (let y = 0; y < height; y += 1) {
                    colSum[y + 1] = colSum[y] + horizontal[y * width + x];
                }
                for (let y = 0; y < height; y += 1) {
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
        for (let p = yStart * width; p < yEnd * width; p += 1) {
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
 * A real task boundary.
 *
 * `setTimeout(…, 0)` rather than a microtask, deliberately: a microtask drains
 * before the task queue is touched, so awaiting one proves nothing — nothing
 * the user did can have been delivered yet. Timers are one task source served
 * in order, so a cancellation raised before this yield has certainly run by the
 * time it resolves.
 */
export function taskBoundary(): Promise<void> {
    return new Promise((resolve) => { window.setTimeout(resolve, 0); });
}

export interface BandedRun<T> {
    cancelled: boolean;
    reason: 'completed' | 'cancelled' | 'superseded';
    bands: number;
    result: T | null;
}

/**
 * Drive a banded computation so that a cancellation can actually arrive.
 *
 * Between every pair of bands: yield to a task boundary, then read the
 * cancellation flag and the ownership token that the queued work may just have
 * changed. A cancelled run returns nothing — half a change mask is not a
 * smaller change, it is a different drawing.
 */
export async function runBanded<T>(
    steps: Generator<unknown, T, void>,
    options: {
        shouldContinue?: () => boolean;
        isOwner?: () => boolean;
        yieldToTask?: () => Promise<void>;
    } = {},
): Promise<BandedRun<T>> {
    const shouldContinue = options.shouldContinue ?? (() => true);
    const isOwner = options.isOwner ?? (() => true);
    const yieldToTask = options.yieldToTask ?? taskBoundary;
    let bands = 0;
    let step = steps.next();
    while (!step.done) {
        bands += 1;
        await yieldToTask();
        if (!shouldContinue()) {
            steps.return(undefined as never);
            return { cancelled: true, reason: 'cancelled', bands, result: null };
        }
        if (!isOwner()) {
            steps.return(undefined as never);
            return { cancelled: true, reason: 'superseded', bands, result: null };
        }
        step = steps.next();
    }
    // Re-checked immediately before the result is handed back, not only during:
    // a run can be superseded by the last thing that happened while its final
    // band was running.
    if (!isOwner()) {
        return { cancelled: true, reason: 'superseded', bands, result: null };
    }
    return { cancelled: false, reason: 'completed', bands, result: step.value };
}
