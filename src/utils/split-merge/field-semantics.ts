/**
 * What a form field is, decided once. RF-R4-4.
 *
 * `/FT` and `/V` are inheritable, so what a field is can depend on its
 * ancestors. The two helpers that resolved them — one in the facts reader, one
 * in the form reader — each answered `undefined` for a `/Parent` that cycled,
 * dangled or was not a dictionary: the same answer as "no ancestor declares
 * this". A signature field whose `/FT` lived on a parent nobody could reach
 * therefore read as a field with no type, its applied signature as no
 * signature, and a Merge carried it. Malformed ancestry had turned signature
 * evidence into its absence.
 *
 * So there is one resolver, and it ends COMPLETE or REFUSED; and the question
 * "is this a signature" looks at the value before it looks at the ancestry. A
 * `/V` that is a signature dictionary is a signature whatever its field's
 * ancestors say or fail to say.
 */
import { PDFDict, PDFName, PDFNull, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { MECHANISM_BOUNDS } from './policy';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

/**
 * An inheritable attribute, resolved up `/Parent`.
 *
 * `complete: true` with `value: undefined` means the whole chain was read and
 * nothing on it declares the key. Anything that stops the chain being read — a
 * cycle, a reference to nothing, a parent that is not a dictionary, a chain
 * deeper than the bound — is `complete: false`, because "an ancestor may
 * declare it and could not be read" is not "nobody declares it".
 */
export type InheritedRead =
    | { complete: true; value: unknown }
    | { complete: false; reason: string };

const lookupRef = (doc: PDFDocument, ref: PDFRef): { ok: true; value: unknown } | { ok: false; reason: string } => {
    let value: unknown;
    try {
        value = doc.context.lookup(ref);
    } catch (error) {
        return { ok: false, reason: `${ref.tag} could not be read: ${String((error as Error)?.message ?? error)}` };
    }
    if (value === undefined) return { ok: false, reason: `${ref.tag} is not in the document` };
    return { ok: true, value };
};

export function readInheritedField(doc: PDFDocument, field: PDFDict, key: string): InheritedRead {
    const seen = new Set<string>();
    let current: PDFDict = field;
    for (let depth = 0; ; depth += 1) {
        if (depth > MECHANISM_BOUNDS.maxInheritanceDepth) {
            return {
                complete: false,
                reason: `/Parent chain deeper than ${MECHANISM_BOUNDS.maxInheritanceDepth} while resolving /${key}`,
            };
        }
        const own = current.get(PDFName.of(key));
        // A null object is an absent one, so a null here defers to the parent.
        if (own !== undefined && own !== PDFNull) {
            if (!(own instanceof PDFRef)) return { complete: true, value: own };
            const read = lookupRef(doc, own);
            if (!read.ok) return { complete: false, reason: `/${key} ${read.reason}` };
            return { complete: true, value: read.value };
        }

        const parentRaw = current.get(PDFName.of('Parent'));
        if (parentRaw === undefined || parentRaw === PDFNull) return { complete: true, value: undefined };
        let parent: unknown = parentRaw;
        if (parentRaw instanceof PDFRef) {
            if (seen.has(parentRaw.tag)) {
                return { complete: false, reason: `/Parent chain cycles at ${parentRaw.tag} while resolving /${key}` };
            }
            seen.add(parentRaw.tag);
            const read = lookupRef(doc, parentRaw);
            if (!read.ok) return { complete: false, reason: `/Parent ${read.reason} while resolving /${key}` };
            parent = read.value;
        }
        if (!(parent instanceof PDFDict)) {
            return { complete: false, reason: `/Parent is not a dictionary while resolving /${key}` };
        }
        current = parent;
    }
}

/** The `/Type` values that say a dictionary is a signature value. */
export const SIGNATURE_VALUE_TYPES = ['/Sig', '/DocTimeStamp'];

/**
 * The signature evidence a dictionary carries, named. RF-R5-3.
 *
 * Said once, because it is asked twice: here, to decide what an applied
 * signature is, and by the artifact backstop, to decide that none survived. A
 * backstop narrower than the classifier it backs up is the detector-reach
 * mismatch three earlier rounds were spent on.
 *
 * `/Type /Sig` and `/Type /DocTimeStamp` say what the dictionary is wherever it
 * sits. `/ByteRange` is a signature's own and nothing else in a field value
 * carries it. `/Contents` is the signature's bytes — and also an ordinary key
 * on a page — so it is evidence only where the dictionary is a field's value,
 * which is the only place in a document a signature value can sit. A stream is
 * never a signature value.
 */
export function signatureEvidenceOf(
    value: unknown,
    context: { isFieldValue: boolean },
): string | null {
    if (!(value instanceof PDFDict)) return null;
    const type = nameOf(value.get(PDFName.of('Type')));
    if (SIGNATURE_VALUE_TYPES.includes(type)) return `/Type ${type}`;
    if (value.get(PDFName.of('ByteRange')) !== undefined) return '/ByteRange';
    if (context.isFieldValue && value.get(PDFName.of('Contents')) !== undefined) {
        return 'a field value carrying /Contents';
    }
    return null;
}

/** Whether a field's value is a signature, by what it holds. */
export function isSignatureValue(value: unknown): boolean {
    return signatureEvidenceOf(value, { isFieldValue: true }) !== null;
}

/**
 * What a terminal field or a widget is, as far as a safety decision goes.
 *
 * - `signature`: a signature field. `applied` when its value is a dictionary —
 *   the line M5 H7 drew — or when the value carries signature evidence of its
 *   own, whatever the declared type.
 * - `other`: anything else, with its field type (empty when none is declared
 *   anywhere on a chain that was read completely).
 * - `unreadable`: the type or the value could not be resolved and nothing on
 *   the field settles the question. A refusal: an unread chain may be hiding
 *   the signature.
 */
export type FieldClass =
    | { kind: 'signature'; applied: boolean }
    | { kind: 'other'; ft: string }
    | { kind: 'unreadable'; reason: string };

export function classifyField(doc: PDFDocument, field: PDFDict): FieldClass {
    const value = readInheritedField(doc, field, 'V');
    // Direct evidence first. A value that is a signature is one whatever its
    // ancestry reads as, or fails to read as.
    if (value.complete && isSignatureValue(value.value)) return { kind: 'signature', applied: true };

    const ft = readInheritedField(doc, field, 'FT');
    if (!ft.complete) return { kind: 'unreadable', reason: ft.reason };
    const type = nameOf(ft.value);
    if (type === '/Sig') {
        if (!value.complete) return { kind: 'unreadable', reason: value.reason };
        return { kind: 'signature', applied: value.value instanceof PDFDict };
    }
    if (!value.complete) return { kind: 'unreadable', reason: value.reason };
    return { kind: 'other', ft: type };
}
