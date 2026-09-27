/**
 * The documents the fourth Independent FULL Re-Review's findings are proven
 * against.
 *
 * BLK-R4-1 was a data-integrity defect in how text went back into a PDF: a
 * source string was decoded, then re-wrapped with `PDFString.of`, so a Japanese
 * value lost its high bytes and a `)` ended the string early. So most of what is
 * here is **text in every shape a producer writes it**: UTF-16 as hex, UTF-16
 * as a literal whose code units contain a `(`, `)` or `\` byte, PDFDocEncoding
 * with high bytes, a PDF 2.0 UTF-8 string, escaped delimiters, octal escapes,
 * control characters, the empty string. Each fixture writes the **token** it
 * means, byte for byte, because the defect is invisible to a fixture that lets
 * the library choose the encoding.
 *
 * The rest are the Required Fixes' shapes: named destinations in the catalog's
 * own `/Dests`, a name defined twice, a signature behind a `/Parent` that cannot
 * be read, and attachments whose names a confirmation has to show.
 *
 * Run:  node scripts/make-m6-round5-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const save = async (name, doc, patch) => {
    let bytes = await doc.save({ useObjectStreams: false });
    if (patch) bytes = patch(bytes);
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

const blank = async (pages = 1, label = 'R5') => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([420, 620]);
        page.drawText(`${label}${i + 1}`, { x: 20, y: 580, size: 16, font });
    }
    return doc;
};

// ---------------------------------------------------------------------------
// Tokens, written exactly
// ---------------------------------------------------------------------------

const BS = '\\';

/** A literal token holding these bytes, with only its delimiters escaped. */
const literalBytes = (bytes) => {
    let raw = '';
    for (const byte of bytes) {
        const char = String.fromCharCode(byte);
        raw += char === '(' || char === ')' || char === BS ? BS + char : char;
    }
    return PDFString.of(raw);
};

/** A literal token written with exactly these characters between the parentheses. */
const literalRaw = (raw) => PDFString.of(raw);

const hexBytes = (bytes) => PDFHexString.of(
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
);

const utf16Bytes = (text) => {
    const out = [0xfe, 0xff];
    for (let i = 0; i < text.length; i += 1) {
        const unit = text.charCodeAt(i);
        out.push(unit >> 8, unit & 0xff);
    }
    return out;
};
const utf16Hex = (text) => hexBytes(utf16Bytes(text));
const utf16Literal = (text) => literalBytes(utf16Bytes(text));
const ascii = (text) => literalBytes(Array.from(text, (c) => c.charCodeAt(0)));

// ---------------------------------------------------------------------------
// BLK-R4-1 — form text
// ---------------------------------------------------------------------------

/**
 * Every case the review listed, as `/T` and `/V` of simple merged `/Tx`
 * fields — the one shape the reconstruction rebuilds, so every one of them
 * reaches the writer that was broken.
 *
 * The expected text is recorded next to each token; the gate reads the source
 * and the output with PDF.js and compares both against it.
 */
