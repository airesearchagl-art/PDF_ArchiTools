/**
 * Optional content, carried where it is understood and refused where it is not.
 * Adopted M6-H9b; the soft-mask path closed as B1.
 *
 * The measured problem: `copyPages` drops `/OCProperties` while the copied page
 * keeps the `/Resources /Properties` entry naming the group, so the artifact's
 * marked content references a configuration the document no longer has and a
 * viewer shows its own default instead of the author's. That is a visibility
 * change, not a harmless omission.
 *
 * Three things this module insists on, each of which a previous version of the
 * research got wrong first:
 *
 *   - **The mapping is structural.** Groups are matched through
 *     `(selected source page + /Properties key + source OCG ref)` to
 *     `(output page + same key + output OCG ref)`. Pairing by position worked
 *     for one kept page and could swap ON for OFF for two.
 *   - **The envelope is a detector, not a hope.** "Anything outside the handled
 *     shapes is refused" is only true if the unhandled shapes can be *found*.
 *     A page's resources are a graph: a form XObject, an appearance stream, a
 *     tiling pattern, a Type 3 font and a soft mask's `/G` each open a resource
 *     scope of their own, so marked content in any of them can name a group from
 *     a scope a page-level scan never opens. "Not in the page's resources" was
 *     being read as "not in the document".
 *   - **`/Order` is a structure, not a set.** It nests, it titles sections with
 *     labels, it may be empty and it may be absent — each a different statement
 *     about how the layer panel is drawn. An earlier version collected the
 *     references it found at any depth and rewrote a flat array, so nesting and
 *     labels were lost, an empty `/Order` was filled in and an absent one was
 *     invented, and a comparison that compared the set did not notice.
 *
 * Giving up on a walk never turns into "no optional content": an unresolvable
 * reference, a structure of the wrong type and a graph deeper than the bound are
 * each a refusal.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import { censusIndirectObjects } from './census';
import type { CensusOutcome } from './census';
import { MECHANISM_BOUNDS } from './policy';
import { pdfTextObject, pdfTextOf, readPdfText } from './pdf-text';
import type { PdfText } from './pdf-text';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/** A dictionary key reads back as `/Name`; the slash is not part of the name. */
const LEADING_SLASH = /^\//;

/** Whether a value is a string object — a label — as opposed to anything else. */
const isStringObject = (v: unknown): boolean => v instanceof PDFString || v instanceof PDFHexString;

