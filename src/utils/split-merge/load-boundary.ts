/**
 * The pre-parse hard Load Boundary.
 *
 * `PDFDocument.load()` may be called only on bytes this module PASSes
 * (H11-B3-1). It is the **primary** safety boundary; the disposable Worker
 * around it is defence in depth and bounds nothing on its own
 * (H11-B3-4, and `workerAloneCloses: false` in the record).
 *
 * Why a boundary before the parse, rather than a limit around it: pdf-lib 1.17.1
 * loads eagerly. Every object is parsed, and every object and cross-reference
 * stream is inflated with no cap — B2 measured a 33,149 B file decoding to
 * 33,554,457 B, 1,012x its input, with peak RSS up 80.3 MiB and nothing
 * observable at the phase boundary because the buffer had already been dropped.
 * Input bytes do not bound the load. So the bytes are inspected first, by a walk
 * that follows pdf-lib's own tokenizer and refuses wherever pdf-lib would
 * recover, guess, or expand.
 *
 * Structure of the answer:
 *
 *   { verdict: 'PASS',    stage: null, stats }
 *   { verdict: 'REFUSE',  code, stage, reason, at, stats }
 *
 * Anything unexpected — this module's own exceptions included — is a refusal,
 * never a pass. Silent failure is forbidden (H11-B3-5).
 *
 * What it does NOT do: it bounds the load's **structural** expansion, not heap
 * bytes per parsed object, which stays UNKNOWN (B2). It makes no memory preset
 * adoptable, M5's included. And passing says nothing about the rest of the
 * operation — B2's post-load structural caps still apply once the document is
 * loaded.
 *
 * Bound to pdf-lib 1.17.1. A pdf-lib version change re-opens the question and
 * requires the Load Boundary verification again (H11-B3-6).
 */
import { Inflate } from 'pako';
import type { LoadBoundaryLimits } from './policy';

/** The stages, in the order they run. A refusal names the one it happened in. */
export const LOAD_BOUNDARY_STAGES = [
    'input',
    'raw-name-scan',
    'walk',
    'attribution',
    'declared-values',
    'decode',
    'decoded-content',
] as const;

export type LoadBoundaryStage = typeof LOAD_BOUNDARY_STAGES[number];

/** Every way the boundary can say no. */
export const LOAD_REFUSAL = {
    INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
    ENCRYPTED: 'ENCRYPTED',
    NO_HEADER: 'NO_HEADER',
    MALFORMED_SYNTAX: 'MALFORMED_SYNTAX',
    NESTING_DEPTH: 'NESTING_DEPTH',
    UNEXPECTED_BYTES: 'UNEXPECTED_BYTES',
    INDIRECT_TYPE_ON_STREAM: 'INDIRECT_TYPE_ON_STREAM',
    DUPLICATE_KEY_ON_DECODE_STREAM: 'DUPLICATE_KEY_ON_DECODE_STREAM',
    AMBIGUOUS_NAME_ESCAPE: 'AMBIGUOUS_NAME_ESCAPE',
    AMBIGUOUS_STREAM_LENGTH: 'AMBIGUOUS_STREAM_LENGTH',
    AMBIGUOUS_DECLARED_VALUE: 'AMBIGUOUS_DECLARED_VALUE',
    UNSUPPORTED_FILTER: 'UNSUPPORTED_FILTER',
    TOO_MANY_DECODE_STREAMS: 'TOO_MANY_DECODE_STREAMS',
    XREF_ENTRY_CAP: 'XREF_ENTRY_CAP',
    OBJECT_STREAM_OBJECT_CAP: 'OBJECT_STREAM_OBJECT_CAP',
    DECODED_BYTES_PER_STREAM: 'DECODED_BYTES_PER_STREAM',
    DECODED_BYTES_TOTAL: 'DECODED_BYTES_TOTAL',
    DECODE_ERROR: 'DECODE_ERROR',
    DECODE_TYPE_NAME_IN_DECODED_CONTENT: 'DECODE_TYPE_NAME_IN_DECODED_CONTENT',
    OVERLAPPING_OBJECT_STREAM_OFFSETS: 'OVERLAPPING_OBJECT_STREAM_OFFSETS',
    STREAM_IN_OBJECT_STREAM: 'STREAM_IN_OBJECT_STREAM',
    UNATTRIBUTED_DECODE_TYPE_NAME: 'UNATTRIBUTED_DECODE_TYPE_NAME',
    INSPECTION_FAILED: 'INSPECTION_FAILED',
} as const;

export type LoadRefusalCode = typeof LOAD_REFUSAL[keyof typeof LOAD_REFUSAL];

/** Which byte range an offset is measured in. The prototype mixed the two. */
export type OffsetSpace = 'raw' | 'decoded';

export interface LoadBoundaryStats {
    inputBytes: number;
    stagesCompleted: LoadBoundaryStage[];
    rawDecodeTypeNames: number;
    attributedDecodeTypeNames: number;
    parsedValues: number;
    indirectObjects: number;
    streams: number;
    decodeStreams: number;
    objectStreams: number;
    xrefStreams: number;
    xrefEntriesDeclared: number;
    objectStreamObjects: number;
    decodedBytesTotal: number;
    maxStreamDecodedBytes: number;
    /** Includes the over-limit chunk, so a refused decode still reports. */
    maxMaterializedDecodedBytes: number;
    maxRetainedDecodedBytes: number;
    maxInflateChunkBytes: number;
    inflateChunkBytes: number;
    refusedDecode: {
        limit: number;
        materialized: number;
        chunks: number;
        consumedInputBytes: number;
        inputBytes: number;
    } | null;
}

