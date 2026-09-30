/**
 * Independent comparison of a source PDF and an optimized output.
 *
 * pdf.js (which shares no code with the optimizer) reopens both and compares,
 * page by page: view box, CropBox-derived view, rotation, the full operator
 * sequence (vectors stay vectors, nothing is flattened), text content, every
 * image's decoded samples (including stencil masks and SMask-composited
 * alpha), annotations (subtype, rect, URL, contents, field name/value), and
 * the document metadata (Info + XMP). pdf-lib reopens the output with
 * throwOnInvalidObject and reports its AcroForm field values. Each decoded
 * image is also hashed against the corpus manifest, which records what the
 * image *is* independently of any viewer.
 *
 * mode 'lossless': every image must be sample-identical.
 * mode 'lossy':    images are compared by metrics instead (see lossy.mjs).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

function rgbaOf(img) {
    const { width, height, kind, data } = img;
    const n = width * height;
    if (kind === 3) return data;
    const out = new Uint8Array(n * 4);
    if (kind === 2) { for (let p = 0, q = 0; p < n; p += 1, q += 3) { out[p * 4] = data[q]; out[p * 4 + 1] = data[q + 1]; out[p * 4 + 2] = data[q + 2]; out[p * 4 + 3] = 255; } return out; }
    if (kind === 1) { // 1-bpp grayscale, packed
        const rowBytes = (width + 7) >> 3;
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
            const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
            const p = (y * width + x) * 4; out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
        }
        return out;
    }
    throw new Error(`image kind ${kind}`);
}

// Without the standard font data, pdf.js in Node stops a page's content at the
// first standard-font text (stopAtErrors), and text and vectors after it are
// silently absent from both sides of a comparison. Instrument defect found by
// verify-selftest.mjs; the data now comes from the installed pdfjs-dist.
const STANDARD_FONTS = `${path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts').split(path.sep).join('/')}/`;

async function open(bytes) {
    return pdfjs.getDocument({
        data: bytes.slice(), isOffscreenCanvasSupported: false, verbosity: 0, stopAtErrors: true,
        standardFontDataUrl: STANDARD_FONTS,
    }).promise;
}

async function pageFacts(doc, n) {
    const page = await doc.getPage(n);
    const ops = await page.getOperatorList();
    const images = [];
    for (let i = 0; i < ops.fnArray.length; i += 1) {
        const fn = ops.fnArray[i];
        if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
            const arg = ops.argsArray[i][0];
            const img = typeof arg === 'string'
                ? await new Promise((r) => (arg.startsWith('g_') ? page.commonObjs : page.objs).get(arg, r))
                : arg;
            images.push({ kind: 'image', w: img.width, h: img.height, rgba: rgbaOf(img) });
        } else if (fn === pdfjs.OPS.paintImageMaskXObject) {
            const img = ops.argsArray[i][0];
            images.push({ kind: 'mask', w: img.width, h: img.height, rgba: new Uint8Array(img.data) });
        }
    }
    const text = (await page.getTextContent()).items.map((t) => t.str).join('|');
    const annots = (await page.getAnnotations()).map((a) => ({
        subtype: a.subtype, rect: a.rect.map((v) => +v.toFixed(2)), url: a.url ?? null,
        contents: a.contentsObj?.str ?? a.contents ?? null, field: a.fieldName ?? null,
        value: a.fieldValue ?? null,
    }));
    // The operator stream with image references abstracted: the sequence of
    // operations and their non-image arguments must be identical.
    // pdf.js puts per-document object ids in arguments (fonts `g_d0_f1`,
    // images `img_p0_1`); they differ between any two loaded documents, so
    // they are normalised before the sequence is compared.
    const opSig = sha(Buffer.from(JSON.stringify(ops.fnArray.map((fn, i) => (
        [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintImageMaskXObject].includes(fn) ? [fn] : [fn, ops.argsArray[i]]
    ))).replace(/"g_d\d+_/g, '"g_d_').replace(/"(g_d_)?img_p\d+_\d+"/g, '"img"').replace(/"p\d+_/g, '"p_')));
    const facts = {
        view: page.view.map((v) => +v.toFixed(3)), rotate: page.rotate, ops: ops.fnArray.length,
        pathOps: ops.fnArray.filter((f) => f === pdfjs.OPS.constructPath).length, opSig,
        text, annots, images,
    };
    page.cleanup();
    return facts;
}

export async function compare(sourceBytes, outputBytes, { mode = 'lossless', manifest = null } = {}) {
    const errors = [];
    const notes = [];
    const src = await open(sourceBytes);
    const out = await open(outputBytes);
    let lib;
    try {
        lib = await PDFDocument.load(outputBytes, { updateMetadata: false, throwOnInvalidObject: true });
    } catch (e) { errors.push(`pdf-lib cannot reopen the output: ${e.message}`); }
    if (src.numPages !== out.numPages) errors.push(`pages ${out.numPages} != ${src.numPages}`);
    const sm = await src.getMetadata();
    const om = await out.getMetadata();
    const pick = (m) => JSON.stringify({ info: Object.fromEntries(Object.entries(m.info ?? {}).filter(([k]) => ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'].includes(k))), xmp: m.metadata ? m.metadata.getRaw?.() ?? null : null });
    if (pick(sm) !== pick(om)) errors.push('document metadata differs');
    const imageResults = [];
    let manifestIdx = 0;
    for (let n = 1; n <= Math.min(src.numPages, out.numPages); n += 1) {
        const a = await pageFacts(src, n);
        const b = await pageFacts(out, n);
        const at = `p${n}`;
        if (JSON.stringify(a.view) !== JSON.stringify(b.view)) errors.push(`${at} view ${b.view} != ${a.view}`);
        if (a.rotate !== b.rotate) errors.push(`${at} rotate ${b.rotate} != ${a.rotate}`);
        if (a.opSig !== b.opSig) errors.push(`${at} operator stream differs (${b.ops} vs ${a.ops} ops, paths ${b.pathOps} vs ${a.pathOps})`);
        if (a.text !== b.text) errors.push(`${at} text differs`);
        if (manifest?.expectText && n === 1 && !a.text.includes(manifest.expectText)) errors.push(`${at} the source's own text was not read (instrument): "${a.text.slice(0, 40)}"`);
        if (JSON.stringify(a.annots) !== JSON.stringify(b.annots)) errors.push(`${at} annotations differ`);
        if (a.images.length !== b.images.length) errors.push(`${at} ${b.images.length} images != ${a.images.length}`);
        for (let i = 0; i < Math.min(a.images.length, b.images.length); i += 1) {
            const x = a.images[i];
            const y = b.images[i];
            const r = { page: n, index: i, kind: x.kind, w: x.w, h: x.h, identical: false };
            if (mode === 'lossy' && x.kind === 'image') {
                // Technical-drawing metrics, nearest-neighbour mapped when resized.
                const sx = y.w / x.w;
                const sy = y.h / x.h;
                let se = 0; let ink = 0; let inkKept = 0; let marks = 0; let marksKept = 0; let falseInk = 0;
                const lum = (a, k) => 0.299 * a[k] + 0.587 * a[k + 1] + 0.114 * a[k + 2];
                for (let yy = 0; yy < x.h; yy += 1) {
                    const oy = Math.min(y.h - 1, Math.floor(yy * sy));
                    for (let xx = 0; xx < x.w; xx += 1) {
                        const k = (yy * x.w + xx) * 4;
                        const q = (oy * y.w + Math.min(y.w - 1, Math.floor(xx * sx))) * 4;
                        for (let c = 0; c < 3; c += 1) se += (x.rgba[k + c] - y.rgba[q + c]) ** 2;
                        const li = lum(x.rgba, k);
                        const lo = lum(y.rgba, q);
                        if (li < 200) { ink += 1; if (lo < 200) inkKept += 1; } else if (lo < 200) falseInk += 1;
                        const sat = Math.max(x.rgba[k], x.rgba[k + 1], x.rgba[k + 2]) - Math.min(x.rgba[k], x.rgba[k + 1], x.rgba[k + 2]);
                        if (sat > 100) {
                            marks += 1;
                            if (Math.max(Math.abs(x.rgba[k] - y.rgba[q]), Math.abs(x.rgba[k + 1] - y.rgba[q + 1]), Math.abs(x.rgba[k + 2] - y.rgba[q + 2])) <= 48) marksKept += 1;
                        }
                    }
                }
                const mse = se / (x.w * x.h * 3);
                r.psnr = mse ? +(10 * Math.log10((255 * 255) / mse)).toFixed(2) : 'identical';
                r.inkRecall = ink ? +(inkKept / ink).toFixed(4) : null;
                r.markRecall = marks ? +(marksKept / marks).toFixed(4) : null;
                r.falseInkPixels = falseInk;
                if (x.w !== y.w || x.h !== y.h) r.resized = `${y.w}x${y.h}`;
                r.hash = sha(y.rgba);
                imageResults.push(r);
                continue;
            }
            if (x.w !== y.w || x.h !== y.h) {
                r.resized = `${y.w}x${y.h}`;
                if (mode === 'lossless') errors.push(`${at} image ${i} ${y.w}x${y.h} != ${x.w}x${x.h}`);
            } else {
                let diff = 0;
                let maxErr = 0;
                for (let k = 0; k < x.rgba.length; k += 1) {
                    const d = Math.abs(x.rgba[k] - y.rgba[k]);
                    if (d) { diff += 1; if (d > maxErr) maxErr = d; }
                }
                r.identical = diff === 0;
                r.differingSamples = diff;
                r.maxError = maxErr;
                if (mode === 'lossless' && diff) errors.push(`${at} image ${i}: ${diff} samples differ (max ${maxErr})`);
            }
            r.hash = sha(y.rgba);
            imageResults.push(r);
        }
        a.images = null;
        b.images = null;
    }
    if (manifest?.images) {
        // Pages whose single image has a known independent hash.
        for (const m of manifest.images) {
            if (!m.rgba || m.alpha) continue; // SMask images decode with composited alpha
            const r = imageResults.find((x) => x.page === m.page && x.index === 0);
            if (r && r.w === m.width && r.hash !== m.rgba && mode === 'lossless') errors.push(`p${m.page} image does not decode to the manifest's samples`);
            if (r) r.manifestMatch = r.hash === m.rgba;
            manifestIdx += 1;
        }
    }
    let fields = null;
    if (lib) {
        try {
            fields = lib.getForm().getFields().map((f) => {
                const t = f.constructor.name;
                return { name: f.getName(), type: t, value: t === 'PDFTextField' ? f.getText() : t === 'PDFCheckBox' ? f.isChecked() : null };
            });
        } catch (e) { notes.push(`form read: ${e.message}`); }
    }
    await src.destroy();
    await out.destroy();
    return { ok: errors.length === 0, errors, notes, images: imageResults, fields };
}
