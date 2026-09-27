/**
 * The documents Round 11's JavaScript context authorization and preflight
 * completeness closure are proven against.
 *
 * **BLK-R10R-1.** Round 10 asked what *establishes* that a dictionary is an
 * action, and answered with two things that are not proof: that it carries `/S`
 * — which a transparency group, a structure element and a border style carry
 * too — and that the key holding a reference to it is *named* `/A`, `/Next` or
 * `/OpenAction`. A key's name is not an edge. `/Resources /ExtGState /A` is a
 * resource called "A"; `/Resources /Properties /Next` is a property list. Measured
 * at 7dea89b, READY, losses empty: an ExtGState registered under the name `/A`
 * and carrying `/S /Foo /JS (…)` was deleted as "the script", its reference was
 * left behind, and pdf.js drew the page opaque.
 *
 * The P family is the reviewer's exact adversarial set. Each subject has a
 * control that is the same document with the stray `/JS` removed and nothing
 * else changed, so a refusal is never mistaken for a fix that simply refuses
 * anything with a resource named "A".
 *
 * The H family is the holder matrix: **one child, byte for byte** — an
 * action-looking dictionary — reached through every kind of holder. Only the
 * holder and the edge change, so only they can be why the answer changes.
 *
 * The T family is the closed action vocabulary: what `/S` says, and what a
 * dictionary that says something else — or nothing — is given.
 *
 * **RF-R10R-1.** The Q and R families are documents whose action structure the
 * scan cannot read to the end, each carrying an ordinary attachment. At
 * 7dea89b planning asked only who owns the carriers, said
 * STRUCTURE_LOSS_REQUIRES_CONFIRMATION about the attachment, and the run refused
 * as UNSCANNABLE_ACTIONS after the confirmation had been given. The C family is
 * the confirmation-ordering matrix.
 *
 * Written by hand, like Rounds 7 to 10: pdf-lib normalises most of these shapes
 * away.
 *
 * Run:  node scripts/make-m6-round11-fixtures.mjs
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
const PAGE_PAINT = '0 1 0 rg 10 170 180 20 re f';
/** The square the oracle samples at (100, 100). */
const BLUE = '0 0 1 rg 60 60 80 80 re f';
const PAINT = `${PAGE_PAINT}\n${BLUE}`;

/** The script every carrier here holds, marked so the bytes can be searched. */
const SCRIPT = (marker) => `(app.alert\\(${marker}\\))`;
/** An action-looking dictionary: the one child the holder matrix reuses. */
const CHILD = (marker, extra = '') =>
    `<< /Type /Action /S /JavaScript /JS ${SCRIPT(marker)}${extra} >>`;
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
        32: stream('<< /Type /EmbeddedFile >>', 'M6R11_ATTACHMENT_PAYLOAD'),
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

/**
 * A page from named pieces. `attachment` and `tagging` add the scaffolding for
 * the losses; everything else is passed straight through.
 */
function build({ attachment = false, tagging = false, catalog = '', page = '', extra = {}, ...rest }) {
    return onePage({
        ...rest,
        catalog: `${attachment ? ` /Names << ${ATTACHMENT.names} >>` : ''}${tagging ? TAGGING.catalog : ''}${catalog}`,
        page: `${tagging ? TAGGING.page : ''}${page}`,
        extra: { ...(attachment ? ATTACHMENT.extra : {}), ...(tagging ? TAGGING.extra : {}), ...extra },
    });
}

// ---------------------------------------------------------------------------
// P — BLK-R10R-1: a resource that happens to be called "A"
// ---------------------------------------------------------------------------

/**
 * A graphics state — `/ca` and `/CA`, which is what makes `gs` change the
 * drawing — that also carries `/S /Foo`, so it passes the round-10 shape test,
 * and is registered under a resource name that is also an action-position key.
 */
const gstateBody = (js) =>
    `<< /ca 0.5 /CA 0.5 /LW 7 /S /Foo${js ? ` /JS ${SCRIPT(js)}` : ''} >>`;

const p2 = (js) => onePage({
    resources: '<< /ExtGState << /A 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /A gs ${BLUE} Q`,
    extra: { 6: gstateBody(js) },
});
write('r11-p2-extgstate-name-a', p2('M6R11_P2'));
write('r11-p2c-extgstate-name-a-clean', p2(null));

/** The same dictionary written directly under the resource name. */
const p4 = (js) => onePage({
    resources: `<< /ExtGState << /A ${gstateBody(js)} >> >>`,
    content: `${PAGE_PAINT}\nq /A gs ${BLUE} Q`,
});
write('r11-p4-extgstate-direct-name-a', p4('M6R11_P4'));
write('r11-p4c-extgstate-direct-name-a-clean', p4(null));

