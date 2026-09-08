/**
 * The four ways a comparison could decide what to compare.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * Candidate 0 is a replica of what ships today, kept honest rather than
 * flattering: it is the thing the others are measured against, and its failures
 * are the reason this spike exists.
 */
import { pageGeometry, compareGeometry, referenceScale } from './geometry.mjs';

/** What a comparison can say, beyond "here is a picture". */
export const RESULT = {
    MATCH: 'MATCH',
    CHANGE: 'CHANGE',
    MISSING_PAGE: 'MISSING_PAGE',
    GEOMETRY_MISMATCH: 'GEOMETRY_MISMATCH',
    ALIGNMENT_REQUIRED: 'ALIGNMENT_REQUIRED',
    RENDER_FAILED: 'RENDER_FAILED',
    UNSUPPORTED: 'UNSUPPORTED',
    CANCELLED: 'CANCELLED',
};

// ---------------------------------------------------------------------------
// The render budget
// ---------------------------------------------------------------------------

/**
 * What a comparison actually holds in memory at once.
 *
 * The Annotator's 8 Mpx ceiling does not transfer. That bounds one transparent
 * fragment; this holds every layer's RGBA at full page size *simultaneously*,
 * plus a normalising canvas, plus the composite, plus whatever the JPEG encoder
 * needs. Counting one canvas would understate a two-layer A0 comparison by
 * about four times.
 *
 * Returned in bytes, so the number can be compared with something.
 */
export function estimateMemory({ width, height, layers }) {
    const pixels = width * height;
    const rgba = pixels * 4;
    return {
        pixels,
        perLayerCanvas: rgba,
        // Each layer is rendered, then normalised into a shared canvas and read
        // back out as an ImageData copy that is kept for the whole composite.
        layerCanvases: rgba * layers,
        normalisedCopies: rgba * layers,
        normalisingCanvas: rgba,
        composite: rgba,
        // toDataURL('image/jpeg') materialises a base64 string; roughly 4/3 of
        // the encoded size, and the encoder holds a bitmap while it works.
        encoder: rgba,
        get total() {
            return this.layerCanvases + this.normalisedCopies
                + this.normalisingCanvas + this.composite + this.encoder;
        },
    };
}

/**
 * The comparison's own ceiling, expressed per comparison rather than per canvas.
 *
 * Deliberately not a number carried over from another feature: the shape of the
 * cost is different, and section 22 of the brief says so. What is proposed here
 * is a *total working set*, because that is what the browser has to find.
 */
export const MAX_COMPARISON_BYTES = 512 * 1024 * 1024;

export function checkBudget({ width, height, layers, limit = MAX_COMPARISON_BYTES }) {
    const estimate = estimateMemory({ width, height, layers });
    return {
        ...estimate,
        limit,
        withinBudget: estimate.total <= limit,
    };
}

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

/**
 * The tolerance a user means, in units they can reason about.
 *
 * Today the threshold is a pixel radius, so the same setting means a different
 * physical distance at every DPI: `threshold = 2` is 0.34 mm at 150 DPI and
 * 0.08 mm at 600. A drawing office that calibrates its tolerance at one
 * resolution silently gets a different comparison at another.
 */
export function pixelRadiusFor(millimetres, dpi) {
    const pixelsPerMm = dpi / 25.4;
    return Math.max(0, Math.round(millimetres * pixelsPerMm));
}

export function millimetresFor(pixelRadius, dpi) {
    return (pixelRadius * 25.4) / dpi;
}

// ---------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------

/**
 * Candidate 0 — what ships today.
 *
 * Each page rendered on its own terms, the canvases sized to the largest, the
 * smaller ones drawn at the top-left of a white field. No geometry is examined,
 * a missing page is skipped, and a layer that fails to render is dropped with a
 * console warning while the rest continue.
 *
 * It always produces a picture. That is the problem.
 */
export function candidateBaseline({ pages }) {
    const present = pages.filter((p) => p.available && !p.renderError);
    if (present.length === 0) return { status: RESULT.RENDER_FAILED, pages: [] };
    const width = Math.max(...present.map((p) => p.displayWidth));
    const height = Math.max(...present.map((p) => p.displayHeight));
    return {
        status: RESULT.CHANGE,
        // Whatever is left, aligned at the top-left corner.
        members: present.length,
        droppedMembers: pages.length - present.length,
        width,
        height,
        alignment: 'top-left',
        // Nothing downstream is told any of this happened.
        reported: [],
    };
}

/**
 * Candidate A — strict geometry match.
 *
 * Compares only when the pages describe the same visible sheet. Anything else
 * is refused by name, with the difference stated, so the user knows the tool
 * declined rather than that the drawing changed.
 */
