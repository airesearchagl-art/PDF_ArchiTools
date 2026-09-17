/**
 * What the artifact actually holds, and taking out what nothing points at.
 *
 * pdf-lib writes **everything registered in the context**, reachable or not
 * (`core/writers/PDFWriter.js` walks `enumerateIndirectObjects`). That single
 * fact is behind three separate defects this milestone has now met:
 *
 *   - pages `copyPages` copied and never inserted into `/Pages`;
 *   - a JavaScript action detached from the key that reached it, still in the
 *     bytes;
 *   - an embedded file whose `/Filespec` was deleted, its payload stream still
 *     in the bytes.
 *
 * Removing a reference is not removing an object. So the artifact is swept:
 * everything reachable from the document's roots is kept, and everything else
 * is deleted before `save()`.
 *
 * This is deliberately a **reachability** sweep rather than a list of things to
 * remove. A list only removes the shapes somebody thought of; the next detached
 * object of a shape nobody listed would ship exactly as these did.
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

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/** The dictionary of a dictionary or of a stream, or `null`. */
const dictOf = (value: unknown): PDFDict | null => {
    if (value instanceof PDFDict) return value;
    const inner = (value as { dict?: unknown } | null)?.dict;
    return inner instanceof PDFDict ? inner : null;
};

/**
 * Every indirect object reachable from the document's roots.
 *
 * The roots are the catalog and the trailer's `/Info`, which is everything a
 * reader can start from in a document this code produces. Bounded by the
 * visited set rather than by a depth limit: a reachability answer that gave up
 * early would delete objects that are reachable, which is the one failure mode
 * worse than keeping a detached one.
 */
function reachableRefs(doc: PDFDocument): Set<string> {
    const live = new Set<string>();
    const seenObjects = new Set<object>();
    const stack: unknown[] = [];

    const push = (value: unknown): void => {
        if (value === undefined || value === null) return;
        stack.push(value);
    };

    /**
     * The roots are marked **by reference**, not by object.
     *
     * Pushing the catalog object walks everything under it but never adds the
     * catalog's own reference to the live set, so the sweep deleted the catalog
     * and the artifact reopened with no page tree at all. A root that is not
     * marked as live is not a root.
     */
    const { Root, Info } = doc.context.trailerInfo as {
        Root?: unknown;
        Info?: unknown;
    };
    if (Root !== undefined) push(Root);
    if (Info !== undefined) push(Info);

    // A document whose trailer does not name its catalog is still walked from
    // the catalog object, and every `/Catalog` in the table is treated as a root:
    // deleting one because the trailer was unusual is not a trade this sweep makes.
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

/**
 * Indirect objects nothing reachable points at.
 *
 * Measured on an artifact rather than used to remove anything, so the sweep's
 * result can be asserted on the bytes instead of trusted from the sweep.
 */
export function countUnreachable(doc: PDFDocument): number {
    const live = reachableRefs(doc);
    let count = 0;
    for (const [ref] of doc.context.enumerateIndirectObjects()) {
        if (!live.has(ref.tag)) count += 1;
    }
    return count;
}

export interface PruneReport {
    /** Indirect objects deleted because nothing reachable pointed at them. */
    deleted: number;
    /** What was deleted, by `/Type` or `/Subtype`, for the gate to read. */
    byKind: Record<string, number>;
}

/**
 * Delete every indirect object nothing reachable points at.
 *
 * Run immediately before `save()`, after all reconstruction and sanitization, so
 * what survives is what a reader can actually get to.
 */
export function pruneUnreachable(doc: PDFDocument): PruneReport {
    const live = reachableRefs(doc);
    const doomed: PDFRef[] = [];
    const byKind: Record<string, number> = {};

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (live.has(ref.tag)) continue;
        doomed.push(ref);
        const dict = dictOf(obj);
        const kind = dict
            ? (nameOf(dict.get(PDFName.of('Subtype'))) || nameOf(dict.get(PDFName.of('Type'))) || 'untyped')
            : (obj instanceof PDFStream ? 'stream' : 'other');
        byKind[kind] = (byKind[kind] ?? 0) + 1;
    }

    for (const ref of doomed) {
        const obj = doc.context.lookup(ref);
        // Scrubbed before deletion, so that any route this code has not modelled
        // finds an empty dictionary rather than the thing that was removed.
        const dict = dictOf(obj);
        if (dict) {
            for (const [key] of [...dict.entries()]) dict.delete(key);
        }
        doc.context.delete(ref);
    }

    return { deleted: doomed.length, byKind };
}

