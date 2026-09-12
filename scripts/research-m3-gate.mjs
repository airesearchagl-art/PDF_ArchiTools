/**
 * The M3 research gate: re-checks the claims this spike is going to make.
 *
 * RESEARCH ONLY. This does not gate the app; it gates the write-up. Every
 * assertion here corresponds to a sentence in research/m3-annotator-vector-save/,
 * so a measurement that stops holding becomes a failing gate rather than a
 * paragraph that quietly goes stale.
 *
 * Much of it is negative probes, and one of them is unusual: the current save
 * path is asserted to *fail* preservation. A comparison in which every
 * candidate passes proves nothing about any of them, and the baseline's losses
 * are the reason this spike exists.
 *
 * Run:  node scripts/research-m3-fixtures.mjs
 *       node scripts/research-m3-probe.mjs
 *       node scripts/research-m3-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm3', 'results');

let failures = 0;
const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const has = (name) => fs.existsSync(path.join(OUT, name));

function check(label, ok, detail = '') {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}
/** A check fed input that must make it fire, so it can be believed. */
function probe(label, ok, detail = '') {
    check(`negative probe: ${label}`, ok, detail);
}

const required = ['before.json', 'matrix.json', 'noop.json', 'zoom.json', 'rotation.json',
    'cropbox.json', 'a0.json', 'hybrid-split.json', 'fidelity.json', 'determinism.json',
    'failure.json', 'network.json', 'markers.json', 'ordered.json', 'boundary.json',
    'text-placement.json', 'preflight.json', 'glyphs.json', 'raster-budget.json',
    'page-keys.json', 'snapshot.json'];
const missing = required.filter((f) => !has(f));
if (missing.length) {
    console.error(`Missing results: ${missing.join(', ')}`);
    console.error('Run: node scripts/research-m3-probe.mjs');
    process.exit(1);
}

const before = read('before.json');
const matrix = read('matrix.json');
const FIXTURES = ['native', 'rotated', 'boxes', 'croprot', 'features', 'scanned', 'a0'];
const worstOf = (result, key) => {
    const order = ['lost', 'changed', 'preserved'];
    const real = result.perPage.map((p) => p[key]).filter((v) => order.includes(v));
    return real.length === 0 ? 'not applicable' : real.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
};

console.log('=== the corpus carries what it is supposed to ===');
check('every fixture was measured', FIXTURES.every((f) => before[f]),
    Object.keys(before).join(', '));
check('there is real text to lose',
    before.native.pages.reduce((s, p) => s + p.charCount, 0) > 100,
    `${before.native.pages.reduce((s, p) => s + p.charCount, 0)} chars in native.pdf`);
check('there is vector geometry to lose',
    before.native.pages.reduce((s, p) => s + p.pathOps, 0) > 10,
    `${before.native.pages.reduce((s, p) => s + p.pathOps, 0)} path operators`);
check('all four rotation quadrants are present',
    [0, 90, 180, 270].every((r) => before.rotated.pages.some((p) => p.rotate === r)),
    before.rotated.pages.map((p) => p.rotate).join(', '));
check('a page is cropped, and one of the crops does not start at the origin',
    before.boxes.pages.some((p) => p.cropBox.x > 0 && p.cropBox.y > 0),
    before.boxes.pages.map((p) => `${p.cropBox.x},${p.cropBox.y}`).join(' | '));
check('one fixture has a crop origin and a rotation at the same time',
    before.croprot.pages.length === 4
    && before.croprot.pages.every((p) => p.cropBox.x > 0 && p.cropBox.y > 0)
    && new Set(before.croprot.pages.map((p) => p.rotate)).size === 4,
    'each of the four quadrants, cropped at (50, 70)');
check('there are existing annotations and form fields',
    before.features.pages[0].annotationCount >= 2 && before.features.form.fields.length >= 2,
    `${before.features.pages[0].annotationCount} annots, ${before.features.form.fields.length} fields`);
check('there is an image-only page and a page with an invisible text layer',
    before.scanned.pages[0].imageOps > 0 && before.scanned.pages[1].charCount > 0,
    `p1 images ${before.scanned.pages[0].imageOps}, p2 chars ${before.scanned.pages[1].charCount}`);

