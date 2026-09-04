/**
 * Generate the synthetic PDFs the page-size normalizer smoke test runs against.
 *
 * Everything here is drawn from geometry and text we control. No customer
 * document, company drawing or real project file is ever used, and nothing
 * generated here is committed (test-fixtures/ is git-ignored).
 *
 *   size-a1-landscape.pdf   A1 landscape, vector + text            (already-target case)
 *   size-a3-landscape.pdf   A3 landscape, vector + text            (up-scale case)
 *   size-mixed.pdf          A1 / A3 / A3 / A1                      (mixed multipage)
 *   size-a3-portrait.pdf    A3 portrait                            (orientation kept)
 *   size-a3-rotated.pdf     A3 portrait MediaBox with /Rotate 90   (rotation case)
 *   size-custom.pdf         700 x 500 pt, not an A-series sheet    (aspect ratio case)
 *   size-text-native.pdf    A3 landscape, rich embedded text       (text extraction)
 *   size-ocr-layer.pdf      image-only page + invisible text layer (M1 OCR output shape)
 *   size-annotated.pdf      A3 landscape with a square annotation  (annotation transform)
 *   size-form.pdf           A3 landscape with an AcroForm text field (form preservation)
 *   size-a3-rot180.pdf      A3 landscape MediaBox with /Rotate 180  (rotation case)
 *   size-a3-rot270.pdf      A3 portrait MediaBox with /Rotate 270   (rotation case)
 *   size-mediabox-mismatch  MediaBox > CropBox, CropBox == exact A1 (page-box only)
 *   size-cropbox-hidden.pdf MediaBox > CropBox with marks outside it (hidden content)
 *   size-cropbox-annot.pdf  same, plus an annotation outside CropBox (must be refused)
 *
 * Every drawing sheet carries four filled corner markers whose outer edges sit
 * exactly INSET_PT from the sheet edge, so the ink bounding box of a rendered
 * page is known in advance. That is what makes "nothing was cropped", "the
 * content is centred" and "the aspect ratio is intact" measurable rather than
 * eyeballed.
 *
 * Run:  node scripts/make-size-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
    beginText,
    degrees,
    endText,
    PDFDocument,
    PDFName,
    popGraphicsState,
    pushGraphicsState,
    rgb,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
    StandardFonts,
    TextRenderingMode,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures');
const JP_FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');

const mm = (v) => (v * 72) / 25.4;

/** Same table as src/utils/page-size-normalizer.ts, restated so the smoke is an
 *  independent witness rather than a mirror of the implementation. */
const SHEET = {
    A0: [mm(1189), mm(841)],
    A1: [mm(841), mm(594)],
    A2: [mm(594), mm(420)],
    A3: [mm(420), mm(297)],
    A4: [mm(297), mm(210)],
};

/** Outer edge of the corner markers, measured from the sheet edge. */
export const INSET_PT = 6;
const MARKER_PT = 16;

fs.mkdirSync(OUT, { recursive: true });

/**
 * One drawing sheet: corner markers, a border, vector lines, a rectangle and
 * text. The markers alone define the ink bounding box; everything else lives
 * inside it and exercises vector and text preservation.
 */
function drawSheet(page, w, h, font, label) {
    const ink = rgb(0, 0, 0);

    // Corner markers -> ink box is exactly [INSET, INSET, w-INSET, h-INSET].
    for (const [x, y] of [
        [INSET_PT, INSET_PT],
        [w - INSET_PT - MARKER_PT, INSET_PT],
        [INSET_PT, h - INSET_PT - MARKER_PT],
        [w - INSET_PT - MARKER_PT, h - INSET_PT - MARKER_PT],
    ]) {
        page.drawRectangle({ x, y, width: MARKER_PT, height: MARKER_PT, color: ink });
    }

    // Drawing border, well inside the markers.
    page.drawRectangle({
        x: w * 0.06,
        y: h * 0.06,
        width: w * 0.88,
        height: h * 0.88,
        borderColor: ink,
        borderWidth: 3,
    });

    // Vector geometry: two diagonals and a filled-outline rectangle.
    page.drawLine({ start: { x: w * 0.1, y: h * 0.1 }, end: { x: w * 0.9, y: h * 0.9 }, thickness: 2, color: ink });
    page.drawLine({ start: { x: w * 0.1, y: h * 0.9 }, end: { x: w * 0.9, y: h * 0.1 }, thickness: 2, color: ink });
    page.drawRectangle({
        x: w * 0.35,
        y: h * 0.35,
        width: w * 0.3,
        height: h * 0.3,
        borderColor: ink,
        borderWidth: 2,
    });

    const size = Math.max(10, Math.min(w, h) * 0.03);
    page.drawText(label, { x: w * 0.1, y: h * 0.2, size, font, color: ink });
    page.drawText('SECTION A-A', { x: w * 0.1, y: h * 0.2 - size * 1.6, size, font, color: ink });
}

