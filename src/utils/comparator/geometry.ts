/**
 * What "the same page" means when two PDFs are compared.
 *
 * A page can differ from another page in ways that are not changes to the
 * drawing at all — a different sheet size, a quarter turn in the page
 * dictionary, a crop box starting somewhere other than the origin. A comparison
 * that ignores those reports them as design changes, and the user cannot tell
 * them apart from the real thing.
 *
 * Adopted from `research/m4-comparator-reliability/prototype/geometry.mjs`.
 */
import { GEOMETRY_TOLERANCE_PT } from './contract';

export interface PageGeometry {
    rotate: number;
    origin: { x: number; y: number };
    displayWidth: number;
    displayHeight: number;
    /** The visible box with `/Rotate` ignored: a property of the paper. */
    physical: { width: number; height: number };
}

export interface GeometryDifference {
    kind: 'rotation' | 'sheet-size' | 'orientation' | 'crop-origin';
    detail: string;
    recoverable: 'automatic' | 'human';
    sameAspect?: boolean;
}

export interface GeometryComparison {
    identical: boolean;
    differences: GeometryDifference[];
    /** True when nothing is left that a renderer cannot settle by itself. */
    automaticOnly: boolean;
}

/** The mapping a comparison may actually use: the identity, or nothing. */
export interface CanonicalMapping {
    /** Always upright. This is the whole of the rotation fix. */
    renderRotation: 0;
    sourceRotate: { reference: number; other: number };
    scaleX: 1;
    scaleY: 1;
    /** Zero by construction, not by measurement. */
    scaleDelta: 0;
    residualWidthPt: number;
    residualHeightPt: number;
    rigid: boolean;
    tolerancePt: number;
}

/** Normalise any rotation to 0, 90, 180 or 270. */
export function normaliseRotation(rotate: number): number {
    return (((Math.round(rotate / 90) * 90) % 360) + 360) % 360;
}

/**
 * The page as a viewer shows it, and as the paper actually is.
 *
 * `view` is what PDF.js reports as the visible box — the CropBox where there is
 * one, the MediaBox otherwise — in PDF points.
 */
export function pageGeometry(view: readonly number[], rotate: number): PageGeometry {
    const [x0, y0, x1, y1] = view;
    const boxWidth = Math.abs(x1 - x0);
    const boxHeight = Math.abs(y1 - y0);
    const r = normaliseRotation(rotate);
    const quarter = r === 90 || r === 270;
    return {
        rotate: r,
        origin: { x: Math.min(x0, x1), y: Math.min(y0, y1) },
        displayWidth: quarter ? boxHeight : boxWidth,
        displayHeight: quarter ? boxWidth : boxHeight,
        physical: { width: boxWidth, height: boxHeight },
    };
}

/**
 * The canonical upright frame a comparison is made in.
 *
 * The renderer is asked for `getViewport({ scale, rotation: 0 })`, which
 * removes the whole of the rotation difference. Everything downstream is
 * expressed against this rather than against the display plane, because the
 * display plane still carries `/Rotate` and anything derived from it inherits
 * the quarter turn.
 */
export function uprightGeometry(geometry: PageGeometry): {
    width: number;
    height: number;
    sourceRotate: number;
    renderRotation: 0;
} {
    return {
        width: geometry.physical.width,
        height: geometry.physical.height,
        sourceRotate: geometry.rotate,
        renderRotation: 0,
    };
}

/**
 * How two pages differ, before anything is rendered.
 *
 * A list of named differences rather than a boolean, because the right response
 * is not the same for all of them: a quarter turn is recoverable by rendering
 * upright, a different sheet size is not recoverable without deciding what "the
 * same place" means.
 */
