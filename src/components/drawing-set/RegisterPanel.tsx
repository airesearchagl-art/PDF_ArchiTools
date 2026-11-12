import React, { useState } from 'react';
import type { RegisterRowInput } from '../../utils/drawing-set/drawing-register';
import type { DrawingRegisterReference, DrawingSet, RegisterEntry, Sheet } from '../../utils/drawing-set/model';
import { FIELD_NAMES, isLive } from '../../utils/drawing-set/model';
import type { RegisterView } from '../../utils/drawing-set/qa-engine';
import type { DrawingSetStore } from '../../utils/drawing-set/workspace-store';
import { REGISTER_EDIT_DRAFT, useDraft } from './drafts';
import type { DraftBook } from './drafts';
import { FIELD_LABEL } from './title-block-labels';

/**
 * The drawing registers a person typed in (M7-P3): one per page of a Source
 * the list is on. Rows are corrected in place and withdrawn, never deleted; a
 * whole register is withdrawn the same way. Declaring a new one starts from
 * the page selected in the page list, shown beside the rows being typed.
 */

interface Props {
    store: DrawingSetStore;
    drafts: DraftBook;
    drawingSet: DrawingSet;
    register: RegisterView;
    locked: boolean;
    selectedSheet: Sheet | null;
    onDeclare: () => void;
    onNotice: (message: string) => void;
}

const rowInput = (entry: RegisterEntry): RegisterRowInput => ({
    drawingNumber: entry.drawingNumber,
    drawingTitle: entry.drawingTitle ?? '',
    revision: entry.revision ?? '',
    issueDate: entry.issueDate ?? '',
});

