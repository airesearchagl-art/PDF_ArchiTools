/**
 * PDF text is a semantic value with an exact byte form. BLK-R4-1.
 *
 * The defect this module exists for ran through four readers at once: a source
 * text object was decoded to a JavaScript string and written back with
 * `PDFString.of(decodedText)`. pdf-lib writes a `PDFString` by copying each
 * UTF-16 code unit into a byte, so a Japanese name lost its high byte, and it
 * escapes nothing, so a `)` or a `\` in a field value ended the string early and
 * the rest of the object was parsed as syntax. Measured on form `/T` and `/V`,
 * named-destination keys and `/OCProperties /D /Name`; every one READY.
 *
 * The rule adopted from it: a decoded string is never written back as though it
 * were a serialization. Text that is carried **unchanged** goes back out as the
 * source's own token — the one serialization every reader already agrees with
 * the source about. Text that is **constructed** — a flattened or renamed field
 * name, a key converted from a legacy name — is encoded from its semantic value
 * as printable ASCII with its delimiters escaped, or as UTF-16BE with a byte
 * order mark. Both routes go through {@link pdfTextObject}; there is no other
 * text writer in M6.
 *
 * Reading follows PDF.js's lexer and `stringToPDFString` rather than pdf-lib's
 * `decodeText`, on purpose. pdf-lib reads a hex string with whitespace in it as
 * the wrong bytes, keeps the line feed of a `\` + CRLF continuation, decodes a
 * UTF-8 string with a byte order mark as PDFDocEncoding, and maps 0x16 to
 * U+0017. PDF.js is the reader this project renders with and the reader the gate
 * checks against, so "what the text is" is what it says. Where a value cannot be
 * decoded without guessing — malformed UTF-16, an octal escape wider than a byte,
 * a character that is not a hex digit — the answer is a refusal, not a
 * best-effort string.
 */
import { PDFHexString, PDFName, PDFString } from 'pdf-lib';

/** How the value was written in the source, kept only to be written back. */
export interface PdfTextToken {
    kind: 'literal' | 'hex';
    /** The characters between the delimiters, exactly as they were parsed. */
    raw: string;
}

/** A byte string read from a document, held without the document. */
export interface PdfBytes {
    /** The string's bytes, as a reader's lexer produces them. Identity and order. */
    bytes: Uint8Array;
    /** The source token, when the value is carried unchanged. */
    token: PdfTextToken | null;
}

/** A text string: its bytes, and what a reader shows for them. */
export interface PdfText extends PdfBytes {
    text: string;
}

export type PdfRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** PDF whitespace, which a hex string may contain anywhere. */
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * PDFDocEncoding, as PDF.js decodes it.
 *
 * Only the code points that differ from their byte are listed. A byte with no
 * entry decodes to the character with the same number — including the handful
 * PDFDocEncoding leaves undefined, which PDF.js passes through rather than
 * replacing, and which this module therefore passes through as well.
 */
const PDF_DOC_ENCODING: Record<number, number> = {
    0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9,
    0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
    0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026,
    0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
    0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030,
    0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
    0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01,
    0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
    0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142,
    0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
};

/** The bytes of a literal string, from the characters between its parentheses. */
function literalBytes(raw: string): PdfRead<Uint8Array> {
    const out: number[] = [];
    for (let i = 0; i < raw.length; i += 1) {
        const c = raw.charCodeAt(i);
        if (c > 0xff) return { ok: false, reason: 'holds a character that is not a byte' };
        if (c !== 0x5c) {
            out.push(c);
            continue;
        }
        i += 1;
        if (i >= raw.length) return { ok: false, reason: 'ends in a lone backslash' };
        const e = raw.charCodeAt(i);
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
            // A line continuation: the backslash and the end of line vanish,
            // CRLF included.
            if (raw.charCodeAt(i + 1) === 0x0a) i += 1;
        } else if (e === 0x0a) {
            // Likewise.
        } else if (e >= 0x30 && e <= 0x37) {
            let value = e - 0x30;
            for (let digits = 1; digits < 3; digits += 1) {
                const next = raw.charCodeAt(i + 1);
                if (!(next >= 0x30 && next <= 0x37)) break;
                value = value * 8 + (next - 0x30);
                i += 1;
            }
            if (value > 0xff) {
                return { ok: false, reason: 'holds an octal escape wider than a byte' };
            }
            out.push(value);
        } else if (e > 0xff) {
            return { ok: false, reason: 'holds a character that is not a byte' };
        } else {
            // `\\`, `\(`, `\)`, and any other character: the character itself.
            out.push(e);
        }
    }
    return { ok: true, value: Uint8Array.from(out) };
}

