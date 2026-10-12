/**
 * M7-P2-A: what it costs that M7's recogniser keeps no language data cache.
 *
 * Local evidence for the HD-P2A-01 repair, not a CI gate. tesseract.js by
 * default stores the language data it downloads in IndexedDB, from inside its
 * worker, and the next worker reads it from there; M7's engine says
 * cacheMethod 'none', so every worker fetches the language data from this
 * origin again. This measures both, in the same browser, against the same
 * Vite dev server as the foundation smoke:
 *
 *   m7       the engine as shipped (GuardedRegisterOcr, cacheMethod 'none')
 *   pre-fix  the same engine with tesseract.js's default cache, as it was
 *            before the repair
 *
 * Each mode runs two series, each in a fresh browser context (storage and
 * HTTP cache of its own):
 *   init     a recogniser started and closed, N times in a row -- first and
 *            repeated initialisation, with the core, language and initialise
 *            jobs timed separately
 *   extract  one extraction over two Sources (the register and JPX
 *            fixtures, 9 Sheets), N times in a row -- total time, recognition
 *            time
 * Every request is recorded with its path, status and body size, so the
 * language data downloads (and HTTP revalidations) sit next to the times.
 *
 * Locally the dev server answers a repeated download with 304 from the
 * browser's HTTP cache, which is the best case for 'none'. Two options show the
 * rest: --http-cache=off disables the HTTP cache for the page and its workers
 * (every run downloads the language data in full: the worst case), and
 * --throttle=<Mbit/s>:<latency ms> emulates a slower connection.
 *
 *   node scripts/bench-m7-p2a-ocr-cache.mjs [--browser=<path>] [--repeat=3] [--http-cache=off]
 *       [--throttle=10:40] [--out=<file.json>]
 *
 * Needs the P2-A fixtures (node scripts/make-m7-p1-fixtures.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5217;
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

const manifestPath = path.join(ROOT, 'test-fixtures', 'm7-p2a', 'manifest.json');
if (!fs.existsSync(manifestPath)) {
    console.error('No P2-A fixtures. Run: node scripts/make-m7-p1-fixtures.mjs');
    process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const truths = Object.fromEntries(['p2a-register', 'p2a-jpx'].map((name) => [name, manifest.files.find((f) => f.name === name).truth]));

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)) : null;
};
const jobMs = (jobs, action) => jobs.filter((j) => j.action === action).map((j) => j.ms);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

async function series(browser, mode, what) {
    const context = await browser.createBrowserContext();
    const requests = [];
    const errors = [];
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(0);
        if (HTTP_CACHE === 'off') await page.setCacheEnabled(false);
        if (THROTTLE) await page.emulateNetworkConditions({ download: THROTTLE.download, upload: THROTTLE.upload, latency: THROTTLE.latency });
        page.on('requestfinished', (r) => {
            const res = r.response();
            requests.push({
                url: r.url(),
                status: res?.status() ?? null,
                bytes: res && res.status() === 200 ? Number(res.headers()['content-length'] ?? NaN) : 0,
                fromCache: res?.fromCache() ?? false,
            });
        });
        page.on('requestfailed', (r) => requests.push({ url: r.url(), status: 'failed', bytes: 0, fromCache: false }));
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${ORIGIN}/scripts/smoke-m7-p2a-harness.html`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.__m7p2aReady === true, { timeout: 300000 });
        const steps = [];
        for (let i = 1; i <= REPEAT; i++) {
            const from = requests.length;
            const step = await page.evaluate((a) => window.__m7p2a.ocrBenchStep(a), { mode, what, truths });
            await new Promise((resolve) => setTimeout(resolve, 300)); // let the last requestfinished events arrive
            const own = requests.slice(from);
            const ocrAssets = own.filter((r) => r.url.startsWith(`${ORIGIN}/ocr/`));
            const lang = ocrAssets.filter((r) => r.url.includes('/ocr/tessdata/'));
            steps.push({
                run: i,
                ...step,
                network: {
                    offOrigin: own.filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(ORIGIN)).map((r) => r.url),
                    ocrAssets: ocrAssets.map((r) => ({ path: r.url.slice(ORIGIN.length), status: r.status, bytes: r.bytes, fromCache: r.fromCache })),
                    languageRequests: lang.length,
                    languageBodyBytes: sum(lang.map((r) => r.bytes || 0)),
                    ocrAssetBodyBytes: sum(ocrAssets.map((r) => r.bytes || 0)),
                },
            });
        }
        return { mode, what, steps, errors };
    } finally {
        await context.close().catch(() => { });
    }
}

function describe(step) {
    const j = step.jobs;
    const base = `run ${step.run}: cacheMethod ${JSON.stringify(step.cacheMethods)}`
        + ` load ${sum(jobMs(j, 'load'))} ms, loadLanguage ${sum(jobMs(j, 'loadLanguage'))} ms, initialize ${sum(jobMs(j, 'initialize'))} ms`;
    const net = `tessdata ${step.network.languageRequests} req ${JSON.stringify(step.network.ocrAssets.filter((r) => r.path.includes('tessdata')).map((r) => r.status))}`
        + ` ${(step.network.languageBodyBytes / 1048576).toFixed(2)} MiB; /ocr/ total ${(step.network.ocrAssetBodyBytes / 1048576).toFixed(2)} MiB`;
    const idb = `IndexedDB ${JSON.stringify(step.storage.contents)}`;
    const workers = `workers +${step.workersStarted}/-${step.workersEnded}, live ${step.workersLive}`;
    if (step.what === 'init') return `${base}; start ${step.initMs} ms, close ${step.closeMs} ms; ${net}; ${workers}; ${idb}`;
    const rec = jobMs(j, 'recognize');
    return `${base}; total ${step.totalMs} ms (${step.outcome}, ${step.observed}/${step.sheets} observed, ${step.ocrValues} OCR values, ${step.ocrCalls} OCR calls)`
        + `; recognize ${rec.length} x, ${sum(rec)} ms; ${net}; ${workers}; ${idb}`;
}

async function main() {
    const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
    await server.listen();
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...(browserArg ? { executablePath: browserArg } : {}),
    });
    const version = await browser.version();
    const conditions = `HTTP cache ${HTTP_CACHE}; network ${THROTTLE ? `${THROTTLE.mbps} Mbit/s, ${THROTTLE.latency} ms latency` : 'unthrottled (localhost)'}`;
    console.log(`browser: ${version}${browserArg ? ` (${browserArg})` : ' (bundled)'}; repeat ${REPEAT}; ${conditions}`);
    const results = [];
    try {
        for (const what of ['init', 'extract']) {
            for (const mode of ['pre-fix', 'm7']) {
                const r = await series(browser, mode, what);
                results.push(r);
                console.log(`\n=== ${what} / ${mode} (fresh context) ===`);
                for (const step of r.steps) console.log(`  ${describe(step)}`);
                if (r.errors.length) console.log(`  page errors: ${r.errors.join(' | ')}`);
            }
        }
        console.log('\n=== Summary (medians of runs 2..N are "repeat") ===');
        for (const r of results) {
            const first = r.steps[0];
            const rest = r.steps.slice(1);
            const key = r.what === 'init' ? 'initMs' : 'totalMs';
            console.log(`  ${r.what.padEnd(7)} ${r.mode.padEnd(7)} first ${first[key]} ms, repeat median ${median(rest.map((s) => s[key]))} ms;`
                + ` loadLanguage first ${sum(jobMs(first.jobs, 'loadLanguage'))} ms, repeat median ${median(rest.map((s) => sum(jobMs(s.jobs, 'loadLanguage'))))} ms;`
                + ` recognize median ${median(r.steps.flatMap((s) => jobMs(s.jobs, 'recognize')))} ms;`
                + ` tessdata body MiB per run ${r.steps.map((s) => (s.network.languageBodyBytes / 1048576).toFixed(2)).join(' / ')};`
                + ` off-origin ${sum(r.steps.map((s) => s.network.offOrigin.length))}`);
        }
        if (OUT) {
            fs.writeFileSync(OUT, JSON.stringify({ browser: version, repeat: REPEAT, httpCache: HTTP_CACHE, throttle: THROTTLE, results }, null, 2));
            console.log(`\nwrote ${OUT}`);
        }
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
