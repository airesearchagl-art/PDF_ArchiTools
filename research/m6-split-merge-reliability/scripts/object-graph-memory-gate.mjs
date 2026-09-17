/**
 * The M6 Object-Graph Memory Sub-Spike gate (B2).
 *
 * M6-H11 was adopted with the memory model UNKNOWN and every memory preset NOT
 * ADOPTABLE. This gate is where that UNKNOWN is taken apart. It does not propose
 * a number. It asks, of pdf-lib 1.17.1 as installed, which terms of a Split or
 * Merge's memory can be known before the work that creates them — and it checks
 * each claim against a real copy rather than letting a model agree with itself.
 *
 * Classifications, as in the other two gates:
 *
 *   ASSERT        something that must hold, and does
 *   PROBE         a negative probe: input that must make a check fire
 *   MEASURE       a number, reported without a verdict
 *   BASELINE-FAIL a defect in today's production behaviour, reproduced on purpose
 *   HUMAN-OPEN    a decision this research may not take
 *
 * Every verdict here rests on a structural number — an object count or a stream
 * byte total, EXACT and the same on every run — or on two lengths compared
 * inside one run. Output lengths themselves move between runs, because the
 * production route writes the time into the file, so they are MEASURED_ONLY
 * like heap, RSS, array-buffer and collectability readings from the child
 * process run with --expose-gc: named so, and deciding nothing.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-memory-fixtures.mjs
 *       node research/m6-split-merge-reliability/scripts/object-graph-memory-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { reachableGraph, contextTotals } from '../prototype/object-graph-memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.resolve(HERE, '..');
const ROOT = path.resolve(RESEARCH, '..', '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm6-object-graph-memory');
const PHASE = path.join(HERE, 'object-graph-memory-phase.mjs');

if (!fs.existsSync(path.join(FIX, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-m6-memory-fixtures.mjs')], { stdio: 'inherit' });
}
const corpus = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(FIX, 'corpus.json'), 'utf8')).map((entry) => [entry.name, entry]),
);
const bytesOf = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, `${name}.pdf`)));
const fmt = (n) => Number(n).toLocaleString('en-US');
const MIB = 1024 * 1024;
const mib = (n) => `${(n / MIB).toFixed(1)} MiB`;

const rows = [];
const say = (kind, name, ok, detail) => {
    rows.push({ kind, name, ok });
    const mark = ok === null ? '····' : (ok ? 'PASS' : 'FAIL');
    console.log(`  ${mark}  [${kind}] ${name}${detail ? `  ${detail}` : ''}`);
};
const assert_ = (name, ok, detail = '') => say('ASSERT', name, !!ok, detail);
const probe = (name, ok, detail = '') => say('PROBE', name, !!ok, detail);
const measure = (name, detail = '') => say('MEASURE', name, null, detail);
const baselineFail = (name, reproduced, detail = '') => say('BASELINE-FAIL', name, !!reproduced, detail);
const humanOpen = (name, detail = '') => say('HUMAN-OPEN', name, null, detail);

const evidence = { provenance: {}, corpus: {}, cases: {}, structural: {}, measuredOnly: {} };

/** One case in a fresh process. A child that fails is a failed row, not a crash. */
function runCase(args) {
    try {
        const out = execFileSync(process.execPath, ['--expose-gc', PHASE, JSON.stringify(args)], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * MIB,
        });
        return { ok: true, ...JSON.parse(out.trim().split('\n').pop()) };
    } catch (error) {
        return { ok: false, error: String(error?.stderr || error?.message || error).split('\n').slice(0, 4).join(' | ') };
    }
}

const phaseNamed = (run, name) => run.phases.find((p) => p.phase === name);
const memoryAt = (run, name) => phaseNamed(run, name)?.memory ?? {};

