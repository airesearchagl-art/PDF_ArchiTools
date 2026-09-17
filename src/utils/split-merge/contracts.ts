/**
 * What Split and Merge promise, stated as types.
 *
 * The shape follows M5's, for the reason M5 adopted it: "it produced bytes" and
 * "it did what you asked" are different claims, and only a type keeps them
 * apart. M6 adds a third phase, because the measured defect here is not a bad
 * output — it is an output that looks right and carries pages nobody selected.
 *
 *   plan(source, selection)  -> ExtractPlan    nothing has been read for output
 *   run(plan)                -> ExtractResult  only a READY plan reaches a runner
 *   publish(result)          -> handed over    only a validated artifact ships
 *
 * Adopted: M6-H1 … M6-H14 (research/m6-split-merge-reliability/human-gate.json,
 * reviewed head 7f4d71b60474df063f4a45710cf257aba7468bec).
 */

/**
 * Every answer an M6 operation can give, including the good one.
 *
 * The order the refusals are decided in matters and is stated in
 * `extract-contract.md`: a document that is both signed and carries XFA is
 * refused as signed, because that is the sharper statement about it.
 */
export const M6_STATUS = {
    READY: 'READY',

    /** Unreadable, or a page tree that cannot be walked. */
    UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
    /** Refused by the loader. A distinct answer, because the remedy differs. */
    ENCRYPTED: 'ENCRYPTED',
    /** An applied signature in the source. M6-H1 for Extract, M6-H2 for Merge. */
    SIGNATURE_UNSAFE: 'SIGNATURE_UNSAFE',
    /** XFA the operation would drop. M6-H4. */
    XFA_UNSAFE: 'XFA_UNSAFE',
    /** Form features outside the proven `/Tx` subset. M6-H3. */
    UNSUPPORTED_FORM: 'UNSUPPORTED_FORM',
    /** A field whose widgets straddle kept and dropped pages. M6-H3. */
    FIELD_SPANS_SELECTION: 'FIELD_SPANS_SELECTION',
    /** The same field name in more than one Merge source. M6-H3. */
    DUPLICATE_FIELD_NAMES: 'DUPLICATE_FIELD_NAMES',
    /** Optional content outside the proven direct-/OCG envelope. M6-H9b. */
    UNSUPPORTED_OPTIONAL_CONTENT: 'UNSUPPORTED_OPTIONAL_CONTENT',
    /** The action graph could not be inspected completely. M6-H9c. */
    UNSCANNABLE_ACTIONS: 'UNSCANNABLE_ACTIONS',
    /**
     * Nothing selected. Refused in planning, never after `save()`: pdf-lib adds
     * a blank A4 to a document with no pages (api/PDFDocument.js:1253-1254), so
     * an unplanned empty extract ships a blank page and calls it a result.
     */
    EMPTY_SELECTION: 'EMPTY_SELECTION',
    /** A loss the person has to agree to before it happens. */
    STRUCTURE_LOSS_REQUIRES_CONFIRMATION: 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION',
    /** E1 only: the selection would break navigation. M6-H5. */
    BROKEN_DESTINATIONS: 'BROKEN_DESTINATIONS',

    /**
     * The pre-parse Load Boundary refused the bytes. H11-B3-1: this is decided
     * before `PDFDocument.load()` is called at all.
     */
    LOAD_BOUNDARY_REFUSED: 'LOAD_BOUNDARY_REFUSED',
    /**
     * The exact structural graph the copy would create is over a cap, decided
     * before `copyPages`. H11-EXTRACT-3 / H11-MERGE-4.
     */
    OVER_STRUCTURAL_CAP: 'OVER_STRUCTURAL_CAP',
    /** The produced artifact exceeds the adopted actual-output ceiling. */
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
    /**
     * The output would have gone out without what the source came in with.
     *
     * M6-H7 carries metadata under M5's H12 contract, and H12 makes metadata
     * part of the artifact — so failing to carry it is a refusal, not a note
     * attached to a file already handed over.
     */
    METADATA_NOT_PRESERVED: 'METADATA_NOT_PRESERVED',

    /** The run was superseded. M6-H13. */
    CANCELLED: 'CANCELLED',
    /** The worker died, timed out, or answered something unrecognised. */
    WORKER_FAILED: 'WORKER_FAILED',
    /**
     * The planned copy graph and the graph the copy actually produced disagree.
     * A5: the plan is only a safety argument if it describes the real copy.
     */
    PLAN_ACTUAL_MISMATCH: 'PLAN_ACTUAL_MISMATCH',
    /** An invariant this contract exists to hold did not hold in the artifact. */
    INVARIANT_VIOLATED: 'INVARIANT_VIOLATED',
} as const;

