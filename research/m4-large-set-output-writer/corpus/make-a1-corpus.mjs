/**
 * Synthetic A1 architectural corpus for the Output Writer research.
 *
 * Two 5-page sets (A = reference, B = revised), vector only, generated from
 * seeded SVG and printed to PDF by the pinned puppeteer Chrome so that small
 * Japanese text is embedded as real glyphs. No customer or real-project
 * document is used; outputs go to research/m4-large-set-output-writer/out/ (ignored).
 *
 *   p1  A1 landscape  plan, identical in A and B            -> MATCH expected
 *   p2  A1 landscape  plan with true changes + cloud/triangle -> CHANGE
 *   p3  A1 landscape  dense plan (hatching, furniture), one small change -> CHANGE
 *   p4  A1 portrait   dense quantity schedule, identical     -> MATCH
 *   p5  A1 portrait   quantity schedule, digits + a rule changed -> CHANGE
 *
 * Run: node research/m4-large-set-output-writer/corpus/make-a1-corpus.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'out', 'corpus');
fs.mkdirSync(OUT, { recursive: true });

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const W_THIN = 0.13;
const W_MED = 0.25;
const W_THICK = 0.5;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const line = (x1, y1, x2, y2, w = W_THIN, c = '#000') =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${c}" stroke-width="${w}"/>`;
const rect = (x, y, w, h, sw = W_THIN, c = '#000') =>
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
const text = (x, y, s, size = 2.5, anchor = 'start') =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${size}" text-anchor="${anchor}" font-family="'Yu Gothic','Meiryo','MS Gothic',sans-serif">${esc(s)}</text>`;

const ROOMS = ['居室', '寝室', '洋室', '和室', '廊下', '便所', '浴室', '洗面所', '台所', '収納', '玄関', '階段', 'ホール', '倉庫', '事務室', '会議室'];

function frame(w, h, title, sheetNo, rev) {
    const parts = [rect(10, 10, w - 20, h - 20, W_THICK)];
    const tbw = 180;
    const tbh = 60;
    const tx = w - 10 - tbw;
    const ty = h - 10 - tbh;
    parts.push(rect(tx, ty, tbw, tbh, W_MED));
    for (let i = 1; i < 6; i += 1) parts.push(line(tx, ty + i * 10, tx + tbw, ty + i * 10));
    parts.push(line(tx + 50, ty, tx + 50, ty + tbh));
    const rows = [
        ['工事名称', '(仮称) 合成試験棟 新築工事'],
        ['図面名称', title],
        ['図面番号', sheetNo],
        ['縮尺', '1/100 (A1)'],
        ['改訂', rev],
        ['作成', 'PDF ArchiTools research corpus'],
    ];
    rows.forEach(([k, v], i) => {
        parts.push(text(tx + 3, ty + i * 10 + 6.5, k, 3.2));
        parts.push(text(tx + 53, ty + i * 10 + 6.5, v, 3.2));
    });
    return parts;
}

function door(x, y, r, flip) {
    const s = flip ? -1 : 1;
    return [
        line(x, y, x + s * r, y, W_MED),
        `<path d="M ${(x + s * r).toFixed(2)} ${y.toFixed(2)} A ${r} ${r} 0 0 ${flip ? 0 : 1} ${x.toFixed(2)} ${(y + r).toFixed(2)}" fill="none" stroke="#000" stroke-width="${W_THIN}"/>`,
    ];
}

function hatch(x, y, w, h, gap) {
    const out = [];
    for (let d = -h; d < w; d += gap) {
        const x1 = Math.max(x, x + d);
        const y1 = y + Math.max(0, -d);
        const len = Math.min(w - Math.max(0, d), h - Math.max(0, -d));
        if (len <= 0) continue;
        out.push(line(x1, y1 + len, x1 + len, y1, 0.1));
    }
    return out;
}

function dimension(x1, y, x2, label) {
    return [
        line(x1, y, x2, y, 0.1),
        line(x1, y - 2, x1, y + 2, 0.1),
        line(x2, y - 2, x2, y + 2, 0.1),
        text((x1 + x2) / 2, y - 1.2, label, 2.2, 'middle'),
    ];
}

function cloud(cx, cy, rx, ry) {
    const n = 18;
    let d = '';
    for (let i = 0; i < n; i += 1) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        const p0 = [cx + rx * Math.cos(a0), cy + ry * Math.sin(a0)];
        const p1 = [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)];
        if (i === 0) d += `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} `;
        d += `A 4 4 0 0 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)} `;
    }
    return `<path d="${d}" fill="none" stroke="#000" stroke-width="${W_MED}"/>`;
}

const triangle = (x, y, label) => [
    `<path d="M ${x} ${y - 5} L ${x + 5} ${y + 3.5} L ${x - 5} ${y + 3.5} Z" fill="none" stroke="#000" stroke-width="${W_MED}"/>`,
    text(x, y + 2.2, label, 3, 'middle'),
];

/** A floor plan on a bay grid. `mods` selects the revised variant's edits. */
function plan(seed, { dense = false, mods = {} } = {}) {
    const W = 841;
    const H = 594;
    const r = rng(seed);
    const p = frame(W, H, dense ? '詳細平面図 (家具・仕上)' : '1階平面図', dense ? 'A-103' : (mods.rev ? 'A-102' : 'A-101'), mods.rev ? 'B' : 'A');
    const cols = dense ? 14 : 10;
    const rows = dense ? 8 : 6;
    const x0 = 60;
    const y0 = 50;
    const bw = (W - 300) / cols;
    const bh = (H - 140) / rows;
    // Grid lines and labels.
    for (let i = 0; i <= cols; i += 1) {
        p.push(`<line x1="${x0 + i * bw}" y1="${y0 - 25}" x2="${x0 + i * bw}" y2="${y0 + rows * bh + 10}" stroke="#000" stroke-width="0.1" stroke-dasharray="6 1.5 1 1.5"/>`);
        p.push(text(x0 + i * bw, y0 - 28, `X${i + 1}`, 3.5, 'middle'));
    }
    for (let j = 0; j <= rows; j += 1) {
        p.push(`<line x1="${x0 - 25}" y1="${y0 + j * bh}" x2="${x0 + cols * bw + 10}" y2="${y0 + j * bh}" stroke="#000" stroke-width="0.1" stroke-dasharray="6 1.5 1 1.5"/>`);
        p.push(text(x0 - 30, y0 + j * bh + 1.2, `Y${j + 1}`, 3.5, 'middle'));
    }
    // Dimension strings.
    for (let i = 0; i < cols; i += 1) {
        const mm = 6000 + Math.round(r() * 6) * 300;
        const label = (mods.dimChange && i === 3) ? String(mm + 100) : String(mm);
        p.push(...dimension(x0 + i * bw, y0 - 12, x0 + (i + 1) * bw, label));
    }
    // Rooms: walls, doors, names, areas.
    for (let j = 0; j < rows; j += 1) {
        for (let i = 0; i < cols; i += 1) {
            const x = x0 + i * bw;
            const y = y0 + j * bh;
            const moved = mods.moveWall && i === 2 && j === 1 ? 6 : 0;
            p.push(line(x + moved, y, x + moved, y + bh, W_THICK));
            p.push(line(x + moved + 1.2, y, x + moved + 1.2, y + bh, W_THICK));
            p.push(line(x, y, x + bw, y, W_THICK));
            p.push(line(x, y + 1.2, x + bw, y + 1.2, W_THICK));
            if (r() < 0.7) p.push(...door(x + bw * 0.3, y + 1.2, Math.min(9, bw * 0.25), r() < 0.5));
            if (mods.addDoor && i === 5 && j === 3) p.push(...door(x + bw * 0.7, y + 1.2, 8, false));
            const name = ROOMS[Math.floor(r() * ROOMS.length)];
            p.push(text(x + bw / 2, y + bh / 2, name, 3, 'middle'));
            const area = (bw * bh / 100 * (0.9 + r() * 0.2)).toFixed(2);
            p.push(text(x + bw / 2, y + bh / 2 + 4.5, `${area}㎡`, 2.2, 'middle'));
            if (dense) {
                if (r() < 0.35) p.push(...hatch(x + 4, y + 4, bw * 0.35, bh * 0.3, 1.0));
                for (let k = 0; k < 4; k += 1) {
                    const fx = x + 5 + r() * (bw - 20);
                    const fy = y + 8 + r() * (bh - 20);
                    p.push(rect(fx, fy, 6 + r() * 8, 4 + r() * 6, W_THIN));
                }
                p.push(text(x + 3, y + bh - 3, `FL±0 / CH${2400 + Math.round(r() * 4) * 50}`, 1.8));
            }
        }
    }
    p.push(line(x0 + cols * bw, y0, x0 + cols * bw, y0 + rows * bh, W_THICK));
    p.push(line(x0, y0 + rows * bh, x0 + cols * bw, y0 + rows * bh, W_THICK));
    // Notes block.
    for (let k = 0; k < 18; k += 1) {
        p.push(text(W - 185, 30 + k * 5, `${k + 1}. 特記なき限り寸法は躯体芯押えとする。仕上は別途仕上表による。`, 2.2));
    }
    if (mods.cloud) {
        const cx = x0 + 2.5 * bw;
        const cy = y0 + 1.5 * bh;
        p.push(cloud(cx, cy, bw * 0.8, bh * 0.7));
        p.push(...triangle(cx + bw * 0.85, cy - bh * 0.7, '1'));
    }
    if (mods.denseSmall) {
        p.push(text(x0 + 7.5 * bw, y0 + 4.5 * bh + 9, '※PS', 1.8, 'middle'));
    }
    return { w: W, h: H, body: p.join('\n') };
}

