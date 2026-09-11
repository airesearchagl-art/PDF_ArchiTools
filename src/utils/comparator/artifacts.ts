/**
 * The two files, built one way, for the app and for the gates alike.
 *
 * The preflight prices every item an artifact will contain, in a sequence of
 * allocations and releases (`itemCost` in budget.ts). That price is only true
 * while the code that builds the file keeps to the sequence, so the code lives
 * here, once: the UI calls it, and the gates call exactly the same thing and
 * then measure the jsPDF document it produced.
 *
 * The container is jsPDF 3.0.4 and nothing else; the model is bound to it, and
 * a different version is refused rather than trusted.
 */
import jsPDF, { type jsPDFOptions } from 'jspdf';
import {
    ARTIFACT_ITEM,
    NOTICE_RASTER,
    PLAN,
    RESULT,
    type ArtifactItemKind,
} from './contract';
import { JSPDF_CONTAINER } from './budget';
import { RasterShapeError, assertRaster } from './mask';
import { encodePngStored } from './png';
import type { PageResult, PairResult } from './engine';

type FileKind = keyof typeof NOTICE_RASTER;

/** The container version the running bundle actually carries. */
export function containerVersion(): string {
    return jsPDF.version;
}

/** What was written, in the order it was written. */
export interface AppendedItem {
    kind: ArtifactItemKind;
    page: number;
    slot: number | null;
    width: number;
    height: number;
    alias: string;
    encodedBytes: number;
}

export interface ArtifactSink {
    kind: FileKind;
    doc: jsPDF;
    appended: AppendedItem[];
    onPair: (pair: PairResult) => void;
    onPage: (page: PageResult) => void;
    save: (filename: string) => void;
}

/**
 * Every raster handed to jsPDF is opaque, because jsPDF writes an SMask string
 * the size of the alpha channel for one that is not (jspdf.es.js:14963-14965)
 * and the model has no term for it. Checked, not assumed.
 */
function assertOpaque(pixels: Uint8ClampedArray, what: string): void {
    for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] !== 255) {
            throw new RasterShapeError(`${what}: pixel ${(i - 3) / 4} is not opaque`);
        }
    }
}

/** The owned PNG of an opaque raster. */
function encodeOpaque(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    what: string,
): Uint8Array {
    assertRaster(pixels, width, height, 4, what);
    assertOpaque(pixels, what);
    return encodePngStored(pixels, width, height);
}

/**
 * One rectangle of a composite, copied row by row.
 *
 * The same pixels the old canvas `drawImage` produced for a whole-pixel crop at
 * one-to-one, without the two canvases it needed to produce them.
 */
export function cropRgba(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    bounds: { x: number; y: number; width: number; height: number },
): Uint8ClampedArray<ArrayBuffer> {
    assertRaster(pixels, width, height, 4, 'crop source');
    if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
        || bounds.x + bounds.width > width || bounds.y + bounds.height > height) {
        throw new RasterShapeError(
            `crop ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} `
            + `is outside a ${width}x${height} frame`,
        );
    }
    const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
    const row = bounds.width * 4;
    for (let y = 0; y < bounds.height; y += 1) {
        const from = ((bounds.y + y) * width + bounds.x) * 4;
        out.set(pixels.subarray(from, from + row), y * row);
    }
    return out;
}

/** What a notice says: the page, its state, and each reason. */
export function noticeLines(page: PageResult): string[] {
    return [`Page ${page.page} — ${page.status}`, ...page.reported];
}

/**
 * A notice, rendered as an image.
 *
 * jsPDF's standard fonts have no Japanese glyphs, so text written through them
 * would reach the artifact as boxes or as nothing — and a missing page the user
 * cannot read about has been lost as surely as one that was deleted. Drawing it
 * on a canvas uses the system's own text stack, and the result goes into the
 * PDF through the same owned encoder as everything else.
 */
export function drawNotice(
    lines: string[],
    raster: { width: number; height: number },
): Uint8ClampedArray {
    const { width, height } = raster;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#333333';
    ctx.font = '32px sans-serif';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, 60, 80 + i * 52, width - 120));
    const pixels = ctx.getImageData(0, 0, width, height).data;
    // The canvas goes before the readback is encoded: `itemCost` prices the
    // notice's encode step with one raster live, not two.
    canvas.width = 1;
    canvas.height = 1;
    return pixels;
}

/**
 * A notice's PNG. The readback is local to this function, so nothing refers to
 * it by the time jsPDF is handed the PNG.
 */
function noticePng(page: PageResult, kind: FileKind): Uint8Array {
    const raster = NOTICE_RASTER[kind];
    return encodeOpaque(
        drawNotice(noticeLines(page), raster), raster.width, raster.height,
        `notice p${page.page}`,
    );
}

function noticeKind(page: PageResult): ArtifactItemKind {
    return page.status === PLAN.MISSING_PAGE
        ? ARTIFACT_ITEM.MISSING_PAGE_NOTICE
        : ARTIFACT_ITEM.GEOMETRY_MISMATCH_NOTICE;
}

/** Refuse a container the memory model was not derived from. */
function newDocument(options?: jsPDFOptions): jsPDF {
    if (jsPDF.version !== JSPDF_CONTAINER.version) {
        throw new Error(
            `jsPDF ${jsPDF.version} is not the container the memory budget was `
            + `derived from (${JSPDF_CONTAINER.version})`,
        );
    }
    // No `compress`: the model is of the uncompressed path (jspdf.es.js:9293).
    return new jsPDF(options);
}

