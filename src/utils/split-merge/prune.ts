/**
 * What the artifact actually holds, taking out what nothing points at — and
 * refusing rather than reporting zero when the inspection cannot be proven
 * complete.
 *
 * pdf-lib writes **everything registered in the context**, reachable or not
 * (`core/writers/PDFWriter.js` walks `enumerateIndirectObjects`). That single
 * fact is behind several defects this milestone has met: pages `copyPages`
 * copied and never inserted into `/Pages`; a JavaScript action detached from the
 * key that reached it; an embedded file whose `/Filespec` was deleted with its
 * payload stream still in the bytes.
 *
 * Removing a reference is not removing an object. So the artifact is swept:
 * everything reachable from the document's roots is kept, and everything else is
 * deleted before `save()`. This is deliberately a **reachability** sweep rather
 * than a list of things to remove — a list only removes the shapes somebody
 * thought of.
 *
 * Every census here runs on the shared complete-or-refuse primitive in
 * `census.ts`. Detection stays domain-specific and separate, so a change to what
 * counts as JavaScript cannot quietly change what counts as an attachment.
 */
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { censusIndirectObjects, collectByCensus, dictOf } from './census';
import type { CensusNode, CensusOutcome } from './census';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

// ---------------------------------------------------------------------------
// Reachability, and the sweep
// ---------------------------------------------------------------------------

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
 */
