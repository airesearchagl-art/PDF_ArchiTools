/**
 * Whether a page leaves marked content open (RF-IR01-01).
 *
 * 半透明レイヤ追加 appends its overlay after the page's own content. pdf-lib
 * wraps that content in `q … Q`, which restores the graphics state and nothing
 * else: a `BMC` or `BDC` the page opens and never closes with `EMC` is still
 * open when the overlay is drawn, so the overlay ends up inside it. Inside an
 * existing layer that is OFF, the new layer then shows nothing when it is ON.
 * So before anything is drawn, every page's content is read in order and the
 * marked-content nesting must come out at zero, never going below it.
 *
 * This is a reader of the content stream's **tokens**, not a text search: an
 * operator is a run of regular characters standing on its own, and nothing
 * inside a string, a hex string, a comment, a name, a dictionary or an inline
 * image's data is one. The streams of a `/Contents` array are one sequence, so
 * a sequence may open in one stream and close in the next; a token, a string or
 * an inline image may not straddle two streams, and one that does is not read
 * as anything — it is refused.
 *
 * Bounded and streaming. Content is decoded through pako 2.1.0 one chunk at a
 * time and each chunk is read and dropped, so what is held is one chunk and the
 * reader's state, whatever the page's size; the decoded total of the whole
 * document is capped, and passing the cap is a refusal, not a partial answer.
 * Only unfiltered and FlateDecode content is decoded. Any other filter, and an
 * inline image whose end cannot be found without decoding it, are refused by
 * name: this check answers "closed" only when it has read every byte. An
 * inline image's data ends where its dimensions put it, or at its ASCIIHex /
 * ASCII85 end-of-data marker — never where a stated /L or /Length says, and
 * never at the first "EI" found in it; a dictionary that states a length is
 * refused.
 *
 * The Form XObjects a page paints with `Do` are read too (RF-IR01-R2-01): a
 * BDC a form leaves open is still open, in readers that carry marked content
 * across `Do`, when the overlay is drawn after the page. Each form is its own
 * unit and must close what it opens; names resolve through the form's own
 * `/Resources`, or, for a form without them, through the resources of where it
 * is painted. Forms that paint forms are followed to MAX_FORM_DEPTH, a
 * document's form checks are capped at MAX_FORM_CHECKS, and a form on its own
 * calling path is a cycle; each of those, and a name that resolves to nothing
 * or to an XObject that is neither an image nor a form, is a refusal. Forms
 * count toward the same decode limit as the pages.
 *
 * Nothing is repaired. A page or form that leaves a sequence open is refused,
 * not given the `EMC` it is missing.
 */
import { Inflate } from 'pako';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { ProcessorError } from './contracts';
import { PAKO2 } from './optimize-budget';

/** The most decoded content — pages and the forms they paint — this check reads in one document. */
export const MAX_PAGE_CONTENT_SCAN_BYTES = 256 * 1024 * 1024;

/** How deep a chain of Form XObjects painting Form XObjects this check follows from a page. */
export const MAX_FORM_DEPTH = 12;

/** How many form checks (one form, in one resource environment) one document may need. */
export const MAX_FORM_CHECKS = 2000;

/** A regular-character token longer than this is not a PDF token. */
const MAX_TOKEN_BYTES = 128;

export type MarkedContentCheck =
    | { ok: true; pages: number; forms: number; scannedBytes: number }
    | { ok: false; page: number; reason: string };

export interface MarkedContentOptions {
    maxDecodedBytes?: number;
    maxFormDepth?: number;
    maxFormChecks?: number;
    /** Called before each content stream; the runner passes its cancellation check. */
    beforeStream?: () => void;
}

/** A refusal raised from inside the reader, with the sentence the person sees. */
class ContentRefusal extends Error {}
class OverLimit extends Error {}

const isWhite = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
const isDelimiter = (b: number) => b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b
    || b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25;
const isHexDigit = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

const State = {
    Normal: 0,
    Comment: 1,
    Str: 2,
    StrEscape: 3,
    Hex: 4,
    Name: 5,
    LessThan: 6,
    GreaterThan: 7,
    ImageData: 8,
    ImageHexData: 9,
    ImageA85Data: 10,
    ImageA85Tilde: 11,
} as const;
type State = typeof State[keyof typeof State];

