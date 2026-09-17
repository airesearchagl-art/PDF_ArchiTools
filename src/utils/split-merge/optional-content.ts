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
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { MECHANISM_BOUNDS } from './policy';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

const textOf = (v: unknown): string | null => {
    const decode = (v as { decodeText?: () => string } | null)?.decodeText;
    return typeof decode === 'function' ? decode.call(v) : null;
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
export const HANDLED_D_KEYS = ['Order', 'ON', 'OFF', 'Name', 'BaseState'];

/** The only `/BaseState` this reader reproduces. Others are refused. */
export const SUPPORTED_BASE_STATE = '/ON';

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

export interface OptionalContentDescription {
    present: boolean;
    groups: { ref: PDFRef; name: string | null }[];
    on: (string | null)[];
    off: (string | null)[];
    dName: string | null;
    baseState: string | null;
    orderPresent: boolean;
    orderShape: unknown;
    configs: number;
    pageProperties: PagePropertyEntry[];
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
    const label = textOf(value);
    if (label !== null) {
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
function walkPageResourceGraph(
    doc: PDFDocument,
    sourceIndex: number,
    pageNode: PDFDict,
    unsupported: string[],
): void {
    const visited = new Set<string>();
    const refuse = (text: string): void => {
        unsupported.push(text);
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

    const walkResources = (raw: unknown, where: string, depth: number): void => {
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
                walkStream(entry, `${where} /XObject ${key.asString()}`, depth, true);
            }
        }

        const patterns = subDict(resources, 'Pattern', where);
        if (patterns) {
            for (const [key, entry] of patterns.entries()) {
                // A shading pattern is a plain dictionary with no content
                // stream; a tiling pattern is a stream with resources. Neither
                // is an `/OC` attachment point — a pattern is a scope.
                walkStream(entry, `${where} /Pattern ${key.asString()}`, depth, false);
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

    function walkStream(raw: unknown, where: string, depth: number, ocApplies: boolean): void {
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
        if (ocApplies && dict.get(PDFName.of('OC')) !== undefined) refuse(`${where} /OC`);
        walkResources(dict.get(PDFName.of('Resources')), where, depth + 1);
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
        walkResources(font.get(PDFName.of('Resources')), where, depth + 1);
        const procs = subDict(font, 'CharProcs', where);
        if (procs) {
            for (const [glyph, entry] of procs.entries()) {
                walkStream(entry, `${where} /CharProcs ${glyph.asString()}`, depth + 1, false);
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
        walkStream(rawGroup, groupWhere, depth, true);
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
                    walkStream(stream, `${apWhere} ${state.asString()}`, 0, true);
                }
            } else {
                walkStream(entry, apWhere, 0, true);
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

    walkResources(pageNode.get(PDFName.of('Resources')), `page ${sourceIndex}`, 0);
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
        baseState: null,
        orderPresent: false,
        orderShape: null,
        configs: 0,
        pageProperties: [],
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
    for (const sourceIndex of wanted) {
        const page = pages[sourceIndex];
        if (!page) continue;
        walkPageResourceGraph(doc, sourceIndex, page.node, out.unsupported);
    }

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
        return g instanceof PDFDict ? textOf(look(doc, g.get(PDFName.of('Name')))) : null;
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
        out.dName = textOf(look(doc, d.get(PDFName.of('Name'))));
        const base = d.get(PDFName.of('BaseState'));
        if (base !== undefined) {
            out.baseState = nameOf(base);
            if (out.baseState !== SUPPORTED_BASE_STATE) {
                out.unsupported.push(`/D /BaseState ${out.baseState}`);
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
        const resources = look(doc, page.node.get(PDFName.of('Resources')));
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
                name: textOf(look(doc, value.get(PDFName.of('Name')))),
            });
        }
    });

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
        const label = textOf(value);
        if (label !== null) {
            if (!labelAllowed) {
                throw new Error('/D /Order holds a text label in a position this reader cannot reproduce');
            }
            return PDFString.of(label);
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
    if (description.dName !== null) d.Name = PDFString.of(description.dName);
    if (description.baseState === SUPPORTED_BASE_STATE) d.BaseState = PDFName.of('ON');

    out.catalog.set(
        PDFName.of('OCProperties'),
        out.context.obj({ OCGs: ordered, D: d } as never),
    );

    return {
        status: 'CARRIED',
        carried: ordered.length,
        on: on.length,
        off: off.length,
        mapped: sourceRefToOutputRef.size,
    };
}
