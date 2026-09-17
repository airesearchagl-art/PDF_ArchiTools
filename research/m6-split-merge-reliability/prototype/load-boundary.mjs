/**
 * A load boundary for pdf-lib 1.17.1: refuse, before `PDFDocument.load` is
 * called, what that load would expand without limit.
 *
 * Not production code. B3 exists because pdf-lib's load is eager and uncapped,
 * and everything B2 could bound comes after it. This module inspects the raw
 * bytes instead, with limits of its own, and says PASS or REFUSE. It never calls
 * pdf-lib, never builds the document's object graph, and never sends anything
 * anywhere.
 *
 * What pdf-lib's load can expand, from its source (cited in load-boundary.md):
 *
 *   - every object stream and cross-reference stream is decoded as the parser
 *     meets it, into a buffer that doubles with no upper limit;
 *   - an XRef stream's declared /Size or /Index sets how many entries — and how
 *     many pooled references — are built, whatever the decoded bytes hold;
 *   - an object stream's offsets are not bounds-checked, so one decoded region
 *     can be parsed as many objects as there are offsets;
 *   - whether a stream is one of those is decided by `dict.lookup('Type')`,
 *     which resolves an indirect /Type and decodes #xx escapes in names;
 *   - unparseable bytes are skipped until the next object header;
 *   - the encryption check runs only after all of it.
 *
 * So the boundary is built as a superset, and refuses whenever it cannot show a
 * document is inside it. It runs in stages, in this order, and every refusal
 * names the stage that made it:
 *
 *   input            the raw byte ceiling;
 *   raw-name-scan    /Encrypt, written any way a name can be written, appears
 *                    nowhere in the raw bytes;
 *   walk             a linear walk that follows pdf-lib's tokenizer and
 *                    stream-boundary rules, refuses anything pdf-lib would only
 *                    reach by skipping or recovering, refuses an indirect /Type
 *                    on any stream, and refuses a decode candidate whose names
 *                    pdf-lib and a case-blind #xx decode would read differently;
 *   attribution      every name in the raw bytes that could decode to ObjStm or
 *                    XRef is the direct /Type of a stream the walk found;
 *   declared-values  each decode candidate has a direct /Length that reaches
 *                    endstream, no filter or a single FlateDecode, and direct
 *                    declared values within caps;
 *   decode           decoding is streamed through pako and aborted as soon as a
 *                    per-stream or cumulative cap is crossed — never inflated
 *                    first and measured after;
 *   decoded-content  an object stream's decoded bytes do not name ObjStm, XRef
 *                    or Encrypt, and its objects start in increasing order and
 *                    end before the next begins.
 *
 * The raw name scan is a superset detector. It can refuse a document that holds
 * nothing dangerous (a false positive, counted as compatibility cost); it never
 * shows on its own that a document is safe. PASS needs every stage.
 *
 * Passing says nothing about the rest of the operation. B2's structural caps
 * still apply once the document is loaded.
 */
import pako from 'pako';

/** Research defaults for a caller that passes none. Not product values. */
export const DEFAULT_LIMITS = {
    maxInputBytes: 64 * 1024 * 1024,
    maxDecodedBytesPerStream: 4 * 1024 * 1024,
    maxDecodedBytesTotal: 8 * 1024 * 1024,
    maxDecodeStreams: 64,
    maxXrefEntries: 100000,
    maxObjectsPerObjectStream: 10000,
    maxNestingDepth: 64,
    inflateChunkBytes: 16384,
};

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isNumeric = (c) => isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e;
const kw = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

// Keyword byte sequences, as core/syntax/Keywords.js:7-82 defines them.
const K = {
    header: kw('%PDF-'), obj: kw('obj'), endobj: kw('endobj'), xref: kw('xref'), trailer: kw('trailer'),
    startxref: kw('startxref'), true: kw('true'), false: kw('false'), null: kw('null'),
    streamEOF1: kw('stream \r\n'), streamEOF2: kw('stream\r\n'), streamEOF3: kw('stream\r'), streamEOF4: kw('stream\n'),
    stream: kw('stream'), endstream: kw('endstream'),
    EOF1endstream: kw('\r\nendstream'), EOF2endstream: kw('\rendstream'), EOF3endstream: kw('\nendstream'),
};

