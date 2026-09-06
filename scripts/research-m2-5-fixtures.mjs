/**
 * A synthetic drawing set for the M2-5 drawing-register spike.
 *
 * Twenty pages meant to look like a real issue: two title-block layouts, four
 * sheet sizes, native and scanned pages, all four /Rotate values, Japanese and
 * English titles, a duplicate drawing number, a deliberate gap in a numbering
 * run, a page whose numbering scheme defeats gap inference, a blank field, a
 * page that is a raster drawing with only a vector stamp, a page carrying an
 * invisible OCR text layer, and a page whose values are the ones a spreadsheet
 * treats as formulas.
 *
 * Everything is drawn from text we control with the OFL font already shipped
 * for OCR. No customer document and no real project drawing is used anywhere,
 * and nothing generated here is committed -- test-fixtures/ is ignored.
 *
 * The answer key travels beside the PDF as drawing-set.truth.json and records,
 * per page: the field values, the sheet size, the rotation, the layout profile
 * and the field rectangles in **upright page space** (origin top-left, y down,
 * PDF points). Template transfer is measured against those rectangles, so the
 * question "does one template work on another page" has an answer rather than
 * an opinion.
 *
 * Run:  node scripts/research-m2-5-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-5');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');
const EPOCH = new Date(0);

/** Sheet sizes in points. A1 and A0 are here to test ROI rendering, not layout. */
const SIZES = {
    A3: { w: 841.89, h: 1190.55 },
    A2: { w: 1190.55, h: 1683.78 },
    A1: { w: 1683.78, h: 2383.94 },
    A0: { w: 2383.94, h: 3370.39 },
};

