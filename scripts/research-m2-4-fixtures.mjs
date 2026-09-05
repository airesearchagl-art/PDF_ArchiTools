/**
 * The synthetic corpus for the M2-4 table-reconstruction spike.
 *
 * Two halves, and the second one is the point.
 *
 *   Positive cases  -- documents that really do contain a table, each written
 *                      out with the grid that produced it, so accuracy is
 *                      measured against a known answer instead of an opinion.
 *   Adversarial     -- architectural drawing content that looks table-shaped to
 *                      a clustering algorithm and is not a table: title blocks,
 *                      legends, keynote lists, dimension strings, column grids.
 *                      The expected answer for these is zero tables.
 *
 * Everything is drawn from text we control with the OFL font already shipped
 * for OCR. No customer document and no real project drawing is used anywhere,
 * and nothing generated here is committed -- test-fixtures/ is ignored.
 *
 * Ground truth travels with each file as <name>.truth.json, in *display space*
 * at scale 1: origin top-left, y downwards, PDF points. That is the space the
 * probes measure in, so no coordinate flip sits between the answer and the
 * measurement.
 *
 * Run:  node scripts/research-m2-4-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-4');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');

const A4_W = 595.28;
const A4_H = 841.89;
const PX_W = 1240;
const PX_H = 1754;
/** A raster sheet is laid over the whole A4 page, so this converts px to points. */
const PX_TO_PT = A4_W / PX_W;

