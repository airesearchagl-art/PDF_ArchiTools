/**
 * Phase 1 spike -- decide Human Decision H2 empirically.
 *
 * pdf-lib issue #1232 reports that @pdf-lib/fontkit@1.1.1 corrupts CJK glyphs
 * when subset:true. Rather than trust the report, embed the same Japanese text
 * both ways and check whether the text survives round-trip extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = fs.readFileSync(path.join(HERE, 'assets', 'MPLUS1p-Regular.ttf'));
const SAMPLE = '建築図面 第一版 平面図 Architectural Drawing Version 1';

async function build(subset) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset });
  const page = doc.addPage([600, 200]);
  page.drawText(SAMPLE, { x: 30, y: 100, size: 18, font, color: rgb(0, 0, 0) });
  return await doc.save();
}

async function extract(bytes) {
  const d = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  return tc.items.map(i => i.str).join('');
}

console.log(`sample: "${SAMPLE}"\n`);
for (const subset of [false, true]) {
  let bytes, got, err = null;
  try { bytes = await build(subset); got = await extract(bytes); }
  catch (e) { err = e.message; }
  console.log(`subset: ${String(subset).padEnd(5)}`);
  if (err) { console.log(`  THREW: ${err}\n`); continue; }
  console.log(`  pdf size      : ${bytes.length} bytes`);
  console.log(`  extracted     : "${got}"`);
  console.log(`  text round-trips: ${got.replace(/\s/g, '') === SAMPLE.replace(/\s/g, '')}`);
  fs.writeFileSync(path.join(HERE, 'out', `font-subset-${subset}.pdf`), bytes);
  console.log('');
}
