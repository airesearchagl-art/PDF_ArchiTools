/**
 * E3, implemented: an image XObject this architecture owns end to end.
 *
 * pdf-lib writes a stream exactly as handed to it (`context.stream`) or
 * deflates it with its own pinned pako (`context.flateStream`). Neither path
 * decodes, and neither involves a browser encoder.
 *
 * The ordering matters as much as the encoder. `getImageData` needs the canvas,
 * but nothing after it does — so the canvas is released the moment the readback
 * exists, before any sample buffer is allocated. That is what makes the peak
 * the readback (8 B/px) instead of the readback plus the samples on top of a
 * canvas nobody is using any more. The first version of this prototype kept the
 * canvas alive to the end; `ordering: 'canvas-held'` reproduces that so the gate
 * can show the difference rather than assert it.
 *
 * This is a prototype. It does not touch `src/`, and nothing here is adopted.
 */
import {
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

export const ORDERING = { HELD: 'canvas-held', RELEASED: 'canvas-released' };

/** Drop a canvas's backing store. A zero-sized canvas holds no pixels. */
export function releaseCanvas(canvas) {
    canvas.width = 0;
    canvas.height = 0;
}

/** RGBA readback to DeviceGray samples. */
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
 * Returns the `PDFRawStream` itself, so a caller can read what was actually
 * stored — `getContentsSize()` — instead of assuming the samples' length.
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
    return {
        stream,
        /** What the PDF actually carries, read back from the object. */
        storedBytes: stream.getContentsSize(),
        /** Whether pdf-lib kept the very array we handed it (no copy on the write path). */
        sameArray: filter === 'none' && stream.getContents() === samples,
        name: String(name),
    };
}

/**
 * The whole owned path for one page, in a stated order, reporting what was live
 * at each step so the model can be checked against the code rather than assumed.
 */
export function encodeOwnedPage(doc, page, ctx, {
    width, height, colourSpace, filter, contrast, ordering = ORDERING.RELEASED,
}) {
    const canvas = ctx.canvas;
    const canvasBytes = canvas.width * canvas.height * 4;
    const readback = ctx.getImageData(0, 0, width, height);
    const readbackBytes = readback.data.length;

    let canvasLiveDuringConvert = canvasBytes;
    if (ordering === ORDERING.RELEASED) {
        releaseCanvas(canvas);
        canvasLiveDuringConvert = 0;
    }

    const samples = colourSpace === 'DeviceGray'
        ? rgbaToGray(readback.data, { contrast })
        : rgbaToRgb(readback.data);

    // `readback` is still referenced by this frame while `drawFullPageImage`
    // runs, and with `filter: 'flate'` that call deflates synchronously.
    // Nothing in JavaScript promises the ImageData is collected in between, so
    // the model prices the deflate step with it live. Releasing it would be a
    // restructuring a production implementation could make — and would have to
    // make explicitly, and prove — before claiming the smaller number.
    const drawn = drawFullPageImage(doc, page, { samples, width, height, colourSpace, filter });

    return {
        ordering,
        canvasBytes,
        readbackBytes,
        sampleBytes: samples.length,
        /** The live set while the samples were being allocated and filled. */
        convertLiveBytes: canvasLiveDuringConvert + readbackBytes + samples.length,
        canvasReleasedBeforeConvert: canvasLiveDuringConvert === 0,
        canvasWidthAfter: canvas.width,
        storedBytes: drawn.storedBytes,
        sameArray: drawn.sameArray,
        colourSpace,
        filter,
    };
}