/** The bytes of a hex string, from the characters between its angle brackets. */
function hexBytes(raw: string): PdfRead<Uint8Array> {
    const out: number[] = [];
    let high = -1;
    for (let i = 0; i < raw.length; i += 1) {
        const c = raw.charCodeAt(i);
        if (PDF_WHITESPACE.has(c)) continue;
        let digit = -1;
        if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
        else if (c >= 0x41 && c <= 0x46) digit = c - 0x37;
        else if (c >= 0x61 && c <= 0x66) digit = c - 0x57;
        if (digit < 0) return { ok: false, reason: 'holds a character that is not a hex digit' };
        if (high < 0) {
            high = digit;
        } else {
            out.push((high << 4) | digit);
            high = -1;
        }
    }
    // An odd digit count ends as though a 0 followed it.
    if (high >= 0) out.push(high << 4);
    return { ok: true, value: Uint8Array.from(out) };
}

/**
 * What a reader shows for a text string's bytes.
 *
 * A byte order mark selects UTF-16 (either order) or UTF-8; anything else is
 * PDFDocEncoding. The Unicode forms are decoded strictly: a lone surrogate, an
 * odd byte count or an invalid sequence is a value that cannot be read, and it
 * is reported as one rather than decoded into something a reader would not show.
 */
export function decodePdfTextBytes(bytes: Uint8Array): PdfRead<string> {
    const bom16be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
    const bom16le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    const bom8 = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (bom16be || bom16le || bom8) {
        if ((bom16be || bom16le) && bytes.length % 2 !== 0) {
            return { ok: false, reason: 'is UTF-16 with an odd number of bytes' };
        }
        const encoding = bom16be ? 'utf-16be' : bom16le ? 'utf-16le' : 'utf-8';
        try {
            // The decoder consumes the byte order mark itself.
            return { ok: true, value: new TextDecoder(encoding, { fatal: true }).decode(bytes) };
        } catch {
            return { ok: false, reason: `is not valid ${encoding.toUpperCase()}` };
        }
    }
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(PDF_DOC_ENCODING[byte] ?? byte);
    return { ok: true, value: text };
}

/** The token a string object was written as, or null for anything else. */
function tokenOf(value: unknown): PdfTextToken | null {
    if (value instanceof PDFHexString) return { kind: 'hex', raw: value.asString() };
    if (value instanceof PDFString) return { kind: 'literal', raw: value.asString() };
    return null;
}

/**
 * A byte string, as a reader's lexer reads it.
 *
 * For values that are bytes rather than text — a default appearance string is
 * content-stream syntax, not something to decode as prose.
 */
export function readPdfBytes(value: unknown): PdfRead<PdfBytes> {
    const token = tokenOf(value);
    if (!token) return { ok: false, reason: 'is not a string' };
    const bytes = token.kind === 'hex' ? hexBytes(token.raw) : literalBytes(token.raw);
    if (!bytes.ok) return bytes;
    return { ok: true, value: { bytes: bytes.value, token } };
}

/** A text string, with its bytes, its text, and the token it came as. */
export function readPdfText(value: unknown): PdfRead<PdfText> {
    const read = readPdfBytes(value);
    if (!read.ok) return read;
    const text = decodePdfTextBytes(read.value.bytes);
    if (!text.ok) return text;
    return { ok: true, value: { ...read.value, text: text.value } };
}

/** The text of a string object, or null when it is not one that can be read. */
export function pdfTextOf(value: unknown): string | null {
    const read = readPdfText(value);
    return read.ok ? read.value.text : null;
}

