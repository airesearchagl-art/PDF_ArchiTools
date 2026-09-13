/**
 * Synthetic documents for the M6 Split / Merge reliability research.
 *
 * None of these is a customer or project document; every byte is generated
 * here. They exist to make one distinction measurable: **copying pages is not
 * preserving a document.** A page renders identically whether or not the
 * outline that pointed at it, the field its widget belonged to, the named
 * destination that addressed it or the metadata that described it came with it.
 *
 * So each fixture carries markers a reader can find afterwards — a visible and
 * extractable `M6-PAGE-<doc>-<n>` on every page, so page *order* can be
 * measured exactly rather than eyeballed, plus whatever catalog-level structure
 * the fixture is about.
 *
 * Output goes to `test-fixtures/m6-split-merge/`, which is already ignored, so
 * running this leaves the working tree clean and the research evidence stays
 * bound to committed source rather than to files nobody can regenerate.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef,
    StandardFonts, rgb, degrees,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const SHEET = {
    A4: { w: 595.28, h: 841.89 },
    A3: { w: 841.89, h: 1190.55 },
    A1: { w: 1683.78, h: 2383.94 },
};

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const written = [];

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setAuthor('M6 author');
    doc.setSubject('M6 subject');
    doc.setCreator('M6 creator');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, font };
}

async function write(name, doc, note) {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, note });
    return bytes;
}

const writeRaw = (name, buffer, note) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), buffer);
    written.push({ name, bytes: buffer.length, note });
};

/** Border, grid and a heavy line, so "the page still draws" is checkable. */
function drawVector(page, size) {
    const { w, h } = size;
    const lw = w * 0.002;
    page.drawRectangle({
        x: w * 0.05, y: h * 0.05, width: w * 0.9, height: h * 0.9,
        borderColor: rgb(0, 0, 0), borderWidth: lw * 2,
    });
    for (let i = 1; i < 5; i += 1) {
        page.drawLine({
            start: { x: w * 0.05, y: h * (0.2 + i * 0.12) },
            end: { x: w * 0.95, y: h * (0.2 + i * 0.12) },
            thickness: lw, color: rgb(0.1, 0.2, 0.85),
        });
    }
    page.drawLine({
        start: { x: w * 0.15, y: h * 0.35 }, end: { x: w * 0.85, y: h * 0.35 },
        thickness: lw * 4, color: rgb(0.85, 0.1, 0.1),
    });
}

/**
 * The marker that makes page order a measurement rather than an impression.
 * Extractable by a text reader and visible to a human looking at the output.
 */
const mark = (page, font, size, text) => page.drawText(text, {
    x: size.w * 0.1, y: size.h * 0.12, size: Math.max(9, size.h * 0.02), font, color: rgb(0, 0, 0),
});

/** A page with its own identity. */
function sheet(doc, font, size, marker) {
    const page = doc.addPage([size.w, size.h]);
    drawVector(page, size);
    mark(page, font, size, marker);
    return page;
}

function addAnnots(doc, page, dicts) {
    const refs = dicts.map((d) => doc.context.register(doc.context.obj(d)));
    const existing = page.node.lookup(PDFName.of('Annots'));
    const arr = existing instanceof PDFArray ? existing : doc.context.obj([]);
    for (const r of refs) arr.push(r);
    page.node.set(PDFName.of('Annots'), arr);
    return refs;
}

