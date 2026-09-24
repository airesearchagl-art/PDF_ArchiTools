/**
 * The documents Round 9's attachment / optional-content safety closure is
 * proven against.
 *
 * One theme again, from four directions: a sanitizer may not change what a
 * reader sees, and neither may the order a dictionary happens to be written in.
 *
 * **BLK-R8R-1** — `/EF` is evidence, not authority to delete. The V family puts
 * `/EF` on things that are not file specifications (an optional-content group,
 * `/OCProperties`); the W family points an `/EF` at things that are not files
 * (the form a page draws, the page's own content stream, a payload something
 * else also uses). The old remover deleted all of them as "the attachment" and
 * shipped READY: hidden layers drawn, drawings gone. Controls keep the ordinary
 * attachment shapes — the tree, the annotation, the typeless specification,
 * an indirect `/Annots` — removable exactly as before.
 *
 * **RF-R9-1** — a sanitizer other than attachments reaching optional content:
 * an empty signature field that is also the switched-off group. Removing the
 * field removed the group; the old Extract carried nothing and called it READY.
 *
 * **RF-R9-2** — the same group in `/ON` and `/OFF`, and its controls.
 *
 * **RF-R8R-2** — a shared form whose *child* carries `/OC`, reached through a
 * scope-only role (pattern, Type 3 glyph, soft mask) and through `/XObject`, in
 * both dictionary orders; and shared parents whose every alias must stay right.
 *
 * **RF-R8R-1** — artifact shapes for the `/Properties` channel and the full
 * configuration envelope, fed straight to the output census. One of them is a
 * real artifact: what b76bda8 wrote for `r8-props-direct`.
 *
 * **Round 9 / J** — the JavaScript counterpart of BLK-R8R-1: `/JS` on things
 * that are not actions.
 *
 * Written by hand, like Rounds 7 and 8: pdf-lib normalises most of these shapes
 * away.
 *
 * Run:  node scripts/make-m6-round9-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];

const latin1 = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};

/** A document from explicit numbered objects, with a real cross-reference table. */
function doc(objects, { root = 1 } = {}) {
    const nums = [...objects.keys()].sort((a, b) => a - b);
    const max = nums[nums.length - 1];
    let body = '%PDF-1.7\n';
    const offsets = new Map();
    for (const n of nums) {
        offsets.set(n, body.length);
        body += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
    }
    const xrefAt = body.length;
    body += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= max; n += 1) {
        body += offsets.has(n)
            ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`
            : '0000000000 65535 f \n';
    }
    body += `trailer\n<< /Size ${max + 1} /Root ${root} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return latin1(body);
}

const stream = (dict, content) => {
    const inner = dict.replace(/>>\s*$/, '').trimEnd();
    return `${inner} /Length ${content.length} >>\nstream\n${content}\nendstream`;
};

const write = (name, bytes) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

/** A green bar the page always paints, so "hidden" is never "blank". */
const PAGE_PAINT = '0 1 0 rg 10 170 180 20 re f';
/** The layer: a blue square in the middle of the page. */
const LAYER_PAINT = '0 0 1 rg 60 60 80 80 re f';
/** Something a decoy draws that is not the layer. */
const DECOY_PAINT = '1 0 0 rg 5 5 20 20 re f';
/** Marked content naming `/MC0`. */
const MARKED = `${PAGE_PAINT}\n/OC /MC0 BDC\n${LAYER_PAINT}\nEMC`;

const OCG = (name = 'Layer A') => `<< /Type /OCG /Name (${name}) >>`;
const REG_OFF = '<< /OCGs [5 0 R] /D << /BaseState /ON /OFF [5 0 R] >> >>';
const FORM = (res = '<< >>', extra = '', content = LAYER_PAINT) => stream(
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources ${res}${extra} >>`,
    content,
);
const PAYLOAD = (marker, type = ' /Type /EmbeddedFile') => stream(`<<${type} >>`, marker);

/** Catalog, one page, the group as object 5. `extra` adds or replaces objects. */
function onePage({ catalog = '', resources = '<< >>', content = PAGE_PAINT, page = '', extra = {} }) {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R${catalog} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources ${resources} /Contents 4 0 R${page} >>`);
    o.set(4, stream('<< >>', content));
    o.set(5, OCG());
    for (const [k, v] of Object.entries(extra)) o.set(Number(k), v);
    return doc(o);
}

