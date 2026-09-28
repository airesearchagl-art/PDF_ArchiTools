/**
 * The Comparison PDF's container: append-only, byte by byte, bounded.
 *
 * jsPDF holds a document as one JavaScript string and joins, copies and
 * re-copies it to save, and it catches its own exceptions: past V8's string
 * limit it hands back nothing at all (research/m4-large-set-output-writer,
 * report §5). This writer holds the file as the list of byte chunks it will
 * consist of. An object is serialised the moment it is complete; an image
 * stream arrives already compressed and is appended as it is; nothing is ever
 * re-read or joined. `finish()` writes the page tree, the xref and the trailer
 * and returns the chunks, which `new Blob(chunks)` publishes without a copy in
 * script.
 *
 * Nothing is published before `finish()`, and `abort()` drops everything. A
 * writer that did not finish has no output to hand anyone, so a partial file
 * cannot be mistaken for a complete one.
 *
 * Every byte is counted against `maxBytes` before it is appended.
 *
 * Object layout, numbered up front so the page tree can be written last:
 *   1 Catalog, 2 Pages, 3 Font (Helvetica, WinAnsi), 4 Info,
 *   then per page: Image XObject, content stream, Page.
 */
import type { EncodedImage } from './state-raster';

/**
 * Everything one page adds besides its image payload: the image dictionary
 * and stream framing, the content stream, the page dictionary, three xref
 * lines and its entry in /Kids. Asserted per page, so it is a bound the
 * budget may use, not an estimate.
 */
export const PAGE_OBJECTS_BYTES = 4096;
/** Header, font, catalog, info, page-tree framing, xref header and trailer. */
export const DOCUMENT_OBJECTS_BYTES = 16 * 1024;
/** A verdict line longer than this is shortened, so it stays inside the page allowance. */
export const MAX_TITLE_CHARS = 600;

const XREF_LINE = 20;
const KIDS_ENTRY = 16;
const encoder = new TextEncoder();

export class OutputCeilingError extends Error {
    readonly bytes: number;
    readonly ceiling: number;
    readonly pagesWritten: number;
    constructor(bytes: number, ceiling: number, pagesWritten: number) {
        super(`the Comparison PDF would reach ${bytes} bytes, over its ${ceiling}-byte ceiling, `
            + `after ${pagesWritten} page(s)`);
        this.name = 'OutputCeilingError';
        this.bytes = bytes;
        this.ceiling = ceiling;
        this.pagesWritten = pagesWritten;
    }
}

export class WriterStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WriterStateError';
    }
}

/**
 * A verdict line as a PDF literal string in WinAnsiEncoding.
 *
 * The standard Helvetica has no glyphs outside WinAnsi, so anything else is
 * written as '?'. jsPDF, given the same line through the same font, loses
 * the rest of the line entirely; here the page, the separator and the verdict
 * always survive.
 */
export function pdfTitleLiteral(title: string): string {
    let chars = Array.from(title);
    if (chars.length > MAX_TITLE_CHARS) chars = [...chars.slice(0, MAX_TITLE_CHARS - 3), '.', '.', '.'];
    let out = '';
    for (const ch of chars) {
        const c = ch.codePointAt(0) ?? 0x3F;
        if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
        else if (c === 0x2014) out += '\\227';
        else if (c < 0x20 || (c > 0x7E && c < 0xA0) || c > 0xFF) out += '?';
        else if (c > 0x7E) out += `\\${c.toString(8).padStart(3, '0')}`;
        else out += ch;
    }
    return `(${out})`;
}

