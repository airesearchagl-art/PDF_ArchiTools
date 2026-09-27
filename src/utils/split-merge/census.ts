/**
 * One artifact-census traversal, with exactly two outcomes.
 *
 * The recurring architectural error this replaces: a bounded scanner reached its
 * internal depth limit, stopped, and then reported **zero**. A count that can be
 * produced by giving up is not a safety invariant — it is the absence of one,
 * wearing the same shape.
 *
 * Adopted Human clarification: every census whose result is used as an output
 * invariant ends as
 *
 *   COMPLETE   the whole claimed scope was inspected, and here is the count
 *   REFUSED    completeness could not be proven, and this is a typed failure
 *
 * There is no TRUNCATED-then-ZERO state.
 *
 * **Why enumerating roots beats following references.** Every indirect object in
 * the context is its own census root, so nothing has to be *discovered* by
 * traversal to be inspected. That removes the whole failure mode at the root:
 * the previous scanner shared one `seen` set across roots and marked an object
 * before inspecting its descendants, so an object that was truncated during one
 * traversal could be skipped as "already seen" when its turn as a root came
 * round. Here the walk never follows a `PDFRef` — it does not need to — and the
 * cycle set is **local to one root**, so no root can suppress another.
 *
 * Direct nesting is what is walked: dictionaries, arrays and stream
 * dictionaries. That is bounded in practice as well as in principle, because the
 * pre-parse Load Boundary already refuses a document whose direct nesting is
 * deeper than its nesting cap long before a census sees it.
 */
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';

/**
 * How much direct nesting one root may hold, and how many nodes one census may
 * inspect, before completeness stops being provable.
 *
 * Neither is a product policy value and neither is a B4 item: they are the point
 * at which this module stops claiming to have looked at everything. Generous on
 * purpose — the answer when one is reached is a refusal, so a value that is too
 * small costs compatibility rather than safety.
 */
export const CENSUS_BUDGET = {
    /** Direct container nesting within a single indirect object. */
    maxDirectDepth: 512,
    /** Nodes inspected across the whole census. */
    maxNodes: 5_000_000,
} as const;

export type CensusOutcome<T> =
    | { complete: true; value: T; nodes: number; roots: number }
    | { complete: false; reason: string; nodes: number; roots: number };

/** What the visitor is handed: one dictionary, and where it was found. */
export interface CensusNode {
    dict: PDFDict;
    /** The indirect object this dictionary was reached from. */
    rootTag: string;
    /** Direct nesting depth below that root. 0 is the root object itself. */
    depth: number;
    /**
     * The container that holds this dictionary, and the key or index it is held
     * under. Null at a root. Lets a remover delete the right entry rather than
     * guess.
     */
    parent: { container: PDFDict | PDFArray; key: string | number } | null;
}

/** The dictionary of a dictionary or of a stream, or `null`. */
export const dictOf = (value: unknown): PDFDict | null => {
    if (value instanceof PDFDict) return value;
    const inner = (value as { dict?: unknown } | null)?.dict;
    return inner instanceof PDFDict ? inner : null;
};

/**
 * Walk every indirect object's direct content, calling `visit` for each
 * dictionary found, and answer COMPLETE or REFUSED.
 *
 * `visit` does the domain-specific detection. This function does nothing but
 * guarantee the scope was covered — which is why the JavaScript census and the
 * attachment census can share it without one being able to change the other's
 * semantics.
 */