console.log('');
console.log('=== the current save path loses the document ===');
// The control. If these ever pass, the comparison below has nothing to say.
for (const fixture of ['native', 'boxes', 'a0']) {
    const b = matrix[fixture].baseline;
    probe(`${fixture}: the baseline loses the source text`,
        worstOf(b, 'sourceText') === 'lost',
        `${b.perPage[0].beforeChars} chars in, ${b.perPage[0].afterChars} out`);
    probe(`${fixture}: the baseline loses the source vector geometry`,
        worstOf(b, 'vector') === 'lost',
        `${b.perPage[0].beforePathOps} path ops in, ${b.perPage[0].afterPathOps} out`);
}
probe('the baseline loses the existing annotations and the form',
    worstOf(matrix.features.baseline, 'annotations') === 'lost'
    && matrix.features.baseline.form.after === 0,
    `${matrix.features.baseline.form.before} fields in, ${matrix.features.baseline.form.after} out`);
probe('the baseline loses the document metadata',
    matrix.features.baseline.metadata.titlePreserved === false,
    `title ${JSON.stringify(matrix.features.baseline.metadata.after.title)}`);
probe('the baseline loses the invisible OCR text layer on a scanned page',
    matrix.scanned.baseline.perPage[1].afterChars === 0,
    `${matrix.scanned.baseline.perPage[1].beforeChars} chars in, 0 out`);
probe('the baseline changes the page geometry',
    worstOf(matrix.native.baseline, 'cropBox') === 'changed',
    'the output page is sized in capture pixels, not source points');
probe('and it loses the page rotation',
    worstOf(matrix.rotated.baseline, 'rotation') === 'changed',
    'every page comes out at /Rotate 0');

console.log('');
console.log('=== the overlay and hybrid candidates keep it ===');
for (const candidate of ['overlay', 'hybrid']) {
    // A0 is deliberately not in this list for the overlay: under the raster
    // ceiling it cannot save that page at all, which is asserted on its own
    // below rather than smuggled in as a preservation failure.
    const fixtures = candidate === 'overlay' ? ['native', 'boxes'] : ['native', 'boxes', 'a0'];
    for (const fixture of fixtures) {
        const r = matrix[fixture][candidate];
        check(`${candidate} on ${fixture}: source text preserved`,
            worstOf(r, 'sourceText') === 'preserved',
            `${r.perPage[0].beforeChars} -> ${r.perPage[0].afterChars} chars`);
        check(`${candidate} on ${fixture}: source vector preserved`,
            worstOf(r, 'vector') === 'preserved',
            `${r.perPage[0].beforePathOps} -> ${r.perPage[0].afterPathOps} path ops`);
    }
    check(`${candidate}: rotation preserved on all four quadrants`,
        worstOf(matrix.rotated[candidate], 'rotation') === 'preserved',
        matrix.rotated[candidate].perPage.map((p) => `${p.beforeRotate}->${p.afterRotate}`).join(' '));
    check(`${candidate}: crop boxes preserved`,
        worstOf(matrix.boxes[candidate], 'cropBox') === 'preserved');
    check(`${candidate}: existing annotations and form values preserved`,
        worstOf(matrix.features[candidate], 'annotations') === 'preserved'
        && matrix.features[candidate].form.valuesPreserved,
        `${matrix.features[candidate].form.after} fields, values intact`);
    check(`${candidate}: metadata preserved`,
        matrix.features[candidate].metadata.titlePreserved);
    check(`${candidate}: the invisible text layer survives`,
        matrix.scanned[candidate].perPage[1].afterChars >= matrix.scanned[candidate].perPage[1].beforeChars,
        `${matrix.scanned[candidate].perPage[1].beforeChars} -> ${matrix.scanned[candidate].perPage[1].afterChars} chars`);
    check(`${candidate}: page count and order unchanged wherever it saved`,
        FIXTURES.filter((f) => !matrix[f][candidate].failed)
            .every((f) => matrix[f][candidate].pageCount.before === matrix[f][candidate].pageCount.after));
}

