/**
 * The documents Round 8's optional-content safety closure is proven against.
 *
 * Three families, one theme: an artifact may not change what a reader sees.
 *
 * **BLK-R7-A** is a form XObject that more than one resource edge names. The
 * walker used to answer "have I seen this object" before it answered "what does
 * `/OC` mean on *this* edge", so a form first met through a `/Pattern` or a
 * Type 3 `/CharProcs` — where `/OC` is not an attachment point and is therefore
 * not read — was marked, and the later `/XObject` edge returned before reading
 * it. Neither carried nor refused, the group stayed out of `/OCProperties`
 * while the copied `/OC` stayed live, and a layer the author had switched off
 * drew in the artifact. Every fixture here uses a default-**OFF** layer, so the
 * defect is a visible flip rather than a structural nicety.
 *
 * **BLK-R7-B** is a page `/Properties` entry naming a group the source does not
 * register. Every other reader in this module refuses that; this one carried it
 * and registered it in the output, which handed an unregistered group the
 * source's `/D /OFF` and hid content the author could see.
 *
 * **RF-R8-1** is the artifact-wide backstop. Those fixtures are not sources at
 * all: they are *artifact* shapes, fed straight to the output census, because
 * the point of a backstop is that it holds when discovery does not. One of them
 * carries an `/OC` on an object no page walk would ever reach.
 *
 * Written by hand rather than through pdf-lib for the same reason Round 7's
 * were: pdf-lib writes the shapes it likes, and every one of these is a shape
 * it would quietly normalise away.
 *
 * Run:  node scripts/make-m6-round8-fixtures.mjs
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

/**
 * A document from explicit numbered objects.
 *
 * `startxref 0` and no table, exactly as Round 7's hand-built documents do:
 * pdf-lib recovers by scanning, which is what lets an object nothing points at
 * still be in the file — the shape RF-R8-1's C14 needs.
 */
function doc(objects, { root = 1, extraTrailer = '' } = {}) {
    const nums = [...objects.keys()].sort((a, b) => a - b);
    let body = '%PDF-1.7\n';
    for (const n of nums) body += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
    body += `trailer\n<< /Size ${nums[nums.length - 1] + 1} /Root ${root} 0 R${extraTrailer} >>\n`
        + 'startxref\n0\n%%EOF\n';
    return latin1(body);
}

const stream = (dict, content) => {
    const inner = dict.replace(/>>\s*$/, '').trimEnd();
    return `${inner} /Length ${content.length} >>\nstream\n${content}endstream`;
};

const write = (name, bytes) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

/** A green bar the page always paints, so "hidden layer" is not "blank page". */
const PAGE_PAINT = '0 1 0 rg 10 10 180 20 re f\n';
/** A blue square only the layer paints. */
const FORM_PAINT = '0 0 1 rg 60 60 80 80 re f\n';
/** Something for the alias edge to draw that is not the layer. */
const DECOY_PAINT = '1 0 0 rg 5 170 20 20 re f\n';

const OCG = '<< /Type /OCG /Name (Layer A) >>';
const OTHER_OCG = '<< /Type /OCG /Name (Layer B) >>';

/** `/OCProperties` with one registered group, switched off by default. */
const configOff = (groups = '5 0 R', d = '/BaseState /ON /OFF [5 0 R]') =>
    ` /OCProperties << /OCGs [${groups}] /D << ${d} >> >>`;

// ---------------------------------------------------------------------------
// BLK-R7-A — one object, more than one resource edge
// ---------------------------------------------------------------------------

/**
 * `alias` decides which resource class reaches form 7 besides `/XObject`, and
 * `order` decides which edge the page walks first.
 */
function aliasDoc({ alias, order = 'alias-first' }) {
    const objs = new Map();
    // Walked in dictionary order, which is the order written here.
    const keys = order === 'alias-first'
        ? '/Fa 8 0 R /Fz 7 0 R'
        : '/Aa 7 0 R /Zz 8 0 R';
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${configOff()} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] `
        + `/Resources << /XObject << ${keys} >> >> /Contents 4 0 R >>`);
    objs.set(4, stream('<< >>', `${PAGE_PAINT}/Fa Do\n/Fz Do\n`));
    objs.set(5, OCG);
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /OC 5 0 R >>',
        FORM_PAINT,
    ));

    let decoyResources = '<< >>';
    if (alias === 'pattern') {
        decoyResources = '<< /Pattern << /P0 7 0 R >> >>';
    } else if (alias === 'charprocs') {
        decoyResources = '<< /Font << /T3 9 0 R >> >>';
        objs.set(9, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 10 10] '
            + '/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 7 0 R >> '
            + '/Encoding << /Type /Encoding /Differences [97 /a] >> '
            + '/FirstChar 97 /LastChar 97 /Widths [10] >>');
    } else if (alias === 'smask') {
        decoyResources = '<< /ExtGState << /GS0 10 0 R >> >>';
        objs.set(10, '<< /Type /ExtGState /SMask << /S /Luminosity /G 7 0 R >> >>');
    }
    objs.set(8, stream(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources ${decoyResources} >>`,
        DECOY_PAINT,
    ));
    return doc(objs);
}

