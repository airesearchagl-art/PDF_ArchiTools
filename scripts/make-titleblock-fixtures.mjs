/**
 * Generate the synthetic PDFs the title-block updater smoke runs against.
 *
 * Every sheet is drawn from geometry and text we control. No customer document,
 * company drawing or real project file is ever used, and nothing generated here
 * is committed (test-fixtures/ is git-ignored).
 *
 *   tb-a1.pdf              A1 landscape, title block at a fixed relative spot
 *   tb-a3.pdf              A3 landscape, same relative spot, different paper
 *   tb-mixed.pdf           A1 / A3 / A1 / A3 / A1  (five pages, mixed sizes)
 *   tb-rotated.pdf         A1 portrait MediaBox with /Rotate 90 -> shown landscape
 *   tb-portrait-mix.pdf    landscape page followed by a portrait one (must refuse)
 *   tb-scanned.pdf         image-only page, title block baked into the raster
 *   tb-searchable.pdf      image-only page plus an invisible text layer (M1 shape)
 *   tb-portrait.pdf        A1 portrait, same relative title block
 *   tb-rot180.pdf          A1 landscape MediaBox with /Rotate 180
 *   tb-rot270.pdf          A1 portrait MediaBox with /Rotate 270
 *
 * The title block sits at the same fractions of every sheet, which is what makes
 * one set of rules work across A1 and A3:
 *
 *   status field  x 0.720..0.960   y 0.828..0.888   (from the top)
 *   date field    x 0.720..0.960   y 0.900..0.950
 *
 * Run:  node scripts/make-titleblock-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
    beginText,
    concatTransformationMatrix,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
    TextRenderingMode,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures');
const JP_FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');

const mm = (v) => (v * 72) / 25.4;
const A1 = [mm(841), mm(594)];
const A3 = [mm(420), mm(297)];

/** Shared by the fixtures and the smoke, so both agree on where to aim. */
export const FIELDS = {
    status: { x: 0.720, y: 0.828, width: 0.240, height: 0.060 },
    date: { x: 0.720, y: 0.900, width: 0.240, height: 0.050 },
};
export const ORIGINAL_STATUS = '実施設計図';
export const ORIGINAL_DATE = '2026.03.15';

