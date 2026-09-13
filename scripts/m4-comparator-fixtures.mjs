/**
 * Synthetic drawings for the M4 comparator research.
 *
 * RESEARCH ONLY. Every file is generated here; no customer or real-project
 * document is used, and nothing written by this script is committed
 * (`test-fixtures/` is ignored).
 *
 * The corpus is built around one question: **can a comparison be wrong in a way
 * that looks right?** So most pairs differ in something other than the drawing
 * — paper size, rotation, crop origin, page count — while the drawing itself is
 * identical. A comparator that reports changes on those pairs is reporting its
 * own coordinate handling as a design change, and the user has no way to tell.
 *
 * Run:  node scripts/m4-comparator-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, StandardFonts, rgb, degrees,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm4-comparator');
fs.mkdirSync(OUT, { recursive: true });

/** Paper, in points. */
const SHEET = {
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
    A1: { w: 1683.78, h: 2383.94 },
    A0: { w: 2383.94, h: 3370.39 },
};

const written = [];

/**
 * The same drawing, drawn to fill whatever sheet it is given.
 *
 * Everything is expressed as a fraction of the sheet, so "the same drawing on
 * A1 and on A3" means the same physical picture at two scales — which is what a
 * revision comparison across reissued sheets actually looks like.
 */
function drawPlan(page, size, font, opts = {}) {
    const { w, h } = size;
    const {
        extraLine = false, removeLine = false, offset = 0,
        grey = false, colour = null, pale = false, label = 'PLAN',
        dense = 0, bare = false,
    } = opts;
    const ink = colour ?? (grey ? rgb(0.55, 0.55, 0.55) : rgb(0, 0, 0));
    const lw = w * 0.0025;

    // Border and title block: the repeated features that make automatic
    // alignment plausible and wrong. `bare` leaves them out, so two dense
    // variants share almost no ink at all -- otherwise the shared furniture
    // matches and the neighbourhood search exits early on it.
    if (!bare) {
    page.drawRectangle({
        x: w * 0.05, y: h * 0.05, width: w * 0.9, height: h * 0.9,
        borderColor: ink, borderWidth: lw * 1.5,
    });
    page.drawRectangle({
        x: w * 0.62, y: h * 0.07, width: w * 0.31, height: h * 0.12,
        borderColor: ink, borderWidth: lw,
    });
    page.drawText(label, {
        x: w * 0.64, y: h * 0.15, size: h * 0.014, font, color: ink,
    });

    // A grid, so a shifted comparison has plenty to disagree about.
    for (let i = 1; !bare && i < 6; i++) {
        page.drawLine({
            start: { x: w * 0.05, y: h * (0.25 + i * 0.11) },
            end: { x: w * 0.95, y: h * (0.25 + i * 0.11) },
            thickness: lw, color: ink,
        });
    }
    for (let i = 1; !bare && i < 5; i++) {
        page.drawLine({
            start: { x: w * (0.05 + i * 0.18) + offset, y: h * 0.25 },
            end: { x: w * (0.05 + i * 0.18) + offset, y: h * 0.9 },
            thickness: lw, color: ink,
        });
    }

    }

    // The wall that a revision might move.
    if (!bare && !removeLine) {
        page.drawLine({
            start: { x: w * 0.15, y: h * 0.35 },
            end: { x: w * 0.85, y: h * 0.35 },
            thickness: lw * 3, color: ink,
        });
    }
    if (!bare && extraLine) {
        page.drawLine({
            start: { x: w * 0.15, y: h * 0.60 },
            end: { x: w * 0.85, y: h * 0.60 },
            thickness: lw * 3, color: ink,
        });
    }
    if (dense) {
        // Many short strokes whose positions depend on `dense`, so two sheets
        // drawn with different values share almost no ink. This is the case the
        // comparator exists for and the one its neighbourhood search cannot
        // exit early on: nothing matches, so every pixel runs the full box.
        for (let i = 0; i < 900; i++) {
            const t = (i * 37 + dense * 13) % 100;
            const u = (i * 61 + dense * 29) % 100;
            page.drawLine({
                start: { x: w * (0.07 + t * 0.0086), y: h * (0.27 + u * 0.006) },
                end: { x: w * (0.07 + t * 0.0086) + w * 0.03, y: h * (0.27 + u * 0.006) },
                thickness: lw * 1.5, color: ink,
            });
        }
    }
    if (pale) {
        // Hatch, faint enough to sit near any ink threshold.
        for (let i = 0; i < 20; i++) {
            page.drawLine({
                start: { x: w * 0.15 + i * w * 0.03, y: h * 0.70 },
                end: { x: w * 0.15 + i * w * 0.03, y: h * 0.80 },
                thickness: lw * 0.5, color: rgb(0.82, 0.82, 0.82),
            });
        }
    }
}

