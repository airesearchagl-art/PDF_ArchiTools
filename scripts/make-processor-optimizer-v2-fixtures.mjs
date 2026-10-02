/**
 * Synthetic fixtures for the 最適化 v2 (D-028 Stage 1) gate. Pure Node + pdf-lib,
 * deterministic, CI-sized. No customer or project document is used.
 *
 * Every image records its object number, what the census must decide for it,
 * and whether a rewrite is expected, in test-fixtures/processor-optimizer-v2/
 * corpus.json — so the gate checks the optimizer against what each image *is*,
 * not against what the optimizer said about it.
 *
 * Run: node scripts/make-processor-optimizer-v2-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
    PDFArray, PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts, rgb, degrees,
} from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'test-fixtures', 'processor-optimizer-v2');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const corpus = [];

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

/** A small baseline JPEG (64×48), made once and embedded so CI needs no encoder. */
const TINY_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAwAEADASIAAhEBAxEB/8QAGgABAQADAQEAAAAAAAAAAAAAAQACBgcIBP/EACkQAQEAAAEICwAAAAAAAAAAAAABEgYRExQXZqTjBwgVFiVDRmKEocP/xAAXAQEBAQEAAAAAAAAAAAAAAAAFBgQB/8QAIxEAAgICAQIHAAAAAAAAAAAAAAMCEQESBQQxExQhIkFh4f/aAAwDAQACEQMRAD8A1+iqvZQzp0blpyXI+V19t3fzXajxpWNezXGOsZ6e+R+TdBVBMOUy+eIa1f3+HGKKqK3qgcawKKqKQVALcw+iuy7b93uN5bjNFTiY5x2KXq1rfXiYujs23Dd7jeW0vpHy4759n+H6lqmk8/SY8eH2zNmw/bTGNb1wsLklS87Qx6lRVRSCoGNzAoqoIKgGNYfRRVRU2qBVtYVY01jSCoBjWFRVRSCoBjWBRVRSCoBbWH//2Q==',
    'base64',
);

// ---------------------------------------------------------------- pixels

/** RGB buffer filled with one colour. */
function canvas(w, h, [r, g, b] = [255, 255, 255]) {
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i += 1) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b; }
    return px;
}
function setPx(px, w, h, x, y, c) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}
function line(px, w, h, x0, y0, x1, y1, c, thick = 1) {
    const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy; let x = x0; let y = y0;
    for (;;) {
        for (let t = 0; t < thick; t += 1) { setPx(px, w, h, x + t, y, c); setPx(px, w, h, x, y + t, c); }
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
}
/** A line drawing in up to `colours.length + 1` exact colours. */
function drawing(w, h, seed, colours = [[0, 0, 0], [220, 0, 0], [0, 0, 200]]) {
    const px = canvas(w, h);
    const r = rng(seed);
    for (let i = 0; i < 80; i += 1) {
        const c = colours[i % colours.length];
        line(px, w, h, Math.floor(r() * w), Math.floor(r() * h), Math.floor(r() * w), Math.floor(r() * h), c, 2);
    }
    for (let i = 0; i < 12; i += 1) {
        const x = Math.floor(r() * (w - 60)); const y = Math.floor(r() * (h - 40));
        for (let k = 0; k < 60; k += 1) { setPx(px, w, h, x + k, y, colours[0]); setPx(px, w, h, x + k, y + 40, colours[0]); }
        for (let k = 0; k < 40; k += 1) { setPx(px, w, h, x, y + k, colours[0]); setPx(px, w, h, x + 60, y + k, colours[0]); }
    }
    return px;
}
/** A smooth field with far more than 256 colours. */
function photo(w, h, seed) {
    const px = Buffer.alloc(w * h * 3);
    const r = rng(seed);
    const fx = 2 + r() * 3; const fy = 2 + r() * 3;
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 3;
            px[i] = Math.round(127 + 120 * Math.sin((x / w) * fx * Math.PI));
            px[i + 1] = Math.round(127 + 120 * Math.cos((y / h) * fy * Math.PI));
            px[i + 2] = Math.round(((x + y) / (w + h)) * 255);
        }
    }
    return px;
}
const noise = (n, seed) => { const r = rng(seed); const b = Buffer.alloc(n); for (let i = 0; i < n; i += 1) b[i] = Math.floor(r() * 256); return b; };
const flate = (b) => zlib.deflateSync(b, { level: 6 });

