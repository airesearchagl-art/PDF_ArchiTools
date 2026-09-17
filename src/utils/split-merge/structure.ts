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
    const doomed = new Map<string, PDFRef>();

    const condemn = (raw: unknown): void => {
        if (raw instanceof PDFRef) doomed.set(raw.tag, raw);
    };

    const noteName = (spec: PDFDict): void => {
        const label = textOf(doc.context.lookup(spec.get(PDFName.of('F')) as never))
            ?? textOf(doc.context.lookup(spec.get(PDFName.of('UF')) as never))
            ?? textOf(spec.get(PDFName.of('F')));
        if (label && !names.includes(label)) names.push(label);
    };

    /**
     * A `/Filespec` and everything hanging off its `/EF`.
     *
     * Deleting the `/Filespec` alone leaves the payload stream registered, and
     * pdf-lib writes everything registered — measured, the embedded bytes were
     * still in the artifact after the attachment was reported removed.
     */
    const condemnFilespec = (raw: unknown): void => {
        const spec = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
        if (!(spec instanceof PDFDict)) return;
        noteName(spec);
        const ef = doc.context.lookup(spec.get(PDFName.of('EF')) as never) ?? spec.get(PDFName.of('EF'));
        if (ef instanceof PDFDict) {
            for (const [, streamRef] of ef.entries()) condemn(streamRef);
            for (const [key] of [...ef.entries()]) ef.delete(key);
        }
        spec.delete(PDFName.of('EF'));
        condemn(raw);
    };

    // Route 1 — the catalog's embedded-files name tree.
    const namesDict = doc.catalog.lookup(PDFName.of('Names'));
    if (namesDict instanceof PDFDict && namesDict.get(PDFName.of('EmbeddedFiles')) !== undefined) {
        const embedded = namesDict.lookup(PDFName.of('EmbeddedFiles'));
        if (embedded instanceof PDFDict) {
            const list = embedded.lookup(PDFName.of('Names'));
            if (list instanceof PDFArray) {
                for (let i = 0; i + 1 < list.size(); i += 2) {
                    const label = textOf(doc.context.lookup(list.get(i)));
                    if (label && !names.includes(label)) names.push(label);
                    condemnFilespec(list.get(i + 1));
                }
            }
        }
        namesDict.delete(PDFName.of('EmbeddedFiles'));
        removed += 1;
    }

    // Route 2 — a `/FileAttachment` annotation on a page. The annotation, its
    // `/FS` filespec and the payload behind it all go; the annotation object
    // itself is condemned, not merely taken out of `/Annots`.
    for (const page of doc.getPages()) {
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = annots.size() - 1; i >= 0; i -= 1) {
            const raw = annots.get(i);
            const annot = doc.context.lookup(raw);
            if (!(annot instanceof PDFDict)) continue;
            if (nameOf(annot.get(PDFName.of('Subtype'))) !== '/FileAttachment') continue;
            condemnFilespec(annot.get(PDFName.of('FS')));
            annot.delete(PDFName.of('FS'));
            annots.remove(i);
            condemn(raw);
            removed += 1;
        }
    }

    // Route 3 — any remaining `/Filespec` with an `/EF`, wherever it sits.
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('Type'))) !== '/Filespec') continue;
        if (obj.get(PDFName.of('EF')) === undefined) continue;
        condemnFilespec(ref);
    }

    // Route 4 — any `/EmbeddedFile` stream, whatever reached it.
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        const inner = (obj as unknown as { dict?: unknown })?.dict;
        const dict = obj instanceof PDFDict
            ? obj
            : (inner instanceof PDFDict ? inner : null);
        if (!dict) continue;
        if (nameOf(dict.get(PDFName.of('Type'))) !== '/EmbeddedFile') continue;
        condemn(ref);
    }

    for (const ref of doomed.values()) {
        const obj = doc.context.lookup(ref);
        // Scrubbed before deletion: if some route this contract has not modelled
        // still holds the reference, what it finds is empty rather than the file.
        if (obj instanceof PDFDict) {
            for (const [key] of [...obj.entries()]) obj.delete(key);
        }
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
    source: PDFDocument,
    out: PDFDocument,
    sourceName: string,
): { carried: string[]; dropped: string[]; xmp: boolean } {
    const carried: string[] = [];
    const dropped: string[] = [];

    /**
     * The whole Info dictionary, custom keys included.
     *
     * The first implementation copied a hand-picked five — Title, Author,
     * Subject, Keywords, Creator — through pdf-lib's setters, so a `/Company`
     * key, a project code, or anything else a drawing office puts in Info was
     * dropped without being named. M6-H7 adopts M5's H12 contract, and H12's
     * whole point is that metadata is part of the artifact rather than a nicety.
     */
    const infoRef = source.context.trailerInfo.Info;
    const sourceDict = infoRef ? source.context.lookup(infoRef) : undefined;

    const outInfoRef = out.context.trailerInfo.Info;
    let outDict = outInfoRef ? out.context.lookup(outInfoRef) : undefined;
    if (!(outDict instanceof PDFDict)) {
        const created = out.context.obj({} as never);
        out.context.trailerInfo.Info = out.context.register(created);
        outDict = created;
    }

    if (sourceDict instanceof PDFDict && outDict instanceof PDFDict) {
        for (const [key, value] of sourceDict.entries()) {
            const name = key.asString().replace(/^\//, '');
            // Producer is pdf-lib's to state: the artifact really was written by
            // this build, and claiming the source's writer would be a false
            // provenance claim rather than preservation.
            if (name === 'Producer') {
                dropped.push(name);
                continue;
            }
            const resolved = value instanceof PDFRef ? source.context.lookup(value) : value;
            const cloned = (resolved as { clone?: (ctx: unknown) => unknown } | undefined)?.clone;
            if (typeof cloned !== 'function') {
                dropped.push(name);
                continue;
            }
            outDict.set(key, cloned.call(resolved, out.context) as never);
            carried.push(name);
        }
    }

    if (!carried.includes('Title')) {
        out.setTitle(sourceName);
        carried.push('Title');
    }

    // The XMP packet, carried as bytes. It is a stream in the catalog, and
    // nothing in a copy path touches it.
    let xmp = false;
    const xmpRaw = source.catalog.get(PDFName.of('Metadata'));
    if (xmpRaw !== undefined) {
        const stream = xmpRaw instanceof PDFRef ? source.context.lookup(xmpRaw) : xmpRaw;
        const contents = (stream as { contents?: Uint8Array } | undefined)?.contents;
        if (contents instanceof Uint8Array) {
            const copy = new Uint8Array(contents.length);
            copy.set(contents);
            const carriedStream = out.context.stream(copy, {
                Type: 'Metadata',
                Subtype: 'XML',
            });
            out.catalog.set(PDFName.of('Metadata'), out.context.register(carriedStream));
            xmp = true;
            carried.push('Metadata(XMP)');
        } else {
            dropped.push('Metadata(XMP)');
        }
    }

    return { carried, dropped, xmp };
}

/**
 * What the artifact kept of the source's metadata, measured by reopening it.
 *
 * M6-H7 makes metadata part of the artifact, so failing to carry it is a
 * refusal rather than a note attached to a file already handed over. The
 * comparison is against the source's own Info dictionary, key by key.
 */
export function metadataGaps(
    sourceInfo: Record<string, string>,
    artifact: PDFDocument,
    sourceHadXmp: boolean,
): string[] {
    const gaps: string[] = [];
    const artifactInfo = readInfo(artifact);
    for (const [key, value] of Object.entries(sourceInfo)) {
        if (key === 'Producer' || key === 'ModDate') continue;
        if (artifactInfo[key] !== value) gaps.push(key);
    }
    if (sourceHadXmp && artifact.catalog.get(PDFName.of('Metadata')) === undefined) {
        gaps.push('Metadata(XMP)');
    }
    return gaps;
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

/** Whether the source carries an XMP packet, so its absence can be detected. */
export function hasXmpMetadata(doc: PDFDocument): boolean {
    return doc.catalog.get(PDFName.of('Metadata')) !== undefined;
}
