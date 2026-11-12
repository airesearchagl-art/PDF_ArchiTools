/**
 * What the QA screen says (M7-P3). One place, so the words can be held to:
 *  - a partial QA result never reads as a pass or as the final check: the
 *    readiness area never says PASS, 合格, 完了 or 問題なし, and names the
 *    Final QA Report only to say it is not available;
 *  - a refused run never reads as a run: it is never "QA を実行しました";
 *  - as on the rest of the screen (title-block-labels.ts), nothing says
 *    確認済み, 正しい, 承認 or 検証済み.
 */
import type { QaRuleId, ReviewOutcome } from '../../utils/drawing-set/model';
import type { FindingCurrency, LimitExcess, NotEvaluatedWhy, Qa02Reason, ReadinessBlockerCode } from '../../utils/drawing-set/qa-engine';
import type { Tone } from './title-block-labels';

export const RULE_LABEL: Partial<Record<QaRuleId, string>> = {
    QA01_DUPLICATE_NUMBER: '番号の重複（QA01）',
    QA02_METADATA_UNCONFIRMED: '表題欄の値が未確定（QA02）',
    QA09_REGISTER_SHEET_MISMATCH: '図面一覧との照合（QA09）',
};

export const QA02_REASON_LABEL: Record<Qa02Reason, string> = {
    NOT_READ: 'まだ読み取っていません',
    UNCONFIRMED: '読み取った値が確定されていません',
    OCR_FAILED: '文字認識で読み取れませんでした',
    READ_IS_STALE: '読み取った後でファイルかプロファイルが変わりました',
    RECONFIRM_REQUIRED: '確定した後でファイルかプロファイルが変わりました（確定し直しが必要です）',
};

export const QA09_REASON_LABEL: Record<'ACTUAL_NOT_LISTED' | 'LISTED_BUT_MISSING', string> = {
    ACTUAL_NOT_LISTED: 'ページにある番号が、図面一覧にありません',
    LISTED_BUT_MISSING: '図面一覧にある番号のページがありません',
};

export const FINDING_CURRENCY_LABEL: Record<FindingCurrency, { text: string; title: string; tone: Tone }> = {
    CURRENT: { text: '現在の内容と一致', title: 'いまの内容で QA を実行しても、同じ指摘になります。', tone: 'current' },
    UNVERIFIED: {
        text: '照合できていないファイルあり',
        title: '指摘の内容は変わっていませんが、元のファイルの内容（SHA-256）をこの画面で照合できていないか、番号を読めていないページがあります。',
        tone: 'unverified',
    },
    STALE: { text: '内容が変わりました', title: 'この指摘の後で内容が変わりました。QA を実行し直すと、指摘が更新されます。', tone: 'stale' },
    HISTORICAL: { text: '履歴', title: 'その後の QA で置き換えられたか、終了した指摘です。', tone: 'none' },
};

export const LIFECYCLE_LABEL = {
    ACTIVE: '最新',
    SUPERSEDED: '根拠が変わり、新しい指摘に置き換え',
    NOT_REPRODUCED: '終了（その後の QA で指摘されなくなりました）',
} as const;

export const OUTCOME_LABEL: Record<ReviewOutcome, { text: string; title: string }> = {
    ACTION_REQUIRED: { text: '要対応', title: '図面の修正などの対応が必要です。' },
    INTENTIONAL: { text: '意図どおり', title: '意図したとおりです。表題欄の値が未確定の指摘では、そのページの確定を不要にします。' },
    FALSE_POSITIVE: { text: '誤検出', title: '指摘の内容が当てはまりません。' },
    HOLD: { text: '保留', title: '判断を保留します。保留の指摘があるうちは、最終確認に進めません。' },
};

/** Always shown: M7-P3 implements three rules, so there is no final check. */
export const FINAL_UNAVAILABLE_TEXT = '最終確認（Final QA Report）には未対応です。未実装のルール：QA01B、QA03〜QA08、QA10';
export const BLOCKERS_HEAD_TEXT = '実装済みのルール（QA01・QA02・QA09）の範囲で、次の項目が残っています。';
export const NO_BLOCKERS_TEXT = '実装済みのルールの範囲では、残っている項目はありません（最終確認ではありません）。';

export const BLOCKER_LABEL: Record<Exclude<ReadinessBlockerCode, 'QA_RESULT_NOT_CURRENT'>, (count: number) => string> = {
    SOURCES_NOT_MATCHED: (n) => `ファイルの内容（SHA-256）をこの画面で照合できていないファイルがあります（${n} 件）。`,
    METADATA_NOT_CONFIRMED: (n) => `表題欄の値が確定されていないページがあります（${n} 件）。`,
    REGISTER_NOT_CURRENT: (n) => `元のファイルが変わった図面一覧があります（${n} 件）。宣言し直すか、取り下げてください。`,
    FINDINGS_NOT_CURRENT: (n) => `内容が変わったか、照合できていない指摘があります（${n} 件）。`,
    FINDINGS_UNREVIEWED: (n) => `判断を記録していない指摘があります（${n} 件）。`,
    FINDINGS_ON_HOLD: (n) => `判断が「保留」の指摘があります（${n} 件）。`,
};

export const QA_NOT_RUN_TEXT = 'QA をまだ実行していません。';
export const QA_RESULT_NOT_CURRENT_TEXT = 'QA を実行した後に内容が変わりました。もう一度 QA を実行してください。';

export const NOT_EVALUATED_LABEL: Record<Exclude<NotEvaluatedWhy, 'NOT_IMPLEMENTED'>, (count: number) => string> = {
    NO_DECLARED_REGISTER: () => '図面一覧との照合：未実施（図面一覧が宣言されていません）',
    REGISTER_NOT_CURRENT: () => '図面一覧との照合：未実施（一覧の元のファイルが変わりました。宣言し直すか、一覧を取り下げてください）',
    SHEETS_WITHOUT_QA_INPUT: (n) => `番号が読めていないページ（${n} 件）は、重複と一覧の照合の対象外です。`,
};

/** Why a QA run, or a Decision, was refused: one sentence per bound, never the word for a completed run. */
export function describeExcess(excess: LimitExcess): string {
    switch (excess.limit) {
        case 'maxSubjectsPerFinding':
            return excess.at === 'finding.registerEntryIds'
                ? `図面一覧で番号「${excess.comparisonKey ?? ''}」の行が ${excess.planned} 件あり、1 件の指摘で扱える上限（${excess.max} 件）を超えています。行を取り下げてから、もう一度実行してください。`
                : `番号「${excess.comparisonKey ?? ''}」のページが ${excess.planned} 件あり、1 件の指摘で扱える上限（${excess.max} 件）を超えています。`;
        case 'maxAnalysisRuns':
            return `読み取りと QA の記録が上限（${excess.max} 件）に達しています。`;
        case 'maxFindings':
            return `指摘の記録が上限（${excess.max} 件）を超えるためです（${excess.planned} 件になります）。`;
        case 'maxSheets':
            return `QA の対象のページ数が上限（${excess.max} 件）を超えています（${excess.planned} 件）。`;
        case 'maxSources':
            return `1 件の指摘が根拠にするファイルが上限（${excess.max} 件）を超えています（${excess.planned} 件）。`;
        case 'maxDecisions':
            return `判断の記録が上限（${excess.max} 件）に達しています。`;
    }
}

export const QA_REFUSED_HEAD = 'QA の結果を反映できませんでした。';
export const QA_REFUSED_TAIL = '結果は変わっていません。';
export const QA_WOULD_REFUSE_HEAD = 'いまの内容では、QA を実行しても結果を反映できません。';
