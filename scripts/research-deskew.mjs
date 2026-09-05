/**
 * Measure candidate deskew detectors against fixtures with known angles.
 *
 * A one-off comparison, kept so the choice of algorithm can be re-run rather
 * than taken on trust. It answers one question: which scoring function finds
 * the angle a fixture was actually built with, and what does it cost. OCR
 * quality before and after is the smoke gate's job, not this one's.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/research-deskew.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5194;
const ORIGIN = `http://localhost:${PORT}`;

/** fixture -> the angle it was generated with, or null when there is no truth. */
const CASES = [
    ['scanned-ja-en.pdf', 0],
    ['scanned-skew-tiny.pdf', 0.1],
    ['scanned-skew-plus-1.pdf', 1],
    ['scanned-skew-minus-1.pdf', -1],
    ['scanned-skew-plus-3.pdf', 3],
    ['scanned-skew-minus-3.pdf', -3],
    ['scanned-skew-ja.pdf', 2],
    ['scanned-skew-en.pdf', 2],
    ['scanned-noisy.pdf', 0],
    ['scanned-noisy-heavy.pdf', 0],
    ['scanned-skew-noisy.pdf', 3],
    ['scanned-sparse.pdf', null],
    ['scanned-blank.pdf', null],
];

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'scanned-skew-plus-3.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);
page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));

try {
    await page.goto(`${ORIGIN}/scripts/research-deskew-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__research?.ready === true);

    const rows = [];
    for (const [name, truth] of CASES) {
        const r = await page.evaluate((n) => window.__research.measure(n), name);
        rows.push({ ...r, truth });
    }

    const pad = (s, n) => String(s).padEnd(n);
    const num = (s, n) => String(s).padStart(n);
    console.log(`\n${pad('fixture', 26)} ${num('truth', 6)} | ${num('var', 7)}${num('marg', 7)}${num('ms', 6)} | ${num('grad', 7)}${num('marg', 7)}${num('ms', 6)} | ${num('mom', 7)} | analysis    ink`);
    console.log('-'.repeat(120));
    const err = { variance: [], gradient: [], moments: [] };
    for (const r of rows) {
        const t = r.truth;
        for (const k of ['variance', 'gradient', 'moments']) {
            if (t !== null) err[k].push(Math.abs(r[k].angle - t));
        }
        console.log(
            `${pad(r.name, 26)} ${num(t === null ? '-' : t.toFixed(1), 6)} | ` +
            `${num(r.variance.angle.toFixed(2), 7)}${num(r.variance.margin.toFixed(2), 7)}${num(r.variance.ms, 6)} | ` +
            `${num(r.gradient.angle.toFixed(2), 7)}${num(r.gradient.margin.toFixed(2), 7)}${num(r.gradient.ms, 6)} | ` +
            `${num(r.moments.angle.toFixed(2), 7)} | ${pad(r.analysis, 11)} ${r.inkPoints}`);
    }

    console.log('\nmean absolute error against the known angle (fixtures with a truth):');
    for (const k of ['variance', 'gradient', 'moments']) {
        const e = err[k];
        const mean = e.reduce((a, b) => a + b, 0) / e.length;
        const worst = Math.max(...e);
        console.log(`  ${pad(k, 10)} mean ${mean.toFixed(3)}deg   worst ${worst.toFixed(3)}deg`);
    }
    console.log('\nblank / sparse (no truth) must not produce a confident angle:');
    for (const r of rows.filter((x) => x.truth === null)) {
        console.log(`  ${pad(r.name, 22)} var ${String(r.variance.angle).padStart(6)} (margin ${r.variance.margin})   grad ${String(r.gradient.angle).padStart(6)} (margin ${r.gradient.margin})   ink ${r.inkPoints}`);
    }
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(0);
}
