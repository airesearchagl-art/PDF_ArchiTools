import React, { useCallback, useEffect, useRef, useState } from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import { AlertTriangle, Check, Download, Loader, Trash2 } from 'lucide-react';

import {
    analysePageGeometry, buildWorkbook, canvasRectToUpright, reconstructSelection,
    sheetNameFor, workbookFileName, STATUS_LABEL, XLSX_MIME,
} from '../utils/pdf-textifier';
import type {
    ConfirmedTable, PageGeometry, SelectionRect, TableCandidate,
} from '../utils/pdf-textifier';

/**
 * Native table -> Excel.
 *
 * The shape of this screen is the safety argument, not a layout preference.
 * Structure confidence says a grid holds together; it says nothing about
 * whether the thing selected was a schedule -- a title block, a legend and two
 * columns of notes all produce sound grids, because structurally they are
 * grids. So there is no path from a reconstruction to a file that does not pass
 * through a person looking at it and saying yes.
 */

/** Width the page is rendered at. Big enough to drag on accurately. */
const RENDER_WIDTH = 720;

interface Props {
    file: File;
    doc: pdfjsLib.PDFDocumentProxy;
}

interface DragState {
    startX: number;
    startY: number;
    x: number;
    y: number;
}

const rectOf = (drag: DragState): SelectionRect => ({
    left: Math.min(drag.startX, drag.x),
    top: Math.min(drag.startY, drag.y),
    right: Math.max(drag.startX, drag.x),
    bottom: Math.max(drag.startY, drag.y),
});

