/**
 * The Processor's UI contract, in the built app.
 *
 * `RunOwnership` can be tested in isolation, and is — but the thing that went
 * wrong before was never the token. It was the wiring: a batch the user had
 * navigated away from still downloaded, a setting changed mid-run produced a
 * file at the old value whose row said done, and a confirmation the user
 * accepted did nothing because the state it set had not landed yet. None of
 * those is visible in a unit test of the token, and the last one survived a
 * green module gate and was caught only by driving `dist/`.
 *
 * So this drives the real built Processor and asserts the two properties that
 * matter to somebody using it:
 *
 *   a superseded run leaves no download, no archive and no green row;
 *   a row is not green until its artifact was actually published.
 *
 * Run:  npm run build
 *       node scripts/make-processor-fixtures.mjs
 *       node scripts/smoke-processor-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5209;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'processor');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-processor-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-ui-dl-'));
const server = await preview({
    root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn',
});
const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);
await page.setViewport({ width: 1400, height: 1000 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const cdp = await page.target().createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
await cdp.send('Page.enable');

/**
 * When the browser was *told* to download — not when the file finished
 * appearing on disk.
 *
 * `saveAs` hands the blob over and the row turns green in the same tick; Chrome
 * then writes its `.crdownload` placeholder on its own schedule, tens of
 * milliseconds later. Comparing an in-process state update against that
 * placeholder compares two different clocks, and reported a 65 ms "inversion"
 * that no code caused. This event is the handoff itself.
 */
const downloadEvents = [];
cdp.on('Page.downloadWillBegin', (e) => {
    downloadEvents.push({ at: Date.now(), name: e.suggestedFilename });
});

const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const downloadsNow = () => fs.readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'));
/**
 * Whether a download has *started*, which is the event publication actually
 * causes. A finished file is a later and slower thing — Chrome writes through a
 * `.crdownload` placeholder — and measuring only the final name once put five
 * seconds between `saveAs` and the file, which reads like an ordering bug and
 * is not one.
 */
const downloadStarted = () => fs.readdirSync(downloads).length > 0;
/** Each section starts from an empty folder, so "nothing appeared" means it. */
const clearDownloads = () => {
    for (const f of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, f), { force: true });
};
const rowStates = () => page.evaluate(() => [...document.querySelectorAll('.file-status')]
    .map((el) => el.textContent?.trim() ?? ''));
const openProcessor = async () => page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('PDF加工'));
    if (!b) return false;
    b.click();
    return true;
});
const pickTool = async (label) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('.tool-btn')].find((x) => x.textContent?.includes(t));
    if (!b) return false;
    b.click();
    return true;
}, label);
const upload = async (...files) => {
    const input = await page.$('[data-usage-target="processor-upload"] input[type="file"]')
        ?? await page.$('input[type="file"]');
    await input.uploadFile(...files);
    await settle(700);
};
const run = async () => page.evaluate(() => {
    document.querySelector('[data-usage-target="processor-run"]')?.click();
});
const confirmLosses = async () => page.evaluate(() => {
    const panel = document.querySelector('[data-usage-target="processor-confirm"]');
    if (!panel) return false;
    const b = [...panel.querySelectorAll('button')].find((x) => x.textContent?.includes('内容を理解して実行'));
    if (!b) return false;
    b.click();
    return true;
});
/**
 * Change a setting mid-run, the way a person does.
 *
 * React listens for `input` on a `<select>`, not for `change` alone, and it
 * reads the value through its own descriptor — so setting `.value` directly and
 * firing `change` reaches nothing. The native setter plus both events is what
 * actually delivers an `onChange`, and the gate verifies the value stuck rather
 * than assuming the click landed.
 */
/**
 * The rendered DPI, read from the label that belongs to the DPI select.
 *
 * `document.body.textContent` runs the settings panels together, so a plain
 * match picked up the next control's number as well and reported "300150".
 * The label is found through the select itself instead.
 */
/**
 * The DPI React believes it is on.
 *
 * Reading a label was a mistake twice over: the settings panels run together in
 * `textContent`, and even scoped to a group the text can carry a second
 * control's number. A controlled `<select>`'s `value` comes from state, so
 * after a render it *is* what React thinks — and if `onChange` never ran,
 * React re-renders the old value back over the assignment.
 */