function reachableRefs(doc: PDFDocument): Set<string> {
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

/** Indirect objects nothing reachable points at, measured on an artifact. */
export function countUnreachable(doc: PDFDocument): number {
    const live = reachableRefs(doc);
    let count = 0;
    for (const [ref] of doc.context.enumerateIndirectObjects()) {
        if (!live.has(ref.tag)) count += 1;
    }
    return count;
}

export interface PruneReport {
    deleted: number;
    byKind: Record<string, number>;
}

/** Delete every indirect object nothing reachable points at. */
export function pruneUnreachable(doc: PDFDocument): PruneReport {
    const live = reachableRefs(doc);
    const doomed: PDFRef[] = [];
    const byKind: Record<string, number> = {};

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (live.has(ref.tag)) continue;
        doomed.push(ref);
        const dict = dictOf(obj);
        const kind = dict
            ? (nameOf(dict.get(PDFName.of('Subtype')))
                || nameOf(dict.get(PDFName.of('Type')))
                || 'untyped')
            : (obj instanceof PDFStream ? 'stream' : 'other');
        byKind[kind] = (byKind[kind] ?? 0) + 1;
    }

    for (const ref of doomed) {
        const obj = doc.context.lookup(ref);
        const dict = dictOf(obj);
        if (dict) {
            for (const [key] of [...dict.entries()]) dict.delete(key);
        }
        doc.context.delete(ref);
    }

    return { deleted: doomed.length, byKind };
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

/**
 * Whether a dictionary carries JavaScript, whatever it calls itself.
 *
 * `/S /JavaScript` is the obvious form and not the only one: a Rendition action
 * carries its script in `/JS` under `/S /Rendition`, and the reachable scanner
 * that asked only about `/S` reported **zero** for a document whose action held
 * `/JS`. So the question is about the script, not the subtype — an action
 * dictionary that holds `/JS` holds JavaScript however it is labelled.
 */
export const carriesJavaScript = (dict: PDFDict): boolean =>
    dict.get(PDFName.of('JS')) !== undefined
    || nameOf(dict.get(PDFName.of('S'))) === '/JavaScript';

/** Every JavaScript carrier in the artifact, or a refusal. */
export function censusJavaScript(doc: PDFDocument): CensusOutcome<CensusNode[]> {
    return collectByCensus(doc, (node) => carriesJavaScript(node.dict));
}

/**
 * Scrub every JavaScript carrier the census found, and delete the indirect ones.
 *
 * Returns a refusal when the census could not prove it covered the artifact:
 * scrubbing what an incomplete scan happened to find and then reporting success
 * is the failure this whole module was rebuilt to remove.
 */
export type ScrubOutcome =
    | { complete: true; scrubbed: number }
    | { complete: false; reason: string };

export function scrubAllJavaScript(doc: PDFDocument): ScrubOutcome {
    const census = censusJavaScript(doc);
    if (!census.complete) return { complete: false, reason: census.reason };

    const rootTags = new Set<string>();
    for (const node of census.value) {
        rootTags.add(node.rootTag);
        // The entry that holds it goes, so the artifact does not keep an action
        // dictionary stripped of everything that made it one.
        if (node.parent) {
            const { container, key } = node.parent;
            if (container instanceof PDFDict) container.delete(PDFName.of(String(key)));
        }
        for (const [key] of [...node.dict.entries()]) node.dict.delete(key);
    }

    // An indirect object that WAS a carrier is emptied above; the reachability
    // sweep removes it once nothing points at it.
    for (const tag of rootTags) {
        for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
            if (ref.tag !== tag) continue;
            const dict = dictOf(obj);
            if (dict && carriesJavaScript(dict)) {
                for (const [key] of [...dict.entries()]) dict.delete(key);
            }
        }
    }

    return { complete: true, scrubbed: census.value.length };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Whether a dictionary is an attachment carrier.
 *
 * **Semantic, not declared.** A dictionary carrying `/EF` is a file
 * specification whether or not it says `/Type /Filespec`, and the stream behind
 * it is a payload whether or not it says `/Type /EmbeddedFile`. Measured: a
 * typeless `/EF` carrier inside a `/Launch` action evaded detection, evaded
 * removal, and its payload bytes were in the artifact while the census reported
 * zero.
 */
export const carriesEmbeddedFile = (dict: PDFDict): boolean =>
    dict.get(PDFName.of('EF')) !== undefined;

export const isFileAttachmentAnnot = (dict: PDFDict): boolean =>
    nameOf(dict.get(PDFName.of('Subtype'))) === '/FileAttachment';

export interface AttachmentCensus {
    /** Dictionaries carrying `/EF`, whatever their `/Type`. */
    efCarriers: number;
    fileAttachmentAnnots: number;
    /** Streams reachable through an `/EF`, whatever their `/Type`. */
    payloadStreams: number;
    /** Names found, for disclosure. */
    names: string[];
}

const textOf = (v: unknown): string | null => {
    const decode = (v as { decodeText?: () => string } | null)?.decodeText;
    return typeof decode === 'function' ? decode.call(v) : null;
};

/** The attachment census, or a refusal. */
export function censusAttachments(doc: PDFDocument): CensusOutcome<AttachmentCensus> {
    const result: AttachmentCensus = {
        efCarriers: 0,
        fileAttachmentAnnots: 0,
        payloadStreams: 0,
        names: [],
    };
    const payloadTags = new Set<string>();

    const outcome = censusIndirectObjects(doc, (node) => {
        const { dict } = node;
        if (isFileAttachmentAnnot(dict)) result.fileAttachmentAnnots += 1;
        if (!carriesEmbeddedFile(dict)) return;
        result.efCarriers += 1;
        const label = textOf(dict.get(PDFName.of('F')))
            ?? textOf(dict.get(PDFName.of('UF')))
            ?? textOf(doc.context.lookup(dict.get(PDFName.of('F')) as never));
        if (label && !result.names.includes(label)) result.names.push(label);

        const ef = dict.get(PDFName.of('EF'));
        const efDict = ef instanceof PDFRef ? doc.context.lookup(ef) : ef;
        if (!(efDict instanceof PDFDict)) return;
        for (const [, target] of efDict.entries()) {
            if (target instanceof PDFRef) {
                if (!payloadTags.has(target.tag)) {
                    payloadTags.add(target.tag);
                    result.payloadStreams += 1;
                }
            } else if (target instanceof PDFStream) {
                result.payloadStreams += 1;
            }
        }
    });

    if (!outcome.complete) return outcome;
    return { complete: true, value: result, nodes: outcome.nodes, roots: outcome.roots };
}

export type AttachmentRemoval =
    | { complete: true; removed: number; names: string[]; removedActions: string[] }
    | { complete: false; reason: string };

/**
 * Remove every attachment, everywhere, and leave nothing half-removed.
 *
 * Three things go together, because removing any one of them alone is what
 * produced the defects: the `/EF` entry, the payload streams behind it, and —
 * when the carrier sits inside an action this contract does not support, such as
 * `/Launch` — the whole containing action. Deleting a `/Launch` action's file
 * and leaving the action behind would ship a broken action, which is a partial
 * semantic this contract does not invent.
 */
export function removeAttachmentsEverywhere(doc: PDFDocument): AttachmentRemoval {
    const names: string[] = [];
    const removedActions: string[] = [];
    /** Indirect objects to delete, and whose incoming references to remove. */
    const condemnedTags = new Set<string>();
    let removed = 0;

    const condemn = (raw: unknown): void => {
        if (raw instanceof PDFRef) condemnedTags.add(raw.tag);
    };

    /** An action this contract does not carry, so removing it whole is safe. */
    const unsupportedAction = (dict: PDFDict): string | null => {
        const s = nameOf(dict.get(PDFName.of('S')));
        if (!s) return null;
        return s === '/GoTo' ? null : s;
    };

    // ---- phase 1: identify, by a census that proves it covered the artifact ---
    const carriers = collectByCensus(doc, (node) => carriesEmbeddedFile(node.dict));
    if (!carriers.complete) return { complete: false, reason: carriers.reason };
    const annots = collectByCensus(doc, (node) => isFileAttachmentAnnot(node.dict));
    if (!annots.complete) return { complete: false, reason: annots.reason };

    for (const node of carriers.value) {
        const { dict, parent, depth, rootTag } = node;
        const label = textOf(dict.get(PDFName.of('F')))
            ?? textOf(dict.get(PDFName.of('UF')))
            ?? textOf(doc.context.lookup(dict.get(PDFName.of('F')) as never));
        if (label && !names.includes(label)) names.push(label);

        const ef = dict.get(PDFName.of('EF'));
        const efDict = ef instanceof PDFRef ? doc.context.lookup(ef) : ef;
        if (efDict instanceof PDFDict) {
            for (const [, target] of efDict.entries()) condemn(target);
            for (const [key] of [...efDict.entries()]) efDict.delete(key);
        }
        condemn(ef);
        dict.delete(PDFName.of('EF'));
        removed += 1;

        // A carrier that IS an indirect object is condemned whole; one nested
        // directly inside something else is edited in place.
        if (depth === 0) condemnedTags.add(rootTag);
        else if (parent && parent.container instanceof PDFDict) {
            const holder = parent.container;
            const kind = unsupportedAction(holder);
            if (kind) {
                // A `/Launch` whose file has been taken away is a broken action,
                // and this contract does not invent partial action semantics. The
                // whole action goes, and the removal is named.
                removedActions.push(kind);
                for (const [key] of [...holder.entries()]) holder.delete(key);
                removed += 1;
            } else {
                holder.delete(PDFName.of(String(parent.key)));
            }
        }
    }

    for (const node of annots.value) {
        condemn(node.dict.get(PDFName.of('FS')));
        node.dict.delete(PDFName.of('FS'));
        if (node.depth === 0) condemnedTags.add(node.rootTag);
        else if (node.parent?.container instanceof PDFArray) {
            const array = node.parent.container;
            for (let i = array.size() - 1; i >= 0; i -= 1) {
                if (dictOf(array.get(i)) === node.dict) array.remove(i);
            }
        }
        removed += 1;
    }

    const namesDict = doc.catalog.lookup(PDFName.of('Names'));
    if (namesDict instanceof PDFDict && namesDict.get(PDFName.of('EmbeddedFiles')) !== undefined) {
        namesDict.delete(PDFName.of('EmbeddedFiles'));
        removed += 1;
    }

    // ---- phase 2: remove every incoming reference, then the objects -----------
    //
    // The census deliberately does not follow references — that is what makes it
    // complete — so it cannot see that an `/Annots` array holds a reference to a
    // condemned annotation. Taking the object out without taking the reference
    // out left the annotation in the artifact, counted by the readback and
    // reported as a survival. So references are removed by their own pass.
    if (condemnedTags.size > 0) {
        const pass = censusIndirectObjects(doc, ({ dict }) => {
            for (const [key, value] of [...dict.entries()]) {
                if (value instanceof PDFRef && condemnedTags.has(value.tag)) dict.delete(key);
                if (value instanceof PDFArray) {
                    for (let i = value.size() - 1; i >= 0; i -= 1) {
                        const entry = value.get(i);
                        if (entry instanceof PDFRef && condemnedTags.has(entry.tag)) value.remove(i);
                    }
                }
            }
        });
        if (!pass.complete) return { complete: false, reason: pass.reason };
    }

    for (const tag of condemnedTags) {
        for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
            if (ref.tag !== tag) continue;
            const dict = dictOf(obj);
            if (dict) {
                for (const [key] of [...dict.entries()]) dict.delete(key);
            }
            doc.context.delete(ref);
            removed += 1;
            break;
        }
    }

    return { complete: true, removed, names, removedActions };
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

export interface TaggingCensus {
    structTreeRoot: boolean;
    markInfo: boolean;
    structParents: number;
    structParent: number;
    total: number;
}

/** Tagging remnants across every copied reachable structure, or a refusal. */
export function censusTagging(doc: PDFDocument): CensusOutcome<TaggingCensus> {
    const result: TaggingCensus = {
        structTreeRoot: doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined,
        markInfo: doc.catalog.get(PDFName.of('MarkInfo')) !== undefined,
        structParents: 0,
        structParent: 0,
        total: 0,
    };
    const outcome = censusIndirectObjects(doc, ({ dict }) => {
        if (dict.get(PDFName.of('StructParents')) !== undefined) result.structParents += 1;
        if (dict.get(PDFName.of('StructParent')) !== undefined) result.structParent += 1;
    });
    if (!outcome.complete) return outcome;
    result.total = (result.structTreeRoot ? 1 : 0)
        + (result.markInfo ? 1 : 0)
        + result.structParents
        + result.structParent;
    return { complete: true, value: result, nodes: outcome.nodes, roots: outcome.roots };
}

export type TaggingStrip =
    | { complete: true; before: TaggingCensus }
    | { complete: false; reason: string };

/** Strip every tagging remnant, everywhere, or refuse. */
export function stripTaggingEverywhere(doc: PDFDocument): TaggingStrip {
    const before = censusTagging(doc);
    if (!before.complete) return { complete: false, reason: before.reason };

    doc.catalog.delete(PDFName.of('StructTreeRoot'));
    doc.catalog.delete(PDFName.of('MarkInfo'));

    const outcome = censusIndirectObjects(doc, ({ dict }) => {
        dict.delete(PDFName.of('StructParent'));
        dict.delete(PDFName.of('StructParents'));
    });
    if (!outcome.complete) return { complete: false, reason: outcome.reason };

    return { complete: true, before: before.value };
}

/** Raw-stream payload bytes still in the context, for a gate to compare. */
export function rawStreamCount(doc: PDFDocument): number {
    let count = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream) count += 1;
    }
    return count;
}