/** RunLengthDecode encoding (literal runs only): a filter the optimizer leaves. */
function runLength(b) {
    const parts = [];
    for (let i = 0; i < b.length; i += 128) {
        const n = Math.min(128, b.length - i);
        parts.push(Buffer.from([n - 1]), b.subarray(i, i + n));
    }
    parts.push(Buffer.from([128]));
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pdf helpers

function image(doc, samples, dict) {
    return doc.context.register(doc.context.stream(samples, { Type: 'XObject', Subtype: 'Image', ...dict }));
}

/** A page that paints one image, optionally with a line of native text. */
function imagePage(doc, ref, { w = 400, h = 300, font = null, text = null } = {}) {
    const page = doc.addPage([w + 40, h + 80]);
    page.node.setXObject(PDFName.of('Im0'), ref);
    let ops = `q ${w} 0 0 ${h} 20 60 cm /Im0 Do Q\n`;
    if (font && text) {
        const key = page.node.newFontDictionary('F1', font.ref);
        ops += `BT /${key.asString().slice(1)} 12 Tf 20 30 Td (${text}) Tj ET\n`;
    }
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(ops, {})));
    return page;
}

async function save(name, doc, images, extra = {}) {
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    doc.setProducer('make-processor-optimizer-v2-fixtures');
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    corpus.push({ name, bytes: bytes.length, images, ...extra });
    console.log(`${name}.pdf  ${bytes.length.toLocaleString('en-US')} bytes`);
}

const obj = (ref) => ref.objectNumber;

/** Add one more content stream to a page whose /Contents pdf-lib may already hold as an array. */
function appendContent(doc, page, ref) {
    const contents = page.node.get(PDFName.of('Contents'));
    const resolved = contents instanceof PDFArray ? contents : doc.context.lookup(contents);
    if (resolved instanceof PDFArray) resolved.push(ref);
    else page.node.set(PDFName.of('Contents'), doc.context.obj([contents, ref]));
}

// ---------------------------------------------------------------- fixtures

