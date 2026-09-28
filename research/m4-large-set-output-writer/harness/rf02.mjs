/**
 * RF-02: the Comparison PDF feature surface, driven by the production engine.
 *
 * `planComparison` + `runComparison` run unmodified (the only shim is
 * `document.createElement('canvas')` -> @napi-rs/canvas, and
 * `window` -> globalThis with a timer-based requestAnimationFrame), over the RF-02
 * synthetic members, for 2, 3 and 4 members. Each pair and page event is teed
 * to (1) the candidate writer and then (2) the production jsPDF sink, in that
 * order because the production sink releases the pixels.
 *
 * The candidate writes pairs as 4-bit Indexed through the owned bounded
 * encoder (the recommended safety-authoritative path) and notices as DeviceRGB
 * through the same encoder, drawn by production `drawNotice`.
 *
 * Checks on reopen (pdf.js + pdf-lib), per run:
 *   - page sequence == expectedSequence(members), derived from the fixture spec
 *     alone: exact count, source-page then slot order, notices in place, no
 *     pair omitted or duplicated, MATCH / CHANGE labels
 *   - page size == frame / scale (pairs) or notice / 2, orientation == sheet
 *   - decoded image pixels hash-equal to what the engine produced
 *   - the production jsPDF artifact of the same run has the same sequence,
 *     sizes, texts and image dimensions
 *
 * Run: node harness/rf02.mjs [--dpi 150]  -> prints JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { ChunkedPdfWriter } from './pdf-writer.mjs';
import { statePalette, indexedRowsFromComposite, rgbRows, encodeIndexedOwned, encodeRgbOwned } from './encoders.mjs';
import { makeRf02Corpus, expectedSequence, SHEETS } from '../corpus/make-rf02-corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);
const OUTDIR = path.join(ROOT, 'out', 'rf02');
fs.mkdirSync(OUTDIR, { recursive: true });
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : f; };
const DPI = Number(arg('dpi', '150'));

// taskBoundary (mask.ts:271) yields with window.setTimeout. Once `window`
// exists pdf.js takes its browser path and schedules with requestAnimationFrame,
// so that is provided too (a timer task, as in a background tab).
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.document = {
    createElement(tag) {
        if (tag !== 'canvas') throw new Error(`shim: only canvas, not ${tag}`);
        return createCanvas(1, 1);
    },
};

// PdfComparator.tsx:34-37, 61-62.
const SLOT_RGB = [[0, 0, 1], [1, 0, 0], [0, 0.5, 0], [0.9, 0.7, 0]];
const MATCH_COLOR = [0xC0 / 255, 0xC0 / 255, 0xC0 / 255];
const MATCH_OPACITY = 0.7;

const rgbHash = (rgba) => {
    const h = crypto.createHash('sha256');
    const row = Buffer.alloc(3 * 4096);
    for (let p = 0; p < rgba.length;) {
        let o = 0;
        for (; o < row.length && p < rgba.length; p += 4, o += 3) {
            row[o] = rgba[p]; row[o + 1] = rgba[p + 1]; row[o + 2] = rgba[p + 2];
        }
        h.update(row.subarray(0, o));
    }
    return h.digest('hex').slice(0, 16);
};
const rgbHashOf3 = (rgb) => crypto.createHash('sha256').update(rgb).digest('hex').slice(0, 16);

function candidateSink(members, dpi) {
    const writer = new ChunkedPdfWriter();
    const scale = dpi / 72;
    const log = [];
    const colorBySlot = new Map(members.map((m) => [m.slot, m.color]));
    const refColor = members[0].color;
    return {
        log,
        onPair(pair) {
            if (!pair.pixels) throw new Error('pair without pixels');
            const palette = statePalette(prod.paintPair, refColor, colorBySlot.get(pair.slot), MATCH_COLOR, MATCH_OPACITY);
            const image = encodeIndexedOwned(indexedRowsFromComposite(pair.pixels, pair.width, pair.height, palette, 4), palette, 4, { predictor: 2 });
            const widthPt = pair.width / scale;
            const heightPt = pair.height / scale;
            writer.addImagePage({ widthPt, heightPt, image, title: `${pair.title} — ${pair.verdict}` });
            log.push({
                kind: 'PAIR', page: pair.page, slot: pair.slot, label: pair.label, verdict: pair.verdict,
                width: pair.width, height: pair.height, widthPt, heightPt, hash: rgbHash(pair.pixels),
                encodedBytes: image.encodedBytes, bound: image.bound, withinBound: image.encodedBytes <= image.bound,
            });
        },
        onPage(page) {
            if (page.status === prod.PLAN.READY_TO_COMPARE) return;
            const raster = prod.NOTICE_RASTER.COMPARISON_PDF;
            const pixels = prod.drawNotice(prod.noticeLines(page), raster);
            const image = encodeRgbOwned(rgbRows(pixels, raster.width, raster.height), { predictor: 2 });
            // Same placement as artifacts.ts:219-220; no text on a notice page.
            writer.addImagePage({ widthPt: raster.width / 2, heightPt: raster.height / 2, image, title: '' });
            log.push({
                kind: page.status, page: page.page, slot: null, width: raster.width, height: raster.height,
                widthPt: raster.width / 2, heightPt: raster.height / 2, hash: rgbHash(pixels),
                encodedBytes: image.encodedBytes, bound: image.bound, withinBound: image.encodedBytes <= image.bound,
            });
        },
        finish: () => writer.finish(),
    };
}

async function reopen(bytes) {
    const lib = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isOffscreenCanvasSupported: false, verbosity: 0, stopAtErrors: true }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const [, , w, h] = page.view;
        const text = (await page.getTextContent()).items.map((i) => i.str).join(' ').trim();
        const ops = await page.getOperatorList();
        const names = [];
        ops.fnArray.forEach((fn, i) => { if (fn === pdfjs.OPS.paintImageXObject) names.push(ops.argsArray[i][0]); });
        const img = await new Promise((r) => page.objs.get(names[0], r));
        let rgb = img.data;
        if (img.kind === 3) {
            rgb = new Uint8Array(img.width * img.height * 3);
            for (let p = 0, q = 0; p < img.data.length; p += 4, q += 3) { rgb[q] = img.data[p]; rgb[q + 1] = img.data[p + 1]; rgb[q + 2] = img.data[p + 2]; }
        }
        pages.push({ w: +w.toFixed(3), h: +h.toFixed(3), text, images: names.length, imgW: img.width, imgH: img.height, hash: rgbHashOf3(rgb) });
        page.cleanup();
    }
    await doc.destroy();
    return { pdfLibPages: lib.getPageCount(), pages };
}

const normalise = (s) => s.replace(/\s+/g, ' ').replace(/—/g, '-').trim();

async function run(memberNames, files) {
    const members = [];
    for (const [i, m] of memberNames.entries()) {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(files[m])), isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
        members.push({ slot: i, label: `rf02-${m}.pdf`, pdf, color: SLOT_RGB[i] });
    }
    const settings = {
        pages: [1, 2, 3, 4, 5], dpi: DPI, toleranceMm: 0, memoryBudgetBytes: 2048 * 2 ** 20,
        matchColor: MATCH_COLOR, matchOpacity: MATCH_OPACITY, artifact: prod.ARTIFACT.COMPARISON_PDF,
    };
    const plan = await prod.planComparison(members, settings);
    const cand = candidateSink(members, DPI);
    const cur = prod.createComparisonPdf(DPI);
    const result = await prod.runComparison(plan, members, { isCancelled: () => false, isOwner: () => true }, {
        onPair: async (pair) => { cand.onPair(pair); cur.onPair(pair); },
        onPage: async (page) => { cand.onPage(page); cur.onPage(page); },
    });
    const tag = `${memberNames.length}m`;
    const candChunks = cand.finish();
    const candBytes = new Uint8Array(candChunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of candChunks) { candBytes.set(c, o); o += c.length; }
    const curBytes = new Uint8Array(cur.doc.output('arraybuffer'));
    fs.writeFileSync(path.join(OUTDIR, `candidate-${tag}.pdf`), candBytes);
    fs.writeFileSync(path.join(OUTDIR, `current-${tag}.pdf`), curBytes);
    const c = await reopen(candBytes);
    const j = await reopen(curBytes);
    for (const m of members) await m.pdf.destroy();

    const expected = expectedSequence(memberNames);
    const errors = [];
    const planStatuses = plan.pages.map((p) => `${p.page}:${p.status}`);
    if (plan.refusal) errors.push(`plan refused: ${plan.refusal.status}`);
    if (result.status === prod.PLAN.CANCELLED || result.abandoned) errors.push('run abandoned');
    if (result.status === prod.PLAN.RENDER_FAILED) errors.push(`render failed: ${result.pages.flatMap((p) => p.reported).join(' / ')}`);
    if (c.pages.length !== expected.length) errors.push(`candidate pages ${c.pages.length} != expected ${expected.length}`);
    if (c.pdfLibPages !== c.pages.length) errors.push('pdf-lib / pdf.js page count disagree');
    if (j.pages.length !== expected.length) errors.push(`jsPDF pages ${j.pages.length} != expected ${expected.length}`);
    const seen = new Set();
    expected.forEach((e, i) => {
        const L = cand.log[i];
        const P = c.pages[i];
        const J = j.pages[i];
        const where = `#${i + 1} p${e.page}`;
        if (!L || !P) { errors.push(`${where} missing`); return; }
        const key = `${L.kind}:${L.page}:${L.slot}`;
        if (seen.has(key)) errors.push(`${where} duplicate ${key}`);
        seen.add(key);
        if (L.kind !== (e.kind === 'PAIR' ? 'PAIR' : e.kind) || L.page !== e.page) errors.push(`${where} is ${L.kind} p${L.page}, expected ${e.kind}`);
        const sheet = SHEETS[e.page - 1];
        if (e.kind === 'PAIR') {
            const want = `p${e.page}: rf02-A.pdf vs rf02-${e.member}.pdf - ${e.verdict}`;
            if (normalise(P.text) !== want) errors.push(`${where} text "${P.text}" != "${want}"`);
            if (L.slot !== e.slot) errors.push(`${where} slot ${L.slot} != ${e.slot}`);
            if (Math.abs(P.w - sheet[0]) > 72 / DPI + 0.01 || Math.abs(P.h - sheet[1]) > 72 / DPI + 0.01) errors.push(`${where} size ${P.w}x${P.h} vs sheet ${sheet}`);
            if ((P.w > P.h) !== (sheet[0] > sheet[1])) errors.push(`${where} orientation`);
        } else {
            if (P.text !== '') errors.push(`${where} notice carries text "${P.text}"`);
            if (P.w !== 620 || P.h !== 877) errors.push(`${where} notice size ${P.w}x${P.h}`);
        }
        if (Math.abs(P.w - L.widthPt) > 0.001 || Math.abs(P.h - L.heightPt) > 0.001) errors.push(`${where} page size != writer's`);
        if (P.imgW !== L.width || P.imgH !== L.height) errors.push(`${where} image ${P.imgW}x${P.imgH}`);
        if (P.hash !== L.hash) errors.push(`${where} decoded pixels differ from the engine's (${P.hash} vs ${L.hash})`);
        if (P.images !== 1) errors.push(`${where} ${P.images} images`);
        if (!L.withinBound) errors.push(`${where} encoded over the owned bound`);
        if (J) {
            if (Math.abs(J.w - P.w) > 0.01 || Math.abs(J.h - P.h) > 0.01) errors.push(`${where} jsPDF size ${J.w}x${J.h} != candidate ${P.w}x${P.h}`);
            if (normalise(J.text) !== normalise(P.text)) errors.push(`${where} jsPDF text "${J.text}" != "${P.text}"`);
            if (J.imgW !== P.imgW || J.imgH !== P.imgH) errors.push(`${where} jsPDF image dims differ`);
            if (J.hash !== P.hash) errors.push(`${where} jsPDF decoded pixels differ from candidate`);
        }
    });
    return {
        members: memberNames.length, dpi: DPI, planStatuses,
        runStatus: result.status, runReported: result.pages.flatMap((p) => p.reported),
        expected: expected.map((e) => (e.kind === 'PAIR' ? `p${e.page}/${e.member}/${e.verdict}` : `p${e.page}/${e.kind}`)),
        candidate: cand.log.map((l) => (l.kind === 'PAIR' ? `p${l.page}/s${l.slot}/${l.verdict}` : `p${l.page}/${l.kind}`)),
        candidateBytes: candBytes.length, jsPdfBytes: curBytes.length,
        pages: c.pages.map((p, i) => ({ size: `${p.w}x${p.h}`, image: `${p.imgW}x${p.imgH}`, hash: p.hash, encodedBytes: cand.log[i]?.encodedBytes, bound: cand.log[i]?.bound })),
        errors, ok: errors.length === 0,
    };
}

const files = await makeRf02Corpus();
const out = [];
for (const names of [['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) out.push(await run(names, files));
console.log(JSON.stringify({ dpi: DPI, runs: out, ok: out.every((r) => r.ok) }));
