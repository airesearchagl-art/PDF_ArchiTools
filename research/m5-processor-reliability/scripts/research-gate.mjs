/**
 * The M5 Processor reliability research gate.
 *
 * Four kinds of line, kept apart on purpose:
 *
 *   ASSERT         the research apparatus is sound — the fixtures are what
 *                  they claim, the inspector is read-only, nothing left the
 *                  machine. A failure here means the evidence cannot be
 *                  trusted, and the gate exits non-zero.
 *   PROBE          a negative probe: a check fed input that must make it fire,
 *                  so a later "retained" can be believed. Also exits non-zero.
 *   MEASURE        a number or an observed behaviour, recorded, not judged.
 *   BASELINE-FAIL  production behaviour that breaks a candidate invariant,
 *                  recorded with its root cause and the architecture proposed
 *                  for it. These describe the code on main; they are the
 *                  findings, and they do not make the gate red, because this
 *                  research does not change production code to make them go
 *                  away.
 *   HUMAN-OPEN     a decision only the Human Gate can make. Never a PASS.
 *
 * Run:  node research/m5-processor-reliability/scripts/make-fixtures.mjs
 *       node research/m5-processor-reliability/scripts/research-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RESEARCH = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm5-processor');
const DOWNLOADS = path.join(ROOT, 'test-fixtures', 'm5-processor-downloads');
const PORT = 5206;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIXTURES, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-fixtures.mjs')], { stdio: 'inherit' });
}
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const lines = [];
const log = (kind, name, ok, detail = '', extra = {}) => {
    lines.push({ kind, name, ok, detail, ...extra });
    const tag = kind === 'MEASURE' || kind === 'HUMAN-OPEN'
        ? kind : `${kind} ${ok ? 'PASS' : 'FAIL'}`;
    console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
    if (extra.rootCause) console.log(`      root cause: ${extra.rootCause}`);
    if (extra.architecture) console.log(`      proposed:   ${extra.architecture}`);
};
const assert = (name, ok, detail) => log('ASSERT', name, ok, detail);
const probe = (name, ok, detail) => log('PROBE', name, ok, detail);
const measure = (name, detail, data) => log('MEASURE', name, null, detail, data ? { data } : {});
const baselineFail = (name, detail, rootCause, architecture, data) => log(
    'BASELINE-FAIL', name, false, detail, { rootCause, architecture, ...(data ? { data } : {}) },
);
const human = (id, question, recommendation) => log('HUMAN-OPEN', `${id} ${question}`, null,
    recommendation ? `recommendation: ${recommendation}` : '');

// Provenance, unambiguous: what production code was measured, which research
// commit the gate ran from, whether that tree was clean, and who ran it. This
// is local research evidence; Core CI does not run this gate.
const evidence = {
    ranAt: new Date().toISOString(),
    ranBy: 'M5 research gate (local run on the research branch)',
    productionBase: '78b5bd5ee676ee72621bccf9524225cd4ce8482a',
    researchHeadAtRun: null,
    researchBranchAtRun: null,
    workingTreeDirty: null,
    coreCiRunsThisGate: false,
    sections: {},
};
try {
    const git = (args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
    evidence.researchHeadAtRun = git(['rev-parse', 'HEAD']);
    evidence.researchBranchAtRun = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    evidence.workingTreeDirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
} catch { /* not a checkout */ }

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 0,
});
const session = await browser.target().createCDPSession();
await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });

const external = [];
const pageErrors = [];
const consoleErrors = [];
const failedResponses = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* data:, blob: */ }
};
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const s = await target.createCDPSession();
        await s.send('Network.enable');
        s.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});