if (!fs.existsSync(FONT)) {
    console.error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const EPOCH = new Date(0);

/** pdf-lib stamps dates by default; fixed metadata keeps runs byte-identical. */
function stamp(doc) {
    doc.setTitle('M2-4 research fixture');
    doc.setAuthor('research');
    doc.setSubject('synthetic');
    doc.setProducer('research-m2-4-fixtures');
    doc.setCreator('research-m2-4-fixtures');
    doc.setCreationDate(EPOCH);
    doc.setModificationDate(EPOCH);
}

// ---------------------------------------------------------------------------
// Native drawing
// ---------------------------------------------------------------------------

/**
 * Draw a grid of cells and report exactly what was drawn.
 *
 * Text is placed cell by cell so each cell's content is a text run of its own.
 * A real PDF is not always that tidy, which is why `fragment` exists: it splits
 * a cell's string into two runs drawn side by side, the way kerning and font
 * switches fragment a line in a PDF produced by a CAD package.
 */
function drawTable(page, font, spec) {
    const {
        x, yTop, colWidths, rowHeights, cells,
        ruled = true, padding = 4, size = 9, fragment = false,
        ruleWidth = 0.8,
    } = spec;

    const colX = [x];
    for (const w of colWidths) colX.push(colX[colX.length - 1] + w);
    const rowY = [yTop];
    for (const h of rowHeights) rowY.push(rowY[rowY.length - 1] + h);

    const width = colX[colX.length - 1] - x;
    const height = rowY[rowY.length - 1] - yTop;

    // Ruling lines, drawn as thin filled rectangles: a vector line in the page
    // content, which is what the ruling-line detection question is about.
    if (ruled) {
        for (const cx of colX) {
            page.drawRectangle({
                x: cx, y: A4_H - rowY[rowY.length - 1], width: ruleWidth, height,
                color: rgb(0, 0, 0),
            });
        }
        for (const cy of rowY) {
            page.drawRectangle({
                x, y: A4_H - cy, width, height: ruleWidth,
                color: rgb(0, 0, 0),
            });
        }
    }

    const truthCells = [];
    const spans = [];
    for (const cell of cells) {
        const { row, col, text, rowSpan = 1, colSpan = 1, align = 'left' } = cell;
        const left = colX[col];
        const right = colX[col + colSpan];
        const top = rowY[row];
        const bottom = rowY[row + rowSpan];
        if (rowSpan > 1 || colSpan > 1) spans.push({ row, col, rowSpan, colSpan });

        // A merged cell hides the interior rules that would otherwise cross it.
        if (ruled && (rowSpan > 1 || colSpan > 1)) {
            page.drawRectangle({
                x: left + ruleWidth, y: A4_H - bottom + ruleWidth,
                width: right - left - ruleWidth, height: bottom - top - ruleWidth,
                color: rgb(1, 1, 1),
            });
            page.drawRectangle({ x: left, y: A4_H - bottom, width: ruleWidth, height: bottom - top, color: rgb(0, 0, 0) });
            page.drawRectangle({ x: right, y: A4_H - bottom, width: ruleWidth, height: bottom - top, color: rgb(0, 0, 0) });
            page.drawRectangle({ x: left, y: A4_H - top, width: right - left, height: ruleWidth, color: rgb(0, 0, 0) });
            page.drawRectangle({ x: left, y: A4_H - bottom, width: right - left, height: ruleWidth, color: rgb(0, 0, 0) });
        }

        const lines = String(text).split('\n');
        const runs = [];
        lines.forEach((line, i) => {
            if (line === '') return;
            const baselineTop = top + padding + size * (1 + i * 1.35);
            const textWidth = font.widthOfTextAtSize(line, size);
            let tx = left + padding;
            if (align === 'right') tx = right - padding - textWidth;
            if (align === 'center') tx = left + (right - left - textWidth) / 2;

            if (fragment && line.length > 3) {
                // Two runs, drawn where one run would have been.
                const cut = Math.ceil(line.length / 2);
                const head = line.slice(0, cut);
                const tail = line.slice(cut);
                page.drawText(head, { x: tx, y: A4_H - baselineTop, size, font, color: rgb(0, 0, 0) });
                const headWidth = font.widthOfTextAtSize(head, size);
                page.drawText(tail, { x: tx + headWidth, y: A4_H - baselineTop, size, font, color: rgb(0, 0, 0) });
                runs.push({ text: head, x: tx, baselineTop });
                runs.push({ text: tail, x: tx + headWidth, baselineTop });
            } else {
                page.drawText(line, { x: tx, y: A4_H - baselineTop, size, font, color: rgb(0, 0, 0) });
                runs.push({ text: line, x: tx, baselineTop });
            }
        });

        truthCells.push({
            row, col, rowSpan, colSpan,
            text: String(text),
            rect: { left, top, right, bottom },
            runs,
        });
    }

    return {
        rows: rowHeights.length,
        cols: colWidths.length,
        bbox: { left: x, top: yTop, right: colX[colX.length - 1], bottom: rowY[rowY.length - 1] },
        colX, rowY, ruled, spans,
        cells: truthCells,
    };
}

/**
 * Move a table's answer key into the space a /Rotate 90 page is displayed in.
 *
 * Truth is written in display space for an unrotated page: (x, pageHeight - y).
 * pdf.js hands a 90-degree page the viewport transform [0,1,1,0,0,0], so the
 * displayed point is (y_pdf, x_pdf). Composing the two gives (H - dy, dx),
 * which is what this applies -- rather than leaving the probe and the answer
 * key to disagree about which way up the page is.
 */
function rotateTruth90(table) {
    const pt = (x, y) => ({ x: A4_H - y, y: x });
    const box = (r) => {
        const a = pt(r.left, r.top);
        const b = pt(r.right, r.bottom);
        return {
            left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
            top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
        };
    };
    return {
        ...table,
        rotatedTo: 90,
        bbox: box(table.bbox),
        cells: table.cells.map((c) => ({ ...c, rect: box(c.rect), runs: [] })),
    };
}

/** Free text that is not part of any table: a title, a note, a paragraph. */
function drawLines(page, font, x, yTop, lines, size = 10, leading = 1.5) {
    let y = yTop + size;
    for (const line of lines) {
        if (line !== '') page.drawText(line, { x, y: A4_H - y, size, font, color: rgb(0, 0, 0) });
        y += size * leading;
    }
    return y;
}

function hline(page, x, yTop, width, thickness = 0.8) {
    page.drawRectangle({ x, y: A4_H - yTop, width, height: thickness, color: rgb(0, 0, 0) });
}

function vline(page, x, yTop, height, thickness = 0.8) {
    page.drawRectangle({ x, y: A4_H - yTop - height, width: thickness, height, color: rgb(0, 0, 0) });
}

// ---------------------------------------------------------------------------
// Raster drawing, for the scanned half of the corpus
// ---------------------------------------------------------------------------

/**
 * Render one HTML table to a PNG and measure where every cell landed.
 *
 * The measurement is `getBoundingClientRect()` on the real cells, converted to
 * page points -- not a guess at where the browser put them. Same logical table
 * as the native fixture it mirrors, so native and scanned results are
 * comparable rather than merely adjacent.
 */
async function rasterTable(browser, { cells, rows, cols, ruled = true, skewDeg = 0, speckle = 0, scan = 1 }) {
    const body = [];
    for (let r = 0; r < rows; r++) {
        const tds = [];
        for (let c = 0; c < cols; c++) {
            const cell = cells.find((x) => x.row === r && x.col === c);
            if (!cell) { tds.push('<td></td>'); continue; }
            const span = [];
            if ((cell.colSpan ?? 1) > 1) span.push(`colspan="${cell.colSpan}"`);
            if ((cell.rowSpan ?? 1) > 1) span.push(`rowspan="${cell.rowSpan}"`);
            const covered = cells.some((o) => o !== cell
                && r >= o.row && r < o.row + (o.rowSpan ?? 1)
                && c >= o.col && c < o.col + (o.colSpan ?? 1));
            if (covered) continue;
            tds.push(`<td ${span.join(' ')} data-cell="${r},${c}">${String(cell.text).replace(/\n/g, '<br>')}</td>`);
        }
        body.push(`<tr>${tds.join('')}</tr>`);
    }

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
      html, body { margin:0; padding:0; background:#fff; }
      body { width:${PX_W}px; height:${PX_H}px; font-family:"M",sans-serif; color:#000; }
      .skew { width:${PX_W}px; height:${PX_H}px; transform-origin:50% 50%; transform:rotate(${skewDeg}deg); }
      .sheet { padding:120px 90px; }
      h1 { font-size:34px; margin:0 0 28px; font-weight:400; }
      table { border-collapse:collapse; font-size:22px; }
      td { ${ruled ? 'border:2px solid #000;' : ''} padding:10px 14px; vertical-align:top; }
    </style></head><body>
      <div class="${skewDeg ? 'skew' : ''}"><div class="sheet">
        <h1>仕上表 / FINISH SCHEDULE</h1>
        <table>${body.join('')}</table>
      </div></div>
    </body></html>`;

    const page = await browser.newPage();
    // `scan` is the resolution the sheet was scanned at, not the resolution it
    // is later rendered at: a 2x raster carries twice the detail, where
    // re-rendering a 1x raster carries none.
    await page.setViewport({ width: PX_W, height: PX_H, deviceScaleFactor: scan });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);

    // Measured before any skew is considered: with a rotation applied the
    // rectangles are the axis-aligned bounds of rotated cells, which is exactly
    // what a downstream detector would have to live with.
    const measured = await page.evaluate(() => {
        const out = [];
        for (const td of document.querySelectorAll('td[data-cell]')) {
            const [row, col] = td.dataset.cell.split(',').map(Number);
            const r = td.getBoundingClientRect();
            out.push({ row, col, text: td.innerText, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        }
        const t = document.querySelector('table').getBoundingClientRect();
        return { cells: out, table: { left: t.left, top: t.top, right: t.right, bottom: t.bottom } };
    });

    let png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: PX_W, height: PX_H } });
    await page.close();
    if (speckle > 0) png = await addSpeckle(browser, png, 0x4d32, speckle);

    const toPt = (r) => ({
        left: r.left * PX_TO_PT, top: r.top * PX_TO_PT,
        right: r.right * PX_TO_PT, bottom: r.bottom * PX_TO_PT,
    });
    return {
        png,
        truth: {
            rows, cols, ruled,
            bbox: toPt(measured.table),
            spans: cells.filter((c) => (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1)
                .map((c) => ({ row: c.row, col: c.col, rowSpan: c.rowSpan ?? 1, colSpan: c.colSpan ?? 1 })),
            cells: measured.cells.map((c) => {
                const spec = cells.find((s) => s.row === c.row && s.col === c.col);
                return {
                    row: c.row, col: c.col,
                    rowSpan: spec?.rowSpan ?? 1, colSpan: spec?.colSpan ?? 1,
                    text: String(spec?.text ?? ''),
                    rect: toPt(c),
                    runs: [],
                };
            }),
        },
    };
}

/** A page of drawing content rendered as an image: the adversarial scan case. */
async function rasterSheet(browser, html, { skewDeg = 0, speckle = 0 } = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: PX_W, height: PX_H, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
      html, body { margin:0; padding:0; background:#fff; }
      body { width:${PX_W}px; height:${PX_H}px; font-family:"M",sans-serif; color:#000; }
      .skew { width:${PX_W}px; height:${PX_H}px; transform-origin:50% 50%; transform:rotate(${skewDeg}deg); }
    </style></head><body><div class="${skewDeg ? 'skew' : ''}">${html}</div></body></html>`,
    { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    let png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: PX_W, height: PX_H } });
    await page.close();
    if (speckle > 0) png = await addSpeckle(browser, png, 0x77a1, speckle);
    return png;
}

/** Seeded speckle: the same fixture must come out identical on every run. */
async function addSpeckle(browser, pngBuffer, seed, density) {
    const page = await browser.newPage();
    await page.setViewport({ width: 32, height: 32, deviceScaleFactor: 1 });
    await page.goto('about:blank');
    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    const out = await page.evaluate(async (src, seedValue, densityValue) => {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = reject; image.src = src;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = data.data;
        let state = seedValue >>> 0;
        const rand = () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const set = (x, y, v) => {
            if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
            const i = (y * canvas.width + x) * 4;
            d[i] = d[i + 1] = d[i + 2] = v;
        };
        const speckles = Math.round(canvas.width * canvas.height * densityValue);
        for (let n = 0; n < speckles; n++) {
            const x = Math.floor(rand() * canvas.width);
            const y = Math.floor(rand() * canvas.height);
            const roll = rand();
            if (roll < 0.72) set(x, y, 0);
            else if (roll < 0.93) { set(x, y, 0); set(x + 1, y, 0); }
            else { set(x, y, 0); set(x + 1, y, 0); set(x, y + 1, 0); }
        }
        ctx.putImageData(data, 0, 0);
        return canvas.toDataURL('image/png');
    }, dataUrl, seed, density);
    await page.close();
    return Buffer.from(out.split(',')[1], 'base64');
}

// ---------------------------------------------------------------------------
// The logical tables the corpus is built from
// ---------------------------------------------------------------------------

const SIMPLE = {
    rows: 4, cols: 3,
    colWidths: [150, 140, 130], rowHeights: [22, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '室名' }, { row: 0, col: 1, text: '床' }, { row: 0, col: 2, text: '天井' },
        { row: 1, col: 0, text: '事務室' }, { row: 1, col: 1, text: 'タイルカーペット' }, { row: 1, col: 2, text: '岩綿吸音板' },
        { row: 2, col: 0, text: 'Meeting Room' }, { row: 2, col: 1, text: 'Vinyl Tile' }, { row: 2, col: 2, text: 'Plaster Board' },
        { row: 3, col: 0, text: '倉庫' }, { row: 3, col: 1, text: '長尺シート' }, { row: 3, col: 2, text: 'EP塗装' },
    ],
};

