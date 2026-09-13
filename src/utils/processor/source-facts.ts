/**
 * What a source document is, read without changing it.
 *
 * The reading is done at the dictionary level for one measured reason: in
 * pdf-lib 1.17.1 `getForm()` is not read-only. It routes through
 * `getOrCreateForm()`, so a document with no AcroForm *gains an empty one*
 * merely by being inspected, and it calls `deleteXFA()` on anything carrying
 * XFA form data. The Annotator's `assessSource` already avoids that trap; this
 * module is the Processor's equivalent, and it never reaches `getForm()` at all.
 *
 * Facts only. No verdict is formed here — the H7 policy is applied in the
 * planner, over these facts — because "this document has a signature field" and
 * "this document may not be processed" are different statements, and conflating
 * them is what made an empty signature box look like a signed contract.
 *
 * **`/FT` and `/V` are inheritable.** A terminal field may carry neither and
 * still be a signature field holding a signature, because both can sit on an
 * ancestor. Reading them off the field dictionary alone misses exactly the
 * documents this boundary exists for, so both are resolved up the `/Parent`
 * chain.
 *
 * **`/T` does not decide what is a field.** It is optional. The earlier walk
 * treated a Kid as a child field only when it carried `/T`, so a child with no
 * `/T`, inheriting `/FT /Sig` from its parent and holding the signature in its
 * own `/V`, was classified as a widget, never descended into, and the applied
 * signature it held was never seen. What decides now is whether the Kid carries
 * any attribute that belongs to a field and to nothing else.
 *
 * **Ambiguity is a refusal, not a shrug.** A cyclic field tree, one deeper than
 * this walk will follow, a `/Fields` entry that is not an array, or a Kid whose
 * dictionary contradicts itself all leave `formInspectionState: 'unreadable'`,
 * which the planner turns into `SIGNATURE_UNSAFE`. A form we cannot read
 * completely may hide an applied signature, and "probably fine" is not a thing
 * this code is allowed to decide.
 *
 * Adopted: H7 (applied-only), H11 (one facts step for every operation).
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } from 'pdf-lib';
import type { SourceFacts } from './contracts';

/** How far up a `/Parent` chain, or down a field tree, this walk will go. */
export const MAX_FIELD_TREE_DEPTH = 32;

const resolve = (doc: PDFDocument, value: unknown): unknown => {
    try {
        return doc.context.lookup(value as never) ?? value;
    } catch {
        return value;
    }
};

const nameOf = (value: unknown): string => {
    const asString = (value as { asString?: () => string })?.asString;
    return typeof asString === 'function' ? asString.call(value) : String(value ?? '');
};

/** Raised when the field tree cannot be read completely. Never swallowed. */
class FieldTreeUnreadable extends Error {}

/**
 * The keys that belong to a field dictionary and to nothing else.
 *
 * A widget annotation has `/Rect`, `/AP`, `/AS`, `/MK`, `/BS`, `/F`, `/P` and
 * friends; none of those appears here, and `/DA` and `/AA` are deliberately
 * absent because a widget may carry them too. What remains is the set whose
 * presence means "this dictionary is a field", whether or not it also happens
 * to be the widget that draws it.
 */
const FIELD_ONLY_KEYS = ['T', 'FT', 'V', 'DV', 'Ff', 'TU', 'TM', 'Kids'] as const;

const hasFieldAttribute = (dict: PDFDict): boolean =>
    FIELD_ONLY_KEYS.some((key) => dict.get(PDFName.of(key)) !== undefined);

const subtypeOf = (dict: PDFDict): string | null => {
    const raw = dict.get(PDFName.of('Subtype'));
    return raw === undefined ? null : nameOf(raw);
};

/**
 * Is this Kid a child field, or an annotation that merely belongs to one?
 *
 * Descending is never the dangerous direction — it can only find more — so the
 * decision that needs an argument is the one that *skips* a Kid. A Kid with no
 * field attribute of its own is skipped, and that is safe for a reason the
 * dictionary itself proves: `/Kids` is in the set above, so such a Kid has no
 * children either, and every `/FT` or `/V` it could inherit is by definition on
 * the parent this walk is about to read as a terminal field. Skipping it cannot
 * lose a signature, only a duplicate count of one we are already looking at.
 *
 * A Kid that contradicts itself is neither, and says so: a widget annotation
 * with `/Kids`, or a dictionary carrying field attributes while declaring it is
 * some other kind of annotation. Guessing which half to believe is how an
 * applied signature gets skipped by a reader that was sure it knew better.
 */