/**
 * An ordinary marked-content property list — not optional content, just a
 * language tag — under a name that is an action-position key. Round 9's
 * optional-content dangling-use invariant used to be the first thing to notice
 * it was gone, and reported a missing *layer*.
 */
const plist = (name, js) => onePage({
    resources: `<< /Properties << /${name} 6 0 R >> >>`,
    content: `${PAGE_PAINT}\n/Span /${name} BDC\n${BLUE}\nEMC`,
    extra: { 6: `<< /S /Foo /Lang (M6R11_PLIST)${js ? ` /JS ${SCRIPT(js)}` : ''} >>` },
});
write('r11-p1-props-name-a', plist('A', 'M6R11_P1'));
write('r11-p1c-props-name-a-clean', plist('A', null));
write('r11-p1b-props-name-next', plist('Next', 'M6R11_P1B'));
write('r11-p1bc-props-name-next-clean', plist('Next', null));
write('r11-p5-props-name-openaction', plist('OpenAction', 'M6R11_P5'));
write('r11-p5c-props-name-openaction-clean', plist('OpenAction', null));

// ---------------------------------------------------------------------------
// H — the holder matrix: one child, every kind of holder
// ---------------------------------------------------------------------------

/**
 * Object 6 is `CHILD(marker)` in every document below, byte for byte. What
 * differs is only who holds it and under which key.
 */
const holder = (name, marker, spec) => write(name, onePage({
    ...spec,
    extra: { 6: CHILD(marker), ...(spec.extra ?? {}) },
}));
const PROPS = (n) => ({
    resources: `<< /Properties << /${n} 6 0 R >> >>`,
    content: `${PAGE_PAINT}\n/Span /${n} BDC\n${BLUE}\nEMC`,
});

// A. the real catalog OpenAction — supported.
holder('r11-h-a-real-openaction', 'M6R11_HA', { catalog: ' /OpenAction 6 0 R' });
// B. an arbitrary dictionary that has an `/OpenAction` key — not an action edge.
holder('r11-h-b-private-openaction', 'M6R11_HB', {
    page: ' /PieceInfo << /App << /OpenAction 6 0 R >> >>',
});
// C. an annotation on a page — supported.
holder('r11-h-c-real-annot-a', 'M6R11_HC', {
    page: ' /Annots [8 0 R]',
    extra: { 8: LINK('/A 6 0 R') },
});
// D. a resource dictionary member whose *name* is `/A` — not an action edge.
holder('r11-h-d-resource-name-a', 'M6R11_HD', PROPS('A'));
holder('r11-h-d2-extgstate-name-a', 'M6R11_HD2', {
    resources: '<< /ExtGState << /A 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /A gs ${BLUE} Q`,
});
// E. a supported `/AA` event value — supported.
holder('r11-h-e-real-aa', 'M6R11_HE', {
    page: ' /Annots [8 0 R]',
    extra: { 8: LINK('/AA << /U 6 0 R >>') },
});
// F. an arbitrary dictionary containing an `/AA` key — not an action edge.
holder('r11-h-f-private-aa', 'M6R11_HF', {
    page: ' /PieceInfo << /App << /AA << /X 6 0 R >> >> >>',
});
// G. the `/Next` of a proven action — supported.
holder('r11-h-g-proven-next', 'M6R11_HG', {
    page: ' /Annots [8 0 R]',
    extra: { 7: URI(' /Next 6 0 R'), 8: LINK('/A 7 0 R') },
});
/**
 * G2. The same, through an internal `/GoTo` — the one action M6 rebuilds. The
 * rebuild replaces the annotation's `/A` with a new action and leaves the copy
 * of the old one registered, still holding its `/Next`: a proven action nothing
 * points at. Planning sees the reachable one and the sanitizer sees the orphan,
 * and both have to answer the same way.
 */