const MIXED_TYPES = {
    rows: 5, cols: 4,
    colWidths: [110, 90, 100, 110], rowHeights: [22, 20, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '部材' }, { row: 0, col: 1, text: '数量' }, { row: 0, col: 2, text: '単価' }, { row: 0, col: 3, text: '備考' },
        { row: 1, col: 0, text: 'H形鋼' }, { row: 1, col: 1, text: '12', align: 'right' }, { row: 1, col: 2, text: '18500.50', align: 'right' }, { row: 1, col: 3, text: '2026.09.01' },
        { row: 2, col: 0, text: 'アンカー' }, { row: 2, col: 1, text: '001', align: 'right' }, { row: 2, col: 2, text: '320', align: 'right' }, { row: 2, col: 3, text: 'M16' },
        { row: 3, col: 0, text: 'デッキ' }, { row: 3, col: 1, text: '8', align: 'right' }, { row: 3, col: 2, text: '4200.00', align: 'right' }, { row: 3, col: 3, text: '1:100' },
        { row: 4, col: 0, text: '配筋' }, { row: 4, col: 1, text: '24', align: 'right' }, { row: 4, col: 2, text: '150', align: 'right' }, { row: 4, col: 3, text: 'D13@200' },
    ],
};

const BLANKS = {
    rows: 4, cols: 4,
    colWidths: [110, 100, 100, 100], rowHeights: [22, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '記号' }, { row: 0, col: 1, text: '寸法' }, { row: 0, col: 2, text: '仕上' }, { row: 0, col: 3, text: '数量' },
        { row: 1, col: 0, text: 'W1' }, { row: 1, col: 1, text: '1800x2000' }, { row: 1, col: 2, text: '' }, { row: 1, col: 3, text: '4', align: 'right' },
        { row: 2, col: 0, text: 'W2' }, { row: 2, col: 1, text: '' }, { row: 2, col: 2, text: 'AL' }, { row: 2, col: 3, text: '', align: 'right' },
        { row: 3, col: 0, text: 'D1' }, { row: 3, col: 1, text: '900x2100' }, { row: 3, col: 2, text: 'SUS' }, { row: 3, col: 3, text: '2', align: 'right' },
    ],
};

