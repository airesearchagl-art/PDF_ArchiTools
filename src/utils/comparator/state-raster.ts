/**
 * A comparison visual as the few colours it actually has.
 *
 * `paintPair` colours every pixel from two layers, each of which is either
 * paper, ink matched by the other member, or ink the other member does not
 * have (engine.ts:163-204). Nine states, so nine colours at most: the
 * Comparison PDF can carry the visual as a 4-bit Indexed image and decode to
 * exactly the RGB the composite holds, with no loss and no change of
 * resolution.
 *
 * The palette is not written down here. It is obtained by asking `paintPair`
 * (passed in, so this module stays free of the engine and the budget can
 * import its arithmetic) to paint one pixel in each state, so the file can never drift from the
 * compositor. A composite pixel whose colour is not in that palette is a
 * contract violation, and encoding refuses rather than approximating it.
 */
import { OwnedZlib, ownedDeflateBound, ownedDeflateScratchBytes } from './deflate';

export type Rgb = [number, number, number];

/** engine.ts `paintPair`'s signature. */
export type PaintPair = (
    reference: Uint8Array,
    other: Uint8Array,
    dilatedReference: Uint8Array,
    dilatedOther: Uint8Array,
    referenceColor: Rgb,
    otherColor: Rgb,
    width: number,
    height: number,
    matchColor: Rgb,
    matchOpacity: number,
) => Uint8ClampedArray;

/** The colours `paintPair` was asked to use for one pair. */
export interface PairPaint {
    referenceColor: Rgb;
    otherColor: Rgb;
    matchColor: Rgb;
    matchOpacity: number;
}

export const INDEXED_BITS_PER_COMPONENT = 4;
export const STATE_COUNT = 9;

/** One byte ahead of every row: the PNG predictor tag (ISO 32000-1 7.4.4.4). */
export const PREDICTOR_UP = 2;

/**
 * The palette, index = s0 * 3 + s1, where each layer's state is
 * 0 paper, 1 ink matched by the other member, 2 ink the other member lacks.
 */
export function statePalette(paintPair: PaintPair, paint: PairPaint): Rgb[] {
    const ref = new Uint8Array(STATE_COUNT);
    const other = new Uint8Array(STATE_COUNT);
    const dilatedRef = new Uint8Array(STATE_COUNT);
    const dilatedOther = new Uint8Array(STATE_COUNT);
    for (let s0 = 0; s0 < 3; s0 += 1) {
        for (let s1 = 0; s1 < 3; s1 += 1) {
            const p = s0 * 3 + s1;
            ref[p] = s0 > 0 ? 1 : 0;
            other[p] = s1 > 0 ? 1 : 0;
            // paintPair reads a layer as matched when the *other* layer's
            // dilation covers the pixel.
            dilatedOther[p] = s0 === 1 ? 1 : 0;
            dilatedRef[p] = s1 === 1 ? 1 : 0;
        }
    }
    const px = paintPair(
        ref, other, dilatedRef, dilatedOther,
        paint.referenceColor, paint.otherColor, STATE_COUNT, 1,
        paint.matchColor, paint.matchOpacity,
    );
    const palette: Rgb[] = [];
    for (let p = 0; p < STATE_COUNT; p += 1) palette.push([px[p * 4], px[p * 4 + 1], px[p * 4 + 2]]);
    return palette;
}

/** Bytes in one 4-bit row, before its predictor byte. */
export function indexedRowBytes(width: number): number {
    return Math.ceil(width / 2);
}

/** Bytes the compressor receives for an indexed image: predictor byte + row, per row. */
export function indexedStreamInputBytes(width: number, height: number): number {
    return (indexedRowBytes(width) + 1) * height;
}

/** Bytes the compressor receives for a DeviceRGB image. */
export function rgbStreamInputBytes(width: number, height: number): number {
    return (width * 3 + 1) * height;
}

/**
 * Every buffer one image encode allocates besides the source pixels and its
 * output: the source row, the filtered line, the previous row, and the
 * compressor's own fixed buffers.
 */
export function streamEncoderScratchBytes(rowBytes: number): number {
    return rowBytes + (rowBytes + 1) + rowBytes + ownedDeflateScratchBytes(rowBytes + 1);
}

/** Output chunks are separate Uint8Arrays; this bounds each one's object overhead. */
export const CHUNK_OBJECT_BYTES = 256;
const OUTPUT_CHUNK = 65536;

/** The most one encoded image stream can hold in memory, chunk objects included. */
export function streamRetainedBound(inputBytes: number): number {
    const bytes = ownedDeflateBound(inputBytes);
    return bytes + Math.ceil(bytes / OUTPUT_CHUNK) * CHUNK_OBJECT_BYTES;
}

/** How an encode gives the event loop, and a cancellation, their turn. */
export interface EncodeControl {
    /** Called at block boundaries; resolves when the encoder may continue. */
    atBlock?: () => Promise<void>;
    /** Checked after every yield; false stops the encode, which returns null. */
    shouldContinue?: () => boolean;
    /** Called with the running compressed size; may throw to stop the encode. */
    onBytes?: (encodedSoFar: number) => void;
}

