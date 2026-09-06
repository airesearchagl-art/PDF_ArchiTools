/**
 * Read a native page's text and ruling lines, in one coordinate space.
 *
 * Two things here are easy to get subtly wrong, and both were measured wrong
 * once before they were measured right:
 *
 *   1. A run's extent follows the text, not the screen. Laying `item.width`
 *      along display x is correct only while the page is upright.
 *   2. Reconstruction has to happen in the page's *upright* space. Rows are
 *      grouped by vertical overlap, so on a quarter-turned page the same code
 *      returns the table's transpose -- every cell present, every cell in the
 *      wrong place.
 *
 * So tokens, ruling lines and the user's selection all pass through the same
 * un-rotation before anything is reconstructed.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

import type { PageGeometry, RulingSegment, SelectionRect, TableToken } from './table-types';

/** Shorter than this in both directions and it is not a line, it is a dot. */
const MIN_SEGMENT = 0.4;

/** getTextContent returns text items mixed with marked-content markers. */
interface TextItemLike {
    str: string;
    width: number;
    height: number;
    transform: number[];
}

function isTextItem(item: unknown): item is TextItemLike {
    const candidate = item as Partial<TextItemLike> | null;
    return typeof candidate === 'object' && candidate !== null
        && typeof candidate.str === 'string' && Array.isArray(candidate.transform);
}

/**
 * Undo a page's /Rotate.
 *
 * pdf.js presents a rotated page as `R(user)`. Composing the inverse of that
 * with the upright viewport gives these maps, where W and H are the page's own
 * width and height rather than the rotated viewport's.
 */
export function toUprightPoint(
    x: number, y: number, rotate: number, displayWidth: number, displayHeight: number,
): { x: number; y: number } {
    const r = ((rotate % 360) + 360) % 360;
    const W = r % 180 === 90 ? displayHeight : displayWidth;
    const H = r % 180 === 90 ? displayWidth : displayHeight;
    switch (r) {
        case 90: return { x: y, y: H - x };
        case 180: return { x: W - x, y: H - y };
        case 270: return { x: W - y, y: x };
        default: return { x, y };
    }
}

/** The same map for a rectangle, re-bounded after the corners move. */
export function toUprightRect(
    rect: SelectionRect, rotate: number, displayWidth: number, displayHeight: number,
): SelectionRect {
    if (!rotate) return { ...rect };
    const a = toUprightPoint(rect.left, rect.top, rotate, displayWidth, displayHeight);
    const b = toUprightPoint(rect.right, rect.bottom, rotate, displayWidth, displayHeight);
    return {
        left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
        top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
    };
}

/**
 * Where a run of text actually sits, as a quad.
 *
 * `item.transform` is `[a,b,c,d,e,f]`: `(a,b)` is the baseline direction in
 * user space and `(c,d)` the direction glyphs rise in, both already carrying
 * the font size. `item.width` and `item.height` are lengths *along those two
 * directions*. So the run occupies the parallelogram from `(e,f)` spanned by
 * width along the normalised `(a,b)` and height along the normalised `(c,d)`,
 * and its display box is the bound of that quad's four corners.
 *
 * Exported for the gates: this is the piece that has to be right for a rotated
 * page, and it is worth being able to check on its own.
 */
export function runQuad(
    transform: number[], width: number, height: number, viewportTransform: number[],
): { x: number; y: number }[] {
    const [a, b, c, d, e, f] = transform;
    const uLen = Math.hypot(a, b) || 1;
    const vLen = Math.hypot(c, d) || 1;
    const ux = a / uLen;
    const uy = b / uLen;
    const vx = c / vLen;
    const vy = d / vLen;
    const m = viewportTransform;
    return [[0, 0], [width, 0], [width, height], [0, height]].map(([s, t]) => {
        const x = e + s * ux + t * vx;
        const y = f + s * uy + t * vy;
        return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
    });
}

/**
 * Whitespace-only items carry no content and no height.
 *
 * pdf.js emits a separate item for a run of spaces, and those items report a
 * height of zero. Left in, each becomes a zero-height row of its own and splits
 * the row it sits in, so a four-row table groups as twelve.
 */
export function isContentToken(text: string): boolean {
    return text.trim() !== '';
}

