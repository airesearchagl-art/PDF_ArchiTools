/**
 * The object graph a Split or Merge will copy, counted before it is copied.
 *
 * Not production code. B2 asks whether what `copyPages` keeps alive can be
 * bounded before the work starts. pdf-lib 1.17.1 answers part of that in its
 * own source, and this module turns those parts into numbers:
 *
 *   `copyPages` makes one PDFObjectCopier per call (api/PDFDocument.js:647) and
 *   copies each selected page's *node*, not its reference (:652). The copier
 *   (core/PDFObjectCopier.js:36-109):
 *     - moves Resources, MediaBox, CropBox and Rotate inherited from the page
 *       tree onto the copy, then deletes that copy's /Parent (:42-58);
 *     - clones every dictionary, array and stream it meets and follows every
 *       value in them — no key other than the page's own /Parent is skipped;
 *     - allocates one destination reference per distinct source reference, and
 *       dedupes by that reference (:97-109); a page leaf reached through a
 *       reference is copied as a page again (:36);
 *     - duplicates a raw stream's bytes (core/objects/PDFRawStream.js:17).
 *
 * `reachableGraph` walks the source the same way without cloning anything, so
 * what it counts is what the copier will create. That is a statement about this
 * pinned version, checked against a real copy by the gate rather than assumed.
 *
 * What it cannot count is what any of it weighs in a JavaScript heap. Object
 * counts and stream byte totals are EXACT; bytes per object are an engine
 * property and stay UNKNOWN.
 */
import { PDFArray, PDFDict, PDFName, PDFPageLeaf, PDFRawStream, PDFRef, PDFStream, PDFWriter } from 'pdf-lib';

const INHERITABLE = PDFPageLeaf.InheritableEntries.map((key) => PDFName.of(key));
const PARENT = PDFName.of('Parent');

/** Bytes a stream holds as it sits in the context. Raw streams only; see below. */
function heldStreamBytes(stream) {
    if (stream instanceof PDFRawStream) return { bytes: stream.contents.length, raw: true };
    // A PDFFlateStream or PDFContentStream computes its bytes on first request
    // and caches the result (core/structures/PDFFlateStream.js:13-28), so asking
    // would change what it holds. Such streams are counted, not sized.
    return { bytes: 0, raw: false };
}

/**
 * Everything `copyPages(doc, pageIndices)` would copy, in one pass.
 *
 * Returns EXACT structural counts:
 *   destinationObjects  indirect objects the copy registers: one per selected
 *                       page, plus one per distinct resolvable reference
 *   danglingReferences  references the copier will allocate a number for but
 *                       leave unassigned, because they resolve to nothing
 *   copierEntries       entries the copier's traversedObjects map will hold
 *   streams / streamBytes / maxStreamBytes
 *                       raw streams reached and the bytes each copy duplicates
 *   unsizedStreams      non-raw streams reached, whose size is not read
 *   pageLeavesReached   page leaves reached through a reference — copied as
 *                       pages, and outside the output page tree
 */
export function reachableGraph(doc, pageIndices) {
    const context = doc.context;
    const pages = doc.getPages();
    const refsSeen = new Set();
    const containersSeen = new Set();
    const out = {
        selectedPages: pageIndices.length,
        destinationObjects: 0,
        danglingReferences: 0,
        copierEntries: 0,
        streams: 0,
        streamBytes: 0,
        maxStreamBytes: 0,
        unsizedStreams: 0,
        pageLeavesReached: 0,
    };

    // An explicit stack rather than recursion: a two-hundred-deep chain must not
    // be the thing that decides whether the count finishes.
    const stack = [];

    const visitValue = (value) => {
        if (value instanceof PDFRef) {
            if (refsSeen.has(value)) return;
            refsSeen.add(value);
            out.copierEntries += 1;
            const target = context.lookup(value);
            if (target === undefined) {
                out.danglingReferences += 1;
                return;
            }
            out.destinationObjects += 1;
            if (target instanceof PDFPageLeaf) {
                out.pageLeavesReached += 1;
                stack.push({ page: target });
            } else {
                stack.push({ container: target });
            }
            return;
        }
        if (value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream) {
            stack.push({ container: value });
        }
    };

    /**
     * A page, as copyPDFPage prepares it: its own entries, plus any inheritable
     * entry it lacks taken from the nearest ancestor that has it, minus /Parent.
     * The copier keys the prepared clone, not the original, so a page is never
     * deduped against itself here either.
     */
    const visitPage = (leaf) => {
        out.copierEntries += 1;
        const entries = new Map(leaf.entries());
        for (const key of INHERITABLE) {
            if (!entries.has(key)) {
                const inherited = leaf.getInheritableAttribute(key);
                if (inherited !== undefined) entries.set(key, inherited);
            }
        }
        entries.delete(PARENT);
        for (const value of entries.values()) visitValue(value);
    };

    const visitContainer = (object) => {
        if (containersSeen.has(object)) return;
        containersSeen.add(object);
        if (object instanceof PDFPageLeaf) {
            // Reached directly rather than through a reference: copied as a page.
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
            const next = stack.pop();
            if (next.page) {
                if (next.root) visitPage(next.page);
                else visitContainer(next.page);
            } else {
                visitContainer(next.container);
            }
        }
    }
    return out;
}

/** The whole context, as it stands: EXACT counts of what is registered. */
export function contextTotals(doc) {
    let objects = 0;
    let streams = 0;
    let streamBytes = 0;
    let unsizedStreams = 0;
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
        objects += 1;
        if (object instanceof PDFStream) {
            const held = heldStreamBytes(object);
            if (held.raw) {
                streams += 1;
                streamBytes += held.bytes;
            } else {
                unsizedStreams += 1;
            }
        }
    }
    return { objects, streams, streamBytes, unsizedStreams, largestObjectNumber: doc.context.largestObjectNumber };
}

/**
 * The exact length `save({ useObjectStreams: false })` will allocate, asked
 * before it is allocated.
 *
 * PDFWriter computes the total size and only then allocates a Uint8Array of that
 * size (core/writers/PDFWriter.js:27-31). Calling the same computation first
 * gives the number without the buffer. It is not free: sizing a Flate or content
 * stream compresses it and caches the result (core/structures/PDFFlateStream.js:
 * 13-28), which save would do anyway, and sizing sets each stream's /Length.
 *
 * It answers only for the plain writer. With object streams — pdf-lib's default,
 * and what production uses — the size is known only after each chunk has been
 * deflated (core/writers/PDFStreamWriter.js:73-100), so there is no equivalent
 * question to ask before compressing.
 */
export async function predictPlainSaveBytes(doc) {
    await doc.flush();
    const { size } = await PDFWriter.forContext(doc.context, Infinity).computeBufferSize();
    return size;
}
