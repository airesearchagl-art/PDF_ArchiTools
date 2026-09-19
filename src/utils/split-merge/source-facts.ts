/**
 * What a source is, read at the dictionary level without changing it.
 *
 * Deliberately not `getForm()`: in pdf-lib 1.17.1 that call is not read-only —
 * M5 found the same thing and its `source-facts.ts` says so at the top. Reading
 * facts must not be the thing that alters the document the facts are about.
 *
 * Two distinctions this module exists to keep:
 *
 *   - **A signature field is not a signature.** An empty `/Sig` field is a form
 *     control, and refusing a document for carrying one would refuse ordinary
 *     signable paperwork. Only a `/Sig` whose `/V` holds a dictionary is an
 *     applied signature. M5 H7 drew that line; M6 must not re-derive it
 *     differently.
 *   - **A document that loads is not a document that walks.** Two measured
 *     fixtures load cleanly and report a page count while their page tree is
 *     inconsistent — `/Count` disagreeing with `/Kids`. Intake cannot be
 *     "whatever the loader accepts", so the tree is walked here.
 */
import { PDFArray, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { M6SourceFacts } from './contracts';
import { MECHANISM_BOUNDS } from './policy';
import { censusAttachments } from './prune';
import { classifyField } from './field-semantics';
import { pdfTextOf } from './pdf-text';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/**
 * Resolve, keeping "not there" apart from "not a reference".
 *
 * A reference to an object that was never written resolves to `undefined`
 * without throwing, and a helper that fell back to the reference would hand back
 * something that reads as a value. That is how a missing object passes for a
 * present one.
 */
function look(doc: PDFDocument, value: unknown): unknown {
    try {
        if (value instanceof PDFRef) return doc.context.lookup(value);
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Walk the page tree, counting leaves and checking every `/Count` against the
 * kids actually found.
 *
 * Bounded and cycle-aware: a tree that loops is a tree that cannot be walked,
 * which is a refusal rather than a hang.
 */
function walkPageTree(doc: PDFDocument): { leaves: number; consistent: boolean } {
    const catalog = doc.catalog;
    const rootRaw = catalog.get(PDFName.of('Pages'));
    const root = look(doc, rootRaw);
    if (!(root instanceof PDFDict)) return { leaves: 0, consistent: false };

    const seen = new Set<string>();
    let consistent = true;

    const visit = (node: PDFDict, raw: unknown, depth: number): number => {
        if (depth > MECHANISM_BOUNDS.maxResourceDepth) {
            consistent = false;
            return 0;
        }
        if (raw instanceof PDFRef) {
            if (seen.has(raw.tag)) {
                consistent = false;
                return 0;
            }
            seen.add(raw.tag);
        }
        const type = nameOf(node.get(PDFName.of('Type')));
        if (type === '/Page') return 1;

        const kidsRaw = node.get(PDFName.of('Kids'));
        const kids = look(doc, kidsRaw);
        if (!(kids instanceof PDFArray)) {
            // A node that is neither a leaf nor a branch.
            consistent = false;
            return 0;
        }
        let found = 0;
        for (let i = 0; i < kids.size(); i += 1) {
            const kidRaw = kids.get(i);
            const kid = look(doc, kidRaw);
            if (!(kid instanceof PDFDict)) {
                consistent = false;
                continue;
            }
            found += visit(kid, kidRaw, depth + 1);
        }
        const declared = node.get(PDFName.of('Count'));
        const declaredValue = (declared as { asNumber?: () => number } | undefined)?.asNumber?.();
        if (typeof declaredValue === 'number' && declaredValue !== found) consistent = false;
        return found;
    };

    const leaves = visit(root, rootRaw, 0);
    return { leaves, consistent };
}

/** Every terminal AcroForm field, walked through `/Kids` with a bound. */
function walkFields(
    doc: PDFDocument,
    acro: PDFDict,
    onField: (field: PDFDict, name: string) => void,
): boolean {
    let readable = true;
    const walk = (entries: unknown[], inheritedName: string, depth: number): void => {
        if (depth > MECHANISM_BOUNDS.maxActionDepth) {
            readable = false;
            return;
        }
        for (const raw of entries) {
            const field = look(doc, raw);
            if (!(field instanceof PDFDict)) {
                readable = false;
                continue;
            }
            const partial = pdfTextOf(look(doc, field.get(PDFName.of('T'))));
            const full = inheritedName && partial
                ? `${inheritedName}.${partial}`
                : (partial ?? inheritedName);

            const kids = look(doc, field.get(PDFName.of('Kids')));
            const childFields: unknown[] = [];
            if (kids instanceof PDFArray) {
                for (let i = 0; i < kids.size(); i += 1) {
                    const kidRaw = kids.get(i);
                    const kid = look(doc, kidRaw);
                    if (!(kid instanceof PDFDict)) continue;
                    const isField = ['T', 'FT', 'V', 'DV', 'Ff', 'Kids']
                        .some((k) => kid.get(PDFName.of(k)) !== undefined);
                    if (isField) childFields.push(kidRaw);
                }
            }
            if (childFields.length > 0) {
                walk(childFields, full, depth + 1);
                continue;
            }
            onField(field, full);
        }
    };

    const fields = look(doc, acro.get(PDFName.of('Fields')));
    if (fields instanceof PDFArray) {
        const list: unknown[] = [];
        for (let i = 0; i < fields.size(); i += 1) list.push(fields.get(i));
        walk(list, '', 0);
    } else if (acro.get(PDFName.of('Fields')) !== undefined) {
        readable = false;
    }
    return readable;
}

/** Whether any page carries `/StructParents`, which a strip has to remove too. */
function pagesWithStructParents(doc: PDFDocument): number[] {
    const out: number[] = [];
    doc.getPages().forEach((page, index) => {
        if (page.node.get(PDFName.of('StructParents')) !== undefined) out.push(index);
    });
    return out;
}

/**
 * Whether this document carries an attachment, and what it is called. M6-H9d.
 *
 * **Semantic, not declared, and complete-or-refused.** This reader used to walk
 * the object table asking for `/Type /Filespec`, which is the question BLK-2R
 * ruled out: `/EF` is what makes a payload an embedded file and `/Type` is a
 * label. The removal path had already been corrected; this one had not, and it
 * is the one that feeds `requiresConfirmation` — so a typeless `/EF` carrier
 * was deleted by a Merge that never asked, because the detector that decides
 * whether to ask could not see it.
 *
 * Both paths now share one basis: {@link censusAttachments}, which enumerates
 * every indirect object and walks its direct contents, and which answers
 * COMPLETE or REFUSED rather than handing back a count it could not stand
 * behind.
 */
function readAttachments(
    doc: PDFDocument,
): { complete: boolean; reason?: string; present: boolean; names: string[] } {
    let present = false;

    const namesDict = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (namesDict instanceof PDFDict) {
        const embedded = look(doc, namesDict.get(PDFName.of('EmbeddedFiles')));
        if (embedded !== undefined) present = true;
    }

    // RF-R4-6: one label per attachment, by the census's rule — `/UF` before
    // `/F`, the embedded-files key for a specification that names nothing, and
    // an explicit unnamed label rather than silence when there is no name.
    const census = censusAttachments(doc);
    if (!census.complete) return { complete: false, reason: census.reason, present, names: [] };
    if (census.value.efCarriers > 0 || census.value.fileAttachmentAnnots > 0) present = true;

    return { complete: true, present, names: [...census.value.names] };
}

/**
 * Every widget annotation on every page, as dictionaries.
 *
 * The field tree is not the only place a signature can sit: a widget that no
 * `/Fields` entry reaches is still drawn, still removed as a signature widget,
 * and still a signature. So the facts are taken from the pages as well.
 */
function pageWidgets(doc: PDFDocument): PDFDict[] {
    const widgets: PDFDict[] = [];
    for (const page of doc.getPages()) {
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) === '/Widget') widgets.push(annot);
        }
    }
    return widgets;
}

