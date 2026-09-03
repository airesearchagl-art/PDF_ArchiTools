/**
 * Phase 1 spike — fetch the large binary assets the spike needs.
 *
 * These are deliberately NOT committed: together they are ~18 MB of font, WASM
 * and OCR language data. Run this once before spike/make-fixtures.mjs and
 * spike/run-spike.mjs.
 *
 * Everything fetched here is permissively licensed and pulled from its canonical
 * upstream, not from a re-packaging mirror:
 *   M PLUS 1p Regular   OFL-1.1     google/fonts
 *   jpn/eng traineddata Apache-2.0  tesseract-ocr/tessdata_fast
 *
 * The Tesseract worker and core WASM are copied out of node_modules rather than
 * downloaded, so they always match the installed tesseract.js version.
 *
 * Run:  node spike/fetch-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ASSETS = path.join(HERE, 'assets');
const PUB_TESS = path.join(ROOT, 'public', 'tesseract');
const PUB_DATA = path.join(ROOT, 'public', 'tessdata');

const DOWNLOADS = [
  ['https://github.com/google/fonts/raw/main/ofl/mplus1p/MPLUS1p-Regular.ttf', path.join(ASSETS, 'MPLUS1p-Regular.ttf')],
  ['https://github.com/google/fonts/raw/main/ofl/mplus1p/OFL.txt',             path.join(ASSETS, 'OFL.txt')],
  ['https://github.com/tesseract-ocr/tessdata_fast/raw/main/jpn.traineddata',  path.join(PUB_DATA, 'jpn.traineddata')],
  ['https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata',  path.join(PUB_DATA, 'eng.traineddata')],
];

// Only the LSTM cores are copied: the pipeline runs oem=1, and tesseract.js
// feature-detects which of these three to actually fetch at runtime.
const COPIES = [
  ['tesseract.js/dist/worker.min.js',                          'worker.min.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js',        'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js',             'tesseract-core-lstm.wasm.js'],
];

for (const dir of [ASSETS, PUB_TESS, PUB_DATA]) fs.mkdirSync(dir, { recursive: true });

for (const [url, dest] of DOWNLOADS) {
  if (fs.existsSync(dest)) { console.log(`  have  ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} bytes)`); continue; }
  process.stdout.write(`  get   ${path.relative(ROOT, dest)} ... `);
  const res = await fetch(url);
  if (!res.ok) { console.log(`FAILED ${res.status}`); process.exitCode = 1; continue; }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`${fs.statSync(dest).size} bytes`);
}

for (const [from, to] of COPIES) {
  const src = path.join(ROOT, 'node_modules', from);
  const dest = path.join(PUB_TESS, to);
  if (!fs.existsSync(src)) { console.log(`  MISSING ${from} — run npm install first`); process.exitCode = 1; continue; }
  fs.copyFileSync(src, dest);
  console.log(`  copy  ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} bytes)`);
}

console.log('\nDone. Next: node spike/make-fixtures.mjs && node spike/run-spike.mjs');
