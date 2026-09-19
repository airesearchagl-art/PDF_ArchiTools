/**
 * The document-level structures M6 strips, carries or refuses, and the metadata
 * policy that decides what an output says about itself.
 *
 * Adopted: M6-H7 (Extract metadata), M6-H8 (Merge metadata), M6-H9a (tagging),
 * M6-H9d (attachments).
 *
 * The background fact all of this sits on: `copyPages` copies **no**
 * document-level structure. `/AcroForm`, `/Names`, `/Dests`, `/Outlines`,
 * `/PageLabels`, `/StructTreeRoot`, `/OCProperties`, `/Metadata` and
 * `/OpenAction` are either not implemented in pdf-lib 1.17.1 or never read by a
 * copy path — the library says so itself in the doc comment on
 * `PDFDocument.copy()`. So none of the dropped structure is a misuse of the
 * library; the product's mistake was presenting page copying as document
 * splitting and reporting success.
 */
import { PDFDict, PDFName, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { LossRecord, MergeMetadataPolicy } from './contracts';
import { pdfTextFromString, pdfTextObject, readPdfText } from './pdf-text';
import type { PdfText } from './pdf-text';

/**
 * Strip every tagging remnant, `/StructParents` included, and say so.
 * Adopted M6-H9a.
 *
 * Leaving `/StructParents` behind on a page whose `/StructTreeRoot` is gone
 * points a reader's accessibility machinery at a tree that no longer exists.
 * The loss is real and is disclosed rather than hidden: a structure tree cannot
 * be reconstructed for a subset of pages, and pretending otherwise would be the
 * silent loss this contract forbids.
 */
export function stripTagging(doc: PDFDocument): { stripped: boolean; pages: number } {
    let stripped = false;
    if (doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined) {
        doc.catalog.delete(PDFName.of('StructTreeRoot'));
        stripped = true;
    }
    if (doc.catalog.get(PDFName.of('MarkInfo')) !== undefined) {
        doc.catalog.delete(PDFName.of('MarkInfo'));
        stripped = true;
    }
    let pages = 0;
    for (const page of doc.getPages()) {
        if (page.node.get(PDFName.of('StructParents')) !== undefined) {
            page.node.delete(PDFName.of('StructParents'));
            pages += 1;
            stripped = true;
        }
    }
    return { stripped, pages };
}

/**
 * Retarget or drop `/OpenAction`.
 *
 * Nothing carries it across a copy, so the only question is whether the output
 * should have one at all. It is rebuilt when its target survived and reported
 * when it did not — the same rule the other destinations follow.
 */
export function dropOpenAction(doc: PDFDocument): boolean {
    if (doc.catalog.get(PDFName.of('OpenAction')) === undefined) return false;
    doc.catalog.delete(PDFName.of('OpenAction'));
    return true;
}

/** The trailer's Info dictionary, read as plain strings, for display. */
export function readInfo(doc: PDFDocument): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(readInfoTexts(doc))) out[key] = value.text;
    return out;
}

/**
 * The trailer's Info strings as text, bytes and token.
 *
 * What M1 carries into a merged output. Holding the token, not the decoded
 * text, is what lets it be written back as it was — the M1 path decoded with
 * pdf-lib, which reads a PDF 2.0 UTF-8 string as PDFDocEncoding, and wrote the
 * resulting mojibake through a setter. Plain values only: nothing here refers to
 * the source. A value whose text cannot be read is left out, and M1 then says
 * nothing rather than something false.
 */
