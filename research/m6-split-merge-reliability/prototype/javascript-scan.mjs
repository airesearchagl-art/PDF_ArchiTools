/**
 * Every place a JavaScript action can hide, visited on purpose — and then the
 * object table, because removing a reference is not the same as removing an
 * object.
 *
 * Not production code. The contract is
 *
 *     no JavaScript action survives a sanitized result
 *
 * and there are two ways to be wrong about it. The first is not looking
 * everywhere a reference can be: that is what the reachable scan below covers,
 * and what `/Next` arrays taught this research the hard way. The second is
 * subtler and is the reason for `scanArtifactWide`: an action held as an
 * **indirect object** stays registered in the document's object table after the
 * key pointing at it is deleted, so a reachability scan reports zero while the
 * bytes still carry the script. M6 has already been bitten by exactly that
 * class of remanence once, with pages that `copyPages` copied and never
 * inserted into `/Pages`.
 *
 * So a sanitized artifact is measured twice: reachable count, and object-table
 * count. Only both being zero is "the JavaScript is gone".
 *
 * Sites covered by the reachable scan:
 *
 *   catalog /OpenAction                    a bare action, or a destination
 *   catalog /AA                            document-level additional actions
 *   catalog /Names /JavaScript             the document JavaScript name tree
 *   page /AA                               page open/close actions
 *   annotation /A and /AA                  including every sub-entry
 *   AcroForm field /AA and /A              walked through /Kids
 *   /Next                                  on every action found above
 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFString } from 'pdf-lib';

const nameOf = (v) => (typeof v?.asString === 'function' ? v.asString() : String(v ?? ''));
const look = (doc, v) => {
    try {
        return doc.context.lookup(v) ?? v;
    } catch {
        return undefined;
    }
};

/** How far a `/Next` chain or a field tree is followed before it is unreadable. */
export const MAX_ACTION_DEPTH = 32;

class Unscannable extends Error {}

/**
 * Keys whose value may legitimately be a **destination** rather than an action.
 *
 * `/Next` is defined as an action dictionary *or an array of them*, and an
 * earlier version of this scanner treated every array it met as a destination
 * and stopped — so a JavaScript action inside a `/Next` array was never
 * visited, and the document passed. An array means different things in
 * different places, and only the key it is stored under says which.
 */
const DESTINATION_KEYS = new Set(['OpenAction', 'Dest', 'D']);

/** One action, or one array of them, plus whatever is chained behind it. */
function walkActionValue(doc, raw, ownerFor, found, depth, seen) {
    if (depth > MAX_ACTION_DEPTH) throw new Unscannable(`action chain deeper than ${MAX_ACTION_DEPTH}`);
    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) throw new Unscannable('cyclic action chain');
        seen.add(raw.tag);
    }
    const action = look(doc, raw);
    if (!(action instanceof PDFDict)) {
        throw new Unscannable('an action position holds neither an action nor a destination');
    }
    const s = nameOf(action.get(PDFName.of('S')));
    if (s === '/JavaScript') {
        found.push({ ...ownerFor, kind: 'JavaScript', ref: raw instanceof PDFRef ? raw : null });
    }
    walkAction(doc, action, 'Next', found, depth + 1, seen);
}

function walkAction(doc, holder, key, found, depth, seen) {
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (depth > MAX_ACTION_DEPTH) throw new Unscannable(`action chain deeper than ${MAX_ACTION_DEPTH}`);

    const resolved = look(doc, raw);

    if (resolved instanceof PDFArray) {
        if (DESTINATION_KEYS.has(key)) return;
        for (let i = 0; i < resolved.size(); i += 1) {
            walkActionValue(
                doc, resolved.get(i),
                { holder: resolved, key: i, inArray: true },
                found, depth + 1, new Set(seen),
            );
        }
        return;
    }

    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) throw new Unscannable('cyclic action chain');
        seen.add(raw.tag);
    }
    if (!(resolved instanceof PDFDict)) {
        throw new Unscannable(`${key} is neither an action nor a destination`);
    }

    const s = nameOf(resolved.get(PDFName.of('S')));
    if (s === '/JavaScript') {
        // The reference is recorded alongside the holder: deleting the key
        // detaches the action, and deleting the object is what removes it.
        found.push({ holder, key, kind: 'JavaScript', ref: raw instanceof PDFRef ? raw : null });
    }
    walkAction(doc, resolved, 'Next', found, depth + 1, seen);
}

