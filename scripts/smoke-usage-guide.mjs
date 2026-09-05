/**
 * Gate for the 使い方 (usage guide) page against the PRODUCTION build.
 *
 * Two things can rot here. The navigation: the guide is a set of collapsible
 * tools now, and "all five visible at a glance, one open at a time, reachable
 * by keyboard and by link" is behaviour, not decoration. And the content: a
 * tool that shipped but was never written up, or a claim that outlived the code
 * it described. Both are checked, and the content is checked inside the panel
 * it belongs to rather than against one blob of page text.
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

const TOOLS = ['annotator', 'comparator', 'processor', 'split-merge', 'textifier'];

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

const openGuide = async () => {
    await page.evaluate(() => {
        const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent || '').trim() === '使い方');
        if (b) b.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.usage-header').length === 5);
};

const headerState = () => page.evaluate(() => [...document.querySelectorAll('.usage-header')].map((h) => ({
    tool: h.dataset.usageTool,
    expanded: h.getAttribute('aria-expanded'),
    controls: h.getAttribute('aria-controls'),
    controlsExists: Boolean(document.getElementById(h.getAttribute('aria-controls'))),
    text: (h.textContent || '').replace(/\s+/g, ' ').trim(),
    bottom: Math.round(h.getBoundingClientRect().bottom),
})));

const clickTool = async (tool) => {
    await page.evaluate((t) => document.querySelector(`[data-usage-tool="${t}"]`).click(), tool);
    await new Promise((r) => setTimeout(r, 120));
};

/** Text of an open panel, or '' when it is closed. */
const panelText = (tool) => page.evaluate((t) => {
    const panel = document.getElementById(`usage-panel-${t}`);
    return panel && !panel.hidden ? (panel.innerText || '') : '';
}, tool);