async function newPage() {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('request', (r) => record(r.url()));
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.url()}`); });
    page.on('dialog', async (d) => { await d.dismiss(); });
    return page;
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

let exitCode = 1;
try {
    const h = await newPage();
    await h.goto(`${ORIGIN}/research/m5-processor-reliability/scripts/harness.html`, { waitUntil: 'networkidle0' });
    await h.waitForFunction(() => window.__m5Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => h.evaluate((f, a) => window.__m5[f](...a), fn, args);

    // ---- 1. the corpus is what it claims --------------------------------------
    console.log('\n=== 1. the corpus (controls) ===');
    const names = ['vector-a4', 'text-a4', 'raster-a4', 'ocr-a4', 'mixed-a4', 'transparency-a4',
        'annotation-a4', 'link-a4', 'form-a4', 'signature-a4', 'xfa-a4', 'metadata-a4', 'three-pages',
        'vector-a3', 'vector-a1', 'vector-a0', 'landscape-a4', 'rotate-0', 'rotate-90', 'rotate-180',
        'rotate-270', 'crop-offset', 'mediabox-offset', 'mediabox-larger', 'mixed-sizes', 'batch-ok', 'long-8'];
    const corpus = await call('corpus', names);
    evidence.sections.corpus = Object.fromEntries(Object.entries(corpus).map(([k, v]) => [k, {
        bytes: v.bytes, pages: v.pages.length, acroForm: v.acroForm, xfa: v.xfa,
        boxes: v.pages.map((p) => ({ media: p.mediaBox, crop: p.cropBox, rotate: p.rotate })),
        ops: v.pages.map((p) => ({ path: p.content.pathOps, text: p.content.textShows, images: p.images.length, invisible: p.content.invisibleTextModes })),
        annots: v.pages.flatMap((p) => p.annots.map((a) => a.subtype)),
        signatures: v.signatures, info: v.info, xmp: v.xmpMarker,
    }]));
    const c = corpus;
    const p0 = (n) => c[n].pages[0];
    assert('vector-a4 is vectors only', p0('vector-a4').content.pathOps > 10 && p0('vector-a4').content.textShows === 0 && p0('vector-a4').images.length === 0,
        `${p0('vector-a4').content.pathOps} path operators, no text, no image`);
    assert('text-a4 has extractable native text', c['text-a4'].text.join(' ').includes('NATIVE-TEXT-M5'));
    assert('raster-a4 is one image and nothing to read', p0('raster-a4').images.length === 1 && p0('raster-a4').content.textShows === 0);
    assert('ocr-a4 carries an invisible text layer a reader extracts',
        c['ocr-a4'].text.join(' ').includes('OCR-LAYER-M5') && p0('ocr-a4').content.invisibleTextModes >= 1 && p0('ocr-a4').images.length === 1);
    assert('annotation-a4 has a Square and a Text annotation',
        p0('annotation-a4').annots.map((a) => a.subtype).sort().join(',') === 'Square,Text');
    assert('link-a4 has a URI link', p0('link-a4').annots.some((a) => a.subtype === 'Link' && a.uri === 'https://example.invalid/m5-link'));
    assert('form-a4 has a field with its value', c['form-a4'].fields.some((f) => f.name === 'm5.text' && f.value === 'M5-FIELD-VALUE'));
    assert('signature-a4 is signed over the whole file, and the proxy says intact',
        c['signature-a4'].signatures[0]?.state === 'intact', JSON.stringify(c['signature-a4'].signatures[0]));
    assert('xfa-a4 carries /XFA', c['xfa-a4'].xfa === true);
    assert('metadata-a4 carries Info fields and an XMP stream', c['metadata-a4'].info.author === 'M5 author' && c['metadata-a4'].xmpMarker === true);
    assert('rotate-N fixtures carry /Rotate N', [0, 90, 180, 270].every((r) => p0(`rotate-${r}`).rotate === r));
    assert('crop-offset has a CropBox origin at (50,70)', p0('crop-offset').cropBox[0] === 50 && p0('crop-offset').cropBox[1] === 70);
    assert('mediabox-offset has a MediaBox origin at (200,300)', p0('mediabox-offset').mediaBox[0] === 200 && p0('mediabox-offset').mediaBox[1] === 300);
    assert('mediabox-larger hides content outside its CropBox',
        p0('mediabox-larger').mediaBox[2] > p0('mediabox-larger').cropBox[2] && c['mediabox-larger'].thumbs[0] !== undefined);
    assert('mixed-sizes has three different sheets', new Set(c['mixed-sizes'].pages.map((p) => p.mediaBox.join())).size === 3);
    assert('A1 and A0 fixtures are the sheets they name',
        Math.round(p0('vector-a1').mediaBox[2]) === 1684 && Math.round(p0('vector-a0').mediaBox[3]) === 3370);

    const sig = await call('signatureProbe');
    probe('the signature proxy notices one changed byte in the signed range',
        sig.original[0]?.state === 'intact' && sig.tampered[0]?.state === 'digest-mismatch',
        `${sig.original[0]?.state} -> ${sig.tampered[0]?.state}`);

    // ---- 2. what the existing M3 inspection says ------------------------------
    console.log('\n=== 2. the existing source inspection (M3 assessSource) ===');
    const assess = await call('assess', ['text-a4', 'form-a4', 'signature-a4', 'xfa-a4', 'annotation-a4', 'metadata-a4', 'raster-a4']);
    evidence.sections.assess = assess;
    for (const [k, v] of Object.entries(assess)) if (!k.startsWith('__')) measure(`assessSource(${k})`, `${v.supported ? 'supported' : 'refused'} ${v.codes.join(',')}`);
    probe('it refuses a signed document', assess['signature-a4'].supported === false && assess['signature-a4'].codes.includes('signed'));
    probe('it refuses XFA rather than letting pdf-lib delete it', assess['xfa-a4'].supported === false && assess['xfa-a4'].codes.includes('xfa-unsupported'));
    assert('it accepts ordinary forms, annotations and metadata', ['text-a4', 'form-a4', 'annotation-a4', 'metadata-a4', 'raster-a4'].every((k) => assess[k].supported));
    assert('and looking does not create an AcroForm', assess.__inspectionIsReadOnly === true);

    // ---- 2b. facts, apart from policy (RF-K1) ------------------------------------
    //
    // assessSource's `supported` is the Annotator's verdict: XFA → refused, no
    // document. The Processor's XFA policy is H7 and still open, so the
    // Processor reads facts and applies a policy separately.
    console.log('\n=== 2b. source facts, apart from any policy (RF-K1) ===');
    const sf = await call('sourceFacts');
    evidence.sections.sourceFacts = sf;
    for (const [n, f] of Object.entries(sf.facts)) {
        measure(`facts(${n})`, `readable ${f.readable}, encrypted ${f.encrypted}, pages ${f.pageCount}, AcroForm ${f.hasAcroForm}, XFA ${f.hasXfa}, fields ${f.fieldCount}, signature fields ${f.signatureFields.map((s) => `${s.name}${s.signed ? ' (signed)' : ''}`).join(',') || 'none'}, form ${f.formInspectionState}`);
    }
    probe('reading facts never reaches getForm() — trapped to throw, and it did not',
        sf.getFormCallsWhileReading === 0 && sf.getFormCallsByAssessSource > 0,
        `0 calls while reading facts; assessSource on an ordinary form called it ${sf.getFormCallsByAssessSource} time(s), so the trap was live`);
    assert('facts agree with M3 on every fact M3 also reports',
        sf.facts['signature-a4'].signatureFields.length === 1 && sf.m3['signature-a4'].codes.includes('signed')
        && sf.facts['xfa-a4'].hasXfa && sf.m3['xfa-a4'].codes.includes('xfa-unsupported')
        // pdf-lib's parser is lenient: the non-PDF loads, and fails at its pages
        // -- where M3 also calls it unreadable.
        && !(sf.facts.invalid.readable && sf.facts.invalid.pagesValid) && sf.m3.invalid.codes.includes('unreadable')
        && sf.facts['form-a4'].fieldCount === 2 && sf.facts['form-a4'].formInspectionState === 'read');
    probe('facts carry no verdict: an XFA document is described, not refused, until a policy is applied',
        sf.facts['xfa-a4'].readable === true && sf.m3['xfa-a4'].docReturned === false
        && sf.matrix['applied-only']['xfa-a4'].layer === 'READY',
        `M3 returns no document for it; under 'applied-only' Layer plans READY`);
    for (const [policy, rows] of Object.entries(sf.matrix)) {
        measure(`H7 candidate '${policy}'`, ['signature-a4', 'xfa-a4', 'form-a4'].map((n) => `${n}: ${Object.entries(rows[n])
            .filter(([op]) => ['layer', 'margin-inplace', 'monochrome-A', 'monochrome-C', 'optimize-O1', 'optimize-O3', 'normalize-size'].includes(op))
            .map(([op, s]) => `${op}=${s}`).join(' ')}`).join(' | '));
    }
    probe('every candidate policy refuses an applied signature for every operation, because every operation re-saves',
        Object.values(sf.matrix).every((rows) => Object.values(rows['signature-a4']).every((s) => s === 'SIGNATURE_UNSAFE')));
    // RF-L1: a place for a signature is not a signature.
    const applied = sf.facts['signature-a4'];
    const empty = sf.facts['unsigned-signature-field'];
    measure('an applied signature against an empty signature field',
        `applied: field ${applied.hasSignatureField}, applied ${applied.hasAppliedSignature}, SigFlags ${applied.sigFlags}; `
        + `empty: field ${empty.hasSignatureField}, applied ${empty.hasAppliedSignature}, SigFlags ${empty.sigFlags}`);
    probe('the facts tell an empty /Sig field from an applied signature, and /SigFlags alone from both',
        applied.hasSignatureField && applied.hasAppliedSignature
        && empty.hasSignatureField && empty.hasAppliedSignature === false && empty.sigFlags === 3
        && empty.signatureFields.length === 1 && empty.signatureFields[0].signed === false,
        'an empty field with /SigFlags 3 is a signable document, not a signed one');
    measure('what the operations do to an empty signature field',
        Object.entries(sf.emptyField).filter(([k]) => k !== 'before')
            .map(([op, r]) => `${op}: ${r.error ? r.error : `field ${r.hasSignatureField}, AcroForm ${r.hasAcroForm}`}`).join('; '));
    probe('an empty signature field is a form object: Layer keeps it, Monochrome removes it with the rest of the form',
        sf.emptyField.layer.hasSignatureField === true && sf.emptyField.layer.hasAppliedSignature === false
        && sf.emptyField.monochrome.hasSignatureField === false && sf.emptyField.monochrome.hasAcroForm === false,
        'so it belongs to the operation\'s form contract (H6), not to a signature refusal');
    probe("policy A ('applied-only') refuses the applied signature and lets the empty field through; policy B refuses both",
        Object.values(sf.matrix['applied-only']['signature-a4']).every((s) => s === 'SIGNATURE_UNSAFE')
        && sf.matrix['applied-only']['unsigned-signature-field'].layer === 'READY'
        && sf.matrix['applied-only']['unsigned-signature-field']['margin-inplace'] === 'READY'
        && sf.matrix['applied-only']['unsigned-signature-field']['monochrome-A'] === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION'
        && Object.values(sf.matrix['any-signature-infrastructure']['unsigned-signature-field']).every((s) => s === 'SIGNATURE_UNSAFE'),
        `A: layer READY, monochrome-A ${sf.matrix['applied-only']['unsigned-signature-field']['monochrome-A']}; `
        + 'B: every operation SIGNATURE_UNSAFE');
    assert('no candidate policy calls an unsigned document signed',
        sf.facts['unsigned-signature-field'].hasAppliedSignature === false);

    // ---- 3. the five legacy operations ----------------------------------------
    console.log('\n=== 3. baseline: the five target operations ===');
    const a4 = ['vector-a4', 'text-a4', 'raster-a4', 'ocr-a4', 'mixed-a4', 'transparency-a4', 'annotation-a4',
        'link-a4', 'form-a4', 'signature-a4', 'xfa-a4', 'metadata-a4', 'three-pages', 'landscape-a4',
        'rotate-0', 'rotate-90', 'rotate-180', 'rotate-270', 'crop-offset', 'mediabox-offset', 'mediabox-larger'];
    const large = ['vector-a3', 'vector-a1', 'vector-a0', 'mixed-sizes'];
    const ops = ['layer', 'monochrome', 'both', 'margin', 'optimize'];
    const plan = [];
    for (const op of ops) {
        for (const fixture of a4) plan.push({ op, fixture });
        // Large sheets at 72 dpi for the raster operations: the structural
        // outcome is the same, and section 6 prices the resolutions.
        for (const fixture of large) plan.push({ op, fixture, dpi: ['monochrome', 'both', 'optimize'].includes(op) ? 72 : undefined });
    }
    const rows = await call('baseline', plan);
    evidence.sections.baseline = rows;
    const row = (op, fixture) => rows.find((r) => r.op === op && r.fixture === fixture);
    for (const op of ops) {
        const r = (f) => row(op, f);
        console.log(`\n  -- ${op} --`);
        console.log(`    text ${r('text-a4').nativeText} | OCR ${r('ocr-a4').ocrText} | vectors ${r('vector-a4').vectors} | raster ${r('raster-a4').raster} | full-page raster ${r('text-a4').fullPageRaster}`);
        console.log(`    annotations ${r('annotation-a4').annotations} | links ${r('link-a4').links} | form ${r('form-a4').form} | signature ${r('signature-a4').signature} | XFA ${r('xfa-a4').xfa}`);
        console.log(`    metadata title ${r('metadata-a4').metadata.title}, author ${r('metadata-a4').metadata.author}, producer ${r('metadata-a4').metadata.producer}, XMP ${r('metadata-a4').metadata.xmp}`);
        console.log(`    page order ${r('three-pages').pageOrder} | rotate 90: ${JSON.stringify(r('rotate-90').boxes[0])}`);
        console.log(`    crop-offset: ${JSON.stringify(r('crop-offset').boxes[0])}`);
        console.log(`    mediabox-larger hidden content revealed: ${r('mediabox-larger').hiddenContentRevealed}`);
        console.log(`    sizes: vector ${r('vector-a4').size.before}->${r('vector-a4').size.after} (x${r('vector-a4').size.ratio.toFixed(1)}), raster ${r('raster-a4').size.before}->${r('raster-a4').size.after} (x${r('raster-a4').size.ratio.toFixed(2)})`);
        measure(`${op}: preservation row recorded for ${a4.length + large.length} fixtures`, `${rows.filter((x) => x.op === op && x.error).length} errors`);
    }

    // Classify the findings. Each is a measured fact about main.
    const flattening = ['monochrome', 'both', 'optimize'];
    for (const op of flattening) {
        const r = (f) => row(op, f);
        if (r('text-a4').nativeText.startsWith('lost') && r('ocr-a4').ocrText === 'lost' && r('vector-a4').vectors === 'lost') {
            baselineFail(`${op}: searchable text, the OCR layer and every vector are replaced by one JPEG per page`,
                `full-page raster on every page: ${r('text-a4').fullPageRaster}; output image ${JSON.stringify(r('text-a4').outImages[0])}`,
                'pdf-processor.ts renders each page to a canvas and writes a new PDF of canvas.toDataURL(JPEG) images (lines 61-160); nothing of the source document is carried over',
                'classify as INTENTIONAL_FLATTENING and require PLAN=STRUCTURE_LOSS_REQUIRES_CONFIRMATION with the losses named, or adopt a structure-preserving candidate (H1/H2/H5)');
        }
        const lost = [['annotations', r('annotation-a4').annotations], ['links', r('link-a4').links], ['form', r('form-a4').form],
            ['signature', r('signature-a4').signature], ['XFA', r('xfa-a4').xfa], ['XMP', r('metadata-a4').metadata.xmp]]
            .filter(([, v]) => v !== 'retained' && v !== 'retained with value' && v !== 'intact');
        if (lost.length > 0) {
            baselineFail(`${op}: annotations, links, forms, the signature, XFA and metadata do not survive, and nothing says so`,
                lost.map(([k, v]) => `${k}: ${v}`).join('; '),
                'the output is a new PDFDocument; only rendered pixels cross over, and the run reports done',
                'every output item must be accounted for in the PLAN; a loss is either refused or confirmed, never silent (H5/H6/H7)');
        }
    }
    for (const op of ops) {
        const r = row(op, 'three-pages');
        if (r.pageCount.after !== 3 || r.pageOrder.startsWith('changed')) {
            baselineFail(`${op}: page count or order`, `${r.pageCount.before} -> ${r.pageCount.after}, ${r.pageOrder}`, 'unexpected', 'investigate');
        } else {
            measure(`${op}: page count and order`, `${r.pageCount.before} -> ${r.pageCount.after}, ${r.pageOrder}`);
        }
    }
    {
        const r = (f) => row('optimize', f);
        const grows = ['vector-a4', 'text-a4', 'annotation-a4', 'form-a4'].filter((f) => r(f).size.ratio > 1);
        if (grows.length > 0) {
            baselineFail('optimize: 「最適化」 makes a vector document many times larger',
                grows.map((f) => `${f} ${r(f).size.before}->${r(f).size.after} B (x${r(f).size.ratio.toFixed(1)})`).join('; '),
                'the operation is a 150 dpi JPEG rasterisation, not a size optimisation: a page of vectors costs a few hundred bytes, its raster tens of kilobytes',
                'the name and the contract must agree — see decision-matrix O1/O2/O3 (H2)');
        }
    }
    {
        const r = (f) => row('margin', f);
        const kept = r('text-a4').nativeText === 'extractable' && r('vector-a4').vectors === 'retained';
        (kept ? measure : baselineFail)('margin: text and vectors survive as operators inside a Form XObject',
            `text ${r('text-a4').nativeText}, vectors ${r('vector-a4').vectors}, OCR ${r('ocr-a4').ocrText}, raster ${r('raster-a4').raster}`);
        const lostPage = [['annotations', r('annotation-a4').annotations], ['links', r('link-a4').links], ['form', r('form-a4').form],
            ['signature', r('signature-a4').signature], ['XFA', r('xfa-a4').xfa], ['XMP', r('metadata-a4').metadata.xmp],
            ['author', r('metadata-a4').metadata.author]]
            .filter(([, v]) => !['retained', 'retained with value', 'intact', 'n/a'].includes(v));
        if (lostPage.length > 0) {
            baselineFail('margin: every page-level and document-level object is left behind',
                lostPage.map(([k, v]) => `${k}: ${v}`).join('; '),
                'processMargin creates a new PDFDocument and draws each source page into it with embedPage/drawPage (pdf-processor.ts:167-232); embedPage carries the content stream and its resources only',
                'in-place content transform + explicit annotation/widget coordinate transform (prototype/margin-inplace.mjs), refusing what it cannot move (H3/H6)');
        }
        const rot = ['rotate-90', 'rotate-180', 'rotate-270'].map((f) => [f, r(f).boxes[0]]);
        const rotChanged = rot.filter(([, b]) => b.rotateAfter !== b.rotateBefore);
        if (rotChanged.length > 0) {
            baselineFail('margin: /Rotate is dropped, so a rotated sheet comes back turned',
                rotChanged.map(([f, b]) => `${f}: /Rotate ${b.rotateBefore} -> ${b.rotateAfter}, MediaBox ${JSON.stringify(b.mediaAfter)}`).join('; '),
                'the new page is created at the MediaBox size with no /Rotate, and the embedded page is drawn unrotated',
                'transform in place in the page\'s own user space, keeping /Rotate; position the margin by the visible corner (prototype)');
        }
        const crop = r('crop-offset').boxes[0];
        if (JSON.stringify(crop.cropAfter) !== JSON.stringify(crop.cropBefore)) {
            baselineFail('margin: the CropBox is not the page that comes back',
                `CropBox ${JSON.stringify(crop.cropBefore)} -> ${JSON.stringify(crop.cropAfter)}; MediaBox ${JSON.stringify(crop.mediaBefore)} -> ${JSON.stringify(crop.mediaAfter)}`,
                'the new page takes page.getSize() (the MediaBox) and discards the CropBox',
                'keep the source page boxes; transform only content and annotations');
        }
        if (r('mediabox-larger').hiddenContentRevealed) {
            baselineFail('margin: content the CropBox hid becomes visible',
                `hidden magenta ${r('mediabox-larger').hiddenMagentaBefore.toFixed(4)} -> ${r('mediabox-larger').hiddenMagentaAfter.toFixed(4)} of the page`,
                'the page is embedded with its MediaBox as the bounding box, and the output page is MediaBox-sized',
                'clip to the mapped visible box (prototype does)');
        }
    }
    {
        const r = (f) => row('layer', f);
        measure('layer: structure survives as a pdf-lib re-save',
            `text ${r('text-a4').nativeText}, OCR ${r('ocr-a4').ocrText}, vectors ${r('vector-a4').vectors}, raster ${r('raster-a4').raster}, annotations ${r('annotation-a4').annotations}, links ${r('link-a4').links}, form ${r('form-a4').form}, XFA ${r('xfa-a4').xfa}, XMP ${r('metadata-a4').metadata.xmp}, rotate-90 ${JSON.stringify(r('rotate-90').boxes[0].rotateAfter)}`);
        if (r('signature-a4').signature !== 'intact') {
            baselineFail('layer: a signed document is re-saved and its signature silently invalidated',
                `signature ${r('signature-a4').signature}`,
                'processLayer loads with pdf-lib and calls save() — a full re-serialisation — without inspecting the source',
                'PLAN=SIGNATURE_UNSAFE from the common SourceFacts reading (the M3 dictionary-level logic) under the adopted H7 policy, before any byte is produced');
        }
        if (r('metadata-a4').metadata.producer !== 'retained' || r('metadata-a4').metadata.modDate !== 'retained') {
            baselineFail('layer: document metadata is rewritten',
                `producer ${r('metadata-a4').metadata.producer}, modDate ${r('metadata-a4').metadata.modDate}`,
                'PDFDocument.load defaults to updateMetadata: true',
                'load with updateMetadata: false, as assessSource does, and state which metadata the operation changes');
        }
        const cover = (f) => r(f).overlayCoverage;
        measure('layer: share of the source ink the overlay reached',
            ['vector-a4', 'text-a4', 'crop-offset', 'mediabox-offset', 'rotate-90'].map((f) => `${f} ${cover(f)?.toFixed(2)}`).join(', '));
        if (cover('mediabox-offset') !== null && cover('mediabox-offset') < 0.9 * cover('text-a4')) {
            baselineFail('layer: on a page whose MediaBox does not start at (0,0), the overlay misses part of the sheet',
                `overlay reached ${(cover('mediabox-offset') * 100).toFixed(0)}% of the ink, against ${(cover('text-a4') * 100).toFixed(0)}% on an ordinary page`,
                'processLayer draws its rectangle at x=0, y=0 with page.getSize(), ignoring the MediaBox origin (pdf-processor.ts:42-52)',
                'draw over the page\'s visible box (CropBox ∩ MediaBox) in its own coordinates');
        }
    }
    {
        const r = (f) => row('both', f);
        measure('both: Monochrome\'s losses are inherited, then Layer re-saves the raster',
            `text ${r('text-a4').nativeText}, annotations ${r('annotation-a4').annotations}, signature ${r('signature-a4').signature}, output ${r('text-a4').size.after} B vs monochrome ${row('monochrome', 'text-a4').size.after} B`);
    }

    // ---- 4. the hardened lanes, compatibility only ----------------------------
    console.log('\n=== 4. hardened lanes: what a common PLAN would add ===');
    const hardened = await call('hardened');
    evidence.sections.hardened = hardened;
    for (const r of hardened) {
        measure(`${r.lane} on ${r.fixture}`, r.error ? `refused/threw: ${r.error}`
            : `signature ${r.signature}, XFA ${r.xfa}, form ${r.form}, producer ${r.metadata?.producer}, text ${r.nativeText}`);
    }
    const hardenedSig = hardened.filter((r) => r.fixture === 'signature-a4' && r.signature && r.signature !== 'intact');
    if (hardenedSig.length > 0) {
        baselineFail('hardened lanes: a signed document is processed and its signature invalidated without a refusal',
            hardenedSig.map((r) => `${r.lane}: ${r.signature}`).join('; '),
            'neither normalizePageSize nor updateTitleBlocks inspects the source; both re-serialise with pdf-lib save()',
            'a common PLAN step reading SourceFacts and applying the adopted H7 policy *before* the lane — adds a refusal, removes nothing the lanes guarantee (not a redesign of either lane)');
    }
    const hardenedMeta = hardened.filter((r) => r.fixture === 'metadata-a4' && r.metadata && r.metadata.producer !== 'retained');
    if (hardenedMeta.length > 0) {
        baselineFail('hardened lanes: Producer and ModDate are rewritten on every run',
            hardenedMeta.map((r) => `${r.lane}: producer ${r.metadata.producer}, modDate ${r.metadata.modDate}`).join('; '),
            'both load with PDFDocument.load defaults (updateMetadata: true); page-size-normalizer.ts states that document metadata survives',
            'record as a compatibility note for the lanes\' own owners; a common layer must not silently change it either way');
    }
    measure('hardened lanes keep XFA and form values (they never call getForm)',
        hardened.filter((r) => ['xfa-a4', 'form-a4'].includes(r.fixture)).map((r) => `${r.lane}/${r.fixture}: ${r.xfa !== 'n/a' ? r.xfa : r.form}`).join('; '));

    // ---- 5. Monochrome, Margin and Optimize candidates --------------------------
    console.log('\n=== 5a. Monochrome candidates A / B / C ===');
    const monoNames = ['vector-a4', 'text-a4', 'transparency-a4', 'annotation-a4', 'link-a4', 'form-a4',
        'metadata-a4', 'rotate-90', 'crop-offset', 'raster-a4', 'ocr-a4', 'mixed-a4', 'colour-raster-a4', '@opt:mixed-a4'];
    const mono = await call('monoCandidates', monoNames);
    evidence.sections.monochrome = mono;
    for (const [name, r] of Object.entries(mono)) {
        const cell = (x) => (x.status === 'CONVERTED'
            ? `text ${x.nativeText}/${x.ocrText} vec ${x.vectors} img ${x.raster} ann ${x.annotations} chroma ${x.chromaAfter?.toFixed(4)} ${x.size?.after}B`
            : `${x.status}${x.refusals?.length ? `: ${x.refusals[0]}` : ''}`);
        console.log(`  ${name.padEnd(16)} A ${cell(r.A)}`);
        console.log(`  ${''.padEnd(16)} B ${cell(r.B)}`);
        console.log(`  ${''.padEnd(16)} C ${cell(r.C)}`);
    }
    const converted = (label) => Object.entries(mono).filter(([, r]) => r[label].status === 'CONVERTED');
    measure('candidate B converts', converted('B').map(([n]) => n).join(', '));
    measure('candidate C converts', converted('C').map(([n]) => n).join(', '));
    probe('B refuses every page that draws an image, rather than leaving it in colour',
        ['raster-a4', 'ocr-a4', 'mixed-a4'].every((n) => mono[n].B.status === 'REFUSED'),
        ['raster-a4', 'ocr-a4', 'mixed-a4'].map((n) => mono[n].B.refusals?.[0]).join(' | '));
    const bKeeps = converted('B').every(([, r]) => r.B.nativeText !== 'lost' && r.B.vectors !== 'lost'
        && (r.B.annotations === 'n/a' || r.B.annotations === 'retained'));
    measure('where B converts, text, vectors and annotations are kept', `${bKeeps}`);
    measure('where C converts, the page is grey', converted('C').map(([n, r]) => `${n} ${r.C.chromaAfter?.toFixed(4)}`).join(', '));
    probe('C turns a saturated image grey, through both decoders it supports',
        mono['colour-raster-a4'].C.status === 'CONVERTED' && mono['colour-raster-a4'].C.chromaBefore > 0.5
        && mono['colour-raster-a4'].C.chromaAfter < 0.001
        && mono['@opt:mixed-a4'].C.status === 'CONVERTED' && mono['@opt:mixed-a4'].C.chromaAfter < 0.001,
        `Flate: chroma ${mono['colour-raster-a4'].C.chromaBefore?.toFixed(3)} -> ${mono['colour-raster-a4'].C.chromaAfter?.toFixed(3)}, text ${mono['colour-raster-a4'].C.nativeText}; `
        + `DCT (production Optimize output): ${mono['@opt:mixed-a4'].C.chromaBefore?.toFixed(3)} -> ${mono['@opt:mixed-a4'].C.chromaAfter?.toFixed(3)}`);

    console.log('\n=== 5b. Margin: production (embedPage) against in-place ===');
    const marginNames = ['text-a4', 'ocr-a4', 'annotation-a4', 'link-a4', 'form-a4', 'xfa-a4', 'metadata-a4',
        'rotate-0', 'rotate-90', 'rotate-180', 'rotate-270', 'crop-offset', 'mediabox-larger', 'mixed-sizes'];
    const margin = await call('marginCandidates', marginNames);
    evidence.sections.margin = margin;
    for (const [name, r] of Object.entries(margin)) {
        for (const [k, x] of Object.entries(r)) {
            console.log(`  ${name.padEnd(16)} ${k.padEnd(19)} ${x.status} text ${x.nativeText} ann ${x.annotations} link ${x.links} form ${x.form} xfa ${x.xfa} rot ${x.boxes?.rotateBefore}->${x.boxes?.rotateAfter} vs expected ${typeof x.againstExpected === 'object' ? x.againstExpected.meanAbs.toFixed(1) : x.againstExpected}${x.hiddenMagenta !== null && x.hiddenMagenta !== undefined ? ` hidden ${x.hiddenMagenta.toFixed(4)}` : ''}${x.refusals ? ` ${x.refusals[0]}` : ''}`);
        }
    }

    // RF-K4: what a margin has to carry besides the drawing.
    console.log('\n  -- Margin semantics (RF-K4) --');
    const ms = await call('marginSemantics');
    evidence.sections.marginSemantics = ms;
    const d = ms.destinations;
    console.log(`  destinations before ${JSON.stringify(d.before.links)} named ${JSON.stringify(d.before.named)} outline ${JSON.stringify(d.before.outline)}`);
    console.log(`  in-place             ${JSON.stringify(d.inplace?.links)} named ${JSON.stringify(d.inplace?.named)} outline ${JSON.stringify(d.inplace?.outline)}`);
    console.log(`  expected             XYZ ${JSON.stringify(d.expected.xyz)} FitH ${d.expected.fitH} FitR ${JSON.stringify(d.expected.fitR)} outline ${JSON.stringify(d.expected.outline)}`);
    const near = (a, b) => Math.abs(a - b) < 0.02;
    const xyz = d.inplace?.links[0];
    const fitr = d.inplace?.links[2];
    probe('in-place: a GoTo link keeps pointing at the same drawing — its /XYZ moves with the page it names',
        d.inplaceStatus === 'TRANSFORMED' && xyz[0] === 2 && near(xyz[2], d.expected.xyz[0]) && near(xyz[3], d.expected.xyz[1]) && xyz[4] === 0,
        `[p2 XYZ 100 700] -> ${JSON.stringify(xyz)}`);
    assert('and so do /FitR, the named destination (as PDF.js resolves it) and the outline item',
        fitr && d.expected.fitR.every((v, i) => near(fitr[i + 2], v))
        && near(d.inplace.named[2], d.expected.fitH) && near(d.readerNamedAfter[1], d.expected.fitH)
        && near(d.inplace.outline[2], d.expected.outline[0]) && near(d.inplace.outline[3], d.expected.outline[1])
        && d.inplace.outline[4] === null,
        `FitH 500 -> ${d.readerNamedAfter[1]} in PDF.js; outline null zoom stays null; ${d.movedDestinations} destinations moved`);
    measure('production Margin on the same document', `links ${d.production.annots}, named ${JSON.stringify(d.production.named)}, outline ${JSON.stringify(d.production.outline)} — all left behind`);
    probe('in-place refuses an annotation half outside the CropBox, before changing anything',
        ms.partial.status === 'REFUSED' && ms.partial.refusals[0].includes('not wholly inside') && ms.partial.controlStatus === 'TRANSFORMED',
        `${ms.partial.refusals[0]}; the same page without it transforms`);
    const wg = ms.widgets;
    measure('form widget text height (PDF.js, points)', `source ${wg.source.inkHeight}; in-place ${wg.scaled.inkHeight} (stored appearance); regenerated from /DA: scaled ${wg.scaledRegenerated.inkHeight}, unscaled ${wg.unscaledRegenerated.inkHeight}; /DA ${JSON.stringify(wg.source.da)} -> ${JSON.stringify(wg.scaled.da)}`);
    const ratio = (x) => x / wg.source.inkHeight;
    probe('in-place: a widget redrawn from /DA is drawn at the margin\'s scale, because /DA is scaled with it',
        Math.abs(ratio(wg.scaled.inkHeight) - 0.8) < 0.06 && Math.abs(ratio(wg.scaledRegenerated.inkHeight) - 0.8) < 0.06
        && Math.abs(ratio(wg.unscaledRegenerated.inkHeight) - 1) < 0.06 && wg.fieldValue === 'M5-FIELD-VALUE',
        `stored ×${ratio(wg.scaled.inkHeight).toFixed(2)}, regenerated ×${ratio(wg.scaledRegenerated.inkHeight).toFixed(2)}; without scaling /DA a regenerated widget would be ×${ratio(wg.unscaledRegenerated.inkHeight).toFixed(2)} in a box ×0.8`);

    // RF-K6: which layer the overlay is on.
    console.log('\n=== 5d. Layer and annotation stacking (RF-K6) ===');
    const ls = await call('layerStacking');
    evidence.sections.layerStacking = ls;
    measure('an opaque blue annotation under the white 50% layer',
        `before ${JSON.stringify(ls.before)}; production ${JSON.stringify(ls.production)}; overlay-as-last-annotation ${JSON.stringify(ls.above)}`);
    measure('annotations', `before ${ls.annotsBefore.join(',')}; production ${ls.annotsProduction.join(',')}; above ${ls.annotsAbove.join(',')}`);
    assert('production puts the layer below every annotation: the annotation is not faded',
        JSON.stringify(ls.production) === JSON.stringify(ls.before),
        'annotations are painted after the page content the rectangle is drawn into');
    probe('a layer above annotations exists without flattening: one more annotation, painted last',
        ls.above[0] > 100 && ls.above[1] > 100 && ls.above[2] > 240 && ls.annotsAbove.length === ls.annotsBefore.length + 1
        && ls.textKept.above === true && ls.contentAbove > 0.95,
        `the blue fades to ${JSON.stringify(ls.above)}; the original annotation is kept; the layer is itself an annotation`);

    console.log('\n=== 5c. Optimize: what happens to size ===');
    const opt = await call('optimizeSizes', ['vector-a4', 'text-a4', 'raster-a4', 'ocr-a4', 'mixed-a4', 'form-a4', 'annotation-a4', 'vector-a1']);
    evidence.sections.optimize = opt;
    for (const [name, r] of Object.entries(opt)) {
        console.log(`  ${name.padEnd(13)} ${String(r.source).padStart(7)} B | O1@72 x${r['O1@72'].ratio.toFixed(2)} @150 x${r['O1@150'].ratio.toFixed(2)} @300 x${r['O1@300'].ratio.toFixed(2)} (text ${r['O1@150'].text}) | O2 x${r.O2lossless.ratio.toFixed(2)} | O3@150 x${r.O3at150.ratio.toFixed(2)} (text ${r.O3at150.text}, vectors ${r.O3at150.vectors}, annots ${r.O3at150.annotations}, re-encoded ${r.O3at150.reencoded})`);
    }
    const o1Grows = Object.entries(opt).filter(([, r]) => r['O1@150'].ratio > 1).map(([n]) => n);
    const o3NeverGrows = Object.values(opt).every((r) => r.O3at150.ratio <= 1.0001);
    measure('O1 (production) at its default makes these larger', o1Grows.join(', '));
    probe('O3 keeps text, vectors and annotations wherever the source had them',
        Object.values(opt).every((r) => r.O3at150.text !== 'lost' && !String(r.O3at150.vectors).startsWith('lost')
            && !String(r.O3at150.annotations).startsWith('lost')),
        Object.entries(opt).map(([n, r]) => `${n}:${r.O3at150.text}/${r.O3at150.vectors}`).join(' '));
    measure('O3 never makes a document larger here', `${o3NeverGrows}`);

    // RF-K3: every use of a shared image, planned before any rewrite.
    console.log('\n  -- O3 planning across every use (RF-K3) --');
    const op3 = await call('optimizePlanning');
    evidence.sections.optimizePlanning = op3;
    for (const [n, r] of Object.entries(op3)) {
        console.log(`  ${n.padEnd(20)} uses ${r.uses.map((u) => `${u.width}x${u.height}: ${u.uses.map((x) => `p${x.page} needs ${x.needW}x${x.needH}`).join(', ') || 'none'}${u.uncertain.length ? ` — uncertain (${u.uncertain[0]})` : ''}`).join('; ')}`);
        console.log(`  ${''.padEnd(20)} all-uses ${r['all-uses'].images.join(',') || '(annotation only)'} | first-use ${r['first-use'].images.join(',') || '(annotation only)'}`);
    }
    const dims = (n, p) => op3[n][p].decisions.map((x) => (x.to ?? x.from).join('x')).join(',');
    probe('the all-uses plan is the same whichever page comes first',
        dims('shared-image-a4-a1', 'all-uses') === dims('shared-image-a1-a4', 'all-uses'),
        `A4→A1 ${dims('shared-image-a4-a1', 'all-uses')}, A1→A4 ${dims('shared-image-a1-a4', 'all-uses')}`);
    const meets = (n) => op3[n].uses.every((u) => {
        const kept = op3[n]['all-uses'].decisions[0];
        const [w, h] = kept.to ?? kept.from;
        return u.uses.every((x) => w >= Math.min(u.width, x.needW) - 1 && h >= Math.min(u.height, x.needH) - 1);
    });
    probe('and keeps enough pixels for the most demanding use — shared across pages, repeated on a page, inside a reused form',
        ['shared-image-a4-a1', 'shared-image-a1-a4', 'repeated-image', 'form-image'].every(meets),
        `repeated-image -> ${dims('repeated-image', 'all-uses')}; form-image -> ${dims('form-image', 'all-uses')}`);
    probe('an image whose use the plan cannot size is not downsampled',
        op3['annot-image']['all-uses'].decisions[0].uncertain > 0 && op3['annot-image']['all-uses'].decisions[0].to === null,
        'drawn only by an annotation appearance');
    probe('the first-encounter planner it replaces was page-order dependent and undersampled',
        dims('shared-image-a4-a1', 'first-use') !== dims('shared-image-a1-a4', 'first-use')
        && dims('form-image', 'first-use') === '1240x1754',
        `A4→A1 ${dims('shared-image-a4-a1', 'first-use')} for an A1 use needing ${op3['shared-image-a4-a1'].uses[0].uses[1].needW}px wide`);

    // RF-K3: what recompression does to one-pixel linework.
    console.log('\n  -- O3 lossy quality on a 300 dpi fine-line scan (RF-K3) --');
    const oq = await call('optimizeQuality');
    evidence.sections.optimizeQuality = oq;
    for (const [k, v] of Object.entries(oq)) {
        if (typeof v !== 'object') continue;
        measure(`fine-line scan, ${k}`, `x${v.ratio.toFixed(3)} size; line ink kept ${(v.lineInkKept * 100).toFixed(1)}%, spurious ${(v.spuriousInk * 100).toFixed(1)}%, PSNR ${v.psnr === null ? '∞' : v.psnr.toFixed(1)} dB (at 300 dpi against the source)`);
    }
    assert('the quality measure can see loss and its absence: lossless keeps every line',
        oq['O2 lossless'].lineInkKept === 1 && oq['O1 production @150'].lineInkKept < 0.5);
    measure('what destroys linework is the target resolution, not JPEG',
        `JPEG q0.8 at the scan's own 300 dpi keeps ${(oq['O3 JPEG q0.8 @300'].lineInkKept * 100).toFixed(0)}% at x${oq['O3 JPEG q0.8 @300'].ratio.toFixed(2)}; any resample to 150 dpi keeps ≈${(oq['O3 lossless resample @150'].lineInkKept * 100).toFixed(0)}–${(oq['O3 JPEG q0.8 @150'].lineInkKept * 100).toFixed(0)}%, lossless or not`);

    // ---- 6. large format -------------------------------------------------------
    console.log('\n=== 6. large format ===');
    const mem = await call('memory', [
        { op: 'optimize', fixture: 'vector-a1', dpi: 150 },
        { op: 'monochrome', fixture: 'vector-a1', dpi: 150 },
        { op: 'optimize', fixture: 'vector-a0', dpi: 150 },
        { op: 'monochrome', fixture: 'vector-a1', dpi: 300 },
    ]);
    evidence.sections.memory = mem;
    for (const r of mem.rows) {
        console.log(`  ${r.sheet} @${String(r.dpi).padStart(3)}dpi  ${r.width}x${r.height}  ${r.megapixels.toFixed(1)} Mpx  RGBA ${(r.rgba / 2 ** 20).toFixed(0)} MiB`);
    }
    for (const r of mem.measured) {
        if (r.error) { measure(`${r.op} ${r.fixture} @${r.dpi}dpi`, `threw: ${r.error}`); continue; }
        const px = r.image.width * r.image.height;
        const jpeg = r.image.encodedBytes;
        // Per page, from the code: the canvas, Monochrome's getImageData copy,
        // the JPEG the browser encodes, its base64 data URL (one byte per
        // character), and the bytes pdf-lib decodes from it and keeps.
        const peak = px * 4 * (r.op === 'monochrome' ? 2 : 1) + jpeg + Math.ceil(jpeg / 3) * 4 + 23 + jpeg;
        measure(`${r.op} ${r.fixture} @${r.dpi}dpi`,
            `${(r.ms / 1000).toFixed(1)} s; ${r.image.width}x${r.image.height} ${r.image.filter} of ${(jpeg / 1e6).toFixed(2)} MB; output ${(r.outputBytes / 1e6).toFixed(2)} MB; per-page peak from the code ≈ ${(peak / 2 ** 20).toFixed(0)} MiB`);
    }
    for (const l of mem.limits) {
        measure(`canvas ${l.sheet} @${l.dpi}dpi (${l.megapixels.toFixed(0)} Mpx)`, l.usable ? 'allocates' : `does not allocate${l.emptyDataUrl ? '; toDataURL returns "data:,"' : ''}`);
    }
    const unusable = mem.limits.filter((l) => !l.usable);
    if (unusable.length > 0) {
        const over = await call('overLimit');
        evidence.sections.overLimit = over;
        for (const [op, r] of Object.entries(over)) {
            measure(`${op} A1 @600dpi (offered by the UI)`, r.threw ? `throws: ${r.threw}` : `returns ${r.bytes} B, ink ${r.inkFraction}`);
        }
        const blank = Object.entries(over).filter(([, r]) => !r.threw && r.inkFraction < 0.001);
        const threw = Object.entries(over).filter(([, r]) => r.threw);
        if (blank.length > 0) {
            baselineFail('monochrome at 600 dpi on an A1 returns a blank document as success',
                blank.map(([op, r]) => `${op}: ${r.bytes} B, ink ${r.inkFraction}`).join('; '),
                'the canvas exceeds the browser limit and silently fails; nothing checks before rendering',
                'preflight the raster against a measured canvas limit and a memory budget; refuse by name (H8/H9)');
        } else if (threw.length > 0) {
            baselineFail('monochrome at 600 dpi on an A1 is offered, and fails only after the work has started',
                threw.map(([op, r]) => `${op}: ${r.threw}`).join('; '),
                `${unusable.map((l) => `${l.sheet}@${l.dpi}`).join(', ')} exceed the canvas the browser will allocate; there is no preflight, so the failure is an exception from the middle of a run`,
                'preflight raster size, canvas limit and memory before the first page; refuse with the numbers (H8/H9)');
        }
    }

    // ---- 6b. the Raster Budget (RF-K5) -------------------------------------------
    console.log('\n=== 6b. Raster Budget for the flattening operations (RF-K5) ===');
    const jw = await call('jpegWorstCase');
    evidence.sections.jpegWorstCase = jw;
    for (const s of jw.samples) measure(`JPEG q0.8, ${s.kind} ${s.width}x${s.height}`, `${s.bytesPerPixel.toFixed(3)} B/px`);
    probe('the planning ratio covers the worst content measured, with margin — and stays far under the format bound',
        jw.worst * 1.25 <= jw.bound + 1e-9 && jw.bound < jw.formatBound,
        `worst ${jw.worst.toFixed(3)} B/px (x1.25 = ${(jw.worst * 1.25).toFixed(3)}); planning ${jw.bound} B/px; format ${jw.formatBound} B/px — the gap is what an unowned encoder costs`);
    const rb = await call('rasterBudget');
    evidence.sections.rasterBudget = rb;
    for (const [term, basis, source] of rb.terms) console.log(`    [${basis.padEnd(26)}] ${term} — ${source}`);
    measure('the JPEG term, by basis',
        `hard (fail-closed): ${rb.model.jpeg.formatUpperBound} B/px from ITU-T T.81 entropy coding and byte stuffing; `
        + `planning (performance evidence only): ${rb.model.jpeg.measuredPerformanceBound} B/px from a measured worst case of ${rb.model.jpeg.measuredWorst} B/px; `
        + 'the encoder\'s internal working memory: unknown, and not bounded by anything here');
    for (const v of rb.validation) {
        measure(`model vs production: ${v.op} ${v.name} @${v.dpi}`, `output ${v.outputBytes.toLocaleString('en-US')} ≤ planning ${v.outputBound.toLocaleString('en-US')} ≤ hard ${v.outputHardBound.toLocaleString('en-US')}; largest JPEG ${v.jpegMax.toLocaleString('en-US')} ≤ ${v.jpegBound.toLocaleString('en-US')}; data URL exact ${v.dataUrlExact}; canvas exact ${v.canvasExact}`);
    }
    probe('the exact terms hold against production: canvases as planned and data URLs to the byte',
        rb.validation.every((v) => v.canvasExact && v.dataUrlExact !== false),
        `${rb.validation.length} runs, ${rb.validation.reduce((n, v) => n + v.pages, 0)} pages`);
    probe('and the measured outputs stay under both JPEG terms — evidence for the planning model, sanity for the hard one',
        rb.validation.every((v) => v.jpegPerPageWithinBound && v.jpegPerPageWithinHardBound && v.outputBytes <= v.outputBound),
        'measured ratios are performance evidence; only the format bound is fail-closed');
    for (const cnd of rb.candidates) measure(`MAX_RASTER_PIXELS candidate ${cnd.limitMpx.toFixed(1)} Mpx admits`, cnd.admits.join(' '));
    for (const mode of ['hard', 'planning']) {
        const m = rb[mode];
        console.log(`\n  -- ${mode} model (JPEG ${m.jpegBytesPerPixel} B/px) --`);
        console.log('  sheet op          dpi     Mpx   peak MiB  out MiB  512 MiB            1 GiB              2 GiB');
        for (const t of m.table) {
            console.log(`  ${t.sheet} ${t.op.padEnd(11)} ${String(t.dpi).padStart(3)} ${t.megapixels.toFixed(1).padStart(7)} ${t.peakMiB.toFixed(0).padStart(9)} ${t.outputMiB.toFixed(0).padStart(8)}  ${t.at512.padEnd(18)} ${t.at1G.padEnd(18)} ${t.at2G}`);
        }
        const b = m.boundaries;
        const cap = (x) => (x.largest === 0 ? 'nothing' : `${x.largest} (${x.atLargest.peakMiB.toFixed(0)} MiB)`);
        measure(`${mode} model: what 512 MiB takes`,
            `A4@300 Monochrome ${cap(b.pages300)} pages, first over ${b.pages300.firstRefused} (${b.pages300.atFirst.peakMiB.toFixed(0)} MiB, ${b.pages300.atFirst.status}); `
            + `A4@150 Monochrome ${cap(b.pages150)} pages; `
            + `A4@150 Optimize batch ${cap(b.files)} files; A1@300 Monochrome ${b.a1mono300.at512.status} (${b.a1mono300.at512.peakMiB.toFixed(0)} MiB), at 1 GiB ${b.a1mono300.at1G.status}`);
    }
    // The raster ceiling is pixels only: the same in both models, and the one
    // thing here that does not depend on the encoder at all.
    const hard = rb.hard.boundaries;
    const planning = rb.planning.boundaries;
    probe('the raster ceiling is independent of the JPEG term: the same boundary in both models, to the point',
        hard.raster.largest.status === 'READY' && hard.raster.firstRefused.status === 'OVER_RASTER_LIMIT'
        && hard.raster.firstRefusedWidthPt === hard.raster.largestWidthPt + 1
        && planning.raster.largestWidthPt === hard.raster.largestWidthPt,
        `${(hard.raster.pixelsLargest / 1e6).toFixed(2)} Mpx accepted, ${(hard.raster.pixelsFirst / 1e6).toFixed(2)} Mpx refused (memory unbounded, to isolate it)`);
    for (const [mode, b] of [['hard', hard], ['planning', planning]]) {
        probe(`${mode} model: pages just under and first over, refused by name`,
            b.pages150.firstRefused === b.pages150.largest + 1 && b.pages150.atFirst.status !== 'READY'
            && (b.pages150.largest === 0 || b.pages150.atLargest.status === 'READY'),
            `A4@150 Monochrome: ${b.pages150.largest} accepted, ${b.pages150.firstRefused} ${b.pages150.atFirst.status}`);
        probe(`${mode} model: a batch just under and first over, and the explicit presets`,
            b.files.firstRefused === b.files.largest + 1 && b.files.atFirst.status !== 'READY'
            && (b.files.firstAt1G.status === 'READY' || b.files.firstAt2G.status === 'READY' || b.files.atFirst.status === 'OVER_OUTPUT_BUDGET'),
            `${b.files.largest} files accepted, ${b.files.firstRefused} ${b.files.atFirst.status}; at 1 GiB ${b.files.firstAt1G.status}, at 2 GiB ${b.files.firstAt2G.status}`);
        probe(`${mode} model: a larger memory budget buys past neither the raster ceiling nor the output ceiling`,
            b.independence.rasterAt2G.status === 'OVER_RASTER_LIMIT'
            && b.independence.rasterAtUnbounded.status === 'OVER_RASTER_LIMIT'
            && b.independence.outputAt2G.status === 'OVER_OUTPUT_BUDGET',
            `A1@600 at 2 GiB: ${b.independence.rasterAt2G.reason}; output at 2 GiB: ${b.independence.outputAt2G.reason}`);
    }
    measure('what the fail-closed model costs',
        `under the format bound the flattening operations take ${rb.hard.boundaries.pages300.largest} A4 pages at 300 dpi and `
        + `${rb.hard.boundaries.pages150.largest} at 150 dpi within 512 MiB, against ${rb.planning.boundaries.pages300.largest} and `
        + `${rb.planning.boundaries.pages150.largest} under the planning estimate — the gap is the encoder nobody here owns`);
    log('BASELINE-FAIL', 'H8 cannot be adopted as a hard memory guarantee in this round', false,
        'the browser JPEG encoder is not owned: neither its encoded size nor its internal working memory is bounded by any implementation this research controls',
        {
            rootCause: 'production encodes with canvas.toDataURL(image/jpeg, 0.8); measured compression ratios are performance evidence, and a finite fixture sweep cannot bound an encoder',
            architecture: 'H8 is BLOCKED pending a Raster Encoder / Memory Sub-Spike (an owned encoder — the repository already owns an exact-size PNG encoder from M4 — or a bounded encoding path). H9 (raster pixels + runtime canvas probe) is unaffected and can be adopted now; MAX_OUTPUT_BYTES can be enforced on the finished artifact, which is measured rather than predicted',
        });

    // ---- 7. failure and atomicity (functions) ---------------------------------
    console.log('\n=== 7. failure ===');
    const failures = await call('failures');
    evidence.sections.failures = failures;
    for (const [op, r] of Object.entries(failures.invalid)) measure(`${op} on a non-PDF`, r.threw ? `throws (${r.threw}), 0 bytes` : `returns ${r.bytes} B`);
    for (const [op, r] of Object.entries(failures.midDocument)) measure(`${op} failing on page 2 of 3`, r.threw ? `throws (${r.threw}), 0 bytes` : `returns ${r.bytes} B, ${r.pages} pages`);
    assert('a per-file function never returns a partial document',
        Object.values(failures.midDocument).every((r) => r.bytes === 0) && Object.values(failures.invalid).every((r) => r.bytes === 0),
        'every failure is an exception with no bytes: atomic per file, by construction');

    // ---- 8. FileResult / BatchResult, B1 / B2 / B3 (RF-K2) ------------------------
    console.log('\n=== 8. FileResult, BatchResult and the three batch policies (RF-K2) ===');
    const bp = await call('batchPolicies');
    evidence.sections.batchPolicies = bp;
    for (const [k, def] of Object.entries(bp.definitions)) {
        console.log(`  ${k} ${def.name}: ownership ${def.ownership}; publication ${def.publication}; download ${def.downloadTiming}; cancellation ${def.cancellation}; failure ${def.failurePropagation}; manifest ${def.manifest}; early publish ${def.earlyPublish}`);
    }
    const FILE = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
    const BATCH = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'];
    const rec = (o) => o.records.map((r) => `${r.name}:${r.plan ?? '-'}/${r.result}`).join(' ');
    for (const k of ['B1', 'B2', 'B3', 'B3fileCancel', 'B1superseded', 'B2superseded', 'B3superseded']) {
        measure(`${k}`, `${bp[k].result}; ${bp[k].published} publish(es) ${JSON.stringify(bp[k].units.map((u) => (u.kind === 'archive' ? `archive[${u.files.join(',')}]` : u.name)))}; ${rec(bp[k])}`);
    }
    const all = ['B1', 'B2', 'B3', 'B3fileCancel', 'B1superseded', 'B2superseded', 'B3superseded'].map((k) => bp[k]);
    assert('every result is in its own vocabulary: FileResult per file, BatchResult per batch',
        all.every((o) => BATCH.includes(o.result) && o.records.every((r) => FILE.includes(r.result))));
    probe('B1: the first failure stops the batch, later files are not run, nothing is published',
        bp.B1.result === 'FAILED' && bp.B1.published === 0 && bp.B1.started.length === 2
        && bp.B1.records.slice(2).every((r) => r.result === 'CANCELLED'),
        `started ${bp.B1.started.join(', ')}`);
    probe('B2: one archive after the last file, the successes and a manifest naming every failure and why',
        bp.B2.result === 'PARTIAL' && bp.B2.published === 1 && bp.B2.units[0].kind === 'archive'
        && bp.B2.units[0].files.length === 2 && bp.B2.manifest.files.some((f) => f.plan === 'SIGNATURE_UNSAFE')
        && bp.B2.manifest.files.some((f) => f.plan === 'UNSUPPORTED_DOCUMENT'),
        JSON.stringify(bp.B2.manifest.files.map((f) => `${f.name}:${f.result}${f.plan !== 'READY' ? `(${f.plan})` : ''}`)));
    probe('B3: one download per success, each before the next file starts — independent, not an archive',
        bp.conformance.real.conforms && bp.B3.published === 2 && bp.B3.units.every((u) => u.kind === 'file'),
        `${bp.B3.units.map((u) => u.name).join(', ')}`);
    probe('B3: a file cancelled by its own owner cancels only itself',
        bp.B3fileCancel.records.map((r) => r.result).join(',') === 'SUCCEEDED,CANCELLED,SUCCEEDED' && bp.B3fileCancel.published === 2
        && bp.B3fileCancel.result === 'PARTIAL');
    probe('an aggregate single publish cannot pass for B3',
        bp.conformance.fake.conforms === false, bp.conformance.fake.problems.join('; '));
    probe('a superseded batch: B1 and B2 publish nothing; B3 has published only what finished before it',
        bp.B1superseded.published === 0 && bp.B2superseded.published === 0
        && bp.B3superseded.published === 1 && bp.B3superseded.units[0].name === 'batch-ok.pdf'
        && [bp.B1superseded, bp.B2superseded, bp.B3superseded].every((o) => o.result === 'CANCELLED'),
        `B3 kept ${bp.B3superseded.units.map((u) => u.name).join(', ')}; ${rec(bp.B3superseded)}`);

    // The planner's table of what each operation does to XFA and forms is a
    // claim; here it is held against what was measured.
    {
        const measuredXfa = {
            layer: row('layer', 'xfa-a4').xfa, 'monochrome-A': row('monochrome', 'xfa-a4').xfa,
            both: row('both', 'xfa-a4').xfa, 'margin-embed': row('margin', 'xfa-a4').xfa,
            'optimize-O1': row('optimize', 'xfa-a4').xfa, 'margin-inplace': margin['xfa-a4']['inplace:center'].xfa,
            'normalize-size': hardened.find((r) => r.lane === 'normalize-size' && r.fixture === 'xfa-a4').xfa,
            'title-block-update': hardened.find((r) => r.lane === 'title-block-update' && r.fixture === 'xfa-a4').xfa,
        };
        const measuredForm = {
            layer: row('layer', 'form-a4').form, 'monochrome-A': row('monochrome', 'form-a4').form,
            both: row('both', 'form-a4').form, 'margin-embed': row('margin', 'form-a4').form,
            'optimize-O1': row('optimize', 'form-a4').form, 'margin-inplace': margin['form-a4']['inplace:center'].form,
            'monochrome-C': mono['form-a4'].C.form,
        };
        const effects = sf.effects;
        const xfaAgree = Object.entries(measuredXfa).every(([op, v]) => effects[op].keepsXfa === (v === 'retained'));
        const formAgree = Object.entries(measuredForm).every(([op, v]) => effects[op].keepsForm === (v === 'retained with value'));
        assert('the planner\'s operation-effects table matches what was measured for XFA and forms',
            xfaAgree && formAgree,
            Object.entries(measuredXfa).map(([op, v]) => `${op}:${v}`).join(' '));
    }

    // ---- 9. the real UI: batches and lifecycle ----------------------------------
    console.log('\n=== 9. the Processor UI: batches ===');
    const finished = () => fs.readdirSync(DOWNLOADS).filter((f) => !f.endsWith('.crdownload'));
    const clear = () => { for (const f of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, f), { force: true }); };
    async function download(ms = 60000) {
        const until = Date.now() + ms;
        for (;;) {
            const [name] = finished();
            if (name) {
                const size = fs.statSync(path.join(DOWNLOADS, name)).size;
                await wait(200);
                if (fs.statSync(path.join(DOWNLOADS, name)).size === size) return name;
            }
            if (Date.now() > until) return null;
            await wait(150);
        }
    }
    async function openProcessor() {
        const page = await newPage();
        await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
        await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'PDF加工')?.click());
        await page.waitForSelector('#file-input');
        return page;
    }
    const tool = (page, label) => page.evaluate((l) => [...document.querySelectorAll('.tool-btn')]
        .find((b) => b.textContent?.includes(l))?.click(), label);
    const upload = async (page, list) => (await page.$('#file-input')).uploadFile(...list.map((n) => path.join(FIXTURES, `${n}.pdf`)));
    const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.file-row')].map((r) => ({
        name: r.querySelector('.file-name')?.textContent, status: r.querySelector('.file-status')?.textContent,
        error: r.querySelector('.file-error')?.textContent ?? null,
    })));
    const runIt = (page) => page.click('[data-usage-target="processor-run"]');
    async function idle(page, ms = 180000) {
        const until = Date.now() + ms;
        for (;;) {
            const busy = await page.evaluate(() => document.querySelector('[data-usage-target="processor-run"]')?.textContent?.includes('処理中'));
            if (!busy) return true;
            if (Date.now() > until) return false;
            await wait(100);
        }
    }
    async function zipEntries(name) {
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(DOWNLOADS, name)));
        return Object.keys(zip.files);
    }

    const batchCases = [
        ['middle failure', ['batch-ok', 'invalid', 'text-a4']],
        ['first failure', ['invalid', 'batch-ok', 'text-a4']],
        ['last failure', ['batch-ok', 'text-a4', 'invalid']],
        ['all invalid', ['invalid', 'invalid']],
        ['single invalid', ['invalid']],
        ['single valid', ['batch-ok']],
        ['all valid', ['batch-ok', 'text-a4']],
    ];
    const batch = {};
    for (const [label, list] of batchCases) {
        clear();
        const page = await openProcessor();
        await tool(page, '半透明レイヤ追加');
        await upload(page, list);
        await runIt(page);
        await idle(page);
        const file = await download(list.every((n) => n === 'invalid') ? 5000 : 30000);
        const entries = file?.endsWith('.zip') ? await zipEntries(file) : null;
        batch[label] = { rows: await rowsOf(page), download: file, entries };
        await page.close();
        measure(`batch ${label}`, `rows ${batch[label].rows.map((r) => r.status).join(',')}; download ${file ?? 'none'}${entries ? ` [${entries.join(', ')}]` : ''}`);
    }
    evidence.sections.batch = batch;
    const partial = ['middle failure', 'first failure', 'last failure']
        .filter((k) => batch[k].download === 'processed_files.zip' && batch[k].entries?.length === 2);
    measure('a batch with a failed file still downloads processed_files.zip of the rest',
        `${partial.length}/3 positions; the archive carries no record of the failure: ${partial.map((k) => batch[k].entries.join('+')).join(' | ')}`);
    probe('a single unreadable file downloads nothing', batch['single invalid'].download === null && batch['single invalid'].rows[0].status === 'error');
    assert('the rows say which file failed', ['middle failure', 'first failure', 'last failure']
        .every((k) => batch[k].rows.filter((r) => r.status === 'error').length === 1));

    console.log('\n=== 9b. the Processor UI: a run the user has moved on from ===');
    // (a) navigate away mid-run
    clear();
    let page = await openProcessor();
    await tool(page, 'モノクロ化');
    await upload(page, ['long-8', 'batch-ok']);
    await runIt(page);
    await page.waitForFunction(() => document.querySelector('.file-status')?.textContent === 'processing');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'PDF比較')?.click());
    const unmounted = await page.evaluate(() => document.querySelector('#file-input') === null);
    const stale = await download(60000);
    measure('navigating away while a batch runs', `processor unmounted: ${unmounted}; download afterwards: ${stale ?? 'none'}`);
    if (unmounted && stale) {
        baselineFail('a batch the user navigated away from still downloads',
            `${stale} arrived after the Processor had unmounted`,
            'startProcessing has no generation or ownership check; the loop and saveAs run to completion regardless of the component',
            'the F1-B/M4 owner token: captured at start, re-read at every file boundary and immediately before publish; unmount supersedes (prototype/job.mjs, H10)');
    }
    await page.close();

    // (b) settings changed mid-run
    clear();
    page = await openProcessor();
    await tool(page, 'モノクロ化');
    await upload(page, ['long-8', 'batch-ok']);
    await runIt(page);
    await page.waitForFunction(() => document.querySelector('.file-status')?.textContent === 'processing');
    const selectEnabled = await page.evaluate(() => {
        const s = [...document.querySelectorAll('.tools-settings select')][0];
        return s ? !s.disabled : null;
    });
    await page.select('.tools-settings select', '150');
    // (c) a file added mid-run
    await upload(page, ['text-a4']);
    const removeDisabled = await page.evaluate(() => [...document.querySelectorAll('.remove-btn')].every((b) => b.disabled));
    const toolsDisabled = await page.evaluate(() => [...document.querySelectorAll('.tool-btn')].every((b) => b.disabled));
    await idle(page);
    const settledRows = await rowsOf(page);
    const shownDpi = await page.evaluate(() => document.querySelector('.tools-settings select')?.value);
    const zipName = await download(60000);
    let usedWidth = null;
    if (zipName?.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(fs.readFileSync(path.join(DOWNLOADS, zipName)));
        const first = Object.keys(zip.files).find((n) => n.startsWith('batch-ok'));
        const bytes = await zip.files[first].async('uint8array');
        usedWidth = await h.evaluate(async (arr) => {
            const { inspect } = await import('/research/m5-processor-reliability/prototype/inspect.mjs');
            const r = await inspect(new Uint8Array(arr), { render: false });
            return r.pages[0].images[0]?.width ?? null;
        }, Array.from(bytes));
    }
    evidence.sections.lifecycle = {
        unmounted, staleDownload: stale, selectEnabled, removeDisabled, toolsDisabled,
        settledRows, shownDpi, usedWidth, zip: zipName,
    };
    measure('during a run', `settings enabled: ${selectEnabled}; remove buttons disabled: ${removeDisabled}; tool buttons disabled: ${toolsDisabled}`);
    measure('a file added during a run', `rows afterwards: ${settledRows.map((r) => `${r.name}:${r.status}`).join(', ')}`);
    if (selectEnabled && shownDpi === '150' && Number(usedWidth) > 2000) {
        baselineFail('a setting changed during a run is neither applied nor locked',
            `the panel shows ${shownDpi} dpi; the file written at the end is ${usedWidth} px wide, i.e. 300 dpi, and its row says done`,
            'startProcessing closes over the settings of the render it started in; the controls stay live and nothing ties the result to the settings it used',
            'a settings change supersedes the run (no stale artifact), or settings lock for its duration; the result names the settings it used (H10)');
    }
    await page.close();

    // ---- 10. existing gates for the hardened lanes ------------------------------
    console.log('\n=== 10. hardened-lane gates (run separately; see measurements.md) ===');
    measure('smoke-page-size-normalizer / smoke-production-size-normalizer / smoke-title-block-updater / smoke-titleblock-ui',
        'not re-implemented here; run unchanged alongside this gate');

    // ---- 11. network, errors ----------------------------------------------------
    console.log('\n=== 11. local only ===');
    probe('no external HTTP(S) request during any measurement', external.length === 0,
        external.length === 0 ? '0 requests' : [...new Set(external)].join(' '));
    assert('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    const expectedLogs = consoleErrors.filter((e) => e.startsWith('Processing failed')).length;
    measure('console errors', `${consoleErrors.length}: ${expectedLogs} are PdfTools logging the deliberately invalid inputs; failed responses: ${failedResponses.length ? [...new Set(failedResponses)].join(', ') : 'none'}`,
        [...new Set(consoleErrors)]);

    // ---- 12. what only a person can decide ----------------------------------------
    console.log('\n=== 12. Human Product Gate ===');
    const decisions = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'human-gate.json'), 'utf8'));
    for (const d of decisions) human(d.id, d.question, d.recommendation);

    const count = (kind, ok) => lines.filter((l) => l.kind === kind && (ok === undefined || l.ok === ok)).length;
    const summary = {
        assertions: count('ASSERT'), assertionsFailed: count('ASSERT', false),
        probes: count('PROBE'), probesFailed: count('PROBE', false),
        measurements: count('MEASURE'), baselineFails: count('BASELINE-FAIL'), humanOpen: count('HUMAN-OPEN'),
        external: external.length, pageErrors: pageErrors.length,
    };
    evidence.summary = summary;
    evidence.lines = lines;
    // Everything, for whoever wants to dig, where git will not see it...
    fs.writeFileSync(path.join(ROOT, 'test-fixtures', 'm5-processor-evidence-full.json'), `${JSON.stringify(evidence)}\n`);
    // ...and what the research rests on, small enough to review.
    const keep = ['nativeText', 'ocrText', 'vectors', 'raster', 'fullPageRaster', 'annotations', 'links', 'form',
        'signature', 'xfa', 'pageOrder', 'overlayCoverage', 'hiddenContentRevealed', 'error'];
    const slim = {
        ...evidence,
        sections: {
            ...evidence.sections,
            corpus: Object.fromEntries(Object.entries(evidence.sections.corpus).map(([k, v]) => [k, {
                bytes: v.bytes, pages: v.pages, box: v.boxes[0], ops: v.ops[0], annots: v.annots,
                acroForm: v.acroForm, xfa: v.xfa, signature: v.signatures[0]?.state ?? null,
            }])),
            baseline: evidence.sections.baseline.map((r) => ({
                op: r.op, fixture: r.fixture, dpi: r.dpi,
                ...Object.fromEntries(keep.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])),
                metadata: r.metadata, box: r.boxes?.[0], size: r.size,
            })),
            margin: Object.fromEntries(Object.entries(evidence.sections.margin).map(([k, v]) => [k,
                Object.fromEntries(Object.entries(v).map(([m, x]) => [m, {
                    status: x.status, refusals: x.refusals, nativeText: x.nativeText, ocrText: x.ocrText,
                    annotations: x.annotations, links: x.links, form: x.form, xfa: x.xfa,
                    rotate: x.boxes ? `${x.boxes.rotateBefore}->${x.boxes.rotateAfter}` : undefined,
                    crop: x.boxes ? { before: x.boxes.cropBefore, after: x.boxes.cropAfter } : undefined,
                    againstExpected: x.againstExpected, hiddenMagenta: x.hiddenMagenta,
                }]))])),
        },
    };
    // Structure down to the rows, one row per line: diffable, and readable.
    const pretty = (value, depth = 0) => {
        const pad = '  '.repeat(depth + 1);
        if (depth >= 2 || value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[\n${value.map((v) => pad + pretty(v, depth + 1)).join(',\n')}\n${'  '.repeat(depth)}]`;
        return `{\n${Object.entries(value).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pretty(v, depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}}`;
    };
    fs.writeFileSync(path.join(RESEARCH, 'evidence.json'), `${pretty(slim)}\n`);
    console.log(`\n  ASSERT ${summary.assertions - summary.assertionsFailed}/${summary.assertions}  PROBE ${summary.probes - summary.probesFailed}/${summary.probes}  MEASURE ${summary.measurements}  BASELINE-FAIL ${summary.baselineFails}  HUMAN-OPEN ${summary.humanOpen}`);
    if (summary.assertionsFailed === 0 && summary.probesFailed === 0) {
        console.log('\nThe apparatus holds. The baseline findings above describe main; the decisions above are open.\n');
        exitCode = 0;
    } else {
        console.error('\nThe apparatus failed: the evidence above cannot be relied on.\n');
    }
} catch (error) {
    console.error(`\nResearch gate failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
