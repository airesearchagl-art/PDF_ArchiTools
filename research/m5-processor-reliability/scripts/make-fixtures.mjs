/**
 * Synthetic documents for the M5 Processor reliability research.
 *
 * Every file is generated here; none is a customer or project document, and
 * nothing written by this script is committed (`test-fixtures/` is ignored).
 *
 * Each fixture carries markers the research harness looks for afterwards, so
 * that "preserved" is decided by reading the output's structure — the text a
 * PDF reader extracts, the annotations it lists, the field values it holds —
 * rather than by looking at a picture of it.
 *
 * Run:  node research/m5-processor-reliability/scripts/make-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray,
    StandardFonts, rgb, degrees,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix,
    setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm5-processor');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/** Paper, in points. */
export const SHEET = {
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
    A1: { w: 1683.78, h: 2383.94 },
    A0: { w: 2383.94, h: 3370.39 },
};

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const written = [];

async function write(name, doc, note, { objectStreams = false } = {}) {
    const bytes = await doc.save({ useObjectStreams: objectStreams });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
    return bytes;
}

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    doc.setProducer('M5 synthetic fixture');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, font };
}

/**
 * A drawing in colour, scaled to the sheet: border, grid, a wall, and an
 * asymmetric "L" in the top-left corner so orientation can be read back.
 */
function drawVector(page, size, { colour = true } = {}) {
    const { w, h } = size;
    const lw = w * 0.002;
    const red = colour ? rgb(0.85, 0.1, 0.1) : rgb(0, 0, 0);
    const blue = colour ? rgb(0.1, 0.2, 0.85) : rgb(0, 0, 0);
    page.drawRectangle({
        x: w * 0.05, y: h * 0.05, width: w * 0.9, height: h * 0.9,
        borderColor: rgb(0, 0, 0), borderWidth: lw * 2,
    });
    for (let i = 1; i < 6; i += 1) {
        page.drawLine({
            start: { x: w * 0.05, y: h * (0.2 + i * 0.1) }, end: { x: w * 0.95, y: h * (0.2 + i * 0.1) },
            thickness: lw, color: blue,
        });
    }
    page.drawLine({
        start: { x: w * 0.15, y: h * 0.35 }, end: { x: w * 0.85, y: h * 0.35 },
        thickness: lw * 4, color: red,
    });
    page.drawCircle({ x: w * 0.5, y: h * 0.8, size: w * 0.04, borderColor: red, borderWidth: lw });
    // The orientation mark: a thick L hugging the top-left corner.
    page.drawRectangle({ x: w * 0.07, y: h * 0.85, width: w * 0.12, height: h * 0.02, color: rgb(0, 0.5, 0) });
    page.drawRectangle({ x: w * 0.07, y: h * 0.77, width: w * 0.02, height: h * 0.1, color: rgb(0, 0.5, 0) });
}

function drawText(page, font, size, marker, { y = 0.12 } = {}) {
    page.drawText(marker, { x: size.w * 0.12, y: size.h * y, size: size.h * 0.018, font, color: rgb(0, 0, 0) });
}

// ---------------------------------------------------------------------------
// A tiny, deterministic RGB PNG: a "scanned sheet" of paper-grey noise with
// dark strokes on it. pdf-lib re-encodes it as a FlateDecode image XObject.
// ---------------------------------------------------------------------------
/** Saturated colour blocks: an image whose conversion to grey is visible. */
function colourPng(width, height) {
    const raw = Buffer.alloc(height * (1 + width * 3));
    const palette = [[220, 30, 30], [30, 80, 220], [20, 160, 60], [240, 200, 20]];
    for (let y = 0; y < height; y += 1) {
        const row = y * (1 + width * 3);
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = palette[(Math.floor(x / (width / 4)) + Math.floor(y / (height / 3))) % 4];
            const i = row + 1 + x * 3;
            raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
        }
    }
    return pngOf(width, height, raw);
}

function pngOf(width, height, raw) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

function scanPng(width, height, seed = 7) {
    let s = seed;
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y += 1) {
        const row = y * (1 + width * 3);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            let v = 232 + Math.floor(rand() * 16);
            const stroke = (y % 60 < 3) || (x % 90 < 3) || Math.abs(x - y) < 2
                || (x > width * 0.2 && x < width * 0.8 && Math.abs(y - height * 0.6) < 4);
            if (stroke) v = 40 + Math.floor(rand() * 30);
            const i = row + 1 + x * 3;
            raw[i] = v; raw[i + 1] = Math.max(0, v - 6); raw[i + 2] = Math.max(0, v - 14);
        }
    }
    return pngOf(width, height, raw);
}
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function drawScan(doc, page, size, box = { x: 0, y: 0, w: size.w, h: size.h }) {
    const png = await doc.embedPng(scanPng(Math.round(box.w * 1.5), Math.round(box.h * 1.5)));
    page.drawImage(png, { x: box.x, y: box.y, width: box.w, height: box.h });
}