function look(doc: PDFDocument, value: unknown): unknown {
    try {
        if (value instanceof PDFRef) return doc.context.lookup(value);
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Resolve, keeping "not there" apart from "not a reference".
 *
 * A dangling reference looks up to `undefined` rather than throwing, and a
 * helper that fell back to the reference would hand back something that reads as
 * a value. That is how a missing object passes for a present one.
 */
type Resolved = { ok: true; value: unknown } | { ok: false; reason: string };

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

/** The dictionary of a dictionary or of a stream, or `null`. */
const dictOf = (value: unknown): PDFDict | null => {
    if (value instanceof PDFDict) return value;
    const inner = (value as { dict?: unknown } | null)?.dict;
    return inner instanceof PDFDict ? inner : null;
};

/** The `/D` keys this reader both accepts **and reproduces**. */
export const HANDLED_D_KEYS = ['Order', 'ON', 'OFF', 'Name', 'BaseState', 'AS', 'RBGroups'];

/** The `/AS` events this reader reproduces. Any other event is refused. */
export const SUPPORTED_AS_EVENTS = ['/View', '/Print', '/Export'];

/** The `/AS` entry keys this reader understands. A fourth key is refused. */
const HANDLED_AS_KEYS = ['Event', 'Category', 'OCGs'];

/** The only `/BaseState` this reader reproduces. Others are refused. */
export const SUPPORTED_BASE_STATE = '/ON';

/** The same group listed by two sources is one group, not two. */
const dedupeRefs = (refs: PDFRef[]): PDFRef[] => {
    const out: PDFRef[] = [];
    for (const ref of refs) {
        if (!out.some((r) => r.tag === ref.tag)) out.push(ref);
    }
    return out;
};

const refsOf = (arr: unknown): PDFRef[] => {
    const out: PDFRef[] = [];
    if (!(arr instanceof PDFArray)) return out;
    for (let i = 0; i < arr.size(); i += 1) {
        const r = arr.get(i);
        if (r instanceof PDFRef) out.push(r);
    }
    return out;
};

export interface PagePropertyEntry {
    sourcePageIndex: number;
    /** Position within the selection, which is the output page index. */
    pageIndex: number;
    key: string;
    /**
     * The group, by reference, and always one `/OCProperties /OCGs` registers.
     * BLK-R7-B: an entry that cannot be proven to name a registered group is a
     * refusal, so there is no longer a case where this is absent.
     */
    ref: PDFRef;
    name: string | null;
}

/**
 * A form XObject whose `/OC` names a group, found through the resource walk.
 *
 * Real drawings put the group on the form and never mention it in the page's
 * `/Properties`, so discovery through `/Properties` alone reports a document
 * with no uses and carries no configuration — which is how a copied `/OC`
 * survived into an artifact with no `/OCProperties` at all, and a layer that
 * was off became visible. This is the other way a group is really used.
 *
 * `path` is the chain of `/XObject` keys from the page's resources down to the
 * form. It is how the same form is found again in the output, where every
 * reference is a different number but the structure is the one that was copied.
 */
export interface XObjectOcUsage {
    sourcePageIndex: number;
    /** Position within the selection, which is the output page index. */
    pageIndex: number;
    /** `/XObject` keys from the page down to the form, without leading slashes. */
    path: string[];
    /** The group the form's `/OC` resolves to, in the source. */
    ref: PDFRef;
    name: string | null;
    /**
     * True when the source `/OC` was a membership dictionary this reader
     * replaces with the group itself. OC-B.
     */
    viaOcmd: boolean;
    /**
     * The form itself, by source reference. Every usage naming the same source
     * form has to find the same written form, and no two source forms may find
     * one — the carry checks both, so a path is a witness, never an identity.
     */
    formRef: string | null;
    /** What the source `/OC` names: the group, or the OC-B membership dictionary. */
    ocRef: string;
}

/** One `/D /AS` usage application dictionary, in terms that survive a copy. */
export interface AutoStateEntry {
    event: string;
    categories: string[];
    ocgs: PDFRef[];
}

export interface OptionalContentDescription {
    present: boolean;
    groups: { ref: PDFRef; name: string | null }[];
    on: (string | null)[];
    off: (string | null)[];
    /** `/D /ON` and `/D /OFF` by reference, as written. RF-R9-1 identity. */
    onRefs: string[];
    offRefs: string[];
    /** `/D /Order` with every group as its reference. RF-R9-1 identity. */
    orderRefShape: unknown;
    /** `/D /Name`, as the text a reader shows. Compared across Merge sources. */
    dName: string | null;
    /** The same value as bytes and token, to be written back as it was. BLK-R4-1. */
    dNameValue: PdfText | null;
    baseState: string | null;
    orderPresent: boolean;
    orderShape: unknown;
    configs: number;
    pageProperties: PagePropertyEntry[];
    /** Form XObjects whose `/OC` this reader supports and carries. OC-A / OC-B. */
    xobjectUsages: XObjectOcUsage[];
    /** `/D /AS`, in order. Empty when the key is absent. OC-C. */
    autoStates: AutoStateEntry[];
    /** Whether `/D /AS` was present at all, so an absent one stays absent. */
    autoStatesPresent: boolean;
    /**
     * Whether `/D /RBGroups` was present as the empty array. Only the empty
     * array is supported, and it is preserved as the empty array. OC-D.
     */
    emptyRbGroups: boolean;
    unsupported: string[];
}

/**
 * `/Order` as a comparable shape, with the label rule applied.
 *
 * A text label titles a section of the layer panel, and the only position this
 * research showed it can be reproduced in is **the first element of a nested
 * array**. A string at the top level, or part-way through a nested array, means
 * something unestablished, so it is recorded as unsupported rather than carried
 * on the strength of being a string.
 */
function orderShapeOf(
    doc: PDFDocument,
    node: unknown,
    nameOfGroup: (ref: unknown) => string | null,
    depth: number,
    unsupported: string[],
    labelAllowed: boolean,
): unknown {
    if (depth > MECHANISM_BOUNDS.maxOrderDepth) {
        unsupported.push(`/D /Order nested deeper than ${MECHANISM_BOUNDS.maxOrderDepth}`);
        return '(too deep)';
    }
    const value = look(doc, node);
    if (value instanceof PDFArray) {
        const shape: unknown[] = [];
        for (let i = 0; i < value.size(); i += 1) {
            // Only a nested array may open with a label; the outermost one is
            // the order itself, not a titled section.
            shape.push(orderShapeOf(doc, value.get(i), nameOfGroup, depth + 1, unsupported, depth > 0 && i === 0));
        }
        return shape;
    }
    if (value instanceof PDFDict) {
        const type = nameOf(value.get(PDFName.of('Type')));
        if (type !== '/OCG') {
            unsupported.push(`/D /Order holds a ${type || 'untyped'} dictionary`);
            return `(unsupported ${type || 'dictionary'})`;
        }
        return nameOfGroup(node);
    }
    if (isStringObject(value)) {
        // BLK-R4-1: a label is text a reader shows, so it is read the way a
        // reader reads it. One that is there and cannot be read is not a label
        // this reader can reproduce.
        const read = readPdfText(value);
        if (!read.ok) {
            unsupported.push(`/D /Order holds a text label that cannot be read: it ${read.reason}`);
            return '(unreadable label)';
        }
        const label = read.value.text;
        if (!labelAllowed) {
            unsupported.push(
                depth === 0
                    ? '/D /Order holds a text label at the top level'
                    : '/D /Order holds a text label away from the start of its group',
            );
            return `(unsupported label:${label})`;
        }
        return `label:${label}`;
    }
    unsupported.push('/D /Order holds an entry that is neither a group, an array nor a label');
    return '(unsupported entry)';
}

/**
 * `/Order` with every group as its reference — the identity RF-R9-1 compares
 * across sanitization within one loaded document, where two groups may share a
 * name but never a reference. Shape only; `orderShapeOf` does the refusing.
 */
function orderRefShapeOf(doc: PDFDocument, node: unknown, depth: number): unknown {
    if (depth > MECHANISM_BOUNDS.maxOrderDepth) return '(too deep)';
    const value = look(doc, node);
    if (value instanceof PDFArray) {
        const shape: unknown[] = [];
        for (let i = 0; i < value.size(); i += 1) shape.push(orderRefShapeOf(doc, value.get(i), depth + 1));
        return shape;
    }
    if (node instanceof PDFRef) return `ref:${node.tag}`;
    if (isStringObject(value)) {
        const read = readPdfText(value);
        return read.ok ? `label:${read.value.text}` : '(unreadable label)';
    }
    return value instanceof PDFDict ? '(direct dictionary)' : '(other)';
}

/**
 * Walk one kept page's resource graph, refusing every attachment point this
 * reader does not rebuild.
 *
 * An expansion set keyed on `(indirect reference, context)` makes a cycle
 * terminate and a shared body expand once per context (RF-R8R-2). It
 * deduplicates **bodies**, never edges: what an `/OC` means depends on the
 * resource role it was reached through, so that is decided per edge before the
 * set is consulted at all. `/ColorSpace` and
 * `/Shading` are deliberately not opened: they hold no content stream, so they
 * open no resource scope and carry no `/OC`. That is a statement about scope,
 * not about safety.
 */
/**
 * A page's **effective** `/Resources`, resolved through the page tree.
 *
 * `/Resources` is an inheritable attribute: a page that declares none takes its
 * parent's, and the parent's `/Properties`, `/XObject`, `/ExtGState` and the
 * soft masks under them are just as much part of what that page draws with.
 *
 * Reading only the `/Resources` present on the page itself made every inherited
 * scope invisible, and invisible read as "none" — the same blind-path shape as
 * B1, one level up. A document whose optional content lives in an inherited
 * dictionary extracted READY with the group unexamined.
 *
 * Malformed inheritance is a refusal, not an absence: a `/Parent` chain that
 * loops, a `/Parent` that does not resolve, and a `/Resources` of the wrong type
 * each mean this reader cannot say what the page draws with.
 */
function effectiveResources(
    doc: PDFDocument,
    pageNode: PDFDict,
    where: string,
    refuse: (text: string) => void,
): unknown {
    const own = pageNode.get(PDFName.of('Resources'));
    if (own !== undefined) return own;

    const seen = new Set<string>();
    let node: PDFDict = pageNode;
    for (let depth = 0; depth <= MECHANISM_BOUNDS.maxInheritanceDepth; depth += 1) {
        const parentRaw = node.get(PDFName.of('Parent'));
        if (parentRaw === undefined) return undefined;
        if (parentRaw instanceof PDFRef) {
            if (seen.has(parentRaw.tag)) {
                refuse(`${where} /Parent chain loops, so its resources cannot be resolved`);
                return undefined;
            }
            seen.add(parentRaw.tag);
        }
        const resolved = resolve(doc, parentRaw);
        if (!resolved.ok) {
            refuse(`${where} /Parent ${resolved.reason}`);
            return undefined;
        }
        if (!(resolved.value instanceof PDFDict)) {
            refuse(`${where} /Parent is not a dictionary`);
            return undefined;
        }
        node = resolved.value;
        const inherited = node.get(PDFName.of('Resources'));
        if (inherited !== undefined) return inherited;
    }
    refuse(`${where} /Parent chain deeper than ${MECHANISM_BOUNDS.maxInheritanceDepth}`);
    return undefined;
}

/**
 * The groups `/OCProperties /OCGs` registers, by reference tag.
 *
 * Read silently and ahead of the page walk, because the walk has to know
 * whether a form's `/OC` names a registered group before it can say whether it
 * is supported. The `/OCGs` array is read again, properly and with its own
 * refusals, further down; this pass reports nothing, so the order of the
 * refusals a reader sees does not depend on it.
 */
function registeredOcgTags(doc: PDFDocument, oc: unknown): Set<string> {
    const tags = new Set<string>();
    if (!(oc instanceof PDFDict)) return tags;
    const groups = look(doc, oc.get(PDFName.of('OCGs')));
    if (!(groups instanceof PDFArray)) return tags;
    for (let i = 0; i < groups.size(); i += 1) {
        const raw = groups.get(i);
        if (!(raw instanceof PDFRef)) continue;
        const value = look(doc, raw);
        if (value instanceof PDFDict && nameOf(value.get(PDFName.of('Type'))) === '/OCG') tags.add(raw.tag);
    }
    return tags;
}

/**
 * One `/D /AS` entry, within the envelope OC-C adopts.
 *
 * Every key is named, every event is one of three, every category is a name and
 * every group is one this document registers. Anything outside that refuses the
 * whole entry: half a usage application dictionary applies a state the author
 * did not ask for, which is a visibility change.
 */
function readAutoState(
    doc: PDFDocument,
    raw: unknown,
    where: string,
    registered: Set<string>,
    unsupported: string[],
): AutoStateEntry | null {
    const r = resolve(doc, raw);
    if (!r.ok) {
        unsupported.push(`${where} ${r.reason}`);
        return null;
    }
    if (!(r.value instanceof PDFDict)) {
        unsupported.push(`${where} is not a dictionary`);
        return null;
    }
    const dict = r.value;
    for (const [k] of dict.entries()) {
        const key = k.asString().replace(LEADING_SLASH, '');
        if (!HANDLED_AS_KEYS.includes(key)) {
            unsupported.push(`${where} /${key}`);
            return null;
        }
    }

    const event = nameOf(dict.get(PDFName.of('Event')));
    if (!SUPPORTED_AS_EVENTS.includes(event)) {
        unsupported.push(`${where} /Event ${event || 'is missing'}`);
        return null;
    }

    const rawCategory = dict.get(PDFName.of('Category'));
    if (rawCategory === undefined) {
        unsupported.push(`${where} /Category is missing`);
        return null;
    }
    const categoryRead = resolve(doc, rawCategory);
    if (!categoryRead.ok) {
        unsupported.push(`${where} /Category ${categoryRead.reason}`);
        return null;
    }
    if (!(categoryRead.value instanceof PDFArray)) {
        unsupported.push(`${where} /Category is not an array`);
        return null;
    }
    const categories: string[] = [];
    for (let i = 0; i < categoryRead.value.size(); i += 1) {
        const member = categoryRead.value.get(i);
        if (!(member instanceof PDFName)) {
            unsupported.push(`${where} /Category[${i}] is not a name`);
            return null;
        }
        categories.push(member.asString());
    }

    const rawOcgs = dict.get(PDFName.of('OCGs'));
    if (rawOcgs === undefined) {
        unsupported.push(`${where} /OCGs is missing`);
        return null;
    }
    const ocgsRead = resolve(doc, rawOcgs);
    if (!ocgsRead.ok) {
        unsupported.push(`${where} /OCGs ${ocgsRead.reason}`);
        return null;
    }
    if (!(ocgsRead.value instanceof PDFArray)) {
        unsupported.push(`${where} /OCGs is not an array`);
        return null;
    }
    const ocgs: PDFRef[] = [];
    for (let i = 0; i < ocgsRead.value.size(); i += 1) {
        const member = ocgsRead.value.get(i);
        if (!(member instanceof PDFRef)) {
            unsupported.push(`${where} /OCGs[${i}] is not a reference to a group`);
            return null;
        }
        if (!registered.has(member.tag)) {
            unsupported.push(`${where} /OCGs[${i}] names a group /OCProperties does not register`);
            return null;
        }
        ocgs.push(member);
    }

    return { event, categories, ocgs };
}

function walkPageResourceGraph(
    doc: PDFDocument,
    sourceIndex: number,
    pageIndex: number,
    pageNode: PDFDict,
    unsupported: string[],
    registered: Set<string>,
    usages: XObjectOcUsage[],
): void {
    /**
     * RF-R8R-2 — a body is expanded once per **context**, not once per object.
     *
     * Round 8 made the edge decide what `/OC` means on that edge, then expanded
     * each object's body once. That is only sound if expanding a body gives the
     * same answer whoever asks — and it does not. The children of a form reached
     * through `/Pattern`, a Type 3 `/CharProcs`, a soft mask's `/G` or an
     * annotation's appearance are in a scope this reader does not rebuild, so
     * their `/OC` is refused; the same children reached through `/XObject` from
     * the page are carried. Whichever edge expanded the shared form first
     * decided for the other, so swapping two keys in a resource dictionary
     * turned a refusal into READY.
     *
     * The answer for a child depends on exactly one thing about how its parent
     * was reached: whether that path is all `/XObject` from the page (`xobject`)
     * or passes through anything else (`scope`). So that is the memo key —
     * `(object, context)` — and each body is expanded at most twice. Both
     * contexts are always explored when both are reachable, so the refusal a
     * `scope` path produces is produced whatever the dictionary order.
     *
     * Why one `/XObject` path per object is enough for the output, rather than
     * one per alias: a usage is how the carry *finds* a written form, and every
     * alias of one source form finds the same written form, because one Extract
     * or one Merge source is copied in a single `copyPages` call and its copier
     * copies each source object once. The carry does not assume that: every
     * usage names its source form (`formRef`), and the carry refuses if one
     * source form resolves to two written forms, or two to one.
     *
     * **Bounded and order-independent.** Work is done level by level in
     * resource depth, so each `(object, context)` is expanded at the smallest
     * depth it can be reached at — which makes the depth bound a property of
     * the graph, not of which key happened to be read first. Every edge out of
     * every expanded body is classified exactly once.
     */
    type Context = 'scope' | 'xobject';
    const contextOf = (path: string[] | null): Context => (path === null ? 'scope' : 'xobject');
    const expanded = new Set<string>();
    const firstExpansion = (raw: unknown, kind: string): boolean => {
        if (!(raw instanceof PDFRef)) return true;
        const key = `${raw.tag}|${kind}`;
        if (expanded.has(key)) return false;
        expanded.add(key);
        return true;
    };

    const refuse = (text: string): void => {
        unsupported.push(text);
    };

    /**
     * Usages already recorded, keyed by the edge that produced them.
     *
     * Edge-local classification runs per edge, so a form reached along two
     * valid `/XObject` paths is classified twice — correctly, because either
     * path may be the one that identifies it in the output. What must not
     * happen is the *same* path recording twice.
     */
    const seenUsages = new Set<string>();

    const record = (
        path: string[],
        ref: PDFRef,
        group: PDFDict,
        viaOcmd: boolean,
        ocRef: string,
        formRaw: unknown,
    ): void => {
        const key = `${path.join('/')}\u0000${ref.tag}`;
        if (seenUsages.has(key)) return;
        seenUsages.add(key);
        usages.push({
            sourcePageIndex: sourceIndex,
            pageIndex,
            path: [...path],
            ref,
            name: pdfTextOf(look(doc, group.get(PDFName.of('Name')))),
            viaOcmd,
            formRef: formRaw instanceof PDFRef ? formRaw.tag : null,
            ocRef,
        });
    };

    /**
     * OC-B: a membership dictionary this reader may replace with its one group.
     *
     * Proven against the pinned pdf.js (`pdfjs-dist` 5.4.449,
     * `build/pdf.mjs` `isVisible`): with no `/VE` there is no expression to
     * evaluate, with no `/P` the policy defaults to `AnyOn`, and `AnyOn` over a
     * single member returns that member's `visible` — which is exactly what the
     * `OCG` branch of the same function returns. So the group alone is the same
     * picture, and the redundant dictionary is not carried into the output.
     * Anything outside that envelope is refused rather than approximated.
     */
    const classifyOcmd = (
        target: PDFDict,
        where: string,
        path: string[],
        ocRaw: unknown,
        formRaw: unknown,
    ): void => {
        if (target.get(PDFName.of('VE')) !== undefined) {
            refuse(`${where} /OC is an /OCMD with a /VE visibility expression`);
            return;
        }
        if (target.get(PDFName.of('P')) !== undefined) {
            refuse(`${where} /OC is an /OCMD with a /P visibility policy`);
            return;
        }
        for (const [k] of target.entries()) {
            const key = k.asString().replace(/^\//, '');
            if (key !== 'Type' && key !== 'OCGs') {
                refuse(`${where} /OC is an /OCMD carrying /${key}`);
                return;
            }
        }
        const rawOcgs = target.get(PDFName.of('OCGs'));
        if (rawOcgs === undefined) {
            refuse(`${where} /OC is an /OCMD with no /OCGs`);
            return;
        }
        const read = resolve(doc, rawOcgs);
        if (!read.ok) {
            refuse(`${where} /OC /OCGs ${read.reason}`);
            return;
        }
        // One group, written either as the reference itself or as a one-element
        // array. A member that is not a reference is not a group this reader can
        // name, so the whole dictionary is refused rather than partly read.
        let refs: PDFRef[] = [];
        if (read.value instanceof PDFArray) {
            for (let i = 0; i < read.value.size(); i += 1) {
                const member = read.value.get(i);
                if (!(member instanceof PDFRef)) {
                    refuse(`${where} /OC is an /OCMD whose /OCGs[${i}] is not a reference to a group`);
                    return;
                }
                refs.push(member);
            }
        } else if (rawOcgs instanceof PDFRef && read.value instanceof PDFDict) {
            refs = [rawOcgs];
        } else {
            refuse(`${where} /OC is an /OCMD whose /OCGs is neither a group nor an array`);
            return;
        }
        if (refs.length !== 1) {
            refuse(`${where} /OC is an /OCMD naming ${refs.length} groups, not one`);
            return;
        }
        const ref = refs[0];
        if (!registered.has(ref.tag)) {
            refuse(`${where} /OC is an /OCMD naming a group /OCProperties does not register`);
            return;
        }
        const group = look(doc, ref);
        if (!(group instanceof PDFDict)) {
            refuse(`${where} /OC is an /OCMD whose group cannot be read`);
            return;
        }
        record(path, ref, group, true, ocRaw instanceof PDFRef ? ocRaw.tag : '(direct)', formRaw);
    };

    /**
     * OC-A: `/OC` on a form XObject, naming a registered group.
     *
     * `path === null` means this stream was not reached through `/XObject`
     * resources all the way from the page — a soft mask's `/G`, an annotation
     * appearance, anything under a pattern or a Type 3 glyph — and those
     * positions keep refusing, because nothing has shown what carrying them
     * would mean. Presence alone is no longer the refusal; what the `/OC`
     * actually resolves to decides it.
     */
    const classifyOc = (
        dict: PDFDict,
        ocRaw: unknown,
        where: string,
        path: string[] | null,
        formRaw: unknown,
    ): void => {
        if (path === null) {
            refuse(`${where} /OC`);
            return;
        }
        const subtype = nameOf(dict.get(PDFName.of('Subtype')));
        if (subtype !== '/Form') {
            refuse(`${where} /OC on ${subtype || 'an untyped'} XObject`);
            return;
        }
        const r = resolve(doc, ocRaw);
        if (!r.ok) {
            refuse(`${where} /OC ${r.reason}`);
            return;
        }
        if (!(r.value instanceof PDFDict)) {
            refuse(`${where} /OC is not a dictionary`);
            return;
        }
        const type = nameOf(r.value.get(PDFName.of('Type')));
        if (type === '/OCMD') {
            classifyOcmd(r.value, where, path, ocRaw, formRaw);
            return;
        }
        if (type !== '/OCG') {
            refuse(`${where} /OC is ${type || 'untyped'}`);
            return;
        }
        if (!(ocRaw instanceof PDFRef)) {
            refuse(`${where} /OC is a group written directly rather than by reference`);
            return;
        }
        if (!registered.has(ocRaw.tag)) {
            refuse(`${where} /OC names a group /OCProperties does not register`);
            return;
        }
        record(path, ocRaw, r.value, false, ocRaw.tag, formRaw);
    };

    const subDict = (holder: PDFDict, key: string, where: string): PDFDict | null => {
        const raw = holder.get(PDFName.of(key));
        if (raw === undefined) return null;
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} /${key} ${r.reason}`);
            return null;
        }
        if (!(r.value instanceof PDFDict)) {
            refuse(`${where} /${key} is not a dictionary`);
            return null;
        }
        return r.value;
    };

    /**
     * `/Properties` below the page's own resources. Nothing here is rebuilt, so
     * every entry is refused — named, so the refusal says what it found.
     */
    const walkNestedProperties = (resources: PDFDict, where: string): void => {
        const properties = subDict(resources, 'Properties', where);
        if (!properties) return;
        for (const [key, entry] of properties.entries()) {
            const r = resolve(doc, entry);
            if (!r.ok) {
                refuse(`${where} /Properties ${key.asString()} ${r.reason}`);
                continue;
            }
            const dict = dictOf(r.value);
            const type = dict ? nameOf(dict.get(PDFName.of('Type'))) : '';
            const what = type === '/OCG'
                ? 'an optional-content group'
                : type === '/OCMD'
                    ? 'an optional-content membership dictionary'
                    : dict
                        ? `a ${type || 'untyped'} dictionary`
                        : 'a value that is not a dictionary';
            refuse(`${where} /Properties ${key.asString()} names ${what} below the page's own resources`);
        }
    };

    // ---- the schedule ---------------------------------------------------------
    //
    // One list per resource depth. A task at depth d only ever adds tasks at d
    // (a stream's body, a font, a graphics state — same depth as the edge that
    // reached it) or at d + 1 (the resources that body opens), so finishing a
    // level before starting the next expands everything at its smallest depth.
    type Task =
        | { t: 'resources'; raw: unknown; where: string; depth: number; path: string[] | null }
        | { t: 'body'; raw: unknown; dict: PDFDict; where: string; depth: number; path: string[] | null }
        | { t: 'type3'; raw: unknown; font: PDFDict; where: string; depth: number }
        | { t: 'softmask'; raw: unknown; value: unknown; where: string; depth: number };
    const levels: Task[][] = [];
    const schedule = (task: Task): void => {
        (levels[task.depth] ??= []).push(task);
    };

    /**
     * One resource edge to a stream: decided here, for this edge. The body is
     * scheduled, and expanded later at most once per context.
     */
    const edgeStream = (
        raw: unknown,
        where: string,
        depth: number,
        ocApplies: boolean,
        path: string[] | null,
    ): void => {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        const dict = dictOf(r.value);
        if (!dict) {
            refuse(`${where} is not a dictionary or stream`);
            return;
        }
        // ---- edge-local: decided by how this object was reached -------------
        const ocRaw = dict.get(PDFName.of('OC'));
        if (ocApplies && ocRaw !== undefined) classifyOc(dict, ocRaw, where, path, raw);
        // ---- node-local, per context: the body ------------------------------
        schedule({ t: 'body', raw, dict, where, depth, path });
    };

    /**
     * A Type 3 font draws its glyphs with content streams, and those streams
     * take their resources from the font. Other font types hold no content
     * stream and are passed over. A font is not an `/OC` attachment point and
     * everything under it is `scope`, so its expansion is context-independent.
     */
    const edgeType3 = (raw: unknown, where: string, depth: number): void => {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        const font = dictOf(r.value);
        if (!font || nameOf(font.get(PDFName.of('Subtype'))) !== '/Type3') return;
        schedule({ t: 'type3', raw, font, where, depth });
    };

    /**
     * A graphics state's soft mask — the path that was not walked until B1, and
     * through which `ocg-extgstate-smask` extracted READY with a group behind it.
     * Its resolution is refused per edge; the rest is a property of the object.
     */
    const edgeSoftMask = (raw: unknown, where: string, depth: number): void => {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        schedule({ t: 'softmask', raw, value: r.value, where, depth });
    };

    const runResources = (task: Extract<Task, { t: 'resources' }>): void => {
        const { raw, where, depth, path } = task;
        if (raw === undefined) return;
        if (depth > MECHANISM_BOUNDS.maxResourceDepth) {
            refuse(`${where} /Resources nested deeper than ${MECHANISM_BOUNDS.maxResourceDepth}`);
            return;
        }
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} /Resources ${r.reason}`);
            return;
        }
        const resources = r.value;
        if (!(resources instanceof PDFDict)) {
            refuse(`${where} /Resources is not a dictionary`);
            return;
        }

        if (depth > 0) walkNestedProperties(resources, where);

        const xobjects = subDict(resources, 'XObject', where);
        if (xobjects) {
            for (const [key, entry] of xobjects.entries()) {
                // The one route along which an `/OC` can be carried, so the key
                // is added to the path that finds this form again in the output.
                const name = key.asString().replace(/^\//, '');
                edgeStream(
                    entry,
                    `${where} /XObject ${key.asString()}`,
                    depth,
                    true,
                    path === null ? null : [...path, name],
                );
            }
        }

        const patterns = subDict(resources, 'Pattern', where);
        if (patterns) {
            for (const [key, entry] of patterns.entries()) {
                // A shading pattern is a plain dictionary with no content
                // stream; a tiling pattern is a stream with resources. Neither
                // is an `/OC` attachment point — a pattern is a scope.
                edgeStream(entry, `${where} /Pattern ${key.asString()}`, depth, false, null);
            }
        }

        const fonts = subDict(resources, 'Font', where);
        if (fonts) {
            for (const [key, entry] of fonts.entries()) {
                edgeType3(entry, `${where} /Font ${key.asString()}`, depth);
            }
        }

        const graphicsStates = subDict(resources, 'ExtGState', where);
        if (graphicsStates) {
            for (const [key, entry] of graphicsStates.entries()) {
                edgeSoftMask(entry, `${where} /ExtGState ${key.asString()}`, depth);
            }
        }
    };

    const runBody = (task: Extract<Task, { t: 'body' }>): void => {
        if (!firstExpansion(task.raw, contextOf(task.path))) return;
        schedule({
            t: 'resources',
            raw: task.dict.get(PDFName.of('Resources')),
            where: task.where,
            depth: task.depth + 1,
            path: task.path,
        });
    };

    const runType3 = (task: Extract<Task, { t: 'type3' }>): void => {
        const { raw, font, where, depth } = task;
        if (!firstExpansion(raw, 'font')) return;
        schedule({ t: 'resources', raw: font.get(PDFName.of('Resources')), where, depth: depth + 1, path: null });
        const procs = subDict(font, 'CharProcs', where);
        if (procs) {
            for (const [glyph, entry] of procs.entries()) {
                edgeStream(entry, `${where} /CharProcs ${glyph.asString()}`, depth + 1, false, null);
            }
        }
    };

    /**
     * No `/SMask` and `/SMask /None` both mean no mask, and neither is a reason
     * to refuse. A mask paints with its `/G`, a transparency group form, so `/G`
     * is an edge like any other — through the same `edgeStream`, sharing the
     * expansion set and the depth bound. Anything that cannot be read as one of
     * those shapes is refused: an unreadable mask is not an absent one.
     */
    const runSoftMask = (task: Extract<Task, { t: 'softmask' }>): void => {
        const { raw, value, where, depth } = task;
        if (!firstExpansion(raw, 'gs')) return;
        if (!(value instanceof PDFDict)) {
            refuse(`${where} is not a graphics state dictionary`);
            return;
        }
        const rawMask = value.get(PDFName.of('SMask'));
        if (rawMask === undefined) return;
        const mask = resolve(doc, rawMask);
        if (!mask.ok) {
            refuse(`${where} /SMask ${mask.reason}`);
            return;
        }
        if (mask.value instanceof PDFName) {
            if (mask.value.asString() !== '/None') {
                refuse(`${where} /SMask is ${mask.value.asString()}, neither /None nor a dictionary`);
            }
            return;
        }
        if (!(mask.value instanceof PDFDict)) {
            refuse(`${where} /SMask is neither /None nor a dictionary`);
            return;
        }
        const groupWhere = `${where} /SMask /G`;
        const rawGroup = mask.value.get(PDFName.of('G'));
        if (rawGroup === undefined) {
            refuse(`${groupWhere} is missing, which a soft mask requires`);
            return;
        }
        const group = resolve(doc, rawGroup);
        if (!group.ok) {
            refuse(`${groupWhere} ${group.reason}`);
            return;
        }
        const groupDict = dictOf(group.value);
        const isStream = groupDict !== null && (group.value as { dict?: unknown })?.dict instanceof PDFDict;
        if (!isStream) {
            refuse(`${groupWhere} is not a form XObject stream`);
            return;
        }
        const subtype = nameOf(groupDict.get(PDFName.of('Subtype')));
        if (subtype && subtype !== '/Form') {
            refuse(`${groupWhere} is ${subtype}, not a form XObject`);
            return;
        }
        // A soft mask's group keeps refusing an `/OC`: nothing has shown what
        // carrying one there would mean.
        edgeStream(rawGroup, groupWhere, depth, true, null);
    };

    /** `/AP` holds a stream per state, or a dictionary of streams per state. */
    const walkAppearance = (annot: PDFDict, where: string): void => {
        const ap = subDict(annot, 'AP', where);
        if (!ap) return;
        for (const [kind, entry] of ap.entries()) {
            const apWhere = `${where} /AP ${kind.asString()}`;
            const r = resolve(doc, entry);
            if (!r.ok) {
                refuse(`${apWhere} ${r.reason}`);
                continue;
            }
            if (r.value instanceof PDFDict) {
                for (const [state, stream] of r.value.entries()) {
                    edgeStream(stream, `${apWhere} ${state.asString()}`, 0, true, null);
                }
            } else {
                edgeStream(entry, apWhere, 0, true, null);
            }
        }
    };

    // An annotation that belongs to a group, and what its appearance holds.
    const rawAnnots = pageNode.get(PDFName.of('Annots'));
    if (rawAnnots !== undefined) {
        const r = resolve(doc, rawAnnots);
        if (!r.ok) {
            refuse(`page ${sourceIndex} /Annots ${r.reason}`);
        } else if (!(r.value instanceof PDFArray)) {
            refuse(`page ${sourceIndex} /Annots is not an array`);
        } else {
            for (let i = 0; i < r.value.size(); i += 1) {
                const where = `page ${sourceIndex} annotation ${i}`;
                const a = resolve(doc, r.value.get(i));
                if (!a.ok) {
                    refuse(`${where} ${a.reason}`);
                    continue;
                }
                if (!(a.value instanceof PDFDict)) continue;
                if (a.value.get(PDFName.of('OC')) !== undefined) refuse(`${where} /OC`);
                walkAppearance(a.value, where);
            }
        }
    }

    // The page's EFFECTIVE resources, inherited ones included (M6-H9b-A).
    schedule({
        t: 'resources',
        raw: effectiveResources(doc, pageNode, `page ${sourceIndex}`, refuse),
        where: `page ${sourceIndex}`,
        depth: 0,
        path: [],
    });

    for (let depth = 0; depth < levels.length; depth += 1) {
        const level = levels[depth] ?? [];
        // A task may add to its own level while the level runs, so the length
        // is read on every turn.
        for (let i = 0; i < level.length; i += 1) {
            const task = level[i];
            if (task.t === 'resources') runResources(task);
            else if (task.t === 'body') runBody(task);
            else if (task.t === 'type3') runType3(task);
            else runSoftMask(task);
        }
        levels[depth] = [];
    }
}

/**
 * What a document's optional content is, in terms that survive a copy.
 *
 * References differ between documents, so everything a comparison needs is also
 * reported by name. `pageProperties` keeps the `(page, key)` pairs that make the
 * mapping structural rather than positional.
 */
export function describeOptionalContent(
    doc: PDFDocument,
    selection: number[] | null = null,
): OptionalContentDescription {
    const out: OptionalContentDescription = {
        present: false,
        groups: [],
        on: [],
        off: [],
        onRefs: [],
        offRefs: [],
        orderRefShape: null,
        dName: null,
        dNameValue: null,
        baseState: null,
        orderPresent: false,
        orderShape: null,
        configs: 0,
        pageProperties: [],
        xobjectUsages: [],
        autoStates: [],
        autoStatesPresent: false,
        emptyRbGroups: false,
        unsupported: [],
    };

    let oc: unknown;
    try {
        oc = doc.catalog.lookup(PDFName.of('OCProperties'));
    } catch (error) {
        // A structure that cannot even be looked up is not "absent".
        out.present = true;
        out.unsupported.push(`/OCProperties could not be read: ${String((error as Error)?.message ?? error)}`);
        return out;
    }

    // Attachments are detected whether or not the catalog declares optional
    // content: an annotation carrying `/OC` in a document with no
    // `/OCProperties` is itself a structure this reader does not understand.
    const pages = doc.getPages();
    const wanted = selection === null ? pages.map((_p, i) => i) : selection;
    const registered = registeredOcgTags(doc, oc);
    wanted.forEach((sourceIndex, position) => {
        const page = pages[sourceIndex];
        if (!page) return;
        walkPageResourceGraph(
            doc,
            sourceIndex,
            position,
            page.node,
            out.unsupported,
            registered,
            out.xobjectUsages,
        );
    });

    if (!(oc instanceof PDFDict)) {
        if (doc.catalog.get(PDFName.of('OCProperties')) !== undefined) {
            out.present = true;
            out.unsupported.push('/OCProperties is not a dictionary');
        }
        if (out.unsupported.length > 0) out.present = true;
        return out;
    }
    out.present = true;

    const nameOfGroup = (ref: unknown): string | null => {
        const g = look(doc, ref);
        return g instanceof PDFDict ? pdfTextOf(look(doc, g.get(PDFName.of('Name')))) : null;
    };

    // `/OCGs` and `/D` are both required. Refusing only a key of the wrong
    // *type* would read a missing one as an empty default — the same
    // "unreadable means absent" inference this reader exists to forbid.
    const rawGroups = oc.get(PDFName.of('OCGs'));
    if (rawGroups === undefined) {
        out.unsupported.push('/OCProperties has no /OCGs, which the specification requires');
    } else {
        const groupsRead = resolve(doc, rawGroups);
        if (!groupsRead.ok) {
            out.unsupported.push(`/OCProperties /OCGs ${groupsRead.reason}`);
        } else if (!(groupsRead.value instanceof PDFArray)) {
            out.unsupported.push('/OCProperties /OCGs is not an array');
        } else {
            const groups = groupsRead.value;
            for (let i = 0; i < groups.size(); i += 1) {
                const raw = groups.get(i);
                const r = resolve(doc, raw);
                if (!r.ok) {
                    out.unsupported.push(`/OCProperties /OCGs[${i}] ${r.reason}`);
                    continue;
                }
                if (!(raw instanceof PDFRef)) {
                    out.unsupported.push(`/OCProperties /OCGs[${i}] is not a reference to a group`);
                    continue;
                }
                const type = r.value instanceof PDFDict ? nameOf(r.value.get(PDFName.of('Type'))) : '';
                if (type !== '/OCG') {
                    out.unsupported.push(`/OCProperties /OCGs[${i}] is ${type || 'not a group'}`);
                    continue;
                }
                out.groups.push({ ref: raw, name: nameOfGroup(raw) });
            }
        }
    }

    // Alternate configurations. One default configuration is rebuilt; a second
    // has never been shown to be.
    if (oc.get(PDFName.of('Configs')) !== undefined) {
        const configs = look(doc, oc.get(PDFName.of('Configs')));
        out.configs = configs instanceof PDFArray ? configs.size() : -1;
        out.unsupported.push(
            configs instanceof PDFArray
                ? `/OCProperties /Configs with ${configs.size()} alternate configuration(s)`
                : '/OCProperties /Configs is not an array',
        );
    }

    const rawD = oc.get(PDFName.of('D'));
    let d: PDFDict | null = null;
    if (rawD === undefined) {
        out.unsupported.push('/OCProperties has no /D, which the specification requires');
    } else {
        const dRead = resolve(doc, rawD);
        if (!dRead.ok) {
            out.unsupported.push(`/OCProperties /D ${dRead.reason}`);
        } else if (!(dRead.value instanceof PDFDict)) {
            out.unsupported.push('/OCProperties /D is not a dictionary');
        } else {
            d = dRead.value;
        }
    }

    if (d) {
        for (const [key] of d.entries()) {
            const k = key.asString().replace(/^\//, '');
            if (!HANDLED_D_KEYS.includes(k)) out.unsupported.push(`/D /${k}`);
        }
        const onRefs = refsOf(look(doc, d.get(PDFName.of('ON'))));
        const offRefs = refsOf(look(doc, d.get(PDFName.of('OFF'))));
        out.on = onRefs.map(nameOfGroup);
        out.off = offRefs.map(nameOfGroup);
        out.onRefs = onRefs.map((r) => r.tag);
        out.offRefs = offRefs.map((r) => r.tag);
        /**
         * RF-R9-2 (Human decision): a group listed in both `/ON` and `/OFF` is
         * outside the support envelope. The specification does not say which
         * list wins, and readers disagree — the pinned pdf.js applies `/OFF`
         * last, so the layer is hidden there, and that is one reader's answer,
         * not the author's. Neither side is chosen and nothing is normalised;
         * the document is refused. A group repeated within one list is still
         * one state, and stays as it was.
         */
        const offTags = new Set(out.offRefs);
        const both = [...new Set(out.onRefs.filter((tag) => offTags.has(tag)))];
        if (both.length > 0) {
            out.unsupported.push(
                `/D /ON and /D /OFF both list ${both.length} group(s) (${both.join(', ')})`,
            );
        }
        // BLK-R4-1: the configuration's name is text a reader shows, carried as
        // the token it was. Present and not a readable text string used to
        // read as "no name", and the name was dropped without a word.
        const dNameRaw = look(doc, d.get(PDFName.of('Name')));
        if (dNameRaw !== undefined && dNameRaw !== PDFNull) {
            const read = readPdfText(dNameRaw);
            if (read.ok) {
                out.dName = read.value.text;
                out.dNameValue = read.value;
            } else {
                out.unsupported.push(`/D /Name ${read.reason}`);
            }
        }
        const base = d.get(PDFName.of('BaseState'));
        if (base !== undefined) {
            out.baseState = nameOf(base);
            if (out.baseState !== SUPPORTED_BASE_STATE) {
                out.unsupported.push(`/D /BaseState ${out.baseState}`);
            }
        }

        // OC-C: the usage application dictionaries. Preserved inside a named
        // envelope; anything outside it is refused rather than dropped, because
        // an `/AS` that quietly disappears changes what a viewer prints.
        const rawAs = d.get(PDFName.of('AS'));
        if (rawAs !== undefined) {
            out.autoStatesPresent = true;
            const asRead = resolve(doc, rawAs);
            if (!asRead.ok) {
                out.unsupported.push(`/D /AS ${asRead.reason}`);
            } else if (!(asRead.value instanceof PDFArray)) {
                out.unsupported.push('/D /AS is not an array');
            } else {
                for (let i = 0; i < asRead.value.size(); i += 1) {
                    const entry = readAutoState(
                        doc,
                        asRead.value.get(i),
                        `/D /AS[${i}]`,
                        registered,
                        out.unsupported,
                    );
                    if (entry) out.autoStates.push(entry);
                }
            }
        }

        // OC-D: only the empty `/RBGroups` is understood. It is preserved as
        // the empty array — omitting it may well be harmless, but preserving
        // what was written costs nothing and claims nothing.
        const rawRbGroups = d.get(PDFName.of('RBGroups'));
        if (rawRbGroups !== undefined) {
            const rbRead = resolve(doc, rawRbGroups);
            if (!rbRead.ok) {
                out.unsupported.push(`/D /RBGroups ${rbRead.reason}`);
            } else if (!(rbRead.value instanceof PDFArray)) {
                out.unsupported.push('/D /RBGroups is not an array');
            } else if (rbRead.value.size() > 0) {
                out.unsupported.push(`/D /RBGroups with ${rbRead.value.size()} group(s)`);
            } else {
                out.emptyRbGroups = true;
            }
        }

        out.orderPresent = d.get(PDFName.of('Order')) !== undefined;
        if (out.orderPresent) {
            const order = look(doc, d.get(PDFName.of('Order')));
            if (!(order instanceof PDFArray)) {
                out.unsupported.push('/D /Order is not an array');
            } else {
                out.orderShape = orderShapeOf(doc, order, nameOfGroup, 0, out.unsupported, false);
                out.orderRefShape = orderRefShapeOf(doc, order, 0);
            }
        }
    }

    wanted.forEach((sourceIndex, position) => {
        const page = pages[sourceIndex];
        if (!page) return;
        // The carried set is read from the effective resources too, so a page
        // whose /Properties is inherited is carried rather than silently empty.
        const resources = look(
            doc,
            effectiveResources(doc, page.node, `page ${sourceIndex}`, (t) => out.unsupported.push(t)),
        );
        const properties = resources instanceof PDFDict
            ? look(doc, resources.get(PDFName.of('Properties')))
            : undefined;
        if (!(properties instanceof PDFDict)) return;
        for (const [key, raw] of properties.entries()) {
            const value = look(doc, raw);
            if (!(value instanceof PDFDict)) {
                out.unsupported.push(`page ${sourceIndex} /Properties ${key.asString()} is not a dictionary`);
                continue;
            }
            const type = nameOf(value.get(PDFName.of('Type')));
            if (type === '/OCMD') {
                out.unsupported.push(
                    value.get(PDFName.of('VE')) !== undefined
                        ? `page ${sourceIndex} /OCMD with a /VE visibility expression`
                        : `page ${sourceIndex} /OCMD`,
                );
                continue;
            }
            if (type !== '/OCG') {
                out.unsupported.push(`page ${sourceIndex} /Properties ${key.asString()} is ${type || 'untyped'}`);
                continue;
            }
            /**
             * BLK-R7-B — the group has to be one this document already
             * registers.
             *
             * Every other reader here asks that: a form's `/OC`, the group
             * inside an OCMD, and each `/D /AS` member are all refused when
             * `/OCProperties /OCGs` does not list them. This one did not, and
             * the asymmetry was a visibility change rather than a tidiness
             * problem. A group the source leaves unregistered has no
             * configuration in the source — a viewer that cannot find it draws
             * the content — so carrying it, registering it in the output and
             * then applying the source's `/D /OFF` to it gives the layer a
             * meaning the source never had, and content the author could see
             * disappears from the artifact. Measured on the pinned pdf.js:
             * visible in the source, hidden in the output, status READY.
             *
             * A group written as a direct dictionary is refused for the same
             * reason it is refused on a form: `/OCGs` lists references, so
             * there is no way to prove a direct dictionary is the registered
             * one. This reader preserves semantics it can prove; it does not
             * repair a document's registration on its behalf.
             */
            if (!(raw instanceof PDFRef)) {
                out.unsupported.push(
                    `page ${sourceIndex} /Properties ${key.asString()} `
                    + 'names a group written directly rather than by reference',
                );
                continue;
            }
            if (!registered.has(raw.tag)) {
                out.unsupported.push(
                    `page ${sourceIndex} /Properties ${key.asString()} `
                    + 'names a group /OCProperties does not register',
                );
                continue;
            }
            out.pageProperties.push({
                sourcePageIndex: sourceIndex,
                pageIndex: position,
                key: key.asString(),
                ref: raw,
                name: pdfTextOf(look(doc, value.get(PDFName.of('Name')))),
            });
        }
    });

    /**
     * OC-C: an `/AS` entry may only name groups this selection actually keeps.
     *
     * Checked here, once both discovery passes have run, so the answer is known
     * before any page is copied: a usage application dictionary that survives
     * into an artifact naming a group the artifact does not contain is a
     * dangling reference, and a viewer applying it would act on a layer that is
     * not there. Refusing in planning is the same answer the copy would reach,
     * given before the work rather than after it.
     *
     * Real drawing sets reach this: a CAD export lists every layer of the whole
     * document in `/AS`, and an extract of some of its pages keeps only the
     * layers those pages use.
     */
    if (out.autoStates.length > 0) {
        const used = new Set<string>();
        for (const entry of out.pageProperties) used.add(entry.ref.tag);
        for (const usage of out.xobjectUsages) used.add(usage.ref.tag);
        const missing = new Set<string>();
        for (const entry of out.autoStates) {
            for (const ref of entry.ocgs) if (!used.has(ref.tag)) missing.add(ref.tag);
        }
        if (missing.size > 0) {
            out.unsupported.push(
                `/D /AS names ${missing.size} group(s) no selected page uses`,
            );
        }
    }

    return out;
}

export type OptionalContentPlan =
    | { status: 'NONE' }
    | { status: 'CARRY'; groups: number }
    | { status: 'REFUSE'; reason: string; unsupported: string[] };

export function planOptionalContent(oc: OptionalContentDescription): OptionalContentPlan {
    if (!oc.present) return { status: 'NONE' };
    if (oc.unsupported.length > 0) {
        return {
            status: 'REFUSE',
            reason: `この文書のオプショナルコンテンツは対応範囲外です: ${oc.unsupported.join(', ')}`,
            unsupported: oc.unsupported,
        };
    }
    return { status: 'CARRY', groups: oc.pageProperties.length };
}

/**
 * RF-R9-1 — the optional-content semantics of one loaded source, normalised.
 *
 * Everything the carry reproduces, by identity rather than by count: which
 * groups are registered and what they are called, every page `/Properties`
 * use, every form `/OC` use with the path that finds it and what the `/OC`
 * named (the OC-B membership dictionary included), `/D /Name`, `/BaseState`,
 * `/ON`, `/OFF`, `/Order`, `/AS` and the empty `/RBGroups`. Reference tags are
 * safe identities here because both sides are read from the same loaded
 * document; they are never compared across documents.
 *
 * Deterministic: collections whose order carries no meaning are sorted, so two
 * readings of the same semantics produce the same text.
 */
export function optionalContentSemantics(oc: OptionalContentDescription): Record<string, string> {
    const sorted = (items: string[]): string[] => [...items].sort();
    const field = (value: unknown): string => JSON.stringify(value ?? null);
    return {
        present: field(oc.present),
        groups: field(oc.groups.map((g) => [g.ref.tag, g.name])),
        pageProperties: field(sorted(oc.pageProperties.map((p) => JSON.stringify(
            [p.sourcePageIndex, p.pageIndex, p.key, p.ref.tag, p.name],
        )))),
        xobjectUsages: field(sorted(oc.xobjectUsages.map((u) => JSON.stringify(
            [u.sourcePageIndex, u.pageIndex, u.path, u.ref.tag, u.name, u.viaOcmd, u.ocRef, u.formRef],
        )))),
        dName: field(oc.dNameValue ?? oc.dName),
        baseState: field(oc.baseState),
        on: field(oc.onRefs),
        off: field(oc.offRefs),
        order: field([oc.orderPresent, oc.orderRefShape]),
        autoStates: field([
            oc.autoStatesPresent,
            oc.autoStates.map((e) => [e.event, e.categories, e.ocgs.map((r) => r.tag)]),
        ]),
        rbGroups: field(oc.emptyRbGroups),
        configs: field(oc.configs),
        unsupported: field(sorted(oc.unsupported)),
    };
}

export type SanitizedOptionalContentVerdict = {
    status: 'UNSUPPORTED_OPTIONAL_CONTENT' | 'PLAN_RUNTIME_MISMATCH';
    reason: string;
    detail: Record<string, unknown>;
} | null;

/**
 * RF-R9-1 — a source's optional content must come through its destructive
 * sanitization unchanged, or the operation is refused.
 *
 * None of those steps — signature widgets, destinations, attachments — is an
 * adopted optional-content transformation. So `before` (read before any of them
 * ran) and `after` (read on the source that will actually be copied) must
 * describe the same semantics, and `after` must still be supported. This is the
 * check an artifact census cannot make: a sanitizer that takes a group's `/OFF`
 * entry with it leaves a configuration that holds together perfectly, in which
 * the layer the author switched off is on.
 */
export function verifySanitizedOptionalContent(
    before: OptionalContentDescription,
    after: OptionalContentDescription,
): SanitizedOptionalContentVerdict {
    if (after.present && after.unsupported.length > 0) {
        return {
            status: 'UNSUPPORTED_OPTIONAL_CONTENT',
            reason: '安全のための除去処理の後、オプショナルコンテンツ（レイヤー）の構成が対応範囲外になったため処理しません: '
                + after.unsupported.join(', '),
            detail: { unsupported: after.unsupported, stage: 'after-sanitization' },
        };
    }
    const a = optionalContentSemantics(before);
    const b = optionalContentSemantics(after);
    const changed = Object.keys(a).filter((k) => a[k] !== b[k]);
    if (changed.length > 0) {
        return {
            status: 'PLAN_RUNTIME_MISMATCH',
            reason: '安全のための除去処理によって、オプショナルコンテンツ（レイヤー）の構成が'
                + '変わってしまうため処理しません。',
            detail: { mismatch: 'optional-content', changed },
        };
    }
    return null;
}

export type CarryOutcome =
    | { status: 'CARRIED'; carried: number; on: number; off: number; mapped: number }
    | { status: 'REFUSED'; reason: string; unsupported: string[] };

/**
 * Write the configuration the kept pages need onto the output.
 *
 * The groups themselves travel with the pages — they are reachable through
 * `/Resources /Properties` — so what has to be rebuilt is the catalog entry
 * saying which of them are on, and it is rebuilt from the output's own
 * references, reached through the same `(page, key)` pairs the source used.
 */
export function carryOptionalContent(
    source: PDFDocument,
    description: OptionalContentDescription,
    out: PDFDocument,
): CarryOutcome {
    const outPages = out.getPages();
    const sourceRefToOutputRef = new Map<string, PDFRef>();
    const outputRefByTag = new Map<string, PDFRef>();

    for (const entry of description.pageProperties) {
        const page = outPages[entry.pageIndex];
        if (!page) continue;
        const resources = page.node.lookup(PDFName.of('Resources'));
        const properties = resources instanceof PDFDict
            ? resources.lookup(PDFName.of('Properties'))
            : undefined;
        if (!(properties instanceof PDFDict)) continue;
        const raw = properties.get(PDFName.of(entry.key.replace(/^\//, '')));
        if (!(raw instanceof PDFRef)) continue;
        sourceRefToOutputRef.set(entry.ref.tag, raw);
        outputRefByTag.set(raw.tag, raw);
    }

    /**
     * OC-A / OC-B: the groups a page uses through a form XObject's `/OC`.
     *
     * `copyPages` copied the form and the `/OC` reference with it, so the
     * output already holds the group object; what it does not hold is any
     * record that the group exists. The same form is found again by walking the
     * output's resources along the path the source walk recorded — structure,
     * not object identity, because every reference is a different number here.
     *
     * A usage the description promised and the output cannot show is a refusal.
     * Leaving it would produce exactly the artifact this expansion exists to
     * prevent: a live `/OC` naming a group `/OCProperties` never lists, which a
     * viewer resolves to its own default and draws a hidden layer visible.
     */
    const formAtPath = (page: PDFPage, path: string[]): PDFDict | null => {
        let resources: unknown = page.node.Resources();
        let form: PDFDict | null = null;
        for (const key of path) {
            if (!(resources instanceof PDFDict)) return null;
            const xobjects = resources.lookup(PDFName.of('XObject'));
            if (!(xobjects instanceof PDFDict)) return null;
            const dict = dictOf(xobjects.lookup(PDFName.of(key)));
            if (!dict) return null;
            form = dict;
            resources = dict.lookup(PDFName.of('Resources'));
        }
        return form;
    };

    const unresolvedUsage = (use: XObjectOcUsage, what: string): CarryOutcome => {
        const where = `page ${use.pageIndex} /XObject ${use.path.join(' /XObject ')}`;
        return {
            status: 'REFUSED',
            reason: `オプショナルコンテンツの対象を再現できません: ${where} ${what}`,
            unsupported: [`${where} ${what}`],
        };
    };

    /**
     * RF-R8R-2: a path is a witness, not an identity. The walk records one
     * `/XObject` path per form and context, which is enough only because one
     * source form becomes one written form. That is checked, not assumed: the
     * same source form found as two written forms, or two source forms found as
     * one, is a refusal.
     */
    const writtenBySource = new Map<string, PDFDict>();
    const sourceByWritten = new Map<PDFDict, string>();

    for (const use of description.xobjectUsages) {
        const page = outPages[use.pageIndex];
        if (!page) continue;
        const form = formAtPath(page, use.path);
        if (!form) return unresolvedUsage(use, 'is not in the written page');
        if (use.formRef !== null) {
            const written = writtenBySource.get(use.formRef);
            if (written !== undefined && written !== form) {
                return unresolvedUsage(use, 'is one source form found as two written forms');
            }
            const source = sourceByWritten.get(form);
            if (source !== undefined && source !== use.formRef) {
                return unresolvedUsage(use, 'is a written form two source forms both lead to');
            }
            writtenBySource.set(use.formRef, form);
            sourceByWritten.set(form, use.formRef);
        }
        const rawOc = form.get(PDFName.of('OC'));
        if (!(rawOc instanceof PDFRef)) return unresolvedUsage(use, '/OC did not survive the copy');

        /**
         * What is in the output decides this, not what the source looked like.
         *
         * The two are the same on the first usage of a form. They differ on the
         * second, because one form can be named by more than one edge — two
         * `/XObject` keys, a nested path and a direct one, a cycle — and
         * edge-local classification records each of them (BLK-R7-A). The first
         * usage of a shared form reduced its `/OCMD` to the group; by the time
         * the second arrives, `use.viaOcmd` still says "membership dictionary"
         * while the output already holds the group. Branching on the source
         * would refuse an artifact this reader itself just made correct.
         */
        let groupRef: PDFRef | null = null;
        const target = out.context.lookup(rawOc);
        const targetType = target instanceof PDFDict ? nameOf(target.get(PDFName.of('Type'))) : '';
        if (targetType === '/OCMD') {
            // OC-B: the copied membership dictionary is replaced by the single
            // group it named. pdf.js evaluates the two identically, and
            // carrying the group alone keeps the output's supported shapes to
            // the ones this reader can prove.
            const members = (target as PDFDict).get(PDFName.of('OCGs'));
            const resolved = members instanceof PDFRef ? out.context.lookup(members) : members;
            if (members instanceof PDFRef && resolved instanceof PDFDict) {
                groupRef = members;
            } else if (resolved instanceof PDFArray && resolved.size() === 1) {
                const only = resolved.get(0);
                if (only instanceof PDFRef) groupRef = only;
            }
            if (!groupRef) return unresolvedUsage(use, '/OC names a membership dictionary this output cannot reduce');
            form.set(PDFName.of('OC'), groupRef);
        } else if (targetType === '/OCG') {
            // OC-A, or a form an earlier usage of the same object already
            // reduced. Either way the output already names the group.
            groupRef = rawOc;
        } else {
            return unresolvedUsage(use, '/OC does not name a group this output can register');
        }

        sourceRefToOutputRef.set(use.ref.tag, groupRef);
        outputRefByTag.set(groupRef.tag, groupRef);
    }

    const ordered: PDFRef[] = [];
    const pushOnce = (ref: PDFRef | undefined): void => {
        if (!ref) return;
        if (ordered.some((r) => r.tag === ref.tag)) return;
        ordered.push(ref);
    };

    const sourceOc = source.catalog.lookup(PDFName.of('OCProperties'));
    const sourceD = sourceOc instanceof PDFDict ? sourceOc.lookup(PDFName.of('D')) : null;
    if (sourceOc instanceof PDFDict) {
        for (const ref of refsOf(sourceOc.lookup(PDFName.of('OCGs')))) {
            pushOnce(sourceRefToOutputRef.get(ref.tag));
        }
    }
    for (const ref of outputRefByTag.values()) pushOnce(ref);

    if (ordered.length === 0) {
        return { status: 'CARRIED', carried: 0, on: 0, off: 0, mapped: 0 };
    }

    /**
     * `/Order`, mapped recursively rather than flattened, with the same label
     * rule the reader applied. A reference to a group no kept page uses is a
     * refusal rather than a silent omission: dropping it would change the
     * structure the layer panel is drawn from while leaving the same groups
     * behind.
     */
    const mapOrder = (node: unknown, depth: number, labelAllowed: boolean): unknown => {
        if (depth > MECHANISM_BOUNDS.maxOrderDepth) {
            throw new Error('/D /Order nested too deep to reproduce');
        }
        const value = look(source, node);
        if (value instanceof PDFArray) {
            const mapped: unknown[] = [];
            for (let i = 0; i < value.size(); i += 1) {
                mapped.push(mapOrder(value.get(i), depth + 1, depth > 0 && i === 0));
            }
            return mapped;
        }
        if (node instanceof PDFRef) {
            const target = sourceRefToOutputRef.get(node.tag);
            if (!target) throw new Error('/D /Order names a group no kept page uses');
            return target;
        }
        if (isStringObject(value)) {
            const read = readPdfText(value);
            if (!read.ok) throw new Error(`/D /Order holds a text label that cannot be read: it ${read.reason}`);
            if (!labelAllowed) {
                throw new Error('/D /Order holds a text label in a position this reader cannot reproduce');
            }
            // BLK-R4-1: the label as it was written, not its decoded text
            // re-wrapped in a literal that drops high bytes and escapes nothing.
            return pdfTextObject(read.value);
        }
        throw new Error('/D /Order holds an entry that cannot be reproduced');
    };

    const mapAll = (refs: PDFRef[]): PDFRef[] => {
        const mapped: PDFRef[] = [];
        for (const ref of refs) {
            const target = sourceRefToOutputRef.get(ref.tag);
            if (target && !mapped.some((r) => r.tag === target.tag)) mapped.push(target);
        }
        return mapped;
    };

    const on = sourceD instanceof PDFDict ? mapAll(refsOf(sourceD.lookup(PDFName.of('ON')))) : [];
    const off = sourceD instanceof PDFDict ? mapAll(refsOf(sourceD.lookup(PDFName.of('OFF')))) : [];

    const d: Record<string, unknown> = {};
    // Absent stays absent and empty stays empty. Fabricating an `/Order` for a
    // document that had none, or filling in one that was deliberately empty, is
    // a change to what a viewer shows.
    if (description.orderPresent && sourceD instanceof PDFDict) {
        try {
            d.Order = mapOrder(sourceD.get(PDFName.of('Order')), 0, false);
        } catch (error) {
            const message = String((error as Error)?.message ?? error);
            return {
                status: 'REFUSED',
                reason: `オプショナルコンテンツの表示順を再現できません: ${message}`,
                unsupported: [message],
            };
        }
    }
    if (on.length > 0) d.ON = on;
    if (off.length > 0) d.OFF = off;
    if (description.dNameValue !== null) d.Name = pdfTextObject(description.dNameValue);
    if (description.baseState === SUPPORTED_BASE_STATE) d.BaseState = PDFName.of('ON');

    // OC-C: every `/AS` entry, remapped. An entry naming a group no kept page
    // uses is a refusal rather than an entry quietly dropped — the state it
    // applies is part of what the author asked a viewer to do.
    if (description.autoStatesPresent) {
        const autoStates: unknown[] = [];
        for (const entry of description.autoStates) {
            const mapped: PDFRef[] = [];
            for (const ref of entry.ocgs) {
                const target = sourceRefToOutputRef.get(ref.tag);
                if (!target) {
                    const message = '/D /AS names a group no kept page uses';
                    return {
                        status: 'REFUSED',
                        reason: `オプショナルコンテンツの自動状態を再現できません: ${message}`,
                        unsupported: [message],
                    };
                }
                if (!mapped.some((r) => r.tag === target.tag)) mapped.push(target);
            }
            autoStates.push({
                Event: PDFName.of(entry.event.replace(LEADING_SLASH, '')),
                Category: entry.categories.map((c) => PDFName.of(c.replace(LEADING_SLASH, ''))),
                OCGs: mapped,
            });
        }
        d.AS = autoStates;
    }
    // OC-D: the empty array is the only supported value, and it is written back
    // as the empty array rather than left out.
    if (description.emptyRbGroups) d.RBGroups = [];

    /**
     * Merged into whatever is already there, not written over it.
     *
     * A Merge carries one source at a time, and replacing `/OCProperties` per
     * source left the artifact holding only the last one's groups — measured:
     * two sources, each with its own layer, and the output listed one. The
     * groups from every source are accumulated, and so are `/ON`, `/OFF` and
     * `/Order`.
     */
    const existing = out.catalog.lookup(PDFName.of('OCProperties'));
    if (existing instanceof PDFDict) {
        const mergedGroups = [...refsOf(existing.lookup(PDFName.of('OCGs')))];
        for (const ref of ordered) {
            if (!mergedGroups.some((r) => r.tag === ref.tag)) mergedGroups.push(ref);
        }
        const previousD = existing.lookup(PDFName.of('D'));
        const mergedD: Record<string, unknown> = {};
        if (previousD instanceof PDFDict) {
            const previousOn = refsOf(previousD.lookup(PDFName.of('ON')));
            const previousOff = refsOf(previousD.lookup(PDFName.of('OFF')));
            const combinedOn = dedupeRefs([...previousOn, ...on]);
            const combinedOff = dedupeRefs([...previousOff, ...off]);
            if (combinedOn.length > 0) mergedD.ON = combinedOn;
            if (combinedOff.length > 0) mergedD.OFF = combinedOff;
            /**
             * RF-R3-1 — the configuration's own semantics travel with it.
             *
             * This branch rebuilt `/D` from `/ON`, `/OFF` and `/Order` alone,
             * so the second accepted source dropped `/Name` and `/BaseState`
             * — both the previous source's and its own. Measured: two sources
             * that agree on `/D /Name (Config A)` merged to a `/D` with no
             * `/Name` at all, READY, no loss reported. There was not even a
             * silent winner; both were discarded.
             *
             * `runMerge` has already refused a disagreement on either key
             * before the carry reaches here, so a value that exists is one
             * every accepted source agrees with.
             */
            const previousName = previousD.lookup(PDFName.of('Name'));
            const name = previousName !== undefined ? previousName : d.Name;
            if (name !== undefined) mergedD.Name = name;
            const previousBase = previousD.lookup(PDFName.of('BaseState'));
            const baseState = previousBase !== undefined ? previousBase : d.BaseState;
            if (baseState !== undefined) mergedD.BaseState = baseState;
            // Each source's `/AS` entries are kept, already remapped to output
            // groups, so no source's usage application dictionary is lost to
            // another's.
            const previousAs = previousD.lookup(PDFName.of('AS'));
            if (previousAs instanceof PDFArray || d.AS !== undefined) {
                const combinedAs: unknown[] = [];
                if (previousAs instanceof PDFArray) {
                    for (let i = 0; i < previousAs.size(); i += 1) combinedAs.push(previousAs.get(i));
                }
                if (Array.isArray(d.AS)) combinedAs.push(...d.AS);
                mergedD.AS = combinedAs;
            }
            // Only the empty array is ever supported, so the union of two of
            // them is the empty array.
            const previousRbGroups = previousD.lookup(PDFName.of('RBGroups'));
            if (previousRbGroups !== undefined || d.RBGroups !== undefined) mergedD.RBGroups = [];
            const previousOrder = previousD.lookup(PDFName.of('Order'));
            const thisOrder = d.Order;
            if (previousOrder instanceof PDFArray || thisOrder !== undefined) {
                const combined: unknown[] = [];
                if (previousOrder instanceof PDFArray) {
                    for (let i = 0; i < previousOrder.size(); i += 1) combined.push(previousOrder.get(i));
                }
                if (Array.isArray(thisOrder)) combined.push(...thisOrder);
                else if (thisOrder !== undefined) combined.push(thisOrder);
                if (combined.length > 0) mergedD.Order = combined;
            }
        } else {
            Object.assign(mergedD, d);
        }
        out.catalog.set(
            PDFName.of('OCProperties'),
            out.context.obj({ OCGs: mergedGroups, D: mergedD } as never),
        );
    } else {
        out.catalog.set(
            PDFName.of('OCProperties'),
            out.context.obj({ OCGs: ordered, D: d } as never),
        );
    }

    return {
        status: 'CARRIED',
        carried: ordered.length,
        on: on.length,
        off: off.length,
        mapped: sourceRefToOutputRef.size,
    };
}

/**
 * What an artifact's optional content actually is — measured on the bytes that
 * were written, not on the intentions of the code that wrote them.
 */
export interface OptionalContentFacts {
    /** Live `/OC` entries found anywhere in the artifact. */
    uses: number;
    /** Groups the artifact's `/OCProperties /OCGs` registers. */
    registeredGroups: number;
    /** `/OC` entries naming an object the artifact does not hold. Must be 0. */
    danglingUses: number;
    /** `/OC` entries naming a group `/OCProperties` does not register. Must be 0. */
    unregisteredUses: number;
    /** `/OC` entries still naming a membership dictionary. Must be 0. */
    ocmdSurvivors: number;
    /**
     * RF-R8R-1: `/Properties` entries naming an optional-content group or
     * membership dictionary — the marked-content channel (`/OC /MC0 BDC`), which
     * holds no `/OC` key at all. Not itself a failure; the dangling,
     * unregistered and membership-dictionary counts above include these.
     */
    propertyUses: number;
    /**
     * Configuration entries naming something other than a registered output
     * group, plus the output shapes this contract does not allow. Must be 0.
     */
    configErrors: number;
    /** What was found, so a refusal can name it rather than only count it. */
    detail: string[];
}

/** Enough to name the problem; a refusal does not need the whole list. */
const OC_DETAIL_CAP = 6;

/**
 * RF-R8-1 — the artifact proves its own optional content is self-consistent.
 *
 * `describeOptionalContent` reads a *source* to decide what may be carried.
 * This reads an *artifact* to decide whether what was carried holds together,
 * and the two are deliberately not the same walk. A reader that re-used the
 * resource walker would inherit its blind paths, and inheriting the blind paths
 * is exactly the failure this exists to catch: BLK-R7-A produced a READY
 * artifact with a live `/OC`, no `/OCProperties` at all, and a layer the author
 * had switched off drawn in full — and no invariant noticed, because there was
 * no optional-content invariant to notice it.
 *
 * So the scope here is every indirect object in the artifact, through the same
 * COMPLETE-or-REFUSED census the JavaScript, attachment and signature scans
 * use. Nothing has to be *discovered* by traversal to be inspected, which is
 * what makes this a backstop rather than a second opinion from the same
 * witness. The walk never follows a reference — each target is its own root —
 * and the few lookups below are direct, on references the walk already holds.
 *
 * Two outcomes, as always. A structure this proof needs and cannot read is
 * REFUSED; a structure it can read and that does not hold together is counted.
 * Both stop an artifact being handed over.
 */
export function censusOptionalContent(doc: PDFDocument): CensusOutcome<OptionalContentFacts> {
    const facts: OptionalContentFacts = {
        uses: 0,
        registeredGroups: 0,
        danglingUses: 0,
        unregisteredUses: 0,
        ocmdSurvivors: 0,
        propertyUses: 0,
        configErrors: 0,
        detail: [],
    };
    const note = (text: string): void => {
        if (facts.detail.length < OC_DETAIL_CAP) facts.detail.push(text);
    };
    const configError = (text: string): void => {
        facts.configErrors += 1;
        note(text);
    };
    const refused = (reason: string): CensusOutcome<OptionalContentFacts> => (
        { complete: false, reason, nodes: 0, roots: 0 }
    );

    // ---- the configuration ---------------------------------------------------
    let rawOcProperties: unknown;
    try {
        rawOcProperties = doc.catalog.get(PDFName.of('OCProperties'));
    } catch (error) {
        return refused(
            '書き出したPDFのオプショナルコンテンツ設定を読み取れませんでした: '
            + String((error as Error)?.message ?? error),
        );
    }

    const registered = new Set<string>();
    let config: PDFDict | null = null;
    const present = rawOcProperties !== undefined && rawOcProperties !== PDFNull;

    if (present) {
        const read = resolve(doc, rawOcProperties);
        if (!read.ok) return refused(`書き出したPDFの /OCProperties ${read.reason}`);
        if (!(read.value instanceof PDFDict)) {
            return refused('書き出したPDFの /OCProperties が辞書ではありません。');
        }
        const ocProperties = read.value;

        // RF-R8R-1: the output envelope, not only its references. This tool
        // writes `/OCGs` and `/D` and nothing else — `/Configs` in particular
        // is refused at the source, so one here was not carried by anything
        // this contract proved.
        for (const [k] of ocProperties.entries()) {
            const key = k.asString().replace(LEADING_SLASH, '');
            if (key !== 'OCGs' && key !== 'D') configError(`/OCProperties /${key} is not written by this output`);
        }

        const rawGroups = ocProperties.get(PDFName.of('OCGs'));
        if (rawGroups === undefined) {
            return refused('書き出したPDFの /OCProperties に /OCGs がありません。');
        }
        const groupsRead = resolve(doc, rawGroups);
        if (!groupsRead.ok) return refused(`書き出したPDFの /OCProperties /OCGs ${groupsRead.reason}`);
        if (!(groupsRead.value instanceof PDFArray)) {
            return refused('書き出したPDFの /OCProperties /OCGs が配列ではありません。');
        }
        for (let i = 0; i < groupsRead.value.size(); i += 1) {
            const member = groupsRead.value.get(i);
            if (!(member instanceof PDFRef)) {
                facts.configErrors += 1;
                note(`/OCProperties /OCGs[${i}] is not a reference to a group`);
                continue;
            }
            const target = look(doc, member);
            if (!(target instanceof PDFDict) || nameOf(target.get(PDFName.of('Type'))) !== '/OCG') {
                facts.configErrors += 1;
                note(`/OCProperties /OCGs[${i}] does not resolve to a group`);
                continue;
            }
            registered.add(member.tag);
        }
        facts.registeredGroups = registered.size;

        const rawD = ocProperties.get(PDFName.of('D'));
        if (rawD === undefined) {
            return refused('書き出したPDFの /OCProperties に /D がありません。');
        }
        const dRead = resolve(doc, rawD);
        if (!dRead.ok) return refused(`書き出したPDFの /OCProperties /D ${dRead.reason}`);
        if (!(dRead.value instanceof PDFDict)) {
            return refused('書き出したPDFの /OCProperties /D が辞書ではありません。');
        }
        config = dRead.value;
    }

    if (config !== null) {
        const configured = config;

        // RF-R8R-1: the `/D` keys this output writes, and no others. `/Locked`,
        // `/Intent`, `/ListMode` and the rest are refused at the source, so one
        // in an artifact was not produced by anything this contract proved.
        for (const [k] of configured.entries()) {
            const key = k.asString().replace(LEADING_SLASH, '');
            if (!HANDLED_D_KEYS.includes(key)) configError(`/D /${key} is not written by this output`);
        }
        const rawBase = configured.get(PDFName.of('BaseState'));
        if (rawBase !== undefined && nameOf(look(doc, rawBase)) !== SUPPORTED_BASE_STATE) {
            configError(`/D /BaseState is not ${SUPPORTED_BASE_STATE}, the only state this output writes`);
        }

        const membersOf = (key: string): Set<string> => {
            const tags = new Set<string>();
            const raw = configured.get(PDFName.of(key));
            if (raw === undefined) return tags;
            const read = resolve(doc, raw);
            if (!read.ok || !(read.value instanceof PDFArray)) {
                configError(`/D /${key} is not a readable array`);
                return tags;
            }
            for (let i = 0; i < read.value.size(); i += 1) {
                const member = read.value.get(i);
                if (!(member instanceof PDFRef) || !registered.has(member.tag)) {
                    configError(`/D /${key}[${i}] does not name a registered group`);
                    continue;
                }
                tags.add(member.tag);
            }
            return tags;
        };
        const onTags = membersOf('ON');
        const offTags = membersOf('OFF');
        // RF-R9-2: one group in both lists has no single state, and this output
        // never writes one — the source is refused before it gets here.
        for (const tag of onTags) {
            if (offTags.has(tag)) configError(`/D /ON and /D /OFF both list ${tag}`);
        }

        // `/Order` nests, and a nested array may open with a text label. Only a
        // group reference has to be registered; the rest is shape.
        let orderTooDeep = false;
        const walkOrder = (node: unknown, depth: number): void => {
            if (depth > MECHANISM_BOUNDS.maxOrderDepth) {
                orderTooDeep = true;
                return;
            }
            if (node instanceof PDFRef) {
                if (!registered.has(node.tag)) {
                    facts.configErrors += 1;
                    note('/D /Order names a group the artifact does not register');
                }
                return;
            }
            const value = look(doc, node);
            if (value instanceof PDFArray) {
                for (let i = 0; i < value.size(); i += 1) walkOrder(value.get(i), depth + 1);
                return;
            }
            if (isStringObject(value)) return;
            facts.configErrors += 1;
            note('/D /Order holds an entry that is neither a group, an array nor a label');
        };
        const rawOrder = configured.get(PDFName.of('Order'));
        if (rawOrder !== undefined) {
            const read = resolve(doc, rawOrder);
            if (!read.ok || !(read.value instanceof PDFArray)) {
                facts.configErrors += 1;
                note('/D /Order is not a readable array');
            } else {
                walkOrder(read.value, 0);
            }
        }
        if (orderTooDeep) {
            return refused(
                `書き出したPDFの /D /Order が ${MECHANISM_BOUNDS.maxOrderDepth} 段より深く、確認できませんでした。`,
            );
        }

        const rawAs = configured.get(PDFName.of('AS'));
        if (rawAs !== undefined) {
            const read = resolve(doc, rawAs);
            if (!read.ok || !(read.value instanceof PDFArray)) {
                facts.configErrors += 1;
                note('/D /AS is not a readable array');
            } else {
                for (let i = 0; i < read.value.size(); i += 1) {
                    const entryRead = resolve(doc, read.value.get(i));
                    if (!entryRead.ok || !(entryRead.value instanceof PDFDict)) {
                        facts.configErrors += 1;
                        note(`/D /AS[${i}] is not a readable dictionary`);
                        continue;
                    }
                    // RF-R8R-1: the whole OC-C envelope, read independently of
                    // the source reader that decided it — three keys, one of
                    // three events, a category array of names.
                    const entry = entryRead.value;
                    for (const [k] of entry.entries()) {
                        const key = k.asString().replace(LEADING_SLASH, '');
                        if (!HANDLED_AS_KEYS.includes(key)) configError(`/D /AS[${i}] carries /${key}`);
                    }
                    const event = nameOf(look(doc, entry.get(PDFName.of('Event'))));
                    if (!SUPPORTED_AS_EVENTS.includes(event)) {
                        configError(`/D /AS[${i}] /Event is ${event || 'missing'}, which this output never writes`);
                    }
                    const categoryRead = resolve(doc, entry.get(PDFName.of('Category')));
                    if (!categoryRead.ok || !(categoryRead.value instanceof PDFArray)) {
                        configError(`/D /AS[${i}] /Category is not a readable array`);
                    } else {
                        for (let c = 0; c < categoryRead.value.size(); c += 1) {
                            if (!(categoryRead.value.get(c) instanceof PDFName)) {
                                configError(`/D /AS[${i}] /Category[${c}] is not a name`);
                            }
                        }
                    }
                    const groupsRead = resolve(doc, entry.get(PDFName.of('OCGs')));
                    if (!groupsRead.ok || !(groupsRead.value instanceof PDFArray)) {
                        facts.configErrors += 1;
                        note(`/D /AS[${i}] /OCGs is not a readable array`);
                        continue;
                    }
                    for (let g = 0; g < groupsRead.value.size(); g += 1) {
                        const member = groupsRead.value.get(g);
                        if (!(member instanceof PDFRef) || !registered.has(member.tag)) {
                            facts.configErrors += 1;
                            note(`/D /AS[${i}] /OCGs[${g}] does not name a registered group`);
                        }
                    }
                }
            }
        }

        // OC-D: the only radio-button shape this tool writes is the empty array.
        const rawRbGroups = configured.get(PDFName.of('RBGroups'));
        if (rawRbGroups !== undefined) {
            const read = resolve(doc, rawRbGroups);
            if (!read.ok || !(read.value instanceof PDFArray)) {
                facts.configErrors += 1;
                note('/D /RBGroups is not a readable array');
            } else if (read.value.size() > 0) {
                facts.configErrors += 1;
                note(`/D /RBGroups holds ${read.value.size()} group(s), which this output never writes`);
            }
        }
    }

    // ---- every live `/OC`, and every `/Properties` map, wherever they are ------
    const pending: { rootTag: string; raw: unknown }[] = [];
    const propertyMaps: { rootTag: string; raw: unknown }[] = [];
    const outcome = censusIndirectObjects(doc, ({ dict, rootTag }) => {
        const properties = dict.get(PDFName.of('Properties'));
        if (properties !== undefined && properties !== PDFNull) propertyMaps.push({ rootTag, raw: properties });
        const raw = dict.get(PDFName.of('OC'));
        // A null entry is the same as an absent one, and is not a use.
        if (raw === undefined || raw === PDFNull) return;
        pending.push({ rootTag, raw });
    });
    if (!outcome.complete) return outcome;

    /**
     * RF-R8R-1 — the marked-content channel.
     *
     * `/OC /MC0 BDC … EMC` in a content stream names its group through a
     * resource dictionary's `/Properties`, so it holds no `/OC` key for the scan
     * above to find. That is the channel the original M6-H9b defect lived in,
     * and the one BLK-R7-B shipped through: a page property naming a group the
     * artifact does not register draws, whatever the author switched off.
     *
     * Every `/Properties` map anywhere in the artifact is read — a page's own,
     * an inherited one on a `/Pages` node, a form's — so a page's effective
     * resources are covered without walking the page tree. An entry that names
     * a group must name a registered one by reference; a membership dictionary
     * is a shape this output never writes; an entry naming nothing is a use
     * whose meaning cannot be known. An ordinary property list — marked content
     * that is not optional content — is not a use, and is left alone.
     */
    for (const { rootTag, raw } of propertyMaps) {
        const mapRead = resolve(doc, raw);
        if (!mapRead.ok) {
            facts.danglingUses += 1;
            note(`object ${rootTag} /Properties ${mapRead.reason}`);
            continue;
        }
        if (!(mapRead.value instanceof PDFDict)) continue;
        for (const [key, entry] of mapRead.value.entries()) {
            const name = `object ${rootTag} /Properties ${key.asString()}`;
            const target = entry instanceof PDFRef ? look(doc, entry) : entry;
            if (entry instanceof PDFRef && target === undefined) {
                facts.propertyUses += 1;
                facts.danglingUses += 1;
                note(`${name} points at ${entry.tag}, which is not in the artifact`);
                continue;
            }
            const targetDict = dictOf(target);
            const type = targetDict ? nameOf(targetDict.get(PDFName.of('Type'))) : '';
            if (type === '/OCMD') {
                facts.propertyUses += 1;
                facts.ocmdSurvivors += 1;
                note(`${name} names a membership dictionary`);
                continue;
            }
            if (type !== '/OCG') continue;
            facts.propertyUses += 1;
            if (!(entry instanceof PDFRef)) {
                facts.unregisteredUses += 1;
                note(`${name} is a group written directly rather than by reference`);
            } else if (!registered.has(entry.tag)) {
                facts.unregisteredUses += 1;
                note(
                    present
                        ? `${name} names a group /OCProperties does not register`
                        : `${name} names a group, and the artifact declares no /OCProperties`,
                );
            }
        }
    }

    for (const { rootTag, raw } of pending) {
        facts.uses += 1;
        if (!(raw instanceof PDFRef)) {
            // `/OCGs` lists references, so a group written any other way cannot
            // be shown to be one the artifact registers.
            facts.unregisteredUses += 1;
            note(`object ${rootTag} /OC is not a reference to a group`);
            continue;
        }
        const target = look(doc, raw);
        if (target === undefined) {
            facts.danglingUses += 1;
            note(`object ${rootTag} /OC points at ${raw.tag}, which is not in the artifact`);
            continue;
        }
        const targetDict = dictOf(target);
        const type = targetDict ? nameOf(targetDict.get(PDFName.of('Type'))) : '';
        if (type === '/OCMD') {
            // OC-B is canonicalized to the group itself, so a surviving
            // membership dictionary is a shape this output never writes.
            facts.ocmdSurvivors += 1;
            note(`object ${rootTag} /OC still names a membership dictionary`);
            continue;
        }
        if (type !== '/OCG') {
            facts.unregisteredUses += 1;
            note(`object ${rootTag} /OC names ${type || 'something that is not a group'}`);
            continue;
        }
        if (!registered.has(raw.tag)) {
            facts.unregisteredUses += 1;
            note(
                present
                    ? `object ${rootTag} /OC names a group /OCProperties does not register`
                    : `object ${rootTag} /OC names a group, and the artifact declares no /OCProperties`,
            );
        }
    }

    return { complete: true, value: facts, nodes: outcome.nodes, roots: outcome.roots };
}
