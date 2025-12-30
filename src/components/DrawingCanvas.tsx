import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';

export type ToolType = 'select' | 'pen' | 'eraser' | 'stroke-eraser' | 'rect-eraser' | 'lasso-eraser' | 'text' | 'select-rect' | 'select-lasso' | 'measure-line' | 'measure-poly' | 'measure-area' | 'calibrate';

export interface MeasurementScale {
    value: number; // world units per pixel (point)
    unit: 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'px';
}

interface DrawingCanvasProps {
    width: number;
    height: number;
    scale?: number; // Zoom scale
    color?: string;
    lineWidth?: number;
    opacity?: number;
    tool?: ToolType;
    pointerEvents?: 'auto' | 'none';
    enablePressure?: boolean;
    // Text Props
    fontSize?: number;
    fontFamily?: string;
    // Selection Props
    onSelectionChange?: (selectedIds: string[]) => void;
    onZoom?: (delta: number) => void;
    // Measurement Props
    measurementScale?: MeasurementScale;
    onCalibrationEnd?: (start: Point, end: Point) => void;
}

interface Point {
    x: number;
    y: number;
    pressure?: number;
}

interface BaseObject {
    id: string;
    type: string;
    isSelected?: boolean;
    opacity?: number; // Make optional on base, but specific types will have it
}

interface StrokeObject extends BaseObject {
    type: 'stroke';
    points: Point[];
    color: string;
    lineWidth: number;
    opacity: number;
    enablePressure?: boolean;
    isEraser?: boolean;
}

interface TextObject extends BaseObject {
    type: 'text';
    x: number;
    y: number;
    text: string;
    fontSize: number;
    fontFamily: string;
    color: string;
    opacity: number;
}

interface MeasureObject extends BaseObject {
    type: 'measure';
    subtype: 'line' | 'poly' | 'area';
    points: Point[];
    color: string;
    scale: MeasurementScale;
    opacity: 1; // Always opaque or fixed?
}

export type CanvasObject = StrokeObject | TextObject | MeasureObject;

export interface DrawingCanvasRef {
    duplicateSelection: () => void;
    deleteSelection: () => void;
}

