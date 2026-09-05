/**
 * UI gate for Text Extraction against the PRODUCTION build.
 *
 * The module gate covers the extraction itself. What only the UI can show is
 * that the mode a person picked is the mode they get: that Text Extraction
 * offers a .txt and not a searchable PDF, that switching mode does not leave the
 * previous mode's finished file sitting under a Download button, and that the
 * file which actually lands on disk is the UTF-8 text of the PDF they uploaded.
 *
 * The download is performed for real and read back, because a blob that never
 * reaches the filesystem proves nothing about what the user receives.
 *
 * Run:  npm run build && node scripts/smoke-text-extraction-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5188;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
const FIXTURE = 'mixed-multipage.pdf';

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, FIXTURE))) {
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
await page.setViewport({ width: 1280, height: 900 });
page.setDefaultTimeout(60_000);

const pageErrors = [];
const external = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    if (/^https?:/.test(url)) external.push(url);
};
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => record(r.url()));
// OCR and PDF.js both run in their own workers, whose traffic page-level events
// never see. Without this the network check would only be measuring the shell.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* target already gone */ }
});

const clickButton = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(t));
    if (!b) throw new Error(`button not found: ${t}`);
    b.click();
}, text);

/** What the Textifier screen is currently offering. */
const screenState = () => page.evaluate(() => {
    const select = document.querySelector('select');
    const modes = [...document.querySelectorAll('input[name="mode"]')].map((r) => ({
        value: r.value, checked: r.checked, disabled: r.disabled,
    }));
    const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
    return {
        modes,
        format: select?.value ?? null,
        formatLabel: select?.selectedOptions?.[0]?.textContent?.trim() ?? null,
        formatOptions: [...(select?.options ?? [])].map((o) => `${o.value}${o.disabled ? '(disabled)' : ''}`),
        downloadName: link?.getAttribute('download') ?? null,
        complete: document.body.innerText.includes('Processing Complete!'),
        summary: [...document.querySelectorAll('p')].map((p) => p.textContent.trim())
            .find((t) => t.includes('ページ処理')) ?? null,
    };
});

const selectMode = (value) => page.evaluate((v) => {
    const radio = [...document.querySelectorAll('input[name="mode"]')].find((r) => r.value === v);
    if (!radio) throw new Error(`mode radio not found: ${v}`);
    radio.click();
}, value);

/**
 * Run to completion while recording what the progress area actually said.
 *
 * Observed rather than polled: reading a text-native page takes about a
 * millisecond, so a poll fast enough to catch 文字を抽出中 on a three-page
 * document would have to run flat out and would still miss it by luck. A
 * MutationObserver sees every string React renders, however briefly.
 */
async function runAndWatch() {
    await page.evaluate(() => {
        window.__progressSeen = new Set();
        const pattern = /判定中|抽出中|認識中|読み込み中|書き出し中/;
        const consider = (raw) => {
            const text = (raw || '').trim();
            // Short strings only: the surrounding panel also holds the cancel
            // button and its explanation, which is not a progress message.
            if (text && text.length < 40 && pattern.test(text)) window.__progressSeen.add(text);
        };
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'characterData') consider(record.target.data);
                for (const node of record.addedNodes) consider(node.textContent);
            }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        window.__progressObserver = observer;
    });

    await clickButton('Start Textification');
    const deadline = Date.now() + 180_000;
    let done = false;
    while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({
            done: document.body.innerText.includes('Processing Complete!'),
            failed: document.body.innerText.includes('予期しないエラー'),
        }));
        if (state.done || state.failed) { done = state.done; break; }
        await new Promise((r) => setTimeout(r, 100));
    }
    const messages = await page.evaluate(() => {
        window.__progressObserver?.disconnect();
        return [...window.__progressSeen];
    });
    return { done, messages };
}