// 1. The original problem, small: raw DeviceRGB low-colour pages + a verdict line.
{
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const images = [];
    for (let p = 0; p < 2; p += 1) {
        const w = 900; const h = 640;
        const ref = image(doc, drawing(w, h, 10 + p), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
        imagePage(doc, ref, { w: 450, h: 320, font, text: `Verdict: CHANGE page ${p + 1}` });
        images.push({ obj: obj(ref), label: 'raw DeviceRGB, 4 exact colours', decision: 'R1+R2', rewrite: true, form: 'Indexed' });
    }
    await save('comparator-like', doc, images, { expectText: 'Verdict: CHANGE page 1', expectKind: 'optimized' });
}

// 2. Ordinary Flate RGB with more than 256 colours.
{
    const doc = await PDFDocument.create();
    const w = 400; const h = 300;
    const ref = image(doc, flate(photo(w, h, 2)), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
    imagePage(doc, ref);
    await save('flate-rgb', doc, [{ obj: obj(ref), label: 'Flate DeviceRGB, many colours', decision: 'R1+R2', rewrite: true, form: 'R1' }], { expectKind: 'optimized' });
}

// 3. Exact grayscale written as RGB, and 4. exact lower bit depth.
{
    const doc = await PDFDocument.create();
    const w = 400; const h = 300;
    const gray = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const v = Math.floor((x * 255) / (w - 1)); gray.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3); }
    const g1 = image(doc, gray, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, g1);
    const bw = Buffer.alloc(w * h);
    const d = drawing(w, h, 4, [[0, 0, 0]]);
    for (let i = 0; i < w * h; i += 1) bw[i] = d[i * 3];
    const g2 = image(doc, bw, { Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    imagePage(doc, g2);
    await save('exact-gray', doc, [
        { obj: obj(g1), label: 'DeviceRGB with R=G=B', decision: 'R1+R2', rewrite: true, form: 'Gray' },
        { obj: obj(g2), label: 'DeviceGray 8-bit, values 0/255', decision: 'R1+R2', rewrite: true, form: 'Gray 1-bit' },
    ], { expectKind: 'optimized' });
}

// 5. /Interpolate true and its control: the same exact 4-colour samples twice.
{
    const doc = await PDFDocument.create();
    const w = 600; const h = 450;
    const px = drawing(w, h, 5);
    const a = image(doc, px, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Interpolate: true });
    imagePage(doc, a);
    const b = image(doc, px, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, b);
    await save('interpolate', doc, [
        { obj: obj(a), label: '/Interpolate true', decision: 'R1', rewrite: true, form: 'R1', interpolate: true },
        { obj: obj(b), label: 'control without /Interpolate', decision: 'R1+R2', rewrite: true, form: 'Indexed', control: true },
    ], { expectKind: 'optimized' });
}

// 6. Image classes, one page each.
{
    const doc = await PDFDocument.create();
    const w = 300; const h = 200;
    const px = drawing(w, h, 6);
    const images = [];
    const add = (label, samples, dict, decision, rewrite, extra = {}) => {
        const ref = image(doc, samples, { Width: w, Height: h, ...dict });
        imagePage(doc, ref, { w, h });
        images.push({ obj: obj(ref), label, decision, rewrite, ...extra });
        return ref;
    };
    add('/Decode array', px, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Decode: [1, 0, 1, 0, 1, 0] }, 'R1', true, { form: 'R1' });
    add('colour-key /Mask', px, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Mask: [250, 255, 250, 255, 250, 255] }, 'R1', true, { form: 'R1' });
    const bits = Buffer.alloc(Math.ceil(w / 8) * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (px[(y * w + x) * 3] < 128) bits[y * Math.ceil(w / 8) + (x >> 3)] |= 0x80 >> (x & 7);
    add('/ImageMask', bits, { ImageMask: true, BitsPerComponent: 1 }, 'R1', true, { form: 'R1' });
    const icc = doc.context.register(doc.context.stream(Buffer.alloc(0), { N: 3, Alternate: 'DeviceRGB' }));
    add('ICCBased N=3, 4 colours', px, { ColorSpace: doc.context.obj(['ICCBased', icc]), BitsPerComponent: 8 }, 'R1+R2', true, { form: 'Indexed', icc: true });
    const s16 = Buffer.alloc(w * h * 6);
    for (let i = 0; i < w * h * 3; i += 1) { s16[i * 2] = px[i]; s16[i * 2 + 1] = px[i]; }
    add('16-bit DeviceRGB', s16, { ColorSpace: 'DeviceRGB', BitsPerComponent: 16 }, 'R1', true, { form: 'R1' });
    const cmyk = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) { cmyk[i * 4] = 255 - px[i * 3]; cmyk[i * 4 + 1] = 255 - px[i * 3 + 1]; cmyk[i * 4 + 2] = 255 - px[i * 3 + 2]; }
    add('DeviceCMYK', cmyk, { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }, 'R1', true, { form: 'R1' });
    const pal = PDFHexString.of('ffffff000000dc00000000c8');
    const idx = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i += 1) idx[i] = px[i * 3] === 255 ? 0 : px[i * 3] === 0 && px[i * 3 + 2] === 0 ? 1 : px[i * 3] === 220 ? 2 : 3;
    add('Indexed 8-bit', idx, { ColorSpace: doc.context.obj(['Indexed', 'DeviceRGB', 3, pal]), BitsPerComponent: 8 }, 'R1', true, { form: 'R1' });
    const alpha = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) alpha[y * w + x] = x < w / 2 ? 255 : 128;
    const smask = image(doc, alpha, { Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    images.push({ obj: obj(smask), label: 'SMask (DeviceGray)', decision: 'R1+R2', rewrite: true, form: 'any', smask: true });
    add('DeviceRGB with an SMask', px, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask }, 'R1+R2', true, { form: 'Indexed' });
    const matte = image(doc, alpha, { Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Matte: [1, 1, 1] });
    images.push({ obj: obj(matte), label: 'SMask with /Matte', decision: 'R1+R2', rewrite: true, form: 'any', smask: true });
    add('parent of an SMask with /Matte', px, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: matte }, 'R1', true, { form: 'R1' });
    const hex = Buffer.from(`${flate(px).toString('hex')}>`, 'latin1');
    add('[/ASCIIHexDecode /FlateDecode]', hex, { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: ['ASCIIHexDecode', 'FlateDecode'] }, 'R1+R2', true, { form: 'Indexed' });
    // A JPEG: never decoded, never re-encoded. Its own size, not the page's.
    const jpg = image(doc, TINY_JPEG, { Width: 64, Height: 48, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    imagePage(doc, jpg, { w: 64, h: 48 });
    images.push({ obj: obj(jpg), label: 'DCTDecode', decision: 'LEAVE', rewrite: false });
    add('RunLengthDecode', runLength(px), { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'RunLengthDecode' }, 'LEAVE', false);
    await save('classes', doc, images, { expectKind: 'optimized' });
}

// 7. One image object on three pages and inside a Form XObject.
{
    const doc = await PDFDocument.create();
    const w = 400; const h = 300;
    const ref = image(doc, drawing(w, h, 7), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    for (let i = 0; i < 3; i += 1) imagePage(doc, ref);
    const form = doc.context.register(doc.context.stream('q 200 0 0 150 0 0 cm /Im0 Do Q\n', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 150], Resources: { XObject: { Im0: ref } },
    }));
    const page = doc.addPage([300, 250]);
    page.node.setXObject(PDFName.of('Fm0'), form);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 40 40 cm /Fm0 Do Q\n', {})));
    await save('shared', doc, [{ obj: obj(ref), label: 'shared on 3 pages + a Form XObject', decision: 'R1+R2', rewrite: true, form: 'Indexed' }], { expectKind: 'optimized' });
}

