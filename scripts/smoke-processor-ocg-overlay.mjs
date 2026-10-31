/**
 * The 半透明レイヤ追加 overlay-layer gate.
 *
 * The overlay is now a layer of its own, so what this gate asserts is mostly
 * what a reader sees when that layer is switched: off, the page is exactly what
 * it was before (pixel for pixel, annotations and all); on, it is that page with
 * the colour laid over every visible pixel at the chosen opacity, with the
 * annotations still drawn on top. The layer structure the document came with —
 * names, states, order, locks, alternate configurations — must come back
 * untouched, and a structure that cannot be added to without guessing must be
 * refused by name before anything is written.
 *
 * The overlay is appended after the page's own content, so a page that leaves
 * marked content open (BMC/BDC without EMC) would take it inside — inside an
 * OFF layer, the new layer would show nothing when ON (RF-IR01-01). Every such
 * page, an EMC with nothing open, and content the check cannot read to the end
 * are refused by the planner, by the runner on its own and by `processLayer`;
 * operator names inside strings, comments, names, hex strings, property lists
 * and inline image data are not operators, and a sequence may open in one
 * `/Contents` stream and close in the next.
 *
 * The overlay is page content in the new group, never an annotation: no page
 * gains an `/Annots` entry, so an annotation tool's select, move and erase have
 * nothing of it to pick up. That a viewer actually behaves so is not something
 * pdf.js can show; it is checked by a person in the viewer, not here.
 *
 * Run:  node scripts/make-processor-ocg-fixtures.mjs
 *       node scripts/smoke-processor-ocg-overlay.mjs
 *
 * `OCG_SAMPLE_DIR=<dir>` also writes the sample PDFs a person can open in a
 * desktop viewer to check the layer list by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5221;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'processor-ocg', 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-processor-ocg-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so the passing ones can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

/** Off is the page before, exactly; on is that page with the colour over it. */
const overlayHolds = (pages, minShare = 0.9) => pages.every((p) => p.unknown.length === 0
    && p.off.sameSize && p.off.maxDiff === 0
    && p.on.sameSize && p.on.maxDev <= 2 && p.on.outside === 0 && p.on.compared >= p.on.total * minShare
    && (p.on.squares === 0 || p.on.annotationCentreMaxDiff <= 2));
