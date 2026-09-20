/**
 * Merge: intake, plan, run, publish.
 *
 * Three contracts shape every line of this file.
 *
 * **No all-source lifetime (H11-MERGE-1 … 3).** A Merge never holds more than
 * one source as a loaded `PDFDocument`. Each source goes through
 * `Load Boundary -> PASS -> load -> inspect -> decide -> sanitize -> plan ->
 * copy -> release`, and is released before the next is loaded.
 *
 * **Intake is not a loophole (A6).** Intake loads one source at a time,
 * converts what it learned into a plain serialisable `IntakeRecord`, and lets
 * the document go. The copy loop loads each source again from bytes it never
 * stopped owning.
 *
 * **Every input carries a result (M6-H10).** What must never happen is an input
 * that disappears between the file picker and the list.
 *
 * And one ordering rule that had to be learned twice: **inspection comes before
 * mutation.** An earlier version removed signature widgets and attachments from
 * the loaded source and only then read its facts, so a source with an applied
 * signature could reach READY — the signature had been deleted before anything
 * asked whether it was there. Intake's facts are not a safety authority either:
 * they are computed on the main thread for the UI, and in a worker they arrive
 * as a message. Everything a refusal depends on is re-derived here, from the
 * unmodified document this run just loaded out of bytes it owns.
 */
import { PDFDocument } from 'pdf-lib';
import type {
    FieldCollisionPolicy,
    IntakeRecord,
    LossRecord,
    MergeMetadataPolicy,
    MergePlan,
    MergeResult,
    StructuralPlan,
} from './contracts';
import {
    addStructuralPlans,
    CONFIRMATION_REQUIRED_LOSSES,
    EMPTY_STRUCTURAL_PLAN,
    GENERIC_REFUSAL_JA,
    INTAKE_RESULT,
    M6_STATUS,
    requiresConfirmation,
} from './contracts';
import { inspectLoadBoundary } from './load-boundary';
import { assertEnforceablePolicy, PROVISIONAL_POLICY } from './policy';
import type { M6Policy } from './policy';
import { classifyLoadError, readSourceFacts } from './source-facts';
import {
    carryOptionalContent,
    describeOptionalContent,
    planOptionalContent,
} from './optional-content';
import type { OptionalContentDescription } from './optional-content';
import {
    closeSourcePageRefs,
    nameAnnotationsByReference,
    rebuildDestinations,
    rebuildSourcePageRefs,
    sanitizeDestinations,
} from './destinations';
import type { StripOutcome } from './destinations';
import {
    canonicalizeStreamLengthsForSave,
    pruneUnreachable,
    removeAttachmentsEverywhere,
    scrubAllJavaScript,
    stripTaggingEverywhere,
} from './prune';
import { sanitizeJavaScript } from './javascript';
import { planFormForExtract, readForm, rebuildAcroForm, removeSignatureWidgets } from './forms';
import type { FormField } from './forms';
import { checkCumulativeCaps, planStructuralGraph } from './structural-graph';
import {
    applyMergeMetadata,
    attachmentLosses,
    dropOpenAction,
    hasOutlines,
    hasPageLabels,
    readInfo,
    readInfoTexts,
} from './structure';
import type { PdfText } from './pdf-text';
import { contentDigest } from './digest';
import { mergeOutputName } from './naming';
import { checkArtifactInvariants, readbackArtifact } from './readback';

/** One input, as the caller holds it. The bytes stay the caller's. */
export interface MergeInput {
    id: string;
    name: string;
    /** The declared MIME type, when the picker supplied one. */
    type?: string;
    bytes: Uint8Array;
}

export interface MergeOptions {
    metadataPolicy?: MergeMetadataPolicy;
    collisionPolicy?: FieldCollisionPolicy;
    policy?: M6Policy;
    /** Ids to exclude even though intake accepted them. */
    excluded?: string[];
    /** Losses the person has already agreed to, for this exact job. */
    confirmedLosses?: string[];
    /**
     * The plan those losses were agreed to for. RF-R3-3.
     *
     * A confirmation without one is a confirmation of nothing in particular,
     * and is not honoured: `confirmedLosses` only counts when this matches
     * {@link mergeConfirmationFingerprint} of the plan being run.
     */
    confirmedFingerprint?: string;
    stillOurs?: () => boolean;
}

const emptyIntake = (input: MergeInput): IntakeRecord => ({
    id: input.id,
    name: input.name,
    sizeBytes: input.bytes.length,
    result: INTAKE_RESULT.UNREADABLE,
    pageCount: 0,
    pageTreeWalks: false,
    hasAcroForm: false,
    fieldNames: [],
    hasOptionalContent: false,
    hasStructTree: false,
    hasAttachments: false,
    attachments: [],
    contentDigest: '',
    info: {},
});

/**
 * Everything a refusal can depend on, read from an unmodified document.
 *
 * Centralised so Merge and its intake ask the same questions in the same order,
 * and so nothing can be decided from a document something has already edited.
 */
interface SourceSafety {
    /** Non-null when the source must not be merged. */
    refusal: {
        intake: IntakeRecord['result'];
        status: MergeResult['status'];
        reason: string;
        detail?: Record<string, unknown>;
    } | null;
    facts: ReturnType<typeof readSourceFacts>;
    form: ReturnType<typeof readForm>;
    optionalContent: OptionalContentDescription;
    signatureFieldNames: string[];
    hasOutlines: boolean;
    hasPageLabels: boolean;
}