let exitCode = 1;
try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await openGuide();
    check('使い方 page opens', true);

    // ---- the five tools, at a glance ---------------------------------------
    console.log('\n=== accordion ===');
    const initial = await headerState();
    console.log(`  headers  : ${JSON.stringify(initial.map((h) => h.tool))}`);
    console.log(`  last bottom ${initial[initial.length - 1].bottom}px of 900px viewport`);
    check('there are five tool headers', initial.length === 5, String(initial.length));
    check('they are in the order the top navigation uses',
        initial.map((h) => h.tool).join(',') === TOOLS.join(','), initial.map((h) => h.tool).join(','));
    for (const [i, label] of ['1. PDF加筆', '2. PDF比較', '3. PDF加工', '4. PDF抽出・統合', '5. PDFテキスト化'].entries()) {
        check(`header ${i + 1} reads ${label}`, initial[i].text.includes(label), initial[i].text.slice(0, 40));
    }
    check('every header carries a one-line summary',
        initial.every((h) => /追加|確認|加工|結合|変換/.test(h.text)),
        JSON.stringify(initial.map((h) => h.text.slice(-24))));
    check('nothing is open to begin with',
        initial.every((h) => h.expanded === 'false'), JSON.stringify(initial.map((h) => h.expanded)));
    check('all five headers are visible without scrolling at 1280x900',
        initial.every((h) => h.bottom <= 900),
        `last bottom ${initial[initial.length - 1].bottom}`);
    check('a closed guide does not scroll the page',
        (await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)) === true);

    // A distinctive line from deep inside the processor panel: it must not be
    // reachable while every section is closed.
    const closedText = await page.evaluate(() => document.body.innerText);
    check('closed sections do not expose their detail',
        !closedText.includes('墨消し') && !closedText.includes('===== Page 1 ====='),
        'processor and textifier detail absent');

    // ---- one at a time ------------------------------------------------------
    await clickTool('processor');
    let state = await headerState();
    check('clicking a header opens that tool',
        state.find((h) => h.tool === 'processor').expanded === 'true',
        JSON.stringify(state.map((h) => h.expanded)));
    check('opening one closes the others',
        state.filter((h) => h.expanded === 'true').length === 1,
        JSON.stringify(state.map((h) => h.expanded)));

    await clickTool('comparator');
    state = await headerState();
    check('opening another closes the first',
        state.find((h) => h.tool === 'processor').expanded === 'false'
        && state.find((h) => h.tool === 'comparator').expanded === 'true',
        JSON.stringify(state.map((h) => `${h.tool}:${h.expanded}`)));

    await clickTool('comparator');
    state = await headerState();
    check('clicking the open header closes it',
        state.every((h) => h.expanded === 'false'), JSON.stringify(state.map((h) => h.expanded)));

    // ---- accessibility -------------------------------------------------------
    console.log('\n=== accessibility ===');
    check('each header is a real button',
        (await page.evaluate(() => [...document.querySelectorAll('.usage-header')]
            .every((h) => h.tagName === 'BUTTON'))) === true);
    check('aria-controls points at a panel that exists',
        state.every((h) => h.controls === `usage-panel-${h.tool}` && h.controlsExists),
        JSON.stringify(state.map((h) => h.controls)));

    // Keyboard, through the real focus path rather than a synthetic click.
    await page.evaluate(() => document.querySelector('[data-usage-tool="annotator"]').focus());
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 120));
    check('Enter opens the focused header',
        (await page.evaluate(() => document.querySelector('[data-usage-tool="annotator"]').getAttribute('aria-expanded'))) === 'true');
    await page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, 120));
    check('Space closes it again',
        (await page.evaluate(() => document.querySelector('[data-usage-tool="annotator"]').getAttribute('aria-expanded'))) === 'false');
    check('the focused header shows a focus ring',
        (await page.evaluate(() => {
            const el = document.querySelector('[data-usage-tool="annotator"]');
            el.focus();
            const s = getComputedStyle(el, ':focus-visible');
            return s.outlineStyle !== 'none' || s.outlineWidth !== '0px';
        })) === true);
    check('the chevron shows state as a shape, not only a colour',
        (await page.evaluate(() => Boolean(document.querySelector('.usage-header-chevron')))) === true);

    // ---- deep links -----------------------------------------------------------
    console.log('\n=== deep links ===');
    for (const tool of ['processor', 'textifier', 'annotator']) {
        await page.goto(`${ORIGIN}#${tool}`, { waitUntil: 'networkidle0' });
        await openGuide();
        const opened = await page.evaluate((t) =>
            document.querySelector(`[data-usage-tool="${t}"]`)?.getAttribute('aria-expanded'), tool);
        check(`#${tool} opens that tool`, opened === 'true', String(opened));
    }

    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await openGuide();
    await page.evaluate(() => document.querySelector('a[href="#release-history"]').click());
    await new Promise((r) => setTimeout(r, 400));
    const history = await page.evaluate(() => {
        const el = document.getElementById('release-history');
        return { exists: Boolean(el), hash: window.location.hash, top: el ? Math.round(el.getBoundingClientRect().top) : null };
    });
    console.log(`  release-history: ${JSON.stringify(history)}`);
    check('the 更新履歴 link still reaches the history',
        history.exists && history.hash === '#release-history', JSON.stringify(history));

    // ---- version badges come from the shared config ---------------------------
    console.log('\n=== versions ===');
    const versions = await page.evaluate(() => {
        const out = {};
        for (const h of document.querySelectorAll('.usage-header')) {
            const m = /v(\d+\.\d+\.\d+)/.exec(h.textContent || '');
            if (m) out[h.dataset.usageTool] = m[1];
        }
        return out;
    });
    console.log(`  ${JSON.stringify(versions)}`);
    check('PDF加工 shows v1.3.0', versions.processor === '1.3.0', JSON.stringify(versions));
    check('PDFテキスト化 shows v1.5.0', versions.textifier === '1.5.0', JSON.stringify(versions));
    check('every tool header shows a version', TOOLS.every((t) => versions[t]), JSON.stringify(versions));

    // ---- content, read from the panel it belongs to ---------------------------
    console.log('\n=== content ===');
    const text = {};
    for (const tool of TOOLS) {
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await openGuide();
        await clickTool(tool);
        await new Promise((r) => setTimeout(r, 200));
        text[tool] = await panelText(tool);
        check(`${tool}: its panel has content when open`, text[tool].length > 200, `${text[tool].length} chars`);
    }

    // PDF加筆 -- described by what the toolbar actually has.
    const a = text.annotator;
    check('annotator: the four erasers and two range selections are described',
        a.includes('ピクセル') && a.includes('線ごと') && a.includes('矩形') && a.includes('投げ縄'),
        'eraser modes');
    check('annotator: measurement and calibration are described',
        a.includes('距離') && a.includes('折れ線') && a.includes('面積') && a.includes('縮尺校正')
        && a.includes('プリセット'), 'measure + calibrate');
    check('annotator: no generic shape-drawing tool is claimed',
        !/図形ツール/.test(a) && a.includes('図形を描くツールはありません'),
        'shape tooling');
    check('annotator: saving is described as page images, not preserved vectors',
        a.includes('画像として書き出したもの') && !a.includes('ベクターを完全保持'),
        'save format');
    check('annotator: layers are described only as far as they go',
        a.includes('追加・表示切替・削除'), 'layer scope');

    // PDF比較 -- the DPI list was wrong for a long time.
    const c = text.comparator;
    check('comparator: four PDFs and their colours',
        c.includes('最大4つ') && c.includes('Blue (Base)') && c.includes('Red')
        && c.includes('Green') && c.includes('Yellow'), 'slots');
    check('comparator: the real export DPI list',
        c.includes('72') && c.includes('150') && c.includes('300') && c.includes('450'), 'dpi list');
    check('comparator: the old 1200 DPI claim is gone', !c.includes('1200'), 'no 1200');
    check('comparator: match colour and opacity',
        c.includes('一致している部分の色') && c.includes('透明度'), 'match controls');
    check('comparator: the change report', c.includes('変更箇所抽出レポート'));
    check('comparator: the diff threshold', c.includes('Diff Threshold') && c.includes('0〜5px'));
    check('comparator: export scope options',
        c.includes('すべて') && c.includes('現在のページ') && c.includes('範囲指定'), 'scope');
    check('comparator: per-file visibility', c.includes('表示・非表示'));

    // PDF加工 -- unchanged in substance, and the warning must survive.
    const p = text.processor;
    check('processor: all seven functions',
        ['半透明レイヤ追加', 'モノクロ化', '両方実行', '余白生成', '図面サイズ統一', '図枠一括更新', '最適化']
            .every((f) => p.includes(f)), 'seven');
    check('processor: 両方実行 states the order', p.includes('モノクロ化のあとに半透明レイヤ'));
    check('processor: single file vs ZIP', p.includes('複数ならZIP'));
    check('processor: 図面サイズ統一 target sheets and preservation',
        p.includes('A0 / A1 / A2 / A3 / A4') && p.includes('最初のページに合わせる')
        && p.includes('ベクター') && p.includes('検索できる文字情報'), 'S1');
    check('processor: 図面サイズ統一 fail-close is stated',
        p.includes('安全のため処理を中止'), 'S1 fail-close');
    check('processor: 図枠一括更新 workflow',
        p.includes('ドラッグ') && p.includes('最大3か所') && p.includes('全ページ')
        && p.includes('プレビューで位置と文字を確認'), 'S2');
    check('processor: the redaction warning is intact',
        p.includes('墨消し') && p.includes('元の文字はPDFの内部に残る')
        && p.includes('機密情報を消す目的では使用しないでください'), 'S2 warning');

    // PDF抽出・統合 -- the tabs are exclusive, and there are two screenshots.
    const s = text['split-merge'];
    check('split-merge: the tabs are described as a switch',
        s.includes('タブで切り替え'), 'tab switching');
    check('split-merge: it says the two are never shown together',
        s.includes('同時に表示されることはありません'), 'not simultaneous');
    check('split-merge: it does not describe a side-by-side layout',
        !/左側[\s\S]{0,40}右側/.test(s) && !s.includes('左右'), 'no side-by-side');
    // Re-open it: the content loop above left the last tool showing.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await openGuide();
    await clickTool('split-merge');
    const shots = await page.evaluate(() => [...document.querySelectorAll('#usage-panel-split-merge [data-usage-screenshot]')]
        .map((el) => el.dataset.usageScreenshot));
    console.log(`  split-merge screenshots: ${JSON.stringify(shots)}`);
    check('split-merge: both the Extract and the Merge screenshot are shown',
        shots.includes('split_extract') && shots.includes('split_merge'), JSON.stringify(shots));
    check('split-merge: extract selection and export order',
        s.includes('クリックすると選択') && s.includes('元のページ順に並びます'), 'extract');
    check('split-merge: merge ordering and removal',
        s.includes('順番を入れ替え') && s.includes('リストの順番どおり'), 'merge');

    // PDFテキスト化 -- three outputs, and the limits of the newest one.
    const t = text.textifier;
    check('textifier: all three outputs',
        t.includes('PDF (Searchable)') && t.includes('Text (.txt)') && t.includes('Word (.docx)'), 'outputs');
    check('textifier: OCR preprocessing and its default',
        t.includes('OCR前処理') && t.includes('傾き補正') && t.includes('ノイズ除去')
        && t.includes('初期状態はオフ'), 'preprocessing');
    check('textifier: preprocessing touches only the OCR image',
        t.includes('文字認識用の画像だけ') && t.includes('元のPDFの見た目'), 'scope');
    check('textifier: the page-too-large notice is documented',
        t.includes('前処理を行わずに文字認識'), 'page-too-large');
    check('textifier: Excel is still marked unsupported',
        /Excel \(\.xlsx\)[^\n]*未対応/.test(t), 'excel');
    check('textifier: the Word limits are stated',
        t.includes('PDFの見た目をWordへ再現する機能ではありません')
        && t.includes('表の構造は復元しません')
        && t.includes('画像・図形・線はWordへ移しません')
        && t.includes('フォント・文字サイズ・太字などの体裁は再現しません'), 'word limits');
    check('textifier: the TXT page separator', t.includes('===== Page 1 ====='));
    check('textifier: nothing claims Word keeps the layout',
        !t.includes('レイアウトを保持') && !t.includes('レイアウトを再現します'), 'no layout claim');

    // ---- privacy copy stays within what the code proves ----------------------
    console.log('\n=== privacy copy ===');
    const intro = await page.evaluate(() => document.body.innerText);
    check('the privacy note is the measured one',
        intro.includes('ブラウザ内で処理されます')
        && intro.includes('外部のAI・OCRサービスへ送信することはありません'), 'privacy');
    check('it does not claim zero network access anywhere in the app',
        !intro.includes('外部通信が完全に0') && !intro.includes('ネットワークアクセスが一切'), 'no overclaim');

    // ---- release history -----------------------------------------------------
    console.log('\n=== release history ===');
    const historyText = await page.evaluate(() => document.querySelector('#release-history')?.innerText ?? '');
    check('更新履歴 section exists', historyText.length > 0);
    check('the v1.5.0 Word entry leads, newest first',
        historyText.indexOf('1.5.0') >= 0
        && historyText.indexOf('1.5.0') < historyText.indexOf('1.4.0')
        && historyText.indexOf('1.4.0') < historyText.indexOf('1.3.1')
        && historyText.indexOf('1.3.1') < historyText.indexOf('1.3.0')
        && historyText.includes('Word'),
        historyText.slice(0, 90).replace(/\n/g, ' | '));
    check('the earlier entries survive below it',
        historyText.includes('傾き') && historyText.includes('プレビュー')
        && historyText.includes('図枠一括更新') && historyText.includes('図面サイズ統一'),
        'older entries');
    check('both same-day PDF加工 entries render',
        (historyText.match(/2026\/09\/04/g) ?? []).length === 2,
        `${(historyText.match(/2026\/09\/04/g) ?? []).length} entries dated 2026/09/04`);
    check('release history stays out of implementation detail',
        !/CropBox|MediaBox|CTM|RF\d|#\d+|[0-9a-f]{7,}/.test(historyText));

    // ---- screenshots really load ---------------------------------------------
    console.log('\n=== screenshots ===');
    const images = [];
    for (const tool of TOOLS) {
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await openGuide();
        await clickTool(tool);
        await page.waitForFunction((t) => {
            const imgs = [...document.querySelectorAll(`#usage-panel-${t} img`)];
            return imgs.length > 0 && imgs.every((i) => i.complete);
        }, { timeout: 30_000 }, tool);
        const shot = await page.evaluate((t) => [...document.querySelectorAll(`#usage-panel-${t} img`)].map((img) => ({
            src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, lazy: img.getAttribute('loading'),
        })), tool);
        images.push(...shot);
        for (const img of shot) console.log(`  ${tool.padEnd(14)} ${img.src} ${img.w}x${img.h} loading=${img.lazy}`);
    }
    check('every screenshot the guide shows actually loads',
        images.length === 6 && images.every((i) => i.w > 0 && i.h > 0),
        `${images.filter((i) => i.w > 0).length}/${images.length}`);
    check('screenshots are lazily loaded', images.every((i) => i.lazy === 'lazy'));

    // ---- layout ----------------------------------------------------------------
    console.log('\n=== layout ===');
    const measureWidth = async (width, openTool) => {
        await page.setViewport({ width, height: 900 });
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await openGuide();
        if (openTool) { await clickTool(openTool); await new Promise((r) => setTimeout(r, 300)); }
        return page.evaluate((w) => {
            const wide = [];
            for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.right > w + 1 || r.width > w + 1) {
                    wide.push({ tag: el.tagName, cls: el.className?.toString?.().slice(0, 24), inNav: Boolean(el.closest('nav')) || el.tagName === 'NAV' });
                }
            }
            const guide = document.querySelector('.usage-accordion')?.parentElement ?? null;
            return {
                guideScrollW: guide?.scrollWidth ?? -1,
                guideClientW: guide?.clientWidth ?? -1,
                wideOutsideNav: wide.filter((e) => !e.inNav).map((e) => `${e.tag}.${e.cls}`),
            };
        }, width);
    };
    // Measured on the guide itself. The app's top <nav> already overflows below
    // roughly 470px on every page; that is app chrome, not this page, and
    // redesigning it is not what this change is for -- so it is excluded here
    // and the guide is held to the stricter bar on its own.
    for (const [width, openTool] of [[1280, null], [1280, 'textifier'], [390, null], [390, 'processor']]) {
        const r = await measureWidth(width, openTool);
        const label = `${width}px${openTool ? ` with ${openTool} open` : ''}`;
        console.log(`  ${label}: guide ${r.guideScrollW}/${r.guideClientW} wide=${JSON.stringify(r.wideOutsideNav.slice(0, 3))}`);
        check(`the guide does not overflow horizontally at ${label}`,
            r.guideScrollW > 0 && r.guideScrollW <= r.guideClientW + 1,
            `${r.guideScrollW} vs ${r.guideClientW}`);
        check(`nothing outside the app nav overflows at ${label}`,
            r.wideOutsideNav.length === 0, JSON.stringify(r.wideOutsideNav.slice(0, 3)));
    }

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
