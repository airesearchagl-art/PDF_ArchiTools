/**
 * A mirror of the annotator's object model, and a sample set to save.
 *
 * RESEARCH ONLY. Nothing here is imported by the app, and this does not import
 * the app: the research must not be able to change production behaviour, and a
 * shared type would make that possible by accident.
 *
 * The shapes below are copied from `src/components/DrawingCanvas.tsx` as it
 * stands at 320d98b, field for field, because an architecture that saves a
 * model the app does not have is worthless. Where the app's model is thinner
 * than one might expect, the mirror is thin in the same way and the gap is
 * recorded rather than quietly filled in:
 *
 *   - a measurement carries no label text. Labels are computed at draw time
 *     from the points and the stored scale (`DrawingCanvas.tsx:296-362`), so a
 *     save path has to compute them the same way or lose them.
 *   - a measurement has no line width; the renderer hardcodes 2
 *     (`DrawingCanvas.tsx:263`).
 *   - an area's fill is hardcoded as the stroke colour at 30%
 *     (`DrawingCanvas.tsx:277-278`), not stored.
 *   - nothing carries a layer id. A layer is a separate canvas with its own
 *     object array (`PdfPage.tsx:142-162`), so "which layer" is not a property
 *     of an object at all.
 *   - pressure is per point, and a stroke replays as one straight segment per
 *     point pair whose width is the mean of the two pressures
 *     (`DrawingCanvas.tsx:242-254`).
 *
 * **The coordinate space, precisely.** Stored coordinates are in *display
 * space*: points, origin top-left, y downwards, **with `/Rotate` already
 * applied**. Not upright space. The chain is short and worth following, because
 * an earlier version of this file got it wrong and the error is invisible on an
 * unrotated page:
 *
 *   `PdfPage.tsx:74` sizes the canvas from `pageProxy.getViewport({ scale })`,
 *   with no `rotation` argument, so the viewport carries the page's own
 *   `/Rotate`. `DrawingCanvas.tsx:129-138` then converts a pointer event with
 *   `(clientX - rect.left) / scale` and nothing else. Dividing by the zoom
 *   removes the zoom; nothing removes the rotation.
 *
 * So a stored coordinate is zoom-independent -- that part was right -- and on a
 * page with `/Rotate 90` it is expressed in the rotated frame the user is
 * looking at. A save path must undo the rotation before writing, because a
 * content stream is written unrotated.
 *
 * That is `displayToUpright()` in `coords.mjs`, and it is not optional: skipping
 * it puts every mark on a rotated page in the wrong place, and every fixture
 * that happens to be at `/Rotate 0` will agree that nothing is wrong.
 */

/** @typedef {{ x: number, y: number, pressure?: number }} Point */

/**
 * @typedef {{
 *   id: string, type: 'stroke', points: Point[], color: string,
 *   lineWidth: number, opacity: number,
 *   enablePressure?: boolean, isEraser?: boolean,
 * }} StrokeObject
 */

/**
 * @typedef {{
 *   id: string, type: 'text', x: number, y: number, text: string,
 *   fontSize: number, fontFamily: string, color: string, opacity: number,
 * }} TextObject
 */

/**
 * @typedef {{
 *   id: string, type: 'measure', subtype: 'line'|'poly'|'area',
 *   points: Point[], color: string,
 *   scale: { value: number, unit: string }, opacity: 1,
 * }} MeasureObject
 */

/** Hardcoded in the renderer rather than stored on the object. */
export const MEASURE_LINE_WIDTH = 2;
/** `obj.color + '4d'` -- 30% alpha -- in `DrawingCanvas.tsx:278`. */
export const MEASURE_FILL_ALPHA = 0x4d / 255;

export const DEFAULT_SCALE = { value: 0.3527, unit: 'mm' };

const line = (from, to, steps = 12, pressure = null) => {
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        points.push({
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
            ...(pressure === null ? {} : { pressure: pressure(t) }),
        });
    }
    return points;
};

/**
 * The annotation set every candidate is asked to save.
 *
 * One of each thing the app can produce, placed so that nothing overlaps
 * anything else -- a fidelity comparison of overlapping marks cannot say which
 * one went wrong. Positions are in points from the top-left of an A4 page and
 * are chosen to sit inside the tightest CropBox in the corpus, so the same set
 * is meaningful on every fixture.
 */
