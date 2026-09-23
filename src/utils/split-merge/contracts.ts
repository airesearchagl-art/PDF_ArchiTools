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
    /**
     * The same named destination in more than one Merge source, pointing at
     * different pages.
     *
     * No adopted policy resolves this, and silently overwriting or renaming one
     * of them would change navigation without saying so. M6-H6 covers
     * reconstructing named destinations, not reconciling them.
     */
    DUPLICATE_NAMED_DESTINATIONS: 'DUPLICATE_NAMED_DESTINATIONS',
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
    /**
     * A safety census could not be proven to have covered the artifact.
     *
     * The adopted clarification: a census ends COMPLETE or REFUSED. A count
     * produced by giving up is not an invariant, so an incomplete inspection
     * is a typed failure rather than a zero.
     */
    CENSUS_INCOMPLETE: 'CENSUS_INCOMPLETE',
    /**
     * What planning decided and what the run re-derived from the bytes do not
     * agree. Never a reason to skip the work and continue.
     */
    PLAN_RUNTIME_MISMATCH: 'PLAN_RUNTIME_MISMATCH',
    /** A loss requiring confirmation was not confirmed. */
    CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
    /**
     * A destination structure is present and could not be read completely.
     *
     * The adopted Human clarification, applied to semantic readers: a reader
     * whose output controls preservation ends COMPLETE, EXPLICIT LOSS or
     * REFUSED. A `/Names` tree this reader cannot walk is not a document
     * without named destinations — it is one whose navigation cannot be
     * described, and describing it as empty is how it disappeared silently.
     */
    UNREADABLE_DESTINATIONS: 'UNREADABLE_DESTINATIONS',
    /**
     * Something carries the marks of an attachment and cannot be proven to be
     * only one. BLK-R8R-1.
     *
     * `/EF` is evidence to inspect, not authority to delete. A dictionary that
     * carries `/EF` and is also an optional-content group, a payload that is
     * also the form a page draws, a payload also reached from outside any
     * attachment structure — removing any of them as "the attachment" would
     * remove the other thing too, under a confirmation that named only the
     * attachment. So the document is refused before anything is asked.
     */
    UNSAFE_ATTACHMENT_STRUCTURE: 'UNSAFE_ATTACHMENT_STRUCTURE',
    /**
     * Something carries JavaScript and is provably not only an action — a
     * stream, a form XObject, a group, a page. Round 9, the same rule as
     * BLK-R8R-1: taking it apart as "the script" would take the drawing, the
     * layer or the page with it, so the document is refused instead.
     */
    UNSAFE_JAVASCRIPT_STRUCTURE: 'UNSAFE_JAVASCRIPT_STRUCTURE',
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

/**
 * BLK-R8R-1, in the person's words: what would be lost is not only an
 * attachment, so this is not a question they can be asked.
 */
export const UNSAFE_ATTACHMENT_REASON_JA =
    '添付ファイルの目印（/EF）を持つ構造を、添付ファイル以外の内容（レイヤー・図形・ページの内容など）と'
    + '区別できないため処理しません。添付ファイルとして取り除くと、それ以外の内容まで失われるおそれがあります。';

/** Round 9, the JavaScript counterpart of {@link UNSAFE_ATTACHMENT_REASON_JA}. */
export const UNSAFE_JAVASCRIPT_REASON_JA =
    'JavaScriptの目印を持つ構造を、アクション以外の内容（図形・レイヤー・ページなど）と'
    + '区別できないため処理しません。JavaScriptとして取り除くと、それ以外の内容まで失われるおそれがあります。';

/**
 * Round 11 (RF-R10R-1): the same refusal, for a source whose action structure
 * could not be inspected completely. Planning, intake and the sanitizer all say
 * this one sentence, so a document is refused for the same reason in the same
 * words wherever the question is asked.
 */
export const UNSCANNABLE_ACTIONS_REASON_JA =
    'この文書のアクション構造を完全に検査できませんでした';

/**
 * What is known about the JavaScript in one document. Closed: exactly one of
 * these is true, and only SAFE lets anything be planned.
 *
 * - `SAFE`: every carrier is proven to be an action — by its own shape and by
 *   every place that refers to it — and every action position was inspected.
 * - `UNSAFE_STRUCTURE`: something carries JavaScript and is not proven to be an
 *   action nothing else depends on. Taking it apart would take that with it.
 * - `UNSCANNABLE`: an action position could not be read to the end, so what
 *   lies past it is unknown.
 * - `CENSUS_INCOMPLETE`: the object census that finds the carriers could not
 *   prove it covered the document (or was never asked).
 */