/**
 * Read the source's facts.
 *
 * `sourceBytes` is passed in rather than derived, because the loaded document no
 * longer knows how long the file it came from was.
 */
export function readSourceFacts(doc: PDFDocument, sourceBytes: number): M6SourceFacts {
    const facts: M6SourceFacts = {
        readable: true,
        encrypted: false,
        sourceBytes,
        pageCount: 0,
        pageTreeWalks: false,
        hasSignatureField: false,
        hasAppliedSignature: false,
        signatureFieldNames: [],
        appliedSignatureFieldNames: [],
        emptySignatureFieldNames: [],
        hasXfa: false,
        hasAcroForm: false,
        hasStructTree: false,
        pagesWithStructParents: [],
        hasAttachments: false,
        attachmentNames: [],
        attachmentsComplete: false,
        hasOptionalContent: false,
    };

    try {
        facts.pageCount = doc.getPageCount();
        const tree = walkPageTree(doc);
        facts.pageTreeWalks = tree.consistent && tree.leaves === facts.pageCount;

        /**
         * RF-R4-4: one classification, from the shared resolver, for every
         * terminal field and every widget. A signature value is recognised by
         * what it holds before any ancestry is consulted, and a field whose
         * type or value sits behind an ancestry that cannot be read is a
         * refusal — never "no signature". The distinction M5 H7 drew still
         * holds: a value that is a dictionary is an applied signature, and an
         * empty field is a form control.
         */
        const classified = new Set<PDFDict>();
        const classify = (field: PDFDict, name: string): void => {
            if (classified.has(field)) return;
            classified.add(field);
            const kind = classifyField(doc, field);
            if (kind.kind === 'unreadable') {
                facts.readable = false;
                facts.reason = `${name || '(no name)'}: ${kind.reason}`;
                return;
            }
            if (kind.kind !== 'signature') return;
            facts.hasSignatureField = true;
            facts.signatureFieldNames.push(name || '(no name)');
            if (kind.applied) {
                facts.hasAppliedSignature = true;
                facts.appliedSignatureFieldNames.push(name || '(no name)');
            } else {
                facts.emptySignatureFieldNames.push(name || '(no name)');
            }
        };

        const acro = look(doc, doc.catalog.get(PDFName.of('AcroForm')));
        if (acro instanceof PDFDict) {
            facts.hasAcroForm = true;
            facts.hasXfa = acro.get(PDFName.of('XFA')) !== undefined;
            const readable = walkFields(doc, acro, classify);
            if (!readable) facts.readable = false;
        }
        // Widgets the field tree does not reach. A widget that is its field
        // was decided with it, and so was a bare widget whose parent is a
        // decided field; counting either again would name one field twice.
        for (const widget of pageWidgets(doc)) {
            const parent = look(doc, widget.get(PDFName.of('Parent')));
            if (parent instanceof PDFDict && classified.has(parent)) continue;
            classify(widget, pdfTextOf(look(doc, widget.get(PDFName.of('T')))) ?? '');
        }

        facts.hasStructTree = doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined;
        facts.pagesWithStructParents = pagesWithStructParents(doc);

        const attachments = readAttachments(doc);
        facts.hasAttachments = attachments.present;
        facts.attachmentNames = attachments.names;
        facts.attachmentsComplete = attachments.complete;
        if (!attachments.complete) facts.attachmentsRefusal = attachments.reason;

        facts.hasOptionalContent = doc.catalog.get(PDFName.of('OCProperties')) !== undefined;
    } catch (error) {
        facts.readable = false;
        facts.reason = String((error as Error)?.message ?? error);
    }

    return facts;
}

/**
 * Tell an encrypted source apart from a corrupt one.
 *
 * A password-protected file and a broken file are different problems for the
 * person holding the PDF, and the remedy differs, so the codes differ. pdf-lib
 * compiles its error classes to plain `Error`, so the message is the only
 * signal available — the same approach the Textifier takes at its own loader
 * boundary.
 */
export function classifyLoadError(error: unknown): 'ENCRYPTED' | 'UNREADABLE' {
    const message = String((error as Error)?.message ?? error);
    return /encrypted/i.test(message) ? 'ENCRYPTED' : 'UNREADABLE';
}
