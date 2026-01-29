import React, { useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { Save, Upload, ArrowUp, ArrowDown, X, FileText } from 'lucide-react';
import { GlobalWorkerOptions } from 'pdfjs-dist';

// Ensure worker is set
GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';

interface ExtractPage {
    pageNum: number;
    selected: boolean;
    image: string; // Data URL
}

interface MergeFile {
    id: string;
    file: File;
    name: string;
    pageCount: number;
}

export const PdfSplitMerge: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'extract' | 'merge'>('extract');

    // Extract State
    const [extractFile, setExtractFile] = useState<File | null>(null);
    const [extractPages, setExtractPages] = useState<ExtractPage[]>([]);
    const [isExtracting, setIsExtracting] = useState(false);
    const [thumbnailSize, setThumbnailSize] = useState(150);

    // Merge State
    const [mergeFiles, setMergeFiles] = useState<MergeFile[]>([]);
    const [isMerging, setIsMerging] = useState(false);

    // --- Extract Logic ---
    const handleExtractUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setExtractFile(file);
        setIsExtracting(true);
        setExtractPages([]);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            const pages: ExtractPage[] = [];

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                // Render at higher resolution (scale 1.5) to support larger thumbnails (up to 1000px)
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                if (context) {
                    await page.render({ canvasContext: context, viewport } as any).promise;
                    pages.push({
                        pageNum: i,
                        selected: false,
                        image: canvas.toDataURL()
                    });
                }
            }
            setExtractPages(pages);
        } catch (error) {
            console.error(error);
            alert("Failed to load PDF for extraction.");
        } finally {
            setIsExtracting(false);
        }
    };

    const togglePageSelection = (pageNum: number) => {
        setExtractPages(prev => prev.map(p =>
            p.pageNum === pageNum ? { ...p, selected: !p.selected } : p
        ));
    };

    const handleExtractExport = async () => {
        if (!extractFile) return;
        const selectedPages = extractPages.filter(p => p.selected);
        if (selectedPages.length === 0) {
            alert("Please select at least one page.");
            return;
        }

        try {
            const srcDoc = await PDFDocument.load(await extractFile.arrayBuffer());
            const newDoc = await PDFDocument.create();

            // pages are 0-indexed in pdf-lib, 1-indexed in UI
            const pageIndices = selectedPages.map(p => p.pageNum - 1);
            const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);

            copiedPages.forEach(page => newDoc.addPage(page));

            const pdfBytes = await newDoc.save();
            const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `extracted_${extractFile.name}`;
            link.click();
        } catch (error) {
            console.error(error);
            alert("Failed to export PDF.");
        }
    };

    // --- Merge Logic ---
    const handleMergeUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        if (!event.target.files) return;
        const newFiles = Array.from(event.target.files);

        setIsMerging(true); // Loading state really

        const processedFiles: MergeFile[] = [];

        for (const file of newFiles) {
            if (file.type !== 'application/pdf') continue;
            try {
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                processedFiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    file,
                    name: file.name,
                    pageCount: pdf.numPages
                });
            } catch (e) {
                console.error(`Failed to load ${file.name}`, e);
            }
        }

        setMergeFiles(prev => [...prev, ...processedFiles]);
        setIsMerging(false);
    };

    const moveFile = (index: number, direction: 'up' | 'down') => {
        if (direction === 'up' && index === 0) return;
        if (direction === 'down' && index === mergeFiles.length - 1) return;

        const newFiles = [...mergeFiles];
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        [newFiles[index], newFiles[swapIndex]] = [newFiles[swapIndex], newFiles[index]];
        setMergeFiles(newFiles);
    };

    const removeFile = (id: string) => {
        setMergeFiles(prev => prev.filter(f => f.id !== id));
    };

    const handleMergeExport = async () => {
        if (mergeFiles.length === 0) return;

        try {
            const newDoc = await PDFDocument.create();

            for (const fileObj of mergeFiles) {
                const srcDoc = await PDFDocument.load(await fileObj.file.arrayBuffer());
                const indices = srcDoc.getPageIndices();
                const copiedPages = await newDoc.copyPages(srcDoc, indices);
                copiedPages.forEach(page => newDoc.addPage(page));
            }

            const pdfBytes = await newDoc.save();
            const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'merged_document.pdf';
            link.click();
        } catch (err) {
            console.error(err);
            alert("Failed to merge PDFs.");
        }
    };


    return (
        <div style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* Tabs */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button
                    onClick={() => setActiveTab('extract')}
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        borderRadius: '5px',
                        backgroundColor: activeTab === 'extract' ? '#4a90e2' : '#eee',
                        color: activeTab === 'extract' ? 'white' : 'black',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }}
                >
                    PDF抽出 (Extract)
                </button>
                <button
                    onClick={() => setActiveTab('merge')}
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        borderRadius: '5px',
                        backgroundColor: activeTab === 'merge' ? '#4a90e2' : '#eee',
                        color: activeTab === 'merge' ? 'white' : 'black',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }}
                >
                    PDF統合 (Merge)
                </button>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {activeTab === 'extract' && (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
                            <label className="button-primary" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', padding: '10px 15px', backgroundColor: '#333', color: 'white', borderRadius: '5px' }}>
                                <Upload size={18} />
                                PDFをアップロード
                                <input type="file" accept="application/pdf" onChange={handleExtractUpload} style={{ display: 'none' }} />
                            </label>

                            {/* Slider Control */}
                            {extractFile && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '0.9em', whiteSpace: 'nowrap' }}>表示サイズ:</span>
                                    <input
                                        type="range"
                                        min="100"
                                        max="1000"
                                        value={thumbnailSize}
                                        onChange={(e) => setThumbnailSize(parseInt(e.target.value))}
                                        style={{ width: '150px', cursor: 'pointer' }}
                                    />
                                    <span style={{ fontSize: '0.8em', color: '#666' }}>{thumbnailSize}px</span>
                                </div>
                            )}

                            {extractFile && <span>Current: {extractFile.name}</span>}
                            {extractPages.some(p => p.selected) && (
                                <button
                                    onClick={handleExtractExport}
                                    style={{
                                        marginLeft: 'auto',
                                        padding: '10px 20px',
                                        backgroundColor: '#28a745',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '5px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px'
                                    }}
                                >
                                    <Save size={18} />
                                    選択したページを書き出し
                                </button>
                            )}
                        </div>

                        {isExtracting && <div>読み込み中 / Loading...</div>}

                        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: '5px', padding: '20px' }}>
                            {!extractFile && <div style={{ textAlign: 'center', marginTop: '50px', color: '#999' }}>PDFをアップロードしてください</div>}
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`,
                                gap: '20px',
                                placeItems: 'start center'
                            }}>
                                {extractPages.map(page => (
                                    <div
                                        key={page.pageNum}
                                        onClick={() => togglePageSelection(page.pageNum)}
                                        style={{
                                            border: page.selected ? '3px solid #4a90e2' : '1px solid #ddd',
                                            borderRadius: '5px',
                                            padding: '10px',
                                            cursor: 'pointer',
                                            backgroundColor: page.selected ? '#e6f2ff' : 'white',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            transition: 'all 0.2s',
                                            width: '100%',
                                            boxSizing: 'border-box'
                                        }}
                                    >
                                        <div style={{ marginBottom: '5px', fontWeight: 'bold' }}>Page {page.pageNum}</div>
                                        <img src={page.image} alt={`Page ${page.pageNum}`} style={{ maxWidth: '100%', border: '1px solid #eee' }} />
                                        <input
                                            type="checkbox"
                                            checked={page.selected}
                                            readOnly
                                            style={{ marginTop: '10px', transform: 'scale(1.5)', pointerEvents: 'none' }}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'merge' && (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <label className="button-primary" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', padding: '10px 15px', backgroundColor: '#333', color: 'white', borderRadius: '5px' }}>
                                <Upload size={18} />
                                追加 PDF アップロード
                                <input type="file" accept="application/pdf" multiple onChange={handleMergeUpload} style={{ display: 'none' }} />
                            </label>
                            {mergeFiles.length > 0 && (
                                <button
                                    onClick={handleMergeExport}
                                    style={{
                                        marginLeft: 'auto',
                                        padding: '10px 20px',
                                        backgroundColor: '#28a745',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '5px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '5px'
                                    }}
                                >
                                    <Save size={18} />
                                    統合 PDF を書き出し
                                </button>
                            )}
                        </div>

                        {isMerging && <div>Processing uploads...</div>}

                        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: '5px', padding: '20px' }}>
                            {mergeFiles.length === 0 && <div style={{ textAlign: 'center', marginTop: '50px', color: '#999' }}>統合するPDFファイルを追加してください</div>}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {mergeFiles.map((file, index) => (
                                    <div key={file.id} style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        padding: '15px',
                                        border: '1px solid #eee',
                                        borderRadius: '5px',
                                        backgroundColor: 'white',
                                        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                                    }}>
                                        <div style={{ marginRight: '15px', color: '#666', fontWeight: 'bold' }}>{index + 1}</div>
                                        <FileText size={24} style={{ marginRight: '15px', color: '#4a90e2' }} />
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 'bold', color: 'black' }}>{file.name}</div>
                                            <div style={{ fontSize: '0.9em', color: '#666' }}>{file.pageCount} pages</div>
                                        </div>

                                        <div style={{ display: 'flex', gap: '5px' }}>
                                            <button
                                                onClick={() => moveFile(index, 'up')}
                                                disabled={index === 0}
                                                style={{ padding: '5px', cursor: index === 0 ? 'default' : 'pointer', opacity: index === 0 ? 0.3 : 1 }}
                                                title="Move Up"
                                            >
                                                <ArrowUp size={18} />
                                            </button>
                                            <button
                                                onClick={() => moveFile(index, 'down')}
                                                disabled={index === mergeFiles.length - 1}
                                                style={{ padding: '5px', cursor: index === mergeFiles.length - 1 ? 'default' : 'pointer', opacity: index === mergeFiles.length - 1 ? 0.3 : 1 }}
                                                title="Move Down"
                                            >
                                                <ArrowDown size={18} />
                                            </button>
                                            <button
                                                onClick={() => removeFile(file.id)}
                                                style={{ padding: '5px', marginLeft: '10px', color: 'red', cursor: 'pointer' }}
                                                title="Remove"
                                            >
                                                <X size={18} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <VersionFooter
                toolName="splitMerge"
                version={TOOL_VERSIONS.splitMerge.version}
                lastUpdate={TOOL_VERSIONS.splitMerge.lastUpdate}
            />
        </div>
    );
};
