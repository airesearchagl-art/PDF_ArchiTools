/**
 * Internal destinations: E1 and E2. Adopted M6-H5.
 *
 * The measured reason this module exists. `copyPages` does not merely fail to
 * retarget a destination — it **copies the page the destination points at**.
 * The copier dispatches on type with no branch for what a referent is
 * (`core/PDFObjectCopier.js:36-41`), so a link's `/Dest [ 12 0 R /XYZ ... ]` is
 * an array holding a reference, the reference is dereferenced, the referent is a
 * `PDFPageLeaf`, and the first rung of the ladder copies the whole page. That
 * copy is registered but never inserted into `/Pages`
 * (`api/PDFDocument.js:611`), so it is an orphan: invisible to a reader,
 * present in the bytes.
 *
 * It happens **even when the target page is selected**. `copyPDFPage` clones the
 * leaf before memoising it (`:43`, `:64`), so a page reached both as an argument
 * and through a reference is copied twice, and the destination is remapped onto
 * the copy that never enters the tree. A link that resolves and navigates
 * nowhere is the worst of the outcomes, because nothing reports it.
 *
 * So the order is the whole trick, and step 1 is not an optimisation:
 *
 *   1. strip every internal destination from the pages being copied —
 *      **including the ones whose target is kept**, because leaving them is what
 *      makes the copier drag a duplicate in;
 *   2. copy;
 *   3. rebuild what is still meaningful, from the output's own page references;
 *   4. report what was dropped, by name.
 *
 * And `/Annots` is not the only way out of a page. An article bead in `/B`
 * chains through `/N` to a bead whose `/P` is a different page, so a page with
 * no link annotations at all can still drag one in. A contract that enumerated
 * annotations would have been wrong and would have looked right.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { LossRecord } from './contracts';
import { MECHANISM_BOUNDS } from './policy';
import { comparePdfBytes, pdfTextObject, readNameIdentifier, readPdfText } from './pdf-text';
import type { PdfRead, PdfText } from './pdf-text';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/**
 * A destination's identity, from a string or a name object. BLK-R4-1.
 *
 * A link names its destination with a string (a name-tree key) or with a name
 * object (a catalog `/Dests` key). Both are matched by the text a reader shows
 * for them — PDF.js resolves either kind against either store that way — and a
 * string whose text cannot be read, or a name whose text depends on the reader,
 * is a destination that cannot be identified: a refusal, not a link to nothing.
 */
function readDestinationName(value: unknown): PdfRead<PdfText> {
    if (value instanceof PDFName) return readNameIdentifier(value);
    return readPdfText(value);
}

