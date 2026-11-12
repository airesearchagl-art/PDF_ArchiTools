/**
 * The bounds on what M7-P2 records, and the one place that decides whether a
 * piece of text can be recorded at all.
 *
 * Text a machine read, or a person typed, is recorded exactly or not at all.
 * Nothing here shortens it, drops a character from it or puts one in: a value
 * cut at its limit looks complete and is not, and a person who confirms it has
 * confirmed something the sheet does not say. The one change made is to line
 * endings in a field's raw text -- CRLF and CR become LF -- which the contract
 * requires and which loses nothing.
 *
 * Lengths are counted as JSON Schema counts them: code points, not UTF-16
 * units. The character rules are the schema's own (FieldValue, FieldRawText,
 * Name), plus one it cannot state: an unpaired surrogate is refused, because
 * it does not survive being written as UTF-8 and so could not be recorded
 * faithfully.
 */
import { P1_INTAKE_LIMITS } from './intake-policy';
import type { FieldName } from './model';

type LimitStatus = 'HUMAN_ADOPTED' | 'CANONICAL_PRE_RELEASE_CANDIDATE';

interface P2Limit {
    value: number;
    /** The schema's `x-limit` name for this bound. */
    xLimit: string;
    status: LimitStatus;
}

/**
 * The bounds M7-P2 enforces, refusing anything past them. Each equals the
 * canonical schema (the contract gate checks it); only maxFieldRawTextLength
 * is Human-adopted, the rest are pre-release candidates.
 */
