/**
 * Bounded Tesseract.js vs PaddleOCR.js browser comparison driver.
 *
 * Fail-closed. The artifact is always written, and the process exits non-zero
 * whenever the comparison did not semantically succeed. The previous version
 * ended in `setTimeout(() => process.exit(0))` inside `finally`, so a run whose
 * own artifact recorded a fatal error still reported success to CI.
 *
 * Run:  node spike/run-paddle-compare.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { describeError, networkEvidence } from './evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'paddleocr-comparison.json');
const HARD_WALL_MS = 600_000;
const PORT = 5198;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REQUIRED_FIXTURES = ['scanned-ja.pdf', 'scanned-en.pdf', 'scanned-ja-en.pdf'];

fs.mkdirSync(path.dirname(OUT), { recursive: true });

function writeArtifact(payload) {
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// Overwrite any previous artifact immediately, so a crash cannot leave an older
// passing artifact on disk to be mistaken for this run's result.
const startedAt = new Date().toISOString();
writeArtifact({
  runStartedAt: startedAt,
  runStatus: 'in-progress',
  completed: false,
  failureReason: null,
  note: 'Run did not complete. If this is the final content, the driver died before writing results.',
});

// Vite's Node API rather than spawning `npx vite`: spawning a .cmd shim fails
// with EINVAL on Windows under current Node, and an in-process server also
// removes the stray pipe handle that motivated the old unconditional exit(0).
let server;

async function startServer() {
  server = await createServer({
    root: path.resolve(HERE, '..'),
    server: { host: '127.0.0.1', port: PORT, strictPort: true },
    logLevel: 'warn',
    // PaddleOCR.js ships its Web Worker as a sibling asset
    // (dist/assets/worker-entry-*.js). Vite's dependency pre-bundler rewrites
    // the package entry into .vite/deps but does not carry that asset across,
    // so the worker URL 404s and the library reports only "OCR worker failed."
    // Excluding it from pre-bundling serves the package from its own directory,
    // where the relative worker URL still resolves.
    //
    // Set here, in the research driver, rather than in vite.config.ts: this is a
    // harness concern and production config must stay untouched.
    optimizeDeps: {
      exclude: ['@paddleocr/paddleocr-js'],
      // ...but its dependencies are all CommonJS, and excluding the parent also
      // skips the CJS-to-ESM interop they rely on. Without this, the page dies
      // at load with "clipper-lib does not provide an export named 'default'".
      include: ['clipper-lib', '@techstark/opencv-js', 'js-yaml', 'onnxruntime-web'],
    },
  });
  await server.listen();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ORIGIN}/spike/paddle-compare.html`);
      if (r.ok) return;
    } catch { /* not serving yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Vite server started but did not serve the comparison page within 60s');
}

async function closeBrowserHard(browser) {
  if (!browser) return false;
  let closed = false;
  await Promise.race([
    browser.close().then(() => { closed = true; }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (!closed) {
    try { browser.process()?.kill('SIGKILL'); } catch { /* already gone */ }
  }
  return closed;
}

/**
 * Decide whether the comparison actually succeeded.
 *
 * Deliberately separate from "did the process throw". A run can complete
 * cleanly and still be a semantic failure, which is exactly the gap that let a
 * failed comparison report exit 0.
 */
function evaluateGate(payload) {
  const reasons = [];
  const t = payload.tesseract;
  const p = payload.paddle;

  if (payload.fatalError) reasons.push(`fatalError present (stage: ${payload.fatalError.stage ?? 'unknown'})`);
  if (payload.hardWallTimeout) reasons.push(`hard wall of ${payload.hardWallMs} ms exceeded`);
  if (payload.driverError) reasons.push(`driver error (stage: ${payload.driverError.stage ?? 'unknown'})`);

  if (!t) reasons.push('Tesseract result missing');
  else if (t.error) reasons.push(`Tesseract engine error (stage: ${t.error.stage ?? 'unknown'})`);
  else for (const f of REQUIRED_FIXTURES) {
    if (!t.outputs?.[f]) reasons.push(`Tesseract result missing for ${f}`);
  }

  if (!p) reasons.push('Paddle result missing');
  else if (p.error) reasons.push(`Paddle engine error (stage: ${p.error.stage ?? 'unknown'})`);
  else for (const f of REQUIRED_FIXTURES) {
    if (!p.outputs?.[f]) reasons.push(`Paddle result missing for ${f}`);
  }

  return { pass: reasons.length === 0, reasons };
}

const responses = [];
const failedRequests = [];
const consoleErrors = [];
let browser;
let payload;
let stage = 'startup';