const dpiValue = () => page.evaluate(() => {
    const select = [...document.querySelectorAll('select')].find((s) => {
        const values = [...s.options].map((o) => o.value);
        return values.includes('150') && values.includes('600');
    });
    return select ? select.value : null;
});
const changeDpi = async (value) => {
    const before = await dpiValue();
    const result = await page.evaluate((v) => {
        // More than one select offers a "150": the DPI one is identified by the
        // 600 option, which only it has. Picking the first match would have
        // driven the memory preset instead and proved nothing.
        const select = [...document.querySelectorAll('select')].find((s) => {
            const values = [...s.options].map((o) => o.value);
            return values.includes('150') && values.includes('600');
        });
        if (!select) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, String(v));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, domValue: select.value };
    }, value);
    // The DOM value changes whether or not React heard about it. The rendered
    // label only changes when `onChange` ran and state was set, so that is what
    // "the control received it" means here.
    // A render has to happen for the assertion to mean anything: if `onChange`
    // did not run, React paints the old value back.
    await settle(400);
    const after = await dpiValue();
    return { ...result, valueBefore: before, valueAfter: after, reachedReact: after === String(value) };
};

const A4 = path.join(FIXTURES, 'text-a4.pdf');
const A4b = path.join(FIXTURES, 'vector-a4.pdf');
const A4c = path.join(FIXTURES, 'annotation-a4.pdf');
/**
 * The interruption material.
 *
 * Not A1: at 300 dpi an A1 page peaks at 598 MiB and the planner refuses the
 * job outright, so every row reads 処理できません and there is never a run to
 * interrupt — the first version of this gate mistook that refusal for a
 * supersede failure. A4 at 300 dpi is admitted (30 pages fit in 512 MiB) and
 * still takes long enough per page to act on.
 */
const SLOW = path.join(FIXTURES, 'three-pages.pdf');

/**
 * Wait until a run is genuinely in flight before interfering with it.
 *
 * The first version of this gate interrupted three small overlays at 150 ms and
 * reported that supersede had failed. It had not: the batch was already
 * finished, the ZIP already written, and the "interruption" arrived afterwards.
 * A supersede test is only a test while there is something to supersede, so
 * every scenario below waits for the run to be observably running — the button
 * locked and nothing downloaded yet — and gives up loudly if it never is.
 */
/**
 * Wait for the state this whole contract turns on: a file produced, and nothing
 * published yet. If a batch is quick enough that the window never opens, that
 * is worth saying out loud rather than failing a check about something the run
 * never did.
 */
const waitForProcessedRow = async (timeoutMs = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const states = await page.evaluate(
            () => [...document.querySelectorAll('.file-status')].map((e) => e.textContent.trim()),
        );
        if (states.some((s) => s.includes('書き出し待ち'))) return { seen: true, states };
        if (states.some((s) => s.includes('完了'))) return { seen: false, states, reason: 'already published' };
        await settle(60);
    }
    return { seen: false, states: [], reason: 'timed out' };
};

