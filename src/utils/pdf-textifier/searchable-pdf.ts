import {
    beginText,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setCharacterSqueeze,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
    TextRenderingMode,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import type { OcrWord } from './types';

/**
 * Write recognised words onto a page as invisible text.
 *
 * The original page content is left completely alone; this only appends a text
 * block in rendering mode 3, which a viewer searches and selects but never
 * draws. That is why the output looks pixel-identical to the input.
 */
export function drawInvisibleWords(
    page: PDFPage,
    fontName: ReturnType<PDFPage['node']['newFontDictionary']>,
    font: PDFFont,
    words: OcrWord[],
    viewport: PageViewport,
): number {
    const operators = [
        pushGraphicsState(),
        beginText(),
        setTextRenderingMode(TextRenderingMode.Invisible),
    ];
    let placed = 0;

    for (const { text, bbox } of words) {
        // Boxes arrive in canvas pixels. convertToPdfPoint is the exact inverse
        // of the render transform, so it stays correct when the page carries a
        // /Rotate entry or a MediaBox that does not start at the origin -- both
        // cases where `pageHeight - y` silently misplaces the text.
        const start = toPoint(viewport, bbox.x0, bbox.y1);
        const end = toPoint(viewport, bbox.x1, bbox.y1);
        const up = toPoint(viewport, bbox.x0, bbox.y0);

        const advanceX = end.x - start.x;
        const advanceY = end.y - start.y;
        const boxWidth = Math.hypot(advanceX, advanceY);
        const boxHeight = Math.hypot(up.x - start.x, up.y - start.y);
        if (boxWidth <= 0 || boxHeight <= 0) continue;

        let encoded;
        try {
            encoded = font.encodeText(text);
        } catch {
            // A character the embedded font cannot encode: skip the word rather
            // than abandoning the page.
            continue;
        }

        const natural = font.widthOfTextAtSize(text, boxHeight);
        if (!(natural > 0)) continue;

        // The text matrix carries the page's rotation, taken from the direction
        // the box actually runs in user space. Without this the invisible run
        // would sit axis-aligned across a rotated page and selection would be
        // skewed away from the glyphs underneath.
        const angle = Math.atan2(advanceY, advanceX);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        operators.push(
            setFontAndSize(fontName, boxHeight),
            // Tz stretches the run to exactly the width OCR measured, absorbing
            // the difference between the scanned glyphs and our font's metrics.
            setCharacterSqueeze((boxWidth / natural) * 100),
            setTextMatrix(cos, sin, -sin, cos, start.x, start.y),
            showText(encoded),
        );
        placed++;
    }

    operators.push(endText(), popGraphicsState());
    if (placed > 0) page.pushOperators(...operators);
    return placed;
}

function toPoint(viewport: PageViewport, x: number, y: number): { x: number; y: number } {
    const [px, py] = viewport.convertToPdfPoint(x, y) as [number, number];
    return { x: px, y: py };
}
