/**
 * Merge: intake, plan, run, publish.
 *
 * Two contracts shape every line of this file.
 *
 * **No all-source lifetime (H11-MERGE-1 … 3).** A Merge never holds more than
 * one source as a loaded `PDFDocument`. Each source goes through
 * `Load Boundary -> PASS -> load -> structural planning -> cumulative cap ->
 * copy -> release`, and is released before the next is loaded. B2 measured each
 * source becoming collectable once the loop let go of it, and nothing in the
 * output pointing back at it; preloading every source would hold every source
 * graph at once and adds nothing the sequential route needs.
 *
 * **Intake is not a loophole (A6).** The obvious way to write intake is to load
 * every file to read its page count and then keep the documents around for the
 * copy. That is all-source preload wearing a different name. So intake loads one
 * source at a time, converts what it learned into a plain serialisable
 * `IntakeRecord`, and lets the document go — and the copy loop loads each source
 * again from bytes it never stopped owning.
 *
 * **Every input carries a result (M6-H10).** What must never happen again is
 * today's behaviour: `handleMergeUpload` skipped anything whose MIME type was
 * not `application/pdf` with a bare `continue` and swallowed a failed load with
 * `console.error`, so five files chosen and four merged was presented as an
 * ordinary success.
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
    EMPTY_STRUCTURAL_PLAN,
    GENERIC_REFUSAL_JA,
    INTAKE_RESULT,
    M6_STATUS,
} from './contracts';
import { inspectLoadBoundary } from './load-boundary';
import { assertEnforceablePolicy, PROVISIONAL_POLICY } from './policy';
import type { M6Policy } from './policy';
import { classifyLoadError, readSourceFacts } from './source-facts';
import { describeOptionalContent } from './optional-content';
import { sanitizeJavaScript } from './javascript';
import { readForm, rebuildAcroForm, removeSignatureWidgets } from './forms';
import type { FormField } from './forms';
import { checkCumulativeCaps, graphOfWholeDocument, planStructuralGraph } from './structural-graph';
import {
    applyMergeMetadata,
    dropOpenAction,
    readInfo,
    removeAttachments,
    stripTagging,
} from './structure';
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
    info: {},
});

/**
 * Inspect one source and let it go.
 *
 * Everything this function learns becomes a plain record. The `PDFDocument` it
 * loaded is unreachable by the time it returns, which is what keeps intake
 * inside the no-preload contract.
 */
async function intakeOne(input: MergeInput, policy: M6Policy): Promise<IntakeRecord> {
    const record = emptyIntake(input);

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

    const facts = readSourceFacts(doc, input.bytes.length);
    record.pageCount = facts.pageCount;
    record.pageTreeWalks = facts.pageTreeWalks;
    record.hasAcroForm = facts.hasAcroForm;
    record.hasOptionalContent = facts.hasOptionalContent;
    record.hasStructTree = facts.hasStructTree;
    record.hasAttachments = facts.hasAttachments;
    record.info = readInfo(doc);

    // A document whose `/Count` disagrees with its `/Kids` loads cleanly and
    // reports a page count, then fails later. Intake cannot be "whatever the
    // loader accepts", so the tree is walked here.
    if (!facts.readable || !facts.pageTreeWalks) {
        record.result = INTAKE_RESULT.UNREADABLE;
        record.reason = 'このPDFのページ構造を確認できませんでした。';
        return record;
    }

    if (facts.hasXfa) {
        record.result = INTAKE_RESULT.XFA_UNSAFE;
        record.reason = 'XFAフォームを含むPDFは統合できません。';
        return record;
    }

    // M6-H2: Merge refuses an applied signature, unlike Extract. The asymmetry
    // is deliberate — a merge mixes a signed document into other people's
    // content, and the combined artifact would carry the signed document's
    // appearance without its guarantee. An empty `/Sig` field stays permitted,
    // because an unsigned signature field is a form control.
    if (facts.hasAppliedSignature) {
        record.result = INTAKE_RESULT.SIGNATURE_UNSAFE;
        record.reason = '電子署名が適用されたPDFは統合できません。';
        return record;
    }

    const form = readForm(doc);
    record.fieldNames = form.fields.map((f) => f.name);

    const oc = describeOptionalContent(doc, null);
    if (oc.present && oc.unsupported.length > 0) {
        record.result = INTAKE_RESULT.UNREADABLE;
        record.reason = `対応範囲外のオプショナルコンテンツを含みます: ${oc.unsupported[0]}`;
        return record;
    }

    record.result = INTAKE_RESULT.ACCEPTED;
    return record;
}

