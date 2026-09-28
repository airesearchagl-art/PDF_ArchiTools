/**
 * RF-02 synthetic members for the Comparison PDF feature surface: 2/3/4
 * members, reference pairs, MISSING_PAGE and GEOMETRY_MISMATCH notices, mixed
 * orientation and sheet size. Vector only (pdf-lib), no customer documents.
 *
 *            p1 A4 port   p2 A3 land   p3 A3 land        p4 A3 port   p5 A4 land
 *   A (ref)  base         base         base              base         base
 *   B        CHANGE       same         A4 land (geom!)   CHANGE       same
 *   C        same         CHANGE       same              same         (absent)
 *   D        CHANGE       CHANGE       same              same         CHANGE
 *
 * `EXPECTED` is the independent oracle the RF-02 check compares against.
 * Run: node research/m4-large-set-output-writer/corpus/make-rf02-corpus.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RF02_DIR = path.resolve(HERE, '..', 'out', 'rf02-corpus');

const A4 = [595.28, 841.89];
const A3 = [841.89, 1190.55];
const land = ([w, h]) => [h, w];
export const SHEETS = [A4, land(A3), land(A3), A3, land(A4)];
export const MEMBERS = ['A', 'B', 'C', 'D'];
// Per member, per page: 'same' | 'change' | 'geom' | 'absent'.
export const SPEC = {
    A: ['same', 'same', 'same', 'same', 'same'],
    B: ['change', 'same', 'geom', 'change', 'same'],
    C: ['same', 'change', 'same', 'same', 'absent'],
    D: ['change', 'change', 'same', 'same', 'change'],
};

/** The artifact's page sequence, derived from SPEC alone (never from the engine). */
export function expectedSequence(memberNames) {
    const seq = [];
    for (let p = 0; p < 5; p += 1) {
        const states = memberNames.map((m) => SPEC[m][p]);
        if (states.includes('absent')) { seq.push({ page: p + 1, kind: 'MISSING_PAGE' }); continue; }
        if (states.includes('geom')) { seq.push({ page: p + 1, kind: 'GEOMETRY_MISMATCH' }); continue; }
        memberNames.slice(1).forEach((m, i) => seq.push({
            page: p + 1, kind: 'PAIR', member: m, slot: i + 1,
            verdict: SPEC[m][p] === 'change' ? 'CHANGE' : 'MATCH',
        }));
    }
    return seq;
}

function draw(page, font, [w, h], n, changed) {
    const ink = rgb(0, 0, 0);
    page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: ink, borderWidth: 1.2 });
    const cols = 6;
    const rows = 5;
    for (let i = 0; i <= cols; i += 1) {
        const x = 60 + ((w - 160) * i) / cols;
        page.drawLine({ start: { x, y: 60 }, end: { x, y: h - 60 }, thickness: 0.9, color: ink });
    }
    for (let j = 0; j <= rows; j += 1) {
        const y = 60 + ((h - 120) * j) / rows;
        page.drawLine({ start: { x: 60, y }, end: { x: w - 100, y }, thickness: 0.9, color: ink });
    }
    page.drawText(`SHEET ${n}  ROOM SCHEDULE / PLAN`, { x: 64, y: h - 48, size: 10, font, color: ink });
    for (let k = 0; k < 12; k += 1) {
        page.drawText(`${n}-${k + 1}  W=${900 + k * 150}  H=2100`, { x: w - 96, y: h - 90 - k * 14, size: 5, font, color: ink });
    }
    if (changed) {
        page.drawLine({ start: { x: 60 + (w - 160) * 0.5 + 9, y: 80 }, end: { x: 60 + (w - 160) * 0.5 + 9, y: h * 0.6 }, thickness: 0.9, color: ink });
        page.drawText('REV 2', { x: w * 0.3, y: h * 0.3, size: 7, font, color: ink });
    }
}

export async function makeRf02Corpus() {
    fs.mkdirSync(RF02_DIR, { recursive: true });
    const out = {};
    for (const m of MEMBERS) {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        SPEC[m].forEach((state, i) => {
            if (state === 'absent') return;
            const size = state === 'geom' ? land(A4) : SHEETS[i];
            draw(doc.addPage(size), font, size, i + 1, state === 'change');
        });
        doc.setCreationDate(new Date(0));
        doc.setModificationDate(new Date(0));
        const file = path.join(RF02_DIR, `rf02-${m}.pdf`);
        fs.writeFileSync(file, await doc.save());
        out[m] = file;
    }
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    console.log(await makeRf02Corpus());
}