/** Click the real download link and wait for the file to land. */
async function download(dir) {
    await page.evaluate(() => {
        const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
        if (!link) throw new Error('no download link on screen');
        link.click();
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const entries = fs.readdirSync(dir);
        const settled = entries.filter((f) => !f.endsWith('.crdownload'));
        if (settled.length && !entries.some((f) => f.endsWith('.crdownload'))) return settled[0];
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await clickButton('PDFテキスト化');
    await page.waitForFunction(() => document.body.innerText.includes('PDFテキスト化 (PDF Textification)'));
    check('PDFテキスト化 opens', true);

    const input = await page.$('input[type="file"]');
    await input.uploadFile(path.join(FIXTURES, FIXTURE));
    await page.waitForFunction((n) => document.body.innerText.includes(n), {}, FIXTURE);

    const initial = await screenState();
    console.log(`  initial   : ${JSON.stringify(initial)}`);
    check('Text Extraction is offered, not greyed out',
        initial.modes.length === 2 && initial.modes[1].value === 'extract'
        && initial.modes[1].disabled === false, JSON.stringify(initial.modes));
    check('OCR is still the default mode',
        initial.modes[0].checked === true && initial.format === 'pdf', JSON.stringify(initial.modes));

    // ---- an OCR result must not survive the switch to Text Extraction --------
    console.log('\n=== mode switching invalidates the previous result ===');
    const ocrRun = await runAndWatch();
    const afterOcr = await screenState();
    console.log(`  after OCR : ${JSON.stringify(afterOcr)}`);
    check('OCR mode still produces a searchable PDF',
        ocrRun.done === true && afterOcr.downloadName === 'mixed-multipage_searchable.pdf',
        String(afterOcr.downloadName));

    await selectMode('extract');
    const switched = await screenState();
    console.log(`  switched  : ${JSON.stringify(switched)}`);
    check('switching to Text Extraction clears the OCR download',
        switched.downloadName === null && switched.complete === false, JSON.stringify(switched));
    check('Text Extraction selects Text (.txt)',
        switched.format === 'txt' && switched.formatLabel === 'Text (.txt)',
        `${switched.format} / ${switched.formatLabel}`);
    // Word became a real option in M2-3 and has its own gate; what this one
    // still holds is that Text is the default and Excel is not offered.
    check('Text is the default, and Excel stays unavailable',
        switched.formatOptions.join(',') === 'txt,word,excel(disabled)',
        switched.formatOptions.join(','));

    // ---- the real run, downloaded for real ----------------------------------
    console.log('\n=== Text Extraction run ===');
    const downloads = fs.mkdtempSync(path.join(FIXTURES, 'ui-txt-'));
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    const extractRun = await runAndWatch();
    console.log(`  progress  : ${JSON.stringify(extractRun.messages)}`);
    check('the run completes', extractRun.done === true);
    check('progress is reported per page while it runs',
        extractRun.messages.some((m) => /判定中\.\.\. \d+ \/ 3/.test(m))
        && extractRun.messages.some((m) => /抽出中\.\.\. \d+ \/ 3/.test(m))
        && extractRun.messages.some((m) => /認識中\.\.\. \d+ \/ 3/.test(m)),
        JSON.stringify(extractRun.messages));

    const done = await screenState();
    console.log(`  result    : ${JSON.stringify(done)}`);
    check('the result offers a .txt download',
        done.downloadName === 'mixed-multipage_extracted.txt', String(done.downloadName));
    check('the result counts the characters it wrote',
        /3 ページ処理/.test(done.summary ?? '') && /抽出 \d+ 文字/.test(done.summary ?? ''),
        String(done.summary));

    const file = await download(downloads);
    check('the TXT actually downloads', file === 'mixed-multipage_extracted.txt', String(file));

    if (file) {
        const bytes = fs.readFileSync(path.join(downloads, file));
        let text = null;
        let utf8 = false;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            utf8 = true;
        } catch (e) {
            text = String(e);
        }
        console.log(`  file      : ${bytes.length} bytes`);
        console.log(`  content   : ${JSON.stringify(text.slice(0, 160))}`);
        check('the downloaded file is valid UTF-8', utf8 === true, text.slice(0, 80));

        const headers = [...text.matchAll(/^===== Page (\d+) =====$/gm)].map((m) => Number(m[1]));
        check('every page has a header, in the original order',
            headers.join(',') === '1,2,3', headers.join(','));
        check('the file starts at page 1 with no leading noise',
            text.startsWith('===== Page 1 ====='), JSON.stringify(text.slice(0, 24)));

        const blocks = text.split(/^===== Page \d+ =====$/m).slice(1).map((b) => b.trim());
        check('page 1 carries the first sheet\'s own Japanese and English',
            blocks[0].includes('建築図面') && /Architectural Drawing/.test(blocks[0]),
            JSON.stringify(blocks[0].slice(0, 60)));
        check('page 2 carries the recognised text of the scanned sheet',
            /建築|Architectural/.test(blocks[1]), JSON.stringify(blocks[1].slice(0, 60)));
        check('page 3 carries the last sheet\'s own text',
            /最終ページ|Final Page/.test(blocks[2]), JSON.stringify(blocks[2].slice(0, 60)));
        check('no stringified placeholder reached the file',
            !/\[object Object\]|\bundefined\b|\bnull\b|\bNaN\b/.test(text));
    }
    fs.rmSync(downloads, { recursive: true, force: true });

    // ---- and back the other way ---------------------------------------------
    await selectMode('ocr');
    const backToOcr = await screenState();
    console.log(`\n  back to OCR: ${JSON.stringify(backToOcr)}`);
    check('switching back to OCR clears the TXT download',
        backToOcr.downloadName === null && backToOcr.complete === false, JSON.stringify(backToOcr));
    check('OCR mode offers PDF (Searchable) again',
        backToOcr.format === 'pdf' && backToOcr.formatLabel === 'PDF (Searchable)',
        `${backToOcr.format} / ${backToOcr.formatLabel}`);

    // ---- network -------------------------------------------------------------
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
