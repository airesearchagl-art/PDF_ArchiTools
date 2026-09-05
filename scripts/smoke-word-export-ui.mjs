/**
 * UI gate for the Word export against the PRODUCTION build.
 *
 * The module gate proves the package. What only the UI can show is that the
 * option is real: that Word appears where Text Extraction can produce it, that
 * choosing it changes what arrives, and that the file which lands on disk is a
 * .docx that reopens with the right text in it.
 *
 * The download is performed for real and reopened with JSZip, because a run
 * that finishes on screen proves nothing about the file the user receives.
 *
 * Run:  npm run build && node scripts/smoke-word-export-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
const MIXED = 'mixed-multipage.pdf';
const SKEWED = 'scanned-skew-plus-3.pdf';
const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, MIXED))) {
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
    const select = document.querySelector('select');
    const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
    const boxes = {};
    for (const name of ['deskew', 'noiseReduction']) {
        const el = document.querySelector(`input[name="${name}"]`);
        boxes[name] = el ? el.checked : null;
    }
    return {
        format: select?.value ?? null,
        formatLabel: select?.selectedOptions?.[0]?.textContent?.trim() ?? null,
        formatOptions: [...(select?.options ?? [])].map((o) => `${o.value}${o.disabled ? '(disabled)' : ''}`),
        boxes,
        downloadName: link?.getAttribute('download') ?? null,
        complete: document.body.innerText.includes('Processing Complete!'),
    };
});

const setFormat = (value) => page.evaluate((v) => {
    const select = document.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, v);
    select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

const selectMode = (value) => page.evaluate((v) => {
    const radio = [...document.querySelectorAll('input[name="mode"]')].find((r) => r.value === v);
    if (!radio) throw new Error(`mode radio not found: ${v}`);
    radio.click();
}, value);

const setBox = (name, value) => page.evaluate((n, v) => {
    const el = document.querySelector(`input[name="${n}"]`);
    if (!el) throw new Error(`checkbox not found: ${n}`);
    if (el.checked !== v) el.click();
}, name, value);

async function runToCompletion() {
    await clickButton('Start Textification');
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        const s = await page.evaluate(() => ({
            done: document.body.innerText.includes('Processing Complete!'),
            failed: document.body.innerText.includes('予期しないエラー')
                || document.body.innerText.includes('Wordファイルの生成に失敗'),
        }));
        if (s.done) return true;
        if (s.failed) return false;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
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

/** Reopen the downloaded package and read it the way a reader would. */
async function openDocx(file) {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    const documentXml = zip.file('word/document.xml')
        ? await zip.file('word/document.xml').async('string') : null;
    const relsXml = zip.file('_rels/.rels') ? await zip.file('_rels/.rels').async('string') : null;
    const text = documentXml
        ? await page.evaluate((xml) => {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            if (doc.querySelector('parsererror')) return null;
            return [...doc.getElementsByTagName('w:p')]
                .filter((p) => ![...p.getElementsByTagName('w:br')].some((b) => b.getAttribute('w:type') === 'page'))
                .map((p) => [...p.getElementsByTagName('w:t')].map((t) => t.textContent).join(''))
                .join('\n');
        }, documentXml)
        : null;
    // Parsed, not pattern-matched. Every relationship carries a Type that is a
    // schema URI beginning http://schemas.openxmlformats.org -- searching the
    // file for "http" therefore finds the spec, not a remote target. What
    // matters is the Target, and whether it is declared External.
    const relationships = relsXml
        ? await page.evaluate((xml) => {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            if (doc.querySelector('parsererror')) return null;
            return [...doc.getElementsByTagName('Relationship')].map((r) => ({
                target: r.getAttribute('Target'),
                mode: r.getAttribute('TargetMode') ?? 'Internal',
            }));
        }, relsXml)
        : null;

    return {
        entries,
        text,
        relationships,
        pageBreaks: (documentXml?.match(/<w:br w:type="page"\/>/g) ?? []).length,
        external: (relationships ?? []).some(
            (r) => r.mode === 'External' || /^https?:|^\\\\|^\/\//i.test(r.target ?? ''),
        ),
        targetsResolve: (relationships ?? []).every((r) => entries.includes((r.target ?? '').replace(/^\//, ''))),
        macros: entries.filter((n) => /vbaProject|\.bin$/i.test(n)),
    };
}

const openTool = async (fixture) => {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await clickButton('PDFテキスト化');
    await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
    const input = await page.$('input[type="file"]');
    await input.uploadFile(path.join(FIXTURES, fixture));
    await page.waitForFunction((n) => document.body.innerText.includes(n), {}, fixture);
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
    await openTool(MIXED);
    check('PDFテキスト化 opens with the mixed fixture', true);

    // ---- Word is offered where it can be produced, and nowhere else -----------
    const ocrFormats = await screenState();
    console.log(`  OCR mode  : ${JSON.stringify(ocrFormats.formatOptions)}`);
    check('OCR mode does not offer Word',
        ocrFormats.formatOptions.join(',') === 'pdf,excel(disabled)',
        ocrFormats.formatOptions.join(','));

    await selectMode('extract');
    const extractFormats = await screenState();
    console.log(`  Extract   : ${JSON.stringify(extractFormats.formatOptions)} default=${extractFormats.format}`);
    check('Text Extraction offers both Text and Word, Excel still not',
        extractFormats.formatOptions.join(',') === 'txt,word,excel(disabled)',
        extractFormats.formatOptions.join(','));
    check('Text (.txt) stays the default', extractFormats.format === 'txt',
        String(extractFormats.format));

    // ---- the .docx run --------------------------------------------------------
    console.log('\n=== Word export ===');
    await setFormat('word');
    const armed = await screenState();
    check('choosing Word is reflected on screen',
        armed.format === 'word' && armed.formatLabel === 'Word (.docx)',
        `${armed.format} / ${armed.formatLabel}`);

    const downloads = fs.mkdtempSync(path.join(FIXTURES, 'ui-word-'));
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    check('the run completes', (await runToCompletion()) === true);
    const done = await screenState();
    console.log(`  result    : ${done.downloadName}`);
    check('a .docx is offered', done.downloadName === 'mixed-multipage_extracted.docx',
        String(done.downloadName));

    // The blob really is typed as a Word document, not merely named like one.
    const blobType = await page.evaluate(async () => {
        const link = [...document.querySelectorAll('a')].find((a) => a.hasAttribute('download'));
        const res = await fetch(link.href);
        const blob = await res.blob();
        return { type: blob.type, size: blob.size };
    });
    console.log(`  blob      : ${JSON.stringify(blobType)}`);
    check('the download carries the OOXML wordprocessing MIME type',
        blobType.type === WORD_MIME, blobType.type);

    const file = await download(downloads, 'mixed-multipage_extracted.docx');
    check('the .docx actually downloads', file === 'mixed-multipage_extracted.docx', String(file));

    if (file) {
        const docx = await openDocx(path.join(downloads, file));
        console.log(`  entries   : ${JSON.stringify(docx.entries)}`);
        console.log(`  text      : ${JSON.stringify((docx.text ?? '').slice(0, 120))}`);
        check('the downloaded file is a package with the required parts',
            docx.entries.includes('[Content_Types].xml')
            && docx.entries.includes('_rels/.rels')
            && docx.entries.includes('word/document.xml'),
            JSON.stringify(docx.entries));
        check('its document parses as XML', typeof docx.text === 'string');
        check('it holds the Japanese and English of the source',
            (docx.text ?? '').includes('建築図面') && /Architectural Drawing/.test(docx.text ?? ''),
            JSON.stringify((docx.text ?? '').slice(0, 60)));
        check('the scanned page contributes its recognised text',
            /平面図|Floor Plan/.test(docx.text ?? ''));
        check('three pages give two explicit page breaks', docx.pageBreaks === 2,
            String(docx.pageBreaks));
        console.log(`  rels      : ${JSON.stringify(docx.relationships)}`);
        check('every relationship points at a part inside the package',
            docx.external === false && docx.targetsResolve === true,
            JSON.stringify(docx.relationships));
        check('it carries no macros', docx.macros.length === 0, JSON.stringify(docx.macros));
    }
    fs.rmSync(downloads, { recursive: true, force: true });

    // ---- switching format throws the old file away ----------------------------
    console.log('\n=== format switching ===');
    await setFormat('txt');
    const toTxt = await screenState();
    check('switching Word to Text clears the finished result',
        toTxt.downloadName === null && toTxt.complete === false, JSON.stringify(toTxt));

    const txtDir = fs.mkdtempSync(path.join(FIXTURES, 'ui-word-txt-'));
    const txtClient = await page.createCDPSession();
    await txtClient.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: txtDir });
    check('the Text run completes', (await runToCompletion()) === true);
    const txtDone = await screenState();
    check('Text mode offers the .txt again', txtDone.downloadName === 'mixed-multipage_extracted.txt',
        String(txtDone.downloadName));
    await setFormat('word');
    const backToWord = await screenState();
    check('switching Text to Word clears the finished result',
        backToWord.downloadName === null && backToWord.complete === false,
        JSON.stringify(backToWord));
    fs.rmSync(txtDir, { recursive: true, force: true });

    // ---- Word with preprocessing on -------------------------------------------
    console.log('\n=== Word with OCR preprocessing ===');
    await openTool(SKEWED);
    await selectMode('extract');
    await setFormat('word');
    await setBox('deskew', true);
    await setBox('noiseReduction', true);
    const prepArmed = await screenState();
    check('preprocessing and Word can be selected together',
        prepArmed.format === 'word' && prepArmed.boxes.deskew === true
        && prepArmed.boxes.noiseReduction === true, JSON.stringify(prepArmed));

    const prepDir = fs.mkdtempSync(path.join(FIXTURES, 'ui-word-prep-'));
    const prepClient = await page.createCDPSession();
    await prepClient.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: prepDir });
    check('the preprocessed Word run completes', (await runToCompletion()) === true);
    const prepFile = await download(prepDir, 'scanned-skew-plus-3_extracted.docx');
    check('the preprocessed .docx downloads', prepFile === 'scanned-skew-plus-3_extracted.docx',
        String(prepFile));
    if (prepFile) {
        const docx = await openDocx(path.join(prepDir, prepFile));
        console.log(`  text      : ${JSON.stringify((docx.text ?? '').slice(0, 100))}`);
        const tokens = ['建築', '図面', 'Architectural', 'Drawing'];
        const hits = tokens.filter((t) => (docx.text ?? '').includes(t));
        check('a crooked scan still reaches Word with its text',
            hits.length === tokens.length,
            `${hits.length}/${tokens.length} ${JSON.stringify(tokens.filter((t) => !(docx.text ?? '').includes(t)))}`);
        check('a single-page source gets no page break', docx.pageBreaks === 0,
            String(docx.pageBreaks));
    }
    fs.rmSync(prepDir, { recursive: true, force: true });

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
