/**
 * Measure the M2-5 drawing-register architecture against the synthetic set.
 *
 * Nothing here is described from memory. Page geometry comes from the
 * production analyser, the segmentation modes come from the installed
 * tesseract.js, and the rendering costs are read off real canvases.
 *
 * Results land in test-fixtures/m2-5/results/ as JSON, which the write-up and
 * the research gate then read. Keeping measurement and judgement apart is what
 * lets the gate re-check a conclusion without a browser in the loop.
 *
 * Run:  node scripts/research-m2-5-fixtures.mjs && node scripts/research-m2-5-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

import { buildTemplate, applyTemplate, templateFits, iou, unionRegion, MODELS } from '../research/m2-5/prototype/template.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-5');
const OUT = path.join(FIX, 'results');
const PORT = 5192;
const ORIGIN = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(FIX, 'drawing-set.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'research-m2-5-fixtures.mjs')], { stdio: 'inherit' });
}
fs.mkdirSync(OUT, { recursive: true });

const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'drawing-set.truth.json'), 'utf8'));
const FIELDS = ['drawing_number', 'drawing_title', 'revision', 'revision_date'];
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const ocrAssets = [];
const record = (url) => {
    if (!url) return;
    if (url.startsWith(`${ORIGIN}/ocr/`)) ocrAssets.push(url.slice(ORIGIN.length));
    if (url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* gone */ }
});

