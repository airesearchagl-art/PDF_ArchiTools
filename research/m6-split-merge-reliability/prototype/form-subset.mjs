/**
 * How much of an AcroForm can be carried, and where the honest answer is "no".
 *
 * Not production code. The review's instruction is the shape of this file: do
 * not recommend reconstruction, or rename-on-collision, from the mere fact that
 * the current build loses them. Either a prototype shows the contract is
 * implementable over a **stated** subset, or the MVP answer is a typed refusal.
 *
 * The subset is deliberately small, and everything outside it is detected and
 * refused rather than attempted. The detector is the deliverable as much as the
 * reconstruction is: "refuse where the document depends on X" is not
 * implementable until `depends on X` is a function.
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

/** Field types this prototype is willing to carry. */
export const SUPPORTED_FIELD_TYPES = ['/Tx', '/Btn', '/Ch', '/Sig'];

/**
 * Entries whose presence means the form does something this prototype cannot
 * reason about, so the document leaves the supported subset.
 *
 * `/AA` is an additional-actions dictionary, `/CO` a calculation order, and a
 * document-level `/Names /JavaScript` tree can reach fields by name from
 * anywhere. Renaming a field in any of those documents can silently break a
 * calculation that no structural check would notice, which is exactly why
 * rename-on-collision may not be recommended on the strength of "a collision
 * exists".
 */
export const DISQUALIFYING = ['AA', 'CO'];

/**
 * Read a form the way a contract would have to: terminal fields, their widgets,
 * which page each widget is on, and whether anything here is outside the subset.
 */
export function readForm(doc) {
    const pages = doc.getPages();
    const annotTagsByPage = pages.map((page) => {
        const annots = page.node.lookup(PDFName.of('Annots'));
        const tags = [];
        if (annots instanceof PDFArray) {
            for (let i = 0; i < annots.size(); i += 1) {
                const raw = annots.get(i);
                if (raw instanceof PDFRef) tags.push(raw.tag);
            }
        }
        return tags;
    });
    const pageOf = (ref) => {
        if (!(ref instanceof PDFRef)) return null;
        for (let i = 0; i < annotTagsByPage.length; i += 1) {
            if (annotTagsByPage[i].includes(ref.tag)) return i;
        }
        return null;
    };

    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    const out = {
        present: acro instanceof PDFDict,
        xfa: acro instanceof PDFDict && acro.get(PDFName.of('XFA')) !== undefined,
        needAppearances: acro instanceof PDFDict && acro.get(PDFName.of('NeedAppearances')) !== undefined,
        dr: acro instanceof PDFDict && acro.get(PDFName.of('DR')) !== undefined,
        da: acro instanceof PDFDict ? textOf(look(doc, acro.get(PDFName.of('DA')))) : null,
        fields: [],
        outsideSubset: [],
        readable: true,
    };
    if (!(acro instanceof PDFDict)) return out;

    for (const key of DISQUALIFYING) {
        if (acro.get(PDFName.of(key)) !== undefined) out.outsideSubset.push(`AcroForm /${key}`);
    }
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript')) !== undefined) {
        out.outsideSubset.push('document-level /JavaScript');
    }

    const walk = (entries, inheritedName, depth) => {
        if (depth > 32) {
            out.readable = false;
            return;
        }
        for (const raw of entries) {
            const ref = raw instanceof PDFRef ? raw : null;
            const field = look(doc, raw);
            if (!(field instanceof PDFDict)) {
                out.readable = false;
                continue;
            }
            const partial = textOf(look(doc, field.get(PDFName.of('T'))));
            const full = inheritedName && partial ? `${inheritedName}.${partial}` : (partial || inheritedName);

            for (const key of DISQUALIFYING) {
                if (field.get(PDFName.of(key)) !== undefined) out.outsideSubset.push(`${full} /${key}`);
            }

            const kidsRaw = field.get(PDFName.of('Kids'));
            const kids = kidsRaw === undefined ? null : look(doc, kidsRaw);
            const childFields = [];
            const widgets = [];
            if (kids instanceof PDFArray) {
                for (let i = 0; i < kids.size(); i += 1) {
                    const kidRaw = kids.get(i);
                    const kid = look(doc, kidRaw);
                    if (!(kid instanceof PDFDict)) continue;
                    const isField = ['T', 'FT', 'V', 'DV', 'Ff', 'Kids']
                        .some((k) => kid.get(PDFName.of(k)) !== undefined);
                    if (isField) childFields.push(kidRaw);
                    else widgets.push(kidRaw);
                }
            }
            if (childFields.length > 0) {
                walk(childFields, full, depth + 1);
                continue;
            }

            const widgetRefs = widgets.length > 0 ? widgets : (ref ? [ref] : []);
            const ft = nameOf(field.get(PDFName.of('FT')));
            if (ft && !SUPPORTED_FIELD_TYPES.includes(ft)) out.outsideSubset.push(`${full} ${ft}`);
            out.fields.push({
                ref,
                name: full,
                ft,
                merged: widgets.length === 0,
                value: textOf(look(doc, field.get(PDFName.of('V')))),
                signed: look(doc, field.get(PDFName.of('V'))) instanceof PDFDict,
                flags: look(doc, field.get(PDFName.of('Ff')))?.asNumber?.() ?? null,
                widgetRefs,
                widgetPages: widgetRefs.map((w) => pageOf(w)),
            });
        }
    };

    const fields = acro.lookup(PDFName.of('Fields'));
    if (fields instanceof PDFArray) {
        const entries = [];
        for (let i = 0; i < fields.size(); i += 1) entries.push(fields.get(i));
        walk(entries, '', 0);
    } else if (acro.get(PDFName.of('Fields')) !== undefined) {
        out.readable = false;
    }
    return out;
}

