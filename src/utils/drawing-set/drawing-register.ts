/**
 * Drawing registers a person types in (M7-P3): MANUAL declarations only.
 *
 * A register exists because a person declared it -- here, by typing the rows
 * of a list that is on one page of one Source (semantic contract §E). Nothing
 * reads a table, infers a list from a page, or imports one from elsewhere.
 * What is kept is field-level: per row the four values as typed, which page of
 * which bytes, and when; never the page, its text or an image of it.
 *
 * The basis is fixed. A reference names the Source's bytes at the moment it
 * was declared and never moves to other bytes or another page: declared again,
 * it is a new reference, and the old one is withdrawn by a person.
 *
 * Nothing is deleted. A row a person removes is retired, a reference a person
 * withdraws is retired, and both stay in the Drawing Set so the Findings that
 * cite them stay resolvable. A row a person corrects keeps its id and stays
 * MANUAL: a typed row corrected by a person is still a typed row.
 *
 * Every function is pure: it returns a new Drawing Set, or a refusal and the
 * Drawing Set untouched. Values are recorded exactly as typed or not at all.
 */
import type { FieldProblem } from './field-bounds';
import { MAX_REGISTER_ENTRIES, MAX_REGISTER_REFERENCES, P3_QA_LIMITS, checkFieldValue, describeProblem } from './field-bounds';
import type { DrawingRegisterReference, DrawingSet, FieldName, RegisterEntry, Timestamp, Uuid } from './model';
import { FIELD_NAMES, isLive } from './model';

/** One row as a person typed it. An empty optional value is "the list does not state it". */
export interface RegisterRowInput {
    drawingNumber: string;
    drawingTitle: string;
    revision: string;
    issueDate: string;
}

export type RegisterRefusalCode =
    | 'SOURCE_NOT_LIVE'
    | 'PAGE_OUT_OF_RANGE'
    | 'NO_ROWS'
    | 'ROW_LIMIT'
    | 'REGISTER_LIMIT'
    | 'NUMBER_REQUIRED'
    | 'VALUE_INVALID'
    | 'NO_SUCH_REFERENCE'
    | 'REFERENCE_RETIRED'
    | 'NO_SUCH_ENTRY'
    | 'ENTRY_RETIRED'
    | 'NO_CHANGE';

export interface RegisterRefusal {
    code: RegisterRefusalCode;
    message: string;
    /** The 1-based row the refusal is about, when it is about one. */
    row?: number;
    problems?: FieldProblem[];
}

export type RegisterResult =
    | { ok: true; drawingSet: DrawingSet; referenceId: Uuid; entryId?: Uuid }
    | { ok: false; refusal: RegisterRefusal };

export interface RegisterSeams {
    now: () => Timestamp;
    newId: () => Uuid;
}

const refuse = (code: RegisterRefusalCode, message: string, extra: Partial<RegisterRefusal> = {}): RegisterResult =>
    ({ ok: false, refusal: { code, message, ...extra } });

const FIELD_TEXT: Record<FieldName, string> = {
    drawingNumber: '図面番号',
    drawingTitle: '図面名称',
    revision: '版',
    issueDate: '日付',
};

/** A typed row as the model keeps it, or why it cannot be kept. Nothing is trimmed, cut or replaced. */
function rowValues(input: RegisterRowInput, row: number):
    | { ok: true; values: Pick<RegisterEntry, FieldName> }
    | { ok: false; refusal: RegisterRefusal } {
    const problems: FieldProblem[] = [];
    for (const field of FIELD_NAMES) {
        const value = input[field];
        if (typeof value !== 'string') {
            problems.push({ field, part: 'value', problem: { kind: 'EMPTY' } });
            continue;
        }
        const problem = checkFieldValue(value);
        if (problem) problems.push({ field, part: 'value', problem });
    }
    if (problems.length > 0) {
        const first = problems[0];
        return { ok: false, refusal: { code: 'VALUE_INVALID', message: `${row} 行目の${FIELD_TEXT[first.field]}: ${describeProblem(first.problem)}`, row, problems } };
    }
    if (input.drawingNumber.trim() === '') {
        return { ok: false, refusal: { code: 'NUMBER_REQUIRED', message: `${row} 行目の図面番号が空です。図面番号は必ず入力してください。`, row } };
    }
    const optional = (value: string): string | null => (value === '' ? null : value);
    return {
        ok: true,
        values: {
            drawingNumber: input.drawingNumber,
            drawingTitle: optional(input.drawingTitle),
            revision: optional(input.revision),
            issueDate: optional(input.issueDate),
        },
    };
}

/**
 * Declare a typed register on one page of a live Source: a new reference, its
 * basis the Source's bytes now, one MANUAL row per typed row in the order
 * given. The page must be one of the Source's pages. Any row that cannot be
 * kept refuses the whole declaration.
 */
