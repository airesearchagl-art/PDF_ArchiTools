/**
 * Every place a JavaScript action can hide, visited on purpose — and then the
 * object table, because removing a reference is not removing an object.
 * Adopted M6-H9c.
 *
 * The contract is *no JavaScript action survives a sanitized result*, not *the
 * sites we happened to inspect were clean*, and there are two ways to be wrong
 * about it:
 *
 *   1. Not looking everywhere a reference can be. An array means different
 *      things in different places, and only the key holding it says which: a
 *      destination under `/OpenAction`, `/Dest` or `/D`; a **list of actions**
 *      under `/Next`, every element of which has to be walked. An earlier
 *      version of this scan treated every array as a destination and stopped, so
 *      JavaScript inside a `/Next` array was never visited and the document
 *      passed.
 *   2. Counting reachability and calling it removal. An action held as an
 *      indirect object stays registered in the object table after the key
 *      pointing at it is deleted, and pdf-lib writes everything registered,
 *      reachable or not — the same mechanism that leaves orphaned pages behind
 *      after a `copyPages`. "No reachable JavaScript" would be a true sentence
 *      about a file that still carried the script.
 *
 * So a sanitized artifact is measured twice, and the contract is **both counts
 * at zero**.
 */
import { PDFArray, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { MECHANISM_BOUNDS } from './policy';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

function look(doc: PDFDocument, value: unknown): unknown {
    try {
        if (value instanceof PDFRef) return doc.context.lookup(value);
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Whether a dictionary carries JavaScript, whatever it calls itself.
 *
 * `/S /JavaScript` is the obvious form and not the only one. A Rendition
 * action carries its script in `/JS` under `/S /Rendition`, and this scanner
 * — which asked only about `/S` — reported **zero** for a document whose
 * action held `/JS`. The question is about the script, not the subtype.
 */
export const actionCarriesJavaScript = (dict: PDFDict): boolean =>
    dict.get(PDFName.of('JS')) !== undefined
    || nameOf(dict.get(PDFName.of('S'))) === '/JavaScript';

/**
 * Round 9, the BLK-R8R-1 rule applied to scripts: `/JS` is evidence to inspect,
 * not authority to empty a dictionary.
 *
 * Removing JavaScript means taking an **action** apart. Both removers used to
 * take apart whatever carried `/JS` or `/S /JavaScript`, and a dictionary can
 * carry either key while being something else entirely. Measured, READY: a
 * form XObject a page draws carried a stray `/JS`, its stream dictionary was
 * emptied — `/Subtype`, `/BBox`, `/Resources` with it — and the drawing was
 * gone from the artifact with no loss reported.
 *
 * So a carrier is only removed as JavaScript when nothing about it says it is
 * something else. A stream, a `/Type` other than `/Action`, or any `/Subtype`
 * is positive evidence of another role, and the answer is a typed refusal
 * rather than a guess about which role to destroy. Returns what the conflict
 * is, or null for an action-shaped carrier.
 */
export function javaScriptCarrierConflict(dict: PDFDict, isStream: boolean): string | null {
    if (isStream) return 'is a stream, not an action';
    const type = nameOf(dict.get(PDFName.of('Type')));
    if (type !== '' && type !== '/Action') return `is ${type}, not an action`;
    const subtype = nameOf(dict.get(PDFName.of('Subtype')));
    if (subtype !== '') return `has /Subtype ${subtype}, which no action has`;
    return null;
}

/** A document the scanner cannot finish inspecting is refused, never passed. */
class Unscannable extends Error {}

/**
 * Keys whose value may legitimately be a **destination** rather than an action.
 * Everywhere else, an array is a list of actions.
 */
const DESTINATION_KEYS = new Set(['OpenAction', 'Dest', 'D']);

interface FoundAction {
    /** The dictionary or array the reference lives on. */
    holder: PDFDict | PDFArray;
    /** The key, or the index when the holder is an array. */
    key: string | number;
    inArray?: boolean;
    inNameTree?: boolean;
    ref: PDFRef | null;
}

export interface JavaScriptScan {
    count: number;
    found: FoundAction[];
    /** How many times a site was reached, before deduplication. */
    visits: number;
    incomplete: string[];
    complete: boolean;
}

function walkActionValue(
    doc: PDFDocument,
    raw: unknown,
    owner: { holder: PDFDict | PDFArray; key: string | number; inArray?: boolean },
    found: FoundAction[],
    depth: number,
    seen: Set<string>,
): void {
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable(`action chain deeper than ${MECHANISM_BOUNDS.maxActionDepth}`);
    }
    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) throw new Unscannable('cyclic action chain');
        seen.add(raw.tag);
    }
    const action = look(doc, raw);
    if (!(action instanceof PDFDict)) {
        throw new Unscannable('an action position holds neither an action nor a destination');
    }
    if (actionCarriesJavaScript(action)) {
        found.push({ ...owner, ref: raw instanceof PDFRef ? raw : null });
    }
    walkAction(doc, action, 'Next', found, depth + 1, seen);
}

