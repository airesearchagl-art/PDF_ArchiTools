/**
 * What "the same page" means when two PDFs are compared.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * The comparator's job is to say what changed in a drawing. Everything in this
 * file exists because a page can differ from another page in ways that are not
 * changes to the drawing at all — a different sheet size, a quarter turn in the
 * page dictionary, a crop box starting somewhere other than the origin — and a
 * comparison that ignores those reports them as design changes. The user cannot
 * tell those apart from the real thing, which makes it the worst failure this
 * feature has: a wrong answer that looks like an answer.
 */

/** Normalise any rotation to 0, 90, 180 or 270. */
export function normaliseRotation(rotate) {
    return (((Math.round(rotate / 90) * 90) % 360) + 360) % 360;
}

/**
 * The page as a viewer shows it.
 *
 * `view` is what PDF.js reports as the visible box — the CropBox where there is
 * one, the MediaBox otherwise — in PDF points. `displayWidth`/`displayHeight`
 * are that box after `/Rotate`, which is the frame a rendered canvas is in.
 */
export function pageGeometry({ view, rotate }) {
    const [x0, y0, x1, y1] = view;
    const boxWidth = Math.abs(x1 - x0);
    const boxHeight = Math.abs(y1 - y0);
    const r = normaliseRotation(rotate);
    const quarter = r === 90 || r === 270;
    return {
        rotate: r,
        origin: { x: Math.min(x0, x1), y: Math.min(y0, y1) },
        boxWidth,
        boxHeight,
        displayWidth: quarter ? boxHeight : boxWidth,
        displayHeight: quarter ? boxWidth : boxHeight,
        /** Physical size of the visible region, rotation ignored. */
        physical: { width: boxWidth, height: boxHeight },
    };
}

/**
 * How two pages differ, before anything is rendered.
 *
 * Reported as a list of named differences rather than a boolean, because the
 * right response is not the same for all of them: a quarter turn is
 * recoverable by rendering upright, a different sheet size is not recoverable
 * without deciding what "the same place" means, and a crop origin is only
 * recoverable if the visible extents actually match.
 *
 * `tolerancePt` exists because generators disagree about A4 by fractions of a
 * point. It is deliberately small: 3 points is a millimetre, and a millimetre
 * of drift across a sheet is not a rounding artefact.
 */
export function compareGeometry(a, b, { tolerancePt = 1 } = {}) {
    const close = (p, q) => Math.abs(p - q) <= tolerancePt;
    const differences = [];

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
            // would compare a 1:50 plan against a 1:100 one and call the
            // difference a change.
            sameAspect: Math.abs(ratio - 1) < 0.01,
            recoverable: 'human',
        });
    } else if (!displaySame) {
        // Same physical sheet, different displayed extent: that is the rotation
        // above, and nothing more.
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
            // A crop origin is only a description of where the visible region
            // sits on the sheet. If the visible regions are the same size, a
            // renderer that starts at each page's own origin has already
            // removed it -- which is what PDF.js does.
            recoverable: physicalSame ? 'automatic' : 'human',
        });
    }

    return {
        identical: differences.length === 0,
        differences,
        /** True when nothing is left that a renderer cannot settle by itself. */
        automaticOnly: differences.every((d) => d.recoverable === 'automatic'),
    };
}

/**
 * The scale that puts a page into the reference page's display plane.
 *
 * Only meaningful when the two are the same physical sheet — otherwise this
 * would be stretching one drawing onto another's paper, which changes lengths
 * and is exactly what a comparison must not do silently.
 */
export function referenceScale(reference, other) {
    return {
        x: reference.displayWidth / other.displayWidth,
        y: reference.displayHeight / other.displayHeight,
        uniform: Math.abs(
            (reference.displayWidth / other.displayWidth)
            - (reference.displayHeight / other.displayHeight),
        ) < 1e-6,
    };
}