function look(doc: PDFDocument, value: unknown): unknown {
    try {
        if (value instanceof PDFRef) return doc.context.lookup(value);
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Resolve, keeping "not there" apart from "there and unreadable".
 *
 * {@link look} answers `undefined` for a dangling reference and for a key that
 * was never written, and a reader that cannot tell those apart reports a
 * missing object as an absent one. Every branch that decides whether a
 * destination exists uses this instead.
 */
type Resolved = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Whether a slot is empty.
 *
 * `null` is not a malformed value in a PDF: the specification says a null
 * object is equivalent to an absent one, so a producer that leaves a hole in
 * `/Annots` or `/Kids` writes `null` into it. Refusing those would refuse
 * ordinary documents for being ordinary — the point of the refusals below is
 * structures that are *there* and cannot be read.
 */
const isEmptySlot = (value: unknown): boolean => value === undefined || value === PDFNull;

function resolve(doc: PDFDocument, raw: unknown): Resolved {
    if (!(raw instanceof PDFRef)) return { ok: true, value: raw };
    let value: unknown;
    try {
        value = doc.context.lookup(raw);
    } catch (error) {
        return { ok: false, reason: `could not be read: ${String((error as Error)?.message ?? error)}` };
    }
    if (value === undefined) {
        return { ok: false, reason: `points at ${raw.tag}, which is not in the document` };
    }
    return { ok: true, value };
}

/**
 * The destination array behind a named destination's value.
 *
 * Two forms are standard and both are in the field: the array itself, and a
 * dictionary wrapping it under `/D`. Only the array shape is reproduced, so the
 * wrapper is unwrapped rather than supported as a shape of its own — and a
 * wrapper whose `/D` is missing or is not an array is `null`, which the caller
 * turns into a refusal. It is never silently skipped.
 */
function destinationArrayOf(doc: PDFDocument, value: unknown): PDFArray | null {
    if (value instanceof PDFArray) return value;
    if (value instanceof PDFDict) {
        const inner = value.get(PDFName.of('D'));
        if (inner === undefined) return null;
        const read = resolve(doc, inner);
        if (!read.ok || !(read.value instanceof PDFArray)) return null;
        return read.value;
    }
    return null;
}

/**
 * Where a page can reach another page from.
 *
 * `/Annots` is handled by the destination walk below. `/B` is the route the
 * `page-refs-beyond-annots` measurement found, and it is removed wholesale
 * rather than reconstructed: rebuilding an article thread across a subset of its
 * pages is a different feature, not a silent side effect of extracting.
 */
const NON_ANNOT_PAGE_REFERENCE_KEYS = ['B'] as const;

/**
 * A destination's parameters, as plain values.
 *
 * H11-EXTRACT-4 requires the source to be released before `save`, and a
 * rebuild record that held the source's own `PDFName` and `PDFNumber` objects
 * kept the source context alive through the whole save — the release was a
 * variable assignment with a live object graph behind it. So the tail is
 * described rather than carried: a name becomes a string, a number becomes a
 * number, and the output's objects are built from those.
 */
export type DestParam =
    | { kind: 'name'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'null' };

const describeParam = (value: unknown): DestParam => {
    const asString = (value as { asString?: () => string } | null)?.asString;
    if (typeof asString === 'function') {
        return { kind: 'name', value: asString.call(value).replace(/^\//, '') };
    }
    const asNumber = (value as { asNumber?: () => number } | null)?.asNumber;
    if (typeof asNumber === 'function') return { kind: 'number', value: asNumber.call(value) };
    if (typeof value === 'number') return { kind: 'number', value };
    return { kind: 'null' };
};

const describeTail = (values: unknown[]): DestParam[] => values.map(describeParam);

const materializeTail = (out: PDFDocument, tail: DestParam[]): unknown[] => tail.map((t) => {
    if (t.kind === 'name') return PDFName.of(t.value);
    if (t.kind === 'number') return out.context.obj(t.value as never);
    return out.context.obj(null as never);
});

type LinkKind = 'explicit' | 'named';

interface FoundLink {
    fromIndex: number;
    annotIndex: number;
    annotRef: PDFRef | null;
    /** The dictionary the destination key lives on: the annotation or its action. */
    holder: PDFDict;
    /** `Dest` on an annotation, or `D` on a `/GoTo` action. */
    key: 'Dest' | 'D';
    kind: LinkKind;
    targetIndex: number | null;
    /** The destination array's tail — the zoom or fit parameters. */
    tail: unknown[];
    name?: string;
}

interface NamedDestination {
    /** The text a reader shows for the key: the destination's identity. */
    name: string;
    /** The key as bytes and token, so it is written back as what it was. */
    key: PdfText;
    targetIndex: number | null;
    tail: unknown[];
}

export interface DestinationPlan {
    pageCount: number;
    selection: number[];
    links: FoundLink[];
    named: NamedDestination[];
    /** Page reference sites that are not annotations, per page. */
    otherSites: { fromIndex: number; key: string }[];
    /** How many links would break under E1. */
    wouldBreak: number;
    /**
     * Destination structures that are present and could not be read.
     *
     * A refusal, not an absence. Empty means every destination in this document
     * was understood — which is the only state in which the lists above are a
     * complete description of it.
     */
    unreadable: string[];
    /**
     * Destination names defined more than once. RF-R4-3.
     *
     * A refusal too: which definition a reader follows is up to the reader, and
     * no adopted policy picks one.
     */
    duplicateNames: string[];
}

/** Every destination on a page, with enough context to remove or rebuild it. */
function destinationsOnPage(
    doc: PDFDocument,
    pageIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    unreadable: string[],
): FoundLink[] {
    const found: FoundLink[] = [];
    const page = doc.getPages()[pageIndex];
    const annotsRaw = page.node.get(PDFName.of('Annots'));
    if (isEmptySlot(annotsRaw)) return found;
    const annotsRead = resolve(doc, annotsRaw);
    if (!annotsRead.ok) {
        unreadable.push(`page ${pageIndex} /Annots ${annotsRead.reason}`);
        return found;
    }
    const annots = annotsRead.value;
    if (!(annots instanceof PDFArray)) {
        unreadable.push(`page ${pageIndex} /Annots is not an array`);
        return found;
    }

    for (let i = 0; i < annots.size(); i += 1) {
        const annotRaw = annots.get(i);
        if (isEmptySlot(annotRaw)) continue;
        const annotRead = resolve(doc, annotRaw);
        if (!annotRead.ok) {
            unreadable.push(`page ${pageIndex} /Annots[${i}] ${annotRead.reason}`);
            continue;
        }
        const annot = annotRead.value;
        if (isEmptySlot(annot)) continue;
        if (!(annot instanceof PDFDict)) {
            unreadable.push(`page ${pageIndex} /Annots[${i}] is not a dictionary`);
            continue;
        }

        const record = (holder: PDFDict, key: 'Dest' | 'D', raw: unknown): void => {
            const dest = look(doc, raw);
            if (dest instanceof PDFArray) {
                const first = dest.get(0);
                const tail: unknown[] = [];
                for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
                found.push({
                    fromIndex: pageIndex,
                    annotIndex: i,
                    annotRef: annotRaw instanceof PDFRef ? annotRaw : null,
                    holder,
                    key,
                    kind: 'explicit',
                    targetIndex: first instanceof PDFRef ? pageIndexOf(first) : null,
                    tail,
                });
            } else if (dest !== undefined) {
                // A name reference: a string, or a name object. Anything else
                // is a destination that is present and cannot be read, which
                // is a refusal rather than a link with an empty name.
                const isNameShaped = dest instanceof PDFName
                    || dest instanceof PDFString
                    || dest instanceof PDFHexString;
                if (!isNameShaped) {
                    unreadable.push(
                        `page ${pageIndex} /Annots[${i}] /${key} is neither a destination `
                        + 'array nor a name',
                    );
                    return;
                }
                const named = readDestinationName(dest);
                if (!named.ok) {
                    unreadable.push(`page ${pageIndex} /Annots[${i}] /${key} ${named.reason}`);
                    return;
                }
                found.push({
                    fromIndex: pageIndex,
                    annotIndex: i,
                    annotRef: annotRaw instanceof PDFRef ? annotRaw : null,
                    holder,
                    key,
                    kind: 'named',
                    targetIndex: null,
                    tail: [],
                    name: named.value.text,
                });
            }
        };

        if (annot.get(PDFName.of('Dest')) !== undefined) {
            record(annot, 'Dest', annot.get(PDFName.of('Dest')));
        }
        const action = look(doc, annot.get(PDFName.of('A')));
        if (action instanceof PDFDict && nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
            record(action, 'D', action.get(PDFName.of('D')));
        }
    }
    return found;
}

/**
 * What a named-destination read can end as. RF-R3-5.
 *
 * The semantic-reader form of the adopted census clarification: COMPLETE with
 * the entries, or REFUSED with a reason. There is no third state in which the
 * tree was not understood and the answer is an empty list.
 *
 * The reader this replaces handled exactly one shape — a flat `/Names` array
 * whose values were arrays — and answered `[]` for everything else. Measured:
 * a `/Kids` name tree, which is how any document with more than a handful of
 * names is written, and a `<< /D [...] >>` destination dictionary both
 * vanished from the output with the target page still in the selection, no
 * loss recorded and the operation READY.
 */
export type NamedDestinationRead =
    | { complete: true; entries: NamedDestination[] }
    | { complete: false; reason: string; duplicates?: string[] };

/**
 * Named destinations, resolved to page indices, from every place PDF keeps them.
 *
 * Two stores, one model. `/Names /Dests` is a name tree keyed by strings; the
 * catalog's own `/Dests` is the older dictionary keyed by names (RF-R4-2). A
 * reader that looked at the first only answered "none" for a document written
 * the second way, and the names were gone from the output with nothing said.
 * Both are read here into the same descriptor, and nothing downstream knows
 * which store an entry came from — there is one preservation path, not two.
 *
 * The name tree is bounded by {@link MECHANISM_BOUNDS} in depth and in nodes,
 * cycle-aware by reference tag. Reaching a bound, meeting a malformed node, a
 * key whose text cannot be read, or a destination shape this reader does not
 * reproduce is a refusal — the structure is there, so "no named destinations"
 * would be false.
 *
 * And a name is one destination (RF-R4-3). Two definitions with the same text
 * — in one leaf or two, in either store, spelt in different encodings — leave
 * the target up to whichever the reader meets first, and no adopted policy says
 * which should win. Duplicates are found here, before anything is rebuilt, and
 * the read refuses rather than keeping the first, keeping the last, writing both
 * or renaming one.
 */
function namedDestinations(
    doc: PDFDocument,
    pageIndexOf: (ref: PDFRef) => number | null,
): NamedDestinationRead {
    const treeRead = namedDestinationsInTree(doc, pageIndexOf);
    if (!treeRead.complete) return treeRead;
    const legacyRead = namedDestinationsInCatalog(doc, pageIndexOf);
    if (!legacyRead.complete) return legacyRead;
    const entries = [...treeRead.entries, ...legacyRead.entries];

    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (duplicates.length > 0) {
        return {
            complete: false,
            reason: `named destination(s) defined more than once: ${duplicates.join(', ')}`,
            duplicates,
        };
    }
    return { complete: true, entries };
}

/** One destination value: the target page and the tail, or why it cannot be read. */
function readNamedValue(
    doc: PDFDocument,
    raw: unknown,
    pageIndexOf: (ref: PDFRef) => number | null,
): PdfRead<{ targetIndex: number | null; tail: unknown[] }> {
    const valueRead = resolve(doc, raw);
    if (!valueRead.ok) return { ok: false, reason: valueRead.reason };
    const dest = destinationArrayOf(doc, valueRead.value);
    if (dest === null) return { ok: false, reason: 'is not a destination this reader reproduces' };
    const first = dest.get(0);
    const tail: unknown[] = [];
    for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
    return {
        ok: true,
        value: { targetIndex: first instanceof PDFRef ? pageIndexOf(first) : null, tail },
    };
}

/**
 * The catalog's `/Dests` dictionary. RF-R4-2.
 *
 * The PDF 1.1 form: keys are names, values are the same two destination shapes
 * the name tree holds. A key is a name, so its text is only read where readers
 * agree on it — see {@link readNameIdentifier}; one that cannot be normalised
 * refuses the read.
 */
function namedDestinationsInCatalog(
    doc: PDFDocument,
    pageIndexOf: (ref: PDFRef) => number | null,
): NamedDestinationRead {
    const entries: NamedDestination[] = [];
    const destsRaw = doc.catalog.get(PDFName.of('Dests'));
    if (isEmptySlot(destsRaw)) return { complete: true, entries };
    const destsRead = resolve(doc, destsRaw);
    if (!destsRead.ok) return { complete: false, reason: `catalog /Dests ${destsRead.reason}` };
    if (!(destsRead.value instanceof PDFDict)) {
        return { complete: false, reason: 'catalog /Dests is not a dictionary' };
    }
    const dict = destsRead.value;
    if (dict.entries().length > MECHANISM_BOUNDS.maxNameTreeNodes) {
        return {
            complete: false,
            reason: `catalog /Dests holds more than ${MECHANISM_BOUNDS.maxNameTreeNodes} entries`,
        };
    }
    for (const [key, raw] of dict.entries()) {
        const where = `catalog /Dests ${key.asString()}`;
        const name = readNameIdentifier(key);
        if (!name.ok) return { complete: false, reason: `${where} ${name.reason}` };
        const value = readNamedValue(doc, raw, pageIndexOf);
        if (!value.ok) return { complete: false, reason: `${where} ${value.reason}` };
        entries.push({ name: name.value.text, key: name.value, ...value.value });
    }
    return { complete: true, entries };
}

/** The `/Names /Dests` name tree, read through every leaf. */
function namedDestinationsInTree(
    doc: PDFDocument,
    pageIndexOf: (ref: PDFRef) => number | null,
): NamedDestinationRead {
    const entries: NamedDestination[] = [];

    const namesRaw = doc.catalog.get(PDFName.of('Names'));
    if (isEmptySlot(namesRaw)) return { complete: true, entries };
    const namesRead = resolve(doc, namesRaw);
    if (!namesRead.ok) return { complete: false, reason: `catalog /Names ${namesRead.reason}` };
    if (!(namesRead.value instanceof PDFDict)) {
        return { complete: false, reason: 'catalog /Names is not a dictionary' };
    }

    const destsRaw = namesRead.value.get(PDFName.of('Dests'));
    if (isEmptySlot(destsRaw)) return { complete: true, entries };

    const seen = new Set<string>();
    let nodes = 0;

    /** Walk one name-tree node. Returns a refusal reason, or null. */
    const walk = (raw: unknown, depth: number, where: string): string | null => {
        if (depth > MECHANISM_BOUNDS.maxNameTreeDepth) {
            return `${where} is nested deeper than ${MECHANISM_BOUNDS.maxNameTreeDepth}`;
        }
        nodes += 1;
        if (nodes > MECHANISM_BOUNDS.maxNameTreeNodes) {
            return `the name tree holds more than ${MECHANISM_BOUNDS.maxNameTreeNodes} nodes`;
        }
        if (raw instanceof PDFRef) {
            if (seen.has(raw.tag)) return `${where} is reached twice: the name tree cycles`;
            seen.add(raw.tag);
        }
        const node = resolve(doc, raw);
        if (!node.ok) return `${where} ${node.reason}`;
        if (!(node.value instanceof PDFDict)) return `${where} is not a dictionary`;
        const dict = node.value;

        const leafRaw = isEmptySlot(dict.get(PDFName.of('Names')))
            ? undefined
            : dict.get(PDFName.of('Names'));
        const kidsRaw = isEmptySlot(dict.get(PDFName.of('Kids')))
            ? undefined
            : dict.get(PDFName.of('Kids'));
        if (leafRaw === undefined && kidsRaw === undefined) {
            return `${where} has neither /Names nor /Kids`;
        }

        if (leafRaw !== undefined) {
            const leaf = resolve(doc, leafRaw);
            if (!leaf.ok) return `${where} /Names ${leaf.reason}`;
            if (!(leaf.value instanceof PDFArray)) return `${where} /Names is not an array`;
            const list = leaf.value;
            if (list.size() % 2 !== 0) {
                return `${where} /Names holds ${list.size()} entries, which is not name/value pairs`;
            }
            for (let i = 0; i + 1 < list.size(); i += 2) {
                const keyRead = resolve(doc, list.get(i));
                if (!keyRead.ok) return `${where} /Names[${i}] ${keyRead.reason}`;
                // BLK-R4-1: the key is read as the bytes a reader compares and
                // the text it shows, and kept as the token it was written as.
                // A key that is not a string, or whose text cannot be read, is
                // a key nobody can look up the same way twice.
                const key = readPdfText(keyRead.value);
                if (!key.ok) return `${where} /Names[${i}] ${key.reason}`;
                const name = key.value.text;
                const value = readNamedValue(doc, list.get(i + 1), pageIndexOf);
                if (!value.ok) return `${where} /Names (${name}) ${value.reason}`;
                entries.push({ name, key: key.value, ...value.value });
            }
        }

        if (kidsRaw !== undefined) {
            const kids = resolve(doc, kidsRaw);
            if (!kids.ok) return `${where} /Kids ${kids.reason}`;
            if (!(kids.value instanceof PDFArray)) return `${where} /Kids is not an array`;
            for (let i = 0; i < kids.value.size(); i += 1) {
                const kid = kids.value.get(i);
                if (isEmptySlot(kid)) continue;
                const reason = walk(kid, depth + 1, `${where} /Kids[${i}]`);
                if (reason !== null) return reason;
            }
        }

        return null;
    };

    const reason = walk(destsRaw, 0, '/Names /Dests');
    if (reason !== null) return { complete: false, reason };
    return { complete: true, entries };
}

/**
 * Plan, on the source, before anything is copied.
 *
 * This is the only moment the answer is knowable without having already done the
 * damage: `copyPages` flushes the source, and the copy is what creates the
 * orphans.
 */
export function planDestinations(doc: PDFDocument, selection: number[]): DestinationPlan {
    const pages = doc.getPages();
    const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
    const pageIndexOf = (ref: PDFRef): number | null => byTag.get(ref.tag) ?? null;
    const kept = new Set(selection);

    const unreadable: string[] = [];
    const links: FoundLink[] = [];
    for (const index of selection) {
        if (!pages[index]) continue;
        links.push(...destinationsOnPage(doc, index, pageIndexOf, unreadable));
    }

    // RF-R3-5: COMPLETE or REFUSED. A tree that could not be walked is carried
    // as a refusal rather than collapsing into "this document has none". A
    // duplicate is its own refusal, so it can be named for what it is.
    const read = namedDestinations(doc, pageIndexOf);
    const named = read.complete ? read.entries : [];
    const duplicateNames = !read.complete && read.duplicates ? read.duplicates : [];
    if (!read.complete && duplicateNames.length === 0) unreadable.push(read.reason);
    const namedByName = new Map(named.map((n) => [n.name, n]));

    const otherSites: { fromIndex: number; key: string }[] = [];
    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;
        for (const key of NON_ANNOT_PAGE_REFERENCE_KEYS) {
            if (page.node.get(PDFName.of(key)) !== undefined) {
                otherSites.push({ fromIndex: index, key });
            }
        }
    }

    const breaks = links.filter((l) => {
        if (l.kind === 'explicit') return l.targetIndex === null || !kept.has(l.targetIndex);
        const entry = l.name !== undefined ? namedByName.get(l.name) : undefined;
        return !entry || entry.targetIndex === null || !kept.has(entry.targetIndex);
    });

    return {
        pageCount: pages.length,
        selection,
        links,
        named,
        otherSites,
        wouldBreak: breaks.length,
        unreadable,
        duplicateNames,
    };
}

/** What has to be put back after the copy, and where. */
export interface DestinationRebuild {
    /** The page in the output's own numbering. Merge shifts this. */
    fromIndex: number;
    /**
     * The same page in the source document, never shifted. RF-R5-1.
     *
     * The annotation is looked up in the source at reconstruction time, so the
     * lookup needs the page it actually sits on rather than where its copy
     * landed.
     */
    sourcePageIndex: number;
    /**
     * The annotation, by reference: identity that survives a removal. RF-R5-1.
     *
     * A `PDFRef` is an object number and a generation, so holding one keeps
     * nothing of the source alive (RF-E).
     */
    annotRef: PDFRef | null;
    /** Where it sat when the plan was made. Kept only to name it in a message. */
    annotIndex: number;
    holderIsAction: boolean;
    targetIndex: number;
    /** Plain values, so nothing here keeps the source document alive. */
    tail: DestParam[];
}

/** A named destination that survived, described in plain values. */
export interface SurvivingName {
    /** Its identity: the text a reader shows for the key. */
    name: string;
    /**
     * Its key as bytes and token — plain values, no source object — so it is
     * written back as the key it was and sorted by the bytes readers compare.
     */
    key: PdfText;
    targetIndex: number;
    tail: DestParam[];
}

export interface StripOutcome {
    rebuild: DestinationRebuild[];
    /** Named destinations whose target survived, to be written to the output. */
    survivingNames: SurvivingName[];
    losses: LossRecord[];
    /** Destination structures present and unreadable. A refusal, not an absence. */
    unreadable: string[];
    /** Names defined more than once. A refusal. RF-R4-3. */
    duplicateNames: string[];
}

/**
 * Strip every internal destination from the pages being copied, on a working
 * copy of the source.
 *
 * Including the ones whose target is kept. That is the step that removes the
 * reference the copier would otherwise follow into another page, and it is why
 * the artifact ends up with `orphanPageCount === 0` instead of one or two page
 * objects nobody asked for.
 */
export function stripInternalDestinations(
    doc: PDFDocument,
    plan: DestinationPlan,
    selection: number[],
): StripOutcome {
    const kept = new Set(selection);
    const rebuild: DestinationRebuild[] = [];
    const losses: LossRecord[] = [];
    const namedByName = new Map(plan.named.map((n) => [n.name, n]));

    for (const link of plan.links) {
        if (link.kind === 'named') {
            const entry = link.name !== undefined ? namedByName.get(link.name) : undefined;
            if (entry && entry.targetIndex !== null && kept.has(entry.targetIndex)) {
                rebuild.push({
                    fromIndex: link.fromIndex,
                    sourcePageIndex: link.fromIndex,
                    annotRef: link.annotRef,
                    annotIndex: link.annotIndex,
                    holderIsAction: link.key === 'D',
                    targetIndex: entry.targetIndex,
                    tail: describeTail(entry.tail),
                });
            } else {
                losses.push({
                    kind: 'internal-links',
                    fromIndex: link.fromIndex,
                    what: link.name,
                    why: entry
                        ? 'ジャンプ先のページが選択されていません。'
                        : 'この名前のジャンプ先が文書内に見つかりません。',
                });
            }
            link.holder.delete(PDFName.of(link.key));
            continue;
        }

        if (link.targetIndex !== null && kept.has(link.targetIndex)) {
            rebuild.push({
                fromIndex: link.fromIndex,
                sourcePageIndex: link.fromIndex,
                annotRef: link.annotRef,
                annotIndex: link.annotIndex,
                holderIsAction: link.key === 'D',
                targetIndex: link.targetIndex,
                tail: describeTail(link.tail),
            });
        } else {
            losses.push({
                kind: 'internal-links',
                fromIndex: link.fromIndex,
                what: link.targetIndex === null ? undefined : `p.${link.targetIndex + 1}`,
                why: link.targetIndex === null
                    ? 'リンク先がページとして解決できませんでした。'
                    : 'リンク先のページが選択されていません。',
            });
        }
        link.holder.delete(PDFName.of(link.key));
    }

    // Page reference sites that are not annotations: removed wholesale, and
    // reported by name.
    for (const site of plan.otherSites) {
        const page = doc.getPages()[site.fromIndex];
        page.node.delete(PDFName.of(site.key));
        losses.push({
            kind: 'article-threads',
            fromIndex: site.fromIndex,
            what: `/${site.key}`,
            why: '選択したページだけでは記事スレッドを再構成できません。',
        });
    }

    const survivingNames: SurvivingName[] = plan.named
        .filter((n) => n.targetIndex !== null && kept.has(n.targetIndex))
        .map((n) => ({
            name: n.name,
            key: n.key,
            targetIndex: n.targetIndex as number,
            tail: describeTail(n.tail),
        }));
    for (const n of plan.named) {
        if (n.targetIndex === null || !kept.has(n.targetIndex)) {
            losses.push({
                kind: 'named-destinations',
                what: n.name,
                why: 'ジャンプ先のページが選択されていません。',
            });
        }
    }

    return {
        rebuild,
        survivingNames,
        losses,
        unreadable: plan.unreadable,
        duplicateNames: plan.duplicateNames,
    };
}

// ---------------------------------------------------------------------------
// Annotation identity. RF-R5-1.
// ---------------------------------------------------------------------------

/**
 * Give every annotation on a page a reference of its own. RF-R5-1.
 *
 * A reconstruction plan has to name one annotation and still mean the same one
 * later. A position in `/Annots` cannot do that: `removeSignatureWidgets`
 * (M6-H1) and `removeAttachmentsEverywhere` (M6-H2) both take entries out of
 * that array between the plan and the copy, and every later entry moves.
 * Measured: a signature widget carrying an ordinary `/P` made Extract rebuild
 * `/Annots[0]` after `/Annots[0]` had been removed, and the run refused a
 * document it supports.
 *
 * A reference is identity. An annotation written *directly* into the array has
 * none to hold, so it is registered as an indirect object here — the same
 * dictionary, given a name. PDF lets an annotation be either, and every reader
 * resolves both, so this changes the document's representation and not what it
 * says; it is also what lets the rest of this module drop the special case
 * entirely rather than carry a second, weaker identity strategy.
 *
 * Runs on the working copy, before any plan is made and before anything is
 * removed. Shapes this does not understand are left exactly as they are and
 * reported by the readers that already report them.
 */
export function nameAnnotationsByReference(doc: PDFDocument, selection: number[]): void {
    const pages = doc.getPages();
    for (const pageIndex of selection) {
        const page = pages[pageIndex];
        if (!page) continue;
        const read = resolve(doc, page.node.get(PDFName.of('Annots')));
        if (!read.ok || !(read.value instanceof PDFArray)) continue;
        const annots = read.value;
        for (let i = 0; i < annots.size(); i += 1) {
            const entry = annots.get(i);
            if (entry instanceof PDFRef || isEmptySlot(entry)) continue;
            if (!(entry instanceof PDFDict)) continue;
            annots.set(i, doc.context.register(entry));
        }
    }
}

/** Where an annotation named by reference sits in its page's `/Annots` now. */
type AnnotSite =
    | { kind: 'at'; index: number }
    | { kind: 'gone' }
    | { kind: 'unresolved'; reason: string };

const annotsOf = (doc: PDFDocument, pageIndex: number): PDFArray | null | 'unreadable' => {
    const page = doc.getPages()[pageIndex];
    if (!page) return 'unreadable';
    const read = resolve(doc, page.node.get(PDFName.of('Annots')));
    if (!read.ok) return 'unreadable';
    if (isEmptySlot(read.value)) return null;
    return read.value instanceof PDFArray ? read.value : 'unreadable';
};

/**
 * Find the annotation the plan named, in the source, as it is now.
 *
 * `gone` is the annotation this run deliberately removed — a signature widget
 * or a file-attachment annotation. It was not copied, so there is nothing in
 * the output to reconstruct, and its removal is already a loss the plan
 * reports. `unresolved` is everything else, and refuses.
 */
function locateAnnot(doc: PDFDocument, pageIndex: number, ref: PDFRef | null): AnnotSite {
    if (ref === null) return { kind: 'unresolved', reason: 'the annotation has no reference to name it by' };
    const annots = annotsOf(doc, pageIndex);
    if (annots === 'unreadable') return { kind: 'unresolved', reason: 'the source page /Annots cannot be read' };
    if (annots === null) return { kind: 'gone' };
    for (let i = 0; i < annots.size(); i += 1) {
        const entry = annots.get(i);
        if (entry instanceof PDFRef && entry.tag === ref.tag) return { kind: 'at', index: i };
    }
    return { kind: 'gone' };
}

/**
 * The copied annotation the plan is about, proved rather than assumed.
 *
 * `copyPages` reproduces `/Annots` entry for entry, so position `i` in the
 * source is position `i` in the copy — but only while the two arrays are the
 * same length, which is checked here rather than trusted, and only while the
 * annotation at that position is the same kind of thing, which is checked too.
 */
function copiedAnnot(
    source: PDFDocument,
    sourcePageIndex: number,
    outAnnots: PDFArray,
    out: PDFDocument,
    ref: PDFRef | null,
): { ok: true; annot: PDFDict } | { ok: false; gone: boolean; reason: string } {
    const site = locateAnnot(source, sourcePageIndex, ref);
    if (site.kind === 'gone') {
        return { ok: false, gone: true, reason: 'the annotation was removed before the copy' };
    }
    if (site.kind === 'unresolved') return { ok: false, gone: false, reason: site.reason };
    const sourceAnnots = annotsOf(source, sourcePageIndex);
    if (!(sourceAnnots instanceof PDFArray) || sourceAnnots.size() !== outAnnots.size()) {
        return { ok: false, gone: false, reason: 'the copied /Annots does not match the source' };
    }
    const annot = out.context.lookup(outAnnots.get(site.index));
    if (!(annot instanceof PDFDict)) {
        return { ok: false, gone: false, reason: 'the copied annotation is not there' };
    }
    const sourceAnnot = source.context.lookup(sourceAnnots.get(site.index));
    if (sourceAnnot instanceof PDFDict
        && nameOf(sourceAnnot.get(PDFName.of('Subtype'))) !== nameOf(annot.get(PDFName.of('Subtype')))) {
        return { ok: false, gone: false, reason: 'the copied annotation is a different one' };
    }
    return { ok: true, annot };
}

/**
 * What a reconstruction managed, and what it planned and could not do.
 *
 * `unapplied` is empty on every document this contract handles: each entry was
 * planned against a page that is in the selection and an annotation that was
 * named by reference on it. It exists because the alternative is the shape this
 * milestone keeps finding — a `continue` that abandons a planned rebuild and
 * returns a count that looks like success.
 */
export interface RebuildOutcome {
    rebuilt: number;
    unapplied: string[];
    /**
     * Plans whose annotation this run removed before the copy. RF-R5-1.
     *
     * Not a failure: the annotation is not in the output because it was taken
     * out on purpose, and that removal is reported as its own loss. Carried so
     * the skip is visible rather than silent.
     */
    removed: string[];
}

/**
 * Put the destinations back, pointing at the output's own page references.
 *
 * The copied annotation is found by the **reference** the plan named it with,
 * resolved against the source as it is now (RF-R5-1). `copyPages` preserves the
 * order of `/Annots`, so the annotation's position in the source is its position
 * in the copy — but the position it had when the plan was made is not, because
 * sanitization takes other entries out of that array in between.
 */
export function rebuildDestinations(
    out: PDFDocument,
    outcome: StripOutcome,
    selection: number[],
    source: PDFDocument | null = null,
): RebuildOutcome {
    const outPages = out.getPages();
    const unapplied: string[] = [];
    const removed: string[] = [];
    const outRefOf = (sourceIndex: number): PDFRef | null => {
        const position = selection.indexOf(sourceIndex);
        return position >= 0 && outPages[position] ? outPages[position].ref : null;
    };

    let rebuilt = 0;

    for (const item of outcome.rebuild) {
        const where = `page ${item.fromIndex} /Annots[${item.annotIndex}]`;
        const position = selection.indexOf(item.fromIndex);
        const outPage = outPages[position];
        if (!outPage) {
            unapplied.push(`${where}: the page it belongs to is not in the output`);
            continue;
        }
        const annots = outPage.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) {
            unapplied.push(`${where}: the copied page has no /Annots array`);
            continue;
        }
        if (source === null) {
            unapplied.push(`${where}: the source is not available to name the annotation`);
            continue;
        }
        // RF-R5-1: by reference, not by the position it had when planned.
        const found = copiedAnnot(source, item.sourcePageIndex, annots, out, item.annotRef);
        if (!found.ok) {
            (found.gone ? removed : unapplied).push(`${where}: ${found.reason}`);
            continue;
        }
        const annot = found.annot;

        const target = outRefOf(item.targetIndex);
        if (!target) {
            unapplied.push(`${where}: its target page is not in the output`);
            continue;
        }

        const dest = out.context.obj([target, ...materializeTail(out, item.tail)] as never[]);
        if (item.holderIsAction) {
            annot.set(
                PDFName.of('A'),
                out.context.obj({ Type: 'Action', S: 'GoTo', D: dest } as never),
            );
        } else {
            annot.set(PDFName.of('Dest'), dest);
        }
        rebuilt += 1;
    }

    // Named destinations whose target survived. M6-H6 adopted reconstructing
    // these and deferred outlines and page labels. Whichever store a name came
    // from, it is written into the name tree: a catalog `/Dests` key becomes a
    // string key with the same bytes, which is where the name tree is looked up.
    if (outcome.survivingNames.length > 0) {
        const flat: unknown[] = [];
        // Sorted by the key's BYTES: a name tree's `/Names` array is required to
        // be, and a reader binary-searches it comparing bytes. Sorting by the
        // decoded text put a UTF-16 key where its spelling belongs rather than
        // where its bytes do, and the lookup for it looked in the wrong place.
        // The entries arrive from a whole tree and from the catalog, so the
        // order they were met in is not the order they belong in either.
        const ordered = [...outcome.survivingNames]
            .sort((a, b) => comparePdfBytes(a.key.bytes, b.key.bytes));
        for (const n of ordered) {
            if (n.targetIndex === null) {
                unapplied.push(`named destination ${n.name}: it resolved to no page`);
                continue;
            }
            const target = outRefOf(n.targetIndex);
            if (!target) {
                unapplied.push(`named destination ${n.name}: its target is not in the output`);
                continue;
            }
            flat.push(
                // BLK-R4-1: the key as it was written, never the decoded text
                // put through `PDFString.of`, which dropped every high byte and
                // escaped no delimiter.
                pdfTextObject(n.key),
                out.context.obj([target, ...materializeTail(out, n.tail)] as never[]),
            );
        }
        if (flat.length > 0) {
            out.catalog.set(
                PDFName.of('Names'),
                out.context.register(out.context.obj({ Dests: { Names: flat } } as never)),
            );
        }
    }

    return { rebuilt, unapplied, removed };
}

/**
 * Every place a page reference can hide, walked before the copy. M6-H5A.
 *
 * `/Dest` was never the only route, and the Independent Review found the rest:
 * an annotation's own `/P` back-pointer, an `/AA` on an annotation, a widget or
 * a page, and a `/GoTo` reached through a recursive `/Next` chain. Each carries
 * a reference to a page of the **source**, and a source-page reference in an
 * output document means nothing a reader can follow — while the copier, which
 * has no branch for what a reference points at, will happily drag the whole page
 * in behind it.
 *
 * So the rule is uniform: a source-page reference is stripped before the graph
 * is counted, and rebuilt afterwards only against output page references. What
 * cannot be rebuilt is reported; what cannot be understood is refused.
 */
const ACTION_CHAIN_BOUND = 32;

interface PageRefSite {
    /** The dictionary holding the key. */
    holder: PDFDict;
    key: string;
    /** Where it was found, for the loss report. */
    where: string;
    fromIndex: number;
    /** The source page index the reference resolves to, when it resolves. */
    targetIndex: number | null;
    /** `dest` when the value is a destination array, `page` for a bare `/P`. */
    shape: 'dest' | 'page';
    tail: unknown[];
}

/**
 * Walk one action, and everything chained behind it, collecting the page
 * references it holds.
 *
 * Bounded and cycle-aware. A chain that cannot be finished is reported as
 * unreadable rather than quietly truncated, because a truncated walk that found
 * nothing looks exactly like a clean one.
 */
function collectActionPageRefs(
    doc: PDFDocument,
    holder: PDFDict,
    key: string,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
    depth: number,
    seen: Set<string>,
): void {
    if (depth > ACTION_CHAIN_BOUND) {
        unreadable.push(`${where}: action chain deeper than ${ACTION_CHAIN_BOUND}`);
        return;
    }
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) {
            unreadable.push(`${where}: cyclic action chain`);
            return;
        }
        seen.add(raw.tag);
    }
    const resolved = look(doc, raw);

    if (resolved instanceof PDFArray) {
        // Under `/Next` an array is a list of actions; under a destination key
        // it is the destination itself. Only the key says which.
        if (key === 'Next') {
            for (let i = 0; i < resolved.size(); i += 1) {
                const item = look(doc, resolved.get(i));
                if (!(item instanceof PDFDict)) continue;
                collectFromActionDict(
                    doc, item, `${where} /Next[${i}]`, fromIndex, pageIndexOf,
                    out, unreadable, depth + 1, new Set(seen),
                );
            }
        }
        return;
    }
    if (!(resolved instanceof PDFDict)) return;
    collectFromActionDict(
        doc, resolved, where, fromIndex, pageIndexOf, out, unreadable, depth + 1, seen,
    );
}

