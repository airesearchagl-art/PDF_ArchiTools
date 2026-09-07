/**
 * Synthetic PDFs for the M3 annotator-save spike.
 *
 * Six small documents, each carrying something a save path can lose. They exist
 * so that "the source is preserved" can be a measurement rather than a claim:
 * every one of them has a feature that survives, changes or disappears, and the
 * probe reports which.
 *
 * No customer document and no real project drawing is used anywhere. Nothing
 * generated here is committed -- test-fixtures/ is ignored -- and generation is
 * deterministic, so a number that moves between two runs is a change in the
 * code rather than noise.
 *
 * Run:  node scripts/research-m3-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm3');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');
const EPOCH = new Date(0);

const A4 = { w: 595.28, h: 841.89 };
const A3 = { w: 841.89, h: 1190.55 };
const A0 = { w: 2383.94, h: 3370.39 };

if (!fs.existsSync(FONT)) {
    console.error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.pdf') || file.endsWith('.json')) fs.unlinkSync(path.join(OUT, file));
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

/** Deterministic metadata on every fixture, so nothing drifts between runs. */
function stamp(doc, title) {
    doc.setTitle(title);
    doc.setAuthor('m3 research fixtures');
    doc.setSubject('synthetic');
    doc.setKeywords(['m3', 'synthetic', 'research']);
    doc.setProducer('research-m3-fixtures');
    doc.setCreator('research-m3-fixtures');
    doc.setCreationDate(EPOCH);
    doc.setModificationDate(EPOCH);
}

/**
 * Vector content plus real text.
 *
 * Both matter separately: a save path can keep the look of the lines while
 * losing every character, which is the failure mode this whole spike is about.
 */
