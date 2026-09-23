/**
 * The documents Round 12's Merge action-structure intake parity is proven
 * against.
 *
 * **RF-R11R-1.** Two readers of an action's structure decide whether a source
 * can be copied. The JavaScript assessment asks what a script hides behind, and
 * Merge asked it at intake. The other one follows each action to the pages it
 * points at — `closeSourcePageRefs` — and Merge asked it only when it ran. A
 * source that satisfied the first and not the second was accepted, planned
 * READY, agreed to, and then stopped the whole Merge with UNSCANNABLE_ACTIONS,
 * safe sources and all.
 *
 * The A, B and C families are the shapes the second reader refuses and the
 * first does not: an `/AA` that names nothing. Each carries, or can carry, an
 * ordinary attachment and a structure tree, because the failure was visible only
 * in what a person was asked to agree to before it happened.
 *
 * The D, E and F families are `/Next` chains of an exact length. The second
 * reader spent two depth units per hop and stopped at 15 hops; the first stops
 * at 32. One hop is one unit now, in both, and the boundary is inclusive: 32
 * hops are read, 33 are refused. Each chain is a run of URI actions — nothing in
 * it is a script — so any refusal is the reader's and not the sanitizer's, and
 * `-js` variants end the chain in a script to prove it is removed at the bound.
 *
 * The X family walks the same boundary through `/Next` **arrays**, whose
 * container is a level of its own in both scanners: 16 hops are read and 17 are
 * refused, in both.
 *
 * The G and H families are the shapes that must stay refused whatever the depth
 * arithmetic: a `/Next` list with a member that is not an action, and cycles.
 * The V family is the valid shapes beside them.
 *
 * Written by hand, like Rounds 7 to 11: pdf-lib normalises most of these shapes
 * away.
 *
 * Run:  node scripts/make-m6-round12-fixtures.mjs
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

/** A green bar the page always paints, so a lost square is never a blank page. */
const PAINT = '0 1 0 rg 10 170 180 20 re f\n0 0 1 rg 60 60 80 80 re f';
const SCRIPT = (marker) => `(app.alert\\(${marker}\\))`;
const JS_ACTION = (marker, tail = '') => `<< /Type /Action /S /JavaScript /JS ${SCRIPT(marker)}${tail} >>`;
const LINK = (tail) => `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ${tail} >>`;
const URI = (tail = '') => `<< /Type /Action /S /URI /URI (https://example.invalid/)${tail} >>`;

