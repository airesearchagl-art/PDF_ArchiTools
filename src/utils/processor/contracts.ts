/**
 * What the Processor promises, stated as types.
 *
 * The operations used to share one contract — "it either produced bytes or it
 * threw" — and that is exactly the contract the M5 research found wanting. A
 * document whose signature was invalidated, whose XFA was deleted, or whose
 * searchable text was replaced by a picture all produced bytes, and all
 * reported success. So the shape here is deliberately two-phase:
 *
 *   plan(source, operation, settings) -> Plan      nothing has been touched yet
 *   run(plan)                          -> FileResult
 *
 * A `Plan` that is not `READY` never reaches a runner, and no runner publishes
 * anything. "Cannot safely process" and "successful output" are different
 * answers, and the type system is where that stops being a convention.
 *
 * Adopted: H1, H5, H6, H7, H10, H11, H12 (PR #23 `adoption.md`).
 */

/** The operations this orchestration covers. */
export type ProcessorOperation =
    | 'layer'
    | 'monochrome'
    | 'both'
    | 'margin'
    | 'optimize'
    | 'normalize-size'
    | 'title-block-update';

/**
 * Whether an operation keeps the document it was given, or deliberately
 * replaces it with a picture of itself. H1 adopted the second as a legitimate
 * thing to offer — but only when it is named, planned and confirmed.
 */
export type OperationClass = 'STRUCTURE_PRESERVING' | 'INTENTIONAL_FLATTENING';

export const OPERATION_CLASS: Record<ProcessorOperation, OperationClass> = {
    layer: 'STRUCTURE_PRESERVING',
    monochrome: 'INTENTIONAL_FLATTENING',
    both: 'INTENTIONAL_FLATTENING',
    margin: 'STRUCTURE_PRESERVING',
    optimize: 'STRUCTURE_PRESERVING',
    'normalize-size': 'STRUCTURE_PRESERVING',
    'title-block-update': 'STRUCTURE_PRESERVING',
};

/**
 * The verdict of planning, before anything is read for output or written.
 *
 * `READY` is the only one a runner accepts. `STRUCTURE_LOSS_REQUIRES_CONFIRMATION`
 * is not a soft failure: it is a plan that becomes runnable only when the person
 * has agreed to the specific losses it names, for these exact files and
 * settings.
 */
export const PLAN_STATUS = {
    READY: 'READY',
    UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
    SIGNATURE_UNSAFE: 'SIGNATURE_UNSAFE',
    XFA_UNSAFE: 'XFA_UNSAFE',
    STRUCTURE_LOSS_REQUIRES_CONFIRMATION: 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION',
    UNSUPPORTED_MARGIN_SEMANTICS: 'UNSUPPORTED_MARGIN_SEMANTICS',
    /**
     * The output would have gone out without what the source came in with.
     * H12 makes metadata part of the artifact, so failing to carry it is a
     * refusal — not a note attached to a file already handed over.
     */
    METADATA_NOT_PRESERVED: 'METADATA_NOT_PRESERVED',
    OVER_RASTER_LIMIT: 'OVER_RASTER_LIMIT',
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
    CANVAS_UNAVAILABLE: 'CANVAS_UNAVAILABLE',
    CANCELLED: 'CANCELLED',
} as const;

export type PlanStatus = typeof PLAN_STATUS[keyof typeof PLAN_STATUS];

/** Every status except READY is a refusal or a question, never an output. */
export const isRunnable = (status: PlanStatus): boolean => status === PLAN_STATUS.READY;

/**
 * What a flattening operation is about to destroy, named one by one.
 *
 * H5 and H6: a loss may be accepted, never assumed. The list is built from what
 * the source actually carries, so a vector-only drawing is not asked to consent
 * to losing form fields it never had.
 */
export type StructureLoss =
    | 'searchable-text'
    | 'ocr-text-layer'
    | 'vector-structure'
    | 'annotations'
    | 'links'
    | 'form-fields';

export const LOSS_LABEL_JA: Record<StructureLoss, string> = {
    'searchable-text': '検索できる文字（本文テキスト）',
    'ocr-text-layer': 'OCRで付与された透明テキスト',
    'vector-structure': 'ベクター図形（線・図形データ）',
    annotations: '注釈',
    links: 'リンク',
    'form-fields': 'フォーム部品と入力値',
};

