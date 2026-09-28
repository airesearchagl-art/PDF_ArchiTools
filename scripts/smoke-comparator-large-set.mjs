/**
 * The large-set Comparison PDF gate (Output Writer v2).
 *
 * The reported failure: two A1 sets of five pages at 150 dpi could not be
 * exported as one Comparison PDF, and each exported page was ~50 MB of
 * uncompressed raster. This gate proves, on synthetic A1 drawings only:
 *
 *   - A1 x 5 x 2 members at 150 dpi is one export at the default 512 MiB,
 *     reopens with every page the sheet it came from, decodes pixel-for-pixel
 *     to the engine's composites, stays inside its owned bound, and is at
 *     least 90% smaller than the previous writer's uncompressed images;
 *   - 3 and 4 members at 150 dpi are accepted at 512 MiB;
 *   - 300 dpi: 2 members accepted at 1 GiB and written; 3 and 4 members
 *     refused by the output ceiling, with the requested DPI and pages intact;
 *   - 2 / 3 / 4 members with notices and mixed sheets, in order, pixel-exact;
 *   - the runtime ceiling fails typed and leaves nothing to publish;
 *   - the encode yields to the event loop, and a revoked run stops mid-page;
 *   - through the real UI: the estimate panel, one downloaded 5-page file, no
 *     download from a superseded export, and a typed refusal at 300 dpi x 3.
 *
 * Run: node scripts/smoke-comparator-large-set.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expectedSequence, SHEETS } from './make-comparator-members-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5206;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'comparator-large');
const DOWNLOADS = path.join(ROOT, 'test-fixtures', 'comparator-large-downloads');
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

if (!fs.existsSync(path.join(FIXTURES, 'a1-set-b.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-comparator-a1-fixtures.mjs')], { stdio: 'inherit' });
}
if (!fs.existsSync(path.join(FIXTURES, 'members-d.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-comparator-members-fixtures.mjs')], { stdio: 'inherit' });
}
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const mib = (b) => `${(b / MIB).toFixed(2)} MiB`;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 0,
});
const session = await browser.target().createCDPSession();
await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* blob:, data: */ }
};
async function newPage() {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('request', (r) => record(r.url()));
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', async (d) => { pageErrors.push(`dialog: ${d.message()}`); await d.dismiss(); });
    return page;
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

let exitCode = 1;
try {
    // ================================================================ harness
    const h = await newPage();
    await h.goto(`${ORIGIN}/scripts/smoke-comparator-large-set-harness.html`, { waitUntil: 'networkidle0' });
    await h.waitForFunction(() => window.__largeReady === true, { timeout: 300000 });

    // ---- A1 x 5 x 2 members at 150 dpi, default 512 MiB ------------------------
    console.log('\n=== A1 x 5 pages x 2 members, 150 dpi, 512 MiB ===');
    const a150 = await h.evaluate(() => window.__large.a1({ names: ['a1-set-a', 'a1-set-b'], dpi: 150, limit: 512 * 1024 * 1024 }));
    const f = a150.file;
    console.log(`  planned peak ${mib(a150.plan.jobPeak)} (${a150.plan.peakPhase}), output bound ${mib(a150.plan.outputBound)}`);
    console.log(`  written ${f.bytes.toLocaleString('en-US')} bytes in ${a150.ms} ms; the previous writer: `
        + `${a150.baseline.toLocaleString('en-US')} bytes; ${a150.stats.yields} yields, longest slice `
        + `${a150.stats.longestSliceMs.toFixed(1)} ms`);
    check('accepted at the default 512 MiB, as one job, at the requested 150 dpi and all five pages',
        a150.plan.refusal === null && a150.plan.jobPeak <= 512 * MIB
        && a150.plan.effectiveDpi === 150 && a150.plan.effectivePages.join(',') === '1,2,3,4,5',
        `${mib(a150.plan.jobPeak)} of 512 MiB`);
    check('one file, five pages, one image each, nothing omitted or duplicated',
        f.pages.length === 5 && f.pages.every((p) => p.images === 1)
        && a150.pairs.map((p) => p.page).join(',') === '1,2,3,4,5',
        `${f.pages.length} pages`);
    check('every page is the sheet it came from: physical size and orientation',
        f.pages.every((p, i) => near(p.width, a150.sheets[i][0], 72 / 150 + 0.01)
            && near(p.height, a150.sheets[i][1], 72 / 150 + 0.01)
            && (p.width > p.height) === (a150.sheets[i][0] > a150.sheets[i][1])),
        f.pages.map((p) => `${p.width}x${p.height}`).join(' '));
    check('source-page order and the verdict on every page',
        f.pages.every((p, i) => p.text === `${a150.pairs[i].title} — ${a150.pairs[i].verdict}`)
        && a150.pairs.map((p) => p.verdict).join(',') === 'MATCH,CHANGE,CHANGE,MATCH,CHANGE',
        a150.pairs.map((p) => `p${p.page} ${p.verdict}`).join(', '));
    check('no silent DPI reduction: every image is the full 150 dpi raster',
        f.pages.every((p, i) => p.imageWidth === a150.pairs[i].width && p.imageHeight === a150.pairs[i].height),
        f.pages.map((p) => `${p.imageWidth}x${p.imageHeight}`).join(' '));
    check('every page decodes to exactly the composite the engine painted',
        f.pages.every((p, i) => p.rgbHash === a150.pairs[i].hash), 'RGB hashed, 5/5 equal');
    check('the file is inside the owned bound the preflight charged',
        f.bytes <= a150.plan.fileBound && a150.appended.every((a) => a.encodedBytes <= a150.plan.perImageBound),
        `${f.bytes.toLocaleString('en-US')} <= ${a150.plan.fileBound.toLocaleString('en-US')} bytes`);
    const reduction = 1 - f.bytes / a150.baseline;
    check('at least 90% smaller than the previous uncompressed Comparison PDF',
        reduction >= 0.9, `${(reduction * 100).toFixed(2)}% smaller`);

    // ---- 3 and 4 members at 150 dpi ------------------------------------------
    console.log('\n=== A1 x 5 pages, 3 and 4 members, 150 dpi, 512 MiB ===');
    for (const names of [['a1-set-a', 'a1-set-b', 'a1-set-a'], ['a1-set-a', 'a1-set-b', 'a1-set-a', 'a1-set-b']]) {
        const r = await h.evaluate((n) => window.__large.a1({ names: n, dpi: 150, limit: 512 * 1024 * 1024, run: false }), names);
        console.log(`  ${names.length} members: ${r.plan.refusal ?? 'accepted'}, peak ${mib(r.plan.jobPeak)}, output bound ${mib(r.plan.outputBound)}, ${r.plan.items} images`);
        check(`${names.length} members: accepted at 512 MiB, all ${5 * (names.length - 1)} pairs planned`,
            r.plan.refusal === null && r.plan.items === 5 * (names.length - 1) && r.plan.jobPeak <= 512 * MIB);
    }

    // ---- 300 dpi ----------------------------------------------------------------
    console.log('\n=== A1 x 5 pages, 300 dpi ===');
    const a300at512 = await h.evaluate(() => window.__large.a1({ names: ['a1-set-a', 'a1-set-b'], dpi: 300, limit: 512 * 1024 * 1024, run: false }));
    const a300 = await h.evaluate(() => window.__large.a1({ names: ['a1-set-a', 'a1-set-b'], dpi: 300, limit: 1024 * 1024 * 1024, pixels: false }));
    console.log(`  2 members: 512 MiB ${a300at512.plan.refusal} (${mib(a300at512.plan.jobPeak)}, ${a300at512.plan.peakPhase}); `
        + `1 GiB ${a300.plan.refusal ?? 'accepted'} (${mib(a300.plan.jobPeak)}); written ${a300.file?.bytes?.toLocaleString('en-US')} bytes in ${a300.ms} ms`);
    probe('300 dpi x 2 members is refused at 512 MiB for memory, not quietly shrunk',
        a300at512.plan.refusal === 'OVER_MEMORY_BUDGET' && a300at512.sinkCallsOnRefused === 0
        && a300at512.plan.effectiveDpi === 300, a300at512.plan.reason ?? '');
    check('300 dpi x 2 members is accepted at 1 GiB and written: five pages, full raster, inside the bound',
        a300.plan.refusal === null && a300.file.pages.length === 5
        && a300.file.pages.every((p) => p.images === 1)
        && a300.appended.every((a, i) => a.width === a300.pairs[i].width)
        && a300.file.bytes <= a300.plan.fileBound
        && a300.file.pages.every((p, i) => near(p.width, a300.sheets[i][0], 72 / 300 + 0.01)),
        `${a300.file.bytes.toLocaleString('en-US')} bytes, bound ${a300.plan.fileBound.toLocaleString('en-US')}`);
    for (const [names, limit] of [[['a1-set-a', 'a1-set-b', 'a1-set-a'], GIB], [['a1-set-a', 'a1-set-b', 'a1-set-a'], 2 * GIB],
        [['a1-set-a', 'a1-set-b', 'a1-set-a', 'a1-set-b'], 2 * GIB]]) {
        const r = await h.evaluate((n, l) => window.__large.a1({ names: n, dpi: 300, limit: l, run: false }), names, limit);
        console.log(`  ${names.length} members at ${limit / GIB} GiB: ${r.plan.refusal} (output bound ${mib(r.plan.outputBound)})`);
        probe(`300 dpi x ${names.length} members at ${limit / GIB} GiB fails closed on the output ceiling, requested DPI and pages intact`,
            r.plan.refusal === 'OVER_OUTPUT_BUDGET' && r.plan.outputBound > 256 * MIB
            && r.plan.effectiveDpi === 300 && r.plan.effectivePages.join(',') === '1,2,3,4,5'
            && r.sinkCallsOnRefused === 0, r.plan.reason ?? '');
    }

    // ---- 2 / 3 / 4 members, notices, mixed sheets ------------------------------
    console.log('\n=== 2 / 3 / 4 members, notices, mixed sheets, 150 dpi ===');
    for (const letters of [['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) {
        const names = letters.map((l) => `members-${l.toLowerCase()}`);
        const r = await h.evaluate((n) => window.__large.members(n), names);
        const want = expectedSequence(letters);
        const got = r.expected;
        const pages = r.file.pages;
        console.log(`  ${letters.length} members: ${got.map((g) => (g.kind === 'PAIR' ? `p${g.page}/s${g.slot}/${g.verdict}` : `p${g.page}/${g.kind}`)).join(' ')}`);
        const orderOk = want.length === got.length && want.every((w, i) => got[i].page === w.page
            && (w.kind === 'PAIR' ? got[i].kind === 'PAIR' && got[i].slot === w.slot && got[i].verdict === w.verdict : got[i].kind === w.kind));
        check(`${letters.length} members: the file is exactly the spec's sequence — page, then slot, notices in place`,
            orderOk && pages.length === want.length
            && r.appended.every((a, i) => a.page === got[i].page && a.slot === got[i].slot),
            `${pages.length} pages expected ${want.length}`);
        const keys = got.map((g) => `${g.kind}:${g.page}:${g.slot}`);
        probe(`${letters.length} members: no pair omitted, none duplicated`,
            new Set(keys).size === keys.length && want.filter((w) => w.kind === 'PAIR').length === got.filter((g) => g.kind === 'PAIR').length);
        check(`${letters.length} members: labels, sizes and orientation on every page`,
            pages.every((p, i) => {
                const g = got[i];
                if (g.kind !== 'PAIR') return p.text === '' && p.width === 620 && p.height === 877;
                const sheet = SHEETS[g.page - 1];
                return p.text === `p${g.page}: members-a.pdf vs ${g.label} — ${g.verdict}`
                    && near(p.width, sheet[0], 72 / 150 + 0.01) && near(p.height, sheet[1], 72 / 150 + 0.01)
                    && (p.width > p.height) === (sheet[0] > sheet[1]);
            }));
        check(`${letters.length} members: every page decodes to its composite, every notice to its drawing`,
            pages.every((p, i) => p.rgbHash === got[i].hash && p.imageWidth === got[i].width && p.imageHeight === got[i].height));
    }

    // ---- runtime ceiling ---------------------------------------------------------
    console.log('\n=== the runtime ceiling ===');
    const ceil = await h.evaluate(() => window.__large.ceiling(300000));
    console.log(`  ${ceil.errorName} after ${ceil.pagesWritten} page(s): ${ceil.projected} > ${ceil.ceiling}; finish: ${ceil.finishError}`);
    probe('a file that would pass the runtime ceiling fails typed, mid-run',
        ceil.planAccepted && ceil.isOutputCeilingError && ceil.ceiling === 300000 && ceil.projected > 300000);
    probe('and leaves nothing to publish: no Blob can be made from the aborted writer',
        ceil.blob === null && ceil.finishError !== null, `finish() -> ${ceil.finishError}`);

    // ---- responsiveness and cancellation -------------------------------------------
    console.log('\n=== yielding, and a run revoked mid-encode ===');
    const cancel = await h.evaluate(() => window.__large.cancelMidEncode());
    console.log(`  one A1 page encoded in ${cancel.encodeMs.toFixed(0)} ms: the event loop ran ${cancel.ticksDuringEncode} times, `
        + `longest gap ${cancel.longestGapMs.toFixed(1)} ms; ${cancel.yields} yields`);
    check('the encoder gives the event loop control during a large encode',
        cancel.ticksDuringEncode >= 2 && cancel.yields >= 2 && cancel.longestGapMs < 250,
        `${cancel.ticksDuringEncode} timer tasks ran inside one page's encode`);
    probe('a revocation queued as the encode starts takes effect mid-page: nothing appended, nothing publishable',
        cancel.revokedDuringEncode && cancel.cancelled && cancel.appended === 0
        && cancel.abandoned === true && cancel.finishError !== null,
        `run ${cancel.runStatus}; finish() -> ${cancel.finishError}`);

    // ================================================================ the real UI
    console.log('\n=== through the real UI ===');
    const ui = await newPage();
    await ui.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await ui.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('PDF比較'))?.click(); });
    const upload = async (names) => {
        for (let i = 0; i < names.length; i += 1) {
            const input = await ui.waitForSelector(`[data-testid="file-input-${i}"]`);
            await input.uploadFile(path.join(FIXTURES, `${names[i]}.pdf`));
            await ui.waitForFunction((n) => document.body.textContent?.includes(n), {}, `${names[i]}.pdf`);
        }
    };
    const settle = async () => {
        for (;;) {
            const busy = await ui.evaluate(() => !!(document.querySelector('[data-testid="comparator-busy"]')
                || document.querySelector('[data-testid="exporting-overlay"]')));
            if (!busy) return;
            await wait(150);
        }
    };
    const finished = () => fs.readdirSync(DOWNLOADS).filter((n) => !n.endsWith('.crdownload'));
    const openSettings = () => ui.evaluate(() => {
        if (document.querySelector('[data-testid="dpi"]')) return;
        [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Export Settings')?.click();
    });
    await upload(['a1-set-a', 'a1-set-b']);
    await settle();
    await openSettings();
    await ui.waitForSelector('[data-testid="export-estimate-status"]');
    await ui.waitForFunction(() => document.querySelector('[data-testid="export-estimate"]')?.textContent?.includes('5 ページ'));
    const estimate = await ui.evaluate(() => document.querySelector('[data-testid="export-estimate"]').textContent);
    console.log(`  estimate: ${estimate}`);
    check('the export panel states DPI, pages, sheet, memory, a guaranteed output ceiling, and the status',
        estimate.includes('150 DPI') && estimate.includes('5 ページ') && estimate.includes('841 × 594 mm')
        && estimate.includes('上限 512 MiB') && estimate.includes('（安全上限）')
        && estimate.includes('実際のサイズは図面内容により小さくなります') && estimate.includes('出力できます'));

    await ui.click('[data-testid="export-pdf"]');
    let file = null;
    for (const until = Date.now() + 600000; Date.now() < until;) {
        const [name] = finished();
        if (name) {
            const size = fs.statSync(path.join(DOWNLOADS, name)).size;
            await wait(300);
            if (fs.statSync(path.join(DOWNLOADS, name)).size === size) { file = name; break; }
        }
        await wait(250);
    }
    await settle();
    let downloaded = null;
    if (file) {
        const data = new Uint8Array(fs.readFileSync(path.join(DOWNLOADS, file)));
        const bytes = data.length;
        // pdf.js transfers the buffer it is given; hand it a copy.
        const doc = await pdfjs.getDocument({ data: data.slice(), verbosity: 0, isEvalSupported: false }).promise;
        const pages = [];
        for (let n = 1; n <= doc.numPages; n += 1) {
            const p = await doc.getPage(n);
            const [x0, y0, x1, y1] = p.view;
            pages.push({ w: x1 - x0, h: y1 - y0, text: (await p.getTextContent()).items.map((i) => i.str).join(' ') });
        }
        await doc.destroy();
        downloaded = { name: file, bytes, pages };
    }
    console.log(`  downloaded ${downloaded?.name} ${downloaded?.bytes?.toLocaleString('en-US')} bytes, ${downloaded?.pages.length} pages`);
    check('one click, one download: all five A1 pages in one Comparison PDF at 150 dpi',
        downloaded && /^comparison_a1-set-a_150dpi\.pdf$/.test(downloaded.name) && downloaded.pages.length === 5
        && downloaded.pages.every((p, i) => near(p.w, a150.sheets[i][0], 0.5) && near(p.h, a150.sheets[i][1], 0.5))
        && downloaded.pages.every((p, i) => p.text.startsWith(`p${i + 1}: a1-set-a.pdf vs a1-set-b.pdf — `)),
        downloaded ? `${(downloaded.bytes / 1e6).toFixed(2)} MB` : 'no file');
    check('and it is the size the harness wrote for the same job, well under the ceiling',
        downloaded && downloaded.bytes === f.bytes && downloaded.bytes < 256 * MIB,
        downloaded ? `${downloaded.bytes} = ${f.bytes}` : '');
    for (const n of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, n), { force: true });

    // A superseded export: started, then the DPI is changed while it runs.
    await ui.click('[data-testid="export-pdf"]');
    await ui.waitForSelector('[data-testid="exporting-overlay"]');
    await wait(1500);
    await openSettings();
    await ui.select('[data-testid="dpi"]', '72');
    await settle();
    await wait(8000);
    probe('an export superseded while it runs writes nothing', finished().length === 0, `${finished().length} files`);
    await ui.select('[data-testid="dpi"]', '150');

    // 300 dpi x 3 members, 2 GiB: refused by name, requested settings intact.
    const input2 = await ui.waitForSelector('[data-testid="file-input-2"]');
    await input2.uploadFile(path.join(FIXTURES, 'a1-set-a.pdf'));
    await settle();
    await openSettings();
    await ui.select('[data-testid="dpi"]', '300');
    await ui.select('[data-testid="memory-budget"]', String(2 * GIB));
    await settle();
    // The preview of the current page also plans at these settings, and at
    // 300 dpi x 3 members its own single-page plan is refused too (2 visuals,
    // 1 page requested). A refusal on screen is therefore not evidence about
    // the export: the assertion is bound to the export plan's own numbers --
    // all 5 pages requested, 10 comparison visuals, a ~333 MiB output bound --
    // which the one-page preview refusal cannot show.
    const refusalText = () => ui.evaluate(
        () => document.querySelector('[data-testid="preflight-refusal"]')?.textContent ?? '');
    const isExportRefusal = (t) => t.includes('OVER_OUTPUT_BUDGET') && t.includes('比較 10 枚')
        && t.includes('/ 333 MiB') && t.includes('要求: 5 ページ');
    const beforeClick = await refusalText();
    // The estimate is planned asynchronously after each settings change; give it
    // time to reach the settings now on screen before reading it.
    const estimateSettled = await ui.waitForFunction(() => {
        const t = document.querySelector('[data-testid="export-estimate"]')?.textContent ?? '';
        return t.includes('333 MiB');
    }, { timeout: 30000 }).then(() => true, () => false);
    const estimateBefore = await ui.evaluate(
        () => document.querySelector('[data-testid="export-estimate"]')?.textContent ?? '');
    console.log(`  estimate settled on the 3-member plan: ${estimateSettled}`);
    // Every Blob the page could publish goes through URL.createObjectURL
    // (file-saver's saveAs does); count them from here on.
    await ui.evaluate(() => {
        window.__objectUrls = 0;
        const original = URL.createObjectURL;
        URL.createObjectURL = function counted(...args) {
            window.__objectUrls += 1;
            return original.apply(this, args);
        };
    });
    await ui.click('[data-testid="export-pdf"]');
    // The same predicate as isExportRefusal, evaluated in the page.
    await ui.waitForFunction(() => {
        const t = document.querySelector('[data-testid="preflight-refusal"]')?.textContent ?? '';
        return t.includes('OVER_OUTPUT_BUDGET') && t.includes('比較 10 枚')
            && t.includes('/ 333 MiB') && t.includes('要求: 5 ページ');
    }, { timeout: 180000 });
    await settle();
    await wait(5000);
    const after = await ui.evaluate(() => ({
        text: document.querySelector('[data-testid="preflight-refusal"]')?.textContent ?? '',
        status: document.querySelector('[data-testid="refusal-status"]')?.textContent ?? '',
        dpi: document.querySelector('[data-testid="dpi"]')?.value,
        scopeAll: [...document.querySelectorAll('label')]
            .find((l) => l.textContent?.includes('All Pages'))
            ?.querySelector('input[type="radio"]')?.checked ?? null,
        objectUrls: window.__objectUrls,
        overlay: document.querySelector('[data-testid="exporting-overlay"]') !== null,
    }));
    console.log(`  300 dpi x 3, estimate: ${estimateBefore}`);
    console.log(`  300 dpi x 3, before the click: ${beforeClick.slice(0, 140) || '(no refusal shown)'}`);
    console.log(`  300 dpi x 3, after Export:     ${after.text.slice(0, 160)}`);
    check('the refusal shown before the click is not the export plan (the gate can tell them apart)',
        !isExportRefusal(beforeClick), beforeClick ? 'a one-page preview refusal' : 'none shown');
    check('the export settings plan the same export: 5 pages, refused on the ~333 MiB output bound',
        estimateBefore.includes('5 ページ（1–5）') && estimateBefore.includes('300 DPI')
        && estimateBefore.includes('出力できません') && estimateBefore.includes('比較 10 枚')
        && estimateBefore.includes('333 MiB'));
    probe('Export at 300 dpi x 3 members x 2 GiB is refused by the export plan itself: all 5 pages, 10 visuals, ~333 MiB',
        isExportRefusal(after.text) && after.status === 'OVER_OUTPUT_BUDGET',
        after.text.slice(0, 120));
    probe('and nothing is reduced, published or written: DPI 300, all pages, no Blob URL, no download',
        after.dpi === '300' && after.scopeAll === true && after.objectUrls === 0
        && !after.overlay && finished().length === 0,
        `dpi ${after.dpi}, scope all ${after.scopeAll}, object URLs ${after.objectUrls}, files ${finished().length}`);

    check('no network request left the machine', external.length === 0, external.slice(0, 3).join(' '));
    check('no page error and no alert', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
    console.error(error);
    exitCode = 1;
} finally {
    await browser.close();
    await server.close();
    const out = path.join(ROOT, 'test-fixtures', 'smoke-comparator-large-set-results.json');
    fs.writeFileSync(out, JSON.stringify(checks, null, 2));
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n  ${checks.length - failed}/${checks.length} checks passed, ${checks.filter((c) => c.name.startsWith('negative probe')).length} of them negative probes`);
    process.exit(exitCode);
}
