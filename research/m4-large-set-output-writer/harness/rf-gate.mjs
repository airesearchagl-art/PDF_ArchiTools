/**
 * Focused-repair gate for RF-01 / RF-02.
 *
 * Reuses the SHA-bound stage-1 composites (produced by prepare.mjs, unchanged
 * since 572ecca) instead of re-rendering: before anything else it proves the
 * composites on disk are structurally identical to those recorded in
 * evidence/gate-g1.json, and refuses to run otherwise.
 *
 * Steps: bundle -> reuse check -> owned-deflate unit (round trip + bound) ->
 * RF-01 writer cells (owned / guarded / faulty platform) with reopen ->
 * owned writer sink-only memory -> RF-01 model -> RF-02 engine-driven runs.
 *
 * Run:     node harness/rf-gate.mjs --run rf1
 * Compare: node harness/rf-gate.mjs --compare rf1 rf2
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OwnedZlib, ownedDeflateBound } from './owned-deflate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const EVIDENCE = path.join(ROOT, 'evidence');
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };

if (process.argv.includes('--compare')) {
    const i = process.argv.indexOf('--compare');
    const [a, b] = [process.argv[i + 1], process.argv[i + 2]].map((r) => JSON.parse(fs.readFileSync(path.join(EVIDENCE, `rf-gate-${r}.json`), 'utf8')));
    const same = JSON.stringify(a.structural) === JSON.stringify(b.structural);
    console.log(`structural fields identical: ${same}`);
    if (!same) for (const k of Object.keys(a.structural)) if (JSON.stringify(a.structural[k]) !== JSON.stringify(b.structural[k])) console.log(`  differs: ${k}`);
    process.exit(same ? 0 : 1);
}

const RUN = arg('run', 'rf1');
const BIG = '--max-old-space-size=24000';
const steps = [];
function step(name, args) {
    const t = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 2 ** 20 });
    steps.push({ name, exitCode: r.status, ms: Date.now() - t });
    console.log(`[${r.status === 0 ? 'ok' : 'FAIL'}] ${name} (${Date.now() - t} ms)`);
    if (r.status !== 0) {
        console.log((r.stderr || '').split('\n').filter((l) => !l.startsWith('var ')).slice(-12).join('\n'));
        throw new Error(`step failed: ${name}`);
    }
    return (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
}

// 1. Bundle (same flags as gate.mjs).
step('bundle production comparator', [
    path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(HERE, 'prod-entry.ts'), '--bundle', '--platform=node', '--format=esm', '--log-level=warning', '--minify-whitespace',
    `--alias:jspdf=${path.join(REPO, 'node_modules', 'jspdf', 'dist', 'jspdf.es.min.js')}`,
    '--external:pdfjs-dist', `--outfile=${path.join(ROOT, 'out', 'prod.mjs')}`,
]);

// 2. Reuse check: the composites must be the SHA-bound ones.
const g1 = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'gate-g1.json'), 'utf8'));
const reuse = {};
for (const tag of ['dpi150', 'dpi300', 'dpi450']) {
    const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'composites', tag, 'summary.json'), 'utf8'))
        .map((m) => ({ page: m.page, frame: `${m.width}x${m.height}`, verdict: m.verdict, changePixels: m.changePixels, inkPixels: m.inkPixels, colours: m.distinctColours }));
    reuse[tag] = JSON.stringify(disk) === JSON.stringify(g1.structural.composites[tag]);
}
console.log(`[${Object.values(reuse).every(Boolean) ? 'ok' : 'FAIL'}] reused composites match gate-g1 (${g1.head.slice(0, 7)})`);
if (!Object.values(reuse).every(Boolean)) throw new Error('reused composites do not match the SHA-bound evidence; rerun gate.mjs first');

// 3. Owned deflate: exact round trip through zlib, and never over the bound.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; }; }
const r = rng(11);
const unitInputs = {
    'uniform random bytes': [Uint8Array.from({ length: 400000 }, () => (r() * 256) | 0), 2485],
    'random 9-state nibbles': [Uint8Array.from({ length: 400000 }, () => (((r() * 9) | 0) << 4) | ((r() * 9) | 0)), 2485],
    'all paper': [new Uint8Array(300000), 2485],
    'row-periodic': [Uint8Array.from({ length: 300000 }, (_, i) => ((i % 2485) * 7) & 0xFF), 2485],
    'row wider than the window (no row matches)': [Uint8Array.from({ length: 200000 }, (_, i) => (i % 40001) & 0x3), 40001],
    'exactly one block': [new Uint8Array(65535).fill(3), 100],
    'one block + 1': [new Uint8Array(65536).fill(3), 100],
    'empty': [new Uint8Array(0), 100],
};
const unit = [];
for (const [name, [data, rowBytes]] of Object.entries(unitInputs)) {
    const chunks = [];
    const z = new OwnedZlib(rowBytes, (c) => chunks.push(c.slice()));
    for (let i = 0; i < data.length; i += 9973) z.push(data.subarray(i, i + 9973));
    const res = z.finish();
    const back = zlib.inflateSync(Buffer.concat(chunks));
    unit.push({ input: name, inputBytes: data.length, encodedBytes: res.encodedBytes, bound: ownedDeflateBound(data.length), withinBound: res.encodedBytes <= ownedDeflateBound(data.length), roundTrip: Buffer.compare(back, Buffer.from(data)) === 0, blocksFixed: res.blocksFixed, blocksStored: res.blocksStored });
}
console.log(`[${unit.every((u) => u.withinBound && u.roundTrip) ? 'ok' : 'FAIL'}] owned deflate unit (${unit.length} inputs)`);

// 4. RF-01 writer cells, reopened pixel-exact.
const CELLS = [
    ['dpi150', 'idx4m-own'], ['dpi150', 'idx4m-guard'], ['dpi150', 'idx4m-guard-expanding'], ['dpi150', 'idx4m-guard-throwing'],
    ['dpi300', 'idx4m-own'], ['dpi300', 'idx4m-guard'],
    ['dpi450', 'idx4m-own'], ['dpi450', 'idx4m-guard'],
];
const cells = {};
const measured = {};
const lines = [];
for (const [tag, writer] of CELLS) {
    const rec = JSON.parse(step(`${tag} ${writer}`, [BIG, '--expose-gc', path.join(HERE, 'write.mjs'), '--tag', tag, '--writer', writer]));
    lines.push(rec);
    cells[`${tag}/${writer}`] = {
        fileBytes: rec.fileBytes, verifyOk: rec.verify?.ok,
        pixelMismatches: rec.verify?.pages?.map((p) => p.pixelMismatches),
        encoders: rec.perPage.map((p) => p.encoder), withinBound: rec.perPage.every((p) => p.withinBound === true),
        encodedBytes: rec.perPage.map((p) => p.encodedBytes), bounds: rec.perPage.map((p) => p.bound),
        fallbacks: rec.perPage.map((p) => (p.fallback ? p.fallback.replace(/\d+/g, 'N') : null)),
    };
    measured[`${tag}/${writer}`] = { totalMs: rec.totalMs, sampledWriterPeakMiB: rec.sampledWriterPeakMiB };
}
// 5. Owned writer's own memory.
for (const tag of ['dpi150', 'dpi300', 'dpi450']) {
    const rec = JSON.parse(step(`${tag} idx4m-own sink-only`, [BIG, '--expose-gc', path.join(HERE, 'write.mjs'), '--tag', tag, '--writer', 'idx4m-own', '--sink-only', '--no-verify']));
    lines.push(rec);
    measured[`sink:${tag}/idx4m-own`] = { totalMs: rec.totalMs, sampledWriterPeakMiB: rec.sampledWriterPeakMiB, fileBytes: rec.fileBytes };
}
fs.writeFileSync(path.join(EVIDENCE, `rf01-${RUN}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// 6. Model; 7. RF-02.
step('RF-01 owned-bound model', [path.join(HERE, 'rf01-model.mjs')]);
const model = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'rf01-model.json'), 'utf8'));
const rf02 = JSON.parse(step('RF-02 engine-driven 2/3/4 members', [BIG, path.join(HERE, 'rf02.mjs')]));
fs.writeFileSync(path.join(EVIDENCE, `rf02-${RUN}.json`), JSON.stringify(rf02, null, 1));

const cellOk = Object.entries(cells).every(([k, c]) => c.verifyOk === true && c.withinBound && c.pixelMismatches.every((x) => x === 0)
    && (k.includes('guard-') ? c.encoders.every((e) => e === 'owned (fallback)') : true));
const summary = {
    run: RUN,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    srcDirty: spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() !== '',
    reusedComposites: { from: 'evidence/gate-g1.json', head: g1.head, match: reuse },
    structural: {
        unit,
        cells,
        model: model.rows.map((m) => `${m.dpi}/${m.members}m/${m.pages}p peak=${m.jobPeakMiB} outBound=${m.outputBoundMiB} mem=${m.memoryAccepts.map((a) => (a ? 'Y' : 'n')).join('')} out<=256=${m.outputBoundWithinMaxOutput}`),
        modelConstants: model.constants,
        rf02: rf02.runs.map((x) => ({ members: x.members, ok: x.ok, errors: x.errors, planStatuses: x.planStatuses, sequence: x.candidate, candidateBytes: x.candidateBytes, jsPdfBytes: x.jsPdfBytes, pages: x.pages })),
    },
    measuredOnly: { steps, cells: measured },
};
summary.pass = unit.every((u) => u.withinBound && u.roundTrip) && cellOk && rf02.ok && !summary.srcDirty;
fs.writeFileSync(path.join(EVIDENCE, `rf-gate-${RUN}.json`), JSON.stringify(summary, null, 1));
console.log(`rf-gate ${RUN}: ${summary.pass ? 'PASS' : 'FAIL'} (head ${summary.head})`);
process.exit(summary.pass ? 0 : 1);