export type LoadBoundaryVerdict =
    | { verdict: 'PASS'; stage: null; stats: LoadBoundaryStats }
    | {
        verdict: 'REFUSE';
        code: LoadRefusalCode;
        stage: LoadBoundaryStage;
        reason: string;
        at: number | null;
        atSpace: OffsetSpace | null;
        stats: LoadBoundaryStats;
    };

class Refusal extends Error {
    // Written out rather than declared as parameter properties: the build sets
    // `erasableSyntaxOnly`, so type-directed emit is not available here.
    readonly code: LoadRefusalCode;

    readonly at: number | null;

    readonly atSpace: OffsetSpace | null;

    constructor(
        code: LoadRefusalCode,
        reason: string,
        at: number | null = null,
        atSpace: OffsetSpace | null = null,
    ) {
        super(reason);
        this.name = 'LoadBoundaryRefusal';
        this.code = code;
        this.at = at;
        this.atSpace = atSpace;
    }
}

class BoundExceeded extends Error {}

// ---------------------------------------------------------------------------
// Byte classes and keywords, following pdf-lib's own tables.
// ---------------------------------------------------------------------------

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;

const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isNumeric = (c: number): boolean => isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e;

const kw = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

const K = {
    header: kw('%PDF-'),
    obj: kw('obj'),
    endobj: kw('endobj'),
    xref: kw('xref'),
    trailer: kw('trailer'),
    startxref: kw('startxref'),
    true: kw('true'),
    false: kw('false'),
    null: kw('null'),
    // Every end-of-line form pdf-lib accepts after `stream`, longest first.
    streamEOF1: kw('stream \r\n'),
    streamEOF2: kw('stream\r\n'),
    streamEOF3: kw('stream\r'),
    streamEOF4: kw('stream\n'),
    stream: kw('stream'),
    endstream: kw('endstream'),
};

/** The two `/Type` names that make a stream something pdf-lib will decode. */
const DECODE_TYPES = new Set(['ObjStm', 'XRef']);

/** Names that must never appear, anywhere, raw or decoded. */
const FORBIDDEN_NAMES = new Set(['Encrypt']);

const SCANNED_NAMES = new Set([...DECODE_TYPES, ...FORBIDDEN_NAMES]);

/**
 * The longest raw byte run that could still decode to one of the scanned names.
 *
 * Derived rather than hardcoded: every `#xx` escape costs three raw bytes for
 * one decoded character, so a name of N characters occupies at most 3N raw
 * bytes. The prototype used a flat 40, which is safe for these targets but is a
 * scan-coverage constant that has to move if a longer name is ever added.
 */
const MAX_SCANNED_NAME_RAW_BYTES = 3 * Math.max(...[...SCANNED_NAMES].map((n) => n.length));

const latin1 = (b: Uint8Array, from: number, to: number): string => {
    let s = '';
    for (let i = from; i < to; i += 1) s += String.fromCharCode(b[i]);
    return s;
};

/**
 * A name as pdf-lib decodes it: uppercase hex only
 * (`core/objects/PDFName.js:9-10`).
 */