export const P2_METADATA_LIMITS = {
    /** FieldRawText.maxLength. Human-adopted (Architecture v1 decision 5). */
    maxFieldRawTextLength: { value: 1000, xLimit: 'maxFieldRawTextLength', status: 'HUMAN_ADOPTED' },
    /** FieldValue.maxLength. */
    maxFieldValueLength: { value: 300, xLimit: 'maxFieldValueLength', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Name.maxLength: a profile's name. */
    maxNameLength: { value: 200, xLimit: 'maxNameLength', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** DrawingSet.titleBlockProfiles.maxItems, retired profiles included. */
    maxProfiles: { value: 64, xLimit: 'maxProfiles', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** DrawingSet.analysisRuns.maxItems. */
    maxAnalysisRuns: { value: 2000, xLimit: 'maxAnalysisRuns', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Sheet.confirmationHistory.maxItems. */
    maxConfirmationHistoryPerSheet: { value: 32, xLimit: 'maxConfirmationHistoryPerSheet', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
} as const satisfies Record<string, P2Limit>;

export const MAX_FIELD_RAW_TEXT_LENGTH = P2_METADATA_LIMITS.maxFieldRawTextLength.value;
export const MAX_FIELD_VALUE_LENGTH = P2_METADATA_LIMITS.maxFieldValueLength.value;
export const MAX_NAME_LENGTH = P2_METADATA_LIMITS.maxNameLength.value;
export const MAX_PROFILES = P2_METADATA_LIMITS.maxProfiles.value;
export const MAX_ANALYSIS_RUNS = P2_METADATA_LIMITS.maxAnalysisRuns.value;
export const MAX_CONFIRMATION_HISTORY = P2_METADATA_LIMITS.maxConfirmationHistoryPerSheet.value;
/** A profile revision's format bound (TitleBlockProfile.revision.maximum); not an x-limit. */
export const MAX_PROFILE_REVISION = 1_000_000;

/**
 * The bounds on what M7-P3 writes: a QA run with its Findings, a Review
 * Decision, a typed drawing register (CAN-03 R4.1-L). Past any of them the
 * whole operation is refused and nothing is written; nothing is cut short,
 * left out or deleted to make room, and none is raised here. Each equals the
 * canonical schema (the contract gate checks it); all are pre-release
 * candidates. The ones another phase already enforces are that phase's own
 * entries, so the two can never differ.
 */
export const P3_QA_LIMITS = {
    /** DrawingSet.analysisRuns.maxItems: EXTRACTION and QA runs together. */
    maxAnalysisRuns: P2_METADATA_LIMITS.maxAnalysisRuns,
    /** DrawingSet.findings.maxItems, every lifecycle state: Findings are never deleted. */
    maxFindings: { value: 50000, xLimit: 'maxFindings', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** DrawingSet.decisions.maxItems (ReviewDecision.sequence.maximum follows). */
    maxDecisions: { value: 100000, xLimit: 'maxDecisions', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Finding.sheetIds / Finding.registerEntryIds .maxItems. */
    maxSubjectsPerFinding: { value: 5000, xLimit: 'maxSubjectsPerFinding', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Finding.sourceIds / Finding.basis .maxItems; also DrawingSet.sources. */
    maxSources: P1_INTAKE_LIMITS.maxSources,
    /** AnalysisRun.coverage.sheetsEvaluated / sheetsExcluded .maximum; also DrawingSet.sheets. */
    maxSheets: P1_INTAKE_LIMITS.maxSheets,
    /** DrawingSet.drawingRegisterReferences.maxItems, retired references included. */
    maxRegisterReferences: { value: 64, xLimit: 'maxRegisterReferences', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** DrawingRegisterReference.entries.maxItems and RegisterEntry.row.maximum. */
    maxRegisterEntriesPerReference: { value: 1000, xLimit: 'maxRegisterEntriesPerReference', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** DrawingRegisterReference.pageNumber.maximum. */
    maxPagesPerSource: P1_INTAKE_LIMITS.maxPagesPerSource,
    /** Comment.maxLength: a Review Decision's comment. */
    maxCommentLength: { value: 4000, xLimit: 'maxCommentLength', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
} as const;

export const MAX_FINDINGS = P3_QA_LIMITS.maxFindings.value;
export const MAX_DECISIONS = P3_QA_LIMITS.maxDecisions.value;
export const MAX_SUBJECTS_PER_FINDING = P3_QA_LIMITS.maxSubjectsPerFinding.value;
export const MAX_REGISTER_REFERENCES = P3_QA_LIMITS.maxRegisterReferences.value;
export const MAX_REGISTER_ENTRIES = P3_QA_LIMITS.maxRegisterEntriesPerReference.value;
export const MAX_COMMENT_LENGTH = P3_QA_LIMITS.maxCommentLength.value;

/**
 * The schema's character classes, as the text of a regular-expression class.
 * The contract gate rebuilds each schema pattern from these and compares.
 * Single-line text (FieldValue, Name) refuses every control character; a raw
 * field text (FieldRawText) keeps its line feeds.
 */
export const SINGLE_LINE_FORBIDDEN_CLASS = '\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069';
export const RAW_TEXT_FORBIDDEN_CLASS = '\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069';
/** A Review Decision's comment (Comment): line feeds and tabs kept. */
export const COMMENT_FORBIDDEN_CLASS = '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069';

export type CharacterClass = 'CONTROL' | 'LINE_SEPARATOR' | 'BIDI_CONTROL' | 'UNPAIRED_SURROGATE';

export type TextProblem =
    | { kind: 'EMPTY' }
    | { kind: 'TOO_LONG'; length: number; limit: number }
    | { kind: 'INVALID_CHARACTER'; codePoint: number; characterClass: CharacterClass };

/** Characters, as JSON Schema counts them. */
export const codePointLength = (text: string): number => Array.from(text).length;

function classOf(codePoint: number, allowLineFeed: boolean, allowTab = false): CharacterClass | null {
    if (codePoint === 0x0a && allowLineFeed) return null;
    if (codePoint === 0x09 && allowTab) return null;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 'CONTROL';
    if (codePoint === 0x2028 || codePoint === 0x2029) return 'LINE_SEPARATOR';
    if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069)) return 'BIDI_CONTROL';
    // Iterating a string yields a lone surrogate as its own code point; a
    // well-formed pair arrives as one astral code point and never lands here.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 'UNPAIRED_SURROGATE';
    return null;
}

/** The first character that cannot be recorded, or null. */
export function firstForbiddenCharacter(
    text: string, options: { allowLineFeed: boolean; allowTab?: boolean },
): { codePoint: number; characterClass: CharacterClass } | null {
    for (const character of text) {
        const codePoint = character.codePointAt(0)!;
        const characterClass = classOf(codePoint, options.allowLineFeed, options.allowTab);
        if (characterClass) return { codePoint, characterClass };
    }
    return null;
}

function check(text: string, limit: number, allowLineFeed: boolean, allowTab = false): TextProblem | null {
    const forbidden = firstForbiddenCharacter(text, { allowLineFeed, allowTab });
    if (forbidden) return { kind: 'INVALID_CHARACTER', ...forbidden };
    const length = codePointLength(text);
    if (length > limit) return { kind: 'TOO_LONG', length, limit };
    return null;
}

/** A field value: one line, at most 300 characters. Empty is a value. */
export const checkFieldValue = (value: string): TextProblem | null =>
    check(value, MAX_FIELD_VALUE_LENGTH, false);

/** What was read inside one field rectangle: line feeds kept, at most 1000 characters. */
export const checkFieldRawText = (rawText: string): TextProblem | null =>
    check(rawText, MAX_FIELD_RAW_TEXT_LENGTH, true);

/**
 * A Review Decision's comment: line feeds and tabs kept, at most 4000
 * characters, may be empty. Call it on text whose line endings were already
 * made LF (normaliseLineEndings): a CR is a control character here.
 */
export const checkComment = (comment: string): TextProblem | null =>
    check(comment, MAX_COMMENT_LENGTH, true, true);

/** A profile's name: one line, 1 to 200 characters, not blank. */
export function checkName(name: string): TextProblem | null {
    if (name.trim() === '') return { kind: 'EMPTY' };
    return check(name, MAX_NAME_LENGTH, false);
}

/** CRLF and lone CR become LF. The only change ever made to recorded text. */
export const normaliseLineEndings = (text: string): string => text.replace(/\r\n?/g, '\n');

/** Why one field of a reading could not be recorded. Counts and a code point only, never the text. */
export interface FieldProblem {
    field: FieldName;
    part: 'rawText' | 'value' | 'ocrScore' | 'source';
    problem: TextProblem | { kind: 'OUT_OF_RANGE' };
}

/** A short Japanese description of a problem, for a person. Never quotes the text. */
export function describeProblem(problem: FieldProblem['problem']): string {
    switch (problem.kind) {
        case 'EMPTY':
            return '空にはできません。';
        case 'TOO_LONG':
            return `${problem.limit}文字を超えています（${problem.length}文字）。`;
        case 'INVALID_CHARACTER': {
            const hex = `U+${problem.codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
            const label = {
                CONTROL: '制御文字',
                LINE_SEPARATOR: '改行・区切り文字',
                BIDI_CONTROL: '双方向制御文字',
                UNPAIRED_SURROGATE: '対になっていないサロゲート',
            }[problem.characterClass];
            return `使用できない文字（${hex} ${label}）が含まれています。`;
        }
        case 'OUT_OF_RANGE':
            return '値が範囲外です。';
    }
}