function classifyKid(kid: PDFDict): 'field' | 'widget' {
    const subtype = subtypeOf(kid);
    const fieldAttributes = hasFieldAttribute(kid);
    const hasKids = kid.get(PDFName.of('Kids')) !== undefined;

    if (subtype === '/Widget' && hasKids) {
        throw new FieldTreeUnreadable('a widget annotation carrying /Kids');
    }
    if (subtype !== null && subtype !== '/Widget' && fieldAttributes) {
        throw new FieldTreeUnreadable(`a field dictionary declaring ${subtype}`);
    }
    return fieldAttributes ? 'field' : 'widget';
}

/**
 * An inheritable attribute, resolved the way a reader resolves it: this
 * dictionary first, then `/Parent`, then its parent, and so on.
 *
 * A loop in the chain is not "not found" — it is a document we cannot read, so
 * it refuses rather than returning undefined and letting a signature through.
 */
function inherited(
    doc: PDFDocument,
    field: PDFDict,
    key: string,
    startRef: PDFRef | null,
): unknown {
    const seen = new Set<string>();
    if (startRef) seen.add(startRef.toString());
    let current: PDFDict | null = field;
    for (let depth = 0; current; depth += 1) {
        if (depth > MAX_FIELD_TREE_DEPTH) {
            throw new FieldTreeUnreadable(`inheritable ${key} chain deeper than ${MAX_FIELD_TREE_DEPTH}`);
        }
        const own = current.get(PDFName.of(key));
        if (own !== undefined) return resolve(doc, own);

        const parentRaw = current.get(PDFName.of('Parent'));
        if (parentRaw === undefined) return undefined;
        if (parentRaw instanceof PDFRef) {
            const id = parentRaw.toString();
            if (seen.has(id)) throw new FieldTreeUnreadable('cyclic /Parent chain');
            seen.add(id);
        }
        const parent = resolve(doc, parentRaw);
        if (!(parent instanceof PDFDict)) {
            throw new FieldTreeUnreadable('/Parent is not a dictionary');
        }
        current = parent;
    }
    return undefined;
}

/**
 * Walk the AcroForm field tree at the dictionary level.
 *
 * A field is terminal when none of its Kids is itself a field — which is not
 * the same question as whether its Kids carry `/T`. A `/Sig` field is *applied*
 * only when its effective `/V` resolves to a dictionary; an empty signature box
 * has no `/V` anywhere above it.
 */
function walkFieldEntries(
    doc: PDFDocument,
    entries: unknown[],
    facts: SourceFacts,
    inheritedName: string,
    seen: Set<string>,
    depth: number,
): void {
    if (depth > MAX_FIELD_TREE_DEPTH) {
        throw new FieldTreeUnreadable(`field tree deeper than ${MAX_FIELD_TREE_DEPTH}`);
    }
    for (const raw of entries) {
        const ref = raw instanceof PDFRef ? raw : null;
        if (ref) {
            const id = ref.toString();
            if (seen.has(id)) throw new FieldTreeUnreadable('cyclic field tree');
            seen.add(id);
        }
        const field = resolve(doc, raw);
        if (!(field instanceof PDFDict)) {
            // A field slot holding something that is not a field dictionary is
            // a form we cannot enumerate, not a form with one fewer field.
            throw new FieldTreeUnreadable('a field entry that is not a dictionary');
        }

        const partial = field.get(PDFName.of('T'));
        const partialName = partial === undefined
            ? ''
            : String((partial as { decodeText?: () => string }).decodeText?.() ?? partial);
        const fullName = inheritedName && partialName
            ? `${inheritedName}.${partialName}`
            : (partialName || inheritedName);

        const kidsRaw = field.get(PDFName.of('Kids'));
        let childFields: unknown[] = [];
        if (kidsRaw !== undefined) {
            const kids = resolve(doc, kidsRaw);
            if (!(kids instanceof PDFArray)) throw new FieldTreeUnreadable('/Kids is not an array');
            const found: unknown[] = [];
            for (let k = 0; k < kids.size(); k += 1) {
                const kidRaw = kids.get(k);
                const kid = resolve(doc, kidRaw);
                if (!(kid instanceof PDFDict)) {
                    throw new FieldTreeUnreadable('a /Kids entry that is not a dictionary');
                }
                if (classifyKid(kid) === 'field') found.push(kidRaw);
            }
            childFields = found;
        }

        if (childFields.length > 0) {
            walkFieldEntries(doc, childFields, facts, fullName, seen, depth + 1);
            continue;
        }

        facts.fieldCount += 1;
        const ft = nameOf(inherited(doc, field, 'FT', ref));
        if (ft === '/Sig') {
            const value = inherited(doc, field, 'V', ref);
            facts.signatureFields.push({ name: fullName, signed: value instanceof PDFDict });
        }
    }
}

