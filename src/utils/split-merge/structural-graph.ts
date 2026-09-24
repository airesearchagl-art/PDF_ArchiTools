/**
 * The object graph a copy will create, counted before it is created.
 *
 * B2's finding, and the reason this module exists: once a source is loaded,
 * everything `copyPages` will register is countable exactly — and nothing about
 * it is predictable from page count or file size. Page 1 of one measured
 * document is a single page that reaches nine unselected pages and 4,901,945 B
 * of stream bytes through its links; page 10 of the same document reaches four
 * objects and 490,196 B. `selectedPages x constant` is not a memory model, and
 * this contract does not use one.
 *
 * The walk follows pdf-lib 1.17.1's `PDFObjectCopier`
 * (`core/PDFObjectCopier.js:36-109`) without cloning anything:
 *
 *   - a page is prepared the way `copyPDFPage` prepares it — its own entries,
 *     plus any inheritable entry it lacks taken from the nearest ancestor, minus
 *     `/Parent` (`:42-58`);
 *   - every dictionary, array and stream met is walked, and every value in it
 *     followed: there is no branch for what a reference points at, which is the
 *     whole reason an internal destination drags a page into the output;
 *   - one destination reference is allocated per distinct source reference, and
 *     deduped by it (`:97-109`);
 *   - a raw stream's bytes are duplicated (`core/objects/PDFRawStream.js:17`).
 *
 * What it counts is EXACT — it equalled the real copy object for object and
 * stream byte for stream byte in fifteen shapes. What it cannot count is what
 * any of it weighs in a JavaScript heap: that is an engine property and stays
 * UNKNOWN, which is why none of these numbers becomes a memory preset.
 *
 * Bound to pdf-lib 1.17.1 (H11-B3-6).
 */
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFPageLeaf,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type { PDFContext, PDFDocument } from 'pdf-lib';
import type { StructuralPlan } from './contracts';
import { EMPTY_STRUCTURAL_PLAN } from './contracts';
import type { StructuralCaps } from './policy';

const INHERITABLE = PDFPageLeaf.InheritableEntries.map((key: string) => PDFName.of(key));
const PARENT = PDFName.of('Parent');

/**
 * Bytes a stream holds as it sits in the context.
 *
 * Raw streams only. A `PDFFlateStream` or `PDFContentStream` computes its bytes
 * on first request and caches the result
 * (`core/structures/PDFFlateStream.js:13-28`), so asking would change what the
 * document holds — the measurement would alter the thing being measured. Such
 * streams are counted, not sized.
 */
function heldStreamBytes(stream: PDFStream): { bytes: number; raw: boolean } {
    if (stream instanceof PDFRawStream) return { bytes: stream.contents.length, raw: true };
    return { bytes: 0, raw: false };
}

type StackItem = { page: PDFPageLeaf; root?: boolean } | { container: object };

/**
 * Everything `copyPages(doc, pageIndices)` would copy, in one pass.
 *
 * Deliberately iterative with an explicit stack: a two-hundred-deep chain must
 * not be the thing that decides whether the count finishes.
 *
 * **Precondition: the source must already be flushed.** Use
 * {@link planStructuralGraph}, which flushes first, unless the caller has
 * flushed itself. Counting an unflushed document counts a different document —
 * see the note on `planStructuralGraph`.
 */
