/**
 * What a PDF *is*, read from its structure rather than from a picture of it.
 *
 * "Preserved" is never decided by appearance. A rasterised page can look
 * identical and have lost every character a reader could search for; a page
 * drawn inside a Form XObject can look identical and have lost its links. So
 * the inspector reads what a PDF reader reads:
 *
 *   - PDF.js: the text a reader extracts, the annotations it lists, and a
 *     small rendering for measured (not asserted) visual comparison;
 *   - pdf-lib: page boxes and rotation, content-stream operators (walking into
 *     Form XObjects), image XObjects and a digest of their bytes, the AcroForm
 *     and its field values, signature dictionaries, XFA, the Info dictionary
 *     and the XMP stream.
 *
 * Inspection must not modify what it inspects: the document is loaded with
 * `updateMetadata: false` and `getForm()` is never called (in pdf-lib 1.17.1
 * it creates an AcroForm where there was none and deletes XFA — M3).
 *
 * Research code. Not part of the app.
 */
import {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, PDFRef,
    PDFString, PDFHexString, PDFNumber, decodePDFRawStream,
} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const COLOUR_OPS = new Set(['rg', 'RG', 'k', 'K', 'g', 'G', 'sc', 'scn', 'SC', 'SCN', 'cs', 'CS']);

const str = (v) => {
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
    if (v instanceof PDFName) return v.decodeText();
    if (v instanceof PDFNumber) return v.asNumber();
    return v === undefined ? undefined : String(v);
};
const box = (b) => [b.x, b.y, b.x + b.width, b.y + b.height].map((n) => Math.round(n * 100) / 100);

async function sha256(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decoded bytes of a stream, or null when its filter cannot be decoded here. */
export function streamBytes(stream) {
    try {
        if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
        if (stream instanceof PDFStream && typeof stream.getContents === 'function') {
            return stream.getContents();
        }
    } catch { /* an image filter pdf-lib does not decode */ }
    return null;
}

/**
 * A content stream's operators, approximately but deterministically: strings,
 * hex strings, comments and inline image data are removed, then every token
 * that is not a number, a name or a delimiter is an operator.
 */
export function tokenizeContent(bytes) {
    let text = new TextDecoder('latin1').decode(bytes);
    const inline = (text.match(/\bBI\b/g) ?? []).length;
    text = text.replace(/\bBI\b[\s\S]*?\bEI\b/g, ' INLINE_IMAGE ');
    text = text.replace(/%[^\r\n]*/g, ' ');
    // Literal strings (one level of balanced parentheses is enough here).
    text = text.replace(/\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)/g, ' STR ');
    text = text.replace(/<(?!<)[0-9A-Fa-f\s]*>/g, ' STR ');
    const tokens = text.split(/[\s[\]<>{}]+/).filter(Boolean);
    return { tokens, inline };
}

function resolveDict(doc, v) {
    const r = v instanceof PDFRef ? doc.context.lookup(v) : v;
    return r instanceof PDFDict ? r : null;
}

function xobjectsOf(doc, resources) {
    const res = resolveDict(doc, resources);
    const xo = res ? resolveDict(doc, res.get(PDFName.of('XObject'))) : null;
    const map = new Map();
    if (!xo) return map;
    for (const [key, ref] of xo.entries()) {
        const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (stream instanceof PDFStream) map.set(key.decodeText(), { ref, stream });
    }
    return map;
}