/**
 * Read the facts. Never throws for a bad document: an unreadable source is a
 * fact about it, and the planner decides what to do with that.
 */
export async function readSourceFacts(bytes: Uint8Array): Promise<SourceFacts> {
    const facts: SourceFacts = {
        readable: false,
        sourceBytes: bytes.length,
        loadError: null,
        encrypted: false,
        pageCount: 0,
        pagesValid: false,
        pageError: null,
        hasAcroForm: false,
        hasXfa: false,
        sigFlags: null,
        fieldCount: 0,
        signatureFields: [],
        hasSignatureField: false,
        hasAppliedSignature: false,
        formInspectionState: 'no-form',
        formError: null,
        pages: [],
    };
    const derive = (): SourceFacts => {
        facts.hasSignatureField = facts.signatureFields.length > 0;
        facts.hasAppliedSignature = facts.signatureFields.some((f) => f.signed);
        return facts;
    };

    let doc: PDFDocument;
    try {
        // `updateMetadata: false` matters here as well as at save time: loading
        // with the default rewrites Producer and ModDate, and this module is
        // supposed to observe the document, not edit it. H12.
        doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
        facts.readable = true;
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        facts.loadError = message;
        facts.encrypted = /encrypt/i.test(message);
        return derive();
    }

    facts.encrypted = doc.isEncrypted;

    // Loading is not the same as being usable: a damaged cross-reference region
    // can parse far enough for `load` to return and then fail in the middle of
    // a save. Every page is opened here instead, before anything is produced.
    try {
        const pages = doc.getPages();
        facts.pageCount = pages.length;
        if (pages.length === 0) throw new Error('この文書にはページがありません。');
        for (const page of pages) {
            const media = page.getMediaBox();
            page.getCropBox();
            const rotation = page.getRotation().angle;
            if (!(media.width > 0 && media.height > 0)) {
                throw new Error('ページサイズを読み取れませんでした。');
            }
            const turned = Math.abs(rotation % 180) === 90;
            facts.pages.push({
                widthPt: turned ? media.height : media.width,
                heightPt: turned ? media.width : media.height,
            });
        }
        facts.pagesValid = true;
    } catch (error) {
        facts.pageError = String((error as Error)?.message ?? error);
        return derive();
    }

    // ---- the form, read rather than created --------------------------------
    let acroForm: PDFDict | undefined;
    try {
        const raw = doc.catalog.get(PDFName.of('AcroForm'));
        if (raw !== undefined) {
            const resolved = doc.catalog.lookup(PDFName.of('AcroForm'));
            if (!(resolved instanceof PDFDict)) throw new Error('AcroForm is not a dictionary');
            acroForm = resolved;
        }
    } catch (error) {
        facts.formInspectionState = 'unreadable';
        facts.formError = String((error as Error)?.message ?? error);
        return derive();
    }

    if (!acroForm) return derive();

    facts.hasAcroForm = true;
    facts.hasXfa = acroForm.get(PDFName.of('XFA')) !== undefined;

    const sigFlags = resolve(doc, acroForm.get(PDFName.of('SigFlags')));
    if (sigFlags instanceof PDFNumber) facts.sigFlags = sigFlags.asNumber();

    try {
        const fieldsRaw = acroForm.get(PDFName.of('Fields'));
        if (fieldsRaw !== undefined) {
            const fields = resolve(doc, fieldsRaw);
            if (!(fields instanceof PDFArray)) {
                // An AcroForm that has /Fields but not as an array is a form we
                // cannot enumerate. That is exactly the state where a signature
                // could be hiding, so it refuses rather than reporting none.
                throw new FieldTreeUnreadable('/Fields is not an array');
            }
            const entries: unknown[] = [];
            for (let i = 0; i < fields.size(); i += 1) entries.push(fields.get(i));
            walkFieldEntries(doc, entries, facts, '', new Set<string>(), 0);
        }
        facts.formInspectionState = 'read';
    } catch (error) {
        facts.formInspectionState = 'unreadable';
        facts.formError = String((error as Error)?.message ?? error);
        // What was collected before the tree turned out to be unreadable is not
        // a complete picture, so it is not reported as one.
        facts.signatureFields = [];
        facts.fieldCount = 0;
    }

    return derive();
}
