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
    PDFNumber,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { CENSUS_BUDGET, censusIndirectObjects, collectByCensus, dictOf } from './census';
import type { CensusNode, CensusOutcome } from './census';
import { readPdfText } from './pdf-text';
import { classifyField, signatureEvidenceOf } from './field-semantics';
import { javaScriptCarrierConflict } from './javascript';

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

export interface StreamLengthReport {
    /** Streams whose `/Length` was rewritten to the direct current length. */
    canonicalized: number;
    /** Streams already carrying the correct direct `/Length`. */
    unchanged: number;
    /**
     * Streams whose current contents could not be measured, by reference. A
     * non-empty list is a refusal: an artifact whose stream lengths cannot be
     * described is not one to hand over.
     */
    undescribable: string[];
}

/**
 * Make `/Length` say what pdf-lib is about to serialise, before the sweep.
 *
 * A source stream may carry `/Length <ref>` — an indirect number. `copyPages`
 * copies the stream *and* that number, and the sweep is right to call the
 * number reachable, because at that moment the stream dictionary really does
 * point at it. Then `save()` runs, `PDFStream.updateDict()` rewrites `/Length`
 * to a **direct** `PDFNumber` (`core/objects/PDFStream.js`), and the copied
 * number is left in the bytes with nothing pointing at it. A real published
 * drawing reached readback with 18 such orphans and failed
 * `unreachableObjects === 0`.
 *
 * The honest fix is not to teach the invariant to overlook a number. It is to
 * put the output graph into the representation pdf-lib will write **before**
 * anything is counted or swept, so the indirect length objects become
 * unreachable on their own and `pruneUnreachable` removes them for the ordinary
 * reason. Run this immediately before that sweep.
 *
 * The length written is the stream's own measured content size, never the
 * `/Length` token already there: a token that disagrees with the bytes is the
 * thing being corrected, not the authority for it. Contents are never touched,
 * nothing is compressed to make a number fit, and no replacement length object
 * is registered — the value is direct, exactly as pdf-lib would write it. A
 * number still referenced by some other live key survives the sweep through
 * that reference, because this changes one entry rather than deleting anything.
 */
export function canonicalizeStreamLengthsForSave(doc: PDFDocument): StreamLengthReport {
    const report: StreamLengthReport = { canonicalized: 0, unchanged: 0, undescribable: [] };
    const LENGTH = PDFName.of('Length');

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFStream)) continue;

        // The base class throws rather than guessing, and a size that is not a
        // whole count of bytes describes no stream. Either way the artifact is
        // refused rather than written with a length nobody can stand behind.
        let size: number;
        try {
            size = obj.getContentsSize();
        } catch {
            report.undescribable.push(ref.toString());
            continue;
        }
        if (!Number.isInteger(size) || size < 0) {
            report.undescribable.push(ref.toString());
            continue;
        }

        const current = obj.dict.get(LENGTH);
        if (current instanceof PDFNumber && current.asNumber() === size) {
            report.unchanged += 1;
            continue;
        }
        obj.dict.set(LENGTH, PDFNumber.of(size));
        report.canonicalized += 1;
    }

    return report;
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
    | { complete: false; unsafe: false; reason: string }
    /** Round 9: a carrier that is provably something besides an action. */
    | { complete: false; unsafe: true; reason: string; details: string[] };

export function scrubAllJavaScript(doc: PDFDocument): ScrubOutcome {
    const census = censusJavaScript(doc);
    if (!census.complete) return { complete: false, unsafe: false, reason: census.reason };

    // Round 9 — `/JS` is evidence, not authority. Every carrier is proven to be
    // an action before any one of them is emptied; a stream, or anything typed
    // or subtyped as something else, refuses the whole scrub untouched.
    const streamRoots = new Set<string>();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFStream) streamRoots.add(ref.tag);
    }
    const conflicts: string[] = [];
    for (const node of census.value) {
        const conflict = javaScriptCarrierConflict(node.dict, node.depth === 0 && streamRoots.has(node.rootTag));
        if (conflict) {
            const where = node.depth === 0 ? `object ${node.rootTag}` : `a dictionary inside ${node.rootTag}`;
            conflicts.push(`${where} carries JavaScript but ${conflict}`);
        }
    }
    if (conflicts.length > 0) {
        return { complete: false, unsafe: true, reason: conflicts.join('; '), details: conflicts };
    }

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
    /**
     * One label per attachment, for disclosure. RF-R4-6.
     *
     * Not de-duplicated: two attachments both called `notes.txt` are two
     * attachments, and a confirmation that listed one name for them would be
     * asking about one.
     */
    names: string[];
}