function newSheet(pdfDoc, [w, h], font, label, rotation = 0) {
    const page = pdfDoc.addPage([w, h]);
    if (rotation) page.setRotation(degrees(rotation));
    drawSheet(page, w, h, font, label);
    return page;
}

async function write(name, pdfDoc) {
    const bytes = await pdfDoc.save();
    fs.writeFileSync(path.join(OUT, name), bytes);
    console.log(`  ${name.padEnd(26)} ${bytes.length} bytes`);
}

// ---------------------------------------------------------------------------
// A minimal PNG encoder, so the image-only fixture needs no browser and no new
// dependency. 8-bit RGB, filter 0 on every row.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, crc]);
}

function encodePng(width, height, rgbBuf) {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgbBuf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** White sheet with black blocks standing in for scanned glyphs plus markers. */
function scannedRaster(width, height, wordBoxes) {
    const buf = Buffer.alloc(width * height * 3, 0xff);
    const fill = (x0, y0, x1, y1) => {
        for (let y = Math.max(0, y0 | 0); y < Math.min(height, y1 | 0); y++) {
            for (let x = Math.max(0, x0 | 0); x < Math.min(width, x1 | 0); x++) {
                const i = (y * width + x) * 3;
                buf[i] = 0;
                buf[i + 1] = 0;
                buf[i + 2] = 0;
            }
        }
    };
    const marker = Math.round((MARKER_PT / 1190) * width);
    const inset = Math.round((INSET_PT / 1190) * width);
    fill(inset, inset, inset + marker, inset + marker);
    fill(width - inset - marker, inset, width - inset, inset + marker);
    fill(inset, height - inset - marker, inset + marker, height - inset);
    fill(width - inset - marker, height - inset - marker, width - inset, height - inset);
    for (const b of wordBoxes) fill(b.x0, b.y0, b.x1, b.y1);
    return encodePng(width, height, buf);
}

// ---------------------------------------------------------------------------

const jpAvailable = fs.existsSync(JP_FONT);
console.log(`Writing fixtures to ${OUT}${jpAvailable ? '' : '  (Japanese font missing, falling back to Helvetica)'}`);

// 1 / 2 / 4 / 5 / 6 — plain single-page sheets.
for (const [name, size, label, rotation] of [
    ['size-a1-landscape.pdf', SHEET.A1, 'A1 LANDSCAPE', 0],
    ['size-a3-landscape.pdf', SHEET.A3, 'A3 LANDSCAPE', 0],
    ['size-a3-portrait.pdf', [SHEET.A3[1], SHEET.A3[0]], 'A3 PORTRAIT', 0],
    ['size-a3-rotated.pdf', [SHEET.A3[1], SHEET.A3[0]], 'A3 ROTATED 90', 90],
    ['size-custom.pdf', [700, 500], 'CUSTOM 700x500', 0],
]) {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    newSheet(pdfDoc, size, font, label, rotation);
    await write(name, pdfDoc);
}

// 3 — mixed multipage, each page individually labelled so order is checkable.
{
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    newSheet(pdfDoc, SHEET.A1, font, 'PAGE 1 A1');
    newSheet(pdfDoc, SHEET.A3, font, 'PAGE 2 A3');
    newSheet(pdfDoc, SHEET.A3, font, 'PAGE 3 A3');
    newSheet(pdfDoc, SHEET.A1, font, 'PAGE 4 A1');
    await write('size-mixed.pdf', pdfDoc);
}

// 7 — text-native vector page carrying text that must survive verbatim.
{
    const pdfDoc = await PDFDocument.create();
    let font;
    if (jpAvailable) {
        pdfDoc.registerFontkit(fontkit);
        font = await pdfDoc.embedFont(fs.readFileSync(JP_FONT), { subset: true });
    } else {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
    const [w, h] = SHEET.A3;
    const page = newSheet(pdfDoc, SHEET.A3, font, 'TEXT NATIVE', 0);
    const body = jpAvailable ? '建築図面テキストレイヤ' : 'ARCHITECTURAL TEXT LAYER';
    page.drawText(body, { x: w * 0.15, y: h * 0.62, size: 22, font, color: rgb(0, 0, 0) });
    page.drawText('SCALE 1:100', { x: w * 0.15, y: h * 0.56, size: 22, font, color: rgb(0, 0, 0) });
    await write('size-text-native.pdf', pdfDoc);
}

// 8 — the shape M1 OCR emits: an image-only page with an invisible text layer.
{
    const pdfDoc = await PDFDocument.create();
    let font;
    if (jpAvailable) {
        pdfDoc.registerFontkit(fontkit);
        font = await pdfDoc.embedFont(fs.readFileSync(JP_FONT), { subset: true });
    } else {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
    const [w, h] = SHEET.A3;
    const imgW = 595;
    const imgH = 421;
    const words = jpAvailable
        ? [
            { text: '建築図面', box: { x0: 90, y0: 150, x1: 250, y1: 182 } },
            { text: '平面図', box: { x0: 90, y0: 200, x1: 210, y1: 232 } },
            { text: 'SCALE 1:100', box: { x0: 300, y0: 150, x1: 470, y1: 182 } },
        ]
        : [
            { text: 'DRAWING', box: { x0: 90, y0: 150, x1: 250, y1: 182 } },
            { text: 'PLAN', box: { x0: 90, y0: 200, x1: 210, y1: 232 } },
            { text: 'SCALE 1:100', box: { x0: 300, y0: 150, x1: 470, y1: 182 } },
        ];

    const png = await pdfDoc.embedPng(scannedRaster(imgW, imgH, words.map((word) => word.box)));
    const page = pdfDoc.addPage([w, h]);
    page.drawImage(png, { x: 0, y: 0, width: w, height: h });

    // Same operator sequence as src/utils/pdf-textifier/searchable-pdf.ts: a
    // rendering-mode-3 block appended after the page content.
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    const operators = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const { text, box } of words) {
        const x = (box.x0 / imgW) * w;
        const yTop = (box.y0 / imgH) * h;
        const yBottom = (box.y1 / imgH) * h;
        const sizePt = Math.abs(yBottom - yTop);
        operators.push(
            setFontAndSize(fontName, sizePt),
            setTextMatrix(1, 0, 0, 1, x, h - yBottom),
            showText(font.encodeText(text)),
        );
    }
    operators.push(endText(), popGraphicsState());
    page.pushOperators(...operators);
    await write('size-ocr-layer.pdf', pdfDoc);
}

// 9 — an annotation, so the smoke can prove it moves with the content.
{
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const [w, h] = SHEET.A3;
    const page = newSheet(pdfDoc, SHEET.A3, font, 'ANNOTATED A3', 0);
    const rect = [w * 0.4, h * 0.4, w * 0.6, h * 0.6];
    const annot = pdfDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: rect,
        F: 4,
        C: [1, 0, 0],
    });
    page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([pdfDoc.context.register(annot)]));
    await write('size-annotated.pdf', pdfDoc);
}