console.log('');
console.log('=== the source file is never modified ===');
for (const candidate of ['baseline', 'overlay', 'hybrid']) {
    check(`${candidate} leaves the bytes it was given alone`,
        FIXTURES.every((f) => matrix[f][candidate].sourceUnchanged !== false));
}

console.log('');
console.log('=== what the vector-only candidate cannot do ===');
const split = read('hybrid-split.json');
const failure = read('failure.json');
check('the pixel eraser is the thing it cannot express',
    split.unsupportedForVector.length === 1 && split.unsupportedForVector[0] === 'stroke-eraser-mark',
    split.unsupportedForVector.join(', '));
probe('and it refuses the save rather than dropping the mark',
    typeof failure.withEraser.refused === 'string' && failure.withEraser.produced === undefined,
    failure.withEraser.refused ?? `IT PRODUCED ${failure.withEraser.produced} BYTES`);
check('without an eraser it succeeds',
    failure.withoutEraser.produced > 0 && failure.withoutEraser.ops > 0,
    `${failure.withoutEraser.ops} operators`);
probe('a coordinate that cannot mean anything is refused, not drawn',
    typeof failure.nanCoordinate.refused === 'string',
    failure.nanCoordinate.refused ?? `IT PRODUCED ${failure.nanCoordinate.produced} BYTES`);
check('the hybrid rasterises the span an eraser reaches, and no more',
    split.raster.includes('stroke-eraser-mark')
    && split.raster[split.raster.length - 1] === 'stroke-eraser-mark'
    && split.wholeLayerRastered === false,
    `pixels: ${split.raster.join(', ')}`);
probe('and it does not send everything to pixels to be safe',
    split.vector.length > split.raster.length,
    `${split.vector.length} as operators, ${split.raster.length} as pixels`);
// The span is deliberately over-inclusive. Objects inside it that no eraser
// touches are rasterised too, because deciding otherwise means reasoning about
// overlaps between every pair -- and being wrong there reorders the drawing.
check('everything between the first affected object and the last eraser is in the span',
    split.runs[0].kind === 'raster'
    && split.runs[0].ids[split.runs[0].ids.length - 1] === 'stroke-eraser-mark'
    && split.runs.slice(1).every((r) => r.kind === 'vector'),
    split.runs.map((r) => `${r.kind}:${r.ids.length}`).join(' -> '));

console.log('');
console.log('=== annotation text a person can search for ===');
const added = (c) => matrix.native[c].addedTextSearchable;
probe('the baseline leaves no searchable annotation text',
    added('baseline').ascii === false && added('baseline').japanese === false);
probe('nor does the raster overlay -- its annotations are a picture',
    added('overlay').ascii === false && added('overlay').japanese === false);
check('the hybrid does, including Japanese and the measurement labels',
    added('hybrid').ascii && added('hybrid').japanese && added('hybrid').measureLabel,
    'ascii, japanese and a "NN.NN mm" label all extractable');
check('and it reports that the font was substituted rather than claiming the user’s',
    matrix.native.hybrid.fontSubstituted === true);

console.log('');
console.log('=== saving with nothing added ===');
const noop = read('noop.json');
probe('the baseline rewrites the page even with no annotations',
    noop.baseline.chars.after === 0 && noop.baseline.pathOps.after === 0,
    `${noop.baseline.chars.before} chars and ${noop.baseline.pathOps.before} path ops in, none out`);
for (const candidate of ['overlay', 'vector', 'hybrid']) {
    check(`${candidate}: a no-op save keeps the text, the vector and the page count`,
        noop[candidate].chars.after === noop[candidate].chars.before
        && noop[candidate].pathOps.after === noop[candidate].pathOps.before
        && noop[candidate].pageCount.after === noop[candidate].pageCount.before,
        `${noop[candidate].chars.after} chars, ${noop[candidate].pathOps.after} path ops`);
    check(`${candidate}: byte identity is not claimed`,
        noop[candidate].byteIdentical === false,
        'semantically preserved, not byte-for-byte -- a re-serialised file');
}

console.log('');
console.log('=== zoom ===');
const zoom = read('zoom.json');
check('the same spot gives the same PDF coordinate at every zoom',
    zoom.allIdentical,
    zoom.results.map((r) => `${r.scale}x:(${r.pdf.x},${r.pdf.y})`).join(' '));
