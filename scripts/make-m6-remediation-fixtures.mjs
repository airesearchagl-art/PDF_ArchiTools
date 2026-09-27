/**
 * The documents the Independent FULL Review's findings are proven against.
 *
 * Separate from `make-m6-split-merge-fixtures.mjs` on purpose: these exist
 * because a specific defect reached the artifact, and each one carries a marker
 * that can be looked for in the serialized bytes. A gate that asked the
 * production scanner whether the production sanitizer had worked would be asking
 * the same code twice; these let it look at the file instead.
 *
 * Every payload is a distinctive ASCII marker and every stream is written
 * uncompressed, so "is it in the bytes" is a question the gate can answer
 * without decoding anything.
 *
 * Run:  node scripts/make-m6-remediation-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const writeRaw = (name, text) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(text, 'latin1'));
    written.push(name);
};

const blank = async (pages = 1, label = 'P') => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([300, 300]);
        page.drawText(`${label}${i + 1}`, { x: 20, y: 260, size: 16, font });
    }
    return doc;
};

const js = (marker) => ({ Type: 'Action', S: 'JavaScript', JS: PDFString.of(marker) });

// ---------------------------------------------------------------------------
// BLK-1 — JavaScript that survived while both counts said zero
// ---------------------------------------------------------------------------

/**
 * The destination rebuild replaces `/A`, orphaning an indirect `/GoTo` that
 * carries a **direct** JavaScript action under `/Next`. A top-level `/S` check
 * never looks inside it.
 */
async function jsDetachedNext() {
    const doc = await blank(2, 'JSNEXT');
    const [p1, p2] = doc.getPages();
    const old = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('Fit')], Next: js('M6JS_DETACHED_NEXT'),
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40], A: old,
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** A `/FileAttachment` annotation whose `/AA` holds a direct JavaScript action. */
async function jsFileAttachmentAa() {
    const doc = await blank(1, 'JSATT');
    const page = doc.getPages()[0];
    const payload = doc.context.register(
        doc.context.stream('M6ATTACHMENT_PAYLOAD_MARKER', { Type: 'EmbeddedFile' }),
    );
    const spec = doc.context.register(doc.context.obj({
        Type: 'Filespec', F: PDFString.of('secret-notes.txt'), EF: { F: payload },
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 10, 40, 40],
        FS: spec, AA: { U: js('M6JS_FILEATTACH_AA') },
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/**
 * A parent form field reachable only through the widget's `/Parent`. The
 * AcroForm rebuild deletes `/Parent`, detaching a field whose `/AA` holds a
 * direct JavaScript action.
 */
async function jsDetachedParentField() {
    const doc = await blank(1, 'JSFIELD');
    const page = doc.getPages()[0];
    const parent = doc.context.register(doc.context.obj({
        T: PDFString.of('parent'), AA: { K: js('M6JS_DETACHED_FIELD') },
    }));
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'), T: PDFString.of('kid'),
        V: PDFString.of('value'), Rect: [10, 200, 200, 230], Parent: parent,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget],
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// M6-H5A — source-page references on routes that are not /Dest
// ---------------------------------------------------------------------------

/** An annotation whose `/P` names a different page. */
async function pageRefAnnotP() {
    const doc = await blank(2, 'ANNOTP');
    const [p1, p2] = doc.getPages();
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 40, 40], P: p2.ref,
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** An annotation `/AA` whose action is a `/GoTo` to another page. */
async function pageRefAnnotAa() {
    const doc = await blank(2, 'ANNOTAA');
    const [p1, p2] = doc.getPages();
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 40, 40],
        AA: { E: { Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('Fit')] } },
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** A widget `/AA` reaching another page. */
async function pageRefWidgetAa() {
    const doc = await blank(2, 'WIDGETAA');
    const [p1, p2] = doc.getPages();
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'), T: PDFString.of('w'),
        V: PDFString.of('v'), Rect: [10, 200, 200, 230],
        AA: { F: { Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('Fit')] } },
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget],
    })));
    return doc;
}

