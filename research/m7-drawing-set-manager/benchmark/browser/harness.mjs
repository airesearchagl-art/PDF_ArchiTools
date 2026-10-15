/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The in-page half of the browser measurements. Everything is exposed on
 * `window.m7bench` and called by benchmark/bench-browser.mjs; nothing runs on
 * its own.
 *
 * Whatever is measured on the page's own thread is measured together with a
 * heartbeat: a 4 ms timer whose longest gap is how long the page could not have
 * responded to a person. That is the number "does it block the main thread"
 * means, and it is reported next to every timing.
 */

import { FingerprintCancelled, fingerprintBlobStreaming, toHex } from '../../prototype/sha256-stream.mjs';
import { runScaleMatrix } from '../scale-core.mjs';
import { importProject, exportProject } from '../../prototype/project-io.mjs';
import { buildSyntheticProject } from '../../prototype/synthetic-project.mjs';
import { seededUuidSource, randomUuid } from '../../prototype/ids.mjs';

const input = document.getElementById('files');
const MiB = 1024 * 1024;

/** Run `work` while a heartbeat records the longest time the thread was unavailable. */
async function withHeartbeat(work) {
    let last = performance.now();
    let maxGap = 0;
    let over50 = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        const gap = now - last;
        if (gap > maxGap) maxGap = gap;
        if (gap > 50) over50 += 1;
        last = now;
    }, 4);
    const longTasks = [];
    let observer = null;
    try {
        observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
        observer.observe({ type: 'longtask', buffered: false });
    } catch { /* not supported: the heartbeat is the measurement */ }
    try {
        const result = await work();
        // One more turn so a gap that ended with the work is counted.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { result, mainThread: { maxGapMs: Number(maxGap.toFixed(1)), gapsOver50Ms: over50, longTasks: longTasks.length, longestTaskMs: Number(Math.max(0, ...longTasks).toFixed(1)) } };
    } finally {
        clearInterval(timer);
        observer?.disconnect();
    }
}

const jsHeapMiB = () => (performance.memory ? Number((performance.memory.usedJSHeapSize / MiB).toFixed(1)) : null);

let worker = null;
let nextId = 1;
function ensureWorker() {
    if (!worker) worker = new Worker(new URL('./fingerprint-worker.mjs', import.meta.url), { type: 'module' });
    return worker;
}
function askWorker(message, { cancelAfterMs } = {}) {
    const target = ensureWorker();
    const id = nextId++;
    return new Promise((resolve) => {
        const posted = performance.now();
        let cancelPostedAt = null;
        const onMessage = (event) => {
            if (event.data.id !== id) return;
            target.removeEventListener('message', onMessage);
            resolve({ ...event.data, roundTripMs: performance.now() - posted, cancelLatencyMs: cancelPostedAt === null ? null : performance.now() - cancelPostedAt });
        };
        target.addEventListener('message', onMessage);
        target.postMessage({ ...message, id });
        if (cancelAfterMs !== undefined) {
            setTimeout(() => { cancelPostedAt = performance.now(); target.postMessage({ kind: 'cancel', id }); }, cancelAfterMs);
        }
    });
}

async function fingerprintOne(method, file, chunkBytes) {
    const started = performance.now();
    if (method === 'subtle-main') {
        const buffer = await file.arrayBuffer();
        const read = performance.now();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const done = performance.now();
        return { sha256: toHex(new Uint8Array(digest)), byteLength: buffer.byteLength, readMs: read - started, digestMs: done - read, totalMs: done - started };
    }
    if (method === 'stream-main') {
        const result = await fingerprintBlobStreaming(file, { chunkBytes });
        return { ...result, totalMs: performance.now() - started };
    }
    if (method === 'subtle-worker') return askWorker({ kind: 'hash', method: 'subtle', file });
    if (method === 'stream-worker') return askWorker({ kind: 'hash', method: 'stream', file, chunkBytes });
    if (method === 'byob-worker') return askWorker({ kind: 'hash', method: 'byob', file, chunkBytes });
    throw new Error(`unknown method ${method}`);
}

