/**
 * The documents the fifth Independent FULL Re-Review's findings are proven
 * against.
 *
 * **RF-R5-1** is why most of these exist, and why they are built the way they
 * are. A reconstruction plan named an annotation by its position in `/Annots`,
 * and sanitization then removed other entries from that same array, so every
 * later position moved and Extract refused a document it supports. The shape
 * that reaches it is an ordinary one — a widget annotation carrying `/P`, the
 * back-reference to its own page — and **no round-5 fixture has one**, because
 * pdf-lib does not write `/P` and every round-5 fixture was pdf-lib's. So these
 * set `/P` explicitly, and one of them writes its annotation *directly* into
 * `/Annots` rather than as a reference, which is the case a reference-based
 * identity has to have an answer for.
 *
 * **RF-R5-2** is a field `/DA` that is there and cannot be read: it was read as
 * absent, which skipped the `/DR` dependency check the fixture's valid control
 * trips. `/DA` is content-stream syntax, so the question is whether its *bytes*
 * can be read — `r6-da-hexbytes` is a readable byte string that happens to look
 * like UTF-16, and it is not a refusal.
 *
 * **RF-R5-3** is the artifact backstop's reach. Those fixtures are
 * output-shaped: each carries exactly one kind of signature evidence, and two
 * carry `/Contents` where `/Contents` is ordinary, so a detector that counted
 * the key rather than the semantics fails them.
 *
 * Run:  node scripts/make-m6-round6-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const save = async (name, doc) => {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

const blank = async (pages = 1, label = 'R6') => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([420, 620]);
        page.drawText(`${label}${i + 1}`, { x: 20, y: 580, size: 16, font });
    }
    return doc;
};

const N = (s) => PDFName.of(s);
const put = (doc, page, refs) => page.node.set(N('Annots'), doc.context.obj(refs));
const acroForm = (doc, fields, extra = {}) => {
    doc.catalog.set(N('AcroForm'), doc.context.register(
        doc.context.obj({ Fields: fields, ...extra }),
    ));
};

/** A signature value: the dictionary a signed field points at. */
const sigValue = (doc, marker) => doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    ByteRange: [0, 100, 200, 300],
    Contents: PDFHexString.of(Buffer.from(marker, 'latin1').toString('hex').toUpperCase()),
});

/**
 * A widget annotation, with `/P` unless told otherwise.
 *
 * `/P` is the key the defect needed: ordinary, optional, written by most
 * producers, and absent from everything pdf-lib builds.
 */
const widget = (doc, page, fields, { withP = true } = {}) => {
    const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        F: 4,
        Rect: [20, 200, 380, 240],
        ...fields,
    });
    if (withP) dict.set(N('P'), page.ref);
    return dict;
};

const link = (doc, page, target, { withP = true, y = 300 } = {}) => {
    const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [20, y, 380, y + 30],
        Border: [0, 0, 0],
        Dest: [target.ref, PDFName.of('XYZ'), null, null, null],
    });
    if (withP) dict.set(N('P'), page.ref);
    return dict;
};

// ---------------------------------------------------------------------------
// RF-R5-1 — a plan must survive the removal of another annotation
// ---------------------------------------------------------------------------