// ---------------------------------------------------------------------------
// Content classes and geometry
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M6 text and vector');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-TEXT-1');
    await write('text-vector', doc, 'native searchable text over vector geometry');
}
{
    // A "scan": one full-page DeviceGray image XObject, no encoder involved.
    const { doc, font } = await newDoc('M6 scanned');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    const w = 160;
    const h = 220;
    const samples = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            samples[y * w + x] = (x % 16 < 2 || y % 20 < 2) ? 0x20 : 0xe8;
        }
    }
    const image = doc.context.stream(zlib.deflateSync(samples), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: w,
        Height: h,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
    });
    const name = page.node.newXObject('M6Scan', doc.context.register(image));
    // Drawn through pdf-lib's own operator helpers so the page keeps a single
    // content stream it manages, and the marker drawn afterwards lands on top
    // of the image rather than underneath a stream appended behind it.
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(SHEET.A4.w, 0, 0, SHEET.A4.h, 0, 0),
        drawObject(name.asString().replace(/^\//, '')),
        popGraphicsState(),
    );
    mark(page, font, SHEET.A4, 'M6-PAGE-SCAN-1');
    await write('scanned-image', doc, 'a full-page DeviceGray image XObject');
}
{
    const { doc, font } = await newDoc('M6 six pages');
    for (let i = 1; i <= 6; i += 1) sheet(doc, font, SHEET.A4, `M6-PAGE-SIX-${i}`);
    await write('mixed-6p', doc, 'six pages, each uniquely marked, for order and subset tests');
}
for (const angle of [0, 90, 180, 270]) {
    const { doc, font } = await newDoc(`M6 rotate ${angle}`);
    const page = sheet(doc, font, SHEET.A4, `M6-PAGE-ROT${angle}-1`);
    page.setRotation(degrees(angle));
    await write(`rotate-${angle}`, doc, `/Rotate ${angle}`);
}
{
    const { doc, font } = await newDoc('M6 crop offset');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-CROP-1');
    page.node.set(PDFName.of('CropBox'), doc.context.obj([50, 70, SHEET.A4.w - 40, SHEET.A4.h - 60]));
    await write('crop-offset', doc, 'CropBox origin at (50,70), smaller than the MediaBox');
}
{
    const { doc, font } = await newDoc('M6 mediabox offset');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-MBOFF-1');
    page.node.set(PDFName.of('MediaBox'), doc.context.obj([200, 300, 200 + SHEET.A4.w, 300 + SHEET.A4.h]));
    page.node.set(PDFName.of('CropBox'), doc.context.obj([200, 300, 200 + SHEET.A4.w, 300 + SHEET.A4.h]));
    await write('mediabox-offset', doc, 'MediaBox origin at (200,300)');
}
{
    const { doc, font } = await newDoc('M6 mixed sizes');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-SIZE-1');
    sheet(doc, font, SHEET.A3, 'M6-PAGE-SIZE-2');
    sheet(doc, font, SHEET.A1, 'M6-PAGE-SIZE-3');
    await write('mixed-sizes', doc, 'A4, A3 and A1 in one document');
}
// Bulk documents for the preview-memory question. The current Extract renders
// every page at scale 1.5 and keeps each one as a base64 PNG Data URL in React
// state, so the cost is a function of page count and sheet size — and neither
// can be measured against a six-page corpus.
for (const n of [10, 50, 100, 200]) {
    const { doc, font } = await newDoc(`M6 ${n} pages`);
    for (let i = 1; i <= n; i += 1) {
        const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
        page.drawRectangle({
            x: SHEET.A4.w * 0.06, y: SHEET.A4.h * 0.06,
            width: SHEET.A4.w * 0.88, height: SHEET.A4.h * 0.88,
            borderColor: rgb(0, 0, 0), borderWidth: 1.2,
        });
        mark(page, font, SHEET.A4, `M6-PAGE-BULK${n}-${i}`);
    }
    await write(`pages-${n}`, doc, `${n} A4 pages, for preview-memory measurement`);
}
{
    const { doc, font } = await newDoc('M6 ten A1 sheets');
    for (let i = 1; i <= 10; i += 1) {
        const page = doc.addPage([SHEET.A1.w, SHEET.A1.h]);
        page.drawRectangle({
            x: SHEET.A1.w * 0.06, y: SHEET.A1.h * 0.06,
            width: SHEET.A1.w * 0.88, height: SHEET.A1.h * 0.88,
            borderColor: rgb(0, 0, 0), borderWidth: 3,
        });
        mark(page, font, SHEET.A1, `M6-PAGE-A1BULK-${i}`);
    }
    await write('pages-10-a1', doc, 'ten A1 sheets, for the large-format preview cost');
}

