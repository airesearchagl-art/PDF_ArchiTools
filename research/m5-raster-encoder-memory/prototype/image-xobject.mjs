/**
 * E3, implemented: an image XObject this architecture owns end to end.
 *
 * pdf-lib will write a stream exactly as given (`context.stream`) or deflate it
 * with its own pinned pako (`context.flateStream`). Neither path decodes, and
 * neither involves a browser encoder, so the bytes in the file are either the
 * samples themselves — exact, known before the page is rendered — or a deflate
 * of them, bounded by DEFLATE's stored-block worst case.
 *
 * This is a prototype. It does not touch `src/`, and nothing here is adopted.
 */
import {
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

/** RGBA readback to DeviceGray samples, in place of a colour conversion pass. */
export function rgbaToGray(rgba, { contrast = 1 } = {}) {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
        const grey = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        const v = contrast === 1 ? grey : (grey - 128) * contrast + 128;
        out[j] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return out;
}

/** RGBA readback to DeviceRGB samples: the alpha channel is dropped. */
export function rgbaToRgb(rgba) {
    const out = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
        out[j] = rgba[i];
        out[j + 1] = rgba[i + 1];
        out[j + 2] = rgba[i + 2];
        j += 3;
    }
    return out;
}

/**
 * Write one full-page image XObject and draw it over the whole page.
 *
 * `colourSpace` is 'DeviceGray' (1 sample per pixel) or 'DeviceRGB' (3).
 * `filter` is 'none' — the samples are the stream — or 'flate'.
 */
export function drawFullPageImage(doc, page, {
    samples, width, height, colourSpace, filter = 'none',
}) {
    const components = colourSpace === 'DeviceGray' ? 1 : 3;
    if (samples.length !== width * height * components) {
        throw new Error(
            `${colourSpace} needs ${width * height * components} samples for ${width}x${height}, got ${samples.length}`,
        );
    }
    const dict = {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        BitsPerComponent: 8,
        ColorSpace: colourSpace,
    };
    const stream = filter === 'flate'
        ? doc.context.flateStream(samples, dict)
        : doc.context.stream(samples, dict);
    const ref = doc.context.register(stream);
    const name = page.node.newXObject('M5Img', ref);
    const { width: pw, height: ph } = page.getSize();
    // `drawObject` takes a PDFName as it is (api/objects.js: asPDFName).
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(pw, 0, 0, ph, 0, 0),
        drawObject(name),
        popGraphicsState(),
    );
    return { streamBytes: samples.length, name: String(name) };
}

/**
 * The whole owned path for one page, for the harness to run against the same
 * canvas production uses: read back, convert, write, and report exactly what
 * each step cost.
 */
export function encodeOwnedPage(doc, page, ctx, { width, height, colourSpace, filter, contrast }) {
    const readback = ctx.getImageData(0, 0, width, height);
    const samples = colourSpace === 'DeviceGray'
        ? rgbaToGray(readback.data, { contrast })
        : rgbaToRgb(readback.data);
    const drawn = drawFullPageImage(doc, page, {
        samples, width, height, colourSpace, filter,
    });
    return {
        readbackBytes: readback.data.length,
        sampleBytes: samples.length,
        streamBytes: drawn.streamBytes,
        colourSpace,
        filter,
    };
}