/** Text a reader extracts but nobody sees: an OCR layer, Tr 3. */
function drawInvisibleText(page, font, size, marker) {
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText(marker, { x: size.w * 0.2, y: size.h * 0.6, size: size.h * 0.02, font });
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

{
    const { doc } = await newDoc('M5 vector');
    drawVector(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4);
    await write('vector-a4', doc, 'pure coloured vector drawing, no text, no image');
}
{
    const { doc, font } = await newDoc('M5 native text');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'NATIVE-TEXT-M5 DIM 1200');
    await write('text-a4', doc, 'vector drawing with native searchable text');
}
{
    const { doc } = await newDoc('M5 raster scan');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    await drawScan(doc, page, SHEET.A4);
    await write('raster-a4', doc, 'a scanned sheet: one full-page RGB image, no text');
}
{
    const { doc, font } = await newDoc('M5 colour raster');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const png = await doc.embedPng(colourPng(600, 848));
    page.drawImage(png, { x: 0, y: 0, width: SHEET.A4.w, height: SHEET.A4.h });
    drawText(page, font, SHEET.A4, 'COLOUR-RASTER-M5');
    await write('colour-raster-a4', doc, 'a full-page image of saturated colour blocks, plus native text');
}
{
    const { doc, font } = await newDoc('M5 OCR layer');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    await drawScan(doc, page, SHEET.A4);
    drawInvisibleText(page, font, SHEET.A4, 'OCR-LAYER-M5');
    await write('ocr-a4', doc, 'a scanned sheet with an invisible OCR text layer (Tr 3)');
}
{
    const { doc, font } = await newDoc('M5 mixed');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4);
    await drawScan(doc, page, SHEET.A4, { x: SHEET.A4.w * 0.55, y: SHEET.A4.h * 0.4, w: SHEET.A4.w * 0.35, h: SHEET.A4.h * 0.25 });
    drawText(page, font, SHEET.A4, 'MIXED-TEXT-M5');
    await write('mixed-a4', doc, 'vector + a raster detail + native text');
}
{
    const { doc, font } = await newDoc('M5 transparency');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    page.drawRectangle({ x: 100, y: 400, width: 250, height: 250, color: rgb(1, 0, 0), opacity: 0.5 });
    page.drawRectangle({ x: 220, y: 300, width: 250, height: 250, color: rgb(0, 0, 1), opacity: 0.5 });
    drawText(page, font, SHEET.A4, 'TRANSPARENCY-M5');
    await write('transparency-a4', doc, 'overlapping translucent fills (ExtGState ca)');
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function addAnnots(doc, page, dicts) {
    const refs = dicts.map((d) => doc.context.register(doc.context.obj(d)));
    const existing = page.node.lookup(PDFName.of('Annots'));
    const arr = existing instanceof PDFArray ? existing : doc.context.obj([]);
    for (const r of refs) arr.push(r);
    page.node.set(PDFName.of('Annots'), arr);
    return refs;
}

async function annotated(name, size, rotate = 0, note = '') {
    const { doc, font } = await newDoc(`M5 ${name}`);
    const page = doc.addPage([size.w, size.h]);
    drawVector(page, size);
    drawText(page, font, size, `ANNOT-PAGE-M5 ${name}`);
    const ap = doc.context.register(doc.context.stream(
        '1 0 0 RG 3 w 2 2 116 76 re S', {
            Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 80],
        },
    ));
    addAnnots(doc, page, [
        {
            Type: 'Annot', Subtype: 'Square', Rect: [size.w * 0.6, size.h * 0.5, size.w * 0.6 + 120, size.h * 0.5 + 80],
            C: [1, 0, 0], Contents: PDFString.of('M5-SQUARE-NOTE'), F: 4, AP: { N: ap },
        },
        {
            Type: 'Annot', Subtype: 'Text', Rect: [size.w * 0.2, size.h * 0.5, size.w * 0.2 + 24, size.h * 0.5 + 24],
            Contents: PDFString.of('M5-STICKY-NOTE'), F: 4, Name: 'Comment',
        },
    ]);
    if (rotate) page.setRotation(degrees(rotate));
    await write(name, doc, note);
}

await annotated('annotation-a4', SHEET.A4, 0, 'a Square annotation with an appearance stream and a sticky note');

