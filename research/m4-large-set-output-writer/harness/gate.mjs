/**
 * The research gate: every step from a clean out/, then one summary whose
 * fields are split into Structural (must be identical run to run) and
 * MeasuredOnly (timings, RSS, viewer load time - reported, never compared).
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
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};

function compare(a, b) {
    const A = JSON.parse(fs.readFileSync(path.join(EVIDENCE, `gate-${a}.json`), 'utf8'));
    const B = JSON.parse(fs.readFileSync(path.join(EVIDENCE, `gate-${b}.json`), 'utf8'));
    const sa = JSON.stringify(A.structural);
    const sb = JSON.stringify(B.structural);
    const same = sa === sb;
    console.log(`structural fields identical: ${same}`);
    if (!same) {
        const fa = A.structural.cells;
        const fb = B.structural.cells;
        for (const k of Object.keys(fa)) {
            if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) console.log(`  differs: ${k}\n    ${JSON.stringify(fa[k])}\n    ${JSON.stringify(fb[k])}`);
        }
    }
    process.exit(same ? 0 : 1);
}
if (arg('compare', null)) compare(process.argv[process.argv.indexOf('--compare') + 1], process.argv[process.argv.indexOf('--compare') + 2]);

const RUN = arg('run', 'g1');
const steps = [];
function step(name, args, opts = {}) {
    const t = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: opts.cwd ?? ROOT, encoding: 'utf8', maxBuffer: 256 * 2 ** 20 });
    const rec = { name, exitCode: r.status, ms: Date.now() - t };
    steps.push(rec);
    console.log(`[${rec.exitCode === 0 ? 'ok' : 'FAIL'}] ${name} (${rec.ms} ms)`);
    if (r.status !== 0) {
        console.log((r.stderr || r.stdout || '').split('\n').slice(-15).join('\n'));
        throw new Error(`gate step failed: ${name}`);
    }
    return r.stdout;
}

fs.rmSync(path.join(ROOT, 'out'), { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
const BIG = '--max-old-space-size=24000';
step('bundle production comparator', [
    path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    // Whitespace-minified so the vendored eslint directives inside jsPDF's
    // dependencies are dropped: out/ is git-ignored but `eslint .` still walks it.
    path.join(HERE, 'prod-entry.ts'), '--bundle', '--platform=node', '--format=esm', '--log-level=warning', '--minify-whitespace',
    `--alias:jspdf=${path.join(REPO, 'node_modules', 'jspdf', 'dist', 'jspdf.es.min.js')}`,
    '--external:pdfjs-dist', `--outfile=${path.join(ROOT, 'out', 'prod.mjs')}`,
], { cwd: REPO });
step('synthetic A1 corpus', [path.join(ROOT, 'corpus', 'make-a1-corpus.mjs')]);
for (const [dpi, tol] of [[150, 0], [300, 0], [450, 0], [72, 0], [150, 0.15]]) {
    step(`prepare ${dpi} dpi tol ${tol}`, [BIG, path.join(HERE, 'prepare.mjs'), '--dpi', String(dpi), '--tolerance-mm', String(tol)]);
}
step('production preflight matrix', [path.join(HERE, 'budget-matrix.mjs')]);
step('writer matrix', [path.join(HERE, 'run-matrix.mjs'), '--run', RUN]);
step('writer-own memory (sink-only)', [path.join(HERE, 'run-matrix.mjs'), '--run', `${RUN}-sink`, '--set', 'sink']);
const ceiling = JSON.parse(step('runtime ceiling abort', [BIG, '--expose-gc', path.join(HERE, 'write.mjs'), '--tag', 'dpi150', '--writer', 'idx4m-up', '--ceiling', '300000'])
    .trim().split('\n').filter((l) => l.startsWith('{')).pop());
const ceilingFileExists = fs.existsSync(path.join(ROOT, 'out', 'pdf', 'dpi150', 'idx4m-up_p1-5_ceil300000.pdf'));
step('model + deflate bound', [path.join(HERE, 'model.mjs')]);
step('chrome canvas / viewer', [path.join(HERE, 'chrome-check.mjs')]);

// ------------------------------------------------------------- summary
const lines = (f) => fs.readFileSync(path.join(EVIDENCE, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const matrix = lines(`matrix-${RUN}.jsonl`);
const sink = lines(`matrix-${RUN}-sink.jsonl`);
const budget = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'budget-matrix.json'), 'utf8'));
const model = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'model.json'), 'utf8'));
const chrome = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'chrome-check.json'), 'utf8'));
const composites = {};
for (const tag of ['dpi72', 'dpi150', 'dpi300', 'dpi450', 'dpi150-tol0.15']) {
    composites[tag] = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'composites', tag, 'summary.json'), 'utf8'))
        .map((m) => ({ page: m.page, frame: `${m.width}x${m.height}`, verdict: m.verdict, changePixels: m.changePixels, inkPixels: m.inkPixels, colours: m.distinctColours }));
}
const cells = {};
const measured = {};
for (const r of matrix) {
    const k = `${r.tag}/${r.writer}/${r.pages}`;
    cells[k] = r.failed ? { failed: true, exitCode: r.exitCode } : {
        published: r.published, fileBytes: r.fileBytes, jsPdfOutput: r.jsPdfOutput,
        encodedBytes: r.perPage.filter((p) => p.page).map((p) => p.encodedBytes),
        verifyOk: r.verify?.ok ?? null, verifyErrors: r.verify?.errors?.map((e) => e.split('\n')[0]) ?? null,
        pages: r.verify?.pages?.map((p) => ({
            size: `${p.widthPt}x${p.heightPt}`, orientation: p.orientation, image: `${p.imageWidth}x${p.imageHeight}`,
            pixelMismatches: p.pixelMismatches, changeRecall: p.changeRecall == null ? null : +p.changeRecall.toFixed(4),
            falseChange: p.falseChangePixels,
        })) ?? null,
    };
    measured[k] = { totalMs: r.totalMs, peakOverBaselineMiB: r.writerPeakOverBaselineMiB, sampledWriterPeakMiB: r.sampledWriterPeakMiB };
}
for (const r of sink) {
    measured[`sink:${r.tag}/${r.writer}/${r.pages}`] = { totalMs: r.totalMs, sampledWriterPeakMiB: r.sampledWriterPeakMiB, peakOverBaselineMiB: r.writerPeakOverBaselineMiB, fileBytes: r.fileBytes };
}
const summary = {
    run: RUN,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    dirty: spawnSync('git', ['status', '--porcelain', '--', 'research', 'src'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() !== '',
    node: process.version,
    chrome: chrome.chrome,
    structural: {
        composites,
        cells,
        preflightToday: budget.map((b) => `${b.dpi}/${b.pages}p/${b.preset}: ${b.accepted ? 'ACCEPT' : b.refusal} out=${b.outputMiB} peak=${b.jobPeakMiB}${b.achievable ? ` (${b.achievable})` : ''}`),
        proposedModel: model.model.map((m) => `${m.dpi}/${m.pages}p peak=${m.jobPeakMiB} outWorst=${m.outputWorstCaseMiB} memoryAccepts=${Object.values(m.acceptsAt).map((a) => (a ? 'Y' : 'n')).join('')} outBoundWithin256MiB=${m.outputBoundWithinMaxOutput}`),
        deflateBound: model.bound.map((b) => ({ input: b.input, withinZlibBound: b.withinZlibBound, fflateL6: b.fflateL6, zlib: b.nodeZlibDefault })),
        runtimeCeiling: { published: ceiling.published, refused: ceiling.refused, fileExists: ceilingFileExists },
        chromeCanvas: chrome.canvas.map((c) => ({ dpi: c.dpi, frame: `${c.width}x${c.height}`, ok: c.ok })),
        chromeCompressionStreamZlibHeader: chrome.compressionStream.zlibHeader,
        chromeViewerOpened: chrome.viewer.map((v) => ({ file: `${v.tag}/${v.name}`, loadError: v.loadError })),
    },
    measuredOnly: {
        steps,
        cells: measured,
        chromeCanvasMs: chrome.canvas.map((c) => c.ms),
        chromeViewerMs: chrome.viewer.map((v) => v.ms),
        chromeCompressionStream: chrome.compressionStream,
    },
};
summary.pass = Object.entries(cells).every(([k, c]) => {
    if (k === 'dpi300/current/1-5') return c.published === false && /undefined/.test(c.jsPdfOutput ?? '');
    return !c.failed && c.verifyOk === true;
}) && ceiling.published === false && !ceilingFileExists
    && chrome.canvas.every((c) => c.ok) && model.bound.every((b) => b.withinZlibBound);
fs.writeFileSync(path.join(EVIDENCE, `gate-${RUN}.json`), JSON.stringify(summary, null, 1));
console.log(`gate ${RUN}: ${summary.pass ? 'PASS' : 'FAIL'} (head ${summary.head}${summary.dirty ? ', dirty' : ''})`);
process.exit(summary.pass ? 0 : 1);