{
    // Inheritable geometry declared on the page tree rather than the leaf: a
    // copied leaf whose /Parent is gone has to carry it, or lose it.
    const { doc, font } = await newDoc('M6 inherited page attributes');
    const page = doc.addPage([SHEET.A4.w, SHEET.A4.h]);
    drawVector(page, SHEET.A4);
    mark(page, font, SHEET.A4, 'M6-PAGE-INHERIT-1');
    const tree = doc.catalog.lookup(PDFName.of('Pages'));
    if (tree instanceof PDFDict) {
        tree.set(PDFName.of('Rotate'), PDFNumber.of(90));
        tree.set(PDFName.of('CropBox'), doc.context.obj([20, 30, SHEET.A4.w - 20, SHEET.A4.h - 30]));
    }
    page.node.delete(PDFName.of('CropBox'));
    await write('inherited-page-attrs', doc, '/Rotate and /CropBox on the page tree, not the leaf');
}
{
    const { doc, font } = await newDoc('M6 user unit');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-UU-1');
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2.5));
    await write('user-unit', doc, '/UserUnit 2.5');
}

// ---------------------------------------------------------------------------
// Annotations and navigation
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M6 links');
    const pages = [1, 2, 3, 4].map((i) => sheet(doc, font, SHEET.A4, `M6-PAGE-LINK-${i}`));

    addAnnots(doc, pages[0], [
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 700, 320, 720], Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.invalid/m6') },
        },
        {
            // Straight /Dest to a page that a 1-2 extract leaves behind.
            Type: 'Annot', Subtype: 'Link', Rect: [100, 660, 320, 680], Border: [0, 0, 0],
            Dest: [pages[3].ref, PDFName.of('XYZ'), PDFNumber.of(80), PDFNumber.of(700), PDFNumber.of(0)],
        },
        {
            // /GoTo action to a page a 1-2 extract keeps.
            Type: 'Annot', Subtype: 'Link', Rect: [100, 620, 320, 640], Border: [0, 0, 0],
            A: {
                Type: 'Action',
                S: 'GoTo',
                D: [pages[1].ref, PDFName.of('FitH'), PDFNumber.of(500)],
            },
        },
        {
            Type: 'Annot', Subtype: 'Link', Rect: [100, 580, 320, 600], Border: [0, 0, 0],
            A: { Type: 'Action', S: 'GoTo', D: PDFString.of('M6-NAMED-FAR') },
        },
        {
            Type: 'Annot', Subtype: 'Square', Rect: [360, 560, 520, 700],
            C: [0, 0, 1], F: 4, T: PDFString.of('M6-SQUARE'),
        },
    ]);

    // Named destinations: one to a page an extract keeps, one to a page it drops.
    const near = doc.context.obj([pages[1].ref, PDFName.of('Fit')]);
    const far = doc.context.obj([pages[3].ref, PDFName.of('XYZ'), PDFNumber.of(10), PDFNumber.of(20), PDFNumber.of(0)]);
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        Dests: {
            Names: [PDFString.of('M6-NAMED-NEAR'), near, PDFString.of('M6-NAMED-FAR'), far],
        },
    })));

    // An outline pointing at each of the four pages.
    const items = pages.map((p, i) => doc.context.register(doc.context.obj({
        Title: PDFString.of(`M6 outline ${i + 1}`),
        Dest: [p.ref, PDFName.of('XYZ'), PDFNumber.of(70), PDFNumber.of(600), PDFNumber.of(0)],
    })));
    for (let i = 0; i < items.length; i += 1) {
        const item = doc.context.lookup(items[i]);
        if (!(item instanceof PDFDict)) continue;
        if (i > 0) item.set(PDFName.of('Prev'), items[i - 1]);
        if (i < items.length - 1) item.set(PDFName.of('Next'), items[i + 1]);
    }
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({
        Type: 'Outlines', First: items[0], Last: items[items.length - 1], Count: items.length,
    })));

    // Page labels: i, ii, then A-1, A-2.
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.register(doc.context.obj({
        Nums: [
            PDFNumber.of(0), { S: PDFName.of('r') },
            PDFNumber.of(2), { S: PDFName.of('D'), St: PDFNumber.of(1), P: PDFString.of('A-') },
        ],
    })));

    // An OpenAction onto page 3.
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj([
        pages[2].ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0),
    ]));

    await write('nav-4p', doc,
        'four pages: URI link, /Dest to p4, /GoTo to p2, named-dest link, named dests, outlines, page labels, OpenAction');
}
{
    // A destination that already points nowhere, before anything copies it.
    const { doc, font } = await newDoc('M6 dangling destination');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-DANGLE-1');
    addAnnots(doc, page, [{
        Type: 'Annot', Subtype: 'Link', Rect: [100, 700, 320, 720], Border: [0, 0, 0],
        Dest: [PDFRef.of(9999, 0), PDFName.of('Fit')],
    }]);
    await write('dangling-dest', doc, 'a link whose /Dest references an object that is not there');
}

