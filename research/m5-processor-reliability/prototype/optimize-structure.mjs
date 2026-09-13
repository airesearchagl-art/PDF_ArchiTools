/**
 * Optimize without flattening — candidate O3, planned across every use.
 *
 * Production's 「最適化」 (O1) renders every page to a JPEG. This candidate
 * leaves the document's structure alone and recompresses only images it can
 * decode exactly: 8-bit DeviceRGB/DeviceGray in Flate or DCT, without a soft
 * mask.
 *
 * How many pixels an image may keep is decided *before* anything is rewritten,
 * from every place it is drawn:
 *
 *   - each page content stream is walked with its graphics-state stack; a
 *     `cm` multiplies the CTM, a Form XObject `Do` recurses under the form's
 *     /Matrix, an image `Do` records the size the unit square is mapped to;
 *   - an image's required resolution is the largest over all its uses, so the
 *     answer cannot depend on which page happens to come first;
 *   - a use the walk cannot size — an annotation appearance, a stream whose
 *     q/Q underflows, a degenerate matrix, an image found in resources but
 *     never drawn — makes the image *uncertain*, and an uncertain image is
 *     never downsampled.
 *
 * The earlier first-encounter planner (a full-page bound on the first page
 * that met the image) is kept as `planner: 'first-use'` so the gate can show
 * what it got wrong.
 *
 * What is written is lossy when `codec` is 'jpeg': O3 changes raster pixels on
 * purpose. How much is measured by the gate, and whether that is acceptable
 * is a Human decision (H2b).
 *
 * Research code. Not part of the app, and not a claim of readiness.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { imageClass, lex } from './mono-structure.mjs';

function resolve(doc, v) { return v instanceof PDFRef ? doc.context.lookup(v) : v; }
const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

function streamText(stream) {
    try { return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()); } catch { return null; }
}

/**
 * Every use of every image XObject, with the points each use needs.
 * @returns {Map<string, { ref, stream, uses: {page:number, w:number, h:number}[], uncertain: string[] }>}
 */
export function planImageUses(doc) {
    const images = new Map();
    const entry = (ref, stream) => {
        const key = ref.toString();
        if (!images.has(key)) images.set(key, { ref, stream, uses: [], uncertain: [] });
        return images.get(key);
    };
    const walk = (streams, resources, ctm0, page, depth, via) => {
        const res = resolve(doc, resources);
        const xo = res instanceof PDFDict ? resolve(doc, res.get(PDFName.of('XObject'))) : null;
        for (const stream of streams) {
            const text = streamText(stream);
            if (text === null) continue;
            const tokens = lex(text);
            const stack = [];
            let ctm = ctm0;
            let broken = false;
            for (let i = 0; i < tokens.length; i += 1) {
                const t = tokens[i];
                if (t.type !== 'op') continue;
                if (t.value === 'q') stack.push(ctm);
                else if (t.value === 'Q') { if (stack.length === 0) broken = true; else ctm = stack.pop(); }
                else if (t.value === 'cm') {
                    const n = tokens.slice(i - 6, i).map((x) => x.value);
                    if (n.length === 6 && n.every((x) => typeof x === 'number')) ctm = mul(n, ctm);
                    else broken = true;
                } else if (t.value === 'Do' && tokens[i - 1]?.type === 'name' && xo instanceof PDFDict) {
                    const ref = xo.get(PDFName.of(tokens[i - 1].value));
                    const s = resolve(doc, ref);
                    if (!(ref instanceof PDFRef) || !(s instanceof PDFStream)) continue;
                    const subtype = s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.();
                    if (subtype === 'Image') {
                        const e = entry(ref, s);
                        const w = Math.hypot(ctm[0], ctm[1]);
                        const h = Math.hypot(ctm[2], ctm[3]);
                        if (broken) e.uncertain.push(`${via}: drawn after the graphics-state stack underflowed`);
                        else if (!(w > 0 && h > 0)) e.uncertain.push(`${via}: degenerate matrix`);
                        else e.uses.push({ page, w, h });
                    } else if (subtype === 'Form' && depth < 12) {
                        const m = s.dict.lookup(PDFName.of('Matrix'));
                        const fm = m instanceof PDFArray ? m.asArray().map((x) => x.asNumber()) : [1, 0, 0, 1, 0, 0];
                        walk([s], s.dict.get(PDFName.of('Resources')) ?? resources, mul(fm, ctm), page, depth + 1,
                            `${via} > form ${tokens[i - 1].value}`);
                    }
                }
            }
        }
    };
    doc.getPages().forEach((page, index) => {
        const c = page.node.get(PDFName.of('Contents'));
        const list = resolve(doc, c);
        const streams = (list instanceof PDFArray ? list.asArray() : [c]).map((r) => resolve(doc, r))
            .filter((s) => s instanceof PDFStream);
        walk(streams, page.node.Resources(), [1, 0, 0, 1, 0, 0], index + 1, 0, `p${index + 1}`);
        // Annotation appearances: drawn at a size the page content does not
        // state. Whatever images they reach are uncertain.
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) return;
        const mark = (res, depth) => {
            const xo = resolve(doc, resolve(doc, res)?.get?.(PDFName.of('XObject')));
            if (!(xo instanceof PDFDict) || depth > 12) return;
            for (const [, ref] of xo.entries()) {
                const s = resolve(doc, ref);
                if (!(ref instanceof PDFRef) || !(s instanceof PDFStream)) continue;
                const subtype = s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.();
                if (subtype === 'Image') entry(ref, s).uncertain.push(`p${index + 1}: drawn by an annotation appearance`);
                else if (subtype === 'Form') mark(s.dict.get(PDFName.of('Resources')), depth + 1);
            }
        };
        for (const aref of annots.asArray()) {
            const ap = resolve(doc, resolve(doc, aref)?.get?.(PDFName.of('AP')));
            if (!(ap instanceof PDFDict)) continue;
            for (const [, v] of ap.entries()) {
                const s = resolve(doc, v);
                const forms = s instanceof PDFStream ? [s] : (s instanceof PDFDict ? s.values().map((x) => resolve(doc, x)) : []);
                for (const f of forms) if (f instanceof PDFStream) mark(f.dict.get(PDFName.of('Resources')), 0);
            }
        }
    });
    // Images present in resources but never seen drawn: nothing says how big.
    for (const obj of doc.context.enumerateIndirectObjects()) {
        const [ref, s] = obj;
        if (!(s instanceof PDFStream)) continue;
        if (s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.() !== 'Image') continue;
        if (s.dict.get(PDFName.of('SMask')) !== undefined) {
            const mask = s.dict.get(PDFName.of('SMask'));
            if (mask instanceof PDFRef) entry(mask, resolve(doc, mask)).uncertain.push('a soft mask of another image');
        }
        const e = entry(ref, s);
        if (e.uses.length === 0 && e.uncertain.length === 0) e.uncertain.push('never drawn by page content');
    }
    return images;
}

