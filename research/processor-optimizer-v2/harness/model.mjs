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
const C = prod.comparator;
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
// Largest image, decoded: RGB samples. Production encodes in row streams, but
// the exact-palette analysis and the chosen form are priced whole here, on the
// conservative side: decoded samples + index form + compressed-stream bound.
const W = 4969; const H = 3509;
const decoded = W * H * 3;
const indexForm = Math.ceil(W / 2) * H + H; // the largest non-8-bit form tried
const imageWork = decoded + indexForm + C.ownedDeflateBound(decoded + H) + C.ownedDeflateScratchBytes(W * 3 + 1);
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
    row.policyR = P.MEMORY_PRESETS.map((m) => {
        const need = Math.max(v.parsePeak ?? 0, fixed);
        return { presetMiB: m / MiB, admitted: need <= m, reserveMiB: mib(m - fixed) };
    });
    policies.push(row);
}

const result = { current, largestAdmitted, parse, PER_OBJECT, f01: { sourceBytes: S, objects: f01.objects, streamBytes: f01.streamBytes, imageWorkBytes: imageWork }, policies };
fs.writeFileSync(path.join(ROOT, 'evidence', 'model.json'), JSON.stringify(result, null, 1));
for (const r of current) console.log(`${r.label}: filePeak ${r.filePeakMiB} MiB -> ${Object.entries(r.presets).map(([k, v]) => `${k} ${v.startsWith('runs') ? 'runs' : 'REFUSED'}`).join(', ')}; unchanged output within 256 MiB: ${r.unchangedOutputPassesCeiling}`);
console.log('largest source admitted today:', JSON.stringify(largestAdmitted));
for (const p of parse) console.log(`parse ${p.fixture}: ${p.objects} objects, streams ${(p.streamShare * 100).toFixed(1)}% of file, grew ${mib(p.parsedGrowthBytes)} MiB, ~${p.nonStreamPerObject} B/object beyond streams`);
console.log('PER_OBJECT', PER_OBJECT);
for (const p of policies) console.log(`${p.variant}\n   fixed ${p.fixedMiB} MiB; P worst case ${p.policyP_MiB} MiB accepts ${p.acceptsP.map((a) => (a ? 'Y' : 'n')).join('')}; R ${p.policyR.map((x) => `${x.presetMiB}:${x.admitted ? `Y reserve ${x.reserveMiB}` : 'n'}`).join(' | ')}`);
