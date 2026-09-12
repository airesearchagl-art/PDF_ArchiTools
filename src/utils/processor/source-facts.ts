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
 * Adopted: H7 (applied-only), H11 (one facts step for every operation).
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import type { SourceFacts } from './contracts';

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

/**
 * Walk the AcroForm field tree at the dictionary level.
 *
 * Terminal fields are the ones with a `/T` and no field `/Kids`; a widget is
 * not a field, and counting widgets is how a one-field form starts reporting
 * two. A `/Sig` field is *applied* only when its `/V` resolves to a dictionary
 * — an empty signature box has no `/V`, or a null one.
 */
function walkFields(
    doc: PDFDocument,
    array: PDFArray,
    facts: SourceFacts,
    inheritedName: string,
    depth = 0,
): void {
    if (depth > 32) return; // a cycle is a broken document, not a deep one
    for (let i = 0; i < array.size(); i += 1) {
        const field = resolve(doc, array.get(i));
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
            walkFields(doc, kids, facts, fullName, depth + 1);
            continue;
        }

        if (partial === undefined) continue; // a bare widget

        facts.fieldCount += 1;
        const ft = nameOf(field.get(PDFName.of('FT')));
        if (ft === '/Sig') {
            const value = resolve(doc, field.get(PDFName.of('V')));
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
        const fields = resolve(doc, acroForm.get(PDFName.of('Fields')));
        if (fields instanceof PDFArray) walkFields(doc, fields, facts, '');
        facts.formInspectionState = 'read';
    } catch (error) {
        facts.formInspectionState = 'unreadable';
        facts.formError = String((error as Error)?.message ?? error);
    }

    return derive();
}