const decodeStrict = (s: string): string =>
    s.replace(/#([\dABCDEF]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/** A superset: either case of hex. Anything this matches is treated as meant. */
const decodeLoose = (s: string): string =>
    s.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

// ---------------------------------------------------------------------------
// Tokenized values. Only what a check needs is retained.
// ---------------------------------------------------------------------------

type TokenName = { kind: 'name'; at: number; strict: string; loose: string };
type TokenNumber = { kind: 'number'; at: number; value: number };
type TokenRef = { kind: 'ref'; at: number };
type TokenKeyword = { kind: 'keyword'; at: number };
type TokenString = { kind: 'string'; at: number };
type TokenArray = { kind: 'array'; at: number; items: TokenValue[] };
type TokenDict = { kind: 'dict'; at: number; entries: { key: TokenName; value: TokenValue }[] };

type TokenValue =
    | TokenName
    | TokenNumber
    | TokenRef
    | TokenKeyword
    | TokenString
    | TokenArray
    | TokenDict;

/**
 * Every name in `b[from, to)` that could decode to one of `targets`.
 *
 * A **superset detector, not a proof**. It can refuse a document that holds
 * nothing dangerous — a `/Title` string that merely mentions `/ObjStm` is
 * refused — and that is a compatibility cost, counted as one. It never shows on
 * its own that a document is safe: a PASS needs every stage.
 */
function scanNames(
    b: Uint8Array,
    from: number,
    to: number,
    targets: Set<string>,
): { at: number; name: string }[] {
    const found: { at: number; name: string }[] = [];
    for (let i = from; i < to; i += 1) {
        if (b[i] !== 0x2f) continue;
        let j = i + 1;
        while (j < to && !WS[b[j]] && !DELIM[b[j]] && j - i <= MAX_SCANNED_NAME_RAW_BYTES) j += 1;
        if (j - i <= MAX_SCANNED_NAME_RAW_BYTES) {
            const loose = decodeLoose(latin1(b, i + 1, j));
            if (targets.has(loose)) found.push({ at: i, name: loose });
        }
        i = j - 1;
    }
    return found;
}

/**
 * A tokenizer over one byte range that follows pdf-lib's object parser
 * (`core/parser/BaseParser.js`, `core/parser/PDFObjectParser.js`) — the same
 * whitespace, comments, keywords, numbers, strings, names, arrays and
 * dictionaries — but refuses where pdf-lib would recover.
 *
 * Two pdf-lib quirks are reproduced on purpose, because the point is to walk the
 * bytes the way pdf-lib will and not the way the specification says it should:
 * `true` / `false` / `null` are matched with no trailing-delimiter check, and
 * the dictionary loop ends when **either** of the next two bytes is `>`.
 */
function tokenizer(
    b: Uint8Array,
    limits: LoadBoundaryLimits,
    end: number,
    stats: LoadBoundaryStats,
    space: OffsetSpace,
) {
    const t = {
        p: 0,

        skipWSC(): void {
            for (;;) {
                while (t.p < end && WS[b[t.p]]) t.p += 1;
                if (t.p < end && b[t.p] === 0x25) {
                    while (t.p < end && b[t.p] !== 0x0a && b[t.p] !== 0x0d) t.p += 1;
                    continue;
                }
                return;
            }
        },

        match(keyword: Uint8Array): boolean {
            if (t.p + keyword.length > end) return false;
            for (let i = 0; i < keyword.length; i += 1) {
                if (b[t.p + i] !== keyword[i]) return false;
            }
            t.p += keyword.length;
            return true;
        },

        peek(keyword: Uint8Array): boolean {
            if (t.p + keyword.length > end) return false;
            for (let i = 0; i < keyword.length; i += 1) {
                if (b[t.p + i] !== keyword[i]) return false;
            }
            return true;
        },

        rawInt(what: string): number {
            t.skipWSC();
            const start = t.p;
            while (t.p < end && isDigit(b[t.p])) t.p += 1;
            if (t.p === start) {
                throw new Refusal(
                    LOAD_REFUSAL.MALFORMED_SYNTAX,
                    `expected an integer for ${what}`,
                    start,
                    space,
                );
            }
            return Number(latin1(b, start, t.p));
        },

        rawNumber(): number {
            t.skipWSC();
            const start = t.p;
            while (t.p < end && isNumeric(b[t.p])) t.p += 1;
            const text = latin1(b, start, t.p);
            const value = Number(text);
            if (text.length === 0 || !Number.isFinite(value)) {
                throw new Refusal(
                    LOAD_REFUSAL.MALFORMED_SYNTAX,
                    `unreadable number "${text}"`,
                    start,
                    space,
                );
            }
            return value;
        },

        name(): TokenName {
            const at = t.p;
            t.p += 1;
            const start = t.p;
            while (t.p < end && !WS[b[t.p]] && !DELIM[b[t.p]]) t.p += 1;
            const raw = latin1(b, start, t.p);
            return { kind: 'name', at, strict: decodeStrict(raw), loose: decodeLoose(raw) };
        },

        /**
         * One value.
         *
         * `keep` controls whether an array's items are retained. Retaining every
         * array would make the walk's own memory a function of the document,
         * which is the problem this module exists to bound.
         */
        value(depth: number, keep = false): TokenValue {
            if (depth > limits.maxNestingDepth) {
                throw new Refusal(
                    LOAD_REFUSAL.NESTING_DEPTH,
                    `nested deeper than ${limits.maxNestingDepth}`,
                    t.p,
                    space,
                );
            }
            stats.parsedValues += 1;
            t.skipWSC();
            const at = t.p;

            if (t.match(K.true) || t.match(K.false) || t.match(K.null)) {
                return { kind: 'keyword', at };
            }

            const c = b[t.p];

            if (c === 0x3c && b[t.p + 1] === 0x3c) return t.dict(depth, keep);

            if (c === 0x3c) {
                t.p += 1;
                while (t.p < end && b[t.p] !== 0x3e) {
                    const h = b[t.p];
                    const hex = isDigit(h)
                        || (h >= 0x41 && h <= 0x46)
                        || (h >= 0x61 && h <= 0x66);
                    if (!hex && !WS[h]) {
                        throw new Refusal(
                            LOAD_REFUSAL.MALFORMED_SYNTAX,
                            'a hex string holds a byte that is not hex',
                            t.p,
                            space,
                        );
                    }
                    t.p += 1;
                }
                if (t.p >= end) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        'an unterminated hex string',
                        at,
                        space,
                    );
                }
                t.p += 1;
                return { kind: 'string', at };
            }

            if (c === 0x28) {
                t.p += 1;
                let nesting = 1;
                let escaped = false;
                while (t.p < end && nesting > 0) {
                    const ch = b[t.p];
                    if (escaped) escaped = false;
                    else if (ch === 0x5c) escaped = true;
                    else if (ch === 0x28) nesting += 1;
                    else if (ch === 0x29) nesting -= 1;
                    t.p += 1;
                }
                if (nesting !== 0) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        'an unbalanced string',
                        at,
                        space,
                    );
                }
                return { kind: 'string', at };
            }

            if (c === 0x2f) return t.name();

            if (c === 0x5b) {
                t.p += 1;
                const items: TokenValue[] = [];
                for (;;) {
                    t.skipWSC();
                    if (t.p >= end) {
                        throw new Refusal(
                            LOAD_REFUSAL.MALFORMED_SYNTAX,
                            'an unterminated array',
                            at,
                            space,
                        );
                    }
                    if (b[t.p] === 0x5d) {
                        t.p += 1;
                        return { kind: 'array', at, items };
                    }
                    const item = t.value(depth + 1, keep);
                    if (keep) items.push(item);
                }
            }

            if (t.p < end && isNumeric(c)) {
                const value = t.rawNumber();
                const lookahead = t.p;
                try {
                    t.skipWSC();
                    const secondStart = t.p;
                    while (t.p < end && isDigit(b[t.p])) t.p += 1;
                    if (t.p > secondStart) {
                        t.skipWSC();
                        if (b[t.p] === 0x52) {
                            t.p += 1;
                            return { kind: 'ref', at };
                        }
                    }
                } catch {
                    // A lookahead that cannot be read is simply not a reference.
                }
                t.p = lookahead;
                return { kind: 'number', at, value };
            }

            throw new Refusal(
                LOAD_REFUSAL.MALFORMED_SYNTAX,
                `a byte that starts no object (0x${(c ?? 0).toString(16)})`,
                at,
                space,
            );
        },

        /** A dictionary, with the loop condition `PDFObjectParser.parseDict` uses. */
        dict(depth: number, keepAll = false): TokenDict {
            const at = t.p;
            t.p += 2;
            t.skipWSC();
            const entries: { key: TokenName; value: TokenValue }[] = [];
            while (t.p < end && b[t.p] !== 0x3e && b[t.p + 1] !== 0x3e) {
                if (b[t.p] !== 0x2f) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        'a dictionary key that is not a name',
                        t.p,
                        space,
                    );
                }
                const key = t.name();
                // `/Index`, `/W` and `/Filter` are the arrays a later stage has
                // to read. Everything else is walked and discarded.
                const keep = keepAll || ['Index', 'W', 'Filter'].includes(key.loose);
                const value = t.value(depth + 1, keep);
                entries.push({ key, value });
                t.skipWSC();
            }
            t.skipWSC();
            if (!(b[t.p] === 0x3e && b[t.p + 1] === 0x3e)) {
                throw new Refusal(
                    LOAD_REFUSAL.MALFORMED_SYNTAX,
                    'an unterminated dictionary',
                    at,
                    space,
                );
            }
            t.p += 2;
            return { kind: 'dict', at, entries };
        },
    };
    return t;
}

