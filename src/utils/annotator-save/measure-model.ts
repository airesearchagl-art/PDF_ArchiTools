/**
 * What a measurement draws, computed the way the renderer computes it.
 *
 * The app stores none of this. The label strings, their positions, their fonts
 * and their white backing rectangles are all derived at draw time from the
 * points and the stored scale (`DrawingCanvas.tsx:296-362`), so a save path that
 * wants them has to derive the same things. Getting the strings right and the
 * placement wrong is barely better than losing them: the numbers end up
 * somewhere that is not the line they describe.
 *
 * Every constant here is quoted from the renderer rather than chosen.
 */
import type { MeasureAnnotation, SavePoint } from './types';

/** `DrawingCanvas.tsx:263` — fixed, not stored on the object. */
export const MEASURE_LINE_WIDTH = 2;

/** `DrawingCanvas.tsx:290` — poly and area only. */
export const MEASURE_VERTEX_RADIUS = 3;

export const measureHasVertices = (obj: MeasureAnnotation): boolean => obj.subtype !== 'line';

/** `DrawingCanvas.tsx:193`. */
export const distance = (a: SavePoint, b: SavePoint): number => Math.hypot(b.x - a.x, b.y - a.y);

/** `DrawingCanvas.tsx:195-198` — two decimals, one space, unit suffix. */
export function formatLength(pixels: number, scale: { value: number; unit: string }): string {
    return `${(pixels * scale.value).toFixed(2)} ${scale.unit}`;
}

/** `DrawingCanvas.tsx:200-210` — shoelace with wraparound, scale squared. */
export function formatArea(
    points: readonly SavePoint[], scale: { value: number; unit: string },
): string {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }
    area = Math.abs(area) / 2;
    return `${(area * scale.value * scale.value).toFixed(2)} ${scale.unit}²`;
}

export interface MeasureLabel {
    text: string;
    /** Where `fillText` is called, in stored (display) space. */
    x: number;
    y: number;
    /** The CSS font shorthand the renderer sets. */
    font: string;
    /** The same size as a number, for the PDF writer. */
    size: number;
    bold: boolean;
    align: 'center' | 'left';
    /** `null` means the measurement's own colour. */
    colour: string | null;
    /** The white rectangle behind it, relative to (x, y) and the text width. */
    box: { dx: number; dy: number; padWidth: number; height: number } | null;
}

/**
 * Every label a measurement draws.
 *
 * `textBaseline` is `'bottom'` throughout (`DrawingCanvas.tsx:299`), so `y` is
 * the text's baseline.
 */
export function measureLabels(obj: MeasureAnnotation): MeasureLabel[] {
    const p = obj.points;
    const out: MeasureLabel[] = [];
    if (p.length < 2) return out;

    if (obj.subtype === 'line') {
        // `DrawingCanvas.tsx:302-315`
        const [p1, p2] = p;
        out.push({
            text: formatLength(distance(p1, p2), obj.scale),
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2,
            font: '12px Arial',
            size: 12,
            bold: false,
            align: 'center',
            colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
        return out;
    }

    if (obj.subtype === 'poly') {
        // `DrawingCanvas.tsx:316-346`
        let total = 0;
        for (let i = 0; i < p.length - 1; i++) {
            const d = distance(p[i], p[i + 1]);
            total += d;
            out.push({
                text: formatLength(d, obj.scale),
                x: (p[i].x + p[i + 1].x) / 2,
                // The renderer offsets the segment label 4 below the midpoint
                // "for vertical centering approx", and draws it grey rather
                // than in the measurement's colour.
                y: (p[i].y + p[i + 1].y) / 2 + 4,
                font: '10px Arial',
                size: 10,
                bold: false,
                align: 'center',
                colour: '#555555',
                box: { dx: -1, dy: -10, padWidth: 2, height: 12 },
            });
        }
        // The total never includes a closing segment (`:317-320`).
        const last = p[p.length - 1];
        out.push({
            text: `Total: ${formatLength(total, obj.scale)}`,
            x: last.x + 6,
            y: last.y,
            font: 'bold 12px Arial',
            size: 12,
            bold: true,
            align: 'left',
            colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
        return out;
    }

    if (obj.subtype === 'area' && p.length >= 3) {
        // `DrawingCanvas.tsx:348-361` — the unweighted mean of the points, and
        // still `12px Arial`, because the poly branch's font switches never run.
        out.push({
            text: formatArea(p, obj.scale),
            x: p.reduce((s, q) => s + q.x, 0) / p.length,
            y: p.reduce((s, q) => s + q.y, 0) / p.length,
            font: '12px Arial',
            size: 12,
            bold: false,
            align: 'center',
            colour: null,
            box: { dx: -2, dy: -14, padWidth: 4, height: 16 },
        });
    }
    return out;
}

/**
 * Where a label's backing rectangle goes, given the measured text width.
 *
 * `align: 'left'` anchors at the label's x; everything else centres.
 * `DrawingCanvas.tsx:311-312`, `:331-332`, `:341-343`, `:358-359`.
 */
export function labelBox(
    label: MeasureLabel, textWidth: number,
): { x: number; y: number; width: number; height: number } | null {
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

/** The white behind a label: 0.9 for the bold total, 0.8 for the rest. */
export const labelBoxAlpha = (label: MeasureLabel): number => (label.bold ? 0.9 : 0.8);

/**
 * The width the renderer draws for one segment of a pressure stroke.
 *
 * `DrawingCanvas.tsx:246,251`: the mean of the two endpoint pressures, doubled,
 * times the stroke's own width. A point with no pressure counts as 0.5, so an
 * unpressured stroke comes out at its nominal width and a fully pressed one at
 * twice it.
 */
export function segmentWidth(
    obj: { lineWidth: number; enablePressure?: boolean; points: readonly SavePoint[] },
    i: number,
): number {
    if (!obj.enablePressure) return obj.lineWidth;
    const a = obj.points[i].pressure ?? 0.5;
    const b = obj.points[i + 1].pressure ?? 0.5;
    return obj.lineWidth * (((a + b) / 2) * 2);
}