export function declareManualRegister(
    set: DrawingSet,
    request: { sourceId: Uuid; pageNumber: number; rows: readonly RegisterRowInput[] },
    seams: RegisterSeams,
): RegisterResult {
    const source = set.sources.find((s) => s.id === request.sourceId);
    if (!source || !isLive(source)) return refuse('SOURCE_NOT_LIVE', 'このファイルは図面一式から外されているため、図面一覧を宣言できません。');
    const pageLimit = Math.min(source.fingerprint.pageCount, P3_QA_LIMITS.maxPagesPerSource.value);
    if (!Number.isInteger(request.pageNumber) || request.pageNumber < 1 || request.pageNumber > pageLimit) {
        return refuse('PAGE_OUT_OF_RANGE', `ページ番号が範囲外です（1〜${pageLimit}）。`);
    }
    if (request.rows.length === 0) return refuse('NO_ROWS', '図面一覧の行がありません。少なくとも 1 行入力してください。');
    if (request.rows.length > MAX_REGISTER_ENTRIES) {
        return refuse('ROW_LIMIT', `1 つの図面一覧に入力できる行は ${MAX_REGISTER_ENTRIES} 行までです（${request.rows.length} 行）。続きは別の図面一覧として宣言してください。`);
    }
    if (set.drawingRegisterReferences.length + 1 > MAX_REGISTER_REFERENCES) {
        return refuse('REGISTER_LIMIT', `この図面一式で宣言できる図面一覧は ${MAX_REGISTER_REFERENCES} 件までです（取り下げたものも数えます）。`);
    }
    const kept: Pick<RegisterEntry, FieldName>[] = [];
    for (const [index, row] of request.rows.entries()) {
        const checked = rowValues(row, index + 1);
        if (!checked.ok) return { ok: false, refusal: checked.refusal };
        kept.push(checked.values);
    }
    const at = seams.now();
    const reference: DrawingRegisterReference = {
        id: seams.newId(),
        sourceId: source.id,
        pageNumber: request.pageNumber,
        region: null,
        sourceSha256: source.fingerprint.sha256,
        method: 'MANUAL',
        declaredAt: at,
        updatedAt: at,
        retiredAt: null,
        entries: kept.map((values, index) => ({
            id: seams.newId(),
            row: index + 1,
            drawingNumber: values.drawingNumber,
            drawingTitle: values.drawingTitle,
            revision: values.revision,
            issueDate: values.issueDate,
            origin: 'MANUAL',
            retiredAt: null,
        })),
    };
    return { ok: true, drawingSet: { ...set, drawingRegisterReferences: [...set.drawingRegisterReferences, reference] }, referenceId: reference.id };
}

function liveRow(set: DrawingSet, referenceId: Uuid, entryId: Uuid):
    | { ok: true; reference: DrawingRegisterReference; entry: RegisterEntry }
    | { ok: false; result: RegisterResult } {
    const reference = set.drawingRegisterReferences.find((r) => r.id === referenceId);
    if (!reference) return { ok: false, result: refuse('NO_SUCH_REFERENCE', '図面一覧が見つかりません。') };
    if (!isLive(reference)) return { ok: false, result: refuse('REFERENCE_RETIRED', 'この図面一覧は取り下げられています。') };
    const entry = reference.entries.find((e) => e.id === entryId);
    if (!entry) return { ok: false, result: refuse('NO_SUCH_ENTRY', '図面一覧の行が見つかりません。') };
    if (!isLive(entry)) return { ok: false, result: refuse('ENTRY_RETIRED', 'この行は取り下げられています。') };
    return { ok: true, reference, entry };
}

const withReference = (set: DrawingSet, reference: DrawingRegisterReference): DrawingSet => ({
    ...set,
    drawingRegisterReferences: set.drawingRegisterReferences.map((r) => (r.id === reference.id ? reference : r)),
});

/**
 * Correct one live row in place: same id, same row number, the values as
 * typed now. A MANUAL row stays MANUAL; a row read from a table would become
 * EDITED (no such row exists in M7-P3).
 */
export function editRegisterEntry(
    set: DrawingSet,
    request: { referenceId: Uuid; entryId: Uuid; values: RegisterRowInput },
    seams: RegisterSeams,
): RegisterResult {
    const found = liveRow(set, request.referenceId, request.entryId);
    if (!found.ok) return found.result;
    const { reference, entry } = found;
    const checked = rowValues(request.values, entry.row);
    if (!checked.ok) return { ok: false, refusal: checked.refusal };
    if (FIELD_NAMES.every((field) => entry[field] === checked.values[field])) {
        return refuse('NO_CHANGE', '値が変わっていないため、記録しませんでした。', { row: entry.row });
    }
    const at = seams.now();
    const corrected: RegisterEntry = { ...entry, ...checked.values, origin: entry.origin === 'EXTRACTED' ? 'EDITED' : entry.origin };
    return {
        ok: true,
        drawingSet: withReference(set, { ...reference, updatedAt: at, entries: reference.entries.map((e) => (e.id === entry.id ? corrected : e)) }),
        referenceId: reference.id,
        entryId: entry.id,
    };
}

/** Retire one live row. It stays in its reference, retired; a reference may be left with no live row. */
export function retireRegisterEntry(set: DrawingSet, request: { referenceId: Uuid; entryId: Uuid }, seams: RegisterSeams): RegisterResult {
    const found = liveRow(set, request.referenceId, request.entryId);
    if (!found.ok) return found.result;
    const { reference, entry } = found;
    const at = seams.now();
    return {
        ok: true,
        drawingSet: withReference(set, { ...reference, updatedAt: at, entries: reference.entries.map((e) => (e.id === entry.id ? { ...e, retiredAt: at } : e)) }),
        referenceId: reference.id,
        entryId: entry.id,
    };
}

/** Withdraw a live reference. Its rows stay as they were; none of them is live any more. */
export function retireRegisterReference(set: DrawingSet, referenceId: Uuid, seams: RegisterSeams): RegisterResult {
    const reference = set.drawingRegisterReferences.find((r) => r.id === referenceId);
    if (!reference) return refuse('NO_SUCH_REFERENCE', '図面一覧が見つかりません。');
    if (!isLive(reference)) return refuse('REFERENCE_RETIRED', 'この図面一覧はすでに取り下げられています。');
    return { ok: true, drawingSet: withReference(set, { ...reference, retiredAt: seams.now() }), referenceId: reference.id };
}
