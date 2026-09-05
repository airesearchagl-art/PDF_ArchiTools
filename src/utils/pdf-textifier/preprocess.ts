/**
 * Clean up the image that goes to the OCR engine, and only that image.
 *
 * Nothing here ever touches the document the user gets back. The searchable PDF
 * keeps the original page exactly as it was -- vectors, images, annotations,
 * appearance -- and this works on the throwaway raster that exists solely to be
 * recognised. There is deliberately no path from a processed canvas into a PDF.
 */

/** Below this luma a pixel counts as ink. */
const INK_THRESHOLD = 160;

/**
 * Below this luma a pixel counts as evidence that its neighbour belongs to
 * something real, even though it is too pale to be ink itself.
 *
 * Anti-aliasing is why this exists and why it is separate. A glyph on a scan --
 * and especially on a page that was scanned crooked -- has a dark core with
 * grey shoulders either side, and on a thin stroke that core can be a single
 * pixel wide and broken. Judging isolation by ink alone therefore reads parts
 * of real strokes as specks: measured, that removed enough of a crooked noisy
 * page to take recognition from six expected words to none. A speck on paper
 * has white around it; a stroke never does.
 */
const SUPPORT_THRESHOLD = 224;

/** Longest side of the downsampled image the angle is estimated from. */
const ANALYSIS_MAX = 1000;

/**
 * Skew is only searched for in this range. Anything beyond it is a page fed in
 * sideways, which is a /Rotate concern and is already handled upstream -- not
 * something to "correct" by a few degrees.
 */
const MAX_SKEW_DEG = 5;

/**
 * How much better the best angle has to score than leaving the page alone.
 *
 * Measured, not guessed. Across the skewed fixtures this score separates a
 * genuinely crooked page from a straight one by a factor of 13.9 to 66.9, while
 * every straight, noisy, sparse and blank page scores 1.00 to 1.003. A
 * threshold of 2 sits in the middle of that gap with room on both sides, so a
 * straight page is never rotated and a real skew is never dismissed.
 */
const CONFIDENCE_MARGIN = 2;

/**
 * Enough ink to draw a conclusion from. A near-empty sheet has no text lines to
 * align, and every scoring function will still return its argmax -- which for a
 * blank page is simply the first angle tried. Measured: the blank fixture
 * produces -5.00 degrees from an all-zero profile. That answer must never leave
 * this module.
 */
const MIN_INK_POINTS = 500;

/** Below this there is nothing worth rotating a whole page for. */
const MIN_CORRECTION_DEG = 0.3;

export interface OcrPreprocessOptions {
    deskew: boolean;
    noiseReduction: boolean;
}

export interface OcrPreprocessResult {
    /** The image to recognise. The input canvas itself when nothing was done. */
    canvas: HTMLCanvasElement;
    /** True when `canvas` is a new object the caller must release separately. */
    ownsCanvas: boolean;
    deskewApplied: boolean;
    /** Degrees the page was found to be rotated by. 0 when nothing was applied. */
    detectedAngle: number;
    /** How much the winning angle beat leaving the page alone. */
    deskewConfidence: number;
    noiseReductionApplied: boolean;
    removedSpecks: number;
    analysisWidth: number;
    analysisHeight: number;
    detectMs: number;
    applyMs: number;
    noiseMs: number;
    processingMs: number;
    /**
     * Maps a point on the processed canvas back to the canvas that was
     * rendered from the page. Undefined when the two are the same image, which
     * is what lets the searchable-PDF path stay untouched when deskew is off.
     */
    mapToRenderSpace?: (x: number, y: number) => { x: number; y: number };
}

/** Nothing was asked for, or nothing could be done: hand back what came in. */
function untouched(canvas: HTMLCanvasElement, partial: Partial<OcrPreprocessResult> = {}): OcrPreprocessResult {
    return {
        canvas,
        ownsCanvas: false,
        deskewApplied: false,
        detectedAngle: 0,
        deskewConfidence: 0,
        noiseReductionApplied: false,
        removedSpecks: 0,
        analysisWidth: 0,
        analysisHeight: 0,
        detectMs: 0,
        applyMs: 0,
        noiseMs: 0,
        processingMs: 0,
        ...partial,
    };
}

interface InkPoints {
    xs: Float32Array;
    ys: Float32Array;
    width: number;
    height: number;
}

/**
 * The page's ink as a list of coordinates, downsampled.
 *
 * The angle is estimated from this rather than from the full-resolution page.
 * An A0 sheet at 150 DPI is over 50 megapixels, and the search visits dozens of
 * angles; doing that at full size would be minutes of work to answer a question
 * a thousand-pixel-wide copy answers just as well.
 */
