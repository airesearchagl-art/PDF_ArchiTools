/**
 * 図面サイズ統一 — drawing page-size normalisation.
 *
 * Brings a mixed-size drawing set (A1 / A3 / ...) onto a single paper size
 * WITHOUT rasterising anything. The original document is kept and each page is
 * transformed in place by wrapping its content stream in a CTM, so vector
 * geometry, embedded fonts, searchable text (including an OCR text layer),
 * embedded images, annotations and document metadata all survive as PDF
 * content. Nothing is redrawn through a canvas and nothing is re-encoded.
 *
 * Page-box policy
 * ---------------
 * - The *visible* box (CropBox, falling back to MediaBox) drives both detection
 *   and the fit, because that is the sheet a viewer and a printer actually see.
 * - Output MediaBox and CropBox are both set explicitly to
 *   [0 0 targetW targetH], so the result is unambiguously the target sheet
 *   rather than "looks like A1 but the MediaBox says something else".
 * - BleedBox / TrimBox / ArtBox are transformed with the same factor when they
 *   already exist, then clamped into the new sheet. They are never invented.
 * - /Rotate is preserved verbatim, and the target box is swapped for 90/270 so
 *   the orientation the user sees never changes.
 * - Content lying outside the source CropBox was already hidden by that
 *   CropBox and stays hidden. Nothing visible is ever cropped.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

/** JIS/ISO A-series trimmed sheet sizes, in millimetres. Single source of truth. */
export const PAPER_SIZES_MM = {
    A0: { short: 841, long: 1189 },
    A1: { short: 594, long: 841 },
    A2: { short: 420, long: 594 },
    A3: { short: 297, long: 420 },
    A4: { short: 210, long: 297 },
} as const;

export type PaperSizeKey = keyof typeof PAPER_SIZES_MM;

/** Largest first, so a UI list reads A0 -> A4. */
export const PAPER_SIZE_KEYS: readonly PaperSizeKey[] = ['A0', 'A1', 'A2', 'A3', 'A4'];

/** 1 pt = 1/72 inch, 1 inch = 25.4 mm. */
export const PT_PER_INCH = 72;
export const MM_PER_INCH = 25.4;

export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;
export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;

/** The same table in PDF points, derived — never hand-typed anywhere else. */
export const PAPER_SIZES_PT: Record<PaperSizeKey, { short: number; long: number }> = Object.fromEntries(
    PAPER_SIZE_KEYS.map((key) => [
        key,
        { short: mmToPt(PAPER_SIZES_MM[key].short), long: mmToPt(PAPER_SIZES_MM[key].long) },
    ]),
) as Record<PaperSizeKey, { short: number; long: number }>;

/**
 * Generators round differently (AutoCAD writes 1683.78 where the exact A1 edge
 * is 1683.7795) and a sheet can be trimmed a millimetre or two, so classify on
 * a tolerance rather than on equality.
 */
export const DETECT_TOLERANCE_MM = 5;

/**
 * Below this the fit is already the target to within a twentieth of a point
 * (~18 micron on paper), so the content stream is left completely alone.
 */
const CONTENT_EPSILON_PT = 0.05;

export const OTHER_SIZE_LABEL = 'その他';

export type NormalizeTarget = PaperSizeKey | 'first-page';
export type PageOrientation = 'portrait' | 'landscape';

export interface PageSizeReport {
    /** 1-based, matching what the user sees in a viewer. */
    pageNumber: number;
    /** Detected A-series sheet, or null when it matches none of them. */
    detected: PaperSizeKey | null;
    /** Visible size as displayed, i.e. after /Rotate. */
    widthPt: number;
    heightPt: number;
    orientation: PageOrientation;
    rotation: number;
    scale: number;
    /** True when the page already was the target sheet and was left untouched. */
    unchanged: boolean;
}

export interface NormalizeSummary {
    pageCount: number;
    /** e.g. 'A1' or '最初のページ (A1)'. */
    targetLabel: string;
    /** Ordered A0..A4 then その他; only non-zero entries. */
    sourceCounts: { label: string; count: number }[];
    unchangedPages: number;
    transformedPages: number;
    /** Suffix the caller appends to the output filename, without '.pdf'. */
    filenameSuffix: string;
    pages: PageSizeReport[];
}

export interface NormalizeResult {
    data: Uint8Array;
    summary: NormalizeSummary;
}

