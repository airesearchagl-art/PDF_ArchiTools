/**
 * Phase 1 spike driver.
 *
 * Boots the project's own Vite dev server, drives spike.html in a real Chrome
 * via puppeteer, and checks the acceptance criteria from the brief (section 15).
 * Browser-based on purpose: this is the target runtime, and it also exercises
 * the Vite + WASM + worker integration the research flagged as a risk.
 *
 * Fail-closed. Two rules matter here, both learned from a run that reported a
 * stale pass:
 *   1. The artifact is overwritten with an in-progress marker before anything
 *      else, so a crash can never leave an older passing artifact on disk to be
 *      mistaken for this run's result.
 *   2. Every acceptance check reads defensively. A fixture that failed is stored
 *      as `{ error }`, and reaching into `.report.pages` on it used to throw a
 *      secondary TypeError that killed the driver before it wrote anything.
 *
 * Run:  node spike/run-spike.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { describeError, networkEvidence } from './evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const RESULTS = path.join(OUT, 'spike-results.json');
fs.mkdirSync(OUT, { recursive: true });

const startedAt = new Date().toISOString();
const say = (s) => console.log(s);

// Stale-artifact guard. Written before the server even starts.
fs.writeFileSync(RESULTS, JSON.stringify({
  __runStartedAt: startedAt,
  __runStatus: 'in-progress',
  __completed: false,
  __failureReason: null,
  __note: 'Run did not complete. If this is the final content, the driver died before recording results.',
}, null, 2));

const results = {};
const consoleErrors = [];
const failedRequests = [];
const responses = [];
let server;
let browser;
let stage = 'startup';
let driverError = null;
let checks = [];
let pass = 0;

/** Puppeteer flattens a browser exception; the page hands back structure instead. */
function unwrap(value, label) {
  if (value && typeof value === 'object' && value.__error) {
    return { error: value.__error, failedAt: label };
  }
  return value;
}

