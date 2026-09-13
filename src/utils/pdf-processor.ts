/**
 * The Processor's legacy entry points, kept as a facade.
 *
 * This module used to *be* the Processor: five functions, each with its own
 * idea of what success meant. The M5 research measured what that cost — a
 * signature invalidated in silence, XFA deleted by an inspection, searchable
 * text replaced by a picture and reported as done, an A1 at 600 dpi that failed
 * after the work had started — and the adopted architecture puts one planning
 * step in front of all of them (`src/utils/processor/`).
 *
 * What stays here is the old surface, so anything still importing it keeps
 * working, and so that the difference is visible in one place:
 *
 *  - every wrapper reads the source's facts and plans before it touches
 *    anything, and a refusal comes back as a `ProcessorError` with a code
 *    rather than as a document with something missing from it;
 *  - the flattening wrappers will not run unless the caller has said, in this
 *    call, that the losses are intended. There is no default that agrees on the
 *    user's behalf;
 *  - 「最適化」 is lossless. The old one rasterised at a chosen DPI, which made
 *    vector drawings 11–153× larger and unsearchable; `dpi` is accepted and
 *    ignored so old call sites do not break, and the operation no longer has a
 *    resolution at all.
 *
 * New code should use `src/utils/processor` directly.
 */
import {
    PLAN_STATUS,
    ProcessorError,
    planOperation,
    readSourceFacts,
    runBoth,
    runFlatten,
    runLayer,
    runMargin,
    runOptimizeLossless,
    withConfirmation,
} from './processor';
import type { ProcessorOperation } from './processor';

export type { MarginOptions } from './processor';

export interface LayerOptions {
    /** Hex string, e.g. "#ff0000". */
    color: string;
    opacity: number;
}

export interface MonoOptions {
    dpi: number;
    contrast: number;
    /**
     * The caller states, for this call, that replacing the page with a picture
     * of itself is what was wanted. Without it the operation refuses, because
     * the losses are real and the old code took them for granted.
     */
    confirmStructureLoss?: boolean;
}

export interface OptimizeOptions {
    /** Accepted and ignored: 「最適化」 is lossless and has no resolution. */
    dpi?: number;
}

const toBytes = async (input: File | Uint8Array): Promise<Uint8Array> => (
    input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer())
);

/** Plan first; throw the refusal rather than producing a damaged document. */
async function planOrThrow(
    bytes: Uint8Array,
    operation: ProcessorOperation,
    settings: { dpi?: number; contrast?: number } = {},
    confirmed = false,
) {
    const facts = await readSourceFacts(bytes);
    const plan = withConfirmation(planOperation(facts, operation, settings), confirmed);
    if (plan.status !== PLAN_STATUS.READY) {
        throw new ProcessorError(plan.reason, plan.status);
    }
    return plan;
}

export async function processLayer(
    file: File | Uint8Array,
    options: LayerOptions,
): Promise<Uint8Array> {
    const bytes = await toBytes(file);
    await planOrThrow(bytes, 'layer');
    return runLayer(bytes, options);
}

export async function processMonochrome(
    file: File | Uint8Array,
    options: MonoOptions,
): Promise<Uint8Array> {
    const bytes = await toBytes(file);
    await planOrThrow(
        bytes,
        'monochrome',
        { dpi: options.dpi, contrast: options.contrast },
        options.confirmStructureLoss === true,
    );
    return runFlatten(bytes, 'monochrome', { dpi: options.dpi, contrast: options.contrast });
}

export async function processBoth(
    file: File | Uint8Array,
    mono: MonoOptions,
    layer: LayerOptions,
): Promise<Uint8Array> {
    const bytes = await toBytes(file);
    await planOrThrow(
        bytes,
        'both',
        { dpi: mono.dpi, contrast: mono.contrast },
        mono.confirmStructureLoss === true,
    );
    return runBoth(bytes, { dpi: mono.dpi, contrast: mono.contrast }, layer);
}

/**
 * Lossless. Returns the source bytes unchanged when a re-save does not actually
 * make the file smaller — a tool called 最適化 that grows the document is the
 * behaviour this replaces.
 */
export async function processOptimize(
    file: File | Uint8Array,
    _options: OptimizeOptions = {},
): Promise<Uint8Array> {
    void _options;
    const bytes = await toBytes(file);
    await planOrThrow(bytes, 'optimize');
    const { bytes: out } = await runOptimizeLossless(bytes);
    return out;
}

export async function processMargin(
    file: File | Uint8Array,
    options: import('./processor').MarginOptions,
): Promise<Uint8Array> {
    const bytes = await toBytes(file);
    await planOrThrow(bytes, 'margin');
    return runMargin(bytes, options);
}
