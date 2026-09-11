/**
 * Margin by transforming the page in place — the candidate alternative.
 *
 * Production builds a *new* document and draws each source page into it as a
 * Form XObject (`embedPage`). The drawing survives as operators; the page does
 * not: annotations, links, form widgets, the AcroForm, metadata and /Rotate
 * all stay behind in the document that is thrown away.
 *
 * This candidate keeps the source document and changes only what a margin
 * means: the page's content is wrapped in one `cm` that scales it towards the
 * chosen corner of the *visible* page, a clip keeps whatever the CropBox hid
 * hidden, and every annotation coordinate is carried through the same
 * transform. Page boxes, /Rotate, resources, the AcroForm, the XFA packet and
 * the Info/XMP metadata are untouched because nothing touches them.
 *
 * Refused rather than guessed:
 *   - content whose q/Q nesting underflows (the wrapper could be popped early);
 *   - an annotation this prototype does not know how to move;
 *   - an annotation outside the visible page that the scale would bring in.
 *
 * Research code. Not part of the app, and not a claim of readiness.
 */
import {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream,
    decodePDFRawStream,
} from 'pdf-lib';
import { lex } from './mono-structure.mjs';

const MOVABLE = new Set([
    'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
    'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink',
    'Popup', 'FileAttachment', 'Widget',
]);
const POINT_ARRAYS = ['QuadPoints', 'Vertices', 'L', 'CL'];
const HIDDEN = 2;

function resolve(doc, v) { return v instanceof PDFRef ? doc.context.lookup(v) : v; }

/** The user-space corner shown at a visual corner, for each /Rotate. */
function userCorner(position, rotate, [x0, y0, x1, y1]) {
    const corners = {
        0: { tl: [x0, y1], tr: [x1, y1], bl: [x0, y0], br: [x1, y0] },
        90: { tl: [x0, y0], tr: [x0, y1], br: [x1, y1], bl: [x1, y0] },
        180: { tl: [x1, y0], tr: [x0, y0], br: [x0, y1], bl: [x1, y1] },
        270: { tl: [x1, y1], tr: [x1, y0], br: [x0, y0], bl: [x0, y1] },
    };
    return corners[rotate][position];
}

/** The transform, in the page's own user space, that makes the margin. */
export function marginTransform(visible, rotate, scale, position) {
    const [x0, y0, x1, y1] = visible;
    const w = x1 - x0;
    const h = y1 - y0;
    let X0;
    let Y0;
    if (position === 'center') {
        X0 = x0 + (w - w * scale) / 2;
        Y0 = y0 + (h - h * scale) / 2;
    } else {
        const [ux, uy] = userCorner(position, rotate, visible);
        X0 = ux === x0 ? x0 : x1 - w * scale;
        Y0 = uy === y0 ? y0 : y1 - h * scale;
    }
    return {
        matrix: [scale, 0, 0, scale, X0 - scale * x0, Y0 - scale * y0],
        target: [X0, Y0, X0 + w * scale, Y0 + h * scale],
    };
}

function underflows(doc, page) {
    const c = page.node.get(PDFName.of('Contents'));
    const refs = c instanceof PDFArray ? c.asArray() : [c];
    let depth = 0;
    for (const ref of refs) {
        const s = resolve(doc, ref);
        if (!(s instanceof PDFRawStream)) continue;
        const text = new TextDecoder('latin1').decode(decodePDFRawStream(s).decode());
        for (const t of lex(text)) {
            if (t.type !== 'op') continue;
            if (t.value === 'q') depth += 1;
            if (t.value === 'Q') { depth -= 1; if (depth < 0) return true; }
        }
    }
    return false;
}

