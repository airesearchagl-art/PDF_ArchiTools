/**
 * Optimizer v2's append-only writer: an existing document, every indirect
 * object serialised on its own, the cross-reference table last (D-028).
 *
 * It takes the discipline of the Comparator's Output Writer v2 — chunks owned
 * until `finish`, nothing published before it, `abort` drops everything, the
 * output ceiling checked before each append — and applies it to a document
 * pdf-lib has parsed rather than one it is building:
 *
 *   - an unchanged stream is emitted as the contents pdf-lib already holds (a
 *     reference, not a copy);
 *   - a replaced image stream is emitted from the chunks its compressor handed
 *     over, without ever being joined into one buffer;
 *   - only dictionaries, object headers and the xref table are new bytes.
 *
 * The output is a classic, single-section cross-reference file. The trailer
 * carries Root, Info and ID from the source; encrypted documents never get
 * here (the planner refuses them).
 */
import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { PLAN_STATUS, ProcessorError } from './contracts';

const N = (s: string) => PDFName.of(s);
const latin1 = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
};

/** Replaced streams: the placeholder pdf-lib holds, and what is written for it. */
export interface StreamReplacement {
    chunks: Uint8Array[];
    length: number;
}

export type WriterState = 'open' | 'finished' | 'aborted';

/**
 * Owns the chunks until `finish`. Every append is checked against the output
 * ceiling first; a write that would pass it aborts the writer and throws.
 */
export class ChunkedDocumentWriter {
    private readonly maxBytes: number;

    /** What the ledger reserved for this writer's own bytes; never exceeded. */
    private readonly ownedLimit: number;

    private chunks: Uint8Array[] = [];

    private offset = 0;

    /** Bytes this writer allocated itself (not views of existing streams). */
    private owned = 0;

    private status: WriterState = 'open';

    constructor(maxBytes: number, ownedLimit = Number.POSITIVE_INFINITY) {
        this.maxBytes = maxBytes;
        this.ownedLimit = ownedLimit;
    }

    get bytesWritten(): number { return this.offset; }

    get ownedBytes(): number { return this.owned; }

    get state(): WriterState { return this.status; }

    private assertOpen(): void {
        if (this.status !== 'open') {
            throw new ProcessorError(`書き出しは${this.status === 'aborted' ? '中止' : '完了'}済みです。`, PLAN_STATUS.UNSUPPORTED_DOCUMENT);
        }
    }

    private reserve(more: number): void {
        if (this.offset + more > this.maxBytes) {
            const at = this.offset + more;
            this.abort();
            throw new ProcessorError(
                `出力が${(at / 1048576).toFixed(1)} MiBを超え、上限の${(this.maxBytes / 1048576).toFixed(0)} MiBを超えるため、`
                + '書き出しを中止しました。',
                PLAN_STATUS.OVER_OUTPUT_BUDGET,
            );
        }
    }

    /** New bytes this writer made. */
    writeOwned(bytes: Uint8Array): void {
        this.assertOpen();
        if (this.owned + bytes.length > this.ownedLimit) {
            this.abort();
            throw new ProcessorError(
                '書き出し用に確保した量を超えるデータが発生したため、書き出しを中止しました。',
                PLAN_STATUS.OVER_MEMORY_BUDGET,
            );
        }
        this.reserve(bytes.length);
        this.chunks.push(bytes);
        this.offset += bytes.length;
        this.owned += bytes.length;
    }

    /** Bytes that already exist elsewhere (stream contents, compressor chunks). */
    writeView(bytes: Uint8Array): void {
        this.assertOpen();
        this.reserve(bytes.length);
        if (bytes.length > 0) this.chunks.push(bytes);
        this.offset += bytes.length;
    }

    /** Hands the chunks over. The writer holds nothing afterwards. */
    finish(): { chunks: Uint8Array[]; total: number } {
        this.assertOpen();
        const out = { chunks: this.chunks, total: this.offset };
        this.chunks = [];
        this.status = 'finished';
        return out;
    }

