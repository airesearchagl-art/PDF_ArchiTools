/**
 * Research prototype of an image-aware PDF optimizer. Not production code.
 *
 * Parse with pdf-lib, walk every indirect object, and for each Image XObject
 * decide one of:
 *
 *   LEAVE     the stream is kept byte for byte (DCT, JPX, JBIG2, CCITT, LZW,
 *             RunLength, Crypt, anything this module cannot decode exactly)
 *   R1        samples kept exactly; only the stream encoding changes:
 *             decode the filter chain, re-encode Flate (+ PNG predictor).
 *             ColorSpace / BitsPerComponent / Decode / Mask / ImageMask /
 *             SMask / Interpolate are untouched, so this is lossless for any
 *             colour space.
 *   R2        the sample *representation* changes, only when it is provably
 *             exact: DeviceRGB or ICCBased(N=3) 8-bit -> Indexed over the same
 *             base (<=256 colours); DeviceRGB 8-bit with R=G=B -> DeviceGray;
 *             DeviceGray 8-bit -> 1/2/4-bit when every value is representable;
 *             never with a /Decode array, a colour-key /Mask, or /ImageMask.
 *   LOSSY     opt-in only: DCT (q) and/or downsampling; never by default.
 *
 * The chosen encoding is kept only when it is smaller than the original
 * stream. Everything else in the document is left as pdf-lib parsed it.
 *
 * Writers:
 *   'pdflib'   doc.save({ useObjectStreams: true })   (whole-file Uint8Array)
 *   'chunked'  every object serialised on its own into a chunk list with a
 *              classic xref table; raw stream contents are appended as views
 *              (no whole-file buffer; publish as new Blob(chunks)).
 */
import zlib from 'node:zlib';
import pako from 'pako';
import {
    PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRawStream, PDFRef, PDFBool,
    PDFHexString, PDFString, PDFStream,
} from 'pdf-lib';

// ------------------------------------------------------------------ helpers
const N = (s) => PDFName.of(s);
const nameOf = (v) => (v instanceof PDFName ? v.asString().slice(1) : null);

function resolve(ctx, v) { return v instanceof PDFRef ? ctx.lookup(v) : v; }

function filtersOf(ctx, dict) {
    const f = resolve(ctx, dict.get(N('Filter')));
    if (!f) return [];
    if (f instanceof PDFName) return [nameOf(f)];
    if (f instanceof PDFArray) return f.asArray().map((x) => nameOf(resolve(ctx, x)));
    return ['?'];
}
function parmsOf(ctx, dict, i) {
    const p = resolve(ctx, dict.get(N('DecodeParms')) ?? dict.get(N('DP')));
    if (!p) return null;
    if (p instanceof PDFDict) return i === 0 ? p : null;
    if (p instanceof PDFArray) { const e = resolve(ctx, p.get(i)); return e instanceof PDFDict ? e : null; }
    return null;
}
const numberIn = (ctx, d, k, dflt) => {
    const v = d ? resolve(ctx, d.get(N(k))) : undefined;
    return v instanceof PDFNumber ? v.asNumber() : dflt;
};

/** Undo a PNG (10-15) or TIFF (2) predictor. */
function unpredict(data, predictor, colors, bpc, columns) {
    if (!predictor || predictor === 1) return data;
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowBytes = Math.ceil((colors * bpc * columns) / 8);
    if (predictor === 2) {
        if (bpc !== 8) throw new Error('TIFF predictor with bpc != 8');
        const out = Buffer.from(data);
        for (let r = 0; r < out.length; r += rowBytes) for (let i = colors; i < rowBytes; i += 1) out[r + i] = (out[r + i] + out[r + i - colors]) & 0xFF;
        return out;
    }
    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = Buffer.alloc(rows * rowBytes);
    for (let r = 0; r < rows; r += 1) {
        const type = data[r * (rowBytes + 1)];
        const src = r * (rowBytes + 1) + 1;
        const dst = r * rowBytes;
        for (let i = 0; i < rowBytes; i += 1) {
            const a = i >= bpp ? out[dst + i - bpp] : 0;
            const b = r > 0 ? out[dst - rowBytes + i] : 0;
            const c = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
            let v = data[src + i];
            if (type === 1) v += a; else if (type === 2) v += b; else if (type === 3) v += (a + b) >> 1;
            else if (type === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } else if (type !== 0) throw new Error(`PNG filter ${type}`);
            out[dst + i] = v & 0xFF;
        }
    }
    return out;
}

