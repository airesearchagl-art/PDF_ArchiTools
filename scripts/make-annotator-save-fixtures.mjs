/**
 * Synthetic source documents for the annotator's vector-preserving save.
 *
 * Every one is generated here. No customer or real-project document is used,
 * and nothing written by this script is committed — `test-fixtures/` is ignored.
 *
 * The corpus exists to answer one question in several ways: **is the source
 * still there afterwards?** So each file carries something a whole-page raster
 * would destroy, and the gate compares that thing before and after. A fixture
 * that only carried a picture would let a rasterising save pass.
 *
 * Run:  node scripts/make-annotator-save-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, StandardFonts, rgb, degrees,
    PDFName, PDFNumber, PDFString,
    pushGraphicsState, popGraphicsState, beginText, endText, showText,
    setFontAndSize, setTextRenderingMode, moveText, TextRenderingMode,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'annotator-save');
fs.mkdirSync(OUT, { recursive: true });

const A4 = { w: 595.28, h: 841.89 };
const A0 = { w: 2383.94, h: 3370.39 };

const written = [];

/** A small deterministic PNG, so a page can carry a real image. */
function makePng(width, height) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            raw[o++] = (x * 8) % 256;
            raw[o++] = (y * 8) % 256;
            raw[o++] = 128;
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // colour type: truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

let crcTable = null;
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}

const PNG = makePng(48, 32);

/** Text, vectors and a searchable string — the things a raster save destroys. */
function drawSheet(page, font, size, label) {
    page.drawText(label, { x: 60, y: size.h - 80, size: 22, font, color: rgb(0, 0, 0) });
    page.drawText('A-101 GROUND FLOOR PLAN', {
        x: 60, y: size.h - 120, size: 13, font, color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText('SEARCHABLE-SOURCE-TEXT', {
        x: 60, y: size.h - 150, size: 11, font, color: rgb(0.2, 0.2, 0.2),
    });
    // Vector geometry: a title block and a couple of long runs.
    page.drawRectangle({
        x: 40, y: 40, width: size.w - 80, height: size.h - 200,
        borderColor: rgb(0, 0, 0), borderWidth: 1.5,
    });
    page.drawLine({
        start: { x: 40, y: 200 }, end: { x: size.w - 40, y: 200 },
        thickness: 1, color: rgb(0, 0, 0),
    });
    page.drawLine({
        start: { x: size.w / 2, y: 40 }, end: { x: size.w / 2, y: 200 },
        thickness: 1, color: rgb(0, 0, 0),
    });
}

function stamp(doc, title) {
    doc.setTitle(title);
    doc.setAuthor('PDF ArchiTools synthetic fixture');
    doc.setSubject('annotator vector-preserving save');
    doc.setKeywords(['synthetic', 'm3']);
    doc.setProducer('make-annotator-save-fixtures');
    doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
    doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
}

async function write(name, doc, note) {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
}

// ---------------------------------------------------------------------------
// 1. rich.pdf -- everything a rasterising save destroys, on one page
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 rich source');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([A4.w, A4.h]);
    drawSheet(page, font, A4, 'RICH SOURCE');

    // An image.
    const png = await doc.embedPng(PNG);
    page.drawImage(png, { x: 80, y: 260, width: 144, height: 96 });

    // An OCR-style invisible text layer: rendering mode 3 draws nothing and
    // stays searchable, which is exactly what a raster save silently loses.
    //
    // The font has to be a real resource on this page, or the string is bytes
    // with nothing to decode them and no extractor will read it back.
    const ocrKey = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(
        pushGraphicsState(),
        beginText(),
        setTextRenderingMode(TextRenderingMode.Invisible),
        setFontAndSize(ocrKey, 12),
        moveText(80, 240),
        showText(font.encodeText('INVISIBLE-OCR-LAYER')),
        endText(),
        popGraphicsState(),
    );

    // An existing annotation, which must still be there afterwards.
    const note = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: doc.context.obj([320, 250, 460, 340]),
        F: PDFNumber.of(4),
        C: doc.context.obj([1, 0, 0]),
        Contents: PDFString.of('existing-annotation'),
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(note)]));

    // A form field with a value.
    const form = doc.getForm();
    const field = form.createTextField('drawing.number');
    field.setText('A-101');
    field.addToPage(page, { x: 320, y: 120, width: 180, height: 24 });
    const field2 = form.createTextField('drawing.revision');
    field2.setText('C');
    field2.addToPage(page, { x: 320, y: 80, width: 60, height: 24 });

    await write('rich', doc, 'text, vectors, image, OCR layer, annotation, 2 form fields, metadata');
}

// ---------------------------------------------------------------------------
// 2. rotated.pdf -- the same content at all four quarter turns
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 rotations');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const angle of [0, 90, 180, 270]) {
        const page = doc.addPage([A4.w, A4.h]);
        drawSheet(page, font, A4, `ROTATE ${angle}`);
        page.setRotation(degrees(angle));
    }
    await write('rotated', doc, '/Rotate 0, 90, 180, 270 with identical content');
}

