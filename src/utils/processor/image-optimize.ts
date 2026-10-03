/**
 * Optimizer v2 Stage 1: rewrite the images a PDF is made of, losslessly, and
 * nothing else (D-028).
 *
 *   LEAVE   the stream stays exactly as it is: DCT, JPX, JBIG2, CCITT, LZW,
 *           RunLength, ASCII85, Crypt, external (/F) streams, a TIFF predictor,
 *           an unknown colour space, anything this module cannot decode exactly.
 *   R1      the samples are kept exactly and only their encoding changes:
 *           decode the filter chain, re-encode Flate with a PNG predictor.
 *           ColorSpace / BitsPerComponent / Decode / Mask / SMask / Interpolate
 *           are untouched, so this is lossless in any colour space.
 *   R2      the sample *representation* changes, only where the change is
 *           provably exact:
 *             DeviceRGB 8-bit, ≤256 colours → Indexed over DeviceRGB
 *             ICCBased(N=3) 8-bit, ≤256 colours → Indexed over the same ICC
 *             DeviceRGB 8-bit with R=G=B → DeviceGray (only where the document
 *               gives device colour no Default* remapping and no OutputIntents)
 *             DeviceGray 8-bit whose values are all representable → 1/2/4-bit
 *           and never with a /Decode array, a colour-key /Mask, /ImageMask,
 *           /Interpolate true, an SMask carrying /Matte, or anything else
 *           whose equivalence is not established.
 *
 * A candidate replaces the stream only when it is strictly smaller than the
 * stream and than every other candidate. Candidates are produced a row block
 * at a time and fed to a streaming pako 2.1.0 `Deflate`; a candidate whose
 * emitted bytes pass what it would have to beat is abandoned at once (the
 * run-time cap), so no losing candidate is ever finished.
 */
import {
    PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef,
} from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';
import { Deflate, Inflate } from 'pako';
import { PAKO2, ROW_BLOCK_ROWS } from './optimize-budget';

// ---------------------------------------------------------------- helpers

const N = (s: string) => PDFName.of(s);

const resolve = (ctx: PDFContext, v: PDFObject | undefined): PDFObject | undefined => (
    v instanceof PDFRef ? ctx.lookup(v) : v
);

const nameOf = (v: PDFObject | undefined): string | null => (
    v instanceof PDFName ? v.decodeText() : null
);

const intOf = (ctx: PDFContext, v: PDFObject | undefined): number | null => {
    const r = resolve(ctx, v);
    return r instanceof PDFNumber && Number.isInteger(r.asNumber()) ? r.asNumber() : null;
};

/** The streaming compressor's output, kept as the chunks pako handed over. */
export interface EncodedChunks {
    chunks: Uint8Array[];
    /** Bytes of compressed data. */
    length: number;
    /** Bytes the chunks pin: every chunk is (a view of) a whole 16 KiB buffer. */
    heldBytes: number;
}

/** Thrown from inside `onData` when a candidate can no longer win. */
class CandidateCap extends Error {
    constructor() {
        super('candidate cap');
        this.name = 'CandidateCap';
    }
}

export interface WorkControl {
    /** Throws when the run has been superseded. Called at every row block. */
    check: () => void;
    /** Hands control back to the event loop; called at most every slice. */
    yieldToTask: () => Promise<void>;
}

const SLICE_MS = 12;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------- census

export type ImageDecision = 'LEAVE' | 'R1' | 'R1+R2';

export interface ImageEntry {
    ref: PDFRef;
    stream: PDFRawStream;
    width: number;
    height: number;
    bitsPerComponent: number;
    components: number;
    colourSpace: string;
    filters: string[];
    decision: ImageDecision;
    /** Why, for the summary and the gate. */
    why: string;
    /** Whether the stream's rows carry PNG predictor tags. */
    pngPredicted: boolean;
    /** Bytes per row of the exact samples. */
    rowBytes: number;
    /** Bytes the exact decode produces before predictor tags are removed. */
    decodedBytes: number;
    /** The ColorSpace object as found, so an ICC base is reused as is. */
    colourSpaceObject: PDFObject | undefined;
    r2: { indexed: boolean; gray: boolean; lowerBits: boolean };
}