/** One token of an inline image's dictionary, kept until `ID` says how long its data is. */
type ImageToken =
    | { k: 'name'; v: string }
    | { k: 'word'; v: string }
    | { k: 'open' }
    | { k: 'close' }
    | { k: 'other' };

const unreadable = (detail: string) => new ContentRefusal(`ページ内容を読み取れません（${detail}）。`);
const inlineImage = (detail: string) => new ContentRefusal(
    `ページ内容のインライン画像の終わりを確かめられません（${detail}）。`,
);

/**
 * The bytes an inline image's data occupies, from its dictionary — or which
 * end-of-data marker closes it when it is ASCII-encoded.
 */
function imageExtent(tokens: ImageToken[]): { kind: 'bytes'; length: number } | { kind: 'hex' | 'a85' } {
    const entries = new Map<string, ImageToken[]>();
    for (let i = 0; i < tokens.length;) {
        const key = tokens[i];
        if (key.k !== 'name') throw inlineImage('辞書のキーが名前ではありません');
        i += 1;
        if (i >= tokens.length) throw inlineImage('値のないキーがあります');
        const value: ImageToken[] = [];
        if (tokens[i].k === 'open') {
            let depth = 0;
            do {
                const t = tokens[i];
                if (t.k === 'open') depth += 1;
                if (t.k === 'close') depth -= 1;
                value.push(t);
                i += 1;
            } while (depth > 0 && i < tokens.length);
            if (depth !== 0) throw inlineImage('閉じていない配列があります');
        } else {
            value.push(tokens[i]);
            i += 1;
        }
        entries.set(key.v, value);
    }
    const one = (...keys: string[]) => {
        for (const key of keys) if (entries.has(key)) return entries.get(key)!;
        return undefined;
    };
    const integer = (...keys: string[]): number | null => {
        const v = one(...keys);
        if (!v || v.length !== 1 || v[0].k !== 'word' || !/^\d+$/.test(v[0].v)) return null;
        return Number(v[0].v);
    };

    // RF-IR01-01, review R1: /L (PDF 2.0) or /Length states the data's length,
    // but nothing makes a reader honour it. Skipping that many bytes would read
    // as image data whatever lies there — an EI, and a BDC a reader that ends
    // the data at that EI opens. The extent is taken only from what fixes it
    // (dimensions, or an ASCII end-of-data marker); a dictionary that states
    // its own length is refused, whatever the value, rather than trusted.
    if (entries.has('L') || entries.has('Length')) {
        throw inlineImage('長さの指定（/L・/Length）があるインライン画像は、データの終わりを確かめられないため受け付けません');
    }

    const filter = one('F', 'Filter');
    if (filter) {
        const first = filter.find((t) => t.k === 'name' || t.k === 'word');
        const name = first && first.k === 'name' ? first.v : null;
        if (name === 'AHx' || name === 'ASCIIHexDecode') return { kind: 'hex' };
        if (name === 'A85' || name === 'ASCII85Decode') return { kind: 'a85' };
        if (filter.some((t) => t.k === 'name')) throw inlineImage(`圧縮された画像（/${name ?? '?'}）`);
    }

    const width = integer('W', 'Width');
    const height = integer('H', 'Height');
    if (width === null || height === null) throw inlineImage('幅と高さが読めません');
    const mask = one('IM', 'ImageMask');
    const isMask = !!mask && mask.length === 1 && mask[0].k === 'word' && mask[0].v === 'true';
    let bpc = integer('BPC', 'BitsPerComponent');
    let components = 1;
    if (isMask) {
        bpc = 1;
    } else {
        const cs = one('CS', 'ColorSpace');
        const head = cs?.find((t) => t.k === 'name');
        const name = head && head.k === 'name' ? head.v : null;
        if (name === 'G' || name === 'DeviceGray' || name === 'CalGray' || name === 'I' || name === 'Indexed') components = 1;
        else if (name === 'RGB' || name === 'DeviceRGB' || name === 'CalRGB') components = 3;
        else if (name === 'CMYK' || name === 'DeviceCMYK') components = 4;
        else throw inlineImage(`色空間（/${name ?? '?'}）`);
        if (cs && cs[0].k === 'name' && (name === 'I' || name === 'Indexed')) throw inlineImage('色空間の配列が読めません');
    }
    if (bpc === null || ![1, 2, 4, 8, 16].includes(bpc)) throw inlineImage('ビット数が読めません');
    return { kind: 'bytes', length: height * Math.ceil((width * components * bpc) / 8) };
}