/**
 * Inspect a loaded source and decide, before anything is changed.
 *
 * The order is deliberate. XFA is asked **before** readability, because a
 * document can carry XFA and a malformed `/Fields` at the same time, and
 * "unreadable" is the vaguer of the two true statements. A malformed AcroForm
 * still fails closed — it just does not get to hide the XFA.
 */
function inspectSource(doc: PDFDocument, sizeBytes: number): SourceSafety {
    const facts = readSourceFacts(doc, sizeBytes);
    const form = readForm(doc);
    const optionalContent = describeOptionalContent(doc, null);
    const base: Omit<SourceSafety, 'refusal'> = {
        facts,
        form,
        optionalContent,
        signatureFieldNames: form.signatureFields,
        hasOutlines: hasOutlines(doc),
        hasPageLabels: hasPageLabels(doc),
    };

    if (facts.hasXfa || form.xfa) {
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.XFA_UNSAFE,
                status: M6_STATUS.XFA_UNSAFE,
                reason: 'XFAフォームを含むPDFは統合できません。',
            },
        };
    }
    if (!facts.pageTreeWalks) {
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.UNREADABLE,
                status: M6_STATUS.UNSUPPORTED_DOCUMENT,
                reason: 'このPDFのページ構造を確認できませんでした。',
            },
        };
    }
    if (!facts.readable || !form.readable) {
        // A malformed or unreadable AcroForm fails closed: a form nobody can
        // read is a form nobody can promise to carry.
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.UNSUPPORTED_FORM,
                status: M6_STATUS.UNSUPPORTED_FORM,
                reason: 'フォーム構造を読み取れないため統合できません。',
                detail: facts.reason ? { reason: facts.reason } : undefined,
            },
        };
    }
    if (!facts.attachmentsComplete) {
        // RF-R3-2: intake's answer is what decides whether the person is asked
        // about an attachment, so a census that could not prove it covered the
        // document is a refusal here rather than a quiet "none".
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.CENSUS_INCOMPLETE,
                status: M6_STATUS.CENSUS_INCOMPLETE,
                reason: '添付ファイルの有無を完全に確認できなかったため統合できません。',
                detail: { reason: facts.attachmentsRefusal },
            },
        };
    }
    if (facts.hasAppliedSignature) {
        // M6-H2: Merge refuses an applied signature, unlike Extract. A merge
        // mixes a signed document into other people's content, and the combined
        // artifact would carry its appearance without its guarantee.
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.SIGNATURE_UNSAFE,
                status: M6_STATUS.SIGNATURE_UNSAFE,
                reason: '電子署名が適用されたPDFは統合できません。',
            },
        };
    }

    const formPlan = planFormForExtract(form, doc.getPageIndices());
    if (formPlan.status === 'REFUSE') {
        return {
            ...base,
            refusal: {
                intake: formPlan.code === 'XFA_UNSAFE'
                    ? INTAKE_RESULT.XFA_UNSAFE
                    : INTAKE_RESULT.UNSUPPORTED_FORM,
                status: formPlan.code === 'XFA_UNSAFE'
                    ? M6_STATUS.XFA_UNSAFE
                    : formPlan.code === 'FIELD_SPANS_SELECTION'
                        ? M6_STATUS.FIELD_SPANS_SELECTION
                        : M6_STATUS.UNSUPPORTED_FORM,
                reason: formPlan.reason,
                detail: formPlan.detail,
            },
        };
    }

    const ocPlan = planOptionalContent(optionalContent);
    if (ocPlan.status === 'REFUSE') {
        return {
            ...base,
            refusal: {
                intake: INTAKE_RESULT.UNSUPPORTED_OPTIONAL_CONTENT,
                status: M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                reason: ocPlan.reason,
                detail: { unsupported: ocPlan.unsupported },
            },
        };
    }

    return { ...base, refusal: null };
}

/** Inspect one source and let it go. */
async function intakeOne(input: MergeInput, policy: M6Policy): Promise<IntakeRecord> {
    const record = emptyIntake(input);
    // RF-R4-5: what these facts are facts about. Taken first, over exactly the
    // bytes every question below is asked of.
    record.contentDigest = await contentDigest(input.bytes);

    // A file the picker did not call a PDF is still reported, by name and with a
    // reason. It is not silently dropped from the list.
    if (input.type && input.type !== 'application/pdf') {
        record.result = INTAKE_RESULT.UNSUPPORTED;
        record.reason = 'PDFではないファイルです。';
        return record;
    }

    const boundary = inspectLoadBoundary(input.bytes, policy.loadBoundary);
    if (boundary.verdict === 'REFUSE') {
        record.result = INTAKE_RESULT.LOAD_BOUNDARY_REFUSED;
        record.reason = GENERIC_REFUSAL_JA;
        return record;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(input.bytes, { updateMetadata: false });
    } catch (error) {
        const kind = classifyLoadError(error);
        record.result = kind === 'ENCRYPTED' ? INTAKE_RESULT.ENCRYPTED : INTAKE_RESULT.UNREADABLE;
        record.reason = kind === 'ENCRYPTED'
            ? 'パスワード保護されたPDFは統合できません。'
            : 'このPDFを読み取れませんでした。';
        return record;
    }

    const safety = inspectSource(doc, input.bytes.length);
    record.pageCount = safety.facts.pageCount;
    record.pageTreeWalks = safety.facts.pageTreeWalks;
    record.hasAcroForm = safety.facts.hasAcroForm;
    record.hasOptionalContent = safety.facts.hasOptionalContent;
    record.hasStructTree = safety.facts.hasStructTree;
    record.hasAttachments = safety.facts.hasAttachments;
    record.attachments = [...safety.facts.attachmentNames];
    record.info = readInfo(doc);
    record.fieldNames = safety.form.fields.map((f) => f.name);

    if (safety.refusal) {
        record.result = safety.refusal.intake;
        record.reason = safety.refusal.reason;
        return record;
    }

    record.result = INTAKE_RESULT.ACCEPTED;
    return record;
}

