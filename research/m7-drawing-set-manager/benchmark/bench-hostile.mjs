/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * What the import bounds buy, measured both ways.
 *
 *   bounded     each hostile input through the real import pipeline with the
 *               candidate limits: where it is refused, how long that took, and
 *               the process's peak memory.
 *   unbounded   the same input handed straight to JSON.parse, which is what an
 *               importer without a pre-parse stage does: time, retained heap,
 *               peak memory -- or the way it failed.
 *
 * Each case runs in its own child process so its peak memory is its own. All
 * inputs are generated in memory; nothing is written to disk but the results.
 *
 * NODE EVIDENCE. V8 is the same engine as Chrome's, so the shape of these
 * numbers carries over; the absolute heap sizes of a browser tab do not.
 *
 * Run: node research/m7-drawing-set-manager/benchmark/bench-hostile.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OUT = path.join(HERE, 'results', 'hostile-node.json');
const MiB = 1024 * 1024;

const PROJECT_HEAD = '{"format":"pdf-architools/drawing-set-project","schemaVersion":1,"junk":';

/** Build one input as text. Kept as functions so only the child pays for it. */
const INPUTS = {
    'deep nesting, 1,000,000 levels': () => `${PROJECT_HEAD}${'['.repeat(1_000_000)}${']'.repeat(1_000_000)}}`,
    'array of 16,000,000 numbers': () => `${PROJECT_HEAD}[${'0,'.repeat(16_000_000 - 1)}0]}`,
    'array of 10,000,000 empty objects': () => `${PROJECT_HEAD}[${'{},'.repeat(10_000_000 - 1)}{}]}`,
    'one 32 MiB string': () => `${PROJECT_HEAD}"${'QUJD'.repeat((32 * MiB) / 4)}"}`,
    'object with 2,000,000 distinct keys': () => {
        const parts = [];
        for (let i = 0; i < 2_000_000; i += 1) parts.push(`"k${i}":0`);
        return `${PROJECT_HEAD}{${parts.join(',')}}}`;
    },
    // Just inside every scan bound: the costliest thing the scan lets through.
    'worst case inside the bounds: 3,999,990 empty objects': () => `${PROJECT_HEAD}[${'{},'.repeat(3_999_990 - 1)}{}]}`,
    '500,000 strings of 100 characters': () => `${PROJECT_HEAD}[${`"${'x'.repeat(100)}",`.repeat(500_000 - 1)}"${'x'.repeat(100)}"]}`,
};

const peakRssMiB = () => Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
const heapMiB = () => Number((process.memoryUsage().heapUsed / MiB).toFixed(1));

