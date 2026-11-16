/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The browser measurements: source fingerprinting, the scale matrix, and a
 * handful of facts the architecture leans on, all observed in a real Chrome.
 *
 * BROWSER EVIDENCE. Chrome for Testing (the build Puppeteer installed), driven
 * headless on this machine. It is one browser on one machine: nothing here is a
 * claim about Firefox, Safari, a phone, or a machine with less memory.
 *
 * How the numbers are taken:
 *
 *   files     synthetic, generated into the OS temp directory (never the
 *             repository), handed to a real <input type=file> so the page gets
 *             disk-backed File objects exactly as it would from a person. Each
 *             file's SHA-256 is computed here with node:crypto and every digest
 *             the page reports is checked against it.
 *   time      measured in the page, around the operation.
 *   memory    the peak working set and peak commit of the Chrome processes, as
 *             the operating system reports them (Win32_Process). Each case runs
 *             in a FRESH browser, so a process's peak is that case's peak. This
 *             is a direct measurement, not allocation accounting.
 *   blocking  a 4 ms heartbeat on the page's thread; its longest gap.
 *
 * Nothing leaves the machine: the page is served from 127.0.0.1 by the static
 * server below and loads nothing else.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/bench-browser.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(HERE, 'results');
const MiB = 1024 * 1024;
const NEWLINE = String.fromCodePoint(10);
const only = new Set(process.argv.slice(2).filter((a) => a.startsWith('--only=')).flatMap((a) => a.slice(7).split(',')));
const want = (part) => only.size === 0 || only.has(part);