/** The entries of a dictionary under one decoded key, in order. */
const valuesOf = (dict: TokenDict, key: string): TokenValue[] =>
    dict.entries.filter((e) => e.key.loose === key || e.key.strict === key).map((e) => e.value);

const directInt = (v: TokenValue | null | undefined): v is TokenNumber =>
    !!v && v.kind === 'number' && Number.isInteger(v.value) && v.value >= 0;

/**
 * Whether pdf-lib and a case-blind decode would read any name of this
 * dictionary differently.
 *
 * pdf-lib decodes only uppercase `#xx`, so `/Fi#6cter` stays `Fi#6cter` to it
 * and is `Filter` to a case-blind reader. On a stream that is going to be
 * decoded, that difference could hide a `/Filter` or a `/Length`, so it is
 * refused rather than resolved — a boundary that resolved the name would have
 * counted something other than what pdf-lib decodes.
 *
 * Widened from the prototype, which compared only top-level keys, top-level name
 * values and the items of retained arrays. A `#xx`-ambiguous name nested inside
 * another dictionary or inside an unretained array went uncompared. The walk
 * below is recursive over everything the token tree holds. Widening a refusal
 * can only refuse more, never less, so it cannot weaken the boundary.
 */
function ambiguousName(dict: TokenDict): TokenName | null {
    const seen = new Set<TokenValue>();
    const walk = (value: TokenValue): TokenName | null => {
        if (seen.has(value)) return null;
        seen.add(value);
        if (value.kind === 'name') return value.strict !== value.loose ? value : null;
        if (value.kind === 'array') {
            for (const item of value.items) {
                const odd = walk(item);
                if (odd) return odd;
            }
            return null;
        }
        if (value.kind === 'dict') {
            for (const { key, value: sub } of value.entries) {
                if (key.strict !== key.loose) return key;
                const odd = walk(sub);
                if (odd) return odd;
            }
        }
        return null;
    };
    return walk(dict);
}

interface StreamExtent {
    start: number;
    end: number;
    /** Whether a direct `/Length` reached `endstream` by itself. */
    direct: boolean;
}

/**
 * Where a stream's bytes begin and end.
 *
 * A direct `/Length` that lands exactly on `endstream` is the only form a
 * decode candidate is allowed to use; anything else is ambiguous, and the
 * fallback scan exists only so an ordinary stream can be stepped over.
 */