async function readTokens(page: PDFPageProxy, viewport: pdfjsLib.PageViewport): Promise<TableToken[]> {
    const content = await page.getTextContent();
    const vt = Array.from(viewport.transform);
    const rotate = page.rotate ?? 0;
    const tokens: TableToken[] = [];

    for (const item of content.items) {
        if (!isTextItem(item)) continue;
        if (!isContentToken(item.str)) continue;

        const quad = runQuad(item.transform, item.width, item.height, vt)
            .map((p) => toUprightPoint(p.x, p.y, rotate, viewport.width, viewport.height));
        const xs = quad.map((p) => p.x);
        const ys = quad.map((p) => p.y);
        const dx = quad[1].x - quad[0].x;
        const dy = quad[1].y - quad[0].y;
        const len = Math.hypot(dx, dy) || 1;

        tokens.push({
            text: item.str,
            x0: Math.min(...xs), x1: Math.max(...xs),
            y0: Math.min(...ys), y1: Math.max(...ys),
            width: item.width,
            height: item.height,
            direction: { x: dx / len, y: dy / len },
        });
    }
    return tokens;
}

/** How many coordinates each path opcode consumes, in pdf.js 5.x path data. */
const PATH_OPCODE_ARITY: Record<number, number> = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0, 5: 0 };

/**
 * Recover axis-aligned ruling lines from the page's own vector content.
 *
 * The path data is a flat `[opcode, ...coords]` array whose opcode numbering is
 * an internal detail of pdf.js, so the decode is checked against the `minMax`
 * the same call carries. **A decode that does not reproduce that bounding box
 * is discarded rather than trusted**: an invented ruling line becomes an
 * invented cell boundary, and there is no way to see that in the result.
 */
async function readRulingSegments(page: PDFPageProxy, viewport: pdfjsLib.PageViewport): Promise<RulingSegment[]> {
    const list = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const rotate = page.rotate ?? 0;

    let ctm = Array.from(viewport.transform);
    const stack: number[][] = [];
    const out: RulingSegment[] = [];

    const decodePath = (data: number[]) => {
        const points: number[][] = [];
        const segments: number[][] = [];
        let cx = 0; let cy = 0; let sx = 0; let sy = 0; let started = false;
        for (let i = 0; i < data.length;) {
            const op = data[i++];
            const arity = PATH_OPCODE_ARITY[op];
            if (arity === undefined || i + arity > data.length) return null;
            if (arity === 2) {
                const x = data[i++];
                const y = data[i++];
                points.push([x, y]);
                if (op === 0) { cx = x; cy = y; sx = x; sy = y; started = true; }
                else { if (started) segments.push([cx, cy, x, y]); cx = x; cy = y; }
            } else if (arity > 0) {
                for (let k = 0; k < arity; k += 2) points.push([data[i + k], data[i + k + 1]]);
                i += arity;
                cx = data[i - 2]; cy = data[i - 1];
            } else if (started) {
                segments.push([cx, cy, sx, sy]);
                cx = sx; cy = sy;
            }
        }
        return { points, segments };
    };

    for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i];
        const args = list.argsArray[i];
        if (fn === OPS.save) { stack.push(Array.from(ctm)); continue; }
        if (fn === OPS.restore) { ctm = stack.pop() ?? ctm; continue; }
        if (fn === OPS.transform) { ctm = pdfjsLib.Util.transform(ctm, args as number[]); continue; }
        if (fn !== OPS.constructPath) continue;

        const subpaths = Array.isArray(args[1]) ? args[1] : [args[1]];
        const minMax = args[2] as ArrayLike<number> | undefined;
        const segments: number[][] = [];
        const points: number[][] = [];
        let decoded = true;
        for (const sub of subpaths) {
            const got = decodePath(Array.from((sub ?? []) as ArrayLike<number>));
            if (!got) { decoded = false; break; }
            segments.push(...got.segments);
            points.push(...got.points);
        }
        if (!decoded || points.length === 0 || !minMax || minMax.length !== 4) continue;

        // Self-check. If the decode does not reproduce pdf.js's own bounding
        // box for this path, it is wrong, and a wrong ruling line is worse than
        // no ruling line: the geometry fallback can still find the table.
        const near = (p: number, q: number) => Math.abs(p - q) < 0.01;
        const bx0 = Math.min(...points.map((p) => p[0]));
        const by0 = Math.min(...points.map((p) => p[1]));
        const bx1 = Math.max(...points.map((p) => p[0]));
        const by1 = Math.max(...points.map((p) => p[1]));
        if (!near(bx0, minMax[0]) || !near(by0, minMax[1]) || !near(bx1, minMax[2]) || !near(by1, minMax[3])) {
            continue;
        }

        for (const [ax, ay, qx, qy] of segments) {
            const p = {
                x: ctm[0] * ax + ctm[2] * ay + ctm[4],
                y: ctm[1] * ax + ctm[3] * ay + ctm[5],
            };
            const q = {
                x: ctm[0] * qx + ctm[2] * qy + ctm[4],
                y: ctm[1] * qx + ctm[3] * qy + ctm[5],
            };
            const up = toUprightPoint(p.x, p.y, rotate, viewport.width, viewport.height);
            const uq = toUprightPoint(q.x, q.y, rotate, viewport.width, viewport.height);
            const dx = Math.abs(up.x - uq.x);
            const dy = Math.abs(up.y - uq.y);
            if (dx < MIN_SEGMENT && dy < MIN_SEGMENT) continue;
            // A diagonal is not a ruling line and is not guessed into one.
            if (dx > MIN_SEGMENT && dy > MIN_SEGMENT) continue;
            out.push({
                orientation: dx >= dy ? 'h' : 'v',
                x0: Math.min(up.x, uq.x), x1: Math.max(up.x, uq.x),
                y0: Math.min(up.y, uq.y), y1: Math.max(up.y, uq.y),
                length: Math.max(dx, dy),
            });
        }
    }
    return out;
}

