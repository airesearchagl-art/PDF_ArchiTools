/**
 * Synthetic documents for the 半透明レイヤ追加 optional-content gate.
 *
 * Every file is generated here; none is a customer or project document, and
 * nothing written by this script is committed (`test-fixtures/` is ignored).
 *
 * The documents carry what the overlay must leave alone — existing layers in
 * every state, a layer already called what the overlay is called, a
 * `/Properties` name the overlay would like to use, annotations (one of them in
 * a layer), a link, a form field, text and metadata — on pages that are
 * rotated, offset and cropped. The ones that end in a refusal are listed with
 * the reason the planner must give.
 *
 * Run:  node scripts/make-processor-ocg-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFName, PDFString, PDFHexString, PDFOperator, PDFOperatorNames,
    StandardFonts, rgb, degrees,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'processor-ocg');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/** The name the overlay layer is given, as `src/utils/processor/optional-content.ts` states it. */
export const OVERLAY_NAME = 'PDF ArchiTools 半透明オーバーレイ';

const A4 = { w: 595.28, h: 841.89 };
const A3_LANDSCAPE = { w: 1190.55, h: 841.89 };
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const corpus = [];

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setAuthor('OCG author');
    doc.setSubject('OCG subject');
    doc.setCreator('OCG creator');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, font };
}

/**
 * @param expect `ready`, or the plan code the planner must refuse with
 * @param reason a phrase the refusal must contain
 */
async function write(name, doc, note, expect = 'ready', reason = null) {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    corpus.push({ name, bytes: bytes.length, note, expect, reason });
    return bytes;
}

const hex = (text) => PDFHexString.fromText(text);

/** A drawing inside `box` ({x, y, w, h} in page space): border, grid, a wall, a corner mark. */
function drawVector(page, box) {
    const { x, y, w, h } = box;
    const lw = Math.max(0.6, w * 0.002);
    page.drawRectangle({
        x: x + w * 0.05, y: y + h * 0.05, width: w * 0.9, height: h * 0.9,
        borderColor: rgb(0, 0, 0), borderWidth: lw * 2,
    });
    for (let i = 1; i < 6; i += 1) {
        page.drawLine({
            start: { x: x + w * 0.05, y: y + h * (0.2 + i * 0.1) },
            end: { x: x + w * 0.95, y: y + h * (0.2 + i * 0.1) },
            thickness: lw, color: rgb(0.1, 0.2, 0.85),
        });
    }
    page.drawLine({
        start: { x: x + w * 0.15, y: y + h * 0.35 }, end: { x: x + w * 0.85, y: y + h * 0.35 },
        thickness: lw * 4, color: rgb(0.85, 0.1, 0.1),
    });
    page.drawRectangle({
        x: x + w * 0.07, y: y + h * 0.85, width: w * 0.12, height: h * 0.02, color: rgb(0, 0.5, 0),
    });
}

const drawText = (page, font, box, marker, at = 0.12) => page.drawText(marker, {
    x: box.x + box.w * 0.12, y: box.y + box.h * at, size: 14, font, color: rgb(0, 0, 0),
});

function addAnnots(doc, page, dicts) {
    const refs = dicts.map((d) => doc.context.register(doc.context.obj(d)));
    const arr = doc.context.obj([]);
    for (const r of refs) arr.push(r);
    page.node.set(PDFName.of('Annots'), arr);
    return refs;
}

/** A Square annotation with its own opaque appearance, so every reader draws the same pixels. */
function opaqueSquare(doc, rect, [r, g, b], extra = {}) {
    const width = rect[2] - rect[0];
    const height = rect[3] - rect[1];
    const appearance = doc.context.register(doc.context.stream(
        `${r} ${g} ${b} rg 0 0 ${width} ${height} re f`,
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height] },
    ));
    return {
        Type: 'Annot', Subtype: 'Square', Rect: rect, C: [r, g, b], IC: [r, g, b], F: 4,
        AP: { N: appearance }, ...extra,
    };
}

function newGroup(doc, name) {
    return doc.context.register(doc.context.obj({ Type: 'OCG', Name: hex(name) }));
}

