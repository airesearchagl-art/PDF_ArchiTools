/**
 * Local performance evidence for M7-P1's fingerprint path. Not a CI gate.
 *
 * Drives the built app's 図面管理 workspace -- the Production read loop and the
 * Production fingerprint Worker, as shipped in dist/ -- with synthetic PDFs of
 * 1, 10, 50, 100 and 250 MiB. Each file is a valid one-page PDF whose bulk is
 * an unreferenced stream of deterministic pseudo-random bytes, so PDF.js opens
 * it cheaply and the time is the reading and hashing. The reference digest is
 * node:crypto's, computed while the file is written.
 *
 * Measured per size: wall time from selection to the Source being in the
 * list; the app's own User Timing measure of read + fingerprint; whether the
 * digest the app shows equals node:crypto's; and main-thread responsiveness,
 * as the longest gap a 16 ms interval timer saw while the file was taken in.
 * Then one cancellation part-way through the largest file (its reads slowed
 * to 100 ms per 4 MiB chunk, only for that run, so the cancel lands while the
 * file is still being fingerprinted). Browser heap is NOT
 * measured: ArrayBuffers live outside the JS heap and nothing here claims a
 * number for them.
 *
 * A size is skipped, and reported RESOURCE_BLOCKED, when the machine has less
 * free memory than it needs (about 4x the file).
 *
 * Run:
 *   npm run build
 *   node scripts/bench-m7-p1-fingerprint.mjs --browser="C:\Program Files\Google\Chrome\Application\chrome.exe"
 *   options: --sizes=1,10,50,100,250  --no-cancel  --out=<results.json>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5216;
const ORIGIN = `http://localhost:${PORT}`;
const MiB = 1024 * 1024;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserPath = arg('browser') || process.env.M7_BROWSER || '';
const sizes = (arg('sizes') ?? '1,10,50,100,250').split(',').map(Number).filter((n) => n > 0);
const withCancel = !process.argv.includes('--no-cancel');
const outFile = arg('out');

/** Write a valid one-page PDF of exactly `totalBytes`, returning node:crypto's SHA-256 of it. */
function writeSyntheticPdf(file, totalBytes, seed) {
    const head = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null, // contents stream
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        null, // padding stream
    ];
    const content = 'BT /F1 28 Tf 60 760 Td (M7 P1 FINGERPRINT BENCH) Tj ET';
    const fixed = [];
    let offset = Buffer.byteLength(head, 'latin1');
    const offsets = [];
    const pieces = [Buffer.from(head, 'latin1')];
    const push = (text) => { const b = Buffer.from(text, 'latin1'); pieces.push(b); offset += b.length; };
    for (let i = 0; i < 4; i++) {
        offsets.push(offset);
        push(i === 3
            ? `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
            : `${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    }
    offsets.push(offset);
    push(`5 0 obj\n${objects[4]}\nendobj\n`);
    fixed.push(...pieces);

    // Object 6, the padding stream, starts at `offset`; the xref follows it.
    const padHeadFor = (padding) => `6 0 obj\n<< /Length ${padding} >>\nstream\n`;
    const tailFor = (padding) => {
        const xrefAt = offset + Buffer.byteLength(padHeadFor(padding)) + padding + '\nendstream\nendobj\n'.length;
        let xref = 'xref\n0 7\n0000000000 65535 f \n';
        for (const o of [...offsets, offset]) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
        return `\nendstream\nendobj\n${xref}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    };
    // Solve for the padding length so the file is exactly totalBytes.
    let padding = totalBytes - offset - 400;
    for (let i = 0; i < 8; i++) {
        const total = offset + Buffer.byteLength(padHeadFor(padding)) + padding + Buffer.byteLength(tailFor(padding));
        padding += totalBytes - total;
    }
    const padHead = padHeadFor(padding);
    const tail = tailFor(padding);

    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'w');
    const write = (buffer) => { fs.writeSync(fd, buffer); hash.update(buffer); };
    for (const piece of fixed) write(piece);
    write(Buffer.from(padHead, 'latin1'));
    let x = (seed >>> 0) || 1;
    const block = Buffer.alloc(MiB);
    for (let left = padding; left > 0;) {
        const n = Math.min(left, block.length);
        for (let i = 0; i < n; i++) {
            x ^= x << 13; x >>>= 0;
            x ^= x >>> 17; x >>>= 0;
            x ^= x << 5; x >>>= 0;
            block[i] = x & 0xff;
        }
        write(block.subarray(0, n));
        left -= n;
    }
    write(Buffer.from(tail, 'latin1'));
    fs.closeSync(fd);
    const size = fs.statSync(file).size;
    if (size !== totalBytes) throw new Error(`synthetic file is ${size} bytes, wanted ${totalBytes}`);
    return hash.digest('hex');
}

async function main() {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
        console.error('No build to test. Run: npm run build');
        process.exit(1);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-p1-bench-'));
    const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: 0,
        ...(browserPath ? { executablePath: browserPath } : {}),
    });
    const results = { browser: '', executable: browserPath || 'puppeteer bundled', machine: {}, sizes: [], cancel: null, external: [] };
    let exitCode = 1;
    try {
        results.browser = await browser.version();
        results.machine = {
            platform: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? '',
            cores: os.cpus().length,
            totalMemGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
            freeMemGiBAtStart: +(os.freemem() / 1024 ** 3).toFixed(1),
        };
        console.log(`Browser: ${results.browser}  (${results.executable})`);
        console.log(`Machine: ${results.machine.cpu}, ${results.machine.cores} cores, ${results.machine.freeMemGiBAtStart} / ${results.machine.totalMemGiB} GiB free`);

        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        await page.setViewport({ width: 1400, height: 900 });
        const record = (url) => {
            if (!url || url.startsWith(ORIGIN)) return;
            try {
                const { protocol } = new URL(url);
                if (protocol === 'http:' || protocol === 'https:') results.external.push(url);
            } catch { /* data:, blob: */ }
        };
        page.on('request', (r) => record(r.url()));
        // Reads can be slowed on purpose for the cancellation run only.
        await page.evaluateOnNewDocument(() => {
            const original = Blob.prototype.arrayBuffer;
            Blob.prototype.arrayBuffer = async function arrayBuffer() {
                const ms = window.__dsDelayMs || 0;
                if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
                return original.call(this);
            };
        });
        browser.on('targetcreated', async (target) => {
            if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
            try {
                const session = await target.createCDPSession();
                await session.send('Network.enable');
                session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
            } catch { /* gone */ }
        });

        const open = async () => {
            await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
            await page.evaluate(() => [...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === '図面管理').click());
            await page.waitForSelector('[data-ds-empty]');
        };
        const monitor = () => page.evaluate(() => {
            window.__gaps = [];
            let last = performance.now();
            window.__monitor = setInterval(() => {
                const now = performance.now();
                window.__gaps.push(now - last);
                last = now;
            }, 16);
            performance.clearMeasures();
        });
        const stopMonitor = () => page.evaluate(() => {
            clearInterval(window.__monitor);
            const gaps = window.__gaps.slice().sort((a, b) => a - b);
            const measures = Object.fromEntries(performance.getEntriesByType('measure').map((m) => [m.name, m.duration]));
            return {
                maxGapMs: gaps.length ? gaps[gaps.length - 1] : 0,
                p95GapMs: gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0,
                ticks: gaps.length,
                measures,
            };
        });

        for (const sizeMiB of sizes) {
            const bytes = sizeMiB * MiB;
            const freeGiB = os.freemem() / 1024 ** 3;
            if (freeGiB * 1024 < sizeMiB * 4 + 1024) {
                console.log(`\n${sizeMiB} MiB: RESOURCE_BLOCKED (${freeGiB.toFixed(1)} GiB free)`);
                results.sizes.push({ sizeMiB, status: 'RESOURCE_BLOCKED', freeGiB: +freeGiB.toFixed(1) });
                continue;
            }
            const file = path.join(tmp, `bench-${sizeMiB}mib.pdf`);
            const reference = writeSyntheticPdf(file, bytes, 0x5eed + sizeMiB);
            await open();
            await monitor();
            const t0 = Date.now();
            await (await page.$('[data-ds-file-input]')).uploadFile(file);
            await page.waitForFunction(() => {
                const el = document.querySelector('[data-ds-root]');
                return el && el.dataset.dsState === 'idle' && el.querySelectorAll('[data-ds-result]').length > 0
                    && ![...el.querySelectorAll('[data-ds-result]')].some((r) => r.dataset.dsResult === 'processing' || r.dataset.dsResult === 'queued');
            }, { polling: 50 });
            const wallMs = Date.now() - t0;
            const timing = await stopMonitor();
            const state = await page.evaluate(() => ({
                sources: Number(document.querySelector('[data-ds-root]').dataset.dsSources),
                result: document.querySelector('[data-ds-result]')?.dataset.dsResult,
                sha: document.querySelector('[data-ds-info-sha]')?.dataset.dsInfoSha ?? null,
            }));
            const row = {
                sizeMiB,
                bytes,
                status: state.sources === 1 && state.sha === reference ? 'PASS' : 'FAIL',
                wallMs,
                readAndFingerprintMs: Math.round(timing.measures['drawing-set:read-and-fingerprint'] ?? NaN),
                pdfOpenMs: Math.round(timing.measures['drawing-set:pdf-open'] ?? NaN),
                inventoryMs: Math.round(timing.measures['drawing-set:inventory'] ?? NaN),
                mibPerSecond: +(sizeMiB / ((timing.measures['drawing-set:read-and-fingerprint'] ?? NaN) / 1000)).toFixed(1),
                digestMatchesNodeCrypto: state.sha === reference,
                sha256: state.sha,
                reference,
                mainThreadMaxGapMs: Math.round(timing.maxGapMs),
                mainThreadP95GapMs: Math.round(timing.p95GapMs),
                fingerprintWorkersLeft: page.workers().filter((w) => w.url().includes('drawing-set-fingerprint')).length,
            };
            results.sizes.push(row);
            console.log(`\n${sizeMiB} MiB: ${row.status}  wall ${wallMs} ms; read+fingerprint ${row.readAndFingerprintMs} ms (${row.mibPerSecond} MiB/s); open ${row.pdfOpenMs} ms`);
            console.log(`  digest ${row.digestMatchesNodeCrypto ? '=' : '!='} node:crypto  ${state.sha}`);
            console.log(`  main thread: longest gap ${row.mainThreadMaxGapMs} ms, p95 ${row.mainThreadP95GapMs} ms over ${timing.ticks} ticks; fingerprint Workers left ${row.fingerprintWorkersLeft}`);
            fs.rmSync(file, { force: true });
        }

        if (withCancel) {
            const sizeMiB = [...sizes].reverse().find((s) => os.freemem() / MiB > s * 4 + 1024) ?? 0;
            if (!sizeMiB) {
                results.cancel = { status: 'RESOURCE_BLOCKED' };
            } else {
                const file = path.join(tmp, `cancel-${sizeMiB}mib.pdf`);
                writeSyntheticPdf(file, sizeMiB * MiB, 0xcafe);
                await open();
                await page.evaluate(() => { window.__dsDelayMs = 100; });
                await (await page.$('[data-ds-file-input]')).uploadFile(file);
                await page.waitForFunction(() => /識別情報の計算 ([1-9]\d)%/.test(document.querySelector('[data-ds-status]')?.textContent ?? ''), { polling: 10, timeout: 120_000 });
                const at = await page.evaluate(() => document.querySelector('[data-ds-status]').textContent);
                const workersDuring = page.workers().filter((w) => w.url().includes('drawing-set-fingerprint')).length;
                await page.click('[data-ds-stop]');
                await page.evaluate(() => { window.__dsDelayMs = 0; });
                await new Promise((r) => setTimeout(r, 3000));
                const after = await page.evaluate(() => ({
                    sources: Number(document.querySelector('[data-ds-root]').dataset.dsSources),
                    results: [...document.querySelectorAll('[data-ds-result]')].map((r) => r.dataset.dsResult),
                    state: document.querySelector('[data-ds-root]').dataset.dsState,
                }));
                const workersAfter = page.workers().filter((w) => w.url().includes('drawing-set-fingerprint')).length;
                results.cancel = {
                    sizeMiB,
                    stoppedAt: at,
                    workersDuring,
                    workersAfter,
                    ...after,
                    status: after.sources === 0 && after.results.join() === 'cancelled' && workersAfter === 0 && after.state === 'idle' ? 'PASS' : 'FAIL',
                };
                console.log(`\ncancel ${sizeMiB} MiB at "${at}": ${results.cancel.status}  sources ${after.sources}, results ${after.results.join()}, fingerprint Workers ${workersDuring} -> ${workersAfter}`);
                fs.rmSync(file, { force: true });
            }
        }

        console.log(`\nexternal HTTP(S) requests: ${results.external.length}`);
        const ok = results.sizes.every((r) => r.status === 'PASS' || r.status === 'RESOURCE_BLOCKED')
            && (!results.cancel || results.cancel.status !== 'FAIL') && results.external.length === 0;
        exitCode = ok ? 0 : 1;
    } catch (error) {
        console.error(`\nBench failed: ${error?.stack ?? error}\n`);
    } finally {
        if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    process.exit(exitCode);
}

main();
