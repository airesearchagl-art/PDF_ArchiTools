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
 * Semantics that point *at* a place on a page move with it: explicit
 * destinations in links, GoTo actions, outline items and the named-destination
 * tree are rewritten through the matrix of the page they point to, and a form
 * widget's regenerable text (`/DA` font size, border width) is scaled with its
 * rectangle so a viewer that redraws it draws it at the new size.
 *
 * Refused rather than guessed, before anything is changed:
 *   - content whose q/Q nesting underflows (the wrapper could be popped early);
 *   - an annotation this prototype does not know how to move;
 *   - an annotation not wholly inside the visible page — scaling it inward
 *     would bring its hidden part into view;
 *   - a destination whose type is not one of the eight in the PDF
 *     specification, that points at no page of this document, or that is a
 *     structure destination.
 *
 * Research code. Not part of the app, and not a claim of readiness.
 */
import {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream,
    PDFString, PDFHexString, PDFNull, decodePDFRawStream,
} from 'pdf-lib';
import { lex } from './mono-structure.mjs';

/**
 * Which operands of each destination type are coordinates, and on which axis.
 * `null` operands stay null ("unchanged" in the specification).
 */
const DEST_AXES = {
    XYZ: ['x', 'y', null],
    Fit: [],
    FitH: ['y'],
    FitV: ['x'],
    FitR: ['x', 'y', 'x', 'y'],
    FitB: [],
    FitBH: ['y'],
    FitBV: ['x'],
};

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

/**
 * Every explicit destination array the document can reach: link /Dest,
 * GoTo /D, outline items, the /Dests dictionary and the /Names /Dests tree.
 * Named references need no rewrite — the arrays they name are rewritten.
 */
function collectDestinations(doc, pages, refusals) {
    const found = [];
    const seen = new Set();
    const take = (value, where) => {
        const v = resolve(doc, value);
        if (v instanceof PDFDict) { take(v.get(PDFName.of('D')), where); return; }
        if (!(v instanceof PDFArray)) return; // a name or string: resolved in the tree
        if (seen.has(v)) return;
        seen.add(v);
        found.push({ array: v, where });
    };
    const fromAction = (actionValue, where) => {
        const a = resolve(doc, actionValue);
        if (!(a instanceof PDFDict)) return;
        const s = a.lookup(PDFName.of('S'))?.decodeText?.();
        if (s === 'GoTo') {
            if (a.get(PDFName.of('SD')) !== undefined) refusals.push(`${where}: structure destination (/SD)`);
            take(a.get(PDFName.of('D')), where);
        } else if (s === 'GoToE') {
            refusals.push(`${where}: /GoToE into an embedded file`);
        }
        const next = a.get(PDFName.of('Next'));
        if (next !== undefined) {
            const list = resolve(doc, next);
            (list instanceof PDFArray ? list.asArray() : [next]).forEach((n) => fromAction(n, `${where} /Next`));
        }
    };
    pages.forEach((page, i) => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) return;
        for (const aref of annots.asArray()) {
            const a = resolve(doc, aref);
            if (!(a instanceof PDFDict)) continue;
            if (a.get(PDFName.of('Dest')) !== undefined) take(a.get(PDFName.of('Dest')), `p${i + 1} link /Dest`);
            if (a.get(PDFName.of('A')) !== undefined) fromAction(a.get(PDFName.of('A')), `p${i + 1} link /A`);
        }
    });
    const outlines = resolve(doc, doc.catalog.get(PDFName.of('Outlines')));
    const visitOutline = (ref, depth) => {
        let item = resolve(doc, ref);
        const guard = new Set();
        while (item instanceof PDFDict && !guard.has(item) && depth < 32) {
            guard.add(item);
            if (item.get(PDFName.of('Dest')) !== undefined) take(item.get(PDFName.of('Dest')), 'outline');
            if (item.get(PDFName.of('A')) !== undefined) fromAction(item.get(PDFName.of('A')), 'outline');
            if (item.get(PDFName.of('First')) !== undefined) visitOutline(item.get(PDFName.of('First')), depth + 1);
            item = resolve(doc, item.get(PDFName.of('Next')));
        }
    };
    if (outlines instanceof PDFDict && outlines.get(PDFName.of('First')) !== undefined) {
        visitOutline(outlines.get(PDFName.of('First')), 0);
    }
    const dests = resolve(doc, doc.catalog.get(PDFName.of('Dests')));
    if (dests instanceof PDFDict) for (const [, v] of dests.entries()) take(v, '/Dests');
    const names = resolve(doc, doc.catalog.get(PDFName.of('Names')));
    const tree = names instanceof PDFDict ? resolve(doc, names.get(PDFName.of('Dests'))) : null;
    const visitTree = (node, depth) => {
        const n = resolve(doc, node);
        if (!(n instanceof PDFDict) || depth > 32) return;
        const list = resolve(doc, n.get(PDFName.of('Names')));
        if (list instanceof PDFArray) {
            const arr = list.asArray();
            for (let i = 1; i < arr.length; i += 2) take(arr[i], '/Names /Dests');
        }
        const kids = resolve(doc, n.get(PDFName.of('Kids')));
        if (kids instanceof PDFArray) kids.asArray().forEach((k) => visitTree(k, depth + 1));
    };
    if (tree) visitTree(tree, 0);
    return found;
}