class Refusal extends Error {
    constructor(code, reason, at = null) {
        super(reason);
        this.code = code;
        this.at = at;
    }
}
class BoundExceeded extends Error {}

/** The stages, in the order they run. */
export const STAGES = ['input', 'raw-name-scan', 'walk', 'attribution', 'declared-values', 'decode', 'decoded-content'];

/** A name as pdf-lib decodes it (uppercase hex only, core/objects/PDFName.js:9-10). */
const decodeStrict = (s) => s.replace(/#([\dABCDEF]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** A superset: either case of hex. Anything this matches, the boundary treats as meant. */
const decodeLoose = (s) => s.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const DECODE_TYPES = new Set(['ObjStm', 'XRef']);

function latin1(bytes, from, to) {
    let s = '';
    for (let i = from; i < to; i += 1) s += String.fromCharCode(bytes[i]);
    return s;
}

/**
 * A tokenizer over one byte range that follows pdf-lib's object parser
 * (core/parser/BaseParser.js, core/parser/PDFObjectParser.js) — the same
 * whitespace, comments, keywords, numbers, strings, names, arrays and
 * dictionaries — but throws a Refusal where pdf-lib would throw or recover.
 */
function tokenizer(b, limits, end = b.length, stats = null) {
    const t = { p: 0 };

    t.done = () => t.p >= end;
    t.skipWSC = () => {
        while (t.p < end && WS[b[t.p]]) t.p += 1;
        while (t.p < end && b[t.p] === 0x25) {
            while (t.p < end && b[t.p] !== 0x0a && b[t.p] !== 0x0d) t.p += 1;
            while (t.p < end && WS[b[t.p]]) t.p += 1;
        }
    };
    t.match = (k) => {
        if (t.p + k.length > end) return false;
        for (let i = 0; i < k.length; i += 1) if (b[t.p + i] !== k[i]) return false;
        t.p += k.length;
        return true;
    };
    t.rawInt = (what) => {
        const start = t.p;
        while (t.p < end && isDigit(b[t.p])) t.p += 1;
        if (t.p === start) throw new Refusal('MALFORMED_SYNTAX', `expected an integer for ${what}`, start);
        return Number(latin1(b, start, t.p));
    };
    t.rawNumber = () => {
        const start = t.p;
        while (t.p < end && isNumeric(b[t.p])) {
            const c = b[t.p];
            t.p += 1;
            if (c === 0x2e) break;
        }
        while (t.p < end && isDigit(b[t.p])) t.p += 1;
        const text = latin1(b, start, t.p);
        const value = Number(text);
        if (!text || !Number.isFinite(value)) throw new Refusal('MALFORMED_SYNTAX', `unreadable number "${text}"`, start);
        return value;
    };
    t.name = () => {
        const at = t.p;
        t.p += 1;
        const start = t.p;
        while (t.p < end && !WS[b[t.p]] && !DELIM[b[t.p]]) t.p += 1;
        const raw = latin1(b, start, t.p);
        return { kind: 'name', at, strict: decodeStrict(raw), loose: decodeLoose(raw) };
    };

    /** One object. `keep` retains array items, for the few arrays whose values matter. */
    t.value = (depth, keep = false) => {
        if (depth > limits.maxNestingDepth) throw new Refusal('NESTING_DEPTH', `nested deeper than ${limits.maxNestingDepth}`, t.p);
        if (stats) stats.parsedValues += 1;
        t.skipWSC();
        const at = t.p;
        if (t.match(K.true) || t.match(K.false) || t.match(K.null)) return { kind: 'keyword', at };
        const c = b[t.p];
        if (c === 0x3c && b[t.p + 1] === 0x3c) return t.dict(depth);
        if (c === 0x3c) {
            t.p += 1;
            while (t.p < end && b[t.p] !== 0x3e) {
                const h = b[t.p];
                const hex = isDigit(h) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66) || WS[h];
                if (!hex) throw new Refusal('MALFORMED_SYNTAX', 'a hex string holds a byte that is not hex', t.p);
                t.p += 1;
            }
            if (t.p >= end) throw new Refusal('MALFORMED_SYNTAX', 'an unterminated hex string', at);
            t.p += 1;
            return { kind: 'hex', at };
        }
        if (c === 0x28) {
            let nesting = 0;
            let escaped = false;
            while (t.p < end) {
                const x = b[t.p];
                t.p += 1;
                if (!escaped) {
                    if (x === 0x28) nesting += 1;
                    if (x === 0x29) nesting -= 1;
                }
                if (x === 0x5c) escaped = !escaped;
                else if (escaped) escaped = false;
                if (nesting === 0) return { kind: 'string', at };
            }
            throw new Refusal('MALFORMED_SYNTAX', 'an unbalanced string', at);
        }
        if (c === 0x2f) return t.name();
        if (c === 0x5b) {
            t.p += 1;
            t.skipWSC();
            const items = keep ? [] : null;
            let count = 0;
            while (b[t.p] !== 0x5d) {
                if (t.p >= end) throw new Refusal('MALFORMED_SYNTAX', 'an unterminated array', at);
                const item = t.value(depth + 1);
                if (keep) items.push(item);
                count += 1;
                t.skipWSC();
            }
            t.p += 1;
            return { kind: 'array', at, items, count };
        }
        if (t.p < end && isNumeric(c)) {
            const first = t.rawNumber();
            t.skipWSC();
            const lookahead = t.p;
            if (t.p < end && isDigit(b[t.p])) {
                const second = t.rawNumber();
                t.skipWSC();
                if (b[t.p] === 0x52) {
                    t.p += 1;
                    return { kind: 'ref', at, num: first, gen: second };
                }
            }
            t.p = lookahead;
            return { kind: 'number', at, value: first };
        }
        throw new Refusal('MALFORMED_SYNTAX', `a byte that starts no object (0x${(c ?? 0).toString(16)})`, at);
    };

    /** A dictionary, with the loop condition PDFObjectParser.parseDict uses. */
    t.dict = (depth) => {
        const at = t.p;
        t.p += 2;
        t.skipWSC();
        const entries = [];
        while (t.p < end && b[t.p] !== 0x3e && b[t.p + 1] !== 0x3e) {
            if (b[t.p] !== 0x2f) throw new Refusal('MALFORMED_SYNTAX', 'a dictionary key that is not a name', t.p);
            const key = t.name();
            const keep = ['Index', 'W', 'Filter'].includes(key.loose);
            const value = t.value(depth + 1, keep);
            entries.push({ key, value });
            t.skipWSC();
        }
        t.skipWSC();
        if (!(b[t.p] === 0x3e && b[t.p + 1] === 0x3e)) throw new Refusal('MALFORMED_SYNTAX', 'an unterminated dictionary', at);
        t.p += 2;
        return { kind: 'dict', at, entries };
    };
    return t;
}