/**
 * Intake every input, one at a time.
 *
 * Sequential on purpose, not for tidiness: running these concurrently would put
 * several sources in memory together, which is the shape H11-MERGE-1 forbids.
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

/** Plan a Merge from records intake already produced. */
export function planMerge(intake: IntakeRecord[], options: MergeOptions = {}): MergePlan {
    const excluded = new Set(options.excluded ?? []);
    const metadataPolicy = options.metadataPolicy ?? 'M4';
    const collisionPolicy = options.collisionPolicy ?? 'rename';

    const accepted = intake.filter(
        (r) => r.result === INTAKE_RESULT.ACCEPTED && !excluded.has(r.id),
    );

    const losses: LossRecord[] = [];
    for (const record of intake) {
        if (record.result !== INTAKE_RESULT.ACCEPTED || excluded.has(record.id)) continue;
        if (record.hasStructTree) {
            losses.push({
                kind: 'tagging',
                what: record.name,
                why: 'タグ構造は統合後に再構成できないため削除します。',
            });
        }
        if (record.hasAttachments) {
            losses.push({
                kind: 'attachments',
                what: record.name,
                why: '添付ファイルは統合後のPDFに引き継がれません。',
            });
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

    // Field-name collisions across sources. Renaming is only offered because the
    // documents where a rename could break something invisible — AcroForm `/CO`,
    // a field `/AA`, a document-level `/Names /JavaScript` — are detected and
    // refused by `readForm` before this point.
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

    const requiresConfirmation = [...new Set(losses.map((l) => l.kind))]
        .filter((k) => k === 'attachments' || k === 'tagging');

    return {
        status: M6_STATUS.READY,
        intake,
        order: accepted.map((r) => r.id),
        metadataPolicy,
        collisionPolicy,
        losses,
        requiresConfirmation,
        detail: { collisions: [...collisions] },
    };
}

const refusedMerge = (
    status: MergeResult['status'],
    reason: string,
    intake: IntakeRecord[],
    outputName: string,
    detail?: Record<string, unknown>,
): MergeResult => ({
    status,
    reason,
    bytes: null,
    outputName,
    intake,
    losses: [],
    renamedFields: [],
    cumulative: null,
    readback: null,
    detail,
});

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
        return refusedMerge(plan.status, plan.reason ?? GENERIC_REFUSAL_JA, plan.intake, outputName);
    }
    if (ordered.length === 0) {
        return refusedMerge(
            M6_STATUS.EMPTY_SELECTION,
            '統合できるPDFがありません。',
            plan.intake,
            outputName,
        );
    }

    const collisions = new Set((plan.detail?.collisions as string[]) ?? []);
    const out = await PDFDocument.create({ updateMetadata: false });
    const losses: LossRecord[] = [...plan.losses];
    const renamedFields: { from: string; to: string; source: string }[] = [];
    const metadataSources: { name: string; info: Record<string, string> }[] = [];
    let cumulative: StructuralPlan = { ...EMPTY_STRUCTURAL_PLAN };

    for (let index = 0; index < ordered.length; index += 1) {
        const input = ordered[index];
        if (!stillOurs()) {
            return refusedMerge(
                M6_STATUS.CANCELLED,
                '操作が変更されたため、この処理は中止しました。',
                plan.intake,
                outputName,
            );
        }

        // ---- Load Boundary, again, on the bytes about to be loaded ----------
        //
        // Re-checked rather than trusted from intake: the contract is that
        // `PDFDocument.load()` is called only on bytes that passed, and intake
        // may have happened long enough ago for the list to have changed.
        const boundary = inspectLoadBoundary(input.bytes, policy.loadBoundary);
        if (boundary.verdict === 'REFUSE') {
            return refusedMerge(
                M6_STATUS.LOAD_BOUNDARY_REFUSED,
                `${input.name}: ${GENERIC_REFUSAL_JA}`,
                plan.intake,
                outputName,
                { code: boundary.code, stage: boundary.stage },
            );
        }

        let source: PDFDocument | null = await PDFDocument.load(input.bytes, {
            updateMetadata: false,
        });
        const indices = source.getPageIndices();
        metadataSources.push({ name: input.name, info: readInfo(source) });

        // An applied signature was refused at intake. An EMPTY `/Sig` field was
        // accepted, because it is a form control rather than a signature — but
        // the reconstruction does not rebuild signature fields, so its widget
        // would arrive in the artifact belonging to nothing. It goes here,
        // before the graph is counted, so the count still describes the copy.
        removeSignatureWidgets(source);

        const form = readForm(source);
        const sourceFields: FormField[] = form.fields.filter((f) => f.ft !== '/Sig');

        // ---- structural planning, and the cumulative cap before the copy ----
        const thisSource = await planStructuralGraph(source, indices);
        const after = addStructuralPlans(cumulative, thisSource);
        const breach = checkCumulativeCaps(after, policy.structural);
        if (breach) {
            return refusedMerge(
                M6_STATUS.OVER_STRUCTURAL_CAP,
                `${input.name} を加えると上限を超えます。${breach.reason}`,
                plan.intake,
                outputName,
                { term: breach.term, value: breach.value, cap: breach.cap, source: input.name },
            );
        }

        // ---- copy -----------------------------------------------------------
        const firstNewPage = out.getPageCount();
        const copied = await out.copyPages(source, indices);
        copied.forEach((page) => out.addPage(page));
        cumulative = after;

        if (sourceFields.length > 0) {
            const rebuilt = rebuildAcroForm(out, sourceFields, {
                da: form.da,
                startPage: firstNewPage,
                rename: (name) => (collisions.has(name) && plan.collisionPolicy === 'rename'
                    ? `source${index + 1}.${name}`
                    : name),
            });
            for (const r of rebuilt.renamed) {
                renamedFields.push({ ...r, source: input.name });
            }
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
        );
    }

    stripTagging(out);
    const removedAttachments = removeAttachments(out);
    if (removedAttachments.names.length > 0) {
        losses.push({
            kind: 'attachments',
            what: removedAttachments.names.join(', '),
            why: '添付ファイルを削除しました。',
        });
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
        );
    }

    applyMergeMetadata(out, plan.metadataPolicy, metadataSources);

    const bytes = await out.save({ useObjectStreams: false });

    if (bytes.length > policy.output.maxOutputBytes) {
        return refusedMerge(
            M6_STATUS.OVER_OUTPUT_BUDGET,
            `統合したPDFが上限を超えました（${(bytes.length / (1024 * 1024)).toFixed(1)} MiB / `
            + `上限 ${(policy.output.maxOutputBytes / (1024 * 1024)).toFixed(0)} MiB）。`,
            plan.intake,
            outputName,
            { bytes: bytes.length, ceiling: policy.output.maxOutputBytes },
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
        );
    }

    // Every omitted source is named in the result, not merely missing from it.
    for (const record of plan.intake) {
        if (record.result === INTAKE_RESULT.ACCEPTED && plan.order.includes(record.id)) continue;
        losses.push({
            kind: 'internal-links',
            what: record.name,
            why: record.reason ?? 'このPDFは統合に含まれていません。',
        });
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
            finalGraph: await graphOfWholeDocument(await PDFDocument.load(bytes, {
                updateMetadata: false,
            })),
        },
    };
}
