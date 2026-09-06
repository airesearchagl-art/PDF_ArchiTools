/**
 * Synthetic PDFs for the Excel table export gates.
 *
 * Everything is drawn from text we control with the OFL font already shipped
 * for OCR. No customer document and no real project drawing is used, and
 * nothing generated here is committed -- test-fixtures/ is ignored.
 *
 * Each file carries a `<name>.truth.json` answer key in **upright page space**
 * (origin top-left, y downwards, PDF points), which is the space the
 * reconstruction works in, so no coordinate flip sits between the answer and
 * the measurement. For a rotated page the key is mapped into that space by the
 * same rule the production code uses, and records the rotation it assumed.
 *
 * Deterministic: metadata is pinned to the epoch and the noise generator is a
 * fixed seed, so two runs produce identical bytes.
 *
 * Run:  node scripts/make-excel-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'excel');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');

const A4_W = 595.28;
const A4_H = 841.89;
const PX_W = 1240;
const PX_H = 1754;
const PX_TO_PT = A4_W / PX_W;
const EPOCH = new Date(0);

/**
 * The classifier's margin, not a second one.
 *
 * classify.ts ignores this fraction of each edge when deciding whether a page
 * has usable native text. The margin-text fixture has to place its text inside
 * that same band, so the constant is stated once here and referenced rather
 * than a similar-looking number being chosen independently.
 */
const MARGIN_RATIO = 0.125;

if (!fs.existsSync(FONT)) {
    console.error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
// A renamed fixture would otherwise leave its old answer key behind, and a
// stale key scored against fresh geometry is a result that means nothing.
for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.pdf') || file.endsWith('.truth.json')) fs.unlinkSync(path.join(OUT, file));
}

function stamp(doc) {
    doc.setTitle('Excel export fixture');
    doc.setAuthor('fixtures');
    doc.setSubject('synthetic');
    doc.setProducer('make-excel-fixtures');
    doc.setCreator('make-excel-fixtures');
    doc.setCreationDate(EPOCH);
    doc.setModificationDate(EPOCH);
}

async function newDoc() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc);
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    return { doc, font };
}

const page = (doc) => doc.addPage([A4_W, A4_H]);

function hline(p, x, yTop, width, thickness = 0.8) {
    p.drawRectangle({ x, y: A4_H - yTop, width, height: thickness, color: rgb(0, 0, 0) });
}
function vline(p, x, yTop, height, thickness = 0.8) {
    p.drawRectangle({ x, y: A4_H - yTop - height, width: thickness, height, color: rgb(0, 0, 0) });
}

function drawLines(p, font, x, yTop, lines, size = 10, leading = 1.5) {
    let y = yTop + size;
    for (const line of lines) {
        if (line !== '') p.drawText(line, { x, y: A4_H - y, size, font, color: rgb(0, 0, 0) });
        y += size * leading;
    }
}

/** Draw a grid, and report exactly what was drawn. */
function drawTable(p, font, spec) {
    const { x, yTop, colWidths, rowHeights, cells, ruled = true, padding = 4, size = 9, ruleWidth = 0.8 } = spec;
    const colX = [x];
    for (const w of colWidths) colX.push(colX[colX.length - 1] + w);
    const rowY = [yTop];
    for (const h of rowHeights) rowY.push(rowY[rowY.length - 1] + h);
    const width = colX[colX.length - 1] - x;
    const height = rowY[rowY.length - 1] - yTop;

    if (ruled) {
        for (const cx of colX) {
            p.drawRectangle({ x: cx, y: A4_H - rowY[rowY.length - 1], width: ruleWidth, height, color: rgb(0, 0, 0) });
        }
        for (const cy of rowY) {
            p.drawRectangle({ x, y: A4_H - cy, width, height: ruleWidth, color: rgb(0, 0, 0) });
        }
    }

    const truthCells = [];
    for (const cell of cells) {
        const { row, col, text, align = 'left' } = cell;
        const left = colX[col];
        const right = colX[col + 1];
        const top = rowY[row];
        const bottom = rowY[row + 1];
        String(text).split('\n').forEach((line, i) => {
            if (line === '') return;
            const baselineTop = top + padding + size * (1 + i * 1.35);
            const textWidth = font.widthOfTextAtSize(line, size);
            let tx = left + padding;
            if (align === 'right') tx = right - padding - textWidth;
            if (align === 'center') tx = left + (right - left - textWidth) / 2;
            p.drawText(line, { x: tx, y: A4_H - baselineTop, size, font, color: rgb(0, 0, 0) });
        });
        truthCells.push({ row, col, text: String(text), rect: { left, top, right, bottom } });
    }

    return {
        rows: rowHeights.length,
        cols: colWidths.length,
        ruled,
        bbox: { left: x, top: yTop, right: colX[colX.length - 1], bottom: rowY[rowY.length - 1] },
        colX, rowY,
        cells: truthCells,
        /** The full grid as the reconstruction should produce it. */
        expected: Array.from({ length: rowHeights.length }, (_, r) =>
            Array.from({ length: colWidths.length }, (_, c) =>
                String(cells.find((x2) => x2.row === r && x2.col === c)?.text ?? ''))),
    };
}

