/**
 * One planner and one comparison, behind three presentations.
 *
 * The preview, the comparison PDF and the change report used to decide for
 * themselves what a comparison meant — three render scales, two of them capped
 * differently and one not at all, and three different answers to a missing
 * page. They are presentations now: they consume this, and none of them may
 * reach a verdict of its own.
 *
 * Adopted from `research/m4-comparator-reliability/` (PR #21).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    GEOMETRY_TOLERANCE_PT,
    MATCH_RATIO_FLOOR,
    MULTI_MEMBER_CONTRACT,
    PLAN,
    RESULT,
    pixelRadiusFor,
    type PlanStatus,
    type Refusal,
    type ResultStatus,
} from './contract';
import {
    canonicalMapping, compareGeometry, mappingsAreRigid, pageGeometry,
    type CanonicalMapping,
} from './geometry';
import {
    dilateMask, inkMask, pairChangeMaskSteps, runBanded, taskBoundary,
    type ChangeMask,
} from './mask';
import { preflightPages, type PageShape, type Preflight } from './budget';

export interface MemberSource {
    slot: number;
    label: string;
    pdf: PDFDocumentProxy;
    color: [number, number, number];
}

export interface ComparisonSettings {
    /** Requested source pages, 1-based. An export of 3-5 is [3, 4, 5]. */
    pages: number[];
    dpi: number;
    toleranceMm: number;
    memoryBudgetBytes: number;
    matchColor: [number, number, number];
    matchOpacity: number;
}

/** What a run is allowed to keep doing, and whether it may still publish. */
export interface RunSignal {
    isCancelled: () => boolean;
    isOwner: () => boolean;
}

export interface PagePlan {
    page: number;
    status: PlanStatus;
    /** One line per thing the user needs to know, in their language. */
    reported: string[];
    width: number;
    height: number;
    mappings: CanonicalMapping[];
    /** Labels of members that do not have this page. */
    missing: string[];
}

export interface JobPlan {
    status: PlanStatus;
    contract: typeof MULTI_MEMBER_CONTRACT;
    renderScale: number;
    radiusPx: number;
    pages: PagePlan[];
    comparablePages: number;
    preflight: Preflight;
    refusal: Refusal | null;
    requested: ComparisonSettings;
    /** Identical to `requested`: nothing is ever quietly reduced to fit. */
    effective: ComparisonSettings;
}

export interface PairResult {
    page: number;
    slot: number;
    label: string;
    referenceLabel: string;
    /** "p3: A.pdf vs C.pdf" — deterministic, and carried into every artifact. */
    title: string;
    verdict: ResultStatus;
    changePixels: number;
    inkPixels: number;
    width: number;
    height: number;
    /**
     * The painted visual — full-resolution RGBA, and the largest thing a pair
     * produces. Null once it has been handed to a sink and released: an export
     * that kept every page's would be holding the whole job in RAM, which is
     * not what the budget was computed against.
     */
    pixels: Uint8ClampedArray<ArrayBuffer> | null;
    /** The bounding box of what changed, or null when nothing did. */
    bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface PageResult {
    page: number;
    status: PlanStatus;
    reported: string[];
    pairs: PairResult[];
    /** MATCH only when every pair matches. Null when no comparison ran. */
    verdict: ResultStatus | null;
}

export interface JobResult {
    status: PlanStatus;
    pages: PageResult[];
    verdict: ResultStatus | null;
    /** True when the run was cancelled or superseded; nothing may be published. */
    abandoned: boolean;
    plan: JobPlan;
}

/**
 * The picture, painted from the masks alone.
 *
 * A property of the compositor rather than a simplification of it: the old one
 * started each pixel white and multiplied in a *flat* colour wherever ink was
 * found, never reading the source pixel's intensity. So the composite is a
 * function of the masks, the layer colours, the match colour and the match
 * opacity, and of nothing else — which is what lets a member's RGBA be released
 * as soon as its mask exists.
 *
 * Two members only, because that is the rule that is coherent. Painting a
 * reference-pairs result with an any-other-member rule would show a
 * two-against-two disagreement as a clean sheet under a status saying CHANGE.
 */
export function paintPair(
    reference: Uint8Array,
    other: Uint8Array,
    dilatedReference: Uint8Array,
    dilatedOther: Uint8Array,
    referenceColor: [number, number, number],
    otherColor: [number, number, number],
    width: number,
    height: number,
    matchColor: [number, number, number],
    matchOpacity: number,
): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(width * height * 4);
    const masks = [reference, other];
    const dilated = [dilatedReference, dilatedOther];
    const colors = [referenceColor, otherColor];
    for (let p = 0; p < width * height; p += 1) {
        let r = 255;
        let g = 255;
        let b = 255;
        for (let l = 0; l < 2; l += 1) {
            if (!masks[l][p]) continue;
            const isMatch = dilated[1 - l][p] === 1;
            const ink = isMatch ? matchColor : colors[l];
            if (isMatch && matchOpacity < 1) {
                r = r * (1 - matchOpacity) + r * ink[0] * matchOpacity;
                g = g * (1 - matchOpacity) + g * ink[1] * matchOpacity;
                b = b * (1 - matchOpacity) + b * ink[2] * matchOpacity;
            } else {
                r *= ink[0];
                g *= ink[1];
                b *= ink[2];
            }
        }
        const i = p * 4;
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = 255;
    }
    return out;
}

