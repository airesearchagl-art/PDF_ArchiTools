/**
 * 余白生成, done to the document instead of to a picture of it.
 *
 * The legacy implementation embedded each page into a new document as a Form
 * XObject and drew it smaller. The drawing survived that; the document did not.
 * Measured on the research corpus, the output lost every annotation, every
 * link and where it pointed, the AcroForm and its values, XFA and all metadata;
 * `/Rotate` was dropped so a landscape sheet came back turned; the CropBox was
 * discarded, which *revealed* content the crop had been hiding.
 *
 * So the transform is applied in place. The page keeps its boxes, its rotation
 * and its objects; the content stream is wrapped in one `q … cm … Q`, clipped
 * to the visible page so nothing hidden becomes visible, and everything that
 * carries coordinates is moved through the same matrix — annotations, link
 * targets, outline destinations, named destinations, widget appearances.
 *
 * Where a piece of geometry cannot be moved safely, the operation refuses
 * **before** it writes anything, rather than producing a document whose links
 * point at the wrong place.
 *
 * Adopted: H3 (the contract below), H6, H12.
 */
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    PDFHexString,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { PLAN_STATUS, ProcessorError } from './contracts';

export interface MarginOptions {
    /** 0.25 – 0.90 of the visible page. */
    scale: number;
    position: 'center' | 'tl' | 'tr' | 'bl' | 'br';
}

/** A 2-D affine transform, as PDF writes it: [a b c d e f]. */
interface Matrix {
    a: number;
    d: number;
    e: number;
    f: number;
}

const refuse = (message: string): never => {
    throw new ProcessorError(message, PLAN_STATUS.UNSUPPORTED_MARGIN_SEMANTICS);
};

const num = (value: unknown): number | null => (
    value instanceof PDFNumber ? value.asNumber() : null
);

/** CropBox ∩ MediaBox, in page coordinates. The page as anyone sees it. */
function visibleBox(page: PDFPage): { x: number; y: number; width: number; height: number } {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const x0 = Math.max(media.x, crop.x);
    const y0 = Math.max(media.y, crop.y);
    const x1 = Math.min(media.x + media.width, crop.x + crop.width);
    const y1 = Math.min(media.y + media.height, crop.y + crop.height);
    if (!(x1 > x0 && y1 > y0)) {
        refuse('このページの表示領域を決められませんでした（CropBoxとMediaBoxが重なっていません）。');
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function matrixFor(
    box: { x: number; y: number; width: number; height: number },
    options: MarginOptions,
): Matrix {
    const s = options.scale;
    const w = box.width * s;
    const h = box.height * s;
    let x = box.x + (box.width - w) / 2;
    let y = box.y + (box.height - h) / 2;
    switch (options.position) {
        case 'tl': x = box.x; y = box.y + box.height - h; break;
        case 'tr': x = box.x + box.width - w; y = box.y + box.height - h; break;
        case 'bl': x = box.x; y = box.y; break;
        case 'br': x = box.x + box.width - w; y = box.y; break;
        default: break;
    }
    // p' = s·p + t, with t chosen so the scaled box lands at (x, y).
    return { a: s, d: s, e: x - box.x * s, f: y - box.y * s };
}

const applyX = (m: Matrix, x: number): number => m.a * x + m.e;
const applyY = (m: Matrix, y: number): number => m.d * y + m.f;

/**
 * Wrap the page's content in `q [clip] [cm] … Q`.
 *
 * Prepending rather than appending matters: `pushOperators` would put the
 * matrix *after* the page had already drawn itself. The clip is the visible box
 * as it is now, so content the CropBox was hiding stays hidden after the
 * content moves.
 */
function wrapContents(
    doc: PDFDocument,
    page: PDFPage,
    box: { x: number; y: number; width: number; height: number },
    m: Matrix,
): void {
    const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6));
    const prefix = doc.context.stream(
        `q\n${f(box.x)} ${f(box.y)} ${f(box.width)} ${f(box.height)} re W n\n`
        + `${f(m.a)} 0 0 ${f(m.d)} ${f(m.e)} ${f(m.f)} cm\n`,
    );
    const suffix = doc.context.stream('\nQ\n');
    const prefixRef = doc.context.register(prefix);
    const suffixRef = doc.context.register(suffix);

    const contents = page.node.get(PDFName.of('Contents'));
    const existing: PDFRef[] = [];
    if (contents instanceof PDFRef) {
        existing.push(contents);
    } else if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i += 1) {
            const entry = contents.get(i);
            if (entry instanceof PDFRef) existing.push(entry);
        }
    } else if (contents !== undefined) {
        refuse('このページの内容ストリームを解釈できませんでした。');
    }

    page.node.set(
        PDFName.of('Contents'),
        doc.context.obj([prefixRef, ...existing, suffixRef]),
    );
}

