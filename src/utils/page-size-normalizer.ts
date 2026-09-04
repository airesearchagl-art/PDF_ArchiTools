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
 * - The *visible* box drives both detection and the fit: CropBox bounded by
 *   MediaBox, because that is the sheet a viewer and a printer actually see.
 * - Output MediaBox and CropBox are both set explicitly to
 *   [0 0 targetW targetH], so the result is unambiguously the target sheet
 *   rather than "looks like A1 but the MediaBox says something else".
 * - Content transform and page-box normalisation are decided separately. A page
 *   whose CropBox is already the target but whose MediaBox is larger needs its
 *   boxes normalised and its content left completely alone; deciding both from
 *   one flag would leave that page the wrong physical size.
 * - BleedBox / TrimBox / ArtBox are transformed with the same factor when they
 *   already exist, then clamped into the new sheet. They are never invented.
 * - /Rotate is preserved verbatim, and the target box is swapped for 90/270 so
 *   the orientation the user sees never changes.
 *
 * Preserving the visibility boundary
 * ----------------------------------
 * Widening the CropBox to the whole target sheet would otherwise reveal content
 * the source CropBox was hiding: after a fit that leaves padding, anything just
 * outside the old CropBox lands inside the new sheet. The content stream is
 * therefore clipped to the mapped source visible box whenever that box does not
 * already cover the sheet, so what was hidden stays hidden.
 *
 * A clipping path does not affect annotations. An annotation that would move
 * from hidden to visible cannot be preserved without changing the document, so
 * such an input is refused with a user-visible error rather than silently
 * exposing it. Only the Hidden flag exempts an annotation from that check;
 * NoView is a screen-only flag and is checked like any other annotation.
 *
 * The clip governs what is *drawn*. Glyphs that the old CropBox excluded stay
 * in the content stream, so any part of them that now falls inside the sheet
 * remains reachable by text extraction and search even though none of it is
 * painted. Removing it would mean rewriting the content stream operator by
 * operator, which is out of scope here; the behaviour is measured by
 * scripts/smoke-page-size-normalizer.mjs and stated as a known limitation.
 */
import {
    clip,
    endPath,
    PDFArray,
    PDFContentStream,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    popGraphicsState,
    pushGraphicsState,
    rectangle,
} from 'pdf-lib';
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

/** Page boxes are compared much more strictly: the output must be exact. */
const BOX_EPSILON_PT = 0.01;

/** Slack when judging whether an annotation sits inside the visible sheet. */
const ANNOT_TOLERANCE_PT = 1;

export const OTHER_SIZE_LABEL = 'その他';

export type NormalizeTarget = PaperSizeKey | 'first-page';
export type PageOrientation = 'portrait' | 'landscape';

/** Refusals the UI can show verbatim. */
export class PageSizeNormalizeError extends Error {
    readonly code: 'annotation-outside-crop' | 'empty-document';

    constructor(message: string, code: PageSizeNormalizeError['code']) {
        super(message);
        this.name = 'PageSizeNormalizeError';
        this.code = code;
    }
}

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
    /** Where the source visible box ends up on the new sheet, in page space. */
    mappedVisible: Box;
    /** The content stream was re-wrapped in a CTM. */
    contentTransformed: boolean;
    /** MediaBox / CropBox were rewritten to the target sheet. */
    boxesNormalized: boolean;
    /** A clipping path was added to keep the old visibility boundary. */
    clipApplied: boolean;
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

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Annotation entries holding x/y pairs that must move with the content. */
const ANNOT_POINT_KEYS = ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL'] as const;

/**
 * /F bit 2, Hidden: the only flag that makes an annotation invisible everywhere.
 *
 * NoView (bit 6) deliberately does NOT qualify. It hides the annotation on
 * screen only: a NoView annotation carrying Print still comes out of the
 * printer, and ToggleNoView (bit 9) can bring it back on screen as well. Since
 * this tool exists to prepare sheets for printing, treating NoView as "can
 * never be seen" would let such an annotation slip from outside the old CropBox
 * into the new one unnoticed, so it goes through the exposure check like any
 * other annotation.
 */
const HIDDEN_ANNOT_FLAG = 2;

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

const isSwapped = (rotation: number): boolean => rotation === 90 || rotation === 270;

