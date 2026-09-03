/**
 * Populate public/ocr/ with the OCR runtime assets.
 *
 * These are committed rather than fetched at run time, because the Textifier
 * must work without contacting any third party: no unpkg, no jsDelivr, no CDN.
 * Everything the OCR path loads has to come from our own origin.
 *
 * The Tesseract worker and WASM cores are copied out of node_modules so they
 * always match the installed tesseract.js. The language data and the font are
 * downloaded once from their canonical upstreams.
 *
 * Run after changing the tesseract.js version:  node scripts/setup-ocr-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'ocr');

const DIRS = ['tesseract', 'tessdata', 'fonts'];

// Only the LSTM cores: the pipeline runs oem=1. tesseract.js feature-detects at
// run time and requests exactly one of these, so all three variants must exist
// or the detected one 404s and the worker fails with a bare "OCR worker failed".
const COPY = [
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/tesseract-core-lstm.wasm.js'],
];

const DOWNLOAD = [
  // Apache-2.0, straight from upstream rather than a re-packaging mirror.
  ['https://github.com/tesseract-ocr/tessdata_fast/raw/main/jpn.traineddata', 'tessdata/jpn.traineddata'],
  ['https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata', 'tessdata/eng.traineddata'],
  // OFL-1.1. Smallest static-weight Japanese TrueType we found; see docs.
  ['https://github.com/google/fonts/raw/main/ofl/mplus1p/MPLUS1p-Regular.ttf', 'fonts/MPLUS1p-Regular.ttf'],
  ['https://github.com/google/fonts/raw/main/ofl/mplus1p/OFL.txt', 'fonts/OFL.txt'],
];

for (const d of DIRS) fs.mkdirSync(path.join(OUT, d), { recursive: true });

for (const [from, to] of COPY) {
  const src = path.join(ROOT, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error(`  MISSING ${from} - run npm install first`);
    process.exitCode = 1;
    continue;
  }
  const dest = path.join(OUT, to);
  fs.copyFileSync(src, dest);
  console.log(`  copy  public/ocr/${to}  (${fs.statSync(dest).size} bytes)`);
}

for (const [url, to] of DOWNLOAD) {
  const dest = path.join(OUT, to);
  if (fs.existsSync(dest)) {
    console.log(`  have  public/ocr/${to}  (${fs.statSync(dest).size} bytes)`);
    continue;
  }
  process.stdout.write(`  get   public/ocr/${to} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAILED ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`${fs.statSync(dest).size} bytes`);
}

console.log('\nDone. These files must be committed - the app loads them same-origin.');
