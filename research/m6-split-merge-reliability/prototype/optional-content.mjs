/**
 * Optional content, carried where it is understood and refused where it is not.
 *
 * Not production code. The measured problem: `copyPages` drops `/OCProperties`
 * while the copied page keeps the `/Resources /Properties` entry naming the
 * group, so the artifact's marked content references a configuration the
 * document no longer has and a viewer shows its own default instead of the
 * author's. That is a visibility change, not a harmless omission.
 *
 * **The mapping is structural, and that is a correction.** An earlier version
 * paired source groups to output groups by position, with the source cursor
 * reset on every output page — so with one kept page it worked and with two it
 * silently mismatched ON against OFF. Groups are now matched through the thing
 * that actually identifies them across the copy:
 *
 *     selected source page + /Properties key + source OCG ref
 *         ->  output page   + same key       + output OCG ref
 *
 * The envelope is deliberately narrow, and the narrowness is the contract:
 *
 *   carried   page /Properties entries resolving to plain /OCG dictionaries,
 *             with a /D whose keys are handled *and reproduced*
 *   refused   /OCMD in any form, a /VE visibility expression, a /D key outside
 *             the handled set, or a /BaseState this reader does not reproduce
 *
 * Refusing `/OCMD` is not a gap to be apologised for. An `/OCMD` decides
 * visibility from a set of groups and optionally from a nested boolean
 * expression; carrying a subset of that evaluation silently changes what the
 * reader sees.
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
 * What a document's optional content is, in terms that survive a copy.
 *
 * Refs differ between documents, so everything a comparison needs is also
 * reported by **name**: the group's own `/Name`, and which names are on and
 * off. `pageProperties` keeps the `(page, key)` pairs that make the mapping
 * structural rather than positional.
 */
export function describeOptionalContent(doc, selection = null) {
    const out = {
        present: false,
        groups: [],
        on: [],
        off: [],
        dName: null,
        baseState: null,
        pageProperties: [],
        unsupported: [],
    };
    const oc = doc.catalog.lookup(PDFName.of('OCProperties'));
    if (!(oc instanceof PDFDict)) return out;
    out.present = true;

    const nameOfGroup = (ref) => {
        const g = look(doc, ref);
        return g instanceof PDFDict ? textOf(look(doc, g.get(PDFName.of('Name')))) : null;
    };

    for (const ref of refsOf(oc.lookup(PDFName.of('OCGs')))) {
        out.groups.push({ ref, name: nameOfGroup(ref) });
    }

    const d = oc.lookup(PDFName.of('D'));
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
    //
    // For every (output page, /Properties key) the source also had, take the
    // output's own reference. Positions are never used: a page whose keys were
    // written in a different order, or a group used on two pages, resolves
    // through the key it is actually stored under.
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

    // Deduplicated, in the order the source's /D /Order named them where it
    // named them at all, then anything else the kept pages reference.
    const ordered = [];
    const pushOnce = (ref) => {
        if (!ref) return;
        if (ordered.some((r) => r.tag === ref.tag)) return;
        ordered.push(ref);
    };
    const sourceOc = doc.catalog.lookup(PDFName.of('OCProperties'));
    const sourceD = sourceOc instanceof PDFDict ? sourceOc.lookup(PDFName.of('D')) : null;
    if (sourceD instanceof PDFDict) {
        for (const ref of refsOf(sourceD.lookup(PDFName.of('Order')))) {
            pushOnce(sourceRefToOutputRef.get(ref.tag));
        }
    }
    for (const ref of outputRefByTag.values()) pushOnce(ref);

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
        const d = { Order: ordered };
        if (on.length > 0) d.ON = on;
        if (off.length > 0) d.OFF = off;
        // The /D semantics, reproduced rather than merely tolerated.
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
        pageProperties: {
            source: keyed(a.pageProperties), output: keyed(b.pageProperties),
            equal: JSON.stringify(keyed(a.pageProperties)) === JSON.stringify(keyed(b.pageProperties)),
        },
    };
}
