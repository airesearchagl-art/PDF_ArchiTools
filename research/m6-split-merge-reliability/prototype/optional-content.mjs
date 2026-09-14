/**
 * Optional content, carried where it is understood and refused where it is not.
 *
 * Not production code. The measured problem: `copyPages` drops `/OCProperties`
 * while the copied page keeps the `/Resources /Properties` entry naming the
 * group, so the artifact's marked content references a configuration the
 * document no longer has and a viewer shows its own default instead of the
 * author's. That is a visibility change, not a harmless omission.
 *
 * **The mapping is structural.** Groups are matched through the thing that
 * actually identifies them across a copy:
 *
 *     selected source page + /Properties key + source OCG ref
 *         ->  output page   + same key       + output OCG ref
 *
 * An earlier version paired them by position with the source cursor reset on
 * every output page, so one kept page worked and two could swap ON for OFF.
 *
 * **The envelope is a detector, not a hope.** A contract that says "anything
 * outside the handled shapes is refused" is only true if the unhandled shapes
 * can be found. Optional content can attach itself in more places than a
 * catalog `/OCProperties` and a page's `/Properties`:
 *
 *   /OCProperties /Configs   alternate configurations this reader cannot rebuild
 *   annotation /OC           an annotation that belongs to a group
 *   XObject /OC              a form or image that belongs to a group
 *   unreadable /OCProperties a structure that cannot be walked at all
 *
 * None of those is carried, and none of them was previously *seen* — which is
 * the difference between a narrow envelope and an envelope with holes in it.
 * The point of this round is not to widen support. It is to make the refusals
 * real.
 *
 * **A page's resources are a graph, not a dictionary.** The scan above once
 * stopped at the page's own `/Resources`, so a form XObject that names a group
 * from *its* resources, an appearance stream that does, or a form two levels
 * down carrying `/OC` were all invisible — and invisible read as "none". The
 * walker below follows every resource scope a content stream can open, with a
 * visited set and a depth bound, and treats a reference it cannot resolve as a
 * refusal rather than as absence. Only the page's own `/Properties` is rebuilt;
 * one found in any deeper scope is refused.
 *
 * A soft mask was the scope that paragraph once left out. `/ExtGState` holds no
 * content stream itself, but a soft mask's `/G` is a transparency group form
 * with resources of its own, and a document with a group behind one extracted
 * READY. That path is walked now (B1), under the same visited set and depth
 * bound as every other form.
 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFString } from 'pdf-lib';

const nameOf = (v) => (typeof v?.asString === 'function' ? v.asString() : String(v ?? ''));
const textOf = (v) => (typeof v?.decodeText === 'function' ? v.decodeText() : null);
const look = (doc, v) => {
    try {
        return doc.context.lookup(v) ?? v;
    } catch {
        return undefined;
    }
};

/**
 * Resolve a value, keeping "not there" apart from "not a reference".
 *
 * `look` above answers `undefined` only when a lookup *throws*. A reference to
 * an object that was never written resolves to nothing, and `look` hands back
 * the reference itself — which reads like a value, and is how a dangling entry
 * would otherwise pass as present-and-fine.
 */
function resolve(doc, raw) {
    if (!(raw instanceof PDFRef)) return { ok: true, value: raw };
    let value;
    try {
        value = doc.context.lookup(raw);
    } catch (error) {
        return { ok: false, reason: `could not be read: ${String(error?.message ?? error)}` };
    }
    if (value === undefined) return { ok: false, reason: `points at ${raw.tag}, which is not in the document` };
    return { ok: true, value };
}

/** The dictionary of a dictionary or of a stream, or `null`. */
const dictOf = (value) => {
    if (value instanceof PDFDict) return value;
    return value?.dict instanceof PDFDict ? value.dict : null;
};

/** How deep the resource graph is followed before it is refused. */
export const MAX_RESOURCE_DEPTH = 24;

/**
 * Resource keys the walker opens, because each can reach a content stream with
 * a `/Resources` of its own — and so a `/Properties` of its own. `/ExtGState`
 * is opened only as far as a soft mask's `/G`, the one entry of a graphics
 * state that holds such a stream.
 */
export const RESOURCE_KEYS_WALKED = ['Properties', 'XObject', 'Pattern', 'Font', 'ExtGState'];

/**
 * Resource keys the walker does **not** open.
 *
 * This is a statement about scope, not about safety. `/ColorSpace` and
 * `/Shading` hold no content stream, so they open no resource scope and carry
 * no `/OC`. `/ExtGState` used to be listed here as well, and a group behind a
 * soft mask extracted READY because of it; it moved to the walked keys to close
 * B1.
 */