/**
 * Can this selection carry its form?
 *
 * Three answers, and the middle one is the reason this exists: a field whose
 * widgets sit on both kept and dropped pages cannot be reconstructed honestly —
 * half of it would render and the value would belong to neither half.
 */
export function planFormForExtract(form, selection) {
    const kept = new Set(selection);
    if (!form.present) return { status: 'NO_FORM' };
    if (!form.readable) return { status: 'REFUSE', code: 'UNSUPPORTED_DOCUMENT', reason: 'フォーム構造を読み取れません。' };
    if (form.xfa) return { status: 'REFUSE', code: 'XFA_UNSAFE', reason: 'XFAフォームは保持できません。' };
    if (form.outsideSubset.length > 0) {
        return {
            status: 'REFUSE',
            code: 'UNSUPPORTED_FORM',
            reason: `対応範囲外のフォーム要素があります: ${form.outsideSubset.join(', ')}`,
        };
    }

    const straddling = form.fields.filter((f) => {
        const pagesOfField = f.widgetPages.filter((p) => p !== null);
        const inside = pagesOfField.filter((p) => kept.has(p));
        return inside.length > 0 && inside.length < pagesOfField.length;
    });
    if (straddling.length > 0) {
        return {
            status: 'REFUSE',
            code: 'FIELD_SPANS_SELECTION',
            reason: `フィールド ${straddling.map((f) => f.name).join(', ')} は選択外のページにも部品を持つため、`
                + '分割すると入力値の意味が失われます。',
            straddling: straddling.map((f) => f.name),
        };
    }

    const carried = form.fields.filter((f) => f.widgetPages.some((p) => p !== null && kept.has(p)));
    const dropped = form.fields.filter((f) => !carried.includes(f));
    return { status: 'CARRY', carried: carried.map((f) => f.name), dropped: dropped.map((f) => f.name) };
}

/**
 * Rebuild the AcroForm on an extracted document.
 *
 * The widgets already travelled with their pages; what is missing is the tree
 * that gives them meaning. This walks the output's own annotations, finds the
 * ones that are widgets, and registers them as fields again with the values the
 * source held.
 */
export async function extractWithForm(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const form = readForm(doc);
    const plan = planFormForExtract(form, selection);
    // The spread goes first. Written the other way round, `plan.status`
    // ("REFUSE") silently overwrote the "REFUSED" being set here, and a
    // correctly refused document reported an unrecognised status — a refusal
    // that worked, failing its own check.
    if (plan.status === 'REFUSE') return { ...plan, status: 'REFUSED' };

    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));

    if (plan.status === 'NO_FORM') {
        return { status: 'READY', bytes: await out.save({ useObjectStreams: false }), plan };
    }

    // Every widget the output actually holds, in page order.
    const fieldRefs = [];
    const outPages = out.getPages();
    const wanted = new Map(form.fields.map((f) => [f.name, f]));
    let cursor = 0;
    for (const page of outPages) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const ref = annots.get(i);
            const annot = out.context.lookup(ref);
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/Widget') continue;

            // A merged field/widget already carries its own /T and /FT; a bare
            // widget needs the field rebuilt around it.
            const carriedNames = plan.carried;
            const source = wanted.get(annot.get(PDFName.of('T')) !== undefined
                ? textOf(look(out, annot.get(PDFName.of('T'))))
                : carriedNames[Math.min(cursor, carriedNames.length - 1)]);
            if (!source) continue;

            if (annot.get(PDFName.of('T')) === undefined) {
                annot.set(PDFName.of('T'), PDFString.of(source.name));
            }
            if (source.ft) annot.set(PDFName.of('FT'), PDFName.of(source.ft.replace(/^\//, '')));
            if (source.value !== null && source.value !== undefined) {
                annot.set(PDFName.of('V'), PDFString.of(source.value));
            }
            annot.delete(PDFName.of('Parent'));
            if (ref instanceof PDFRef) fieldRefs.push(ref);
            cursor += 1;
        }
    }

    if (fieldRefs.length > 0) {
        const acro = { Fields: fieldRefs, NeedAppearances: true };
        if (form.da) acro.DA = PDFString.of(form.da);
        out.catalog.set(PDFName.of('AcroForm'), out.context.register(out.context.obj(acro)));
    }
    return { status: 'READY', bytes: await out.save({ useObjectStreams: false }), plan, rebuiltFields: fieldRefs.length };
}

