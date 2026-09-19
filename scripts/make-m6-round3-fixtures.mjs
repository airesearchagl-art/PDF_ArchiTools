/**
 * The documents the second Independent FULL Re-Review's findings are proven
 * against.
 *
 * Same discipline as the round-2 generator: every one exists because a specific
 * defect reached the artifact, and each carries an ASCII marker the gate can
 * look for in the serialized bytes. Streams are written uncompressed unless the
 * fixture is specifically about compression.
 *
 * Run:  node scripts/make-m6-round3-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflate } from 'pako';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const save = async (name, doc) => {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

const blank = async (pages = 1, label = 'R3') => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([300, 300]);
        page.drawText(`${label}${i + 1}`, { x: 20, y: 260, size: 16, font });
    }
    return doc;
};

// ---------------------------------------------------------------------------
// BLK-1R — JavaScript that is not labelled /S /JavaScript
// ---------------------------------------------------------------------------

/**
 * A Rendition action carries its script in `/JS` under `/S /Rendition`.
 *
 * The reachable scanner asked only about `/S`, so it reported zero for this
 * document. `chainLinks` puts the carrier behind a run of indirect objects, so a
 * census that depended on traversal depth to reach it would miss it.
 */
async function renditionJs(chainLinks, marker) {
    const doc = await blank(1, 'REND');
    const page = doc.getPages()[0];
    const annotDict = doc.context.obj({
        Type: 'Annot', Subtype: 'Screen', Rect: [10, 10, 60, 40],
        A: { Type: 'Action', S: 'Rendition', JS: PDFString.of(marker) },
    });
    const annot = doc.context.register(annotDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));

    if (chainLinks > 0) {
        const dicts = [];
        const refs = [];
        for (let i = 0; i < chainLinks; i += 1) {
            const dict = doc.context.obj({ M6Index: i });
            dicts.push(dict);
            refs.push(doc.context.register(dict));
        }
        for (let i = 0; i < chainLinks; i += 1) {
            dicts[i].set(PDFName.of('M6N'), i + 1 < chainLinks ? refs[i + 1] : annot);
        }
        page.node.set(PDFName.of('M6Chain'), refs[0]);
    }
    return doc;
}

// ---------------------------------------------------------------------------
// BLK-2R — a typeless /EF carrier
// ---------------------------------------------------------------------------

/**
 * A dictionary carrying `/EF` with no `/Type /Filespec`, and a payload stream
 * with no `/Type /EmbeddedFile`, inside a `/Launch` action.
 *
 * Detection that asked about `/Type` missed all three facts, and the payload was
 * in the artifact while the census reported zero.
 */
async function typelessEf(deep, marker) {
    const doc = await blank(1, 'TYPELESS');
    const page = doc.getPages()[0];
    const payload = doc.context.register(doc.context.stream(marker, {}));
    const annotDict = doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40],
        A: {
            Type: 'Action', S: 'Launch',
            F: { F: PDFString.of('hidden-payload.bin'), EF: { F: payload } },
        },
    });
    const annot = doc.context.register(annotDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    if (deep) {
        let tail = annot;
        for (let i = 0; i < 200; i += 1) {
            tail = doc.context.register(doc.context.obj({ M6Link: tail }));
        }
        page.node.set(PDFName.of('M6Chain'), tail);
    }
    return doc;
}

/** The same payload as an explicit `/Filespec`, for contrast. */
async function explicitFilespec(marker) {
    const doc = await blank(1, 'EXPLICIT');
    const page = doc.getPages()[0];
    const payload = doc.context.register(doc.context.stream(marker, { Type: 'EmbeddedFile' }));
    const spec = doc.context.register(doc.context.obj({
        Type: 'Filespec', F: PDFString.of('explicit.bin'), EF: { F: payload },
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 10, 40, 40], FS: spec,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-A — documents whose safety facts must be re-derived from the bytes
// ---------------------------------------------------------------------------

/** XFA with a valid, empty `/Fields`. */
async function xfaEmptyFields() {
    const doc = await blank(1, 'XFAEMPTY');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [], XFA: PDFString.of('<xdp:xdp/>'),
    })));
    return doc;
}

/** XFA with no `/Fields` at all — detection must not depend on one. */
async function xfaMissingFields() {
    const doc = await blank(1, 'XFANOF');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        XFA: PDFString.of('<xdp:xdp/>'),
    })));
    return doc;
}

/** XFA whose `/Fields` is the wrong type. */
async function xfaMalformedFields() {
    const doc = await blank(1, 'XFABAD');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: PDFString.of('not an array'), XFA: PDFString.of('<xdp:xdp/>'),
    })));
    return doc;
}

/** An AcroForm whose field tree cannot be read. Must fail closed. */
async function malformedAcroForm() {
    const doc = await blank(1, 'BADFORM');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: PDFString.of('not an array'),
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-H — source-page routes this contract does not support
// ---------------------------------------------------------------------------

/** A page `/Thread`, whose bead chain reaches another page. */
async function threadFixture() {
    const doc = await blank(2, 'THREAD');
    const [p1, p2] = doc.getPages();
    const beadB = doc.context.register(doc.context.obj({ P: p2.ref, R: [0, 0, 50, 50] }));
    const beadA = doc.context.register(doc.context.obj({
        P: p1.ref, R: [0, 0, 50, 50], N: beadB,
    }));
    const thread = doc.context.register(doc.context.obj({ Type: 'Thread', F: beadA }));
    doc.catalog.set(PDFName.of('Threads'), doc.context.obj([thread]));
    p1.node.set(PDFName.of('B'), doc.context.obj([beadA]));
    return doc;
}

/** An annotation whose `/Popup` sits on another page. */
async function popupCrossPage() {
    const doc = await blank(2, 'POPUP');
    const [p1, p2] = doc.getPages();
    const popup = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 80, 80], P: p2.ref,
    }));
    const parent = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Popup: popup,
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([parent]));
    p2.node.set(PDFName.of('Annots'), doc.context.obj([popup]));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-D — a compressed XMP packet