export interface EncodedImage {
    width: number;
    height: number;
    /** The image dictionary's entries after /Width and /Height. */
    dict: string;
    chunks: Uint8Array[];
    encodedBytes: number;
    inputBytes: number;
    bound: number;
}

export class PaletteMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PaletteMismatchError';
    }
}

function hexPalette(palette: Rgb[]): string {
    return palette.map((c) => c.map((v) => v.toString(16).padStart(2, '0')).join('')).join('');
}

function decodeParms(colors: number, bitsPerComponent: number, columns: number): string {
    return `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${bitsPerComponent} /Columns ${columns} >>`;
}

/**
 * Rows through the Up predictor into the owned compressor, yielding at block
 * boundaries. `fillRow(y, out)` writes row y's bytes into `out`.
 */
async function encodeRows(
    height: number,
    rowBytes: number,
    fillRow: (y: number, out: Uint8Array) => void,
    control: EncodeControl,
): Promise<{ chunks: Uint8Array[]; encodedBytes: number; inputBytes: number } | null> {
    const chunks: Uint8Array[] = [];
    let encodedSoFar = 0;
    const zlib = new OwnedZlib(rowBytes + 1, (chunk) => {
        chunks.push(chunk);
        encodedSoFar += chunk.length;
        control.onBytes?.(encodedSoFar);
    });
    const row = new Uint8Array(rowBytes);
    const prev = new Uint8Array(rowBytes);
    const line = new Uint8Array(rowBytes + 1);
    line[0] = PREDICTOR_UP;
    let blocks = zlib.blocksWritten;
    for (let y = 0; y < height; y += 1) {
        fillRow(y, row);
        for (let i = 0; i < rowBytes; i += 1) line[i + 1] = (row[i] - prev[i]) & 0xFF;
        prev.set(row);
        zlib.push(line);
        if (zlib.blocksWritten !== blocks) {
            blocks = zlib.blocksWritten;
            if (control.atBlock) {
                await control.atBlock();
                if (control.shouldContinue && !control.shouldContinue()) return null;
            }
        }
    }
    const result = zlib.finish();
    control.onBytes?.(result.encodedBytes);
    return { chunks, encodedBytes: result.encodedBytes, inputBytes: result.inputBytes };
}

/**
 * An RGBA composite as a 4-bit Indexed image stream. Null when the control
 * cancelled it. Throws `PaletteMismatchError` on a colour the palette lacks.
 */
export async function encodeIndexedImage(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    palette: Rgb[],
    control: EncodeControl = {},
): Promise<EncodedImage | null> {
    if (palette.length > 1 << INDEXED_BITS_PER_COMPONENT) {
        throw new PaletteMismatchError(`palette of ${palette.length} does not fit ${INDEXED_BITS_PER_COMPONENT} bits`);
    }
    const index = new Map<number, number>();
    palette.forEach(([r, g, b], i) => {
        const key = (r << 16) | (g << 8) | b;
        if (!index.has(key)) index.set(key, i);
    });
    const rowBytes = indexedRowBytes(width);
    const encoded = await encodeRows(height, rowBytes, (y, out) => {
        out.fill(0);
        let p = y * width * 4;
        for (let x = 0; x < width; x += 1, p += 4) {
            const v = index.get((pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2]);
            if (v === undefined) {
                throw new PaletteMismatchError(
                    `pixel ${x},${y} is rgb(${pixels[p]},${pixels[p + 1]},${pixels[p + 2]}), `
                    + 'which paintPair does not produce for this pair',
                );
            }
            out[x >> 1] |= (x & 1) ? v : (v << 4);
        }
    }, control);
    if (!encoded) return null;
    return {
        width,
        height,
        dict: `/ColorSpace [/Indexed /DeviceRGB ${palette.length - 1} <${hexPalette(palette)}>] `
            + `/BitsPerComponent ${INDEXED_BITS_PER_COMPONENT} /Filter /FlateDecode `
            + decodeParms(1, INDEXED_BITS_PER_COMPONENT, width),
        chunks: encoded.chunks,
        encodedBytes: encoded.encodedBytes,
        inputBytes: encoded.inputBytes,
        bound: ownedDeflateBound(encoded.inputBytes),
    };
}

/** An opaque RGBA raster (a notice) as a DeviceRGB image stream. Null when cancelled. */
export async function encodeRgbImage(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    control: EncodeControl = {},
): Promise<EncodedImage | null> {
    const rowBytes = width * 3;
    const encoded = await encodeRows(height, rowBytes, (y, out) => {
        let p = y * width * 4;
        for (let o = 0; o < rowBytes; o += 3, p += 4) {
            out[o] = pixels[p];
            out[o + 1] = pixels[p + 1];
            out[o + 2] = pixels[p + 2];
        }
    }, control);
    if (!encoded) return null;
    return {
        width,
        height,
        dict: `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ${decodeParms(3, 8, width)}`,
        chunks: encoded.chunks,
        encodedBytes: encoded.encodedBytes,
        inputBytes: encoded.inputBytes,
        bound: ownedDeflateBound(encoded.inputBytes),
    };
}
