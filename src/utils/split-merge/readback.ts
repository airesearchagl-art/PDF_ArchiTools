/**
 * What the artifact actually holds, measured by reopening the bytes.
 *
 * Every number here answers a claim the run would otherwise be making about
 * itself. A sanitizer that reports what it removed is describing its own
 * intent; the counts that matter are taken from the file afterwards.
 *
 * Each artifact-wide census runs on the shared complete-or-refuse primitive, so
 * the numbers below are either a measurement of the whole artifact or a typed
 * refusal. There is no state in which a scan gives up and the count reads zero —
 * which is what a bounded scanner did, three times, while the thing it was
 * looking for was in the bytes.
 */
import { PDFDocument } from 'pdf-lib';
import type { ReadbackFacts } from './contracts';
import { countSourcePageReferences, measureDestinationInvariants } from './destinations';
import { scanJavaScript } from './javascript';
import { countOrphanWidgets } from './forms';
import {
    censusAttachments,
    censusJavaScript,
    censusSignatures,
    censusTagging,
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

    const js = censusJavaScript(doc);
    const attachments = censusAttachments(doc);
    const tagging = censusTagging(doc);
    const signatures = censusSignatures(doc);

    const refusals = [js, attachments, tagging, signatures]
        .filter((c) => !c.complete)
        .map((c) => (c as { reason: string }).reason);

    /**
     * When any census refused, the counts it would have produced are not
     * reported as zero. They are reported as the artifact's own numbers where
     * another complete census supplied them, and `censusComplete` is false —
     * which `checkArtifactInvariants` turns into a refusal before anything else
     * is considered.
     */
    return {
        pageCount: doc.getPageCount(),
        orphanPageCount: destinations.orphanPageCount,
        danglingDestinations: destinations.danglingDestinations,
        sourcePageReferences: countSourcePageReferences(doc),
        reachableJavaScript: reachable.count,
        artifactWideJavaScript: js.complete ? js.value.length : Number.NaN,
        orphanWidgets: countOrphanWidgets(doc),
        fileAttachmentAnnots: attachments.complete ? attachments.value.fileAttachmentAnnots : Number.NaN,
        filespecsWithEF: attachments.complete ? attachments.value.efCarriers : Number.NaN,
        embeddedFileStreams: attachments.complete ? attachments.value.payloadStreams : Number.NaN,
        taggingRemnants: tagging.complete ? tagging.value.total : Number.NaN,
        signatureRemnants: signatures.complete ? signatures.value : Number.NaN,
        unreachableObjects: countUnreachable(doc),
        complete: reachable.complete,
        censusComplete: refusals.length === 0,
        censusRefusal: refusals.length > 0 ? refusals.join('; ') : undefined,
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
 *
 * Census completeness is checked **first**. A zero that came out of an
 * incomplete scan would satisfy every check below it.
 */
export function checkArtifactInvariants(
    facts: ReadbackFacts,
    expectedPages: number,
): InvariantBreach | null {
    if (!facts.censusComplete) {
        return {
            invariant: 'every artifact census is complete',
            value: 0,
            reason: '書き出したPDFを完全に検査できたことを確認できませんでした'
                + `（${facts.censusRefusal ?? '理由不明'}）。`,
        };
    }
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
            reason: '書き出したPDFに添付ファイルの実体が残っていました'
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
    if (facts.signatureRemnants !== 0) {
        // RF-R4-4: a derivative that still carries a signature field, value or
        // byte range presents itself as signed. None may.
        return {
            invariant: 'signatureRemnants === 0',
            value: facts.signatureRemnants,
            reason: `書き出したPDFに電子署名の要素が ${facts.signatureRemnants} 件残っていました。`,
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