export function compareGeometry(
    a: PageGeometry,
    b: PageGeometry,
    tolerancePt: number = GEOMETRY_TOLERANCE_PT,
): GeometryComparison {
    const close = (p: number, q: number) => Math.abs(p - q) <= tolerancePt;
    const differences: GeometryDifference[] = [];

    if (a.rotate !== b.rotate) {
        differences.push({
            kind: 'rotation',
            detail: `/Rotate ${a.rotate} vs ${b.rotate}`,
            // Undoing a page rotation is arithmetic, not interpretation.
            recoverable: 'automatic',
        });
    }

    const displaySame = close(a.displayWidth, b.displayWidth)
        && close(a.displayHeight, b.displayHeight);
    const physicalSame = close(a.physical.width, b.physical.width)
        && close(a.physical.height, b.physical.height);

    if (!physicalSame) {
        const ratio = (a.physical.width / a.physical.height)
            / (b.physical.width / b.physical.height);
        differences.push({
            kind: 'sheet-size',
            detail: `${a.physical.width.toFixed(1)}x${a.physical.height.toFixed(1)}pt `
                + `vs ${b.physical.width.toFixed(1)}x${b.physical.height.toFixed(1)}pt`,
            // Same proportions do not make it the same sheet. A drawing reissued
            // from A1 to A3 is at a different scale, and matching the extents
            // would compare a 1:50 plan against a 1:100 one.
            sameAspect: Math.abs(ratio - 1) < 0.01,
            recoverable: 'human',
        });
    } else if (!displaySame) {
        differences.push({
            kind: 'orientation',
            detail: `${a.displayWidth.toFixed(1)}x${a.displayHeight.toFixed(1)} `
                + `vs ${b.displayWidth.toFixed(1)}x${b.displayHeight.toFixed(1)}`,
            recoverable: 'automatic',
        });
    }

    if (!close(a.origin.x, b.origin.x) || !close(a.origin.y, b.origin.y)) {
        differences.push({
            kind: 'crop-origin',
            detail: `(${a.origin.x.toFixed(0)}, ${a.origin.y.toFixed(0)}) vs `
                + `(${b.origin.x.toFixed(0)}, ${b.origin.y.toFixed(0)})`,
            // PDF.js renders from each page's own visible box, so a crop origin
            // over the same-sized region is already removed by rendering.
            recoverable: physicalSame ? 'automatic' : 'human',
        });
    }

    return {
        identical: differences.length === 0,
        differences,
        automaticOnly: differences.every((d) => d.recoverable === 'automatic'),
    };
}

/**
 * The mapping, taken in canonical upright space.
 *
 * There are two cases and no third. Either the visible boxes are the same sheet
 * within `tolerancePt`, and the mapping is the **identity** — upright, from each
 * page's own origin, scale 1 — or they are not the same sheet and there is no
 * mapping at all.
 *
 * A scale computed from the pages' *display* dimensions looks reasonable until
 * the pair differs by a quarter turn: an A4 at `/Rotate 0` against the same A4
 * at `/Rotate 90` gives x = 0.707, y = 1.414. That is an anisotropic stretch
 * across two pages that are the same piece of paper, and this function exists so
 * that it cannot be computed.
 */
export function canonicalMapping(
    reference: PageGeometry,
    other: PageGeometry,
    tolerancePt: number = GEOMETRY_TOLERANCE_PT,
): CanonicalMapping {
    const a = uprightGeometry(reference);
    const b = uprightGeometry(other);
    const residualWidthPt = Math.abs(a.width - b.width);
    const residualHeightPt = Math.abs(a.height - b.height);
    return {
        renderRotation: 0,
        sourceRotate: { reference: a.sourceRotate, other: b.sourceRotate },
        scaleX: 1,
        scaleY: 1,
        scaleDelta: 0,
        residualWidthPt,
        residualHeightPt,
        rigid: residualWidthPt <= tolerancePt && residualHeightPt <= tolerancePt,
        tolerancePt,
    };
}

/**
 * The invariant, as a check rather than a sentence.
 *
 * `READY_TO_COMPARE` means every member is mapped by a rigid transform.
 * Anything else is a plan that has promised a comparison it cannot make
 * honestly.
 */
export function mappingsAreRigid(mappings: readonly CanonicalMapping[]): boolean {
    return mappings.every(
        (m) => m.rigid && m.scaleX === 1 && m.scaleY === 1
            && m.scaleDelta === 0 && m.renderRotation === 0,
    );
}
