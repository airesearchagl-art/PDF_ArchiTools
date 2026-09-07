/**
 * Page geometry for the drawing register, and rendering one region of a page.
 *
 * Two things here differ from the table work, and both are deliberate.
 *
 * **Tokens are not withheld from a scanned page.** `analysePageGeometry()`
 * hands back no tokens when its classifier calls a page scanned, which is
 * right for table reconstruction: marginal text on a raster sheet must never
 * become a one-cell table. The register decides per *field*, so it must be
 * able to see a drawing number left as vector text on a raster drawing --
 * a real and common sheet. The classification is still reported, because it is
 * useful context; it just does not gate the tokens.
 *
 * **Regions render with `/Rotate` undone.** Getting the rectangle right is not
 * enough. Mapping an upright rectangle into display space crops exactly the
 * right pixels and then hands the recogniser a title block lying on its side:
 * the region is correct, the text is present, and the value comes back as
 * rubbish -- indistinguishable, in any total, from "this page could not be
 * read". Rendering at `rotation: 0` puts the canvas in the same upright space
 * the rectangles already use.
 */

import type * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SelectionRect, TableToken } from './table-types';
import { classifyPage } from './classify';
import { readTokens } from './table-geometry';

/** A page as the register sees it. */
export interface RegisterPageGeometry {
    pageNumber: number;
    /** The page's own `/Rotate`, kept for display and for the gates. */
    rotate: number;
    displayWidth: number;
    displayHeight: number;
    uprightWidth: number;
    uprightHeight: number;
    /**
     * Every text run on the page, in upright space.
     *
     * Present even when `scanned` is true. That is the whole point of this
     * module: a raster sheet with a vector drawing number has one field that
     * needs no recognition at all.
     */
    tokens: TableToken[];
    /** What the pipeline's classifier makes of the page. Context, not a gate. */
    scanned: boolean;
    allChars: number;
    interiorChars: number;
}

/**
 * Read a page's geometry for register extraction.
 *
 * Opens and cleans up the page itself, like `analysePageGeometry`, so callers
 * do not have to think about page lifetimes.
 */
export async function analyseRegisterPage(
    doc: PDFDocumentProxy, pageNumber: number,
): Promise<RegisterPageGeometry> {
    const page = await doc.getPage(pageNumber);
    try {
        const viewport = page.getViewport({ scale: 1 });
        const rotate = page.rotate ?? 0;
        const classification = await classifyPage(page);
        const tokens = await readTokens(page, viewport);
        const quarter = ((rotate % 360) + 360) % 360 % 180 === 90;
        return {
            pageNumber,
            rotate,
            displayWidth: viewport.width,
            displayHeight: viewport.height,
            uprightWidth: quarter ? viewport.height : viewport.width,
            uprightHeight: quarter ? viewport.width : viewport.height,
            tokens,
            scanned: classification.kind === 'scanned',
            allChars: classification.allChars,
            interiorChars: classification.interiorChars,
        };
    } finally {
        page.cleanup();
    }
}

/**
 * The text inside one rectangle, as lines.
 *
 * Tokens are grouped into lines by vertical overlap and joined, which is the
 * extraction boundary: what this returns *is* the field's raw text. A title
 * block cell holds its label above its value, and flattening the two into one
 * string destroys the only signal that tells them apart -- so the line breaks
 * are kept and the caller decides how to present them.
 */
export function tokensToRawText(tokens: TableToken[], rect: SelectionRect): string {
    const inside = tokens.filter((token) => {
        const cx = (token.x0 + token.x1) / 2;
        const cy = (token.y0 + token.y1) / 2;
        return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
    });
    const ordered = [...inside].sort((a, b) => {
        const ay = (a.y0 + a.y1) / 2;
        const by = (b.y0 + b.y1) / 2;
        return Math.abs(ay - by) > 2 ? ay - by : a.x0 - b.x0;
    });

    const lines: TableToken[][] = [];
    for (const token of ordered) {
        const line = lines[lines.length - 1];
        const last = line?.[line.length - 1];
        const shared = last ? Math.min(last.y1, token.y1) - Math.max(last.y0, token.y0) : 0;
        const smaller = last ? Math.min(last.y1 - last.y0, token.y1 - token.y0) : 0;
        if (line && smaller > 0 && shared / smaller >= 0.5) line.push(token);
        else lines.push([token]);
    }
    return lines
        .map((line) => line.map((token) => token.text).join('').trim())
        .filter((line) => line !== '')
        .join('\n');
}

/** What one region render produced, and what it cost. */
export interface RenderedRegion {
    canvas: HTMLCanvasElement;
    /** The upright rectangle actually drawn, clamped to the page. */
    rect: SelectionRect;
    /** Points-to-pixels, so a word box can be mapped back to upright points. */
    scale: number;
    width: number;
    height: number;
    pixels: number;
}

/**
 * The default resolution for recognising a title block.
 *
 * 300 dpi is the baseline the architecture adopted. It is a per-region cost,
 * not a per-page one, which is what makes the largest sheets possible at all.
 */
export const REGISTER_DPI = 300;

/**
 * Render one upright rectangle of a page.
 *
 * `rotation` exists for one reason and it is not flexibility: a gate renders
 * the same region through the page's own `/Rotate` to show that the reading
 * stops working, because a rotation fix that is never broken on purpose is a
 * claim rather than a result. Production always uses the default.
 */
export async function renderRegion(
    page: pdfjsLib.PDFPageProxy,
    rect: SelectionRect,
    options: { dpi?: number; rotation?: number } = {},
): Promise<RenderedRegion> {
    const { dpi = REGISTER_DPI, rotation = 0 } = options;
    const scale = dpi / 72;

    const base = page.getViewport({ scale: 1, rotation });
    const box: SelectionRect = {
        left: Math.max(0, Math.min(rect.left, base.width)),
        right: Math.max(0, Math.min(rect.right, base.width)),
        top: Math.max(0, Math.min(rect.top, base.height)),
        bottom: Math.max(0, Math.min(rect.bottom, base.height)),
    };

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil((box.right - box.left) * scale));
    canvas.height = Math.max(1, Math.ceil((box.bottom - box.top) * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2D コンテキストを取得できませんでした。');
    // OCR reads dark on light; an unpainted canvas is transparent, which
    // composites to black in some renderers and produces nothing.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const viewport = page.getViewport({
        scale, rotation, offsetX: -box.left * scale, offsetY: -box.top * scale,
    });
    await page.render({ canvas, viewport, intent: 'print' }).promise;

    return {
        canvas, rect: box, scale,
        width: canvas.width, height: canvas.height,
        pixels: canvas.width * canvas.height,
    };
}

/** Zero a canvas so the browser can reclaim it immediately. */
export function releaseRegion(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}
