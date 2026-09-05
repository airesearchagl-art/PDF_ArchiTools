/**
 * Gate for the Textifier's first-page preview, against the PRODUCTION build.
 *
 * The preview is the only confirmation a person gets that the file they picked
 * is the file the tool opened. A blank frame where the drawing should be reads
 * as a broken or empty PDF, and there is nothing on screen to say otherwise.
 *
 * A canvas with a size is not a canvas with a picture on it, so this reads the
 * pixels. It then compares what the app drew against the same page rendered
 * independently through the current PDF.js API, because "something was drawn"
 * is a much weaker claim than "the page was drawn".
 *
 * Run:  npm run build && node scripts/smoke-textifier-preview.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview, createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 5190;
const CONTROL_PORT = 5191;
const ORIGIN = `http://localhost:${APP_PORT}`;
const CONTROL_ORIGIN = `http://localhost:${CONTROL_PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
/** The width the Textifier fits its preview thumbnail to. */
const PREVIEW_CSS_WIDTH = 300;

const CASES = ['text-native-ja-en.pdf', 'scanned-ja-en.pdf'];

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, CASES[0]))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const appServer = await preview({ root: ROOT, preview: { port: APP_PORT, strictPort: true }, logLevel: 'warn' });
const controlServer = await createServer({
    root: ROOT, server: { port: CONTROL_PORT, strictPort: true }, logLevel: 'warn',
});
await controlServer.listen();

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.setDefaultTimeout(30_000);

const pageErrors = [];
const consoleErrors = [];
const external = [];
const workerRequests = [];
/** Only the app's own traffic is judged; the control harness is test scaffolding. */
const record = (url) => {
    if (!url) return;
    if (url.includes('pdf.worker')) workerRequests.push(url);
    if (url.startsWith(ORIGIN) || url.startsWith(CONTROL_ORIGIN)) return;
    if (/^https?:/.test(url)) external.push(url);
};
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('request', (r) => record(r.url()));
// A PDF.js worker runs in its own target, whose traffic page-level events miss.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* target already gone */ }
});

/** How much of the two ink grids agree, and how far apart their coverage is. */
function compare(app, control) {
    if (!app?.grid || !control?.grid) return { agreement: 0, inkRatioFactor: Infinity };
    let same = 0;
    for (let i = 0; i < 256; i++) if (app.grid[i] === control.grid[i]) same++;
    const factor = control.inkRatio > 0
        ? Math.max(app.inkRatio, control.inkRatio) / Math.max(1e-9, Math.min(app.inkRatio, control.inkRatio))
        : Infinity;
    return { agreement: +(same / 256).toFixed(3), inkRatioFactor: +factor.toFixed(2) };
}

