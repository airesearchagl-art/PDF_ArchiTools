/**
 * B2: an explicit partial batch.
 *
 * The old behaviour was the quiet kind of wrong. A batch where two of five
 * files failed produced a ZIP of the three that worked, named
 * `processed_files.zip`, with nothing inside it saying the other two existed.
 * The rows on screen said `error`, and the archive on disk did not.
 *
 * B2, adopted at H4: one archive after the last file, containing every success
 * **and a manifest naming every input** — what happened to it, why, and under
 * which code. A file that was refused is in the manifest. A file that was
 * cancelled is in the manifest. Nothing is omitted silently.
 *
 * The memory ceiling is a **job** ceiling (H8): JSZip holds the sources, the
 * accumulated chunks, the concatenated archive and the Blob copy at the same
 * moment, so pricing the largest file alone accepts batches that cannot run.
 *
 * Adopted: H4 (B2), H8 (whole-job accounting), H10 (nothing publishes after the
 * run has been superseded).
 */
import JSZip from 'jszip';
import {
    BATCH_RESULT, FILE_RESULT, PLAN_STATUS, ProcessorError,
} from './contracts';
import type { BatchResult, BatchResultStatus, FileResult } from './contracts';
import {
    MANIFEST_NAME, MAX_ENTRY_NAME_BYTES, batchCost, checkActualOutput, checkCeilings, entryNameBytes,
} from './budget';
import type { Ceilings } from './budget';

export interface ManifestEntry {
    input: string;
    output: string | null;
    result: FileResult['status'];
    code: FileResult['code'];
    reason: string;
    bytes: number | null;
}

export interface Manifest {
    tool: string;
    createdAt: string;
    files: ManifestEntry[];
    summary: { total: number; succeeded: number; failed: number; cancelled: number };
}

/**
 * The stated maxima the manifest is priced at.
 *
 * A reason is a sentence written at runtime — a refusal quoting a filename, a
 * thrown message from a library — so without a stated ceiling the manifest has
 * no upper bound and neither does the archive that carries it. Both are bounded
 * here and the bound is *enforced* rather than hoped for, which is what lets
 * the pre-run preflight price a manifest that does not exist yet.
 */
export const MAX_MANIFEST_REASON_BYTES = 512;
export const MAX_TOOL_LABEL_BYTES = 64;

/**
 * A string cut to a byte budget, with the characters JSON would expand removed.
 *
 * `JSON.stringify` writes a quote, a backslash or a control character as an
 * escape of two or six bytes, so a field measured at its raw length can still
 * serialise past the priced maximum. Japanese text needs no such care — it is
 * emitted as itself, three bytes a character — so only the expanding cases are
 * replaced.
 */
