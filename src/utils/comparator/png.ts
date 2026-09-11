/**
 * RGBA8 to PNG, deterministically.
 *
 * The memory budget needs to know what the encoded image costs *before* it is
 * produced, and a formula about `canvas.toBlob` is not a guarantee about it:
 * the browser chooses its own DEFLATE strategy, block layout, IDAT chunking and
 * internal scratch, and exposes none of them. So the encoder is owned. Every
 * parameter below is a constant here rather than a browser's choice, which
 * makes the output size not merely bounded but **exact**.
 *
 * The price is the file size. Stored blocks do not compress, so this writes
 * about 4.001 bytes per pixel where a browser's PNG of the same composite
 * writes about 0.03. That is a deliberate trade of output size for a memory
 * guarantee, and it is why `MAX_OUTPUT_BYTES` admits about seven A4 pages at
 * 300 dpi rather than hundreds.
 *
 * Adopted from `research/m4-comparator-reliability/prototype/candidates.mjs`.
 */

export const PNG_STORED_CONTRACT = {
    colourType: 6, // RGBA
    bitDepth: 8,
    filter: 0, // None, on every row
    deflateStrategy: 'stored',
    maxDeflateBlockBytes: 65535,
    maxIdatChunkBytes: 1 << 20,
} as const;

/**
 * The exact encoded size. Not an estimate.
 *
 * The raster is one filter byte per row plus RGBA. DEFLATE stored blocks add
 * five bytes of header per block; zlib adds a two-byte header and a four-byte
 * Adler-32; the container adds a signature, IHDR, IDAT framing per chunk, and
 * IEND.
 */
export function pngStoredSize(width: number, height: number): number {
    const raster = height * (1 + width * 4);
    const blocks = Math.max(
        1, Math.ceil(raster / PNG_STORED_CONTRACT.maxDeflateBlockBytes),
    );
    const zlib = 2 + blocks * 5 + raster + 4;
    const idatChunks = Math.max(
        1, Math.ceil(zlib / PNG_STORED_CONTRACT.maxIdatChunkBytes),
    );
    return 8 + (12 + 13) + idatChunks * 12 + zlib + 12;
}

/**
 * What the encoder holds while it runs, beyond its output.
 *
 * It streams: it walks the composite a row at a time and writes filter byte and
 * row bytes straight into the stored-block payload. There is no intermediate
 * filtered raster and no intermediate zlib buffer, which is the other half of
 * owning the encoder — a browser's may well allocate both.
 */
export function encoderScratchBytes(width: number): number {
    return 1 + width * 4;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

export class PngEncodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PngEncodeError';
    }
}

/**
 * Encode, or refuse.
 *
 * Hardened over the research prototype: the dimensions and the buffer length
 * have to agree, and the result is asserted to be exactly `pngStoredSize`
 * before it is handed back. An encoder whose output size the budget cannot
 * trust is an encoder the budget cannot use.
 */