/** An empty signature field, carrying `/P`. Removed under M6-H1; nothing signed. */
async function sigEmptyP() {
    const doc = await blank(2, 'R6SE');
    const page = doc.getPages()[0];
    const ref = doc.context.register(widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.empty') }));
    put(doc, page, [ref]);
    acroForm(doc, [ref]);
    return doc;
}

/** An applied signature, carrying `/P`. M6-H1's unsigned derivative. */
async function sigAppliedP() {
    const doc = await blank(2, 'R6SA');
    const page = doc.getPages()[0];
    const w = widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.applied') });
    w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
    const ref = doc.context.register(w);
    put(doc, page, [ref]);
    acroForm(doc, [ref]);
    return doc;
}

/** A signature widget before a link: the link's plan must still find the link. */
async function sigThenLink() {
    const doc = await blank(2, 'R6SL');
    const [page, second] = doc.getPages();
    const w = widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.sig') });
    w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
    const sigRef = doc.context.register(w);
    const linkRef = doc.context.register(link(doc, page, second));
    put(doc, page, [sigRef, linkRef]);
    acroForm(doc, [sigRef]);
    return doc;
}

/** A signature widget before an ordinary text field. */
async function sigThenTx() {
    const doc = await blank(2, 'R6ST');
    const page = doc.getPages()[0];
    const w = widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.sig') });
    w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
    const sigRef = doc.context.register(w);
    const txRef = doc.context.register(widget(doc, page, {
        FT: 'Tx', T: PDFString.of('r6.kept'), V: PDFString.of('R6KEPTVALUE'),
    }));
    put(doc, page, [sigRef, txRef]);
    acroForm(doc, [sigRef, txRef]);
    return doc;
}

/** Two signature widgets removed before a retained link. */
async function sigMultiThenLink() {
    const doc = await blank(2, 'R6SM');
    const [page, second] = doc.getPages();
    const refs = [];
    for (const name of ['r6.sigA', 'r6.sigB']) {
        const w = widget(doc, page, { FT: 'Sig', T: PDFString.of(name) });
        w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
        refs.push(doc.context.register(w));
    }
    const linkRef = doc.context.register(link(doc, page, second));
    put(doc, page, [...refs, linkRef]);
    acroForm(doc, refs);
    return doc;
}

/** A retained link BEFORE the removed widget: nothing should shift at all. */
async function linkThenSig() {
    const doc = await blank(2, 'R6LS');
    const [page, second] = doc.getPages();
    const linkRef = doc.context.register(link(doc, page, second));
    const w = widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.sig') });
    w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
    const sigRef = doc.context.register(w);
    put(doc, page, [linkRef, sigRef]);
    acroForm(doc, [sigRef]);
    return doc;
}

/** No signature at all: the control that proves the others measure the removal. */
async function annotsControl() {
    const doc = await blank(2, 'R6AC');
    const [page, second] = doc.getPages();
    const linkRef = doc.context.register(link(doc, page, second));
    const txRef = doc.context.register(widget(doc, page, {
        FT: 'Tx', T: PDFString.of('r6.kept'), V: PDFString.of('R6KEPTVALUE'),
    }));
    put(doc, page, [linkRef, txRef]);
    acroForm(doc, [txRef]);
    return doc;
}

/**
 * An annotation written directly into `/Annots`, with a signature widget before
 * it. A direct dictionary has no reference to be named by, which is the case
 * the identity strategy has to answer rather than assume away.
 */
async function directAnnot() {
    const doc = await blank(2, 'R6DA');
    const [page, second] = doc.getPages();
    const w = widget(doc, page, { FT: 'Sig', T: PDFString.of('r6.sig') });
    w.set(N('V'), doc.context.register(sigValue(doc, 'R6SIGPAYLOAD')));
    const sigRef = doc.context.register(w);
    // Not registered: the array holds the dictionary itself.
    const direct = link(doc, page, second, { y: 340 });
    page.node.set(N('Annots'), doc.context.obj([sigRef, direct]));
    acroForm(doc, [sigRef]);
    return doc;
}

/**
 * A file-attachment annotation before a link. On the Merge route the
 * attachment annotation is removed *after* both plans are made, which is the
 * same defect reached by a different door.
 */
async function attachmentAnnotThenLink() {
    const doc = await blank(2, 'R6AA');
    const [page, second] = doc.getPages();
    const payload = doc.context.stream('R6ATTACHPAYLOAD', { Type: 'EmbeddedFile' });
    const spec = doc.context.register(doc.context.obj({
        Type: 'Filespec',
        F: PDFString.of('r6-note.txt'),
        UF: PDFString.of('r6-note.txt'),
        EF: { F: doc.context.register(payload) },
    }));
    const annotRef = doc.context.register(doc.context.obj({
        Type: 'Annot',
        Subtype: 'FileAttachment',
        Rect: [20, 400, 60, 440],
        FS: spec,
        P: page.ref,
    }));
    const linkRef = doc.context.register(link(doc, page, second));
    put(doc, page, [annotRef, linkRef]);
    doc.catalog.set(N('Names'), doc.context.register(doc.context.obj({
        EmbeddedFiles: { Names: [PDFString.of('r6-note.txt'), spec] },
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R5-2 — a `/DA` that is there and cannot be read
// ---------------------------------------------------------------------------

async function daDoc(value) {
    const doc = await blank(1, 'R6DAF');
    const page = doc.getPages()[0];
    const font = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica',
    }));
    const w = widget(doc, page, { FT: 'Tx', T: PDFString.of('r6.da'), V: PDFString.of('v') });
    if (value !== undefined) w.set(N('DA'), value(doc));
    const ref = doc.context.register(w);
    put(doc, page, [ref]);
    acroForm(doc, [ref], { DR: { Font: { R6F: font } } });
    return doc;
}

/** AcroForm `/DR` present and not a dictionary: its names cannot be listed. */
async function drNotDict() {
    const doc = await blank(1, 'R6DR');
    const page = doc.getPages()[0];
    const w = widget(doc, page, { FT: 'Tx', T: PDFString.of('r6.dr'), V: PDFString.of('v') });
    w.set(N('DA'), PDFString.of('/R6F 12 Tf 0 g'));
    const ref = doc.context.register(w);
    put(doc, page, [ref]);
    acroForm(doc, [ref], { DR: PDFName.of('NotADictionary') });
    return doc;
}

/** A field whose `/Kids` is there and is not an array: not a terminal field. */
async function kidsNotArray() {
    const doc = await blank(1, 'R6KD');
    const page = doc.getPages()[0];
    const w = widget(doc, page, { FT: 'Tx', T: PDFString.of('r6.kids'), V: PDFString.of('v') });
    w.set(N('Kids'), PDFName.of('NotAnArray'));
    const ref = doc.context.register(w);
    put(doc, page, [ref]);
    acroForm(doc, [ref]);
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R5-3 — the artifact backstop's reach, one kind of evidence per document
// ---------------------------------------------------------------------------

async function remnant(build) {
    const doc = await blank(1, 'R6RM');
    build(doc, doc.getPages()[0]);
    return doc;
}

const REMNANTS = {
    'r6-rem-ft-sig': (doc, page) => {
        const ref = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('r6.f') }));
        acroForm(doc, [ref]);
        void page;
    },
    'r6-rem-type-sig': (doc) => {
        doc.catalog.set(N('R6Probe'), doc.context.register(doc.context.obj({ Type: 'Sig' })));
    },
    'r6-rem-doctimestamp': (doc) => {
        doc.catalog.set(N('R6Probe'), doc.context.register(doc.context.obj({ Type: 'DocTimeStamp' })));
    },
    'r6-rem-byterange': (doc) => {
        doc.catalog.set(N('R6Probe'), doc.context.register(doc.context.obj({
            ByteRange: [0, 100, 200, 300],
        })));
    },
    // The evidence is `/Contents`, and the only thing that makes it evidence is
    // that a field points at it with `/V`.
    'r6-rem-contents-value': (doc) => {
        const value = doc.context.register(doc.context.obj({
            Contents: PDFHexString.of('523652414C5545'),
        }));
        const field = doc.context.register(doc.context.obj({
            FT: 'Tx', T: PDFString.of('r6.v'), V: value,
        }));
        acroForm(doc, [field]);
    },
    // Controls: `/Contents` where `/Contents` is ordinary.
    'r6-rem-page-contents': () => { /* a page always has one; nothing to add */ },
    'r6-rem-dict-contents': (doc) => {
        doc.catalog.set(N('R6Probe'), doc.context.register(doc.context.obj({
            Type: 'R6Ordinary',
            Contents: PDFString.of('not a signature'),
        })));
    },
    // A widget whose `/FT /Sig` lives on its parent: H1 says it must not be here.
    'r6-rem-widget-inherited': (doc, page) => {
        const parent = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('r6.p') }));
        const w = widget(doc, page, { Parent: parent });
        const ref = doc.context.register(w);
        put(doc, page, [ref]);
        acroForm(doc, [parent]);
    },
    // A widget whose ancestry cannot be read: the census must refuse, not count 0.
    'r6-rem-widget-dangling': (doc, page) => {
        const w = widget(doc, page, {});
        w.set(N('Parent'), PDFNumber.of(0));
        const ref = doc.context.register(w);
        put(doc, page, [ref]);
        acroForm(doc, [ref]);
    },
    // An ordinary form document: the zero everything else is measured against.
    'r6-rem-clean': (doc, page) => {
        const ref = doc.context.register(widget(doc, page, {
            FT: 'Tx', T: PDFString.of('r6.clean'), V: PDFString.of('v'),
        }));
        put(doc, page, [ref]);
        acroForm(doc, [ref]);
    },
};

