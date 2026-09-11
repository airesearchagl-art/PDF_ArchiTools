/**
 * Optimize without flattening — candidate O3, to put a number next to O1.
 *
 * Production's 「最適化」 (O1) renders every page to a JPEG. This candidate
 * leaves the document's structure alone and recompresses only what is large
 * and can be decoded exactly: 8-bit DeviceRGB/DeviceGray images in Flate or
 * DCT, without a soft mask. Each is resampled to at most what a full-page
 * placement needs at the target resolution — an upper bound, so an image
 * placed smaller keeps more pixels than it strictly needs — re-encoded as a
 * JPEG, and swapped in only if that is smaller. Everything else is kept as it
 * was and reported, because leaving an image as it was is not a wrong answer
 * for an optimisation the way leaving it in colour is for monochrome.
 *
 * Research code. Not part of the app, and not a claim of readiness.
 */
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFStream, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { imageClass } from './mono-structure.mjs';

function resolve(doc, v) { return v instanceof PDFRef ? doc.context.lookup(v) : v; }

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

export async function optimizeStructural(sourceBytes, { dpi = 150, quality = 0.8 } = {}) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const done = new Map();
    const report = { reencoded: 0, kept: [] };
    const visit = async (resources, maxW, maxH, depth) => {
        const res = resolve(doc, resources);
        const xo = res instanceof PDFDict ? resolve(doc, res.get(PDFName.of('XObject'))) : null;
        if (!(xo instanceof PDFDict)) return;
        for (const [, ref] of xo.entries()) {
            const s = resolve(doc, ref);
            if (!(ref instanceof PDFRef) || !(s instanceof PDFStream) || done.has(ref.toString())) continue;
            done.set(ref.toString(), true);
            const subtype = s.dict.lookup(PDFName.of('Subtype'))?.decodeText?.();
            if (subtype === 'Form' && depth < 8) { await visit(s.dict.get(PDFName.of('Resources')), maxW, maxH, depth + 1); continue; }
            if (subtype !== 'Image') continue;
            const cls = imageClass(doc, s);
            if (cls.startsWith('unsupported') || cls === 'stencil' || s.dict.get(PDFName.of('SMask')) !== undefined) {
                report.kept.push(cls === 'stencil' ? 'stencil mask' : (cls.startsWith('unsupported') ? cls.slice(12) : 'has a soft mask'));
                continue;
            }
            const w = s.dict.lookup(PDFName.of('Width')).asNumber();
            const h = s.dict.lookup(PDFName.of('Height')).asNumber();
            const scale = Math.min(1, maxW / w, maxH / h);
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const rgba = await toRgba(s, cls, w, h);
            const from = document.createElement('canvas');
            from.width = w; from.height = h;
            from.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
            const to = document.createElement('canvas');
            to.width = tw; to.height = th;
            to.getContext('2d').drawImage(from, 0, 0, tw, th);
            from.width = 1; from.height = 1;
            const blob = await new Promise((r) => { to.toBlob(r, 'image/jpeg', quality); });
            to.width = 1; to.height = 1;
            const jpeg = new Uint8Array(await blob.arrayBuffer());
            if (jpeg.length >= s.contents.length) { report.kept.push('already smaller than a JPEG of it'); continue; }
            const entries = {};
            for (const [k, v] of s.dict.entries()) {
                if (!['Filter', 'DecodeParms', 'Length', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent'].includes(k.decodeText())) entries[k.decodeText()] = v;
            }
            doc.context.assign(ref, doc.context.stream(jpeg, {
                ...entries, Filter: PDFName.of('DCTDecode'), Width: PDFNumber.of(tw), Height: PDFNumber.of(th),
                ColorSpace: PDFName.of('DeviceRGB'), BitsPerComponent: PDFNumber.of(8),
            }));
            report.reencoded += 1;
        }
    };
    for (const page of doc.getPages()) {
        await visit(page.node.Resources(), page.getWidth() * dpi / 72, page.getHeight() * dpi / 72, 0);
    }
    const bytes = await doc.save({ useObjectStreams: true });
    return { status: 'OPTIMIZED', bytes, report };
}