const DECODABLE = new Set(['FlateDecode', 'ASCIIHexDecode']);

interface ColourSpaceInfo {
    kind: string;
    components: number | null;
}

function colourSpaceInfo(ctx: PDFContext, raw: PDFObject | undefined): ColourSpaceInfo {
    const v = resolve(ctx, raw);
    if (v instanceof PDFName) {
        const n = v.decodeText();
        const comps = ({ DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 } as Record<string, number>)[n] ?? null;
        return { kind: n, components: comps };
    }
    if (v instanceof PDFArray && v.size() > 0) {
        const head = nameOf(resolve(ctx, v.get(0)));
        switch (head) {
            case 'ICCBased': {
                const s = resolve(ctx, v.get(1));
                const n = s instanceof PDFRawStream ? intOf(ctx, s.dict.get(N('N'))) : null;
                return { kind: 'ICCBased', components: n === 1 || n === 3 || n === 4 ? n : null };
            }
            case 'Indexed':
                return { kind: 'Indexed', components: 1 };
            case 'CalGray':
            case 'Separation':
                return { kind: head, components: 1 };
            case 'CalRGB':
            case 'Lab':
                return { kind: head, components: 3 };
            case 'DeviceN': {
                const names = resolve(ctx, v.get(1));
                return { kind: 'DeviceN', components: names instanceof PDFArray ? names.size() : null };
            }
            default:
                return { kind: head ?? '?', components: null };
        }
    }
    return { kind: v === undefined ? 'none' : '?', components: null };
}

/**
 * Whether device colour in this document means the same thing however it is
 * written. A page can remap DeviceGray / DeviceRGB through a /Default* colour
 * space, and an /OutputIntents entry can colour-manage them differently; in
 * either case RGB(v,v,v) and Gray(v) are not provably the same, so RGB → Gray
 * is withheld for the whole document. Indexed over DeviceRGB keeps its base
 * and is unaffected.
 */
export function deviceGrayIsExact(doc: PDFDocument): boolean {
    if (doc.catalog.get(N('OutputIntents')) !== undefined) return false;
    const ctx = doc.context;
    const defaults = ['DefaultGray', 'DefaultRGB', 'DefaultCMYK'];
    const seen = new Set<PDFDict>();
    const visit = (d: PDFDict, depth: number): boolean => {
        if (seen.has(d) || depth > 4) return true;
        seen.add(d);
        const cs = resolve(ctx, d.get(N('ColorSpace')));
        if (cs instanceof PDFDict && defaults.some((k) => cs.get(N(k)) !== undefined)) return false;
        for (const [, v] of d.entries()) {
            const r = v instanceof PDFRef ? undefined : v;
            const dict = r instanceof PDFDict ? r : null;
            if (dict && !visit(dict, depth + 1)) return false;
        }
        return true;
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
        const d = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : null;
        if (d && !visit(d, 0)) return false;
    }
    return true;
}

interface FilterChain {
    names: string[];
    /** The predictor the Flate stage declares, or null for none. */
    png: boolean;
    problem: string | null;
}

