import './PdfTextifier.css';

import React, { useState, useRef, useCallback } from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import { Upload, FileText, Check, Download, Loader, Settings, ArrowRight, AlertTriangle, XCircle } from 'lucide-react';
import { renderPageToCanvas } from '../utils/pdfDiff';

import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';
import { textifyPdf, TextifyError, configurePdfWorker } from '../utils/pdf-textifier';
import type { PageResult, ProgressEvent } from '../utils/pdf-textifier';

interface TextifierOptions {
    cleanNoise: boolean;
    mode: 'ocr' | 'extract';
    outputFormat: 'pdf' | 'word' | 'excel';
}

interface CompletedRun {
    blobUrl: string;
    fileName: string;
    pages: PageResult[];
    outputBytes: number;
    totalMs: number;
    fontEmbedded: boolean;
}

export const PdfTextifier: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<ProgressEvent | null>(null);
    const [result, setResult] = useState<CompletedRun | null>(null);
    const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // Default options
    const [options, setOptions] = useState<TextifierOptions>({
        cleanNoise: false,
        mode: 'ocr',
        outputFormat: 'pdf'
    });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    // Read at every page boundary by the pipeline. A ref, not state, so the
    // running job sees the change without waiting for a re-render.
    const cancelRef = useRef(false);

    const resetRun = useCallback(() => {
        setResult((previous) => {
            if (previous) URL.revokeObjectURL(previous.blobUrl);
            return null;
        });
        setError(null);
        setNotice(null);
        setProgress(null);
    }, []);

    // Handle File Upload
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (!selectedFile) return;

        resetRun();

        try {
            // Other tools assign the shared PDF.js worker global at import time;
            // claim it here so the preview loads from our own origin.
            configurePdfWorker();
            const arrayBuffer = await selectedFile.arrayBuffer();
            const loadedPdf = await pdfjsLib.getDocument(arrayBuffer).promise;

            setFile(selectedFile);

            // Render preview of first page
            renderPreview(loadedPdf);
        } catch (err) {
            console.error("Error loading PDF:", err);
            setFile(null);
            setError({
                title: 'PDFを読み込めませんでした。',
                detail: err instanceof Error ? err.message : String(err),
            });
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

    const handleProcess = async () => {
        if (!file || isProcessing) return;

        resetRun();
        cancelRef.current = false;
        setIsProcessing(true);

        try {
            const run = await textifyPdf(file, {
                langs: 'jpn+eng',
                onProgress: setProgress,
                shouldCancel: () => cancelRef.current,
            });

            const blob = new Blob([run.bytes as BlobPart], { type: 'application/pdf' });
            const outName = file.name.replace(/\.pdf$/i, '') + '_searchable.pdf';

            setResult({
                blobUrl: URL.createObjectURL(blob),
                fileName: outName,
                pages: run.pages,
                outputBytes: run.outputBytes,
                totalMs: run.totalMs,
                fontEmbedded: run.fontEmbedded,
            });

            const failed = run.pages.filter((p) => p.error);
            if (failed.length > 0) {
                setNotice(`${failed.length} ページで文字認識に失敗しました。該当ページは元のまま出力されています。`);
            } else if (run.pages.every((p) => p.kind === 'text-native')) {
                setNotice('すべてのページに既にテキストが含まれていたため、OCRは実行していません。');
            }
        } catch (err) {
            if (err instanceof TextifyError) {
                // Cancellation is a user action, not a failure.
                if (err.code === 'cancelled') setNotice('処理をキャンセルしました。ファイルは出力されていません。');
                else setError({ title: err.message, detail: err.detail });
            } else {
                setError({
                    title: '処理中に予期しないエラーが発生しました。',
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        } finally {
            setIsProcessing(false);
            setProgress(null);
            cancelRef.current = false;
        }
    };

    const handleCancel = () => {
        // Tesseract cannot abort a page mid-recognition, so this takes effect at
        // the next page boundary. The pipeline then terminates the worker and
        // throws rather than handing back a half-finished document.
        cancelRef.current = true;
    };

    const ocrPages = result?.pages.filter((p) => p.kind === 'scanned') ?? [];
    const recognisedWords = ocrPages.reduce((sum, p) => sum + p.ocrWords, 0);

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
                            スキャンPDFを検索可能PDFへ。処理はすべてブラウザ内で行われ、ファイルは外部へ送信されません。
                        </p>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', padding: '30px', gap: '30px' }}>

                    {/* 1. Upload Section */}
                    <div style={{ border: '2px dashed #ddd', borderRadius: '12px', padding: '40px', textAlign: 'center', backgroundColor: '#fafafa', cursor: isProcessing ? 'not-allowed' : 'pointer', position: 'relative' }}>
                        <input
                            type="file"
                            accept="application/pdf"
                            onChange={handleFileChange}
                            disabled={isProcessing}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: isProcessing ? 'not-allowed' : 'pointer' }}
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
                                    {!isProcessing && <div style={{ color: '#4a90e2', marginTop: '10px', fontSize: '0.9rem' }}>Click to change file</div>}
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
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'not-allowed', color: '#999' }}>
                                    <input
                                        type="checkbox"
                                        checked={options.cleanNoise}
                                        disabled
                                        readOnly
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <span>ノイズ除去を行う (Remove Noise)</span>
                                </label>
                                <span style={{ fontSize: '0.75rem', color: '#999' }}>後続対応 (not yet implemented)</span>
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
                                            disabled={isProcessing}
                                        /> OCR
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'not-allowed', color: '#999' }}>
                                        <input type="radio" name="mode" disabled readOnly checked={false} /> Text Extraction
                                    </label>
                                </div>
                                <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                    既にテキストを持つページは自動的にOCRを行いません。
                                </span>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ fontWeight: 600 }}>Output Format</label>
                                <select
                                    value={options.outputFormat}
                                    onChange={(e) => setOptions({ ...options, outputFormat: e.target.value as TextifierOptions['outputFormat'] })}
                                    disabled={isProcessing}
                                    style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                                >
                                    <option value="pdf">PDF (Searchable)</option>
                                    <option value="word" disabled>Word (.docx) — Coming later</option>
                                    <option value="excel" disabled>Excel (.xlsx) — Coming later</option>
                                </select>
                            </div>
                        </div>
                    )}

                    {/* 3. Action Section */}
                    {file && !result && (
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

                            {isProcessing && (
                                <div style={{ marginTop: '18px' }}>
                                    <div style={{ color: '#555', fontSize: '0.95rem', minHeight: '1.4em' }}>
                                        {progress?.message ?? '準備中...'}
                                    </div>
                                    {progress?.totalPages ? (
                                        <div style={{ marginTop: '10px', maxWidth: '360px', marginLeft: 'auto', marginRight: 'auto' }}>
                                            <div style={{ height: '6px', background: '#e6e9ee', borderRadius: '3px', overflow: 'hidden' }}>
                                                <div style={{
                                                    height: '100%',
                                                    width: `${Math.round(100 * ((progress.page ?? 0) - 1 + (progress.pageProgress ?? 0)) / progress.totalPages)}%`,
                                                    background: '#4a90e2',
                                                    transition: 'width 0.2s',
                                                }} />
                                            </div>
                                        </div>
                                    ) : null}
                                    <button
                                        onClick={handleCancel}
                                        disabled={cancelRef.current}
                                        style={{
                                            marginTop: '14px', padding: '8px 20px', fontSize: '0.9rem',
                                            background: 'none', border: '1px solid #d0d5dd', borderRadius: '20px',
                                            color: '#555', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px',
                                        }}
                                    >
                                        <XCircle size={16} /> キャンセル
                                    </button>
                                    <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#999' }}>
                                        キャンセルは現在のページの認識完了後に反映されます。
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div style={{ display: 'flex', gap: '12px', padding: '16px', background: '#fff4f4', border: '1px solid #ffd5d5', borderRadius: '8px', color: '#a12622' }}>
                            <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
                            <div>
                                <div style={{ fontWeight: 600 }}>{error.title}</div>
                                {error.detail && (
                                    <div style={{ marginTop: '6px', fontSize: '0.8rem', color: '#8a4b49', wordBreak: 'break-word' }}>{error.detail}</div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Notice (cancellation, partial failure, nothing to OCR) */}
                    {notice && !error && (
                        <div style={{ padding: '14px 16px', background: '#fffbe6', border: '1px solid #ffe8a3', borderRadius: '8px', color: '#7a5c00', fontSize: '0.9rem' }}>
                            {notice}
                        </div>
                    )}

                    {/* 4. Result Section */}
                    {result && (
                        <div style={{ textAlign: 'center', animation: 'fadeIn 0.5s ease' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '60px', height: '60px', borderRadius: '50%', background: '#dffff0', color: '#00c853', marginBottom: '15px' }}>
                                <Check size={32} />
                            </div>
                            <h3 style={{ margin: '0 0 10px', color: '#333' }}>Processing Complete!</h3>
                            <p style={{ color: '#666', marginBottom: '8px' }}>
                                {result.pages.length} ページ処理 / OCR {ocrPages.length} ページ / 認識 {recognisedWords} 語
                            </p>
                            <p style={{ color: '#999', marginBottom: '20px', fontSize: '0.85rem' }}>
                                {(result.outputBytes / 1024 / 1024).toFixed(2)} MB ・ {(result.totalMs / 1000).toFixed(1)} 秒
                                {result.fontEmbedded ? ' ・ 日本語フォント埋め込み済み' : ''}
                            </p>

                            <a
                                href={result.blobUrl}
                                download={result.fileName}
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
                                    textDecoration: 'none',
                                    boxShadow: '0 4px 6px rgba(0, 200, 83, 0.3)'
                                }}
                            >
                                <Download size={20} /> Download Result
                            </a>

                            <div style={{ marginTop: '20px' }}>
                                <button
                                    onClick={() => { resetRun(); setFile(null); }}
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