check('and a pen of the same pixel width gives the same line width',
    zoom.widthsIdentical, `${zoom.results[0].widthPoints}pt at every zoom`);
probe('the zoom levels really were different',
    new Set(zoom.results.map((r) => r.scale)).size === 4,
    zoom.results.map((r) => `${r.scale}x`).join(', '));

console.log('');
console.log('=== rotation ===');
const rotation = read('rotation.json');
check('all four quadrants were mapped', rotation.length === 4,
    rotation.map((r) => r.rotate).join(', '));
check('every mapping round-trips', rotation.every((r) => r.roundTrips));
check('and lands on the page', rotation.every((r) => r.insidePage));
probe('the quadrants are not all the same answer',
    new Set(rotation.map((r) => `${r.pdf.x},${r.pdf.y}`)).size === 4,
    rotation.map((r) => `${r.rotate}:(${r.pdf.x},${r.pdf.y})`).join(' '));

console.log('');
console.log('=== page boxes ===');
const crop = read('cropbox.json');
check('a page whose crop starts at the origin needs no correction',
    crop[0].differs === false);
probe('a cropped page does, and the naive mapping is wrong by the crop origin',
    crop.slice(1).every((c) => c.differs),
    crop.slice(1).map((c) => `p${c.page} off by (${c.offBy.x}, ${c.offBy.y})`).join('; '));
probe('getSize() reports the MediaBox, which is the trap',
    crop.slice(1).every((c) => c.reportedSize.width !== c.cropBox.width),
    `getSize ${crop[1].reportedSize.width} vs crop ${crop[1].cropBox.width}`);

console.log('');
console.log('=== the largest sheet ===');
const a0 = read('a0.json');
check('a full-page raster of an A0 at 2x is large',
    a0.fullPageAt2x.pixels > 30e6,
    `${(a0.fullPageAt2x.pixels / 1e6).toFixed(1)} Mpx = ${(a0.fullPageAt2x.rgbaBytes / 1e6).toFixed(0)} MB of RGBA`);
probe('the baseline pays it in full',
    a0.baseline.maxPixels >= a0.fullPageAt2x.pixels * 0.95,
    `${(a0.baseline.maxPixels / 1e6).toFixed(1)} Mpx`);
// The finding the raster ceiling produced: a page-sized overlay is a
// page-sized image, so on the largest sheet candidate A cannot run at all.
probe('the whole-page overlay is refused outright on an A0',
    typeof a0.overlay.failed === 'string' && a0.overlay.failed.includes('8.0'),
    a0.overlay.failed ?? `IT PRODUCED ${a0.overlay.outputBytes} BYTES`);
check('the hybrid saves the same page comfortably',
    a0.hybrid.maxPixels > 0 && a0.hybrid.maxPixels < 1e6,
    `${(a0.hybrid.maxPixels / 1e6).toFixed(2)} Mpx, `
    + `${(a0.hybrid.rgbaBytes / 1e6).toFixed(1)} MB, ${a0.hybrid.ms}ms`);
check('which is what makes it the candidate rather than the overlay',
    a0.hybrid.maxPixels < a0.fullPageAt2x.pixels / 100,
    `${(a0.fullPageAt2x.pixels / a0.hybrid.maxPixels).toFixed(0)}x fewer pixels than a full page`);

console.log('');
console.log('=== how close each output looks ===');
const fidelity = read('fidelity.json');
const worstTool = (c) => Object.entries(fidelity[c].perTool)
    .sort((a, b) => b[1].differingFraction - a[1].differingFraction)[0];
check('the raster overlay reproduces every stroke exactly',
    ['stroke-plain', 'stroke-alpha', 'stroke-pressure', 'stroke-eraser-mark']
        .every((id) => fidelity.overlay.perTool[id].differingFraction < 0.01),
    'including the pixel-eraser result');
check('the hybrid reproduces the strokes it rasterises exactly',
    ['stroke-plain', 'stroke-alpha', 'stroke-eraser-mark']
        .every((id) => fidelity.hybrid.perTool[id].differingFraction < 0.01));