/** Move a rectangle [x0 y0 x1 y1] through the matrix, in place. */
function transformRect(array: PDFArray, m: Matrix, doc: PDFDocument): void {
    const values = [0, 1, 2, 3].map((i) => num(doc.context.lookup(array.get(i))));
    if (values.some((v) => v === null)) refuse('注釈の座標を読み取れませんでした。');
    const [x0, y0, x1, y1] = values as number[];
    array.set(0, PDFNumber.of(applyX(m, Math.min(x0, x1))));
    array.set(1, PDFNumber.of(applyY(m, Math.min(y0, y1))));
    array.set(2, PDFNumber.of(applyX(m, Math.max(x0, x1))));
    array.set(3, PDFNumber.of(applyY(m, Math.max(y0, y1))));
}

const insideBox = (
    r: number[],
    box: { x: number; y: number; width: number; height: number },
): boolean => (
    Math.min(r[0], r[2]) >= box.x - 0.01
    && Math.min(r[1], r[3]) >= box.y - 0.01
    && Math.max(r[0], r[2]) <= box.x + box.width + 0.01
    && Math.max(r[1], r[3]) <= box.y + box.height + 0.01
);

/** `/DA` carries a font size in points; the text has to shrink with the page. */
function scaleDefaultAppearance(dict: PDFDict, m: Matrix): void {
    const da = dict.get(PDFName.of('DA'));
    if (!(da instanceof PDFString) && !(da instanceof PDFHexString)) return;
    const text = da.decodeText();
    const scaled = text.replace(/(-?[\d.]+)\s+Tf/g, (_match, size: string) => {
        const value = parseFloat(size) * m.a;
        return `${Number.isInteger(value) ? value : value.toFixed(3)} Tf`;
    });
    dict.set(PDFName.of('DA'), PDFString.of(scaled));
}

function scaleBorderWidth(dict: PDFDict, m: Matrix): void {
    const bs = dict.get(PDFName.of('BS'));
    if (bs instanceof PDFDict) {
        const w = num(bs.get(PDFName.of('W')));
        if (w !== null) bs.set(PDFName.of('W'), PDFNumber.of(w * m.a));
    }
}

/**
 * Destination arrays: `[page /XYZ left top zoom]` and friends.
 *
 * Only the standard eight are moved. Anything else — a structure destination,
 * a type this version does not model — is refused rather than left pointing at
 * a coordinate that no longer means what it did.
 */
function transformDestination(
    doc: PDFDocument,
    dest: unknown,
    matrices: Map<string, Matrix>,
): void {
    const array = doc.context.lookup(dest as never);
    if (!(array instanceof PDFArray) || array.size() < 2) {
        refuse('リンクの移動先を解釈できませんでした。処理を中止しました。');
        return;
    }
    const target = array.get(0);
    if (!(target instanceof PDFRef)) {
        // A page given by index is not resolvable to a page object here, and a
        // structure destination is not a page at all.
        refuse('ページ参照ではない移動先が含まれているため、処理を中止しました。');
        return;
    }
    const m = matrices.get(target.toString());
    if (!m) {
        refuse('この文書のページに存在しない移動先が含まれているため、処理を中止しました。');
        return;
    }
    const type = String((array.get(1) as { asString?: () => string })?.asString?.() ?? '');
    const setX = (i: number) => {
        const v = num(doc.context.lookup(array.get(i)));
        if (v !== null) array.set(i, PDFNumber.of(applyX(m, v)));
    };
    const setY = (i: number) => {
        const v = num(doc.context.lookup(array.get(i)));
        if (v !== null) array.set(i, PDFNumber.of(applyY(m, v)));
    };
    switch (type) {
        case '/Fit':
        case '/FitB':
            break; // no coordinates to move
        case '/XYZ': setX(2); setY(3); break;
        case '/FitH':
        case '/FitBH': setY(2); break;
        case '/FitV':
        case '/FitBV': setX(2); break;
        case '/FitR': setX(2); setY(3); setX(4); setY(5); break;
        default:
            refuse(`未対応の移動先タイプ（${type || '不明'}）が含まれているため、処理を中止しました。`);
    }
}