write('r8-alias-pattern', aliasDoc({ alias: 'pattern' }));
write('r8-alias-charprocs', aliasDoc({ alias: 'charprocs' }));
write('r8-alias-smask', aliasDoc({ alias: 'smask' }));
write('r8-alias-xobject-first', aliasDoc({ alias: 'pattern', order: 'xobject-first' }));

/** The same form under two `/XObject` keys: two valid edges, one group. */
write('r8-alias-two-keys', (() => {
    const objs = new Map();
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${configOff()} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + '/Resources << /XObject << /Fm0 7 0 R /FmX 7 0 R >> >> /Contents 4 0 R >>');
    objs.set(4, stream('<< >>', `${PAGE_PAINT}/Fm0 Do\n`));
    objs.set(5, OCG);
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /OC 5 0 R >>',
        FORM_PAINT,
    ));
    return doc(objs);
})());

/** The same form on two pages. Both are selected, so both must be found. */
write('r8-alias-two-pages', (() => {
    const objs = new Map();
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${configOff()} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>');
    for (const [pageNum, contentNum] of [[3, 4], [6, 11]]) {
        objs.set(pageNum, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
            + `/Resources << /XObject << /Fm0 7 0 R >> >> /Contents ${contentNum} 0 R >>`);
        objs.set(contentNum, stream('<< >>', `${PAGE_PAINT}/Fm0 Do\n`));
    }
    objs.set(5, OCG);
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /OC 5 0 R >>',
        FORM_PAINT,
    ));
    return doc(objs);
})());

/** A nested form that is also aliased into the outer form's `/Pattern`. */
write('r8-alias-nested', (() => {
    const objs = new Map();
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${configOff()} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + '/Resources << /XObject << /Fm0 8 0 R >> >> /Contents 4 0 R >>');
    objs.set(4, stream('<< >>', `${PAGE_PAINT}/Fm0 Do\n`));
    objs.set(5, OCG);
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >> /OC 5 0 R >>',
        FORM_PAINT,
    ));
    // `/Pattern` is written first, so the alias edge is walked before the
    // nested `/XObject` edge that actually carries the layer.
    objs.set(8, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] '
        + '/Resources << /Pattern << /P0 7 0 R >> /XObject << /Fm1 7 0 R >> >> >>',
        `${DECOY_PAINT}/Fm1 Do\n`,
    ));
    return doc(objs);
})());

/** A resource graph that loops: the expansion set still has to terminate it. */
write('r8-alias-cycle', (() => {
    const objs = new Map();
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${configOff()} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + '/Resources 6 0 R /Contents 4 0 R >>');
    objs.set(4, stream('<< >>', `${PAGE_PAINT}/Fm0 Do\n`));
    objs.set(5, OCG);
    objs.set(6, '<< /XObject << /Fm0 7 0 R >> >>');
    // The form takes the page's own resource dictionary as its own.
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources 6 0 R /OC 5 0 R >>',
        FORM_PAINT,
    ));
    return doc(objs);
})());

// ---------------------------------------------------------------------------
// BLK-R7-B — a page property naming a group the source does not register
// ---------------------------------------------------------------------------

const MARKED = `${PAGE_PAINT}/OC /MC0 BDC\n${FORM_PAINT}EMC\n`;

/**
 * `registered` decides whether `/OCProperties /OCGs` lists the group the page's
 * `/Properties` names; `state` decides which list `/D` puts it in. `property`
 * replaces the entry with a shape that cannot be proven at all.
 */
function propsDoc({ registered = true, state = 'ON', property = '5 0 R' }) {
    const objs = new Map();
    const groups = registered ? '5 0 R' : '6 0 R';
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R`
        + ` /OCProperties << /OCGs [${groups}] /D << /BaseState /ON /${state} [5 0 R] >> >> >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + `/Resources << /Properties << /MC0 ${property} >> >> /Contents 4 0 R >>`);
    objs.set(4, stream('<< >>', MARKED));
    objs.set(5, OCG);
    if (!registered) objs.set(6, OTHER_OCG);
    if (property === '7 0 R') objs.set(7, '<< /Type /Annot /Subtype /Square >>');
    return doc(objs);
}