/** Catalog, one page, content as object 4. `extra` adds numbered objects. */
function onePage({ catalog = '', resources = '<< >>', content = PAINT, page = '', extra = {} }) {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R${catalog} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources ${resources} /Contents 4 0 R${page} >>`);
    o.set(4, stream('<< >>', content));
    for (const [k, v] of Object.entries(extra)) o.set(Number(k), v);
    return doc(o);
}

/** An ordinary attachment, a loss a person is asked to agree to. Objects 30-32. */
const ATTACHMENT = {
    names: '/EmbeddedFiles 30 0 R',
    extra: {
        30: '<< /Names [(notes.txt) 31 0 R] >>',
        31: '<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F 32 0 R >> >>',
        32: stream('<< /Type /EmbeddedFile >>', 'M6R12_ATTACHMENT_PAYLOAD'),
    },
};
/** A structure tree, the other loss a person is asked to agree to. Objects 20-22. */
const TAGGING = {
    catalog: ' /StructTreeRoot 20 0 R /MarkInfo << /Marked true >>',
    page: ' /StructParents 0',
    extra: {
        20: '<< /Type /StructTreeRoot /K [21 0 R] /ParentTree 22 0 R >>',
        21: '<< /Type /StructElem /S /P /P 20 0 R /Pg 3 0 R /K 0 >>',
        22: '<< /Nums [0 [21 0 R]] >>',
    },
};

/** A page from named pieces. `attachment` and `tagging` add the scaffolding for the losses. */
function build({ attachment = false, tagging = false, catalog = '', page = '', extra = {}, ...rest }) {
    return onePage({
        ...rest,
        catalog: `${attachment ? ` /Names << ${ATTACHMENT.names} >>` : ''}${tagging ? TAGGING.catalog : ''}${catalog}`,
        page: `${tagging ? TAGGING.page : ''}${page}`,
        extra: { ...(attachment ? ATTACHMENT.extra : {}), ...(tagging ? TAGGING.extra : {}), ...extra },
    });
}

// ---------------------------------------------------------------------------
// A, B, C — an /AA that names nothing
// ---------------------------------------------------------------------------

/** An annotation whose `/AA` is a reference to an object the file does not hold. */
const ANNOT_DANGLING_AA = { page: ' /Annots [8 0 R]', extra: { 8: LINK('/AA 99 0 R') } };
/** A page whose own `/AA` is a reference to an object the file does not hold. */
const PAGE_DANGLING_AA = { page: ' /AA 99 0 R' };

// R12-A: the annotation, with the attachment that used to be asked about first.
write('r12-a-annot-dangling-aa-att', build({ attachment: true, ...ANNOT_DANGLING_AA }));
// R12-B: the page.
write('r12-b-page-dangling-aa-att', build({ attachment: true, ...PAGE_DANGLING_AA }));
// R12-C: the same defect with nothing to confirm, and with the other loss, and with both.
write('r12-c-annot-dangling-aa', build({ ...ANNOT_DANGLING_AA }));
write('r12-c-page-dangling-aa', build({ ...PAGE_DANGLING_AA }));
write('r12-c-annot-dangling-aa-tag', build({ tagging: true, ...ANNOT_DANGLING_AA }));
write('r12-c-annot-dangling-aa-att-tag', build({ attachment: true, tagging: true, ...ANNOT_DANGLING_AA }));
// The same annotation shape as a form widget: the widget is a page annotation, so the
// same walk reaches it, and the form planner may say so first in Extract.
write('r12-c-widget-dangling-aa', onePage({
    catalog: ' /AcroForm << /Fields [9 0 R] /DA (/Helv 0 Tf 0 g) >>',
    page: ' /Annots [9 0 R]',
    extra: { 9: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (f1) /V (v) /Rect [10 10 100 30] /P 3 0 R /AA 99 0 R >>' },
}));

// ---------------------------------------------------------------------------
// D, E, F — a /Next chain of an exact length
// ---------------------------------------------------------------------------

/**
 * A chain of `hops` `/Next` hops — `hops + 1` actions — held by an annotation's
 * `/A`. The first action is object 40 and the last is object `40 + hops`. `end`
 * is the last action; `shape` is how each `/Next` is written.
 */
function chain(hops, { end = URI(), shape = 'direct', ...spec } = {}) {
    const extra = { 8: LINK('/A 40 0 R'), ...(spec.extra ?? {}) };
    for (let i = 0; i <= hops; i += 1) {
        const last = i === hops;
        const next = shape === 'array' ? ` /Next [${41 + i} 0 R]` : ` /Next ${41 + i} 0 R`;
        extra[40 + i] = last ? end : URI(next);
    }
    return build({ ...spec, page: ' /Annots [8 0 R]', extra });
}

for (const hops of [15, 16, 17]) write(`r12-d-next-${hops}`, chain(hops));
write('r12-d-next-17-att', chain(17, { attachment: true }));
for (const hops of [31, 32]) write(`r12-e-next-${hops}`, chain(hops));
write('r12-e-next-32-js', chain(32, { end: JS_ACTION('M6R12_E32') }));
write('r12-f-next-33', chain(33));
write('r12-f-next-33-att', chain(33, { attachment: true }));
write('r12-f-next-33-js', chain(33, { end: JS_ACTION('M6R12_F33') }));

// X: the same boundary through /Next arrays — the container is a level of its own.
for (const hops of [16, 17]) write(`r12-x-next-array-${hops}`, chain(hops, { shape: 'array' }));
write('r12-x-next-array-16-js', chain(16, { shape: 'array', end: JS_ACTION('M6R12_X16') }));

// ---------------------------------------------------------------------------
// G, H — shapes that stay refused whatever the depth arithmetic
// ---------------------------------------------------------------------------

/** A `/Next` list whose second member is not an action. */
const badMember = { page: ' /Annots [8 0 R]', extra: { 6: URI(' /Next [7 0 R 42]'), 7: URI(), 8: LINK('/A 6 0 R') } };
write('r12-g-next-array-bad-member', build({ ...badMember }));
write('r12-g-next-array-bad-member-att', build({ attachment: true, ...badMember }));
/** A chain that comes back to where it started, and one that points at itself. */
const cycle = { page: ' /Annots [8 0 R]', extra: { 6: URI(' /Next 7 0 R'), 7: URI(' /Next 6 0 R'), 8: LINK('/A 6 0 R') } };
write('r12-h-next-cycle', build({ ...cycle }));
write('r12-h-next-cycle-att', build({ attachment: true, ...cycle }));
write('r12-h-next-self', build({ page: ' /Annots [8 0 R]', extra: { 6: URI(' /Next 6 0 R'), 8: LINK('/A 6 0 R') } }));

// ---------------------------------------------------------------------------
// V — the valid shapes beside them
// ---------------------------------------------------------------------------

write('r12-v-direct-action', build({ page: ' /Annots [8 0 R]', extra: { 8: LINK(`/A ${URI()}`) } }));
write('r12-v-indirect-action', build({ page: ' /Annots [8 0 R]', extra: { 6: URI(), 8: LINK('/A 6 0 R') } }));
write('r12-v-next-array', build({ page: ' /Annots [8 0 R]', extra: { 6: URI(' /Next [7 0 R 9 0 R]'), 7: URI(), 9: URI(), 8: LINK('/A 6 0 R') } }));
write('r12-v-next-array-js', build({
    page: ' /Annots [8 0 R]',
    extra: { 6: URI(' /Next [7 0 R 9 0 R]'), 7: JS_ACTION('M6R12_V1'), 9: URI(), 8: LINK('/A 6 0 R') },
}));
write('r12-v-aa-valid', build({ page: ' /Annots [8 0 R]', extra: { 6: URI(), 8: LINK('/AA << /U 6 0 R >>') } }));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