let exitCode = 1;
try {
    // ---- the control: what the page actually looks like ---------------------
    const control = await browser.newPage();
    control.setDefaultTimeout(60_000);
    await control.goto(`${CONTROL_ORIGIN}/scripts/smoke-preview-control.html`, { waitUntil: 'networkidle0' });
    await control.waitForFunction(() => window.__control?.ready === true, { timeout: 120_000 });

    const reference = {};
    for (const fixture of CASES) {
        reference[fixture] = await control.evaluate(
            (f, w) => window.__control.render(f, w), fixture, PREVIEW_CSS_WIDTH);
        const r = reference[fixture];
        console.log(`  control ${fixture.padEnd(24)} ${r.width}x${r.height} ink=${r.ink} ratio=${r.inkRatio} bbox=${JSON.stringify(r.bbox)}`);
        check(`control: ${fixture} really has ink to find`, r.ink > 0 && r.bbox !== null,
            `ink=${r.ink}`);
    }
    // The ink-stats helper is defined in the control harness; the app page has
    // no module of its own to import, so it is installed there directly.
    const inkStatsSource = await control.evaluate(() => window.__inkStats.toString());

    // ---- the app ------------------------------------------------------------
    // The app tab has to be the front one. PDF.js schedules display-intent
    // rendering on requestAnimationFrame, which does not fire in a hidden tab,
    // so the render promise would never settle and this gate would be measuring
    // a background-tab quirk instead of the preview. A person looking at the
    // preview is, by definition, looking at the tab.
    await page.bringToFront();
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('PDFテキスト化'));
        if (!b) throw new Error('PDFテキスト化 tab not found');
        b.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
    check('PDFテキスト化 opens', true);

    /**
     * Open the tool fresh, pick one file, and report what the preview holds.
     *
     * Reloading matters. The defect this gate exists for only ever hit the
     * first file of a session -- the canvas the preview draws onto is not in
     * the tree until a file is selected, so the very first render had nothing
     * to draw on, while every file after it inherited the canvas the previous
     * one had left behind. A gate that uploaded two files in one session would
     * have caught the first and been reassured by the second.
     */
    const openFresh = async () => {
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
            [...document.querySelectorAll('button')]
                .find((x) => (x.textContent || '').includes('PDFテキスト化')).click();
        });
        await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
        await page.evaluate((src) => { window.__inkStats = eval(`(${src})`); }, inkStatsSource);
    };

    const upload = async (fixture) => {
        const input = await page.$('input[type="file"]');
        await input.uploadFile(path.join(FIXTURES, fixture));
        await page.waitForFunction((n) => document.body.innerText.includes(n), {}, fixture);
    };

    for (const fixture of CASES) {
        console.log(`\n=== ${fixture} (first file of a fresh session) ===`);
        await openFresh();
        await upload(fixture);

        // Wait for the preview to be drawn, not merely to exist. A canvas that
        // never gets painted keeps its default 300x150 and stays transparent,
        // which is exactly the failure this gate is here for -- so the wait has
        // to time out rather than hang, and the checks below report it.
        let drawn = true;
        try {
            await page.waitForFunction(() => {
                const c = document.querySelector('canvas');
                if (!c || c.width === 0 || c.height === 0) return false;
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] !== 0 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 200) return true;
                }
                return false;
            }, { timeout: 15_000 });
        } catch {
            drawn = false;
        }

        const app = await page.evaluate(() => {
            const c = document.querySelector('canvas');
            if (!c) return null;
            const ctx = c.getContext('2d');
            return { ...window.__inkStats(ctx, c.width, c.height), cssWidth: Math.round(c.getBoundingClientRect().width) };
        });
        console.log(`  app     ${String(app?.width)}x${String(app?.height)} ink=${app?.ink} ratio=${app?.inkRatio} bbox=${JSON.stringify(app?.bbox)} drawnWithin15s=${drawn}`);

        const ref = reference[fixture];
        const cmp = compare(app, ref);
        console.log(`  compare agreement=${cmp.agreement} inkRatioFactor=${cmp.inkRatioFactor}`);

        check(`${fixture}: the preview canvas exists`, app !== null);
        check(`${fixture}: the preview canvas has a real size`,
            (app?.width ?? 0) > 0 && (app?.height ?? 0) > 0, `${app?.width}x${app?.height}`);
        check(`${fixture}: the canvas is sized from the page, not left at the 300x150 default`,
            app?.width !== 300 || app?.height !== 150, `${app?.width}x${app?.height}`);
        check(`${fixture}: the preview is fitted to the thumbnail width`,
            Math.abs((app?.width ?? 0) - PREVIEW_CSS_WIDTH) <= 2, String(app?.width));
        // The check the whole gate exists for: a blank canvas must never pass.
        check(`${fixture}: the preview actually has ink on it`, (app?.ink ?? 0) > 0, `ink=${app?.ink}`);
        check(`${fixture}: the preview is not a blank sheet`, (app?.nonWhite ?? 0) > 0,
            `nonWhite=${app?.nonWhite}`);
        check(`${fixture}: what was drawn matches the page itself`,
            cmp.agreement >= 0.95 && cmp.inkRatioFactor <= 2,
            `agreement=${cmp.agreement} inkRatioFactor=${cmp.inkRatioFactor}`);
        check(`${fixture}: the ink lands where the page has it`,
            app?.bbox !== null && ref.bbox !== null
            && Math.abs(app.bbox.x0 - ref.bbox.x0) <= 0.05 && Math.abs(app.bbox.y0 - ref.bbox.y0) <= 0.05
            && Math.abs(app.bbox.x1 - ref.bbox.x1) <= 0.05 && Math.abs(app.bbox.y1 - ref.bbox.y1) <= 0.05,
            `app=${JSON.stringify(app?.bbox)} control=${JSON.stringify(ref.bbox)}`);
    }

    // ---- a second file in the same session still works ----------------------
    console.log('\n=== second file in the same session ===');
    await openFresh();
    await upload(CASES[0]);
    await upload(CASES[1]);
    // Wait for the preview to show the SECOND page, not the first one still on
    // screen. Both fixtures are 300 wide and their ink coverage is within 3% of
    // each other, so neither size nor density tells them apart -- only where the
    // ink sits does. Waiting on the same grid the check below uses.
    await page.waitForFunction((expectedGrid) => {
        const c = document.querySelector('canvas');
        if (!c || !c.width) return false;
        const s = window.__inkStats(c.getContext('2d'), c.width, c.height);
        if (!s.ink) return false;
        let same = 0;
        for (let i = 0; i < 256; i++) if (s.grid[i] === expectedGrid[i]) same++;
        return same / 256 >= 0.95;
    }, { timeout: 15_000 }, reference[CASES[1]].grid).catch(() => { });
    const second = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        return c ? window.__inkStats(c.getContext('2d'), c.width, c.height) : null;
    });
    const secondCmp = compare(second, reference[CASES[1]]);
    console.log(`  app     ${String(second?.width)}x${String(second?.height)} ink=${second?.ink} agreement=${secondCmp.agreement}`);
    check('replacing the file redraws the preview for the new one',
        (second?.ink ?? 0) > 0 && secondCmp.agreement >= 0.95,
        `ink=${second?.ink} agreement=${secondCmp.agreement}`);

    // ---- network -------------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueWorkers = [...new Set(workerRequests)];
    for (const w of uniqueWorkers) console.log(`  worker: ${w}`);
    check('a PDF.js worker was actually requested', uniqueWorkers.length > 0, String(uniqueWorkers.length));
    check('every PDF.js worker request is same-origin',
        uniqueWorkers.every((u) => u.startsWith(`${ORIGIN}/pdf.worker.min.mjs`)
            || u.startsWith(`${CONTROL_ORIGIN}/pdf.worker.min.mjs`)),
        uniqueWorkers.join(' | '));
    check('no unpkg or CDN worker request', !uniqueWorkers.some((u) => /unpkg|jsdelivr|cdnjs/.test(u)));

    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external HTTP request while the preview renders', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);

    console.log('\n=== errors ===');
    for (const e of [...new Set(consoleErrors)]) console.log(`  console.error: ${e}`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    // The component swallows a failed preview into console.error and shows the
    // user an empty frame, so a silent console is part of the contract.
    check('the preview reported no render error',
        !consoleErrors.some((e) => e.includes('Preview render error')),
        consoleErrors.filter((e) => e.includes('Preview render error')).slice(0, 1).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    await browser.close().catch(() => { });
    await appServer.close().catch(() => { });
    await controlServer.close().catch(() => { });
    process.exit(exitCode);
}