/** Name `groups` ({key: ref}) in the page's /Properties. */
function setProperties(doc, page, groups) {
    const { Resources } = page.node.normalizedEntries();
    Resources.set(PDFName.of('Properties'), doc.context.obj(groups));
}

function inGroup(page, key, draw) {
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(key)]));
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
}

const setBoxes = (doc, page, media, crop = media) => {
    page.node.set(PDFName.of('MediaBox'), doc.context.obj(media));
    page.node.set(PDFName.of('CropBox'), doc.context.obj(crop));
};
const boxOf = ([x0, y0, x1, y1]) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

// ---------------------------------------------------------------------------
// No layers yet: five pages, rotated, offset, cropped, with the structure that
// must come through untouched.
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('OCG multi-page');

    const p1 = doc.addPage([A4.w, A4.h]);
    const box1 = { x: 0, y: 0, ...A4 };
    drawVector(p1, box1);
    drawText(p1, font, box1, 'OCG-PAGE-1');
    const field = doc.getForm().createTextField('ocg.field');
    field.setText('OCG-FIELD-VALUE');
    field.addToPage(p1, { x: 340, y: 160, width: 180, height: 24, font });
    const annots1 = [
        opaqueSquare(doc, [120, 400, 300, 520], [0, 0, 1], { T: PDFString.of('OCG-SQUARE') }),
        { Type: 'Annot', Subtype: 'Text', Rect: [320, 460, 340, 480], Contents: PDFString.of('OCG-NOTE'), F: 4 },
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 700, 300, 720], Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.invalid/ocg') },
        },
    ];
    // The form widget pdf-lib placed is kept alongside.
    const existing = p1.node.lookup(PDFName.of('Annots'));
    const refs = annots1.map((d) => doc.context.register(doc.context.obj(d)));
    for (const r of refs) existing.push(r);

    const p2 = doc.addPage([A3_LANDSCAPE.w, A3_LANDSCAPE.h]);
    const box2 = { x: 0, y: 0, ...A3_LANDSCAPE };
    drawVector(p2, box2);
    drawText(p2, font, box2, 'OCG-PAGE-2');

    const p3 = doc.addPage([A4.w, A4.h]);
    setBoxes(doc, p3, [100, 150, 100 + A4.w, 150 + A4.h], [130, 190, 660, 950]);
    drawVector(p3, boxOf([130, 190, 660, 950]));
    drawText(p3, font, boxOf([130, 190, 660, 950]), 'OCG-PAGE-3');
    p3.setRotation(degrees(90));

    const p4 = doc.addPage([A4.w, A4.h]);
    setBoxes(doc, p4, [-50, -80, -50 + A4.w, -80 + A4.h]);
    drawVector(p4, boxOf([-50, -80, -50 + A4.w, -80 + A4.h]));
    drawText(p4, font, boxOf([-50, -80, -50 + A4.w, -80 + A4.h]), 'OCG-PAGE-4');
    p4.setRotation(degrees(180));

    const p5 = doc.addPage([A4.w, A4.h]);
    setBoxes(doc, p5, [0, 0, A4.w, A4.h], [40, 40, A4.w - 40, A4.h - 40]);
    drawVector(p5, boxOf([40, 40, A4.w - 40, A4.h - 40]));
    drawText(p5, font, boxOf([40, 40, A4.w - 40, A4.h - 40]), 'OCG-PAGE-5');
    p5.setRotation(degrees(270));

    await write('ocg-plain-multi', doc,
        'five pages (A4, A3 landscape, rotated 90/180/270, MediaBox and CropBox offsets), annotations, a link and a field');
}