function filterChain(ctx: PDFContext, dict: PDFDict, width: number, bpc: number, comps: number): FilterChain {
    const rawFilter = resolve(ctx, dict.get(N('Filter')));
    const rawParms = resolve(ctx, dict.get(N('DecodeParms')));
    const names: string[] = [];
    const parms: (PDFObject | undefined)[] = [];
    if (rawFilter instanceof PDFName) {
        names.push(rawFilter.decodeText());
        parms.push(rawParms instanceof PDFArray ? resolve(ctx, rawParms.get(0)) : rawParms);
    } else if (rawFilter instanceof PDFArray) {
        for (let i = 0; i < rawFilter.size(); i += 1) {
            const n = nameOf(resolve(ctx, rawFilter.get(i)));
            names.push(n ?? '?');
            parms.push(rawParms instanceof PDFArray ? resolve(ctx, rawParms.get(i)) : undefined);
        }
    } else if (rawFilter !== undefined) {
        return { names: ['?'], png: false, problem: '/Filter is neither a name nor an array' };
    }

    const exotic = names.find((n) => !DECODABLE.has(n));
    if (exotic) return { names, png: false, problem: `${exotic} is kept as is` };
    // ASCIIHex only as the outermost stage, Flate at most once and innermost.
    const flateAt = names.indexOf('FlateDecode');
    if (names.filter((n) => n === 'FlateDecode').length > 1 || names.filter((n) => n === 'ASCIIHexDecode').length > 1) {
        return { names, png: false, problem: 'repeated filter stage' };
    }
    if (flateAt !== -1 && flateAt !== names.length - 1) return { names, png: false, problem: 'Flate is not the last stage' };

    let png = false;
    if (flateAt !== -1) {
        const p = parms[flateAt];
        if (p !== undefined && !(p instanceof PDFDict)) return { names, png: false, problem: 'unreadable DecodeParms' };
        const predictor = p instanceof PDFDict ? intOf(ctx, p.get(N('Predictor'))) ?? 1 : 1;
        if (predictor >= 10 && predictor <= 15) {
            const colors = p instanceof PDFDict ? intOf(ctx, p.get(N('Colors'))) ?? 1 : 1;
            const pbpc = p instanceof PDFDict ? intOf(ctx, p.get(N('BitsPerComponent'))) ?? 8 : 8;
            const columns = p instanceof PDFDict ? intOf(ctx, p.get(N('Columns'))) ?? 1 : 1;
            if (colors !== comps || pbpc !== bpc || columns !== width) {
                return { names, png: false, problem: 'predictor parameters do not describe this image' };
            }
            png = true;
        } else if (predictor !== 1) {
            return { names, png: false, problem: `predictor ${predictor} is kept as is` };
        }
    }
    return { names, png, problem: null };
}

