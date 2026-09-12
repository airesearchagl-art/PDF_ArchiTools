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
 * **Ambiguity is a refusal, not a shrug.** A cyclic field tree, one deeper than
 * this walk will follow, or a `/Fields` entry that is not an array all leave
 * `formInspectionState: 'unreadable'`, which the planner turns into
 * `SIGNATURE_UNSAFE`. A form we cannot read completely may hide an applied
 * signature, and "probably fine" is not a thing this code is allowed to decide.
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
        current = parent instanceof PDFDict ? parent : null;
    }
    return undefined;
}

/**
 * Walk the AcroForm field tree at the dictionary level.
 *
 * Terminal fields are the ones with a `/T` and no field `/Kids`; a widget is
 * not a field, and counting widgets is how a one-field form starts reporting
 * two. A `/Sig` field is *applied* only when its effective `/V` resolves to a
 * dictionary — an empty signature box has no `/V` anywhere above it.
 */
function walkFields(
    doc: PDFDocument,
    array: PDFArray,
    facts: SourceFacts,
    inheritedName: string,
    seen: Set<string>,
    depth: number,
): void {
    if (depth > MAX_FIELD_TREE_DEPTH) {
        throw new FieldTreeUnreadable(`field tree deeper than ${MAX_FIELD_TREE_DEPTH}`);
    }
    for (let i = 0; i < array.size(); i += 1) {
        const raw = array.get(i);
        const ref = raw instanceof PDFRef ? raw : null;
        if (ref) {
            const id = ref.toString();
            if (seen.has(id)) throw new FieldTreeUnreadable('cyclic field tree');
            seen.add(id);
        }
        const field = resolve(doc, raw);
        if (!(field instanceof PDFDict)) continue;

        const partial = field.get(PDFName.of('T'));
        const partialName = partial === undefined
            ? ''
            : String((partial as { decodeText?: () => string }).decodeText?.() ?? partial);
        const fullName = inheritedName && partialName
            ? `${inheritedName}.${partialName}`
            : (partialName || inheritedName);

        const kidsRaw = resolve(doc, field.get(PDFName.of('Kids')));
        const kids = kidsRaw instanceof PDFArray ? kidsRaw : null;
        // Kids that are themselves fields (they carry /T) make this a node, not
        // a leaf. Kids that are only widgets leave it a terminal field.
        let hasFieldKids = false;
        if (kids) {
            for (let k = 0; k < kids.size(); k += 1) {
                const kid = resolve(doc, kids.get(k));
                if (kid instanceof PDFDict && kid.get(PDFName.of('T')) !== undefined) {
                    hasFieldKids = true;
                    break;
                }
            }
        }

        if (hasFieldKids && kids) {
            walkFields(doc, kids, facts, fullName, seen, depth + 1);
            continue;
        }

        if (partial === undefined) continue; // a bare widget

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
            walkFields(doc, fields, facts, '', new Set<string>(), 0);
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
