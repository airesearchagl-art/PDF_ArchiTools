/**
 * The shapes a save works with, and the ways it is allowed to fail.
 *
 * The annotation types mirror `DrawingCanvas.tsx` rather than defining a new
 * model: a save path that writes a model the app does not have is worthless.
 * Where the app's model is thinner than one might expect, this is thin in the
 * same way — a measurement carries no label text, no line width and no fill,
 * because the renderer computes all three at draw time, so the writer has to
 * compute them the same way or lose them.
 */

/** A point in stored (display) space. `pressure` is present only on ink. */
export interface SavePoint {
    x: number;
    y: number;
    pressure?: number;
}

export interface StrokeAnnotation {
    id: string;
    type: 'stroke';
    points: SavePoint[];
    color: string;
    lineWidth: number;
    opacity: number;
    enablePressure?: boolean;
    /** The pixel eraser. The only eraser that survives as a stored object. */
    isEraser?: boolean;
}

export interface TextAnnotation {
    id: string;
    type: 'text';
    x: number;
    y: number;
    text: string;
    fontSize: number;
    /** A CSS family name. It cannot be resolved to a file, so it cannot be embedded. */
    fontFamily: string;
    color: string;
    opacity: number;
}

export interface MeasureAnnotation {
    id: string;
    type: 'measure';
    subtype: 'line' | 'poly' | 'area';
    points: SavePoint[];
    color: string;
    scale: { value: number; unit: string };
    opacity: number;
}

export type SaveAnnotation = StrokeAnnotation | TextAnnotation | MeasureAnnotation;

/**
 * One visible layer's objects, in the order the canvas paints them.
 *
 * Layers are separate canvases in the app, and a pixel eraser's
 * `destination-out` only reaches its own canvas. So layers stay separate all
 * the way to the writer: flattening them into one list would silently give an
 * upper layer's eraser the power to cut holes in the layers beneath it.
 */
export interface LayerSnapshot {
    layerId: string;
    objects: SaveAnnotation[];
}

/** Everything on one page, bottom layer first. */
export interface PageSnapshot {
    pageNumber: number;
    layers: LayerSnapshot[];
}

// ---------------------------------------------------------------------------
// Failing
// ---------------------------------------------------------------------------

/**
 * Why a save refused.
 *
 * Typed rather than a string, because the UI has to say something different for
 * each of these and matching on a message is how that rots.
 */
export type SaveErrorCode =
    | 'signed'
    | 'encrypted'
    | 'unreadable'
    | 'form-unreadable'
    | 'pending-annotation'
    | 'raster-budget'
    | 'invalid-annotation'
    | 'font-unavailable';

export interface SaveProblem {
    code: SaveErrorCode;
    message: string;
    /** Never shown to the user; useful in the console. */
    detail?: string;
    page?: number;
    layerId?: string;
    objectId?: string;
}

/**
 * A refusal.
 *
 * Carries every problem, not just the first, so the UI can show all of them at
 * once instead of one per attempt.
 */
export class AnnotatorSaveError extends Error {
    readonly code: SaveErrorCode;

    readonly problems: SaveProblem[];

    constructor(problems: SaveProblem[]) {
        super(problems[0]?.message ?? '保存できませんでした。');
        this.name = 'AnnotatorSaveError';
        this.code = problems[0]?.code ?? 'invalid-annotation';
        this.problems = problems;
    }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** A text object that had to be drawn as pixels, and why. */
export interface RasteredTextReport {
    page: number;
    layerId: string;
    objectId: string;
    missing: string[];
}

/**
 * What a save produced, and what it cost.
 *
 * The costs are not diagnostics: font substitution and a rastered text object
 * both change what the user gets, so both have to reach the UI rather than the
 * console.
 */
export interface SaveResult {
    bytes: Uint8Array;
    /** True whenever any vector text was written, since the family is never the user's. */
    fontSubstituted: boolean;
    rasteredTextObjects: RasteredTextReport[];
    rasterFragments: number;
    maxRasterPixels: number;
    visibleLayerCount: number;
    annotationCount: number;
    /** No annotations: the source bytes are returned unchanged rather than re-serialised. */
    unchangedCopy: boolean;
    ms: number;
}
