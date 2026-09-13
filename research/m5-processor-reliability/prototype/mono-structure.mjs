/**
 * Monochrome without rasterising — candidates B and C.
 *
 * Candidate A (production) renders each page to pixels and writes a new PDF of
 * JPEGs. These candidates instead rewrite the colour the document asks for:
 *
 *   B — content-stream colour operators only. Vectors and text keep their
 *       operators; a page that draws an image is refused, because leaving the
 *       image in colour is a partial conversion that reports success.
 *   C — B, plus image XObjects of a class this prototype can decode exactly,
 *       re-encoded as 8-bit DeviceGray Flate. Anything else is refused.
 *
 * The plan comes first and is total: every content stream, every Form XObject
 * it reaches, every annotation appearance is examined, and a single
 * unsupported construct refuses the whole document with no bytes. Only then is
 * anything rewritten. That is the difference between "cannot safely process"
 * and "processed, mostly".
 *
 * Luma matches production (0.299 R + 0.587 G + 0.114 B) and so does contrast,
 * so the colour decision is the same; what differs is what survives.
 *
 * Research code. Not part of the app, and not a claim of readiness.
 */
import {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream,
    PDFNumber, PDFString, decodePDFRawStream,
} from 'pdf-lib';

// ---------------------------------------------------------------------------
// A content-stream lexer that keeps byte positions, so a rewrite touches only
// the operands it means to.
// ---------------------------------------------------------------------------
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0']);

export function lex(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const ch = src[i];
        if (WS.has(ch)) { i += 1; continue; }
        if (ch === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1; continue; }
        const start = i;
        if (ch === '(') {
            let depth = 0;
            for (; i < n; i += 1) {
                if (src[i] === '\\') { i += 1; continue; }
                if (src[i] === '(') depth += 1;
                else if (src[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
            }
            tokens.push({ type: 'string', start, end: i });
            continue;
        }
        if (ch === '<' && src[i + 1] === '<') { tokens.push({ type: 'dict<', start, end: i + 2 }); i += 2; continue; }
        if (ch === '>' && src[i + 1] === '>') { tokens.push({ type: 'dict>', start, end: i + 2 }); i += 2; continue; }
        if (ch === '<') {
            const close = src.indexOf('>', i);
            i = close === -1 ? n : close + 1;
            tokens.push({ type: 'string', start, end: i });
            continue;
        }
        if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
            tokens.push({ type: ch, start, end: i + 1 }); i += 1; continue;
        }
        if (ch === '/') {
            i += 1;
            while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i += 1;
            tokens.push({ type: 'name', value: src.slice(start + 1, i), start, end: i });
            continue;
        }
        while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i += 1;
        const word = src.slice(start, i);
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
            tokens.push({ type: 'number', value: Number(word), start, end: i });
        } else {
            tokens.push({ type: 'op', value: word, start, end: i });
            if (word === 'ID') {
                // Inline image data: skip to EI. The plan refuses inline images,
                // so this only has to keep the lexer from reading binary.
                const ei = src.indexOf('EI', i);
                i = ei === -1 ? n : ei;
            }
        }
    }
    return tokens;
}

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const contrastOf = (y, contrast) => clamp01(((y * 255 - 128) * contrast + 128) / 255);
const cmykToY = (c, m, y, k) => luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
const fmt = (v) => (Math.round(v * 10000) / 10000).toString();

