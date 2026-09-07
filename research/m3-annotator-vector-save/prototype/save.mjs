/**
 * Four ways to save an annotated page, so they can be measured against each
 * other rather than argued about.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 *   candidate 0  whole-page raster -- what the app does today. The page and the
 *                annotations are composited into one picture and a brand-new
 *                PDF is built around it. Control, not a proposal.
 *   candidate A  the original PDF, with the annotation layer alone laid over it
 *                as a transparent image.
 *   candidate B  the original PDF, with the annotations written as drawing
 *                operators.
 *   candidate C  the original PDF, annotations as operators, and a transparent
 *                raster only for the marks that cannot be expressed as
 *                operators.
 *
 * A and C exist because of one thing the app does that PDF has no operator for.
 * The pixel eraser is not a deletion: it is an object replayed with
 * `destination-out`, subtracting from whatever was drawn before it
 * (`DrawingCanvas.tsx:223-229`). A content stream cannot un-draw. Any candidate
 * that writes operators has to either work out the geometric difference, refuse
 * the stroke, or fall back to pixels for the part of the layer it touches.
 *
 * What none of them do is change the source page's own content. The eraser
 * erases annotation ink; it is not redaction and this code never treats it as
 * such.
 */

import {
    MEASURE_FILL_ALPHA, MEASURE_LINE_WIDTH, hexToRgb, measureLabels, segmentWidth,
} from './model.mjs';
import { uprightToPdf } from './coords.mjs';

/**
 * Draw the annotation objects, the way the app draws them.
 *
 * Deliberately a copy of `DrawingCanvas.tsx:178-375` rather than a tidy-up: the
 * point is to produce the pixels the user is looking at, including the parts
 * that are accidents of the current implementation. Where it differs, the
 * fidelity numbers would be measuring this file instead of the app.
 */
