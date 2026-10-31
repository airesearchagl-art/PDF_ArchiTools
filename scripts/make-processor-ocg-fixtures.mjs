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
import zlib from 'node:zlib';
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

// ---------------------------------------------------------------------------
// The page's own marked content (RF-IR01-01). The overlay is appended after the
// page's content, so a BDC/BMC the page leaves open would take the overlay
// inside it: with an OFF layer left open, the new layer shows nothing when ON.
// Each content stream here is written by hand, so what the reader sees is
// exactly the bytes below.
// ---------------------------------------------------------------------------
const HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' };
const BASE_DRAWING = [
    'q 0 0 0 RG 2 w 30 30 535.28 781.89 re S Q',
    'q 0.85 0.1 0.1 RG 6 w 90 300 m 505 300 l S Q',
    'BT /F1 14 Tf 72 100 Td (OCG-MC-BASE) Tj ET',
].join('\n');

/** A page whose /Contents are exactly `streams` (strings, or {data, filter} for an encoded one). */
async function handWritten(name, title, streams, { groups = {}, ocProperties = null, note, expect = 'ready', reason = null }) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const page = doc.addPage([A4.w, A4.h]);
    const refs = {};
    for (const [key, label] of Object.entries(groups)) refs[key] = newGroup(doc, label);
    const contents = streams.map((s) => {
        if (typeof s === 'string') return doc.context.register(doc.context.stream(s, {}));
        return doc.context.register(doc.context.stream(s.data, { Filter: s.filter }));
    });
    page.node.set(PDFName.of('Contents'), doc.context.obj(contents));
    page.node.set(PDFName.of('Resources'), doc.context.obj({
        Font: { F1: doc.context.obj(HELVETICA) },
        ...(Object.keys(refs).length ? { Properties: refs } : {}),
    }));
    if (ocProperties) doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj(ocProperties(refs)));
    await write(name, doc, note, expect, reason);
}

