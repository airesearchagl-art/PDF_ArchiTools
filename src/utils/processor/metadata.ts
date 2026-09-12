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
 * Two things this module deliberately does *not* do:
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
 *
 * Adopted: H12 — no operation changes metadata silently.
 */
import { PDFDict, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';

export interface DocumentMetadata {
    /** Every Info entry, by key, exactly as the source held it. */
    info: { key: string; value: PDFObject }[];
    /** The `/Metadata` stream itself, not its bytes. */
    xmp: PDFRawStream | null;
    /** Present when the source had a `/Metadata` entry we could not read. */
    xmpError: string | null;
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

/** Read what the source carries, without altering it. */
export function readMetadata(doc: PDFDocument): DocumentMetadata {
    const meta: DocumentMetadata = { info: [], xmp: null, xmpError: null };

    const info = infoDictOf(doc);
    if (info) {
        for (const [key, value] of info.entries()) {
            meta.info.push({ key: key.asString(), value });
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
 * Put it on a rebuilt document.
 *
 * Entries are cloned into the target's context — an object still owned by the
 * source document would serialise as a dangling reference — and the XMP stream
 * is cloned whole, dictionary included, so `/Filter`, `/Length` and anything
 * else it carries stay with the bytes they describe.
 */
export function applyMetadata(doc: PDFDocument, meta: DocumentMetadata): void {
    if (meta.info.length > 0) {
        const target = doc.context.obj({});
        for (const { key, value } of meta.info) {
            try {
                target.set(PDFName.of(key.replace(/^\//, '')), value.clone(doc.context));
            } catch {
                // One unclonable entry must not cost the document the rest of
                // its metadata; `metadataGaps` reports what did not arrive.
            }
        }
        doc.context.trailerInfo.Info = doc.context.register(target);
    }

    if (meta.xmp) {
        try {
            doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta.xmp.clone(doc.context)));
        } catch {
            // Same: reported rather than pretended.
        }
    }
}

/**
 * What could not be carried, so the caller can report it instead of losing it
 * quietly. Empty when everything the source had is on the output.
 */
export function metadataGaps(source: DocumentMetadata, output: DocumentMetadata): string[] {
    const gaps: string[] = [];
    const have = new Set(output.info.map((e) => e.key));
    for (const { key } of source.info) {
        if (!have.has(key)) gaps.push(key);
    }
    if (source.xmp && !output.xmp) gaps.push('/Metadata (XMP)');
    return gaps;
}