/** The entries of a dictionary under one decoded key, in order. */
const valuesOf = (dict, key) => dict.entries.filter((e) => e.key.loose === key || e.key.strict === key).map((e) => e.value);

/** Every name in `b[from, to)` that could decode to one of `targets`, with its offset. */
function scanNames(b, from, to, targets) {
    const found = [];
    for (let i = from; i < to; i += 1) {
        if (b[i] !== 0x2f) continue;
        let j = i + 1;
        while (j < to && !WS[b[j]] && !DELIM[b[j]] && j - i <= 40) j += 1;
        if (j - i <= 40) {
            const raw = latin1(b, i + 1, j);
            const loose = decodeLoose(raw);
            if (targets.has(loose)) found.push({ at: i, name: loose });
        }
        i = j - 1;
    }
    return found;
}

/**
 * Stream data extent, as PDFObjectParser.parseDictOrStream finds it
 * (core/parser/PDFObjectParser.js:171-224): a direct numeric /Length that lands
 * on endstream, or else a scan that counts nested `stream` and `endstream`.
 */
function streamExtent(t, b, dict, startPos) {
    const start = t.p;
    const lengths = valuesOf(dict, 'Length');
    const length = lengths.length ? lengths[lengths.length - 1] : null;
    if (length && length.kind === 'number') {
        const target = start + length.value;
        if (Number.isInteger(target) && target >= start && target <= b.length) {
            t.p = target;
            t.skipWSC();
            if (t.match(K.endstream)) return { start, end: target, direct: true };
        }
        t.p = start;
    }
    let nesting = 1;
    let end = t.p;
    while (!t.done()) {
        end = t.p;
        if (t.match(K.stream)) nesting += 1;
        else if (t.match(K.EOF1endstream) || t.match(K.EOF2endstream) || t.match(K.EOF3endstream) || t.match(K.endstream)) nesting -= 1;
        else t.p += 1;
        if (nesting === 0) break;
    }
    if (nesting !== 0) throw new Refusal('MALFORMED_SYNTAX', 'a stream with no endstream', startPos);
    return { start, end, direct: false };
}

