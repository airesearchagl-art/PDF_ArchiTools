/**
 * Where the translucent layer sits relative to annotations — H13b.
 *
 * Production draws its rectangle into the page content stream. Annotations
 * are painted after the page content, so every annotation appearance sits
 * *above* that layer, unfaded (measured by the gate).
 *
 * "Layer above annotations" has exactly two ways to exist:
 *
 *   - flatten each annotation's appearance into the content stream and draw
 *     the layer over it — which removes the annotations as annotations, i.e.
 *     a flattening transform;
 *   - add the layer as one more annotation, last in /Annots, so it is painted
 *     after the others. Nothing is flattened and no existing annotation is
 *     rewritten; the layer itself becomes an annotation (selectable and
 *     deletable in an editor, printed only because /F says Print).
 *
 * This module is the second, so it can be measured.
 *
 * Research code. Not part of the app.
 */
import { PDFDocument, PDFName, PDFArray, PDFNumber } from 'pdf-lib';

const hex = (h) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 1, 1];
};

export async function layerAboveAnnotations(sourceBytes, { color, opacity }) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const [r, g, b] = hex(color);
    for (const page of doc.getPages()) {
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const x0 = Math.max(media.x, crop.x);
        const y0 = Math.max(media.y, crop.y);
        const x1 = Math.min(media.x + media.width, crop.x + crop.width);
        const y1 = Math.min(media.y + media.height, crop.y + crop.height);
        const w = x1 - x0;
        const h = y1 - y0;
        const ap = doc.context.register(doc.context.stream(
            `q /GS0 gs ${r} ${g} ${b} rg 0 0 ${w} ${h} re f Q`, {
                Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h],
                Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: opacity, CA: opacity } } },
            },
        ));
        const annot = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Square', Rect: [x0, y0, x1, y1],
            IC: [r, g, b], CA: PDFNumber.of(opacity), BS: { W: 0 },
            F: 4 | 128, // Print, Locked
            NM: 'm5-layer-overlay', AP: { N: ap },
        }));
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots instanceof PDFArray) annots.push(annot);
        else page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    }
    return doc.save();
}
