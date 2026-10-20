/**
 * Where a person's drag on the viewer lands in a title-block profile, and
 * back (M7-P2-B2, W2). Pure arithmetic, nothing else.
 *
 * Three spaces:
 *  - screen: CSS pixels over the viewer's canvas, origin at its top-left. The
 *    canvas's CSS box is the page at `cssScale` CSS pixels per point -- the
 *    bitmap behind it may be smaller (the viewer bounds its pixels), which is
 *    why nothing here reads the bitmap's size.
 *  - display points: the page as the viewer shows it, turned by its /Rotate
 *    (`rotate`, clockwise), at scale 1.
 *  - upright points: the page without its /Rotate, origin top-left, y down --
 *    the space a profile's rectangles are recorded in (semantic contract §D)
 *    and the Drawing Register reads in. The display<->upright map is the
 *    Drawing Register's own (toUprightRect).
 *
 * A drag is clamped to the page; a rectangle is always ordered (left < right,
 * top < bottom) whichever way the pointer moved.
 */
import { toUprightRect } from '../pdf-textifier/table-geometry';
import type { Rect } from './model';

/** What the viewer tells the overlay about the page it drew. */
export interface ViewerGeometry {
    /** CSS pixels per point of the page as displayed. */
    cssScale: number;
    /** The page as displayed (turned), in points. */
    displayWidthPt: number;
    displayHeightPt: number;
    /** The page's /Rotate, clockwise: 0, 90, 180 or 270. */
    rotate: number;
}

const quarter = (rotate: number): boolean => (((rotate % 360) + 360) % 180) === 90;

/** The page's upright size, from how it is displayed. */
export function uprightSize(geometry: ViewerGeometry): { width: number; height: number } {
    return quarter(geometry.rotate)
        ? { width: geometry.displayHeightPt, height: geometry.displayWidthPt }
        : { width: geometry.displayWidthPt, height: geometry.displayHeightPt };
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));

/** A drag between two screen points as an upright rectangle, on the page. */
export function dragToUpright(
    from: { x: number; y: number }, to: { x: number; y: number }, geometry: ViewerGeometry,
): Rect {
    const s = geometry.cssScale;
    const display: Rect = {
        left: clamp(Math.min(from.x, to.x) / s, geometry.displayWidthPt),
        right: clamp(Math.max(from.x, to.x) / s, geometry.displayWidthPt),
        top: clamp(Math.min(from.y, to.y) / s, geometry.displayHeightPt),
        bottom: clamp(Math.max(from.y, to.y) / s, geometry.displayHeightPt),
    };
    return toUprightRect(display, geometry.rotate, geometry.displayWidthPt, geometry.displayHeightPt);
}

/** An upright rectangle as it lies on the displayed page, in display points (the inverse of toUprightRect). */
export function uprightToDisplay(rect: Rect, geometry: ViewerGeometry): Rect {
    const { width: W, height: H } = uprightSize(geometry);
    switch (((geometry.rotate % 360) + 360) % 360) {
        case 90: return { left: H - rect.bottom, right: H - rect.top, top: rect.left, bottom: rect.right };
        case 180: return { left: W - rect.right, right: W - rect.left, top: H - rect.bottom, bottom: H - rect.top };
        case 270: return { left: rect.top, right: rect.bottom, top: W - rect.right, bottom: W - rect.left };
        default: return { ...rect };
    }
}

/** An upright rectangle as a CSS box over the viewer's canvas. */
export function uprightToScreen(rect: Rect, geometry: ViewerGeometry): { left: number; top: number; width: number; height: number } {
    const d = uprightToDisplay(rect, geometry);
    const s = geometry.cssScale;
    return { left: d.left * s, top: d.top * s, width: (d.right - d.left) * s, height: (d.bottom - d.top) * s };
}

/** Round a recorded coordinate to 0.01 pt, the contract's own tolerance, so a value typed back reads the same. */
export const roundPoints = (rect: Rect): Rect => ({
    left: Math.round(rect.left * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    right: Math.round(rect.right * 100) / 100,
    bottom: Math.round(rect.bottom * 100) / 100,
});