const decodeLatin1 = (bytes) => new TextDecoder('latin1').decode(bytes);
const encodeLatin1 = (text) => {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function resolve(doc, v) { return v instanceof PDFRef ? doc.context.lookup(v) : v; }
function dictOf(doc, v) { const r = resolve(doc, v); return r instanceof PDFDict ? r : null; }
function nameOf(v) { return v instanceof PDFName ? v.decodeText() : null; }

/** A named colour space resource, reduced to what this prototype can convert. */
function colourSpaceClass(doc, resources, name) {
    if (['DeviceRGB', 'DeviceCMYK', 'DeviceGray', 'RGB', 'CMYK', 'G'].includes(name)) {
        return { DeviceRGB: 'rgb', RGB: 'rgb', DeviceCMYK: 'cmyk', CMYK: 'cmyk', DeviceGray: 'gray', G: 'gray' }[name];
    }
    if (name === 'Pattern') return 'unsupported:Pattern';
    const cs = dictOf(doc, resources)?.lookup(PDFName.of('ColorSpace'));
    const entry = cs instanceof PDFDict ? resolve(doc, cs.get(PDFName.of(name))) : undefined;
    const family = entry instanceof PDFArray ? nameOf(resolve(doc, entry.get(0))) : nameOf(entry);
    if (family === 'DeviceRGB') return 'rgb';
    if (family === 'DeviceCMYK') return 'cmyk';
    if (family === 'DeviceGray') return 'gray';
    return `unsupported:${family ?? 'unknown'}`;
}

export function imageClass(doc, stream) {
    const d = stream.dict;
    if (d.get(PDFName.of('ImageMask'))?.toString() === 'true') return 'stencil';
    const filter = resolve(doc, d.get(PDFName.of('Filter')));
    const filters = filter instanceof PDFArray ? filter.asArray().map((f) => nameOf(resolve(doc, f))) : [nameOf(filter)];
    const cs = nameOf(resolve(doc, d.get(PDFName.of('ColorSpace'))));
    const bpc = resolve(doc, d.get(PDFName.of('BitsPerComponent')))?.asNumber?.();
    const parms = dictOf(doc, d.get(PDFName.of('DecodeParms')));
    const predictor = parms?.lookup(PDFName.of('Predictor'))?.asNumber?.() ?? 1;
    if (d.get(PDFName.of('Decode')) !== undefined) return 'unsupported:Decode array';
    if (bpc !== 8) return `unsupported:${bpc}-bit`;
    if (cs !== 'DeviceRGB' && cs !== 'DeviceGray') return `unsupported:colour space ${cs ?? '(complex)'}`;
    if (filters.length === 1 && filters[0] === 'FlateDecode' && predictor === 1) return `flate-${cs}`;
    if (filters.length === 1 && filters[0] === 'DCTDecode') return `dct-${cs}`;
    return `unsupported:filter ${filters.join('+') || 'none'}${predictor !== 1 ? ` predictor ${predictor}` : ''}`;
}

/**
 * Everything the document draws, examined before anything is written.
 * Returns the work to do, or the reasons it cannot be done.
 */
export function planMonochrome(doc, { images }) {
    const refusals = [];
    const streams = new Map();   // ref string -> { ref, stream, resources, where }
    const imageWork = new Map(); // ref string -> { ref, stream, cls }
    const visitedForms = new Set();

    const visitStream = (ref, stream, resources, where, depth) => {
        const key = ref.toString();
        if (streams.has(key)) return;
        if (!(stream instanceof PDFRawStream)) { refusals.push(`${where}: stream is not decodable here`); return; }
        let bytes;
        try { bytes = decodePDFRawStream(stream).decode(); } catch (e) {
            refusals.push(`${where}: content stream cannot be decoded (${e?.message ?? e})`); return;
        }
        streams.set(key, { ref, stream, resources, where, text: decodeLatin1(bytes) });
        const tokens = lex(streams.get(key).text);
        const res = dictOf(doc, resources);
        const xobjects = res ? dictOf(doc, res.get(PDFName.of('XObject'))) : null;
        const fonts = res ? dictOf(doc, res.get(PDFName.of('Font'))) : null;
        const gstates = res ? dictOf(doc, res.get(PDFName.of('ExtGState'))) : null;
        for (let i = 0; i < tokens.length; i += 1) {
            const t = tokens[i];
            if (t.type !== 'op') continue;
            if (t.value === 'sh') refusals.push(`${where}: shading (sh) — gradients are not converted`);
            if (t.value === 'BI') refusals.push(`${where}: inline image — not converted`);
            if ((t.value === 'cs' || t.value === 'CS') && tokens[i - 1]?.type === 'name') {
                const cls = colourSpaceClass(doc, resources, tokens[i - 1].value);
                if (cls.startsWith('unsupported')) refusals.push(`${where}: colour space ${cls.slice(12)}`);
            }
            if ((t.value === 'scn' || t.value === 'SCN') && tokens[i - 1]?.type === 'name') {
                refusals.push(`${where}: pattern colour — not converted`);
            }
            if (t.value === 'gs' && tokens[i - 1]?.type === 'name') {
                const g = gstates ? dictOf(doc, gstates.get(PDFName.of(tokens[i - 1].value))) : null;
                const smask = g ? resolve(doc, g.get(PDFName.of('SMask'))) : undefined;
                if (smask instanceof PDFDict) refusals.push(`${where}: soft mask — not converted`);
            }
            if (t.value === 'Tf' && tokens[i - 2]?.type === 'name' && fonts) {
                const f = dictOf(doc, fonts.get(PDFName.of(tokens[i - 2].value)));
                if (nameOf(f?.get(PDFName.of('Subtype'))) === 'Type3') {
                    refusals.push(`${where}: Type3 font — glyph procedures carry their own colour`);
                }
            }
            if (t.value === 'Do' && tokens[i - 1]?.type === 'name' && xobjects) {
                const xref = xobjects.get(PDFName.of(tokens[i - 1].value));
                const xs = resolve(doc, xref);
                if (!(xs instanceof PDFStream) || !(xref instanceof PDFRef)) continue;
                const subtype = nameOf(xs.dict.get(PDFName.of('Subtype')));
                if (subtype === 'Form') {
                    if (visitedForms.has(xref.toString()) || depth > 8) continue;
                    visitedForms.add(xref.toString());
                    visitStream(xref, xs, xs.dict.get(PDFName.of('Resources')) ?? resources,
                        `${where} > form ${tokens[i - 1].value}`, depth + 1);
                } else if (subtype === 'Image') {
                    const cls = imageClass(doc, xs);
                    if (cls === 'stencil') continue; // painted in the fill colour, which is converted
                    if (images === 'refuse') {
                        refusals.push(`${where}: image ${tokens[i - 1].value} — candidate B converts no images`);
                    } else if (cls.startsWith('unsupported')) {
                        refusals.push(`${where}: image ${tokens[i - 1].value} ${cls.slice(12)}`);
                    } else {
                        imageWork.set(xref.toString(), { ref: xref, stream: xs, cls });
                    }
                }
            }
        }
    };

    doc.getPages().forEach((page, index) => {
        const where = `p${index + 1}`;
        const c = page.node.get(PDFName.of('Contents'));
        const refs = c instanceof PDFArray ? c.asArray() : [c];
        for (const ref of refs) {
            const s = resolve(doc, ref);
            if (ref instanceof PDFRef && s instanceof PDFStream) visitStream(ref, s, page.node.Resources(), where, 0);
        }
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots instanceof PDFArray) {
            for (const aref of annots.asArray()) {
                const a = dictOf(doc, aref);
                const ap = a ? dictOf(doc, a.get(PDFName.of('AP'))) : null;
                if (!ap) continue;
                for (const state of ['N', 'R', 'D']) {
                    const entry = ap.get(PDFName.of(state));
                    const resolved = resolve(doc, entry);
                    const list = resolved instanceof PDFDict && !(resolved instanceof PDFStream)
                        ? resolved.values() : [entry];
                    for (const r of list) {
                        const s = resolve(doc, r);
                        if (r instanceof PDFRef && s instanceof PDFStream) {
                            visitStream(r, s, s.dict.get(PDFName.of('Resources')), `${where} annotation /AP /${state}`, 1);
                        }
                    }
                }
            }
        }
    });
    return { refusals, streams, imageWork };
}