function streamExtent(
    b: Uint8Array,
    afterKeyword: number,
    dict: TokenDict,
    fileEnd: number,
    space: OffsetSpace,
): StreamExtent {
    const lengths = valuesOf(dict, 'Length');
    const last = lengths.length > 0 ? lengths[lengths.length - 1] : undefined;
    if (directInt(last)) {
        const end = afterKeyword + last.value;
        if (end <= fileEnd) {
            let p = end;
            while (p < fileEnd && WS[b[p]]) p += 1;
            let matches = true;
            for (let i = 0; i < K.endstream.length; i += 1) {
                if (b[p + i] !== K.endstream[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches) return { start: afterKeyword, end, direct: true };
        }
    }

    // Fall back to a nesting scan. `direct` stays false, so a decode candidate
    // that lands here is refused rather than decoded.
    let depth = 1;
    let p = afterKeyword;
    while (p < fileEnd) {
        if (b[p] === 0x73 && p + K.stream.length <= fileEnd) {
            let isStream = true;
            for (let i = 0; i < K.stream.length; i += 1) {
                if (b[p + i] !== K.stream[i]) {
                    isStream = false;
                    break;
                }
            }
            if (isStream) {
                depth += 1;
                p += K.stream.length;
                continue;
            }
        }
        if (b[p] === 0x65 && p + K.endstream.length <= fileEnd) {
            let isEnd = true;
            for (let i = 0; i < K.endstream.length; i += 1) {
                if (b[p + i] !== K.endstream[i]) {
                    isEnd = false;
                    break;
                }
            }
            if (isEnd) {
                depth -= 1;
                if (depth === 0) return { start: afterKeyword, end: p, direct: false };
                p += K.endstream.length;
                continue;
            }
        }
        p += 1;
    }
    throw new Refusal(
        LOAD_REFUSAL.MALFORMED_SYNTAX,
        'a stream with no endstream',
        afterKeyword,
        space,
    );
}

interface InflateReport {
    materialized: number;
    maxChunk: number;
    chunks: number;
    consumedInputBytes: number;
    inputBytes: number;
}

type InflateOutcome =
    | ({ exceeded: true; error?: undefined; decoded?: undefined; bytes?: undefined } & InflateReport)
    | ({ exceeded?: false; error: string; decoded?: undefined; bytes?: undefined } & InflateReport)
    | ({ exceeded?: false; error?: undefined; decoded: number; bytes: Uint8Array | null } & InflateReport);

/**
 * Decode one FlateDecode stream with a hard stop.
 *
 * pako hands out its output one chunk at a time, synchronously, from inside
 * `push`. The first chunk that takes the running total past `limit` throws out
 * of `push`, so decoding stops there: **at most `limit + chunkBytes` decoded
 * bytes ever exist**, and the compressed input after that point is never read.
 * `consumedInputBytes` is returned so a gate can see the stop actually happened
 * rather than take this comment's word for it.
 *
 * The over-limit chunk is counted and then dropped — the throw precedes the
 * push into `chunks` — so a refused decode never retains what took it over.
 */
export function inflateBounded(
    data: Uint8Array,
    limit: number,
    chunkBytes: number,
    keep = false,
): InflateOutcome {
    const inflator = new Inflate({ chunkSize: chunkBytes });
    let total = 0;
    let maxChunk = 0;
    let calls = 0;
    const chunks: Uint8Array[] | null = keep ? [] : null;

    inflator.onData = (chunk: Uint8Array) => {
        calls += 1;
        total += chunk.length;
        maxChunk = Math.max(maxChunk, chunk.length);
        if (total > limit) throw new BoundExceeded();
        if (chunks) chunks.push(chunk);
    };

    const report = (): InflateReport => ({
        materialized: total,
        maxChunk,
        chunks: calls,
        consumedInputBytes: inflator.strm.next_in,
        inputBytes: data.length,
    });

    try {
        inflator.push(data, true);
    } catch (error) {
        if (error instanceof BoundExceeded) return { exceeded: true, ...report() };
        return { error: String((error as Error)?.message ?? error), ...report() };
    }

    if (!inflator.ended || inflator.err) {
        const why = inflator.msg || inflator.err || 'truncated';
        return { error: `the stream did not end cleanly (${String(why)})`, ...report() };
    }

    let bytes: Uint8Array | null = null;
    if (chunks) {
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
    }
    return { decoded: total, bytes, ...report() };
}

interface Candidate {
    num: number;
    gen: number;
    dict: TokenDict;
    kind: 'ObjStm' | 'XRef';
    typeAt: number;
    extent: StreamExtent;
    n?: number;
    first?: number;
}

/**
 * Inspect raw bytes and answer PASS or a typed REFUSE, before
 * `PDFDocument.load()` is called.
 */
export function inspectLoadBoundary(
    input: Uint8Array,
    limits: LoadBoundaryLimits,
): LoadBoundaryVerdict {
    const b = input;
    const stats: LoadBoundaryStats = {
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

    let stage: LoadBoundaryStage = 'input';
    /**
     * Stages are recorded as they finish, including inside the per-candidate
     * loop. The prototype pushed the last three in one batch on the PASS path
     * only, so a refusal in the loop reported progress that stopped at
     * `attribution` even though later stages had run for earlier candidates.
     */
    const complete = (next: LoadBoundaryStage): void => {
        if (!stats.stagesCompleted.includes(stage)) stats.stagesCompleted.push(stage);
        stage = next;
    };

    try {
        // ---- input ---------------------------------------------------------
        if (b.length > limits.maxInputBytes) {
            throw new Refusal(
                LOAD_REFUSAL.INPUT_TOO_LARGE,
                `${b.length} bytes is over the ${limits.maxInputBytes}-byte input limit`,
                null,
                'raw',
            );
        }
        complete('raw-name-scan');

        // ---- raw-name-scan -------------------------------------------------
        const typeNames = scanNames(b, 0, b.length, SCANNED_NAMES);
        const encrypt = typeNames.find((n) => FORBIDDEN_NAMES.has(n.name));
        if (encrypt) {
            throw new Refusal(
                LOAD_REFUSAL.ENCRYPTED,
                'the bytes name /Encrypt',
                encrypt.at,
                'raw',
            );
        }
        stats.rawDecodeTypeNames = typeNames.length;
        complete('walk');

        // ---- walk ----------------------------------------------------------
        let headerAt = -1;
        for (let i = 0; i + K.header.length <= b.length; i += 1) {
            let ok = true;
            for (let j = 0; j < K.header.length; j += 1) {
                if (b[i + j] !== K.header[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                headerAt = i;
                break;
            }
        }
        if (headerAt < 0) {
            throw new Refusal(LOAD_REFUSAL.NO_HEADER, 'no %PDF- header', null, 'raw');
        }

        const t = tokenizer(b, limits, b.length, stats, 'raw');
        t.p = headerAt + K.header.length;
        t.rawInt('the header major version');
        if (b[t.p] !== 0x2e) {
            throw new Refusal(
                LOAD_REFUSAL.MALFORMED_SYNTAX,
                'a header with no version dot',
                t.p,
                'raw',
            );
        }
        t.p += 1;
        t.rawInt('the header minor version');

        const candidates: Candidate[] = [];

        for (;;) {
            t.skipWSC();
            if (t.p >= b.length) break;
            const at = t.p;
            const c = b[t.p];

            if (isDigit(c)) {
                const num = t.rawInt('an object number');
                const gen = t.rawInt('an object generation');
                t.skipWSC();
                if (!t.match(K.obj)) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        'an object header with no obj keyword',
                        at,
                        'raw',
                    );
                }
                stats.indirectObjects += 1;
                const value = t.value(0);

                if (value.kind === 'dict') {
                    t.skipWSC();
                    const isStream = t.match(K.streamEOF1)
                        || t.match(K.streamEOF2)
                        || t.match(K.streamEOF3)
                        || t.match(K.streamEOF4)
                        || t.match(K.stream);
                    if (isStream) {
                        stats.streams += 1;

                        const types = valuesOf(value, 'Type');
                        if (types.some((v) => v.kind === 'ref')) {
                            throw new Refusal(
                                LOAD_REFUSAL.INDIRECT_TYPE_ON_STREAM,
                                `object ${num} ${gen} has an indirect /Type`,
                                value.at,
                                'raw',
                            );
                        }

                        const decodeType = types.find(
                            (v): v is TokenName => v.kind === 'name'
                                && (DECODE_TYPES.has(v.loose) || DECODE_TYPES.has(v.strict)),
                        );
                        if (decodeType && types.length > 1) {
                            throw new Refusal(
                                LOAD_REFUSAL.DUPLICATE_KEY_ON_DECODE_STREAM,
                                `object ${num} ${gen} declares /Type more than once`,
                                value.at,
                                'raw',
                            );
                        }

                        const extent = streamExtent(b, t.p, value, b.length, 'raw');

                        if (decodeType) {
                            const odd = ambiguousName(value);
                            if (odd) {
                                throw new Refusal(
                                    LOAD_REFUSAL.AMBIGUOUS_NAME_ESCAPE,
                                    `object ${num} ${gen} is a decode candidate with a name pdf-lib `
                                    + `reads as "${odd.strict}" and a case-blind decode as "${odd.loose}"`,
                                    odd.at,
                                    'raw',
                                );
                            }
                            candidates.push({
                                num,
                                gen,
                                dict: value,
                                kind: decodeType.loose === 'XRef' || decodeType.strict === 'XRef'
                                    ? 'XRef'
                                    : 'ObjStm',
                                typeAt: decodeType.at,
                                extent,
                            });
                            if (candidates.length > limits.maxDecodeStreams) {
                                throw new Refusal(
                                    LOAD_REFUSAL.TOO_MANY_DECODE_STREAMS,
                                    `more than ${limits.maxDecodeStreams} object or cross-reference streams`,
                                    at,
                                    'raw',
                                );
                            }
                        }

                        t.p = extent.end;
                        t.skipWSC();
                        t.match(K.endstream);
                    }
                }

                t.skipWSC();
                if (!t.match(K.endobj)) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        `object ${num} ${gen} has no endobj`,
                        at,
                        'raw',
                    );
                }
                continue;
            }

            if (t.match(K.xref)) {
                for (;;) {
                    t.skipWSC();
                    if (t.p >= b.length || !isDigit(b[t.p])) break;
                    t.rawInt('an xref field');
                    t.rawInt('an xref field');
                    t.skipWSC();
                    if (b[t.p] === 0x6e || b[t.p] === 0x66) t.p += 1;
                }
                continue;
            }

            if (t.match(K.trailer)) {
                t.skipWSC();
                if (!(b[t.p] === 0x3c && b[t.p + 1] === 0x3c)) {
                    throw new Refusal(
                        LOAD_REFUSAL.MALFORMED_SYNTAX,
                        'a trailer with no dictionary',
                        t.p,
                        'raw',
                    );
                }
                t.dict(0);
                continue;
            }

            if (t.match(K.startxref)) {
                t.rawInt('startxref');
                continue;
            }

            throw new Refusal(
                LOAD_REFUSAL.UNEXPECTED_BYTES,
                'bytes that are not an object, xref, trailer or startxref — '
                + 'pdf-lib would skip them and keep parsing',
                at,
                'raw',
            );
        }
        complete('attribution');

        // ---- attribution ---------------------------------------------------
        //
        // Every raw `/ObjStm` or `/XRef` name in the file must be a candidate's
        // own direct `/Type`, matched by byte offset rather than by value. A name
        // anywhere else is a route this walk did not account for.
        const attributed = new Set(candidates.map((c) => c.typeAt));
        const stray = typeNames.find((n) => DECODE_TYPES.has(n.name) && !attributed.has(n.at));
        if (stray) {
            throw new Refusal(
                LOAD_REFUSAL.UNATTRIBUTED_DECODE_TYPE_NAME,
                `/${stray.name} appears where no stream's direct /Type is`,
                stray.at,
                'raw',
            );
        }
        stats.attributedDecodeTypeNames = attributed.size;
        complete('declared-values');

        // ---- per candidate: declared-values, decode, decoded-content --------
        for (const c of candidates) {
            stage = 'declared-values';
            const where = `object ${c.num} ${c.gen}`;
            stats.decodeStreams += 1;

            if (!c.extent.direct) {
                throw new Refusal(
                    LOAD_REFUSAL.AMBIGUOUS_STREAM_LENGTH,
                    `${where} has no direct /Length that reaches endstream`,
                    c.dict.at,
                    'raw',
                );
            }

            const single = (key: string): TokenValue | null => {
                const values = valuesOf(c.dict, key);
                if (values.length > 1) {
                    throw new Refusal(
                        LOAD_REFUSAL.DUPLICATE_KEY_ON_DECODE_STREAM,
                        `${where} declares /${key} more than once`,
                        c.dict.at,
                        'raw',
                    );
                }
                return values[0] ?? null;
            };

            // `/Length` is checked here too. The prototype left it out, so a
            // decode candidate could declare it twice and be measured against
            // whichever one `streamExtent` happened to take.
            single('Length');

            const filter = single('Filter');
            if (filter && !(filter.kind === 'name'
                && (filter.loose === 'FlateDecode' || filter.strict === 'FlateDecode'))) {
                throw new Refusal(
                    LOAD_REFUSAL.UNSUPPORTED_FILTER,
                    `${where} uses a filter the boundary does not decode`,
                    c.dict.at,
                    'raw',
                );
            }

            let keepDecoded = false;

            if (c.kind === 'XRef') {
                const size = single('Size');
                const index = single('Index');
                const w = single('W');
                if (!directInt(size)) {
                    throw new Refusal(
                        LOAD_REFUSAL.AMBIGUOUS_DECLARED_VALUE,
                        `${where} has no direct integer /Size`,
                        c.dict.at,
                        'raw',
                    );
                }
                if (!w || w.kind !== 'array' || w.items.length !== 3
                    || !w.items.every((x) => directInt(x) && x.value <= 8)) {
                    throw new Refusal(
                        LOAD_REFUSAL.AMBIGUOUS_DECLARED_VALUE,
                        `${where} has no direct /W of three widths`,
                        c.dict.at,
                        'raw',
                    );
                }
                let entries = size.value;
                if (index) {
                    if (index.kind !== 'array' || index.items.length % 2 !== 0
                        || !index.items.every(directInt)) {
                        throw new Refusal(
                            LOAD_REFUSAL.AMBIGUOUS_DECLARED_VALUE,
                            `${where} has an /Index that is not direct integer pairs`,
                            c.dict.at,
                            'raw',
                        );
                    }
                    entries = 0;
                    for (let i = 1; i < index.items.length; i += 2) {
                        entries += (index.items[i] as TokenNumber).value;
                    }
                }
                stats.xrefStreams += 1;
                stats.xrefEntriesDeclared += entries;
                if (stats.xrefEntriesDeclared > limits.maxXrefEntries) {
                    throw new Refusal(
                        LOAD_REFUSAL.XREF_ENTRY_CAP,
                        `${where} brings declared entries to ${stats.xrefEntriesDeclared}, `
                        + `over ${limits.maxXrefEntries}`,
                        c.dict.at,
                        'raw',
                    );
                }
            } else {
                const n = single('N');
                const first = single('First');
                if (!directInt(n) || !directInt(first)) {
                    throw new Refusal(
                        LOAD_REFUSAL.AMBIGUOUS_DECLARED_VALUE,
                        `${where} has no direct integer /N and /First`,
                        c.dict.at,
                        'raw',
                    );
                }
                if (n.value > limits.maxObjectsPerObjectStream) {
                    throw new Refusal(
                        LOAD_REFUSAL.OBJECT_STREAM_OBJECT_CAP,
                        `${where} declares ${n.value} objects, over ${limits.maxObjectsPerObjectStream}`,
                        c.dict.at,
                        'raw',
                    );
                }
                stats.objectStreams += 1;
                c.n = n.value;
                c.first = first.value;
                keepDecoded = true;
            }
            complete('decode');

            // ---- decode ----------------------------------------------------
            stage = 'decode';
            const perStream = limits.maxDecodedBytesPerStream;
            const remaining = limits.maxDecodedBytesTotal - stats.decodedBytesTotal;
            const limit = Math.min(perStream, remaining);
            // When the cumulative budget is what bound this stream, say so.
            const code = remaining < perStream
                ? LOAD_REFUSAL.DECODED_BYTES_TOTAL
                : LOAD_REFUSAL.DECODED_BYTES_PER_STREAM;
            const raw = b.subarray(c.extent.start, c.extent.end);

            let decodedLength: number;
            let decodedBytes: Uint8Array | null = null;

            if (filter) {
                const r = inflateBounded(raw, limit, limits.inflateChunkBytes, keepDecoded);
                stats.maxMaterializedDecodedBytes = Math.max(
                    stats.maxMaterializedDecodedBytes,
                    r.materialized,
                );
                stats.maxInflateChunkBytes = Math.max(stats.maxInflateChunkBytes, r.maxChunk);
                if (r.exceeded) {
                    stats.refusedDecode = {
                        limit,
                        materialized: r.materialized,
                        chunks: r.chunks,
                        consumedInputBytes: r.consumedInputBytes,
                        inputBytes: r.inputBytes,
                    };
                    throw new Refusal(code, `${where} decodes past ${limit} bytes`, c.dict.at, 'raw');
                }
                if (r.error !== undefined) {
                    throw new Refusal(
                        LOAD_REFUSAL.DECODE_ERROR,
                        `${where}: ${r.error}`,
                        c.dict.at,
                        'raw',
                    );
                }
                decodedLength = r.decoded;
                decodedBytes = r.bytes;
            } else {
                if (raw.length > limit) {
                    throw new Refusal(
                        code,
                        `${where} holds ${raw.length} unfiltered bytes, over ${limit}`,
                        c.dict.at,
                        'raw',
                    );
                }
                decodedLength = raw.length;
                decodedBytes = keepDecoded ? raw : null;
            }

            stats.decodedBytesTotal += decodedLength;
            stats.maxStreamDecodedBytes = Math.max(stats.maxStreamDecodedBytes, decodedLength);
            if (decodedBytes) {
                stats.maxRetainedDecodedBytes = Math.max(
                    stats.maxRetainedDecodedBytes,
                    decodedBytes.length,
                );
            }
            complete('decoded-content');

            // ---- decoded-content -------------------------------------------
            //
            // Only an object stream reaches here. A cross-reference stream's
            // decoded bytes are fixed-width binary entries, not object syntax:
            // pdf-lib reads them with `PDFXRefStreamParser`, which never
            // tokenizes a name out of them, so scanning them for `/Encrypt` or
            // `/ObjStm` would refuse on binary coincidence and prove nothing.
            // They are still counted against every decode cap above.
            stage = 'decoded-content';
            if (c.kind !== 'ObjStm' || !decodedBytes || c.n === undefined || c.first === undefined) {
                continue;
            }

            const inner = decodedBytes;
            const dangerous = scanNames(inner, 0, inner.length, SCANNED_NAMES);
            if (dangerous.length > 0) {
                const n = dangerous[0];
                throw new Refusal(
                    FORBIDDEN_NAMES.has(n.name)
                        ? LOAD_REFUSAL.ENCRYPTED
                        : LOAD_REFUSAL.DECODE_TYPE_NAME_IN_DECODED_CONTENT,
                    `${where} decodes to bytes naming /${n.name}`,
                    n.at,
                    'decoded',
                );
            }

            const it = tokenizer(inner, limits, inner.length, stats, 'decoded');
            const offsets: number[] = [];
            for (let i = 0; i < c.n; i += 1) {
                it.skipWSC();
                it.rawInt('an object-stream object number');
                it.skipWSC();
                offsets.push(it.rawInt('an object-stream offset'));
            }
            const tableEnd = it.p;

            for (let i = 0; i < offsets.length; i += 1) {
                const start = c.first + offsets[i];
                const next = i + 1 < offsets.length ? c.first + offsets[i + 1] : inner.length;
                if (start < tableEnd || start >= inner.length
                    || (i + 1 < offsets.length && offsets[i + 1] <= offsets[i])) {
                    throw new Refusal(
                        LOAD_REFUSAL.OVERLAPPING_OBJECT_STREAM_OFFSETS,
                        `${where} object ${i} starts at ${start}, not after the previous one`,
                        start,
                        'decoded',
                    );
                }
                it.p = start;
                const value = it.value(0);
                if (value.kind === 'dict') {
                    const save = it.p;
                    it.skipWSC();
                    if (it.peek(K.stream)) {
                        throw new Refusal(
                            LOAD_REFUSAL.STREAM_IN_OBJECT_STREAM,
                            `${where} holds a stream`,
                            start,
                            'decoded',
                        );
                    }
                    it.p = save;
                }
                if (it.p > next) {
                    throw new Refusal(
                        LOAD_REFUSAL.OVERLAPPING_OBJECT_STREAM_OFFSETS,
                        `${where} object ${i} runs past the start of the next`,
                        start,
                        'decoded',
                    );
                }
            }
            stats.objectStreamObjects += offsets.length;
        }

        if (!stats.stagesCompleted.includes(stage)) stats.stagesCompleted.push(stage);
        for (const s of LOAD_BOUNDARY_STAGES) {
            if (!stats.stagesCompleted.includes(s)) stats.stagesCompleted.push(s);
        }

        return { verdict: 'PASS', stage: null, stats };
    } catch (error) {
        if (error instanceof Refusal) {
            return {
                verdict: 'REFUSE',
                code: error.code,
                stage,
                reason: error.message,
                at: error.at,
                atSpace: error.atSpace,
                stats,
            };
        }
        // The boundary's own failure is a refusal, never a pass.
        return {
            verdict: 'REFUSE',
            code: LOAD_REFUSAL.INSPECTION_FAILED,
            stage,
            reason: String((error as Error)?.message ?? error),
            at: null,
            atSpace: null,
            stats,
        };
    }
}
