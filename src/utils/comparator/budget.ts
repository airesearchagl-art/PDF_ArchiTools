/**
 * What a comparison costs, decided before anything is allocated.
 *
 * Three ceilings, and passing one says nothing about the others: the working
 * set the browser has to find, the comparison work the kernel has to do, and
 * the finished output the operation has to hold. Every term is arithmetic on
 * the page sizes, the member count, the tolerance and the artifact being built,
 * so all three are answerable before the first canvas exists.
 *
 * The artifact matters as much as the comparison. A comparison PDF is a jsPDF
 * document that holds every image until it is saved, and writes a notice image
 * for every page nobody could compare; the preview holds its visuals as pixels.
 * So a plan is priced item by item against the artifact that will actually be
 * built — including the items that are not comparisons at all.
 *
 * Adopted from `research/m4-comparator-reliability/prototype/candidates.mjs`,
 * and bound to the production container, jsPDF 3.0.4.
 */
import {
    ARTIFACT,
    ARTIFACT_ITEM,
    COMPARISON_ALGORITHM,
    MAX_COMPARISON_WORK_UNITS,
    MAX_OUTPUT_BYTES,
    NOTICE_RASTER,
    PLAN,
    type ArtifactItemKind,
    type ArtifactKind,
    type PlanStatus,
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
// The comparison kernel's working set
// ---------------------------------------------------------------------------

export interface PhaseMemory {
    phases: Record<string, number>;
    peakPhase: string;
    peakWorkingSet: number;
    bytesPerPixel: number;
}

/**
 * The kernel's working set, phase by phase, for the pipeline that is built.
 *
 * The load-bearing fact is the paint phase: the composite is a function of the
 * ink masks and the layer colours and nothing else, so no member's RGBA
 * survives the phase that extracted its mask. Members are rendered serially
 * into one canonical frame and pairs are processed serially, with the
 * reference's mask and dilation computed once and reused. Both are part of the
 * contract: a parallel implementation has a different peak.
 *
 * What happens to the composite afterwards belongs to the artifact, and is
 * priced there — see `itemCost`.
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

    const phases: Record<string, number> = {
        // One member's frame canvas, the pixels read back from it, and the
        // masks of the members already done.
        render: rgba + rgba + mask * Math.max(0, job.members - 1),
        // The canvas is released; the readback is live while it is read.
        'mask-extraction': rgba + mask * job.members,
        // The reference's dilation is computed once and reused, so only the
        // other member's dilation and one scratch band are transient.
        dilation: mask * job.members
            + (dilating ? mask * 3 : 0) + dilationIndex,
        comparison: mask * job.members + (dilating ? mask * 2 : 0) + mask,
        // One pair's composite, painted from the masks.
        paint: engineLiveDuringSink(job) + rgba,
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

/**
 * What the engine still holds while a sink is handling one of its pairs: the
 * members' masks, and the two dilations when there are any.
 */
export function engineLiveDuringSink(job: {
    width: number;
    height: number;
    members: number;
    radiusPx: number;
}): number {
    const mask = job.width * job.height;
    return mask * job.members + (job.radiusPx > 0 ? mask * 2 : 0);
}

// ---------------------------------------------------------------------------
// The production container: jsPDF 3.0.4
// ---------------------------------------------------------------------------

/**
 * The container the files are built in, as its source says it behaves.
 *
 * The browser resolves `jspdf` to `dist/jspdf.es.min.js`; the line numbers
 * below are the same code in `dist/jspdf.es.js`. The app constructs jsPDF
 * without `compress`, so `addImage` takes the uncompressed branch
 * (jspdf.es.js:9293-9296, 8900-8902, 14677-14681) and nothing is deflated.
 *
 * For each `addImage(png, 'PNG', …)` of an RGBA8 PNG, in order:
 *
 *   - fast-png decodes it (jspdf.es.js:14640). The input is read through views,
 *     not copied (iobuffer IOBuffer.js:68-86, fast-png PngDecoder.js:240).
 *   - pako inflates the IDAT stream into a list of 64 KiB chunks, then
 *     flattens them into one exact buffer (pako.esm.mjs:6638-6639, 6731,
 *     6750, 3489). Both are live while it flattens.
 *   - fast-png unfilters into a new RGBA buffer (decodeInterlaceNull.js:10).
 *   - jsPDF splits it into a colour buffer and an alpha buffer
 *     (jspdf.es.js:14948-14949), and turns the colour buffer into a binary
 *     string in 8192-character pieces (jspdf.es.js:9216-9227, 14683-14685).
 *   - An SMask is written only when some pixel is not opaque
 *     (jspdf.es.js:14963-14965, 14681). Every raster this module hands jsPDF
 *     is opaque, and the sink asserts it, so there is no SMask string.
 *   - The colour string is kept for the life of the document
 *     (jspdf.es.js:9009, 14689-14704). The PNG, the decoded RGBA and the
 *     colour and alpha buffers are not.
 *
 * And at `save()` (jspdf.es.js:5761): every retained image string, the
 * `content` array, `content.join("\n")` (3356), an ArrayBuffer of the same
 * length filled from it (1511-1518), and a Blob of that (3358-3361).
 */
export const JSPDF_CONTAINER = {
    version: '3.0.4',
    /** pako `Inflate` output chunk (pako.esm.mjs:6523, 6638-6639). */
    inflateChunkBytes: 64 * 1024,
    /** pako's sliding window (32 KiB, pako.esm.mjs:5140) and tables, rounded up. */
    inflateStateBytes: 64 * 1024,
    /** `arrayBufferToBinaryString` batch (jspdf.es.js:8668, 9225). */
    stringPieceChars: 8192,
    /**
     * Per piece of a string built by `+=`: a rope node and a string header.
     * A bound, not a measurement of V8's layout.
     */
    stringPieceOverheadBytes: 64,
    /**
     * Every character jsPDF writes is 0-255 — image bytes, and text after
     * `to8bitStream` (jspdf.es.js:2951-3074) — so V8 stores one byte each.
     * An inference about V8; the gate measures that no character exceeds 255.
     */
    bytesPerStringChar: 1,
    /** Per item: image dictionary, page object, content stream, xref lines. A bound. */
    perItemFileOverheadBytes: 4096,
    /** Header, catalog, info, trailer. A bound. */
    documentOverheadBytes: 16 * 1024,
    /** Objects jsPDF keeps per page and image beyond the image string. A bound. */
    perItemStateBytes: 16 * 1024,
} as const;

/** The bytes a jsPDF binary string of `chars` characters holds. */
export function binaryStringBytes(chars: number): number {
    const c = JSPDF_CONTAINER;
    return chars * c.bytesPerStringChar
        + Math.ceil(chars / c.stringPieceChars) * c.stringPieceOverheadBytes;
}

export interface IngestTerms {
    /** PNG raster with its filter bytes, as pako hands it back. */
    inflated: number;
    /** pako's chunk list, in whole chunks. */
    inflateChunks: number;
    inflateState: number;
    /** fast-png's unfiltered RGBA. */
    decoded: number;
    colorBytes: number;
    alphaBytes: number;
    colorString: number;
    /** Zero: every image handed to jsPDF here is opaque. */
    sMaskString: number;
    steps: Record<string, number>;
    peak: number;
    peakStep: string;
}

/** What jsPDF allocates while one `addImage` of a `width x height` RGBA PNG runs. */
export function jsPdfIngest(width: number, height: number): IngestTerms {
    const c = JSPDF_CONTAINER;
    const inflated = height * (1 + width * 4);
    const inflateChunks = Math.ceil(inflated / c.inflateChunkBytes) * c.inflateChunkBytes;
    const decoded = width * height * 4;
    const colorBytes = width * height * 3;
    const alphaBytes = width * height;
    const colorString = binaryStringBytes(width * height * 3);
    const steps: Record<string, number> = {
        inflate: inflateChunks + inflated + c.inflateStateBytes,
        unfilter: inflated + decoded,
        split: decoded + colorBytes + alphaBytes,
        stringify: decoded + colorBytes + alphaBytes + colorString,
    };
    const [peakStep, peak] = maxEntry(steps);
    return {
        inflated, inflateChunks, inflateState: c.inflateStateBytes,
        decoded, colorBytes, alphaBytes, colorString, sMaskString: 0,
        steps, peak, peakStep,
    };
}

/** What jsPDF keeps, after `addImage` returns, until the document is gone. */
export function jsPdfRetained(width: number, height: number): number {
    return binaryStringBytes(width * height * 3) + JSPDF_CONTAINER.perItemStateBytes;
}

/** What one image adds to the saved file: its colour stream and its objects. */
export function jsPdfFileBytes(width: number, height: number): number {
    return width * height * 3 + JSPDF_CONTAINER.perItemFileOverheadBytes;
}

/**
 * Where each term comes from, so a reader can tell a bound from a fact.
 *
 * `exact` is arithmetic that matches the code byte for byte; `conservative` is
 * an upper bound on something that cannot be pinned down exactly; `inferred`
 * rests on reading the pinned jsPDF (or its dependencies, or V8) rather than on
 * this module's own code. Which of them the gates also measure is listed in
 * the gate, not here: a term is not measured because someone wrote so.
 */
export const MEMORY_TERMS: readonly {
    term: string;
    basis: 'exact' | 'conservative' | 'inferred';
    source: string;
}[] = [
    { term: 'kernel phases (canvas, readback, masks, dilations, composite)', basis: 'exact', source: 'estimatePhaseMemory; engine.ts' },
    { term: 'owned PNG', basis: 'exact', source: 'pngStoredSize; encodePngStored asserts it' },
    { term: 'encoder scratch', basis: 'conservative', source: 'encoderScratchBytes; the encoder writes in place' },
    { term: 'notice canvas and readback', basis: 'exact', source: 'NOTICE_RASTER x 4' },
    { term: 'Change Report crop', basis: 'conservative', source: 'priced as the whole sheet; a crop is never larger' },
    { term: 'pako chunk list + flattened raster', basis: 'inferred', source: 'pako.esm.mjs:6638-6639, 6750, 3489' },
    { term: 'fast-png unfiltered RGBA', basis: 'inferred', source: 'decodeInterlaceNull.js:10' },
    { term: 'jsPDF colour + alpha buffers', basis: 'inferred', source: 'jspdf.es.js:14948-14949' },
    { term: 'jsPDF colour string (retained)', basis: 'inferred', source: 'jspdf.es.js:9216-9227, 9009' },
    { term: 'string rope overhead', basis: 'conservative', source: 'JSPDF_CONTAINER.stringPieceOverheadBytes' },
    { term: 'one byte per string character', basis: 'inferred', source: 'V8 one-byte strings; to8bitStream' },
    { term: 'no SMask string', basis: 'exact', source: 'sink asserts opacity; jspdf.es.js:14963-14965' },
    { term: 'per-item state and file overhead', basis: 'conservative', source: 'JSPDF_CONTAINER' },
    { term: 'rope flatten during join (largest string)', basis: 'conservative', source: 'V8 may flatten a rope it reads' },
    { term: 'joined document, ArrayBuffer', basis: 'inferred', source: 'jspdf.es.js:3356, 1511-1518' },
    { term: 'Blob', basis: 'inferred', source: 'jspdf.es.js:3358-3361; the browser copies it' },
    { term: 'display canvas (preview)', basis: 'exact', source: 'putImageData into one canvas' },
];

// ---------------------------------------------------------------------------
// The artifact, item by item
// ---------------------------------------------------------------------------

export interface ItemCost {
    /** The RGBA the item is made from: a composite, or a notice's readback. */
    rasterBytes: number;
    /** The owned PNG. Exact. */
    encodedBytes: number;
    /** jsPDF's own peak while it ingests the PNG. */
    ingestBytes: number;
    /** What stays behind in the document. */
    retainedBytes: number;
    /** What the saved file receives. */
    fileBytes: number;
    /**
     * What counts against `MAX_OUTPUT_BYTES`: the larger of the owned PNG and
     * the file's share, so the ceiling bounds both.
     */
    outputBytes: number;
    /** The item's own sequence, each step being what is live at once. */
    steps: Record<string, number>;
    peakBytes: number;
    peakStep: string;
}

/**
 * One item, priced against the artifact it goes into.
 *
 * The sequence is the one the sinks in `artifacts.ts` follow, and each release
 * named here is one they perform: a composite is let go once it is encoded (or
 * cropped), a notice's canvas once it is read back, the readback once it is
 * encoded. What jsPDF does with the PNG is `jsPdfIngest`.
 */
export function itemCost(
    artifact: ArtifactKind,
    item: ArtifactItemKind,
    width: number,
    height: number,
): ItemCost {
    const raster = width * height * 4;
    if (artifact === ARTIFACT.PREVIEW) {
        // Kept whole, as pixels, for the screen. Nothing is encoded.
        return {
            rasterBytes: raster, encodedBytes: 0, ingestBytes: 0,
            retainedBytes: raster, fileBytes: 0, outputBytes: raster,
            steps: { hold: raster }, peakBytes: raster, peakStep: 'hold',
        };
    }
    const encoded = pngStoredSize(width, height);
    const scratch = encoderScratchBytes(width);
    const ingest = jsPdfIngest(width, height);
    const steps: Record<string, number> = {};
    if (item === ARTIFACT_ITEM.PAIR_VISUAL && artifact === ARTIFACT.COMPARISON_PDF) {
        steps.encode = raster + encoded + scratch;
        steps.ingest = encoded + ingest.peak;
    } else if (item === ARTIFACT_ITEM.PAIR_VISUAL) {
        // Priced as a crop of the whole sheet, which no crop exceeds.
        steps.crop = raster + raster;
        steps.encode = raster + encoded + scratch;
        steps.ingest = encoded + ingest.peak;
    } else {
        steps.draw = raster;
        steps.readback = raster + raster;
        steps.encode = raster + encoded + scratch;
        steps.ingest = encoded + ingest.peak;
    }
    const [peakStep, peakBytes] = maxEntry(steps);
    const fileBytes = jsPdfFileBytes(width, height);
    return {
        rasterBytes: raster,
        encodedBytes: encoded,
        ingestBytes: ingest.peak,
        retainedBytes: jsPdfRetained(width, height),
        fileBytes,
        outputBytes: Math.max(encoded, fileBytes),
        steps,
        peakBytes,
        peakStep,
    };
}

export interface ArtifactItem {
    kind: ArtifactItemKind;
    page: number;
    /** The member compared against the reference; null for a notice. */
    slot: number | null;
    /**
     * `if-change` is a Change Report pair: written only when it is a CHANGE,
     * and priced as though it will be, because that is not known in advance.
     */
    emitted: 'always' | 'if-change';
    width: number;
    height: number;
    /** What the engine holds while the sink handles this item. */
    engineLiveBytes: number;
    cost: ItemCost;
}

export interface ArtifactPlan {
    kind: ArtifactKind;
    /** The notice raster this artifact draws, or null for the preview. */
    notice: { width: number; height: number } | null;
    /** In the order they will be written: source page, then slot. */
    items: ArtifactItem[];
}

/** One requested page as the planner decided it. */
export interface PageSlot {
    page: number;
    status: PlanStatus;
    width: number;
    height: number;
}

/**
 * Every item the artifact will contain, in the order it will contain them.
 *
 * A page that could be compared contributes one visual per pair. A page that
 * could not contributes its notice, in its own place — the preview shows that
 * as text, the files as an image the size of `NOTICE_RASTER`. There is no
 * third kind, and nothing is dropped to make a plan fit.
 */
export function planArtifact(
    kind: ArtifactKind,
    pages: readonly PageSlot[],
    memberSlots: readonly number[],
    radiusPx: number,
): ArtifactPlan {
    const notice = kind === ARTIFACT.PREVIEW ? null : NOTICE_RASTER[kind];
    const items: ArtifactItem[] = [];
    for (const page of pages) {
        if (page.status === PLAN.READY_TO_COMPARE) {
            const live = engineLiveDuringSink({
                width: page.width, height: page.height,
                members: memberSlots.length, radiusPx,
            });
            for (const slot of memberSlots.slice(1)) {
                items.push({
                    kind: ARTIFACT_ITEM.PAIR_VISUAL,
                    page: page.page,
                    slot,
                    emitted: kind === ARTIFACT.CHANGE_REPORT ? 'if-change' : 'always',
                    width: page.width,
                    height: page.height,
                    engineLiveBytes: live,
                    cost: itemCost(kind, ARTIFACT_ITEM.PAIR_VISUAL, page.width, page.height),
                });
            }
            continue;
        }
        if (!notice) continue;
        const noticeKind = page.status === PLAN.MISSING_PAGE
            ? ARTIFACT_ITEM.MISSING_PAGE_NOTICE
            : ARTIFACT_ITEM.GEOMETRY_MISMATCH_NOTICE;
        items.push({
            kind: noticeKind,
            page: page.page,
            slot: null,
            emitted: 'always',
            width: notice.width,
            height: notice.height,
            engineLiveBytes: 0,
            cost: itemCost(kind, noticeKind, notice.width, notice.height),
        });
    }
    return { kind, notice, items };
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

export interface MemoryModel {
    /** The largest compared page's kernel phases. */
    kernel: PhaseMemory;
    /** The worst item while its sink runs, with the engine's masks still live. */
    sinkPeak: number;
    sinkPeakItem: number | null;
    /** Everything the artifact keeps, counted as live from the start. */
    retainedTotal: number;
    /** max(kernel, sink) + retained: conservative by the items not yet made. */
    duringRun: number;
    /** What is live at once while the artifact is handed over, by name. */
    publish: Record<string, number>;
    atPublish: number;
}

export interface OutputEstimate {
    items: number;
    visuals: number;
    notices: number;
    encodedBytes: number;
    fileBytes: number;
    /** What is checked against `MAX_OUTPUT_BYTES`. */
    outputBytes: number;
    /** The largest single visual's share of it. */
    perVisualBytes: number;
}

export interface Preflight {
    artifact: ArtifactPlan;
    memory: MemoryModel;
    output: OutputEstimate;
    work: WorkEstimate;
    jobPeak: number;
    peakPhase: string;
    memoryLimit: number;
    withinBudget: boolean;
    refusal: Refusal | null;
}

/**
 * The three ceilings over the artifact that will actually be built.
 *
 * Memory is a peak. The kernel is serial, so the largest page decides its
 * share; the sink is serial, so the worst item decides its; and whatever the
 * container keeps is live under both, so it is added to both — all of it, from
 * the start, which overstates the early pages and is the price of not having
 * to reason about which page is the worst one. Then the hand-over: the
 * container's images, and the finished document the container builds from
 * them, at once.
 *
 * Work and output are cumulative, and are summed item by item rather than
 * multiplied by a representative page, because a document is not obliged to
 * be uniform and a notice is not obliged to be free.
 */
export function preflightArtifact(
    plan: ArtifactPlan,
    members: number,
    radiusPx: number,
    memoryLimit: number,
): Preflight {
    const c = JSPDF_CONTAINER;
    const container = plan.kind !== ARTIFACT.PREVIEW;
    const visuals = plan.items.filter((i) => i.kind === ARTIFACT_ITEM.PAIR_VISUAL);

    // The kernel, and the work it does, over the compared pages.
    const compared = new Map<number, PageSize>();
    for (const item of visuals) compared.set(item.page, { width: item.width, height: item.height });
    let kernel = estimatePhaseMemory({ width: 1, height: 1, members: 2, radiusPx: 0 });
    let kernelSeen = false;
    let jobUnits: number | null = 0;
    let perPageUnits = 0;
    for (const size of compared.values()) {
        const shape = { ...size, members, radiusPx };
        const phase = estimatePhaseMemory(shape);
        if (!kernelSeen || phase.peakWorkingSet > kernel.peakWorkingSet) kernel = phase;
        kernelSeen = true;
        const pageWork = estimateWork({ ...shape, pages: 1 });
        perPageUnits = Math.max(perPageUnits, pageWork.perPageUnits ?? 0);
        if (jobUnits === null || pageWork.jobUnits === null) {
            jobUnits = null;
        } else {
            jobUnits += pageWork.jobUnits;
            if (!Number.isSafeInteger(jobUnits)) jobUnits = null;
        }
    }
    if (!kernelSeen) {
        kernel = { phases: {}, peakPhase: 'none', peakWorkingSet: 0, bytesPerPixel: 0 };
    }
    const work: WorkEstimate = {
        algorithm: COMPARISON_ALGORITHM,
        perPageUnits,
        jobUnits,
        representable: jobUnits !== null,
    };

    // The artifact.
    let sinkPeak = 0;
    let sinkPeakItem: number | null = null;
    let retainedTotal = 0;
    let encodedBytes = 0;
    let fileBytes = container ? c.documentOverheadBytes : 0;
    let outputBytes = container ? c.documentOverheadBytes : 0;
    let perVisualBytes = 0;
    let largestString = 0;
    let smallStrings = container ? c.documentOverheadBytes : 0;
    plan.items.forEach((item, index) => {
        const cost = item.cost;
        if (container) {
            const live = cost.peakBytes + item.engineLiveBytes;
            if (live > sinkPeak) {
                sinkPeak = live;
                sinkPeakItem = index;
            }
            largestString = Math.max(largestString, binaryStringBytes(item.width * item.height * 3));
            smallStrings += c.perItemFileOverheadBytes;
        }
        retainedTotal += cost.retainedBytes;
        encodedBytes += cost.encodedBytes;
        fileBytes += cost.fileBytes;
        outputBytes += cost.outputBytes;
        if (item.kind === ARTIFACT_ITEM.PAIR_VISUAL) {
            perVisualBytes = Math.max(perVisualBytes, cost.outputBytes);
        }
    });

    const duringRun = Math.max(kernel.peakWorkingSet, sinkPeak) + retainedTotal;
    let publish: Record<string, number>;
    if (container) {
        publish = {
            'retained images': retainedTotal,
            'content strings': smallStrings,
            'rope flatten': largestString,
            'joined document': fileBytes,
            ArrayBuffer: fileBytes,
            Blob: fileBytes,
        };
    } else {
        const largest = visuals.reduce((n, i) => Math.max(n, i.cost.rasterBytes), 0);
        publish = { 'retained visuals': retainedTotal, 'display canvas': largest };
    }
    const atPublish = Object.values(publish).reduce((n, v) => n + v, 0);
    const jobPeak = Math.max(duringRun, atPublish);
    let peakPhase = 'publish';
    if (duringRun > atPublish) {
        peakPhase = sinkPeak > kernel.peakWorkingSet && sinkPeakItem !== null
            ? `${plan.items[sinkPeakItem].kind} ${plan.items[sinkPeakItem].cost.peakStep}`
            : kernel.peakPhase;
    }

    const output: OutputEstimate = {
        items: plan.items.length,
        visuals: visuals.length,
        notices: plan.items.length - visuals.length,
        encodedBytes,
        fileBytes,
        outputBytes,
        perVisualBytes,
    };

    const pageCount = new Set(plan.items.map((i) => i.page)).size;
    return refuseOrAccept({
        artifact: plan,
        memory: {
            kernel, sinkPeak, sinkPeakItem, retainedTotal, duringRun, publish, atPublish,
        },
        output,
        work,
        jobPeak,
        peakPhase,
        memoryLimit,
    }, pageCount);
}

/** Bytes as a human number, for a refusal a person has to act on. */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/** How many leading pages of the plan fit under the output ceiling. */
function pagesThatFit(plan: ArtifactPlan): number {
    const base = plan.kind === ARTIFACT.PREVIEW ? 0 : JSPDF_CONTAINER.documentOverheadBytes;
    const byPage = new Map<number, number>();
    for (const item of plan.items) {
        byPage.set(item.page, (byPage.get(item.page) ?? 0) + item.cost.outputBytes);
    }
    let total = base;
    let fit = 0;
    for (const bytes of byPage.values()) {
        total += bytes;
        if (total > MAX_OUTPUT_BYTES) break;
        fit += 1;
    }
    return fit;
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
    if (output.outputBytes > MAX_OUTPUT_BYTES) {
        const fit = pagesThatFit(base.artifact);
        return {
            ...base,
            withinBudget: false,
            refusal: {
                status: PLAN.OVER_OUTPUT_BUDGET,
                reason: `出力が上限を超えます（比較 ${output.visuals} 枚・`
                    + `通知 ${output.notices} 枚 / ${formatBytes(output.outputBytes)}）。`,
                requested: `${pageCount} ページ`,
                achievable: fit > 0 ? `先頭から ${fit} ページまで` : undefined,
            },
        };
    }
    return { ...base, withinBudget: true, refusal: null };
}

function maxEntry(record: Record<string, number>): [string, number] {
    let best: [string, number] = ['', -Infinity];
    for (const [name, value] of Object.entries(record)) {
        if (value > best[1]) best = [name, value];
    }
    return best;
}