/** Walk a content stream and every Form XObject it draws, once each. */
async function summariseContent(doc, streams, resources, acc, seen, depth = 0) {
    for (const stream of streams) {
        const bytes = streamBytes(stream);
        if (!bytes) { acc.undecodable += 1; continue; }
        const { tokens, inline } = tokenizeContent(bytes);
        acc.inlineImages += inline;
        const xobjects = xobjectsOf(doc, resources);
        for (let i = 0; i < tokens.length; i += 1) {
            const t = tokens[i];
            if (PATH_OPS.has(t)) acc.pathOps += 1;
            else if (PAINT_OPS.has(t)) acc.paintOps += 1;
            else if (TEXT_SHOW.has(t)) acc.textShows += 1;
            else if (COLOUR_OPS.has(t)) acc.colourOps[t] = (acc.colourOps[t] ?? 0) + 1;
            else if (t === 'sh') acc.shadings += 1;
            else if (t === 'Tr' && tokens[i - 1] === '3') acc.invisibleTextModes += 1;
            else if (t === 'Do') {
                const name = (tokens[i - 1] ?? '').replace(/^\//, '');
                const entry = xobjects.get(name);
                if (!entry) { acc.unresolvedDo += 1; continue; }
                const subtype = str(entry.stream.dict.get(PDFName.of('Subtype')));
                if (subtype === 'Image') {
                    acc.imageDraws += 1;
                    const key = entry.ref instanceof PDFRef ? entry.ref.toString() : `${name}@${depth}`;
                    if (!acc.images.has(key)) acc.images.set(key, entry.stream);
                } else if (subtype === 'Form') {
                    acc.formDraws += 1;
                    const key = entry.ref instanceof PDFRef ? entry.ref.toString() : `${name}@${depth}`;
                    if (seen.has(key) || depth > 8) continue;
                    seen.add(key);
                    await summariseContent(
                        doc, [entry.stream], entry.stream.dict.get(PDFName.of('Resources')) ?? resources,
                        acc, seen, depth + 1,
                    );
                }
            }
        }
    }
}

function pageContentStreams(doc, page) {
    const c = page.node.get(PDFName.of('Contents'));
    const resolved = c instanceof PDFRef ? doc.context.lookup(c) : c;
    if (resolved instanceof PDFArray) {
        return resolved.asArray().map((r) => doc.context.lookup(r)).filter((s) => s instanceof PDFStream);
    }
    return resolved instanceof PDFStream ? [resolved] : [];
}

function fieldTree(doc, acro) {
    const fields = [];
    const visit = (ref, prefix) => {
        const d = resolveDict(doc, ref);
        if (!d) return;
        const t = str(d.get(PDFName.of('T')));
        const name = t === undefined ? prefix : (prefix ? `${prefix}.${t}` : t);
        const kids = d.lookup(PDFName.of('Kids'));
        const ft = str(d.get(PDFName.of('FT')));
        const v = d.get(PDFName.of('V'));
        const vDict = resolveDict(doc, v);
        if (ft || v !== undefined) {
            fields.push({
                name,
                ft: ft ?? null,
                value: vDict ? '(dict)' : str(v) ?? null,
                signature: vDict && ft === 'Sig' ? {
                    byteRange: vDict.lookup(PDFName.of('ByteRange'))?.asArray?.().map((n) => n.asNumber()) ?? null,
                    contents: (() => {
                        const c = vDict.get(PDFName.of('Contents'));
                        return c instanceof PDFHexString ? c.asString() : null;
                    })(),
                } : null,
            });
        }
        if (kids instanceof PDFArray) for (const k of kids.asArray()) visit(k, name);
    };
    const list = acro.lookup(PDFName.of('Fields'));
    if (list instanceof PDFArray) for (const f of list.asArray()) visit(f, '');
    return fields;
}

/**
 * Is the data a signature covers still the data?
 *
 * The fixture's /Contents holds the SHA-256 of its /ByteRange, so this is the
 * first check a real verifier makes, without the cryptography that follows.
 */
export async function signatureState(bytes, sig) {
    if (!sig?.byteRange || !sig.contents) return 'no-signature-value';
    const [a, b, c, d] = sig.byteRange;
    if (a !== 0 || c + d !== bytes.length || b > c) return 'byte-range-does-not-cover-file';
    const joined = new Uint8Array(b + d);
    joined.set(bytes.subarray(0, b), 0);
    joined.set(bytes.subarray(c, c + d), b);
    const digest = await sha256(joined);
    return sig.contents.toLowerCase().startsWith(digest) ? 'intact' : 'digest-mismatch';
}

/** Small rendering of one page, for measured visual comparison. */
async function thumbnail(pdfPage, width = 240) {
    const unit = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: width / unit.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    canvas.width = 1; canvas.height = 1;
    let chroma = 0; let ink = 0; let luma = 0;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const bl = data[i + 2];
        if (Math.max(r, g, bl) - Math.min(r, g, bl) > 24) chroma += 1;
        if (r < 200 || g < 200 || bl < 200) ink += 1;
        luma += 0.299 * r + 0.587 * g + 0.114 * bl;
    }
    const px = data.length / 4;
    return {
        width: Math.round(viewport.width), height: Math.round(viewport.height),
        chromaFraction: chroma / px, inkFraction: ink / px, meanLuma: luma / px, data,
    };
}

/** Mean absolute difference between two thumbnails of the same size, 0..255. */
export function visualDiff(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
    let sum = 0; let differing = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
            + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
        sum += d;
        if (d > 32) differing += 1;
    }
    const px = a.data.length / 4;
    return { meanAbs: sum / px, differingFraction: differing / px };
}

