/**
 * The Processor reliability gate.
 *
 * The old Processor's contract was "it produced bytes, so it worked". The M5
 * research measured what that hid: a signature invalidated in silence, XFA
 * deleted by the act of inspecting it, searchable text replaced by a picture
 * and reported as done, an A1 at 600 dpi that failed after the work had
 * started, a partial batch whose ZIP said nothing about the files missing from
 * it, and a run the user had moved on from that downloaded anyway.
 *
 * So most of what this gate asserts is that the tool **refuses**, by name, and
 * before it has touched anything. A gate in which every document processed
 * would be asserting the defect.
 *
 * Run:  node scripts/make-processor-fixtures.mjs
 *       node scripts/smoke-processor-reliability.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5208;
const ORIGIN = `http://localhost:${PORT}`;
const MIB = 1024 * 1024;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'processor', 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-processor-fixtures.mjs')], { stdio: 'inherit' });
}

/**
 * The H8 arithmetic is derived from a specific deflater, so the gate resolves
 * the one pdf-lib actually gets rather than trusting a constant that happens to
 * sit in our source. A lockfile change that moves it must turn this red.
 *
 * `PAKO_STATE_BYTES` and the 16,383 divisor are read off pako 1.0.11's
 * `deflate.js`; if the resolved version is not that, the numbers in
 * `src/utils/processor/budget.ts` describe a library this build does not use.
 */
const require_ = createRequire(import.meta.url);
const resolvedVersions = (() => {
    const versionOf = (spec, from) => {
        try {
            const paths = from
                ? [path.dirname(require_.resolve(`${from}/package.json`))]
                : [ROOT];
            const file = require_.resolve(`${spec}/package.json`, { paths });
            return { version: require_(file).version, file: path.relative(ROOT, file) };
        } catch (error) {
            return { version: null, file: null, error: String(error?.message ?? error).split('\n')[0] };
        }
    };
    return {
        pdfLib: versionOf('pdf-lib'),
        jszip: versionOf('jszip'),
        pdfjs: versionOf('pdfjs-dist'),
        pakoUnderPdfLib: versionOf('pako', 'pdf-lib'),
    };
})();

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so the passing ones can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const note = (name, detail) => console.log(`  ----  ${name}  ${detail}`);
const measureNote = note;
/** Thousands separators, so a byte count reads as one. */
const fmt = (n) => Number(n).toLocaleString('en-US');
/** The derived B2 boundaries, reported at the end for the completion report. */
const evidenceB2 = {};

/** Every operation the orchestration covers. Declared here because both the
 * facts section and the policy section below assert across all of them. */
