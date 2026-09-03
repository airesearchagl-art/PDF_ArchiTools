/**
 * Generate the synthetic PDFs the Textifier smoke test runs against.
 *
 * Everything here is written from text we control and rendered with the OFL
 * font already shipped for OCR. No customer document is ever used, and nothing
 * generated here is committed.
 *
 *   text-native-ja-en.pdf   real embedded text -> must never reach the OCR engine
 *   scanned-en.pdf          image-only, English
 *   scanned-ja.pdf          image-only, Japanese
 *   scanned-ja-en.pdf       image-only, mixed
 *   mixed-multipage.pdf     text-native, scanned, text-native
 *   scanned-rotated.pdf     image-only page carrying /Rotate 90
 *
 * Run:  node scripts/make-test-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures');
const FONT = path.join(ROOT, 'public', 'ocr', 'fonts', 'MPLUS1p-Regular.ttf');

const A4_W = 595.28;
const A4_H = 841.89;
const PX_W = 1240;
const PX_H = 1754;

if (!fs.existsSync(FONT)) {
    console.error(`Missing ${FONT} - run node scripts/setup-ocr-assets.mjs first.`);
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/**
 * `sideways` renders the same sheet turned a quarter turn inside a portrait
 * frame. Combined with /Rotate 90 on the page, a viewer shows it upright --
 * which is what a sheet fed into the scanner sideways actually looks like.
 * Done in CSS rather than with pdf-lib's rotate, so the geometry is explicit
 * and does not depend on which way pdf-lib measures a positive angle.
 */
const pageHtml = (lines, sideways = false) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
  html, body { margin:0; padding:0; background:#fff; }
  body { width:${PX_W}px; height:${PX_H}px; font-family:"M",sans-serif; color:#000; }
  .s { padding:140px 110px; }
  h1 { font-size:66px; margin:0 0 52px; font-weight:400; }
  p  { font-size:46px; margin:0 0 34px; }
  .r { border:3px solid #000; height:300px; margin-top:60px; }
  .rot { width:${PX_H}px; height:${PX_W}px; transform-origin:0 0; transform:translateY(${PX_H}px) rotate(-90deg); }
</style></head><body>
  <div class="${sideways ? 'rot' : ''}"><div class="s">
  ${lines.map((l, i) => (i === 0 ? `<h1>${l}</h1>` : `<p>${l}</p>`)).join('\n  ')}
  <div class="r"></div>
</div></div></body></html>`;

async function raster(browser, lines, tag, sideways = false) {
    const file = path.join(OUT, `_tmp-${tag}.html`);
    fs.writeFileSync(file, pageHtml(lines, sideways), 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ width: PX_W, height: PX_H, deviceScaleFactor: 1 });
    await page.goto(`file://${file.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: PX_W, height: PX_H } });
    await page.close();
    fs.unlinkSync(file);
    return png;
}

/** Draw real text with an embedded font, so the page is genuinely text-native. */
async function addTextPage(doc, font, lines) {
    const page = doc.addPage([A4_W, A4_H]);
    let y = A4_H - 120;
    for (const [text, size] of lines) {
        page.drawText(text, { x: 60, y, size, font, color: rgb(0, 0, 0) });
        y -= size * 2.4;
    }
    page.drawRectangle({ x: 60, y: y - 240, width: A4_W - 120, height: 220, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    return page;
}

/** A page whose only content is a raster, exactly what a scanner produces. */
async function addScanPage(doc, png) {
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    return page;
}

const write = async (doc, name) => {
    const bytes = await doc.save();
    fs.writeFileSync(path.join(OUT, name), bytes);
    return bytes.length;
};

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const fontBytes = fs.readFileSync(FONT);
const results = [];

const JA = ['建築図面', '第一版 平面図', '株式会社 設計事務所'];
const EN = ['Architectural Drawing', 'Version 1 Floor Plan', 'Design Office Inc.'];
const MIX = ['建築図面 Architectural Drawing', '第一版 Version 1', '平面図 Floor Plan'];

const TEXT_LINES = [
    ['建築図面 Architectural Drawing', 22],
    ['第一版 / Version 1', 16],
    ['平面図 Floor Plan', 16],
    ['This page has real embedded text and must not be OCR processed.', 12],
    ['このページには本物のテキストが埋め込まれています。', 12],
];

// text-native
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: false });
    await addTextPage(doc, font, TEXT_LINES);
    results.push(['text-native-ja-en.pdf', await write(doc, 'text-native-ja-en.pdf')]);
}

// single-page scans
for (const [name, lines, tag] of [
    ['scanned-en.pdf', EN, 'en'],
    ['scanned-ja.pdf', JA, 'ja'],
    ['scanned-ja-en.pdf', MIX, 'mix'],
]) {
    const doc = await PDFDocument.create();
    await addScanPage(doc, await raster(browser, lines, tag));
    results.push([name, await write(doc, name)]);
}

// mixed: text-native, scanned, text-native
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: false });
    await addTextPage(doc, font, TEXT_LINES);
    await addScanPage(doc, await raster(browser, MIX, 'mixpage'));
    await addTextPage(doc, font, [['最終ページ Final Page', 20], ['This page is text-native too.', 12]]);
    results.push(['mixed-multipage.pdf', await write(doc, 'mixed-multipage.pdf')]);
}

// rotated scan: the image is laid down turned a quarter turn and the page then
// carries /Rotate 90, so a viewer shows it upright -- what a sideways-scanned
// sheet actually looks like. The text layer has to follow that rotation.
{
    const doc = await PDFDocument.create();
    const png = await raster(browser, MIX, 'rot', true);
    const image = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    // Drawn plainly, full bleed. All the turning lives in the raster and in
    // /Rotate, so nothing here depends on pdf-lib's rotation convention.
    page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H });
    page.setRotation(degrees(90));
    results.push(['scanned-rotated.pdf', await write(doc, 'scanned-rotated.pdf')]);
}

await browser.close();

console.log('Generated fixtures in test-fixtures/:');
for (const [name, size] of results) console.log(`  ${name.padEnd(24)} ${String(size).padStart(9)} bytes`);