function asciiHexDecode(buf) {
    const s = buf.toString('latin1').replace(/\s+/g, '');
    const end = s.indexOf('>');
    const hex = end >= 0 ? s.slice(0, end) : s;
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
}

const DECODABLE = new Set(['FlateDecode', 'ASCIIHexDecode']);

/** Decoded samples of an image stream, or null when the chain is not exactly decodable here. */
function decodeSamples(ctx, stream, comps, bpc, width) {
    const filters = filtersOf(ctx, stream.dict);
    if (!filters.every((f) => DECODABLE.has(f))) return null;
    let data = Buffer.from(stream.contents.buffer, stream.contents.byteOffset, stream.contents.length);
    filters.forEach((f, i) => {
        if (f === 'ASCIIHexDecode') data = asciiHexDecode(data);
        else if (f === 'FlateDecode') {
            data = zlib.inflateSync(data);
            const p = parmsOf(ctx, stream.dict, i);
            if (p) data = unpredict(data, numberIn(ctx, p, 'Predictor', 1), numberIn(ctx, p, 'Colors', 1), numberIn(ctx, p, 'BitsPerComponent', 8), numberIn(ctx, p, 'Columns', 1));
        }
    });
    return data;
}

// --------------------------------------------------------------- encoders
function filterRow(type, row, prev, bpp, out) {
    out[0] = type;
    for (let i = 0; i < row.length; i += 1) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (type) {
            case 0: v = row[i]; break;
            case 1: v = row[i] - a; break;
            case 2: v = row[i] - b; break;
            case 3: v = row[i] - ((a + b) >> 1); break;
            default: { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v = row[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        }
        out[i + 1] = v & 0xFF;
    }
}
/** PNG-predicted rows (adaptive or fixed), as one buffer. */
function predicted(samples, rowBytes, bpp, mode) {
    const rows = samples.length / rowBytes;
    const out = Buffer.alloc(rows * (rowBytes + 1));
    const scratch = Buffer.alloc(rowBytes + 1);
    const best = Buffer.alloc(rowBytes + 1);
    for (let r = 0; r < rows; r += 1) {
        const row = samples.subarray(r * rowBytes, (r + 1) * rowBytes);
        const prev = r ? samples.subarray((r - 1) * rowBytes, r * rowBytes) : null;
        if (mode === 'adaptive') {
            let bestSum = Infinity;
            for (let t = 0; t <= 4; t += 1) {
                filterRow(t, row, prev, bpp, scratch);
                let s = 0;
                for (let i = 1; i < scratch.length && s < bestSum; i += 1) { const v = scratch[i]; s += v < 128 ? v : 256 - v; }
                if (s < bestSum) { bestSum = s; scratch.copy(best); }
            }
            best.copy(out, r * (rowBytes + 1));
        } else {
            filterRow(mode, row, prev, bpp, out.subarray(r * (rowBytes + 1), (r + 1) * (rowBytes + 1)));
        }
    }
    return out;
}

/** Compress with the requested backend. 'zlib9' = node zlib level 9; 'owned' = production OwnedZlib. */
function compress(buf, backend, rowDistance, owned) {
    if (backend === 'owned') {
        const chunks = [];
        const z = new owned.OwnedZlib(Math.max(1, rowDistance), (c) => chunks.push(Buffer.from(c)));
        z.push(buf);
        z.finish();
        return Buffer.concat(chunks);
    }
    if (backend === 'pako9') return Buffer.from(pako.deflate(buf, { level: 9 }));
    return zlib.deflateSync(buf, { level: backend === 'zlib6' ? 6 : 9 });
}

/** Best lossless Flate encoding of `samples` (rows of rowBytes), trying predictors. */
function flateBest(samples, rowBytes, bpp, colors, bpc, columns, backend, owned, fast = false) {
    const tries = [];
    // fast: one predictor per sample depth (adaptive for 8-bit, Up below).
    const modes = fast ? [bpc >= 8 ? 'adaptive' : 2] : ['none', 2, 'adaptive'];
    for (const mode of modes) {
        const body = mode === 'none' ? samples : predicted(samples, rowBytes, bpp, mode);
        const data = compress(body, backend, mode === 'none' ? rowBytes : rowBytes + 1, owned);
        tries.push({ mode, data });
    }
    tries.sort((a, b) => a.data.length - b.data.length);
    const t = tries[0];
    const parms = t.mode === 'none' ? null : { Predictor: 15, Colors: colors, BitsPerComponent: bpc, Columns: columns };
    return { data: t.data, parms, predictor: t.mode };
}

// ------------------------------------------------------------- analysis
function colourSpaceInfo(ctx, cs) {
    const v = resolve(ctx, cs);
    if (v instanceof PDFName) {
        const n = nameOf(v);
        return { kind: n, comps: { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 }[n] ?? null };
    }
    if (v instanceof PDFArray) {
        const head = nameOf(resolve(ctx, v.get(0)));
        if (head === 'ICCBased') {
            const s = resolve(ctx, v.get(1));
            return { kind: 'ICCBased', comps: numberIn(ctx, s?.dict, 'N', null) };
        }
        if (head === 'Indexed') return { kind: 'Indexed', comps: 1 };
        return { kind: head, comps: null };
    }
    return { kind: '?', comps: null };
}

/** Exact representation candidates for 8-bit samples. */
function exactForms(samples, comps, width, height) {
    const out = [];
    if (comps === 3) {
        const colours = new Map();
        let gray = true;
        for (let i = 0; i < samples.length; i += 3) {
            const r = samples[i]; const g = samples[i + 1]; const b = samples[i + 2];
            if (gray && (r !== g || g !== b)) gray = false;
            if (colours.size <= 256) {
                const k = (r << 16) | (g << 8) | b;
                if (!colours.has(k)) colours.set(k, colours.size);
            }
            if (!gray && colours.size > 256) break;
        }
        if (colours.size <= 256) {
            const n = colours.size;
            const bpc = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
            const perByte = 8 / bpc;
            const rowBytes = Math.ceil(width / perByte);
            const idx = Buffer.alloc(rowBytes * height);
            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    const i = (y * width + x) * 3;
                    const v = colours.get((samples[i] << 16) | (samples[i + 1] << 8) | samples[i + 2]);
                    idx[y * rowBytes + Math.floor(x / perByte)] |= v << (8 - bpc * ((x % perByte) + 1));
                }
            }
            const palette = Buffer.alloc(n * 3);
            for (const [k, i] of colours) { palette[i * 3] = k >> 16; palette[i * 3 + 1] = (k >> 8) & 0xFF; palette[i * 3 + 2] = k & 0xFF; }
            out.push({ form: `Indexed ${bpc}-bit (${n} colours)`, kind: 'indexed', bpc, samples: idx, rowBytes, palette, colors: 1 });
        }
        if (gray) {
            const g = Buffer.alloc(width * height);
            for (let p = 0, q = 0; p < samples.length; p += 3, q += 1) g[q] = samples[p];
            out.push(...grayForms(g, width, height));
        }
    } else if (comps === 1) {
        out.push(...grayForms(samples, width, height).filter((f) => f.bpc < 8));
    }
    return out;
}
function grayForms(g, width, height) {
    const out = [{ form: 'DeviceGray 8-bit', kind: 'gray', bpc: 8, samples: g, rowBytes: width, colors: 1 }];
    for (const bpc of [1, 2, 4]) {
        const levels = (1 << bpc) - 1;
        const step = 255 / levels;
        let ok = true;
        for (let i = 0; i < g.length && ok; i += 1) { const v = g[i] / step; if (Math.abs(v - Math.round(v)) > 1e-9) ok = false; }
        if (!ok) continue;
        const perByte = 8 / bpc;
        const rowBytes = Math.ceil(width / perByte);
        const s = Buffer.alloc(rowBytes * height);
        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) s[y * rowBytes + Math.floor(x / perByte)] |= Math.round(g[y * width + x] / step) << (8 - bpc * ((x % perByte) + 1));
        out.push({ form: `DeviceGray ${bpc}-bit`, kind: 'gray', bpc, samples: s, rowBytes, colors: 1 });
        break;
    }
    return out;
}

