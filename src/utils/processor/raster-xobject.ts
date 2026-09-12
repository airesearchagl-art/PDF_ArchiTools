/**
 * The adopted H8 encoding path: an image XObject this codebase owns.
 *
 * The production path used to be canvas → `toDataURL('image/jpeg', 0.8)` →
 * base64 → `embedJpg`. That encoder is the browser's: its output size can only
 * be observed after the fact and its working memory is bounded by nothing, so
 * no memory contract could be honoured through it. The Gate closed H8 by
 * removing the encoder instead of bounding it.
 *
 * pdf-lib writes a stream exactly as it is handed one — `typedArrayFor` returns
 * a `Uint8Array` unchanged (arrays.js:9-11) and `PDFRawStream` assigns it
 * (PDFRawStream.js:10) — so the samples the page already holds become the
 * image. `DeviceGray` is 1 byte a pixel and `DeviceRGB` is 3, exactly, known
 * before the page is rendered; `FlateDecode` trades that exactness for a bound
 * derived from the pinned pako.
 *
 * Two orderings matter as much as the encoder, and both are deliberate here:
 *
 *  - the canvas backing store is released as soon as `getImageData` has
 *    returned, **before** any sample buffer is allocated (11 B/px against 7 at
 *    conversion, and 91.2 MiB against 66.4 at A4 300 dpi);
 *  - the readback is still reachable while `flateStream` runs, which is why the
 *    budget prices it there rather than pretending it has been collected.
 *
 * Adopted: H8-A (DeviceGray + FlateDecode), H8-B (DeviceRGB raw), H9 probe.
 */
import {
    concatTransformationMatrix,
    drawObject,
    popGraphicsState,
    pushGraphicsState,
} from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { ColourSpace, StreamFilter } from './budget';
import { COMPONENTS } from './budget';

/** Drop a canvas's backing store. A zero-sized canvas holds no pixels. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
}

/**
 * Will this machine give us a canvas of this size at all?
 *
 * The pixel ceiling is a portable policy; this is the machine's own answer, and
 * it is asked **before** the page is rendered rather than discovered halfway
 * through. A browser that refuses the allocation returns a blank canvas rather
 * than throwing, so the probe writes two pixels and reads one back.
 */
export function probeCanvasAllocation(widthPx: number, heightPx: number): boolean {
    let canvas: HTMLCanvasElement | null = null;
    try {
        canvas = document.createElement('canvas');
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 2, 2);
        return ctx.getImageData(0, 0, 1, 1).data[3] === 255;
    } catch {
        return false;
    } finally {
        if (canvas) releaseCanvas(canvas);
    }
}

/** RGBA readback to DeviceGray samples, with the operation's contrast. */
export function rgbaToGray(rgba: Uint8ClampedArray, contrast = 1): Uint8Array {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
        const grey = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        const v = contrast === 1 ? grey : (grey - 128) * contrast + 128;
        out[j] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return out;
}

/** RGBA readback to DeviceRGB samples: the alpha channel is dropped. */
export function rgbaToRgb(rgba: Uint8ClampedArray): Uint8Array {
    const out = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
        out[j] = rgba[i];
        out[j + 1] = rgba[i + 1];
        out[j + 2] = rgba[i + 2];
        j += 3;
    }
    return out;
}

export interface DrawnImage {
    /** What the PDF actually carries, read back from the object. */
    storedBytes: number;
    colourSpace: ColourSpace;
    filter: StreamFilter;
}

/**
 * Write one full-page image XObject and draw it over the whole page.
 *
 * No base64 and no browser encoder is involved at any point.
 */
export function drawFullPageImage(
    doc: PDFDocument,
    page: PDFPage,
    options: {
        samples: Uint8Array;
        widthPx: number;
        heightPx: number;
        colourSpace: ColourSpace;
        filter: StreamFilter;
    },
): DrawnImage {
    const { samples, widthPx, heightPx, colourSpace, filter } = options;
    const expected = widthPx * heightPx * COMPONENTS[colourSpace];
    if (samples.length !== expected) {
        throw new Error(
            `${colourSpace} needs ${expected} samples for ${widthPx}x${heightPx}, got ${samples.length}`,
        );
    }

    const dict = {
        Type: 'XObject',
        Subtype: 'Image',
        Width: widthPx,
        Height: heightPx,
        BitsPerComponent: 8,
        ColorSpace: colourSpace,
    };
    const stream = filter === 'flate'
        ? doc.context.flateStream(samples, dict)
        : doc.context.stream(samples, dict);
    const ref = doc.context.register(stream);
    const name = page.node.newXObject('ProcImg', ref);
    const { width, height } = page.getSize();
    // `drawObject` takes a PDFName as it is (api/objects.ts: asPDFName).
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(width, 0, 0, height, 0, 0),
        drawObject(name),
        popGraphicsState(),
    );
    return { storedBytes: stream.getContentsSize(), colourSpace, filter };
}

/**
 * Read a rendered canvas back and turn it into samples, releasing the canvas
 * before the sample buffer exists.
 *
 * The order of the three statements below is the memory contract. Moving the
 * release after the conversion costs a third of the peak.
 */
export function samplesFromCanvas(
    ctx: CanvasRenderingContext2D,
    widthPx: number,
    heightPx: number,
    colourSpace: ColourSpace,
    contrast = 1,
): { samples: Uint8Array; readback: ImageData } {
    const readback = ctx.getImageData(0, 0, widthPx, heightPx);
    releaseCanvas(ctx.canvas);
    const samples = colourSpace === 'DeviceGray'
        ? rgbaToGray(readback.data, contrast)
        : rgbaToRgb(readback.data);
    return { samples, readback };
}
