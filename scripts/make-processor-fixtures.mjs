/**
 * Synthetic documents for the M5 Processor reliability gate.
 *
 * Every file is generated here; none is a customer or project document, and
 * nothing written by this script is committed (`test-fixtures/` is ignored).
 *
 * Each fixture carries markers the gate looks for afterwards, so "preserved" is
 * decided by reading the output's structure — the text a reader extracts, the
 * annotations it lists, the field values it holds, where a link points — rather
 * than by looking at a picture of it.
 *
 * Run:  node scripts/make-processor-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray,
    StandardFonts, rgb, degrees,
    setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'processor');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

export const SHEET = {
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
    A1: { w: 1683.78, h: 2383.94 },
};

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const written = [];

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setAuthor('M5 author');
    doc.setSubject('M5 subject');
    doc.setCreator('M5 creator');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, font };
}

async function write(name, doc, note) {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
    return bytes;
}

/** A drawing: border, grid, a heavy wall line, and a corner mark. */
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
            start: { x: w * 0.05, y: h * (0.2 + i * 0.1) },
            end: { x: w * 0.95, y: h * (0.2 + i * 0.1) },
            thickness: lw, color: blue,
        });
    }
    page.drawLine({
        start: { x: w * 0.15, y: h * 0.35 }, end: { x: w * 0.85, y: h * 0.35 },
        thickness: lw * 4, color: red,
    });
    page.drawRectangle({ x: w * 0.07, y: h * 0.85, width: w * 0.12, height: h * 0.02, color: rgb(0, 0.5, 0) });
}

const drawText = (page, font, size, marker, y = 0.12) => page.drawText(marker, {
    x: size.w * 0.12, y: size.h * y, size: Math.max(8, size.h * 0.018), font, color: rgb(0, 0, 0),
});

/** Text a reader extracts but nobody sees: an OCR layer, Tr 3. */
function drawInvisibleText(page, font, size, marker) {
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText(marker, { x: size.w * 0.2, y: size.h * 0.6, size: 14, font });
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
}

function addAnnots(doc, page, dicts) {
    const refs = dicts.map((d) => doc.context.register(doc.context.obj(d)));
    const existing = page.node.lookup(PDFName.of('Annots'));
    const arr = existing instanceof PDFArray ? existing : doc.context.obj([]);
    for (const r of refs) arr.push(r);
    page.node.set(PDFName.of('Annots'), arr);
    return refs;
}

// ---------------------------------------------------------------------------
// Content classes
// ---------------------------------------------------------------------------
{
    const { doc } = await newDoc('M5 vector');
    drawVector(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4);
    await write('vector-a4', doc, 'pure vector drawing, no text, no image');
}
{
    const { doc, font } = await newDoc('M5 text');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'NATIVE-TEXT-M5P');
    await write('text-a4', doc, 'vector drawing with native searchable text');
}
{
    const { doc, font } = await newDoc('M5 OCR');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawInvisibleText(page, font, SHEET.A4, 'OCR-LAYER-M5P');
    await write('ocr-a4', doc, 'an invisible OCR text layer (Tr 3)');
}
{
    const { doc, font } = await newDoc('M5 three pages');
    for (let i = 1; i <= 3; i += 1) {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawVector(page, SHEET.A4, { colour: i % 2 === 0 });
        drawText(page, font, SHEET.A4, `PAGE-ORDER-M5P-${i}`);
    }
    await write('three-pages', doc, 'three pages, each marked with its number');
}
{
    const { doc } = await newDoc('M5 A3');
    drawVector(doc.addPage([SHEET.A3.w, SHEET.A3.h]), SHEET.A3);
    await write('vector-a3', doc, 'A3 sheet');
}
{
    const { doc } = await newDoc('M5 A1');
    drawVector(doc.addPage([SHEET.A1.w, SHEET.A1.h]), SHEET.A1);
    await write('vector-a1', doc, 'A1 sheet, for the raster ceiling');
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
for (const angle of [0, 90, 180, 270]) {
    const { doc, font } = await newDoc(`M5 rotate ${angle}`);
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, `ROTATE-M5P-${angle}`);
    page.setRotation(degrees(angle));
    await write(`rotate-${angle}`, doc, `/Rotate ${angle}`);
}
{
    // A CropBox that does not start at the origin: the case the old Layer
    // missed 61% of.
    const { doc, font } = await newDoc('M5 crop offset');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'CROP-OFFSET-M5P');
    page.node.set(PDFName.of('CropBox'), doc.context.obj([50, 70, SHEET.A4.w - 40, SHEET.A4.h - 60]));
    await write('crop-offset', doc, 'CropBox origin at (50,70)');
}
{
    // Content outside the CropBox: Margin used to reveal it.
    const { doc, font } = await newDoc('M5 hidden content');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    page.drawText('HIDDEN-OUTSIDE-CROP-M5P', {
        x: 20, y: SHEET.A4.h - 30, size: 12, font, color: rgb(0.9, 0, 0),
    });
    page.node.set(PDFName.of('CropBox'), doc.context.obj([0, 0, SHEET.A4.w, SHEET.A4.h - 60]));
    await write('mediabox-larger', doc, 'content above the CropBox, hidden');
}
{
    const { doc, font } = await newDoc('M5 mediabox offset');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'MEDIABOX-OFFSET-M5P');
    page.node.set(PDFName.of('MediaBox'), doc.context.obj([200, 300, 200 + SHEET.A4.w, 300 + SHEET.A4.h]));
    page.node.set(PDFName.of('CropBox'), doc.context.obj([200, 300, 200 + SHEET.A4.w, 300 + SHEET.A4.h]));
    await write('mediabox-offset', doc, 'MediaBox origin at (200,300)');
}

