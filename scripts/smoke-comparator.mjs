/**
 * The Comparator reliability gate.
 *
 * The comparator's old contract was "every input produces a picture", which is
 * why the same drawing on a different sheet size looked more alarming than a
 * wall that had moved. What this gate exists to prove is the opposite property:
 * that the tool declines when it cannot compare honestly, that it says so by
 * name, and that when it does compare, the verdict and the picture come from
 * the same rule.
 *
 * A source diff cannot show that. The geometry is decided from a real PDF's
 * page dictionary, the verdict from real rendered ink, the refusals from
 * arithmetic that has to agree with what the renderer would actually allocate.
 * So this drives the production engine in a browser, over a synthetic corpus
 * built for the purpose.
 *
 * Several checks are unusual: a comparison is asserted to *refuse*. Those are
 * the point. A gate in which the comparator answered everything would be
 * asserting the defect.
 *
 * Run:  node scripts/make-comparator-fixtures.mjs
 *       node scripts/smoke-comparator.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5204;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'comparator', 'base-a4.pdf'))) {
    execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'make-comparator-fixtures.mjs')],
        { stdio: 'inherit' },
    );
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
    // PDF.js renders in a worker, whose traffic page-level events miss.
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-comparator-harness.html`,
        { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__comparatorReady === true,
        { timeout: 300000 });

    // ---- the contract the code was built to ---------------------------------
    console.log('\n=== the contract ===');
    const constants = await page.evaluate(() => window.__comparator.constants());
    check('the spatial tolerance is a policy, not a pixel count',
        constants.tolerance.unit === 'mm' && constants.tolerance.default === 0
        && constants.tolerance.minimum === 0 && constants.tolerance.maximum === 0.15
        && constants.tolerance.step === 0.05
        && constants.tolerance.zeroAlwaysAvailable === true,
        `${constants.tolerance.unit}, default ${constants.tolerance.default}, `
        + `${constants.tolerance.minimum}-${constants.tolerance.maximum} step `
        + `${constants.tolerance.step}`);
    check('and the words offered with it do not claim it only ignores shifts',
        /寸法|文字|記号|形状/.test(constants.disclosure),
        constants.disclosure);
    check('the MATCH floor is zero, and is not a setting',
        constants.matchFloor === 0);
    check('the ceilings are the adopted ones',
        constants.geometryTolerancePt === 1
        && constants.workCeiling === 12_000_000_000
        && constants.outputCeiling === 256 * 1024 * 1024
        && constants.defaultMemory === 512 * 1024 * 1024,
        `1pt, ${constants.workCeiling.toLocaleString('en-US')} units, `
        + `${constants.outputCeiling / (1024 * 1024)} MiB output, `
        + `${constants.defaultMemory / (1024 * 1024)} MiB memory`);
    check('the planner is bound to the selected algorithm and contract',
        constants.algorithm === 'separable-dilation'
        && constants.contract === 'reference-pairs',
        `${constants.algorithm}, ${constants.contract}`);
    check('a larger memory budget is offered, and is not the default',
        constants.memoryPresets.length >= 2
        && constants.memoryPresets[0].bytes === constants.defaultMemory
        && constants.memoryPresets.some((p) => p.bytes > constants.defaultMemory),
        constants.memoryPresets.map((p) => p.label).join(', '));

    // ---- geometry ------------------------------------------------------------
    console.log('\n=== what the tool will and will not compare ===');
    const geometry = await page.evaluate(() => window.__comparator.geometry());
    for (const [label, r] of Object.entries(geometry)) {
        console.log(`  ${label.padEnd(24)} ${String(r.plan).padEnd(18)} ${
            String(r.verdict ?? '—').padEnd(7)} ${
            r.changePixels === null ? '' : `${r.changePixels}px`}`);
    }
    const recoverable = ['identical', 'rotate 90', 'rotate 180', 'rotate 270',
        'crop origin', 'crop + rotate 90', 'crop + rotate 180', 'crop + rotate 270'];
    check('every difference a renderer can settle is settled',
        recoverable.every((k) => geometry[k].plan === 'READY_TO_COMPARE'),
        `${recoverable.length} pairs ready`);
    check('and each of them reaches MATCH with nothing differing',
        recoverable.every((k) => geometry[k].verdict === 'MATCH'
            && geometry[k].changePixels === 0),
        '0 differing pixels on all of them');
    probe('every accepted mapping is the identity, rendered upright',
        recoverable.every((k) => geometry[k].mappings.every(
            (m) => m.rigid && m.scaleX === 1 && m.scaleY === 1
                && m.scaleDelta === 0 && m.renderRotation === 0,
        )),
        'no anisotropic stretch can be planned');
    check('a sheet 0.99pt different is the same sheet',
        geometry['+0.99pt'].plan === 'READY_TO_COMPARE');
    probe('a sheet 1.01pt different is not',
        geometry['+1.01pt'].plan === 'GEOMETRY_MISMATCH',
        geometry['+1.01pt'].reported.join('; '));
    probe('a different sheet size is refused rather than compared',
        geometry['different sheet'].plan === 'GEOMETRY_MISMATCH'
        && geometry['different sheet'].verdict === null,
        geometry['different sheet'].reported.join('; '));
    probe('so is a different orientation, and the same aspect at another size',
        geometry['portrait vs landscape'].plan === 'GEOMETRY_MISMATCH'
        && geometry['same aspect 1.4x'].plan === 'GEOMETRY_MISMATCH',
        'proportions do not make it the same paper');

    // ---- geometry primitives -------------------------------------------------
    const units = await page.evaluate(() => window.__comparator.geometryUnits());
    probe('a display-plane mapping would have stretched a quarter turn',
        Math.abs(units.displayPlane.x - 0.707) < 0.01
        && Math.abs(units.displayPlane.y - 1.414) < 0.01,
        `x ${units.displayPlane.x.toFixed(3)}, y ${units.displayPlane.y.toFixed(3)} `
        + '— which is why the mapping is taken upright');
    check('the canonical mapping is the identity instead',
        units.canonical.rigid && units.canonical.scaleX === 1
        && units.canonical.renderRotation === 0
        && units.rigidAcrossRotations === true);
    check('the separable dilation is the same answer as a box scan',
        units.dilationIsSeparable === true);
    check('one differing pixel in a hundred thousand is a change',
        units.verdictAtZeroFloor.empty === 'MATCH'
        && units.verdictAtZeroFloor.one === 'CHANGE');

    const single = await page.evaluate(() => window.__comparator.singleDocument());
    probe('one document is not a comparison, and is refused as one',
        single.plan === 'UNSUPPORTED' && single.refusal === 'UNSUPPORTED'
        && single.pages === 0,
        'the app still shows it — that is a preview, and it carries no verdict');

    // ---- verdicts ------------------------------------------------------------
    console.log('\n=== what it says about a drawing ===');
    const verdicts = await page.evaluate(() => window.__comparator.verdicts());
    for (const [label, r] of Object.entries(verdicts)) {
        console.log(`  ${label.padEnd(26)} ${r.verdict.padEnd(7)} ${
            String(r.changePixels).padStart(6)}px  shown ${
            String(r.shownAsChanged).padStart(6)}px`);
    }
    check('an identical drawing is a match',
        verdicts.identical.verdict === 'MATCH'
        && verdicts.identical.changePixels === 0);
    check('a redrawn but unchanged sheet is a match too',
        verdicts['nothing changed (control)'].verdict === 'MATCH'
        && verdicts['nothing changed (control)'].changePixels === 0,
        'no ratio floor is needed for MATCH to be reachable');
    check('a wall added is a change',
        verdicts['a wall added'].verdict === 'CHANGE'
        && verdicts['a wall added'].hasBounds,
        `${verdicts['a wall added'].changePixels} differing pixels`);
    // The change a floor would have swallowed.
    probe('one digit of a dimension is a change at the default tolerance',
        verdicts['a digit changed'].verdict === 'CHANGE'
        && verdicts['a digit changed'].changePixels > 0,
        `${verdicts['a digit changed'].changePixels} pixels, `
        + `${((verdicts['a digit changed'].changePixels
            / verdicts['a digit changed'].inkPixels) * 100).toFixed(3)}% of the ink`);
    check('and the picture shows exactly what the verdict counted',
        Object.values(verdicts).every((r) => r.shownAsChanged === r.changePixels),
        'the painted result and the mask agree on every pair');

    // ---- every resolution the tool offers ------------------------------------
    console.log('\n=== the tolerance, at every supported resolution ===');
    const dpi = await page.evaluate(() => window.__comparator.acrossDpi());
    for (const resolution of dpi.supported) {
        console.log(`  ${String(resolution).padStart(3)}dpi  default radius ${
            dpi.rows[resolution].radius}  ${dpi.rows[resolution].verdict.padEnd(7)}${
            String(dpi.rows[resolution].changePixels).padStart(6)}px    at 0.15mm `
            + `radius ${dpi.atMaximum[resolution].radius}  ${
                dpi.atMaximum[resolution].verdict}`);
    }
    check('the supported resolutions are the ones the UI offers',
        dpi.supported.join(',') === '72,150,300,450');
    check('at the default tolerance a changed dimension is a change, at every dpi',
        dpi.supported.every((d) => dpi.rows[d].verdict === 'CHANGE'
            && dpi.rows[d].radius === 0),
        dpi.supported.map((d) => `${d}:${dpi.rows[d].changePixels}px`).join(' '));
    // The ceiling is where it is because of this.
    check('and it survives every tolerance the policy permits, at every dpi',
        dpi.supported.every((d) => dpi.atMaximum[d].verdict === 'CHANGE'),
        dpi.supported.map((d) => `${d}dpi:${dpi.atMaximum[d].changePixels}px`).join(' '));

    // ---- ink -----------------------------------------------------------------
    console.log('\n=== what counts as ink ===');
    const ink = await page.evaluate(() => window.__comparator.inkPredicate());
    for (const [name, r] of Object.entries(ink)) {
        console.log(`  ${name.padEnd(12)} rgb(${r.rgb.join(',').padEnd(11)}) ${
            r.predicate ? 'ink' : 'paper'}`);
    }
    check('one predicate serves the mask and the verdict alike',
        Object.values(ink).every((r) => r.predicate === r.mask),
        'the two used to disagree, and a colour between them was painted as a '
        + 'change and left out of the reported area');
    check('black, dark grey, CAD cyan and CAD yellow are all ink',
        ink.black.predicate && ink['dark grey'].predicate
        && ink['cad cyan'].predicate && ink['cad yellow'].predicate,
        'any channel below the threshold');
    check('a pale yellow is ink under the any-channel rule',
        ink['pale yellow'].predicate === true,
        `rgb(${ink['pale yellow'].rgb.join(',')}) — blue channel is what catches it`);
    check('and white is not',
        ink.white.predicate === false);
    // Stated as a limitation rather than fixed by guessing a threshold.
    check('a pale grey hatch remains below the threshold',
        ink['pale grey'].predicate === false,
        'known limitation: no automatic threshold estimation was added');

    // ---- four members --------------------------------------------------------
    console.log('\n=== more than two members ===');
    const multi = await page.evaluate(() => window.__comparator.multiMember());
    for (const [label, r] of Object.entries(multi)) {
        console.log(`  ${label.padEnd(32)} ${r.verdict.padEnd(7)} ${
            r.pairs.map((p) => `${p.verdict === 'CHANGE' ? '!' : '='}${
                p.shownAsChanged}`).join(' ')}`);
    }
    check('four identical documents match',
        multi['four identical'].verdict === 'MATCH'
        && multi['four identical'].pairs.every((p) => p.shownAsChanged === 0));
    check('three the same and one changed is a change, and names the member',
        multi['three same, one changed'].verdict === 'CHANGE'
        && multi['three same, one changed'].pairs
            .filter((p) => p.verdict === 'CHANGE').length === 1
        && multi['three same, one changed'].pairs
            .find((p) => p.verdict === 'CHANGE').label === 'added-line-a4',
        'one pair of three is painted as changed');
    // The case the old any-other-layer rule reported as clean.
    probe('two against two is a change, and the disagreement is visible',
        multi['two vs two'].verdict === 'CHANGE'
        && multi['two vs two'].pairs.filter((p) => p.verdict === 'CHANGE').length === 2
        && multi['two vs two'].pairs
            .filter((p) => p.verdict === 'CHANGE')
            .every((p) => p.shownAsChanged > 0),
        multi['two vs two'].pairs
            .map((p) => `${p.label}:${p.shownAsChanged}px`).join(' '));
    probe('and a reference against three different documents likewise',
        multi['reference and three different'].verdict === 'CHANGE'
        && multi['reference and three different'].pairs
            .every((p) => p.verdict === 'CHANGE' && p.shownAsChanged > 0),
        'every pair visible');
    check('every visual says which two documents it compares',
        Object.values(multi).every((r) => r.pairs.every(
            (p) => p.title.includes(' vs ') && p.title.startsWith('p1:'),
        )),
        multi['two vs two'].pairs[0].title);

    // ---- a page one document does not have -----------------------------------
    console.log('\n=== a missing page, and a blank one ===');
    const missing = await page.evaluate(() => window.__comparator.missingAndFailure());
    for (const p of missing.pages) {
        console.log(`  page ${p.page}  ${p.status.padEnd(18)} ${
            String(p.verdict ?? '—').padEnd(7)} ${p.reported.join('; ')}`);
    }
    check('the pages both documents have compare normally',
        missing.pages[0].status === 'READY_TO_COMPARE'
        && missing.pages[1].status === 'READY_TO_COMPARE');
    // Neither deleted nor given a verdict it did not earn.
    probe('the page one document lacks is kept, named, and left unjudged',
        missing.pages[2].status === 'MISSING_PAGE'
        && missing.pages[2].verdict === null
        && missing.pages[2].pairs === 0
        && missing.pages[2].reported.length > 0,
        missing.pages[2].reported.join('; '));
    check('a page that exists and is blank is a different state',
        missing.blankThird.status === 'READY_TO_COMPARE'
        && missing.blankThird.verdict === 'CHANGE',
        `blank third page: ${missing.blankThird.verdict}, `
        + `${missing.blankThird.changePixels} differing pixels`);

    // ---- the budgets ---------------------------------------------------------
    console.log('\n=== what it refuses to attempt ===');
    const budgets = await page.evaluate(() => window.__comparator.budgets());
    console.log(`  one A4 page at 300 dpi: ${
        budgets.work.oneA4Page.toLocaleString('en-US')} work units, `
        + `${(budgets.output.perVisual / 1e6).toFixed(1)} MB of output`);
    console.log(`  a 48 Mpx sheet at 512 MiB: ${
        budgets.memory.atDefault.refusal?.status ?? 'within'}  `
        + `at 2 GiB: ${budgets.memory.afterExplicitRaise.refusal?.status ?? 'within'}`);
    console.log(`  an A1 at 450 dpi through the engine: ${
        budgets.engineRefusal.status}`);

    // A refusal, and not a quieter comparison.
    probe('a job over the memory budget is refused by name, not quietly shrunk',
        budgets.memory.atDefault.refusal?.status === 'OVER_MEMORY_BUDGET',
        budgets.memory.atDefault.refusal?.reason ?? '');
    check('and the refusal offers the user something to do about it',
        typeof budgets.memory.atDefault.refusal?.achievable === 'string'
        && budgets.memory.atDefault.refusal.achievable.length > 0,
        budgets.memory.atDefault.refusal?.achievable ?? '');
    // The budget only moves because a person moved it.
    check('the same job is planned once the user raises the budget explicitly',
        budgets.memory.afterExplicitRaise.refusal === null
        && budgets.memory.afterExplicitRaise.withinBudget === true,
        'nothing raised it automatically');
    probe('and the engine itself refuses a real over-budget job',
        budgets.engineRefusal.plan !== 'READY_TO_COMPARE'
        && budgets.engineRefusal.status !== null
        && budgets.engineRefusal.pages === 0,
        `${budgets.engineRefusal.status}: ${budgets.engineRefusal.reason}`);

    probe('a job over the whole-job work ceiling is refused',
        budgets.work.atCeiling === 'OVER_WORK_BUDGET',
        `173 A4 pages at 300 dpi, at `
        + `${budgets.work.oneA4Page.toLocaleString('en-US')} units each`);
    check('while a job under it is not',
        budgets.work.justUnder === null,
        'the ceiling is on the operation, not on the page');
    probe('and arithmetic that would leave the safe-integer range is refused',
        budgets.work.unrepresentable === false);

    check('the documented output capacity is what the planner actually allows',
        budgets.output.seven === null,
        `seven A4 pages at 300 dpi, ${
            (budgets.output.perVisual / 1e6).toFixed(1)} MB each`);
    probe('and one page past it is refused before anything is rendered',
        budgets.output.nine === 'OVER_OUTPUT_BUDGET',
        `nine pages against a ${
            budgets.output.ceiling / (1024 * 1024)} MiB output ceiling`);
    check('the working set is modelled phase by phase, not as one sum',
        Object.keys(budgets.memoryPhases.phases).length === 5
        && budgets.memoryPhases.peakWorkingSet
            === Math.max(...Object.values(budgets.memoryPhases.phases)),
        `peak at the ${budgets.memoryPhases.peakPhase} phase, `
        + `${budgets.memoryPhases.bytesPerPixel.toFixed(1)} bytes per pixel`);

    // ---- the memory ceiling, as a boundary -------------------------------------
    //
    // The budget above is arithmetic. What makes it a ceiling is that there is
    // a largest job it takes and a first job it refuses, that the refusal moves
    // only when a person moves it, and that moving it buys nothing anywhere
    // else.
    console.log('\n=== where 512 MiB actually stops ===');
    const boundary = await page.evaluate(() => window.__comparator.memoryBoundary());
    console.log(`  largest accepted: ${boundary.largestAccepted.width}x${
        boundary.largestAccepted.height} (${
        boundary.largestAccepted.megapixels.toFixed(1)} Mpx), peak ${
        (boundary.largestAccepted.jobPeak / (1024 * 1024)).toFixed(1)} MiB`);
    console.log(`  first refused:    ${boundary.firstRefused.width}x${
        boundary.firstRefused.height}, peak ${
        (boundary.firstRefused.jobPeak / (1024 * 1024)).toFixed(1)} MiB  ${
        boundary.firstRefused.status}`);
    check('the largest job the default budget takes is inside it',
        boundary.largestAccepted.refusal === null
        && boundary.largestAccepted.jobPeak <= boundary.largestAccepted.limit,
        `${(boundary.largestAccepted.jobPeak / (1024 * 1024)).toFixed(1)} MiB of `
        + `${boundary.largestAccepted.limit / (1024 * 1024)} MiB`);
    probe('and one pixel-step past it is refused by name',
        boundary.firstRefused.status === 'OVER_MEMORY_BUDGET'
        && boundary.firstRefused.jobPeak > boundary.largestAccepted.limit,
        `${boundary.firstRefused.width}px wide instead of `
        + `${boundary.largestAccepted.width}px`);
    check('the refusal names something the user can actually do',
        typeof boundary.firstRefused.achievable === 'string'
        && boundary.firstRefused.achievable.length > 0,
        boundary.firstRefused.achievable ?? '');
    check('the same job is accepted once a person selects 1 GiB',
        boundary.afterExplicitOneGiB.status === null
        && boundary.afterExplicitOneGiB.offered === true,
        '1 GiB is an offered preset, not a computed escape');
    probe('and asking again at the default still refuses, because nothing was raised',
        boundary.askedAgainAtDefault === 'OVER_MEMORY_BUDGET',
        'no sticky budget, no automatic retry at a larger one');
    probe('a 64 GiB budget does not buy past the output ceiling',
        boundary.independence.outputAtSixtyFourGiB === 'OVER_OUTPUT_BUDGET');
    probe('nor past the work ceiling',
        boundary.independence.workAtSixtyFourGiB === 'OVER_WORK_BUDGET',
        'three ceilings, three separate questions');

    // ---- what the job is actually holding ---------------------------------------
    console.log('\n=== the budget and the buffers agree ===');
    const lifetime = await page.evaluate(() => window.__comparator.bufferLifetime());
    console.log(`  ${lifetime.pairs} pairs: at most ${lifetime.maxLiveVisuals} live `
        + `visual (${(lifetime.maxLiveBytes / 1e6).toFixed(1)} MB); retaining every `
        + `one would hold ${lifetime.retainedVisuals} (${
        (lifetime.retainedBytes / 1e6).toFixed(1)} MB)`);
    check('an export over six pairs holds one full-resolution visual, not six',
        lifetime.maxLiveVisuals === 1
        && lifetime.maxLiveBytes === lifetime.oneVisualBytes,
        `${lifetime.maxLiveBytes.toLocaleString('en-US')} bytes = one visual`);
    check('and it has released that one by the time the job ends',
        lifetime.stillHeld === 0,
        'the sink took it, so the run does not keep it');
    probe('while the same run without a sink does hold all of them',
        lifetime.retainedVisuals === lifetime.pairs
        && lifetime.retainedBytes === lifetime.pairs * lifetime.oneVisualBytes,
        `${(lifetime.retainedBytes / 1e6).toFixed(1)} MB — the lifetime the `
        + 'ceiling would have been wrong about');
    check('the encoded bytes it does accumulate are exactly what preflight counted',
        lifetime.encodedBytes === lifetime.predictedEncoded,
        `${lifetime.encodedBytes.toLocaleString('en-US')} = `
        + `${lifetime.predictedEncoded.toLocaleString('en-US')} bytes`);
    check('so the modelled peak is the peak of the code that runs',
        lifetime.withinBudget === true
        && lifetime.modelledPeak >= lifetime.oneVisualBytes + lifetime.predictedEncoded,
        `${(lifetime.modelledPeak / 1e6).toFixed(1)} MB modelled`);

    // ---- the encoder ---------------------------------------------------------
    console.log('\n=== the owned encoder ===');
    const encoder = await page.evaluate(() => window.__comparator.encoder());
    console.log(`  ${encoder.width}x${encoder.height}  ${
        encoder.bytes.toLocaleString('en-US')} bytes  predicted ${
        encoder.predicted.toLocaleString('en-US')}  ${encoder.bytesPerPixel} B/px`);
    check('the encoded size is exactly what the budget predicted',
        encoder.exact === true,
        `${encoder.bytes} = ${encoder.predicted}`);
    probe('and the bytes are a real PNG, not a plausible buffer',
        encoder.roundTripDiffering === 0
        && encoder.signature.join(',') === '137,80,78,71,13,10,26,10',
        'decoded by the browser and compared pixel for pixel');
    check('the contract it encodes to is stated, not inherited',
        constants.pngContract.deflateStrategy === 'stored'
        && constants.pngContract.filter === 0
        && constants.pngContract.colourType === 6
        && constants.pngContract.bitDepth === 8,
        `RGBA8, filter 0, stored blocks of `
        + `${constants.pngContract.maxDeflateBlockBytes} bytes`);

    // ---- stopping ------------------------------------------------------------
    console.log('\n=== stopping a comparison that has started ===');
    const cancellation = await page.evaluate(() => window.__comparator.cancellation());
    console.log(`  cancelled   ${cancellation.cancelled.status}  abandoned=${
        cancellation.cancelled.abandoned}`);
    console.log(`  superseded  ${cancellation.superseded.status}  abandoned=${
        cancellation.superseded.abandoned}`);
    console.log(`  completed   ${cancellation.completed.status}  ${
        cancellation.completed.verdict}  ${
        cancellation.completed.changePixels.toLocaleString('en-US')}px`);
    probe('a cancellation raised while the comparison runs is observed',
        cancellation.cancelled.status === 'CANCELLED'
        && cancellation.cancelled.abandoned === true,
        'the flag is set from a timer, which can only fire when the run yields');
    check('and a cancelled comparison has nothing to publish',
        cancellation.cancelled.pages === 0,
        'half a change mask is not a smaller change');
    probe('a run superseded by a newer generation publishes nothing either',
        cancellation.superseded.status === 'CANCELLED'
        && cancellation.superseded.abandoned === true);
    check('while an uncancelled run still gives the right answer',
        cancellation.completed.abandoned === false
        && cancellation.completed.verdict === 'CHANGE'
        && cancellation.completed.changePixels > 0);

    // ---- one engine, three presentations -------------------------------------
    console.log('\n=== the three presentations agree ===');
    const parity = await page.evaluate(() => window.__comparator.parity());
    console.log(`  page 3: preview ${parity.page3.preview}, export ${
        parity.page3.export}, report ${parity.page3.report}`);
    check('the missing page is the same status in all three',
        parity.page3.preview === 'MISSING_PAGE'
        && parity.page3.export === 'MISSING_PAGE'
        && parity.page3.report === 'MISSING_PAGE',
        'the preview used to skip it, the export to add it anyway, and the '
        + 'report to drop the whole page');
    check('and a compared page has the same verdict in all of them',
        parity.page1Verdict.export === parity.page1Verdict.report,
        `${parity.page1Verdict.export}`);
    check('they render at one scale, so they are one comparison',
        parity.renderScale.preview === parity.renderScale.export
        && parity.renderScale.export === parity.renderScale.report,
        `scale ${parity.renderScale.preview} everywhere; zoom is display only`);

    // ---- the settings a person actually turns ---------------------------------
    //
    // The contract above lives in a module; these are the controls that reach
    // it. A policy nobody can set, or can set past its ceiling, is a policy in
    // a comment.
    console.log('\n=== the controls ===');
    const ui = await browser.newPage();
    ui.setDefaultTimeout(0);
    try {
        await ui.goto(ORIGIN, { waitUntil: 'networkidle0' });
        const opened = await ui.evaluate(() => {
            const button = [...document.querySelectorAll('button')]
                .find((b) => b.textContent?.includes('PDF比較'));
            if (!button) return false;
            button.click();
            return true;
        });
        await new Promise((resolve) => { setTimeout(resolve, 800); });
        check('the comparator opens', opened === true);

        const slider = await ui.evaluate(() => {
            const el = document.querySelector('[data-testid="tolerance-slider"]');
            if (!el) return null;
            return {
                min: el.getAttribute('min'), max: el.getAttribute('max'),
                step: el.getAttribute('step'), value: el.value,
            };
        });
        check('the tolerance is a slider in millimetres, bounded by the policy',
            slider !== null && slider.min === '0' && slider.max === '0.15'
            && slider.step === '0.05' && slider.value === '0',
            slider ? `${slider.min}-${slider.max} mm, step ${slider.step}, `
                + `at ${slider.value}` : 'no slider found');

        // Zero is the default, and the warning only appears once a person has
        // chosen otherwise.
        const beforeWarning = await ui.$('[data-testid="tolerance-warning"]');
        check('and nothing warns at the default, because there is nothing to warn about',
            beforeWarning === null);

        const warning = await ui.evaluate(() => {
            const el = document.querySelector('[data-testid="tolerance-slider"]');
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            ).set;
            setter.call(el, '0.15');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return null;
        });
        void warning;
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        const shown = await ui.evaluate(() => {
            const el = document.querySelector('[data-testid="tolerance-warning"]');
            const value = document.querySelector('[data-testid="tolerance-value"]');
            return { text: el?.textContent ?? null, value: value?.textContent ?? null };
        });
        probe('a non-zero tolerance says what it will also hide',
            shown.text !== null && /寸法|文字|記号|形状/.test(shown.text)
            && !/位置ずれだけ/.test(shown.text),
            (shown.text ?? '').trim());
        check('and the chosen value is shown in millimetres',
            (shown.value ?? '').includes('0.15 mm'),
            (shown.value ?? '').trim());

        const memory = await ui.evaluate(() => {
            const toggle = [...document.querySelectorAll('button')]
                .find((b) => b.getAttribute('title') === 'Export Settings');
            toggle?.click();
            return null;
        });
        void memory;
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        const budget = await ui.evaluate(() => {
            const el = document.querySelector('[data-testid="memory-budget"]');
            if (!el) return null;
            return {
                value: el.value,
                options: [...el.options].map((o) => Number(o.value)),
            };
        });
        check('the memory budget is a choice, defaulting to the recommendation',
            budget !== null
            && Number(budget.value) === 512 * 1024 * 1024
            && budget.options.some((b) => b > 512 * 1024 * 1024),
            budget ? `default ${Number(budget.value) / (1024 * 1024)} MiB, options `
                + `${budget.options.map((b) => b / (1024 * 1024)).join('/')} MiB`
                : 'no selector found');
    } finally {
        await ui.close();
    }

    // ---- network -------------------------------------------------------------
    console.log('\n=== the comparator talked to nobody ===');
    probe('no external HTTP(S) request during any comparison',
        external.length === 0,
        external.length === 0 ? '0 requests' : external.join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    fs.mkdirSync(path.join(ROOT, 'test-fixtures'), { recursive: true });
    fs.writeFileSync(
        path.join(ROOT, 'test-fixtures', 'smoke-comparator-results.json'),
        `${JSON.stringify({
            ranAt: new Date().toISOString(),
            checks,
            external: [...new Set(external)],
            pageErrors,
        }, null, 2)}\n`,
    );

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nThe comparator declines what it cannot compare, and means what '
            + 'it shows.\n');
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
