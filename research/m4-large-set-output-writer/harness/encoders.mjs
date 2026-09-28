/**
 * Candidate image-stream encoders. Each returns
 *   { width, height, dict, payload: Uint8Array[], rawBytes, encodedBytes }
 * where `dict` is the PDF image dictionary tail (colour space, BPC, filter,
 * DecodeParms) and `payload` the already-encoded stream bytes.
 *
 * Row sources are pull-based (`row(y) -> Uint8Array`) so a candidate can be
 * driven either from a whole composite or straight from the masks, one row at a
 * time, without a full-page intermediate.
 */
import { Zlib, zlibSync } from 'fflate';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG predictors (ISO 32000 7.4.4.4, PNG filter types 0-4), per row.
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Filter one row into out[1..]; out[0] = filter type. */
function filterRow(type, row, prev, bpp, out) {
    out[0] = type;
    const n = row.length;
    for (let i = 0; i < n; i += 1) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (type) {
            case 0: v = row[i]; break;
            case 1: v = row[i] - a; break;
            case 2: v = row[i] - b; break;
            case 3: v = row[i] - ((a + b) >> 1); break;
            default: v = row[i] - paeth(a, b, c);
        }
        out[i + 1] = v & 0xFF;
    }
}

/** Adaptive: the libpng minimum-sum-of-absolute-differences heuristic. */
function adaptiveRow(row, prev, bpp, scratch, out) {
    let best = -1;
    let bestSum = Infinity;
    for (let t = 0; t <= 4; t += 1) {
        filterRow(t, row, prev, bpp, scratch);
        let s = 0;
        for (let i = 1; i < scratch.length; i += 1) {
            const v = scratch[i];
            s += v < 128 ? v : 256 - v;
            if (s >= bestSum) break;
        }
        if (s < bestSum) {
            bestSum = s;
            best = t;
            out.set(scratch);
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Deflate back-ends.
// ---------------------------------------------------------------------------

/**
 * Streamed zlib: rows are pushed in bands; compressed output is collected as it
 * is produced. Nothing of page size is allocated except the output itself.
 */
function streamDeflate({ backend, level, rows, rowBytes, predictor, bpp, bandRows = 64 }) {
    const payload = [];
    let encodedBytes = 0;
    let deflater;
    let nodeChunks;
    if (backend === 'fflate') {
        deflater = new Zlib({ level }, (chunk) => { payload.push(chunk); encodedBytes += chunk.length; });
    } else if (backend === 'node-zlib') {
        nodeChunks = [];
        deflater = zlib.createDeflate({ level });
    } else {
        throw new Error(`unknown backend ${backend}`);
    }
    const lineBytes = rowBytes + (predictor ? 1 : 0);
    const band = new Uint8Array(lineBytes * bandRows);
    const scratch = new Uint8Array(lineBytes);
    const filtered = new Uint8Array(lineBytes);
    let inBand = 0;
    let prev = null;
    let prevCopy = new Uint8Array(rowBytes);
    const types = [0, 0, 0, 0, 0];
    const flush = (final) => {
        const view = band.subarray(0, inBand * lineBytes);
        if (backend === 'fflate') deflater.push(view.slice(), final);
        else nodeChunks.push(Buffer.from(view));
        inBand = 0;
    };
    const height = rows.height;
    for (let y = 0; y < height; y += 1) {
        const row = rows.row(y);
        const dst = band.subarray(inBand * lineBytes, (inBand + 1) * lineBytes);
        if (!predictor) {
            dst.set(row);
        } else if (predictor === 'adaptive') {
            types[adaptiveRow(row, prev, bpp, scratch, filtered)] += 1;
            dst.set(filtered);
        } else {
            filterRow(predictor, row, prev, bpp, dst);
            types[predictor] += 1;
        }
        if (predictor) {
            prevCopy.set(row);
            prev = prevCopy;
        }
        inBand += 1;
        if (inBand === bandRows || y === height - 1) flush(y === height - 1);
    }
    if (backend === 'node-zlib') {
        const out = zlib.deflateSync(Buffer.concat(nodeChunks), { level });
        payload.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
        encodedBytes = out.length;
    }
    prevCopy = null;
    return { payload, encodedBytes, rawBytes: lineBytes * height, filterTypes: predictor ? types : null };
}

function decodeParms(predictor, colors, bpc, columns) {
    if (!predictor) return '';
    return ` /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${bpc} /Columns ${columns} >>`;
}

// ---------------------------------------------------------------------------
// Row sources.
// ---------------------------------------------------------------------------

/** RGB rows out of an RGBA composite. */
export function rgbRows(rgba, width, height) {
    const row = new Uint8Array(width * 3);
    return {
        width, height,
        row(y) {
            let o = 0;
            const s = y * width * 4;
            for (let x = 0; x < width; x += 1) {
                const i = s + x * 4;
                row[o] = rgba[i]; row[o + 1] = rgba[i + 1]; row[o + 2] = rgba[i + 2];
                o += 3;
            }
            return row;
        },
    };
}

/**
 * The 9-state palette, derived by asking production `paintPair` to paint one
 * pixel per state, so the palette cannot drift from the compositor.
 * State per layer: 0 no ink, 1 ink matched, 2 ink unmatched; index = s0*3+s1.
 */
export function statePalette(paintPair, refColor, othColor, matchColor, matchOpacity) {
    const n = 9;
    const ref = new Uint8Array(n);
    const oth = new Uint8Array(n);
    const dRef = new Uint8Array(n);
    const dOth = new Uint8Array(n);
    for (let s0 = 0; s0 < 3; s0 += 1) {
        for (let s1 = 0; s1 < 3; s1 += 1) {
            const p = s0 * 3 + s1;
            ref[p] = s0 > 0 ? 1 : 0;
            oth[p] = s1 > 0 ? 1 : 0;
            dOth[p] = s0 === 1 ? 1 : 0; // reference ink matched by the other
            dRef[p] = s1 === 1 ? 1 : 0; // other ink matched by the reference
        }
    }
    const px = paintPair(ref, oth, dRef, dOth, refColor, othColor, n, 1, matchColor, matchOpacity);
    const palette = [];
    for (let p = 0; p < n; p += 1) palette.push([px[p * 4], px[p * 4 + 1], px[p * 4 + 2]]);
    return palette;
}

/** 4-bit indexed rows straight from the masks: no RGBA composite exists. */
export function stateRowsFromMasks(ref, oth, dRef, dOth, width, height) {
    const rowBytes = (width + 1) >> 1;
    const row = new Uint8Array(rowBytes);
    return {
        width, height, rowBytes,
        row(y) {
            row.fill(0);
            const s = y * width;
            for (let x = 0; x < width; x += 1) {
                const p = s + x;
                const s0 = ref[p] ? (dOth[p] ? 1 : 2) : 0;
                const s1 = oth[p] ? (dRef[p] ? 1 : 2) : 0;
                const v = s0 * 3 + s1;
                row[x >> 1] |= (x & 1) ? v : (v << 4);
            }
            return row;
        },
    };
}

/**
 * Indexed rows from an RGBA composite via an exact colour->index map (for the
 * RGBA-sourced variants and for lossless verification). Throws if the
 * composite holds a colour outside the palette - which would mean the palette
 * is not a faithful encoding.
 */
export function indexedRowsFromComposite(rgba, width, height, palette, bpc) {
    const map = new Map(palette.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));
    const perByte = 8 / bpc;
    const rowBytes = Math.ceil(width / perByte);
    const row = new Uint8Array(rowBytes);
    return {
        width, height, rowBytes,
        row(y) {
            row.fill(0);
            const s = y * width * 4;
            for (let x = 0; x < width; x += 1) {
                const i = s + x * 4;
                const v = map.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
                if (v === undefined) throw new Error(`colour outside palette at ${x},${y}`);
                const shift = 8 - bpc * ((x % perByte) + 1);
                row[Math.floor(x / perByte)] |= v << shift;
            }
            return row;
        },
    };
}

const hex = (palette) => palette.map(([r, g, b]) => [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')).join('');

export function encodeRgb(rows, { predictor = 0, level = 6, backend = 'fflate' } = {}) {
    const r = streamDeflate({ backend, level, rows, rowBytes: rows.width * 3, predictor, bpp: 3 });
    return {
        width: rows.width, height: rows.height,
        dict: `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${decodeParms(predictor, 3, 8, rows.width)}`,
        ...r,
    };
}

export function encodeIndexed(rows, palette, bpc, { predictor = 0, level = 6, backend = 'fflate' } = {}) {
    const r = streamDeflate({ backend, level, rows, rowBytes: rows.rowBytes, predictor, bpp: 1 });
    return {
        width: rows.width, height: rows.height,
        dict: `/ColorSpace [/Indexed /DeviceRGB ${palette.length - 1} <${hex(palette)}>] /BitsPerComponent ${bpc} `
            + `/Filter /FlateDecode${decodeParms(predictor, 1, bpc, rows.width)}`,
        ...r,
    };
}

/** Browser-native path: CompressionStream('deflate') is zlib-wrapped (= FlateDecode). */
export async function encodeIndexedCompressionStream(rows, palette, bpc, { predictor = 0 } = {}) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const payload = [];
    let encodedBytes = 0;
    const reading = (async () => {
        const reader = cs.readable.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            payload.push(value);
            encodedBytes += value.length;
        }
    })();
    const bandRows = 64;
    const lineBytes = rows.rowBytes + (predictor ? 1 : 0);
    const band = new Uint8Array(lineBytes * bandRows);
    const prev = new Uint8Array(rows.rowBytes);
    let havePrev = false;
    let inBand = 0;
    for (let y = 0; y < rows.height; y += 1) {
        const row = rows.row(y);
        const dst = band.subarray(inBand * lineBytes, (inBand + 1) * lineBytes);
        if (predictor) {
            filterRow(predictor, row, havePrev ? prev : null, 1, dst);
            prev.set(row);
            havePrev = true;
        } else {
            dst.set(row);
        }
        inBand += 1;
        if (inBand === bandRows || y === rows.height - 1) {
            await writer.write(band.slice(0, inBand * lineBytes));
            inBand = 0;
        }
    }
    await writer.close();
    await reading;
    return {
        width: rows.width, height: rows.height,
        dict: `/ColorSpace [/Indexed /DeviceRGB ${palette.length - 1} <${hex(palette)}>] /BitsPerComponent ${bpc} `
            + `/Filter /FlateDecode${decodeParms(predictor, 1, bpc, rows.width)}`,
        payload, encodedBytes, rawBytes: lineBytes * rows.height,
    };
}

/** Lossy: a JPEG of the composite, embedded as DCTDecode. */
export function encodeJpeg(jpegBytes, width, height) {
    const payload = [new Uint8Array(jpegBytes.buffer, jpegBytes.byteOffset, jpegBytes.length)];
    return {
        width, height,
        dict: '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        payload, encodedBytes: jpegBytes.length, rawBytes: width * height * 3,
    };
}

/**
 * Priority 2x2 downsample of a 4-bit state raster (artifact-only resolution
 * reduction): unmatched ink beats matched ink beats paper, so a one-pixel
 * change mark cannot vanish. Lossy by construction.
 */
export function downsampledStateRows(ref, oth, dRef, dOth, width, height, factor) {
    const w2 = Math.ceil(width / factor);
    const h2 = Math.ceil(height / factor);
    const rowBytes = (w2 + 1) >> 1;
    const row = new Uint8Array(rowBytes);
    const rank = (s) => (s === 2 ? 2 : s === 1 ? 1 : 0);
    return {
        width: w2, height: h2, rowBytes,
        row(y2) {
            row.fill(0);
            for (let x2 = 0; x2 < w2; x2 += 1) {
                let b0 = 0;
                let b1 = 0;
                for (let dy = 0; dy < factor; dy += 1) {
                    const y = y2 * factor + dy;
                    if (y >= height) break;
                    for (let dx = 0; dx < factor; dx += 1) {
                        const x = x2 * factor + dx;
                        if (x >= width) break;
                        const p = y * width + x;
                        const s0 = ref[p] ? (dOth[p] ? 1 : 2) : 0;
                        const s1 = oth[p] ? (dRef[p] ? 1 : 2) : 0;
                        if (rank(s0) > rank(b0)) b0 = s0;
                        if (rank(s1) > rank(b1)) b1 = s1;
                    }
                }
                const v = b0 * 3 + b1;
                row[x2 >> 1] |= (x2 & 1) ? v : (v << 4);
            }
            return row;
        },
    };
}

export { zlibSync };