if (!fs.existsSync(FONT)) {
    console.error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.pdf') || file.endsWith('.json')) fs.unlinkSync(path.join(OUT, file));
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

/**
 * The four fields, as a fraction of the sheet.
 *
 * Kept as fractions rather than points because that is one of the coordinate
 * models under test: a fraction that holds across sheet sizes is the cheapest
 * template transfer there is, and whether it actually holds is measured.
 *
 * Layout A puts the title block in the bottom-right corner. Layout B runs it
 * up the right-hand edge, which is the other common arrangement -- and is the
 * case a single global template must not be applied to silently.
 */
const LAYOUTS = {
    A: {
        name: 'A: title block, bottom right',
        block: { left: 0.62, top: 0.86, right: 0.97, bottom: 0.97 },
        fields: {
            drawing_number: { left: 0.62, top: 0.86, right: 0.78, bottom: 0.895 },
            drawing_title: { left: 0.62, top: 0.895, right: 0.97, bottom: 0.935 },
            revision: { left: 0.62, top: 0.935, right: 0.72, bottom: 0.97 },
            revision_date: { left: 0.78, top: 0.935, right: 0.97, bottom: 0.97 },
        },
    },
    B: {
        name: 'B: title strip, right edge',
        block: { left: 0.84, top: 0.30, right: 0.98, bottom: 0.62 },
        fields: {
            drawing_number: { left: 0.84, top: 0.30, right: 0.98, bottom: 0.37 },
            drawing_title: { left: 0.84, top: 0.37, right: 0.98, bottom: 0.48 },
            revision: { left: 0.84, top: 0.48, right: 0.98, bottom: 0.55 },
            revision_date: { left: 0.84, top: 0.55, right: 0.98, bottom: 0.62 },
        },
    },
};

/**
 * A title block that keeps its physical size on a bigger sheet.
 *
 * The fractional layouts above scale the block with the paper, which is the
 * easy case and not the usual one: a real title block is a fixed physical size
 * pinned to a corner, so on an A0 it occupies a far smaller fraction of the
 * sheet than on an A3. Without a fixture like this, a coordinate model that
 * only works for proportional blocks would look like the right answer.
 */
function fixedSizeLayout(layoutKey, size) {
    const base = SIZES.A3;
    const spec = LAYOUTS[layoutKey];
    const shift = (frac) => {
        const w = (frac.right - frac.left) * base.w;
        const h = (frac.bottom - frac.top) * base.h;
        const fromRight = (1 - frac.right) * base.w;
        const fromBottom = (1 - frac.bottom) * base.h;
        const left = size.w - fromRight - w;
        const top = size.h - fromBottom - h;
        return { left: left / size.w, top: top / size.h, right: (left + w) / size.w, bottom: (top + h) / size.h };
    };
    return {
        name: `${spec.name} (fixed physical size)`,
        block: shift(spec.block),
        fields: Object.fromEntries(Object.entries(spec.fields).map(([k, f]) => [k, shift(f)])),
    };
}

const toPoints = (frac, size) => ({
    left: frac.left * size.w,
    top: frac.top * size.h,
    right: frac.right * size.w,
    bottom: frac.bottom * size.h,
});

/** Draw the sheet border and some drawing-looking content, so a page is not blank. */
function drawSheet(page, font, size) {
    const m = 0.02;
    const x0 = size.w * m;
    const y0 = size.h * m;
    const w = size.w * (1 - 2 * m);
    const h = size.h * (1 - 2 * m);
    const line = (x, y, width, height) =>
        page.drawRectangle({ x, y, width, height, color: rgb(0, 0, 0) });
    line(x0, y0, w, 1.4);
    line(x0, y0 + h, w, 1.4);
    line(x0, y0, 1.4, h);
    line(x0 + w, y0, 1.4, h);

    // A grid of thin lines, so the page carries the sort of vector content a
    // drawing does and the register work is not measured on an empty sheet.
    const cols = 6;
    const rows = 8;
    for (let i = 1; i < cols; i++) line(x0 + (w / cols) * i, y0 + h * 0.15, 0.4, h * 0.65);
    for (let j = 1; j < rows; j++) line(x0 + w * 0.05, y0 + h * 0.15 + (h * 0.65 / rows) * j, w * 0.5, 0.4);
    page.drawText('PLAN', {
        x: x0 + w * 0.08, y: y0 + h * 0.82, size: size.w / 40, font, color: rgb(0.35, 0.35, 0.35),
    });
}

/**
 * Draw a title block, and report where each field's text actually sits.
 *
 * The rectangles returned are the *field regions* a user would draw, in upright
 * page space. The label and the value are drawn inside the same region on
 * purpose: a field region on a real sheet contains both, and an extraction that
 * cannot tell them apart is a finding, not a fixture bug.
 */
function drawTitleBlock(page, font, size, layout, values, { withLabels = true, spec = LAYOUTS[layout] } = {}) {
    const block = toPoints(spec.block, size);
    const scale = size.w / SIZES.A3.w;
    const fontSize = 11 * scale;
    const labelSize = 7 * scale;

    const rect = (r, thickness = 0.9) => {
        page.drawRectangle({ x: r.left, y: size.h - r.bottom, width: r.right - r.left, height: thickness, color: rgb(0, 0, 0) });
        page.drawRectangle({ x: r.left, y: size.h - r.top, width: r.right - r.left, height: thickness, color: rgb(0, 0, 0) });
        page.drawRectangle({ x: r.left, y: size.h - r.bottom, width: thickness, height: r.bottom - r.top, color: rgb(0, 0, 0) });
        page.drawRectangle({ x: r.right, y: size.h - r.bottom, width: thickness, height: r.bottom - r.top, color: rgb(0, 0, 0) });
    };
    rect(block, 1.2);

    const LABELS = {
        drawing_number: '図面番号',
        drawing_title: '図面名称',
        revision: 'REV',
        revision_date: '日付',
    };

    const fields = {};
    for (const [key, frac] of Object.entries(spec.fields)) {
        const r = toPoints(frac, size);
        rect(r);
        fields[key] = r;
        const value = values[key] ?? '';
        let y = r.top + labelSize + 3 * scale;
        if (withLabels) {
            page.drawText(LABELS[key], {
                x: r.left + 4 * scale, y: size.h - y, size: labelSize, font, color: rgb(0.3, 0.3, 0.3),
            });
            y += fontSize + 2 * scale;
        } else {
            y = r.top + fontSize + 4 * scale;
        }
        for (const lineText of String(value).split('\n')) {
            if (lineText === '') continue;
            page.drawText(lineText, {
                x: r.left + 4 * scale, y: size.h - y, size: fontSize, font, color: rgb(0, 0, 0),
            });
            y += fontSize * 1.25;
        }
    }
    return { block, fields };
}

/** Render one page's worth of HTML to a PNG, for the scanned pages. */
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

/** The same title block, as a picture, positioned by the same fractions. */
function scannedSheetHtml(size, layout, values, pxW, pxH, { fontScale = 1, spec = LAYOUTS[layout] } = {}) {
    const px = (frac) => ({
        left: frac.left * pxW, top: frac.top * pxH,
        width: (frac.right - frac.left) * pxW, height: (frac.bottom - frac.top) * pxH,
    });
    const base = Math.max(11, (pxW / 841.89) * 11) * fontScale;
    const label = base * 0.62;
    const LABELS = {
        drawing_number: '図面番号', drawing_title: '図面名称', revision: 'REV', revision_date: '日付',
    };
    const blockBox = px(spec.block);
    let html = `<div style="position:absolute;left:${blockBox.left}px;top:${blockBox.top}px;width:${blockBox.width}px;height:${blockBox.height}px;border:2px solid #000"></div>`;
    for (const [key, frac] of Object.entries(spec.fields)) {
        const b = px(frac);
        html += `<div style="position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;border:1px solid #000;box-sizing:border-box;padding:${base * 0.25}px">`
            + `<div style="font-size:${label}px;color:#444">${LABELS[key]}</div>`
            + `<div style="font-size:${base}px;white-space:pre-line">${String(values[key] ?? '')}</div>`
            + '</div>';
    }
    // A little drawing content, so the sheet is not an empty box.
    html += `<div style="position:absolute;left:${pxW * 0.06}px;top:${pxH * 0.1}px;width:${pxW * 0.55}px;height:${pxH * 0.6}px;border:2px solid #000"></div>`;
    html += `<div style="position:absolute;left:${pxW * 0.09}px;top:${pxH * 0.14}px;font-size:${base * 1.6}px">PLAN</div>`;
    return `<div style="position:relative;width:${pxW}px;height:${pxH}px">${html}</div>`;
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/**
 * `kind` says how the page is made, not what it means:
 *   native   text drawn into the page content
 *   scanned  a raster image, no text at all
 *   stamp    a raster drawing with only the drawing number as vector text
 *   ocrlayer a raster drawing with an invisible text layer over it
 */
const PAGES = [
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-101', drawing_title: '1階平面図', revision: 'A', revision_date: '2026.09.01' } },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-102', drawing_title: '2階平面図', revision: 'A', revision_date: '2026.09.01' } },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-104', drawing_title: '4階平面図', revision: 'B', revision_date: '2026.09.05' }, note: 'A-103 is deliberately absent' },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-105', drawing_title: 'GROUND FLOOR PLAN', revision: 'A', revision_date: '2026-09-01' }, note: 'English title, ISO-style date' },
    { kind: 'native', size: 'A2', layout: 'A', rotate: 0, values: { drawing_number: 'S-201', drawing_title: '基礎伏図', revision: '03', revision_date: '2026.09.02' } },
    { kind: 'native', size: 'A2', layout: 'A', rotate: 0, values: { drawing_number: 'S-202', drawing_title: '2階伏図', revision: '', revision_date: '2026.09.02' }, note: 'revision deliberately blank' },
    { kind: 'native', size: 'A2', layout: 'B', rotate: 0, values: { drawing_number: 'ME-003', drawing_title: '設備配管図', revision: 'A', revision_date: '2026.09.03' }, note: 'second title-block layout' },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-101', drawing_title: '1階平面図（差替）', revision: 'C', revision_date: '2026.09.10' }, note: 'duplicate drawing number of page 1' },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-106', drawing_title: '屋根伏図', revision: 'A', revision_date: '2026.09.04' } },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-107', drawing_title: 'DETAIL PLAN', revision: 'B', revision_date: '2026.09.04' } },
    { kind: 'scanned', size: 'A2', layout: 'B', rotate: 0, values: { drawing_number: 'S-203', drawing_title: '軸組図', revision: '02', revision_date: '2026.09.06' } },
    { kind: 'stamp', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-108', drawing_title: '立面図', revision: 'A', revision_date: '2026.09.05' }, note: 'raster sheet, drawing number only as vector text' },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 90, values: { drawing_number: 'A-110', drawing_title: '南立面図', revision: 'A', revision_date: '2026.09.07' } },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 180, values: { drawing_number: 'A-111', drawing_title: '断面図', revision: 'A', revision_date: '2026.09.07' } },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 270, values: { drawing_number: 'A-112', drawing_title: '矩計図', revision: 'A', revision_date: '2026.09.07' } },
    { kind: 'scanned', size: 'A1', layout: 'A', rotate: 0, values: { drawing_number: 'A-120', drawing_title: '全体配置図', revision: 'A', revision_date: '2026.09.08' }, note: 'large sheet, for ROI rendering' },
    { kind: 'scanned', size: 'A0', layout: 'A', rotate: 0, values: { drawing_number: 'A-121', drawing_title: '全体詳細図', revision: 'A', revision_date: '2026.09.08' }, note: 'largest sheet, for ROI rendering' },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: '=1+1', drawing_title: '@ABC 仮設計画', revision: '+3', revision_date: '-1' }, note: 'values a spreadsheet would read as formulas' },
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'DETAIL-A', drawing_title: '納まり詳細', revision: 'A', revision_date: '2026.09.09' }, note: 'numbering scheme that must disable gap inference' },
    { kind: 'ocrlayer', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-130', drawing_title: '仕上詳細図', revision: 'A', revision_date: '2026.09.09' }, note: 'raster sheet with an invisible text layer, as our own searchable PDF produces' },
    { kind: 'native', size: 'A2', layout: 'A', rotate: 0, fixedBlock: true, values: { drawing_number: 'A-140', drawing_title: '外構平面図', revision: 'A', revision_date: '2026.09.11' }, note: 'A2 with a title block of the same physical size as the A3 pages' },
    { kind: 'native', size: 'A1', layout: 'A', rotate: 0, fixedBlock: true, values: { drawing_number: 'A-141', drawing_title: '外構詳細図', revision: 'A', revision_date: '2026.09.11' }, note: 'A1 with a title block of the same physical size as the A3 pages' },

    // Scanned sheets that are also rotated. The rotated pages above all carry
    // native text, so until these existed the region-render-and-OCR path had
    // only ever run at /Rotate 0 -- a wrong rotation map would have been
    // invisible in every OCR measurement.
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 90, values: { drawing_number: 'A-150', drawing_title: '基礎詳細図', revision: 'A', revision_date: '2026.09.12' }, note: 'scanned and rotated: region OCR at /Rotate 90' },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 180, values: { drawing_number: 'A-151', drawing_title: '柱列表', revision: 'B', revision_date: '2026.09.12' }, note: 'scanned and rotated: region OCR at /Rotate 180' },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 270, values: { drawing_number: 'A-152', drawing_title: '壁量計算図', revision: 'A', revision_date: '2026.09.12' }, note: 'scanned and rotated: region OCR at /Rotate 270' },
];

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('M2-5 research drawing set');
doc.setAuthor('research');
doc.setSubject('synthetic');
doc.setProducer('research-m2-5-fixtures');
doc.setCreator('research-m2-5-fixtures');
doc.setCreationDate(EPOCH);
doc.setModificationDate(EPOCH);
const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });

const truthPages = [];

for (const [index, spec] of PAGES.entries()) {
    const size = SIZES[spec.size];
    const pageNumber = index + 1;
    const page = doc.addPage([size.w, size.h]);
    let regions;

    const layoutSpec = spec.fixedBlock ? fixedSizeLayout(spec.layout, size) : LAYOUTS[spec.layout];

    if (spec.kind === 'native') {
        drawSheet(page, font, size);
        regions = drawTitleBlock(page, font, size, spec.layout, spec.values, { spec: layoutSpec });
    } else {
        // Rasterised at 150 DPI-equivalent, capped so an A0 sheet does not
        // become an unreasonable PNG. The cap is recorded in the answer key.
        const pxW = Math.min(2000, Math.round(size.w * 2));
        const pxH = Math.round(pxW * (size.h / size.w));
        const png = await raster(scannedSheetHtml(size, spec.layout, spec.values, pxW, pxH, { spec: layoutSpec }), pxW, pxH);
        const image = await doc.embedPng(png);
        page.drawImage(image, { x: 0, y: 0, width: size.w, height: size.h });
        regions = {
            block: toPoints(layoutSpec.block, size),
            fields: Object.fromEntries(Object.entries(layoutSpec.fields)
                .map(([k, f]) => [k, toPoints(f, size)])),
            rasterPixels: { width: pxW, height: pxH },
        };

        if (spec.kind === 'stamp') {
            // Only the drawing number, as real vector text, over the raster.
            const r = regions.fields.drawing_number;
            page.drawText(spec.values.drawing_number, {
                x: r.left + 6, y: size.h - (r.top + 26), size: 12, font, color: rgb(0, 0, 0),
            });
        }
        if (spec.kind === 'ocrlayer') {
            // An invisible text layer over the whole title block, the way a
            // searchable PDF carries one. Drawn white-on-white rather than with
            // a render mode, which is enough for "is there text here" and is
            // recorded as such in the answer key.
            for (const [key, r] of Object.entries(regions.fields)) {
                page.drawText(String(spec.values[key] ?? ''), {
                    x: r.left + 6, y: size.h - (r.top + 26), size: 12, font,
                    color: rgb(1, 1, 1), opacity: 0.01,
                });
            }
        }
    }

    if (spec.rotate) page.setRotation(degrees(spec.rotate));

    truthPages.push({
        page: pageNumber,
        kind: spec.kind,
        size: spec.size,
        sizePoints: { width: size.w, height: size.h },
        layout: spec.layout,
        blockScaling: spec.fixedBlock ? 'fixed-physical-size' : 'proportional',
        rotate: spec.rotate,
        values: spec.values,
        // Upright page space: origin top-left, y downwards, PDF points.
        regions: regions.fields,
        block: regions.block,
        rasterPixels: regions.rasterPixels ?? null,
        note: spec.note ?? null,
    });
}

