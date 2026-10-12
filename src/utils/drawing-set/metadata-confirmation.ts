/**
 * What a person stands behind: confirming a Sheet's title-block values,
 * confirming them again, and withdrawing them.
 *
 * A confirmation is made only here, and only because a person asked for one
 * Sheet. Reading a Sheet never confirms it, a score never confirms it, and
 * there is no call that confirms many Sheets at once. A correction never
 * touches the machine's reading: the observation stays exactly as it was read,
 * and the confirmation sits beside it.
 *
 * Two ways to confirm, and both need this session to vouch for the bytes (the
 * Source's File is MATCHED):
 *  - from the observation: only when it is CURRENT, and the confirmation takes
 *    that observation's own basis -- its fingerprint and profile revision. A
 *    stale reading is never given the current profile revision after the
 *    fact; it has to be read again, or the values typed without a profile.
 *  - typed with no profile (`profile: null`): every field counts as supplied
 *    by the person.
 *
 * `editedFields` is HDR-36-01, computed once, at confirmation time, and never
 * again: a key is in it when the observation the person confirmed against is
 * missing, when the observed field was not read at all (`source: none`, even
 * if both values are empty), or when the confirmed value is not exactly the
 * observed value. It records which fields a person supplied; it is not proof
 * they checked the others.
 *
 * Re-confirming or withdrawing moves the confirmation that stood into the
 * history (RECONFIRMED / WITHDRAWN), which only grows. When the history is
 * full the operation is refused rather than an old entry dropped.
 */
import type { RuntimeBindings } from './currency';
import { observationCurrency } from './currency';
import type { FieldProblem } from './field-bounds';
import { MAX_CONFIRMATION_HISTORY, checkFieldValue, describeProblem } from './field-bounds';
import type {
    Confirmation, DrawingSet, FieldName, FieldValues, Observation, RetiredConfirmation, Sheet, Uuid,
} from './model';
import { FIELD_NAMES, isLive, nowTimestamp } from './model';

export type ConfirmRefusalCode =
    | 'SHEET_NOT_FOUND'
    | 'SHEET_RETIRED'
    | 'SOURCE_NOT_MATCHED'
    | 'NO_OBSERVATION'
    | 'OBSERVATION_NOT_CURRENT'
    | 'VALUE_INVALID'
    | 'HISTORY_LIMIT'
    | 'NO_CONFIRMATION';

export interface ConfirmRefusal {
    code: ConfirmRefusalCode;
    message: string;
    problems?: FieldProblem[];
}

const refuse = (code: ConfirmRefusalCode, message: string, problems?: FieldProblem[]): { ok: false; refusal: ConfirmRefusal } =>
    ({ ok: false, refusal: problems ? { code, message, problems } : { code, message } });

/**
 * HDR-36-01, exactly. `observation` is the one the person confirmed against
 * (same fingerprint and profile basis), or null for values typed with no
 * profile. Canonical order, no duplicates, exact comparison.
 */
export function editedFieldsFor(values: FieldValues, observation: Observation | null): FieldName[] {
    return FIELD_NAMES.filter((name) => {
        if (observation === null) return true;
        const observed = observation.fields[name];
        return observed.source === 'none' || values[name] !== observed.value;
    });
}

/** Every value a person can confirm, or the problems with them. Nothing is trimmed or cut. */
export function checkValues(values: Partial<Record<FieldName, unknown>>): FieldProblem[] {
    const problems: FieldProblem[] = [];
    for (const field of FIELD_NAMES) {
        const value = values[field];
        if (typeof value !== 'string') {
            problems.push({ field, part: 'value', problem: { kind: 'OUT_OF_RANGE' } });
            continue;
        }
        const problem = checkFieldValue(value);
        if (problem) problems.push({ field, part: 'value', problem });
    }
    return problems;
}

const copyValues = (values: FieldValues): FieldValues =>
    Object.fromEntries(FIELD_NAMES.map((name) => [name, values[name]])) as FieldValues;

const historyFull = (sheet: Sheet): boolean => sheet.confirmationHistory.length >= MAX_CONFIRMATION_HISTORY;

const historyFullRefusal = () => refuse(
    'HISTORY_LIMIT',
    `このページの確認履歴が上限（${MAX_CONFIRMATION_HISTORY}件）に達しているため、変更できません。`,
);