function collectFromActionDict(
    doc: PDFDocument,
    action: PDFDict,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
    depth: number,
    seen: Set<string>,
): void {
    if (depth > ACTION_CHAIN_BOUND) {
        unreadable.push(`${where}: action chain deeper than ${ACTION_CHAIN_BOUND}`);
        return;
    }
    if (nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
        const raw = action.get(PDFName.of('D'));
        const dest = look(doc, raw);
        if (dest instanceof PDFArray) {
            const first = dest.get(0);
            const tail: unknown[] = [];
            for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
            if (first instanceof PDFRef) {
                out.push({
                    holder: action,
                    key: 'D',
                    where: `${where} /GoTo /D`,
                    fromIndex,
                    targetIndex: pageIndexOf(first),
                    shape: 'dest',
                    tail,
                });
            }
        }
    }
    collectActionPageRefs(
        doc, action, 'Next', `${where} /Next`, fromIndex, pageIndexOf,
        out, unreadable, depth + 1, seen,
    );
}

/** Every entry of an additional-actions dictionary, walked for page references. */
function collectAdditionalActions(
    doc: PDFDocument,
    owner: PDFDict,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
): void {
    const raw = owner.get(PDFName.of('AA'));
    if (raw === undefined) return;
    const aa = look(doc, raw);
    if (!(aa instanceof PDFDict)) {
        unreadable.push(`${where} /AA is not a dictionary`);
        return;
    }
    for (const [key] of aa.entries()) {
        collectActionPageRefs(
            doc, aa, key.asString().replace(/^\//, ''),
            `${where} /AA ${key.asString()}`, fromIndex, pageIndexOf,
            out, unreadable, 0, new Set(),
        );
    }
}

/**
 * Every source-page reference reachable from the kept pages, on every route
 * M6-H5A names.
 */
export function collectSourcePageRefs(
    doc: PDFDocument,
    selection: number[],
): { sites: PageRefSite[]; unreadable: string[] } {
    const pages = doc.getPages();
    const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
    const pageIndexOf = (ref: PDFRef): number | null => byTag.get(ref.tag) ?? null;
    const sites: PageRefSite[] = [];
    const unreadable: string[] = [];

    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;

        // The page's own additional actions.
        collectAdditionalActions(
            doc, page.node, `page ${index}`, index, pageIndexOf, sites, unreadable,
        );

        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            const where = `page ${index} annotation ${i}`;

            // An annotation's `/P` names the page it belongs to. In a copy it
            // names a page of the source, whether or not that page was kept.
            const parentRaw = annot.get(PDFName.of('P'));
            if (parentRaw instanceof PDFRef) {
                sites.push({
                    holder: annot,
                    key: 'P',
                    where: `${where} /P`,
                    fromIndex: index,
                    targetIndex: pageIndexOf(parentRaw),
                    shape: 'page',
                    tail: [],
                });
            }

            collectActionPageRefs(
                doc, annot, 'A', `${where} /A`, index, pageIndexOf, sites, unreadable, 0, new Set(),
            );
            collectAdditionalActions(doc, annot, where, index, pageIndexOf, sites, unreadable);
        }
    }

    return { sites, unreadable };
}