/**
 * The same plan, plus the small marks a revision is actually made of.
 *
 * Everything above is a wall: thousands of pixels, impossible to miss. A real
 * revision is often a digit in a dimension, a symbol swapped, a four-millimetre
 * revision triangle — changes of a few dozen pixels on a sheet with eighty
 * thousand. Those are the ones a ratio floor disappears, so they need to exist
 * in the corpus before any floor can be argued about.
 *
 * Kept as a separate family with its own base so that adding it changes none of
 * the numbers already measured against `base-a4`.
 */
function drawSmallChange(page, size, font, opts = {}) {
    const { w, h } = size;
    const {
        dimText = '1200', symbol = 'circle',
        fineLine = false, revisionMark = false, pale = false,
    } = opts;
    const ink = rgb(0, 0, 0);
    const lw = w * 0.0025;
    drawPlan(page, size, font, { pale });

    // A dimension string. One digit of this is the smallest honest change a
    // drawing can carry and still mean something different.
    page.drawText(dimText, {
        x: w * 0.20, y: h * 0.44, size: h * 0.012, font, color: ink,
    });

    // A symbol that a reissue might swap for another symbol.
    if (symbol === 'circle') {
        page.drawCircle({
            x: w * 0.5, y: h * 0.82, size: w * 0.012, borderColor: ink, borderWidth: lw,
        });
    } else {
        page.drawRectangle({
            x: w * 0.5 - w * 0.012, y: h * 0.82 - w * 0.012,
            width: w * 0.024, height: w * 0.024, borderColor: ink, borderWidth: lw,
        });
    }

    // A short fine line: an added dimension leader, thinner than the walls.
    if (fineLine) {
        page.drawLine({
            start: { x: w * 0.30, y: h * 0.50 }, end: { x: w * 0.38, y: h * 0.50 },
            thickness: lw * 0.6, color: ink,
        });
    }

    // The revision triangle itself, about four millimetres on an A4.
    if (revisionMark) {
        const s = w * 0.014;
        const x = w * 0.72;
        const y = h * 0.52;
        for (const [from, to] of [
            [[x, y], [x + s, y]],
            [[x, y], [x + s / 2, y + s]],
            [[x + s, y], [x + s / 2, y + s]],
        ]) {
            page.drawLine({
                start: { x: from[0], y: from[1] }, end: { x: to[0], y: to[1] },
                thickness: lw * 0.8, color: ink,
            });
        }
    }
}

async function make(name, note, build) {
    const doc = await PDFDocument.create();
    doc.setTitle(`M4 ${name}`);
    doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
    doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await build(doc, font);
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
}

// ---------------------------------------------------------------------------
// The same drawing, and honest revisions of it
// ---------------------------------------------------------------------------

await make('base-a4', 'A4, the reference drawing', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font);
});
await make('identical-a4', 'A4, byte-different but pixel-identical drawing', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font);
});
await make('added-line-a4', 'A4 with one wall added — a true change', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { extraLine: true });
});
await make('removed-line-a4', 'A4 with one wall removed — a true change', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { removeLine: true });
});
await make('offset-a4', 'A4, the whole drawing shifted 2pt right', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { offset: 2 });
});

// ---------------------------------------------------------------------------
// Ink that sits near the threshold
// ---------------------------------------------------------------------------

await make('grey-line-a4', 'A4 drawn in mid grey', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { grey: true });
});
await make('colour-line-a4', 'A4 drawn in CAD cyan', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
        { colour: rgb(0, 0.62, 0.85) });
});
await make('pale-hatch-a4', 'A4 with a very light hatch', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { pale: true });
});

// ---------------------------------------------------------------------------
// The same drawing on paper that is not the same
// ---------------------------------------------------------------------------