// ---------------------------------------------------------------------------
// Existing layers in every state, and the names the overlay would collide with.
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('OCG existing layers');
    const a = newGroup(doc, '既存レイヤ A（表示）');
    const b = newGroup(doc, '既存レイヤ B（非表示）');
    const c = newGroup(doc, OVERLAY_NAME);

    const p1 = doc.addPage([A4.w, A4.h]);
    const box = { x: 0, y: 0, ...A4 };
    drawVector(p1, box);
    drawText(p1, font, box, 'OCG-EXISTING-1');
    // `PATOverlay` is the name the overlay asks for first; here it already means C.
    setProperties(doc, p1, { OCA: a, OCB: b, PATOverlay: c });
    inGroup(p1, 'OCA', () => {
        p1.drawRectangle({ x: 60, y: 600, width: 200, height: 100, color: rgb(0.9, 0.1, 0.1) });
        p1.drawText('LAYER-A-TEXT', { x: 70, y: 580, size: 12, font, color: rgb(0.9, 0.1, 0.1) });
    });
    inGroup(p1, 'OCB', () => {
        p1.drawRectangle({ x: 300, y: 600, width: 200, height: 100, color: rgb(0.1, 0.1, 0.9) });
    });
    inGroup(p1, 'PATOverlay', () => {
        p1.drawRectangle({ x: 60, y: 450, width: 200, height: 100, color: rgb(0.1, 0.7, 0.1) });
    });
    addAnnots(doc, p1, [
        opaqueSquare(doc, [320, 420, 500, 520], [0.8, 0, 0.8]),
        opaqueSquare(doc, [320, 300, 500, 400], [0, 0.7, 0.7], { OC: b }),
    ]);

    const p2 = doc.addPage([A4.w, A4.h]);
    drawVector(p2, box);
    drawText(p2, font, box, 'OCG-EXISTING-2');
    setProperties(doc, p2, { OCA: a });
    inGroup(p2, 'OCA', () => {
        p2.drawRectangle({ x: 300, y: 300, width: 150, height: 150, color: rgb(0.9, 0.5, 0) });
    });

    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [a, b, c],
        D: {
            Name: hex('既定の表示'),
            Order: [a, [hex('グループ'), b], c],
            OFF: [b],
            Locked: [a],
            AS: [{ Event: 'Print', OCGs: [b], Category: ['Print'] }],
        },
        Configs: [{ Name: hex('別設定'), BaseState: 'OFF', ON: [a], Order: [a, b, c] }],
    }));
    await write('ocg-existing', doc,
        'layers ON, OFF and locked, a nested /Order, /AS and /Configs, a layer already named like the overlay, '
        + 'its /Properties name taken, and an annotation in a layer');
}

// /BaseState /OFF: a new layer not named in /ON would start hidden.
{
    const { doc, font } = await newDoc('OCG base state off');
    const a = newGroup(doc, '表示レイヤ');
    const p = doc.addPage([A4.w, A4.h]);
    const box = { x: 0, y: 0, ...A4 };
    drawVector(p, box);
    drawText(p, font, box, 'OCG-BASEOFF');
    setProperties(doc, p, { OCA: a });
    inGroup(p, 'OCA', () => p.drawRectangle({ x: 80, y: 600, width: 200, height: 100, color: rgb(0.9, 0.1, 0.1) }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [a], D: { BaseState: 'OFF', ON: [a], Order: [a] },
    }));
    await write('ocg-baseoff', doc, '/BaseState /OFF with the existing layer in /ON');
}
{
    const { doc, font } = await newDoc('OCG base state off, no ON');
    const a = newGroup(doc, '非表示レイヤ');
    const p = doc.addPage([A4.w, A4.h]);
    const box = { x: 0, y: 0, ...A4 };
    drawVector(p, box);
    drawText(p, font, box, 'OCG-BASEOFF-NO-ON');
    setProperties(doc, p, { OCA: a });
    inGroup(p, 'OCA', () => p.drawRectangle({ x: 80, y: 600, width: 200, height: 100, color: rgb(0.1, 0.1, 0.9) }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [a], D: { BaseState: 'OFF', Order: [a] },
    }));
    await write('ocg-baseoff-no-on', doc, '/BaseState /OFF and no /ON at all: the existing layer starts hidden');
}