/**
 * Decode one FlateDecode stream with a hard stop. Nothing is kept unless `keep`.
 *
 * pako hands out its output one chunk of `chunkBytes` at a time, from inside
 * `push`. The first chunk that takes the running total past `limit` throws out
 * of `push`, so decoding stops there: at most `limit + chunkBytes` decoded
 * bytes ever exist, and the input after that point is never read.
 * `consumedInputBytes` and `chunks` are returned so a gate can see the stop.
 */
export function inflateBounded(data, limit, chunkBytes, keep = false) {
    const inflator = new pako.Inflate({ chunkSize: chunkBytes });
    let total = 0;
    let maxChunk = 0;
    let calls = 0;
    const chunks = keep ? [] : null;
    inflator.onData = (chunk) => {
        calls += 1;
        total += chunk.length;
        maxChunk = Math.max(maxChunk, chunk.length);
        if (total > limit) throw new BoundExceeded();
        if (keep) chunks.push(chunk);
    };
    const report = () => ({ materialized: total, maxChunk, chunks: calls, consumedInputBytes: inflator.strm.next_in, inputBytes: data.length });
    try {
        inflator.push(data, true);
    } catch (error) {
        if (error instanceof BoundExceeded) return { exceeded: true, ...report() };
        return { error: String(error?.message ?? error), ...report() };
    }
    if (!inflator.ended || inflator.err) {
        return { error: `the stream did not end cleanly (${inflator.msg || inflator.err || 'truncated'})`, ...report() };
    }
    let bytes = null;
    if (keep) {
        bytes = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { bytes.set(c, o); o += c.length; }
    }
    return { decoded: total, bytes, ...report() };
}

/**
 * Whether pdf-lib and a case-blind decode would read any top-level name of this
 * dictionary differently. pdf-lib decodes only uppercase #xx (`/Fi#6cter` stays
 * "Fi#6cter" to it and is "Filter" to a case-blind reader); on a stream that is
 * to be decoded, that difference could hide a /Filter or a /Length, so it is
 * refused rather than resolved.
 */
function ambiguousName(dict) {
    for (const { key, value } of dict.entries) {
        if (key.strict !== key.loose) return key;
        const names = value.kind === 'name' ? [value] : (value.items ?? []).filter((x) => x.kind === 'name');
        const odd = names.find((x) => x.strict !== x.loose);
        if (odd) return odd;
    }
    return null;
}

const directInt = (v) => v && v.kind === 'number' && Number.isInteger(v.value) && v.value >= 0;

/**
 * Inspect raw bytes. Returns
 *   { verdict: 'PASS', stage: null, stats }
 *   { verdict: 'REFUSE', code, stage, reason, at, stats }
 * where every code is a typed refusal, `stage` is the stage that refused, and
 * `stats` holds what was counted up to that point. Anything the boundary did not
 * expect — its own exception included — is a refusal, never a pass.
 */