/** Every image XObject held as an indirect stream, in object-number order. */
export function censusImages(doc: PDFDocument): ImageEntry[] {
    const ctx = doc.context;
    const grayExact = deviceGrayIsExact(doc);
    const entries: ImageEntry[] = [];
    const objects = ctx.enumerateIndirectObjects()
        .sort((a, b) => a[0].objectNumber - b[0].objectNumber || a[0].generationNumber - b[0].generationNumber);

    for (const [ref, obj] of objects) {
        if (!(obj instanceof PDFRawStream)) continue;
        const d = obj.dict;
        if (nameOf(resolve(ctx, d.get(N('Subtype')))) !== 'Image') continue;

        const width = intOf(ctx, d.get(N('Width'))) ?? 0;
        const height = intOf(ctx, d.get(N('Height'))) ?? 0;
        const imageMask = resolve(ctx, d.get(N('ImageMask'))) === PDFBool.True;
        const bpc = imageMask ? 1 : intOf(ctx, d.get(N('BitsPerComponent'))) ?? 0;
        const cs = imageMask ? { kind: 'ImageMask', components: 1 } : colourSpaceInfo(ctx, d.get(N('ColorSpace')));
        const base: Omit<ImageEntry, 'decision' | 'why' | 'pngPredicted' | 'rowBytes' | 'decodedBytes' | 'r2' | 'filters'> = {
            ref,
            stream: obj,
            width,
            height,
            bitsPerComponent: bpc,
            components: cs.components ?? 0,
            colourSpace: cs.kind,
            colourSpaceObject: d.get(N('ColorSpace')),
        };
        const leave = (why: string, filters: string[] = []): ImageEntry => ({
            ...base, filters, decision: 'LEAVE', why, pngPredicted: false, rowBytes: 0, decodedBytes: 0,
            r2: { indexed: false, gray: false, lowerBits: false },
        });

        if (d.get(N('F')) !== undefined || d.get(N('FFilter')) !== undefined) {
            entries.push(leave('external stream data (/F)'));
            continue;
        }
        if (!(width > 0 && height > 0)) { entries.push(leave('unreadable /Width or /Height')); continue; }
        if (![1, 2, 4, 8, 16].includes(bpc)) { entries.push(leave(`unsupported BitsPerComponent ${bpc}`)); continue; }
        if (!cs.components) { entries.push(leave(`colour space ${cs.kind} is kept as is`)); continue; }

        const chain = filterChain(ctx, d, width, bpc, cs.components);
        if (chain.problem) { entries.push(leave(chain.problem, chain.names)); continue; }

        const rowBytes = Math.ceil((width * cs.components * bpc) / 8);
        const decodedBytes = (rowBytes + (chain.png ? 1 : 0)) * height;
        if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 2 ** 31 - 1) {
            entries.push(leave('decoded size is out of range', chain.names));
            continue;
        }

        // ---- R2 eligibility: everything that ties sample meaning to its form
        const blockers: string[] = [];
        if (imageMask) blockers.push('ImageMask');
        if (d.get(N('Decode')) !== undefined) blockers.push('/Decode array');
        const mask = resolve(ctx, d.get(N('Mask')));
        if (mask instanceof PDFArray) blockers.push('colour-key /Mask');
        if (resolve(ctx, d.get(N('Interpolate'))) === PDFBool.True) blockers.push('/Interpolate true');
        const smask = resolve(ctx, d.get(N('SMask')));
        if (smask instanceof PDFRawStream && smask.dict.get(N('Matte')) !== undefined) blockers.push('SMask /Matte');
        if (smask !== undefined && !(smask instanceof PDFRawStream)) blockers.push('unreadable /SMask');
        if (bpc !== 8) blockers.push(`${bpc}-bit samples`);
        if (!['DeviceRGB', 'DeviceGray', 'ICCBased'].includes(cs.kind)) blockers.push(cs.kind);
        if (cs.kind === 'ICCBased' && cs.components !== 3) blockers.push(`ICCBased N=${cs.components}`);

        const r2 = blockers.length === 0
            ? {
                indexed: cs.kind === 'DeviceRGB' || cs.kind === 'ICCBased',
                gray: cs.kind === 'DeviceRGB' && grayExact,
                lowerBits: cs.kind === 'DeviceGray' || (cs.kind === 'DeviceRGB' && grayExact),
            }
            : { indexed: false, gray: false, lowerBits: false };

        entries.push({
            ...base,
            filters: chain.names,
            decision: blockers.length === 0 ? 'R1+R2' : 'R1',
            why: blockers.length === 0
                ? 'samples kept; exact Indexed / Gray / bit-depth forms tried'
                : `samples kept exactly (${blockers.join(', ')} forbids a representation change)`,
            pngPredicted: chain.png,
            rowBytes,
            decodedBytes,
            r2,
        });
    }
    return entries;
}

// ---------------------------------------------------------------- decode

function hexValue(c: number): number {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 65 && c <= 70) return c - 55;
    if (c >= 97 && c <= 102) return c - 87;
    return -1;
}

const isWhite = (c: number) => c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09 || c === 0x0C || c === 0x00;

/** ASCIIHexDecode, exactly as PDF 32000 7.4.2 defines it. Null when malformed. */
export function decodeAsciiHex(data: Uint8Array): Uint8Array | null {
    const out = new Uint8Array(Math.ceil(data.length / 2));
    let n = 0;
    let high = -1;
    for (let i = 0; i < data.length; i += 1) {
        const c = data[i];
        if (c === 0x3E) break; // '>' EOD
        if (isWhite(c)) continue;
        const v = hexValue(c);
        if (v < 0) return null;
        if (high < 0) {
            high = v;
        } else {
            out[n] = (high << 4) | v;
            n += 1;
            high = -1;
        }
    }
    if (high >= 0) { out[n] = high << 4; n += 1; }
    return out.subarray(0, n);
}

/** Thrown from inside `onData` when a stream decodes to more than the image holds. */
class DecodeOverrun extends Error {
    constructor() {
        super('decode overrun');
        this.name = 'DecodeOverrun';
    }
}