let exitCode = 1;
try {
    // ---- 1. provenance -------------------------------------------------------
    console.log('\n=== 1. provenance ===');
    const require_ = createRequire(import.meta.url);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    evidence.provenance = {
        productionBase: git(['rev-parse', 'origin/main']),
        researchBranchAtRun: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        testedResearchHead: git(['rev-parse', 'HEAD']),
        workingTreeDirty: git(['status', '--porcelain=v1', '--untracked-files=all']).length > 0,
        // As in the other gates: is the source that produced these numbers
        // committed? Generated evidence cannot be part of that question.
        researchPackageDirtyBeforeRun: git([
            'status', '--porcelain=v1', '--untracked-files=all', '--',
            'research/m6-split-merge-reliability',
            ':!research/m6-split-merge-reliability/evidence.json',
            ':!research/m6-split-merge-reliability/evidence-browser.json',
            ':!research/m6-split-merge-reliability/evidence-object-graph-memory.json',
            ':!research/m6-split-merge-reliability/evidence-load-boundary.json',
        ]).length > 0,
        coreCiRunsThisGate: false,
        dependencies: { 'pdf-lib': require_(require_.resolve('pdf-lib/package.json', { paths: [ROOT] })).version },
        node: process.version,
        ranAt: new Date().toISOString(),
    };
    measure('production base', evidence.provenance.productionBase);
    measure('research head', `${evidence.provenance.testedResearchHead} (package dirty before run: ${evidence.provenance.researchPackageDirtyBeforeRun})`);
    assert_('this gate is local research evidence, not something Core CI runs',
        evidence.provenance.coreCiRunsThisGate === false);
    assert_('the pdf-lib under measurement is the pinned 1.17.1',
        evidence.provenance.dependencies['pdf-lib'] === '1.17.1', evidence.provenance.dependencies['pdf-lib']);
    evidence.corpus = corpus;

    // ---- 2. the walker against the copy it predicts ----------------------------
    //
    // reachableGraph walks a source the way PDFObjectCopier does, without cloning.
    // If what it counts is what copyPages then registers — object for object,
    // stream byte for stream byte — the copy's size is known before the copy.
    console.log('\n=== 2. the walker against a real copy ===');
    const all = (n) => Array.from({ length: n }, (_, i) => i);
    const extracts = [
        ['A-p1', 'mem-a-small-vector', [0]],
        ['B1-p1', 'mem-b1-many-objects', [0]],
        ['B2-p1', 'mem-b2-many-objects-objstm', [0]],
        ['C-p1', 'mem-c-few-large-streams', [0]],
        ['D-p1', 'mem-d-shared-refs', [0]],
        ['D-all', 'mem-d-shared-refs', all(50)],
        ['E-p1', 'mem-e-deep-cycle', [0]],
        ['F-p1', 'mem-f-1000-pages', [0]],
        ['F-all', 'mem-f-1000-pages', all(1000)],
        ['G1-p1', 'mem-g1-large-image-raw', [0]],
        ['G2-p1', 'mem-g2-large-image-flate', [0]],
        ['I-p1', 'mem-i-linked-heavy-pages', [0]],
        ['I-p10', 'mem-i-linked-heavy-pages', [9]],
        ['J-p1', 'mem-j-distinct-names', [0]],
        ['K-p1', 'mem-k-objstm-inflation', [0]],
    ];
    const runs = {};
    for (const [id, fixture, pages] of extracts) {
        const run = runCase({ op: 'extract', fixtures: [fixture], pages });
        runs[id] = run;
        if (!run.ok) {
            evidence.cases[id] = { fixture, pages: pages.length, error: run.error };
            assert_(`${id}: the measured copy ran`, false, run.error);
            continue;
        }
        const created = phaseNamed(run, '3 after destination create').structural.destination;
        const copiedTo = phaseNamed(run, '4 after copyPages').structural.destination;
        const added = { objects: copiedTo.objects - created.objects, streamBytes: copiedTo.streamBytes - created.streamBytes };
        const plan = run.result.plan;
        evidence.cases[id] = {
            fixture, selectedPages: pages.length, plan, copyAdded: added, outputBytesMeasuredOnly: run.result.outputBytesMeasuredOnly,
            phases: run.phases,
        };
        assert_(`${id}: the walker counts what copyPages registers`,
            plan.destinationObjects === added.objects && plan.streamBytes === added.streamBytes,
            `objects ${fmt(plan.destinationObjects)} predicted / ${fmt(added.objects)} copied, `
            + `stream bytes ${fmt(plan.streamBytes)} / ${fmt(added.streamBytes)}`);
    }
    const eRun = runs['E-p1'];
    assert_('a 201-deep chain of forms that closes into a cycle is walked to the end',
        eRun?.ok && eRun.result.plan.destinationObjects > 200,
        eRun?.ok ? `${fmt(eRun.result.plan.destinationObjects)} objects, the same number the copy registered` : 'did not run');

    // ---- 3. shared objects are counted once ------------------------------------
    console.log('\n=== 3. shared objects ===');
    const dDoc = await PDFDocument.load(bytesOf('mem-d-shared-refs'), { updateMetadata: false });
    const dUnion = reachableGraph(dDoc, all(50));
    const dPerPage = all(50).map((i) => reachableGraph(dDoc, [i]));
    const dSummed = dPerPage.reduce((s, g) => ({
        streams: s.streams + g.streams, streamBytes: s.streamBytes + g.streamBytes,
    }), { streams: 0, streamBytes: 0 });
    const dContext = contextTotals(dDoc);
    evidence.structural.sharedReferences = { union: dUnion, summedPerPage: dSummed, context: dContext };
    assert_('fifty pages sharing one image reach it once, not fifty times',
        dUnion.streamBytes === dContext.streamBytes && dSummed.streamBytes > 40 * dUnion.maxStreamBytes,
        `union ${fmt(dUnion.streamBytes)} B = every stream in the document once; summing pages separately `
        + `would say ${fmt(dSummed.streamBytes)} B`);

    // ---- 4. what does not bound the graph ---------------------------------------
    console.log('\n=== 4. what does not bound the graph ===');
    const iOne = runs['I-p1']?.result?.plan;
    const iTen = runs['I-p10']?.result?.plan;
    evidence.structural.pageCount = { 'I-p1': iOne, 'I-p10': iTen };
    probe('one selected page each, and the graphs they reach differ by an order of magnitude',
        iOne && iTen && iOne.selectedPages === iTen.selectedPages
        && iOne.streamBytes >= 5 * iTen.streamBytes && iOne.pageLeavesReached > 0,
        iOne && iTen ? `page 1: ${fmt(iOne.destinationObjects)} objects, ${fmt(iOne.streamBytes)} B, `
            + `${iOne.pageLeavesReached} unselected pages; page 10: ${fmt(iTen.destinationObjects)} objects, ${fmt(iTen.streamBytes)} B` : '');

    const b1 = runs['B1-p1']?.result?.plan;
    const c = runs['C-p1']?.result?.plan;
    const b1Bytes = corpus['mem-b1-many-objects'].bytes;
    const cBytes = corpus['mem-c-few-large-streams'].bytes;
    evidence.structural.fileSizeAgainstObjects = { B1: { fileBytes: b1Bytes, plan: b1 }, C: { fileBytes: cBytes, plan: c } };
    probe('files of about the same size hold object graphs thousands of times apart',
        b1 && c && b1Bytes / cBytes < 2 && cBytes / b1Bytes < 2 && b1.destinationObjects >= 100 * c.destinationObjects,
        b1 && c ? `B1 ${fmt(b1Bytes)} B -> ${fmt(b1.destinationObjects)} objects; C ${fmt(cBytes)} B -> ${fmt(c.destinationObjects)} objects` : '');

    const b2 = runs['B2-p1']?.result?.plan;
    const b2Bytes = corpus['mem-b2-many-objects-objstm'].bytes;
    evidence.structural.packing = { B1: { fileBytes: b1Bytes, plan: b1 }, B2: { fileBytes: b2Bytes, plan: b2 } };
    probe('the same object graph arrives in files several times apart in size',
        b1 && b2 && b1.destinationObjects === b2.destinationObjects && b1Bytes >= 4 * b2Bytes,
        b1 && b2 ? `${fmt(b1.destinationObjects)} objects from ${fmt(b1Bytes)} B plain and from ${fmt(b2Bytes)} B packed` : '');

    const k = corpus['mem-k-objstm-inflation'];
    evidence.structural.loadInflation = { inputBytes: k.bytes, decodedObjectStreamBytes: k.decodedObjectStreamBytes };
    probe('a few kilobytes of input decode to tens of megabytes at load, before any graph exists',
        k.decodedObjectStreamBytes >= 100 * k.bytes && runs['K-p1']?.ok,
        `${fmt(k.bytes)} B of input, ${fmt(k.decodedObjectStreamBytes)} B decoded — `
        + `${Math.round(k.decodedObjectStreamBytes / k.bytes)}x; the load finished and nothing refused it`);

    const g1 = runs['G1-p1']?.result?.plan;
    const g2 = runs['G2-p1']?.result?.plan;
    evidence.structural.encodedBytes = { G1: g1, G2: g2 };
    assert_('pdf-lib holds a stream as its encoded bytes, not as the image it decodes to',
        g1 && g2 && g1.maxStreamBytes === 3000 * 3000 && g2.maxStreamBytes < 3000 * 3000 / 100,
        g1 && g2 ? `the same 9 MB image: ${fmt(g1.maxStreamBytes)} B held raw, ${fmt(g2.maxStreamBytes)} B held under FlateDecode` : '');

    // ---- 5. the save buffer -------------------------------------------------------
    console.log('\n=== 5. the save buffer ===');
    evidence.structural.plainSavePrediction = {};
    for (const [id, fixture, pages] of [
        ['B1-plain', 'mem-b1-many-objects', [0]],
        ['C-plain', 'mem-c-few-large-streams', [0]],
        ['I-p1-plain', 'mem-i-linked-heavy-pages', [0]],
    ]) {
        const run = runCase({ op: 'extract', fixtures: [fixture], pages, useObjectStreams: false });
        const predicted = run.ok ? run.result.predictedPlainBytesMeasuredOnly : null;
        const actual = run.ok ? run.result.outputBytesMeasuredOnly : null;
        // The two lengths move together with the timestamp inside the file, so
        // the equality is the structural fact and the lengths are MEASURED_ONLY.
        evidence.structural.plainSavePrediction[id] = {
            predictedEqualsActual: run.ok && predicted === actual,
            predictedMeasuredOnly: predicted, actualMeasuredOnly: actual, error: run.ok ? undefined : run.error,
        };
        assert_(`${id}: the plain writer's output length is known before its buffer is allocated`,
            run.ok && predicted === actual, run.ok ? `${fmt(predicted)} B predicted, ${fmt(actual)} B written` : run.error);
    }
    const b1Packed = runs['B1-p1']?.result?.outputBytesMeasuredOnly;
    measure('the same B1 extract written with object streams, as production writes it',
        `${fmt(b1Packed)} B — known only after each chunk is deflated, so there is no equivalent number to ask for first`);

    // ---- 6. Merge -------------------------------------------------------------------
    console.log('\n=== 6. Merge, source by source ===');
    const mergeCases = [
        ['merge-A-C-B1', ['mem-a-small-vector', 'mem-c-few-large-streams', 'mem-b1-many-objects']],
        ['merge-D-F', ['mem-d-shared-refs', 'mem-f-1000-pages']],
    ];
    for (const [id, fixtures] of mergeCases) {
        const run = runCase({ op: 'merge', fixtures });
        if (!run.ok) {
            evidence.cases[id] = { fixtures, error: run.error };
            assert_(`${id}: the measured merge ran`, false, run.error);
            continue;
        }
        const base = phaseNamed(run, `1 ${fixtures[0]} loaded`).structural.destination;
        const finalDestination = phaseNamed(run, '5 before save').structural.destination;
        const planned = run.result.perSource.reduce((s, x) => ({
            objects: s.objects + x.plan.destinationObjects, streamBytes: s.streamBytes + x.plan.streamBytes,
        }), { objects: 0, streamBytes: 0 });
        const released = fixtures.map((name) => {
            const s = phaseNamed(run, `7 ${name} released`).structural;
            return { name, sourceDocumentCollectableMeasuredOnly: s.sourceDocumentCollectableMeasuredOnly };
        });
        evidence.cases[id] = {
            fixtures, perSource: run.result.perSource, planned, finalDestination,
            outputBytesMeasuredOnly: run.result.outputBytesMeasuredOnly, released, phases: run.phases,
        };
        assert_(`${id}: the output graph grows by exactly what each source's plan said, before that source is copied`,
            finalDestination.objects - base.objects === planned.objects
            && finalDestination.streamBytes - base.streamBytes === planned.streamBytes,
            `${fmt(planned.objects)} objects and ${fmt(planned.streamBytes)} B planned; `
            + `${fmt(finalDestination.objects - base.objects)} and ${fmt(finalDestination.streamBytes - base.streamBytes)} B copied`);
        measure(`${id}: each source collectable once released (MEASURED_ONLY)`,
            released.map((r) => `${r.name} ${r.sourceDocumentCollectableMeasuredOnly ? 'yes' : 'no'}`).join(', '));
    }

    // ---- 7. memory, as measured ---------------------------------------------------------
    //
    // Reported for scale and for the shape of each phase. None of these numbers
    // is a bound, and none of them decides a row.
    console.log('\n=== 7. memory, as measured (MEASURED_ONLY) ===');
    const signed = (n) => `${n < 0 ? '-' : '+'}${mib(Math.abs(n))}`;
    for (const [id, run] of Object.entries(runs)) {
        if (!run.ok) continue;
        const m0 = memoryAt(run, '0 before load');
        const m1 = memoryAt(run, '1 after source load');
        const m4 = memoryAt(run, '4 after copyPages');
        const m6 = memoryAt(run, '6 immediately after save');
        const m7a = phaseNamed(run, '7a source released').structural;
        const shape = {
            loadPeakRssGrowthMeasuredOnly: m1.maxRssMeasuredOnly - m0.maxRssMeasuredOnly,
            heapUsedAfterLoadMeasuredOnly: m1.heapUsedMeasuredOnly - m0.heapUsedMeasuredOnly,
            heapUsedAfterCopyMeasuredOnly: m4.heapUsedMeasuredOnly - m0.heapUsedMeasuredOnly,
            arrayBuffersAfterSaveMeasuredOnly: m6.arrayBuffersMeasuredOnly - m0.arrayBuffersMeasuredOnly,
            peakRssBySaveMeasuredOnly: m6.maxRssMeasuredOnly - m0.maxRssMeasuredOnly,
            sourceDocumentCollectableMeasuredOnly: m7a.sourceDocumentCollectableMeasuredOnly,
            inputBufferCollectableMeasuredOnly: m7a.inputBufferCollectableMeasuredOnly,
        };
        evidence.measuredOnly[id] = shape;
        measure(`${id}`, `load peak RSS ${signed(shape.loadPeakRssGrowthMeasuredOnly)}, heap ${signed(shape.heapUsedAfterLoadMeasuredOnly)} `
            + `after load / ${signed(shape.heapUsedAfterCopyMeasuredOnly)} after copy, array buffers ${signed(shape.arrayBuffersAfterSaveMeasuredOnly)} `
            + `after save, source collectable when released: ${shape.sourceDocumentCollectableMeasuredOnly ? 'yes' : 'no'}`);
    }
    const retained = (id) => {
        const run = runs[id];
        if (!run?.ok) return null;
        return memoryAt(run, '7b everything released').heapUsedMeasuredOnly - memoryAt(run, '0 before load').heapUsedMeasuredOnly;
    };
    evidence.measuredOnly.retainedAfterReleaseMeasuredOnly = { B1: retained('B1-p1'), J: retained('J-p1') };
    // Both numbers, and no cause. The module-level PDFRef and PDFName pools are a
    // mechanism the source shows; which objects the retained heap actually is
    // was not measured, and J's distinct names account for only part of it.
    measure('heap still held once every document is released, repeated names (B1) against distinct names (J)',
        `B1 ${signed(retained('B1-p1'))}, J ${signed(retained('J-p1'))} — the PDFRef and PDFName pools fit; the cause is not measured`);

    // ---- 8. today's routes --------------------------------------------------------------
    console.log('\n=== 8. what production does today ===');
    baselineFail('production loads a document whose object stream inflates a thousandfold, and nothing stops it',
        runs['K-p1']?.ok && k.decodedObjectStreamBytes >= 100 * k.bytes,
        `${fmt(k.bytes)} B in, ${fmt(k.decodedObjectStreamBytes)} B decoded during load; the route has no size or count check before or during load`);
    baselineFail('production copies and writes whatever one selected page reaches, without looking first',
        iOne && iTen && iOne.pageLeavesReached > 0 && runs['I-p1'].result.outputBytesMeasuredOnly >= 5 * runs['I-p10'].result.outputBytesMeasuredOnly,
        iOne ? `page 1 of I: ${iOne.pageLeavesReached} unselected pages and ${fmt(iOne.streamBytes)} B copied, `
            + `${fmt(runs['I-p1'].result.outputBytesMeasuredOnly)} B written for a one-page extract` : '');

    humanOpen('M6-H11 memory architecture (B2)',
        'which structural caps production enforces, how the unbounded load-time decode is closed, and whether a '
        + 'memory preset is ever offered — see object-graph-memory.md; this research recommends, it does not decide');

    fs.writeFileSync(path.join(RESEARCH, 'evidence-object-graph-memory.json'), `${JSON.stringify(evidence, null, 2)}\n`);

    const counted = rows.filter((r) => r.ok !== null);
    const failed = counted.filter((r) => !r.ok);
    const byKind = (kind) => rows.filter((r) => r.kind === kind).length;
    console.log(`\n  ASSERT ${byKind('ASSERT')}  PROBE ${byKind('PROBE')}  MEASURE ${byKind('MEASURE')}  `
        + `BASELINE-FAIL ${byKind('BASELINE-FAIL')}  HUMAN-OPEN ${byKind('HUMAN-OPEN')}`);
    console.log(`  ${counted.length - failed.length}/${counted.length} verifiable rows passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - [${f.kind}] ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nobject-graph memory gate failed: ${error?.stack ?? error}\n`);
}
process.exit(exitCode);
