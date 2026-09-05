/**
 * Gate for the 使い方 (usage guide) page against the PRODUCTION build.
 *
 * The guide is documentation, so the thing that can silently rot is its
 * accuracy: a tool that shipped but was never written up, or a feature that was
 * described before it existed. This checks the page says what the app actually
 * does today, and that the screenshots it points at really load.
 *
 * Run:  npm run build && node scripts/smoke-usage-guide.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5182;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);

const pageErrors = [];
const failedRequests = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

let exitCode = 1;
try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    // 使い方 is the default view, but click it so the check does not depend on that.
    await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '使い方');
        if (b) b.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('建築設計お役立ちPDFツール集へようこそ'));
    check('使い方 page opens', true);

    const text = await page.evaluate(() => document.body.innerText);

    // ---- the five tool sections ------------------------------------------
    for (const section of ['1. PDF加筆', '2. PDF比較', '3. PDF加工', '4. PDF抽出・統合', '5. PDFテキスト化']) {
        check(`section present: ${section}`, text.includes(section));
    }

    // ---- version badges come from the shared config -----------------------
    const versions = await page.evaluate(() => {
        const heads = [...document.querySelectorAll('h3')];
        const out = {};
        for (const h of heads) {
            const label = (h.textContent || '').trim();
            const badge = /v(\d+\.\d+\.\d+)/.exec(label);
            if (badge) out[label.replace(/\s*v\d+\.\d+\.\d+\s*$/, '')] = badge[1];
        }
        return out;
    });
    console.log(`  versions : ${JSON.stringify(versions)}`);
    check('PDF加工 shows v1.3.0', versions['3. PDF加工 (Processor)'] === '1.3.0', JSON.stringify(versions));
    check('PDFテキスト化 shows v1.3.1', versions['5. PDFテキスト化 (Textifier)'] === '1.3.1', JSON.stringify(versions));

    // ---- S1: the page-size normalizer is documented ------------------------
    check('図面サイズ統一 is documented', text.includes('図面サイズ統一'));
    check('図面サイズ統一 lists the target sheets', /A0 \/ A1 \/ A2 \/ A3 \/ A4/.test(text)
        && text.includes('最初のページに合わせる'));
    check('図面サイズ統一 describes the placement rules',
        text.includes('縦横比') && text.includes('中央に配置') && text.includes('切り取り'));
    check('図面サイズ統一 states what is preserved',
        text.includes('ベクター') && text.includes('検索できる文字情報'));
    check('PDF加工 lists all seven functions',
        ['半透明レイヤ追加', 'モノクロ化', '両方実行', '余白生成', '図面サイズ統一', '図枠一括更新', '最適化']
            .every((f) => text.includes(f)));

    // ---- S2: the title-block updater is documented ------------------------
    check('図枠一括更新 is documented', text.includes('図枠一括更新'));
    check('図枠一括更新 explains the workflow',
        text.includes('ドラッグ') && text.includes('最大3か所') && text.includes('全ページ'),
        'drag / max three / all pages');
    check('図枠一括更新 tells the user to preview first',
        text.includes('プレビューで位置と文字を確認'));
    check('図枠一括更新 says the replacement is visual only',
        text.includes('表示を上書き') && text.includes('元の文字はPDFの内部に残る'));
    check('図枠一括更新 warns it is not redaction',
        text.includes('墨消し') && text.includes('機密情報を消す目的では使用しないでください'));

    // ---- M2-1: the TXT export is documented as available --------------------
    check('Text Extraction is described as a mode the user can pick',
        text.includes('Text Extraction') && text.includes('Text (.txt)'));
    check('the TXT export explains where the text comes from',
        text.includes('文字情報を持つページはその文字をそのまま取り出し')
        && text.includes('スキャンページはOCR'));
    check('the TXT export states page order is kept',
        text.includes('ページ順は維持') || text.includes('ページ順を維持'));
    check('the guide shows the page separator the file actually contains',
        text.includes('===== Page 1 ====='));
    check('the guide names both output file endings',
        text.includes('_searchable.pdf') && text.includes('_extracted.txt'));
    check('the guide warns that switching mode discards the previous result',
        text.includes('モードを切り替えると、前のモードの結果は破棄されます'));
    check('the TXT limitations are stated without overclaiming',
        text.includes('段組みや表が複雑なページ') && text.includes('Excelの表として復元する機能ではありません')
        && text.includes('元の画像の品質'));

    // ---- M1: unsupported features must read as unsupported -----------------
    const unsupported = await page.evaluate(() => {
        const items = [...document.querySelectorAll('li')].map((li) => li.textContent || '');
        const find = (needle) => items.find((t) => t.includes(needle)) ?? '';
        return {
            word: find('Word (.docx)'),
            excel: find('Excel (.xlsx)'),
            noise: find('ノイズ除去 (Remove Noise)'),
        };
    });
    console.log(`  unsupported: ${JSON.stringify(unsupported)}`);
    for (const [key, value] of Object.entries(unsupported)) {
        check(`${key} is marked as not yet available`, value.includes('未対応'), value);
    }
    check('Text Extraction is no longer listed as unavailable',
        !/Text Extraction[^\n]*未対応/.test(text));
    check('the guide no longer claims Word/Excel conversion is available',
        !text.includes('Word/Excel形式に変換'));
    check('OCR capabilities are described',
        text.includes('日本語') && text.includes('検索') && text.includes('ブラウザ内'));

    // ---- release history ----------------------------------------------------
    check('更新履歴 section exists', text.includes('更新履歴'));
    const historyText = await page.evaluate(() =>
        document.querySelector('#release-history')?.innerText ?? '');
    check('release history: the v1.3.1 preview fix leads',
        /^[\s\S]{0,140}プレビュー/.test(historyText)
        && historyText.indexOf('1.3.1') >= 0
        && historyText.indexOf('1.3.1') < historyText.indexOf('1.3.0'),
        historyText.slice(0, 90).replace(/\n/g, ' | '));
    check('release history: the 2026/09/05 PDFテキスト化 v1.3.0 entry survives below it',
        historyText.includes('2026/09/05') && historyText.includes('TXT')
        && historyText.includes('ページ順を維持'));
    check('release history: 2026/09/04 PDF加工 v1.3.0 entry',
        historyText.includes('2026/09/04') && historyText.includes('図枠一括更新')
        && historyText.includes('1.3.0'), historyText.slice(0, 60).replace(/\n/g, ' | '));
    check('release history: the earlier 2026/09/04 v1.2.0 entry survives alongside it',
        historyText.includes('図面サイズ統一') && historyText.includes('1.2.0'));
    check('release history: both same-day PDF加工 entries render',
        (historyText.match(/2026\/09\/04/g) ?? []).length === 2,
        `${(historyText.match(/2026\/09\/04/g) ?? []).length} entries dated 2026/09/04`);
    check('release history: 2026/09/03 PDFテキスト化 entry',
        historyText.includes('2026/09/03') && historyText.includes('PDFテキスト化')
        && historyText.includes('OCR'));
    check('release history stays out of implementation detail',
        !/CropBox|MediaBox|CTM|RF\d|#\d+|[0-9a-f]{7,}/.test(historyText));

    // ---- screenshots really load -------------------------------------------
    const images = await page.evaluate(() => [...document.querySelectorAll('img')].map((img) => ({
        src: img.getAttribute('src'),
        loaded: img.complete && img.naturalWidth > 0,
        w: img.naturalWidth,
        h: img.naturalHeight,
    })));
    for (const img of images) console.log(`  image    : ${img.src} ${img.w}x${img.h} loaded=${img.loaded}`);
    check('every screenshot loads (no 404)', images.length >= 5 && images.every((i) => i.loaded),
        `${images.filter((i) => i.loaded).length}/${images.length}`);

    // ---- layout ---------------------------------------------------------------
    // Measured on the guide itself. The app's top <nav> already overflows below
    // roughly 470px on every page; that is app chrome, not this page, and is
    // asserted separately so a real regression here still fails the gate.
    const measure = async (width) => {
        await page.setViewport({ width, height: 900 });
        await new Promise((r) => setTimeout(r, 300));
        return page.evaluate((w) => {
            const heading = [...document.querySelectorAll('h2')]
                .find((h) => (h.textContent || '').includes('へようこそ'));
            const guide = heading?.parentElement?.parentElement ?? null;
            const wide = [];
            for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.right > w + 1 || r.width > w + 1) {
                    wide.push({ tag: el.tagName, inNav: Boolean(el.closest('nav')) || el.tagName === 'NAV' });
                }
            }
            return {
                guideScrollW: guide?.scrollWidth ?? -1,
                guideClientW: guide?.clientWidth ?? -1,
                wideOutsideNav: wide.filter((e) => !e.inNav).map((e) => e.tag),
            };
        }, width);
    };
    const desktop = await measure(1280);
    const mobile = await measure(390);
    console.log(`  layout   : 1280 -> ${JSON.stringify(desktop)}`);
    console.log(`  layout   : 390  -> ${JSON.stringify(mobile)}`);
    check('guide does not overflow at desktop width',
        desktop.guideScrollW > 0 && desktop.guideScrollW <= desktop.guideClientW + 1, JSON.stringify(desktop));
    check('guide does not overflow at mobile width',
        mobile.guideScrollW > 0 && mobile.guideScrollW <= mobile.guideClientW + 1, JSON.stringify(mobile));
    check('nothing outside the app nav overflows at mobile width',
        mobile.wideOutsideNav.length === 0, mobile.wideOutsideNav.join(','));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

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