/**
 * The Comparison PDF: one page per pair, and one per page nobody could compare,
 * in source-page order.
 *
 * Every image is added under its own alias. Without one, jsPDF names an image
 * by a hash of the first half of its bytes (jspdf.es.js:9095, 9329-9332) and
 * reuses any earlier image with the same name — and a stored PNG's first half
 * is the top half of the sheet. A CHANGE whose change is in the lower half
 * would have been written as the picture of the MATCH before it.
 */
export function createComparisonPdf(dpi: number): ArtifactSink {
    // Points, because the page sizes below are points: the pixel width divided
    // back by the render scale is the source sheet.
    const doc = newDocument({ orientation: 'portrait', unit: 'pt' });
    doc.deletePage(1);
    const appended: AppendedItem[] = [];
    const scale = dpi / 72;

    const onPair = (pair: PairResult) => {
        if (!pair.pixels) return;
        const alias = `pair:p${pair.page}:s${pair.slot}`;
        const png = encodeOpaque(pair.pixels, pair.width, pair.height, alias);
        // Released before jsPDF ingests the PNG: the composite is not needed
        // again, and the model prices the ingest step without it.
        pair.pixels = null;
        const w = pair.width / scale;
        const h = pair.height / scale;
        doc.addPage([w, h], w > h ? 'landscape' : 'portrait');
        doc.addImage(png, 'PNG', 0, 0, w, h, alias);
        doc.setFontSize(9);
        doc.text(`${pair.title} — ${pair.verdict}`, 8, 14);
        appended.push({
            kind: ARTIFACT_ITEM.PAIR_VISUAL, page: pair.page, slot: pair.slot,
            width: pair.width, height: pair.height, alias, encodedBytes: png.length,
        });
    };

    // A page nobody could compare is kept and named, in its own place in the
    // document, as an image — so the notice survives whatever glyphs it needs.
    const onPage = (page: PageResult) => {
        if (page.status === PLAN.READY_TO_COMPARE) return;
        const raster = NOTICE_RASTER.COMPARISON_PDF;
        const alias = `notice:p${page.page}`;
        const png = noticePng(page, 'COMPARISON_PDF');
        doc.addPage([raster.width / 2, raster.height / 2], 'portrait');
        doc.addImage(png, 'PNG', 0, 0, raster.width / 2, raster.height / 2, alias);
        appended.push({
            kind: noticeKind(page), page: page.page, slot: null,
            width: raster.width, height: raster.height, alias, encodedBytes: png.length,
        });
    };

    return {
        kind: 'COMPARISON_PDF',
        doc,
        appended,
        onPair,
        onPage,
        save: (filename) => { doc.save(filename); },
    };
}

/**
 * The Change Report: a crop of every CHANGE, and every page nobody could
 * compare, in source-page order. Nothing else — a MATCH is not written.
 */
export function createChangeReport(): ArtifactSink {
    const doc = newDocument();
    const appended: AppendedItem[] = [];
    let first = true;
    const newPage = () => {
        if (!first) doc.addPage();
        first = false;
    };

    /** The crop's PNG; the crop itself does not outlive this call. */
    const cropPng = (
        pair: PairResult,
        pixels: Uint8ClampedArray,
        bounds: { x: number; y: number; width: number; height: number },
        alias: string,
    ) => {
        const crop = cropRgba(pixels, pair.width, pair.height, bounds);
        // The composite has given what the report needs from it.
        pair.pixels = null;
        return encodeOpaque(crop, bounds.width, bounds.height, alias);
    };

    const onPair = (pair: PairResult) => {
        if (pair.verdict !== RESULT.CHANGE || !pair.bounds || !pair.pixels) return;
        const bounds = pair.bounds;
        const alias = `crop:p${pair.page}:s${pair.slot}`;
        const png = cropPng(pair, pair.pixels, bounds, alias);

        newPage();
        const pdfWidth = doc.internal.pageSize.getWidth() - 20;
        const pdfHeight = pdfWidth * (bounds.height / bounds.width);
        doc.addImage(png, 'PNG', 10, 24, pdfWidth, pdfHeight, alias);
        doc.setFontSize(10);
        doc.text(`${pair.title} — CHANGE`, 10, 16);
        doc.text(
            `x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`,
            10, Math.min(pdfHeight + 34, doc.internal.pageSize.getHeight() - 8),
        );
        appended.push({
            kind: ARTIFACT_ITEM.PAIR_VISUAL, page: pair.page, slot: pair.slot,
            width: bounds.width, height: bounds.height, alias, encodedBytes: png.length,
        });
    };

    const onPage = (page: PageResult) => {
        if (page.status === PLAN.READY_TO_COMPARE) return;
        const raster = NOTICE_RASTER.CHANGE_REPORT;
        const alias = `notice:p${page.page}`;
        const png = noticePng(page, 'CHANGE_REPORT');
        newPage();
        const pdfWidth = doc.internal.pageSize.getWidth() - 20;
        doc.addImage(
            png, 'PNG', 10, 16, pdfWidth, pdfWidth * (raster.height / raster.width), alias,
        );
        appended.push({
            kind: noticeKind(page), page: page.page, slot: null,
            width: raster.width, height: raster.height, alias, encodedBytes: png.length,
        });
    };

    return {
        kind: 'CHANGE_REPORT',
        doc,
        appended,
        onPair,
        onPage,
        save: (filename) => { doc.save(filename); },
    };
}