async function child(mode, name) {
    const { importProject, exportProject } = await import('../prototype/project-io.mjs');
    const { CANDIDATE_LIMITS } = await import('../prototype/limits.proposed.mjs');
    const encoder = new TextEncoder();
    const now = Date.UTC(2026, 9, 6);

    if (mode === 'largest-accepted') {
        // A real, valid Project grown with maximum-length comments until it is
        // just under the byte bound: the most expensive file the importer says yes to.
        const { buildSyntheticProject } = await import('../prototype/synthetic-project.mjs');
        const { seededUuidSource } = await import('../prototype/ids.mjs');
        const { model, now: builtAt, newId } = buildSyntheticProject({ sheets: 5000 });
        const set = model.drawingSet;
        const nextSequence = new Map();
        for (const decision of set.decisions) nextSequence.set(decision.findingId, Math.max(nextSequence.get(decision.findingId) ?? 0, decision.sequence));
        const comment = '図面番号の重複について確認。'.repeat(285).slice(0, CANDIDATE_LIMITS.maxCommentLength);
        const target = Number(name) * MiB;
        let estimate = 9.2 * MiB;
        let i = 0;
        const perDecision = encoder.encode(comment).length + 260;
        while (estimate + perDecision < target) {
            const finding = set.findings[i % set.findings.length];
            const sequence = (nextSequence.get(finding.id) ?? 0) + 1;
            nextSequence.set(finding.id, sequence);
            set.decisions.push({ id: newId(), findingId: finding.id, sequence, outcome: 'HOLD', comment, decidedAt: new Date(builtAt).toISOString(), evidenceDigest: finding.evidenceDigest });
            estimate += perDecision;
            i += 1;
        }
        const ids = seededUuidSource(5);
        const t0 = performance.now();
        const exported = exportProject(model, { now: builtAt, newFileId: ids() });
        const exportMs = performance.now() - t0;
        const bytes = exported.bytes;
        globalThis.gc?.();
        const heapBefore = heapMiB();
        const t1 = performance.now();
        const verdict = importProject(bytes, { now: builtAt + 1000 });
        const importMs = performance.now() - t1;
        globalThis.gc?.();
        const retained = heapMiB() - heapBefore;
        return {
            bytes: bytes.length, MiB: Number((bytes.length / MiB).toFixed(2)), decisions: set.decisions.length,
            status: verdict.status, exportMs: Number(exportMs.toFixed(0)), importMs: Number(importMs.toFixed(0)),
            stages: Object.fromEntries(Object.entries(verdict.timings).map(([k, v]) => [k, Number(v.toFixed(0))])),
            retainedHeapMiB: Number(retained.toFixed(1)), peakRssMiB: peakRssMiB(),
        };
    }

    const text = INPUTS[name]();
    if (mode === 'bounded') {
        const bytes = encoder.encode(text);
        const t0 = performance.now();
        const verdict = importProject(bytes, { now });
        const ms = performance.now() - t0;
        return {
            inputMiB: Number((bytes.length / MiB).toFixed(2)), status: verdict.status, stage: verdict.stage, code: verdict.code,
            refusedInMs: Number(ms.toFixed(1)), reachedJsonParse: verdict.timings?.parseMs !== undefined, peakRssMiB: peakRssMiB(),
        };
    }

    // unbounded: JSON.parse and nothing else.
    globalThis.gc?.();
    const heapBefore = heapMiB();
    const t0 = performance.now();
    let outcome = 'parsed';
    let value;
    try { value = JSON.parse(text); } catch (error) { outcome = `${error.name}: ${String(error.message).slice(0, 60)}`; }
    const parseMs = performance.now() - t0;
    globalThis.gc?.();
    const retained = heapMiB() - heapBefore;
    // What a naive validator would do next: walk it.
    let walk = 'not attempted';
    if (outcome === 'parsed') {
        const visit = (node) => { if (node && typeof node === 'object') for (const item of Array.isArray(node) ? node : Object.values(node)) visit(item); };
        const w0 = performance.now();
        try { visit(value); walk = `walked in ${(performance.now() - w0).toFixed(0)} ms`; } catch (error) { walk = `${error.name}: ${String(error.message).slice(0, 40)}`; }
    }
    return {
        inputMiB: Number((text.length / MiB).toFixed(2)), jsonParse: outcome, parseMs: Number(parseMs.toFixed(0)),
        retainedHeapMiB: Number(retained.toFixed(1)), heapPerInputByte: Number((retained / (text.length / MiB)).toFixed(1)),
        recursiveWalk: walk, peakRssMiB: peakRssMiB(),
    };
}

function runChild(mode, name) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', SELF, '--child', mode, name], { encoding: 'utf8', maxBuffer: 16 * MiB });
    if (result.status !== 0) return { crashed: true, exitCode: result.status, signal: result.signal, stderr: (result.stderr ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300) };
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

if (process.argv[2] === '--child') {
    const result = await child(process.argv[3], process.argv[4]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
    const cases = [];
    for (const name of Object.keys(INPUTS)) {
        const bounded = runChild('bounded', name);
        const unbounded = runChild('unbounded', name);
        cases.push({ input: name, bounded, unbounded });
        console.log(`${name}\n  bounded:   ${JSON.stringify(bounded)}\n  unbounded: ${JSON.stringify(unbounded)}`);
    }
    const accepted = [];
    for (const targetMiB of ['16', '32', '63']) {
        const row = runChild('largest-accepted', targetMiB);
        accepted.push({ targetMiB: Number(targetMiB), ...row });
        console.log(`largest accepted, target ${targetMiB} MiB: ${JSON.stringify(row)}`);
    }
    const report = {
        notice: 'RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL. Synthetic inputs generated in memory. NODE evidence -- not a browser measurement.',
        runtime: 'node',
        environment: { node: process.version, v8: process.versions.v8, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model },
        notes: [
            'Each case ran in its own child process (node --expose-gc --max-old-space-size=8192); peakRssMiB is that process\'s peak resident set, which includes building the input.',
            'retainedHeapMiB is V8 heap still reachable after a forced GC, with the parsed value held.',
            'bounded = the real import pipeline with CANDIDATE_LIMITS. unbounded = JSON.parse alone.',
        ],
        hostile: cases,
        largestAccepted: accepted,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwritten: ${path.relative(process.cwd(), OUT)}`);
}
