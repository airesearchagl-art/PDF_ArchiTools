/**
 * Deterministic smoke verification for the annotator's vector-preserving save.
 *
 * Drives the **production module** (`src/utils/annotator-save/`) in a real
 * browser against synthetic fixtures. Small on purpose: this is a gate, not a
 * test framework. It exits non-zero if any check fails.
 *
 * Much of it is negative probes, and one is unusual: the save is asserted to
 * *refuse* several inputs and to produce **no bytes** when it does. A gate in
 * which everything passes proves nothing about a design whose whole claim is
 * that it fails closed.
 *
 * Run:  node scripts/make-annotator-save-fixtures.mjs
 *       node scripts/smoke-annotator-vector-save.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'annotator-save', 'rich.pdf'))) {
    console.error('Fixtures missing. Run: node scripts/make-annotator-save-fixtures.mjs');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so it can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

const server = await createServer({
    root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn',
});
await server.listen();

const browser = await puppeteer.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative, data:, blob: */ }
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
    await page.goto(`${ORIGIN}/scripts/smoke-annotator-vector-save-harness.html`,
        { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m3ready === true, { timeout: 180000 });

    // ---- what the source still carries -----------------------------------
    console.log('\n=== the source survives the save ===');
    const pres = await page.evaluate(() => window.__m3save.sourcePreservation());
    if (pres.failed) throw new Error(`source preservation refused: ${pres.failed.message}`);
    const b = pres.before;
    const a = pres.after;

    // The corpus has to carry these in the first place, or "preserved" is
    // a statement about an empty document.
    check('the source carried searchable text to begin with',
        b.pages[0].text.includes('SEARCHABLE-SOURCE-TEXT'));
    check('and vector geometry', b.pages[0].paths > 0, `${b.pages[0].paths} path operators`);
    check('and an image', b.pages[0].images > 0, `${b.pages[0].images}`);
    check('and an existing annotation', b.pages[0].annotations > 0, `${b.pages[0].annotations}`);
    check('and form fields with values',
        Object.keys(b.formFields).length >= 2,
        JSON.stringify(b.formFields));
    check('and an invisible OCR text layer',
        b.pages[0].text.includes('INVISIBLE-OCR-LAYER'));

    check('searchable source text survives', a.pages[0].text.includes('SEARCHABLE-SOURCE-TEXT'));
    check('the invisible OCR layer survives', a.pages[0].text.includes('INVISIBLE-OCR-LAYER'));
    check('vector geometry survives, and grows by the annotations',
        a.pages[0].paths >= b.pages[0].paths,
        `${b.pages[0].paths} -> ${a.pages[0].paths}`);
    check('the source image survives',
        a.pages[0].images >= b.pages[0].images, `${b.pages[0].images} -> ${a.pages[0].images}`);
    check('the existing annotation survives',
        a.pages[0].annotations >= b.pages[0].annotations,
        `${b.pages[0].annotations} -> ${a.pages[0].annotations}`);
    check('form fields and their values survive',
        JSON.stringify(a.formFields) === JSON.stringify(b.formFields),
        JSON.stringify(a.formFields));
    check('metadata survives', a.title === b.title && a.author === b.author,
        `${JSON.stringify(a.title)} / ${JSON.stringify(a.author)}`);
    check('page count and order are unchanged',
        a.pageCount === b.pageCount, `${b.pageCount} -> ${a.pageCount}`);
    check('rotation is unchanged',
        a.pages[0].rotate === b.pages[0].rotate, `${b.pages[0].rotate}`);
    check('the page box is unchanged',
        JSON.stringify(a.pages[0].view) === JSON.stringify(b.pages[0].view),
        JSON.stringify(a.pages[0].view));
    // The claim this whole feature turns on: the page is not a picture.
    probe('the page was not replaced by one image',
        a.pages[0].images === b.pages[0].images && a.pages[0].paths > 5,
        `${a.pages[0].images} images, ${a.pages[0].paths} path operators`);
    console.log(`  report: ${JSON.stringify(pres.report)}`);

    // ---- a save with nothing to add --------------------------------------
    console.log('\n=== a save with nothing to add ===');
    const noop = await page.evaluate(() => window.__m3save.noop());
    check('a no-op save returns the source unchanged, byte for byte',
        noop.byteIdentical === true && noop.unchangedCopy === true,
        `${noop.sourceBytes} -> ${noop.outputBytes} bytes`);

    // ---- layers -----------------------------------------------------------
    console.log('\n=== layers ===');
    const layers = await page.evaluate(() => window.__m3save.visibleLayers());
    check('marks on visible layers are saved', layers.A === true && layers.B === true);
    probe('a mark on a hidden layer is not', layers.C === false,
        'the hidden layer is never handed to the save');

    const eraserTest = await page.evaluate(() => window.__m3save.layerLocalEraser());
    if (eraserTest.failed) throw new Error(`layer eraser refused: ${eraserTest.failed.message}`);
    const inside = eraserTest.insideEraser;
    const outside = eraserTest.outsideEraser;
    check('outside the eraser, the upper layer covers the lower one',
        outside.green > 100 && outside.red < 20,
        `green ${outside.green}, red ${outside.red}`);
    check("a pixel eraser clears its own layer's ink",
        inside.green < 20, `green inside the erased window: ${inside.green}`);
    // The one a flattened implementation fails: it would erase both and leave
    // white where the lower layer's mark should be showing through.
    probe('and the layer beneath shows through rather than being erased too',
        inside.red > 100 && inside.white < inside.red,
        `red ${inside.red}, white ${inside.white} inside the erased window`);

    // ---- painter order ----------------------------------------------------
    console.log('\n=== stacking order ===');
    const order = await page.evaluate(() => window.__m3save.painterOrder());
    check('every ordering scenario was measured', Object.keys(order).length === 9,
        `${Object.keys(order).length} scenarios`);
    for (const [label, r] of Object.entries(order)) {
        check(`${label}`, r.produced > 0,
            r.refused ?? `${r.produced}B, ${r.fragments} fragment(s), `
                + `${(r.maxRasterPixels / 1e6).toFixed(2)} Mpx`);
    }
    check('a layer with no eraser stays entirely vector',
        order['overlapping annotations, no eraser'].fragments === 0);

    // ---- where a mark lands ----------------------------------------------
    for (const fixture of ['rotated', 'croprot']) {
        console.log(`\n=== a mark ends up where it was put: ${fixture} ===`);
        const placed = await page.evaluate((f) => window.__m3save.placement(f), fixture);
        for (const p of placed) {
            const errs = Object.entries(p.quadrants).map(([k, v]) => (
                v.missing ? `${k}:MISSING` : `${k}:${v.errorPt.toFixed(1)}pt`
            ));
            const worst = Math.max(...Object.values(p.quadrants)
                .map((v) => (v.missing ? Infinity : v.errorPt)));
            check(`${fixture} p${p.page} (/Rotate ${p.rotate}): every quadrant within 2pt`,
                worst <= 2, errs.join(' '));
        }
    }

    // ---- which way up the text reads --------------------------------------
    for (const fx of ['rotated', 'croprot']) {
        console.log(`\n=== text and labels read the right way up: ${fx} ===`);
        const rows = await page.evaluate((f2) => window.__m3save.textOrientation(f2), fx);
        for (const r of rows) {
            check(`${fx} p${r.page} (/Rotate ${r.rotate}): the text annotation is extractable`,
                r.text.extractable === true,
                r.text.missing ? `saw: ${(r.text.sawInstead ?? []).join(' | ')}` : r.text.x !== undefined
                    ? `at (${r.text.x.toFixed(0)}, ${r.text.y.toFixed(0)})` : '');
            // The one a stroke-only probe cannot see.
            probe(`${fx} p${r.page} (/Rotate ${r.rotate}): its baseline is horizontal on screen`,
                r.text.angle === 0, `${r.text.angle}deg`);
            // The stored y is the *top* of the glyph box and pdf.js reports the
            // baseline, so the two differ by the ascent by design. Asserting
            // that gap is the assertion: it is what keeps text from sitting a
            // line high, and it must hold identically at every rotation.
            const dropped = r.text.y - r.text.expected.y;
            check(`${fx} p${r.page}: and it is where it was put, one ascent below the top`,
                Math.abs(r.text.x - r.text.expected.x) <= 2
                && dropped > 12 && dropped < 21,
                `x ${r.text.x.toFixed(1)} vs ${r.text.expected.x}, `
                + `baseline ${dropped.toFixed(1)}pt below the stored top (16pt text)`);
            probe(`${fx} p${r.page} (/Rotate ${r.rotate}): the measurement label too`,
                r.label.angle === 0, r.label.missing ? 'LABEL MISSING' : `${r.label.angle}deg  ${r.label.str}`);
        }
    }

    for (const fx of ['rotated', 'croprot']) {
        console.log(`\n=== a non-square raster fragment, rotated: ${fx} ===`);
        const rows = await page.evaluate((f2) => window.__m3save.fragmentOrientation(f2), fx);
        for (const r of rows) {
            check(`${fx} p${r.page} (/Rotate ${r.rotate}): the fragment was written`,
                r.fragments === 1 && r.found !== null,
                r.found ? `${r.found.pixels} ink pixels` : 'NOT FOUND');
            probe(`${fx} p${r.page}: and it landed where the marks were drawn`,
                r.errorPt !== null && r.errorPt <= 12,
                r.errorPt === null ? 'MISSING' : `${r.errorPt.toFixed(1)}pt from the expected centroid`);
        }
    }

    // ---- assessing must not change the document ---------------------------
    console.log('\n=== inspecting a document does not modify it ===');
    const side = await page.evaluate(() => window.__m3save.formSideEffects());
    const nf = side['no-form'];
    check('the no-form fixture really has no AcroForm', nf.acroFormBefore === false);
    check('and it saves normally', nf.saved > 0, `${nf.saved} bytes`);
    // pdf-lib's getForm() creates one; this asserts the dictionary itself is
    // still absent, not merely that it holds no fields.
    probe('the saved file still has no AcroForm dictionary',
        nf.acroFormAfter === false,
        nf.acroFormAfter === false ? 'absent, as it was' : 'AN ACROFORM WAS CREATED');
    check('and the input bytes were untouched', nf.inputUnchanged === true);

    const xf = side.xfa;
    check('the XFA fixture really carries XFA', xf.xfaBefore === true);
    probe('an XFA document is refused, distinctly',
        xf.supported === false && xf.code === 'xfa-unsupported',
        xf.code ?? 'no code');
    probe('and the save produces no bytes',
        typeof xf.refused === 'string' && xf.saved === undefined,
        xf.refused?.slice(0, 60) ?? `IT PRODUCED ${xf.saved} BYTES`);
    check('the refusal explains itself without a raw exception',
        (xf.message ?? '').includes('XFA') && (xf.message ?? '').includes('保存できません'),
        (xf.message ?? '').slice(0, 50));
    // The failure this replaces: getForm() strips XFA and carries on.
    probe('the XFA is still in the source afterwards',
        xf.xfaStillInInput === true,
        xf.xfaStillInInput ? 'intact' : 'THE XFA WAS DELETED');
    check('and the input bytes were untouched', xf.inputUnchanged === true);

    check('an ordinary form is still accepted, values and all',
        side['ordinary-form'].saved > 0
        && side['ordinary-form'].fields['drawing.number'] === 'A-101',
        JSON.stringify(side['ordinary-form'].fields));

    // ---- annotation text --------------------------------------------------
    console.log('\n=== added text is searchable ===');
    const searchable = await page.evaluate(() => window.__m3save.searchableText());
    check('ASCII annotation text is extractable', searchable.ascii === true);
    check('Japanese annotation text is extractable', searchable.japanese === true);
    check('a measurement label is extractable too', searchable.measureLabel === true);
    check('and the source text is still extractable alongside it',
        searchable.sourceTextStillThere === true);
    check('the substitution is reported rather than hidden',
        searchable.fontSubstituted === true,
        'the chosen CSS family cannot be embedded, and that is said so');

    console.log('\n=== a character the font cannot draw ===');
    const glyph = await page.evaluate(() => window.__m3save.glyphFallback());
    check('the text object with missing glyphs is rastered',
        glyph.rastered.length === 1 && glyph.rastered[0].objectId === 't-emoji',
        `missing: ${glyph.rastered[0]?.missing.join(' ')}`);
    probe('and is therefore not extractable, which is reported',
        glyph.emojiTextExtractable === false);
    check('while the ordinary text object stays vector and searchable',
        glyph.plainTextExtractable === true);
    check('the mark still appears on the page', glyph.inkPixels > 200,
        `${glyph.inkPixels} ink pixels`);

    // ---- the raster ceiling ----------------------------------------------
    console.log('\n=== how large a raster fragment may be ===');
    const ceiling = await page.evaluate(() => window.__m3save.rasterCeiling());
    check('the ceiling is a stated number', ceiling.limit === 8_000_000,
        `${(ceiling.limit / 1e6).toFixed(1)} Mpx`);
    check('MAX - 1 is accepted', ceiling.maxMinusOne === 'accepted');
    check('MAX exactly is accepted', ceiling.maxExactly === 'accepted', 'the bound is inclusive');
    probe('MAX + 1 is refused', ceiling.maxPlusOne.startsWith('refused'),
        ceiling.maxPlusOne.slice(0, 44));
    probe('and the check fires either side of the line',
        ceiling.justUnder === 'accepted' && ceiling.justOver.startsWith('refused'));
    check('a fragment that fits is written on the largest sheet',
        ceiling.smallFragment.produced > 0,
        `${(ceiling.smallFragment.maxRasterPixels / 1e6).toFixed(2)} Mpx, ${ceiling.smallFragment.ms}ms`);
    probe('a whole-layer A0 fragment is refused, not scaled down',
        typeof ceiling.wholeA0Layer.refused === 'string'
        && ceiling.wholeA0Layer.PRODUCED === undefined,
        ceiling.wholeA0Layer.refused?.slice(0, 70) ?? `IT PRODUCED ${ceiling.wholeA0Layer.PRODUCED} BYTES`);
    check('and the refusal is typed, so the UI can explain it',
        ceiling.wholeA0Layer.code === 'raster-budget', ceiling.wholeA0Layer.code);

    // ---- the support boundary --------------------------------------------
    console.log('\n=== documents this will not write ===');
    const boundary = await page.evaluate(() => window.__m3save.supportBoundary());
    check('an ordinary document is accepted and saved',
        boundary.rich.supported === true && boundary.rich.save.produced > 0,
        `${boundary.rich.save.produced} bytes`);
    check('so is a multi-page one',
        boundary.multipage.supported === true && boundary.multipage.save.produced > 0);
    probe('a signature field is refused, by name',
        boundary.signed.supported === false
        && boundary.signed.problems[0].code === 'signed'
        && boundary.signed.save.produced === undefined,
        boundary.signed.problems[0].message.slice(0, 50));
    probe('a damaged document is refused before anything is written',
        boundary.damaged.supported === false
        && boundary.damaged.problems[0].code === 'unreadable'
        && boundary.damaged.save.produced === undefined);
    probe('a form that cannot be inspected is refused, not assumed unsigned',
        boundary['unreadable-form'].supported === false
        && boundary['unreadable-form'].problems[0].code === 'form-unreadable'
        && boundary['unreadable-form'].save.produced === undefined,
        boundary['unreadable-form'].problems[0].message.slice(0, 44));
    check('each boundary fires on its own document, distinctly',
        boundary.signed.problems[0].code === 'signed'
        && boundary.damaged.problems[0].code === 'unreadable'
        && boundary['unreadable-form'].problems[0].code === 'form-unreadable',
        'signed / unreadable / form-unreadable, against 2 accepted controls');

    // ---- nothing partial --------------------------------------------------
    console.log('\n=== an unsaveable job produces no bytes ===');
    const closed = await page.evaluate(() => window.__m3save.failClosed());
    const invalid = Object.entries(closed).filter(([k]) => k !== 'a valid job');
    check('every invalid case was measured', invalid.length === 10, `${invalid.length} cases`);
    for (const [label, r] of invalid) {
        probe(`${label}: refused with no output`,
            typeof r.refused === 'string' && r.PRODUCED === undefined,
            r.refused?.slice(0, 56) ?? `IT PRODUCED ${r.PRODUCED} BYTES`);
    }
    check('a valid job still goes through', closed['a valid job'].produced > 0,
        `${closed['a valid job'].produced} bytes`);

    // ---- the input is never touched --------------------------------------
    console.log('\n=== the bytes handed in ===');
    const unchanged = await page.evaluate(() => window.__m3save.sourceBytesUnchanged());
    for (const [label, r] of Object.entries(unchanged)) {
        check(`${label}: the source array is unchanged, byte for byte`,
            r.unchanged === true, `${r.outcome}, ${r.length} bytes`);
    }

    // ---- the output name --------------------------------------------------
    console.log('\n=== the file that comes out ===');
    const names = await page.evaluate(() => window.__m3save.filenames());
    check('the original is never overwritten',
        names['drawing.pdf'] === 'drawing_annotated.pdf', names['drawing.pdf']);
    check('a Japanese name is kept', names['A-101 平面図.pdf'] === 'A-101 平面図_annotated.pdf');
    check('a name with dots keeps all but the extension',
        names['dots.in.name.pdf'] === 'dots.in.name_annotated.pdf');
    check('a name with no extension still gets one',
        names['no-extension'] === 'no-extension_annotated.pdf');

    // ---- cost -------------------------------------------------------------
    console.log('\n=== what a save costs ===');
    const perf = await page.evaluate(() => window.__m3save.performance());
    for (const [label, r] of Object.entries(perf)) {
        console.log(`  ${label.padEnd(28)} ${r.refused
            ? `refused: ${r.refused.slice(0, 40)}`
            : `${String(r.ms).padStart(5)}ms  ${String(r.outputBytes).padStart(8)}B  `
              + `${(r.maxRasterPixels / 1e6).toFixed(2)} Mpx  ${r.fragments} fragment(s)`}`);
    }

    // ---- network ----------------------------------------------------------
    console.log('\n=== the save talked to nobody ===');
    probe('no external HTTP(S) request during any save',
        external.length === 0,
        external.length === 0 ? '0 requests' : external.join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nThe source survives, the annotations are vector, and what cannot be '
            + 'written is refused.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nSmoke run failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
