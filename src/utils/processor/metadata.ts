/**
 * Metadata, carried rather than quietly dropped.
 *
 * Two measured behaviours are being corrected here. `PDFDocument.load` defaults
 * to `updateMetadata: true`, so merely loading a document rewrites its Producer
 * and ModDate — every operation did that, including the ones that change
 * nothing else. And the operations that build a new document (the flattening
 * ones) started from an empty one, so Title, Author, Subject, Keywords, the
 * dates and the XMP stream were all gone from the output, with nothing saying so.
 *
 * Three things this module deliberately does *not* do:
 *
 *  - it does not rebuild the Info dictionary from the handful of keys pdf-lib
 *    has getters for. A document may carry `/Company`, `/SourceModified` or any
 *    other private key, and reconstructing "the standard ones" is how those are
 *    lost. Every entry is copied.
 *  - it does not copy a `/Metadata` stream's **bytes** into a fresh stream. The
 *    bytes are the *stored* ones: if the source XMP is `/Filter /FlateDecode`,
 *    writing them into an unfiltered stream produces a document whose XMP is
 *    compressed data claiming to be XML. The stream is cloned with its
 *    dictionary instead, so the filter travels with the payload.
 *  - it does not swallow what it could not carry. An Info value held by
 *    reference is resolved and copied rather than cloned as a bare `PDFRef`,
 *    which would have written `42 0 R` into a document with no object 42; a
 *    value that cannot be copied safely, a missing referent and an unreadable
 *    `/Metadata` are all **reported**, and the caller turns them into a refusal.
 *    A document that quietly comes back without its metadata is the failure
 *    this module exists to prevent, and a silent partial copy is that failure
 *    wearing a success label.
 *
 * Adopted: H12 — no operation changes metadata silently.
 */
import {
    PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFString,
} from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';

export interface InfoEntry {
    key: string;
    /** Always the resolved object, never a `PDFRef`. */
    value: PDFObject;
    /** Whether the source held it indirectly, so the copy can keep that shape. */
    indirect: boolean;
}

export interface DocumentMetadata {
    /** Every Info entry, by key, exactly as the source held it. */
    info: InfoEntry[];
    /** The `/Metadata` stream itself, not its bytes. */
    xmp: PDFRawStream | null;
    /** Present when the source had a `/Metadata` entry we could not read. */
    xmpError: string | null;
    /** Info entries the source had and this reader could not take. */
    infoErrors: string[];
}

const infoDictOf = (doc: PDFDocument): PDFDict | null => {
    try {
        const info = doc.context.trailerInfo?.Info;
        if (info === undefined) return null;
        const resolved = info instanceof PDFRef ? doc.context.lookup(info) : info;
        return resolved instanceof PDFDict ? resolved : null;
    } catch {
        return null;
    }
};

/**
 * Which Info values can be moved into another document by copying them.
 *
 * A scalar carries its whole meaning in itself. A dictionary, an array or a
 * stream may reference objects that live in the source document, and pdf-lib's
 * `clone` copies the reference rather than the referent — so the copy would
 * point at an object number the new file does not have. Rather than write that
 * and call it preserved, such a value is reported and the operation refuses.
 */
const isCopyableValue = (value: PDFObject): boolean => (
    // `PDFNull` is exported as the singleton the parser produces, not as a
    // class, so it is compared by identity. `instanceof` against it is a type
    // error and a runtime one — which is how this line was first written, and
    // how the gate found it.
    value === PDFNull
    || value instanceof PDFString
    || value instanceof PDFHexString
    || value instanceof PDFName
    || value instanceof PDFNumber
    || value instanceof PDFBool
);

/** Read what the source carries, without altering it. */
export function readMetadata(doc: PDFDocument): DocumentMetadata {
    const meta: DocumentMetadata = { info: [], xmp: null, xmpError: null, infoErrors: [] };

    const info = infoDictOf(doc);
    if (info) {
        for (const [key, raw] of info.entries()) {
            const name = key.asString();
            const indirect = raw instanceof PDFRef;
            let value: PDFObject | undefined = raw;
            if (indirect) {
                try {
                    value = doc.context.lookup(raw) as PDFObject | undefined;
                } catch (error) {
                    value = undefined;
                    meta.infoErrors.push(`${name}（参照先を読み取れません: ${String((error as Error)?.message ?? error)}）`);
                    continue;
                }
                if (value === undefined) {
                    meta.infoErrors.push(`${name}（参照先のオブジェクトが存在しません）`);
                    continue;
                }
            }
            if (!value || !isCopyableValue(value)) {
                meta.infoErrors.push(`${name}（この種類の値は安全に複製できません）`);
                continue;
            }
            meta.info.push({ key: name, value, indirect });
        }
    }

    try {
        const raw = doc.catalog.get(PDFName.of('Metadata'));
        if (raw !== undefined) {
            const stream = doc.catalog.lookup(PDFName.of('Metadata'));
            if (stream instanceof PDFRawStream) meta.xmp = stream;
            else meta.xmpError = '/Metadata is not a stream';
        }
    } catch (error) {
        meta.xmpError = String((error as Error)?.message ?? error);
    }

    return meta;
}

/**
 * Put it on a rebuilt document, and say what did not fit.
 *
 * Entries are cloned into the target's context — an object still owned by the
 * source document would serialise as a dangling reference — and the XMP stream
 * is cloned whole, dictionary included, so `/Filter`, `/Length` and anything
 * else it carries stay with the bytes they describe. An entry the source held
 * indirectly is registered in the new document and referenced, so the shape as
 * well as the value survives.
 *
 * The return value is the list of problems, and it is not advisory: the caller
 * refuses on a non-empty list rather than returning a document that lost part
 * of what it was given.
 */
export function applyMetadata(doc: PDFDocument, meta: DocumentMetadata): string[] {
    const problems: string[] = [...meta.infoErrors];
    if (meta.xmpError) problems.push(`/Metadata（${meta.xmpError}）`);

    if (meta.info.length > 0) {
        const target = doc.context.obj({});
        for (const { key, value, indirect } of meta.info) {
            try {
                const copy = value.clone(doc.context);
                target.set(
                    PDFName.of(key.replace(/^\//, '')),
                    indirect ? doc.context.register(copy) : copy,
                );
            } catch (error) {
                problems.push(`${key}（複製に失敗: ${String((error as Error)?.message ?? error)}）`);
            }
        }
        doc.context.trailerInfo.Info = doc.context.register(target);
    }

    if (meta.xmp) {
        try {
            doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta.xmp.clone(doc.context)));
        } catch (error) {
            problems.push(`/Metadata（複製に失敗: ${String((error as Error)?.message ?? error)}）`);
        }
    }

    return problems;
}

/**
 * What could not be carried, so the caller can report it instead of losing it
 * quietly. Empty when everything the source had is on the output.
 */
export function metadataGaps(source: DocumentMetadata, output: DocumentMetadata): string[] {
    const gaps: string[] = [];
    const have = new Map(output.info.map((e) => [e.key, e.value]));
    for (const { key, value } of source.info) {
        if (!have.has(key)) {
            gaps.push(key);
            continue;
        }
        // Present is not the same as preserved: a value that arrived as
        // something else is a loss that a key-only comparison calls a success.
        const before = String((value as { asString?: () => string }).asString?.() ?? value);
        const after = String((have.get(key) as { asString?: () => string })?.asString?.() ?? have.get(key));
        if (before !== after) gaps.push(`${key}（値が変わりました）`);
    }
    if (source.xmp && !output.xmp) gaps.push('/Metadata (XMP)');
    return gaps;
}