if (!fs.existsSync(JP_FONT)) {
    console.error(`Missing ${JP_FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
const JP_BYTES = fs.readFileSync(JP_FONT);
fs.mkdirSync(OUT, { recursive: true });

/** Rect given in "fraction of the sheet, y from the top" -> PDF user space. */
const toUser = (rect, w, h) => ({
    x: rect.x * w,
    y: (1 - rect.y - rect.height) * h,
    width: rect.width * w,
    height: rect.height * h,
});

/**
 * A drawing sheet: border, some vector geometry, a body label, and a title
 * block in the bottom-right carrying a status line and a date.
 */
function drawSheet(page, w, h, fonts, label) {
    const ink = rgb(0, 0, 0);

    page.drawRectangle({ x: w * 0.02, y: h * 0.02, width: w * 0.96, height: h * 0.96, borderColor: ink, borderWidth: 3 });
    page.drawLine({ start: { x: w * 0.08, y: h * 0.1 }, end: { x: w * 0.6, y: h * 0.7 }, thickness: 2, color: ink });
    page.drawRectangle({ x: w * 0.1, y: h * 0.25, width: w * 0.3, height: h * 0.35, borderColor: ink, borderWidth: 2 });
    page.drawText(label, { x: w * 0.08, y: h * 0.12, size: Math.max(10, h * 0.03), font: fonts.latin, color: ink });

    // Title block frame. The two fields sit inside it with a little breathing room.
    const frame = toUser({ x: 0.70, y: 0.80, width: 0.28, height: 0.17 }, w, h);
    page.drawRectangle({ ...frame, borderColor: ink, borderWidth: 2 });
    page.drawText('TITLE BLOCK', {
        x: frame.x + 8,
        y: frame.y + frame.height - Math.max(9, h * 0.022) - 4,
        size: Math.max(8, h * 0.018),
        font: fonts.latin,
        color: ink,
    });

    const status = toUser(FIELDS.status, w, h);
    const statusSize = status.height * 0.7;
    page.drawText(ORIGINAL_STATUS, {
        x: status.x + (status.width - fonts.jp.widthOfTextAtSize(ORIGINAL_STATUS, statusSize)) / 2,
        y: status.y + (status.height - fonts.jp.heightAtSize(statusSize, { descender: false })) / 2,
        size: statusSize,
        font: fonts.jp,
        color: ink,
    });

    const date = toUser(FIELDS.date, w, h);
    const dateSize = date.height * 0.7;
    page.drawText(ORIGINAL_DATE, {
        x: date.x + (date.width - fonts.latin.widthOfTextAtSize(ORIGINAL_DATE, dateSize)) / 2,
        y: date.y + (date.height - fonts.latin.heightAtSize(dateSize, { descender: false })) / 2,
        size: dateSize,
        font: fonts.latin,
        color: ink,
    });
}

async function newDoc() {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fonts = {
        latin: await pdfDoc.embedFont(StandardFonts.Helvetica),
        jp: await pdfDoc.embedFont(JP_BYTES, { subset: false }),
    };
    return { pdfDoc, fonts };
}

function addSheet(pdfDoc, fonts, [w, h], label, rotation = 0) {
    const page = pdfDoc.addPage([w, h]);
    if (rotation) page.setRotation(degrees(rotation));
    drawSheet(page, w, h, fonts, label);
    return page;
}

async function write(name, pdfDoc) {
    const bytes = await pdfDoc.save();
    fs.writeFileSync(path.join(OUT, name), bytes);
    console.log(`  ${name.padEnd(24)} ${bytes.length} bytes`);
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder for the scanned fixtures: no browser, no new dependency.
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
const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
};
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
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** White sheet with a border and dark blocks standing in for scanned glyphs. */
function scannedRaster(width, height) {
    const buf = Buffer.alloc(width * height * 3, 0xff);
    const fill = (x0, y0, x1, y1) => {
        for (let y = Math.max(0, y0 | 0); y < Math.min(height, y1 | 0); y++) {
            for (let x = Math.max(0, x0 | 0); x < Math.min(width, x1 | 0); x++) {
                const i = (y * width + x) * 3;
                buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
            }
        }
    };
    // Border.
    fill(0.02 * width, 0.02 * height, 0.98 * width, 0.025 * height);
    fill(0.02 * width, 0.975 * height, 0.98 * width, 0.98 * height);
    fill(0.02 * width, 0.02 * height, 0.025 * width, 0.98 * height);
    fill(0.975 * width, 0.02 * height, 0.98 * width, 0.98 * height);
    // Title-block fields, as solid ink where the text would be.
    for (const f of [FIELDS.status, FIELDS.date]) {
        fill((f.x + 0.03) * width, (f.y + 0.012) * height,
            (f.x + f.width - 0.03) * width, (f.y + f.height - 0.012) * height);
    }
    return encodePng(width, height, buf);
}

console.log(`Writing title-block fixtures to ${OUT}`);

// 1 / 2 - the two paper sizes with an identical relative layout.
for (const [name, size, label] of [
    ['tb-a1.pdf', A1, 'A1 SHEET'],
    ['tb-a3.pdf', A3, 'A3 SHEET'],
]) {
    const { pdfDoc, fonts } = await newDoc();
    addSheet(pdfDoc, fonts, size, label);
    await write(name, pdfDoc);
}

// 3 - five pages, mixed sizes, so one rule set has to cover both.
{
    const { pdfDoc, fonts } = await newDoc();
    addSheet(pdfDoc, fonts, A1, 'PAGE 1 A1');
    addSheet(pdfDoc, fonts, A3, 'PAGE 2 A3');
    addSheet(pdfDoc, fonts, A1, 'PAGE 3 A1');
    addSheet(pdfDoc, fonts, A3, 'PAGE 4 A3');
    addSheet(pdfDoc, fonts, A1, 'PAGE 5 A1');
    await write('tb-mixed.pdf', pdfDoc);
}

// 4 - portrait MediaBox carrying /Rotate 90, so it is displayed landscape.
//
// The sheet is drawn through a matrix taking "displayed page, origin
// bottom-left" into user space, so this page LOOKS exactly like tb-a1.pdf.
// That is what lets the smoke compare the two renders: if the rotation maths
// were wrong anywhere, the rotated page would stop matching the flat one.
//
// For /Rotate 90 on a MediaBox [0 0 W H]: a display point (lx, ly) sits at
// user (W - ly, lx), i.e. the matrix [0 1 -1 0 W 0].
{
    const { pdfDoc, fonts } = await newDoc();
    const [W, H] = [A1[1], A1[0]];
    const page = pdfDoc.addPage([W, H]);
    page.setRotation(degrees(90));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 1, -1, 0, W, 0));
    drawSheet(page, H, W, fonts, 'ROTATED 90');
    page.pushOperators(popGraphicsState());
    await write('tb-rotated.pdf', pdfDoc);
}

// 4b / 4c - the other two rotation quadrants, drawn the same way so the smoke
// can hold all three against the flat sheet.
//
//   /Rotate 180 on [0 0 W H]: display (lx, ly) -> user (W - lx, H - ly)
//   /Rotate 270 on [0 0 W H]: display (lx, ly) -> user (ly, H - lx)
{
    const { pdfDoc, fonts } = await newDoc();
    const [W, H] = A1;
    const page = pdfDoc.addPage([W, H]);
    page.setRotation(degrees(180));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(-1, 0, 0, -1, W, H));
    drawSheet(page, W, H, fonts, 'ROTATED 180');
    page.pushOperators(popGraphicsState());
    await write('tb-rot180.pdf', pdfDoc);
}
{
    const { pdfDoc, fonts } = await newDoc();
    const [W, H] = [A1[1], A1[0]];
    const page = pdfDoc.addPage([W, H]);
    page.setRotation(degrees(270));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, -1, 1, 0, 0, H));
    drawSheet(page, H, W, fonts, 'ROTATED 270');
    page.pushOperators(popGraphicsState());
    await write('tb-rot270.pdf', pdfDoc);
}

// 5b - a portrait sheet on its own, so a portrait representative page can be
// exercised without the landscape fallback that used to paper over it.
{
    const { pdfDoc, fonts } = await newDoc();
    addSheet(pdfDoc, fonts, [A1[1], A1[0]], 'A1 PORTRAIT');
    await write('tb-portrait.pdf', pdfDoc);
}

// 5 - a landscape page followed by a portrait one: must be refused.
{
    const { pdfDoc, fonts } = await newDoc();
    addSheet(pdfDoc, fonts, A1, 'LANDSCAPE PAGE');
    addSheet(pdfDoc, fonts, [A3[1], A3[0]], 'PORTRAIT PAGE');
    await write('tb-portrait-mix.pdf', pdfDoc);
}

// 6 / 7 - image-only, and the same page with an invisible text layer over it.
{
    const imgW = 842;
    const imgH = 595;
    const png = scannedRaster(imgW, imgH);

    for (const [name, withTextLayer] of [['tb-scanned.pdf', false], ['tb-searchable.pdf', true]]) {
        const { pdfDoc, fonts } = await newDoc();
        const [w, h] = A1;
        const page = pdfDoc.addPage([w, h]);
        const image = await pdfDoc.embedPng(png);
        page.drawImage(image, { x: 0, y: 0, width: w, height: h });

        if (withTextLayer) {
            // Same operator sequence as src/utils/pdf-textifier/searchable-pdf.ts.
            const fontName = page.node.newFontDictionary(fonts.jp.name, fonts.jp.ref);
            const operators = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
            for (const [field, text] of [[FIELDS.status, ORIGINAL_STATUS], [FIELDS.date, ORIGINAL_DATE]]) {
                const box = toUser(field, w, h);
                const size = box.height * 0.7;
                operators.push(
                    setFontAndSize(fontName, size),
                    setTextMatrix(1, 0, 0, 1, box.x + 4, box.y + box.height * 0.2),
                    showText(fonts.jp.encodeText(text)),
                );
            }
            operators.push(endText(), popGraphicsState());
            page.pushOperators(...operators);
        }
        await write(name, pdfDoc);
    }
}

console.log('done');