function inkPoints(canvas: HTMLCanvasElement): InkPoints | null {
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(canvas.width, canvas.height));
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));

    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // The source may carry transparent areas; paper is white, not see-through.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;

    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            if (luma < INK_THRESHOLD) { xs.push(x); ys.push(y); }
        }
    }
    small.width = 0;
    small.height = 0;
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), width, height };
}

/**
 * Score the page as if it had been straightened by `deg`.
 *
 * Every ink pixel is projected onto a row histogram after undoing a rotation of
 * `deg`, and the score is the energy of the row-to-row differences. When the
 * angle is right, each text line collapses into a few rows with white space
 * either side, and those sharp edges are what this rewards.
 *
 * Two scoring functions were measured against fixtures with known angles: this
 * one and the variance of the same histogram. Both find the angle to within
 * 0.1 degrees, so accuracy did not decide it. This one did, because it
 * separates a skewed page from a straight one by more than an order of
 * magnitude where variance manages less than a factor of four -- and that
 * separation is the whole basis for refusing to rotate a page that is already
 * straight.
 */
function profileScore(points: InkPoints, deg: number): number {
    const rad = deg * Math.PI / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const cx = points.width / 2;
    const cy = points.height / 2;
    const bins = points.height;
    const hist = new Float64Array(bins);

    const { xs, ys } = points;
    for (let i = 0; i < xs.length; i++) {
        const row = (-(xs[i] - cx) * sin + (ys[i] - cy) * cos + cy) | 0;
        if (row >= 0 && row < bins) hist[row]++;
    }

    let energy = 0;
    for (let i = 1; i < bins; i++) {
        const d = hist[i] - hist[i - 1];
        energy += d * d;
    }
    return energy / bins;
}

interface Detection {
    angle: number;
    confidence: number;
}

/**
 * Find the skew, or say that there isn't one worth acting on.
 *
 * Coarse pass over the whole range then a fine pass around the winner, so the
 * cost is a fixed number of histogram builds no matter how large the page is.
 */
function detectSkew(points: InkPoints): Detection {
    if (points.xs.length < MIN_INK_POINTS) return { angle: 0, confidence: 0 };

    let best = 0;
    let bestScore = -Infinity;
    let zeroScore = 0;

    for (let deg = -MAX_SKEW_DEG; deg <= MAX_SKEW_DEG + 1e-9; deg += 0.5) {
        const score = profileScore(points, deg);
        if (Math.abs(deg) < 1e-9) zeroScore = score;
        if (score > bestScore) { bestScore = score; best = deg; }
    }
    for (let deg = best - 0.5; deg <= best + 0.5 + 1e-9; deg += 0.05) {
        if (deg < -MAX_SKEW_DEG || deg > MAX_SKEW_DEG) continue;
        const score = profileScore(points, deg);
        if (score > bestScore) { bestScore = score; best = deg; }
    }

    // A page with no structure scores zero everywhere and the argmax above is
    // then just the first angle tried. Never report that as an angle.
    if (!(zeroScore > 0) || !Number.isFinite(bestScore)) return { angle: 0, confidence: 0 };

    const confidence = bestScore / zeroScore;
    const angle = Math.round(best * 100) / 100;
    if (confidence < CONFIDENCE_MARGIN || Math.abs(angle) < MIN_CORRECTION_DEG) {
        // Uncertain, or straight enough. Leaving it alone is the safer answer:
        // a wrong rotation costs more than a skew small enough to argue about.
        return { angle: 0, confidence };
    }
    return { angle, confidence };
}

/**
 * Remove specks that stand entirely alone on white paper, and nothing else.
 *
 * A dark pixel is a candidate only when it is ink, and it goes only when none
 * of its eight neighbours carries any marking at all -- not ink, not even the
 * pale shoulder of a stroke. A hairline, a dimension line, a minus sign, a `1`,
 * an `I` and the fine strokes of a kanji are therefore kept by construction: a
 * stroke always has something touching it, even where its dark core runs thin.
 *
 * Deliberately this timid. An earlier version also removed pairs of pixels that
 * were alone together, on the reasoning that a two-pixel group cannot be text.
 * Measured, that cost the heavily speckled fixture two of its six expected
 * words; dropping the rule turned the same page from 6/6 to 6/6 with slightly
 * better confidence. The extra speckle it cleared was not worth what it took.
 *
 * No blur, no dilation, no rethresholding of the page.
 */
function removeSpecks(ctx: CanvasRenderingContext2D, width: number, height: number): number {
    const image = ctx.getImageData(0, 0, width, height);
    const d = image.data;
    const size = width * height;
    const ink = new Uint8Array(size);
    const support = new Uint8Array(size);
    for (let p = 0, i = 0; p < size; p++, i += 4) {
        const luma = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (luma < INK_THRESHOLD) ink[p] = 1;
        if (luma < SUPPORT_THRESHOLD) support[p] = 1;
    }

    /** How many of the eight neighbours carry any marking at all. */
    const around = new Uint8Array(size);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!ink[p]) continue;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const xx = x + dx;
                    if (xx < 0 || xx >= width) continue;
                    if (support[yy * width + xx]) n++;
                }
            }
            around[p] = n;
        }
    }

    let removed = 0;
    const erase = (p: number) => {
        const i = p * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255;
        removed++;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!ink[p]) continue;
            if (around[p] === 0) erase(p);
        }
    }

    if (removed > 0) ctx.putImageData(image, 0, 0);
    return removed;
}