// ---------------------------------------------------------------------------
// BLK-R8R-1 — V: `/EF` on things that are not file specifications
// ---------------------------------------------------------------------------

const PROPS = '<< /Properties << /MC0 5 0 R >> >>';

write('r9-v1-ocg-ef', onePage({
    catalog: ` /OCProperties ${REG_OFF}`,
    resources: PROPS,
    content: MARKED,
    extra: { 5: '<< /Type /OCG /Name (Layer A) /EF << /F 20 0 R >> >>', 20: PAYLOAD('M6R9_V1_PAYLOAD') },
}));
write('r9-v2-form-oc-ocg-ef', onePage({
    catalog: ` /OCProperties ${REG_OFF}`,
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\n/Fm0 Do`,
    extra: {
        5: '<< /Type /OCG /Name (Layer A) /EF << /F 20 0 R >> >>',
        7: FORM('<< >>', ' /OC 5 0 R'),
        20: PAYLOAD('M6R9_V2_PAYLOAD'),
    },
}));
write('r9-v5-ocprops-direct-ef', onePage({
    catalog: ' /OCProperties << /OCGs [5 0 R] /D << /BaseState /ON /OFF [5 0 R] >> /EF << /F 20 0 R >> >>',
    resources: PROPS,
    content: MARKED,
    extra: { 20: PAYLOAD('M6R9_V5_PAYLOAD') },
}));
write('r9-v6-ocprops-indirect-ef', onePage({
    catalog: ' /OCProperties 9 0 R',
    resources: PROPS,
    content: MARKED,
    extra: {
        9: '<< /OCGs [5 0 R] /D << /BaseState /ON /OFF [5 0 R] >> /EF << /F 20 0 R >> >>',
        20: PAYLOAD('M6R9_V6_PAYLOAD'),
    },
}));
// The shape Merge used to turn into a coherent-but-wrong artifact: `/OFF` lost,
// the group still registered and used, the layer on.
write('r9-v7-ocprops-ef-form', onePage({
    catalog: ' /OCProperties << /OCGs [5 0 R] /D << /BaseState /ON /OFF [5 0 R] >> /EF << /F 20 0 R >> >>',
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\n/Fm0 Do`,
    extra: { 7: FORM('<< >>', ' /OC 5 0 R'), 20: PAYLOAD('M6R9_V7_PAYLOAD') },
}));

// ---------------------------------------------------------------------------
// BLK-R8R-1 — W: an `/EF` naming something that is not only a file
// ---------------------------------------------------------------------------

/** A page that draws the blue form, with an `/EmbeddedFiles` tree entry. */
function attachmentPage({ spec, extra = {}, page = '', resources = '<< /XObject << /Fm0 7 0 R >> >>' }) {
    return onePage({
        catalog: ' /Names << /EmbeddedFiles << /Names [(a.txt) 9 0 R] >> >>',
        resources,
        content: `${PAGE_PAINT}\n/Fm0 Do`,
        page,
        extra: { 7: FORM(), 9: spec, ...extra },
    });
}

