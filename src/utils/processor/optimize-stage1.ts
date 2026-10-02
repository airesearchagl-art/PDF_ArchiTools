/**
 * 最適化 v2, Stage 1 (D-028): one PDF, lossless, image-aware.
 *
 * The order below is the contract:
 *
 *   1. preflight   the file's size and its trailer /Size, read without
 *                  reading the file — refused here if the parse could not fit
 *   2. parse       the only place the source bytes exist; nothing outside
 *                  `parseOnce` keeps a reference to them, so once pdf-lib has
 *                  copied the streams out the buffer can be collected
 *   3. plan        the Processor's own refusals (encrypted, unreadable,
 *                  applied signature, unreadable form)
 *   4. images      one at a time, each priced before it starts; an image whose
 *                  working set does not fit is left as it is
 *   5. write       the chunked writer, against the output ceiling and the
 *                  ledger
 *   6. threshold   the derivative is handed over only when it is ≥ 1% smaller;
 *                  otherwise the caller hands back the original File, which it
 *                  never stopped holding
 *
 * Nothing is published from here. The caller publishes `chunks`, or the File.
 */
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { PLAN_STATUS, ProcessorError } from './contracts';
import type { SourceFacts } from './contracts';
import type { RunToken } from './ownership';
import { planOperation } from './planner';
import { readSourceFactsFromDocument, unreadableFacts } from './source-facts';
import { PRESERVING_SLACK_BYTES, preservingFileCost } from './budget';
import type { Ceilings } from './budget';
import {
    OptimizeLedger, admitPreParse, imageWorkBytes, meetsPublicationThreshold, parsedFixedBytes, usableBytes,
} from './optimize-budget';
import { bestReplacement, censusImages, decodeExactSamples } from './image-optimize';
import type { WorkControl } from './image-optimize';
import { ChunkedDocumentWriter, writeDocument } from './chunked-writer';
import type { StreamReplacement } from './chunked-writer';

/** Where the PDF comes from. A `File` in the app; anything in a gate. */
export interface OptimizeSource {
    readonly size: number;
    /** The whole file. Called exactly once. */
    read(): Promise<Uint8Array>;
    /** A byte range, for the trailer probe. */
    readRange(start: number, end: number): Promise<Uint8Array>;
}

export const sourceFromFile = (file: Blob): OptimizeSource => ({
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
    readRange: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
});

export interface OptimizeImageReport {
    objectNumber: number;
    width: number;
    height: number;
    colourSpace: string;
    bitsPerComponent: number;
    filters: string;
    decision: 'LEAVE' | 'R1' | 'R1+R2';
    why: string;
    before: number;
    after: number;
    /** What was written, or why the stream was kept. */
    outcome: string;
    rewritten: boolean;
}

export interface OptimizeSummary {
    sourceBytes: number;
    /** What the rewrite came to, whether or not it was handed over. */
    candidateBytes: number;
    images: OptimizeImageReport[];
    rewrittenImages: number;
    unchangedImages: number;
    /** Always false in Stage 1: nothing lossy exists on this path. */
    qualityChanged: false;
    resolutionChanged: false;
    /** 'images' (chunked writer) or 'structure' (no image changed; pdf-lib re-save). */
    mode: 'images' | 'structure' | 'none';
    ledgerPeakBytes: number;
    usableBytes: number;
}

export type OptimizeResult =
    | { kind: 'optimized'; chunks: Uint8Array[]; outputBytes: number; summary: OptimizeSummary }
    | { kind: 'unchanged'; summary: OptimizeSummary };

export interface OptimizeHooks {
    /** After the parse, before anything else: the gate's ownership probe. */
    afterParse?: () => Promise<void> | void;
    /** After an image has been decided, for progress and the cancellation gate. */
    afterImage?: (index: number, total: number) => Promise<void> | void;
    /** Before the writer starts. */
    beforeWrite?: () => Promise<void> | void;
}

export interface OptimizeOptions {
    memoryBytes: number;
    ceilings: Ceilings;
    token?: RunToken;
    hooks?: OptimizeHooks;
    yieldToTask?: () => Promise<void>;
}

const defaultYield = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const MiB = (b: number) => (b / 1048576).toFixed(0);

// ---------------------------------------------------------------- trailer

const MAX_PDF_OBJECTS = 8_388_607;

const sizeEntries = (bytes: Uint8Array): number[] => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    const found: number[] = [];
    for (const m of s.matchAll(/\/Size\s+(\d{1,10})(?![\d.])/g)) found.push(Number(m[1]));
    return found;
};

/**
 * The trailer's /Size — one more than the highest object number the file may
 * use — read from the file's tail and from where `startxref` points, without
 * reading the rest. Null when neither place says.
 *
 * The largest value found is taken: an over-estimate only makes the preflight
 * stricter.
 */
