import React, { useState } from 'react';
import type { RegisterRowInput } from '../../utils/drawing-set/drawing-register';
import { MAX_REGISTER_ENTRIES } from '../../utils/drawing-set/field-bounds';
import type { Sheet, Source } from '../../utils/drawing-set/model';
import { FIELD_NAMES } from '../../utils/drawing-set/model';
import type { DrawingSetStore } from '../../utils/drawing-set/workspace-store';
import { FIELD_LABEL } from './title-block-labels';

/**
 * Declaring a typed drawing register (M7-P3) on the page shown in the viewer
 * above: a person types the rows of the list they see on it. A row left
 * entirely empty is not part of the declaration; a row with anything in it
 * needs a drawing number. Nothing is read from the page.
 */

interface Props {
    store: DrawingSetStore;
    sheet: Sheet;
    source: Source;
    locked: boolean;
    onDone: (message: string) => void;
    onCancel: () => void;
}

const EMPTY: RegisterRowInput = { drawingNumber: '', drawingTitle: '', revision: '', issueDate: '' };
const START_ROWS = 5;

export const RegisterDeclarePanel: React.FC<Props> = ({ store, sheet, source, locked, onDone, onCancel }) => {
    const [rows, setRows] = useState<RegisterRowInput[]>(() => Array.from({ length: START_ROWS }, () => ({ ...EMPTY })));
    const [message, setMessage] = useState<string | null>(null);
    // The rows declared, and where each sits in the inputs: an empty row is left out and the rest numbered 1..n.
    const filledAt = rows.flatMap((row, index) => (FIELD_NAMES.some((name) => row[name] !== '') ? [index] : []));
    const filled = filledAt.map((index) => rows[index]);

    const add = (count: number): void => setRows((current) => [...current, ...Array.from({ length: Math.min(count, MAX_REGISTER_ENTRIES - current.length) }, () => ({ ...EMPTY }))]);
    const declare = (): void => {
        const result = store.declareRegister(source.id, sheet.pageNumber, filled);
        if (result.ok) {
            onDone(`図面一覧を宣言しました（${source.displayName} ${sheet.pageNumber}ページ、${filled.length} 行）。QA を実行すると、ページの図面番号と照合します。`);
            return;
        }
        const row = result.refusal.row;
        setMessage(row !== undefined && filledAt[row - 1] !== undefined && filledAt[row - 1] + 1 !== row
            ? `${result.refusal.message}（入力欄の ${filledAt[row - 1] + 1} 行目）`
            : result.refusal.message);
    };

    return (
        <section className="ds-work-panel ds-register-declare" aria-label="図面一覧の宣言" data-ds-register-declare>
            <div className="ds-work-title">
                図面一覧の宣言（手入力）
                <span className="ds-muted ds-small">{source.displayName} {sheet.pageNumber}ページ</span>
            </div>
            <p className="ds-muted ds-small">
                上に表示しているページの図面リストを、1 行ずつ入力してください。図面番号は必ず入力します。図面名称・版・日付は、リストにない場合は空欄のままにします。空の行は宣言に含めません。
            </p>
            <table className="ds-register-table">
                <thead>
                    <tr>
                        <th>行</th>
                        {FIELD_NAMES.map((name) => <th key={name}>{FIELD_LABEL[name]}{name === 'drawingNumber' ? '（必須）' : ''}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={index} data-ds-register-input-row={index + 1}>
                            <td>{index + 1}</td>
                            {FIELD_NAMES.map((name) => (
                                <td key={name}>
                                    <input
                                        type="text"
                                        value={row[name]}
                                        onChange={(event) => {
                                            const value = event.target.value;
                                            setRows((current) => current.map((r, i) => (i === index ? { ...r, [name]: value } : r)));
                                        }}
                                        aria-label={`${index + 1} 行目の${FIELD_LABEL[name]}`}
                                        data-ds-register-input={`${index + 1}:${name}`}
                                    />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {message && <p className="ds-error-text" role="alert" data-ds-register-declare-refused>{message}</p>}
            <div className="ds-work-actions">
                <button type="button" className="ds-link-button" onClick={() => add(5)} disabled={rows.length >= MAX_REGISTER_ENTRIES} data-ds-register-add-rows>行を 5 行追加</button>
                <span className="ds-muted ds-small">入力済み {filled.length} 行（1 つの図面一覧は {MAX_REGISTER_ENTRIES} 行まで）</span>
                <button type="button" className="ds-button is-primary" onClick={declare} disabled={locked || filled.length === 0} data-ds-register-declare-submit>
                    この内容で宣言
                </button>
                <button type="button" className="ds-button" onClick={onCancel} data-ds-register-declare-cancel>やめる</button>
            </div>
        </section>
    );
};
