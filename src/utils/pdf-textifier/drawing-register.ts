/**
 * The register itself: rows, the review surface, and what may be exported.
 *
 * Two rules shape everything here.
 *
 * **Every page gets a row.** No profile, no text, failed recognition, empty
 * fields -- the row still exists, carrying the reason. There is no path in
 * this module that removes a page from a register.
 *
 * **A row is a candidate until a person confirms it.** Nothing promotes a row
 * except an explicit human confirmation: not a score, not an absence of flags,
 * not a native source. The export gate is a function-level check for exactly
 * this, because a disabled button is a suggestion and this needs to be a rule.
 */

import type {
    ConfirmationRecord, RegisterField, RegisterFieldName, RegisterRow,
    ReviewEntry, RowExtraction,
} from './drawing-register-types';
import { LOW_OCR_SCORE, REGISTER_FIELDS, REVIEW_REASONS } from './drawing-register-types';
import type { WorkbookResult } from './excel';
import { buildWorkbook } from './excel';

/**
 * The display value proposed from raw extracted text.
 *
 * A title-block cell holds its label above its value, so the raw text of a
 * drawing-number cell is "図面番号\nA-101". The last non-empty line is the
 * value in every layout we have measured, and it is a rule that a layout
 * putting the label underneath would defeat.
 *
 * So this is a *view*. It never replaces the raw text, and the reviewer is
 * shown both.
 */
export function displayValue(rawText: string): string {
    const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    return lines.length > 0 ? lines[lines.length - 1] : '';
}

function emptyField(): RegisterField {
    return { rawText: '', value: '', source: 'none', ocrScore: null, wordCount: null, reviewReasons: [] };
}

export function emptyRow(pageNumber: number): RegisterRow {
    return {
        pageNumber,
        profileId: null,
        fields: Object.fromEntries(REGISTER_FIELDS.map((name) => [name, emptyField()])) as Record<RegisterFieldName, RegisterField>,
        reviewReasons: [],
        reviewStatus: 'unconfirmed',
        extraction: 'none',
    };
}

/** What extraction produced for one field, before it becomes a candidate. */
export interface FieldExtraction {
    /**
     * The extraction layer's output for this field, before any display
     * transformation. Native tokens or recognised words, grouped into lines
     * and joined. Not the byte stream, not the recogniser's internals.
     *
     * It arrives here as-is and is stored as-is. No trim, no normalisation:
     * that work belongs at the extraction boundary, and once past it the raw
     * text is evidence rather than data to tidy.
     */
    rawText: string;
    source: RegisterField['source'];
    ocrScore?: number | null;
    wordCount?: number | null;
}

/**
 * Build one candidate row.
 *
 * `profileAssigned: false` produces the row a page gets when nobody has said
 * which template it uses -- empty, unconfirmed, and carrying its own reason.
 * That reason is deliberately not the same as a template that was applied and
 * found nothing: one is a question for a person, the other is a result.
 */
export function buildRow(options: {
    pageNumber: number;
    profileId?: string | null;
    profileAssigned?: boolean;
    fields?: Partial<Record<RegisterFieldName, FieldExtraction>>;
    ocrFailed?: boolean;
    deriveValue?: (rawText: string) => string;
}): RegisterRow {
    const {
        pageNumber, profileId = null, profileAssigned = true,
        fields = {}, ocrFailed = false, deriveValue = displayValue,
    } = options;

    const row = emptyRow(pageNumber);
    row.profileId = profileId;

    if (!profileAssigned) {
        row.reviewReasons.push(REVIEW_REASONS.NO_PROFILE_ASSIGNED);
        row.extraction = 'unassigned';
        return row;
    }

    const sources = new Set<RegisterField['source']>();
    for (const name of REGISTER_FIELDS) {
        const found = fields[name];
        const field = row.fields[name];
        field.rawText = found?.rawText ?? '';
        field.value = deriveValue(field.rawText);
        field.source = found?.source ?? 'none';
        field.ocrScore = typeof found?.ocrScore === 'number' ? found.ocrScore : null;
        field.wordCount = typeof found?.wordCount === 'number' ? found.wordCount : null;
        if (found?.source) sources.add(found.source);

        if (field.value === '') {
            field.reviewReasons.push(REVIEW_REASONS.NO_TEXT_IN_FIELD);
        } else if (field.ocrScore !== null && field.ocrScore < LOW_OCR_SCORE) {
            field.reviewReasons.push(REVIEW_REASONS.LOW_OCR_SCORE);
        }
        row.reviewReasons.push(...field.reviewReasons);
    }

    if (ocrFailed) row.reviewReasons.unshift(REVIEW_REASONS.OCR_FAILED);

    const used = [...sources].filter((source) => source !== 'none');
    row.extraction = used.length === 0 ? 'none' : used.length === 1 ? used[0] : 'mixed';
    return row;
}

