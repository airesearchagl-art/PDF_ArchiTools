import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { renderPageToCanvas, computeMultiPdfComposite } from '../utils/pdfDiff';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Eye, EyeOff, Download } from 'lucide-react';
import jsPDF from 'jspdf';

// Configure PDF worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// Config for the 4 slots
const SLOTS = [
    { id: 0, name: 'Red (Base)', color: 'red', rgb: [1, 0, 0] as [number, number, number] },
    { id: 1, name: 'Blue', color: 'blue', rgb: [0, 0, 1] as [number, number, number] },
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
    const [scale, setScale] = useState(1.0);
    const [threshold, setThreshold] = useState(0);
    const [loading, setLoading] = useState(false);
    const [exportingProgress, setExportingProgress] = useState<{ current: number, total: number } | null>(null);

    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Derived state
    const activeIndices = pdfs.map((pdf, i) => (pdf && visible[i] ? i : -1)).filter(i => i !== -1);

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

            setLoading(true);
            try {
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;

                // 1. Render all active pages to buffers
                const layerData = [];
                let w = 0, h = 0;

                for (const i of activeIndices) {
                    const pdf = pdfs[i]!;
                    if (pageNumber > pdf.numPages) continue; // Skip if page doesn't exist

                    const canvas = await renderPageToCanvas(pdf, pageNumber, scale);
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
                    setLoading(false);
                    return;
                }

                canvasRef.current.width = w;
                canvasRef.current.height = h;

                // 2. Compute Composite
                const compositeData = computeMultiPdfComposite(layerData, w, h, threshold);
                ctx.putImageData(compositeData, 0, 0);

            } catch (err) {
                console.error("Error compositing:", err);
            } finally {
                setLoading(false);
            }
        };

        const timer = setTimeout(() => {
            renderComposite();
        }, 300); // Debounce

        return () => clearTimeout(timer);
    }, [pdfs, visible, pageNumber, scale, threshold]);

    // Handle PDF Download
    const handleDownload = async () => {
        if (activeIndices.length === 0) return;
        if (numPages === 0) return;

        setExportingProgress({ current: 0, total: numPages });

        // Use a higher scale for export quality
        const exportScale = 2.0;

        try {
            const doc = new jsPDF({
                orientation: 'portrait',
                unit: 'px',
            });
            // Delete initial empty page
            doc.deletePage(1);

            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');

            if (!tempCtx) throw new Error("No 2D Context");

            for (let p = 1; p <= numPages; p++) {
                setExportingProgress({ current: p, total: numPages });

                // 1. Render Layers
                const layerData = [];
                let w = 0, h = 0;

                for (const i of activeIndices) {
                    const pdf = pdfs[i];
                    if (!pdf || p > pdf.numPages) continue;

                    try {
                        const canvas = await renderPageToCanvas(pdf, p, exportScale);
                        w = Math.max(w, canvas.width);
                        h = Math.max(h, canvas.height);
                        const pCtx = canvas.getContext('2d');
                        if (pCtx) {
                            layerData.push({
                                data: pCtx.getImageData(0, 0, canvas.width, canvas.height).data,
                                color: SLOTS[i].rgb
                            });
                        }
                    } catch (err) {
                        console.warn(`Skipping page ${p} of PDF ${i}`, err);
                    }
                }

                if (w === 0 || h === 0 || layerData.length === 0) {
                    continue; // Skip empty page? Or add blank?
                }

                // 2. Composite
                const compositeData = computeMultiPdfComposite(layerData, w, h, threshold);

                tempCanvas.width = w;
                tempCanvas.height = h;
                tempCtx.putImageData(compositeData, 0, 0);

                const imgData = tempCanvas.toDataURL('image/jpeg', 0.85);

                const orientation = w > h ? 'landscape' : 'portrait';
                doc.addPage([w, h], orientation);
                doc.addImage(imgData, 'JPEG', 0, 0, w, h);

                // Yield to event loop to allow UI update
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            doc.save(`comparison_export_${new Date().toISOString().slice(0, 10)}.pdf`);

        } catch (error) {
            console.error("Export Failed", error);
            alert("Export Failed: " + error);
        } finally {
            setExportingProgress(null);
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
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}>
                <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '5px' }}>
                    {SLOTS.map((slot, i) => (
                        <div key={slot.id} className="file-slot" style={{
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

                {/* View Controls Line */}
                <div className="view-controls" style={{ display: 'flex', gap: '20px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' }}>

                    {/* Page Nav */}
                    <div className="page-nav" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1}>
                            <ChevronLeft />
                        </button>
                        <span style={{ fontWeight: 'bold' }}>Page {pageNumber} / {numPages || '-'}</span>
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

                    {/* Download Btn */}
                    <button
                        onClick={handleDownload}
                        disabled={!!exportingProgress}
                        title="Export Comparison PDF"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            padding: '5px 10px',
                            background: '#2ba6cb',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
                        }}
                    >
                        <Download size={16} />
                        Export PDF
                    </button>

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
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'flex-start',
                    padding: '20px',
                    backgroundColor: '#e5e5e5',
                    position: 'relative'
                }}
            >
                {loading && (
                    <div style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'rgba(255,255,255,0.9)',
                        padding: '15px 30px',
                        borderRadius: '8px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                        zIndex: 10,
                        fontWeight: 'bold'
                    }}>
                        Processing Diff...
                    </div>
                )}

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
                <canvas ref={canvasRef} style={{ boxShadow: '0 0 10px rgba(0,0,0,0.1)', background: 'white' }} />

                {/* Empty State Hint */}
                {activeIndices.length === 0 && (
                    <div style={{ color: '#888', marginTop: '100px', textAlign: 'center' }}>
                        Please upload and enable at least one PDF to view.
                    </div>
                )}
            </div>
        </div>
    );
};