export const ExcelTableExporter: React.FC<Props> = ({ file, doc }) => {
    const [pageNumber, setPageNumber] = useState(1);
    const [geometry, setGeometry] = useState<PageGeometry | null>(null);
    const [scale, setScale] = useState(1);
    const [analysing, setAnalysing] = useState(false);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [selection, setSelection] = useState<SelectionRect | null>(null);
    const [candidate, setCandidate] = useState<TableCandidate | null>(null);
    const [draft, setDraft] = useState<string[][] | null>(null);
    const [confirmed, setConfirmed] = useState<ConfirmedTable[]>([]);
    const [workbookUrl, setWorkbookUrl] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    /**
     * Which analysis the screen is currently interested in.
     *
     * Every asynchronous step captures this and checks it before writing any
     * state back. A reconstruction that finishes after the user has moved to
     * another page or drawn another rectangle must not overwrite what is on
     * screen now -- a late result silently replacing a newer one is the kind of
     * bug that shows the wrong table under the right heading.
     */
    const runId = useRef(0);

    const dropWorkbook = useCallback(() => {
        setWorkbookUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return null;
        });
    }, []);

    /** Anything that changes what is being looked at invalidates the proposal. */
    const clearProposal = useCallback(() => {
        runId.current++;
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setError(null);
    }, []);

    // A new file means nothing that came before it is still true.
    useEffect(() => {
        runId.current++;
        setPageNumber(1);
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setConfirmed([]);
        setError(null);
        dropWorkbook();
    }, [doc, dropWorkbook]);

    useEffect(() => () => dropWorkbook(), [dropWorkbook]);

    // Render the page and read its geometry.
    useEffect(() => {
        const id = ++runId.current;
        let abandoned = false;
        setAnalysing(true);
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setError(null);

        (async () => {
            try {
                const page = await doc.getPage(pageNumber);
                const base = page.getViewport({ scale: 1 });
                const renderScale = RENDER_WIDTH / base.width;
                const viewport = page.getViewport({ scale: renderScale });
                const canvas = canvasRef.current;
                if (canvas) {
                    canvas.width = Math.ceil(viewport.width);
                    canvas.height = Math.ceil(viewport.height);
                    const ctx = canvas.getContext('2d');
                    if (ctx) await page.render({ canvas, viewport, intent: 'print' }).promise;
                }
                page.cleanup();
                const analysed = await analysePageGeometry(doc, pageNumber);
                if (abandoned || runId.current !== id) return;
                setScale(renderScale);
                setGeometry(analysed);
            } catch (err) {
                if (abandoned || runId.current !== id) return;
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!abandoned && runId.current === id) setAnalysing(false);
            }
        })();

        return () => { abandoned = true; };
    }, [doc, pageNumber]);

    const pointIn = (event: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const box = canvas.getBoundingClientRect();
        return {
            x: ((event.clientX - box.left) / box.width) * canvas.width,
            y: ((event.clientY - box.top) / box.height) * canvas.height,
        };
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!geometry || geometry.scanned) return;
        const p = pointIn(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        clearProposal();
        setDrag({ startX: p.x, startY: p.y, x: p.x, y: p.y });
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drag) return;
        const p = pointIn(event);
        setDrag({ ...drag, x: p.x, y: p.y });
    };

    const handlePointerUp = async (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drag || !geometry) return;
        const canvasRect = rectOf(drag);
        setDrag(null);
        // A click rather than a drag: nothing was selected.
        if (canvasRect.right - canvasRect.left < 8 || canvasRect.bottom - canvasRect.top < 8) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);

        const id = ++runId.current;
        const upright = canvasRectToUpright(canvasRect, scale, geometry);
        setSelection(canvasRect);
        setBusy(true);
        try {
            const result = await reconstructSelection(geometry, upright, {
                shouldCancel: () => runId.current !== id,
            });
            if (runId.current !== id) return;
            setCandidate(result);
            setDraft(result.grid.length ? result.grid.map((row) => [...row]) : null);
        } catch (err) {
            if (runId.current !== id) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (runId.current === id) setBusy(false);
        }
    };

    /**
     * Editing the proposal.
     *
     * The draft is what gets confirmed, so what the user typed is what reaches
     * the workbook. A cell cleared here stays cleared: an empty cell in a
     * schedule is information, and filling it back in would be inventing data.
     */
    const editCell = (row: number, col: number, value: string) => {
        setDraft((previous) => {
            if (!previous) return previous;
            const next = previous.map((r) => [...r]);
            next[row][col] = value;
            return next;
        });
        // The workbook on disk no longer matches what is on screen.
        dropWorkbook();
    };

    const confirmTable = () => {
        if (!candidate || !draft || !geometry) return;
        const taken = confirmed.map((t) => t.sheetName);
        const table: ConfirmedTable = {
            id: `${geometry.pageNumber}-${confirmed.length}-${Date.now()}`,
            pageNumber: geometry.pageNumber,
            sheetName: sheetNameFor(geometry.pageNumber, confirmed.length, taken),
            rows: draft.length,
            cols: draft[0]?.length ?? 0,
            // A snapshot. Editing the preview afterwards edits a new proposal,
            // never this: a confirmed table cannot change under the user.
            grid: draft.map((row) => [...row]),
            source: candidate.source,
            status: candidate.status,
            structureScore: candidate.structureScore,
        };
        setConfirmed((previous) => [...previous, table]);
        setCandidate(null);
        setDraft(null);
        setSelection(null);
        dropWorkbook();
    };

    const removeTable = (id: string) => {
        setConfirmed((previous) => previous.filter((t) => t.id !== id));
        dropWorkbook();
    };

    const exportWorkbook = async () => {
        if (!confirmed.length) return;
        setBusy(true);
        setError(null);
        try {
            const built = await buildWorkbook(confirmed);
            const blob = new Blob([built.bytes as BlobPart], { type: XLSX_MIME });
            dropWorkbook();
            setWorkbookUrl(URL.createObjectURL(blob));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const unsupported = geometry?.scanned === true;
    const canConfirm = Boolean(candidate && draft
        && (candidate.status === 'GRID_CONFIDENT' || candidate.status === 'GRID_NEEDS_REVIEW'));

    return (
        <div data-usage-target="excel-workflow" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

            {/* Page navigation */}
            <div data-usage-target="excel-page-nav" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                    type="button"
                    aria-label="前のページ"
                    onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
                    disabled={pageNumber <= 1 || analysing}
                    style={navButton(pageNumber <= 1 || analysing)}
                >前のページ</button>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {pageNumber} / {doc.numPages} ページ
                </span>
                <button
                    type="button"
                    aria-label="次のページ"
                    onClick={() => setPageNumber((n) => Math.min(doc.numPages, n + 1))}
                    disabled={pageNumber >= doc.numPages || analysing}
                    style={navButton(pageNumber >= doc.numPages || analysing)}
                >次のページ</button>
                {analysing && <span style={{ color: '#666', display: 'flex', alignItems: 'center', gap: '6px' }}><Loader size={14} className="spin" /> 解析中…</span>}
            </div>

            {/* The page, and the rectangle drawn on it */}
            <div style={{ position: 'relative', alignSelf: 'flex-start', border: '1px solid #ddd', lineHeight: 0 }}>
                <canvas
                    ref={canvasRef}
                    data-usage-target="excel-page-canvas"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    style={{
                        maxWidth: '100%',
                        touchAction: 'none',
                        cursor: unsupported ? 'not-allowed' : 'crosshair',
                    }}
                />
                {(drag || selection) && (
                    <div
                        aria-hidden="true"
                        style={{
                            position: 'absolute',
                            border: '2px solid #4a90e2',
                            background: 'rgba(74,144,226,0.12)',
                            pointerEvents: 'none',
                            ...boxStyle(drag ? rectOf(drag) : selection!, canvasRef.current),
                        }}
                    />
                )}
            </div>

            {unsupported && (
                <div data-usage-target="excel-scanned-notice" role="status" style={noticeStyle('#fff4e5', '#e8a33d')}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>
                        このページは画像PDFのため、現在のExcel表抽出には対応していません。
                        OCRによる表抽出は今後の対応予定です。文字情報のあるページを選択してください。
                    </span>
                </div>
            )}

            {!unsupported && !candidate && !busy && (
                <p style={{ color: '#666', margin: 0, fontSize: '0.9rem' }}>
                    ページ上で表の範囲をドラッグしてください。罫線のある表は、範囲が多少ずれていても罫線に合わせて調整されます。
                </p>
            )}

            {busy && <p style={{ color: '#666', margin: 0 }}>解析中…</p>}

            {/* The proposal */}
            {candidate && (
                <div data-usage-target="excel-preview" style={{ border: '1px solid #eee', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <strong>表構造候補</strong>
                        <span style={{
                            padding: '2px 8px', borderRadius: '10px', fontSize: '0.8rem',
                            border: '1px solid #bbb', background: '#f5f5f5',
                        }}>{STATUS_LABEL[candidate.status]}</span>
                        {candidate.rows > 0 && (
                            <span style={{ color: '#666', fontSize: '0.85rem' }}>
                                {candidate.rows} 行 × {candidate.cols} 列
                                {candidate.source === 'ruling' ? '（罫線から復元）' : '（文字位置から復元）'}
                            </span>
                        )}
                    </div>

                    {candidate.message && (
                        <div role="status" style={noticeStyle('#fff4e5', '#e8a33d')}>
                            <AlertTriangle size={16} aria-hidden="true" />
                            <span>{candidate.message}</span>
                        </div>
                    )}

                    {draft && (
                        <>
                            <div data-usage-target="excel-confirm-warning" role="note" style={noticeStyle('#eef4ff', '#4a90e2')}>
                                <AlertTriangle size={16} aria-hidden="true" />
                                <span>
                                    内容の意味は自動判定していません。Excel出力前にセル内容を確認してください。
                                </span>
                            </div>

                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                    <tbody>
                                        {draft.map((row, r) => (
                                            <tr key={r}>
                                                {row.map((cell, c) => (
                                                    <td key={c} style={{ border: '1px solid #ddd', padding: 0 }}>
                                                        <textarea
                                                            aria-label={`${r + 1} 行 ${c + 1} 列`}
                                                            data-cell={`${r},${c}`}
                                                            value={cell}
                                                            onChange={(e) => editCell(r, c, e.target.value)}
                                                            rows={1}
                                                            style={{
                                                                border: 'none', width: '120px', minHeight: '28px',
                                                                padding: '4px 6px', font: 'inherit', resize: 'vertical',
                                                                background: 'transparent',
                                                            }}
                                                        />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    data-usage-target="excel-confirm"
                                    onClick={confirmTable}
                                    disabled={!canConfirm}
                                    style={primaryButton(!canConfirm)}
                                >
                                    <Check size={16} aria-hidden="true" /> 内容を確認してこの表を確定
                                </button>
                                <button type="button" onClick={clearProposal} style={navButton(false)}>
                                    範囲を選び直す
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Confirmed tables, and only these reach the workbook */}
            <div data-usage-target="excel-confirmed" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <strong>確定した表: {confirmed.length}</strong>
                {confirmed.length === 0 && (
                    <span style={{ color: '#666', fontSize: '0.9rem' }}>
                        表を確定するとExcelへ書き出せます。確定前にダウンロードはできません。
                    </span>
                )}
                {confirmed.map((t) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid #eee', borderRadius: '6px', padding: '8px 12px' }}>
                        <span style={{ fontWeight: 500 }}>{t.sheetName}</span>
                        <span style={{ color: '#666', fontSize: '0.85rem' }}>
                            {t.pageNumber} ページ / {t.rows} 行 × {t.cols} 列
                        </span>
                        <button
                            type="button"
                            aria-label={`${t.sheetName} を削除`}
                            onClick={() => removeTable(t.id)}
                            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', display: 'flex', alignItems: 'center', gap: '4px' }}
                        >
                            <Trash2 size={14} aria-hidden="true" /> 削除
                        </button>
                    </div>
                ))}

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        data-usage-target="excel-export"
                        onClick={exportWorkbook}
                        disabled={confirmed.length === 0 || busy}
                        style={primaryButton(confirmed.length === 0 || busy)}
                    >
                        Excelを書き出す
                    </button>
                    {workbookUrl && (
                        <a
                            data-usage-target="excel-download"
                            href={workbookUrl}
                            download={workbookFileName(file.name)}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '8px',
                                padding: '10px 20px', borderRadius: '6px',
                                background: '#27ae60', color: 'white', textDecoration: 'none',
                            }}
                        >
                            <Download size={16} aria-hidden="true" /> {workbookFileName(file.name)}
                        </a>
                    )}
                </div>

                <span style={{ color: '#666', fontSize: '0.8rem' }}>
                    すべての値はテキストとして書き出されます。空白セルは空白のまま保持し、結合セルは復元しません。
                </span>
            </div>

            {error && (
                <div role="alert" style={noticeStyle('#fdecea', '#c0392b')}>
                    <AlertTriangle size={16} aria-hidden="true" /> <span>{error}</span>
                </div>
            )}
        </div>
    );
};

/** The overlay is positioned in the canvas's displayed size, not its pixels. */
function boxStyle(rect: SelectionRect, canvas: HTMLCanvasElement | null): React.CSSProperties {
    if (!canvas || !canvas.width || !canvas.height) return { display: 'none' };
    const ratio = canvas.clientWidth ? canvas.clientWidth / canvas.width : 1;
    return {
        left: `${rect.left * ratio}px`,
        top: `${rect.top * ratio}px`,
        width: `${(rect.right - rect.left) * ratio}px`,
        height: `${(rect.bottom - rect.top) * ratio}px`,
    };
}

/** Status is carried by an icon and words, never by colour alone. */
function noticeStyle(background: string, border: string): React.CSSProperties {
    return {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 14px', borderRadius: '6px',
        background, border: `1px solid ${border}`,
        fontSize: '0.9rem',
    };
}

function navButton(disabled: boolean): React.CSSProperties {
    return {
        padding: '6px 14px', borderRadius: '6px', border: '1px solid #ccc',
        background: disabled ? '#f0f0f0' : 'white',
        color: disabled ? '#999' : '#333',
        cursor: disabled ? 'not-allowed' : 'pointer',
    };
}

function primaryButton(disabled: boolean): React.CSSProperties {
    return {
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '10px 20px', borderRadius: '6px', border: 'none',
        background: disabled ? '#ccc' : '#4a90e2', color: 'white',
        cursor: disabled ? 'not-allowed' : 'pointer',
    };
}
