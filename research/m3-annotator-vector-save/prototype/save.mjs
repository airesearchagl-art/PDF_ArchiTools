/**
 * Four ways to save an annotated page, so they can be measured against each
 * other rather than argued about.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 *   candidate 0  whole-page raster -- what the app does today.
 *   candidate A  the original PDF, with the annotation layer alone laid over it
 *                as a transparent image.
 *   candidate B  the original PDF, with the annotations written as drawing
 *                operators.
 *   candidate C  the original PDF, annotations written in painter order as a
 *                sequence of runs: operators where they work, a transparent
 *                raster for the span an eraser reaches into.
 *
 * A and C exist because of one thing the app does that PDF has no operator for.
 * The pixel eraser is not a deletion: it is an object replayed with
 * `destination-out`, subtracting from whatever was drawn before it
 * (`DrawingCanvas.tsx:223-229`). A content stream cannot un-draw.
 *
 * What none of them do is change the source page's own content. The eraser
 * erases annotation ink; it is not redaction and this code never treats it as
 * such.
 *
 * **Coordinates.** Stored annotation coordinates are in *display* space --
 * `/Rotate` already applied -- because the canvas is sized from a rotated
 * viewport (`PdfPage.tsx:74`) and the pointer conversion only divides by the
 * zoom (`DrawingCanvas.tsx:129-138`). Every writer here therefore goes
 * stored -> `displayToUpright` -> `uprightToPdf`, and the middle step is not
 * optional: without it a rotated page gets its marks in the wrong place, and
 * every `/Rotate 0` fixture will cheerfully report that all is well.
 */

import {
    MEASURE_FILL_ALPHA, MEASURE_LINE_WIDTH, MEASURE_VERTEX_RADIUS,
    hexToRgb, labelBox, measureHasVertices, measureLabels, segmentWidth,
} from './model.mjs';
import { displayToUpright, uprightToPdf, pageGeometry } from './coords.mjs';

// ---------------------------------------------------------------------------
// Rendering, matched to the app
// ---------------------------------------------------------------------------

/**
 * Draw the annotation objects, the way the app draws them.
 *
 * Deliberately a copy of `DrawingCanvas.tsx:212-371` rather than a tidy-up,
 * down to the details that look like accidents: text is anchored at its *top*,
 * an area is stroked before it is filled, poly and area measurements get vertex
 * dots, and every label has its own font, alignment, colour and white backing
 * rectangle. Where this differs from the app, the fidelity numbers measure this
 * file instead of the app -- which is what happened the first time, and it made
 * font substitution look more expensive than it is.
 */
