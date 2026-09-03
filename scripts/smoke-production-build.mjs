/**
 * Smoke the Textifier against the PRODUCTION build, through the real UI.
 *
 * `smoke-textifier.mjs` drives the pipeline module on the Vite dev server. That
 * left a gap: nothing exercised the bundled, minified build that actually ships,
 * and nothing clicked the real buttons. This closes both.
 *
 * Deliberately end-to-end and shallow: build, serve dist, open the app, load a
 * synthetic scanned PDF, press Start, and require a downloadable result.
 *
 * Run:  npm run build && node scripts/smoke-production-build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const ORIGIN = `http://localhost:${PORT}`;
const BUDGET_MS = 90_000;

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
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* opaque */ }
};
page.on('response', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
// OCR runs in a Web Worker; page-level events do not see its traffic.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* gone */ }
});

let exitCode = 1;
try {
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });

    const run = await page.evaluate(async (budgetMs) => {
        const open = (label) => [...document.querySelectorAll('button,a,div,span')]
            .filter((e) => (e.textContent || '').trim() === label && e.children.length === 0)[0]?.click();

        /** A page whose only content is one JPEG: no text objects at all. */
        const scannedPdf = (text, w = 900, h = 260) => {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#000'; ctx.font = '56px sans-serif'; ctx.fillText(text, 40, 155);
            const jpeg = Uint8Array.from(atob(c.toDataURL('image/jpeg', 0.95).split(',')[1]), (ch) => ch.charCodeAt(0));
            const PW = 595.28, PH = (595.28 * h) / w, enc = new TextEncoder();
            const chunks = []; let len = 0;
            const put = (u) => { chunks.push(u); len += u.length; };
            const ps = (s) => put(enc.encode(s));
            const off = [];
            const obj = (n, b, st) => { off[n] = len; ps(`${n} 0 obj\n${b}\n`); if (st) { ps('stream\n'); put(st); ps('\nendstream\n'); } ps('endobj\n'); };
            ps('%PDF-1.7\n');
            obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
            obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
            obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
            const ct = enc.encode(`q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`);
            obj(4, `<< /Length ${ct.length} >>`, ct);
            obj(5, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
            const xr = len; let s2 = 'xref\n0 6\n0000000000 65535 f \n';
            for (let i = 1; i <= 5; i++) s2 += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
            ps(s2 + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF\n`);
            const out = new Uint8Array(len); let o = 0;
            for (const ch of chunks) { out.set(ch, o); o += ch.length; }
            return new File([out], 'prod-smoke.pdf', { type: 'application/pdf' });
        };

        open('PDFテキスト化');
        await new Promise((r) => setTimeout(r, 700));
        const textifierOpened = /PDFテキスト化 \(PDF Textification\)/.test(document.body.innerText);

        const input = document.querySelector('input[type=file]');
        const dt = new DataTransfer();
        dt.items.add(scannedPdf('Architectural Drawing'));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1500));

        const phases = [];
        new MutationObserver(() => {
            const m = document.body.innerText.match(/(PDFを読み込み中|ページを判定中[^\n]*|OCRエンジンを準備中|文字認識中[^\n]*|検索可能PDFを生成中|完了しました)/);
            if (m && phases[phases.length - 1] !== m[1]) phases.push(m[1]);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });

        const t0 = Date.now();
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Start Textification'))?.click();
        while (Date.now() - t0 < budgetMs && !document.body.innerText.includes('Processing Complete')) {
            await new Promise((r) => setTimeout(r, 300));
            if (/できませんでした|失敗しました/.test(document.body.innerText)) break;
        }

        const link = document.querySelector('a[download]');
        let downloadBytes = 0;
        if (link?.href?.startsWith('blob:')) {
            downloadBytes = (await (await fetch(link.href)).arrayBuffer()).byteLength;
        }
        return {
            textifierOpened,
            complete: document.body.innerText.includes('Processing Complete'),
            elapsedMs: Date.now() - t0,
            phases,
            summary: (document.body.innerText.match(/Processing Complete![\s\S]{0,140}/) || [''])[0].replace(/\n+/g, ' | '),
            downloadName: link?.getAttribute('download') ?? null,
            downloadBytes,
            errorShown: (document.body.innerText.match(/(できませんでした[^\n]*|失敗しました[^\n]*)/) || [''])[0],
        };
    }, BUDGET_MS);

    console.log(`\n=== production build, real UI ===`);
    console.log(`  phases   : ${run.phases.join(' -> ')}`);
    console.log(`  summary  : ${run.summary}`);
    console.log(`  download : ${run.downloadName} (${run.downloadBytes} bytes)`);
    console.log(`  elapsed  : ${run.elapsedMs} ms\n`);

    check('Textifier opens in the built app', run.textifierOpened === true);
    check('processing completes', run.complete === true, `${run.elapsedMs} ms${run.errorShown ? ` - ${run.errorShown}` : ''}`);
    check('progress reported per phase', run.phases.length >= 3, run.phases.join(' -> '));
    check('OCR recognised words', /認識 [1-9]/.test(run.summary), run.summary.slice(0, 60));
    check('searchable PDF is downloadable', run.downloadBytes > 1000, `${run.downloadBytes} bytes`);
    check('no external request', [...new Set(external)].length === 0, [...new Set(external)].join(', '));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
