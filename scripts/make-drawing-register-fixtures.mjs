/**
 * A synthetic drawing set for the drawing-register gates.
 *
 * Fifteen pages chosen to make each thing the register has to handle fail
 * loudly if it stops working: native and scanned sheets, all four `/Rotate`
 * values on scanned pages specifically, a raster sheet whose drawing number is
 * still vector text, a raster sheet whose only text sits in the margin and is
 * therefore classified scanned, a raster sheet under an invisible OCR text
 * layer, two
 * title-block layouts on the same sheet size, a title block of fixed physical
 * size, an A0 sheet, a duplicate drawing number, a blank revision, a
 * leading-zero number, a value a spreadsheet would evaluate, and both Japanese
 * and English titles.
 *
 * Everything is drawn from text we control, using the OFL font already shipped
 * for OCR. No customer document and no real project drawing is used anywhere.
 * Nothing generated here is committed -- test-fixtures/ is ignored -- so the
 * gates regenerate it, and it is deterministic so that a number that moves
 * between two runs is a change in the code.
 *
 * The answer key travels beside the PDF as `drawing-register.truth.json` and
 * records, per page, the field values and the field rectangles in **upright
 * page space** (origin top-left, y down, PDF points), so a gate can ask "did
 * the register read what the sheet says" rather than "did it read something".
 *
 * Run:  node scripts/make-drawing-register-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'drawing-register');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');
const EPOCH = new Date(0);

/** Sheet sizes in points. A0 is here for the rasterisation bound, not layout. */
const SIZES = {
    A3: { w: 841.89, h: 1190.55 },
    A2: { w: 1190.55, h: 1683.78 },
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
 * The four field regions, as a fraction of the sheet.
 *
 * Layout A puts the title block in the bottom-right corner. Layout B runs it up
 * the right-hand edge. Both appear here on A2, because "same sheet size" must
 * not be enough to decide which template a page uses.
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
    C: {
        // A strip along the very bottom of the sheet, below the band
        // classifyPage() treats as the content region. A page whose only text
        // lives here counts zero interior characters and is therefore called
        // *scanned* -- while still carrying perfectly good vector text.
        name: 'C: margin strip, bottom edge',
        block: { left: 0.55, top: 0.962, right: 0.99, bottom: 0.995 },
        fields: {
            drawing_number: { left: 0.55, top: 0.962, right: 0.66, bottom: 0.995 },
            drawing_title: { left: 0.66, top: 0.962, right: 0.83, bottom: 0.995 },
            revision: { left: 0.83, top: 0.962, right: 0.90, bottom: 0.995 },
            revision_date: { left: 0.90, top: 0.962, right: 0.99, bottom: 0.995 },
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
 * The fractional layouts above scale with the paper, which is one real
 * convention. This is the other: a block pinned to the corner at a fixed size,
 * so on a bigger sheet it occupies a smaller fraction. Without a page like this
 * the proportional transfer model would look like the only answer needed.
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

const LABELS = {
    drawing_number: '図面番号',
    drawing_title: '図面名称',
    revision: 'REV',
    revision_date: '日付',
};

/** Sheet border and some drawing-looking content, so a page is not blank. */
function drawSheet(page, font, size) {
    const m = 0.02;
    const x0 = size.w * m;
    const y0 = size.h * m;
    const w = size.w * (1 - 2 * m);
    const h = size.h * (1 - 2 * m);
    const line = (x, y, width, height) => page.drawRectangle({ x, y, width, height, color: rgb(0, 0, 0) });
    line(x0, y0, w, 1.4);
    line(x0, y0 + h, w, 1.4);
    line(x0, y0, 1.4, h);
    line(x0 + w, y0, 1.4, h);
    const cols = 6;
    const rows = 8;
    for (let i = 1; i < cols; i++) line(x0 + (w / cols) * i, y0 + h * 0.15, 0.4, h * 0.65);
    for (let j = 1; j < rows; j++) line(x0 + w * 0.05, y0 + h * 0.15 + (h * 0.65 / rows) * j, w * 0.5, 0.4);
    page.drawText('PLAN', { x: x0 + w * 0.08, y: y0 + h * 0.82, size: size.w / 40, font, color: rgb(0.35, 0.35, 0.35) });
}

/**
 * Draw a title block, and report where each field sits.
 *
 * The label and the value go inside the same rectangle on purpose: that is
 * what a field region on a real sheet contains, and an extraction that cannot
 * tell them apart is a finding rather than a fixture bug.
 */
function drawTitleBlock(page, font, size, values, spec) {
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

    const fields = {};
    for (const [key, frac] of Object.entries(spec.fields)) {
        const r = toPoints(frac, size);
        rect(r);
        fields[key] = r;
        let y = r.top + labelSize + 3 * scale;
        page.drawText(LABELS[key], { x: r.left + 4 * scale, y: size.h - y, size: labelSize, font, color: rgb(0.3, 0.3, 0.3) });
        y += fontSize + 2 * scale;
        for (const lineText of String(values[key] ?? '').split('\n')) {
            if (lineText === '') continue;
            page.drawText(lineText, { x: r.left + 4 * scale, y: size.h - y, size: fontSize, font, color: rgb(0, 0, 0) });
            y += fontSize * 1.25;
        }
    }
    return { block, fields };
}

/**
 * Draw the four values as plain vector text, with no ruled boxes.
 *
 * Used for the margin-strip page: the sheet itself is a raster, and the only
 * real text on it sits outside the region the classifier looks at.
 */
function drawMarginText(page, font, size, values, spec) {
    const scale = size.w / SIZES.A3.w;
    const fontSize = 10 * scale;
    const fields = {};
    for (const [key, frac] of Object.entries(spec.fields)) {
        const r = toPoints(frac, size);
        fields[key] = r;
        page.drawText(String(values[key] ?? ''), {
            x: r.left + 3 * scale,
            y: size.h - (r.top + fontSize + 3 * scale),
            size: fontSize, font, color: rgb(0, 0, 0),
        });
    }
    return { block: toPoints(spec.block, size), fields };
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

/** Just the drawing, with no title block at all. */
function drawingOnlyHtml(pxW, pxH) {
    const base = Math.max(11, (pxW / 841.89) * 11);
    return `<div style="position:relative;width:${pxW}px;height:${pxH}px">`
        + `<div style="position:absolute;left:${pxW * 0.06}px;top:${pxH * 0.1}px;width:${pxW * 0.55}px;height:${pxH * 0.6}px;border:2px solid #000"></div>`
        + `<div style="position:absolute;left:${pxW * 0.09}px;top:${pxH * 0.14}px;font-size:${base * 1.6}px">PLAN</div>`
        + '</div>';
}

/** The same title block, as a picture, positioned by the same fractions. */
function scannedSheetHtml(size, values, pxW, pxH, spec) {
    const px = (frac) => ({
        left: frac.left * pxW, top: frac.top * pxH,
        width: (frac.right - frac.left) * pxW, height: (frac.bottom - frac.top) * pxH,
    });
    const base = Math.max(11, (pxW / 841.89) * 11);
    const label = base * 0.62;
    const blockBox = px(spec.block);
    let html = `<div style="position:absolute;left:${blockBox.left}px;top:${blockBox.top}px;width:${blockBox.width}px;height:${blockBox.height}px;border:2px solid #000"></div>`;
    for (const [key, frac] of Object.entries(spec.fields)) {
        const b = px(frac);
        html += `<div style="position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;border:1px solid #000;box-sizing:border-box;padding:${base * 0.25}px">`
            + `<div style="font-size:${label}px;color:#444">${LABELS[key]}</div>`
            + `<div style="font-size:${base}px;white-space:pre-line">${String(values[key] ?? '')}</div>`
            + '</div>';
    }
    html += `<div style="position:absolute;left:${pxW * 0.06}px;top:${pxH * 0.1}px;width:${pxW * 0.55}px;height:${pxH * 0.6}px;border:2px solid #000"></div>`;
    html += `<div style="position:absolute;left:${pxW * 0.09}px;top:${pxH * 0.14}px;font-size:${base * 1.6}px">PLAN</div>`;
    return `<div style="position:relative;width:${pxW}px;height:${pxH}px">${html}</div>`;
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/**
 * `kind` says how a page is made, not what it means:
 *   native    text drawn into the page content
 *   scanned   a raster image, no text at all
 *   stamp     a raster drawing with only the drawing number as vector text
 *   ocrlayer  a raster drawing with an invisible text layer over it
 */
const PAGES = [
    // Native, layout A, proportional block -- the ordinary case, in Japanese.
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-101', drawing_title: '1階平面図', revision: 'A', revision_date: '2026.09.01' } },
    // The same number again: the duplicate check has something true to find.
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-101', drawing_title: '1階平面図（差替）', revision: 'C', revision_date: '2026.09.10' }, note: 'duplicate of page 1' },
    // Leading zeros, and an English title.
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: '001', drawing_title: 'GROUND FLOOR PLAN', revision: 'A', revision_date: '2026-09-01' }, note: 'leading zeros must survive to the workbook' },
    // A value a spreadsheet would evaluate, and a revision left blank.
    { kind: 'native', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: '=1+1', drawing_title: '@ABC 仮設計画', revision: '', revision_date: '2026.09.02' }, note: 'formula-like text, blank revision' },
    // Two A2 sheets, same size, different title block.
    { kind: 'native', size: 'A2', layout: 'A', rotate: 0, values: { drawing_number: 'S-201', drawing_title: '基礎伏図', revision: '03', revision_date: '2026.09.02' } },
    { kind: 'native', size: 'A2', layout: 'B', rotate: 0, values: { drawing_number: 'ME-003', drawing_title: '設備配管図', revision: 'A', revision_date: '2026.09.03' }, note: 'same sheet size as page 5, different layout' },
    // Scanned, at every rotation. The rotated ones are why this set exists:
    // a region render that forgets to undo /Rotate crops the right pixels and
    // hands OCR a title block on its side.
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-106', drawing_title: '屋根伏図', revision: 'A', revision_date: '2026.09.04' } },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 90, values: { drawing_number: 'A-107', drawing_title: '南立面図', revision: 'B', revision_date: '2026.09.04' } },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 180, values: { drawing_number: 'A-108', drawing_title: '断面図', revision: 'A', revision_date: '2026.09.05' } },
    { kind: 'scanned', size: 'A3', layout: 'A', rotate: 270, values: { drawing_number: 'A-109', drawing_title: '矩計図', revision: 'A', revision_date: '2026.09.05' } },
    // A raster sheet whose drawing number is still vector text: the page that
    // a page-level native/scanned switch reads one field of, silently.
    { kind: 'stamp', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-110', drawing_title: '立面図', revision: 'A', revision_date: '2026.09.06' }, note: 'mixed source: vector number over a raster sheet' },
    // A raster sheet under somebody else's OCR text layer.
    { kind: 'ocrlayer', size: 'A3', layout: 'A', rotate: 0, values: { drawing_number: 'A-111', drawing_title: '仕上詳細図', revision: 'A', revision_date: '2026.09.06' }, note: 'invisible text layer, as a searchable PDF carries' },
    // A title block of fixed physical size on a bigger sheet.
    { kind: 'native', size: 'A2', layout: 'A', rotate: 0, fixedBlock: true, values: { drawing_number: 'A-140', drawing_title: '外構平面図', revision: 'A', revision_date: '2026.09.07' }, note: 'fixed-physical-size block' },
    // A raster sheet whose only text is a margin strip. The classifier calls
    // this page scanned -- correctly, by its own definition -- and the table
    // path therefore hands back nothing. The register must still read it,
    // because those four values are real vector text.
    { kind: 'marginstamp', size: 'A3', layout: 'C', rotate: 0, values: { drawing_number: 'A-115', drawing_title: 'MARGIN STRIP PLAN', revision: 'A', revision_date: '2026.09.07' }, note: 'classifies as scanned, yet every field is native text' },
    // A0, scanned: the page that must never be rasterised whole.
    { kind: 'scanned', size: 'A0', layout: 'A', rotate: 0, values: { drawing_number: 'A-121', drawing_title: '全体配置図', revision: 'A', revision_date: '2026.09.08' }, note: 'largest sheet; region rendering only' },
];

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
doc.setTitle('Drawing register fixtures');
doc.setAuthor('fixtures');
doc.setSubject('synthetic');
doc.setProducer('make-drawing-register-fixtures');
doc.setCreator('make-drawing-register-fixtures');
doc.setCreationDate(EPOCH);
doc.setModificationDate(EPOCH);

const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
const truthPages = [];

for (const [index, spec] of PAGES.entries()) {
    const size = SIZES[spec.size];
    const pageNumber = index + 1;
    const page = doc.addPage([size.w, size.h]);
    const layoutSpec = spec.fixedBlock ? fixedSizeLayout(spec.layout, size) : LAYOUTS[spec.layout];
    let regions;

    if (spec.kind === 'native') {
        drawSheet(page, font, size);
        regions = drawTitleBlock(page, font, size, spec.values, layoutSpec);
    } else if (spec.kind === 'marginstamp') {
        const pxW = Math.min(2000, Math.round(size.w * 2));
        const pxH = Math.round(pxW * (size.h / size.w));
        const png = await raster(drawingOnlyHtml(pxW, pxH), pxW, pxH);
        const image = await doc.embedPng(png);
        page.drawImage(image, { x: 0, y: 0, width: size.w, height: size.h });
        regions = drawMarginText(page, font, size, spec.values, layoutSpec);
        regions.rasterPixels = { width: pxW, height: pxH };
    } else {
        // Rasterised at roughly 150 dpi, capped so an A0 does not become an
        // unreasonable PNG. The cap is recorded in the answer key.
        const pxW = Math.min(2000, Math.round(size.w * 2));
        const pxH = Math.round(pxW * (size.h / size.w));
        const png = await raster(scannedSheetHtml(size, spec.values, pxW, pxH, layoutSpec), pxW, pxH);
        const image = await doc.embedPng(png);
        page.drawImage(image, { x: 0, y: 0, width: size.w, height: size.h });
        regions = {
            block: toPoints(layoutSpec.block, size),
            fields: Object.fromEntries(Object.entries(layoutSpec.fields).map(([k, f]) => [k, toPoints(f, size)])),
            rasterPixels: { width: pxW, height: pxH },
        };

        if (spec.kind === 'stamp') {
            const r = regions.fields.drawing_number;
            page.drawText(spec.values.drawing_number, {
                x: r.left + 6, y: size.h - (r.top + 26), size: 12, font, color: rgb(0, 0, 0),
            });
        }
        if (spec.kind === 'ocrlayer') {
            // White on white, which is enough for "is there text here" and is
            // recorded as such rather than dressed up as a real text layer.
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
fs.writeFileSync(path.join(OUT, 'drawing-register.pdf'), bytes);
fs.writeFileSync(path.join(OUT, 'drawing-register.truth.json'), `${JSON.stringify({
    pages: truthPages,
    layouts: Object.fromEntries(Object.entries(LAYOUTS).map(([k, v]) => [k, { name: v.name, block: v.block, fields: v.fields }])),
    sizes: SIZES,
}, null, 2)}\n`);

const counts = truthPages.reduce((acc, p) => {
    acc[p.kind] = (acc[p.kind] ?? 0) + 1;
    return acc;
}, {});
for (const p of truthPages) {
    console.log(`  ${String(p.page).padStart(2)}  ${p.kind.padEnd(8)} ${p.size.padEnd(3)} ${p.layout} rot${String(p.rotate).padStart(3)}  ${String(p.values.drawing_number).padEnd(10)} ${p.note ?? ''}`);
}
console.log(`\n  wrote test-fixtures/drawing-register/drawing-register.pdf  (${truthPages.length} pages, ${bytes.length} bytes)`);
console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