check('and its vector pressure stroke is close',
    fidelity.hybrid.perTool['stroke-pressure'].differingFraction < 0.01,
    `${(fidelity.hybrid.perTool['stroke-pressure'].differingFraction * 100).toFixed(1)}% differing`);
check('its text differs, because the font is a substitute',
    fidelity.hybrid.perTool['text-japanese'].differingFraction > 0.05,
    `${(fidelity.hybrid.perTool['text-japanese'].differingFraction * 100).toFixed(1)}% differing`
    + ' -- reported rather than hidden');

// The reference renderer is a copy of the app's draw loop; if it drifts, every
// fidelity number silently measures this repository instead of the product.
const placement = read('text-placement.json');
check('the text difference is glyph shape, not misplacement',
    Object.values(placement.out).every((r) => r.atZero - r.best < 0.02),
    Object.entries(placement.out)
        .map(([id, r]) => `${id} ${(r.atZero * 100).toFixed(1)}% -> ${(r.best * 100).toFixed(1)}% at ${r.bestOffsetPoints}pt`)
        .join('; '));
probe('shifting the comparison does not rescue it',
    Object.values(placement.out).every((r) => r.best > 0.05),
    'no vertical offset makes a substituted face match');
// The finding this whole spike turns on.
probe('the baseline looks the best of all of them while preserving the least',
    fidelity.baseline.whole.differingFraction <= fidelity.overlay.whole.differingFraction
    && worstOf(matrix.native.baseline, 'sourceText') === 'lost',
    `baseline ${(fidelity.baseline.whole.differingFraction * 100).toFixed(2)}% differing`
    + ` vs overlay ${(fidelity.overlay.whole.differingFraction * 100).toFixed(2)}%`
    + ' -- looking right is not preserving anything');
void worstTool;

console.log('');
console.log('');
console.log('=== a mark ends up where the user put it, end to end ===');
const markers = read('markers.json');
for (const fixture of ['rotated', 'croprot']) {
    for (const candidate of ['overlay', 'hybrid']) {
        const r = markers[fixture][candidate];
        check(`${candidate} on ${fixture}: every quadrant lands within a point`,
            !r.failed && r.pages.every((p) => p.found !== null && p.error < 2),
            r.failed ?? r.pages.map((p) => `r${p.rotate}:${p.error?.toFixed(1) ?? 'lost'}pt`).join(' '));
    }
}
check('that includes a page with a crop origin and a rotation together',
    markers.croprot.hybrid.pages.every((p) => p.error < 2),
    markers.croprot.hybrid.pages.map((p) => `r${p.rotate}:${p.error.toFixed(1)}pt`).join(' '));
// This is the check the standalone transform round-trip could not make: it
// proves a function inverts itself, not that the save path calls it, or calls
// it the right way round.
probe('the baseline does not -- it flattens the rotation away',
    markers.rotated.baseline.pages.every((p) => p.rotate === 0),
    `every page comes back at /Rotate 0, and the page is rewritten to `
    + `${markers.rotated.baseline.pages[0].pageSize.width}x${markers.rotated.baseline.pages[0].pageSize.height} capture pixels`);

console.log('');
console.log('=== the saved layer stacks the way the canvas does ===');
const ordered = read('ordered.json');
const scenarios = Object.keys(ordered.hybrid.results);
check('every ordering scenario was measured', scenarios.length >= 9, `${scenarios.length} scenarios`);
for (const [label, r] of Object.entries(ordered.hybrid.results)) {
    if (r.failed) { check(`hybrid: ${label}`, false, r.failed); continue; }
    // The all-vector scenario carries text, so it pays the font substitution.
    const bound = label.includes('no eraser') ? 0.08 : 0.02;
    check(`hybrid: ${label}`, r.differingFraction < bound,
        `${(r.differingFraction * 100).toFixed(2)}% differing   ${r.runs.join(' -> ')}`);
}
const afterRun = ordered.hybrid.results['before, eraser, after'];
probe('a stroke drawn after an eraser is written after the fragment, not under it',
    afterRun.runs.join(' ').endsWith('vector:B'),
    afterRun.runs.join(' -> '));