const MULTILINE = {
    rows: 3, cols: 3,
    colWidths: [110, 190, 120], rowHeights: [22, 48, 34],
    cells: [
        { row: 0, col: 0, text: '記号' }, { row: 0, col: 1, text: '内容' }, { row: 0, col: 2, text: '備考' },
        { row: 1, col: 0, text: 'N-01' }, { row: 1, col: 1, text: '床仕上げは施工前に\n監理者の承認を得ること\nサンプル提出のこと' }, { row: 1, col: 2, text: '要承認' },
        { row: 2, col: 0, text: 'N-02' }, { row: 2, col: 1, text: '既存部との取合いは\n現場確認とする' }, { row: 2, col: 2, text: '' },
    ],
};

const MERGED_HEADER = {
    rows: 4, cols: 4,
    colWidths: [100, 95, 95, 110], rowHeights: [20, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '室名', rowSpan: 2 },
        { row: 0, col: 1, text: '仕上', colSpan: 2, align: 'center' },
        { row: 0, col: 3, text: '面積', rowSpan: 2 },
        { row: 1, col: 1, text: '床' }, { row: 1, col: 2, text: '壁' },
        { row: 2, col: 0, text: '事務室' }, { row: 2, col: 1, text: 'OA' }, { row: 2, col: 2, text: 'EP' }, { row: 2, col: 3, text: '120.5', align: 'right' },
        { row: 3, col: 0, text: '会議室' }, { row: 3, col: 1, text: 'CT' }, { row: 3, col: 2, text: 'CL' }, { row: 3, col: 3, text: '48.0', align: 'right' },
    ],
};

