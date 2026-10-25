/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The scale matrix in Node. NODE EVIDENCE: the same V8 as Chrome, a different
 * embedder, no page and no main thread to block. The browser numbers come from
 * bench-browser.mjs running this same scale-core.mjs in a page.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/bench-scale.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScaleMatrix } from './scale-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'results', 'scale-node.json');

const pad = (value, width) => String(value).padStart(width);
console.log(`${'shape'.padEnd(44)} ${pad('bytes', 10)} ${pad('B/sheet', 8)} ${pad('save', 8)} ${pad('open', 8)} ${pad('scan', 7)} ${pad('parse', 7)} ${pad('schema', 7)} ${pad('rel', 7)} ${pad('QA', 7)} ${pad('sort', 7)} ${pad('stale', 7)}`);

const result = runScaleMatrix((row) => {
    const s = row.open.stageMedians;
    console.log(`${row.label.padEnd(44)} ${pad(row.size.compactBytes, 10)} ${pad(row.size.bytesPerSheet, 8)} ${pad(row.save.exportTotal.medianMs, 8)} ${pad(row.open.importTotal.medianMs, 8)} ${pad(s.scanMs, 7)} ${pad(s.parseMs, 7)} ${pad(s.schemaMs, 7)} ${pad(s.relationsMs, 7)} ${pad(row.qa.evaluateAllRules.medianMs, 7)} ${pad(row.list.sortByNumber.medianMs, 7)} ${pad(row.stale.currencyOfEverything.medianMs, 7)}`);
});

const report = {
    notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic data. NODE evidence -- not a browser measurement.',
    runtime: 'node',
    environment: {
        node: process.version, v8: process.versions.v8, platform: `${os.platform()} ${os.release()}`, arch: os.arch(),
        cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)),
    },
    units: 'milliseconds; each figure is the median of `repeats` runs after one discarded warm-up',
    ...result,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nwritten: ${path.relative(process.cwd(), OUT)}`);
