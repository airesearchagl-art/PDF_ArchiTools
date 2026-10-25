/**
 * M7-ADV-VERIFY-01 (ADV-37-03, T-R4 / T-R5): how long a cancel takes at each
 * stage of the recogniser's start and during a recognition, under a slow
 * network with the HTTP cache off. Local evidence, not a CI gate and not a
 * threshold: nothing here decides whether a target is met.
 *
 * Through the M7-P2-B2 harness (smoke-m7-p2b2-harness.html) on the Vite dev
 * server, which drives the Production modules with the real recogniser and
 * records, on the page's clock, when each of the Worker's jobs was asked and
 * answered: the cancel is made inside the named stage -- 'load' (the core),
 * 'loadLanguage' (the language data), 'initialize' -- or while the Worker
 * reports recognising ('recognize'). This is not the built app of
 * bench-m7-p2b2-ocr.mjs; the network conditions are applied to the page and
 * to every Worker target, so the Worker's own fetches are slowed too.
 *
 *   node scripts/bench-m7-adv-cancel.mjs [--browser=<path>] [--repeat=3] [--http-cache=off|on]
 *       [--throttle=10:40] [--stages=load,loadLanguage,initialize,recognize] [--out=<file.json>]
 *
 * Needs the P2-A fixtures (node scripts/make-m7-p1-fixtures.mjs). Synthetic PDFs only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5219;
const ORIGIN = `http://localhost:${PORT}`;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserArg = arg('browser') || process.env.M7_BROWSER || '';
const REPEAT = Number(arg('repeat') || 3);
const OUT = arg('out');
const HTTP_CACHE = arg('http-cache') === 'on' ? 'on' : 'off';
const STAGES = (arg('stages') || 'load,loadLanguage,initialize,recognize').split(',');
const THROTTLE = (() => {
    const [mbps, latency] = (arg('throttle') || '10:40').split(':').map(Number);
    return { mbps, latency, download: (mbps * 1e6) / 8, upload: (mbps * 1e6) / 8 };
})();
const median = (xs) => {
    const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

async function main() {
    const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
    await server.listen();
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], ...(browserArg ? { executablePath: browserArg } : {}) });
    const external = [];
    const conditions = { offline: false, latency: THROTTLE.latency, downloadThroughput: THROTTLE.download, uploadThroughput: THROTTLE.upload };
    const workerSessions = [];
    // Every Worker target gets the same conditions and cache setting as the page.
    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'worker') return;
        try {
            const session = await target.createCDPSession();
            await session.send('Network.enable');
            await session.send('Network.emulateNetworkConditions', conditions);
            if (HTTP_CACHE === 'off') await session.send('Network.setCacheDisabled', { cacheDisabled: true });
            session.on('Network.requestWillBeSent', (e) => { if (!e.request.url.startsWith(ORIGIN) && /^https?:/.test(e.request.url)) external.push(e.request.url); });
            workerSessions.push(target.url());
        } catch { /* gone before it could be set */ }
    });
    const results = [];
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        page.on('request', (r) => { if (!r.url().startsWith(ORIGIN) && /^https?:/.test(r.url())) external.push(r.url()); });
        await page.exposeFunction('__browserOcrWorkers', () => page.workers().filter((w) => /\/ocr\//.test(w.url())).length);
        await page.goto(`${ORIGIN}/scripts/smoke-m7-p2b2-harness.html`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.__m7p2b2Ready === true, { timeout: 300000 });
        // Conditions applied once the harness is loaded: the bench measures the recogniser, not the harness's start.
        if (HTTP_CACHE === 'off') await page.setCacheEnabled(false);
        await page.emulateNetworkConditions({ download: THROTTLE.download, upload: THROTTLE.upload, latency: THROTTLE.latency });
        const browserLabel = await browser.version();
        console.log(`browser ${browserLabel}; ${THROTTLE.mbps} Mbit/s + ${THROTTLE.latency} ms; HTTP cache ${HTTP_CACHE}; ${REPEAT} per stage`);
        for (const stage of STAGES) {
            for (let i = 1; i <= REPEAT; i++) {
                const which = `ST:${stage}`;
                const out = (await page.evaluate((w) => window.__m7p2b2.ocrInit(w), which))[which];
                const row = {
                    stage, run: i, caughtInStage: Boolean(out.caught && !out.caught.missed), sinceAskedMs: out.caught?.sinceAskedMs ?? null,
                    unlockMs: out.unlockMs, workerEnded: out.workerEnded, workerEndedMs: out.workerEndedMs, browserGoneMs: out.browserGoneMs,
                    outcome: out.report?.outcome ?? null, committed: out.report?.committed ?? null, unconfirmed: out.counts?.unconfirmed ?? null,
                    timeline: out.timeline,
                };
                results.push(row);
                console.log(`${stage.padEnd(12)} #${i}  in-stage ${row.caughtInStage}  unlock ${row.unlockMs} ms  ended ${row.workerEnded} @ ${row.workerEndedMs} ms  browser-none ${row.browserGoneMs} ms  ${row.outcome}`);
            }
        }
        const summary = Object.fromEntries(STAGES.map((stage) => {
            const rows = results.filter((r) => r.stage === stage && r.caughtInStage);
            return [stage, {
                runsInStage: rows.length, of: REPEAT,
                unlockMs: { median: median(rows.map((r) => r.unlockMs)), max: Math.max(...rows.map((r) => r.unlockMs ?? -1)) },
                workerEndedMs: { median: median(rows.map((r) => r.workerEndedMs)), max: Math.max(...rows.map((r) => r.workerEndedMs ?? -1)) },
                browserGoneMs: { median: median(rows.map((r) => r.browserGoneMs)), max: Math.max(...rows.map((r) => r.browserGoneMs ?? -1)) },
                ends: [...new Set(rows.map((r) => r.workerEnded))], outcomes: [...new Set(rows.map((r) => r.outcome))],
            }];
        }));
        const report = {
            what: 'M7-ADV-VERIFY-01 cancel timing by stage (local measurement; not a target)', browser: browserLabel,
            conditions: { throttle: THROTTLE, httpCache: HTTP_CACHE, workerTargetsConditioned: workerSessions.length, server: 'vite dev (harness)' },
            summary, results, external,
        };
        console.log(JSON.stringify(summary, null, 2));
        if (external.length) console.log(`EXTERNAL REQUESTS: ${external.join(', ')}`);
        if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
