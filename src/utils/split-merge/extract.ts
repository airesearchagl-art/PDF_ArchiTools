/**
 * Extract: plan, run, publish.
 *
 * The order below is the adopted production contract, not an implementation
 * preference. H11-EXTRACT-1 and H11-EXTRACT-2 fix it:
 *
 *   1. pre-parse **Load Boundary** — PASS or a typed refusal, before load
 *   2. `PDFDocument.load()` — **only on PASS**
 *   3. facts, and the refusals that are knowable from the source alone
 *   4. **E2 and sanitization applied**, so the graph counted is the graph copied
 *   5. the **exact structural graph**, counted after 4 and before any copy
 *   6. **cap check** — a typed refusal raised before `copyPages`
 *   7. `copyPages`
 *   8. reconstruction — destinations, optional content, forms
 *   9. **release the source**, before save
 *  10. `save`
 *  11. the **actual-output ceiling**, on the artifact
 *  12. **readback** — the invariants, measured on the bytes
 *
 * Step 4 before step 5 is the part that is easy to get backwards and fatal to
 * get backwards: counting a graph that still holds internal destinations and
 * then changing the structure afterwards would satisfy every check while
 * describing a different document. A5 exists to prove it did not happen.
 *
 * Step 9 is not tidiness either. Measured, the save peak holds the source graph,
 * the destination graph and the output buffer at once; releasing the source
 * first takes its stream bytes out of that peak.
 */
import { PDFDocument } from 'pdf-lib';
import type {
    DestinationPolicy,
    ExtractPlan,
    ExtractResult,
    LossRecord,
    M6SourceFacts,
    StructuralPlan,
} from './contracts';
import { GENERIC_REFUSAL_JA, M6_STATUS } from './contracts';
import { inspectLoadBoundary } from './load-boundary';
import { assertEnforceablePolicy, PROVISIONAL_POLICY } from './policy';
import type { M6Policy } from './policy';
import { classifyLoadError, readSourceFacts } from './source-facts';
import {
    closeSourcePageRefs,
    nameAnnotationsByReference,
    rebuildDestinations,
    rebuildSourcePageRefs,
    sanitizeDestinations,
    wouldBreakNavigation,
} from './destinations';
import {
    carryOptionalContent,
    describeOptionalContent,
    planOptionalContent,
} from './optional-content';
import { sanitizeJavaScript } from './javascript';
import { planFormForExtract, readForm, rebuildAcroForm, removeSignatureWidgets } from './forms';
import {
    checkStructuralCaps,
    comparePlanWithActual,
    graphOfWholeDocument,
    planStructuralGraph,
} from './structural-graph';
import {
    attachmentLosses,
    describeStructuralLosses,
    dropOpenAction,
    hasOutlines,
    hasPageLabels,
} from './structure';
import {
    applyMetadataSnapshot,
    metadataGaps,
    snapshotMetadata,
} from './metadata';
import {
    canonicalizeStreamLengthsForSave,
    pruneUnreachable,
    removeAttachmentsEverywhere,
    scrubAllJavaScript,
    stripTaggingEverywhere,
} from './prune';
import { extractOutputName } from './naming';
import { checkArtifactInvariants, readbackArtifact } from './readback';

export interface ExtractOptions {
    /** Source page indices. Normalised to source page order before use. */
    selection: number[];
    sourceName: string;
    destinationPolicy?: DestinationPolicy;
    policy?: M6Policy;
    /** Losses the person has already agreed to, for this exact job. */
    confirmedLosses?: string[];
    /** Re-checked at every boundary control returns from an `await`. */
    stillOurs?: () => boolean;
}

const refusedPlan = (
    status: ExtractPlan['status'],
    reason: string,
    selection: number[],
    facts: M6SourceFacts,
    destinationPolicy: DestinationPolicy,
    detail?: Record<string, unknown>,
): ExtractPlan => ({
    status,
    reason,
    selection,
    facts,
    destinationPolicy,
    structural: null,
    losses: [],
    requiresConfirmation: [],
    detail,
});

const emptyFacts = (sourceBytes: number): M6SourceFacts => ({
    readable: false,
    encrypted: false,
    sourceBytes,
    pageCount: 0,
    pageTreeWalks: false,
    hasSignatureField: false,
    hasAppliedSignature: false,
    signatureFieldNames: [],
    appliedSignatureFieldNames: [],
    emptySignatureFieldNames: [],
    hasXfa: false,
    hasAcroForm: false,
    hasStructTree: false,
    pagesWithStructParents: [],
    hasAttachments: false,
    attachmentNames: [],
    attachmentsComplete: false,
    hasOptionalContent: false,
});