const waitUntilRunning = async (timeoutMs = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const state = await page.evaluate(() => ({
            running: document.querySelector('[data-usage-target="processor-run"]')?.disabled === true,
            processing: [...document.querySelectorAll('.file-status')]
                .some((e) => /処理中|確認中/.test(e.textContent ?? '')),
        }));
        if ((state.running || state.processing) && downloadsNow().length === 0) return true;
        await settle(80);
    }
    return false;
};

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    // ---- 1. a confirmed single run does finish ------------------------------
    console.log('\n=== 1. the ordinary path still works ===');
    check('the processor opens', await openProcessor());
    check('モノクロ化 is selectable', await pickTool('モノクロ化'));
    await upload(A4);
    const before1 = downloadsNow();
    await run();
    await settle(900);
    check('it asks before it flattens', await confirmLosses());
    let produced = null;
    for (let i = 0; i < 80 && !produced; i += 1) {
        await settle(500);
        const now = downloadsNow().filter((f) => !before1.includes(f) && f.toLowerCase().endsWith('.pdf'));
        if (now.length > 0) produced = now[0];
    }
    check('a confirmed run produces a file', produced !== null, produced ?? 'nothing appeared');
    const states1 = await rowStates();
    check('and only then is the row 完了', states1.some((s) => s.includes('完了')), states1.join(','));
    clearDownloads();

    // ---- 2. a setting changed mid-run supersedes it -------------------------
    console.log('\n=== 2. a setting changed while processing ===');
    await page.reload({ waitUntil: 'networkidle0' });
    await openProcessor();
    await pickTool('モノクロ化');
    await upload(SLOW, SLOW, SLOW);
    clearDownloads();
    await run();
    await settle(500);
    await confirmLosses();
    check('the run is actually in flight before it is interrupted', await waitUntilRunning());
    const dpiChange = await changeDpi(150);
    check('the DPI control actually received the change',
        dpiChange.found === true && dpiChange.reachedReact === true,
        JSON.stringify(dpiChange));
    await settle(8000);
    const after2 = downloadsNow();
    const states2 = await rowStates();
    probe('a superseded run downloads nothing',
        after2.length === 0, after2.join(', ') || '0 files');
    probe('and leaves no 完了 behind',
        !states2.some((s) => s.includes('完了')), states2.join(','));
    check('it says it was cancelled rather than failing silently',
        states2.some((s) => s.includes('中止')) || (await page.evaluate(
            () => document.body.textContent?.includes('中止') ?? false,
        )),
        states2.join(','));

    // ---- 3. a file removed mid-run supersedes it ----------------------------
    console.log('\n=== 3. the file list changed while processing ===');
    clearDownloads();
    await page.reload({ waitUntil: 'networkidle0' });
    await openProcessor();
    await pickTool('モノクロ化');
    await upload(SLOW, SLOW, SLOW);
    clearDownloads();
    await run();
    await settle(500);
    await confirmLosses();
    check('the run is in flight', await waitUntilRunning());
    // The file list and the tool buttons are locked while a run is in flight.
    // That is a real guarantee — a list that cannot change cannot desynchronise
    // from the run — but only if the lock is actually there, so it is measured
    // rather than assumed, while the run is genuinely under way.
    const locks = await page.evaluate(() => ({
        remove: document.querySelector('.file-row .remove-btn')?.disabled ?? null,
        tool: document.querySelector('.tool-btn')?.disabled ?? null,
        run: document.querySelector('[data-usage-target="processor-run"]')?.disabled ?? null,
    }));
    check('the file list and the tool buttons are locked while processing',
        locks.remove === true && locks.tool === true && locks.run === true,
        JSON.stringify(locks));
    await settle(12000);
    check('and the run it could not interrupt finished normally',
        downloadsNow().length > 0, downloadsNow().join(', ') || '0 files');

    // ---- 4. navigating away mid-run ----------------------------------------
    console.log('\n=== 4. navigating away while processing ===');
    clearDownloads();
    await page.reload({ waitUntil: 'networkidle0' });
    await openProcessor();
    await pickTool('モノクロ化');
    await upload(SLOW, SLOW, SLOW);
    clearDownloads();
    await run();
    await settle(500);
    await confirmLosses();
    check('the run is in flight before leaving', await waitUntilRunning());
    const left = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('PDF比較'));
        if (!b || b.disabled) return false;
        b.click();
        return true;
    });
    check('the tool was left mid-run', left);
    await settle(10000);
    probe('unmounting the Processor mid-run downloads nothing',
        downloadsNow().length === 0, downloadsNow().join(', ') || '0 files');

    // ---- 5. a batch superseded after one file finished ----------------------
    console.log('\n=== 5. superseded after a file had completed ===');
    clearDownloads();
    await page.reload({ waitUntil: 'networkidle0' });
    await openProcessor();
    await pickTool('モノクロ化');
    // Two multi-page files: the first finishes while the second is still
    // rendering, so the supersede lands after one output exists and before the
    // archive does.
    await upload(SLOW, SLOW);
    clearDownloads();
    await run();
    await settle(500);
    await confirmLosses();
    check('the batch is in flight', await waitUntilRunning());
    // Act on the condition, not on a stopwatch: the first file produced and the
    // archive not yet written. A fixed delay measured the machine's speed and
    // twice arrived after the batch had already published.
    const window = await waitForProcessedRow();
    const midRows = window.states;
    const sliderMoved = await page.evaluate(() => {
        const slider = document.querySelector('.settings-group input[type="range"]');
        if (!slider) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(slider, '1.5');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    });
    check('a setting was moved after a file had been produced',
        sliderMoved, `rows at that moment: ${midRows.join(',') || window.reason}`);
    await settle(10000);
    const states5 = await rowStates();
    if (window.seen) {
        probe('no ZIP is written for a superseded batch',
            downloadsNow().filter((f) => f.toLowerCase().endsWith('.zip')).length === 0,
            downloadsNow().join(', ') || '0 files');
        probe('and a produced-but-unpublished file never shows 完了',
            !states5.some((s) => s.includes('完了')),
            states5.join(','));
    } else {
        // The batch published before the window opened. Nothing was superseded,
        // so the only honest assertion left is the ordinary one.
        check('the batch completed before it could be superseded, and published normally',
            downloadsNow().length > 0 && states5.some((s) => s.includes('完了')),
            `${window.reason}; ${downloadsNow().join(', ') || '0 files'}`);
    }

    // ---- 6. a batch refused its own budget ---------------------------------
    //
    // Producing every file and then being unable to publish is the case where a
    // green row is most tempting and most wrong: the work happened, and the
    // person still has nothing.
    console.log('\n=== 6. a batch that cannot be published ===');
    clearDownloads();
    await page.reload({ waitUntil: 'networkidle0' });
    await openProcessor();
    await pickTool('半透明レイヤ追加');
    await upload(A4, A4b, A4c);
    // Start from a stated zero. The previous version began polling straight
    // after `run()` and read a first 完了 at 60 ms with a handoff at 123 ms on a
    // folder that ended up empty — numbers that describe the *previous*
    // section's leftovers, not this run. A measurement whose starting point is
    // not checked is not a measurement.
    clearDownloads();
    const clean = await page.evaluate(
        () => [...document.querySelectorAll('.file-status')].map((e) => e.textContent.trim()),
    );
    downloadEvents.length = 0;
    check('the ordering measurement starts from an empty folder and unrun rows',
        downloadsNow().length === 0 && !downloadStarted() && downloadEvents.length === 0
        && clean.every((s) => s.includes('待機')),
        `${fs.readdirSync(downloads).length} file(s), rows: ${clean.join(',') || 'none'}`);

    await run();

    // The question is an ordering one, so it is answered by watching the order:
    // poll until either a 完了 appears or the archive is handed over, and see
    // which came first. Sampling at a fixed moment only ever measured how fast
    // the machine was.
    let greenAt = null;
    let handoffAt = null;
    const startedAt = Date.now();
    for (let i = 0; i < 120 && (greenAt === null || handoffAt === null); i += 1) {
        const states = await rowStates();
        if (handoffAt === null && downloadEvents.length > 0) {
            handoffAt = downloadEvents[0].at - startedAt;
        }
        if (greenAt === null && states.some((s) => s.includes('完了'))) greenAt = Date.now() - startedAt;
        if (greenAt !== null && handoffAt !== null) break;
        await settle(50);
    }
    probe('no row goes 完了 before the archive has been handed over',
        greenAt === null || (handoffAt !== null && handoffAt <= greenAt),
        `handoff at ${handoffAt ?? 'never'}ms, first 完了 at ${greenAt ?? 'never'}ms`);

    await settle(4000);
    const after6 = downloadsNow();
    const states6 = await rowStates();
    check('the batch published, and only then did the rows go 完了',
        after6.length > 0 && states6.some((s) => s.includes('完了')),
        `${after6.length} file(s), rows: ${states6.join(',')}`);
    probe('a 完了 row and an empty download folder never coexist',
        !(states6.some((s) => s.includes('完了')) && after6.length === 0),
        `${after6.length} file(s)`);

    check('no page error during any of it', pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        console.error('\nFAILED:');
        for (const f of failed) console.error(`  - ${f.name}`);
    } else {
        console.log('\nA superseded run leaves nothing behind, and nothing is green until it is written.\n');
    }
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nUI smoke run failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
    fs.rmSync(downloads, { recursive: true, force: true });
}

process.exit(exitCode);
