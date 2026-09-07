/**
 * The drawing register, driven through the real UI in a production build.
 *
 * The module gate next door proves the extraction and the rules. This one
 * proves the screen honours them: that every row is offered for review, that
 * the download stays out of reach until every one of them is confirmed, that
 * changing anything a row was built from takes its confirmation away, and that
 * leaving the workflow releases what it was holding.
 *
 * Several checks are negative probes -- an old bug reproduced on purpose to
 * show the guard against it can still fire. A cleanup that is never observed
 * failing is a claim rather than a result.
 *
 * Local gate. Not part of Core CI: it needs a production build and drives a
 * whole workflow, which is more than a per-PR gate should carry.
 *
 * Run:  npm run build
 *       node scripts/make-drawing-register-fixtures.mjs
 *       node scripts/smoke-drawing-register-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'drawing-register');
const PDF = path.join(FIX, 'drawing-register.pdf');
const PORT = 5192;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No production build. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(PDF)) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-drawing-register-fixtures.mjs')], { stdio: 'inherit' });
}

const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'drawing-register.truth.json'), 'utf8'));
const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'register-ui-'));
const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
// Tall enough that a whole A3 sheet fits on screen at the render width. The
// title-block fields sit at the very bottom of the page, and a pointer aimed
// past the fold lands nowhere.
await page.setViewport({ width: 1400, height: 1500 });

const client = await page.target().createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

// Count every object URL the app makes and releases, before the app loads.
await page.evaluateOnNewDocument(() => {
    window.__urls = { created: 0, revoked: 0, live: new Set() };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        const url = create(blob);
        window.__urls.created += 1;
        window.__urls.live.add(url);
        return url;
    };
    URL.revokeObjectURL = (url) => {
        if (window.__urls.live.delete(url)) window.__urls.revoked += 1;
        return revoke(url);
    };
});

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

/** Enter the textifier, upload, and switch to the register workflow. */
async function enterWorkflow(file = PDF) {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
            .find((x) => (x.textContent || '').includes('PDFテキスト化'));
        if (!button) throw new Error('button not found: PDFテキスト化');
        button.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
    const input = await page.$('input[type="file"]');
    await input.uploadFile(file);
    await page.waitForSelector('input[name="mode"][value="extract"]');
    await page.click('input[name="mode"][value="extract"]');
    await page.select('select', 'drawing-register');
    await page.waitForSelector('[data-usage-target="drawing-register-canvas"]');
    await page.waitForFunction(
        () => document.querySelector('[data-usage-target="drawing-register-canvas"]')?.dataset.geometryPage === '1',
        { timeout: 60000 },
    );
}

/** Drag a rectangle given in upright points on page 1, using a real pointer. */
async function dragField(rect) {
    const sheet = truth.pages[0].sizePoints;
    // The pointer works in viewport coordinates, so the canvas has to be in the
    // viewport before its rectangle means anything.
    await page.$eval('[data-usage-target="drawing-register-canvas"]',
        (canvas) => { canvas.scrollIntoView({ block: 'center' }); });
    await wait(80);
    const box = await page.$eval('[data-usage-target="drawing-register-canvas"]', (canvas) => {
        const r = canvas.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (box.top < 0 || box.left < 0) {
        throw new Error(`canvas is off-screen: ${JSON.stringify(box)}`);
    }
    const at = (x, y) => ({
        x: box.left + (x / sheet.width) * box.width,
        y: box.top + (y / sheet.height) * box.height,
    });
    const from = at(rect.left, rect.top);
    const to = at(rect.right, rect.bottom);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await wait(60);
}

const clickByText = (text) => page.evaluate((t) => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t);
    if (!button) throw new Error(`button not found: ${t}`);
    button.click();
}, text);

const rowStatuses = () => page.evaluate(() => [...document.querySelectorAll('[data-register-page]')]
    .map((tr) => ({
        page: Number(tr.dataset.registerPage),
        status: tr.dataset.registerStatus,
    })));

const exportEnabled = () => page.evaluate(() => {
    const section = document.querySelector('[data-usage-target="drawing-register-export"]');
    if (!section) return null;
    const button = [...section.querySelectorAll('button')].find((b) => b.textContent.includes('Excel'));
    return button ? !button.disabled : null;
});

