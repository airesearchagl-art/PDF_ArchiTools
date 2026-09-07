/**
 * The annotator's save, driven through the real UI of the built artifact.
 *
 * The service-level gate (`smoke-annotator-vector-save.mjs`) proves the save
 * module does the right thing when it is handed the right job. This one proves
 * the app hands it that job: the toolbar, the layer menu, the canvas, the save
 * button and the download, with nothing stubbed and no test hook in production
 * code.
 *
 * It drives `dist/`, not the dev server, because the wiring being tested — which
 * PDF.js worker is fetched, whether the source bytes survive the upload, what
 * the downloaded file is called — is a property of the bundle.
 *
 * Run:  npm run build
 *       node scripts/make-annotator-save-fixtures.mjs
 *       node scripts/smoke-annotator-save-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5184;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE = path.join(ROOT, 'test-fixtures', 'annotator-save', 'rich.pdf');

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to test. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(FIXTURE)) {
    console.error('Fixtures missing. Run: node scripts/make-annotator-save-fixtures.mjs');
    process.exit(1);
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'annotator-save-ui-'));
const server = await preview({
    root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn',
});
const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);
await page.setViewport({ width: 1400, height: 1000 });

const requests = [];
const pageErrors = [];
const consoleErrors = [];
page.on('request', (r) => requests.push(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => requests.push(e.request?.url));
    } catch { /* gone */ }
});

