/**
 * Every (fixture, candidate) cell in its own process; one JSON line each to
 * evidence/matrix-<run>.jsonl.
 *
 * Run: node harness/run-matrix.mjs --run m1 [--only f01]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };
const RUN = arg('run', 'm1');
const ONLY = arg('only', null);

const LOSSLESS = ['current', 'struct-chunked', 'r1-chunked', 'll-chunked', 'll-chunked-owned', 'll-chunked-pako', 'll-chunked-pako-fast', 'll-pdflib'];
const LOSSY = ['lossy-q85', 'lossy-q75', 'lossy-down2'];
const FIXTURES = ['f01-comparator-a1-150', 'f02-dense-drawing', 'f03-schedule', 'f04-gray-scan', 'f05-photo', 'f06-jpeg',
    'f07-mixed', 'f08-shared', 'f09-smask', 'f10-structure', 'f11-classes'];
const CELLS = [];
for (const f of FIXTURES) {
    for (const c of LOSSLESS) CELLS.push([f, c, []]);
    if (['f01-comparator-a1-150', 'f02-dense-drawing', 'f04-gray-scan', 'f05-photo'].includes(f)) for (const c of LOSSY) CELLS.push([f, c, []]);
}
CELLS.push(['f01-comparator-a1-150', 'll-chunked', ['--drop-source']]);
CELLS.push(['f01-comparator-a1-150', 'll-chunked-pako-fast', ['--drop-source']]);

const out = path.join(ROOT, 'evidence', `matrix-${RUN}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '');
for (const [fixture, cand, extra] of CELLS.filter(([f]) => !ONLY || f.startsWith(ONLY))) {
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=24000', path.join(HERE, 'run.mjs'),
        '--fixture', fixture, '--candidate', cand, ...extra], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 2 ** 20 });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const rec = r.status === 0 && line ? JSON.parse(line)
        : { fixture, candidate: cand, failed: true, exitCode: r.status, stderrTail: (r.stderr || '').split('\n').filter((l) => l && !l.startsWith('var ')).slice(-6) };
    rec.extra = extra;
    rec.wallMs = Date.now() - t;
    fs.appendFileSync(out, `${JSON.stringify(rec)}\n`);
    const v = rec.verify;
    console.log(`${fixture.padEnd(22)} ${(cand + (extra.length ? '*' : '')).padEnd(17)} `
        + (rec.failed ? `FAILED ${rec.stderrTail?.slice(-1)[0] ?? ''}`
            : `${String(rec.sourceBytes).padStart(10)} -> ${String(rec.outputBytes).padStart(10)} (${(rec.reduction * 100).toFixed(1)}%) peak+${rec.peakOverBaselineMiB} MiB ${rec.ms} ms verify=${v?.ok}${v?.errors?.length ? ` ${v.errors[0]}` : ''}`));
}