/**
 * The token reader. `feed` takes the decoded content a chunk at a time; a
 * stream ends with `endStream`, and the unit — a page's content, or one Form
 * XObject's — with `endUnit`.
 */
class MarkedContentReader {
    depth = 0;
    /** The XObject names this unit paints with `Do`, in order. */
    readonly calls: string[] = [];
    private state: State = State.Normal;
    private token = '';
    private stringDepth = 0;
    /** Inside `BI … ID`: the dictionary's tokens. */
    private image: ImageToken[] | null = null;
    private imageRemaining = 0;
    /** An inline image's data has ended; the next token must be `EI`. */
    private expectEI = false;
    /** The name operand just before the current position, for `Do`. */
    private lastName: string | null = null;

    /** What this unit is, in a refusal: "ページ内容", or the form it is. */
    private readonly label: string;

    constructor(label: string) {
        this.label = label;
    }

    feed(chunk: Uint8Array): void {
        for (let i = 0; i < chunk.length; i += 1) {
            const b = chunk[i];
            switch (this.state) {
                case State.ImageData: {
                    const take = Math.min(this.imageRemaining, chunk.length - i);
                    this.imageRemaining -= take;
                    i += take - 1;
                    if (this.imageRemaining === 0) {
                        this.state = State.Normal;
                        this.expectEI = true;
                    }
                    break;
                }
                case State.ImageHexData:
                    if (b === 0x3e) {
                        this.state = State.Normal;
                        this.expectEI = true;
                    }
                    break;
                case State.ImageA85Data:
                    if (b === 0x7e) this.state = State.ImageA85Tilde;
                    break;
                case State.ImageA85Tilde:
                    if (b === 0x3e) {
                        this.state = State.Normal;
                        this.expectEI = true;
                    } else {
                        throw inlineImage('ASCII85の終わりの印が不正です');
                    }
                    break;
                case State.Comment:
                    if (b === 0x0a || b === 0x0d) this.state = State.Normal;
                    break;
                case State.Str:
                    if (b === 0x5c) this.state = State.StrEscape;
                    else if (b === 0x28) this.stringDepth += 1;
                    else if (b === 0x29) {
                        this.stringDepth -= 1;
                        if (this.stringDepth === 0) this.state = State.Normal;
                    }
                    break;
                case State.StrEscape:
                    this.state = State.Str;
                    break;
                case State.Hex:
                    if (b === 0x3e) this.state = State.Normal;
                    else if (!isHexDigit(b) && !isWhite(b)) throw unreadable('16進文字列に16進数でない文字があります');
                    break;
                case State.LessThan:
                    // `<<` opens a dictionary; anything else began a hex string.
                    if (b === 0x3c) {
                        this.state = State.Normal;
                        this.imageToken({ k: 'other' });
                    } else {
                        this.state = State.Hex;
                        this.imageToken({ k: 'other' });
                        i -= 1;
                    }
                    break;
                case State.GreaterThan:
                    if (b !== 0x3e) throw unreadable('対応のない「>」があります');
                    this.state = State.Normal;
                    this.imageToken({ k: 'other' });
                    break;
                case State.Name:
                    if (isWhite(b) || isDelimiter(b)) {
                        this.nameEnded();
                        i -= 1;
                    } else {
                        this.append(b);
                    }
                    break;
                case State.Normal:
                    this.normal(b);
                    break;
            }
        }
    }

    private append(b: number): void {
        if (this.token.length >= MAX_TOKEN_BYTES) throw unreadable('長すぎる語があります');
        this.token += String.fromCharCode(b);
    }

    /** A dictionary token of an inline image; outside one, nothing to keep. */
    private imageToken(t: ImageToken): void {
        if (this.expectEI) throw inlineImage('画像データの後に「EI」がありません');
        if (t.k !== 'name') this.lastName = null;
        if (this.image) this.image.push(t);
    }

    /** A name has ended: an inline image's key or value, or an operand. */
    private nameEnded(): void {
        const name = this.token;
        this.token = '';
        this.state = State.Normal;
        this.imageToken({ k: 'name', v: name });
        this.lastName = this.image ? null : name;
    }

