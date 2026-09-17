/**
 * How much of an AcroForm can be carried, and where the honest answer is "no".
 * Adopted M6-H3 as S1-A: reconstruct simple `/Tx`, refuse everything else.
 *
 * The subset is deliberately small, and **the detector is the deliverable as
 * much as the reconstruction is**: "refuse where the document depends on X" is
 * not implementable until `depends on X` is a function.
 *
 * An earlier version of the research advertised `/Tx /Btn /Ch /Sig`. The
 * reconstruction only ever restored `/T`, `/FT` and `/V` — it read `/Ff` without
 * writing it back, never touched `/DV`, never carried AcroForm `/DR`, and never
 * checked a button's `/AS` against its `/AP`. Four type names on one type's
 * evidence. So the subset here is what the evidence supports, and widening it
 * means adding fixtures and post-readback proof per type, not editing an array.
 *
 * Half a field is not a smaller field: the value belongs to neither half, and a
 * widget that renders while bound to nothing is exactly the state this contract
 * exists to forbid.
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

/** The one field type this contract has proven it can rebuild. */
export const SUPPORTED_FIELD_TYPES = ['/Tx'];

/**
 * Field entries that take a `/Tx` outside the proven shape.
 *
 * Each is refused because the reconstruction does not restore it, and a field
 * that comes back without its default value, its flags or the resources its
 * `/DA` names is not the field that went in — it is a field-shaped thing with
 * the same name.
 */
export const UNRESTORED_FIELD_KEYS = ['Ff', 'DV', 'AA'];

/**
 * Entries whose presence means the form does something this contract cannot
 * reason about.
 *
 * `/AA` is an additional-actions dictionary, `/CO` a calculation order, and a
 * document-level `/Names /JavaScript` tree can reach fields **by name** from
 * anywhere. Renaming a field in any of those documents can silently break a
 * calculation no structural check would notice — which is precisely why
 * rename-on-collision is offerable at all: the documents where it could break
 * something invisible are detected and refused first.
 */
export const DISQUALIFYING = ['AA', 'CO'];

export interface FormField {
    ref: PDFRef | null;
    name: string;
    ft: string;
    merged: boolean;
    value: string | null;
    widgetRefs: PDFRef[];
    widgetPages: (number | null)[];
}

export interface FormDescription {
    present: boolean;
    xfa: boolean;
    dr: boolean;
    drFonts: string[];
    da: string | null;
    fields: FormField[];
    /**
     * `/Sig` fields, kept apart from the rest.
     *
     * A signature field is not carried and not refused: M6-H1 adopted option B,
     * which allows the unsigned derivative and **removes** the signature widget
     * and its appearance stream. So it is neither a field the reconstruction has
     * to rebuild nor a reason to declare the form unsupported — checking it
     * against the `/Tx` subset would refuse every signed drawing on the grounds
     * that it carries the thing the contract already says to remove.
     */
    signatureFields: string[];
    outsideSubset: string[];
    readable: boolean;
}

/** An inheritable attribute, resolved up `/Parent` with a bound and a cycle set. */
function inherited(doc: PDFDocument, field: PDFDict, key: string): unknown {
    const seen = new Set<string>();
    let current: PDFDict | null = field;
    for (let depth = 0; current && depth <= MECHANISM_BOUNDS.maxInheritanceDepth; depth += 1) {
        const own = current.get(PDFName.of(key));
        if (own !== undefined) return look(doc, own);
        const parentRaw = current.get(PDFName.of('Parent'));
        if (parentRaw === undefined) return undefined;
        if (parentRaw instanceof PDFRef) {
            if (seen.has(parentRaw.tag)) return undefined;
            seen.add(parentRaw.tag);
        }
        const parent = look(doc, parentRaw);
        current = parent instanceof PDFDict ? parent : null;
    }
    return undefined;
}

/**
 * Read a form the way a contract has to: terminal fields, their widgets, which
 * page each widget is on, and whether anything here is outside the subset.
 */