/** Whether a string holds a surrogate that is not half of a pair. */
const hasLoneSurrogate = (text: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

/** Printable ASCII: the range a literal string can hold without a decoding question. */
const isPrintableAscii = (bytes: ArrayLike<number>): boolean => {
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] < 0x20 || bytes[i] > 0x7e) return false;
    }
    return true;
};

/**
 * Text this application constructs, as a value that can be written.
 *
 * Printable ASCII is kept as ASCII, which PDFDocEncoding reads identically;
 * anything else becomes UTF-16BE behind a byte order mark, which every reader
 * decodes the same way. A lone surrogate has no encoding and is refused.
 */
export function pdfTextFromString(text: string): PdfRead<PdfText> {
    if (hasLoneSurrogate(text)) return { ok: false, reason: 'holds a lone surrogate' };
    const units: number[] = [];
    for (let i = 0; i < text.length; i += 1) units.push(text.charCodeAt(i));
    if (isPrintableAscii(units)) {
        return { ok: true, value: { text, bytes: Uint8Array.from(units), token: null } };
    }
    const bytes = new Uint8Array(2 + units.length * 2);
    bytes[0] = 0xfe;
    bytes[1] = 0xff;
    units.forEach((unit, index) => {
        bytes[2 + index * 2] = unit >> 8;
        bytes[3 + index * 2] = unit & 0xff;
    });
    return { ok: true, value: { text, bytes, token: null } };
}

/**
 * The one writer of PDF strings in M6.
 *
 * A carried value goes back as its own token: pdf-lib parsed it by balancing the
 * same parentheses and escapes every reader balances, so writing the same
 * characters between the same delimiters reproduces the same object. A
 * constructed value is written from its bytes — printable ASCII as a literal
 * with `\`, `(` and `)` escaped, anything else as hex — so no byte can end the
 * string or be read as syntax.
 */
export function pdfTextObject(value: PdfBytes): PDFString | PDFHexString {
    if (value.token?.kind === 'literal') return PDFString.of(value.token.raw);
    if (value.token?.kind === 'hex') return PDFHexString.of(value.token.raw);
    if (isPrintableAscii(value.bytes)) {
        let escaped = '';
        for (const byte of value.bytes) {
            const char = String.fromCharCode(byte);
            escaped += char === '\\' || char === '(' || char === ')' ? `\\${char}` : char;
        }
        return PDFString.of(escaped);
    }
    let hex = '';
    for (const byte of value.bytes) hex += byte.toString(16).padStart(2, '0').toUpperCase();
    return PDFHexString.of(hex);
}

/**
 * Byte order, the order a name tree is sorted in.
 *
 * A reader looks a key up by comparing the string's bytes, and PDF.js compares
 * exactly these byte strings. Sorting by decoded text, or by locale, puts a
 * UTF-16 key among the ASCII ones by what it spells rather than by what it is,
 * and a reader binary-searching for it looks in the wrong place.
 */
export function comparePdfBytes(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

/** Bytes as a string of the same character codes, for byte-string syntax such as `/DA`. */
export const latin1 = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
};

/**
 * A name used as a destination identifier: a key of a catalog `/Dests`
 * dictionary, or a link that names its destination with a name object.
 *
 * A name is bytes, and PDF says nothing about which encoding those bytes are
 * text in, so only printable ASCII is read as text — the one range every reader
 * agrees on. And `#`: pdf-lib decodes `#xx` escapes only when the hex digits are
 * upper case, so `/F#6fo` reaches this module as the bytes `F#6fo` while PDF.js
 * reads `Foo`. A name holding `#` after pdf-lib has decoded it may be either,
 * and choosing would be guessing, so it is refused.
 */
export function readNameIdentifier(name: PDFName): PdfRead<PdfText> {
    const bytes = name.asBytes();
    if (bytes.includes(0x23)) {
        return { ok: false, reason: 'holds "#", whose escaping readers do not agree about' };
    }
    if (!isPrintableAscii(bytes)) {
        return { ok: false, reason: 'is not printable ASCII, so its text depends on the reader' };
    }
    return { ok: true, value: { text: latin1(bytes), bytes: Uint8Array.from(bytes), token: null } };
}
