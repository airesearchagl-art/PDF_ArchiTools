/**
 * Writing the annotations onto the source document.
 *
 * The source is loaded and preserved; nothing here rasterises a page, and
 * nothing rewrites a page that has no annotations.
 */
import type { PDFPage, PDFFont, PDFDocument } from 'pdf-lib';
import { rgb, degrees } from 'pdf-lib';
import type { Point, Box, PageGeometry } from './coords';
import { pageGeometry, displayToUpright, uprightToPdf } from './coords';
import type { SaveAnnotation } from './types';
import { parseColour, areaFillColour, MEASURE_FILL_ALPHA } from './colour';
import {
    MEASURE_LINE_WIDTH, MEASURE_VERTEX_RADIUS, measureHasVertices,
    measureLabels, labelBox, labelBoxAlpha, segmentWidth,
} from './measure-model';

export interface PageMapper {
    box: Box;
    geom: PageGeometry;
    toPdf(point: Point): Point;
    anchor: Point;
}

/**
 * How a stored coordinate reaches the page, for one pdf-lib page.
 *
 * Both steps live here so no caller can quietly skip one. The rotation comes
 * off first, because the stored value is in the rotated frame the user was
 * looking at; the crop origin goes on last, because a viewer shows the CropBox
 * and a page cropped away from (0,0) shows its content offset by that much.
 *
 * `page.getSize()` is not used: pdf-lib reports the **MediaBox** there even when
 * the CropBox is smaller, and mapping with it misplaces every mark on a cropped
 * page — measured at (−40, +40) and (−60, +30) points.
 */
export function pageMapper(page: PDFPage): PageMapper {
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    const box = crop.width > 0 && crop.height > 0 ? crop : media;
    const geom = pageGeometry({ mediaBox: media, cropBox: box, rotate: page.getRotation().angle });

    return {
        box,
        geom,
        toPdf: (point: Point) => uprightToPdf(
            displayToUpright(point, geom.rotate, geom.displayWidth, geom.displayHeight),
            box,
        ),
        anchor: { x: box.x, y: box.y + box.height },
    };
}

/**
 * Draw an image that is in display orientation onto an unrotated page.
 *
 * pdf-lib places an image by its bottom-left corner and rotates it about that
 * corner, so two things are needed: which display corner becomes the image's
 * bottom-left, and by how much to turn it.
 *
 * Both fall out of the page mapping rather than being special-cased. An image in
 * display orientation has its local +x along display +x and its local +y up the
 * screen, i.e. against display +y. So its bottom-left corner is the display
 * rectangle's *bottom-left* — `(x, y + height)` in a y-down space — and its
 * rotation is whatever turns PDF +x into display +x, which is the page's own
 * `/Rotate`.
 *
 * Writing a formula per quadrant instead gets this wrong at 90 and 270: a mark
 * placed 60 points from the corner came back 863 points away on one quadrant and
 * off the page entirely on another, and a nearly-square test fragment hid it,
 * because a square hides a swapped width and height.
 */
export function placeDisplayImage(
    page: PDFPage,
    image: Parameters<PDFPage['drawImage']>[0],
    map: PageMapper,
    rect: { x: number; y: number; width: number; height: number },
): void {
    const bottomLeft = map.toPdf({ x: rect.x, y: rect.y + rect.height });
    page.drawImage(image, {
        x: bottomLeft.x,
        y: bottomLeft.y,
        width: rect.width,
        height: rect.height,
        rotate: degrees(map.geom.rotate),
    });
}

