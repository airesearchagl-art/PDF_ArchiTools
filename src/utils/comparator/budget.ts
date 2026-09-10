/**
 * What a comparison costs, decided before anything is allocated.
 *
 * Three ceilings, and passing one says nothing about the others: the working
 * set the browser has to find, the comparison work the kernel has to do, and
 * the finished output the operation has to hold. Every term is arithmetic on
 * the page size, the member count, the tolerance and the page count, so all
 * three are answerable before the first canvas exists.
 *
 * Adopted from `research/m4-comparator-reliability/prototype/candidates.mjs`.
 */
import {
    COMPARISON_ALGORITHM,
    MAX_COMPARISON_WORK_UNITS,
    MAX_OUTPUT_BYTES,
    PLAN,
    type Refusal,
} from './contract';
import { pngStoredSize, encoderScratchBytes } from './png';

export interface PageSize {
    width: number;
    height: number;
}

export interface JobShape extends PageSize {
    /** Source pages actually requested. An export of pages 3-5 is three. */
    pages: number;
    /** Members present on those pages. Slot 1 is the reference. */
    members: number;
    radiusPx: number;
}

/** Slot 1 against each other member, independently. */
export function pairsPerPage(members: number): number {
    return Math.max(1, members - 1);
}

// ---------------------------------------------------------------------------
// The working set
// ---------------------------------------------------------------------------

export interface PhaseMemory {
    phases: Record<string, number>;
    peakPhase: string;
    peakWorkingSet: number;
    bytesPerPixel: number;
}

/**
 * The working set, phase by phase, for the pipeline that is actually built.
 *
 * The old model counted layer canvases, normalised copies, a normalising
 * canvas, a composite and an encoder, because that is what the old pipeline
 * held. This one holds masks. The load-bearing fact is the presentation phase:
 * the composite is a function of the ink masks and the layer colours and
 * nothing else, so no member's RGBA survives the phase that extracted its mask,
 * and four bytes per pixel per member stop being co-resident with anything.
 *
 * Members are rendered serially and pairs are processed serially, with the
 * reference's mask and dilation computed once and reused. Both are part of the
 * contract: a parallel implementation has a different peak.
 */
export function estimatePhaseMemory(job: {
    width: number;
    height: number;
    members: number;
    radiusPx: number;
}): PhaseMemory {
    const pixels = job.width * job.height;
    const rgba = pixels * 4;
    const mask = pixels;
    const dilating = job.radiusPx > 0;
    const dilationIndex = dilating ? (job.width + 1) * 4 + (job.height + 1) * 4 : 0;
    const encodedOutput = pngStoredSize(job.width, job.height);

    const phases: Record<string, number> = {
        // One member's canvas, the pixels read back from it, and the masks of
        // the members already done.
        render: rgba + rgba + mask * Math.max(0, job.members - 1),
        // The canvas is released; the readback is live while it is read.
        'mask-extraction': rgba + mask * job.members,
        // The reference's dilation is computed once and reused, so only the
        // other member's dilation and one scratch band are transient.
        dilation: mask * job.members
            + (dilating ? mask * 3 : 0) + dilationIndex,
        comparison: mask * job.members + (dilating ? mask * 2 : 0) + mask,
        // Pairs are painted one at a time, so two dilations rather than one per
        // member.
        presentation: mask * job.members + (dilating ? mask * 2 : 0)
            + rgba + encoderScratchBytes(job.width) + encodedOutput,
    };

    let peakPhase = 'render';
    let peakWorkingSet = 0;
    for (const [name, total] of Object.entries(phases)) {
        if (total > peakWorkingSet) {
            peakWorkingSet = total;
            peakPhase = name;
        }
    }
    return {
        phases,
        peakPhase,
        peakWorkingSet,
        bytesPerPixel: peakWorkingSet / pixels,
    };
}

// ---------------------------------------------------------------------------
// The finished output
// ---------------------------------------------------------------------------

export interface OutputEstimate {
    pairsPerPage: number;
    visuals: number;
    perVisualBytes: number;
    totalEncodedBytes: number;
    /** What one finished page costs to keep while the next one is compared. */
    retainedPerCompletedPage: number;
}

export function estimateOutput(job: JobShape): OutputEstimate {
    const pairs = pairsPerPage(job.members);
    const perVisualBytes = pngStoredSize(job.width, job.height);
    const visuals = job.pages * pairs;
    return {
        pairsPerPage: pairs,
        visuals,
        perVisualBytes,
        totalEncodedBytes: visuals * perVisualBytes,
        retainedPerCompletedPage: perVisualBytes * pairs,
    };
}

