/**
 * 最適化 v2 (D-028 Stage 1) gate — lossless image-aware optimization.
 *
 * Runs the production modules unmodified in Chrome (Vite dev server, like the
 * Processor reliability gate) against synthetic fixtures, and judges the output
 * with readers that share nothing with the optimizer: pdf.js decodes every image,
 * pdf.js and pdf-lib read the structure back, and a strict reader checks the
 * cross-reference table byte by byte. Every judge is also shown a broken
 * artifact and must reject it.
 *
 *   A  lossless correctness and structure preservation
 *   B  the R2 boundary (/Interpolate, /Decode, colour-key /Mask, ImageMask, /Matte)
 *   C  formats that are left alone (DCT, RunLength)
 *   D  the 1% publication threshold
 *   E  the single-file boundary (code-level; the UI half is in smoke-processor-ui)
 *   F  the memory preflight: ~250 MiB refused at 512 MiB, admitted at 1 GiB
 *   G  the run-time cap
 *   H  cancellation during compression and during the writer
 *   I  the writer: xref, trailer, ceiling, finish/abort, determinism
 *   J  source-buffer ownership
 *
 * Run: node scripts/smoke-processor-optimizer-v2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test-fixtures', 'processor-optimizer-v2');
if (!fs.existsSync(path.join(FIXTURES, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-processor-optimizer-v2-fixtures.mjs')], { stdio: 'inherit' });
}
if (!fs.existsSync(path.join(ROOT, 'test-fixtures', 'processor', 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-processor-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

const PORT = 5211;
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: PORT, strictPort: true } });
await server.listen();
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--expose-gc'],
});
const pageErrors = [];
let exitCode = 1;
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`http://localhost:${PORT}/scripts/smoke-processor-optimizer-v2-harness.html`);
    await page.waitForFunction(() => window.__ov2Ready === true, { timeout: 300_000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__ov2[f](...a), fn, args);
    const corpus = await page.evaluate(() => window.__ov2.corpus);

    // ---- A. lossless correctness --------------------------------------------
    console.log('\n=== A. lossless: every image decodes the same, nothing else moves ===');
    const results = {};
    for (const f of corpus.filter((c) => !c.expectRefusal && !c.expectRefusalAt512)) {
        const r = await call('verify', f.name, 512);
        results[f.name] = r;
        check(`${f.name}: ${f.expectKind}${f.expectMode ? ` (${f.expectMode})` : ''}`,
            r.kind === f.expectKind && (!f.expectMode || r.summary.mode === f.expectMode),
            `${r.summary.sourceBytes} -> ${r.summary.candidateBytes} (${r.summary.mode}), rewritten ${r.summary.rewrittenImages}/${r.summary.images.length}`);
        if (r.kind === 'optimized') {
            check(`${f.name}: judged lossless by pdf.js + pdf-lib`, r.verdict?.ok, (r.verdict?.errors ?? []).slice(0, 3).join(' | '));
            check(`${f.name}: reopens with pdf-lib (throwOnInvalidObject)`, r.reopen === true, String(r.reopen));
            if (r.summary.mode === 'images') check(`${f.name}: strict xref and trailer`, r.xref.length === 0, r.xref.slice(0, 2).join(' | '));
            check(`${f.name}: output is ≥ 1% smaller`, r.outputBytes * 100 <= r.summary.sourceBytes * 99, `${r.outputBytes} / ${r.summary.sourceBytes}`);
        }
        // Census decisions and outcomes, per image, against the manifest.
        for (const img of f.images) {
            const rep = r.summary.images.find((i) => i.objectNumber === img.obj);
            check(`${f.name} obj ${img.obj} (${img.label}): census says ${img.decision}`, rep?.decision === img.decision, rep ? `${rep.decision}: ${rep.why}` : 'missing');
            if (img.rewrite !== null && img.rewrite !== undefined) {
                check(`${f.name} obj ${img.obj}: ${img.rewrite ? 'rewritten' : 'left unchanged'}`, rep?.rewritten === img.rewrite, rep?.outcome ?? '');
            }
            if (img.form && img.form !== 'any' && rep?.rewritten) {
                const want = { Indexed: 'R2 Indexed', Gray: 'R2 DeviceGray 8-bit', 'Gray 1-bit': 'R2 DeviceGray 1-bit', R1: 'R1 Flate' }[img.form];
                check(`${f.name} obj ${img.obj}: chose ${want}`, rep.outcome.startsWith(want), rep.outcome);
            }
            if (rep?.rewritten) {
                const before = r.imagesBefore[img.obj];
                const after = r.imagesAfter[img.obj];
                check(`${f.name} obj ${img.obj}: width/height unchanged`, before && after && before.width === after.width && before.height === after.height,
                    `${before?.width}x${before?.height} -> ${after?.width}x${after?.height}`);
            }
        }
    }
    check('nothing lossy anywhere: quality and resolution never change',
        Object.values(results).every((r) => r.summary.qualityChanged === false && r.summary.resolutionChanged === false));
    check('no image is ever re-encoded as JPEG',
        Object.values(results).every((r) => Object.values(r.imagesAfter ?? {}).every((i) => !i.filter.includes('DCT') || r.imagesBefore[Object.keys(r.imagesAfter).find((k) => r.imagesAfter[k] === i)]?.filter.includes('DCT'))));

    console.log('\n--- the judge must reject broken artifacts');
    for (const [name, kind] of [
        ['comparator-like', 'sample'], ['structure', 'annotation'], ['structure', 'formValue'],
        ['structure', 'metadata'], ['structure', 'rotation'], ['structure', 'cropBox'], ['interpolate', 'interpolateR2'],
    ]) {
        const m = await call('mutationCaught', name, kind);
        probe(`${kind} on ${name} is caught`, m.caught, m.by.join(' | '));
    }

    // ---- B / C summaries -------------------------------------------------------
    console.log('\n=== B/C. the R2 boundary and the formats left alone ===');
    const interp = results.interpolate.summary.images;
    check('/Interpolate true stays R1 while its control goes R2 and is smaller',
        interp[0].decision === 'R1' && interp[0].outcome.startsWith('R1') && interp[1].outcome.startsWith('R2 Indexed') && interp[1].after < interp[0].after,
        `${interp[0].after} (R1) vs ${interp[1].after} (control)`);
    const cls = results.classes.summary.images;
    const leaveSame = Object.entries(results.classes.imagesAfter).filter(([k]) => ['37', '40'].includes(k))
        .every(([k, v]) => v.sha === results.classes.imagesBefore[k].sha && v.filter === results.classes.imagesBefore[k].filter);
    check('DCT and RunLength images are byte-identical in the output', leaveSame);
    check('no R2 form for /Decode, colour-key /Mask, ImageMask, 16-bit, CMYK, Indexed, /Matte parent',
        cls.filter((i) => i.decision === 'R1').every((i) => !i.outcome.startsWith('R2')));

    // ---- D. publication threshold ---------------------------------------------
    console.log('\n=== D. the 1% publication threshold ===');
    const t = await call('threshold');
    check('integer rule: exactly 1% publishes, just under does not, just over does', t.allRight,
        t.cases.filter((c) => c.got !== c.expect).map((c) => `${c.out}/${c.src}`).join(' '));
    probe('a rule using < instead of ≤ is caught by the same cases', t.brokenCaught);
    check('noise.pdf: below threshold, so the result is "unchanged" (the caller returns the File)', results.noise.kind === 'unchanged');

    // ---- F. preflight ------------------------------------------------------------
    console.log('\n=== F. memory: ~250 MiB needs 1 GiB; 512 MiB is not claimed ===');
    const S = 261_547_235;
    const f512 = await call('preflightLarge', S, 19, 512);
    const f1g = await call('preflightLarge', S, 19, 1024);
    const f2g = await call('preflightLarge', S, 19, 2048);
    check('~249 MiB at 512 MiB: refused OVER_MEMORY_BUDGET before the file is read',
        f512.code === 'OVER_MEMORY_BUDGET' && f512.readCalled === false && f512.runCode === 'OVER_MEMORY_BUDGET', f512.reason);
    check('the refusal tells the user 1 GiB is needed', /1 GiB/.test(f512.reason));
    check('~249 MiB at 1 GiB: admitted by the preflight', f1g.code === 'ADMITTED', JSON.stringify(f1g.arithmetic));
    check('~249 MiB at 2 GiB: admitted', f2g.code === 'ADMITTED');
    check('the trailer /Size is read from the tail', f512.trailerSize === 19);
    // RF-31-03: /Size is a bound, so anything that is not a true one refuses.
    const size0 = await call('preflightLarge', 1_000_000, 0, 512);
    check('/Size 0: refused before the read (UNSUPPORTED_DOCUMENT), never treated as "no objects"',
        size0.code === 'UNSUPPORTED_DOCUMENT' && size0.trailerSize === 0 && size0.readCalled === false, size0.reason);
    const sizeHuge = await call('preflightLarge', 1_000_000, 9_000_000, 2048);
    check('/Size above 8,388,607: refused, not clamped down', sizeHuge.code === 'UNSUPPORTED_DOCUMENT' && sizeHuge.readCalled === false && sizeHuge.trailerSize === 9_000_000,
        sizeHuge.reason);
    const sizeMax = await call('preflightLarge', 1_000_000, 8_388_607, 2048);
    check('/Size at the maximum is read exactly (and then priced: 8,388,607 objects do not fit 2 GiB)', sizeMax.trailerSize === 8_388_607 && sizeMax.code === 'OVER_MEMORY_BUDGET', sizeMax.code);
    const stray = await call('preflightLarge', 1_000_000, 12, 512, 'stray');
    check('a stray "/Size 12" near EOF with no table at startxref: refused, the text is not a trailer',
        stray.code === 'UNSUPPORTED_DOCUMENT' && stray.trailerSize === null && stray.readCalled === false, stray.reason);
    const under = await call('refusal', 'size-understated', 512);
    const underMeta = corpus.find((c) => c.name === 'size-understated');
    check(`/Size ${underMeta.declared} declared for ${underMeta.actual}: refused after the parse, before any image is touched`,
        under.code === 'UNSUPPORTED_DOCUMENT' && /\/Size/.test(under.message) && under.reachedWrite === false, under.message);
    const xs = results['xref-stream'];
    check('an XRef-stream file: /Size read from the stream dictionary, optimized', xs?.kind === 'optimized' && xs.verdict?.ok);
    const k = await call('constants');
    check('MAX_OUTPUT_BYTES is still 256 MiB and the presets are unchanged',
        k.MAX_OUTPUT_BYTES === 256 * 1024 * 1024 && JSON.stringify(k.MEMORY_PRESETS) === JSON.stringify([512, 1024, 2048].map((m) => m * 1024 * 1024)));
    check('pako 2.1.0 deflate state is counted from its own source (267,160 B at level 9)', k.PAKO2_DEFLATE_STATE_BYTES === 267_160);
    const big = results['comparator-like'].summary;
    check('the ledger never planned past the usable share', Object.values(results).every((r) => r.summary.ledgerPeakBytes <= r.summary.usableBytes),
        `comparator-like peak ${(big.ledgerPeakBytes / 1048576).toFixed(1)} of ${(big.usableBytes / 1048576).toFixed(0)} MiB`);

    // ---- G. run-time cap ---------------------------------------------------------
    console.log('\n=== G. the run-time cap ===');
    const cap = await call('cap');
    check('an incompressible candidate is abandoned at its cap (no result)', cap.cappedIsNull);
    probe('the same candidate with no cap does complete, so the null above is the cap', cap.brokenCaught, `uncapped ${cap.uncappedLength} B`);
    check('noise.pdf: every candidate capped, the stream kept, nothing written',
        results.noise.summary.images[0].rewritten === false && /no exact encoding was smaller/.test(results.noise.summary.images[0].outcome));
    check('the previous best survives a capped later candidate (control image keeps its R2 form)', interp[1].outcome.startsWith('R2'));

    // ---- H. cancellation ----------------------------------------------------------
    console.log('\n=== H. cancellation ===');
    const cc = await call('cancel', 'medium', 'compression');
    check('superseded during compression: CANCELLED, nothing produced', cc.code === 'CANCELLED' && !cc.published, JSON.stringify(cc));
    const cw = await call('cancel', 'many-objects', 'writer');
    check('superseded during the writer: CANCELLED, nothing produced', cw.code === 'CANCELLED' && !cw.published && cw.inWriter, JSON.stringify(cw));
    const cn = await call('cancel', 'many-objects', 'no-token');
    probe('without an ownership token the same run would have produced output', cn.published === true, JSON.stringify(cn));

    // ---- I. writer -----------------------------------------------------------------
    console.log('\n=== I. the writer ===');
    const xn = await call('xrefNegatives', 'structure');
    check('the strict xref reader accepts the real output', xn.good.length === 0, xn.good.join(' | '));
    probe('an offset off by one is caught', xn.offset.length > 0, xn.offset[0]);
    probe('a trailer without /Root is caught', xn.root.length > 0, xn.root[0]);
    const w = await call('writer', 'comparator-like');
    check('an output past the ceiling is refused (OVER_OUTPUT_BUDGET)', w.tooSmall === 'OVER_OUTPUT_BUDGET', w.tooSmall);
    check('a write past the ceiling aborts the writer and drops its chunks', w.overflow === 'OVER_OUTPUT_BUDGET' && w.stateAfterOverflow === 'aborted');
    check('an aborted writer cannot finish', w.finishAfterAbort !== null);
    check('finish hands over every chunk and closes the writer',
        w.finished.total === 3 && w.finished.chunks === 2 && w.finished.owned === 2 && w.finished.state === 'finished' && w.writeAfterFinish !== null);
    const d = await call('deterministic', 'structure');
    check('the same input gives the same bytes', d.a && d.a === d.b, `${d.a} / ${d.b}`);

    // ---- J. source-buffer ownership ---------------------------------------------
    console.log('\n=== J. source-buffer ownership ===');
    const own = await call('ownership', 'comparator-like', false);
    check('after the parse, the source buffer is no longer reachable (collected while the run goes on)', own.aliveAfterParse === false, JSON.stringify(own));
    const ownNeg = await call('ownership', 'comparator-like', true);
    probe('a caller that keeps the buffer is seen as keeping it', ownNeg.aliveAfterParse === true, JSON.stringify(ownNeg));

    // ---- existing refusals ------------------------------------------------------------
    console.log('\n=== existing Processor refusals on this path ===');
    const ref = await call('refusals');
    check('an applied signature is refused (SIGNATURE_UNSAFE)', ref['signature-a4'] === 'SIGNATURE_UNSAFE', ref['signature-a4']);
    check('an unreadable PDF is refused (UNSUPPORTED_DOCUMENT)', ref.invalid === 'UNSUPPORTED_DOCUMENT', ref.invalid);
    const led = await call('ledger');
    check('the ledger plans against 3/4 of the preset', led.usable === 384 * 1024 * 1024 && led.fitsBefore === true && led.fitsMore === false);
    check('a commit past the usable share throws OVER_MEMORY_BUDGET and is not recorded',
        led.overCommit === 'OVER_MEMORY_BUDGET' && led.heldAfterRefusal === 300 * 1024 * 1024, JSON.stringify(led));

    // ---- K. RF-31: exact decode, writer reservation --------------------------------
    console.log('\n=== K. Flate must decode exactly; the writer is reserved before it allocates ===');
    const inf = await call('inflate');
    for (const [k2, v] of Object.entries(inf)) check(`inflateExact: ${k2}`, v === true);
    const fi = results['flate-integrity'];
    check('flate-integrity: bad Adler, truncated, expected±1 (Flate) and expected+1 (raw) are all left byte-identical',
        fi && fi.summary.images.filter((i) => !i.rewritten).length === 5 && fi.verdict?.ok,
        fi?.summary.images.map((i) => `${i.objectNumber}:${i.rewritten ? 'R' : '-'}`).join(' '));
    check('flate-integrity: the stream decoding to exactly one 64 KiB pako chunk is rewritten',
        fi?.summary.images.find((i) => i.width === 256)?.rewritten === true);
    const heavyMeta = corpus.find((c) => c.name === 'object-heavy');
    const oh512 = await call('refusal', 'object-heavy', 512);
    check(`object-heavy at 512 MiB: the pre-parse gate admitted it (${heavyMeta.preParseNeed} ≤ ${heavyMeta.usable512})`, heavyMeta.preParseNeed <= heavyMeta.usable512);
    check('object-heavy at 512 MiB: refused OVER_MEMORY_BUDGET by the writer reservation, before the writer allocated',
        oh512.code === 'OVER_MEMORY_BUDGET' && oh512.reachedWrite === true && /書き出し/.test(oh512.message ?? ''), oh512.message);
    const oh1g = await call('refusal', 'object-heavy', 1024);
    check('object-heavy at 1 GiB: the same file is optimized, its output far inside the 256 MiB ceiling',
        oh1g.code === null && oh1g.kind === 'optimized' && oh1g.outputBytes < 256 * 1024 * 1024, `${oh1g.kind} ${oh1g.outputBytes}`);
    const wp = await call('writePlanExact', 'many-objects');
    check('the writer measured without allocating equals what it then wrote', wp.kind === 'optimized' && wp.outputBytes === wp.candidateBytes, `${wp.outputBytes} / ${wp.candidateBytes}`);
    check('no image rewritten → the original File (jpeg-only), no structure-only re-save', results['jpeg-only'].kind === 'unchanged' && results['jpeg-only'].summary.mode === 'none');
    check('the single-file refusal has its own code', led.PLAN_STATUS_SINGLE === 'SINGLE_FILE_ONLY');

    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    const passed = checks.filter((c) => c.ok).length;
    console.log(`\n${passed}/${checks.length} checks passed`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) console.log(`FAILED:\n${failed.map((c) => `  - ${c.name}`).join('\n')}`);
    exitCode = failed.length === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
