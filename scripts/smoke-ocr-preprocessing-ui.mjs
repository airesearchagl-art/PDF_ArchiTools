/**
 * UI gate for OCR preprocessing against the PRODUCTION build.
 *
 * The module gate proves the algorithms. What only the UI can show is that the
 * checkboxes are real: that they start off, that turning them on actually
 * reaches the pipeline, that the file which lands on disk is a working
 * searchable PDF whose appearance is unchanged, and that the same settings
 * carry into the text export.
 *
 * The download is performed for real and reopened, because a run that finishes
 * on screen proves nothing about the file the user receives.
 *
 * Run:  npm run build && node scripts/smoke-ocr-preprocessing-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5196;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
const SKEWED = 'scanned-skew-plus-3.pdf';

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, SKEWED))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
page.setDefaultTimeout(60_000);

const pageErrors = [];
const external = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    if (/^https?:/.test(url)) external.push(url);
};
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => record(r.url()));
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* target already gone */ }
});

const clickButton = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(t));
    if (!b) throw new Error(`button not found: ${t}`);
    b.click();
}, text);

const screenState = () => page.evaluate(() => {
    const boxes = {};
    for (const name of ['deskew', 'noiseReduction']) {
        const el = document.querySelector(`input[name="${name}"]`);
        boxes[name] = el ? { checked: el.checked, disabled: el.disabled } : null;
    }
    const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
    return {
        boxes,
        downloadName: link?.getAttribute('download') ?? null,
        complete: document.body.innerText.includes('Processing Complete!'),
        summary: [...document.querySelectorAll('p')].map((p) => p.textContent.trim())
            .find((t) => t.includes('ページ処理')) ?? null,
    };
});

const setBox = (name, value) => page.evaluate((n, v) => {
    const el = document.querySelector(`input[name="${n}"]`);
    if (!el) throw new Error(`checkbox not found: ${n}`);
    if (el.checked !== v) el.click();
}, name, value);

const selectMode = (value) => page.evaluate((v) => {
    const radio = [...document.querySelectorAll('input[name="mode"]')].find((r) => r.value === v);
    if (!radio) throw new Error(`mode radio not found: ${v}`);
    radio.click();
}, value);

async function runAndWatch() {
    await page.evaluate(() => {
        window.__seen = new Set();
        const pattern = /判定中|抽出中|認識中|読み込み中|書き出し中/;
        const consider = (raw) => {
            const t = (raw || '').trim();
            if (t && t.length < 40 && pattern.test(t)) window.__seen.add(t);
        };
        const o = new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === 'characterData') consider(r.target.data);
                for (const n of r.addedNodes) consider(n.textContent);
            }
        });
        o.observe(document.body, { subtree: true, childList: true, characterData: true });
        window.__obs = o;
    });
    await clickButton('Start Textification');
    const deadline = Date.now() + 180_000;
    let done = false;
    while (Date.now() < deadline) {
        const s = await page.evaluate(() => ({
            done: document.body.innerText.includes('Processing Complete!'),
            failed: document.body.innerText.includes('予期しないエラー'),
        }));
        if (s.done || s.failed) { done = s.done; break; }
        await new Promise((r) => setTimeout(r, 100));
    }
    const messages = await page.evaluate(() => { window.__obs?.disconnect(); return [...window.__seen]; });
    return { done, messages };
}

async function download(dir, expected) {
    await page.evaluate(() => {
        const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
        if (!link) throw new Error('no download link on screen');
        link.click();
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const entries = fs.readdirSync(dir);
        const settled = entries.filter((f) => !f.endsWith('.crdownload'));
        if (settled.includes(expected)) return expected;
        if (settled.length && !entries.some((f) => f.endsWith('.crdownload'))) return settled[0];
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

const openTool = async () => {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await clickButton('PDFテキスト化');
    await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
    const input = await page.$('input[type="file"]');
    await input.uploadFile(path.join(FIXTURES, SKEWED));
    await page.waitForFunction((n) => document.body.innerText.includes(n), {}, SKEWED);
    // The preview paints before anything else is worth doing.
    await page.waitForFunction(() => {
        const c = document.querySelector('canvas');
        if (!c || !c.width) return false;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] !== 0 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 200) return true;
        }
        return false;
    }, { timeout: 30_000 });
};