/**
 * Plan and strip in one call, so the plan never escapes.
 *
 * `DestinationPlan` holds `PDFDict` holders from the source — that is what
 * makes the strip possible — and a caller that kept it would keep the source
 * context alive right through `save()`. Confining it here makes source
 * retention impossible by construction rather than by discipline.
 */
export function sanitizeDestinations(
    doc: PDFDocument,
    selection: number[],
): StripOutcome {
    const plan = planDestinations(doc, selection);
    return stripInternalDestinations(doc, plan, selection);
}

/** Whether E1 would refuse this selection, decided without keeping the plan. */
export function wouldBreakNavigation(
    doc: PDFDocument,
    selection: number[],
): {
    wouldBreak: number;
    otherSites: { fromIndex: number; key: string }[];
    unreadable: string[];
    duplicateNames: string[];
} {
    const plan = planDestinations(doc, selection);
    return {
        wouldBreak: plan.wouldBreak,
        otherSites: plan.otherSites,
        unreadable: plan.unreadable,
        duplicateNames: plan.duplicateNames,
    };
}

/** What M6-H5A's second pass removed, and what has to go back. */
export interface PageRefClosure {
    /** Rebuilt after the copy, against output page references. */
    rebuild: {
        fromIndex: number;
        /** The page in the source document, never shifted. RF-R5-1. */
        sourcePageIndex: number;
        /** The annotation, by reference: identity that survives a removal. RF-R5-1. */
        annotRef: PDFRef | null;
        annotIndex: number | null;
        pagePath: 'annot-P' | 'none';
        targetIndex: number;
    }[];
    losses: LossRecord[];
    /** Structures the walk could not finish. A refusal, not an absence. */
    unreadable: string[];
}

