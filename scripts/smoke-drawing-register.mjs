/**
 * The drawing register, exercised against the production modules.
 *
 * This drives `src/utils/pdf-textifier/drawing-register*.ts` in a real browser
 * over a deterministic synthetic set, and asserts the things the architecture
 * committed to: one row per page whatever happens to it, a source chosen per
 * field, regions rendered upright and never a whole sheet, a review surface
 * that holds every row, and an export that refuses anything unconfirmed.
 *
 * Several assertions are negative probes -- the same code fed input that must
 * make it fail. A rotation fix that is never broken on purpose is a claim
 * rather than a result, and an export gate that is never asked to refuse has
 * not been shown to.
 *
 * Run:  node scripts/make-drawing-register-fixtures.mjs
 *       node scripts/smoke-drawing-register.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'drawing-register');
const PORT = 5191;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIX, 'drawing-register.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-drawing-register-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check whose whole value is that it fails when the thing it guards breaks. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

// Everything the page and its workers fetch, so "browser-local" is measured.
const external = [];
const ocrAssets = new Set();
const pageErrors = [];
page.on('requestfinished', (request) => {
    const url = request.url();
    if (!url.startsWith(ORIGIN) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
    if (url.startsWith(`${ORIGIN}/ocr/`)) ocrAssets.add(url.slice(ORIGIN.length));
});
page.on('pageerror', (error) => pageErrors.push(String(error)));
browser.on('targetcreated', async (target) => {
    if (target.type() !== 'worker' && target.type() !== 'service_worker') return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', ({ request }) => {
            const url = request.url;
            if (!url.startsWith(ORIGIN) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
            if (url.startsWith(`${ORIGIN}/ocr/`)) ocrAssets.add(url.slice(ORIGIN.length));
        });
    } catch { /* a worker that died before we attached tells us nothing */ }
});

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-drawing-register-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__registerReady === true, { timeout: 180000 });

    const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'drawing-register.truth.json'), 'utf8'));
    const pageCount = await page.evaluate(() => window.__register.pageCount());

    console.log('\n=== the set ===');
    check('every fixture page is in the document', pageCount === truth.pages.length,
        `${pageCount} pages`);
    const segMode = await page.evaluate(() => window.__register.REGISTER_PAGE_SEG_MODE);
    check('the register asks for single-block segmentation explicitly',
        segMode === '6', `tessedit_pageseg_mode=${JSON.stringify(segMode)}`);

    // ---- native tokens on a page the table path calls scanned ---------------
    console.log('\n=== field-level source, on pages a page-level switch gets wrong ===');
    const stampPage = truth.pages.find((p) => p.kind === 'stamp').page;
    const stampGeom = await page.evaluate((n) => window.__register.geometry(n), stampPage);
    const nativeFields = Object.entries(stampGeom.fieldText).filter(([, text]) => text.trim() !== '');
    check('the register sees the vector drawing number on the raster sheet',
        nativeFields.length === 1 && nativeFields[0][0] === 'drawing_number',
        `native fields: ${nativeFields.map(([f]) => f).join(', ') || 'none'}`);

    // The page that separates the two paths. Its only text sits in the margin,
    // so the classifier calls it scanned -- and the table path, which fails
    // closed on exactly that, hands back nothing. The register needs those
    // tokens: they are the four values.
    const marginPage = truth.pages.find((p) => p.kind === 'marginstamp').page;
    const marginGeom = await page.evaluate((n) => window.__register.geometry(n), marginPage);
    const marginTable = await page.evaluate((n) => window.__register.tableGeometry(n), marginPage);
    check('a sheet whose only text is in the margin is classified scanned',
        marginGeom.scanned === true && marginTable.scanned === true,
        `interior chars ${marginGeom.interiorChars}, all chars ${marginGeom.allChars}`);
    probe('the table path withholds every token from it, as it always has',
        marginTable.tokens === 0, 'M2-4 fail-closed behaviour is unchanged');
    check('the register reads all four fields from it anyway',
        Object.values(marginGeom.fieldText).filter((t) => t.trim() !== '').length === 4,
        `${marginGeom.tokens} tokens the table path would not have shown`);

    // ---- rotation -----------------------------------------------------------
    console.log('\n=== scanned regions, through every rotation ===');
    const rotatedScanned = truth.pages.filter((p) => p.kind === 'scanned' && p.rotate !== 0);
    let rotatedHits = 0;
    for (const p of rotatedScanned) {
        const run = await page.evaluate((n) => window.__register.recognise(n), p.page);
        const hits = Object.values(run.fields).filter((f) => f.found).length;
        rotatedHits += hits;
        check(`/Rotate ${String(p.rotate).padStart(3)} reads its fields`, hits >= 3, `${hits}/4`);
    }
    let wrongHits = 0;
    for (const p of rotatedScanned) {
        const run = await page.evaluate((n, r) => window.__register.recognise(n, { rotation: r }), p.page, p.rotate);
        wrongHits += Object.values(run.fields).filter((f) => f.found).length;
    }
    probe('rendering those regions through the page rotation reads nothing',
        wrongHits === 0,
        `${wrongHits}/${rotatedScanned.length * 4} fields -- the crop is right and the glyphs are sideways`);
    check('so the un-rotation is what makes the rotated pages readable',
        rotatedHits > wrongHits, `${rotatedHits} upright vs ${wrongHits} rotated`);

    // ---- the largest sheet --------------------------------------------------
    console.log('\n=== the largest sheet is never rasterised whole ===');
    const a0 = truth.pages.find((p) => p.size === 'A0').page;
    const cost = await page.evaluate((n) => window.__register.regionCost(n), a0);
    check('the region is a small fraction of the A0 sheet',
        cost.region.pixels / cost.fullPage.pixels < 0.05,
        `${(cost.region.pixels / 1e6).toFixed(2)} of ${(cost.fullPage.pixels / 1e6).toFixed(1)} Mpx`
        + ` (${((cost.region.pixels / cost.fullPage.pixels) * 100).toFixed(2)}%)`);
    probe('the full A0 page really would be too large to hold',
        cost.fullPage.pixels > 100e6,
        `${(cost.fullPage.pixels / 1e6).toFixed(1)} Mpx = ${(cost.fullPage.pixels * 4 / 1e6).toFixed(0)} MB of RGBA`);

    // ---- the whole document -------------------------------------------------
    console.log('\n=== the whole document, end to end ===');
    const run = await page.evaluate(() => window.__register.extract());
    check('one row per page', run.rows.length === pageCount, `${run.rows.length} rows for ${pageCount} pages`);
    check('no page number is missing',
        truth.pages.every((p) => run.rows.some((r) => r.pageNumber === p.page)));
    check('every row starts unconfirmed',
        run.rows.every((r) => r.reviewStatus === 'unconfirmed'));

    // Accuracy is reported by source, because the two are not the same kind of
    // claim. Reading a field out of the text layer is deterministic and must be
    // exact every time. Recognising one from an image is not: the fixture's
    // raster pages are rendered by the local browser, and Tesseract's output
    // moves by a field or two between platforms. A single blended percentage
    // hides that, and a threshold on it is a coin toss on somebody else's CI.
    const norm = (s) => String(s ?? '').replace(/\s+/gu, '');
    const bySource = { native: { hit: 0, total: 0 }, ocr: { hit: 0, total: 0 }, none: { hit: 0, total: 0 } };
    const missed = [];
    for (const row of run.rows) {
        for (const field of Object.keys(row.fields)) {
            const want = row.expected[field] ?? '';
            if (want === '') continue;
            const source = row.fields[field].source;
            const bucket = bySource[source] ?? bySource.none;
            bucket.total += 1;
            if (norm(row.fields[field].value).includes(norm(want))) bucket.hit += 1;
            else missed.push(`p${row.pageNumber}.${field}[${source}] wanted ${JSON.stringify(want)} got ${JSON.stringify(row.fields[field].value)}`);
        }
    }
    check('every field read from the text layer is exact',
        bySource.native.hit === bySource.native.total,
        `${bySource.native.hit}/${bySource.native.total} native fields`);
    check('most fields recognised from an image are right too',
        bySource.ocr.total > 0 && bySource.ocr.hit / bySource.ocr.total >= 0.7,
        `${bySource.ocr.hit}/${bySource.ocr.total} recognised fields`);
    probe('both paths were actually exercised, so neither number is vacuous',
        bySource.native.total > 10 && bySource.ocr.total > 10,
        `${bySource.native.total} native, ${bySource.ocr.total} recognised`);
    if (missed.length > 0) console.log(`        missed: ${missed.join('; ')}`);

    const mixed = run.rows.find((r) => r.pageNumber === stampPage);
    const sources = new Set(Object.values(mixed.fields).map((f) => f.source));
    check('the mixed-source page keeps a source per field',
        sources.size > 1 && mixed.extraction === 'mixed',
        Object.entries(mixed.fields).map(([f, v]) => `${f}=${v.source}`).join(' '));
    probe('a row-level summary alone could not say which field came from where',
        mixed.extraction === 'mixed' && sources.has('native') && sources.has('ocr'));

    const marginRow = run.rows.find((r) => r.pageNumber === marginPage);
    check('the margin-strip page is read natively, field by field',
        marginRow.extraction === 'native'
        && Object.values(marginRow.fields).every((f) => f.source === 'native'),
        `extraction=${marginRow.extraction}`);
    probe('a page-level switch would have sent that page to OCR and found nothing there',
        marginGeom.scanned === true && marginRow.extraction === 'native',
        'classified scanned, read from its text layer');

    const ocrLayerPage = truth.pages.find((p) => p.kind === 'ocrlayer').page;
    const ocrLayerRow = run.rows.find((r) => r.pageNumber === ocrLayerPage);
    check('a sheet under an invisible text layer is read from that layer',
        ocrLayerRow.extraction === 'native', `extraction=${ocrLayerRow.extraction}`);

    // ---- unassigned pages ---------------------------------------------------
    console.log('\n=== a page nobody assigned ===');
    const partial = await page.evaluate(() => window.__register.extract({ skipLayoutB: true }));
    const layoutB = truth.pages.filter((p) => p.layout === 'B').map((p) => p.page);
    const sameSizeAssigned = truth.pages
        .filter((p) => p.size === 'A2' && p.layout === 'A').map((p) => p.page);
    check('it still produces a row', partial.rows.length === pageCount,
        `${partial.rows.length} rows with ${layoutB.length} page(s) unassigned`);
    const unassignedRows = partial.rows.filter((r) => layoutB.includes(r.pageNumber));
    check('with no profile and its own reason',
        unassignedRows.every((r) => r.profileId === null && r.extraction === 'unassigned'
            && r.reasons.some((reason) => reason.includes('プロファイル'))),
        unassignedRows.map((r) => `p${r.pageNumber}:${r.extraction}`).join(' '));
    probe('it is not quietly given the profile of the same-size pages',
        unassignedRows.every((r) => Object.values(r.fields).every((f) => f.value === '')),
        `pages ${layoutB.join(', ')} share A2 with assigned pages ${sameSizeAssigned.join(', ')}`);
    check('and the assignment set reports them as unassigned',
        partial.unassignedInput.join(',') === layoutB.join(','),
        `unassigned: ${partial.unassignedInput.join(', ')}`);

    const assign = await page.evaluate(() => window.__register.assignmentChecks());
    probe('assigning over an existing assignment reports a conflict instead of overwriting',
        assign.conflictReported === assign.sameSizeAssigned.length && assign.conflictAssigned === 0,
        `${assign.conflictReported} conflict(s)`);
    check('an explicit reassignment does go through', assign.reassigned === assign.sameSizeAssigned.length);
    check('a page with no assignment resolves to null, not to the only profile there is',
        assign.lookupOnUnassigned.every((entry) => entry === null));
    probe('a profile missing a rectangle cannot be built',
        assign.missingWhenIncomplete.length === 3 && assign.missingWhenComplete.length === 0,
        `missing: ${assign.missingWhenIncomplete.join(', ')}`);
    check('a page range past the end of the document is reported, not silently dropped',
        assign.range.errors.length === 1 && assign.range.pages.length === 4,
        `${assign.range.pages.join(', ')} + ${assign.range.errors.length} error(s)`);

    // ---- the review surface -------------------------------------------------
    console.log('\n=== every row reaches a person ===');
    check('the review surface holds one entry per page',
        run.surface.length === pageCount, `${run.surface.length} of ${pageCount}`);
    check('the attention queue is a strict subset',
        run.attention.length < run.surface.length,
        `${run.attention.length} flagged of ${run.surface.length}`);
    const unflagged = run.surface.filter((e) => !e.needsAttention);
    probe('rows with nothing flagged are still on the surface, unconfirmed',
        unflagged.length > 0 && unflagged.every((e) => e.reviewStatus === 'unconfirmed'),
        `${unflagged.length} unflagged row(s) a flag-filtered list would hide`);
    check('the duplicate drawing number is found',
        run.duplicates.length === 1 && run.duplicates[0].pages.length === 2,
        run.duplicates.map((d) => `${d.number} on ${d.pages.join(' and ')}`).join('; '));

    // ---- raw text -----------------------------------------------------------
    console.log('\n=== rawText is what extraction said, unchanged ===');
    const raw = await page.evaluate(() => window.__register.rawTextContract());
    check('leading and trailing whitespace survives into the row',
        raw.stored === raw.input, JSON.stringify(raw.stored));
    check('the display value is still clean', raw.display === 'A-101');
    probe('a different display rule changes the value and not the raw text',
        raw.otherPolicyValue === raw.input && raw.otherPolicyRaw === raw.stored
        && raw.otherPolicyValue !== raw.display);
    probe('an edit changes the value and not the raw text',
        raw.afterEditRaw === raw.input && raw.afterEditValue === 'A-108');
    check('confirmation records raw, proposed and final',
        raw.recordRaw === raw.input && raw.recordProposed === 'A-101'
        && raw.recordFinal === 'A-108' && raw.edited.join() === 'drawing_number');

    // ---- export -------------------------------------------------------------
    console.log('\n=== nothing is exported until every row is confirmed ===');
    const exp = await page.evaluate(() => window.__register.exportChecks());
    check('a register of unconfirmed rows is not ready', exp.before.ready === false, exp.before.reason);
    probe('and calling the export function directly is refused',
        typeof exp.refusedUnconfirmed === 'string', exp.refusedUnconfirmed || 'IT RETURNED A WORKBOOK');
    probe('one unconfirmed row out of three is still refused',
        typeof exp.refusedOneUnconfirmed === 'string', exp.refusedOneUnconfirmed || 'IT RETURNED A WORKBOOK');
    probe('a register missing a page is refused even when every row it has is confirmed',
        typeof exp.refusedMissingPage === 'string', exp.refusedMissingPage || 'IT RETURNED A WORKBOOK');
    check('with every row confirmed it is ready',
        exp.ready.ready === true && exp.ready.confirmed === exp.ready.pageCount,
        `${exp.ready.confirmed}/${exp.ready.pageCount}`);
    probe('invalidating a confirmed row takes the confirmation away with it',
        exp.invalidated.status === 'unconfirmed' && exp.invalidated.hadConfirmation === false);
    check('confirmation leaves the raw text alone',
        exp.rawAfterConfirm === '図面番号\n001', JSON.stringify(exp.rawAfterConfirm));

    console.log('\n=== a complete, confirmed register that is still wrong ===');
    const shape = await page.evaluate(() => window.__register.exportShapeChecks());
    check('the control case does produce a workbook',
        shape.control.ready === true && shape.control.bytes > 0,
        `${shape.control.bytes} bytes`);
    for (const [key, label] of [
        ['duplicate', 'two rows for the same page'],
        ['pageZero', 'a row for page 0'],
        ['pastEnd', 'a row past the last page'],
        ['extraConfirmed', 'an extra confirmed row on top of every page'],
        ['duplicateNoMissingCount', 'a duplicate standing in for a missing page'],
        ['fractional', 'a page number that is not a whole number'],
    ]) {
        const result = shape[key];
        probe(`${label} produces no workbook`,
            result.ready === false && result.bytes === null && typeof result.refused === 'string',
            result.bytes === null ? (result.reason ?? result.refused) : `IT RETURNED ${result.bytes} BYTES`);
    }

    console.log('\n=== rows read under an arrangement that has since changed ===');
    const stale = await page.evaluate(() => window.__register.staleRevisionChecks());
    check('a register checked against the arrangement it was read under is ready',
        stale.sameRevision.ready === true && stale.sameRevision.stale.length === 0);
    probe('the same rows are refused once the arrangement moves on',
        stale.movedRevision.ready === false && stale.movedRevision.stale.length === 2,
        stale.movedRevision.reason);
    probe('and the export function refuses them too',
        typeof stale.refused === 'string', stale.refused || 'IT RETURNED A WORKBOOK');
    probe('confirming a stale row again does not make it exportable',
        stale.afterReconfirm.ready === false && stale.afterReconfirm.stale.length === 2,
        `rows still stamped ${stale.revisionOnRows.join(', ')}`);

    // The bypass: a caller that never mentions the revision. Types do not
    // survive to runtime, so this is checked as behaviour and not as a
    // signature -- a rule that only holds while everybody compiles against the
    // current declaration is not a rule.
    for (const [label, result] of Object.entries(stale.bypass)) {
        probe(`exporting with ${label} is refused`,
            result.bytes === null && typeof result.error === 'string',
            result.bytes === null ? result.error : `IT RETURNED ${result.bytes} BYTES`);
    }
    check('a register whose rows match the current revision does export',
        typeof stale.freshWithRevision === 'number' && stale.freshWithRevision > 0,
        `${stale.freshWithRevision} bytes`);
    probe('and the same register is refused when the revision is left out',
        typeof stale.freshWithout === 'string',
        typeof stale.freshWithout === 'string' ? stale.freshWithout : `IT RETURNED ${stale.freshWithout} BYTES`);

    console.log('\n=== a stalled recognition does not poison the rest of the run ===');
    const scannedPage = truth.pages.find((p) => p.kind === 'scanned' && p.rotate === 0).page;
    const recovery = await page.evaluate((n) => window.__register.workerRecovery(n), scannedPage);
    check('the engine starts', recovery.startedBefore === true);
    probe('a recognition that cannot finish in time fails fatally',
        typeof recovery.fatal === 'string', recovery.fatal || 'IT DID NOT FAIL');
    probe('and takes the worker down with it',
        recovery.startedAfterFatal === false,
        'there is no way to abort a recognition in flight, so the worker goes');
    check('the next recognition builds a new worker without being asked',
        recovery.startedAfterRecovery === true);
    check('and reads the page it was given',
        recovery.recoveredHits >= 3, `${recovery.recoveredHits}/${recovery.of} fields after recovery`);

    console.log('\n=== the workbook ===');
    const header = exp.grid[0];
    check('the sheet has the register columns',
        header.join('|') === 'ページ|図面番号|図面名称|版|日付', header.join(' | '));
    check('leading zeros survive to the cell', exp.grid[1][1] === '001', JSON.stringify(exp.grid[1][1]));
    check('a formula-like value stays text', exp.grid[2][1] === '=1+1', JSON.stringify(exp.grid[2][1]));
    check('a blank field stays blank without shifting its neighbours',
        exp.grid[2][3] === '' && exp.grid[2][4] === '2026.09.02',
        `revision=${JSON.stringify(exp.grid[2][3])} date=${JSON.stringify(exp.grid[2][4])}`);
    check('a multiline value keeps its line break',
        exp.grid[2][2].includes('\n') === false && exp.grid[2][2] === '二行目',
        `the display value is the last line: ${JSON.stringify(exp.grid[2][2])}`);
    check('the file is named for the source', exp.fileName === 'site plan_drawing_register.xlsx', exp.fileName);

    const xlsx = Buffer.from(exp.base64, 'base64');
    fs.writeFileSync(path.join(FIX, 'drawing-register.xlsx'), xlsx);
    const zipText = xlsx.toString('latin1');
    check('the workbook is a zip', xlsx[0] === 0x50 && xlsx[1] === 0x4b, `${xlsx.length} bytes`);
    check('it declares one worksheet', (zipText.match(/xl\/worksheets\/sheet\d+\.xml/g) ?? []).length >= 1);
    probe('no cell is a formula', !/<f>/.test(zipText) && !/<f /.test(zipText));
    probe('there is no macro part', !zipText.includes('vbaProject.bin'));
    probe('there is no external relationship',
        !zipText.includes('externalLink') && !/Target="https?:/.test(zipText));

    // ---- browser-local ------------------------------------------------------
    console.log('\n=== nothing left this machine ===');
    check('no external request was made', external.length === 0,
        external.length ? external.slice(0, 3).join(', ') : '0 requests');
    check('the OCR assets came from this origin', ocrAssets.size > 0
        && [...ocrAssets].every((url) => url.startsWith('/ocr/')),
        `${ocrAssets.size} asset(s) under /ocr/`);
    check('no page error', pageErrors.length === 0, pageErrors[0] ?? '');

    const renders = await page.evaluate(() => window.__register.renders());
    const largest = Math.max(...renders.map((r) => r.pixels));
    probe('no render came anywhere near a full A0 page',
        largest < cost.fullPage.pixels / 10,
        `largest region ${(largest / 1e6).toFixed(2)} Mpx against ${(cost.fullPage.pixels / 1e6).toFixed(1)} Mpx for the sheet`);

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length === 0
        ? `All ${checks.length} drawing-register checks passed (${checks.filter((c) => c.name.startsWith('negative probe')).length} negative probes).`
        : `${failed.length} of ${checks.length} checks failed.`}\n`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nFAILED: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