function liveSheet(set: DrawingSet, sheetId: Uuid): Sheet | { ok: false; refusal: ConfirmRefusal } {
    const sheet = set.sheets.find((s) => s.id === sheetId);
    if (!sheet) return refuse('SHEET_NOT_FOUND', 'ページが見つかりません。');
    if (!isLive(sheet)) return refuse('SHEET_RETIRED', '外したファイルのページは確定できません。');
    return sheet;
}

const replaceSheet = (set: DrawingSet, next: Sheet): DrawingSet => ({
    ...set,
    sheets: set.sheets.map((sheet) => (sheet.id === next.id ? next : sheet)),
});

/**
 * Confirm one Sheet's four values, as a person asked.
 *
 * `basis: 'observation'` confirms against the Sheet's current observation and
 * takes its basis; `basis: 'manual'` records values typed with no profile.
 */
export function confirmSheet(
    set: DrawingSet,
    request: { sheetId: Uuid; values: FieldValues; basis: 'observation' | 'manual' },
    bindings: RuntimeBindings,
): { ok: true; drawingSet: DrawingSet; confirmation: Confirmation } | { ok: false; refusal: ConfirmRefusal } {
    const sheet = liveSheet(set, request.sheetId);
    if ('ok' in sheet) return sheet;
    const source = set.sources.find((s) => s.id === sheet.sourceId);
    if (!source || !isLive(source)) return refuse('SHEET_RETIRED', '外したファイルのページは確定できません。');
    if (bindings.get(source.id) !== 'MATCHED') {
        return refuse('SOURCE_NOT_MATCHED', 'ファイルの内容を確認できないため、確定できません。');
    }
    const problems = checkValues(request.values);
    if (problems.length > 0) {
        const first = problems[0];
        return refuse('VALUE_INVALID', describeProblem(first.problem), problems);
    }
    if (sheet.confirmation && historyFull(sheet)) return historyFullRefusal();

    let observation: Observation | null = null;
    if (request.basis === 'observation') {
        if (!sheet.observation) return refuse('NO_OBSERVATION', 'このページはまだ読み取られていません。');
        const currency = observationCurrency(set, sheet, bindings);
        if (currency.state !== 'CURRENT') {
            return refuse('OBSERVATION_NOT_CURRENT', '読み取り値が現在のファイルやプロファイルと一致しないため、この読み取り値では確定できません。読み直すか、プロファイルを使わずに入力してください。');
        }
        observation = sheet.observation;
    }

    const confirmedAt = nowTimestamp();
    const values = copyValues(request.values);
    const confirmation: Confirmation = {
        confirmedAt,
        sourceSha256: observation ? observation.sourceSha256 : source.fingerprint.sha256,
        profile: observation ? { profileId: observation.profile.profileId, profileRevision: observation.profile.profileRevision } : null,
        values,
        editedFields: editedFieldsFor(values, observation),
    };
    const history: RetiredConfirmation[] = sheet.confirmation
        ? [...sheet.confirmationHistory, { confirmation: sheet.confirmation, retiredAt: confirmedAt, reason: 'RECONFIRMED' }]
        : sheet.confirmationHistory;
    return {
        ok: true,
        drawingSet: replaceSheet(set, { ...sheet, confirmation, confirmationHistory: history }),
        confirmation,
    };
}

/** Withdraw the confirmation that stands, keeping it in the history. */
export function withdrawConfirmation(
    set: DrawingSet, sheetId: Uuid,
): { ok: true; drawingSet: DrawingSet } | { ok: false; refusal: ConfirmRefusal } {
    const sheet = liveSheet(set, sheetId);
    if ('ok' in sheet) return sheet;
    if (!sheet.confirmation) return refuse('NO_CONFIRMATION', 'このページには取り下げる確定値がありません。');
    if (historyFull(sheet)) return historyFullRefusal();
    const retired: RetiredConfirmation = { confirmation: sheet.confirmation, retiredAt: nowTimestamp(), reason: 'WITHDRAWN' };
    return {
        ok: true,
        drawingSet: replaceSheet(set, { ...sheet, confirmation: null, confirmationHistory: [...sheet.confirmationHistory, retired] }),
    };
}
