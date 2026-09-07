import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Upload, ZoomIn, ZoomOut, Download, PenTool, Eraser, Layers, Plus, Eye, EyeOff, Trash2, Trash, Copy, Maximize, Ruler, Hexagon, Square, Target, MousePointer2 } from 'lucide-react';
import { PdfPage } from './PdfPage';
import type { ToolType, MeasurementScale } from './DrawingCanvas';
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';
import { configurePdfWorker } from '../utils/pdf-worker-source';
import {
    saveAnnotatedPdf, annotatedFilename, AnnotatorSaveError,
    type PageSnapshot, type SaveResult,
} from '../utils/annotator-save';
import type { PdfPageRef } from './PdfPage';

import './PdfViewer.css';

interface PdfViewerProps {
    onLoad?: (pdf: pdfjsLib.PDFDocumentProxy) => void;
}

export interface Layer {
    id: string;
    visible: boolean;
}

export const PdfViewer: React.FC<PdfViewerProps> = ({ onLoad }) => {
    const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    // const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1.0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [saveNotice, setSaveNotice] = useState<string[] | null>(null);

    /**
     * The uploaded file, kept as the master copy.
     *
     * Saving writes the annotations onto the original document, so the original
     * bytes have to survive the upload. PDF.js may transfer the buffer it is
     * handed, which detaches it — so the copy kept here and the copy given to
     * PDF.js are separate slices of the same read, and neither can affect the
     * other.
     */
    const sourceBytesRef = useRef<Uint8Array | null>(null);
    const sourceNameRef = useRef<string>('document.pdf');

    // Drawing state
    const [tool, setTool] = useState<ToolType>('pen');
    const [color, setColor] = useState('#000000');
    const [lineWidth, setLineWidth] = useState(2);
    const [opacity, setOpacity] = useState(1.0);
    const [enablePressure, setEnablePressure] = useState(false);

    // Text State
    const [fontSize, setFontSize] = useState(16);
    const [fontFamily, setFontFamily] = useState('Arial');

    // Measurement State
    const [measurementScale, setMeasurementScale] = useState<MeasurementScale>({ value: 1, unit: 'px' });

    const handleCalibrationEnd = (start: { x: number, y: number }, end: { x: number, y: number }) => {
        const pixelDistance = Math.hypot(end.x - start.x, end.y - start.y);
        const input = window.prompt(`Measured path is ${pixelDistance.toFixed(2)}px.\nEnter known straight-line distance (e.g., "5 m" or "100 cm"):`);
        if (!input) return;

        // Parse input
        const match = input.match(/^([\d.]+)\s*(mm|cm|m|km|in|ft|px)?$/i);
        if (!match) {
            alert("Invalid format. Usage: '10.5 m'");
            return;
        }

        const val = parseFloat(match[1]);
        const unit = (match[2] || 'px').toLowerCase() as any;

        if (val <= 0) return;

        const scaleValue = val / pixelDistance;
        setMeasurementScale({ value: scaleValue, unit });
        setTool('pen');
    };

    const SCALE_PRESETS = [
        { label: '1:1 (72dpi)', value: 0.3527, unit: 'mm' }, // 1px = 1pt = 0.3527mm
        { label: '1:10', value: 3.527, unit: 'mm' },
        { label: '1:20', value: 7.054, unit: 'mm' },
        { label: '1:50', value: 17.635, unit: 'mm' },
        { label: '1:100', value: 35.27, unit: 'mm' },
        { label: '1:200', value: 70.54, unit: 'mm' },
        { label: '1:300', value: 105.81, unit: 'mm' },
        { label: '1:400', value: 141.08, unit: 'mm' },
        { label: '1:500', value: 176.35, unit: 'mm' },
        { label: '1:600', value: 211.62, unit: 'mm' },
        { label: '1:1000', value: 352.7, unit: 'mm' },
    ];

    const applyPresetScale = (presetValue: number, unit: any) => {
        setMeasurementScale({ value: presetValue, unit: unit });
    };

    const UNIT_FACTORS: { [key: string]: number } = {
        'mm': 0.001,
        'cm': 0.01,
        'm': 1.0,
        'km': 1000.0,
        'in': 0.0254,
        'ft': 0.3048,
    };

    const changeUnit = (newUnit: string) => {
        const currentUnit = measurementScale.unit;
        if (currentUnit === 'px' || newUnit === 'px') {
            setMeasurementScale({ ...measurementScale, unit: newUnit as any });
            return;
        }

        const currentFactor = UNIT_FACTORS[currentUnit];
        const newFactor = UNIT_FACTORS[newUnit];

        if (currentFactor && newFactor) {
            // value is Units Per Pixel.
            // 1 px = V old. V * F_old = Meters.
            // New V' * F_new = Meters.
            // V' = (V * F_old) / F_new
            const newValue = (measurementScale.value * currentFactor) / newFactor;
            setMeasurementScale({ value: newValue, unit: newUnit as any });
        } else {
            setMeasurementScale({ ...measurementScale, unit: newUnit as any });
        }
    };

    // Refs for pages
    const pageRefs = useRef<{ [key: number]: PdfPageRef | null }>({});

    const duplicateSelection = () => {
        Object.values(pageRefs.current).forEach(ref => ref?.duplicateSelection?.());
    };

    const deleteSelection = () => {
        Object.values(pageRefs.current).forEach(ref => ref?.deleteSelection?.());
    };
    // Remove canvasDimensions, as it's now per page in PdfPage

    // Layer state
    const [layers, setLayers] = useState<Layer[]>([{ id: 'layer-1', visible: true }]);
    const [activeLayerId, setActiveLayerId] = useState<string>('layer-1');
    const [showLayerMenu, setShowLayerMenu] = useState(false);



    const addLayer = () => {
        const newId = `layer-${Date.now()}`;
        setLayers(prev => [...prev, { id: newId, visible: true }]);
        setActiveLayerId(newId);
    };

    const toggleLayerVisibility = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setLayers(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
    };

    const deleteLayer = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (layers.length <= 1) return;
        setLayers(prev => prev.filter(l => l.id !== id));
        if (activeLayerId === id) {
            // Activate the last remaining layer
            setActiveLayerId(layers.find(l => l.id !== id)?.id || layers[0].id);
        }
    };

    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (file.type !== 'application/pdf') {
            setError('Please upload a valid PDF file.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const arrayBuffer = await file.arrayBuffer();
            // One read, two independent copies. PDF.js is given its own, so
            // whatever it does to that buffer cannot reach the copy a save
            // depends on.
            const bytes = new Uint8Array(arrayBuffer);
            sourceBytesRef.current = bytes.slice();
            sourceNameRef.current = file.name || 'document.pdf';
            const forDisplay = bytes.slice();
            // Right here, not at module scope: `GlobalWorkerOptions.workerSrc`
            // is one global, and two other modules still assign it to a CDN when
            // they load. In a bundle the last one to evaluate wins, so setting
            // it at import time would leave which worker we fetch depending on
            // import order. Setting it immediately before the only call that
            // reads it makes that irrelevant.
            configurePdfWorker();
            const loadedPdf = await pdfjsLib.getDocument({ data: forDisplay }).promise;
            setPdfDoc(loadedPdf);
            setSaveNotice(null);
            pageRefs.current = {};
            if (onLoad) onLoad(loadedPdf);
        } catch (err) {
            console.error('Error loading PDF:', err);
            setError('Failed to load PDF.');
        } finally {
            setLoading(false);
        }
    };

    // Removed renderPage(), changePage()

    useEffect(() => {
        // renderPage(); // This useEffect is no longer needed as PdfPage handles rendering
    }, [pdfDoc, scale]); // Keep for now, but will be removed once PdfPage is fully integrated

    const changeScale = (delta: number) => {
        setScale(prev => Math.max(0.5, Math.min(6.0, prev + delta)));
    };

    /**
     * What the user is told when a save refuses.
     *
     * A generic "failed to export" tells them nothing about whether to retry,
     * finish an operation, or pick a different file, so each cause gets its own
     * sentence. The raw exception goes to the console, never to an alert.
     */
    const describeSaveFailure = (error: unknown): string => {
        if (error instanceof AnnotatorSaveError) {
            const lines = error.problems.map((p) => (
                p.page ? `・${p.message}（${p.page}ページ）` : `・${p.message}`
            ));
            return lines.join('\n');
        }
        return 'PDFを保存できませんでした。もう一度お試しください。';
    };

    /** What the user is told when a save succeeds but cost something. */
    const describeSaveWarnings = (result: SaveResult): string[] => {
        const notices: string[] = [];
        if (result.fontSubstituted) {
            notices.push('文字注釈は検索可能な状態を保つため、互換フォントへ置換して保存しました。');
        }
        if (result.rasteredTextObjects.length > 0) {
            const missing = [...new Set(result.rasteredTextObjects.flatMap((r) => r.missing))];
            notices.push(
                `${result.rasteredTextObjects.length}件の文字注釈は、使用フォントで表現できない文字`
                + `（${missing.join(' ')}）を含むため画像として保存しました。`
                + 'この注釈はPDFの文字検索の対象になりません。',
            );
        }
        return notices;
    };

    const handleDownload = async () => {
        const sourceBytes = sourceBytesRef.current;
        if (!pdfDoc || !sourceBytes) return;
        // One save at a time. A second click while the first is in flight would
        // race two downloads and two sets of warnings.
        if (isSaving) return;

        setIsSaving(true);
        setSaveNotice(null);
        let objectUrl: string | null = null;
        try {
            // An unfinished operation is refused rather than skipped. Live pen
            // ink and typed text are not in the object model until they are
            // committed, so saving through them would return a finished-looking
            // file with the mark missing.
            const pages: PageSnapshot[] = [];
            for (const [key, handle] of Object.entries(pageRefs.current)) {
                if (!handle) continue;
                const pending = handle.getPendingInteraction();
                if (pending) {
                    throw new AnnotatorSaveError([{
                        code: 'pending-annotation',
                        page: Number(key),
                        message: `${pending.message}操作を完了してから保存してください。`,
                    }]);
                }
                const layers = handle.getVisibleLayerSnapshots();
                if (layers.length > 0) {
                    pages.push({ pageNumber: Number(key), layers });
                }
            }

            const result = await saveAnnotatedPdf({ sourceBytes, pages });

            // Only now that every page is written does anything download.
            const blob = new Blob([result.bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
            objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = annotatedFilename(sourceNameRef.current);
            document.body.appendChild(link);
            link.click();
            link.remove();

            setSaveNotice(describeSaveWarnings(result));
        } catch (err) {
            console.error('Annotated save failed:', err);
            setSaveNotice([describeSaveFailure(err)]);
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            setIsSaving(false);
        }
    };

    const COLORS = [
        { name: 'Black', value: '#000000' },
        { name: 'Red', value: '#FF0000' },
        { name: 'Blue', value: '#0000FF' },
        { name: 'Green', value: '#008000' },
        { name: 'Yellow', value: '#FFD700' },
        { name: 'Magenta', value: '#FF00FF' },
        { name: 'Cyan', value: '#00FFFF' },
        { name: 'Purple', value: '#800080' },
        { name: 'Dark Blue', value: '#00008B' },
        { name: 'Orange', value: '#FFA500' },
    ];



    return (
        <div className="pdf-viewer-container">
            {!pdfDoc && (
                <div className="upload-section">
                    <label className="upload-button">
                        <Upload size={24} />
                        <span>Upload PDF</span>
                        <input
                            type="file"
                            accept="application/pdf"
                            onChange={handleFileUpload}
                            onClick={(e) => (e.target as HTMLInputElement).value = ''}
                            style={{ display: 'none' }}
                        />
                    </label>
                    {error && <p className="error-message">{error}</p>}
                </div>
            )}

            {loading && <p>Loading PDF...</p>}

            {pdfDoc && (
                <>
                    <div className="viewer-controls">
                        {/* Zoom Controls */}
                        <div className="zoom-controls" data-usage-target="annotator-zoom" style={{ paddingLeft: 0, borderLeft: 'none' }}>
                            <button onClick={() => changeScale(-0.1)} title="Zoom Out">
                                <ZoomOut size={20} />
                            </button>

                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px', margin: '0 5px' }}>
                                <input
                                    type="range"
                                    min="0.5"
                                    max="6.0"
                                    step="0.1"
                                    value={scale}
                                    onChange={(e) => setScale(parseFloat(e.target.value))}
                                    style={{ width: '100%', cursor: 'pointer' }}
                                />
                                <span style={{ fontSize: '0.7em', color: '#666' }}>{Math.round(scale * 100)}%</span>
                            </div>

                            <button onClick={() => changeScale(0.1)} title="Zoom In">
                                <ZoomIn size={20} />
                            </button>
                            <button onClick={() => setScale(1.0)} title="Reset Scale">
                                <Maximize size={20} />
                            </button>
                        </div>

                        {/* Drawing Tools */}
                        <div className="drawing-controls" data-usage-target="annotator-draw">
                            <button
                                onClick={() => setTool('select')}
                                className={tool === 'select' ? 'active' : ''}
                                title="Select / Edit (Delete key to remove)"
                            >
                                <MousePointer2 size={20} />
                            </button>
                            <div style={{ width: '1px', height: '20px', background: '#e0e0e0', margin: '0 5px' }}></div>
                            <button
                                onClick={() => setTool('pen')}
                                className={tool === 'pen' ? 'active' : ''}
                                title="Pen"
                            >
                                <PenTool size={20} />
                            </button>
                            <button
                                onClick={() => setTool('eraser')}
                                className={tool === 'eraser' ? 'active' : ''}
                                title="Eraser (Pixel)"
                            >
                                <Eraser size={20} />
                            </button>
                            <button
                                onClick={() => setTool('stroke-eraser')}
                                className={tool === 'stroke-eraser' ? 'active' : ''}
                                title="Stroke Eraser"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 6L6 18" />
                                    <path d="M6 6l12 12" />
                                </svg>
                            </button>
                            <button
                                onClick={() => setTool('rect-eraser')}
                                className={tool === 'rect-eraser' ? 'active' : ''}
                                title="Rectangle Eraser"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                <div style={{ width: '16px', height: '16px', border: '2px dashed currentColor', borderRadius: '2px' }}></div>
                            </button>
                            <button
                                onClick={() => setTool('lasso-eraser')}
                                className={tool === 'lasso-eraser' ? 'active' : ''}
                                title="Lasso Eraser"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                <div style={{ width: '16px', height: '16px', border: '2px dotted currentColor', borderRadius: '50%' }}></div>
                            </button>

                            {/* Separator */}
                            <div style={{ width: '1px', height: '20px', background: '#e0e0e0', margin: '0 5px' }}></div>

                            {/* Text Tool */}
                            <button
                                onClick={() => setTool('text')}
                                className={tool === 'text' ? 'active' : ''}
                                title="Text Tool"
                            >
                                <div style={{ fontSize: '18px', fontWeight: 'bold' }}>T</div>
                            </button>

                            {/* Select Tools */}
                            <button
                                onClick={() => setTool('select-rect')}
                                className={tool === 'select-rect' ? 'active' : ''}
                                title="Select (Rect)"
                            >
                                <div style={{ width: '14px', height: '14px', border: '1px dashed currentColor', borderRadius: '2px' }}></div>
                            </button>
                            <button
                                onClick={() => setTool('select-lasso')}
                                className={tool === 'select-lasso' ? 'active' : ''}
                                title="Select (Lasso)"
                            >
                                <div style={{ width: '14px', height: '14px', border: '1px dotted currentColor', borderRadius: '50%' }}></div>
                            </button>

                            {/* Text Options */}
                            {tool === 'text' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <input
                                        type="number"
                                        value={fontSize}
                                        onChange={(e) => setFontSize(parseInt(e.target.value))}
                                        style={{ width: '50px' }}
                                        title="Font Size"
                                    />
                                    <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} style={{ width: '80px' }}>
                                        <option value="Arial">Arial</option>
                                        <option value="Times New Roman">Times</option>
                                        <option value="Courier New">Courier</option>
                                    </select>
                                </div>
                            )}
                        </div>

                        {/* Separator */}
                        <div style={{ width: '1px', height: '20px', background: '#e0e0e0', margin: '0 5px' }}></div>

                        {/* Measurement Tools */}
                        <button
                            data-usage-target="annotator-measure"
                            onClick={() => setTool('measure-line')}
                            className={tool === 'measure-line' ? 'active' : ''}
                            title="Measure Line"
                        >
                            <Ruler size={20} />
                        </button>
                        <button
                            data-usage-target="annotator-measure"
                            onClick={() => setTool('measure-poly')}
                            className={tool === 'measure-poly' ? 'active' : ''}
                            title="Measure Polyline"
                        >
                            <Hexagon size={20} />
                        </button>
                        <button
                            data-usage-target="annotator-measure"
                            onClick={() => setTool('measure-area')}
                            className={tool === 'measure-area' ? 'active' : ''}
                            title="Measure Area"
                        >
                            <Square size={20} />
                        </button>
                        <button
                            data-usage-target="annotator-measure"
                            onClick={() => setTool('calibrate')}
                            className={tool === 'calibrate' ? 'active' : ''}
                            title="Calibrate Scale"
                        >
                            <Target size={20} />
                        </button>
                        <div data-usage-target="annotator-scale" style={{ display: 'flex', flexDirection: 'column', marginLeft: '5px' }}>
                            <select
                                style={{ fontSize: '0.8em', padding: '2px', maxWidth: '100px' }}
                                onChange={(e) => {
                                    const idx = parseInt(e.target.value);
                                    if (!isNaN(idx)) {
                                        applyPresetScale(SCALE_PRESETS[idx].value, SCALE_PRESETS[idx].unit);
                                    }
                                }}
                                defaultValue=""
                            >
                                <option value="" disabled>Presets</option>
                                {SCALE_PRESETS.map((p, i) => (
                                    <option key={i} value={i}>{p.label}</option>
                                ))}
                            </select>
                            {measurementScale.unit !== 'px' && (
                                <div style={{ fontSize: '0.7em', color: '#666', marginTop: '2px' }}>
                                    1px = {measurementScale.value < 0.01 || measurementScale.value > 1000 ? measurementScale.value.toExponential(2) : measurementScale.value.toFixed(3)}
                                    <select
                                        value={measurementScale.unit}
                                        onChange={(e) => changeUnit(e.target.value)}
                                        style={{ marginLeft: '4px', fontSize: '1em', padding: '0', border: 'none', background: 'transparent', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        {Object.keys(UNIT_FACTORS).map(u => (
                                            <option key={u} value={u}>{u}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        {/* Separator */}
                        <div style={{ width: '1px', height: '20px', background: '#e0e0e0', margin: '0 5px' }}></div>

                        <div data-usage-target="annotator-select-actions" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <button onClick={duplicateSelection} title="Duplicate Selection" className="icon-btn small">
                                <Copy size={16} />
                            </button>
                            <button onClick={deleteSelection} title="Delete Selection" className="icon-btn small danger">
                                <Trash size={16} />
                            </button>
                        </div>

                        {/* Color Palette */}
                        <div className="color-palette" data-usage-target="annotator-color">
                            {COLORS.map((c) => (
                                <div
                                    key={c.name}
                                    className={`color-swatch ${color === c.value ? 'active' : ''}`}
                                    style={{ backgroundColor: c.value }}
                                    onClick={() => setColor(c.value)}
                                    title={c.name}
                                />
                            ))}
                        </div>

                        <input
                            type="color"
                            value={color}
                            onChange={(e) => setColor(e.target.value)}
                            title="Custom Color"
                            style={{ width: '32px', height: '32px', padding: 0, border: 'none', cursor: 'pointer', background: 'white', borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 1px #ddd' }}
                        />

                        {/* Width Slider & Pressure */}
                        <div data-usage-target="annotator-style" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginLeft: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ fontSize: '0.7rem', color: '#ccc', minWidth: '45px' }}>Size: {lineWidth}</span>
                                <input
                                    type="range"
                                    min="1"
                                    max="20"
                                    value={lineWidth}
                                    onChange={(e) => setLineWidth(parseInt(e.target.value))}
                                    style={{ width: '80px', accentColor: 'var(--primary-color)' }}
                                    title="Pen Width"
                                />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ fontSize: '0.7rem', color: '#ccc', minWidth: '45px' }}>Opacity: {Math.round(opacity * 100)}%</span>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="1.0"
                                    step="0.1"
                                    value={opacity}
                                    onChange={(e) => setOpacity(parseFloat(e.target.value))}
                                    style={{ width: '80px', accentColor: 'var(--primary-color)' }}
                                    title="Opacity"
                                />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.7rem', color: '#ccc', cursor: 'pointer', marginTop: '4px' }}>
                                <input
                                    type="checkbox"
                                    checked={enablePressure}
                                    onChange={(e) => setEnablePressure(e.target.checked)}
                                    style={{ accentColor: 'var(--primary-color)' }}
                                />
                                Pressure
                            </label>
                        </div>

                        <div className="layer-controls-dropdown" data-usage-target="annotator-layers" style={{ display: 'flex', alignItems: 'center', marginLeft: '0.5rem', gap: '0.5rem', borderLeft: '1px solid #ddd', paddingLeft: '0.5rem' }}>
                            <div className="layer-list-popover-trigger" title="Manage Layers" onClick={() => setShowLayerMenu(!showLayerMenu)}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'pointer', padding: '0.4rem', borderRadius: '4px', backgroundColor: showLayerMenu ? 'rgba(0,0,0,0.05)' : 'transparent' }}>
                                    <Layers size={20} />
                                    <span>Layers</span>
                                </div>
                                {showLayerMenu && (
                                    <div className="layer-list-popover" onClick={e => e.stopPropagation()}>
                                        <div className="layer-header">
                                            <span>Layers</span>
                                            <button onClick={addLayer} title="Add Layer" className="icon-btn small"><Plus size={16} /></button>
                                        </div>
                                        <div className="layer-list">
                                            {layers.map((layer, index) => (
                                                <div
                                                    key={layer.id}
                                                    className={`layer-item ${activeLayerId === layer.id ? 'active' : ''}`}
                                                    onClick={() => setActiveLayerId(layer.id)}
                                                >
                                                    <button className="icon-btn" onClick={(e) => toggleLayerVisibility(layer.id, e)}>
                                                        {layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                                                    </button>
                                                    <span className="layer-name">Layer {index + 1}</span>
                                                    <button
                                                        className="icon-btn danger"
                                                        onClick={(e) => deleteLayer(layer.id, e)}
                                                        disabled={layers.length === 1}
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <button onClick={handleDownload} disabled={isSaving} title="Download Annotated PDF" data-usage-target="annotator-save" style={{ marginLeft: 'auto' }}>
                            <Download size={20} />
                        </button>
                    </div>

                    <div className="pdf-scroll-container" onWheel={(e) => {
                        if (e.altKey) {
                            e.preventDefault();
                            const delta = e.deltaY > 0 ? -0.1 : 0.1;
                            changeScale(delta);
                        }
                    }}>
                        {Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1).map(pageNum => (
                            <div key={pageNum}>
                                <PdfPage
                                    pdfDoc={pdfDoc}
                                    pageNumber={pageNum}
                                    scale={scale}
                                    layers={layers}
                                    activeLayerId={activeLayerId}
                                    tool={tool}
                                    color={color}
                                    lineWidth={lineWidth}
                                    opacity={opacity}
                                    enablePressure={enablePressure}
                                    fontSize={fontSize}
                                    fontFamily={fontFamily}
                                    ref={(el) => { if (el) pageRefs.current[pageNum] = el; }}
                                    onZoom={(delta) => changeScale(delta)}
                                    measurementScale={measurementScale}
                                    onCalibrationEnd={handleCalibrationEnd}
                                />
                            </div>
                        ))}
                    </div>
                </>
            )}

            {isSaving && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'white', fontSize: '24px', flexDirection: 'column'
                }}>
                    <div className="spinner" style={{ marginBottom: '10px' }}></div>
                    Saving PDF... Do not close.
                </div>
            )}
            {saveNotice && saveNotice.length > 0 && (
                // Font substitution and a rastered text object both change what
                // the user gets, so they belong on screen rather than in the
                // console. Failures land here too, one line per cause.
                <div
                    className="annotator-save-notice"
                    role="status"
                    data-testid="annotator-save-notice"
                >
                    <div className="annotator-save-notice-body">
                        {saveNotice.map((line) => (
                            <p key={line}>{line}</p>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => setSaveNotice(null)}
                        aria-label="通知を閉じる"
                    >
                        ×
                    </button>
                </div>
            )}
            <VersionFooter
                toolName="annotator"
                version={TOOL_VERSIONS.annotator.version}
                lastUpdate={TOOL_VERSIONS.annotator.lastUpdate}
            />
        </div>
    );
};