try {
  stage = 'startServer';
  await startServer();

  stage = 'launchBrowser';
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // PaddleOCR's WASM init blocks the page's main thread for long stretches, so
    // CDP calls stop being answered and puppeteer's default 180s protocolTimeout
    // fires before any real result exists. This run is bounded by HARD_WALL_MS
    // instead -- one explicit limit rather than two competing ones.
    protocolTimeout: 0,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(0);

  page.on('response', (response) => {
    const headers = response.headers();
    responses.push({
      url: response.url(),
      status: response.status(),
      contentLength: headers['content-length'] ? Number(headers['content-length']) : null,
      contentType: headers['content-type'] ?? null,
    });
  });
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));

  // Page-level events do NOT see traffic started inside a Web Worker, and
  // PaddleOCR loads its models and ONNX runtime from inside its worker. Without
  // this, the external-request count is silently understated as zero.
  browser.on('targetcreated', async (target) => {
    const type = target.type();
    if (type !== 'worker' && type !== 'service_worker' && type !== 'shared_worker') return;
    try {
      const session = await target.createCDPSession();
      await session.send('Network.enable');
      session.on('Network.responseReceived', (e) => {
        const len = e.response?.headers?.['content-length'] ?? e.response?.headers?.['Content-Length'];
        responses.push({
          url: e.response?.url ?? '',
          status: e.response?.status ?? null,
          contentLength: len ? Number(len) : null,
          contentType: e.response?.mimeType ?? null,
          origin: 'worker',
        });
      });
      session.on('Network.loadingFailed', (e) => {
        failedRequests.push({ url: `worker request ${e.requestId}`, error: e.errorText ?? null });
      });
    } catch { /* target may already be gone */ }
  });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err?.message ?? String(err)}`));

  stage = 'navigate';
  await page.goto(`${ORIGIN}/spike/paddle-compare.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  stage = 'awaitComparison';
  const waitForDone = page.waitForFunction(() => window.__PADDLE_COMPARE_DONE__ === true, { timeout: 0 })
    .then(() => ({ kind: 'done' }))
    .catch((error) => ({ kind: 'wait-error', error: describeError(error, 'awaitComparison') }));
  const wall = new Promise((resolve) => setTimeout(
    () => resolve({
      kind: 'hard-wall',
      error: describeError(new Error(`comparison exceeded ${HARD_WALL_MS} ms hard wall`), 'hardWall'),
    }),
    HARD_WALL_MS,
  ));
  const outcome = await Promise.race([waitForDone, wall]);

  if (outcome.kind === 'done') {
    stage = 'collectResult';
    const result = await page.evaluate(() => window.__PADDLE_COMPARE_RESULT__);
    payload = {
      ...result,
      runStartedAt: startedAt,
      hardWallTimeout: false,
      hardWallMs: HARD_WALL_MS,
    };
    // The page reports its own fatalError inside the result; keep whatever it said.
    if (!('fatalError' in payload)) payload.fatalError = null;
  } else {
    // The page did not finish. Try to recover where it got stuck and whatever it
    // had already produced. Raced with a short timeout because a blocked main
    // thread cannot answer an evaluate at all.
    stage = 'recoverPartial';
    const probe = async (fn) => Promise.race([
      page.evaluate(fn).catch((e) => ({ __probeError: e?.message ?? String(e) })),
      new Promise((r) => setTimeout(() => r({ __probeError: 'page did not respond within 15s (main thread blocked)' }), 15_000)),
    ]);

    payload = {
      runStartedAt: startedAt,
      fatalError: outcome.error,
      hardWallTimeout: outcome.kind === 'hard-wall',
      hardWallMs: HARD_WALL_MS,
      comparisonStage: 'browser OCR engine comparison',
      stuckAtStage: await probe(() => window.__PADDLE_STAGE__ ?? null),
      stageLog: await probe(() => window.__PADDLE_LOG__ ?? null),
    };
    const partial = await probe(() => window.__PADDLE_PARTIAL__ ?? null);
    if (partial && !partial.__probeError && partial.tesseract) {
      payload.tesseract = partial.tesseract;
      payload.partialRecovered = true;
    } else {
      payload.partialProbe = partial;
    }
  }
} catch (error) {
  payload = {
    runStartedAt: startedAt,
    fatalError: null,
    driverError: describeError(error, stage),
    hardWallTimeout: false,
    hardWallMs: HARD_WALL_MS,
  };
} finally {
  payload = payload ?? {
    runStartedAt: startedAt,
    fatalError: null,
    driverError: describeError(new Error('driver produced no payload'), stage),
    hardWallTimeout: false,
    hardWallMs: HARD_WALL_MS,
  };

  payload.network = networkEvidence(responses, failedRequests, consoleErrors);
  payload.terminatedCleanly = await closeBrowserHard(browser);
  try { await server?.close(); } catch { /* already gone */ }

  const gate = evaluateGate(payload);
  payload.gate = gate;
  payload.semanticGatePass = gate.pass;
  payload.runFinishedAt = new Date().toISOString();
  // Explicit run metadata so a reader can never mistake a leftover artifact for
  // this run's result: a file without runStatus 'completed' is not evidence.
  payload.runStatus = 'completed';
  payload.completed = true;
  payload.failureReason = gate.pass ? null : gate.reasons;
  writeArtifact(payload);

  console.log(JSON.stringify({
    gate,
    fatalError: payload.fatalError,
    driverError: payload.driverError ?? null,
    hardWallTimeout: payload.hardWallTimeout,
    terminatedCleanly: payload.terminatedCleanly,
    tesseractError: payload.tesseract?.error ?? null,
    paddleError: payload.paddle?.error ?? null,
    externalRequestCount: payload.network.externalRequestCount,
  }, null, 2));
  console.log(`\nartifact: ${path.relative(process.cwd(), OUT)}`);
  console.log(gate.pass ? 'GATE: PASS' : `GATE: FAIL\n  - ${gate.reasons.join('\n  - ')}`);

  // Exit explicitly with the gate's verdict, never an unconditional 0.
  process.exit(gate.pass ? 0 : 1);
}
