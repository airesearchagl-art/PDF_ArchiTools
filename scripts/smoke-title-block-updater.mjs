/**
 * Deterministic smoke verification for 図枠一括更新 (title-block batch update).
 *
 * Drives the production module in a real browser against synthetic fixtures and
 * reads every result back through PDF.js, so the checks see what a viewer sees.
 * Small on purpose: this is a gate, not a test framework. Exits non-zero if any
 * check fails.
 *
 * Run:  node scripts/smoke-title-block-updater.mjs   (fixtures are generated on demand)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5184;
const ORIGIN = `http://localhost:${PORT}`;

// Regenerate the fixtures when they are absent, so the whole gate is one command.
if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'tb-portrait.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-titleblock-fixtures.mjs')], { stdio: 'inherit' });
}

/** Restated here so the gate does not read its expectations from the module. */
const FIELDS = {
    status: { x: 0.720, y: 0.828, width: 0.240, height: 0.060 },
    date: { x: 0.720, y: 0.900, width: 0.240, height: 0.050 },
};
const NEW_STATUS = '竣工図';
const NEW_DATE = '2026.09.04';
const OLD_STATUS = '実施設計図';
const OLD_DATE = '2026.03.15';

const RULES_BOTH = [
    { rect: FIELDS.status, text: NEW_STATUS },
    { rect: FIELDS.date, text: NEW_DATE },
];
const RULES_DATE_ONLY = [{ rect: FIELDS.date, text: NEW_DATE }];

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const round = (v, d = 2) => Number(v.toFixed(d));

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
    } catch { /* opaque */ }
});
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Shape checks every run has to satisfy: nothing about the page may move. */
function assertStructure(run, tag) {
    const { before, after } = run;
    check(`${tag}: page count unchanged`, before.numPages === after.numPages,
        `${before.numPages} -> ${after.numPages}`);
    for (let i = 0; i < after.pages.length; i++) {
        const b = before.pages[i];
        const a = after.pages[i];
        check(`${tag} p${i + 1}: page size unchanged`,
            Math.abs(a.widthPt - b.widthPt) < 0.001 && Math.abs(a.heightPt - b.heightPt) < 0.001
            && Math.abs(a.mediaBox.width - b.mediaBox.width) < 0.001,
            `${round(b.widthPt)}x${round(b.heightPt)} -> ${round(a.widthPt)}x${round(a.heightPt)}`);
        check(`${tag} p${i + 1}: /Rotate unchanged`, a.rotate === b.rotate, `${b.rotate} -> ${a.rotate}`);
        check(`${tag} p${i + 1}: no full-page rasterisation`, a.imageOps === b.imageOps,
            `image ${b.imageOps} -> ${a.imageOps}`);
    }
}

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-titleblock-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__tbSmoke?.ready === true, { timeout: 120000 });

    const runs = {};
    const doRun = async (key, name, rules, orientation, diffPages = [1]) => {
        console.log(`\n=== ${name} ===`);
        const r = await page.evaluate((n, ru, o, dp) => window.__tbSmoke.run(n, ru, o, dp),
            name, rules, orientation, diffPages);
        runs[key] = r;
        for (const p of r.summary.pages) {
            console.log(`  p${p.pageNumber}: ${round(p.widthPt)}x${round(p.heightPt)} rot=${p.rotation} ${p.orientation} sizes=${p.applied.map((a) => round(a.fontSize, 1)).join('/')}`);
        }
        for (const d of r.diffs) {
            console.log(`  diff p${d.page}: inside=${d.inside} outside=${d.outside} canvas=${JSON.stringify(d.canvas)} samples=${JSON.stringify(d.outsideSamples)}`);
        }
        console.log(`  jpFont=${r.summary.embeddedJapaneseFont}  ${r.inputBytes} -> ${r.outputBytes} bytes`);
        return r;
    };

    await doRun('a1', 'tb-a1.pdf', RULES_BOTH, 'landscape');
    await doRun('a3', 'tb-a3.pdf', RULES_BOTH, 'landscape');
    await doRun('mixed', 'tb-mixed.pdf', RULES_BOTH, 'landscape', [1, 2, 3, 4, 5]);
    await doRun('rotated', 'tb-rotated.pdf', RULES_BOTH, 'landscape');
    await doRun('scanned', 'tb-scanned.pdf', RULES_BOTH, 'landscape');
    await doRun('searchable', 'tb-searchable.pdf', RULES_BOTH, 'landscape');
    await doRun('dateOnly', 'tb-a1.pdf', RULES_DATE_ONLY, 'landscape');
    await doRun('rot180', 'tb-rot180.pdf', RULES_BOTH, 'landscape');
    await doRun('rot270', 'tb-rot270.pdf', RULES_BOTH, 'landscape');
    await doRun('portrait', 'tb-portrait.pdf', RULES_BOTH, 'portrait');

    console.log('\n=== checks ===');
    for (const [key, tag] of [
        ['a1', 'A1'], ['a3', 'A3'], ['mixed', 'mixed'], ['rotated', 'rotated'],
        ['scanned', 'scanned'], ['searchable', 'searchable'], ['dateOnly', 'date-only'],
        ['rot180', 'rot180'], ['rot270', 'rot270'], ['portrait', 'portrait'],
    ]) {
        assertStructure(runs[key], tag);
    }

    // ---- only the selected regions may change ------------------------------
    console.log('\n=== visual containment ===');
    for (const [key, tag] of [
        ['a1', 'A1'], ['a3', 'A3'], ['rotated', 'rotated'], ['scanned', 'scanned'],
        ['searchable', 'searchable'], ['dateOnly', 'date-only'],
        ['rot180', 'rot180'], ['rot270', 'rot270'], ['portrait', 'portrait'],
    ]) {
        const d = runs[key].diffs[0];
        check(`${tag}: nothing outside the selected regions changed`, d.outside === 0,
            `outside=${d.outside} samples=${JSON.stringify(d.outsideSamples)}`);
        check(`${tag}: the selected regions did change`, d.inside > 200, `inside=${d.inside}`);
    }
    for (const d of runs.mixed.diffs) {
        check(`mixed p${d.page}: nothing outside the selected regions changed`, d.outside === 0,
            `outside=${d.outside} samples=${JSON.stringify(d.outsideSamples)}`);
        check(`mixed p${d.page}: the selected regions did change`, d.inside > 200, `inside=${d.inside}`);
    }

    // ---- the replacement text is really there ------------------------------
    console.log('\n=== replacement text ===');
    const a1After = runs.a1.after.pages[0].text;
    console.log(`  A1 before: ${JSON.stringify(runs.a1.before.pages[0].text)}`);
    console.log(`  A1 after : ${JSON.stringify(a1After)}`);
    check('Japanese replacement is written and extractable', a1After.includes(NEW_STATUS),
        JSON.stringify(a1After.slice(0, 60)));
    check('date replacement is written and extractable', a1After.includes(NEW_DATE));
    check('both rules were applied to every page',
        runs.mixed.summary.pages.every((p) => p.applied.length === 2),
        runs.mixed.summary.pages.map((p) => p.applied.length).join(','));
    check('a single rule applies only once',
        runs.dateOnly.summary.ruleCount === 1
        && runs.dateOnly.summary.pages.every((p) => p.applied.length === 1));
    check('date-only run leaves the status field alone',
        runs.dateOnly.after.pages[0].text.includes(OLD_STATUS)
        && runs.dateOnly.after.pages[0].text.includes(NEW_DATE));

    // ---- A1 / A3 land at the same relative place ---------------------------
    console.log('\n=== A1 / A3 consistency ===');
    const relativeInk = (run, pageIndex) => {
        const p = run.summary.pages[pageIndex];
        return p.applied.map((a) => round(a.fontSize / p.heightPt, 5));
    };
    console.log(`  A1 relative sizes: ${JSON.stringify(relativeInk(runs.a1, 0))}`);
    console.log(`  A3 relative sizes: ${JSON.stringify(relativeInk(runs.a3, 0))}`);
    check('A1 and A3 scale the replacement by the same fraction of the sheet',
        JSON.stringify(relativeInk(runs.a1, 0)) === JSON.stringify(relativeInk(runs.a3, 0)),
        `${JSON.stringify(relativeInk(runs.a1, 0))} vs ${JSON.stringify(relativeInk(runs.a3, 0))}`);
    const mixedRel = runs.mixed.summary.pages.map((_, i) => JSON.stringify(relativeInk(runs.mixed, i)));
    check('every page of the mixed document gets the same relative treatment',
        new Set(mixedRel).size === 1, mixedRel.join(' | '));
    check('mixed document really does contain both paper sizes',
        new Set(runs.mixed.before.pages.map((p) => round(p.widthPt))).size === 2,
        runs.mixed.before.pages.map((p) => round(p.widthPt)).join(','));

    // ---- rotation ------------------------------------------------------------
    console.log('\n=== rotation ===');
    const rot = runs.rotated;
    check('rotated fixture really carries /Rotate 90', rot.before.pages[0].rotate === 90);
    check('rotated page is displayed landscape', rot.before.pages[0].widthPt > rot.before.pages[0].heightPt);
    check('rotated page: replacement text is written', rot.after.pages[0].text.includes(NEW_STATUS));
    const cross = await page.evaluate((r) => window.__tbSmoke.crossCompare('tb-a1.pdf', 'tb-rotated.pdf', r, 'landscape'), RULES_BOTH);
    console.log(`  rotated vs flat: before ${JSON.stringify(cross.before)}`);
    console.log(`  rotated vs flat: after  ${JSON.stringify(cross.after)}`);
    // The rotated fixture is drawn to look exactly like the flat one, so the two
    // renders agreeing after the update is what proves the region landed where
    // the user drew it rather than somewhere a rotation got mishandled.
    check('rotated fixture is drawn to look like the flat one',
        cross.before.sizeMismatch === false && cross.before.diff / cross.before.total < 0.01,
        `diff=${cross.before.diff}/${cross.before.total}`);
    check('the update lands in the same place on a rotated page as on a flat one',
        cross.after.sizeMismatch === false && cross.after.diff / cross.after.total < 0.01,
        `diff=${cross.after.diff}/${cross.after.total}`);
    check('rotated page: MediaBox is untouched',
        Math.abs(rot.after.pages[0].mediaBox.width - rot.before.pages[0].mediaBox.width) < 0.001
        && Math.abs(rot.after.pages[0].mediaBox.height - rot.before.pages[0].mediaBox.height) < 0.001);

    // ---- vector / OCR preservation -------------------------------------------
    console.log('\n=== preservation ===');
    const a1 = runs.a1;
    check('vector page stays vector: only the two masks are added',
        a1.after.pages[0].pathOps === a1.before.pages[0].pathOps + 2
        && a1.after.pages[0].imageOps === 0,
        `path ${a1.before.pages[0].pathOps} -> ${a1.after.pages[0].pathOps}`);
    check('existing page text survives alongside the replacement',
        a1.after.pages[0].text.includes('TITLE BLOCK'));
    const sc = runs.scanned;
    check('scanned page keeps its single image', sc.before.pages[0].imageOps === 1 && sc.after.pages[0].imageOps === 1);
    const se = runs.searchable;
    check('searchable page keeps its invisible text layer',
        se.before.pages[0].text.includes(OLD_STATUS) && se.after.pages[0].text.includes(OLD_STATUS));
    check('searchable page gains the replacement text too', se.after.pages[0].text.includes(NEW_STATUS));
    const classified = await page.evaluate((r) => window.__tbSmoke.classify('tb-searchable.pdf', r, 'landscape'), RULES_BOTH);
    console.log(`  classify before: ${classified.before.map((c) => `${c.kind}(interior=${c.interiorChars})`).join(', ')}`);
    console.log(`  classify after : ${classified.after.map((c) => `${c.kind}(interior=${c.interiorChars})`).join(', ')}`);
    check('M1 still reads the updated OCR output as text-native',
        classified.after.every((c) => c.kind === 'text-native'), classified.after.map((c) => c.kind).join(','));

    // ---- the documented limitation, measured rather than assumed -------------
    console.log('\n=== known limitation: this is not redaction ===');
    console.log(`  A1 after text: ${JSON.stringify(a1After)}`);
    check('the old title-block text is STILL extractable after the update',
        a1After.includes(OLD_STATUS) && a1After.includes(OLD_DATE),
        `old status present=${a1After.includes(OLD_STATUS)} old date present=${a1After.includes(OLD_DATE)}`);
    check('the old text is nevertheless not visible', runs.a1.diffs[0].outside === 0);

    // ---- fail-closed ----------------------------------------------------------
    console.log('\n=== orientation mismatch ===');
    const refused = await page.evaluate((r) => window.__tbSmoke.errorProbe('tb-portrait-mix.pdf', r, 'landscape'), RULES_BOTH);
    console.log(`  ${JSON.stringify(refused)}`);
    check('a page whose orientation differs from the template is refused',
        refused.threw === true && refused.code === 'orientation-mismatch');
    check('the refusal names the page and is user-facing Japanese',
        typeof refused.message === 'string' && refused.message.includes('2ページ目')
        && refused.message.includes('縦横方向'), refused.message?.slice(0, 50));

    const tooLong = await page.evaluate(() => window.__tbSmoke.errorProbe('tb-a1.pdf', [{
        rect: { x: 0.72, y: 0.9, width: 0.02, height: 0.004 },
        text: 'この文字列は指定した領域に対して明らかに長すぎます',
    }], 'landscape'));
    console.log(`  ${JSON.stringify(tooLong)}`);
    check('text that cannot fit legibly is refused instead of shrunk to nothing',
        tooLong.threw === true && tooLong.code === 'text-too-long');

    // ---- font / size behaviour -------------------------------------------------
    console.log('\n=== font handling ===');
    check('a Japanese replacement embeds the Japanese face', runs.a1.summary.embeddedJapaneseFont === true);
    const asciiOnly = await page.evaluate((r) => window.__tbSmoke.run('tb-a1.pdf', r, 'landscape'), RULES_DATE_ONLY);
    check('an ASCII-only replacement does not embed it', asciiOnly.summary.embeddedJapaneseFont === false);
    console.log(`  japanese run : ${runs.a1.inputBytes} -> ${runs.a1.outputBytes} bytes`);
    console.log(`  ascii run    : ${asciiOnly.inputBytes} -> ${asciiOnly.outputBytes} bytes`);
    check('the ASCII run is not inflated by a font embed',
        asciiOnly.outputBytes < asciiOnly.inputBytes + 50_000,
        `${asciiOnly.inputBytes} -> ${asciiOnly.outputBytes}`);

    // ---- RF1: the PDF.js worker stays same-origin --------------------------------
    console.log('\n=== PDF.js worker source ===');
    const worker = await page.evaluate(() => window.__tbSmoke.workerProbe());
    console.log(`  ${JSON.stringify(worker)}`);
    check('the app really can have its worker global hijacked to a CDN',
        worker.hijacked.startsWith('https://unpkg.com/'), worker.hijacked);
    check('RF1: point-of-use configuration takes it back to same-origin',
        worker.restored === worker.expected && worker.restored === '/pdf.worker.min.mjs',
        worker.restored);
    check('RF1: the import-time default is already same-origin',
        worker.before === worker.expected, worker.before);

    // ---- RF1 / rotation quadrants -------------------------------------------------
    console.log('\n=== all rotation quadrants land alike ===');
    for (const [fixture, label] of [
        ['tb-rotated.pdf', '/Rotate 90'],
        ['tb-rot180.pdf', '/Rotate 180'],
        ['tb-rot270.pdf', '/Rotate 270'],
    ]) {
        const cross = await page.evaluate((f, r) => window.__tbSmoke.crossCompare('tb-a1.pdf', f, r, 'landscape'),
            fixture, RULES_BOTH);
        console.log(`  ${label}: before ${cross.before.diff}/${cross.before.total}  after ${cross.after.diff}/${cross.after.total}`);
        check(`${label}: fixture is drawn to look like the flat sheet`,
            cross.before.sizeMismatch === false && cross.before.diff / cross.before.total < 0.01,
            `${cross.before.diff}/${cross.before.total}`);
        check(`${label}: the update lands in the same place as on a flat sheet`,
            cross.after.sizeMismatch === false && cross.after.diff / cross.after.total < 0.01,
            `${cross.after.diff}/${cross.after.total}`);
    }

    // ---- portrait representative --------------------------------------------------
    console.log('\n=== portrait representative ===');
    const por = runs.portrait;
    check('portrait fixture really is portrait',
        por.before.pages[0].heightPt > por.before.pages[0].widthPt
        && por.before.pages[0].orientation === 'portrait');
    check('portrait sheet takes the replacement', por.after.pages[0].text.includes(NEW_STATUS));
    const wrongOrientation = await page.evaluate((r) => window.__tbSmoke.errorProbe('tb-portrait.pdf', r, 'landscape'), RULES_BOTH);
    console.log(`  landscape rules on a portrait sheet: ${JSON.stringify(wrongOrientation)}`);
    check('a portrait sheet is refused when the template was landscape',
        wrongOrientation.threw === true && wrongOrientation.code === 'orientation-mismatch',
        JSON.stringify(wrongOrientation));

    // ---- environment ------------------------------------------------------------
    console.log('\n=== environment ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external request during the update', uniqueExternal.length === 0, `${uniqueExternal.length} external`);
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
        path.join(ROOT, 'test-fixtures', 'smoke-titleblock-results.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), checks, external: [...new Set(external)], pageErrors }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
