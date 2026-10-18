import React, { useEffect, useRef, useState } from 'react';
import { MAX_CONFIRMATION_HISTORY } from '../../utils/drawing-set/field-bounds';
import { editedFieldsFor } from '../../utils/drawing-set/metadata-confirmation';
import type { FieldName, FieldValues, Sheet } from '../../utils/drawing-set/model';
import { FIELD_NAMES, isLive } from '../../utils/drawing-set/model';
import { findProfile } from '../../utils/drawing-set/title-block-profiles';
import type { DrawingSetStore, EvidenceHandle } from '../../utils/drawing-set/workspace-store';
import { CurrencyBadge } from './CurrencyBadge';
import { FIELD_LABEL, METHOD_LABEL } from './title-block-labels';

/**
 * Confirming one Sheet (M7-P2-B2, W4; HD-B-03 A+B+C).
 *
 *  A. Original drawing: the four field rectangles of the Sheet's profile,
 *     cropped from the preview's own document by the session store and put
 *     here, beside the values. The panel holds empty slots and never draws
 *     into them; it is told when the crops are in place by being handed the
 *     store's evidence, which it passes back, unopened, to confirm.
 *  B. How each value was got: PDFの文字, OCR or 読み取れず -- from the
 *     observation, never changed by typing -- and, beside it, whether the
 *     value as it stands now is the reading or a person's entry.
 *  C. One Sheet: one button confirms this Sheet only.
 *
 * Nothing confirms without a profile (H-13): such a Sheet has no field
 * rectangles to show the drawing of. A reading the profile has moved past is
 * not shown against the new rectangles; it has to be read again.
 */

interface Props {
    store: DrawingSetStore;
    sheet: Sheet;
    /** The store's evidence generation: the crops are drawn again when it moves. */
    generation: number;
    locked: boolean;
    documentsUnavailable: boolean;
    onNotice: (message: string) => void;
}

/** What the inputs start from: the values confirmed against this very reading, else the reading's own. */
const valuesOf = (sheet: Sheet): FieldValues => {
    const confirmation = sheet.confirmation;
    const observation = sheet.observation;
    const sameBasis = confirmation && observation && confirmation.profile
        && confirmation.profile.profileId === observation.profile.profileId
        && confirmation.profile.profileRevision === observation.profile.profileRevision
        && confirmation.sourceSha256 === observation.sourceSha256;
    return Object.fromEntries(FIELD_NAMES.map((name) => [
        name, sameBasis ? confirmation.values[name] : observation?.fields[name].value ?? '',
    ])) as FieldValues;
};