/**
 * Everything decided before a byte is written, on a document loaded only after
 * the boundary passed it.
 *
 * The working document this leaves behind in `detail.__doc` is deliberately not
 * part of the public shape: a plan is a value the UI can hold, and a loaded
 * `PDFDocument` is not. `runExtract` loads its own.
 */
export async function planExtract(
    sourceBytes: Uint8Array,
    options: ExtractOptions,
): Promise<ExtractPlan> {
    const policy = options.policy ?? PROVISIONAL_POLICY;
    assertEnforceablePolicy(policy);
    const destinationPolicy = options.destinationPolicy ?? 'E2';
    // Source page order, always. The UI offers no reordering, and a person who
    // ticks page 5 then page 2 means "pages 2 and 5".
    const selection = [...new Set(options.selection)].sort((a, b) => a - b);

    // ---- 1. the pre-parse Load Boundary --------------------------------------
    const boundary = inspectLoadBoundary(sourceBytes, policy.loadBoundary);
    if (boundary.verdict === 'REFUSE') {
        return refusedPlan(
            M6_STATUS.LOAD_BOUNDARY_REFUSED,
            GENERIC_REFUSAL_JA,
            selection,
            emptyFacts(sourceBytes.length),
            destinationPolicy,
            { code: boundary.code, stage: boundary.stage, reason: boundary.reason, at: boundary.at },
        );
    }

    // ---- 2. load, only on PASS ----------------------------------------------
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    } catch (error) {
        const kind = classifyLoadError(error);
        return refusedPlan(
            kind === 'ENCRYPTED' ? M6_STATUS.ENCRYPTED : M6_STATUS.UNSUPPORTED_DOCUMENT,
            kind === 'ENCRYPTED'
                ? 'パスワード保護されたPDFは処理できません。'
                : 'このPDFを読み取れませんでした。',
            selection,
            emptyFacts(sourceBytes.length),
            destinationPolicy,
            { error: String((error as Error)?.message ?? error) },
        );
    }

    const facts = readSourceFacts(doc, sourceBytes.length);

    // ---- 3. refusals knowable from the source alone --------------------------
    //
    // XFA is asked FIRST. A document can carry XFA and a malformed `/Fields` at
    // the same time, and reporting the malformed field tree would give the
    // vaguer of two true answers — and make XFA detection depend on a valid
    // `/Fields`, which is exactly what it must not depend on.
    if (facts.hasXfa) {
        return refusedPlan(
            M6_STATUS.XFA_UNSAFE,
            'XFAフォームを含むPDFは、内容を失わずに抽出できないため処理しません。',
            selection,
            facts,
            destinationPolicy,
        );
    }
    if (!facts.pageTreeWalks) {
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_DOCUMENT,
            'このPDFのページ構造を確認できませんでした。',
            selection,
            facts,
            destinationPolicy,
        );
    }
    if (!facts.readable) {
        // The only thing `readSourceFacts` declares unreadable is the AcroForm
        // field tree, so this says what it actually is rather than blaming the
        // document as a whole.
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_FORM,
            'フォーム構造を読み取れないため処理しません。',
            selection,
            facts,
            destinationPolicy,
            facts.reason ? { reason: facts.reason } : undefined,
        );
    }
    if (!facts.attachmentsComplete) {
        // RF-R3-2: `hasAttachments: false` is only a fact about the document
        // when the census that produced it was complete. An incomplete one is
        // a refusal, because the answer feeds what the person is asked to
        // agree to.
        return refusedPlan(
            M6_STATUS.CENSUS_INCOMPLETE,
            '添付ファイルの有無を完全に確認できなかったため処理しません。',
            selection,
            facts,
            destinationPolicy,
            { reason: facts.attachmentsRefusal },
        );
    }
    if (selection.length === 0) {
        // Refused in planning, never after `save()`: pdf-lib adds a blank A4 to
        // a document with no pages, so an unplanned empty extract would ship a
        // blank page and call it a result.
        return refusedPlan(
            M6_STATUS.EMPTY_SELECTION,
            'ページが選択されていません。',
            selection,
            facts,
            destinationPolicy,
        );
    }
    if (selection.some((i) => i < 0 || i >= facts.pageCount)) {
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_DOCUMENT,
            '選択されたページ番号がこのPDFの範囲外です。',
            selection,
            facts,
            destinationPolicy,
        );
    }

    /**
     * Whether this document's destinations can be read at all, asked before
     * the readers that walk the same pages for something else.
     *
     * A malformed `/Annots` is visible to the optional-content resource walk
     * too, and reporting it as an optional-content problem is the vaguer of
     * two true answers — the same mistake XFA-behind-a-malformed-`/Fields`
     * was. RF-R3-5: present and unreadable is a refusal, and it is named for
     * what it is.
     */
    const destinations = wouldBreakNavigation(doc, selection);
    if (destinations.duplicateNames.length > 0) {
        // RF-R4-3: a name defined twice has no single target to preserve, and
        // no adopted policy chooses one.
        return refusedPlan(
            M6_STATUS.DUPLICATE_NAMED_DESTINATIONS,
            '同じ名前の名前付きジャンプ先が複数定義されているため処理しません: '
            + destinations.duplicateNames.join(', '),
            selection,
            facts,
            destinationPolicy,
            { duplicates: destinations.duplicateNames },
        );
    }
    if (destinations.unreadable.length > 0) {
        return refusedPlan(
            M6_STATUS.UNREADABLE_DESTINATIONS,
            'このPDFのジャンプ先の構造を完全に読み取れなかったため処理しません: '
            + destinations.unreadable.join(', '),
            selection,
            facts,
            destinationPolicy,
            { unreadable: destinations.unreadable },
        );
    }

    const form = readForm(doc);
    const formPlan = planFormForExtract(form, selection);
    if (formPlan.status === 'REFUSE') {
        return refusedPlan(
            formPlan.code === 'XFA_UNSAFE'
                ? M6_STATUS.XFA_UNSAFE
                : formPlan.code === 'FIELD_SPANS_SELECTION'
                    ? M6_STATUS.FIELD_SPANS_SELECTION
                    : formPlan.code === 'UNSUPPORTED_FORM'
                        ? M6_STATUS.UNSUPPORTED_FORM
                        : M6_STATUS.UNSUPPORTED_DOCUMENT,
            formPlan.reason,
            selection,
            facts,
            destinationPolicy,
            formPlan.detail,
        );
    }

    const oc = describeOptionalContent(doc, selection);
    const ocPlan = planOptionalContent(oc);
    if (ocPlan.status === 'REFUSE') {
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
            ocPlan.reason,
            selection,
            facts,
            destinationPolicy,
            { unsupported: ocPlan.unsupported },
        );
    }

    if (destinationPolicy === 'E1'
        && (destinations.wouldBreak > 0 || destinations.otherSites.length > 0)) {
        const parts: string[] = [];
        if (destinations.wouldBreak > 0) {
            parts.push(`選択したページから、選択に含まれないページへの参照が${destinations.wouldBreak}件あります。`);
        }
        if (destinations.otherSites.length > 0) {
            const keys = destinations.otherSites.map((s) => `/${s.key}`).join(', ');
            parts.push(`また、注釈以外の経路（${keys}）でも他ページを参照しています。`);
        }
        return refusedPlan(
            M6_STATUS.BROKEN_DESTINATIONS,
            parts.join(''),
            selection,
            facts,
            destinationPolicy,
            { wouldBreak: destinations.wouldBreak },
        );
    }

    // ---- 4 & 5. sanitize on a working copy, then count -----------------------
    //
    // The count has to describe the graph `copyPages` will walk, so the working
    // copy is transformed first and the count is taken from the transformed
    // document. A second load is used rather than the one above, so planning
    // never hands the caller a mutated document.
    const working = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const strip = sanitizeDestinations(working, selection);
    if (strip.duplicateNames.length > 0) {
        return refusedPlan(
            M6_STATUS.DUPLICATE_NAMED_DESTINATIONS,
            '同じ名前の名前付きジャンプ先が複数定義されているため処理しません: '
            + strip.duplicateNames.join(', '),
            selection,
            facts,
            destinationPolicy,
            { duplicates: strip.duplicateNames },
        );
    }
    if (strip.unreadable.length > 0) {
        return refusedPlan(
            M6_STATUS.UNREADABLE_DESTINATIONS,
            'このPDFのジャンプ先の構造を完全に読み取れなかったため処理しません: '
            + strip.unreadable.join(', '),
            selection,
            facts,
            destinationPolicy,
            { unreadable: strip.unreadable },
        );
    }
    // M6-H5A: the routes `/Dest` never covered, closed before the graph is
    // counted so the count describes a graph with no source-page reference in
    // it. A route the walk could not finish is a refusal, not an absence.
    const closure = closeSourcePageRefs(working, selection);
    if (closure.unreadable.length > 0) {
        return refusedPlan(
            M6_STATUS.UNSCANNABLE_ACTIONS,
            `この文書のアクション構造を完全に検査できませんでした: ${closure.unreadable.join(', ')}`,
            selection,
            facts,
            destinationPolicy,
            { unreadable: closure.unreadable },
        );
    }
    // BLK-2R: attachments are removed from the working copy, before planning,
    // so the payload is never part of the graph that gets counted or copied.
    // An `/EF` carrier is recognised semantically, so a typeless one inside an
    // unsupported action is found too — and the census refuses rather than
    // reporting zero if it cannot prove it covered the document.
    const plannedAttachments = removeAttachmentsEverywhere(working);
    if (!plannedAttachments.complete) {
        return refusedPlan(
            M6_STATUS.CENSUS_INCOMPLETE,
            '添付ファイルの有無を完全に確認できなかったため処理しません。',
            selection,
            facts,
            destinationPolicy,
            { reason: plannedAttachments.reason },
        );
    }
    // Every `/Sig` widget goes, applied or empty: the reconstruction does not
    // rebuild signature fields (M6-H3 defers that), and a widget left behind
    // would be an orphan in the artifact. An applied signature is additionally a
    // disclosed loss; an empty field is a form control that is simply not carried.
    if (facts.hasSignatureField) {
        const removal = removeSignatureWidgets(working);
        if (removal.unclassified.length > 0) {
            // RF-R4-4: a widget that cannot be told apart from a signature is
            // not assumed to be an ordinary one.
            return refusedPlan(
                M6_STATUS.UNSUPPORTED_FORM,
                'フォームの継承関係を読み取れず、署名欄かどうかを判定できないため処理しません。',
                selection,
                facts,
                destinationPolicy,
                { unclassified: removal.unclassified },
            );
        }
    }

    const structural = await planStructuralGraph(working, selection);

    /**
     * RF-H — the pre-copy invariant is hard, not a readback.
     *
     * After every adopted sanitization and reconstruction plan, the graph must
     * reach no page that is not being copied. `/Thread` and a cross-page
     * `/Popup` are two routes this contract does not support; there will be
     * others. Letting the copy run and refusing afterwards means the orphan was
     * created and then thrown away, and H11-EXTRACT-2 says the graph counted is
     * the graph copied. So this is a backstop for paths nobody has enumerated,
     * and it refuses before `copyPages` rather than after `save`.
     */
    if (structural.pageLeavesReached > 0) {
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_DOCUMENT,
            'このPDFには、選択していないページを参照する構造が残っています。'
            + '安全に説明できないため処理しません。',
            selection,
            facts,
            destinationPolicy,
            { pageLeavesReached: structural.pageLeavesReached },
        );
    }

    // ---- 6. the cap check, before any copy ----------------------------------
    const breach = checkStructuralCaps(structural, policy.structural);
    if (breach) {
        return refusedPlan(
            M6_STATUS.OVER_STRUCTURAL_CAP,
            breach.reason,
            selection,
            facts,
            destinationPolicy,
            { term: breach.term, value: breach.value, cap: breach.cap, policy: policy.origin },
        );
    }

    const losses: LossRecord[] = [];
    const plannedSeen = new Set<string>();
    const addPlanned = (loss: LossRecord): void => {
        // Two detectors can legitimately find the same fact — the facts reader
        // and the attachment remover both name an embedded file. Reporting it
        // twice reads as two attachments.
        const key = `${loss.kind}|${loss.what ?? ''}|${loss.fromIndex ?? ''}`;
        if (plannedSeen.has(key)) return;
        plannedSeen.add(key);
        losses.push(loss);
    };
    for (const loss of [
        ...strip.losses,
        ...closure.losses,
        ...describeStructuralLosses(facts),
    ]) addPlanned(loss);
    if (hasOutlines(doc)) {
        addPlanned({ kind: 'outlines', why: 'しおりは引き継がれません（今回の対応範囲外）。' });
    }
    if (hasPageLabels(doc)) {
        addPlanned({ kind: 'page-labels', why: 'ページラベルは引き継がれません（今回の対応範囲外）。' });
    }
    // RF-R4-6: one entry per attachment, named, by the same labels the facts
    // were read with — so the planned removal and the disclosed one agree.
    for (const loss of attachmentLosses(plannedAttachments.names, '添付ファイルは引き継がれません。')) {
        addPlanned(loss);
    }
    for (const kind of plannedAttachments.removedActions) {
        addPlanned({
            kind: 'internal-links',
            what: '/' + kind,
            why: '対応範囲外のアクションに添付が含まれていたため、そのアクションごと削除しました。',
        });
    }
    if (facts.emptySignatureFieldNames.length > 0) {
        // RF-F: an unsigned field is not an applied signature, and saying so
        // told people their document had been signed when it had not. And the
        // reverse (ADV-9, RF-R4-4): the unsigned ones are named as unsigned
        // even when an applied one sits beside them, and an applied signature
        // whose value was unreadable is refused upstream, never listed here.
        addPlanned({
            kind: 'empty-signature-field',
            what: facts.emptySignatureFieldNames.join(', '),
            why: '未署名の署名欄は抽出後のPDFには引き継がれないため削除しました。',
        });
    }

    // A loss may be accepted, never assumed. Only the two that destroy something
    // the source carried are gated behind a confirmation.
    const requiresConfirmation = losses
        .filter((l) => l.kind === 'attachments' || l.kind === 'tagging')
        .map((l) => l.kind);
    const confirmed = new Set(options.confirmedLosses ?? []);
    const outstanding = requiresConfirmation.filter((k) => !confirmed.has(k));

    return {
        status: outstanding.length > 0
            ? M6_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION
            : M6_STATUS.READY,
        reason: outstanding.length > 0
            ? 'この抽出では次の内容が失われます。内容を確認してから実行してください。'
            : undefined,
        selection,
        facts,
        destinationPolicy,
        structural,
        losses,
        requiresConfirmation: [...new Set(outstanding)],
        detail: {
            policy: policy.origin,
            policyProvisional: policy.provisional,
            carriedForm: formPlan.status === 'CARRY' ? formPlan.carried : [],
            optionalContent: ocPlan.status,
        },
    };
}

