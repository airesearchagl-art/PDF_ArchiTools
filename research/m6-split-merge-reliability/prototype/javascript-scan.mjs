/**
 * Every place a JavaScript action can hide, visited on purpose.
 *
 * Not production code. The contract this has to support is
 *
 *     no JavaScript action survives a sanitized result
 *
 * and not "the sites we happened to inspect were clean". So the scanner
 * enumerates the action-bearing structures the contract promises to cover, and
 * anything it cannot finish inspecting — a chain deeper than the bound, a cycle,
 * an action dictionary it cannot read — makes the document a typed refusal
 * rather than a quiet pass.
 *
 * Sites covered:
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
 * Walk one action and its `/Next` chain, reporting every JavaScript action.
 *
 * `remove` is passed the dictionary that *holds* the action and the key it is
 * held under, so a sanitizer can take it out at the right level: an `/A` is
 * removed from its annotation, a `/Next` is spliced out of its parent action.
 */
function walkAction(doc, holder, key, found, depth, seen) {
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (depth > MAX_ACTION_DEPTH) throw new Unscannable(`action chain deeper than ${MAX_ACTION_DEPTH}`);
    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) throw new Unscannable('cyclic action chain');
        seen.add(raw.tag);
    }
    const action = look(doc, raw);
    // A destination array is a legitimate value here and is not an action.
    if (action instanceof PDFArray) return;
    if (!(action instanceof PDFDict)) throw new Unscannable(`${key} is neither an action nor a destination`);

    const s = nameOf(action.get(PDFName.of('S')));
    if (s === '/JavaScript') found.push({ holder, key, kind: 'JavaScript' });
    walkAction(doc, action, 'Next', found, depth + 1, seen);
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
            const entry = look(doc, names.get(i + 1));
            if (entry instanceof PDFDict && nameOf(entry.get(PDFName.of('S'))) === '/JavaScript') {
                found.push({ holder: names, key: String(i + 1), kind: 'JavaScript', inNameTree: true });
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
 * Find every JavaScript action, and say plainly when the document could not be
 * inspected completely.
 */
export function scanJavaScript(doc) {
    const found = [];
    const incomplete = [];

    /**
     * One action can be reached by more than one route — a form field's widget
     * is both a page annotation and an AcroForm field, so its `/AA` is visited
     * twice. The first version of this scanner reported that document as
     * holding two JavaScript actions when it holds one. Sites are identified by
     * the dictionary that holds them and the key it is held under, so the count
     * describes the document rather than the walk.
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
        incomplete,
        complete: incomplete.length === 0,
    };
}

/**
 * Remove every JavaScript action the scan found.
 *
 * A name-tree entry is removed by emptying its value rather than resplicing the
 * array, because the pair positions are what the tree's ordering depends on;
 * an action held under a key is deleted from its holder, which also detaches
 * anything chained behind it through `/Next`.
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
    let removed = 0;
    for (const item of scan.found) {
        if (item.inNameTree) {
            const index = Number(item.key);
            item.holder.set(index, doc.context.obj({}));
            removed += 1;
            continue;
        }
        item.holder.delete(PDFName.of(item.key));
        removed += 1;
    }
    // The name tree itself is removed once it holds nothing worth keeping.
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript')) !== undefined) {
        names.delete(PDFName.of('JavaScript'));
    }
    return { status: 'READY', removed };
}

/**
 * Extract with JavaScript sanitized, and prove it by reopening the result.
 *
 * A sanitizer that reports what it removed is describing its own intent. The
 * count that matters is the one taken from the bytes afterwards.
 */
export async function extractSanitized(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const before = scanJavaScript(doc);

    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));

    const result = sanitizeJavaScript(out);
    if (result.status === 'REFUSED') return { ...result, beforeCount: before.count };

    const bytes = await out.save({ useObjectStreams: false });
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const after = scanJavaScript(reopened);
    return {
        status: 'READY',
        bytes,
        beforeCount: before.count,
        removed: result.removed,
        remainingAfterReadback: after.count,
        readbackComplete: after.complete,
    };
}

/** Exported for the gate: a document JavaScript marker, for fixture checks. */
export const JS_MARKER = PDFString.of('/* M6 */');