/**
 * Rows sharing a drawing number, by exact match after trimming.
 *
 * `A-101` and `A101` are deliberately *not* merged. On a real issue they may
 * be two different sheets, and a tool that quietly merges them has made a
 * decision the user never saw. Report what is certainly the same; ask about
 * the rest.
 */
export function findDuplicates(rows: RegisterRow[]): { number: string; pages: number[] }[] {
    const seen = new Map<string, number[]>();
    for (const row of rows) {
        const key = row.fields.drawing_number.value.trim();
        if (key === '') continue;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key)!.push(row.pageNumber);
    }
    return [...seen.entries()]
        .filter(([, pages]) => pages.length > 1)
        .map(([number, pages]) => ({ number, pages }));
}

/** Fold the register-level checks back into the rows they concern. */
export function annotateRegister(rows: RegisterRow[]): RegisterRow[] {
    const duplicates = findDuplicates(rows);
    const duplicatePages = new Set(duplicates.flatMap((d) => d.pages));
    for (const row of rows) {
        const already = row.reviewReasons.includes(REVIEW_REASONS.DUPLICATE_NUMBER);
        if (duplicatePages.has(row.pageNumber) && !already) {
            row.reviewReasons.push(REVIEW_REASONS.DUPLICATE_NUMBER);
        }
    }
    return rows;
}

/**
 * Every row, in the order a reviewer should walk them.
 *
 * *Every* row, and that is the point rather than an oversight. Returning only
 * flagged rows turns "nothing flagged" into "nothing to check", and the rows
 * it hides are the ones a score cannot help with: a value read confidently and
 * wrongly carries no flag at all. A surface that cannot show that row is not a
 * surface a person can confirm a register from.
 *
 * Flags and scores decide the order. They never decide membership.
 */
export function reviewSurface(rows: RegisterRow[]): ReviewEntry[] {
    return rows
        .map((row) => {
            const scores = REGISTER_FIELDS
                .map((name) => row.fields[name].ocrScore)
                .filter((score): score is number => score !== null);
            return {
                pageNumber: row.pageNumber,
                reasons: row.reviewReasons,
                needsAttention: row.reviewReasons.length > 0,
                reviewStatus: row.reviewStatus,
                lowestScore: scores.length > 0 ? Math.min(...scores) : null,
            };
        })
        .sort((a, b) => b.reasons.length - a.reasons.length
            || (a.lowestScore ?? 101) - (b.lowestScore ?? 101)
            || a.pageNumber - b.pageNumber);
}

/**
 * The flagged subset, for a UI that wants to lead with the doubtful rows.
 *
 * An ordering aid, not a work list. Emptying it finishes nothing, and no part
 * of this module treats an empty attention queue as a completed review.
 */
export function attentionQueue(rows: RegisterRow[]): ReviewEntry[] {
    return reviewSurface(rows).filter((entry) => entry.needsAttention);
}

/**
 * A row a person has looked at and accepted.
 *
 * Takes the values as edited, and records what was extracted alongside them.
 * `rawText` is carried through untouched: a confirmed row that no longer knows
 * what was on the page cannot be audited, and "the human agreed" is a
 * different record from "this is what the sheet said".
 */
export function confirmRow(row: RegisterRow, edits: Partial<Record<RegisterFieldName, string>> = {}): RegisterRow {
    const fields = {} as Record<RegisterFieldName, RegisterField>;
    const raw = {} as Record<RegisterFieldName, string>;
    const proposed = {} as Record<RegisterFieldName, string>;
    const final = {} as Record<RegisterFieldName, string>;
    const editedFields: RegisterFieldName[] = [];

    for (const name of REGISTER_FIELDS) {
        const field = row.fields[name];
        const value = (edits[name] ?? field.value).trim();
        raw[name] = field.rawText;
        proposed[name] = field.value;
        final[name] = value;
        if (value !== field.value) editedFields.push(name);
        fields[name] = { ...field, rawText: field.rawText, value };
    }

    const confirmation: ConfirmationRecord = {
        confirmedAt: Date.now(), raw, proposed, final, editedFields,
    };
    return { ...row, fields, reviewStatus: 'confirmed', confirmation };
}

/** Put a row back to unconfirmed, because something it depended on changed. */
export function invalidateRow(row: RegisterRow): RegisterRow {
    if (row.reviewStatus === 'unconfirmed') return row;
    const { confirmation, ...rest } = row;
    void confirmation;
    return { ...rest, reviewStatus: 'unconfirmed' };
}