holder('r11-h-g2-goto-next-rebuilt', 'M6R11_HG2', {
    page: ' /Annots [8 0 R]',
    extra: {
        7: '<< /Type /Action /S /GoTo /D [3 0 R /Fit] /Next 6 0 R >>',
        8: LINK('/A 7 0 R'),
    },
});
// H. the `/Next` of something that is not an action — not an action edge.
holder('r11-h-h-nonaction-next', 'M6R11_HH', {
    page: ' /Annots [8 0 R]',
    extra: { 7: '<< /Foo 1 /Next 6 0 R >>', 8: LINK('/A 7 0 R') },
});
holder('r11-h-h2-private-next', 'M6R11_HH2', {
    page: ' /PieceInfo << /App << /Next 6 0 R >> >>',
});
// I. an actual value slot of the `/Names /JavaScript` tree — supported.
holder('r11-h-i-names-value', 'M6R11_HI', {
    catalog: ' /Names << /JavaScript 7 0 R >>',
    extra: { 7: '<< /Names [(script) 6 0 R] >>' },
});
// J. a name slot of that array — a name is never an action.
holder('r11-h-j-names-key-slot', 'M6R11_HJ', {
    catalog: ' /Names << /JavaScript 7 0 R >>',
    extra: { 7: '<< /Names [6 0 R (script) 9 0 R] >>', 9: '<< /Type /Action /S /Named /N /NextPage >>' },
});
// K. a name tree that is not the JavaScript one — not an action edge.
holder('r11-h-k-unrelated-names-tree', 'M6R11_HK', {
    catalog: ' /Names << /Dests 7 0 R >>',
    extra: { 7: '<< /Names [(script) 6 0 R] >>' },
});

// ---------------------------------------------------------------------------
// S — shared ownership, and the same key name in two holders
// ---------------------------------------------------------------------------

/**
 * The particularly important one. The same child is held by a real annotation's
 * `/A` **and** by `/Resources /ExtGState /A`. The key is spelled identically.
 * Only the holder distinguishes them, and one of them is not an action.
 */
holder('r11-s-annot-a-and-extgstate-a', 'M6R11_S1', {
    resources: '<< /ExtGState << /A 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /A gs ${BLUE} Q`,
    page: ' /Annots [8 0 R]',
    extra: { 8: LINK('/A 6 0 R') },
});
/**
 * A holder that is not part of the document at all — an object nothing reaches,
 * as a rebuild leaves behind — points at the action from a key that is not an
 * action position. Nothing live depends on it, so it is not a reason to refuse;
 * the same key on a holder the page *does* reach (`r11-h-f`, `r11-s-annot-a-and-
 * extgstate-a`) is.
 */
holder('r11-s-dead-holder-ignored', 'M6R11_S3', {
    page: ' /Annots [8 0 R]',
    extra: { 8: LINK('/A 6 0 R'), 9: '<< /Foo 6 0 R /Bar (nothing points here) >>' },
});
/** Three valid action edges to one action. Supported; the script goes with them. */
holder('r11-s-three-action-edges', 'M6R11_S2', {
    catalog: ' /OpenAction 6 0 R',
    page: ' /Annots [8 0 R]',
    extra: { 8: LINK('/A 6 0 R /AA << /U 6 0 R >>') },
});

// ---------------------------------------------------------------------------
// T — `/S` is a closed vocabulary
// ---------------------------------------------------------------------------

/** An action the annotation holds, with `/JS` — the only variable is its shape. */
const shape = (name, marker, body) => write(name, onePage({
    page: ' /Annots [8 0 R]',
    extra: { 6: body(SCRIPT(marker)), 8: LINK('/A 6 0 R') },
}));

shape('r11-t-javascript', 'M6R11_T1', (js) => `<< /S /JavaScript /JS ${js} >>`);
shape('r11-t-rendition', 'M6R11_T2', (js) => `<< /S /Rendition /OP 0 /JS ${js} >>`);
shape('r11-t-unknown-s', 'M6R11_T3', (js) => `<< /S /Foo /JS ${js} >>`);
shape('r11-t-missing-s', 'M6R11_T4', (js) => `<< /Type /Action /JS ${js} >>`);
shape('r11-t-not-a-name-s', 'M6R11_T5', (js) => `<< /S (JavaScript) /JS ${js} >>`);
shape('r11-t-type-action-unknown-s', 'M6R11_T6', (js) => `<< /Type /Action /S /Foo /JS ${js} >>`);
shape('r11-t-type-action-no-script-s', 'M6R11_T7', (js) => `<< /Type /Action /S /GoTo /JS ${js} >>`);
shape('r11-t-transparency-s', 'M6R11_T8', (js) => `<< /S /Transparency /JS ${js} >>`);

/** A chain through recognised action types, ending in a script. Every link is proven. */
write('r11-t-chain-recognised', onePage({
    page: ' /Annots [8 0 R]',
    extra: {
        6: URI(' /Next 7 0 R'),
        7: '<< /Type /Action /S /Named /N /NextPage /Next 9 0 R >>',
        9: '<< /S /Hide /T (field) /H true /Next 10 0 R >>',
        10: CHILD('M6R11_T9'),
        8: LINK('/A 6 0 R'),
    },
}));
/** The same chain with one link whose `/S` is not an action type. Nothing past it is proven. */
write('r11-t-chain-unrecognised-link', onePage({
    page: ' /Annots [8 0 R]',
    extra: {
        6: URI(' /Next 7 0 R'),
        7: '<< /S /Foo /Next 10 0 R >>',
        10: CHILD('M6R11_T10'),
        8: LINK('/A 6 0 R'),
    },
}));