/** The reviewer's counterexample, rebuilt here: an OFF layer the page leaves open. */
await handWritten('mc-unclosed-bdc-off', 'MC unclosed BDC (OFF layer)', [
    `${BASE_DRAWING}\n/OC /OCA BDC\nq 0.1 0.1 0.9 rg 300 600 200 100 re f Q\n`,
], {
    groups: { OCA: '既存レイヤ（非表示・未閉鎖）' },
    ocProperties: (g) => ({ OCGs: [g.OCA], D: { Order: [g.OCA], OFF: [g.OCA] } }),
    note: 'an existing OFF layer opened with BDC and never closed: the counterexample of RF-IR01-01',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '閉じていない',
});
await handWritten('mc-unclosed-bmc', 'MC unclosed BMC', [
    `${BASE_DRAWING}\n/Span BMC\nq 0 0.5 0 rg 300 600 200 100 re f Q\n`,
], {
    note: 'a BMC that is never closed, in a document with no layers',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '閉じていない',
});
await handWritten('mc-extra-emc', 'MC extra EMC', [
    `${BASE_DRAWING}\n/Span BMC q 0 0.5 0 rg 300 600 200 100 re f Q EMC\nEMC\n`,
], {
    note: 'one EMC more than was opened',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '対応する開始のないEMC',
});
await handWritten('mc-nested-ok', 'MC nested', [
    [
        BASE_DRAWING,
        '/OC /OCA BDC',
        '  q 0.9 0.1 0.1 rg 60 600 200 100 re f Q',
        '  /Span << /MCID 0 >> BDC',
        '    /Artifact BMC q 0 0.6 0 rg 60 480 80 80 re f Q EMC',
        '    /OC /OCB BDC q 0.1 0.1 0.9 rg 160 480 80 80 re f Q EMC',
        '  EMC',
        'EMC',
    ].join('\n'),
], {
    groups: { OCA: '入れ子レイヤ A（表示）', OCB: '入れ子レイヤ B（非表示）' },
    ocProperties: (g) => ({ OCGs: [g.OCA, g.OCB], D: { Order: [g.OCA, g.OCB], OFF: [g.OCB] } }),
    note: 'BDC, BMC and an OC BDC nested three deep and all closed',
});
await handWritten('mc-split-contents-ok', 'MC across streams', [
    `${BASE_DRAWING}\n/OC /OCA BDC\nq 0.9 0.1 0.1 rg 60 600 200 100 re f Q\n`,
    'q 0.1 0.1 0.9 rg 300 600 200 100 re f Q\nEMC\n',
], {
    groups: { OCA: '分割レイヤ（表示）' },
    ocProperties: (g) => ({ OCGs: [g.OCA], D: { Order: [g.OCA] } }),
    note: 'a BDC opened in the first /Contents stream and closed in the second',
});
// Every byte sequence that looks like a marked-content operator but is not one.
const DECOYS = [
    BASE_DRAWING,
    '% EMC BDC BMC in a comment\n',
    'BT /F1 12 Tf 72 700 Td (BDC \\) EMC \\( BMC) Tj ((EMC) nested (BDC)) Tj <454D43> Tj [(EMC) -20 (BDC)] TJ ET',
    '/EMC BMC q 0.2 0.2 0.2 rg 72 640 40 40 re f Q EMC',
    '/Span << /ActualText (EMC BDC) /Alt <424443> /Tag /BDC /N [/EMC 1 2] >> BDC q 0 0.5 0 rg 130 640 40 40 re f Q EMC',
    // An uncompressed inline image whose eight data bytes spell " EMC BDC".
    'q 80 0 0 10 200 640 cm BI /W 8 /H 1 /BPC 8 /CS /G ID  EMC BDC EI Q',
    'q 40 0 0 40 300 640 cm BI /W 2 /H 2 /BPC 1 /IM true /D [1 0] ID À\u0000 EI Q',
].join('\n');
await handWritten('mc-decoys-ok', 'MC decoys', [DECOYS], {
    note: 'operator names inside strings, a comment, names, hex strings, a property list and inline image data',
});
await handWritten('mc-decoys-flate-ok', 'MC decoys, compressed', [
    { data: zlib.deflateSync(Buffer.from(DECOYS, 'latin1')), filter: 'FlateDecode' },
], {
    note: 'the same decoys in a FlateDecode stream',
});
await handWritten('mc-split-string', 'MC string across streams', [
    `${BASE_DRAWING}\nBT /F1 12 Tf 72 700 Td (abc`,
    'def) Tj ET\n',
], {
    note: 'a string opened in one /Contents stream and closed in the next',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '読み取れません',
});
await handWritten('mc-inline-flate', 'MC inline image of unknown length', [
    `${BASE_DRAWING}\nq 40 0 0 40 300 640 cm BI /W 2 /H 2 /BPC 8 /CS /G /F /Fl ID ${'x'.repeat(12)} EI Q\n`,
], {
    note: 'a compressed inline image, whose end cannot be found without decoding it',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'インライン画像',
});
await handWritten('mc-unsupported-filter', 'MC ASCIIHex content', [
    { data: Buffer.from(`${Buffer.from(BASE_DRAWING, 'latin1').toString('hex')}>`, 'latin1'), filter: 'ASCIIHexDecode' },
], {
    note: 'page content encoded with a filter the check does not decode',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '圧縮形式',
});
{
    // 260 MiB of spaces deflates to about a quarter of a megabyte: the decoded
    // size is what the check is bounded by, not the file's.
    const spaces = Buffer.alloc(260 * 1024 * 1024, 0x20);
    const bomb = zlib.deflateSync(spaces, { level: 9 });
    await handWritten('mc-over-limit', 'MC over the decode limit', [
        BASE_DRAWING,
        { data: bomb, filter: 'FlateDecode' },
    ], {
        note: 'page content that decodes to 260 MiB',
        expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '上限',
    });
}

