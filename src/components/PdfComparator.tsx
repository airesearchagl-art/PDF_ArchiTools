import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
    DEFAULT_MEMORY_BUDGET_BYTES,
    MEMORY_BUDGET_PRESETS,
    PLAN,
    RESULT,
    SPATIAL_TOLERANCE_DISCLOSURE,
    SPATIAL_TOLERANCE_POLICY,
    encodePngStored,
    formatBytes,
    planComparison,
    runComparison,
    type ComparisonSettings,
    type JobResult,
    type MemberSource,
    type PairResult,
    type Refusal,
} from '../utils/comparator';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Eye, EyeOff, Download, Settings, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';
import { configurePdfWorker } from '../utils/pdf-worker-source';

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
    // The spatial tolerance, in the unit a drawing office reasons in. Default
    // zero: a comparison nobody configured must report every difference it can
    // see, and a non-zero value is an explicit choice with a stated cost.
    const [toleranceMm, setToleranceMm] = useState<number>(SPATIAL_TOLERANCE_POLICY.default);
    // 512 MiB is the recommendation, not a fixed limit. Nothing raises it
    // automatically -- a budget that grows to fit the job is not a budget.
    const [memoryBudgetBytes, setMemoryBudgetBytes] = useState(DEFAULT_MEMORY_BUDGET_BYTES);
    const [result, setResult] = useState<JobResult | null>(null);
    const [activePair, setActivePair] = useState(0);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    const [matchColor, setMatchColor] = useState('#C0C0C0'); // 一致箇所の色（デフォルト: 薄いグレー）
    const [matchOpacity, setMatchOpacity] = useState(0.7);   // 一致箇所の透明度（デフォルト: 70%）
    const [exportingProgress, setExportingProgress] = useState<{ current: number, total: number } | null>(null);

    // Export Settings
    const [exportScope, setExportScope] = useState<'all' | 'current' | 'range'>('all');
    const [exportRange, setExportRange] = useState('');
    const [showExportSettings, setShowExportSettings] = useState(false);

    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /**
     * Ownership, the M3 shape. Every run captures this and re-reads it between
     * bands and again before anything is shown or saved; a run whose generation
     * has moved publishes nothing.
     */
    const generationRef = useRef(0);

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
            // At the point of use rather than module scope. This module already
            // pointed at the local worker, so nothing about which file is
            // fetched changes -- what changes is that it no longer depends on
            // this module's assignment being the last one to run.
            configurePdfWorker();
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
    /**
     * Everything the engine needs, gathered in one place.
     *
     * The three presentations differ in which pages they ask for and nothing
     * else. They used to differ in render scale as well — the preview capped,
     * the export capped differently, the change report not at all — which is
     * how they came to disagree about what a comparison meant.
     */
    const buildJob = useCallback((pages: number[]): {
        members: MemberSource[];
        settings: ComparisonSettings;
    } => ({
        members: activeIndices.map((i) => ({
            slot: i,
            label: files[i]?.name ?? SLOTS[i].name,
            pdf: pdfs[i]!,
            color: SLOTS[i].rgb,
        })),
        settings: {
            pages,
            dpi,
            toleranceMm,
            memoryBudgetBytes,
            matchColor: hexToRgb(matchColor),
            matchOpacity,
        },
    }), [activeIndices, files, pdfs, dpi, toleranceMm, memoryBudgetBytes, matchColor, matchOpacity]);

    /** A run that has been superseded may not draw, save, or report. */
    const signalFor = (token: number) => ({
        isCancelled: () => token !== generationRef.current,
        isOwner: () => token === generationRef.current,
    });

    const paintToCanvas = (pair: PairResult) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = pair.width;
        canvas.height = pair.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.putImageData(new ImageData(pair.pixels, pair.width, pair.height), 0, 0);
        // Zoom is display only. It used to change the render scale, which made
        // the preview a different comparison from the export.
        canvas.style.width = `${(pair.width * scale) / (dpi / 72)}px`;
        canvas.style.height = `${(pair.height * scale) / (dpi / 72)}px`;
    };

    useEffect(() => {
        const token = generationRef.current + 1;
        generationRef.current = token;

        const clear = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 1;
            canvas.height = 1;
        };

        if (activeIndices.length < 2) {
            setResult(null);
            clear();
            return;
        }

        const timer = setTimeout(() => {
            void (async () => {
                setBusy(true);
                try {
                    const { members, settings } = buildJob([pageNumber]);
                    const plan = await planComparison(members, settings);
                    if (token !== generationRef.current) return;
                    setRefusal(plan.refusal);
                    if (plan.refusal) { setResult(null); clear(); return; }
                    const run = await runComparison(plan, members, signalFor(token));
                    if (token !== generationRef.current || run.abandoned) return;
                    setResult(run);
                    const pairs = run.pages[0]?.pairs ?? [];
                    if (pairs.length === 0) {
                        clear();
                    } else {
                        const index = Math.min(activePair, pairs.length - 1);
                        paintToCanvas(pairs[index]);
                    }
                } catch (err) {
                    console.error('Comparison failed:', err);
                } finally {
                    if (token === generationRef.current) setBusy(false);
                }
            })();
        }, 300);

        return () => {
            clearTimeout(timer);
            // Bumping the generation is what makes an in-flight run stop: it
            // reads this between bands, and again before it would publish.
            generationRef.current += 1;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pdfs, visible, pageNumber, dpi, toleranceMm, memoryBudgetBytes, matchColor, matchOpacity]);

    // Re-paint when the user picks a different pair, without re-comparing.
    useEffect(() => {
        const pairs = result?.pages[0]?.pairs ?? [];
        if (pairs.length === 0) return;
        paintToCanvas(pairs[Math.min(activePair, pairs.length - 1)]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePair, result, scale]);

    /** The pages the user asked for, in order, without inventing any. */
    const requestedPages = (): number[] => {
        if (exportScope === 'all') {
            return Array.from({ length: numPages }, (_, i) => i + 1);
        }
        if (exportScope === 'current') return [pageNumber];
        const unique = new Set<number>();
        exportRange.split(',').map((part) => part.trim()).forEach((part) => {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(Number);
                if (!Number.isNaN(start) && !Number.isNaN(end)) {
                    for (let k = Math.min(start, end); k <= Math.max(start, end); k += 1) {
                        if (k >= 1 && k <= numPages) unique.add(k);
                    }
                }
            } else {
                const p = Number(part);
                if (!Number.isNaN(p) && p >= 1 && p <= numPages) unique.add(p);
            }
        });
        return Array.from(unique).sort((a, b) => a - b);
    };

    /**
     * Plan, refuse or run — the same three steps for every presentation.
     *
     * A refusal returns null and leaves the reason on screen. Nothing here
     * reduces the DPI, the tolerance, the page range or the member count to
     * make a job fit: the user is told what does not fit and decides.
     */
    const planAndRun = async (pages: number[]): Promise<JobResult | null> => {
        const token = generationRef.current + 1;
        generationRef.current = token;
        const { members, settings } = buildJob(pages);
        const plan = await planComparison(members, settings);
        if (plan.refusal) {
            setRefusal(plan.refusal);
            return null;
        }
        setRefusal(null);
        const run = await runComparison(
            plan, members, signalFor(token),
            (done, total) => setExportingProgress({ current: done, total }),
        );
        if (run.abandoned || token !== generationRef.current) return null;
        if (run.status === PLAN.RENDER_FAILED) {
            setRefusal({
                status: PLAN.RENDER_FAILED,
                reason: run.pages.find((p) => p.status === PLAN.RENDER_FAILED)
                    ?.reported[0] ?? 'ページを描画できませんでした。',
            });
            return null;
        }
        return run;
    };

    /** A canvas holding one pair's visual, for cropping or embedding. */
    const canvasOf = (pair: PairResult): HTMLCanvasElement => {
        const canvas = document.createElement('canvas');
        canvas.width = pair.width;
        canvas.height = pair.height;
        canvas.getContext('2d')!
            .putImageData(new ImageData(pair.pixels, pair.width, pair.height), 0, 0);
        return canvas;
    };

    // Handle PDF Download
    const handleDownload = async () => {
        if (activeIndices.length < 2) {
            alert('比較するPDFが2つ以上必要です');
            return;
        }
        const pages = requestedPages();
        if (pages.length === 0) {
            alert('出力するページが選択されていません');
            return;
        }

        setBusy(true);
        setExportingProgress({ current: 0, total: pages.length });
        try {
            const run = await planAndRun(pages);
            if (!run) return;

            const doc = new jsPDF({
                orientation: 'portrait', unit: 'px', hotfixes: ['px_scaling'],
            });
            doc.deletePage(1);

            // Source page order, then slot order. The same ordering in every
            // artifact, so a reader can find a pair without counting.
            for (const page of run.pages) {
                if (page.status !== PLAN.READY_TO_COMPARE) {
                    doc.addPage([595, 842], 'portrait');
                    doc.setFontSize(14);
                    doc.text(`Page ${page.page}`, 40, 60);
                    doc.setFontSize(10);
                    page.reported.forEach((line, i) => doc.text(line, 40, 90 + i * 18));
                    continue;
                }
                for (const pair of page.pairs) {
                    const logicalW = pair.width / run.plan.renderScale;
                    const logicalH = pair.height / run.plan.renderScale;
                    doc.addPage(
                        [logicalW, logicalH],
                        logicalW > logicalH ? 'landscape' : 'portrait',
                    );
                    doc.addImage(
                        encodePngStored(pair.pixels, pair.width, pair.height),
                        'PNG', 0, 0, logicalW, logicalH,
                    );
                    doc.setFontSize(9);
                    doc.text(`${pair.title} — ${pair.verdict}`, 8, 14);
                }
            }

            // Ownership once more, immediately before the bytes leave: a run
            // superseded while the container was assembled publishes nothing.
            if (!signalFor(generationRef.current).isOwner()) return;
            const baseName = files[activeIndices[0]]?.name.replace(/\.pdf$/i, '') ?? 'comparison';
            doc.save(`comparison_${baseName}_${dpi}dpi.pdf`);
        } catch (error) {
            console.error('Export failed', error);
            alert('エクスポートに失敗しました: ' + (error as Error).message);
        } finally {
            setExportingProgress(null);
            setBusy(false);
        }
    };

    const generateChangeReport = async () => {
        if (activeIndices.length < 2) {
            alert('比較するPDFが2つ以上必要です');
            return;
        }
        setBusy(true);
        try {
            const run = await planAndRun(
                Array.from({ length: numPages }, (_, i) => i + 1),
            );
            if (!run) return;

            const report = new jsPDF();
            let first = true;
            let changes = 0;
            const newPage = () => {
                if (!first) report.addPage();
                first = false;
            };

            for (const page of run.pages) {
                if (page.status !== PLAN.READY_TO_COMPARE) {
                    // A page one document does not have stays in the report.
                    // Dropping it would lose it silently, which is the failure
                    // this whole contract exists to prevent.
                    newPage();
                    report.setFontSize(12);
                    report.text(`Page ${page.page} — ${page.status}`, 10, 20);
                    report.setFontSize(9);
                    page.reported.forEach((line, i) => report.text(line, 10, 32 + i * 8));
                    continue;
                }
                for (const pair of page.pairs) {
                    if (pair.verdict !== RESULT.CHANGE || !pair.bounds) continue;
                    changes += 1;
                    const source = canvasOf(pair);
                    const crop = document.createElement('canvas');
                    crop.width = pair.bounds.width;
                    crop.height = pair.bounds.height;
                    crop.getContext('2d')!.drawImage(
                        source,
                        pair.bounds.x, pair.bounds.y, pair.bounds.width, pair.bounds.height,
                        0, 0, pair.bounds.width, pair.bounds.height,
                    );
                    source.width = 1;
                    source.height = 1;

                    newPage();
                    const pdfWidth = report.internal.pageSize.getWidth() - 20;
                    const pdfHeight = pdfWidth * (pair.bounds.height / pair.bounds.width);
                    report.addImage(
                        encodePngStored(
                            crop.getContext('2d')!
                                .getImageData(0, 0, crop.width, crop.height).data,
                            crop.width, crop.height,
                        ),
                        'PNG', 10, 20, pdfWidth, pdfHeight,
                    );
                    report.setFontSize(10);
                    report.text(pair.title, 10, 14);
                    report.text(
                        `変更あり（位置: x=${pair.bounds.x}, y=${pair.bounds.y}）`,
                        10, pdfHeight + 30,
                    );
                    crop.width = 1;
                    crop.height = 1;
                }
            }

            if (first) {
                alert('変更箇所が検出されませんでした');
                return;
            }
            if (!signalFor(generationRef.current).isOwner()) return;
            report.save('change_report.pdf');
            alert(`レポート生成完了: ${changes} 件の変更を検出しました`);
        } catch (error) {
            console.error('Report generation error:', error);
            alert('レポート生成に失敗しました: ' + (error as Error).message);
        } finally {
            setBusy(false);
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



                    {/* Spatial tolerance, in the unit a drawing office uses.
                        Zero is the default and is always selectable; anything
                        above it is a choice the user made, with the cost said
                        out loud rather than implied. */}
                    <div className="tolerance-control" data-usage-target="comparator-tolerance" style={{
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
                            <label style={{ fontSize: '0.8em', fontWeight: 'bold' }}>許容値</label>
                            <div style={{ fontSize: '0.7em', color: '#666' }}>
                                同じ位置とみなす距離
                            </div>
                        </div>
                        <input
                            type="range"
                            aria-label="許容値 (mm)"
                            data-testid="tolerance-slider"
                            min={SPATIAL_TOLERANCE_POLICY.minimum}
                            max={SPATIAL_TOLERANCE_POLICY.maximum}
                            step={SPATIAL_TOLERANCE_POLICY.step}
                            value={toleranceMm}
                            onChange={(e) => setToleranceMm(parseFloat(e.target.value))}
                            style={{ cursor: 'pointer' }}
                        />
                        <div style={{
                            fontSize: '1.1em',
                            fontWeight: 'bold',
                            width: '60px',
                            textAlign: 'center',
                            color: toleranceMm === 0 ? '#00796b' : '#b26a00'
                        }} data-testid="tolerance-value">
                            {toleranceMm.toFixed(2)} mm
                        </div>
                    </div>
                    {toleranceMm > 0 && (
                        <div data-testid="tolerance-warning" style={{
                            fontSize: '0.72em',
                            color: '#8a5300',
                            background: '#fff4e0',
                            border: '1px solid #ffd699',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            maxWidth: '320px',
                            lineHeight: 1.4
                        }}>
                            {SPATIAL_TOLERANCE_DISCLOSURE}
                        </div>
                    )}



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

                                {/* Memory budget. 512 MiB is the recommendation
                                    and the default; a larger one is available
                                    and is never chosen automatically. */}
                                <div style={{ marginBottom: '5px' }}>
                                    <label style={{ display: 'block', fontSize: '0.75em', fontWeight: 'bold', marginBottom: '4px', color: '#666' }}>
                                        Memory budget
                                    </label>
                                    <select
                                        data-testid="memory-budget"
                                        aria-label="メモリ上限"
                                        value={memoryBudgetBytes}
                                        onChange={(e) => setMemoryBudgetBytes(Number(e.target.value))}
                                        style={{ width: '100%', padding: '4px', fontSize: '0.85em', color: '#333', backgroundColor: 'white' }}
                                    >
                                        {MEMORY_BUDGET_PRESETS.map((preset) => (
                                            <option key={preset.bytes} value={preset.bytes}>
                                                {preset.label}
                                            </option>
                                        ))}
                                    </select>
                                    <div style={{ fontSize: '0.7em', color: '#888', marginTop: '4px' }}>
                                        現在: {formatBytes(memoryBudgetBytes)}
                                    </div>
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
                {/* The comparison could not be made, and why. Nothing here
                    quietly reduces the request to something that would fit:
                    the numbers are shown and the choice is the user's. */}
                {refusal && (
                    <div data-testid="preflight-refusal" style={{
                        maxWidth: '560px',
                        margin: '40px auto',
                        padding: '16px 20px',
                        border: '1px solid #e0b4b4',
                        background: '#fff6f6',
                        borderRadius: '8px',
                        color: '#7a2222',
                        lineHeight: 1.6,
                    }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
                            この設定では比較できません
                        </div>
                        <div data-testid="refusal-status" style={{
                            fontFamily: 'monospace', fontSize: '0.8em', color: '#a33',
                        }}>
                            {refusal.status}
                        </div>
                        <div style={{ marginTop: '8px' }}>{refusal.reason}</div>
                        {refusal.requested && (
                            <div style={{ fontSize: '0.85em', marginTop: '6px' }}>
                                要求: {refusal.requested}
                            </div>
                        )}
                        {refusal.achievable && (
                            <div style={{ fontSize: '0.85em', marginTop: '2px' }}>
                                実行可能: {refusal.achievable}
                            </div>
                        )}
                        <div style={{ fontSize: '0.8em', marginTop: '10px', color: '#666' }}>
                            設定を変更すると再計画します。自動では変更しません。
                        </div>
                    </div>
                )}

                {/* Which pair is on screen. With four members a reader has to
                    be able to tell which document differs from the reference,
                    not merely that something does. */}
                {!refusal && (result?.pages[0]?.pairs.length ?? 0) > 0 && (
                    <div data-testid="pair-tabs" style={{
                        display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap',
                    }}>
                        {result!.pages[0].pairs.map((pair, index) => (
                            <button
                                key={pair.title}
                                data-testid={`pair-tab-${index}`}
                                onClick={() => setActivePair(index)}
                                style={{
                                    fontSize: '0.8em',
                                    padding: '4px 10px',
                                    borderRadius: '14px',
                                    border: index === activePair
                                        ? '2px solid #00796b' : '1px solid #ccc',
                                    background: index === activePair ? '#e0f2f1' : 'white',
                                    color: '#333',
                                    cursor: 'pointer',
                                }}
                            >
                                {pair.referenceLabel} vs {pair.label}
                                <span style={{
                                    marginLeft: '6px',
                                    fontWeight: 'bold',
                                    color: pair.verdict === RESULT.CHANGE ? '#c62828' : '#2e7d32',
                                }}>
                                    {pair.verdict}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {/* A page one document does not have is a different state from
                    a page that exists and is blank, and from a page that
                    matched. It says so. */}
                {!refusal && result && result.pages[0]
                    && result.pages[0].status !== PLAN.READY_TO_COMPARE && (
                    <div data-testid="page-state" style={{
                        maxWidth: '560px',
                        margin: '40px auto',
                        padding: '16px 20px',
                        border: '1px solid #d6c48a',
                        background: '#fffbe9',
                        borderRadius: '8px',
                        color: '#6b5400',
                        lineHeight: 1.6,
                    }}>
                        <div data-testid="page-state-status" style={{
                            fontFamily: 'monospace', fontSize: '0.8em',
                        }}>
                            {result.pages[0].status}
                        </div>
                        {result.pages[0].reported.map((line) => (
                            <div key={line} style={{ marginTop: '6px' }}>{line}</div>
                        ))}
                    </div>
                )}

                {/* Canvas */}
                <canvas
                    ref={canvasRef}
                    data-testid="comparator-canvas"
                    style={{
                        boxShadow: '0 0 10px rgba(0,0,0,0.1)',
                        background: 'white',
                        display: refusal || (result?.pages[0]?.pairs.length ?? 0) === 0
                            ? 'none' : 'block',
                    }}
                />
                {busy && (
                    <div data-testid="comparator-busy" style={{
                        fontSize: '0.8em', color: '#888', marginTop: '8px',
                    }}>
                        比較中...
                    </div>
                )}

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
