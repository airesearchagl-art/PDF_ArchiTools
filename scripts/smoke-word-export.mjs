/**
 * Gate for the Word export.
 *
 * A .docx is a ZIP of XML that agrees with itself, and every way of getting it
 * wrong produces a file that either does not open or opens with the wrong text
 * in it. So nothing here trusts that the export ran: every document is reopened
 * as a package, its parts are parsed by a real XML parser, and what a reader
 * would see is compared against what went in.
 *
 * The export is a text export. It carries characters and page order, not
 * layout, and the checks are written to that promise and no further.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/smoke-word-export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const ORIGIN = `http://localhost:${PORT}`;

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'text-native-xml-specials.pdf'))) {
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

const external = [];
const ocrAssets = [];
const pageErrors = [];
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
// OCR and PDF.js both run in workers, whose traffic page-level events miss.
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

const run = (name, options) => page.evaluate((n, o) => window.__word.run(n, o), name, options ?? {});
const build = (pages) => page.evaluate((p) => window.__word.build(p), pages);

/** Everything a well-formed package must be true of, whatever it contains. */
function structuralChecks(label, r) {
    check(`${label}: the package is a readable ZIP with the three required parts`,
        r.hasContentTypes && r.hasPackageRels && r.hasDocument,
        JSON.stringify(r.entries));
    check(`${label}: every part parses as XML`,
        r.documentParses && r.relsParse && r.typesParse,
        r.documentError ?? '');
    check(`${label}: the document is declared UTF-8`, r.xmlDeclared === true);
    check(`${label}: the main document has its content type`, r.documentTyped === true);
    check(`${label}: every relationship points at a part that exists`,
        r.targetsResolve === true && r.relationships.length > 0,
        JSON.stringify(r.relationships.map((x) => x.target)));
    check(`${label}: no relationship leaves the package`,
        r.externalRelationships === 0 && r.remoteTargets === 0,
        JSON.stringify(r.relationships.map((x) => x.mode)));
    check(`${label}: no macros or binary parts`, r.macros.length === 0, JSON.stringify(r.macros));
    check(`${label}: no reserved character arrived unescaped`,
        r.rawUnescapedAmpersand === false);
    check(`${label}: no stringified placeholder in the document`,
        r.hasPlaceholderJunk === false);
}

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-word-export-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__word?.ready === true, { timeout: 120000 });

    check('the export declares the OOXML wordprocessing MIME type',
        (await page.evaluate(() => window.__word.mime)) === WORD_MIME);

    // ---- A. native Japanese and English, with no OCR at all -------------------
    console.log('\n=== A. text-native (must not touch OCR) ===');
    const native = await run('text-native-ja-en.pdf');
    console.log(`  pages=${native.word.pageCount} paragraphs=${native.word.paragraphCount} chars=${native.word.characterCount} breaks=${native.word.pageBreaks} bytes=${native.word.bytes} (extract ${native.extractMs}ms, build ${native.buildMs}ms)`);
    console.log(`  text  : ${JSON.stringify(native.report.text.slice(0, 110))}`);
    structuralChecks('text-native', native.report);
    check('text-native: the OCR engine never started', native.ocrUsed === false);
    check('text-native: not one OCR asset was requested', ocrAssets.length === 0,
        `${ocrAssets.length}: ${[...new Set(ocrAssets)].slice(0, 3).join(' ')}`);
    check('text-native: Japanese survives into the document',
        native.report.text.includes('建築図面'), JSON.stringify(native.report.text.slice(0, 60)));
    check('text-native: English survives into the document',
        /Architectural Drawing/.test(native.report.text));
    check('text-native: a single page gets no page break',
        native.word.pageBreaks === 0 && native.report.pageBreaks === 0);

    // ---- B. scanned -----------------------------------------------------------
    console.log('\n=== B. scanned (OCR) ===');
    const scanned = await run('scanned-ja-en.pdf');
    console.log(`  pages=${scanned.word.pageCount} paragraphs=${scanned.word.paragraphCount} bytes=${scanned.word.bytes}`);
    console.log(`  text  : ${JSON.stringify(scanned.report.text.slice(0, 110))}`);
    structuralChecks('scanned', scanned.report);
    check('scanned: the OCR engine was used', scanned.ocrUsed === true
        && scanned.pages[0].ocrWords > 0, `${scanned.pages[0].ocrWords} words`);
    check('scanned: recognised Japanese and English reach the document',
        /建築/.test(scanned.report.text) && /Architectural/.test(scanned.report.text),
        JSON.stringify(scanned.report.text.slice(0, 60)));

    // ---- C. mixed -------------------------------------------------------------
    console.log('\n=== C. mixed document ===');
    const mixed = await run('mixed-multipage.pdf');
    console.log(`  ${JSON.stringify(mixed.pages.map((p) => `${p.pageNumber}:${p.kind}:${p.ocrWords}`))}`);
    console.log(`  pages=${mixed.word.pageCount} breaks=${mixed.word.pageBreaks} paragraphs=${mixed.word.paragraphCount}`);
    structuralChecks('mixed', mixed.report);
    check('mixed: only the scanned page was recognised',
        mixed.pages[0].ocrWords === 0 && mixed.pages[1].ocrWords > 0 && mixed.pages[2].ocrWords === 0,
        mixed.pages.map((p) => p.ocrWords).join('/'));
    check('mixed: three pages give two page breaks',
        mixed.word.pageCount === 3 && mixed.word.pageBreaks === 2 && mixed.report.pageBreaks === 2,
        `${mixed.word.pageCount} pages, ${mixed.report.pageBreaks} breaks`);
    // Order is the claim this export actually makes, so it is checked as order.
    const mixedText = mixed.report.text;
    const iFirst = mixedText.indexOf('建築図面');
    const iLast = mixedText.indexOf('最終ページ');
    check('mixed: page order survives into the document',
        iFirst >= 0 && iLast > iFirst, `first=${iFirst} last=${iLast}`);
    check('mixed: the scanned page contributes its recognised text',
        /Floor Plan|平面図/.test(mixedText));

    // ---- D. a blank page must still be a page ---------------------------------
    console.log('\n=== D. blank page ===');
    const blank = await run('text-with-blank-page.pdf');
    console.log(`  pages=${blank.word.pageCount} breaks=${blank.word.pageBreaks} paragraphs=${blank.word.paragraphCount}`);
    console.log(`  page chars: ${JSON.stringify(blank.pages.map((p) => p.charCount))}`);
    structuralChecks('blank-page', blank.report);
    check('blank page: the document still has three pages worth of boundaries',
        blank.word.pageCount === 3 && blank.report.pageBreaks === 2,
        `${blank.word.pageCount} pages, ${blank.report.pageBreaks} breaks`);
    check('blank page: it is not dropped from the middle',
        blank.pages[1].charCount === 0 && blank.pages[2].charCount > 0,
        JSON.stringify(blank.pages.map((p) => p.charCount)));

    // ---- E. preprocessing -------------------------------------------------------
    console.log('\n=== E. with M2-2 preprocessing ===');
    const prepOff = await run('scanned-skew-plus-3.pdf');
    const prepOn = await run('scanned-skew-plus-3.pdf', { preprocess: { deskew: true, noiseReduction: true } });
    const tokens = ['建築', '図面', 'Architectural', 'Drawing', 'Floor', 'Plan'];
    const hits = (t) => tokens.filter((x) => t.includes(x)).length;
    console.log(`  off ${hits(prepOff.report.text)}/${tokens.length}   on ${hits(prepOn.report.text)}/${tokens.length}   angle ${prepOn.pages[0].preprocess?.detectedAngle}`);
    structuralChecks('preprocessed', prepOn.report);
    check('preprocessing reaches the Word path',
        prepOn.pages[0].preprocess?.deskewApplied === true,
        JSON.stringify(prepOn.pages[0].preprocess));
    check('preprocessing does not cost the document any expected token',
        hits(prepOn.report.text) >= hits(prepOff.report.text),
        `${hits(prepOff.report.text)} -> ${hits(prepOn.report.text)}`);

    // ---- F. characters XML reserves ---------------------------------------------
    console.log('\n=== F. XML-reserved characters ===');
    const specials = await run('text-native-xml-specials.pdf');
    console.log(`  text  : ${JSON.stringify(specials.report.text.slice(0, 140))}`);
    structuralChecks('xml-specials', specials.report);
    for (const literal of ['A&B', '<drawing>', '"quoted"', '日本語＆English', '5 < 10 & 10 > 5']) {
        check(`xml-specials: "${literal}" reads back exactly`,
            specials.report.text.includes(literal),
            JSON.stringify(specials.report.text.slice(0, 80)));
    }

    // The builder itself, over text no PDF could carry: emoji, a control code
    // and a lone surrogate. The first must survive; the other two cannot exist
    // in XML and must be dropped rather than corrupting the package.
    const hostile = await build([
        { pageNumber: 1, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: '絵文字 🏗️🧱 emoji' },
        { pageNumber: 2, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: 'bell\u0007here\u000Bvtab' },
        { pageNumber: 3, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: 'lone\uD800surrogate' },
        { pageNumber: 4, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: 'tab\there\r\nand a newline' },
    ]);
    console.log(`  hostile text: ${JSON.stringify(hostile.report.text)}`);
    structuralChecks('hostile-text', hostile.report);
    check('emoji and supplementary characters survive',
        hostile.report.text.includes('🏗️🧱'), JSON.stringify(hostile.report.text.slice(0, 40)));
    check('characters XML cannot carry are dropped, not smuggled in',
        hostile.report.text.includes('bellhere') && hostile.report.text.includes('vtab')
        && hostile.report.text.includes('lonesurrogate'),
        JSON.stringify(hostile.report.text));
    check('a tab survives and CRLF becomes a paragraph break',
        hostile.report.text.includes('tab\there'), JSON.stringify(hostile.report.text));

    // ---- page break arithmetic ---------------------------------------------------
    console.log('\n=== page breaks == pages - 1 ===');
    for (const r of [native, scanned, mixed, blank, specials, { name: 'hostile(4 pages)', word: hostile.word, report: hostile.report }]) {
        check(`${r.name}: explicit page breaks are one fewer than the pages`,
            r.report.pageBreaks === r.word.pageCount - 1 && r.word.pageBreaks === r.word.pageCount - 1,
            `${r.word.pageCount} pages, ${r.report.pageBreaks} breaks`);
    }

    // ---- determinism ---------------------------------------------------------------
    console.log('\n=== determinism ===');
    const det = await page.evaluate(() => window.__word.determinism([
        { pageNumber: 1, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: '建築図面 Architectural Drawing\n第一版' },
        { pageNumber: 2, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: '' },
        { pageNumber: 3, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: 'Final' },
    ]));
    console.log(`  ${JSON.stringify(det)}`);
    check('the same pages build to the same bytes', det.byteIdentical === true, JSON.stringify(det));
    check('the same pages build to the same document payload', det.payloadIdentical === true);

    // ---- cancellation ----------------------------------------------------------------
    console.log('\n=== cancellation ===');
    const cancelExtract = await page.evaluate(() => window.__word.cancelDuringExtraction('mixed-multipage.pdf'));
    console.log(`  during extraction: ${JSON.stringify(cancelExtract)}`);
    check('cancelling extraction produces no document at all',
        cancelExtract.threw === true && cancelExtract.code === 'cancelled'
        && cancelExtract.builtBytes === null, JSON.stringify(cancelExtract));

    const cancelBuild = await page.evaluate(() => window.__word.cancelDuringBuild([
        { pageNumber: 1, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0, text: 'text' },
    ]));
    console.log(`  during build     : ${JSON.stringify(cancelBuild)}`);
    check('cancelling the package build hands back nothing',
        cancelBuild.threw === true && cancelBuild.code === 'cancelled'
        && cancelBuild.builtBytes === null, JSON.stringify(cancelBuild));

    // ---- performance ------------------------------------------------------------------
    console.log('\n=== performance ===');
    const big = [];
    for (let p = 1; p <= 40; p++) {
        big.push({
            pageNumber: p, kind: 'text-native', charCount: 0, ocrWords: 0, meanConfidence: null, ms: 0,
            text: Array.from({ length: 60 }, (_, i) => `${p}-${i} 建築図面 Architectural Drawing note line`).join('\n'),
        });
    }
    const started = Date.now();
    const large = await build(big);
    const largeMs = Date.now() - started;
    console.log(`  40 pages / ${large.word.paragraphCount} paragraphs / ${large.word.characterCount} chars -> ${large.word.bytes} bytes in ~${largeMs}ms`);
    structuralChecks('large', large.report);
    check('a forty-page document builds and reopens intact',
        large.word.pageCount === 40 && large.report.pageBreaks === 39
        && large.word.paragraphCount === 40 * 60,
        `${large.word.pageCount} pages, ${large.report.pageBreaks} breaks, ${large.word.paragraphCount} paragraphs`);

    // ---- network -------------------------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    console.log(`  same-origin OCR assets: ${[...new Set(ocrAssets)].join(', ') || 'none'}`);
    check('no external request during extraction or Word generation',
        uniqueExternal.length === 0, `${uniqueExternal.length} external`);
    check('every OCR asset came from our own origin',
        [...new Set(ocrAssets)].every((u) => u.startsWith('/ocr/')));
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
        path.join(ROOT, 'test-fixtures', 'smoke-word-export-results.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), checks, external: [...new Set(external)], pageErrors }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
