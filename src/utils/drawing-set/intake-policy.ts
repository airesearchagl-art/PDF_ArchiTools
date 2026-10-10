/**
 * M7-P1 PDF intake gate: what a file must satisfy before the Drawing Set
 * spends anything on it, and the bounds the in-memory model keeps to.
 *
 * Every number here is traceable to the canonical contract,
 * contracts/m7/portable-project.schema.json, by the `x-limit` name next to it.
 * scripts/smoke-m7-p1.mjs reads that schema and fails if a value here drifts
 * from it; the schema itself is never loaded into the app.
 *
 * Two kinds of value, kept apart on purpose:
 *  - maxSourceBytes, 256 MiB, is the per-source ceiling Human-adopted for M6,
 *    which M7 Architecture v1 (decision 7) lets M7 reuse. P1 reuses it as its
 *    own PDF intake gate.
 *  - every other number is the contract's current canonical PRE-RELEASE bound
 *    (a candidate until M7-P4 freezes it). None of them is a product guarantee,
 *    and nothing user-facing should present them as one.
 */

export type LimitStatus =
    /** M6's adopted per-source ceiling, reused by the M7-P1 intake gate. */
    | 'M6_ADOPTED_REUSED_BY_P1'
    /** The canonical contract's current pre-release bound; not frozen. */
    | 'CANONICAL_PRE_RELEASE_CANDIDATE';

export interface P1Limit {
    readonly value: number;
    /** The `x-limit` name the schema marks this bound with. */
    readonly xLimit: string;
    readonly status: LimitStatus;
}