export async function inspectLoadBoundary(input, limitsIn = {}) {
    const limits = { ...DEFAULT_LIMITS, ...limitsIn };
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const stats = {
        inputBytes: b.length,
        stagesCompleted: [],
        rawDecodeTypeNames: 0,
        attributedDecodeTypeNames: 0,
        parsedValues: 0,
        indirectObjects: 0,
        streams: 0,
        decodeStreams: 0,
        objectStreams: 0,
        xrefStreams: 0,
        xrefEntriesDeclared: 0,
        objectStreamObjects: 0,
        decodedBytesTotal: 0,
        maxStreamDecodedBytes: 0,
        maxMaterializedDecodedBytes: 0,
        maxRetainedDecodedBytes: 0,
        maxInflateChunkBytes: 0,
        inflateChunkBytes: limits.inflateChunkBytes,
        refusedDecode: null,
    };
    let stage = 'input';
    const complete = (next) => {
        stats.stagesCompleted.push(stage);
        stage = next;
    };

    try {
        if (b.length > limits.maxInputBytes) {
            throw new Refusal('INPUT_TOO_LARGE', `${b.length} bytes is over the ${limits.maxInputBytes}-byte input limit`);
        }
        complete('raw-name-scan');

        // The name superset.
        const typeNames = scanNames(b, 0, b.length, new Set([...DECODE_TYPES, 'Encrypt']));
        const encrypt = typeNames.find((n) => n.name === 'Encrypt');
        if (encrypt) throw new Refusal('ENCRYPTED', 'the bytes name /Encrypt', encrypt.at);
        stats.rawDecodeTypeNames = typeNames.length;
        complete('walk');

        // The walk.
        const t = tokenizer(b, limits, b.length, stats);
        let headerAt = -1;
        for (let i = 0; i + K.header.length <= b.length; i += 1) {
            let hit = true;
            for (let k = 0; k < K.header.length; k += 1) if (b[i + k] !== K.header[k]) { hit = false; break; }
            if (hit) { headerAt = i; break; }
        }
        if (headerAt < 0) throw new Refusal('NO_HEADER', 'no %PDF- header');
        t.p = headerAt + K.header.length;
        t.rawInt('the header major version');
        if (b[t.p] !== 0x2e) throw new Refusal('MALFORMED_SYNTAX', 'a header with no version dot', t.p);
        t.p += 1;
        t.rawInt('the header minor version');

        const candidates = [];
        for (;;) {
            t.skipWSC();
            if (t.done()) break;
            const at = t.p;
            if (isDigit(b[t.p])) {
                const num = t.rawInt('an object number');
                t.skipWSC();
                const gen = t.rawInt('a generation number');
                t.skipWSC();
                if (!t.match(K.obj)) throw new Refusal('MALFORMED_SYNTAX', 'an object header with no obj keyword', at);
                t.skipWSC();
                const valueAt = t.p;
                const value = t.value(0);
                stats.indirectObjects += 1;
                if (value.kind === 'dict') {
                    t.skipWSC();
                    if (t.match(K.streamEOF1) || t.match(K.streamEOF2) || t.match(K.streamEOF3) || t.match(K.streamEOF4) || t.match(K.stream)) {
                        stats.streams += 1;
                        const types = valuesOf(value, 'Type');
                        if (types.some((v) => v.kind === 'ref')) {
                            throw new Refusal('INDIRECT_TYPE_ON_STREAM', `object ${num} ${gen} has an indirect /Type`, value.at);
                        }
                        const decodeType = types.find((v) => v.kind === 'name' && (DECODE_TYPES.has(v.loose) || DECODE_TYPES.has(v.strict)));
                        if (decodeType && types.length > 1) {
                            throw new Refusal('DUPLICATE_KEY_ON_DECODE_STREAM', `object ${num} ${gen} declares /Type more than once`, value.at);
                        }
                        const extent = streamExtent(t, b, value, valueAt);
                        if (decodeType) {
                            const odd = ambiguousName(value);
                            if (odd) {
                                throw new Refusal('AMBIGUOUS_NAME_ESCAPE', `object ${num} ${gen} is a decode candidate with a name pdf-lib reads as "${odd.strict}" and a case-blind decode as "${odd.loose}"`, odd.at);
                            }
                            candidates.push({ num, gen, dict: value, kind: decodeType.loose === 'XRef' || decodeType.strict === 'XRef' ? 'XRef' : 'ObjStm', typeAt: decodeType.at, extent });
                            if (candidates.length > limits.maxDecodeStreams) {
                                throw new Refusal('TOO_MANY_DECODE_STREAMS', `more than ${limits.maxDecodeStreams} object or cross-reference streams`, at);
                            }
                        }
                    }
                }
                t.skipWSC();
                if (!t.match(K.endobj)) throw new Refusal('MALFORMED_SYNTAX', `object ${num} ${gen} has no endobj`, at);
            } else if (t.match(K.xref)) {
                t.skipWSC();
                while (!t.done() && isDigit(b[t.p])) {
                    t.rawInt('an xref field');
                    t.skipWSC();
                    t.rawInt('an xref field');
                    t.skipWSC();
                    if (b[t.p] === 0x6e || b[t.p] === 0x66) t.p += 1;
                    t.skipWSC();
                }
            } else if (t.match(K.trailer)) {
                t.skipWSC();
                if (!(b[t.p] === 0x3c && b[t.p + 1] === 0x3c)) throw new Refusal('MALFORMED_SYNTAX', 'a trailer with no dictionary', at);
                t.dict(0);
            } else if (t.match(K.startxref)) {
                t.skipWSC();
                t.rawInt('startxref');
            } else {
                throw new Refusal('UNEXPECTED_BYTES', 'bytes that are not an object, xref, trailer or startxref — pdf-lib would skip them and keep parsing', at);
            }
        }

        complete('attribution');

        // Attribution: every ObjStm/XRef name must be a candidate's direct /Type.
        const attributed = new Set(candidates.map((c) => c.typeAt));
        const stray = typeNames.find((n) => DECODE_TYPES.has(n.name) && !attributed.has(n.at));
        if (stray) {
            throw new Refusal('UNATTRIBUTED_DECODE_TYPE_NAME', `/${stray.name} appears where no stream's direct /Type is`, stray.at);
        }
        stats.attributedDecodeTypeNames = attributed.size;
        complete('declared-values');

        // Each candidate, in file order: declared values, decode, decoded content.
        for (const c of candidates) {
            stage = 'declared-values';
            const where = `${c.kind} ${c.num} ${c.gen}`;
            if (!c.extent.direct) {
                throw new Refusal('AMBIGUOUS_STREAM_LENGTH', `${where} has no direct /Length that reaches endstream`, c.dict.at);
            }
            const single = (key) => {
                const vs = valuesOf(c.dict, key);
                if (vs.length > 1) throw new Refusal('DUPLICATE_KEY_ON_DECODE_STREAM', `${where} declares /${key} more than once`, c.dict.at);
                return vs[0] ?? null;
            };
            const filter = single('Filter');
            if (filter && !(filter.kind === 'name' && (filter.loose === 'FlateDecode' || filter.strict === 'FlateDecode'))) {
                throw new Refusal('UNSUPPORTED_FILTER', `${where} uses a filter the boundary does not decode`, c.dict.at);
            }

            let keepDecoded = false;
            if (c.kind === 'XRef') {
                const size = single('Size');
                const index = single('Index');
                const w = single('W');
                if (!directInt(size)) throw new Refusal('AMBIGUOUS_DECLARED_VALUE', `${where} has no direct integer /Size`, c.dict.at);
                if (!w || w.kind !== 'array' || w.items.length !== 3 || !w.items.every((x) => directInt(x) && x.value <= 8)) {
                    throw new Refusal('AMBIGUOUS_DECLARED_VALUE', `${where} has no direct /W of three widths`, c.dict.at);
                }
                let entries = size.value;
                if (index) {
                    if (index.kind !== 'array' || index.items.length % 2 !== 0 || !index.items.every(directInt)) {
                        throw new Refusal('AMBIGUOUS_DECLARED_VALUE', `${where} has an /Index that is not direct integer pairs`, c.dict.at);
                    }
                    entries = 0;
                    for (let i = 1; i < index.items.length; i += 2) entries += index.items[i].value;
                }
                stats.xrefStreams += 1;
                stats.xrefEntriesDeclared += entries;
                if (stats.xrefEntriesDeclared > limits.maxXrefEntries) {
                    throw new Refusal('XREF_ENTRY_CAP', `${where} brings declared entries to ${stats.xrefEntriesDeclared}, over ${limits.maxXrefEntries}`, c.dict.at);
                }
            } else {
                const n = single('N');
                const first = single('First');
                if (!directInt(n) || !directInt(first)) throw new Refusal('AMBIGUOUS_DECLARED_VALUE', `${where} has no direct integer /N and /First`, c.dict.at);
                if (n.value > limits.maxObjectsPerObjectStream) {
                    throw new Refusal('OBJECT_STREAM_OBJECT_CAP', `${where} declares ${n.value} objects, over ${limits.maxObjectsPerObjectStream}`, c.dict.at);
                }
                c.n = n.value;
                c.first = first.value;
                keepDecoded = true;
                stats.objectStreams += 1;
            }

            const perStream = limits.maxDecodedBytesPerStream;
            const remaining = limits.maxDecodedBytesTotal - stats.decodedBytesTotal;
            const limit = Math.min(perStream, remaining);
            const code = limit < perStream ? 'DECODED_BYTES_TOTAL' : 'DECODED_BYTES_PER_STREAM';
            const raw = b.subarray(c.extent.start, c.extent.end);
            stage = 'decode';
            let decoded;
            if (filter) {
                const r = inflateBounded(raw, limit, limits.inflateChunkBytes, keepDecoded);
                stats.maxMaterializedDecodedBytes = Math.max(stats.maxMaterializedDecodedBytes, r.materialized);
                stats.maxInflateChunkBytes = Math.max(stats.maxInflateChunkBytes, r.maxChunk);
                if (r.exceeded) {
                    stats.refusedDecode = { limit, materialized: r.materialized, chunks: r.chunks, consumedInputBytes: r.consumedInputBytes, inputBytes: r.inputBytes };
                    throw new Refusal(code, `${where} decodes past ${limit} bytes`, c.dict.at);
                }
                if (r.error) throw new Refusal('DECODE_ERROR', `${where}: ${r.error}`, c.dict.at);
                decoded = { length: r.decoded, bytes: r.bytes };
            } else {
                if (raw.length > limit) throw new Refusal(code, `${where} holds ${raw.length} unfiltered bytes, over ${limit}`, c.dict.at);
                decoded = { length: raw.length, bytes: keepDecoded ? raw : null };
            }
            stats.decodeStreams += 1;
            stats.decodedBytesTotal += decoded.length;
            stats.maxStreamDecodedBytes = Math.max(stats.maxStreamDecodedBytes, decoded.length);
            if (decoded.bytes) stats.maxRetainedDecodedBytes = Math.max(stats.maxRetainedDecodedBytes, decoded.bytes.length);

            stage = 'decoded-content';
            if (c.kind === 'ObjStm') inspectObjectStream(c, decoded.bytes, limits, stats, where);
        }
        stats.stagesCompleted.push('declared-values', 'decode', 'decoded-content');

        return { verdict: 'PASS', stage: null, stats };
    } catch (error) {
        if (error instanceof Refusal) {
            return { verdict: 'REFUSE', code: error.code, stage, reason: error.message, at: error.at, stats };
        }
        return { verdict: 'REFUSE', code: 'INSPECTION_FAILED', stage, reason: String(error?.message ?? error), at: null, stats };
    }
}