export function readForm(doc: PDFDocument): FormDescription {
    const pages = doc.getPages();
    const annotTagsByPage = pages.map((page) => {
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        const tags: string[] = [];
        if (annots instanceof PDFArray) {
            for (let i = 0; i < annots.size(); i += 1) {
                const raw = annots.get(i);
                if (raw instanceof PDFRef) tags.push(raw.tag);
            }
        }
        return tags;
    });
    const pageOf = (ref: unknown): number | null => {
        if (!(ref instanceof PDFRef)) return null;
        for (let i = 0; i < annotTagsByPage.length; i += 1) {
            if (annotTagsByPage[i].includes(ref.tag)) return i;
        }
        return null;
    };

    const acro = look(doc, doc.catalog.get(PDFName.of('AcroForm')));
    const out: FormDescription = {
        present: acro instanceof PDFDict,
        xfa: acro instanceof PDFDict && acro.get(PDFName.of('XFA')) !== undefined,
        dr: acro instanceof PDFDict && acro.get(PDFName.of('DR')) !== undefined,
        drFonts: [],
        da: acro instanceof PDFDict ? textOf(look(doc, acro.get(PDFName.of('DA')))) : null,
        fields: [],
        signatureFields: [],
        outsideSubset: [],
        readable: true,
    };
    if (!(acro instanceof PDFDict)) return out;

    // Which resource names `/DR` actually supplies, so a field's `/DA` can be
    // checked against them rather than against the presence of `/DR` alone.
    const dr = look(doc, acro.get(PDFName.of('DR')));
    if (dr instanceof PDFDict) {
        const fonts = look(doc, dr.get(PDFName.of('Font')));
        if (fonts instanceof PDFDict) {
            for (const [key] of fonts.entries()) out.drFonts.push(key.asString().replace(/^\//, ''));
        }
    }

    for (const key of DISQUALIFYING) {
        if (acro.get(PDFName.of(key)) !== undefined) out.outsideSubset.push(`AcroForm /${key}`);
    }
    const names = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript')) !== undefined) {
        out.outsideSubset.push('document-level /JavaScript');
    }

    const walk = (entries: unknown[], inheritedName: string, depth: number): void => {
        if (depth > MECHANISM_BOUNDS.maxActionDepth) {
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
            const full = inheritedName && partial
                ? `${inheritedName}.${partial}`
                : (partial ?? inheritedName);

            for (const key of DISQUALIFYING) {
                if (field.get(PDFName.of(key)) !== undefined) out.outsideSubset.push(`${full} /${key}`);
            }

            const kids = look(doc, field.get(PDFName.of('Kids')));
            const childFields: unknown[] = [];
            const widgets: PDFRef[] = [];
            if (kids instanceof PDFArray) {
                for (let i = 0; i < kids.size(); i += 1) {
                    const kidRaw = kids.get(i);
                    const kid = look(doc, kidRaw);
                    if (!(kid instanceof PDFDict)) continue;
                    const isField = ['T', 'FT', 'V', 'DV', 'Ff', 'Kids']
                        .some((k) => kid.get(PDFName.of(k)) !== undefined);
                    if (isField) childFields.push(kidRaw);
                    else if (kidRaw instanceof PDFRef) widgets.push(kidRaw);
                }
            }
            if (childFields.length > 0) {
                walk(childFields, full, depth + 1);
                continue;
            }

            const widgetRefs = widgets.length > 0 ? widgets : (ref ? [ref] : []);

            // `/FT` and `/V` are inheritable, so a terminal field may carry
            // neither. The proven shape carries both on itself; anything relying
            // on inheritance is outside it, and saying so is cheaper than a
            // reconstruction that guesses.
            const ownFt = nameOf(field.get(PDFName.of('FT')));
            const inheritedFt = ownFt || nameOf(inherited(doc, field, 'FT'));
            const ownValue = field.get(PDFName.of('V')) !== undefined;
            if (!ownFt && inheritedFt) out.outsideSubset.push(`${full} inherits /FT`);
            if (!ownValue && inherited(doc, field, 'V') !== undefined) {
                out.outsideSubset.push(`${full} inherits /V`);
            }

            const ft = inheritedFt;

            /**
             * A signature field leaves the subset conversation entirely.
             *
             * It is removed by M6-H1's adopted option B, so it is not measured
             * against a reconstruction that was never going to run on it. Its
             * widgets are still recorded, because the straddle check and the
             * orphan-widget invariant both need to know where they are.
             */
            if (ft === '/Sig') {
                out.signatureFields.push(full);
                out.fields.push({
                    ref,
                    name: full,
                    ft,
                    merged: widgets.length === 0,
                    value: null,
                    widgetRefs,
                    widgetPages: widgetRefs.map((w) => pageOf(w)),
                });
                continue;
            }

            if (ft && !SUPPORTED_FIELD_TYPES.includes(ft)) out.outsideSubset.push(`${full} ${ft}`);

            for (const key of UNRESTORED_FIELD_KEYS) {
                if (field.get(PDFName.of(key)) !== undefined) out.outsideSubset.push(`${full} /${key}`);
            }

            // A separate widget dictionary keeps the field's own `/DA`, `/Ff`
            // and value on a dictionary the copy does not preserve as a field.
            if (widgets.length > 0) out.outsideSubset.push(`${full} has separate widget dictionaries`);

            // A `/DA` naming a font that lives in AcroForm `/DR` needs `/DR`
            // carried, which this reconstruction does not do.
            const da = textOf(look(doc, field.get(PDFName.of('DA'))));
            if (da && out.dr) {
                const named = /\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/.exec(da)?.[1];
                if (named && out.drFonts.includes(named)) {
                    out.outsideSubset.push(`${full} /DA names /${named} from AcroForm /DR`);
                }
            }

            out.fields.push({
                ref,
                name: full,
                ft,
                merged: widgets.length === 0,
                value: textOf(look(doc, field.get(PDFName.of('V')))),
                widgetRefs,
                widgetPages: widgetRefs.map((w) => pageOf(w)),
            });
        }
    };

    const fields = look(doc, acro.get(PDFName.of('Fields')));
    if (fields instanceof PDFArray) {
        const entries: unknown[] = [];
        for (let i = 0; i < fields.size(); i += 1) entries.push(fields.get(i));
        walk(entries, '', 0);
    } else if (acro.get(PDFName.of('Fields')) !== undefined) {
        out.readable = false;
    }
    return out;
}

export type FormPlan =
    | { status: 'NO_FORM' }
    | { status: 'CARRY'; carried: string[]; dropped: string[] }
    | {
        status: 'REFUSE';
        code: 'UNSUPPORTED_DOCUMENT' | 'XFA_UNSAFE' | 'FIELD_SPANS_SELECTION' | 'UNSUPPORTED_FORM';
        reason: string;
        detail?: Record<string, unknown>;
    };

/**
 * Can this selection carry its form?
 *
 * Straddling is decided **before** the general subset check, and on purpose. A
 * field whose widgets sit on both kept and dropped pages necessarily has
 * separate widget dictionaries, which the narrowed subset also refuses — so
 * checking the subset first would make `FIELD_SPANS_SELECTION` unreachable and
 * report the vaguer reason. Both facts are true; the sharper one is worth
 * telling someone, and the other reasons travel with it.
 */
export function planFormForExtract(form: FormDescription, selection: number[]): FormPlan {
    const kept = new Set(selection);
    if (!form.present) return { status: 'NO_FORM' };
    if (!form.readable) {
        return {
            status: 'REFUSE',
            code: 'UNSUPPORTED_DOCUMENT',
            reason: 'フォーム構造を読み取れません。',
        };
    }
    if (form.xfa) {
        return {
            status: 'REFUSE',
            code: 'XFA_UNSAFE',
            reason: 'XFAフォームは保持できないため、この操作は行いません。',
        };
    }

    // A `/Sig` field is removed rather than reconstructed, so it cannot be
    // straddled across a selection in any way that matters.
    const carryable = form.fields.filter((f) => f.ft !== '/Sig');

    const straddling = carryable.filter((f) => {
        const pagesOfField = f.widgetPages.filter((p): p is number => p !== null);
        const inside = pagesOfField.filter((p) => kept.has(p));
        return inside.length > 0 && inside.length < pagesOfField.length;
    });
    if (straddling.length > 0) {
        const also = form.outsideSubset.length > 0
            ? `（このフォームは他にも対応範囲外の要素を含みます: ${form.outsideSubset.join(', ')}）`
            : '';
        return {
            status: 'REFUSE',
            code: 'FIELD_SPANS_SELECTION',
            reason: `フィールド ${straddling.map((f) => f.name).join(', ')} は選択外のページにも部品を持つため、`
                + `分割すると入力値の意味が失われます。${also}`,
            detail: {
                straddling: straddling.map((f) => f.name),
                alsoOutsideSubset: form.outsideSubset,
            },
        };
    }

    if (form.outsideSubset.length > 0) {
        return {
            status: 'REFUSE',
            code: 'UNSUPPORTED_FORM',
            reason: `対応範囲外のフォーム要素があります: ${form.outsideSubset.join(', ')}`,
            detail: { outsideSubset: form.outsideSubset },
        };
    }

    const carried = carryable.filter(
        (f) => f.widgetPages.some((p) => p !== null && kept.has(p)),
    );
    const dropped = carryable.filter((f) => !carried.includes(f));
    return {
        status: 'CARRY',
        carried: carried.map((f) => f.name),
        dropped: dropped.map((f) => f.name),
    };
}

/**
 * Rebuild the AcroForm on an output document.
 *
 * The widgets already travelled with their pages; what is missing is the tree
 * that gives them meaning. This walks the output's own annotations, finds the
 * widgets, and registers them as fields again with the values the source held.
 *
 * `rename` lets Merge apply its collision policy without this function knowing
 * about sources.
 */
export function rebuildAcroForm(
    out: PDFDocument,
    sourceFields: FormField[],
    options: { da?: string | null; rename?: (name: string) => string; startPage?: number } = {},
): { rebuiltFields: number; fieldRefs: PDFRef[]; renamed: { from: string; to: string }[] } {
    const fieldRefs: PDFRef[] = [];
    const renamed: { from: string; to: string }[] = [];
    const byName = new Map(sourceFields.map((f) => [f.name, f]));
    const outPages = out.getPages();
    const startPage = options.startPage ?? 0;
    let cursor = 0;

    for (let p = startPage; p < outPages.length; p += 1) {
        const annots = outPages[p].node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const ref = annots.get(i);
            const annot = out.context.lookup(ref);
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/Widget') continue;

            const own = textOf(look(out, annot.get(PDFName.of('T'))));
            const source = (own !== null ? byName.get(own) : undefined)
                ?? sourceFields[Math.min(cursor, sourceFields.length - 1)];
            if (!source) continue;

            const finalName = options.rename ? options.rename(source.name) : source.name;
            if (finalName !== source.name) renamed.push({ from: source.name, to: finalName });

            annot.set(PDFName.of('T'), PDFString.of(finalName));
            if (source.ft) annot.set(PDFName.of('FT'), PDFName.of(source.ft.replace(/^\//, '')));
            if (source.value !== null && source.value !== undefined) {
                annot.set(PDFName.of('V'), PDFString.of(source.value));
            }
            // A merged field/widget must not keep a `/Parent` pointing into a
            // field tree that no longer exists.
            annot.delete(PDFName.of('Parent'));
            if (ref instanceof PDFRef) fieldRefs.push(ref);
            cursor += 1;
        }
    }

    if (fieldRefs.length > 0) {
        const existing = out.catalog.lookup(PDFName.of('AcroForm'));
        const allRefs = [...fieldRefs];
        if (existing instanceof PDFDict) {
            const previous = existing.lookup(PDFName.of('Fields'));
            if (previous instanceof PDFArray) {
                for (let i = 0; i < previous.size(); i += 1) {
                    const r = previous.get(i);
                    if (r instanceof PDFRef && !allRefs.some((x) => x.tag === r.tag)) allRefs.unshift(r);
                }
            }
        }
        const acro: Record<string, unknown> = { Fields: allRefs, NeedAppearances: true };
        if (options.da) acro.DA = PDFString.of(options.da);
        out.catalog.set(PDFName.of('AcroForm'), out.context.register(out.context.obj(acro as never)));
    }

    return { rebuiltFields: fieldRefs.length, fieldRefs, renamed };
}

/**
 * Widgets in an artifact that belong to no field.
 *
 * Measured on a signed source: removing the signature left `AcroForm absent, 0
 * signature fields, 1 orphan widget — with its /AP`, rendering pixel for pixel
 * like the signed original. Zero orphan widgets is part of every successful
 * output (M6-H3).
 */
export function countOrphanWidgets(doc: PDFDocument): number {
    const fieldTags = new Set<string>();
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acro instanceof PDFDict) {
        const collect = (entries: PDFArray, depth: number): void => {
            if (depth > MECHANISM_BOUNDS.maxActionDepth) return;
            for (let i = 0; i < entries.size(); i += 1) {
                const raw = entries.get(i);
                if (raw instanceof PDFRef) fieldTags.add(raw.tag);
                const field = doc.context.lookup(raw);
                if (field instanceof PDFDict) {
                    const kids = field.lookup(PDFName.of('Kids'));
                    if (kids instanceof PDFArray) collect(kids, depth + 1);
                }
            }
        };
        const fields = acro.lookup(PDFName.of('Fields'));
        if (fields instanceof PDFArray) collect(fields, 0);
    }

    let orphans = 0;
    for (const page of doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const raw = annots.get(i);
            const annot = doc.context.lookup(raw);
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/Widget') continue;
            const tag = raw instanceof PDFRef ? raw.tag : null;
            if (!tag || !fieldTags.has(tag)) orphans += 1;
        }
    }
    return orphans;
}

/**
 * Remove a signature widget and its appearance stream. M6-H1, option B.
 *
 * Removing the signature is not removing the signature block: measured, an
 * extract of a signed document kept the widget and its `/AP` and rendered
 * 4,325 non-white pixels of 24,300 — pixel for pixel identical to the source. A
 * reader opening the derived file saw a signed-looking document carrying no
 * signature. So the appearance goes with the field.
 */
export function removeSignatureWidgets(doc: PDFDocument): number {
    let removed = 0;
    const removedTags = new Set<string>();

    for (const page of doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = annots.size() - 1; i >= 0; i -= 1) {
            const raw = annots.get(i);
            const annot = doc.context.lookup(raw);
            if (!(annot instanceof PDFDict)) continue;
            const isWidget = nameOf(annot.get(PDFName.of('Subtype'))) === '/Widget';
            const ft = nameOf(annot.get(PDFName.of('FT')))
                || nameOf(inherited(doc, annot, 'FT'));
            if (!isWidget || ft !== '/Sig') continue;
            // The appearance goes with the field. Measured: removing the
            // signature and leaving the widget produced an extract that rendered
            // 4,325 non-white pixels of 24,300 — pixel for pixel identical to
            // the signed source, on a document carrying no signature.
            annot.delete(PDFName.of('AP'));
            annot.delete(PDFName.of('V'));
            annots.remove(i);
            if (raw instanceof PDFRef) {
                removedTags.add(raw.tag);
                doc.context.delete(raw);
            }
            removed += 1;
        }
    }

    // Take the same fields out of the AcroForm, and take the AcroForm itself
    // only if nothing is left in it. A drawing can carry a signature field and
    // ordinary text fields, and removing the signature must not remove those.
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acro instanceof PDFDict) {
        const fields = acro.lookup(PDFName.of('Fields'));
        if (fields instanceof PDFArray) {
            for (let i = fields.size() - 1; i >= 0; i -= 1) {
                const raw = fields.get(i);
                if (raw instanceof PDFRef && removedTags.has(raw.tag)) {
                    fields.remove(i);
                    continue;
                }
                const field = doc.context.lookup(raw);
                if (field instanceof PDFDict && nameOf(field.get(PDFName.of('FT'))) === '/Sig') {
                    fields.remove(i);
                    if (raw instanceof PDFRef) doc.context.delete(raw);
                    removed += 1;
                }
            }
            if (fields.size() === 0) doc.catalog.delete(PDFName.of('AcroForm'));
        } else {
            doc.catalog.delete(PDFName.of('AcroForm'));
        }
        // `/SigFlags` describes a signing capability the artifact no longer has.
        if (doc.catalog.get(PDFName.of('AcroForm')) !== undefined) {
            acro.delete(PDFName.of('SigFlags'));
        }
    }

    return removed;
}
