/**
 * Synthetic documents for the M7-P2-A gates: title-block profiles, the
 * register extraction adapter, and the PDF.js data files.
 *
 * Nothing here is a customer or project drawing and nothing is downloaded:
 * every page is built through pdf-lib (or raw PDF objects), with text we
 * choose, in the OFL font already shipped for OCR. The answer key travels
 * beside the PDFs (truth.json), and the generator computes it itself -- the
 * field rectangles in upright page space, where they land on screen at each
 * rotation, the text in each cell, the sentinels outside them -- so the gates
 * compare the app against what was built, not against the app's own maths.
 *
 *   p2a-geometry   8 pages: /Rotate 0, 90, 180, 270, each without and with a
 *                  CropBox offset inside a larger MediaBox. A unique token in
 *                  each field cell, sentinels just outside the cells and
 *                  outside the CropBox.
 *   p2a-transfer   a reference page, and two larger pages carrying the same
 *                  block scaled with the paper (normalised) or kept at its
 *                  size against the bottom-right corner (corner-anchored).
 *   p2a-register   Japanese title blocks: native text (label above value), a
 *                  raster block (OCR), a raster block with a native drawing
 *                  number, a blank field, and the bounds -- a 1000-character
 *                  raw text and a 300-character value that fit, 1001 and 301
 *                  that do not.
 *   p2a-cmap       C1 a non-embedded Japanese CID font with a predefined CMap
 *                  (UniJIS-UCS2-H) and no ToUnicode; C2 an embedded font
 *                  marked Adobe-Japan1 with its ToUnicode removed; C3 the same
 *                  font with its ToUnicode (control); C4 standard fonts.
 *   p2a-jpx        the same raster title block as a JPX (JPEG 2000) image and,
 *                  as a control, as a PNG. The JPX is encoded losslessly by
 *                  scripts/m7-p2a-j2k-encoder.mjs.
 *
 * Run:  node scripts/make-m7-p2a-fixtures.mjs   (also run by make-m7-p1-fixtures.mjs)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import {
    PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb,
    beginText, concatTransformationMatrix, drawObject, endText, moveText, popGraphicsState, pushGraphicsState,
    setFontAndSize, showText,
} from 'pdf-lib';
import puppeteer from 'puppeteer';
import { encodeJ2k } from './m7-p2a-j2k-encoder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm7-p2a');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));

/** Never inside a field rectangle. The gates look for it everywhere it must not be. */
export const SENTINEL = 'XQSENTINEL';

const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
const LABELS = { drawingNumber: '図面番号', drawingTitle: '図面名称', revision: '版', issueDate: '日付' };
const CODES = { drawingNumber: 'DN', drawingTitle: 'TI', revision: 'RV', issueDate: 'DT' };

/** The visible box every page except the transfer ones has, in points. */
const PAGE = { w: 800, h: 580 };
/** The field cells, upright page space (origin top-left of the visible box, y down). */
const CELLS = {
    drawingNumber: { left: 560, top: 440, right: 780, bottom: 480 },
    drawingTitle: { left: 560, top: 480, right: 780, bottom: 520 },
    revision: { left: 560, top: 520, right: 660, bottom: 560 },
    issueDate: { left: 660, top: 520, right: 780, bottom: 560 },
};
/** The title block around them, for rasters. */
const BLOCK = { left: 550, top: 430, right: 790, bottom: 570 };
const RASTER_DPI = 200;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreator('PDF ArchiTools synthetic fixture');
    doc.setProducer('pdf-lib');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    doc.registerFontkit(fontkit);
    return doc;
}

const save = (doc) => doc.save({ useObjectStreams: false });

/**
 * A page whose visible box is `w` x `h`. With `offset`, the MediaBox is larger
 * and the CropBox sits inside it away from the origin.
 */
function addPage(doc, { w = PAGE.w, h = PAGE.h, offset = false, rotate = 0 } = {}) {
    const box = offset ? { x0: 40, y0: 60, x1: 40 + w, y1: 60 + h } : { x0: 0, y0: 0, x1: w, y1: h };
    const page = doc.addPage(offset ? [w + 100, h + 120] : [w, h]);
    if (offset) page.setCropBox(box.x0, box.y0, w, h);
    if (rotate) page.setRotation(degrees(rotate));
    return { page, box, w, h, rotate, offset };
}