const FORM_TEXT_CASES = [
    // [T token, T text, V token, V text]
    [utf16Hex('氏名'), '氏名', utf16Hex('山田 太郎'), '山田 太郎'],
    // UTF-16 code units whose low byte is `(`, `)` and `\` — as a literal.
    [utf16Literal('〨〩ぜ名'), '〨〩ぜ名', utf16Literal('〨〩ぜ値'), '〨〩ぜ値'],
    [ascii('(1) first'), '(1) first', ascii('(1) first'), '(1) first'],
    [ascii('close)paren'), 'close)paren', ascii('a)b'), 'a)b'],
    [ascii('open(paren'), 'open(paren', ascii('a(b'), 'a(b'],
    [ascii('back\\slash'), 'back\\slash', ascii('C:\\dir\\file'), 'C:\\dir\\file'],
    // PDFDocEncoding high bytes: ö ß, and • ﬁ € é.
    [literalBytes([0x47, 0x72, 0xf6, 0xdf, 0x65]), 'Größe',
        literalBytes([0x80, 0x93, 0xa0, 0xe9]), '•ﬁ€é'],
    // UTF-16 with a surrogate pair.
    [utf16Hex('𠮷野家'), '𠮷野家', utf16Hex('𠮷野家 定食'), '𠮷野家 定食'],
    // Control characters, written as escapes.
    [literalRaw(`ctl${BS}007name`), 'ctl\u0007name', literalRaw(`a${BS}tb${BS}001c`), 'a\tb\u0001c'],
    [ascii('multiline'), 'multiline', literalRaw(`l1${BS}r${BS}nl2`), 'l1\r\nl2'],
    [ascii('empty'), 'empty', literalRaw(''), ''],
    // PDF 2.0: UTF-8 behind a byte order mark.
    [ascii('utf8bom'), 'utf8bom',
        literalBytes([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('日本語')]), '日本語'],
    // Octal escapes and an escaped ordinary character.
    [literalRaw(`oct${BS}101${BS}_x`), 'octA_x', literalRaw(`v${BS}060${BS}061`), 'v01'],
];

async function formText() {
    const doc = await blank(1, 'FORMTEXT');
    const page = doc.getPages()[0];
    const widgets = FORM_TEXT_CASES.map(([t, , v], i) => doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'),
        T: t, V: v,
        Rect: [20, 560 - i * 40, 400, 590 - i * 40], F: 4,
    })));
    page.node.set(PDFName.of('Annots'), doc.context.obj(widgets));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: widgets, NeedAppearances: true, DA: ascii('/Helv 0 Tf 0 g'),
    })));
    return doc;
}

/** A text field whose value is a string that cannot be decoded. */
async function formValue(value, label) {
    const doc = await blank(1, label);
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'),
        T: ascii('bad.value'), V: value,
        Rect: [20, 500, 400, 530], F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], NeedAppearances: true,
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// BLK-R4-1 — named-destination text and name-tree order
// ---------------------------------------------------------------------------

/**
 * Keys in every encoding, targeting pages 2–4, written into `/Names` in
 * REVERSE order so the output's order is the tool's, not the source's.
 *
 * [token, text, target page index]
 */
const ND_KEYS = [
    [ascii('M6R5_ASCII'), 'M6R5_ASCII', 1],
    [ascii('a(b)c\\d'), 'a(b)c\\d', 2],
    [literalBytes([0x80, 0x41]), '•A', 3],
    [utf16Hex('目次'), '目次', 1],
    [utf16Literal('〨ぜ'), '〨ぜ', 2],
    [ascii('M6R5_P'), 'M6R5_P', 3],
    [ascii('M6R5_PA'), 'M6R5_PA', 1],
    [ascii('M6R5_PB'), 'M6R5_PB', 2],
    [utf16Hex('目次2'), '目次2', 3],
    // Escapes that are not delimiters: `\_` and `\S` are the characters
    // themselves, so the key's bytes are "M6R5_ESC".
    [literalRaw(`M6R5${BS}_E${BS}SC`), 'M6R5_ESC', 1],
    // An octal escape: `\117` is "O".
    [literalRaw(`M6R5${BS}117CT`), 'M6R5OCT', 2],
    // ASCII, written as hex.
    [hexBytes(Array.from('M6R5_HEX', (c) => c.charCodeAt(0))), 'M6R5_HEX', 3],
];

