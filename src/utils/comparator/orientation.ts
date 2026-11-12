/**
 * Which way up a compared page is shown.
 *
 * The comparison itself is made on the paper, upright (`rotation: 0`,
 * geometry.ts): two sheets that differ only in their `/Rotate` are the same
 * drawing, and the masks, the verdict, the change counts and the change box are
 * all worked out in that frame. What a person looks at is a separate question.
 * When every sheet taking part in a page's comparison carries the same
 * `/Rotate`, the drawing is shown the way those sheets are meant to be read --
 * turned as a PDF viewer turns them -- on the screen and in every artifact.
 * When their rotations differ, there is no one right way up, and the page is
 * shown on the paper, as before.
 *
 * Everything that is shown goes through the one transform here, so the
 * composite, the change box and its coordinates are always turned together:
 *  - `orientedPlacement` says where an upright pixel lands in the shown raster
 *    (the compositor paints straight into it, so no second raster is made);
 *  - `orientRect` turns a rectangle of upright pixels into the shown raster.
 *
 * Turns are clockwise, as `/Rotate` and PDF.js's viewport rotation are.
 */
import { normaliseRotation } from './geometry';

export type DisplayRotation = 0 | 90 | 180 | 270;

/**
 * The rotation a page is shown at: the `/Rotate` its sheets share, or 0 when
 * any of them differs from the others.
 */
export function displayRotationOf(rotates: readonly number[]): DisplayRotation {
    if (rotates.length === 0) return 0;
    const first = normaliseRotation(rotates[0]);
    return rotates.every((r) => normaliseRotation(r) === first) ? (first as DisplayRotation) : 0;
}

/** A quarter turn swaps width and height. */
export function orientedSize(width: number, height: number, rotate: DisplayRotation): { width: number; height: number } {
    return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Where the upright pixel (x, y) of a `width` x `height` raster lands in the
 * shown raster, as a pixel index: `start + x * stepX + y * stepY`. Linear in
 * both, so a row is painted with one addition per pixel.
 *
 *   0:   (x, y) -> (x, y)
 *   90:  (x, y) -> (height - 1 - y, x)
 *   180: (x, y) -> (width - 1 - x, height - 1 - y)
 *   270: (x, y) -> (y, width - 1 - x)
 */
export function orientedPlacement(width: number, height: number, rotate: DisplayRotation): {
    width: number;
    height: number;
    start: number;
    stepX: number;
    stepY: number;
} {
    switch (rotate) {
        case 90:
            return { width: height, height: width, start: height - 1, stepX: height, stepY: -1 };
        case 180:
            return { width, height, start: width * height - 1, stepX: -1, stepY: -width };
        case 270:
            return { width: height, height: width, start: (width - 1) * height, stepX: -height, stepY: 1 };
        default:
            return { width, height, start: 0, stepX: 1, stepY: width };
    }
}

/** A rectangle of upright pixels, as it lies in the shown raster. */
export function orientRect(
    rect: { x: number; y: number; width: number; height: number },
    width: number,
    height: number,
    rotate: DisplayRotation,
): { x: number; y: number; width: number; height: number } {
    switch (rotate) {
        case 90:
            return { x: height - (rect.y + rect.height), y: rect.x, width: rect.height, height: rect.width };
        case 180:
            return { x: width - (rect.x + rect.width), y: height - (rect.y + rect.height), width: rect.width, height: rect.height };
        case 270:
            return { x: rect.y, y: width - (rect.x + rect.width), width: rect.height, height: rect.width };
        default:
            return { ...rect };
    }
}