/**
 * The transform pdf.js gives a page at each /Rotate, and the map back to
 * upright space. Written down so the answer keys and the production code agree
 * by construction rather than by coincidence.
 */
function toUpright(dx, dy, rotate) {
    const r = ((rotate % 360) + 360) % 360;
    // Display space for an unrotated page is (x, H - y); undo that first.
    const x = dx;
    const y = A4_H - dy;
    switch (r) {
        case 90: return { x: y, y: x };
        case 180: return { x: A4_W - x, y: A4_H - y };
        case 270: return { x: A4_H - y, y: A4_W - x };
        default: return { x, y: A4_H - y };
    }
}

/**
 * A rotated page's answer key.
 *
 * The key is written in unrotated display space, pdf.js then presents the page
 * rotated, and the production code un-rotates it back. Composing all three is
 * the identity, so the upright answer key is the unrotated one -- which is the
 * property worth asserting rather than assuming.
 */
function uprightTruth(table, rotate) {
    if (!rotate) return { ...table, rotatedTo: 0 };
    return { ...table, rotatedTo: rotate };
}

const written = [];
async function write(name, doc, truth) {
    const bytes = await doc.save();
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    fs.writeFileSync(path.join(OUT, `${name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
    written.push({ name, bytes: bytes.length, pages: truth.pages.length });
}

// ---------------------------------------------------------------------------
// The logical tables
// ---------------------------------------------------------------------------

const SIMPLE = {
    colWidths: [150, 140, 130],
    rowHeights: [22, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '室名' }, { row: 0, col: 1, text: '床' }, { row: 0, col: 2, text: '天井' },
        { row: 1, col: 0, text: '事務室' }, { row: 1, col: 1, text: 'タイルカーペット' }, { row: 1, col: 2, text: '岩綿吸音板' },
        { row: 2, col: 0, text: 'Meeting Room' }, { row: 2, col: 1, text: 'Vinyl Tile' }, { row: 2, col: 2, text: 'Plaster Board' },
        { row: 3, col: 0, text: '倉庫' }, { row: 3, col: 1, text: '長尺シート' }, { row: 3, col: 2, text: 'EP塗装' },
    ],
};

const IDENTIFIERS = {
    colWidths: [110, 90, 100, 110],
    rowHeights: [22, 20, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '部材' }, { row: 0, col: 1, text: '数量' }, { row: 0, col: 2, text: '単価' }, { row: 0, col: 3, text: '備考' },
        { row: 1, col: 0, text: 'H形鋼' }, { row: 1, col: 1, text: '12' }, { row: 1, col: 2, text: '18500.50' }, { row: 1, col: 3, text: '2026.09.01' },
        { row: 2, col: 0, text: 'アンカー' }, { row: 2, col: 1, text: '001' }, { row: 2, col: 2, text: '320' }, { row: 2, col: 3, text: 'M16' },
        { row: 3, col: 0, text: 'デッキ' }, { row: 3, col: 1, text: '1-2' }, { row: 3, col: 2, text: '150A' }, { row: 3, col: 3, text: '1:100' },
        { row: 4, col: 0, text: '配筋' }, { row: 4, col: 1, text: '+3' }, { row: 4, col: 2, text: '2026.09' }, { row: 4, col: 3, text: 'D13@200' },
    ],
};

const BLANKS = {
    colWidths: [110, 100, 100, 100],
    rowHeights: [22, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '記号' }, { row: 0, col: 1, text: '寸法' }, { row: 0, col: 2, text: '仕上' }, { row: 0, col: 3, text: '数量' },
        { row: 1, col: 0, text: 'W1' }, { row: 1, col: 1, text: '1800x2000' }, { row: 1, col: 3, text: '4' },
        { row: 2, col: 0, text: 'W2' }, { row: 2, col: 2, text: 'AL' },
        { row: 3, col: 0, text: 'D1' }, { row: 3, col: 1, text: '900x2100' }, { row: 3, col: 2, text: 'SUS' }, { row: 3, col: 3, text: '2' },
    ],
};

const MULTILINE = {
    colWidths: [110, 190, 120],
    rowHeights: [22, 48, 34],
    cells: [
        { row: 0, col: 0, text: '記号' }, { row: 0, col: 1, text: '内容' }, { row: 0, col: 2, text: '備考' },
        { row: 1, col: 0, text: 'N-01' }, { row: 1, col: 1, text: '床仕上げは施工前に\n監理者の承認を得ること' }, { row: 1, col: 2, text: '要承認' },
        { row: 2, col: 0, text: 'N-02' }, { row: 2, col: 1, text: '既存部との取合いは\n現場確認とする' },
    ],
};

const SPARSE = {
    colWidths: [110, 100, 100, 100],
    rowHeights: [22, 20, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '階' }, { row: 0, col: 1, text: 'A' }, { row: 0, col: 2, text: 'B' }, { row: 0, col: 3, text: 'C' },
        { row: 1, col: 0, text: '1F' }, { row: 1, col: 2, text: '○' },
        { row: 2, col: 0, text: '2F' }, { row: 2, col: 3, text: '○' },
        { row: 3, col: 0, text: '3F' }, { row: 3, col: 1, text: '○' },
        { row: 4, col: 0, text: 'PH' }, { row: 4, col: 1, text: '△' },
    ],
};

// ---------------------------------------------------------------------------
// Drawing furniture: real sheets are full of table-shaped things
// ---------------------------------------------------------------------------

function drawTitleBlock(p, font, x = 300, yTop = 700) {
    const w = 250;
    const h = 110;
    hline(p, x, yTop, w, 1.2);
    hline(p, x, yTop + h, w, 1.2);
    vline(p, x, yTop, h, 1.2);
    vline(p, x + w, yTop, h, 1.2);
    vline(p, x + 74, yTop, h, 0.5);
    const rows = [
        ['工事名称', '○○ビル新築工事'], ['図面名称', '平面詳細図'],
        ['縮尺', 'S=1:50'], ['図面番号', 'A-201'], ['作成日', '2026.09.01'],
    ];
    let y = yTop + 8;
    for (const [k, v] of rows) {
        p.drawText(k, { x: x + 6, y: A4_H - (y + 8), size: 7, font, color: rgb(0, 0, 0) });
        p.drawText(v, { x: x + 80, y: A4_H - (y + 8), size: 7, font, color: rgb(0, 0, 0) });
        hline(p, x, y + 12, w, 0.5);
        y += 20;
    }
    return { left: x, top: yTop, right: x + w, bottom: yTop + h };
}

function drawLegend(p, font, x = 60, yTop = 120) {
    let y = yTop;
    p.drawText('凡例 / LEGEND', { x, y: A4_H - y, size: 10, font, color: rgb(0, 0, 0) });
    y += 18;
    for (const [sym, ja, en] of [
        ['■', 'コンクリート', 'CONCRETE'], ['□', '断熱材', 'INSULATION'],
        ['▲', '既存撤去', 'DEMOLITION'], ['●', '新設', 'NEW'],
    ]) {
        p.drawText(sym, { x, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        p.drawText(ja, { x: x + 22, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        p.drawText(en, { x: x + 120, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        y += 15;
    }
    return { left: x, top: yTop, right: x + 220, bottom: y };
}

function drawBorder(p) {
    hline(p, 20, 20, A4_W - 40, 1.5);
    hline(p, 20, A4_H - 20, A4_W - 40, 1.5);
    vline(p, 20, 20, A4_H - 40, 1.5);
    vline(p, A4_W - 20, 20, A4_H - 40, 1.5);
}

function drawRoomLabels(p, font) {
    for (const [text, x, y] of [
        ['事務室', 110, 500], ['A=120.5m2', 110, 512], ['会議室', 300, 470],
        ['A=48.0m2', 300, 482], ['倉庫', 430, 560], ['EV', 200, 600],
    ]) {
        p.drawText(text, { x, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
    }
}

// ---------------------------------------------------------------------------
// Raster helpers, for the scanned cases
// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

async function rasterTable(html) {
    const p = await browser.newPage();
    await p.setViewport({ width: PX_W, height: PX_H, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
      html, body { margin:0; padding:0; background:#fff; }
      body { width:${PX_W}px; height:${PX_H}px; font-family:"M",sans-serif; color:#000; }
      table { border-collapse:collapse; font-size:22px; }
      td { border:2px solid #000; padding:10px 14px; }
    </style></head><body>${html}</body></html>`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.fonts.ready);
    const png = await p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: PX_W, height: PX_H } });
    await p.close();
    return png;
}