function drawSheet(page, font, size, label, { japanese = true } = {}) {
    const m = 0.05;
    const x0 = size.w * m;
    const y0 = size.h * m;
    const w = size.w * (1 - 2 * m);
    const h = size.h * (1 - 2 * m);
    const bar = (x, y, width, height) => page.drawRectangle({ x, y, width, height, color: rgb(0, 0, 0) });
    bar(x0, y0, w, 1.2);
    bar(x0, y0 + h, w, 1.2);
    bar(x0, y0, 1.2, h);
    bar(x0 + w, y0, 1.2, h);

    // A few diagonals and circles, so there is vector geometry that is not just
    // axis-aligned rectangles.
    page.drawLine({ start: { x: x0, y: y0 }, end: { x: x0 + w, y: y0 + h }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
    page.drawLine({ start: { x: x0, y: y0 + h }, end: { x: x0 + w, y: y0 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
    page.drawCircle({ x: size.w / 2, y: size.h / 2, size: size.w / 8, borderWidth: 1.1, borderColor: rgb(0.2, 0.2, 0.6) });

    const fs1 = size.w / 30;
    page.drawText(label, { x: x0 + 10, y: y0 + h - fs1 - 8, size: fs1, font, color: rgb(0, 0, 0) });
    page.drawText('A-101 GROUND FLOOR PLAN', { x: x0 + 10, y: y0 + h - fs1 * 2.4, size: fs1 * 0.5, font, color: rgb(0, 0, 0) });
    if (japanese) {
        page.drawText('A-101 建築平面図', { x: x0 + 10, y: y0 + h - fs1 * 3.4, size: fs1 * 0.5, font, color: rgb(0, 0, 0) });
        page.drawText('縮尺 1:100  改訂 A', { x: x0 + 10, y: y0 + 12, size: fs1 * 0.4, font, color: rgb(0, 0, 0) });
    }
}

/** A page's worth of HTML rastered to PNG, for the scanned fixtures. */
async function raster(html, pxW, pxH) {
    const p = await browser.newPage();
    await p.setViewport({ width: pxW, height: pxH, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
      html, body { margin:0; padding:0; background:#fff; }
      body { width:${pxW}px; height:${pxH}px; font-family:"M",sans-serif; color:#000; }
    </style></head><body>${html}</body></html>`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.fonts.ready);
    const png = await p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: pxW, height: pxH } });
    await p.close();
    return png;
}

const written = [];
const write = async (name, doc, note) => {
    const bytes = await doc.save();
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
};

// ---------------------------------------------------------------------------
// 1. native.pdf -- vector, real text, mixed page sizes
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 native vector and text');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    drawSheet(doc.addPage([A4.w, A4.h]), font, A4, 'PAGE 1  A4');
    drawSheet(doc.addPage([A3.w, A3.h]), font, A3, 'PAGE 2  A3');
    // A page with nothing added to it later, for the no-annotation case.
    drawSheet(doc.addPage([A4.w, A4.h]), font, A4, 'PAGE 3  A4  (no annotation)');
    await write('native', doc, 'vector + searchable text, mixed sizes, one page left un-annotated');
}

// ---------------------------------------------------------------------------
// 2. rotated.pdf -- all four /Rotate quadrants, same content
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 rotation quadrants');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    for (const rotate of [0, 90, 180, 270]) {
        const page = doc.addPage([A4.w, A4.h]);
        drawSheet(page, font, A4, `ROTATE ${rotate}`);
        if (rotate) page.setRotation(degrees(rotate));
    }
    await write('rotated', doc, '/Rotate 0, 90, 180, 270 with identical content');
}

// ---------------------------------------------------------------------------
// 3. boxes.pdf -- MediaBox and CropBox disagreeing
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 page boxes');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });

    const plain = doc.addPage([A4.w, A4.h]);
    drawSheet(plain, font, A4, 'MEDIABOX = CROPBOX');

    // A crop that hides a margin of the sheet. Content drawn outside the crop
    // is still in the file; anything that flattens the visible area loses it,
    // and anything that mis-maps coordinates will place a mark in it.
    const cropped = doc.addPage([A4.w, A4.h]);
    drawSheet(cropped, font, A4, 'CROPBOX SMALLER');
    cropped.drawText('HIDDEN BY CROPBOX', {
        x: 14, y: 20, size: 12, font, color: rgb(0.85, 0.1, 0.1),
    });
    cropped.node.set(PDFName.of('CropBox'), doc.context.obj([40, 40, A4.w - 40, A4.h - 40]));

    // A crop whose origin is not (0,0): the case that catches an implementation
    // assuming the page starts at the MediaBox origin.
    const offset = doc.addPage([A4.w, A4.h]);
    drawSheet(offset, font, A4, 'CROPBOX ORIGIN NOT ZERO');
    offset.node.set(PDFName.of('CropBox'), doc.context.obj([60, 90, A4.w - 20, A4.h - 30]));

    await write('boxes', doc, 'MediaBox = CropBox, CropBox smaller, CropBox origin non-zero');
}

// ---------------------------------------------------------------------------
// 4. features.pdf -- annotations, a form, outlines, metadata
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 existing PDF features');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    const page = doc.addPage([A4.w, A4.h]);
    drawSheet(page, font, A4, 'EXISTING FEATURES');

    // A square annotation and a text ("sticky note") annotation, built with the
    // low-level API because pdf-lib has no high-level constructor for them.
    const square = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: doc.context.obj([60, 600, 260, 700]),
        C: doc.context.obj([1, 0, 0]),
        CA: PDFNumber.of(1),
        F: PDFNumber.of(4),
        Contents: PDFString.of('existing square annotation'),
    });
    const note = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: doc.context.obj([300, 640, 320, 660]),
        Contents: PDFString.of('existing sticky note'),
        F: PDFNumber.of(4),
    });
    page.node.set(PDFName.of('Annots'), doc.context.obj([
        doc.context.register(square), doc.context.register(note),
    ]));

    const form = doc.getForm();
    const field = form.createTextField('drawing.number');
    field.setText('A-101');
    field.addToPage(page, { x: 60, y: 500, width: 200, height: 24, font });
    const check = form.createCheckBox('drawing.approved');
    check.check();
    check.addToPage(page, { x: 300, y: 500, width: 20, height: 20 });

    await write('features', doc, '2 annotations, 2 form fields, metadata');
}

// ---------------------------------------------------------------------------
// 5. scanned.pdf -- an image page, and an image page under a text layer
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 scanned and searchable-scanned');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    const pxW = 1200;
    const pxH = Math.round(pxW * (A4.h / A4.w));
    const html = `<div style="position:relative;width:${pxW}px;height:${pxH}px">
        <div style="position:absolute;left:40px;top:40px;width:${pxW - 80}px;height:${pxH - 80}px;border:3px solid #000"></div>
        <div style="position:absolute;left:70px;top:70px;font-size:44px">SCANNED SHEET</div>
        <div style="position:absolute;left:70px;top:130px;font-size:30px">A-101 建築平面図</div>
      </div>`;
    const png = await raster(html, pxW, pxH);
    const image = await doc.embedPng(png);

    const plain = doc.addPage([A4.w, A4.h]);
    plain.drawImage(image, { x: 0, y: 0, width: A4.w, height: A4.h });

    // The same raster with an invisible text layer over it, the way a
    // searchable PDF carries one.
    const searchable = doc.addPage([A4.w, A4.h]);
    searchable.drawImage(image, { x: 0, y: 0, width: A4.w, height: A4.h });
    searchable.drawText('A-101 建築平面図', {
        x: 34, y: A4.h - 96, size: 15, font, color: rgb(1, 1, 1), opacity: 0.01,
    });
    searchable.drawText('SCANNED SHEET', {
        x: 34, y: A4.h - 66, size: 22, font, color: rgb(1, 1, 1), opacity: 0.01,
    });

    await write('scanned', doc, 'image-only page, and an image page with an invisible text layer');
}

// ---------------------------------------------------------------------------
// 7. croprot.pdf -- a crop origin AND a rotation, together
// ---------------------------------------------------------------------------
//
// Each of those alone is already in the corpus. Together they are the case that
// catches a save path which handles one and forgets the other, because either
// fix on its own still looks right on the fixture that only exercises it.
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 crop and rotation together');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    for (const rotate of [0, 90, 180, 270]) {
        const page = doc.addPage([A4.w, A4.h]);
        drawSheet(page, font, A4, `CROP + ROTATE ${rotate}`);
        page.node.set(PDFName.of('CropBox'), doc.context.obj([50, 70, A4.w - 30, A4.h - 25]));
        if (rotate) page.setRotation(degrees(rotate));
    }
    await write('croprot', doc, 'CropBox origin (50,70) on all four rotations');
}

// ---------------------------------------------------------------------------
// 8. signed.pdf -- a signature field, for the support boundary
// ---------------------------------------------------------------------------
//
// A signature *field*, not a real signature: enough to exercise detection,
// which is what the boundary needs. Producing a genuinely signed document would
// need a certificate and a signing implementation, and would measure those
// rather than the refusal.
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 signature field');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
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
// 9. damaged.pdf -- a file that is not a PDF any more
// ---------------------------------------------------------------------------
{
    const source = fs.readFileSync(path.join(OUT, 'native.pdf'));
    const broken = Buffer.from(source);
    // Wipe the cross-reference table's neighbourhood at the end of the file.
    broken.fill(0x41, broken.length - 400, broken.length - 40);
    fs.writeFileSync(path.join(OUT, 'damaged.pdf'), broken);
    written.push({ name: 'damaged', bytes: broken.length, note: 'truncated xref region, for the refusal path' });
}

// ---------------------------------------------------------------------------
// 6. a0.pdf -- the sheet nothing should rasterise whole
// ---------------------------------------------------------------------------
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc, 'M3 A0');
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    drawSheet(doc.addPage([A0.w, A0.h]), font, A0, 'A0 SHEET');
    await write('a0', doc, 'one A0 page, for the rasterisation bound');
}

await browser.close();

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({
    files: written,
    sizes: { A4, A3, A0 },
    expectedText: {
        ascii: 'A-101 GROUND FLOOR PLAN',
        japanese: 'A-101 建築平面図',
    },
}, null, 2)}\n`);

for (const f of written) {
    console.log(`  ${f.name.padEnd(10)} ${String(f.bytes).padStart(8)} bytes  ${f.note}`);
}
console.log(`\n  wrote ${written.length} fixtures to test-fixtures/m3/\n`);