/**
 * Every JavaScript action in the artifact, wherever it sits.
 *
 * The old scanner asked one question of each **top-level** indirect object: is
 * its `/S` `/JavaScript`? That misses a JavaScript action held as a direct
 * dictionary inside another object — under `/Next` on a detached `/GoTo`, under
 * `/AA` on a detached form field, under `/AA` on an annotation the copy brought
 * across — and all three reported `artifact-wide 0` about a file that carried
 * the script. Measured on three fixtures: production readback 0, the marker
 * present in the serialized bytes.
 *
 * So this walks into everything: dictionaries, arrays, and the dictionaries of
 * streams, cycle-safe, and counts an action wherever it is. `/JS` is counted as
 * well as `/S /JavaScript`, because an action dictionary stripped of its `/S`
 * still carries the script.
 */
export function findJavaScriptActions(doc: PDFDocument): { holder: PDFDict; viaRef: string | null }[] {
    const found: { holder: PDFDict; viaRef: string | null }[] = [];
    const seen = new Set<object>();

    const walk = (value: unknown, viaRef: string | null, depth: number): void => {
        if (depth > 256) return;
        if (value instanceof PDFRef) {
            let target: unknown;
            try {
                target = doc.context.lookup(value);
            } catch {
                return;
            }
            if (target !== undefined) walk(target, value.tag, depth + 1);
            return;
        }
        if (typeof value !== 'object' || value === null) return;
        if (seen.has(value)) return;
        seen.add(value);

        if (value instanceof PDFDict) {
            const isAction = nameOf(value.get(PDFName.of('S'))) === '/JavaScript'
                || value.get(PDFName.of('JS')) !== undefined;
            if (isAction) found.push({ holder: value, viaRef });
            for (const [, entry] of value.entries()) walk(entry, viaRef, depth + 1);
            return;
        }
        if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i += 1) walk(value.get(i), viaRef, depth + 1);
            return;
        }
        if (value instanceof PDFStream) {
            for (const [, entry] of value.dict.entries()) walk(entry, viaRef, depth + 1);
        }
    };

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        walk(obj instanceof PDFRawStream ? obj.dict : obj, ref.tag, 0);
    }

    return found;
}

/** The count the artifact invariant is stated in terms of. */
export function countArtifactWideJavaScript(doc: PDFDocument): number {
    return findJavaScriptActions(doc).length;
}

/**
 * Scrub every JavaScript action found anywhere, then delete the indirect ones.
 *
 * Belt and braces beside {@link pruneUnreachable}: the sweep removes detached
 * objects, and this removes a script even where it sits inside something that
 * is still reachable and has to stay.
 */
export function scrubAllJavaScript(doc: PDFDocument): number {
    const actions = findJavaScriptActions(doc);
    for (const { holder } of actions) {
        for (const [key] of [...holder.entries()]) holder.delete(key);
    }
    // Any object that WAS a JavaScript action is now an empty dictionary; the
    // reachability sweep takes the detached ones out on the next pass.
    const doomed: PDFRef[] = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (obj.entries().length > 0) continue;
        // Only objects this scrub emptied, not every empty dictionary: an
        // emptied action is the one shape known to have been one.
        if (actions.some((a) => a.viaRef === ref.tag)) doomed.push(ref);
    }
    for (const ref of doomed) doc.context.delete(ref);
    return actions.length;
}

export interface AttachmentCensus {
    fileAttachmentAnnots: number;
    filespecs: number;
    filespecsWithEF: number;
    embeddedFileStreams: number;
}

/**
 * Attachments as an independent count, taken from the object table rather than
 * from the code that removed them.
 *
 * The production remover reporting what it removed is the remover describing its
 * own intent. Measured: it reported an attachment removed while the page's
 * `/FileAttachment` annotation, and the embedded payload stream it reached, were
 * both still in the serialized bytes.
 */
export function censusAttachments(doc: PDFDocument): AttachmentCensus {
    const census: AttachmentCensus = {
        fileAttachmentAnnots: 0,
        filespecs: 0,
        filespecsWithEF: 0,
        embeddedFileStreams: 0,
    };
    const seen = new Set<object>();

    const walk = (value: unknown, depth: number): void => {
        if (depth > 256) return;
        if (value instanceof PDFRef) {
            let target: unknown;
            try {
                target = doc.context.lookup(value);
            } catch {
                return;
            }
            if (target !== undefined) walk(target, depth + 1);
            return;
        }
        if (typeof value !== 'object' || value === null) return;
        if (seen.has(value)) return;
        seen.add(value);

        const dict = dictOf(value);
        if (dict) {
            if (nameOf(dict.get(PDFName.of('Subtype'))) === '/FileAttachment') {
                census.fileAttachmentAnnots += 1;
            }
            if (nameOf(dict.get(PDFName.of('Type'))) === '/Filespec') {
                census.filespecs += 1;
                if (dict.get(PDFName.of('EF')) !== undefined) census.filespecsWithEF += 1;
            }
            if (nameOf(dict.get(PDFName.of('Type'))) === '/EmbeddedFile') {
                census.embeddedFileStreams += 1;
            }
        }

        if (value instanceof PDFDict) {
            for (const [, entry] of value.entries()) walk(entry, depth + 1);
        } else if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i += 1) walk(value.get(i), depth + 1);
        } else if (value instanceof PDFStream) {
            for (const [, entry] of value.dict.entries()) walk(entry, depth + 1);
        }
    };

    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        walk(obj instanceof PDFRawStream ? obj.dict : obj, 0);
    }
    return census;
}