write('r9-w0-valid', attachmentPage({
    spec: '<< /Type /Filespec /F (a.txt) /UF (a.txt) /EF << /F 20 0 R >> >>',
    extra: { 20: PAYLOAD('M6R9_W0_PAYLOAD') },
}));
write('r9-w1-ef-form', attachmentPage({
    spec: '<< /Type /Filespec /F (a.txt) /UF (a.txt) /EF << /F 7 0 R >> >>',
}));
write('r9-w2-ef-contents', attachmentPage({
    spec: '<< /Type /Filespec /F (a.txt) /UF (a.txt) /EF << /F 4 0 R >> >>',
}));
// A typeless file specification whose context — a value of the tree — proves it.
write('r9-w3-typeless-tree', attachmentPage({
    spec: '<< /F (typeless.txt) /EF << /F 20 0 R >> >>',
    extra: { 20: PAYLOAD('M6R9_W3_PAYLOAD', '') },
}));
// One payload, two file specifications, both attachment structures.
write('r9-w4-shared-payload', onePage({
    catalog: ' /Names << /EmbeddedFiles << /Names [(a.txt) 9 0 R] >> >>',
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\n/Fm0 Do`,
    page: ' /Annots [10 0 R]',
    extra: {
        7: FORM(),
        9: '<< /Type /Filespec /F (a.txt) /EF << /F 20 0 R >> >>',
        10: '<< /Type /Annot /Subtype /FileAttachment /Rect [150 150 170 170] /FS 11 0 R /P 3 0 R >>',
        11: '<< /Type /Filespec /F (b.txt) /EF << /F 20 0 R >> >>',
        20: PAYLOAD('M6R9_W4_PAYLOAD'),
    },
}));
// A proper payload that page private data also names.
write('r9-w5-shared-nonattachment', attachmentPage({
    spec: '<< /Type /Filespec /F (a.txt) /EF << /F 20 0 R >> >>',
    page: ' /PieceInfo << /M6App << /LastModified (D:20260921) /Private 20 0 R >> >>',
    extra: { 20: PAYLOAD('M6R9_W5_PAYLOAD') },
}));
// A file-attachment annotation held in an INDIRECT `/Annots` array.
write('r9-w6-indirect-annots', onePage({
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\n/Fm0 Do`,
    page: ' /Annots 12 0 R',
    extra: {
        7: FORM(),
        10: '<< /Type /Annot /Subtype /FileAttachment /Rect [150 150 170 170] /FS 11 0 R /P 3 0 R >>',
        11: '<< /Type /Filespec /F (c.txt) /UF (c.txt) /EF << /F 20 0 R >> >>',
        12: '[10 0 R]',
        20: PAYLOAD('M6R9_W6_PAYLOAD'),
    },
}));

// ---------------------------------------------------------------------------
// RF-R9-1 — another sanitizer reaching optional content
// ---------------------------------------------------------------------------

/** Object 8 is at once an empty signature field and the switched-off group. */
function sigGroup({ viaForm }) {
    const o = new Map();
    o.set(1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R] >> '
        + '/OCProperties << /OCGs [8 0 R] /D << /BaseState /ON /OFF [8 0 R] >> >> >>');
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [8 0 R] '
        + `/Resources ${viaForm ? '<< /XObject << /Fm0 7 0 R >> >>' : '<< /Properties << /MC0 8 0 R >> >>'} `
        + '/Contents 4 0 R >>');
    o.set(4, stream('<< >>', viaForm ? `${PAGE_PAINT}\n/Fm0 Do` : MARKED));
    if (viaForm) o.set(7, FORM('<< >>', ' /OC 8 0 R'));
    o.set(8, '<< /Type /OCG /Name (Layer A) /Subtype /Widget /FT /Sig /T (sig1) /Rect [0 0 0 0] /P 3 0 R >>');
    return doc(o);
}
write('r9-h1-sig-ocg-marked', sigGroup({ viaForm: false }));
write('r9-h2-sig-ocg-form', sigGroup({ viaForm: true }));

// ---------------------------------------------------------------------------
// RF-R9-2 — `/ON` / `/OFF` overlap, and its controls
// ---------------------------------------------------------------------------

function onOff(d, twoGroups = false) {
    return onePage({
        catalog: ` /OCProperties << /OCGs [5 0 R${twoGroups ? ' 6 0 R' : ''}] /D << /BaseState /ON ${d} >> >>`,
        resources: twoGroups
            ? '<< /Properties << /MC0 5 0 R /MC1 6 0 R >> >>'
            : PROPS,
        content: twoGroups
            ? `${MARKED}\n/OC /MC1 BDC\n1 0 1 rg 150 100 30 30 re f\nEMC`
            : MARKED,
        extra: twoGroups ? { 6: OCG('Layer B') } : {},
    });
}
write('r9-onoff-on', onOff('/ON [5 0 R]'));
write('r9-onoff-off', onOff('/OFF [5 0 R]'));
write('r9-onoff-neither', onOff(''));
write('r9-onoff-both', onOff('/ON [5 0 R] /OFF [5 0 R]'));
write('r9-onoff-multi', onOff('/ON [5 0 R 6 0 R] /OFF [6 0 R]', true));
write('r9-onoff-dup-on', onOff('/ON [5 0 R 5 0 R]'));
write('r9-onoff-dup-off', onOff('/OFF [5 0 R 5 0 R]'));