try {
  stage = 'startServer';
  server = await createServer({ root: path.join(HERE, '..'), server: { port: 5199 }, logLevel: 'warn' });
  await server.listen();
  const base = 'http://localhost:5199';

  stage = 'launchBrowser';
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on('response', (r) => {
    const h = r.headers();
    responses.push({
      url: r.url(),
      status: r.status(),
      contentLength: h['content-length'] ? Number(h['content-length']) : null,
      contentType: h['content-type'] ?? null,
    });
    if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()} ${r.url()}`);
  });

  stage = 'navigate';
  await page.goto(`${base}/spike/spike.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__spike?.ready === true, { timeout: 60000 });

  // ---------------------------------------------------------------- classify
  stage = 'classify';
  say('\n=== text-native detection (no OCR run) ===');
  for (const f of ['text-native-ja-en.pdf', 'scanned-ja.pdf', 'scanned-multipage.pdf']) {
    const r = unwrap(await page.evaluate((f) => window.__spike.classify(f), f), `classify:${f}`);
    results[`classify:${f}`] = r;
    if (!Array.isArray(r)) { say(`  ${f.padEnd(24)} ERROR: ${r?.error?.message ?? 'unknown'}`); continue; }
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
    stage = `pipeline:${fixture}`;
    say(`\n=== ${fixture}  (langs=${langs}) ===`);
    const t0 = Date.now();
    let r;
    try {
      r = unwrap(await page.evaluate((f, l) => window.__spike.run(f, { langs: l }), fixture, langs), fixture);
    } catch (e) {
      r = { error: describeError(e, `pipeline:${fixture}`) };
    }
    const wall = Date.now() - t0;

    if (r?.error) {
      say(`  FAILED: ${r.error.name ?? 'Error'}: ${r.error.message ?? '(no message)'}`);
      if (r.error.details) say(`  details: ${JSON.stringify(r.error.details)}`);
      if (r.error.stage) say(`  stage  : ${r.error.stage}`);
      results[fixture] = { ...r, wallMs: wall };
      continue;
    }

    if (r.outputBase64) {
      fs.writeFileSync(path.join(OUT, `out-${fixture}`), Buffer.from(r.outputBase64, 'base64'));
    }
    delete r.outputBase64;
    r.wallMs = wall;
    results[fixture] = r;

    for (const p of r.report?.pages ?? []) {
      say(`  p${p.page}: ${p.kind.padEnd(12)} ocrWords=${String(p.ocrWords).padStart(4)} placed=${String(p.placed).padStart(4)} conf=${p.meanConfidence ?? '-'} ${p.ms}ms`);
      if (p.text) say(`       ocr text: ${p.text.slice(0, 120)}`);
    }
    say(`  extracted p1 : ${(r.extracted?.[0] || '').slice(0, 140)}`);
    say(`  appearance   : identical=${r.appearance?.identical} differingPixels=${r.appearance?.differingPixels}/${r.appearance?.totalPixels} (${r.appearance?.percent}%)`);
    say(`  selection    : selectable=${r.selection?.selectable} spans=${r.selection?.spans} withinPage=${r.selection?.spansWithinPage} chars=${r.selection?.selectedChars}`);
    say(`  selected     : ${(r.selection?.selectedSample || '').slice(0, 120)}`);
    say(`  size         : ${r.report?.inputBytes} -> ${r.report?.outputBytes} bytes   total ${r.report?.timings?.totalMs}ms (ocrInit ${r.report?.timings?.ocrInitMs ?? 0}ms), wall ${wall}ms`);
  }

  // ------------------------------------------------- font subsetting (H2)
  stage = 'fontSubset';
  say('\n=== Japanese font subsetting: does subset:true damage visible glyphs? ===');
  const sub = unwrap(await page.evaluate(
    () => window.__spike.compareFiles('/spike/out/font-subset-true.pdf', '/spike/out/font-subset-false.pdf'),
  ), 'fontSubset');
  results.fontSubset = sub;
  if (sub?.error) say(`  SKIPPED: ${sub.error.message} (run spike/probe-font-subset.mjs first)`);
  else say(`  subset:true vs subset:false rendering - identical=${sub.identical} differingPixels=${sub.differingPixels}/${sub.totalPixels} (${sub.percent}%) maxChannelDelta=${sub.maxChannelDelta}`);

  // ---------------------------------------------------------------- cancel
  stage = 'cancel';
  say('\n=== cancellation ===');
  const c = unwrap(await page.evaluate(() => window.__spike.cancelProbe('scanned-multipage.pdf')), 'cancel');
  results.cancel = c;
  if (c?.error) say(`  FAILED: ${c.error.message}`);
  else say(`  cancelled=${c.cancelled} pagesProcessed=${c.pagesProcessed}/3 in ${c.ms}ms`);

  // ---------------------------------------------------------------- verdict
  stage = 'verdict';
  say('\n=== acceptance criteria ===');
  const EXPECT = {
    'scanned-en.pdf':        ['Architectural', 'Drawing'],
    'scanned-ja.pdf':        ['建築', '図面'],
    'scanned-ja-en.pdf':     ['Architectural'],
    'scanned-multipage.pdf': ['Page'],
  };
  const hit = (hay, needles) => needles.filter((n) => hay.includes(n));

  // Every accessor below is defensive on purpose: a failed fixture is stored as
  // { error }, and this block must still produce a verdict rather than throw.
  const tn = results['text-native-ja-en.pdf'];
  const tnPages = Array.isArray(tn?.report?.pages) ? tn.report.pages : null;
  checks.push(['text-native PDF uses existing text, no OCR',
    !!tnPages && tnPages.length > 0 && tnPages.every((p) => p.kind === 'text-native' && p.ocrWords === 0)]);
  checks.push(['text-native text is present in output',
    (tn?.extracted?.[0] || '').includes('建築図面')]);

  for (const [f, needles] of Object.entries(EXPECT)) {
    const all = Array.isArray(results[f]?.extracted) ? results[f].extracted.join('') : '';
    const found = hit(all, needles);
    checks.push([`${f}: OCR text present in output  (${found.join(',') || 'none'})`, found.length > 0]);
  }

  const mpPages = Array.isArray(results['scanned-multipage.pdf']?.report?.pages)
    ? results['scanned-multipage.pdf'].report.pages : null;
  checks.push(['multi-page: all 3 pages processed', mpPages?.length === 3]);
  checks.push(['multi-page: every page got invisible words',
    !!mpPages && mpPages.length > 0 && mpPages.every((p) => p.placed > 0)]);
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

  // M1 font policy is subset:false. Assert it here so a future change that
  // silently reverts it fails the gate instead of quietly passing.
  const pipelineSrc = fs.readFileSync(path.join(HERE, 'pipeline.js'), 'utf8');
  const subsetFalse = /embedFont\(fontBytes,\s*\{\s*subset:\s*false\s*\}\)/.test(pipelineSrc);
  checks.push(['M1 font policy is subset:false in pipeline.js', subsetFalse]);

  for (const [name, ok] of checks) { say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  say(`\n  ${pass}/${checks.length} checks passed`);
} catch (error) {
  driverError = describeError(error, stage);
  say(`\n!! DRIVER ERROR at stage "${stage}"`);
  say(`   ${driverError.name ?? 'Error'}: ${driverError.message ?? '(no message)'}`);
  if (driverError.details) say(`   details: ${JSON.stringify(driverError.details)}`);
} finally {
  if (consoleErrors.length) {
    say('\n  console errors:');
    for (const e of consoleErrors.slice(0, 10)) say(`    ${e.slice(0, 200)}`);
  }
  if (failedRequests.length) {
    say('\n  failed requests:');
    for (const e of failedRequests.slice(0, 10)) say(`    ${e.slice(0, 200)}`);
  }

  const total = checks.length;
  const gatePass = driverError === null && total > 0 && pass === total;

  results.__runStartedAt = startedAt;
  results.__runFinishedAt = new Date().toISOString();
  // Explicit run metadata so a leftover artifact from an earlier commit can
  // never be read as this run's result -- the exact confusion that let a
  // subset:true-era 13/13 file stand in for a run that never wrote one.
  results.__runStatus = 'completed';
  results.__completed = true;
  results.__checks = checks.map(([name, ok]) => ({ name, ok }));
  results.__checksPassed = pass;
  results.__checksTotal = total;
  results.__driverError = driverError;
  results.__network = networkEvidence(responses, failedRequests, consoleErrors);
  results.__gate = {
    pass: gatePass,
    reasons: [
      ...(driverError ? [`driver error at stage: ${driverError.stage}`] : []),
      ...(total === 0 ? ['no acceptance checks were evaluated'] : []),
      ...checks.filter(([, ok]) => !ok).map(([name]) => `failed check: ${name}`),
    ],
  };
  results.__semanticGatePass = gatePass;
  results.__failureReason = gatePass ? null : results.__gate.reasons;
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  say(`\n  wrote ${path.join('spike', 'out', 'spike-results.json')}`);
  say(gatePass ? '  GATE: PASS' : `  GATE: FAIL\n    - ${results.__gate.reasons.join('\n    - ')}`);

  try { await browser?.close(); } catch { /* best effort */ }
  try { await server?.close(); } catch { /* best effort */ }
  process.exit(gatePass ? 0 : 1);
}