async function toRgba(stream, cls, w, h) {
    if (cls.startsWith('flate')) {
        const raw = decodePDFRawStream(stream).decode();
        const grey = cls.endsWith('DeviceGray');
        const out = new Uint8ClampedArray(w * h * 4);
        for (let p = 0; p < w * h; p += 1) {
            const i = grey ? p : p * 3;
            out[p * 4] = raw[i];
            out[p * 4 + 1] = grey ? raw[i] : raw[i + 1];
            out[p * 4 + 2] = grey ? raw[i] : raw[i + 2];
            out[p * 4 + 3] = 255;
        }
        return out;
    }
    const bitmap = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    c.width = 1; c.height = 1;
    return data;
}

/**
 * @param {{ dpi?: number, quality?: number, codec?: 'jpeg'|'flate', planner?: 'all-uses'|'first-use' }} options
 */
export async function optimizeStructural(sourceBytes, {
    dpi = 150, quality = 0.8, codec = 'jpeg', planner = 'all-uses',
} = {}) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const report = { reencoded: 0, kept: [], decisions: [] };
    let targets;
    if (planner === 'all-uses') {
        targets = new Map();
        for (const [key, e] of planImageUses(doc)) {
            const w = e.stream.dict.lookup(PDFName.of('Width'))?.asNumber?.() ?? 0;
            const h = e.stream.dict.lookup(PDFName.of('Height'))?.asNumber?.() ?? 0;
            if (e.uncertain.length > 0 || e.uses.length === 0) {
                targets.set(key, { ref: e.ref, stream: e.stream, scale: 1, uncertain: e.uncertain });
                continue;
            }
            // Keep enough pixels for the most demanding use, on both axes.
            const needW = Math.max(...e.uses.map((u) => u.w)) * dpi / 72;
            const needH = Math.max(...e.uses.map((u) => u.h)) * dpi / 72;
            targets.set(key, { ref: e.ref, stream: e.stream, scale: Math.min(1, Math.max(needW / w, needH / h)), uses: e.uses.length });
        }
    } else {
        // The first-encounter planner: a full-page bound on whichever page met
        // the image first.
        targets = new Map();
        for (const page of doc.getPages()) {
            const res = page.node.Resources();
            const xo = resolve(doc, res?.get?.(PDFName.of('XObject')));
            const visit = (dict, depth) => {
                if (!(dict instanceof PDFDict) || depth > 8) return;
                for (const [, ref] of dict.entries()) {
                    const s = resolve(doc, ref);
                    if (!(ref instanceof PDFRef) || !(s instanceof PDFStream) || targets.has(ref.toString())) continue;
                    const subtype = s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.();
                    if (subtype === 'Form') { visit(resolve(doc, resolve(doc, s.dict.get(PDFName.of('Resources')))?.get?.(PDFName.of('XObject'))), depth + 1); continue; }
                    if (subtype !== 'Image') continue;
                    const w = s.dict.lookup(PDFName.of('Width')).asNumber();
                    const h = s.dict.lookup(PDFName.of('Height')).asNumber();
                    const maxW = page.getWidth() * dpi / 72;
                    const maxH = page.getHeight() * dpi / 72;
                    targets.set(ref.toString(), { ref, stream: s, scale: Math.min(1, maxW / w, maxH / h) });
                }
            };
            visit(xo, 0);
        }
    }

    for (const [key, t] of targets) {
        const s = t.stream;
        const cls = imageClass(doc, s);
        const w = s.dict.lookup(PDFName.of('Width'))?.asNumber?.() ?? 0;
        const h = s.dict.lookup(PDFName.of('Height'))?.asNumber?.() ?? 0;
        const decision = { image: key, width: w, height: h, uncertain: t.uncertain ?? [], uses: t.uses ?? null };
        report.decisions.push(decision);
        if (cls.startsWith('unsupported') || cls === 'stencil' || s.dict.get(PDFName.of('SMask')) !== undefined) {
            decision.action = 'kept';
            decision.why = cls === 'stencil' ? 'stencil mask' : (cls.startsWith('unsupported') ? cls.slice(12) : 'has a soft mask');
            report.kept.push(decision.why);
            continue;
        }
        const tw = Math.max(1, Math.round(w * t.scale));
        const th = Math.max(1, Math.round(h * t.scale));
        const rgba = await toRgba(s, cls, w, h);
        const from = document.createElement('canvas');
        from.width = w; from.height = h;
        from.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
        const to = document.createElement('canvas');
        to.width = tw; to.height = th;
        const tctx = to.getContext('2d', { willReadFrequently: true });
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(from, 0, 0, tw, th);
        from.width = 1; from.height = 1;
        let bytes;
        let dict;
        if (codec === 'jpeg') {
            const blob = await new Promise((r) => { to.toBlob(r, 'image/jpeg', quality); });
            bytes = new Uint8Array(await blob.arrayBuffer());
            dict = { Filter: PDFName.of('DCTDecode') };
        } else {
            const px = tctx.getImageData(0, 0, tw, th).data;
            const rgb = new Uint8Array(tw * th * 3);
            for (let p = 0; p < tw * th; p += 1) {
                rgb[p * 3] = px[p * 4]; rgb[p * 3 + 1] = px[p * 4 + 1]; rgb[p * 3 + 2] = px[p * 4 + 2];
            }
            bytes = rgb;
            dict = null;
        }
        to.width = 1; to.height = 1;
        const entries = {};
        for (const [k, v] of s.dict.entries()) {
            if (!['Filter', 'DecodeParms', 'Length', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent'].includes(k.decodeText())) entries[k.decodeText()] = v;
        }
        Object.assign(entries, {
            Width: PDFNumber.of(tw), Height: PDFNumber.of(th),
            ColorSpace: PDFName.of('DeviceRGB'), BitsPerComponent: PDFNumber.of(8),
        });
        const replacement = dict ? doc.context.stream(bytes, { ...entries, ...dict }) : doc.context.flateStream(bytes, entries);
        // Only ever swapped in when smaller: an optimisation that grows a
        // file has failed at the one thing it promised.
        if (replacement.contents.length >= s.contents.length) {
            decision.action = 'kept';
            decision.why = 'recompressing would not make it smaller';
            report.kept.push(decision.why);
            continue;
        }
        doc.context.assign(t.ref, replacement);
        decision.action = 'reencoded';
        decision.to = [tw, th];
        report.reencoded += 1;
    }
    const bytes = await doc.save({ useObjectStreams: true });
    return { status: 'OPTIMIZED', bytes, report };
}
