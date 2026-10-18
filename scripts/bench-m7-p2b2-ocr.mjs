/**
 * M7-P2-B2 stage L (T-14, HD-B-09): what a title-block reading costs in the
 * built app, as a person runs it, on this machine.
 *
 * Local evidence for the Release judgement, not a CI gate, and not a
 * threshold: the targets (cancel seen in about 1 s, about 0.5 s added per
 * run by the recogniser keeping no language cache) are what a person
 * weighs; nothing here changes the code if they are missed.
 *
 * Against `vite preview` of dist/ (the build under test), in a fresh browser
 * context per condition (its own HTTP cache and storage):
 *   1. the register and JPX fixtures taken in, a profile dragged on
 *      register p.1, every Sheet ticked and assigned;
 *   2. N readings in a row of all of them (raster pages go through OCR):
 *      from the click to the lock let go, with every /ocr/ request (status,
 *      body bytes, from the HTTP cache or not);
 *   3. one reading stopped while OCR runs: from 読み取りを中止 to the lock let
 *      go, and whether the recogniser Worker has ended by then.
 *
 *   node scripts/bench-m7-p2b2-ocr.mjs [--browser=<path>] [--repeat=3] [--http-cache=off]
 *       [--throttle=10:40] [--out=<file.json>]
 *
 * Needs a build (npm run build) and the P2-A fixtures. Synthetic PDFs only;
 * every request is recorded and none may leave this machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5218;
const ORIGIN = `http://localhost:${PORT}`;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserArg = arg('browser') || process.env.M7_BROWSER || '';
const REPEAT = Number(arg('repeat') || 3);
const OUT = arg('out');
const HTTP_CACHE = arg('http-cache') === 'off' ? 'off' : 'on';
const THROTTLE = arg('throttle') ? (() => {
    const [mbps, latency] = arg('throttle').split(':').map(Number);
    return { mbps, latency, download: (mbps * 1e6) / 8, upload: (mbps * 1e6) / 8 };
})() : null;
const P2A = path.join(ROOT, 'test-fixtures', 'm7-p2a');
const manifest = JSON.parse(fs.readFileSync(path.join(P2A, 'manifest.json'), 'utf8'));
const cells = manifest.files.find((f) => f.name === 'p2a-register').truth.cells;
const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)) : null;
};

async function runCondition(browser) {
    const context = await browser.createBrowserContext();
    const requests = [];
    const offOrigin = [];
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(180_000);
        await page.setViewport({ width: 1400, height: 900 });
        if (HTTP_CACHE === 'off') await page.setCacheEnabled(false);
        if (THROTTLE) await page.emulateNetworkConditions({ download: THROTTLE.download, upload: THROTTLE.upload, latency: THROTTLE.latency });
        // Puppeteer reports the page's dedicated Workers' requests with the page's own (the recogniser fetching
        // the language data): what arrived, its body size, and whether from the HTTP cache.
        page.on('requestfinished', (r) => {
            const res = r.response();
            const url = r.url();
            if (/^https?:/.test(url) && !url.startsWith(ORIGIN)) offOrigin.push(url);
            const entry = { url, status: res?.status() ?? null, bytes: 0, fromCache: res?.fromCache() ?? false };
            requests.push(entry);
            if (res && res.status() === 200 && url.startsWith(`${ORIGIN}/ocr/`)) res.buffer().then((b) => { entry.bytes = b.length; }, () => { entry.bytes = NaN; });
        });
        page.on('requestfailed', (r) => requests.push({ url: r.url(), status: 'failed', bytes: 0, fromCache: false }));
        const ocrWorkers = () => page.workers().filter((w) => /\/ocr\//.test(w.url())).length;

        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await page.evaluate(() => [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === '図面管理').click());
        await page.waitForSelector('[data-ds-root]');
        const input = await page.$('[data-ds-file-input]');
        await input.uploadFile(path.join(P2A, 'p2a-register.pdf'), path.join(P2A, 'p2a-jpx.pdf'));
        await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsSources === '2' && document.querySelector('[data-ds-root]')?.dataset.dsState === 'idle', { polling: 100 });
        await page.click('[data-ds-sheet-row][data-ds-row-index="0"]');
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { polling: 100 });
        await page.click('[data-ds-new-profile]');
        await page.waitForSelector('[data-ds-profile-editor="create"]');
        for (const field of FIELDS) {
            await page.click(`[data-ds-pick-field="${field}"]`);
            await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered' && document.querySelector('[data-ds-viewer-overlay]'), { polling: 50 });
            const g = await page.evaluate(() => {
                const o = document.querySelector('[data-ds-viewer-overlay]');
                const b = o.getBoundingClientRect();
                return { left: b.left, top: b.top, scale: Number(o.dataset.dsCssScale) };
            });
            const r = cells[field];
            await page.mouse.move(g.left + r.left * g.scale, g.top + r.top * g.scale);
            await page.mouse.down();
            await page.mouse.move(g.left + r.right * g.scale, g.top + r.bottom * g.scale, { steps: 6 });
            await page.mouse.up();
        }
        await page.click('[data-ds-transfer-model="normalised"]');
        await page.type('[data-ds-profile-name]', 'B');
        await page.click('[data-ds-editor-done]');
        await page.waitForSelector('[data-ds-profile-row]');
        await page.click('[data-ds-check-all]');
        await page.select('[data-ds-assign-target]', await page.evaluate(() => document.querySelector('[data-ds-profile-row]').dataset.dsProfileId));
        await page.click('[data-ds-assign]');
        await page.waitForFunction(() => /\d+ページ/.test(document.querySelector('[data-ds-profile-row]')?.textContent ?? '') && !document.querySelector('[data-ds-profile-row]').textContent.includes('・0ページ'), { polling: 50 });
        const sheets = await page.evaluate(() => Number(document.querySelector('[data-ds-root]').dataset.dsSheets));

        const runs = [];
        for (let i = 1; i <= REPEAT; i++) {
            const from = requests.length;
            const t0 = Date.now();
            await page.click('[data-ds-extract]');
            await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation !== '', { polling: 10 });
            await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation === '', { polling: 20, timeout: 600_000 });
            const ms = Date.now() - t0;
            await new Promise((resolve) => setTimeout(resolve, 300));
            const result = await page.evaluate(() => document.querySelector('[data-ds-extraction-result]')?.textContent ?? '');
            const ocr = requests.slice(from).filter((r) => r.url.startsWith(`${ORIGIN}/ocr/`));
            runs.push({
                run: i, ms, result,
                ocrRequests: ocr.length, ocrBodyBytes: sum(ocr.map((r) => r.bytes || 0)), ocrFromCache: ocr.filter((r) => r.fromCache).length,
                ocr: ocr.map((r) => ({ path: r.url.slice(ORIGIN.length), status: r.status, bytes: r.bytes, fromCache: r.fromCache })),
                ocrWorkersAfter: ocrWorkers(),
            });
        }

        // Stopped while OCR runs: wait for the recogniser's Worker, then cancel.
        const t0 = Date.now();
        await page.click('[data-ds-extract]');
        const sawOcr = await page.waitForFunction(() => true, { polling: 10 }).then(async () => {
            const until = Date.now() + 60_000;
            while (Date.now() < until && ocrWorkers() === 0) await new Promise((resolve) => setTimeout(resolve, 10));
            return ocrWorkers() > 0;
        });
        const asked = Date.now();
        await page.click('[data-ds-cancel-extraction]');
        await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation === '', { polling: 10, timeout: 120_000 });
        const unlockedMs = Date.now() - asked;
        const workersAtUnlock = ocrWorkers();
        // The browser reports a Worker gone a little after it was terminated: when did it go?
        let workerGoneMs = null;
        for (const waited = Date.now(); Date.now() - waited < 5_000;) {
            if (ocrWorkers() === 0) {
                workerGoneMs = Date.now() - asked;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const result = await page.evaluate(() => document.querySelector('[data-ds-extraction-result]')?.dataset.dsExtractionResult ?? '');
        return {
            sheets, runs,
            cancel: { sawOcr, askedAfterMs: asked - t0, unlockedMs, ocrWorkersAtUnlock: workersAtUnlock, workerGoneMs, result },
            offOrigin,
        };
    } finally {
        await context.close().catch(() => { });
    }
}

async function main() {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
        console.error('No build to measure. Run: npm run build');
        process.exit(1);
    }
    const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], ...(browserArg ? { executablePath: browserArg } : {}) });
    const version = await browser.version();
    const conditions = `HTTP cache ${HTTP_CACHE}; network ${THROTTLE ? `${THROTTLE.mbps} Mbit/s, ${THROTTLE.latency} ms latency` : 'unthrottled (localhost)'}`;
    console.log(`browser: ${version}${browserArg ? ` (${browserArg})` : ' (bundled)'}; repeat ${REPEAT}; ${conditions}`);
    let exitCode = 1;
    try {
        const r = await runCondition(browser);
        for (const run of r.runs) {
            console.log(`  run ${run.run}: ${run.ms} ms for ${r.sheets} Sheets — ${run.result}; /ocr/ ${run.ocrRequests} req, ${(run.ocrBodyBytes / 1048576).toFixed(2)} MiB body, ${run.ocrFromCache} from cache; OCR workers after ${run.ocrWorkersAfter}`);
        }
        console.log(`  cancel: OCR running ${r.cancel.sawOcr}, asked ${r.cancel.askedAfterMs} ms after the click; lock let go ${r.cancel.unlockedMs} ms after 読み取りを中止;`
            + ` OCR worker reported gone at ${r.cancel.workerGoneMs} ms (still listed at the unlock: ${r.cancel.ocrWorkersAtUnlock}); ${r.cancel.result}`);
        console.log(`  summary: first ${r.runs[0].ms} ms, repeat median ${median(r.runs.slice(1).map((x) => x.ms))} ms; off-origin requests ${r.offOrigin.length}`);
        if (OUT) {
            fs.writeFileSync(OUT, JSON.stringify({ browser: version, repeat: REPEAT, httpCache: HTTP_CACHE, throttle: THROTTLE, ...r }, null, 2));
            console.log(`  wrote ${OUT}`);
        }
        exitCode = r.offOrigin.length === 0 ? 0 : 1;
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
    process.exit(exitCode);
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
