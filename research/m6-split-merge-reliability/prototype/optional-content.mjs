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
 * carry. Found on the **kept pages only**, because a group on a page nobody
 * asked for is not this extract's problem.
 */
function detectUnhandledAttachments(doc, selection, unsupported) {
    const pages = doc.getPages();
    const wanted = selection === null ? pages.map((_, i) => i) : selection;

    for (const sourceIndex of wanted) {
        const page = pages[sourceIndex];
        if (!page) continue;

        // A2 — an annotation that belongs to an optional-content group.
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots instanceof PDFArray) {
            for (let i = 0; i < annots.size(); i += 1) {
                const annot = look(doc, annots.get(i));
                if (annot instanceof PDFDict && annot.get(PDFName.of('OC')) !== undefined) {
                    unsupported.push(`page ${sourceIndex} annotation /OC`);
                }
            }
        }

        // A3 — a form or image XObject that belongs to a group.
        const resources = page.node.lookup(PDFName.of('Resources'));
        const xobjects = resources instanceof PDFDict
            ? resources.lookup(PDFName.of('XObject'))
            : undefined;
        if (xobjects instanceof PDFDict) {
            for (const [key, raw] of xobjects.entries()) {
                const xobject = look(doc, raw);
                const dict = xobject instanceof PDFDict ? xobject : xobject?.dict;
                if (dict instanceof PDFDict && dict.get(PDFName.of('OC')) !== undefined) {
                    unsupported.push(`page ${sourceIndex} XObject ${key.asString()} /OC`);
                }
            }
        }
    }
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

    // A4 — /OCGs must be an array of groups, or the structure is unreadable.
    const groups = oc.lookup(PDFName.of('OCGs'));
    if (oc.get(PDFName.of('OCGs')) !== undefined && !(groups instanceof PDFArray)) {
        out.unsupported.push('/OCProperties /OCGs is not an array');
    }
    for (const ref of refsOf(groups)) {
        out.groups.push({ ref, name: nameOfGroup(ref) });
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

    const d = oc.lookup(PDFName.of('D'));
    if (oc.get(PDFName.of('D')) !== undefined && !(d instanceof PDFDict)) {
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