    private normal(b: number): void {
        if (isWhite(b)) {
            this.flush(true);
            return;
        }
        if (!isDelimiter(b)) {
            this.append(b);
            return;
        }
        this.flush(false);
        switch (b) {
            case 0x25: this.state = State.Comment; return;
            case 0x28: this.imageToken({ k: 'other' }); this.state = State.Str; this.stringDepth = 1; return;
            case 0x29: throw unreadable('対応のない「)」があります');
            case 0x3c: this.state = State.LessThan; return;
            case 0x3e: this.state = State.GreaterThan; return;
            case 0x2f: this.state = State.Name; return;
            case 0x5b: this.imageToken({ k: 'open' }); return;
            case 0x5d: this.imageToken({ k: 'close' }); return;
            default: this.imageToken({ k: 'other' });
        }
    }

    /** A run of regular characters has ended: an operand, or an operator. */
    private flush(byWhitespace: boolean): void {
        if (this.token === '') return;
        const word = this.token;
        this.token = '';

        if (this.expectEI) {
            if (word !== 'EI') throw inlineImage('画像データの後に「EI」がありません');
            this.expectEI = false;
            return;
        }
        if (this.image) {
            if (word !== 'ID') {
                this.image.push({ k: 'word', v: word });
                return;
            }
            // `ID` and exactly one white-space byte, then the data.
            if (!byWhitespace) throw inlineImage('「ID」の後に空白がありません');
            const extent = imageExtent(this.image);
            this.image = null;
            if (extent.kind !== 'bytes') {
                this.state = extent.kind === 'hex' ? State.ImageHexData : State.ImageA85Data;
            } else if (extent.length === 0) {
                this.expectEI = true;
            } else {
                this.imageRemaining = extent.length;
                this.state = State.ImageData;
            }
            return;
        }

        const name = this.lastName;
        this.lastName = null;
        if (NUMBER.test(word) || word === 'true' || word === 'false' || word === 'null') return;
        if (word === 'BMC' || word === 'BDC') {
            this.depth += 1;
        } else if (word === 'EMC') {
            if (this.depth === 0) {
                throw new ContentRefusal(`${this.label}に、対応する開始のないEMCがあります。`);
            }
            this.depth -= 1;
        } else if (word === 'Do') {
            // `Do` paints the XObject its one operand names.
            if (name === null) throw unreadable('「Do」の前に名前がありません');
            this.calls.push(name);
        } else if (word === 'BI') {
            this.image = [];
        } else if (word === 'ID' || word === 'EI') {
            throw inlineImage(`「BI」のない「${word}」があります`);
        }
    }

    /** A stream boundary ends a token; nothing else may be left half-read. */
    endStream(): void {
        if (this.state === State.Name) this.nameEnded();
        if (this.state === State.Comment) this.state = State.Normal;
        if (this.state !== State.Normal) {
            throw unreadable('文字列・16進文字列・インライン画像のいずれかが、内容ストリームの途中で終わっています');
        }
        this.flush(false);
        if (this.image || this.expectEI) {
            throw inlineImage('インライン画像が内容ストリームの途中で終わっています');
        }
    }

    endUnit(): void {
        if (this.depth !== 0) {
            throw new ContentRefusal(
                `${this.label}に、閉じていないマーク付きコンテンツ（BMC／BDC）が${this.depth}個あります。`
                + '追加するレイヤーがその内側に入ってしまうため、処理できません。',
            );
        }
    }
}

/** The streams a page's `/Contents` names, in order. */
function contentStreams(doc: PDFDocument, contents: unknown): PDFRawStream[] {
    if (contents === undefined) return [];
    const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
    if (resolved instanceof PDFRawStream) return [resolved];
    if (resolved instanceof PDFArray) {
        const out: PDFRawStream[] = [];
        for (let i = 0; i < resolved.size(); i += 1) {
            const entry = resolved.get(i);
            const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
            if (!(stream instanceof PDFRawStream)) throw unreadable('内容の一覧に、内容ストリームでない項目があります');
            out.push(stream);
        }
        return out;
    }
    throw unreadable('ページの内容（/Contents）が内容ストリームではありません');
}

