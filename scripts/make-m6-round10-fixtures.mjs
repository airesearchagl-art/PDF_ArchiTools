/**
 * The documents Round 10's JavaScript carrier ownership closure is proven
 * against.
 *
 * **BLK-R9R-1.** Round 9 asked whether anything *contradicted* "this is an
 * action" — a stream, a `/Type` other than `/Action`, a `/Subtype`. That closed
 * the shape it was found on and left the class open, because most PDF
 * dictionaries declare none of those things. Measured at 0a30302, READY, losses
 * empty: `/Resources /ExtGState /GS0` naming `<< /ca 0.5 /CA 0.5 /JS (…) >>`
 * was deleted as "the script", the reference was left behind, and pdf.js drew
 * the page opaque — `ignoring ExtGState: GState should be a dictionary`.
 *
 * So the K family is the same question from the other side: what *establishes*
 * that a dictionary is an action. Two things have to, together — its own shape
 * (`/S`, or `/Type /Action`) and every reference that reaches it being an
 * action position. `k4`, `k5` and `k6` are the three carriers that passed the
 * old test and are not actions; `k4c`, `k5c` and `k6c` are the same documents
 * with the stray key removed, and they must still come through untouched.
 *
 * `k7`–`k13` are the ownership matrix: an action reached from two action slots
 * (removable), one reached from an action slot and a resource slot (not), and
 * each supported position — the name tree, `/AA`, `/Next`, and the detached
 * action the destination and AcroForm rebuilds leave behind on purpose.
 *
 * `k15` is RF-R10-1: a document that is refused for a JavaScript reason and
 * also holds a perfectly ordinary attachment. Nobody should be asked to agree
 * to losing the attachment for an extract that was never going to happen.
 *
 * Written by hand, like Rounds 7 to 9: pdf-lib normalises most of these shapes
 * away.
 *
 * Run:  node scripts/make-m6-round10-fixtures.mjs
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

/** The script every carrier here holds, marked so the bytes can be searched. */
const SCRIPT = (marker) => `(app.alert\\(${marker}\\))`;
/** A JavaScript action in the shape this contract already supports. */
const JS_ACTION = (marker) => `<< /Type /Action /S /JavaScript /JS ${SCRIPT(marker)} >>`;

/** Catalog, one page, content as object 4. `extra` adds numbered objects. */
function onePage({ catalog = '', resources = '<< >>', content = PAGE_PAINT, page = '', extra = {} }) {
    const o = new Map();
    o.set(1, `<< /Type /Catalog /Pages 2 0 R${catalog} >>`);
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources ${resources} /Contents 4 0 R${page} >>`);
    o.set(4, stream('<< >>', content));
    for (const [k, v] of Object.entries(extra)) o.set(Number(k), v);
    return doc(o);
}

// ---------------------------------------------------------------------------
// K4 / K5 / K6 — the carriers the Round 9 test let through, and their controls
// ---------------------------------------------------------------------------

/**
 * A graphics state with no `/Type` — which the specification makes optional and
 * many producers leave out — painting the square at half opacity. With the
 * stray `/JS` the whole dictionary was deleted and the square came out solid.
 */
const gstate = (js) => onePage({
    resources: '<< /ExtGState << /GS0 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /GS0 gs ${BLUE} Q`,
    extra: { 6: `<< /ca 0.5 /CA 0.5 /LW 7${js ? ` /JS ${SCRIPT('M6R10_GSTATE')}` : ''} >>` },
});
write('r10-k4-extgstate-js', gstate(true));
write('r10-k4c-extgstate-clean', gstate(false));

/**
 * A transparency group attributes dictionary, likewise typeless, on the form
 * the page draws. `/Transparency` is searched for in the artifact bytes: the
 * control keeps it, and the subject never produces bytes at all.
 */
const group = (js) => onePage({
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\nq /Fm0 Do Q`,
    extra: {
        6: `<< /S /Transparency /I true /K true${js ? ` /JS ${SCRIPT('M6R10_GROUP')}` : ''} >>`,
        7: stream('<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /Group 6 0 R >>', BLUE),
    },
});
write('r10-k5-group-js', group(true));
write('r10-k5c-group-clean', group(false));

/**
 * An ordinary marked-content property list — not optional content, just a
 * language tag. At 0a30302 the stray `/JS` deleted it and the run stopped on
 * the optional-content dangling-use invariant, reporting a missing *layer*:
 * fail-closed, and the wrong sentence about the wrong thing.
 */
const propertyList = (js) => onePage({
    resources: '<< /Properties << /MC9 6 0 R >> >>',
    content: `${PAGE_PAINT}\n/Span /MC9 BDC\n${BLUE}\nEMC`,
    extra: { 6: `<< /Lang (M6R10_PLIST)${js ? ` /JS ${SCRIPT('M6R10_PROPS')}` : ''} >>` },
});
write('r10-k6-props-js', propertyList(true));
write('r10-k6c-props-clean', propertyList(false));

/**
 * The boundary: the same graphics state that *does* declare `/Type
 * /ExtGState`. Round 9 already refused this one; it stays here so a change to
 * the shape test cannot quietly stop refusing it.
 */
write('r10-k14-extgstate-typed-js', onePage({
    resources: '<< /ExtGState << /GS0 6 0 R >> >>',
    content: `${PAGE_PAINT}\nq /GS0 gs ${BLUE} Q`,
    extra: { 6: `<< /Type /ExtGState /ca 0.5 /JS ${SCRIPT('M6R10_TYPED')} >>` },
}));

// ---------------------------------------------------------------------------
// K7 / K8 — ownership: who is allowed to point at an action
// ---------------------------------------------------------------------------

/** One action, two proven action slots. Both edges go; the script goes with them. */
write('r10-k7-shared-action', onePage({
    catalog: ' /OpenAction 6 0 R',
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\nq /Fm0 Do Q`,
    page: ' /Annots [8 0 R]',
    extra: {
        6: JS_ACTION('M6R10_SHARED'),
        7: stream('<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> >>', BLUE),
        8: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A 6 0 R >>',
    },
}));