export function renderAnnotations(ctx, objects, { scale = 1, offset = { x: 0, y: 0 } } = {}) {
    ctx.save();
    // setTransform *replaces* the transform, so an offset a caller applied with
    // translate() beforehand would be discarded here. The fragment renderer
    // needs one, so it is folded into the same call rather than left to be
    // silently thrown away -- which is exactly what happened the first time.
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
            ctx.fillStyle = obj.color;
            ctx.font = `${obj.fontSize}px ${obj.fontFamily}`;
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(obj.text, obj.x, obj.y);
        } else if (obj.type === 'measure') {
            const p = obj.points;
            if (p.length < 2) continue;
            ctx.strokeStyle = obj.color;
            ctx.lineWidth = MEASURE_LINE_WIDTH;

            if (obj.subtype === 'area') {
                ctx.fillStyle = `${obj.color}4d`;
                ctx.beginPath();
                ctx.moveTo(p[0].x, p[0].y);
                for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(p[0].x, p[0].y);
                for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
                ctx.stroke();
            }

            ctx.fillStyle = obj.color;
            ctx.font = '12px sans-serif';
            for (const label of measureLabels(obj)) {
                const w = ctx.measureText(label.text).width;
                ctx.save();
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.fillRect(label.x - w / 2 - 2, label.y - 12, w + 4, 15);
                ctx.restore();
                ctx.fillStyle = obj.color;
                ctx.fillText(label.text, label.x - w / 2, label.y);
            }
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

/**
 * Candidate 0 -- whole-page raster, as the app does it today.
 *
 * `PdfViewer.tsx:196-243`: every `.pdf-page-container` in the DOM is captured
 * with html2canvas at scale 2, encoded as JPEG at 0.85, and added to a fresh
 * jsPDF whose page size is the *pixel* dimensions of that capture. The source
 * document is not opened by the writer at all.
 *
 * Reproduced here without html2canvas -- the page is rendered by pdf.js and the
 * annotations composited on top -- because html2canvas's job is to turn a DOM
 * into a picture, and what is being measured is what happens to a PDF once its
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
        // The annotations are composited from their own canvas, not drawn
        // straight onto the page. That is what the app does -- the annotation
        // layer is a separate element stacked over the PDF one -- and it is
        // the difference between a pixel eraser removing annotation ink and a
        // pixel eraser removing the drawing underneath it. Drawing both into
        // one canvas makes `destination-out` eat the page, which the app never
        // does and this baseline must not appear to do either.
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

/** The page box a viewer shows, and how a mark maps onto it. */
function pageBox(pdfLibPage) {
    const crop = pdfLibPage.getCropBox();
    const media = pdfLibPage.getMediaBox();
    // A CropBox of zero area is not a crop, it is a broken file; fall back
    // rather than divide the page by nothing.
    return crop.width > 0 && crop.height > 0 ? crop : media;
}

/**
 * Candidate A -- the original PDF, with a transparent annotation image over it.
 *
 * The source document is loaded and kept: its pages, text, vector content,
 * images, annotations and form are whatever they already were. Only the
 * annotation layer is rasterised, and only where a page has annotations.
 *
 * `overlayScale` is pixels per point. It decides the only real cost here, and
 * unlike the baseline it is a property of the annotation layer rather than of
 * the whole sheet.
 */
export async function saveOverlay({
    PDFDocument, sourceBytes, objects, overlayScale = 2, skipEmptyPages = true,
}) {
    const started = performance.now();
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const pages = doc.getPages();
    let maxPixels = 0;
    let overlays = 0;

    for (let i = 0; i < pages.length; i++) {
        const list = objects[i + 1] ?? [];
        if (skipEmptyPages && list.length === 0) continue;

        const page = pages[i];
        const box = pageBox(page);
        const canvas = renderOverlayCanvas(list, {
            width: box.width, height: box.height, scale: overlayScale,
        });
        maxPixels = Math.max(maxPixels, canvas.width * canvas.height);

        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const buf = new Uint8Array(await png.arrayBuffer());
        releaseCanvas(canvas);

        const embedded = await doc.embedPng(buf);
        // Drawn at the crop box's own origin, so a page whose visible area does
        // not start at (0,0) still gets its marks where the user put them.
        page.drawImage(embedded, {
            x: box.x, y: box.y, width: box.width, height: box.height,
        });
        overlays += 1;
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, ms: Math.round(performance.now() - started), maxPixels, overlays };
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

/**
 * Write one object as drawing operators onto a pdf-lib page.
 *
 * `toPdf` maps a stored point (upright, y down) into the page's user space.
 */
function drawObjectVector(page, obj, toPdf, { font, rgb, degrees, anchor }) {
    void degrees;
    if (obj.type === 'stroke') {
        if (obj.points.length < 2) return 0;
        const colour = hexToRgb(obj.color);
        let ops = 0;
        if (!obj.enablePressure) {
            // One polyline: pdf-lib has no polyline primitive, so it is a run
            // of line segments sharing a width. Round caps and joins match the
            // canvas renderer's lineCap/lineJoin.
            for (let i = 0; i < obj.points.length - 1; i++) {
                const a = toPdf(obj.points[i]);
                const b = toPdf(obj.points[i + 1]);
                page.drawLine({
                    start: a, end: b,
                    thickness: obj.lineWidth,
                    color: rgb(colour.r, colour.g, colour.b),
                    opacity: obj.opacity ?? 1,
                    lineCap: 1,
                });
                ops += 1;
            }
        } else {
            // A pressure stroke is already a run of differently-sized segments
            // in the app, so it is the same run here -- one operator per pair.
            for (let i = 0; i < obj.points.length - 1; i++) {
                const a = toPdf(obj.points[i]);
                const b = toPdf(obj.points[i + 1]);
                page.drawLine({
                    start: a, end: b,
                    thickness: segmentWidth(obj, i),
                    color: rgb(colour.r, colour.g, colour.b),
                    opacity: obj.opacity ?? 1,
                    lineCap: 1,
                });
                ops += 1;
            }
        }
        return ops;
    }

    if (obj.type === 'text') {
        const colour = hexToRgb(obj.color);
        // The stored y is the text baseline in a y-down space, which is already
        // what a PDF baseline is once the axis is flipped.
        const at = toPdf({ x: obj.x, y: obj.y });
        page.drawText(obj.text, {
            x: at.x, y: at.y,
            size: obj.fontSize,
            font,
            color: rgb(colour.r, colour.g, colour.b),
            opacity: obj.opacity ?? 1,
        });
        return 1;
    }

    if (obj.type === 'measure') {
        const p = obj.points;
        if (p.length < 2) return 0;
        const colour = hexToRgb(obj.color);
        let ops = 0;

        if (obj.subtype === 'area' && p.length >= 3) {
            // drawSvgPath reads its path in SVG convention -- y downwards from
            // the anchor it is given -- which is the space the points are
            // already in. So they go in unconverted and the anchor is the
            // top-left of the visible page box. Handing it points that had
            // already been flipped *and* an anchor applies the flip twice, and
            // the polygon lands somewhere else entirely.
            const d = `M ${p.map((q) => `${q.x} ${q.y}`).join(' L ')} Z`;
            page.drawSvgPath(d, {
                borderColor: rgb(colour.r, colour.g, colour.b),
                borderWidth: MEASURE_LINE_WIDTH,
                color: rgb(colour.r, colour.g, colour.b),
                opacity: MEASURE_FILL_ALPHA,
                borderOpacity: 1,
                x: anchor.x,
                y: anchor.y,
                scale: 1,
            });
            ops += 1;
        } else {
            for (let i = 0; i < p.length - 1; i++) {
                page.drawLine({
                    start: toPdf(p[i]), end: toPdf(p[i + 1]),
                    thickness: MEASURE_LINE_WIDTH,
                    color: rgb(colour.r, colour.g, colour.b),
                    lineCap: 1,
                });
                ops += 1;
            }
        }

        // The labels the app computes at draw time. Without these the lines
        // survive and the numbers do not, which looks like success.
        for (const label of measureLabels(obj)) {
            const at = toPdf({ x: label.x, y: label.y });
            const width = font.widthOfTextAtSize(label.text, 12);
            page.drawRectangle({
                x: at.x - width / 2 - 2, y: at.y - 3,
                width: width + 4, height: 15,
                color: rgb(1, 1, 1), opacity: 0.8,
            });
            page.drawText(label.text, {
                x: at.x - width / 2, y: at.y,
                size: 12, font,
                color: rgb(colour.r, colour.g, colour.b),
            });
            ops += 2;
        }
        return ops;
    }
    return 0;
}

/**
 * Candidate B -- the original PDF, with the annotations as operators.
 *
 * Refuses rather than approximates. If the page carries anything this cannot
 * express, the whole save fails with the reasons, because a partial success
 * that quietly drops a mark is indistinguishable from a complete one.
 */
export async function saveVector({
    PDFDocument, rgb, degrees, sourceBytes, objects, fontBytes, fontkit,
}) {
    const started = performance.now();
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
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
        const page = pages[i];
        const box = pageBox(page);
        const toPdf = (point) => uprightToPdf(point, box);
        // The top-left of the visible page box, in PDF space -- the anchor an
        // SVG path is measured down from.
        const anchor = { x: box.x, y: box.y + box.height };
        for (const obj of list) ops += drawObjectVector(page, obj, toPdf, { font, rgb, degrees, anchor });
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, ms: Math.round(performance.now() - started), ops, maxPixels: 0, fontSubstituted: true };
}

/**
 * Candidate C -- operators where they work, pixels only where they do not.
 *
 * The split is by cause rather than by convenience: a pixel eraser and the ink
 * it subtracts from go into one transparent fragment, and everything else is
 * written as operators. The fragment covers only the bounding box of the marks
 * involved, so the cost is a function of how much was erased rather than of the
 * sheet size.
 */
export async function saveHybrid({
    PDFDocument, rgb, degrees, sourceBytes, objects, fontBytes, fontkit,
    overlayScale = 2, pad = 4,
}) {
    const started = performance.now();
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    const pages = doc.getPages();

    let ops = 0;
    let maxPixels = 0;
    let fragments = 0;

    for (let i = 0; i < pages.length; i++) {
        const list = objects[i + 1] ?? [];
        if (list.length === 0) continue;
        const page = pages[i];
        const box = pageBox(page);
        const toPdf = (point) => uprightToPdf(point, box);

        const { vector, raster } = splitForHybrid(list);
        const anchor = { x: box.x, y: box.y + box.height };
        for (const obj of vector) ops += drawObjectVector(page, obj, toPdf, { font, rgb, degrees, anchor });

        if (raster.length > 0) {
            const bounds = boundsOf(raster, pad);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil(bounds.width * overlayScale));
            canvas.height = Math.max(1, Math.ceil(bounds.height * overlayScale));
            maxPixels = Math.max(maxPixels, canvas.width * canvas.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            renderAnnotations(ctx, raster, {
                scale: overlayScale, offset: { x: bounds.x, y: bounds.y },
            });

            const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            const buf = new Uint8Array(await png.arrayBuffer());
            releaseCanvas(canvas);
            const embedded = await doc.embedPng(buf);
            const topLeft = toPdf({ x: bounds.x, y: bounds.y });
            page.drawImage(embedded, {
                x: topLeft.x, y: topLeft.y - bounds.height,
                width: bounds.width, height: bounds.height,
            });
            fragments += 1;
        }
    }

    const bytes = await doc.save({ useObjectStreams: false });
    return {
        bytes, ms: Math.round(performance.now() - started),
        ops, maxPixels, fragments, fontSubstituted: true,
    };
}

/**
 * Which objects have to be pixels, and which can be operators.
 *
 * An eraser takes with it everything drawn before it that it overlaps -- those
 * marks are only correct in combination with the subtraction, so writing them
 * as operators would put back ink the user removed.
 */
export function splitForHybrid(objects) {
    const erasers = objects.filter((o) => o.type === 'stroke' && o.isEraser);
    if (erasers.length === 0) return { vector: objects, raster: [] };

    const affected = new Set();
    objects.forEach((obj, index) => {
        if (obj.type === 'stroke' && obj.isEraser) {
            affected.add(index);
            return;
        }
        const earlier = erasers.some((e) => objects.indexOf(e) > index && overlaps(obj, e));
        if (earlier) affected.add(index);
    });

    return {
        vector: objects.filter((_, i) => !affected.has(i)),
        // Order is preserved so the subtraction still happens after the ink.
        raster: objects.filter((_, i) => affected.has(i)),
    };
}

function extentOf(obj) {
    if (obj.type === 'text') {
        return {
            minX: obj.x, minY: obj.y - obj.fontSize,
            maxX: obj.x + obj.fontSize * obj.text.length, maxY: obj.y + obj.fontSize * 0.3,
        };
    }
    const xs = obj.points.map((p) => p.x);
    const ys = obj.points.map((p) => p.y);
    const half = (obj.lineWidth ?? MEASURE_LINE_WIDTH) / 2;
    return {
        minX: Math.min(...xs) - half, minY: Math.min(...ys) - half,
        maxX: Math.max(...xs) + half, maxY: Math.max(...ys) + half,
    };
}

function overlaps(a, b) {
    const ea = extentOf(a);
    const eb = extentOf(b);
    return !(ea.maxX < eb.minX || ea.minX > eb.maxX || ea.maxY < eb.minY || ea.minY > eb.maxY);
}

function boundsOf(objects, pad) {
    const extents = objects.map(extentOf);
    const minX = Math.min(...extents.map((e) => e.minX)) - pad;
    const minY = Math.min(...extents.map((e) => e.minY)) - pad;
    const maxX = Math.max(...extents.map((e) => e.maxX)) + pad;
    const maxY = Math.max(...extents.map((e) => e.maxY)) + pad;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