export function sampleAnnotations() {
    return [
        // A plain pen stroke.
        {
            id: 'stroke-plain',
            type: 'stroke',
            points: line({ x: 90, y: 140 }, { x: 300, y: 200 }),
            color: '#FF0000',
            lineWidth: 3,
            opacity: 1,
            enablePressure: false,
        },
        // A semi-transparent stroke: alpha is its own preservation question.
        {
            id: 'stroke-alpha',
            type: 'stroke',
            points: line({ x: 90, y: 230 }, { x: 300, y: 230 }),
            color: '#0000FF',
            lineWidth: 6,
            opacity: 0.4,
            enablePressure: false,
        },
        // A pressure stroke: one segment per point pair, width from the mean of
        // the two pressures. Thirteen points means twelve segments, each a
        // different width -- the case that decides whether pressure is cheap to
        // express as vector operators or expensive.
        {
            id: 'stroke-pressure',
            type: 'stroke',
            points: line({ x: 90, y: 270 }, { x: 300, y: 300 }, 12, (t) => 0.15 + 0.85 * Math.sin(Math.PI * t)),
            color: '#008000',
            lineWidth: 8,
            opacity: 1,
            enablePressure: true,
        },
        // A pixel-eraser stroke crossing the plain one. In the app this is a
        // normal object replayed with destination-out, and it only subtracts
        // from objects earlier in the array.
        {
            id: 'stroke-eraser-mark',
            type: 'stroke',
            points: line({ x: 150, y: 120 }, { x: 190, y: 220 }, 8),
            color: '#ffffff',
            lineWidth: 14,
            opacity: 1,
            enablePressure: false,
            isEraser: true,
        },
        // Text, in three alphabets plus a character a font may not have.
        {
            id: 'text-ascii',
            type: 'text',
            x: 90, y: 360,
            text: 'REVISION A',
            fontSize: 16,
            fontFamily: 'Arial',
            color: '#000000',
            opacity: 1,
        },
        {
            id: 'text-japanese',
            type: 'text',
            x: 90, y: 390,
            text: '確認済み 2026年9月',
            fontSize: 16,
            fontFamily: 'Arial',
            color: '#800080',
            opacity: 1,
        },
        {
            id: 'text-mixed',
            type: 'text',
            x: 90, y: 420,
            text: 'A-101 図面 <check> & ok',
            fontSize: 14,
            fontFamily: 'Arial',
            color: '#00008B',
            opacity: 1,
        },
        // A measurement line, a polyline and an area.
        {
            id: 'measure-line',
            type: 'measure',
            subtype: 'line',
            points: [{ x: 90, y: 470 }, { x: 280, y: 470 }],
            color: '#FF00FF',
            scale: DEFAULT_SCALE,
            opacity: 1,
        },
        {
            id: 'measure-poly',
            type: 'measure',
            subtype: 'poly',
            points: [{ x: 90, y: 510 }, { x: 170, y: 545 }, { x: 260, y: 505 }],
            color: '#FFA500',
            scale: DEFAULT_SCALE,
            opacity: 1,
        },
        {
            id: 'measure-area',
            type: 'measure',
            subtype: 'area',
            points: [{ x: 90, y: 580 }, { x: 250, y: 580 }, { x: 250, y: 670 }, { x: 90, y: 670 }],
            color: '#00008B',
            scale: DEFAULT_SCALE,
            opacity: 1,
        },
    ];
}

/** Distance helper, matching `DrawingCanvas.tsx:193`. */
export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** `formatLength`, matching `DrawingCanvas.tsx:195-198`. */
export function formatLength(pixels, scale) {
    const v = pixels * scale.value;
    return `${v.toFixed(2)} ${scale.unit}`;
}

/** `formatArea`, matching `DrawingCanvas.tsx:200-210` -- shoelace, scale squared. */
export function formatArea(points, scale) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }
    area = Math.abs(area) / 2;
    const v = area * (scale.value * scale.value);
    return `${v.toFixed(2)} ${scale.unit}²`;
}

