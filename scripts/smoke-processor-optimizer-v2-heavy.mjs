/**
 * 最適化 v2 (D-028 Stage 1) — local heavy evidence, not CI.
 *
 * The problem that started Optimizer v2, through the built application:
 * an old-Comparator-like A1 × 5 PDF at 150 dpi (~261 MB, one raw DeviceRGB
 * image per page and a line of native text), selected in PDF加工 → 最適化.
 *
 *   512 MiB  refused before anything starts; no file is written
 *   1 GiB    one PDF comes back, far smaller; every page image decodes to the
 *            same pixels (pdf.js, independently), page sizes, text, operators
 *            and metadata unchanged, and the output reopens
 *
 * Resource-guarded: it will not start with less than 10 GiB of free physical
 * memory, and it runs one heavy step at a time.
 *
 * Run: npm run build && node scripts/smoke-processor-optimizer-v2-heavy.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, 'test-fixtures', 'processor-optimizer-v2-heavy');
const SOURCE = path.join(DIR, 'a1x5-150dpi.pdf');
const MIN_FREE = 10 * 1024 ** 3;
const MODE = process.argv[2] ?? 'gate';

// ---------------------------------------------------------------- generate

async function generate() {
    const { PDFDocument, PDFName, StandardFonts } = await import('pdf-lib');
    fs.mkdirSync(DIR, { recursive: true });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const colours = [[0, 0, 0], [220, 0, 0], [0, 0, 200]];
    // A1 at 150 dpi: 841 × 594 mm → 4967 × 3508 px; three landscape, two portrait.
    const sizes = [[4967, 3508], [4967, 3508], [4967, 3508], [3508, 4967], [3508, 4967]];
    let seed = 1;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let p = 0; p < sizes.length; p += 1) {
        const [w, h] = sizes[p];
        const px = Buffer.alloc(w * h * 3, 255);
        const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < w && y < h) { const i = (y * w + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; } };
        for (let i = 0; i < 400; i += 1) {
            const c = colours[i % (p === 0 ? 1 : colours.length)];
            let x0 = Math.floor(rnd() * w); let y0 = Math.floor(rnd() * h);
            const x1 = Math.floor(rnd() * w); const y1 = Math.floor(rnd() * h);
            const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
            let err = dx + dy;
            for (;;) {
                set(x0, y0, c); set(x0 + 1, y0, c); set(x0, y0 + 1, c);
                if (x0 === x1 && y0 === y1) break;
                const e2 = 2 * err;
                if (e2 >= dy) { err += dy; x0 += sx; }
                if (e2 <= dx) { err += dx; y0 += sy; }
            }
        }
        const wPt = (w * 72) / 150; const hPt = (h * 72) / 150;
        const ref = doc.context.register(doc.context.stream(px, {
            Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
        }));
        const page = doc.addPage([wPt, hPt]);
        page.node.setXObject(PDFName.of('Im0'), ref);
        const key = page.node.newFontDictionary('F1', font.ref).asString();
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
            `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q\nBT ${key} 14 Tf 40 40 Td (Comparison verdict: CHANGE sheet ${p + 1}) Tj ET\n`, {},
        )));
    }
    doc.setTitle('A1 x 5 comparison (synthetic)');
    doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(SOURCE, bytes);
    console.log(`generated ${SOURCE}: ${bytes.length.toLocaleString('en-US')} bytes`);
}

// ---------------------------------------------------------------- verify (child)

async function verify(outFile) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
    const toRgba = (img) => {
        const { width: w, height: h, kind, data } = img;
        if (kind === 3) return Buffer.from(data.buffer, data.byteOffset, data.length);
        const out = Buffer.alloc(w * h * 4);
        if (kind === 2) { for (let i = 0; i < w * h; i += 1) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = 255; } return out; }
        const stride = (w + 7) >> 3;
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const v = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; const o = (y * w + x) * 4; out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255; }
        return out;
    };
    const seen = async (file) => {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
        const pages = [];
        for (let p = 1; p <= pdf.numPages; p += 1) {
            const page = await pdf.getPage(p);
            const ops = await page.getOperatorList();
            const images = [];
            for (let i = 0; i < ops.fnArray.length; i += 1) {
                if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject) {
                    const id = ops.argsArray[i][0];
                    const img = await new Promise((r) => (id.startsWith('g_') ? page.commonObjs : page.objs).get(id, r));
                    images.push(`${img.width}x${img.height}/${crypto.createHash('sha256').update(toRgba(img)).digest('hex').slice(0, 24)}`);
                }
            }
            const text = (await page.getTextContent()).items.map((t) => t.str).join(' ');
            pages.push({ view: page.view.join(','), rotate: page.rotate, fn: ops.fnArray.join(','), images, text });
            page.cleanup();
        }
        const md = await pdf.getMetadata();
        await pdf.destroy();
        return { pages, title: md.info?.Title ?? null };
    };
    const a = await seen(SOURCE);
    const b = await seen(outFile);
    const doc = await PDFDocument.load(fs.readFileSync(outFile), { throwOnInvalidObject: true, updateMetadata: false });
    const dims = [];
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
        if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
            dims.push(`${o.dict.get(PDFName.of('Width'))}x${o.dict.get(PDFName.of('Height'))} ${o.dict.lookup(PDFName.of('ColorSpace'))?.toString().slice(0, 40)} bpc=${o.dict.get(PDFName.of('BitsPerComponent'))}`);
        }
    }
    const pixelsEqual = a.pages.map((p, i) => p.images.length > 0 && p.images.join() === b.pages[i]?.images.join());
    const result = {
        pageCount: [a.pages.length, b.pages.length],
        pixelsEqual,
        viewsEqual: a.pages.every((p, i) => p.view === b.pages[i]?.view && p.rotate === b.pages[i]?.rotate),
        operatorsEqual: a.pages.every((p, i) => p.fn === b.pages[i]?.fn),
        textEqual: a.pages.every((p, i) => p.text === b.pages[i]?.text && p.text.includes('Comparison verdict')),
        titleEqual: a.title === b.title && a.title !== null,
        reopened: doc.getPageCount() === 5,
        outputImages: dims,
        sourceImages: a.pages.map((p) => p.images[0]?.split('/')[0]),
    };
    console.log(`VERIFY ${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------- gate

async function gate() {
    const free = os.freemem();
    console.log(`free physical memory: ${(free / 1024 ** 3).toFixed(1)} GiB`);
    if (free < MIN_FREE) {
        console.log('RESOURCE BLOCKED: less than 10 GiB free. Not starting the heavy gate.');
        process.exit(2);
    }
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { console.error('No build. Run: npm run build'); process.exit(1); }
    if (!fs.existsSync(SOURCE)) {
        const r = spawnSync(process.execPath, ['--max-old-space-size=6000', fileURLToPath(import.meta.url), 'generate'], { stdio: 'inherit' });
        if (r.status !== 0) process.exit(1);
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const srcDirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    const sourceBytes = fs.statSync(SOURCE).size;
    console.log(`head ${head} srcDirty=${srcDirty} source ${sourceBytes.toLocaleString('en-US')} B`);

    const checks = [];
    const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

    const { preview } = await import('vite');
    const puppeteer = (await import('puppeteer')).default;
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-v2-heavy-dl-'));
    const server = await preview({ root: ROOT, preview: { port: 5213, strictPort: true }, logLevel: 'warn' });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const evidence = { head, srcDirty, sourceBytes, at: new Date().toISOString() };
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const cdp = await page.target().createCDPSession();
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        const settle = (ms) => new Promise((r) => { setTimeout(r, ms); });
        const done = () => fs.readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'));
        const fresh = async () => {
            await page.goto('http://localhost:5213', { waitUntil: 'networkidle0' });
            await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('PDF加工'))?.click());
            await page.evaluate(() => [...document.querySelectorAll('.tool-btn')].find((b) => b.textContent?.includes('最適化'))?.click());
            for (const f of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, f), { force: true });
        };
        const setMemory = (bytes) => page.evaluate((v) => {
            const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === '536870912'));
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(s, String(v));
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return s.value;
        }, bytes);
        const upload = async () => {
            const input = await page.$('[data-usage-target="processor-upload"] input[type="file"]');
            await input.uploadFile(SOURCE);
            await settle(1500);
        };
        const run = () => page.evaluate(() => document.querySelector('[data-usage-target="processor-run"]')?.click());
        const rows = () => page.evaluate(() => [...document.querySelectorAll('.file-status')].map((e) => e.textContent?.trim()));
        const listText = () => page.evaluate(() => document.querySelector('.file-list')?.textContent ?? '');

        // ---- 512 MiB ----------------------------------------------------------
        await fresh();
        await upload();
        const t512 = Date.now();
        await run();
        let r512 = [];
        for (let i = 0; i < 120; i += 1) {
            r512 = await rows();
            if (r512.some((s) => s.includes('処理できません') || s.includes('完了') || s.includes('失敗'))) break;
            await settle(250);
        }
        const text512 = await listText();
        evidence.at512 = { rows: r512, ms: Date.now() - t512, message: text512.slice(0, 300) };
        check('512 MiB: refused explicitly (OVER_MEMORY_BUDGET)', r512.some((s) => s.includes('処理できません')) && text512.includes('OVER_MEMORY_BUDGET'), text512.slice(0, 160));
        check('512 MiB: the refusal names 1 GiB', text512.includes('1 GiB'));
        check('512 MiB: it was refused before any work (no 処理中 wait)', Date.now() - t512 < 30_000, `${Date.now() - t512} ms`);
        await settle(3000);
        check('512 MiB: no download', fs.readdirSync(downloads).length === 0, fs.readdirSync(downloads).join(','));

        // ---- 1 GiB ------------------------------------------------------------
        await fresh();
        check('1 GiB preset selected', (await setMemory(1024 ** 3)) === String(1024 ** 3));
        await upload();
        const t1g = Date.now();
        await run();
        let out = [];
        for (let i = 0; i < 1200 && out.length === 0; i += 1) {
            out = done();
            const r = await rows();
            if (r.some((s) => s.includes('処理できません') || s.includes('失敗'))) break;
            if (out.length === 0) await settle(500);
        }
        await settle(2000);
        out = done();
        const r1g = await rows();
        const summary = await page.evaluate(() => document.querySelector('[data-optimize-summary]')?.textContent ?? '');
        evidence.at1GiB = { rows: r1g, ms: Date.now() - t1g, files: out, summary };
        check('1 GiB: exactly one PDF, named _optimized', out.length === 1 && out[0] === 'a1x5-150dpi_optimized.pdf', out.join(','));
        check('1 GiB: the row is 完了', r1g.some((s) => s.includes('完了')), r1g.join(','));
        check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
        if (out.length === 1) {
            const outFile = path.join(DIR, out[0]);
            fs.copyFileSync(path.join(downloads, out[0]), outFile);
            const outBytes = fs.statSync(outFile).size;
            evidence.outputBytes = outBytes;
            evidence.reductionPercent = +(100 * (1 - outBytes / sourceBytes)).toFixed(3);
            check('1 GiB: the output is under 5 MB', outBytes < 5_000_000, `${sourceBytes.toLocaleString('en-US')} -> ${outBytes.toLocaleString('en-US')} B`);
            check('1 GiB: and under the 256 MiB output ceiling', outBytes <= 256 * 1024 * 1024);
            await browser.close();
            await server.close();
            const v = spawnSync(process.execPath, ['--max-old-space-size=8000', fileURLToPath(import.meta.url), 'verify', outFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            const line = (v.stdout || '').split('\n').find((l) => l.startsWith('VERIFY '));
            const res = line ? JSON.parse(line.slice(7)) : null;
            evidence.verify = res ?? { error: (v.stderr || '').slice(-600) };
            check('decoded pixels equal on every page (pdf.js, independent)', res?.pixelsEqual?.length === 5 && res.pixelsEqual.every(Boolean), JSON.stringify(res?.pixelsEqual));
            check('page sizes and rotation unchanged', res?.viewsEqual === true);
            check('operator sequences (vectors, text drawing, image placement) unchanged', res?.operatorsEqual === true);
            check('native text unchanged', res?.textEqual === true);
            check('metadata title unchanged', res?.titleEqual === true);
            check('the output reopens with pdf-lib (throwOnInvalidObject), 5 pages', res?.reopened === true);
            check('image dimensions unchanged (no resolution change)', res && res.outputImages.length === 5
                && res.outputImages.every((d, i) => d.startsWith(res.sourceImages[i] ?? '?')), JSON.stringify(res?.outputImages));
        }
    } finally {
        try { await browser.close(); } catch { /* closed */ }
        try { await server.close(); } catch { /* closed */ }
        fs.rmSync(downloads, { recursive: true, force: true });
    }
    const passed = checks.filter((c) => c.ok).length;
    evidence.checks = `${passed}/${checks.length}`;
    fs.writeFileSync(path.join(DIR, 'evidence.json'), JSON.stringify(evidence, null, 1));
    console.log(`\n${passed}/${checks.length} checks passed`);
    console.log(`EVIDENCE ${JSON.stringify(evidence)}`);
    process.exit(passed === checks.length ? 0 : 1);
}

if (MODE === 'generate') await generate();
else if (MODE === 'verify') await verify(process.argv[3]);
else await gate();
