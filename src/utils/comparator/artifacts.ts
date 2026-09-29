/**
 * The two files, built one way, for the app and for the gates alike.
 *
 * The preflight prices every item an artifact will contain, in a sequence of
 * allocations and releases (`itemCost` in budget.ts). That price is only true
 * while the code that builds the file keeps to the sequence, so the code lives
 * here, once: the UI calls it, and the gates call exactly the same thing and
 * then measure the file it produced.
 *
 * The two files have two containers, and each has its own model:
 *
 *   - The Comparison PDF (Output Writer v2) is written by the owned
 *     append-only writer (pdf-writer.ts): each visual as a 4-bit Indexed image
 *     through the owned bounded DEFLATE, each notice as DeviceRGB through the
 *     same encoder. Its bounds are the owned ones in budget.ts.
 *   - The Change Report is still jsPDF 3.0.4 and nothing else; its model is
 *     bound to that version, and a different one is refused rather than
 *     trusted.
 */
import jsPDF, { type jsPDFOptions } from 'jspdf';
import { saveAs } from 'file-saver';
import {
    ARTIFACT_ITEM,
    MAX_OUTPUT_BYTES,
    NOTICE_RASTER,
    PLAN,
    RESULT,
    type ArtifactItemKind,
} from './contract';
import { JSPDF_CONTAINER } from './budget';
import { RasterShapeError, assertRaster, taskBoundary } from './mask';
import { encodePngStored } from './png';
import { paintPair, type PageResult, type PairResult, type RunSignal } from './engine';
import { ChunkedPdfWriter, OutputCeilingError } from './pdf-writer';
import {
    encodeIndexedImage,
    encodeRgbImage,
    statePalette,
    type EncodeControl,
    type EncodedImage,
    type Rgb,
} from './state-raster';

/** Re-exported so a caller can tell a runtime ceiling from any other failure. */
export { OutputCeilingError };

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

/** The colours the run's pairs were painted with: one reference, one per other slot. */
export interface ComparisonPaint {
    referenceColor: Rgb;
    colorBySlot: ReadonlyMap<number, Rgb>;
    matchColor: Rgb;
    matchOpacity: number;
}

export interface ComparisonPdfOptions {
    paint: ComparisonPaint;
    /** The run's own signal. A superseded run stops encoding and publishes nothing. */
    signal?: RunSignal;
    /** The runtime ceiling on actual bytes. `MAX_OUTPUT_BYTES` unless a test lowers it. */
    maxBytes?: number;
    /** How long an encode may hold the thread before it yields at a block boundary. */
    sliceMs?: number;
}

/** How the encode shared the thread, for the gates. */
export interface YieldStats {
    yields: number;
    /** The longest stretch between two yields (or from the start of an encode). */
    longestSliceMs: number;
    blocks: number;
}

export interface ComparisonPdfSink {
    kind: 'COMPARISON_PDF';
    appended: AppendedItem[];
    stats: YieldStats;
    onPair: (pair: PairResult) => Promise<void>;
    onPage: (page: PageResult) => Promise<void>;
    /** True once the run was superseded mid-encode; nothing will be published. */
    readonly cancelled: boolean;
    readonly bytesWritten: number;
    /** The finished file. Throws `OutputCeilingError` if the tail would pass the ceiling. */
    finish: () => Blob;
    /** `finish()` and hand the file to the browser's download. */
    save: (filename: string) => void;
    abort: () => void;
}

/**
 * The Comparison PDF: one page per pair, and one per page nobody could compare,
 * in source-page order.
 *
 * Each pair's composite becomes a 4-bit Indexed image whose palette is what
 * `paintPair` paints for that pair's colours, so it decodes to exactly the
 * composite's RGB. Each notice is drawn as today and written as DeviceRGB.
 * Both go through the owned bounded DEFLATE, whose output and scratch the
 * preflight priced before the run began (budget.ts).
 *
 * The encode yields to the event loop at block boundaries whenever it has held
 * the thread for `sliceMs`, and after every yield it asks the run's signal
 * whether it still owns the output. A run that no longer does drops the writer
 * and returns; the engine sees the same signal and abandons the run, and the
 * component never reaches `save`. Every append is counted against `maxBytes`:
 * a file that would pass it is dropped and the run fails with
 * `OutputCeilingError`, and nothing is written.
 */
