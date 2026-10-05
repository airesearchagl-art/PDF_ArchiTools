/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Collects the evidence for one committed source head, in one pass.
 *
 * Evidence is only worth something if it is about a commit. This refuses to
 * run unless the source it is about to measure is exactly what is committed
 * (nothing modified, nothing untracked outside the two output directories), and
 * records that commit in everything it writes.
 *
 *   1. the research tests, and the mutation probes over them
 *   2. every benchmark, TWICE; after each pass the run-independent fields are
 *      extracted, and the two extractions must be identical; then every figure
 *      the documents quote is checked against the second pass
 *   3. the repository's own checks: `npm run build`, and ESLint with the
 *      findings inside this directory counted apart from the baseline
 *   4. the change against the base commit, which must touch nothing outside
 *      this directory; and, if a baseline build is supplied, a byte-for-byte
 *      comparison of the built app with the base commit's
 *
 * Writes evidence/gates.json, evidence/gates.md, evidence/tests.txt,
 * evidence/mutation-probe.json, evidence/structural.run1.json / run2.json, and
 * leaves the second pass's results and SUMMARY.md under benchmark/results/.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/collect-evidence.mjs \
 *        --base=<sha> [--baseline-dist=<path to dist built from the base commit>]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const EVIDENCE = path.join(ROOT, 'evidence');
const RESULTS = path.join(HERE, 'results');
const REL = 'research/m7-drawing-set-manager';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BASE = arg('base');
const BASELINE_DIST = arg('baseline-dist');
if (!BASE) { console.error('--base=<sha> is required'); process.exit(2); }

const run = (command, args, options = {}) => spawnSync(command, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: false, ...options });
const git = (...args) => run('git', args).stdout.trim();
const node = (...args) => run(process.execPath, args);
const log = (text) => console.log(`[evidence] ${text}`);

// -- 0. the source under test is exactly a commit -----------------------------
const head = git('rev-parse', 'HEAD');
const outputs = [`${REL}/evidence/`, `${REL}/benchmark/results/`];
const dirty = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .filter((line) => !outputs.some((prefix) => line.slice(3).replace(/"/g, '').startsWith(prefix)));
if (dirty.length > 0) {
    console.error(`the source is not what is committed:\n${dirty.join('\n')}`);
    process.exit(2);
}
log(`source head ${head}, clean`);
fs.mkdirSync(EVIDENCE, { recursive: true });

// -- 1. tests and mutation probes ---------------------------------------------
const tests = node('--test', `${REL}/tests/*.test.mjs`);
fs.writeFileSync(path.join(EVIDENCE, 'tests.txt'), `${tests.stdout}${tests.stderr}`);
const count = (label) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(tests.stdout)?.[1] ?? NaN);
const testSummary = { exitCode: tests.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
log(`tests: ${JSON.stringify(testSummary)}`);

const probe = node(`${REL}/tests/mutation-probe.mjs`);
const probeReport = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'mutation-probe.json'), 'utf8'));
const probeSummary = { exitCode: probe.status, probes: probeReport.probes, caught: probeReport.caught, filesRestored: probeReport.prototypeFilesRestoredByteIdentical };
log(`mutation probes: ${JSON.stringify(probeSummary)}`);

