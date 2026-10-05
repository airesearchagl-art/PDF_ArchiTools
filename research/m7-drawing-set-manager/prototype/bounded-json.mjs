/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Reading a Portable Project JSON as what it is: a file from outside.
 *
 * `JSON.parse` is the right parser -- it is the one every other consumer of the
 * file will agree with -- but it answers only one question, "is this JSON", and
 * it answers it after it has allocated everything. Three things have to be
 * settled before that, and one thing it cannot settle at all:
 *
 *   before   how many bytes        `file.size`, before anything is read
 *   before   is it UTF-8           a fatal decoder; a lone surrogate is refused
 *   before   how deep / how many   one pass over the text that builds nothing
 *   never    duplicate keys        `JSON.parse` keeps the last one and says
 *                                  nothing, so `{"schemaVersion":1, ...,
 *                                  "schemaVersion":2}` would be read as 2 by this
 *                                  app and as 1 by a tool that keeps the first
 *
 * The scan is deliberately not a parser. It tracks exactly what a bound needs:
 * where strings start and stop, how containers nest, which strings are keys. On
 * any text `JSON.parse` accepts that tracking is exact, so every bound it
 * reports is true; on text `JSON.parse` rejects it may be confused, and that
 * does not matter, because the text is rejected either way.
 */

export const IMPORT_STAGE = Object.freeze({
    BYTES: 'bytes',
    ENCODING: 'encoding',
    SCAN: 'scan',
    PARSE: 'parse',
    VERSION: 'version',
    SCHEMA: 'schema',
    RELATIONS: 'relations',
});

export const SCAN_REFUSAL = Object.freeze({
    PROJECT_TOO_LARGE: 'PROJECT_TOO_LARGE',
    EMPTY_INPUT: 'EMPTY_INPUT',
    NOT_UTF8: 'NOT_UTF8',
    NOT_AN_OBJECT: 'NOT_AN_OBJECT',
    NESTING_TOO_DEEP: 'NESTING_TOO_DEEP',
    TOO_MANY_VALUES: 'TOO_MANY_VALUES',
    STRING_TOO_LONG: 'STRING_TOO_LONG',
    KEY_TOO_LONG: 'KEY_TOO_LONG',
    TOO_MANY_KEYS: 'TOO_MANY_KEYS',
    DUPLICATE_KEY: 'DUPLICATE_KEY',
    UNTERMINATED: 'UNTERMINATED',
    INVALID_JSON: 'INVALID_JSON',
});

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

const isWhitespace = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

const refuse = (code, at, stats, detail = '') => ({ ok: false, code, at, detail, stats });

/**
 * One pass over the text. Builds nothing but the bookkeeping for the bounds.
 *
 * `at` in a refusal is a UTF-16 offset into the text, for a message; it is not
 * a byte offset and is never used to slice the input.
 */
