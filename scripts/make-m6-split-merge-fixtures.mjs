/**
 * Synthetic documents for the M6 Split / Merge gate.
 *
 * Every one of these exists because some check has to be able to reach a
 * boundary case. A gate in which every document is processed successfully would
 * be asserting the defect: most of what M6 promises is that it **refuses**, by
 * name, before it has touched anything.
 *
 * Nothing here is a customer file and nothing is downloaded. Each document is
 * built byte by byte or through pdf-lib, and the hostile ones are built by hand
 * because the shapes that matter — a decode bomb, an ambiguous name escape, an
 * object stream whose offsets overlap — are shapes a well-behaved writer will
 * not produce.
 *
 * Run:  node scripts/make-m6-split-merge-fixtures.mjs
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
const write = (name, bytes) => {
    const file = path.join(OUT, `${name}.pdf`);
    fs.writeFileSync(file, Buffer.from(bytes));
    written.push({ name, bytes: bytes.length });
};

const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const concat = (parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
};

// ---------------------------------------------------------------------------
// Ordinary documents, built with pdf-lib.
// ---------------------------------------------------------------------------

async function plain(pages, label) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([595, 842]);
        page.drawText(`${label} ${i + 1}`, { x: 40, y: 780, size: 20, font });
    }
    return doc;
}

/** Four pages, page 1 linking to page 3. The orphan-page shape. */
async function navFourPages() {
    const doc = await plain(4, 'NAV');
    const pages = doc.getPages();
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 40, 220, 64],
        Dest: [pages[2].ref, PDFName.of('XYZ'), 0, 842, 0],
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** A `/GoTo` action rather than a bare `/Dest`. The second route in. */
async function navGoTo() {
    const doc = await plain(3, 'GOTO');
    const pages = doc.getPages();
    const action = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'GoTo', D: [pages[2].ref, PDFName.of('Fit')],
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 220, 64], A: action,
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/**
 * An article bead. Page 1 has no link annotation at all and still reaches
 * another page, through `/B` to a bead whose `/P` is page 2.
 */
async function beadBeyondAnnots() {
    const doc = await plain(2, 'BEAD');
    const pages = doc.getPages();
    const beadB = doc.context.register(doc.context.obj({ P: pages[1].ref, R: [0, 0, 100, 100] }));
    const beadA = doc.context.register(doc.context.obj({
        P: pages[0].ref, R: [0, 0, 100, 100], N: beadB,
    }));
    pages[0].node.set(PDFName.of('B'), doc.context.obj([beadA]));
    return doc;
}

/** A named destination whose target is page 2. */
async function namedDestination() {
    const doc = await plain(3, 'NAMED');
    const pages = doc.getPages();
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        Dests: {
            Names: [
                PDFString.of('target'),
                [pages[1].ref, PDFName.of('XYZ'), 0, 842, 0],
            ],
        },
    })));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 220, 64], Dest: PDFString.of('target'),
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** A JavaScript action held as an indirect object on an annotation's `/A`. */
async function javascriptAnnot() {
    const doc = await plain(1, 'JS');
    const action = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("M6");'),
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40], A: action,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** JavaScript two `/Next` links down — the shape an array-stops scanner missed. */
async function javascriptNextChain() {
    const doc = await plain(1, 'JSNEXT');
    const deep = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("deep");'),
    }));
    const middle = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'ResetForm', Next: [deep],
    }));
    const action = doc.context.register(doc.context.obj({
        Type: 'Action', S: 'ResetForm', Next: middle,
    }));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40], A: action,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

/** An applied signature: a `/Sig` field whose `/V` is a dictionary. */
async function appliedSignature() {
    const doc = await plain(2, 'SIGNED');
    const value = doc.context.register(doc.context.obj({
        Type: 'Sig', Filter: PDFName.of('Adobe.PPKLite'), SubFilter: PDFName.of('adbe.pkcs7.detached'),
    }));
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Sig'), T: PDFString.of('signature1'),
        Rect: [40, 700, 240, 760], V: value, F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], SigFlags: 3,
    })));
    return doc;
}

/** An EMPTY signature field. A form control, not a signature. */
async function emptySignatureField() {
    const doc = await plain(1, 'SIGFIELD');
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Sig'), T: PDFString.of('unsigned'),
        Rect: [40, 700, 240, 760], F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget],
    })));
    return doc;
}

