/**
 * Everything an object actually paints, with a margin for error.
 *
 * Using the geometry points and the nominal line width is wrong in several ways
 * at once: a pressure stroke can be twice its nominal width, text extends below
 * and right of its anchor by an amount only the font knows, and a measurement
 * draws vertex dots and labels with backing rectangles that reach well outside
 * the geometry — a poly's total label sits past its last point entirely.
 *
 * Under-reporting is the dangerous direction. It lets an eraser and the ink it
 * touches look unrelated, which puts them in different runs and changes what the
 * user drew. Over-reporting only costs pixels. So every estimate rounds outward,
 * and anything unknown counts as painted.
 */
import type { SaveAnnotation } from './types';
import {
    MEASURE_LINE_WIDTH, MEASURE_VERTEX_RADIUS, measureHasVertices,
    measureLabels, labelBox, segmentWidth,
} from './measure-model';

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

let measuringCtx: CanvasRenderingContext2D | null = null;

/** Text width under a CSS font shorthand, measured the way the canvas will. */
export function textWidth(text: string, font: string): number {
    if (!measuringCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        measuringCtx = canvas.getContext('2d');
    }
    if (!measuringCtx) return text.length * 8; // no canvas: assume wide
    measuringCtx.font = font;
    return measuringCtx.measureText(text).width;
}

export function paintedBounds(obj: SaveAnnotation): Bounds | null {
    const boxes: Bounds[] = [];
    const add = (minX: number, minY: number, maxX: number, maxY: number) => {
        boxes.push({ minX, minY, maxX, maxY });
    };

    if (obj.type === 'stroke') {
        const xs = obj.points.map((p) => p.x);
        const ys = obj.points.map((p) => p.y);
        let widest = obj.lineWidth;
        if (obj.enablePressure) {
            for (let i = 0; i < obj.points.length - 1; i++) {
                widest = Math.max(widest, segmentWidth(obj, i));
            }
        }
        const half = widest / 2 + 1;
        add(Math.min(...xs) - half, Math.min(...ys) - half,
            Math.max(...xs) + half, Math.max(...ys) + half);
    } else if (obj.type === 'text') {
        const font = `${obj.fontSize}px ${obj.fontFamily} `;
        const w = textWidth(obj.text, font);
        // Anchored at the top (`textBaseline = 'top'`); a generous descent
        // allowance below, because the real descent is not knowable from the
        // size alone.
        add(obj.x - 2, obj.y - 2, obj.x + w + 2, obj.y + obj.fontSize * 1.6 + 2);
    } else {
        const xs = obj.points.map((p) => p.x);
        const ys = obj.points.map((p) => p.y);
        const pad = MEASURE_LINE_WIDTH / 2
            + (measureHasVertices(obj) ? MEASURE_VERTEX_RADIUS : 0) + 1;
        add(Math.min(...xs) - pad, Math.min(...ys) - pad,
            Math.max(...xs) + pad, Math.max(...ys) + pad);

        for (const label of measureLabels(obj)) {
            const w = textWidth(label.text, label.font);
            const box = labelBox(label, w);
            if (box) {
                add(box.x - 1, box.y - 1, box.x + box.width + 1, box.y + box.height + 1);
            }
            // The glyphs themselves, which can overhang the backing rectangle.
            const left = label.align === 'left' ? label.x : label.x - w / 2;
            add(left - 1, label.y - label.size - 2, left + w + 1, label.y + 2);
        }
    }

    if (boxes.length === 0) return null;
    return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
}

/** Unknown bounds count as touching: the safe direction. */
export function boundsOverlap(a: Bounds | null, b: Bounds | null): boolean {
    if (!a || !b) return true;
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}