export function renderAnnotations(ctx, objects, { scale = 1, offset = { x: 0, y: 0 } } = {}) {
    ctx.save();
    // setTransform *replaces* the transform, so an offset applied with
    // translate() beforehand would be discarded. The fragment renderer needs
    // one, so it is folded into the same call.
    ctx.setTransform(scale, 0, 0, scale, -offset.x * scale, -offset.y * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const obj of objects) {
        ctx.globalAlpha = obj.opacity ?? 1;
        ctx.globalCompositeOperation = 'source-over';

        if (obj.type === 'stroke') {
            if (obj.isEraser) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.strokeStyle = '#000000';
            } else {
                ctx.strokeStyle = obj.color;
            }
            if (obj.points.length < 2) continue;

            if (!obj.enablePressure) {
                ctx.lineWidth = obj.lineWidth;
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x, obj.points[0].y);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x, obj.points[i].y);
                }
                ctx.stroke();
            } else {
                for (let i = 0; i < obj.points.length - 1; i++) {
                    ctx.beginPath();
                    ctx.moveTo(obj.points[i].x, obj.points[i].y);
                    ctx.lineTo(obj.points[i + 1].x, obj.points[i + 1].y);
                    ctx.lineWidth = segmentWidth(obj, i);
                    ctx.stroke();
                }
            }
        } else if (obj.type === 'text') {
            // Note the trailing space in the app's font string, and the *top*
            // baseline: the stored y is the top of the glyph box, not the
            // typographic baseline.
            ctx.font = `${obj.fontSize}px ${obj.fontFamily} `;
            ctx.fillStyle = obj.color;
            ctx.textBaseline = 'top';
            ctx.fillText(obj.text, obj.x, obj.y);
        } else if (obj.type === 'measure') {
            const p = obj.points;
            if (p.length < 2) continue;
            ctx.strokeStyle = obj.color;
            ctx.fillStyle = obj.color;
            ctx.lineWidth = MEASURE_LINE_WIDTH;

            ctx.beginPath();
            ctx.moveTo(p[0].x, p[0].y);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
            if (obj.subtype === 'area') {
                // Stroked first, then filled -- the app's order, and it matters
                // because the translucent fill lands on top of the outline.
                ctx.closePath();
                ctx.stroke();
                const fillC = obj.color.startsWith('#') ? obj.color : '#0000ff';
                ctx.fillStyle = `${fillC}4d`;
                ctx.fill();
                ctx.fillStyle = obj.color;
            } else {
                ctx.stroke();
            }

            if (measureHasVertices(obj)) {
                ctx.fillStyle = obj.color;
                for (const q of p) {
                    ctx.beginPath();
                    ctx.arc(q.x, q.y, MEASURE_VERTEX_RADIUS, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            ctx.save();
            ctx.textBaseline = 'bottom';
            for (const label of measureLabels(obj)) {
                ctx.font = label.font;
                ctx.textAlign = label.align;
                const width = ctx.measureText(label.text).width;
                const box = labelBox(label, width);
                if (box) {
                    ctx.fillStyle = label.bold ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.8)';
                    ctx.fillRect(box.x, box.y, box.width, box.height);
                }
                ctx.fillStyle = label.colour ?? obj.color;
                ctx.fillText(label.text, label.x, label.y);
            }
            ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
}

/** A canvas holding only the annotation layer, on transparent pixels. */
export function renderOverlayCanvas(objects, { width, height, scale = 1 }) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // No fill: the pixels stay transparent, which is the whole point. JPEG
    // cannot carry that, which is why this path produces PNG.
    renderAnnotations(ctx, objects, { scale });
    return canvas;
}

const releaseCanvas = (canvas) => { if (canvas) { canvas.width = 0; canvas.height = 0; } };

// ---------------------------------------------------------------------------
// Painted bounds
// ---------------------------------------------------------------------------

let measuringCtx = null;
function textWidth(text, font) {
    if (!measuringCtx) {
        const c = document.createElement('canvas');
        c.width = 8;
        c.height = 8;
        measuringCtx = c.getContext('2d');
    }
    measuringCtx.font = font;
    return measuringCtx.measureText(text).width;
}

/**
 * Everything an object actually paints, with a margin for error.
 *
 * An earlier version used the stroke points and the nominal line width, which
 * is wrong in several ways at once: a pressure stroke can be twice its nominal
 * width, text extends below and right of its anchor by an amount only the font
 * knows, and measurements draw vertex dots and labels with backing rectangles
 * that reach well outside the geometry -- a poly's total label sits past its
 * last point entirely.
 *
 * Under-reporting is the dangerous direction. It lets an eraser and the ink it
 * touches look unrelated, which puts them in different layers and changes what
 * the user drew. So every estimate rounds outward, and anything unknown counts
 * as painted.
 */
export function paintedBounds(obj) {
    const boxes = [];
    const add = (minX, minY, maxX, maxY) => boxes.push({ minX, minY, maxX, maxY });

    if (obj.type === 'stroke') {
        const xs = obj.points.map((p) => p.x);
        const ys = obj.points.map((p) => p.y);
        let widest = obj.lineWidth;
        if (obj.enablePressure) {
            for (let i = 0; i < obj.points.length - 1; i++) {
                widest = Math.max(widest, segmentWidth(obj, i));
            }
        }
        const half = widest / 2 + 1;
        add(Math.min(...xs) - half, Math.min(...ys) - half,
            Math.max(...xs) + half, Math.max(...ys) + half);
    } else if (obj.type === 'text') {
        const font = `${obj.fontSize}px ${obj.fontFamily} `;
        const w = textWidth(obj.text, font);
        // Anchored at the top; a generous descent allowance below, because the
        // real descent is not knowable from the size alone.
        add(obj.x - 2, obj.y - 2, obj.x + w + 2, obj.y + obj.fontSize * 1.6 + 2);
    } else if (obj.type === 'measure') {
        const xs = obj.points.map((p) => p.x);
        const ys = obj.points.map((p) => p.y);
        const pad = MEASURE_LINE_WIDTH / 2 + (measureHasVertices(obj) ? MEASURE_VERTEX_RADIUS : 0) + 1;
        add(Math.min(...xs) - pad, Math.min(...ys) - pad,
            Math.max(...xs) + pad, Math.max(...ys) + pad);
        for (const label of measureLabels(obj)) {
            const w = textWidth(label.text, label.font);
            const box = labelBox(label, w);
            if (box) add(box.x - 1, box.y - 1, box.x + box.width + 1, box.y + box.height + 1);
            const left = label.align === 'left' ? label.x : label.x - w / 2;
            add(left - 1, label.y - label.size - 2, left + w + 1, label.y + 2);
        }
    }

    if (boxes.length === 0) return null;
    return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
}

function boundsOverlap(a, b) {
    if (!a || !b) return true; // unknown means treat as touching
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

// ---------------------------------------------------------------------------
// Composition planning
// ---------------------------------------------------------------------------

/**
 * Split an annotation layer into runs that keep painter order.
 *
 * An earlier version sorted objects into a vector bucket and a raster bucket
 * and wrote all of one then all of the other. That does not preserve stacking.
 * Given `stroke A, eraser, stroke B`, B is on top in the app; bucketed, B is
 * written as an operator and the fragment holding A and the eraser is drawn
 * afterwards, on top of it.
 *
 * So the plan is a *sequence*. The span from the earliest object an eraser
 * reaches back to, through to the last eraser, becomes one raster fragment;
 * whatever precedes and follows stays operators; the runs are emitted in order.
 * Because pdf-lib appends to the content stream in call order, emitting runs in
 * order preserves stacking by construction.
 *
 * Everything inside the span is rasterised, including objects no eraser
 * touches. That is deliberate: deciding which of them could be lifted out means
 * reasoning about overlaps between every pair, and being wrong there reorders
 * the user's marks. Over-including costs pixels; under-including changes the
 * drawing.
 *
 * With erasers scattered through a layer the span grows until it is the whole
 * layer, which is the documented fallback: the annotation layer becomes one
 * transparent image. The source page is still never rasterised.
 */
export function planComposition(objects) {
    const eraserIndices = [];
    objects.forEach((obj, i) => {
        if (obj.type === 'stroke' && obj.isEraser) eraserIndices.push(i);
    });
    if (eraserIndices.length === 0) {
        return {
            runs: objects.length ? [{ kind: 'vector', from: 0, to: objects.length - 1, objects }] : [],
            rasterSpan: null,
            wholeLayerRastered: false,
        };
    }

    const bounds = objects.map(paintedBounds);
    const lastEraser = eraserIndices[eraserIndices.length - 1];

    // The earliest object any later eraser subtracts from.
    let start = eraserIndices[0];
    for (let i = 0; i < start; i++) {
        const touched = eraserIndices.some((e) => e > i && boundsOverlap(bounds[i], bounds[e]));
        if (touched) {
            start = i;
            break;
        }
    }

    const runs = [];
    if (start > 0) {
        runs.push({ kind: 'vector', from: 0, to: start - 1, objects: objects.slice(0, start) });
    }
    runs.push({
        kind: 'raster', from: start, to: lastEraser, objects: objects.slice(start, lastEraser + 1),
    });
    if (lastEraser < objects.length - 1) {
        runs.push({
            kind: 'vector', from: lastEraser + 1, to: objects.length - 1,
            objects: objects.slice(lastEraser + 1),
        });
    }
    return {
        runs,
        rasterSpan: { from: start, to: lastEraser },
        wholeLayerRastered: start === 0 && lastEraser === objects.length - 1,
    };
}

/** Which objects a plan sends where, for the write-up and the gate. */
export function splitForHybrid(objects) {
    const plan = planComposition(objects);
    return {
        vector: plan.runs.filter((r) => r.kind === 'vector').flatMap((r) => r.objects),
        raster: plan.runs.filter((r) => r.kind === 'raster').flatMap((r) => r.objects),
        runs: plan.runs.map((r) => ({ kind: r.kind, ids: r.objects.map((o) => o.id) })),
        wholeLayerRastered: plan.wholeLayerRastered,
    };
}

/**
 * What candidate B cannot express.
 *
 * Returned rather than worked around: a save that silently drops a mark is the
 * one outcome worse than a save that refuses.
 */
export function unsupportedForVector(objects) {
    const reasons = [];
    for (const obj of objects) {
        if (obj.type === 'stroke' && obj.isEraser) {
            reasons.push({
                id: obj.id,
                reason: 'a pixel eraser subtracts from ink already drawn, and a content stream cannot un-draw',
            });
        }
    }
    return reasons;
}

// ---------------------------------------------------------------------------
// Source support boundary
// ---------------------------------------------------------------------------

/**
 * Whether a source document may be saved at all.
 *
 * Preserving the source is the non-negotiable half of M3, and there are files
 * that cannot be honoured. A signature is the sharp case: every candidate here
 * re-serialises the document, which invalidates any signature over it. Writing
 * that file and reporting success is the worst kind of preservation failure --
 * the document still looks signed and is not.
 *
 * These are refused before anything is written, by name.
 */
export async function assessSource(PDFDocument, bytes) {
    const problems = [];
    let doc = null;
    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
    } catch (error) {
        const message = String(error?.message ?? error);
        problems.push(/encrypt/i.test(message)
            ? { code: 'encrypted', message: 'パスワード保護されたPDFは、現在この方式では保存できません。' }
            : { code: 'unreadable', message: `このPDFを読み取れませんでした: ${message}` });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    if (doc.isEncrypted) {
        problems.push({
            code: 'encrypted',
            message: 'パスワード保護されたPDFは、現在この方式では保存できません。',
        });
    }

    // Loading is not the same as being usable. A file whose cross-reference
    // region is damaged can parse far enough for `load` to return and then
    // fail somewhere in the middle of a save, which is the worst place to find
    // out: half the pages are written and the error names an internal
    // property. So every page is opened and measured here, before anything is
    // produced, and a failure becomes a refusal with a reason.
    try {
        const pages = doc.getPages();
        if (pages.length === 0) throw new Error('この文書にはページがありません。');
        for (const page of pages) {
            const media = page.getMediaBox();
            page.getCropBox();
            page.getRotation();
            if (!(media.width > 0 && media.height > 0)) {
                throw new Error('ページサイズを読み取れませんでした。');
            }
        }
    } catch (error) {
        problems.push({
            code: 'unreadable',
            message: `このPDFの内容を読み取れませんでした: ${String(error?.message ?? error)}`,
        });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    // A signature lives in the AcroForm as a field whose /FT is /Sig.
    const signatureFields = [];
    try {
        for (const field of doc.getForm().getFields()) {
            if (/Signature/i.test(field.constructor.name)) signatureFields.push(field.getName());
        }
    } catch { /* a form we cannot read is not evidence of a signature */ }

    if (signatureFields.length > 0) {
        problems.push({
            code: 'signed',
            message: '電子署名付きPDFは、保存すると署名が無効になるため、現在は処理できません。',
        });
    }

    return { supported: problems.length === 0, problems, signatureFields, doc };
}

/** Throw unless the source is one this design will write. */
async function requireSupported(PDFDocument, bytes) {
    const verdict = await assessSource(PDFDocument, bytes);
    if (!verdict.supported) {
        const error = new Error(verdict.problems[0].message);
        error.problems = verdict.problems;
        throw error;
    }
    return verdict.doc;
}

// ---------------------------------------------------------------------------
// Candidate 0 -- whole-page raster
// ---------------------------------------------------------------------------

/**
 * What the app does today.
 *
 * `PdfViewer.tsx:196-243`: every `.pdf-page-container` in the DOM is captured
 * with html2canvas at scale 2, encoded as JPEG at 0.85, and added to a fresh
 * jsPDF whose page size is the *pixel* dimensions of that capture. The source
 * document is not opened by the writer at all.
 *
 * Reproduced without html2canvas -- pdf.js renders the page and the annotation
 * layer is composited over it from its own canvas, as the app stacks the two
 * elements -- because what is being measured is what happens to a PDF once its
 * page has become a picture.
 */
export async function saveBaseline({ pdfjsDoc, jsPDF, objects, captureScale = 2 }) {
    const started = performance.now();
    const pdf = new jsPDF({ unit: 'px', hotfixes: ['px_scaling'] });
    pdf.deletePage(1);
    let maxPixels = 0;

    for (let n = 1; n <= pdfjsDoc.numPages; n++) {
        const page = await pdfjsDoc.getPage(n);
        const viewport = page.getViewport({ scale: captureScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        maxPixels = Math.max(maxPixels, canvas.width * canvas.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, viewport, intent: 'print' }).promise;

        const layer = renderOverlayCanvas(objects[n] ?? [], {
            width: viewport.width / captureScale,
            height: viewport.height / captureScale,
            scale: captureScale,
        });
        ctx.drawImage(layer, 0, 0);
        releaseCanvas(layer);

        const imgData = canvas.toDataURL('image/jpeg', 0.85);
        const w = canvas.width;
        const h = canvas.height;
        pdf.addPage([w, h], w > h ? 'l' : 'p');
        pdf.addImage(imgData, 'JPEG', 0, 0, w, h);
        releaseCanvas(canvas);
        page.cleanup();
    }

    const bytes = new Uint8Array(pdf.output('arraybuffer'));
    return { bytes, ms: Math.round(performance.now() - started), maxPixels, calls: pdfjsDoc.numPages };
}

// ---------------------------------------------------------------------------
// Shared page mapping
// ---------------------------------------------------------------------------

/**
 * How a stored coordinate reaches the page, for one pdf-lib page.
 *
 * Both steps live here so that no candidate can quietly skip one. The rotation
 * comes off first, because the stored value is in the rotated frame the user
 * was looking at; the crop origin goes on last, because a viewer shows the
 * CropBox and a page cropped away from (0,0) shows its content offset by that
 * much.
 */
function pageMapper(pdfLibPage) {
    const crop = pdfLibPage.getCropBox();
    const media = pdfLibPage.getMediaBox();
    const box = crop.width > 0 && crop.height > 0 ? crop : media;
    const rotate = pdfLibPage.getRotation().angle;
    const geom = pageGeometry({ mediaBox: media, cropBox: box, rotate });

    const toPdf = (point) => uprightToPdf(
        displayToUpright(point, geom.rotate, geom.displayWidth, geom.displayHeight),
        box,
    );
    return { box, geom, toPdf, anchor: { x: box.x, y: box.y + box.height } };
}

/**
 * Draw an image that is in display orientation onto an unrotated page.
 *
 * pdf-lib places an image by its bottom-left corner and rotates it about that
 * corner, so two things are needed: which display corner becomes the image's
 * bottom-left, and by how much to turn it.
 *
 * Both fall out of the page mapping rather than being special-cased. An image
 * in display orientation has its local +x along display +x and its local +y up
 * the screen, i.e. against display +y. So its bottom-left corner is the display
 * rectangle's *bottom-left* -- `(ax, ay + ah)` in a y-down space -- and its
 * rotation is whatever turns PDF +x into display +x, which is the page's own
 * `/Rotate`.
 *
 * The first version of this wrote out a formula per quadrant with the rotation
 * negated, and it was wrong at 90 and 270: a mark placed 60 points from the
 * corner came back 863 points away on one quadrant and off the page entirely on
 * another. It survived review because the fragment it was tested with was
 * nearly square, and a square hides a swapped width and height. Deriving it
 * from the mapping removes both the special cases and the opportunity.
 */
function placeDisplayImage(page, image, map, degrees, rect = null) {
    const { geom, toPdf } = map;
    const area = rect ?? { x: 0, y: 0, width: geom.displayWidth, height: geom.displayHeight };
    const bottomLeft = toPdf({ x: area.x, y: area.y + area.height });
    return page.drawImage(image, {
        x: bottomLeft.x,
        y: bottomLeft.y,
        width: area.width,
        height: area.height,
        rotate: degrees(geom.rotate),
    });
}

// ---------------------------------------------------------------------------
// Candidate A -- transparent overlay
// ---------------------------------------------------------------------------

/**
 * The original PDF, with a transparent annotation image over it.
 *
 * The source document is loaded and kept: pages, text, vector content, images,
 * annotations and form are whatever they already were. Only the annotation
 * layer is rasterised, and only where a page has annotations.
 */
export async function saveOverlay({
    PDFDocument, degrees, sourceBytes, objects, overlayScale = 2, skipEmptyPages = true,
}) {
    const started = performance.now();
    const doc = await requireSupported(PDFDocument, sourceBytes);
    const pages = doc.getPages();
    let maxPixels = 0;
    let overlays = 0;

    for (let i = 0; i < pages.length; i++) {
        const list = objects[i + 1] ?? [];
        if (skipEmptyPages && list.length === 0) continue;

        const page = pages[i];
        const map = pageMapper(page);
        const canvas = renderOverlayCanvas(list, {
            width: map.geom.displayWidth, height: map.geom.displayHeight, scale: overlayScale,
        });
        maxPixels = Math.max(maxPixels, canvas.width * canvas.height);

        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const buf = new Uint8Array(await png.arrayBuffer());
        releaseCanvas(canvas);

        const embedded = await doc.embedPng(buf);
        placeDisplayImage(page, embedded, map, degrees);
        overlays += 1;
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, ms: Math.round(performance.now() - started), maxPixels, overlays };
}

// ---------------------------------------------------------------------------
// Vector writing
// ---------------------------------------------------------------------------

/** Write one object as drawing operators onto a pdf-lib page. */
function drawObjectVector(page, obj, map, { font, rgb }) {
    const { toPdf } = map;

    if (obj.type === 'stroke') {
        if (obj.points.length < 2) return 0;
        const colour = hexToRgb(obj.color);
        let ops = 0;
        for (let i = 0; i < obj.points.length - 1; i++) {
            page.drawLine({
                start: toPdf(obj.points[i]),
                end: toPdf(obj.points[i + 1]),
                thickness: segmentWidth(obj, i),
                color: rgb(colour.r, colour.g, colour.b),
                opacity: obj.opacity ?? 1,
                lineCap: 1,
            });
            ops += 1;
        }
        return ops;
    }

    if (obj.type === 'text') {
        const colour = hexToRgb(obj.color);
        // The stored y is the *top* of the glyph box (`textBaseline = 'top'`)
        // and a PDF text object is placed on its baseline, so the ascent has to
        // be added before the flip. Without it every annotation sits a line
        // high -- and the difference would be blamed on the substituted font.
        const ascent = font.heightAtSize(obj.fontSize, { descender: false });
        const at = toPdf({ x: obj.x, y: obj.y + ascent });
        page.drawText(obj.text, {
            x: at.x, y: at.y, size: obj.fontSize, font,
            color: rgb(colour.r, colour.g, colour.b),
            opacity: obj.opacity ?? 1,
        });
        return 1;
    }

    if (obj.type === 'measure') {
        const p = obj.points;
        if (p.length < 2) return 0;
        const colour = hexToRgb(obj.color);
        const stroke = rgb(colour.r, colour.g, colour.b);
        let ops = 0;

        if (obj.subtype === 'area' && p.length >= 3) {
            const closed = [...p, p[0]];
            for (let i = 0; i < closed.length - 1; i++) {
                page.drawLine({
                    start: toPdf(closed[i]), end: toPdf(closed[i + 1]),
                    thickness: MEASURE_LINE_WIDTH, color: stroke, lineCap: 1,
                });
                ops += 1;
            }
            // drawSvgPath reads its path in SVG convention -- y downwards from
            // the anchor -- so the points go in as *upright* coordinates and
            // the anchor is the top-left of the visible page box. Handing it
            // points that were already flipped applies the flip twice.
            const upright = p.map((q) => displayToUpright(
                q, map.geom.rotate, map.geom.displayWidth, map.geom.displayHeight,
            ));
            const d = `M ${upright.map((q) => `${q.x} ${q.y}`).join(' L ')} Z`;
            page.drawSvgPath(d, {
                color: stroke,
                opacity: MEASURE_FILL_ALPHA,
                borderWidth: 0,
                x: map.anchor.x,
                y: map.anchor.y,
                scale: 1,
            });
            ops += 1;
        } else {
            for (let i = 0; i < p.length - 1; i++) {
                page.drawLine({
                    start: toPdf(p[i]), end: toPdf(p[i + 1]),
                    thickness: MEASURE_LINE_WIDTH, color: stroke, lineCap: 1,
                });
                ops += 1;
            }
        }

        if (measureHasVertices(obj)) {
            for (const q of p) {
                const at = toPdf(q);
                page.drawCircle({ x: at.x, y: at.y, size: MEASURE_VERTEX_RADIUS, color: stroke });
                ops += 1;
            }
        }

        for (const label of measureLabels(obj)) {
            const width = font.widthOfTextAtSize(label.text, label.size);
            const box = labelBox(label, width);
            if (box) {
                const a = toPdf({ x: box.x, y: box.y });
                const b = toPdf({ x: box.x + box.width, y: box.y + box.height });
                page.drawRectangle({
                    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                    width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
                    color: rgb(1, 1, 1),
                    opacity: label.bold ? 0.9 : 0.8,
                });
                ops += 1;
            }
            // A bottom baseline puts the text's baseline at label.y.
            const left = label.align === 'left' ? label.x : label.x - width / 2;
            const at = toPdf({ x: left, y: label.y });
            const lc = hexToRgb(label.colour ?? obj.color);
            page.drawText(label.text, {
                x: at.x, y: at.y, size: label.size, font,
                color: rgb(lc.r, lc.g, lc.b),
            });
            ops += 1;
        }
        return ops;
    }
    return 0;
}

/**
 * Candidate B -- the original PDF, with the annotations as operators.
 *
 * Refuses rather than approximates. If a page carries anything this cannot
 * express, the whole save fails with the reasons, because a partial success
 * that quietly drops a mark is indistinguishable from a complete one.
 */
export async function saveVector({
    PDFDocument, rgb, sourceBytes, objects, fontBytes, fontkit,
}) {
    const started = performance.now();
    const doc = await requireSupported(PDFDocument, sourceBytes);
    doc.registerFontkit(fontkit);
    // The app's fontFamily is a CSS family name and cannot be resolved to a
    // file; a document font is embedded instead, and the substitution is
    // reported rather than presented as the user's choice.
    const font = await doc.embedFont(fontBytes, { subset: true });
    const pages = doc.getPages();

    const refused = [];
    for (let i = 0; i < pages.length; i++) {
        for (const r of unsupportedForVector(objects[i + 1] ?? [])) {
            refused.push({ page: i + 1, ...r });
        }
    }
    if (refused.length > 0) {
        const error = new Error('この保存方式では表現できない注釈があります。');
        error.refused = refused;
        throw error;
    }

    let ops = 0;
    for (let i = 0; i < pages.length; i++) {
        const list = objects[i + 1] ?? [];
        if (list.length === 0) continue;
        const map = pageMapper(pages[i]);
        for (const obj of list) ops += drawObjectVector(pages[i], obj, map, { font, rgb });
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, ms: Math.round(performance.now() - started), ops, maxPixels: 0, fontSubstituted: true };
}

/**
 * Candidate C -- runs, in painter order.
 *
 * Operators where they work; one transparent fragment for the span an eraser
 * reaches into; emitted in the order the canvas would have drawn them.
 */
export async function saveHybrid({
    PDFDocument, rgb, degrees, sourceBytes, objects, fontBytes, fontkit,
    overlayScale = 2, pad = 4,
}) {
    const started = performance.now();
    const doc = await requireSupported(PDFDocument, sourceBytes);
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    const pages = doc.getPages();

    let ops = 0;
    let maxPixels = 0;
    let fragments = 0;
    let wholeLayerPages = 0;

    for (let i = 0; i < pages.length; i++) {
        const list = objects[i + 1] ?? [];
        if (list.length === 0) continue;
        const page = pages[i];
        const map = pageMapper(page);
        const plan = planComposition(list);
        if (plan.wholeLayerRastered) wholeLayerPages += 1;

        for (const run of plan.runs) {
            if (run.kind === 'vector') {
                for (const obj of run.objects) ops += drawObjectVector(page, obj, map, { font, rgb });
                continue;
            }

            const bounds = runBounds(run.objects, pad);
            if (!bounds) continue;
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil(bounds.width * overlayScale));
            canvas.height = Math.max(1, Math.ceil(bounds.height * overlayScale));
            maxPixels = Math.max(maxPixels, canvas.width * canvas.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            renderAnnotations(ctx, run.objects, {
                scale: overlayScale, offset: { x: bounds.x, y: bounds.y },
            });

            const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            const buf = new Uint8Array(await png.arrayBuffer());
            releaseCanvas(canvas);
            const embedded = await doc.embedPng(buf);
            placeDisplayImage(page, embedded, map, degrees, bounds);
            fragments += 1;
        }
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return {
        bytes, ms: Math.round(performance.now() - started),
        ops, maxPixels, fragments, wholeLayerPages, fontSubstituted: true,
    };
}

function runBounds(objects, pad) {
    const boxes = objects.map(paintedBounds).filter(Boolean);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.minX)) - pad;
    const minY = Math.min(...boxes.map((b) => b.minY)) - pad;
    const maxX = Math.max(...boxes.map((b) => b.maxX)) + pad;
    const maxY = Math.max(...boxes.map((b) => b.maxY)) + pad;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