/**
 * Inflate into exactly `expected` bytes, or nothing.
 *
 * Only a stream pako decoded completely is accepted: `push` succeeded, no
 * error, the zlib stream reached its end (so its Adler-32 was checked), and it
 * produced exactly the bytes the image holds. A truncated stream, a bad
 * checksum, or a stream that decodes to more than the image are all left as
 * they are — rewriting them would turn a malformed image into a valid one.
 * Decoding stops the moment the output would pass `expected`, so an
 * over-long stream never materialises beyond one chunk.
 */
export function inflateExact(data: Uint8Array, expected: number): Uint8Array | null {
    const out = new Uint8Array(expected);
    let at = 0;
    const inflater = new Inflate({ chunkSize: PAKO2.inflateChunkBytes });
    inflater.onData = (chunk: Uint8Array) => {
        if (at + chunk.length > expected) throw new DecodeOverrun();
        out.set(chunk, at);
        at += chunk.length;
    };
    let pushed: boolean;
    try {
        pushed = inflater.push(data, true);
    } catch (e) {
        if (e instanceof DecodeOverrun) return null;
        throw e;
    }
    return pushed && inflater.err === 0 && inflater.ended && at === expected ? out : null;
}

/** Undo PNG predictors in place; returns the packed rows, or null if malformed. */
function unpredictPng(buf: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array | null {
    const stride = rowBytes + 1;
    for (let r = 0; r < height; r += 1) {
        const tag = buf[r * stride];
        const src = r * stride + 1;
        const dst = r * rowBytes;
        const prev = r === 0 ? -1 : (r - 1) * rowBytes;
        for (let i = 0; i < rowBytes; i += 1) {
            const x = buf[src + i];
            const a = i >= bpp ? buf[dst + i - bpp] : 0;
            const b = prev >= 0 ? buf[prev + i] : 0;
            const c = prev >= 0 && i >= bpp ? buf[prev + i - bpp] : 0;
            let v: number;
            switch (tag) {
                case 0: v = x; break;
                case 1: v = x + a; break;
                case 2: v = x + b; break;
                case 3: v = x + ((a + b) >> 1); break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                    break;
                }
                default: return null;
            }
            buf[dst + i] = v & 0xFF;
        }
    }
    return buf.subarray(0, rowBytes * height);
}

/**
 * The image's exact samples, packed `rowBytes` per row, or null when they
 * cannot be recovered exactly (the image is then left as it is): every stage
 * must decode cleanly to exactly the size the image declares.
 *
 * An unfiltered stream is returned as a view of pdf-lib's own copy — read,
 * never written.
 */
export function decodeExactSamples(entry: ImageEntry): Uint8Array | null {
    let data: Uint8Array = entry.stream.contents;
    for (const f of entry.filters) {
        if (f === 'ASCIIHexDecode') {
            const hex = decodeAsciiHex(data);
            if (!hex) return null;
            data = hex;
        }
    }
    const expected = entry.decodedBytes;
    if (entry.filters.includes('FlateDecode')) {
        const inflated = inflateExact(data, expected);
        if (!inflated) return null;
        data = inflated;
    } else if (data.length !== expected) {
        // Unfiltered (or ASCIIHex only) data must be exactly the image's size:
        // short is malformed, and longer would be silently truncated.
        return null;
    }
    if (!entry.pngPredicted) return data;
    const bpp = Math.max(1, Math.ceil((entry.components * entry.bitsPerComponent) / 8));
    // A view of pdf-lib's copy must not be rewritten in place.
    const own = data.buffer === entry.stream.contents.buffer ? data.slice() : data;
    return unpredictPng(own, entry.rowBytes, entry.height, bpp);
}

// ---------------------------------------------------------------- exact forms

/** A representation produced one row at a time. */
interface RowForm {
    label: string;
    rowBytes: number;
    /** PNG predictor Colors / BitsPerComponent. */
    colors: number;
    bpc: number;
    /** Fill `out` (rowBytes long) with row `y`. */
    fill: (y: number, out: Uint8Array) => void;
    /** Dictionary entries that change, beyond Filter / DecodeParms. */
    dict: (ctx: PDFContext) => Record<string, PDFObject>;
}

