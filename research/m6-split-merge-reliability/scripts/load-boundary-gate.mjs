/**
 * The M6 Load Boundary Sub-Spike gate (B3).
 *
 * B3 was accepted with a defence order: a pre-parse hard boundary first, a
 * disposable Worker second, and a Worker alone never enough. This gate checks
 * both halves and keeps them apart:
 *
 *   node half     the boundary's answer, and the stage that gives it, for every
 *                 shape pdf-lib's load can expand — L16 refused at the walk, L16b
 *                 only by the decoded-content scan; the decode hard stop exactly
 *                 at a cap and one byte over, per stream and cumulatively; the
 *                 boundary's own bounds; a differential oracle that runs the real
 *                 pdf-lib load — one process per fixture, one process for the
 *                 ordinary corpus — and checks that on every document the
 *                 boundary passes, pdf-lib decodes no more than the boundary
 *                 counted; a sweep of mutated documents for parser-shape
 *                 closure; B2's K; today's route (BASELINE-FAIL); the
 *                 compatibility corpus; and B2 composed behind B3
 *   browser half  a disposable Worker: transfer in and out, cancellation,
 *                 timeout, typed failure, a refusal inside the Worker before the
 *                 load it prevents, and — measured only — responsiveness and
 *                 which memory APIs exist
 *
 * Only node-half rows bear on whether B3 can close. The browser half is defence
 * in depth, and `closureCriteria` in the evidence is computed without it.
 *
 * Classifications, as in the other gates:
 *
 *   ASSERT        a deterministic structural invariant that must hold, and does
 *   PROBE         a threat or parser-shape probe: input that must be refused, or
 *                 a sweep that must find nothing the boundary under-counts
 *   MEASURE       compatibility, timings, browser and Worker observations,
 *                 reported without a verdict and never promoted to a threshold
 *   BASELINE-FAIL today's unsafe direct pdf-lib load, reproduced on purpose
 *   HUMAN-OPEN    a decision this research may not take
 *
 * Verdicts rest on EXACT structure — a refusal code and stage, a byte count, an
 * entry count, a call count, a detached buffer's length, a message count. Every
 * evidence field that can differ between two runs of the same source is named
 * MeasuredOnly (or is ranAt).
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-load-boundary-fixtures.mjs
 *       node research/m6-split-merge-reliability/scripts/load-boundary-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { inspectLoadBoundary, inflateBounded } from '../prototype/load-boundary.mjs';
import { reachableGraph } from '../prototype/object-graph-memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.resolve(HERE, '..');
const ROOT = path.resolve(RESEARCH, '..', '..');
const CORPUS_ROOT = path.join(ROOT, 'test-fixtures');
const FIX = path.join(CORPUS_ROOT, 'm6-load-boundary');
const SWEEP = path.join(FIX, 'sweep');
const ORACLE = path.join(HERE, 'load-boundary-oracle.mjs');
const PORT = 5217;
const ORIGIN = `http://localhost:${PORT}`;
const MIB = 1024 * 1024;
const MAX_OUTPUT_BYTES = 268435456;
const ONE_DOCUMENT_TIMEOUT_MS = 180000;
const BATCH_TIMEOUT_MS = 1200000;

if (!fs.existsSync(path.join(FIX, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-m6-load-boundary-fixtures.mjs')], { stdio: 'inherit' });
}
const { testLimits: LIMITS, fixtureCount, fixtures } = JSON.parse(fs.readFileSync(path.join(FIX, 'corpus.json'), 'utf8'));
const fmt = (n) => Number(n).toLocaleString('en-US');
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

const rows = [];
let half = 'node';
const say = (kind, name, ok, detail, criterion) => {
    rows.push({ kind, half, name, ok, criterion });
    const mark = ok === null ? '····' : (ok ? 'PASS' : 'FAIL');
    console.log(`  ${mark}  [${kind}] ${name}${detail ? `  ${detail}` : ''}`);
};
const assert_ = (name, ok, detail = '', criterion = null) => say('ASSERT', name, !!ok, detail, criterion);
const probe = (name, ok, detail = '', criterion = null) => say('PROBE', name, !!ok, detail, criterion);
const measure = (name, detail = '') => say('MEASURE', name, null, detail, null);
const baselineFail = (name, reproduced, detail = '') => say('BASELINE-FAIL', name, !!reproduced, detail, null);
const humanOpen = (name, detail = '') => say('HUMAN-OPEN', name, null, detail, null);

/**
 * What B3 needs before it could be called closed with a hard pre-load boundary.
 * Each is met only if at least one node-half row carries it and every such row
 * passed. Browser rows carry none.
 */
const CRITERIA = {
    'pre-load-refusal': 'every dangerous shape is refused before PDFDocument.load is called',
    'own-bounds': 'the boundary is itself bounded: decode, chunk, retention and parse work',
    'decode-surface-coverage': 'every load-time decode passes through what the oracle observes, and the oracle is not blind',
    'differential-zero-false-negatives': 'no known document the boundary passes makes pdf-lib decode more than the boundary counted',
    'exact-boundary': 'exactly a cap is allowed and one byte over is refused, per stream and cumulatively',
    'ambiguity-fail-closed': 'ambiguous or unsupported syntax is refused, never guessed at',
};
const AMBIGUITY_CODES = new Set([
    'MALFORMED_SYNTAX', 'UNEXPECTED_BYTES', 'AMBIGUOUS_NAME_ESCAPE', 'AMBIGUOUS_STREAM_LENGTH', 'AMBIGUOUS_DECLARED_VALUE',
    'DUPLICATE_KEY_ON_DECODE_STREAM', 'NESTING_DEPTH', 'UNSUPPORTED_FILTER',
]);
/** Refusals that mean a document may be a bomb: its oracle run gets a process of its own. */
const HOSTILE_CODES = new Set([
    'INPUT_TOO_LARGE', 'DECODED_BYTES_PER_STREAM', 'DECODED_BYTES_TOTAL', 'XREF_ENTRY_CAP', 'OBJECT_STREAM_OBJECT_CAP', 'TOO_MANY_DECODE_STREAMS',
]);

const evidence = {
    provenance: {}, limits: LIMITS, fixtureCount: null, fixtures: {}, stageRules: {}, decodeBound: {}, ownBounds: {},
    oracle: {}, differential: {}, sweep: {}, compatibility: {}, composed: {}, worker: {}, closureCriteria: {},
    workerRowsCountTowardClosure: false, rows: [], measuredOnly: {},
};

