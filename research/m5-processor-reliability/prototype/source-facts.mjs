/**
 * What a source document *is* — facts, with no verdict attached.
 *
 * M3's `assessSource` answers a different question: may the Annotator save
 * this document? Its `supported` flag folds the Annotator's policy into the
 * reading — XFA present means `xfa-unsupported`, `supported: false`, and no
 * document — which is right for the Annotator and is not something the
 * Processor may inherit before its own policy (H7) is decided: measured, some
 * Processor paths re-serialise XFA without removing it.
 *
 * So this separates the two:
 *
 *   readSourceFacts(bytes)                     facts only, never a verdict
 *   planOperation(facts, operation, policy)    the product decision
 *
 * The reading reuses M3's proven dictionary-level approach — load with
 * `updateMetadata: false`, read `/AcroForm` from the catalog, check `/XFA` on
 * the dictionary — and goes one step further: the field tree is walked at the
 * dictionary level too, so `getForm()` is never called, not even for a form
 * without XFA. In pdf-lib 1.17.1 `getForm()` creates an AcroForm where there
 * was none and deletes XFA (M3); a fact-reader must not do either.
 *
 * Research code. Not part of the app.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } from 'pdf-lib';

function resolve(doc, v) { return v instanceof PDFRef ? doc.context.lookup(v) : v; }
const text = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText()
    : (v instanceof PDFName ? v.decodeText() : undefined));

/**
 * @returns {Promise<{
 *   readable: boolean, loadError: string|null, encrypted: boolean,
 *   pageCount: number, pagesValid: boolean, pageError: string|null,
 *   hasAcroForm: boolean, hasXfa: boolean, sigFlags: number|null,
 *   fieldCount: number, signatureFields: {name: string, signed: boolean}[],
 *   formInspectionState: 'no-form'|'read'|'unreadable', formError: string|null,
 * }>}
 */
export async function readSourceFacts(bytes) {
    const facts = {
        readable: false, loadError: null, encrypted: false,
        pageCount: 0, pagesValid: false, pageError: null,
        hasAcroForm: false, hasXfa: false, sigFlags: null,
        fieldCount: 0, signatureFields: [],
        formInspectionState: 'no-form', formError: null,
    };
    let doc;
    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
    } catch (error) {
        const message = String(error?.message ?? error);
        facts.encrypted = /encrypt/i.test(message);
        facts.loadError = message;
        return facts;
    }
    facts.readable = true;
    facts.encrypted = doc.isEncrypted;
    if (facts.encrypted) return facts;

    // Loading is not the same as being usable (M3): open and measure every
    // page before anything is planned.
    try {
        const pages = doc.getPages();
        facts.pageCount = pages.length;
        if (pages.length === 0) throw new Error('no pages');
        for (const page of pages) {
            const media = page.getMediaBox();
            page.getCropBox();
            page.getRotation();
            if (!(media.width > 0 && media.height > 0)) throw new Error('page size unreadable');
        }
        facts.pagesValid = true;
    } catch (error) {
        facts.pageError = String(error?.message ?? error);
        return facts;
    }

    // The form, read as dictionaries and never created or touched.
    try {
        const raw = doc.catalog.get(PDFName.of('AcroForm'));
        if (raw === undefined) return facts;
        const acro = resolve(doc, raw);
        if (!(acro instanceof PDFDict)) throw new Error('AcroForm is not a dictionary');
        facts.hasAcroForm = true;
        facts.hasXfa = acro.get(PDFName.of('XFA')) !== undefined;
        const flags = resolve(doc, acro.get(PDFName.of('SigFlags')));
        facts.sigFlags = typeof flags?.asNumber === 'function' ? flags.asNumber() : null;
        const seen = new Set();
        const visit = (ref, prefix, inheritedFt) => {
            const key = ref instanceof PDFRef ? ref.toString() : null;
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            const d = resolve(doc, ref);
            if (!(d instanceof PDFDict)) return;
            const t = text(d.get(PDFName.of('T')));
            const name = t === undefined ? prefix : (prefix ? `${prefix}.${t}` : t);
            const ft = text(d.get(PDFName.of('FT'))) ?? inheritedFt;
            const kids = resolve(doc, d.get(PDFName.of('Kids')));
            const hasFieldKids = kids instanceof PDFArray && kids.asArray()
                .some((k) => resolve(doc, k)?.get?.(PDFName.of('T')) !== undefined);
            // A terminal field has a name of its own; its widgets (kids without
            // /T) are not fields.
            if (!hasFieldKids && t !== undefined) {
                facts.fieldCount += 1;
                if (ft === 'Sig') {
                    facts.signatureFields.push({
                        name, signed: resolve(doc, d.get(PDFName.of('V'))) instanceof PDFDict,
                    });
                }
            }
            if (kids instanceof PDFArray) for (const k of kids.asArray()) visit(k, name, ft);
        };
        const fields = resolve(doc, acro.get(PDFName.of('Fields')));
        if (fields instanceof PDFArray) for (const f of fields.asArray()) visit(f, '', undefined);
        facts.formInspectionState = 'read';
    } catch (error) {
        facts.formInspectionState = 'unreadable';
        facts.formError = String(error?.message ?? error);
    }
    return facts;
}

