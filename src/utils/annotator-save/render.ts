/**
 * Draw annotation objects onto a canvas, the way the app draws them.
 *
 * Used only for raster fragments — the span a pixel eraser reaches into, and a
 * text object whose glyphs the embedded font lacks. Everything else is written
 * as operators.
 *
 * Deliberately a copy of `DrawingCanvas.tsx:212-371` rather than a tidy-up,
 * down to the details that look like accidents: text is anchored at its *top*,
 * an area is stroked before it is filled, poly and area measurements get vertex
 * dots, and every label has its own font, alignment, colour and white backing
 * rectangle. Where this differs from the app, the fragment differs from what the
 * user saw.
 *
 * What it deliberately does **not** copy is the selection highlight
 * (`DrawingCanvas.tsx:213-217`): a blue glow is UI, not a mark, and saving it
 * would put a shadow in the file around whatever happened to be selected.
 */
import type { SaveAnnotation } from './types';
import {
    MEASURE_LINE_WIDTH, MEASURE_VERTEX_RADIUS, measureHasVertices,
    measureLabels, labelBox, labelBoxAlpha, segmentWidth,
} from './measure-model';

export function renderAnnotations(
    ctx: CanvasRenderingContext2D,
    objects: readonly SaveAnnotation[],
    { scale = 1, offset = { x: 0, y: 0 } }: { scale?: number; offset?: { x: number; y: number } } = {},
): void {
    ctx.save();
    // setTransform *replaces* the transform, so an offset applied with
    // translate() beforehand would be discarded. The fragment needs one, so it
    // is folded into the same call.
    ctx.setTransform(scale, 0, 0, scale, -offset.x * scale, -offset.y * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const obj of objects) {
        ctx.globalAlpha = obj.opacity ?? 1;
        ctx.globalCompositeOperation = 'source-over';

        if (obj.type === 'stroke') {
            if (obj.points.length < 2) continue;
            if (obj.isEraser) {
                // The pixel eraser. A content stream cannot un-draw, which is
                // the entire reason this fragment exists.
                ctx.globalCompositeOperation = 'destination-out';
                ctx.strokeStyle = '#000000';
            } else {
                ctx.strokeStyle = obj.color;
            }

            if (!obj.enablePressure) {
                ctx.lineWidth = obj.lineWidth;
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x, obj.points[0].y);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x, obj.points[i].y);
                }
                ctx.stroke();
            } else {
                for (let i = 0; i < obj.points.length - 1; i++) {
                    ctx.beginPath();
                    ctx.moveTo(obj.points[i].x, obj.points[i].y);
                    ctx.lineTo(obj.points[i + 1].x, obj.points[i + 1].y);
                    ctx.lineWidth = segmentWidth(obj, i);
                    ctx.stroke();
                }
            }
        } else if (obj.type === 'text') {
            // Note the trailing space in the app's font string, and the *top*
            // baseline: the stored y is the top of the glyph box, not the
            // typographic baseline.
            ctx.font = `${obj.fontSize}px ${obj.fontFamily} `;
            ctx.fillStyle = obj.color;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            ctx.fillText(obj.text, obj.x, obj.y);
        } else {
            const p = obj.points;
            if (p.length < 2) continue;
            ctx.strokeStyle = obj.color;
            ctx.fillStyle = obj.color;
            ctx.lineWidth = MEASURE_LINE_WIDTH;

            ctx.beginPath();
            ctx.moveTo(p[0].x, p[0].y);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
            if (obj.subtype === 'area') {
                // Stroked first, then filled — the app's order, and it matters
                // because the translucent fill lands on top of the outline.
                ctx.closePath();
                ctx.stroke();
                const fillC = obj.color.startsWith('#') ? obj.color : '#0000ff';
                ctx.fillStyle = `${fillC}4d`;
                ctx.fill();
                ctx.fillStyle = obj.color;
            } else {
                ctx.stroke();
            }

            if (measureHasVertices(obj)) {
                ctx.fillStyle = obj.color;
                for (const q of p) {
                    ctx.beginPath();
                    ctx.arc(q.x, q.y, MEASURE_VERTEX_RADIUS, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            ctx.save();
            ctx.textBaseline = 'bottom';
            for (const label of measureLabels(obj)) {
                ctx.font = label.font;
                ctx.textAlign = label.align;
                const width = ctx.measureText(label.text).width;
                const box = labelBox(label, width);
                if (box) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${labelBoxAlpha(label)})`;
                    ctx.fillRect(box.x, box.y, box.width, box.height);
                }
                ctx.fillStyle = label.colour ?? obj.color;
                ctx.fillText(label.text, label.x, label.y);
            }
            ctx.restore();
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
}

/**
 * Let a canvas go.
 *
 * Some browsers hold the backing store until the element is collected, which on
 * a page with several fragments is a lot of memory for no reason.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 1;
    canvas.height = 1;
}