export function reachableGraph(doc: PDFDocument, pageIndices: number[]): StructuralPlan {
    const context: PDFContext = doc.context;
    const pages = doc.getPages();
    const refsSeen = new Set<PDFRef>();
    const containersSeen = new Set<object>();
    const out: StructuralPlan = { ...EMPTY_STRUCTURAL_PLAN, selectedPages: pageIndices.length };

    const stack: StackItem[] = [];

    const visitValue = (value: unknown): void => {
        if (value instanceof PDFRef) {
            if (refsSeen.has(value)) return;
            refsSeen.add(value);
            out.copierEntries += 1;
            const target = context.lookup(value);
            if (target === undefined) {
                // The copier allocates a number for this and never assigns it,
                // so the output holds a reference to an object that is not there
                // (`core/PDFObjectCopier.js:97-109`).
                out.danglingReferences += 1;
                return;
            }
            out.destinationObjects += 1;
            if (target instanceof PDFPageLeaf) {
                out.pageLeavesReached += 1;
                stack.push({ page: target });
            } else {
                stack.push({ container: target as object });
            }
            return;
        }
        if (value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream) {
            stack.push({ container: value });
        }
    };

    const visitPage = (leaf: PDFPageLeaf): void => {
        out.copierEntries += 1;
        const entries = new Map(leaf.entries());
        for (const key of INHERITABLE) {
            if (!entries.has(key)) {
                const inheritedValue = leaf.getInheritableAttribute(key);
                if (inheritedValue !== undefined) entries.set(key, inheritedValue);
            }
        }
        entries.delete(PARENT);
        for (const value of entries.values()) visitValue(value);
    };

    const visitContainer = (object: object): void => {
        if (containersSeen.has(object)) return;
        containersSeen.add(object);
        if (object instanceof PDFPageLeaf) {
            visitPage(object);
            return;
        }
        out.copierEntries += 1;
        if (object instanceof PDFDict) {
            for (const [, value] of object.entries()) visitValue(value);
        } else if (object instanceof PDFArray) {
            for (let i = 0; i < object.size(); i += 1) visitValue(object.get(i));
        } else if (object instanceof PDFStream) {
            const held = heldStreamBytes(object);
            if (held.raw) {
                out.streams += 1;
                out.streamBytes += held.bytes;
                out.maxStreamBytes = Math.max(out.maxStreamBytes, held.bytes);
            } else {
                out.unsizedStreams += 1;
            }
            for (const [, value] of object.dict.entries()) visitValue(value);
        }
    };

    for (const index of pageIndices) {
        const page = pages[index];
        if (!page) throw new RangeError(`page index ${index} is outside the document`);
        out.destinationObjects += 1;
        stack.push({ page: page.node, root: true });
        while (stack.length > 0) {
            const next = stack.pop() as StackItem;
            if ('page' in next) {
                if (next.root) visitPage(next.page);
                else visitContainer(next.page);
            } else {
                visitContainer(next.container);
            }
        }
    }
    return out;
}

/**
 * The exact copy graph, counted the way the copy will see it.
 *
 * **Why this flushes first, and why that is not an optimisation.**
 *
 * `copyPages` flushes the *source* before reading it
 * (`api/PDFDocument.js:644`, `flush` at `:1201-1224`): the flush writes embedded
 * fonts, images, embedded pages and files into the source context, registering
 * objects that were not in its object table a moment earlier. So a count taken
 * before the flush describes a document that no longer exists by the time the
 * copier walks it.
 *
 * Measured here on a four-page document with one embedded font and a link whose
 * `/Dest` targets another page: counting before the flush predicted 5 copied
 * objects and the copy registered 6 — the font, which the flush had not yet
 * materialised. Counting after the flush predicts exactly what the copy
 * registers.
 *
 * That off-by-one is not cosmetic. H11-EXTRACT-1 requires the cap check to run
 * on the terms the copy will actually create, and A5 requires the planned graph
 * and the copied graph to agree. A planner that counted the unflushed document
 * would fail A5 on every source carrying an embedded resource, and — worse —
 * would under-count the graph it is supposed to be bounding.
 *
 * `structure-policy.md` stated the mechanism ("copying mutates the source ...
 * any M6 contract that re-uses a loaded source document after a copy is building
 * on a document that is no longer what it was"); this is where the contract
 * acts on it.
 */
export async function planStructuralGraph(
    doc: PDFDocument,
    pageIndices: number[],
): Promise<StructuralPlan> {
    await doc.flush();
    return reachableGraph(doc, pageIndices);
}

/**
 * The same counts taken from a document that already exists.
 *
 * Used on the artifact, so the plan can be checked against the copy it claimed
 * to describe (A5). Counting the output's own pages reproduces what the copy
 * created, because every page in the artifact was copied.
 */
export async function graphOfWholeDocument(doc: PDFDocument): Promise<StructuralPlan> {
    return planStructuralGraph(doc, doc.getPageIndices());
}