export function censusIndirectObjects(
    doc: PDFDocument,
    visit: (node: CensusNode) => void,
): CensusOutcome<void> {
    let nodes = 0;
    let roots = 0;

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        roots += 1;
        const rootTag = ref.tag;
        // Local to this root. A cycle inside one object terminates; nothing this
        // root visits can stop another root from being inspected.
        const local = new Set<object>();
        const stack: {
            value: unknown;
            depth: number;
            parent: CensusNode['parent'];
        }[] = [{ value: obj instanceof PDFRawStream ? obj.dict : obj, depth: 0, parent: null }];

        while (stack.length > 0) {
            const item = stack.pop() as (typeof stack)[number];
            const { value, depth, parent } = item;

            if (value === undefined || value === null) continue;
            // A reference is NOT followed: its target is enumerated as its own
            // root. Following it is what made the old walk depth-sensitive.
            if (value instanceof PDFRef) continue;
            if (typeof value !== 'object') continue;

            nodes += 1;
            if (nodes > CENSUS_BUDGET.maxNodes) {
                return {
                    complete: false,
                    reason: `census exceeded ${CENSUS_BUDGET.maxNodes} nodes`,
                    nodes,
                    roots,
                };
            }
            if (depth > CENSUS_BUDGET.maxDirectDepth) {
                return {
                    complete: false,
                    reason: `object ${rootTag} nests directly deeper than `
                        + `${CENSUS_BUDGET.maxDirectDepth}`,
                    nodes,
                    roots,
                };
            }

            if (local.has(value)) continue;
            local.add(value);

            const dict = dictOf(value);
            if (dict) {
                visit({ dict, rootTag, depth, parent });
                for (const [key, entry] of dict.entries()) {
                    stack.push({
                        value: entry,
                        depth: depth + 1,
                        parent: { container: dict, key: key.asString().replace(/^\//, '') },
                    });
                }
                // A stream's own dictionary was handed over above; its bytes are
                // not a container.
                continue;
            }
            if (value instanceof PDFArray) {
                for (let i = 0; i < value.size(); i += 1) {
                    stack.push({
                        value: value.get(i),
                        depth: depth + 1,
                        parent: { container: value, key: i },
                    });
                }
                continue;
            }
            if (value instanceof PDFStream) {
                stack.push({ value: value.dict, depth: depth + 1, parent });
            }
        }
    }

    return { complete: true, value: undefined, nodes, roots };
}

/**
 * A census that counts, with the same two outcomes.
 *
 * The count is only returned when the scope was covered. A caller that wants a
 * number has to handle the refusal, which is the point: it cannot accidentally
 * read "nothing was found" out of "nothing was looked at".
 */
export function countByCensus(
    doc: PDFDocument,
    matches: (node: CensusNode) => boolean,
): CensusOutcome<number> {
    let count = 0;
    const outcome = censusIndirectObjects(doc, (node) => {
        if (matches(node)) count += 1;
    });
    if (!outcome.complete) return outcome;
    return { complete: true, value: count, nodes: outcome.nodes, roots: outcome.roots };
}

/** Collect the nodes a census matched, when the scope was covered. */
export function collectByCensus(
    doc: PDFDocument,
    matches: (node: CensusNode) => boolean,
): CensusOutcome<CensusNode[]> {
    const found: CensusNode[] = [];
    const outcome = censusIndirectObjects(doc, (node) => {
        if (matches(node)) found.push(node);
    });
    if (!outcome.complete) return outcome;
    return { complete: true, value: found, nodes: outcome.nodes, roots: outcome.roots };
}

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/**
 * Every indirect object reachable from the document's roots.
 *
 * The roots are marked **by reference**, not by object: pushing the catalog
 * object walks everything under it but never adds the catalog's own reference,
 * so an earlier version of this sweep deleted the catalog and the artifact
 * reopened with no page tree at all. A root that is not marked is not a root.
 *
 * Bounded by the visited set rather than by a depth limit. A reachability answer
 * that gave up early would delete objects that are reachable, which is the one
 * failure mode worse than keeping a detached one.
 *
 * Lives here, with the other whole-document traversal, because two modules ask
 * it: the sweep that deletes what nothing reaches, and the JavaScript ownership
 * analysis, which does not count a reference held by an object nothing reaches
 * as a reason to refuse — a dead holder takes nothing live with it.
 */
export function reachableRefTags(doc: PDFDocument): Set<string> {
    const live = new Set<string>();
    const seenObjects = new Set<object>();
    const stack: unknown[] = [];

    const push = (value: unknown): void => {
        if (value === undefined || value === null) return;
        stack.push(value);
    };

    const { Root, Info } = doc.context.trailerInfo as { Root?: unknown; Info?: unknown };
    if (Root !== undefined) push(Root);
    if (Info !== undefined) push(Info);
    push(doc.catalog);
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        const dict = dictOf(obj);
        if (dict && nameOf(dict.get(PDFName.of('Type'))) === '/Catalog') push(ref);
    }

    while (stack.length > 0) {
        const value = stack.pop();

        if (value instanceof PDFRef) {
            if (live.has(value.tag)) continue;
            live.add(value.tag);
            let target: unknown;
            try {
                target = doc.context.lookup(value);
            } catch {
                continue;
            }
            if (target !== undefined) push(target);
            continue;
        }

        if (typeof value !== 'object' || value === null) continue;
        if (seenObjects.has(value)) continue;
        seenObjects.add(value);

        if (value instanceof PDFDict) {
            for (const [, entry] of value.entries()) push(entry);
        } else if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i += 1) push(value.get(i));
        } else if (value instanceof PDFStream) {
            for (const [, entry] of value.dict.entries()) push(entry);
        }
    }

    return live;
}
