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
    ref: PDFRef | null;
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
 * Walk one kept page's resource graph, refusing every attachment point this
 * reader does not rebuild.
 *
 * A visited set keyed on indirect references makes a cycle terminate and a
 * shared object count once. `/ColorSpace` and `/Shading` are deliberately not
 * opened: they hold no content stream, so they open no resource scope and carry
 * no `/OC`. That is a statement about scope, not about safety.
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
    const visited = new Set<string>();
    const refuse = (text: string): void => {
        unsupported.push(text);
    };

    const record = (path: string[], ref: PDFRef, group: PDFDict, viaOcmd: boolean): void => {
        usages.push({
            sourcePageIndex: sourceIndex,
            pageIndex,
            path: [...path],
            ref,
            name: pdfTextOf(look(doc, group.get(PDFName.of('Name')))),
            viaOcmd,
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
    const classifyOcmd = (target: PDFDict, where: string, path: string[]): void => {
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
        record(path, ref, group, true);
    };

    /**
     * OC-A: `/OC` on a form XObject, naming a registered group.
     *
     * `path === null` means this stream was not reached through `/XObject`
     * resources — a soft mask's `/G`, an annotation appearance — and those
     * positions keep refusing, because nothing has shown what carrying them
     * would mean. Presence alone is no longer the refusal; what the `/OC`
     * actually resolves to decides it.
     */
    const classifyOc = (dict: PDFDict, ocRaw: unknown, where: string, path: string[] | null): void => {
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
            classifyOcmd(r.value, where, path);
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
        record(path, ocRaw, r.value, false);
    };

    const firstVisit = (raw: unknown): boolean => {
        if (!(raw instanceof PDFRef)) return true;
        if (visited.has(raw.tag)) return false;
        visited.add(raw.tag);
        return true;
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

    const walkResources = (raw: unknown, where: string, depth: number, path: string[] | null): void => {
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
                walkStream(
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
                walkStream(entry, `${where} /Pattern ${key.asString()}`, depth, false, null);
            }
        }

        const fonts = subDict(resources, 'Font', where);
        if (fonts) {
            for (const [key, entry] of fonts.entries()) {
                walkType3(entry, `${where} /Font ${key.asString()}`, depth);
            }
        }

        const graphicsStates = subDict(resources, 'ExtGState', where);
        if (graphicsStates) {
            for (const [key, entry] of graphicsStates.entries()) {
                walkSoftMask(entry, `${where} /ExtGState ${key.asString()}`, depth);
            }
        }
    };

    function walkStream(
        raw: unknown,
        where: string,
        depth: number,
        ocApplies: boolean,
        path: string[] | null,
    ): void {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        if (!firstVisit(raw)) return;
        const dict = dictOf(r.value);
        if (!dict) {
            refuse(`${where} is not a dictionary or stream`);
            return;
        }
        const ocRaw = dict.get(PDFName.of('OC'));
        if (ocApplies && ocRaw !== undefined) classifyOc(dict, ocRaw, where, path);
        walkResources(dict.get(PDFName.of('Resources')), where, depth + 1, path);
    }

    /**
     * A Type 3 font draws its glyphs with content streams, and those streams
     * take their resources from the font. Other font types hold no content
     * stream and are passed over.
     */
    function walkType3(raw: unknown, where: string, depth: number): void {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        const font = dictOf(r.value);
        if (!font || nameOf(font.get(PDFName.of('Subtype'))) !== '/Type3') return;
        if (!firstVisit(raw)) return;
        walkResources(font.get(PDFName.of('Resources')), where, depth + 1, null);
        const procs = subDict(font, 'CharProcs', where);
        if (procs) {
            for (const [glyph, entry] of procs.entries()) {
                walkStream(entry, `${where} /CharProcs ${glyph.asString()}`, depth + 1, false, null);
            }
        }
    }

    /**
     * A graphics state's soft mask — the path that was not walked until B1, and
     * through which `ocg-extgstate-smask` extracted READY with a group behind
     * it.
     *
     * No `/SMask` and `/SMask /None` both mean no mask, and neither is a reason
     * to refuse. A mask paints with its `/G`, a transparency group form, so `/G`
     * is walked like any other form — through the same `walkStream`, sharing the
     * visited set and the depth bound rather than keeping a recursion of its own.
     * Anything that cannot be read as one of those shapes is refused: an
     * unreadable mask is not an absent one.
     */
    function walkSoftMask(raw: unknown, where: string, depth: number): void {
        const r = resolve(doc, raw);
        if (!r.ok) {
            refuse(`${where} ${r.reason}`);
            return;
        }
        if (!firstVisit(raw)) return;
        if (!(r.value instanceof PDFDict)) {
            refuse(`${where} is not a graphics state dictionary`);
            return;
        }
        const rawMask = r.value.get(PDFName.of('SMask'));
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
        walkStream(rawGroup, groupWhere, depth, true, null);
    }

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
                    walkStream(stream, `${apWhere} ${state.asString()}`, 0, true, null);
                }
            } else {
                walkStream(entry, apWhere, 0, true, null);
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
    walkResources(
        effectiveResources(doc, pageNode, `page ${sourceIndex}`, refuse),
        `page ${sourceIndex}`,
        0,
        [],
    );
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
        out.on = refsOf(look(doc, d.get(PDFName.of('ON')))).map(nameOfGroup);
        out.off = refsOf(look(doc, d.get(PDFName.of('OFF')))).map(nameOfGroup);
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
            out.pageProperties.push({
                sourcePageIndex: sourceIndex,
                pageIndex: position,
                key: key.asString(),
                ref: raw instanceof PDFRef ? raw : null,
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
        for (const entry of out.pageProperties) if (entry.ref) used.add(entry.ref.tag);
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
        if (entry.ref) sourceRefToOutputRef.set(entry.ref.tag, raw);
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

    for (const use of description.xobjectUsages) {
        const page = outPages[use.pageIndex];
        if (!page) continue;
        const form = formAtPath(page, use.path);
        if (!form) return unresolvedUsage(use, 'is not in the written page');
        const rawOc = form.get(PDFName.of('OC'));
        if (!(rawOc instanceof PDFRef)) return unresolvedUsage(use, '/OC did not survive the copy');

        let groupRef: PDFRef | null = null;
        if (use.viaOcmd) {
            // OC-B: the copied membership dictionary is replaced by the single
            // group it named. pdf.js evaluates the two identically, and
            // carrying the group alone keeps the output's supported shapes to
            // the ones this reader can prove.
            const ocmd = out.context.lookup(rawOc);
            const members = ocmd instanceof PDFDict ? ocmd.get(PDFName.of('OCGs')) : undefined;
            const resolved = members instanceof PDFRef ? out.context.lookup(members) : members;
            if (members instanceof PDFRef && resolved instanceof PDFDict) {
                groupRef = members;
            } else if (resolved instanceof PDFArray && resolved.size() === 1) {
                const only = resolved.get(0);
                if (only instanceof PDFRef) groupRef = only;
            }
            if (!groupRef) return unresolvedUsage(use, '/OC names a membership dictionary this output cannot reduce');
            form.set(PDFName.of('OC'), groupRef);
        } else {
            groupRef = rawOc;
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