/** Rewrite one content stream's colour operators, keeping everything else byte for byte. */
export function rewriteColour(text, contrast, csClass) {
    const tokens = lex(text);
    const edits = [];
    let fill = 'gray';
    let stroke = 'gray';
    let operandsFrom = 0;
    for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];
        if (t.type !== 'op') continue;
        const nums = [];
        for (let j = i - 1; j >= operandsFrom && tokens[j].type === 'number'; j -= 1) nums.unshift(tokens[j]);
        const span = (k) => ({ start: nums[nums.length - k].start, end: t.end });
        const put = (k, y, op) => edits.push({ ...span(k), text: `${fmt(y)} ${op}` });
        switch (t.value) {
            case 'rg': case 'RG':
                if (nums.length >= 3) {
                    const [r, g, b] = nums.slice(-3).map((x) => x.value);
                    put(3, contrastOf(luma(r, g, b), contrast), t.value === 'rg' ? 'g' : 'G');
                }
                break;
            case 'k': case 'K':
                if (nums.length >= 4) {
                    const [c, m, y, k] = nums.slice(-4).map((x) => x.value);
                    put(4, contrastOf(cmykToY(c, m, y, k), contrast), t.value === 'k' ? 'g' : 'G');
                }
                break;
            case 'g': case 'G':
                if (nums.length >= 1 && contrast !== 1) put(1, contrastOf(nums[nums.length - 1].value, contrast), t.value);
                break;
            case 'cs': case 'CS': {
                const prev = tokens[i - 1];
                if (prev?.type === 'name') {
                    const cls = csClass(prev.value);
                    if (t.value === 'cs') fill = cls; else stroke = cls;
                    edits.push({ start: prev.start, end: t.end, text: `/DeviceGray ${t.value}` });
                }
                break;
            }
            case 'sc': case 'SC': case 'scn': case 'SCN': {
                const cls = (t.value === 'sc' || t.value === 'scn') ? fill : stroke;
                const n = { rgb: 3, cmyk: 4, gray: 1 }[cls] ?? 0;
                if (n && nums.length >= n) {
                    const v = nums.slice(-n).map((x) => x.value);
                    const y = cls === 'rgb' ? luma(...v) : (cls === 'cmyk' ? cmykToY(...v) : v[0]);
                    put(n, contrastOf(y, contrast), t.value);
                }
                break;
            }
            default: break;
        }
        operandsFrom = i + 1;
    }
    if (edits.length === 0) return { text, edits: 0 };
    let out = '';
    let at = 0;
    for (const e of edits.sort((a, b) => a.start - b.start)) {
        out += text.slice(at, e.start) + e.text;
        at = e.end;
    }
    return { text: out + text.slice(at), edits: edits.length };
}

