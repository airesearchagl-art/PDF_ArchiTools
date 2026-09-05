/**
 * Measure OCR preprocessing on large-format sheets.
 *
 * A4 tells you nothing about an A1 or A0 drawing: the working image goes from
 * 2 megapixels to 17 and then 35, and anything that allocates per pixel goes
 * with it. This renders each fixture at the pipeline's own 150 DPI and reports
 * what preprocessing costs in time and in heap.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/probe-large-format.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5197;
const ORIGIN = `http://localhost:${PORT}`;

const CASES = [
    ['scanned-ja-en.pdf', 'A4  '],
    ['scanned-a1-clean.pdf', 'A1  '],
    ['scanned-a1-skew-noisy.pdf', 'A1  '],
    ['scanned-a0-clean.pdf', 'A0  '],
    ['scanned-a0-skew-noisy.pdf', 'A0  '],
];
const MODES = [
    ['none', { deskew: false, noiseReduction: false }],
    ['noise', { deskew: false, noiseReduction: true }],
    ['deskew', { deskew: true, noiseReduction: false }],
    ['both', { deskew: true, noiseReduction: true }],
];

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'scanned-a0-clean.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({
    headless: true,
    // --expose-gc lets the probe settle the heap between cases, so the numbers
    // are the cost of one page rather than the debris of the previous one.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--expose-gc'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);
page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.error(`  [console] ${m.text()}`); });

try {
    await page.goto(`${ORIGIN}/scripts/smoke-ocr-preprocessing-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__prep?.ready === true, { timeout: 120_000 });

    const pad = (s, n) => String(s).padEnd(n);
    const num = (s, n) => String(s).padStart(n);
    console.log(`\n${pad('fixture', 28)} ${pad('mode', 7)} ${num('canvas', 12)} ${num('Mpx', 6)} ${num('detect', 7)} ${num('noise', 7)} ${num('apply', 7)} ${num('total', 7)} ${num('liveMB', 7)} ${num('keptMB', 7)} ${num('band', 6)} ${num('angle', 6)}  released`);
    console.log('-'.repeat(134));

    for (const [fixture, label] of CASES) {
        for (const [modeName, options] of MODES) {
            const r = await page.evaluate(async (f, o) => {
                const settle = async () => {
                    if (window.gc) window.gc();
                    await new Promise((res) => setTimeout(res, 150));
                    if (window.gc) window.gc();
                    await new Promise((res) => setTimeout(res, 150));
                };
                await settle();
                const before = performance.memory?.usedJSHeapSize ?? 0;
                const started = performance.now();
                const out = await window.__prep.detect(f, o);
                out.wallMs = Math.round(performance.now() - started);
                // What is still held once the run is over and the collector has
                // had its chance. Peak usedJSHeapSize during the run is mostly
                // short-lived per-band buffers, so it measures garbage rather
                // than footprint; this measures whether anything was kept.
                await settle();
                out.retainedMB = performance.memory
                    ? +(((performance.memory.usedJSHeapSize - before) / 1048576).toFixed(1))
                    : null;
                out.liveWorkingMB = +(((out.peakWorkingBytes ?? 0) / 1048576).toFixed(1));
                return out;
            }, fixture, options).catch((e) => ({ crashed: String(e?.message ?? e) }));

            if (r.crashed) {
                console.log(`${pad(fixture, 28)} ${pad(modeName, 7)}  CRASHED: ${r.crashed}`);
                continue;
            }
            const mpx = (() => {
                const [w, h] = r.source.split('x').map(Number);
                return (w * h / 1e6).toFixed(1);
            })();
            console.log(
                `${pad(label + fixture.replace('scanned-', ''), 28)} ${pad(modeName, 7)} ${num(r.source, 12)} ${num(mpx, 6)} ` +
                `${num(r.detectMs, 7)} ${num(r.noiseMs, 7)} ${num(r.applyMs, 7)} ${num(r.wallMs, 7)} ` +
                `${num(r.liveWorkingMB ?? '-', 7)} ${num(r.retainedMB ?? '-', 7)} ${num(r.bandRows ?? '-', 6)} ${num(r.detectedAngle, 6)}  ` +
                `${r.releasedProcessed && r.releasedSource ? 'yes' : 'NO'}` +
                `${r.removedSpecks ? `  specks=${r.removedSpecks}` : ''}` +
                `${r.inkBefore !== undefined ? `  ink ${r.inkBefore}->${r.inkAfter}` : ''}`);
        }
    }
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(0);
}
