/**
 * Stage 1: the comparison result, exactly as production computes it.
 *
 * Renders both synthetic sets with pdf.js (legacy build, @napi-rs/canvas) at
 * the requested DPI, then runs the unmodified production kernel functions from
 * the esbuild bundle of src/utils/comparator (inkMask, dilateMask,
 * pairChangeMask, verdictFor, changeBounds, paintPair). Writes, per page:
 *   composite.rgba  - the RGBA composite production would hand its sink
 *   ref.mask / oth.mask - the ink masks (for the direct-from-mask paint test)
 *   meta.json       - frame, verdict, change/ink pixels, bounds, timings
 *
 * The composite is the fixed input of every writer candidate in stage 2, so
 * writers are compared on identical pixels and the verdict is decided here,
 * before any output encoding exists.
 *
 * Run: node harness/prepare.mjs --dpi 150 [--tolerance-mm 0]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'out');
const prod = await import(path.join(OUT, 'prod.mjs').replace(/\\/g, '/').replace(/^/, 'file:///'));

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};
const DPI = Number(arg('dpi', '150'));
const TOL_MM = Number(arg('tolerance-mm', '0'));
const TAG = arg('tag', `dpi${DPI}${TOL_MM ? `-tol${TOL_MM}` : ''}`);
const DIR = path.join(OUT, 'composites', TAG);
fs.mkdirSync(DIR, { recursive: true });

// Production defaults (PdfComparator.tsx:34-35, 61-62; hexToRgb /255).
const REF_COLOR = [0, 0, 1];
const OTH_COLOR = [1, 0, 0];
const MATCH_COLOR = [0xC0 / 255, 0xC0 / 255, 0xC0 / 255];
const MATCH_OPACITY = 0.7;

async function load(file) {
    const data = new Uint8Array(fs.readFileSync(file));
    return pdfjs.getDocument({ data, isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
}

async function renderRgba(pdf, n, scale) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale, rotation: 0 });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const rgba = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 1;
    canvas.height = 1;
    page.cleanup();
    return { rgba, w, h };
}

const scale = DPI / 72;
const radius = prod.pixelRadiusFor(TOL_MM, DPI);
const a = await load(path.join(OUT, 'corpus', 'a1-set-A.pdf'));
const b = await load(path.join(OUT, 'corpus', 'a1-set-B.pdf'));
const summary = [];
for (let n = 1; n <= a.numPages; n += 1) {
    const t0 = performance.now();
    const ra = await renderRgba(a, n, scale);
    const refMask = prod.inkMask(ra.rgba, ra.w, ra.h);
    ra.rgba = null;
    const rb = await renderRgba(b, n, scale);
    if (rb.w !== ra.w || rb.h !== ra.h) throw new Error(`frame mismatch p${n}`);
    const othMask = prod.inkMask(rb.rgba, rb.w, rb.h);
    rb.rgba = null;
    const t1 = performance.now();
    const { w, h } = ra;
    const dRef = prod.dilateMask(refMask, w, h, radius);
    const dOth = prod.dilateMask(othMask, w, h, radius);
    const cm = prod.pairChangeMask(refMask, othMask, dRef, dOth);
    const verdict = prod.verdictFor(cm);
    const bounds = prod.changeBounds(refMask, othMask, dRef, dOth, w, h);
    const composite = prod.paintPair(
        refMask, othMask, dRef, dOth, REF_COLOR, OTH_COLOR, w, h, MATCH_COLOR, MATCH_OPACITY,
    );
    const t2 = performance.now();

    const pageDir = path.join(DIR, `p${n}`);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'composite.rgba'), composite);
    fs.writeFileSync(path.join(pageDir, 'ref.mask'), refMask);
    fs.writeFileSync(path.join(pageDir, 'oth.mask'), othMask);
    const colours = new Map();
    for (let i = 0; i < composite.length; i += 4) {
        const k = (composite[i] << 16) | (composite[i + 1] << 8) | composite[i + 2];
        colours.set(k, (colours.get(k) ?? 0) + 1);
    }
    const meta = {
        page: n, dpi: DPI, toleranceMm: TOL_MM, radiusPx: radius,
        width: w, height: h, pixels: w * h,
        pageWidthPt: w / scale, pageHeightPt: h / scale,
        verdict, changePixels: cm.changePixels, inkPixels: cm.inkPixels, bounds,
        distinctColours: colours.size,
        colourHistogram: [...colours.entries()].sort((x, y) => y[1] - x[1])
            .map(([k, c]) => ({ rgb: `#${k.toString(16).padStart(6, '0')}`, pixels: c })),
        renderAndMaskMs: Math.round(t1 - t0),
        compareAndPaintMs: Math.round(t2 - t1),
    };
    fs.writeFileSync(path.join(pageDir, 'meta.json'), JSON.stringify(meta, null, 2));
    summary.push(meta);
    console.log(`p${n} ${w}x${h} ${verdict} change=${cm.changePixels} ink=${cm.inkPixels} colours=${colours.size} render=${meta.renderAndMaskMs}ms paint=${meta.compareAndPaintMs}ms`);
}
fs.writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(summary, null, 2));