// --------------------------------------------------------------- the pass
export function censusAndPlan(doc) {
    const ctx = doc.context;
    const images = [];
    const pageUse = new Map();
    const walkResources = (res, where, seen = new Set()) => {
        const r = resolve(ctx, res);
        if (!(r instanceof PDFDict)) return;
        const xo = resolve(ctx, r.get(N('XObject')));
        if (!(xo instanceof PDFDict)) return;
        for (const [, v] of xo.entries()) {
            if (!(v instanceof PDFRef)) continue;
            const key = v.toString();
            const list = pageUse.get(key) ?? [];
            list.push(where);
            pageUse.set(key, list);
            const obj = ctx.lookup(v);
            if (obj instanceof PDFRawStream && nameOf(obj.dict.get(N('Subtype'))) === 'Form' && !seen.has(key)) {
                seen.add(key);
                walkResources(obj.dict.get(N('Resources')), `${where} > Form ${key}`, seen);
            }
        }
    };
    doc.getPages().forEach((p, i) => walkResources(p.node.Resources(), `p${i + 1}`));
    const smaskOf = new Set();
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream && nameOf(obj.dict.get(N('Subtype'))) === 'Image') {
            const s = obj.dict.get(N('SMask'));
            if (s instanceof PDFRef) smaskOf.add(s.toString());
        }
    }
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue;
        const d = obj.dict;
        if (nameOf(d.get(N('Subtype'))) !== 'Image') continue;
        const width = numberIn(ctx, d, 'Width', 0);
        const height = numberIn(ctx, d, 'Height', 0);
        const imageMask = resolve(ctx, d.get(N('ImageMask'))) === PDFBool.True;
        const bpc = imageMask ? 1 : numberIn(ctx, d, 'BitsPerComponent', 8);
        const cs = imageMask ? { kind: 'ImageMask', comps: 1 } : colourSpaceInfo(ctx, d.get(N('ColorSpace')));
        const filters = filtersOf(ctx, d);
        const hasDecode = d.get(N('Decode')) !== undefined;
        const mask = resolve(ctx, d.get(N('Mask')));
        const colourKey = mask instanceof PDFArray;
        const rec = {
            ref: ref.toString(), width, height, bpc, colourSpace: cs.kind, comps: cs.comps, filters,
            streamBytes: obj.contents.length, decodeArray: hasDecode, colourKeyMask: colourKey,
            stencilMask: mask instanceof PDFRawStream || mask instanceof PDFRef, imageMask,
            smask: d.get(N('SMask')) !== undefined, isSMask: smaskOf.has(ref.toString()),
            interpolate: d.get(N('Interpolate')) !== undefined,
            usedBy: pageUse.get(ref.toString()) ?? (smaskOf.has(ref.toString()) ? ['(SMask)'] : []),
        };
        const exotic = filters.find((f) => !DECODABLE.has(f));
        if (exotic) rec.decision = { class: 'LEAVE', why: `${exotic} is kept as is (not decoded here)` };
        else if (!cs.comps && !imageMask) rec.decision = { class: 'LEAVE', why: `colour space ${cs.kind} with unknown component count` };
        else {
            const r2Blocked = imageMask ? 'ImageMask' : hasDecode ? '/Decode array' : colourKey ? 'colour-key /Mask' : bpc !== 8 ? `${bpc}-bit` : !['DeviceRGB', 'DeviceGray', 'ICCBased'].includes(cs.kind) ? cs.kind : null;
            rec.decision = { class: r2Blocked ? 'R1' : 'R1+R2', why: r2Blocked ? `samples kept exactly (${r2Blocked} forbids a representation change)` : 'samples kept; exact Indexed/Gray/bit-depth forms tried' };
        }
        images.push({ rec, ref, obj });
    }
    return images;
}

