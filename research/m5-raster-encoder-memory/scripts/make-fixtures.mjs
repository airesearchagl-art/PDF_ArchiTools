/**
 * The quality corpus for the Raster Encoder / Memory Sub-Spike.
 *
 * An encoder choice is a memory decision, but it is also a visual one: a
 * bounded encoder that ruins thin linework has not solved anything. These are
 * the contents the flattening operations have to survive, generated here, none
 * of them a customer document, none committed (`test-fixtures/` is ignored).
 *
 * Run:  node research/m5-raster-encoder-memory/scripts/make-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm5-encoder');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

export const SHEET = {
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
};

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const written = [];

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    doc.setProducer('M5 encoder sub-spike fixture');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, font };
}

async function write(name, doc, note) {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
    return bytes;
}

// --- PNG helpers ------------------------------------------------------------

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
/** An 8-bit truecolour PNG from raw rows (each already carrying its filter byte). */
function pngOf(width, height, raw) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}
/** xorshift32: full-period high bits, unlike an LCG's. */
function noise(seed = 0x9E3779B9) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return (s >>> 24) & 0xFF;
    };
}

function rasterOf(width, height, paint) {
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y += 1) {
        const row = y * (1 + width * 3);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = paint(x, y);
            const i = row + 1 + x * 3;
            raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
        }
    }
    return pngOf(width, height, raw);
}

// --- contents ---------------------------------------------------------------

/** A drawing: border, grid, a heavy wall line, and a corner mark for orientation. */
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
        start: { x: w * 0.15, y: h * 0.35 }, end: { x: w * 0.85, y: h * 0.35 }, thickness: lw * 4, color: red,
    });
    page.drawRectangle({ x: w * 0.07, y: h * 0.85, width: w * 0.12, height: h * 0.02, color: rgb(0, 0.5, 0) });
}

/** Hatching at drawing density: many hairlines, the thing a lossy encoder smears. */
function drawHatching(page, size) {
    const { w, h } = size;
    const step = w * 0.004;
    for (let x = w * 0.1; x < w * 0.9; x += step) {
        page.drawLine({
            start: { x, y: h * 0.15 }, end: { x: x + h * 0.25, y: h * 0.4 },
            thickness: 0.24, color: rgb(0, 0, 0),
        });
    }
    for (let y = h * 0.5; y < h * 0.85; y += step) {
        page.drawLine({
            start: { x: w * 0.1, y }, end: { x: w * 0.9, y }, thickness: 0.24, color: rgb(0.1, 0.1, 0.1),
        });
    }
}

/** Dimension strings: small text next to thin witness lines, as a drawing carries. */
function drawDimensions(page, font, size) {
    const { w, h } = size;
    for (let i = 0; i < 6; i += 1) {
        const y = h * (0.2 + i * 0.11);
        page.drawLine({ start: { x: w * 0.12, y }, end: { x: w * 0.88, y }, thickness: 0.24, color: rgb(0, 0, 0) });
        page.drawLine({ start: { x: w * 0.12, y: y - 4 }, end: { x: w * 0.12, y: y + 4 }, thickness: 0.24, color: rgb(0, 0, 0) });
        page.drawLine({ start: { x: w * 0.88, y: y - 4 }, end: { x: w * 0.88, y: y + 4 }, thickness: 0.24, color: rgb(0, 0, 0) });
        page.drawText(`${1200 + i * 75} DIM-M5E-${i}`, {
            x: w * 0.38, y: y + 2, size: 5.5, font, color: rgb(0, 0, 0),
        });
    }
}

