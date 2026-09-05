/**
 * Gate for OCR preprocessing: deskew and speckle removal.
 *
 * "The feature ran" is not the bar. Preprocessing exists to make recognition
 * better on a crooked or dirty scan, so this measures the same fixture with it
 * off and on and requires the on run to be at least as good. It equally
 * requires a clean page to come out unchanged, because the cheapest way to
 * damage this tool is to correct a page that was already straight.
 *
 * Every fixture is synthetic and deterministic: fixed skew angles and a seeded
 * speckle generator, so a difference between the two runs is the algorithm's
 * doing and not the run's.
 *
 * Run:  node scripts/make-test-fixtures.mjs && node scripts/smoke-ocr-preprocessing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5195;
const ORIGIN = `http://localhost:${PORT}`;

const OFF = { deskew: false, noiseReduction: false };
const ON = { deskew: true, noiseReduction: true };
const DESKEW_ONLY = { deskew: true, noiseReduction: false };
const NOISE_ONLY = { deskew: false, noiseReduction: true };

const MIX_TOKENS = ['建築', '図面', 'Architectural', 'Drawing', 'Floor', 'Plan'];
const JA_TOKENS = ['建築', '図面', '設計'];
const EN_TOKENS = ['Architectural', 'Drawing', 'Design'];

if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'scanned-skew-plus-3.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative or opaque */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
// OCR runs inside a Web Worker, whose traffic page-level events never see.
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    record(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
        session.on('Network.responseReceived', (e) => record(e.response?.url));
    } catch { /* target already gone */ }
});

const detect = (name, options) => page.evaluate((n, o) => window.__prep.detect(n, o), name, options);
const ocrRun = (name, options, tokens, checkPage = 1) =>
    page.evaluate((n, o, t, p) => window.__prep.ocrRun(n, o, t, p), name, options, tokens, checkPage);