export function createComparisonPdf(dpi: number, options: ComparisonPdfOptions): ComparisonPdfSink {
    const scale = dpi / 72;
    const writer = new ChunkedPdfWriter(options.maxBytes ?? MAX_OUTPUT_BYTES);
    const appended: AppendedItem[] = [];
    const stats: YieldStats = { yields: 0, longestSliceMs: 0, blocks: 0 };
    const sliceMs = options.sliceMs ?? 12;
    const signal = options.signal;
    const { paint } = options;
    let cancelled = false;

    const owns = () => !signal || (!signal.isCancelled() && signal.isOwner());

    const control = (): EncodeControl => {
        let sliceStart = performance.now();
        return {
            atBlock: async () => {
                stats.blocks += 1;
                const held = performance.now() - sliceStart;
                if (held < sliceMs) return;
                stats.longestSliceMs = Math.max(stats.longestSliceMs, held);
                await taskBoundary();
                stats.yields += 1;
                sliceStart = performance.now();
            },
            shouldContinue: owns,
            // The running compressed size, against the ceiling, before the
            // page is appended: a file that cannot fit stops growing now.
            onBytes: (encodedSoFar) => writer.reserve(encodedSoFar),
        };
    };

    const append = (image: EncodedImage | null, widthPt: number, heightPt: number, title: string) => {
        if (!image) {
            cancelled = true;
            writer.abort();
            return false;
        }
        writer.addImagePage({ widthPt, heightPt, image, title });
        return true;
    };

    // Any failure drops the writer, whatever threw: a sink that failed part way
    // has no file to give, even to a caller that goes on to ask for one.
    const failClosed = <T extends unknown[]>(step: (...args: T) => Promise<void>) =>
        async (...args: T) => {
            try {
                await step(...args);
            } catch (error) {
                writer.abort();
                throw error;
            }
        };

    const onPair = failClosed(async (pair: PairResult) => {
        if (!pair.pixels || cancelled || !writer.isOpen) return;
        const alias = `pair:p${pair.page}:s${pair.slot}`;
        assertRaster(pair.pixels, pair.width, pair.height, 4, alias);
        assertOpaque(pair.pixels, alias);
        const otherColor = paint.colorBySlot.get(pair.slot);
        if (!otherColor) throw new RasterShapeError(`${alias}: no colour for slot ${pair.slot}`);
        const palette = statePalette(paintPair, {
            referenceColor: paint.referenceColor,
            otherColor,
            matchColor: paint.matchColor,
            matchOpacity: paint.matchOpacity,
        });
        const image = await encodeIndexedImage(pair.pixels, pair.width, pair.height, palette, control());
        const w = pair.width / scale;
        const h = pair.height / scale;
        if (!append(image, w, h, `${pair.title} — ${pair.verdict}`)) return;
        appended.push({
            kind: ARTIFACT_ITEM.PAIR_VISUAL, page: pair.page, slot: pair.slot,
            width: pair.width, height: pair.height, alias, encodedBytes: image!.encodedBytes,
        });
    });

    // A page nobody could compare is kept and named, in its own place in the
    // document, as an image — so the notice survives whatever glyphs it needs.
    const onPage = failClosed(async (page: PageResult) => {
        if (page.status === PLAN.READY_TO_COMPARE || cancelled || !writer.isOpen) return;
        const raster = NOTICE_RASTER.COMPARISON_PDF;
        const alias = `notice:p${page.page}`;
        const image = await encodeRgbImage(
            drawNotice(noticeLines(page), raster), raster.width, raster.height, control(),
        );
        if (!append(image, raster.width / 2, raster.height / 2, '')) return;
        appended.push({
            kind: noticeKind(page), page: page.page, slot: null,
            width: raster.width, height: raster.height, alias, encodedBytes: image!.encodedBytes,
        });
    });

    const finish = () => {
        if (cancelled) throw new Error('the Comparison PDF was cancelled and has no output');
        const chunks = writer.finish() as Uint8Array<ArrayBuffer>[];
        return new Blob(chunks, { type: 'application/pdf' });
    };

    return {
        kind: 'COMPARISON_PDF',
        appended,
        stats,
        onPair,
        onPage,
        get cancelled() { return cancelled; },
        get bytesWritten() { return writer.bytesWritten; },
        finish,
        save: (filename) => { saveAs(finish(), filename); },
        abort: () => { writer.abort(); },
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
