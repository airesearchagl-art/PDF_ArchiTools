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
 * Adopted: H12 — no operation changes metadata silently.
 */
import { PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';

export interface DocumentMetadata {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
    creator?: string;
    producer?: string;
    creationDate?: Date;
    modificationDate?: Date;
    /** The raw XMP packet, copied byte for byte when one is present. */
    xmp: Uint8Array | null;
}

const text = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const s = String(value);
    return s.length > 0 ? s : undefined;
};

/** Read what the source carries, without altering it. */
export function readMetadata(doc: PDFDocument): DocumentMetadata {
    const meta: DocumentMetadata = { xmp: null };
    try { meta.title = text(doc.getTitle()); } catch { /* absent */ }
    try { meta.author = text(doc.getAuthor()); } catch { /* absent */ }
    try { meta.subject = text(doc.getSubject()); } catch { /* absent */ }
    try { meta.keywords = doc.getKeywords()?.split(/[,;\s]+/).filter(Boolean); } catch { /* absent */ }
    try { meta.creator = text(doc.getCreator()); } catch { /* absent */ }
    try { meta.producer = text(doc.getProducer()); } catch { /* absent */ }
    try { meta.creationDate = doc.getCreationDate(); } catch { /* absent */ }
    try { meta.modificationDate = doc.getModificationDate(); } catch { /* absent */ }

    try {
        const stream = doc.catalog.lookup(PDFName.of('Metadata'));
        if (stream instanceof PDFRawStream) meta.xmp = stream.getContents();
    } catch { /* no XMP, or unreadable — reported by the caller, never invented */ }

    return meta;
}

/**
 * Put it on a rebuilt document.
 *
 * The XMP packet is copied as bytes rather than regenerated: it can carry
 * fields this application does not model, and rewriting it from the Info
 * dictionary would silently drop them.
 */
export function applyMetadata(doc: PDFDocument, meta: DocumentMetadata): void {
    if (meta.title !== undefined) doc.setTitle(meta.title);
    if (meta.author !== undefined) doc.setAuthor(meta.author);
    if (meta.subject !== undefined) doc.setSubject(meta.subject);
    if (meta.keywords !== undefined && meta.keywords.length > 0) doc.setKeywords(meta.keywords);
    if (meta.creator !== undefined) doc.setCreator(meta.creator);
    if (meta.producer !== undefined) doc.setProducer(meta.producer);
    if (meta.creationDate !== undefined) doc.setCreationDate(meta.creationDate);
    if (meta.modificationDate !== undefined) doc.setModificationDate(meta.modificationDate);

    if (meta.xmp) {
        const stream = doc.context.stream(meta.xmp, { Type: 'Metadata', Subtype: 'XML' });
        doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    }
}

/**
 * What could not be carried, so the caller can report it instead of losing it
 * quietly. Empty when everything the source had is on the output.
 */
export function metadataGaps(source: DocumentMetadata, output: DocumentMetadata): string[] {
    const gaps: string[] = [];
    const pairs: [keyof DocumentMetadata, string][] = [
        ['title', 'タイトル'],
        ['author', '作成者'],
        ['subject', 'サブタイトル'],
        ['creator', 'アプリケーション'],
        ['creationDate', '作成日時'],
    ];
    for (const [key, label] of pairs) {
        if (source[key] !== undefined && output[key] === undefined) gaps.push(label);
    }
    if (source.xmp && !output.xmp) gaps.push('XMPメタデータ');
    return gaps;
}
