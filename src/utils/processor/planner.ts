/**
 * Planning: the answer before the work.
 *
 * Every refusal the Processor can give is decided here, from facts read without
 * touching the document, and it is decided *before* a raster is allocated or a
 * byte is written. That ordering is the whole point: the old code found out
 * that an A1 at 600 dpi could not be rendered by failing in the middle of
 * rendering it, and found out a document was signed by having already
 * invalidated the signature.
 *
 * The H7 policy adopted is `applied-only` with XFA `refuse-if-dropped`:
 *
 *   applied signature (a /Sig field whose /V is a dictionary) → refuse, always
 *   empty signature field                                     → an ordinary form field
 *   /SigFlags alone                                           → refuses nothing
 *   XFA                                                       → refuse where the operation drops it
 *
 * Adopted: H1, H2a, H5, H6, H7, H8, H9, H11.
 */
import {
    OPERATION_CLASS,
    PLAN_STATUS,
} from './contracts';
import type {
    Plan, ProcessorOperation, SourceFacts, StructureLoss,
} from './contracts';
import {
    checkCeilings, defaultCeilings, fileCost, pageCost,
} from './budget';
import type { Ceilings, ColourSpace, StreamFilter } from './budget';

/**
 * Which operations keep XFA and which drop it.
 *
 * Only the flattening ones rebuild the document from pixels, and those are the
 * ones that lose it. Everything else either edits in place or copies the
 * catalog, so XFA survives — and is therefore allowed, per `refuse-if-dropped`.
 */
export const DROPS_XFA: Record<ProcessorOperation, boolean> = {
    layer: false,
    monochrome: true,
    both: true,
    margin: false,
    optimize: false,
    'normalize-size': false,
    'title-block-update': false,
};

/** The adopted encoding for each flattening operation (H8-A / H8-B). */
export const RASTER_ENCODING: Partial<Record<ProcessorOperation, {
    colourSpace: ColourSpace;
    filter: StreamFilter;
}>> = {
    monochrome: { colourSpace: 'DeviceGray', filter: 'flate' },
    both: { colourSpace: 'DeviceGray', filter: 'flate' },
};

/**
 * What a flattening operation may remove.
 *
 * The list is what the confirmation has to say out loud. It is the operation's
 * behaviour, not a guess about this document: the page is replaced by a picture
 * of itself, so anything that was structure is gone.
 */
export const FLATTENING_LOSSES: StructureLoss[] = [
    'searchable-text',
    'ocr-text-layer',
    'vector-structure',
    'annotations',
    'links',
    'form-fields',
];

export interface PlanSettings {
    dpi?: number;
    contrast?: number;
    memoryBudgetBytes?: number;
}

const REASON = {
    unreadable: 'このPDFを読み取れませんでした。処理を中止しました。',
    encrypted: 'パスワード保護されたPDFは処理できません。',
    noPages: 'ページが読み取れないPDFのため、処理を中止しました。',
    formUnreadable: 'このPDFのフォーム情報を読み取れなかったため、電子署名の有無を確認できませんでした。'
        + '確認できない状態では処理しません。',
    signed: '電子署名が適用されたPDFです。処理すると署名が無効になるため、処理できません。',
    xfa: 'このPDFにはXFAフォームが含まれており、この操作では保持できません。処理を中止しました。',
    raster: (mpx: number, limit: number) => `この解像度では1ページあたり${mpx.toFixed(1)}メガピクセルとなり、`
        + `上限の${(limit / 1e6).toFixed(1)}メガピクセルを超えます。解像度を下げて実行してください。`,
    memory: (needMiB: number, budgetMiB: number) => `この処理には約${needMiB.toFixed(0)} MiBが必要で、`
        + `現在の処理メモリ上限${budgetMiB.toFixed(0)} MiBを超えます。`
        + `ファイル数・ページ数を減らすか、解像度または上限設定を変更してください。`,
    output: (haveMiB: number, limitMiB: number) => `出力が約${haveMiB.toFixed(0)} MiBとなり、`
        + `上限の${limitMiB.toFixed(0)} MiBを超えます。`,
    ready: '実行できます。',
    confirm: 'この操作はページを画像に置き換えます。失われる内容を確認してください。',
} as const;

const refuse = (
    operation: ProcessorOperation,
    facts: SourceFacts,
    status: Plan['status'],
    reason: string,
): Plan => ({
    operation,
    status,
    code: status,
    reason,
    facts,
    losses: [],
    fileBytesEstimate: 0,
    filePeakBytes: 0,
});

/**
 * Plan one file. Pure: no canvas, no network, no mutation — so the gate can run
 * it in node over the same facts the browser would produce.
 */