const extractRun = (name, options, tokens) =>
    page.evaluate((n, o, t) => window.__prep.extractRun(n, o, t), name, options, tokens);

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-ocr-preprocessing-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__prep?.ready === true, { timeout: 120000 });

    // ---- detection against known angles --------------------------------------
    console.log('\n=== deskew detection (known angles) ===');
    const KNOWN = [
        ['scanned-skew-plus-1.pdf', 1],
        ['scanned-skew-minus-1.pdf', -1],
        ['scanned-skew-plus-3.pdf', 3],
        ['scanned-skew-minus-3.pdf', -3],
        ['scanned-skew-ja.pdf', 2],
        ['scanned-skew-en.pdf', 2],
        ['scanned-skew-noisy.pdf', 3],
    ];
    const detections = {};
    for (const [name, truth] of KNOWN) {
        const d = await detect(name, DESKEW_ONLY);
        detections[name] = d;
        console.log(`  ${name.padEnd(26)} truth ${String(truth).padStart(4)}  found ${String(d.detectedAngle).padStart(6)}  conf ${String(d.deskewConfidence).padStart(8)}  analysis ${d.analysis}  detect ${d.detectMs}ms apply ${d.applyMs}ms  ${d.source} -> ${d.processed}`);
        check(`${name}: detected angle is within 0.25 deg of the truth`,
            Math.abs(d.detectedAngle - truth) <= 0.25, `${d.detectedAngle} vs ${truth}`);
        check(`${name}: the sign matches`, Math.sign(d.detectedAngle) === Math.sign(truth),
            `${d.detectedAngle}`);
        check(`${name}: the correction was applied`, d.deskewApplied === true);
        check(`${name}: a coordinate mapping came back with it`,
            d.hasMapping === true
            && Math.abs(d.mappingRoundTrip?.x ?? 99) < 0.01 && Math.abs(d.mappingRoundTrip?.y ?? 99) < 0.01,
            JSON.stringify(d.mappingRoundTrip));
        check(`${name}: the straightened page still holds the whole sheet`,
            d.processed !== d.source, `${d.source} -> ${d.processed}`);
    }

    // ---- pages that must be left alone ---------------------------------------
    console.log('\n=== no-op cases ===');
    for (const [name, why] of [
        ['scanned-ja-en.pdf', 'already straight'],
        ['scanned-skew-tiny.pdf', '0.1 deg, not worth rotating'],
        ['scanned-noisy.pdf', 'straight, just dirty'],
        ['scanned-noisy-heavy.pdf', 'straight, very dirty'],
        ['scanned-sparse.pdf', 'too little ink to judge'],
        ['scanned-blank.pdf', 'nothing on the sheet'],
    ]) {
        const d = await detect(name, DESKEW_ONLY);
        console.log(`  ${name.padEnd(26)} ${why.padEnd(28)} angle ${String(d.detectedAngle).padStart(6)}  conf ${String(d.deskewConfidence).padStart(8)}  applied=${d.deskewApplied}`);
        check(`${name}: no rotation is applied`, d.deskewApplied === false && d.detectedAngle === 0,
            `angle=${d.detectedAngle} applied=${d.deskewApplied}`);
        check(`${name}: the reported angle is a real number`,
            Number.isFinite(d.detectedAngle) && Number.isFinite(d.deskewConfidence),
            `angle=${d.detectedAngle} conf=${d.deskewConfidence}`);
        check(`${name}: the image is handed back untouched`,
            d.ownsCanvas === false && d.processed === d.source, `${d.source} -> ${d.processed}`);
    }

    // ---- canvas ownership ------------------------------------------------------
    console.log('\n=== memory ===');
    const owned = await detect('scanned-skew-plus-3.pdf', ON);
    console.log(`  ${JSON.stringify({ ownsCanvas: owned.ownsCanvas, releasedProcessed: owned.releasedProcessed, releasedSource: owned.releasedSource })}`);
    check('a processed page owns a second canvas and both can be released',
        owned.ownsCanvas === true && owned.releasedProcessed === true && owned.releasedSource === true,
        JSON.stringify(owned));

    // ---- OCR quality, off vs on ------------------------------------------------
    console.log('\n=== OCR quality: preprocessing off vs on ===');
    const QUALITY = [
        ['scanned-ja-en.pdf', ON, MIX_TOKENS, 'clean -- must not get worse'],
        ['scanned-skew-plus-1.pdf', DESKEW_ONLY, MIX_TOKENS, '+1 deg'],
        ['scanned-skew-minus-1.pdf', DESKEW_ONLY, MIX_TOKENS, '-1 deg'],
        ['scanned-skew-plus-3.pdf', DESKEW_ONLY, MIX_TOKENS, '+3 deg'],
        ['scanned-skew-minus-3.pdf', DESKEW_ONLY, MIX_TOKENS, '-3 deg'],
        ['scanned-skew-ja.pdf', DESKEW_ONLY, JA_TOKENS, '+2 deg Japanese'],
        ['scanned-skew-en.pdf', DESKEW_ONLY, EN_TOKENS, '+2 deg English'],
        ['scanned-noisy.pdf', NOISE_ONLY, MIX_TOKENS, 'light speckle'],
        ['scanned-noisy-heavy.pdf', NOISE_ONLY, MIX_TOKENS, 'heavy speckle'],
        ['scanned-skew-noisy.pdf', ON, MIX_TOKENS, '+3 deg and speckle'],
    ];
    console.log(`  ${'fixture'.padEnd(26)} ${'case'.padEnd(28)} off        on         verdict`);
    const quality = [];
    for (const [name, options, tokens, label] of QUALITY) {
        const off = await ocrRun(name, OFF, tokens);
        const on = await ocrRun(name, options, tokens);
        quality.push({ name, label, off, on });
        const fmt = (r) => `${r.tokenHits}/${r.tokenTotal} c${String(r.meanConfidence ?? '-').padStart(3)}`;
        console.log(`  ${name.padEnd(26)} ${label.padEnd(28)} ${fmt(off).padEnd(10)} ${fmt(on).padEnd(10)} ` +
            `${on.tokenHits > off.tokenHits ? 'better' : on.tokenHits === off.tokenHits ? 'same' : 'WORSE'}` +
            `  ${off.totalMs}ms -> ${on.totalMs}ms  prep=${on.preprocess ? on.preprocess.processingMs + 'ms' : '-'}`);
        if (on.missing.length) console.log(`      missing with preprocessing on: ${JSON.stringify(on.missing)}`);

        check(`${name}: preprocessing does not lose expected tokens`,
            on.tokenHits >= off.tokenHits, `${off.tokenHits} -> ${on.tokenHits}, missing ${JSON.stringify(on.missing)}`);
        check(`${name}: confidence does not collapse`,
            (on.meanConfidence ?? 0) >= (off.meanConfidence ?? 0) - 5,
            `${off.meanConfidence} -> ${on.meanConfidence}`);
        check(`${name}: the visible page is unchanged with preprocessing on`,
            on.appearance.identical === true, `diff=${on.appearance.differingPixels}`);
    }

    // The point of the whole feature: a crooked page must actually read better.
    //
    // Token hits alone cannot show that. Most of these fixtures already score
    // 6/6 without any help, so the count has nowhere to go and "no worse" would
    // be the only thing it could ever say. Tesseract's own confidence is the
    // measure that still moves, so the bar is stated on both: never fewer
    // tokens, and a real average gain in confidence across the crooked set.
    const skewCases = quality.filter((q) => /skew-(plus|minus)-[13]|skew-ja|skew-en/.test(q.name));
    const deltas = skewCases.map((q) => ({
        name: q.name.replace('scanned-', '').replace('.pdf', ''),
        tokens: q.on.tokenHits - q.off.tokenHits,
        conf: (q.on.meanConfidence ?? 0) - (q.off.meanConfidence ?? 0),
    }));
    const meanConfGain = deltas.reduce((s, d) => s + d.conf, 0) / deltas.length;
    console.log(`\n  crooked pages, change with deskew on:`);
    for (const d of deltas) console.log(`    ${d.name.padEnd(16)} tokens ${d.tokens >= 0 ? '+' : ''}${d.tokens}   confidence ${d.conf >= 0 ? '+' : ''}${d.conf}`);
    console.log(`    mean confidence gain: ${meanConfGain >= 0 ? '+' : ''}${meanConfGain.toFixed(2)}`);
    check('deskew never costs a crooked page any expected token',
        deltas.every((d) => d.tokens >= 0), JSON.stringify(deltas));
    check('deskew raises average recognition confidence on crooked pages',
        meanConfGain > 0, `mean ${meanConfGain.toFixed(2)}`);
    check('deskew improves at least one crooked page outright',
        deltas.some((d) => d.tokens > 0 || d.conf >= 3), JSON.stringify(deltas));

    const clean = quality.find((q) => q.name === 'scanned-ja-en.pdf');
    check('a clean page is not damaged by turning preprocessing on',
        clean.on.tokenHits >= clean.off.tokenHits
        && (clean.on.meanConfidence ?? 0) >= (clean.off.meanConfidence ?? 0) - 2,
        `${clean.off.tokenHits}/${clean.off.meanConfidence} -> ${clean.on.tokenHits}/${clean.on.meanConfidence}`);

    // ---- thin strokes survive speckle removal ---------------------------------
    console.log('\n=== thin text survives noise reduction ===');
    const thinOff = await ocrRun('scanned-ja-en.pdf', OFF, MIX_TOKENS);
    const thinOn = await ocrRun('scanned-ja-en.pdf', NOISE_ONLY, MIX_TOKENS);
    console.log(`  clean page: off ${thinOff.ocrWords} words / on ${thinOn.ocrWords} words, specks removed ${thinOn.preprocess?.removedSpecks ?? '-'}`);
    check('speckle removal keeps every expected token on a clean page',
        thinOn.tokenHits === thinOn.tokenTotal, JSON.stringify(thinOn.missing));
    check('speckle removal barely touches a clean page',
        (thinOn.preprocess?.removedSpecks ?? 0) < 200, String(thinOn.preprocess?.removedSpecks));
    const noisyPrep = quality.find((q) => q.name === 'scanned-noisy-heavy.pdf');
    check('speckle removal actually removes speckle on a dirty page',
        (noisyPrep.on.preprocess?.removedSpecks ?? 0) > 1000,
        String(noisyPrep.on.preprocess?.removedSpecks));

    // ---- the text layer still lands on the glyphs ------------------------------
    console.log('\n=== searchable text placement after deskew ===');
    for (const q of quality.filter((x) => /skew-(plus|minus)-3/.test(x.name))) {
        console.log(`  ${q.name.padEnd(26)} off contained ${q.off.placement.containedInInk} angle ${q.off.placement.medianRunAngleDeg}` +
            `   on contained ${q.on.placement.containedInInk} angle ${q.on.placement.medianRunAngleDeg}`);
        check(`${q.name}: the invisible text still sits on the ink`,
            q.on.placement.containedInInk >= 0.85, String(q.on.placement.containedInInk));
        check(`${q.name}: the text runs along the page's own skew, not flat`,
            Math.abs(q.on.placement.medianRunAngleDeg) > 0.4,
            `${q.on.placement.medianRunAngleDeg} deg`);
    }

    // ---- mixed document: only the scanned page is preprocessed -----------------
    console.log('\n=== mixed document ===');
    const mixed = await ocrRun('mixed-multipage.pdf', ON, MIX_TOKENS, 2);
    console.log(`  ${JSON.stringify(mixed.pages.map((p) => ({ p: p.pageNumber, kind: p.kind, words: p.ocrWords, prep: p.preprocess ? 'yes' : 'no' })))}`);
    check('mixed: a text-native page is never preprocessed',
        mixed.pages.filter((p) => p.kind === 'text-native').every((p) => !p.preprocess),
        JSON.stringify(mixed.pages.map((p) => `${p.kind}:${p.preprocess ? 'prep' : '-'}`)));
    check('mixed: the scanned page is preprocessed',
        mixed.pages.find((p) => p.kind === 'scanned')?.preprocess != null);
    check('mixed: the visible document is unchanged', mixed.appearance.identical === true,
        `diff=${mixed.appearance.differingPixels}`);

    // ---- an existing /Rotate page must not be confused with skew ---------------
    console.log('\n=== rotated page (/Rotate 90) ===');
    const rotOff = await ocrRun('scanned-rotated.pdf', OFF, MIX_TOKENS);
    const rotOn = await ocrRun('scanned-rotated.pdf', ON, MIX_TOKENS);
    console.log(`  off tokens ${rotOff.tokenHits}/${rotOff.tokenTotal} contained ${rotOff.placement.containedInInk}` +
        `   on tokens ${rotOn.tokenHits}/${rotOn.tokenTotal} contained ${rotOn.placement.containedInInk}` +
        `   angle ${rotOn.preprocess?.detectedAngle}`);
    check('rotated page: /Rotate is not mistaken for skew',
        Math.abs(rotOn.preprocess?.detectedAngle ?? 0) <= 5, String(rotOn.preprocess?.detectedAngle));
    check('rotated page: recognition does not regress',
        rotOn.tokenHits >= rotOff.tokenHits, `${rotOff.tokenHits} -> ${rotOn.tokenHits}`);
    check('rotated page: the text layer still lands on the ink',
        rotOn.placement.containedInInk >= 0.85, String(rotOn.placement.containedInInk));
    check('rotated page: appearance unchanged', rotOn.appearance.identical === true);

    // ---- text extraction uses the same preprocessing ---------------------------
    console.log('\n=== text extraction ===');
    const exOff = await extractRun('scanned-skew-plus-3.pdf', OFF, MIX_TOKENS);
    const exOn = await extractRun('scanned-skew-plus-3.pdf', ON, MIX_TOKENS);
    console.log(`  off ${exOff.tokenHits}/${exOff.tokenTotal}  on ${exOn.tokenHits}/${exOn.tokenTotal}  angle ${exOn.pages[0]?.preprocess?.detectedAngle}`);
    check('text extraction applies the same preprocessing',
        exOn.pages[0]?.preprocess?.deskewApplied === true,
        JSON.stringify(exOn.pages[0]?.preprocess));
    check('text extraction does not lose tokens with preprocessing on',
        exOn.tokenHits >= exOff.tokenHits, `${exOff.tokenHits} -> ${exOn.tokenHits}`);

    const exMixed = await extractRun('mixed-multipage.pdf', ON, MIX_TOKENS);
    check('text extraction: text-native pages stay untouched',
        exMixed.pages.filter((p) => p.kind === 'text-native').every((p) => !p.preprocess),
        JSON.stringify(exMixed.pages.map((p) => `${p.kind}:${p.preprocess ? 'prep' : '-'}`)));

    // ---- cancellation still behaves ---------------------------------------------
    console.log('\n=== cancellation with preprocessing on ===');
    const cancel = await page.evaluate((o) => window.__prep.cancelProbe('scanned-skew-plus-3.pdf', o), ON);
    console.log(`  ${JSON.stringify(cancel)}`);
    check('cancelling a preprocessed run still rejects with no result',
        cancel.threw === true && cancel.code === 'cancelled' && cancel.gotText !== true,
        JSON.stringify(cancel));

    // ---- network -----------------------------------------------------------------
    console.log('\n=== network ===');
    const uniqueExternal = [...new Set(external)];
    for (const u of uniqueExternal) console.log(`  EXTERNAL ${u}`);
    check('no external request during preprocessing or OCR', uniqueExternal.length === 0,
        `${uniqueExternal.length} external`);
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
        path.join(ROOT, 'test-fixtures', 'smoke-ocr-preprocessing-results.json'),
        JSON.stringify({ ranAt: new Date().toISOString(), checks, external: [...new Set(external)], pageErrors }, null, 2),
    );
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