export type JavaScriptSafety =
    | { status: 'SAFE' }
    | { status: 'UNSAFE_STRUCTURE'; unsafe: string[] }
    | { status: 'UNSCANNABLE'; incomplete: string[] }
    | { status: 'CENSUS_INCOMPLETE'; reason: string };

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
    /**
     * An unsigned `/Sig` field that was removed.
     *
     * Kept apart from `applied-signature` because they are different facts: one
     * is a signature that was applied to the source, the other a form control
     * that was never signed. Labelling the second as the first told the person
     * their document had been signed when it had not.
     */
    | 'empty-signature-field'
    /**
     * A Merge source that was not merged.
     *
     * This is not a loss of document content, and reporting it as one — under
     * `internal-links`, which is what happened — told the person a link was
     * broken when a whole file had been left out.
     */
    | 'excluded-source'
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
    'empty-signature-field': '未署名の署名欄',
    'excluded-source': '統合に含まれなかったPDF',
    'article-threads': '記事スレッド（/B）',
};

/**
 * Losses a person has to agree to before they happen.
 *
 * A loss outside this set is disclosed, not gated. The distinction matters
 * because a confirmation is only meaningful for something that was shown, and
 * showing everything would bury the two that destroy what the source carried.
 */
export const CONFIRMATION_REQUIRED_LOSSES: readonly M6Loss[] = ['attachments', 'tagging'];