{
    const { doc } = await newDoc('E vector');
    drawVector(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4);
    await write('vector-a4', doc, 'pure coloured vector drawing');
}
{
    const { doc, font } = await newDoc('E text');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    page.drawText('NATIVE-TEXT-M5E 1200', { x: SHEET.A4.w * 0.12, y: SHEET.A4.h * 0.12, size: 14, font });
    await write('text-a4', doc, 'vector drawing with native searchable text');
}
{
    const { doc, font } = await newDoc('E drawing');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4, { colour: false });
    drawDimensions(page, font, SHEET.A4);
    await write('drawing-a4', doc, 'architectural drawing: thin witness lines and small dimension strings');
}
{
    const { doc } = await newDoc('E hatching');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawHatching(page, SHEET.A4);
    await write('hatch-a4', doc, 'dense hatching at hairline width');
}
{
    // One-pixel linework on paper grain, at 300 dpi: the hardest case for any
    // resampling or lossy step.
    const { doc } = await newDoc('E fine lines');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const w = Math.round(SHEET.A4.w * 300 / 72);
    const h = Math.round(SHEET.A4.h * 300 / 72);
    const grain = noise(12345);
    const png = await doc.embedPng(rasterOf(w, h, (x, y) => {
        const line = (x % 37 === 0) || (y % 53 === 0) || (Math.abs(x - y) % 211 === 0);
        if (line) return [25, 25, 25];
        const v = 236 + (grain() % 12);
        return [v, v, v];
    }));
    page.drawImage(png, { x: 0, y: 0, width: SHEET.A4.w, height: SHEET.A4.h });
    await write('fine-line-a4', doc, '300 dpi one-pixel linework on paper grain');
}
{
    const { doc } = await newDoc('E grey scan');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const grain = noise(777);
    const png = await doc.embedPng(rasterOf(1240, 1754, (x, y) => {
        const stroke = (y % 60 < 3) || (x % 90 < 3);
        const v = stroke ? 45 + (grain() % 20) : 228 + (grain() % 18);
        return [v, v, v];
    }));
    page.drawImage(png, { x: 0, y: 0, width: SHEET.A4.w, height: SHEET.A4.h });
    await write('grey-scan-a4', doc, 'a greyscale scan: strokes on grained paper');
}
{
    const { doc } = await newDoc('E colour scan');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const palette = [[220, 30, 30], [30, 80, 220], [20, 160, 60], [240, 200, 20]];
    const grain = noise(31337);
    const png = await doc.embedPng(rasterOf(1240, 1754, (x, y) => {
        const [r, g, b] = palette[(Math.floor(x / 310) + Math.floor(y / 585)) % 4];
        const n = (grain() % 10) - 5;
        return [Math.max(0, r + n), Math.max(0, g + n), Math.max(0, b + n)];
    }));
    page.drawImage(png, { x: 0, y: 0, width: SHEET.A4.w, height: SHEET.A4.h });
    await write('colour-scan-a4', doc, 'a colour scan: saturated blocks with grain');
}
{
    const { doc } = await newDoc('E photo');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const grain = noise(999983);
    const png = await doc.embedPng(rasterOf(1240, 1754, (x, y) => {
        const r = Math.round(120 + 100 * Math.sin(x / 190) + (grain() % 8));
        const g = Math.round(110 + 90 * Math.sin((x + y) / 240) + (grain() % 8));
        const b = Math.round(130 + 95 * Math.cos(y / 210) + (grain() % 8));
        const clamp = (v) => (v < 0 ? 0 : (v > 255 ? 255 : v));
        return [clamp(r), clamp(g), clamp(b)];
    }));
    page.drawImage(png, { x: 0, y: 0, width: SHEET.A4.w, height: SHEET.A4.h });
    await write('photo-a4', doc, 'photographic content: smooth gradients plus grain');
}
{
    const { doc, font } = await newDoc('E four pages');
    for (let i = 1; i <= 4; i += 1) {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawVector(page, SHEET.A4, { colour: i % 2 === 0 });
        page.drawText(`PAGE-ORDER-M5E-${i}`, { x: 60, y: 80, size: 18, font });
    }
    await write('four-pages', doc, 'four vector pages, for multi-page retention');
}
{
    const { doc } = await newDoc('E A3');
    drawVector(doc.addPage([SHEET.A3.w, SHEET.A3.h]), SHEET.A3);
    await write('vector-a3', doc, 'A3 vector drawing');
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify(written, null, 2)}\n`);
console.log(`${written.length} fixtures -> ${OUT}`);
for (const f of written) console.log(`  ${f.name.padEnd(16)} ${String(f.bytes).padStart(8)} B  ${f.note}`);