/** A quantity schedule. `mods.changed` edits digits and one rule. */
function schedule(seed, { mods = {} } = {}) {
    const W = 594;
    const H = 841;
    const r = rng(seed);
    const p = frame(W, H, mods.title ?? '数量内訳書', mods.sheet ?? 'Q-201', mods.rev ? 'B' : 'A');
    const cols = [
        ['No.', 12], ['名称', 70], ['規格・仕様', 110], ['数量', 30], ['単位', 18], ['単価', 40], ['金額', 50], ['備考', 50],
    ];
    const x0 = 30;
    const y0 = 40;
    const rowH = 6.2;
    const rows = 110;
    const widths = cols.map(([, w]) => w);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = x0;
    p.push(rect(x0, y0, total, rowH * (rows + 1), W_MED));
    for (const [name, w] of cols) {
        p.push(text(x + w / 2, y0 + 4.3, name, 2.6, 'middle'));
        x += w;
        p.push(line(x, y0, x, y0 + rowH * (rows + 1), W_THIN));
    }
    const items = ['普通コンクリート', '異形鉄筋 SD345', '型枠 合板', '鉄骨 SN490B', '高力ボルト', '押出成形セメント板', '石膏ボード 12.5', '軽量鉄骨下地', 'ビニル床シート', '長尺塩ビシート', '外部建具 AW', '内部建具 WD', '防水 ウレタン塗膜', '断熱材 吹付'];
    const specs = ['Fc24 S18', 'D13〜D25', '打放し B種', 'H-400×200', 'M20 F10T', 't=60', 'GB-R', '@303 65形', 't=2.0', 't=2.5', 'W1800×H2000', 'W900×H2100', 'X-2 t=3', 'A種1 t=30'];
    for (let i = 0; i < rows; i += 1) {
        const y = y0 + rowH * (i + 1);
        const bold = mods.changedRule && i === 60;
        p.push(line(x0, y, x0 + total, y, bold ? W_THICK : 0.1));
        const k = Math.floor(r() * items.length);
        let qty = (r() * 900 + 10).toFixed(1);
        const unit = ['m3', 't', 'm2', '本', '箇所', '式'][Math.floor(r() * 6)];
        const price = Math.round(r() * 90000 + 1000);
        if (mods.changed && (i === 7 || i === 33 || i === 81)) qty = (Number(qty) + 12.5).toFixed(1);
        const cells = [String(i + 1), items[k], specs[k], qty, unit, price.toLocaleString('en-US'), Math.round(Number(qty) * price).toLocaleString('en-US'), r() < 0.2 ? '別途' : ''];
        let cx = x0;
        cells.forEach((c, ci) => {
            const w = widths[ci];
            const numeric = ci === 0 || ci === 3 || ci === 5 || ci === 6;
            p.push(text(numeric ? cx + w - 1.5 : cx + 1.5, y + 4.4, c, 2.4, numeric ? 'end' : 'start'));
            cx += w;
        });
    }
    return { w: W, h: H, body: p.join('\n') };
}

