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
    const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

    /**
     * Three separate identities, because three separate jobs can be in flight.
     *
     * One counter for all of them looks tidier and is wrong: drawing a
     * rectangle would then invalidate the page analysis that the rectangle
     * needs, so the analysis would abandon itself, never clear `analysing`, and
     * leave the reconstruction to run against the previous page's geometry
     * while the canvas shows the new page.
     *
     * So each job owns its own generation and only ever checks its own. A job
     * that has been superseded publishes nothing at all -- not a result, not an
     * error, and not a cleared busy flag belonging to whatever replaced it.
     */
    const pageGeneration = useRef(0);
    const selectionGeneration = useRef(0);
    const workbookGeneration = useRef(0);

    /**
     * Who owns the busy flag.
     *
     * "Only the current operation clears busy" is half a rule, and the missing
     * half strands the screen: an export that is overtaken must not clear a
     * newer operation's flag, but if nothing newer took the flag then nobody
     * clears it and the screen stays busy for good. So the flag is owned. An
     * operation clears it only while it is still the owner, which is false
     * exactly when something newer has claimed it.
     */
    const busyOwner = useRef<string | null>(null);
    const claimBusy = useCallback((owner: string) => {
        busyOwner.current = owner;
        setBusy(true);
    }, []);
    const releaseBusy = useCallback((owner: string) => {
        if (busyOwner.current !== owner) return;
        busyOwner.current = null;
        setBusy(false);
    }, []);

    const dropWorkbook = useCallback(() => {
        setWorkbookUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return null;
        });
    }, []);

    /**
     * Drop the current proposal.
     *
     * Bumps the selection generation only. The page analysis is a different job
     * with a different lifetime, and invalidating it here is what used to leave
     * the screen loading forever.
     */
    const clearProposal = useCallback(() => {
        selectionGeneration.current++;
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setError(null);
    }, []);

    // A new file means nothing that came before it is still true.
    useEffect(() => {
        pageGeneration.current++;
        selectionGeneration.current++;
        workbookGeneration.current++;
        setPageNumber(1);
        setGeometry(null);
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setConfirmed([]);
        setError(null);
        dropWorkbook();
    }, [doc, dropWorkbook]);

    useEffect(() => () => dropWorkbook(), [dropWorkbook]);

    /**
     * Render the page and read its geometry.
     *
     * The geometry is cleared before the new page is read, not after. Keeping
     * the previous page's tokens on screen while the next page paints is how a
     * rectangle drawn during the transition ends up reconstructing the page the
     * user just left.
     */
    useEffect(() => {
        const id = ++pageGeneration.current;
        // Whatever was proposed belonged to the page being left.
        selectionGeneration.current++;
        setGeometry(null);
        setAnalysing(true);
        setSelection(null);
        setCandidate(null);
        setDraft(null);
        setError(null);

        (async () => {
            let page: pdfjsLib.PDFPageProxy | null = null;
            try {
                page = await doc.getPage(pageNumber);
                if (pageGeneration.current !== id) return;
                const base = page.getViewport({ scale: 1 });
                const renderScale = RENDER_WIDTH / base.width;
                const viewport = page.getViewport({ scale: renderScale });
                const canvas = canvasRef.current;
                if (canvas) {
                    // A render still running for the previous page would paint
                    // over this one after it had won. pdf.js can cancel it.
                    renderTaskRef.current?.cancel();
                    canvas.width = Math.ceil(viewport.width);
                    canvas.height = Math.ceil(viewport.height);
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        const task = page.render({ canvas, viewport, intent: 'print' });
                        renderTaskRef.current = task;
                        try {
                            await task.promise;
                        } finally {
                            if (renderTaskRef.current === task) renderTaskRef.current = null;
                        }
                    }
                }
                if (pageGeneration.current !== id) return;
                const analysed = await analysePageGeometry(doc, pageNumber);
                if (pageGeneration.current !== id) return;
                setScale(renderScale);
                setGeometry(analysed);
            } catch (err) {
                if (pageGeneration.current !== id) return;
                // A cancelled render is this effect being superseded, not a
                // failure worth putting on the screen.
                const message = err instanceof Error ? err.message : String(err);
                if (!/cancel/i.test(message)) setError(message);
            } finally {
                page?.cleanup();
                // Only the current analysis clears the flag. A superseded one
                // clearing it would announce that a page it no longer owns has
                // finished loading.
                if (pageGeneration.current === id) setAnalysing(false);
            }
        })();
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

    /**
     * Whether a rectangle may be started at all.
     *
     * The geometry has to exist, be finished loading, describe *this* page, and
     * be a page Excel supports. Checking only that geometry exists lets a drag
     * during a page transition reconstruct the previous page against the new
     * page's picture.
     */
    const selectable = Boolean(
        geometry && !analysing && !busy
        && geometry.pageNumber === pageNumber
        && !geometry.scanned,
    );

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!selectable || !geometry) return;
        const p = pointIn(event);
        // Capture is a convenience, not a requirement: a pointer that is
        // already gone makes this throw, and losing the drag is better than
        // taking the screen down with it.
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch { /* the pointer is no longer capturable */ }
        clearProposal();
        setDrag({ startX: p.x, startY: p.y, x: p.x, y: p.y });
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drag) return;
        const p = pointIn(event);
        setDrag({ ...drag, x: p.x, y: p.y });
    };

    const handlePointerUp = async (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drag) return;
        const canvasRect = rectOf(drag);
        setDrag(null);
        if (!selectable || !geometry) return;
        // A click rather than a drag: nothing was selected.
        if (canvasRect.right - canvasRect.left < 8 || canvasRect.bottom - canvasRect.top < 8) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);

        // The geometry this run is about, captured now. If the page changes
        // underneath, the page generation moves and this run publishes nothing.
        const target = geometry;
        const pageAtStart = pageGeneration.current;
        const id = ++selectionGeneration.current;
        const stale = () => selectionGeneration.current !== id || pageGeneration.current !== pageAtStart;

        const upright = canvasRectToUpright(canvasRect, scale, target);
        const owner = `selection:${id}`;
        setSelection(canvasRect);
        claimBusy(owner);
        try {
            const result = await reconstructSelection(target, upright, { shouldCancel: stale });
            if (stale()) return;
            setCandidate(result);
            setDraft(result.grid.length ? result.grid.map((row) => [...row]) : null);
        } catch (err) {
            if (stale()) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            releaseBusy(owner);
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
        workbookGeneration.current++;
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
        // The set the workbook would be built from has changed, so any export
        // already running is about a set that no longer exists.
        workbookGeneration.current++;
        dropWorkbook();
    };

    const removeTable = (id: string) => {
        setConfirmed((previous) => previous.filter((t) => t.id !== id));
        workbookGeneration.current++;
        dropWorkbook();
    };

    /**
     * Build the workbook from the tables confirmed *now*.
     *
     * Two things make this safe to run while the user keeps working. The set is
     * snapshotted before the await, so the file is built from an explicit list
     * rather than from whatever state happens to hold when it finishes. And the
     * run carries a generation: adding, removing or editing a confirmed table
     * moves it, and a run that has been overtaken publishes nothing -- no blob
     * URL, no error, and not a cleared busy flag belonging to a newer export.
     */
    const exportWorkbook = async () => {
        if (!confirmed.length) return;
        const snapshot = confirmed.map((table) => ({ ...table, grid: table.grid.map((row) => [...row]) }));
        const id = ++workbookGeneration.current;
        const stale = () => workbookGeneration.current !== id;

        const owner = `workbook:${id}`;
        claimBusy(owner);
        setError(null);
        try {
            const built = await buildWorkbook(snapshot, { shouldCancel: stale });
            if (stale()) return;
            const blob = new Blob([built.bytes as BlobPart], { type: XLSX_MIME });
            dropWorkbook();
            setWorkbookUrl(URL.createObjectURL(blob));
        } catch (err) {
            if (stale()) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            releaseBusy(owner);
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
                    // Which page the geometry under this canvas describes, and
                    // whether a rectangle may be drawn on it yet. Both are on
                    // the element so the state is legible from outside rather
                    // than only inferable from what happens next.
                    data-geometry-page={geometry?.pageNumber ?? ''}
                    data-selectable={selectable ? 'true' : 'false'}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    style={{
                        maxWidth: '100%',
                        touchAction: 'none',
                        cursor: selectable ? 'crosshair' : 'not-allowed',
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
