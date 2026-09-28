/**
 * Runs every (tag, writer, pages) cell in its own process, sequentially, and
 * appends one JSON line per cell to evidence/matrix-<run>.jsonl.
 *
 * Run: node harness/run-matrix.mjs --run r1 [--only dpi150]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg('run', 'r1');
const ONLY = arg('only', null);

const LOSSLESS_150 = [
    'rgb-flate', 'rgb-up', 'rgb-paeth', 'rgb-adaptive',
    'idx4c-flate', 'idx4c-up',
    'idx4m-flate', 'idx4m-up', 'idx4m-flate-L1', 'idx4m-flate-L9', 'idx4m-cs', 'idx4m-cs-up',
];
const CELLS = [
    // 150 dpi: the reported failure, reproduced with the production sink.
    ['dpi150', 'current', '1-3'],
    ['dpi150', 'current', '1-5'],
    ...LOSSLESS_150.map((w) => ['dpi150', w, '1-5']),
    ['dpi150', 'idx4m-down2', '1-5'],
    ['dpi150', 'jpeg-q90', '1-5'],
    ['dpi150', 'jpeg-q75', '1-5'],
    ['dpi150-tol0.15', 'idx4m-flate', '1-5'],
    ['dpi150-tol0.15', 'idx4c-flate', '1-5'],
    ['dpi72', 'idx4m-flate', '1-5'],
    // 300 dpi.
    ['dpi300', 'current', '1-1'],
    ['dpi300', 'current', '1-5'],
    ['dpi300', 'rgb-up', '1-5'],
    ['dpi300', 'idx4m-flate', '1-5'],
    ['dpi300', 'idx4m-up', '1-5'],
    ['dpi300', 'idx4m-cs', '1-5'],
    ['dpi300', 'idx4m-cs-up', '1-5'],
    ['dpi300', 'jpeg-q90', '1-5'],
    // 450 dpi.
    ['dpi450', 'current', '1-1'],
    ['dpi450', 'rgb-up', '1-5'],
    ['dpi450', 'idx4m-flate', '1-5'],
    ['dpi450', 'idx4m-up', '1-5'],
    ['dpi450', 'idx4m-cs', '1-5'],
    ['dpi450', 'idx4m-cs-up', '1-5'],
    ['dpi450', 'jpeg-q90', '1-5'],
];
// Writer-own memory: inputs preloaded, write window sampled (write.mjs --sink-only).
const SINK_CELLS = [
    ['dpi150', 'current', '1-3'],
    ['dpi150', 'current', '1-5'],
    ['dpi150', 'idx4m-up', '1-5'],
    ['dpi150', 'idx4m-cs', '1-5'],
    ['dpi150', 'idx4m-cs-up', '1-5'],
    ['dpi300', 'current', '1-1'],
    ['dpi300', 'idx4m-up', '1-5'],
    ['dpi300', 'idx4m-cs', '1-5'],
    ['dpi300', 'idx4m-cs-up', '1-5'],
    ['dpi450', 'current', '1-1'],
    ['dpi450', 'idx4m-up', '1-5'],
    ['dpi450', 'idx4m-cs', '1-5'],
    ['dpi450', 'idx4m-cs-up', '1-5'],
].map((c) => [...c, 'sink']);
const SET = arg('set', 'main');
const CELLS_RUN = (SET === 'sink' ? SINK_CELLS : CELLS).filter(([tag]) => !ONLY || tag === ONLY);

const out = path.join(ROOT, 'evidence', `matrix-${RUN}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '');
for (const [tag, writer, pages, mode] of CELLS_RUN) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [
        '--max-old-space-size=24000', '--expose-gc', path.join(HERE, 'write.mjs'),
        '--tag', tag, '--writer', writer, '--pages', pages,
        ...(mode === 'sink' ? ['--sink-only', '--no-verify'] : []),
    ], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    let rec;
    if (r.status === 0 && line) {
        rec = JSON.parse(line);
        if (rec.verify?.pages) for (const p of rec.verify.pages) delete p.text;
    } else {
        rec = {
            tag, writer, pages, failed: true, exitCode: r.status, signal: r.signal,
            stderrTail: (r.stderr || '').split('\n').filter(Boolean).slice(-6),
        };
    }
    rec.wallMs = Date.now() - t;
    fs.appendFileSync(out, `${JSON.stringify(rec)}\n`);
    const v = rec.verify;
    console.log(`${tag.padEnd(15)} ${writer.padEnd(16)} ${pages} `
        + (rec.failed ? `FAILED exit=${rec.exitCode} ${rec.stderrTail?.slice(-1)[0] ?? ''}`
            : `${String(rec.fileMiB).padStart(9)} MiB  peak+${rec.writerPeakOverBaselineMiB} MiB  sampled+${rec.sampledWriterPeakMiB} MiB  ${rec.totalMs} ms  verify=${v?.ok}${v?.errors?.length ? ` ${v.errors[0]}` : ''}`));
}