export const RegisterPanel: React.FC<Props> = ({ store, drafts, drawingSet, register, locked, selectedSheet, onDeclare, onNotice }) => {
    // The correction being typed is the workspace's draft: it is still there after a look at the page view.
    const [editing, setEditing, endEditing] = useDraft<{ referenceId: string; entryId: string; values: RegisterRowInput } | null>(drafts, REGISTER_EDIT_DRAFT, () => null);
    const [withdrawing, setWithdrawing] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [showRetired, setShowRetired] = useState(false);
    const sources = new Map(drawingSet.sources.map((s) => [s.id, s]));
    const live = drawingSet.drawingRegisterReferences.filter(isLive);
    const retired = drawingSet.drawingRegisterReferences.filter((r) => !isLive(r));
    const selectedSource = selectedSheet ? sources.get(selectedSheet.sourceId) ?? null : null;

    const answer = (result: { ok: true } | { ok: false; refusal: { message: string } }, done: string): void => {
        if (result.ok) {
            setMessage(null);
            onNotice(done);
        } else {
            setMessage(result.refusal.message);
        }
    };
    const saveRow = (): void => {
        if (!editing) return;
        const result = store.editRegisterEntry(editing.referenceId, editing.entryId, editing.values);
        if (result.ok) endEditing();
        answer(result, '図面一覧の行を修正しました。QA を実行し直すと照合に反映されます。');
    };
    const retireRow = (referenceId: string, entry: RegisterEntry): void => {
        answer(store.retireRegisterEntry(referenceId, entry.id), `図面一覧の ${entry.row} 行目を取り下げました。行は履歴として残ります。`);
    };
    const withdraw = (referenceId: string): void => {
        setWithdrawing(null);
        answer(store.retireRegisterReference(referenceId), '図面一覧を取り下げました。行は履歴として残ります。QA を実行し直すと照合に反映されます。');
    };

    const headOf = (reference: DrawingRegisterReference): string =>
        `${sources.get(reference.sourceId)?.displayName ?? '?'} ${reference.pageNumber}ページ`;

    return (
        <section className="ds-register" aria-label="図面一覧（手入力）" data-ds-register data-ds-register-state={register.state}>
            <div className="ds-pane-title">図面一覧（手入力）{live.length > 0 ? `（${live.length} 件）` : ''}</div>
            <p className="ds-muted ds-small">
                図面一式の中にある図面リストのページを選び、その内容を手で入力して宣言します。QA で、宣言した一覧とページの図面番号を照合します。表の自動読み取りや、CSV・Excel の取り込みには対応していません。
            </p>
            <div className="ds-work-actions">
                <button type="button" className="ds-button" onClick={onDeclare} disabled={locked || !selectedSheet || !selectedSource || !isLive(selectedSource)} data-ds-register-declare-start>
                    {selectedSheet && selectedSource ? `選択中のページ（${selectedSource.displayName} ${selectedSheet.pageNumber}ページ）から宣言` : 'ページを選ぶと宣言できます'}
                </button>
            </div>
            {message && <p className="ds-error-text" role="alert" data-ds-register-refused>{message}</p>}

            {live.map((reference) => {
                const notCurrent = register.notCurrent.includes(reference.id);
                const liveRows = reference.entries.filter(isLive).length;
                return (
                    <div key={reference.id} className="ds-register-ref" data-ds-register-ref={reference.id} data-ds-register-current={String(!notCurrent)}>
                        <div className="ds-register-ref-head">
                            <span className="ds-register-ref-name">{headOf(reference)}</span>
                            <span className="ds-muted ds-small">手入力・{liveRows} 行（宣言 {new Date(reference.declaredAt).toLocaleString('ja-JP')}）</span>
                            {notCurrent && <span className="ds-currency is-stale" data-ds-register-not-current>元のファイルが変わりました（宣言し直すか取り下げてください）</span>}
                            {withdrawing === reference.id ? (
                                <span className="ds-register-confirm" data-ds-register-withdraw-confirm>
                                    この図面一覧を取り下げますか？
                                    <button type="button" className="ds-button is-danger" onClick={() => withdraw(reference.id)} disabled={locked} data-ds-register-withdraw-yes>取り下げる</button>
                                    <button type="button" className="ds-button" onClick={() => setWithdrawing(null)}>やめる</button>
                                </span>
                            ) : (
                                <button type="button" className="ds-link-button is-danger" onClick={() => setWithdrawing(reference.id)} disabled={locked} data-ds-register-withdraw>
                                    この図面一覧を取り下げる
                                </button>
                            )}
                        </div>
                        <table className="ds-register-table">
                            <thead>
                                <tr>
                                    <th>行</th>
                                    {FIELD_NAMES.map((name) => <th key={name}>{FIELD_LABEL[name]}</th>)}
                                    <th aria-label="操作" />
                                </tr>
                            </thead>
                            <tbody>
                                {reference.entries.map((entry) => {
                                    // A row withdrawn meanwhile (its Source removed, say) is no longer corrected.
                                    const isEditing = editing?.entryId === entry.id && isLive(entry);
                                    return (
                                        <tr key={entry.id} className={isLive(entry) ? '' : 'is-retired'} data-ds-register-row={entry.row} data-ds-register-row-live={String(isLive(entry))}>
                                            <td>{entry.row}</td>
                                            {FIELD_NAMES.map((name) => (
                                                <td key={name}>
                                                    {isEditing ? (
                                                        <input
                                                            type="text"
                                                            value={editing.values[name]}
                                                            onChange={(event) => setEditing({ ...editing, values: { ...editing.values, [name]: event.target.value } })}
                                                            aria-label={`${entry.row} 行目の${FIELD_LABEL[name]}`}
                                                            data-ds-register-edit-input={name}
                                                        />
                                                    ) : (entry[name] ?? <span className="ds-muted">—</span>)}
                                                </td>
                                            ))}
                                            <td className="ds-register-actions">
                                                {!isLive(entry) ? <span className="ds-muted ds-small">取り下げ済み</span>
                                                    : isEditing ? (
                                                        <>
                                                            <button type="button" className="ds-link-button" onClick={saveRow} disabled={locked} data-ds-register-edit-save>修正を反映</button>
                                                            <button type="button" className="ds-link-button" onClick={endEditing} data-ds-register-edit-cancel>やめる</button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <button type="button" className="ds-link-button" onClick={() => setEditing({ referenceId: reference.id, entryId: entry.id, values: rowInput(entry) })} disabled={locked} data-ds-register-edit>修正</button>
                                                            <button type="button" className="ds-link-button is-danger" onClick={() => retireRow(reference.id, entry)} disabled={locked} data-ds-register-retire-row>取り下げ</button>
                                                        </>
                                                    )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                );
            })}

            {retired.length > 0 && (
                <div className="ds-register-retired" data-ds-register-retired>
                    <button type="button" className="ds-link-button" onClick={() => setShowRetired((v) => !v)}>
                        {showRetired ? '取り下げた図面一覧を閉じる' : `取り下げた図面一覧（${retired.length} 件）を表示`}
                    </button>
                    {showRetired && (
                        <ul>
                            {retired.map((reference) => (
                                <li key={reference.id} className="ds-muted ds-small">
                                    {headOf(reference)}・{reference.entries.length} 行（取り下げ {new Date(reference.retiredAt!).toLocaleString('ja-JP')}）
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
};