/** An action may carry a destination, and may chain to more actions. */
function transformAction(
    doc: PDFDocument,
    action: unknown,
    matrices: Map<string, Matrix>,
    depth = 0,
): void {
    if (depth > 32) return;
    const dict = doc.context.lookup(action as never);
    if (!(dict instanceof PDFDict)) return;
    const type = String((dict.get(PDFName.of('S')) as { asString?: () => string })?.asString?.() ?? '');
    if (type === '/GoToR') return; // another file's coordinates; not ours to move
    if (type === '/GoToE') {
        refuse('埋め込みファイルへのリンク（GoToE）は移動できないため、処理を中止しました。');
    }
    if (type === '/GoTo') {
        const d = dict.get(PDFName.of('D'));
        if (d !== undefined && !(d instanceof PDFString) && !(d instanceof PDFHexString)) {
            transformDestination(doc, d, matrices);
        }
    }
    const next = dict.get(PDFName.of('Next'));
    const resolvedNext = doc.context.lookup(next as never);
    if (resolvedNext instanceof PDFArray) {
        for (let i = 0; i < resolvedNext.size(); i += 1) {
            transformAction(doc, resolvedNext.get(i), matrices, depth + 1);
        }
    } else if (resolvedNext instanceof PDFDict) {
        transformAction(doc, next, matrices, depth + 1);
    }
}

/** Named destinations, in both the old dictionary and the newer name tree. */
function transformNamedDestinations(doc: PDFDocument, matrices: Map<string, Matrix>): void {
    const dests = doc.catalog.lookup(PDFName.of('Dests'));
    if (dests instanceof PDFDict) {
        for (const [, value] of dests.entries()) transformDestination(doc, value, matrices);
    }

    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (!(names instanceof PDFDict)) return;
    const tree = names.lookup(PDFName.of('Dests'));
    if (!(tree instanceof PDFDict)) return;

    const walk = (node: PDFDict, depth = 0): void => {
        if (depth > 32) return;
        const namesArray = node.lookup(PDFName.of('Names'));
        if (namesArray instanceof PDFArray) {
            for (let i = 1; i < namesArray.size(); i += 2) {
                const value = doc.context.lookup(namesArray.get(i));
                if (value instanceof PDFDict) {
                    transformDestination(doc, value.get(PDFName.of('D')), matrices);
                } else {
                    transformDestination(doc, namesArray.get(i), matrices);
                }
            }
        }
        const kids = node.lookup(PDFName.of('Kids'));
        if (kids instanceof PDFArray) {
            for (let i = 0; i < kids.size(); i += 1) {
                const kid = doc.context.lookup(kids.get(i));
                if (kid instanceof PDFDict) walk(kid, depth + 1);
            }
        }
    };
    walk(tree);
}

/** Outline items carry destinations too, and nobody notices when they rot. */
function transformOutlines(doc: PDFDocument, matrices: Map<string, Matrix>): void {
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
    if (!(outlines instanceof PDFDict)) return;

    const seen = new Set<string>();
    const walk = (node: PDFDict, depth = 0): void => {
        if (depth > 64) return;
        const dest = node.get(PDFName.of('Dest'));
        if (dest !== undefined && !(dest instanceof PDFString) && !(dest instanceof PDFHexString)) {
            transformDestination(doc, dest, matrices);
        }
        const action = node.get(PDFName.of('A'));
        if (action !== undefined) transformAction(doc, action, matrices);

        for (const key of ['First', 'Next'] as const) {
            const ref = node.get(PDFName.of(key));
            if (ref instanceof PDFRef) {
                const id = ref.toString();
                if (seen.has(id)) continue;
                seen.add(id);
                const child = doc.context.lookup(ref);
                if (child instanceof PDFDict) walk(child, depth + 1);
            }
        }
    };
    walk(outlines);
}