// ---------------------------------------------------------------------------
// RF-IR01-01, review R1: an inline image's /L (or /Length) claimed more bytes
// than its data, and the reader skipped them as image data — the EI, and a BDC
// left open after it. A reader that ends the data at the first EI opens that
// BDC; the check never saw it. Any /L or /Length is refused now, whatever its
// value: the image's real extent is not something /L can be trusted to say.
// ---------------------------------------------------------------------------
const OLD_LAYER = { Old: '既存レイヤ Old（非表示）' };
const oldOff = (g) => ({ OCGs: [g.Old], D: { Order: [g.Old], OFF: [g.Old] } });
/** 1×1 RGB 8-bit: three data bytes, then whatever `afterData` says. */
const lengthCase = (dict, afterData) => [
    `${BASE_DRAWING}\nq 40 0 0 40 300 640 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ${dict} ID xyz${afterData}`,
];
// The reviewer's shape: /L 21 is the three data bytes and the eighteen after
// them — " EI", then "/OC /Old BDC" — so a reader trusting /L lands on the
// second EI and believes the page is closed.
const SKIPPED = ' EI\n/OC /Old BDC \n';
if (Buffer.byteLength(`xyz${SKIPPED}`, 'latin1') !== 21) throw new Error('the /L 21 counterexample is not 21 bytes');
const AFTER_SKIP = 'EI\nq 0.1 0.1 0.9 rg 300 600 200 100 re f Q\n';
for (const [name, dict, note] of [
    ['mc-inline-L-skip', '/L 21', 'the R1 counterexample: /L 21 over 3 data bytes hides an EI and an open BDC of an OFF layer'],
    ['mc-inline-Length-skip', '/Length 21', 'the same with /Length'],
    ['mc-inline-L-exact', '/L 3', '/L equal to the real data length'],
    ['mc-inline-L-zero', '/L 0', '/L 0'],
    ['mc-inline-Length-odd', '/Length 3.0', '/Length written as a real number'],
    ['mc-inline-L-negative', '/L -1', 'a negative /L'],
]) {
    const exact = dict === '/L 3' || dict === '/Length 3.0';
    await handWritten(name, `MC inline ${dict}`, lengthCase(dict, exact ? ' EI Q\n' : `${SKIPPED}${AFTER_SKIP} Q\n`), {
        groups: OLD_LAYER, ocProperties: oldOff,
        note, expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '/L・/Length',
    });
}
await handWritten('mc-inline-L-flate', 'MC inline /L with a filter', [
    `${BASE_DRAWING}\nq 40 0 0 40 300 640 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /Fl /L 11 ID ${'x'.repeat(11)} EI Q\n`,
], {
    groups: OLD_LAYER, ocProperties: oldOff,
    note: 'a compressed inline image accepted on its /L alone before R1',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '/L・/Length',
});
// No /L: the data's end comes from its dictionary, and an "EI" or "BDC" among
// the data bytes is data, not an operator.
await handWritten('mc-inline-ei-in-data-ok', 'MC inline image holding EI in its data', [
    `${BASE_DRAWING}\nq 80 0 0 10 300 640 cm BI /W 8 /H 1 /BPC 8 /CS /G ID  EI BDC  EI Q\n`
    + '/Span BMC q 0 0.5 0 rg 60 600 120 60 re f Q EMC\n',
], {
    note: 'an 8-byte gray image whose data reads " EI BDC ", with no /L, followed by a closed BMC',
});

// ---------------------------------------------------------------------------
// RF-IR01-R2-01: the page's own content is closed, but a Form XObject it paints
// leaves a BDC open. Readers that carry marked content across `Do` (MuPDF and
// Poppler, per the independent review) then draw the overlay inside it.
// ---------------------------------------------------------------------------
/** The form-chain depth and form count the check allows (src/utils/processor/marked-content.ts). */
const MAX_FORM_DEPTH = 12;
const MAX_FORM_CHECKS = 2000;

/**
 * A document whose pages paint Form XObjects. `forms` maps a key to
 * { content, resources: { xobjects: {Name: key}, props: [group key] } | null, flate, subtype };
 * `resources: null` writes a form with no /Resources of its own.
 */
