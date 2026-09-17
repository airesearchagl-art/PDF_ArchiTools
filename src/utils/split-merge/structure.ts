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
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { LossRecord, MergeMetadataPolicy } from './contracts';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

const textOf = (v: unknown): string | null => {
    const decode = (v as { decodeText?: () => string } | null)?.decodeText;
    return typeof decode === 'function' ? decode.call(v) : null;
};

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
 * Remove embedded files. Adopted M6-H9d for Extract, with explicit confirmation
 * naming the files.
 *
 * Both routes are taken: the catalog's `/Names /EmbeddedFiles` tree, and any
 * `/Filespec` carrying an `/EF` wherever it sits. A detector that checked only
 * the name tree would miss a file attachment annotation.
 */
export function removeAttachments(doc: PDFDocument): { removed: number; names: string[] } {
    const names: string[] = [];
    let removed = 0;

    const namesDict = doc.catalog.lookup(PDFName.of('Names'));
    if (namesDict instanceof PDFDict && namesDict.get(PDFName.of('EmbeddedFiles')) !== undefined) {
        const embedded = namesDict.lookup(PDFName.of('EmbeddedFiles'));
        if (embedded instanceof PDFDict) {
            const list = embedded.lookup(PDFName.of('Names'));
            if (list instanceof PDFArray) {
                for (let i = 0; i + 1 < list.size(); i += 2) {
                    const label = textOf(doc.context.lookup(list.get(i)));
                    if (label) names.push(label);
                }
            }
        }
        namesDict.delete(PDFName.of('EmbeddedFiles'));
        removed += 1;
    }

    const doomed: PDFRef[] = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('Type'))) !== '/Filespec') continue;
        if (obj.get(PDFName.of('EF')) === undefined) continue;
        const label = textOf(doc.context.lookup(obj.get(PDFName.of('F')) as never))
            ?? textOf(doc.context.lookup(obj.get(PDFName.of('UF')) as never));
        if (label && !names.includes(label)) names.push(label);
        doomed.push(ref);
    }

    // Detach the annotations that point at them first, so the artifact does not
    // keep a `/FileAttachment` whose target is gone.
    for (const page of doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = annots.size() - 1; i >= 0; i -= 1) {
            const annot = doc.context.lookup(annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/FileAttachment') continue;
            annots.remove(i);
            removed += 1;
        }
    }

    for (const ref of doomed) {
        doc.context.delete(ref);
        removed += 1;
    }

    return { removed, names };
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

/** The trailer's Info dictionary, read as plain strings. */
export function readInfo(doc: PDFDocument): Record<string, string> {
    const out: Record<string, string> = {};
    const infoRef = doc.context.trailerInfo.Info;
    const info = infoRef ? doc.context.lookup(infoRef) : undefined;
    if (!(info instanceof PDFDict)) return out;
    for (const [key, value] of info.entries()) {
        const text = textOf(doc.context.lookup(value)) ?? textOf(value);
        if (text !== null) out[key.asString().replace(/^\//, '')] = text;
    }
    return out;
}

/**
 * Metadata that is *chosen*, not defaulted.
 *
 * pdf-lib overwrites `/Producer` and `/ModDate` on every `load` and `create`
 * unless `updateMetadata: false` is passed, and production passed neither —
 * which is why every Extract and Merge output carried exactly pdf-lib's four
 * keys and nothing of the source's. Every `load` and `create` in this module
 * passes `updateMetadata: false`, and the policy below is then applied
 * deliberately.
 */
export function applyExtractMetadata(
    out: PDFDocument,
    sourceInfo: Record<string, string>,
    sourceName: string,
): { carried: string[]; dropped: string[] } {
    const carried: string[] = [];
    const dropped: string[] = [];

    const setters: Record<string, (v: string) => void> = {
        Title: (v) => out.setTitle(v),
        Author: (v) => out.setAuthor(v),
        Subject: (v) => out.setSubject(v),
        Keywords: (v) => out.setKeywords(v.split(/[,\s]+/).filter(Boolean)),
        Creator: (v) => out.setCreator(v),
    };

    for (const [key, value] of Object.entries(sourceInfo)) {
        const setter = setters[key];
        if (setter && value) {
            setter(value);
            carried.push(key);
        } else if (!setter) {
            dropped.push(key);
        }
    }

    if (!sourceInfo.Title) {
        out.setTitle(sourceName);
        carried.push('Title');
    }
    return { carried, dropped };
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
    sources: { name: string; info: Record<string, string> }[],
): void {
    if (policy === 'M1' && sources.length > 0) {
        const first = sources[0];
        if (first.info.Title) out.setTitle(first.info.Title);
        else out.setTitle(first.name);
        if (first.info.Author) out.setAuthor(first.info.Author);
        if (first.info.Subject) out.setSubject(first.info.Subject);
        if (first.info.Creator) out.setCreator(first.info.Creator);
        return;
    }

    // M4 — provenance that names what the document was built from.
    const names = sources.map((s) => s.name);
    out.setTitle(`${names.length}件のPDFを統合`);
    out.setSubject(`統合元: ${names.join(' / ')}`);
    out.setCreator('PDF ArchiTools — PDF統合');
    out.setKeywords(names);
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
        losses.push({
            kind: 'attachments',
            what: facts.attachmentNames.join(', ') || undefined,
            why: '添付ファイルは引き継がれません。',
        });
    }
    if (facts.hasAppliedSignature) {
        losses.push({
            kind: 'applied-signature',
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

/** Write a marker a gate can read back, without changing what a reader sees. */
export function markProvisionalPolicy(out: PDFDocument, origin: string): void {
    const info = out.context.trailerInfo.Info;
    const dict = info ? out.context.lookup(info) : undefined;
    if (dict instanceof PDFDict) {
        dict.set(PDFName.of('M6PolicyOrigin'), PDFString.of(origin));
    }
}