// ---------------------------------------------------------------------------

async function main() {
    await save('r6-sig-empty-p', await sigEmptyP());
    await save('r6-sig-applied-p', await sigAppliedP());
    await save('r6-sig-then-link-p', await sigThenLink());
    await save('r6-sig-then-tx-p', await sigThenTx());
    await save('r6-sig-multi-then-link', await sigMultiThenLink());
    await save('r6-link-then-sig', await linkThenSig());
    await save('r6-annots-control', await annotsControl());
    await save('r6-annot-direct', await directAnnot());
    await save('r6-att-annot-then-link', await attachmentAnnotThenLink());

    const BS = String.fromCharCode(92);
    await save('r6-da-valid', await daDoc(() => PDFString.of('/R6F 12 Tf 0 g')));
    await save('r6-da-octal', await daDoc(() => PDFString.of(`/R6F 12 Tf ${BS}777`)));
    await save('r6-da-name', await daDoc(() => PDFName.of('R6F')));
    await save('r6-da-number', await daDoc(() => PDFNumber.of(12)));
    await save('r6-da-indirect-number', await daDoc((doc) => doc.context.register(PDFNumber.of(12))));
    await save('r6-da-stream', await daDoc((doc) => doc.context.register(
        doc.context.stream('/R6F 12 Tf 0 g'),
    )));
    await save('r6-da-hexbytes', await daDoc(() => PDFHexString.of('FEFF41')));
    await save('r6-da-absent', await daDoc(undefined));
    await save('r6-dr-notdict', await drNotDict());
    await save('r6-kids-notarray', await kidsNotArray());

    for (const [name, build] of Object.entries(REMNANTS)) {
        await save(name, await remnant(build));
    }

    console.log(`m6 round-6 fixtures: ${written.length} documents`);
    for (const name of written) console.log(`  ${name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
