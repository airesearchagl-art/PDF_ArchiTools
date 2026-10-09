import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { Sheet, Source } from '../../utils/drawing-set/model';
import type { PreviewCounts, PreviewDocumentOwner } from '../../utils/drawing-set/preview-document';
import { PreviewError } from '../../utils/drawing-set/preview-document';

/**
 * The Drawing Set's read-only viewer: one selected page, drawn on one canvas.
 *
 * Nothing here can change a file. There is no annotation, text layer, editing,
 * saving or download, by construction rather than by hiding buttons. A render
 * that is no longer wanted -- the Sheet, the zoom, the Source or the size of
 * the pane changed, or the viewer went away -- is cancelled, and a cancelled
 * render publishes nothing. The workspace mounts one viewer per Source (keyed
 * by its id), so nothing a viewer holds can outlive the Source it was for.
 */

interface Props {
    owner: PreviewDocumentOwner;
    source: Source;
    file: File;
    sheet: Sheet;
    pageTotal: number;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
/** Canvas bounds, so a large sheet at a high zoom cannot ask for an unbounded bitmap. */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 16_777_216;
const PANE_PADDING = 24;

type DocState =
    | { sourceId: string; doc: PDFDocumentProxy }
    | { sourceId: string; error: string };

type RenderState = { key: string; status: 'rendered' | 'error'; message?: string; counts: PreviewCounts };

export const ReadOnlySheetViewer: React.FC<Props> = ({ owner, source, file, sheet, pageTotal }) => {
    const paneRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [zoom, setZoom] = useState(1);
    const [pane, setPane] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [docState, setDocState] = useState<DocState | null>(null);
    const [render, setRender] = useState<RenderState | null>(null);

    // The pane's size decides the "whole page" scale.
    useEffect(() => {
        const element = paneRef.current;
        if (!element) return;
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (!box) return;
            const width = Math.floor(box.width);
            const height = Math.floor(box.height);
            setPane((current) => (current.width === width && current.height === height ? current : { width, height }));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // The Source's document: the owner keeps at most one open.
    const sourceId = source.id;
    const expectedBytes = source.fingerprint.byteLength;
    const expectedSha256 = source.fingerprint.sha256;
    useEffect(() => {
        let alive = true;
        owner.open(sourceId, file, { sha256: expectedSha256, byteLength: expectedBytes }).then(
            (doc) => { if (alive) setDocState({ sourceId, doc }); },
            (error: unknown) => {
                if (!alive || (error instanceof PreviewError && error.code === 'CLOSED')) return;
                setDocState({ sourceId, error: error instanceof Error ? error.message : 'このページを表示できませんでした。' });
            },
        );
        return () => { alive = false; };
    }, [owner, sourceId, file, expectedBytes, expectedSha256]);

    // A document destroyed by its owner is never drawn from.
    const doc = docState && docState.sourceId === sourceId && 'doc' in docState && !docState.doc.loadingTask.destroyed
        ? docState.doc
        : null;
    const openError = docState && docState.sourceId === sourceId && 'error' in docState ? docState.error : null;
    const pageNumber = sheet.pageNumber;
    const renderKey = `${sheet.id}|${zoom}|${pane.width}x${pane.height}`;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!doc || !canvas || pane.width <= 0 || pane.height <= 0) return;
        let cancelled = false;
        let task: RenderTask | null = null;
        let page: PDFPageProxy | null = null;
        (async () => {
            try {
                page = await doc.getPage(pageNumber);
                if (cancelled) return;
                const whole = page.getViewport({ scale: 1 });
                const fit = Math.max(0.01, Math.min(
                    (pane.width - PANE_PADDING) / whole.width,
                    (pane.height - PANE_PADDING) / whole.height,
                ));
                const cssScale = fit * zoom;
                const ratio = window.devicePixelRatio || 1;
                let scale = cssScale * ratio;
                const width = whole.width * scale;
                const height = whole.height * scale;
                scale *= Math.min(1, MAX_CANVAS_SIDE / Math.max(width, height), Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
                const viewport = page.getViewport({ scale });
                canvas.width = Math.max(1, Math.floor(viewport.width));
                canvas.height = Math.max(1, Math.floor(viewport.height));
                canvas.style.width = `${Math.round(whole.width * cssScale)}px`;
                canvas.style.height = `${Math.round(whole.height * cssScale)}px`;
                owner.noteRender('started');
                task = page.render({ canvas, viewport });
                await task.promise;
                if (cancelled) return;
                owner.noteRender('completed');
                setRender({ key: renderKey, status: 'rendered', counts: owner.counts() });
            } catch (error) {
                if (cancelled || (error as { name?: string })?.name === 'RenderingCancelledException') return;
                setRender({ key: renderKey, status: 'error', message: 'このページを表示できませんでした。', counts: owner.counts() });
            }
        })();
        return () => {
            cancelled = true;
            if (task) {
                task.cancel();
                owner.noteRender('cancelled');
            }
            page?.cleanup();
        };
    }, [doc, owner, pageNumber, zoom, pane.width, pane.height, renderKey]);

    const status: 'loading' | 'rendered' | 'error' = openError
        ? 'error'
        : render && render.key === renderKey
            ? render.status
            : 'loading';
    const message = openError ?? (status === 'error' ? render?.message : null);
    const counts = render?.counts;

    return (
        <div
            className="ds-viewer"
            data-ds-viewer
            data-ds-render-state={status}
            data-ds-preview-live={counts?.live ?? ''}
            data-ds-preview-opened={counts?.opened ?? ''}
            data-ds-preview-destroyed={counts?.destroyed ?? ''}
            data-ds-render-cancelled={counts?.renderCancelled ?? ''}
        >
            <div className="ds-viewer-toolbar">
                <span className="ds-viewer-label" title={source.displayName}>
                    {source.displayName} — {pageNumber} / {pageTotal} ページ
                </span>
                <span className="ds-viewer-zoom">
                    <button type="button" className="ds-icon-button" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} title="縮小" aria-label="縮小" data-ds-zoom-out>
                        <ZoomOut size={16} />
                    </button>
                    <span className="ds-zoom-value" data-ds-zoom-value>{Math.round(zoom * 100)}%</span>
                    <button type="button" className="ds-icon-button" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} title="拡大" aria-label="拡大" data-ds-zoom-in>
                        <ZoomIn size={16} />
                    </button>
                    <button type="button" className="ds-icon-button" onClick={() => setZoom(1)} disabled={zoom === 1} title="ページ全体を表示" aria-label="ページ全体を表示" data-ds-zoom-fit>
                        <Maximize size={16} />
                    </button>
                </span>
            </div>
            <div className="ds-viewer-pane" ref={paneRef}>
                <canvas
                    ref={canvasRef}
                    className="ds-viewer-canvas"
                    data-ds-rendered-sheet={status === 'rendered' ? sheet.id : ''}
                    style={{ visibility: status === 'rendered' ? 'visible' : 'hidden' }}
                />
                {status === 'loading' && <div className="ds-viewer-overlay">表示を準備しています…</div>}
                {status === 'error' && <div className="ds-viewer-overlay ds-viewer-error" role="alert">{message}</div>}
            </div>
        </div>
    );
};