async function formFixture(name, title, { forms, pages, groups = {}, ocProperties = null, note, expect = 'ready', reason = null }) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const g = {};
    for (const [key, label] of Object.entries(groups)) g[key] = newGroup(doc, label);
    const refs = {};
    for (const key of Object.keys(forms)) refs[key] = doc.context.nextRef();
    const resourcesOf = (spec = {}) => {
        const r = { Font: { F1: doc.context.obj(HELVETICA) } };
        if (spec.xobjects) r.XObject = Object.fromEntries(Object.entries(spec.xobjects).map(([n, k]) => [n, refs[k]]));
        if (spec.props) r.Properties = Object.fromEntries(spec.props.map((k) => [k, g[k]]));
        return r;
    };
    const stream = (content, dict, flate) => doc.context.stream(
        flate ? zlib.deflateSync(Buffer.from(content, 'latin1')) : content,
        flate ? { ...dict, Filter: 'FlateDecode' } : dict,
    );
    for (const [key, f] of Object.entries(forms)) {
        const subtype = f.subtype ?? 'Form';
        const dict = subtype === 'Image'
            ? { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }
            : { Type: 'XObject', Subtype: subtype, BBox: [0, 0, A4.w, A4.h] };
        if (subtype === 'Form' && f.resources !== null) dict.Resources = doc.context.obj(resourcesOf(f.resources));
        doc.context.assign(refs[key], stream(f.content, dict, f.flate));
    }
    for (const p of pages) {
        const page = doc.addPage([A4.w, A4.h]);
        page.node.set(PDFName.of('Contents'), doc.context.obj([doc.context.register(stream(p.content, {}, p.flate))]));
        page.node.set(PDFName.of('Resources'), doc.context.obj(p.noResources ? {} : resourcesOf(p.resources)));
    }
    if (ocProperties) doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj(ocProperties(g)));
    await write(name, doc, note, expect, reason);
}

const BLUE_BOX = 'q 0.1 0.1 0.9 rg 300 600 200 100 re f Q';
const paint = (...names) => `${BASE_DRAWING}\n${names.map((n) => `q /${n} Do Q`).join('\n')}\n`;