/** One cap that was exceeded, named so the refusal can say which. */
export interface CapBreach {
    term: string;
    value: number;
    cap: number;
    /** Why, in the user's language. */
    reason: string;
}

const formatCount = (n: number): string => n.toLocaleString('en-US');
const formatMiB = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Check one Extract's exact structural plan against the caps, before
 * `copyPages`.
 *
 * H11-EXTRACT-3: exceeding a cap is a typed refusal raised **before** the copy
 * starts, not an error discovered during it. The caps themselves are provisional
 * until B4 closes; the check is not.
 */
export function checkStructuralCaps(
    plan: StructuralPlan,
    caps: StructuralCaps,
): CapBreach | null {
    if (plan.destinationObjects > caps.maxCopiedObjects) {
        return {
            term: 'destinationObjects',
            value: plan.destinationObjects,
            cap: caps.maxCopiedObjects,
            reason: `この操作は ${formatCount(plan.destinationObjects)} 個のオブジェクトを複製します`
                + `（上限 ${formatCount(caps.maxCopiedObjects)} 個）。`,
        };
    }
    if (plan.copierEntries > caps.maxCopierEntries) {
        return {
            term: 'copierEntries',
            value: plan.copierEntries,
            cap: caps.maxCopierEntries,
            reason: `この操作は ${formatCount(plan.copierEntries)} 件の参照をたどります`
                + `（上限 ${formatCount(caps.maxCopierEntries)} 件）。`,
        };
    }
    if (plan.streamBytes > caps.maxDuplicatedStreamBytes) {
        return {
            term: 'streamBytes',
            value: plan.streamBytes,
            cap: caps.maxDuplicatedStreamBytes,
            reason: `この操作は ${formatMiB(plan.streamBytes)} のストリームを複製します`
                + `（上限 ${formatMiB(caps.maxDuplicatedStreamBytes)}）。`,
        };
    }
    if (plan.maxStreamBytes > caps.maxSingleStreamBytes) {
        return {
            term: 'maxStreamBytes',
            value: plan.maxStreamBytes,
            cap: caps.maxSingleStreamBytes,
            reason: `単一のストリームが ${formatMiB(plan.maxStreamBytes)} あります`
                + `（上限 ${formatMiB(caps.maxSingleStreamBytes)}）。`,
        };
    }
    return null;
}

/**
 * Check a Merge's cumulative totals **after adding the next source and before
 * copying it**.
 *
 * H11-MERGE-4. The output grew by exactly the sum of each source's pre-copy
 * count in both measured merges — 20,012 objects and 1,260,544 B across three
 * sources, 2,103 objects and 583,090 B across two — so the source that would
 * take the total over a cap can be refused before its copy rather than after.
 */
export function checkCumulativeCaps(
    cumulative: StructuralPlan,
    caps: StructuralCaps,
): CapBreach | null {
    const perSource = checkStructuralCaps(cumulative, {
        ...caps,
        maxCopiedObjects: caps.maxCumulativeCopiedObjects,
        maxDuplicatedStreamBytes: caps.maxCumulativeStreamBytes,
    });
    return perSource;
}

/**
 * Whether the plan and the artifact describe the same copy.
 *
 * A5, promoted to an implementation acceptance criterion: a structural cap is
 * only a safety argument if the graph that was counted is the graph that was
 * copied. Counting before E2 strips destinations and then changing the
 * structure would satisfy every check and describe a different document.
 *
 * `pageLeavesReached` is compared too, because it is the term that would move
 * if the destination stripping did not happen.
 */
export interface PlanActualComparison {
    agrees: boolean;
    differences: { term: string; planned: number; actual: number }[];
}

export function comparePlanWithActual(
    planned: StructuralPlan,
    actual: StructuralPlan,
): PlanActualComparison {
    const terms: (keyof StructuralPlan)[] = [
        'destinationObjects',
        'streamBytes',
        'pageLeavesReached',
    ];
    const differences: { term: string; planned: number; actual: number }[] = [];
    for (const term of terms) {
        if (planned[term] !== actual[term]) {
            differences.push({ term, planned: planned[term], actual: actual[term] });
        }
    }
    return { agrees: differences.length === 0, differences };
}