const bounded = (text: string, maxBytes: number): string => {
    const clean = String(text ?? '')
        .replace(/["\\]/g, "'")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u2028\u2029]/g, ' ');
    let out = clean;
    while (entryNameBytes(out) > maxBytes) out = out.slice(0, -1);
    return out;
};

/**
 * Every input, in the order it was given. The manifest is the record the ZIP
 * itself cannot carry: a missing file looks identical to a file nobody added.
 */
export function buildManifest(tool: string, results: FileResult[]): Manifest {
    const count = (status: FileResult['status']) => results.filter((r) => r.status === status).length;
    return {
        tool: bounded(tool, MAX_TOOL_LABEL_BYTES),
        createdAt: new Date().toISOString(),
        files: results.map((r) => ({
            input: r.name,
            output: r.outputName,
            result: r.status,
            code: r.code,
            reason: bounded(r.reason, MAX_MANIFEST_REASON_BYTES),
            bytes: r.bytes ? r.bytes.length : null,
        })),
        summary: {
            total: results.length,
            succeeded: count(FILE_RESULT.SUCCEEDED),
            failed: count(FILE_RESULT.FAILED),
            cancelled: count(FILE_RESULT.CANCELLED),
        },
    };
}

export const manifestBytes = (manifest: Manifest): Uint8Array =>
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

/**
 * The largest manifest this many files can produce, built rather than guessed.
 *
 * The previous preflight used a flat 2,048 bytes, which a batch of forty files
 * passes in its first three entries. This serialises the worst manifest the
 * enforced maxima above allow — every name at `MAX_ENTRY_NAME_BYTES`, every
 * reason at its ceiling, the longest status code, a byte count at
 * `Number.MAX_SAFE_INTEGER` — so the number is an upper bound by construction
 * and moves when the shape of the manifest does.
 */
export function manifestUpperBound(fileCount: number): number {
    const name = 'x'.repeat(MAX_ENTRY_NAME_BYTES);
    const files: ManifestEntry[] = Array.from({ length: Math.max(0, fileCount) }, () => ({
        input: name,
        output: name,
        result: FILE_RESULT.CANCELLED,
        code: PLAN_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION,
        reason: 'x'.repeat(MAX_MANIFEST_REASON_BYTES),
        bytes: Number.MAX_SAFE_INTEGER,
    }));
    return manifestBytes({
        tool: 'x'.repeat(MAX_TOOL_LABEL_BYTES),
        createdAt: new Date(0).toISOString(),
        files,
        summary: {
            total: fileCount, succeeded: fileCount, failed: fileCount, cancelled: fileCount,
        },
    }).length;
}

/**
 * The name the whole-job model prices every entry at: the longest this
 * publication will accept, and non-ASCII, so it also carries the Info-ZIP
 * Unicode Path extra field in both records. 85 three-byte characters is exactly
 * `MAX_ENTRY_NAME_BYTES`.
 *
 * Exported so the gate can hold it against `worstCaseEntryOverhead()` rather
 * than take on trust that the name used here really is the worst case.
 */
export const WORST_CASE_ENTRY_NAME = 'あ'.repeat(MAX_ENTRY_NAME_BYTES / 3);

/**
 * Can this batch be published at all?
 *
 * Entry names are priced in **UTF-8 bytes**, because that is what a ZIP stores
 * and what a Japanese filename costs three of per character. A name longer than
 * the stated maximum is refused rather than left to push the archive past a
 * ceiling the model said it was inside.
 */
export function planBatchPublication(
    results: FileResult[],
    manifest: Manifest,
    ceilings: Ceilings,
): { ok: true; cost: ReturnType<typeof batchCost> } | { ok: false; code: typeof PLAN_STATUS[keyof typeof PLAN_STATUS]; reason: string } {
    const successes = results.filter((r) => r.status === FILE_RESULT.SUCCEEDED && r.bytes);

    // Both names are checked, not only the one that becomes a ZIP entry: the
    // input name goes into the manifest, and the manifest is what the pre-run
    // preflight priced at a stated maximum. A name past that maximum would make
    // the archive larger than the arithmetic that admitted the batch.
    for (const r of results) {
        for (const name of [r.name, r.outputName].filter((n): n is string => typeof n === 'string')) {
            const bytes = entryNameBytes(name);
            if (bytes > MAX_ENTRY_NAME_BYTES) {
                return {
                    ok: false,
                    code: PLAN_STATUS.UNSUPPORTED_DOCUMENT,
                    reason: `ファイル名が長すぎます（${bytes}バイト、上限${MAX_ENTRY_NAME_BYTES}バイト）: ${name}`,
                };
            }
        }
    }

    const cost = batchCost(
        successes.map((r) => ({ name: r.outputName ?? r.name, bytes: r.bytes!.length })),
        manifestBytes(manifest).length,
    );
    const refusal = checkCeilings(
        { pixels: 0, peakBytes: cost.peakBytes, outputBytes: cost.archiveBytes },
        ceilings,
    );
    if (refusal === 'OVER_MEMORY_BUDGET') {
        return {
            ok: false,
            code: PLAN_STATUS.OVER_MEMORY_BUDGET,
            reason: `ZIPの作成には約${(cost.peakBytes / 1048576).toFixed(0)} MiBが必要で、`
                + `処理メモリ上限${(ceilings.memoryBytes / 1048576).toFixed(0)} MiBを超えます。`
                + 'ファイル数を減らして実行してください。',
        };
    }
    if (refusal === 'OVER_OUTPUT_BUDGET') {
        return {
            ok: false,
            code: PLAN_STATUS.OVER_OUTPUT_BUDGET,
            reason: `ZIPが約${(cost.archiveBytes / 1048576).toFixed(0)} MiBとなり、`
                + `上限の${(ceilings.maxOutputBytes / 1048576).toFixed(0)} MiBを超えます。`,
        };
    }
    return { ok: true, cost };
}

/**
 * Whether the job can still afford to start the next file.
 *
 * Checking the archive's budget after every output has been produced discovers
 * `OVER_MEMORY_BUDGET` with the memory already claimed — the refusal arrives
 * too late to be a refusal. So the job is re-checked at each file boundary,
 * against what is actually being held rather than against an estimate: the
 * bytes of the outputs retained so far, plus the peak the next file will reach
 * while it is produced.
 *
 * `nextFilePeakBytes` comes from that file's own plan, which exists before the
 * first raster of the job is allocated.
 */
export function canStartNextFile(
    retained: FileResult[],
    nextFilePeakBytes: number,
    ceilings: Ceilings,
): { ok: true; liveBytes: number } | { ok: false; reason: string; liveBytes: number } {
    const held = retained.reduce((n, r) => n + (r.bytes ? r.bytes.length : 0), 0);
    const liveBytes = held + nextFilePeakBytes;
    if (liveBytes <= ceilings.memoryBytes) return { ok: true, liveBytes };
    return {
        ok: false,
        liveBytes,
        reason: `すでに書き出し済みの${(held / 1048576).toFixed(0)} MiBに加えて`
            + `このファイルの処理に約${(nextFilePeakBytes / 1048576).toFixed(0)} MiBが必要で、`
            + `処理メモリ上限${(ceilings.memoryBytes / 1048576).toFixed(0)} MiBを超えます。`
            + 'ファイル数を減らすか、上限設定を変更してください。',
    };
}

/**
 * The whole job, priced before the first page is rendered.
 *
 * Every file's plan is known up front, so the batch can be refused before it
 * starts instead of part-way through. The two terms that matter are the peak
 * while the last file is produced on top of everything retained, and the
 * archive handoff at the end.
 *
 * This has to be an **upper bound on the exact publication plan**, or a batch
 * can pass here and then be refused after every file has been produced — which
 * is the refusal arriving too late to be one. So neither the names nor the
 * manifest are estimated from the inputs: the output names do not exist yet
 * (最適化 decides its suffix by whether the file got smaller, and the two
 * hardened lanes take theirs from a summary produced during the run), so every
 * entry is priced at the longest name the publication will accept, with its
 * Unicode Path extra field, and the manifest at the largest the enforced maxima
 * allow. `gateWholeJobBound` in the reliability gate holds the two against each
 * other for real batches.
 */
export function planWholeJob(
    filePeaks: number[],
    fileOutputEstimates: number[],
    ceilings: Ceilings,
): { ok: true; peakBytes: number } | { ok: false; reason: string; peakBytes: number } {
    const retainedAtEnd = fileOutputEstimates.reduce((n, b) => n + b, 0);
    const producing = fileOutputEstimates.reduce(
        (worst, _b, i) => {
            const before = fileOutputEstimates.slice(0, i).reduce((n, x) => n + x, 0);
            return Math.max(worst, before + (filePeaks[i] ?? 0));
        },
        0,
    );
    const archive = batchCost(
        fileOutputEstimates.map((bytes) => ({ name: WORST_CASE_ENTRY_NAME, bytes })),
        manifestUpperBound(fileOutputEstimates.length),
    );
    const peakBytes = Math.max(producing, retainedAtEnd, archive.peakBytes);
    if (peakBytes <= ceilings.memoryBytes) return { ok: true, peakBytes };
    return {
        ok: false,
        peakBytes,
        reason: `このバッチ全体で約${(peakBytes / 1048576).toFixed(0)} MiBが必要で、`
            + `処理メモリ上限${(ceilings.memoryBytes / 1048576).toFixed(0)} MiBを超えます。`
            + '処理を開始せずに中止しました。',
    };
}

const batchStatus = (results: FileResult[]): BatchResultStatus => {
    if (results.some((r) => r.status === FILE_RESULT.CANCELLED)) return BATCH_RESULT.CANCELLED;
    const ok = results.filter((r) => r.status === FILE_RESULT.SUCCEEDED).length;
    if (ok === 0) return BATCH_RESULT.FAILED;
    return ok === results.length ? BATCH_RESULT.SUCCEEDED : BATCH_RESULT.PARTIAL;
};

/**
 * Build the archive.
 *
 * `stillOurs` is re-checked immediately before the Blob is produced: a run the
 * user has superseded must not leave a download behind, and the archive is the
 * last and largest thing it could leave.
 */
export async function publishBatch(
    tool: string,
    results: FileResult[],
    ceilings: Ceilings,
    stillOurs: () => boolean,
): Promise<BatchResult> {
    const manifest = buildManifest(tool, results);
    const plan = planBatchPublication(results, manifest, ceilings);
    if (!plan.ok) {
        throw new ProcessorError(plan.reason, plan.code);
    }

    const zip = new JSZip();
    for (const r of results) {
        if (r.status === FILE_RESULT.SUCCEEDED && r.bytes) {
            zip.file(r.outputName ?? r.name, r.bytes);
        }
    }
    zip.file(MANIFEST_NAME, manifestBytes(manifest));

    if (!stillOurs()) {
        return { status: BATCH_RESULT.CANCELLED, files: results, archive: null, archiveName: null };
    }
    const archive = await zip.generateAsync({ type: 'blob' });
    if (!stillOurs()) {
        return { status: BATCH_RESULT.CANCELLED, files: results, archive: null, archiveName: null };
    }

    // The ceiling, applied to the archive that exists rather than to the one the
    // model described. The model above is exact for JSZip's STORE path and has
    // measured zero head-room, which is precisely why it cannot be the last
    // word: an exact model is only exact while the library it was read off
    // behaves as it did. If the real Blob is over, nothing is published.
    const actual = checkActualOutput(archive.size, ceilings);
    if (!actual.ok) {
        throw new ProcessorError(
            `作成したZIPが${(archive.size / 1048576).toFixed(1)} MiBとなり、`
            + `上限の${(ceilings.maxOutputBytes / 1048576).toFixed(0)} MiBを超えました。書き出しは行いません。`,
            PLAN_STATUS.OVER_OUTPUT_BUDGET,
        );
    }

    return {
        status: batchStatus(results),
        files: results,
        archive,
        archiveName: `${tool}_${results.length}files.zip`,
    };
}
