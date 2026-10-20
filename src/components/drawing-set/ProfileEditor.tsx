import React, { useRef, useState } from 'react';
import type { FieldName, Rect, TransferModel } from '../../utils/drawing-set/model';
import { FIELD_NAMES } from '../../utils/drawing-set/model';
import type { ViewerGeometry } from '../../utils/drawing-set/profile-pointer';
import { dragToUpright, roundPoints, uprightToScreen } from '../../utils/drawing-set/profile-pointer';
import { FIELD_LABEL, TRANSFER_LABEL } from './title-block-labels';

/**
 * Drawing a title-block profile on the viewer (M7-P2-B2, W2).
 *
 * A person picks one of the four fields and drags its rectangle on the page
 * as the viewer shows it; the rectangle is recorded in upright points, the
 * space the Drawing Register reads in (profile-pointer.ts). Nothing is
 * inferred: no rectangle, no transfer model and no name is filled in for
 * the person. The profile is made, or revised, only when all four fields are
 * drawn, a transfer model is chosen, and the person says so -- through the
 * session store's commands, which may still refuse.
 *
 * The overlay is CSS over the viewer's canvas. It draws nothing into the
 * page, and the page is never changed.
 */

export type DraftFields = Partial<Record<FieldName, Rect>>;

/** The four rectangles over the page: shown, and -- when a field is being drawn -- drawn by dragging. */
export const FieldRectsOverlay: React.FC<{
    geometry: ViewerGeometry;
    rects: DraftFields;
    /** The field a drag draws, or null for a read-only overlay. */
    drawing?: FieldName | null;
    onDraw?: (field: FieldName, rect: Rect) => void;
    mode: 'profile' | 'draft';
}> = ({ geometry, rects, drawing = null, onDraw, mode }) => {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
    const point = (event: React.PointerEvent): { x: number; y: number } => {
        const box = surfaceRef.current!.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const live = drag && drawing ? dragToUpright(drag.from, drag.to, geometry) : null;
    return (
        <div
            ref={surfaceRef}
            className={`ds-field-surface${drawing ? ' is-drawing' : ''}`}
            data-ds-field-surface={mode}
            data-ds-drawing={drawing ?? ''}
            onPointerDown={(event) => {
                if (!drawing || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const p = point(event);
                setDrag({ from: p, to: p });
            }}
            onPointerMove={(event) => {
                if (!drag) return;
                setDrag({ from: drag.from, to: point(event) });
            }}
            onPointerUp={(event) => {
                if (!drag || !drawing) return;
                const rect = roundPoints(dragToUpright(drag.from, point(event), geometry));
                setDrag(null);
                if (rect.right > rect.left && rect.bottom > rect.top) onDraw?.(drawing, rect);
            }}
            onPointerCancel={() => setDrag(null)}
        >
            {FIELD_NAMES.map((name) => {
                const rect = live && name === drawing ? live : rects[name];
                if (!rect) return null;
                const box = uprightToScreen(rect, geometry);
                return (
                    <div
                        key={name}
                        className={`ds-field-rect is-${name}${name === drawing ? ' is-active' : ''}`}
                        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                        data-ds-field-rect={name}
                        data-ds-upright={`${rect.left},${rect.top},${rect.right},${rect.bottom}`}
                    >
                        <span className="ds-field-rect-label">{FIELD_LABEL[name]}</span>
                    </div>
                );
            })}
        </div>
    );
};

/** The editor's controls, under the viewer. */
export const ProfileEditorPanel: React.FC<{
    mode: 'create' | 'revise';
    profileName: string;
    reference: string;
    draft: DraftFields;
    drawing: FieldName | null;
    transferModel: TransferModel | null;
    name: string;
    message: string | null;
    onPick: (field: FieldName) => void;
    onTransferModel: (model: TransferModel) => void;
    onName: (name: string) => void;
    onDone: () => void;
    onCancel: () => void;
}> = ({ mode, profileName, reference, draft, drawing, transferModel, name, message, onPick, onTransferModel, onName, onDone, onCancel }) => {
    const complete = FIELD_NAMES.every((field) => draft[field]);
    const ready = complete && transferModel !== null && (mode === 'revise' || name.trim() !== '');
    return (
        <section className="ds-work-panel ds-profile-editor" aria-label="プロファイルの範囲指定" data-ds-profile-editor={mode}>
            <div className="ds-work-title">
                {mode === 'create' ? '新しいプロファイル' : `プロファイル「${profileName}」の範囲を変更`}
                <span className="ds-muted ds-small">基準ページ: {reference}</span>
            </div>
            <p className="ds-muted ds-small">項目を選んでから、ページ上をドラッグして範囲を指定してください。4つの項目すべてに範囲が必要です。</p>
            <div className="ds-field-picks" role="group" aria-label="範囲を指定する項目">
                {FIELD_NAMES.map((field) => (
                    <button
                        key={field}
                        type="button"
                        className={`ds-button ds-field-pick is-${field}${drawing === field ? ' is-active' : ''}`}
                        aria-pressed={drawing === field}
                        onClick={() => onPick(field)}
                        data-ds-pick-field={field}
                    >
                        {FIELD_LABEL[field]}
                        <span className="ds-small">{draft[field] ? '指定済み' : '未指定'}</span>
                    </button>
                ))}
            </div>
            <fieldset className="ds-transfer">
                <legend>用紙の大きさが違うページでの範囲の扱い（選んでください）</legend>
                {(Object.keys(TRANSFER_LABEL) as TransferModel[]).map((model) => (
                    <label key={model} title={TRANSFER_LABEL[model].title}>
                        <input
                            type="radio"
                            name="ds-transfer-model"
                            checked={transferModel === model}
                            onChange={() => onTransferModel(model)}
                            data-ds-transfer-model={model}
                        />
                        {TRANSFER_LABEL[model].text}
                    </label>
                ))}
            </fieldset>
            {mode === 'create' && (
                <label className="ds-profile-name">
                    プロファイル名
                    <input type="text" value={name} onChange={(event) => onName(event.target.value)} maxLength={200} data-ds-profile-name />
                </label>
            )}
            {message && <p className="ds-error-text" role="alert" data-ds-editor-message>{message}</p>}
            <div className="ds-work-actions">
                <button type="button" className="ds-button is-primary" disabled={!ready} onClick={onDone} data-ds-editor-done>
                    {mode === 'create' ? 'プロファイルを作成' : '範囲を変更'}
                </button>
                <button type="button" className="ds-button" onClick={onCancel} data-ds-editor-cancel>やめる</button>
            </div>
        </section>
    );
};
