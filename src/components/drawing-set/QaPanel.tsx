import React, { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import type { DrawingSet, Finding, ReviewDecision, ReviewOutcome, Sheet } from '../../utils/drawing-set/model';
import { REVIEW_OUTCOMES, isLive } from '../../utils/drawing-set/model';
import type { FindingCurrency, LimitExcess, QaAssessment } from '../../utils/drawing-set/qa-engine';
import { QA01, QA02, QA09 } from '../../utils/drawing-set/qa-engine';
import type { DrawingSetStore } from '../../utils/drawing-set/workspace-store';
import { QA_VIEW_DRAFT, decisionDraftKey, useDraft } from './drafts';
import type { DraftBook } from './drafts';
import {
    BLOCKERS_HEAD_TEXT, BLOCKER_LABEL, FINAL_UNAVAILABLE_TEXT, FINDING_CURRENCY_LABEL, LIFECYCLE_LABEL, NOT_EVALUATED_LABEL, NO_BLOCKERS_TEXT,
    OUTCOME_LABEL, QA02_REASON_LABEL, QA09_REASON_LABEL, QA_NOT_RUN_TEXT, QA_REFUSED_HEAD, QA_REFUSED_TAIL, QA_RESULT_NOT_CURRENT_TEXT,
    QA_WOULD_REFUSE_HEAD, RULE_LABEL, describeExcess,
} from './qa-labels';
import { RegisterPanel } from './RegisterPanel';

/**
 * QA (M7-P3, first scope): run QA01 / QA02 / QA09 over the Drawing Set, see
 * what is left before a final check could be made, and record a Review
 * Decision on each Finding.
 *
 * Nothing here decides anything. Every number, currency and refusal shown is
 * the store's assessment of the session as it is (qa-engine.ts); every change
 * is a store command that answers with what it did or why it refused. A run
 * that is refused is said to be refused, with the bound it would have gone
 * past, and nothing about the results moves. Whatever the state, the screen
 * says the final check is not available: three of the rules are implemented,
 * not all of them.
 *
 * A Decision being typed, a register row being corrected and how far each list
 * is opened are the workspace's drafts (drafts.ts): this view is taken off the
 * screen while the page view is shown, and they are there again when it comes
 * back.
 */

interface Props {
    store: DrawingSetStore;
    drafts: DraftBook;
    drawingSet: DrawingSet;
    locked: boolean;
    selectedSheet: Sheet | null;
    onDeclare: () => void;
    onNotice: (message: string) => void;
}

/** How many Findings of one group are shown before "さらに表示". */
const PAGE = 50;
const GROUPS: { key: string; title: string; match: (f: Finding) => boolean }[] = [
    { key: 'qa01', title: '番号の重複（QA01）', match: (f) => f.ruleId === QA01 },
    { key: 'anl', title: '図面一覧にない番号（QA09）', match: (f) => f.ruleId === QA09 && f.params.reason === 'ACTUAL_NOT_LISTED' },
    { key: 'lbm', title: '図面一覧にあるがページがない番号（QA09）', match: (f) => f.ruleId === QA09 && f.params.reason === 'LISTED_BUT_MISSING' },
    { key: 'qa02', title: '表題欄の値が未確定（QA02）', match: (f) => f.ruleId === QA02 },
];

type RunMessage = { kind: 'applied'; text: string } | { kind: 'refused'; text: string; exceeded: LimitExcess[] } | null;

const formatTime = (timestamp: string): string => new Date(timestamp).toLocaleString('ja-JP');

export const QaPanel: React.FC<Props> = ({ store, drafts, drawingSet, locked, selectedSheet, onDeclare, onNotice }) => {
    const assessment = store.qaAssessment();
    const [message, setMessage] = useState<RunMessage>(null);
    const [listView, setListView] = useDraft<{ shown: Record<string, number>; history: boolean }>(drafts, QA_VIEW_DRAFT, () => ({ shown: {}, history: false }));
    const { shown, history: showHistory } = listView;
    const setShown = (next: (current: Record<string, number>) => Record<string, number>): void => setListView((v) => ({ ...v, shown: next(v.shown) }));
    const setShowHistory = (next: (current: boolean) => boolean): void => setListView((v) => ({ ...v, history: next(v.history) }));

    const labels = useMemo(() => subjectLabels(drawingSet), [drawingSet]);
    if (!assessment) return null;
    const { evaluation, readiness } = assessment;
    const latestRun = drawingSet.analysisRuns.filter((run) => run.kind === 'QA' && run.outcome === 'COMPLETED').at(-1) ?? null;
    const active = drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE');
    const history = drawingSet.findings.filter((f) => f.lifecycle.state !== 'ACTIVE');

    const run = (): void => {
        const outcome = store.runQa();
        if (outcome.ok) {
            setMessage({
                kind: 'applied',
                text: `QA の結果を反映しました（${formatTime(outcome.run.completedAt!)}）。新しい指摘 ${outcome.created} 件、置き換え ${outcome.superseded} 件、終了 ${outcome.closed} 件。`,
            });
        } else if (outcome.refusal.code === 'QA_LIMIT_EXCEEDED') {
            setMessage({ kind: 'refused', text: QA_REFUSED_HEAD, exceeded: outcome.refusal.exceeded ?? [] });
        } else {
            setMessage({ kind: 'refused', text: outcome.refusal.message, exceeded: [] });
        }
    };

    const notCurrent = readiness.blockers.find((b) => b.code === 'QA_RESULT_NOT_CURRENT') ?? null;
    const otherBlockers = readiness.blockers.filter((b) => b.code !== 'QA_RESULT_NOT_CURRENT');
    const registerNote = readiness.notEvaluated.find((n) => n.ruleId === QA09 && (n.why === 'NO_DECLARED_REGISTER' || n.why === 'REGISTER_NOT_CURRENT')) ?? null;
    const noInput = readiness.notEvaluated.find((n) => n.why === 'SHEETS_WITHOUT_QA_INPUT') ?? null;

    return (
        <section className="ds-qa" aria-label="QA（チェック）" data-ds-qa>
            <div className="ds-qa-head">
                <h3>QA（チェック）</h3>
                <button
                    type="button"
                    className="ds-button is-primary"
                    onClick={run}
                    disabled={locked}
                    title={locked ? '表題欄の読み取り中は QA を実行できません。' : undefined}
                    data-ds-qa-run
                >
                    <Play size={14} /> QA を実行
                </button>
                <span className="ds-muted ds-small" data-ds-qa-last-run>
                    {latestRun
                        ? `前回の QA: ${formatTime(latestRun.completedAt!)}（対象 ${latestRun.coverage.sheetsEvaluated} ページ・番号が読めず対象外 ${latestRun.coverage.sheetsExcluded} ページ）`
                        : QA_NOT_RUN_TEXT}
                </span>
            </div>
            <p className="ds-muted ds-small">
                番号の重複（QA01）、表題欄の値が未確定のページ（QA02）、図面一覧とページの照合（QA09）を調べます。図面の内容そのものの良し悪しや設計の意図は判断しません。
            </p>

            {message && (
                <div className={`ds-qa-message is-${message.kind}`} role={message.kind === 'refused' ? 'alert' : 'status'} data-ds-qa-result={message.kind}>
                    <p>{message.text}</p>
                    {message.kind === 'refused' && message.exceeded.length > 0 && (
                        <>
                            <ul>{message.exceeded.map((excess, i) => <li key={i} data-ds-qa-exceeded={excess.limit}>{describeExcess(excess)}</li>)}</ul>
                            <p>{QA_REFUSED_TAIL}</p>
                        </>
                    )}
                </div>
            )}

            <section className="ds-readiness" aria-label="最終確認に向けて残っている項目" data-ds-qa-readiness data-ds-readiness-status={readiness.status}>
                <p className="ds-readiness-final" data-ds-final-unavailable>{FINAL_UNAVAILABLE_TEXT}</p>
                {readiness.blockers.length === 0 ? (
                    <p data-ds-readiness-empty>{NO_BLOCKERS_TEXT}</p>
                ) : (
                    <>
                        <p>{BLOCKERS_HEAD_TEXT}</p>
                        <ul className="ds-readiness-list">
                            {notCurrent && (
                                <li data-ds-blocker="QA_RESULT_NOT_CURRENT">
                                    {assessment.refusal.length > 0 ? (
                                        <span data-ds-qa-prediction>
                                            {QA_WOULD_REFUSE_HEAD}
                                            {assessment.refusal.map((excess, i) => <span key={i} className="ds-readiness-detail" data-ds-qa-exceeded={excess.limit}>{describeExcess(excess)}</span>)}
                                        </span>
                                    ) : notCurrent.subjects.includes('NO_QA_RUN') ? QA_NOT_RUN_TEXT : QA_RESULT_NOT_CURRENT_TEXT}
                                </li>
                            )}
                            {otherBlockers.map((blocker) => (
                                <li key={blocker.code} data-ds-blocker={blocker.code}>
                                    {BLOCKER_LABEL[blocker.code as Exclude<typeof blocker.code, 'QA_RESULT_NOT_CURRENT'>](blocker.subjects.length)}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
                {(registerNote || noInput) && (
                    <ul className="ds-readiness-notes">
                        {registerNote && <li data-ds-not-evaluated={registerNote.why}>{NOT_EVALUATED_LABEL[registerNote.why as 'NO_DECLARED_REGISTER' | 'REGISTER_NOT_CURRENT'](0)}</li>}
                        {noInput && <li data-ds-not-evaluated="SHEETS_WITHOUT_QA_INPUT">{NOT_EVALUATED_LABEL.SHEETS_WITHOUT_QA_INPUT(noInput.subjects?.length ?? 0)}</li>}
                    </ul>
                )}
            </section>

            <RegisterPanel
                store={store}
                drafts={drafts}
                drawingSet={drawingSet}
                register={evaluation.register}
                locked={locked}
                selectedSheet={selectedSheet}
                onDeclare={onDeclare}
                onNotice={onNotice}
            />

            <section className="ds-findings" aria-label="指摘" data-ds-findings data-ds-findings-active={active.length}>
                <div className="ds-pane-title">指摘（最新 {active.length} 件）</div>
                {active.length === 0 && (
                    <p className="ds-muted ds-small">{latestRun ? '前回の QA で、実装済みのルールの指摘はありませんでした。' : 'QA を実行すると、指摘がここに表示されます。'}</p>
                )}
                {GROUPS.map((group) => {
                    const list = active.filter(group.match);
                    if (list.length === 0) return null;
                    const limit = shown[group.key] ?? PAGE;
                    return (
                        <div key={group.key} className="ds-finding-group" data-ds-finding-group={group.key}>
                            <div className="ds-finding-group-title">{group.title}（{list.length} 件）</div>
                            <ul>
                                {list.slice(0, limit).map((finding) => (
                                    <FindingCard key={finding.id} store={store} drafts={drafts} finding={finding} assessment={assessment} labels={labels} locked={locked} />
                                ))}
                            </ul>
                            {list.length > limit && (
                                <button type="button" className="ds-link-button" onClick={() => setShown((s) => ({ ...s, [group.key]: limit + PAGE }))} data-ds-finding-more={group.key}>
                                    さらに {Math.min(PAGE, list.length - limit)} 件表示（残り {list.length - limit} 件）
                                </button>
                            )}
                        </div>
                    );
                })}
                {history.length > 0 && (
                    <div className="ds-finding-group is-history" data-ds-finding-history>
                        <button type="button" className="ds-link-button" onClick={() => setShowHistory((v) => !v)} data-ds-finding-history-toggle>
                            {showHistory ? '履歴を閉じる' : `置き換え・終了した指摘の履歴（${history.length} 件）を表示`}
                        </button>
                        {showHistory && (
                            <ul>
                                {history.slice(-(shown.history ?? PAGE)).reverse().map((finding) => (
                                    <FindingCard key={finding.id} store={store} drafts={drafts} finding={finding} assessment={assessment} labels={labels} locked={locked} />
                                ))}
                            </ul>
                        )}
                        {showHistory && history.length > (shown.history ?? PAGE) && (
                            <button type="button" className="ds-link-button" onClick={() => setShown((s) => ({ ...s, history: (s.history ?? PAGE) + PAGE }))}>
                                さらに表示（残り {history.length - (shown.history ?? PAGE)} 件）
                            </button>
                        )}
                    </div>
                )}
            </section>
        </section>
    );
};

interface SubjectLabels {
    sheet: (id: string) => string;
    entry: (id: string) => string;
}

/** How a Finding's subjects read to a person: file and page, or register and row. Never an id. */
function subjectLabels(set: DrawingSet): SubjectLabels {
    const sources = new Map(set.sources.map((s) => [s.id, s]));
    const sheets = new Map(set.sheets.map((s) => [s.id, s]));
    const entries = new Map<string, string>();
    for (const reference of set.drawingRegisterReferences) {
        const source = sources.get(reference.sourceId);
        for (const entry of reference.entries) {
            entries.set(entry.id, `図面一覧（${source?.displayName ?? '?'} ${reference.pageNumber}ページ）の ${entry.row} 行目`);
        }
    }
    return {
        sheet: (id) => {
            const sheet = sheets.get(id);
            if (!sheet) return '（不明なページ）';
            const label = `${sources.get(sheet.sourceId)?.displayName ?? '?'} ${sheet.pageNumber}ページ`;
            return isLive(sheet) ? label : `${label}（外したページ）`;
        },
        entry: (id) => entries.get(id) ?? '（不明な行）',
    };
}

const LIST_MAX = 8;
const listOf = (items: string[]): string =>
    items.length <= LIST_MAX ? items.join('、') : `${items.slice(0, LIST_MAX).join('、')} ほか ${items.length - LIST_MAX} 件`;

function describeFinding(finding: Finding, labels: SubjectLabels): string {
    const key = finding.params.comparisonKey ?? '';
    switch (finding.ruleId) {
        case QA01:
            return `番号「${key}」のページが ${finding.sheetIds.length} 件あります：${listOf(finding.sheetIds.map(labels.sheet))}`;
        case QA02:
            return `${labels.sheet(finding.sheetIds[0])}：${QA02_REASON_LABEL[finding.params.reason as keyof typeof QA02_REASON_LABEL] ?? finding.params.reason}`;
        case QA09:
            return finding.params.reason === 'ACTUAL_NOT_LISTED'
                ? `${labels.sheet(finding.sheetIds[0])} の番号「${key}」が、図面一覧にありません。`
                : `図面一覧の番号「${key}」に当たるページがありません：${listOf(finding.registerEntryIds.map(labels.entry))}`;
        default:
            return finding.ruleId;
    }
}

const FindingCard: React.FC<{ store: DrawingSetStore; drafts: DraftBook; finding: Finding; assessment: QaAssessment; labels: SubjectLabels; locked: boolean }> = ({
    store, drafts, finding, assessment, labels, locked,
}) => {
    const currency: FindingCurrency = assessment.currency.get(finding.id) ?? 'HISTORICAL';
    const decisions = assessment.decisions.get(finding.id) ?? [];
    const effective = assessment.effective.get(finding.id) ?? null;
    const state = finding.lifecycle.state;
    const currencyLabel = FINDING_CURRENCY_LABEL[currency];
    const reason = finding.ruleId === QA09 ? QA09_REASON_LABEL[finding.params.reason as keyof typeof QA09_REASON_LABEL] : null;
    return (
        <li
            className={`ds-finding is-${state.toLowerCase()}`}
            data-ds-finding={finding.id}
            data-ds-finding-rule={finding.ruleId}
            data-ds-finding-reason={finding.params.reason ?? ''}
            data-ds-finding-lifecycle={state}
            data-ds-finding-currency={currency}
            data-ds-finding-effective={effective ?? ''}
        >
            <div className="ds-finding-head">
                <span className="ds-finding-rule">{RULE_LABEL[finding.ruleId] ?? finding.ruleId}</span>
                {reason && <span className="ds-muted ds-small">{reason}</span>}
                <span className={`ds-currency is-${currencyLabel.tone}`} title={currencyLabel.title} data-ds-finding-currency-label>{currencyLabel.text}</span>
                {effective && <span className={`ds-outcome is-${effective.toLowerCase()}`} title={OUTCOME_LABEL[effective].title} data-ds-finding-outcome>{OUTCOME_LABEL[effective].text}</span>}
                {state !== 'ACTIVE' && <span className="ds-muted ds-small">{LIFECYCLE_LABEL[state]}</span>}
            </div>
            <p className="ds-finding-text">{describeFinding(finding, labels)}</p>
            <span className="ds-muted ds-small">指摘した QA: {formatTime(finding.createdAt)}</span>
            {decisions.length > 0 && <DecisionHistory decisions={decisions} />}
            {state === 'ACTIVE' && (
                currency === 'CURRENT'
                    ? <DecisionForm store={store} drafts={drafts} finding={finding} locked={locked} />
                    : <p className="ds-muted ds-small" data-ds-decision-blocked>判断を記録できるのは、現在の内容と一致する指摘だけです。{currency === 'STALE' ? 'QA を実行し直してください。' : 'ファイルを照合するか、番号を読めていないページを読み取ってください。'}</p>
            )}
        </li>
    );
};

const DecisionHistory: React.FC<{ decisions: ReviewDecision[] }> = ({ decisions }) => (
    <ol className="ds-decision-history" aria-label="判断の履歴" data-ds-decision-history>
        {decisions.map((decision) => (
            <li key={decision.id} data-ds-decision={decision.sequence} data-ds-decision-outcome={decision.outcome}>
                <span className="ds-decision-seq">{decision.sequence}.</span>
                <span className={`ds-outcome is-${decision.outcome.toLowerCase()}`}>{OUTCOME_LABEL[decision.outcome].text}</span>
                <span className="ds-muted ds-small">{formatTime(decision.decidedAt)}</span>
                {decision.comment !== '' && <span className="ds-decision-comment" data-ds-decision-comment>{decision.comment}</span>}
            </li>
        ))}
    </ol>
);

const DecisionForm: React.FC<{ store: DrawingSetStore; drafts: DraftBook; finding: Finding; locked: boolean }> = ({ store, drafts, finding, locked }) => {
    // The outcome chosen and the comment typed are a draft until recorded; a Decision recorded starts the form over.
    const [draft, setDraft, discardDraft] = useDraft<{ outcome: ReviewOutcome | null; comment: string }>(
        drafts, decisionDraftKey(finding.id), () => ({ outcome: null, comment: '' }));
    const { outcome, comment } = draft;
    const setOutcome = (value: ReviewOutcome): void => setDraft((d) => ({ ...d, outcome: value }));
    const setComment = (value: string): void => setDraft((d) => ({ ...d, comment: value }));
    const [refusal, setRefusal] = useState<{ message: string; exceeded: LimitExcess[] } | null>(null);
    const submit = (): void => {
        if (!outcome) return;
        const result = store.decide(finding.id, outcome, comment);
        if (result.ok) {
            discardDraft();
            setRefusal(null);
        } else {
            setRefusal({ message: result.refusal.message, exceeded: result.refusal.exceeded ?? [] });
        }
    };
    return (
        <div className="ds-decision-form" data-ds-decision-form>
            <div className="ds-decision-outcomes" role="radiogroup" aria-label="判断">
                {REVIEW_OUTCOMES.map((value) => (
                    <label key={value} title={OUTCOME_LABEL[value].title}>
                        <input type="radio" name={`outcome-${finding.id}`} value={value} checked={outcome === value} onChange={() => setOutcome(value)} data-ds-decision-outcome-input={value} />
                        {OUTCOME_LABEL[value].text}
                    </label>
                ))}
            </div>
            <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="コメント（任意、4000文字まで）"
                rows={2}
                aria-label="コメント"
                data-ds-decision-comment-input
            />
            {refusal && (
                <p className="ds-error-text" role="alert" data-ds-decision-refused>
                    {refusal.message}
                    {refusal.exceeded.map((excess, i) => <span key={i} className="ds-readiness-detail">{describeExcess(excess)}</span>)}
                </p>
            )}
            <div className="ds-work-actions">
                <button type="button" className="ds-button" onClick={submit} disabled={locked || outcome === null} data-ds-decision-submit>
                    判断を記録
                </button>
                <span className="ds-muted ds-small">記録した判断は消えません。考えが変わったときは、新しい判断を記録します。</span>
            </div>
        </div>
    );
};