/**
 * Scale every page's content in place, and move everything that points at a
 * coordinate along with it.
 */
export async function marginInPlace(
    bytes: Uint8Array,
    options: MarginOptions,
): Promise<Uint8Array> {
    // `updateMetadata: false`: this operation has no business rewriting the
    // Producer of a document whose margins it was asked to change. H12.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPages();
    if (pages.length === 0) refuse('ページが存在しないPDFです。');

    // One matrix per page, keyed by the page's reference, so a destination in
    // another part of the document can be moved with the page it points at.
    const matrices = new Map<string, Matrix>();
    const boxes = pages.map((page) => {
        const box = visibleBox(page);
        const m = matrixFor(box, options);
        matrices.set(page.ref.toString(), m);
        return { page, box, m };
    });

    // Refusals first, across the whole document: nothing is written until every
    // page and every destination is known to be movable.
    for (const { page, box, m } of boxes) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = doc.context.lookup(annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            const rect = doc.context.lookup(annot.get(PDFName.of('Rect')));
            if (!(rect instanceof PDFArray) || rect.size() < 4) {
                refuse('座標を読み取れない注釈が含まれているため、処理を中止しました。');
                continue;
            }
            const values = [0, 1, 2, 3].map((k) => num(doc.context.lookup(rect.get(k))) ?? NaN);
            if (values.some(Number.isNaN)) {
                refuse('座標を読み取れない注釈が含まれているため、処理を中止しました。');
            }
            if (!insideBox(values, box)) {
                refuse('表示領域からはみ出している注釈があるため、処理を中止しました。'
                    + '縮小すると一部が失われる可能性があります。');
            }
            void m;
        }
    }
    transformNamedDestinations(doc, matrices);
    transformOutlines(doc, matrices);

    // Now the writes.
    for (const { page, box, m } of boxes) {
        wrapContents(doc, page, box, m);

        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = doc.context.lookup(annots.get(i));
            if (!(annot instanceof PDFDict)) continue;

            const rect = doc.context.lookup(annot.get(PDFName.of('Rect')));
            if (rect instanceof PDFArray) transformRect(rect, m, doc);

            const quad = doc.context.lookup(annot.get(PDFName.of('QuadPoints')));
            if (quad instanceof PDFArray) {
                for (let k = 0; k + 1 < quad.size(); k += 2) {
                    const x = num(doc.context.lookup(quad.get(k)));
                    const y = num(doc.context.lookup(quad.get(k + 1)));
                    if (x !== null) quad.set(k, PDFNumber.of(applyX(m, x)));
                    if (y !== null) quad.set(k + 1, PDFNumber.of(applyY(m, y)));
                }
            }

            const subtype = String((annot.get(PDFName.of('Subtype')) as { asString?: () => string })?.asString?.() ?? '');
            if (subtype === '/Widget') {
                scaleDefaultAppearance(annot, m);
                scaleBorderWidth(annot, m);
            }

            const dest = annot.get(PDFName.of('Dest'));
            if (dest !== undefined && !(dest instanceof PDFString) && !(dest instanceof PDFHexString)) {
                transformDestination(doc, dest, matrices);
            }
            const action = annot.get(PDFName.of('A'));
            if (action !== undefined) transformAction(doc, action, matrices);
        }
    }

    // The AcroForm's own /DA is the fallback for fields that have none.
    const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acroForm instanceof PDFDict) {
        scaleDefaultAppearance(acroForm, boxes[0].m);
        // Appearances were generated at the old size; ask a viewer to redraw.
        acroForm.set(PDFName.of('NeedAppearances'), doc.context.obj(true));
    }

    return doc.save({ useObjectStreams: false });
}
