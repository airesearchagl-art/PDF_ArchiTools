/**
 * How one layer's objects are split between operators and pixels, and how large
 * a raster fragment is allowed to be.
 */
import type { SaveAnnotation } from './types';
import { AnnotatorSaveError } from './types';
import type { Bounds } from './bounds';
import { paintedBounds, boundsOverlap } from './bounds';

// ---------------------------------------------------------------------------
// How large a raster fragment may be
// ---------------------------------------------------------------------------

/**
 * The ceiling on one raster fragment, in pixels. **Inclusive.**
 *
 * Measured rather than borrowed: a fragment costs roughly four bytes of live
 * canvas per pixel and its PNG encode dominates the runtime, so the cost is
 * smooth right up to the point where allocating the canvas is itself the
 * problem. 8 Mpx is 32 MB of RGBA, about a third of a second to encode, and a
 * quarter of what a whole A0 page at 2x would take.
 *
 * It bounds the *fragment*, never the page: a layer needing more than this is
 * refused, and the source page is not rasterised as a consolation — that would
 * destroy exactly what this design exists to preserve. Scaling the fragment
 * down is equally not an option: it would quietly blur the user's marks with no
 * way for them to know.
 */
export const MAX_RASTER_PIXELS = 8_000_000;

export interface RasterBudget {
    width: number;
    height: number;
    pixels: number;
}

/**
 * Decide whether a fragment may be drawn, **before any canvas exists**.
 *
 * Ordering is the whole point of separating this out. Checking after allocation
 * means the allocation has already happened, which on a pathological layer is
 * the failure being guarded against.
 */
export function checkRasterBudget(
    bounds: { width: number; height: number },
    scale: number,
    { page, layerId, limit = MAX_RASTER_PIXELS }:
    { page: number; layerId?: string; limit?: number },
): RasterBudget {
    const width = Math.max(1, Math.ceil(bounds.width * scale));
    const height = Math.max(1, Math.ceil(bounds.height * scale));
    const pixels = width * height;
    if (pixels > limit) {
        throw new AnnotatorSaveError([{
            code: 'raster-budget',
            page,
            layerId,
            message: `ページ ${page} の注釈を画像化するには `
                + `${(pixels / 1e6).toFixed(1)} メガピクセル（${width}×${height}）が必要で、`
                + `上限の ${(limit / 1e6).toFixed(1)} メガピクセルを超えます。`
                + '消しゴムを使った範囲を狭くするか、注釈を分けて保存してください。',
            detail: `${width}x${height}=${pixels} > ${limit}`,
        }]);
    }
    return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Composition planning
// ---------------------------------------------------------------------------

export interface CompositionRun {
    kind: 'vector' | 'raster';
    objects: SaveAnnotation[];
}

export interface CompositionPlan {
    runs: CompositionRun[];
    wholeLayerRastered: boolean;
}

/**
 * Split one layer into an **ordered sequence of runs**.
 *
 * Not a vector bucket and a raster bucket. Buckets invert stacking: with
 * `stroke A -> pixel eraser -> stroke B`, sorting into buckets writes A and B
 * together and the eraser somewhere else, so B ends up under a fragment it was
 * drawn over. That was a real bug, not a hypothetical.
 *
 * Runs come out in painter order and are emitted in that order, so stacking
 * survives by construction — pdf-lib appends in call order.
 *
 * A pixel eraser drags everything it overlaps, from the earliest such object
 * through to itself, into one contiguous raster run: a content stream cannot
 * un-draw, so the subtraction has to happen in pixels, and it can only happen
 * against the marks it was subtracting from.
 *
 * Objects the caller cannot express for its own reasons — a glyph the embedded
 * font lacks — are rastered too, but need no closure: nothing depends on what
 * was drawn before a text object.
 *
 * Over-including costs pixels. Under-including reorders the user's marks. So
 * this rounds towards including.
 */
export function planComposition(
    objects: readonly SaveAnnotation[],
    { mustRaster = () => false }: { mustRaster?: (obj: SaveAnnotation) => boolean } = {},
): CompositionPlan {
    const bounds: (Bounds | null)[] = objects.map(paintedBounds);
    const required = new Set<number>();

    objects.forEach((obj, e) => {
        if (!(obj.type === 'stroke' && obj.isEraser)) return;
        let start = e;
        for (let i = 0; i < e; i++) {
            if (boundsOverlap(bounds[i], bounds[e])) { start = i; break; }
        }
        for (let i = start; i <= e; i++) required.add(i);
    });

    objects.forEach((obj, i) => {
        if (mustRaster(obj)) required.add(i);
    });

    if (required.size === 0) {
        return {
            runs: objects.length
                ? [{ kind: 'vector', objects: [...objects] }]
                : [],
            wholeLayerRastered: false,
        };
    }

    const runs: CompositionRun[] = [];
    let from = 0;
    let kind: 'vector' | 'raster' | null = required.has(0) ? 'raster' : 'vector';
    for (let i = 1; i <= objects.length; i++) {
        const next = i < objects.length
            ? (required.has(i) ? 'raster' : 'vector')
            : null;
        if (next !== kind) {
            runs.push({ kind: kind as 'vector' | 'raster', objects: objects.slice(from, i) });
            from = i;
            kind = next;
        }
    }

    return { runs, wholeLayerRastered: required.size === objects.length };
}

/** The area a run of objects paints, with a margin. */
export function runBounds(
    objects: readonly SaveAnnotation[], pad: number,
): { x: number; y: number; width: number; height: number } | null {
    const boxes = objects.map(paintedBounds).filter((b): b is Bounds => b !== null);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.minX)) - pad;
    const minY = Math.min(...boxes.map((b) => b.minY)) - pad;
    const maxX = Math.max(...boxes.map((b) => b.maxX)) + pad;
    const maxY = Math.max(...boxes.map((b) => b.maxY)) + pad;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