// ---------------------------------------------------------------------------
// Forms and signature states
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M6 form');
    const pages = [1, 2].map((i) => sheet(doc, font, SHEET.A4, `M6-PAGE-FORM-${i}`));
    const widgetOn = (page, name, value, y) => {
        const ref = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Widget', FT: 'Tx',
            T: PDFString.of(name), V: PDFString.of(value),
            Rect: [120, y, 400, y + 30], F: 4,
            DA: PDFString.of('/Helv 12 Tf 0 g'),
        }));
        const arr = doc.context.obj([]);
        arr.push(ref);
        page.node.set(PDFName.of('Annots'), arr);
        return ref;
    };
    const a = widgetOn(pages[0], 'm6.onPage1', 'M6-FIELD-ONE', 300);
    const b = widgetOn(pages[1], 'm6.onPage2', 'M6-FIELD-TWO', 300);
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [a, b], DA: PDFString.of('/Helv 12 Tf 0 g'), NeedAppearances: true,
    })));
    await write('form-2p', doc, 'one text field with a value on each of two pages');
}
{
    // One field, two widgets, on two different pages: extracting one page takes
    // half a field with it.
    const { doc, font } = await newDoc('M6 split field');
    const pages = [1, 2].map((i) => sheet(doc, font, SHEET.A4, `M6-PAGE-SPLITFIELD-${i}`));
    const kids = pages.map((p, i) => {
        const ref = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Widget', Rect: [120, 300 + i * 40, 400, 330 + i * 40], F: 4,
        }));
        p.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
        return ref;
    });
    const field = doc.context.obj({
        FT: 'Tx', T: PDFString.of('m6.shared'), V: PDFString.of('M6-SHARED-VALUE'),
        Kids: kids, DA: PDFString.of('/Helv 12 Tf 0 g'),
    });
    const fieldRef = doc.context.register(field);
    for (const kid of kids) {
        const k = doc.context.lookup(kid);
        if (k instanceof PDFDict) k.set(PDFName.of('Parent'), fieldRef);
    }
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [fieldRef], DA: PDFString.of('/Helv 12 Tf 0 g'),
    })));
    await write('form-field-across-pages', doc, 'one field whose two widgets sit on different pages');
}
{
    const { doc, font } = await newDoc('M6 empty signature');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-SIGEMPTY-1');
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('m6.blank'),
        Rect: [380, 80, 560, 140], F: 4,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], SigFlags: 3,
    })));
    await write('sig-empty', doc, 'an empty /Sig field with /SigFlags 3');
}
{
    // An applied signature whose /Contents really is a digest of the file, so a
    // re-save can be shown to have invalidated it.
    const { doc, font } = await newDoc('M6 applied signature');
    const pages = [1, 2].map((i) => sheet(doc, font, SHEET.A4, `M6-PAGE-SIGNED-${i}`));
    const sigRef = doc.context.register(doc.context.obj({
        Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(32)),
        M: PDFString.of('D:20260101000000Z'),
    }));
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('m6.sig'),
        V: sigRef, Rect: [380, 80, 560, 140], F: 4,
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], SigFlags: 3,
    })));
    const bytes = await doc.save({ useObjectStreams: false });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const patched = Buffer.from(bytes);
    const at = patched.indexOf(Buffer.from('00'.repeat(32), 'ascii'));
    if (at >= 0) patched.write(digest.slice(0, 64), at, 'ascii');
    fs.writeFileSync(path.join(OUT, 'sig-applied.pdf'), patched);
    written.push({ name: 'sig-applied', bytes: patched.length, note: 'an applied signature over two pages' });
}
{
    const { doc, font } = await newDoc('M6 XFA');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-XFA-1');
    const xfa = doc.context.stream(zlib.deflateSync(Buffer.from(
        '<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">M6</xdp:xdp>', 'utf8',
    )), { Filter: 'FlateDecode' });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [], XFA: doc.context.register(xfa),
    })));
    await write('xfa', doc, 'an AcroForm carrying /XFA');
}
{
    const { doc, font } = await newDoc('M6 malformed AcroForm');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-BADFORM-1');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: { Broken: PDFNumber.of(1) }, SigFlags: 3,
    })));
    await write('malformed-acroform', doc, '/Fields is a dictionary rather than an array');
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
const XMP = (marker) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description dc:title="${marker}" xmlns:dc="http://purl.org/dc/elements/1.1/"/>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