/** A simple merged `/Tx` field — the one shape the reconstruction rebuilds. */
async function formTxPlain(fieldName = 'plain.field', value = 'M6-TX-VALUE') {
    const doc = await plain(1, 'FORM');
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'),
        T: PDFString.of(fieldName), V: PDFString.of(value),
        Rect: [40, 700, 300, 730], F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], NeedAppearances: true,
    })));
    return doc;
}

/** The same field with `/Ff` — read and never restored, so refused. */
async function formTxFf() {
    const doc = await formTxPlain('flagged.field', 'V');
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    const fields = acro.lookup(PDFName.of('Fields'));
    const widget = doc.context.lookup(fields.get(0));
    widget.set(PDFName.of('Ff'), doc.context.obj(1));
    return doc;
}

/** A `/Ch` choice field — outside the proven subset. */
async function formChoice() {
    const doc = await plain(1, 'CHOICE');
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Ch'),
        T: PDFString.of('choice.field'), V: PDFString.of('a'),
        Opt: [PDFString.of('a'), PDFString.of('b')],
        Rect: [40, 700, 300, 730], F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget],
    })));
    return doc;
}

/** A field whose widgets straddle two pages. */
async function formFieldAcrossPages() {
    const doc = await plain(2, 'STRADDLE');
    const pages = doc.getPages();
    const kidA = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [40, 700, 300, 730], F: 4,
    }));
    const kidB = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', Rect: [40, 700, 300, 730], F: 4,
    }));
    const field = doc.context.register(doc.context.obj({
        FT: PDFName.of('Tx'), T: PDFString.of('across'), V: PDFString.of('x'), Kids: [kidA, kidB],
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([kidA]));
    pages[1].node.set(PDFName.of('Annots'), doc.context.obj([kidB]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [field],
    })));
    return doc;
}

/** XFA. Refused by M6-H4 wherever the operation would drop it. */
async function xfa() {
    const doc = await plain(1, 'XFA');
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [], XFA: PDFString.of('<xdp:xdp/>'),
    })));
    return doc;
}

/** Optional content this reader understands: one group, named from a page. */
async function ocgSupported() {
    const doc = await plain(1, 'OCG');
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-LAYER-A'),
    }));
    const page = doc.getPages()[0];
    const resources = page.node.lookup(PDFName.of('Resources'));
    resources.set(PDFName.of('Properties'), doc.context.obj({ M6L: group }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [group], D: { ON: [group], Order: [group] },
    }));
    return doc;
}

/** An `/OCMD`, which decides visibility from a set. Refused. */
async function ocmd() {
    const doc = await plain(1, 'OCMD');
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-LAYER-B'),
    }));
    const membership = doc.context.register(doc.context.obj({
        Type: 'OCMD', OCGs: [group],
    }));
    const page = doc.getPages()[0];
    const resources = page.node.lookup(PDFName.of('Resources'));
    resources.set(PDFName.of('Properties'), doc.context.obj({ M6M: membership }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [group], D: { ON: [group] },
    }));
    return doc;
}

/**
 * B1: a group named from a soft mask's `/G` resources.
 *
 * This is the path the walker did not open until B1, and the document extracted
 * READY with a group behind it. It must refuse.
 */
async function ocgExtGStateSMask() {
    const doc = await plain(1, 'SMASK');
    const group = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of('M6-SMASK-LAYER'),
    }));
    const inner = doc.context.stream('', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
        Resources: { Properties: { M6L: group } },
    });
    const innerRef = doc.context.register(inner);
    const gs = doc.context.register(doc.context.obj({
        Type: 'ExtGState', SMask: { S: PDFName.of('Luminosity'), G: innerRef },
    }));
    const page = doc.getPages()[0];
    const resources = page.node.lookup(PDFName.of('Resources'));
    resources.set(PDFName.of('ExtGState'), doc.context.obj({ M6GS: gs }));
    return doc;
}

/** A soft mask with nothing optional behind it. Must stay READY. */
async function smaskClean() {
    const doc = await plain(1, 'SMASKOK');
    const inner = doc.context.register(doc.context.stream('', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: {},
    }));
    const gs = doc.context.register(doc.context.obj({
        Type: 'ExtGState', SMask: { S: PDFName.of('Luminosity'), G: inner },
    }));
    const page = doc.getPages()[0];
    page.node.lookup(PDFName.of('Resources')).set(PDFName.of('ExtGState'), doc.context.obj({ M6GS: gs }));
    return doc;
}