/** Which decoding this check can do for a stream: none, or Flate with no predictor. */
function decodingOf(doc: PDFDocument, stream: PDFRawStream): 'none' | 'flate' {
    const dict = stream.dict;
    const raw = doc.context.lookup(dict.get(PDFName.of('Filter')));
    const filters: string[] = [];
    if (raw instanceof PDFName) filters.push(raw.asString());
    else if (raw instanceof PDFArray) {
        for (let i = 0; i < raw.size(); i += 1) {
            const f = doc.context.lookup(raw.get(i));
            if (!(f instanceof PDFName)) throw unreadable('圧縮形式（/Filter）が名前ではありません');
            filters.push(f.asString());
        }
    } else if (raw !== undefined) {
        throw unreadable('圧縮形式（/Filter）が読めません');
    }
    if (filters.length === 0) return 'none';
    if (filters.length === 1 && filters[0] === '/FlateDecode') {
        const parms = doc.context.lookup(dict.get(PDFName.of('DecodeParms')));
        const predictor = parms instanceof PDFDict ? doc.context.lookup(parms.get(PDFName.of('Predictor'))) : undefined;
        if (parms === undefined || (parms instanceof PDFDict && (predictor === undefined
            || (predictor instanceof PDFNumber && predictor.asNumber() === 1)))) {
            return 'flate';
        }
    }
    throw new ContentRefusal(`圧縮形式（${filters.join(' ')}）の内容は確認できません。`);
}

/** One document's walk: the decode budget, the form limits, and what is already proven. */
interface Walk {
    doc: PDFDocument;
    limit: number;
    scanned: number;
    maxDepth: number;
    maxChecks: number;
    checks: number;
    beforeStream?: () => void;
    /** Forms proven closed, with every form they paint, keyed by form and resource environment. */
    proven: Set<string>;
    /** An identity for each resource dictionary a resource-less form was painted from. */
    environments: Map<PDFDict, number>;
}

/** Read one unit — a page's streams in order, or one form's — and return the names it paints. */
function readUnit(walk: Walk, streams: PDFRawStream[], label: string): string[] {
    const reader = new MarkedContentReader(label);
    for (const stream of streams) {
        walk.beforeStream?.();
        const bytes = stream.getContents();
        if (decodingOf(walk.doc, stream) === 'none') {
            walk.scanned += bytes.length;
            if (walk.scanned > walk.limit) throw new OverLimit();
            reader.feed(bytes);
        } else {
            const inflator = new Inflate({ chunkSize: PAKO2.inflateChunkBytes });
            inflator.onData = (chunk: Uint8Array) => {
                walk.scanned += chunk.length;
                if (walk.scanned > walk.limit) throw new OverLimit();
                reader.feed(chunk);
            };
            inflator.push(bytes, true);
            if (!inflator.ended || inflator.err) {
                throw new ContentRefusal(`${label}を展開できません。`);
            }
        }
        reader.endStream();
    }
    reader.endUnit();
    return reader.calls;
}

function resourcesOf(doc: PDFDocument, raw: unknown, what: string): PDFDict | undefined {
    if (raw === undefined) return undefined;
    const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (!(resolved instanceof PDFDict)) throw new ContentRefusal(`${what}のリソース（/Resources）が辞書ではありません。`);
    return resolved;
}

/**
 * The XObjects a unit paints, resolved in the resources it is painted with.
 *
 * Images have no content to read. A form is read as a unit of its own and,
 * through its own resources, the forms it paints in turn. Anything that cannot
 * be resolved to one of those two is refused, not skipped.
 */
function readPainted(walk: Walk, names: string[], resources: PDFDict | undefined, path: string[], depth: number): void {
    for (const name of new Set(names)) {
        const xobjects = resources ? walk.doc.context.lookup(resources.get(PDFName.of('XObject'))) : undefined;
        if (!(xobjects instanceof PDFDict)) {
            throw new ContentRefusal(`呼び出される外部オブジェクト（/${name}）を解決できません（/XObject がありません）。`);
        }
        const ref = xobjects.get(PDFName.of(name));
        const target = ref instanceof PDFRef ? walk.doc.context.lookup(ref) : undefined;
        if (!(ref instanceof PDFRef) || !(target instanceof PDFRawStream)) {
            throw new ContentRefusal(`呼び出される外部オブジェクト（/${name}）を解決できません。`);
        }
        const subtype = walk.doc.context.lookup(target.dict.get(PDFName.of('Subtype')));
        const kind = subtype instanceof PDFName ? subtype.asString() : null;
        if (kind === '/Image') continue;
        if (kind !== '/Form') {
            throw new ContentRefusal(`呼び出される外部オブジェクト（/${name}）の種類（${kind ?? '不明'}）は確認できません。`);
        }
        readForm(walk, ref, target, name, resources, path, depth + 1);
    }
}