/** Every entry of an additional-actions dictionary. */
function walkAdditionalActions(doc, owner, found, depth) {
    const aa = look(doc, owner.get(PDFName.of('AA')));
    if (aa === undefined) return;
    if (!(aa instanceof PDFDict)) throw new Unscannable('/AA is not a dictionary');
    for (const [key] of aa.entries()) {
        walkAction(doc, aa, key.asString().replace(/^\//, ''), found, depth, new Set());
    }
}

/** The document JavaScript name tree, including its /Kids. */
function walkJavaScriptNameTree(doc, node, found, depth) {
    if (!(node instanceof PDFDict)) return;
    if (depth > MAX_ACTION_DEPTH) throw new Unscannable('name tree deeper than the bound');
    const names = node.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
        for (let i = 0; i + 1 < names.size(); i += 2) {
            const raw = names.get(i + 1);
            const entry = look(doc, raw);
            if (entry instanceof PDFDict && nameOf(entry.get(PDFName.of('S'))) === '/JavaScript') {
                found.push({
                    holder: names, key: String(i + 1), kind: 'JavaScript',
                    inNameTree: true, ref: raw instanceof PDFRef ? raw : null,
                });
            }
        }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i += 1) {
            walkJavaScriptNameTree(doc, look(doc, kids.get(i)), found, depth + 1);
        }
    }
}

/**
 * Find every reachable JavaScript action, and say plainly when the document
 * could not be inspected completely.
 */
export function scanJavaScript(doc) {
    const found = [];
    const incomplete = [];

    /**
     * One action can be reached by more than one route — a form field's widget
     * is both a page annotation and an AcroForm field, so its `/AA` is visited
     * twice. Sites are identified by the dictionary that holds them and the key
     * it is held under, so the count describes the document rather than the walk.
     */
    const holderIds = new WeakMap();
    let nextHolderId = 1;
    const siteKey = (holder, key) => {
        if (!holderIds.has(holder)) {
            holderIds.set(holder, nextHolderId);
            nextHolderId += 1;
        }
        return `${holderIds.get(holder)}#${key}`;
    };
    const site = (label, fn) => {
        try {
            fn();
        } catch (error) {
            if (error instanceof Unscannable) incomplete.push(`${label}: ${error.message}`);
            else throw error;
        }
    };

    site('catalog /OpenAction', () => walkAction(doc, doc.catalog, 'OpenAction', found, 0, new Set()));
    site('catalog /AA', () => walkAdditionalActions(doc, doc.catalog, found, 0));
    site('catalog /Names /JavaScript', () => {
        const names = doc.catalog.lookup(PDFName.of('Names'));
        if (names instanceof PDFDict) {
            walkJavaScriptNameTree(doc, names.lookup(PDFName.of('JavaScript')), found, 0);
        }
    });

    doc.getPages().forEach((page, index) => {
        site(`page ${index} /AA`, () => walkAdditionalActions(doc, page.node, found, 0));
        site(`page ${index} /Annots`, () => {
            const annots = page.node.lookup(PDFName.of('Annots'));
            if (!(annots instanceof PDFArray)) return;
            for (let i = 0; i < annots.size(); i += 1) {
                const annot = look(doc, annots.get(i));
                if (!(annot instanceof PDFDict)) continue;
                walkAction(doc, annot, 'A', found, 0, new Set());
                walkAdditionalActions(doc, annot, found, 0);
            }
        });
    });

    site('AcroForm fields', () => {
        const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
        if (!(acro instanceof PDFDict)) return;
        const walkFields = (entries, depth) => {
            if (depth > MAX_ACTION_DEPTH) throw new Unscannable('field tree deeper than the bound');
            for (const raw of entries) {
                const field = look(doc, raw);
                if (!(field instanceof PDFDict)) continue;
                walkAction(doc, field, 'A', found, 0, new Set());
                walkAdditionalActions(doc, field, found, 0);
                const kids = field.lookup(PDFName.of('Kids'));
                if (kids instanceof PDFArray) {
                    const list = [];
                    for (let i = 0; i < kids.size(); i += 1) list.push(kids.get(i));
                    walkFields(list, depth + 1);
                }
            }
        };
        const fields = acro.lookup(PDFName.of('Fields'));
        if (fields instanceof PDFArray) {
            const list = [];
            for (let i = 0; i < fields.size(); i += 1) list.push(fields.get(i));
            walkFields(list, 0);
        }
    });

    const seen = new Set();
    const unique = found.filter((item) => {
        const k = siteKey(item.holder, item.key);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    return {
        count: unique.length,
        found: unique,
        visits: found.length,
        indirectRefs: [...new Set(unique.filter((i) => i.ref).map((i) => i.ref.tag))],
        incomplete,
        complete: incomplete.length === 0,
    };
}

/**
 * The object table, independent of what can be reached from the catalog.
 *
 * This is the measurement the reachable scan cannot make. `enumerateIndirectObjects`
 * lists what the document will actually write, so a JavaScript action that was
 * detached but never deleted shows up here and nowhere else.
 */
export function scanArtifactWide(doc) {
    const actions = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('S'))) !== '/JavaScript') continue;
        actions.push({
            ref: ref.tag,
            hasJs: obj.get(PDFName.of('JS')) !== undefined,
        });
    }
    return { count: actions.length, actions };
}

