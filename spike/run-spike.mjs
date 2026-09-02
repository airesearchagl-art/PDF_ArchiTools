/**
 * Phase 1 spike driver.
 *
 * Boots the project's own Vite dev server, drives spike.html in a real Chrome
 * via puppeteer, and checks the acceptance criteria from the brief (section 15).
 * Browser-based on purpose: this is the target runtime, and it also exercises
 * the Vite + WASM + worker integration the research flagged as a risk.
 *
 * Run:  node spike/run-spike.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ root: path.join(HERE, '..'), server: { port: 5199 }, logLevel: 'warn' });
await server.listen();
const base = `http://localhost:5199`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`${base}/spike/spike.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__spike?.ready === true, { timeout: 60000 });

const results = {};
const say = (s) => console.log(s);

// ---------------------------------------------------------------- classify
say('\n=== text-native detection (no OCR run) ===');
for (const f of ['text-native-ja-en.pdf', 'scanned-ja.pdf', 'scanned-multipage.pdf']) {
  const r = await page.evaluate((f) => window.__spike.classify(f), f);
  results[`classify:${f}`] = r;
  for (const p of r) {
    say(`  ${f.padEnd(24)} p${p.page}  ${p.kind.padEnd(12)} interiorChars=${String(p.interiorChars).padStart(4)}  allChars=${String(p.allChars).padStart(4)}  imageOps=${p.imageOps}`);
  }
}

// ---------------------------------------------------------------- pipeline
const cases = [
  ['text-native-ja-en.pdf', 'jpn+eng'],
  ['scanned-en.pdf',        'eng'],
  ['scanned-ja.pdf',        'jpn'],
  ['scanned-ja-en.pdf',     'jpn+eng'],
  ['scanned-multipage.pdf', 'jpn+eng'],
];

for (const [fixture, langs] of cases) {
  say(`\n=== ${fixture}  (langs=${langs}) ===`);
  const t0 = Date.now();
  let r;
  try {
    r = await page.evaluate((f, l) => window.__spike.run(f, { langs: l }), fixture, langs);
  } catch (e) {
    say(`  FAILED: ${e.message}`);
    results[fixture] = { error: e.message };
    continue;
  }
  const wall = Date.now() - t0;

  if (r.outputBase64) {
    fs.writeFileSync(path.join(OUT, `out-${fixture}`), Buffer.from(r.outputBase64, 'base64'));
  }
  delete r.outputBase64;
  r.wallMs = wall;
  results[fixture] = r;

  for (const p of r.report.pages) {
    say(`  p${p.page}: ${p.kind.padEnd(12)} ocrWords=${String(p.ocrWords).padStart(4)} placed=${String(p.placed).padStart(4)} conf=${p.meanConfidence ?? '-'} ${p.ms}ms`);
    if (p.text) say(`       ocr text: ${p.text.slice(0, 120)}`);
  }
  say(`  extracted p1 : ${(r.extracted[0] || '').slice(0, 140)}`);
  say(`  appearance   : identical=${r.appearance.identical} differingPixels=${r.appearance.differingPixels}/${r.appearance.totalPixels} (${r.appearance.percent}%)`);
  say(`  selection    : selectable=${r.selection.selectable} spans=${r.selection.spans} withinPage=${r.selection.spansWithinPage} chars=${r.selection.selectedChars}`);
  say(`  selected     : ${(r.selection.selectedSample || '').slice(0, 120)}`);
  say(`  size         : ${r.report.inputBytes} -> ${r.report.outputBytes} bytes   total ${r.report.timings.totalMs}ms (ocrInit ${r.report.timings.ocrInitMs ?? 0}ms), wall ${wall}ms`);
}

// ------------------------------------------------- font subsetting (H2)
say('\n=== Japanese font subsetting: does subset:true damage visible glyphs? ===');
try {
  const sub = await page.evaluate(
    () => window.__spike.compareFiles('/spike/out/font-subset-true.pdf', '/spike/out/font-subset-false.pdf'),
  );
  results.fontSubset = sub;
  say(`  subset:true vs subset:false rendering — identical=${sub.identical} differingPixels=${sub.differingPixels}/${sub.totalPixels} (${sub.percent}%) maxChannelDelta=${sub.maxChannelDelta}`);
} catch (e) {
  results.fontSubset = { error: e.message };
  say(`  SKIPPED: ${e.message} (run spike/probe-font-subset.mjs first)`);
}

// ---------------------------------------------------------------- cancel
say('\n=== cancellation ===');
try {
  const c = await page.evaluate(() => window.__spike.cancelProbe('scanned-multipage.pdf'));
  results.cancel = c;
  say(`  cancelled=${c.cancelled} pagesProcessed=${c.pagesProcessed}/3 in ${c.ms}ms`);
} catch (e) {
  results.cancel = { error: e.message };
  say(`  FAILED: ${e.message}`);
}

// ---------------------------------------------------------------- verdict
say('\n=== acceptance criteria ===');
const EXPECT = {
  'scanned-en.pdf':        ['Architectural', 'Drawing'],
  'scanned-ja.pdf':        ['建築', '図面'],
  'scanned-ja-en.pdf':     ['Architectural'],
  'scanned-multipage.pdf': ['Page'],
};
const hit = (hay, needles) => needles.filter((n) => hay.includes(n));

const checks = [];
const tn = results['text-native-ja-en.pdf'];
checks.push(['text-native PDF uses existing text, no OCR',
  !!tn && tn.report.pages.every((p) => p.kind === 'text-native' && p.ocrWords === 0)]);
checks.push(['text-native text is present in output',
  !!tn && (tn.extracted[0] || '').includes('建築図面')]);

for (const [f, needles] of Object.entries(EXPECT)) {
  const r = results[f];
  const all = r?.extracted?.join('') ?? '';
  const found = hit(all, needles);
  checks.push([`${f}: OCR text present in output  (${found.join(',') || 'none'})`, found.length > 0]);
}
checks.push(['multi-page: all 3 pages processed',
  results['scanned-multipage.pdf']?.report?.pages?.length === 3]);
checks.push(['multi-page: every page got invisible words',
  (results['scanned-multipage.pdf']?.report?.pages ?? []).every((p) => p.placed > 0)]);
checks.push(['output text is selectable',
  results['scanned-ja-en.pdf']?.selection?.selectable === true]);
checks.push(['appearance preserved (zero differing pixels)',
  ['scanned-en.pdf', 'scanned-ja.pdf', 'scanned-ja-en.pdf', 'scanned-multipage.pdf']
    .every((f) => results[f]?.appearance?.identical === true)]);
checks.push(['cancellation stops before all pages', results.cancel?.cancelled === true]);
// The dev server has no favicon; that 404 is the harness's own noise, not the
// pipeline's, so it is excluded by name rather than by silencing all errors.
const realFailures = failedRequests.filter((u) => !u.includes('/favicon.ico'));
checks.push([`no failed requests (favicon excluded)  [${realFailures.length} real, ${failedRequests.length} total]`,
  realFailures.length === 0]);
checks.push(['no page errors / uncaught exceptions',
  consoleErrors.filter((e) => !e.includes('Failed to load resource')).length === 0]);

let pass = 0;
for (const [name, ok] of checks) { say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
say(`\n  ${pass}/${checks.length} checks passed`);
if (consoleErrors.length) {
  say('\n  console errors:');
  for (const e of consoleErrors.slice(0, 10)) say(`    ${e.slice(0, 200)}`);
}
if (failedRequests.length) {
  say('\n  failed requests:');
  for (const e of failedRequests.slice(0, 10)) say(`    ${e.slice(0, 200)}`);
}

results.__checks = checks.map(([name, ok]) => ({ name, ok }));
results.__consoleErrors = consoleErrors;
results.__failedRequests = failedRequests;
fs.writeFileSync(path.join(OUT, 'spike-results.json'), JSON.stringify(results, null, 2));
say(`\n  wrote ${path.join('spike', 'out', 'spike-results.json')}`);

await browser.close();
await server.close();
process.exit(pass === checks.length ? 0 : 1);