// ---------------------------------------------------------------------------
// RF-R8R-2 — a shared parent whose CHILD carries `/OC`
// ---------------------------------------------------------------------------

/** Form 12 has no `/OC`; its child 7 does. */
const WRAP = FORM('<< /XObject << /C1 7 0 R >> >>', '', '/C1 Do');
const T3 = (proc) => '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 10 10] '
    + '/FontMatrix [0.001 0 0 0.001 0 0] '
    + `/CharProcs << /a ${proc} >> /Encoding << /Type /Encoding /Differences [97 /a] >> `
    + '/FirstChar 97 /LastChar 97 /Widths [10] >>';

/**
 * `role` reaches the shared parent 12 from inside decoy 8; `/XObject` reaches it
 * from the page. `order` decides which the page walks first.
 */
function nested({ role, order }) {
    const keys = order === 'alias-first' ? '/Fa 8 0 R /Fz 12 0 R' : '/Aa 12 0 R /Zz 8 0 R';
    const draws = order === 'alias-first' ? '/Fa Do /Fz Do' : '/Aa Do /Zz Do';
    const decoyRes = {
        pattern: '<< /Pattern << /P0 12 0 R >> >>',
        charprocs: '<< /Font << /T3 9 0 R >> >>',
        smask: '<< /ExtGState << /GS0 10 0 R >> >>',
    }[role];
    const extra = {
        7: FORM('<< >>', ' /OC 5 0 R'),
        8: FORM(decoyRes, '', DECOY_PAINT),
        12: WRAP,
    };
    if (role === 'charprocs') extra[9] = T3('12 0 R');
    if (role === 'smask') extra[10] = '<< /Type /ExtGState /SMask << /S /Luminosity /G 12 0 R >> >>';
    return onePage({
        catalog: ` /OCProperties ${REG_OFF}`,
        resources: `<< /XObject << ${keys} >> >>`,
        content: `${PAGE_PAINT}\n${draws}`,
        extra,
    });
}
for (const role of ['pattern', 'charprocs', 'smask']) {
    write(`r9-nest-${role}-alias-first`, nested({ role, order: 'alias-first' }));
    write(`r9-nest-${role}-xobject-first`, nested({ role, order: 'xobject-first' }));
}

/**
 * Parent P (12) draws a red square and its child C (7, the layer, a blue square
 * at 40..60). The page draws P twice: `/A` at the origin, `/B` shifted by
 * (100, 100). So each alias has its own red and blue positions to read.
 */
const CHILD = FORM('<< >>', ' /OC 5 0 R', '0 0 1 rg 40 40 20 20 re f');
const PARENT = FORM('<< /XObject << /C1 7 0 R >> >>', '', `${DECOY_PAINT}\n/C1 Do`);
const TWO_ALIASES = `${PAGE_PAINT}\nq /A Do Q\nq 1 0 0 1 100 100 cm /B Do Q`;

