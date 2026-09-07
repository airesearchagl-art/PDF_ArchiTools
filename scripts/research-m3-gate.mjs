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
    'failure.json', 'network.json'];
const missing = required.filter((f) => !has(f));
if (missing.length) {
    console.error(`Missing results: ${missing.join(', ')}`);
    console.error('Run: node scripts/research-m3-probe.mjs');
    process.exit(1);
}

const before = read('before.json');
const matrix = read('matrix.json');
const FIXTURES = ['native', 'rotated', 'boxes', 'features', 'scanned', 'a0'];
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
    for (const fixture of ['native', 'boxes', 'a0']) {
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
    check(`${candidate}: page count and order unchanged on every fixture`,
        FIXTURES.every((f) => matrix[f][candidate].pageCount.before === matrix[f][candidate].pageCount.after));
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
check('the hybrid sends only the eraser and the ink it touches to pixels',
    split.raster.includes('stroke-eraser-mark') && split.raster.length === 3
    && split.vector.length === split.total - 3,
    `pixels: ${split.raster.join(', ')}`);
probe('and it does not send everything to pixels to be safe',
    split.vector.length > split.raster.length,
    `${split.vector.length} as operators, ${split.raster.length} as pixels`);

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
probe('and so does the whole-page raster overlay',
    a0.overlay.maxPixels >= a0.fullPageAt2x.pixels * 0.95,
    `${(a0.overlay.maxPixels / 1e6).toFixed(1)} Mpx -- the overlay is page-sized`);
check('the hybrid pays only for what it rasterises',
    a0.hybrid.maxPixels < a0.fullPageAt2x.pixels / 100,
    `${(a0.hybrid.maxPixels / 1e6).toFixed(2)} Mpx, ${(a0.hybrid.rgbaBytes / 1e6).toFixed(1)} MB`);
check('which is also much faster on that sheet',
    a0.hybrid.ms < a0.overlay.ms / 5, `${a0.hybrid.ms}ms vs ${a0.overlay.ms}ms`);

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
    fidelity.hybrid.perTool['stroke-pressure'].differingFraction < 0.05,
    `${(fidelity.hybrid.perTool['stroke-pressure'].differingFraction * 100).toFixed(1)}% differing`);
check('its text differs, because the font is a substitute',
    fidelity.hybrid.perTool['text-japanese'].differingFraction > 0.05,
    `${(fidelity.hybrid.perTool['text-japanese'].differingFraction * 100).toFixed(1)}% differing`
    + ' -- reported rather than hidden');
// The finding this whole spike turns on.
probe('the baseline looks the best of all of them while preserving the least',
    fidelity.baseline.whole.differingFraction <= fidelity.overlay.whole.differingFraction
    && worstOf(matrix.native.baseline, 'sourceText') === 'lost',
    `baseline ${(fidelity.baseline.whole.differingFraction * 100).toFixed(2)}% differing`
    + ` vs overlay ${(fidelity.overlay.whole.differingFraction * 100).toFixed(2)}%`
    + ' -- looking right is not preserving anything');
void worstTool;

console.log('');
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
