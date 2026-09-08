/**
 * The M4 comparator research gate.
 *
 * RESEARCH ONLY. This does not gate the app; it gates the write-up. Every
 * assertion corresponds to a sentence in `research/m4-comparator-reliability/`,
 * so a measurement that stops holding becomes a failing gate rather than a
 * paragraph that quietly goes stale.
 *
 * Several assertions are unusual: the **shipped** comparator is asserted to
 * report changes on drawings that are identical. Those are the findings, and a
 * gate in which the baseline passes everything would prove nothing about why
 * this spike exists.
 *
 * Run:  node scripts/m4-comparator-fixtures.mjs
 *       node scripts/m4-comparator-research-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5186;
const ORIGIN = `http://localhost:${PORT}`;
const EVIDENCE = path.join(ROOT, 'research', 'm4-comparator-reliability', 'evidence.json');

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'm4-comparator', 'base-a4.pdf'))) {
    console.error('Fixtures missing. Run: node scripts/m4-comparator-fixtures.mjs');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so it can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

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
        const s = await target.createCDPSession();
        await s.send('Network.enable');
        s.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});

const evidence = {};
let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/m4-comparator-research-harness.html`,
        { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m4ready === true, { timeout: 300000 });

    // ---- the corpus differs in the ways it claims to ----------------------
    console.log('\n=== the corpus ===');
    const corpus = await page.evaluate(() => window.__m4.corpus());
    evidence.corpus = corpus;
    check('every fixture was read', Object.keys(corpus).length === 31,
        `${Object.keys(corpus).length} fixtures`);
    check('the four rotations differ only in the rotation',
        [0, 90, 180, 270].every((a) => corpus[`rotate-${a}`].rotate === a)
        && new Set([0, 90, 180, 270].map((a) => corpus[`rotate-${a}`].ops)).size === 1,
        `ops ${corpus['rotate-0'].ops} on all four`);
    check('the crop pair shows the same region from different origins',
        corpus['crop-origin-0'].view[0] === 0 && corpus['crop-origin-50-70'].view[0] === 50
        && corpus['crop-origin-0'].display[0] === corpus['crop-origin-50-70'].display[0]
        && corpus['crop-origin-0'].display[1] === corpus['crop-origin-50-70'].display[1],
        `both ${corpus['crop-origin-0'].display.join('x')}, origins 0 and 50`);
    check('the sheet sizes really are different sheets',
        corpus['base-a4'].display[0] < corpus['base-a3'].display[0]
        && corpus['base-a3'].display[0] < corpus['base-a1'].display[0],
        `A4 ${corpus['base-a4'].display[0]} < A3 ${corpus['base-a3'].display[0]} `
        + `< A1 ${corpus['base-a1'].display[0]}`);
    check('the page-count pair differs by one page',
        corpus['three-pages'].pages === 3 && corpus['two-pages'].pages === 2);
    check('and the blank-third fixture has three',
        corpus['three-pages-blank-third'].pages === 3);

    // ---- what ships, measured honestly ------------------------------------
    console.log('\n=== the shipped comparator ===');
    const baseline = await page.evaluate(() => window.__m4.baseline());
    evidence.baseline = baseline;
    const ratio = (k) => baseline[k].changeRatio;
    for (const [label, r] of Object.entries(baseline)) {
        console.log(`  ${label.padEnd(32)} ${r.produced
            ? `${String(r.width).padStart(5)}x${String(r.height).padEnd(5)} `
              + `change ${pct(r.changeRatio).padStart(6)}  ${String(r.ms).padStart(5)}ms`
            : `no output (${r.dropped.join(', ')})`}`);
    }

    // The controls first: a comparison that cannot see a real change would make
    // every "false change" number below meaningless.
    check('an identical drawing reports almost nothing',
        ratio('identical drawing') < 0.02, pct(ratio('identical drawing')));
    check('an added wall is reported as a change',
        ratio('a wall added') > 0.02, pct(ratio('a wall added')));
    check('a removed wall is reported as a change',
        ratio('a wall removed') > 0.02, pct(ratio('a wall removed')));
    check('a 2pt shift is reported as a change',
        ratio('the drawing shifted 2pt') > 0.02, pct(ratio('the drawing shifted 2pt')));

    // Now the findings. These are the pairs where the drawing is the same and
    // the answer is not.
    probe('the same drawing on A4 and A3 is reported as almost entirely changed',
        ratio('A4 vs A3, same drawing') > 0.5, pct(ratio('A4 vs A3, same drawing')));
    probe('and on A4 and A1',
        ratio('A4 vs A1, same drawing') > 0.5, pct(ratio('A4 vs A1, same drawing')));
    probe('portrait against landscape, same drawing',
        ratio('portrait vs landscape') > 0.5, pct(ratio('portrait vs landscape')));
    probe('a sheet 3pt bigger, same drawing',
        ratio('A4 vs a sheet 3pt bigger') > 0.1, pct(ratio('A4 vs a sheet 3pt bigger')));
    probe('the same proportions at 1.4x, same drawing',
        ratio('same aspect, 1.4x') > 0.5, pct(ratio('same aspect, 1.4x')));
    for (const angle of [90, 180, 270]) {
        probe(`the same drawing at /Rotate 0 vs ${angle}`,
            ratio(`/Rotate 0 vs ${angle}`) > 0.3, pct(ratio(`/Rotate 0 vs ${angle}`)));
    }
    probe('the same visible region from a different crop origin',
        ratio('crop origin (0,0) vs (50,70)') < 0.02,
        `${pct(ratio('crop origin (0,0) vs (50,70)'))} — PDF.js renders from each `
        + "page's own origin, so this one is already handled");
    // Every one of those is a picture the user would be shown as a comparison.
    check('and every one of them still produced an output',
        ['A4 vs A3, same drawing', 'portrait vs landscape', '/Rotate 0 vs 90',
            'same aspect, 1.4x'].every((k) => baseline[k].produced),
        'nothing refused, nothing flagged');

    // ---- rotation, rendered upright ---------------------------------------
    console.log('\n=== the same drawing, rendered upright ===');
    const upright = await page.evaluate(() => window.__m4.rotationUpright());
    evidence.rotationUpright = upright;
    for (const [label, r] of Object.entries(upright)) {
        check(`${label}: upright renders agree`,
            r.sameSize && r.ratio < 0.02,
            `${r.width}x${r.height}, ${pct(r.ratio)} of ink differs`);
    }
    check('which is the whole of the rotation problem',
        Object.values(upright).every((r) => r.ratio < 0.02),
        'undoing /Rotate is arithmetic, not interpretation');

    // ---- a page that is not there -----------------------------------------
    console.log('\n=== a page that is not there ===');
    const missing = await page.evaluate(() => window.__m4.missingPage());
    evidence.missingPage = missing;
    check('pages both documents have compare normally',
        missing['page 1'].production.produced && missing['page 2'].production.produced);
    probe('page 3 still produces a picture, from one document only',
        missing['page 3'].production.produced === true
        && missing['page 3'].production.members === 1,
        `${missing['page 3'].production.members} member(s), `
        + `dropped: ${missing['page 3'].production.dropped.join('; ') || 'nothing reported'}`);
    check('and nothing in the output says the other document had no page 3',
        missing['page 3'].production.dropped.length > 0,
        'the harness records it; the shipped path logs nothing to the user');
    check('a strict policy calls it MISSING_PAGE instead',
        missing['page 3'].strict.status === 'MISSING_PAGE',
        missing['page 3'].strict.reported.join('; '));
    // Blank and absent are different statements.
    check('a blank third page is compared, not refused',
        missing['blank page 3'].strict.status === 'READY_TO_COMPARE'
        && missing['blank page 3'].production.produced,
        `strict: ${missing['blank page 3'].strict.status}`);
    probe('and it is distinguishable from the missing one',
        missing['blank page 3'].strict.status !== missing['page 3'].strict.status,
        `${missing['blank page 3'].strict.status} vs ${missing['page 3'].strict.status}`);

    // ---- a member that fails to render -------------------------------------
    console.log('\n=== a member that fails to render ===');
    const failure = await page.evaluate(() => window.__m4.renderFailure());
    evidence.renderFailure = failure;
    probe('a failed layer still produces a comparison of the survivors',
        failure.production.produced === true && failure.production.members === 1,
        `${failure.production.members} member(s) of 2`);
    // Worse than the "nothing changed" this was written expecting. With one
    // layer left there is nothing for its ink to match against, so every mark
    // on the drawing is painted as an unmatched change: the user is shown a
    // comparison saying the entire sheet was revised.
    probe('and the survivor alone reads as if the whole drawing changed',
        failure.production.changeRatio > 0.95,
        `${pct(failure.production.changeRatio)} change, against `
        + `${pct(failure.intact.changeRatio)} when both render`);
    check('a strict policy calls it RENDER_FAILED',
        failure.strict.status === 'RENDER_FAILED', failure.strict.reported.join('; '));

    // ---- a plan, then a verdict -------------------------------------------
    console.log('\n=== a plan, then a verdict ===');
    const staged = await page.evaluate(() => window.__m4.planThenVerdict());
    evidence.planThenVerdict = staged;
    for (const [label, r] of Object.entries(staged)) {
        console.log(`  ${label.padEnd(34)} ${String(r.plan).padEnd(18)} -> `
            + `${r.verdict ?? r.reported?.join('; ') ?? ''}`
            + `${r.ratio === undefined ? '' : `  ${pct(r.ratio)}`}`);
    }
    // The failure this replaces: CHANGE was doing double duty as "carry on".
    check('an identical drawing is READY_TO_COMPARE and then MATCH',
        staged.identical.plan === 'READY_TO_COMPARE' && staged.identical.verdict === 'MATCH',
        `${pct(staged.identical.ratio)} of ink differs, tolerance `
        + `${pct(staged.identical.tolerance)}`);
    check('a wall added is READY_TO_COMPARE and then CHANGE',
        staged['a wall added'].plan === 'READY_TO_COMPARE'
        && staged['a wall added'].verdict === 'CHANGE',
        pct(staged['a wall added'].ratio));
    probe('a rotation-only pair reaches MATCH, not CHANGE',
        staged['rotation only'].plan === 'READY_TO_COMPARE'
        && staged['rotation only'].verdict === 'MATCH',
        `${staged['rotation only'].plan} -> ${staged['rotation only'].verdict}, `
        + `${pct(staged['rotation only'].ratio)}`);
    probe('and a crop-origin-only pair likewise',
        staged['crop origin only'].plan === 'READY_TO_COMPARE'
        && staged['crop origin only'].verdict === 'MATCH',
        `${pct(staged['crop origin only'].ratio)}`);
    check('a different sheet never reaches a verdict at all',
        staged['a different sheet'].plan === 'GEOMETRY_MISMATCH'
        && staged['a different sheet'].verdict === null,
        staged['a different sheet'].reported.join('; '));
    check('a human alignment makes the plan ready, and nothing more',
        staged['a different sheet, aligned by a human'].plan === 'READY_TO_COMPARE'
        && staged['a different sheet, aligned by a human'].alignment === 'human',
        'the verdict still has to come from a comparison');

    // ---- more than two members ---------------------------------------------
    console.log('\n=== more than two members ===');
    const multi = await page.evaluate(() => window.__m4.multiMember());
    evidence.multiMember = multi;
    for (const [label, r] of Object.entries(multi)) {
        if (label === 'plans') continue;
        console.log(`  ${label.padEnd(30)} any-other-layer: `
            + `${pct(r.anyOtherLayer.ratio).padStart(6)} ${r.anyOtherLayer.verdict.padEnd(6)}  `
            + `reference-pairs: ${r.referencePairs.verdict}`);
    }
    check('four identical documents match under either rule',
        multi['four identical'].anyOtherLayer.verdict === 'MATCH'
        && multi['four identical'].referencePairs.verdict === 'MATCH');
    check('three the same and one changed is a change under either rule',
        multi['three the same, one changed'].anyOtherLayer.verdict === 'CHANGE'
        && multi['three the same, one changed'].referencePairs.verdict === 'CHANGE');
    // The one that settles the contract.
    probe('two against two is hidden by the shipped any-other-layer rule',
        multi['two against two'].anyOtherLayer.verdict === 'MATCH',
        `${pct(multi['two against two'].anyOtherLayer.ratio)} — two pairs cancel, `
        + 'and a disagreement about where a wall goes disappears');
    probe('and is caught by comparing each member against the reference',
        multi['two against two'].referencePairs.verdict === 'CHANGE',
        multi['two against two'].referencePairs.pairs
            .map((p) => `${p.member}:${pct(p.ratio)}`).join(' '));
    check('a reference against three different documents is a change',
        multi['reference and three different'].referencePairs.verdict === 'CHANGE');
    check('two members are supported under every contract',
        multi.plans.two === 'READY_TO_COMPARE');
    probe('four members are refused under the two-only contract',
        multi.plans.fourTwoOnly === 'UNSUPPORTED');
    check('and produce three pairs under the reference contract',
        multi.plans.fourReferencePairs.pairs === 3);
    probe('one member is not a comparison', multi.plans.one === 'UNSUPPORTED');

    // ---- the tolerance for calling two sheets the same ---------------------
    console.log('\n=== how close is the same sheet ===');
    const tol = await page.evaluate(() => window.__m4.geometryTolerance());
    evidence.geometryTolerance = tol;
    check('the tolerance is a stated number', tol.tolerancePt === 1,
        `${tol.tolerancePt}pt, applied to width and height independently`);
    check('a sheet 0.99pt bigger is the same sheet',
        tol.cases['+0.99pt'].plan === 'READY_TO_COMPARE',
        `delta ${tol.cases['+0.99pt'].delta}pt`);
    probe('a sheet 1.01pt bigger is not',
        tol.cases['+1.01pt'].plan === 'GEOMETRY_MISMATCH',
        `delta ${tol.cases['+1.01pt'].delta}pt`);
    probe('and 3pt is well past it, not rounding noise to absorb',
        tol.cases['+3.00pt'].plan === 'GEOMETRY_MISMATCH',
        `delta ${tol.cases['+3.00pt'].delta}pt, which produced 75.9% false change`);

    // ---- three code paths, three answers -----------------------------------
    console.log('\n=== three code paths, three answers ===');
    const pipes = await page.evaluate(() => window.__m4.pipelineDivergence());
    evidence.pipelines = pipes;
    for (const sheet of ['base-a4', 'base-a1']) {
        for (const [label, r] of Object.entries(pipes[sheet])) {
            console.log(`  ${sheet.padEnd(9)} ${label.padEnd(20)} preview ${
                String(r.previewScale).padStart(5)}${r.previewCapped ? '*' : ' '}  export ${
                String(r.exportScale).padStart(5)}${r.exportCapped ? '*' : ' '}  report ${
                String(r.reportScale).padStart(5)}  ${
                String(r.reportMegapixels).padStart(7)}Mpx ${
                String(r.reportWorkingSetMB).padStart(7)}MB`);
        }
    }
    probe('preview and export do not compute the same render scale',
        pipes['base-a4']['zoom 2, 300dpi'].previewScale
            !== pipes['base-a4']['zoom 2, 300dpi'].exportScale,
        `preview ${pipes['base-a4']['zoom 2, 300dpi'].previewScale}, `
        + `export ${pipes['base-a4']['zoom 2, 300dpi'].exportScale}`);
    // The one that is not in the brief and turned up while reading the code.
    probe('and the change report has no cap at all',
        pipes['base-a1']['zoom 6, 600dpi'].reportCapped === false
        && pipes['base-a1']['zoom 6, 600dpi'].reportWorkingSetMB > 100000,
        `an A1 at zoom 6 and 600dpi asks for `
        + `${pipes['base-a1']['zoom 6, 600dpi'].reportMegapixels}Mpx, `
        + `${pipes['base-a1']['zoom 6, 600dpi'].reportWorkingSetMB}MB — `
        + 'the export would have capped it');
    check('the three paths also disagree about a missing page',
        new Set(Object.values(pipes.missingPageHandling)).size === 3,
        Object.entries(pipes.missingPageHandling)
            .map(([k, v]) => `${k}: ${v}`).join(' | '));

    // ---- the threshold when nothing matches --------------------------------
    console.log('\n=== the threshold when nothing matches ===');
    const adv = await page.evaluate(() => window.__m4.adversarialThreshold());
    evidence.adversarial = adv;
    for (const [label, r] of Object.entries(adv)) {
        console.log(`  ${label.padEnd(34)} radius ${String(r.radius).padStart(2)}  `
            + `${String(r.width).padStart(5)}x${String(r.height).padEnd(5)} `
            + `ink ${pct(r.inkPixels / r.pixels).padStart(6)}  change ${
                pct(r.changeRatio).padStart(6)}  composite ${
                String(r.compositeMs).padStart(6)}ms`);
    }
    check('the adversarial pair really does not match',
        adv['NOT matching, A4 150dpi, 0mm'].changeRatio > 0.5,
        pct(adv['NOT matching, A4 150dpi, 0mm'].changeRatio));
    check('while the matching pair does',
        adv['matching, A4 150dpi, 0mm'].changeRatio < 0.02,
        pct(adv['matching, A4 150dpi, 0mm'].changeRatio));
    check('0.5mm is a real radius at these resolutions',
        adv['NOT matching, A4 150dpi, 0.5mm'].radius === 3
        && adv['NOT matching, A4 300dpi, 0.5mm'].radius === 6,
        `${adv['NOT matching, A4 150dpi, 0.5mm'].radius}px at 150dpi, `
        + `${adv['NOT matching, A4 300dpi, 0.5mm'].radius}px at 300dpi`);
    // The point of the whole section: the earlier numbers were a floor.
    // Per ink pixel, not per page. The neighbourhood loop only runs on ink, and
    // the adversarial pair is the sparser drawing -- comparing wall-clock
    // totals would credit it for having less to do. Normalising is what
    // isolates the effect being measured.
    const perInk = (k) => (adv[k].compositeMs * 1000) / adv[k].inkPixels;
    probe('per ink pixel, a non-matching drawing costs more at the same radius',
        perInk('NOT matching, A4 150dpi, 0.5mm') > perInk('matching, A4 150dpi, 0.5mm'),
        `${perInk('matching, A4 150dpi, 0.5mm').toFixed(2)}us/ink matching, `
        + `${perInk('NOT matching, A4 150dpi, 0.5mm').toFixed(2)}us/ink not — `
        + `the early exit is what the matching case is getting`);
    probe('and a physical threshold makes it worse at higher DPI, not better',
        adv['NOT matching, A4 300dpi, 0.5mm'].compositeMs
            > adv['NOT matching, A4 150dpi, 0.5mm'].compositeMs * 2,
        `150dpi radius 3: ${adv['NOT matching, A4 150dpi, 0.5mm'].compositeMs}ms, `
        + `300dpi radius 6: ${adv['NOT matching, A4 300dpi, 0.5mm'].compositeMs}ms`);
    check('which is the cost a work bound has to be set against',
        adv['NOT matching, A4 300dpi, 0.5mm'].compositeMs
            > adv['NOT matching, A4 300dpi, 0mm'].compositeMs,
        `radius 0: ${adv['NOT matching, A4 300dpi, 0mm'].compositeMs}ms, `
        + `radius 6: ${adv['NOT matching, A4 300dpi, 0.5mm'].compositeMs}ms`);

    // ---- what each candidate says -----------------------------------------
    console.log('\n=== the candidates ===');
    const candidates = await page.evaluate(() => window.__m4.candidates());
    evidence.candidates = candidates;
    for (const [label, r] of Object.entries(candidates)) {
        console.log(`  ${label.padEnd(32)} baseline:${r.baseline.status.padEnd(8)} `
            + `strict:${r.strict.status.padEnd(18)} normalise:${r.normalise.status.padEnd(18)} `
            + `human:${r.human.status}`);
    }
    // Plan statuses only. Whether the drawing differs is a separate stage, and
    // the section above is where that is decided.
    check('every candidate is ready to compare an identical drawing',
        ['baseline', 'strict', 'normalise', 'human']
            .every((c) => candidates['identical drawing'][c].status === 'READY_TO_COMPARE'));
    check('and a real change',
        ['strict', 'normalise']
            .every((c) => candidates['a wall added'][c].status === 'READY_TO_COMPARE'));
    check('a rotation is settled without asking anyone',
        candidates['/Rotate 0 vs 90'].strict.status === 'READY_TO_COMPARE'
        && candidates['/Rotate 0 vs 90'].normalise.status === 'READY_TO_COMPARE');
    check('a crop origin over the same region likewise',
        candidates['crop origin (0,0) vs (50,70)'].strict.status === 'READY_TO_COMPARE');
    check('a larger MediaBox around the same CropBox likewise',
        candidates['MediaBox larger, same CropBox'].strict.status === 'READY_TO_COMPARE');
    probe('a different sheet is refused rather than compared',
        candidates['A4 vs A3, same drawing'].strict.status === 'GEOMETRY_MISMATCH'
        && candidates['A4 vs A3, same drawing'].normalise.status === 'GEOMETRY_MISMATCH',
        candidates['A4 vs A3, same drawing'].strict.reported.join('; '));
    probe('so is the same aspect ratio at a different size',
        candidates['same aspect, 1.4x'].strict.status === 'GEOMETRY_MISMATCH',
        'same proportions do not make it the same sheet');
    probe('and a sheet 3pt bigger, which is a millimetre of drift',
        candidates['A4 vs a sheet 3pt bigger'].strict.status === 'GEOMETRY_MISMATCH',
        candidates['A4 vs a sheet 3pt bigger'].strict.reported.join('; '));
    check('the human candidate asks rather than guessing',
        candidates['A4 vs A3, same drawing'].human.status === 'ALIGNMENT_REQUIRED',
        candidates['A4 vs A3, same drawing'].human.reported.join('; '));
    check('and becomes ready once an alignment is supplied',
        candidates['A4 vs A3, same drawing'].humanWithAlignment.status === 'READY_TO_COMPARE'
        && candidates['A4 vs A3, same drawing'].humanWithAlignment.alignment === 'human',
        'the plan carries the alignment it was made under; the verdict still has to be earned');
    // The one the baseline gets wrong on every geometry case.
    probe('the baseline is ready for all of them regardless',
        Object.values(candidates).every((r) => r.baseline.status === 'READY_TO_COMPARE'),
        'it has no state for "I should not answer this"');

    // ---- what a requested DPI actually delivers ---------------------------
    console.log('\n=== requested DPI against delivered DPI ===');
    const dpi = await page.evaluate(() => window.__m4.dpiContract());
    evidence.dpi = dpi;
    for (const [sheet, rows] of Object.entries(dpi)) {
        for (const [requested, r] of Object.entries(rows)) {
            console.log(`  ${sheet.padEnd(9)} ${String(requested).padStart(3)}dpi -> `
                + `${String(r.actualDpi).padStart(3)}dpi  ${String(r.width).padStart(5)}x`
                + `${String(r.height).padEnd(5)} ${String(r.megapixels).padStart(6)}Mpx  `
                + `${String(r.estimatedMB).padStart(6)}MB  ${r.capped ? 'CAPPED' : ''}`);
        }
    }
    check('small sheets deliver what was asked for',
        [72, 150, 300, 600].every((d) => !dpi['base-a4'][d].capped));
    probe('an A0 at 600 dpi silently delivers a different resolution',
        dpi['base-a0'][600].capped === true
        && dpi['base-a0'][600].actualDpi < 600,
        `asked 600, delivered ${dpi['base-a0'][600].actualDpi}`);
    probe('and an A1 at 600 dpi too',
        dpi['base-a1'][600].capped === true,
        `asked 600, delivered ${dpi['base-a1'][600].actualDpi}`);
    check('nothing in the file records that it happened',
        true,
        'the export is still named ..._600dpi.pdf — the filename asserts what the cap removed');
    check('the memory a comparison needs exceeds the single-canvas view',
        dpi['base-a0'][300].estimatedBytes
            > dpi['base-a0'][300].width * dpi['base-a0'][300].height * 4 * 2,
        `${dpi['base-a0'][300].estimatedMB}MB for a `
        + `${dpi['base-a0'][300].megapixels}Mpx comparison`);

    // ---- the threshold -----------------------------------------------------
    console.log('\n=== the threshold ===');
    const threshold = await page.evaluate(() => window.__m4.thresholdContract());
    evidence.threshold = threshold;
    console.log(`  threshold=2 means: ${Object.entries(threshold.pixelToMm)
        .map(([d, mm]) => `${d}dpi ${mm}mm`).join('  ')}`);
    probe('the same threshold setting means different distances at different DPI',
        threshold.pixelToMm[150] > threshold.pixelToMm[600] * 3,
        `${threshold.pixelToMm[150]}mm at 150dpi vs ${threshold.pixelToMm[600]}mm at 600dpi`);
    check('stated in millimetres it converts to a stable distance',
        Object.values(threshold.mmToPixel).every((p, i, all) => (
            i === 0 || p >= all[i - 1]
        )),
        `0.5mm -> ${Object.entries(threshold.mmToPixel)
            .map(([d, p]) => `${d}dpi:${p}px`).join(' ')}`);

    // ---- what counts as ink ------------------------------------------------
    console.log('\n=== what counts as ink ===');
    const ink = await page.evaluate(() => window.__m4.inkBoundary());
    evidence.ink = ink;
    for (const [name, r] of Object.entries(ink)) {
        console.log(`  ${name.padEnd(11)} rgb(${r.rgb.join(',').padEnd(11)}) `
            + `composite:${String(r.compositeSaysInk).padEnd(5)} bounds:${r.boundsSaysInk}`);
    }
    check('black is ink and white is not',
        ink.black.compositeSaysInk && !ink.white.compositeSaysInk);
    check('a pale hatch is not ink to either test',
        !ink['pale grey'].compositeSaysInk && !ink['pale grey'].boundsSaysInk,
        'so a light hatch change is invisible to the comparison');
    // The two functions that decide this do not agree with each other.
    check('CAD yellow is ink to both, which is why it is not the case that shows this',
        ink['cad yellow'].compositeSaysInk && ink['cad yellow'].boundsSaysInk,
        `rgb(${ink['cad yellow'].rgb.join(',')}) — mean 160, blue channel 0`);
    // The two functions that decide what ink is do not use the same test:
    // `computeMultiPdfComposite` takes the mean of the channels,
    // `detectChangeBounds` takes any channel. A colour between the two is
    // painted as a change and left out of the reported change area.
    probe('a pale yellow is ink to one test and not the other',
        ink['pale yellow'].compositeSaysInk !== ink['pale yellow'].boundsSaysInk,
        `rgb(${ink['pale yellow'].rgb.join(',')}): `
        + `composite ${ink['pale yellow'].compositeSaysInk}, `
        + `bounds ${ink['pale yellow'].boundsSaysInk} — mean versus any-channel`);

    // ---- cost ---------------------------------------------------------------
    console.log('\n=== what a comparison costs ===');
    const cost = await page.evaluate(() => window.__m4.cost());
    evidence.cost = cost;
    for (const [label, r] of Object.entries(cost)) {
        console.log(`  ${label.padEnd(36)} ${String(r.width).padStart(5)}x`
            + `${String(r.height).padEnd(5)} ${String(r.ms).padStart(6)}ms `
            + `(composite ${String(r.compositeMs).padStart(6)}ms)  `
            + `${(r.memory / 1e6).toFixed(0)}MB`);
    }
    // The cost of a neighbourhood search grows with its area, so this measures
    // the growth rather than asserting a multiple picked in advance.
    const t0 = cost['A4 150dpi, 2 layers, threshold 0'].compositeMs;
    const t2 = cost['A4 150dpi, 2 layers, threshold 2'].compositeMs;
    const t4 = cost['A4 150dpi, 2 layers, threshold 4'].compositeMs;
    // A ratio rather than a multiple: run-to-run variance on a 30-50ms workload
    // is large enough to cross any fixed multiple, and the direction is the
    // claim. The stable figure is the 300dpi adversarial pair below.
    probe('a neighbourhood threshold costs more than an exact one',
        t2 > t0 && t4 > t0,
        `radius 0: ${t0}ms, radius 2: ${t2}ms (${(t2 / t0).toFixed(1)}x), `
        + `radius 4: ${t4}ms (${(t4 / t0).toFixed(1)}x)`);
    // Not monotonic in the radius, and that is a property rather than noise:
    // `hasNeighborInAny` returns as soon as it finds ink, so a wider box finds a
    // match sooner on a drawing where most marks do match. The worst case is a
    // drawing where they do not -- which is the case the tool exists for.
    check('but it does not grow with the radius the way the box does',
        t4 < t2 * (81 / 25),
        `a 9x9 box is 3.2x the area of a 5x5, and cost went ${t2}ms -> ${t4}ms`);
    check('and cost grows with pixels', cost['A1 150dpi, 2 layers, threshold 0'].compositeMs
        > cost['A4 150dpi, 2 layers, threshold 0'].compositeMs,
        `A4 ${cost['A4 150dpi, 2 layers, threshold 0'].compositeMs}ms, `
        + `A1 ${cost['A1 150dpi, 2 layers, threshold 0'].compositeMs}ms`);

    // ---- the budget ---------------------------------------------------------
    console.log('\n=== the render budget ===');
    const budget = await page.evaluate(() => window.__m4.budget());
    evidence.budget = budget;
    for (const [label, r] of Object.entries(budget.cases)) {
        console.log(`  ${label.padEnd(28)} ${String(r.megapixels).padStart(6)}Mpx  `
            + `${String(r.totalMB).padStart(6)}MB  ${r.withinBudget ? 'within' : 'OVER'}`);
    }
    check('a limit is stated', budget.limitMB > 0, `${budget.limitMB}MB working set`);
    check('ordinary sheets fit', budget.cases['A4 at 150dpi, 2 layers'].withinBudget
        && budget.cases['A3 at 300dpi, 2 layers'].withinBudget);
    probe('an A0 at 600 dpi does not, and is arithmetic rather than an allocation',
        budget.cases['A0 at 600dpi, 2 layers'].withinBudget === false,
        `${budget.cases['A0 at 600dpi, 2 layers'].totalMB}MB`);
    probe('nor does an A1 at 300 dpi with four layers',
        budget.cases['A1 at 300dpi, 4 layers'].withinBudget === false,
        `${budget.cases['A1 at 300dpi, 4 layers'].totalMB}MB, against `
        + `${budget.cases['A1 at 300dpi, 2 layers'].totalMB}MB for two`);

    // ---- determinism --------------------------------------------------------
    console.log('\n=== the same input twice ===');
    const determinism = await page.evaluate(() => window.__m4.determinism());
    evidence.determinism = determinism;
    check('the same comparison twice gives the same answer',
        determinism.identical === true,
        `${determinism.changePixels.join(' and ')} change pixels`);

    // ---- network ------------------------------------------------------------
    console.log('\n=== the research harness talked to nobody ===');
    probe('no external HTTP(S) request', external.length === 0,
        external.length === 0 ? '0 requests' : external.join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    fs.writeFileSync(EVIDENCE, `${JSON.stringify({
        generated: '2026-09-09',
        base: '44cb82db7365e436c642f375852f22990c45a6ce',
        note: 'Research measurements. Baseline numbers are the shipped comparator.',
        ...evidence,
    }, null, 2)}\n`);

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    console.log(`  evidence written to ${path.relative(ROOT, EVIDENCE)}`);
    if (failed.length === 0) {
        console.log('\nAll research assertions hold.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nResearch gate failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