/**
 * Intake every input, one at a time.
 *
 * Sequential on purpose: running these concurrently would put several sources in
 * memory together, which is the shape H11-MERGE-1 forbids.
 */
export async function intakeSources(
    inputs: MergeInput[],
    options: MergeOptions = {},
): Promise<IntakeRecord[]> {
    const policy = options.policy ?? PROVISIONAL_POLICY;
    assertEnforceablePolicy(policy);
    const stillOurs = options.stillOurs ?? (() => true);
    const records: IntakeRecord[] = [];
    for (const input of inputs) {
        if (!stillOurs()) {
            const cancelled = emptyIntake(input);
            cancelled.result = INTAKE_RESULT.CANCELLED;
            cancelled.reason = '操作が変更されたため、この処理は中止しました。';
            records.push(cancelled);
            continue;
        }
        records.push(await intakeOne(input, policy));
    }
    return records;
}

/** A source that was not merged, reported as what it is. */
const excludedSourceLoss = (record: IntakeRecord): LossRecord => ({
    kind: 'excluded-source',
    what: record.name,
    why: `${record.result}${record.reason ? `: ${record.reason}` : ''}`,
});

/** Plan a Merge from records intake already produced. */
export function planMerge(intake: IntakeRecord[], options: MergeOptions = {}): MergePlan {
    const excluded = new Set(options.excluded ?? []);
    const metadataPolicy = options.metadataPolicy ?? 'M4';
    const collisionPolicy = options.collisionPolicy ?? 'rename';

    /**
     * A requested source with no finalized state fails the whole plan.
     *
     * Treating it as simply absent is exactly the silent omission this contract
     * exists to stop. `NOT_DECIDED` is never a reason to proceed with fewer
     * files than were asked for.
     */
    const undecided = intake.filter((r) => r.result === INTAKE_RESULT.NOT_DECIDED);
    if (undecided.length > 0) {
        return {
            status: M6_STATUS.UNSUPPORTED_DOCUMENT,
            reason: '次のファイルを確認できなかったため、統合を中止しました: '
                + undecided.map((r) => r.name).join(', '),
            intake,
            order: [],
            metadataPolicy,
            collisionPolicy,
            losses: [],
            requiresConfirmation: [],
            detail: { undecided: undecided.map((r) => r.name) },
        };
    }

    const accepted = intake.filter(
        (r) => r.result === INTAKE_RESULT.ACCEPTED && !excluded.has(r.id),
    );

    const losses: LossRecord[] = [];
    for (const record of intake) {
        if (record.result !== INTAKE_RESULT.ACCEPTED || excluded.has(record.id)) {
            // Not a content loss: a whole file was left out, and calling that a
            // broken internal link told the person the wrong thing entirely.
            losses.push(excludedSourceLoss(record));
            continue;
        }
        if (record.hasStructTree) {
            losses.push({
                kind: 'tagging',
                what: record.name,
                why: 'タグ構造は統合後に再構成できないため削除します。',
            });
        }
        if (record.hasAttachments) {
            // RF-R4-6: the confirmation names the attachment, not only the
            // file it is in — "source.pdf — secret-notes.txt", one entry per
            // attachment, and an explicit unnamed entry where the document
            // gives no name.
            const why = '添付ファイルは統合後のPDFに引き継がれません。';
            const named = attachmentLosses(record.attachments ?? [], why, record.name);
            losses.push(...(named.length > 0
                ? named
                : [{ kind: 'attachments' as const, what: record.name, why }]));
        }
    }

    if (accepted.length === 0) {
        return {
            status: M6_STATUS.EMPTY_SELECTION,
            reason: '統合できるPDFがありません。',
            intake,
            order: [],
            metadataPolicy,
            collisionPolicy,
            losses,
            requiresConfirmation: [],
        };
    }

    // Field-name collisions across sources. Renaming is only offered because
    // `readForm` has already refused the documents where a rename could break
    // something invisible — AcroForm `/CO`, a field `/AA`, document JavaScript.
    const seen = new Map<string, string>();
    const collisions = new Set<string>();
    for (const record of accepted) {
        for (const name of record.fieldNames) {
            if (seen.has(name) && seen.get(name) !== record.id) collisions.add(name);
            else seen.set(name, record.id);
        }
    }
    if (collisions.size > 0 && collisionPolicy === 'refuse') {
        return {
            status: M6_STATUS.DUPLICATE_FIELD_NAMES,
            reason: `同じフィールド名が複数のPDFにあります: ${[...collisions].join(', ')}`,
            intake,
            order: accepted.map((r) => r.id),
            metadataPolicy,
            collisionPolicy,
            losses,
            requiresConfirmation: [],
            detail: { collisions: [...collisions] },
        };
    }

    const needed = [...new Set(losses.map((l) => l.kind))].filter(requiresConfirmation);

    return {
        status: M6_STATUS.READY,
        intake,
        order: accepted.map((r) => r.id),
        metadataPolicy,
        collisionPolicy,
        losses,
        requiresConfirmation: needed,
        detail: { collisions: [...collisions] },
    };
}

