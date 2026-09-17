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

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

const textOf = (v: unknown): string | null => {
    const decode = (v as { decodeText?: () => string } | null)?.decodeText;
    return typeof decode === 'function' ? decode.call(v) : null;
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
            const partial = textOf(look(doc, field.get(PDFName.of('T'))));
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

/** `/Names /EmbeddedFiles`, or any `/Filespec` carrying an `/EF`. M6-H9d. */
function readAttachments(doc: PDFDocument): { present: boolean; names: string[] } {
    const names: string[] = [];
    let present = false;

    const namesDict = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (namesDict instanceof PDFDict) {
        const embedded = look(doc, namesDict.get(PDFName.of('EmbeddedFiles')));
        if (embedded !== undefined) present = true;
        if (embedded instanceof PDFDict) {
            const list = look(doc, embedded.get(PDFName.of('Names')));
            if (list instanceof PDFArray) {
                for (let i = 0; i + 1 < list.size(); i += 2) {
                    const label = textOf(look(doc, list.get(i)));
                    if (label) names.push(label);
                }
            }
        }
    }

    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('Type'))) !== '/Filespec') continue;
        if (obj.get(PDFName.of('EF')) === undefined) continue;
        present = true;
        const label = textOf(look(doc, obj.get(PDFName.of('F'))))
            ?? textOf(look(doc, obj.get(PDFName.of('UF'))));
        if (label && !names.includes(label)) names.push(label);
    }

    return { present, names };
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
        hasXfa: false,
        hasAcroForm: false,
        hasStructTree: false,
        pagesWithStructParents: [],
        hasAttachments: false,
        attachmentNames: [],
        hasOptionalContent: false,
    };

    try {
        facts.pageCount = doc.getPageCount();
        const tree = walkPageTree(doc);
        facts.pageTreeWalks = tree.consistent && tree.leaves === facts.pageCount;

        const acro = look(doc, doc.catalog.get(PDFName.of('AcroForm')));
        if (acro instanceof PDFDict) {
            facts.hasAcroForm = true;
            facts.hasXfa = acro.get(PDFName.of('XFA')) !== undefined;
            const readable = walkFields(doc, acro, (field, name) => {
                const ft = nameOf(field.get(PDFName.of('FT')));
                if (ft !== '/Sig') return;
                facts.hasSignatureField = true;
                facts.signatureFieldNames.push(name || '(no name)');
                // The distinction that matters: a value that is a dictionary is
                // an applied signature. An empty field is a form control.
                const value = look(doc, field.get(PDFName.of('V')));
                if (value instanceof PDFDict) facts.hasAppliedSignature = true;
            });
            if (!readable) facts.readable = false;
        }

        facts.hasStructTree = doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined;
        facts.pagesWithStructParents = pagesWithStructParents(doc);

        const attachments = readAttachments(doc);
        facts.hasAttachments = attachments.present;
        facts.attachmentNames = attachments.names;

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