// -- static server ----------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const file = path.normalize(path.join(ROOT, requested));
    // Only files under the research directory, and only the types above.
    if (!file.startsWith(ROOT + path.sep) || !MIME[path.extname(file)] || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const PAGE_PATH = '/benchmark/browser/index.html';

// -- synthetic files --------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-fingerprint-bench-'));
const made = new Map();

/** A file of pseudo-random bytes and its SHA-256, generated once per (name). */
function syntheticFile(name, bytes, seed) {
    if (made.has(name)) return made.get(name);
    const file = path.join(TMP, name);
    const hash = createHash('sha256');
    const block = new Uint32Array(MiB / 4);
    const view = new Uint8Array(block.buffer);
    let state = (seed >>> 0) || 1;
    const fd = fs.openSync(file, 'w');
    for (let written = 0; written < bytes; written += MiB) {
        for (let i = 0; i < block.length; i += 1) {
            state ^= state << 13; state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5; state >>>= 0;
            block[i] = state;
        }
        const chunk = view.subarray(0, Math.min(MiB, bytes - written));
        hash.update(chunk);
        fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
    const entry = { path: file, bytes, sha256: hash.digest('hex') };
    made.set(name, entry);
    return entry;
}

// -- Chrome -----------------------------------------------------------------

const BASE_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--enable-precise-memory-info'];

async function withPage(run, { origin = `http://127.0.0.1:${PORT}`, extraArgs = [] } = {}) {
    const browser = await puppeteer.launch({ headless: true, args: [...BASE_ARGS, ...extraArgs], protocolTimeout: 0 });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 200)));
        await page.goto(`${origin}${PAGE_PATH}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.m7bench?.ready === true);
        const result = await run(page, browser);
        if (errors.length > 0) throw new Error(`page errors: ${errors.join(' | ')}`);
        return result;
    } finally {
        await browser.close();
    }
}

async function select(page, files) {
    const handle = await page.$('#files');
    await handle.uploadFile(...files.map((f) => f.path));
    await page.waitForFunction((count) => document.getElementById('files').files.length === count, {}, files.length);
}

/** Peak memory of this browser's processes, from the operating system. */
function chromeMemory(browser) {
    const pid = browser.process().pid;
    const script = [
        "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\"",
        '$p | Select-Object ProcessId,ParentProcessId,CommandLine,PeakWorkingSetSize,WorkingSetSize,PeakPageFileUsage | ConvertTo-Json -Compress',
    ].join('; ');
    // -EncodedCommand takes UTF-16LE base64, which sidesteps every quoting rule between here and PowerShell.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', maxBuffer: 32 * MiB });
    if (out.status !== 0) return { error: 'os query failed' };
    const all = JSON.parse(out.stdout);
    const mine = (Array.isArray(all) ? all : [all]).filter((p) => p.ProcessId === pid || p.ParentProcessId === pid);
    const typed = mine.map((p) => ({
        type: p.ProcessId === pid ? 'browser' : (/--type=([a-z-]+)/.exec(p.CommandLine ?? '')?.[1] ?? 'unknown'),
        // Win32_Process reports the two peaks in kilobytes.
        peakWorkingSetMiB: Number((p.PeakWorkingSetSize / 1024).toFixed(1)),
        peakCommitMiB: Number((p.PeakPageFileUsage / 1024).toFixed(1)),
    }));
    const renderers = typed.filter((p) => p.type === 'renderer').sort((a, b) => b.peakWorkingSetMiB - a.peakWorkingSetMiB);
    const browserProcess = typed.find((p) => p.type === 'browser');
    return {
        // The page's renderer is the one that did the work: the largest.
        rendererPeakWorkingSetMiB: renderers[0]?.peakWorkingSetMiB ?? null,
        rendererPeakCommitMiB: renderers[0]?.peakCommitMiB ?? null,
        browserProcessPeakWorkingSetMiB: browserProcess?.peakWorkingSetMiB ?? null,
        allProcessesPeakWorkingSetSumMiB: Number(typed.reduce((sum, p) => sum + p.peakWorkingSetMiB, 0).toFixed(1)),
        processes: typed.length,
    };
}

const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const summarise = (runs) => ({
    medianMs: Number(median(runs.map((r) => r.totalMs)).toFixed(1)),
    minMs: Math.min(...runs.map((r) => r.totalMs)), maxMs: Math.max(...runs.map((r) => r.totalMs)),
    runs: runs.length,
    MiBPerSecond: Number(((runs[0].totalBytes / MiB) / (median(runs.map((r) => r.totalMs)) / 1000)).toFixed(0)),
    maxMainThreadGapMs: Math.max(...runs.map((r) => r.mainThread.maxGapMs)),
    longestTaskMs: Math.max(...runs.map((r) => r.mainThread.longestTaskMs)),
    rendererPeakWorkingSetMiB: Math.max(...runs.map((r) => r.memory.rendererPeakWorkingSetMiB ?? 0)),
    rendererPeakCommitMiB: Math.max(...runs.map((r) => r.memory.rendererPeakCommitMiB ?? 0)),
    browserProcessPeakWorkingSetMiB: Math.max(...runs.map((r) => r.memory.browserProcessPeakWorkingSetMiB ?? 0)),
    allProcessesPeakWorkingSetSumMiB: Math.max(...runs.map((r) => r.memory.allProcessesPeakWorkingSetSumMiB ?? 0)),
});

/** One fingerprint case in a fresh browser: time, blocking, memory, and a correctness check. */
async function fingerprintCase(files, method, options = {}) {
    return withPage(async (page, browser) => {
        await select(page, files);
        const result = await page.evaluate((m, o) => window.m7bench.fingerprint(m, o), method, options);
        result.each.forEach((each, i) => {
            if (each.sha256 !== files[i].sha256 || each.byteLength !== files[i].bytes) {
                throw new Error(`${method}: wrong digest for file ${i} (${each.sha256} / ${each.byteLength})`);
            }
        });
        const memory = chromeMemory(browser);
        return { ...result, memory, digestsVerified: result.each.length };
    });
}

const freeMemoryGiB = () => Number((os.freemem() / 2 ** 30).toFixed(1));
const report = { fingerprint: null, scale: null, probes: null };
const startedAt = new Date().toISOString();

try {
    const environment = await withPage(async (page, browser) => ({ ...(await page.evaluate(() => window.m7bench.env())), browserVersion: await browser.version() }));
    const machine = {
        platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
        totalMemoryGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), freeMemoryGiBAtStart: freeMemoryGiB(), node: process.version,
    };
    console.log(`${environment.browserVersion} | secure context: ${environment.isSecureContext} | free memory ${machine.freeMemoryGiBAtStart} GiB`);

    // ======================================================================
    if (want('fingerprint')) {
        // The single-buffer methods hold a whole file in memory. Do not start
        // the large ones on a machine that cannot afford them.
        if (os.freemem() < 2 * 2 ** 30) throw new Error(`only ${freeMemoryGiB()} GiB free; not running the 250 MiB cases`);

        const SIZES = [1, 10, 50, 100, 250];
        const METHODS = ['subtle-main', 'subtle-worker', 'stream-worker', 'stream-main'];
        const RUNS = 3;
        const single = SIZES.map((size, i) => ({ size, file: syntheticFile(`single-${size}MiB.bin`, size * MiB, 1000 + i) }));

        // Baseline: a page with the largest file selected and nothing done to it.
        const baseline = await withPage(async (page, browser) => {
            await select(page, [single.at(-1).file]);
            await new Promise((resolve) => setTimeout(resolve, 500));
            return chromeMemory(browser);
        });
        console.log(`baseline (250 MiB file selected, not read): renderer peak ${baseline.rendererPeakWorkingSetMiB} MiB working set`);

        const singleRows = [];
        for (const { size, file } of single) {
            for (const method of METHODS) {
                const runs = [];
                for (let i = 0; i < RUNS; i += 1) runs.push(await fingerprintCase([file], method));
                const row = { sizeMiB: size, method, ...summarise(runs), readMs: runs[0].each[0].readMs, digestMs: runs[0].each[0].digestMs };
                singleRows.push(row);
                console.log(`single ${String(size).padStart(3)} MiB  ${method.padEnd(14)} ${String(row.medianMs).padStart(8)} ms  ${String(row.MiBPerSecond).padStart(5)} MiB/s  main gap ${String(row.maxMainThreadGapMs).padStart(6)} ms  renderer peak ${String(row.rendererPeakWorkingSetMiB).padStart(6)} MiB (commit ${row.rendererPeakCommitMiB})`);
            }
        }

        // Chunk size for the streaming method, chosen by measurement.
        const chunkRows = [];
        const hundred = single.find((s) => s.size === 100).file;
        for (const chunkKiB of [64, 256, 1024, 4096, 16384]) {
            const runs = [];
            for (let i = 0; i < RUNS; i += 1) runs.push(await fingerprintCase([hundred], 'stream-worker', { chunkBytes: chunkKiB * 1024 }));
            const row = { sizeMiB: 100, method: 'stream-worker', chunkKiB, ...summarise(runs) };
            chunkRows.push(row);
            console.log(`chunk ${String(chunkKiB).padStart(6)} KiB  ${String(row.medianMs).padStart(8)} ms  ${String(row.MiBPerSecond).padStart(5)} MiB/s  renderer peak ${row.rendererPeakWorkingSetMiB} MiB`);
        }

        // Several sources, strictly one after another.
        const multiRows = [];
        for (const [count, size] of [[10, 10], [20, 25]]) {
            const files = Array.from({ length: count }, (_, i) => syntheticFile(`multi-${count}x${size}MiB-${i}.bin`, size * MiB, 5000 + count * 100 + i));
            for (const method of ['subtle-main', 'subtle-worker', 'stream-worker']) {
                const runs = [];
                for (let i = 0; i < 2; i += 1) runs.push(await fingerprintCase(files, method));
                const row = { files: count, eachMiB: size, totalMiB: count * size, method, ...summarise(runs) };
                multiRows.push(row);
                console.log(`multi ${count} x ${size} MiB  ${method.padEnd(14)} ${String(row.medianMs).padStart(8)} ms  ${String(row.MiBPerSecond).padStart(5)} MiB/s  main gap ${row.maxMainThreadGapMs} ms  renderer peak ${row.rendererPeakWorkingSetMiB} MiB (commit ${row.rendererPeakCommitMiB})`);
            }
        }

        // Cancellation.
        const big = single.at(-1).file;
        const cancelRuns = [];
        for (const chunkKiB of [1024, 4096, 16384]) {
            for (let i = 0; i < 3; i += 1) {
                cancelRuns.push(await withPage(async (page) => {
                    await select(page, [big]);
                    return page.evaluate((o) => window.m7bench.cancelStreaming(o), { cancelAfterMs: 150, chunkBytes: chunkKiB * 1024 });
                }));
            }
        }
        const terminate = await withPage(async (page) => {
            await select(page, [big]);
            return page.evaluate((o) => window.m7bench.terminateOneShot(o), { terminateAfterMs: 30 });
        });
        console.log(`cancel streaming: ${JSON.stringify(cancelRuns.map((r) => [r.chunkBytes / 1024, r.outcome, r.cancelLatencyMs]))}`);
        console.log(`terminate one-shot: ${JSON.stringify(terminate)}`);

        report.fingerprint = {
            notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic files. BROWSER evidence (Chrome for Testing, headless) -- not a Node measurement.',
            runtime: 'browser', startedAt, environment, machine,
            method: {
                files: 'pseudo-random bytes written to the OS temp directory, selected through a real <input type=file>; freshly written, so the OS file cache is warm and read times are a best case',
                memory: 'peak working set / peak commit of the Chrome processes from Win32_Process, one fresh browser per run; a direct OS measurement',
                time: 'in-page performance.now() around the whole operation; median of the runs',
                blocking: 'longest gap of a 4 ms heartbeat on the page thread during the operation',
                correctness: 'every digest reported by the page was compared with node:crypto over the same file',
            },
            methods: {
                'subtle-main': 'page thread: file.arrayBuffer() then crypto.subtle.digest()',
                'subtle-worker': 'dedicated Worker: file.arrayBuffer() then crypto.subtle.digest()',
                'stream-worker': 'dedicated Worker: blob.slice() chunks into the incremental JS SHA-256',
                'stream-main': 'page thread: blob.slice() chunks into the incremental JS SHA-256',
            },
            baselineLargestFileSelectedNotRead: baseline,
            singleFile: singleRows, chunkSize: chunkRows, multiFileSequential: multiRows,
            cancellation: { streamingCancelledAfter150Ms: cancelRuns, oneShotWorkerTerminatedAfter30Ms: terminate },
        };
        fs.mkdirSync(RESULTS, { recursive: true });
        fs.writeFileSync(path.join(RESULTS, 'fingerprint-browser.json'), `${JSON.stringify(report.fingerprint, null, 2)}\n`);
    }

    // ======================================================================
    if (want('extra')) {
        if (os.freemem() < 2 * 2 ** 30) throw new Error(`only ${freeMemoryGiB()} GiB free; not running the 250 MiB cases`);
        const rows = [];
        for (const [index, size] of [10, 100, 250].entries()) {
            const file = syntheticFile(`extra-${size}MiB.bin`, size * MiB, 3000 + index);
            for (const method of ['stream-worker', 'byob-worker']) {
                const runs = [];
                for (let i = 0; i < 3; i += 1) runs.push(await fingerprintCase([file], method));
                const row = { sizeMiB: size, method, ...summarise(runs) };
                rows.push(row);
                console.log(`extra ${String(size).padStart(3)} MiB  ${method.padEnd(14)} ${String(row.medianMs).padStart(8)} ms  ${String(row.MiBPerSecond).padStart(5)} MiB/s  renderer peak ${String(row.rendererPeakWorkingSetMiB).padStart(6)} MiB (commit ${row.rendererPeakCommitMiB})`);
            }
        }
        const many = Array.from({ length: 20 }, (_, i) => syntheticFile(`extra-multi-${i}.bin`, 25 * MiB, 3500 + i));
        const multi = [];
        for (const method of ['stream-worker', 'byob-worker']) {
            const runs = [];
            for (let i = 0; i < 2; i += 1) runs.push(await fingerprintCase(many, method));
            const row = { files: 20, eachMiB: 25, totalMiB: 500, method, ...summarise(runs) };
            multi.push(row);
            console.log(`extra multi 20 x 25 MiB  ${method.padEnd(14)} ${String(row.medianMs).padStart(8)} ms  ${String(row.MiBPerSecond).padStart(5)} MiB/s  renderer peak ${row.rendererPeakWorkingSetMiB} MiB (commit ${row.rendererPeakCommitMiB})`);
        }
        const split = [];
        for (const size of [100, 250]) {
            const file = syntheticFile(`extra-${size}MiB.bin`, size * MiB, 0);
            for (let i = 0; i < 3; i += 1) {
                split.push(await withPage(async (page) => {
                    await select(page, [file]);
                    return { sizeMiB: size, ...(await page.evaluate(() => window.m7bench.blockingSplit())) };
                }));
            }
        }
        console.log(`blocking split: ${JSON.stringify(split.map((r) => [r.sizeMiB, 'read', r.fileArrayBuffer.ms, r.fileArrayBuffer.mainThread.maxGapMs, 'digest', r.subtleDigest.ms, r.subtleDigest.mainThread.maxGapMs]))}`);
        const extra = {
            notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic files. BROWSER evidence (Chrome for Testing, headless) -- not a Node measurement.',
            runtime: 'browser', startedAt, environment, machine,
            methods: {
                'stream-worker': 'dedicated Worker: blob.slice() chunks (a new ArrayBuffer per chunk) into the incremental JS SHA-256',
                'byob-worker': 'dedicated Worker: file.stream() BYOB reader refilling ONE 4 MiB buffer, into the incremental JS SHA-256',
            },
            singleFile: rows, multiFileSequential: multi,
            oneShotPageThreadSplit: { note: 'file.arrayBuffer() and crypto.subtle.digest() on the page thread, each under its own heartbeat', runs: split },
        };
        fs.mkdirSync(RESULTS, { recursive: true });
        fs.writeFileSync(path.join(RESULTS, 'fingerprint-browser-extra.json'), `${JSON.stringify(extra, null, 2)}${NEWLINE}`);
    }

    // ======================================================================
    if (want('probes')) {
        const ten = syntheticFile('probe-10MiB.bin', 10 * MiB, 77);
        const secure = await withPage(async (page) => {
            await select(page, [ten]);
            return { env: await page.evaluate(() => window.m7bench.env()), worker: await page.evaluate(() => window.m7bench.workerProbe()), facts: await page.evaluate(() => window.m7bench.probes()) };
        });

        // The same page from an origin that is not localhost and not HTTPS: what
        // the app gets when it is served over plain HTTP on a LAN.
        const insecure = await withPage(async (page) => {
            await select(page, [ten]);
            const env = await page.evaluate(() => window.m7bench.env());
            const worker = await page.evaluate(() => window.m7bench.workerProbe());
            const attempt = async (method) => {
                try {
                    const r = await page.evaluate((m) => window.m7bench.fingerprint(m), method);
                    return { ok: r.each[0].sha256 === ten.sha256, workerReply: r.each[0].kind, totalMs: r.totalMs };
                } catch (error) { return { ok: false, error: String(error.message).split('\n')[0].slice(0, 160) }; }
            };
            return { env, worker, fingerprint: { 'subtle-main': await attempt('subtle-main'), 'subtle-worker': await attempt('subtle-worker'), 'stream-worker': await attempt('stream-worker'), 'stream-main': await attempt('stream-main') } };
        }, { origin: `http://insecure.test:${PORT}`, extraArgs: [`--host-resolver-rules=MAP insecure.test 127.0.0.1`] });

        // A file that changes on disk after it was selected.
        const changed = {};
        for (const [name, mutate] of [['appended', (p) => fs.appendFileSync(p, Buffer.alloc(4096, 1))], ['overwritten same size', (p) => { const fd = fs.openSync(p, 'r+'); fs.writeSync(fd, Buffer.alloc(4096, 2), 0, 4096, 0); fs.closeSync(fd); }], ['deleted', (p) => fs.rmSync(p)]]) {
            const copy = path.join(TMP, `mutable-${name.replace(/ /g, '-')}.bin`);
            fs.copyFileSync(syntheticFile('probe-1MiB.bin', MiB, 78).path, copy);
            // Let the file's timestamp settle, so the change below is a later one.
            const past = new Date(Date.now() - 60_000);
            fs.utimesSync(copy, past, past);
            changed[name] = await withPage(async (page) => {
                await select(page, [{ path: copy }]);
                const before = await page.evaluate(() => window.m7bench.files());
                mutate(copy);
                return { selected: before[0], afterChange: await page.evaluate(() => window.m7bench.rereadFirstFile()) };
            });
        }

        const parse = await withPage(async (page) => page.evaluate(() => window.m7bench.parseUnbounded()));
        const mainThread = await withPage(async (page) => {
            const rows = [];
            for (const sheets of [200, 1000, 5000]) rows.push(await page.evaluate((n) => window.m7bench.importOnMainThread(n), sheets));
            return rows;
        });
        const list = await withPage(async (page) => page.evaluate(() => window.m7bench.listDom([50, 200, 500, 1000, 5000, 20000])));

        report.probes = {
            notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. BROWSER evidence (Chrome for Testing, headless).',
            runtime: 'browser', startedAt, browserVersion: environment.browserVersion,
            secureContext: secure,
            insecureContext: { how: 'same page and server, reached as http://insecure.test:<port> via --host-resolver-rules, so the origin is neither localhost nor HTTPS', ...insecure },
            fileChangedOnDiskAfterSelection: changed,
            jsonParseWithoutBounds: parse,
            projectOpenAndSaveOnPageThread: mainThread,
            sheetListPlainDomLowerBound: { note: 'plain DOM, no framework, 8 cells per row, nothing virtualised; a lower bound on an un-virtualised list', rows: list },
        };
        fs.mkdirSync(RESULTS, { recursive: true });
        fs.writeFileSync(path.join(RESULTS, 'browser-probes.json'), `${JSON.stringify(report.probes, null, 2)}\n`);
        console.log(`insecure context: subtle=${insecure.env.cryptoSubtleDigest} randomUUID=${insecure.env.cryptoRandomUUID} getRandomValues=${insecure.env.cryptoGetRandomValues} | ${JSON.stringify(insecure.fingerprint)}`);
        console.log(`file changed on disk: ${JSON.stringify(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.afterChange])))}`);
        console.log(`facts: ${JSON.stringify(secure.facts)}`);
        console.log(`open/save on page thread: ${JSON.stringify(mainThread.map((r) => [r.sheets, r.open.ms, r.open.mainThread.maxGapMs, r.save.ms]))}`);
        console.log(`list: ${JSON.stringify(list.map((r) => [r.rows, r.buildMs, r.layoutMs, r.restyleAllMs]))}`);
        console.log(`parse without bounds: ${JSON.stringify(parse)}`);
    }

    // ======================================================================
    if (want('scale')) {
        const scale = await withPage(async (page) => page.evaluate(() => window.m7bench.scale()));
        report.scale = {
            notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic data. BROWSER evidence (Chrome for Testing, headless), page thread.',
            runtime: 'browser', startedAt, environment, machine,
            units: 'milliseconds; each figure is the median of `repeats` runs after one discarded warm-up',
            ...scale,
        };
        fs.mkdirSync(RESULTS, { recursive: true });
        fs.writeFileSync(path.join(RESULTS, 'scale-browser.json'), `${JSON.stringify(report.scale, null, 2)}\n`);
        for (const row of scale.rows) {
            console.log(`${row.label.padEnd(44)} ${String(row.size.compactBytes).padStart(10)}  save ${String(row.save.exportTotal.medianMs).padStart(7)}  open ${String(row.open.importTotal.medianMs).padStart(7)}  QA ${String(row.qa.evaluateAllRules.medianMs).padStart(7)}  sort ${String(row.list.sortByNumber.medianMs).padStart(6)}  stale ${String(row.stale.currencyOfEverything.medianMs).padStart(6)}`);
        }
    }
} finally {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`temp files removed: ${!fs.existsSync(TMP)}`);
}