/**
 * An object stream's decoded bytes, as PDFObjectStreamParser reads them
 * (core/parser/PDFObjectStreamParser.js:36-65): /N pairs, then an object at each
 * /First + offset. pdf-lib checks neither order nor overlap, so the boundary does.
 */
function inspectObjectStream(c, bytes, limits, stats, where) {
    const names = scanNames(bytes, 0, bytes.length, new Set([...DECODE_TYPES, 'Encrypt']));
    if (names.length > 0) {
        const n = names[0];
        throw new Refusal(n.name === 'Encrypt' ? 'ENCRYPTED' : 'DECODE_TYPE_NAME_IN_DECODED_CONTENT',
            `${where} decodes to bytes naming /${n.name}`, c.dict.at);
    }
    const t = tokenizer(bytes, limits, bytes.length, stats);
    const offsets = [];
    for (let i = 0; i < c.n; i += 1) {
        t.skipWSC();
        t.rawInt('an object-stream object number');
        t.skipWSC();
        offsets.push(t.rawInt('an object-stream offset'));
    }
    const tableEnd = t.p;
    for (let i = 0; i < offsets.length; i += 1) {
        const start = c.first + offsets[i];
        const next = i + 1 < offsets.length ? c.first + offsets[i + 1] : bytes.length;
        if (start < tableEnd || start >= bytes.length || (i + 1 < offsets.length && offsets[i + 1] <= offsets[i])) {
            throw new Refusal('OVERLAPPING_OBJECT_STREAM_OFFSETS', `${where} object ${i} starts at ${start}, not after the previous one`, c.dict.at);
        }
        t.p = start;
        const value = t.value(0);
        if (value.kind === 'dict') {
            const save = t.p;
            t.skipWSC();
            if (t.match(K.stream)) throw new Refusal('STREAM_IN_OBJECT_STREAM', `${where} holds a stream`, c.dict.at);
            t.p = save;
        }
        if (t.p > next) {
            throw new Refusal('OVERLAPPING_OBJECT_STREAM_OFFSETS', `${where} object ${i} runs past the start of the next`, c.dict.at);
        }
    }
    stats.objectStreamObjects += offsets.length;
}
