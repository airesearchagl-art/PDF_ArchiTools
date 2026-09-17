/**
 * What the artifact actually holds, measured by reopening the bytes.
 *
 * Every number here answers a claim the run would otherwise be making about
 * itself. A sanitizer that reports what it removed is describing its own
 * intent; the counts that matter are taken from the file afterwards.
 *
 * This is the step that would have caught each of the defects M6 exists to fix —
 * and, after the Independent Review, the step that had to get stricter, because
 * three of them reported zero while the thing was in the bytes:
 *
 *   - a JavaScript action held as a **direct** dictionary inside a detached
 *     object, which a top-level `/S` check never sees;
 *   - a page `/FileAttachment` annotation and the payload stream it reached,
 *     both detached and both serialized;
 *   - a source-page reference surviving on a route that is not `/Dest`.
 *
 * So the counts below are taken by walking the artifact, not by asking the code
 * that produced it.
 */
import { PDFDocument } from 'pdf-lib';
import type { ReadbackFacts } from './contracts';
import { countSourcePageReferences, measureDestinationInvariants } from './destinations';
import { scanJavaScript } from './javascript';
import { countOrphanWidgets } from './forms';
import {
    censusAttachments,
    censusTagging,
    countArtifactWideJavaScript,
    countUnreachable,
} from './prune';

/**
 * Reopen an artifact and measure it.
 *
 * `updateMetadata: false` matters even here: loading with pdf-lib's default
 * would rewrite `/Producer` and `/ModDate` on the document being inspected,
 * which is a measurement that changes what it measures.
 */
export async function readbackArtifact(bytes: Uint8Array): Promise<ReadbackFacts> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const destinations = measureDestinationInvariants(doc);
    const reachable = scanJavaScript(doc);
    const attachments = censusAttachments(doc);
    const tagging = censusTagging(doc);
    return {
        pageCount: doc.getPageCount(),
        orphanPageCount: destinations.orphanPageCount,
        danglingDestinations: destinations.danglingDestinations,
        sourcePageReferences: countSourcePageReferences(doc),
        reachableJavaScript: reachable.count,
        artifactWideJavaScript: countArtifactWideJavaScript(doc),
        orphanWidgets: countOrphanWidgets(doc),
        fileAttachmentAnnots: attachments.fileAttachmentAnnots,
        filespecsWithEF: attachments.filespecsWithEF,
        embeddedFileStreams: attachments.embeddedFileStreams,
        taggingRemnants: tagging.total,
        unreachableObjects: countUnreachable(doc),
        complete: reachable.complete,
    };
}

/** One invariant that did not hold, named so a refusal can say which. */
export interface InvariantBreach {
    invariant: string;
    value: number;
    reason: string;
}

/**
 * The invariants every successful M6 artifact holds.
 *
 * `orphanPageCount === 0` is the adopted production contract (M6-H5), and the
 * thing it prevents is shipping the content of pages the user did not select.
 * The rest follow the same rule: a count that should be zero is checked on the
 * bytes, not assumed from the code path that produced them.
 */
export function checkArtifactInvariants(
    facts: ReadbackFacts,
    expectedPages: number,
): InvariantBreach | null {
    if (!facts.complete) {
        return {
            invariant: 'readback completes',
            value: 0,
            reason: '書き出したPDFを完全に検査できませんでした。',
        };
    }
    if (facts.pageCount !== expectedPages) {
        return {
            invariant: 'pageCount',
            value: facts.pageCount,
            reason: `書き出したPDFのページ数が想定と異なります（${facts.pageCount} / 想定 ${expectedPages}）。`,
        };
    }
    if (facts.orphanPageCount !== 0) {
        return {
            invariant: 'orphanPageCount === 0',
            value: facts.orphanPageCount,
            reason: `書き出したPDFに、選択していないページの実体が ${facts.orphanPageCount} 件残っていました。`,
        };
    }
    if (facts.danglingDestinations !== 0) {
        return {
            invariant: 'every surviving destination targets the output page tree',
            value: facts.danglingDestinations,
            reason: `書き出したPDFに、どこにも到達しないリンクが ${facts.danglingDestinations} 件残っていました。`,
        };
    }
    if (facts.sourcePageReferences !== 0) {
        return {
            invariant: 'sourcePageReferences === 0',
            value: facts.sourcePageReferences,
            reason: `書き出したPDFに、元のPDFのページを指す参照が ${facts.sourcePageReferences} 件残っていました。`,
        };
    }
    if (facts.reachableJavaScript !== 0) {
        return {
            invariant: 'reachableJavaScript === 0',
            value: facts.reachableJavaScript,
            reason: `書き出したPDFにJavaScriptが ${facts.reachableJavaScript} 件残っていました。`,
        };
    }
    if (facts.artifactWideJavaScript !== 0) {
        return {
            invariant: 'artifactWideJavaScript === 0',
            value: facts.artifactWideJavaScript,
            reason: `書き出したPDFのオブジェクト表にJavaScriptが ${facts.artifactWideJavaScript} 件残っていました。`,
        };
    }
    if (facts.orphanWidgets !== 0) {
        return {
            invariant: 'orphanWidgets === 0',
            value: facts.orphanWidgets,
            reason: `書き出したPDFに、どのフィールドにも属さない入力欄が ${facts.orphanWidgets} 件残っていました。`,
        };
    }
    if (facts.fileAttachmentAnnots !== 0
        || facts.filespecsWithEF !== 0
        || facts.embeddedFileStreams !== 0) {
        const total = facts.fileAttachmentAnnots + facts.filespecsWithEF + facts.embeddedFileStreams;
        return {
            invariant: 'no attachment payload survives',
            value: total,
            reason: `書き出したPDFに添付ファイルの実体が残っていました`
                + `（注釈 ${facts.fileAttachmentAnnots} / 指定 ${facts.filespecsWithEF} / 本体 ${facts.embeddedFileStreams}）。`,
        };
    }
    if (facts.taggingRemnants !== 0) {
        return {
            invariant: 'taggingRemnants === 0',
            value: facts.taggingRemnants,
            reason: `書き出したPDFにタグ構造の残骸が ${facts.taggingRemnants} 件残っていました。`,
        };
    }
    if (facts.unreachableObjects !== 0) {
        return {
            invariant: 'unreachableObjects === 0',
            value: facts.unreachableObjects,
            reason: `書き出したPDFに、どこからも参照されないオブジェクトが ${facts.unreachableObjects} 件残っていました。`,
        };
    }
    return null;
}
