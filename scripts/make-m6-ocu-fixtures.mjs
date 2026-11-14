/**
 * OC-U / OC-C2 fixtures (Human-adopted with conditions, 2026-11-15).
 *
 * The shape is the one MLIT's 建築工事標準詳細図 vol. 2 has, rebuilt
 * synthetically: CAD layers a page's `/Properties` names that
 * `/OCProperties /OCGs` never registers (OC-U), registered layers drawn by form
 * XObjects, and a `/D /AS` that names every registered layer, including ones no
 * page uses (OC-C2). Nothing from that document is copied here.
 *
 * Every page paints three things at known points, so the raster says which
 * channel drew what:
 *   green bar  (100, 20)  — always drawn, not optional content
 *   blue square (100,100) — an UNREGISTERED layer, via `/OC /MC0 BDC`
 *   red square  (15, 180) — a REGISTERED layer, via a form XObject's `/OC`
 *
 * Run:  node scripts/make-m6-ocu-fixtures.mjs
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

/** Same hand-built form as Round 8: numbered objects, `startxref 0`. */
function doc(objects) {
    const nums = [...objects.keys()].sort((a, b) => a - b);
    let body = '%PDF-1.7\n';
    for (const n of nums) body += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
    body += `trailer\n<< /Size ${nums[nums.length - 1] + 1} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
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

const PAGE_PAINT = '0 1 0 rg 10 10 180 20 re f\n';
const CAD_PAINT = '0 0 1 rg 60 60 80 80 re f\n';
const MARK_PAINT = '1 0 0 rg 5 170 20 20 re f\n';
const CONTENT = `${PAGE_PAINT}/OC /MC0 BDC\n${CAD_PAINT}EMC\n/Fm0 Do\n`;

/**
 * pages: [{ cad: objNum|null, mark: objNum|null }] — which unregistered group the
 * page's `/Properties /MC0` names, and which registered group its form's `/OC`
 * names. `groups` are object numbers → names; `registered` lists the ones
 * `/OCGs` holds; `d` is the `/D` body.
 */
function layered({ pages, groups, registered, d }) {
    const objs = new Map();
    const kids = [];
    let next = 100;
    for (const p of pages) {
        const pageNum = next; const contentNum = next + 1; const formNum = next + 2;
        next += 3;
        kids.push(`${pageNum} 0 R`);
        const props = p.cad !== null ? `/Properties << /MC0 ${p.cad} 0 R >> ` : '';
        objs.set(pageNum, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
            + `/Resources << ${props}/XObject << /Fm0 ${formNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
        objs.set(contentNum, stream('<< >>', p.cad !== null ? CONTENT : `${PAGE_PAINT}/Fm0 Do\n`));
        const oc = p.mark !== null ? ` /OC ${p.mark} 0 R` : '';
        objs.set(formNum, stream(
            `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << >>${oc} >>`,
            MARK_PAINT,
        ));
    }
    for (const [num, name] of Object.entries(groups)) objs.set(Number(num), `<< /Type /OCG /Name (${name}) >>`);
    const ocgs = registered.map((n) => `${n} 0 R`).join(' ');
    objs.set(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${ocgs}] /D << ${d} >> >> >>`);
    objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`);
    return doc(objs);
}

const r = (...nums) => nums.map((n) => `${n} 0 R`).join(' ');
const as = (...nums) => ['View', 'Print', 'Export']
    .map((e) => `<< /Event /${e} /Category [/${e}] /OCGs [${r(...nums)}] >>`).join(' ');

// One page: an unregistered CAD layer beside a registered one. OC-U alone.
write('ocu-basic', layered({
    pages: [{ cad: 5, mark: 6 }],
    groups: { 5: 'WAKU', 6: 'Watermark' },
    registered: [6],
    d: `/ON [${r(6)}] /AS [${as(6)}]`,
}));

// The vol. 2 shape: two pages, each with its own CAD layer and its own
// registered layer, plus a registered layer no page uses. `/AS` names all three.
const VOL2 = {
    pages: [{ cad: 5, mark: 6 }, { cad: 9, mark: 8 }],
    groups: { 5: 'WAKU', 6: 'Watermark', 8: 'Watermark', 9: 'MOJI', 10: 'Watermark' },
    registered: [6, 8, 10],
};
write('ocu-vol2like', layered({ ...VOL2, d: `/ON [${r(6, 8, 10)}] /AS [${as(6, 8, 10)}]` }));
// The same, with page 1's registered layer switched OFF by default: the kept
// layer's initial state has to survive the `/AS` trim.
write('ocu-vol2like-off', layered({ ...VOL2, d: `/ON [${r(8, 10)}] /OFF [${r(6)}] /AS [${as(6, 8, 10)}]` }));

// ---- still refused --------------------------------------------------------
// An unregistered group that `/D` nevertheless gives a panel position.
write('ocu-unreg-in-order', layered({
    pages: [{ cad: 5, mark: 6 }], groups: { 5: 'WAKU', 6: 'Watermark' }, registered: [6],
    d: `/ON [${r(6)}] /Order [${r(6, 5)}]`,
}));
// An unregistered group an auto state acts on.
write('ocu-unreg-in-as', layered({
    pages: [{ cad: 5, mark: 6 }], groups: { 5: 'WAKU', 6: 'Watermark' }, registered: [6],
    d: `/ON [${r(6)}] /AS [${as(6, 5)}]`,
}));
// Page 1 keeps only an unregistered layer; its registered one is on page 2.
write('ocu-only-unregistered', layered({
    pages: [{ cad: 5, mark: null }, { cad: null, mark: 6 }],
    groups: { 5: 'WAKU', 6: 'Watermark' }, registered: [6],
    d: `/ON [${r(6)}]`,
}));
// `/Order` naming a registered group no kept page uses: OC-C2 is about `/AS`
// only, so this stays the refusal it was.
write('occ2-order-unused', layered({
    pages: [{ cad: null, mark: 6 }], groups: { 6: 'Watermark', 10: 'Watermark' }, registered: [6, 10],
    d: `/ON [${r(6, 10)}] /Order [${r(6, 10)}]`,
}));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}:`);
for (const name of written) console.log(`  ${name}.pdf`);