/**
 * Everything one page offers, in upright space.
 *
 * A page with no text of its own is reported as `scanned` with no tokens. It is
 * never sent to OCR from here: Excel export is native-only, and quietly
 * recognising the page would be both slow and a promise the feature does not
 * make.
 */
export async function analysePageGeometry(
    doc: PDFDocumentProxy, pageNumber: number,
): Promise<PageGeometry> {
    const page = await doc.getPage(pageNumber);
    try {
        const viewport = page.getViewport({ scale: 1 });
        const rotate = page.rotate ?? 0;
        const tokens = await readTokens(page, viewport);
        const segments = tokens.length ? await readRulingSegments(page, viewport) : [];
        const quarter = ((rotate % 360) + 360) % 360 % 180 === 90;
        return {
            pageNumber,
            rotate,
            displayWidth: viewport.width,
            displayHeight: viewport.height,
            uprightWidth: quarter ? viewport.height : viewport.width,
            uprightHeight: quarter ? viewport.width : viewport.height,
            tokens,
            segments,
            scanned: tokens.length === 0,
        };
    } finally {
        page.cleanup();
    }
}

/**
 * A rectangle drawn on a rendered canvas, in the space the grid lives in.
 *
 * The user drags in canvas pixels. Those become display-space points by the
 * render scale, and display-space points become upright points by the page's
 * rotation. Skipping the second step is the failure that leaves the tokens
 * normalised and the selection somewhere else entirely.
 */
export function canvasRectToUpright(
    rect: SelectionRect, scale: number, page: PageGeometry,
): SelectionRect {
    const display: SelectionRect = {
        left: rect.left / scale,
        top: rect.top / scale,
        right: rect.right / scale,
        bottom: rect.bottom / scale,
    };
    return toUprightRect(display, page.rotate, page.displayWidth, page.displayHeight);
}

/** Tokens whose centre falls inside a rectangle. */
export function tokensInRect(tokens: TableToken[], rect: SelectionRect): TableToken[] {
    return tokens.filter((t) => {
        const cx = (t.x0 + t.x1) / 2;
        const cy = (t.y0 + t.y1) / 2;
        return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
    });
}

/** Ruling segments clipped to a rectangle. */
export function segmentsInRect(segments: RulingSegment[], rect: SelectionRect): RulingSegment[] {
    const out: RulingSegment[] = [];
    for (const s of segments) {
        if (s.x1 < rect.left || s.x0 > rect.right || s.y1 < rect.top || s.y0 > rect.bottom) continue;
        const x0 = Math.max(s.x0, rect.left);
        const x1 = Math.min(s.x1, rect.right);
        const y0 = Math.max(s.y0, rect.top);
        const y1 = Math.min(s.y1, rect.bottom);
        if (x1 < x0 || y1 < y0) continue;
        out.push({ ...s, x0, x1, y0, y1, length: Math.max(x1 - x0, y1 - y0) });
    }
    return out;
}

/**
 * How strongly a selection and a grid point at each other, 0 to 1.
 *
 * The shared area over the *smaller* of the two, not over their union.
 * Intersection-over-union answers "are these the same rectangle", which is not
 * the question: a generous box drawn round a small table scores badly by that
 * measure even though it obviously means that table, and a box drawn inside a
 * large table scores badly too. Both of those are ordinary things to do, and
 * both mean "this one".
 */
export function rectOverlap(a: SelectionRect, b: SelectionRect): number {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return 0;
    const inter = (right - left) * (bottom - top);
    const areaA = (a.right - a.left) * (a.bottom - a.top);
    const areaB = (b.right - b.left) * (b.bottom - b.top);
    const smaller = Math.min(areaA, areaB);
    return smaller > 0 ? inter / smaller : 0;
}