// ---------------------------------------------------------------------------
// Structure: annotations, links, destinations, outlines, forms
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M5 annotations');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'ANNOT-M5P');
    addAnnots(doc, page, [
        {
            Type: 'Annot', Subtype: 'Square', Rect: [120, 400, 300, 520],
            C: [0, 0, 1], IC: [0, 0, 1], CA: 1, F: 4, T: PDFString.of('M5-SQUARE'),
        },
        {
            Type: 'Annot', Subtype: 'Text', Rect: [320, 460, 340, 480],
            Contents: PDFString.of('M5-NOTE'), F: 4,
        },
    ]);
    await write('annotation-a4', doc, 'a Square and a Text annotation, wholly inside the page');
}
{
    // One annotation crossing the CropBox: Margin must refuse this, by name.
    const { doc, font } = await newDoc('M5 annotation across the crop');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'ANNOT-PARTIAL-M5P');
    page.node.set(PDFName.of('CropBox'), doc.context.obj([40, 40, SHEET.A4.w - 40, SHEET.A4.h - 40]));
    addAnnots(doc, page, [{
        Type: 'Annot', Subtype: 'Square', Rect: [10, 300, 200, 420], C: [1, 0, 0], F: 4,
    }]);
    await write('annotation-partial-crop', doc, 'a Square half outside the CropBox');
}
{
    const { doc, font } = await newDoc('M5 links');
    const pages = [0, 1].map(() => doc.addPage([SHEET.A4.w, SHEET.A4.h]));
    pages.forEach((p, i) => {
        drawVector(p, SHEET.A4, { colour: false });
        drawText(p, font, SHEET.A4, `LINK-PAGE-M5P-${i + 1}`);
    });
    // A URI link, an internal XYZ destination, and a FitR one.
    addAnnots(doc, pages[0], [
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 700, 300, 720], Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.invalid/m5p') },
        },
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 650, 300, 670], Border: [0, 0, 0],
            Dest: [pages[1].ref, PDFName.of('XYZ'), PDFNumber.of(100), PDFNumber.of(700), PDFNumber.of(0)],
        },
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 600, 300, 620], Border: [0, 0, 0],
            A: {
                Type: 'Action',
                S: 'GoTo',
                D: [pages[1].ref, PDFName.of('FitR'), PDFNumber.of(50), PDFNumber.of(60), PDFNumber.of(300), PDFNumber.of(400)],
            },
        },
    ]);
    // A named destination, in the /Names tree, plus an outline that uses it.
    const destArray = doc.context.obj([pages[1].ref, PDFName.of('FitH'), PDFNumber.of(500)]);
    const namesDict = doc.context.obj({
        Names: [PDFString.of('M5P-NAMED'), destArray],
    });
    doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: namesDict }));
    const outlineItem = doc.context.obj({
        Title: PDFString.of('M5P outline'),
        Dest: [pages[1].ref, PDFName.of('XYZ'), PDFNumber.of(70), PDFNumber.of(600), PDFNumber.of(0)],
    });
    const itemRef = doc.context.register(outlineItem);
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({
        Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1,
    })));
    await write('internal-links', doc, 'URI link, XYZ and FitR destinations, a named destination and an outline');
}
{
    const { doc, font } = await newDoc('M5 form');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'FORM-M5P');
    const fieldDict = doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Ft: 'Tx',
        T: PDFString.of('m5p.text'), V: PDFString.of('M5P-FIELD-VALUE'),
        Rect: [120, 300, 400, 330], F: 4,
        DA: PDFString.of('/Helv 14 Tf 0 g'),
        BS: { W: 2, S: 'S' },
    });
    const fieldRef = doc.context.register(fieldDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([fieldRef]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [fieldRef], DA: PDFString.of('/Helv 12 Tf 0 g'),
    })));
    await write('form-a4', doc, 'one text field with a value, /DA 14pt and a 2pt border');
}

