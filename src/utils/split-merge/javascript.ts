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
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import { ActionTraversal } from './action-traversal';
import { CENSUS_BUDGET, censusIndirectObjects, reachableRefTags } from './census';
import type { CensusNode, CensusOutcome } from './census';
import { MECHANISM_BOUNDS } from './policy';
import { UNSCANNABLE_ACTIONS_REASON_JA } from './contracts';
import type { JavaScriptSafety } from './contracts';

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
 * A dictionary entry that is a **name**, or the empty string. A string that
 * merely reads like one — `/S (JavaScript)` — is not an `/S` at all: the
 * vocabulary below is a vocabulary of names, and an entry that is not one says
 * nothing.
 */
const nameEntry = (dict: PDFDict, key: string): string => {
    const value = dict.get(PDFName.of(key));
    return value instanceof PDFName ? value.asString() : '';
};

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

// ---------------------------------------------------------------------------
// Round 11 — the closed vocabulary of actions
// ---------------------------------------------------------------------------

/**
 * Every action type the specification defines (ISO 32000-1 §12.6.4), and
 * nothing else.
 *
 * M6 adds no support for any of them: the scan already walks an action chain
 * through whatever it finds, and this list only says what may be **recognised**
 * as an action while it does. `/S` present is not recognition — `/S` is also a
 * transparency group's subtype, a structure element's type, a border style's
 * style and a page transition's kind. An `/S` whose value is not in this set is
 * not an action, and is refused rather than guessed at.
 */
export const ACTION_SUBTYPES: ReadonlySet<string> = new Set([
    '/GoTo', '/GoToR', '/GoToE', '/Launch', '/Thread', '/URI', '/Sound', '/Movie',
    '/Hide', '/Named', '/SubmitForm', '/ResetForm', '/ImportData', '/JavaScript',
    '/SetOCGState', '/Rendition', '/Trans', '/GoTo3DView',
]);

/**
 * The action types this contract already takes a script out of: the obvious
 * `/S /JavaScript`, and a Rendition action, which carries its script in `/JS`
 * (see {@link actionCarriesJavaScript}). A recognised action of any other type
 * that carries `/JS` is malformed — nothing defines a script there — and is not
 * given a destructive answer.
 */
export const SCRIPT_ACTION_SUBTYPES: ReadonlySet<string> = new Set(['/JavaScript', '/Rendition']);

/**
 * Whether a dictionary is, by its own shape, a proven action: a recognised
 * `/S`, and nothing that says it is something else.
 *
 * `/Type /Action` alone is not proof. It is evidence, and it does not turn a
 * dictionary with no `/S` — or an `/S` this contract does not recognise — into
 * something that may be taken apart.
 */
export function isProvenAction(dict: PDFDict): boolean {
    const type = nameOf(dict.get(PDFName.of('Type')));
    if (type !== '' && type !== '/Action') return false;
    if (nameOf(dict.get(PDFName.of('Subtype'))) !== '') return false;
    return ACTION_SUBTYPES.has(nameEntry(dict, 'S'));
}

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
 * **Round 10 — BLK-R9R-1.** Asking what *contradicts* "action" was the wrong
 * way round: most PDF dictionaries are typeless, and a typeless one carrying a
 * stray `/JS` passed every clause and was deleted. The question is what
 * **establishes** it.
 *
 * **Round 11 — BLK-R10R-1.** Round 10 took `/S` for that proof, and `/S` is not
 * proof: it names a transparency group, a structure element, a border style. An
 * action's `/S` is one of a closed set of values ({@link ACTION_SUBTYPES}), and
 * the ones that carry a script are {@link SCRIPT_ACTION_SUBTYPES}. Anything
 * else — no `/S`, an `/S` that is not a name, an unknown one, a recognised one
 * that has no script to carry — is refused, whatever `/Type` it declares.
 *
 * Shape is half the proof; {@link classifyJavaScript} supplies the other half.
 * Returns what the conflict is, or null for an action-shaped carrier.
 */