const round = (value) => (typeof value === 'number' ? Number(value.toFixed(1)) : value);

window.m7bench = {
    ready: true,

    env() {
        return {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemoryGiB: navigator.deviceMemory ?? null,
            origin: location.origin,
            isSecureContext: window.isSecureContext,
            crossOriginIsolated: window.crossOriginIsolated,
            cryptoSubtleDigest: typeof crypto?.subtle?.digest,
            cryptoRandomUUID: typeof crypto?.randomUUID,
            cryptoGetRandomValues: typeof crypto?.getRandomValues,
            worker: typeof Worker,
            blobStream: typeof Blob.prototype.stream,
            blobBytes: typeof Blob.prototype.bytes,
            arrayBufferTransfer: typeof ArrayBuffer.prototype.transfer,
            stringIsWellFormed: typeof String.prototype.isWellFormed,
            performanceMemory: typeof performance.memory,
            measureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory,
            showOpenFilePicker: typeof window.showOpenFilePicker,
        };
    },

    files() {
        return [...input.files].map((file) => ({ name: file.name, size: file.size, lastModified: file.lastModified, type: file.type }));
    },

    /** Fingerprint every selected file, one after another, by one method. */
    async fingerprint(method, { chunkBytes = 4 * MiB } = {}) {
        const files = [...input.files];
        const heapBefore = jsHeapMiB();
        const { result, mainThread } = await withHeartbeat(async () => {
            const started = performance.now();
            const each = [];
            for (const file of files) each.push(await fingerprintOne(method, file, chunkBytes));
            return { each, totalMs: performance.now() - started };
        });
        return {
            method, chunkBytes: method.startsWith('stream') || method.startsWith('byob') ? chunkBytes : null, files: files.length,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            totalMs: round(result.totalMs),
            each: result.each.map((r) => ({ sha256: r.sha256, byteLength: r.byteLength, readMs: round(r.readMs ?? null), digestMs: round(r.digestMs ?? null), totalMs: round(r.totalMs), kind: r.kind ?? null })),
            mainThread, jsHeapMiB: { before: heapBefore, after: jsHeapMiB() },
        };
    },

    /**
     * Which half of the one-shot method keeps the page thread busy: reading the
     * file into memory, or the digest of what was read. Each is run under its
     * own heartbeat.
     */
    async blockingSplit() {
        const [file] = input.files;
        const read = await withHeartbeat(async () => {
            const started = performance.now();
            const buffer = await file.arrayBuffer();
            return { buffer, ms: performance.now() - started };
        });
        const digest = await withHeartbeat(async () => {
            const started = performance.now();
            await crypto.subtle.digest('SHA-256', read.result.buffer);
            return { ms: performance.now() - started };
        });
        return {
            bytes: file.size,
            fileArrayBuffer: { ms: round(read.result.ms), mainThread: read.mainThread },
            subtleDigest: { ms: round(digest.result.ms), mainThread: digest.mainThread },
        };
    },

    /** Start a streaming fingerprint in the Worker and cancel it part-way. */
    async cancelStreaming({ cancelAfterMs, chunkBytes = 4 * MiB }) {
        const [file] = input.files;
        const reply = await askWorker({ kind: 'hash', method: 'stream', file, chunkBytes }, { cancelAfterMs });
        return { outcome: reply.kind, cancelAfterMs, cancelLatencyMs: round(reply.cancelLatencyMs), workerRanMs: round(reply.afterMs ?? reply.totalMs), chunkBytes };
    },

    /** Start a one-shot fingerprint in the Worker and terminate the Worker part-way. */
    async terminateOneShot({ terminateAfterMs }) {
        const [file] = input.files;
        const target = ensureWorker();
        let settled = false;
        const pending = askWorker({ kind: 'hash', method: 'subtle', file }).then((reply) => { settled = true; return reply; });
        await new Promise((resolve) => setTimeout(resolve, terminateAfterMs));
        const before = performance.now();
        target.terminate();
        const terminateCallMs = performance.now() - before;
        worker = null;
        await new Promise((resolve) => setTimeout(resolve, 300));
        void pending;
        // A fresh Worker is usable at once.
        const probeStarted = performance.now();
        const probe = await askWorker({ kind: 'probe' });
        return { settledBeforeTerminate: settled, terminateCallMs: round(terminateCallMs), resultDelivered: settled, freshWorkerReadyMs: round(performance.now() - probeStarted), freshWorkerProbe: probe.kind };
    },

    async workerProbe() {
        const reply = await askWorker({ kind: 'probe' });
        return { isSecureContext: reply.isSecureContext, subtle: reply.subtle, randomUUID: reply.randomUUID, getRandomValues: reply.getRandomValues };
    },

    /** Small facts the architecture leans on, observed rather than assumed. */
    async probes() {
        const out = {};

        // Does Web Crypto take input in pieces?
        try {
            const stream = new Blob([new Uint8Array(8)]).stream();
            await crypto.subtle.digest('SHA-256', stream);
            out.subtleDigestAcceptsStream = true;
        } catch (error) { out.subtleDigestAcceptsStream = false; out.subtleDigestStreamError = error.name; }

        // What is the digest of a buffer that has been transferred away?
        try {
            const buffer = new Uint8Array(1024).fill(7).buffer;
            const before = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
            const channel = new MessageChannel();
            channel.port1.postMessage(buffer, [buffer]);
            const after = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
            out.detachedBuffer = {
                byteLengthAfterTransfer: buffer.byteLength,
                digestBefore: before, digestAfter: after,
                digestAfterIsEmptyDigest: after === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            };
        } catch (error) { out.detachedBuffer = { threw: error.name }; }

        // Does digest() detach or alter the buffer it is given?
        try {
            const buffer = new Uint8Array(4096).fill(9).buffer;
            await crypto.subtle.digest('SHA-256', buffer);
            out.digestLeavesInputUsable = buffer.byteLength === 4096 && new Uint8Array(buffer)[100] === 9;
        } catch (error) { out.digestLeavesInputUsable = `threw ${error.name}`; }

        // Does a File survive structured clone to a Worker without its bytes being read here?
        if (input.files.length > 0) {
            const [file] = input.files;
            const started = performance.now();
            const reply = await askWorker({ kind: 'probe', file });
            out.fileCloneToWorkerMs = round(performance.now() - started);
            out.fileCloneBytes = file.size;
            void reply;
        }

        // A UUID without a secure context.
        const uuid = randomUuid();
        out.uuidFromGetRandomValues = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
        return out;
    },

    /** Read the first selected file again, after the driver has changed it on disk. */
    async rereadFirstFile() {
        const [file] = input.files;
        const out = { name: file.name, sizeReportedByFileObject: file.size, lastModified: file.lastModified };
        try { out.slice = (await file.slice(0, 16).arrayBuffer()).byteLength; } catch (error) { out.sliceError = error.name; }
        try { out.whole = (await file.arrayBuffer()).byteLength; } catch (error) { out.wholeError = error.name; }
        try { const r = await fingerprintBlobStreaming(file, { chunkBytes: MiB }); out.streamed = r.byteLength; } catch (error) { out.streamError = error.name; }
        return out;
    },

    /**
     * The same scale matrix as Node, on this page's thread.
     *
     * No heartbeat here: the matrix is one long synchronous run by design, so
     * "how long was the page unavailable" would only report the matrix's own
     * length. That question is asked per operation by importOnMainThread.
     */
    scale() {
        return runScaleMatrix();
    },

    /** Opening and saving one Project on the page's thread: how long is the page unavailable? */
    async importOnMainThread(sheets) {
        const { model, now } = buildSyntheticProject({ sheets });
        const ids = seededUuidSource(3);
        const exported = exportProject(model, { now, newFileId: ids() });
        const file = new File([exported.bytes], 'synthetic.project.json', { type: 'application/json' });
        const opened = await withHeartbeat(async () => {
            const started = performance.now();
            const bytes = new Uint8Array(await file.arrayBuffer());
            const verdict = importProject(bytes, { now: now + 1 });
            return { status: verdict.status, ms: performance.now() - started, timings: verdict.timings };
        });
        const saved = await withHeartbeat(async () => {
            const started = performance.now();
            const again = exportProject(model, { now, newFileId: ids() });
            return { bytes: again.bytes.length, ms: performance.now() - started };
        });
        return {
            sheets, bytes: exported.bytes.length,
            open: { status: opened.result.status, ms: round(opened.result.ms), stages: Object.fromEntries(Object.entries(opened.result.timings).map(([k, v]) => [k, round(v)])), mainThread: opened.mainThread },
            save: { ms: round(saved.result.ms), mainThread: saved.mainThread },
        };
    },

    /** What JSON.parse alone does with inputs the scan would have refused. */
    parseUnbounded() {
        const head = '{"junk":';
        const cases = {
            'deep nesting, 1,000,000 levels': () => `${head}${'['.repeat(1_000_000)}${']'.repeat(1_000_000)}}`,
            'array of 3,999,990 empty objects': () => `${head}[${'{},'.repeat(3_999_989)}{}]}`,
            'array of 10,000,000 empty objects': () => `${head}[${'{},'.repeat(9_999_999)}{}]}`,
        };
        const out = [];
        for (const [name, make] of Object.entries(cases)) {
            const text = make();
            const before = jsHeapMiB();
            const started = performance.now();
            let outcome = 'parsed';
            let value;
            try { value = JSON.parse(text); } catch (error) { outcome = `${error.name}`; }
            const parseMs = performance.now() - started;
            const after = jsHeapMiB();
            let walk = 'not attempted';
            if (outcome === 'parsed') {
                const visit = (node) => { if (node && typeof node === 'object') for (const item of Array.isArray(node) ? node : Object.values(node)) visit(item); };
                try { visit(value); walk = 'walked'; } catch (error) { walk = error.name; }
            }
            out.push({ input: name, inputMiB: Number((text.length / MiB).toFixed(2)), jsonParse: outcome, parseMs: round(parseMs), jsHeapGrowthMiB: before === null ? null : Number((after - before).toFixed(1)), recursiveWalk: walk });
            value = null;
        }
        return out;
    },

    /**
     * A lower bound on what an un-virtualised Sheet List costs.
     *
     * Plain DOM, no framework: one row per sheet, eight cells. A React list
     * pays this and its own reconciliation on top, so if this is already too
     * slow at a size, virtualisation is needed at that size; if it is fast,
     * that proves nothing about React and says so.
     */
    listDom(sizes) {
        const host = document.getElementById('list');
        const out = [];
        for (const count of sizes) {
            host.replaceChildren();
            void host.offsetHeight;
            const heapBefore = jsHeapMiB();
            const started = performance.now();
            const table = document.createElement('table');
            const body = document.createElement('tbody');
            for (let i = 0; i < count; i += 1) {
                const row = document.createElement('tr');
                const cells = [String(i + 1), `A-${1000 + i}`, `${(i % 9) + 1}階平面図 その${i % 5}`, 'B', '2026.10.05', 'A1', 'confirmed', String(i % 3)];
                for (const text of cells) { const cell = document.createElement('td'); cell.textContent = text; row.appendChild(cell); }
                body.appendChild(row);
            }
            table.appendChild(body);
            host.appendChild(table);
            const built = performance.now();
            const height = host.offsetHeight; // forces style and layout
            const laidOut = performance.now();
            table.classList.add('dense');     // a style change that touches every row
            void host.offsetHeight;
            const restyled = performance.now();
            // Replace one row's text, as an edit to one sheet would.
            body.children[Math.floor(count / 2)].children[2].textContent = 'edited';
            void host.offsetHeight;
            const edited = performance.now();
            out.push({
                rows: count, domNodes: host.getElementsByTagName('*').length, heightPx: height,
                buildMs: round(built - started), layoutMs: round(laidOut - built), restyleAllMs: round(restyled - laidOut), editOneRowMs: round(edited - restyled),
                jsHeapGrowthMiB: heapBefore === null ? null : Number((jsHeapMiB() - heapBefore).toFixed(1)),
            });
        }
        host.replaceChildren();
        return out;
    },

    FingerprintCancelledName: FingerprintCancelled.name,
};