// ---------------------------------------------------------------------------
// O — Outline items: not a position the action scan walks
// ---------------------------------------------------------------------------

const outline = (js) => onePage({
    catalog: ' /Outlines 20 0 R',
    extra: {
        20: '<< /Type /Outlines /First 21 0 R /Last 21 0 R /Count 1 >>',
        21: `<< /Title (contents) /Parent 20 0 R${js ? ` /A ${CHILD(js)}` : ''} >>`,
    },
});
write('r11-o-outline-a-js', outline('M6R11_O1'));
write('r11-oc-outline-clean', outline(null));

// ---------------------------------------------------------------------------
// Q / R — RF-R10R-1: an action structure the scan cannot read to the end
// ---------------------------------------------------------------------------

/** Every one of these carries an ordinary attachment, so the wrong order shows. */
const unscannable = (name, spec) => write(name, build({ attachment: true, ...spec }));
unscannable('r11-q9-att-annot-a-42', { page: ' /Annots [8 0 R]', extra: { 8: LINK('/A 42') } });
unscannable('r11-r1-att-annot-aa-42', { page: ' /Annots [8 0 R]', extra: { 8: LINK('/AA << /U 42 >>') } });
unscannable('r11-r2-att-page-aa-42', { page: ' /AA << /O 42 >>' });
unscannable('r11-r3-att-annot-a-name', { page: ' /Annots [8 0 R]', extra: { 8: LINK('/A /Foo') } });
unscannable('r11-r4-att-annot-a-dangling', { page: ' /Annots [8 0 R]', extra: { 8: LINK('/A 99 0 R') } });
unscannable('r11-r6-att-next-name', {
    page: ' /Annots [8 0 R]',
    extra: { 6: URI(' /Next /Foo'), 8: LINK('/A 6 0 R') },
});
unscannable('r11-r7-att-annot-a-stream', {
    page: ' /Annots [8 0 R]',
    extra: { 6: stream('<< /Type /Action /S /URI /URI (https://example.invalid/) >>', 'x'), 8: LINK('/A 6 0 R') },
});
unscannable('r11-q11-att-next-list-42', {
    page: ' /Annots [8 0 R]',
    extra: { 6: URI(' /Next [7 0 R 42]'), 7: CHILD('M6R11_Q11'), 8: LINK('/A 6 0 R') },
});
/** The same defect, no attachment: planning used to say READY. */
write('r11-eq9-annot-a-42', onePage({ page: ' /Annots [8 0 R]', extra: { 8: LINK('/A 42') } }));
write('r11-eq9b-annot-a-dangling', onePage({ page: ' /Annots [8 0 R]', extra: { 8: LINK('/A 99 0 R') } }));

// ---------------------------------------------------------------------------
// C — confirmation ordering: a hard refusal comes before every question
// ---------------------------------------------------------------------------

const UNSAFE = {
    resources: '<< /ExtGState << /GS0 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /GS0 gs ${BLUE} Q`,
    extra: { 6: '<< /ca 0.5 /CA 0.5 /JS (app.alert\\(M6R11_C_UNSAFE\\)) >>' },
};
const UNSCANNABLE = { page: ' /Annots [8 0 R]', extra: { 8: LINK('/A 42') } };
const both = (a, b) => ({ ...a, ...b, extra: { ...a.extra, ...b.extra } });

write('r11-c-att-only', build({ attachment: true }));
write('r11-c-tag-only', build({ tagging: true }));
write('r11-c-unsafe-only', build({ ...UNSAFE }));
write('r11-c-unscannable-only', build({ ...UNSCANNABLE }));
write('r11-c-unsafe-att', build({ attachment: true, ...UNSAFE }));
write('r11-c-unscannable-att', build({ attachment: true, ...UNSCANNABLE }));
write('r11-c-unsafe-tag', build({ tagging: true, ...UNSAFE }));
write('r11-c-unscannable-tag', build({ tagging: true, ...UNSCANNABLE }));
write('r11-c-unsafe-att-tag', build({ attachment: true, tagging: true, ...UNSAFE }));
write('r11-c-unscannable-att-tag', build({ attachment: true, tagging: true, ...UNSCANNABLE }));
write('r11-c-both-att', build({ attachment: true, ...both(UNSAFE, UNSCANNABLE) }));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