/**
 * What a confirmation is a confirmation **of**. RF-R3-3.
 *
 * A confirmation used to be a set of loss kinds held in the UI, which outlived
 * the plan it was given for: confirm a Merge of A and B, add C, click once, and
 * C's attachment was deleted having never been shown. "Attachments may be
 * removed" is not something a person agrees to in general — they agree to the
 * losses they were shown, for the files they were shown them for.
 *
 * So the agreement is bound to everything that decides what those losses are:
 * which sources were requested and how each was decided, the order they merge
 * in, the exact gated losses by kind and by name, and the policies that shape
 * them. Any of those changing produces a different fingerprint, and a
 * fingerprint that does not match is not a confirmation.
 */
export function mergeConfirmationFingerprint(plan: MergePlan): string {
    const gated = plan.losses
        .filter((l) => requiresConfirmation(l.kind))
        .map((l) => `${l.kind}|${l.what ?? ''}`)
        .sort();
    return JSON.stringify({
        order: plan.order,
        // Every requested source, not only the accepted ones: a file that was
        // refused is part of what the person was looking at when they agreed.
        // And its content (RF-R4-5): the same id over different bytes is a
        // different plan, whatever its facts claim.
        intake: plan.intake.map((r) => `${r.id}|${r.result}|${r.contentDigest ?? ''}`),
        gated,
        metadataPolicy: plan.metadataPolicy,
        collisionPolicy: plan.collisionPolicy,
    });
}

const refusedMerge = (
    status: MergeResult['status'],
    reason: string,
    intake: IntakeRecord[],
    outputName: string,
    detail?: Record<string, unknown>,
    losses: LossRecord[] = [],
): MergeResult => ({
    status,
    reason,
    bytes: null,
    outputName,
    intake,
    losses,
    renamedFields: [],
    cumulative: null,
    readback: null,
    detail,
});

/** A named destination surviving into the merged output. */
interface MergedName {
    name: string;
    /** The key as it was written in its source. BLK-R4-1. */
    key: PdfText;
    source: string;
    /** Output page index. */
    targetIndex: number;
    tail: StripOutcome['survivingNames'][number]['tail'];
}

/**
 * Run a Merge, one source at a time.
 *
 * The loop body is the adopted order, and the release at its end is what keeps
 * the peak to "the output so far, plus this one source".
 */
