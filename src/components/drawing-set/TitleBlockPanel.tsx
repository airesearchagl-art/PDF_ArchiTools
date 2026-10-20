import React, { useState } from 'react';
import type { DrawingSet, Sheet, TitleBlockProfile, Uuid } from '../../utils/drawing-set/model';
import { isLive } from '../../utils/drawing-set/model';
import { liveProfiles } from '../../utils/drawing-set/title-block-profiles';
import type { DrawingSetStore, ExtractionSummary, StoreOperation } from '../../utils/drawing-set/workspace-store';
import { TRANSFER_LABEL } from './title-block-labels';

/**
 * Profiles, which Sheets are on them, and reading them (M7-P2-B2, W2-W3).
 *
 * A Sheet is put on a profile only because a person chose it and said so; a
 * Sheet already on another profile moves only once the person has seen
 * which and confirmed the move. Reading runs over exactly the Sheets ticked
 * in the list, all of which must be on a profile. While it runs, everything
 * that would change what it reads is refused by the session store, and the
 * screen says why; it can be stopped at any time.
 */

const EXCLUSION_LABEL: Record<string, string> = {
    SOURCE_MISSING: 'ファイルがない',
    SOURCE_UNREADABLE: 'ファイルを読み込めない',
    SOURCE_CHANGED: 'ファイルの内容が変わった',
    PDF_OPEN_FAILED: 'PDFを開けない',
    EXTRACTION_FAILED: '読み取りに失敗',
    PAGE_NOT_IN_DOCUMENT: 'ページがない',
    FIELD_UNRECORDABLE: '記録できない文字・長さ',
    CANCELLED: '中止',
    RUN_FAILED: '処理の失敗',
    CHANGED_DURING_RUN: '読み取り中に変更された',
};

const OUTCOME_LABEL = { COMPLETED: '読み取りが終わりました', CANCELLED: '読み取りを中止しました', FAILED: '読み取りが途中で失敗しました' } as const;

interface Props {
    store: DrawingSetStore;
    drawingSet: DrawingSet;
    checked: ReadonlySet<Uuid>;
    operation: StoreOperation | null;
    lastExtraction: ExtractionSummary | null;
    selectedSheet: Sheet | null;
    canDraw: boolean;
    editing: boolean;
    onCheck: (ids: Uuid[] | null) => void;
    onCreate: () => void;
    onRevise: (profile: TitleBlockProfile) => void;
    onNotice: (message: string) => void;
}