/**
 * Every label a measurement draws, matched to `DrawingCanvas.tsx:296-362`.
 *
 * The app stores none of this -- the strings, their positions, their fonts and
 * their white backing rectangles are all computed at draw time -- so a save
 * path that wants them has to compute the same things. Getting the strings
 * right and the placement wrong is not much better than losing them: the
 * numbers end up somewhere that is not the line they describe.
 *
 * Each entry carries what the canvas actually uses, so both the mirror renderer
 * and the vector writer can be driven from one description rather than two that
 * drift:
 *
 *   `text`      the string
 *   `x`, `y`    where `fillText` is called, in stored (display) space
 *   `font`      the CSS font shorthand the app sets
 *   `size`      the same size as a number, for the PDF writer
 *   `bold`      whether that font is bold
 *   `align`     `center` or `left`, as `ctx.textAlign` is set
 *   `colour`    `null` means the measurement's own colour
 *   `box`       the white rectangle drawn behind it, or null
 *
 * `textBaseline` is `'bottom'` for all of them (`DrawingCanvas.tsx:299`).
 */
export function measureLabels(obj) {
    const p = obj.points;
    const out = [];
    if (p.length < 2) return out;

    if (obj.subtype === 'line') {
        const [p1, p2] = p;
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const text = formatLength(distance(p1, p2), obj.scale);
        out.push({
            text, x: midX, y: midY,
            font: '12px Arial', size: 12, bold: false, align: 'center', colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
        return out;
    }

    if (obj.subtype === 'poly') {
        let total = 0;
        for (let i = 0; i < p.length - 1; i++) {
            const d = distance(p[i], p[i + 1]);
            total += d;
            const midX = (p[i].x + p[i + 1].x) / 2;
            const midY = (p[i].y + p[i + 1].y) / 2;
            out.push({
                // The segment label sits 4 points below the midpoint and is
                // drawn in grey, not in the measurement's colour.
                text: formatLength(d, obj.scale), x: midX, y: midY + 4,
                font: '10px Arial', size: 10, bold: false, align: 'center', colour: '#555555',
                box: { dx: -1, dy: -10, padWidth: 2, height: 12 },
            });
        }
        const last = p[p.length - 1];
        out.push({
            text: `Total: ${formatLength(total, obj.scale)}`,
            x: last.x + 6, y: last.y,
            font: 'bold 12px Arial', size: 12, bold: true, align: 'left', colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
        return out;
    }

    if (obj.subtype === 'area' && p.length >= 3) {
        const cx = p.reduce((s2, q) => s2 + q.x, 0) / p.length;
        const cy = p.reduce((s2, q) => s2 + q.y, 0) / p.length;
        out.push({
            text: formatArea(p, obj.scale), x: cx, y: cy,
            font: '12px Arial', size: 12, bold: false, align: 'center', colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
    }
    return out;
}

/** Vertices are drawn on poly and area measurements, radius 3. */
export const MEASURE_VERTEX_RADIUS = 3;
export const measureHasVertices = (obj) => obj.subtype !== 'line';

/**
 * Where a label's backing rectangle goes, given the text width.
 *
 * `align: 'left'` anchors the box at the label's x; everything else centres it.
 * Matching `DrawingCanvas.tsx:311-312`, `:329-330`, `:341-343` and `:358-359`.
 */
export function labelBox(label, textWidth) {
    if (!label.box) return null;
    const left = label.align === 'left'
        ? label.x + label.box.dx
        : label.x - textWidth / 2 + label.box.dx;
    return {
        x: left,
        y: label.y + label.box.dy,
        width: textWidth + label.box.padWidth,
        height: label.box.height,
    };
}

/** #rrggbb -> {r,g,b} in 0..1, for pdf-lib. */
export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * The width the app draws for one segment of a pressure stroke.
 *
 * `DrawingCanvas.tsx:247-252`: the mean of the two endpoint pressures, doubled,
 * times the stroke's own width. A point with no pressure counts as 0.5.
 */
export function segmentWidth(obj, i) {
    if (!obj.enablePressure) return obj.lineWidth;
    const a = obj.points[i].pressure ?? 0.5;
    const b = obj.points[i + 1].pressure ?? 0.5;
    return obj.lineWidth * (((a + b) / 2) * 2);
}