// The R2 counterexample: page content closed, the form it paints is not.
await formFixture('form-unclosed-bdc-off', 'Form leaves an OFF layer open', {
    groups: OLD_LAYER, ocProperties: oldOff,
    forms: { Fm0: { content: `/OC /Old BDC\n${BLUE_BOX}\n`, resources: { props: ['Old'] } } },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'the R2 counterexample: the page is closed; the Form XObject it paints opens an OFF layer and never closes it',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'Form XObject /Fm0',
});
await formFixture('form-unclosed-bmc', 'Form leaves a BMC open', {
    forms: { Fm0: { content: `/Span BMC\n${BLUE_BOX}\n`, resources: {} } },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'a Form XObject with a BMC it never closes',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '閉じていない',
});
await formFixture('form-extra-emc', 'Form closes more than it opened', {
    forms: { Fm0: { content: `${BLUE_BOX}\nEMC\n`, resources: {} } },
    pages: [{ content: `${BASE_DRAWING}\n/Span BMC q /Fm0 Do Q EMC\n`, resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'a Form XObject with an EMC of its own, painted inside a BMC the page opened',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '対応する開始のないEMC',
});
await formFixture('form-nested-ok', 'Nested forms, all closed', {
    groups: { A: 'フォーム内レイヤ A（表示）', B: 'フォーム内レイヤ B（非表示）' },
    ocProperties: (g) => ({ OCGs: [g.A, g.B], D: { Order: [g.A, g.B], OFF: [g.B] } }),
    forms: {
        Fm0: {
            content: '/OC /A BDC q 0.9 0.1 0.1 rg 60 600 200 100 re f Q EMC\n/Fm1 Do\n',
            resources: { xobjects: { Fm1: 'Fm1' }, props: ['A'] },
        },
        Fm1: { content: '/OC /B BDC q 0.1 0.1 0.9 rg 300 600 200 100 re f Q EMC\n', resources: { props: ['B'] }, flate: true },
    },
    pages: [{ content: paint('Fm0', 'Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'a page painting a form twice; that form paints a compressed form; each closes its own layers',
});
await formFixture('form-nested-bad', 'A nested form leaves a layer open', {
    groups: OLD_LAYER, ocProperties: oldOff,
    forms: {
        Fm0: { content: 'q 0 0.5 0 rg 60 600 100 100 re f Q\n/Fm1 Do\n', resources: { xobjects: { Fm1: 'Fm1' } } },
        Fm1: { content: `/OC /Old BDC\n${BLUE_BOX}\n`, resources: { props: ['Old'] } },
    },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'page and first form closed; the form that form paints opens an OFF layer',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'Form XObject /Fm1',
});
await formFixture('form-shared-ok', 'One form shared by pages', {
    groups: { A: '共有フォームのレイヤ（表示）' },
    ocProperties: (g) => ({ OCGs: [g.A], D: { Order: [g.A] } }),
    forms: { Fm0: { content: '/OC /A BDC q 0.9 0.1 0.1 rg 60 600 200 100 re f Q EMC\n', resources: { props: ['A'] } } },
    pages: [
        { content: paint('Fm0', 'Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } },
        { content: paint('Fm0', 'Fm0', 'Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } },
    ],
    note: 'one closed form painted twice on page 1 and three times on page 2',
});
await formFixture('form-shared-bad', 'One open form shared by pages', {
    groups: OLD_LAYER, ocProperties: oldOff,
    forms: { Fm0: { content: `/OC /Old BDC\n${BLUE_BOX}\n`, resources: { props: ['Old'] } } },
    pages: [
        { content: paint('Fm0', 'Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } },
        { content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } },
    ],
    note: 'one open form painted from two pages',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'Form XObject /Fm0',
});
await formFixture('form-cycle', 'Forms painting each other', {
    forms: {
        Fm0: { content: 'q 0 0.5 0 rg 60 600 100 100 re f Q\n/Fm1 Do\n', resources: { xobjects: { Fm1: 'Fm1' } } },
        Fm1: { content: 'q 0.5 0 0 rg 200 600 100 100 re f Q\n/Fm0 Do\n', resources: { xobjects: { Fm0: 'Fm0' } } },
    },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'Fm0 paints Fm1, which paints Fm0',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '循環',
});
await formFixture('form-self-cycle', 'A form painting itself', {
    forms: { Fm0: { content: 'q 0 0.5 0 rg 60 600 100 100 re f Q\n/Fm0 Do\n', resources: { xobjects: { Fm0: 'Fm0' } } } },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: 'a form that paints itself',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '循環',
});
/** A chain page → F1 → F2 → … → Fn. */
const chain = (n) => {
    const forms = {};
    for (let i = 1; i <= n; i += 1) {
        forms[`F${i}`] = i < n
            ? { content: `q 0 0 0 rg ${20 + i * 10} 400 8 8 re f Q\n/F${i + 1} Do\n`, resources: { xobjects: { [`F${i + 1}`]: `F${i + 1}` } } }
            : { content: `/Span BMC q 0 0 0 rg ${20 + i * 10} 400 8 8 re f Q EMC\n`, resources: {} };
    }
    return { forms, pages: [{ content: paint('F1'), resources: { xobjects: { F1: 'F1' } } }] };
};
await formFixture('form-depth-at-limit-ok', 'Forms nested to the limit', {
    ...chain(MAX_FORM_DEPTH), note: `forms nested ${MAX_FORM_DEPTH} deep, the most the check follows`,
});
await formFixture('form-depth-over', 'Forms nested past the limit', {
    ...chain(MAX_FORM_DEPTH + 1), note: `forms nested ${MAX_FORM_DEPTH + 1} deep`,
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '深さ',
});
/** A page painting `n` different closed forms. */
const many = (n) => {
    const forms = {};
    const xobjects = {};
    for (let i = 0; i < n; i += 1) {
        forms[`G${i}`] = { content: `q 0 0 0 rg ${20 + (i % 50) * 10} ${100 + Math.floor(i / 50) * 10} 4 4 re f Q\n`, resources: {} };
        xobjects[`G${i}`] = `G${i}`;
    }
    return { forms, pages: [{ content: `${BASE_DRAWING}\n${Object.keys(forms).map((k) => `/${k} Do`).join('\n')}\n`, resources: { xobjects } }] };
};
await formFixture('form-count-at-limit-ok', 'As many forms as the check reads', {
    ...many(MAX_FORM_CHECKS), note: `${MAX_FORM_CHECKS} different forms on one page, the most the check reads`,
});
await formFixture('form-count-over', 'More forms than the check reads', {
    ...many(MAX_FORM_CHECKS + 1), note: `${MAX_FORM_CHECKS + 1} different forms`,
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '件数',
});
await formFixture('form-unresolved', 'A name the resources do not have', {
    forms: { Fm0: { content: `${BLUE_BOX}\n`, resources: {} } },
    pages: [{ content: paint('Missing'), resources: { xobjects: { Fm0: 'Fm0' } } }],
    note: '/Missing Do with no /Missing in the page /XObject',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '解決できません',
});
await formFixture('form-no-xobject-dict', 'Do with no /XObject at all', {
    forms: {},
    pages: [{ content: paint('Fm0'), resources: {} }],
    note: '/Fm0 Do on a page whose resources have no /XObject',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '解決できません',
});
await formFixture('form-do-no-name', 'Do with no operand', {
    forms: {},
    pages: [{ content: `${BASE_DRAWING}\nq Do Q\n`, resources: {} }],
    note: 'a Do operator with no name before it',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'Do',
});
// A form with no /Resources of its own takes them from where it is painted
// (the deprecated inheritance). The form it then paints must be the one that
// environment names — and the same form painted from two environments is two
// different questions.
await formFixture('form-inherited-bad', 'A form without resources paints an open one', {
    groups: OLD_LAYER, ocProperties: oldOff,
    forms: {
        Fm0: { content: 'q 0 0.5 0 rg 60 600 100 100 re f Q\n/Inner Do\n', resources: null },
        Inner: { content: `/OC /Old BDC\n${BLUE_BOX}\n`, resources: { props: ['Old'] } },
    },
    pages: [{ content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0', Inner: 'Inner' } } }],
    note: 'Fm0 has no /Resources; /Inner resolves through the page, and leaves an OFF layer open',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: 'Form XObject /Inner',
});
await formFixture('form-env-differs', 'One form, two environments', {
    groups: OLD_LAYER, ocProperties: oldOff,
    forms: {
        Fm0: { content: 'q 0 0.5 0 rg 60 600 100 100 re f Q\n/Inner Do\n', resources: null },
        InnerOk: { content: '/Span BMC q 0 0 0.6 rg 200 600 50 50 re f Q EMC\n', resources: {} },
        InnerBad: { content: `/OC /Old BDC\n${BLUE_BOX}\n`, resources: { props: ['Old'] } },
    },
    pages: [
        { content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0', Inner: 'InnerOk' } } },
        { content: paint('Fm0'), resources: { xobjects: { Fm0: 'Fm0', Inner: 'InnerBad' } } },
    ],
    note: 'the same resource-less Fm0 on two pages: /Inner is a closed form on page 1 and an open one on page 2',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '2ページ目',
});
await formFixture('form-image-ok', 'An image XObject', {
    forms: { Im0: { content: '\u0080', subtype: 'Image' } },
    pages: [{ content: `${BASE_DRAWING}\nq 50 0 0 50 300 300 cm /Im0 Do Q\n`, resources: { xobjects: { Im0: 'Im0' } } }],
    note: 'an image XObject, which has no content to read',
});
await formFixture('form-ps-unsupported', 'A PostScript XObject', {
    forms: { Ps0: { content: '% nothing', subtype: 'PS' } },
    pages: [{ content: `${BASE_DRAWING}\n/Ps0 Do\n`, resources: { xobjects: { Ps0: 'Ps0' } } }],
    note: 'an XObject of a kind the check does not read',
    expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '種類',
});
{
    // The page decodes to 150 MiB and the form it paints to another 150: each
    // is under the document's 256 MiB, together they are not.
    const half = ' '.repeat(150 * 1024 * 1024);
    await formFixture('form-cumulative-over', 'Page and form together past the limit', {
        forms: { Fm0: { content: `${half}${BLUE_BOX}\n`, resources: {}, flate: true } },
        pages: [{ content: `${BASE_DRAWING}\n${half}\nq /Fm0 Do Q\n`, resources: { xobjects: { Fm0: 'Fm0' } }, flate: true }],
        note: 'page content and the form it paints decode to 150 MiB each',
        expect: 'OPTIONAL_CONTENT_UNSAFE', reason: '上限',
    });
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({ overlayName: OVERLAY_NAME, files: corpus }, null, 2)}\n`);
console.log(`wrote ${corpus.length} fixtures to ${path.relative(ROOT, OUT)}`);
for (const f of corpus) console.log(`  ${f.name.padEnd(26)} ${String(f.bytes).padStart(7)}  ${f.expect.padEnd(24)} ${f.note}`);