await make('base-a3', 'A3, the same drawing at a different physical size', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A3.w, SHEET.A3.h]), SHEET.A3, font);
});
await make('base-a1', 'A1, the same drawing at a different physical size', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A1.w, SHEET.A1.h]), SHEET.A1, font);
});
await make('base-a0', 'A0, for the render budget', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A0.w, SHEET.A0.h]), SHEET.A0, font);
});
await make('landscape-a4', 'A4 turned on its side, same drawing', async (doc, font) => {
    const size = { w: SHEET.A4.h, h: SHEET.A4.w };
    drawPlan(doc.addPage([size.w, size.h]), size, font);
});
await make('nearly-a4', 'a sheet 3pt wider than A4 — a generator tolerance', async (doc, font) => {
    const size = { w: SHEET.A4.w + 3, h: SHEET.A4.h + 3 };
    drawPlan(doc.addPage([size.w, size.h]), size, font);
});
await make('same-ratio-larger', 'A4 proportions at 1.4x — same aspect, different sheet',
    async (doc, font) => {
        const size = { w: SHEET.A4.w * 1.4, h: SHEET.A4.h * 1.4 };
        drawPlan(doc.addPage([size.w, size.h]), size, font);
    });

// ---------------------------------------------------------------------------
// The same drawing, described differently
// ---------------------------------------------------------------------------

for (const angle of [0, 90, 180, 270]) {
    await make(`rotate-${angle}`, `the same A4 drawing at /Rotate ${angle}`, async (doc, font) => {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawPlan(page, SHEET.A4, font);
        page.setRotation(degrees(angle));
    });
}

await make('crop-origin-0', 'CropBox at (0,0), 495x741 of an A4', async (doc, font) => {
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawPlan(page, SHEET.A4, font);
    page.setCropBox(0, 0, 495, 741);
});
await make('crop-origin-50-70', 'the same visible region, CropBox at (50,70)',
    async (doc, font) => {
        // Everything is drawn 50/70 further along, and the box moves with it, so
        // the *visible* region is the same picture as crop-origin-0. Only the
        // coordinates describing it differ -- which is the whole point: a
        // comparator that ignores the crop origin will see this as a shift.
        const page = doc.addPage([SHEET.A4.w + 50, SHEET.A4.h + 70]);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 50, 70));
        drawPlan(page, SHEET.A4, font);
        page.pushOperators(popGraphicsState());
        page.setCropBox(50, 70, 495, 741);
    });
await make('mediabox-larger', 'MediaBox bigger than the CropBox, same visible drawing',
    async (doc, font) => {
        const page = doc.addPage([SHEET.A4.w + 200, SHEET.A4.h + 200]);
        drawPlan(page, SHEET.A4, font);
        page.setCropBox(0, 0, SHEET.A4.w, SHEET.A4.h);
    });

// A second copy at /Rotate 0, so "0 against 0" is a real pair of documents
// rather than a document compared with itself.
await make('rotate-0-copy', 'a second copy of the same A4 drawing at /Rotate 0',
    async (doc, font) => {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        drawPlan(page, SHEET.A4, font);
        page.setRotation(degrees(0));
    });

// Crop origin *and* rotation together. Either alone is recoverable; the pair is
// where a mapping computed in the display plane goes anisotropic, so the
// canonical upright normalisation has to be shown on exactly these.
for (const angle of [90, 180, 270]) {
    await make(`crop-rot-${angle}`, `the crop-origin region at /Rotate ${angle}`,
        async (doc, font) => {
            const page = doc.addPage([SHEET.A4.w + 50, SHEET.A4.h + 70]);
            page.pushOperators(
                pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 50, 70),
            );
            drawPlan(page, SHEET.A4, font);
            page.pushOperators(popGraphicsState());
            page.setCropBox(50, 70, 495, 741);
            page.setRotation(degrees(angle));
        });
}

// ---------------------------------------------------------------------------
// Changes small enough for a ratio floor to swallow
// ---------------------------------------------------------------------------
//
// A wall is 9.6% of the ink. A digit is not. Every fixture here is a *true*
// change to the drawing, small enough that a global "under half a percent is a
// match" rule would report it as unchanged -- which is the failure a floor
// introduces, and the reason one cannot be picked by intuition.
//
// `small-base-copy` is the control: a redraw with nothing changed, so the
// difference between "too small to see" and "nothing there" stays measurable.