const SPARSE = {
    rows: 5, cols: 4,
    colWidths: [110, 100, 100, 100], rowHeights: [22, 20, 20, 20, 20],
    cells: [
        { row: 0, col: 0, text: '階' }, { row: 0, col: 1, text: 'A' }, { row: 0, col: 2, text: 'B' }, { row: 0, col: 3, text: 'C' },
        { row: 1, col: 0, text: '1F' }, { row: 1, col: 2, text: '○' },
        { row: 2, col: 0, text: '2F' }, { row: 2, col: 3, text: '○' },
        { row: 3, col: 0, text: '3F' }, { row: 3, col: 1, text: '○' },
        { row: 4, col: 0, text: 'PH' },
    ],
};

// ---------------------------------------------------------------------------
// Adversarial drawing content -- none of this is a table
// ---------------------------------------------------------------------------

function drawTitleBlock(page, font) {
    // The bordered box in the corner of every drawing. Ruled, aligned,
    // label/value pairs: everything a naive detector reads as a table.
    const x = 300, yTop = 700, w = 250, h = 110;
    hline(page, x, yTop, w, 1.2);
    hline(page, x, yTop + h, w, 1.2);
    vline(page, x, yTop, h, 1.2);
    vline(page, x + w, yTop, h, 1.2);
    const rows = [
        ['工事名称', '○○ビル新築工事'],
        ['図面名称', '平面詳細図'],
        ['縮尺', 'S=1:50'],
        ['図面番号', 'A-201'],
        ['作成日', '2026.09.01'],
    ];
    // The divider between label and value is a real vertical rule, because a
    // title block that has one is the hard case: it is then a closed ruled
    // grid, structurally indistinguishable from a two-column schedule.
    vline(page, x + 74, yTop, h, 0.5);
    let y = yTop + 8;
    for (const [k, v] of rows) {
        page.drawText(k, { x: x + 6, y: A4_H - (y + 8), size: 7, font, color: rgb(0, 0, 0) });
        page.drawText(v, { x: x + 80, y: A4_H - (y + 8), size: 7, font, color: rgb(0, 0, 0) });
        hline(page, x, y + 12, w, 0.5);
        y += 20;
    }
}

