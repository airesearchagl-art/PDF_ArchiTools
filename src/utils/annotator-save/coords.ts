/**
 * The coordinate contract between the annotator's canvas and a PDF page.
 *
 * Four spaces are involved and conflating any two of them puts a mark in the
 * wrong place:
 *
 *   1. **pointer space** — CSS pixels relative to the canvas element. What a
 *      pointer event reports, and dependent on the zoom in force at the time.
 *   2. **display space** — the page as PDF.js draws it at scale 1: origin
 *      top-left, y downwards, `/Rotate` already applied. **This is what the
 *      annotator stores.**
 *   3. **upright page space** — origin top-left, y downwards, `/Rotate` undone.
 *   4. **PDF user space** — what a content stream operator sees: origin at the
 *      bottom-left of the page box, y upwards, and never rotated, because
 *      `/Rotate` is a viewer instruction rather than a transform on content.
 *
 * `PdfPage` sizes its canvas from `getViewport({ scale })` with no `rotation`
 * argument, so the viewport carries the page's own `/Rotate`. `DrawingCanvas`
 * then converts a pointer event by dividing by the zoom and nothing else.
 * Dividing by the zoom removes the zoom; nothing removes the rotation. So a
 * stored coordinate is zoom-independent and expressed in the rotated frame the
 * user was looking at.
 *
 * A save therefore has three steps and the middle one is not optional:
 *
 *     stored (display space)
 *        -> displayToUpright(/Rotate)   undo the rotation
 *        -> uprightToPdf(CropBox)       flip y, add the crop origin
 *        -> PDF user space
 *
 * The second is the one that gets forgotten, because a page at `/Rotate 0`
 * cannot tell you it is missing.
 */

export interface Point {
    x: number;
    y: number;
}

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PageGeometry {
    rotate: number;
    box: Box;
    uprightWidth: number;
    uprightHeight: number;
    displayWidth: number;
    displayHeight: number;
}

/** Normalise any rotation to 0, 90, 180 or 270. */
export function normaliseRotation(rotate: number): number {
    return (((Math.round(rotate / 90) * 90) % 360) + 360) % 360;
}

/**
 * Display space -> upright page space.
 *
 * `displayWidth`/`displayHeight` are the page's size *as displayed*, so for a
 * quarter-turned page they are the upright size transposed.
 */
export function displayToUpright(
    point: Point,
    rotate: number,
    displayWidth: number,
    displayHeight: number,
): Point {
    switch (normaliseRotation(rotate)) {
        case 90: return { x: point.y, y: displayWidth - point.x };
        case 180: return { x: displayWidth - point.x, y: displayHeight - point.y };
        case 270: return { x: displayHeight - point.y, y: point.x };
        default: return { x: point.x, y: point.y };
    }
}

/** Upright page space -> display space. The inverse of the above. */
export function uprightToDisplay(
    point: Point,
    rotate: number,
    uprightWidth: number,
    uprightHeight: number,
): Point {
    switch (normaliseRotation(rotate)) {
        case 90: return { x: uprightHeight - point.y, y: point.x };
        case 180: return { x: uprightWidth - point.x, y: uprightHeight - point.y };
        case 270: return { x: point.y, y: uprightWidth - point.x };
        default: return { x: point.x, y: point.y };
    }
}

/**
 * Upright page space -> PDF user space.
 *
 * Two things happen here and both are easy to forget.
 *
 * The y axis flips: upright space counts downwards from the top, a content
 * stream counts upwards from the bottom.
 *
 * The origin moves to the page box's own origin. A page whose CropBox starts at
 * (60, 90) shows its content offset by that much, so an annotation placed over
 * what the user can see has to be written at `cropOrigin + point`. Ignoring
 * this misplaces every mark on a cropped page, and on a page cropped from the
 * bottom-left it puts them into the hidden margin.
 */
export function uprightToPdf(point: Point, box: Box): Point {
    return {
        x: box.x + point.x,
        y: box.y + box.height - point.y,
    };
}

/**
 * A page's boxes, as the transform needs them.
 *
 * `displayWidth`/`displayHeight` follow the *crop* box, because that is what a
 * viewer shows, and they transpose on a quarter turn.
 */
export function pageGeometry(
    { mediaBox, cropBox, rotate }: { mediaBox: Box; cropBox?: Box | null; rotate: number },
): PageGeometry {
    const box = cropBox && cropBox.width > 0 && cropBox.height > 0 ? cropBox : mediaBox;
    const r = normaliseRotation(rotate);
    const quarter = r === 90 || r === 270;
    return {
        rotate: r,
        box,
        uprightWidth: box.width,
        uprightHeight: box.height,
        displayWidth: quarter ? box.height : box.width,
        displayHeight: quarter ? box.width : box.height,
    };
}
