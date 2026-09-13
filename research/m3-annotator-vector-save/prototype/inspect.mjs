/**
 * What a PDF still contains, measured rather than assumed.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * The whole spike turns on one question -- what survives a save -- and "the
 * pages look the same" is not an answer to it. A whole-page raster looks
 * identical and has thrown away every character, every path and every form
 * field. So each feature is counted separately, before and after, and the
 * comparison reports `preserved`, `changed`, `lost`, or `not applicable` per
 * feature rather than a single verdict.
 *
 * Everything here reads with pdf-lib and pdf.js, both already dependencies.
 */

/**
 * Structure, read with pdf-lib: boxes, rotation, annotations, form, metadata.
 *
 * Deliberately separate from the pdf.js pass below. pdf-lib sees the object
 * graph -- the annotation dictionaries, the AcroForm, the page tree -- and
 * pdf.js sees what a renderer would draw. A feature can survive in one and not
 * the other, and collapsing the two hides exactly that.
 */
export async function inspectStructure(PDFDocument, bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    const pages = doc.getPages().map((page, index) => {
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const annots = page.node.Annots?.();
        const annotations = [];
        if (annots && typeof annots.size === 'function') {
            for (let i = 0; i < annots.size(); i++) {
                const dict = doc.context.lookup(annots.get(i));
                if (!dict || typeof dict.get !== 'function') continue;
                const subtype = dict.get(dict.context ? undefined : undefined);
                annotations.push(readAnnot(doc, dict));
            }
        }
        return {
            index: index + 1,
            mediaBox: round(media),
            cropBox: round(crop),
            rotate: page.getRotation().angle,
            // getSize() reports the MediaBox even when the CropBox is smaller,
            // which is a trap worth recording rather than working around
            // silently: a save path that maps annotations with it misplaces
            // every mark on a cropped page.
            reportedSize: round({ x: 0, y: 0, ...page.getSize() }),
            annotationCount: annotations.length,
            annotations,
        };
    });

    let form = { present: false, fields: [] };
    try {
        const acro = doc.getForm();
        const fields = acro.getFields();
        form = {
            present: fields.length > 0,
            fields: fields.map((f) => ({
                name: f.getName(),
                type: f.constructor.name,
                value: readFieldValue(f),
            })).sort((a, b) => a.name.localeCompare(b.name)),
        };
    } catch {
        form = { present: false, fields: [], unreadable: true };
    }

    return {
        pageCount: pages.length,
        pages,
        form,
        metadata: {
            title: safe(() => doc.getTitle()),
            author: safe(() => doc.getAuthor()),
            subject: safe(() => doc.getSubject()),
            keywords: safe(() => doc.getKeywords()),
            producer: safe(() => doc.getProducer()),
            creator: safe(() => doc.getCreator()),
        },
        outlines: doc.catalog.get(doc.context.obj({}).constructor.name ? undefined : undefined) ? 'unknown' : 'unknown',
        bytes: bytes.length ?? bytes.byteLength,
    };
}

function readAnnot(doc, dict) {
    const get = (key) => {
        try {
            const raw = dict.lookup ? dict.lookup(nameOf(doc, key)) : undefined;
            return raw;
        } catch {
            return undefined;
        }
    };
    const subtype = get('Subtype');
    const rect = get('Rect');
    return {
        subtype: subtype && subtype.asString ? subtype.asString().replace(/^\//, '') : String(subtype ?? ''),
        rect: rect && rect.asArray
            ? rect.asArray().map((n) => Math.round((n.asNumber ? n.asNumber() : Number(n)) * 100) / 100)
            : null,
    };
}

function nameOf(doc, key) {
    // pdf-lib exposes PDFName through the context's obj factory; going through
    // it avoids importing the class here just to build one name.
    return doc.context.obj({ [key]: 0 }).keys()[0];
}

function readFieldValue(field) {
    try {
        if (typeof field.getText === 'function') return field.getText() ?? '';
        if (typeof field.isChecked === 'function') return field.isChecked() ? 'checked' : 'unchecked';
        if (typeof field.getSelected === 'function') return field.getSelected();
    } catch { /* a field type we do not read is reported as unknown */ }
    return '(unread)';
}

const safe = (fn) => {
    try {
        return fn() ?? null;
    } catch {
        return null;
    }
};

const round = (box) => ({
    x: Math.round(box.x * 100) / 100,
    y: Math.round(box.y * 100) / 100,
    width: Math.round(box.width * 100) / 100,
    height: Math.round(box.height * 100) / 100,
});

/**
 * What a renderer sees, read with pdf.js: text, drawing operators, images.
 *
 * The operator census is the evidence that vector content is still vector. A
 * page flattened to a picture has almost no path operators and exactly one
 * image; a page that kept its content has many paths and however many images it
 * started with.
 */
export async function inspectRendered(pdfjsLib, bytes, { maxPages = 50 } = {}) {
    const doc = await pdfjsLib.getDocument({
        data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        // Keep the measurement about the file, not about pdf.js's helpfulness.
        isEvalSupported: false,
    }).promise;

    const pages = [];
    const total = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= total; n++) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const text = content.items.map((i) => (typeof i.str === 'string' ? i.str : '')).join('');
        const ops = await page.getOperatorList();

        const census = {};
        for (const fn of ops.fnArray) {
            const name = OPS_NAME.get(fn) ?? `op_${fn}`;
            census[name] = (census[name] ?? 0) + 1;
        }
        const imageOps = (census.paintImageXObject ?? 0) + (census.paintInlineImageXObject ?? 0)
            + (census.paintJpegXObject ?? 0);
        const pathOps = (census.constructPath ?? 0) + (census.stroke ?? 0) + (census.fill ?? 0)
            + (census.eoFill ?? 0) + (census.fillStroke ?? 0) + (census.closePath ?? 0);

        pages.push({
            index: n,
            rotate: page.rotate ?? 0,
            width: Math.round(viewport.width * 100) / 100,
            height: Math.round(viewport.height * 100) / 100,
            charCount: text.replace(/\s/g, '').length,
            text,
            textItems: content.items.length,
            operators: ops.fnArray.length,
            pathOps,
            imageOps,
            census,
        });
        page.cleanup();
    }
    const numPages = doc.numPages;
    await doc.destroy();
    return { pageCount: numPages, pages };
}

/** pdf.js operator numbers are stable per build; resolved once, by name. */
export const OPS_NAME = new Map();
export function initOpsNames(OPS) {
    OPS_NAME.clear();
    for (const [name, value] of Object.entries(OPS)) OPS_NAME.set(value, name);
}

/**
 * Compare one feature before and after, and say which of four things happened.
 *
 * `not applicable` is a real answer and is kept distinct from `preserved`: a
 * fixture with no form fields tells you nothing about whether forms survive,
 * and recording that as a pass would be the most flattering kind of lie.
 */
export function verdict(before, after, { compare = (a, b) => a === b } = {}) {
    const emptyBefore = before === null || before === undefined || before === 0
        || (Array.isArray(before) && before.length === 0) || before === '';
    const emptyAfter = after === null || after === undefined || after === 0
        || (Array.isArray(after) && after.length === 0) || after === '';
    if (emptyBefore) return 'not applicable';
    if (emptyAfter) return 'lost';
    return compare(before, after) ? 'preserved' : 'changed';
}