/**
 * What the source is, read without changing it.
 *
 * `hasSignatureField` and `hasAppliedSignature` are separate on purpose (H7): a
 * blank signature box is a form field, and refusing a document for having one
 * would refuse ordinary signable paperwork. Only a `/Sig` field whose `/V`
 * holds a signature dictionary is a signature that re-serialising destroys.
 */
export interface SourceFacts {
    readable: boolean;
    /**
     * The source's own size. The conservative per-file bound for the operations
     * that cannot know their output until they have produced it is derived from
     * this, so it is a fact about the source rather than a number the caller
     * remembers to pass.
     */
    sourceBytes: number;
    loadError: string | null;
    encrypted: boolean;
    pageCount: number;
    pagesValid: boolean;
    pageError: string | null;
    hasAcroForm: boolean;
    hasXfa: boolean;
    sigFlags: number | null;
    fieldCount: number;
    signatureFields: { name: string; signed: boolean }[];
    hasSignatureField: boolean;
    hasAppliedSignature: boolean;
    formInspectionState: 'no-form' | 'read' | 'unreadable';
    formError: string | null;
    /** Visible page geometry, in points, after /Rotate. */
    pages: { widthPt: number; heightPt: number }[];
}

/** What a page will cost, and what it is allowed to cost. */
export interface RasterPlan {
    dpi: number;
    widthPx: number;
    heightPx: number;
    pixels: number;
    /** Peak bytes live at once for this page, from the adopted H8 model. */
    peakBytes: number;
    /** What the page contributes to the finished artifact. */
    outputBytes: number;
    peakStep: string;
}

export interface Plan {
    operation: ProcessorOperation;
    status: PlanStatus;
    /** Why, in the user's language. Shown, not only logged. */
    reason: string;
    /** Stable identifier for gates and manifests. */
    code: PlanStatus;
    facts: SourceFacts;
    /** Present only for flattening operations. */
    raster?: RasterPlan;
    /** Non-empty exactly when the status is STRUCTURE_LOSS_REQUIRES_CONFIRMATION. */
    losses: StructureLoss[];
    /** What the whole file is expected to cost, for the job-level ceiling. */
    fileBytesEstimate: number;
    filePeakBytes: number;
}

export const FILE_RESULT = {
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
} as const;
export type FileResultStatus = typeof FILE_RESULT[keyof typeof FILE_RESULT];

export interface FileResult {
    name: string;
    status: FileResultStatus;
    /** The plan's code for a refusal, or 'SUCCEEDED'. */
    code: PlanStatus | 'SUCCEEDED';
    reason: string;
    bytes: Uint8Array | null;
    outputName: string | null;
}

export const BATCH_RESULT = {
    SUCCEEDED: 'SUCCEEDED',
    PARTIAL: 'PARTIAL',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
} as const;
export type BatchResultStatus = typeof BATCH_RESULT[keyof typeof BATCH_RESULT];

export interface BatchResult {
    status: BatchResultStatus;
    files: FileResult[];
    /** The archive, when B2 produced one. */
    archive: Blob | null;
    archiveName: string | null;
}

/**
 * A refusal the UI can show verbatim, carrying the code the gate asserts on.
 *
 * Thrown only where a call stack has to unwind; planning returns a `Plan`
 * rather than throwing, because a refusal is an answer, not an accident.
 */
export class ProcessorError extends Error {
    readonly code: PlanStatus;

    constructor(message: string, code: PlanStatus) {
        super(message);
        this.name = 'ProcessorError';
        this.code = code;
    }
}

/**
 * The exact run a confirmation was given for.
 *
 * H10: a confirmation is not a setting. Change the files, the tool, the DPI,
 * the contrast or the memory preset and the thing the person agreed to no
 * longer exists, so the token stops matching and the run asks again. There is
 * deliberately no "always allow".
 */
export interface RunSnapshot {
    operation: ProcessorOperation;
    fileIds: string[];
    dpi: number | null;
    contrast: number | null;
    memoryBudgetBytes: number;
}

export const snapshotKey = (s: RunSnapshot): string => [
    s.operation,
    s.fileIds.join(','),
    s.dpi ?? '-',
    s.contrast ?? '-',
    s.memoryBudgetBytes,
].join('|');