export function candidateStrict({ pages, tolerancePt = 1 }) {
    const missing = pages.filter((p) => !p.available);
    if (missing.length > 0) {
        return {
            status: RESULT.MISSING_PAGE,
            reported: missing.map((p) => `${p.label}: この文書にこのページはありません`),
        };
    }
    const failed = pages.filter((p) => p.renderError);
    if (failed.length > 0) {
        return {
            status: RESULT.RENDER_FAILED,
            reported: failed.map((p) => `${p.label}: ページを描画できませんでした`),
        };
    }

    const [reference, ...others] = pages.map((p) => pageGeometry(p));
    const problems = [];
    others.forEach((g, i) => {
        const verdict = compareGeometry(reference, g, { tolerancePt });
        // A rotation alone is arithmetic; anything else is a question about
        // what "the same place" means, and that is not the tool's to answer.
        const blocking = verdict.differences.filter((d) => d.recoverable !== 'automatic');
        if (blocking.length > 0) {
            problems.push({ member: pages[i + 1].label, differences: blocking });
        }
    });
    if (problems.length > 0) {
        return {
            status: RESULT.GEOMETRY_MISMATCH,
            problems,
            reported: problems.map((p) => `${p.member}: `
                + p.differences.map((d) => d.detail).join(', ')),
        };
    }
    return {
        status: RESULT.CHANGE,
        members: pages.length,
        droppedMembers: 0,
        // Rendering upright removes the only difference that was left.
        width: reference.displayWidth,
        height: reference.displayHeight,
        alignment: 'upright-page-space',
        reported: [],
    };
}

/**
 * Candidate B — reference-space normalisation, where it is provable.
 *
 * Slot 1 is the reference. Another page is mapped into its display plane only
 * when the mapping is a rigid one: the same physical sheet, differing by
 * rotation or crop origin. Where a real rescale would be needed — a different
 * sheet size — it refuses rather than stretching, because stretching a drawing
 * onto another's paper changes every length on it.
 */
export function candidateNormalise({ pages, tolerancePt = 1 }) {
    const strict = candidateStrict({ pages, tolerancePt: Infinity });
    if (strict.status !== RESULT.CHANGE) return strict;

    const [reference, ...others] = pages.map((p) => pageGeometry(p));
    const mappings = [];
    for (let i = 0; i < others.length; i++) {
        const verdict = compareGeometry(reference, others[i], { tolerancePt });
        const sizeDiff = verdict.differences.find((d) => d.kind === 'sheet-size');
        if (sizeDiff) {
            return {
                status: RESULT.GEOMETRY_MISMATCH,
                problems: [{ member: pages[i + 1].label, differences: [sizeDiff] }],
                reported: [`${pages[i + 1].label}: ${sizeDiff.detail}`
                    + '（用紙が異なるため、拡大して重ねると寸法が変わります）'],
            };
        }
        const scale = referenceScale(reference, others[i]);
        mappings.push({
            member: pages[i + 1].label,
            rotate: others[i].rotate,
            cropOrigin: others[i].origin,
            scale: scale.uniform ? 1 : scale,
            rigid: scale.uniform,
        });
    }
    return {
        status: RESULT.CHANGE,
        members: pages.length,
        droppedMembers: 0,
        width: reference.displayWidth,
        height: reference.displayHeight,
        alignment: 'reference-display-plane',
        mappings,
        reported: [],
    };
}

/**
 * Candidate C — human alignment.
 *
 * When the geometry cannot be settled by arithmetic, the tool says so and lets
 * a person supply the offset, and optionally a rotation and scale. The result
 * carries that alignment, so a comparison is never separable from the
 * assumption it was made under.
 *
 * The tool proposes nothing here. An offer of "we think it is 12.4pt across"
 * becomes the answer the moment it is displayed.
 */
export function candidateHumanAlignment({ pages, alignment = null, tolerancePt = 1 }) {
    const strict = candidateStrict({ pages, tolerancePt });
    if (strict.status !== RESULT.GEOMETRY_MISMATCH) return strict;
    if (!alignment) {
        return {
            ...strict,
            status: RESULT.ALIGNMENT_REQUIRED,
            reported: strict.reported.map((r) => `${r}（位置合わせを指定すると比較できます）`),
        };
    }
    const [reference] = pages.map((p) => pageGeometry(p));
    return {
        status: RESULT.CHANGE,
        members: pages.length,
        droppedMembers: 0,
        width: reference.displayWidth,
        height: reference.displayHeight,
        alignment: 'human',
        appliedAlignment: alignment,
        reported: ['位置合わせは手動指定によるものです'],
    };
}
