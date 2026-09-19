/**
 * The M6 UI gate.
 *
 * The module gate proves the contract; this proves the wiring. Four of the
 * Independent FULL Review's findings were only visible by driving the built app:
 *
 *   - a slow upload finishing after a fast one, so the screen said B and the
 *     exported file was A;
 *   - a confirmation that asked someone to agree to losing an attachment without
 *     naming it;
 *   - PDF.js parsing untrusted input before the Load Boundary had passed it;
 *   - a B4 notice the footer sat on top of.
 *
 * Each is asserted on something observable: the bytes of the downloaded file,
 * the text on screen before the click, the requests the page made, and the
 * measured geometry of two elements.
 *
 * Run:  npm run build
 *       node scripts/make-m6-split-merge-fixtures.mjs
 *       node scripts/make-m6-remediation-fixtures.mjs
 *       node scripts/make-m6-round3-fixtures.mjs
 *       node scripts/make-m6-round4-fixtures.mjs
 *       node scripts/make-m6-round5-fixtures.mjs
 *       node scripts/smoke-split-merge-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5187;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
const WORKER = '/pdf.worker.min.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(FIXTURES)) {
    console.error('No fixtures. Run: node scripts/make-m6-split-merge-fixtures.mjs');
    process.exit(1);
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-ui-'));
const fixture = (name) => path.join(FIXTURES, `${name}.pdf`);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await preview({
    root: ROOT,
    preview: { port: PORT, strictPort: true },
    logLevel: 'warn',
});
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

let exitCode = 1;
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 1400, height: 900 });

    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const workerRequests = () => requests.filter((u) => u.includes(WORKER)).length;

    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
    });

    /**
     * Make one named file slow to read.
     *
     * `File.prototype.arrayBuffer` is patched before any app code runs, so the
     * race BLK-3 is about can be produced on demand instead of hoped for.
     */
    await page.evaluateOnNewDocument(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function (...args) {
            const delay = window.__m6SlowFiles?.[this.name] ?? 0;
            const result = original.apply(this, args);
            if (!delay) return result;
            return new Promise((resolve, reject) => {
                setTimeout(() => result.then(resolve, reject), delay);
            });
        };
    });

    const openSplitMerge = async () => {
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
            [...document.querySelectorAll('button')]
                .find((b) => b.textContent?.includes('PDF抽出・統合'))?.click();
        });
        await settle(400);
    };

    const bodyText = () => page.evaluate(() => document.body.textContent ?? '');
    const waitForText = async (needle, timeout = 15000) => {
        const started = Date.now();
        for (;;) {
            if ((await bodyText()).includes(needle)) return true;
            if (Date.now() - started > timeout) return false;
            await settle(200);
        }
    };

    // ---- 1. the preview never sees untrusted input first ---------------------
    //
    // A file the Load Boundary refuses must produce no PDF.js parse at all. The
    // observable form of "PDF.js did not run" is that its worker was never
    // fetched.
    console.log('\n=== 1. preview only after Load Boundary PASS ===');
    await openSplitMerge();
    requests.length = 0;

    let input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('decode-bomb-large'));
    await settle(2500);

    const refusedText = await bodyText();
    check('a refused file is reported, not previewed',
        refusedText.includes('安全に処理できることを確認できなかった'),
        refusedText.includes('安全に処理できることを確認できなかった') ? 'typed refusal shown' : 'NOT SHOWN');
    check('and PDF.js was never asked to parse it',
        workerRequests() === 0, `${workerRequests()} request(s) to ${WORKER}`);

    // The control: a file that passes does reach PDF.js, so the check above is
    // measuring the boundary rather than a page that never previews anything.
    requests.length = 0;
    await openSplitMerge();
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('nav-4p'));
    await settle(3000);
    check('a file that passes the boundary is previewed',
        workerRequests() > 0 && (await bodyText()).includes('Page 1'),
        `${workerRequests()} request(s) to ${WORKER}`);

    // ---- 2. BLK-3: the upload race -------------------------------------------
    console.log('\n=== 2. BLK-3 upload race ===');
    await openSplitMerge();

    // `merge-a` is 3 pages and made slow; `nav-4p` is 4 pages and is chosen
    // second. If the late run wins, the screen shows 3 pages and the export
    // carries merge-a's content under nav-4p's name.
    await page.evaluate(() => {
        window.__m6SlowFiles = { 'merge-a.pdf': 2500 };
    });
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('merge-a'));
    await settle(200);
    await input.uploadFile(fixture('nav-4p'));
    await settle(6000);

    const raceText = await bodyText();
    check('the screen shows the file chosen last',
        raceText.includes('nav-4p.pdf') && !raceText.includes('merge-a.pdf'),
        raceText.includes('nav-4p.pdf') ? 'nav-4p.pdf' : 'WRONG FILE');
    const pageCells = await page.$$eval('[data-usage-target="extract-pages"] > div',
        (els) => els.length);
    check('and its page count, not the slow file\'s',
        pageCells === 4, `${pageCells} page cells (nav-4p has 4, merge-a has 3)`);

    // Select every page and export, then read the artifact that came out.
    await page.evaluate(() => {
        for (const cell of document.querySelectorAll('[data-usage-target="extract-pages"] > div')) {
            cell.click();
        }
    });
    await settle(500);
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-export"]')?.click();
    });
    await settle(6000);

    const files = fs.readdirSync(downloads).filter((f) => f.endsWith('.pdf'));
    const exported = files.find((f) => f.startsWith('nav-4p'));
    check('the exported file is named for the file chosen last',
        Boolean(exported), files.join(', ') || 'no download');
    if (exported) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(downloads, exported)));
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        check('and its CONTENT is that file, not the slow one',
            doc.getPageCount() === 4, `${doc.getPageCount()} pages`);
    } else {
        check('and its CONTENT is that file, not the slow one', false, 'no artifact to read');
    }

    // ---- 3. RF-7: the confirmation names what it is asking about -------------
    console.log('\n=== 3. RF-7 confirmation shows the real losses ===');
    await openSplitMerge();
    input = await page.$('input[type="file"]');
    await input.uploadFile(fixture('rem-js-fileattachment-aa'));
    await settle(3000);

    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-pages"] > div')?.click();
    });
    await settle(400);
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-export"]')?.click();
    });
    const named = await waitForText('secret-notes.txt');
    check('the attachment filename is on screen BEFORE the confirmation is given',
        named, named ? 'secret-notes.txt shown' : 'NOT SHOWN');
    const confirmText = await bodyText();
    check('and the confirmation button says it is a confirmation',
        confirmText.includes('内容を了承して書き出し'),
        confirmText.includes('内容を了承して書き出し') ? 'shown' : 'NOT SHOWN');

    // ---- 4. the B4 notice is visible ----------------------------------------
    console.log('\n=== 4. B4 notice visibility ===');

    const noticeGeometry = async () => page.evaluate(() => {
        const notice = document.querySelector('[data-usage-target="m6-b4-notice"]');
        if (!notice) return null;
        const rect = notice.getBoundingClientRect();
        const style = getComputedStyle(notice);
        // Whatever is painted at the middle of the notice: if it is not the
        // notice or one of its children, something is covering it.
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
            width: rect.width,
            height: rect.height,
            visible: style.visibility !== 'hidden'
                && style.display !== 'none'
                && Number(style.opacity) > 0,
            covered: !(hit === notice || notice.contains(hit)),
            text: notice.textContent ?? '',
        };
    });

    for (const [label, width, height] of [['desktop', 1400, 900], ['narrow', 390, 780]]) {
        await page.setViewport({ width, height });
        await openSplitMerge();
        await settle(400);
        const geo = await noticeGeometry();
        check(`the B4 notice is present and readable at ${label} (${width}px)`,
            Boolean(geo) && geo.visible && geo.width > 0 && geo.height > 0
            && geo.text.includes('B4 未決定'),
            geo ? `${Math.round(geo.width)}x${Math.round(geo.height)}` : 'NOT FOUND');
        check(`and nothing covers it at ${label}`,
            Boolean(geo) && geo.covered === false,
            geo ? `covered=${geo.covered}` : 'NOT FOUND');
    }
    await page.setViewport({ width: 1400, height: 900 });

    // ---- 5. BLK-4: every requested merge source is listed --------------------
    console.log('\n=== 5. BLK-4 every requested source is listed ===');
    await openSplitMerge();
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF統合'))?.click();
    });
    await settle(400);

    const mergeInput = await page.$('input[type="file"]');
    await mergeInput.uploadFile(
        fixture('merge-a'),
        fixture('xfa'),
        fixture('signature-applied'),
        fixture('no-header'),
    );
    await settle(6000);

    const mergeText = await bodyText();
    const rows = await page.$$eval('[data-usage-target="merge-list"] > div', (els) => els.length);
    check('every chosen file has a row, including the ones that cannot be merged',
        rows === 4, `${rows} rows for 4 files`);
    for (const [name, label] of [
        ['xfa.pdf', 'XFAフォームを含みます'],
        ['signature-applied.pdf', '電子署名が適用されています'],
        ['no-header.pdf', '安全に読み込めることを確認できませんでした'],
    ]) {
        check(`${name} is shown with its reason`,
            mergeText.includes(name) && mergeText.includes(label),
            mergeText.includes(name) ? 'named' : 'MISSING');
    }

    // ---- 6. BLK-4R: supersede does not erase the request --------------------
    //
    // Cancellation used to be implemented as `return`, so an intake that was
    // superseded mid-flight dropped files the person had already picked and left
    // `busy` set. That is the M6-H10 defect — an input vanishing between the
    // picker and the list — reintroduced through the cancellation path.
    //
    // The invariant: after any supersede, EVERY requested file holds a terminal
    // intake record, and nothing is still working. The record is read off the
    // row rather than out of the prose, so 'shown as cancelled' and 'gone' can
    // never look the same to this gate.
    console.log('\n=== 6. BLK-4R supersede keeps every requested file ===');

    const openMergeTab = async () => page.evaluate(() => {
        document.querySelectorAll('[data-usage-target="split-tabs"] button')[1]
            ?.click();
    });
    const openMerge = async () => {
        await openSplitMerge();
        await openMergeTab();
        await settle(400);
    };
    const mergeRows = () => page.$$eval('[data-usage-target="merge-row"]',
        (els) => els.map((el) => ({
            name: el.getAttribute('data-m6-name'),
            intake: el.getAttribute('data-m6-intake'),
        })));
    const working = async () => (await bodyText()).includes('処理中 / Working');

    for (const { label, seed, disturb } of [
        {
            label: 'a file is removed',
            seed: ['merge-b'],
            disturb: () => page.evaluate(() => {
                document.querySelectorAll('[data-usage-target="merge-row"]')[0]
                    ?.querySelector('button[title="Remove"]')?.click();
            }),
        },
        {
            // Two seeded rows, because the second row is the one with an
            // enabled Move Up.
            label: 'the list is reordered',
            seed: ['merge-b', 'nav-goto'],
            disturb: () => page.evaluate(() => {
                document.querySelectorAll('[data-usage-target="merge-row"]')[1]
                    ?.querySelector('button[title="Move Up"]')?.click();
            }),
        },
        {
            label: 'the tab is switched away',
            seed: ['merge-b'],
            // Scoped to the component's tab strip: `PDF抽出` is also a
            // substring of the app-level `PDF抽出・統合`, and clicking that
            // one supersedes nothing.
            disturb: () => page.evaluate(() => {
                document.querySelector('[data-usage-target="split-tabs"] button')
                    ?.click();
            }),
        },
    ]) {
        await openMerge();
        let mi = await page.$('input[type="file"]');
        await mi.uploadFile(...seed.map(fixture));
        await settle(3500);
        const seeded = (await mergeRows()).length;

        // Two more, the first of which reads slowly, so the disturbance lands
        // while the intake is genuinely in flight.
        await page.evaluate(() => {
            window.__m6SlowFiles = { 'merge-a.pdf': 3000 };
        });
        mi = await page.$('input[type="file"]');
        await mi.uploadFile(fixture('merge-a'), fixture('nav-4p'));
        await settle(500);
        check(`${label}: the intake really was in flight`,
            seeded === seed.length && (await working()),
            `${seeded} seeded rows, busy ${await working()}`);

        await disturb();
        await settle(7000);
        // The tab case has to come back to look at the list.
        await openMergeTab();
        await settle(400);

        const rows = await mergeRows();
        const shape = rows.map((r) => `${r.name}=${r.intake}`).join(', ');
        const expected = (label === 'a file is removed' ? seeded - 1 : seeded) + 2;
        check(`${label}: nothing is left working`, (await working()) === false, 'idle');
        check(`${label}: every row holds a terminal record`,
            rows.length === expected && rows.every((r) => r.intake !== 'PENDING'),
            `${rows.length} rows (expected ${expected}): ${shape}`);
        check(`${label}: both interrupted files are still there, as cancelled`,
            ['merge-a.pdf', 'nav-4p.pdf'].every(
                (n) => rows.some((r) => r.name === n && r.intake === 'CANCELLED'),
            ),
            shape);
    }

    // A second upload arriving mid-intake supersedes the first. Both requests
    // are the person's; neither may be dropped.
    await openMerge();
    await page.evaluate(() => {
        window.__m6SlowFiles = { 'merge-a.pdf': 3000 };
    });
    let racing = await page.$('input[type="file"]');
    await racing.uploadFile(fixture('merge-a'), fixture('nav-4p'));
    await settle(500);
    racing = await page.$('input[type="file"]');
    await racing.uploadFile(fixture('merge-b'));
    await settle(9000);

    const raced = await mergeRows();
    const racedShape = raced.map((r) => `${r.name}=${r.intake}`).join(', ');
    check('a re-upload during intake: nothing is left working',
        (await working()) === false, 'idle');
    check('a re-upload during intake: all three requested files have a record',
        raced.length === 3 && raced.every((r) => r.intake !== 'PENDING'),
        `${raced.length} rows: ${racedShape}`);
    check('and the file chosen last is the one that was decided',
        raced.some((r) => r.name === 'merge-b.pdf' && r.intake === 'ACCEPTED'),
        racedShape);

    // ---- 7. RF-C: a gated loss list is never truncated ----------------------
    //
    // The list used to be cut at eight, so an attachment could fall off the end
    // while the broad approval still authorised deleting it. A confirmation is
    // only valid for what was actually shown.
    console.log('\n=== 7. RF-C the confirmation shows every loss it gates ===');
    await openSplitMerge();
    const manyInput = await page.$('input[type="file"]');
    await manyInput.uploadFile(fixture('r3-many-losses'));
    await settle(3500);

    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-pages"] > div')?.click();
    });
    await settle(400);
    await page.evaluate(() => {
        document.querySelector('[data-usage-target="extract-export"]')?.click();
    });
    const gatedShown = await waitForText('内容を了承して書き出し');
    check('the confirmation is asked for before anything is written',
        gatedShown, gatedShown ? 'shown' : 'NOT SHOWN');

    const gatedList = await page
        .$eval('[data-usage-target="m6-confirm-losses"]', (el) => ({
            text: el.textContent ?? '',
            items: el.querySelectorAll('li').length,
        }))
        .catch(() => null);
    check('both confirmation-required losses are listed in full',
        Boolean(gatedList)
        && gatedList.items === 2
        && gatedList.text.includes('添付ファイル')
        && gatedList.text.includes('タグ構造'),
        gatedList ? `${gatedList.items} items` : 'NOT FOUND');
    check('and the attachment is named by filename before the click',
        Boolean(gatedList) && gatedList.text.includes('secret-notes.txt'),
        gatedList ? gatedList.text.slice(0, 100) : 'NOT FOUND');

    // The informational remainder is disclosed too — collapsed is allowed, gone
    // is not.
    const informationalShown = await bodyText();
    check('the informational losses are on screen as well',
        informationalShown.includes('しおり（アウトライン）')
        && informationalShown.includes('ページラベル'),
        'outlines and page labels named');

    // ---- 8. RF-R3-2: the confirmation can see a typeless /EF ---------------
    //
    // The removal path found these; the path that decides whether to ask did
    // not, because it asked about `/Type`. Driven through the real app a
    // single click produced the file, and the attachment it had just deleted
    // was named in the success notice.
    console.log('\n=== 8. RF-R3-2 a typeless attachment is confirmed, not assumed ===');

    const mergeNotice = () => page.evaluate(
        () => document.querySelector('[data-usage-target="m6-notice"]')?.textContent ?? '');
    const gatedItems = () => page.evaluate(
        () => [...document.querySelectorAll('[data-usage-target="m6-confirm-losses"] li')]
            .map((li) => li.textContent ?? ''));
    const downloadedNames = () => fs.readdirSync(downloads).filter((f) => f.endsWith('.pdf'));
    const clickMergeExport = () => page.evaluate(() => {
        document.querySelector('[data-usage-target="merge-export"]')?.click();
    });

    await openMerge();
    let typelessInput = await page.$('input[type="file"]');
    await typelessInput.uploadFile(fixture('r4-typeless-ef'), fixture('merge-b'));
    await settle(4000);
    const downloadsBeforeTypeless = downloadedNames().length;
    await clickMergeExport();
    await settle(3000);
    const typelessFirst = await mergeNotice();
    const typelessGated = await gatedItems();
    check('a typeless /EF source stops the first click',
        typelessFirst.includes('CONFIRMATION_REQUIRED')
        && downloadedNames().length === downloadsBeforeTypeless,
        `${typelessFirst.slice(0, 80)} · ${downloadedNames().length - downloadsBeforeTypeless} new file(s)`);
    check('and the attachment is named before anything is written',
        typelessGated.some((t) => t.includes('r4-typeless-ef.pdf')),
        JSON.stringify(typelessGated));

    await clickMergeExport();
    await settle(6000);
    check('the second click produces the file',
        downloadedNames().length === downloadsBeforeTypeless + 1,
        `${downloadedNames().length - downloadsBeforeTypeless} new file(s)`);
    const typelessOut = downloadedNames()
        .map((f) => path.join(downloads, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const typelessBytes = fs.readFileSync(typelessOut);
    check('and the payload is not in the bytes it handed over',
        !typelessBytes.includes('M6R4_TYPELESS_SHALLOW'),
        `${path.basename(typelessOut)}, ${typelessBytes.length} bytes`);

    // ---- 9. RF-R3-3: a confirmation belongs to the plan it was given for ---
    //
    // Measured: confirm a Merge of A and B, add C, click once, and C's
    // attachment was deleted having never been shown. The agreement was a
    // boolean about loss kinds, and it outlived the plan it was given for.
    console.log('\n=== 9. RF-R3-3 a confirmation does not outlive its plan ===');

    /** Confirm a two-source Merge, then disturb the input set and click once. */
    const afterDisturbance = async (label, disturb) => {
        await openMerge();
        const input = await page.$('input[type="file"]');
        await input.uploadFile(fixture('with-attachment'), fixture('merge-b'));
        await settle(4000);
        const before = downloadedNames().length;
        await clickMergeExport();
        await settle(2500);
        const confirmed = (await mergeNotice()).includes('CONFIRMATION_REQUIRED');

        await disturb();
        await settle(4000);
        await clickMergeExport();
        await settle(6000);
        const notice = await mergeNotice();
        const produced = downloadedNames().length - before;
        check(`${label}: the first click asked for a confirmation`,
            confirmed, confirmed ? 'asked' : 'did not ask');
        check(`${label}: and the confirmation did not survive it`,
            notice.includes('CONFIRMATION_REQUIRED') && produced === 0,
            `${notice.slice(0, 90)} · ${produced} new file(s)`);
    };

    await afterDisturbance('a third file is added', async () => {
        const input = await page.$('input[type="file"]');
        await input.uploadFile(fixture('r4-typeless-ef'));
    });

    await afterDisturbance('a file is removed', async () => {
        await page.evaluate(() => {
            document.querySelectorAll('[data-usage-target="merge-row"]')[1]
                ?.querySelector('button[title="Remove"]')?.click();
        });
    });

    await afterDisturbance('the list is reordered', async () => {
        await page.evaluate(() => {
            document.querySelectorAll('[data-usage-target="merge-row"]')[1]
                ?.querySelector('button[title="Move Up"]')?.click();
        });
    });

    await afterDisturbance('the same file is uploaded again', async () => {
        const input = await page.$('input[type="file"]');
        await input.uploadFile(fixture('with-attachment'));
    });

    // And the control: nothing changes, so the confirmation is honoured.
    await openMerge();
    const steadyInput = await page.$('input[type="file"]');
    await steadyInput.uploadFile(fixture('with-attachment'), fixture('merge-b'));
    await settle(4000);
    const steadyBefore = downloadedNames().length;
    await clickMergeExport();
    await settle(2500);
    await clickMergeExport();
    await settle(6000);
    check('an unchanged plan is merged on the second click',
        downloadedNames().length === steadyBefore + 1,
        `${downloadedNames().length - steadyBefore} new file(s)`);

    // ---- 10. RF-R4-6: the confirmation names the attachment ------------------
    //
    // Promoted from the fourth review's advisories. The earlier gate asked
    // only that the SOURCE file be named, and a confirmation reading
    // "attachment (drawing.pdf)" asks someone to agree to deleting something
    // they cannot see. Every gated entry is read off the rendered list BEFORE
    // the consenting click, and the artifact is then opened for the payload.
    console.log('\n=== 10. RF-R4-6 the attachment is named before consent ===');

    const disclosureCases = [
        ['r5-att-secret', ['r5-att-secret.pdf — secret-notes.txt'], ['M6R5_SECRET_PAYLOAD']],
        ['r5-att-unicode', ['r5-att-unicode.pdf — 図面メモ.txt'], ['M6R5_UNICODE_PAYLOAD']],
        ['r5-att-multi', [
            'r5-att-multi.pdf — a.txt', 'r5-att-multi.pdf — b.txt', 'r5-att-multi.pdf — c.txt',
        ], ['M6R5_MULTI_A', 'M6R5_MULTI_B', 'M6R5_MULTI_C']],
        ['r5-att-unnamed', ['r5-att-unnamed.pdf — 名前のない添付ファイル'], ['M6R5_UNNAMED_PAYLOAD']],
    ];
    for (const [name, expected, markers] of disclosureCases) {
        await openMerge();
        const input = await page.$('input[type="file"]');
        await input.uploadFile(fixture(name), fixture('merge-b'));
        await settle(4000);
        const before = downloadedNames().length;
        await clickMergeExport();
        await settle(3000);
        const gated = await gatedItems();
        const produced = downloadedNames().length - before;
        check(`${name}: the first click asks, and writes nothing`,
            (await mergeNotice()).includes('CONFIRMATION_REQUIRED') && produced === 0,
            `${produced} new file(s)`);
        for (const entry of expected) {
            check(`${name}: "${entry}" is on screen before consent`,
                gated.some((text) => text.includes(entry)),
                JSON.stringify(gated));
        }
        check(`${name}: and every gated attachment has its own entry`,
            gated.filter((text) => text.startsWith('添付ファイル')).length === expected.length,
            JSON.stringify(gated));

        await clickMergeExport();
        await settle(6000);
        check(`${name}: the second click writes the file`,
            downloadedNames().length === before + 1,
            `${downloadedNames().length - before} new file(s)`);
        const out = downloadedNames()
            .map((f) => path.join(downloads, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const bytes = fs.readFileSync(out);
        check(`${name}: and no payload it asked about is in the bytes`,
            markers.every((m) => !bytes.includes(m)),
            `${path.basename(out)}, ${bytes.length} bytes`);
    }

    check('no uncaught page error during any of it',
        pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.httpServer.close();
    fs.rmSync(downloads, { recursive: true, force: true });
}
process.exit(exitCode);