/**
 * The same action, also named by a page's `/Properties`. One of those two
 * edges is an action and the other is a drawing resource, so the object is not
 * exclusively an action and it is not taken apart as one.
 */
write('r10-k8-mixed-owner', onePage({
    catalog: ' /OpenAction 6 0 R',
    resources: '<< /Properties << /MC9 6 0 R >> >>',
    content: `${PAGE_PAINT}\n/Span /MC9 BDC\n${BLUE}\nEMC`,
    extra: { 6: JS_ACTION('M6R10_MIXED') },
}));

// ---------------------------------------------------------------------------
// K9 - K13 — every supported action position, and the two detached shapes
// ---------------------------------------------------------------------------

/** The document-level script name tree. */
write('r10-k9-names-js', onePage({
    catalog: ' /Names << /JavaScript 7 0 R >>',
    content: `${PAGE_PAINT}\n${BLUE}`,
    extra: { 6: JS_ACTION('M6R10_NAMETREE'), 7: '<< /Names [(s1) 6 0 R] >>' },
}));

/** An annotation's additional-actions dictionary. */
write('r10-k10-aa-js', onePage({
    content: `${PAGE_PAINT}\n${BLUE}`,
    page: ' /Annots [8 0 R]',
    extra: {
        6: JS_ACTION('M6R10_AA'),
        8: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /AA << /U 6 0 R >> >>',
    },
}));

/** A script reached only as the `/Next` of another action. */
write('r10-k11-next-js', onePage({
    content: `${PAGE_PAINT}\n${BLUE}`,
    page: ' /Annots [8 0 R]',
    extra: {
        6: '<< /Type /Action /S /GoTo /D [3 0 R /Fit] /Next 7 0 R >>',
        7: JS_ACTION('M6R10_NEXT'),
        8: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A 6 0 R >>',
    },
}));

/**
 * A registered action nothing points at. `dropOpenAction` and the destination
 * and AcroForm rebuilds all orphan actions on purpose, so this is the ordinary
 * end state of a supported removal — and its shape still says action.
 */
write('r10-k12-detached-action', onePage({
    content: `${PAGE_PAINT}\n${BLUE}`,
    extra: { 6: JS_ACTION('M6R10_DETACHED') },
}));

/**
 * A detached dictionary that carries a script and nothing that says action.
 * Having no inbound reference is not evidence of being one, so this refuses
 * rather than guessing that an unreferenced object may be taken apart.
 */
write('r10-k13-detached-typeless', onePage({
    content: `${PAGE_PAINT}\n${BLUE}`,
    extra: { 6: `<< /Lang (M6R10_ORPHAN) /JS ${SCRIPT('M6R10_ORPHAN_JS')} >>` },
}));

// ---------------------------------------------------------------------------
// K15 — RF-R10-1: the refusal has to arrive before the confirmation
// ---------------------------------------------------------------------------

/**
 * An ordinary attachment, which would be a loss to agree to, and a drawn form
 * carrying a stray `/JS`, which makes the extract impossible. At 0a30302
 * planning returned STRUCTURE_LOSS_REQUIRES_CONFIRMATION naming only the
 * attachment, and the JavaScript refusal arrived after the confirmation had
 * been given.
 */
write('r10-k15-js-and-attachment', onePage({
    catalog: ' /Names << /EmbeddedFiles 9 0 R >>',
    resources: '<< /XObject << /Fm0 7 0 R >> >>',
    content: `${PAGE_PAINT}\nq /Fm0 Do Q`,
    extra: {
        7: stream(
            `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /JS ${SCRIPT('M6R10_FORM')} >>`,
            BLUE,
        ),
        8: stream('<< /Type /EmbeddedFile >>', 'M6R10_ATTACHMENT_PAYLOAD'),
        9: '<< /Names [(notes.txt) 10 0 R] >>',
        10: '<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F 8 0 R >> >>',
    },
}));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