function sheets(variant) {
    const b = variant === 'B';
    return [
        plan(101),
        plan(202, { mods: b ? { rev: true, moveWall: true, addDoor: true, cloud: true, dimChange: true } : {} }),
        plan(303, { dense: true, mods: b ? { denseSmall: true } : {} }),
        schedule(404),
        schedule(505, { mods: b ? { rev: true, changed: true, changedRule: true, sheet: 'Q-202' } : { sheet: 'Q-202' } }),
    ];
}

function html(s) {
    const css = `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }
      html, body { margin: 0; padding: 0; } svg { display: block; }`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>`
        + `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}mm" height="${s.h}mm" viewBox="0 0 ${s.w} ${s.h}">${s.body}</svg></body></html>`;
}

// One print per sheet at an explicit size, then one document: Chrome's named
// @page support does not survive page.pdf().
const browser = await puppeteer.launch({ headless: true });
try {
    const page = await browser.newPage();
    for (const variant of ['A', 'B']) {
        const doc = await PDFDocument.create();
        for (const s of sheets(variant)) {
            await page.setContent(html(s), { waitUntil: 'load' });
            await page.evaluate(() => document.fonts.ready);
            const one = await PDFDocument.load(await page.pdf({
                width: `${s.w}mm`, height: `${s.h}mm`, printBackground: true, pageRanges: '1',
            }));
            const [copied] = await doc.copyPages(one, [0]);
            doc.addPage(copied);
        }
        doc.setCreationDate(new Date(0));
        doc.setModificationDate(new Date(0));
        const bytes = await doc.save();
        const file = path.join(OUT, `a1-set-${variant}.pdf`);
        fs.writeFileSync(file, bytes);
        console.log(`${path.relative(process.cwd(), file)}  ${bytes.length} bytes, `
            + doc.getPages().map((p) => `${p.getWidth().toFixed(2)}x${p.getHeight().toFixed(2)}`).join(' '));
    }
} finally {
    await browser.close();
}