export async function runMerge(
    inputs: MergeInput[],
    plan: MergePlan,
    options: MergeOptions = {},
): Promise<MergeResult> {
    const policy = options.policy ?? PROVISIONAL_POLICY;
    assertEnforceablePolicy(policy);
    const stillOurs = options.stillOurs ?? (() => true);
    const byId = new Map(inputs.map((i) => [i.id, i]));
    const ordered = plan.order
        .map((id) => byId.get(id))
        .filter((i): i is MergeInput => i !== undefined);
    const outputName = mergeOutputName(ordered.map((i) => i.name));

    if (plan.status !== M6_STATUS.READY) {
        return refusedMerge(
            plan.status,
            plan.reason ?? GENERIC_REFUSAL_JA,
            plan.intake,
            outputName,
            plan.detail,
            plan.losses,
        );
    }
    if (ordered.length === 0) {
        return refusedMerge(
            M6_STATUS.EMPTY_SELECTION,
            '統合できるPDFがありません。',
            plan.intake,
            outputName,
            undefined,
            plan.losses,
        );
    }

    /**
     * A confirmation flag that is computed and then ignored is not a
     * confirmation. If the plan says a loss needs agreeing to, the Merge does
     * not proceed and disclose it afterwards.
     *
     * And a confirmation given for a different plan is not one either: it only
     * counts when it was given for this exact set of sources and losses.
     */
    const fingerprint = mergeConfirmationFingerprint(plan);
    const confirmed = new Set(
        options.confirmedFingerprint === fingerprint ? (options.confirmedLosses ?? []) : [],
    );
    const outstanding = plan.requiresConfirmation.filter((k) => !confirmed.has(k));
    if (outstanding.length > 0) {
        return refusedMerge(
            M6_STATUS.CONFIRMATION_REQUIRED,
            'この統合では次の内容が失われます。内容を確認してから実行してください。',
            plan.intake,
            outputName,
            { requiresConfirmation: outstanding, fingerprint },
            plan.losses,
        );
    }

    const collisions = new Set((plan.detail?.collisions as string[]) ?? []);
    const out = await PDFDocument.create({ updateMetadata: false });
    const losses: LossRecord[] = [...plan.losses];
    const seenLoss = new Set(losses.map((l) => `${l.kind}|${l.what ?? ''}`));
    const addLoss = (loss: LossRecord): void => {
        const key = `${loss.kind}|${loss.what ?? ''}`;
        if (seenLoss.has(key)) return;
        seenLoss.add(key);
        losses.push(loss);
    };

    const renamedFields: { from: string; to: string; source: string }[] = [];
    const metadataSources: { name: string; info: Record<string, PdfText> }[] = [];
    const mergedNames: MergedName[] = [];
    let cumulative: StructuralPlan = { ...EMPTY_STRUCTURAL_PLAN };

    /** Optional-content configuration facts that must agree across sources. */
    let configName: { source: string; value: string } | null = null;
    let configBaseState: { source: string; value: string } | null = null;
    let orderPresence: { source: string; present: boolean } | null = null;

    for (let index = 0; index < ordered.length; index += 1) {
        const input = ordered[index];
        if (!stillOurs()) {
            return refusedMerge(
                M6_STATUS.CANCELLED,
                '操作が変更されたため、この処理は中止しました。',
                plan.intake,
                outputName,
                undefined,
                losses,
            );
        }

        // ---- Load Boundary, again, on the bytes about to be loaded -----------
        const boundary = inspectLoadBoundary(input.bytes, policy.loadBoundary);
        if (boundary.verdict === 'REFUSE') {
            return refusedMerge(
                M6_STATUS.LOAD_BOUNDARY_REFUSED,
                `${input.name}: ${GENERIC_REFUSAL_JA}`,
                plan.intake,
                outputName,
                { code: boundary.code, stage: boundary.stage },
                losses,
            );
        }

        let source: PDFDocument | null = await PDFDocument.load(input.bytes, {
            updateMetadata: false,
        });
        const indices = source.getPageIndices();
        metadataSources.push({ name: input.name, info: readInfoTexts(source) });

        // ---- inspect, on the UNMODIFIED document, and decide -----------------
        const safety = inspectSource(source, input.bytes.length);
        if (safety.refusal) {
            return refusedMerge(
                safety.refusal.status,
                `${input.name}: ${safety.refusal.reason}`,
                plan.intake,
                outputName,
                { source: input.name, ...safety.refusal.detail },
                losses,
            );
        }

        const intakeRecord = plan.intake.find((r) => r.id === input.id);

        /**
         * RF-R4-5 — the confirmation's authority is the bytes, not the message.
         *
         * Intake's facts reach a Worker as a message, and the plan and its
         * confirmation are built from them. A caller could keep a source's id
         * and change its bytes, and the run would sanitize what the new bytes
         * held under a confirmation given for the old ones: an attachment
         * nobody was shown, removed, READY.
         *
         * So the run re-derives, from the document it just loaded, everything
         * a confirmation is about — the content itself, by digest, and each
         * confirmation-gated fact by value — and a plan that does not describe
         * these bytes is refused. The confirmation fingerprint covers the
         * digest and the named losses, so a confirmation that matches this plan
         * is a confirmation of exactly this content.
         */
        const actualDigest = await contentDigest(input.bytes);
        const actualAttachments = [...safety.facts.attachmentNames].sort();
        const plannedAttachments = [...(intakeRecord?.attachments ?? [])].sort();
        const mismatches: string[] = [];
        if (!intakeRecord || !intakeRecord.contentDigest || intakeRecord.contentDigest !== actualDigest) {
            mismatches.push('content digest');
        }
        if ((intakeRecord?.hasAttachments ?? false) !== safety.facts.hasAttachments
            || plannedAttachments.join('\u0000') !== actualAttachments.join('\u0000')) {
            mismatches.push('attachments');
        }
        if ((intakeRecord?.hasStructTree ?? false) !== safety.facts.hasStructTree) {
            mismatches.push('tagging');
        }
        if (mismatches.length > 0) {
            return refusedMerge(
                M6_STATUS.PLAN_RUNTIME_MISMATCH,
                `${input.name}: 事前に確認した内容と実際の内容が一致しませんでした。`
                + 'ファイルを読み込み直してから実行してください。',
                plan.intake,
                outputName,
                {
                    source: input.name,
                    mismatches,
                    planned: {
                        hasAttachments: intakeRecord?.hasAttachments ?? false,
                        attachments: plannedAttachments,
                        hasStructTree: intakeRecord?.hasStructTree ?? false,
                    },
                    actual: {
                        hasAttachments: safety.facts.hasAttachments,
                        attachments: actualAttachments,
                        hasStructTree: safety.facts.hasStructTree,
                    },
                },
                losses,
            );
        }

        /**
         * The plan said this source's optional content was carryable. If the
         * bytes disagree, that is a refusal — never a reason to skip the carry
         * and continue, which would lose the configuration silently.
         */
        const plannedOc = intakeRecord?.hasOptionalContent ?? false;
        if (plannedOc !== safety.optionalContent.present) {
            return refusedMerge(
                M6_STATUS.PLAN_RUNTIME_MISMATCH,
                `${input.name}: 事前に確認した内容と実際の内容が一致しませんでした。`,
                plan.intake,
                outputName,
                {
                    source: input.name,
                    planned: plannedOc,
                    actual: safety.optionalContent.present,
                },
                losses,
            );
        }

        // Optional-content configuration facts that cannot be combined without
        // losing one of them.
        const oc = safety.optionalContent;
        if (oc.present && oc.unsupported.length === 0) {
            if (oc.dName !== null) {
                if (configName && configName.value !== oc.dName) {
                    return refusedMerge(
                        M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                        `${input.name}: レイヤー設定の名称が ${configName.source} と異なるため、`
                        + 'どちらかを失わずに統合できません。',
                        plan.intake,
                        outputName,
                        { source: input.name, conflict: 'D /Name' },
                        losses,
                    );
                }
                configName = configName ?? { source: input.name, value: oc.dName };
            }
            if (oc.baseState !== null) {
                if (configBaseState && configBaseState.value !== oc.baseState) {
                    return refusedMerge(
                        M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                        `${input.name}: レイヤーの初期表示状態が ${configBaseState.source} と異なるため、`
                        + 'どちらかを失わずに統合できません。',
                        plan.intake,
                        outputName,
                        { source: input.name, conflict: 'D /BaseState' },
                        losses,
                    );
                }
                configBaseState = configBaseState ?? { source: input.name, value: oc.baseState };
            }
            if (oc.pageProperties.length > 0 || oc.xobjectUsages.length > 0) {
                if (orderPresence && orderPresence.present !== oc.orderPresent) {
                    // One source draws its panel from an `/Order` tree and
                    // another does not. Combining them would leave the groups
                    // from the unordered source out of the panel, which is a
                    // visibility change rather than a layout detail.
                    return refusedMerge(
                        M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                        `${input.name}: レイヤーの表示順の指定有無が ${orderPresence.source} と異なるため、`
                        + 'どのレイヤーも隠さずに統合できません。',
                        plan.intake,
                        outputName,
                        { source: input.name, conflict: 'D /Order presence' },
                        losses,
                    );
                }
                orderPresence = orderPresence ?? { source: input.name, present: oc.orderPresent };
            }
        }

        if (safety.signatureFieldNames.length > 0) {
            addLoss({
                kind: 'empty-signature-field',
                what: `${input.name}: ${safety.signatureFieldNames.join(', ')}`,
                why: '未署名の署名欄は統合後のPDFには引き継がれないため削除しました。',
            });
        }
        if (safety.hasOutlines) {
            addLoss({
                kind: 'outlines',
                what: input.name,
                why: 'しおりは引き継がれません（今回の対応範囲外）。',
            });
        }
        if (safety.hasPageLabels) {
            addLoss({
                kind: 'page-labels',
                what: input.name,
                why: 'ページラベルは引き継がれません（今回の対応範囲外）。',
            });
        }

        const sourceFields: FormField[] = safety.form.fields.filter((f) => f.ft !== '/Sig');
        const formDa = safety.form.da;

        // ---- only now: sanitize ---------------------------------------------
        /**
         * RF-R5-1: name every annotation before anything is planned or
         * removed. `removeAttachmentsEverywhere` below takes file-attachment
         * annotations out of `/Annots` after both reconstruction plans are
         * made, which moved every later entry; the plans are bound to the
         * reference instead of to the position.
         */
        nameAnnotationsByReference(source, indices);
        const signatureRemoval = removeSignatureWidgets(source);
        if (signatureRemoval.unclassified.length > 0) {
            return refusedMerge(
                M6_STATUS.UNSUPPORTED_FORM,
                `${input.name}: フォームの継承関係を読み取れず、署名欄かどうかを判定できないため統合できません。`,
                plan.intake,
                outputName,
                { source: input.name, unclassified: signatureRemoval.unclassified },
                losses,
            );
        }

        const strip = sanitizeDestinations(source, indices);
        if (strip.duplicateNames.length > 0) {
            // RF-R4-3: within one source, before any cross-source comparison.
            return refusedMerge(
                M6_STATUS.DUPLICATE_NAMED_DESTINATIONS,
                `${input.name}: 同じ名前の名前付きジャンプ先が複数定義されているため統合できません: `
                + strip.duplicateNames.join(', '),
                plan.intake,
                outputName,
                { source: input.name, duplicates: strip.duplicateNames },
                losses,
            );
        }
        if (strip.unreadable.length > 0) {
            return refusedMerge(
                M6_STATUS.UNREADABLE_DESTINATIONS,
                `${input.name}: ジャンプ先の構造を完全に読み取れなかったため統合できません: `
                + strip.unreadable.join(', '),
                plan.intake,
                outputName,
                { source: input.name, unreadable: strip.unreadable },
                losses,
            );
        }
        const closure = closeSourcePageRefs(source, indices);
        if (closure.unreadable.length > 0) {
            return refusedMerge(
                M6_STATUS.UNSCANNABLE_ACTIONS,
                `${input.name}: この文書のアクション構造を完全に検査できませんでした: `
                + closure.unreadable.join(', '),
                plan.intake,
                outputName,
                { source: input.name, unreadable: closure.unreadable },
                losses,
            );
        }
        for (const loss of [...strip.losses, ...closure.losses]) {
            addLoss({ ...loss, what: [input.name, loss.what].filter(Boolean).join(' ') });
        }

        const strippedAttachments = removeAttachmentsEverywhere(source);
        if (!strippedAttachments.complete) {
            return refusedMerge(
                M6_STATUS.CENSUS_INCOMPLETE,
                `${input.name}: 添付ファイルの有無を完全に確認できなかったため処理しません。`,
                plan.intake,
                outputName,
                { source: input.name, reason: strippedAttachments.reason },
                losses,
            );
        }
        // In the plan's own words, so what was removed and what was confirmed
        // are the same entries rather than two descriptions of one thing.
        for (const loss of attachmentLosses(
            strippedAttachments.names,
            '添付ファイルは統合後のPDFに引き継がれません。',
            input.name,
        )) addLoss(loss);
        for (const kind of strippedAttachments.removedActions) {
            addLoss({
                kind: 'internal-links',
                what: `${input.name}: /${kind}`,
                why: '対応範囲外のアクションに添付が含まれていたため、そのアクションごと削除しました。',
            });
        }

        // ---- structural planning, and the cumulative cap before the copy ----
        const thisSource = await planStructuralGraph(source, indices);
        if (thisSource.pageLeavesReached > 0) {
            // RF-H: the pre-copy invariant is hard. A route this contract does
            // not support left a reference to a page outside the copy, and the
            // answer is a refusal before `copyPages` rather than a readback
            // after `save`.
            return refusedMerge(
                M6_STATUS.UNSUPPORTED_DOCUMENT,
                `${input.name}: 選択していないページを参照する構造が残っています。`
                + '安全に説明できないため処理しません。',
                plan.intake,
                outputName,
                { source: input.name, pageLeavesReached: thisSource.pageLeavesReached },
                losses,
            );
        }
        const after = addStructuralPlans(cumulative, thisSource);
        const breach = checkCumulativeCaps(after, policy.structural);
        if (breach) {
            return refusedMerge(
                M6_STATUS.OVER_STRUCTURAL_CAP,
                `${input.name} を加えると上限を超えます。${breach.reason}`,
                plan.intake,
                outputName,
                { term: breach.term, value: breach.value, cap: breach.cap, source: input.name },
                losses,
            );
        }

        // ---- copy -----------------------------------------------------------
        const firstNewPage = out.getPageCount();
        const copied = await out.copyPages(source, indices);
        copied.forEach((page) => out.addPage(page));
        cumulative = after;

        // ---- reconstruction, against the merged output ----------------------
        //
        // RF-B: stripping a source's destinations and not rebuilding them turned
        // a refusal into a successful silent loss — the link annotations
        // survived with no target and nothing was reported.
        const mergedSelection = Array.from({ length: out.getPageCount() }, (_v, i) => i);
        const shiftedStrip: StripOutcome = {
            rebuild: strip.rebuild.map((r) => ({
                ...r,
                fromIndex: r.fromIndex + firstNewPage,
                targetIndex: r.targetIndex + firstNewPage,
            })),
            survivingNames: [],
            losses: [],
            unreadable: [],
            duplicateNames: [],
        };
        const rebuiltDestinations = rebuildDestinations(out, shiftedStrip, mergedSelection, source);
        const rebuiltPageRefs = rebuildSourcePageRefs(
            out,
            {
                ...closure,
                rebuild: closure.rebuild.map((r) => ({
                    ...r,
                    targetIndex: r.targetIndex + firstNewPage,
                })),
            },
            mergedSelection,
            source,
        );
        const unapplied = [...rebuiltDestinations.unapplied, ...rebuiltPageRefs.unapplied];
        if (unapplied.length > 0) {
            return refusedMerge(
                M6_STATUS.PLAN_ACTUAL_MISMATCH,
                `${input.name}: 事前に計画したリンクの復元ができませんでした。安全のため書き出しません。`,
                plan.intake,
                outputName,
                { source: input.name, unapplied },
                losses,
            );
        }

        for (const surviving of strip.survivingNames) {
            const clash = mergedNames.find(
                (n) => n.name === surviving.name
                    && n.targetIndex !== surviving.targetIndex + firstNewPage,
            );
            if (clash) {
                // No adopted collision policy resolves a named-destination clash,
                // and silently overwriting or renaming one is exactly the silent
                // change this contract forbids.
                return refusedMerge(
                    M6_STATUS.DUPLICATE_NAMED_DESTINATIONS,
                    `${input.name}: 名前付きジャンプ先 "${surviving.name}" が `
                    + `${clash.source} と衝突するため、どちらかを失わずに統合できません。`,
                    plan.intake,
                    outputName,
                    { source: input.name, conflict: 'named destination', name: surviving.name },
                    losses,
                );
            }
            if (!mergedNames.some((n) => n.name === surviving.name)) {
                mergedNames.push({
                    name: surviving.name,
                    key: surviving.key,
                    source: input.name,
                    targetIndex: surviving.targetIndex + firstNewPage,
                    tail: surviving.tail,
                });
            }
        }

        if (oc.present && oc.unsupported.length === 0) {
            if (oc.pageProperties.length === 0 && oc.xobjectUsages.length === 0) {
                // The source declares optional content that no page of it uses
                // — through `/Properties` or through a form XObject's `/OC`.
                // Carrying nothing would drop the configuration silently.
                return refusedMerge(
                    M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                    `${input.name}: レイヤー設定を統合後のPDFに再現できません。`,
                    plan.intake,
                    outputName,
                    { source: input.name, conflict: 'no page uses the declared groups' },
                    losses,
                );
            }
            const shifted: OptionalContentDescription = {
                ...oc,
                pageProperties: oc.pageProperties.map((e) => ({
                    ...e,
                    pageIndex: e.pageIndex + firstNewPage,
                })),
                // A form XObject's `/OC` is found again through the output page
                // it landed on, so its page index shifts with the rest.
                xobjectUsages: oc.xobjectUsages.map((e) => ({
                    ...e,
                    pageIndex: e.pageIndex + firstNewPage,
                })),
            };
            const carried = carryOptionalContent(source, shifted, out);
            if (carried.status === 'REFUSED') {
                return refusedMerge(
                    M6_STATUS.UNSUPPORTED_OPTIONAL_CONTENT,
                    `${input.name}: ${carried.reason}`,
                    plan.intake,
                    outputName,
                    { source: input.name, unsupported: carried.unsupported },
                    losses,
                );
            }
        }

        if (sourceFields.length > 0) {
            const rebuilt = rebuildAcroForm(out, sourceFields, {
                da: formDa,
                startPage: firstNewPage,
                rename: (name) => (collisions.has(name) && plan.collisionPolicy === 'rename'
                    ? `source${index + 1}.${name}`
                    : name),
            });
            if (rebuilt.unwritable.length > 0) {
                return refusedMerge(
                    M6_STATUS.PLAN_ACTUAL_MISMATCH,
                    `${input.name}: フォームのフィールド名を安全に書き出せませんでした。安全のため書き出しません。`,
                    plan.intake,
                    outputName,
                    { source: input.name, unwritable: rebuilt.unwritable },
                    losses,
                );
            }
            for (const r of rebuilt.renamed) renamedFields.push({ ...r, source: input.name });
        }

        // ---- release, before the next source is touched ----------------------
        source = null;
    }

    if (!stillOurs()) {
        return refusedMerge(
            M6_STATUS.CANCELLED,
            '操作が変更されたため、この処理は中止しました。',
            plan.intake,
            outputName,
            undefined,
            losses,
        );
    }

    // The named destinations that survived, written once against the output.
    if (mergedNames.length > 0) {
        const written = rebuildDestinations(
            out,
            {
                rebuild: [],
                survivingNames: mergedNames.map((n) => ({
                    name: n.name,
                    key: n.key,
                    targetIndex: n.targetIndex,
                    tail: n.tail,
                })),
                losses: [],
                unreadable: [],
                duplicateNames: [],
            },
            Array.from({ length: out.getPageCount() }, (_v, i) => i),
        );
        if (written.unapplied.length > 0) {
            return refusedMerge(
                M6_STATUS.PLAN_ACTUAL_MISMATCH,
                '事前に計画した名前付きジャンプ先を書き出せませんでした。安全のため中止します。',
                plan.intake,
                outputName,
                { unapplied: written.unapplied },
                losses,
            );
        }
    }

    const strippedTagging = stripTaggingEverywhere(out);
    if (!strippedTagging.complete) {
        return refusedMerge(
            M6_STATUS.CENSUS_INCOMPLETE,
            'タグ構造を完全に確認できなかったため処理しません。',
            plan.intake,
            outputName,
            { reason: strippedTagging.reason },
            losses,
        );
    }

    const outputAttachments = removeAttachmentsEverywhere(out);
    if (!outputAttachments.complete) {
        return refusedMerge(
            M6_STATUS.CENSUS_INCOMPLETE,
            '添付ファイルの有無を完全に確認できなかったため処理しません。',
            plan.intake,
            outputName,
            { reason: outputAttachments.reason },
            losses,
        );
    }
    dropOpenAction(out);

    const sanitized = sanitizeJavaScript(out);
    if (sanitized.status === 'REFUSED') {
        return refusedMerge(
            M6_STATUS.UNSCANNABLE_ACTIONS,
            sanitized.reason,
            plan.intake,
            outputName,
            { incomplete: sanitized.incomplete },
            losses,
        );
    }

    const scrubbed = scrubAllJavaScript(out);
    if (!scrubbed.complete) {
        return refusedMerge(
            M6_STATUS.CENSUS_INCOMPLETE,
            'JavaScriptの有無を完全に確認できなかったため処理しません。',
            plan.intake,
            outputName,
            { reason: scrubbed.reason },
            losses,
        );
    }

    applyMergeMetadata(out, plan.metadataPolicy, metadataSources);

    // Before anything is swept: put `/Length` into the direct form `save()`
    // will write, so a copied indirect length object is unreachable now rather
    // than orphaned in the bytes afterwards.
    const lengths = canonicalizeStreamLengthsForSave(out);
    if (lengths.undescribable.length > 0) {
        return refusedMerge(
            M6_STATUS.INVARIANT_VIOLATED,
            `書き出す前に、${lengths.undescribable.length} 件のストリームの長さを確認できませんでした。安全のため書き出しません。`,
            plan.intake,
            outputName,
            { undescribableStreams: lengths.undescribable.length },
            losses,
        );
    }

    // Nothing points at it, so nothing writes it.
    pruneUnreachable(out);

    const bytes = await out.save({ useObjectStreams: false });

    if (bytes.length > policy.output.maxOutputBytes) {
        return refusedMerge(
            M6_STATUS.OVER_OUTPUT_BUDGET,
            `統合したPDFが上限を超えました（${(bytes.length / (1024 * 1024)).toFixed(1)} MiB / `
            + `上限 ${(policy.output.maxOutputBytes / (1024 * 1024)).toFixed(0)} MiB）。`,
            plan.intake,
            outputName,
            { bytes: bytes.length, ceiling: policy.output.maxOutputBytes },
            losses,
        );
    }

    const expectedPages = ordered.reduce((sum, input) => {
        const record = plan.intake.find((r) => r.id === input.id);
        return sum + (record?.pageCount ?? 0);
    }, 0);

    const readback = await readbackArtifact(bytes);
    const invariant = checkArtifactInvariants(readback, expectedPages);
    if (invariant) {
        return refusedMerge(
            M6_STATUS.INVARIANT_VIOLATED,
            invariant.reason,
            plan.intake,
            outputName,
            { invariant: invariant.invariant, value: invariant.value },
            losses,
        );
    }

    return {
        status: M6_STATUS.READY,
        bytes,
        outputName,
        intake: plan.intake,
        losses,
        renamedFields,
        cumulative,
        readback,
        detail: {
            policy: policy.origin,
            policyProvisional: policy.provisional,
            sourcesCopied: ordered.length,
            namedDestinations: mergedNames.length,
            confirmationRequired: plan.requiresConfirmation,
        },
    };
}

/** Loss kinds a Merge may ask a person to agree to, for the UI to render. */
export const MERGE_CONFIRMATION_LOSSES = CONFIRMATION_REQUIRED_LOSSES;