await browser.close();

const bytes = await doc.save();
fs.writeFileSync(path.join(OUT, 'drawing-set.pdf'), bytes);
fs.writeFileSync(path.join(OUT, 'drawing-set.truth.json'), `${JSON.stringify({
    pages: truthPages,
    layouts: Object.fromEntries(Object.entries(LAYOUTS).map(([k, v]) => [k, { name: v.name, block: v.block, fields: v.fields }])),
    sizes: SIZES,
}, null, 2)}\n`);

const counts = truthPages.reduce((acc, p) => {
    acc[p.kind] = (acc[p.kind] ?? 0) + 1;
    return acc;
}, {});
console.log(`\n  wrote test-fixtures/m2-5/drawing-set.pdf  (${truthPages.length} pages, ${bytes.length} bytes)\n`);
console.log(`  kinds     ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`  sizes     ${[...new Set(truthPages.map((p) => p.size))].join(' ')}`);
console.log(`  layouts   ${[...new Set(truthPages.map((p) => p.layout))].join(' ')}`);
console.log(`  rotations ${[...new Set(truthPages.map((p) => p.rotate))].sort((a, b) => a - b).join(' ')}`);
console.log('');
for (const p of truthPages) {
    console.log(`  ${String(p.page).padStart(2)}  ${p.kind.padEnd(8)} ${p.size.padEnd(3)} ${p.layout} rot${String(p.rotate).padStart(3)}  ${String(p.values.drawing_number).padEnd(10)} ${p.note ?? ''}`);
}
console.log('');