async function namedDestinationText() {
    const doc = await blank(4, 'NDTEXT');
    const pages = doc.getPages();
    const flat = [];
    for (const [token, , target] of [...ND_KEYS].reverse()) {
        flat.push(token, doc.context.obj([pages[target].ref, PDFName.of('Fit')]));
    }
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        Dests: doc.context.register(doc.context.obj({ Names: flat })),
    })));
    // Links on page 1 that reach names by text — in encodings other than the
    // key's own, where that is possible — so the reference and the definition
    // have to agree on the text, not on the spelling.
    const link = (rect, fields) => doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: rect, ...fields,
    }));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj([
        link([10, 10, 60, 40], { Dest: ascii('M6R5_ASCII') }),
        link([70, 10, 120, 40], { Dest: utf16Hex('目次') }),
        link([130, 10, 180, 40], {
            A: { Type: 'Action', S: 'GoTo', D: ascii('a(b)c\\d') },
        }),
        link([190, 10, 240, 40], { Dest: ascii('M6R5_ESC') }),
    ]));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R4-2 — the catalog's own /Dests
// ---------------------------------------------------------------------------

async function legacyDests(shape) {
    const doc = await blank(3, 'LEGACY');
    const pages = doc.getPages();
    const third = pages[2].ref;
    const set = (dests) => doc.catalog.set(PDFName.of('Dests'), dests);
    const links = [];
    if (shape === 'array') {
        set(doc.context.register(doc.context.obj({
            M6R5_LEG: [third, PDFName.of('Fit')],
        })));
        links.push({ Dest: PDFName.of('M6R5_LEG') });
    } else if (shape === 'dict') {
        set(doc.context.register(doc.context.obj({
            M6R5_LEGD: { D: [third, PDFName.of('XYZ'), 0, 600, null] },
        })));
        links.push({ A: { Type: 'Action', S: 'GoTo', D: PDFName.of('M6R5_LEGD') } });
    } else if (shape === 'escaped') {
        // `/M6R5#20LEG`: a name with a space in it, escaped.
        const dict = doc.context.obj({});
        dict.set(PDFName.of('M6R5 LEG'), doc.context.obj([third, PDFName.of('Fit')]));
        set(doc.context.register(dict));
        links.push({ Dest: PDFName.of('M6R5 LEG') });
    } else if (shape === 'plus-tree') {
        set(doc.context.register(doc.context.obj({
            M6R5_L1: [pages[1].ref, PDFName.of('Fit')],
        })));
        doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
            Dests: { Names: [ascii('M6R5_T1'), doc.context.obj([third, PDFName.of('Fit')])] },
        })));
        links.push({ Dest: PDFName.of('M6R5_L1') }, { Dest: ascii('M6R5_T1') });
    } else if (shape === 'malformed') {
        set(PDFNumber.of(7));
    } else if (shape === 'bad-value') {
        set(doc.context.register(doc.context.obj({ M6R5_BAD: 5 })));
    } else if (shape === 'hash-lower') {
        // Written as `/M6R5#2FLEG` and patched to `/M6R5#2fLEG` below: pdf-lib
        // cannot write a lower-case escape itself, and cannot read one either.
        set(doc.context.register(doc.context.obj({
            'M6R5/LEG': [third, PDFName.of('Fit')],
        })));
    } else if (shape === 'nonascii') {
        const dict = doc.context.obj({});
        dict.set(PDFName.of('M6R5\u00e9'), doc.context.obj([third, PDFName.of('Fit')]));
        set(doc.context.register(dict));
    } else {
        throw new Error(`unknown legacy shape ${shape}`);
    }
    if (links.length > 0) {
        pages[0].node.set(PDFName.of('Annots'), doc.context.obj(links.map((fields, i) =>
            doc.context.register(doc.context.obj({
                Type: 'Annot', Subtype: 'Link', Rect: [10 + i * 60, 10, 60 + i * 60, 40], ...fields,
            })))));
    }
    return doc;
}

