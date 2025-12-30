import { useState } from 'react';
import './PdfTools.css';
import { Settings, Sliders, Layers, FileText, UploadCloud, Play, X, Check, AlertCircle, Blend, BoxSelect } from 'lucide-react';
import { processLayer, processMonochrome, processOptimize, processMargin } from '../../utils/pdf-processor';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';

type ToolType = 'layer' | 'monochrome' | 'both' | 'optimize' | 'margin';

interface ProcessFile {
    id: string;
    file: File;
    status: 'idle' | 'processing' | 'done' | 'error';
    progress: number;
}

export function PdfTools() {
    const [activeTool, setActiveTool] = useState<ToolType>('layer');
    const [files, setFiles] = useState<ProcessFile[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Tool Settings
    const [layerOpacity, setLayerOpacity] = useState(0.5);
    const [layerColor, setLayerColor] = useState('#ffffff');
    const [monoContrast, setMonoContrast] = useState(1.0);
    const [monoDpi, setMonoDpi] = useState(300);
    const [optimizeDpi, setOptimizeDpi] = useState(150);
    const [marginScale, setMarginScale] = useState(0.8);
    const [marginPosition, setMarginPosition] = useState<'center' | 'tl' | 'tr' | 'bl' | 'br'>('center');

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        const newFiles = droppedFiles.map(f => ({
            id: Math.random().toString(36).substr(2, 9),
            file: f,
            status: 'idle' as const,
            progress: 0
        }));
        setFiles(prev => [...prev, ...newFiles]);
    };

    const removeFile = (id: string) => {
        setFiles(prev => prev.filter(f => f.id !== id));
    };

    const startProcessing = async () => {
        if (files.length === 0 || isProcessing) return;
        setIsProcessing(true);

        const zip = new JSZip();
        let processedCount = 0;

        for (const fileObj of files) {
            // Remove check to allow re-processing
            // if (fileObj.status === 'done') continue;

            setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'processing', progress: 10 } : f));

            try {
                let resultData: Uint8Array;
                let suffix = '';

                if (activeTool === 'layer') {
                    resultData = await processLayer(fileObj.file, { color: layerColor, opacity: layerOpacity });
                    suffix = '_overlay';
                } else if (activeTool === 'monochrome') {
                    resultData = await processMonochrome(fileObj.file, { dpi: monoDpi, contrast: monoContrast });
                    suffix = '_mono';
                } else if (activeTool === 'both') {
                    // Both: Monochrome first, then Layer
                    const monoData = await processMonochrome(fileObj.file, { dpi: monoDpi, contrast: monoContrast });
                    resultData = await processLayer(monoData, { color: layerColor, opacity: layerOpacity });
                    suffix = '_overlay&mono';
                } else if (activeTool === 'margin') {
                    resultData = await processMargin(fileObj.file, { scale: marginScale, position: marginPosition });
                    suffix = '_margin';
                } else {
                    // Optimize
                    resultData = await processOptimize(fileObj.file, { dpi: optimizeDpi });
                    suffix = '_optimize';
                }

                // Filename construct: original_suffix.pdf
                const originalName = fileObj.file.name.replace(/\.pdf$/i, '');
                const fileName = `${originalName}${suffix}.pdf`;

                if (files.length === 1) {
                    const blob = new Blob([resultData as any], { type: 'application/pdf' });
                    saveAs(blob, fileName);
                } else {
                    zip.file(fileName, resultData);
                }

                setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'done', progress: 100 } : f));
                processedCount++;
            } catch (error) {
                console.error('Processing failed', error);
                setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'error' } : f));
            }
        }

        if (files.length > 1 && processedCount > 0) {
            const content = await zip.generateAsync({ type: "blob" });
            saveAs(content, "processed_files.zip");
        }

        setIsProcessing(false);
    };

    return (
        <div className="pdf-tools-container">
            <div className="tools-sidebar">
                <button
                    className={`tool-btn ${activeTool === 'layer' ? 'active' : ''}`}
                    onClick={() => setActiveTool('layer')}
                    disabled={isProcessing}
                >
                    <Layers size={20} />
                    <span>半透明レイヤ追加</span>
                </button>
                <button
                    className={`tool-btn ${activeTool === 'monochrome' ? 'active' : ''}`}
                    onClick={() => setActiveTool('monochrome')}
                    disabled={isProcessing}
                >
                    <Sliders size={20} />
                    <span>モノクロ化</span>
                </button>
                <button
                    className={`tool-btn ${activeTool === 'both' ? 'active' : ''}`}
                    onClick={() => setActiveTool('both')}
                    disabled={isProcessing}
                >
                    <Blend size={20} />
                    <span>両方実行</span>
                </button>
                <button
                    className={`tool-btn ${activeTool === 'margin' ? 'active' : ''}`}
                    onClick={() => setActiveTool('margin')}
                    disabled={isProcessing}
                >
                    <BoxSelect size={20} />
                    <span>余白生成</span>
                </button>
                <button
                    className={`tool-btn ${activeTool === 'optimize' ? 'active' : ''}`}
                    onClick={() => setActiveTool('optimize')}
                    disabled={isProcessing}
                >
                    <FileText size={20} />
                    <span>最適化</span>
                </button>
            </div>

            <div className="tools-main">
                <div
                    className="drop-zone"
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                    onClick={() => document.getElementById('file-input')?.click()}
                >
                    <UploadCloud size={48} className="drop-icon" />
                    <h3>PDFファイルをドロップ</h3>
                    <p>またはクリックして選択</p>
                    <input
                        id="file-input"
                        type="file"
                        multiple
                        accept=".pdf"
                        className="file-input-hidden"
                        onChange={e => {
                            if (e.target.files) {
                                const newFiles = Array.from(e.target.files).map(f => ({
                                    id: Math.random().toString(36).substr(2, 9),
                                    file: f,
                                    status: 'idle' as const,
                                    progress: 0
                                }));
                                setFiles(prev => [...prev, ...newFiles]);
                            }
                        }}
                    />
                </div>

                <div className="file-list">
                    {files.map(f => (
                        <div key={f.id} className="file-item">
                            <span className="file-name">{f.file.name}</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span className={`file-status ${f.status}`}>{f.status}</span>
                                {f.status === 'done' && <Check size={16} color="#4cd964" />}
                                {f.status === 'error' && <AlertCircle size={16} color="#ff3b30" />}
                                <button
                                    className="remove-btn"
                                    onClick={() => removeFile(f.id)}
                                    disabled={isProcessing}
                                >
                                    <X size={16} />
                                </button>
                            </div>
                            {f.status === 'processing' && (
                                <div className="progress-bar-container">
                                    <div className="progress-bar">
                                        <div className="progress-fill" style={{ width: `${f.progress}%` }}></div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    {files.length === 0 && <div className="empty-state">ファイルが選択されていません</div>}
                </div>
            </div>

            <div className="tools-settings">
                <h3><Settings size={18} /> 設定</h3>

                {(activeTool === 'layer' || activeTool === 'both') && (
                    <div className="settings-group">
                        <h4>半透明レイヤ設定</h4>
                        <label>不透明度: {Math.round(layerOpacity * 100)}%</label>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={layerOpacity}
                            onChange={e => setLayerOpacity(parseFloat(e.target.value))}
                        />

                        <label>色</label>
                        <input
                            type="color"
                            value={layerColor}
                            onChange={e => setLayerColor(e.target.value)}
                        />
                        {activeTool === 'both' && <hr style={{ borderColor: '#444', width: '100%' }} />}
                    </div>
                )}

                {(activeTool === 'monochrome' || activeTool === 'both') && (
                    <div className="settings-group">
                        <h4>モノクロ化設定</h4>
                        <label>解像度 (DPI): {monoDpi}</label>
                        <select value={monoDpi} onChange={e => setMonoDpi(parseInt(e.target.value))}>
                            <option value={150}>150 (高速)</option>
                            <option value={300}>300 (標準)</option>
                            <option value={600}>600 (高画質)</option>
                        </select>

                        <label>コントラスト: {monoContrast}</label>
                        <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.1"
                            value={monoContrast}
                            onChange={e => setMonoContrast(parseFloat(e.target.value))}
                        />
                    </div>
                )}

                {activeTool === 'margin' && (
                    <div className="settings-group">
                        <p className="info-text">
                            元の内容を縮小し、周囲に余白を作成します。
                        </p>
                        <label>縮小率: {Math.round(marginScale * 100)}%</label>
                        <input
                            type="range"
                            min="0.25"
                            max="0.9"
                            step="0.05"
                            value={marginScale}
                            onChange={e => setMarginScale(parseFloat(e.target.value))}
                        />

                        <label>配置</label>
                        <div className="position-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '5px', width: '100px', margin: '0 auto' }}>
                            <button
                                className={`pos-btn ${marginPosition === 'tl' ? 'active' : ''}`}
                                onClick={() => setMarginPosition('tl')}
                                style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === 'tl' ? '#61dafb' : '#333', cursor: 'pointer' }}
                                title="左上"
                            />
                            <button
                                style={{ height: '30px', border: '1px solid #222', backgroundColor: 'transparent', cursor: 'default' }}
                                disabled
                            />
                            <button
                                className={`pos-btn ${marginPosition === 'tr' ? 'active' : ''}`}
                                onClick={() => setMarginPosition('tr')}
                                style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === 'tr' ? '#61dafb' : '#333', cursor: 'pointer' }}
                                title="右上"
                            />

                            <button
                                style={{ height: '30px', border: '1px solid #222', backgroundColor: 'transparent', cursor: 'default' }}
                                disabled
                            />
                            <button
                                className={`pos-btn ${marginPosition === 'center' ? 'active' : ''}`}
                                onClick={() => setMarginPosition('center')}
                                style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === 'center' ? '#61dafb' : '#333', cursor: 'pointer' }}
                                title="中央"
                            />
                            <button
                                style={{ height: '30px', border: '1px solid #222', backgroundColor: 'transparent', cursor: 'default' }}
                                disabled
                            />

                            <button
                                className={`pos-btn ${marginPosition === 'bl' ? 'active' : ''}`}
                                onClick={() => setMarginPosition('bl')}
                                style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === 'bl' ? '#61dafb' : '#333', cursor: 'pointer' }}
                                title="左下"
                            />
                            <button
                                style={{ height: '30px', border: '1px solid #222', backgroundColor: 'transparent', cursor: 'default' }}
                                disabled
                            />
                            <button
                                className={`pos-btn ${marginPosition === 'br' ? 'active' : ''}`}
                                onClick={() => setMarginPosition('br')}
                                style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === 'br' ? '#61dafb' : '#333', cursor: 'pointer' }}
                                title="右下"
                            />
                        </div>
                    </div>
                )}

                {activeTool === 'optimize' && (
                    <div className="settings-group">
                        <p className="info-text">
                            解像度を調整してファイルサイズを削減します。
                        </p>
                        <label>圧縮解像度 (DPI): {optimizeDpi}</label>
                        <select value={optimizeDpi} onChange={e => setOptimizeDpi(parseInt(e.target.value))}>
                            <option value={72}>72 (スクリーン用・軽量)</option>
                            <option value={150}>150 (標準)</option>
                            <option value={300}>300 (印刷用)</option>
                        </select>
                    </div>
                )}

                <button
                    className="process-btn"
                    onClick={startProcessing}
                    disabled={isProcessing || files.length === 0}
                >
                    {isProcessing ? (
                        <>処理中...</>
                    ) : (
                        <><Play size={18} /> 実行開始</>
                    )}
                </button>
            </div>
        </div>
    );
}