function drawLegend(page, font) {
    let y = 120;
    page.drawText('凡例 / LEGEND', { x: 60, y: A4_H - y, size: 10, font, color: rgb(0, 0, 0) });
    y += 18;
    const items = [
        ['■', 'コンクリート', 'CONCRETE'],
        ['□', '断熱材', 'INSULATION'],
        ['▲', '既存撤去', 'DEMOLITION'],
        ['●', '新設', 'NEW'],
        ['◆', '仮設', 'TEMPORARY'],
    ];
    for (const [sym, ja, en] of items) {
        page.drawText(sym, { x: 60, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        page.drawText(ja, { x: 82, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        page.drawText(en, { x: 180, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        y += 15;
    }
}

function drawKeynotes(page, font) {
    let y = 260;
    page.drawText('キーノート', { x: 60, y: A4_H - y, size: 10, font, color: rgb(0, 0, 0) });
    y += 18;
    const notes = [
        ['01', '既存壁を撤去し新規間仕切とする'],
        ['02', '床レベル差はスロープにて処理'],
        ['03', '天井内配管は別図参照'],
        ['04', '外部建具はアルミ製とする'],
        ['05', '塗装色は別途指示による'],
        ['06', '防火区画貫通部は認定工法とする'],
    ];
    for (const [n, text] of notes) {
        page.drawText(n, { x: 60, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        page.drawText(text, { x: 90, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
        y += 14;
    }
}

function drawGrid(page, font) {
    // A structural column grid: long lines, bubbles, single-character labels.
    const left = 70, top = 430, cell = 70, cols = 6, rows = 4;
    for (let c = 0; c <= cols; c++) {
        vline(page, left + c * cell, top, rows * cell, 0.4);
        page.drawText(String.fromCharCode(65 + c), {
            x: left + c * cell - 2, y: A4_H - (top - 8), size: 8, font, color: rgb(0, 0, 0),
        });
    }
    for (let r = 0; r <= rows; r++) {
        hline(page, left, top + r * cell, cols * cell, 0.4);
        page.drawText(String(r + 1), { x: left - 12, y: A4_H - (top + r * cell + 3), size: 8, font, color: rgb(0, 0, 0) });
    }
    // Column symbols at the intersections.
    for (let c = 0; c <= cols; c++) {
        for (let r = 0; r <= rows; r++) {
            page.drawRectangle({
                x: left + c * cell - 4, y: A4_H - (top + r * cell) - 4,
                width: 8, height: 8, color: rgb(0, 0, 0),
            });
        }
    }
}

function drawDimensions(page, font) {
    // Dimension strings: numbers on a line, evenly spaced. Column-like, and
    // meaningless as a grid.
    const y = 380;
    hline(page, 70, y, 420, 0.4);
    const dims = ['6,000', '6,000', '6,000', '6,000', '6,000', '6,000', '6,000'];
    dims.forEach((d, i) => {
        page.drawText(d, { x: 74 + i * 60, y: A4_H - (y - 4), size: 7, font, color: rgb(0, 0, 0) });
        vline(page, 70 + i * 60, y - 6, 12, 0.4);
    });
    page.drawText('42,000', { x: 250, y: A4_H - (y + 16), size: 7, font, color: rgb(0, 0, 0) });
}

function drawRoomLabels(page, font) {
    // Room names scattered across a plan: aligned by accident, not by grid.
    const labels = [
        ['事務室', 110, 500], ['A=120.5m2', 110, 512],
        ['会議室', 300, 470], ['A=48.0m2', 300, 482],
        ['倉庫', 430, 560], ['A=22.0m2', 430, 572],
        ['EV', 200, 600], ['階段', 260, 620],
        ['便所', 380, 640], ['PS', 450, 660],
    ];
    for (const [text, x, y] of labels) {
        page.drawText(text, { x, y: A4_H - y, size: 8, font, color: rgb(0, 0, 0) });
    }
}

function drawBorder(page) {
    hline(page, 20, 20, A4_W - 40, 1.5);
    hline(page, 20, A4_H - 20, A4_W - 40, 1.5);
    vline(page, 20, 20, A4_H - 40, 1.5);
    vline(page, A4_W - 20, 20, A4_H - 40, 1.5);
}

function drawNoteColumns(page, font) {
    // Two aligned columns of free text. Genuinely column-shaped, genuinely
    // not a table: the two columns are independent notes, not paired cells.
    const left = ['注記', '1. 寸法は mm とする', '2. 記載なき納まりは', '   標準詳細による', '3. 疑義は監理者に確認'];
    const right = ['NOTES', '1. Dimensions in mm', '2. Refer to standard', '   details if not shown', '3. Confirm with architect'];
    drawLines(page, font, 70, 150, left, 8, 1.6);
    drawLines(page, font, 320, 150, right, 8, 1.6);
}

function drawKeyPlan(page, font) {
    const x = 430, y = 120, s = 120;
    hline(page, x, y, s, 0.6); hline(page, x, y + s, s, 0.6);
    vline(page, x, y, s, 0.6); vline(page, x + s, y, s, 0.6);
    hline(page, x, y + s / 2, s, 0.4); vline(page, x + s / 2, y, s, 0.4);
    page.drawRectangle({ x, y: A4_H - (y + s / 2), width: s / 2, height: s / 2, color: rgb(0.85, 0.85, 0.85) });
    page.drawText('KEY PLAN', { x: x + 30, y: A4_H - (y - 6), size: 7, font, color: rgb(0, 0, 0) });
    page.drawText('N', { x: x + s + 6, y: A4_H - (y + 10), size: 7, font, color: rgb(0, 0, 0) });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const written = [];

/** Write a PDF and the answer key that goes with it. */
async function write(name, doc, truth) {
    const bytes = await doc.save();
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    fs.writeFileSync(path.join(OUT, `${name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
    written.push({ name, bytes: bytes.length, pages: truth.pages.length, tables: truth.pages.reduce((n, p) => n + p.tables.length, 0) });
}

async function newDoc() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    stamp(doc);
    const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
    return { doc, font };
}

const nativePage = (doc) => doc.addPage([A4_W, A4_H]);

// --- positive: A ruled-simple ------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['仕上表 / FINISH SCHEDULE'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: SIMPLE.colWidths, rowHeights: SIMPLE.rowHeights, cells: SIMPLE.cells });
    await write('native-ruled-simple', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: B ruled, mixed value types, fragmented runs -------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['数量表 / QUANTITY TABLE'], 14);
    const table = drawTable(page, font, {
        x: 60, yTop: 110, colWidths: MIXED_TYPES.colWidths, rowHeights: MIXED_TYPES.rowHeights,
        cells: MIXED_TYPES.cells, fragment: true,
    });
    await write('native-ruled-mixed-types', doc, {
        kind: 'positive', source: 'native', note: 'cell text is split into two runs, as a CAD-produced PDF does',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: C borderless --------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['仕上表（罫線なし）'], 14);
    const table = drawTable(page, font, {
        x: 60, yTop: 110, colWidths: SIMPLE.colWidths, rowHeights: SIMPLE.rowHeights,
        cells: SIMPLE.cells, ruled: false,
    });
    await write('native-borderless-aligned', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: D blank cells -------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['建具表 / DOOR & WINDOW'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: BLANKS.colWidths, rowHeights: BLANKS.rowHeights, cells: BLANKS.cells });
    await write('native-blank-cells', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: E multiline cells ---------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['特記事項'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: MULTILINE.colWidths, rowHeights: MULTILINE.rowHeights, cells: MULTILINE.cells });
    await write('native-multiline-cell', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: F merged header ------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['室別仕上・面積表'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: MERGED_HEADER.colWidths, rowHeights: MERGED_HEADER.rowHeights, cells: MERGED_HEADER.cells });
    await write('native-merged-header', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: G sparse --------------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['系統別対応表'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: SPARSE.colWidths, rowHeights: SPARSE.rowHeights, cells: SPARSE.cells });
    await write('native-sparse-table', doc, {
        kind: 'positive', source: 'native',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

// --- positive: rotated page ----------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLines(page, font, 60, 60, ['仕上表（90度回転ページ）'], 14);
    const table = drawTable(page, font, { x: 60, yTop: 110, colWidths: SIMPLE.colWidths, rowHeights: SIMPLE.rowHeights, cells: SIMPLE.cells });
    page.setRotation(degrees(90));
    await write('native-rotated-90', doc, {
        kind: 'positive', source: 'native',
        note: 'rects are in the rotated display space the viewer shows, so the answer key and the probe speak one language',
        pages: [{ page: 1, rotate: 90, width: A4_H, height: A4_W, tables: [rotateTruth90(table)] }],
    });
}

// --- positive: H scanned -------------------------------------------------------
{
    const { doc } = await newDoc();
    const { png, truth } = await rasterTable(browser, { ...SIMPLE });
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('scanned-ruled-simple', doc, {
        kind: 'positive', source: 'scanned',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [truth] }],
    });
}

// --- positive: I scanned, skewed and noisy -------------------------------------
{
    const { doc } = await newDoc();
    const { png, truth } = await rasterTable(browser, { ...SIMPLE, skewDeg: 3, speckle: 0.0016 });
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('scanned-skew-noisy-table', doc, {
        kind: 'positive', source: 'scanned',
        note: 'cell rects are pre-skew: the sheet is rotated 3 degrees about its centre',
        skewDeg: 3,
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [truth] }],
    });
}

// --- positive: the same scan at twice the resolution -------------------------
{
    const { doc } = await newDoc();
    const { png, truth } = await rasterTable(browser, { ...SIMPLE, scan: 2 });
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('scanned-ruled-hires', doc, {
        kind: 'positive', source: 'scanned', note: 'same sheet, scanned at 2x -- the control for "is 150 DPI simply too coarse"',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [truth] }],
    });
}

// --- positive: scanned without ruling lines ------------------------------------
{
    const { doc } = await newDoc();
    const { png, truth } = await rasterTable(browser, { ...SIMPLE, ruled: false });
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('scanned-borderless-simple', doc, {
        kind: 'positive', source: 'scanned', note: 'the control for "does the ruled box itself stop the recogniser"',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [truth] }],
    });
}

// --- positive: J mixed document -------------------------------------------------
{
    const { doc, font } = await newDoc();
    const p1 = nativePage(doc);
    drawLines(p1, font, 60, 60, ['仕上表 / FINISH SCHEDULE'], 14);
    const t1 = drawTable(p1, font, { x: 60, yTop: 110, colWidths: SIMPLE.colWidths, rowHeights: SIMPLE.rowHeights, cells: SIMPLE.cells });

    const { png, truth: t2 } = await rasterTable(browser, { ...MIXED_TYPES });
    const image = await doc.embedPng(png);
    const p2 = doc.addPage([A4_W, A4_H]);
    p2.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });

    const p3 = nativePage(doc);
    drawBorder(p3);
    drawTitleBlock(p3, font);
    drawRoomLabels(p3, font);
    drawGrid(p3, font);

    await write('mixed-document', doc, {
        kind: 'mixed', source: 'mixed',
        pages: [
            { page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [t1] },
            { page: 2, rotate: 0, width: A4_W, height: A4_H, tables: [t2] },
            { page: 3, rotate: 0, width: A4_W, height: A4_H, tables: [] },
        ],
    });
}

// --- adversarial: title block ----------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawBorder(page);
    drawTitleBlock(page, font);
    await write('adv-title-block', doc, {
        kind: 'adversarial', source: 'native', why: 'ruled label/value box in the sheet corner',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: legend -----------------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawLegend(page, font);
    await write('adv-legend', doc, {
        kind: 'adversarial', source: 'native', why: 'three aligned columns of symbol/JA/EN',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: keynote list ------------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawKeynotes(page, font);
    await write('adv-keynote-list', doc, {
        kind: 'adversarial', source: 'native', why: 'numbered notes: two aligned columns, one of them prose',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: dimensions + grid ---------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawBorder(page);
    drawGrid(page, font);
    drawDimensions(page, font);
    await write('adv-grid-dimensions', doc, {
        kind: 'adversarial', source: 'native', why: 'a column grid is a literal grid of ruled lines',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: room labels ------------------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawBorder(page);
    drawRoomLabels(page, font);
    drawKeyPlan(page, font);
    await write('adv-room-labels', doc, {
        kind: 'adversarial', source: 'native', why: 'labels scattered over a plan, incidentally aligned',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: aligned note columns -----------------------------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawNoteColumns(page, font);
    await write('adv-note-columns', doc, {
        kind: 'adversarial', source: 'native', why: 'two independent columns of prose, aligned',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: everything at once, as a real sheet looks --------------------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawBorder(page);
    drawTitleBlock(page, font);
    drawGrid(page, font);
    drawDimensions(page, font);
    drawRoomLabels(page, font);
    drawLegend(page, font);
    drawKeynotes(page, font);
    drawKeyPlan(page, font);
    drawNoteColumns(page, font);
    await write('adv-full-sheet', doc, {
        kind: 'adversarial', source: 'native', why: 'a complete drawing sheet with no schedule on it',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial: scanned drawing sheet ------------------------------------------------------
{
    const { doc } = await newDoc();
    const png = await rasterSheet(browser, `
      <div style="padding:80px 70px">
        <div style="border:3px solid #000;height:900px;position:relative">
          <div style="position:absolute;right:20px;bottom:20px;border:2px solid #000;width:420px">
            <div style="border-bottom:1px solid #000;padding:6px 10px;font-size:20px">工事名称　○○ビル新築工事</div>
            <div style="border-bottom:1px solid #000;padding:6px 10px;font-size:20px">図面名称　平面詳細図</div>
            <div style="border-bottom:1px solid #000;padding:6px 10px;font-size:20px">縮尺　S=1:50</div>
            <div style="padding:6px 10px;font-size:20px">図面番号　A-201</div>
          </div>
          <div style="position:absolute;left:60px;top:60px;font-size:22px">事務室</div>
          <div style="position:absolute;left:60px;top:92px;font-size:18px">A=120.5m2</div>
          <div style="position:absolute;left:380px;top:200px;font-size:22px">会議室</div>
          <div style="position:absolute;left:380px;top:232px;font-size:18px">A=48.0m2</div>
          <div style="position:absolute;left:60px;top:420px;font-size:18px">6,000　6,000　6,000　6,000</div>
        </div>
      </div>`, { speckle: 0.0012 });
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    await write('adv-scanned-sheet', doc, {
        kind: 'adversarial', source: 'scanned', why: 'the same trap, but only OCR boxes to judge it from',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [] }],
    });
}

// --- adversarial-positive: a real table sharing a page with a drawing -----------------------
{
    const { doc, font } = await newDoc();
    const page = nativePage(doc);
    drawBorder(page);
    drawTitleBlock(page, font);
    drawGrid(page, font);
    drawRoomLabels(page, font);
    const table = drawTable(page, font, {
        x: 60, yTop: 110, colWidths: SIMPLE.colWidths, rowHeights: SIMPLE.rowHeights, cells: SIMPLE.cells,
    });
    await write('mixed-table-and-drawing', doc, {
        kind: 'mixed', source: 'native',
        why: 'one real schedule and a sheet full of table-shaped content around it',
        pages: [{ page: 1, rotate: 0, width: A4_W, height: A4_H, tables: [table] }],
    });
}

await browser.close();

const totalTables = written.reduce((n, w) => n + w.tables, 0);
console.log(`\n  wrote ${written.length} fixtures to test-fixtures/m2-4/  (${totalTables} ground-truth tables)\n`);
for (const w of written) {
    console.log(`  ${w.name.padEnd(30)} ${String(w.pages).padStart(2)}p  ${String(w.tables).padStart(2)} tables  ${String(w.bytes).padStart(8)} bytes`);
}
console.log('');