// 8. Structure: text, vectors, annotations, a link, a form, Info + XMP, rotation and CropBox.
{
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const w = 600; const h = 400;
    const ref = image(doc, drawing(w, h, 8), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const page = doc.addPage([595.28, 841.89]);
    page.node.setXObject(PDFName.of('Im0'), ref);
    page.drawText('Native text survives optimization', { x: 40, y: 790, size: 14, font });
    for (let i = 0; i < 20; i += 1) page.drawLine({ start: { x: 40 + i * 20, y: 100 }, end: { x: 40 + i * 20, y: 300 }, thickness: 0.6, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 300, y: 320, width: 200, height: 100, borderColor: rgb(0.8, 0, 0), borderWidth: 1.2 });
    page.pushOperators();
    const extra = doc.context.register(doc.context.stream('q 400 0 0 266 80 480 cm /Im0 Do Q\n', {}));
    appendContent(doc, page, extra);
    const link = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 760, 240, 776], Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.invalid/spec') },
    }));
    const note = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [300, 760, 320, 780], Contents: PDFHexString.fromText('確認: 寸法 1200'), Open: false,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([link, note]));
    const formApi = doc.getForm();
    const field = formApi.createTextField('drawing.number');
    field.setText('A-101');
    field.addToPage(page, { x: 40, y: 40, width: 200, height: 24, font });
    const box = formApi.createCheckBox('drawing.approved');
    box.check();
    box.addToPage(page, { x: 260, y: 40, width: 18, height: 18 });
    const p2 = doc.addPage([841.89, 595.28]);
    p2.setRotation(degrees(90));
    p2.setCropBox(20, 20, 700, 500);
    p2.drawText('Rotated page with a CropBox', { x: 60, y: 400, size: 12, font });
    p2.node.setXObject(PDFName.of('Im0'), ref);
    p2.pushOperators();
    appendContent(doc, p2, doc.context.register(doc.context.stream('q 300 0 0 200 60 100 cm /Im0 Do Q\n', {})));
    doc.setTitle('Optimizer v2 structure fixture');
    doc.setAuthor('PDF ArchiTools gate');
    doc.setSubject('synthetic');
    doc.setKeywords(['optimizer', 'v2']);
    const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Optimizer v2 structure fixture</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
    await save('structure', doc, [{ obj: obj(ref), label: 'raw DeviceRGB under text, vectors, annotations and a form', decision: 'R1+R2', rewrite: true, form: 'Indexed' }],
        { expectText: 'Native text survives optimization', expectKind: 'optimized' });
}

// 9. Incompressible noise: every candidate is capped, nothing is written.
{
    const doc = await PDFDocument.create();
    const w = 300; const h = 200;
    const ref = image(doc, noise(w * h * 3, 9), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, ref);
    await save('noise', doc, [{ obj: obj(ref), label: 'random noise', decision: 'R1+R2', rewrite: false }], { expectKind: 'unchanged' });
}