/**
 * pdf-lib's real load, observed, in one child process for all of `files`. A
 * file with no result line — the process failed, was killed at the timeout, or
 * ran out of memory — comes back as `oracleFailed`, which no check reads as safe.
 */
function oracle(files, timeoutMs) {
    const run = spawnSync(process.execPath, [ORACLE, '-'], {
        cwd: ROOT, input: files.join('\n'), encoding: 'utf8', maxBuffer: 256 * MIB, timeout: timeoutMs, killSignal: 'SIGKILL',
    });
    const seen = new Map();
    for (const line of (run.stdout ?? '').split(/\r?\n/)) {
        if (!line.startsWith('{"file":')) continue;
        try {
            const o = JSON.parse(line);
            seen.set(o.file, o);
        } catch { /* a torn last line is no result */ }
    }
    const failure = run.error ? String(run.error.code ?? run.error.message) : (run.status !== 0 ? `exit ${run.status} ${run.signal ?? ''}`.trim() : 'no result line');
    return files.map((file) => seen.get(file) ?? { file, oracleFailed: failure });
}

/** On a passed document: pdf-lib stayed within what the boundary counted, and that within the caps. */
const covers = (v, o) => !!o && !o.oracleFailed
    && o.decodedBytesTotal <= v.stats.decodedBytesTotal
    && o.maxDecodedBytes <= v.stats.maxStreamDecodedBytes
    && o.loadDecodeCalls <= v.stats.decodeStreams
    && o.xrefEntries <= v.stats.xrefEntriesDeclared
    && v.stats.decodedBytesTotal <= LIMITS.maxDecodedBytesTotal
    && v.stats.maxStreamDecodedBytes <= LIMITS.maxDecodedBytesPerStream
    && v.stats.xrefEntriesDeclared <= LIMITS.maxXrefEntries;
/** Every decode during the load went through the load path the oracle counts. */
const oneRoute = (o) => !!o && !o.oracleFailed && o.filterDecodeCalls === o.loadDecodeCalls;
const oracleRecord = (o) => {
    const { file, ...rest } = o;
    return { file: rel(path.resolve(ROOT, file)), ...rest };
};

