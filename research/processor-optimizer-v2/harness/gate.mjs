/**
 * The Optimizer v2 research gate: everything from a clean out/, then one
 * summary split into Structural (identical run to run) and MeasuredOnly
 * (timings, RSS).
 *
 * Run:     node harness/gate.mjs --run g1
 * Compare: node harness/gate.mjs --compare g1 g2
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const EVIDENCE = path.join(ROOT, 'evidence');
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };

if (process.argv.includes('--compare')) {
    const i = process.argv.indexOf('--compare');
    const [a, b] = [process.argv[i + 1], process.argv[i + 2]].map((r) => JSON.parse(fs.readFileSync(path.join(EVIDENCE, `gate-${r}.json`), 'utf8')));
    const same = JSON.stringify(a.structural) === JSON.stringify(b.structural);
    console.log(`structural fields identical: ${same}`);
    if (!same) for (const k of Object.keys(a.structural)) if (JSON.stringify(a.structural[k]) !== JSON.stringify(b.structural[k])) console.log(`  differs: ${k}`);
    process.exit(same ? 0 : 1);
}

const RUN = arg('run', 'g1');
const steps = [];
function step(name, args) {
    const t = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 2 ** 20 });
    steps.push({ name, exitCode: r.status, ms: Date.now() - t });
    console.log(`[${r.status === 0 ? 'ok' : 'FAIL'}] ${name} (${Date.now() - t} ms)`);
    if (r.status !== 0) {
        console.log((r.stderr || '').split('\n').filter((l) => l && !l.startsWith('var ')).slice(-10).join('\n'));
        throw new Error(`step failed: ${name}`);
    }
    return (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
}

fs.rmSync(path.join(ROOT, 'out'), { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
step('bundle production processor + comparator', [
    path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(HERE, 'prod-entry.ts'),
    '--bundle', '--platform=node', '--format=esm', '--log-level=warning', '--minify-whitespace',
    `--alias:jspdf=${path.join(REPO, 'node_modules', 'jspdf', 'dist', 'jspdf.es.min.js')}`,
    '--alias:pdfjs-dist=pdfjs-dist/legacy/build/pdf.mjs', '--external:pdfjs-dist/legacy/build/pdf.mjs',
    `--outfile=${path.join(ROOT, 'out', 'prod.mjs')}`,
]);
step('synthetic corpus', ['--max-old-space-size=16000', path.join(ROOT, 'corpus', 'make-corpus.mjs')]);
step('matrix', [path.join(HERE, 'run-matrix.mjs'), '--run', RUN]);
step('memory model', ['--expose-gc', '--max-old-space-size=16000', path.join(HERE, 'model.mjs')]);
const selftest = JSON.parse(step('verifier self-test', [path.join(HERE, 'verify-selftest.mjs')]));
fs.writeFileSync(path.join(EVIDENCE, `selftest-${RUN}.json`), JSON.stringify(selftest, null, 1));

const cells = fs.readFileSync(path.join(EVIDENCE, `matrix-${RUN}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const model = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'model.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'manifest.json'), 'utf8'));
const key = (c) => `${c.fixture}/${c.candidate}${c.extra?.length ? `/${c.extra.join('')}` : ''}`;
const structuralCells = {};
const measuredCells = {};
for (const c of cells) {
    structuralCells[key(c)] = c.failed ? { failed: true } : {
        sourceBytes: c.sourceBytes, outputBytes: c.outputBytes, changed: c.changed, outputSha: c.outputSha,
        verifyOk: c.verify?.ok ?? null, errors: c.verify?.errors ?? null, fieldsPreserved: c.verify?.fieldsPreserved ?? null,
        images: c.images.map((i) => `${i.cs}/${i.bpc}/${i.filters} ${i.decision} ${i.before}->${i.after} ${i.chosen}`),
        lossyMetrics: (c.verify?.images ?? []).filter((i) => i.psnr !== undefined).map((i) => ({ psnr: i.psnr, inkRecall: i.inkRecall, markRecall: i.markRecall, falseInk: i.falseInkPixels, resized: i.resized ?? null })),
    };
    measuredCells[key(c)] = { ms: c.ms, analyseMs: c.analyseMs, writeMs: c.writeMs, peakOverBaselineMiB: c.peakOverBaselineMiB, sampledPeakMiB: c.sampledPeakMiB };
}
const f01 = (cand, extra = '') => structuralCells[`f01-comparator-a1-150/${cand}${extra}`];
const lossless = cells.filter((c) => !c.failed && !c.candidate.startsWith('lossy'));
const summary = {
    run: RUN,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    srcDirty: spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() !== '',
    structural: {
        corpus: Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, { bytes: v.bytes, images: v.images.map((i) => `${i.width}x${i.height} ${i.class}`), expectText: v.expectText ?? null }])),
        cells: structuralCells,
        currentModel: model.current,
        largestAdmitted: model.largestAdmitted,
        policies: model.policies,
        parse: model.parse.map((p) => ({ fixture: p.fixture, objects: p.objects, streams: p.streams, streamBytes: p.streamBytes })),
        selftest,
    },
    measuredOnly: { steps, cells: measuredCells, parseGrowth: model.parse.map((p) => ({ fixture: p.fixture, parsedGrowthBytes: p.parsedGrowthBytes, nonStreamPerObject: p.nonStreamPerObject })), PER_OBJECT: model.PER_OBJECT },
};
const checks = {
    everyLosslessCellVerified: lossless.every((c) => c.verify?.ok === true),
    noCellFailed: cells.every((c) => !c.failed),
    selftestCatchesEveryBreak: selftest.ok === true,
    currentRefusedAt512: model.current.every((r) => r.presets['512 MiB'].startsWith('refused')) && model.current.every((r) => r.presets['1024 MiB'] === 'runs'),
    currentStaysLarge: f01('current').outputBytes > 0.99 * f01('current').sourceBytes,
    primaryLosslessOver90pctAndUnder5MB: f01('ll-chunked-pako-fast').outputBytes < 5_000_000
        && f01('ll-chunked-pako-fast').outputBytes < 0.1 * f01('ll-chunked-pako-fast').sourceBytes,
    lossyNeverChosenWhereLosslessIsSmaller: structuralCells['f01-comparator-a1-150/lossy-q85'].images.every((s) => !s.includes('LOSSY')),
};
summary.checks = checks;
summary.pass = Object.values(checks).every(Boolean) && !summary.srcDirty;
fs.writeFileSync(path.join(EVIDENCE, `gate-${RUN}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(checks));
console.log(`gate ${RUN}: ${summary.pass ? 'PASS' : 'FAIL'} (head ${summary.head})`);
process.exit(summary.pass ? 0 : 1);