write('r9-cxt1-shared-parent', onePage({
    catalog: ` /OCProperties ${REG_OFF}`,
    resources: '<< /XObject << /A 12 0 R /B 12 0 R >> >>',
    content: TWO_ALIASES,
    extra: { 7: CHILD, 12: PARENT },
}));
write('r9-cxt1-shared-parent-on', onePage({
    catalog: ' /OCProperties << /OCGs [5 0 R] /D << /BaseState /ON /ON [5 0 R] >> >>',
    resources: '<< /XObject << /A 12 0 R /B 12 0 R >> >>',
    content: TWO_ALIASES,
    extra: { 7: CHILD, 12: PARENT },
}));
write('r9-cxt2-two-pages', (() => {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties ${REG_OFF} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R 13 0 R] /Count 2 >>');
    for (const [pageNum, contentNum] of [[3, 4], [13, 14]]) {
        o.set(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] `
            + `/Resources << /XObject << /A 12 0 R >> >> /Contents ${contentNum} 0 R >>`);
        o.set(contentNum, stream('<< >>', `${PAGE_PAINT}\n/A Do`));
    }
    o.set(5, OCG());
    o.set(7, CHILD);
    o.set(12, PARENT);
    return doc(o);
})());
// The same child name under two parents, each naming a different group: X is
// switched off, Y is on. The paths are identical but for the first key.
write('r9-cxt3-same-names', onePage({
    catalog: ' /OCProperties << /OCGs [5 0 R 6 0 R] /D << /BaseState /ON /OFF [5 0 R] /ON [6 0 R] >> >>',
    resources: '<< /XObject << /A 12 0 R /B 15 0 R >> >>',
    content: TWO_ALIASES,
    extra: {
        6: OCG('Layer B'),
        7: CHILD,
        12: PARENT,
        15: FORM('<< /XObject << /C1 16 0 R >> >>', '', `${DECOY_PAINT}\n/C1 Do`),
        16: FORM('<< >>', ' /OC 6 0 R', '0 0 1 rg 40 40 20 20 re f'),
    },
}));
// A scope-only alias alongside two valid ones, in both orders.
for (const order of ['alias-first', 'xobject-first']) {
    const keys = order === 'alias-first'
        ? '/Da 8 0 R /A 12 0 R /B 12 0 R'
        : '/A 12 0 R /B 12 0 R /Dz 8 0 R';
    write(`r9-cxt4-scope-alias-${order}`, onePage({
        catalog: ` /OCProperties ${REG_OFF}`,
        resources: `<< /XObject << ${keys} >> >>`,
        content: TWO_ALIASES,
        extra: { 7: CHILD, 8: FORM('<< /Pattern << /P0 12 0 R >> >>', '', DECOY_PAINT), 12: PARENT },
    }));
}
// A resource graph that loops back through two keys.
write('r9-cxt5-cycle', (() => {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties ${REG_OFF} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources 6 0 R /Contents 4 0 R >>');
    o.set(4, stream('<< >>', `${PAGE_PAINT}\n/F Do`));
    o.set(5, OCG());
    o.set(6, '<< /XObject << /F 7 0 R /G 7 0 R >> >>');
    o.set(7, FORM('6 0 R', ' /OC 5 0 R'));
    return doc(o);
})());

// ---------------------------------------------------------------------------
// RF-R8R-1 — artifact shapes for the output census
// ---------------------------------------------------------------------------

/**
 * A one-page artifact. `props` is the page's `/Properties` map and `config` the
 * catalog's `/OCProperties`, both verbatim — none is a shape this tool writes.
 */
function artifact({ props = null, config = null, extra = {}, content = PAGE_PAINT }) {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R${config ? ` /OCProperties ${config}` : ''} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + `/Resources << ${props ? `/Properties ${props}` : ''} >> /Contents 4 0 R >>`);
    o.set(4, stream('<< >>', content));
    for (const [k, v] of Object.entries(extra)) o.set(Number(k), v);
    return doc(o);
}
const CFG = (d = '/BaseState /ON') => `<< /OCGs [5 0 R] /D << ${d} >> >>`;

write('r9-art-p1-props-registered', artifact({
    props: '<< /MC0 5 0 R >>', config: CFG('/BaseState /ON /OFF [5 0 R]'), content: MARKED, extra: { 5: OCG() },
}));
write('r9-art-p2-props-unregistered', artifact({ props: '<< /MC0 5 0 R >>', content: MARKED, extra: { 5: OCG() } }));
write('r9-art-p3-props-dangling', artifact({
    props: '<< /MC0 5 0 R /MC9 99 0 R >>', config: CFG(), content: MARKED, extra: { 5: OCG() },
}));
write('r9-art-p4-props-ocmd', artifact({
    props: '<< /MC0 9 0 R >>', config: CFG(), content: MARKED,
    extra: { 5: OCG(), 9: '<< /Type /OCMD /OCGs [5 0 R] >>' },
}));
/**
 * P5: not built here — what b76bda8, before the BLK-R7-B fix, actually wrote
 * for `r8-props-direct` (READY, 656 bytes): a page `/Properties` naming a group
 * written directly, and no `/OCProperties` at all. Reproduced with
 * `runExtract(r8-props-direct.pdf, { selection: [0] })` on b76bda8.
 */
write('r9-art-p5-prefix-props-direct', Buffer.from(
    'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovTGVuZ3RoIDcwCj4+CnN0cmVhbQowIDEgMCByZyAxMCAxMCAxODAgMjAgcmUgZgovT0MgL01DMCBCREMKMCAwIDEgcmcgNjAgNjAgODAgODAgcmUgZgpFTUMKCmVuZHN0cmVhbQplbmRvYmoKCjQgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL01lZGlhQm94IFsgMCAwIDIwMCAyMDAgXQovUmVzb3VyY2VzIDw8Ci9Qcm9wZXJ0aWVzIDw8Ci9NQzAgPDwKL1R5cGUgL09DRwovTmFtZSAoSW5saW5lKQo+Pgo+Pgo+PgovQ29udGVudHMgMyAwIFIKL1BhcmVudCAxIDAgUgo+PgplbmRvYmoKCjUgMCBvYmoKPDwKL1RpdGxlIChyOC1wcm9wcy1kaXJlY3QucGRmKQo+PgplbmRvYmoKCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDc2IDAwMDAwIG4gCjAwMDAwMDAxMjYgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwNDA5IDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMiAwIFIKL0luZm8gNSAwIFIKPj4KCnN0YXJ0eHJlZgo0NjAKJSVFT0Y=',
    'base64',
));
write('r9-art-p6-props-ordinary', artifact({
    props: '<< /Span0 << /ActualText (plain) >> /Span1 7 0 R >>',
    content: `${PAGE_PAINT}\n/Span /Span0 BDC\nEMC`,
    extra: { 7: '<< /Lang (ja-JP) >>' },
}));
const OCG_ON_PAGE = { props: '<< /MC0 5 0 R >>', content: MARKED };
write('r9-art-p7-as-event', artifact({
    ...OCG_ON_PAGE, config: CFG('/BaseState /ON /AS [<< /Event /Bogus /Category [/View] /OCGs [5 0 R] >>]'),
    extra: { 5: OCG() },
}));
write('r9-art-p8-as-category', artifact({
    ...OCG_ON_PAGE, config: CFG('/BaseState /ON /AS [<< /Event /View /Category [(View)] /OCGs [5 0 R] >>]'),
    extra: { 5: OCG() },
}));
write('r9-art-p9-as-extra-key', artifact({
    ...OCG_ON_PAGE, config: CFG('/BaseState /ON /AS [<< /Event /View /Category [/View] /OCGs [5 0 R] /Extra 1 >>]'),
    extra: { 5: OCG() },
}));
write('r9-art-p10-basestate-off', artifact({ ...OCG_ON_PAGE, config: CFG('/BaseState /OFF'), extra: { 5: OCG() } }));
write('r9-art-p11-configs', artifact({
    ...OCG_ON_PAGE, config: '<< /OCGs [5 0 R] /D << /BaseState /ON >> /Configs [<< /Name (Alt) >>] >>',
    extra: { 5: OCG() },
}));
write('r9-art-p12-locked', artifact({ ...OCG_ON_PAGE, config: CFG('/BaseState /ON /Locked [5 0 R]'), extra: { 5: OCG() } }));
write('r9-art-p13-onoff-overlap', artifact({
    ...OCG_ON_PAGE, config: CFG('/BaseState /ON /ON [5 0 R] /OFF [5 0 R]'), extra: { 5: OCG() },
}));
// Control: the whole supported envelope at once.
write('r9-art-envelope-ok', artifact({
    ...OCG_ON_PAGE,
    config: CFG('/Name (Cfg) /BaseState /ON /OFF [5 0 R] /Order [[(Section) 5 0 R]] /RBGroups [] '
        + '/AS [<< /Event /Print /Category [/Print] /OCGs [5 0 R] >>]'),
    extra: { 5: OCG() },
}));

// ---------------------------------------------------------------------------
// Round 9 / J — `/JS` on things that are not actions
// ---------------------------------------------------------------------------

write('r9-j1-ocg-js', onePage({
    catalog: ` /OCProperties ${REG_OFF}`,
    resources: PROPS,
    content: MARKED,
    extra: { 5: '<< /Type /OCG /Name (Layer A) /JS (app.alert\\(1\\)) >>' },
}));
write('r9-j2-form-js', onePage({
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\n/Fm0 Do`,
    extra: { 7: FORM('<< >>', ' /JS (app.alert\\(1\\))') },
}));
write('r9-j3-page-js', onePage({
    content: `${PAGE_PAINT}\n${LAYER_PAINT}`,
    page: ' /S /JavaScript',
}));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