/** A page `/AA` reaching another page. */
async function pageRefPageAa() {
    const doc = await blank(2, 'PAGEAA');
    const [p1, p2] = doc.getPages();
    p1.node.set(PDFName.of('AA'), doc.context.obj({
        O: { Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('Fit')] },
    }));
    return doc;
}

/** A `/GoTo` two `/Next` links down. */
async function pageRefRecursiveNext() {
    const doc = await blank(2, 'NEXTGOTO');
    const [p1, p2] = doc.getPages();
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 40, 40],
        A: {
            Type: 'Action', S: 'ResetForm',
            Next: {
                Type: 'Action', S: 'ResetForm',
                Next: { Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('Fit')] },
            },
        },
    }));
    p1.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

// ---------------------------------------------------------------------------
// M6-H9b-A — optional content behind INHERITED resources
// ---------------------------------------------------------------------------

/** The page declares no `/Resources`; the parent `/Pages` provides `/Properties`. */
async function inheritedProperties() {
    const doc = await blank(1, 'INHPROP');
    const page = doc.getPages()[0];
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-INHERITED-LAYER'),
    }));
    const parentRef = page.node.get(PDFName.of('Parent'));
    const parent = doc.context.lookup(parentRef);
    parent.set(PDFName.of('Resources'), doc.context.obj({ Properties: { M6L: group } }));
    page.node.delete(PDFName.of('Resources'));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [group], D: { ON: [group] },
    }));
    return doc;
}

/** An inherited `/XObject` whose form carries `/OC`. */
async function inheritedXObjectOc() {
    const doc = await blank(1, 'INHXOBJ');
    const page = doc.getPages()[0];
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-INHERITED-XOBJ'),
    }));
    const form = doc.context.register(doc.context.stream('', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], OC: group, Resources: {},
    }));
    const parent = doc.context.lookup(page.node.get(PDFName.of('Parent')));
    parent.set(PDFName.of('Resources'), doc.context.obj({ XObject: { M6X: form } }));
    page.node.delete(PDFName.of('Resources'));
    return doc;
}

/** An inherited `/ExtGState` whose soft mask `/G` names a group. */
async function inheritedSMaskG() {
    const doc = await blank(1, 'INHSMASK');
    const page = doc.getPages()[0];
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-INHERITED-SMASK'),
    }));
    const inner = doc.context.register(doc.context.stream('', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
        Resources: { Properties: { M6L: group } },
    }));
    const gs = doc.context.register(doc.context.obj({
        Type: 'ExtGState', SMask: { S: PDFName.of('Luminosity'), G: inner },
    }));
    const parent = doc.context.lookup(page.node.get(PDFName.of('Parent')));
    parent.set(PDFName.of('Resources'), doc.context.obj({ ExtGState: { M6GS: gs } }));
    page.node.delete(PDFName.of('Resources'));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-6 — inherited field type and inherited applied signature
// ---------------------------------------------------------------------------

/** A terminal field with no `/FT` of its own, inheriting `/Sig` from its parent. */
async function inheritedSignatureField() {
    const doc = await blank(1, 'INHSIG');
    const page = doc.getPages()[0];
    const parentDict = doc.context.obj({
        FT: PDFName.of('Sig'), T: PDFString.of('sig-parent'),
    });
    const parent = doc.context.register(parentDict);
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [10, 200, 200, 240], Parent: parent, F: 4,
    }));
    parentDict.set(PDFName.of('Kids'), doc.context.obj([widget]));
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [parent],
    })));
    return doc;
}

/** The same, with an applied signature inherited through `/V`. */
async function inheritedAppliedSignature() {
    const doc = await blank(1, 'INHSIGAPP');
    const page = doc.getPages()[0];
    const value = doc.context.register(doc.context.obj({
        Type: 'Sig', Filter: PDFName.of('Adobe.PPKLite'),
    }));
    const parentDict = doc.context.obj({
        FT: PDFName.of('Sig'), T: PDFString.of('sig-parent'), V: value,
    });
    const parent = doc.context.register(parentDict);
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [10, 200, 200, 240], Parent: parent, F: 4,
    }));
    parentDict.set(PDFName.of('Kids'), doc.context.obj([widget]));
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [parent], SigFlags: 3,
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-8 — metadata beyond the five keys pdf-lib has setters for
// ---------------------------------------------------------------------------