async function toBytes(input: File | Uint8Array | ArrayBuffer): Promise<ArrayBuffer | Uint8Array> {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return input;
    return await input.arrayBuffer();
}

/** Overlap of two boxes, or null when they do not meet. */
function intersectRect(a: Box, b: Box): Box | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const boxMatches = (box: Box, width: number, height: number): boolean =>
    Math.abs(box.x) <= BOX_EPSILON_PT &&
    Math.abs(box.y) <= BOX_EPSILON_PT &&
    Math.abs(box.width - width) <= BOX_EPSILON_PT &&
    Math.abs(box.height - height) <= BOX_EPSILON_PT;

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

const annotDicts = (page: PDFPage): PDFDict[] => {
    const annots = page.node.Annots();
    if (!annots) return [];
    const out: PDFDict[] = [];
    for (let i = 0; i < annots.size(); i++) {
        const annot = annots.lookup(i);
        if (annot instanceof PDFDict) out.push(annot);
    }
    return out;
};

/** The annotation's /Rect as an ordered box, or null when it has none. */
function annotRect(annot: PDFDict): Box | null {
    const rect = annot.lookup(PDFName.of('Rect'));
    if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
    const values: number[] = [];
    for (let i = 0; i < 4; i++) {
        const n = rect.lookup(i);
        if (!(n instanceof PDFNumber)) return null;
        values.push(n.asNumber());
    }
    const x0 = Math.min(values[0], values[2]);
    const y0 = Math.min(values[1], values[3]);
    return { x: x0, y: y0, width: Math.max(values[0], values[2]) - x0, height: Math.max(values[1], values[3]) - y0 };
}

/**
 * Refuse a page whose annotations would go from hidden to visible.
 *
 * Only reachable when the fit leaves padding, because otherwise everything
 * outside the mapped visible box also falls outside the new sheet and stays
 * clipped by the MediaBox. A clipping path cannot hide an annotation, and
 * rewriting its flags would change the document behind the user's back, so the
 * safe answer is to stop.
 */
