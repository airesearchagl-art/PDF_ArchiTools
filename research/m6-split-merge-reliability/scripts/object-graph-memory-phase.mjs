/**
 * One Split or Merge, measured phase by phase, in a process of its own.
 *
 * Run by `object-graph-memory-gate.mjs`, never on its own, and always with
 * `--expose-gc`. A process per case keeps one document's retained objects —
 * and pdf-lib's module-level caches — out of the next document's numbers.
 *
 * Two kinds of number come out, and they are never mixed:
 *
 *   structural   object counts and stream byte totals — EXACT, read off the
 *                documents themselves
 *   output       the saved length, and the plain writer's prediction of it —
 *                MEASURED_ONLY by name: the production route loads and creates
 *                with updateMetadata on, so the file carries the time it was
 *                written, and its length can move by a few bytes between runs
 *   memory       process.memoryUsage() and peak RSS after a forced collection —
 *                MEASURED_ONLY, reported for scale and never used as a bound:
 *                when V8 collects, how it lays objects out and what a browser
 *                engine would do are not things this process can promise
 *
 * Lifetime is asked a third way: a WeakRef to the source document and to its
 * input buffer, dereferenced only after the last strong reference is dropped and
 * a full collection has run. A WeakRef that still answers means something is
 * holding the object; one that does not means nothing was. That depends on the
 * collector having run, so it is MEASURED_ONLY too.
 *
 * Usage (from the gate):
 *   node --expose-gc object-graph-memory-phase.mjs '{"op":"extract","fixtures":["x"],"pages":[0]}'
 *   node --expose-gc object-graph-memory-phase.mjs '{"op":"merge","fixtures":["a","b"]}'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { reachableGraph, contextTotals, predictPlainSaveBytes } from '../prototype/object-graph-memory.mjs';

if (typeof global.gc !== 'function') {
    console.error('object-graph-memory-phase: run with --expose-gc');
    process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm6-object-graph-memory');
const args = JSON.parse(process.argv[2] ?? '{}');
const useObjectStreams = args.useObjectStreams !== false;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Collect twice, let WeakRefs clear at the job boundary, then read memory. */
async function sample() {
    global.gc();
    await settle();
    global.gc();
    await settle();
    const m = process.memoryUsage();
    return {
        rssMeasuredOnly: m.rss,
        heapUsedMeasuredOnly: m.heapUsed,
        externalMeasuredOnly: m.external,
        arrayBuffersMeasuredOnly: m.arrayBuffers,
        // The peak since the process started. A sample at a phase boundary sees
        // only what is still held there; a buffer that grew and was dropped
        // inside a phase — an object stream inflated during load — shows up
        // here and nowhere else.
        maxRssMeasuredOnly: process.resourceUsage().maxRSS * 1024,
    };
}

/**
 * Whether each WeakRef's target is gone, asked only after a full collection.
 * Dereferencing first would both answer too early and keep the target alive for
 * the rest of the job. GC-dependent, so every key says MeasuredOnly.
 */
async function collectable(refs) {
    await sample();
    const out = {};
    for (const [key, ref] of Object.entries(refs)) out[key] = ref.deref() === undefined;
    return out;
}

const phases = [];
const record = async (phase, structural = {}) => {
    phases.push({ phase, structural, memory: await sample() });
};

const readFixture = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, `${name}.pdf`)));

/**
 * The production Extract route, instrumented: `load` and `create` with their
 * defaults, `copyPages`, `addPage`, `save` — as PdfSplitMerge does it.
 */
async function extract(name, pages) {
    let input = readFixture(name);
    const inputRef = new WeakRef(input.buffer);
    await record('0 before load', { inputBytes: input.length });

    let source = await PDFDocument.load(input);
    const sourceRef = new WeakRef(source);
    const sourceContextRef = new WeakRef(source.context);
    input = null;
    await record('1 after source load', { source: contextTotals(source) });

    const plan = reachableGraph(source, pages);
    await record('2 after graph scan', { plan });

    let output = await PDFDocument.create();
    await record('3 after destination create', { destination: contextTotals(output) });

    const copied = await output.copyPages(source, pages);
    copied.forEach((page) => output.addPage(page));
    await record('4 after copyPages', { source: contextTotals(source), destination: contextTotals(output) });

    const predictedPlainBytesMeasuredOnly = useObjectStreams ? null : await predictPlainSaveBytes(output);
    await record('5 before save', { destination: contextTotals(output), predictedPlainBytesMeasuredOnly });

    let bytes = await output.save({ useObjectStreams });
    const outputBytesMeasuredOnly = bytes.length;
    await record('6 immediately after save', { destination: contextTotals(output), outputBytesMeasuredOnly });

    source = null;
    await record('7a source released', await collectable({
        sourceDocumentCollectableMeasuredOnly: sourceRef,
        sourceContextCollectableMeasuredOnly: sourceContextRef,
        inputBufferCollectableMeasuredOnly: inputRef,
    }));
    output = null;
    bytes = null;
    await record('7b everything released', {});

    return { plan, outputBytesMeasuredOnly, predictedPlainBytesMeasuredOnly };
}

/**
 * The production Merge route, instrumented source by source: one output
 * document, and for each input a load, a copy of every page, and — here, where
 * production simply lets the loop variable go — an explicit release, so what
 * the output still holds of each source can be asked directly.
 */
async function merge(names) {
    await record('0 before load', {});
    let output = await PDFDocument.create();
    const perSource = [];
    for (const name of names) {
        let input = readFixture(name);
        const inputRef = new WeakRef(input.buffer);
        let source = await PDFDocument.load(input);
        const sourceRef = new WeakRef(source);
        const sourceContextRef = new WeakRef(source.context);
        input = null;
        await record(`1 ${name} loaded`, { source: contextTotals(source), destination: contextTotals(output) });

        // Planned against the source before it is copied: the output's growth
        // for this source is known at this point, not after.
        const plan = reachableGraph(source, source.getPageIndices());
        const copied = await output.copyPages(source, source.getPageIndices());
        copied.forEach((page) => output.addPage(page));
        await record(`4 ${name} copied`, { plan, destination: contextTotals(output) });

        source = null;
        await record(`7 ${name} released`, {
            destination: contextTotals(output),
            ...(await collectable({
                sourceDocumentCollectableMeasuredOnly: sourceRef,
                sourceContextCollectableMeasuredOnly: sourceContextRef,
                inputBufferCollectableMeasuredOnly: inputRef,
            })),
        });
        perSource.push({ name, plan });
    }
    const predictedPlainBytesMeasuredOnly = useObjectStreams ? null : await predictPlainSaveBytes(output);
    await record('5 before save', { destination: contextTotals(output), predictedPlainBytesMeasuredOnly });
    let bytes = await output.save({ useObjectStreams });
    const outputBytesMeasuredOnly = bytes.length;
    await record('6 immediately after save', { destination: contextTotals(output), outputBytesMeasuredOnly });
    output = null;
    bytes = null;
    await record('7b everything released', {});
    return { perSource, outputBytesMeasuredOnly, predictedPlainBytesMeasuredOnly };
}

const result = args.op === 'merge'
    ? await merge(args.fixtures)
    : await extract(args.fixtures[0], args.pages);

process.stdout.write(`${JSON.stringify({ args: { ...args, useObjectStreams }, result, phases })}\n`);