// Everything held by reference.
{
    const { doc, font } = await newDoc('OCG indirect');
    const a = newGroup(doc, '参照レイヤ');
    const p = doc.addPage([A4.w, A4.h]);
    const box = { x: 0, y: 0, ...A4 };
    drawVector(p, box);
    drawText(p, font, box, 'OCG-INDIRECT');
    const props = doc.context.register(doc.context.obj({ OCA: a }));
    p.node.normalizedEntries().Resources.set(PDFName.of('Properties'), props);
    inGroup(p, 'OCA', () => p.drawRectangle({ x: 80, y: 600, width: 200, height: 100, color: rgb(0.9, 0.1, 0.1) }));
    const ocgs = doc.context.register(doc.context.obj([a]));
    const order = doc.context.register(doc.context.obj([a]));
    const on = doc.context.register(doc.context.obj([a]));
    const d = doc.context.register(doc.context.obj({ Order: order, ON: on, Intent: ['View', 'Design'] }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.register(doc.context.obj({ OCGs: ocgs, D: d })));
    await write('ocg-indirect', doc,
        '/OCProperties, /OCGs, /D, /Order, /ON and /Properties all indirect; /Intent [/View /Design]');
}

// Two pages drawing with one resource dictionary inherited from the page tree.
{
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle('OCG shared resources');
    const pages = [doc.addPage([A4.w, A4.h]), doc.addPage([A4.w, A4.h])];
    pages.forEach((p) => drawVector(p, { x: 0, y: 0, ...A4 }));
    const shared = doc.context.register(doc.context.obj({}));
    doc.catalog.lookup(PDFName.of('Pages')).set(PDFName.of('Resources'), shared);
    for (const p of pages) p.node.delete(PDFName.of('Resources'));
    await write('ocg-shared-resources', doc, 'two pages inheriting one /Resources from the page tree');
}

// ---------------------------------------------------------------------------
// Structures the overlay cannot be added to without guessing: refused by name.
// ---------------------------------------------------------------------------
async function refusal(name, note, reason, build) {
    const { doc, font } = await newDoc(`OCG ${name}`);
    const a = newGroup(doc, '既存レイヤ');
    const p = doc.addPage([A4.w, A4.h]);
    const box = { x: 0, y: 0, ...A4 };
    drawVector(p, box);
    drawText(p, font, box, `OCG-${name.toUpperCase()}`);
    setProperties(doc, p, { OCA: a });
    inGroup(p, 'OCA', () => p.drawRectangle({ x: 80, y: 600, width: 200, height: 100, color: rgb(0.9, 0.1, 0.1) }));
    build(doc, a, p);
    await write(name, doc, note, 'OPTIONAL_CONTENT_UNSAFE', reason);
}

await refusal('ocg-no-order', '/D without /Order', '/Order', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [a], D: { ON: [a] } }));
});
await refusal('ocg-no-d', '/OCProperties without /D', '/D', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [a] }));
});
await refusal('ocg-ocgs-not-array', '/OCGs is a dictionary', '/OCGs', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: { A: a }, D: { Order: [a] } }));
});
await refusal('ocg-ocgs-direct-entry', 'an /OCGs entry that is a direct dictionary', '/OCGs', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [a, { Type: 'OCG', Name: hex('直接') }], D: { Order: [a] },
    }));
});
await refusal('ocg-design-intent', '/D /Intent /Design only', '表示用', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [a], D: { Order: [a], Intent: 'Design' } }));
});
await refusal('ocg-bad-basestate', '/D /BaseState is a string', '/BaseState', (doc, a) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [a], D: { Order: [a], BaseState: PDFString.of('ON') },
    }));
});
await refusal('ocg-properties-not-dict', 'a page /Properties that is an array', '/Properties', (doc, a, p) => {
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [a], D: { Order: [a] } }));
    p.node.normalizedEntries().Resources.set(PDFName.of('Properties'), doc.context.obj([a]));
});

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({ overlayName: OVERLAY_NAME, files: corpus }, null, 2)}\n`);
console.log(`wrote ${corpus.length} fixtures to ${path.relative(ROOT, OUT)}`);
for (const f of corpus) console.log(`  ${f.name.padEnd(26)} ${String(f.bytes).padStart(7)}  ${f.expect.padEnd(24)} ${f.note}`);