/** `/SMask /None`. Also not a reason to refuse. */
async function smaskNone() {
    const doc = await plain(1, 'SMASKNONE');
    const gs = doc.context.register(doc.context.obj({
        Type: 'ExtGState', SMask: PDFName.of('None'),
    }));
    const page = doc.getPages()[0];
    page.node.lookup(PDFName.of('Resources')).set(PDFName.of('ExtGState'), doc.context.obj({ M6GS: gs }));
    return doc;
}

/** A tagged document: `/StructTreeRoot` plus `/StructParents` on a page. */
async function tagged() {
    const doc = await plain(2, 'TAGGED');
    const root = doc.context.register(doc.context.obj({ Type: 'StructTreeRoot', K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), root);
    doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
    doc.getPages().forEach((p, i) => p.node.set(PDFName.of('StructParents'), doc.context.obj(i)));
    return doc;
}

/** An embedded file, through the catalog name tree. */
async function withAttachment() {
    const doc = await plain(1, 'ATTACH');
    const stream = doc.context.register(doc.context.flateStream('hello'));
    const spec = doc.context.register(doc.context.obj({
        Type: 'Filespec', F: PDFString.of('note.txt'), UF: PDFString.of('note.txt'),
        EF: { F: stream },
    }));
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        EmbeddedFiles: { Names: [PDFString.of('note.txt'), spec] },
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// Hostile documents, built by hand. A well-behaved writer will not make these.
// ---------------------------------------------------------------------------

/** A minimal, valid, hand-built document the boundary must PASS. */
function handBuiltMinimal() {
    const body = '%PDF-1.7\n'
        + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
        + '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
        + '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n'
        + 'trailer\n<< /Size 4 /Root 1 0 R >>\n'
        + 'startxref\n0\n%%EOF\n';
    return latin1(body);
}

/**
 * An object stream that decodes to far more than its input.
 *
 * 33,149 B of input decoding to 33,554,457 B is the shape B2 measured; this is
 * the same shape at a size a gate can run quickly. The point is the ratio, and
 * that the boundary stops without materialising the whole thing.
 */
function decodeBomb(decodedBytes) {
    const inner = latin1('1 0 '.repeat(1) + ' '.repeat(decodedBytes));
    const compressed = deflate(inner);
    const head = latin1('%PDF-1.7\n1 0 obj\n'
        + `<< /Type /ObjStm /N 1 /First 4 /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`);
    const tail = latin1('\nendstream\nendobj\n'
        + 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    return concat([head, compressed, tail]);
}

/** A cross-reference stream declaring an implausible number of entries. */
function xrefEntryBomb(entries) {
    const payload = deflate(new Uint8Array(12));
    const head = latin1('%PDF-1.7\n1 0 obj\n'
        + `<< /Type /XRef /Size ${entries} /W [1 2 1] /Length ${payload.length} /Filter /FlateDecode >>\nstream\n`);
    const tail = latin1('\nendstream\nendobj\n'
        + 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    return concat([head, payload, tail]);
}

/** An object stream declaring more objects than any cap would allow. */
function objectStreamObjectBomb(count) {
    const payload = deflate(latin1('1 0 '));
    const head = latin1('%PDF-1.7\n1 0 obj\n'
        + `<< /Type /ObjStm /N ${count} /First 4 /Length ${payload.length} /Filter /FlateDecode >>\nstream\n`);
    const tail = latin1('\nendstream\nendobj\n'
        + 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    return concat([head, payload, tail]);
}

/**
 * A decode candidate whose `/Filter` is spelled with a lowercase hex escape.
 *
 * pdf-lib decodes only uppercase `#xx`, so it reads the key as `Fi#6cter` and
 * a case-blind reader reads `Filter`. On a stream that is to be decoded, that
 * difference could hide a filter, so it is refused rather than resolved.
 */
function ambiguousNameEscape() {
    const payload = deflate(latin1('1 0 '));
    const head = latin1('%PDF-1.7\n1 0 obj\n'
        + `<< /Type /ObjStm /N 1 /First 4 /Length ${payload.length} /Fi#6cter /FlateDecode >>\nstream\n`);
    const tail = latin1('\nendstream\nendobj\n'
        + 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    return concat([head, payload, tail]);
}

/** A stream whose `/Type` is indirect, so it cannot be read before the parse. */
function indirectTypeOnStream() {
    return latin1('%PDF-1.7\n'
        + '1 0 obj\n<< /Type 2 0 R /Length 0 >>\nstream\n\nendstream\nendobj\n'
        + '2 0 obj\n/ObjStm\nendobj\n'
        + 'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
}

/** Bytes that are not an object, an xref, a trailer or a startxref. */
function unexpectedBytes() {
    return latin1('%PDF-1.7\n1 0 obj\n<< >>\nendobj\nTHIS IS NOT PDF SYNTAX\n'
        + 'trailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n');
}

/** An encrypted document, named in the raw bytes. */
function encrypted() {
    return latin1('%PDF-1.7\n'
        + '1 0 obj\n<< /Type /Catalog >>\nendobj\n'
        + 'trailer\n<< /Size 2 /Root 1 0 R /Encrypt 2 0 R >>\nstartxref\n0\n%%EOF\n');
}

/** A decode candidate with no direct `/Length` that reaches `endstream`. */
function ambiguousStreamLength() {
    const payload = deflate(latin1('1 0 '));
    const head = latin1('%PDF-1.7\n1 0 obj\n'
        + '<< /Type /ObjStm /N 1 /First 4 /Length 2 0 R /Filter /FlateDecode >>\nstream\n');
    const tail = latin1('\nendstream\nendobj\n'
        + 'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    return concat([head, payload, tail]);
}

/** Not a PDF at all. */
function noHeader() {
    return latin1('this file is not a PDF, whatever its extension says\n');
}

// ---------------------------------------------------------------------------

async function main() {
    const save = async (name, doc, options = {}) => {
        write(name, await doc.save({ useObjectStreams: false, ...options }));
    };

    await save('nav-4p', await navFourPages());
    await save('nav-goto', await navGoTo());
    await save('bead-beyond-annots', await beadBeyondAnnots());
    await save('named-destination', await namedDestination());
    await save('js-annot-a', await javascriptAnnot());
    await save('js-next-chain', await javascriptNextChain());
    await save('signature-applied', await appliedSignature());
    await save('signature-field-empty', await emptySignatureField());
    await save('form-tx-plain', await formTxPlain());
    await save('form-tx-ff', await formTxFf());
    await save('form-choice', await formChoice());
    await save('form-field-across-pages', await formFieldAcrossPages());
    await save('xfa', await xfa());
    await save('ocg-supported', await ocgSupported());
    await save('ocmd', await ocmd());
    await save('ocg-extgstate-smask', await ocgExtGStateSMask());
    await save('smask-clean', await smaskClean());
    await save('smask-none', await smaskNone());
    await save('tagged', await tagged());
    await save('with-attachment', await withAttachment());

    // Merge sources, including two that declare the same field name.
    await save('merge-a', await plain(3, 'A'));
    await save('merge-b', await plain(2, 'B'));
    await save('merge-collide-1', await formTxPlain('shared.field', 'ONE'));
    await save('merge-collide-2', await formTxPlain('shared.field', 'TWO'));

    // The object-stream route, which the boundary must walk and PASS.
    write('objstm-ok', await (await plain(3, 'OBJSTM')).save({ useObjectStreams: true }));

    write('hand-built-minimal', handBuiltMinimal());
    write('decode-bomb-small', decodeBomb(200_000));
    write('decode-bomb-large', decodeBomb(4_000_000));
    write('xref-entry-bomb', xrefEntryBomb(5_000_000));
    write('objstm-object-bomb', objectStreamObjectBomb(500_000));
    write('ambiguous-name-escape', ambiguousNameEscape());
    write('indirect-type-on-stream', indirectTypeOnStream());
    write('unexpected-bytes', unexpectedBytes());
    write('encrypted', encrypted());
    write('ambiguous-stream-length', ambiguousStreamLength());
    write('no-header', noHeader());

    const manifest = {
        generatedBy: 'scripts/make-m6-split-merge-fixtures.mjs',
        note: 'Synthetic only. No customer document, no network, no secret.',
        count: written.length,
        files: written,
    };
    fs.writeFileSync(
        path.join(OUT, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );

    console.log(`m6 split/merge fixtures: ${written.length} documents in ${path.relative(ROOT, OUT)}`);
    for (const f of written) console.log(`  ${f.name.padEnd(26)} ${String(f.bytes).padStart(9)} B`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