{
    const { doc, font } = await newDoc('M6 metadata');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-META-1');
    doc.setKeywords(['M6-KEY-ONE', 'M6-KEY-TWO']);
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) {
        info.set(PDFName.of('Company'), PDFString.of('M6-COMPANY'));
        info.set(PDFName.of('M6Custom'), PDFString.of('M6-CUSTOM-VALUE'));
        info.set(PDFName.of('M6Indirect'), doc.context.register(PDFString.of('M6-INDIRECT-VALUE')));
    }
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(
        doc.context.stream(Buffer.from(XMP('M6-XMP-PLAIN'), 'utf8'), { Type: 'Metadata', Subtype: 'XML' }),
    ));
    await write('meta-rich', doc, 'custom Info, an indirect Info value, /Keywords and an unfiltered XMP packet');
}
{
    const { doc, font } = await newDoc('M6 compressed XMP');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-METAFLATE-1');
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(
        zlib.deflateSync(Buffer.from(XMP('M6-XMP-FLATE'), 'utf8')),
        { Type: 'Metadata', Subtype: 'XML', Filter: 'FlateDecode' },
    )));
    await write('meta-xmp-flate', doc, 'an XMP packet stored with /Filter /FlateDecode');
}

// ---------------------------------------------------------------------------
// Catalog-level structures that a page copy cannot carry on its own
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M6 optional content');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-OCG-1');
    const ocg = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-LAYER'),
    }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [ocg],
        D: { Order: [ocg], ON: [ocg] },
    }));
    const props = doc.context.obj({ M6OC: ocg });
    const resources = page.node.lookup(PDFName.of('Resources'));
    if (resources instanceof PDFDict) resources.set(PDFName.of('Properties'), props);
    await write('ocproperties', doc, 'an optional-content group referenced from page resources');
}
{
    const { doc, font } = await newDoc('M6 tagged');
    const page = sheet(doc, font, SHEET.A4, 'M6-PAGE-TAGGED-1');
    const struct = doc.context.register(doc.context.obj({
        Type: 'StructTreeRoot',
        K: { Type: 'StructElem', S: PDFName.of('Document'), P: PDFString.of('M6-STRUCT') },
        ParentTree: { Nums: [] },
    }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), struct);
    doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
    page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
    await write('structtree', doc, 'a /StructTreeRoot and a page claiming /StructParents');
}
{
    const { doc, font } = await newDoc('M6 attachment');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-ATTACH-1');
    const embedded = doc.context.register(doc.context.stream(
        Buffer.from('M6-ATTACHED-PAYLOAD\n', 'utf8'),
        { Type: 'EmbeddedFile', Subtype: PDFName.of('text/plain') },
    ));
    const filespec = doc.context.register(doc.context.obj({
        Type: 'Filespec', F: PDFString.of('m6-note.txt'), UF: PDFString.of('m6-note.txt'),
        EF: { F: embedded },
    }));
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        EmbeddedFiles: { Names: [PDFString.of('m6-note.txt'), filespec] },
        JavaScript: {
            Names: [PDFString.of('M6-JS'), { S: PDFName.of('JavaScript'), JS: PDFString.of('/* M6 */') }],
        },
    })));
    await write('attachment-and-js', doc, 'an embedded file and a document-level JavaScript name tree');
}

// ---------------------------------------------------------------------------
// Merge sources: ordering, repetition and collisions
// ---------------------------------------------------------------------------
{
    const { doc, font } = await newDoc('M6 source A');
    for (let i = 1; i <= 3; i += 1) sheet(doc, font, SHEET.A4, `M6-PAGE-A-${i}`);
    await write('source-a', doc, 'three pages marked A-1..A-3');
}
{
    const { doc, font } = await newDoc('M6 source B');
    for (let i = 1; i <= 2; i += 1) sheet(doc, font, SHEET.A3, `M6-PAGE-B-${i}`);
    await write('source-b', doc, 'two A3 pages marked B-1..B-2');
}
{
    const { doc, font } = await newDoc('M6 source C');
    const p = sheet(doc, font, SHEET.A4, 'M6-PAGE-C-1');
    p.setRotation(degrees(270));
    sheet(doc, font, SHEET.A4, 'M6-PAGE-C-2');
    await write('source-c', doc, 'two pages, the first rotated 270');
}

