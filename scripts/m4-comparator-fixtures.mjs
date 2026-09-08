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
    } = opts;
    const ink = colour ?? (grey ? rgb(0.55, 0.55, 0.55) : rgb(0, 0, 0));
    const lw = w * 0.0025;

    // Border and title block: the repeated features that make automatic
    // alignment plausible and wrong.
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
    for (let i = 1; i < 6; i++) {
        page.drawLine({
            start: { x: w * 0.05, y: h * (0.25 + i * 0.11) },
            end: { x: w * 0.95, y: h * (0.25 + i * 0.11) },
            thickness: lw, color: ink,
        });
    }
    for (let i = 1; i < 5; i++) {
        page.drawLine({
            start: { x: w * (0.05 + i * 0.18) + offset, y: h * 0.25 },
            end: { x: w * (0.05 + i * 0.18) + offset, y: h * 0.9 },
            thickness: lw, color: ink,
        });
    }

    // The wall that a revision might move.
    if (!removeLine) {
        page.drawLine({
            start: { x: w * 0.15, y: h * 0.35 },
            end: { x: w * 0.85, y: h * 0.35 },
            thickness: lw * 3, color: ink,
        });
    }
    if (extraLine) {
        page.drawLine({
            start: { x: w * 0.15, y: h * 0.60 },
            end: { x: w * 0.85, y: h * 0.60 },
            thickness: lw * 3, color: ink,
        });
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
