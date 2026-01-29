
import './PdfTextifier.css';

import React, { useState, useRef } from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import { Upload, FileText, Check, Download, Loader, Settings, ArrowRight } from 'lucide-react';
import { renderPageToCanvas } from '../utils/pdfDiff';

// Reuse worker configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';

interface TextifierOptions {
    cleanNoise: boolean;
    mode: 'ocr' | 'extract';
    outputFormat: 'pdf' | 'word' | 'excel';
}

export const PdfTextifier: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isComplete, setIsComplete] = useState(false);

    // Default options
    const [options, setOptions] = useState<TextifierOptions>({
        cleanNoise: true,
        mode: 'ocr',
        outputFormat: 'pdf'
    });

    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Handle File Upload
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (!selectedFile) return;

        try {
            const arrayBuffer = await selectedFile.arrayBuffer();
            const loadedPdf = await pdfjsLib.getDocument(arrayBuffer).promise;

            setFile(selectedFile);
            setIsComplete(false); // Reset completion state on new file

            // Render preview of first page
            renderPreview(loadedPdf);
        } catch (err) {
            console.error("Error loading PDF:", err);
            alert("Failed to load PDF file.");
        }
    };

    const renderPreview = async (loadedPdf: pdfjsLib.PDFDocumentProxy) => {
        if (!canvasRef.current) return;

        try {
            const page = await loadedPdf.getPage(1);
            const viewport = page.getViewport({ scale: 1.0 });

            // Fit to container width (approx 300px for preview thumbnail)
            const scale = 300 / viewport.width;
            const canvas = await renderPageToCanvas(loadedPdf, 1, scale);

            // Draw to our ref canvas
            const ctx = canvasRef.current.getContext('2d');
            if (ctx) {
                canvasRef.current.width = canvas.width;
                canvasRef.current.height = canvas.height;
                ctx.drawImage(canvas, 0, 0);
            }
        } catch (e) {
            console.error("Preview render error:", e);
        }
    };

    const handleProcess = () => {
        if (!file) return;
        setIsProcessing(true);

        // Mock processing delay
        setTimeout(() => {
            setIsProcessing(false);
            setIsComplete(true);
        }, 2000);
    };

    const handleDownload = () => {
        // Mock download
        alert('Downloading converted file in ' + options.outputFormat.toUpperCase() + ' format...');
    };

    return (
        <div style={{ padding: '20px', height: '100%', overflowY: 'auto', backgroundColor: '#f0f2f5', color: '#333' }}>
            <div style={{ maxWidth: '800px', margin: '0 auto', backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', overflow: 'hidden' }}>

                {/* Header */}
                <div style={{ padding: '20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ background: '#4a90e2', padding: '8px', borderRadius: '6px', color: 'white' }}>
                        <FileText size={24} />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.2rem' }}>PDFテキスト化 (PDF Textification)</h2>
                        <p style={{ margin: '5px 0 0', color: '#666', fontSize: '0.9rem' }}>
                            Scan data to editable text. Noise cleaning & OCR.
                        </p>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', padding: '30px', gap: '30px' }}>

                    {/* 1. Upload Section */}
                    <div style={{ border: '2px dashed #ddd', borderRadius: '12px', padding: '40px', textAlign: 'center', backgroundColor: '#fafafa', cursor: 'pointer', position: 'relative' }}>
                        <input
                            type="file"
                            accept="application/pdf"
                            onChange={handleFileChange}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
                        />
                        {!file ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', color: '#888' }}>
                                <Upload size={48} color="#ccc" />
                                <span style={{ fontWeight: 500 }}>Click or Drag PDF here</span>
                                <span style={{ fontSize: '0.8rem' }}>Supports .pdf files</span>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px' }}>
                                <canvas ref={canvasRef} style={{ border: '1px solid #ddd', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }} />
                                <div style={{ textAlign: 'left' }}>
                                    <div style={{ fontWeight: 'bold', fontSize: '1.1rem', marginBottom: '5px' }}>{file.name}</div>
                                    <div style={{ color: '#666' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
                                    <div style={{ color: '#4a90e2', marginTop: '10px', fontSize: '0.9rem' }}>Click to change file</div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 2. Settings Section */}
                    {file && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', padding: '20px', background: '#f8f9fa', borderRadius: '8px', border: '1px solid #eee' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <Settings size={16} /> Cleaning
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={options.cleanNoise}
                                        onChange={(e) => setOptions({ ...options, cleanNoise: e.target.checked })}
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <span>ノイズ除去を行う (Remove Noise)</span>
                                </label>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ fontWeight: 600 }}>Processing Mode</label>
                                <div style={{ display: 'flex', gap: '15px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                                        <input
                                            type="radio"
                                            name="mode"
                                            checked={options.mode === 'ocr'}
                                            onChange={() => setOptions({ ...options, mode: 'ocr' })}
                                        /> OCR
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                                        <input
                                            type="radio"
                                            name="mode"
                                            checked={options.mode === 'extract'}
                                            onChange={() => setOptions({ ...options, mode: 'extract' })}
                                        /> Text Extraction
                                    </label>
                                </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ fontWeight: 600 }}>Output Format</label>
                                <select
                                    value={options.outputFormat}
                                    onChange={(e) => setOptions({ ...options, outputFormat: e.target.value as any })}
                                    style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                                >
                                    <option value="pdf">PDF (Searchable)</option>
                                    <option value="word">Word (.docx)</option>
                                    <option value="excel">Excel (.xlsx)</option>
                                </select>
                            </div>
                        </div>
                    )}

                    {/* 3. Action Section */}
                    {file && !isComplete && (
                        <div style={{ textAlign: 'center' }}>
                            <button
                                onClick={handleProcess}
                                disabled={isProcessing}
                                style={{
                                    padding: '12px 40px',
                                    fontSize: '1.1rem',
                                    backgroundColor: isProcessing ? '#ccc' : '#4a90e2',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '30px',
                                    cursor: isProcessing ? 'not-allowed' : 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    transition: 'background-color 0.2s',
                                    boxShadow: '0 4px 6px rgba(74, 144, 226, 0.3)'
                                }}
                            >
                                {isProcessing ? (
                                    <>
                                        <Loader className="spin" size={20} /> Processing...
                                    </>
                                ) : (
                                    <>
                                        Start Textification <ArrowRight size={20} />
                                    </>
                                )}
                            </button>
                        </div>
                    )}

                    {/* 4. Result Section */}
                    {isComplete && (
                        <div style={{ textAlign: 'center', animation: 'fadeIn 0.5s ease' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '60px', height: '60px', borderRadius: '50%', background: '#dffff0', color: '#00c853', marginBottom: '15px' }}>
                                <Check size={32} />
                            </div>
                            <h3 style={{ margin: '0 0 10px', color: '#333' }}>Processing Complete!</h3>
                            <p style={{ color: '#666', marginBottom: '20px' }}>Your file is ready to download.</p>

                            <button
                                onClick={handleDownload}
                                style={{
                                    padding: '12px 30px',
                                    fontSize: '1rem',
                                    backgroundColor: '#00c853',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    boxShadow: '0 4px 6px rgba(0, 200, 83, 0.3)'
                                }}
                            >
                                <Download size={20} /> Download Result
                            </button>

                            <div style={{ marginTop: '20px' }}>
                                <button
                                    onClick={() => { setIsComplete(false); setFile(null); }}
                                    style={{ background: 'none', border: 'none', color: '#888', textDecoration: 'underline', cursor: 'pointer' }}
                                >
                                    Process another file
                                </button>
                            </div>
                        </div>
                    )}

                </div>
            </div>


            <VersionFooter
                toolName="textifier"
                version={TOOL_VERSIONS.textifier.version}
                lastUpdate={TOOL_VERSIONS.textifier.lastUpdate}
            />
        </div>
    );
};