export async function inspect(bytes, { render = true } = {}) {
    const report = { bytes: bytes.length };
    let doc;
    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
        report.loadError = String(error?.message ?? error);
        return report;
    }

    const acro = resolveDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
    report.acroForm = acro !== null;
    report.xfa = acro ? acro.get(PDFName.of('XFA')) !== undefined : false;
    report.sigFlags = acro ? str(acro.get(PDFName.of('SigFlags'))) ?? null : null;
    report.fields = acro ? fieldTree(doc, acro) : [];
    report.signatures = [];
    for (const f of report.fields.filter((x) => x.ft === 'Sig')) {
        report.signatures.push({
            name: f.name, hasValue: f.signature !== null,
            state: await signatureState(bytes, f.signature),
        });
    }
    const safe = (fn) => { try { return fn() ?? null; } catch { return null; } };
    report.info = {
        title: safe(() => doc.getTitle()), author: safe(() => doc.getAuthor()),
        subject: safe(() => doc.getSubject()), keywords: safe(() => doc.getKeywords()),
        creator: safe(() => doc.getCreator()), producer: safe(() => doc.getProducer()),
        creationDate: safe(() => doc.getCreationDate()?.toISOString()),
        modDate: safe(() => doc.getModificationDate()?.toISOString()),
    };
    const md = doc.catalog.lookup(PDFName.of('Metadata'));
    const mdBytes = md instanceof PDFStream ? streamBytes(md) : null;
    report.xmpMarker = mdBytes ? new TextDecoder('latin1').decode(mdBytes).includes('M5-XMP-MARKER') : false;

    report.pages = [];
    for (const page of doc.getPages()) {
        const acc = {
            pathOps: 0, paintOps: 0, textShows: 0, colourOps: {}, shadings: 0,
            invisibleTextModes: 0, imageDraws: 0, formDraws: 0, inlineImages: 0,
            unresolvedDo: 0, undecodable: 0, images: new Map(),
        };
        await summariseContent(
            doc, pageContentStreams(doc, page), page.node.Resources(), acc, new Set(),
        );
        const images = [];
        for (const stream of acc.images.values()) {
            const d = stream.dict;
            images.push({
                filter: str(d.get(PDFName.of('Filter'))) ?? str(d.lookup(PDFName.of('Filter'))?.get?.(0)) ?? null,
                width: str(d.get(PDFName.of('Width'))),
                height: str(d.get(PDFName.of('Height'))),
                colorSpace: str(d.get(PDFName.of('ColorSpace'))) ?? '(complex)',
                bpc: str(d.get(PDFName.of('BitsPerComponent'))),
                digest: stream instanceof PDFRawStream ? await sha256(stream.contents) : null,
                encodedBytes: stream instanceof PDFRawStream ? stream.contents.length : null,
            });
        }
        delete acc.images;
        const annots = [];
        const arr = page.node.lookup(PDFName.of('Annots'));
        if (arr instanceof PDFArray) {
            for (const ref of arr.asArray()) {
                const a = resolveDict(doc, ref);
                if (!a) continue;
                const action = resolveDict(doc, a.get(PDFName.of('A')));
                annots.push({
                    subtype: str(a.get(PDFName.of('Subtype'))),
                    rect: a.lookup(PDFName.of('Rect'))?.asArray?.().map((n) => Math.round(n.asNumber() * 100) / 100) ?? null,
                    contents: str(a.get(PDFName.of('Contents'))) ?? null,
                    uri: action ? str(action.get(PDFName.of('URI'))) ?? null : null,
                    ft: str(a.get(PDFName.of('FT'))) ?? null,
                });
            }
        }
        report.pages.push({
            mediaBox: box(page.getMediaBox()),
            cropBox: box(page.getCropBox()),
            rotate: page.getRotation().angle,
            content: acc,
            images,
            annots,
        });
    }

    // What a reader sees and extracts.
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    report.text = [];
    report.pdfjsAnnots = [];
    report.thumbs = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
        const p = await pdf.getPage(n);
        const tc = await p.getTextContent();
        report.text.push(tc.items.map((i) => i.str).join(' '));
        const an = await p.getAnnotations();
        report.pdfjsAnnots.push(an.map((a) => ({
            subtype: a.subtype, url: a.url ?? null, fieldName: a.fieldName ?? null,
            fieldValue: a.fieldValue ?? null,
        })));
        if (render) report.thumbs.push(await thumbnail(p));
        p.cleanup();
    }
    await pdf.destroy();
    return report;
}

/** Strip the pixel arrays before a report is handed back to Node. */
export function portable(report) {
    return {
        ...report,
        thumbs: (report.thumbs ?? []).map(({ data, ...rest }) => rest),
    };
}