/**
 * Remove every JavaScript action the scan found — the reference **and** the
 * object.
 *
 * Deleting the key detaches the action from the structure that reached it.
 * Deleting the indirect object is what keeps it out of the bytes: pdf-lib
 * writes everything registered in the context, reachable or not, which is the
 * same mechanism that leaves orphaned pages behind after a `copyPages`.
 *
 * Every reference found is removed before any object is deleted, so nothing is
 * deleted out from under a reference this scan knows about. A scan that could
 * not complete refuses, so there is no "probably nothing else points at it".
 */
export function sanitizeJavaScript(doc) {
    const scan = scanJavaScript(doc);
    if (!scan.complete) {
        return {
            status: 'REFUSED',
            code: 'UNSCANNABLE_ACTIONS',
            reason: `この文書のアクション構造を完全に検査できませんでした: ${scan.incomplete.join(', ')}`,
            incomplete: scan.incomplete,
        };
    }
    let removedReferences = 0;

    // Array elements are taken out by index, and in descending order, because
    // removing element 0 first would shift every later index out from under
    // the removals still to come.
    const arrayRemovals = new Map();
    for (const item of scan.found) {
        if (item.inNameTree) {
            const index = Number(item.key);
            item.holder.set(index, doc.context.obj({}));
            removedReferences += 1;
            continue;
        }
        if (item.inArray) {
            if (!arrayRemovals.has(item.holder)) arrayRemovals.set(item.holder, []);
            arrayRemovals.get(item.holder).push(item.key);
            continue;
        }
        item.holder.delete(PDFName.of(item.key));
        removedReferences += 1;
    }
    for (const [array, indices] of arrayRemovals) {
        for (const index of [...new Set(indices)].sort((a, b) => b - a)) {
            array.remove(index);
            removedReferences += 1;
        }
    }

    // The name tree itself is removed once it holds nothing worth keeping.
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript')) !== undefined) {
        names.delete(PDFName.of('JavaScript'));
    }

    // Now the objects. Every JavaScript action dictionary in the table goes,
    // not only the ones the walk reached: an object nobody points at is exactly
    // the remnant this step exists for, and leaving it would make "no reachable
    // JavaScript" true and "no JavaScript" false.
    let removedObjects = 0;
    const table = scanArtifactWide(doc);
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('S'))) !== '/JavaScript') continue;
        // Scrubbed first, then deleted. If some path this research has not
        // modelled still holds the reference, what it finds is an empty
        // dictionary rather than a script.
        for (const [key] of [...obj.entries()]) obj.delete(key);
        doc.context.delete(ref);
        removedObjects += 1;
    }

    return {
        status: 'READY',
        removed: removedReferences,
        removedObjects,
        objectsBefore: table.count,
    };
}

/**
 * Extract with JavaScript sanitized, and prove it by reopening the result —
 * twice over.
 *
 * A sanitizer that reports what it removed is describing its own intent. The
 * counts that matter are taken from the bytes afterwards, and there are two of
 * them: what a reader can reach, and what the object table holds.
 */
export async function extractSanitized(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const before = scanJavaScript(doc);
    const beforeArtifact = scanArtifactWide(doc);

    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));

    // What the copy brought across, before anything is removed. This is the
    // number that says whether the artifact ever held the action at all.
    const copiedArtifact = scanArtifactWide(out);

    const result = sanitizeJavaScript(out);
    if (result.status === 'REFUSED') {
        return { ...result, beforeCount: before.count, beforeArtifactCount: beforeArtifact.count };
    }

    const bytes = await out.save({ useObjectStreams: false });
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const after = scanJavaScript(reopened);
    const afterArtifact = scanArtifactWide(reopened);

    return {
        status: 'READY',
        bytes,
        beforeCount: before.count,
        beforeArtifactCount: beforeArtifact.count,
        copiedArtifactCount: copiedArtifact.count,
        removed: result.removed,
        removedObjects: result.removedObjects,
        remainingAfterReadback: after.count,
        remainingArtifactWide: afterArtifact.count,
        readbackComplete: after.complete,
    };
}

/** Exported for the gate: a document JavaScript marker, for fixture checks. */
export const JS_MARKER = PDFString.of('/* M6 */');