export const ConfirmationPanel: React.FC<Props> = ({ store, sheet, generation, locked, documentsUnavailable, onNotice }) => {
    const set = store.currentSet();
    const profile = sheet.profileAssignment ? findProfile(set, sheet.profileAssignment.profileId) : null;
    const binding = store.bindingOf(sheet.sourceId);
    const currency = store.currencyOf(sheet);
    const observed = currency?.observation ?? null;
    const confirmed = currency?.confirmation ?? null;
    const observation = sheet.observation;

    const [values, setValues] = useState<FieldValues>(() => valuesOf(sheet));
    const [retry, setRetry] = useState(0);
    // What the latest request for crops came to, for the request it answers: an older answer is never shown.
    const request = `${sheet.id}|${generation}|${retry}`;
    const [answer, setAnswer] = useState<{ request: string; status: 'ready' | 'refused'; handle: EvidenceHandle | null; message?: string } | null>(null);
    const current = answer && answer.request === request ? answer : null;
    const handle = current?.status === 'ready' ? current.handle : null;
    const crop = { status: current?.status ?? 'drawing', message: current?.message };
    const [result, setResult] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const slotRefs = useRef<Partial<Record<FieldName, HTMLDivElement | null>>>({});

    // What stops this Sheet being confirmed now; null when the crops can be drawn.
    let blocked: { why: string; verify?: boolean } | null = null;
    if (locked) blocked = { why: '表題欄の読み取り中は確定できません。' };
    else if (documentsUnavailable) blocked = { why: '前に開いたPDFを閉じられたか確認できないため、確定できません。ページを再読み込みしてください。' };
    else if (!profile || !isLive(profile)) blocked = { why: 'このページにはプロファイルが割り当てられていないため、確定できません。プロファイルを割り当てて読み取ると確定できます。' };
    else if (!observation) blocked = { why: 'このページはまだ読み取られていません。「チェックしたページを読み取る」で読み取ってください。' };
    else if (binding !== 'MATCHED') blocked = { why: 'ファイルの内容（SHA-256）をこの画面で確かめられていないため、確定できません。', verify: true };
    else if (observed?.state !== 'CURRENT') blocked = { why: '読み取った後でプロファイルなどが変わったため、この読み取り値では確定できません。読み取りをやり直してください。' };
    const blockedWhy = blocked?.why ?? null;

    useEffect(() => {
        if (blockedWhy) return undefined;
        const panel = panelRef.current;
        const slots = slotRefs.current;
        if (!panel || !FIELD_NAMES.every((name) => slots[name])) return undefined;
        const controller = new AbortController();
        let issued: EvidenceHandle | null = null;
        store.prepareEvidence(sheet.id, { panel, slots: slots as Record<FieldName, HTMLElement> }, { signal: controller.signal }).then((outcome) => {
            if (controller.signal.aborted) {
                if (outcome.ok) store.releaseEvidence(outcome.handle);
                return;
            }
            if (outcome.ok) {
                issued = outcome.handle;
                setAnswer({ request, status: 'ready', handle: outcome.handle });
                return;
            }
            // Something moved while the crops were drawn: when that moved the generation, this runs again by itself.
            if (outcome.refusal.code === 'EVIDENCE_STALE' && store.getSnapshot().evidenceGeneration !== generation) return;
            setAnswer({ request, status: 'refused', handle: null, message: outcome.refusal.message });
        });
        return () => {
            controller.abort();
            if (issued) store.releaseEvidence(issued);
        };
    }, [store, sheet.id, generation, blockedWhy, request]);

    const edited = observation ? editedFieldsFor(values, observation) : [];
    const confirm = (): void => {
        if (!handle) return;
        const outcome = store.confirmSheet({ sheetId: sheet.id, values, evidence: handle });
        if (outcome.ok) {
            setResult(null);
            onNotice(`このページの値を確定しました（${sheet.pageNumber}ページ）。`);
        } else {
            setResult(outcome.refusal.message);
        }
    };
    const withdraw = (): void => {
        const outcome = store.withdrawConfirmation(sheet.id);
        if (outcome.ok) onNotice('このページの確定を取り下げました。確定の記録は履歴に残ります。');
        else setResult(outcome.refusal.message);
    };
    const verify = (): void => {
        setVerifying(true);
        store.verifyFile(sheet.sourceId).then((outcome) => {
            setVerifying(false);
            if (!outcome.ok) setResult(outcome.refusal.message);
        });
    };

    return (
        <section className="ds-work-panel ds-confirmation" aria-label="表題欄の確定" data-ds-confirmation-panel data-ds-crop-state={blocked ? 'blocked' : crop.status}>
            <div className="ds-work-title">
                表題欄の確定
                <span className="ds-currency-pair">
                    {observed && <CurrencyBadge kind="observation" currency={observed} />}
                    {confirmed && <CurrencyBadge kind="confirmation" currency={confirmed} />}
                </span>
                {profile && <span className="ds-muted ds-small">プロファイル: {profile.name}</span>}
            </div>

            {blocked ? (
                <div className="ds-blocked" data-ds-confirmation-blocked>
                    <p>{blocked.why}</p>
                    {blocked.verify && !locked && (
                        <button type="button" className="ds-button" onClick={verify} disabled={verifying} data-ds-verify-file>
                            {verifying ? '照合しています…' : 'ファイルを照合'}
                        </button>
                    )}
                </div>
            ) : (
                <div ref={panelRef} className="ds-crop-panel" data-ds-crop-panel>
                    <div className="ds-crop-grid">
                        <span className="ds-crop-head">項目</span>
                        <span className="ds-crop-head">原図</span>
                        <span className="ds-crop-head">取得方法</span>
                        <span className="ds-crop-head">値</span>
                        {FIELD_NAMES.map((name) => {
                            const method = observation ? METHOD_LABEL[observation.fields[name].source] : null;
                            return (
                                <React.Fragment key={name}>
                                    <span className="ds-crop-label">{FIELD_LABEL[name]}</span>
                                    <div className="ds-crop-slot" ref={(el) => { slotRefs.current[name] = el; }} data-ds-crop-slot={name} />
                                    <span className="ds-crop-method" title={method?.title} data-ds-method={observation?.fields[name].source}>{method?.text}</span>
                                    <span className="ds-crop-value">
                                        <input
                                            type="text"
                                            value={values[name]}
                                            onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                                            aria-label={`${FIELD_LABEL[name]}の値`}
                                            data-ds-value-input={name}
                                        />
                                        <span className={`ds-entry${edited.includes(name) ? ' is-edited' : ''}`} data-ds-entry={edited.includes(name) ? 'edited' : 'as-read'}>
                                            {edited.includes(name) ? '手で入力・修正' : '読み取り値のまま'}
                                        </span>
                                    </span>
                                </React.Fragment>
                            );
                        })}
                    </div>
                    {crop.status === 'drawing' && <p className="ds-muted ds-small" data-ds-crop-drawing>原図を表示しています…</p>}
                    {crop.status === 'refused' && (
                        <p className="ds-error-text" role="alert" data-ds-crop-refused>
                            {crop.message}
                            <button type="button" className="ds-link-button" onClick={() => setRetry((n) => n + 1)}>原図を表示し直す</button>
                        </p>
                    )}
                    <p className="ds-muted ds-small">
                        原図（左）と値を見比べて、このページだけを確定します。確定すると、値と、手で入力・修正した項目が記録されます。読み取りの値はそのまま残ります。
                    </p>
                    {result && <p className="ds-error-text" role="alert" data-ds-confirm-refused>{result}</p>}
                    <div className="ds-work-actions">
                        <button type="button" className="ds-button is-primary" disabled={!handle || crop.status !== 'ready'} onClick={confirm} data-ds-confirm-sheet>
                            このページを確定
                        </button>
                    </div>
                </div>
            )}

            {sheet.confirmation && (
                <div className="ds-confirmed" data-ds-confirmed>
                    <div className="ds-pane-title">確定した値（{new Date(sheet.confirmation.confirmedAt).toLocaleString('ja-JP')}）</div>
                    <dl>
                        {FIELD_NAMES.map((name) => (
                            <React.Fragment key={name}>
                                <dt>{FIELD_LABEL[name]}</dt>
                                <dd data-ds-confirmed-value={name}>
                                    {sheet.confirmation!.values[name] || <span className="ds-muted">（空欄）</span>}
                                    {sheet.confirmation!.editedFields.includes(name) && <span className="ds-entry is-edited">手で入力・修正</span>}
                                </dd>
                            </React.Fragment>
                        ))}
                    </dl>
                    <div className="ds-work-actions">
                        <span className="ds-muted ds-small">確定の履歴 {sheet.confirmationHistory.length} / {MAX_CONFIRMATION_HISTORY} 件</span>
                        <button type="button" className="ds-button" onClick={withdraw} disabled={locked} data-ds-withdraw>確定を取り下げる</button>
                    </div>
                </div>
            )}
        </section>
    );
};
