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
if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'size-annot-hidden.pdf'))) {
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
function assertRun(run, { expectPageCount, expectTargets, label, textMayGain = false }) {
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
        const clipDelta = report.clipApplied ? 1 : 0;

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

        // `textMayGain` is only for the cropped fixture: PDF.js drops text that
        // sits outside the page view, so text the old CropBox excluded starts
        // being reported once the sheet grows around it. Nothing may be lost.
        check(`${tag} p${i + 1}: page order preserved (text identity)`,
            textMayGain ? a.text.startsWith(b.text) : a.text === b.text,
            `${JSON.stringify(b.text.slice(0, 24))} -> ${JSON.stringify(a.text.slice(0, 24))}`);

        check(`${tag} p${i + 1}: text extraction preserved`, a.text.length > 0 || b.text.length === 0,
            `${b.text.length} -> ${a.text.length} chars`);

        // The only operator the normaliser may add is the clip rectangle that
        // keeps the old visibility boundary; nothing may be rasterised.
        check(`${tag} p${i + 1}: vector content preserved (no rasterisation)`,
            a.pathOps === b.pathOps + clipDelta && a.imageOps === b.imageOps && a.textOps === b.textOps
            && a.clipOps === b.clipOps + clipDelta,
            `path ${b.pathOps}->${a.pathOps} image ${b.imageOps}->${a.imageOps} text ${b.textOps}->${a.textOps} clip ${b.clipOps}->${a.clipOps} (clipApplied=${report.clipApplied})`);

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

            // The ink box alone cannot see a flip or a mirror; its centroid can.
            check(`${tag} p${i + 1}: content not flipped or mirrored`,
                near(a.ink.centroid.fx, b.ink.centroid.fx, 0.02) && near(a.ink.centroid.fy, b.ink.centroid.fy, 0.02),
                `centroid ${round(b.ink.centroid.fx, 3)},${round(b.ink.centroid.fy, 3)} -> ${round(a.ink.centroid.fx, 3)},${round(a.ink.centroid.fy, 3)}`);
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
            console.log(`  p${p.pageNumber}: ${String(p.detected ?? 'Other').padEnd(5)} ${round(p.widthPt, 1)}x${round(p.heightPt, 1)} rot=${p.rotation} ${p.orientation} scale=${round(p.scale, 5)} content=${p.contentTransformed} boxes=${p.boxesNormalized} clip=${p.clipApplied} unchanged=${p.unchanged}`);
        }
        console.log(`  summary: ${r.summary.pageCount}ページ -> ${r.summary.targetLabel}  src=${r.summary.sourceCounts.map((s) => `${s.label}x${s.count}`).join(' ')}  suffix=${r.summary.filenameSuffix}  ${r.inputBytes} -> ${r.outputBytes} bytes`);
        return r;
    };

    await doRun('a1', 'size-a1-landscape.pdf', 'A1');
    await doRun('a3', 'size-a3-landscape.pdf', 'A1');
    await doRun('mixed', 'size-mixed.pdf', 'A1');
    await doRun('mixedFirst', 'size-mixed.pdf', 'first-page');
    await doRun('portrait', 'size-a3-portrait.pdf', 'A1');
    await doRun('rotated', 'size-a3-rotated.pdf', 'A1');
    await doRun('rot180', 'size-a3-rot180.pdf', 'A1');
    await doRun('rot270', 'size-a3-rot270.pdf', 'A1');
    await doRun('custom', 'size-custom.pdf', 'A1');
    await doRun('textNative', 'size-text-native.pdf', 'A1');
    await doRun('ocr', 'size-ocr-layer.pdf', 'A1');
    await doRun('annotated', 'size-annotated.pdf', 'A1');
    await doRun('form', 'size-form.pdf', 'A1');
    await doRun('mismatch', 'size-mediabox-mismatch.pdf', 'A1');
    await doRun('hidden', 'size-cropbox-hidden.pdf', 'A1');
    await doRun('down', 'size-a1-landscape.pdf', 'A3');

    console.log('\n=== checks ===');

    assertRun(runs.a1, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.a3, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.mixed, { expectPageCount: 4, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.mixedFirst, { expectPageCount: 4, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.portrait, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.rotated, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.rot180, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.rot270, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.custom, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.textNative, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.ocr, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.annotated, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.form, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.mismatch, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o) });
    assertRun(runs.hidden, { expectPageCount: 1, expectTargets: (_, o) => expectedSheet('A1', o), textMayGain: true });
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
    check('A1 -> A1 adds no clip', runs.a1.summary.pages[0].clipApplied === false);

    // ---- RF1: page boxes normalise even when the content must not move -----
    console.log('\n=== RF1: MediaBox / CropBox mismatch ===');
    const mm1 = runs.mismatch;
    const mmBefore = mm1.before.pages[0];
    const mmAfter = mm1.after.pages[0];
    const mmReport = mm1.summary.pages[0];
    console.log(`  before media ${round(mmBefore.mediaBox.width, 2)}x${round(mmBefore.mediaBox.height, 2)} crop ${round(mmBefore.cropBox.width, 2)}x${round(mmBefore.cropBox.height, 2)}`);
    console.log(`  after  media ${round(mmAfter.mediaBox.width, 2)}x${round(mmAfter.mediaBox.height, 2)} crop ${round(mmAfter.cropBox.width, 2)}x${round(mmAfter.cropBox.height, 2)}`);
    check('fixture really has MediaBox > CropBox == exact A1',
        mmBefore.mediaBox.width === 3000 && mmBefore.mediaBox.height === 2000
        && near(mmBefore.cropBox.width, mm(841), 0.01) && near(mmBefore.cropBox.height, mm(594), 0.01),
        `media ${mmBefore.mediaBox.width}x${mmBefore.mediaBox.height}`);
    check('RF1: output MediaBox is A1',
        near(mmAfter.mediaBox.width, mm(841), 0.01) && near(mmAfter.mediaBox.height, mm(594), 0.01),
        `${round(mmAfter.mediaBox.width, 3)}x${round(mmAfter.mediaBox.height, 3)}`);
    check('RF1: output CropBox is A1',
        near(mmAfter.cropBox.width, mm(841), 0.01) && near(mmAfter.cropBox.height, mm(594), 0.01),
        `${round(mmAfter.cropBox.width, 3)}x${round(mmAfter.cropBox.height, 3)}`);
    check('RF1: boxes normalised without transforming the content',
        mmReport.boxesNormalized === true && mmReport.contentTransformed === false && mmReport.clipApplied === false,
        `boxes=${mmReport.boxesNormalized} content=${mmReport.contentTransformed} clip=${mmReport.clipApplied}`);
    check('RF1: no CTM wrapper was added (operators identical)',
        mmAfter.pathOps === mmBefore.pathOps && mmAfter.textOps === mmBefore.textOps
        && mmAfter.clipOps === mmBefore.clipOps && mmAfter.imageOps === mmBefore.imageOps,
        `path ${mmBefore.pathOps}->${mmAfter.pathOps} clip ${mmBefore.clipOps}->${mmAfter.clipOps}`);
    check('RF1: text unchanged', mmAfter.text === mmBefore.text && mmBefore.text.length > 0);
    check('RF1: annotations and forms unchanged',
        JSON.stringify(mmAfter.annots) === JSON.stringify(mmBefore.annots)
        && JSON.stringify(mm1.after.formFields) === JSON.stringify(mm1.before.formFields),
        `${mmBefore.annots.length} annots`);
    check('RF1: the page is reported as changed, not untouched', mmReport.unchanged === false);

    // ---- RF2: content the CropBox was hiding must stay hidden --------------
    console.log('\n=== RF2: hidden CropBox content ===');
    const hiddenProbe = await page.evaluate(() => window.__sizeSmoke.hiddenProbe('size-cropbox-hidden.pdf'));
    console.log(`  media ${JSON.stringify(hiddenProbe.mediaBox)}`);
    console.log(`  crop  ${JSON.stringify(hiddenProbe.cropBox)}`);
    console.log(`  widened render: leftDark=${hiddenProbe.widenedLeftDark} rightDark=${hiddenProbe.widenedRightDark}`);
    check('fixture really has MediaBox > CropBox',
        hiddenProbe.mediaBox.width > hiddenProbe.cropBox.width && hiddenProbe.cropBox.x > 0,
        `${hiddenProbe.mediaBox.width}x${hiddenProbe.mediaBox.height} vs ${hiddenProbe.cropBox.width}x${hiddenProbe.cropBox.height}`);
    check('the hidden marks really exist (they render once the CropBox is widened)',
        hiddenProbe.widenedLeftDark > 100 && hiddenProbe.widenedRightDark > 100,
        `left=${hiddenProbe.widenedLeftDark} right=${hiddenProbe.widenedRightDark}`);
    check('before: the CropBox hides them (ink starts at the marker inset)',
        near(hiddenProbe.asIsInk.left, 6, 2 * hiddenProbe.asIsInk.pixelPt)
        && near(hiddenProbe.asIsInk.right, 6, 2 * hiddenProbe.asIsInk.pixelPt),
        `l/r ${round(hiddenProbe.asIsInk.left, 2)}/${round(hiddenProbe.asIsInk.right, 2)}`);

    console.log(`  as-is text   : ${JSON.stringify(hiddenProbe.asIsText)}`);
    console.log(`  widened text : ${JSON.stringify(hiddenProbe.widenedText)}`);
    check('PDF.js text extraction is CropBox-aware in the source',
        !hiddenProbe.asIsText.includes('HIDDEN') && hiddenProbe.widenedText.includes('HIDDEN'),
        `asIs=${JSON.stringify(hiddenProbe.asIsText)}`);

    const padding = await page.evaluate(() => window.__sizeSmoke.paddingProbe('size-cropbox-hidden.pdf', 'A1'));
    console.log(`  padding pt: ${JSON.stringify({
        left: round(padding.paddingPt.left, 2), right: round(padding.paddingPt.right, 2),
        top: round(padding.paddingPt.top, 2), bottom: round(padding.paddingPt.bottom, 2),
    })}`);
    console.log(`  ink: inside=${padding.insideDark} outside=${padding.outsideDark} samples=${JSON.stringify(padding.outsideSamples)}`);
    check('the fit really does leave padding to surface into',
        padding.paddingPt.left > 50 && padding.paddingPt.right > 50,
        `l=${round(padding.paddingPt.left, 1)} r=${round(padding.paddingPt.right, 1)}`);
    check('RF2: no ink at all outside the mapped source CropBox',
        padding.outsideDark === 0 && padding.insideDark > 1000,
        `outside=${padding.outsideDark} inside=${padding.insideDark}`);
    check('RF2: the clip is what does it', padding.report.clipApplied === true
        && runs.hidden.after.pages[0].clipOps === runs.hidden.before.pages[0].clipOps + 1,
        `clipApplied=${padding.report.clipApplied} clipOps ${runs.hidden.before.pages[0].clipOps}->${runs.hidden.after.pages[0].clipOps}`);
    check('RF2: the annotation inside the CropBox still survives',
        runs.hidden.before.pages[0].annots.length === 1 && runs.hidden.after.pages[0].annots.length === 1
        && padding.annots.length === 1,
        `${runs.hidden.before.pages[0].annots.length} -> ${runs.hidden.after.pages[0].annots.length}`);
    console.log(`  output text  : ${JSON.stringify(padding.text)}`);
    check('RF2: no visible text is lost', padding.text.startsWith(hiddenProbe.asIsText),
        JSON.stringify(padding.text.slice(0, 60)));
    // Measured, not assumed: the clip stops the marks being drawn, but the
    // glyphs stay in the content stream, so whatever now falls inside the sheet
    // is still reachable by a text layer even though nothing of it is drawn.
    // Recorded as a known limitation rather than left as a surprise.
    const gainedText = padding.text.slice(hiddenProbe.asIsText.length);
    check('RF2 limitation is exactly as measured: formerly cropped text is invisible but partly extractable',
        padding.outsideDark === 0 && gainedText.length > 0 && hiddenProbe.widenedText.includes(gainedText),
        `outsideDark=${padding.outsideDark} gained=${JSON.stringify(gainedText)}`);

    if (padding.annots[0]) {
        const r = padding.annots[0].rect;
        const mv = padding.report.mappedVisible;
        check('RF2: that annotation lands inside the mapped visible box',
            r[0] >= mv.x - 1 && r[1] >= mv.y - 1 && r[2] <= mv.x + mv.width + 1 && r[3] <= mv.y + mv.height + 1,
            `rect ${r.map((v) => round(v, 1)).join(',')} in ${round(mv.x, 1)},${round(mv.y, 1)},${round(mv.x + mv.width, 1)},${round(mv.y + mv.height, 1)}`);
    }

    console.log('\n=== RF2: annotation outside the CropBox is refused ===');
    const refused = await page.evaluate(() => window.__sizeSmoke.errorProbe('size-cropbox-annot.pdf', 'A1'));
    console.log(`  ${JSON.stringify(refused)}`);
    check('RF2: an annotation that would become visible fails closed',
        refused.threw === true && refused.code === 'annotation-outside-crop',
        `threw=${refused.threw} code=${refused.code}`);
    check('RF2: the refusal message is user-facing Japanese',
        typeof refused.message === 'string' && refused.message.includes('CropBox') && refused.message.includes('中止'),
        refused.message?.slice(0, 60));
    const accepted = await page.evaluate(() => window.__sizeSmoke.errorProbe('size-cropbox-hidden.pdf', 'A1'));
    check('RF2: the same sheet without that annotation is still accepted', accepted.threw === false,
        JSON.stringify(accepted));

    // ---- RF4: only Hidden counts as safely invisible ------------------------
    console.log('\n=== RF4: annotation /F flags ===');
    const FLAG = { Hidden: 2, Print: 4, NoView: 32, ToggleNoView: 256 };
    for (const [fixture, flags, label, mustRefuse] of [
        ['size-cropbox-annot.pdf', FLAG.Print, 'Print', true],
        ['size-annot-noview-print.pdf', FLAG.NoView | FLAG.Print, 'NoView|Print', true],
        ['size-annot-noview-toggle.pdf', FLAG.NoView | FLAG.ToggleNoView, 'NoView|ToggleNoView', true],
        ['size-annot-hidden.pdf', FLAG.Hidden, 'Hidden', false],
    ]) {
        const probe = await page.evaluate((n, t) => window.__sizeSmoke.annotFlagProbe(n, t), fixture, 'A1');
        const outside = probe.before[1];
        console.log(`  ${label.padEnd(20)} /F=${outside?.f}  ${probe.error ? `refused(${probe.error.code})` : 'accepted'}`);
        check(`${label}: the fixture really carries /F = ${flags}`, outside?.f === flags,
            `got ${outside?.f}`);
        if (mustRefuse) {
            check(`${label}: annotation outside the CropBox is refused`,
                probe.error !== null && probe.error.code === 'annotation-outside-crop',
                JSON.stringify(probe.error));
            check(`${label}: nothing is produced when refused`, probe.after === null);
        } else {
            check(`${label}: safely invisible everywhere, so it is accepted`, probe.error === null,
                JSON.stringify(probe.error));
            check(`${label}: the annotation is kept, still Hidden, and moved with the content`,
                probe.after !== null && probe.after.length === probe.before.length
                && probe.after[1].f === FLAG.Hidden
                && probe.after[1].rect[0] !== probe.before[1].rect[0],
                `before ${JSON.stringify(probe.before[1])} after ${JSON.stringify(probe.after?.[1])}`);
        }
    }

    // ---- RF3: every /Rotate quadrant ---------------------------------------
    console.log('\n=== RF3: rotation quadrants ===');
    for (const [key, rotate, expectBox] of [
        ['rotated', 90, 'swapped'],
        ['rot180', 180, 'plain'],
        ['rot270', 270, 'swapped'],
    ]) {
        const r = runs[key];
        const a = r.after.pages[0];
        const b = r.before.pages[0];
        const wantW = expectBox === 'swapped' ? mm(594) : mm(841);
        const wantH = expectBox === 'swapped' ? mm(841) : mm(594);
        console.log(`  /Rotate ${rotate}: ${round(b.widthPt, 1)}x${round(b.heightPt, 1)} -> ${round(a.widthPt, 1)}x${round(a.heightPt, 1)}  media ${round(a.mediaBox.width, 2)}x${round(a.mediaBox.height, 2)}`);
        check(`/Rotate ${rotate}: displayed sheet is A1 landscape`,
            near(a.widthPt, mm(841), 0.01) && near(a.heightPt, mm(594), 0.01) && a.detected === 'A1',
            `${round(a.widthPt, 1)}x${round(a.heightPt, 1)} ${a.detected}`);
        check(`/Rotate ${rotate}: MediaBox is the ${expectBox} sheet`,
            near(a.mediaBox.width, wantW, 0.01) && near(a.mediaBox.height, wantH, 0.01),
            `${round(a.mediaBox.width, 2)}x${round(a.mediaBox.height, 2)}`);
        check(`/Rotate ${rotate}: rotation entry preserved`, a.rotate === rotate && b.rotate === rotate,
            `${b.rotate} -> ${a.rotate}`);
        check(`/Rotate ${rotate}: visible orientation still landscape`, a.widthPt > a.heightPt);
        check(`/Rotate ${rotate}: text still extracts`, a.text === b.text && a.text.length > 0,
            JSON.stringify(a.text.slice(0, 20)));
        check(`/Rotate ${rotate}: content neither clipped nor moved`,
            near(a.ink.width, b.ink.width * r.summary.pages[0].scale, 6)
            && near(a.ink.left, a.ink.right, 2.5 * a.ink.pixelPt)
            && near(a.ink.centroid.fx, b.ink.centroid.fx, 0.02)
            && near(a.ink.centroid.fy, b.ink.centroid.fy, 0.02),
            `ink ${round(a.ink.width, 1)}x${round(a.ink.height, 1)} centroid ${round(a.ink.centroid.fx, 3)},${round(a.ink.centroid.fy, 3)}`);
    }

    // ---- orientation --------------------------------------------------------
    console.log('\n=== orientation ===');
    check('portrait A3 becomes portrait A1', runs.portrait.after.pages[0].heightPt > runs.portrait.after.pages[0].widthPt
        && runs.portrait.after.pages[0].detected === 'A1');

    // ---- vector & text -----------------------------------------------------
    console.log('\n=== vector & text preservation ===');
    const tn = runs.textNative;
    check('text-native page keeps every character', tn.after.pages[0].text === tn.before.pages[0].text
        && tn.before.pages[0].text.length > 0, `${tn.before.pages[0].text.length} chars`);
    check('text-native page keeps its expected text', /SECTION A-A/.test(tn.after.pages[0].text)
        && /(建築図面テキストレイヤ|ARCHITECTURAL TEXT LAYER)/.test(tn.after.pages[0].text),
        JSON.stringify(tn.after.pages[0].text.slice(0, 60)));
    check('text-native page keeps its vector operators and gains no image',
        tn.after.pages[0].pathOps === tn.before.pages[0].pathOps + (tn.summary.pages[0].clipApplied ? 1 : 0)
        && tn.after.pages[0].pathOps > 0 && tn.after.pages[0].imageOps === 0,
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