/**
 * A refusal, with the losses that caused it.
 *
 * RF-7: the confirmation path used to answer with an empty `losses` array, so
 * the UI asked someone to agree to a structural loss it could not name — the
 * attachment's filename in particular. A confirmation is only valid for what was
 * visibly presented, which means the losses have to travel with the refusal that
 * asks for it.
 */
const refusedResult = (
    status: ExtractResult['status'],
    reason: string,
    outputName: string,
    detail?: Record<string, unknown>,
    losses: LossRecord[] = [],
): ExtractResult => ({
    status,
    reason,
    bytes: null,
    outputName,
    losses,
    planned: null,
    actual: null,
    readback: null,
    detail,
});

/**
 * Run a plan that is READY, and validate what it produced.
 *
 * The plan is re-derived here rather than trusted: a plan is a value that may
 * have been held across a settings change, and the only safe thing to run is a
 * decision made against the bytes in hand.
 */
export async function runExtract(
    sourceBytes: Uint8Array,
    options: ExtractOptions,
): Promise<ExtractResult> {
    const policy = options.policy ?? PROVISIONAL_POLICY;
    const outputName = extractOutputName(options.sourceName, options.selection);
    const stillOurs = options.stillOurs ?? (() => true);

    const plan = await planExtract(sourceBytes, options);
    if (plan.status !== M6_STATUS.READY) {
        // The losses travel with the refusal: a confirmation the UI cannot name
        // is a confirmation nobody actually gave.
        return refusedResult(
            plan.status,
            plan.reason ?? GENERIC_REFUSAL_JA,
            outputName,
            { ...plan.detail, requiresConfirmation: plan.requiresConfirmation },
            plan.losses,
        );
    }
    if (!stillOurs()) {
        return refusedResult(M6_STATUS.CANCELLED, '操作が変更されたため、この処理は中止しました。', outputName);
    }

    const selection = plan.selection;

    // A working copy, transformed exactly as planning transformed its own.
    /**
     * RF-E — the metadata is snapshotted, not held.
     *
     * A second loaded document kept purely to read metadata at the end made
     * "release the source before save" untrue: the release was an assignment
     * with a live object graph behind it. The snapshot holds strings, numbers
     * and copied byte arrays, so this document can be, and is, dropped here.
     */
    const metadataSnapshot = await (async () => {
        const metadataSource = await PDFDocument.load(sourceBytes, { updateMetadata: false });
        return snapshotMetadata(metadataSource);
    })();

    let working: PDFDocument | null = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    /**
     * RF-R5-1: every annotation gets a name before anything is planned or
     * removed. The reconstructions below are bound to that name, so the
     * sanitization between them and `copyPages` — signature widgets under
     * M6-H1, file-attachment annotations under M6-H2 — cannot move the
     * annotation a plan is about out from under it.
     */
    nameAnnotationsByReference(working, selection);
    const strip = sanitizeDestinations(working, selection);
    if (strip.duplicateNames.length > 0) {
        return refusedResult(
            M6_STATUS.DUPLICATE_NAMED_DESTINATIONS,
            '同じ名前の名前付きジャンプ先が複数定義されているため処理しません: '
            + strip.duplicateNames.join(', '),
            outputName,
            { duplicates: strip.duplicateNames },
        );
    }
    if (strip.unreadable.length > 0) {
        return refusedResult(
            M6_STATUS.UNREADABLE_DESTINATIONS,
            'このPDFのジャンプ先の構造を完全に読み取れなかったため処理しません: '
            + strip.unreadable.join(', '),
            outputName,
            { unreadable: strip.unreadable },
        );
    }
    const closure = closeSourcePageRefs(working, selection);
    if (closure.unreadable.length > 0) {
        return refusedResult(
            M6_STATUS.UNSCANNABLE_ACTIONS,
            `この文書のアクション構造を完全に検査できませんでした: ${closure.unreadable.join(', ')}`,
            outputName,
            { unreadable: closure.unreadable },
        );
    }
    if (plan.facts.hasSignatureField) {
        const removal = removeSignatureWidgets(working);
        if (removal.unclassified.length > 0) {
            return refusedResult(
                M6_STATUS.UNSUPPORTED_FORM,
                'フォームの継承関係を読み取れず、署名欄かどうかを判定できないため処理しません。',
                outputName,
                { unclassified: removal.unclassified },
            );
        }
    }
    const removedAttachments = removeAttachmentsEverywhere(working);
    if (!removedAttachments.complete) {
        return refusedResult(
            M6_STATUS.CENSUS_INCOMPLETE,
            '添付ファイルの有無を完全に確認できなかったため処理しません。',
            outputName,
            { reason: removedAttachments.reason },
        );
    }

    const ocDescription = describeOptionalContent(working, selection);
    const form = readForm(working);
    const formPlan = planFormForExtract(form, selection);

    const planned: StructuralPlan = await planStructuralGraph(working, selection);
    // RF-H, on the graph this run will actually copy.
    if (planned.pageLeavesReached > 0) {
        return refusedResult(
            M6_STATUS.UNSUPPORTED_DOCUMENT,
            'このPDFには、選択していないページを参照する構造が残っています。'
            + '安全に説明できないため処理しません。',
            outputName,
            { pageLeavesReached: planned.pageLeavesReached },
        );
    }
    const breach = checkStructuralCaps(planned, policy.structural);
    if (breach) {
        return refusedResult(M6_STATUS.OVER_STRUCTURAL_CAP, breach.reason, outputName, {
            term: breach.term, value: breach.value, cap: breach.cap,
        });
    }
    if (!stillOurs()) {
        return refusedResult(M6_STATUS.CANCELLED, '操作が変更されたため、この処理は中止しました。', outputName);
    }

    // ---- 7. copy -------------------------------------------------------------
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(working, selection);
    copied.forEach((page) => out.addPage(page));

    /**
     * A5, measured here and nowhere else.
     *
     * The comparison is between the graph the planner counted and the graph
     * `copyPages` actually produced, so it has to be taken **before**
     * reconstruction. Step 8 deliberately puts objects back — a rebuilt
     * destination, an `/OCProperties`, an AcroForm — and sanitization
     * deliberately removes others, so a count taken after them would differ for
     * reasons that are the contract working rather than failing. Measuring the
     * finished artifact instead would make this check either meaningless or
     * permanently red; the invariants on the finished artifact are the readback
     * in step 12, which is a different question.
     */
    const actual = await graphOfWholeDocument(out);

    // ---- 8. reconstruction ---------------------------------------------------
    const rebuiltDestinations = rebuildDestinations(out, strip, selection, working);
    const rebuiltPageRefs = rebuildSourcePageRefs(out, closure, selection, working);
    const unapplied = [...rebuiltDestinations.unapplied, ...rebuiltPageRefs.unapplied];
    if (unapplied.length > 0) {
        // A reconstruction that was planned and did not happen is a link the
        // person had and the artifact does not, with nothing said about it.
        return refusedResult(
            M6_STATUS.PLAN_ACTUAL_MISMATCH,
            '事前に計画したリンクの復元ができませんでした。安全のため書き出しません。',
            outputName,
            { unapplied },
        );
    }
    // RF-R5-1: reconstructions whose annotation this run removed on purpose.
    // Not a failure — the removal is its own reported loss — but recorded.
    const removedAnnots = [...rebuiltDestinations.removed, ...rebuiltPageRefs.removed];

    if (ocDescription.present && ocDescription.unsupported.length === 0) {
        const carried = carryOptionalContent(working, ocDescription, out);
        if (carried.status === 'REFUSED') {
            return refusedResult(
                M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                carried.reason,
                outputName,
                { unsupported: carried.unsupported },
            );
        }
    }

    if (formPlan.status === 'CARRY') {
        const carriedFields = form.fields.filter((f) => formPlan.carried.includes(f.name));
        if (carriedFields.length > 0) {
            const rebuilt = rebuildAcroForm(out, carriedFields, { da: form.da });
            if (rebuilt.unwritable.length > 0) {
                // Never reached on text read from a document — it decoded, so
                // it encodes — and a field written with another name is a field
                // the person did not have.
                return refusedResult(
                    M6_STATUS.PLAN_ACTUAL_MISMATCH,
                    'フォームのフィールド名を安全に書き出せませんでした。安全のため書き出しません。',
                    outputName,
                    { unwritable: rebuilt.unwritable },
                );
            }
        }
    }

    // Every tagging remnant, not just the catalog keys: an annotation's
    // `/StructParent` and a form XObject's `/StructParents` point at a tree
    // that is gone just as surely as a page's does.
    const strippedTagging = stripTaggingEverywhere(out);
    if (!strippedTagging.complete) {
        return refusedResult(
            M6_STATUS.CENSUS_INCOMPLETE,
            'タグ構造を完全に確認できなかったため処理しません。',
            outputName,
            { reason: strippedTagging.reason },
        );
    }
    const outputAttachments = removeAttachmentsEverywhere(out);
    if (!outputAttachments.complete) {
        return refusedResult(
            M6_STATUS.CENSUS_INCOMPLETE,
            '添付ファイルの有無を完全に確認できなかったため処理しません。',
            outputName,
            { reason: outputAttachments.reason },
        );
    }
    dropOpenAction(out);

    const sanitized = sanitizeJavaScript(out);
    if (sanitized.status === 'REFUSED') {
        return refusedResult(M6_STATUS.UNSCANNABLE_ACTIONS, sanitized.reason, outputName, {
            incomplete: sanitized.incomplete,
        });
    }

    // Belt and braces beside the sweep below: a script inside something that
    // is still reachable has to go too, and a top-level `/S` check never saw
    // an action nested as a direct dictionary.
    const scrubbed = scrubAllJavaScript(out);
    if (!scrubbed.complete) {
        return refusedResult(
            M6_STATUS.CENSUS_INCOMPLETE,
            'JavaScriptの有無を完全に確認できなかったため処理しません。',
            outputName,
            { reason: scrubbed.reason },
        );
    }

    const metadata = applyMetadataSnapshot(out, metadataSnapshot, options.sourceName);

    // A5, decided now that both counts exist. A mismatch means the graph that
    // was capped is not the graph that was copied, which makes the cap check a
    // statement about a document that was never produced.
    const comparison = comparePlanWithActual(planned, actual);
    if (!comparison.agrees) {
        return refusedResult(
            M6_STATUS.PLAN_ACTUAL_MISMATCH,
            '事前に計画した内容と、実際に作成された内容が一致しませんでした。安全のため書き出しません。',
            outputName,
            { differences: comparison.differences },
        );
    }

    // ---- 9. release the source, before save ---------------------------------
    working = null;

    if (!stillOurs()) {
        return refusedResult(M6_STATUS.CANCELLED, '操作が変更されたため、この処理は中止しました。', outputName);
    }

    // Before anything is swept: put `/Length` into the direct form `save()`
    // will write, so a copied indirect length object is unreachable now rather
    // than orphaned in the bytes afterwards.
    const lengths = canonicalizeStreamLengthsForSave(out);
    if (lengths.undescribable.length > 0) {
        return refusedResult(
            M6_STATUS.INVARIANT_VIOLATED,
            `書き出す前に、${lengths.undescribable.length} 件のストリームの長さを確認できませんでした。安全のため書き出しません。`,
            outputName,
            { undescribableStreams: lengths.undescribable.length },
        );
    }

    // Nothing points at it, so nothing writes it. pdf-lib serialises every
    // registered object whether or not it is reachable, which is how a
    // detached action and an orphaned attachment payload both reached the
    // bytes while every count said zero.
    pruneUnreachable(out);

    // ---- 10. save ------------------------------------------------------------
    const bytes = await out.save({ useObjectStreams: false });

    // ---- 11. the actual-output ceiling ---------------------------------------
    if (bytes.length > policy.output.maxOutputBytes) {
        return refusedResult(
            M6_STATUS.OVER_OUTPUT_BUDGET,
            `書き出したPDFが上限を超えました（${(bytes.length / (1024 * 1024)).toFixed(1)} MiB / `
            + `上限 ${(policy.output.maxOutputBytes / (1024 * 1024)).toFixed(0)} MiB）。`,
            outputName,
            { bytes: bytes.length, ceiling: policy.output.maxOutputBytes },
        );
    }

    // ---- 12. readback --------------------------------------------------------
    // M6-H7: metadata is part of the artifact, so a gap is a refusal rather
    // than a note attached to a file already handed over.
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const gaps = metadataGaps(metadataSnapshot, reopened);
    if (gaps.length > 0) {
        return refusedResult(
            M6_STATUS.METADATA_NOT_PRESERVED,
            '元のPDFの文書情報を引き継げませんでした: ' + gaps.join(', '),
            outputName,
            { gaps, carried: metadata.carried, dropped: metadata.dropped },
        );
    }

    const readback = await readbackArtifact(bytes);
    const invariant = checkArtifactInvariants(readback, selection.length);
    if (invariant) {
        return refusedResult(M6_STATUS.INVARIANT_VIOLATED, invariant.reason, outputName, {
            invariant: invariant.invariant, value: invariant.value,
        });
    }

    /**
     * RF-I — the result carries every loss the plan named.
     *
     * Losses were being recomputed here from a narrower set, so outlines, page
     * labels and the page-reference removals the plan had already found
     * disappeared from a successful result. A loss that is known and not
     * reported is a silent loss whatever the reason it went missing.
     */
    const losses: LossRecord[] = [...plan.losses];
    const seenLoss = new Set(losses.map((l) => `${l.kind}|${l.what ?? ''}|${l.fromIndex ?? ''}`));
    for (const loss of [...strip.losses, ...closure.losses, ...describeStructuralLosses(plan.facts)]) {
        const key = `${loss.kind}|${loss.what ?? ''}|${loss.fromIndex ?? ''}`;
        if (seenLoss.has(key)) continue;
        seenLoss.add(key);
        losses.push(loss);
    }
    for (const loss of attachmentLosses(removedAttachments.names, '添付ファイルは引き継がれません。')) {
        const key = `${loss.kind}|${loss.what ?? ''}|`;
        if (seenLoss.has(key)) continue;
        seenLoss.add(key);
        losses.push(loss);
    }
    for (const kind of removedAttachments.removedActions) {
        const key = `internal-links|/${kind}|`;
        if (seenLoss.has(key)) continue;
        seenLoss.add(key);
        losses.push({
            kind: 'internal-links',
            what: '/' + kind,
            why: '対応範囲外のアクションに添付が含まれていたため、そのアクションごと削除しました。',
        });
    }

    return {
        status: M6_STATUS.READY,
        bytes,
        outputName,
        losses,
        planned,
        actual,
        readback,
        detail: {
            policy: policy.origin,
            policyProvisional: policy.provisional,
            ...(removedAnnots.length > 0 ? { removedAnnotations: removedAnnots } : {}),
        },
    };
}