/** Shown for an attachment that carries no filename at all. Never invented. */
export const UNNAMED_ATTACHMENT_LABEL = '名前のない添付ファイル';
/** Shown for an attachment whose filename is there and cannot be read. */
export const UNREADABLE_ATTACHMENT_LABEL = '名前を読み取れない添付ファイル';

const lookupQuietly = (doc: PDFDocument, value: unknown): unknown => {
    if (!(value instanceof PDFRef)) return value;
    try {
        return doc.context.lookup(value);
    } catch {
        return undefined;
    }
};

/**
 * The filename a file specification shows, `/UF` first. RF-R4-6.
 *
 * `/UF` is the Unicode filename and `/F` the portable one, so `/UF` is the name
 * a person gave the file; the reader this replaces asked for `/F` first and
 * showed `memo.txt` for a file called `図面メモ.txt`. A file specification may
 * also be a bare string. Either key being unreadable is recorded, so a name
 * that is there and cannot be decoded is not presented as no name.
 */
function filespecLabel(doc: PDFDocument, spec: unknown): { label: string | null; unreadable: boolean } {
    const resolved = lookupQuietly(doc, spec);
    if (!(resolved instanceof PDFDict)) {
        if (resolved === undefined) return { label: null, unreadable: false };
        const read = readPdfText(resolved);
        if (read.ok) return { label: read.value.text || null, unreadable: false };
        return { label: null, unreadable: true };
    }
    let unreadable = false;
    for (const key of ['UF', 'F']) {
        const raw = resolved.get(PDFName.of(key));
        if (raw === undefined) continue;
        const read = readPdfText(lookupQuietly(doc, raw));
        if (read.ok && read.value.text !== '') return { label: read.value.text, unreadable: false };
        if (!read.ok) unreadable = true;
    }
    return { label: null, unreadable };
}

/**
 * `/Names /EmbeddedFiles` keys by the file specification they point at.
 *
 * Used only to name an attachment whose file specification names nothing: the
 * tree key is the name the document gave it. Best effort by design — a tree
 * that cannot be walked leaves the attachment disclosed as unnamed, never
 * undisclosed, because presence is decided by the census, not by this.
 */
function embeddedFileKeys(doc: PDFDocument): Map<string, string> {
    const keys = new Map<string, string>();
    const names = lookupQuietly(doc, doc.catalog.get(PDFName.of('Names')));
    if (!(names instanceof PDFDict)) return keys;
    const seen = new Set<string>();
    const walk = (raw: unknown, depth: number): void => {
        if (depth > 32 || keys.size > 100_000) return;
        if (raw instanceof PDFRef) {
            if (seen.has(raw.tag)) return;
            seen.add(raw.tag);
        }
        const node = lookupQuietly(doc, raw);
        if (!(node instanceof PDFDict)) return;
        const leaf = lookupQuietly(doc, node.get(PDFName.of('Names')));
        if (leaf instanceof PDFArray) {
            for (let i = 0; i + 1 < leaf.size(); i += 2) {
                const target = leaf.get(i + 1);
                const key = readPdfText(lookupQuietly(doc, leaf.get(i)));
                if (target instanceof PDFRef && key.ok && key.value.text !== '') {
                    keys.set(target.tag, key.value.text);
                }
            }
        }
        const kids = lookupQuietly(doc, node.get(PDFName.of('Kids')));
        if (kids instanceof PDFArray) {
            for (let i = 0; i < kids.size(); i += 1) walk(kids.get(i), depth + 1);
        }
    };
    walk(names.get(PDFName.of('EmbeddedFiles')), 0);
    return keys;
}

/**
 * One label per attachment the census found. RF-R4-6.
 *
 * Every `/EF` carrier is an attachment. A `/FileAttachment` annotation is one
 * more only when its `/FS` is not itself a carrier — otherwise the same file
 * would be listed twice.
 */