export function readInfoTexts(doc: PDFDocument): Record<string, PdfText> {
    const out: Record<string, PdfText> = {};
    const infoRef = doc.context.trailerInfo.Info;
    const info = infoRef ? doc.context.lookup(infoRef) : undefined;
    if (!(info instanceof PDFDict)) return out;
    for (const [key, value] of info.entries()) {
        const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
        const read = readPdfText(resolved);
        if (read.ok) out[key.asString().replace(/^\//, '')] = read.value;
    }
    return out;
}

/** The output's Info dictionary, created if the output has none yet. */
function infoDictOf(out: PDFDocument): PDFDict {
    const ref = out.context.trailerInfo.Info;
    const existing = ref ? out.context.lookup(ref) : undefined;
    if (existing instanceof PDFDict) return existing;
    const created = out.context.obj({});
    out.context.trailerInfo.Info = out.context.register(created);
    return created;
}

/**
 * Merge metadata. Adopted M6-H8: M4 synthesized provenance by default, M1 —
 * the first source's metadata — available.
 *
 * A merged document is a new document, and the honest metadata for it is
 * metadata that says so. What happens today is none of the candidates: the
 * output carries pdf-lib's four keys, which is neutral metadata by accident and
 * without saying so.
 */
export function applyMergeMetadata(
    out: PDFDocument,
    policy: MergeMetadataPolicy,
    sources: { name: string; info: Record<string, PdfText> }[],
): void {
    if (policy === 'M1' && sources.length > 0) {
        // BLK-R4-1: the first source's strings, written back as they were.
        const first = sources[0];
        const info = infoDictOf(out);
        for (const key of ['Title', 'Author', 'Subject', 'Creator']) {
            const value = first.info[key];
            if (value && value.text) info.set(PDFName.of(key), pdfTextObject(value));
        }
        if (!(first.info.Title && first.info.Title.text)) {
            const fallback = pdfTextFromString(first.name);
            if (fallback.ok) info.set(PDFName.of('Title'), pdfTextObject(fallback.value));
        }
        return;
    }

    // M4 — provenance that names what the document was built from. The
    // filenames are the person's, so they go through the one text writer.
    const names = sources.map((s) => s.name);
    const info = infoDictOf(out);
    const entries: [string, string][] = [
        ['Title', `${names.length}件のPDFを統合`],
        ['Subject', `統合元: ${names.join(' / ')}`],
        ['Creator', 'PDF ArchiTools — PDF統合'],
        ['Keywords', names.join(' ')],
    ];
    for (const [key, text] of entries) {
        const encoded = pdfTextFromString(text);
        if (encoded.ok) info.set(PDFName.of(key), pdfTextObject(encoded.value));
    }
}

/**
 * One loss per distinct attachment label, each naming what is removed. RF-R4-6.
 *
 * A confirmation is only a confirmation of what it showed, so every attachment
 * is named — by its filename where the document gives one, by an explicit
 * unnamed label where it does not — and, for a Merge, together with the source
 * it belongs to. Two attachments with the same label stay two: the count is
 * part of the name rather than lost to a de-duplication.
 */
export function attachmentLosses(
    labels: string[],
    why: string,
    source?: string,
): LossRecord[] {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return [...counts.entries()].map(([label, count]) => {
        const named = count > 1 ? `${label} ×${count}` : label;
        return { kind: 'attachments', what: source ? `${source} — ${named}` : named, why };
    });
}

/**
 * Losses this document will take, listed from the facts so a vector-only
 * drawing is never asked to consent to losing form fields it never had.
 */
export function describeStructuralLosses(facts: {
    hasStructTree: boolean;
    pagesWithStructParents: number[];
    hasAttachments: boolean;
    attachmentNames: string[];
    hasAppliedSignature: boolean;
    appliedSignatureFieldNames: string[];
}): LossRecord[] {
    const losses: LossRecord[] = [];
    if (facts.hasStructTree || facts.pagesWithStructParents.length > 0) {
        losses.push({
            kind: 'tagging',
            why: 'タグ構造は選択したページ分だけを再構成できないため、すべて削除します。'
                + 'スクリーンリーダーでの読み上げ順などが失われます。',
        });
    }
    if (facts.hasAttachments) {
        const why = '添付ファイルは引き継がれません。';
        const named = attachmentLosses(facts.attachmentNames, why);
        losses.push(...(named.length > 0 ? named : [{ kind: 'attachments' as const, why }]));
    }
    if (facts.hasAppliedSignature) {
        losses.push({
            kind: 'applied-signature',
            what: facts.appliedSignatureFieldNames.join(', ') || undefined,
            why: '抽出後のPDFは新しい別の文書になるため、元の電子署名は有効になりません。'
                + '署名欄と見た目も削除します。',
        });
    }
    return losses;
}

/** A page label range, read only so its absence can be reported honestly. */
export function hasPageLabels(doc: PDFDocument): boolean {
    return doc.catalog.get(PDFName.of('PageLabels')) !== undefined;
}

/** An outline tree, read only so its absence can be reported honestly. */
export function hasOutlines(doc: PDFDocument): boolean {
    return doc.catalog.get(PDFName.of('Outlines')) !== undefined;
}

/** Whether the source carries an XMP packet, so its absence can be detected. */
export function hasXmpMetadata(doc: PDFDocument): boolean {
    return doc.catalog.get(PDFName.of('Metadata')) !== undefined;
}