/** Where the change is, from the same masks the verdict used. */
export function changeBounds(
    a: Uint8Array,
    b: Uint8Array,
    dilatedA: Uint8Array,
    dilatedB: Uint8Array,
    width: number,
    height: number,
): { x: number; y: number; width: number; height: number } | null {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const p = y * width + x;
            const unmatched = (a[p] && !dilatedB[p]) || (b[p] && !dilatedA[p]);
            if (!unmatched) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The verdict, from the canonical mask and a floor that is fixed at zero. */
export function verdictFor(mask: ChangeMask): ResultStatus {
    if (mask.inkPixels === 0) return RESULT.MATCH;
    return mask.changePixels / mask.inkPixels <= MATCH_RATIO_FLOOR
        ? RESULT.MATCH : RESULT.CHANGE;
}

/**
 * The same page of every member, rendered upright at the same scale.
 *
 * Exported because a single loaded document is worth showing — that is a
 * preview, not a comparison, and it carries no verdict — and it should be shown
 * in the frame a comparison would use.
 */
export async function renderUprightCanvas(
    pdf: PDFDocumentProxy,
    pageNumber: number,
    scale: number,
): Promise<HTMLCanvasElement> {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas;
}

/**
 * Whether the comparison can be made, page by page, before anything is drawn.
 *
 * A page one document does not have stays in the plan as `MISSING_PAGE` and is
 * named. Deleting it would lose it silently; giving it a verdict would claim a
 * comparison that never happened.
 */
export async function planComparison(
    members: MemberSource[],
    settings: ComparisonSettings,
): Promise<JobPlan> {
    const renderScale = settings.dpi / 72;
    const radiusPx = pixelRadiusFor(settings.toleranceMm, settings.dpi);
    const pages: PagePlan[] = [];

    if (members.length < 2) {
        const empty = preflightPages([], settings.memoryBudgetBytes);
        return {
            status: PLAN.UNSUPPORTED,
            contract: MULTI_MEMBER_CONTRACT,
            renderScale,
            radiusPx,
            pages: [],
            comparablePages: 0,
            preflight: empty,
            refusal: {
                status: PLAN.UNSUPPORTED,
                reason: '比較するには2つ以上のPDFが必要です。',
            },
            requested: settings,
            effective: settings,
        };
    }

    for (const pageNumber of settings.pages) {
        const missing = members
            .filter((m) => pageNumber > m.pdf.numPages)
            .map((m) => m.label);
        if (missing.length > 0) {
            pages.push({
                page: pageNumber,
                status: PLAN.MISSING_PAGE,
                reported: missing.map(
                    (label) => `ページ ${pageNumber} — ${label} に対応ページがありません`,
                ),
                width: 0,
                height: 0,
                mappings: [],
                missing,
            });
            continue;
        }

        const geometries = [];
        for (const m of members) {
            const page = await m.pdf.getPage(pageNumber);
            geometries.push(pageGeometry(page.view, page.rotate));
        }
        const [reference, ...others] = geometries;

        const blocking: string[] = [];
        others.forEach((g, i) => {
            const differences = compareGeometry(reference, g, GEOMETRY_TOLERANCE_PT);
            const refused = differences.differences.filter(
                (d) => d.recoverable !== 'automatic',
            );
            if (refused.length > 0) {
                blocking.push(
                    `ページ ${pageNumber} — ${members[i + 1].label}: `
                    + `${refused.map((d) => d.detail).join(', ')}`
                    + '（用紙が異なるため比較できません）',
                );
            }
        });

        const mappings = others.map(
            (g) => canonicalMapping(reference, g, GEOMETRY_TOLERANCE_PT),
        );
        if (blocking.length > 0 || !mappingsAreRigid(mappings)) {
            pages.push({
                page: pageNumber,
                status: PLAN.GEOMETRY_MISMATCH,
                reported: blocking.length > 0 ? blocking : [
                    `ページ ${pageNumber} — 剛体変換で重ねられないため比較できません`,
                ],
                width: 0,
                height: 0,
                mappings: [],
                missing: [],
            });
            continue;
        }

        pages.push({
            page: pageNumber,
            status: PLAN.READY_TO_COMPARE,
            reported: [],
            width: Math.ceil(reference.physical.width * renderScale),
            height: Math.ceil(reference.physical.height * renderScale),
            mappings,
            missing: [],
        });
    }

    const shapes: PageShape[] = pages
        .filter((p) => p.status === PLAN.READY_TO_COMPARE)
        .map((p) => ({
            width: p.width, height: p.height, members: members.length, radiusPx,
        }));
    const budget = preflightPages(shapes, settings.memoryBudgetBytes);

    const comparablePages = shapes.length;
    let status: PlanStatus = PLAN.READY_TO_COMPARE;
    if (budget.refusal) {
        status = budget.refusal.status;
    } else if (comparablePages === 0) {
        status = pages.length > 0 ? pages[0].status : PLAN.UNSUPPORTED;
    }

    return {
        status,
        contract: MULTI_MEMBER_CONTRACT,
        renderScale,
        radiusPx,
        pages,
        comparablePages,
        preflight: budget,
        refusal: budget.refusal,
        requested: settings,
        effective: settings,
    };
}

/**
 * Run the plan, and stop the moment it is told to.
 *
 * Members are rendered serially and each member's RGBA is released as soon as
 * its mask exists. Pairs are compared serially against slot 1, with the
 * reference's mask and dilation computed once and reused — the buffer lifetime
 * the memory model was built on.
 */
export interface RunOptions {
    onProgress?: (done: number, total: number) => void;
    /**
     * Consume each pair as it is produced.
     *
     * When given, the pair's RGBA is released as soon as this returns, so an
     * export holds one visual at a time rather than the whole job. Semantic
     * metadata — the verdict, the counts, the bounds — is small and is kept.
     */
    onPair?: (pair: PairResult) => void | Promise<void>;
    /**
     * Consume each page as it is finished, in source-page order, after that
     * page's pairs and including the pages that produced none.
     *
     * A page nobody could compare has to reach the artifact in its own place.
     * Collecting those and appending them at the end would put page 2's notice
     * after page 5's comparison, and a reader has no way to tell that ordering
     * from a missing page they were never told about.
     */
    onPage?: (page: PageResult) => void | Promise<void>;
}

export async function runComparison(
    plan: JobPlan,
    members: MemberSource[],
    signal: RunSignal,
    options: RunOptions = {},
): Promise<JobResult> {
    const { onProgress, onPair, onPage } = options;
    const results: PageResult[] = [];
    const comparable = plan.pages.filter((p) => p.status === PLAN.READY_TO_COMPARE);
    let done = 0;

    if (plan.refusal) {
        return {
            status: plan.status,
            pages: plan.pages.map((p) => ({
                page: p.page, status: p.status, reported: p.reported, pairs: [],
                verdict: null,
            })),
            verdict: null,
            abandoned: false,
            plan,
        };
    }

    const abandon = (): JobResult => ({
        status: PLAN.CANCELLED, pages: results, verdict: null, abandoned: true, plan,
    });

    for (const pagePlan of plan.pages) {
        if (pagePlan.status !== PLAN.READY_TO_COMPARE) {
            const unreadable: PageResult = {
                page: pagePlan.page,
                status: pagePlan.status,
                reported: pagePlan.reported,
                pairs: [],
                verdict: null,
            };
            results.push(unreadable);
            if (onPage) {
                await onPage(unreadable);
                await taskBoundary();
                if (signal.isCancelled() || !signal.isOwner()) return abandon();
            }
            continue;
        }

        let referenceMask: Uint8Array;
        let width = 0;
        let height = 0;
        try {
            const canvas = await renderUprightCanvas(
                members[0].pdf, pagePlan.page, plan.renderScale,
            );
            width = canvas.width;
            height = canvas.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            referenceMask = inkMask(
                ctx.getImageData(0, 0, width, height).data, width, height,
            );
            canvas.width = 1;
            canvas.height = 1;
        } catch {
            // A member that cannot be read fails the whole operation. Comparing
            // the survivors produces the most alarming possible wrong answer:
            // with one layer left nothing matches, and the entire sheet is
            // painted as revised.
            return {
                status: PLAN.RENDER_FAILED,
                pages: results.concat({
                    page: pagePlan.page,
                    status: PLAN.RENDER_FAILED,
                    reported: [
                        `ページ ${pagePlan.page} — ${members[0].label} を描画できませんでした`,
                    ],
                    pairs: [],
                    verdict: null,
                }),
                verdict: null,
                abandoned: false,
                plan,
            };
        }

        const dilatedReference = dilateMask(
            referenceMask, width, height, plan.radiusPx,
        );
        const pairs: PairResult[] = [];

        for (let i = 1; i < members.length; i += 1) {
            let otherMask: Uint8Array;
            try {
                const canvas = await renderUprightCanvas(
                    members[i].pdf, pagePlan.page, plan.renderScale,
                );
                const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
                otherMask = inkMask(
                    ctx.getImageData(0, 0, canvas.width, canvas.height).data,
                    width, height,
                );
                canvas.width = 1;
                canvas.height = 1;
            } catch {
                return {
                    status: PLAN.RENDER_FAILED,
                    pages: results.concat({
                        page: pagePlan.page,
                        status: PLAN.RENDER_FAILED,
                        reported: [
                            `ページ ${pagePlan.page} — ${members[i].label} を描画できませんでした`,
                        ],
                        pairs: [],
                        verdict: null,
                    }),
                    verdict: null,
                    abandoned: false,
                    plan,
                };
            }

            const run = await runBanded(
                pairChangeMaskSteps(
                    referenceMask, otherMask, width, height, plan.radiusPx,
                ),
                { shouldContinue: () => !signal.isCancelled(), isOwner: signal.isOwner },
            );
            if (run.cancelled || run.result === null) {
                return {
                    status: PLAN.CANCELLED,
                    pages: results,
                    verdict: null,
                    abandoned: true,
                    plan,
                };
            }

            const dilatedOther = dilateMask(otherMask, width, height, plan.radiusPx);
            const pair: PairResult = {
                page: pagePlan.page,
                slot: members[i].slot,
                label: members[i].label,
                referenceLabel: members[0].label,
                title: `p${pagePlan.page}: ${members[0].label} vs ${members[i].label}`,
                verdict: verdictFor(run.result),
                changePixels: run.result.changePixels,
                inkPixels: run.result.inkPixels,
                width,
                height,
                pixels: paintPair(
                    referenceMask, otherMask, dilatedReference, dilatedOther,
                    members[0].color, members[i].color, width, height,
                    plan.requested.matchColor, plan.requested.matchOpacity,
                ),
                bounds: changeBounds(
                    referenceMask, otherMask, dilatedReference, dilatedOther,
                    width, height,
                ),
            };

            // Painting, bounds and encoding are the expensive stretch after the
            // banded kernel, and a run that cannot be stopped here can still
            // publish something the user has already replaced. So the boundary
            // is per pair, not per comparison.
            await taskBoundary();
            if (signal.isCancelled() || !signal.isOwner()) {
                return {
                    status: PLAN.CANCELLED,
                    pages: results,
                    verdict: null,
                    abandoned: true,
                    plan,
                };
            }

            if (onPair) {
                await onPair(pair);
                // Handed over and no longer needed. What accumulates from here
                // is the artifact, which the output budget accounts for.
                pair.pixels = null;
                await taskBoundary();
                if (signal.isCancelled() || !signal.isOwner()) {
                    return {
                        status: PLAN.CANCELLED,
                        pages: results,
                        verdict: null,
                        abandoned: true,
                        plan,
                    };
                }
            }
            pairs.push(pair);
        }

        const compared: PageResult = {
            page: pagePlan.page,
            status: PLAN.READY_TO_COMPARE,
            reported: [],
            pairs,
            verdict: pairs.every((p) => p.verdict === RESULT.MATCH)
                ? RESULT.MATCH : RESULT.CHANGE,
        };
        results.push(compared);
        if (onPage) {
            await onPage(compared);
            await taskBoundary();
            if (signal.isCancelled() || !signal.isOwner()) return abandon();
        }
        done += 1;
        onProgress?.(done, comparable.length);
    }

    // Ownership again, immediately before anything is handed back to be shown
    // or saved: a run can be superseded by the last thing that happened while
    // its final page was being compared.
    if (!signal.isOwner()) {
        return {
            status: PLAN.CANCELLED, pages: [], verdict: null, abandoned: true, plan,
        };
    }

    const judged = results.filter((p) => p.verdict !== null);
    return {
        status: plan.status,
        pages: results,
        verdict: judged.length === 0
            ? null
            : (judged.every((p) => p.verdict === RESULT.MATCH)
                ? RESULT.MATCH : RESULT.CHANGE),
        abandoned: false,
        plan,
    };
}