let exitCode = 1;
let server = null;
let browser = null;
try {
    // ---- 1. provenance ------------------------------------------------------------
    console.log('\n=== 1. provenance ===');
    const require_ = createRequire(import.meta.url);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const versionOf = (spec) => require_(require_.resolve(`${spec}/package.json`, { paths: [ROOT] })).version;
    evidence.provenance = {
        productionBase: git(['rev-parse', 'origin/main']),
        researchBranchAtRun: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        testedResearchHead: git(['rev-parse', 'HEAD']),
        researchPackageDirtyBeforeRun: git([
            'status', '--porcelain=v1', '--untracked-files=all', '--',
            'research/m6-split-merge-reliability',
            ':!research/m6-split-merge-reliability/evidence.json',
            ':!research/m6-split-merge-reliability/evidence-browser.json',
            ':!research/m6-split-merge-reliability/evidence-object-graph-memory.json',
            ':!research/m6-split-merge-reliability/evidence-load-boundary.json',
        ]).length > 0,
        coreCiRunsThisGate: false,
        dependencies: { 'pdf-lib': versionOf('pdf-lib'), pako: versionOf('pako') },
        node: process.version,
        ranAt: new Date().toISOString(),
    };
    measure('production base', evidence.provenance.productionBase);
    measure('research head', `${evidence.provenance.testedResearchHead} (package dirty before run: ${evidence.provenance.researchPackageDirtyBeforeRun})`);
    assert_('this gate is local research evidence, not something Core CI runs', evidence.provenance.coreCiRunsThisGate === false);
    assert_('the pdf-lib whose load is being bounded is the pinned 1.17.1', evidence.provenance.dependencies['pdf-lib'] === '1.17.1');
    measure('decoder the boundary uses', `pako ${evidence.provenance.dependencies.pako}, resolved from the repository's installed tree — not a declared dependency`);
    measure('test limits (research values, not product values)', JSON.stringify(LIMITS));

    const presentFixtures = fixtures.filter((f) => fs.existsSync(path.join(FIX, `${f.name}.pdf`)));
    evidence.fixtureCount = { declared: fixtureCount, listed: fixtures.length, present: presentFixtures.length };
    assert_('every generated load-boundary fixture is present', fixtureCount === fixtures.length && presentFixtures.length === fixtures.length,
        `${fixtures.length} listed, ${presentFixtures.length} on disk`);
    measure('load-boundary fixtures generated', `${fixtures.length}`);

    // ---- 2. the boundary's answer and stage, shape by shape --------------------------
    console.log('\n=== 2. the boundary, shape by shape ===');
    const verdicts = {};
    const preParserMs = {};
    const shapes = [
        ...fixtures.map((f) => ({ ...f, file: path.join(FIX, `${f.name}.pdf`) })),
        {
            name: 'mem-k-objstm-inflation', expect: 'REFUSE', code: 'DECODED_BYTES_PER_STREAM', stage: 'decode',
            file: path.join(CORPUS_ROOT, 'm6-object-graph-memory', 'mem-k-objstm-inflation.pdf'),
            baselineRisk: 'decode', note: 'B2 fixture K: 33,149 B decoding to 33,554,457 B', regression: true,
        },
    ];
    for (const shape of shapes) {
        if (!fs.existsSync(shape.file)) {
            assert_(`${shape.name}: fixture present`, false, rel(shape.file));
            continue;
        }
        const bytes = new Uint8Array(fs.readFileSync(shape.file));
        const started = process.hrtime.bigint();
        const verdict = await inspectLoadBoundary(bytes, LIMITS);
        preParserMs[shape.name] = Number(process.hrtime.bigint() - started) / 1e6;
        verdicts[shape.name] = verdict;
        evidence.fixtures[shape.name] = {
            expect: shape.expect, expectedCode: shape.code, expectedStage: shape.stage,
            verdict: verdict.verdict, code: verdict.code ?? null, stage: verdict.stage, reason: verdict.reason ?? null, stats: verdict.stats,
        };
        const ok = verdict.verdict === shape.expect
            && (shape.expect === 'PASS' || (verdict.code === shape.code && verdict.stage === shape.stage));
        const detail = verdict.verdict === 'PASS'
            ? `PASS — ${fmt(verdict.stats.decodeStreams)} decode stream(s), ${fmt(verdict.stats.decodedBytesTotal)} B decoded`
            : `${verdict.code} at ${verdict.stage}: ${verdict.reason}`;
        const label = shape.regression ? `${shape.name} (B2 K regression)` : shape.name;
        if (shape.expect === 'PASS') {
            assert_(`${label}: passes every stage`, ok, detail);
        } else {
            probe(`${label}: refused before load as ${shape.code} at ${shape.stage}`, ok, detail,
                AMBIGUITY_CODES.has(shape.code) ? 'ambiguity-fail-closed' : 'pre-load-refusal');
        }
    }
    evidence.measuredOnly.preParserMsMeasuredOnly = preParserMs;
    const v = (name) => verdicts[name];

    // ---- 3. L16 and L16b: which stage refuses -----------------------------------------------
    //
    // The boundary runs walk, then name attribution, then decoding. L16 must be
    // refused by the first of those, L16b by nothing before the last.
    console.log('\n=== 3. stage rules: L16 at the walk, L16b only at the decoded-content scan ===');
    const l16 = v('lb-l16-type-inside-objstm');
    evidence.stageRules.l16 = { code: l16?.code, stage: l16?.stage, stagesCompleted: l16?.stats.stagesCompleted, decodeStreams: l16?.stats.decodeStreams };
    assert_('L16: refused at the walk by the indirect-/Type rule — before attribution, before any decode',
        l16?.code === 'INDIRECT_TYPE_ON_STREAM' && l16.stage === 'walk'
        && !l16.stats.stagesCompleted.includes('attribution') && l16.stats.decodeStreams === 0 && l16.stats.maxMaterializedDecodedBytes === 0,
        `${l16?.code} at ${l16?.stage}; stages completed ${l16?.stats.stagesCompleted.join(' → ')}; ${l16?.stats.decodeStreams} stream(s) decoded`,
        'pre-load-refusal');
    const l16b = v('lb-l16b-name-inside-objstm');
    evidence.stageRules.l16b = {
        code: l16b?.code, stage: l16b?.stage, stagesCompleted: l16b?.stats.stagesCompleted,
        rawDecodeTypeNames: l16b?.stats.rawDecodeTypeNames, attributedDecodeTypeNames: l16b?.stats.attributedDecodeTypeNames, decodeStreams: l16b?.stats.decodeStreams,
    };
    assert_('L16b: the walk and name attribution let it through; only the decoded-content scan refuses it',
        l16b?.code === 'DECODE_TYPE_NAME_IN_DECODED_CONTENT' && l16b.stage === 'decoded-content'
        && l16b.stats.stagesCompleted.includes('walk') && l16b.stats.stagesCompleted.includes('attribution')
        && l16b.stats.rawDecodeTypeNames === 1 && l16b.stats.attributedDecodeTypeNames === 1 && l16b.stats.decodeStreams === 1,
        `${l16b?.code} at ${l16b?.stage}; stages completed ${l16b?.stats.stagesCompleted.join(' → ')}; `
        + `raw ObjStm/XRef names ${l16b?.stats.rawDecodeTypeNames}, all attributed (${l16b?.stats.attributedDecodeTypeNames}); ${l16b?.stats.decodeStreams} stream decoded`,
        'pre-load-refusal');

    // ---- 4. the decode hard bound: exactly the cap, and one byte over -------------------------
    console.log('\n=== 4. decode hard bound ===');
    const PER = LIMITS.maxDecodedBytesPerStream;
    const TOTAL = LIMITS.maxDecodedBytesTotal;
    const CHUNK = LIMITS.inflateChunkBytes;
    const deflated = (n) => zlib.deflateSync(Buffer.alloc(n, 0x20), { level: 9 });
    const strip = ({ bytes, ...rest }) => rest;
    const atCap = inflateBounded(deflated(PER), PER, CHUNK);
    const overCap = inflateBounded(deflated(PER + 1), PER, CHUNK);
    const bomb = inflateBounded(deflated(32 * MIB), PER, CHUNK);
    evidence.decodeBound.inflate = { atCap: strip(atCap), overCap: strip(overCap), bomb32MiB: strip(bomb) };
    assert_('decoder, per-stream cap exactly: allowed, every byte decoded',
        !atCap.exceeded && !atCap.error && atCap.decoded === PER, `${fmt(atCap.decoded)} B decoded against a ${fmt(PER)} B cap`, 'exact-boundary');
    assert_('decoder, per-stream cap + 1: refused, with no more than the cap plus one chunk ever decoded',
        overCap.exceeded === true && overCap.materialized > PER && overCap.materialized <= PER + CHUNK,
        `stopped with ${fmt(overCap.materialized)} B materialised (bound ${fmt(PER + CHUNK)} B)`, 'exact-boundary');
    assert_('decoder, a 32 MiB stream against the cap: stopped mid-stream, not decoded then measured',
        bomb.exceeded === true && bomb.materialized <= PER + CHUNK && bomb.chunks <= Math.ceil(PER / CHUNK) + 1 && bomb.consumedInputBytes < bomb.inputBytes,
        `${fmt(bomb.materialized)} B materialised in ${bomb.chunks} chunks; ${fmt(bomb.consumedInputBytes)} of ${fmt(bomb.inputBytes)} input bytes read`, 'own-bounds');

    const s11 = v('lb-l11-per-stream-exact');
    const s12 = v('lb-l12-per-stream-plus-one');
    const c11 = v('lb-l11c-total-exact');
    const c12 = v('lb-l12c-total-plus-one');
    evidence.decodeBound.documents = {
        perStreamExact: { verdict: s11?.verdict, maxStreamDecodedBytes: s11?.stats.maxStreamDecodedBytes },
        perStreamPlusOne: { code: s12?.code, stage: s12?.stage, refusedDecode: s12?.stats.refusedDecode },
        totalExact: { verdict: c11?.verdict, decodedBytesTotal: c11?.stats.decodedBytesTotal, maxStreamDecodedBytes: c11?.stats.maxStreamDecodedBytes },
        totalPlusOne: { code: c12?.code, stage: c12?.stage, decodedBytesTotal: c12?.stats.decodedBytesTotal, refusedDecode: c12?.stats.refusedDecode },
    };
    assert_('per-stream cap, whole document: a stream of exactly the cap passes',
        s11?.verdict === 'PASS' && s11.stats.maxStreamDecodedBytes === PER, `${fmt(s11?.stats.maxStreamDecodedBytes)} B`, 'exact-boundary');
    assert_('per-stream cap + 1, whole document: refused at decode, stopped within the cap plus one chunk',
        s12?.code === 'DECODED_BYTES_PER_STREAM' && s12.stage === 'decode' && s12.stats.refusedDecode?.limit === PER
        && s12.stats.refusedDecode.materialized <= PER + CHUNK,
        `${s12?.code} at ${s12?.stage}; ${fmt(s12?.stats.refusedDecode?.materialized)} B materialised`, 'exact-boundary');
    assert_('cumulative cap, whole document: streams totalling exactly the cap pass, each under the per-stream cap',
        c11?.verdict === 'PASS' && c11.stats.decodedBytesTotal === TOTAL && c11.stats.maxStreamDecodedBytes <= PER,
        `${fmt(c11?.stats.decodedBytesTotal)} B in total`, 'exact-boundary');
    assert_('cumulative cap + 1, whole document: refused at decode by the cumulative cap, the last stream stopped at what remained',
        c12?.code === 'DECODED_BYTES_TOTAL' && c12.stage === 'decode' && c12.stats.decodedBytesTotal === TOTAL - 40
        && c12.stats.refusedDecode?.limit === 40 && c12.stats.refusedDecode.materialized <= 40 + CHUNK,
        `${c12?.code} at ${c12?.stage}; ${fmt(c12?.stats.decodedBytesTotal)} B accepted, last stream limited to ${c12?.stats.refusedDecode?.limit} B`, 'exact-boundary');

    const decodeRefusals = Object.entries(verdicts).filter(([, x]) => x.stage === 'decode' && x.stats.refusedDecode);
    assert_('every refusal at the decode stage stopped within its limit plus one chunk',
        decodeRefusals.length > 0 && decodeRefusals.every(([, x]) => x.stats.refusedDecode.materialized <= x.stats.refusedDecode.limit + CHUNK),
        `${decodeRefusals.length} decode-stage refusals`, 'own-bounds');
    const bombs = decodeRefusals.filter(([name]) => shapes.find((s) => s.name === name)?.baselineRisk === 'decode');
    assert_('every 32 MiB-class stream was abandoned before its input was read to the end',
        bombs.length > 0 && bombs.every(([, x]) => x.stats.refusedDecode.consumedInputBytes < x.stats.refusedDecode.inputBytes),
        bombs.map(([name, x]) => `${name} ${fmt(x.stats.refusedDecode.consumedInputBytes)}/${fmt(x.stats.refusedDecode.inputBytes)}`).join('; '), 'own-bounds');

    // ---- 5. the boundary's own bounds ----------------------------------------------------------
    console.log('\n=== 5. the boundary\'s own bounds ===');
    const all = Object.values(verdicts);
    const ownBounds = (list) => ({
        maxMaterializedDecodedBytes: Math.max(0, ...list.map((x) => x.stats.maxMaterializedDecodedBytes)),
        maxInflateChunkBytes: Math.max(0, ...list.map((x) => x.stats.maxInflateChunkBytes)),
        maxRetainedDecodedBytes: Math.max(0, ...list.map((x) => x.stats.maxRetainedDecodedBytes)),
        parseWorkOverBytes: list.filter((x) => x.stats.parsedValues > x.stats.inputBytes + x.stats.decodedBytesTotal).length,
    });
    evidence.ownBounds.fixtures = ownBounds(all);
    const ob = evidence.ownBounds.fixtures;
    assert_('no decode materialised more than the per-stream cap plus one inflate chunk',
        ob.maxMaterializedDecodedBytes <= PER + CHUNK, `largest ${fmt(ob.maxMaterializedDecodedBytes)} B against ${fmt(PER)} + ${fmt(CHUNK)} B`, 'own-bounds');
    assert_('no inflate chunk exceeded the configured chunk size', ob.maxInflateChunkBytes <= CHUNK,
        `${fmt(ob.maxInflateChunkBytes)} B against ${fmt(CHUNK)} B`, 'own-bounds');
    assert_('no decoded object stream was kept beyond the per-stream cap', ob.maxRetainedDecodedBytes <= PER,
        `${fmt(ob.maxRetainedDecodedBytes)} B kept at most`, 'own-bounds');
    assert_('parse work is linear: no document made the boundary parse more values than it has raw plus decoded bytes',
        ob.parseWorkOverBytes === 0, `${ob.parseWorkOverBytes} over`, 'own-bounds');
    const deep = v('lb-l23-deep-nesting');
    assert_('the boundary\'s own recursion stops at its depth limit, with a typed refusal', deep?.code === 'NESTING_DEPTH' && deep.stage === 'walk',
        `${deep?.code} at ${deep?.stage}`, 'own-bounds');

    // ---- 6. the oracle: pdf-lib's real load, one process per fixture ----------------------------
    //
    // For every document the boundary passes, pdf-lib must decode no more bytes,
    // no larger stream, no more streams and build no more xref entries than the
    // boundary counted, and those counts must sit within the caps. For every
    // document it refuses, today's route is what the refusal prevents.
    console.log('\n=== 6. differential oracle on the fixtures ===');
    const observed = {};
    for (const shape of shapes) {
        const [o] = oracle([rel(shape.file)], ONE_DOCUMENT_TIMEOUT_MS);
        observed[shape.name] = o;
        evidence.oracle[shape.name] = oracleRecord(o);
    }
    const fixtureRuns = Object.values(observed);
    const failedRuns = fixtureRuns.filter((o) => o.oracleFailed);
    assert_('the oracle returned a result for every fixture, each in its own process — none failed or hung',
        failedRuns.length === 0, `${fixtureRuns.length - failedRuns.length} of ${fixtureRuns.length}${failedRuns.length ? `; failed: ${failedRuns.map((o) => `${o.file} (${o.oracleFailed})`).join(', ')}` : ''}`,
        'decode-surface-coverage');
    const l9o = observed['lb-l9-clean-objstm'];
    const l1o = observed['lb-l1-objstm-inflation'];
    const l2bo = observed['lb-l2b-xref-declared-entries'];
    assert_('the oracle is not blind: it sees an ordinary object-stream decode, a 32 MiB decode, and a million declared entries',
        l9o?.loadDecodeCalls >= 1 && l1o?.decodedBytesTotal >= 32 * MIB && l2bo?.xrefEntries === 1000000,
        `L9 ${l9o?.loadDecodeCalls} decode(s); L1 ${fmt(l1o?.decodedBytesTotal)} B; L2b ${fmt(l2bo?.xrefEntries)} entries`, 'decode-surface-coverage');
    const offRoute = fixtureRuns.filter((o) => !oneRoute(o));
    assert_('during every fixture load, every filter decode went through the load decode the oracle counts',
        offRoute.length === 0, `${fixtureRuns.length - offRoute.length} of ${fixtureRuns.length} on one route`, 'decode-surface-coverage');

    const passShapes = shapes.filter((s) => verdicts[s.name]?.verdict === 'PASS');
    const undercounted = passShapes.filter((s) => !covers(verdicts[s.name], observed[s.name]));
    const passedDangerous = shapes.filter((s) => s.expect === 'REFUSE' && verdicts[s.name]?.verdict === 'PASS');
    evidence.differential.fixtures = {
        passed: passShapes.map((s) => s.name), undercounted: undercounted.map((s) => s.name), expectedRefusalsPassed: passedDangerous.map((s) => s.name),
    };
    assert_('every fixture the boundary passes: pdf-lib decoded no more than the boundary counted, within the caps',
        undercounted.length === 0, `${passShapes.length} passed; ${undercounted.length ? `undercounted: ${undercounted.map((s) => s.name).join(', ')}` : 'none undercounted'}`,
        'differential-zero-false-negatives');
    assert_('no fixture that must be refused was passed',
        passedDangerous.length === 0, `${passedDangerous.length} passed`, 'differential-zero-false-negatives');

    for (const shape of shapes.filter((s) => s.baselineRisk)) {
        const o = observed[shape.name];
        let reproduced = false;
        let detail = '';
        if (shape.baselineRisk === 'decode') {
            reproduced = !!o && !o.oracleFailed && o.decodedBytesTotal > LIMITS.maxDecodedBytesTotal;
            detail = `pdf-lib decoded ${fmt(o?.decodedBytesTotal)} B in ${o?.decodeCalls} call(s)${o?.loaded ? '' : `, then ${o?.errorKind}`}`;
        } else if (shape.baselineRisk === 'entries') {
            reproduced = !!o && !o.oracleFailed && o.xrefEntries > LIMITS.maxXrefEntries;
            detail = `pdf-lib built ${fmt(o?.xrefEntries)} xref entries from ${fmt(o?.decodedBytesTotal)} decoded bytes`;
        } else if (shape.baselineRisk === 'reparse') {
            reproduced = !!o && !o.oracleFailed && o.decodedBytesTotal === shape.decodedBytes && shape.reparsedBytes >= 20 * shape.decodedBytes;
            detail = `${fmt(shape.decodedBytes)} B decoded, ${fmt(shape.reparsedBytes)} B parsed as objects — nothing checked the offsets${o?.loaded ? '' : `; ${o?.errorKind}`}`;
        }
        baselineFail(`today's route: ${shape.name}`, reproduced,
            `${detail}; peak RSS +${fmt(Math.round((o?.peakRssGrowthMeasuredOnly ?? 0) / MIB))} MiB (MEASURED_ONLY)`);
    }
    const encrypted = observed['lb-l18-encrypted-objstm'];
    probe('pdf-lib decodes an encrypted document\'s object stream before its encryption check refuses it',
        encrypted?.errorKind === 'ENCRYPTED_PDF' && encrypted.decodedBytesTotal > LIMITS.maxDecodedBytesTotal,
        `${fmt(encrypted?.decodedBytesTotal)} B decoded, then ${encrypted?.errorKind}`);
    const l21o = observed['lb-l21-lowercase-escape-filter'];
    const l21fixture = shapes.find((s) => s.name === 'lb-l21-lowercase-escape-filter');
    probe('a lowercase #xx escape really is read two ways: pdf-lib takes the stored bytes as they are, more than they inflate to',
        l21o?.loadDecodeCalls === 1 && l21o.decodedBytesTotal > 0 && l21o.decodedBytesTotal === fs.readFileSync(l21fixture.file).toString('latin1').match(/stream\n([\s\S]*?)\nendstream/)?.[1].length,
        `pdf-lib decoded ${l21o?.decodedBytesTotal} B — the raw stream data, unfiltered`);

    const conservative = shapes.filter((s) => verdicts[s.name]?.verdict === 'REFUSE' && !s.baselineRisk
        && observed[s.name]?.loaded === true && observed[s.name].decodedBytesTotal <= TOTAL && observed[s.name].xrefEntries <= LIMITS.maxXrefEntries);
    evidence.differential.conservativeFixtureRefusals = conservative.map((s) => `${s.name}: ${verdicts[s.name].code}@${verdicts[s.name].stage}`);
    measure('fixtures refused that pdf-lib loads within the caps (conservative refusals, compatibility cost)',
        conservative.map((s) => s.name).join(', ') || 'none');

    // ---- 7. parser-shape sweep: mutated documents -------------------------------------------------
    //
    // Deterministic truncations, substitutions and insertions of three clean
    // documents. The boundary may refuse any of them. Every one it passes goes
    // through the real load, in one process, and must be covered.
    console.log('\n=== 7. parser-shape sweep ===');
    fs.rmSync(SWEEP, { recursive: true, force: true });
    fs.mkdirSync(SWEEP, { recursive: true });
    const INTERESTING = [0x20, 0x0a, 0x0d, 0x00, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x28, 0x29, 0x25, 0x23, 0x30, 0x39, 0x52, 0x65, 0x73, 0x6e, 0x2d, 0x2e];
    let seed = 0x6d36b3;
    const next = () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed;
    };
    const sweepSources = ['lb-l9-clean-objstm', 'lb-l5-hybrid-clean', 'lb-l4b-prev-cycle'];
    const mutants = [];
    for (const source of sweepSources) {
        const original = fs.readFileSync(path.join(FIX, `${source}.pdf`));
        const add = (id, bytes) => mutants.push({ id: `${source}#${id}`, file: path.join(SWEEP, `${source}-${id}.pdf`), bytes });
        for (let i = 1; i <= 48; i += 1) add(`t${i}`, original.subarray(0, Math.floor((original.length * i) / 49)));
        for (let i = 0; i < 96; i += 1) {
            const copy = Buffer.from(original);
            copy[next() % copy.length] = INTERESTING[next() % INTERESTING.length];
            add(`s${i}`, copy);
        }
        for (let i = 0; i < 48; i += 1) {
            const at = next() % original.length;
            add(`i${i}`, Buffer.concat([original.subarray(0, at), Buffer.from([INTERESTING[next() % INTERESTING.length]]), original.subarray(at)]));
        }
    }
    const sweepVerdicts = new Map();
    const sweepByOutcome = {};
    for (const m of mutants) {
        fs.writeFileSync(m.file, m.bytes);
        const verdict = await inspectLoadBoundary(new Uint8Array(m.bytes), LIMITS);
        sweepVerdicts.set(rel(m.file), { id: m.id, verdict });
        const key = verdict.verdict === 'PASS' ? 'PASS' : `${verdict.code}@${verdict.stage}`;
        sweepByOutcome[key] = (sweepByOutcome[key] ?? 0) + 1;
    }
    const sweepPass = [...sweepVerdicts.entries()].filter(([, x]) => x.verdict.verdict === 'PASS').map(([file]) => file);
    const sweepObserved = oracle(sweepPass, BATCH_TIMEOUT_MS);
    const sweepFailed = sweepObserved.filter((o) => o.oracleFailed);
    const sweepUnder = sweepObserved.filter((o) => !covers(sweepVerdicts.get(o.file).verdict, o));
    const sweepOffRoute = sweepObserved.filter((o) => !o.oracleFailed && !oneRoute(o));
    evidence.sweep = {
        sources: sweepSources, mutants: mutants.length, byOutcome: sweepByOutcome, passed: sweepPass.length,
        oracleResults: sweepObserved.length - sweepFailed.length, oracleFailed: sweepFailed.map((o) => o.file),
        undercounted: sweepUnder.map((o) => sweepVerdicts.get(o.file).id), offRoute: sweepOffRoute.map((o) => sweepVerdicts.get(o.file).id),
        passedButPdfLibFailed: sweepObserved.filter((o) => o.loaded === false).length,
    };
    measure('mutants inspected, and what the boundary answered', `${mutants.length} mutants: ${JSON.stringify(sweepByOutcome)}`);
    probe('every mutant the boundary passes: pdf-lib decoded no more than the boundary counted',
        sweepFailed.length === 0 && sweepUnder.length === 0,
        `${sweepPass.length} passed, ${sweepObserved.length - sweepFailed.length} loaded through the oracle in one process, ${sweepUnder.length} undercounted`,
        'differential-zero-false-negatives');
    probe('during every passed mutant\'s load, every filter decode went through the counted load decode',
        sweepFailed.length === 0 && sweepOffRoute.length === 0, `${sweepOffRoute.length} off route`, 'decode-surface-coverage');

    // ---- 8. compatibility: the repository's other documents ----------------------------------------
    console.log('\n=== 8. compatibility corpus ===');
    const corpusFiles = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== FIX) walk(full);
            } else if (entry.name.toLowerCase().endsWith('.pdf')) {
                corpusFiles.push(full);
            }
        }
    };
    walk(CORPUS_ROOT);
    corpusFiles.sort((a, b) => (rel(a) < rel(b) ? -1 : 1));
    const corpusVerdicts = {};
    const byVerdict = {};
    const byDirectory = {};
    const corpusStarted = process.hrtime.bigint();
    for (const file of corpusFiles) {
        const verdict = await inspectLoadBoundary(new Uint8Array(fs.readFileSync(file)), LIMITS);
        const r = rel(file);
        corpusVerdicts[r] = verdict;
        const key = verdict.verdict === 'PASS' ? 'PASS' : `${verdict.code}@${verdict.stage}`;
        byVerdict[key] = (byVerdict[key] ?? 0) + 1;
        const dir = path.relative(CORPUS_ROOT, file).replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.';
        byDirectory[dir] = byDirectory[dir] ?? { pass: 0, refuse: 0 };
        byDirectory[dir][verdict.verdict === 'PASS' ? 'pass' : 'refuse'] += 1;
    }
    const corpusInspectMs = Number(process.hrtime.bigint() - corpusStarted) / 1e6;
    const isolated = Object.keys(corpusVerdicts).filter((r) => HOSTILE_CODES.has(corpusVerdicts[r].code));
    const batched = Object.keys(corpusVerdicts).filter((r) => !HOSTILE_CODES.has(corpusVerdicts[r].code));
    const oracleStarted = process.hrtime.bigint();
    const corpusObserved = [
        ...oracle(batched, BATCH_TIMEOUT_MS),
        ...isolated.flatMap((r) => oracle([r], ONE_DOCUMENT_TIMEOUT_MS)),
    ];
    const corpusOracleMs = Number(process.hrtime.bigint() - oracleStarted) / 1e6;
    const byFile = new Map(corpusObserved.map((o) => [o.file, o]));
    const corpusPass = Object.keys(corpusVerdicts).filter((r) => corpusVerdicts[r].verdict === 'PASS');
    const corpusFailed = corpusObserved.filter((o) => o.oracleFailed);
    const corpusUnder = corpusPass.filter((r) => !covers(corpusVerdicts[r], byFile.get(r)));
    const corpusOffRoute = corpusObserved.filter((o) => !oneRoute(o));
    const refusedLoaded = Object.keys(corpusVerdicts).filter((r) => corpusVerdicts[r].verdict === 'REFUSE' && byFile.get(r)?.loaded === true);
    const conservativeCorpus = refusedLoaded.filter((r) => byFile.get(r).decodedBytesTotal <= TOTAL && byFile.get(r).xrefEntries <= LIMITS.maxXrefEntries);
    evidence.ownBounds.corpus = ownBounds(Object.values(corpusVerdicts));
    evidence.compatibility = {
        documents: corpusFiles.length,
        oracleSingleProcessDocuments: batched.length,
        oracleIsolatedDocuments: isolated,
        byVerdict,
        byDirectory,
        refused: Object.fromEntries(Object.entries(corpusVerdicts).filter(([, x]) => x.verdict !== 'PASS').map(([r, x]) => [r, `${x.code}@${x.stage}: ${x.reason}`])),
        oracleResults: corpusObserved.length - corpusFailed.length,
        oracleFailed: corpusFailed.map((o) => `${o.file}: ${o.oracleFailed}`),
        passedButPdfLibFailed: corpusPass.filter((r) => byFile.get(r)?.loaded === false),
        refusedPdfLibLoads: refusedLoaded.length,
        refusedPdfLibLoadsWithinCaps: conservativeCorpus.length,
        refusedPdfLibFails: Object.keys(corpusVerdicts).filter((r) => corpusVerdicts[r].verdict === 'REFUSE' && byFile.get(r)?.loaded === false).length,
        undercounted: corpusUnder,
        offRoute: corpusOffRoute.map((o) => o.file),
    };
    evidence.measuredOnly.corpusInspectMsMeasuredOnly = corpusInspectMs;
    evidence.measuredOnly.corpusOracleMsMeasuredOnly = corpusOracleMs;
    measure('documents inspected across the repository\'s other fixture corpora',
        `${corpusFiles.length} — every one synthetic; no real drawing was available. Oracle: ${batched.length} in one process, ${isolated.length} isolated as possible bombs`);
    measure('boundary verdicts by code and stage', JSON.stringify(byVerdict));
    measure('conservative refusals: refused, yet pdf-lib loads them within the caps (compatibility cost)',
        `${conservativeCorpus.length} of ${corpusFiles.length}; refused and pdf-lib also fails: ${evidence.compatibility.refusedPdfLibFails}`);
    measure('boundary and oracle time over the corpus (MEASURED_ONLY)', `boundary ${Math.round(corpusInspectMs)} ms; oracle ${Math.round(corpusOracleMs)} ms`);
    assert_('the oracle returned a result for every corpus document — none failed or hung',
        corpusFailed.length === 0 && corpusObserved.length === corpusFiles.length,
        `${corpusObserved.length - corpusFailed.length} of ${corpusFiles.length}`, 'decode-surface-coverage');
    assert_('every corpus document the boundary passes: pdf-lib decoded no more than the boundary counted, within the caps',
        corpusUnder.length === 0, `${corpusPass.length} passed; ${corpusUnder.length} undercounted${corpusUnder.length ? `: ${corpusUnder.join(', ')}` : ''}`,
        'differential-zero-false-negatives');
    assert_('during every corpus load, every filter decode went through the counted load decode',
        corpusOffRoute.length === 0, `${corpusObserved.length - corpusOffRoute.length} of ${corpusObserved.length} on one route`, 'decode-surface-coverage');
    const cb = evidence.ownBounds.corpus;
    assert_('over the corpus too, the boundary stayed within its own decode, chunk, retention and parse-work bounds',
        cb.maxMaterializedDecodedBytes <= PER + CHUNK && cb.maxInflateChunkBytes <= CHUNK && cb.maxRetainedDecodedBytes <= PER && cb.parseWorkOverBytes === 0,
        JSON.stringify(cb), 'own-bounds');

    // ---- 9. the composed contract, end to end ----------------------------------------------------
    //
    // B3 in front of B2: bound the load, then load, then plan the copy from the
    // loaded graph, copy, and write — each stage using only a term the stage
    // before it made available. A refusal at the first stage means no load.
    console.log('\n=== 9. B2 + B3 composed ===');
    for (const [name, file] of [
        ['lb-l9-clean-objstm', path.join(FIX, 'lb-l9-clean-objstm.pdf')],
        ['lb-l10-clean-classic', path.join(FIX, 'lb-l10-clean-classic.pdf')],
        ['lb-l11c-total-exact', path.join(FIX, 'lb-l11c-total-exact.pdf')],
        ['mem-k-objstm-inflation', path.join(CORPUS_ROOT, 'm6-object-graph-memory', 'mem-k-objstm-inflation.pdf')],
    ]) {
        const bytes = new Uint8Array(fs.readFileSync(file));
        const stage1 = await inspectLoadBoundary(bytes, LIMITS);
        let composed = { stage1: stage1.verdict, stage1Code: stage1.code ?? null, loadCalled: false };
        if (stage1.verdict === 'PASS') {
            composed.loadCalled = true;
            const source = await PDFDocument.load(bytes, { updateMetadata: false });
            const plan = reachableGraph(source, [0]);
            const output = await PDFDocument.create({ updateMetadata: false });
            const before = output.context.enumerateIndirectObjects().length;
            (await output.copyPages(source, [0])).forEach((p) => output.addPage(p));
            const copied = output.context.enumerateIndirectObjects().length - before;
            const saved = await output.save({ useObjectStreams: false });
            composed = {
                ...composed, stage3PlannedObjects: plan.destinationObjects, stage4CopiedObjects: copied,
                stage6OutputUnderCeiling: saved.length <= MAX_OUTPUT_BYTES,
            };
        }
        evidence.composed[name] = composed;
        if (name === 'mem-k-objstm-inflation') {
            assert_('K: refused at the first stage, so pdf-lib\'s load is never called',
                composed.stage1 === 'REFUSE' && composed.loadCalled === false, JSON.stringify(composed));
        } else {
            assert_(`${name}: boundary passes, then load, plan, copy and write each stay within the term before them`,
                composed.stage1 === 'PASS' && composed.stage3PlannedObjects === composed.stage4CopiedObjects && composed.stage6OutputUnderCeiling,
                JSON.stringify(composed));
        }
    }

    // ---- 10. the Worker, in a browser: defence in depth, not closure ------------------------------
    console.log('\n=== 10. a disposable Worker (browser half — defence in depth) ===');
    half = 'browser';
    const { createServer } = await import('vite');
    const puppeteer = (await import('puppeteer')).default;
    server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
    await server.listen();
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    const external = [];
    const pageErrors = [];
    page.on('request', (request) => {
        const url = request.url();
        if (!url || url.startsWith(ORIGIN)) return;
        try {
            const { protocol } = new URL(url);
            if (protocol === 'http:' || protocol === 'https:') external.push(url);
        } catch { /* data:, blob: */ }
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    browser.on('targetcreated', async (target) => {
        if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
        try {
            const session = await target.createCDPSession();
            await session.send('Network.enable');
            session.on('Network.requestWillBeSent', (e) => {
                const url = e.request?.url;
                if (url && !url.startsWith(ORIGIN) && /^https?:/.test(url)) external.push(url);
            });
        } catch { /* gone */ }
    });
    await page.goto(`${ORIGIN}/research/m6-split-merge-reliability/scripts/load-boundary-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__b3Ready === true, { timeout: 120000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__b3[f](...a), fn, args);

    const transfer = await call('transfer', 'lb-l10-clean-classic');
    evidence.worker.transfer = transfer;
    assert_('the input is transferred, not copied: the page\'s buffer is detached once posted',
        transfer.mainSideInputAfterPost === 0 && transfer.receivedBytes === transfer.sentBytes,
        `${fmt(transfer.sentBytes)} B sent, ${transfer.mainSideInputAfterPost} B left on the page, ${fmt(transfer.receivedBytes)} B received`);
    assert_('the output comes back transferred, and the Worker\'s copy is detached',
        transfer.outputByteLength > 0 && transfer.workerSideOutputAfterTransfer === 0,
        `${fmt(transfer.outputByteLength)} B returned, ${transfer.workerSideOutputAfterTransfer} B left in the Worker`);
    assert_('a terminated Worker answers nothing afterwards', transfer.answeredAfterTerminate === 0, String(transfer.answeredAfterTerminate));

    const cancelled = await call('cancel', 'lb-l13-slow-parse', 30);
    evidence.worker.cancel = cancelled;
    assert_('cancelling a load in progress — started, not ended — terminates it, and no result arrives after',
        cancelled.loadStarted === true && cancelled.endedBeforeTerminate === false && cancelled.afterTerminate === 0, JSON.stringify(cancelled));

    const timedOut = await call('timeout', 'lb-l13-slow-parse', 30);
    evidence.worker.timeout = timedOut;
    assert_('a load that outlives its budget, counted from its start, becomes a typed TIMEOUT, and nothing arrives late',
        timedOut.outcome === 'TIMEOUT' && timedOut.loadStarted === true && timedOut.lateMessages === 0, JSON.stringify(timedOut));

    const errors = await call('errors');
    evidence.worker.errors = errors;
    assert_('a caught failure, a synchronous uncaught throw and an unhandled rejection each reach the page as a typed outcome',
        errors.caught === 'LOAD_FAILED' && errors.uncaughtAsErrorEvent === 'WORKER_ERROR' && errors.rejected === 'UNHANDLED_REJECTION',
        JSON.stringify(errors));
    measure('what an unhandled rejection raises on the Worker object by itself',
        `${errors.rejectedErrorEvents} error event(s) — without the Worker's own listener, a rejection reaches the page as nothing, and only a timeout would notice`);

    const refusedInWorker = await call('preflightInWorker', 'lb-l1-objstm-inflation', LIMITS);
    const refusedLateInWorker = await call('preflightInWorker', 'lb-l16b-name-inside-objstm', LIMITS);
    const passedInWorker = await call('preflightInWorker', 'lb-l10-clean-classic', LIMITS);
    evidence.worker.preflight = { l1: refusedInWorker, l16b: refusedLateInWorker, l10: passedInWorker };
    assert_('inside the Worker, the boundary refuses L1 and L16b with their codes and stages before pdf-lib loads them, and lets a clean document through',
        refusedInWorker.outcome === 'REFUSED' && refusedInWorker.code === 'DECODED_BYTES_PER_STREAM' && refusedInWorker.stage === 'decode' && refusedInWorker.loaded === false
        && refusedLateInWorker.outcome === 'REFUSED' && refusedLateInWorker.code === 'DECODE_TYPE_NAME_IN_DECODED_CONTENT' && refusedLateInWorker.stage === 'decoded-content'
        && refusedLateInWorker.loaded === false && passedInWorker.outcome === 'DONE',
        `L1 ${refusedInWorker.outcome} ${refusedInWorker.code}@${refusedInWorker.stage}; L16b ${refusedLateInWorker.outcome} ${refusedLateInWorker.code}@${refusedLateInWorker.stage}; L10 ${passedInWorker.outcome}`);

    const onMain = await call('responsiveness', 'lb-l13-slow-parse', 'main');
    const inWorker = await call('responsiveness', 'lb-l13-slow-parse', 'worker');
    evidence.measuredOnly.responsiveness = { main: onMain, worker: inWorker };
    measure('longest gap in the page\'s own timer during a slow load (MEASURED_ONLY)',
        `main thread ${Math.round(onMain.worstTimerGapMsMeasuredOnly)} ms; Worker ${Math.round(inWorker.worstTimerGapMsMeasuredOnly)} ms — responsiveness, not a memory bound`);

    const memoryApi = await call('memoryApi');
    evidence.worker.memoryApi = memoryApi;
    measure('whether this page can measure or cap a Worker\'s memory',
        `measureUserAgentSpecificMemory: ${memoryApi.measureUserAgentSpecificMemory}, crossOriginIsolated: ${memoryApi.crossOriginIsolated} — and no API sets a per-Worker ceiling`);

    evidence.worker.externalRequests = external;
    evidence.worker.pageErrors = pageErrors;
    assert_('no external HTTP(S) request from the page or its Workers', external.length === 0, external.join(', ') || 'external HTTP(S) = 0');

    half = 'node';
    humanOpen('M6-H11 / B3 production load-boundary architecture',
        'whether a pre-parse boundary is adopted as the load contract; which decoder production uses (pako, resolved here only '
        + 'transitively, or another whose chunking is not source-derived); the limit values; where it runs (main thread or Worker); '
        + 'and whether its strict-syntax refusals are acceptable for real drawings, which this research could not measure');

    // ---- 11. what the rows say about closure ------------------------------------------------------
    console.log('\n=== 11. closure criteria (node half only) ===');
    for (const [key, what] of Object.entries(CRITERIA)) {
        const tagged = rows.filter((r) => r.half === 'node' && r.criterion === key);
        const met = tagged.length > 0 && tagged.every((r) => r.ok === true);
        evidence.closureCriteria[key] = { what, rows: tagged.length, met };
        console.log(`  ${met ? 'met    ' : 'NOT MET'}  ${key} (${tagged.length} rows) — ${what}`);
    }
    evidence.rows = rows;

    fs.writeFileSync(path.join(RESEARCH, 'evidence-load-boundary.json'), `${JSON.stringify(evidence, null, 2)}\n`);

    const counted = rows.filter((r) => r.ok !== null);
    const failed = counted.filter((r) => !r.ok);
    const byKind = (kind, h = null) => rows.filter((r) => r.kind === kind && (h === null || r.half === h)).length;
    console.log(`\n  ASSERT ${byKind('ASSERT')}  PROBE ${byKind('PROBE')}  MEASURE ${byKind('MEASURE')}  `
        + `BASELINE-FAIL ${byKind('BASELINE-FAIL')}  HUMAN-OPEN ${byKind('HUMAN-OPEN')}`);
    for (const h of ['node', 'browser']) {
        const c = counted.filter((r) => r.half === h);
        console.log(`  ${h} half: ${c.filter((r) => r.ok).length}/${c.length} verifiable rows passed`);
    }
    console.log(`  ${counted.length - failed.length}/${counted.length} verifiable rows passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - [${f.kind}] ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nload-boundary gate failed: ${error?.stack ?? error}\n`);
} finally {
    if (browser) await browser.close();
    if (server) await server.close();
}
process.exit(exitCode);