/**
 * Strip every remaining source-page reference from the pages being copied.
 *
 * Runs after {@link stripInternalDestinations}, which has already taken the
 * `/Dest` and top-level `/A /GoTo /D` shapes. What is left is exactly the set
 * M6-H5A added: `/P`, `/AA` on an annotation, a widget or a page, and a `/GoTo`
 * reached through `/Next`.
 *
 * `/P` is the only one rebuilt, because it has an output equivalent: the page
 * the annotation ends up on. An action chain that reaches a `/GoTo` is removed
 * and reported — reconstructing an arbitrary chain against a subset of pages is
 * not a shape this contract has proven.
 */
export function closeSourcePageRefs(
    doc: PDFDocument,
    selection: number[],
): PageRefClosure {
    const kept = new Set(selection);
    const { sites, unreadable } = collectSourcePageRefs(doc, selection);
    const rebuild: PageRefClosure['rebuild'] = [];
    const losses: LossRecord[] = [];

    const pages = doc.getPages();
    /**
     * Where the annotation sits, and — RF-R5-1 — what names it. The position is
     * kept for the message; the reference is what the reconstruction resolves.
     */
    const annotEntryOf = (
        pageIndex: number,
        holder: PDFDict,
    ): { index: number; ref: PDFRef | null } | null => {
        const page = pages[pageIndex];
        if (!page) return null;
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) return null;
        for (let i = 0; i < annots.size(); i += 1) {
            const entry = annots.get(i);
            if (look(doc, entry) === holder) {
                return { index: i, ref: entry instanceof PDFRef ? entry : null };
            }
        }
        return null;
    };

    for (const site of sites) {
        if (site.shape === 'page' && site.key === 'P') {
            const found = annotEntryOf(site.fromIndex, site.holder);
            // The annotation belongs to the page it sits on, which is kept by
            // construction — it was reached by walking that page.
            if (found !== null && kept.has(site.fromIndex)) {
                rebuild.push({
                    fromIndex: site.fromIndex,
                    sourcePageIndex: site.fromIndex,
                    annotRef: found.ref,
                    annotIndex: found.index,
                    pagePath: 'annot-P',
                    targetIndex: site.fromIndex,
                });
            } else {
                // Removed with nowhere to put it back. Never reached on a
                // document this contract handles — the site was found by
                // walking a page that is in the selection — so if it is, the
                // structure is not what this reader believes it is.
                unreadable.push(
                    `${site.where}: /P was removed and cannot be restored`,
                );
            }
            site.holder.delete(PDFName.of('P'));
            continue;
        }

        // An action's page reference. Removed, and named.
        site.holder.delete(PDFName.of(site.key));
        losses.push({
            kind: 'internal-links',
            fromIndex: site.fromIndex,
            what: site.where,
            why: site.targetIndex === null
                ? 'ページとして解決できない参照のため削除しました。'
                : kept.has(site.targetIndex)
                    ? '対応範囲外の経路（アクション連鎖）からのページ参照のため削除しました。'
                    : 'リンク先のページが選択されていません。',
        });
    }

    return { rebuild, losses, unreadable };
}