function number(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export interface ImagePage {
    widthPt: number;
    heightPt: number;
    image: EncodedImage;
    /** The verdict line, or '' for a page that carries none (a notice). */
    title: string;
}

export class ChunkedPdfWriter {
    readonly maxBytes: number;
    private chunks: Uint8Array[] = [];
    private offset = 0;
    private readonly xref = new Map<number, number>();
    private nextObject = 5;
    private readonly kids: number[] = [];
    private state: 'open' | 'finished' | 'aborted' = 'open';

    constructor(maxBytes: number) {
        this.maxBytes = maxBytes;
        this.append(encoder.encode('%PDF-1.7\n%âãÏÓ\n'));
        this.object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    }

    /** Bytes the file holds so far. */
    get bytesWritten(): number {
        return this.offset;
    }

    get pages(): number {
        return this.kids.length;
    }

    get isOpen(): boolean {
        return this.state === 'open';
    }

    /**
     * Throws `OutputCeilingError` (and aborts) if `more` bytes beyond what is
     * already written, plus what finishing needs, would pass the ceiling.
     */
    reserve(more: number): void {
        const projected = this.offset + more + this.tailBytes(this.kids.length + 1);
        if (projected > this.maxBytes) {
            const pages = this.kids.length;
            this.abort();
            throw new OutputCeilingError(projected, this.maxBytes, pages);
        }
    }

    addImagePage(page: ImagePage): void {
        this.assertOpen();
        const { widthPt, heightPt, image } = page;
        const imageN = this.nextObject;
        const contentN = this.nextObject + 1;
        const pageN = this.nextObject + 2;

        const imageHead = encoder.encode(
            `${imageN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} `
            + `/Height ${image.height} ${image.dict} /Length ${image.encodedBytes} >>\nstream\n`,
        );
        const streamEnd = encoder.encode('\nendstream\nendobj\n');
        let text = `q ${number(widthPt)} 0 0 ${number(heightPt)} 0 0 cm /Im0 Do Q\n`;
        if (page.title) {
            // artifacts.ts (jsPDF): setFontSize(9), text at (8, 14) from the top.
            text += `BT /F1 9 Tf 0 g 8 ${number(heightPt - 14)} Td ${pdfTitleLiteral(page.title)} Tj ET\n`;
        }
        const content = encoder.encode(text);
        const contentObject = encoder.encode(`${contentN} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
        const pageObject = encoder.encode(
            `${pageN} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(widthPt)} ${number(heightPt)}] `
            + `/Resources << /XObject << /Im0 ${imageN} 0 R >> /Font << /F1 3 0 R >> >> `
            + `/Contents ${contentN} 0 R >>\nendobj\n`,
        );
        const objects = imageHead.length + streamEnd.length + contentObject.length + content.length
            + streamEnd.length + pageObject.length + 3 * XREF_LINE + KIDS_ENTRY;
        if (objects > PAGE_OBJECTS_BYTES) {
            throw new WriterStateError(`page objects take ${objects} bytes, over the ${PAGE_OBJECTS_BYTES}-byte allowance`);
        }
        let payload = 0;
        for (const c of image.chunks) payload += c.length;
        if (payload !== image.encodedBytes) {
            throw new WriterStateError(`image stream holds ${payload} bytes but declares ${image.encodedBytes}`);
        }
        this.reserve(objects - 3 * XREF_LINE - KIDS_ENTRY + payload);

        this.xref.set(imageN, this.offset);
        this.append(imageHead);
        for (const c of image.chunks) this.append(c);
        this.append(streamEnd);
        this.xref.set(contentN, this.offset);
        this.append(contentObject);
        this.append(content);
        this.append(streamEnd);
        this.xref.set(pageN, this.offset);
        this.append(pageObject);
        this.kids.push(pageN);
        this.nextObject += 3;
    }

    /** The file, as chunks. The writer holds nothing afterwards. */
    finish(): Uint8Array[] {
        this.assertOpen();
        if (this.kids.length === 0) throw new WriterStateError('a Comparison PDF needs at least one page');
        this.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
        this.object(2, `<< /Type /Pages /Kids [${this.kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${this.kids.length} >>`);
        this.object(4, '<< /Producer (PDF ArchiTools Comparator) >>');
        const size = this.nextObject;
        const xrefAt = this.offset;
        let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
        for (let n = 1; n < size; n += 1) {
            const at = this.xref.get(n);
            if (at === undefined) throw new WriterStateError(`object ${n} was never written`);
            xref += `${String(at).padStart(10, '0')} 00000 n \n`;
        }
        xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
        this.append(encoder.encode(xref));
        if (this.offset > this.maxBytes) {
            const pages = this.kids.length;
            const bytes = this.offset;
            this.abort();
            throw new OutputCeilingError(bytes, this.maxBytes, pages);
        }
        const chunks = this.chunks;
        this.chunks = [];
        this.state = 'finished';
        return chunks;
    }

    /** Drops every byte. Idempotent. */
    abort(): void {
        this.chunks = [];
        if (this.state === 'open') this.state = 'aborted';
    }

    private assertOpen(): void {
        if (this.state !== 'open') throw new WriterStateError(`writer is ${this.state}`);
    }

    /** What finishing a document of `pages` pages writes beyond the pages themselves. */
    private tailBytes(pages: number): number {
        return DOCUMENT_OBJECTS_BYTES - 1024 + pages * (KIDS_ENTRY + 3 * XREF_LINE);
    }

    private object(n: number, body: string): void {
        this.xref.set(n, this.offset);
        this.append(encoder.encode(`${n} 0 obj\n${body}\nendobj\n`));
    }

    private append(bytes: Uint8Array): void {
        this.chunks.push(bytes);
        this.offset += bytes.length;
    }
}
