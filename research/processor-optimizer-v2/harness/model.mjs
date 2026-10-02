/**
 * The memory arithmetic, current and proposed.
 *
 * (1) Current production, with production's own functions: preservingFileCost
 *     -> the plan's filePeakBytes -> canStartNextFile (the single-file
 *     run-time boundary, PdfTools.tsx:285) at each preset, plus
 *     checkActualOutput on the artifact.
 * (2) pdf-lib 1.17.1 parse cost, measured per fixture (heap + ArrayBuffers
 *     after load, gc'd): MeasuredOnly, used only to size a conservative
 *     per-object constant.
 * (3) The v2 model under two admission policies, for the primary fixture:
 *     P  preflight worst case for everything (retained replacement streams
 *        <= the streams they replace; output <= source by the unchanged rule)
 *     R  preflight for what is fixed (source, parse, largest image work) plus
 *        a run-time reserve for what depends on compression (replacement
 *        streams, output, Blob), enforced on actual bytes with abort and no
 *        publication.
 *     The largest image's work is priced for pako 2.1.0, the recommended
 *     compressor, with no pako output bound claimed (a run-time cap instead).
 * (4) A pako 2.1.0 probe: one-shot vs Deflate + onData, and the run-time cap.
 * (5) Stage 1 as decided: single file only; ~250 MiB needs the 1 GiB preset,
 *     512 MiB for that size is deferred (arithmetic is not a support claim).
 *
 * Run: node --expose-gc harness/model.mjs -> evidence/model.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, PDFRawStream, PDFName, PDFNumber } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
const P = prod.processor;
const MiB = 2 ** 20;
const mib = (b) => +(b / MiB).toFixed(1);

// ---------------------------------------------------------------- (1) current
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'manifest.json'), 'utf8'));
const sizes = { 'f01 (synthetic, this corpus)': corpus['f01-comparator-a1-150'].bytes, '250,000,000 B (the reported ~250 MB)': 250_000_000, '261,549,245 B (M4 PR #28, measured old writer)': 261_549_245 };
const current = [];
for (const [label, S] of Object.entries(sizes)) {
    const cost = P.preservingFileCost(S, P.PRESERVING_SLACK_BYTES);
    const row = { label, sourceBytes: S, sourceMiB: mib(S), plannedOutputMiB: mib(cost.outputBytes), filePeakMiB: mib(cost.peakBytes), presets: {} };
    for (const preset of P.MEMORY_PRESETS) {
        const ceilings = P.defaultCeilings(preset);
        const b = P.canStartNextFile([], cost.peakBytes, ceilings);
        row.presets[`${preset / MiB} MiB`] = b.ok ? 'runs' : `refused: ${b.reason}`;
    }
    row.unchangedOutputPassesCeiling = P.checkActualOutput(S, P.defaultCeilings(P.MEMORY_PRESETS[0])).ok;
    current.push(row);
}
// Largest source each preset admits: 3.5 S + slack <= preset.
const largestAdmitted = Object.fromEntries(P.MEMORY_PRESETS.map((m) => {
    let lo = 0; let hi = m;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (P.preservingFileCost(mid, P.PRESERVING_SLACK_BYTES).peakBytes <= m) lo = mid; else hi = mid; }
    return [`${m / MiB} MiB`, { bytes: lo, MiB: mib(lo) }];
}));

// ---------------------------------------------------- (2) pdf-lib parse cost
const parse = [];
for (const name of Object.keys(corpus)) {
    const file = path.join(ROOT, 'out', 'corpus', `${name}.pdf`);
    const bytes = new Uint8Array(fs.readFileSync(file));
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage();
    let objects = 0; let streams = 0; let streamBytes = 0; let largestImage = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
        objects += 1;
        if (o instanceof PDFRawStream) {
            streams += 1; streamBytes += o.contents.length;
            if (o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
                const w = o.dict.get(PDFName.of('Width')); const h = o.dict.get(PDFName.of('Height'));
                const bpc = o.dict.get(PDFName.of('BitsPerComponent'));
                if (w instanceof PDFNumber && h instanceof PDFNumber) largestImage = Math.max(largestImage, w.asNumber() * h.asNumber() * 4 * ((bpc instanceof PDFNumber ? bpc.asNumber() : 8) / 8));
            }
        }
    }
    const grew = (after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers);
    parse.push({ fixture: name, sourceBytes: bytes.length, objects, streams, streamBytes, streamShare: +(streamBytes / bytes.length).toFixed(4), parsedGrowthBytes: grew, nonStreamPerObject: Math.max(0, Math.round((grew - streamBytes) / objects)), largestImageRgbaBytes: largestImage });
    void doc;
}
// A conservative per-object constant: twice the largest measured, at least 4 KiB.
const PER_OBJECT = Math.max(4096, 2 * Math.max(...parse.map((p) => p.nonStreamPerObject)));

// --------------------------------------------------------------- (3) v2 model
const f01 = parse.find((p) => p.fixture === 'f01-comparator-a1-150');
const S = f01.sourceBytes;
const O = f01.objects * PER_OBJECT;
// Largest image, priced for the recommended compressor, pako 2.1.0 (the
// Comparator's owned DEFLATE bound is NOT used: it is not the recommended path).
// Everything is priced whole, on the conservative side:
//   decoded samples + the whole predicted R1 body + the largest R2 form
//   + the best candidate kept so far (kept only when smaller than the source
//     stream, so <= that stream)
//   + the candidate being compressed: NO pako 2.1.0 output bound is claimed.
//     It is held to the same cap at run time (onData counts bytes and stops
//     the candidate once it can no longer win), so it is <= the stream + one
//     16 KiB output chunk. That is a design contract the production phase must
//     implement and test, not a property of pako.
//   + pako 2.1.0's DeflateState arrays (counted below from its source).
const W = 4969; const H = 3509;
const decoded = W * H * 3;
const imageStream = decoded; // f01 images are raw: the source stream is the samples
const predictedR1 = (W * 3 + 1) * H; // one filter byte a row
const indexForm = (Math.ceil(W / 2) + 1) * H; // the largest non-8-bit form tried, predicted
const PAKO2 = {
    version: '2.1.0',
    chunkSize: 16_384, // lib/deflate.js:115
    // lib/zlib/deflate.js at level 9 / windowBits 15 / memLevel 8:
    stateBytes: 2 * 32_768 // window = Uint8Array(w_size * 2)            :1505
        + 2 * 32_768 // head = Uint16Array(hash_size = 1 << (memLevel + 7)) :1501, 1506
        + 2 * 32_768 // prev = Uint16Array(w_size)                       :1507
        + 4 * 16_384 // pending_buf = Uint8Array(lit_bufsize * 4)        :1512, 1553-1554
        + 2 * 573 * 2 + 2 * 61 * 2 + 2 * 39 * 2 // dyn_ltree, dyn_dtree, bl_tree :1296-1298
        + 2 * 16 + 2 * 573 + 2 * 573, // bl_count, heap, depth            :1308, 1312, 1321
};
const imageWorkTerms = {
    decodedSamples: decoded,
    predictedR1Body: predictedR1,
    largestR2Form: indexForm,
    bestCandidateKept: imageStream,
    candidateInProgressUnderRuntimeCap: imageStream + PAKO2.chunkSize,
    pakoStateBytes: PAKO2.stateBytes,
};
const imageWork = Object.values(imageWorkTerms).reduce((a, b) => a + b, 0);

// pako 2.1.0, one-shot vs streaming, on f01's first image (raw samples, level 9).
//   one-shot pako.deflate = new Deflate + push(input, true); onEnd flattens the
//   chunk list into one new buffer (lib/deflate.js:291-296, 334-337;
//   utils/common.js:30-48), so the whole result exists twice at the end.
//   Deflate with onData overridden: every full chunk is a fresh 16 KiB buffer
//   (lib/deflate.js:225, 252), so the chunks can be kept as they are.
const pako = (await import('pako')).default;
const f01doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'f01-comparator-a1-150.pdf'))), { updateMetadata: false });
let probeSamples = null;
for (const [, o] of f01doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') { probeSamples = o.contents; break; }
}
const oneShot = pako.deflate(probeSamples, { level: 9 });
const streamChunks = [];
const streamer = new pako.Deflate({ level: 9 });
streamer.onData = (c) => streamChunks.push(c);
streamer.onEnd = () => {};
streamer.push(probeSamples, true);
const streamBytes = streamChunks.reduce((a, c) => a + c.length, 0);
const joined = new Uint8Array(streamBytes);
{ let at = 0; for (const c of streamChunks) { joined.set(c, at); at += c.length; } }
const distinctBuffers = new Set(streamChunks.map((c) => c.buffer)).size;
// The run-time cap: stop a candidate once its emitted bytes pass a limit.
const CAP = Math.floor(oneShot.length / 2); // well inside the real output, so the cap must fire
let capEmitted = 0; let capAborted = false;
const capped = new pako.Deflate({ level: 9 });
capped.onData = (c) => { capEmitted += c.length; if (capEmitted > CAP) throw new Error('candidate cannot win'); };
// Pushed in row blocks; a throw from onData leaves push() at once.
try { for (let at = 0; at < probeSamples.length; at += 1 << 20) capped.push(probeSamples.subarray(at, Math.min(probeSamples.length, at + (1 << 20))), at + (1 << 20) >= probeSamples.length); } catch { capAborted = true; }
const pakoProbe = {
    pakoVersion: JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', '..', 'node_modules', 'pako', 'package.json'), 'utf8')).version,
    inputBytes: probeSamples.length,
    oneShotBytes: oneShot.length,
    streamingBytes: streamBytes,
    streamingEqualsOneShot: streamBytes === oneShot.length && Buffer.compare(Buffer.from(joined), Buffer.from(oneShot)) === 0,
    streamingChunks: streamChunks.length,
    streamingChunksAreDistinctBuffers: distinctBuffers === streamChunks.length,
    // what each path holds when compression ends
    oneShotPeakHeldBytes: Math.ceil(oneShot.length / PAKO2.chunkSize) * PAKO2.chunkSize + oneShot.length,
    streamingPeakHeldBytes: streamChunks.length * PAKO2.chunkSize,
    cap: { capBytes: CAP, aborted: capAborted, emittedBytes: capEmitted, withinCapPlusOneChunk: capEmitted <= CAP + PAKO2.chunkSize },
};
void f01doc;
const variants = {
    'B1 pdf-lib parse (copies streams), source held': { source: S, parsed: f01.streamBytes + O },
    'B1 pdf-lib parse, source released after parse (re-read the File for the unchanged fallback)': { source: 0, parsed: f01.streamBytes + O, parsePeak: S + f01.streamBytes + O },
    'B2 owned parser (streams are views of the source)': { source: S, parsed: O },
};
const policies = [];
for (const [name, v] of Object.entries(variants)) {
    const fixed = v.source + v.parsed + imageWork;
    // P: worst case - replacement streams <= what they replace, output <= source, Blob = output.
    const worstRetained = f01.streamBytes;
    const worstOutput = S;
    const policyP = Math.max(v.parsePeak ?? 0, fixed + worstRetained + worstOutput + worstOutput);
    const row = { variant: name, fixedMiB: mib(fixed), policyP_MiB: mib(policyP), acceptsP: P.MEMORY_PRESETS.map((m) => policyP <= m) };
    // R: preflight admits fixed + parse peak; the rest must fit the reserve left
    // in the chosen preset, enforced at run time on actual bytes.
    // arithmeticAdmits is the model's arithmetic only. It is not a support
    // claim: see stage1 below.
    row.parsePeakMiB = mib(Math.max(v.parsePeak ?? 0, fixed));
    row.policyR = P.MEMORY_PRESETS.map((m) => {
        const need = Math.max(v.parsePeak ?? 0, fixed);
        return { presetMiB: m / MiB, arithmeticAdmits: need <= m, headroomAtPeakMiB: mib(m - need), reserveMiB: mib(m - fixed) };
    });
    policies.push(row);
}

// Stage 1, as decided (RF-30-01, RF-30-03). Policy R is the intended
// architecture; ~250 MiB at 512 MiB is NOT proven: the parse-instant headroom
// is thin, PER_OBJECT is sized on this synthetic corpus only, and browser heap,
// GC timing and Blob behaviour were not measured. So Stage 1 needs 1 GiB for
// it, and 512 MiB for this size is deferred to a bounded-memory phase.
const released = policies.find((p) => p.variant.includes('released'));
const stage1 = {
    policyRConcept: 'recommended',
    boundary: {
        inputs: 'single file only: Optimizer v2 with more than one selected file is refused explicitly (no silent first-file processing)',
        why: 'the UI holds every selected source in planned[] before running (PdfTools.tsx:219); releasing one source after parse bounds nothing while the others stay held',
        otherProcessorTools: 'batch behaviour unchanged',
        batchAndZip: 'deferred (needs its own sequential source-ownership + ZIP memory model and gate)',
    },
    variant: released.variant,
    '~250 MiB source': {
        '512 MiB': {
            status: 'DEFERRED - not yet proven',
            arithmeticAdmits: released.policyR[0].arithmeticAdmits,
            headroomAtPeakMiB: released.policyR[0].headroomAtPeakMiB,
            unproven: ['parse-instant headroom', 'PER_OBJECT measured on the synthetic corpus only', 'browser heap / GC / Blob not measured', 'pako 2.1.0 output held by a run-time cap that is a design contract, not yet implemented'],
        },
        '1024 MiB': { status: released.policyR[1].arithmeticAdmits ? 'required preset in Stage 1' : 'NOT ADMITTED', headroomAtPeakMiB: released.policyR[1].headroomAtPeakMiB, reserveMiB: released.policyR[1].reserveMiB },
    },
};

const result = { current, largestAdmitted, parse, PER_OBJECT, f01: { sourceBytes: S, objects: f01.objects, streamBytes: f01.streamBytes, imageWorkBytes: imageWork, imageWorkBasis: 'pako 2.1.0 (recommended path)', imageWorkTerms }, pako2: PAKO2, pakoProbe, policies, stage1 };
fs.writeFileSync(path.join(ROOT, 'evidence', 'model.json'), JSON.stringify(result, null, 1));
for (const r of current) console.log(`${r.label}: filePeak ${r.filePeakMiB} MiB -> ${Object.entries(r.presets).map(([k, v]) => `${k} ${v.startsWith('runs') ? 'runs' : 'REFUSED'}`).join(', ')}; unchanged output within 256 MiB: ${r.unchangedOutputPassesCeiling}`);
console.log('largest source admitted today:', JSON.stringify(largestAdmitted));
for (const p of parse) console.log(`parse ${p.fixture}: ${p.objects} objects, streams ${(p.streamShare * 100).toFixed(1)}% of file, grew ${mib(p.parsedGrowthBytes)} MiB, ~${p.nonStreamPerObject} B/object beyond streams`);
console.log('PER_OBJECT', PER_OBJECT);
for (const p of policies) console.log(`${p.variant}\n   fixed ${p.fixedMiB} MiB; P worst case ${p.policyP_MiB} MiB accepts ${p.acceptsP.map((a) => (a ? 'Y' : 'n')).join('')}; R ${p.policyR.map((x) => `${x.presetMiB}:${x.arithmeticAdmits ? `Y reserve ${x.reserveMiB}` : 'n'}`).join(' | ')}`);
console.log('pako probe', JSON.stringify(pakoProbe));
console.log('stage1', JSON.stringify(stage1['~250 MiB source']));