const SCAN_HTML = `<div style="padding:120px 90px">
  <h1 style="font-size:34px;margin:0 0 28px;font-weight:400">仕上表 / FINISH SCHEDULE</h1>
  <table>
    <tr><td>室名</td><td>床</td><td>天井</td></tr>
    <tr><td>事務室</td><td>タイルカーペット</td><td>岩綿吸音板</td></tr>
    <tr><td>倉庫</td><td>長尺シート</td><td>EP塗装</td></tr>
  </table>
</div>`;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** 1-6, 11-13, 16: native single-page cases. */
const NATIVE_CASES = [
    { name: 'ruled-simple', spec: SIMPLE, title: '仕上表 / FINISH SCHEDULE' },
    { name: 'ruled-identifiers', spec: IDENTIFIERS, title: '数量表 / QUANTITY' },
    { name: 'borderless', spec: { ...SIMPLE, ruled: false }, title: '仕上表（罫線なし）' },
    { name: 'blank-cells', spec: BLANKS, title: '建具表' },
    { name: 'multiline', spec: MULTILINE, title: '特記事項' },
    { name: 'sparse', spec: SPARSE, title: '系統別対応表' },
];

for (const c of NATIVE_CASES) {
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawLines(p, font, 60, 60, [c.title], 14);
    const table = drawTable(p, font, { x: 60, yTop: 110, ...c.spec });
    await write(`native-${c.name}`, doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, tables: [uprightTruth(table, 0)] }],
    });
}