export async function optimize(bytes, opts = {}) {
    const { backend = 'zlib9', writer = 'pdflib', lossy = null, owned = null, minGain = 0, r1Only = false, noImages = false, fast = false } = opts;
    const t0 = performance.now();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const images = censusAndPlan(doc);
    const report = [];
    for (const { rec, ref, obj } of images) {
        const out = { ...rec, before: rec.streamBytes, after: rec.streamBytes, chosen: 'unchanged' };
        report.push(out);
        if (rec.decision.class === 'LEAVE' || noImages) continue;
        const comps = rec.comps ?? 1;
        let samples;
        try { samples = decodeSamples(ctx, obj, comps, rec.bpc, rec.width); } catch (e) { out.chosen = `unchanged (decode failed: ${e.message})`; continue; }
        if (!samples) continue;
        const rowBytes = Math.ceil((comps * rec.bpc * rec.width) / 8);
        if (samples.length < rowBytes * rec.height) { out.chosen = 'unchanged (short data)'; continue; }
        samples = samples.subarray(0, rowBytes * rec.height);
        const candidates = [];
        // R1: same samples, better encoding.
        const r1 = flateBest(samples, rowBytes, Math.max(1, Math.ceil((comps * rec.bpc) / 8)), comps, rec.bpc, rec.width, backend, owned, fast);
        candidates.push({ label: `R1 Flate (${r1.predictor})`, data: r1.data, dict: { Filter: 'FlateDecode', DecodeParms: r1.parms } });
        // R2: exact representation change.
        if (rec.decision.class === 'R1+R2' && !r1Only) {
            for (const f of exactForms(samples, comps, rec.width, rec.height)) {
                const e = flateBest(f.samples, f.rowBytes, 1, 1, f.bpc, rec.width, backend, owned, fast);
                let cs;
                if (f.kind === 'indexed') {
                    const base = rec.colourSpace === 'ICCBased' ? obj.dict.get(N('ColorSpace')) : N('DeviceRGB');
                    cs = ctx.obj([N('Indexed'), rec.colourSpace === 'ICCBased' ? resolve(ctx, base) : base, f.palette.length / 3 - 1, PDFHexString.of(f.palette.toString('hex'))]);
                } else {
                    // RGB -> Gray is only exact for device colour; an ICC space keeps its profile.
                    if (rec.colourSpace === 'ICCBased' && comps === 3) continue;
                    cs = N('DeviceGray');
                }
                candidates.push({ label: `R2 ${f.form} (${e.predictor})`, data: e.data, dict: { Filter: 'FlateDecode', DecodeParms: e.parms, ColorSpace: cs, BitsPerComponent: f.bpc } });
            }
        }
        // LOSSY (opt-in): DCT of 8-bit RGB/Gray device images without Decode/colour-key/SMask semantics issues.
        if (lossy && rec.bpc === 8 && !rec.decodeArray && !rec.colourKeyMask && !rec.imageMask && ['DeviceRGB', 'DeviceGray'].includes(rec.colourSpace) && !rec.isSMask) {
            const jpg = await lossy.encode(samples, comps, rec.width, rec.height);
            if (jpg) candidates.push({ label: `LOSSY ${jpg.label}`, data: jpg.data, dict: { Filter: 'DCTDecode', DecodeParms: null, Width: jpg.width, Height: jpg.height }, lossy: true });
        }
        candidates.sort((a, b) => a.data.length - b.data.length);
        const best = candidates[0];
        if (best.data.length + minGain >= rec.streamBytes) continue;
        const dict = obj.dict.clone(ctx);
        dict.delete(N('DecodeParms'));
        dict.delete(N('DP'));
        for (const [k, v] of Object.entries(best.dict)) {
            if (v === null || v === undefined) continue;
            dict.set(N(k), typeof v === 'string' ? N(v) : v instanceof Object && !(v.constructor?.name?.startsWith('PDF')) ? ctx.obj(v) : (typeof v === 'number' ? PDFNumber.of(v) : v));
        }
        if (best.dict.Filter === 'FlateDecode' && !best.dict.DecodeParms) dict.delete(N('DecodeParms'));
        dict.set(N('Length'), PDFNumber.of(best.data.length));
        ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(best.data.buffer, best.data.byteOffset, best.data.length)));
        out.after = best.data.length;
        out.chosen = best.label;
        out.lossy = !!best.lossy;
    }
    const t1 = performance.now();
    let chunks;
    let total;
    if (writer === 'pdflib') {
        const saved = await doc.save({ useObjectStreams: true });
        chunks = [saved];
        total = saved.length;
    } else {
        ({ chunks, total } = writeChunked(doc));
    }
    const t2 = performance.now();
    return { chunks, total, report, ms: { analyse: Math.round(t1 - t0), write: Math.round(t2 - t1) } };
}

