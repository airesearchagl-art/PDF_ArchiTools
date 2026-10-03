/**
 * 最適化 v2, Stage 1 (D-028): one PDF, lossless, image-aware.
 *
 * The order below is the contract:
 *
 *   1. preflight   the file's size and the /Size of the cross-reference
 *                  section `startxref` names, read without reading the file —
 *                  refused if /Size cannot be read exactly, is out of range,
 *                  or the parse could not fit
 *   2. parse       the only place the source bytes exist; nothing outside
 *                  `parseOnce` keeps a reference to them, so once pdf-lib has
 *                  copied the streams out the buffer can be collected. A parse
 *                  whose objects go past /Size is refused (the preflight was
 *                  priced on a number that was not true)
 *   3. plan        the Processor's own refusals (encrypted, unreadable,
 *                  applied signature, unreadable form)
 *   4. images      one at a time, each charged to the ledger before it starts;
 *                  an image whose working set does not fit is left as it is
 *   5. measure     no image rewritten → the original File. Otherwise the
 *                  writer's output is measured exactly without allocating it;
 *                  the output ceiling and the ≥ 1% threshold are decided on
 *                  that, and the writer's own bytes plus the publication copy
 *                  are charged to the ledger — which refuses rather than pass
 *                  its share — before the writer allocates anything
 *   6. write       the chunked writer, held to the bytes it was given
 *
 * Nothing is published from here. The caller publishes `chunks`, or the File.
 */
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { PLAN_STATUS, ProcessorError } from './contracts';
import type { SourceFacts } from './contracts';
import type { RunToken } from './ownership';
import { planOperation } from './planner';
import { readSourceFactsFromDocument, unreadableFacts } from './source-facts';
import type { Ceilings } from './budget';
import {
    OptimizeLedger, admitPreParse, imageWorkBytes, meetsPublicationThreshold, parsedFixedBytes, usableBytes,
} from './optimize-budget';
import { bestReplacement, censusImages, decodeExactSamples } from './image-optimize';
import type { WorkControl } from './image-optimize';
import { ChunkedDocumentWriter, planDocumentWrite, writeDocument } from './chunked-writer';
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
    /** 'images' when the chunked writer ran (or was measured), 'none' when no image was rewritten. */
    mode: 'images' | 'none';
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

/** The largest /Size Optimizer v2 accepts (PDF 32000 Annex C: 8,388,607 objects). */
export const MAX_TRAILER_SIZE = 8_388_607;

const latin = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return s;
};

/** The /Size entry of one dictionary's text, or null when it has none. */
const sizeIn = (dict: string): number | null => {
    const m = /\/Size\s+(\d{1,12})(?=[\s/>\]])/.exec(dict);
    return m ? Number(m[1]) : null;
};