export const P1_INTAKE_LIMITS = {
    /** Bytes of one Source. SourceFingerprint.byteLength.maximum. */
    maxSourceBytes: { value: 268_435_456, xLimit: 'maxSourceBytes', status: 'M6_ADOPTED_REUSED_BY_P1' },
    /** Sources the Drawing Set holds, retired ones included. DrawingSet.sources.maxItems. */
    maxSources: { value: 5000, xLimit: 'maxSources', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Sheets the Drawing Set holds, retired ones included. DrawingSet.sheets.maxItems. */
    maxSheets: { value: 5000, xLimit: 'maxSheets', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** Pages of one Source. SourceFingerprint.pageCount.maximum. */
    maxPagesPerSource: { value: 5000, xLimit: 'maxPagesPerSource', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** A page side, in PDF points at scale 1. PagePoints.maximum. */
    maxPagePoints: { value: 14400, xLimit: 'maxPagePoints', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
    /** A file name, in characters. FileName.maxLength. */
    maxFileNameLength: { value: 255, xLimit: 'maxFileNameLength', status: 'CANONICAL_PRE_RELEASE_CANDIDATE' },
} as const satisfies Record<string, P1Limit>;

export const MAX_SOURCE_BYTES = P1_INTAKE_LIMITS.maxSourceBytes.value;
export const MAX_SOURCES = P1_INTAKE_LIMITS.maxSources.value;
export const MAX_SHEETS = P1_INTAKE_LIMITS.maxSheets.value;
export const MAX_PAGES_PER_SOURCE = P1_INTAKE_LIMITS.maxPagesPerSource.value;
export const MAX_PAGE_POINTS = P1_INTAKE_LIMITS.maxPagePoints.value;
export const MAX_FILE_NAME_LENGTH = P1_INTAKE_LIMITS.maxFileNameLength.value;

/**
 * How much of a file is read at a time. An implementation choice of P1, not a
 * contract value: it bounds what is in flight between the file, the analysis
 * buffer and the fingerprint Worker.
 */
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Why a file was not taken into the Drawing Set. */
export type IntakeRefusalCode =
    | 'FILE_NAME_INVALID'
    | 'EMPTY_FILE'
    | 'SOURCE_TOO_LARGE'
    | 'SOURCE_LIMIT'
    | 'SHEET_LIMIT'
    | 'PAGE_COUNT_LIMIT'
    | 'MEMORY_UNAVAILABLE'
    | 'FILE_READ_FAILED'
    | 'FILE_CHANGED'
    | 'FINGERPRINT_FAILED'
    | 'NOT_A_PDF'
    | 'PASSWORD_PROTECTED'
    | 'PAGE_READ_FAILED'
    | 'PAGE_SIZE_INVALID'
    | 'PAGE_SIZE_OUT_OF_RANGE'
    | 'PAGE_USER_UNIT_UNSUPPORTED'
    | 'PAGE_ROTATION_INVALID'
    | 'CLOCK_OUT_OF_RANGE'
    | 'ID_UNAVAILABLE';

export interface IntakeRefusal {
    code: IntakeRefusalCode;
    /** For the person. Never contains a path or file content. */
    message: string;
}

const MiB = 1024 * 1024;

export const refusal = (code: IntakeRefusalCode, message: string): IntakeRefusal => ({ code, message });

/**
 * Thrown to stop one file's intake: with a refusal, or with `null` when the run
 * was cancelled (reset, removal, unmount) and must publish nothing at all.
 */
export class IntakeStop extends Error {
    readonly refusal: IntakeRefusal | null;
    constructor(value: IntakeRefusal | null) {
        super(value ? value.message : 'cancelled');
        this.name = 'IntakeStop';
        this.refusal = value;
    }
}

export const cancelledStop = (): IntakeStop => new IntakeStop(null);

/*
 * The canonical FileName contract: 1..255 characters, none of them a control
 * character, a line or paragraph separator, a direction override or isolate, a
 * path separator or a drive colon (schema FileName.pattern), and not ".", ".."
 * or blank (semantic REL_FILE_NAME). P1 also refuses a name that is not
 * well-formed UTF-16, because it could not be written as the UTF-8 text a
 * Project file is.
 */
// The control characters are the point of this pattern: it is the schema's.
// eslint-disable-next-line no-control-regex
export const FILE_NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069/\\:]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Characters, as JSON Schema counts them: code points, not UTF-16 units. */
const codePointLength = (value: string): number => Array.from(value).length;

/** Whether `name` can be stored as a Source's displayName, and why not. */
export function checkFileName(name: string): IntakeRefusal | null {
    const length = codePointLength(name);
    if (length < 1 || name.trim() === '' || name === '.' || name === '..') {
        return refusal('FILE_NAME_INVALID', 'ファイル名が空のため、読み込めません。');
    }
    if (length > MAX_FILE_NAME_LENGTH) {
        return refusal('FILE_NAME_INVALID', `ファイル名が長すぎるため（${MAX_FILE_NAME_LENGTH}文字まで）、読み込めません。`);
    }
    if (LONE_SURROGATE.test(name) || FILE_NAME_FORBIDDEN.test(name)) {
        return refusal('FILE_NAME_INVALID', 'ファイル名に使えない文字（制御文字・区切り文字・表示方向の制御文字など）が含まれるため、読み込めません。');
    }
    return null;
}

/**
 * A file name made safe to show in a refusal: the characters the contract
 * forbids are replaced, so a name that was refused for carrying a direction
 * override cannot reorder the message it appears in.
 */
export function displaySafeFileName(name: string): string {
    const replaced = name
        .replace(new RegExp(LONE_SURROGATE.source, 'g'), '\uFFFD')
        .replace(new RegExp(FILE_NAME_FORBIDDEN.source, 'gu'), '\uFFFD');
    const chars = Array.from(replaced);
    return chars.length > 120 ? `${chars.slice(0, 117).join('')}…` : replaced || '(名前なし)';
}

/** What the Drawing Set already holds, as far as the gate is concerned. */
export interface HeldCounts {
    /** Every Source, retired ones included: the contract bounds the list. */
    sources: number;
    /** Every Sheet, retired ones included, for the same reason. */
    sheets: number;
}

/**
 * The checks that cost nothing: the name, the size and the room left. They run
 * before a single byte is read or any memory is set aside for the file, so a
 * file over the ceiling is refused without ever being allocated.
 */
export function preflight(file: { name: string; size: number }, held: HeldCounts): IntakeRefusal | null {
    const name = checkFileName(file.name);
    if (name) return name;
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
        return refusal('FILE_READ_FAILED', 'ファイルの大きさを確認できないため、読み込めません。');
    }
    if (file.size === 0) {
        return refusal('EMPTY_FILE', 'ファイルが空（0バイト）のため、読み込めません。');
    }
    if (file.size > MAX_SOURCE_BYTES) {
        return refusal(
            'SOURCE_TOO_LARGE',
            `ファイルが大きすぎるため（${(file.size / MiB).toFixed(1)} MiB）、読み込めません。1ファイル ${MAX_SOURCE_BYTES / MiB} MiB までです。`,
        );
    }
    if (held.sources >= MAX_SOURCES) {
        return refusal('SOURCE_LIMIT', `この図面一式に追加できるファイル数（${MAX_SOURCES}）に達しています。新しい図面一式で始めてください。`);
    }
    if (held.sheets >= MAX_SHEETS) {
        return refusal('SHEET_LIMIT', `この図面一式に追加できるページ数（${MAX_SHEETS}）に達しています。新しい図面一式で始めてください。`);
    }
    return null;
}

/**
 * The page-count gate, checked as soon as PDF.js reports the count and before
 * any page is read: a Source has 1..5000 pages, and the Drawing Set as a whole
 * holds at most 5000 Sheets, retired ones included.
 */
export function checkPageCount(pageCount: number, held: HeldCounts): IntakeRefusal | null {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        return refusal('NOT_A_PDF', 'ページを読み取れないため、PDFとして読み込めません。');
    }
    if (pageCount > MAX_PAGES_PER_SOURCE) {
        return refusal('PAGE_COUNT_LIMIT', `ページ数が多すぎるため（${pageCount}ページ）、読み込めません。1ファイル ${MAX_PAGES_PER_SOURCE} ページまでです。`);
    }
    if (held.sheets + pageCount > MAX_SHEETS) {
        const room = Math.max(0, MAX_SHEETS - held.sheets);
        return refusal(
            'SHEET_LIMIT',
            `追加すると図面一式のページ数が上限（${MAX_SHEETS}）を超えるため、読み込めません（このファイル ${pageCount} ページ、残り ${room} ページ。外したファイルのページも数えます）。`,
        );
    }
    return null;
}