/** Put `/P` back, pointing at the page the annotation actually sits on. */
export function rebuildSourcePageRefs(
    out: PDFDocument,
    closure: PageRefClosure,
    selection: number[],
    source: PDFDocument | null = null,
): RebuildOutcome {
    const outPages = out.getPages();
    const unapplied: string[] = [];
    const removed: string[] = [];
    let rebuilt = 0;
    for (const item of closure.rebuild) {
        const where = `page ${item.targetIndex} /Annots[${item.annotIndex}] /P`;
        const position = selection.indexOf(item.targetIndex);
        const page = outPages[position];
        if (!page) {
            unapplied.push(`${where}: the page it belongs to is not in the output`);
            continue;
        }
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) {
            unapplied.push(`${where}: the copied page has no /Annots array`);
            continue;
        }
        if (source === null) {
            unapplied.push(`${where}: the source is not available to name the annotation`);
            continue;
        }
        // RF-R5-1: by reference, not by the position it had when planned.
        const found = copiedAnnot(source, item.sourcePageIndex, annots, out, item.annotRef);
        if (!found.ok) {
            (found.gone ? removed : unapplied).push(`${where}: ${found.reason}`);
            continue;
        }
        found.annot.set(PDFName.of('P'), page.ref);
        rebuilt += 1;
    }
    return { rebuilt, unapplied, removed };
}

