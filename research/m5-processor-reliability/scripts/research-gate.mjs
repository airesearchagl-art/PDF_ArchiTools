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

const evidence = { ranAt: new Date().toISOString(), main: null, sections: {} };
try {
    evidence.main = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
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
                'PLAN=SIGNATURE_UNSAFE via the existing assessSource before any byte is produced (H7)');
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
            'a common PLAN step running assessSource *before* the lane — adds a refusal, removes nothing the lanes guarantee (not a redesign of either lane)');
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

    // ---- 7. failure and atomicity (functions) ---------------------------------
    console.log('\n=== 7. failure ===');
    const failures = await call('failures');
    evidence.sections.failures = failures;
    for (const [op, r] of Object.entries(failures.invalid)) measure(`${op} on a non-PDF`, r.threw ? `throws (${r.threw}), 0 bytes` : `returns ${r.bytes} B`);
    for (const [op, r] of Object.entries(failures.midDocument)) measure(`${op} failing on page 2 of 3`, r.threw ? `throws (${r.threw}), 0 bytes` : `returns ${r.bytes} B, ${r.pages} pages`);
    assert('a per-file function never returns a partial document',
        Object.values(failures.midDocument).every((r) => r.bytes === 0) && Object.values(failures.invalid).every((r) => r.bytes === 0),
        'every failure is an exception with no bytes: atomic per file, by construction');

    // ---- 8. the job prototype --------------------------------------------------
    console.log('\n=== 8. PLAN/RESULT + ownership prototype ===');
    const job = await call('jobPrototype');
    evidence.sections.job = job;
    for (const k of ['B1', 'B2', 'B3']) {
        measure(`${k} on [ok, invalid, text, signed]`, `${job[k].result}; artifacts ${job[k].artifacts.join(', ') || 'none'}; published ${JSON.stringify(job[k].published)}; ${job[k].results.map((r) => `${r.name}:${r.plan}/${r.result}`).join(' ')}`);
    }
    probe('B1: one failure and nothing is published', job.B1.result === 'FAILED' && job.B1.published.length === 0);
    probe('B2: the partial archive names every failure and why',
        job.B2.result === 'PARTIAL' && job.B2.manifest.failed === 2 && job.B2.manifest.failures.some((f) => f.plan === 'SIGNATURE_UNSAFE'),
        JSON.stringify(job.B2.manifest.failures.map((f) => `${f.name}:${f.plan}`)));
    probe('a superseded batch publishes nothing', job.superseded.result === 'CANCELLED' && job.superseded.published.length === 0,
        job.superseded.results.map((r) => `${r.name}:${r.result}`).join(' '));
    assert('while the same batch, not superseded, publishes once', job.control.published.length === 1);

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