// ---------------------------------------------------------------------------

async function flateXmp() {
    const doc = await blank(1, 'XMPFLATE');
    const packet = '<?xpacket begin="" id="M6R3_XMP_FLATE_MARKER"?>'
        + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';
    const compressed = deflate(new TextEncoder().encode(packet));
    const stream = doc.context.register(doc.context.stream(compressed, {
        Type: 'Metadata', Subtype: 'XML', Filter: PDFName.of('FlateDecode'),
    }));
    doc.catalog.set(PDFName.of('Metadata'), stream);
    doc.setTitle('M6R3_TITLE');
    return doc;
}

// ---------------------------------------------------------------------------
// Optional-content configuration fidelity
// ---------------------------------------------------------------------------

async function ocConfig({ label, group, dName, baseState, order }) {
    const doc = await blank(1, label);
    const page = doc.getPages()[0];
    const ocg = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of(group),
    }));
    page.node.lookup(PDFName.of('Resources')).set(
        PDFName.of('Properties'), doc.context.obj({ M6L: ocg }),
    );
    const d = { ON: [ocg] };
    if (dName) d.Name = PDFString.of(dName);
    if (baseState) d.BaseState = PDFName.of(baseState);
    if (order) d.Order = [ocg];
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: d }));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-I — deferred structures that must still be disclosed
// ---------------------------------------------------------------------------

async function withOutlinesAndLabels() {
    const doc = await blank(2, 'DEFERRED');
    const outlines = doc.context.register(doc.context.obj({ Type: 'Outlines', Count: 0 }));
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({
        Nums: [0, { S: PDFName.of('D'), St: 1 }],
    }));
    return doc;
}

/**
 * A document that produces more than eight losses **and** an attachment.
 *
 * RF-C: the UI truncated its loss list at eight, so the attachment filename
 * could drop off the end while the broad approval still authorised deleting it.
 */
async function manyLosses() {
    const doc = await blank(4, 'MANY');
    const pages = doc.getPages();

    // An attachment, which is the loss that must stay visible.
    const payload = doc.context.register(
        doc.context.stream('M6R3_MANY_PAYLOAD', { Type: 'EmbeddedFile' }),
    );
    const spec = doc.context.register(doc.context.obj({
        Type: 'Filespec', F: PDFString.of('secret-notes.txt'), EF: { F: payload },
    }));
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        EmbeddedFiles: { Names: [PDFString.of('secret-notes.txt'), spec] },
    })));

    // Tagging, so a second confirmation-required loss exists.
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({
        Type: 'StructTreeRoot', K: [],
    })));
    pages.forEach((p, i) => p.node.set(PDFName.of('StructParents'), doc.context.obj(i)));

    // Deferred structures.
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({
        Type: 'Outlines', Count: 0,
    })));
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({
        Nums: [0, { S: PDFName.of('D'), St: 1 }],
    }));

    // Eight links from page 1 to pages that will not be selected, each one its
    // own reported loss.
    const annots = [];
    for (let i = 0; i < 8; i += 1) {
        annots.push(doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: [10, 10 + i * 12, 60, 20 + i * 12],
            Dest: [pages[(i % 3) + 1].ref, PDFName.of('Fit')],
        })));
    }
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj(annots));
    return doc;
}

async function main() {
    await save('r3-rendition-js', await renditionJs(0, 'M6R3_RENDITION_SHALLOW'));
    for (const links of [126, 127, 128, 129, 130]) {
        await save(`r3-rendition-js-chain-${links}`, await renditionJs(links, `M6R3_RENDITION_${links}`));
    }

    await save('r3-typeless-ef', await typelessEf(false, 'M6R3_TYPELESS_SHALLOW'));
    await save('r3-typeless-ef-deep', await typelessEf(true, 'M6R3_TYPELESS_DEEP'));
    await save('r3-explicit-filespec', await explicitFilespec('M6R3_EXPLICIT_PAYLOAD'));

    await save('r3-xfa-empty-fields', await xfaEmptyFields());
    await save('r3-xfa-missing-fields', await xfaMissingFields());
    await save('r3-xfa-malformed-fields', await xfaMalformedFields());
    await save('r3-malformed-acroform', await malformedAcroForm());

    await save('r3-thread', await threadFixture());
    await save('r3-popup-crosspage', await popupCrossPage());

    await save('r3-xmp-flate', await flateXmp());

    await save('r3-oc-name-a', await ocConfig({
        label: 'OCNA', group: 'M6-OC-A', dName: 'Config A', order: true,
    }));
    await save('r3-oc-name-b', await ocConfig({
        label: 'OCNB', group: 'M6-OC-B', dName: 'Config B', order: true,
    }));
    await save('r3-oc-name-same', await ocConfig({
        label: 'OCNS', group: 'M6-OC-C', dName: 'Config A', order: true,
    }));
    await save('r3-oc-basestate-on', await ocConfig({
        label: 'OCBS', group: 'M6-OC-D', baseState: 'ON', order: true,
    }));
    await save('r3-oc-order', await ocConfig({
        label: 'OCORD', group: 'M6-OC-E', order: true,
    }));
    await save('r3-oc-no-order', await ocConfig({
        label: 'OCNOORD', group: 'M6-OC-F', order: false,
    }));

    await save('r3-deferred-structures', await withOutlinesAndLabels());
    await save('r3-many-losses', await manyLosses());

    console.log(`m6 round-3 fixtures: ${written.length} documents`);
    for (const name of written) console.log(`  ${name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