// ---------------------------------------------------------------------------
// Signature states and XFA
// ---------------------------------------------------------------------------
{
    // An applied signature: /ByteRange covers the file and /Contents holds a
    // digest of it, so the gate can prove a re-save would have invalidated it.
    const { doc, font } = await newDoc('M5 signed');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'SIGNED-M5P');
    const sigDict = doc.context.obj({
        Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(32)),
        M: PDFString.of('D:20260101000000Z'),
    });
    const sigRef = doc.context.register(sigDict);
    const widget = doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('m5p.sig'),
        V: sigRef, Rect: [380, 80, 560, 140], F: 4,
    });
    const widgetRef = doc.context.register(widget);
    page.node.set(PDFName.of('Annots'), doc.context.obj([widgetRef]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widgetRef], SigFlags: 3,
    })));
    const bytes = await doc.save({ useObjectStreams: false });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const patched = Buffer.from(bytes);
    const marker = Buffer.from('00'.repeat(32), 'ascii');
    const at = patched.indexOf(marker);
    if (at >= 0) patched.write(digest.slice(0, 64), at, 'ascii');
    fs.writeFileSync(path.join(OUT, 'signature-a4.pdf'), patched);
    written.push({ name: 'signature-a4', bytes: patched.length, note: 'an applied signature over the whole file' });
}
{
    // The same infrastructure with nothing signed: a form field, not a signature.
    const { doc, font } = await newDoc('M5 unsigned signature field');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'UNSIGNED-FIELD-M5P');
    const widget = doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('m5p.blank'),
        Rect: [380, 80, 560, 140], F: 4,
    });
    const widgetRef = doc.context.register(widget);
    page.node.set(PDFName.of('Annots'), doc.context.obj([widgetRef]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widgetRef], SigFlags: 3,
    })));
    await write('unsigned-signature-field', doc, 'an empty /Sig field with /SigFlags 3');
}
{
    // /SigFlags and nothing else: refuses nothing, under the adopted policy.
    const { doc, font } = await newDoc('M5 sigflags only');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'SIGFLAGS-ONLY-M5P');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [], SigFlags: 3,
    })));
    await write('sigflags-only', doc, '/SigFlags 3 with no fields at all');
}
{
    const { doc, font } = await newDoc('M5 XFA');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'XFA-M5P');
    const xfa = doc.context.stream(zlib.deflateSync(Buffer.from(
        '<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">M5P</xdp:xdp>', 'utf8',
    )), { Filter: 'FlateDecode' });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [], XFA: doc.context.register(xfa),
    })));
    await write('xfa-a4', doc, 'an AcroForm carrying /XFA');
}

// ---------------------------------------------------------------------------
// Metadata and a document that cannot be read at all
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M5 metadata');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawText(page, font, SHEET.A4, 'METADATA-M5P');
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description dc:title="M5P-XMP-TITLE" xmlns:dc="http://purl.org/dc/elements/1.1/"/>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const stream = doc.context.stream(Buffer.from(xmp, 'utf8'), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    await write('metadata-a4', doc, 'Info fields and an XMP packet');
}
{
    fs.writeFileSync(path.join(OUT, 'invalid.pdf'), Buffer.from('not a pdf at all\n', 'utf8'));
    written.push({ name: 'invalid', bytes: 17, note: 'not a PDF' });
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify(written, null, 2)}\n`);
console.log(`${written.length} fixtures -> ${OUT}`);
for (const f of written) console.log(`  ${f.name.padEnd(26)} ${String(f.bytes).padStart(8)} B  ${f.note}`);