probe('and an eraser two objects back still pulls the run open',
    ordered.hybrid.results['multiple erasers'].runs[0] === 'raster:A+E1+B+E2',
    ordered.hybrid.results['multiple erasers'].runs.join(' -> '));
check('an object no eraser touches is still rasterised when it sits inside the span',
    ordered.hybrid.results['affected and unaffected interleaved'].runs[0].includes('far'),
    'conservative by construction: over-including costs pixels, under-including reorders marks');
check('a layer with no eraser at all stays entirely vector',
    ordered.hybrid.results['overlapping annotations, no eraser'].runs.every((r) => r.startsWith('vector')),
    ordered.hybrid.results['overlapping annotations, no eraser'].runs.join(' -> '));

console.log('');
console.log('=== annotations a save refuses rather than skips ===');
const pre = read('preflight.json');
const invalid = Object.entries(pre).filter(([label]) => label !== 'a valid job');
check('every invalid case was measured', invalid.length >= 9, `${invalid.length} cases`);
for (const [label, r] of invalid) {
    probe(`${label}: refused by all three writers, with no bytes`,
        r.problems.length > 0
        && ['overlay', 'vector', 'hybrid'].every((c) => typeof r.results[c].refused === 'string'),
        r.problems[0] ?? 'NO PROBLEM REPORTED');
}
check('a valid job still goes through',
    pre['a valid job'].problems.length === 0
    && ['overlay', 'vector', 'hybrid'].every((c) => pre['a valid job'].results[c].produced > 0),
    Object.entries(pre['a valid job'].results).map(([c, r]) => `${c}:${r.produced}B`).join(' '));
// The two the writers used to swallow: an unknown type hit a `return 0`, and a
// page the document does not have was never visited, because the writers loop
// over source pages rather than over the annotations.
probe('an unknown object type is one of them',
    typeof pre['unknown object type'].results.hybrid.refused === 'string');
probe('and so is an annotation filed against a page that does not exist',
    typeof pre['page N + 1'].results.hybrid.refused === 'string');

console.log('');
console.log('=== the page key validated, and the page key written ===');
const keys = read('page-keys.json');
// The gap this closes: `Number("02")` is 2 and passes an integer check, while a
// writer resolving `objects[i + 1]` stringifies to "2" and finds nothing. The
// job was validated against a page the writer never visits.
check('every non-canonical spelling still coerces to a valid integer',
    ['02', '2e0', '+2', ' 2'].every((k) => keys[k].coercesToInteger === true),
    'so a Number()-based check passes all of them');
check('and a writer indexing by number would have found nothing there',
    ['02', '2e0', '+2', ' 2'].every((k) => keys[k].writerWouldFind === 0),
    'validated as page 2, written as no page: the silent drop');
for (const k of ['02', '2e0', '+2', ' 2']) {
    probe(`${JSON.stringify(k)} is refused, not silently dropped`,
        typeof keys[k].refused === 'string' && keys[k].produced === undefined,
        keys[k].refused?.slice(0, 60) ?? `IT PRODUCED ${keys[k].produced} BYTES`);
}
check('the canonical spelling still saves, and the mark reaches the page',
    keys['2'].produced > 0 && keys['2'].ops > 0,
    `${keys['2'].produced} bytes, ${keys['2'].ops} operators`);

console.log('');
console.log('=== the caller mutates the job after it is checked ===');
const snap = read('snapshot.json');
check('the snapshot does not change when the caller does',
    snap.snapshotUnchanged === true);
check('a field mutated afterwards is not the field that would be written',
    snap.snapshotLineWidth === 4 && snap.callerLineWidth === 999,
    `snapshot ${snap.snapshotLineWidth}, caller ${snap.callerLineWidth}`);
probe('an object pushed in afterwards is not in the snapshot',
    snap.snapshotCount === 1 && snap.callerCount === 2,
    `snapshot ${snap.snapshotCount}, caller ${snap.callerCount}`);
probe('nor is a whole page added afterwards',
    snap.pageAddedAfterwards === 0);
// The review allows either outcome here -- write the validated snapshot, or
// detect the mutation and refuse. What is forbidden is writing content that
// was never validated. A refusal is the branch this interleaving takes.
check('a save racing a mutation either writes what it validated, or refuses',
    typeof snap.save.refused === 'string' || snap.save.produced > 0,
    snap.save.refused ? 'refused, no bytes' : `${snap.save.produced} bytes`);

