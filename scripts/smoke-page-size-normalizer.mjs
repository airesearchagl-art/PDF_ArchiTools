/**
 * Deterministic smoke verification for 図面サイズ統一 (page-size normalisation).
 *
 * Drives the production module in a real browser against synthetic fixtures and
 * reads every result back through PDF.js, so the checks see what a viewer sees.
 * Small on purpose: this is a gate, not a test framework. Exits non-zero if any
 * check fails.
 *
 * Run:  node scripts/smoke-page-size-normalizer.mjs   (fixtures are generated on demand)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const ORIGIN = `http://localhost:${PORT}`;

const mm = (v) => (v * 72) / 25.4;
/** Restated here on purpose: the gate must not read its expectations from the
 *  module under test. */
const SHEET_MM = {
    A0: { short: 841, long: 1189 },
    A1: { short: 594, long: 841 },
    A2: { short: 420, long: 594 },
    A3: { short: 297, long: 420 },
    A4: { short: 210, long: 297 },
};
const expectedSheet = (key, orientation) => {
    const short = mm(SHEET_MM[key].short);
    const long = mm(SHEET_MM[key].long);
    return orientation === 'landscape' ? { width: long, height: short } : { width: short, height: long };
};

// Regenerate the fixtures when they are absent, so the whole gate is one command.
if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'size-form.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-size-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const round = (v, digits = 3) => Number(v.toFixed(digits));

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
page.on('response', (r) => {
    const url = r.url();
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
});
page.on('pageerror', (e) => pageErrors.push(e.message));

/**
 * The whole acceptance matrix for one run, asserted against expectations that
 * were computed here rather than taken from the module.
 */