export function encodePngStored(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
): Uint8Array {
    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width <= 0 || height <= 0) {
        throw new PngEncodeError(`PNG dimensions must be positive integers: ${width}x${height}`);
    }
    if (pixels.length !== width * height * 4) {
        throw new PngEncodeError(
            `PNG buffer is ${pixels.length} bytes for ${width}x${height} (expected `
            + `${width * height * 4})`,
        );
    }

    const predicted = pngStoredSize(width, height);
    const out = new Uint8Array(predicted);
    let pos = 0;
    const u32 = (value: number) => {
        out[pos] = (value >>> 24) & 0xFF;
        out[pos + 1] = (value >>> 16) & 0xFF;
        out[pos + 2] = (value >>> 8) & 0xFF;
        out[pos + 3] = value & 0xFF;
        pos += 4;
    };
    for (const b of [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        out[pos] = b;
        pos += 1;
    }

    const crcOver = (from: number, to: number) => {
        let crc = 0xFFFFFFFF;
        for (let i = from; i < to; i += 1) {
            crc = CRC_TABLE[(crc ^ out[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };

    const chunk = (type: string, write: () => void) => {
        const lengthAt = pos;
        pos += 4;
        const dataStart = pos;
        for (let i = 0; i < 4; i += 1) {
            out[pos] = type.charCodeAt(i);
            pos += 1;
        }
        write();
        const dataEnd = pos;
        const saved = pos;
        pos = lengthAt;
        u32(dataEnd - dataStart - 4);
        pos = saved;
        u32(crcOver(dataStart, dataEnd));
    };

    chunk('IHDR', () => {
        u32(width);
        u32(height);
        out[pos] = PNG_STORED_CONTRACT.bitDepth;
        out[pos + 1] = PNG_STORED_CONTRACT.colourType;
        out[pos + 2] = 0;
        out[pos + 3] = 0;
        out[pos + 4] = 0;
        pos += 5;
    });

    const raster = height * (1 + width * 4);
    const blockMax = PNG_STORED_CONTRACT.maxDeflateBlockBytes;
    const blocks = Math.max(1, Math.ceil(raster / blockMax));
    const zlibLength = 2 + blocks * 5 + raster + 4;
    const idatMax = PNG_STORED_CONTRACT.maxIdatChunkBytes;

    let zlibWritten = 0;
    let chunkRemaining = 0;
    let chunkStart = 0;
    let chunkLengthAt = 0;
    let chunksOpened = 0;

    const closeChunk = () => {
        const dataEnd = pos;
        const saved = pos;
        pos = chunkLengthAt;
        u32(dataEnd - chunkStart - 4);
        pos = saved;
        u32(crcOver(chunkStart, dataEnd));
    };
    const openChunk = () => {
        chunkLengthAt = pos;
        pos += 4;
        chunkStart = pos;
        for (let i = 0; i < 4; i += 1) {
            out[pos] = 'IDAT'.charCodeAt(i);
            pos += 1;
        }
        chunksOpened += 1;
        chunkRemaining = Math.min(idatMax, zlibLength - zlibWritten);
    };
    const push = (byte: number) => {
        if (chunkRemaining === 0) {
            if (chunksOpened > 0) closeChunk();
            openChunk();
        }
        out[pos] = byte;
        pos += 1;
        chunkRemaining -= 1;
        zlibWritten += 1;
    };

    push(0x78);
    push(0x01);
    let adlerA = 1;
    let adlerB = 0;
    let blockRemaining = 0;
    let rasterRemaining = raster;
    const pushRaster = (byte: number) => {
        if (blockRemaining === 0) {
            const take = Math.min(blockMax, rasterRemaining);
            // BFINAL is set on the block that carries the last raster byte.
            push(rasterRemaining === take ? 1 : 0);
            push(take & 0xFF);
            push((take >>> 8) & 0xFF);
            push(~take & 0xFF);
            push((~take >>> 8) & 0xFF);
            blockRemaining = take;
        }
        push(byte);
        blockRemaining -= 1;
        rasterRemaining -= 1;
        adlerA = (adlerA + byte) % 65521;
        adlerB = (adlerB + adlerA) % 65521;
    };

    for (let y = 0; y < height; y += 1) {
        pushRaster(0);
        const rowStart = y * width * 4;
        for (let i = 0; i < width * 4; i += 1) pushRaster(pixels[rowStart + i]);
    }
    for (const byte of [
        (adlerB >>> 8) & 0xFF, adlerB & 0xFF, (adlerA >>> 8) & 0xFF, adlerA & 0xFF,
    ]) push(byte);
    closeChunk();

    chunk('IEND', () => { /* empty */ });

    if (pos !== predicted) {
        throw new PngEncodeError(
            `PNG encoder wrote ${pos} bytes where the contract predicts ${predicted}`,
        );
    }
    return out;
}
