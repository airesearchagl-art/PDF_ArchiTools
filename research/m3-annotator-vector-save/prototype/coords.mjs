/**
 * The coordinate contract between the annotator's canvas and a PDF page.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * Four spaces are involved and conflating any two of them produces a mark in
 * the wrong place:
 *
 *   1. **pointer space** -- CSS pixels relative to the canvas element. What a
 *      pointer event reports. Depends on the zoom the user happens to be at.
 *   2. **display space** -- the page as PDF.js draws it at scale 1: origin
 *      top-left, y downwards, `/Rotate` already applied. This is what the user
 *      sees, unrotated only in the sense that it is the right way up.
 *   3. **upright page space** -- origin top-left, y downwards, `/Rotate`
 *      undone. The same space M2-4 and M2-5 settled on, and the only one in
 *      which a rectangle means the same thing on every page of a document.
 *   4. **PDF user space** -- what a content stream operator sees: origin at the
 *      bottom-left of the page box, y upwards, and *never rotated*, because
 *      `/Rotate` is a viewer instruction rather than a transform on the
 *      content.
 *
 * The rule that makes zoom irrelevant is that nothing is ever stored in space
 * 1. A pointer event is converted to space 3 the moment it arrives, using the
 * scale in force at that moment, and the stored annotation is in page points
 * from then on. Save reads space 3 and writes space 4. Two users at 50% and
 * 600% produce identical stored coordinates and identical output.
 */

/** Normalise any rotation to 0, 90, 180 or 270. */
export function normaliseRotation(rotate) {
    const r = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
    return r;
}

/**
 * Pointer CSS pixels -> display space.
 *
 * `scale` is CSS pixels per PDF point, i.e. the zoom. `devicePixelRatio` does
 * not appear: it affects the canvas *backing store*, not the CSS box a pointer
 * event is measured against, and folding it in here is a common way to get
 * annotations that drift on a high-DPI screen.
 */
export function pointerToDisplay(point, scale) {
    return { x: point.x / scale, y: point.y / scale };
}

/**
 * Display space -> upright page space.
 *
 * `displayWidth`/`displayHeight` are the page's size *as displayed*, so for a
 * quarter-turned page they are the upright size transposed.
 */
export function displayToUpright(point, rotate, displayWidth, displayHeight) {
    const r = normaliseRotation(rotate);
    switch (r) {
        case 90: return { x: point.y, y: displayWidth - point.x };
        case 180: return { x: displayWidth - point.x, y: displayHeight - point.y };
        case 270: return { x: displayHeight - point.y, y: point.x };
        default: return { x: point.x, y: point.y };
    }
}

/** Upright page space -> display space. The inverse of the above. */
export function uprightToDisplay(point, rotate, uprightWidth, uprightHeight) {
    const r = normaliseRotation(rotate);
    switch (r) {
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
 * what the user can see has to be written at `cropOrigin + point`. A save path
 * that ignores this puts every mark on a cropped page in the wrong place, and
 * on a page cropped from the bottom-left it puts them into the hidden margin.
 *
 * `box` is `{ x, y, width, height }` of the box the viewer is showing -- the
 * CropBox where there is one, the MediaBox otherwise.
 */
export function uprightToPdf(point, box) {
    return {
        x: box.x + point.x,
        y: box.y + box.height - point.y,
    };
}

/** PDF user space -> upright page space. */
export function pdfToUpright(point, box) {
    return {
        x: point.x - box.x,
        y: box.y + box.height - point.y,
    };
}

/**
 * The whole chain, for one point.
 *
 * Kept as a single function so the probe can assert the round trip rather than
 * assembling the steps itself and asserting its own assembly.
 */
export function pointerToPdf(point, { scale, rotate, displayWidth, displayHeight, box }) {
    const display = pointerToDisplay(point, scale);
    const upright = displayToUpright(display, rotate, displayWidth, displayHeight);
    return uprightToPdf(upright, box);
}

/**
 * A page's boxes, as the transform needs them.
 *
 * `displayWidth`/`displayHeight` follow the *crop* box, because that is what a
 * viewer shows, and they transpose on a quarter turn.
 */
export function pageGeometry({ mediaBox, cropBox, rotate }) {
    const box = cropBox ?? mediaBox;
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

/**
 * Length in points, from a length in pointer pixels.
 *
 * Stroke widths need the same treatment as positions: a 4-pixel pen at 600%
 * zoom is a much thinner line on the page than a 4-pixel pen at 50%, and a save
 * path that stores the pixel number produces a document whose line weights
 * depend on how far the user happened to be zoomed in.
 */
export function pointerLengthToPoints(pixels, scale) {
    return pixels / scale;
}