export type M6Status = typeof M6_STATUS[keyof typeof M6_STATUS];

/** Every status except READY is a refusal or a question, never an output. */
export const isRunnable = (status: M6Status): boolean => status === M6_STATUS.READY;

/**
 * A typed failure.
 *
 * Thrown only where a call stack has to unwind. Planning returns a plan rather
 * than throwing, because a refusal is an answer, not an accident — the same
 * split M5 adopted.
 */
export class M6Error extends Error {
    readonly code: M6Status;

    /** Where the refusal came from, for diagnostics. Never shown raw. */
    readonly detail?: string;

    constructor(message: string, code: M6Status, detail?: string) {
        super(message);
        this.name = 'M6Error';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * The sentence shown when nothing more specific is known.
 *
 * H11-B3-5 requires a refusal at least equivalent to this. Silent failure is
 * forbidden, so every path that cannot name its cause still says this much.
 */
export const GENERIC_REFUSAL_JA =
    'このPDFは安全に処理できることを確認できなかったため処理しません。';

/** What a kept page loses, named one by one so it can be agreed to. */
export type M6Loss =
    | 'tagging'
    | 'attachments'
    | 'internal-links'
    | 'named-destinations'
    | 'outlines'
    | 'page-labels'
    | 'document-javascript'
    | 'applied-signature'
    | 'article-threads';

export const M6_LOSS_LABEL_JA: Record<M6Loss, string> = {
    tagging: 'タグ構造（読み上げ順・アクセシビリティ情報）',
    attachments: '添付ファイル',
    'internal-links': '文書内リンク（選択外ページ宛て）',
    'named-destinations': '名前付きジャンプ先',
    outlines: 'しおり（アウトライン）',
    'page-labels': 'ページラベル',
    'document-javascript': '文書内のJavaScript',
    'applied-signature': '適用済みの電子署名',
    'article-threads': '記事スレッド（/B）',
};

/** One thing that was dropped or changed, with enough detail to report it. */
export interface LossRecord {
    kind: M6Loss;
    /** Source page index the loss belongs to, when it belongs to one. */
    fromIndex?: number;
    /** The name, key or target that identifies what was lost. */
    what?: string;
    /** Why, in the user's language. */
    why: string;
}

/**
 * The exact structural terms B2 proved countable before the copy happens.
 *
 * Every one is a count or a byte total taken from the graph the copier will
 * walk — never estimated from page count or file size, which B2 showed bound
 * nothing (page 1 of `mem-i-linked-heavy-pages` is one page and reaches nine
 * more and 4,901,945 B). None of them is a heap figure, which is why none of
 * them becomes a memory preset.
 */
export interface StructuralPlan {
    /** Pages the person asked for. */
    selectedPages: number;
    /** Indirect objects the copy will register. */
    destinationObjects: number;
    /** Entries the copier's `traversedObjects` map will hold. */
    copierEntries: number;
    /** References the copier allocates a number for and never assigns. */
    danglingReferences: number;
    /** Raw streams reached. */
    streams: number;
    /** Raw stream bytes the copy duplicates. */
    streamBytes: number;
    /** The largest single raw stream reached. */
    maxStreamBytes: number;
    /** Non-raw streams reached, whose size is not read. */
    unsizedStreams: number;
    /**
     * Page leaves reached through a reference: copied as pages, and outside the
     * output page tree. E2 strips the route before counting, so a non-zero
     * value here after sanitization is a structure this contract cannot explain.
     */
    pageLeavesReached: number;
}

export const EMPTY_STRUCTURAL_PLAN: StructuralPlan = {
    selectedPages: 0,
    destinationObjects: 0,
    copierEntries: 0,
    danglingReferences: 0,
    streams: 0,
    streamBytes: 0,
    maxStreamBytes: 0,
    unsizedStreams: 0,
    pageLeavesReached: 0,
};

/** Sum two structural plans, for Merge's cumulative check. */
export function addStructuralPlans(a: StructuralPlan, b: StructuralPlan): StructuralPlan {
    return {
        selectedPages: a.selectedPages + b.selectedPages,
        destinationObjects: a.destinationObjects + b.destinationObjects,
        copierEntries: a.copierEntries + b.copierEntries,
        danglingReferences: a.danglingReferences + b.danglingReferences,
        streams: a.streams + b.streams,
        streamBytes: a.streamBytes + b.streamBytes,
        maxStreamBytes: Math.max(a.maxStreamBytes, b.maxStreamBytes),
        unsizedStreams: a.unsizedStreams + b.unsizedStreams,
        pageLeavesReached: a.pageLeavesReached + b.pageLeavesReached,
    };
}

/**
 * What the source is, read without changing it.
 *
 * `hasSignatureField` and `hasAppliedSignature` are separate for the reason M5
 * H7 separated them, and M6 must not re-derive the distinction differently: an
 * empty `/Sig` field is a form control, and refusing a document for carrying
 * one would refuse ordinary signable paperwork.
 */
export interface M6SourceFacts {
    readable: boolean;
    encrypted: boolean;
    sourceBytes: number;
    pageCount: number;
    /** True when the page tree walks cleanly: `/Count` agreeing with `/Kids`. */
    pageTreeWalks: boolean;
    hasSignatureField: boolean;
    hasAppliedSignature: boolean;
    signatureFieldNames: string[];
    hasXfa: boolean;
    hasAcroForm: boolean;
    hasStructTree: boolean;
    pagesWithStructParents: number[];
    hasAttachments: boolean;
    attachmentNames: string[];
    hasOptionalContent: boolean;
    /** Why the facts could not be read, when `readable` is false. */
    reason?: string;
}

/** How an internal destination whose target is not kept is handled. M6-H5. */
export type DestinationPolicy = 'E1' | 'E2';

/** Which metadata a Merge output carries. M6-H8. */
export type MergeMetadataPolicy = 'M4' | 'M1';

/** What a Merge does when two sources declare the same field name. M6-H3. */
export type FieldCollisionPolicy = 'rename' | 'refuse';

/** A refusal or a question, with everything needed to show it. */
export interface M6Refusal {
    status: Exclude<M6Status, 'READY'>;
    /** Why, in the user's language. Shown, not only logged. */
    reason: string;
    /** What the person would be agreeing to, when the status is a question. */
    losses?: LossRecord[];
    /** Machine-readable specifics, for diagnostics and the gate. */
    detail?: Record<string, unknown>;
}

/** An Extract that has been decided but not yet run. */
export interface ExtractPlan {
    status: M6Status;
    reason?: string;
    /** Source page indices, always in source page order. M6-H5 page order. */
    selection: number[];
    facts: M6SourceFacts;
    destinationPolicy: DestinationPolicy;
    /**
     * The exact copy graph, counted after E2 and sanitization planning and
     * before `copyPages`. Null when planning refused before it got that far.
     */
    structural: StructuralPlan | null;
    losses: LossRecord[];
    /** Losses the person must agree to before this plan becomes runnable. */
    requiresConfirmation: M6Loss[];
    detail?: Record<string, unknown>;
}

/** What a run produced, before anyone is allowed to have it. */
export interface ExtractResult {
    status: M6Status;
    reason?: string;
    bytes: Uint8Array | null;
    outputName: string;
    losses: LossRecord[];
    /** The plan's counts, kept so the artifact can be checked against them. */
    planned: StructuralPlan | null;
    /** The same counts taken from the artifact. A5 requires these to agree. */
    actual: StructuralPlan | null;
    /** Measured on the artifact by reopening it. */
    readback: ReadbackFacts | null;
    detail?: Record<string, unknown>;
}

/**
 * What the artifact holds, measured by reopening the bytes.
 *
 * Every field here answers a claim the run would otherwise be making about
 * itself. `orphanPageCount` is the adopted production invariant (M6-H5);
 * `artifactWideJavaScript` is the count a reachability scan cannot make
 * (M6-H9c).
 */
export interface ReadbackFacts {
    pageCount: number;
    /** Indirect `/Page` objects outside the output page tree. Must be 0. */
    orphanPageCount: number;
    /** Surviving internal destinations that do not target the output tree. */
    danglingDestinations: number;
    /**
     * Source-page references surviving anywhere in the artifact. Must be 0.
     *
     * M6-H5A: `/Dest` was never the only route. `/A /GoTo`, a recursive `/Next`,
     * an annotation, widget or page `/AA`, and an annotation's own `/P` can each
     * carry a page reference, and a reference to a page of the *source* cannot
     * mean anything in the output.
     */
    sourcePageReferences: number;
    /** JavaScript actions a reader can reach. Must be 0. */
    reachableJavaScript: number;
    /**
     * JavaScript actions anywhere in the artifact, nested included. Must be 0.
     *
     * Counted by walking into every indirect object rather than by asking each
     * top-level one whether its own `/S` is `/JavaScript` — which is what let a
     * detached `/GoTo` carrying a direct action under `/Next` report zero.
     */
    artifactWideJavaScript: number;
    /** Widgets belonging to no field. Must be 0. */
    orphanWidgets: number;
    /** `/FileAttachment` annotations anywhere in the artifact. Must be 0. */
    fileAttachmentAnnots: number;
    /** `/Filespec` objects carrying an `/EF`. Must be 0. */
    filespecsWithEF: number;
    /** `/EmbeddedFile` payload streams. Must be 0. */
    embeddedFileStreams: number;
    /** Tagging remnants of every defined kind, summed. Must be 0 when stripped. */
    taggingRemnants: number;
    /** Indirect objects nothing reachable points at. Must be 0 after the sweep. */
    unreachableObjects: number;
    /** Whether the readback scan itself completed. */
    complete: boolean;
}

/** One Merge input's answer. M6-H10: every input carries one. */
export const INTAKE_RESULT = {
    ACCEPTED: 'ACCEPTED',
    UNSUPPORTED: 'UNSUPPORTED',
    UNREADABLE: 'UNREADABLE',
    ENCRYPTED: 'ENCRYPTED',
    SIGNATURE_UNSAFE: 'SIGNATURE_UNSAFE',
    XFA_UNSAFE: 'XFA_UNSAFE',
    UNSUPPORTED_FORM: 'UNSUPPORTED_FORM',
    UNSUPPORTED_OPTIONAL_CONTENT: 'UNSUPPORTED_OPTIONAL_CONTENT',
    LOAD_BOUNDARY_REFUSED: 'LOAD_BOUNDARY_REFUSED',
    /**
     * The worker failed, timed out, or was cancelled before this input was
     * decided.
     *
     * These exist because the alternative was worse: intake collapsing to an
     * empty list on failure let a Merge proceed having silently omitted files
     * the person chose. An input with no finalized state is not an input that
     * can be left out quietly — it is one the run has to fail closed on.
     */
    WORKER_ERROR: 'WORKER_ERROR',
    WORKER_TIMEOUT: 'WORKER_TIMEOUT',
    CANCELLED: 'CANCELLED',
    /** Requested, and never decided. Always a refusal, never an omission. */
    NOT_DECIDED: 'NOT_DECIDED',
} as const;

export type IntakeResultCode = typeof INTAKE_RESULT[keyof typeof INTAKE_RESULT];

export const INTAKE_LABEL_JA: Record<IntakeResultCode, string> = {
    ACCEPTED: '統合できます',
    UNSUPPORTED: 'PDFではありません',
    UNREADABLE: '読み取れませんでした',
    ENCRYPTED: 'パスワード保護されています',
    SIGNATURE_UNSAFE: '電子署名が適用されています',
    XFA_UNSAFE: 'XFAフォームを含みます',
    UNSUPPORTED_FORM: '対応範囲外のフォームを含みます',
    UNSUPPORTED_OPTIONAL_CONTENT: '対応範囲外のオプショナルコンテンツを含みます',
    LOAD_BOUNDARY_REFUSED: '安全に読み込めることを確認できませんでした',
    WORKER_ERROR: '確認処理が失敗しました',
    WORKER_TIMEOUT: '確認処理が時間内に終わりませんでした',
    CANCELLED: '中止されました',
    NOT_DECIDED: '確認できていません',
};

/** Only an ACCEPTED input may be copied. Everything else is named and excluded. */
export const isAcceptedIntake = (code: IntakeResultCode): boolean =>
    code === INTAKE_RESULT.ACCEPTED;

/**
 * One input, after intake.
 *
 * Deliberately a plain, serialisable record: H11-MERGE-1 and the A6 reading of
 * M6-H10 forbid holding every source as a loaded `PDFDocument`, so intake keeps
 * what it learned and lets the document go.
 */
export interface IntakeRecord {
    id: string;
    name: string;
    sizeBytes: number;
    result: IntakeResultCode;
    /** Why, in the user's language, when the result is not ACCEPTED. */
    reason?: string;
    pageCount: number;
    pageTreeWalks: boolean;
    hasAcroForm: boolean;
    fieldNames: string[];
    hasOptionalContent: boolean;
    hasStructTree: boolean;
    hasAttachments: boolean;
    /** The source's Info dictionary, for M1 metadata. */
    info: Record<string, string>;
}

/** A Merge that has been decided but not yet run. */
export interface MergePlan {
    status: M6Status;
    reason?: string;
    /** Every input, in list order, accepted or not. M6-H10. */
    intake: IntakeRecord[];
    /** The ids that will actually be copied, in order. */
    order: string[];
    metadataPolicy: MergeMetadataPolicy;
    collisionPolicy: FieldCollisionPolicy;
    losses: LossRecord[];
    requiresConfirmation: M6Loss[];
    detail?: Record<string, unknown>;
}

/** What a Merge produced, before anyone is allowed to have it. */
export interface MergeResult {
    status: M6Status;
    reason?: string;
    bytes: Uint8Array | null;
    outputName: string;
    intake: IntakeRecord[];
    losses: LossRecord[];
    /** Renamed fields, when the collision policy renamed any. */
    renamedFields: { from: string; to: string; source: string }[];
    /** The cumulative structural totals across every copied source. */
    cumulative: StructuralPlan | null;
    readback: ReadbackFacts | null;
    detail?: Record<string, unknown>;
}

/**
 * What a run is bound to. M6-H13.
 *
 * Changing any of it supersedes the run in flight: a different file, a
 * different selection, a different policy, a different tab. The snapshot is the
 * key, not the state, so a confirmation cannot drift onto a different job.
 */
export interface M6Snapshot {
    operation: 'extract' | 'merge';
    fileIds: string[];
    /** Extract only: the selection, as a stable string. */
    selection: string;
    destinationPolicy: DestinationPolicy;
    metadataPolicy: MergeMetadataPolicy;
    collisionPolicy: FieldCollisionPolicy;
}

export const m6SnapshotKey = (s: M6Snapshot): string => [
    s.operation,
    s.fileIds.join(','),
    s.selection,
    s.destinationPolicy,
    s.metadataPolicy,
    s.collisionPolicy,
].join('|');