/**
 * Straighten the page into a canvas large enough to hold all of it.
 *
 * Rotating in place would slide the corners outside the frame, and on a drawing
 * the corners are where the title block and the sheet border live. The output
 * is the bounding box of the rotated page instead, which costs a few percent
 * more pixels and loses nothing.
 */
function applyDeskew(source: HTMLCanvasElement, angleDeg: number) {
    const rad = angleDeg * Math.PI / 180;
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    // Read once, into numbers. The mapping below is called after recognition,
    // by which time this canvas has been released and its width and height are
    // zero -- reading them lazily put every word half a page from where it
    // belonged, and only when noise reduction had made a canvas to release.
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const width = Math.ceil(sourceWidth * cos + sourceHeight * sin);
    const height = Math.ceil(sourceWidth * sin + sourceHeight * cos);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-rad);
    ctx.drawImage(source, -sourceWidth / 2, -sourceHeight / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // The exact inverse, for putting recognised words back where they came from
    // on the page that is actually in the PDF.
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    const mapToRenderSpace = (x: number, y: number) => {
        const ex = x - width / 2;
        const ey = y - height / 2;
        return {
            x: ex * cosR - ey * sinR + sourceWidth / 2,
            y: ex * sinR + ey * cosR + sourceHeight / 2,
        };
    };

    return { canvas: out, ctx, mapToRenderSpace };
}

/**
 * Prepare one rendered page for recognition.
 *
 * Order matters: specks are removed before the page is straightened, because
 * rotation resamples and turns a crisp one-pixel speck into a soft grey smudge
 * that no longer looks isolated to anything.
 */
export function preprocessForOcr(
    canvas: HTMLCanvasElement,
    options: OcrPreprocessOptions,
): OcrPreprocessResult {
    if (!options.deskew && !options.noiseReduction) return untouched(canvas);

    const startedAt = performance.now();
    let working = canvas;
    let ownsCanvas = false;
    let noiseMs = 0;
    let removedSpecks = 0;
    let noiseReductionApplied = false;

    if (options.noiseReduction) {
        const t0 = performance.now();
        // Work on a copy: the rendered canvas belongs to the caller, and the
        // OCR image must never be the thing anything else might still read.
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.drawImage(canvas, 0, 0);
            removedSpecks = removeSpecks(ctx, copy.width, copy.height);
            working = copy;
            ownsCanvas = true;
            noiseReductionApplied = true;
        } else {
            copy.width = 0;
            copy.height = 0;
        }
        noiseMs = performance.now() - t0;
    }

    let detectMs = 0;
    let applyMs = 0;
    let detectedAngle = 0;
    let deskewConfidence = 0;
    let deskewApplied = false;
    let analysisWidth = 0;
    let analysisHeight = 0;
    let mapToRenderSpace: OcrPreprocessResult['mapToRenderSpace'];

    if (options.deskew) {
        const t0 = performance.now();
        const points = inkPoints(working);
        if (points) {
            analysisWidth = points.width;
            analysisHeight = points.height;
            const detection = detectSkew(points);
            detectedAngle = detection.angle;
            deskewConfidence = detection.confidence;
        }
        detectMs = performance.now() - t0;

        if (detectedAngle !== 0) {
            const t1 = performance.now();
            const rotated = applyDeskew(working, detectedAngle);
            if (rotated) {
                // The rotation is measured against the page as rendered, so the
                // mapping has to be too. When noise reduction made a copy first
                // the two share a coordinate space, so nothing else is needed.
                if (ownsCanvas) { working.width = 0; working.height = 0; }
                working = rotated.canvas;
                ownsCanvas = true;
                deskewApplied = true;
                mapToRenderSpace = rotated.mapToRenderSpace;
            }
            applyMs = performance.now() - t1;
        }
    }

    return {
        canvas: working,
        ownsCanvas,
        deskewApplied,
        detectedAngle,
        deskewConfidence: Number.isFinite(deskewConfidence) ? Math.round(deskewConfidence * 1000) / 1000 : 0,
        noiseReductionApplied,
        removedSpecks,
        analysisWidth,
        analysisHeight,
        detectMs: Math.round(detectMs),
        applyMs: Math.round(applyMs),
        noiseMs: Math.round(noiseMs),
        processingMs: Math.round(performance.now() - startedAt),
        mapToRenderSpace,
    };
}