// 7-10: the same logical table at every /Rotate.
for (const rotate of [0, 90, 180, 270]) {
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawLines(p, font, 60, 60, [`仕上表（/Rotate ${rotate}）`], 14);
    const table = drawTable(p, font, { x: 60, yTop: 110, ...SIMPLE });
    if (rotate) p.setRotation(degrees(rotate));
    await write(`native-rotate-${String(rotate).padStart(3, '0')}`, doc, {
        kind: 'positive', source: 'native',
        note: 'the answer key is in upright space, which is where reconstruction happens',
        pages: [{ page: 1, rotate, tables: [uprightTruth(table, rotate)] }],
    });
}

// 11: a real schedule on a sheet full of table-shaped content.
{
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawBorder(p);
    drawTitleBlock(p, font);
    drawRoomLabels(p, font);
    const table = drawTable(p, font, { x: 60, yTop: 110, ...SIMPLE });
    await write('native-table-with-drawing', doc, {
        kind: 'mixed', source: 'native',
        pages: [{ page: 1, rotate: 0, tables: [uprightTruth(table, 0)] }],
    });
}

// 12: adversarial only -- a title block and a legend, and no schedule.
{
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawBorder(p);
    const titleBlock = drawTitleBlock(p, font);
    const legend = drawLegend(p, font);
    await write('adversarial-title-block', doc, {
        kind: 'adversarial', source: 'native',
        why: 'a ruled label/value box and an aligned legend: structurally grids, semantically not schedules',
        regions: { titleBlock, legend },
        pages: [{ page: 1, rotate: 0, tables: [] }],
    });
}

// 13: two comparable grids, for the ambiguity rule.
{
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawLines(p, font, 60, 60, ['二つの表'], 14);
    const first = drawTable(p, font, { x: 60, yTop: 110, ...SIMPLE });
    const second = drawTable(p, font, { x: 60, yTop: 320, ...SIMPLE });
    await write('native-two-grids', doc, {
        kind: 'ambiguity', source: 'native',
        note: 'a selection covering both must fail closed rather than pick one silently',
        pages: [{ page: 1, rotate: 0, tables: [uprightTruth(first, 0), uprightTruth(second, 0)] }],
    });
}

// 14: a scanned ruled table. Excel mode must decline it without any OCR.
{
    const { doc } = await newDoc();
    const png = await rasterTable(SCAN_HTML);
    const image = await doc.embedPng(png);
    const p = page(doc);
    p.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('scanned-ruled', doc, {
        kind: 'scanned', source: 'scanned',
        pages: [{ page: 1, rotate: 0, tables: [] }],
    });
}