console.log('');
console.log('=== a character the embedded font cannot draw ===');
const glyphs = read('glyphs.json');
check('the missing glyphs are actually detected', glyphs.missing.length >= 1,
    glyphs.missing.join(' '));
probe('the vector-only candidate refuses rather than writing .notdef',
    typeof glyphs.vector.refused === 'string',
    glyphs.vector.refused ?? `IT PRODUCED ${glyphs.vector.produced} BYTES`);
check('the hybrid sends that text object to pixels and carries on',
    glyphs.hybrid.produced > 0 && glyphs.hybrid.rasteredForGlyphs.includes('text-emoji'),
    `rastered: ${glyphs.hybrid.rasteredForGlyphs.join(', ')}`);
check('and says so, rather than leaving the text silently searchable-looking',
    glyphs.hybrid.textExtracted === false,
    'a rastered text object is not extractable, which is the cost of not losing it');

console.log('');
console.log('=== how large a raster fragment may be ===');
const budget = read('raster-budget.json');
const row = (label) => budget.rows.find((r) => r.label === label);
check('the ceiling is a stated number', budget.limit === 8_000_000,
    `${(budget.limit / 1e6).toFixed(1)} Mpx = ${(budget.limit * 4 / 1e6).toFixed(0)} MB of RGBA`);
check('fragments below it are produced, and the cost is smooth',
    ['small', 'medium', 'large', 'just under the bound']
        .every((l) => row(l).produced > 0),
    ['small', 'medium', 'large', 'just under the bound']
        .map((l) => `${(row(l).maxPixels / 1e6).toFixed(2)}Mpx/${row(l).ms}ms`).join('  '));
probe('a fragment just over it is refused',
    typeof row('just over the bound').refused === 'string'
    && row('just over the bound').produced === undefined,
    `${(row('just over the bound').predictedPixels / 1e6).toFixed(2)} Mpx needed`);
probe('and a whole-layer A0 fragment is refused too, not silently scaled down',
    typeof row('whole A0 layer').refused === 'string',
    `${(row('whole A0 layer').predictedPixels / 1e6).toFixed(1)} Mpx`);
check('the refusal names the page and the size',
    row('just over the bound').budget !== null
    && row('just over the bound').budget.page === 1
    && row('just over the bound').budget.width > 0,
    `page ${row('just over the bound').budget.page}, `
    + `${row('just over the bound').budget.width}x${row('just over the bound').budget.height}`);
probe('the check is arithmetic, so it fires either side of the line',
    budget.edges.justUnder === 'accepted' && budget.edges.justOver.startsWith('refused'),
    `${budget.edges.justUnder} / ${budget.edges.justOver.slice(0, 30)}`);
// To the pixel, so "over the limit" means over and not near.
check('MAX - 1 is accepted', budget.edges.maxMinusOne === 'accepted');
check('MAX exactly is accepted', budget.edges.maxExactly === 'accepted',
    'the bound is inclusive, and says so');
probe('MAX + 1 is refused', budget.edges.maxPlusOne.startsWith('refused'),
    budget.edges.maxPlusOne.slice(0, 40));
// A bound that is only ever tested from one side is not a bound.
check('the measurement straddles the ceiling rather than approaching it',
    row('just under the bound').predictedPixels < budget.limit
    && row('just over the bound').predictedPixels > budget.limit,
    `${(row('just under the bound').predictedPixels / 1e6).toFixed(2)} Mpx under, `
    + `${(row('just over the bound').predictedPixels / 1e6).toFixed(2)} Mpx over`);

console.log('');
console.log('=== documents this design will not write ===');
const boundary = read('boundary.json');
check('an ordinary document is accepted and saved',
    boundary.native.supported === true && boundary.native.save.produced > 0,
    `${boundary.native.save.produced} bytes`);
probe('a document with a signature field is refused, by name',
    boundary.signed.supported === false
    && boundary.signed.problems.some((p) => p.code === 'signed')
    && typeof boundary.signed.save.refused === 'string',
    boundary.signed.save.refused ?? 'IT PRODUCED A FILE');