/** Replace one ASCII run with another of the same length, so offsets hold. */
const patchSameLength = (from, to) => (bytes) => {
    const a = new TextEncoder().encode(from);
    const b = new TextEncoder().encode(to);
    if (a.length !== b.length) throw new Error('patch must keep the length');
    const out = new Uint8Array(bytes);
    let hits = 0;
    outer: for (let i = 0; i + a.length <= out.length; i += 1) {
        for (let j = 0; j < a.length; j += 1) if (out[i + j] !== a[j]) continue outer;
        out.set(b, i);
        hits += 1;
    }
    if (hits === 0) throw new Error(`patch target ${from} not found`);
    return out;
};

// ---------------------------------------------------------------------------
// RF-R4-3 — one name, two definitions
// ---------------------------------------------------------------------------

async function duplicateNames(shape) {
    const doc = await blank(3, 'DUP');
    const pages = doc.getPages();
    const to = (i) => doc.context.obj([pages[i].ref, PDFName.of('Fit')]);
    const tree = (dests) => doc.catalog.set(PDFName.of('Names'), doc.context.register(
        doc.context.obj({ Dests: dests }),
    ));
    const key = ascii('M6R5_DUP');
    if (shape === 'same-leaf') {
        tree(doc.context.obj({ Names: [key, to(1), ascii('M6R5_DUP'), to(2)] }));
    } else if (shape === 'same-target') {
        tree(doc.context.obj({ Names: [key, to(1), ascii('M6R5_DUP'), to(1)] }));
    } else if (shape === 'kids') {
        const leafA = doc.context.register(doc.context.obj({
            Limits: [ascii('M6R5_DUP'), ascii('M6R5_DUP')], Names: [ascii('M6R5_DUP'), to(1)],
        }));
        const leafB = doc.context.register(doc.context.obj({
            Limits: [ascii('M6R5_DUP'), ascii('M6R5_DUP')], Names: [ascii('M6R5_DUP'), to(2)],
        }));
        tree(doc.context.obj({ Kids: [leafA, leafB] }));
    } else if (shape === 'legacy-tree') {
        doc.catalog.set(PDFName.of('Dests'), doc.context.register(doc.context.obj({ M6R5_DUP: to(1) })));
        tree(doc.context.obj({ Names: [key, to(2)] }));
    } else if (shape === 'encoding') {
        // The same text as PDFDocEncoding and as UTF-16: different bytes, and
        // one name to any reader that shows it.
        tree(doc.context.obj({ Names: [key, to(1), utf16Hex('M6R5_DUP'), to(2)] }));
    } else if (shape === 'hex-literal') {
        // The same bytes, written as a literal and as hex.
        tree(doc.context.obj({
            Names: [key, to(1), hexBytes(Array.from('M6R5_DUP', (c) => c.charCodeAt(0))), to(1)],
        }));
    } else if (shape === 'dict-wrapped') {
        tree(doc.context.obj({ Names: [key, to(1), ascii('M6R5_DUP'), doc.context.obj({ D: to(2) })] }));
    } else {
        throw new Error(`unknown duplicate shape ${shape}`);
    }
    return doc;
}

// ---------------------------------------------------------------------------
// BLK-R4-1 — optional-content configuration name and /Order labels
// ---------------------------------------------------------------------------

async function ocName({ label, dName, orderLabel }) {
    const doc = await blank(1, label);
    const page = doc.getPages()[0];
    const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: ascii(`M6-R5-${label}`) }));
    page.node.lookup(PDFName.of('Resources')).set(
        PDFName.of('Properties'), doc.context.obj({ M6L: ocg }),
    );
    const d = { ON: [ocg], Order: orderLabel ? [[orderLabel, ocg]] : [ocg] };
    if (dName !== undefined) d.Name = dName;
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: d }));
    return doc;
}

const OC_NAME_CASES = {
    'r5-oc-name-jp': { dName: utf16Hex('レイヤー設定'), text: 'レイヤー設定' },
    'r5-oc-name-parens': { dName: ascii('(A) cfg'), text: '(A) cfg' },
    'r5-oc-name-backslash': { dName: ascii('C:\\cfg'), text: 'C:\\cfg' },
    'r5-oc-name-highbyte': { dName: literalBytes([0x80, 0x43, 0x66, 0x67]), text: '•Cfg' },
    'r5-oc-name-ascii': { dName: ascii('Config Plain'), text: 'Config Plain' },
    'r5-oc-name-utf16lit': { dName: utf16Literal('〨〩ぜ'), text: '〨〩ぜ' },
};