export async function readTrailerSize(source: OptimizeSource): Promise<number | null> {
    if (source.size <= 0) return null;
    const tailStart = Math.max(0, source.size - 65_536);
    const tail = await source.readRange(tailStart, source.size);
    const sizes = sizeEntries(tail);

    let text = '';
    const from = Math.max(0, tail.length - 2048);
    for (let i = from; i < tail.length; i += 1) text += String.fromCharCode(tail[i]);
    const sx = [...text.matchAll(/startxref\s+(\d{1,12})/g)].pop();
    if (sx) {
        const at = Number(sx[1]);
        if (at >= 0 && at < source.size) {
            sizes.push(...sizeEntries(await source.readRange(at, Math.min(source.size, at + 4096))));
        }
    }
    if (sizes.length === 0) return null;
    return Math.min(MAX_PDF_OBJECTS + 1, Math.max(...sizes));
}

// ---------------------------------------------------------------- the run

/**
 * The parse, and the only frame the source bytes are ever bound in.
 *
 * `source.read()` is awaited inside the call to `PDFDocument.load`, so no name
 * in this module ever refers to the buffer. pdf-lib copies each stream out of
 * it while parsing; once `load` returns, nothing the caller can reach holds it.
 */
async function parseOnce(source: OptimizeSource): Promise<{ doc: PDFDocument | null; facts: SourceFacts }> {
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(await readExactly(source), { updateMetadata: false, ignoreEncryption: false });
    } catch (error) {
        if (error instanceof ProcessorError) throw error;
        return { doc: null, facts: unreadableFacts(source.size, error) };
    }
    return { doc, facts: readSourceFactsFromDocument(doc, source.size) };
}

