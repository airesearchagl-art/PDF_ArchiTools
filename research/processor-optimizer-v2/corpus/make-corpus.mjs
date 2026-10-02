/**
 * Synthetic corpus for the Optimizer v2 research. Generated at run time into
 * out/corpus (git-ignored); no customer or real-project document is used.
 *
 * Every image written here has its decoded samples recorded independently in
 * out/corpus/manifest.json (sha256 of the RGBA the image should decode to), so
 * an optimizer's output can be checked against what the image *is*, not only
 * against what a viewer showed for the source.
 *
 *   f01-comparator-a1-150   A1 x 5 @150 dpi, old Comparator layout: one raw
 *                           (unfiltered) DeviceRGB image per page + a
 *                           Helvetica verdict line. ~261 MB. The primary target.
 *   f02-dense-drawing       A1 dense plan rendered at 150 dpi (anti-aliased
 *                           greys), DeviceRGB, FlateDecode without predictor.
 *   f03-schedule            A1 portrait schedule rendered at 150 dpi, raw RGB.
 *   f04-gray-scan           the schedule as a noisy grey scan, DeviceGray Flate.
 *   f05-photo               A4 @300 dpi photographic colour field, RGB Flate.
 *   f06-jpeg                the same photo as DCTDecode (q 85).
 *   f07-mixed               native text, vector paths, a raw RGB image, a page
 *                           rotated 90 with a CropBox.
 *   f08-shared              one raw RGB image object on three pages and inside
 *                           a Form XObject on a fourth.
 *   f09-smask               RGB image with an 8-bit SMask (both raw).
 *   f10-structure           Info + XMP metadata, a URI link, a text annotation,
 *                           an AcroForm text field and checkbox, one raw image.
 *   f11-classes             one page per image class: Indexed, Decode array,
 *                           colour-key Mask, ImageMask, ICCBased RGB, 16-bit,
 *                           Interpolate, 1-bit gray, ASCIIHex+Flate filter
 *                           chain, CMYK.
 *   f12-interpolate         4-colour DeviceRGB raw twice: /Interpolate true
 *                           (R2 forbidden) and the same samples without it.
 *
 * Run: node corpus/make-corpus.mjs [--only f01]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFString, PDFHexString,
    StandardFonts, rgb, degrees,
} from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const OUT = path.join(ROOT, 'out', 'corpus');
fs.mkdirSync(OUT, { recursive: true });
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
// Importing the Processor points pdf.js at the app's browser worker path; in
// Node the fake worker needs the legacy worker file instead.
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(REPO, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')).href;
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };
const ONLY = arg('only', null);
const manifest = fs.existsSync(path.join(OUT, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : {};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

/** RGBA -> the decoded RGBA an RGB image of these samples should give (alpha 255). */
const rgbaHash = (rgba) => {
    const c = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
    const out = Buffer.alloc(c.length);
    for (let i = 0; i < c.length; i += 4) { out[i] = c[i]; out[i + 1] = c[i + 1]; out[i + 2] = c[i + 2]; out[i + 3] = 255; }
    return sha(out);
};
const toRgb = (rgba) => {
    const out = Buffer.alloc((rgba.length / 4) * 3);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) { out[q] = rgba[p]; out[q + 1] = rgba[p + 1]; out[q + 2] = rgba[p + 2]; }
    return out;
};
const toGray = (rgba) => {
    const out = Buffer.alloc(rgba.length / 4);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q += 1) out[q] = rgba[p];
    return out;
};

// ---------------------------------------------------------------- rendering
async function loadPdf(file) {
    return pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
}
async function render(pdf, n, dpi) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const rgba = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 1;
    return { rgba, w, h };
}

// ------------------------------------------------------------- PDF building
/** A raw image stream registered in `doc`; returns its ref. */
function imageObject(doc, samples, dict) {
    const d = { Type: 'XObject', Subtype: 'Image', ...dict };
    const stream = doc.context.stream(samples, d);
    return doc.context.register(stream);
}
function flate(buf) { return zlib.deflateSync(buf, { level: 6 }); }