/**
 * Source-page references surviving in an artifact.
 *
 * A page reference in an output document is legitimate only when it resolves to
 * a page of that document's own tree. Anything else — a reference to a page
 * object outside the tree, or one that resolves to nothing — is a reference the
 * copy brought across and nobody retargeted.
 */
export function countSourcePageReferences(doc: PDFDocument): number {
    const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
    let count = 0;

    const isStrayPageRef = (raw: unknown): boolean => {
        if (!(raw instanceof PDFRef)) return false;
        let target: unknown;
        try {
            target = doc.context.lookup(raw);
        } catch {
            return false;
        }
        if (!(target instanceof PDFDict)) return false;
        if (nameOf(target.get(PDFName.of('Type'))) !== '/Page') return false;
        return !inTree.has(raw.tag);
    };

    const seen = new Set<object>();
    const walkAction = (value: unknown, depth: number): void => {
        if (depth > ACTION_CHAIN_BOUND) return;
        const action = look(doc, value);
        if (!(action instanceof PDFDict)) return;
        if (seen.has(action)) return;
        seen.add(action);
        const dest = look(doc, action.get(PDFName.of('D')));
        if (dest instanceof PDFArray && isStrayPageRef(dest.get(0))) count += 1;
        const next = action.get(PDFName.of('Next'));
        const resolved = look(doc, next);
        if (resolved instanceof PDFArray) {
            for (let i = 0; i < resolved.size(); i += 1) walkAction(resolved.get(i), depth + 1);
        } else if (next !== undefined) {
            walkAction(next, depth + 1);
        }
    };

    const walkAdditional = (owner: PDFDict): void => {
        const aa = look(doc, owner.get(PDFName.of('AA')));
        if (!(aa instanceof PDFDict)) return;
        for (const [, entry] of aa.entries()) walkAction(entry, 0);
    };

    for (const page of doc.getPages()) {
        walkAdditional(page.node);
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (isStrayPageRef(annot.get(PDFName.of('P')))) count += 1;
            const dest = look(doc, annot.get(PDFName.of('Dest')));
            if (dest instanceof PDFArray && isStrayPageRef(dest.get(0))) count += 1;
            walkAction(annot.get(PDFName.of('A')), 0);
            walkAdditional(annot);
        }
    }

    return count;
}

