/**
 * Real-browser checks with the pinned puppeteer Chrome:
 *   1. canvas feasibility at the A1 frames (create, fill, getImageData) - the
 *      hard allocation the kernel cannot avoid;
 *   2. CompressionStream('deflate') availability and throughput on a
 *      page-sized buffer;
 *   3. each candidate PDF opened in Chrome's own PDF viewer, screenshotted.
 *
 * Run: node harness/chrome-check.mjs  -> evidence/chrome-check.json, out/chrome/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'out', 'chrome');
fs.mkdirSync(SHOTS, { recursive: true });

const FRAMES = [
    { dpi: 150, width: 4969, height: 3509 },
    { dpi: 300, width: 9938, height: 7017 },
    { dpi: 450, width: 14907, height: 10526 },
];
const PDFS = [
    ['dpi150', 'current_p1-3.pdf'],
    ['dpi150', 'idx4m-up_p1-5.pdf'],
    ['dpi150', 'idx4m-cs_p1-5.pdf'],
    ['dpi300', 'idx4m-up_p1-5.pdf'],
    ['dpi450', 'idx4m-up_p1-5.pdf'],
    ['dpi450', 'idx4m-cs-up_p1-5.pdf'],
    ['dpi150', 'jpeg-q75_p1-5.pdf'],
];

const browser = await puppeteer.launch({ headless: true, args: ['--enable-precise-memory-info'] });
const result = { chrome: await browser.version(), canvas: [], compressionStream: null, viewer: [] };
try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    for (const f of FRAMES) {
        result.canvas.push(await page.evaluate(({ width, height, dpi }) => {
            const t = performance.now();
            try {
                const c = document.createElement('canvas');
                c.width = width;
                c.height = height;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                if (!ctx) return { dpi, width, height, ok: false, error: 'no 2d context' };
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = 'black';
                ctx.fillRect(width - 2, height - 2, 1, 1);
                const d = ctx.getImageData(0, 0, width, height).data;
                const last = d[((height - 2) * width + (width - 2)) * 4];
                const ok = d.length === width * height * 4 && last === 0;
                c.width = 1;
                c.height = 1;
                return { dpi, width, height, pixels: width * height, readbackBytes: d.length, ok, ms: Math.round(performance.now() - t), heapLimit: performance.memory?.jsHeapSizeLimit };
            } catch (e) {
                return { dpi, width, height, ok: false, error: String(e) };
            }
        }, f));
    }
    result.compressionStream = await page.evaluate(async () => {
        const n = Math.ceil(4969 / 2) * 3509; // one 150-dpi page of 4-bit indexed rows
        const buf = new Uint8Array(n);
        for (let i = 0; i < n; i += 997) buf[i] = 0x12;
        const t = performance.now();
        const cs = new CompressionStream('deflate');
        const out = new Response(cs.readable).arrayBuffer();
        const w = cs.writable.getWriter();
        for (let o = 0; o < n; o += 1 << 20) await w.write(buf.subarray(o, Math.min(n, o + (1 << 20))));
        await w.close();
        const bytes = (await out).byteLength;
        const head = new Uint8Array(await new Response(new Blob([buf.subarray(0, 64)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
        return { inputBytes: n, outputBytes: bytes, ms: Math.round(performance.now() - t), zlibHeader: [head[0], head[1]] };
    });
    for (const [tag, name] of PDFS) {
        const file = path.join(ROOT, 'out', 'pdf', tag, name);
        if (!fs.existsSync(file)) {
            result.viewer.push({ tag, name, skipped: 'missing' });
            continue;
        }
        const v = await browser.newPage();
        await v.setViewport({ width: 1400, height: 1000 });
        const t = Date.now();
        const resp = await v.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0', timeout: 120000 }).catch((e) => ({ error: String(e) }));
        await new Promise((r) => setTimeout(r, 4000));
        const shot = path.join(SHOTS, `${tag}-${name.replace('.pdf', '')}.png`);
        await v.screenshot({ path: shot });
        const embed = await v.evaluate(() => {
            const e = document.querySelector('embed');
            return e ? { type: e.getAttribute('type'), src: e.getAttribute('src')?.slice(0, 40) } : null;
        });
        result.viewer.push({ tag, name, ms: Date.now() - t, loadError: resp?.error ?? null, embed, screenshot: path.relative(ROOT, shot) });
        await v.close();
    }
} finally {
    await browser.close();
}
fs.writeFileSync(path.join(ROOT, 'evidence', 'chrome-check.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