function assertRun(run, { expectPageCount, expectTargets, label }) {
    const { before, after, summary } = run;
    const tag = label ?? `${run.name} -> ${run.target}`;

    check(`${tag}: page count unchanged`, before.numPages === after.numPages && after.numPages === expectPageCount,
        `${before.numPages} -> ${after.numPages}`);

    for (let i = 0; i < after.pages.length; i++) {
        const b = before.pages[i];
        const a = after.pages[i];
        const orientation = b.widthPt >= b.heightPt ? 'landscape' : 'portrait';
        const want = expectTargets(i, orientation);
        const report = summary.pages[i];
        const scale = report.scale;

        check(`${tag} p${i + 1}: exact target sheet`,
            near(a.widthPt, want.width, 0.01) && near(a.heightPt, want.height, 0.01),
            `${round(a.widthPt)}x${round(a.heightPt)} want ${round(want.width)}x${round(want.height)}`);

        // The visible sheet is the CropBox, so the MediaBox must agree with it:
        // no "looks like A1 but the MediaBox says otherwise" output.
        const boxW = a.rotate % 180 === 90 ? want.height : want.width;
        const boxH = a.rotate % 180 === 90 ? want.width : want.height;
        check(`${tag} p${i + 1}: MediaBox == CropBox == target`,
            near(a.mediaBox.width, boxW, 0.01) && near(a.mediaBox.height, boxH, 0.01)
            && near(a.cropBox.width, boxW, 0.01) && near(a.cropBox.height, boxH, 0.01)
            && near(a.mediaBox.x, a.cropBox.x, 0.01) && near(a.mediaBox.y, a.cropBox.y, 0.01),
            `media ${round(a.mediaBox.width)}x${round(a.mediaBox.height)} crop ${round(a.cropBox.width)}x${round(a.cropBox.height)}`);

        check(`${tag} p${i + 1}: orientation maintained`,
            (a.widthPt >= a.heightPt ? 'landscape' : 'portrait') === orientation, orientation);

        check(`${tag} p${i + 1}: /Rotate preserved`, a.rotate === b.rotate, `${b.rotate} -> ${a.rotate}`);

        check(`${tag} p${i + 1}: page order preserved (text identity)`, a.text === b.text,
            `${JSON.stringify(b.text.slice(0, 24))} -> ${JSON.stringify(a.text.slice(0, 24))}`);

        check(`${tag} p${i + 1}: text extraction preserved`, a.text.length > 0 || b.text.length === 0,
            `${b.text.length} -> ${a.text.length} chars`);

        check(`${tag} p${i + 1}: vector content preserved (no rasterisation)`,
            a.pathOps === b.pathOps && a.imageOps === b.imageOps && a.textOps === b.textOps,
            `path ${b.pathOps}->${a.pathOps} image ${b.imageOps}->${a.imageOps} text ${b.textOps}->${a.textOps}`);

        if (b.ink && a.ink) {
            // Anything cropped shrinks this box; anything added grows it.
            const tol = 2 * (b.ink.pixelPt * scale + a.ink.pixelPt);
            check(`${tag} p${i + 1}: no clipping (ink box scales exactly)`,
                near(a.ink.width, b.ink.width * scale, tol) && near(a.ink.height, b.ink.height * scale, tol),
                `${round(a.ink.width, 1)}x${round(a.ink.height, 1)} want ${round(b.ink.width * scale, 1)}x${round(b.ink.height * scale, 1)} tol ${round(tol, 2)}`);

            const centreTol = 2.5 * a.ink.pixelPt;
            check(`${tag} p${i + 1}: centred`,
                near(a.ink.left, a.ink.right, centreTol) && near(a.ink.top, a.ink.bottom, centreTol),
                `l/r ${round(a.ink.left, 1)}/${round(a.ink.right, 1)} t/b ${round(a.ink.top, 1)}/${round(a.ink.bottom, 1)} tol ${round(centreTol, 2)}`);

            const beforeAspect = b.ink.width / b.ink.height;
            const afterAspect = a.ink.width / a.ink.height;
            check(`${tag} p${i + 1}: aspect ratio preserved`,
                Math.abs(afterAspect - beforeAspect) / beforeAspect <= 0.01,
                `${round(beforeAspect, 4)} -> ${round(afterAspect, 4)}`);
        }
    }
}

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-size-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__sizeSmoke?.ready === true, { timeout: 120000 });

    const run = (name, target) => page.evaluate((n, t) => window.__sizeSmoke.run(n, t), name, target);
    const runs = {};
    const doRun = async (key, name, target) => {
        console.log(`\n=== ${name} -> ${target} ===`);
        const r = await run(name, target);
        runs[key] = r;
        for (const p of r.summary.pages) {
            console.log(`  p${p.pageNumber}: ${String(p.detected ?? 'Other').padEnd(5)} ${round(p.widthPt, 1)}x${round(p.heightPt, 1)} rot=${p.rotation} ${p.orientation} scale=${round(p.scale, 5)} unchanged=${p.unchanged}`);
        }
        console.log(`  summary: ${r.summary.pageCount}ページ -> ${r.summary.targetLabel}  src=${r.summary.sourceCounts.map((s) => `${s.label}x${s.count}`).join(' ')}  suffix=${r.summary.filenameSuffix}  ${r.inputBytes} -> ${r.outputBytes} bytes`);
        return r;
    };

    // ---- 1. already-target A1 --------------------------------------------
    await doRun('a1', 'size-a1-landscape.pdf', 'A1');
    // ---- 2. A3 up-scaled to A1 -------------------------------------------
    await doRun('a3', 'size-a3-landscape.pdf', 'A1');
    // ---- 3. mixed multipage ----------------------------------------------
    await doRun('mixed', 'size-mixed.pdf', 'A1');
    await doRun('mixedFirst', 'size-mixed.pdf', 'first-page');
    // ---- 4. portrait ------------------------------------------------------
    await doRun('portrait', 'size-a3-portrait.pdf', 'A1');
    // ---- 5. /Rotate 90 ----------------------------------------------------
    await doRun('rotated', 'size-a3-rotated.pdf', 'A1');
    // ---- 6. non-A-series custom sheet -------------------------------------
    await doRun('custom', 'size-custom.pdf', 'A1');
    // ---- 7. text-native vector page ---------------------------------------
    await doRun('textNative', 'size-text-native.pdf', 'A1');
    // ---- 8. OCR-layer page -------------------------------------------------
    await doRun('ocr', 'size-ocr-layer.pdf', 'A1');
    // ---- 9. annotations ----------------------------------------------------
    await doRun('annotated', 'size-annotated.pdf', 'A1');
    // ---- 10. AcroForm -------------------------------------------------------
    await doRun('form', 'size-form.pdf', 'A1');
    // ---- 11. down-scale A1 -> A3 -------------------------------------------
    await doRun('down', 'size-a1-landscape.pdf', 'A3');

    console.log('\n=== checks ===');

    assertRun(runs.a1, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.a3, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.mixed, { expectPageCount: 4, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.mixedFirst, { expectPageCount: 4, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.portrait, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.rotated, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.custom, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.textNative, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.ocr, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.annotated, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.form, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.down, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A3', o) });

    // ---- detection / summary ----------------------------------------------
    console.log('\n=== detection & summary ===');
    check('A1 sheet detected as A1', runs.a1.before.pages[0].detected === 'A1');
    check('A3 sheet detected as A3', runs.a3.before.pages[0].detected === 'A3');
    check('rotated A3 detected as A3 (rotation-aware)', runs.rotated.before.pages[0].detected === 'A3',
        `${round(runs.rotated.before.pages[0].widthPt, 1)}x${round(runs.rotated.before.pages[0].heightPt, 1)}`);
    check('custom 700x500 detected as neither A-series sheet',
        runs.custom.before.pages[0].detected === null && runs.custom.summary.sourceCounts[0].label === 'その他');
    check('mixed summary counts A1 x2 and A3 x2',
        JSON.stringify(runs.mixed.summary.sourceCounts) === JSON.stringify([{ label: 'A1', count: 2 }, { label: 'A3', count: 2 }]),
        JSON.stringify(runs.mixed.summary.sourceCounts));
    check('mixed target label is A1', runs.mixed.summary.targetLabel === 'A1');
    check('first-page target resolves to the first sheet', runs.mixedFirst.summary.targetLabel === '最初のページ (A1)',
        runs.mixedFirst.summary.targetLabel);
    check('filename suffix: named target', runs.mixed.summary.filenameSuffix === '_A1');
    check('filename suffix: first-page target', runs.mixedFirst.summary.filenameSuffix === '_normalized');

    // ---- already-target pages are left alone -------------------------------
    console.log('\n=== untouched target pages ===');
    check('A1 -> A1 leaves the page untouched', runs.a1.summary.pages[0].unchanged === true
        && runs.a1.summary.unchangedPages === 1 && runs.a1.summary.transformedPages === 0);
    check('mixed A1 -> A1: only the A3 pages are transformed',
        runs.mixed.summary.pages.map((p) => p.unchanged).join(',') === 'true,false,false,true',
        runs.mixed.summary.pages.map((p) => `p${p.pageNumber}=${p.unchanged}`).join(' '));
    check('A1 -> A1 scale is exactly 1', runs.a1.summary.pages[0].scale === 1, String(runs.a1.summary.pages[0].scale));

    // ---- orientation & rotation -------------------------------------------
    console.log('\n=== orientation & rotation ===');
    check('portrait A3 becomes portrait A1', runs.portrait.after.pages[0].heightPt > runs.portrait.after.pages[0].widthPt
        && runs.portrait.after.pages[0].detected === 'A1');
    check('rotated A3 stays landscape as displayed',
        runs.rotated.after.pages[0].widthPt > runs.rotated.after.pages[0].heightPt
        && runs.rotated.after.pages[0].rotate === 90 && runs.rotated.after.pages[0].detected === 'A1',
        `rotate=${runs.rotated.after.pages[0].rotate} ${round(runs.rotated.after.pages[0].widthPt, 1)}x${round(runs.rotated.after.pages[0].heightPt, 1)}`);
    check('rotated page: MediaBox is the swapped sheet, not the displayed one',
        near(runs.rotated.after.pages[0].mediaBox.width, mm(594), 0.01)
        && near(runs.rotated.after.pages[0].mediaBox.height, mm(841), 0.01),
        `${round(runs.rotated.after.pages[0].mediaBox.width, 2)}x${round(runs.rotated.after.pages[0].mediaBox.height, 2)}`);

    // ---- vector & text -----------------------------------------------------
    console.log('\n=== vector & text preservation ===');
    const tn = runs.textNative;
    check('text-native page keeps every character', tn.after.pages[0].text === tn.before.pages[0].text
        && tn.before.pages[0].text.length > 0, `${tn.before.pages[0].text.length} chars`);
    check('text-native page keeps its expected text', /SECTION A-A/.test(tn.after.pages[0].text)
        && /(建築図面テキストレイヤ|ARCHITECTURAL TEXT LAYER)/.test(tn.after.pages[0].text),
        JSON.stringify(tn.after.pages[0].text.slice(0, 60)));
    check('text-native page keeps its vector operators and gains no image',
        tn.after.pages[0].pathOps === tn.before.pages[0].pathOps && tn.after.pages[0].pathOps > 0
        && tn.after.pages[0].imageOps === 0,
        `paths=${tn.after.pages[0].pathOps} images=${tn.after.pages[0].imageOps}`);
    check('no fixture is replaced by a full-page raster',
        Object.values(runs).every((r) => r.after.pages.every((p, i) => p.imageOps === r.before.pages[i].imageOps)));

    // ---- OCR layer ----------------------------------------------------------
    console.log('\n=== OCR text layer ===');
    const ocr = runs.ocr;
    check('OCR-layer page keeps its invisible text', ocr.after.pages[0].text === ocr.before.pages[0].text
        && ocr.before.pages[0].text.length > 0, JSON.stringify(ocr.after.pages[0].text.slice(0, 40)));
    check('OCR-layer page keeps exactly one image (no re-raster)',
        ocr.before.pages[0].imageOps === 1 && ocr.after.pages[0].imageOps === 1);
    const classified = await page.evaluate(() => window.__sizeSmoke.classify('size-ocr-layer.pdf', 'A1'));
    console.log(`  classify before: ${classified.before.map((c) => `${c.kind}(interior=${c.interiorChars})`).join(', ')}`);
    console.log(`  classify after : ${classified.after.map((c) => `${c.kind}(interior=${c.interiorChars})`).join(', ')}`);
    check('M1 still reads the normalised OCR output as text-native',
        classified.after.every((c) => c.kind === 'text-native'),
        classified.after.map((c) => c.kind).join(','));
    check('M1 classification is unchanged by normalisation',
        JSON.stringify(classified.before.map((c) => c.kind)) === JSON.stringify(classified.after.map((c) => c.kind)));

    // ---- annotations ---------------------------------------------------------
    console.log('\n=== annotations ===');
    const ann = runs.annotated;
    const beforeAnnot = ann.before.pages[0].annots[0];
    const afterAnnot = ann.after.pages[0].annots[0];
    console.log(`  before ${JSON.stringify(beforeAnnot)}`);
    console.log(`  after  ${JSON.stringify(afterAnnot)}`);
    check('annotation survives normalisation',
        ann.before.pages[0].annots.length === 1 && ann.after.pages[0].annots.length === 1,
        `${ann.before.pages[0].annots.length} -> ${ann.after.pages[0].annots.length}`);
    if (beforeAnnot && afterAnnot) {
        const s = ann.summary.pages[0].scale;
        const source = ann.before.pages[0].view;
        const target = ann.after.pages[0].mediaBox;
        const dx = (target.width - (source[2] - source[0]) * s) / 2 - source[0] * s;
        const dy = (target.height - (source[3] - source[1]) * s) / 2 - source[1] * s;
        const want = [beforeAnnot.rect[0] * s + dx, beforeAnnot.rect[1] * s + dy,
            beforeAnnot.rect[2] * s + dx, beforeAnnot.rect[3] * s + dy];
        check('annotation moves and scales with the content',
            want.every((v, i) => near(afterAnnot.rect[i], v, 0.05)),
            `want ${want.map((v) => round(v, 2)).join(',')}`);
    }

    // ---- AcroForm ------------------------------------------------------------
    console.log('\n=== forms ===');
    const form = runs.form;
    console.log(`  before ${JSON.stringify(form.before.formFields)}`);
    console.log(`  after  ${JSON.stringify(form.after.formFields)}`);
    check('AcroForm field survives with its value',
        JSON.stringify(form.after.formFields) === JSON.stringify(form.before.formFields)
        && Array.isArray(form.after.formFields) && form.after.formFields.length === 1,
        JSON.stringify(form.after.formFields));
    const beforeWidget = form.before.pages[0].annots[0];
    const afterWidget = form.after.pages[0].annots[0];
    check('form widget is still on the page', beforeWidget?.subtype === 'Widget' && afterWidget?.subtype === 'Widget',
        `${beforeWidget?.subtype} -> ${afterWidget?.subtype}`);
    if (beforeWidget && afterWidget) {
        const s = form.summary.pages[0].scale;
        const src = form.before.pages[0].view;
        const dst = form.after.pages[0].mediaBox;
        const dx = (dst.width - (src[2] - src[0]) * s) / 2 - src[0] * s;
        const dy = (dst.height - (src[3] - src[1]) * s) / 2 - src[1] * s;
        const want = [beforeWidget.rect[0] * s + dx, beforeWidget.rect[1] * s + dy,
            beforeWidget.rect[2] * s + dx, beforeWidget.rect[3] * s + dy];
        check('form widget moves and scales with the content',
            want.every((v, i) => near(afterWidget.rect[i], v, 0.05)),
            `${afterWidget.rect.map((v) => round(v, 2)).join(',')} want ${want.map((v) => round(v, 2)).join(',')}`);
    }

    // ---- environment ----------------------------------------------------------
    console.log('\n=== environment ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external request during normalisation', uniqueExternal.length === 0, `${uniqueExternal.length} external`);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    fs.mkdirSync(path.join(ROOT, 'test-fixtures'), { recursive: true });
    fs.writeFileSync(
        path.join(ROOT, 'test-fixtures', 'smoke-size-results.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), checks, external: [...new Set(external)], pageErrors }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