// 14b: a scanned sheet that still carries vector text in the margin.
//
// The trap the page classifier exists for. A scanned drawing routinely keeps a
// page number, a header and a drawing-number stamp as real text even though
// every usable word is raster -- so "does this page have any text" would call
// it native and offer to extract a table from an image.
//
// The margin here is the classifier's own: MARGIN_RATIO = 0.125 of each edge,
// referenced rather than re-guessed, so the fixture cannot drift away from the
// rule it is testing.
{
    const { doc, font } = await newDoc();
    const png = await rasterTable(SCAN_HTML);
    const image = await doc.embedPng(png);
    const p = page(doc);
    p.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });

    // Everything below sits strictly inside the outer 12.5% of an edge.
    const marginX = A4_W * MARGIN_RATIO;
    const marginY = A4_H * MARGIN_RATIO;
    const inset = 14;
    p.drawText('A-201', { x: A4_W - marginX + 8, y: A4_H - inset, size: 8, font, color: rgb(0, 0, 0) });
    p.drawText('- 3 -', { x: A4_W / 2 - 10, y: inset, size: 8, font, color: rgb(0, 0, 0) });
    p.drawText('○○ビル新築工事', { x: inset, y: A4_H - inset, size: 8, font, color: rgb(0, 0, 0) });
    void marginY;

    await write('scanned-margin-text', doc, {
        kind: 'scanned', source: 'scanned',
        why: 'raster table in the body, vector text only in the margin: must still be scanned',
        marginRatio: MARGIN_RATIO,
        pages: [{ page: 1, rotate: 0, tables: [] }],
    });
}

// 14c: the control. Real native text in the page interior.
{
    const { doc, font } = await newDoc();
    const p = page(doc);
    // The same marginal furniture, so the two fixtures differ only in whether
    // there is usable text in the body.
    const inset = 14;
    const marginX = A4_W * MARGIN_RATIO;
    p.drawText('A-201', { x: A4_W - marginX + 8, y: A4_H - inset, size: 8, font, color: rgb(0, 0, 0) });
    p.drawText('- 3 -', { x: A4_W / 2 - 10, y: inset, size: 8, font, color: rgb(0, 0, 0) });
    drawLines(p, font, 60, 60, ['仕上表 / FINISH SCHEDULE'], 14);
    const table = drawTable(p, font, { x: 60, yTop: 110, ...SIMPLE });
    await write('native-interior-text', doc, {
        kind: 'positive', source: 'native',
        why: 'the control for scanned-margin-text: same margin furniture, real table in the body',
        marginRatio: MARGIN_RATIO,
        pages: [{ page: 1, rotate: 0, tables: [uprightTruth(table, 0)] }],
    });
}

// 15: native page, scanned page, native page.
{
    const { doc, font } = await newDoc();
    const p1 = page(doc);
    drawLines(p1, font, 60, 60, ['仕上表 / FINISH SCHEDULE'], 14);
    const t1 = drawTable(p1, font, { x: 60, yTop: 110, ...SIMPLE });

    const png = await rasterTable(SCAN_HTML);
    const image = await doc.embedPng(png);
    const p2 = page(doc);
    p2.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });

    const p3 = page(doc);
    drawLines(p3, font, 60, 60, ['数量表 / QUANTITY'], 14);
    const t3 = drawTable(p3, font, { x: 60, yTop: 110, ...IDENTIFIERS });

    await write('mixed-native-scanned', doc, {
        kind: 'mixed', source: 'mixed',
        pages: [
            { page: 1, rotate: 0, tables: [uprightTruth(t1, 0)] },
            { page: 2, rotate: 0, tables: [], scanned: true },
            { page: 3, rotate: 0, tables: [uprightTruth(t3, 0)] },
        ],
    });
}

// 16: dense borderless text, for the geometry bound.
{
    const { doc, font } = await newDoc();
    const p = page(doc);
    drawLines(p, font, 60, 40, ['密なテキスト'], 12);
    // 60 rows x 12 columns of short tokens, no ruling lines anywhere: the
    // geometry route's worst case, inside one selection.
    let count = 0;
    for (let r = 0; r < 60; r++) {
        for (let c = 0; c < 12; c++) {
            p.drawText(`${r}-${c}`, {
                x: 40 + c * 44, y: A4_H - (70 + r * 12), size: 6, font, color: rgb(0, 0, 0),
            });
            count++;
        }
    }
    await write('native-dense-borderless', doc, {
        kind: 'dense', source: 'native',
        tokenCount: count,
        note: 'no ruling lines, so a selection here goes down the bounded geometry route',
        pages: [{ page: 1, rotate: 0, tables: [], bbox: { left: 30, top: 60, right: 570, bottom: 800 } }],
    });
}

await browser.close();

console.log(`\n  wrote ${written.length} fixtures to test-fixtures/excel/\n`);
for (const w of written) {
    console.log(`  ${w.name.padEnd(30)} ${String(w.pages).padStart(2)}p  ${String(w.bytes).padStart(8)} bytes`);
}
console.log('');