/** Scale a /DA string's font size (`/Name size Tf`) by `s`. */
function scaleDA(da, s) {
    const tokens = lex(da);
    for (let i = 2; i < tokens.length; i += 1) {
        if (tokens[i].type === 'op' && tokens[i].value === 'Tf' && tokens[i - 1].type === 'number') {
            const size = tokens[i - 1].value;
            if (size === 0) return da; // auto-size already follows the rectangle
            const t = tokens[i - 1];
            return da.slice(0, t.start) + String(Math.round(size * s * 1000) / 1000) + da.slice(t.end);
        }
    }
    return da;
}

export async function marginInPlace(sourceBytes, { scale, position, scaleWidgetText = true }) {
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
            if (rect && (flags & HIDDEN) === 0 && subtype !== 'Popup') {
                // Wholly inside, within a point. Anything else has a part the
                // CropBox hides, and scaling it inward would show it.
                const inside = Math.min(rect[0], rect[2]) >= vx0 - 1 && Math.max(rect[0], rect[2]) <= vx1 + 1
                    && Math.min(rect[1], rect[3]) >= vy0 - 1 && Math.max(rect[1], rect[3]) <= vy1 + 1;
                if (!inside) {
                    refusals.push(`${where}: /${subtype} is not wholly inside the visible page; scaling would bring its hidden part into view`);
                }
            }
        }
        return { page, visible, rotate, list, ...marginTransform(visible, rotate, scale, position) };
    });
    const byPage = new Map(plans.map((p) => [p.page.ref.toString(), p]));
    const destinations = collectDestinations(doc, pages, refusals);
    for (const { array, where } of destinations) {
        const target = array.get(0);
        const type = resolve(doc, array.get(1))?.decodeText?.();
        if (!(target instanceof PDFRef) || !byPage.has(target.toString())) {
            refusals.push(`${where}: destination does not point at a page of this document`);
        } else if (!(type in DEST_AXES)) {
            refusals.push(`${where}: destination type /${type ?? '?'}`);
        }
    }
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
            // What a viewer regenerates from: the text size and the border.
            if (scaleWidgetText) {
                const da = annot.get(PDFName.of('DA'));
                if (da instanceof PDFString || da instanceof PDFHexString) {
                    annot.set(PDFName.of('DA'), PDFString.of(scaleDA(da.decodeText(), a)));
                }
                const bs = resolve(doc, annot.get(PDFName.of('BS')));
                const bw = bs instanceof PDFDict ? bs.lookup(PDFName.of('W')) : null;
                if (bw?.asNumber) bs.set(PDFName.of('W'), PDFNumber.of(bw.asNumber() * a));
            }
            movedAnnotations += 1;
        }
    }
    let scaledTexts = 0;
    if (scaleWidgetText) {
        // Field-level /DA (on a parent without its own widget) and the form's
        // default. The scale is the same on every page, so one factor is right.
        const acro = resolve(doc, doc.catalog.get(PDFName.of('AcroForm')));
        const scaled = new Set();
        const visit = (ref) => {
            const d = resolve(doc, ref);
            if (!(d instanceof PDFDict) || scaled.has(d)) return;
            scaled.add(d);
            const da = d.get(PDFName.of('DA'));
            if ((da instanceof PDFString || da instanceof PDFHexString) && d.get(PDFName.of('Rect')) === undefined) {
                d.set(PDFName.of('DA'), PDFString.of(scaleDA(da.decodeText(), scale)));
                scaledTexts += 1;
            }
            const kids = resolve(doc, d.get(PDFName.of('Kids')));
            if (kids instanceof PDFArray) kids.asArray().forEach(visit);
        };
        if (acro instanceof PDFDict) {
            const da = acro.get(PDFName.of('DA'));
            if (da instanceof PDFString || da instanceof PDFHexString) {
                acro.set(PDFName.of('DA'), PDFString.of(scaleDA(da.decodeText(), scale)));
                scaledTexts += 1;
            }
            const fields = resolve(doc, acro.get(PDFName.of('Fields')));
            if (fields instanceof PDFArray) fields.asArray().forEach(visit);
        }
    }
    // Destinations, through the matrix of the page each one points at.
    let movedDestinations = 0;
    for (const { array } of destinations) {
        const plan = byPage.get(array.get(0).toString());
        const [a, , , d, e, f] = plan.matrix;
        const axes = DEST_AXES[resolve(doc, array.get(1)).decodeText()];
        axes.forEach((axis, k) => {
            const operand = resolve(doc, array.get(k + 2));
            if (!axis || operand === undefined || operand === PDFNull || !operand.asNumber) return;
            const v = operand.asNumber();
            array.set(k + 2, PDFNumber.of(axis === 'x' ? a * v + e : d * v + f));
        });
        movedDestinations += 1;
    }
    const bytes = await doc.save();
    return { status: 'TRANSFORMED', refusals: [], bytes, movedAnnotations, movedDestinations, scaledTexts };
}