function packInto(out: Uint8Array, x: number, bits: number, v: number): void {
    const perByte = 8 / bits;
    out[Math.floor(x / perByte)] |= v << (8 - bits * ((x % perByte) + 1));
}

export interface ExactAnalysis {
    colours: Map<number, number> | null;
    isGray: boolean;
    /** Smallest bit depth every gray value is exactly representable at (8 if none). */
    grayBits: 1 | 2 | 4 | 8;
}

/** One pass over the samples: colour set (≤256), R=G=B, representable gray depth. */
export async function analyseExact(
    samples: Uint8Array, entry: ImageEntry, control: WorkControl,
): Promise<ExactAnalysis> {
    const rgb = entry.components === 3;
    let colours: Map<number, number> | null = rgb && entry.r2.indexed ? new Map() : null;
    let isGray = rgb ? entry.r2.gray || entry.r2.lowerBits : entry.r2.lowerBits;
    let ok1 = true; let ok2 = true; let ok4 = true;
    const step = entry.components;
    const rowSamples = entry.rowBytes;
    let last = now();
    for (let y = 0; y < entry.height; y += 1) {
        const off = y * rowSamples;
        for (let i = off; i < off + rowSamples; i += step) {
            const v = samples[i];
            if (rgb) {
                const g = samples[i + 1];
                const b = samples[i + 2];
                if (isGray && (v !== g || g !== b)) isGray = false;
                if (colours) {
                    const k = (v << 16) | (g << 8) | b;
                    if (!colours.has(k)) {
                        if (colours.size === 256) colours = null;
                        else colours.set(k, colours.size);
                    }
                }
            }
            if (isGray && (ok1 || ok2 || ok4)) {
                if (v % 255 !== 0) ok1 = false;
                if (v % 85 !== 0) ok2 = false;
                if (v % 17 !== 0) ok4 = false;
            }
        }
        if (!colours && !isGray) break;
        if ((y & 63) === 63) {
            control.check();
            if (now() - last > SLICE_MS) { await control.yieldToTask(); last = now(); }
        }
    }
    const grayBits = !isGray ? 8 : ok1 ? 1 : ok2 ? 2 : ok4 ? 4 : 8;
    return { colours, isGray, grayBits };
}

function exactForms(samples: Uint8Array, entry: ImageEntry, a: ExactAnalysis): RowForm[] {
    const w = entry.width;
    const forms: RowForm[] = [];
    const rowOf = (y: number) => y * entry.rowBytes;

    if (entry.components === 3 && a.isGray && (entry.r2.gray || entry.r2.lowerBits)) {
        const bits = entry.r2.lowerBits ? a.grayBits : 8;
        const scale = 255 / ((1 << bits) - 1);
        forms.push({
            label: `R2 DeviceGray ${bits}-bit`,
            rowBytes: Math.ceil((w * bits) / 8),
            colors: 1,
            bpc: bits,
            fill: (y, out) => {
                out.fill(0);
                const o = rowOf(y);
                if (bits === 8) for (let x = 0; x < w; x += 1) out[x] = samples[o + 3 * x];
                else for (let x = 0; x < w; x += 1) packInto(out, x, bits, samples[o + 3 * x] / scale);
            },
            dict: () => ({ ColorSpace: N('DeviceGray'), BitsPerComponent: PDFNumber.of(bits) }),
        });
    }

    if (entry.components === 3 && a.colours && entry.r2.indexed) {
        const map = a.colours;
        const n = map.size;
        const bits = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
        const palette = new Uint8Array(n * 3);
        for (const [k, i] of map) { palette[i * 3] = k >> 16; palette[i * 3 + 1] = (k >> 8) & 0xFF; palette[i * 3 + 2] = k & 0xFF; }
        forms.push({
            label: `R2 Indexed ${bits}-bit (${n} colours)`,
            rowBytes: Math.ceil((w * bits) / 8),
            colors: 1,
            bpc: bits,
            fill: (y, out) => {
                out.fill(0);
                const o = rowOf(y);
                for (let x = 0; x < w; x += 1) {
                    const p = o + 3 * x;
                    const idx = map.get((samples[p] << 16) | (samples[p + 1] << 8) | samples[p + 2]) as number;
                    if (bits === 8) out[x] = idx;
                    else packInto(out, x, bits, idx);
                }
            },
            dict: (ctx) => {
                // The base is the image's own colour space object: DeviceRGB, or
                // the very same ICCBased array, so the profile is not touched.
                const baseObj = entry.colourSpace === 'ICCBased' ? entry.colourSpaceObject as PDFObject : N('DeviceRGB');
                let hex = '';
                for (let i = 0; i < palette.length; i += 1) hex += palette[i].toString(16).padStart(2, '0');
                return {
                    ColorSpace: ctx.obj([N('Indexed'), baseObj, PDFNumber.of(n - 1), PDFHexString.of(hex)]),
                    BitsPerComponent: PDFNumber.of(bits),
                };
            },
        });
    }

    if (entry.components === 1 && entry.colourSpace === 'DeviceGray' && entry.r2.lowerBits && a.grayBits < 8) {
        const bits = a.grayBits;
        const scale = 255 / ((1 << bits) - 1);
        forms.push({
            label: `R2 DeviceGray ${bits}-bit`,
            rowBytes: Math.ceil((w * bits) / 8),
            colors: 1,
            bpc: bits,
            fill: (y, out) => {
                out.fill(0);
                const o = rowOf(y);
                for (let x = 0; x < w; x += 1) packInto(out, x, bits, samples[o + x] / scale);
            },
            dict: () => ({ BitsPerComponent: PDFNumber.of(bits) }),
        });
    }
    return forms;
}

