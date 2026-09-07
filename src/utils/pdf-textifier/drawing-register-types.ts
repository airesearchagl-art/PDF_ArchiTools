/**
 * Types for the drawing register.
 *
 * A register is one row per PDF page, carrying four fields read out of the
 * sheet's title block. Everything geometric here lives in *upright page space*
 * -- origin top-left of the page as it would be without its `/Rotate`, y
 * downwards, PDF points at scale 1 -- the same single space the table work
 * uses, for the same reason: a rectangle drawn in one space and a token found
 * in another do not describe the same field.
 *
 * Two rules run through all of it, and they are the reason for most of the
 * shapes below.
 *
 * **Every page gets a row.** A page with no profile, no text, failed OCR or
 * empty fields still produces a row carrying the reason. A register that is
 * quietly missing a sheet is worse than one that says it does not know,
 * because nobody checks for the sheet that is not there.
 *
 * **A row is a candidate until a person says otherwise.** Confidence never
 * promotes a row; it only decides what a reviewer is shown first.
 */

import type { SelectionRect } from './table-types';

/** The four fields this workflow reads. Not extensible in this release. */
export const REGISTER_FIELDS = [
    'drawing_number',
    'drawing_title',
    'revision',
    'revision_date',
] as const;

export type RegisterFieldName = (typeof REGISTER_FIELDS)[number];

/** What each field is called on screen. */
export const FIELD_LABELS: Record<RegisterFieldName, string> = {
    drawing_number: '図面番号',
    drawing_title: '図面名称',
    revision: '版',
    revision_date: '日付',
};

/**
 * How a template's rectangles move to a sheet of a different size.
 *
 * Two conventions exist in real drawing sets and neither can be inferred:
 *
 *   normalised       the title block is a fraction of the sheet, so it grows
 *                    with the paper.
 *   corner-anchored  the title block is a fixed physical size anchored to a
 *                    corner, so it stays put as the paper grows.
 *
 * The measurement behind this is unambiguous: each model reads its own
 * convention almost completely and the other one almost not at all. So the
 * model is part of what a person confirms, never something guessed from the
 * page.
 */
export type TransferModel = 'normalised' | 'corner-anchored';

export const TRANSFER_MODEL_LABELS: Record<TransferModel, string> = {
    normalised: '用紙サイズに比例（表題欄が用紙と一緒に拡大縮小する）',
    'corner-anchored': '実寸固定（表題欄の大きさが用紙によらず同じ）',
};

/** Where a field's text came from. Recorded per field, never per page. */
export type FieldSource = 'native' | 'ocr' | 'none';

/**
 * A named set of field rectangles, plus how they transfer.
 *
 * `sourcePage` records the page the rectangles were drawn on and its upright
 * size, because both models need the original to transfer from.
 */
export interface TemplateProfile {
    id: string;
    name: string;
    model: TransferModel;
    sourcePage: {
        pageNumber: number;
        uprightWidth: number;
        uprightHeight: number;
    };
    /** All four are required; a profile missing one cannot be saved. */
    fields: Record<RegisterFieldName, SelectionRect>;
    createdAt: number;
}

/**
 * A page belongs to a profile because a person said so.
 *
 * `confirmedAt` is not decoration. An assignment nobody made is the thing this
 * structure exists to prevent, so the moment it was made is recorded with it.
 */
export interface PageAssignment {
    pageNumber: number;
    profileId: string;
    confirmedAt: number;
}

/** Why a row or field needs a person before it can be trusted. */
export const REVIEW_REASONS = {
    NO_PROFILE_ASSIGNED: 'このページに割り当てられたプロファイルがありません',
    NO_TEXT_IN_FIELD: '値が読み取れませんでした',
    LOW_OCR_SCORE: 'OCRの内部スコアが低いフィールドがあります',
    OCR_FAILED: 'このページの文字認識に失敗しました',
    DUPLICATE_NUMBER: 'この図面番号は他のページにもあります',
} as const;

/**
 * Below this, a field is flagged for attention.
 *
 * This is a sort key and nothing else. It never accepts a value, never
 * confirms a row, and is not a probability that the value is correct -- it is
 * the recogniser's own score for its own output. A value above it is exactly
 * as unconfirmed as a value below it.
 */
export const LOW_OCR_SCORE = 70;

/**
 * One field of one row.
 *
 * `rawText` and `value` are both kept, and the distinction is load-bearing.
 * `rawText` is what the extraction layer produced for this field before any
 * display transformation -- not the PDF byte stream, not the recogniser's
 * internal structure. Whitespace grouping happens at that boundary (tokens or
 * words grouped into lines) and nowhere after it. From here on it does not
 * change: not trimmed, not normalised, not replaced by an edit.
 *
 * `value` is a guess made from `rawText`, which is why the raw text has to
 * survive. When a reviewer sees a wrong drawing number the question is always
 * "what does the sheet actually say", and a row that has thrown that away
 * cannot answer.
 */
export interface RegisterField {
    rawText: string;
    value: string;
    source: FieldSource;
    /** The recogniser's own score, 0-100, or null when it did not run. */
    ocrScore: number | null;
    wordCount: number | null;
    reviewReasons: string[];
}

export type RowStatus = 'unconfirmed' | 'confirmed';

/** How a row's values were obtained, as a summary over its fields. */
export type RowExtraction = 'native' | 'ocr' | 'mixed' | 'none' | 'unassigned';

/** What a person changed, kept so a confirmed row can be audited. */
export interface ConfirmationRecord {
    confirmedAt: number;
    raw: Record<RegisterFieldName, string>;
    proposed: Record<RegisterFieldName, string>;
    final: Record<RegisterFieldName, string>;
    editedFields: RegisterFieldName[];
}

export interface RegisterRow {
    pageNumber: number;
    /** Null when no profile covers this page. The row still exists. */
    profileId: string | null;
    /**
     * Which set of profiles and assignments this row was read under.
     *
     * A row is only meaningful against the arrangement that produced it. Change
     * a profile's rectangles, move a page to another profile, delete a profile
     * -- and the values in every row read under the old arrangement describe
     * something that no longer exists. Taking the confirmation off is not
     * enough, because the stale values are still sitting there to be confirmed
     * again.
     *
     * So the arrangement carries a number, the row records it, and the export
     * refuses a register whose rows were not all read under the current one.
     */
    sourceRevision: number;
    fields: Record<RegisterFieldName, RegisterField>;
    /** Reasons that concern the row rather than one field. */
    reviewReasons: string[];
    reviewStatus: RowStatus;
    extraction: RowExtraction;
    confirmation?: ConfirmationRecord;
}

/** A row as the review surface presents it. */
export interface ReviewEntry {
    pageNumber: number;
    reasons: string[];
    needsAttention: boolean;
    reviewStatus: RowStatus;
    lowestScore: number | null;
}

/** What one extraction run cost, for the gates to assert on. */
export interface ExtractionStats {
    pages: number;
    assignedPages: number;
    unassignedPages: number;
    ocrCalls: number;
    ocrPixels: number;
    maxRegionPixels: number;
    ms: number;
}

export interface RegisterExtractionResult {
    rows: RegisterRow[];
    stats: ExtractionStats;
    /** The arrangement these rows were read under. */
    sourceRevision: number;
}
