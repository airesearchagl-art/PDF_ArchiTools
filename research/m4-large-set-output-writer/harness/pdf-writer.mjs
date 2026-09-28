/**
 * Prototype of the candidate owned Comparison-PDF writer.
 *
 * Append-only: every object is serialised to bytes the moment it is complete
 * and kept as a list of Uint8Array chunks. Nothing is ever held as a JS string
 * except short dictionaries, nothing is re-read, and an image stream is written
 * already compressed (FlateDecode or DCTDecode), so after a page is appended the
 * only thing it leaves behind is its compressed bytes.
 *
 * finish() returns the chunk list; in a browser `new Blob(chunks)` publishes it
 * without a concatenated copy. abort() drops everything. There is no partial
 * publication path: a writer that did not reach finish() returns nothing.
 *
 * Object layout (numbers fixed up front so Pages can be written last):
 *   1 Catalog, 2 Pages, 3 Font /Helvetica (WinAnsi), 4 Info, then per page:
 *   Image XObject, content stream, Page.
 */
const enc = new TextEncoder();

function pdfString(s) {
    // WinAnsi-safe literal: escape delimiters; replace non-Latin-1 with '?'
    // (the current jsPDF path has the same Helvetica limitation).
    let out = '';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
        else if (c === 0x2014) out += '\\227'; // em dash in WinAnsi
        else if (c < 32 || c > 255) out += '?';
        else out += ch;
    }
    return `(${out})`;
}

const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

export class OutputCeilingError extends Error {
    constructor(bytes, ceiling, pagesDone) {
        super(`output ${bytes} bytes would exceed the runtime ceiling ${ceiling} after ${pagesDone} page(s)`);
        this.name = 'OutputCeilingError';
        this.bytes = bytes;
        this.ceiling = ceiling;
        this.pagesDone = pagesDone;
    }
}

export class ChunkedPdfWriter {
    /** `maxBytes`: the Runtime Artifact Gate - actual cumulative bytes, checked before each append. */
    constructor({ maxBytes = Infinity } = {}) {
        this.maxBytes = maxBytes;
        this.chunks = [];
        this.offset = 0;
        this.xref = new Map();
        this.nextObj = 5;
        this.kids = [];
        this.closed = false;
        this.push(enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
        this.object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    }

    push(bytes) {
        this.chunks.push(bytes);
        this.offset += bytes.length;
    }

    object(n, body) {
        this.xref.set(n, this.offset);
        this.push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    }

    /** A stream whose payload is a list of already-encoded chunks. */
    streamObject(n, dict, payload) {
        const length = payload.reduce((s, c) => s + c.length, 0);
        this.xref.set(n, this.offset);
        this.push(enc.encode(`${n} 0 obj\n<< ${dict} /Length ${length} >>\nstream\n`));
        for (const c of payload) this.push(c);
        this.push(enc.encode('\nendstream\nendobj\n'));
        return length;
    }

    /**
     * One page = one full-bleed image + the verdict line the current writer
     * draws (artifacts.ts:204-205: 9 pt Helvetica at 8,14 from the top).
     * `image` = { width, height, dict, payload: Uint8Array[] }.
     */
    addImagePage({ widthPt, heightPt, image, title }) {
        if (this.closed) throw new Error('writer closed');
        // Page objects + trailer are a few hundred bytes; 4 KiB bounds them.
        const projected = this.offset + image.encodedBytes + 4096;
        if (projected > this.maxBytes) {
            const pagesDone = this.kids.length;
            this.abort();
            throw new OutputCeilingError(projected, this.maxBytes, pagesDone);
        }
        const imgN = this.nextObj++;
        const contentN = this.nextObj++;
        const pageN = this.nextObj++;
        const imageBytes = this.streamObject(
            imgN,
            `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${image.dict}`,
            image.payload,
        );
        const content = `q ${num(widthPt)} 0 0 ${num(heightPt)} 0 0 cm /Im0 Do Q\n`
            + `BT /F1 9 Tf 0 g 8 ${num(heightPt - 14)} Td ${pdfString(title)} Tj ET\n`;
        this.streamObject(contentN, '', [enc.encode(content)]);
        this.object(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(widthPt)} ${num(heightPt)}] `
            + `/Resources << /XObject << /Im0 ${imgN} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${contentN} 0 R >>`);
        this.kids.push(pageN);
        return { imageBytes, bytesSoFar: this.offset };
    }

    finish(info = {}) {
        if (this.closed) throw new Error('writer closed');
        this.closed = true;
        this.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
        this.object(2, `<< /Type /Pages /Kids [${this.kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${this.kids.length} >>`);
        this.object(4, `<< /Producer ${pdfString(info.producer ?? 'PDF ArchiTools research writer')} >>`);
        const size = this.nextObj;
        const xrefAt = this.offset;
        let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
        for (let n = 1; n < size; n += 1) {
            const at = this.xref.get(n);
            if (at === undefined) throw new Error(`object ${n} never written`);
            x += `${String(at).padStart(10, '0')} 00000 n \n`;
        }
        x += `trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
        this.push(enc.encode(x));
        const chunks = this.chunks;
        this.chunks = [];
        return chunks;
    }

    abort() {
        this.closed = true;
        this.chunks = [];
    }
}