export const TitleBlockPanel: React.FC<Props> = ({
    store, drawingSet, checked, operation, lastExtraction, selectedSheet, canDraw, editing, onCheck, onCreate, onRevise, onNotice,
}) => {
    const profiles = liveProfiles(drawingSet);
    const [target, setTarget] = useState<Uuid | ''>('');
    const [conflict, setConflict] = useState<{ profileId: Uuid; sheetIds: Uuid[]; count: number } | null>(null);
    const [renaming, setRenaming] = useState<{ id: Uuid; name: string } | null>(null);
    const [retiring, setRetiring] = useState<Uuid | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const locked = operation !== null;
    const liveSheets = drawingSet.sheets.filter(isLive);
    const chosen = liveSheets.filter((sheet) => checked.has(sheet.id));
    const unassigned = chosen.filter((sheet) => !sheet.profileAssignment).length;
    const targetProfile = profiles.find((p) => p.id === target) ?? null;
    const countOn = (profileId: Uuid): number => liveSheets.filter((sheet) => sheet.profileAssignment?.profileId === profileId).length;

    const assign = (replace: boolean): void => {
        if (!targetProfile) return;
        const ids = chosen.map((sheet) => sheet.id);
        const outcome = store.assignProfile(ids, targetProfile.id, { replace });
        if (outcome.ok) {
            setConflict(null);
            setMessage(null);
            const moved = 'replaced' in outcome ? outcome.replaced.length : 0;
            onNotice(`${ids.length}ページを「${targetProfile.name}」に割り当てました${moved > 0 ? `（${moved}ページは別のプロファイルから移しました）` : ''}。`);
        } else if (outcome.refusal.code === 'ASSIGNMENT_CONFLICT') {
            setConflict({ profileId: targetProfile.id, sheetIds: ids, count: outcome.refusal.sheetIds?.length ?? 0 });
        } else {
            setMessage(outcome.refusal.message);
        }
    };
    const unassign = (): void => {
        const outcome = store.unassignProfile(chosen.map((sheet) => sheet.id));
        if (outcome.ok) onNotice(`${outcome.cleared.length}ページの割り当てを外しました。`);
        else setMessage(outcome.refusal.message);
    };
    const extract = (): void => {
        setMessage(null);
        void store.startExtraction(chosen.map((sheet) => sheet.id));
    };
    const rename = (): void => {
        if (!renaming) return;
        const outcome = store.renameProfile(renaming.id, renaming.name);
        if (outcome.ok) setRenaming(null);
        else setMessage(outcome.refusal.message);
    };
    const retire = (profileId: Uuid): void => {
        const outcome = store.retireProfile(profileId);
        setRetiring(null);
        if (outcome.ok) onNotice(`プロファイルを廃止しました。${outcome.unassignedSheetIds.length}ページの割り当てが外れました（読み取りと確定の記録は残ります）。`);
        else setMessage(outcome.refusal.message);
    };

    const progress = operation?.progress;
    return (
        <div className="ds-titleblock" data-ds-titleblock>
            <div className="ds-pane-title">表題欄プロファイル（{profiles.length}）</div>
            <ul className="ds-profile-list" data-ds-profile-list>
                {profiles.map((profile) => (
                    <li key={profile.id} className="ds-profile-row" data-ds-profile-row data-ds-profile-id={profile.id}>
                        {renaming?.id === profile.id ? (
                            <span className="ds-profile-rename">
                                <input type="text" value={renaming.name} maxLength={200} onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })} aria-label="新しいプロファイル名" data-ds-rename-input />
                                <button type="button" className="ds-button" onClick={rename} disabled={locked} data-ds-rename-done>名前を変える</button>
                                <button type="button" className="ds-link-button" onClick={() => setRenaming(null)}>やめる</button>
                            </span>
                        ) : (
                            <>
                                <span className="ds-profile-name-text" data-ds-profile-name-text>{profile.name}</span>
                                <span className="ds-muted ds-small">
                                    {TRANSFER_LABEL[profile.transferModel].text}・範囲 r{profile.revision}・{countOn(profile.id)}ページ
                                </span>
                                <span className="ds-profile-actions">
                                    <button type="button" className="ds-link-button" disabled={locked || !canDraw || editing} onClick={() => onRevise(profile)} title="選択中のページの上で、このプロファイルの範囲を指定し直します。" data-ds-revise-profile>範囲を変更</button>
                                    <button type="button" className="ds-link-button" disabled={locked} onClick={() => setRenaming({ id: profile.id, name: profile.name })} data-ds-rename-profile>名前</button>
                                    {retiring === profile.id ? (
                                        <>
                                            <button type="button" className="ds-link-button is-danger" onClick={() => retire(profile.id)} disabled={locked} data-ds-retire-yes>廃止する</button>
                                            <button type="button" className="ds-link-button" onClick={() => setRetiring(null)}>やめる</button>
                                        </>
                                    ) : (
                                        <button type="button" className="ds-link-button" disabled={locked} onClick={() => setRetiring(profile.id)} data-ds-retire-profile>廃止</button>
                                    )}
                                </span>
                            </>
                        )}
                    </li>
                ))}
            </ul>
            <button type="button" className="ds-button" disabled={locked || !canDraw || editing} onClick={onCreate} title="選択中のページの上で、4つの項目の範囲を指定します。" data-ds-new-profile>
                新しいプロファイル
            </button>
            {!canDraw && profiles.length === 0 && <p className="ds-muted ds-small">ページを選んで表示すると、そのページの上で表題欄の範囲を指定できます。</p>}

            <div className="ds-pane-title">ページの選択（{chosen.length}）</div>
            <div className="ds-check-actions">
                <button type="button" className="ds-link-button" onClick={() => onCheck(liveSheets.map((s) => s.id))} data-ds-check-all>すべて</button>
                {selectedSheet && (
                    <button type="button" className="ds-link-button" onClick={() => onCheck(liveSheets.filter((s) => s.sourceId === selectedSheet.sourceId).map((s) => s.id))} data-ds-check-source>
                        このファイルのページ
                    </button>
                )}
                <button type="button" className="ds-link-button" onClick={() => onCheck(null)} data-ds-check-none>選択を解除</button>
            </div>

            <div className="ds-pane-title">割り当て</div>
            <div className="ds-assign">
                <select value={target} onChange={(event) => { setTarget(event.target.value); setConflict(null); }} disabled={locked || profiles.length === 0} aria-label="割り当てるプロファイル" data-ds-assign-target>
                    <option value="">プロファイルを選ぶ</option>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                <button type="button" className="ds-button" disabled={locked || !targetProfile || chosen.length === 0} onClick={() => assign(false)} data-ds-assign>
                    チェックしたページに割り当て
                </button>
                <button type="button" className="ds-link-button" disabled={locked || chosen.length === 0} onClick={unassign} data-ds-unassign>割り当てを外す</button>
            </div>
            {conflict && (
                <div className="ds-confirm" role="alertdialog" data-ds-assign-conflict>
                    <span>チェックしたページのうち{conflict.count}ページには、別のプロファイルが割り当てられています。「{targetProfile?.name}」に置き換えますか？</span>
                    <button type="button" className="ds-button is-danger" onClick={() => assign(true)} data-ds-assign-replace>置き換える</button>
                    <button type="button" className="ds-button" onClick={() => setConflict(null)}>やめる</button>
                </div>
            )}

            <div className="ds-pane-title">読み取り</div>
            {operation ? (
                <div className="ds-extraction is-running" data-ds-extraction={operation.phase}>
                    <span data-ds-extraction-progress>
                        {operation.phase === 'cancelling' ? '中止しています…' : `読み取り中（${operation.sheetCount}ページ）`}
                        {progress && ` ファイル ${progress.sourceIndex + 1} / ${progress.sourceTotal}${progress.pageNumber !== null ? `・ページ ${progress.pageNumber} / ${progress.pageTotal}` : ''}`}
                    </span>
                    <button type="button" className="ds-button" onClick={() => store.cancelExtraction()} disabled={operation.phase === 'cancelling'} data-ds-cancel-extraction>
                        読み取りを中止
                    </button>
                </div>
            ) : (
                <div className="ds-extraction">
                    <button type="button" className="ds-button is-primary" disabled={chosen.length === 0 || unassigned > 0} onClick={extract} data-ds-extract>
                        チェックしたページを読み取る
                    </button>
                    {unassigned > 0 && <span className="ds-muted ds-small">プロファイルが割り当てられていないページ（{unassigned}）があります。</span>}
                </div>
            )}
            {lastExtraction && !operation && (
                <div className="ds-extraction-result" data-ds-extraction-result={lastExtraction.kind === 'refused' ? 'refused' : lastExtraction.outcome ?? ''} data-ds-extraction-ocr-failed={lastExtraction.ocrFailed}>
                    {lastExtraction.kind === 'refused' ? (
                        <span>{lastExtraction.refusal?.message}</span>
                    ) : (
                        <span>
                            {OUTCOME_LABEL[lastExtraction.outcome ?? 'FAILED']}：{lastExtraction.committed}ページの読み取り値を記録しました。
                            {lastExtraction.ocrFailed > 0 && ` そのうち${lastExtraction.ocrFailed}ページは文字認識（OCR）ができず、値を読み取れていません。`}
                            {lastExtraction.excluded.length > 0 && ` 読み取れなかったページ：${lastExtraction.excluded.map((e) => `${EXCLUSION_LABEL[e.code] ?? e.code} ${e.count}`).join('、')}`}
                            {!lastExtraction.applied && ' （図面一式が変わったため、記録していません）'}
                        </span>
                    )}
                </div>
            )}
            {message && <p className="ds-error-text" role="alert" data-ds-titleblock-message>{message}</p>}
            <p className="ds-muted ds-small">読み取りはブラウザ内で行います。PDFの文字がない範囲は、同じサイトにあるOCRで読み取ります。読み取った値は、人が原図と見比べて確定するまで確定値ではありません。</p>
        </div>
    );
};