/**
 * One Form XObject as a unit of its own: its marked content must close inside
 * it, whatever its caller has open.
 *
 * A form with `/Resources` resolves names through them, so one proof covers
 * every place it is painted. A form without them takes the resources of where
 * it is painted (the deprecated inheritance), so what it paints depends on its
 * caller; it is proven per environment, never once for all. A form on the
 * current path again is a cycle, not a shared form, and is refused.
 */
function readForm(
    walk: Walk,
    ref: PDFRef,
    stream: PDFRawStream,
    name: string,
    callerResources: PDFDict | undefined,
    path: string[],
    depth: number,
): void {
    const tag = ref.toString();
    if (path.includes(tag)) {
        throw new ContentRefusal(`図形（Form XObject /${name}）の呼び出しに循環参照があります。`);
    }
    if (depth > walk.maxDepth) {
        throw new ContentRefusal(`図形（Form XObject）の呼び出しの深さが、確認できる上限（${walk.maxDepth}段）を超えます。`);
    }
    const label = `ページから呼び出される図形（Form XObject /${name}）の内容`;
    const own = resourcesOf(walk.doc, stream.dict.get(PDFName.of('Resources')), label);
    let key = tag;
    if (!own) {
        let id = 0;
        if (callerResources) {
            id = walk.environments.get(callerResources) ?? walk.environments.size + 1;
            walk.environments.set(callerResources, id);
        }
        key = `${tag}@${id}`;
    }
    if (walk.proven.has(key)) return;
    walk.checks += 1;
    if (walk.checks > walk.maxChecks) {
        throw new ContentRefusal(`確認する図形（Form XObject）の件数が、確認できる上限（${walk.maxChecks}件）を超えます。`);
    }
    const painted = readUnit(walk, [stream], label);
    readPainted(walk, painted, own ?? callerResources, [...path, tag], depth);
    walk.proven.add(key);
}

/**
 * Read every page's content, and every Form XObject it paints, and answer
 * whether all of it closes its marked content (RF-IR01-01, RF-IR01-R2-01).
 *
 * The page and each form are separate units: a form must close what it opens
 * inside itself. The decode limit covers pages and forms together.
 *
 * Never returns `ok` for anything it could not read to the end. The caller's
 * cancellation check (`beforeStream`) is the only exception it lets through.
 */
export function checkPageMarkedContent(
    doc: PDFDocument,
    options: MarkedContentOptions = {},
): MarkedContentCheck {
    const limit = options.maxDecodedBytes ?? MAX_PAGE_CONTENT_SCAN_BYTES;
    const walk: Walk = {
        doc,
        limit,
        scanned: 0,
        maxDepth: options.maxFormDepth ?? MAX_FORM_DEPTH,
        maxChecks: options.maxFormChecks ?? MAX_FORM_CHECKS,
        checks: 0,
        beforeStream: options.beforeStream,
        proven: new Set(),
        environments: new Map(),
    };
    const pages = doc.getPages();
    for (let p = 0; p < pages.length; p += 1) {
        try {
            const page = pages[p];
            const painted = readUnit(walk, contentStreams(doc, page.node.get(PDFName.of('Contents'))), 'ページ内容');
            const resources = resourcesOf(doc, page.node.getInheritableAttribute(PDFName.of('Resources')), 'ページ');
            readPainted(walk, painted, resources, [], 0);
        } catch (error) {
            if (error instanceof OverLimit) {
                return {
                    ok: false,
                    page: p + 1,
                    reason: `${p + 1}ページ目: ページ内容と、ページから呼び出される図形の内容の展開後の大きさが、`
                        + `確認できる上限（${Math.round(limit / 1024 / 1024)} MiB）を超えます。`,
                };
            }
            if (error instanceof ContentRefusal) return { ok: false, page: p + 1, reason: `${p + 1}ページ目: ${error.message}` };
            // The caller's cancellation is not a fact about the document.
            if (error instanceof ProcessorError) throw error;
            // Anything else — a reference pdf-lib cannot follow, pako giving up
            // inside `push` — is content this check did not read to the end.
            return { ok: false, page: p + 1, reason: `${p + 1}ページ目: ページ内容を読み取れません。` };
        }
    }
    return { ok: true, pages: pages.length, forms: walk.checks, scannedBytes: walk.scanned };
}
