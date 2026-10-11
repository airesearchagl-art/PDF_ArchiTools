/**
 * The M7 side of the Drawing Register's extraction engine.
 *
 * `extractRegister` (src/utils/pdf-textifier) is the one way M7 reads a title
 * block; this module only translates, in both directions, and changes nothing
 * in the engine. What it owns is the boundary:
 *  - names: the engine's `drawing_number`, `drawing_title`, `revision`,
 *    `revision_date` are the contract's `drawingNumber`, `drawingTitle`,
 *    `revision`, `issueDate` (Architecture v1 decision 8: the revision date is
 *    the issue date);
 *  - profiles: an M7 profile, with its UUID and its own revision, becomes the
 *    engine's TemplateProfile under that same UUID. The engine stamps one
 *    arrangement number on every row; M7 does not use it, and records instead
 *    the profile and revision each Sheet was read under;
 *  - scope: the engine walks every page of a document and returns a row for
 *    each. Only the Sheets a run targets are given an assignment, so every
 *    other page costs nothing and comes back as an unassigned row, which is
 *    dropped -- an unassigned page never becomes an observation;
 *  - what is kept: the four fields' raw text, value, source and score. Not the
 *    engine's row, its tokens, word counts, words that fell outside every
 *    field, or anything else of the page.
 *
 * And the bounds (field-bounds.ts): a field's raw text is recorded with its
 * line endings made LF and nothing else changed; its value is the engine's own
 * `displayValue` of that text. If any field of a Sheet cannot be recorded --
 * too long, a character the contract refuses -- the Sheet gets no observation
 * at all, and the reason says which field and why, never what it said.
 */
import { displayValue } from '../pdf-textifier/drawing-register';
import { AssignmentSet } from '../pdf-textifier/drawing-register-template';
import type { RegisterFieldName, RegisterRow, TemplateProfile } from '../pdf-textifier/drawing-register-types';
import { REVIEW_REASONS } from '../pdf-textifier/drawing-register-types';
import type { FieldProblem } from './field-bounds';
import { checkFieldRawText, checkFieldValue, normaliseLineEndings } from './field-bounds';
import type {
    FieldName, FieldSource, Observation, ObservedField, ProfileBasis, Sha256Hex, TitleBlockProfile, Uuid,
} from './model';
import { FIELD_NAMES } from './model';

/** Contract field -> engine field. */
export const ENGINE_FIELD: Record<FieldName, RegisterFieldName> = {
    drawingNumber: 'drawing_number',
    drawingTitle: 'drawing_title',
    revision: 'revision',
    issueDate: 'revision_date',
};

const SOURCES: readonly FieldSource[] = ['native', 'ocr', 'none'];

/**
 * The engine's profile for an M7 profile. Same id, same rectangles, same
 * transfer model, same reference size; the engine needs nothing else.
 */
export function toTemplateProfile(profile: TitleBlockProfile): TemplateProfile {
    return {
        id: profile.id,
        name: profile.name,
        model: profile.transferModel,
        sourcePage: {
            // The engine transfers from the reference size only; the page it
            // was drawn on is not part of an M7 profile.
            pageNumber: 0,
            uprightWidth: profile.referencePage.uprightWidthPt,
            uprightHeight: profile.referencePage.uprightHeightPt,
        },
        fields: Object.fromEntries(FIELD_NAMES.map((name) => {
            const { left, top, right, bottom } = profile.fields[name];
            return [ENGINE_FIELD[name], { left, top, right, bottom }];
        })) as TemplateProfile['fields'],
        createdAt: Date.parse(profile.createdAt),
    };
}

/** Assignments for exactly these pages of one document, and no others. */
export function assignmentsFor(pages: readonly { pageNumber: number; profileId: Uuid }[]): AssignmentSet {
    const assignments = new AssignmentSet();
    for (const { pageNumber, profileId } of pages) {
        const { conflicts } = assignments.assign([pageNumber], profileId);
        if (conflicts.length > 0) throw new Error(`page ${pageNumber} targeted twice`);
    }
    return assignments;
}

export type RowConversion =
    | { ok: true; observation: Observation }
    | { ok: false; problems: FieldProblem[] };

/**
 * One engine row as an observation of one Sheet, or why it cannot be one.
 * `basis` is what the run recorded when it started: the run, the bytes it
 * verified, and the profile revision the Sheet was assigned under.
 */
export function observationFromRow(
    row: RegisterRow,
    basis: { runId: Uuid; sourceSha256: Sha256Hex; profile: ProfileBasis },
): RowConversion {
    if (row.profileId !== basis.profile.profileId || row.extraction === 'unassigned') {
        throw new Error(`page ${row.pageNumber} was not read under the profile it was assigned`);
    }
    const problems: FieldProblem[] = [];
    const fields = {} as Record<FieldName, ObservedField>;
    for (const name of FIELD_NAMES) {
        const read = row.fields[ENGINE_FIELD[name]];
        const rawText = normaliseLineEndings(read.rawText);
        const value = displayValue(rawText);
        const rawProblem = checkFieldRawText(rawText);
        if (rawProblem) problems.push({ field: name, part: 'rawText', problem: rawProblem });
        const valueProblem = checkFieldValue(value);
        if (valueProblem) problems.push({ field: name, part: 'value', problem: valueProblem });
        if (!SOURCES.includes(read.source)) problems.push({ field: name, part: 'source', problem: { kind: 'OUT_OF_RANGE' } });
        const score = read.ocrScore;
        if (score !== null && !(Number.isInteger(score) && score >= 0 && score <= 100)) {
            problems.push({ field: name, part: 'ocrScore', problem: { kind: 'OUT_OF_RANGE' } });
        }
        fields[name] = { value, rawText, source: read.source, ocrScore: score };
    }
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        observation: {
            runId: basis.runId,
            sourceSha256: basis.sourceSha256,
            profile: { profileId: basis.profile.profileId, profileRevision: basis.profile.profileRevision },
            status: row.reviewReasons.includes(REVIEW_REASONS.OCR_FAILED) ? 'OCR_FAILED' : 'READ',
            fields,
        },
    };
}
