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
 *   text-with-blank-page.pdf  text-native, entirely blank, text-native
 *
 * For OCR preprocessing (M2-2). Every one of these is deterministic: the skew
 * is a fixed CSS rotation and the noise comes from a seeded generator, so a
 * measured improvement is a property of the algorithm and not of the run.
 *
 *   scanned-skew-plus-1.pdf   +1 degree
 *   scanned-skew-minus-1.pdf  -1 degree
 *   scanned-skew-plus-3.pdf   +3 degrees
 *   scanned-skew-minus-3.pdf  -3 degrees
 *   scanned-skew-tiny.pdf     +0.1 degrees -- must NOT be "corrected"
 *   scanned-skew-ja.pdf       +2 degrees, Japanese only
 *   scanned-skew-en.pdf       +2 degrees, English only
 *   scanned-noisy.pdf         light speckle
 *   scanned-noisy-heavy.pdf   heavier speckle
 *   scanned-skew-noisy.pdf    +3 degrees and speckle together
 *   scanned-sparse.pdf        two short words -- too little to judge an angle from
 *   scanned-blank.pdf         an empty sheet
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
const pageHtml = (lines, sideways = false, skewDeg = 0) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: "M"; src: url("file://${FONT.replace(/\\/g, '/')}") format("truetype"); }
  html, body { margin:0; padding:0; background:#fff; }
  body { width:${PX_W}px; height:${PX_H}px; font-family:"M",sans-serif; color:#000; }
  .s { padding:140px 110px; }
  h1 { font-size:66px; margin:0 0 52px; font-weight:400; }
  p  { font-size:46px; margin:0 0 34px; }
  .r { border:3px solid #000; height:300px; margin-top:60px; }
  .rot { width:${PX_H}px; height:${PX_W}px; transform-origin:0 0; transform:translateY(${PX_H}px) rotate(-90deg); }
  /* A sheet fed in slightly crooked: the whole page turns a degree or two
     about its centre, exactly as it would on a flatbed. */
  .skew { width:${PX_W}px; height:${PX_H}px; transform-origin:50% 50%; transform:rotate(${skewDeg}deg); }
</style></head><body>
  <div class="${skewDeg ? 'skew' : ''}"><div class="${sideways ? 'rot' : ''}"><div class="s">
  ${lines.map((l, i) => (i === 0 ? `<h1>${l}</h1>` : `<p>${l}</p>`)).join('\n  ')}
  ${lines.filter(Boolean).length > 1 ? '<div class="r"></div>' : ''}
</div></div></div></body></html>`;

/**
 * Seeded speckle, applied to the rendered sheet.
 *
 * Deterministic on purpose. Noise reduction has to be judged by whether it
 * helped, and that judgement is worthless if the noise is different every run,
 * so the generator is a fixed-seed mulberry32 and the same fixture comes out
 * byte-for-byte identical each time.
 *
 * The model is scanner speckle rather than a general blur: isolated dark
 * pixels, a few two- and three-pixel clumps, and light grey grain. That is what
 * a real scan of a drawing carries, and it is the case a conservative filter
 * should be able to clear without touching a thin stroke.
 */
async function addSpeckle(browser, pngBuffer, seed, density) {
    const page = await browser.newPage();
    await page.setViewport({ width: 32, height: 32, deviceScaleFactor: 1 });
    await page.goto('about:blank');
    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    const out = await page.evaluate(async (src, seedValue, densityValue) => {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = src;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
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
            if (roll < 0.72) {
                set(x, y, 0);                       // a single dark pixel
            } else if (roll < 0.93) {
                set(x, y, 0); set(x + 1, y, 0);     // a two-pixel clump
            } else {
                set(x, y, 0); set(x + 1, y, 0); set(x, y + 1, 0);
            }
        }
        // Light grey grain over the whole sheet, well above the ink threshold so
        // it does not read as text to anything downstream.
        const grain = Math.round(canvas.width * canvas.height * densityValue * 1.5);
        for (let n = 0; n < grain; n++) {
            const x = Math.floor(rand() * canvas.width);
            const y = Math.floor(rand() * canvas.height);
            const i = (y * canvas.width + x) * 4;
            if (d[i] > 200) set(x, y, 200 + Math.floor(rand() * 40));
        }

        ctx.putImageData(data, 0, 0);
        return canvas.toDataURL('image/png');
    }, dataUrl, seed, density);
    await page.close();
    return Buffer.from(out.split(',')[1], 'base64');
}

async function raster(browser, lines, tag, sideways = false, skewDeg = 0) {
    const file = path.join(OUT, `_tmp-${tag}.html`);
    fs.writeFileSync(file, pageHtml(lines, sideways, skewDeg), 'utf8');
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

/**
 * Fixed metadata, so the same inputs give the same bytes.
 *
 * pdf-lib stamps a creation and modification date by default, which made every
 * fixture differ from the last run even when nothing about the page had
 * changed. A gate that measures "did preprocessing help" needs the input to be
 * the same file every time, or the comparison is against a moving target.
 */
const EPOCH = new Date(0);

const write = async (doc, name) => {
    doc.setCreationDate(EPOCH);
    doc.setModificationDate(EPOCH);
    doc.setProducer('PDF ArchiTools test fixtures');
    doc.setCreator('PDF ArchiTools test fixtures');
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

// A sheet with nothing on it at all, between two text pages. Real drawing sets
// carry these -- a separator, a page that failed to scan -- and a text export
// must still show that the page was there rather than quietly renumbering.
{
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: false });
    await addTextPage(doc, font, TEXT_LINES);
    doc.addPage([A4_W, A4_H]);
    await addTextPage(doc, font, [['最終ページ Final Page', 20], ['This page is text-native too.', 12]]);
    results.push(['text-with-blank-page.pdf', await write(doc, 'text-with-blank-page.pdf')]);
}

// ---- OCR preprocessing fixtures (M2-2) -------------------------------------
// Known angles, so a detector can be judged against the truth rather than
// against whether the OCR happened to improve.
for (const [name, deg, lines, tag] of [
    ['scanned-skew-plus-1.pdf', 1, MIX, 'sk+1'],
    ['scanned-skew-minus-1.pdf', -1, MIX, 'sk-1'],
    ['scanned-skew-plus-3.pdf', 3, MIX, 'sk+3'],
    ['scanned-skew-minus-3.pdf', -3, MIX, 'sk-3'],
    // Straight enough that correcting it would be the mistake.
    ['scanned-skew-tiny.pdf', 0.1, MIX, 'sk01'],
    ['scanned-skew-ja.pdf', 2, JA, 'skja'],
    ['scanned-skew-en.pdf', 2, EN, 'sken'],
]) {
    const doc = await PDFDocument.create();
    await addScanPage(doc, await raster(browser, lines, tag, false, deg));
    results.push([name, await write(doc, name)]);
}

// Speckled sheets. The clean raster is generated once and dirtied, so the only
// difference from scanned-ja-en.pdf is the noise itself.
{
    const clean = await raster(browser, MIX, 'noisebase');
    for (const [name, seed, density] of [
        ['scanned-noisy.pdf', 20260905, 0.0008],
        ['scanned-noisy-heavy.pdf', 20260906, 0.0035],
    ]) {
        const doc = await PDFDocument.create();
        await addScanPage(doc, await addSpeckle(browser, clean, seed, density));
        results.push([name, await write(doc, name)]);
    }

    const skewed = await raster(browser, MIX, 'skewnoise', false, 3);
    const doc = await PDFDocument.create();
    await addScanPage(doc, await addSpeckle(browser, skewed, 20260907, 0.0008));
    results.push(['scanned-skew-noisy.pdf', await write(doc, 'scanned-skew-noisy.pdf')]);
}

// Too little ink to judge an angle from, and none at all. Both must come back
// as "no idea", not as some arbitrary number.
{
    const doc = await PDFDocument.create();
    await addScanPage(doc, await raster(browser, ['A1'], 'sparse'));
    results.push(['scanned-sparse.pdf', await write(doc, 'scanned-sparse.pdf')]);
}
{
    const doc = await PDFDocument.create();
    await addScanPage(doc, await raster(browser, [], 'blank'));
    results.push(['scanned-blank.pdf', await write(doc, 'scanned-blank.pdf')]);
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