// ---------------------------------------------------------------- encode

type PredictorMode = 'up' | 'adaptive';

function filterRow(mode: number, row: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
    out[0] = mode;
    for (let i = 0; i < row.length; i += 1) {
        const x = row[i];
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v: number;
        switch (mode) {
            case 0: v = x; break;
            case 1: v = x - a; break;
            case 2: v = x - b; break;
            case 3: v = x - ((a + b) >> 1); break;
            default: {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            }
        }
        out[i + 1] = v & 0xFF;
    }
}

const absCost = (tagged: Uint8Array) => {
    let s = 0;
    for (let i = 1; i < tagged.length; i += 1) { const v = tagged[i]; s += v < 128 ? v : 256 - v; }
    return s;
};

/**
 * Compress rows through PNG predictors into a streaming pako 2.1.0 Deflate.
 *
 * Returns null when the candidate was capped: its emitted bytes passed `cap`,
 * so it could not have been kept. At most one 16 KiB chunk past the cap is ever
 * materialised, and the partial candidate is dropped with the deflater.
 */
export async function compressRows(
    height: number,
    rowBytes: number,
    bpp: number,
    mode: PredictorMode,
    rowAt: (y: number, scratch: Uint8Array) => Uint8Array,
    cap: number,
    control: WorkControl,
): Promise<EncodedChunks | null> {
    const deflater = new Deflate({ level: 9, chunkSize: PAKO2.deflateChunkBytes });
    const chunks: Uint8Array[] = [];
    let emitted = 0;
    deflater.onData = (chunk: Uint8Array) => {
        chunks.push(chunk);
        emitted += chunk.length;
        if (emitted > cap) throw new CandidateCap();
    };
    // The default onEnd flattens the chunk list into a second whole copy.
    deflater.onEnd = () => { /* chunks are handed over as they are */ };

    const stride = rowBytes + 1;
    const block = new Uint8Array(stride * Math.min(ROW_BLOCK_ROWS, height));
    const scratchA = new Uint8Array(rowBytes);
    const scratchB = new Uint8Array(rowBytes);
    const trial = new Uint8Array(stride);
    let prevRow: Uint8Array | null = null;
    let current = scratchA;
    let last = now();

    try {
        for (let y0 = 0; y0 < height; y0 += ROW_BLOCK_ROWS) {
            control.check();
            const rows = Math.min(ROW_BLOCK_ROWS, height - y0);
            for (let r = 0; r < rows; r += 1) {
                const row = rowAt(y0 + r, current);
                const out = block.subarray(r * stride, (r + 1) * stride);
                if (mode === 'up') {
                    filterRow(2, row, prevRow, bpp, out);
                } else {
                    filterRow(0, row, prevRow, bpp, out);
                    let best = absCost(out);
                    for (let m = 1; m <= 4; m += 1) {
                        filterRow(m, row, prevRow, bpp, trial);
                        const cost = absCost(trial);
                        if (cost < best) { best = cost; out.set(trial); }
                    }
                }
                // The row just used becomes the previous one; it must not be the
                // scratch the next row is written into.
                if (row === current) {
                    prevRow = current;
                    current = current === scratchA ? scratchB : scratchA;
                } else {
                    prevRow = row;
                }
            }
            deflater.push(block.subarray(0, rows * stride), false);
            if (deflater.err) throw new Error(`pako: ${deflater.msg}`);
            if (now() - last > SLICE_MS) { await control.yieldToTask(); last = now(); }
        }
        control.check();
        deflater.push(new Uint8Array(0), true);
        if (deflater.err) throw new Error(`pako: ${deflater.msg}`);
    } catch (e) {
        if (e instanceof CandidateCap) return null;
        throw e;
    }
    return { chunks, length: emitted, heldBytes: chunks.length * PAKO2.deflateChunkBytes };
}