// ---------------------------------------------------------------------------
// The comparison work
// ---------------------------------------------------------------------------

/**
 * Integer arithmetic that refuses to lie.
 *
 * A work estimate that silently loses precision would pass a job whose real
 * size is unrepresentable. Anything that leaves the safe-integer range comes
 * back as `null`, and `null` is a refusal.
 */
function safeProduct(...factors: number[]): number | null {
    let acc = 1;
    for (const f of factors) {
        if (!Number.isInteger(f) || f < 0) return null;
        acc *= f;
        if (!Number.isSafeInteger(acc)) return null;
    }
    return acc;
}

export interface WorkEstimate {
    algorithm: typeof COMPARISON_ALGORITHM;
    perPageUnits: number | null;
    jobUnits: number | null;
    representable: boolean;
}

/**
 * What the whole operation would cost, in pixel reads.
 *
 * Under the selected separable dilation the radius leaves the cost entirely —
 * two passes over the pixels regardless of how wide the box is — so a page is
 * `pixels x sourceMembers x 4` per compared pair, at any tolerance.
 *
 * Summed over every requested page and every required pair, because memory is a
 * peak and work is cumulative: the export and the change report both run over
 * ranges, and a hundred pages that each pass are a hundred times the work.
 */
export function estimateWork(job: JobShape): WorkEstimate {
    const pixels = safeProduct(Math.round(job.width), Math.round(job.height));
    if (pixels === null) {
        return {
            algorithm: COMPARISON_ALGORITHM,
            perPageUnits: null,
            jobUnits: null,
            representable: false,
        };
    }
    const perPair = safeProduct(pixels, 2, 4);
    const perPage = perPair === null
        ? null : safeProduct(perPair, pairsPerPage(job.members));
    const jobUnits = perPage === null ? null : safeProduct(perPage, job.pages);
    return {
        algorithm: COMPARISON_ALGORITHM,
        perPageUnits: perPage,
        jobUnits,
        representable: jobUnits !== null,
    };
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

export interface Preflight {
    memory: PhaseMemory;
    output: OutputEstimate;
    work: WorkEstimate;
    /** Finished output of earlier pages is live while the next is compared. */
    duringLastPage: number;
    /** Everything held while the artifact is assembled. */
    atPublish: number;
    jobPeak: number;
    peakPhase: string;
    memoryLimit: number;
    withinBudget: boolean;
    refusal: Refusal | null;
}

/** One requested page, which need not be the same size as the next. */
export interface PageShape extends PageSize {
    members: number;
    radiusPx: number;
}

/**
 * The same three ceilings over a job whose pages differ in size.
 *
 * Memory is a peak and pages are serial, so the largest page decides it. Work
 * and output are cumulative and are summed page by page rather than multiplied
 * by a representative page, because a document is not obliged to be uniform.
 */
export function preflightPages(pages: PageShape[], memoryLimit: number): Preflight {
    if (pages.length === 0) {
        const empty = estimatePhaseMemory({ width: 1, height: 1, members: 2, radiusPx: 0 });
        return {
            memory: empty,
            output: {
                pairsPerPage: 1, visuals: 0, perVisualBytes: 0,
                totalEncodedBytes: 0, retainedPerCompletedPage: 0,
            },
            work: {
                algorithm: COMPARISON_ALGORITHM, perPageUnits: 0, jobUnits: 0,
                representable: true,
            },
            duringLastPage: 0,
            atPublish: 0,
            jobPeak: 0,
            peakPhase: 'render',
            memoryLimit,
            withinBudget: true,
            refusal: null,
        };
    }

    let memory = estimatePhaseMemory(pages[0]);
    let visuals = 0;
    let totalEncodedBytes = 0;
    let jobUnits: number | null = 0;
    let perPageUnits = 0;
    let perVisualBytes = 0;
    let pairs = pairsPerPage(pages[0].members);

    for (const shape of pages) {
        const pageMemory = estimatePhaseMemory(shape);
        if (pageMemory.peakWorkingSet > memory.peakWorkingSet) memory = pageMemory;
        const pageOutput = estimateOutput({ ...shape, pages: 1 });
        visuals += pageOutput.visuals;
        totalEncodedBytes += pageOutput.totalEncodedBytes;
        perVisualBytes = Math.max(perVisualBytes, pageOutput.perVisualBytes);
        pairs = Math.max(pairs, pageOutput.pairsPerPage);
        const pageWork = estimateWork({ ...shape, pages: 1 });
        perPageUnits = Math.max(perPageUnits, pageWork.perPageUnits ?? 0);
        if (jobUnits === null || pageWork.jobUnits === null) {
            jobUnits = null;
        } else {
            jobUnits += pageWork.jobUnits;
            if (!Number.isSafeInteger(jobUnits)) jobUnits = null;
        }
    }

    const output: OutputEstimate = {
        pairsPerPage: pairs,
        visuals,
        perVisualBytes,
        totalEncodedBytes,
        retainedPerCompletedPage: perVisualBytes * pairs,
    };
    const work: WorkEstimate = {
        algorithm: COMPARISON_ALGORITHM,
        perPageUnits,
        jobUnits,
        representable: jobUnits !== null,
    };
    // Conservative by one page's output: the page being compared has its own
    // visual counted both in its phase peak and in the retained total.
    const duringLastPage = memory.peakWorkingSet + totalEncodedBytes;
    const atPublish = totalEncodedBytes * 2;
    const jobPeak = Math.max(duringLastPage, atPublish);
    const peakPhase = atPublish >= duringLastPage ? 'publish' : memory.peakPhase;

    return refuseOrAccept({
        memory, output, work, duringLastPage, atPublish, jobPeak, peakPhase, memoryLimit,
    }, pages.length);
}

/** Bytes as a human number, for a refusal a person has to act on. */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/**
 * Every ceiling, checked before the first canvas.
 *
 * Refusals are typed and name their numbers. Nothing here reduces a DPI, a
 * tolerance, a page range or a member count to make a job fit — that is the
 * silent downgrade the export path used to perform, where an A0 asked for at
 * 600 dpi delivered 227 and was still named `_600dpi.pdf`. Where an achievable
 * alternative is computable it is *offered*, and the user chooses it or not.
 */
function refuseOrAccept(
    base: Omit<Preflight, 'withinBudget' | 'refusal'>,
    pageCount: number,
): Preflight {
    const { output, work, jobPeak, peakPhase, memoryLimit } = base;

    if (!work.representable) {
        return {
            ...base,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_WORK_BUDGET,
                reason: 'この比較の作業量は計算可能な範囲を超えています。',
            },
        };
    }
    // Order matters, and it is the order of how fundamental the violation is:
    // too much comparison, then too much memory to hold it, then too much
    // finished output to keep. Each names the constraint the user can act on
    // first, and each stays reachable — an order that put output first would
    // make the other two unreachable, which is a ceiling that never speaks.
    if ((work.jobUnits ?? 0) > MAX_COMPARISON_WORK_UNITS) {
        return {
            ...base,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_WORK_BUDGET,
                reason: `比較作業量が上限を超えます（`
                    + `${(work.jobUnits ?? 0).toLocaleString('en-US')} / 上限 `
                    + `${MAX_COMPARISON_WORK_UNITS.toLocaleString('en-US')}）。`,
                requested: `${pageCount} ページ`,
                achievable: work.perPageUnits
                    ? `${Math.max(1, Math.floor(
                        MAX_COMPARISON_WORK_UNITS / work.perPageUnits,
                    ))} ページまで`
                    : undefined,
            },
        };
    }
    if (jobPeak > memoryLimit) {
        return {
            ...base,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_MEMORY_BUDGET,
                reason: `必要推定メモリ ${formatBytes(jobPeak)} が上限 `
                    + `${formatBytes(memoryLimit)} を超えます（${peakPhase}）。`,
                requested: formatBytes(jobPeak),
                achievable: 'メモリ上限を変更するか、解像度・ページ範囲を選び直してください。',
            },
        };
    }
    if (output.totalEncodedBytes > MAX_OUTPUT_BYTES) {
        return {
            ...base,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_OUTPUT_BUDGET,
                reason: `出力が上限を超えます（${output.visuals} 枚 / `
                    + `${formatBytes(output.totalEncodedBytes)}）。`,
                requested: `${pageCount} ページ × ${output.pairsPerPage} 組`,
                achievable: `${Math.max(1, Math.floor(
                    MAX_OUTPUT_BYTES / (output.perVisualBytes * output.pairsPerPage),
                ))} ページまで`,
            },
        };
    }
    return { ...base, withinBudget: true, refusal: null };
}