/** Upright (left, baseline) -> user space, for the visible box. */
const userPoint = (p, u, v) => ({ x: p.box.x0 + u, y: p.box.y1 - v });

function drawCellBorders(p, cells) {
    for (const rect of Object.values(cells)) {
        const { x, y } = userPoint(p, rect.left, rect.bottom);
        p.page.drawRectangle({ x, y, width: rect.right - rect.left, height: rect.bottom - rect.top, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
    }
}

/** Text centred in a rectangle (upright), one run. */
function drawCentred(p, text, font, size, rect) {
    const width = font.widthOfTextAtSize(text, size);
    const u = (rect.left + rect.right) / 2 - width / 2;
    // A run spans its font size above the baseline; centre that span.
    const baseline = (rect.top + rect.bottom) / 2 + size / 2;
    const { x, y } = userPoint(p, u, baseline);
    p.page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
}

/** A label line at the top of a cell, the value near its bottom. */
function drawLabelled(p, font, field, value, rect) {
    const label = LABELS[field];
    const { x: lx, y: ly } = userPoint(p, rect.left + 4, rect.top + 10);
    p.page.drawText(label, { x: lx, y: ly, size: 7, font, color: rgb(0.25, 0.25, 0.25) });
    if (value !== '') {
        const { x, y } = userPoint(p, rect.left + 8, rect.bottom - 6);
        p.page.drawText(value, { x, y, size: 12, font, color: rgb(0, 0, 0) });
    }
}

/** Upright -> display space at scale 1, for a page of upright size W x H turned by `rotate` (clockwise). */
function toDisplay(u, v, rotate, W, H) {
    switch (rotate) {
        case 90: return { x: H - v, y: u };
        case 180: return { x: W - u, y: H - v };
        case 270: return { x: v, y: W - u };
        default: return { x: u, y: v };
    }
}

function displayRect(rect, rotate, W, H) {
    const a = toDisplay(rect.left, rect.top, rotate, W, H);
    const b = toDisplay(rect.right, rect.bottom, rotate, W, H);
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

const scaleRect = (r, s) => ({ left: r.left * s, top: r.top * s, right: r.right * s, bottom: r.bottom * s });
const shiftRect = (r, dx, dy) => ({ left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy });
const mapCells = (fn) => Object.fromEntries(FIELDS.map((f) => [f, fn(CELLS[f], f)]));

// ---------------------------------------------------------------------------
// Rasters, drawn by a browser in the OCR font
// ---------------------------------------------------------------------------

let browser = null;

/** The title block as a picture: PNG bytes, and the same pixels as 8-bit grey. */
async function rasterBlock(values, { omit = [] } = {}) {
    const s = RASTER_DPI / 72;
    const pxW = Math.round((BLOCK.right - BLOCK.left) * s);
    const pxH = Math.round((BLOCK.bottom - BLOCK.top) * s);
    let html = '';
    for (const field of FIELDS) {
        const r = CELLS[field];
        const box = { left: (r.left - BLOCK.left) * s, top: (r.top - BLOCK.top) * s, width: (r.right - r.left) * s, height: (r.bottom - r.top) * s };
        html += `<div style="position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;border:1px solid #000;box-sizing:border-box;padding:${3 * s}px ${4 * s}px">`
            + `<div style="font-size:${7 * s}px;line-height:1.1;color:#333">${LABELS[field]}</div>`
            + (omit.includes(field) ? '' : `<div style="font-size:${12 * s}px;line-height:1.2">${values[field]}</div>`)
            + '</div>';
    }
    const page = await browser.newPage();
    await page.setViewport({ width: pxW, height: pxH, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
      html, body { margin:0; padding:0; background:#fff; }
      body { position:relative; width:${pxW}px; height:${pxH}px; font-family:"M",sans-serif; color:#000; }
    </style></head><body>${html}</body></html>`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: pxW, height: pxH } });
    const grey = await page.evaluate(async (b64, w, h) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        let out = '';
        for (let i = 0; i < w * h; i++) {
            out += String.fromCharCode(Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]));
        }
        return btoa(out);
    }, Buffer.from(png).toString('base64'), pxW, pxH);
    await page.close();
    return { png, grey: Uint8Array.from(Buffer.from(grey, 'base64')), pxW, pxH };
}

/** Place an image XObject over the title block of a page. */
function placeOverBlock(p, name, ref) {
    const { x, y } = userPoint(p, BLOCK.left, BLOCK.bottom);
    p.page.node.setXObject(PDFName.of(name), ref);
    p.page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(BLOCK.right - BLOCK.left, 0, 0, BLOCK.bottom - BLOCK.top, x, y),
        drawObject(name),
        popGraphicsState(),
    );
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

async function geometry() {
    const doc = await newDoc('M7 P2-A fixture: geometry');
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const pages = [];
    let n = 0;
    for (const offset of [false, true]) {
        for (const rotate of [0, 90, 180, 270]) {
            n += 1;
            const p = addPage(doc, { offset, rotate });
            drawCellBorders(p, CELLS);
            const tokens = {};
            for (const field of FIELDS) {
                tokens[field] = `${CODES[field]}-P${n}-R${rotate}${offset ? '-OFF' : ''}`;
                drawCentred(p, tokens[field], helvetica, 12, CELLS[field]);
                // Just left of each cell, on its line.
                const r = CELLS[field];
                drawCentred(p, `${SENTINEL}-L-${CODES[field]}-P${n}`, helvetica, 8, { left: 400, right: 540, top: r.top, bottom: r.bottom });
            }
            // Just above the block, over the drawing-number column.
            drawCentred(p, `${SENTINEL}-ABOVE-P${n}`, helvetica, 8, { left: 560, right: 780, top: 426, bottom: 434 });
            if (offset) {
                // In the MediaBox, outside the CropBox: never visible, never a field.
                p.page.drawText(`${SENTINEL}-OUTSIDE-CROP-P${n}`, { x: 5, y: 5, size: 8, font: helvetica });
            }
            const quarter = rotate % 180 === 90;
            pages.push({
                page: n, rotate, offset,
                upright: { width: PAGE.w, height: PAGE.h },
                display: { width: quarter ? PAGE.h : PAGE.w, height: quarter ? PAGE.w : PAGE.h },
                cropBox: offset ? [40, 60, 40 + PAGE.w, 60 + PAGE.h] : [0, 0, PAGE.w, PAGE.h],
                uprightRects: CELLS,
                displayRects: mapCells((rect) => displayRect(rect, rotate, PAGE.w, PAGE.h)),
                tokens,
            });
        }
    }
    return { bytes: await save(doc), truth: { reference: { uprightWidthPt: PAGE.w, uprightHeightPt: PAGE.h }, pages } };
}

async function transfer() {
    const doc = await newDoc('M7 P2-A fixture: transfer');
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const big = { w: 1200, h: 870 };
    const layouts = [
        { label: 'REF', size: PAGE, cells: CELLS },
        { label: 'NORM', size: big, cells: mapCells((r) => scaleRect(r, 1.5)) },
        { label: 'CORN', size: big, cells: mapCells((r) => shiftRect(r, big.w - PAGE.w, big.h - PAGE.h)) },
    ];
    const pages = [];
    layouts.forEach((layout, i) => {
        const p = addPage(doc, { w: layout.size.w, h: layout.size.h });
        drawCellBorders(p, layout.cells);
        const tokens = {};
        for (const field of FIELDS) {
            tokens[field] = `${layout.label}-${CODES[field]}`;
            drawCentred(p, tokens[field], helvetica, 12, layout.cells[field]);
        }
        pages.push({ page: i + 1, model: layout.label, upright: { width: layout.size.w, height: layout.size.h }, cells: layout.cells, tokens });
    });
    return { bytes: await save(doc), truth: { reference: { uprightWidthPt: PAGE.w, uprightHeightPt: PAGE.h }, pages } };
}

/** Digits only: narrow, no spaces, nothing PDF.js would split or join. */
const digits = (length, seed) => Array.from({ length }, (_, i) => String((i * 7 + seed) % 10)).join('');

async function register() {
    const doc = await newDoc('M7 P2-A fixture: register');
    const mplus = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const pages = [];
    const sentinel = (p, n) => p.page.drawText(`${SENTINEL}-REG-P${n}`, { ...userPoint(p, 40, 40), size: 10, font: helvetica });

    // 1. Native, label above value.
    {
        const p = addPage(doc);
        const values = { drawingNumber: 'A-101', drawingTitle: '1階平面図', revision: 'B', issueDate: '2026.09.01' };
        drawCellBorders(p, CELLS);
        for (const f of FIELDS) drawLabelled(p, mplus, f, values[f], CELLS[f]);
        sentinel(p, 1);
        pages.push({ page: 1, kind: 'native', values, rawText: Object.fromEntries(FIELDS.map((f) => [f, `${LABELS[f]}\n${values[f]}`])), sources: mapCells(() => 'native') });
    }
    // 2. Raster block: every field by OCR.
    {
        const p = addPage(doc);
        const values = { drawingNumber: 'A-102', drawingTitle: '2階平面図', revision: 'C', issueDate: '2026.09.02' };
        const r = await rasterBlock(values);
        placeOverBlock(p, 'ImR2', (await doc.embedPng(r.png)).ref);
        sentinel(p, 2);
        pages.push({ page: 2, kind: 'raster', values, sources: mapCells(() => 'ocr') });
    }
    // 3. Raster block with the drawing number left as native text.
    {
        const p = addPage(doc);
        const values = { drawingNumber: 'A-103', drawingTitle: '3階平面図', revision: 'D', issueDate: '2026.09.03' };
        const r = await rasterBlock(values, { omit: ['drawingNumber'] });
        placeOverBlock(p, 'ImR3', (await doc.embedPng(r.png)).ref);
        const { x, y } = userPoint(p, CELLS.drawingNumber.left + 8, CELLS.drawingNumber.bottom - 6);
        p.page.drawText(values.drawingNumber, { x, y, size: 12, font: mplus });
        sentinel(p, 3);
        pages.push({ page: 3, kind: 'stamp', values, rawText: { drawingNumber: 'A-103' }, sources: { drawingNumber: 'native', drawingTitle: 'ocr', revision: 'ocr', issueDate: 'ocr' } });
    }
    // 4. Native, with an empty revision cell: nothing there to read, so it goes to OCR and OCR finds nothing.
    {
        const p = addPage(doc);
        const values = { drawingNumber: 'A-104', drawingTitle: '屋上平面図', revision: '', issueDate: '2026.09.04' };
        drawCellBorders(p, CELLS);
        for (const f of FIELDS) {
            if (f === 'revision') continue;
            drawLabelled(p, mplus, f, values[f], CELLS[f]);
        }
        sentinel(p, 4);
        pages.push({ page: 4, kind: 'blank-field', values, sources: { drawingNumber: 'native', drawingTitle: 'native', revision: 'ocr', issueDate: 'native' } });
    }
    // 5-7. The bounds. Lines of digits, 3 pt apart so they never share a line.
    const bounds = async (n, numberLength, titleLines) => {
        const p = addPage(doc);
        drawCellBorders(p, CELLS);
        const number = digits(numberLength, n);
        drawCentred(p, number, helvetica, 1.2, CELLS.drawingNumber);
        const lines = titleLines.map((length, i) => digits(length, n + i));
        lines.forEach((line, i) => {
            const { x, y } = userPoint(p, CELLS.drawingTitle.left + 6, CELLS.drawingTitle.top + 8 + i * 3);
            p.page.drawText(line, { x, y, size: 1.5, font: helvetica });
        });
        drawCentred(p, 'E', helvetica, 12, CELLS.revision);
        drawCentred(p, `2026.09.0${n}`, helvetica, 12, CELLS.issueDate);
        sentinel(p, n);
        const rawTitle = lines.join('\n');
        return {
            page: n,
            kind: 'bounds',
            values: { drawingNumber: number, drawingTitle: lines[lines.length - 1], revision: 'E', issueDate: `2026.09.0${n}` },
            rawText: { drawingNumber: number, drawingTitle: rawTitle },
            lengths: { numberValue: [...number].length, titleRaw: [...rawTitle].length },
        };
    };
    pages.push(await bounds(5, 300, [142, 142, 142, 142, 142, 142, 142]));
    pages.push(await bounds(6, 12, [142, 142, 142, 142, 142, 142, 143]));
    pages.push(await bounds(7, 301, [20]));
    return { bytes: await save(doc), truth: { reference: { uprightWidthPt: PAGE.w, uprightHeightPt: PAGE.h }, cells: CELLS, pages } };
}

/** UCS-2 big-endian hex, which is what UniJIS-UCS2-H codes are. */
const ucs2Hex = (text) => [...text].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();

async function cmap() {
    const doc = await newDoc('M7 P2-A fixture: CMap');
    const pages = [];
    const ctx = doc.context;

    // C1: a non-embedded Adobe-Japan1 CID font, predefined UniJIS-UCS2-H, no ToUnicode.
    {
        const p = addPage(doc);
        drawCellBorders(p, CELLS);
        const descriptor = ctx.register(ctx.obj({
            Type: 'FontDescriptor', FontName: 'HeiseiKakuGo-W5', Flags: 4,
            FontBBox: [-92, -250, 1010, 922], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 737, StemV: 114,
        }));
        const cidFont = ctx.register(ctx.obj({
            Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'HeiseiKakuGo-W5',
            CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 5 },
            FontDescriptor: descriptor, DW: 1000,
        }));
        const type0 = ctx.register(ctx.obj({
            Type: 'Font', Subtype: 'Type0', BaseFont: 'HeiseiKakuGo-W5', Encoding: 'UniJIS-UCS2-H', DescendantFonts: [cidFont],
        }));
        p.page.node.setFontDictionary(PDFName.of('FJ1'), type0);
        const values = { drawingNumber: 'C1-101', drawingTitle: '設計図面一覧', revision: '改1', issueDate: '2026.10.01' };
        for (const f of FIELDS) {
            const r = CELLS[f];
            const size = 12;
            const width = [...values[f]].length * size;
            const { x, y } = userPoint(p, (r.left + r.right) / 2 - width / 2, (r.top + r.bottom) / 2 + size / 2);
            p.page.pushOperators(beginText(), setFontAndSize('FJ1', size), moveText(x, y), showText(PDFHexString.of(ucs2Hex(values[f]))), endText());
        }
        pages.push({ page: 1, case: 'C1', values, note: 'non-embedded CID font, UniJIS-UCS2-H, no ToUnicode' });
    }
    // C2 and C3: the same embedded font; C2's ToUnicode is removed afterwards and it is marked Japan1.
    // Whole fonts: pdf-lib's subsetting drops outlines of some CJK glyphs, which would blur the render comparison.
    const c2Font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    const c3Font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    for (const [n, font, values, note] of [
        [2, c2Font, { drawingNumber: 'C2-102', drawingTitle: '構造図', revision: 'B', issueDate: '2026.10.02' }, 'embedded, Adobe-Japan1, ToUnicode removed'],
        [3, c3Font, { drawingNumber: 'C3-103', drawingTitle: '設備図', revision: 'C', issueDate: '2026.10.03' }, 'embedded, with ToUnicode (control)'],
    ]) {
        const p = addPage(doc);
        drawCellBorders(p, CELLS);
        for (const f of FIELDS) drawCentred(p, values[f], font, 12, CELLS[f]);
        pages.push({ page: n, case: `C${n}`, values, note });
    }
    // C4: standard fonts, not embedded.
    {
        const p = addPage(doc);
        const helvetica = await doc.embedFont(StandardFonts.Helvetica);
        const symbol = await doc.embedFont(StandardFonts.Symbol);
        drawCellBorders(p, CELLS);
        const values = { drawingNumber: 'C4-104', drawingTitle: 'STANDARD FONT', revision: 'D', issueDate: '2026.10.04' };
        for (const f of FIELDS) drawCentred(p, values[f], helvetica, 12, CELLS[f]);
        p.page.drawText('αβγδ', { ...userPoint(p, 60, 100), size: 18, font: symbol });
        pages.push({ page: 4, case: 'C4', values, note: 'standard 14 fonts, not embedded' });
    }

    // Take C2's ToUnicode away and say its glyphs are Adobe-Japan1 CIDs.
    const saved = await save(doc);
    const loaded = await PDFDocument.load(saved, { updateMetadata: false });
    const fonts = loaded.getPage(1).node.Resources().lookup(PDFName.of('Font'), PDFDict);
    let changed = 0;
    // pdf-lib names the font afresh for every run drawn; the object is one.
    const refs = new Map(fonts.entries().map(([, ref]) => [ref.toString(), ref]));
    for (const ref of refs.values()) {
        const dict = loaded.context.lookup(ref, PDFDict);
        if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Type0') continue;
        dict.delete(PDFName.of('ToUnicode'));
        const descendant = dict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
        descendant.set(PDFName.of('CIDSystemInfo'), loaded.context.obj({
            Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: PDFNumber.of(6),
        }));
        changed += 1;
    }
    if (changed !== 1) throw new Error(`expected one Type0 font on page C2, found ${changed}`);
    return { bytes: await save(loaded), truth: { reference: { uprightWidthPt: PAGE.w, uprightHeightPt: PAGE.h }, cells: CELLS, pages } };
}

async function jpx() {
    const doc = await newDoc('M7 P2-A fixture: JPX');
    const values = { drawingNumber: 'J5-105', drawingTitle: '配置図', revision: 'E', issueDate: '2026.10.05' };
    const r = await rasterBlock(values);
    const j2k = encodeJ2k(r.grey, r.pxW, r.pxH);
    {
        const p = addPage(doc);
        const image = doc.context.register(doc.context.stream(j2k, {
            Type: 'XObject', Subtype: 'Image', Width: r.pxW, Height: r.pxH,
            ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'JPXDecode',
        }));
        placeOverBlock(p, 'ImJ', image);
    }
    {
        const p = addPage(doc);
        placeOverBlock(p, 'ImP', (await doc.embedPng(r.png)).ref);
    }
    return {
        bytes: await save(doc),
        j2k,
        truth: {
            reference: { uprightWidthPt: PAGE.w, uprightHeightPt: PAGE.h },
            cells: CELLS,
            block: BLOCK,
            image: { width: r.pxW, height: r.pxH, j2kBytes: j2k.length, j2kSha256: sha256(j2k) },
            pages: [{ page: 1, case: 'JPX', values }, { page: 2, case: 'PNG control', values }],
        },
    };
}

export async function generateP2aFixtures() {
    if (!fs.existsSync(FONT)) throw new Error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    fs.mkdirSync(OUT, { recursive: true });
    for (const file of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, file));
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const files = [];
    try {
        for (const [name, build] of [['p2a-geometry', geometry], ['p2a-transfer', transfer], ['p2a-register', register], ['p2a-cmap', cmap], ['p2a-jpx', jpx]]) {
            const built = await build();
            fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(built.bytes));
            if (built.j2k) fs.writeFileSync(path.join(OUT, `${name}.j2k`), Buffer.from(built.j2k));
            files.push({ name, file: `${name}.pdf`, bytes: built.bytes.length, sha256: sha256(built.bytes), truth: built.truth });
        }
    } finally {
        await browser.close();
        browser = null;
    }
    const manifest = {
        generatedBy: 'scripts/make-m7-p2a-fixtures.mjs',
        note: 'Synthetic only. No customer or project document, no network, no secret. SHA-256 from node:crypto.',
        sentinel: SENTINEL,
        files,
    };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`m7-p2a fixtures: ${files.length} documents in ${path.relative(ROOT, OUT)}`);
    for (const f of files) console.log(`  ${f.name.padEnd(14)} ${String(f.bytes).padStart(9)} B  ${f.sha256.slice(0, 12)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    generateP2aFixtures().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
