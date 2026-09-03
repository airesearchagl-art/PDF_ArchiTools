import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PageClassification } from './types';

/**
 * Fraction of each edge treated as margin and excluded from the text test.
 *
 * Matches OCRmyPDF's `_page_has_text`, and for the same reason: a scanned sheet
 * often still carries a page number, a header or a drawing-number stamp, and
 * counting that as "this page already has text" would wrongly skip OCR for the
 * whole page.
 */
const MARGIN_RATIO = 0.125;

interface TextItemLike {
    str: string;
    transform: number[];
    width: number;
    height: number;
}

/** getTextContent returns text items mixed with marked-content markers. */
function isTextItem(item: unknown): item is TextItemLike {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Partial<TextItemLike>;
    return typeof candidate.str === 'string' && Array.isArray(candidate.transform);
}

/**
 * Decide whether a page already carries usable text, so OCR can be skipped.
 *
 * Judged per page: a document with a born-digital cover and scanned drawings
 * behind it must OCR only the drawings.
 */
export async function classifyPage(page: PDFPageProxy): Promise<PageClassification> {
    const [x0, y0, x1, y1] = page.view;
    const width = x1 - x0;
    const height = y1 - y0;
    const ix0 = x0 + width * MARGIN_RATIO;
    const ix1 = x1 - width * MARGIN_RATIO;
    const iy0 = y0 + height * MARGIN_RATIO;
    const iy1 = y1 - height * MARGIN_RATIO;

    const textContent = await page.getTextContent();
    let allChars = 0;
    let interiorChars = 0;

    for (const item of textContent.items) {
        if (!isTextItem(item)) continue;
        const chars = item.str.replace(/\s/g, '').length;
        if (chars === 0) continue;
        allChars += chars;

        // Intersect the item's box with the interior region rather than testing
        // its origin. A body line can start left of the margin inset and still
        // cross the page; testing only its start point reads that as marginal.
        const bx0 = item.transform[4];
        const by0 = item.transform[5];
        const bx1 = bx0 + (item.width ?? 0);
        const by1 = by0 + (item.height ?? 0);
        if (bx1 >= ix0 && bx0 <= ix1 && by1 >= iy0 && by0 <= iy1) {
            interiorChars += chars;
        }
    }

    const operatorList = await page.getOperatorList();
    const ops = pdfjsLib.OPS;
    let imageOps = 0;
    for (const fn of operatorList.fnArray) {
        if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) imageOps++;
    }

    return {
        pageNumber: page.pageNumber,
        kind: interiorChars > 0 ? 'text-native' : 'scanned',
        allChars,
        interiorChars,
        imageOps,
    };
}

/**
 * Classify every page up front.
 *
 * Done as a separate pass so the caller knows, before touching the OCR engine
 * or the Japanese font, whether either is needed at all.
 */
export async function classifyDocument(
    doc: pdfjsLib.PDFDocumentProxy,
    onPage?: (pageNumber: number, total: number) => void,
): Promise<PageClassification[]> {
    const out: PageClassification[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        onPage?.(i, doc.numPages);
        const page = await doc.getPage(i);
        out.push(await classifyPage(page));
        page.cleanup();
    }
    return out;
}