const ops = ['layer', 'monochrome', 'both', 'margin', 'optimize', 'normalize-size', 'title-block-update'];

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* data:, blob: */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-processor-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__processorReady === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__processor[f](...a), fn, args);

    // ---- 1. facts, read without changing the document ------------------------
    console.log('\n=== 1. source facts ===');
    const facts = await call('facts', [
        'signature-a4', 'unsigned-signature-field', 'sigflags-only', 'xfa-a4',
        'form-a4', 'invalid', 'vector-a4',
    ]);
    check('an applied signature is seen as applied',
        facts['signature-a4'].hasSignatureField && facts['signature-a4'].hasAppliedSignature,
        JSON.stringify(facts['signature-a4'].signatureFields));
    check('an empty /Sig field is a field, not a signature',
        facts['unsigned-signature-field'].hasSignatureField
        && facts['unsigned-signature-field'].hasAppliedSignature === false
        && facts['unsigned-signature-field'].sigFlags === 3);
    check('/SigFlags alone is neither',
        facts['sigflags-only'].sigFlags === 3
        && facts['sigflags-only'].hasSignatureField === false
        && facts['sigflags-only'].hasAppliedSignature === false);
    check('XFA is seen', facts['xfa-a4'].hasXfa === true);
    check('an ordinary form is read, and counted by field rather than by widget',
        facts['form-a4'].hasAcroForm && facts['form-a4'].fieldCount === 1
        && facts['form-a4'].formInspectionState === 'read');
    check('a malformed source is reported as such rather than throwing',
        facts.invalid.readable === false || facts.invalid.pagesValid === false);

    // RF-O1: /FT and /V are inheritable, and an unreadable tree is a refusal.
    const inheritedFacts = await call('facts', [
        'inherited-ft-signature', 'inherited-v-signature', 'inherited-empty-signature',
        'cyclic-field-tree', 'over-depth-field-tree', 'malformed-fields-entry',
    ]);
    check('a /Sig inherited from the parent is seen, signature and all',
        inheritedFacts['inherited-ft-signature'].hasAppliedSignature === true
        && inheritedFacts['inherited-v-signature'].hasAppliedSignature === true,
        `FT-on-parent: ${inheritedFacts['inherited-ft-signature'].hasAppliedSignature}, `
        + `V-on-parent: ${inheritedFacts['inherited-v-signature'].hasAppliedSignature}`);
    check('an inherited but empty /Sig field is a field, not a signature',
        inheritedFacts['inherited-empty-signature'].hasSignatureField === true
        && inheritedFacts['inherited-empty-signature'].hasAppliedSignature === false);
    probe('a field tree that cannot be read completely is unreadable, not empty',
        ['cyclic-field-tree', 'over-depth-field-tree', 'malformed-fields-entry']
            .every((n) => inheritedFacts[n].formInspectionState === 'unreadable'
                && inheritedFacts[n].signatureFields.length === 0),
        ['cyclic-field-tree', 'over-depth-field-tree', 'malformed-fields-entry']
            .map((n) => `${n}:${inheritedFacts[n].formInspectionState}`).join(' '));

    const inheritedPlans = await call('plans', [
        'inherited-ft-signature', 'inherited-v-signature',
        'cyclic-field-tree', 'over-depth-field-tree', 'malformed-fields-entry',
    ], ops);
    probe('every operation refuses an inherited applied signature before mutating',
        ['inherited-ft-signature', 'inherited-v-signature'].every(
            (n) => ops.every((op) => inheritedPlans[n][op].status === 'SIGNATURE_UNSAFE'),
        ));
    probe('and refuses a form it could not enumerate',
        ['cyclic-field-tree', 'over-depth-field-tree', 'malformed-fields-entry'].every(
            (n) => ops.every((op) => inheritedPlans[n][op].status === 'SIGNATURE_UNSAFE'),
        ));
    check('an inherited empty field still processes',
        (await call('plans', ['inherited-empty-signature'], ['layer', 'optimize']))['inherited-empty-signature'].layer.status === 'READY');

    const readOnly = await call('inspectionIsReadOnly');
    probe('looking at an XFA document does not delete its XFA',
        readOnly.xfaBefore === true && readOnly.xfaAfter === true);
    probe('looking at a document without a form does not create one',
        readOnly.plainGainedForm === false);

    // ---- 2. H7, applied to every operation -----------------------------------
    console.log('\n=== 2. the signature and XFA policy ===');
    const plans = await call('plans', ['signature-a4', 'unsigned-signature-field', 'sigflags-only', 'xfa-a4'], ops);
    check('an applied signature is refused by every operation',
        ops.every((op) => plans['signature-a4'][op].status === 'SIGNATURE_UNSAFE'),
        ops.map((op) => `${op}:${plans['signature-a4'][op].status}`).join(' '));
    check('an empty signature field refuses nothing on the preserving operations',
        ['layer', 'margin', 'optimize', 'normalize-size', 'title-block-update']
            .every((op) => plans['unsigned-signature-field'][op].status === 'READY'));
    check('/SigFlags alone refuses nothing',
        ['layer', 'margin', 'optimize'].every((op) => plans['sigflags-only'][op].status === 'READY'));
    check('XFA is refused exactly where the operation would drop it',
        plans['xfa-a4'].monochrome.status === 'XFA_UNSAFE'
        && plans['xfa-a4'].both.status === 'XFA_UNSAFE'
        && ['layer', 'margin', 'optimize', 'normalize-size', 'title-block-update']
            .every((op) => plans['xfa-a4'][op].status === 'READY'),
        ops.map((op) => `${op}:${plans['xfa-a4'][op].status}`).join(' '));

    // ---- 3. Layer -------------------------------------------------------------
    console.log('\n=== 3. 半透明レイヤ追加 ===');
    const layerCrop = await call('run', 'crop-offset', 'layer');
    check('Layer keeps text, vectors, annotations and metadata',
        layerCrop.ran
        && layerCrop.after.text.join(' ').includes('CROP-OFFSET-M5P')
        && layerCrop.after.pathOps >= layerCrop.before.pathOps
        && layerCrop.after.info.title === layerCrop.before.info.title);
    check('Layer leaves the page boxes alone',
        JSON.stringify(layerCrop.after.boxes) === JSON.stringify(layerCrop.before.boxes),
        JSON.stringify(layerCrop.after.boxes[0]));
    const layerAnnot = await call('run', 'annotation-a4', 'layer');
    check('annotations survive and stay above the overlay (it is page content)',
        layerAnnot.ran && layerAnnot.after.annots.length === layerAnnot.before.annots.length
        && layerAnnot.after.images.length === 0);
    const layerOffset = await call('run', 'mediabox-offset', 'layer');
    check('a MediaBox that does not start at the origin is still covered',
        layerOffset.ran && layerOffset.after.boxes[0].media[0] === 200);
    const layerSigned = await call('run', 'signature-a4', 'layer');
    probe('Layer refuses an applied signature before touching it',
        layerSigned.ran === false && layerSigned.code === 'SIGNATURE_UNSAFE');

    // ---- 4. Monochrome / Both -------------------------------------------------
    console.log('\n=== 4. モノクロ化 / 両方実行 ===');
    const monoUnconfirmed = await call('run', 'text-a4', 'monochrome');
    probe('Monochrome will not run without the loss confirmation',
        monoUnconfirmed.ran === false
        && monoUnconfirmed.code === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION');
    const monoPlan = (await call('plans', ['text-a4'], ['monochrome']))['text-a4'].monochrome;
    check('the confirmation names every loss it is asking about',
        monoPlan.losses.length === 6
        && ['searchable-text', 'ocr-text-layer', 'vector-structure', 'annotations', 'links', 'form-fields']
            .every((l) => monoPlan.losses.includes(l)),
        monoPlan.losses.join(','));

    const mono = await call('run', 'text-a4', 'monochrome', { confirm: true, dpi: 150 });
    check('confirmed, Monochrome writes one DeviceGray FlateDecode image per page',
        mono.ran && mono.after.images.length === 1
        && mono.after.colourSpaces[0] === '/DeviceGray'
        && mono.after.filters[0] === '/FlateDecode'
        && mono.after.images[0].bits === 8,
        `${mono.after.colourSpaces[0]} ${mono.after.filters[0]}`);
    check('no JPEG and no base64 anywhere in the output',
        mono.after.hasDct === false && mono.after.hasBase64Marker === false);
    check('the text really is gone, which is what was confirmed',
        mono.before.text.join(' ').includes('NATIVE-TEXT-M5P')
        && !mono.after.text.join(' ').includes('NATIVE-TEXT-M5P'));
    check('and the metadata is carried onto the rebuilt document',
        mono.after.info.title === mono.before.info.title
        && mono.after.info.author === mono.before.info.author,
        JSON.stringify(mono.after.info));
    const monoXfa = await call('run', 'xfa-a4', 'monochrome', { confirm: true });
    probe('Monochrome refuses XFA even when the losses are confirmed',
        monoXfa.ran === false && monoXfa.code === 'XFA_UNSAFE');
    const monoSigned = await call('run', 'signature-a4', 'monochrome', { confirm: true });
    probe('Monochrome refuses an applied signature even when the losses are confirmed',
        monoSigned.ran === false && monoSigned.code === 'SIGNATURE_UNSAFE');

    const both = await call('run', 'text-a4', 'both', { confirm: true, dpi: 150 });
    check('両方実行 inherits the same contract and the same encoding',
        both.ran && both.after.colourSpaces[0] === '/DeviceGray'
        && both.after.filters[0] === '/FlateDecode' && both.after.hasDct === false);

    // ---- 5. the budget --------------------------------------------------------
    console.log('\n=== 5. the H8 budget ===');
    const budget = await call('budget');
    note('A4 @300 DeviceGray flate', `${(budget.a4At300.peakBytes / MIB).toFixed(1)} MiB at "${budget.a4At300.peakStep}"`);
    check('the adopted constants are the adopted ones',
        budget.constants.MAX_RASTER_PIXELS === 134217728
        && budget.constants.MAX_OUTPUT_BYTES === 256 * MIB
        && budget.constants.literalsPerBlock === 16383
        && budget.constants.PAKO_STATE_BYTES === 267160,
        `pako state ${budget.constants.PAKO_STATE_BYTES} B, divisor ${budget.constants.literalsPerBlock}`);
    probe('the deflate bound uses lit_bufsize - 1, not lit_bufsize',
        budget.deflateBound.bound > budget.deflateBound.previousDivisorBound,
        `${budget.deflateBound.bound} vs ${budget.deflateBound.previousDivisorBound} at n=16384`);
    const a1At600 = await call('plans', ['vector-a1'], ['monochrome'], { dpi: 600 });
    probe('an A1 at 600 dpi is refused by the raster ceiling, before rendering',
        a1At600['vector-a1'].monochrome.status === 'OVER_RASTER_LIMIT',
        `${(a1At600['vector-a1'].monochrome.raster.pixels / 1e6).toFixed(0)} Mpx`);
    const a1At300 = await call('plans', ['vector-a1'], ['monochrome'], { dpi: 300 });
    note('A1 @300', `${a1At300['vector-a1'].monochrome.status}, peak ${(a1At300['vector-a1'].monochrome.filePeakBytes / MIB).toFixed(0)} MiB`);
    probe('a refusal carries the number it refused on, not a zero',
        a1At300['vector-a1'].monochrome.status === 'OVER_MEMORY_BUDGET'
        && a1At300['vector-a1'].monochrome.filePeakBytes > 512 * MIB
        && a1At300['vector-a1'].monochrome.raster.pixels > 0,
        `${(a1At300['vector-a1'].monochrome.filePeakBytes / MIB).toFixed(0)} MiB against a 512 MiB budget`);
    check('the memory presets admit more pages as they grow, and never fewer',
        budget.perPreset[536870912].pages300 <= budget.perPreset[1073741824].pages300
        && budget.perPreset[1073741824].pages300 <= budget.perPreset[2147483648].pages300,
        Object.entries(budget.perPreset).map(([k, v]) => `${(k / MIB)}MiB:${v.pages300}@300/${v.pages150}@150`).join(' '));

    // ---- 6. Margin ------------------------------------------------------------
    console.log('\n=== 6. 余白生成 ===');
    for (const angle of [0, 90, 180, 270]) {
        const r = await call('run', `rotate-${angle}`, 'margin');
        check(`Margin keeps /Rotate ${angle}`,
            r.ran && r.after.rotations[0] === angle,
            `after: ${r.after?.rotations?.[0]}`);
    }
    const marginCrop = await call('run', 'crop-offset', 'margin');
    check('Margin keeps the CropBox rather than discarding it',
        marginCrop.ran
        && JSON.stringify(marginCrop.after.boxes[0].crop) === JSON.stringify(marginCrop.before.boxes[0].crop),
        JSON.stringify(marginCrop.after.boxes[0].crop));
    const marginHidden = await call('run', 'mediabox-larger', 'margin');
    check('content the CropBox hid is still hidden afterwards',
        marginHidden.ran
        && JSON.stringify(marginHidden.after.boxes[0].crop) === JSON.stringify(marginHidden.before.boxes[0].crop));
    const marginLinks = await call('run', 'internal-links', 'margin');
    check('Margin keeps links and moves their destinations',
        marginLinks.ran
        && marginLinks.after.links.length === marginLinks.before.links.length
        && marginLinks.after.links.some((l) => l.uri === 'https://example.invalid/m5p'),
        JSON.stringify(marginLinks.after.links.map((l) => l.kind)));
    const before = marginLinks.before.links.find((l) => l.kind === '/XYZ');
    const after = marginLinks.after.links.find((l) => l.kind === '/XYZ');
    check('an XYZ destination is transformed, not left where it was',
        before && after && after.values[0] !== before.values[0] && after.values[1] !== before.values[1],
        `${JSON.stringify(before?.values)} -> ${JSON.stringify(after?.values)}`);
    const marginForm = await call('run', 'form-a4', 'margin');
    check('field values survive and the widget /DA is scaled with the page',
        marginForm.ran
        && marginForm.after.fields[0]?.value === 'M5P-FIELD-VALUE'
        && marginForm.after.fields[0]?.da !== marginForm.before.fields[0]?.da,
        `${marginForm.before.fields[0]?.da} -> ${marginForm.after.fields[0]?.da}`);
    const marginXfa = await call('run', 'xfa-a4', 'margin');
    check('Margin keeps XFA', marginXfa.ran && marginXfa.after.hasXfa === true);
    const marginMeta = await call('run', 'metadata-a4', 'margin');
    check('Margin keeps Info and XMP',
        marginMeta.ran && marginMeta.after.info.title === marginMeta.before.info.title
        && marginMeta.after.hasXmp === marginMeta.before.hasXmp);
    const marginPartial = await call('run', 'annotation-partial-crop', 'margin');
    probe('an annotation crossing the CropBox stops Margin before any change',
        marginPartial.ran === false && marginPartial.code === 'UNSUPPORTED_MARGIN_SEMANTICS',
        marginPartial.reason ?? '');
    const marginSigned = await call('run', 'signature-a4', 'margin');
    probe('Margin refuses an applied signature', marginSigned.ran === false && marginSigned.code === 'SIGNATURE_UNSAFE');

    // ---- 7. Optimize ----------------------------------------------------------
    console.log('\n=== 7. 最適化 (O2, lossless) ===');
    const optText = await call('run', 'text-a4', 'optimize');
    check('text, vectors and structure all survive',
        optText.ran
        && optText.after.text.join(' ').includes('NATIVE-TEXT-M5P')
        && optText.after.pathOps > 0 && optText.after.images.length === 0);
    const optOcr = await call('run', 'ocr-a4', 'optimize');
    check('the OCR layer survives', optOcr.ran && optOcr.after.text.join(' ').includes('OCR-LAYER-M5P'));
    const optAnnot = await call('run', 'annotation-a4', 'optimize');
    check('annotations survive', optAnnot.ran && optAnnot.after.annots.length === optAnnot.before.annots.length);
    const optForm = await call('run', 'form-a4', 'optimize');
    check('form values survive', optForm.ran && optForm.after.fields[0]?.value === 'M5P-FIELD-VALUE');
    const optXfa = await call('run', 'xfa-a4', 'optimize');
    check('XFA survives', optXfa.ran && optXfa.after.hasXfa === true);
    const optMeta = await call('run', 'metadata-a4', 'optimize');
    check('metadata survives', optMeta.ran && optMeta.after.info.title === optMeta.before.info.title && optMeta.after.hasXmp);
    const optRot = await call('run', 'rotate-90', 'optimize');
    check('rotation and boxes survive',
        optRot.ran && optRot.after.rotations[0] === 90
        && JSON.stringify(optRot.after.boxes) === JSON.stringify(optRot.before.boxes));
    probe('最適化 never makes the file bigger: it returns the source bytes instead',
        [optText, optAnnot, optForm, optXfa, optMeta].every((r) => r.after.bytes <= r.before.bytes),
        [optText, optAnnot, optForm, optXfa, optMeta].map((r) => `${r.before.bytes}->${r.after.bytes}`).join(' '));
    probe('and it does not rasterise anything',
        [optText, optOcr, optAnnot].every((r) => r.after.images.length === r.before.images.length && r.after.hasDct === false));

    // ---- 7b. metadata, structurally (RF-O2) ------------------------------------
    console.log('\n=== 7b. metadata carried, not reconstructed ===');
    const customMono = await call('metadataRoundTrip', 'metadata-custom', 'monochrome', { confirm: true, dpi: 150 });
    const customKeys = (side) => side.info.map((e) => e.key).sort();
    check('every Info entry survives a rebuild, custom keys included',
        customMono.ran
        && ['/Company', '/M5PCustom', '/SourceModified', '/Keywords', '/Title', '/Author']
            .every((k) => customKeys(customMono.after).includes(k)),
        `before ${customKeys(customMono.before).join(',')} | after ${customKeys(customMono.after).join(',')}`);
    const keywordsBefore = customMono.before.info.find((e) => e.key === '/Keywords')?.value;
    const keywordsAfter = customMono.after.info.find((e) => e.key === '/Keywords')?.value;
    probe('/Keywords is carried, not split and rebuilt into something else',
        keywordsBefore === keywordsAfter,
        `${JSON.stringify(keywordsBefore)} -> ${JSON.stringify(keywordsAfter)}`);
    check('an unfiltered XMP packet arrives readable, with its custom field',
        customMono.after.xmp?.startsWithXpacket === true
        && customMono.after.xmp?.hasTitleMarker === true
        && customMono.after.xmp?.hasCustomMarker === true,
        JSON.stringify(customMono.after.xmp));

    const flateMono = await call('metadataRoundTrip', 'metadata-xmp-flate', 'monochrome', { confirm: true, dpi: 150 });
    probe('a FlateDecode XMP keeps its filter instead of becoming compressed bytes claiming to be XML',
        flateMono.ran
        && flateMono.after.xmp?.filter === '/FlateDecode'
        && flateMono.after.xmp?.startsWithXpacket === true
        && flateMono.after.xmp?.hasTitleMarker === true,
        JSON.stringify(flateMono.after.xmp));
    check('and the structure-preserving operations keep theirs untouched',
        (await call('metadataRoundTrip', 'metadata-xmp-flate', 'layer')).after.xmp?.filter === '/FlateDecode');

    // ---- 8. B2 -----------------------------------------------------------------
    console.log('\n=== 8. batch (B2) ===');
    const batch = await call('batch', ['vector-a4', 'signature-a4', 'text-a4'], 'layer');
    check('every input is in the manifest, including the refused one',
        batch.manifest.files.length === 3
        && batch.manifest.files.some((f) => f.code === 'SIGNATURE_UNSAFE')
        && batch.manifest.summary.succeeded === 2 && batch.manifest.summary.failed === 1,
        JSON.stringify(batch.manifest.summary));
    check('a partial batch says so rather than looking complete',
        batch.status === 'PARTIAL' && batch.archiveBytes !== null);
    check('the archive is priced as a whole job, not as its largest file',
        batch.publication.ok && batch.publication.peakBytes > batch.publication.archiveBytes * 2,
        `peak ${(batch.publication.peakBytes / 1024).toFixed(0)} KiB vs archive ${(batch.publication.archiveBytes / 1024).toFixed(0)} KiB`);
    const zipNames = await call('zipNameAccounting');
    probe('ZIP entry names are priced in UTF-8 bytes, not characters',
        zipNames.japaneseBytes > zipNames.japaneseChars,
        `${zipNames.japaneseChars} chars = ${zipNames.japaneseBytes} bytes`);

    // RF-O5: the model against archives JSZip actually wrote.
    const zipReal = await call('zipModelVersusActual');
    for (const r of zipReal) {
        measureNote(`zip ${r.label}`,
            `actual ${fmt(r.actualBytes)} B, modelled ${fmt(r.modelledBytes)} B, `
            + `head-room ${fmt(r.overPricedBy)} B`);
    }
    probe('the hard model never under-prices a real archive',
        zipReal.every((r) => r.overPricedBy >= 0),
        zipReal.map((r) => `${r.label}:${r.overPricedBy}`).join(' '));
    probe('and a non-ASCII name is charged its Unicode Path extra field',
        zipReal.find((r) => r.label === 'japanese').unicodeExtraPerEntry.every((n) => n > 0)
        && zipReal.find((r) => r.label === 'ascii').unicodeExtraPerEntry.every((n) => n === 0),
        `japanese +${zipReal.find((r) => r.label === 'japanese').unicodeExtraPerEntry[0]} B/record`);

    // RF-O3: the ceiling on the artifact that exists.
    const guard = await call('actualOutputGuard');
    probe('the output ceiling admits the last byte under it and refuses the first over',
        guard.justUnder.ok === true && guard.first.ok === false,
        `${fmt(guard.limit)} B ok, ${fmt(guard.limit + 1)} B refused`);

    // RF-O4: the job refused before the first raster, and at each boundary.
    const overJob = await call('wholeJobPreflight', 40, 120 * MIB, 40 * MIB, 512 * MIB);
    const okJob = await call('wholeJobPreflight', 3, 120 * MIB, 40 * MIB, 512 * MIB);
    probe('a batch that cannot finish is refused before it starts',
        overJob.whole.ok === false && okJob.whole.ok === true,
        `40 files: ${(overJob.whole.peakBytes / MIB).toFixed(0)} MiB; 3 files: ${(okJob.whole.peakBytes / MIB).toFixed(0)} MiB`);
    probe('and a file boundary refuses before the next file is started',
        overJob.atLastBoundary.ok === false,
        `${(overJob.atLastBoundary.liveBytes / MIB).toFixed(0)} MiB live at the boundary`);

    // The adopted boundaries, derived from the production model rather than
    // quoted. If the corrected accounting moves them, these are the numbers.
    for (const colourSpace of ['DeviceGray', 'DeviceRGB']) {
        const b = await call('b2Boundaries', colourSpace);
        evidenceB2[colourSpace] = b;
        for (const memory of [512 * MIB, 1024 * MIB, 2048 * MIB]) {
            const row = b.presets[memory];
            note(`B2 ${colourSpace} at ${(memory / MIB)} MiB`,
                `${row.justUnder} accepted, ${row.firstOver} first-over (${row.binding})`);
        }
        check(`B2 ${colourSpace}: a larger preset never admits fewer files`,
            b.presets[512 * MIB].justUnder <= b.presets[1024 * MIB].justUnder
            && b.presets[1024 * MIB].justUnder <= b.presets[2048 * MIB].justUnder);
        probe(`B2 ${colourSpace}: the first-over file is refused by name`,
            ['OVER_MEMORY_BUDGET', 'OVER_OUTPUT_BUDGET'].includes(b.presets[512 * MIB].binding),
            b.presets[512 * MIB].binding);
    }

    // ---- 9. ownership ----------------------------------------------------------
    console.log('\n=== 9. ownership and cancellation ===');
    const own = await call('ownership');
    check('a token is current while its run is', own.before === true);
    probe('and stops being current the moment the run is superseded',
        own.afterSupersede === false && own.assertCode === 'CANCELLED');
    probe('an earlier run cannot become current again when a new one starts',
        own.earlierTokenAfterNewRun === false && own.newTokenCurrent === true);
    check('a changed setting is a different run', own.keysDiffer === true);
    const superseded = await call('supersededBatchPublishesNothing');
    probe('a superseded batch produces no archive at all',
        superseded.cancelled === true && superseded.archive === true);

    // ---- 10. the dependencies the arithmetic is derived from --------------------
    console.log('\n=== 10. the resolved dependencies (RF-O7) ===');
    note('pdf-lib', `${resolvedVersions.pdfLib.version} (${resolvedVersions.pdfLib.file})`);
    note("pdf-lib's pako", `${resolvedVersions.pakoUnderPdfLib.version} (${resolvedVersions.pakoUnderPdfLib.file})`);
    check('pdf-lib resolves the pako the H8 bound was derived from',
        resolvedVersions.pakoUnderPdfLib.version === '1.0.11',
        resolvedVersions.pakoUnderPdfLib.version
            ? `${resolvedVersions.pakoUnderPdfLib.version} at ${resolvedVersions.pakoUnderPdfLib.file}`
            : `unresolvable: ${resolvedVersions.pakoUnderPdfLib.error}`);
    check('and the direct dependencies are the pinned ones',
        resolvedVersions.pdfLib.version === '1.17.1'
        && resolvedVersions.jszip.version === '3.10.1'
        && resolvedVersions.pdfjs.version === '5.4.449',
        `pdf-lib ${resolvedVersions.pdfLib.version}, jszip ${resolvedVersions.jszip.version}, pdfjs-dist ${resolvedVersions.pdfjs.version}`);
    probe('the constants in source are the ones that library implies',
        budget.constants.literalsPerBlock === 16383 && budget.constants.PAKO_STATE_BYTES === 267160
        && resolvedVersions.pakoUnderPdfLib.version === '1.0.11',
        'a lockfile change that moves pako while leaving these numbers behind fails here');

    // ---- 11. local-only ---------------------------------------------------------
    console.log('\n=== 11. local only ===');
    check('no request left the machine', external.length === 0, external.join(', '));
    check('no page error during the run', pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