// ---------------------------------------------------------------------------
// RF-R4-4 — a signature behind an ancestry that cannot be read
// ---------------------------------------------------------------------------

/** A signature value, and an appearance that makes a page look signed. */
const signatureParts = (doc) => {
    const value = doc.context.register(doc.context.obj({
        Type: 'Sig',
        Filter: PDFName.of('Adobe.PPKLite'),
        SubFilter: PDFName.of('adbe.pkcs7.detached'),
        ByteRange: [0, 16, 32, 16],
        Contents: hexBytes(Array.from('M6R5_SIG_PAYLOAD', (c) => c.charCodeAt(0))),
    }));
    const appearance = doc.context.register(doc.context.stream(
        'BT /Helv 10 Tf 5 5 Td (M6R5_SIG_APPEARANCE) Tj ET',
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 180, 40] },
    ));
    return { value, appearance };
};

async function signature(shape) {
    const doc = await blank(2, 'SIG');
    const page = doc.getPages()[0];
    const { value, appearance } = signatureParts(doc);
    const widgetBase = {
        Type: 'Annot', Subtype: 'Widget', Rect: [20, 400, 200, 440], F: 4,
        AP: { N: appearance },
    };
    let fieldsEntry;
    let widget;
    if (shape === 'inherited') {
        // The normal inherited shape: a signature field carrying /FT and /V,
        // whose widget carries neither.
        const parentDict = doc.context.obj({ FT: PDFName.of('Sig'), T: ascii('sig-parent'), V: value });
        const parent = doc.context.register(parentDict);
        widget = doc.context.register(doc.context.obj({ ...widgetBase, Parent: parent }));
        parentDict.set(PDFName.of('Kids'), doc.context.obj([widget]));
        fieldsEntry = parent;
    } else if (shape === 'inherited-kid-field') {
        // A terminal field of its own under the signature field: /FT and /V
        // both inherited by a field.
        const parentDict = doc.context.obj({ FT: PDFName.of('Sig'), T: ascii('sig-parent'), V: value });
        const parent = doc.context.register(parentDict);
        widget = doc.context.register(doc.context.obj({ ...widgetBase, T: ascii('kid'), Parent: parent }));
        parentDict.set(PDFName.of('Kids'), doc.context.obj([widget]));
        fieldsEntry = parent;
    } else if (shape === 'direct-v') {
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, FT: PDFName.of('Sig'), T: ascii('direct'), V: value,
        }));
        fieldsEntry = widget;
    } else if (shape === 'parent-cycle') {
        const a = doc.context.obj({});
        const b = doc.context.obj({});
        const aRef = doc.context.register(a);
        const bRef = doc.context.register(b);
        a.set(PDFName.of('Parent'), bRef);
        b.set(PDFName.of('Parent'), aRef);
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, T: ascii('cycle'), V: value, Parent: aRef,
        }));
        fieldsEntry = widget;
    } else if (shape === 'parent-dangling') {
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, T: ascii('dangling'), V: value, Parent: PDFRef.of(9999),
        }));
        fieldsEntry = widget;
    } else if (shape === 'parent-wrong-type') {
        const notADict = doc.context.register(doc.context.obj([1, 2, 3]));
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, T: ascii('wrongtype'), V: value, Parent: notADict,
        }));
        fieldsEntry = widget;
    } else if (shape === 'missing-ft') {
        widget = doc.context.register(doc.context.obj({ ...widgetBase, T: ascii('noft'), V: value }));
        fieldsEntry = widget;
    } else if (shape === 'empty') {
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, FT: PDFName.of('Sig'), T: ascii('unsigned'),
        }));
        fieldsEntry = widget;
    } else if (shape === 'unclassifiable') {
        // No /FT and no /V of its own, and the ancestry that would supply them
        // cycles: nothing settles what this field is.
        const a = doc.context.obj({});
        const aRef = doc.context.register(a);
        a.set(PDFName.of('Parent'), aRef);
        widget = doc.context.register(doc.context.obj({ ...widgetBase, T: ascii('unknown'), Parent: aRef }));
        fieldsEntry = widget;
    } else if (shape === 'orphan-widget') {
        // A signed widget no /Fields entry reaches.
        widget = doc.context.register(doc.context.obj({
            ...widgetBase, FT: PDFName.of('Sig'), T: ascii('orphan'), V: value,
        }));
        fieldsEntry = null;
    } else {
        throw new Error(`unknown signature shape ${shape}`);
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: fieldsEntry ? [fieldsEntry] : [], SigFlags: 3,
    })));
    return doc;
}