/** Open a row and confirm it, one at a time. There is no bulk path. */
async function confirmPage(pageNumber) {
    await page.evaluate((n) => {
        const tr = document.querySelector(`[data-register-page="${n}"]`);
        const button = [...tr.querySelectorAll('button')].find((b) => b.textContent.includes('確認する'));
        if (!button) throw new Error(`no confirm button for page ${n}`);
        button.click();
    }, pageNumber);
    await page.waitForSelector('[data-usage-target="drawing-register-row"]');
    await clickByText('この行を確認済みにする');
    await wait(40);
}

let exitCode = 1;
try {
    console.log('\n=== entering the workflow ===');
    await enterWorkflow();
    check('the register workflow is reachable from the format list',
        await page.$('[data-usage-target="drawing-register-workflow"]') !== null);
    check('the format option is named so it is not the table exporter',
        await page.$eval('select', (s) => s.selectedOptions[0].textContent) === '図面一覧（Excel）');
    check('the table exporter is not on screen at the same time',
        await page.$('[data-usage-target="excel-workflow"]') === null);

    console.log('\n=== building a profile ===');
    const regions = truth.pages[0].regions;
    const fieldOrder = ['drawing_number', 'drawing_title', 'revision', 'revision_date'];
    for (const name of fieldOrder) {
        await page.evaluate((label) => {
            const button = [...document.querySelectorAll('.dr-field')]
                .find((b) => b.textContent.includes(label));
            if (!button) throw new Error(`field button not found: ${label}`);
            button.click();
        }, { drawing_number: '図面番号', drawing_title: '図面名称', revision: '版', revision_date: '日付' }[name]);
        await dragField(regions[name]);
    }
    const drawn = await page.$$eval('.dr-field', (nodes) => nodes.filter((n) => n.textContent.includes('指定済み')).length);
    check('all four field regions were drawn', drawn === 4, `${drawn}/4`);

    const saveDisabledBefore = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'プロファイルを保存');
        return button.disabled;
    });
    check('a complete profile can be saved', saveDisabledBefore === false);

    await page.type('.dr-profile-form input[type="text"]', 'A: 表題欄');
    await clickByText('プロファイルを保存');
    await page.waitForSelector('[data-usage-target="drawing-register-assign"]');
    check('the profile is listed once saved',
        (await page.$$eval('.dr-profile-list li', (n) => n.length)) === 1);

    console.log('\n=== assigning pages ===');
    // Everything except the layout-B page, which is deliberately left alone.
    const layoutB = truth.pages.filter((p) => p.layout === 'B').map((p) => p.page);
    const assignable = truth.pages.filter((p) => !layoutB.includes(p.page)).map((p) => p.page);
    await page.type('.dr-assign-form input[type="text"]', assignable.join(', '));
    await clickByText('割り当て');
    await wait(80);
    const unassignedText = await page.$eval('[data-usage-target="drawing-register-unassigned"]', (el) => el.textContent);
    check('the pages left out are reported as unassigned',
        layoutB.every((p) => unassignedText.includes(String(p))), unassignedText.trim());

    console.log('\n=== extraction ===');
    await clickByText('図面一覧を読み取る');
    await page.waitForSelector('[data-usage-target="drawing-register-review"]', { timeout: 180000 });
    await page.waitForFunction(() => {
        const text = document.querySelector('[data-usage-target="drawing-register-review"]')?.innerText ?? '';
        return /確認済み \d+ \/ \d+ 行/.test(text);
    }, { timeout: 180000 });

    const statuses = await rowStatuses();
    check('there is one row per page of the document',
        statuses.length === truth.pages.length, `${statuses.length} rows for ${truth.pages.length} pages`);
    check('every row starts unconfirmed',
        statuses.every((r) => r.status === 'unconfirmed'));
    const flagged = await page.$$eval('.dr-flag', (n) => n.length);
    probe('rows with no flag are on the list too, not filtered out of it',
        statuses.length > flagged,
        `${flagged} flagged, ${statuses.length - flagged} unflagged, all ${statuses.length} listed`);
    const unassignedRowPresent = statuses.some((r) => layoutB.includes(r.page));
    check('the unassigned page still has a row', unassignedRowPresent,
        `page ${layoutB.join(', ')} present`);

    console.log('\n=== the download stays out of reach ===');
    check('the export button is disabled with nothing confirmed', (await exportEnabled()) === false);

    // Confirm every row but one.
    const pagesInOrder = statuses.map((r) => r.page).sort((a, b) => a - b);
    for (const p of pagesInOrder.slice(0, -1)) await confirmPage(p);
    const nearlyDone = await rowStatuses();
    const stillUnconfirmed = nearlyDone.filter((r) => r.status === 'unconfirmed');
    check('confirming happens one row at a time', stillUnconfirmed.length === 1,
        `${nearlyDone.length - stillUnconfirmed.length} of ${nearlyDone.length} confirmed`);
    probe('one unconfirmed row still blocks the export', (await exportEnabled()) === false,
        `page ${stillUnconfirmed[0].page} is unconfirmed`);
    check('there is no bulk confirm control',
        await page.evaluate(() => ![...document.querySelectorAll('button')]
            .some((b) => /すべて.*確認|一括/.test(b.textContent || ''))));

    await confirmPage(stillUnconfirmed[0].page);
    check('with every row confirmed the export is offered', (await exportEnabled()) === true);

    console.log('\n=== the workbook ===');
    await page.evaluate(() => {
        const section = document.querySelector('[data-usage-target="drawing-register-export"]');
        [...section.querySelectorAll('button')].find((b) => b.textContent.includes('Excel')).click();
    });
    await page.waitForSelector('.dr-download', { timeout: 60000 });
    const urlsAfterBuild = await page.evaluate(() => ({ ...window.__urls, live: window.__urls.live.size }));
    check('a workbook link was published', urlsAfterBuild.created >= 1,
        `${urlsAfterBuild.created} object URL(s) created`);
    const downloadName = await page.$eval('.dr-download', (a) => a.getAttribute('download'));
    check('the download is named for the source document',
        downloadName === 'drawing-register_drawing_register.xlsx', downloadName);

    console.log('\n=== changing something takes the confirmation back ===');
    // Re-open a confirmed row and take its confirmation off.
    await page.evaluate(() => {
        const tr = document.querySelector('[data-register-page="1"]');
        [...tr.querySelectorAll('button')].find((b) => b.textContent.includes('確認を取り消す')).click();
    });
    await wait(80);
    check('a row can be un-confirmed', (await rowStatuses()).find((r) => r.page === 1).status === 'unconfirmed');
    probe('and the download disappears with it', await page.$('.dr-download') === null,
        'the screen and the file can never disagree');
    check('the export is blocked again', (await exportEnabled()) === false);
    const afterDrop = await page.evaluate(() => ({ ...window.__urls, live: window.__urls.live.size }));
    probe('the stale workbook URL was revoked, not just forgotten',
        afterDrop.revoked >= 1 && afterDrop.live === 0,
        `created ${afterDrop.created}, revoked ${afterDrop.revoked}, live ${afterDrop.live}`);

    // Changing the arrangement must not leave the old reading behind for
    // somebody to confirm a second time.
    await confirmPage(1);
    await page.evaluate(() => {
        const section = document.querySelector('[data-usage-target="drawing-register-export"]');
        [...section.querySelectorAll('button')].find((b) => b.textContent.includes('Excel')).click();
    });
    await page.waitForSelector('.dr-download', { timeout: 60000 });
    const confirmedBefore = (await rowStatuses()).filter((r) => r.status === 'confirmed').length;
    check('every row is confirmed and a workbook exists before the change',
        confirmedBefore === 15 && await page.$('.dr-download') !== null,
        `${confirmedBefore} confirmed`);

    // Reassign a page to nothing by deleting the profile it belongs to.
    await page.evaluate(() => {
        const li = document.querySelector('.dr-profile-list li');
        [...li.querySelectorAll('button')].find((b) => b.textContent.trim() === '削除').click();
    });
    await wait(200);

    probe('the old reading is discarded, not just unconfirmed',
        await page.$('[data-usage-target="drawing-register-review"]') === null,
        'there is no stale row left on screen to confirm again');
    probe('so there is nothing to confirm',
        (await rowStatuses()).length === 0,
        'the review table is gone until the register is read again');
    probe('and nothing to export',
        await page.$('[data-usage-target="drawing-register-export"]') === null
        && await page.$('.dr-download') === null,
        'the export section goes with the rows');
    const afterProfile = await page.evaluate(() => ({ ...window.__urls, live: window.__urls.live.size }));
    check('no object URL is left live', afterProfile.live === 0,
        `created ${afterProfile.created}, revoked ${afterProfile.revoked}`);

    // Reading again is the only way back, and it starts from unconfirmed.
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('.dr-field')].length;
        return button;
    });
    for (const name of fieldOrder) {
        await page.evaluate((label) => {
            const button = [...document.querySelectorAll('.dr-field')]
                .find((b) => b.textContent.includes(label));
            button.click();
        }, { drawing_number: '図面番号', drawing_title: '図面名称', revision: '版', revision_date: '日付' }[name]);
        await dragField(regions[name]);
    }
    await page.type('.dr-profile-form input[type="text"]', 'A: 表題欄（再作成）');
    await clickByText('プロファイルを保存');
    await page.waitForSelector('[data-usage-target="drawing-register-assign"]');
    await page.type('.dr-assign-form input[type="text"]', assignable.join(', '));
    await clickByText('割り当て');
    await wait(80);
    await clickByText('図面一覧を読み取る');
    await page.waitForSelector('[data-usage-target="drawing-register-review"]', { timeout: 180000 });
    const afterReextract = await rowStatuses();
    check('reading again gives a full register of unconfirmed rows',
        afterReextract.length === 15 && afterReextract.every((r) => r.status === 'unconfirmed'),
        `${afterReextract.length} rows, all unconfirmed`);
    check('and the export is blocked until they are confirmed again',
        (await exportEnabled()) === false);

    console.log('\n=== leaving, and coming back ===');
    // Switching format unmounts the workflow.
    await page.evaluate(() => {
        const select = document.querySelector('select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'txt');
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(200);
    check('the workflow is gone', await page.$('[data-usage-target="drawing-register-workflow"]') === null);
    const afterLeave = await page.evaluate(() => ({ ...window.__urls, live: window.__urls.live.size }));
    probe('leaving released every object URL it held',
        afterLeave.live === 0 && afterLeave.revoked === afterLeave.created,
        `created ${afterLeave.created}, revoked ${afterLeave.revoked}`);

    await page.evaluate(() => {
        const select = document.querySelector('select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'drawing-register');
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForSelector('[data-usage-target="drawing-register-canvas"]');
    await wait(300);
    check('coming back gives a fresh workflow, not the old one',
        await page.$('[data-usage-target="drawing-register-review"]') === null
        && await page.$('[data-usage-target="drawing-register-assign"]') === null,
        'no rows, no profiles');

    console.log('\n=== replacing the file ===');
    const replaceInput = await page.$('input[type="file"]');
    await replaceInput.uploadFile(PDF);
    await page.waitForFunction(
        () => document.querySelector('[data-usage-target="drawing-register-canvas"]')?.dataset.geometryPage === '1',
        { timeout: 60000 },
    );
    check('a replaced file starts from nothing',
        await page.$('[data-usage-target="drawing-register-review"]') === null);
    const finalUrls = await page.evaluate(() => ({ ...window.__urls, live: window.__urls.live.size }));
    check('and nothing is still holding an object URL', finalUrls.live === 0,
        `created ${finalUrls.created}, revoked ${finalUrls.revoked}, live ${finalUrls.live}`);

    check('no page error throughout', pageErrors.length === 0, pageErrors[0] ?? '');

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length === 0
        ? `All ${checks.length} drawing-register UI checks passed (${checks.filter((c) => c.name.startsWith('negative probe')).length} negative probes).`
        : `${failed.length} of ${checks.length} checks failed.`}\n`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nFAILED: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.httpServer.close();
    fs.rmSync(downloads, { recursive: true, force: true });
}

process.exit(exitCode);