async function richMetadata() {
    const doc = await blank(2, 'META');
    doc.setTitle('M6_TITLE_MARKER');
    doc.setAuthor('M6_AUTHOR_MARKER');
    const infoRef = doc.context.trailerInfo.Info;
    const info = doc.context.lookup(infoRef);
    info.set(PDFName.of('Company'), PDFString.of('M6_COMPANY_MARKER'));
    info.set(PDFName.of('M6Custom'), PDFString.of('M6_CUSTOM_MARKER'));
    const xmp = doc.context.register(doc.context.stream(
        '<?xpacket begin="" id="M6_XMP_MARKER"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>',
        { Type: 'Metadata', Subtype: 'XML' },
    ));
    doc.catalog.set(PDFName.of('Metadata'), xmp);
    return doc;
}

// ---------------------------------------------------------------------------
// Tagging remnants below the catalog
// ---------------------------------------------------------------------------

async function taggingRemnants() {
    const doc = await blank(1, 'TAGREM');
    const page = doc.getPages()[0];
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({
        Type: 'StructTreeRoot', K: [],
    })));
    doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 40, 40], StructParent: 1,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    const form = doc.context.register(doc.context.stream('', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], StructParents: 2, Resources: {},
    }));
    page.node.lookup(PDFName.of('Resources')).set(
        PDFName.of('XObject'), doc.context.obj({ M6X: form }),
    );
    return doc;
}

// ---------------------------------------------------------------------------
// RF-4 — a Merge source carrying supported optional content
// ---------------------------------------------------------------------------

async function mergeOcgSource(label, groupName) {
    const doc = await blank(1, label);
    const page = doc.getPages()[0];
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of(groupName),
    }));
    page.node.lookup(PDFName.of('Resources')).set(
        PDFName.of('Properties'), doc.context.obj({ M6L: group }),
    );
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [group], D: { ON: [group], Order: [group] },
    }));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-1 — Encrypt spelled every way, raw and inside an object stream
// ---------------------------------------------------------------------------

const encryptFixture = (name, spelling) => writeRaw(name,
    '%PDF-1.7\n'
    + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
    + '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
    + '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\n'
    + `trailer\n<< /Size 4 /Root 1 0 R ${spelling} 4 0 R >>\n`
    + 'startxref\n0\n%%EOF\n');

async function main() {
    await save('rem-js-detached-next', await jsDetachedNext());
    await save('rem-js-fileattachment-aa', await jsFileAttachmentAa());
    await save('rem-js-detached-parent-field', await jsDetachedParentField());

    await save('rem-pageref-annot-p', await pageRefAnnotP());
    await save('rem-pageref-annot-aa', await pageRefAnnotAa());
    await save('rem-pageref-widget-aa', await pageRefWidgetAa());
    await save('rem-pageref-page-aa', await pageRefPageAa());
    await save('rem-pageref-recursive-next', await pageRefRecursiveNext());

    await save('rem-inherited-properties', await inheritedProperties());
    await save('rem-inherited-xobject-oc', await inheritedXObjectOc());
    await save('rem-inherited-smask-g', await inheritedSMaskG());

    await save('rem-inherited-sig-field', await inheritedSignatureField());
    await save('rem-inherited-sig-applied', await inheritedAppliedSignature());

    await save('rem-metadata-rich', await richMetadata());
    await save('rem-tagging-remnants', await taggingRemnants());

    await save('rem-merge-ocg-a', await mergeOcgSource('OCGA', 'M6-MERGE-LAYER-A'));
    await save('rem-merge-ocg-b', await mergeOcgSource('OCGB', 'M6-MERGE-LAYER-B'));

    encryptFixture('rem-encrypt-plain', '/Encrypt');
    encryptFixture('rem-encrypt-partly-escaped', '/Encr#79pt');
    encryptFixture('rem-encrypt-fully-escaped', '/#45#6E#63#72#79#70#74');
    encryptFixture('rem-encrypt-lowercase-escaped', '/#45#6e#63#72#79#70#74');

    console.log(`m6 remediation fixtures: ${written.length} documents`);
    for (const name of written) console.log(`  ${name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