function replaceStream(doc, ref, oldStream, bytes, extra = {}) {
    const entries = {};
    for (const [k, v] of oldStream.dict.entries()) {
        const key = k.decodeText();
        if (['Filter', 'DecodeParms', 'Length'].includes(key)) continue;
        entries[key] = v;
    }
    Object.assign(entries, extra);
    doc.context.assign(ref, doc.context.flateStream(bytes, entries));
}

/** Decode an image of a supported class to grey pixels, 8 bits each. */
async function greyPixels(doc, stream, cls, contrast) {
    const w = stream.dict.lookup(PDFName.of('Width')).asNumber();
    const h = stream.dict.lookup(PDFName.of('Height')).asNumber();
    let rgb;
    let channels;
    if (cls.startsWith('flate')) {
        rgb = decodePDFRawStream(stream).decode();
        channels = cls.endsWith('DeviceRGB') ? 3 : 1;
    } else {
        const bitmap = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        rgb = ctx.getImageData(0, 0, w, h).data;
        canvas.width = 1; canvas.height = 1;
        channels = 4;
    }
    if (rgb.length < w * h * channels) throw new Error(`image decodes to ${rgb.length} bytes, expected ${w * h * channels}`);
    const grey = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p += 1) {
        const i = p * channels;
        const y = channels === 1 ? rgb[i] / 255 : luma(rgb[i], rgb[i + 1], rgb[i + 2]) / 255;
        grey[p] = Math.round(contrastOf(y, contrast) * 255);
    }
    return grey;
}

/** Annotation colour entries viewers use when they regenerate an appearance. */
function greyAnnotationColours(doc, contrast) {
    let n = 0;
    const greyArray = (arr) => {
        const v = arr.asArray().map((x) => x.asNumber?.() ?? 0);
        if (v.length === 3) return [contrastOf(luma(...v), contrast)];
        if (v.length === 4) return [contrastOf(cmykToY(...v), contrast)];
        return null;
    };
    for (const page of doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (const aref of annots.asArray()) {
            const a = dictOf(doc, aref);
            if (!a) continue;
            for (const key of ['C', 'IC']) {
                const arr = a.lookup(PDFName.of(key));
                const g = arr instanceof PDFArray ? greyArray(arr) : null;
                if (g) { a.set(PDFName.of(key), doc.context.obj(g)); n += 1; }
            }
            const mk = dictOf(doc, a.get(PDFName.of('MK')));
            for (const key of ['BC', 'BG']) {
                const arr = mk?.lookup(PDFName.of(key));
                const g = arr instanceof PDFArray ? greyArray(arr) : null;
                if (g) { mk.set(PDFName.of(key), doc.context.obj(g)); n += 1; }
            }
            const da = a.get(PDFName.of('DA'));
            if (da instanceof PDFString) {
                const rewritten = rewriteColour(da.decodeText(), contrast, () => 'gray');
                if (rewritten.edits) { a.set(PDFName.of('DA'), PDFString.of(rewritten.text)); n += 1; }
            }
        }
    }
    return n;
}

/**
 * Plan, then — only if nothing was refused — convert.
 * @returns {{ status: 'CONVERTED'|'REFUSED', refusals: string[], bytes: Uint8Array|null, stats: object }}
 */
export async function monochromeStructural(sourceBytes, { images = 'refuse', contrast = 1 } = {}) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const plan = planMonochrome(doc, { images });
    const stats = { streams: plan.streams.size, images: plan.imageWork.size, colourEdits: 0, annotationColours: 0 };
    if (plan.refusals.length > 0) {
        return { status: 'REFUSED', refusals: [...new Set(plan.refusals)], bytes: null, stats };
    }
    for (const { ref, stream, resources, text } of plan.streams.values()) {
        const csClass = (name) => colourSpaceClass(doc, resources, name);
        const rewritten = rewriteColour(text, contrast, csClass);
        stats.colourEdits += rewritten.edits;
        if (rewritten.edits) replaceStream(doc, ref, stream, encodeLatin1(rewritten.text));
    }
    for (const { ref, stream, cls } of plan.imageWork.values()) {
        const grey = await greyPixels(doc, stream, cls, contrast);
        replaceStream(doc, ref, stream, grey, {
            ColorSpace: PDFName.of('DeviceGray'), BitsPerComponent: PDFNumber.of(8),
        });
    }
    stats.annotationColours = greyAnnotationColours(doc, contrast);
    const bytes = await doc.save();
    return { status: 'CONVERTED', refusals: [], bytes, stats };
}