// 10 / 11 - the remaining /Rotate quadrants.
for (const [name, size, label, rotation] of [
    ['size-a3-rot180.pdf', SHEET.A3, 'A3 ROTATED 180', 180],
    ['size-a3-rot270.pdf', [SHEET.A3[1], SHEET.A3[0]], 'A3 ROTATED 270', 270],
]) {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    newSheet(pdfDoc, size, font, label, rotation);
    await write(name, pdfDoc);
}

// 12 - CropBox is already exactly A1 but the MediaBox is much larger. Only the
// page boxes need normalising; the content must not be touched at all.
{
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const [w, h] = SHEET.A1;
    const page = pdfDoc.addPage([3000, 2000]);
    page.setCropBox(0, 0, w, h);
    drawSheet(page, w, h, font, 'MEDIABOX MISMATCH');
    await write('size-mediabox-mismatch.pdf', pdfDoc);
}

// 13 / 14 - a CropBox that hides part of the page. The hidden marks sit just
// outside its left and right edges, and the CropBox aspect ratio (900x700) is
// far enough from A1 that the fit leaves ~110pt of padding on each side --
// exactly where those marks would surface without a clip.
const HIDDEN_MEDIA = [1300, 900];
const HIDDEN_CROP = { x: 200, y: 100, width: 900, height: 700 };
const buildHiddenSheet = async (withOutsideAnnot) => {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage(HIDDEN_MEDIA);
    page.setCropBox(HIDDEN_CROP.x, HIDDEN_CROP.y, HIDDEN_CROP.width, HIDDEN_CROP.height);

    // Visible sheet, drawn in CropBox coordinates.
    const ink = rgb(0, 0, 0);
    const cx = HIDDEN_CROP.x;
    const cy = HIDDEN_CROP.y;
    const cw = HIDDEN_CROP.width;
    const ch = HIDDEN_CROP.height;
    for (const [mx, my] of [
        [cx + INSET_PT, cy + INSET_PT],
        [cx + cw - INSET_PT - MARKER_PT, cy + INSET_PT],
        [cx + INSET_PT, cy + ch - INSET_PT - MARKER_PT],
        [cx + cw - INSET_PT - MARKER_PT, cy + ch - INSET_PT - MARKER_PT],
    ]) {
        page.drawRectangle({ x: mx, y: my, width: MARKER_PT, height: MARKER_PT, color: ink });
    }
    page.drawRectangle({ x: cx + 60, y: cy + 60, width: cw - 120, height: ch - 120, borderColor: ink, borderWidth: 3 });
    page.drawText('INSIDE CROP', { x: cx + 100, y: cy + 120, size: 26, font, color: ink });

    // Hidden by the CropBox: solid blocks and text hard against its edges.
    page.drawRectangle({ x: cx - 50, y: cy + 250, width: 45, height: 200, color: ink });
    page.drawRectangle({ x: cx + cw + 5, y: cy + 250, width: 45, height: 200, color: ink });
    page.drawText('HIDDENLEFT', { x: cx - 190, y: cy + 480, size: 24, font, color: ink });
    page.drawText('HIDDENRIGHT', { x: cx + cw + 5, y: cy + 480, size: 24, font, color: ink });

    // An annotation well inside the CropBox always has to keep working.
    const annots = [pdfDoc.context.register(pdfDoc.context.obj({
        Type: 'Annot', Subtype: 'Square', F: 4, C: [0, 0, 1],
        Rect: [cx + 300, cy + 250, cx + 500, cy + 400],
    }))];
    if (withOutsideAnnot) {
        annots.push(pdfDoc.context.register(pdfDoc.context.obj({
            Type: 'Annot', Subtype: 'Square', F: 4, C: [1, 0, 0],
            Rect: [cx + cw + 5, cy + 250, cx + cw + 50, cy + 450],
        })));
    }
    page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(annots));
    return pdfDoc;
};
await write('size-cropbox-hidden.pdf', await buildHiddenSheet(false));
await write('size-cropbox-annot.pdf', await buildHiddenSheet(true));

// 15 - an AcroForm text field, so the smoke can prove forms are not dropped.
{
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const [w, h] = SHEET.A3;
    const page = newSheet(pdfDoc, SHEET.A3, font, 'FORM A3', 0);
    const field = pdfDoc.getForm().createTextField('drawing.number');
    field.setText('A-101');
    field.addToPage(page, { x: w * 0.65, y: h * 0.14, width: 220, height: 32 });
    await write('size-form.pdf', pdfDoc);
}

console.log('done');
