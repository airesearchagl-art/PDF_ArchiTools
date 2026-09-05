import './PdfTextifier.css';

import React, { useState, useRef, useCallback, useEffect } from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import { Upload, FileText, Check, Download, Loader, Settings, ArrowRight, AlertTriangle, XCircle } from 'lucide-react';
import { renderPageToCanvas } from '../utils/pdfDiff';

import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';
import { textifyPdf, extractTextPdf, TextifyError, configurePdfWorker, preprocessSkipNotice } from '../utils/pdf-textifier';
import type { PageKind, PagePreprocessInfo, ProgressEvent } from '../utils/pdf-textifier';

type Mode = 'ocr' | 'extract';

interface TextifierOptions {
    /** Applied to the OCR image only. Both off unless the user asks. */
    deskew: boolean;
    noiseReduction: boolean;
    mode: Mode;
    outputFormat: 'pdf' | 'txt' | 'word' | 'excel';
}

/**
 * More than one thing can be worth saying about a finished run, and the panel
 * shows one string. Nothing is dropped just because something else also
 * applied.
 */
function joinNotices(parts: (string | null)[]): string | null {
    const kept = parts.filter((p): p is string => Boolean(p));
    return kept.length ? kept.join(' ') : null;
}

/** Width the first-page preview thumbnail is fitted to. */
const PREVIEW_WIDTH = 300;

/** The only format each mode can actually produce today. */
const FORMAT_FOR_MODE: Record<Mode, TextifierOptions['outputFormat']> = {
    ocr: 'pdf',
    extract: 'txt',
};

/** What the result panel needs, from either pipeline. */
interface CompletedRun {
    mode: Mode;
    blobUrl: string;
    fileName: string;
    pages: { pageNumber: number; kind: PageKind; ocrWords: number; error?: string; preprocess?: PagePreprocessInfo }[];
    outputBytes: number;
    totalMs: number;
    fontEmbedded: boolean;
    /** Characters written, for a Text Extraction run. */
    totalChars: number | null;
}