const cdp = await page.target().createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** The layer popover toggles, so open it only when it is not already open. */
const openLayerMenu = async () => {
    const already = await page.evaluate(() => document.querySelector('.layer-list-popover') !== null);
    if (already) return true;
    const clicked = await page.evaluate(() => {
        const trigger = document.querySelector('.layer-list-popover-trigger');
        if (!trigger) return false;
        (trigger.firstElementChild ?? trigger).click();
        return true;
    });
    if (!clicked) return false;
    // React re-renders on its own schedule, so the popover is waited for
    // rather than assumed to exist the instant the click returns.
    await page.waitForSelector('.layer-list-popover', { timeout: 10000 }).catch(() => {});
    return page.evaluate(() => document.querySelector('.layer-list-popover') !== null);
};
const clickByTitle = (title) => page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, [title]')].find((b) => b.getAttribute('title') === t);
    if (!el) return false;
    el.click();
    return true;
}, title);

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF加筆'))?.click();
    });
    await page.waitForSelector('input[type="file"][accept="application/pdf"]');
    const input = await page.$('input[type="file"][accept="application/pdf"]');
    await input.uploadFile(FIXTURE);
    await page.waitForSelector('canvas.pdf-canvas', { timeout: 60000 });
    await settle(1200);

    console.log('\n=== the document opened ===');
    const opened = await page.evaluate(() => {
        const c = document.querySelector('canvas.pdf-canvas');
        return { width: c?.width ?? 0, height: c?.height ?? 0, canvases: document.querySelectorAll('canvas').length };
    });
    check('the page rendered', opened.width > 0 && opened.height > 0,
        `${opened.width}x${opened.height}`);

    const box = await page.evaluate(() => {
        const c = document.querySelector('canvas.pdf-canvas');
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const at = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });

    // ---- draw on layer 1, through the toolbar and the canvas -------------
    console.log('\n=== drawing through the UI ===');
    check('the pen tool is available', await clickByTitle('Pen'));
    const drawLine = async (y) => {
        const from = at(120, y);
        const to = at(400, y);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) {
            await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y);
        }
        await page.mouse.up();
        await settle(120);
    };
    await drawLine(200);

    // ---- text, through the text tool -------------------------------------
    check('the text tool is available', await clickByTitle('Text Tool'));
    const textAt = at(120, 300);
    await page.mouse.click(textAt.x, textAt.y);
    await page.waitForSelector('textarea', { timeout: 20000 });
    await page.type('textarea', 'UISAVEDTEXT');
    // Blur commits it, the same way a user clicking away would.
    await page.evaluate(() => document.querySelector('textarea')?.blur());
    await settle(300);
    check('the typed text was committed', await page.evaluate(() => !document.querySelector('textarea')));

    // ---- a second layer, drawn on and then hidden ------------------------
    console.log('\n=== a hidden layer ===');
    check('the layer menu opens', await openLayerMenu());
    await settle(200);
    check('a layer can be added', await clickByTitle('Add Layer'));
    await settle(300);
    await clickByTitle('Pen');
    await drawLine(500);
    await settle(200);
    check('the layer list is showing both layers',
        await page.evaluate(() => {
            const open = document.querySelector('.layer-list-popover') !== null;
            return open && document.querySelectorAll('.layer-item').length === 2;
        }),
        'two rows');
    // ---- save, twice: with the second layer showing, and hidden ----------
    //
    // One save cannot show that a hidden layer is excluded — it can only show
    // that *something* was saved. Two saves of the same drawing, differing only
    // in that visibility toggle, can.
    console.log('\n=== saving ===');
    const saveOnce = async (label) => {
        const before = fs.readdirSync(downloads);
        const clicked = await page.evaluate(() => {
            const b = document.querySelector('[data-usage-target="annotator-save"]');
            if (!b) return false;
            b.click();
            return true;
        });
        if (!clicked) return { label, clicked: false };
        let name = null;
        for (let i = 0; i < 120 && !name; i++) {
            await settle(500);
            const now = fs.readdirSync(downloads)
                .filter((f2) => !before.includes(f2) && f2.endsWith('.pdf'));
            if (now.length > 0) name = now[0];
        }
        if (!name) return { label, clicked: true, name: null };
        const bytes = new Uint8Array(fs.readFileSync(path.join(downloads, name)));
        fs.rmSync(path.join(downloads, name));
        return { label, clicked: true, name, bytes };
    };

    const withLayer2 = await saveOnce('layer 2 visible');
    check('the save button is there and was clicked', withLayer2.clicked === true);
    check('a PDF was downloaded', withLayer2.bytes !== undefined,
        withLayer2.name ?? 'nothing appeared');
    if (!withLayer2.bytes) throw new Error('no download');
    check('named after the source, not overwriting it',
        withLayer2.name === 'rich_annotated.pdf', withLayer2.name);

    console.log('\n=== the same drawing, with that layer hidden ===');
    // Hide the layer just drawn on: the last visibility toggle in the list.
    const hidden = await page.evaluate(() => {
        // The row whose name is "Layer 2", and its visibility toggle — the
        // first icon button in that row.
        const row = [...document.querySelectorAll('.layer-item')].find(
            (el) => el.querySelector('.layer-name')?.textContent?.trim() === 'Layer 2',
        );
        const toggle = row?.querySelector('button.icon-btn:not(.danger)');
        if (!toggle) return { clicked: false, rows: document.querySelectorAll('.layer-item').length };
        toggle.click();
        return { clicked: true, rows: document.querySelectorAll('.layer-item').length };
    });
    check('the second layer was hidden', hidden.clicked === true, `${hidden.rows} layer rows`);
    await settle(300);
    // The mark on layer 2 is now hidden on screen, which is the state the save
    // must reproduce.
    check('layer 2 is hidden on screen',
        await page.evaluate(() => {
            const wrappers = [...document.querySelectorAll('.pdf-page-container > div')]
                .filter((d) => d.querySelector('canvas'));
            return wrappers.some((d) => d.style.display === 'none');
        }));
    await settle(200);

    const withoutLayer2 = await saveOnce('layer 2 hidden');
    check('the second save produced a file too', withoutLayer2.bytes !== undefined,
        withoutLayer2.name ?? 'nothing appeared');
    if (!withoutLayer2.bytes) throw new Error('no second download');

    // ---- what came out ------------------------------------------------------
    console.log('\n=== what the UI produced ===');
    const outBytes = withoutLayer2.bytes;
    const sourceBytes = new Uint8Array(fs.readFileSync(FIXTURE));

    const doc = await PDFDocument.load(outBytes, { updateMetadata: false });
    check('the output is a readable PDF', doc.getPageCount() === 1, `${doc.getPageCount()} page`);
    check('the source metadata is still there', doc.getTitle() === 'M3 rich source',
        JSON.stringify(doc.getTitle()));
    const fields = Object.fromEntries(doc.getForm().getFields()
        .map((f) => [f.getName(), typeof f.getText === 'function' ? f.getText() : '']));
    check('the source form fields and values are still there',
        fields['drawing.number'] === 'A-101', JSON.stringify(fields));

    // What the file actually says, read the way any reader would read it.
    const extract = async (bytes) => {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
        const out = [];
        for (let n = 1; n <= d.numPages; n++) {
            const p = await d.getPage(n);
            const content = await p.getTextContent();
            const ops = await p.getOperatorList();
            let images = 0;
            for (const fn of ops.fnArray) {
                if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintJpegXObject) images += 1;
            }
            out.push({ text: content.items.map((i) => i.str).join(' '), images, ops: ops.fnArray.length });
        }
        return out;
    };
    const beforePages = await extract(sourceBytes);
    const afterPages = await extract(outBytes);

    check("the source's searchable text survives",
        afterPages[0].text.includes('SEARCHABLE-SOURCE-TEXT'));
    check("and the source's invisible OCR layer survives",
        afterPages[0].text.includes('INVISIBLE-OCR-LAYER'));
    check('the text typed into the UI is extractable from the file',
        afterPages[0].text.includes('UISAVEDTEXT'),
        JSON.stringify(afterPages[0].text.slice(-60)));
    // The claim the whole feature turns on.
    probe('the page was not replaced by a page image',
        afterPages[0].images === beforePages[0].images,
        `${beforePages[0].images} -> ${afterPages[0].images} images`);
    check('and the page still carries operators, not just a picture',
        afterPages[0].ops > beforePages[0].ops,
        `${beforePages[0].ops} -> ${afterPages[0].ops} operators`);

    const visiblePages = await extract(withLayer2.bytes);
    probe('a mark on a hidden layer is not in the file',
        afterPages[0].ops < visiblePages[0].ops,
        `${visiblePages[0].ops} operators with it showing, ${afterPages[0].ops} with it hidden`);
    check('while the visible layers are still there',
        afterPages[0].text.includes('UISAVEDTEXT') && afterPages[0].ops > beforePages[0].ops,
        `${beforePages[0].ops} -> ${afterPages[0].ops} operators`);

    check('the source is preserved, not replaced',
        outBytes.length > sourceBytes.length,
        `${sourceBytes.length} -> ${outBytes.length} bytes`);

    // ---- the worker, and the network ---------------------------------------
    console.log('\n=== the network ===');
    const localWorker = requests.filter((u) => u === `${ORIGIN}/pdf.worker.min.mjs`);
    const localFont = requests.filter((u) => u === `${ORIGIN}/ocr/fonts/MPLUS1p-Regular.ttf`);
    const isExternal = (u) => {
        if (!u || u.startsWith(ORIGIN)) return false;
        try {
            const { protocol } = new URL(u);
            return protocol === 'http:' || protocol === 'https:';
        } catch { return false; }
    };
    const external = requests.filter(isExternal);
    check('the PDF.js worker came from this app', localWorker.length >= 1,
        `${localWorker.length} request(s)`);
    check('and so did the annotation font', localFont.length >= 1,
        `${localFont.length} request(s) to /ocr/fonts/MPLUS1p-Regular.ttf`);
    probe('no external HTTP(S) request in the whole session',
        external.length === 0, external.length === 0 ? '0 requests' : external.join(' '));
    probe('and no render error was logged',
        consoleErrors.filter((t) => t.includes('Render error:')).length === 0,
        consoleErrors.filter((t) => t.includes('Render error:')).join(' | ') || '0');
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nThe Annotator saves onto the document it opened.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nUI smoke failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
    fs.rmSync(downloads, { recursive: true, force: true });
}

process.exit(exitCode);