/**
 * Merge, with the collision question answered rather than assumed.
 *
 * Renaming is only offered when nothing in either document can reach a field by
 * name: no additional actions, no calculation order, no document JavaScript. If
 * anything can, the rename is not provably safe and the answer is a refusal —
 * which the review is right to insist on, because a silently broken calculation
 * is worse than a merge that did not happen.
 */
export async function mergeWithForms(sourceByteList, { onCollision = 'rename' } = {}) {
    const out = await PDFDocument.create({ updateMetadata: false });
    const seen = new Map();
    const collisions = [];
    const renamed = [];
    const forms = [];

    for (let s = 0; s < sourceByteList.length; s += 1) {
        const doc = await PDFDocument.load(sourceByteList[s], { updateMetadata: false });
        const form = readForm(doc);
        forms.push(form);
        if (form.present && form.outsideSubset.length > 0) {
            return {
                status: 'REFUSED',
                code: 'UNSUPPORTED_FORM',
                reason: `ソース${s + 1}に対応範囲外のフォーム要素があります: ${form.outsideSubset.join(', ')}`,
                outsideSubset: form.outsideSubset,
            };
        }
        for (const f of form.fields) {
            if (seen.has(f.name)) collisions.push(f.name);
            else seen.set(f.name, s);
        }
    }

    if (collisions.length > 0 && onCollision === 'refuse') {
        return {
            status: 'REFUSED',
            code: 'DUPLICATE_FIELD_NAMES',
            reason: `同じフィールド名が複数のソースにあります: ${[...new Set(collisions)].join(', ')}`,
            collisions: [...new Set(collisions)],
        };
    }

    const fieldRefs = [];
    for (let s = 0; s < sourceByteList.length; s += 1) {
        const doc = await PDFDocument.load(sourceByteList[s], { updateMetadata: false });
        const form = forms[s];
        const indices = doc.getPageIndices();
        const copied = await out.copyPages(doc, indices);
        const firstNew = out.getPageCount();
        copied.forEach((p) => out.addPage(p));

        for (let p = firstNew; p < out.getPageCount(); p += 1) {
            const annots = out.getPages()[p].node.lookup(PDFName.of('Annots'));
            if (!(annots instanceof PDFArray)) continue;
            for (let i = 0; i < annots.size(); i += 1) {
                const ref = annots.get(i);
                const annot = out.context.lookup(ref);
                if (!(annot instanceof PDFDict)) continue;
                if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/Widget') continue;
                const own = textOf(look(out, annot.get(PDFName.of('T'))));
                const sourceField = form.fields.find((f) => f.name === own) ?? form.fields[0];
                if (!sourceField) continue;
                let name = sourceField.name;
                if (collisions.includes(name) && onCollision === 'rename') {
                    name = `source${s + 1}.${name}`;
                    renamed.push({ from: sourceField.name, to: name, source: s + 1 });
                }
                annot.set(PDFName.of('T'), PDFString.of(name));
                if (sourceField.ft) annot.set(PDFName.of('FT'), PDFName.of(sourceField.ft.replace(/^\//, '')));
                if (sourceField.value !== null && sourceField.value !== undefined) {
                    annot.set(PDFName.of('V'), PDFString.of(sourceField.value));
                }
                annot.delete(PDFName.of('Parent'));
                if (ref instanceof PDFRef) fieldRefs.push(ref);
            }
        }
    }

    if (fieldRefs.length > 0) {
        out.catalog.set(PDFName.of('AcroForm'), out.context.register(out.context.obj({
            Fields: fieldRefs, NeedAppearances: true,
        })));
    }
    return {
        status: 'READY',
        bytes: await out.save({ useObjectStreams: false }),
        collisions: [...new Set(collisions)],
        renamed,
        rebuiltFields: fieldRefs.length,
    };
}