await make('small-base', 'the reference sheet for the small-change set', async (doc, font) => {
    drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font);
});
await make('small-base-copy', 'the same sheet redrawn — the render-variance control',
    async (doc, font) => {
        drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font);
    });
await make('small-digit', 'one digit of a dimension changed: 1200 becomes 1300',
    async (doc, font) => {
        drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
            { dimText: '1300' });
    });
await make('small-fine-line', 'one short fine line added', async (doc, font) => {
    drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
        { fineLine: true });
});
await make('small-symbol', 'the symbol swapped from a circle to a square',
    async (doc, font) => {
        drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
            { symbol: 'square' });
    });
await make('small-revision-mark', 'a 4mm revision triangle added', async (doc, font) => {
    drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
        { revisionMark: true });
});
await make('small-hatch', 'a light hatch added to the same sheet', async (doc, font) => {
    drawSmallChange(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { pale: true });
});

// ---------------------------------------------------------------------------
// Three and four members
// ---------------------------------------------------------------------------
//
// The shipped rule marks an ink pixel matched when **any other layer** has ink
// near it. With four members that lets two agreeing pairs cancel out: A and B
// agree about a wall in one place, C and D agree about a wall in another, and
// every pixel finds a partner. The comparison comes back looking clean.
//
// `wall-at-y` is the same plan with the wall in the second position rather than
// the first, so a two-against-two split can be built from these.

await make('base-a4-copy', 'a second copy of the reference, for 3- and 4-way sets',
    async (doc, font) => {
        drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font);
    });
await make('wall-at-y-a4', 'the wall in the second position instead of the first',
    async (doc, font) => {
        drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
            { removeLine: true, extraLine: true });
    });
await make('wall-at-y-a4-copy', 'a second copy of that, for the two-against-two split',
    async (doc, font) => {
        drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
            { removeLine: true, extraLine: true });
    });

// ---------------------------------------------------------------------------
// Drawings that mostly do not match
// ---------------------------------------------------------------------------
//
// Every threshold cost measured so far is a floor: `hasNeighborInAny` returns on
// the first ink it finds, so a wider search finds a match *sooner* on a drawing
// whose marks mostly agree. These two share the border and grid and almost
// nothing else, so the search runs to completion on nearly every ink pixel --
// which is the worst case, and the case the comparator exists for.

await make('dense-a', 'a dense drawing, no shared furniture, variant A', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
        { dense: 1, bare: true });
});
await make('dense-b', 'the same sheet with the marks somewhere else', async (doc, font) => {
    drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font,
        { dense: 5, bare: true });
});

// ---------------------------------------------------------------------------
// Sheets that differ by less than a point
// ---------------------------------------------------------------------------
//
// The tolerance for calling two sheets the same has to be a number, and the
// number has to be probed either side rather than asserted.

for (const [name, delta] of [['sheet-plus-0-99', 0.99], ['sheet-plus-1-01', 1.01]]) {
    await make(name, `A4 plus ${delta}pt`, async (doc, font) => {
        const size = { w: SHEET.A4.w + delta, h: SHEET.A4.h + delta };
        drawPlan(doc.addPage([size.w, size.h]), size, font);
    });
}

// ---------------------------------------------------------------------------
// Page counts, and the difference between blank and absent
// ---------------------------------------------------------------------------

await make('three-pages', 'three pages of the same drawing', async (doc, font) => {
    for (const n of [1, 2, 3]) {
        drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { label: `PLAN ${n}` });
    }
});
await make('two-pages', 'the same, but page 3 does not exist', async (doc, font) => {
    for (const n of [1, 2]) {
        drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { label: `PLAN ${n}` });
    }
});
await make('three-pages-blank-third', 'three pages, the third deliberately blank',
    async (doc, font) => {
        for (const n of [1, 2]) {
            drawPlan(doc.addPage([SHEET.A4.w, SHEET.A4.h]), SHEET.A4, font, { label: `PLAN ${n}` });
        }
        doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    });

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({
    files: written, sheets: SHEET,
}, null, 2)}\n`);

for (const f of written) {
    console.log(`  ${f.name.padEnd(24)} ${String(f.bytes).padStart(7)} bytes  ${f.note}`);
}
console.log(`\n  wrote ${written.length} fixtures to test-fixtures/m4-comparator/\n`);