/** Write one object as drawing operators. Returns how many it emitted. */
export function drawObjectVector(
    page: PDFPage, obj: SaveAnnotation, map: PageMapper, font: PDFFont,
): number {
    const { toPdf } = map;

    if (obj.type === 'stroke') {
        if (obj.points.length < 2) return 0;
        const c = parseColour(obj.color);
        let ops = 0;
        for (let i = 0; i < obj.points.length - 1; i++) {
            page.drawLine({
                start: toPdf(obj.points[i]),
                end: toPdf(obj.points[i + 1]),
                thickness: segmentWidth(obj, i),
                color: rgb(c.r, c.g, c.b),
                opacity: obj.opacity ?? 1,
                lineCap: 1,
            });
            ops += 1;
        }
        return ops;
    }

    if (obj.type === 'text') {
        const c = parseColour(obj.color);
        // The stored y is the *top* of the glyph box (`textBaseline = 'top'`)
        // and a PDF text object is placed on its baseline, so the ascent has to
        // be added before the flip. Without it every annotation sits a line
        // high — and the difference would be blamed on the substituted font.
        const ascent = font.heightAtSize(obj.fontSize, { descender: false });
        const at = toPdf({ x: obj.x, y: obj.y + ascent });
        page.drawText(obj.text, {
            x: at.x,
            y: at.y,
            size: obj.fontSize,
            font,
            color: rgb(c.r, c.g, c.b),
            opacity: obj.opacity ?? 1,
            // The anchor is not enough. A stroke is written as endpoints, each
            // mapped on its own, so it comes out right whatever the page
            // rotation is. Text is an anchor plus a basis, and only the anchor
            // was being mapped -- so on a rotated page the annotation landed in
            // the right place lying on its side. Measured at /Rotate 90, 180
            // and 270: 90, 180 and -90 degrees off.
            //
            // The page's own /Rotate is what turns PDF +x into display +x, so
            // it is also what turns text written in user space into text that
            // reads horizontally on screen -- the same value, and for the same
            // reason, as the one `placeDisplayImage` gives a fragment.
            rotate: degrees(map.geom.rotate),
        });
        return 1;
    }

    const p = obj.points;
    if (p.length < 2) return 0;
    const c = parseColour(obj.color);
    const stroke = rgb(c.r, c.g, c.b);
    let ops = 0;

    if (obj.subtype === 'area' && p.length >= 3) {
        const closed = [...p, p[0]];
        for (let i = 0; i < closed.length - 1; i++) {
            page.drawLine({
                start: toPdf(closed[i]),
                end: toPdf(closed[i + 1]),
                thickness: MEASURE_LINE_WIDTH,
                color: stroke,
                lineCap: 1,
            });
            ops += 1;
        }
        // drawSvgPath reads its path in SVG convention — y downwards from the
        // anchor — so the points go in as *upright* coordinates and the anchor
        // is the top-left of the visible page box. Handing it points that were
        // already flipped applies the flip twice.
        const upright = p.map((q) => displayToUpright(
            q, map.geom.rotate, map.geom.displayWidth, map.geom.displayHeight,
        ));
        const fill = areaFillColour(obj.color);
        page.drawSvgPath(`M ${upright.map((q) => `${q.x} ${q.y}`).join(' L ')} Z`, {
            color: rgb(fill.r, fill.g, fill.b),
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
                start: toPdf(p[i]),
                end: toPdf(p[i + 1]),
                thickness: MEASURE_LINE_WIDTH,
                color: stroke,
                lineCap: 1,
            });
            ops += 1;
        }
    }

    if (measureHasVertices(obj)) {
        for (const q of p) {
            const at = toPdf(q);
            page.drawCircle({
                x: at.x, y: at.y, size: MEASURE_VERTEX_RADIUS, color: stroke,
            });
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
                x: Math.min(a.x, b.x),
                y: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x),
                height: Math.abs(b.y - a.y),
                color: rgb(1, 1, 1),
                opacity: labelBoxAlpha(label),
            });
            ops += 1;
        }
        // A bottom baseline puts the text's baseline at label.y.
        const left = label.align === 'left' ? label.x : label.x - width / 2;
        const at = toPdf({ x: left, y: label.y });
        const lc = parseColour(label.colour ?? obj.color);
        // Same as above: a measurement's labels are text and need the basis
        // turned, not just the anchor placed.
        page.drawText(label.text, {
            x: at.x, y: at.y, size: label.size, font, color: rgb(lc.r, lc.g, lc.b),
            rotate: degrees(map.geom.rotate),
        });
        ops += 1;
    }
    return ops;
}

/** Embed a PNG the fragment renderer produced. */
export async function embedFragment(
    doc: PDFDocument, canvas: HTMLCanvasElement,
): Promise<Parameters<PDFPage['drawImage']>[0]> {
    const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) throw new Error('注釈の画像化に失敗しました。');
    return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}