// ---------------------------------------------------------------------------
// 3. croprot.pdf -- a crop origin away from (0,0), at every rotation
// ---------------------------------------------------------------------------
//
// The combination is the point. A crop origin alone is caught by any save that
// remembers the CropBox; a rotation alone is caught by any save that undoes
// /Rotate. Only both together catch a save that does one and not the other.
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 crop + rotation');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const angle of [0, 90, 180, 270]) {
        const page = doc.addPage([A4.w, A4.h]);
        drawSheet(page, font, A4, `CROP+ROT ${angle}`);
        page.setMediaBox(0, 0, A4.w, A4.h);
        page.setCropBox(50, 70, A4.w - 120, A4.h - 160);
        page.setRotation(degrees(angle));
    }
    await write('croprot', doc, 'CropBox origin (50,70) on all four rotations');
}

// ---------------------------------------------------------------------------
// 4. a0.pdf -- the sheet a page-sized raster cannot afford
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 A0');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    drawSheet(doc.addPage([A0.w, A0.h]), font, A0, 'A0 SHEET');
    await write('a0', doc, 'one A0 page, for the raster ceiling');
}

// ---------------------------------------------------------------------------
// 5. multipage.pdf -- three pages, for page count, order and per-page marks
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 multipage');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const n of [1, 2, 3]) {
        const page = doc.addPage([A4.w, A4.h]);
        drawSheet(page, font, A4, `PAGE ${n} OF 3`);
    }
    await write('multipage', doc, 'three pages, for count and order');
}

// ---------------------------------------------------------------------------
// 6. signed.pdf -- a signature field, for the support boundary
// ---------------------------------------------------------------------------
//
// A signature *field*, not a real signature: enough to exercise detection,
// which is what the boundary needs. A genuinely signed document would need a
// certificate and a signing implementation, and would measure those instead.
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 signature field');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([A4.w, A4.h]);
    drawSheet(page, font, A4, 'SIGNED');

    const sig = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Widget'),
        FT: PDFName.of('Sig'),
        T: PDFString.of('approval.signature'),
        Rect: doc.context.obj([60, 120, 300, 180]),
        F: PDFNumber.of(4),
    });
    const sigRef = doc.context.register(sig);
    page.node.set(PDFName.of('Annots'), doc.context.obj([sigRef]));

    const form = doc.getForm();
    form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    form.acroForm.dict.set(PDFName.of('Fields'), doc.context.obj([sigRef]));

    await write('signed', doc, 'one AcroForm signature field, for the refusal path');
}

// ---------------------------------------------------------------------------
// 7. unreadable-form.pdf -- a form that cannot be inspected
// ---------------------------------------------------------------------------
//
// Three conditions have to hold in order, or this proves nothing:
//
//   PDFDocument.load     must succeed  -- else it refuses as `unreadable`
//   walking the pages    must succeed  -- same
//   inspecting the form  must fail     -- the condition under test
//
// A /Fields array holding a number rather than a field dictionary does exactly
// that: the file parses, the page tree is intact, and pdf-lib throws the moment
// anything walks the fields.
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 unreadable form');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    drawSheet(doc.addPage([A4.w, A4.h]), font, A4, 'UNREADABLE FORM');
    const acro = doc.context.obj({ Fields: doc.context.obj([PDFNumber.of(7)]) });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
    await write('unreadable-form', doc, 'valid pages, /Fields holding a number: inspection throws');
}

// ---------------------------------------------------------------------------
// 9. no-form.pdf -- a document with no AcroForm at all
// ---------------------------------------------------------------------------
//
// The control for a mutation that is easy to miss: in pdf-lib 1.17.1
// `getForm()` routes through `getOrCreateForm()`, so merely *inspecting* a
// document for signatures gives it an empty AcroForm, which then persists into
// whatever is saved. The dictionary must still be absent afterwards -- "zero
// fields" is not the same claim.
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 no form');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    drawSheet(doc.addPage([A4.w, A4.h]), font, A4, 'NO FORM');
    await write('no-form', doc, 'no /AcroForm in the catalog at all');
}

// ---------------------------------------------------------------------------
// 10. xfa.pdf -- form data pdf-lib deletes rather than fails on
// ---------------------------------------------------------------------------
//
// `getForm()` calls `deleteXFA()` on anything carrying XFA, with a console
// warning and no error. A save that inspected the document would therefore
// destroy its forms and report success -- so the boundary has to refuse before
// anything touches the form.
{
    const doc = await PDFDocument.create();
    stamp(doc, 'M3 XFA form');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([A4.w, A4.h]);
    drawSheet(page, font, A4, 'XFA FORM');
    const ctx = doc.context;
    const xfa = ctx.obj([
        PDFString.of('preamble'),
        ctx.register(ctx.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>')),
    ]);
    const acro = ctx.obj({ Fields: ctx.obj([]), XFA: xfa });
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
    await write('xfa', doc, 'an existing AcroForm carrying /XFA');
}

// ---------------------------------------------------------------------------
// 8. damaged.pdf -- a file that is not a PDF any more
// ---------------------------------------------------------------------------
{
    const source = fs.readFileSync(path.join(OUT, 'rich.pdf'));
    const broken = Buffer.from(source);
    broken.fill(0x41, broken.length - 400, broken.length - 40);
    fs.writeFileSync(path.join(OUT, 'damaged.pdf'), broken);
    written.push({ name: 'damaged', bytes: broken.length, note: 'truncated xref region, for the refusal path' });
}

for (const f of written) {
    console.log(`  ${f.name.padEnd(16)} ${String(f.bytes).padStart(8)} bytes  ${f.note}`);
}
console.log(`\n  wrote ${written.length} fixtures to test-fixtures/annotator-save/\n`);