/** Two documents that disagree about names the catalog treats as unique. */
async function collisionSource(name, marker, { fieldName, destName, outlineTitle, label }) {
    const { doc, font } = await newDoc(`M6 ${name}`);
    const page = sheet(doc, font, SHEET.A4, marker);

    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Tx',
        T: PDFString.of(fieldName), V: PDFString.of(`${marker}-VALUE`),
        Rect: [120, 300, 400, 330], F: 4, DA: PDFString.of('/Helv 12 Tf 0 g'),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], DA: PDFString.of('/Helv 12 Tf 0 g'),
    })));

    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        Dests: { Names: [PDFString.of(destName), [page.ref, PDFName.of('Fit')]] },
    })));

    const item = doc.context.register(doc.context.obj({
        Title: PDFString.of(outlineTitle),
        Dest: [page.ref, PDFName.of('Fit')],
    }));
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({
        Type: 'Outlines', First: item, Last: item, Count: 1,
    })));

    doc.catalog.set(PDFName.of('PageLabels'), doc.context.register(doc.context.obj({
        Nums: [PDFNumber.of(0), { S: PDFName.of('D'), P: PDFString.of(label) }],
    })));

    await write(name, doc, `collision source: field ${fieldName}, dest ${destName}, label ${label}`);
}

await collisionSource('collide-a', 'M6-PAGE-COLLIDE-A', {
    fieldName: 'shared.field', destName: 'M6-SHARED-DEST', outlineTitle: 'M6 shared outline', label: 'A-',
});
await collisionSource('collide-b', 'M6-PAGE-COLLIDE-B', {
    fieldName: 'shared.field', destName: 'M6-SHARED-DEST', outlineTitle: 'M6 shared outline', label: 'B-',
});

// ---------------------------------------------------------------------------
// Invalid and hostile
// ---------------------------------------------------------------------------
writeRaw('invalid', Buffer.from('not a pdf at all\n', 'utf8'), 'not a PDF');
{
    // A real PDF whose trailer claims encryption. The xref table sits before
    // the trailer, so splicing the dictionary does not move any offset it
    // records — the file stays loadable enough to be *refused* for the right
    // reason rather than for a parse error.
    const { doc, font } = await newDoc('M6 encrypted');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-ENC-1');
    const encRef = doc.context.register(doc.context.obj({
        Filter: PDFName.of('Standard'), V: PDFNumber.of(1), R: PDFNumber.of(2),
        O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)),
        P: PDFNumber.of(-1),
    }));
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    const marker = Buffer.from('trailer\n<<', 'ascii');
    const at = bytes.indexOf(marker);
    if (at < 0) throw new Error('could not find the trailer to mark as encrypted');
    const cut = at + marker.length;
    const spliced = Buffer.concat([
        bytes.subarray(0, cut),
        Buffer.from(` /Encrypt ${encRef.objectNumber} ${encRef.generationNumber} R`, 'ascii'),
        bytes.subarray(cut),
    ]);
    writeRaw('encrypted', spliced, 'a loadable PDF whose trailer declares /Encrypt');
}
{
    // A page tree whose /Count and /Kids disagree with reality.
    const { doc, font } = await newDoc('M6 broken page tree');
    sheet(doc, font, SHEET.A4, 'M6-PAGE-BROKEN-1');
    const tree = doc.catalog.lookup(PDFName.of('Pages'));
    if (tree instanceof PDFDict) {
        tree.set(PDFName.of('Count'), PDFNumber.of(7));
        const kids = tree.lookup(PDFName.of('Kids'));
        if (kids instanceof PDFArray) kids.push(PDFRef.of(9998, 0));
    }
    await write('broken-pagetree', doc, '/Count 7 with two kids, one of which is not there');
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify(written, null, 2)}\n`);
console.log(`${written.length} fixtures -> ${path.relative(ROOT, OUT)}`);
for (const f of written) console.log(`  ${f.name.padEnd(26)} ${String(f.bytes).padStart(8)} B  ${f.note}`);
