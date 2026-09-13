/**
 * Optional content, carried where it is understood and refused where it is not.
 *
 * Not production code. The measured problem: `copyPages` drops `/OCProperties`
 * while the copied page keeps the `/Resources /Properties` entry naming the
 * group, so the artifact's marked content references a configuration the
 * document no longer has and a viewer shows its own default instead of the
 * author's. That is a visibility change, not a harmless omission.
 *
 * The envelope is deliberately narrow, and the narrowness is the contract:
 *
 *   carried   a page whose /Properties entries resolve to plain /OCG
 *             dictionaries, with a /D configuration this reader understands
 *   refused   /OCMD in any form, a /VE visibility expression, or a /D carrying
 *             any key outside the handled set
 *
 * Refusing `/OCMD` is not a gap to be apologised for. An `/OCMD` decides
 * visibility from a set of groups and optionally from a nested boolean
 * expression; carrying one correctly means carrying that evaluation, and a
 * subset of it silently changes what the reader sees.
 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from 'pdf-lib';

const nameOf = (v) => (typeof v?.asString === 'function' ? v.asString() : String(v ?? ''));
const look = (doc, v) => {
    try {
        return doc.context.lookup(v) ?? v;
    } catch {
        return undefined;
    }
};

/** The `/D` keys this reader knows how to reproduce. Anything else refuses. */
export const HANDLED_D_KEYS = ['Order', 'ON', 'OFF', 'Name', 'BaseState'];

/**
 * What a document's optional content is, and which of it the kept pages use.
 */
export function readOptionalContent(doc, selection) {
    const out = {
        present: false,
        ocgRefs: [],
        usedByKeptPages: [],
        unsupported: [],
    };
    const oc = doc.catalog.lookup(PDFName.of('OCProperties'));
    if (!(oc instanceof PDFDict)) return out;
    out.present = true;

    const groups = oc.lookup(PDFName.of('OCGs'));
    if (groups instanceof PDFArray) {
        for (let i = 0; i < groups.size(); i += 1) {
            const raw = groups.get(i);
            if (raw instanceof PDFRef) out.ocgRefs.push(raw);
        }
    }

    const d = oc.lookup(PDFName.of('D'));
    if (d instanceof PDFDict) {
        for (const [key] of d.entries()) {
            const k = key.asString().replace(/^\//, '');
            if (!HANDLED_D_KEYS.includes(k)) out.unsupported.push(`/D /${k}`);
        }
        if (nameOf(d.get(PDFName.of('BaseState'))) === '/OFF') {
            out.unsupported.push('/D /BaseState /OFF');
        }
    }

    const pages = doc.getPages();
    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;
        const resources = page.node.lookup(PDFName.of('Resources'));
        const properties = resources instanceof PDFDict
            ? resources.lookup(PDFName.of('Properties'))
            : undefined;
        if (!(properties instanceof PDFDict)) continue;
        for (const [key, raw] of properties.entries()) {
            const value = look(doc, raw);
            if (!(value instanceof PDFDict)) {
                out.unsupported.push(`page ${index} /Properties ${key.asString()} is not a dictionary`);
                continue;
            }
            const type = nameOf(value.get(PDFName.of('Type')));
            if (type === '/OCMD') {
                out.unsupported.push(
                    value.get(PDFName.of('VE')) !== undefined
                        ? `page ${index} /OCMD with a /VE visibility expression`
                        : `page ${index} /OCMD`,
                );
                continue;
            }
            if (type !== '/OCG') {
                out.unsupported.push(`page ${index} /Properties ${key.asString()} is ${type || 'untyped'}`);
                continue;
            }
            out.usedByKeptPages.push({ pageIndex: index, key: key.asString(), ref: raw });
        }
    }
    return out;
}

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
    return { status: 'CARRY', groups: oc.usedByKeptPages.length };
}

/**
 * Extract, carrying the optional-content configuration the kept pages need.
 *
 * The groups are copied with the pages — they are reachable from
 * `/Resources /Properties` — so what has to be rebuilt is the catalog entry
 * that says which of them are on. It is rebuilt from the output's own
 * references rather than the source's, for the same reason destinations are.
 */
export async function extractWithOptionalContent(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const oc = readOptionalContent(doc, selection);
    const plan = planOptionalContent(oc);
    if (plan.status === 'REFUSE') return { ...plan, status: 'REFUSED' };

    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));

    if (plan.status === 'NONE') {
        return { status: 'READY', bytes: await out.save({ useObjectStreams: false }), carried: 0 };
    }

    // The groups as the *output* now holds them, found through the copied
    // pages' own resources.
    const sourceD = doc.catalog.lookup(PDFName.of('OCProperties'))?.lookup?.(PDFName.of('D'));
    const onTags = new Set();
    const offTags = new Set();
    if (sourceD instanceof PDFDict) {
        for (const [key, set] of [['ON', onTags], ['OFF', offTags]]) {
            const arr = sourceD.lookup(PDFName.of(key));
            if (arr instanceof PDFArray) {
                for (let i = 0; i < arr.size(); i += 1) {
                    const r = arr.get(i);
                    if (r instanceof PDFRef) set.add(r.tag);
                }
            }
        }
    }
    // Map source group refs to the copies by the order they appear on the page.
    const sourceOrder = oc.usedByKeptPages.map((u) => (u.ref instanceof PDFRef ? u.ref.tag : null));

    const carried = [];
    const on = [];
    const off = [];
    out.getPages().forEach((page) => {
        const resources = page.node.lookup(PDFName.of('Resources'));
        const properties = resources instanceof PDFDict
            ? resources.lookup(PDFName.of('Properties'))
            : undefined;
        if (!(properties instanceof PDFDict)) return;
        let seen = 0;
        for (const [, raw] of properties.entries()) {
            if (!(raw instanceof PDFRef)) continue;
            const value = out.context.lookup(raw);
            if (!(value instanceof PDFDict) || nameOf(value.get(PDFName.of('Type'))) !== '/OCG') continue;
            carried.push(raw);
            const sourceTag = sourceOrder[seen];
            seen += 1;
            if (sourceTag && offTags.has(sourceTag)) off.push(raw);
            else if (sourceTag && onTags.has(sourceTag)) on.push(raw);
        }
    });

    if (carried.length > 0) {
        const d = { Order: carried };
        if (on.length > 0) d.ON = on;
        if (off.length > 0) d.OFF = off;
        out.catalog.set(PDFName.of('OCProperties'), out.context.obj({ OCGs: carried, D: d }));
    }

    return {
        status: 'READY',
        bytes: await out.save({ useObjectStreams: false }),
        carried: carried.length,
        on: on.length,
        off: off.length,
    };
}