probe('a damaged document is refused before anything is written',
    boundary.damaged.supported === false
    && boundary.damaged.problems.some((p) => p.code === 'unreadable')
    && typeof boundary.damaged.save.refused === 'string',
    boundary.damaged.save.refused ?? 'IT PRODUCED A FILE');
check('the refusal names the document, not an internal property',
    boundary.signed.problems[0].message.includes('電子署名'),
    boundary.signed.problems[0].message);
check('a document with an ordinary form is still accepted',
    boundary.features.supported === true && boundary.features.save.produced > 0,
    `${boundary.features.save.produced} bytes with 2 form fields`);
// Not being able to read the form is not evidence that there is no signature.
// The earlier version swallowed that failure and carried on -- and the earlier
// version of *this* probe read `boundary.signed`, whose code is 'signed', so it
// passed without the form-unreadable path ever running. It needs its own
// document.
const uf = boundary['unreadable-form'];
check('a document whose form cannot be inspected was measured', uf !== undefined);
check('its pages are readable, so this is not the damaged path in disguise',
    uf.problems.every((p) => p.code !== 'unreadable'),
    `codes: ${uf.problems.map((p) => p.code).join(', ')}`);
probe('an inspection failure refuses, rather than assuming there is no signature',
    uf.supported === false && uf.problems.some((p) => p.code === 'form-unreadable'),
    uf.problems.map((p) => p.code).join(', '));
probe('and the save refuses with it, producing nothing',
    typeof uf.save.refused === 'string' && uf.save.produced === undefined,
    uf.save.refused?.slice(0, 60) ?? `IT PRODUCED ${uf.save.produced} BYTES`);
check('the message says why, rather than showing a raw internal error',
    uf.problems[0].message.includes('電子署名')
    && uf.problems[0].message.includes('確認'),
    uf.problems[0].message.slice(0, 60));
// Four boundary conditions, four different causes -- otherwise one of them
// could be standing in for the others.
check('each boundary condition fires on its own document, distinctly',
    boundary.signed.problems[0].code === 'signed'
    && boundary.damaged.problems[0].code === 'unreadable'
    && uf.problems[0].code === 'form-unreadable'
    && boundary.native.supported === true
    && boundary.features.supported === true,
    'signed / unreadable / form-unreadable, against 2 accepted controls');

console.log('');
console.log('=== the bytes handed to a candidate are not modified ===');
for (const candidate of ['baseline', 'overlay', 'vector', 'hybrid']) {
    const results = FIXTURES.map((fx) => matrix[fx][candidate]).filter(Boolean);
    check(`${candidate}: unchanged on every fixture, byte for byte`,
        results.length === FIXTURES.length && results.every((r) => r.sourceUnchanged === true),
        `${results.filter((r) => r.sourceUnchanged === true).length}/${results.length}`
        + ` (${results.filter((r) => r.failed).length} of them refusals)`);
}
probe('including the candidate that refuses -- a refusal must not mutate either',
    FIXTURES.every((fx) => matrix[fx].vector.failed === true && matrix[fx].vector.sourceUnchanged === true),
    'vector refuses all seven and leaves all seven alone');

console.log('=== the same input twice ===');
const determinism = read('determinism.json');
for (const candidate of ['overlay', 'hybrid']) {
    check(`${candidate}: the same input gives the same bytes`,
        determinism[candidate].byteIdentical && determinism[candidate].semanticallyIdentical);
}
probe('the baseline does not, though its content is the same',
    determinism.baseline.byteIdentical === false && determinism.baseline.semanticallyIdentical,
    'deterministic semantics, non-deterministic bytes');
check('the vector-only candidate has no determinism to report, because it refused',
    typeof determinism.vector.refused === 'string');

console.log('');
console.log('=== the research harness talked to nobody ===');
const network = read('network.json');
check('external HTTP(S) requests from the harness', network.external.length === 0,
    network.external.slice(0, 3).join(', ') || '0 requests');
check('no page errors', network.pageErrors.length === 0, network.pageErrors[0] ?? '');

console.log('');
console.log(failures === 0
    ? 'All research assertions hold.'
    : `${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