let exitCode = 1;
try {
    await page.bringToFront();
    await openTool();
    check('PDFテキスト化 opens with the skewed fixture', true);

    const initial = await screenState();
    console.log(`  initial : ${JSON.stringify(initial.boxes)}`);
    check('both preprocessing options exist and are usable',
        initial.boxes.deskew?.disabled === false && initial.boxes.noiseReduction?.disabled === false,
        JSON.stringify(initial.boxes));
    check('both preprocessing options start switched off',
        initial.boxes.deskew?.checked === false && initial.boxes.noiseReduction?.checked === false,
        JSON.stringify(initial.boxes));

    // ---- OCR mode with preprocessing on --------------------------------------
    console.log('\n=== OCR with 傾き補正 + ノイズ除去 ===');
    await setBox('deskew', true);
    await setBox('noiseReduction', true);
    const armed = await screenState();
    check('turning them on is reflected on screen',
        armed.boxes.deskew.checked === true && armed.boxes.noiseReduction.checked === true,
        JSON.stringify(armed.boxes));

    const downloads = fs.mkdtempSync(path.join(FIXTURES, 'ui-prep-'));
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    const run = await runAndWatch();
    console.log(`  progress: ${JSON.stringify(run.messages)}`);
    check('the run completes', run.done === true);
    check('progress is still reported per page', run.messages.some((m) => /認識中/.test(m)),
        JSON.stringify(run.messages));

    const done = await screenState();
    console.log(`  result  : ${done.downloadName} / ${done.summary}`);
    check('a searchable PDF is offered', done.downloadName === 'scanned-skew-plus-3_searchable.pdf',
        String(done.downloadName));

    const file = await download(downloads, 'scanned-skew-plus-3_searchable.pdf');
    check('the searchable PDF downloads', file === 'scanned-skew-plus-3_searchable.pdf', String(file));

    if (file) {
        const bytes = fs.readFileSync(path.join(downloads, file));
        const doc = await PDFDocument.load(bytes);
        check('the downloaded PDF reopens with its page count intact', doc.getPageCount() === 1,
            String(doc.getPageCount()));

        // What the file itself carries. Pixel comparison of the rendered page
        // and the geometry of the text layer need pdf.js, which the production
        // bundle does not expose to the page; those live in the module gate,
        // which imports it directly and asserts both on this same fixture.
        // Read the structure rather than the bytes: pdf-lib compresses its
        // output, so the font name is not sitting in the file as plain text.
        const names = doc.context.enumerateIndirectObjects()
            .map(([, obj]) => { try { return obj.toString(); } catch { return ''; } })
            .join(' ');
        check('the downloaded PDF carries the OCR font the text layer uses',
            names.includes('OcrFont'), 'OCR font dictionary present');
        check('the downloaded PDF is larger than the input, as a text layer implies',
            bytes.length > fs.statSync(path.join(FIXTURES, SKEWED)).size,
            `${fs.statSync(path.join(FIXTURES, SKEWED)).size} -> ${bytes.length}`);
    }
    fs.rmSync(downloads, { recursive: true, force: true });

    // ---- Text Extraction with preprocessing on --------------------------------
    console.log('\n=== Text Extraction with preprocessing on ===');
    await selectMode('extract');
    const extractArmed = await screenState();
    check('switching mode clears the previous result but keeps the settings',
        extractArmed.downloadName === null
        && extractArmed.boxes.deskew.checked === true
        && extractArmed.boxes.noiseReduction.checked === true,
        JSON.stringify(extractArmed));

    const txtDir = fs.mkdtempSync(path.join(FIXTURES, 'ui-prep-txt-'));
    const txtClient = await page.createCDPSession();
    await txtClient.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: txtDir });

    const txtRun = await runAndWatch();
    check('the text extraction run completes', txtRun.done === true);
    const txtDone = await screenState();
    check('a .txt is offered', txtDone.downloadName === 'scanned-skew-plus-3_extracted.txt',
        String(txtDone.downloadName));

    const txtFile = await download(txtDir, 'scanned-skew-plus-3_extracted.txt');
    check('the TXT downloads', txtFile === 'scanned-skew-plus-3_extracted.txt', String(txtFile));
    if (txtFile) {
        const content = fs.readFileSync(path.join(txtDir, txtFile), 'utf8');
        console.log(`  content : ${JSON.stringify(content.slice(0, 120))}`);
        check('the TXT holds the page header', /^===== Page 1 =====/.test(content),
            JSON.stringify(content.slice(0, 24)));
        const tokens = ['建築', '図面', 'Architectural', 'Drawing'];
        const hits = tokens.filter((t) => content.includes(t));
        check('the TXT holds the expected Japanese and English from a crooked scan',
            hits.length === tokens.length, `${hits.length}/${tokens.length} ${JSON.stringify(tokens.filter((t) => !content.includes(t)))}`);
    }
    fs.rmSync(txtDir, { recursive: true, force: true });

    // ---- turning a setting off invalidates the result -------------------------
    await setBox('deskew', false);
    const afterToggle = await screenState();
    check('changing a preprocessing setting clears the finished result',
        afterToggle.downloadName === null && afterToggle.complete === false,
        JSON.stringify(afterToggle));

    // ---- network ---------------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external HTTP request during the whole flow', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