{
    const { doc, font } = await newDoc('M5 link');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4);
    drawText(page, font, SHEET.A4, 'LINK-PAGE-M5');
    // The URI is never fetched: rendering and inspection read the annotation,
    // they do not follow it. The gate counts external requests to prove it.
    addAnnots(doc, page, [{
        Type: 'Annot', Subtype: 'Link', Rect: [60, 90, 300, 120], Border: [0, 0, 0], F: 4,
        A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.invalid/m5-link') },
    }]);
    await write('link-a4', doc, 'a URI link annotation');
}
{
    const { doc, font } = await newDoc('M5 form');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'FORM-PAGE-M5');
    const form = doc.getForm();
    const field = form.createTextField('m5.text');
    field.setText('M5-FIELD-VALUE');
    field.addToPage(page, { x: 80, y: 600, width: 260, height: 28, font });
    const box = form.createCheckBox('m5.check');
    box.addToPage(page, { x: 380, y: 600, width: 20, height: 20 });
    box.check();
    await write('form-a4', doc, 'an AcroForm text field with a value and a checked box');
}

/**
 * A signature field whose signature covers the file.
 *
 * Not a cryptographic signature: there is no certificate and no PKCS#7. The
 * /ByteRange covers every byte except /Contents, exactly as a real one does,
 * and /Contents holds the SHA-256 of those bytes. So "is the signed data still
 * the data?" is answerable afterwards by recomputing the digest — which is the
 * property a real verifier checks first, and the one a re-serialising save
 * destroys.
 */
{
    const { doc, font } = await newDoc('M5 signed');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'SIGNED-PAGE-M5');
    const PLACE = 9999999999;
    const v = doc.context.register(doc.context.obj({
        Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, PLACE, PLACE, PLACE],
        Contents: PDFHexString.of('0'.repeat(1024)),
        M: PDFString.of('D:20260101000000Z'),
        Name: PDFString.of('M5 synthetic signer'),
    }));
    const sig = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('m5.signature'),
        Rect: [0, 0, 0, 0], F: 132, P: page.ref, V: v,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([sig]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({
        Fields: doc.context.obj([sig]), SigFlags: PDFNumber.of(3),
    }));
    let bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    const text = bytes.toString('latin1');
    const br = text.indexOf(`/ByteRange [ 0 ${PLACE} ${PLACE} ${PLACE} ]`);
    const cStart = text.indexOf('/Contents <', br === -1 ? 0 : text.lastIndexOf('<<', br)) + '/Contents '.length;
    const cEnd = text.indexOf('>', cStart) + 1;
    if (br === -1 || cStart < '/Contents '.length || cEnd <= cStart) throw new Error('signature placeholders not found');
    const range = [0, cStart, cEnd, bytes.length - cEnd];
    const pad = (n) => String(n).padStart(10, '0');
    const patched = `/ByteRange [ 0 ${pad(range[1])} ${pad(range[2])} ${pad(range[3])} ]`;
    bytes.write(patched, br, 'latin1');
    const digest = crypto.createHash('sha256')
        .update(bytes.subarray(0, cStart)).update(bytes.subarray(cEnd)).digest('hex');
    bytes.write(`<${digest.padEnd(1024, '0')}>`, cStart, 'latin1');
    fs.writeFileSync(path.join(OUT, 'signature-a4.pdf'), bytes);
    written.push({ name: 'signature-a4', bytes: bytes.length, note: 'a signature whose /ByteRange covers the file, digest in /Contents' });
}
{
    const { doc, font } = await newDoc('M5 XFA');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'XFA-PAGE-M5');
    const ctx = doc.context;
    const xfa = ctx.obj([
        PDFString.of('xdp:xdp'),
        ctx.register(ctx.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template>M5-XFA</template></xdp:xdp>')),
    ]);
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(ctx.obj({ Fields: ctx.obj([]), XFA: xfa })));
    await write('xfa-a4', doc, 'an AcroForm carrying /XFA form data');
}
{
    const { doc, font } = await newDoc('M5 metadata title');
    doc.setAuthor('M5 author');
    doc.setSubject('M5 subject');
    doc.setKeywords(['m5', 'metadata']);
    doc.setCreator('M5 creator');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'METADATA-PAGE-M5');
    const xmp = doc.context.register(doc.context.stream(
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
        + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description>M5-XMP-MARKER</dc:description>'
        + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
        { Type: 'Metadata', Subtype: 'XML' },
    ));
    doc.catalog.set(PDFName.of('Metadata'), xmp);
    await write('metadata-a4', doc, 'Info dictionary fields and an XMP stream');
}
{
    const { doc, font } = await newDoc('M5 three pages');
    for (const n of [1, 2, 3]) {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawVector(page, SHEET.A4, { colour: false });
        drawText(page, font, SHEET.A4, `PAGE-ORDER-M5-${n}`);
        // A block in a different place on each page, so the order is still
        // readable from pixels once an operation has removed the text.
        page.drawRectangle({
            x: SHEET.A4.w * (0.1 + (n - 1) * 0.28), y: SHEET.A4.h * 0.4,
            width: SHEET.A4.w * 0.24, height: SHEET.A4.h * 0.12, color: rgb(0, 0, 0),
        });
    }
    await write('three-pages', doc, 'three pages, each carrying its own page-order marker and block');
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

for (const key of ['A3', 'A1', 'A0']) {
    const { doc, font } = await newDoc(`M5 ${key}`);
    const page = doc.addPage([SHEET[key].w, SHEET[key].h]);
    drawVector(page, SHEET[key]);
    drawText(page, font, SHEET[key], `SHEET-${key}-M5`);
    await write(`vector-${key.toLowerCase()}`, doc, `${key} portrait, vector + native text`);
}
{
    const { doc, font } = await newDoc('M5 landscape');
    const size = { w: SHEET.A4.h, h: SHEET.A4.w };
    const page = doc.addPage([size.w, size.h]);
    drawVector(page, size);
    drawText(page, font, size, 'LANDSCAPE-M5');
    await write('landscape-a4', doc, 'A4 landscape by its MediaBox');
}
for (const angle of [0, 90, 180, 270]) {
    await annotated(`rotate-${angle}`, SHEET.A4, angle, `A4 at /Rotate ${angle}, with annotations`);
}
{
    const { doc, font } = await newDoc('M5 crop offset');
    const page = doc.addPage([SHEET.A4.w + 100, SHEET.A4.h + 140]);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 50, 70));
    drawVector(page, SHEET.A4);
    drawText(page, font, SHEET.A4, 'CROP-OFFSET-M5');
    page.pushOperators(popGraphicsState());
    page.setCropBox(50, 70, SHEET.A4.w, SHEET.A4.h);
    await write('crop-offset', doc, 'CropBox at (50,70) inside a larger MediaBox, drawing within it');
}
{
    // A MediaBox that does not start at the origin. Anything that places
    // itself at (0,0) with the page's width and height misses part of it.
    const { doc, font } = await newDoc('M5 mediabox offset');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    page.setMediaBox(200, 300, SHEET.A4.w, SHEET.A4.h);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 200, 300));
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'MEDIA-OFFSET-M5');
    page.pushOperators(popGraphicsState());
    await write('mediabox-offset', doc, 'MediaBox origin at (200,300), drawing within it');
}
{
    const { doc, font } = await newDoc('M5 mediabox larger');
    const page = doc.addPage([SHEET.A4.w + 200, SHEET.A4.h + 200]);
    drawVector(page, SHEET.A4);
    drawText(page, font, SHEET.A4, 'INSIDE-CROP-M5');
    // Content the CropBox hides. A transform that reveals it has changed what
    // the document shows.
    page.drawText('OUTSIDE-CROP-M5', { x: SHEET.A4.w + 20, y: SHEET.A4.h + 80, size: 24, font });
    page.drawRectangle({ x: SHEET.A4.w + 20, y: 40, width: 150, height: 150, color: rgb(1, 0, 1) });
    page.setCropBox(0, 0, SHEET.A4.w, SHEET.A4.h);
    await write('mediabox-larger', doc, 'MediaBox larger than CropBox, with content outside the crop');
}
{
    const { doc, font } = await newDoc('M5 mixed sizes');
    for (const [key, landscape] of [['A4', false], ['A3', true], ['A1', false]]) {
        const size = landscape ? { w: SHEET[key].h, h: SHEET[key].w } : SHEET[key];
        const page = doc.addPage([size.w, size.h]);
        drawVector(page, size);
        drawText(page, font, size, `MIXED-SIZE-${key}-M5`);
    }
    await write('mixed-sizes', doc, 'A4 portrait, A3 landscape, A1 portrait');
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

fs.writeFileSync(path.join(OUT, 'invalid.pdf'), Buffer.from('%PDF-1.7\nthis is not a PDF body\n%%EOF\n'));
written.push({ name: 'invalid', bytes: 38, note: 'a .pdf that is not a PDF' });
{
    const { doc, font } = await newDoc('M5 batch page');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'BATCH-M5');
    await write('batch-ok', doc, 'a small valid document for batch runs');
}
{
    // Eight A4 sheets: long enough at 300 dpi for a run to be interrupted.
    const { doc, font } = await newDoc('M5 long');
    for (let n = 1; n <= 8; n += 1) {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawVector(page, SHEET.A4);
        drawText(page, font, SHEET.A4, `LONG-M5-${n}`);
    }
    await write('long-8', doc, 'eight A4 pages, for lifecycle interruption');
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({ files: written, sheets: SHEET }, null, 2)}\n`);
for (const f of written) console.log(`  ${f.name.padEnd(18)} ${String(f.bytes).padStart(8)} bytes  ${f.note}`);
console.log(`\n  wrote ${written.length} fixtures to test-fixtures/m5-processor/\n`);
