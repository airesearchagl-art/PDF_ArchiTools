/**
 * Doing the work, once the plan says it may be done.
 *
 * Every runner here takes bytes and returns bytes, and none of them decides
 * whether it should run: that was settled by `planOperation` before anything
 * was allocated. What they do own is the ordering that the memory contract
 * depends on — release the canvas before the samples exist, probe before
 * rendering, re-check ownership at each page boundary — and the promise that a
 * document comes back carrying what it came in with.
 *
 * Adopted: H1, H2a, H8, H9, H10, H12, H13a, H13b.
 */
import { PDFDocument, PDFName, PDFNumber, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { configurePdfWorker } from '../pdf-worker-source';
import { PLAN_STATUS, ProcessorError } from './contracts';
import type { ProcessorOperation } from './contracts';
import type { RunToken } from './ownership';
import { applyMetadata, metadataGaps, readMetadata } from './metadata';
import {
    drawFullPageImage, probeCanvasAllocation, releaseCanvas, samplesFromCanvas,
} from './raster-xobject';
import { RASTER_ENCODING } from './planner';
import { marginInPlace } from './margin-transform';
import type { MarginOptions } from './margin-transform';

export interface FlattenSettings {
    dpi: number;
    contrast: number;
}

export interface LayerSettings {
    /** Hex, as the UI holds it. */
    color: string;
    opacity: number;
}

const hexToRgb = (hex: string) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m
        ? { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 }
        : { r: 1, g: 1, b: 1 };
};

/** A token is optional so the gate can drive a runner without a UI. */
const check = (token?: RunToken) => { token?.assertCurrent(); };

/**
 * Replace every page with a picture of itself, through the path H8 adopted.
 *
 * There is no `toDataURL`, no base64 and no browser encoder anywhere in here:
 * the samples the canvas already holds become the image XObject, DeviceGray at
 * one byte a pixel, deflated by the pako pdf-lib pins.
 */
export async function runFlatten(
    bytes: Uint8Array,
    operation: ProcessorOperation,
    settings: FlattenSettings,
    token?: RunToken,
): Promise<Uint8Array> {
    const encoding = RASTER_ENCODING[operation];
    if (!encoding) throw new ProcessorError('この操作は画像化を行いません。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);

    // The metadata is read from the source before it is replaced, so the new
    // document can be given it back. H12.
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const metadata = readMetadata(source);

    configurePdfWorker();
    const rendered = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const out = await PDFDocument.create({ updateMetadata: false });

    try {
        for (let i = 1; i <= rendered.numPages; i += 1) {
            check(token);
            const page = await rendered.getPage(i);
            const viewport = page.getViewport({ scale: settings.dpi / 72 });
            const widthPx = Math.floor(viewport.width);
            const heightPx = Math.floor(viewport.height);

            // The machine's own answer, asked before the work rather than
            // discovered in the middle of it. H9.
            if (!probeCanvasAllocation(widthPx, heightPx)) {
                throw new ProcessorError(
                    `この解像度（${settings.dpi} dpi、${widthPx}×${heightPx}px）では`
                    + 'ブラウザが描画領域を確保できませんでした。解像度を下げて実行してください。',
                    PLAN_STATUS.CANVAS_UNAVAILABLE,
                );
            }

            const canvas = document.createElement('canvas');
            canvas.width = widthPx;
            canvas.height = heightPx;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                releaseCanvas(canvas);
                throw new ProcessorError(
                    '描画コンテキストを取得できませんでした。',
                    PLAN_STATUS.CANVAS_UNAVAILABLE,
                );
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await page.render({ canvasContext: ctx, viewport } as any).promise;
            page.cleanup();

            // Releases the canvas before the sample buffer is allocated.
            const { samples } = samplesFromCanvas(
                ctx, widthPx, heightPx, encoding.colourSpace, settings.contrast,
            );

            const pdfPage = out.addPage([
                viewport.width * (72 / settings.dpi),
                viewport.height * (72 / settings.dpi),
            ]);
            drawFullPageImage(out, pdfPage, {
                samples,
                widthPx,
                heightPx,
                colourSpace: encoding.colourSpace,
                filter: encoding.filter,
            });
            check(token);
        }
    } finally {
        await rendered.destroy();
    }

    // H12, enforced rather than attempted. `applyMetadata` reports what it could
    // not carry — an Info value held by reference to an object that is not
    // there, a value no copy can move safely, a `/Metadata` that is not a
    // stream — and none of those may end as a file the person is handed while
    // the thing they came in with is missing from it.
    const problems = applyMetadata(out, metadata);
    if (problems.length > 0) {
        throw new ProcessorError(
            `元のPDFのメタデータを引き継げなかったため、処理を中止しました: ${problems.join(' / ')}`,
            PLAN_STATUS.METADATA_NOT_PRESERVED,
        );
    }

    const saved = await out.save({ useObjectStreams: false });

    // And then read back, because applying is a claim and the file is the fact.
    // The XMP defect this gate caught last round applied without error and
    // produced a document whose metadata was deflate data calling itself XML;
    // only reopening the bytes could tell the difference.
    const gaps = metadataGaps(metadata, readMetadata(
        await PDFDocument.load(saved, { updateMetadata: false }),
    ));
    if (gaps.length > 0) {
        throw new ProcessorError(
            `書き出したPDFに元のメタデータが残っていませんでした: ${gaps.join('、')}`,
            PLAN_STATUS.METADATA_NOT_PRESERVED,
        );
    }
    return saved;
}

/**
 * 半透明レイヤ追加, over the page anyone can see.
 *
 * H13a: the overlay covers CropBox ∩ MediaBox, in the page's own coordinates.
 * The old code drew at (0,0) with the page's width and height, so a document
 * whose MediaBox did not start at the origin got a layer over 39% of its ink
 * and nothing over the rest.
 *
 * H13b: it stays in the content stream, which is what puts it *below* every
 * annotation. Making it an annotation to paint it on top would change what the
 * overlay is — selectable, deletable, printable on its own flag — so the tool
 * keeps the honest version and the UI says so.
 */
export async function runLayer(
    bytes: Uint8Array,
    settings: LayerSettings,
    token?: RunToken,
): Promise<Uint8Array> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const { r, g, b } = hexToRgb(settings.color);
    for (const page of doc.getPages()) {
        check(token);
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        const x = Math.max(media.x, crop.x);
        const y = Math.max(media.y, crop.y);
        const width = Math.min(media.x + media.width, crop.x + crop.width) - x;
        const height = Math.min(media.y + media.height, crop.y + crop.height) - y;
        if (!(width > 0 && height > 0)) {
            throw new ProcessorError(
                'このページの表示領域を決められませんでした。',
                PLAN_STATUS.UNSUPPORTED_DOCUMENT,
            );
        }
        page.drawRectangle({
            x, y, width, height, color: rgb(r, g, b), opacity: settings.opacity,
        });
    }
    return doc.save({ useObjectStreams: false });
}

