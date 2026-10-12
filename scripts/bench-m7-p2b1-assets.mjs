/**
 * M7-P2-B1 local benchmark: 図面管理 intake and preview in the built app,
 * before and after P1 intake and preview were given M7's PDF.js data files
 * (CMaps, standard fonts, wasm decoders; HD-B-04). Local evidence, not CI.
 *
 * It drives the real UI of a built app -- `dist/` under --root -- the way a
 * person would: choose files, wait until they are taken in, open a page in the
 * preview. Run it once against a build of the commit before the change and
 * once against this one. Synthetic fixtures only; nothing leaves the machine.
 *
 *  - cold: a fresh browser context each time (empty HTTP cache, no PDF.js
 *    worker warmed up);
 *  - warm: the same files again in the same context, after a new Drawing Set.
 *
 * For each: the time until each file is taken in, until the first page is
 * drawn in the preview, the PDF.js documents open at once (peak), the
 * requests under /pdfjs/, and any request off this machine.
 *
 * Run:
 *   npm run build
 *   node scripts/make-m7-p1-fixtures.mjs
 *   node scripts/bench-m7-p2b1-assets.mjs --root=. --label=after [--runs=3] [--browser=<path>]
 *   node scripts/bench-m7-p2b1-assets.mjs --root=<checkout of the previous commit, built> --label=before
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { preview } from 'vite';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const ROOT = path.resolve(arg('root', HERE));
const LABEL = arg('label', path.basename(ROOT));
const RUNS = Number(arg('runs', '3'));
const BROWSER = arg('browser', process.env.M7_BROWSER || '');
const PORT = Number(arg('port', '5231'));
const ORIGIN = `http://localhost:${PORT}`;

// Fixtures always come from this checkout: both builds read the same bytes.
const FILES = [
    ['cmap (CID fonts)', path.join(HERE, 'test-fixtures', 'm7-p2a', 'p2a-cmap.pdf')],
    ['jpx (JPEG 2000 scan)', path.join(HERE, 'test-fixtures', 'm7-p2a', 'p2a-jpx.pdf')],
    ['native A4/A3', path.join(HERE, 'test-fixtures', 'm7-p1', 'p1-native-a.pdf')],
    ['5000 pages', path.join(HERE, 'test-fixtures', 'm7-p1', 'p1-5000-pages.pdf')],
];

async function measure(page, requests) {
    const out = {};
    const pdfWorkers = () => page.workers().filter((w) => /pdf\.worker/.test(w.url())).length;
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, pdfWorkers()); }, 5);
    try {
        for (const [label, file] of FILES) {
            const from = requests.length;
            const t0 = Date.now();
            await (await page.$('[data-ds-file-input]')).uploadFile(file);
            await page.waitForFunction(() => {
                const el = document.querySelector('[data-ds-root]');
                return el && el.dataset.dsState === 'idle'
                    && ![...el.querySelectorAll('[data-ds-result]')].some((r) => r.dataset.dsResult === 'queued' || r.dataset.dsResult === 'processing');
            }, { timeout: 300_000, polling: 20 });
            const takenMs = Date.now() - t0;
            // The newest file's first Sheet into the preview.
            const t1 = Date.now();
            const clicked = await page.evaluate((name) => {
                const row = [...document.querySelectorAll('[data-ds-sheet-row]')].find((r) => r.textContent.includes(name) && r.dataset.dsPage === '1');
                row?.click();
                return row?.dataset.dsSheetId ?? null;
            }, path.basename(file));
            await page.waitForFunction((id) => {
                const v = document.querySelector('[data-ds-viewer]');
                return v && v.dataset.dsRenderState === 'rendered' && v.querySelector('canvas')?.dataset.dsRenderedSheet === id;
            }, { timeout: 120_000, polling: 20 }, clicked);
            const previewMs = Date.now() - t1;
            const assets = requests.slice(from).filter((u) => u.includes('/pdfjs/'));
            out[label] = { takenMs, previewMs, pdfjsDataRequests: assets.length };
        }
    } finally {
        clearInterval(timer);
    }
    out.pdfDocumentsPeak = peak;
    return out;
}

async function reset(page) {
    await page.click('[data-ds-reset]');
    await page.waitForSelector('[data-ds-confirm="reset"]');
    await page.click('[data-ds-confirm-yes]');
    await page.waitForSelector('[data-ds-empty]');
}

async function main() {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error(`No build under ${ROOT}. Run: npm run build`);
    for (const [, file] of FILES) if (!fs.existsSync(file)) throw new Error(`No fixture ${file}. Run: node scripts/make-m7-p1-fixtures.mjs`);
    const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], ...(BROWSER ? { executablePath: BROWSER } : {}) });
    const results = { label: LABEL, root: ROOT, browser: await browser.version(), runs: [] };
    const external = [];
    try {
        for (let run = 0; run < RUNS; run++) {
            const context = await browser.createBrowserContext();
            const page = await context.newPage();
            await page.setViewport({ width: 1400, height: 900 });
            const requests = [];
            page.on('request', (r) => {
                const url = r.url();
                requests.push(url);
                if (/^https?:/.test(url) && !url.startsWith(ORIGIN)) external.push(url);
            });
            await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
            await page.evaluate(() => [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === '図面管理')?.click());
            await page.waitForSelector('[data-ds-root]');
            const cold = await measure(page, requests);
            await reset(page);
            const warm = await measure(page, requests);
            results.runs.push({ cold, warm });
            await context.close();
        }
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const summary = {};
    for (const phase of ['cold', 'warm']) {
        summary[phase] = {};
        for (const [label] of FILES) {
            summary[phase][label] = {
                takenMs: median(results.runs.map((r) => r[phase][label].takenMs)),
                previewMs: median(results.runs.map((r) => r[phase][label].previewMs)),
                pdfjsDataRequests: median(results.runs.map((r) => r[phase][label].pdfjsDataRequests)),
            };
        }
        summary[phase].pdfDocumentsPeak = Math.max(...results.runs.map((r) => r[phase].pdfDocumentsPeak));
    }
    results.median = summary;
    results.externalRequests = external.length;
    console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