export function javaScriptCarrierConflict(dict: PDFDict, isStream: boolean): string | null {
    if (isStream) return 'is a stream, not an action';
    const type = nameOf(dict.get(PDFName.of('Type')));
    if (type !== '' && type !== '/Action') return `is ${type}, not an action`;
    const subtype = nameOf(dict.get(PDFName.of('Subtype')));
    if (subtype !== '') return `has /Subtype ${subtype}, which no action has`;
    const s = nameEntry(dict, 'S');
    if (s === '') {
        return type === '/Action'
            ? 'declares /Type /Action but carries no /S, so it is a malformed action'
            : 'carries no /S and no /Type /Action, so nothing says it is one';
    }
    if (!ACTION_SUBTYPES.has(s)) return `has /S ${s}, which is not an action type`;
    if (!SCRIPT_ACTION_SUBTYPES.has(s)) return `is a ${s} action, which has no script to carry`;
    return null;
}

/** A stable small number for an object, for building position keys. */
type IdOf = (object: object) => number;

const makeIdOf = (): IdOf => {
    const ids = new WeakMap<object, number>();
    let next = 1;
    return (object) => {
        let id = ids.get(object);
        if (id === undefined) {
            id = next;
            next += 1;
            ids.set(object, id);
        }
        return id;
    };
};

// ---------------------------------------------------------------------------
// The scan: where an action may sit
// ---------------------------------------------------------------------------

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

/**
 * What the scan learned about **where** an action may sit, beyond which of them
 * carry a script.
 *
 * Round 11. The scan starts from a holder whose identity it knows — the
 * catalog, a page, an entry of a page's `/Annots`, an AcroForm field, the
 * `/Names /JavaScript` tree — and the positions it reaches from those are the
 * only *rooted* action positions there are. {@link classifyJavaScript} does not
 * re-derive them from key names; it asks whether a reference sits at one of
 * these, or hangs from an action that is itself proven.
 */
export interface ActionWalk {
    scan: JavaScriptScan;
    /**
     * The rooted action positions: `holder#key` for a single value and
     * `holder#key#index` for one value of a name tree's `/Names` array.
     */
    positions: Set<string>;
    idOf: IdOf;
}

interface WalkSink {
    found: FoundAction[];
    positions: Set<string>;
    idOf: IdOf;
    /**
     * Which actions this walk is reading and which it has read, so an action that
     * many paths reach is read once per depth and not once per path. Round 12B.
     * One for the whole walk: what an action leads to does not depend on which
     * root reached it, and every *site* is recorded before this is asked.
     */
    traversal: ActionTraversal;
}

/**
 * How a position came to be one. `openaction`, `a` and `aa` are positions of a
 * holder the caller identified: the catalog, an annotation or field, and the
 * `/AA` of one of those (or of a page). `next` is not a *rooted* position — it
 * is an action position only because of the action it hangs from, which the
 * classifier judges, so the scan walks it and records nothing.
 */
type PositionVia = 'openaction' | 'a' | 'aa' | 'next';

/** A rooted position's key; the classifier builds the same key from a reference. */
export const positionKey = (idOf: IdOf, holder: object, key: string, index?: number): string =>
    index === undefined ? `${idOf(holder)}#${key}` : `${idOf(holder)}#${key}#${index}`;

/**
 * What follows an action: whatever its `/Next` holds, one hop below it.
 *
 * An indirect action is read through the traversal, once per depth it is reached
 * at that has not been read at already (see `action-traversal.ts`), so a list
 * that names the same action twice reads it once and not twice. An action that is
 * being read now and is reached again is a cycle, and is refused before anything
 * is skipped for having been read. A direct dictionary has no identity to remember
 * and is read wherever whatever holds it is read.
 *
 * The caller has recorded the *site* — the holder and key that name this action —
 * before asking. Skipping what follows an action never skips a site, and the
 * sites below it were recorded the first time.
 */
function walkNext(
    doc: PDFDocument,
    action: PDFDict,
    raw: unknown,
    sink: WalkSink,
    depth: number,
): void {
    if (!(raw instanceof PDFRef)) {
        walkAction(doc, action, 'Next', sink, depth + 1, 'next');
        return;
    }
    if (!sink.traversal.begin(raw.tag, depth)) return;
    let finished = false;
    try {
        walkAction(doc, action, 'Next', sink, depth + 1, 'next');
        finished = true;
    } finally {
        sink.traversal.end(raw.tag, depth, finished);
    }
}

