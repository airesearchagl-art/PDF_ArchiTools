import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Eye, Plus, Trash2 } from 'lucide-react';
import { MAX_RULES, orientationOf } from '../../utils/title-block-updater';
import type { PageOrientation, UpdateRule } from '../../utils/title-block-updater';

// The worker that ships in public/, matching what the Textifier uses.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

/** Longest edge of the preview raster. Big enough to read a title block. */
const PREVIEW_MAX_PX = 1100;

interface Props {
    /** The representative file: its page 1 is what the rules are drawn on. */
    file: File | null;
    rules: UpdateRule[];
    onRulesChange: (rules: UpdateRule[]) => void;
    onTemplateOrientationChange: (orientation: PageOrientation | null) => void;
    disabled?: boolean;
}

interface DragState {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
}

const emptyRule = (): UpdateRule => ({ rect: { x: 0, y: 0, width: 0, height: 0 }, text: '' });
const hasArea = (rule: UpdateRule) => rule.rect.width > 0.002 && rule.rect.height > 0.002;

/**
 * Draw the update regions on a representative page.
 *
 * The rectangles are stored as fractions of the displayed page rather than
 * canvas pixels, so the same selection lands in the same place on an A1 and on
 * an A3 sheet, and survives a change of preview zoom.
 */
export function TitleBlockUpdater({
    file,
    rules,
    onRulesChange,
    onTemplateOrientationChange,
    disabled = false,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activeRule, setActiveRule] = useState(0);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [showAfter, setShowAfter] = useState(true);
    const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);

    // Render whichever page is selected, and report the orientation the rules
    // are being drawn against.
    useEffect(() => {
        let cancelled = false;
        let doc: pdfjsLib.PDFDocumentProxy | null = null;

        (async () => {
            if (!file) {
                if (cancelled) return;
                setNumPages(0);
                setCanvasSize(null);
                onTemplateOrientationChange(null);
                return;
            }
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                doc = await pdfjsLib.getDocument({ data: bytes }).promise;
                if (cancelled) return;
                setNumPages(doc.numPages);
                const target = Math.min(Math.max(1, pageNumber), doc.numPages);
                const page = await doc.getPage(target);
                if (cancelled) return;

                const base = page.getViewport({ scale: 1 });
                const scale = PREVIEW_MAX_PX / Math.max(base.width, base.height);
                const viewport = page.getViewport({ scale });
                const canvas = canvasRef.current;
                if (!canvas) return;
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Selecting a region only needs the page geometry, so open the
                // surface up as soon as that is known. Waiting for the raster
                // would leave the tool inert whenever rendering is slow to
                // finish, and PDF.js only finishes while the tab is visible.
                setCanvasSize({ width: canvas.width, height: canvas.height });
                setLoadError(null);
                onTemplateOrientationChange(orientationOf(base.width, base.height));

                await page.render({ canvas, viewport }).promise;
            } catch (error) {
                if (cancelled) return;
                setLoadError(error instanceof Error ? error.message : String(error));
                onTemplateOrientationChange(null);
            }
        })();

        return () => {
            cancelled = true;
            doc?.destroy().catch(() => { });
        };
    }, [file, pageNumber, onTemplateOrientationChange]);

    const pointToFraction = useCallback((event: React.PointerEvent) => {
        const surface = surfaceRef.current;
        if (!surface) return null;
        const bounds = surface.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return null;
        return {
            x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
            y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
        };
    }, []);

    const onPointerDown = (event: React.PointerEvent) => {
        if (disabled || !canvasSize) return;
        const point = pointToFraction(event);
        if (!point) return;
        // Keeps the drag alive if the pointer leaves the canvas. Best effort:
        // a synthetic pointer has no active id and capture would throw.
        try {
            surfaceRef.current?.setPointerCapture(event.pointerId);
        } catch { /* not a real pointer */ }
        setDrag({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
    };

    const onPointerMove = (event: React.PointerEvent) => {
        if (!drag) return;
        const point = pointToFraction(event);
        if (!point) return;
        setDrag({ ...drag, currentX: point.x, currentY: point.y });
    };

    const onPointerUp = () => {
        if (!drag) return;
        const rect = {
            x: Math.min(drag.startX, drag.currentX),
            y: Math.min(drag.startY, drag.currentY),
            width: Math.abs(drag.currentX - drag.startX),
            height: Math.abs(drag.currentY - drag.startY),
        };
        setDrag(null);
        if (rect.width < 0.004 || rect.height < 0.004) return;

        const next = [...rules];
        while (next.length <= activeRule) next.push(emptyRule());
        next[activeRule] = { ...next[activeRule], rect };
        onRulesChange(next.slice(0, MAX_RULES));
    };

    const setRuleText = (index: number, text: string) => {
        const next = [...rules];
        while (next.length <= index) next.push(emptyRule());
        next[index] = { ...next[index], text };
        onRulesChange(next);
    };

    const addRule = () => {
        if (rules.length >= MAX_RULES) return;
        onRulesChange([...rules, emptyRule()]);
        setActiveRule(rules.length);
    };

    const removeRule = (index: number) => {
        const next = rules.filter((_, i) => i !== index);
        onRulesChange(next);
        setActiveRule(Math.max(0, Math.min(activeRule, next.length - 1)));
    };

    const liveRect = drag
        ? {
            x: Math.min(drag.startX, drag.currentX),
            y: Math.min(drag.startY, drag.currentY),
            width: Math.abs(drag.currentX - drag.startX),
            height: Math.abs(drag.currentY - drag.startY),
        }
        : null;

    return (
        <div className="tb-updater">
            <div className="tb-toolbar">
                <button
                    type="button"
                    onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
                    disabled={disabled || pageNumber <= 1}
                    title="前のページ"
                >
                    <ChevronLeft size={16} /> 前
                </button>
                <span className="tb-page-indicator">
                    {numPages > 0 ? `${pageNumber} / ${numPages} ページ` : 'ページ —'}
                </span>
                <button
                    type="button"
                    onClick={() => setPageNumber((n) => Math.min(numPages || 1, n + 1))}
                    disabled={disabled || numPages === 0 || pageNumber >= numPages}
                    title="次のページ"
                >
                    次 <ChevronRight size={16} />
                </button>
                <button
                    type="button"
                    className={showAfter ? 'tb-toggle active' : 'tb-toggle'}
                    onClick={() => setShowAfter((v) => !v)}
                    title="更新後のイメージと元の表示を切り替えます"
                >
                    <Eye size={16} /> {showAfter ? '更新後を表示中' : '元の表示中'}
                </button>
            </div>

            <div className="tb-stage">
                <div
                    className="tb-surface"
                    ref={surfaceRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    style={{ cursor: disabled || !canvasSize ? 'default' : 'crosshair' }}
                >
                    <canvas ref={canvasRef} className="tb-canvas" />

                    {rules.map((rule, index) => hasArea(rule) && (
                        <div
                            key={index}
                            className={`tb-region ${index === activeRule ? 'active' : ''}`}
                            style={{
                                left: `${rule.rect.x * 100}%`,
                                top: `${rule.rect.y * 100}%`,
                                width: `${rule.rect.width * 100}%`,
                                height: `${rule.rect.height * 100}%`,
                                background: showAfter ? '#fff' : 'transparent',
                            }}
                        >
                            <span className="tb-region-number">{index + 1}</span>
                            {showAfter && rule.text && (
                                <span className="tb-region-text">{rule.text}</span>
                            )}
                        </div>
                    ))}

                    {liveRect && (
                        <div
                            className="tb-region live"
                            style={{
                                left: `${liveRect.x * 100}%`,
                                top: `${liveRect.y * 100}%`,
                                width: `${liveRect.width * 100}%`,
                                height: `${liveRect.height * 100}%`,
                            }}
                        />
                    )}

                    {!file && <div className="tb-placeholder">PDFを追加すると代表ページが表示されます</div>}
                    {loadError && <div className="tb-placeholder">プレビューを表示できません: {loadError}</div>}
                </div>
            </div>

            <p className="tb-hint">
                代表ページの上で、更新したい領域をドラッグして選んでください。選んだ領域は白で覆われ、入力した文字が中央に描かれます。
            </p>

            <div className="tb-rules">
                {rules.map((rule, index) => (
                    <div key={index} className={`tb-rule ${index === activeRule ? 'active' : ''}`}>
                        <button
                            type="button"
                            className="tb-rule-number"
                            onClick={() => setActiveRule(index)}
                            disabled={disabled}
                            title="この番号の領域を選び直します"
                        >
                            {index + 1}
                        </button>
                        <input
                            type="text"
                            className="tb-rule-text"
                            placeholder="新しい文字（例: 竣工図）"
                            value={rule.text}
                            onChange={(e) => setRuleText(index, e.target.value)}
                            disabled={disabled}
                        />
                        <button
                            type="button"
                            className="tb-rule-remove"
                            onClick={() => removeRule(index)}
                            disabled={disabled}
                            title="この領域を削除"
                        >
                            <Trash2 size={14} />
                        </button>
                        <span className="tb-rule-state">
                            {hasArea(rule) ? '領域あり' : '領域未選択'}
                        </span>
                    </div>
                ))}

                <button
                    type="button"
                    className="tb-add"
                    onClick={addRule}
                    disabled={disabled || rules.length >= MAX_RULES}
                >
                    <Plus size={16} /> 更新領域を追加（最大{MAX_RULES}か所）
                </button>
            </div>

            <p className="tb-warning">
                この機能は図枠の表示を一括更新するものです。元の文字情報がPDF内部の検索対象として残る場合があります。
                機密情報の墨消し用途には使用しないでください。
            </p>
        </div>
    );
}