export function scanJsonBounds(text, limits) {
    const stats = { length: text.length, values: 0, keys: 0, maxDepth: 0, maxStringSourceLength: 0 };
    const length = text.length;

    let i = 0;
    while (i < length && isWhitespace(text.charCodeAt(i))) i += 1;
    if (i >= length) return refuse(SCAN_REFUSAL.EMPTY_INPUT, 0, stats);
    if (text.charCodeAt(i) !== LBRACE) return refuse(SCAN_REFUSAL.NOT_AN_OBJECT, i, stats);

    // One frame per open container. `keys` is null for an array; for an object
    // it is the set of keys seen so far, which is the whole cost of the
    // duplicate check and is bounded by maxObjectKeys per object.
    const frames = [];
    let expectKey = false;
    // No token may be longer than this, key or value, so the scan stops walking
    // a string as soon as it is, instead of looking for a quote 30 MiB away.
    const longestToken = Math.max(limits.maxStringSourceLength, limits.maxKeySourceLength);

    while (i < length) {
        const c = text.charCodeAt(i);

        if (isWhitespace(c)) { i += 1; continue; }

        if (c === QUOTE) {
            const start = i;
            i += 1;
            let closed = false;
            while (i < length) {
                const s = text.charCodeAt(i);
                if (s === BACKSLASH) { i += 2; continue; }
                if (s === QUOTE) { closed = true; break; }
                i += 1;
                if (i - start - 1 > longestToken) return refuse(SCAN_REFUSAL.STRING_TOO_LONG, start, stats, `> ${longestToken}`);
            }
            if (!closed) return refuse(SCAN_REFUSAL.UNTERMINATED, start, stats);
            const sourceLength = i - start - 1;
            i += 1; // past the closing quote

            const frame = frames[frames.length - 1];
            if (frame && frame.keys && expectKey) {
                if (sourceLength > limits.maxKeySourceLength) {
                    return refuse(SCAN_REFUSAL.KEY_TOO_LONG, start, stats, `${sourceLength}`);
                }
                let key;
                try {
                    // Decoded, because "a" and "a" are the same key.
                    key = JSON.parse(text.slice(start, i));
                } catch {
                    return refuse(SCAN_REFUSAL.INVALID_JSON, start, stats, 'malformed key');
                }
                if (frame.keys.has(key)) return refuse(SCAN_REFUSAL.DUPLICATE_KEY, start, stats, key);
                // Checked before the key is kept, so no object's key set ever
                // grows past the bound however many keys the text offers.
                if (frame.keys.size >= limits.maxObjectKeys) return refuse(SCAN_REFUSAL.TOO_MANY_KEYS, start, stats, `> ${limits.maxObjectKeys}`);
                frame.keys.add(key);
                stats.keys += 1;
                expectKey = false;
            } else {
                if (sourceLength > stats.maxStringSourceLength) stats.maxStringSourceLength = sourceLength;
                if (sourceLength > limits.maxStringSourceLength) {
                    return refuse(SCAN_REFUSAL.STRING_TOO_LONG, start, stats, `${sourceLength}`);
                }
                stats.values += 1;
                if (stats.values > limits.maxJsonValues) return refuse(SCAN_REFUSAL.TOO_MANY_VALUES, start, stats);
            }
            continue;
        }

        if (c === LBRACE || c === LBRACKET) {
            stats.values += 1;
            if (stats.values > limits.maxJsonValues) return refuse(SCAN_REFUSAL.TOO_MANY_VALUES, i, stats);
            frames.push({ keys: c === LBRACE ? new Set() : null });
            if (frames.length > stats.maxDepth) stats.maxDepth = frames.length;
            if (frames.length > limits.maxNestingDepth) {
                return refuse(SCAN_REFUSAL.NESTING_TOO_DEEP, i, stats, `${frames.length}`);
            }
            expectKey = c === LBRACE;
            i += 1;
            continue;
        }

        if (c === RBRACE || c === RBRACKET) {
            if (frames.length === 0) return refuse(SCAN_REFUSAL.INVALID_JSON, i, stats, 'unbalanced close');
            frames.pop();
            expectKey = false;
            i += 1;
            continue;
        }

        if (c === COMMA) {
            const frame = frames[frames.length - 1];
            expectKey = !!(frame && frame.keys);
            i += 1;
            continue;
        }

        if (c === COLON) { i += 1; continue; }

        // A number or a literal: run to the next structural character. Whether
        // it is a *valid* one is JSON.parse's question, not this pass's.
        stats.values += 1;
        if (stats.values > limits.maxJsonValues) return refuse(SCAN_REFUSAL.TOO_MANY_VALUES, i, stats);
        i += 1;
        while (i < length) {
            const s = text.charCodeAt(i);
            if (s === COMMA || s === RBRACE || s === RBRACKET || s === COLON || s === QUOTE
                || s === LBRACE || s === LBRACKET || isWhitespace(s)) break;
            i += 1;
        }
    }

    if (frames.length !== 0) return refuse(SCAN_REFUSAL.UNTERMINATED, length, stats, 'unclosed container');
    return { ok: true, stats };
}

/**
 * Bytes -> text, refusing anything that is not well-formed UTF-8.
 *
 * A single leading BOM is dropped (the decoder's default): an editor that
 * re-saved the file may have added one, and it carries no content.
 */
export function decodeUtf8Strict(bytes) {
    try {
        return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
        return { ok: false };
    }
}

/**
 * The first three stages of an import: bytes, encoding, scan -- then the parse.
 *
 * Returns the parsed value or a refusal that names its stage. Nothing here
 * knows what a Project is; that is the schema's job, in the next stage.
 */
export function parseBounded(bytes, limits) {
    const timings = {};
    const mark = () => performance.now();
    let t = mark();

    if (!(bytes instanceof Uint8Array)) throw new TypeError('parseBounded expects a Uint8Array');
    if (bytes.length > limits.maxProjectBytes) {
        return { ok: false, stage: IMPORT_STAGE.BYTES, code: SCAN_REFUSAL.PROJECT_TOO_LARGE, at: null, detail: `${bytes.length}`, timings };
    }
    if (bytes.length === 0) {
        return { ok: false, stage: IMPORT_STAGE.BYTES, code: SCAN_REFUSAL.EMPTY_INPUT, at: null, detail: '', timings };
    }

    const decoded = decodeUtf8Strict(bytes);
    timings.decodeMs = mark() - t;
    if (!decoded.ok) {
        return { ok: false, stage: IMPORT_STAGE.ENCODING, code: SCAN_REFUSAL.NOT_UTF8, at: null, detail: '', timings };
    }

    t = mark();
    const scan = scanJsonBounds(decoded.text, limits);
    timings.scanMs = mark() - t;
    if (!scan.ok) {
        return { ok: false, stage: IMPORT_STAGE.SCAN, code: scan.code, at: scan.at, detail: scan.detail, stats: scan.stats, timings };
    }

    t = mark();
    let value;
    try {
        value = JSON.parse(decoded.text);
    } catch (error) {
        timings.parseMs = mark() - t;
        return {
            ok: false, stage: IMPORT_STAGE.PARSE, code: SCAN_REFUSAL.INVALID_JSON, at: null,
            // The engine's message can quote the input; keep it short.
            detail: String(error?.message ?? '').slice(0, 120), timings,
        };
    }
    timings.parseMs = mark() - t;
    return { ok: true, value, stats: scan.stats, timings };
}
