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


// ---------------------------------------------------------------------------
// Which template applies to which page
// ---------------------------------------------------------------------------

/**
 * A template profile assignment, confirmed by a person.
 *
 * The obvious shortcut is to key templates on sheet size: same size, same
 * block. This corpus refutes it on its own -- pages 5, 6 and 7 are all A2, and
 * page 7 is drawn to a different title-block layout entirely. Sheet size is not
 * the thing that varies; the drawing office's template is, and the same office
 * issues several.
 *
 * So assignment is explicit. A profile is a named template plus the coordinate
 * model to transfer it by, and a page belongs to a profile because somebody
 * said so -- by page, or by range. There is no inference step, and a page
 * nobody has assigned is *unassigned*, not guessed.
 *
 * `templateFits()` deliberately plays no part in this. It answers a narrower
 * question (does this rectangle still land on this page) and it answers it true
 * for every A-series sheet, so using it to decide assignment would auto-continue
 * onto exactly the pages this design refuses to guess at.
 */
export function createAssignment() {
    return { profiles: new Map(), pages: new Map() };
}

/** Register a named profile: a template, and how it transfers. */
export function defineProfile(assignment, name, { template, model, confirmedBy = null }) {
    assignment.profiles.set(name, { name, template, model, confirmedBy });
    return assignment;
}

/**
 * Attach pages to a profile.
 *
 * `confirmedBy` is required and not decorative: an assignment nobody confirmed
 * is the thing this whole structure exists to prevent, so it has to be recorded
 * at the point it is made.
 */
export function assignPages(assignment, pageNumbers, profileName, { confirmedBy }) {
    if (!assignment.profiles.has(profileName)) {
        throw new Error(`no such profile: ${profileName}`);
    }
    if (!confirmedBy) {
        throw new Error('an assignment must record who confirmed it');
    }
    for (const pageNumber of pageNumbers) {
        assignment.pages.set(pageNumber, { profileName, confirmedBy });
    }
    return assignment;
}

/**
 * The profile for a page, or null.
 *
 * Null is a real answer and callers must handle it. It does not mean "try the
 * only profile we have" or "use the one that fits"; it means nobody has said
 * what this page is, and the register has to say so rather than produce four
 * confident empty fields.
 */
export function profileFor(assignment, pageNumber) {
    const assigned = assignment.pages.get(pageNumber);
    if (!assigned) return null;
    const profile = assignment.profiles.get(assigned.profileName);
    return profile ? { ...profile, confirmedBy: assigned.confirmedBy } : null;
}

/** Pages with no confirmed profile, which the caller must still produce rows for. */
export function unassignedPages(assignment, pageNumbers) {
    return pageNumbers.filter((n) => !assignment.pages.has(n));
}