// ---------------------------------------------------------------------------
// What each operation does to a document, as measured (baseline.md). A fact
// about the operation, not a policy.
// ---------------------------------------------------------------------------
export const OPERATION_EFFECTS = Object.freeze({
    'layer': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'margin-inplace': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'monochrome-C': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'optimize-O2': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'optimize-O3': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'normalize-size': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'title-block-update': { class: 'STRUCTURE_PRESERVING', reserialises: true, keepsXfa: true, keepsForm: true },
    'monochrome-A': { class: 'INTENTIONAL_FLATTENING', reserialises: true, keepsXfa: false, keepsForm: false },
    'optimize-O1': { class: 'INTENTIONAL_FLATTENING', reserialises: true, keepsXfa: false, keepsForm: false },
    'both': { class: 'INTENTIONAL_FLATTENING', reserialises: true, keepsXfa: false, keepsForm: false },
    'margin-embed': { class: 'STRUCTURE_LOSSY', reserialises: true, keepsXfa: false, keepsForm: false },
});

/**
 * H7's candidate policies, as data. None is adopted; the gate applies each so
 * the Human Gate can see what it would decide.
 *
 *   signed          'refuse'                 — every candidate re-serialises
 *   xfa             'refuse-always'          — the Annotator's rule
 *                   'refuse-if-dropped'      — refuse only operations that drop it
 *                   'confirm-if-dropped'     — a flattening may drop it on confirmation
 *   formUnreadable  'refuse'                 — cannot tell whether it is signed
 */
export const H7_POLICIES = Object.freeze({
    'annotator-equivalent': { signed: 'refuse', xfa: 'refuse-always', formUnreadable: 'refuse' },
    'refuse-if-dropped': { signed: 'refuse', xfa: 'refuse-if-dropped', formUnreadable: 'refuse' },
    'confirm-if-dropped': { signed: 'refuse', xfa: 'confirm-if-dropped', formUnreadable: 'refuse' },
});

/**
 * Facts + operation + an adopted policy → a PLAN status. Pure: no document is
 * opened here, so a plan cannot depend on anything the facts did not record.
 */
export function planOperation(facts, operation, policy) {
    const effect = OPERATION_EFFECTS[operation];
    if (!effect) return { status: 'UNSUPPORTED_OPERATION', reasons: [`unknown operation ${operation}`] };
    if (!facts.readable && facts.encrypted) return { status: 'ENCRYPTED', reasons: [facts.loadError] };
    if (!facts.readable) return { status: 'UNSUPPORTED_DOCUMENT', reasons: [facts.loadError] };
    if (facts.encrypted) return { status: 'ENCRYPTED', reasons: ['encrypted'] };
    if (!facts.pagesValid) return { status: 'UNSUPPORTED_DOCUMENT', reasons: [facts.pageError] };
    if (facts.formInspectionState === 'unreadable' && policy.formUnreadable === 'refuse') {
        return { status: 'SIGNATURE_UNSAFE', reasons: ['the form could not be read, so a signature cannot be ruled out'] };
    }
    const signed = facts.signatureFields.length > 0 || (facts.sigFlags !== null && facts.sigFlags > 0);
    if (signed && effect.reserialises && policy.signed === 'refuse') {
        return { status: 'SIGNATURE_UNSAFE', reasons: ['re-saving invalidates the signature'] };
    }
    const losses = [];
    if (facts.hasXfa) {
        if (policy.xfa === 'refuse-always') return { status: 'XFA_UNSAFE', reasons: ['XFA form data present'] };
        if (!effect.keepsXfa) {
            if (policy.xfa === 'refuse-if-dropped') return { status: 'XFA_UNSAFE', reasons: [`${operation} drops XFA`] };
            losses.push('XFA');
        }
    }
    if (effect.class === 'INTENTIONAL_FLATTENING') {
        losses.push('searchable text', 'OCR layer', 'vectors', 'annotations', 'links', 'forms', 'metadata');
    }
    if (losses.length > 0) return { status: 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION', reasons: losses };
    return { status: 'READY', reasons: [] };
}