/**
 * 最適化, as H2a defines it: **lossless**.
 *
 * The old implementation rasterised every page at a chosen DPI, which removed
 * the text, the vectors and the structure, and made vector drawings 11–153×
 * *larger* at its default. It was not an optimisation; it was a flattening with
 * a misleading name.
 *
 * This one re-saves the document with pdf-lib's object streams and cross-
 * reference stream, which is a structural saving and nothing else. Nothing is
 * re-encoded and no image is touched. If the result is not actually smaller,
 * the **source bytes are returned unchanged** — returning a larger file from a
 * tool called 最適化 is the behaviour being corrected, so it is not repeated
 * in a smaller way.
 */
export async function runOptimizeLossless(
    bytes: Uint8Array,
    token?: RunToken,
): Promise<{ bytes: Uint8Array; changed: boolean }> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    check(token);
    const saved = await doc.save({ useObjectStreams: true });
    if (saved.length >= bytes.length) return { bytes, changed: false };
    return { bytes: saved, changed: true };
}

/** 余白生成 — in place, with the refusals stated in `margin-transform`. */
export async function runMargin(
    bytes: Uint8Array,
    options: MarginOptions,
    token?: RunToken,
): Promise<Uint8Array> {
    check(token);
    const out = await marginInPlace(bytes, options);
    check(token);
    return out;
}

/**
 * 両方実行 — Monochrome, then the overlay, with the same safety contract.
 *
 * Composed here rather than in the component so that it cannot drift into a
 * weaker path: the flattening half is the adopted one, and the overlay half is
 * the corrected one.
 */
export async function runBoth(
    bytes: Uint8Array,
    flatten: FlattenSettings,
    layer: LayerSettings,
    token?: RunToken,
): Promise<Uint8Array> {
    const flattened = await runFlatten(bytes, 'monochrome', flatten, token);
    return runLayer(flattened, layer, token);
}

/**
 * Whether a rebuilt document still carries what the source did.
 *
 * Used by the gate rather than by the UI: a readback is the only way to tell a
 * metadata *claim* from a metadata *fact*, and H12 is about the fact.
 */
export async function readbackMetadata(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const meta = readMetadata(doc);
    const catalog = doc.catalog.get(PDFName.of('Metadata'));
    return { meta, hasXmpEntry: catalog !== undefined };
}

/** Page count without paying for a render. */
export async function pageCountOf(bytes: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount();
}

/** Exposed for the gate: what a page's /Rotate says after an operation. */
export async function rotationsOf(bytes: Uint8Array): Promise<number[]> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPages().map((p) => {
        const raw = p.node.get(PDFName.of('Rotate'));
        return raw instanceof PDFNumber ? raw.asNumber() : 0;
    });
}