/** The control: an ordinary supported text field. */
async function txControl() {
    const doc = await blank(2, 'TXCTL');
    const widget = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'),
        T: ascii('control.field'), V: ascii('M6R5-CONTROL'),
        Rect: [20, 400, 300, 430], F: 4,
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(doc.context.obj({
        Fields: [widget], NeedAppearances: true,
    })));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R4-5 / RF-R4-6 — attachments a confirmation has to name
// ---------------------------------------------------------------------------

async function attachments(label, specs) {
    const doc = await blank(1, label);
    const names = [];
    for (const spec of specs) {
        const payload = doc.context.register(doc.context.stream(spec.payload, { Type: 'EmbeddedFile' }));
        const fields = { Type: 'Filespec', EF: { F: payload } };
        if (spec.f !== undefined) fields.F = spec.f;
        if (spec.uf !== undefined) fields.UF = spec.uf;
        const filespec = doc.context.register(doc.context.obj(fields));
        names.push(spec.key, filespec);
    }
    doc.catalog.set(PDFName.of('Names'), doc.context.register(doc.context.obj({
        EmbeddedFiles: { Names: names },
    })));
    return doc;
}

/** A typeless `/EF` carrier that names nothing, inside a /Launch action. */
async function unnamedAttachment() {
    const doc = await blank(1, 'UNNAMED');
    const payload = doc.context.register(doc.context.stream('M6R5_UNNAMED_PAYLOAD', {}));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40],
        A: { Type: 'Action', S: 'Launch', F: { EF: { F: payload } } },
    }));
    doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc;
}

// ---------------------------------------------------------------------------
// BLK-R4-1 — Info strings a Merge's M1 policy carries
// ---------------------------------------------------------------------------

/**
 * Info strings in the encodings the M1 path mis-decoded: a PDF 2.0 UTF-8
 * Title, which pdf-lib reads as PDFDocEncoding, beside escaped delimiters,
 * UTF-16 and a high byte.
 */
async function infoText() {
    const doc = await blank(1, 'INFO');
    doc.context.trailerInfo.Info = doc.context.register(doc.context.obj({
        Title: literalBytes([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('図面タイトル')]),
        Author: ascii('(A) b\\c'),
        Subject: utf16Hex('件名テスト'),
        Creator: literalBytes([0x80, 0x43]),
    }));
    return doc;
}

// ---------------------------------------------------------------------------