export interface NormalizeOptions {
    target: NormalizeTarget;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Annotation entries holding x/y pairs that must move with the content. */
const ANNOT_POINT_KEYS = ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL'] as const;

/**
 * Classify a visible page size against the A series. Compares the short and the
 * long edge, so portrait and landscape of the same sheet both match.
 */
export function detectPaperSize(
    widthPt: number,
    heightPt: number,
    toleranceMm = DETECT_TOLERANCE_MM,
): PaperSizeKey | null {
    const shortPt = Math.min(widthPt, heightPt);
    const longPt = Math.max(widthPt, heightPt);
    const tolerancePt = mmToPt(toleranceMm);
    for (const key of PAPER_SIZE_KEYS) {
        const size = PAPER_SIZES_PT[key];
        if (Math.abs(shortPt - size.short) <= tolerancePt && Math.abs(longPt - size.long) <= tolerancePt) {
            return key;
        }
    }
    return null;
}

export const paperSizeLabel = (detected: PaperSizeKey | null): string => detected ?? OTHER_SIZE_LABEL;

/** /Rotate is a multiple of 90 but may be negative or beyond 360. */
function normalizeRotation(angle: number): number {
    return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

async function toBytes(input: File | Uint8Array | ArrayBuffer): Promise<ArrayBuffer | Uint8Array> {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return input;
    return await input.arrayBuffer();
}

/** Map an array of x/y pairs through the affine transform. */
function transformPointArray(array: PDFArray, scale: number, dx: number, dy: number): void {
    for (let i = 0; i < array.size(); i++) {
        const value = array.lookup(i);
        if (!(value instanceof PDFNumber)) continue;
        const offset = i % 2 === 0 ? dx : dy;
        array.set(i, PDFNumber.of(value.asNumber() * scale + offset));
    }
}

/** /RD holds edge *differences*, so it scales but must not be translated. */
function scaleNumberArray(array: PDFArray, scale: number): void {
    for (let i = 0; i < array.size(); i++) {
        const value = array.lookup(i);
        if (value instanceof PDFNumber) array.set(i, PDFNumber.of(value.asNumber() * scale));
    }
}

/**
 * Move the annotations with the content.
 *
 * pdf-lib only offers `scaleAnnotations`, which scales without translating and
 * would leave every annotation off-centre once the page is padded, so the same
 * scale + offset used for the content stream is applied here by hand.
 * Appearance streams need no edit: a viewer maps the /AP BBox, through its
 * /Matrix, onto /Rect, so moving and resizing /Rect carries the appearance.
 */
function transformAnnotations(page: PDFPage, scale: number, dx: number, dy: number): void {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let idx = 0; idx < annots.size(); idx++) {
        const annot = annots.lookup(idx);
        if (!(annot instanceof PDFDict)) continue;
        for (const key of ANNOT_POINT_KEYS) {
            const value = annot.lookup(PDFName.of(key));
            if (value instanceof PDFArray) transformPointArray(value, scale, dx, dy);
        }
        const rd = annot.lookup(PDFName.of('RD'));
        if (rd instanceof PDFArray) scaleNumberArray(rd, scale);
        const inkList = annot.lookup(PDFName.of('InkList'));
        if (inkList instanceof PDFArray) {
            for (let i = 0; i < inkList.size(); i++) {
                const stroke = inkList.lookup(i);
                if (stroke instanceof PDFArray) transformPointArray(stroke, scale, dx, dy);
            }
        }
    }
}

function clampBox(box: Box, width: number, height: number): Box {
    const x0 = Math.max(0, Math.min(box.x, width));
    const y0 = Math.max(0, Math.min(box.y, height));
    const x1 = Math.max(x0, Math.min(box.x + box.width, width));
    const y1 = Math.max(y0, Math.min(box.y + box.height, height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The page as displayed: CropBox, with the edges swapped for /Rotate 90/270. */
function visibleSize(page: PDFPage): { width: number; height: number } {
    const box = page.getCropBox();
    const swapped = isSwapped(normalizeRotation(page.getRotation().angle));
    return { width: swapped ? box.height : box.width, height: swapped ? box.width : box.height };
}

const isSwapped = (rotation: number): boolean => rotation === 90 || rotation === 270;

/**
 * Normalise every page of one PDF onto a single sheet size.
 *
 * Aspect ratio is preserved, content is scaled to fit (up or down) and centred,
 * and nothing is cropped. Page count and page order never change.
 */
export async function normalizePageSize(
    input: File | Uint8Array | ArrayBuffer,
    options: NormalizeOptions,
): Promise<NormalizeResult> {
    const pdfDoc = await PDFDocument.load(await toBytes(input));
    const pages = pdfDoc.getPages();
    if (pages.length === 0) throw new Error('ページが存在しないPDFです。');

    // The target sheet is held as short/long edges so every page can take the
    // orientation it is displayed with today.
    let targetShortPt: number;
    let targetLongPt: number;
    if (options.target === 'first-page') {
        const first = visibleSize(pages[0]);
        targetShortPt = Math.min(first.width, first.height);
        targetLongPt = Math.max(first.width, first.height);
    } else {
        targetShortPt = PAPER_SIZES_PT[options.target].short;
        targetLongPt = PAPER_SIZES_PT[options.target].long;
    }

    const reports: PageSizeReport[] = [];

    for (let index = 0; index < pages.length; index++) {
        const page = pages[index];
        const rotation = normalizeRotation(page.getRotation().angle);
        const swapped = isSwapped(rotation);
        const source: Box = page.getCropBox();

        // What the user sees, i.e. the box after /Rotate has been applied.
        const visibleW = swapped ? source.height : source.width;
        const visibleH = swapped ? source.width : source.height;
        const orientation: PageOrientation = visibleW >= visibleH ? 'landscape' : 'portrait';
        const detected = detectPaperSize(visibleW, visibleH);

        const targetVisibleW = orientation === 'landscape' ? targetLongPt : targetShortPt;
        const targetVisibleH = orientation === 'landscape' ? targetShortPt : targetLongPt;
        // Back into unrotated page space, which is where the boxes live.
        const targetBoxW = swapped ? targetVisibleH : targetVisibleW;
        const targetBoxH = swapped ? targetVisibleW : targetVisibleH;

        const scale = Math.min(targetBoxW / source.width, targetBoxH / source.height);
        const dx = (targetBoxW - source.width * scale) / 2 - source.x * scale;
        const dy = (targetBoxH - source.height * scale) / 2 - source.y * scale;

        const scaleIsIdentity = Math.abs(scale - 1) * Math.max(source.width, source.height) <= CONTENT_EPSILON_PT;
        const offsetIsIdentity = Math.abs(dx) <= CONTENT_EPSILON_PT && Math.abs(dy) <= CONTENT_EPSILON_PT;
        const unchanged = scaleIsIdentity && offsetIsIdentity;

        if (!unchanged) {
            // Order matters. `scaleContent` and `translateContent` each wrap the
            // whole content stream and the later call ends up outermost, so
            // scaling first and translating second gives p' = scale * p + offset.
            if (!scaleIsIdentity) page.scaleContent(scale, scale);
            page.translateContent(dx, dy);
            transformAnnotations(page, scaleIsIdentity ? 1 : scale, dx, dy);

            // Read the optional boxes before the MediaBox moves under them:
            // pdf-lib's getters fall back to CropBox/MediaBox when absent.
            const optional: { key: 'BleedBox' | 'TrimBox' | 'ArtBox'; box: Box }[] = [];
            if (page.node.BleedBox()) optional.push({ key: 'BleedBox', box: page.getBleedBox() });
            if (page.node.TrimBox()) optional.push({ key: 'TrimBox', box: page.getTrimBox() });
            if (page.node.ArtBox()) optional.push({ key: 'ArtBox', box: page.getArtBox() });

            page.setMediaBox(0, 0, targetBoxW, targetBoxH);
            page.setCropBox(0, 0, targetBoxW, targetBoxH);

            for (const { key, box } of optional) {
                const moved = clampBox(
                    {
                        x: box.x * scale + dx,
                        y: box.y * scale + dy,
                        width: box.width * scale,
                        height: box.height * scale,
                    },
                    targetBoxW,
                    targetBoxH,
                );
                if (key === 'BleedBox') page.setBleedBox(moved.x, moved.y, moved.width, moved.height);
                if (key === 'TrimBox') page.setTrimBox(moved.x, moved.y, moved.width, moved.height);
                if (key === 'ArtBox') page.setArtBox(moved.x, moved.y, moved.width, moved.height);
            }
        }

        reports.push({
            pageNumber: index + 1,
            detected,
            widthPt: visibleW,
            heightPt: visibleH,
            orientation,
            rotation,
            scale,
            unchanged,
        });
    }

    const data = await pdfDoc.save();
    return { data, summary: buildSummary(reports, options.target) };
}

function buildSummary(pages: PageSizeReport[], target: NormalizeTarget): NormalizeSummary {
    const counts = new Map<string, number>();
    for (const page of pages) {
        const label = paperSizeLabel(page.detected);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const ordered = [...PAPER_SIZE_KEYS, OTHER_SIZE_LABEL]
        .filter((label) => counts.has(label))
        .map((label) => ({ label, count: counts.get(label) as number }));

    const targetLabel =
        target === 'first-page' ? `最初のページ (${paperSizeLabel(pages[0]?.detected ?? null)})` : target;

    return {
        pageCount: pages.length,
        targetLabel,
        sourceCounts: ordered,
        unchangedPages: pages.filter((p) => p.unchanged).length,
        transformedPages: pages.filter((p) => !p.unchanged).length,
        filenameSuffix: target === 'first-page' ? '_normalized' : `_${target}`,
        pages,
    };
}