async function readExactly(source: OptimizeSource): Promise<Uint8Array> {
    const bytes = await source.read();
    if (bytes.length !== source.size) {
        throw new ProcessorError('読み込み中にファイルが変更されたため、処理を中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
    }
    return bytes;
}

/** The single-file preflight, before a byte of the file body is read. */
export async function preflightOptimize(
    source: OptimizeSource,
    memoryBytes: number,
): Promise<{ trailerSize: number; needBytes: number; usableBytes: number }> {
    const trailerSize = await readTrailerSize(source);
    if (trailerSize === null) {
        throw new ProcessorError(
            'このPDFの末尾にある相互参照情報（/Size）を読み取れないため、必要なメモリを事前に見積もれません。'
            + '見積もれない状態では最適化を開始しません。',
            PLAN_STATUS.UNSUPPORTED_DOCUMENT,
        );
    }
    const admission = admitPreParse(source.size, trailerSize, memoryBytes);
    if (!admission.ok) {
        throw new ProcessorError(
            `このPDF（${MiB(source.size)} MiB）の最適化には読み込みだけで約${MiB(admission.needBytes)} MiBが必要で、`
            + `処理メモリ上限${MiB(memoryBytes)} MiBのうち最適化に使える${MiB(admission.usableBytes)} MiBを超えます。`
            + '処理メモリ上限を上げてから実行してください（約250 MiBのPDFには1 GiB以上が必要です）。',
            PLAN_STATUS.OVER_MEMORY_BUDGET,
        );
    }
    return { trailerSize, needBytes: admission.needBytes, usableBytes: admission.usableBytes };
}

export async function runOptimizeV2(source: OptimizeSource, options: OptimizeOptions): Promise<OptimizeResult> {
    const { memoryBytes, ceilings, token, hooks = {} } = options;
    const yieldToTask = options.yieldToTask ?? defaultYield;
    const check = () => { token?.assertCurrent(); };
    const control: WorkControl = { check, yieldToTask };

    // ---- 1. preflight --------------------------------------------------------
    await preflightOptimize(source, memoryBytes);
    check();

    // ---- 2. parse ------------------------------------------------------------
    const { doc, facts } = await parseOnce(source);
    check();
    await hooks.afterParse?.();

    // ---- 3. plan -------------------------------------------------------------
    const plan = planOperation(facts, 'optimize', { memoryBudgetBytes: memoryBytes });
    if (plan.status !== PLAN_STATUS.READY || !doc) throw new ProcessorError(plan.reason, plan.code);

    const ctx = doc.context;
    let objects = 0;
    let streamBytes = 0;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
        objects += 1;
        if (obj instanceof PDFRawStream) streamBytes += obj.contents.length;
    }
    const ledger = new OptimizeLedger(memoryBytes, parsedFixedBytes({ objects, streamBytes }));
    if (!ledger.fits(0)) {
        throw new ProcessorError(
            `読み込んだ文書だけで約${MiB(ledger.heldBytes)} MiBとなり、最適化に使える${MiB(ledger.usable)} MiBを超えます。`
            + '処理メモリ上限を上げてから実行してください。',
            PLAN_STATUS.OVER_MEMORY_BUDGET,
        );
    }

    // ---- 4. images -----------------------------------------------------------
    const census = censusImages(doc);
    const replacements = new Map<PDFRawStream, StreamReplacement>();
    const reports: OptimizeImageReport[] = [];

    for (let i = 0; i < census.length; i += 1) {
        check();
        const entry = census[i];
        const before = entry.stream.contents.length;
        const report: OptimizeImageReport = {
            objectNumber: entry.ref.objectNumber,
            width: entry.width,
            height: entry.height,
            colourSpace: entry.colourSpace,
            bitsPerComponent: entry.bitsPerComponent,
            filters: entry.filters.join('+') || 'none',
            decision: entry.decision,
            why: entry.why,
            before,
            after: before,
            outcome: 'unchanged',
            rewritten: false,
        };
        reports.push(report);
        if (entry.decision === 'LEAVE') {
            report.outcome = `unchanged (${entry.why})`;
        } else {
            const work = imageWorkBytes({
                decodedBytes: entry.decodedBytes + (entry.filters.includes('ASCIIHexDecode') ? Math.ceil(before / 2) : 0),
                streamBytes: before,
                rowBytes: Math.max(entry.rowBytes, entry.width) + 1,
            });
            if (!ledger.fits(work)) {
                report.outcome = 'unchanged (its working set does not fit the memory budget)';
            } else {
                ledger.commit(work);
                try {
                    const samples = decodeExactSamples(entry);
                    if (!samples) {
                        report.outcome = 'unchanged (samples could not be recovered exactly)';
                    } else {
                        const best = await bestReplacement(ctx, entry, samples, control);
                        if (!best) {
                            report.outcome = 'unchanged (no exact encoding was smaller)';
                        } else {
                            // The placeholder carries the new dictionary; the
                            // writer emits the compressor's chunks for it. The
                            // stream pdf-lib copied from the source is let go.
                            const placeholder = PDFRawStream.of(best.dict, new Uint8Array(0));
                            ctx.assign(entry.ref, placeholder);
                            replacements.set(placeholder, { chunks: best.encoded.chunks, length: best.encoded.length });
                            ledger.commit(best.encoded.heldBytes);
                            report.after = best.encoded.length;
                            report.outcome = best.label;
                            report.rewritten = true;
                        }
                    }
                } finally {
                    ledger.release(work);
                }
            }
        }
        await hooks.afterImage?.(i, census.length);
    }
    check();

    const summary: OptimizeSummary = {
        sourceBytes: source.size,
        candidateBytes: source.size,
        images: reports,
        rewrittenImages: reports.filter((r) => r.rewritten).length,
        unchangedImages: reports.filter((r) => !r.rewritten).length,
        qualityChanged: false,
        resolutionChanged: false,
        mode: 'none',
        ledgerPeakBytes: ledger.peakBytes,
        usableBytes: usableBytes(memoryBytes),
    };

    // ---- 5. write ------------------------------------------------------------
    let chunks: Uint8Array[];
    let total: number;
    await hooks.beforeWrite?.();
    check();
    if (replacements.size > 0) {
        const writer = new ChunkedDocumentWriter(ceilings.maxOutputBytes);
        ({ chunks, total } = await writeDocument(ctx, replacements, writer, control));
        summary.mode = 'images';
        ledger.commit(writer.ownedBytes);
    } else {
        // No image changed. What remains is the structural re-save Stage 1
        // inherited from 1.3.1, priced by the same conservative bound and
        // skipped — the original returned — when it does not fit.
        const bound = preservingFileCost(source.size, PRESERVING_SLACK_BYTES).outputBytes;
        if (!ledger.fits(bound)) {
            summary.ledgerPeakBytes = ledger.peakBytes;
            return { kind: 'unchanged', summary };
        }
        const saved = await doc.save({ useObjectStreams: true });
        chunks = [saved];
        total = saved.length;
        summary.mode = 'structure';
        ledger.commit(total);
        if (total > ceilings.maxOutputBytes) {
            summary.candidateBytes = total;
            summary.ledgerPeakBytes = ledger.peakBytes;
            return { kind: 'unchanged', summary };
        }
    }
    check();
    summary.candidateBytes = total;

    // ---- 6. threshold ---------------------------------------------------------
    if (!meetsPublicationThreshold(total, source.size)) {
        summary.ledgerPeakBytes = ledger.peakBytes;
        return { kind: 'unchanged', summary };
    }
    // The publication Blob is one more copy of the output.
    if (!ledger.fits(total)) {
        throw new ProcessorError(
            `書き出し用のデータ（約${MiB(total)} MiB）を確保すると処理メモリ上限を超えるため、書き出しを中止しました。`,
            PLAN_STATUS.OVER_MEMORY_BUDGET,
        );
    }
    ledger.commit(total);
    summary.ledgerPeakBytes = ledger.peakBytes;
    return { kind: 'optimized', chunks, outputBytes: total, summary };
}