async function main() {
    await save('r5-form-text', await formText());
    await save('r5-form-bad-utf16', await formValue(hexBytes([0xfe, 0xff, 0xd8, 0x42]), 'BADV'));
    const streamValue = await blank(1, 'STREAMV');
    {
        const stream = streamValue.context.register(streamValue.context.stream('M6R5 stream value', {}));
        const widget = streamValue.context.register(streamValue.context.obj({
            Type: 'Annot', Subtype: 'Widget', FT: PDFName.of('Tx'), T: ascii('stream.value'), V: stream,
            Rect: [20, 500, 400, 530], F: 4,
        }));
        streamValue.getPages()[0].node.set(PDFName.of('Annots'), streamValue.context.obj([widget]));
        streamValue.catalog.set(PDFName.of('AcroForm'), streamValue.context.register(
            streamValue.context.obj({ Fields: [widget], NeedAppearances: true }),
        ));
    }
    await save('r5-form-v-stream', streamValue);

    await save('r5-nd-text', await namedDestinationText());
    await save('r5-info-text', await infoText());

    for (const shape of ['array', 'dict', 'escaped', 'plus-tree', 'malformed', 'bad-value', 'nonascii']) {
        await save(`r5-legacy-${shape}`, await legacyDests(shape));
    }
    await save('r5-legacy-hash-lower', await legacyDests('hash-lower'),
        patchSameLength('/M6R5#2FLEG', '/M6R5#2fLEG'));

    for (const shape of [
        'same-leaf', 'same-target', 'kids', 'legacy-tree', 'encoding', 'hex-literal', 'dict-wrapped',
    ]) {
        await save(`r5-dup-${shape}`, await duplicateNames(shape));
    }

    for (const [name, { dName }] of Object.entries(OC_NAME_CASES)) {
        await save(name, await ocName({ label: name.replace('r5-oc-name-', '').toUpperCase(), dName }));
    }
    await save('r5-oc-order-label', await ocName({
        label: 'ORDERLABEL', dName: ascii('Cfg L'), orderLabel: utf16Hex('設計図'),
    }));
    await save('r5-oc-name-bad', await ocName({ label: 'BADNAME', dName: hexBytes([0xfe, 0xff, 0xd8, 0x42]) }));
    await save('r5-oc-name-notstring', await ocName({ label: 'NAMEOBJ', dName: PDFName.of('NotText') }));

    for (const shape of [
        'inherited', 'inherited-kid-field', 'direct-v', 'parent-cycle', 'parent-dangling',
        'parent-wrong-type', 'missing-ft', 'empty', 'unclassifiable', 'orphan-widget',
    ]) {
        await save(`r5-sig-${shape}`, await signature(shape));
    }
    await save('r5-tx-control', await txControl());

    await save('r5-att-secret', await attachments('SECRET', [
        { key: ascii('secret-notes.txt'), f: ascii('secret-notes.txt'), uf: ascii('secret-notes.txt'),
            payload: 'M6R5_SECRET_PAYLOAD' },
    ]));
    await save('r5-att-unicode', await attachments('UNICODE', [
        { key: ascii('memo'), f: ascii('memo.txt'), uf: utf16Hex('図面メモ.txt'),
            payload: 'M6R5_UNICODE_PAYLOAD' },
    ]));
    await save('r5-att-multi', await attachments('MULTI', [
        { key: ascii('a'), f: ascii('a.txt'), payload: 'M6R5_MULTI_A' },
        { key: ascii('b'), f: ascii('b.txt'), payload: 'M6R5_MULTI_B' },
        { key: ascii('c'), f: ascii('c.txt'), payload: 'M6R5_MULTI_C' },
    ]));
    await save('r5-att-unnamed', await unnamedAttachment());
    await save('r5-att-same-name-a', await attachments('SAMEA', [
        { key: ascii('secret-notes.txt'), f: ascii('secret-notes.txt'), payload: 'M6R5_SAME_A_PAYLOAD' },
    ]));
    await save('r5-att-same-name-b', await attachments('SAMEB', [
        { key: ascii('secret-notes.txt'), f: ascii('secret-notes.txt'), payload: 'M6R5_SAME_B_PAYLOAD' },
    ]));

    console.log(`m6 round-5 fixtures: ${written.length} documents`);
    for (const name of written) console.log(`  ${name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