/** The dictionary that begins at the first `<<` in `text`, brackets balanced; null if it does not close. */
function firstDictionary(text: string): string | null {
    const start = text.indexOf('<<');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < text.length - 1; i += 1) {
        if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 1; continue; }
        if (text[i] === '>' && text[i + 1] === '>') {
            depth -= 1;
            i += 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * The /Size of the cross-reference section `startxref` points at — one more
 * than the highest object number the file may use — read without reading the
 * body. Only the trailer dictionary of a classic table, or the dictionary of a
 * cross-reference stream, counts; a `/Size` anywhere else is ignored.
 *
 * Null whenever this cannot be established exactly: no `startxref`, a target
 * that is neither `xref` nor `N G obj`, a table that does not walk to its
 * `trailer`, a dictionary that does not close, or no integer /Size in it. The
 * caller refuses on null; nothing here is clamped or guessed.
 */
export async function readTrailerSize(source: OptimizeSource): Promise<number | null> {
    if (source.size <= 0) return null;
    const tail = latin(await source.readRange(Math.max(0, source.size - 2048), source.size));
    const sx = [...tail.matchAll(/startxref\s+(\d{1,12})\s+%%EOF/g)].pop();
    if (!sx) return null;
    const at = Number(sx[1]);
    if (!(at >= 0 && at < source.size)) return null;

    const head = latin(await source.readRange(at, Math.min(source.size, at + 4096)));
    if (/^\d+\s+\d+\s+obj\b/.test(head)) {
        // A cross-reference stream: its own dictionary carries /Size.
        const dict = firstDictionary(head);
        if (!dict || !/\/Type\s*\/XRef\b/.test(dict)) return null;
        return sizeIn(dict);
    }
    if (!head.startsWith('xref')) return null;

    // A classic table: walk its subsections (20-byte entries) to the trailer.
    let pos = at + 4;
    for (let guard = 0; guard < 100_000; guard += 1) {
        const window = latin(await source.readRange(pos, Math.min(source.size, pos + 64)));
        const ws = /^[\0\t\n\f\r ]*/.exec(window)?.[0].length ?? 0;
        const rest = window.slice(ws);
        if (rest.startsWith('trailer')) {
            const t = latin(await source.readRange(pos + ws, Math.min(source.size, pos + ws + 4096)));
            const dict = firstDictionary(t);
            return dict ? sizeIn(dict) : null;
        }
        const sub = /^(\d{1,10}) (\d{1,10})[ \t]*(\r\n|\r|\n)/.exec(rest);
        if (!sub) return null;
        pos += ws + sub[0].length + Number(sub[2]) * 20;
        if (pos >= source.size) return null;
    }
    return null;
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
    if (trailerSize === null || !Number.isSafeInteger(trailerSize) || trailerSize < 1 || trailerSize > MAX_TRAILER_SIZE) {
        throw new ProcessorError(
            trailerSize === null
                ? 'このPDFの相互参照情報（trailerの/Size）を読み取れないため、必要なメモリを事前に見積もれません。'
                    + '見積もれない状態では最適化を開始しません。'
                : `このPDFの相互参照情報に記された/Size（${trailerSize}）が有効な範囲（1〜${MAX_TRAILER_SIZE}）にないため、`
                    + '必要なメモリを事前に見積もれません。見積もれない状態では最適化を開始しません。',
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
    const { trailerSize } = await preflightOptimize(source, memoryBytes);
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
    let highest = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        objects += 1;
        highest = Math.max(highest, ref.objectNumber);
        if (obj instanceof PDFRawStream) streamBytes += obj.contents.length;
    }
    // The preflight priced the parse on /Size. A document whose parsed objects
    // go past it (pdf-lib recovers some broken tables by scanning) was priced
    // on a number that was not true, so it is refused before anything changes.
    if (highest >= trailerSize || objects >= trailerSize) {
        throw new ProcessorError(
            `このPDFには相互参照情報の/Size（${trailerSize}）を超える番号のオブジェクト（最大${highest}、${objects}個）があり、`
            + '事前の見積もりが成り立たないため、最適化を中止しました。',
            PLAN_STATUS.UNSUPPORTED_DOCUMENT,
        );
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
                ledger.commit(work, '画像の処理');
                // The kept candidate's chunks were allocated inside `work`; they
                // move to the ledger as retained bytes once `work` is let go.
                let retained = 0;
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
                            retained = best.encoded.heldBytes;
                            report.after = best.encoded.length;
                            report.outcome = best.label;
                            report.rewritten = true;
                        }
                    }
                } finally {
                    ledger.release(work);
                }
                // ≤ the kept-candidate share of `work`, so this always fits.
                if (retained > 0) ledger.commit(retained, '置き換えた画像の保持');
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

    // ---- 5. nothing to write? -------------------------------------------------
    // No image was rewritten: the original File is the answer. (Stage 1 has no
    // structure-only re-save — it would need its own priced allocation.)
    if (replacements.size === 0) {
        summary.ledgerPeakBytes = ledger.peakBytes;
        return { kind: 'unchanged', summary };
    }

    // ---- 6. measure, decide, reserve — all before the writer allocates ----------
    await hooks.beforeWrite?.();
    check();
    const writePlan = planDocumentWrite(ctx, replacements);
    summary.mode = 'images';
    summary.candidateBytes = writePlan.totalBytes;
    if (writePlan.totalBytes > ceilings.maxOutputBytes) {
        throw new ProcessorError(
            `出力が${(writePlan.totalBytes / 1048576).toFixed(1)} MiBとなり、上限の${MiB(ceilings.maxOutputBytes)} MiBを超えるため、`
            + '書き出しは行いませんでした。',
            PLAN_STATUS.OVER_OUTPUT_BUDGET,
        );
    }
    if (!meetsPublicationThreshold(writePlan.totalBytes, source.size)) {
        summary.ledgerPeakBytes = ledger.peakBytes;
        return { kind: 'unchanged', summary };
    }
    // The writer's own bytes (headers, dictionaries, xref, trailer, and an
    // entry per chunk), then the publication Blob's copy of the whole output.
    // Unchanged stream contents are already held by the parsed document.
    ledger.commit(writePlan.ownedBytes + writePlan.chunkCount * CHUNK_ENTRY_BYTES, '書き出し');
    ledger.commit(writePlan.totalBytes, '書き出したPDFの受け渡し');

    // ---- 7. write ----------------------------------------------------------------
    const writer = new ChunkedDocumentWriter(ceilings.maxOutputBytes, writePlan.ownedBytes);
    const { chunks, total } = await writeDocument(ctx, replacements, writer, control);
    check();
    if (total !== writePlan.totalBytes) {
        throw new ProcessorError('書き出したPDFの大きさが事前の見積もりと一致しないため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
    }
    summary.ledgerPeakBytes = ledger.peakBytes;
    return { kind: 'optimized', chunks, outputBytes: total, summary };
}

/** One array entry per writer chunk: pointer, typed-array header. Conservative. */
const CHUNK_ENTRY_BYTES = 128;