export async function marginInPlace(sourceBytes, { scale, position }) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const refusals = [];
    const pages = doc.getPages();
    const plans = pages.map((page, index) => {
        const where = `p${index + 1}`;
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const vx0 = Math.max(media.x, crop.x);
        const vy0 = Math.max(media.y, crop.y);
        const vx1 = Math.min(media.x + media.width, crop.x + crop.width);
        const vy1 = Math.min(media.y + media.height, crop.y + crop.height);
        const visible = [vx0, vy0, vx1, vy1];
        const rotate = ((page.getRotation().angle % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(rotate)) refusals.push(`${where}: /Rotate ${rotate}`);
        if (underflows(doc, page)) refusals.push(`${where}: content pops more graphics states than it pushes`);
        const annots = page.node.lookup(PDFName.of('Annots'));
        const list = annots instanceof PDFArray ? annots.asArray() : [];
        for (const aref of list) {
            const a = resolve(doc, aref);
            if (!(a instanceof PDFDict)) continue;
            const subtype = a.lookup(PDFName.of('Subtype'))?.decodeText?.() ?? '?';
            if (!MOVABLE.has(subtype)) refusals.push(`${where}: annotation /${subtype} cannot be moved safely`);
            if (a.get(PDFName.of('InkList')) !== undefined && subtype !== 'Ink') {
                refusals.push(`${where}: /InkList on a /${subtype}`);
            }
            const flags = a.lookup(PDFName.of('F'))?.asNumber?.() ?? 0;
            const rect = a.lookup(PDFName.of('Rect'))?.asArray?.().map((n) => n.asNumber());
            if (rect && (flags & HIDDEN) === 0) {
                const outside = Math.max(rect[0], rect[2]) < vx0 - 1 || Math.min(rect[0], rect[2]) > vx1 + 1
                    || Math.max(rect[1], rect[3]) < vy0 - 1 || Math.min(rect[1], rect[3]) > vy1 + 1;
                if (outside && subtype !== 'Popup') {
                    refusals.push(`${where}: /${subtype} outside the visible page would be brought into view`);
                }
            }
        }
        return { page, visible, rotate, list, ...marginTransform(visible, rotate, scale, position) };
    });
    if (refusals.length > 0) return { status: 'REFUSED', refusals: [...new Set(refusals)], bytes: null };

    let movedAnnotations = 0;
    for (const { page, list, matrix, target } of plans) {
        const [a, , , d, e, f] = matrix;
        const [tx0, ty0, tx1, ty1] = target;
        // Clip first, in untransformed space, to the target: whatever the
        // CropBox hid maps outside it and stays hidden.
        const pre = doc.context.register(doc.context.flateStream(
            `q ${tx0} ${ty0} ${tx1 - tx0} ${ty1 - ty0} re W n ${a} 0 0 ${d} ${e} ${f} cm\n`,
        ));
        const post = doc.context.register(doc.context.flateStream('\nQ\n'));
        const c = page.node.get(PDFName.of('Contents'));
        const old = c instanceof PDFArray ? c.asArray() : (c ? [c] : []);
        page.node.set(PDFName.of('Contents'), doc.context.obj([pre, ...old, post]));

        const map = (x, y) => [a * x + e, d * y + f];
        for (const aref of list) {
            const annot = resolve(doc, aref);
            if (!(annot instanceof PDFDict)) continue;
            const rect = annot.lookup(PDFName.of('Rect'));
            if (rect instanceof PDFArray) {
                const [x0, y0, x1, y1] = rect.asArray().map((n) => n.asNumber());
                const [nx0, ny0] = map(x0, y0);
                const [nx1, ny1] = map(x1, y1);
                annot.set(PDFName.of('Rect'), doc.context.obj([nx0, ny0, nx1, ny1]));
            }
            for (const key of POINT_ARRAYS) {
                const arr = annot.lookup(PDFName.of(key));
                if (!(arr instanceof PDFArray)) continue;
                const v = arr.asArray().map((n) => n.asNumber());
                const out = [];
                for (let i = 0; i + 1 < v.length; i += 2) out.push(...map(v[i], v[i + 1]));
                annot.set(PDFName.of(key), doc.context.obj(out));
            }
            const ink = annot.lookup(PDFName.of('InkList'));
            if (ink instanceof PDFArray) {
                annot.set(PDFName.of('InkList'), doc.context.obj(ink.asArray().map((path) => {
                    const v = resolve(doc, path).asArray().map((n) => n.asNumber());
                    const out = [];
                    for (let i = 0; i + 1 < v.length; i += 2) out.push(...map(v[i], v[i + 1]));
                    return out;
                })));
            }
            const rd = annot.lookup(PDFName.of('RD'));
            if (rd instanceof PDFArray) {
                annot.set(PDFName.of('RD'), doc.context.obj(rd.asArray().map((n) => PDFNumber.of(n.asNumber() * a))));
            }
            movedAnnotations += 1;
        }
    }
    const bytes = await doc.save();
    return { status: 'TRANSFORMED', refusals: [], bytes, movedAnnotations };
}
