/**
 * M7-P1 UI gate: the 図面管理 workspace of the built app, driven as a person
 * would, with synthetic PDFs only.
 *
 * The module gate (smoke-m7-p1.mjs) proves the intake, fingerprint and model;
 * this proves the wiring: the sixth navigation entry, the honest empty state,
 * several files taken in one at a time with visible progress, duplicate bytes
 * bound once, a refusal that leaves the accepted files alone, the virtualized
 * Sheet List at 5000 Sheets, the read-only viewer (render, zoom, switching
 * Sheets and Sources, at most one open document), removing a file, starting
 * a new Drawing Set while a file is still being read, and the five existing
 * tools still reachable. Every request is recorded: nothing may leave the
 * machine, and the PDF.js worker must be the local one.
 *
 * Target browsers: by default this runs puppeteer's bundled Chromium (CI). For
 * the M7-P1 target-browser evidence, point it at an installed browser:
 *   node scripts/smoke-m7-p1-ui.mjs --browser="C:\Program Files\Google\Chrome\Application\chrome.exe"
 *   node scripts/smoke-m7-p1-ui.mjs --browser="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 * The exact browser version is printed.
 *
 * Run:
 *   npm run build
 *   node scripts/make-m7-p1-fixtures.mjs
 *   node scripts/smoke-m7-p1-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5215;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm7-p1');
const fixture = (name) => path.join(FIXTURES, `${name}.pdf`);
const browserArg = process.argv.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) || process.env.M7_BROWSER || '';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const note = (name, detail) => console.log(`  ----  ${name}  ${detail}`);
const section = (title) => console.log(`\n=== ${title} ===`);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
        console.error('No build to test. Run: npm run build');
        process.exit(1);
    }
    if (!fs.existsSync(path.join(FIXTURES, 'manifest.json'))) {
        console.error('No fixtures. Run: node scripts/make-m7-p1-fixtures.mjs');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
    const sha = (name) => manifest.files.find((f) => f.name === name).sha256;

    const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...(browserArg ? { executablePath: browserArg } : {}),
    });
    let exitCode = 1;
    try {
        const version = await browser.version();
        console.log(`Browser: ${version}${browserArg ? `  (${browserArg})` : '  (puppeteer bundled)'}`);

        const page = await browser.newPage();
        page.setDefaultTimeout(60_000);
        await page.setViewport({ width: 1400, height: 900 });

        const requests = [];
        const external = [];
        const pageErrors = [];
        const record = (url) => {
            if (!url) return;
            requests.push(url);
            if (url.startsWith(ORIGIN)) return;
            try {
                const { protocol } = new URL(url);
                if (protocol === 'http:' || protocol === 'https:') external.push(url);
            } catch { /* data:, blob: */ }
        };
        page.on('request', (r) => record(r.url()));
        page.on('pageerror', (e) => pageErrors.push(e.message));
        browser.on('targetcreated', async (target) => {
            if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
            try {
                const session = await target.createCDPSession();
                await session.send('Network.enable');
                session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
            } catch { /* gone */ }
        });
        // Reading can be slowed on purpose, so a run is still in flight when
        // the test acts on it. Off unless window.__dsDelayMs is set.
        await page.evaluateOnNewDocument(() => {
            const original = Blob.prototype.arrayBuffer;
            Blob.prototype.arrayBuffer = async function arrayBuffer() {
                const ms = window.__dsDelayMs || 0;
                if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
                return original.call(this);
            };
        });

        const root = () => page.evaluate(() => {
            const el = document.querySelector('[data-ds-root]');
            if (!el) return null;
            const results = [...el.querySelectorAll('[data-ds-result]')].map((r) => ({ state: r.dataset.dsResult, text: r.textContent }));
            return {
                state: el.dataset.dsState,
                sources: Number(el.dataset.dsSources ?? 0),
                sheets: Number(el.dataset.dsSheets ?? 0),
                results,
                empty: Boolean(el.querySelector('[data-ds-empty]')),
                status: el.querySelector('[data-ds-status]')?.textContent ?? '',
            };
        });
        const waitIdle = async (timeout = 120_000) => {
            await page.waitForFunction(() => {
                const el = document.querySelector('[data-ds-root]');
                if (!el || el.dataset.dsState !== 'idle') return false;
                return ![...el.querySelectorAll('[data-ds-result]')].some((r) => r.dataset.dsResult === 'queued' || r.dataset.dsResult === 'processing');
            }, { timeout, polling: 100 });
        };
        const upload = async (...files) => {
            const input = await page.$('[data-ds-file-input]');
            await input.uploadFile(...files);
        };
        const clickNav = (label) => page.evaluate((text) => {
            const button = [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === text);
            button?.click();
            return Boolean(button);
        }, label);
        const viewer = () => page.evaluate(() => {
            const v = document.querySelector('[data-ds-viewer]');
            if (!v) return null;
            const canvas = v.querySelector('canvas');
            return {
                state: v.dataset.dsRenderState,
                renderedSheet: canvas?.dataset.dsRenderedSheet ?? '',
                live: v.dataset.dsPreviewLive,
                opened: v.dataset.dsPreviewOpened,
                destroyRequested: v.dataset.dsPreviewDestroyRequested,
                destroyed: v.dataset.dsPreviewDestroyed,
                started: v.dataset.dsRenderStarted,
                completed: v.dataset.dsRenderCompleted,
                cancelled: v.dataset.dsRenderCancelled,
                failed: v.dataset.dsRenderFailed,
                cssWidth: canvas ? parseFloat(canvas.style.width) : 0,
                zoom: v.querySelector('[data-ds-zoom-value]')?.textContent ?? '',
                label: v.querySelector('.ds-viewer-label')?.textContent ?? '',
            };
        });
        const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-ds-sheet-row]')].map((r) => ({
            id: r.dataset.dsSheetId, index: Number(r.dataset.dsRowIndex), page: Number(r.dataset.dsPage),
            selected: r.getAttribute('aria-selected') === 'true', text: r.textContent,
        })));
        const clickRow = (index) => page.evaluate((i) => {
            const row = document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"]`);
            row?.click();
            return row?.dataset.dsSheetId ?? null;
        }, index);
        const waitRendered = (sheetId) => page.waitForFunction((id) => {
            const v = document.querySelector('[data-ds-viewer]');
            return v && v.dataset.dsRenderState === 'rendered' && v.querySelector('canvas')?.dataset.dsRenderedSheet === id;
        }, { timeout: 60_000, polling: 100 }, sheetId);
        const canvasHasInk = () => page.evaluate(() => {
            const canvas = document.querySelector('[data-ds-viewer] canvas');
            if (!canvas || canvas.width === 0) return false;
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < data.length; i += 4 * 97) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
            return false;
        });
        const fingerprintWorkers = () => page.workers().filter((w) => w.url().includes('drawing-set-fingerprint')).length;
        // PDF.js starts one Worker per open document and terminates it when
        // the document is destroyed: what is really held, apart from the
        // app's own counts. The peak is reset before a window worth watching.
        const isPdfWorker = (w) => /pdf\.worker/.test(w.url());
        const pdfDocuments = () => page.workers().filter(isPdfWorker).length;
        const pdfSeen = { live: 0, peak: 0 };
        page.on('workercreated', (w) => {
            if (!isPdfWorker(w)) return;
            pdfSeen.live += 1;
            pdfSeen.peak = Math.max(pdfSeen.peak, pdfSeen.live);
        });
        page.on('workerdestroyed', (w) => { if (isPdfWorker(w)) pdfSeen.live -= 1; });
        const pdfDocumentsSettle = async (expected, timeout = 10_000) => {
            const t0 = Date.now();
            while (pdfDocuments() !== expected && Date.now() - t0 < timeout) await settle(50);
            return pdfDocuments();
        };

        // ------------------------------------------------------------------
        section('1. Navigation and empty state');
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        const labels = await page.evaluate(() => [...document.querySelectorAll('header nav button')].map((b) => b.textContent.trim()));
        check('six tools and the guide in the navigation, 図面管理 last', labels.length === 7 && labels[6] === '図面管理', labels.join(' | '));
        check('図面管理 is a top-level entry, not inside another tool', labels.includes('図面管理') && labels.includes('PDF加工'));
        await clickNav('図面管理');
        await page.waitForSelector('[data-ds-root]');
        const emptyText = await page.evaluate(() => document.querySelector('[data-ds-empty]')?.textContent ?? '');
        check('empty state is shown', emptyText.includes('図面一式を読み込み、ページ構成を確認します。') && emptyText.includes('PDFを選択'));
        check('empty state says processing is in the browser and nothing is sent',
            emptyText.includes('処理はブラウザ内で行います') && emptyText.includes('PDFはサーバーへ送信しません'));
        const firstHeader = await page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0);
        note('app header height at 1400 px', `${Math.round(firstHeader)} px`);

        section('2. Several PDFs, one at a time, with progress');
        await page.evaluate(() => { window.__dsDelayMs = 300; });
        await upload(fixture('p1-native-a'), fixture('p1-image-only-b'), fixture('p1-second-c'), fixture('p1-native-a-copy'));
        await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsState === 'busy', { timeout: 10_000, polling: 20 }).catch(() => { });
        const during = await root();
        check('progress is visible while files are taken in', during.state === 'busy' && during.status.includes('処理中'), during.status);
        check('the queue is visible: one processing, the rest waiting',
            during.results.filter((r) => r.state === 'processing').length === 1 && during.results.some((r) => r.state === 'queued'),
            during.results.map((r) => r.state).join(','));
        await page.evaluate(() => { window.__dsDelayMs = 0; });
        await waitIdle();
        const after = await root();
        check('three Sources accepted', after.sources === 3, String(after.sources));
        check('nine Sheets (4 + 2 + 3)', after.sheets === 9, String(after.sheets));
        check('every file has a result: 3 added, 1 duplicate',
            after.results.filter((r) => r.state === 'accepted').length === 3 && after.results.filter((r) => r.state === 'duplicate').length === 1);
        const dupText = after.results.find((r) => r.state === 'duplicate')?.text ?? '';
        check('the duplicate names the Source that already has those bytes', dupText.includes('p1-native-a-copy.pdf') && dupText.includes('「p1-native-a.pdf」'), dupText);
        // The preview of the first Sheet reads (and fingerprints) its file
        // again, so the Worker count is read once that has rendered.
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 60_000 }).catch(() => { });
        check('no fingerprint Worker left running', fingerprintWorkers() === 0);

        section('3. Sheet List rows');
        const list = await rows();
        check('one row per Sheet', list.length === 9);
        check('rows show page and file', list[0].text.includes('p.1') && list[0].text.includes('p1-native-a.pdf'));
        check('rows show paper, orientation and size', list[0].text.includes('A4') && list[0].text.includes('縦') && list[0].text.includes('210 × 297 mm'), list[0].text);
        check('a rotated page shows the orientation it is seen in', list[2].text.includes('横'), list[2].text);
        check('native text and no-text pages are told apart',
            list.filter((r) => r.text.includes('テキストあり')).length === 7 && list.filter((r) => r.text.includes('テキストなし')).length === 2);
        const rootText = await page.evaluate(() => document.querySelector('[data-ds-root]').textContent);
        probe('no drawing number, revision, issue date, QA or review in the workspace',
            !/図面番号|版数|改訂|発行日|QA|レビュー|保留|要対応/.test(rootText));

        section('4. Read-only viewer');
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 60_000 }).catch(() => { });
        const first = await viewer();
        check('the first Sheet is selected and rendered', first?.state === 'rendered' && first.renderedSheet === list[0].id && await canvasHasInk());
        const secondId = await clickRow(1);
        await waitRendered(secondId);
        const second = await viewer();
        check('selecting a Sheet renders that page', second.renderedSheet === secondId && second.label.includes('2 / 4'), second.label);
        const info = await page.evaluate(() => document.querySelector('[data-ds-sheet-info]')?.textContent ?? '');
        check('the info pane shows paper, orientation and rotation', info.includes('A3') && info.includes('横') && info.includes('0°'));
        check('the SHA-256 is shown as content identification, not authenticity',
            info.includes('ファイル内容の識別用') && info.includes('署名や改ざん防止の証明ではありません'));
        const shownSha = await page.evaluate(() => document.querySelector('[data-ds-info-sha]')?.dataset.dsInfoSha);
        check('the SHA-256 shown is node:crypto\'s digest of the file', shownSha === sha('p1-native-a'));
        const before = await viewer();
        await page.click('[data-ds-zoom-in]');
        await page.waitForFunction((w) => {
            const v = document.querySelector('[data-ds-viewer]');
            return v.dataset.dsRenderState === 'rendered' && parseFloat(v.querySelector('canvas').style.width) > w;
        }, { timeout: 30_000 }, before.cssWidth);
        const zoomed = await viewer();
        check('zoom in enlarges the page', zoomed.zoom === '125%' && zoomed.cssWidth > before.cssWidth, `${before.cssWidth} -> ${zoomed.cssWidth}`);
        await page.click('[data-ds-zoom-out]');
        await page.click('[data-ds-zoom-out]');
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer] [data-ds-zoom-value]')?.textContent === '80%');
        await page.click('[data-ds-zoom-fit]');
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]').dataset.dsRenderState === 'rendered'
            && document.querySelector('[data-ds-zoom-value]').textContent === '100%');
        const fitted = await viewer();
        check('zoom out and back to the whole page', fitted.zoom === '100%' && fitted.state === 'rendered'
            && Math.abs(fitted.cssWidth - before.cssWidth) < 2, `${fitted.zoom}, ${fitted.cssWidth} px`);

        // Switch quickly: every render but the last is superseded.
        for (const i of [0, 2, 3, 1, 2]) await clickRow(i);
        const lastId = list[2].id;
        await waitRendered(lastId);
        await settle(300);
        const switched = await viewer();
        check('rapid switching ends on the last Sheet chosen, rendered', switched.renderedSheet === lastId && switched.state === 'rendered');
        note('renders cancelled so far', switched.cancelled);

        const cId = list.find((r) => r.text.includes('p1-second-c.pdf')).id;
        const cIndex = list.find((r) => r.id === cId).index;
        const beforeSwitch = await viewer();
        await clickRow(cIndex);
        await waitRendered(cId);
        const afterSwitch = await viewer();
        check('switching Source renders the other file', afterSwitch.label.includes('p1-second-c.pdf'));
        check('switching Source destroys the previous document: at most one open',
            Number(afterSwitch.live) === 1 && Number(afterSwitch.opened) === Number(beforeSwitch.opened) + 1
            && Number(afterSwitch.destroyed) === Number(beforeSwitch.destroyed) + 1,
            `opened ${afterSwitch.opened}, destroyed ${afterSwitch.destroyed}, live ${afterSwitch.live}`);
        const bIndex = list.find((r) => r.text.includes('p1-image-only-b.pdf')).index;
        const bId = await clickRow(bIndex);
        await waitRendered(bId);
        check('an image-only page renders', await canvasHasInk());

        // Rapid Source switching while the preview reads are slowed: reads in
        // progress stop, and a document opens only once the previous one is
        // destroyed. No intake runs here, so every PDF.js document is the
        // preview's.
        const aIndex = list.find((r) => r.text.includes('p1-native-a.pdf')).index;
        const aId = list[aIndex].id;
        check('before rapid switching, the preview holds one PDF.js document', await pdfDocumentsSettle(1) === 1);
        pdfSeen.peak = pdfSeen.live;
        await page.evaluate(() => { window.__dsDelayMs = 120; });
        for (const i of [cIndex, aIndex, cIndex, bIndex, aIndex]) {
            await clickRow(i);
            await settle(40);
        }
        await page.evaluate(() => { window.__dsDelayMs = 0; });
        await waitRendered(aId);
        await settle(300);
        const rapid = await viewer();
        check('rapid Source switching with slowed reads ends on the last choice, rendered', rapid.renderedSheet === aId && rapid.label.includes('p1-native-a.pdf'));
        check('rapid Source switching: PDF.js documents never overlapped; one held after',
            pdfSeen.peak <= 1 && await pdfDocumentsSettle(1) === 1, `peak ${pdfSeen.peak}, held ${pdfDocuments()}`);
        check('the preview counts agree: every other document destroyed (not just asked), every render ended once',
            Number(rapid.live) === 1 && Number(rapid.opened) - Number(rapid.destroyed) === 1 && rapid.destroyRequested === rapid.destroyed
            && Number(rapid.started) === Number(rapid.completed) + Number(rapid.cancelled) + Number(rapid.failed) && rapid.failed === '0',
            `opened ${rapid.opened}, destroy asked ${rapid.destroyRequested} / done ${rapid.destroyed}; renders ${rapid.started} = ${rapid.completed} + ${rapid.cancelled} + ${rapid.failed}`);

        const controls = await page.evaluate(() => {
            const el = document.querySelector('[data-ds-root]');
            const buttons = [...el.querySelectorAll('button')].map((b) => `${b.textContent} ${b.title} ${b.getAttribute('aria-label') ?? ''}`);
            return {
                editing: buttons.filter((t) => /保存|ダウンロード|書き出|注釈|ペン|描画|編集|消しゴム|テキスト追加|Save|Download|Export/i.test(t)),
                downloads: el.querySelectorAll('a[download], a[href^="blob:"]').length,
                inputs: [...el.querySelectorAll('input, textarea, [contenteditable="true"]')].filter((i) => !i.matches('[data-ds-file-input]')).length,
                textLayer: el.querySelectorAll('.textLayer, .annotationLayer').length,
            };
        });
        probe('no save, download, annotation or editing control', controls.editing.length === 0 && controls.downloads === 0, controls.editing.join(' | '));
        probe('no input other than the file picker, no text or annotation layer', controls.inputs === 0 && controls.textLayer === 0);

        section('5. A refusal leaves the accepted files alone');
        await upload(fixture('p1-not-a-pdf'), fixture('p1-password'));
        await waitIdle();
        const refused = await root();
        const refusals = refused.results.filter((r) => r.state === 'refused');
        check('the broken and the password-protected file are refused, each with its reason',
            refusals.length === 2 && refusals.some((r) => r.text.includes('PDFとして読み取れない')) && refusals.some((r) => r.text.includes('パスワード')),
            refusals.map((r) => r.text).join(' | '));
        check('the Drawing Set is unchanged', refused.sources === 3 && refused.sheets === 9);
        await upload(fixture('p1-native-a'));
        await waitIdle();
        check('picking the same file again binds nothing new', (await root()).sources === 3);

        section('6. Removing a file');
        const removeC = await page.evaluate(() => {
            const row = [...document.querySelectorAll('[data-ds-source-row]')].find((r) => r.textContent.includes('p1-second-c.pdf'));
            row?.querySelector('[data-ds-remove-source]')?.click();
            return Boolean(row);
        });
        await page.waitForSelector('[data-ds-confirm="remove"]');
        const confirmText = await page.evaluate(() => document.querySelector('[data-ds-confirm]').textContent);
        check('removal asks first, naming the file', removeC && confirmText.includes('p1-second-c.pdf'));
        await page.click('[data-ds-confirm-yes]');
        await page.waitForFunction(() => document.querySelector('[data-ds-root]').dataset.dsSources === '2');
        const removed = await root();
        check('its Sheets leave the list; the other files are untouched', removed.sheets === 6 && (await rows()).every((r) => !r.text.includes('p1-second-c.pdf')));
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 30_000 }).catch(() => { });
        const afterRemoval = await viewer();
        check('the viewer still holds at most one document', afterRemoval && Number(afterRemoval.live) <= 1 && await pdfDocumentsSettle(1) === 1,
            `${afterRemoval?.live}; PDF.js documents ${pdfDocuments()}`);

        section('7. Total Sheet limit and 5000 rows');
        await upload(fixture('p1-5000-pages'));
        await waitIdle();
        const limited = await root();
        const limitText = limited.results.find((r) => r.text.includes('p1-5000-pages.pdf'))?.text ?? '';
        check('6 + 5000 Sheets: refused at the total Sheet limit, nothing added',
            limited.sheets === 6 && limitText.includes('上限（5000）'), limitText);
        await page.click('[data-ds-reset]');
        await page.waitForSelector('[data-ds-confirm="reset"]');
        await page.click('[data-ds-confirm-yes]');
        await page.waitForSelector('[data-ds-empty]');
        const t0 = Date.now();
        await upload(fixture('p1-5000-pages'));
        await waitIdle(300_000);
        const big = await root();
        check('a 5000-page file is taken in whole', big.sources === 1 && big.sheets === 5000, `${big.sheets} sheets in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        const domRows = async () => page.evaluate(() => ({
            dom: document.querySelectorAll('[data-ds-sheet-row]').length,
            declared: Number(document.querySelector('[data-ds-sheet-list]').dataset.dsRenderedRows),
            total: Number(document.querySelector('[data-ds-sheet-list]').dataset.dsRowCount),
            height: document.querySelector('[data-ds-sheet-list]').clientHeight,
        }));
        const atStart = await domRows();
        check('5000 Sheets, a few dozen row elements', atStart.total === 5000 && atStart.dom <= 60 && atStart.dom === atStart.declared,
            `${atStart.dom} rows in the DOM for a ${atStart.height} px list`);
        await page.evaluate(() => { const l = document.querySelector('[data-ds-sheet-list]'); l.scrollTop = l.scrollHeight / 2; });
        await settle(200);
        const atMiddle = await domRows();
        const middleRows = await rows();
        check('scrolled to the middle: still bounded, showing the middle', atMiddle.dom <= 60 && middleRows.some((r) => r.page === 2500), `${atMiddle.dom} rows`);
        await page.focus('[data-ds-sheet-list]');
        await page.keyboard.press('End');
        await settle(300);
        const endRows = await rows();
        const last = endRows.find((r) => r.page === 5000);
        check('End selects the last Sheet and brings it into view', last?.selected === true && endRows.length <= 60);
        await waitRendered(last.id);
        check('the viewer renders page 5000', (await viewer()).label.includes('5000 / 5000'));
        await page.keyboard.press('Home');
        await settle(300);
        check('Home returns to the first Sheet', (await rows()).find((r) => r.page === 1)?.selected === true);
        await upload(fixture('p1-native-a'));
        await waitIdle();
        const full = await root();
        check('at 5000 Sheets another file is refused, nothing added',
            full.sheets === 5000 && full.results.some((r) => r.state === 'refused' && r.text.includes('p1-native-a.pdf')));

        section('8. New Drawing Set while a file is still being read');
        await page.click('[data-ds-reset]');
        await page.click('[data-ds-confirm-yes]');
        await page.waitForSelector('[data-ds-empty]');
        await page.evaluate(() => { window.__dsDelayMs = 1500; });
        await upload(fixture('p1-native-a'), fixture('p1-second-c'));
        await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsState === 'busy', { timeout: 10_000, polling: 20 });
        const busyWorkers = fingerprintWorkers();
        await page.click('[data-ds-reset]');
        await page.click('[data-ds-confirm-yes]');
        await page.evaluate(() => { window.__dsDelayMs = 0; });
        await settle(3000);
        const stale = await root();
        check('the old run publishes nothing: no Source, no Sheet, no result, no error',
            stale.sources === 0 && stale.sheets === 0 && stale.results.length === 0 && stale.empty, JSON.stringify(stale.results));
        check('its fingerprint Worker is gone', fingerprintWorkers() === 0, `${busyWorkers} while reading`);
        check('no PDF.js document is left behind', await pdfDocumentsSettle(0) === 0, String(pdfDocuments()));
        await upload(fixture('p1-second-c'));
        await waitIdle();
        check('the new Drawing Set works', (await root()).sources === 1);

        section('9. Reset');
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 30_000 }).catch(() => { });
        const heldBeforeReset = await pdfDocumentsSettle(1);
        await page.click('[data-ds-reset]');
        await page.waitForSelector('[data-ds-confirm="reset"]');
        const resetText = await page.evaluate(() => document.querySelector('[data-ds-confirm]').textContent);
        check('reset asks first and says nothing is saved', resetText.includes('保存されず'));
        await page.click('[data-ds-confirm-yes]');
        await page.waitForSelector('[data-ds-empty]');
        const cleared = await root();
        check('reset clears the session', cleared.sources === 0 && cleared.sheets === 0 && cleared.results.length === 0);
        check('reset destroys the preview document', heldBeforeReset === 1 && await pdfDocumentsSettle(0) === 0,
            `${heldBeforeReset} before, ${pdfDocuments()} after`);

        section('10. The other tools');
        await upload(fixture('p1-second-c'));
        await waitIdle();
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 30_000 }).catch(() => { });
        const heldBeforeLeaving = await pdfDocumentsSettle(1);
        const countsBeforeLeaving = await viewer();
        await clickNav('使い方');
        check('leaving 図面管理 destroys the preview document', heldBeforeLeaving === 1 && await pdfDocumentsSettle(0) === 0,
            `${heldBeforeLeaving} before, ${pdfDocuments()} after`);
        for (const label of ['使い方', 'PDF加筆', 'PDF比較', 'PDF加工', 'PDF抽出・統合', 'PDFテキスト化']) {
            const found = await clickNav(label);
            await settle(400);
            const state = await page.evaluate((text) => {
                const button = [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === text);
                const main = document.querySelector('main');
                return { active: button?.style.backgroundColor === 'rgb(74, 144, 226)', content: (main?.textContent ?? '').length, ds: Boolean(document.querySelector('[data-ds-root]')) };
            }, label);
            check(`${label} is reachable`, found && state.active && state.content > 20 && !state.ds);
        }
        const guideHeaders = await page.evaluate(async () => {
            [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === '使い方').click();
            await new Promise((r) => setTimeout(r, 300));
            return document.querySelectorAll('.usage-header').length;
        });
        check('the guide lists six tools', guideHeaders === 6, String(guideHeaders));
        await clickNav('図面管理');
        await page.waitForSelector('[data-ds-empty]');
        check('coming back to 図面管理 starts empty (nothing was kept)', (await root()).sources === 0);
        // The page keeps one preview owner across visits, so a document PDF.js
        // could not destroy still stops previews after coming back.
        await upload(fixture('p1-second-c'));
        await waitIdle();
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 30_000 }).catch(() => { });
        const countsAfterReturn = await viewer();
        check('coming back previews through the same owner: its counts go on, one PDF.js document held',
            countsAfterReturn?.state === 'rendered' && Number(countsAfterReturn.opened) === Number(countsBeforeLeaving?.opened) + 1
            && Number(countsAfterReturn.live) === 1 && await pdfDocumentsSettle(1) === 1,
            `opened ${countsBeforeLeaving?.opened} before leaving, ${countsAfterReturn?.opened} after coming back; PDF.js documents ${pdfDocuments()}`);

        section('11. Privacy');
        check('no request left the machine', external.length === 0, external.join(', '));
        const workerFetches = requests.filter((u) => u === `${ORIGIN}/pdf.worker.min.mjs`).length;
        check('the PDF.js worker is the local one', workerFetches > 0 && !requests.some((u) => /pdf\.worker/.test(u) && !u.startsWith(ORIGIN)), `${workerFetches} local fetches`);
        const storage = await page.evaluate(async () => ({
            local: localStorage.length,
            session: sessionStorage.length,
            idb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
        }));
        check('nothing in localStorage, sessionStorage or IndexedDB', storage.local === 0 && storage.session === 0 && storage.idb === 0, JSON.stringify(storage));
        check('no uncaught page error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

        const failed = checks.filter((c) => !c.ok);
        console.log(`\n${checks.length - failed.length}/${checks.length} checks passed  [${version}]`);
        if (failed.length > 0) {
            console.log('FAILED:');
            for (const f of failed) console.log(`  - ${f.name}`);
        }
        exitCode = failed.length === 0 ? 0 : 1;
    } catch (error) {
        console.error(`\nSmoke run failed: ${error?.stack ?? error}\n`);
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
    process.exit(exitCode);
}

main();