export const PdfTextifier: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<ProgressEvent | null>(null);
    const [result, setResult] = useState<CompletedRun | null>(null);
    const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    // The opened document, kept so the preview can be drawn once the canvas it
    // draws onto has been rendered.
    const [previewPdf, setPreviewPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);

    // Default options
    // Preprocessing starts off. It changes what the OCR engine is shown, and a
    // page that was already straight and clean has nothing to gain from it, so
    // the tool behaves as it always did until someone turns it on.
    const [options, setOptions] = useState<TextifierOptions>({
        deskew: false,
        noiseReduction: false,
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
            setPreviewPdf(loadedPdf);
        } catch (err) {
            console.error("Error loading PDF:", err);
            setFile(null);
            setPreviewPdf(null);
            setError({
                title: 'PDFを読み込めませんでした。',
                detail: err instanceof Error ? err.message : String(err),
            });
        }
    };

    /**
     * Draw the first page once the canvas is actually on screen.
     *
     * This has to wait for a render, not just for the file to be read. The
     * preview canvas is only in the tree while a file is selected, so at the
     * moment the file is opened it does not exist yet and the ref is still
     * null -- and the preview simply gave up there. The result was a blank
     * frame for the first PDF of a session, with the second and every one
     * after it drawing correctly off the canvas the first file had left
     * behind. An effect runs after React has committed the DOM, so the canvas
     * is there to draw on.
     */
    useEffect(() => {
        if (!previewPdf) return;
        let abandoned = false;

        (async () => {
            try {
                const page = await previewPdf.getPage(1);
                const viewport = page.getViewport({ scale: 1.0 });
                const rendered = await renderPageToCanvas(
                    previewPdf, 1, PREVIEW_WIDTH / viewport.width,
                );

                // Another file may have been chosen while this was rendering.
                const target = canvasRef.current;
                if (abandoned || !target) return;
                const ctx = target.getContext('2d');
                if (!ctx) return;
                target.width = rendered.width;
                target.height = rendered.height;
                ctx.drawImage(rendered, 0, 0);
            } catch (e) {
                console.error("Preview render error:", e);
            }
        })();

        return () => { abandoned = true; };
    }, [previewPdf]);

    /**
     * Switching mode throws away whatever the previous mode produced.
     *
     * Otherwise the finished OCR run's "Download Result" would still be sitting
     * there while the screen says Text Extraction, and the file that arrives is
     * a searchable PDF from the mode the user just left.
     */
    const handleModeChange = (mode: Mode) => {
        if (mode === options.mode || isProcessing) return;
        resetRun();
        setOptions({ ...options, mode, outputFormat: FORMAT_FOR_MODE[mode] });
    };

    /**
     * Changing what the OCR engine is shown invalidates the finished result for
     * the same reason changing mode does: the file under the Download button
     * was produced with the old setting, and the screen would no longer describe
     * it.
     */
    const handlePreprocessChange = (key: 'deskew' | 'noiseReduction', value: boolean) => {
        if (isProcessing || options[key] === value) return;
        resetRun();
        setOptions({ ...options, [key]: value });
    };

    const runOcr = async (source: File) => {
        const run = await textifyPdf(source, {
            langs: 'jpn+eng',
            preprocess: { deskew: options.deskew, noiseReduction: options.noiseReduction },
            onProgress: setProgress,
            shouldCancel: () => cancelRef.current,
        });

        const blob = new Blob([run.bytes as BlobPart], { type: 'application/pdf' });
        setResult({
            mode: 'ocr',
            blobUrl: URL.createObjectURL(blob),
            fileName: source.name.replace(/\.pdf$/i, '') + '_searchable.pdf',
            pages: run.pages,
            outputBytes: run.outputBytes,
            totalMs: run.totalMs,
            fontEmbedded: run.fontEmbedded,
            totalChars: null,
        });

        const failed = run.pages.filter((p) => p.error);
        const notices = [preprocessSkipNotice(run.pages)];
        if (failed.length > 0) {
            notices.push(`${failed.length} ページで文字認識に失敗しました。該当ページは元のまま出力されています。`);
        } else if (run.pages.every((p) => p.kind === 'text-native')) {
            notices.push('すべてのページに既にテキストが含まれていたため、OCRは実行していません。');
        }
        setNotice(joinNotices(notices));
    };

    const runExtract = async (source: File) => {
        const run = await extractTextPdf(source, {
            langs: 'jpn+eng',
            preprocess: { deskew: options.deskew, noiseReduction: options.noiseReduction },
            onProgress: setProgress,
            shouldCancel: () => cancelRef.current,
        });

        // Plain UTF-8, no BOM: the charset is declared on the blob, and a byte
        // order mark would put an invisible character ahead of the first page
        // header for anything that reads the file back.
        const blob = new Blob([run.text], { type: 'text/plain;charset=utf-8' });
        setResult({
            mode: 'extract',
            blobUrl: URL.createObjectURL(blob),
            fileName: source.name.replace(/\.pdf$/i, '') + '_extracted.txt',
            pages: run.pages,
            outputBytes: blob.size,
            totalMs: run.totalMs,
            fontEmbedded: false,
            totalChars: run.totalChars,
        });

        const notices = [preprocessSkipNotice(run.pages)];
        if (run.totalChars === 0) {
            notices.push('文字が見つかりませんでした。ページ区切りのみのTXTが出力されています。');
        } else if (!run.ocrUsed) {
            notices.push('すべてのページに文字情報があったため、OCRは実行していません。');
        }
        setNotice(joinNotices(notices));
    };

    const handleProcess = async () => {
        if (!file || isProcessing) return;

        resetRun();
        cancelRef.current = false;
        setIsProcessing(true);

        try {
            if (options.mode === 'extract') await runExtract(file);
            else await runOcr(file);
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
                            スキャンPDFを検索可能PDFへ、またはPDFの文字をTXTへ。処理はすべてブラウザ内で行われ、ファイルは外部へ送信されません。
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
                                    <Settings size={16} /> OCR前処理
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: isProcessing ? 'not-allowed' : 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        name="deskew"
                                        checked={options.deskew}
                                        onChange={(e) => handlePreprocessChange('deskew', e.target.checked)}
                                        disabled={isProcessing}
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <span>傾き補正 (Deskew)</span>
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: isProcessing ? 'not-allowed' : 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        name="noiseReduction"
                                        checked={options.noiseReduction}
                                        onChange={(e) => handlePreprocessChange('noiseReduction', e.target.checked)}
                                        disabled={isProcessing}
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <span>ノイズ除去 (Remove Noise)</span>
                                </label>
                                <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                    スキャンページの文字認識用画像だけに適用されます。元PDFの見た目は変わりません。
                                </span>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ fontWeight: 600 }}>Processing Mode</label>
                                <div style={{ display: 'flex', gap: '15px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                                        <input
                                            type="radio"
                                            name="mode"
                                            value="ocr"
                                            checked={options.mode === 'ocr'}
                                            onChange={() => handleModeChange('ocr')}
                                            disabled={isProcessing}
                                        /> OCR
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                                        <input
                                            type="radio"
                                            name="mode"
                                            value="extract"
                                            checked={options.mode === 'extract'}
                                            onChange={() => handleModeChange('extract')}
                                            disabled={isProcessing}
                                        /> Text Extraction
                                    </label>
                                </div>
                                <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                    {options.mode === 'ocr'
                                        ? '既にテキストを持つページは自動的にOCRを行いません。'
                                        : '文字情報のあるページはその文字を、スキャンページはOCRの結果をTXTへ書き出します。'}
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
                                    {/* Each mode has exactly one real output, so the other one is
                                        not offered rather than offered and then rejected. */}
                                    {options.mode === 'ocr'
                                        ? <option value="pdf">PDF (Searchable)</option>
                                        : <option value="txt">Text (.txt)</option>}
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
                                {result.pages.length} ページ処理 / OCR {ocrPages.length} ページ
                                {result.mode === 'extract'
                                    ? ` / 抽出 ${result.totalChars ?? 0} 文字`
                                    : ` / 認識 ${recognisedWords} 語`}
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
