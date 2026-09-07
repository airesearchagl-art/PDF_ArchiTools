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
 * Coordinates are in **PDF points, origin top-left, y downwards** -- the space
 * a pdf.js viewport at scale 1 uses. That is already true of the app: pointer
 * events are divided by the zoom on the way in (`DrawingCanvas.tsx:129-138`),
 * so the stored numbers do not depend on how far the user was zoomed. This is
 * worth stating plainly because it means zoom-invariance is a property the
 * object model already has, and only the save path can throw it away.
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
 * The label text a measurement draws, computed the way the app computes it.
 *
 * Returned as a list of `{ text, x, y }` so a save path can place the same
 * strings. The app never stores these, so any candidate that wants them in the
 * output has to derive them -- and any candidate that forgets loses the numbers
 * while keeping the lines, which looks fine and means nothing.
 */
export function measureLabels(obj) {
    const p = obj.points;
    if (obj.subtype === 'line' && p.length >= 2) {
        const d = distance(p[0], p[1]);
        return [{
            text: formatLength(d, obj.scale),
            x: (p[0].x + p[1].x) / 2,
            y: (p[0].y + p[1].y) / 2 - 8,
        }];
    }
    if (obj.subtype === 'poly' && p.length >= 2) {
        const labels = [];
        let total = 0;
        for (let i = 0; i < p.length - 1; i++) {
            const d = distance(p[i], p[i + 1]);
            total += d;
            labels.push({
                text: formatLength(d, obj.scale),
                x: (p[i].x + p[i + 1].x) / 2,
                y: (p[i].y + p[i + 1].y) / 2 - 8,
            });
        }
        labels.push({
            text: `Σ ${formatLength(total, obj.scale)}`,
            x: p[p.length - 1].x + 8,
            y: p[p.length - 1].y,
        });
        return labels;
    }
    if (obj.subtype === 'area' && p.length >= 3) {
        const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
        const cy = p.reduce((s, q) => s + q.y, 0) / p.length;
        return [{ text: formatArea(p, obj.scale), x: cx, y: cy }];
    }
    return [];
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