function assertNoAnnotationExposure(
    page: PDFPage,
    pageNumber: number,
    mapped: Box,
    scale: number,
    dx: number,
    dy: number,
    targetW: number,
    targetH: number,
): void {
    for (const annot of annotDicts(page)) {
        const flags = annot.lookup(PDFName.of('F'));
        const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
        if ((f & HIDDEN_ANNOT_FLAG) !== 0) continue;

        const rect = annotRect(annot);
        if (!rect) continue;

        // Only the part that lands on the new sheet can be seen at all.
        const onSheet = intersectRect(
            { x: rect.x * scale + dx, y: rect.y * scale + dy, width: rect.width * scale, height: rect.height * scale },
            { x: 0, y: 0, width: targetW, height: targetH },
        );
        if (!onSheet) continue;

        const inside =
            onSheet.x >= mapped.x - ANNOT_TOLERANCE_PT &&
            onSheet.y >= mapped.y - ANNOT_TOLERANCE_PT &&
            onSheet.x + onSheet.width <= mapped.x + mapped.width + ANNOT_TOLERANCE_PT &&
            onSheet.y + onSheet.height <= mapped.y + mapped.height + ANNOT_TOLERANCE_PT;
        if (inside) continue;

        throw new PageSizeNormalizeError(
            `${pageNumber}ページ目に、表示範囲 (CropBox) の外へはみ出した注釈があります。`
            + '用紙サイズを統一すると、これまで表示されていなかった注釈が余白に現れてしまうため、処理を中止しました。'
            + '注釈を表示範囲の内側へ移動するか、表示範囲の外の注釈を削除してからやり直してください。',
            'annotation-outside-crop',
        );
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
    for (const annot of annotDicts(page)) {
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

/**
 * Clip the page content to `box`, in final page coordinates.
 *
 * Wrapped around everything the CTM helpers already added, so the clipping path
 * is laid down before any scaling and therefore reads in target page space.
 */
function clipContentTo(pdfDoc: PDFDocument, page: PDFPage, box: Box): boolean {
    const start = PDFContentStream.of(pdfDoc.context.obj({}) as PDFDict, [
        pushGraphicsState(),
        rectangle(box.x, box.y, box.width, box.height),
        clip(),
        endPath(),
    ]);
    const end = PDFContentStream.of(pdfDoc.context.obj({}) as PDFDict, [popGraphicsState()]);
    page.node.normalize();
    return page.node.wrapContentStreams(pdfDoc.context.register(start), pdfDoc.context.register(end));
}

function clampBox(box: Box, width: number, height: number): Box {
    const x0 = Math.max(0, Math.min(box.x, width));
    const y0 = Math.max(0, Math.min(box.y, height));
    const x1 = Math.max(x0, Math.min(box.x + box.width, width));
    const y1 = Math.max(y0, Math.min(box.y + box.height, height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** CropBox bounded by MediaBox: what a viewer actually puts on screen. */
function visibleBox(page: PDFPage): Box {
    const mediaBox = page.getMediaBox();
    return intersectRect(page.getCropBox(), mediaBox) ?? mediaBox;
}

/** The page as displayed: the visible box, with edges swapped for /Rotate 90/270. */
function visibleSize(page: PDFPage): { width: number; height: number } {
    const box = visibleBox(page);
    const swapped = isSwapped(normalizeRotation(page.getRotation().angle));
    return { width: swapped ? box.height : box.width, height: swapped ? box.width : box.height };
}

/**
 * Normalise every page of one PDF onto a single sheet size.
 *
 * Aspect ratio is preserved, content is scaled to fit (up or down) and centred,
 * and nothing visible is cropped. Page count and page order never change.
 */
export async function normalizePageSize(
    input: File | Uint8Array | ArrayBuffer,
    options: NormalizeOptions,
): Promise<NormalizeResult> {
    const pdfDoc = await PDFDocument.load(await toBytes(input));
    const pages = pdfDoc.getPages();
    if (pages.length === 0) throw new PageSizeNormalizeError('ページが存在しないPDFです。', 'empty-document');

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
        const mediaBox = page.getMediaBox();
        const cropBox = page.getCropBox();
        const source = intersectRect(cropBox, mediaBox) ?? mediaBox;

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
        const mappedVisible: Box = {
            x: source.x * scale + dx,
            y: source.y * scale + dy,
            width: source.width * scale,
            height: source.height * scale,
        };

        const scaleIsIdentity = Math.abs(scale - 1) * Math.max(source.width, source.height) <= CONTENT_EPSILON_PT;
        const offsetIsIdentity = Math.abs(dx) <= CONTENT_EPSILON_PT && Math.abs(dy) <= CONTENT_EPSILON_PT;
        const contentTransformNeeded = !(scaleIsIdentity && offsetIsIdentity);

        // Padding means the mapped visible box no longer covers the sheet, which
        // is exactly when hidden content would surface.
        const clipNeeded =
            mappedVisible.x > BOX_EPSILON_PT ||
            mappedVisible.y > BOX_EPSILON_PT ||
            mappedVisible.x + mappedVisible.width < targetBoxW - BOX_EPSILON_PT ||
            mappedVisible.y + mappedVisible.height < targetBoxH - BOX_EPSILON_PT;

        const boxesNeedNormalization =
            !boxMatches(mediaBox, targetBoxW, targetBoxH) || !boxMatches(cropBox, targetBoxW, targetBoxH);

        // Refuse before touching anything, so a rejected file is never half-done.
        if (clipNeeded) {
            assertNoAnnotationExposure(page, index + 1, mappedVisible, scale, dx, dy, targetBoxW, targetBoxH);
        }

        if (contentTransformNeeded) {
            // Order matters. `scaleContent` and `translateContent` each wrap the
            // whole content stream and the later call ends up outermost, so
            // scaling first and translating second gives p' = scale * p + offset.
            if (!scaleIsIdentity) page.scaleContent(scale, scale);
            page.translateContent(dx, dy);
            transformAnnotations(page, scaleIsIdentity ? 1 : scale, dx, dy);
        }

        const clipApplied = clipNeeded ? clipContentTo(pdfDoc, page, mappedVisible) : false;

        if (boxesNeedNormalization) {
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
            mappedVisible,
            contentTransformed: contentTransformNeeded,
            boxesNormalized: boxesNeedNormalization,
            clipApplied,
            unchanged: !contentTransformNeeded && !boxesNeedNormalization,
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
