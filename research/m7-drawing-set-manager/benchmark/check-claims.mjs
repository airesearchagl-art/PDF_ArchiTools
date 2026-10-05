/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Holds the documents to the measurements.
 *
 * The prose rounds: "about 0.9 s", "≈ 570 MiB". Times and memory move from run
 * to run, so a rounded figure written after one run can quietly stop being true
 * of the run that is committed beside it. This is the check that it has not.
 *
 * Every figure the documents quote from a benchmark is listed here twice over:
 *
 *   quote   the exact words in the document. They must still be there, so a
 *           sentence cannot be edited away from its check.
 *   checks  the fields of the committed result files those words are about,
 *           each with the range the words allow. "≈ X" allows X ± 25 %; a
 *           stated range or bound allows what it states.
 *
 * It writes results/CLAIMS.md and exits non-zero if any quote is missing or any
 * value is outside its range. collect-evidence.mjs runs it on the second pass.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/check-claims.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(HERE, 'results');
const load = (name) => JSON.parse(fs.readFileSync(path.join(RESULTS, name), 'utf8'));
const docs = new Map();
const doc = (name) => { if (!docs.has(name)) docs.set(name, fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ')); return docs.get(name); };

const fp = load('fingerprint-browser.json');
const extra = load('fingerprint-browser-extra.json');
const fpNode = load('fingerprint-node.json');
const probes = load('browser-probes.json');
const scaleNode = load('scale-node.json');
const scaleBrowser = load('scale-browser.json');
const hostile = load('hostile-node.json');

// -- lookups ----------------------------------------------------------------
const single = (size, method) => fp.singleFile.find((r) => r.sizeMiB === size && r.method === method);
const multi = (files, method) => [...fp.multiFileSequential, ...extra.multiFileSequential].find((r) => r.files === files && r.method === method);
const byob = (size) => extra.singleFile.find((r) => r.sizeMiB === size && r.method === 'byob-worker');
const chunk = (kib) => fp.chunkSize.find((r) => r.chunkKiB === kib);
const split = (size) => extra.oneShotPageThreadSplit.runs.filter((r) => r.sizeMiB === size);
const cancel = (kib) => fp.cancellation.streamingCancelledAfter150Ms.filter((r) => r.chunkBytes === kib * 1024).map((r) => r.cancelLatencyMs);
const nodeFp = (size) => fpNode.rows.find((r) => r.sizeMiB === size);
const row = (report, label) => report.rows.find((r) => r.label === label);
const hostileCase = (prefix) => hostile.hostile.find((c) => c.input.startsWith(prefix));
const parseBrowser = (prefix) => probes.jsonParseWithoutBounds.find((r) => r.input.startsWith(prefix));
const list = (rows) => probes.sheetListPlainDomLowerBound.rows.find((r) => r.rows === rows);
const pageThread = (sheets) => probes.projectOpenAndSaveOnPageThread.find((r) => r.sheets === sheets);
const baseline = fp.baselineLargestFileSelectedNotRead.rendererPeakWorkingSetMiB;

// -- ranges -----------------------------------------------------------------
/** "≈ x": within 25 %, or within `floor` of it for values too small for a ratio to mean much. */
const near = (x, floor = 0) => ({ min: Math.min(x * 0.75, x - floor), max: Math.max(x * 1.25, x + floor) });
const between = (min, max) => ({ min, max });
const under = (max) => ({ min: 0, max });
const c = (label, value, range) => ({ label, value, ...range });
const all = (label, values, range) => values.map((value, i) => c(`${label} [${i + 1}]`, value, range));

const A = 'architecture-research.md';
const S5 = '5000 sheets';
const S5P = '5000 sheets, one PDF per sheet';
const S5U = '5000 sheets, nothing confirmed or decided';
const S5R = '5000 sheets, with a declared register';
const S20 = '20000 sheets (beyond candidate limit)';
const b = (label) => row(scaleBrowser, label);
const fastestOneShot = (get) => Math.min(get('subtle-main'), get('subtle-worker'));

const CLAIMS = [
    // ---- R1, browser ------------------------------------------------------
    { doc: A, quote: 'baseline (file selected, nothing read) ≈ 66 MiB', checks: [c('baseline renderer peak MiB', baseline, near(66))] },
    { doc: A, quote: '| Elapsed | ≈ 0.9 s | ≈ 0.9 s | ≈ 1.15 s | ≈ 1.0 s |', checks: [
        c('subtle-main 250 MiB ms', single(250, 'subtle-main').medianMs, near(900)),
        c('subtle-worker 250 MiB ms', single(250, 'subtle-worker').medianMs, near(900)),
        c('stream-worker 250 MiB ms', single(250, 'stream-worker').medianMs, near(1150)),
        c('byob-worker 250 MiB ms', byob(250).medianMs, near(1000)),
    ] },
    { doc: A, quote: '| Longest time the page thread was unavailable | **≈ 0.8 s** | under 30 ms | under 15 ms | under 15 ms |', checks: [
        c('subtle-main gap ms', single(250, 'subtle-main').maxMainThreadGapMs, near(800)),
        c('subtle-worker gap ms', single(250, 'subtle-worker').maxMainThreadGapMs, under(30)),
        c('stream-worker gap ms', single(250, 'stream-worker').maxMainThreadGapMs, under(15)),
        c('byob-worker gap ms', byob(250).maxMainThreadGapMs, under(15)),
    ] },
    { doc: A, quote: '| Renderer peak working set | ≈ 570 MiB | ≈ 570 MiB | ≈ 160 MiB | **≈ 87 MiB** |', checks: [
        c('subtle-main peak MiB', single(250, 'subtle-main').rendererPeakWorkingSetMiB, near(570)),
        c('subtle-worker peak MiB', single(250, 'subtle-worker').rendererPeakWorkingSetMiB, near(570)),
        c('stream-worker peak MiB', single(250, 'stream-worker').rendererPeakWorkingSetMiB, near(160)),
        c('byob-worker peak MiB', byob(250).rendererPeakWorkingSetMiB, near(87)),
    ] },
    { doc: A, quote: 'between chunks (under 60 ms)', checks: all('cancel latency at 4 MiB ms', cancel(4096), under(60)) },
    { doc: A, quote: 'the renderer peaked about 500 MiB above baseline', checks: [c('subtle-main peak above baseline MiB', single(250, 'subtle-main').rendererPeakWorkingSetMiB - baseline, near(500))] },
    { doc: A, quote: 'reading 250 MiB took 0.1–0.25 s and left the thread free (≈ 5 ms gaps); the digest took ≈ 0.75 s and **the thread was unavailable for all of it**', checks: [
        ...all('read 250 MiB ms', split(250).map((r) => r.fileArrayBuffer.ms), between(100, 250)),
        ...all('gap during read ms', split(250).map((r) => r.fileArrayBuffer.mainThread.maxGapMs), under(15)),
        ...all('digest 250 MiB ms', split(250).map((r) => r.subtleDigest.ms), near(750)),
        ...all('gap during digest / digest time', split(250).map((r) => r.subtleDigest.mainThread.maxGapMs / r.subtleDigest.ms), between(0.95, 1.05)),
        ...all('gap during digest / digest time, 100 MiB', split(100).map((r) => r.subtleDigest.mainThread.maxGapMs / r.subtleDigest.ms), between(0.95, 1.05)),
    ] },
    { doc: A, quote: 'End to end it ran at ≈ 270 MiB/s; the JavaScript hash refilling one buffer ran at ≈ 250 MiB/s', checks: [
        c('subtle-main 250 MiB/s', single(250, 'subtle-main').MiBPerSecond, near(270)),
        c('subtle-worker 250 MiB/s', single(250, 'subtle-worker').MiBPerSecond, near(270)),
        c('subtle-worker 20x25 MiB/s', multi(20, 'subtle-worker').MiBPerSecond, near(270)),
        c('byob 250 MiB/s', byob(250).MiBPerSecond, near(250)),
        c('byob 100 MiB/s', byob(100).MiBPerSecond, near(250)),
        c('byob 20x25 MiB/s', multi(20, 'byob-worker').MiBPerSecond, near(250)),
    ] },
    { doc: A, quote: 'OpenSSL does ≈ 2 000 MiB/s and the JavaScript hash ≈ 290 MiB/s', checks: [
        c('node native stream 250 MiB/s', nodeFp(250).nativeStream.MiBPerSecond, near(2000)),
        c('node webcrypto 250 MiB/s', nodeFp(250).webcryptoOneShot.MiBPerSecond, near(2000)),
        c('node JS incremental 250 MiB/s', nodeFp(250).jsIncrementalInMemory.MiBPerSecond, near(290)),
        c('node JS incremental 100 MiB/s', nodeFp(100).jsIncrementalInMemory.MiBPerSecond, near(290)),
    ] },
    { doc: A, quote: '`subtle-main` peaked at ≈ 395 MiB and `subtle-worker` at ≈ 299 MiB', checks: [
        c('20x25 subtle-main peak MiB', multi(20, 'subtle-main').rendererPeakWorkingSetMiB, near(395)),
        c('20x25 subtle-worker peak MiB', multi(20, 'subtle-worker').rendererPeakWorkingSetMiB, near(299)),
    ] },
    { doc: A, quote: 'against ≈ 158 MiB for sliced streaming and **≈ 120 MiB with one reused buffer**', checks: [
        c('20x25 stream-worker peak MiB', multi(20, 'stream-worker').rendererPeakWorkingSetMiB, near(158)),
        c('20x25 byob-worker peak MiB', multi(20, 'byob-worker').rendererPeakWorkingSetMiB, near(120)),
    ] },
    { doc: A, quote: '64 KiB ≈ 85 MiB/s, 1 MiB ≈ 186, 4 MiB ≈ 215, 16 MiB ≈ 230; a cancellation took effect in under 20 ms, under 60 ms and under 200 ms at 1, 4 and 16 MiB', checks: [
        c('64 KiB MiB/s', chunk(64).MiBPerSecond, near(85)), c('1 MiB MiB/s', chunk(1024).MiBPerSecond, near(186)),
        c('4 MiB MiB/s', chunk(4096).MiBPerSecond, near(215)), c('16 MiB MiB/s', chunk(16384).MiBPerSecond, near(230)),
        ...all('cancel at 1 MiB ms', cancel(1024), under(20)), ...all('cancel at 4 MiB ms', cancel(4096), under(60)),
        ...all('cancel at 16 MiB ms', cancel(16384), under(200)),
    ] },
    { doc: A, quote: '10 MiB `File`: under 2 ms', checks: [c('File clone to Worker ms', probes.secureContext.facts.fileCloneToWorkerMs, under(2))] },
    { doc: A, quote: 'under 25 % of elapsed time with one reused buffer and 10–40 % on the slice fallback', checks: [
        c('byob vs fastest one-shot, 250 MiB', byob(250).medianMs / fastestOneShot((m) => single(250, m).medianMs) - 1, between(-0.25, 0.25)),
        c('byob vs fastest one-shot, 20x25', multi(20, 'byob-worker').medianMs / fastestOneShot((m) => multi(20, m).medianMs) - 1, between(-0.25, 0.25)),
        c('slices vs fastest one-shot, 250 MiB', single(250, 'stream-worker').medianMs / fastestOneShot((m) => single(250, m).medianMs) - 1, between(0.1, 0.4)),
        c('slices vs fastest one-shot, 20x25', multi(20, 'stream-worker').medianMs / fastestOneShot((m) => multi(20, m).medianMs) - 1, between(0.1, 0.4)),
    ] },
    { doc: A, quote: 'Expected cost ≈ 4 ms per MiB', checks: [
        c('byob ms per MiB, 250 MiB', byob(250).medianMs / 250, near(4)), c('byob ms per MiB, 20x25', multi(20, 'byob-worker').medianMs / 500, near(4)),
    ] },
    { doc: A, quote: 'costs a fresh Worker under 20 ms', checks: [c('fresh Worker ms', fp.cancellation.oneShotWorkerTerminatedAfter30Ms.freshWorkerReadyMs, under(20))] },

    // ---- R3 / R4 ----------------------------------------------------------
    { doc: A, quote: '≈ 1.55× larger (≈ 13.5 vs 8.8 MiB at 5000 sheets)', checks: [
        c('indented / compact', b(S5).size.prettyBytes / b(S5).size.compactBytes, between(1.5, 1.6)),
        c('indented MiB', b(S5).size.prettyBytes / 2 ** 20, near(13.5)), c('compact MiB', b(S5).size.compactBytes / 2 ** 20, near(8.8)),
    ] },
    { doc: A, quote: '≈ 640 MiB of heap in Node and ≈ 320 MiB in Chrome and took ≈ 1.5 s; the scan refuses it in ≈ 0.1 s', checks: [
        c('10M objects, Node heap MiB', hostileCase('array of 10,000,000').unbounded.retainedHeapMiB, near(640)),
        c('10M objects, Chrome heap MiB', parseBrowser('array of 10,000,000').jsHeapGrowthMiB, near(320)),
        c('10M objects, Node parse ms', hostileCase('array of 10,000,000').unbounded.parseMs, near(1500)),
        c('10M objects, Chrome parse ms', parseBrowser('array of 10,000,000').parseMs, near(1500)),
        c('10M objects, bounded refusal ms', hostileCase('array of 10,000,000').bounded.refusedInMs, near(100, 60)),
    ] },
    { doc: A, quote: 'a million levels of nesting (≈ 0.1 s)', checks: [
        c('deep nesting, Node parse ms', hostileCase('deep nesting').unbounded.parseMs, near(100, 40)),
        c('deep nesting, Chrome parse ms', parseBrowser('deep nesting').parseMs, near(100, 40)),
        c('deep nesting, bounded refusal ms', hostileCase('deep nesting').bounded.refusedInMs, under(5)),
    ] },
    { doc: A, quote: 'A valid 62.5 MiB file opened in ≈ 0.2 s (Node)', checks: [c('largest accepted open ms', hostile.largestAccepted.at(-1).importMs, near(215))] },
    { doc: A, quote: '≈ 8.8–10.4 MiB at 5000 sheets', checks: [
        c('5000 sheets MiB', b(S5).size.compactBytes / 2 ** 20, between(8.7, 8.9)), c('5000 one-per-sheet MiB', b(S5P).size.compactBytes / 2 ** 20, between(10.3, 10.5)),
    ] },
    { doc: A, quote: '≈ 338 000–397 000 at 5000 sheets', checks: [
        c('5000 sheets JSON values', b(S5).size.jsonValues, between(336_000, 340_000)), c('5000 one-per-sheet JSON values', b(S5P).size.jsonValues, between(395_000, 399_000)),
    ] },
    { doc: A, quote: '≈ 2 500–5 600 at 5000 sheets', checks: [c('findings, typical', b(S5).shape.findings, between(2400, 2700)), c('findings, nothing confirmed', b(S5U).shape.findings, between(5500, 5700))] },
    { doc: A, quote: 'A 5000-sheet Project opens in ≈ 90–125 ms on a page thread (Chrome); the scan is the largest single stage of that', checks: [
        c('open 5000 ms', b(S5).open.importTotal.medianMs, between(70, 130)), c('open 5000 one-per-sheet ms', b(S5P).open.importTotal.medianMs, between(90, 150)),
        c('scan minus the next largest stage, ms', b(S5).open.stageMedians.scanMs - Math.max(b(S5).open.stageMedians.decodeMs, b(S5).open.stageMedians.parseMs, b(S5).open.stageMedians.schemaMs, b(S5).open.stageMedians.relationsMs), between(0, 100)),
    ] },
    { doc: A, quote: 'refused at `schema` after ≈ 0.55 s and ≈ 256 MiB of heap in Node (≈ 104 MiB in Chrome)', checks: [
        c('worst in-bounds refusal ms', hostileCase('worst case inside the bounds').bounded.refusedInMs, near(550)),
        c('worst in-bounds Node heap MiB', hostileCase('worst case inside the bounds').unbounded.retainedHeapMiB, near(256)),
        c('worst in-bounds Chrome heap MiB', parseBrowser('array of 3,999,990').jsHeapGrowthMiB, near(104)),
    ] },
    { doc: A, quote: 'one task of about a tenth of a second at 5000 sheets', checks: [c('page-thread open 5000 ms', pageThread(5000).open.ms, between(70, 150)), c('page-thread gap 5000 ms', pageThread(5000).open.mainThread.maxGapMs, between(70, 150))] },

    // ---- R9, browser ------------------------------------------------------
    { doc: A, quote: '| Save (project, validate, serialise) | ≈ 3 ms | ≈ 15 ms | ≈ 95 ms | ≈ 115 ms | ≈ 400 ms |', checks: [
        c('200', b('200 sheets').save.exportTotal.medianMs, near(3, 1.5)), c('1000', b('1000 sheets').save.exportTotal.medianMs, near(15)),
        c('5000', b(S5).save.exportTotal.medianMs, near(95)), c('5000 one-per-sheet', b(S5P).save.exportTotal.medianMs, near(115)), c('20000', b(S20).save.exportTotal.medianMs, near(400)),
    ] },
    { doc: A, quote: '| Open (decode, scan, parse, schema, relations) | ≈ 4 ms | ≈ 18 ms | ≈ 92 ms | ≈ 120 ms | ≈ 420 ms |', checks: [
        c('200', b('200 sheets').open.importTotal.medianMs, near(4, 1.5)), c('1000', b('1000 sheets').open.importTotal.medianMs, near(18)),
        c('5000', b(S5).open.importTotal.medianMs, near(92)), c('5000 one-per-sheet', b(S5P).open.importTotal.medianMs, near(120)), c('20000', b(S20).open.importTotal.medianMs, near(420)),
    ] },
    { doc: A, quote: '| QA, all rules | ≈ 1 ms | ≈ 5 ms | ≈ 27 ms | ≈ 31 ms | ≈ 120 ms |', checks: [
        c('200', b('200 sheets').qa.evaluateAllRules.medianMs, near(1, 0.7)), c('1000', b('1000 sheets').qa.evaluateAllRules.medianMs, near(5, 2.5)),
        c('5000', b(S5).qa.evaluateAllRules.medianMs, near(27)), c('5000 one-per-sheet', b(S5P).qa.evaluateAllRules.medianMs, near(31)), c('20000', b(S20).qa.evaluateAllRules.medianMs, near(120)),
    ] },
    { doc: A, quote: '| — duplicate-number detection alone | under 1 ms | under 1 ms | under 1 ms | under 1 ms | ≈ 1 ms |', checks: [
        c('5000', b(S5).qa.duplicateNumberDetectionOnly.medianMs, under(1)), c('20000', b(S20).qa.duplicateNumberDetectionOnly.medianMs, near(1, 0.7)),
    ] },
    { doc: A, quote: '| — gap detection alone | under 1 ms | under 1 ms | ≈ 1 ms | ≈ 1.5 ms | ≈ 4 ms |', checks: [
        c('1000', b('1000 sheets').qa.gapDetectionOnly.medianMs, under(1)), c('5000', b(S5).qa.gapDetectionOnly.medianMs, near(1, 0.7)),
        c('5000 one-per-sheet', b(S5P).qa.gapDetectionOnly.medianMs, near(1.5, 1)), c('20000', b(S20).qa.gapDetectionOnly.medianMs, near(4, 2.5)),
    ] },
    { doc: A, quote: '| Sort by drawing number (collated, shuffled input) | under 1 ms | ≈ 1 ms | 3–9 ms | 4–10 ms | 25–50 ms |', checks: [
        c('200', b('200 sheets').list.sortByNumber.medianMs, under(1)), c('1000', b('1000 sheets').list.sortByNumber.medianMs, near(1, 0.6)),
        c('5000', b(S5).list.sortByNumber.medianMs, between(3, 9)), c('5000 one-per-sheet', b(S5P).list.sortByNumber.medianMs, between(4, 10)), c('20000', b(S20).list.sortByNumber.medianMs, between(25, 50)),
    ] },
    { doc: A, quote: '| Filter | under 1 ms | under 1 ms | under 1 ms | under 1 ms | under 2 ms |', checks: [
        c('5000', b(S5).list.filterByText.medianMs, under(1)), c('20000', b(S20).list.filterByText.medianMs, under(2)),
    ] },
    { doc: A, quote: '| Currency of every sheet and finding | under 1 ms | under 1 ms | under 2 ms | under 2 ms | under 6 ms |', checks: [
        c('1000', b('1000 sheets').stale.currencyOfEverything.medianMs, under(1)), c('5000', b(S5).stale.currencyOfEverything.medianMs, under(2)),
        c('5000 one-per-sheet', b(S5P).stale.currencyOfEverything.medianMs, under(2)), c('20000', b(S20).stale.currencyOfEverything.medianMs, under(6)),
    ] },
    { doc: A, quote: '| One Source replaced: what goes stale | 25 of 200 sheets | 25 of 1 000 | 25 of 5 000 | 1 of 5 000 | 25 of 20 000 |', checks: [
        c('200', b('200 sheets').stale.afterOneSourceReplaced.staleSheets, between(25, 25)), c('5000', b(S5).stale.afterOneSourceReplaced.staleSheets, between(25, 25)),
        c('5000 one-per-sheet', b(S5P).stale.afterOneSourceReplaced.staleSheets, between(1, 1)), c('20000', b(S20).stale.afterOneSourceReplaced.staleSheets, between(25, 25)),
    ] },
    { doc: A, quote: 'at ≈ 1.8–2.2 kB and ≈ 67–79 JSON values per sheet', checks: [
        ...all('bytes per sheet', scaleBrowser.rows.map((r) => r.size.bytesPerSheet), between(1800, 2200)),
        ...all('JSON values per sheet', scaleBrowser.rows.map((r) => r.size.jsonValues / r.shape.sheets), between(66.5, 79.5)),
    ] },
    { doc: A, quote: 'With nothing confirmed (5 607 findings) QA is ≈ 62 ms', checks: [
        c('findings', b(S5U).shape.findings, between(5607, 5607)), c('QA ms', b(S5U).qa.evaluateAllRules.medianMs, near(62)),
    ] },
    { doc: A, quote: 'rows take ≈ 30 ms for a layout pass and ≈ 30 ms for a restyle; 5 000 rows ≈ 150 ms each; 20 000 ≈ 650 ms', checks: [
        c('1000 layout', list(1000).layoutMs, near(30)), c('1000 restyle', list(1000).restyleAllMs, near(30)),
        c('5000 layout', list(5000).layoutMs, near(150)), c('5000 restyle', list(5000).restyleAllMs, near(150)),
        c('20000 layout', list(20000).layoutMs, near(650)), c('20000 restyle', list(20000).restyleAllMs, near(650)),
    ] },
    { doc: A, quote: '(roughly 25–75 ms at 5000 sheets)', checks: [
        c('QA 5000', b(S5).qa.evaluateAllRules.medianMs, between(20, 75)), c('QA 5000 nothing confirmed', b(S5U).qa.evaluateAllRules.medianMs, between(25, 80)),
    ] },

    // ---- the declared Drawing Register (RF-33-02) ---------------------------
    { doc: A, quote: 'One of 4 898 rows (five references) adds ≈ 0.95 MiB to a 5000-sheet file — about 200 bytes per row — and QA with it took under 60 ms', checks: [
        c('register rows', b(S5R).shape.registerEntries, between(4898, 4898)), c('register references', b(S5R).shape.registerReferences, between(5, 5)),
        c('added MiB', (b(S5R).size.compactBytes - b(S5).size.compactBytes) / 2 ** 20, near(0.95)),
        c('added bytes per row', (b(S5R).size.compactBytes - b(S5).size.compactBytes) / b(S5R).shape.registerEntries, between(170, 230)),
        c('QA with a register, Chrome ms', b(S5R).qa.evaluateAllRules.medianMs, under(60)),
        c('QA with a register, Node ms', row(scaleNode, S5R).qa.evaluateAllRules.medianMs, under(60)),
    ] },
    { doc: 'qa-rule-matrix.md', quote: 'With a declared register of 4 898 rows the same evaluation took under 60 ms.', checks: [
        c('register rows', b(S5R).shape.registerEntries, between(4898, 4898)),
        c('Chrome ms', b(S5R).qa.evaluateAllRules.medianMs, under(60)), c('Node ms', row(scaleNode, S5R).qa.evaluateAllRules.medianMs, under(60)),
    ] },

    // ---- other documents --------------------------------------------------
    { doc: 'qa-rule-matrix.md', quote: '≈ 27 ms on a page thread in Chrome and ≈ 26 ms in Node; with nothing confirmed (5 607 findings) ≈ 62 ms and ≈ 46 ms', checks: [
        c('Chrome', b(S5).qa.evaluateAllRules.medianMs, near(27)), c('Node', row(scaleNode, S5).qa.evaluateAllRules.medianMs, near(26)),
        c('Chrome, nothing confirmed', b(S5U).qa.evaluateAllRules.medianMs, near(62)), c('Node, nothing confirmed', row(scaleNode, S5U).qa.evaluateAllRules.medianMs, near(46)),
    ] },
    { doc: 'limitations.md', quote: '(≈ 87 MiB against ≈ 570 MiB at 250 MiB)', checks: [
        c('byob peak', byob(250).rendererPeakWorkingSetMiB, near(87)), c('one-shot peak', single(250, 'subtle-worker').rendererPeakWorkingSetMiB, near(570)),
    ] },
    { doc: 'limitations.md', quote: 'at about a sixth of OpenSSL\'s speed on the same CPU', checks: all('OpenSSL MiB/s over Chrome digest MiB/s', split(250).map((r) => nodeFp(250).nativeStream.MiBPerSecond / (250 / (r.subtleDigest.ms / 1000))), between(4, 8)) },
    { doc: 'limitations.md', quote: 'retained ≈ 256 MiB in Node and ≈ 104 MiB in Chrome', checks: [
        c('Node', hostileCase('worst case inside the bounds').unbounded.retainedHeapMiB, near(256)), c('Chrome', parseBrowser('array of 3,999,990').jsHeapGrowthMiB, near(104)),
    ] },
    { doc: 'limitations.md', quote: 'The input is now shuffled (3–9 ms).', checks: [c('sort 5000 ms', b(S5).list.sortByNumber.medianMs, between(3, 9))] },
    { doc: 'limitations.md', quote: 'refused by the scan in about 10 ms without being parsed', checks: [
        c('2M keys refusal ms', hostileCase('object with 2,000,000').bounded.refusedInMs, under(30)),
    ] },
    { doc: 'title-block-profile.md', quote: 'roughly 1.8–2.2 kB per sheet', checks: all('bytes per sheet', scaleBrowser.rows.map((r) => r.size.bytesPerSheet), between(1800, 2200)) },
];

// -- evaluate ---------------------------------------------------------------
const squash = (text) => text.replace(/\s+/g, ' ');
const lines = ['# Claims check', '', '> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**',
    '> Generated by `benchmark/check-claims.mjs`. Every figure the documents quote from a benchmark, the words it is quoted in,',
    '> and whether the committed result files still bear it out. "≈ X" allows X ± 25 %.', ''];
let failed = 0;
let checked = 0;
for (const claim of CLAIMS) {
    const present = doc(claim.doc).includes(squash(claim.quote));
    if (!present) failed += 1;
    lines.push(`### \`${claim.doc}\``, '', `> ${claim.quote}`, '', present ? '' : '**QUOTE NOT FOUND IN THE DOCUMENT**', '',
        '| Check | Measured | Allowed | |', '|---|---|---|---|');
    for (const check of claim.checks) {
        const ok = Number.isFinite(check.value) && check.value >= check.min && check.value <= check.max;
        checked += 1;
        if (!ok) failed += 1;
        lines.push(`| ${check.label} | ${Number(check.value.toFixed(3))} | ${Number(check.min.toFixed(3))} … ${Number(check.max.toFixed(3))} | ${ok ? 'ok' : '**OUTSIDE**'} |`);
    }
    lines.push('');
}
lines.splice(5, 0, `**${CLAIMS.length} quoted statements, ${checked} checks, ${failed} failed.**`, '');
fs.writeFileSync(path.join(RESULTS, 'CLAIMS.md'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(RESULTS, 'claims.json'), `${JSON.stringify({ statements: CLAIMS.length, checks: checked, failed }, null, 2)}\n`);
console.log(`claims: ${CLAIMS.length} quoted statements, ${checked} checks, ${failed} failed -> results/CLAIMS.md`);
process.exit(failed === 0 ? 0 : 1);