const DrawingCanvasComponent: React.ForwardRefRenderFunction<DrawingCanvasRef, DrawingCanvasProps> = ({
    width,
    height,
    scale = 1,
    color = '#000000',
    lineWidth = 2,
    opacity = 1.0,
    tool = 'pen',
    pointerEvents = 'auto',
    enablePressure = false,
    fontSize = 16,
    fontFamily = 'Arial',
    onSelectionChange,
    onZoom,
    measurementScale = { value: 1, unit: 'm' } as MeasurementScale,
    onCalibrationEnd,
}, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [objects, setObjects] = useState<CanvasObject[]>([]);

    // Interaction States
    const [isDrawing, setIsDrawing] = useState(false);
    const currentPointsRef = useRef<Point[]>([]);
    const activeOperationTool = useRef<ToolType | null>(null); // Locks tool for stroke duration

    // Scroll state
    const isScrolling = useRef(false);
    const scrollStart = useRef<{ x: number, y: number, scrollTop: number, scrollLeft: number } | null>(null);

    // Pinch Zoom State
    const pointers = useRef(new Map<number, { x: number, y: number }>());
    const prevPinchDiff = useRef<number | null>(null);
    const tapStart = useRef<{ time: number, pos: Point } | null>(null);

    // Selection / Eraser States
    const [selectionRect, setSelectionRect] = useState<{ start: Point, end: Point } | null>(null);
    const [lassoPath, setLassoPath] = useState<Point[] | null>(null);

    // Text Input State
    const [textInput, setTextInput] = useState<{ x: number, y: number, text: string } | null>(null);

    // Selection Logic State
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState<Point | null>(null);
    const [initialDragObjects, setInitialDragObjects] = useState<CanvasObject[] | null>(null);

    // Helpers
    const getCoordinates = (event: React.PointerEvent | PointerEvent): Point | null => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) / scale,
            y: (event.clientY - rect.top) / scale,
            pressure: event.pressure
        };
    };

    const deleteSelectionInternal = () => {
        if (selectedIds.size === 0) return;
        setObjects(prev => prev.filter(o => !selectedIds.has(o.id)));
        setSelectedIds(new Set());
        onSelectionChange?.([]);
    };

    useImperativeHandle(ref, () => ({
        duplicateSelection: () => {
            if (selectedIds.size === 0) return;
            const newObjects: CanvasObject[] = [...objects];
            const newSelectedIds = new Set<string>();

            objects.forEach(obj => {
                if (selectedIds.has(obj.id)) {
                    // Clone logic
                    // ... verify deep clone if simple spread not enough (points array reference!)
                    // For now, simple logic as before
                    const cloned = JSON.parse(JSON.stringify(obj));
                    cloned.id = crypto.randomUUID();
                    if (cloned.type === 'stroke' || cloned.type === 'measure') {
                        cloned.points.forEach((p: Point) => { p.x += 20; p.y += 20; });
                    } else if (cloned.type === 'text') {
                        cloned.x += 20;
                        cloned.y += 20;
                    }
                    newObjects.push(cloned);
                    newSelectedIds.add(cloned.id);
                }
            });
            setObjects(newObjects);
            setSelectedIds(newSelectedIds);
            onSelectionChange?.(Array.from(newSelectedIds));
        },
        deleteSelection: deleteSelectionInternal
    }));

    // --- Rendering ---
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = width;
        canvas.height = height;

        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.font = `${fontSize}px ${fontFamily} `;

        // Measurement Helpers
        const getDistance = (p1: Point, p2: Point) => Math.hypot(p2.x - p1.x, p2.y - p1.y);

        const formatLength = (pixels: number, mScale: MeasurementScale) => {
            const val = pixels * mScale.value;
            return `${val.toFixed(2)} ${mScale.unit}`;
        };

        const formatArea = (points: Point[], mScale: MeasurementScale) => {
            let area = 0;
            for (let i = 0; i < points.length; i++) {
                const j = (i + 1) % points.length;
                area += points[i].x * points[j].y;
                area -= points[j].x * points[i].y;
            }
            area = Math.abs(area) / 2;
            const val = area * (mScale.value * mScale.value);
            return `${val.toFixed(2)} ${mScale.unit}²`;
        };

        const renderObject = (obj: CanvasObject) => {
            if (selectedIds.has(obj.id)) {
                ctx.save();
                ctx.shadowColor = 'blue';
                ctx.shadowBlur = 5;
            }

            ctx.globalAlpha = obj.opacity ?? 1.0;
            // Default Composite
            ctx.globalCompositeOperation = 'source-over';

            if (obj.type === 'stroke') {
                if (obj.isEraser) {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.strokeStyle = '#000000'; // Color ignored, opaque needed
                } else {
                    ctx.strokeStyle = obj.color;
                }
                ctx.fillStyle = obj.color;

                if (obj.points.length < 2) return;

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
                        const p1 = obj.points[i];
                        const p2 = obj.points[i + 1];
                        const midPressure = ((p1.pressure || 0.5) + (p2.pressure || 0.5)) / 2;

                        ctx.beginPath();
                        ctx.moveTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y);
                        ctx.lineWidth = obj.lineWidth * (midPressure * 2);
                        ctx.stroke();
                    }
                }
            } else if (obj.type === 'text') {
                ctx.font = `${obj.fontSize}px ${obj.fontFamily} `;
                ctx.fillStyle = obj.color;
                ctx.textBaseline = 'top';
                ctx.fillText(obj.text, obj.x, obj.y);
            } else if (obj.type === 'measure') {
                ctx.strokeStyle = obj.color;
                ctx.fillStyle = obj.color;
                ctx.lineWidth = 2; // Fixed width for measurement lines

                if (obj.points.length < 2) return;

                // Draw Lines
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x, obj.points[0].y);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x, obj.points[i].y);
                }
                if (obj.subtype === 'area') {
                    ctx.closePath();
                    ctx.stroke();
                    // Ensure color is hex for transparency suffix
                    const fillC = obj.color.startsWith('#') ? obj.color : '#0000ff';
                    ctx.fillStyle = fillC + '4d'; // 30% transparent fill
                    ctx.fill();
                    ctx.fillStyle = obj.color; // Reset for text
                } else {
                    ctx.stroke();
                }

                // Draw Vertices (for visibility during selection or always?)
                // Optional: Draw dots at vertices for Poly/Area
                if (obj.subtype !== 'line') {
                    ctx.fillStyle = obj.color;
                    obj.points.forEach(p => {
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
                        ctx.fill();
                    });
                }

                // Draw Text / Labels
                ctx.save();
                ctx.font = `12px Arial`;
                ctx.textBaseline = 'bottom';
                ctx.textAlign = 'center';

                if (obj.subtype === 'line') {
                    const p1 = obj.points[0];
                    const p2 = obj.points[1];
                    const midX = (p1.x + p2.x) / 2;
                    const midY = (p1.y + p2.y) / 2;
                    const text = formatLength(getDistance(p1, p2), obj.scale);

                    // Text Background
                    const textMetrics = ctx.measureText(text);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.fillRect(midX - textMetrics.width / 2 - 2, midY - 14, textMetrics.width + 4, 16);

                    ctx.fillStyle = obj.color;
                    ctx.fillText(text, midX, midY);
                } else if (obj.subtype === 'poly') {
                    let totalLen = 0;
                    for (let i = 0; i < obj.points.length - 1; i++) {
                        const dist = getDistance(obj.points[i], obj.points[i + 1]);
                        totalLen += dist;

                        // Segment length label
                        const p1 = obj.points[i];
                        const p2 = obj.points[i + 1];
                        const midX = (p1.x + p2.x) / 2;
                        const midY = (p1.y + p2.y) / 2;
                        const segText = formatLength(dist, obj.scale);

                        ctx.font = '10px Arial';
                        const segMetrics = ctx.measureText(segText);
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                        ctx.fillRect(midX - segMetrics.width / 2 - 1, midY - 6, segMetrics.width + 2, 12);
                        ctx.fillStyle = '#555'; // Darker gray for segment text
                        ctx.fillText(segText, midX, midY + 4); // +4 for vertical centering approx
                    }
                    const lastP = obj.points[obj.points.length - 1];
                    const text = "Total: " + formatLength(totalLen, obj.scale);

                    ctx.font = 'bold 12px Arial';
                    const textMetrics = ctx.measureText(text);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    // Display near last point
                    ctx.fillRect(lastP.x + 4, lastP.y - 14, textMetrics.width + 4, 16);
                    ctx.fillStyle = obj.color;
                    ctx.textAlign = 'left';
                    ctx.fillText(text, lastP.x + 6, lastP.y);

                } else if (obj.subtype === 'area') {
                    // Centroid approx
                    let cx = 0, cy = 0;
                    obj.points.forEach(p => { cx += p.x; cy += p.y; });
                    cx /= obj.points.length;
                    cy /= obj.points.length;

                    const text = formatArea(obj.points, obj.scale);
                    const textMetrics = ctx.measureText(text);

                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.fillRect(cx - textMetrics.width / 2 - 2, cy - 14, textMetrics.width + 4, 16);
                    ctx.fillStyle = obj.color;
                    ctx.fillText(text, cx, cy);
                }
                ctx.restore();
            }

            if (selectedIds.has(obj.id)) {
                ctx.restore();
            }
            ctx.globalAlpha = 1.0;
            ctx.globalCompositeOperation = 'source-over'; // Reset
        };

        objects.forEach(renderObject);

    }, [objects, width, height, selectedIds, scale]);

    // --- Interaction Logic ---


    const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (event.pointerType === 'touch') {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }

        if (pointers.current.size === 2 && onZoom) {
            const points = Array.from(pointers.current.values());
            const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            prevPinchDiff.current = dist;
            setIsDrawing(false);
            isScrolling.current = false;
            setIsDragging(false);
            return;
        }

        if (event.pointerType === 'touch') {
            const pos = getCoordinates(event);
            if (!pos) return;



            // Scroll Logic for Drawing Tools (Pen, Eraser, Measure)
            if (['pen', 'eraser', 'stroke-eraser', 'measure-line', 'measure-poly', 'measure-area', 'calibrate'].includes(tool || '')) {
                const canvas = canvasRef.current;
                const container = canvas?.closest('.pdf-scroll-container') as HTMLElement;
                if (container) {
                    isScrolling.current = true;
                    scrollStart.current = {
                        x: event.clientX,
                        y: event.clientY,
                        scrollTop: container.scrollTop,
                        scrollLeft: container.scrollLeft
                    };
                    if (pos) tapStart.current = { time: Date.now(), pos };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    return;
                }
            }
        }

        event.preventDefault(); // Stop Browser Scroll
        event.currentTarget.setPointerCapture(event.pointerId);
        const pos = getCoordinates(event);
        if (!pos) return;

        // Selection Drag Check / Click Select
        if (event.pointerType !== 'touch' && (tool === 'select' || (selectedIds.size > 0 && tool?.includes('select')))) {
            // ... Hit Test Logic ...
            // Simplified for brevity, assume we use a shared HitTest function ideally.
            // Copied logic:
            const hitId = [...objects].reverse().find(obj => {
                if (obj.type === 'stroke' || obj.type === 'measure') {
                    const xs = obj.points.map(p => p.x);
                    const ys = obj.points.map(p => p.y);
                    const minX = Math.min(...xs) - 10;
                    const maxX = Math.max(...xs) + 10;
                    const minY = Math.min(...ys) - 10;
                    const maxY = Math.max(...ys) + 10;
                    return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
                } else if (obj.type === 'text') {
                    const textLen = obj.text.length * obj.fontSize * 0.6;
                    return pos.x >= obj.x && pos.x <= obj.x + textLen && pos.y >= obj.y && pos.y <= obj.y + obj.fontSize * 1.2;
                }
                return false;
            })?.id;

            if (hitId) {
                // If clicking an unselected item, select it (exclusive unless Shift?)
                if (!selectedIds.has(hitId)) {
                    // If not holding shift/ctrl, clear others? For now simple logic.
                    setSelectedIds(new Set([hitId]));
                    onSelectionChange?.([hitId]);
                }

                setIsDrawing(true);
                setIsDragging(true);
                setDragStart(pos);
                setInitialDragObjects(objects);
                return;
            } else if (tool === 'select') {
                // Clicked empty space with select tool -> deselect
                setSelectedIds(new Set());
                onSelectionChange?.([]);
                return;
            }
        }

        setIsDrawing(true);
        // Only reset currentPointsRef if we are starting a fresh stroke-like action
        // For Poly, we append.
        if (tool === 'measure-poly' || tool === 'measure-area') {
            if (currentPointsRef.current.length === 0) {
                currentPointsRef.current = [pos];
            }
            // For drag rubberband, we used selectionRect in previous attempt.
        } else {
            currentPointsRef.current = [pos];
        }

        const isEraserTip = event.buttons === 32 || (event.button === 5) || (event.buttons & 32);
        let effectiveTool = tool;
        if (isEraserTip && (tool === 'pen' || tool === 'eraser')) {
            effectiveTool = 'stroke-eraser';
            // Force override tool for this session?
            // No, effectiveTool is local.
        }

        // Latch the tool for the duration of this stroke
        activeOperationTool.current = effectiveTool || 'pen';

        // Init Overlays
        if (effectiveTool === 'rect-eraser' || effectiveTool === 'select-rect') {
            setSelectionRect({ start: pos, end: pos });
        } else if (effectiveTool === 'lasso-eraser' || effectiveTool === 'select-lasso') {
            setLassoPath([pos]);
        } else if (effectiveTool === 'text') {
            setTextInput({ x: pos.x, y: pos.y, text: '' });
            setIsDrawing(false);
        } else if (effectiveTool === 'measure-line' || effectiveTool === 'calibrate') {
            // Line rubberband
            setSelectionRect({ start: pos, end: pos });
        } else if (effectiveTool === 'measure-poly' || effectiveTool === 'measure-area') {
            // "Click to add point" logic
            // Add CURRENT position to points
            currentPointsRef.current.push(pos);
            // Rubberband starts from this new point
            setSelectionRect({ start: pos, end: pos });
        }
    };

    const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (event.pointerType === 'touch') {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (pointers.current.size === 2 && onZoom) {
            // ... Pinch Logic ...
            const points = Array.from(pointers.current.values());
            const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            if (prevPinchDiff.current) {
                const deltaDist = dist - prevPinchDiff.current;
                if (Math.abs(deltaDist) > 5) {
                    onZoom(deltaDist > 0 ? 0.05 : -0.05);
                    prevPinchDiff.current = dist;
                }
            } else {
                prevPinchDiff.current = dist;
            }
            return;
        }

        if (isScrolling.current && scrollStart.current) {
            const canvas = canvasRef.current;
            const container = canvas?.closest('.pdf-scroll-container') as HTMLElement;
            if (container) {
                const dx = event.clientX - scrollStart.current.x;
                const dy = event.clientY - scrollStart.current.y;
                container.scrollTop = scrollStart.current.scrollTop - dy;
                container.scrollLeft = scrollStart.current.scrollLeft - dx;
                if (tapStart.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
                    tapStart.current = null;
                }
            }
            return;
        }

        if (!isDrawing) return;
        const pos = getCoordinates(event);
        if (!pos) return;

        // Dragging
        if (isDragging && dragStart && initialDragObjects) {
            const dx = pos.x - dragStart.x;
            const dy = pos.y - dragStart.y;
            const nextObjects = initialDragObjects.map(obj => {
                if (selectedIds.has(obj.id)) {
                    if (obj.type === 'stroke' || obj.type === 'measure') {
                        return { ...obj, points: obj.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) };
                    } else if (obj.type === 'text') {
                        return { ...obj, x: obj.x + dx, y: obj.y + dy };
                    }
                }
                return obj;
            });
            setObjects(nextObjects);
            return;
        }

        const effectiveTool = activeOperationTool.current || tool;

        // Freehand Draw
        if (effectiveTool === 'pen' || effectiveTool === 'eraser') {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (!ctx) return;

            const nativeEvent = event.nativeEvent as PointerEvent;
            const events = (nativeEvent.getCoalescedEvents && nativeEvent.getCoalescedEvents()) || [nativeEvent];

            events.forEach(e => {
                const rect = canvas!.getBoundingClientRect();
                const p = {
                    x: (e.clientX - rect.left) / scale,
                    y: (e.clientY - rect.top) / scale,
                    pressure: e.pressure
                };
                currentPointsRef.current.push(p);

                const prevP = currentPointsRef.current[currentPointsRef.current.length - 2] || p;
                ctx.save();
                ctx.setTransform(scale, 0, 0, scale, 0, 0);
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                if (effectiveTool === 'eraser') {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.strokeStyle = 'rgba(0,0,0,1)';
                } else {
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.strokeStyle = color || '#000';
                }

                if (enablePressure && effectiveTool === 'pen') {
                    ctx.lineWidth = (lineWidth || 2) * (p.pressure || 0.5) * 2;
                } else {
                    ctx.lineWidth = lineWidth || 2;
                }
                ctx.beginPath();
                ctx.moveTo(prevP.x, prevP.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                ctx.restore();
            });
            return;
        }

        // Overlay Updates
        if (effectiveTool === 'rect-eraser' || effectiveTool === 'select-rect' || effectiveTool === 'measure-line' || effectiveTool === 'calibrate') {
            setSelectionRect(prev => prev ? { ...prev, end: pos } : null);
        } else if (effectiveTool === 'lasso-eraser' || effectiveTool === 'select-lasso') {
            setLassoPath(prev => prev ? [...prev, pos] : [pos]);
        } else if (effectiveTool === 'measure-poly' || effectiveTool === 'measure-area') {
            // Rubberband from last ADDED point to current mouse pos
            if (currentPointsRef.current.length > 0) {
                const lastFixed = currentPointsRef.current[currentPointsRef.current.length - 1];
                setSelectionRect({ start: lastFixed, end: pos });
            }
        } else if (effectiveTool === 'stroke-eraser') {
            // For stroke eraser, we track path to delete intersecting
            currentPointsRef.current.push(pos);
            // Visual feedback? maybe red trail.
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (ctx) {
                const prevP = currentPointsRef.current[currentPointsRef.current.length - 2] || pos;
                ctx.save();
                ctx.setTransform(scale, 0, 0, scale, 0, 0);
                ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(prevP.x, prevP.y);
                ctx.lineTo(pos.x, pos.y);
                ctx.stroke();
                ctx.restore();
            }
        }
    };

    const stopDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (event.pointerType === 'touch') {
            pointers.current.delete(event.pointerId);
            if (pointers.current.size < 2) prevPinchDiff.current = null;
        }

        // Tap Logic
        if (isScrolling.current) {
            if (tapStart.current) {
                const diff = Date.now() - tapStart.current.time;
                if (diff < 300) {
                    const pos = tapStart.current.pos;
                    const hitId = [...objects].reverse().find(obj => {
                        // Hit test logic repeated
                        if (obj.type === 'stroke' || obj.type === 'measure') {
                            const xs = obj.points.map(p => p.x);
                            const ys = obj.points.map(p => p.y);
                            const minX = Math.min(...xs) - 10;
                            const maxX = Math.max(...xs) + 10;
                            const minY = Math.min(...ys) - 10;
                            const maxY = Math.max(...ys) + 10;
                            return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
                        } else if (obj.type === 'text') {
                            return pos.x >= obj.x && pos.x <= obj.x + 50 && pos.y >= obj.y && pos.y <= obj.y + 20;
                        }
                        return false;
                    })?.id;

                    if (hitId) {
                        setSelectedIds(new Set([hitId]));
                        onSelectionChange?.([hitId]);
                    } else {
                        setSelectedIds(new Set());
                        onSelectionChange?.([]);
                    }
                }
                tapStart.current = null;
            }
            isScrolling.current = false;
            scrollStart.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            return;
        }

        if (!isDrawing) return;

        if (isDragging) {
            setIsDragging(false);
            setDragStart(null);
            setInitialDragObjects(null);
            setIsDrawing(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
            return;
        }


        const effectiveTool = activeOperationTool.current || tool; // Use latched tool

        // Finalize Pen/Eraser
        if ((effectiveTool === 'pen' || effectiveTool === 'eraser') && currentPointsRef.current.length > 0) {
            const newStroke: StrokeObject = {
                id: Date.now().toString(),
                type: 'stroke',
                points: currentPointsRef.current,
                color: effectiveTool === 'eraser' ? '#ffffff' : (color || '#000'),
                lineWidth: lineWidth || 2,
                opacity: opacity || 1,
                enablePressure: effectiveTool === 'pen' ? enablePressure : false,
                isEraser: effectiveTool === 'eraser'
            };
            setObjects(prev => [...prev, newStroke]);
            currentPointsRef.current = [];
        }

        // --- Stroke Eraser (Whole Delete) ---
        else if (effectiveTool === 'stroke-eraser' && currentPointsRef.current.length > 0) {
            const eraserPath = currentPointsRef.current;
            const ex = eraserPath.map(p => p.x); const ey = eraserPath.map(p => p.y);
            const eMinX = Math.min(...ex), eMaxX = Math.max(...ex);
            const eMinY = Math.min(...ey), eMaxY = Math.max(...ey);

            const newObjects = objects.filter(o => {
                if (o.type !== 'stroke' && o.type !== 'measure') return true;
                const ox = o.points.map(p => p.x); const oy = o.points.map(p => p.y);
                const oMinX = Math.min(...ox), oMaxX = Math.max(...ox);
                const oMinY = Math.min(...oy), oMaxY = Math.max(...oy);
                if (oMaxX < eMinX || oMinX > eMaxX || oMaxY < eMinY || oMinY > eMaxY) return true; // Keep

                for (let ep of eraserPath) {
                    for (let op of o.points) {
                        if (Math.hypot(ep.x - op.x, ep.y - op.y) < 10) return false; // Delete if close
                    }
                }
                return true;
            });
            setObjects(newObjects);
            currentPointsRef.current = [];
        }

        // --- Rect Eraser (Partial) ---
        else if (effectiveTool === 'rect-eraser' && selectionRect) {
            const { start, end } = selectionRect;
            const minX = Math.min(start.x, end.x);
            const maxX = Math.max(start.x, end.x);
            const minY = Math.min(start.y, end.y);
            const maxY = Math.max(start.y, end.y);

            let newObjects: CanvasObject[] = [];

            objects.forEach(obj => {
                let shouldKeep = true;
                let isInside = false;

                // 1. Check Intersection / Containment based on Type
                if (obj.type === 'measure') {
                    // Measure Object (Poly, Area, Line)
                    isInside = obj.points.some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY);
                    if (isInside) {
                        shouldKeep = false; // Delete whole measure if touched
                    }
                } else if (obj.type === 'text') {
                    // Text Object
                    isInside = (obj.x >= minX && obj.x <= maxX && obj.y >= minY && obj.y <= maxY);
                    if (isInside) {
                        shouldKeep = false;
                    }
                } else if (obj.type === 'stroke') {
                    // Stroke Object -> Partial Erasure
                    // We handle this separately to split it
                    shouldKeep = false; // We will generate new strokes or drop it

                    let currentSegment: Point[] = [];
                    let segments: Point[][] = [];

                    for (let i = 0; i < obj.points.length; i++) {
                        const p = obj.points[i];
                        const pInside = p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;

                        if (pInside) {
                            if (currentSegment.length > 0) {
                                segments.push(currentSegment);
                                currentSegment = [];
                            }
                        } else {
                            currentSegment.push(p);
                        }
                    }
                    if (currentSegment.length > 0) segments.push(currentSegment);

                    if (segments.length === 0) {
                        // Fully erased, do nothing (shouldKeep=false)
                    } else if (segments.length === 1 && segments[0].length === obj.points.length) {
                        newObjects.push(obj); // No change
                    } else {
                        // Create new stroke objects for fragments
                        segments.forEach(seg => {
                            if (seg.length < 2) return;
                            // Explicit Cast/Construction to avoid TS issues with spread
                            const newStroke: StrokeObject = {
                                id: crypto.randomUUID(),
                                type: 'stroke',
                                points: seg,
                                color: obj.color,
                                lineWidth: obj.lineWidth,
                                opacity: obj.opacity,
                                enablePressure: obj.enablePressure,
                                isEraser: obj.isEraser
                            };
                            newObjects.push(newStroke);
                        });
                    }
                    return; // Continue forEach
                }

                if (shouldKeep) {
                    newObjects.push(obj);
                }
            });
            setObjects(newObjects);
            setSelectionRect(null);
        }

        // --- Rect Select ---
        else if (effectiveTool === 'select-rect' && selectionRect) {
            const { start, end } = selectionRect;
            const minX = Math.min(start.x, end.x);
            const maxX = Math.max(start.x, end.x);
            const minY = Math.min(start.y, end.y);
            const maxY = Math.max(start.y, end.y);

            const hitIds = new Set<string>();
            objects.forEach(obj => {
                if (obj.type === 'measure' || obj.type === 'stroke') {
                    if (obj.points.some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) {
                        hitIds.add(obj.id);
                    }
                } else if (obj.type === 'text') {
                    if (obj.x >= minX && obj.x <= maxX && obj.y >= minY && obj.y <= maxY) hitIds.add(obj.id);
                }
            });
            setSelectedIds(hitIds);
            onSelectionChange?.(Array.from(hitIds));
            setSelectionRect(null);
        }

        // --- Lasso Select & Eraser ---
        else if ((effectiveTool === 'select-lasso' || effectiveTool === 'lasso-eraser') && lassoPath) {
            const isPointInPoly = (p: Point, poly: Point[]) => {
                let inside = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                    const xi = poly[i].x, yi = poly[i].y;
                    const xj = poly[j].x, yj = poly[j].y;
                    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
                    if (intersect) inside = !inside;
                }
                return inside;
            };

            if (effectiveTool === 'select-lasso') {
                const hitIds = new Set<string>();
                objects.forEach(obj => {
                    if (obj.type === 'stroke' || obj.type === 'measure') {
                        if (obj.points.some(p => isPointInPoly(p, lassoPath))) hitIds.add(obj.id);
                    } else if (obj.type === 'text') {
                        if (isPointInPoly({ x: obj.x, y: obj.y }, lassoPath)) hitIds.add(obj.id);
                    }
                });
                setSelectedIds(hitIds);
                onSelectionChange?.(Array.from(hitIds));
            } else {
                // Lasso Eraser -> Whole Delete
                const newObjects = objects.filter(o => {
                    if (o.type === 'stroke' || o.type === 'measure') {
                        return !o.points.some(p => isPointInPoly(p, lassoPath));
                    } else if (o.type === 'text') {
                        return !isPointInPoly({ x: o.x, y: o.y }, lassoPath);
                    }
                    return true;
                });
                setObjects(newObjects);
            }
            setLassoPath(null);
        }

        // Finalize Calibrate / Line
        else if (effectiveTool === 'calibrate' && selectionRect) {
            onCalibrationEnd?.(selectionRect.start, selectionRect.end);
            setSelectionRect(null);
            currentPointsRef.current = [];
        } else if (effectiveTool === 'measure-line' && selectionRect) {
            const newLine: MeasureObject = {
                id: Date.now().toString(),
                type: 'measure',
                subtype: 'line',
                points: [selectionRect.start, selectionRect.end],
                color: 'blue',
                scale: measurementScale || { value: 1, unit: 'm' },
                opacity: 1
            };
            setObjects(prev => [...prev, newLine]);
            setSelectionRect(null);
            currentPointsRef.current = [];
        }

        // Poly/Area Click Logic
        // Poly/Area Click Logic
        else if (effectiveTool === 'measure-poly' || effectiveTool === 'measure-area') {
            // Do NOT add point on UP. We added on DOWN.
            // Just ensure selectionRect tracks for next move
            if (currentPointsRef.current.length > 0) {
                const lastP = currentPointsRef.current[currentPointsRef.current.length - 1];
                setSelectionRect({ start: lastP, end: lastP }); // Reset rubberband to zero len until move
            }
        }

        // Rect/Lasso Select/Eraser Finalization
        // ... (Simplified: assume implemented logic from before)
        if (effectiveTool === 'rect-eraser' && selectionRect) {
            // splitStrokes...
        }

        if (effectiveTool !== 'measure-poly' && effectiveTool !== 'measure-area') {
            setIsDrawing(false);
            activeOperationTool.current = null; // Reset tool
        }
        event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const commitText = () => {
        if (textInput && textInput.text.trim()) {
            const newText: TextObject = {
                id: Date.now().toString(),
                type: 'text',
                x: textInput.x,
                y: textInput.y,
                text: textInput.text,
                fontSize: fontSize || 16,
                fontFamily: fontFamily || 'Arial',
                color: color || '#000',
                opacity: opacity || 1
            };
            setObjects(prev => [...prev, newText]);
        }
        setTextInput(null);
    };

    // Helper to close poly
    const finishPoly = () => {
        if (currentPointsRef.current.length < 2) {
            currentPointsRef.current = [];
            setSelectionRect(null);
            return;
        }

        const newPoly: MeasureObject = {
            id: Date.now().toString(),
            type: 'measure',
            subtype: tool === 'measure-area' ? 'area' : 'poly',
            points: [...currentPointsRef.current],
            color: '#0000ff', // Hex for alpha compatibility
            scale: measurementScale || { value: 1, unit: 'm' },
            opacity: 1
        };
        setObjects(prev => [...prev, newPoly]);
        currentPointsRef.current = [];
        setSelectionRect(null);
    };

    // Expose finishPoly? Or auto-finish on tool change?
    useEffect(() => {
        // When tool changes, if we have pending poly, finish it? or discard?
        // Discard for safety or finish if valid.
        // Let's discard to avoid accidental commits.
        currentPointsRef.current = [];
        setSelectionRect(null);
    }, [tool]);

    // Key Handler for Delete
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
                // Ignore if typing in text area
                if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT') return;

                deleteSelectionInternal();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedIds]); // Re-bind when selection changes to ensure closure has latest state? 
    // Actually ref.current function uses state setter, so it should be fine. 
    // BUT selectedIds dependency is safe for the check inside.

    return (
        <>
            <canvas
                ref={canvasRef}
                style={{
                    position: 'absolute', top: 0, left: 0,
                    pointerEvents: pointerEvents,
                    touchAction: 'none',
                    zIndex: 10,
                    cursor: tool === 'select' ? 'default' : 'crosshair'
                }}
                onPointerDown={startDrawing}
                onPointerMove={draw}
                onPointerUp={stopDrawing}
                onPointerLeave={stopDrawing}
                onPointerCancel={stopDrawing}
                onDoubleClick={finishPoly}
            />
            {textInput && (
                <textarea
                    autoFocus
                    placeholder="Type here..."
                    style={{
                        position: 'absolute',
                        left: textInput.x,
                        top: textInput.y,
                        fontSize: `${fontSize}px`,
                        fontFamily: fontFamily,
                        color: color,
                        background: 'rgba(255,255,255,0.8)',
                        border: '1px dashed #333',
                        minWidth: '50px',
                        zIndex: 30
                    }}
                    value={textInput.text}
                    onChange={e => setTextInput({ ...textInput, text: e.target.value })}
                    onBlur={commitText}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } }}
                />
            )}

            {/* Overlays */}
            {(tool === 'rect-eraser' || tool === 'select-rect' || tool === 'measure-line' || tool === 'calibrate' || tool === 'measure-poly' || tool === 'measure-area') && selectionRect && (
                <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
                    {(tool === 'measure-poly' || tool === 'measure-area') && currentPointsRef.current.length > 0 && (
                        <polyline
                            points={currentPointsRef.current.map(p => `${p.x * scale},${p.y * scale}`).join(' ')}
                            fill={tool === 'measure-area' ? 'rgba(0,0,255,0.1)' : 'none'}
                            stroke="blue"
                            strokeWidth="2"
                        />
                    )}
                    {(tool === 'measure-poly' || tool === 'measure-area') && currentPointsRef.current.map((p, i) => (
                        <circle key={i} cx={p.x * scale} cy={p.y * scale} r="3" fill="blue" />
                    ))}

                    {(tool === 'rect-eraser' || tool === 'select-rect') ? (
                        <rect
                            x={Math.min(selectionRect.start.x, selectionRect.end.x) * scale}
                            y={Math.min(selectionRect.start.y, selectionRect.end.y) * scale}
                            width={Math.abs(selectionRect.end.x - selectionRect.start.x) * scale}
                            height={Math.abs(selectionRect.end.y - selectionRect.start.y) * scale}
                            fill={tool === 'rect-eraser' ? 'rgba(255,0,0,0.1)' : 'rgba(0,0,255,0.1)'}
                            stroke={tool === 'rect-eraser' ? 'red' : 'blue'}
                            strokeWidth="1"
                            strokeDasharray="4"
                        />
                    ) : (
                        <line
                            x1={selectionRect.start.x * scale} y1={selectionRect.start.y * scale}
                            x2={selectionRect.end.x * scale} y2={selectionRect.end.y * scale}
                            stroke={tool.includes('measure') || tool === 'calibrate' ? 'blue' : (tool.includes('select') ? 'blue' : 'red')}
                            strokeWidth="2"
                            strokeDasharray="4"
                        />
                    )}
                </svg>
            )}
            {(tool === 'lasso-eraser' || tool === 'select-lasso') && lassoPath && (
                <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}>
                    <polygon
                        points={lassoPath.map(p => `${p.x * scale},${p.y * scale}`).join(' ')}
                        fill="rgba(0,0,255,0.1)"
                        stroke="blue"
                        strokeWidth="2"
                        strokeDasharray="4"
                    />
                </svg>
            )}

            {/* Poly Finish Button (Floating near last point?) - Optional UI improvement */}
        </>
    );
};

export const DrawingCanvas = forwardRef(DrawingCanvasComponent);
