/**
 * Phase 1 spike — synthetic fixture generator.
 *
 * Builds the test PDFs the OCR spike runs against. No real customer document is
 * ever used (see brief section 16). Everything here is generated from text we
 * write ourselves, rendered with an OFL-1.1 licensed font.
 *
 *   text-native-ja-en.pdf   real embedded text, Japanese + English -> must NOT be OCR'd
 *   scanned-ja.pdf          image-only page, Japanese
 *   scanned-en.pdf          image-only page, English
 *   scanned-ja-en.pdf       image-only page, mixed
 *   scanned-multipage.pdf   3 image-only pages
 *
 * "Scanned" pages are produced by rendering HTML to a raster in a real browser
 * and embedding that raster as the page's only content, so the page genuinely
 * has no text objects at all -- the same thing a scanner produces.
 *
 * Run:  node spike/make-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, 'assets');
const FIXTURES = path.join(HERE, 'fixtures');
const FONT = path.join(ASSETS, 'MPLUS1p-Regular.ttf');

// A4 in PDF points, and the raster size we render "scans" at (~150 DPI).
const A4_W = 595.28, A4_H = 841.89;
const PX_W = 1240, PX_H = 1754;

if (!fs.existsSync(FONT)) {
  console.error(`Missing font: ${FONT}\nRun spike/fetch-assets.mjs first.`);
  process.exit(1);
}
fs.mkdirSync(FIXTURES, { recursive: true });

/** Known text content of each fixture, so the spike can assert on it later. */
export const EXPECTED = {
  ja: ['建築図面', '第一版', '平面図'],
  en: ['Architectural Drawing', 'Version 1', 'Floor Plan'],
};

const pageHtml = (lines, note) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: "MPLUS1p"; src: url("../assets/MPLUS1p-Regular.ttf") format("truetype"); }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${PX_W}px; height: ${PX_H}px; font-family: "MPLUS1p", sans-serif; color: #000; }
  .sheet { padding: 120px 100px; }
  h1 { font-size: 64px; margin: 0 0 48px; font-weight: 400; }
  p  { font-size: 44px; margin: 0 0 32px; line-height: 1.5; }
  .note { font-size: 30px; color: #444; margin-top: 64px; }
  .rule { border: 3px solid #000; height: 320px; margin-top: 56px; }
</style></head>
<body><div class="sheet">
  ${lines.map((l, i) => (i === 0 ? `<h1>${l}</h1>` : `<p>${l}</p>`)).join('\n  ')}
  <div class="rule"></div>
  ${note ? `<div class="note">${note}</div>` : ''}
</div></body></html>`;

/** Render one HTML page to a PNG buffer using a real browser. */
async function raster(browser, html, name) {
  const file = path.join(FIXTURES, `_tmp-${name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const page = await browser.newPage();
  await page.setViewport({ width: PX_W, height: PX_H, deviceScaleFactor: 1 });
  await page.goto(`file://${file.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: PX_W, height: PX_H } });
  await page.close();
  fs.unlinkSync(file);
  return png;
}

/** Build an image-only PDF: each page's sole content is one embedded raster. */
async function scannedPdf(pngs, out) {
  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const img = await doc.embedPng(png);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(img, { x: 0, y: 0, width: A4_W, height: A4_H });
  }
  const bytes = await doc.save();
  fs.writeFileSync(path.join(FIXTURES, out), bytes);
  return bytes.length;
}

/** Build a genuinely text-native PDF with real embedded Japanese + English text. */
async function textNativePdf(out) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // subset:false deliberately -- see the architecture report on the known CJK
  // subsetting bug in @pdf-lib/fontkit 1.1.1. The spike measures both paths.
  const font = await doc.embedFont(fs.readFileSync(FONT), { subset: false });
  const page = doc.addPage([A4_W, A4_H]);
  const lines = [
    ['建築図面 — Architectural Drawing', 22],
    ['第一版 / Version 1', 16],
    ['平面図 Floor Plan', 16],
    ['This page has real embedded text. It must not be OCR processed.', 12],
    ['このページには本物のテキストが埋め込まれています。', 12],
  ];
  let y = A4_H - 110;
  for (const [text, size] of lines) {
    page.drawText(text, { x: 60, y, size, font, color: rgb(0, 0, 0) });
    y -= size * 2.4;
  }
  page.drawRectangle({ x: 60, y: y - 260, width: A4_W - 120, height: 240, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  const bytes = await doc.save();
  fs.writeFileSync(path.join(FIXTURES, out), bytes);
  return bytes.length;
}

const browser = await puppeteer.launch({ headless: true });
const results = [];

results.push(['text-native-ja-en.pdf', await textNativePdf('text-native-ja-en.pdf')]);

const jaLines  = ['建築図面', '第一版 平面図', '株式会社 設計事務所'];
const enLines  = ['Architectural Drawing', 'Version 1 Floor Plan', 'Design Office Inc.'];
const mixLines = ['建築図面 Architectural Drawing', '第一版 Version 1', '平面図 Floor Plan'];

results.push(['scanned-ja.pdf',    await scannedPdf([await raster(browser, pageHtml(jaLines,  'スキャン画像として保存されたページ'), 'ja')],  'scanned-ja.pdf')]);
results.push(['scanned-en.pdf',    await scannedPdf([await raster(browser, pageHtml(enLines,  'Saved as a scanned raster page'),      'en')],  'scanned-en.pdf')]);
results.push(['scanned-ja-en.pdf', await scannedPdf([await raster(browser, pageHtml(mixLines, '日本語と English の混在'),             'mix')], 'scanned-ja-en.pdf')]);

const multi = [];
for (let i = 1; i <= 3; i++) {
  multi.push(await raster(browser, pageHtml(
    [`建築図面 Page ${i}`, `第 ${i} 葉 Sheet ${i}`, 'Floor Plan 平面図'],
    `Page ${i} of 3`), `mp${i}`));
}
results.push(['scanned-multipage.pdf', await scannedPdf(multi, 'scanned-multipage.pdf')]);

await browser.close();

console.log('Generated fixtures in spike/fixtures:');
for (const [name, size] of results) console.log(`  ${name.padEnd(26)} ${String(size).padStart(9)} bytes`);