const norm = (s) => String(s ?? '').replace(/\s+/gu, '').trim();
const pageTruth = (n) => truth.pages.find((p) => p.page === n);

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/research-m2-5-probe-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m25Ready === true, { timeout: 120000 });

    // ---- what the installed OCR actually offers ----------------------------
    console.log('\n=== segmentation modes, read from the installed tesseract.js ===');
    const psm = await page.evaluate(() => ({ options: window.__m25.psmOptions, values: window.__m25.psmValues }));
    console.log(`  ${psm.options.length} modes: ${psm.options.join(', ')}`);
    console.log(`  values are ${typeof Object.values(psm.values)[0]}s, e.g. AUTO=${JSON.stringify(psm.values.AUTO)}`);
    write('psm-enum.json', psm);

    // ---- page geometry -----------------------------------------------------
    console.log('\n=== page geometry, from the production analyser ===');
    const geometry = [];
    for (const p of truth.pages) {
        const g = await page.evaluate((n) => window.__m25.geometry(n), p.page);
        geometry.push({ ...g, kind: p.kind, size: p.size, layout: p.layout });
        console.log(`  p${String(p.page).padStart(2)} ${p.kind.padEnd(8)} ${p.size.padEnd(3)} L${p.layout} rot${String(g.rotate).padStart(3)}  upright ${g.uprightWidth.toFixed(0)}x${g.uprightHeight.toFixed(0)}  scanned=${String(g.scanned).padEnd(5)} chars ${String(g.allChars).padStart(4)}/${String(g.interiorChars).padStart(4)}  tokens ${g.tokens}`);
    }
    write('geometry.json', geometry);

    // ---- field template transfer -------------------------------------------
    //
    // The template is built from page 1: an A3, layout A, upright. Every other
    // page is then read through it under each coordinate model, and the
    // transferred rectangle is compared with where the field actually is.
    console.log('\n=== field template transfer ===');
    const source = geometry.find((g) => g.pageNumber === 1);
    const template = buildTemplate({
        profile: 'A: title block, bottom right (from page 1)',
        page: source,
        fields: pageTruth(1).regions,
    });

    const transfer = [];
    for (const g of geometry) {
        const t = pageTruth(g.pageNumber);
        const fit = templateFits(template, g);
        const row = { pageNumber: g.pageNumber, kind: g.kind, size: g.size, layout: g.layout, blockScaling: t.blockScaling, rotate: g.rotate, fits: fit.fits, reasons: fit.reasons, models: {} };
        for (const model of Object.keys(MODELS)) {
            const applied = applyTemplate(template, g, model);
            const scores = FIELDS.map((f) => iou(applied[f], t.regions[f]));
            row.models[model] = {
                meanIou: scores.reduce((a, b) => a + b, 0) / scores.length,
                minIou: Math.min(...scores),
                perField: Object.fromEntries(FIELDS.map((f, i) => [f, +scores[i].toFixed(3)])),
                rects: applied,
            };
        }
        transfer.push(row);
    }
    write('template-transfer.json', { template, transfer });

    console.log('  page  size L rot  fits   absolute  normalised  corner-anchored');
    for (const r of transfer) {
        const cell = (m) => `${(r.models[m].meanIou * 100).toFixed(0)}%`.padStart(8);
        console.log(`  ${String(r.pageNumber).padStart(4)}  ${r.size.padEnd(4)} ${r.layout} ${String(r.rotate).padStart(3)}  ${String(r.fits).padEnd(5)} ${cell('absolute')} ${cell('normalised')} ${cell('corner-anchored')}`);
    }
    for (const model of Object.keys(MODELS)) {
        const sameLayout = transfer.filter((r) => r.layout === 'A');
        const otherLayout = transfer.filter((r) => r.layout !== 'A');
        const mean = (rows) => rows.length ? rows.reduce((a, r) => a + r.models[model].meanIou, 0) / rows.length : 0;
        console.log(`  -- ${model.padEnd(16)} layout A ${(mean(sameLayout) * 100).toFixed(0)}%   layout B ${(mean(otherLayout) * 100).toFixed(0)}%`);
    }

    // ---- native extraction through the transferred rectangles ---------------
    // Measured under every model, not under a chosen one: which model is best
    // is the question, so choosing one first would answer it by assumption.
    console.log('\n=== native field extraction, under each coordinate model ===');
    const nativeResults = [];
    for (const g of geometry) {
        const t = pageTruth(g.pageNumber);
        const perModel = {};
        for (const model of Object.keys(MODELS)) {
            const regions = applyTemplate(template, g, model);
            const result = await page.evaluate((n, r) => window.__m25.nativeFields(n, r), g.pageNumber, regions);
            const perField = {};
            for (const f of FIELDS) {
                const got = result.fields[f]?.text ?? '';
                const want = t.values[f] ?? '';
                // The field region contains its label as well as its value,
                // which is what a real title block looks like. Whether the
                // label comes back too is a finding, so it is measured rather
                // than stripped out first.
                perField[f] = {
                    expected: want,
                    actual: got,
                    exact: norm(got) === norm(want),
                    containsExpected: want !== '' && norm(got).includes(norm(want)),
                    tokenCount: result.fields[f]?.tokenCount ?? 0,
                };
            }
            perModel[model] = {
                scanned: result.scanned,
                hits: FIELDS.filter((f) => perField[f].containsExpected).length,
                fields: perField,
            };
        }
        nativeResults.push({
            pageNumber: g.pageNumber, kind: g.kind, size: g.size, layout: g.layout,
            blockScaling: t.blockScaling, rotate: g.rotate, models: perModel,
        });
        console.log(`  p${String(g.pageNumber).padStart(2)} ${g.kind.padEnd(8)} ${g.size.padEnd(3)} L${g.layout} ${String(t.blockScaling ?? '').padEnd(20)} rot${String(g.rotate).padStart(3)}  absolute ${perModel.absolute.hits}/4  normalised ${perModel.normalised.hits}/4  corner ${perModel['corner-anchored'].hits}/4`);
    }
    write('native-extraction.json', nativeResults);

    // How each model does, split by the thing that actually distinguishes the
    // pages: whether the title block scales with the sheet or keeps its size.
    const groups = {
        'same size (A3, layout A)': (r) => r.size === 'A3' && r.layout === 'A',
        'bigger sheet, block scales': (r) => r.size !== 'A3' && r.layout === 'A' && r.blockScaling === 'proportional',
        'bigger sheet, block fixed': (r) => r.blockScaling === 'fixed-physical-size',
        'other layout': (r) => r.layout !== 'A',
    };
    console.log('');
    for (const [label, filter] of Object.entries(groups)) {
        const rows = nativeResults.filter((r) => filter(r) && r.kind === 'native');
        if (!rows.length) continue;
        const score = (model) => {
            const hits = rows.reduce((a, r) => a + r.models[model].hits, 0);
            return `${hits}/${rows.length * 4}`;
        };
        console.log(`  ${label.padEnd(28)} ${String(rows.length).padStart(2)} pages   absolute ${score('absolute').padEnd(7)} normalised ${score('normalised').padEnd(7)} corner-anchored ${score('corner-anchored')}`);
    }

    // The OCR sections need one model to place their regions. Named here so the
    // dependency is visible rather than buried in each call.
    const OCR_MODEL = 'normalised';
    console.log(`\n  OCR regions below are placed with the "${OCR_MODEL}" model`);

    // ---- rendering cost: full page against the region -----------------------
    console.log('\n=== what a region costs against a full page ===');
    const renderCosts = [];
    for (const pageNumber of [1, 9, 16, 17]) {
        const g = geometry.find((x) => x.pageNumber === pageNumber);
        const t = pageTruth(pageNumber);
        const union = unionRegion(t.regions, 6);
        for (const dpi of [300]) {
            const cost = await page.evaluate((n, r, d) => window.__m25.renderCost(n, r, d), pageNumber, union, dpi);
            renderCosts.push({ pageNumber, size: g.size, ...cost });
            console.log(`  p${String(pageNumber).padStart(2)} ${g.size.padEnd(3)} @${dpi}dpi  full ${cost.fullPage.width}x${cost.fullPage.height} = ${(cost.fullPage.pixels / 1e6).toFixed(1)} Mpx (${(cost.fullPage.bytes / 1048576).toFixed(0)} MB)   region ${cost.region.width}x${cost.region.height} = ${(cost.region.pixels / 1e6).toFixed(2)} Mpx (${(cost.region.bytes / 1048576).toFixed(1)} MB)   ${(cost.ratio * 100).toFixed(2)}%  ${cost.ms}ms`);
        }
    }
    write('render-cost.json', renderCosts);

    // ---- segmentation, per field, on the scanned pages ----------------------
    console.log('\n=== segmentation modes, per field, on scanned pages ===');
    const SCANNED = truth.pages.filter((p) => p.kind === 'scanned').map((p) => p.page);
    const MODES = ['AUTO', 'SINGLE_BLOCK', 'SINGLE_LINE', 'SPARSE_TEXT', 'SINGLE_WORD'];
    const perFieldRuns = [];
    for (const pageNumber of SCANNED.slice(0, 3)) {
        const g = geometry.find((x) => x.pageNumber === pageNumber);
        const t = pageTruth(pageNumber);
        const regions = applyTemplate(template, g, OCR_MODEL);
        for (const mode of MODES) {
            const run = await page.evaluate((n, r, m) => window.__m25.ocrPerField(n, r, m), pageNumber, regions, mode);
            const scored = {};
            for (const f of FIELDS) {
                const want = t.values[f] ?? '';
                const got = run.fields[f]?.text ?? '';
                scored[f] = {
                    expected: want, actual: got,
                    exact: norm(got) === norm(want),
                    containsExpected: want !== '' && norm(got).includes(norm(want)),
                    confidence: run.fields[f]?.confidence ?? null,
                };
            }
            const hits = FIELDS.filter((f) => scored[f].containsExpected).length;
            perFieldRuns.push({ pageNumber, mode, hits, totalMs: run.totalMs, totalPixels: run.totalPixels, fields: scored });
            console.log(`  p${String(pageNumber).padStart(2)} ${mode.padEnd(13)} value found in ${hits}/4 fields   ${run.totalMs}ms  ${(run.totalPixels / 1e6).toFixed(2)} Mpx`);
        }
    }
    write('ocr-per-field.json', perFieldRuns);

    // ---- one region for the whole title block -------------------------------
    console.log('\n=== the whole title block in one pass ===');
    const unionRuns = [];
    for (const pageNumber of SCANNED.slice(0, 3)) {
        const g = geometry.find((x) => x.pageNumber === pageNumber);
        const t = pageTruth(pageNumber);
        const regions = applyTemplate(template, g, OCR_MODEL);
        const union = unionRegion(regions, 6);
        for (const mode of MODES) {
            const run = await page.evaluate((n, r, u, m) => window.__m25.ocrUnionRegion(n, r, u, m), pageNumber, regions, union, mode);
            const scored = {};
            for (const f of FIELDS) {
                const want = t.values[f] ?? '';
                const got = run.fields[f]?.text ?? '';
                scored[f] = {
                    expected: want, actual: got,
                    exact: norm(got) === norm(want),
                    containsExpected: want !== '' && norm(got).includes(norm(want)),
                    confidence: run.fields[f]?.confidence ?? null,
                };
            }
            const hits = FIELDS.filter((f) => scored[f].containsExpected).length;
            unionRuns.push({ pageNumber, mode, hits, totalMs: run.totalMs, totalPixels: run.totalPixels, unplaced: run.unplaced, fields: scored });
            console.log(`  p${String(pageNumber).padStart(2)} ${mode.padEnd(13)} value found in ${hits}/4 fields   ${run.totalMs}ms  ${(run.totalPixels / 1e6).toFixed(2)} Mpx  ${run.unplaced.length} words outside any field`);
        }
    }
    write('ocr-union.json', unionRuns);

    // ---- preprocessing, on the same regions ----------------------------------
    console.log('\n=== ROI preprocessing, on and off ===');
    const prepRuns = [];
    for (const pageNumber of SCANNED.slice(0, 2)) {
        const g = geometry.find((x) => x.pageNumber === pageNumber);
        const t = pageTruth(pageNumber);
        const regions = applyTemplate(template, g, OCR_MODEL);
        const union = unionRegion(regions, 6);
        for (const preprocess of [false, true]) {
            const run = await page.evaluate((n, r, u, m, o) => window.__m25.ocrUnionRegion(n, r, u, m, o),
                pageNumber, regions, union, 'AUTO', { dpi: 300, preprocess });
            const hits = FIELDS.filter((f) => {
                const want = t.values[f] ?? '';
                return want !== '' && norm(run.fields[f]?.text ?? '').includes(norm(want));
            }).length;
            prepRuns.push({ pageNumber, preprocess, hits, totalMs: run.totalMs });
            console.log(`  p${String(pageNumber).padStart(2)} preprocessing ${preprocess ? 'ON ' : 'OFF'}  ${hits}/4  ${run.totalMs}ms`);
        }
    }
    write('roi-preprocessing.json', prepRuns);

    // ---- mixed pages: where does a field's text actually come from? ----------
    console.log('\n=== mixed pages: page classification against field content ===');
    const mixed = [];
    for (const pageNumber of truth.pages.filter((p) => ['stamp', 'ocrlayer'].includes(p.kind)).map((p) => p.page)) {
        const g = geometry.find((x) => x.pageNumber === pageNumber);
        const t = pageTruth(pageNumber);
        const regions = applyTemplate(template, g, OCR_MODEL);
        const native = await page.evaluate((n, r) => window.__m25.nativeFields(n, r), pageNumber, regions);
        const fieldsWithText = FIELDS.filter((f) => (native.fields[f]?.text ?? '').trim() !== '');
        mixed.push({
            pageNumber, kind: t.kind, pageScanned: g.scanned,
            allChars: g.allChars, interiorChars: g.interiorChars,
            fieldsWithNativeText: fieldsWithText,
            fields: native.fields,
        });
        console.log(`  p${String(pageNumber).padStart(2)} ${t.kind.padEnd(8)} page classified scanned=${String(g.scanned).padEnd(5)} chars ${g.allChars}/${g.interiorChars}  fields with native text: ${fieldsWithText.length ? fieldsWithText.join(', ') : 'none'}`);
    }
    write('mixed-pages.json', mixed);

    // ---- the whole set, end to end, under two source policies ---------------
    //
    // This is the run the review-burden numbers come from. Two policies are
    // compared because the difference between them is a real architecture
    // choice, not a detail:
    //
    //   page-level   the page classifier decides. A scanned page goes to OCR
    //                entirely, even where a field holds real vector text.
    //   field-level  each field uses its own native text when there is any,
    //                and OCR only where there is none.
    console.log('\n=== the whole set, end to end ===');
    const PROFILES = {
        A: { pages: truth.pages.filter((p) => p.layout === 'A').map((p) => p.page) },
        B: { pages: truth.pages.filter((p) => p.layout === 'B').map((p) => p.page) },
    };
    // Each profile is built from its own representative page, which is what a
    // user assigning template profiles would do.
    const templates = {
        A: template,
        B: buildTemplate({
            profile: 'B: title strip, right edge (from page 7)',
            page: geometry.find((g) => g.pageNumber === 7),
            fields: pageTruth(7).regions,
        }),
    };
    const profileOf = (pageNumber) => (PROFILES.A.pages.includes(pageNumber) ? 'A' : 'B');

    /**
     * The value area of a field, rather than the whole labelled cell.
     *
     * A title-block cell carries its label and its value, and a rectangle drawn
     * round the cell contains both -- so the extracted "drawing number" is
     * "figure-number-label + A-101", which reads fine and parses as nothing.
     * The alternative is to ask the user to draw only the part that holds the
     * value. Here that is approximated by dropping the top of each field
     * rectangle, which is where this corpus puts its labels.
     */
    const VALUE_ONLY_TOP = 0.45;
    const valueOnly = (rects) => Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, {
        ...r, top: r.top + (r.bottom - r.top) * VALUE_ONLY_TOP,
    }]));

    const endToEnd = [];
    for (const policy of ['page-level', 'field-level', 'field-level+value-only']) {
        const started = Date.now();
        const rows = [];
        for (const g of geometry) {
            const t = pageTruth(g.pageNumber);
            const profile = profileOf(g.pageNumber);
            // Within a profile, the model that suits how that sheet's block
            // scales. A production implementation would record this on the
            // profile; here it is derived from the fixture so the end-to-end
            // numbers are not dragged down by a question already answered.
            const model = t.blockScaling === 'fixed-physical-size' ? 'corner-anchored' : 'normalised';
            const wholeCell = applyTemplate(templates[profile], g, model);
            const regions = policy === 'field-level+value-only' ? valueOnly(wholeCell) : wholeCell;

            const native = await page.evaluate((n, r) => window.__m25.nativeFields(n, r), g.pageNumber, regions);
            const fields = {};
            let ocrNeeded = {};

            for (const f of FIELDS) {
                const nativeText = (native.fields[f]?.text ?? '').trim();
                const hasNative = nativeText !== '';
                const useNative = policy.startsWith('field-level') ? hasNative : !g.scanned && hasNative;
                if (useNative) fields[f] = { text: nativeText, source: 'native' };
                else ocrNeeded[f] = regions[f];
            }

            if (Object.keys(ocrNeeded).length) {
                const union = unionRegion(ocrNeeded, 6);
                const run = await page.evaluate((n, r, u, m) => window.__m25.ocrUnionRegion(n, r, u, m),
                    g.pageNumber, ocrNeeded, union, 'SINGLE_BLOCK');
                for (const f of Object.keys(ocrNeeded)) {
                    fields[f] = {
                        text: run.fields[f]?.text ?? '',
                        source: 'ocr',
                        confidence: run.fields[f]?.confidence ?? null,
                    };
                }
            }

            rows.push({ pageNumber: g.pageNumber, profile, model, fields, expected: t.values });
        }
        const ms = Date.now() - started;
        endToEnd.push({ policy, ms, rows });

        const exact = rows.reduce((n, r) => n + FIELDS.filter((f) => {
            const want = r.expected[f] ?? '';
            const got = r.fields[f]?.text ?? '';
            return want !== '' && norm(got).includes(norm(want));
        }).length, 0);
        const total = rows.length * FIELDS.length;
        console.log(`  ${policy.padEnd(12)} ${exact}/${total} fields carry the expected value   ${(ms / 1000).toFixed(1)}s for ${rows.length} pages`);
    }
    write('end-to-end.json', endToEnd);

    // ---- worker lifecycle ------------------------------------------------------
    const workerStats = await page.evaluate(() => window.__m25.workerStats());
    console.log(`\n  one OCR worker served every recognition above; it took ${workerStats.startMs} ms to start`);
    await page.evaluate(() => window.__m25.terminateWorker());
    write('worker.json', workerStats);

    console.log(`\n  external HTTP(S) requests: ${external.length}`);
    console.log(`  OCR assets fetched (same origin): ${new Set(ocrAssets).size} distinct`);
    console.log(`  page errors: ${pageErrors.length}${pageErrors.length ? ` -- ${pageErrors[0]}` : ''}`);
    write('network.json', { external, ocrAssets: [...new Set(ocrAssets)], pageErrors });

    exitCode = external.length === 0 && pageErrors.length === 0 ? 0 : 1;
    console.log('\n  results written to test-fixtures/m2-5/results/\n');
} catch (error) {
    console.error('\n  probe failed:', error?.stack ?? error);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