function walkActionValue(
    doc: PDFDocument,
    raw: unknown,
    owner: { holder: PDFArray; key: number; inArray: true },
    sink: WalkSink,
    depth: number,
): void {
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable(`action chain deeper than ${MECHANISM_BOUNDS.maxActionDepth}`);
    }
    if (raw instanceof PDFRef && sink.traversal.isActive(raw.tag)) {
        throw new Unscannable('cyclic action chain');
    }
    const action = look(doc, raw);
    if (!(action instanceof PDFDict)) {
        throw new Unscannable('an action position holds neither an action nor a destination');
    }
    if (actionCarriesJavaScript(action)) {
        sink.found.push({ ...owner, ref: raw instanceof PDFRef ? raw : null });
    }
    walkNext(doc, action, raw, sink, depth);
}

function walkAction(
    doc: PDFDocument,
    holder: PDFDict,
    key: string,
    sink: WalkSink,
    depth: number,
    via: PositionVia,
): void {
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable(`action chain deeper than ${MECHANISM_BOUNDS.maxActionDepth}`);
    }

    const resolved = look(doc, raw);

    if (resolved instanceof PDFArray) {
        if (DESTINATION_KEYS.has(key)) return;
        // A list of actions is walked wherever it is — the scan has to find a
        // script wherever one is — but it is a rooted position nowhere: only a
        // proven action's `/Next` list is an action position, and that is the
        // classifier's question.
        //
        // A `/Next` list is not a hop of its own. Each member is the action a
        // single `/Next` would have named, so it is read at the depth that action
        // would have had: one hop is one unit whether `/Next` holds one action or
        // a list of them, and the members of one list are siblings, not a queue.
        // Any other list keeps the level its container has always cost — it is
        // not a shape the format defines, and it is not what this is about.
        const memberDepth = key === 'Next' ? depth : depth + 1;
        // An indirect list is a node like an indirect action: reached again while it
        // is being read, it is a cycle, and read at a depth it has been read at, it
        // has nothing new. (Round 12B. A list whose members are direct dictionaries
        // that name the list again is a cycle with no indirect action in it, and the
        // only thing that used to stop it was the depth bound, after 2^33 paths.)
        const held = raw instanceof PDFRef ? raw : null;
        if (held) {
            if (sink.traversal.isActive(held.tag)) throw new Unscannable('cyclic action chain');
            if (!sink.traversal.begin(held.tag, memberDepth)) return;
        }
        let finished = false;
        try {
            for (let i = 0; i < resolved.size(); i += 1) {
                walkActionValue(
                    doc,
                    resolved.get(i),
                    { holder: resolved, key: i, inArray: true },
                    sink,
                    memberDepth,
                );
            }
            finished = true;
        } finally {
            if (held) sink.traversal.end(held.tag, memberDepth, finished);
        }
        return;
    }

    if (raw instanceof PDFRef && sink.traversal.isActive(raw.tag)) {
        throw new Unscannable('cyclic action chain');
    }
    if (!(resolved instanceof PDFDict)) {
        throw new Unscannable(`${key} is neither an action nor a destination`);
    }

    // A rooted position is an action position because of where it is. The key's
    // name alone is nothing: `/Resources /ExtGState /A` is a resource called "A".
    if (via !== 'next') sink.positions.add(positionKey(sink.idOf, holder, key));
    if (actionCarriesJavaScript(resolved)) {
        // The reference is recorded next to the holder: deleting the key
        // detaches the action, and deleting the object is what removes it.
        sink.found.push({ holder, key, ref: raw instanceof PDFRef ? raw : null });
    }
    walkNext(doc, resolved, raw, sink, depth);
}

/**
 * An `/AA` belongs to whoever holds it, and the callers only hand this the
 * catalog, a page, an annotation or a field. The container is not an action;
 * each of its entries is an action position.
 */