/**
 * Count, on an artifact, what the invariants are about.
 *
 * `orphanPageCount` is indirect `/Page` objects outside the output page tree.
 * `danglingDestinations` is surviving internal destinations that do not target a
 * page of that tree. Both are measured by reopening the bytes, not by trusting
 * what the run believes it did.
 */
export function measureDestinationInvariants(doc: PDFDocument): {
    orphanPageCount: number;
    danglingDestinations: number;
} {
    const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
    let orphanPageCount = 0;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('Type'))) !== '/Page') continue;
        if (!inTree.has(ref.tag)) orphanPageCount += 1;
    }

    let danglingDestinations = 0;
    const checkDest = (raw: unknown): void => {
        const dest = look(doc, raw);
        if (!(dest instanceof PDFArray)) return;
        const first = dest.get(0);
        if (!(first instanceof PDFRef)) return;
        if (!inTree.has(first.tag)) danglingDestinations += 1;
    };

    for (const page of doc.getPages()) {
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (annot.get(PDFName.of('Dest')) !== undefined) checkDest(annot.get(PDFName.of('Dest')));
            const action = look(doc, annot.get(PDFName.of('A')));
            if (action instanceof PDFDict && nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
                checkDest(action.get(PDFName.of('D')));
            }
        }
    }

    const names = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (names instanceof PDFDict) {
        const dests = look(doc, names.get(PDFName.of('Dests')));
        if (dests instanceof PDFDict) {
            const arr = look(doc, dests.get(PDFName.of('Names')));
            if (arr instanceof PDFArray) {
                for (let i = 1; i < arr.size(); i += 2) checkDest(arr.get(i));
            }
        }
    }

    return { orphanPageCount, danglingDestinations };
}