export interface ExportReadiness {
    ready: boolean;
    pageCount: number;
    rowCount: number;
    confirmedCount: number;
    unconfirmedPages: number[];
    missingPages: number[];
    reason: string | null;
}

/**
 * Whether this register may be exported.
 *
 * The rule is `confirmed rows === PDF pages`, and it is checked here rather
 * than only in the UI. A disabled button is a suggestion; a caller that
 * reaches the export function directly must get the same answer, or the gate
 * is decoration.
 */
export function exportReadiness(rows: RegisterRow[], pageCount: number): ExportReadiness {
    const byPage = new Map(rows.map((row) => [row.pageNumber, row]));
    const missingPages: number[] = [];
    for (let page = 1; page <= pageCount; page++) {
        if (!byPage.has(page)) missingPages.push(page);
    }
    const unconfirmedPages = rows
        .filter((row) => row.reviewStatus !== 'confirmed')
        .map((row) => row.pageNumber)
        .sort((a, b) => a - b);
    const confirmedCount = rows.length - unconfirmedPages.length;

    let reason: string | null = null;
    if (missingPages.length > 0) {
        reason = `${missingPages.length}ページ分の行がありません（ページ ${missingPages.slice(0, 5).join(', ')}${missingPages.length > 5 ? ' ほか' : ''}）`;
    } else if (unconfirmedPages.length > 0) {
        reason = `未確認の行が${unconfirmedPages.length}件あります（ページ ${unconfirmedPages.slice(0, 5).join(', ')}${unconfirmedPages.length > 5 ? ' ほか' : ''}）`;
    }

    return {
        ready: reason === null && pageCount > 0,
        pageCount,
        rowCount: rows.length,
        confirmedCount,
        unconfirmedPages,
        missingPages,
        reason,
    };
}

/** Column headings of the exported sheet, in order. */
export const REGISTER_COLUMNS = ['ページ', '図面番号', '図面名称', '版', '日付'] as const;

export const REGISTER_SHEET_NAME = 'Drawing Register';

/**
 * The register as a grid for the workbook writer.
 *
 * Everything is a string, including the page number: this workbook is a
 * document list, and a drawing number like `001` that arrives as a number has
 * already lost the thing that identifies it.
 */
export function registerGrid(rows: RegisterRow[]): string[][] {
    const ordered = [...rows].sort((a, b) => a.pageNumber - b.pageNumber);
    return [
        [...REGISTER_COLUMNS],
        ...ordered.map((row) => [
            String(row.pageNumber),
            row.fields.drawing_number.value,
            row.fields.drawing_title.value,
            row.fields.revision.value,
            row.fields.revision_date.value,
        ]),
    ];
}

/** `plan.pdf` becomes `plan_drawing_register.xlsx`. */
export function registerFileName(sourceName: string): string {
    const base = sourceName.replace(/\.pdf$/i, '').trim() || 'drawing';
    return `${base}_drawing_register.xlsx`;
}

/**
 * Build the register workbook.
 *
 * The readiness check is repeated here rather than trusted to the caller. A
 * disabled button is a suggestion; this is the rule, and a caller that reaches
 * this function by any other route gets the same answer.
 */
export async function buildRegisterWorkbook(
    rows: RegisterRow[], pageCount: number, options: { shouldCancel?: () => boolean } = {},
): Promise<WorkbookResult> {
    const readiness = exportReadiness(rows, pageCount);
    if (!readiness.ready) {
        throw new Error(readiness.reason ?? '確認済みの行がありません。');
    }
    const grid = registerGrid(rows);
    return buildWorkbook([{
        id: 'drawing-register',
        pageNumber: 1,
        sheetName: REGISTER_SHEET_NAME,
        rows: grid.length,
        cols: REGISTER_COLUMNS.length,
        grid,
        source: null,
        status: 'GRID_CONFIDENT',
        structureScore: 100,
    }], options);
}

/** A summary a caller can show without walking the rows itself. */
export function registerSummary(rows: RegisterRow[]): {
    total: number;
    confirmed: number;
    flagged: number;
    unassigned: number;
    bySource: Record<RowExtraction, number>;
} {
    const bySource = { native: 0, ocr: 0, mixed: 0, none: 0, unassigned: 0 } as Record<RowExtraction, number>;
    for (const row of rows) bySource[row.extraction] += 1;
    return {
        total: rows.length,
        confirmed: rows.filter((row) => row.reviewStatus === 'confirmed').length,
        flagged: rows.filter((row) => row.reviewReasons.length > 0).length,
        unassigned: rows.filter((row) => row.extraction === 'unassigned').length,
        bySource,
    };
}