export const requiresConfirmation = (kind: M6Loss): boolean =>
    CONFIRMATION_REQUIRED_LOSSES.includes(kind);

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
    /**
     * The two kinds of signature field, named apart. RF-R4-4.
     *
     * A document can carry both, and naming only one kind — or labelling an
     * applied signature "unsigned" because its value sat behind an unreadable
     * parent — tells the person the wrong thing about what was removed.
     */
    appliedSignatureFieldNames: string[];
    emptySignatureFieldNames: string[];
    hasXfa: boolean;
    hasAcroForm: boolean;
    hasStructTree: boolean;
    pagesWithStructParents: number[];
    hasAttachments: boolean;
    attachmentNames: string[];
    /**
     * Whether the attachment census proved it covered this document.
     *
     * `hasAttachments: false` is only a fact about the document when this is
     * true. The Round-3 defect wearing its last disguise: intake asked a
     * `/Type`-gated reader whether there were attachments, the reader did not
     * recognise a typeless `/EF` carrier, and "not recognised" reached the
     * confirmation as "not there" — so a Merge deleted an attachment nobody
     * had been asked about.
     */
    attachmentsComplete: boolean;
    /** Why the attachment census could not prove completeness. */
    attachmentsRefusal?: string;
    /**
     * BLK-R8R-1: every `/EF`, payload or file-attachment annotation that could
     * not be proven to be an attachment and nothing else.
     *
     * Non-empty is a refusal before anything is asked or written. A person is
     * only ever asked to agree to losing an attachment; removing something that
     * merely carries `/EF` would take whatever else it is along with it.
     */
    attachmentsUnsafe: string[];
    /**
     * The one JavaScript safety answer for this source: whether every script in
     * it can be taken apart without taking anything else with it, and whether
     * that could be proven at all.
     *
     * Read here, at intake, rather than only when the artifact is being
     * sanitized — RF-R10-1. A document that cannot be processed for a
     * JavaScript reason must say so before anyone is asked to agree to losing
     * an attachment for an operation that was never going to happen.
     *
     * Round 11 (RF-R10R-1): this is the same {@link JavaScriptSafety} the
     * sanitizer asks of the artifact — the ownership classification and the
     * action scan's completeness together — so planning cannot say READY about a
     * document the sanitizer will later refuse as unscannable. A closed type
     * rather than a flag and a list: a boolean beside a list can disagree with
     * itself, and this cannot.
     */
    javascript: JavaScriptSafety;
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
    /**
     * RF-R8-1: the artifact's own optional content, measured on the bytes.
     *
     * Discovery decides what may be carried; these decide whether what was
     * carried holds together. They exist because BLK-R7-A shipped READY with a
     * live `/OC`, no `/OCProperties` and a hidden layer drawn in full, and
     * nothing here could have caught it — there was no optional-content
     * invariant at all.
     */
    /** Live `/OC` entries anywhere in the artifact. Not itself a failure. */
    optionalContentUses: number;
    /** Groups the artifact's `/OCProperties /OCGs` registers. */
    optionalContentRegisteredGroups: number;
    /** `/OC` entries naming an object the artifact does not hold. Must be 0. */
    optionalContentDanglingUses: number;
    /** `/OC` entries naming a group the artifact does not register. Must be 0. */
    optionalContentUnregisteredUses: number;
    /** `/OC` entries still naming a membership dictionary. Must be 0. */
    optionalContentOcmdSurvivors: number;
    /**
     * RF-R8R-1: `/Properties` entries naming a group or membership dictionary —
     * marked-content optional content. Not itself a failure; the dangling,
     * unregistered and membership-dictionary counts include these.
     */
    optionalContentPropertyUses: number;
    /** Configuration entries that do not hold together. Must be 0. */
    optionalContentConfigErrors: number;
    /** What the census found, so a refusal can name it. */
    optionalContentDetail: string[];
    /** `/FileAttachment` annotations anywhere in the artifact. Must be 0. */
    fileAttachmentAnnots: number;
    /** `/Filespec` objects carrying an `/EF`. Must be 0. */
    filespecsWithEF: number;
    /** `/EmbeddedFile` payload streams. Must be 0. */
    embeddedFileStreams: number;
    /** Tagging remnants of every defined kind, summed. Must be 0 when stripped. */
    taggingRemnants: number;
    /**
     * Signature fields, signature or timestamp values, and byte ranges. Must be
     * 0: no M6 output presents itself as signed (M6-H1, M6-H2, RF-R4-4).
     */
    signatureRemnants: number;
    /** Indirect objects nothing reachable points at. Must be 0 after the sweep. */
    unreachableObjects: number;
    /** Whether the reachable action scan completed. */
    complete: boolean;
    /**
     * Whether every artifact-wide census proved it covered the artifact.
     *
     * False is a refusal, never a zero: the counts above are only invariants
     * when the scan that produced them is known to have been complete.
     */
    censusComplete: boolean;
    /** Why a census could not prove completeness. */
    censusRefusal?: string;
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
    /**
     * A safety census over this source could not prove it covered the document.
     *
     * Intake's answer feeds the confirmation a person is asked for, so an
     * incomplete census here has to be a refusal rather than "nothing found".
     */
    CENSUS_INCOMPLETE: 'CENSUS_INCOMPLETE',
    /** An `/EF` structure that is not provably only an attachment. BLK-R8R-1. */
    UNSAFE_ATTACHMENT_STRUCTURE: 'UNSAFE_ATTACHMENT_STRUCTURE',
    /**
     * A `/JS` carrier that is not provably only an action. BLK-R9R-1, surfaced
     * at intake rather than at sanitization time. RF-R10-1.
     */
    UNSAFE_JAVASCRIPT_STRUCTURE: 'UNSAFE_JAVASCRIPT_STRUCTURE',
    /**
     * An action position that could not be read to the end, so what lies past
     * it is unknown. RF-R10R-1: refused here, at intake, in the same words the
     * sanitizer uses — it used to be found only after the losses had been
     * agreed to, and for a Merge it refused every source, not just this one.
     */
    UNSCANNABLE_ACTIONS: 'UNSCANNABLE_ACTIONS',
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
    CENSUS_INCOMPLETE: '内容を完全に確認できませんでした',
    UNSAFE_ATTACHMENT_STRUCTURE: '添付ファイルとして安全に取り除けない構造を含みます',
    UNSAFE_JAVASCRIPT_STRUCTURE: 'JavaScriptとして安全に取り除けない構造を含みます',
    UNSCANNABLE_ACTIONS: 'アクションの構造を完全に確認できませんでした',
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
    /**
     * One label per attachment, as the confirmation shows it. RF-R4-6.
     *
     * The filename where the document gives one (`/UF`, then `/F`), and an
     * explicit unnamed label where it does not — never invented.
     */
    attachments: string[];
    /**
     * SHA-256 of the bytes intake read. RF-R4-5.
     *
     * Intake's facts are UX facts; this is what makes them facts about a
     * particular file. The run recomputes it over the bytes it loads, and a
     * record that does not match describes some other content.
     */
    contentDigest: string;
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
