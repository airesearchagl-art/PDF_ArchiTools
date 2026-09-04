/**
 * 図枠一括更新 — title-block batch update.
 *
 * The user drags a rectangle over the title block of one representative page,
 * types the replacement text, and every page of every file gets the same update
 * at the same *relative* position. That is what makes an A1 and an A3 sheet with
 * the same layout come out consistent.
 *
 * What this is NOT
 * ----------------
 * This is a VISUAL replacement, not redaction. A white rectangle is drawn over
 * the old text and the new text is drawn on top; the original characters are
 * still in the page's content stream and a viewer's search or a text extractor
 * can still find them. Never present this as a way to remove confidential text.
 * `scripts/smoke-title-block-updater.mjs` measures that behaviour rather than
 * leaving it to be discovered later.
 *
 * Coordinates
 * -----------
 * A rule stores its rectangle as fractions of the *displayed* page — after
 * /Rotate, with y measured from the top, the way the user saw it while dragging.
 * At output time each page turns that back into its own user space through the
 * page's visible box and rotation, so pages of different sizes stay consistent.
 *
 * Nothing is rasterised: the original document is kept and only a filled
 * rectangle and a text run are appended, so vector art, searchable text, an OCR
 * layer and embedded images all survive.
 */
import {
    concatTransformationMatrix,
    degrees,
    PDFDocument,
    popGraphicsState,
    pushGraphicsState,
    rgb,
    StandardFonts,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/** The Japanese face already shipped for OCR; reused so no new asset is needed. */
const JP_FONT_URL = '/ocr/fonts/MPLUS1p-Regular.ttf';

/** At most three rules per run: enough for status + date + revision. */
export const MAX_RULES = 3;

/** Starting size as a fraction of the box height, then shrunk to fit the width. */
const START_HEIGHT_RATIO = 0.72;
/** Leave a hair of room so a glyph never touches the mask edge. */
const WIDTH_FILL_RATIO = 0.96;
/** Below this the text would be unreadable, so stop instead of shrinking on. */
const MIN_FONT_SIZE = 4;

export type PageOrientation = 'portrait' | 'landscape';

/** Refusals the UI shows verbatim. */
export class TitleBlockError extends Error {
    readonly code: 'orientation-mismatch' | 'text-too-long' | 'no-rules' | 'empty-document';

    constructor(message: string, code: TitleBlockError['code']) {
        super(message);
        this.name = 'TitleBlockError';
        this.code = code;
    }
}

/** Fractions of the displayed page. `y` is measured from the top edge. */
export interface NormalizedRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface UpdateRule {
    /** Where on the displayed page, as fractions. */
    rect: NormalizedRect;
    /** What to write there. One line; no wrapping in this version. */
    text: string;
}

export interface TitleBlockOptions {
    rules: UpdateRule[];
    /**
     * Orientation of the page the rules were drawn on. Pages that are displayed
     * the other way round would put the title block somewhere else entirely, so
     * they are refused rather than silently mispositioned.
     */
    templateOrientation: PageOrientation;
    /** Injectable so the smoke and Node callers do not depend on a fetch. */
    loadJapaneseFont?: () => Promise<Uint8Array | ArrayBuffer>;
}

export interface PageUpdateReport {
    pageNumber: number;
    orientation: PageOrientation;
    rotation: number;
    /** Visible page size in points, after /Rotate. */
    widthPt: number;
    heightPt: number;
    /** Where each rule landed, in PDF user space. */
    applied: { ruleIndex: number; fontSize: number }[];
}

export interface TitleBlockSummary {
    pageCount: number;
    ruleCount: number;
    /** True when a Japanese face had to be embedded. */
    embeddedJapaneseFont: boolean;
    filenameSuffix: string;
    pages: PageUpdateReport[];
}

export interface TitleBlockResult {
    data: Uint8Array;
    summary: TitleBlockSummary;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

const isSwapped = (rotation: number): boolean => rotation === 90 || rotation === 270;

/** /Rotate is a multiple of 90 but may be negative or beyond 360. */
function normalizeRotation(angle: number): number {
    return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

function intersectRect(a: Box, b: Box): Box | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** CropBox bounded by MediaBox: what a viewer actually puts on screen. */
function visibleBox(page: PDFPage): Box {
    const mediaBox = page.getMediaBox();
    return intersectRect(page.getCropBox(), mediaBox) ?? mediaBox;
}

/** Size of the page as displayed, i.e. with the edges swapped for 90/270. */
export function displayedSize(page: PDFPage): { width: number; height: number; rotation: number } {
    const box = visibleBox(page);
    const rotation = normalizeRotation(page.getRotation().angle);
    const swapped = isSwapped(rotation);
    return {
        width: swapped ? box.height : box.width,
        height: swapped ? box.width : box.height,
        rotation,
    };
}

export const orientationOf = (width: number, height: number): PageOrientation =>
    width >= height ? 'landscape' : 'portrait';

/**
 * Matrix taking "displayed page, origin bottom-left, y up" into PDF user space.
 *
 * Working in that space instead of the user's own top-left canvas space keeps
 * every case a pure rotation, so a mask stays a mask and text stays upright
 * whatever /Rotate the page carries.
 */
function displayToUserMatrix(
    box: Box,
    rotation: number,
): [number, number, number, number, number, number] {
    switch (rotation) {
        case 90:
            return [0, 1, -1, 0, box.x + box.width, box.y];
        case 180:
            return [-1, 0, 0, -1, box.x + box.width, box.y + box.height];
        case 270:
            return [0, -1, 1, 0, box.x, box.y + box.height];
        default:
            return [1, 0, 0, 1, box.x, box.y];
    }
}

const isAscii = (text: string): boolean => /^[\x20-\x7E]*$/.test(text);

async function defaultJapaneseFontLoader(): Promise<ArrayBuffer> {
    const response = await fetch(JP_FONT_URL);
    if (!response.ok) throw new Error(`フォントの読み込みに失敗しました (HTTP ${response.status})`);
    return await response.arrayBuffer();
}

async function toBytes(input: File | Uint8Array | ArrayBuffer): Promise<ArrayBuffer | Uint8Array> {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return input;
    return await input.arrayBuffer();
}

/**
 * Largest size that fits the box, or null when even the minimum is too wide.
 *
 * Height sets the starting point and width does the shrinking, which is the
 * direction that actually runs out first on a title block.
 */
export function fitFontSize(font: PDFFont, text: string, box: { width: number; height: number }): number | null {
    let size = Math.max(MIN_FONT_SIZE, box.height * START_HEIGHT_RATIO);
    const maxWidth = box.width * WIDTH_FILL_RATIO;
    while (size >= MIN_FONT_SIZE) {
        if (font.widthOfTextAtSize(text, size) <= maxWidth) return size;
        size -= 0.25;
    }
    return null;
}

/**
 * Apply the rules to every page of one PDF.
 *
 * Page count, page order and page size never change; only a white rectangle and
 * a line of text are added inside each selected region.
 */
export async function updateTitleBlocks(
    input: File | Uint8Array | ArrayBuffer,
    options: TitleBlockOptions,
): Promise<TitleBlockResult> {
    const rules = options.rules.filter((r) => r.text.length > 0);
    if (rules.length === 0) {
        throw new TitleBlockError('更新する領域と文字が設定されていません。', 'no-rules');
    }

    const pdfDoc = await PDFDocument.load(await toBytes(input));
    const pages = pdfDoc.getPages();
    if (pages.length === 0) throw new TitleBlockError('ページが存在しないPDFです。', 'empty-document');

    // Refuse before writing anything, so a rejected file is never half-done.
    for (let i = 0; i < pages.length; i++) {
        const { width, height } = displayedSize(pages[i]);
        if (orientationOf(width, height) !== options.templateOrientation) {
            throw new TitleBlockError(
                `${i + 1}ページ目は代表ページと縦横方向が異なるため処理を中止しました。`
                + '同じ向きのページだけをまとめて処理してください。',
                'orientation-mismatch',
            );
        }
    }

    // Only embed the Japanese face when a rule actually needs it: a Helvetica
    // run keeps the output the same size as the input.
    const needsJapanese = rules.some((rule) => !isAscii(rule.text));
    let font: PDFFont;
    if (needsJapanese) {
        pdfDoc.registerFontkit(fontkit);
        const bytes = await (options.loadJapaneseFont ?? defaultJapaneseFontLoader)();
        // subset:false on purpose: @pdf-lib/fontkit 1.1.1 drops CJK glyphs when
        // subsetting, which M1 already hit. Costs bytes, keeps the glyphs.
        font = await pdfDoc.embedFont(bytes as ArrayBuffer, { subset: false });
    } else {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    const reports: PageUpdateReport[] = [];

    for (let index = 0; index < pages.length; index++) {
        const page = pages[index];
        const box = visibleBox(page);
        const { width: displayW, height: displayH, rotation } = displayedSize(page);
        const matrix = displayToUserMatrix(box, rotation);
        const applied: { ruleIndex: number; fontSize: number }[] = [];

        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));

        for (let r = 0; r < rules.length; r++) {
            const rule = rules[r];
            // Fractions of the displayed page -> points, with y flipped up.
            const rect = {
                x: rule.rect.x * displayW,
                y: (1 - rule.rect.y - rule.rect.height) * displayH,
                width: rule.rect.width * displayW,
                height: rule.rect.height * displayH,
            };

            const size = fitFontSize(font, rule.text, rect);
            if (size === null) {
                page.pushOperators(popGraphicsState());
                throw new TitleBlockError(
                    `${index + 1}ページ目の${r + 1}番目の領域は、入力した文字「${rule.text}」を`
                    + '読める大きさで収められません。領域を広げるか、文字を短くしてください。',
                    'text-too-long',
                );
            }

            // Mask exactly the selected rectangle, never a padded one: the frame
            // lines just outside it have to survive.
            page.drawRectangle({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                color: rgb(1, 1, 1),
                rotate: degrees(0),
            });

            const textWidth = font.widthOfTextAtSize(rule.text, size);
            const ascent = font.heightAtSize(size, { descender: false });
            page.drawText(rule.text, {
                x: rect.x + (rect.width - textWidth) / 2,
                y: rect.y + (rect.height - ascent) / 2,
                size,
                font,
                color: rgb(0, 0, 0),
            });

            applied.push({ ruleIndex: r, fontSize: size });
        }

        page.pushOperators(popGraphicsState());

        reports.push({
            pageNumber: index + 1,
            orientation: orientationOf(displayW, displayH),
            rotation,
            widthPt: displayW,
            heightPt: displayH,
            applied,
        });
    }

    const data = await pdfDoc.save();
    return {
        data,
        summary: {
            pageCount: pages.length,
            ruleCount: rules.length,
            embeddedJapaneseFont: needsJapanese,
            filenameSuffix: '_title-updated',
            pages: reports,
        },
    };
}