write('r8-props-registered-on', propsDoc({ registered: true, state: 'ON' }));
write('r8-props-registered-off', propsDoc({ registered: true, state: 'OFF' }));
write('r8-props-unregistered-on', propsDoc({ registered: false, state: 'ON' }));
write('r8-props-unregistered-off', propsDoc({ registered: false, state: 'OFF' }));
write('r8-props-dangling', propsDoc({ registered: true, property: '99 0 R' }));
write('r8-props-wrongtype', propsDoc({ registered: true, property: '7 0 R' }));
write('r8-props-direct', propsDoc({
    registered: true,
    property: '<< /Type /OCG /Name (Inline) >>',
}));

// ---------------------------------------------------------------------------
// RF-R8-1 — artifact shapes, fed straight to the output census
// ---------------------------------------------------------------------------

/**
 * A one-page artifact whose form carries `oc`, with `config` as the catalog's
 * optional-content entry. Both are written verbatim, because every one of these
 * is a shape the production writer would never produce — which is the point.
 */
function artifactDoc({ oc = null, config = null, extra = new Map(), formExtra = '' } = {}) {
    const objs = new Map();
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R${config ? ` /OCProperties ${config}` : ''} >>`);
    objs.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.set(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
        + '/Resources << /XObject << /Fm0 7 0 R >> >> /Contents 4 0 R >>');
    objs.set(4, stream('<< >>', `${PAGE_PAINT}/Fm0 Do\n`));
    objs.set(5, OCG);
    objs.set(7, stream(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >>'
        + `${oc ? ` /OC ${oc}` : ''}${formExtra} >>`,
        FORM_PAINT,
    ));
    for (const [k, v] of extra) objs.set(k, v);
    // The group object goes in only when something names it. A spare object
    // nothing points at is its own invariant failure, and these documents are
    // meant to fail one thing at a time.
    const named = [...objs].filter(([n]) => n !== 5).map(([, v]) => v).join('\n');
    if (!named.includes('5 0 R')) objs.delete(5);
    return doc(objs);
}

const REGISTERED = '<< /OCGs [5 0 R] /D << /BaseState /ON /ON [5 0 R] >> >>';

// C1 — nothing to prove.
write('r8-art-none', artifactDoc({}));
// C2 — the ordinary supported artifact.
write('r8-art-ok', artifactDoc({ oc: '5 0 R', config: REGISTERED }));
// C3 — a live `/OC` and no configuration at all. This is BLK-R7-A's output.
write('r8-art-no-ocprops', artifactDoc({ oc: '5 0 R' }));
// C4 — a live `/OC` naming a group the artifact does not register.
write('r8-art-unregistered', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [6 0 R] /D << /BaseState /ON >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
// C5 — a live `/OC` naming nothing.
write('r8-art-dangling', artifactDoc({ oc: '99 0 R', config: REGISTERED }));
// C6 — a membership dictionary that survived into the output.
write('r8-art-ocmd', artifactDoc({
    oc: '9 0 R',
    config: REGISTERED,
    extra: new Map([[9, '<< /Type /OCMD /OCGs [5 0 R] >>']]),
}));
// C7 / C8 — `/ON` and `/OFF` naming a group the artifact does not register.
write('r8-art-on-unregistered', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [5 0 R] /D << /BaseState /ON /ON [5 0 R 6 0 R] >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
write('r8-art-off-unregistered', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [5 0 R] /D << /BaseState /ON /OFF [6 0 R] >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
// C9 — `/Order` naming a group the artifact does not register.
write('r8-art-order-unregistered', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [5 0 R] /D << /BaseState /ON /Order [5 0 R [(Section) 6 0 R]] >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
// C10 — `/AS` naming a group the artifact does not register.
write('r8-art-as-unregistered', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [5 0 R] /D << /BaseState /ON '
        + '/AS [<< /Event /View /Category [/View] /OCGs [6 0 R] >>] >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
// C11 — a non-empty `/RBGroups`, which this output never writes.
write('r8-art-rbgroups', artifactDoc({
    oc: '5 0 R',
    config: '<< /OCGs [5 0 R 6 0 R] /D << /BaseState /ON /RBGroups [[5 0 R 6 0 R]] >> >>',
    extra: new Map([[6, OTHER_OCG]]),
}));
// C12 — a configuration the proof needs and cannot read.
write('r8-art-malformed', artifactDoc({
    oc: '5 0 R',
    config: '<< /D << /BaseState /ON >> >>',
}));
// C13 — `/OC` inside a direct dictionary nested below the object's own keys.
write('r8-art-nested-oc', artifactDoc({
    formExtra: ' /Private << /Deeper << /OC 5 0 R >> >>',
}));
// C14 — `/OC` on an indirect object no page walk reaches.
write('r8-art-detached-oc', artifactDoc({
    extra: new Map([[12, '<< /Type /XObject /Subtype /Form /OC 5 0 R >>']]),
}));
// Control — keys that merely start the same way must not read as `/OC`.
write('r8-art-control', artifactDoc({
    formExtra: ' /OCR true /OCSP (none) /OCProperties (not the catalog one)',
}));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
