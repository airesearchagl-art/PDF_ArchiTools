import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
    DrawingCanvas, type ToolType, type DrawingCanvasRef,
    type CanvasObject, type PendingInteraction,
} from './DrawingCanvas';
import { type Layer } from './PdfViewer';

/** One visible layer's committed objects, bottom layer first. */
export interface LayerObjects {
    layerId: string;
    objects: CanvasObject[];
}

export interface PdfPageRef {
    duplicateSelection: () => void;
    deleteSelection: () => void;
    /**
     * A deep copy of every visible layer's objects, bottom layer first.
     *
     * Hidden layers are excluded rather than filtered downstream: they are
     * `display: none` on screen and must not appear in the file.
     */
    getVisibleLayerSnapshots: () => LayerObjects[];
    /** An unfinished interaction on any visible layer, or null. */
    getPendingInteraction: () => PendingInteraction | null;
}

interface PdfPageProps {
    pdfDoc: pdfjsLib.PDFDocumentProxy;
    pageNumber: number;
    scale: number;
    layers: Layer[];
    activeLayerId: string;
    tool: ToolType;
    color: string;
    lineWidth: number;
    opacity: number;
    enablePressure?: boolean;
    fontSize?: number;
    fontFamily?: string;
    onZoom?: (delta: number) => void;
    // Measurement Props
    measurementScale: any;
    onCalibrationEnd: (start: { x: number, y: number }, end: { x: number, y: number }) => void;
}

export const PdfPage = React.forwardRef<PdfPageRef, PdfPageProps>(({
    pdfDoc,
    pageNumber,
    scale,
    layers,
    activeLayerId,
    tool,
    color,
    lineWidth,
    opacity,
    enablePressure = false,
    fontSize,
    fontFamily,
    onZoom,
    measurementScale,
    onCalibrationEnd
}, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // State
    const [pageProxy, setPageProxy] = useState<any>(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

    // Refs for Debouncing
    const renderTaskRef = useRef<any>(null);
    const renderTimeoutRef = useRef<number | null>(null);

    // 1. Initial Load of Page Proxy
    useEffect(() => {
        if (!pdfDoc) return;
        let active = true;
        const loadPage = async () => {
            try {
                const page = await pdfDoc.getPage(pageNumber);
                if (active) setPageProxy(page);
            } catch (err) {
                console.error(`Error loading page ${pageNumber}:`, err);
            }
        };
        loadPage();
        return () => { active = false; };
    }, [pdfDoc, pageNumber]);

    // 2. Handle Scale Changes (Debounced Rendering)
    useEffect(() => {
        if (!pageProxy || !canvasRef.current) return;

        // Immediate: Calculate dimensions for layout and smooth CSS scaling
        const viewport = pageProxy.getViewport({ scale });
        setDimensions({ width: viewport.width, height: viewport.height });

        // Cancel previous render/timer
        if (renderTimeoutRef.current) {
            window.clearTimeout(renderTimeoutRef.current);
        }
        if (renderTaskRef.current) {
            renderTaskRef.current.cancel();
            renderTaskRef.current = null;
        }

        // Debounce expensive render
        renderTimeoutRef.current = window.setTimeout(async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            // Update resolution (clears canvas content)
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const renderContext = {
                canvasContext: ctx,
                viewport: viewport,
            };

            try {
                const task = pageProxy.render(renderContext);
                renderTaskRef.current = task;
                await task.promise;
            } catch (error: any) {
                if (error.name !== 'RenderingCancelledException') {
                    console.error('Render error:', error);
                }
            }
        }, 150); // 150ms delay for performance

        return () => {
            if (renderTimeoutRef.current) window.clearTimeout(renderTimeoutRef.current);
            // We usually don't cancel the task on unmount to avoid errors, 
            // but if we do, we should catch cancellation exception.
        };
    }, [pageProxy, scale]);

    // One handle per layer, not one shared between them.
    //
    // Every layer's DrawingCanvas used to be given the same forwarded ref, so
    // with three layers all three wrote to one slot and only the last-rendered
    // one survived. That was invisible while the ref was only used for
    // duplicate and delete on the active layer; it is not survivable for a save,
    // which has to read every visible layer.
    const layerRefs = useRef<Map<string, DrawingCanvasRef>>(new Map());
    const setLayerRef = (layerId: string) => (handle: DrawingCanvasRef | null) => {
        if (handle) layerRefs.current.set(layerId, handle);
        else layerRefs.current.delete(layerId);
    };

    // A deleted layer's handle would otherwise linger and be saved.
    useEffect(() => {
        const live = new Set(layers.map((l) => l.id));
        for (const id of [...layerRefs.current.keys()]) {
            if (!live.has(id)) layerRefs.current.delete(id);
        }
    }, [layers]);

    const visibleLayers = () => layers.filter((l) => l.visible);

    useImperativeHandle(ref, () => ({
        // Selection actions stay on the active layer only, so an action taken
        // on one layer cannot reach into another.
        duplicateSelection: () => layerRefs.current.get(activeLayerId)?.duplicateSelection(),
        deleteSelection: () => layerRefs.current.get(activeLayerId)?.deleteSelection(),
        getVisibleLayerSnapshots: () => visibleLayers()
            .map((layer) => ({
                layerId: layer.id,
                objects: layerRefs.current.get(layer.id)?.getSaveSnapshot() ?? [],
            }))
            .filter((entry) => entry.objects.length > 0),
        getPendingInteraction: () => {
            for (const layer of visibleLayers()) {
                const pending = layerRefs.current.get(layer.id)?.getPendingInteraction();
                if (pending) return pending;
            }
            return null;
        },
    }));

    return (
        <div
            className="pdf-page-container"
            ref={containerRef}
            style={{
                position: 'relative',
                margin: '10px 0',
                boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
                width: dimensions.width,
                height: dimensions.height
            }}
        >
            <canvas
                ref={canvasRef}
                className="pdf-canvas"
                style={{
                    display: 'block',
                    width: '100%',
                    height: '100%'
                }}
            />
            {layers.map(layer => (
                <div key={layer.id} style={{ display: layer.visible ? 'block' : 'none' }}>
                    <DrawingCanvas
                        ref={setLayerRef(layer.id)}
                        width={dimensions.width}
                        height={dimensions.height}
                        scale={scale}
                        tool={tool}
                        color={color}
                        lineWidth={lineWidth}
                        opacity={opacity}
                        pointerEvents={activeLayerId === layer.id ? 'auto' : 'none'}
                        enablePressure={enablePressure}
                        fontSize={fontSize}
                        fontFamily={fontFamily}
                        onZoom={onZoom}
                        measurementScale={measurementScale}
                        onCalibrationEnd={onCalibrationEnd}
                    />
                </div>
            ))}
            {/* Page Number Indicator */}
            <div style={{
                position: 'absolute',
                bottom: '10px',
                right: '10px',
                background: 'rgba(0,0,0,0.5)',
                color: 'white',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '12px',
                pointerEvents: 'none'
            }}>
                {pageNumber}
            </div>
        </div>
    );
});