/** A page that draws one image full-bleed, optionally with a verdict line. */
function imagePage(doc, font, widthPt, heightPt, ref, title) {
    const page = doc.addPage([widthPt, heightPt]);
    page.node.setXObject(PDFName.of('Im0'), ref);
    let ops = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im0 Do Q\n`;
    if (title) {
        const fontKey = page.node.newFontDictionary('F1', font.ref);
        ops += `BT /${fontKey.asString().slice(1)} 9 Tf 0 g 8 ${heightPt - 14} Td (${title}) Tj ET\n`;
    }
    const content = doc.context.register(doc.context.stream(ops, {}));
    page.node.set(PDFName.of('Contents'), content);
    return page;
}

async function save(name, doc, images, expectText = null) {
    doc.setCreationDate(new Date(0));
    doc.setModificationDate(new Date(0));
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    // expectText: what page 1's text must contain, so a verifier that reads
    // nothing (a missing font, a stopped content stream) fails instead of
    // comparing two empty strings.
    manifest[name] = { bytes: bytes.length, images, expectText };
    console.log(`${name}.pdf  ${bytes.length.toLocaleString('en-US')} bytes, ${images.length} image(s)`);
}

const want = (name) => !ONLY || name.startsWith(ONLY);

// -------------------------------------------------------------- f01 primary
const a1Dir = path.join(REPO, 'test-fixtures', 'comparator-large');
if (!fs.existsSync(path.join(a1Dir, 'a1-set-b.pdf'))) {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-comparator-a1-fixtures.mjs')], { stdio: 'inherit' });
}
const A = await loadPdf(path.join(a1Dir, 'a1-set-a.pdf'));
const B = await loadPdf(path.join(a1Dir, 'a1-set-b.pdf'));

if (want('f01')) {
    // The composite the Comparator engine paints, written the way the old
    // (pre-v2) Comparison PDF writer left it in the file: raw DeviceRGB.
    const c = prod.comparator;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const images = [];
    for (let n = 1; n <= 5; n += 1) {
        const ra = await render(A, n, 150);
        const rb = await render(B, n, 150);
        const refMask = c.inkMask(ra.rgba, ra.w, ra.h);
        const othMask = c.inkMask(rb.rgba, rb.w, rb.h);
        const cm = c.pairChangeMask(refMask, othMask, refMask, othMask);
        const verdict = c.verdictFor(cm);
        const composite = c.paintPair(refMask, othMask, refMask, othMask, [0, 0, 1], [1, 0, 0],
            ra.w, ra.h, [0xC0 / 255, 0xC0 / 255, 0xC0 / 255], 0.7);
        const ref = imageObject(doc, toRgb(composite), { Width: ra.w, Height: ra.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
        imagePage(doc, font, ra.w / (150 / 72), ra.h / (150 / 72), ref, `p${n}: a1-set-a.pdf vs a1-set-b.pdf - ${verdict}`);
        images.push({ page: n, width: ra.w, height: ra.h, rgba: rgbaHash(composite), class: 'DeviceRGB raw' });
    }
    await save('f01-comparator-a1-150', doc, images, 'p1: a1-set-a.pdf vs a1-set-b.pdf');
}

// ------------------------------------------------------- f02 / f03 / f04
if (want('f02') || want('f03') || want('f04')) {
    const dense = await render(A, 3, 150);
    const sched = await render(A, 4, 150);
    if (want('f02')) {
        const doc = await PDFDocument.create();
        const ref = imageObject(doc, flate(toRgb(dense.rgba)), { Width: dense.w, Height: dense.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
        imagePage(doc, null, dense.w / (150 / 72), dense.h / (150 / 72), ref, null);
        await save('f02-dense-drawing', doc, [{ page: 1, width: dense.w, height: dense.h, rgba: rgbaHash(dense.rgba), class: 'DeviceRGB Flate, no predictor' }]);
    }
    if (want('f03')) {
        const doc = await PDFDocument.create();
        const ref = imageObject(doc, toRgb(sched.rgba), { Width: sched.w, Height: sched.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
        imagePage(doc, null, sched.w / (150 / 72), sched.h / (150 / 72), ref, null);
        await save('f03-schedule', doc, [{ page: 1, width: sched.w, height: sched.h, rgba: rgbaHash(sched.rgba), class: 'DeviceRGB raw' }]);
    }
    if (want('f04')) {
        // A scan: grey, a little blur, sensor noise, paper tone.
        const r = rng(4);
        const g = toGray(sched.rgba);
        const w = sched.w;
        const out = Buffer.alloc(g.length);
        for (let i = 0; i < g.length; i += 1) {
            const blur = (g[i] * 4 + (g[i - 1] ?? 255) + (g[i + 1] ?? 255) + (g[i - w] ?? 255) + (g[i + w] ?? 255)) / 8;
            out[i] = Math.max(0, Math.min(255, Math.round(blur * 0.93 + 12 + (r() - 0.5) * 14)));
        }
        const rgba = new Uint8ClampedArray(out.length * 4);
        for (let i = 0; i < out.length; i += 1) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[i]; rgba[i * 4 + 3] = 255; }
        const doc = await PDFDocument.create();
        const ref = imageObject(doc, flate(out), { Width: sched.w, Height: sched.h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' });
        imagePage(doc, null, sched.w / (150 / 72), sched.h / (150 / 72), ref, null);
        await save('f04-gray-scan', doc, [{ page: 1, width: sched.w, height: sched.h, rgba: rgbaHash(rgba), class: 'DeviceGray Flate, noisy scan' }]);
    }
}

// ------------------------------------------------------------ f05 / f06 photo
function photo(w, h, seed) {
    const r = rng(seed);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const blobs = Array.from({ length: 24 }, () => ({ x: r() * w, y: r() * h, s: 200 + r() * 900, c: [r() * 255, r() * 255, r() * 255] }));
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            let R = 60 + (x / w) * 80; let G = 90 + (y / h) * 60; let Bv = 120;
            for (const b of blobs) {
                const d = Math.exp(-(((x - b.x) ** 2 + (y - b.y) ** 2) / (b.s * b.s)));
                R += (b.c[0] - R) * d * 0.6; G += (b.c[1] - G) * d * 0.6; Bv += (b.c[2] - Bv) * d * 0.6;
            }
            const n = (r() - 0.5) * 18;
            const i = (y * w + x) * 4;
            rgba[i] = R + n; rgba[i + 1] = G + n; rgba[i + 2] = Bv + n; rgba[i + 3] = 255;
        }
    }
    return rgba;
}
if (want('f05') || want('f06')) {
    const w = 1240;
    const h = 1754; // A4 at 150 dpi keeps the run time sane; photographic content is what matters.
    const px = photo(w, h, 5);
    if (want('f05')) {
        const doc = await PDFDocument.create();
        const ref = imageObject(doc, flate(toRgb(px)), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
        imagePage(doc, null, 595.28, 841.89, ref, null);
        await save('f05-photo', doc, [{ page: 1, width: w, height: h, rgba: rgbaHash(px), class: 'DeviceRGB Flate, photographic' }]);
    }
    if (want('f06')) {
        const canvas = createCanvas(w, h);
        canvas.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
        const jpg = canvas.encodeSync('jpeg', 85);
        const doc = await PDFDocument.create();
        const ref = imageObject(doc, jpg, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
        imagePage(doc, null, 595.28, 841.89, ref, null);
        await save('f06-jpeg', doc, [{ page: 1, width: w, height: h, rgba: null, class: 'DCTDecode (decode is the viewer\'s)' }]);
    }
}

// ------------------------------------------------------------------ f07 mixed
function drawingRgba(w, h, seed, colours = true) {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h);
    const r = rng(seed);
    ctx.lineWidth = 2;
    for (let i = 0; i < 60; i += 1) {
        ctx.strokeStyle = colours && i % 9 === 0 ? 'rgb(255,0,0)' : 'rgb(0,0,0)';
        ctx.beginPath(); ctx.moveTo(r() * w, r() * h); ctx.lineTo(r() * w, r() * h); ctx.stroke();
    }
    ctx.fillStyle = 'rgb(0,0,255)'; ctx.font = '28px sans-serif'; ctx.fillText('A-101 REV 3', 40, 60);
    return ctx.getImageData(0, 0, w, h).data;
}
if (want('f07')) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const px = drawingRgba(1200, 800, 7);
    const ref = imageObject(doc, toRgb(px), { Width: 1200, Height: 800, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const p1 = doc.addPage([841.89, 595.28]);
    p1.drawText('Native text: Floor plan level 1 - GRID A-F / 1-9', { x: 40, y: 560, size: 12, font });
    for (let i = 0; i < 40; i += 1) p1.drawLine({ start: { x: 40 + i * 18, y: 60 }, end: { x: 40 + i * 18, y: 300 }, thickness: 0.6, color: rgb(0, 0, 0) });
    p1.drawRectangle({ x: 420, y: 330, width: 380, height: 200, borderColor: rgb(0.8, 0, 0), borderWidth: 1.2 });
    p1.node.setXObject(PDFName.of('Im0'), ref);
    p1.pushOperators(...[]);
    const extra = doc.context.register(doc.context.stream('q 360 0 0 240 440 340 cm /Im0 Do Q\n', {}));
    const contents = p1.node.Contents();
    const arr = doc.context.obj([]);
    if (contents instanceof PDFArray) contents.asArray().forEach((c) => arr.push(c)); else arr.push(p1.node.get(PDFName.of('Contents')));
    arr.push(extra);
    p1.node.set(PDFName.of('Contents'), arr);
    const p2 = doc.addPage([595.28, 841.89]);
    p2.setRotation(degrees(90));
    p2.setCropBox(20, 20, 555, 801);
    p2.drawText('Rotated page with a CropBox', { x: 60, y: 760, size: 14, font });
    p2.drawCircle({ x: 300, y: 420, size: 120, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    await save('f07-mixed', doc, [{ page: 1, width: 1200, height: 800, rgba: rgbaHash(px), class: 'DeviceRGB raw, on a vector/text page' }], 'Native text: Floor plan level 1');
}

// ----------------------------------------------------------------- f08 shared
if (want('f08')) {
    const doc = await PDFDocument.create();
    const px = drawingRgba(1600, 1100, 8);
    const ref = imageObject(doc, toRgb(px), { Width: 1600, Height: 1100, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    for (let i = 0; i < 3; i += 1) imagePage(doc, null, 800, 550, ref, null);
    // A fourth page draws it through a Form XObject.
    const form = doc.context.register(doc.context.stream('q 800 0 0 550 0 0 cm /Im0 Do Q\n', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 800, 550],
        Resources: { XObject: { Im0: ref } },
    }));
    const p4 = doc.addPage([800, 550]);
    p4.node.setXObject(PDFName.of('Fm0'), form);
    p4.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q /Fm0 Do Q\n', {})));
    await save('f08-shared', doc, [{ page: 1, width: 1600, height: 1100, rgba: rgbaHash(px), class: 'one raw DeviceRGB object, 3 pages + Form XObject' }]);
}

// ------------------------------------------------------------------ f09 smask
if (want('f09')) {
    const w = 900; const h = 600;
    const px = drawingRgba(w, h, 9);
    const alpha = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) alpha[y * w + x] = Math.round(255 * Math.min(1, Math.hypot(x - w / 2, y - h / 2) / 300));
    const doc = await PDFDocument.create();
    const smask = imageObject(doc, alpha, { Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    const ref = imageObject(doc, toRgb(px), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask });
    imagePage(doc, null, 450, 300, ref, null);
    await save('f09-smask', doc, [{ page: 1, width: w, height: h, rgba: rgbaHash(px), alpha: sha(alpha), class: 'DeviceRGB raw + 8-bit SMask raw' }]);
}

// -------------------------------------------------------------- f10 structure
if (want('f10')) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.setTitle('Optimizer v2 structure fixture');
    doc.setAuthor('PDF ArchiTools research');
    doc.setSubject('metadata, annotations, links, forms');
    doc.setKeywords(['optimizer', 'research']);
    const xmp = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Optimizer v2 structure fixture</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
    const px = drawingRgba(1000, 700, 10);
    const ref = imageObject(doc, toRgb(px), { Width: 1000, Height: 700, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const page = imagePage(doc, font, 595.28, 841.89, ref, 'Structure fixture');
    // newFontDictionary returns a unique key; the content must use that key
    // (a hard-coded /F1 left the font unresolvable -- corpus defect, found by
    // the verifier's own-text check).
    const fk = page.node.newFontDictionary('F1', font.ref).asString();
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`q 500 0 0 350 40 440 cm /Im0 Do Q\nBT ${fk} 12 Tf 40 400 Td (Native text survives) Tj ET\n`, {})));
    const link = doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 380, 240, 396], Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.invalid/spec') },
    });
    const note = doc.context.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [300, 380, 320, 400], Contents: PDFHexString.fromText('確認: 寸法 1200'), Open: false,
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link), doc.context.register(note)]));
    const form = doc.getForm();
    const field = form.createTextField('drawing.number');
    field.setText('A-101');
    field.addToPage(page, { x: 40, y: 300, width: 200, height: 24, font });
    const box = form.createCheckBox('drawing.approved');
    box.check();
    box.addToPage(page, { x: 260, y: 300, width: 18, height: 18 });
    await save('f10-structure', doc, [{ page: 1, width: 1000, height: 700, rgba: rgbaHash(px), class: 'DeviceRGB raw on a page with annotations and fields' }], 'Native text survives');
}

// --------------------------------------------------------------- f11 classes
if (want('f11')) {
    const doc = await PDFDocument.create();
    const w = 400; const h = 300;
    const px = drawingRgba(w, h, 11);
    const rgbBytes = toRgb(px);
    const images = [];
    const add = (label, samples, dict, known) => {
        const ref = imageObject(doc, samples, { Width: w, Height: h, ...dict });
        imagePage(doc, null, 400, 300, ref, null);
        images.push({ page: images.length + 1, width: w, height: h, rgba: known ?? null, class: label });
    };
    // Indexed with a 4-colour palette.
    const pal = [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 0, 255]];
    const idx = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i += 1) {
        const r = rgbBytes[i * 3]; const g = rgbBytes[i * 3 + 1]; const b = rgbBytes[i * 3 + 2];
        let best = 0; let bd = Infinity;
        pal.forEach((c, k) => { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = k; } });
        idx[i] = best;
    }
    add('Indexed 8-bit raw', idx, { ColorSpace: doc.context.obj(['Indexed', 'DeviceRGB', 3, PDFHexString.of(pal.map((c) => c.map((v) => v.toString(16).padStart(2, '0')).join('')).join(''))]), BitsPerComponent: 8 });
    add('DeviceRGB with a /Decode array', rgbBytes, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Decode: [1, 0, 1, 0, 1, 0] });
    add('DeviceRGB with a colour-key /Mask', rgbBytes, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Mask: [250, 255, 250, 255, 250, 255] });
    const bits = Buffer.alloc(Math.ceil(w / 8) * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (rgbBytes[(y * w + x) * 3] < 128) bits[y * Math.ceil(w / 8) + (x >> 3)] |= 0x80 >> (x & 7);
    add('ImageMask (stencil)', bits, { ImageMask: true, BitsPerComponent: 1 });
    const icc = doc.context.register(doc.context.stream(Buffer.alloc(0), { N: 3, Alternate: 'DeviceRGB' }));
    add('ICCBased RGB', rgbBytes, { ColorSpace: doc.context.obj(['ICCBased', icc]), BitsPerComponent: 8 });
    const s16 = Buffer.alloc(w * h * 6);
    for (let i = 0; i < w * h * 3; i += 1) { s16[i * 2] = rgbBytes[i]; s16[i * 2 + 1] = rgbBytes[i]; }
    add('DeviceRGB 16-bit', s16, { ColorSpace: 'DeviceRGB', BitsPerComponent: 16 });
    add('DeviceRGB with /Interpolate true', rgbBytes, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Interpolate: true }, rgbaHash(px));
    add('DeviceGray 1-bit raw', bits.map((b) => ~b & 0xFF), { ColorSpace: 'DeviceGray', BitsPerComponent: 1 });
    const hex = Buffer.from(flate(rgbBytes).toString('hex') + '>', 'latin1');
    add('Filter chain [/ASCIIHexDecode /FlateDecode]', hex, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: ['ASCIIHexDecode', 'FlateDecode'] }, rgbaHash(px));
    const cmyk = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) { cmyk[i * 4] = 255 - rgbBytes[i * 3]; cmyk[i * 4 + 1] = 255 - rgbBytes[i * 3 + 1]; cmyk[i * 4 + 2] = 255 - rgbBytes[i * 3 + 2]; }
    add('DeviceCMYK raw', cmyk, { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 });
    await save('f11-classes', doc, images);
}

// --------------------------------------------------------- f12 interpolate
// The same exact 4-colour DeviceRGB samples twice: p1 with /Interpolate true
// (must stay R1), p2 without it (the control, where R2 Indexed wins by size).
if (want('f12')) {
    const doc = await PDFDocument.create();
    const w = 1200; const h = 900;
    const src = toRgb(drawingRgba(w, h, 12));
    const pal = [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 0, 255]];
    const rgbBytes = Buffer.alloc(w * h * 3);
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
        let best = 0; let bd = Infinity;
        pal.forEach((c, k) => { const d = (c[0] - src[i * 3]) ** 2 + (c[1] - src[i * 3 + 1]) ** 2 + (c[2] - src[i * 3 + 2]) ** 2; if (d < bd) { bd = d; best = k; } });
        for (let c = 0; c < 3; c += 1) { rgbBytes[i * 3 + c] = pal[best][c]; rgba[i * 4 + c] = pal[best][c]; }
        rgba[i * 4 + 3] = 255;
    }
    const images = [];
    const add = (label, dict) => {
        const ref = imageObject(doc, rgbBytes, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, ...dict });
        imagePage(doc, null, 600, 450, ref, null);
        images.push({ page: images.length + 1, width: w, height: h, rgba: sha(rgba), class: label });
    };
    add('DeviceRGB 8-bit, 4 exact colours, /Interpolate true', { Interpolate: true });
    add('the same samples without /Interpolate (control)', {});
    await save('f12-interpolate', doc, images);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