export function planOperation(
    facts: SourceFacts,
    operation: ProcessorOperation,
    settings: PlanSettings = {},
): Plan {
    const ceilings: Ceilings = defaultCeilings(settings.memoryBudgetBytes);

    // ---- can this document be read at all? ---------------------------------
    if (facts.encrypted) return refuse(operation, facts, PLAN_STATUS.UNSUPPORTED_DOCUMENT, REASON.encrypted);
    if (!facts.readable) return refuse(operation, facts, PLAN_STATUS.UNSUPPORTED_DOCUMENT, REASON.unreadable);
    if (!facts.pagesValid) return refuse(operation, facts, PLAN_STATUS.UNSUPPORTED_DOCUMENT, REASON.noPages);
    if (facts.formInspectionState === 'unreadable') {
        // A form we cannot read may hide an applied signature. Refusing is the
        // only honest answer; the Annotator's boundary says the same.
        return refuse(operation, facts, PLAN_STATUS.SIGNATURE_UNSAFE, REASON.formUnreadable);
    }

    // ---- H7, in the adopted order ------------------------------------------
    if (facts.hasAppliedSignature) {
        return refuse(operation, facts, PLAN_STATUS.SIGNATURE_UNSAFE, REASON.signed);
    }
    if (facts.hasXfa && DROPS_XFA[operation]) {
        return refuse(operation, facts, PLAN_STATUS.XFA_UNSAFE, REASON.xfa);
    }

    // ---- the budget, for the operations that rasterise ----------------------
    const encoding = RASTER_ENCODING[operation];
    let fileBytesEstimate = 0;
    let filePeakBytes = 0;
    let raster: Plan['raster'];

    if (encoding) {
        const dpi = settings.dpi ?? 300;
        const costs = facts.pages.map((p) => pageCost(
            p.widthPt, p.heightPt, dpi, encoding.colourSpace, encoding.filter,
        ));
        const worst = costs.reduce((a, b) => (b.pixels > a.pixels ? b : a), costs[0]);
        const file = fileCost(costs);
        fileBytesEstimate = file.outputBytes;
        filePeakBytes = file.peakBytes;
        raster = {
            dpi,
            widthPx: worst.widthPx,
            heightPx: worst.heightPx,
            pixels: worst.pixels,
            peakBytes: worst.peakBytes,
            outputBytes: worst.outputBytes,
            peakStep: worst.peakStep,
        };

        const refusal = checkCeilings(
            { pixels: worst.pixels, peakBytes: file.peakBytes, outputBytes: file.outputBytes },
            ceilings,
        );
        // A refusal carries the numbers it refused on. Reporting a peak of zero
        // while saying "this needs more memory than the budget" leaves the
        // structured answer contradicting the sentence next to it, and anything
        // reading the field rather than the prose gets the wrong story.
        const measured = { raster, fileBytesEstimate, filePeakBytes };
        if (refusal === 'OVER_RASTER_LIMIT') {
            return {
                ...refuse(operation, facts, PLAN_STATUS.OVER_RASTER_LIMIT,
                    REASON.raster(worst.pixels / 1e6, ceilings.maxRasterPixels)),
                ...measured,
            };
        }
        if (refusal === 'OVER_MEMORY_BUDGET') {
            return {
                ...refuse(operation, facts, PLAN_STATUS.OVER_MEMORY_BUDGET,
                    REASON.memory(file.peakBytes / 1048576, ceilings.memoryBytes / 1048576)),
                ...measured,
            };
        }
        if (refusal === 'OVER_OUTPUT_BUDGET') {
            return {
                ...refuse(operation, facts, PLAN_STATUS.OVER_OUTPUT_BUDGET,
                    REASON.output(file.outputBytes / 1048576, ceilings.maxOutputBytes / 1048576)),
                ...measured,
            };
        }
    }

    // ---- H5/H6: a loss is agreed to, never assumed --------------------------
    if (OPERATION_CLASS[operation] === 'INTENTIONAL_FLATTENING') {
        return {
            operation,
            status: PLAN_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION,
            code: PLAN_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION,
            reason: REASON.confirm,
            facts,
            raster,
            losses: FLATTENING_LOSSES,
            fileBytesEstimate,
            filePeakBytes,
        };
    }

    return {
        operation,
        status: PLAN_STATUS.READY,
        code: PLAN_STATUS.READY,
        reason: REASON.ready,
        facts,
        raster,
        losses: [],
        fileBytesEstimate,
        filePeakBytes,
    };
}

/**
 * A confirmed flattening plan becomes runnable, and only then.
 *
 * The confirmation is checked against the exact plan it was given for; a plan
 * that is refused for any other reason cannot be confirmed into readiness.
 */
export function withConfirmation(plan: Plan, confirmed: boolean): Plan {
    if (!confirmed) return plan;
    if (plan.status !== PLAN_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION) return plan;
    return { ...plan, status: PLAN_STATUS.READY, code: PLAN_STATUS.READY, reason: REASON.ready };
}