    /** Drops everything written. Idempotent. */
    abort(): void {
        this.chunks = [];
        if (this.status === 'open') this.status = 'aborted';
    }
}

export interface WriteControl {
    /** Throws when the run has been superseded. Called between objects. */
    check: () => void;
    yieldToTask: () => Promise<void>;
}

export interface WritePlan {
    /** Bytes the writer will allocate itself: headers, dictionaries, xref, trailer. */
    ownedBytes: number;
    /** The whole output, views included — what the publication Blob will copy. */
    totalBytes: number;
    /** Chunks the writer will hold (each one an array entry). */
    chunkCount: number;
}

const STREAM_OPEN = '\nstream\n';
const STREAM_CLOSE = '\nendstream';
const OBJECT_CLOSE = '\nendobj\n';

/**
 * The exact size of what `writeDocument` will write, computed without
 * allocating any of it — so Policy R can reserve the writer's own bytes and the
 * publication copy before the first one exists.
 *
 * It walks the same objects in the same order and sets the same /Length values
 * the writer will, so the numbers are not an estimate: the writer is held to
 * `ownedBytes` and refuses to pass it.
 */
export function planDocumentWrite(
    ctx: PDFContext,
    replacements: Map<PDFRawStream, StreamReplacement>,
): WritePlan {
    const root = ctx.trailerInfo.Root;
    if (!(root instanceof PDFRef)) {
        throw new ProcessorError('文書カタログ（/Root）を特定できないため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
    }
    let owned = (ctx.header as unknown as PDFObject).sizeInBytes() + 1;
    let total = owned;
    let chunks = 2;
    let maxNum = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        maxNum = Math.max(maxNum, ref.objectNumber);
        const head = `${ref.objectNumber} ${ref.generationNumber} obj\n`.length;
        owned += head + OBJECT_CLOSE.length;
        total += head + OBJECT_CLOSE.length;
        chunks += 2;
        if (obj instanceof PDFStream && !(obj instanceof PDFRawStream)) {
            // A parsed document holds raw streams only; anything else would be
            // encoded into a new buffer the plan has not priced.
            throw new ProcessorError('想定外の形式のストリームがあるため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
        }
        if (obj instanceof PDFRawStream) {
            const replacement = replacements.get(obj);
            const length = replacement ? replacement.length : obj.contents.length;
            obj.dict.set(N('Length'), PDFNumber.of(length));
            const fixed = obj.dict.sizeInBytes() + STREAM_OPEN.length + STREAM_CLOSE.length;
            owned += fixed;
            total += fixed + length;
            chunks += 3 + (replacement ? replacement.chunks.length : length > 0 ? 1 : 0);
        } else {
            owned += obj.sizeInBytes();
            total += obj.sizeInBytes();
            chunks += 1;
        }
    }
    const xrefAt = total;
    const xref = `xref\n0 ${maxNum + 1}\n`.length + 20 * (maxNum + 1);
    const trailer = trailerDict(ctx, root, maxNum).sizeInBytes();
    const tail = 'trailer\n'.length + trailer + `\nstartxref\n${xrefAt}\n%%EOF\n`.length;
    owned += xref + tail;
    total += xref + tail;
    chunks += 4;
    return { ownedBytes: owned, totalBytes: total, chunkCount: chunks };
}

function trailerDict(ctx: PDFContext, root: PDFRef, maxNum: number): PDFDict {
    const trailer = ctx.obj({}) as PDFDict;
    trailer.set(N('Size'), PDFNumber.of(maxNum + 1));
    trailer.set(N('Root'), root);
    if (ctx.trailerInfo.Info) trailer.set(N('Info'), ctx.trailerInfo.Info as PDFObject);
    if (ctx.trailerInfo.ID) trailer.set(N('ID'), ctx.trailerInfo.ID as PDFObject);
    return trailer;
}

const serialise = (obj: PDFObject): Uint8Array => {
    const out = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(out, 0);
    return out;
};

/**
 * Write the whole parsed document through `writer`.
 *
 * Objects go out in object-number order, so the same document and the same
 * replacements always produce the same bytes. A free-list is written for the
 * gaps, as the cross-reference format requires.
 */
export async function writeDocument(
    ctx: PDFContext,
    replacements: Map<PDFRawStream, StreamReplacement>,
    writer: ChunkedDocumentWriter,
    control: WriteControl,
): Promise<{ chunks: Uint8Array[]; total: number }> {
    try {
        const root = ctx.trailerInfo.Root;
        if (!(root instanceof PDFRef)) {
            throw new ProcessorError('文書カタログ（/Root）を特定できないため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
        }

        writer.writeOwned(serialise(ctx.header as unknown as PDFObject));
        writer.writeOwned(latin1('\n'));

        const objects = ctx.enumerateIndirectObjects()
            .sort((a, b) => a[0].objectNumber - b[0].objectNumber);
        const entries = new Map<number, { gen: number; offset: number }>();
        let maxNum = 0;
        let sinceCheck = 0;

        for (const [ref, obj] of objects) {
            if (entries.has(ref.objectNumber)) {
                throw new ProcessorError('同じ番号のオブジェクトが重複しているため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
            }
            maxNum = Math.max(maxNum, ref.objectNumber);
            entries.set(ref.objectNumber, { gen: ref.generationNumber, offset: writer.bytesWritten });
            writer.writeOwned(latin1(`${ref.objectNumber} ${ref.generationNumber} obj\n`));

            if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
                const replacement = obj instanceof PDFRawStream ? replacements.get(obj) : undefined;
                const contents = replacement
                    ? null
                    : obj instanceof PDFRawStream ? obj.contents : (obj as PDFStream).getContents();
                const length = replacement ? replacement.length : (contents as Uint8Array).length;
                const dict: PDFDict = obj.dict;
                dict.set(N('Length'), PDFNumber.of(length));
                writer.writeOwned(serialise(dict));
                writer.writeOwned(latin1(STREAM_OPEN));
                if (replacement) {
                    let written = 0;
                    for (const c of replacement.chunks) { writer.writeView(c); written += c.length; }
                    if (written !== replacement.length) {
                        throw new ProcessorError('置き換えた画像のデータ長が一致しないため、書き出しを中止しました。', PLAN_STATUS.UNSUPPORTED_DOCUMENT);
                    }
                } else {
                    writer.writeView(contents as Uint8Array);
                }
                writer.writeOwned(latin1(STREAM_CLOSE));
            } else {
                writer.writeOwned(serialise(obj));
            }
            writer.writeOwned(latin1(OBJECT_CLOSE));

            sinceCheck += 1;
            if (sinceCheck >= 256) {
                sinceCheck = 0;
                control.check();
                await control.yieldToTask();
            }
        }
        control.check();

        // ---- the cross-reference table, last ---------------------------------
        const xrefAt = writer.bytesWritten;
        const free: number[] = [];
        for (let n = 1; n <= maxNum; n += 1) if (!entries.has(n)) free.push(n);
        let x = `xref\n0 ${maxNum + 1}\n`;
        // Entry 0 heads the free list; each free entry names the next one.
        x += `${String(free[0] ?? 0).padStart(10, '0')} 65535 f \n`;
        let fi = 0;
        for (let n = 1; n <= maxNum; n += 1) {
            const e = entries.get(n);
            if (e) {
                x += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`;
            } else {
                fi += 1;
                x += `${String(free[fi] ?? 0).padStart(10, '0')} 00000 f \n`;
            }
        }
        writer.writeOwned(latin1(x));

        writer.writeOwned(latin1('trailer\n'));
        writer.writeOwned(serialise(trailerDict(ctx, root, maxNum)));
        writer.writeOwned(latin1(`\nstartxref\n${xrefAt}\n%%EOF\n`));
        return writer.finish();
    } catch (e) {
        writer.abort();
        throw e;
    }
}