/**
 * Tagging remnants, counted across every copied reachable structure rather than
 * at the catalog only.
 *
 * M6-H9a says strip every remnant. A `/StructParent` on an annotation, or
 * `/StructParents` on a form XObject, points a reader's accessibility machinery
 * at a tree that is gone — the same defect as leaving it on a page, in a place
 * the first implementation did not look.
 */
export interface TaggingCensus {
    structTreeRoot: boolean;
    markInfo: boolean;
    pageStructParents: number;
    annotationStructParent: number;
    xobjectStructParents: number;
    total: number;
}

export function censusTagging(doc: PDFDocument): TaggingCensus {
    const census: TaggingCensus = {
        structTreeRoot: doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined,
        markInfo: doc.catalog.get(PDFName.of('MarkInfo')) !== undefined,
        pageStructParents: 0,
        annotationStructParent: 0,
        xobjectStructParents: 0,
        total: 0,
    };

    for (const page of doc.getPages()) {
        if (page.node.get(PDFName.of('StructParents')) !== undefined) census.pageStructParents += 1;
    }

    const seen = new Set<object>();
    const walk = (value: unknown, depth: number): void => {
        if (depth > 256) return;
        if (value instanceof PDFRef) {
            let target: unknown;
            try {
                target = doc.context.lookup(value);
            } catch {
                return;
            }
            if (target !== undefined) walk(target, depth + 1);
            return;
        }
        if (typeof value !== 'object' || value === null) return;
        if (seen.has(value)) return;
        seen.add(value);

        const dict = dictOf(value);
        if (dict) {
            const subtype = nameOf(dict.get(PDFName.of('Subtype')));
            const type = nameOf(dict.get(PDFName.of('Type')));
            if (type === '/Annot' || (subtype && subtype !== '/Form' && subtype !== '/Image' && dict.get(PDFName.of('Rect')) !== undefined)) {
                if (dict.get(PDFName.of('StructParent')) !== undefined) census.annotationStructParent += 1;
            }
            if (subtype === '/Form' || subtype === '/Image') {
                if (dict.get(PDFName.of('StructParents')) !== undefined) census.xobjectStructParents += 1;
            }
        }

        if (value instanceof PDFDict) {
            for (const [, entry] of value.entries()) walk(entry, depth + 1);
        } else if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i += 1) walk(value.get(i), depth + 1);
        } else if (value instanceof PDFStream) {
            for (const [, entry] of value.dict.entries()) walk(entry, depth + 1);
        }
    };

    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        walk(obj instanceof PDFRawStream ? obj.dict : obj, 0);
    }

    census.total = (census.structTreeRoot ? 1 : 0)
        + (census.markInfo ? 1 : 0)
        + census.pageStructParents
        + census.annotationStructParent
        + census.xobjectStructParents;
    return census;
}

/**
 * Strip every tagging remnant, everywhere it was found.
 *
 * `/MarkInfo` goes with the tree: a document that declares itself marked while
 * carrying no structure tree is making a claim the artifact cannot support.
 */
export function stripTaggingEverywhere(doc: PDFDocument): TaggingCensus {
    const before = censusTagging(doc);

    doc.catalog.delete(PDFName.of('StructTreeRoot'));
    doc.catalog.delete(PDFName.of('MarkInfo'));

    const seen = new Set<object>();
    const walk = (value: unknown, depth: number): void => {
        if (depth > 256) return;
        if (value instanceof PDFRef) {
            let target: unknown;
            try {
                target = doc.context.lookup(value);
            } catch {
                return;
            }
            if (target !== undefined) walk(target, depth + 1);
            return;
        }
        if (typeof value !== 'object' || value === null) return;
        if (seen.has(value)) return;
        seen.add(value);

        const dict = dictOf(value);
        if (dict) {
            dict.delete(PDFName.of('StructParent'));
            dict.delete(PDFName.of('StructParents'));
        }

        if (value instanceof PDFDict) {
            for (const [, entry] of value.entries()) walk(entry, depth + 1);
        } else if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i += 1) walk(value.get(i), depth + 1);
        } else if (value instanceof PDFStream) {
            for (const [, entry] of value.dict.entries()) walk(entry, depth + 1);
        }
    };

    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        walk(obj instanceof PDFRawStream ? obj.dict : obj, 0);
    }

    return before;
}