const summary = (pages) => pages.map((p) => `p${p.page} ${p.size.join('x')} off:${p.off.maxDiff}/${p.off.diffPixels}`
    + ` on:dev${p.on.maxDev} n${p.on.compared}/${p.on.total} annot${p.on.annotationCentreMaxDiff ?? '-'}`
    + `${p.unknown.length ? ` unknown:${p.unknown.join('|')}` : ''}`).join('; ');

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);
const external = [];
const pageErrors = [];
page.on('request', (r) => {
    const url = r.url();
    if (url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* data:, blob: */ }
});
page.on('pageerror', (e) => pageErrors.push(e.message));

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-processor-ocg-overlay-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__ocgReady === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__ocg[f](...a), fn, args);
    const NAME = await page.evaluate(() => window.__ocg.overlayName);
    const corpus = await call('corpus');
    check('the fixtures and the module agree on the layer name', corpus.overlayName === NAME, NAME);

    // ---- 1. planning: what may run, and what is refused by name -------------
    console.log('\n=== 1. planning ===');
    for (const f of corpus.files) {
        const plan = await call('plan', f.name, 'layer');
        if (f.expect === 'ready') {
            check(`${f.name}: 半透明レイヤ追加 is ready`, plan.status === 'READY' && plan.optionalContent.state !== 'unreadable',
                `${plan.status} oc:${plan.optionalContent.state}`);
        } else {
            check(`${f.name}: refused as ${f.expect}, saying why`,
                plan.status === f.expect && plan.reason.includes('レイヤー') && plan.reason.includes(f.reason),
                plan.reason);
            const run = await call('run', f.name, 'layer', { color: '#ffffff', opacity: 0.5 }, `refused:${f.name}`);
            check(`${f.name}: nothing is produced`, run.ran === false && run.code === f.expect);
            const both = await call('plan', f.name, 'both');
            check(`${f.name}: 両方実行 is not refused for layers it rebuilds without, and still asks first`,
                both.status === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION', both.status);
        }
    }
    const plainFacts = await call('plan', 'ocg-plain-multi', 'layer');
    check('a document without layers is read as having none', plainFacts.optionalContent.state === 'none');
    const existingFacts = await call('plan', 'ocg-existing', 'layer');
    check('existing layers are read and counted', existingFacts.optionalContent.state === 'read'
        && existingFacts.optionalContent.groupCount === 3, JSON.stringify(existingFacts.optionalContent));
    for (const name of ['ocg-properties-not-dict', 'ocg-no-order']) {
        const unplanned = await call('runUnplanned', name, { color: '#ffffff', opacity: 0.5 });
        probe(`${name}: the runner refuses on its own, without a plan in front of it`,
            unplanned.ran === false && unplanned.code === 'OPTIONAL_CONTENT_UNSAFE', unplanned.reason);
    }

    // ---- 1b. the page's own marked content (RF-IR01-01) ----------------------
    console.log('\n=== 1b. page content left open (RF-IR01-01) ===');
    const mcRefused = corpus.files.filter((f) => f.name.startsWith('mc-') && f.expect !== 'ready');
    for (const f of mcRefused) {
        const unplanned = await call('runUnplanned', f.name, { color: '#ffffff', opacity: 0.5 });
        check(`${f.name}: the runner on its own refuses with ${f.expect} and returns no PDF`,
            unplanned.ran === false && unplanned.code === f.expect && unplanned.reason.includes(f.reason),
            unplanned.reason);
        const facade = await call('facade', f.name, { color: '#ffffff', opacity: 0.5 }, `facade:${f.name}`);
        check(`${f.name}: processLayer refuses with ${f.expect} and returns no PDF`,
            facade.ran === false && facade.code === f.expect, facade.reason);
    }
    const counter = await call('plan', 'mc-unclosed-bdc-off', 'layer');
    check('the counterexample (an OFF layer left open) is refused before anything is written, saying what is open',
        counter.status === 'OPTIONAL_CONTENT_UNSAFE' && counter.reason.includes('閉じていないマーク付きコンテンツ（BMC／BDC）が1個')
        && counter.reason.includes('1ページ目'), counter.reason);
    // Review R1: an inline image's /L or /Length is never trusted. The
    // counterexample (/L 21 over three data bytes) hid an EI and an open BDC.
    const lengthStated = corpus.files.filter((f) => f.name.startsWith('mc-inline-L') || f.name.startsWith('mc-inline-Length'));
    const lengthResults = [];
    for (const f of lengthStated) {
        const plan = await call('plan', f.name, 'layer');
        const scan = await call('scan', f.name);
        lengthResults.push({ name: f.name, ok: plan.status === 'OPTIONAL_CONTENT_UNSAFE' && plan.reason.includes('/L・/Length')
            && scan.ok === false && scan.reason.includes('/L・/Length') });
    }
    check('any /L or /Length is refused, whatever its value and whichever name is used (planner and the check alone)',
        lengthResults.length === 7 && lengthResults.every((r) => r.ok),
        lengthResults.map((r) => `${r.name}:${r.ok ? 'refused' : 'NOT'}`).join(' '));
    const optimizerFacts = await call('planFromDocument', 'mc-nested-ok', 'layer');
    probe('facts that did not read the page content cannot approve 半透明レイヤ追加',
        optimizerFacts.pageContent === 'unchecked' && optimizerFacts.status === 'OPTIONAL_CONTENT_UNSAFE',
        `${optimizerFacts.pageContent} ${optimizerFacts.status}`);
    const fullFacts = await call('plan', 'mc-nested-ok', 'layer');
    check('facts that read it say closed', fullFacts.optionalContent.pageContent === 'closed');
    const bounded = await call('scan', 'mc-decoys-flate-ok', { limit: 512 });
    check('the decode is bounded: past a smaller limit the check refuses instead of reading on',
        bounded.ok === false && bounded.reason.includes('上限'), bounded.reason);
    const cancelled = await call('scan', 'mc-split-contents-ok', { cancelBefore: 2 });
    check('a cancellation between content streams comes out as a cancellation, not a refusal',
        cancelled.threw === true && cancelled.code === 'CANCELLED' && cancelled.streams === 2,
        JSON.stringify(cancelled));
    for (const name of ['mc-nested-ok', 'mc-split-contents-ok', 'mc-decoys-ok', 'mc-decoys-flate-ok', 'mc-inline-ei-in-data-ok']) {
        const scanned = await call('scan', name);
        check(`${name}: the check reads every byte and finds the content closed`,
            scanned.ok === true && scanned.scannedBytes > 0, `${scanned.scannedBytes ?? scanned.reason} B`);
        const key = `${name}-out`;
        const ran = await call('run', name, 'layer', { color: '#ffffff', opacity: 0.5 }, key);
        const s0 = await call('structure', name);
        const s1 = await call('structure', key);
        const kept = JSON.stringify(s1.groups.slice(0, s0.groups.length)) === JSON.stringify(s0.groups)
            && s1.groups.length === s0.groups.length + 1 && s1.groups.at(-1).name === NAME && s1.groups.at(-1).visible
            && JSON.stringify(s1.text) === JSON.stringify(s0.text);
        check(`${name}: runs; existing layers, their states and the text are unchanged`, ran.ran && kept,
            s1.groups.map((g) => `${g.name}:${g.visible}`).join(' | '));
        const pixels = await call('overlay', name, key, NAME, { color: '#ffffff', opacity: 0.5 });
        check(`${name}: off is the page before; on is the overlay`, overlayHolds(pixels), summary(pixels));
        if (s0.groups.length > 0) {
            const flipped = Object.fromEntries(s0.groups.map((g) => [g.name, !g.visible]));
            const pixelsFlipped = await call('overlay', name, key, NAME, { color: '#ffffff', opacity: 0.5, visibility: flipped });
            check(`${name}: every existing layer switched the other way, the new layer still only adds the overlay`,
                overlayHolds(pixelsFlipped), summary(pixelsFlipped));
        }
    }

    // ---- 2. a document without layers, five kinds of page --------------------
    console.log('\n=== 2. no layers before: one new layer over every page ===');
    const src = 'ocg-plain-multi';
    const ranPlain = await call('run', src, 'layer', { color: '#ffffff', opacity: 0.5 }, 'plain-white50');
    check('runs', ranPlain.ran, JSON.stringify(ranPlain));
    const before = await call('structure', src);
    const after = await call('structure', 'plain-white50');
    check('exactly one layer is added, named for what it is, and it starts visible on screen and in print',
        after.groups.length === 1 && after.groups[0].name === NAME && after.groups[0].visible === true
        && after.printGroups.length === 1 && after.printGroups[0].visible === true,
        JSON.stringify(after.groups));
    check('it is listed in the layer order, ON, and neither OFF nor locked',
        after.oc.d.Order === `[OCG(${NAME})]` && after.oc.d.ON === `[OCG(${NAME})]`
        && after.oc.d.OFF === null && after.oc.d.Locked === null, JSON.stringify(after.oc.d));
    const groupRef = after.oc.groupRefs[0];
    const pagesUseOneGroup = after.pages.every((p) => Object.values(p.properties).filter((v) => v.ref === groupRef).length === 1);
    check('every page names the same one group', after.pages.length === 5 && pagesUseOneGroup);
    const onlyOverlayInGroup = after.pages.every((p) => {
        const key = Object.entries(p.properties).find(([, v]) => v.ref === groupRef)[0];
        const marked = p.streams.filter((s) => s.includes(`/OC ${key} BDC`));
        const last = p.streams[p.streams.length - 1];
        // The appended stream is the overlay and nothing else: one filled path
        // in its own graphics state, inside the group's marked content.
        return marked.length === 1 && marked[0] === last
            && /^\/OC \/\w+ BDC\nq\n\/GS-\d+ gs\n[\d. ]+ rg\n[\s\S]*\nh\nf\nQ\nEMC\n$/.test(last)
            && (last.match(/\bBDC\b/g) ?? []).length === 1 && (last.match(/\bEMC\b/g) ?? []).length === 1;
    });
    check('only the appended overlay is inside the group; the page\'s own content is not', onlyOverlayInGroup);
    check('page boxes and rotation are unchanged',
        JSON.stringify(after.pages.map((p) => [p.media, p.crop, p.rotate]))
        === JSON.stringify(before.pages.map((p) => [p.media, p.crop, p.rotate])),
        after.pages.map((p) => `${p.rotate}°`).join(','));
    check('searchable text is unchanged on every page', JSON.stringify(after.text) === JSON.stringify(before.text),
        after.text.map((t) => t.slice(0, 16)).join(' | '));
    check('annotations, the link and the form field are unchanged',
        JSON.stringify(after.pdfjsAnnots) === JSON.stringify(before.pdfjsAnnots)
        && JSON.stringify(after.pages.map((p) => p.annots)) === JSON.stringify(before.pages.map((p) => p.annots))
        && after.pdfjsAnnots[0].some((a) => a.url === 'https://example.invalid/ocg')
        && after.pdfjsAnnots[0].some((a) => a.fieldValue === 'OCG-FIELD-VALUE'),
        after.pdfjsAnnots[0].map((a) => a.subtype).join(','));
    check('metadata is unchanged', JSON.stringify(after.info) === JSON.stringify(before.info));
    // The acceptance condition is about what an annotation tool can pick up:
    // the rectangle is page content inside the group, and no page gains an
    // annotation for it — including the four pages that had none at all.
    check('the overlay is page content, not an annotation: no page gains an /Annots entry',
        JSON.stringify(after.pages.map((p) => p.annots.length)) === JSON.stringify(before.pages.map((p) => p.annots.length))
        && after.pages.slice(1).every((p) => p.annots.length === 0)
        && JSON.stringify(after.pdfjsAnnots.map((list) => list.map((a) => a.subtype)))
            === JSON.stringify(before.pdfjsAnnots.map((list) => list.map((a) => a.subtype))),
        after.pages.map((p) => p.annots.length).join(','));

    const plainPixels = await call('overlay', src, 'plain-white50', NAME, { color: '#ffffff', opacity: 0.5 });
    check('every page: off is the page before, exactly; on is the page with white at 50% over all of it, annotations on top',
        plainPixels.length === 5 && overlayHolds(plainPixels), summary(plainPixels));
    const squareOff = await call('annotationPixels', 'plain-white50', 1, { [NAME]: false });
    const squareOn = await call('annotationPixels', 'plain-white50', 1, { [NAME]: true });
    check('with the layer off, the check-back annotation is still drawn, in its own colour; on, it is not covered',
        JSON.stringify(squareOff) === '[[0,0,255]]' && JSON.stringify(squareOn) === '[[0,0,255]]',
        `off ${JSON.stringify(squareOff)} on ${JSON.stringify(squareOn)}`);

    // ---- 3. colour and opacity at their bounds -------------------------------
    console.log('\n=== 3. colour and opacity ===');
    const cases = [
        ['#ff0000', 0.5], ['#000000', 1], ['#00ff00', 0], ['#123456', 0.1], ['#ffffff', 1], ['zzz', 0.5],
    ];
    for (const [color, opacity] of cases) {
        const key = `plain-${color}-${opacity}`;
        const ran = await call('run', src, 'layer', { color, opacity }, key);
        const expected = /^#?[0-9a-f]{6}$/i.test(color) ? color : '#ffffff';
        const pixels = ran.ran
            ? await call('overlay', src, key, NAME, { color: expected, opacity, pages: [1, 3, 4] }) : [];
        check(`${color} at ${opacity * 100}%: off is the page before; on is ${expected} at that opacity`,
            ran.ran && pixels.length === 3 && overlayHolds(pixels), summary(pixels));
    }
    const outOfRange = await call('run', src, 'layer', { color: '#ffffff', opacity: 1.5 }, 'plain-out-of-range');
    probe('an opacity above 100% produces no file', outOfRange.ran === false, outOfRange.reason?.slice(0, 80));

    // ---- 4. existing layers ---------------------------------------------------
    console.log('\n=== 4. existing layers ===');
    const ex = 'ocg-existing';
    const ranEx = await call('run', ex, 'layer', { color: '#ffffff', opacity: 0.5 }, 'existing-white50');
    const exBefore = await call('structure', ex);
    const exAfter = await call('structure', 'existing-white50');
    const NEW = `${NAME} (2)`;
    check('runs', ranEx.ran, JSON.stringify(ranEx));
    check('the new layer does not take the name of the existing one; it is told apart',
        exAfter.groups.map((g) => g.name).join('|') === ['既存レイヤ A（表示）', '既存レイヤ B（非表示）', NAME, NEW].join('|'),
        exAfter.groups.map((g) => g.name).join(' | '));
    check('existing layers keep their names, their dictionaries and their order in /OCGs',
        JSON.stringify(exAfter.oc.groupDicts.slice(0, 3)) === JSON.stringify(exBefore.oc.groupDicts)
        && JSON.stringify(exAfter.oc.groupRefs.slice(0, 3)) === JSON.stringify(exBefore.oc.groupRefs));
    check('existing layers start as they did: A on, B off, the one named like the overlay on; the new one on',
        JSON.stringify(exAfter.groups.map((g) => g.visible)) === JSON.stringify([true, false, true, true])
        && JSON.stringify(exBefore.groups.map((g) => g.visible)) === JSON.stringify([true, false, true]));
    check('the layer order keeps its nesting and label, with the new layer appended at the end',
        exAfter.oc.d.Order === exBefore.oc.d.Order.replace(/\]$/, `, OCG(${NEW})]`)
        && JSON.stringify(exAfter.order) === JSON.stringify([...exBefore.order, NEW]),
        exAfter.oc.d.Order);
    check('OFF, Locked, AS, the configuration name and the alternate configurations are untouched',
        exAfter.oc.d.OFF === exBefore.oc.d.OFF && exAfter.oc.d.Locked === exBefore.oc.d.Locked
        && exAfter.oc.d.AS === exBefore.oc.d.AS && exAfter.oc.d.Name === exBefore.oc.d.Name
        && exAfter.oc.configs === exBefore.oc.configs && exAfter.oc.configs !== null,
        `Locked ${exAfter.oc.d.Locked} OFF ${exAfter.oc.d.OFF}`);
    check('/ON is added for the new layer only', exBefore.oc.d.ON === null && exAfter.oc.d.ON === `[OCG(${NEW})]`);
    const p1Props = exAfter.pages[0].properties;
    check('the page names it apart from the name already taken; the existing names still mean what they did',
        p1Props['/PATOverlay'].is === `OCG(${NAME})` && p1Props['/PATOverlay1']?.is === `OCG(${NEW})`
        && p1Props['/OCA'].is === 'OCG(既存レイヤ A（表示）)' && p1Props['/OCB'].is === 'OCG(既存レイヤ B（非表示）)',
        Object.keys(p1Props).join(','));
    check('annotations, including the one in layer B, are unchanged',
        JSON.stringify(exAfter.pages.map((p) => p.annots)) === JSON.stringify(exBefore.pages.map((p) => p.annots))
        && JSON.stringify(exAfter.pdfjsAnnots) === JSON.stringify(exBefore.pdfjsAnnots));
    const magentaOff = await call('annotationPixels', 'existing-white50', 1, { [NEW]: false });
    const magentaOn = await call('annotationPixels', 'existing-white50', 1, { [NEW]: true });
    check('existing layers: the annotation outside any layer stays drawn with the new layer off and on',
        JSON.stringify(magentaOff[0]) === '[204,0,204]' && JSON.stringify(magentaOn[0]) === '[204,0,204]',
        `off ${JSON.stringify(magentaOff)} on ${JSON.stringify(magentaOn)}`);
    const exPixels = await call('overlay', ex, 'existing-white50', NEW, { color: '#ffffff', opacity: 0.5 });
    check('as opened: off is the page before; on is the overlay', exPixels.length === 2 && overlayHolds(exPixels),
        summary(exPixels));
    const toggles = [
        ['B shown', { '既存レイヤ B（非表示）': true }],
        ['A hidden', { '既存レイヤ A（表示）': false }],
        [`"${NAME}" (the existing one) hidden`, { [NAME]: false }],
    ];
    for (const [label, visibility] of toggles) {
        const pixels = await call('overlay', ex, 'existing-white50', NEW, { color: '#ffffff', opacity: 0.5, visibility });
        check(`existing layer ${label}: it switches as before, with the new layer off and on`,
            overlayHolds(pixels), summary(pixels));
    }
    const bShown = await call('same', ex, 'existing-white50', 1, { '既存レイヤ B（非表示）': false }, { '既存レイヤ B（非表示）': true, [NEW]: false });
    probe('the comparison sees a layer switched (B hidden vs shown differ)', bShown.sameSize && bShown.diffPixels > 0,
        `${bShown.diffPixels} px`);
    const overlayShown = await call('same', ex, 'existing-white50', 1, {}, { [NEW]: true });
    probe('the comparison sees the overlay (source vs overlay on differ)', overlayShown.diffPixels > 0,
        `${overlayShown.diffPixels} px`);

    // ---- 5. /BaseState /OFF, references, shared resources ---------------------
    console.log('\n=== 5. other layer structures ===');
    for (const [name, existingVisible] of [['ocg-baseoff', true], ['ocg-baseoff-no-on', false]]) {
        const key = `${name}-out`;
        const ran = await call('run', name, 'layer', { color: '#ffffff', opacity: 0.5 }, key);
        const s0 = await call('structure', name);
        const s1 = await call('structure', key);
        check(`${name}: the new layer starts on although the base state is OFF; the existing one is as it was`,
            ran.ran && s1.groups.length === 2 && s1.groups[1].name === NAME && s1.groups[1].visible === true
            && s1.groups[0].visible === existingVisible && s0.groups[0].visible === existingVisible
            && s1.oc.d.BaseState === s0.oc.d.BaseState && s1.oc.d.ON.endsWith(`OCG(${NAME})]`),
            `ON ${s1.oc.d.ON}`);
        const pixels = await call('overlay', name, key, NAME, { color: '#ffffff', opacity: 0.5 });
        check(`${name}: off is the page before; on is the overlay`, overlayHolds(pixels), summary(pixels));
    }
    {
        const ran = await call('run', 'ocg-indirect', 'layer', { color: '#ffffff', opacity: 0.5 }, 'indirect-out');
        const s0 = await call('structure', 'ocg-indirect');
        const s1 = await call('structure', 'indirect-out');
        check('indirect: the same objects are extended in place, never replaced',
            ran.ran && s1.ocPropertiesIndirect && s1.ocPropertiesRef === s0.ocPropertiesRef
            && s1.oc.ocgsRef === s0.oc.ocgsRef && s1.oc.dRef === s0.oc.dRef && s1.oc.orderRef === s0.oc.orderRef
            && s1.oc.d.Intent === s0.oc.d.Intent && s1.groups.at(-1).name === NAME && s1.groups.at(-1).visible,
            `${s1.ocPropertiesRef} ${s1.oc.ocgsRef}`);
        const pixels = await call('overlay', 'ocg-indirect', 'indirect-out', NAME, { color: '#ffffff', opacity: 0.5 });
        check('indirect: off is the page before; on is the overlay', overlayHolds(pixels), summary(pixels));
    }
    {
        const ran = await call('run', 'ocg-shared-resources', 'layer', { color: '#ffffff', opacity: 0.5 }, 'shared-out');
        const s1 = await call('structure', 'shared-out');
        const ref = s1.oc.groupRefs[0];
        check('shared resources: both pages name the one group',
            ran.ran && s1.pages.length === 2
            && s1.pages.every((p) => Object.values(p.properties).filter((v) => v.ref === ref).length === 1));
        const pixels = await call('overlay', 'ocg-shared-resources', 'shared-out', NAME, { color: '#ffffff', opacity: 0.5 });
        check('shared resources: off is the page before; on is the overlay', overlayHolds(pixels), summary(pixels));
    }

    // ---- 6. saved again, and printed -------------------------------------------
    console.log('\n=== 6. save, reopen and print ===');
    for (const [key, source, layer] of [['plain-white50', src, NAME], ['existing-white50', ex, NEW]]) {
        await call('resave', key, `${key}-resaved`);
        const s = await call('structure', `${key}-resaved`);
        const g = s.groups.find((x) => x.name === layer);
        check(`${source}: saved again by another program and reopened, the layer is still there and still on`,
            g?.visible === true && s.oc.d.Order.endsWith(`OCG(${layer})]`));
        const pixels = await call('overlay', source, `${key}-resaved`, layer, { color: '#ffffff', opacity: 0.5 });
        check(`${source}: after reopening, off is the page before; on is the overlay`, overlayHolds(pixels), summary(pixels));
    }
    for (const [key, source, layer] of [['plain-#ff0000-0.5', src, NAME], ['existing-white50', ex, NEW]]) {
        const color = key.includes('ff0000') ? '#ff0000' : '#ffffff';
        const pixels = await call('overlay', source, key, layer, { color, opacity: 0.5, intent: 'print' });
        check(`${source}: printed, the layer is on by default and off prints the page before`,
            overlayHolds(pixels), summary(pixels));
    }

    // ---- 7. 両方実行 -------------------------------------------------------------
    console.log('\n=== 7. 両方実行 ===');
    const bothPlan = await call('plan', src, 'both');
    check('両方実行 still asks before replacing pages with pictures', bothPlan.status === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION');
    const mono = await call('run', src, 'monochrome', null, 'plain-mono');
    const both = await call('run', src, 'both', { color: '#ffffff', opacity: 0.5 }, 'plain-both');
    const bothS = await call('structure', 'plain-both');
    check('両方実行 gets the same switchable layer', mono.ran && both.ran
        && bothS.groups.length === 1 && bothS.groups[0].name === NAME && bothS.groups[0].visible === true);
    const bothPixels = await call('overlay', 'plain-mono', 'plain-both', NAME, { color: '#ffffff', opacity: 0.5 });
    check('両方実行 with the layer off is the monochrome pages — not the source', overlayHolds(bothPixels, 0.97),
        summary(bothPixels));
    const notSource = await call('same', src, 'plain-both', 1, {}, { [NAME]: false });
    probe('両方実行 with the layer off differs from the coloured source', notSource.diffPixels > 0, `${notSource.diffPixels} px`);

    // ---- samples for a person ---------------------------------------------------
    if (process.env.OCG_SAMPLE_DIR) {
        const dir = path.resolve(process.env.OCG_SAMPLE_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const samples = [
            ['plain-white50', '01_layer-white50_5pages.pdf'],
            ['existing-white50', '02_layer-white50_existing-layers.pdf'],
            ['plain-#ff0000-0.5', '03_layer-red50_5pages.pdf'],
            ['plain-both', '04_both-white50_monochrome.pdf'],
        ];
        for (const [key, file] of samples) {
            fs.writeFileSync(path.join(dir, file), Buffer.from(await call('bytes', key)));
        }
        fs.copyFileSync(path.join(ROOT, 'test-fixtures', 'processor-ocg', 'ocg-plain-multi.pdf'), path.join(dir, '00_source_5pages.pdf'));
        fs.copyFileSync(path.join(ROOT, 'test-fixtures', 'processor-ocg', 'ocg-existing.pdf'), path.join(dir, '00_source_existing-layers.pdf'));
        console.log(`\n  ----  samples written to ${dir}`);
    }

    check('no request left this machine', external.length === 0, external.slice(0, 3).join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(error);
    exitCode = 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
