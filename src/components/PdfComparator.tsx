import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { renderPageToCanvas, computeMultiPdfComposite, detectChangeBounds } from '../utils/pdfDiff';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Eye, EyeOff, Download, Settings, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';

// Configure PDF worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// Config for the 4 slots
const SLOTS = [
    { id: 0, name: 'Blue (Base)', color: 'blue', rgb: [0, 0, 1] as [number, number, number] },
    { id: 1, name: 'Red', color: 'red', rgb: [1, 0, 0] as [number, number, number] },
    { id: 2, name: 'Green', color: 'green', rgb: [0, 0.5, 0] as [number, number, number] }, // Darker green for visibility
    { id: 3, name: 'Yellow', color: '#e6b800', rgb: [0.9, 0.7, 0] as [number, number, number] }, // Darker yellow for visibility against white
];

export const PdfComparator: React.FC = () => {
    // State for 4 files
    const [files, setFiles] = useState<(File | null)[]>([null, null, null, null]);
    const [pdfs, setPdfs] = useState<(pdfjsLib.PDFDocumentProxy | null)[]>([null, null, null, null]);
    const [visible, setVisible] = useState<boolean[]>([true, true, true, true]);

    const [pageNumber, setPageNumber] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [scale, setScale] = useState(1.0); // Visual Zoom Scale (1.0 = 100% relative to 72DPI standard)
    const [dpi, setDpi] = useState(150);     // Render Resolution
    const [threshold, setThreshold] = useState(0);
    const [matchColor, setMatchColor] = useState('#C0C0C0'); // 一致箇所の色（デフォルト: 薄いグレー）
    const [matchOpacity, setMatchOpacity] = useState(0.7);   // 一致箇所の透明度（デフォルト: 70%）
    const [exportingProgress, setExportingProgress] = useState<{ current: number, total: number } | null>(null);

    // Export Settings
    const [exportScope, setExportScope] = useState<'all' | 'current' | 'range'>('all');
    const [exportRange, setExportRange] = useState('');
    const [showExportSettings, setShowExportSettings] = useState(false);

    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Derived state
    const activeIndices = pdfs.map((pdf, i) => (pdf && visible[i] ? i : -1)).filter(i => i !== -1);

    // Helper: hex to RGB conversion
    const hexToRgb = (hex: string): [number, number, number] => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255]
            : [0, 0, 0];
    };

    // Handle File Upload
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;

            const newFiles = [...files];
            newFiles[index] = file;
            setFiles(newFiles);

            const newPdfs = [...pdfs];
            newPdfs[index] = pdf;
            setPdfs(newPdfs);

            // Update max pages
            setNumPages(prev => Math.max(prev, pdf.numPages));
        } catch (err) {
            console.error("Error loading PDF:", err);
            alert("Failed to load PDF file.");
        }
    };

    const toggleVisibility = (index: number) => {
        const newVis = [...visible];
        newVis[index] = !newVis[index];
        setVisible(newVis);
    };

    // Zoom Handling
    const handleWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY * -0.01;
            setScale(prev => Math.min(Math.max(0.1, prev + delta), 5.0));
        }
    };

    // Fit Width Handler
    const handleFitWidth = async () => {
        if (!canvasContainerRef.current) return;

        // Find first valid PDF to measure
        const validIndex = activeIndices[0];
        if (validIndex === undefined || !pdfs[validIndex]) return;

        try {
            const page = await pdfs[validIndex]!.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1.0 });

            // Available width in container (minus padding)
            const availableWidth = canvasContainerRef.current.clientWidth - 40; // 20px padding * 2

            const newScale = availableWidth / viewport.width;
            setScale(newScale);
        } catch (e) {
            console.error(e);
        }
    };

    // Render Composite View
    useEffect(() => {
        const renderComposite = async () => {
            // Check if we have at least one visible PDF
            if (activeIndices.length === 0) {
                // Clear canvas
                if (canvasRef.current) {
                    const ctx = canvasRef.current.getContext('2d');
                    ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                }
                return;
            }

            if (!canvasRef.current) return;

            try {
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;

                // 0. Determine Safe Render Scale
                // Get base dimensions from the first active PDF
                const basePdf = pdfs[activeIndices[0]]!;
                let baseVp = { width: 600, height: 800 }; // Fallback
                try {
                    const page = await basePdf.getPage(pageNumber);
                    baseVp = page.getViewport({ scale: 1.0 });
                } catch (e) { console.warn("Could not get viewport", e); }

                let renderScale = scale * (dpi / 72);

                // Safety Limits for Canvas Buffer
                const MAX_DIM = 12000;
                const MAX_AREA = 80000000; // ~80MP

                const estW = baseVp.width * renderScale;
                const estH = baseVp.height * renderScale;

                if (estW > MAX_DIM || estH > MAX_DIM || (estW * estH) > MAX_AREA) {
                    // Reduce scale to fit limits
                    const ratioW = MAX_DIM / estW;
                    const ratioH = MAX_DIM / estH;
                    const ratioA = Math.sqrt(MAX_AREA / (estW * estH));
                    const safeFactor = Math.min(ratioW, ratioH, ratioA);
                    renderScale *= safeFactor;
                    console.warn(`Canvas size limit reached. Capping render scale to ${renderScale.toFixed(2)} (Requested: ${(scale * dpi / 72).toFixed(2)})`);
                }


                // 1. Render all active pages to buffers
                const layerData = [];
                let w = 0, h = 0;

                for (const i of activeIndices) {
                    const pdf = pdfs[i]!;
                    if (pageNumber > pdf.numPages) continue; // Skip if page doesn't exist

                    const canvas = await renderPageToCanvas(pdf, pageNumber, renderScale);
                    w = Math.max(w, canvas.width);
                    h = Math.max(h, canvas.height);

                    const pCtx = canvas.getContext('2d');
                    if (pCtx) {
                        layerData.push({
                            data: pCtx.getImageData(0, 0, canvas.width, canvas.height).data,
                            color: SLOTS[i].rgb
                        });
                    }
                }

                if (w === 0 || h === 0 || layerData.length === 0) {
                    return;
                }

                canvasRef.current.width = w;
                canvasRef.current.height = h;

                // Set CSS dimensions to match Visual Scale
                const displayFactor = scale / renderScale;
                canvasRef.current.style.width = `${w * displayFactor}px`;
                canvasRef.current.style.height = `${h * displayFactor}px`;

                // 2. Compute Composite with match color/opacity
                const matchColorRGB = hexToRgb(matchColor);
                const compositeData = computeMultiPdfComposite(layerData, w, h, threshold, matchColorRGB, matchOpacity);
                ctx.putImageData(compositeData, 0, 0);

            } catch (err) {
                console.error("Error compositing:", err);
            }
        };

        const timer = setTimeout(() => {
            renderComposite();
        }, 300); // Debounce

        return () => clearTimeout(timer);
    }, [pdfs, activeIndices, visible, pageNumber, scale, threshold, dpi, matchColor, matchOpacity]);

    // Handle PDF Download
    const handleDownload = async () => {
        if (activeIndices.length === 0) return;
        if (numPages === 0) return;

        // Determine Pages to Export
        let pagesToExport: number[] = [];
        if (exportScope === 'all') {
            pagesToExport = Array.from({ length: numPages }, (_, i) => i + 1);
        } else if (exportScope === 'current') {
            pagesToExport = [pageNumber];
        } else if (exportScope === 'range') {
            const parts = exportRange.split(',').map(s => s.trim());
            const uniquePages = new Set<number>();
            parts.forEach(part => {
                if (part.includes('-')) {
                    const [start, end] = part.split('-').map(Number);
                    if (!isNaN(start) && !isNaN(end)) {
                        for (let k = Math.min(start, end); k <= Math.max(start, end); k++) {
                            if (k >= 1 && k <= numPages) uniquePages.add(k);
                        }
                    }
                } else {
                    const p = Number(part);
                    if (!isNaN(p) && p >= 1 && p <= numPages) uniquePages.add(p);
                }
            });
            pagesToExport = Array.from(uniquePages).sort((a, b) => a - b);
        }

        if (pagesToExport.length === 0) {
            alert("No valid pages selected for export.");
            return;
        }

        setExportingProgress({ current: 0, total: pagesToExport.length });

        // Calculate Export Scale (dpi / 72)
        const exportScale = dpi / 72;

        try {
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'px',
                hotfixes: ["px_scaling"]
            });
            doc.deletePage(1);

            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');

            if (!tempCtx) throw new Error("No 2D Context");

            // Safety Limits for Export Canvas (same as preview)
            const MAX_DIM = 12000;
            const MAX_AREA = 80000000; // ~80MP

            let processedCount = 0;

            for (const p of pagesToExport) {
                setExportingProgress({ current: processedCount + 1, total: pagesToExport.length });

                // Determine Safe Scale for this page
                let safeExportScale = exportScale;

                try {
                    // Peek at dimensions using the first active base PDF
                    let basePdf = null;
                    for (const idx of activeIndices) {
                        if (pdfs[idx] && p <= pdfs[idx].numPages) {
                            basePdf = pdfs[idx];
                            break;
                        }
                    }

                    if (basePdf) {
                        const page = await basePdf.getPage(p);
                        const vp = page.getViewport({ scale: 1.0 });
                        const estW = vp.width * exportScale;
                        const estH = vp.height * exportScale;

                        if (estW > MAX_DIM || estH > MAX_DIM || (estW * estH) > MAX_AREA) {
                            const ratioW = MAX_DIM / estW;
                            const ratioH = MAX_DIM / estH;
                            const ratioA = Math.sqrt(MAX_AREA / (estW * estH));
                            safeExportScale = exportScale * Math.min(1, ratioW, ratioH, ratioA);
                            console.warn(`Export: Cap scale to ${safeExportScale.toFixed(2)} for safe rendering.`);
                        }
                    }
                } catch (e) { console.warn("Error estimating export size", e); }

                // 1. Render Layers to individual canvases first
                // This allows us to determine the Max Width/Height before compositing
                const rawLayers: { canvas: HTMLCanvasElement, color: [number, number, number] }[] = [];
                let maxW = 0;
                let maxH = 0;

                for (const i of activeIndices) {
                    const pdf = pdfs[i];
                    if (!pdf || p > pdf.numPages) continue;

                    try {
                        const canvas = await renderPageToCanvas(pdf, p, safeExportScale);
                        maxW = Math.max(maxW, canvas.width);
                        maxH = Math.max(maxH, canvas.height);
                        rawLayers.push({
                            canvas: canvas,
                            color: SLOTS[i].rgb
                        });
                    } catch (err) {
                        console.warn(`Skipping page ${p} of PDF ${i}`, err);
                    }
                }

                if (maxW === 0 || maxH === 0 || rawLayers.length === 0) {
                    processedCount++;
                    continue;
                }

                // 2. Normalize and Extract Data
                // Ensure all buffers are exactly maxW x maxH, padded with white
                const normalizedLayerData = [];

                tempCanvas.width = maxW;
                tempCanvas.height = maxH;

                for (const layer of rawLayers) {
                    // Fill white (background)
                    tempCtx.fillStyle = 'white';
                    tempCtx.fillRect(0, 0, maxW, maxH);

                    // Draw layer (top-left aligned)
                    tempCtx.drawImage(layer.canvas, 0, 0);

                    normalizedLayerData.push({
                        data: tempCtx.getImageData(0, 0, maxW, maxH).data,
                        color: layer.color
                    });

                    // Cleanup individual canvas
                    layer.canvas.width = 0;
                    layer.canvas.height = 0;
                }

                // 3. Composite
                const matchColorRGB = hexToRgb(matchColor);
                const compositeData = computeMultiPdfComposite(normalizedLayerData, maxW, maxH, threshold, matchColorRGB, matchOpacity);

                // Put composite back to tempCanvas
                tempCtx.putImageData(compositeData, 0, 0);

                const imgData = tempCanvas.toDataURL('image/jpeg', 0.85);

                const orientation = maxW > maxH ? 'landscape' : 'portrait';

                // Calculate Logical Size
                const pdfW = maxW / safeExportScale;
                const pdfH = maxH / safeExportScale;

                doc.addPage([pdfW, pdfH], orientation);
                doc.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);

                processedCount++;

                // Yield to event loop to allow UI update
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            // Generate Filename
            let baseName = "comparison";
            if (files[0]) {
                baseName = files[0].name.replace(/\.pdf$/i, "");
            }
            const filename = `comparison_${baseName}_${dpi}dpi.pdf`;

            doc.save(filename);

        } catch (error) {
            console.error("Export Failed", error);
            alert("Export Failed: " + error);
        } finally {
            setExportingProgress(null);
        }
    };


    // Generate Change Report function
    const generateChangeReport = async () => {
        if (activeIndices.length < 2) {
            alert('比較するPDFが2つ以上必要です');
            return;
        }

        try {
            const reportPdf = new jsPDF();
            let isFirstPage = true;
            let changesFound = 0;

            for (let page = 1; page <= numPages; page++) {
                // 各ページをレンダリング
                const pixelScale = scale * (dpi / 72);
                const layerData = [];
                let maxW = 0, maxH = 0;

                for (const i of activeIndices) {
                    const pdf = pdfs[i]!;
                    if (page > pdf.numPages) continue;
                    const canvas = await renderPageToCanvas(pdf, page, pixelScale);
                    maxW = Math.max(maxW, canvas.width);
                    maxH = Math.max(maxH, canvas.height);
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        layerData.push({
                            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
                            color: SLOTS[i].rgb
                        });
                    }
                }

                if (layerData.length < 2) continue;

                // 変更箇所を検出
                const bounds = detectChangeBounds(layerData, maxW, maxH, threshold);

                if (bounds) {
                    changesFound++;

                    // 合成画像を生成
                    const matchColorRGB = hexToRgb(matchColor);
                    const composite = computeMultiPdfComposite(layerData, maxW, maxH, threshold, matchColorRGB, matchOpacity);

                    // 一時キャンバスに描画
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = maxW;
                    tempCanvas.height = maxH;
                    const tempCtx = tempCanvas.getContext('2d');
                    if (!tempCtx) continue;
                    tempCtx.putImageData(composite, 0, 0);

                    // 変更箇所のみ切り抜き
                    const croppedCanvas = document.createElement('canvas');
                    croppedCanvas.width = bounds.width;
                    croppedCanvas.height = bounds.height;
                    const croppedCtx = croppedCanvas.getContext('2d');
                    if (!croppedCtx) continue;

                    croppedCtx.drawImage(
                        tempCanvas,
                        bounds.x, bounds.y, bounds.width, bounds.height,
                        0, 0, bounds.width, bounds.height
                    );

                    // PDFに追加
                    if (!isFirstPage) reportPdf.addPage();
                    isFirstPage = false;

                    const imgData = croppedCanvas.toDataURL('image/png');
                    const pdfWidth = reportPdf.internal.pageSize.getWidth() - 20; // マージン
                    const aspectRatio = bounds.height / bounds.width;
                    const pdfHeight = pdfWidth * aspectRatio;

                    reportPdf.addImage(imgData, 'PNG', 10, 10, pdfWidth, pdfHeight);
                    reportPdf.setFontSize(10);
                    reportPdf.text(`Page ${page} - Change Detected (位置: x=${bounds.x}, y=${bounds.y})`, 10, pdfHeight + 20);
                }
            }

            if (changesFound === 0) {
                alert('変更箇所が検出されませんでした');
                return;
            }

            reportPdf.save('change_report.pdf');
            alert(`レポート生成完了: ${changesFound}ページの変更を検出しました`);
        } catch (error) {
            console.error('Report generation error:', error);
            alert('レポート生成に失敗しました: ' + (error as Error).message);
        }
    };

    return (
        <div className="pdf-comparator" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Top Controls: 4 File Slots */}
            <div className="controls-bar" style={{
                padding: '10px',
                background: '#f5f5f5',
                borderBottom: '1px solid #ddd',
                zIndex: 10,
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                color: '#333'
            }}>
                <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '5px' }}>
                    {SLOTS.map((slot, i) => (
                        <div key={slot.id} className="file-slot" data-usage-target="comparator-files" style={{
                            border: `2px solid ${slot.color}`,
                            borderRadius: '6px',
                            padding: '8px',
                            background: 'white',
                            minWidth: '180px',
                            opacity: visible[i] ? 1 : 0.6,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '5px',
                            flexShrink: 0
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <strong style={{ color: slot.color, fontSize: '1.0em' }}>{slot.name}</strong>
                                <button onClick={() => toggleVisibility(i)} style={{ border: 'none', background: 'none', cursor: 'pointer', zIndex: 5, padding: '2px' }} title={visible[i] ? "Hide Layer" : "Show Layer"}>
                                    {visible[i] ? <Eye size={18} color="#333" /> : <EyeOff size={18} color="#999" />}
                                </button>
                            </div>

                            {files[i] ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                    <div style={{ fontWeight: 'bold', fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#222' }} title={files[i]!.name}>
                                        {files[i]!.name}
                                    </div>
                                    <label style={{
                                        fontSize: '0.7em',
                                        color: '#666',
                                        cursor: 'pointer',
                                        textDecoration: 'underline',
                                        marginTop: '2px',
                                        alignSelf: 'flex-start'
                                    }}>
                                        Change
                                        <input
                                            type="file"
                                            accept="application/pdf"
                                            style={{ display: 'none' }}
                                            onChange={(e) => handleFileChange(e, i)}
                                        />
                                    </label>
                                </div>
                            ) : (
                                <input
                                    type="file"
                                    accept="application/pdf"
                                    style={{ width: '100%', fontSize: '0.8em' }}
                                    onChange={(e) => handleFileChange(e, i)}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {/* Match Color/Opacity Control */}
                <div className="match-color-control" data-usage-target="comparator-match" style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    borderLeft: '2px solid #ccc',
                    paddingLeft: '15px'
                }}>
                    <label style={{ fontSize: '0.8em', fontWeight: 'bold', color: '#555' }}>一致箇所:</label>
                    <input
                        type="color"
                        value={matchColor}
                        onChange={(e) => setMatchColor(e.target.value)}
                        style={{
                            width: '40px',
                            height: '30px',
                            cursor: 'pointer',
                            border: '1px solid #ccc',
                            borderRadius: '4px'
                        }}
                        title="一致箇所の色"
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <label style={{ fontSize: '0.7em', color: '#666', marginBottom: '2px' }}>透明度</label>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={matchOpacity}
                            onChange={(e) => setMatchOpacity(parseFloat(e.target.value))}
                            style={{ width: '80px', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '0.7em', color: '#666' }}>{Math.round(matchOpacity * 100)}%</span>
                    </div>
                </div>

                {/* Change Report Button */}
                <div data-usage-target="comparator-report" style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                    <button
                        onClick={generateChangeReport}
                        disabled={activeIndices.length < 2}
                        style={{
                            padding: '10px 20px',
                            backgroundColor: activeIndices.length < 2 ? '#ccc' : '#ff9800',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            cursor: activeIndices.length < 2 ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            boxShadow: activeIndices.length < 2 ? 'none' : '0 2px 4px rgba(255,152,0,0.3)',
                            fontSize: '0.9em',
                            fontWeight: 'bold'
                        }}
                        title="変更箇所のみを抽出したレポートPDFを生成"
                    >
                        <FileText size={18} />
                        変更箇所抽出レポート
                    </button>
                </div>

                {/* View Controls Line */}
                <div className="view-controls" data-usage-target="comparator-view" style={{ display: 'flex', gap: '20px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' }}>

                    {/* Page Nav */}
                    <div className="page-nav" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1}>
                            <ChevronLeft />
                        </button>
                        <span style={{ fontWeight: 'bold', color: 'black' }}>Page {pageNumber} / {numPages || '-'}</span>
                        <button onClick={() => setPageNumber(p => Math.min(numPages, p + 1))} disabled={pageNumber >= numPages}>
                            <ChevronRight />
                        </button>
                    </div>

                    {/* Zoom */}
                    <div className="zoom-controls" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <button onClick={() => setScale(s => Math.max(0.1, s - 0.1))} title="Zoom Out"><ZoomOut size={16} /></button>

                        {/* Zoom Slider */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px' }}>
                            <input
                                type="range"
                                min="0.1"
                                max="5.0"
                                step="0.1"
                                value={scale}
                                onChange={(e) => setScale(parseFloat(e.target.value))}
                                style={{ width: '100%', cursor: 'pointer' }}
                            />
                            <span style={{ fontSize: '0.7em', color: '#666' }}>{Math.round(scale * 100)}%</span>
                        </div>

                        <button onClick={() => setScale(s => Math.min(5.0, s + 0.1))} title="Zoom In"><ZoomIn size={16} /></button>

                        <button onClick={handleFitWidth} title="Fit Width" style={{ marginLeft: '5px', fontSize: '0.8em', padding: '4px 8px' }}>
                            Fit
                        </button>
                        <button onClick={() => setScale(1.0)} title="Reset (1:1)" style={{ fontSize: '0.8em', padding: '4px 8px' }}>
                            1:1
                        </button>
                    </div>



                    {/* Threshold Slider */}
                    <div className="threshold-control" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        borderLeft: '2px solid #ccc',
                        paddingLeft: '15px',
                        background: '#e0e0e0',
                        padding: '5px 15px',
                        borderRadius: '20px'
                    }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <label style={{ fontSize: '0.8em', fontWeight: 'bold' }}>Diff Threshold</label>
                            <div style={{ fontSize: '0.7em', color: '#666' }}>Ignore shifts &le; {threshold}px</div>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="5"
                            step="1"
                            value={threshold}
                            onChange={(e) => setThreshold(parseInt(e.target.value))}
                            style={{ cursor: 'pointer' }}
                        />
                        <div style={{
                            fontSize: '1.2em',
                            fontWeight: 'bold',
                            width: '30px',
                            textAlign: 'center',
                            color: threshold === 0 ? 'red' : 'green'
                        }}>
                            {threshold}px
                        </div>
                    </div>



                    {/* Export Controls */}
                    <div className="export-controls" data-usage-target="comparator-export" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        background: '#e0f2f1',
                        padding: '5px 10px',
                        borderRadius: '20px',
                        border: '1px solid #b2dfdb',
                        position: 'relative' // For dropdown
                    }}>
                        {/* Toggle Settings */}
                        <button
                            onClick={() => setShowExportSettings(!showExportSettings)}
                            title="Export Settings"
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
                                display: 'flex', alignItems: 'center'
                            }}
                        >
                            <Settings size={18} color={showExportSettings ? "#00796b" : "#555"} />
                        </button>

                        <div style={{ height: '20px', width: '1px', background: '#ccc', margin: '0 5px' }} />

                        {/* Download Btn */}
                        <button
                            onClick={handleDownload}
                            disabled={!!exportingProgress}
                            title="Export PDF with Current Settings"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                background: 'transparent',
                                color: '#00796b',
                                border: 'none',
                                fontWeight: 'bold',
                                cursor: 'pointer'
                            }}
                        >
                            <Download size={18} />
                            Export
                        </button>

                        {/* Settings Dropdown/Popover */}
                        {showExportSettings && (
                            <div style={{
                                position: 'absolute',
                                top: '100%',
                                right: 0,
                                marginTop: '10px',
                                background: 'white',
                                padding: '15px',
                                borderRadius: '8px',
                                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                                zIndex: 100,
                                minWidth: '220px',
                                border: '1px solid #eee'
                            }}>
                                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.9em', color: '#333' }}>Export Settings</h4>

                                {/* Scope */}
                                <div style={{ marginBottom: '10px' }}>
                                    <label style={{ display: 'block', fontSize: '0.75em', fontWeight: 'bold', marginBottom: '4px', color: '#666' }}>Pages</label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.85em', gap: '5px', cursor: 'pointer', color: '#333' }}>
                                            <input type="radio" checked={exportScope === 'all'} onChange={() => setExportScope('all')} />
                                            All Pages ({numPages})
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.85em', gap: '5px', cursor: 'pointer', color: '#333' }}>
                                            <input type="radio" checked={exportScope === 'current'} onChange={() => setExportScope('current')} />
                                            Current Page ({pageNumber})
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.85em', gap: '5px', cursor: 'pointer', color: '#333' }}>
                                            <input type="radio" checked={exportScope === 'range'} onChange={() => setExportScope('range')} />
                                            Range (e.g. 1-3, 5)
                                        </label>
                                        {exportScope === 'range' && (
                                            <input
                                                type="text"
                                                placeholder="1-3, 5"
                                                value={exportRange}
                                                onChange={e => setExportRange(e.target.value)}
                                                style={{ fontSize: '0.85em', padding: '4px', width: '100%', boxSizing: 'border-box', color: '#333', backgroundColor: 'white' }}
                                            />
                                        )}
                                    </div>
                                </div>

                                {/* Quality */}
                                <div style={{ marginBottom: '5px' }}>
                                    <label style={{ display: 'block', fontSize: '0.75em', fontWeight: 'bold', marginBottom: '4px', color: '#666' }}>Quality</label>
                                    <select
                                        value={dpi}
                                        onChange={(e) => setDpi(Number(e.target.value))}
                                        style={{ width: '100%', padding: '4px', fontSize: '0.85em', color: '#333', backgroundColor: 'white' }}
                                    >
                                        <option value={72}>72 DPI (Low)</option>
                                        <option value={150}>150 DPI (Std)</option>
                                        <option value={300}>300 DPI (High)</option>
                                        <option value={450}>450 DPI (Very High)</option>
                                    </select>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Canvas Area */}
            <div
                className="canvas-container"
                ref={canvasContainerRef}
                onWheel={handleWheel}
                style={{
                    flex: 1,
                    overflow: 'auto',
                    position: 'relative',
                    backgroundColor: '#e5e5e5',
                    // Use a layout that supports scrolling centered content without clipping
                    display: 'grid',
                    placeItems: 'center',
                    padding: '20px',
                }}
            >
                {exportingProgress && (
                    <div style={{
                        position: 'fixed',
                        top: 0, left: 0, right: 0, bottom: 0,
                        background: 'rgba(0,0,0,0.5)',
                        zIndex: 1000,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                        color: 'white'
                    }}>
                        <div style={{ fontSize: '1.2em', marginBottom: '10px' }}>Exporting...</div>
                        <div style={{ fontSize: '2em', fontWeight: 'bold' }}>
                            {Math.round((exportingProgress.current / exportingProgress.total) * 100)}%
                        </div>
                        <div style={{ marginTop: '5px', opacity: 0.8 }}>
                            Page {exportingProgress.current} / {exportingProgress.total}
                        </div>
                    </div>
                )}
                {/* Canvas */}
                <canvas
                    ref={canvasRef}
                    style={{
                        boxShadow: '0 0 10px rgba(0,0,0,0.1)',
                        background: 'white',
                    }}
                />

                {/* Empty State Hint */}
                {activeIndices.length === 0 && (
                    <div style={{ color: '#888', marginTop: '100px', textAlign: 'center' }}>
                        Please upload and enable at least one PDF to view.
                    </div>
                )}
            </div>
            <VersionFooter
                toolName="comparator"
                version={TOOL_VERSIONS.comparator.version}
                lastUpdate={TOOL_VERSIONS.comparator.lastUpdate}
            />
        </div >
    );
};
