/**
 * Page facts from the page boxes PDF.js reports: pure functions, no PDF.js.
 *
 * Definitions, all from the canonical contract (PageFacts):
 *  - size: the visible box -- the CropBox within the MediaBox, which is what
 *    PDF.js reports as `page.view` -- with /Rotate undone, in PDF points at
 *    scale 1. Never a rendered pixel size.
 *  - rotate: exactly 0, 90, 180 or 270. PDF.js has already reduced a multiple
 *    of 90 modulo 360 and turned anything else into 0, which is also how every
 *    page is displayed; a value outside the four is refused, not coerced.
 *  - kind: "text-native" when the page's native PDF text contains at least one
 *    meaningful character, "scanned" when it contains none. This is native
 *    text classification only: nothing is recognised, no OCR is run, and
 *    "scanned" says only that the page carries no native text.
 *
 * A page whose facts cannot be represented in the contract refuses its whole
 * Source; a Source is never kept with pages missing.
 */
import type { IntakeRefusal } from './intake-policy';
import { MAX_PAGE_POINTS, refusal } from './intake-policy';
import type { PageKind, PageRotation } from './model';

const ROTATIONS: readonly PageRotation[] = [0, 90, 180, 270];

/** Rounded to 1/10000 pt, so float noise from box arithmetic is not recorded as a fact. */
const roundPoints = (value: number): number => Math.round(value * 10000) / 10000;

export type PageBoxVerdict =
    | { ok: true; uprightWidthPt: number; uprightHeightPt: number; rotate: PageRotation }
    | { ok: false; refusal: IntakeRefusal };

/**
 * The size and rotation facts of one page, or why the page cannot have them.
 * `pageNumber` is only for the message.
 */
export function pageBoxFacts(input: {
    view: readonly number[];
    rotate: number;
    userUnit: number;
    pageNumber: number;
}): PageBoxVerdict {
    const { view, rotate, userUnit, pageNumber } = input;
    if (!Array.isArray(view) || view.length !== 4 || !view.every(Number.isFinite)) {
        return { ok: false, refusal: refusal('PAGE_SIZE_INVALID', `${pageNumber}ページ目の用紙サイズを読み取れないため、このファイルは読み込めません。`) };
    }
    // UserUnit rescales what a point means. P1 records "PDF points at scale 1"
    // only where that is unambiguous, and refuses the rest rather than guess.
    if (userUnit !== 1) {
        return {
            ok: false,
            refusal: refusal('PAGE_USER_UNIT_UNSUPPORTED', `${pageNumber}ページ目が単位の拡大（UserUnit）を使っているため、このファイルは読み込めません。`),
        };
    }
    if (!Number.isInteger(rotate) || !ROTATIONS.includes(rotate as PageRotation)) {
        return { ok: false, refusal: refusal('PAGE_ROTATION_INVALID', `${pageNumber}ページ目の回転を読み取れないため、このファイルは読み込めません。`) };
    }
    const width = roundPoints(view[2] - view[0]);
    const height = roundPoints(view[3] - view[1]);
    if (!(width > 0) || !(height > 0)) {
        return { ok: false, refusal: refusal('PAGE_SIZE_INVALID', `${pageNumber}ページ目の用紙サイズが正しくないため、このファイルは読み込めません。`) };
    }
    if (width > MAX_PAGE_POINTS || height > MAX_PAGE_POINTS) {
        return {
            ok: false,
            refusal: refusal(
                'PAGE_SIZE_OUT_OF_RANGE',
                `${pageNumber}ページ目の用紙が大きすぎるため（${Math.round(width)} × ${Math.round(height)} pt）、このファイルは読み込めません。1辺 ${MAX_PAGE_POINTS} pt までです。`,
            ),
        };
    }
    return { ok: true, uprightWidthPt: width, uprightHeightPt: height, rotate: rotate as PageRotation };
}

// Whitespace, controls, soft hyphen, zero-width characters, BOM and the
// replacement character carry no reading of their own.
// eslint-disable-next-line no-control-regex
const MEANINGFUL_TEXT = /[^\s\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF\uFFFD]/u;

/** Whether a piece of native page text has at least one meaningful character. */
export const hasMeaningfulText = (text: string): boolean => MEANINGFUL_TEXT.test(text);

export const pageKindFor = (hasText: boolean): PageKind => (hasText ? 'text-native' : 'scanned');

/* ---------- display helpers: derived, never stored ---------- */

export type DisplayOrientation = 'portrait' | 'landscape' | 'square';

/** The orientation the page is seen in, with its rotation applied. */
export function displayOrientation(facts: { uprightWidthPt: number; uprightHeightPt: number; rotate: number }): DisplayOrientation {
    const turned = facts.rotate === 90 || facts.rotate === 270;
    const width = turned ? facts.uprightHeightPt : facts.uprightWidthPt;
    const height = turned ? facts.uprightWidthPt : facts.uprightHeightPt;
    if (width > height) return 'landscape';
    if (width < height) return 'portrait';
    return 'square';
}

export const ORIENTATION_LABEL: Record<DisplayOrientation, string> = {
    portrait: '縦',
    landscape: '横',
    square: '正方形',
};

const POINTS_TO_MM = 25.4 / 72;

const PAPER_SIZES: readonly [string, number, number][] = [
    ['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210],
    ['B0', 1030, 1456], ['B1', 728, 1030], ['B2', 515, 728], ['B3', 364, 515], ['B4', 257, 364], ['B5', 182, 257],
];

/** Tolerance, in millimetres, for calling a page by a paper name. */
const PAPER_TOLERANCE_MM = 3;

/** "A3" for a page within a few millimetres of an ISO A / JIS B size, else null. */
export function paperSizeName(uprightWidthPt: number, uprightHeightPt: number): string | null {
    const short = Math.min(uprightWidthPt, uprightHeightPt) * POINTS_TO_MM;
    const long = Math.max(uprightWidthPt, uprightHeightPt) * POINTS_TO_MM;
    for (const [name, a, b] of PAPER_SIZES) {
        if (Math.abs(short - a) <= PAPER_TOLERANCE_MM && Math.abs(long - b) <= PAPER_TOLERANCE_MM) return name;
    }
    return null;
}

/** "420 × 297 mm", as the page is seen (rotation applied). */
export function displaySizeMm(facts: { uprightWidthPt: number; uprightHeightPt: number; rotate: number }): string {
    const turned = facts.rotate === 90 || facts.rotate === 270;
    const width = (turned ? facts.uprightHeightPt : facts.uprightWidthPt) * POINTS_TO_MM;
    const height = (turned ? facts.uprightWidthPt : facts.uprightHeightPt) * POINTS_TO_MM;
    return `${Math.round(width)} × ${Math.round(height)} mm`;
}