function walkAction(
    doc: PDFDocument,
    holder: PDFDict,
    key: string,
    found: FoundAction[],
    depth: number,
    seen: Set<string>,
): void {
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable(`action chain deeper than ${MECHANISM_BOUNDS.maxActionDepth}`);
    }

    const resolved = look(doc, raw);

    if (resolved instanceof PDFArray) {
        if (DESTINATION_KEYS.has(key)) return;
        for (let i = 0; i < resolved.size(); i += 1) {
            walkActionValue(
                doc,
                resolved.get(i),
                { holder: resolved, key: i, inArray: true },
                found,
                depth + 1,
                new Set(seen),
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

    if (actionCarriesJavaScript(resolved)) {
        // The reference is recorded next to the holder: deleting the key
        // detaches the action, and deleting the object is what removes it.
        found.push({ holder, key, ref: raw instanceof PDFRef ? raw : null });
    }
    walkAction(doc, resolved, 'Next', found, depth + 1, seen);
}

function walkAdditionalActions(
    doc: PDFDocument,
    owner: PDFDict,
    found: FoundAction[],
    depth: number,
): void {
    const aa = look(doc, owner.get(PDFName.of('AA')));
    if (aa === undefined) return;
    if (!(aa instanceof PDFDict)) throw new Unscannable('/AA is not a dictionary');
    for (const [key] of aa.entries()) {
        walkAction(doc, aa, key.asString().replace(/^\//, ''), found, depth, new Set());
    }
}

function walkJavaScriptNameTree(
    doc: PDFDocument,
    node: unknown,
    found: FoundAction[],
    depth: number,
): void {
    if (!(node instanceof PDFDict)) return;
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable('name tree deeper than the bound');
    }
    const names = look(doc, node.get(PDFName.of('Names')));
    if (names instanceof PDFArray) {
        for (let i = 0; i + 1 < names.size(); i += 2) {
            const raw = names.get(i + 1);
            const entry = look(doc, raw);
            if (entry instanceof PDFDict && actionCarriesJavaScript(entry)) {
                found.push({
                    holder: names,
                    key: i + 1,
                    inNameTree: true,
                    ref: raw instanceof PDFRef ? raw : null,
                });
            }
        }
    }
    const kids = look(doc, node.get(PDFName.of('Kids')));
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
export function scanJavaScript(doc: PDFDocument): JavaScriptScan {
    const found: FoundAction[] = [];
    const incomplete: string[] = [];

    const site = (label: string, fn: () => void): void => {
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
        const names = look(doc, doc.catalog.get(PDFName.of('Names')));
        if (names instanceof PDFDict) {
            walkJavaScriptNameTree(doc, look(doc, names.get(PDFName.of('JavaScript'))), found, 0);
        }
    });

    doc.getPages().forEach((page, index) => {
        site(`page ${index} /AA`, () => walkAdditionalActions(doc, page.node, found, 0));
        site(`page ${index} /Annots`, () => {
            const annots = look(doc, page.node.get(PDFName.of('Annots')));
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
        const acro = look(doc, doc.catalog.get(PDFName.of('AcroForm')));
        if (!(acro instanceof PDFDict)) return;
        const walkFields = (entries: unknown[], depth: number): void => {
            if (depth > MECHANISM_BOUNDS.maxActionDepth) {
                throw new Unscannable('field tree deeper than the bound');
            }
            for (const raw of entries) {
                const field = look(doc, raw);
                if (!(field instanceof PDFDict)) continue;
                walkAction(doc, field, 'A', found, 0, new Set());
                walkAdditionalActions(doc, field, found, 0);
                const kids = look(doc, field.get(PDFName.of('Kids')));
                if (kids instanceof PDFArray) {
                    const list: unknown[] = [];
                    for (let i = 0; i < kids.size(); i += 1) list.push(kids.get(i));
                    walkFields(list, depth + 1);
                }
            }
        };
        const fields = look(doc, acro.get(PDFName.of('Fields')));
        if (fields instanceof PDFArray) {
            const list: unknown[] = [];
            for (let i = 0; i < fields.size(); i += 1) list.push(fields.get(i));
            walkFields(list, 0);
        }
    });

    /**
     * One action can be reached by more than one route — a form field's widget
     * is both a page annotation and an AcroForm field, so its `/AA` is visited
     * twice. Sites are identified by the dictionary holding them and the key
     * they are held under, so the count describes the document rather than the
     * walk.
     */
    const holderIds = new WeakMap<object, number>();
    let nextHolderId = 1;
    const siteKey = (holder: object, key: string | number): string => {
        let id = holderIds.get(holder);
        if (id === undefined) {
            id = nextHolderId;
            nextHolderId += 1;
            holderIds.set(holder, id);
        }
        return `${id}#${key}`;
    };

    const seen = new Set<string>();
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


export type SanitizeOutcome =
    | { status: 'REFUSED'; incomplete: string[]; reason: string }
    /** A `/JS` carrier that is provably something besides an action. Round 9. */
    | { status: 'UNSAFE'; conflicts: string[]; reason: string }
    | { status: 'READY'; removedReferences: number; removedObjects: number };

/**
 * Remove every JavaScript action: the reference **and** the object.
 *
 * Every reference found is removed before any object is deleted, so nothing is
 * deleted out from under a reference this scan knows about. A scan that could
 * not complete refuses, so there is never a "probably nothing else points at
 * it".
 */
export function sanitizeJavaScript(doc: PDFDocument): SanitizeOutcome {
    const scan = scanJavaScript(doc);
    if (!scan.complete) {
        return {
            status: 'REFUSED',
            incomplete: scan.incomplete,
            reason: `この文書のアクション構造を完全に検査できませんでした: ${scan.incomplete.join(', ')}`,
        };
    }

    // Round 9: every indirect carrier this function would take apart is an
    // action, or nothing is touched. Asked before the first reference goes.
    const conflicts: string[] = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        const inner = (obj as unknown as { dict?: unknown })?.dict;
        const isStream = !(obj instanceof PDFDict) && inner instanceof PDFDict;
        const dict = obj instanceof PDFDict ? obj : inner instanceof PDFDict ? inner : null;
        if (!dict || !actionCarriesJavaScript(dict)) continue;
        const conflict = javaScriptCarrierConflict(dict, isStream);
        if (conflict) conflicts.push(`object ${ref.tag} carries JavaScript but ${conflict}`);
    }
    if (conflicts.length > 0) {
        return { status: 'UNSAFE', conflicts, reason: conflicts.join('; ') };
    }

    let removedReferences = 0;

    // Array elements are taken out by index and in descending order: removing
    // element 0 first would shift every later index out from under the removals
    // still to come.
    const arrayRemovals = new Map<PDFArray, number[]>();

    for (const item of scan.found) {
        if (item.inNameTree && item.holder instanceof PDFArray) {
            item.holder.set(Number(item.key), doc.context.obj({} as never));
            removedReferences += 1;
            continue;
        }
        if (item.inArray && item.holder instanceof PDFArray) {
            const list = arrayRemovals.get(item.holder) ?? [];
            list.push(Number(item.key));
            arrayRemovals.set(item.holder, list);
            continue;
        }
        if (item.holder instanceof PDFDict) {
            item.holder.delete(PDFName.of(String(item.key)));
            removedReferences += 1;
        }
    }

    for (const [array, indices] of arrayRemovals) {
        for (const index of [...new Set(indices)].sort((a, b) => b - a)) {
            array.remove(index);
            removedReferences += 1;
        }
    }

    // The name tree goes once it holds nothing worth keeping.
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript')) !== undefined) {
        names.delete(PDFName.of('JavaScript'));
    }

    // Now the objects — every JavaScript action dictionary in the table, not
    // only the ones the walk reached. An object nobody points at is exactly the
    // remnant this step exists for.
    let removedObjects = 0;
    const doomed: PDFRef[] = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (!actionCarriesJavaScript(obj)) continue;
        doomed.push(ref);
    }
    for (const ref of doomed) {
        const obj = doc.context.lookup(ref);
        if (obj instanceof PDFDict) {
            // Scrubbed first, then deleted. If some path this contract has not
            // modelled still holds the reference, what it finds is an empty
            // dictionary rather than a script.
            for (const [key] of [...obj.entries()]) obj.delete(key);
        }
        doc.context.delete(ref);
        removedObjects += 1;
    }

    return { status: 'READY', removedReferences, removedObjects };
}