function walkAdditionalActions(
    doc: PDFDocument,
    owner: PDFDict,
    sink: WalkSink,
    depth: number,
): void {
    const aa = look(doc, owner.get(PDFName.of('AA')));
    if (aa === undefined) return;
    if (!(aa instanceof PDFDict)) throw new Unscannable('/AA is not a dictionary');
    for (const [key] of aa.entries()) {
        walkAction(doc, aa, key.asString().replace(/^\//, ''), sink, depth, 'aa');
    }
}

function walkJavaScriptNameTree(
    doc: PDFDocument,
    node: unknown,
    sink: WalkSink,
    depth: number,
): void {
    if (!(node instanceof PDFDict)) return;
    if (depth > MECHANISM_BOUNDS.maxActionDepth) {
        throw new Unscannable('name tree deeper than the bound');
    }
    const names = look(doc, node.get(PDFName.of('Names')));
    if (names instanceof PDFArray) {
        // Values are at the odd indices. An even index is a name, and a name is
        // never an action.
        for (let i = 0; i + 1 < names.size(); i += 2) {
            const raw = names.get(i + 1);
            const entry = look(doc, raw);
            if (entry instanceof PDFDict) {
                sink.positions.add(positionKey(sink.idOf, node, 'Names', i + 1));
                if (actionCarriesJavaScript(entry)) {
                    sink.found.push({
                        holder: names,
                        key: i + 1,
                        inNameTree: true,
                        ref: raw instanceof PDFRef ? raw : null,
                    });
                }
            }
        }
    }
    const kids = look(doc, node.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i += 1) {
            walkJavaScriptNameTree(doc, look(doc, kids.get(i)), sink, depth + 1);
        }
    }
}

/**
 * Walk every action position in the document. The one definition of a *rooted*
 * action position — {@link scanJavaScript} reports what it found, and
 * {@link classifyJavaScript} reads which references sit at one.
 */
export function walkActions(doc: PDFDocument, idOf: IdOf = makeIdOf()): ActionWalk {
    const found: FoundAction[] = [];
    const incomplete: string[] = [];
    const sink: WalkSink = { found, positions: new Set(), idOf, traversal: new ActionTraversal('javascript') };

    const site = (label: string, fn: () => void): void => {
        try {
            fn();
        } catch (error) {
            if (error instanceof Unscannable) incomplete.push(`${label}: ${error.message}`);
            else throw error;
        }
    };

    site('catalog /OpenAction', () =>
        walkAction(doc, doc.catalog, 'OpenAction', sink, 0, 'openaction'));
    site('catalog /AA', () => walkAdditionalActions(doc, doc.catalog, sink, 0));
    site('catalog /Names /JavaScript', () => {
        const names = look(doc, doc.catalog.get(PDFName.of('Names')));
        if (names instanceof PDFDict) {
            walkJavaScriptNameTree(doc, look(doc, names.get(PDFName.of('JavaScript'))), sink, 0);
        }
    });

    // A page tree that cannot be read is an incomplete scan, not an exception
    // the caller has to remember to catch.
    let pages: PDFPage[] = [];
    site('page tree', () => {
        try {
            pages = doc.getPages();
        } catch (error) {
            throw new Unscannable(`the page tree could not be read: ${String((error as Error)?.message ?? error)}`);
        }
    });
    pages.forEach((page, index) => {
        site(`page ${index} /AA`, () => walkAdditionalActions(doc, page.node, sink, 0));
        site(`page ${index} /Annots`, () => {
            const annots = look(doc, page.node.get(PDFName.of('Annots')));
            if (!(annots instanceof PDFArray)) return;
            for (let i = 0; i < annots.size(); i += 1) {
                const annot = look(doc, annots.get(i));
                if (!(annot instanceof PDFDict)) continue;
                walkAction(doc, annot, 'A', sink, 0, 'a');
                walkAdditionalActions(doc, annot, sink, 0);
            }
        });
    });

    site('AcroForm fields', () => {
        const acro = look(doc, doc.catalog.get(PDFName.of('AcroForm')));
        if (!(acro instanceof PDFDict)) return;
        /**
         * A field's `/Parent` is a field too, and its `/A` and `/AA` are as much
         * actions as the ones below it — including when the form's own field
         * list does not reach it, which is what a malformed hierarchy looks like
         * and what an AcroForm rebuild leaves behind. Walked to the bound the
         * inheritance readers use, and a chain that is deeper than that is an
         * incomplete scan, not a short one.
         */
        const walkFieldAncestors = (field: PDFDict): void => {
            const visited = new Set<PDFDict>([field]);
            let current: unknown = look(doc, field.get(PDFName.of('Parent')));
            for (let depth = 0; current instanceof PDFDict; depth += 1) {
                if (visited.has(current)) return;
                if (depth >= MECHANISM_BOUNDS.maxInheritanceDepth) {
                    throw new Unscannable('field ancestry deeper than the bound');
                }
                visited.add(current);
                walkAction(doc, current, 'A', sink, 0, 'a');
                walkAdditionalActions(doc, current, sink, 0);
                current = look(doc, current.get(PDFName.of('Parent')));
            }
        };
        const walkFields = (entries: unknown[], depth: number): void => {
            if (depth > MECHANISM_BOUNDS.maxActionDepth) {
                throw new Unscannable('field tree deeper than the bound');
            }
            for (const raw of entries) {
                const field = look(doc, raw);
                if (!(field instanceof PDFDict)) continue;
                walkAction(doc, field, 'A', sink, 0, 'a');
                walkAdditionalActions(doc, field, sink, 0);
                walkFieldAncestors(field);
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
    const seen = new Set<string>();
    const unique = found.filter((item) => {
        const k = `${idOf(item.holder)}#${item.key}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    return {
        scan: {
            count: unique.length,
            found: unique,
            visits: found.length,
            incomplete,
            complete: incomplete.length === 0,
        },
        positions: sink.positions,
        idOf,
    };
}

/**
 * Find every reachable JavaScript action, and say plainly when the document
 * could not be inspected completely.
 */
export function scanJavaScript(doc: PDFDocument): JavaScriptScan {
    return walkActions(doc).scan;
}

// ---------------------------------------------------------------------------
// Who owns a JavaScript carrier
// ---------------------------------------------------------------------------

/**
 * Where one reference is held. An indirect array's holder is found through it.
 *
 * Deliberately a second implementation of the shape `prune.ts` uses for
 * attachments rather than a shared one. Detection stays domain-specific here
 * for the same reason the censuses are separate: a change to what counts as an
 * action must not be able to change what counts as an attachment.
 *
 * `index` is where the reference sits in its array, and `nested` says the array
 * is itself inside another — a place no action position takes.
 */
type EdgeSite =
    | { kind: 'dict'; holder: PDFDict; key: string; viaArray: boolean; rootTag: string; index?: number; nested?: boolean }
    | { kind: 'array'; arrayTag: string; index?: number; nested?: boolean };

/** A reference's context, resolved to the dictionary and key that hold it. */
interface EdgeContext {
    holder: PDFDict;
    key: string;
    viaArray: boolean;
    rootTag: string;
    index?: number;
    nested: boolean;
}

export interface JavaScriptAnalysis {
    /** Every dictionary carrying JavaScript, as the census found it. */
    carriers: CensusNode[];
    /**
     * Why taking one of them apart would take something else with it. One
     * entry makes the whole removal a refusal.
     */
    unsafe: string[];
}

/**
 * BLK-R9R-1 / BLK-R10R-1 — decide, changing nothing, whether every JavaScript
 * carrier in the document can be taken apart without taking anything else with
 * it.
 *
 * Two things have to be true of a carrier before it is removed as JavaScript:
 *
 *   1. **Shape.** Its own dictionary is a proven action carrying a script
 *      ({@link javaScriptCarrierConflict}).
 *   2. **Holder and edge.** Every reference that reaches it sits at an action
 *      position. There are two kinds, and nothing else is one:
 *      - a **rooted** position — the catalog's `/OpenAction`; an entry of an
 *        `/AA` that a catalog, page, annotation or field holds; the `/A` of an
 *        annotation on a page or of an AcroForm field; a value slot of the
 *        `/Names /JavaScript` tree — which {@link walkActions} reaches from a
 *        holder whose identity it knows;
 *      - an action's **`/Next`** — but only when the holder is itself a proven
 *        action *and* every reference to that holder is an action position in
 *        turn. An action with no reference at all is an orphan a rebuild left
 *        behind on purpose, and its `/Next` is no less an action's.
 *
 * A key's *name* is not an edge. `/Resources /ExtGState /A` is a resource that
 * happens to be called "A", and `/Resources /Properties /Next` is a property
 * list; neither is an action position, and an action-shaped dictionary reached
 * only there is something else that happens to carry `/JS`. A dictionary
 * reached from `/ExtGState`, from a form's `/Group`, from a page's
 * `/Properties`, from an arbitrary dictionary's `/OpenAction`, `/A`, `/AA` or
 * `/Next`, from an array slot that is a name rather than a value, or from any
 * other place is refused rather than guessed at.
 *
 * COMPLETE or REFUSED, like every census here: an inbound index that could not
 * be proven to cover the document cannot prove exclusivity either. An
 * incomplete analysis is never read as "nothing else points at it".
 */
export function classifyJavaScript(
    doc: PDFDocument,
    walk: ActionWalk = walkActions(doc),
): CensusOutcome<JavaScriptAnalysis> {
    const carriers: CensusNode[] = [];
    /** Every dictionary that is, by its own shape, a proven action. */
    const provenActions = new Map<PDFDict, CensusNode>();
    const inbound = new Map<string, EdgeSite[]>();
    const arrayHolder = new Map<PDFArray, { site: EdgeSite; nested: boolean }>();
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
        arrayHolder.set(array, { site, nested: depth > 0 });
        const inner: EdgeSite = site.kind === 'dict' ? { ...site, viaArray: true } : site;
        for (let i = 0; i < array.size(); i += 1) {
            const item = array.get(i);
            if (item instanceof PDFRef) addEdge(item.tag, { ...inner, index: i, nested: depth > 0 });
            else if (item instanceof PDFArray) scanArray(item, inner, depth + 1);
        }
    };

    // Indirect arrays hold references too — an `/AA` value and a `/Next` list
    // very often are — and the census hands its visitor dictionaries only.
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
        if (actionCarriesJavaScript(dict)) carriers.push(node);
        // A stream is never an action, whatever its dictionary says.
        if (isProvenAction(dict) && !(node.depth === 0 && rootIsStream.has(rootTag))) {
            provenActions.set(dict, node);
        }
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

    /**
     * Every dictionary-and-key a reference is ultimately held under, or null.
     * `index` overrides where in its array a *direct* dictionary sits.
     */
    const contextsOf = (site: EdgeSite, index?: number): EdgeContext[] | null => {
        if (site.kind === 'dict') {
            return [{
                holder: site.holder,
                key: site.key,
                viaArray: site.viaArray,
                rootTag: site.rootTag,
                index: index ?? site.index,
                nested: site.nested === true,
            }];
        }
        const holders = inbound.get(site.arrayTag) ?? [];
        const out: EdgeContext[] = [];
        for (const holder of holders) {
            // An indirect array held by another indirect array is a shape no
            // action position takes, so it is not followed further.
            if (holder.kind !== 'dict') return null;
            out.push({
                holder: holder.holder,
                key: holder.key,
                viaArray: true,
                rootTag: holder.rootTag,
                index: index ?? site.index,
                // The array is itself an element of an array.
                nested: site.nested === true || holder.viaArray,
            });
        }
        return out;
    };
    const where = (c: EdgeContext): string =>
        `${c.rootTag} /${c.key}${c.viaArray && c.index !== undefined ? `[${c.index}]` : ''}`;

    /**
     * The contexts a census node is held under: for an indirect object, every
     * reference to it; for a direct dictionary, the one place it sits. Null when
     * that cannot be resolved, which is a refusal rather than a pass.
     */
    const contextsOfNode = (node: CensusNode): EdgeContext[] | null => {
        if (node.depth === 0) {
            const out: EdgeContext[] = [];
            for (const site of inbound.get(node.rootTag) ?? []) {
                const contexts = contextsOf(site);
                if (contexts === null) return null;
                out.push(...contexts);
            }
            return out;
        }
        const parent = node.parent;
        if (!parent) return null;
        if (parent.container instanceof PDFDict) {
            return [{
                holder: parent.container,
                key: String(parent.key),
                viaArray: false,
                rootTag: node.rootTag,
                nested: false,
            }];
        }
        const held = arrayHolder.get(parent.container);
        if (held) {
            const contexts = contextsOf(held.site, Number(parent.key));
            return contexts === null ? null : contexts.map((c) => ({ ...c, nested: c.nested || held.nested }));
        }
        const tag = rootArrayTag.get(parent.container);
        if (tag === undefined) return null;
        return contextsOf({ kind: 'array', arrayTag: tag }, Number(parent.key));
    };

    /**
     * Whether the object that holds a reference is itself unreachable — a copy
     * the rebuilds left registered, a field an AcroForm rebuild detached. What
     * such a holder points at is not a reason to refuse: nothing live depends on
     * it, and it is swept once the references are gone. Worked out only when a
     * reference has already failed the position test, so a document with nothing
     * to explain never pays for it.
     */
    let liveTags: Set<string> | null = null;
    const deadHolder = (c: EdgeContext): boolean => {
        liveTags ??= reachableRefTags(doc);
        return !liveTags.has(c.rootTag);
    };

    /** A rooted position: one the action walk reached from a known holder. */
    const rootedPosition = (c: EdgeContext): boolean => {
        if (!c.viaArray) return walk.positions.has(positionKey(walk.idOf, c.holder, c.key));
        if (c.nested || c.index === undefined) return false;
        return walk.positions.has(positionKey(walk.idOf, c.holder, c.key, c.index));
    };

    /** An action's `/Next`, single or a list, held by an action node. */
    const nextOf = (c: EdgeContext, actionNodes: ReadonlySet<PDFDict>): boolean =>
        c.key === 'Next'
        && (!c.viaArray || (!c.nested && c.index !== undefined))
        && actionNodes.has(c.holder);

    /**
     * The proven actions that are themselves at an action position, worked out
     * as the largest set in which every member's every reference is a rooted
     * position or the `/Next` of another member.
     *
     * Not a walk from the roots: an orphan — the copy of an action a rebuild has
     * just replaced, still registered and holding its `/Next` — belongs here
     * too, and a proven action that sits in a resource dictionary does not. A
     * cycle of orphans is a member; a cycle that something outside it also
     * points at is not, and the removal spreads to whatever hangs from it.
     */
    let actionNodes: ReadonlySet<PDFDict> | null = null;
    const actionNodeSet = (): ReadonlySet<PDFDict> => {
        if (actionNodes) return actionNodes;
        const members = new Set<PDFDict>(provenActions.keys());
        const contexts = new Map<PDFDict, EdgeContext[] | null>();
        for (const [dict, node] of provenActions) contexts.set(dict, contextsOfNode(node));
        let changed = true;
        while (changed) {
            changed = false;
            for (const dict of [...members]) {
                const held = contexts.get(dict) ?? null;
                const ok = held !== null
                    && held.every((c) => rootedPosition(c) || nextOf(c, members) || deadHolder(c));
                if (!ok) {
                    members.delete(dict);
                    changed = true;
                }
            }
        }
        actionNodes = members;
        return members;
    };

    const atActionPosition = (c: EdgeContext): boolean =>
        rootedPosition(c) || (c.key === 'Next' && nextOf(c, actionNodeSet()));

    const unsafe: string[] = [];
    const note = (text: string): void => {
        if (!unsafe.includes(text)) unsafe.push(text);
    };

    for (const node of carriers) {
        const { dict, depth, rootTag } = node;
        const label = depth === 0 ? `object ${rootTag}` : `a dictionary inside ${rootTag}`;

        const conflict = javaScriptCarrierConflict(dict, depth === 0 && rootIsStream.has(rootTag));
        if (conflict) note(`${label} carries JavaScript but ${conflict}`);

        // An indirect carrier nothing points at is detached: `dropOpenAction`
        // and the destination and AcroForm rebuilds all orphan actions on
        // purpose, and removing one takes nothing with it. Its shape still has
        // to say action, which the check above has already asked. A direct
        // dictionary is always somewhere, and that place has to be an action's.
        const contexts = contextsOfNode(node);
        if (contexts === null) {
            note(depth === 0
                ? `${label} is reached through an indirect array held by another array`
                : `${label} carries JavaScript, and where it sits could not be resolved`);
            continue;
        }
        if (depth > 0 && contexts.length === 0) {
            note(`${label} carries JavaScript, and where it sits could not be resolved`);
            continue;
        }
        for (const c of contexts) {
            if (atActionPosition(c) || deadHolder(c)) continue;
            note(depth === 0
                ? `${label} is also reached from ${where(c)}, which is not an action position`
                : `${label} carries JavaScript at ${where(c)}, which is not an action position`);
        }
    }

    return {
        complete: true,
        value: { carriers, unsafe },
        nodes: outcome.nodes,
        roots: outcome.roots,
    };
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

/**
 * Everything known about the JavaScript in one document, from one walk.
 *
 * Round 11 (RF-R10R-1). The sanitizer asked two questions — was the action scan
 * complete, and is every carrier proven — and planning asked only the second, so
 * a document could plan READY and be refused as unscannable after the losses had
 * been agreed to. There is one assessment now; planning, intake, the sanitizer
 * and the scrub all ask it, so they cannot answer differently about the same
 * document.
 */
export type JavaScriptAssessment =
    | { status: 'SAFE'; scan: JavaScriptScan; carriers: CensusNode[] }
    | { status: 'UNSAFE_STRUCTURE'; scan: JavaScriptScan; carriers: CensusNode[]; unsafe: string[] }
    | { status: 'UNSCANNABLE'; incomplete: string[] }
    | { status: 'CENSUS_INCOMPLETE'; reason: string };

/**
 * The scan comes first: an action position that could not be read to the end
 * leaves the set of positions incomplete, and a carrier judged against an
 * incomplete set would be judged wrongly either way.
 *
 * Never throws. A walk that fails for a reason nobody anticipated is an
 * unscannable document, not an exception a caller has to remember to catch.
 */
export function assessJavaScript(doc: PDFDocument): JavaScriptAssessment {
    let walk: ActionWalk;
    try {
        walk = walkActions(doc);
    } catch (error) {
        return {
            status: 'UNSCANNABLE',
            incomplete: [`the action scan could not run: ${String((error as Error)?.message ?? error)}`],
        };
    }
    if (!walk.scan.complete) return { status: 'UNSCANNABLE', incomplete: walk.scan.incomplete };

    let owned: CensusOutcome<JavaScriptAnalysis>;
    try {
        owned = classifyJavaScript(doc, walk);
    } catch (error) {
        return {
            status: 'CENSUS_INCOMPLETE',
            reason: `the ownership analysis could not run: ${String((error as Error)?.message ?? error)}`,
        };
    }
    if (!owned.complete) return { status: 'CENSUS_INCOMPLETE', reason: owned.reason };
    if (owned.value.unsafe.length > 0) {
        return {
            status: 'UNSAFE_STRUCTURE',
            scan: walk.scan,
            carriers: owned.value.carriers,
            unsafe: [...owned.value.unsafe],
        };
    }
    return { status: 'SAFE', scan: walk.scan, carriers: owned.value.carriers };
}

/** The assessment as a source fact: what is known, without the walk behind it. */
export function javaScriptSafetyOf(assessment: JavaScriptAssessment): JavaScriptSafety {
    switch (assessment.status) {
        case 'SAFE':
            return { status: 'SAFE' };
        case 'UNSAFE_STRUCTURE':
            return { status: 'UNSAFE_STRUCTURE', unsafe: [...assessment.unsafe] };
        case 'UNSCANNABLE':
            return { status: 'UNSCANNABLE', incomplete: [...assessment.incomplete] };
        default:
            return { status: 'CENSUS_INCOMPLETE', reason: assessment.reason };
    }
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
 *
 * This is a backstop as much as a step: planning has already asked
 * {@link assessJavaScript} of the source, and this asks it again of the
 * artifact. An answer that differs from the planned one is a refusal, never a
 * reason to proceed because "it was checked at intake".
 */
export function sanitizeJavaScript(doc: PDFDocument): SanitizeOutcome {
    // Asked before the first reference goes, and asked through the same
    // assessment planning used, so the two cannot disagree.
    const assessed = assessJavaScript(doc);
    if (assessed.status === 'UNSCANNABLE') {
        return {
            status: 'REFUSED',
            incomplete: assessed.incomplete,
            reason: `${UNSCANNABLE_ACTIONS_REASON_JA}: ${assessed.incomplete.join(', ')}`,
        };
    }
    if (assessed.status === 'CENSUS_INCOMPLETE') {
        return {
            status: 'REFUSED',
            incomplete: [assessed.reason],
            reason: `${UNSCANNABLE_ACTIONS_REASON_JA}: ${assessed.reason}`,
        };
    }
    if (assessed.status === 'UNSAFE_STRUCTURE') {
        return {
            status: 'UNSAFE',
            conflicts: [...assessed.unsafe],
            reason: assessed.unsafe.join('; '),
        };
    }
    const scan = assessed.scan;

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
    // remnant this step exists for. Reached only after every carrier in the
    // table has been proven an action, at a place an action may be.
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
