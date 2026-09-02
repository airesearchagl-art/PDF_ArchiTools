import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'paddleocr-comparison.json');
const HARD_WALL_MS = 120_000;
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1', '--port', '5198'], {
  cwd: path.resolve(HERE, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:5198/spike/paddle-compare.html');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite server did not start. Log:\n${serverLog}`);
}

function externalNetwork(network) {
  return network.filter((r) => !r.url.startsWith('http://127.0.0.1:5198'));
}

function networkEvidence(network, failedRequests, consoleErrors) {
  const external = externalNetwork(network);
  return {
    externalRequestCount: external.length,
    externalKnownContentLengthBytes: external.reduce(
      (sum, r) => sum + (Number.isFinite(r.contentLength) ? r.contentLength : 0),
      0,
    ),
    external,
    failedRequests,
    consoleErrors,
  };
}

async function closeBrowserHard(browser) {
  if (!browser) return;
  let closed = false;
  await Promise.race([
    browser.close().then(() => { closed = true; }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (!closed) {
    try { browser.process()?.kill('SIGKILL'); } catch {}
  }
}

const network = [];
const failedRequests = [];
const consoleErrors = [];
let browser;
let page;
try {
  await waitForServer();
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  page = await browser.newPage();
  page.setDefaultTimeout(0);

  page.on('response', (response) => {
    const url = response.url();
    const headers = response.headers();
    network.push({
      url,
      status: response.status(),
      contentLength: headers['content-length'] ? Number(headers['content-length']) : null,
      contentType: headers['content-type'] ?? null,
    });
  });
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.goto('http://127.0.0.1:5198/spike/paddle-compare.html', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const waitForDone = page.waitForFunction(() => window.__PADDLE_COMPARE_DONE__ === true, { timeout: 0 })
    .then(() => ({ kind: 'done' }))
    .catch((error) => ({ kind: 'wait-error', error: String(error?.stack || error) }));
  const wall = new Promise((resolve) => setTimeout(
    () => resolve({ kind: 'hard-wall', error: `comparison exceeded ${HARD_WALL_MS} ms hard wall` }),
    HARD_WALL_MS,
  ));
  const outcome = await Promise.race([waitForDone, wall]);

  let payload;
  if (outcome.kind === 'done') {
    const result = await page.evaluate(() => window.__PADDLE_COMPARE_RESULT__);
    payload = {
      ...result,
      hardWallTimeout: false,
      hardWallMs: HARD_WALL_MS,
      network: networkEvidence(network, failedRequests, consoleErrors),
    };
  } else {
    payload = {
      fatalError: outcome.error,
      hardWallTimeout: outcome.kind === 'hard-wall',
      hardWallMs: HARD_WALL_MS,
      comparisonStage: 'browser OCR engine comparison',
      network: networkEvidence(network, failedRequests, consoleErrors),
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(payload, null, 2));
} finally {
  await closeBrowserHard(browser);
  server.kill('SIGTERM');
}
