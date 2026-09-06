/**
 * How a field rectangle drawn on one page is carried to the others.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * This is the load-bearing question of M2-5. A user marks four rectangles on a
 * representative sheet; every other page has to be read through those
 * rectangles. Whether that works depends entirely on what a rectangle is
 * *stored as*, and the three plausible answers behave very differently the
 * moment a sheet size, an orientation or a title-block layout changes.
 *
 * All rectangles are in **upright page space**: origin top-left, y downwards,
 * PDF points, with any /Rotate already undone. That is the space M2-4 settled
 * on, and reusing it means a template and a token are in the same world.
 */

/**
 * A. Absolute points.
 *
 * The rectangle as drawn, in points. Correct on any page that is the same size
 * and orientation as the one it was drawn on, and meaningless on any page that
 * is not -- an A1 sheet's title block is nowhere near an A3's corner in points.
 */
export function applyAbsolute(field, page) {
    return { ...field.rect };
}

/**
 * B. Normalised to the page box.
 *
 * The rectangle as a fraction of width and height. Survives a change of sheet
 * size when the layout is proportionally the same, which is the usual case for
 * a title block pinned to a corner. Does not survive a change of orientation:
 * a fraction of the width means something different when the width is now the
 * height.
 */
export function applyNormalised(field, page) {
    return {
        left: field.fraction.left * page.uprightWidth,
        top: field.fraction.top * page.uprightHeight,
        right: field.fraction.right * page.uprightWidth,
        bottom: field.fraction.bottom * page.uprightHeight,
    };
}

/**
 * C. Normalised, and anchored to the corner the field sits near.
 *
 * The fraction is measured from the nearest corner rather than from the origin,
 * and the rectangle keeps the size it had in points. A title block is a fixed
 * physical size held against a corner of the sheet -- it does not grow when the
 * paper does -- so this is the model that matches how the thing being measured
 * actually behaves. Whether that is true is what the measurement decides.
 */
export function applyCornerAnchored(field, page) {
    const w = field.rect.right - field.rect.left;
    const h = field.rect.bottom - field.rect.top;
    const fromRight = field.source.uprightWidth - field.rect.right;
    const fromBottom = field.source.uprightHeight - field.rect.bottom;
    const nearRight = fromRight < field.rect.left;
    const nearBottom = fromBottom < field.rect.top;

    const left = nearRight ? page.uprightWidth - fromRight - w : field.rect.left;
    const top = nearBottom ? page.uprightHeight - fromBottom - h : field.rect.top;
    return { left, top, right: left + w, bottom: top + h };
}

export const MODELS = {
    absolute: applyAbsolute,
    normalised: applyNormalised,
    'corner-anchored': applyCornerAnchored,
};

/**
 * Build a template from a page the user has marked up.
 *
 * Each field carries everything the models need: the rectangle in points, the
 * same rectangle as a fraction, and the size of the page it was drawn on.
 * Storing all three is what lets the models be compared on identical input
 * rather than on three slightly different templates.
 */
export function buildTemplate({ profile, page, fields }) {
    return {
        profile,
        source: {
            pageNumber: page.pageNumber,
            uprightWidth: page.uprightWidth,
            uprightHeight: page.uprightHeight,
            aspect: page.uprightWidth / page.uprightHeight,
        },
        fields: Object.fromEntries(Object.entries(fields).map(([key, rect]) => [key, {
            rect: { ...rect },
            fraction: {
                left: rect.left / page.uprightWidth,
                top: rect.top / page.uprightHeight,
                right: rect.right / page.uprightWidth,
                bottom: rect.bottom / page.uprightHeight,
            },
            source: {
                uprightWidth: page.uprightWidth,
                uprightHeight: page.uprightHeight,
            },
        }])),
    };
}

/** Apply a whole template to a page under one coordinate model. */
export function applyTemplate(template, page, model = 'corner-anchored') {
    const apply = MODELS[model];
    if (!apply) throw new Error(`unknown coordinate model: ${model}`);
    return Object.fromEntries(Object.entries(template.fields)
        .map(([key, field]) => [key, apply(field, page)]));
}

/**
 * Whether a template may be applied to a page at all.
 *
 * The alternative is silence, and silence is the failure mode that matters:
 * applying a bottom-right template to a page whose title block runs up the
 * right-hand edge produces four rectangles full of the wrong things, and every
 * one of them looks like a value. So a page whose proportions differ from the
 * page the template was drawn on is *refused* rather than approximated, and a
 * refusal is a reason to ask the user for a second template -- not an error.
 *
 * Orientation and aspect only. Deciding whether the *layout* matches from
 * geometry alone is not attempted: that is what a second profile is for.
 */
export function templateFits(template, page, { aspectTolerance = 0.02 } = {}) {
    const reasons = [];
    const sourceLandscape = template.source.uprightWidth > template.source.uprightHeight;
    const pageLandscape = page.uprightWidth > page.uprightHeight;
    if (sourceLandscape !== pageLandscape) reasons.push('orientation differs');

    const pageAspect = page.uprightWidth / page.uprightHeight;
    const drift = Math.abs(pageAspect - template.source.aspect) / template.source.aspect;
    if (drift > aspectTolerance) {
        reasons.push(`aspect differs by ${(drift * 100).toFixed(1)}%`);
    }
    return { fits: reasons.length === 0, reasons, aspectDrift: drift };
}

/** Overlap of two rectangles over the smaller of them, 0 to 1. */
export function overlap(a, b) {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return 0;
    const inter = (right - left) * (bottom - top);
    const areaA = (a.right - a.left) * (a.bottom - a.top);
    const areaB = (b.right - b.left) * (b.bottom - b.top);
    const smaller = Math.min(areaA, areaB);
    return smaller > 0 ? inter / smaller : 0;
}

/** Intersection over union, for reporting how closely two rectangles agree. */
export function iou(a, b) {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return 0;
    const inter = (right - left) * (bottom - top);
    const areaA = (a.right - a.left) * (a.bottom - a.top);
    const areaB = (b.right - b.left) * (b.bottom - b.top);
    return inter / (areaA + areaB - inter);
}

/** The smallest rectangle containing all of a template's fields, plus padding. */
export function unionRegion(rects, pad = 0) {
    const list = Object.values(rects);
    if (!list.length) return null;
    return {
        left: Math.min(...list.map((r) => r.left)) - pad,
        top: Math.min(...list.map((r) => r.top)) - pad,
        right: Math.max(...list.map((r) => r.right)) + pad,
        bottom: Math.max(...list.map((r) => r.bottom)) + pad,
    };
}