export interface Replacement {
    label: string;
    encoded: EncodedChunks;
    /** The new image dictionary (Length is written by the writer). */
    dict: PDFDict;
}

/**
 * The smallest exact encoding of one image, or null when nothing beats the
 * stream it has. `samples` are the exact decoded rows.
 */
export async function bestReplacement(
    ctx: PDFContext,
    entry: ImageEntry,
    samples: Uint8Array,
    control: WorkControl,
): Promise<Replacement | null> {
    const forms: RowForm[] = [];
    if (entry.decision === 'R1+R2') {
        const analysis = await analyseExact(samples, entry, control);
        forms.push(...exactForms(samples, entry, analysis));
    }
    // R1 last: the exact forms are usually smaller, so its cap is usually tighter.
    forms.push({
        label: 'R1 Flate',
        rowBytes: entry.rowBytes,
        colors: entry.components,
        bpc: entry.bitsPerComponent,
        fill: () => { /* rows are views of the samples */ },
        dict: () => ({}),
    });

    let best: { form: RowForm; encoded: EncodedChunks } | null = null;
    for (const form of forms) {
        // Strictly smaller than the stream and than the best so far, or it is
        // not worth finishing.
        const cap = Math.min(entry.stream.contents.length, best ? best.encoded.length : Infinity) - 1;
        if (cap <= 0) break;
        const bpp = Math.max(1, Math.ceil((form.colors * form.bpc) / 8));
        const mode: PredictorMode = form.bpc >= 8 ? 'adaptive' : 'up';
        const isR1 = form.label === 'R1 Flate';
        const rowAt = isR1
            ? (y: number) => samples.subarray(y * entry.rowBytes, (y + 1) * entry.rowBytes)
            : (y: number, scratch: Uint8Array) => { form.fill(y, scratch); return scratch; };
        const encoded = await compressRows(entry.height, form.rowBytes, bpp, mode, rowAt, cap, control);
        if (encoded) best = { form, encoded };
    }
    if (!best) return null;

    const dict = entry.stream.dict.clone(ctx);
    dict.delete(N('Filter'));
    dict.delete(N('DecodeParms'));
    dict.delete(N('DP'));
    dict.set(N('Filter'), N('FlateDecode'));
    dict.set(N('DecodeParms'), ctx.obj({
        Predictor: 15,
        Colors: best.form.colors,
        BitsPerComponent: best.form.bpc,
        Columns: entry.width,
    }));
    for (const [k, v] of Object.entries(best.form.dict(ctx))) dict.set(N(k), v);
    dict.delete(N('Length'));
    return { label: `${best.form.label} (${best.form.bpc >= 8 ? 'adaptive' : 'up'})`, encoded: best.encoded, dict };
}