// -- 2. benchmarks, twice -----------------------------------------------------
const BENCHMARKS = ['bench-scale.mjs', 'bench-hostile.mjs', 'bench-fingerprint-node.mjs', 'bench-browser.mjs'];
const passes = [];
for (const pass of [1, 2]) {
    const started = Date.now();
    const exits = {};
    for (const script of BENCHMARKS) {
        const result = node(`${REL}/benchmark/${script}`);
        exits[script] = result.status;
        log(`pass ${pass}: ${script} exit ${result.status}`);
        if (result.status !== 0) console.error(result.stderr.split('\n').slice(0, 8).join('\n'));
    }
    const structural = node(`${REL}/benchmark/structural.mjs`);
    exits['structural.mjs'] = structural.status;
    const target = path.join(EVIDENCE, `structural.run${pass}.json`);
    fs.copyFileSync(path.join(RESULTS, 'structural.json'), target);
    passes.push({ pass, exits, seconds: Math.round((Date.now() - started) / 1000), structuralSha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
}
const structuralIdentical = passes[0].structuralSha256 === passes[1].structuralSha256;
const nodeAndBrowserAgree = JSON.parse(fs.readFileSync(path.join(RESULTS, 'structural.json'), 'utf8')).scale.nodeAndBrowserAgree;
log(`structural fields identical across the two passes: ${structuralIdentical}`);
const summarise = node(`${REL}/benchmark/summarise.mjs`);
const claimsRun = node(`${REL}/benchmark/check-claims.mjs`);
const claims = { exitCode: claimsRun.status, ...JSON.parse(fs.readFileSync(path.join(RESULTS, 'claims.json'), 'utf8')) };
log(`claims: ${JSON.stringify(claims)}`);

// -- 3. the repository's own checks -------------------------------------------
const eslintOut = path.join(os.tmpdir(), `m7-eslint-${process.pid}.json`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const eslint = run(npx, ['eslint', '.', '-f', 'json', '-o', eslintOut], { shell: process.platform === 'win32' });
const lint = { exitCode: eslint.status, filesLinted: 0, researchFilesLinted: 0, problemsInResearch: 0, problemsOutsideResearch: 0, filesWithProblemsOutsideResearch: [] };
for (const file of JSON.parse(fs.readFileSync(eslintOut, 'utf8'))) {
    const problems = file.errorCount + file.warningCount;
    const relative = path.relative(REPO, file.filePath).split(path.sep).join('/');
    lint.filesLinted += 1;
    if (relative.startsWith('research/')) { lint.researchFilesLinted += 1; lint.problemsInResearch += problems; }
    else { lint.problemsOutsideResearch += problems; if (problems > 0) lint.filesWithProblemsOutsideResearch.push(`${relative}: ${problems}`); }
}
fs.rmSync(eslintOut, { force: true });
log(`eslint: ${lint.problemsInResearch} in research, ${lint.problemsOutsideResearch} outside (pre-existing baseline)`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = run(npm, ['run', 'build'], { shell: process.platform === 'win32' });
log(`npm run build: exit ${build.status}`);

// -- 4. the change itself -----------------------------------------------------
const changed = git('diff', '--name-only', `${BASE}...HEAD`).split('\n').filter(Boolean);
const outside = changed.filter((file) => !file.startsWith(`${REL}/`));
const base = git('rev-parse', BASE);

const hashTree = (dir) => {
    const entries = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else entries.push(`${path.relative(dir, full).split(path.sep).join('/')} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
        }
    };
    walk(dir);
    return { files: entries.length, sha256: createHash('sha256').update(entries.join('\n')).digest('hex') };
};
let dist = { compared: false };
if (BASELINE_DIST && build.status === 0) {
    const ours = hashTree(path.join(REPO, 'dist'));
    const theirs = hashTree(path.resolve(BASELINE_DIST));
    dist = { compared: true, thisHead: ours, baseCommit: theirs, byteIdentical: ours.sha256 === theirs.sha256 && ours.files === theirs.files };
    log(`built app byte-identical to the base commit's: ${dist.byteIdentical}`);
}

// -- write --------------------------------------------------------------------
const gates = {
    notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Generated by benchmark/collect-evidence.mjs.',
    collectedAt: new Date().toISOString(),
    sourceHead: head, sourceDirty: false, baseCommit: base,
    change: { files: changed.length, outsideResearchDirectory: outside, productionSourceDelta: changed.filter((f) => f.startsWith('src/')).length },
    tests: testSummary, mutationProbes: probeSummary,
    benchmarks: { passes, structuralIdenticalAcrossPasses: structuralIdentical, nodeAndBrowserScaleRowsAgree: nodeAndBrowserAgree, summariseExit: summarise.status },
    claims,
    eslint: lint, build: { exitCode: build.status }, builtApp: dist,
};
fs.writeFileSync(path.join(EVIDENCE, 'gates.json'), `${JSON.stringify(gates, null, 2)}\n`);

const yes = (value) => (value ? 'yes' : '**NO**');
const md = [
    '# Gate record',
    '',
    '> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**',
    '> Generated by `benchmark/collect-evidence.mjs`. Do not edit by hand; `gates.json` is the same record as data.',
    '',
    `- Source head measured: \`${head}\` (working tree clean: nothing modified, nothing untracked outside the output directories)`,
    `- Base commit: \`${base}\``,
    `- Collected: ${gates.collectedAt}`,
    '',
    '## The change',
    '',
    '| | |',
    '|---|---|',
    `| Files changed against the base (\`git diff --name-only ${base.slice(0, 7)}...HEAD\`) | ${changed.length} |`,
    `| Files outside \`${REL}/\` | **${outside.length}** |`,
    `| Files under \`src/\` | **${gates.change.productionSourceDelta}** |`,
    dist.compared ? `| Built app (\`dist/\`) byte-identical to a build of the base commit | ${yes(dist.byteIdentical)} — ${dist.thisHead.files} files, tree digest \`${dist.thisHead.sha256.slice(0, 16)}…\` both |` : '| Built app compared with the base commit | not compared in this run |',
    '',
    '## Research tests',
    '',
    '| | |',
    '|---|---|',
    `| \`node --test "${REL}/tests/*.test.mjs"\` | ${testSummary.pass} pass, ${testSummary.fail} fail, ${testSummary.skipped} skipped (exit ${testSummary.exitCode}) |`,
    `| Mutation probes (\`tests/mutation-probe.mjs\`) | ${probeSummary.caught} of ${probeSummary.probes} caught; prototype files restored byte-identical: ${yes(probeSummary.filesRestored)} |`,
    '',
    '## Benchmarks, two passes',
    '',
    '| Pass | bench-scale | bench-hostile | bench-fingerprint-node | bench-browser | structural | seconds | `structural.json` SHA-256 |',
    '|---|---|---|---|---|---|---|---|',
    ...passes.map((p) => `| ${p.pass} | exit ${p.exits['bench-scale.mjs']} | exit ${p.exits['bench-hostile.mjs']} | exit ${p.exits['bench-fingerprint-node.mjs']} | exit ${p.exits['bench-browser.mjs']} | exit ${p.exits['structural.mjs']} | ${p.seconds} | \`${p.structuralSha256.slice(0, 16)}…\` |`),
    '',
    `- Structural fields identical across the two passes: ${yes(structuralIdentical)}`,
    `- The same synthetic Projects are the same bytes in Node and in Chrome: ${yes(nodeAndBrowserAgree)}`,
    '- Times and memory are measured-only and are not compared. `benchmark/results/` holds the second pass.',
    `- Figures quoted in the documents, checked against the second pass (\`check-claims.mjs\`): ${claims.statements} statements, ${claims.checks} checks, **${claims.failed} failed**`,
    '',
    '## The repository\'s own checks',
    '',
    '| | |',
    '|---|---|',
    `| \`npm run build\` (\`tsc -b && vite build\`) | exit ${build.status} |`,
    `| \`npx eslint .\` — findings inside \`research/\` | **${lint.problemsInResearch}** (${lint.researchFilesLinted} files linted) |`,
    `| \`npx eslint .\` — findings outside \`research/\` | ${lint.problemsOutsideResearch}, all in files this change does not touch (the pre-existing baseline; not modified) |`,
    ...lint.filesWithProblemsOutsideResearch.map((line) => `| | \`${line}\` |`),
    '',
    'Core CI runs on the pull request and is recorded there, not here.',
    '',
].join('\n');
fs.writeFileSync(path.join(EVIDENCE, 'gates.md'), md);
log('written: evidence/gates.json, evidence/gates.md');

const ok = testSummary.exitCode === 0 && probeSummary.exitCode === 0 && structuralIdentical && nodeAndBrowserAgree
    && passes.every((p) => Object.values(p.exits).every((code) => code === 0)) && claims.exitCode === 0
    && outside.length === 0 && build.status === 0 && lint.problemsInResearch === 0 && (!dist.compared || dist.byteIdentical);
process.exit(ok ? 0 : 1);
