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
    planDestinations,
    rebuildDestinations,
    stripInternalDestinations,
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
    applyExtractMetadata,
    describeStructuralLosses,
    dropOpenAction,
    hasOutlines,
    hasPageLabels,
    readInfo,
    removeAttachments,
    stripTagging,
} from './structure';
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
    hasXfa: false,
    hasAcroForm: false,
    hasStructTree: false,
    pagesWithStructParents: [],
    hasAttachments: false,
    attachmentNames: [],
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
    if (!facts.readable || !facts.pageTreeWalks) {
        return refusedPlan(
            M6_STATUS.UNSUPPORTED_DOCUMENT,
            'このPDFのページ構造を確認できませんでした。',
            selection,
            facts,
            destinationPolicy,
        );
    }
    if (facts.hasXfa) {
        return refusedPlan(
            M6_STATUS.XFA_UNSAFE,
            'XFAフォームを含むPDFは、内容を失わずに抽出できないため処理しません。',
            selection,
            facts,
            destinationPolicy,
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

    const destinations = planDestinations(doc, selection);
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
    const workingDestinations = planDestinations(working, selection);
    const strip = stripInternalDestinations(working, workingDestinations, selection);
    // Every `/Sig` widget goes, applied or empty: the reconstruction does not
    // rebuild signature fields (M6-H3 defers that), and a widget left behind
    // would be an orphan in the artifact. An applied signature is additionally a
    // disclosed loss; an empty field is a form control that is simply not carried.
    if (facts.hasSignatureField) removeSignatureWidgets(working);

    const structural = await planStructuralGraph(working, selection);

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

    const losses: LossRecord[] = [
        ...strip.losses,
        ...describeStructuralLosses(facts),
    ];
    if (hasOutlines(doc)) {
        losses.push({ kind: 'outlines', why: 'しおりは引き継がれません（今回の対応範囲外）。' });
    }
    if (hasPageLabels(doc)) {
        losses.push({ kind: 'page-labels', why: 'ページラベルは引き継がれません（今回の対応範囲外）。' });
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

const refusedResult = (
    status: ExtractResult['status'],
    reason: string,
    outputName: string,
    detail?: Record<string, unknown>,
): ExtractResult => ({
    status,
    reason,
    bytes: null,
    outputName,
    losses: [],
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
        return refusedResult(plan.status, plan.reason ?? GENERIC_REFUSAL_JA, outputName, plan.detail);
    }
    if (!stillOurs()) {
        return refusedResult(M6_STATUS.CANCELLED, '操作が変更されたため、この処理は中止しました。', outputName);
    }

    const selection = plan.selection;

    // A working copy, transformed exactly as planning transformed its own.
    let working: PDFDocument | null = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const sourceInfo = readInfo(working);
    const destinations = planDestinations(working, selection);
    const strip = stripInternalDestinations(working, destinations, selection);
    if (plan.facts.hasSignatureField) removeSignatureWidgets(working);

    const ocDescription = describeOptionalContent(working, selection);
    const form = readForm(working);
    const formPlan = planFormForExtract(form, selection);

    const planned: StructuralPlan = await planStructuralGraph(working, selection);
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
    rebuildDestinations(out, strip, selection);

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
        if (carriedFields.length > 0) rebuildAcroForm(out, carriedFields, { da: form.da });
    }

    stripTagging(out);
    const removedAttachments = removeAttachments(out);
    dropOpenAction(out);

    const sanitized = sanitizeJavaScript(out);
    if (sanitized.status === 'REFUSED') {
        return refusedResult(M6_STATUS.UNSCANNABLE_ACTIONS, sanitized.reason, outputName, {
            incomplete: sanitized.incomplete,
        });
    }

    applyExtractMetadata(out, sourceInfo, options.sourceName);

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
    const readback = await readbackArtifact(bytes);
    const invariant = checkArtifactInvariants(readback, selection.length);
    if (invariant) {
        return refusedResult(M6_STATUS.INVARIANT_VIOLATED, invariant.reason, outputName, {
            invariant: invariant.invariant, value: invariant.value,
        });
    }

    const losses: LossRecord[] = [...strip.losses, ...describeStructuralLosses(plan.facts)];
    if (removedAttachments.names.length > 0) {
        losses.push({
            kind: 'attachments',
            what: removedAttachments.names.join(', '),
            why: '添付ファイルを削除しました。',
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
        detail: { policy: policy.origin, policyProvisional: policy.provisional },
    };
}