/**
 * The chunked writer: each indirect object serialised on its own; raw stream
 * contents appended as the views pdf-lib already holds; classic xref.
 */
export function writeChunked(doc) {
    const ctx = doc.context;
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const push = (b) => { chunks.push(b); offset += b.length; };
    push(enc.encode('%PDF-1.7\n%âãÏÓ\n'));
    const offsets = [];
    const objects = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber);
    let maxNum = 0;
    for (const [ref, obj] of objects) {
        maxNum = Math.max(maxNum, ref.objectNumber);
        offsets.push([ref.objectNumber, ref.generationNumber, offset]);
        push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
        if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
            const contents = obj instanceof PDFRawStream ? obj.contents : obj.getContents();
            const dict = obj.dict;
            dict.set(N('Length'), PDFNumber.of(contents.length));
            const head = new Uint8Array(dict.sizeInBytes());
            dict.copyBytesInto(head, 0);
            push(head);
            push(enc.encode('\nstream\n'));
            push(contents);
            push(enc.encode('\nendstream'));
        } else {
            const b = new Uint8Array(obj.sizeInBytes());
            obj.copyBytesInto(b, 0);
            push(b);
        }
        push(enc.encode('\nendobj\n'));
    }
    const xrefAt = offset;
    const byNum = new Map(offsets.map(([n, g, o]) => [n, [g, o]]));
    let x = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= maxNum; n += 1) {
        const e = byNum.get(n);
        x += e ? `${String(e[1]).padStart(10, '0')} ${String(e[0]).padStart(5, '0')} n \n` : '0000000000 00000 f \n';
    }
    const trailer = ctx.obj({ Size: maxNum + 1, Root: ctx.trailerInfo.Root });
    if (ctx.trailerInfo.Info) trailer.set(N('Info'), ctx.trailerInfo.Info);
    if (ctx.trailerInfo.ID) trailer.set(N('ID'), ctx.trailerInfo.ID);
    const tb = new Uint8Array(trailer.sizeInBytes());
    trailer.copyBytesInto(tb, 0);
    push(enc.encode(x + 'trailer\n'));
    push(tb);
    push(enc.encode(`\nstartxref\n${xrefAt}\n%%EOF\n`));
    return { chunks, total: offset };
}
