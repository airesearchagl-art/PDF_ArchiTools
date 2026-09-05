/**
 * Deterministic smoke verification for the Text Extraction pipeline.
 *
 * Drives the production module in a real browser against synthetic fixtures.
 * Small on purpose: this is a gate, not a test framework. It exits non-zero if
 * any check fails.
 *
 * The two things a text export can get wrong and still look fine are covered
 * here explicitly: characters that quietly go missing, and pages that quietly
 * change order. Everything else follows from those.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/smoke-text-extraction.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'text-with-blank-page.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

/** Anything that is not our own origin. data:/blob: never touch the network. */
const external = [];
const pageErrors = [];
/** Same-origin OCR assets, so "the engine never started" can be proved. */
const ocrAssets = [];
const record = (url) => {
    if (!url) return;
    if (url.startsWith(`${ORIGIN}/ocr/`)) ocrAssets.push(url.slice(ORIGIN.length));
    if (url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
// OCR runs inside a Web Worker, and page-level events do not see its traffic.
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

/** Split the export back into page blocks, the way a reader would. */
function splitPages(text, headerFor) {
    const blocks = [];
    const lines = text.split('\n');
    let current = null;
    for (const line of lines) {
        const match = /^===== Page (\d+) =====$/.exec(line);
        if (match) {
            if (current) blocks.push(current);
            current = { pageNumber: Number(match[1]), header: line, body: [] };
            continue;
        }
        if (current) current.body.push(line);
    }
    if (current) blocks.push(current);
    for (const b of blocks) {
        b.text = b.body.join('\n').trim();
        b.headerMatchesModule = b.header === headerFor(b.pageNumber);
    }
    return blocks;
}

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-text-extraction-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__extract?.ready === true, { timeout: 120000 });
    const headerFor = (n) => `===== Page ${n} =====`;
    const modulePrefix = await page.evaluate(() => window.__extract.headerPrefix);
    check('the module writes the documented page header', modulePrefix === '===== Page ', modulePrefix);

    // ---- text-native first, so "no OCR asset was ever fetched" is provable --
    console.log('\n=== text-native-ja-en.pdf (must not touch OCR) ===');
    const tn = await page.evaluate(() => window.__extract.run('text-native-ja-en.pdf'));
    console.log(`  pages=${tn.pages.length} chars=${tn.totalChars} ocrUsed=${tn.ocrUsed} ${tn.totalMs}ms`);
    console.log(`  phases: ${tn.phases.join(', ')}`);
    console.log(`  text  : ${JSON.stringify(tn.text.slice(0, 140))}`);
    const tnBlocks = splitPages(tn.text, headerFor);

    check('text-native: extraction succeeds', tn.pages.length === 1 && tn.totalChars > 0,
        `${tn.pages.length} pages / ${tn.totalChars} chars`);
    check('text-native: Japanese token present', tnBlocks[0]?.text.includes('建築図面'),
        JSON.stringify(tnBlocks[0]?.text.slice(0, 60)));
    check('text-native: English token present', /Architectural Drawing/.test(tnBlocks[0]?.text ?? ''));
    check('text-native: the page is read from the PDF, not recognised',
        tn.pages[0].kind === 'text-native' && tn.pages[0].ocrWords === 0);
    check('text-native: the OCR engine never started', tn.ocrUsed === false);
    check('text-native: not one OCR asset was requested', ocrAssets.length === 0,
        `${ocrAssets.length} requested: ${[...new Set(ocrAssets)].slice(0, 3).join(' ')}`);
    check('text-native: progress reports the extraction phase',
        tn.phases.includes('extracting') && !tn.phases.includes('ocr-init'), tn.phases.join(','));
    check('text-native: progress counts pages for the user',
        tn.messages.some((m) => m.startsWith('文字を抽出中... 1 / 1')),
        JSON.stringify(tn.messages.filter((m) => m.includes('抽出'))));

    // ---- scanned pages -------------------------------------------------------
    const runs = { 'text-native-ja-en.pdf': tn };
    for (const fixture of ['scanned-en.pdf', 'scanned-ja.pdf', 'scanned-ja-en.pdf', 'scanned-rotated.pdf',
        'mixed-multipage.pdf', 'text-with-blank-page.pdf']) {
        console.log(`\n=== ${fixture} ===`);
        const r = await page.evaluate((f) => window.__extract.run(f), fixture);
        runs[fixture] = r;
        for (const p of r.pages) {
            console.log(`  p${p.pageNumber}: ${p.kind.padEnd(12)} chars=${String(p.charCount).padStart(4)} ocrWords=${String(p.ocrWords).padStart(3)} conf=${p.meanConfidence ?? '-'} ${p.ms}ms`);
        }
        console.log(`  ocrUsed=${r.ocrUsed} totalChars=${r.totalChars} ${r.totalMs}ms`);
        console.log(`  text  : ${JSON.stringify(r.text.slice(0, 140))}`);
    }

    console.log('\n=== checks ===');
    const blocksOf = (name) => splitPages(runs[name].text, headerFor);

    const en = blocksOf('scanned-en.pdf');
    check('scanned English: recognised text reaches the export',
        /Architectural/.test(en[0]?.text ?? '') && /Drawing/.test(en[0]?.text ?? ''),
        JSON.stringify(en[0]?.text.slice(0, 60)));
    check('scanned English: the OCR engine was actually used',
        runs['scanned-en.pdf'].ocrUsed === true && runs['scanned-en.pdf'].pages[0].ocrWords > 0);

    const ja = blocksOf('scanned-ja.pdf');
    check('scanned Japanese: expected tokens present',
        /建築/.test(ja[0]?.text ?? '') && /図面/.test(ja[0]?.text ?? ''),
        JSON.stringify(ja[0]?.text.slice(0, 60)));

    const mix = blocksOf('scanned-ja-en.pdf');
    check('scanned Japanese + English: both languages present',
        /建築/.test(mix[0]?.text ?? '') && /Architectural/.test(mix[0]?.text ?? ''),
        JSON.stringify(mix[0]?.text.slice(0, 60)));

    const rot = blocksOf('scanned-rotated.pdf');
    check('rotated scan: recognised text reaches the export',
        /建築|Architectural/.test(rot[0]?.text ?? ''), JSON.stringify(rot[0]?.text.slice(0, 60)));

    // ---- mixed multipage: the order is the whole point ----------------------
    const multi = runs['mixed-multipage.pdf'];
    const multiBlocks = blocksOf('mixed-multipage.pdf');
    check('mixed: three pages processed', multi.pages.length === 3, String(multi.pages.length));
    check('mixed: per-page classification preserved (text/scan/text)',
        multi.pages.map((p) => p.kind).join(',') === 'text-native,scanned,text-native',
        multi.pages.map((p) => p.kind).join(','));
    check('mixed: only the scanned page was recognised',
        multi.pages[0].ocrWords === 0 && multi.pages[1].ocrWords > 0 && multi.pages[2].ocrWords === 0,
        multi.pages.map((p) => p.ocrWords).join('/'));
    check('mixed: the export keeps the original page order',
        multiBlocks.map((b) => b.pageNumber).join(',') === '1,2,3',
        multiBlocks.map((b) => b.pageNumber).join(','));
    check('mixed: page 1 holds the first page\'s own text',
        multiBlocks[0]?.text.includes('建築図面') && /Architectural Drawing/.test(multiBlocks[0]?.text ?? ''));
    check('mixed: page 2 holds the recognised text of the scanned sheet',
        /建築|Architectural/.test(multiBlocks[1]?.text ?? ''), JSON.stringify(multiBlocks[1]?.text.slice(0, 60)));
    check('mixed: page 3 holds the last page\'s own text',
        /最終ページ|Final Page/.test(multiBlocks[2]?.text ?? ''), JSON.stringify(multiBlocks[2]?.text.slice(0, 60)));

    // ---- TXT correctness, across every run -----------------------------------
    console.log('\n=== TXT correctness ===');
    for (const [name, r] of Object.entries(runs)) {
        const blocks = splitPages(r.text, headerFor);
        check(`${name}: one page header per source page`, blocks.length === r.pageCount,
            `${blocks.length} headers / ${r.pageCount} pages`);
        check(`${name}: headers are numbered 1..n in order`,
            blocks.every((b, i) => b.pageNumber === i + 1 && b.headerMatchesModule),
            blocks.map((b) => b.pageNumber).join(','));
        check(`${name}: survives a UTF-8 round trip as text/plain`,
            r.roundTripsAsUtf8 === true && r.blobType === 'text/plain;charset=utf-8', r.blobType);
        // A value that stringified badly is worse than a missing one: it reads
        // as if it were part of the drawing.
        check(`${name}: no stringified placeholder leaked into the body`,
            !/\[object Object\]|\bundefined\b|\bnull\b|\bNaN\b/.test(blocks.map((b) => b.text).join('\n')),
            JSON.stringify(r.text.slice(0, 80)));
    }

    const blank = runs['text-with-blank-page.pdf'];
    const blankBlocks = blocksOf('text-with-blank-page.pdf');
    console.log(`  blank fixture: ${JSON.stringify(blankBlocks.map((b) => ({ p: b.pageNumber, chars: b.text.length })))}`);
    check('empty page: its header is still written', blankBlocks.length === 3
        && blankBlocks[1].pageNumber === 2 && blankBlocks[1].headerMatchesModule,
        blankBlocks.map((b) => b.pageNumber).join(','));
    check('empty page: the pages around it keep their own text',
        blankBlocks[0].text.includes('建築図面') && /最終ページ|Final Page/.test(blankBlocks[2].text),
        `${blankBlocks[0].text.length}/${blankBlocks[1].text.length}/${blankBlocks[2].text.length} chars`);
    check('empty page: the run still reports three pages', blank.pages.length === 3);

    // ---- cancellation ---------------------------------------------------------
    console.log('\n=== cancellation ===');
    const cancel = await page.evaluate(() => window.__extract.cancelProbe('mixed-multipage.pdf'));
    console.log(`  ${JSON.stringify(cancel)}`);
    check('cancel rejects instead of returning a partial export',
        cancel.threw === true && cancel.code === 'cancelled', JSON.stringify(cancel));
    check('cancel hands back no text at all', cancel.gotText !== true);

    // ---- network ---------------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    console.log(`  same-origin OCR assets fetched: ${[...new Set(ocrAssets)].join(', ') || 'none'}`);
    check('no external request during text extraction', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);
    check('every OCR asset came from our own origin',
        [...new Set(ocrAssets)].every((u) => u.startsWith('/ocr/')), [...new Set(ocrAssets)].join(' '));
    check('no Japanese font was embedded for a text export',
        !ocrAssets.some((u) => u.includes('/ocr/fonts/')), ocrAssets.filter((u) => u.includes('fonts')).join(' '));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    fs.mkdirSync(path.join(ROOT, 'test-fixtures'), { recursive: true });
    fs.writeFileSync(
        path.join(ROOT, 'test-fixtures', 'smoke-text-extraction-results.json'),
        JSON.stringify({
            ranAt: new Date().toISOString(), checks,
            external: [...new Set(external)], ocrAssets: [...new Set(ocrAssets)], pageErrors,
        }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