function attachmentLabels(doc: PDFDocument, carriers: CensusNode[], annots: CensusNode[]): string[] {
    const treeKeys = embeddedFileKeys(doc);
    const labels: string[] = [];
    const fallback = (unreadable: boolean): string =>
        (unreadable ? UNREADABLE_ATTACHMENT_LABEL : UNNAMED_ATTACHMENT_LABEL);
    for (const node of carriers) {
        const own = filespecLabel(doc, node.dict);
        const fromTree = node.depth === 0 ? treeKeys.get(node.rootTag) ?? null : null;
        labels.push(own.label ?? fromTree ?? fallback(own.unreadable));
    }
    for (const node of annots) {
        const fs = node.dict.get(PDFName.of('FS'));
        const spec = lookupQuietly(doc, fs);
        if (spec instanceof PDFDict && carriesEmbeddedFile(spec)) continue;
        const own = filespecLabel(doc, fs);
        labels.push(own.label ?? fallback(own.unreadable));
    }
    return labels;
}

/** The attachment census, or a refusal. */
export function censusAttachments(doc: PDFDocument): CensusOutcome<AttachmentCensus> {
    const result: AttachmentCensus = {
        efCarriers: 0,
        fileAttachmentAnnots: 0,
        payloadStreams: 0,
        names: [],
    };
    const payloadTags = new Set<string>();
    const carrierNodes: CensusNode[] = [];
    const annotNodes: CensusNode[] = [];

    const outcome = censusIndirectObjects(doc, (node) => {
        const { dict } = node;
        if (isFileAttachmentAnnot(dict)) {
            result.fileAttachmentAnnots += 1;
            annotNodes.push(node);
        }
        if (!carriesEmbeddedFile(dict)) return;
        result.efCarriers += 1;
        carrierNodes.push(node);

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
    result.names = attachmentLabels(doc, carrierNodes, annotNodes);
    return { complete: true, value: result, nodes: outcome.nodes, roots: outcome.roots };
}

/**
 * BLK-R8R-1 — `/EF` is evidence to inspect, not authority to delete.
 *
 * The remover this replaces treated any dictionary carrying `/EF` as a file
 * specification, condemned every object an `/EF` named, and then deleted every
 * reference, anywhere, to anything it had condemned. Nothing asked whether those
 * objects were attachments. Measured, READY, under a confirmation that said only
 * "an attachment is not carried": an optional-content group carrying `/EF` was
 * deleted together with its registration, so a layer the author had switched
 * off was drawn; an `/OCProperties` carrying `/EF` lost its catalog key; an
 * `/EF /F` naming the form a page draws, or the page's own content stream,
 * deleted the drawing and handed over a blank page.
 *
 * So removal is two steps now, and the first one can refuse:
 *
 *   1. **Classify** ({@link classifyAttachments}). Every `/EF` carrier, every
 *      payload an `/EF` names, every `/FileAttachment` annotation and every
 *      `/EmbeddedFiles` tree node is checked for its **shape** — it is the
 *      attachment structure it would be removed as — and for its **context** —
 *      every reference to it comes from a proven attachment structure. Anything
 *      else is UNSAFE, and the removal is refused before one entry is touched.
 *   2. **Remove edges.** Only then are the attachment edges taken out. What
 *      becomes unreachable is left to the reachability sweep; nothing is deleted
 *      merely because an `/EF` named it.
 *
 * Proven attachment structures — the entry points this contract has always
 * removed, and no others:
 *
 *   - a value of the catalog's `/Names /EmbeddedFiles` name tree;
 *   - the `/FS` of a `/FileAttachment` annotation;
 *   - the `/F` of an action (a dictionary with `/S`) — the `/Launch` family;
 *   - a member of an `/AF` associated-files array.
 *
 * A typeless file specification stays supported (BLK-2R): its context proves
 * what it is. A dictionary with `/EF` in any other context, or with keys a file
 * specification does not have, is not one — and is not removed as one.
 */

/** The keys a file specification dictionary may carry. ISO 32000-2, 7.11.3. */
const FILESPEC_KEYS = new Set([
    'Type', 'FS', 'F', 'UF', 'DOS', 'Mac', 'Unix', 'ID', 'V', 'EF', 'RF',
    'Desc', 'CI', 'Thumb', 'EP', 'AFRelationship',
]);
/** The keys an `/EF` dictionary may carry. Each names one embedded file stream. */
const EF_KEYS = new Set(['F', 'UF', 'DOS', 'Mac', 'Unix']);
/** Stream subtypes that make a stream something a page draws, not a file. */
const DRAWN_SUBTYPES = new Set(['/Form', '/Image', '/PS']);

/** Where one reference is held. An indirect array's holder is found through it. */
type EdgeSite =
    | { kind: 'dict'; holder: PDFDict; key: string; viaArray: boolean; rootTag: string }
    | { kind: 'array'; arrayTag: string };

/** A reference's context, resolved to the dictionary and key that hold it. */
interface EdgeContext {
    holder: PDFDict;
    key: string;
    viaArray: boolean;
    rootTag: string;
}

export interface AttachmentAnalysis {
    /** Every dictionary carrying `/EF`, as the census found it. */
    carriers: CensusNode[];
    /** Every `/FileAttachment` annotation. */
    annots: CensusNode[];
    /**
     * Why removing these would touch something that is not an attachment. One
     * entry makes the whole removal a refusal.
     */
    unsafe: string[];
}

/**
 * Decide, changing nothing, whether every attachment structure in the document
 * can be removed without touching anything that is not an attachment.
 *
 * COMPLETE or REFUSED, like every census here: an inbound-reference index that
 * could not be proven to cover the document cannot prove exclusivity either.
 */
export function classifyAttachments(doc: PDFDocument): CensusOutcome<AttachmentAnalysis> {
    const carriers: CensusNode[] = [];
    const annots: CensusNode[] = [];
    const inbound = new Map<string, EdgeSite[]>();
    const arrayHolder = new Map<PDFArray, EdgeSite>();
    const rootArrayTag = new Map<PDFArray, string>();
    const rootIsStream = new Set<string>();
    let tooDeep = false;

    const addEdge = (tag: string, site: EdgeSite): void => {
        const list = inbound.get(tag);
        if (list) list.push(site);
        else inbound.set(tag, [site]);
    };
    const scanArray = (array: PDFArray, site: EdgeSite, depth: number): void => {
        if (depth > CENSUS_BUDGET.maxDirectDepth) {
            tooDeep = true;
            return;
        }
        arrayHolder.set(array, site);
        const inner: EdgeSite = site.kind === 'dict' ? { ...site, viaArray: true } : site;
        for (let i = 0; i < array.size(); i += 1) {
            const item = array.get(i);
            if (item instanceof PDFRef) addEdge(item.tag, inner);
            else if (item instanceof PDFArray) scanArray(item, inner, depth + 1);
        }
    };

    // Indirect arrays hold references too — `/Annots` very often is one — and
    // the census hands its visitor dictionaries only.
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFStream) rootIsStream.add(ref.tag);
        if (obj instanceof PDFArray) {
            rootArrayTag.set(obj, ref.tag);
            scanArray(obj, { kind: 'array', arrayTag: ref.tag }, 0);
        }
    }

    const outcome = censusIndirectObjects(doc, (node) => {
        const { dict, rootTag } = node;
        for (const [k, value] of dict.entries()) {
            const key = k.asString().replace(/^\//, '');
            if (value instanceof PDFRef) {
                addEdge(value.tag, { kind: 'dict', holder: dict, key, viaArray: false, rootTag });
            } else if (value instanceof PDFArray) {
                scanArray(value, { kind: 'dict', holder: dict, key, viaArray: true, rootTag }, 0);
            }
        }
        if (isFileAttachmentAnnot(dict)) annots.push(node);
        if (carriesEmbeddedFile(dict)) carriers.push(node);
    });
    if (!outcome.complete) return outcome;
    if (tooDeep) {
        return {
            complete: false,
            reason: `an array nests deeper than ${CENSUS_BUDGET.maxDirectDepth}`,
            nodes: outcome.nodes,
            roots: outcome.roots,
        };
    }

    /** Every dictionary-and-key a reference is ultimately held under, or null. */
    const contextsOf = (site: EdgeSite): EdgeContext[] | null => {
        if (site.kind === 'dict') return [site];
        const holders = inbound.get(site.arrayTag) ?? [];
        const out: EdgeContext[] = [];
        for (const holder of holders) {
            // An indirect array held by another indirect array is a shape no
            // attachment structure takes, so it is not followed further.
            if (holder.kind !== 'dict') return null;
            out.push({ ...holder, viaArray: true });
        }
        return out;
    };
    const where = (c: EdgeContext): string => `${c.rootTag} /${c.key}`;
    const typeOf = (dict: PDFDict): string => nameOf(dict.get(PDFName.of('Type')));

    const unsafe: string[] = [];
    const note = (text: string): void => {
        if (!unsafe.includes(text)) unsafe.push(text);
    };

    // ---- the `/EmbeddedFiles` tree ------------------------------------------
    const namesDict = lookupQuietly(doc, doc.catalog.get(PDFName.of('Names')));
    const treeNodes = new Set<PDFDict>();
    const treeTags = new Set<string>();
    if (namesDict instanceof PDFDict) {
        const walkTree = (raw: unknown, depth: number): void => {
            if (depth > 32) return;
            if (raw instanceof PDFRef) {
                if (treeTags.has(raw.tag)) return;
                treeTags.add(raw.tag);
            }
            const node = lookupQuietly(doc, raw);
            if (!(node instanceof PDFDict)) return;
            treeNodes.add(node);
            const kids = lookupQuietly(doc, node.get(PDFName.of('Kids')));
            if (kids instanceof PDFArray) {
                for (let i = 0; i < kids.size(); i += 1) walkTree(kids.get(i), depth + 1);
            }
        };
        const root = namesDict.get(PDFName.of('EmbeddedFiles'));
        if (root !== undefined) walkTree(root, 0);
    }

    // ---- what each role may be held by --------------------------------------
    const carrierDicts = new Set<PDFDict>();
    const efDicts = new Set<PDFDict>();
    const isAction = (dict: PDFDict): boolean => dict.get(PDFName.of('S')) !== undefined;

    const fileSpecContext = (c: EdgeContext): boolean =>
        (treeNodes.has(c.holder) && c.key === 'Names' && c.viaArray)
        || (isFileAttachmentAnnot(c.holder) && c.key === 'FS' && !c.viaArray)
        || (isAction(c.holder) && c.key === 'F' && !c.viaArray)
        || (c.key === 'AF' && c.viaArray);
    const efDictContext = (c: EdgeContext): boolean =>
        carrierDicts.has(c.holder) && c.key === 'EF' && !c.viaArray;
    const payloadContext = (c: EdgeContext): boolean =>
        efDicts.has(c.holder) && EF_KEYS.has(c.key) && !c.viaArray;
    const annotContext = (c: EdgeContext): boolean =>
        (c.key === 'Annots' && c.viaArray)
        || (c.key === 'Parent' && !c.viaArray && nameOf(c.holder.get(PDFName.of('Subtype'))) === '/Popup')
        || (c.key === 'IRT' && !c.viaArray)
        || (c.key === 'Obj' && !c.viaArray && typeOf(c.holder) === '/OBJR');
    const treeNodeContext = (c: EdgeContext): boolean =>
        (c.holder === namesDict && c.key === 'EmbeddedFiles' && !c.viaArray)
        || (treeNodes.has(c.holder) && c.key === 'Kids' && c.viaArray);

    /** Every reference to `tag` is held in `allowed` context, or it is unsafe. */
    const exclusive = (
        tag: string,
        allowed: (c: EdgeContext) => boolean,
        what: string,
    ): void => {
        for (const site of inbound.get(tag) ?? []) {
            const contexts = contextsOf(site);
            if (contexts === null) {
                note(`${what} ${tag} is reached through an indirect array held by another array`);
                continue;
            }
            for (const c of contexts) {
                if (!allowed(c)) {
                    note(`${what} ${tag} is also reached from ${where(c)}, which is not an attachment structure`);
                }
            }
        }
    };

    /** The context a direct dictionary sits in, from its census parent. */
    const directContexts = (node: CensusNode): EdgeContext[] | null => {
        const parent = node.parent;
        if (!parent) return null;
        if (parent.container instanceof PDFDict) {
            return [{
                holder: parent.container,
                key: String(parent.key),
                viaArray: false,
                rootTag: node.rootTag,
            }];
        }
        const site = arrayHolder.get(parent.container);
        if (site) return contextsOf(site);
        const tag = rootArrayTag.get(parent.container);
        return tag === undefined ? null : contextsOf({ kind: 'array', arrayTag: tag });
    };

    // ---- carriers: file-specification shape, `/EF` shape --------------------
    for (const node of carriers) {
        const { dict, depth, rootTag } = node;
        const label = depth === 0 ? `object ${rootTag}` : `a dictionary inside ${rootTag}`;
        const type = typeOf(dict);
        const foreign = [...dict.keys()]
            .map((k) => k.asString().replace(/^\//, ''))
            .filter((k) => !FILESPEC_KEYS.has(k));
        if (depth === 0 && rootIsStream.has(rootTag)) {
            note(`${label} carries /EF but is a stream, not a file specification`);
        } else if (type !== '' && type !== '/Filespec') {
            note(`${label} carries /EF but is ${type}, not a file specification`);
        } else if (foreign.length > 0) {
            note(`${label} carries /EF alongside /${foreign.join(', /')}, which a file specification does not have`);
        }
        carrierDicts.add(dict);

        // A stream's dictionary is not a PDFDict instance, so a stream here fails
        // the same test as a number would.
        const ef = lookupQuietly(doc, dict.get(PDFName.of('EF')));
        if (!(ef instanceof PDFDict)) {
            note(`${label} /EF is not a dictionary of embedded files`);
            continue;
        }
        efDicts.add(ef);
        for (const [k] of ef.entries()) {
            const key = k.asString().replace(/^\//, '');
            if (!EF_KEYS.has(key)) note(`${label} /EF holds /${key}, which names no embedded file`);
        }
    }

    for (const node of carriers) {
        const { dict, depth, rootTag } = node;
        const label = depth === 0 ? `object ${rootTag}` : `a dictionary inside ${rootTag}`;

        // Context: where the file specification itself is held.
        if (depth === 0) {
            exclusive(rootTag, fileSpecContext, 'file specification');
        } else {
            const contexts = directContexts(node);
            if (contexts === null || contexts.length === 0 || !contexts.every(fileSpecContext)) {
                const at = contexts && contexts.length > 0 ? ` at ${where(contexts[0])}` : '';
                note(`${label} carries /EF${at}, which is not an attachment structure`);
            }
        }

        const rawEf = dict.get(PDFName.of('EF'));
        if (rawEf instanceof PDFRef) exclusive(rawEf.tag, efDictContext, '/EF dictionary');
        const ef = lookupQuietly(doc, rawEf);
        if (!(ef instanceof PDFDict)) continue;

        // Payloads: an embedded file stream, held by `/EF` dictionaries only.
        for (const [k, raw] of ef.entries()) {
            const key = k.asString().replace(/^\//, '');
            const target = lookupQuietly(doc, raw);
            const at = raw instanceof PDFRef ? raw.tag : 'a direct value';
            if (!(target instanceof PDFStream)) {
                note(`${label} /EF /${key} names ${at}, which is not an embedded file stream`);
                continue;
            }
            const payloadType = typeOf(target.dict);
            const subtype = nameOf(target.dict.get(PDFName.of('Subtype')));
            if (payloadType !== '' && payloadType !== '/EmbeddedFile') {
                note(`${label} /EF /${key} names ${at}, which is ${payloadType}, not an embedded file`);
            } else if (DRAWN_SUBTYPES.has(subtype)) {
                note(`${label} /EF /${key} names ${at}, which is a ${subtype} XObject, not an embedded file`);
            }
            if (raw instanceof PDFRef) exclusive(raw.tag, payloadContext, 'embedded file');
        }
    }

    // ---- file-attachment annotations -----------------------------------------
    for (const node of annots) {
        const { dict, depth, rootTag } = node;
        const type = typeOf(dict);
        if (type !== '' && type !== '/Annot') {
            note(`object ${rootTag} is a /FileAttachment annotation and also ${type}`);
        }
        if (depth === 0) {
            exclusive(rootTag, annotContext, 'file-attachment annotation');
        } else {
            const contexts = directContexts(node);
            if (contexts === null || contexts.length === 0 || !contexts.every(annotContext)) {
                note(`a /FileAttachment annotation inside ${rootTag} is held outside any /Annots array`);
            }
        }
    }

    // ---- the tree the Names entry is removed with ----------------------------
    for (const tag of treeTags) exclusive(tag, treeNodeContext, '/EmbeddedFiles node');

    return {
        complete: true,
        value: { carriers, annots, unsafe },
        nodes: outcome.nodes,
        roots: outcome.roots,
    };
}

export type AttachmentRemoval =
    | { complete: true; removed: number; names: string[]; removedActions: string[] }
    /** The inspection could not be proven to have covered the document. */
    | { complete: false; unsafe: false; reason: string }
    /** An `/EF`, payload or annotation that is not provably an attachment. */
    | { complete: false; unsafe: true; reason: string; details: string[] };

/**
 * Remove every attachment, everywhere, and leave nothing half-removed — or
 * refuse, having touched nothing, when that would remove anything else.
 *
 * What goes together is unchanged: the `/EF` entry, the payload streams behind
 * it, and — when the file specification sits inside an action this contract does
 * not support, such as `/Launch` — the whole containing action. Deleting a
 * `/Launch` action's file and leaving the action behind would ship a broken
 * action, which is a partial semantic this contract does not invent.
 *
 * What changed is the authority. Only structures {@link classifyAttachments}
 * proved attachment-exclusive are edited, and objects are not deleted here at
 * all: the edges into them are removed, and what that leaves unreachable is
 * never copied from a source and is swept from an artifact by
 * {@link pruneUnreachable}.
 */
export function removeAttachmentsEverywhere(doc: PDFDocument): AttachmentRemoval {
    const analysis = classifyAttachments(doc);
    if (!analysis.complete) return { complete: false, unsafe: false, reason: analysis.reason };
    if (analysis.value.unsafe.length > 0) {
        return {
            complete: false,
            unsafe: true,
            reason: analysis.value.unsafe.join('; '),
            details: [...analysis.value.unsafe],
        };
    }
    const { carriers, annots } = analysis.value;

    const removedActions: string[] = [];
    /** Indirect attachment structures whose incoming references are removed. */
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
    const emptyAction = (holder: PDFDict, kind: string): void => {
        removedActions.push(kind);
        for (const [key] of [...holder.entries()]) holder.delete(key);
        removed += 1;
    };

    // Named before anything is taken apart, by the same rule the facts reader
    // uses, so what the run reports removing is what the person was shown.
    const names = attachmentLabels(doc, carriers, annots);

    for (const node of carriers) {
        const { dict, parent, depth, rootTag } = node;

        const ef = dict.get(PDFName.of('EF'));
        const efDict = ef instanceof PDFRef ? doc.context.lookup(ef) : ef;
        if (efDict instanceof PDFDict) {
            for (const [, target] of efDict.entries()) condemn(target);
            for (const [key] of [...efDict.entries()]) efDict.delete(key);
        }
        condemn(ef);
        dict.delete(PDFName.of('EF'));
        removed += 1;

        // A carrier that IS an indirect object loses every reference to it —
        // each proven above to be an attachment edge. One nested directly
        // inside something else is edited in place.
        if (depth === 0) condemnedTags.add(rootTag);
        else if (parent && parent.container instanceof PDFDict) {
            const holder = parent.container;
            const kind = unsupportedAction(holder);
            if (kind) emptyAction(holder, kind);
            else holder.delete(PDFName.of(String(parent.key)));
        }
    }

    for (const node of annots) {
        // The annotation's own `/FS` entry goes with it. A file specification
        // that carries `/EF` was condemned as a carrier above; one that does
        // not carries no payload, and is left for the sweep rather than having
        // every other reference to it removed on the annotation's account.
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

    // ---- the incoming references, and only those -----------------------------
    //
    // Every one was classified an attachment edge above, so removing them
    // removes attachments and nothing else. The census does not follow
    // references, so it cannot see that an `/Annots` array holds one; indirect
    // arrays are walked by their own pass for the same reason.
    if (condemnedTags.size > 0) {
        const pruneArray = (array: PDFArray, depth: number): void => {
            if (depth > CENSUS_BUDGET.maxDirectDepth) return;
            for (let i = array.size() - 1; i >= 0; i -= 1) {
                const entry = array.get(i);
                if (entry instanceof PDFRef && condemnedTags.has(entry.tag)) array.remove(i);
                else if (entry instanceof PDFArray) pruneArray(entry, depth + 1);
            }
        };
        const pass = censusIndirectObjects(doc, ({ dict }) => {
            for (const [key, value] of [...dict.entries()]) {
                if (value instanceof PDFRef && condemnedTags.has(value.tag)) {
                    // A `/Launch` whose file has been taken away is a broken
                    // action; the whole action goes, and the removal is named.
                    const kind = key.asString() === '/F' ? unsupportedAction(dict) : null;
                    if (kind) {
                        emptyAction(dict, kind);
                        break;
                    }
                    dict.delete(key);
                } else if (value instanceof PDFArray) {
                    pruneArray(value, 0);
                }
            }
        });
        if (!pass.complete) return { complete: false, unsafe: false, reason: pass.reason };
        for (const [, obj] of doc.context.enumerateIndirectObjects()) {
            if (obj instanceof PDFArray) pruneArray(obj, 0);
        }
    }

    return { complete: true, removed, names, removedActions };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Whether a dictionary would present an artifact as signed, and why. RF-R5-3.
 *
 * A signature field (`/FT /Sig`), plus exactly the evidence
 * {@link signatureEvidenceOf} decides an applied signature by — the same set,
 * from the same function, so the backstop cannot drift narrower than the
 * classifier. `/Contents` counts only where the dictionary is a field's value:
 * a page's `/Contents` is its content stream and says nothing about signing.
 *
 * No M6 output carries any of them: Extract removes every signature field under
 * M6-H1, and Merge refuses an applied one under M6-H2 and removes the empty
 * ones. So this is a count that must be zero, measured on the artifact — the
 * backstop for a signature an upstream reader failed to classify.
 */
export const signatureRemnantOf = (dict: PDFDict, isFieldValue: boolean): string | null => {
    if (nameOf(dict.get(PDFName.of('FT'))) === '/Sig') return '/FT /Sig';
    return signatureEvidenceOf(dict, { isFieldValue });
};

/** The same question without the field-value context: evidence that stands alone. */
export const isSignatureRemnant = (dict: PDFDict): boolean =>
    signatureRemnantOf(dict, false) !== null;

/**
 * Every signature remnant in the artifact, or a refusal.
 *
 * Two passes, because `/Contents` is only evidence in one place. The first
 * finds every dictionary a field points at with `/V`; the second counts. Both
 * are censuses, so the answer is COMPLETE or REFUSED and never a partial scan
 * reporting zero (the round-3 rule). A widget is put through `classifyField`
 * itself — the resolver that decides what an applied signature is — so a
 * signature whose `/FT` lives on an ancestor, or whose ancestry cannot be read
 * at all, is counted or refused rather than passed over.
 */
export function censusSignatures(doc: PDFDocument): CensusOutcome<number> {
    const valueTags = new Set<string>();
    const valueDicts = new Set<PDFDict>();
    const values = censusIndirectObjects(doc, ({ dict }) => {
        const v = dict.get(PDFName.of('V'));
        if (v instanceof PDFRef) {
            valueTags.add(v.tag);
            return;
        }
        const direct = dictOf(v);
        if (direct) valueDicts.add(direct);
    });
    if (!values.complete) return values;

    let count = 0;
    const unclassified: string[] = [];
    const outcome = censusIndirectObjects(doc, (node) => {
        const { dict } = node;
        if (nameOf(dict.get(PDFName.of('Subtype'))) === '/Widget') {
            const kind = classifyField(doc, dict);
            if (kind.kind === 'unreadable') {
                unclassified.push(kind.reason);
                return;
            }
            if (kind.kind === 'signature') {
                count += 1;
                return;
            }
        }
        const isFieldValue = (node.depth === 0 && valueTags.has(node.rootTag))
            || valueDicts.has(dict);
        if (signatureRemnantOf(dict, isFieldValue) !== null) count += 1;
    });
    if (!outcome.complete) return outcome;
    if (unclassified.length > 0) {
        return {
            complete: false,
            reason: `書き出したPDFに、署名欄かどうかを判定できない注釈があります: ${unclassified[0]}`,
            nodes: outcome.nodes,
            roots: outcome.roots,
        };
    }
    return { complete: true, value: count, nodes: outcome.nodes, roots: outcome.roots };
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