// 10. Only a JPEG: no image is rewritten, so the original File is the answer.
{
    const doc = await PDFDocument.create();
    const ref = image(doc, TINY_JPEG, { Width: 64, Height: 48, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    imagePage(doc, ref, { w: 64, h: 48 });
    await save('jpeg-only', doc, [{ obj: obj(ref), label: 'DCTDecode', decision: 'LEAVE', rewrite: false }], { expectKind: 'unchanged' });
}

// 11. Many objects: the writer crosses several yield boundaries.
{
    const doc = await PDFDocument.create();
    const w = 300; const h = 200;
    const ref = image(doc, drawing(w, h, 11), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const page = imagePage(doc, ref);
    const annots = [];
    for (let i = 0; i < 700; i += 1) {
        annots.push(doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Square', Rect: [10 + (i % 30) * 13, 10 + Math.floor(i / 30) * 12, 18 + (i % 30) * 13, 18 + Math.floor(i / 30) * 12],
            Contents: PDFString.of(`n${i}`),
        })));
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
    await save('many-objects', doc, [{ obj: obj(ref), label: 'raw DeviceRGB', decision: 'R1+R2', rewrite: true, form: 'Indexed' }], { expectKind: 'optimized' });
}

// 12. Medium: long enough to supersede mid-run in the UI gate.
{
    const doc = await PDFDocument.create();
    const images = [];
    for (let p = 0; p < 3; p += 1) {
        const w = 2000; const h = 1500;
        const ref = image(doc, photo(w, h, 20 + p), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
        imagePage(doc, ref, { w: 500, h: 375 });
        images.push({ obj: obj(ref), label: 'raw DeviceRGB photo field', decision: 'R1+R2', rewrite: true, form: 'R1' });
    }
    await save('medium', doc, images, { expectKind: 'optimized' });
}

// 13. Flate integrity (RF-31-01): only a stream pako decodes completely, with a
//     valid checksum and exactly the image's bytes, may be rewritten.
{
    const doc = await PDFDocument.create();
    const w = 300; const h = 200;
    const px = drawing(w, h, 13);
    const good = flate(px);
    const images = [];
    const add = (label, data, dict, rewrite) => {
        const ref = image(doc, data, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode', ...dict });
        imagePage(doc, ref, { w, h });
        images.push({ obj: obj(ref), label, decision: 'R1+R2', rewrite });
    };
    const badAdler = Buffer.from(good);
    badAdler[badAdler.length - 1] ^= 0xFF;
    add('Flate with a bad Adler-32', badAdler, {}, false);
    add('Flate truncated by 16 bytes', good.subarray(0, good.length - 16), {}, false);
    add('Flate decoding to expected + 1 byte', flate(Buffer.concat([px, Buffer.from([0])])), {}, false);
    add('Flate decoding to expected − 1 byte', flate(px.subarray(0, px.length - 1)), {}, false);
    // Exactly one pako output chunk (64 KiB) of DeviceGray: valid, and rewritten.
    const gw = 256; const gh = 256;
    const gray = Buffer.alloc(gw * gh);
    const gd = drawing(gw, gh, 14, [[0, 0, 0]]);
    for (let i = 0; i < gw * gh; i += 1) gray[i] = gd[i * 3];
    const g = image(doc, flate(gray), { Width: gw, Height: gh, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' });
    imagePage(doc, g, { w: gw, h: gh });
    images.push({ obj: obj(g), label: 'Flate decoding to exactly 65,536 bytes (one pako chunk)', decision: 'R1+R2', rewrite: true });
    const raw = image(doc, Buffer.concat([px, Buffer.from([7])]), { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, raw, { w, h });
    images.push({ obj: obj(raw), label: 'unfiltered, expected + 1 byte', decision: 'R1+R2', rewrite: false });
    // A large valid raw image so the document as a whole is optimized and the
    // left-alone streams can be checked byte for byte in a real output.
    const big = image(doc, drawing(900, 600, 15), { Width: 900, Height: 600, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, big, { w: 450, h: 300 });
    images.push({ obj: obj(big), label: 'raw DeviceRGB (valid)', decision: 'R1+R2', rewrite: true, form: 'Indexed' });
    await save('flate-integrity', doc, images, { expectKind: 'optimized' });
}

// 14. A cross-reference stream with object streams: /Size comes from the XRef
//     stream's own dictionary.
{
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ref = image(doc, drawing(500, 350, 16), { Width: 500, Height: 350, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, ref, { w: 500, h: 350, font, text: 'xref stream source' });
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    doc.setProducer('make-processor-optimizer-v2-fixtures');
    const bytes = await doc.save({ useObjectStreams: true });
    fs.writeFileSync(path.join(OUT, 'xref-stream.pdf'), bytes);
    corpus.push({ name: 'xref-stream', bytes: bytes.length, images: [{ obj: obj(ref), label: 'raw DeviceRGB in an XRef-stream file', decision: 'R1+R2', rewrite: true, form: 'Indexed' }], expectKind: 'optimized', expectText: 'xref stream source' });
    console.log(`xref-stream.pdf  ${bytes.length.toLocaleString('en-US')} bytes`);
}

/** Replace the trailer's `/Size N` with a smaller value, padded so no offset moves. */
function understateSize(bytes, value) {
    const text = Buffer.from(bytes).toString('latin1');
    const at = text.lastIndexOf('/Size ');
    const m = /^\/Size (\d+)/.exec(text.slice(at));
    const replacement = `/Size ${value}`.padEnd(m[0].length, ' ');
    const out = Buffer.from(bytes);
    out.write(replacement, at, 'latin1');
    return { out, declared: value, actual: Number(m[1]) };
}

// 15. /Size understated (RF-31-03): the table lists more objects than /Size admits.
{
    const doc = await PDFDocument.create();
    const ref = image(doc, drawing(300, 200, 17), { Width: 300, Height: 200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    imagePage(doc, ref);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const { out, declared, actual } = understateSize(await doc.save({ useObjectStreams: false }), 3);
    fs.writeFileSync(path.join(OUT, 'size-understated.pdf'), out);
    corpus.push({ name: 'size-understated', bytes: out.length, images: [], expectRefusal: 'UNSUPPORTED_DOCUMENT', declared, actual });
    console.log(`size-understated.pdf  /Size ${actual} written as ${declared}`);
}

// 16. Object-heavy (RF-31-02): at 512 MiB the pre-parse gate admits it, but the
//     parsed objects plus the writer's own bytes and the publication copy do
//     not fit — refused before the writer allocates. Output stays far below the
//     256 MiB ceiling, so only memory refuses it. Sized in two passes.
{
    const USABLE_512 = Math.floor((512 * 1024 * 1024 * 3) / 4);
    const PER_OBJECT = 20_480;
    const N = 18_000;
    const build = async (blobBytes) => {
        const doc = await PDFDocument.create();
        const ref = image(doc, drawing(600, 560, 18), { Width: 600, Height: 560, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
        imagePage(doc, ref, { w: 300, h: 280 });
        const items = [];
        for (let i = 0; i < N; i += 1) items.push(doc.context.register(doc.context.obj({ Type: 'GateItem', N: i })));
        doc.catalog.set(PDFName.of('GateItems'), doc.context.obj(items));
        doc.catalog.set(PDFName.of('GateBlob'), doc.context.register(doc.context.stream(noise(blobBytes, 19), {})));
        doc.setCreationDate(FIXED_DATE);
        doc.setModificationDate(FIXED_DATE);
        const bytes = await doc.save({ useObjectStreams: false });
        const size = Number(/\/Size (\d+)/.exec(Buffer.from(bytes.subarray(bytes.length - 512)).toString('latin1'))[1]);
        return { bytes, size, ref };
    };
    // Aim the pre-parse need 3 MB under the 512 MiB usable share.
    let blob = 14_000_000;
    let r = await build(blob);
    const target = USABLE_512 - 3_000_000;
    blob += Math.floor((target - (2 * r.bytes.length + r.size * PER_OBJECT)) / 2);
    r = await build(blob);
    const need = 2 * r.bytes.length + r.size * PER_OBJECT;
    fs.writeFileSync(path.join(OUT, 'object-heavy.pdf'), r.bytes);
    corpus.push({
        name: 'object-heavy', bytes: r.bytes.length, preParseNeed: need, usable512: USABLE_512,
        images: [{ obj: obj(r.ref), label: 'small raw image (puts the run on the writer path)', decision: 'R1+R2', rewrite: true }],
        expectRefusalAt512: 'OVER_MEMORY_BUDGET', expectKindAt1GiB: 'optimized',
    });
    console.log(`object-heavy.pdf  ${r.bytes.length.toLocaleString('en-US')} bytes, pre-parse need ${need} of ${USABLE_512}`);
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), JSON.stringify(corpus, null, 1));
console.log(`${corpus.length} fixtures → ${OUT}`);
