/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Separates what a benchmark *found* from how long it took.
 *
 * Two kinds of field come out of the benchmarks:
 *
 *   structural     sizes in bytes, counts, verdicts, refusal stages and codes,
 *                  which digests agreed, which capabilities a context has.
 *                  These are properties of the code and the inputs. Two runs
 *                  must produce them identically, and the Node and the browser
 *                  scale runs must agree with each other.
 *   measured-only  times, MiB per second, memory. These vary run to run and are
 *                  never compared for equality.
 *
 * This writes the structural fields alone to results/structural.json, so two
 * runs can be compared with a plain diff, and checks the one cross-runtime
 * invariant directly: the same synthetic Project is the same number of bytes in
 * Node and in Chrome.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/structural.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const load = (name) => JSON.parse(fs.readFileSync(path.join(RESULTS, name), 'utf8'));

const scaleRows = (report) => report.rows.map((r) => ({
    label: r.label, ...r.shape,
    compactBytes: r.size.compactBytes, prettyBytes: r.size.prettyBytes, jsonValues: r.size.jsonValues, maxDepth: r.size.maxDepth,
    afterOneSourceReplaced: { staleSheets: r.stale.afterOneSourceReplaced.staleSheets, staleFindings: r.stale.afterOneSourceReplaced.staleFindings },
}));

const scaleNode = scaleRows(load('scale-node.json'));
const scaleBrowser = scaleRows(load('scale-browser.json'));
const hostile = load('hostile-node.json');
const fp = load('fingerprint-browser.json');
const extra = load('fingerprint-browser-extra.json');
const fpNode = load('fingerprint-node.json');
const probes = load('browser-probes.json');

const walkKind = (text) => (text.startsWith('walked') ? 'walked' : text.split(':')[0]);
const env = (e) => ({
    isSecureContext: e.isSecureContext, cryptoSubtleDigest: e.cryptoSubtleDigest, cryptoRandomUUID: e.cryptoRandomUUID,
    cryptoGetRandomValues: e.cryptoGetRandomValues, worker: e.worker, blobStream: e.blobStream, showOpenFilePicker: e.showOpenFilePicker,
});

const structural = {
    notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. The structural (run-independent) fields of the benchmark results. Times and memory are deliberately absent.',
    scale: {
        nodeAndBrowserAgree: JSON.stringify(scaleNode) === JSON.stringify(scaleBrowser),
        rows: scaleNode,
    },
    hostile: {
        cases: hostile.hostile.map((c) => ({
            input: c.input,
            bounded: { status: c.bounded.status, stage: c.bounded.stage, code: c.bounded.code, reachedJsonParse: c.bounded.reachedJsonParse },
            unbounded: { jsonParse: c.unbounded.jsonParse, recursiveWalk: walkKind(c.unbounded.recursiveWalk) },
        })),
        largestAccepted: hostile.largestAccepted.map((r) => ({ targetMiB: r.targetMiB, bytes: r.bytes, decisions: r.decisions, status: r.status })),
    },
    fingerprint: {
        // A case is only recorded if every digest the page reported equalled node:crypto's.
        browserCasesWithVerifiedDigests: [
            ...fp.singleFile.map((r) => `single ${r.sizeMiB} MiB ${r.method}`),
            ...fp.chunkSize.map((r) => `chunk ${r.chunkKiB} KiB ${r.method}`),
            ...fp.multiFileSequential.map((r) => `multi ${r.files}x${r.eachMiB} MiB ${r.method}`),
            ...extra.singleFile.map((r) => `extra single ${r.sizeMiB} MiB ${r.method}`),
            ...extra.multiFileSequential.map((r) => `extra multi ${r.files}x${r.eachMiB} MiB ${r.method}`),
        ],
        cancellation: {
            streamingOutcomes: [...new Set(fp.cancellation.streamingCancelledAfter150Ms.map((r) => r.outcome))],
            oneShotResultDeliveredAfterTerminate: fp.cancellation.oneShotWorkerTerminatedAfter30Ms.resultDelivered,
        },
        nodeAllImplementationsAgree: fpNode.rows.map((r) => ({ sizeMiB: r.sizeMiB, agree: r.allFiveDigestsAgree })),
    },
    probes: {
        secureContext: env(probes.secureContext.env),
        secureContextWorker: probes.secureContext.worker,
        insecureContext: env(probes.insecureContext.env),
        insecureContextWorker: probes.insecureContext.worker,
        insecureContextFingerprintCorrect: Object.fromEntries(Object.entries(probes.insecureContext.fingerprint).map(([method, r]) => [method, r.ok])),
        facts: {
            subtleDigestAcceptsStream: probes.secureContext.facts.subtleDigestAcceptsStream,
            detachedBufferByteLength: probes.secureContext.facts.detachedBuffer.byteLengthAfterTransfer,
            detachedBufferDigestIsEmptyDigest: probes.secureContext.facts.detachedBuffer.digestAfterIsEmptyDigest,
            digestLeavesInputUsable: probes.secureContext.facts.digestLeavesInputUsable,
            uuidFromGetRandomValues: probes.secureContext.facts.uuidFromGetRandomValues,
        },
        fileChangedOnDisk: Object.fromEntries(Object.entries(probes.fileChangedOnDiskAfterSelection).map(([name, r]) => [name, {
            slice: r.afterChange.sliceError ?? 'read', whole: r.afterChange.wholeError ?? 'read', streamed: r.afterChange.streamError ?? 'read',
        }])),
        jsonParseWithoutBounds: probes.jsonParseWithoutBounds.map((r) => ({ input: r.input, jsonParse: r.jsonParse, recursiveWalk: r.recursiveWalk })),
        projectOpenOnPageThread: probes.projectOpenAndSaveOnPageThread.map((r) => ({ sheets: r.sheets, bytes: r.bytes, status: r.open.status })),
        sheetListDomNodes: probes.sheetListPlainDomLowerBound.rows.map((r) => ({ rows: r.rows, domNodes: r.domNodes })),
    },
};

fs.writeFileSync(path.join(RESULTS, 'structural.json'), `${JSON.stringify(structural, null, 2)}\n`);
console.log(`written: results/structural.json  (Node and browser scale rows agree: ${structural.scale.nodeAndBrowserAgree})`);
if (!structural.scale.nodeAndBrowserAgree) process.exit(1);