export const RESOURCE_KEYS_NOT_WALKED = ['Shading', 'ColorSpace'];

/** The `/D` keys this reader both accepts **and reproduces**. */
export const HANDLED_D_KEYS = ['Order', 'ON', 'OFF', 'Name', 'BaseState'];

/** The only `/BaseState` this reader reproduces. Others are refused. */
export const SUPPORTED_BASE_STATE = '/ON';

/** How deep a nested `/Order` will be followed before it is unreadable. */
export const MAX_ORDER_DEPTH = 32;

const refsOf = (arr) => {
    const out = [];
    if (!(arr instanceof PDFArray)) return out;
    for (let i = 0; i < arr.size(); i += 1) {
        const r = arr.get(i);
        if (r instanceof PDFRef) out.push(r);
    }
    return out;
};

/**
 * `/Order` as a comparable shape, with the label rule applied.
 *
 * A text label titles a section of the layer panel, and the only position this
 * research has shown it can be reproduced in is **the first element of a nested
 * array**. A string at the top level, or part-way through a nested array, means
 * something this prototype has not established, so it is recorded as
 * unsupported rather than carried on the strength of being a string.
 *
 * `labelAllowed` is true only for index 0 of a nested array — never for the
 * outermost array, whose first element is not a section title.
 */
function orderShapeOf(doc, node, nameOfGroup, depth, unsupported, labelAllowed = false) {
    if (depth > MAX_ORDER_DEPTH) {
        unsupported.push(`/D /Order nested deeper than ${MAX_ORDER_DEPTH}`);
        return '(too deep)';
    }
    const value = look(doc, node);
    if (value instanceof PDFArray) {
        const shape = [];
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
 * Every place optional content can attach itself that this reader does not
 * carry, found by walking the resource graph a kept page reaches.
 *
 * Found on the **kept pages only**, because a group on a page nobody asked for
 * is not this extract's problem. From each page the walker follows:
 *
 *   page /Annots             each annotation's /OC, and its /AP streams
 *   /XObject                 each form or image's /OC, and a form's /Resources
 *   /Pattern                 a tiling pattern's /Resources
 *   /Font                    a Type 3 font's /Resources, and any on /CharProcs
 *   /ExtGState               a soft mask's /G, a form with /Resources of its own
 *   /Properties              below the page's own scope, every entry
 *
 * A visited set keyed on indirect references makes a cycle terminate and a
 * shared object count once. A reference that cannot be resolved, a structure of
 * the wrong type and a graph deeper than {@link MAX_RESOURCE_DEPTH} are each a
 * refusal: giving up on a walk never turns into "no optional content".
 */
function detectUnhandledAttachments(doc, selection, unsupported) {
    const pages = doc.getPages();
    const wanted = selection === null ? pages.map((_, i) => i) : selection;

    for (const sourceIndex of wanted) {
        const page = pages[sourceIndex];
        if (!page) continue;
        walkPageResourceGraph(doc, sourceIndex, page, unsupported);
    }
}

function walkPageResourceGraph(doc, sourceIndex, page, unsupported) {
    const visited = new Set();
    const refuse = (text) => unsupported.push(text);

    /** True the first time a reference is reached; direct objects cannot cycle. */
    const firstVisit = (raw) => {
        if (!(raw instanceof PDFRef)) return true;
        if (visited.has(raw.tag)) return false;
        visited.add(raw.tag);
        return true;
    };

    /** A named dictionary under `holder`, resolved; `null` when absent. */
    const subDict = (holder, key, where) => {
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
     * One resource dictionary, and every scope that hangs off it. `depth` 0 is
     * the page's own, whose `/Properties` the carry path reads and rebuilds.
     */
    const walkResources = (raw, where, depth) => {
        if (raw === undefined) return;
        if (depth > MAX_RESOURCE_DEPTH) {
            refuse(`${where} /Resources nested deeper than ${MAX_RESOURCE_DEPTH}`);
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
                // stream; a tiling pattern is a stream with resources.
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

    /**
     * `/Properties` below the page's own resources. Nothing here is rebuilt, so
     * every entry is refused — named, so the refusal says what it found. The
     * same rule the page scope applies to a non-group entry applies here.
     */
    const walkNestedProperties = (resources, where) => {
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
            const what = type === '/OCG' ? 'an optional-content group'
                : type === '/OCMD' ? 'an optional-content membership dictionary'
                    : dict ? `a ${type || 'untyped'} dictionary` : 'a value that is not a dictionary';
            refuse(`${where} /Properties ${key.asString()} names ${what} below the page's own resources`);
        }
    };

    /**
     * An XObject, pattern or appearance stream: its own `/OC` where that is an
     * attachment point, then its own resource scope.
     */
    const walkStream = (raw, where, depth, ocApplies) => {
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
    };

    /**
     * A Type 3 font draws its glyphs with content streams, and those streams
     * take their resources from the font. Other font types hold no content
     * stream and are passed over.
     */
    const walkType3 = (raw, where, depth) => {
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
    };

    /**
     * A graphics state's soft mask. No `/SMask` and `/SMask /None` both mean no
     * mask. A mask dictionary paints with its `/G`, a transparency group form,
     * so `/G` is walked like any other form — through `walkStream`, sharing the
     * visited set and the depth bound rather than keeping a recursion of its
     * own. Anything that cannot be read as one of those shapes is refused: an
     * unreadable mask is not an absent one.
     */
    const walkSoftMask = (raw, where, depth) => {
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
        if (!(group.value?.dict instanceof PDFDict)) {
            refuse(`${groupWhere} is not a form XObject stream`);
            return;
        }
        const subtype = nameOf(group.value.dict.get(PDFName.of('Subtype')));
        if (subtype && subtype !== '/Form') {
            refuse(`${groupWhere} is ${subtype}, not a form XObject`);
            return;
        }
        walkStream(rawGroup, groupWhere, depth, true);
    };

    /** `/AP` holds a stream per state, or a dictionary of streams per state. */
    const walkAppearance = (annot, where) => {
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

    // A2 — an annotation that belongs to a group, and what its appearance holds.
    const rawAnnots = page.node.get(PDFName.of('Annots'));
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

    // A3 and below — the page's resources, and every scope beneath them.
    walkResources(page.node.get(PDFName.of('Resources')), `page ${sourceIndex}`, 0);
}

/**
 * What a document's optional content is, in terms that survive a copy.
 *
 * Refs differ between documents, so everything a comparison needs is also
 * reported by **name**. `pageProperties` keeps the `(page, key)` pairs that
 * make the mapping structural rather than positional.
 */
export function describeOptionalContent(doc, selection = null) {
    const out = {
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

    let oc;
    try {
        oc = doc.catalog.lookup(PDFName.of('OCProperties'));
    } catch (error) {
        // A4 — a structure that cannot even be looked up is not "absent".
        out.present = true;
        out.unsupported.push(`/OCProperties could not be read: ${String(error?.message ?? error)}`);
        return out;
    }

    // Attachments are detected whether or not the catalog declares optional
    // content: an annotation or XObject carrying /OC in a document with no
    // /OCProperties is itself a structure this reader does not understand.
    detectUnhandledAttachments(doc, selection, out.unsupported);

    if (!(oc instanceof PDFDict)) {
        if (doc.catalog.get(PDFName.of('OCProperties')) !== undefined) {
            out.present = true;
            out.unsupported.push('/OCProperties is not a dictionary');
        }
        if (out.unsupported.length > 0) out.present = true;
        return out;
    }
    out.present = true;

    const nameOfGroup = (ref) => {
        const g = look(doc, ref);
        return g instanceof PDFDict ? textOf(look(doc, g.get(PDFName.of('Name')))) : null;
    };

    // A4 — /OCGs and /D are both required. Refusing only a key of the wrong
    // *type* would read a missing one as an empty default, which is the same
    // "unreadable means absent" inference this reader exists to forbid.
    const rawGroups = oc.get(PDFName.of('OCGs'));
    const groupsRead = rawGroups === undefined ? null : resolve(doc, rawGroups);
    if (rawGroups === undefined) {
        out.unsupported.push('/OCProperties has no /OCGs, which the specification requires');
    } else if (!groupsRead.ok) {
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

    // A1 — alternate configurations. This reader rebuilds one default
    // configuration; it has never been shown to rebuild a second.
    const configs = oc.lookup(PDFName.of('Configs'));
    if (oc.get(PDFName.of('Configs')) !== undefined) {
        out.configs = configs instanceof PDFArray ? configs.size() : -1;
        out.unsupported.push(
            configs instanceof PDFArray
                ? `/OCProperties /Configs with ${configs.size()} alternate configuration(s)`
                : '/OCProperties /Configs is not an array',
        );
    }

    const rawD = oc.get(PDFName.of('D'));
    const dRead = rawD === undefined ? null : resolve(doc, rawD);
    const d = dRead?.ok ? dRead.value : undefined;
    if (rawD === undefined) {
        out.unsupported.push('/OCProperties has no /D, which the specification requires');
    } else if (!dRead.ok) {
        out.unsupported.push(`/OCProperties /D ${dRead.reason}`);
    } else if (!(d instanceof PDFDict)) {
        out.unsupported.push('/OCProperties /D is not a dictionary');
    }
    if (d instanceof PDFDict) {
        for (const [key] of d.entries()) {
            const k = key.asString().replace(/^\//, '');
            if (!HANDLED_D_KEYS.includes(k)) out.unsupported.push(`/D /${k}`);
        }
        out.on = refsOf(d.lookup(PDFName.of('ON'))).map(nameOfGroup);
        out.off = refsOf(d.lookup(PDFName.of('OFF'))).map(nameOfGroup);
        out.dName = textOf(look(doc, d.get(PDFName.of('Name'))));
        const base = d.get(PDFName.of('BaseState'));
        if (base !== undefined) {
            out.baseState = nameOf(base);
            if (out.baseState !== SUPPORTED_BASE_STATE) {
                out.unsupported.push(`/D /BaseState ${out.baseState}`);
            }
        }

        // `/Order` nests, titles sections with labels, may be empty and may be
        // absent — each a different statement about how the layer panel is
        // drawn. It is read as a shape, and the label rule is applied here.
        out.orderPresent = d.get(PDFName.of('Order')) !== undefined;
        if (out.orderPresent) {
            const order = d.lookup(PDFName.of('Order'));
            if (!(order instanceof PDFArray)) {
                out.unsupported.push('/D /Order is not an array');
            } else {
                out.orderShape = orderShapeOf(doc, order, nameOfGroup, 0, out.unsupported, false);
            }
        }
    }

    const pages = doc.getPages();
    const wanted = selection === null ? pages.map((_, i) => i) : selection;
    wanted.forEach((sourceIndex, position) => {
        const page = pages[sourceIndex];
        if (!page) return;
        const resources = page.node.lookup(PDFName.of('Resources'));
        const properties = resources instanceof PDFDict
            ? resources.lookup(PDFName.of('Properties'))
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

/** Kept for the gate's older call sites. */
export const readOptionalContent = describeOptionalContent;

/** Carry, refuse, or nothing to do. */
export function planOptionalContent(oc) {
    if (!oc.present) return { status: 'NONE' };
    if (oc.unsupported.length > 0) {
        return {
            status: 'REFUSE',
            code: 'UNSUPPORTED_OPTIONAL_CONTENT',
            reason: `この文書のオプショナルコンテンツは対応範囲外です: ${oc.unsupported.join(', ')}`,
            unsupported: oc.unsupported,
        };
    }
    return { status: 'CARRY', groups: oc.pageProperties.length };
}

/**
 * Extract, carrying the optional-content configuration the kept pages need.
 *
 * The groups themselves travel with the pages — they are reachable through
 * `/Resources /Properties` — so what has to be rebuilt is the catalog entry
 * saying which of them are on, and it is rebuilt from the output's own
 * references, reached through the same `(page, key)` pairs the source used.
 */
export async function extractWithOptionalContent(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const source = describeOptionalContent(doc, selection);
    const plan = planOptionalContent(source);
    if (plan.status === 'REFUSE') return { ...plan, status: 'REFUSED' };

    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));

    if (plan.status === 'NONE') {
        return { status: 'READY', bytes: await out.save({ useObjectStreams: false }), carried: 0 };
    }

    // ---- the structural mapping --------------------------------------------
    const outPages = out.getPages();
    const sourceRefToOutputRef = new Map();
    const outputRefByTag = new Map();

    for (const entry of source.pageProperties) {
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

    const ordered = [];
    const pushOnce = (ref) => {
        if (!ref) return;
        if (ordered.some((r) => r.tag === ref.tag)) return;
        ordered.push(ref);
    };
    const sourceOc = doc.catalog.lookup(PDFName.of('OCProperties'));
    const sourceD = sourceOc instanceof PDFDict ? sourceOc.lookup(PDFName.of('D')) : null;
    if (sourceOc instanceof PDFDict) {
        for (const ref of refsOf(sourceOc.lookup(PDFName.of('OCGs')))) {
            pushOnce(sourceRefToOutputRef.get(ref.tag));
        }
    }
    for (const ref of outputRefByTag.values()) pushOnce(ref);

    /**
     * `/Order`, mapped recursively rather than flattened, with the same label
     * rule the reader applied: a label is reproducible only where it opens a
     * nested array, and a reference to a group no kept page uses is a refusal
     * rather than a silent omission.
     */
    const mapOrder = (node, depth, labelAllowed) => {
        if (depth > MAX_ORDER_DEPTH) throw new Error('/D /Order nested too deep to reproduce');
        const value = look(doc, node);
        if (value instanceof PDFArray) {
            const mapped = [];
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
            if (!labelAllowed) throw new Error('/D /Order holds a text label in a position this reader cannot reproduce');
            return PDFString.of(label);
        }
        throw new Error('/D /Order holds an entry that cannot be reproduced');
    };

    const mapAll = (refs) => {
        const mapped = [];
        for (const ref of refs) {
            const target = sourceRefToOutputRef.get(ref.tag);
            if (target && !mapped.some((r) => r.tag === target.tag)) mapped.push(target);
        }
        return mapped;
    };
    const on = sourceD instanceof PDFDict ? mapAll(refsOf(sourceD.lookup(PDFName.of('ON')))) : [];
    const off = sourceD instanceof PDFDict ? mapAll(refsOf(sourceD.lookup(PDFName.of('OFF')))) : [];

    if (ordered.length > 0) {
        const d = {};
        // Absent stays absent and empty stays empty. Fabricating an /Order for
        // a document that had none, or filling in one that was deliberately
        // empty, is a change to what a viewer shows.
        if (source.orderPresent && sourceD instanceof PDFDict) {
            try {
                d.Order = mapOrder(sourceD.get(PDFName.of('Order')), 0, false);
            } catch (error) {
                return {
                    status: 'REFUSED',
                    code: 'UNSUPPORTED_OPTIONAL_CONTENT',
                    reason: `オプショナルコンテンツの表示順を再現できません: ${String(error?.message ?? error)}`,
                    unsupported: [String(error?.message ?? error)],
                };
            }
        }
        if (on.length > 0) d.ON = on;
        if (off.length > 0) d.OFF = off;
        if (source.dName !== null && source.dName !== undefined) d.Name = PDFString.of(source.dName);
        if (source.baseState === SUPPORTED_BASE_STATE) d.BaseState = PDFName.of('ON');
        out.catalog.set(PDFName.of('OCProperties'), out.context.obj({ OCGs: ordered, D: d }));
    }

    const bytes = await out.save({ useObjectStreams: false });
    return {
        status: 'READY',
        bytes,
        carried: ordered.length,
        on: on.length,
        off: off.length,
        mapped: sourceRefToOutputRef.size,
    };
}

/**
 * Compare a source's optional content, restricted to the kept pages, with what
 * an artifact actually holds — by name, because references do not survive a
 * copy and a comparison that used them would always agree with itself.
 */
export async function compareOptionalContent(sourceBytes, selection, outputBytes) {
    const src = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const outDoc = await PDFDocument.load(outputBytes, { updateMetadata: false });
    const a = describeOptionalContent(src, selection);
    const b = describeOptionalContent(outDoc, null);

    const names = (list) => list.map((g) => g.name).filter((n) => n !== null).sort();
    const keyed = (list) => list
        .map((p) => `${p.pageIndex}${p.key}=${p.name}`)
        .sort();

    return {
        groupCount: { source: a.groups.length, output: b.groups.length, equal: a.groups.length === b.groups.length },
        groupNames: {
            source: names(a.groups), output: names(b.groups),
            equal: JSON.stringify(names(a.groups)) === JSON.stringify(names(b.groups)),
        },
        on: {
            source: [...a.on].sort(), output: [...b.on].sort(),
            equal: JSON.stringify([...a.on].sort()) === JSON.stringify([...b.on].sort()),
        },
        off: {
            source: [...a.off].sort(), output: [...b.off].sort(),
            equal: JSON.stringify([...a.off].sort()) === JSON.stringify([...b.off].sort()),
        },
        dName: { source: a.dName, output: b.dName, equal: a.dName === b.dName },
        baseState: { source: a.baseState, output: b.baseState, equal: a.baseState === b.baseState },
        // Structure, not the set of groups: a flattened order and a nested one
        // hold the same groups and are not the same document.
        order: {
            source: a.orderShape, output: b.orderShape,
            sourcePresent: a.orderPresent, outputPresent: b.orderPresent,
            equal: a.orderPresent === b.orderPresent
                && JSON.stringify(a.orderShape) === JSON.stringify(b.orderShape),
        },
        pageProperties: {
            source: keyed(a.pageProperties), output: keyed(b.pageProperties),
            equal: JSON.stringify(keyed(a.pageProperties)) === JSON.stringify(keyed(b.pageProperties)),
        },
    };
}
