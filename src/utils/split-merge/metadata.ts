/**
 * Metadata, taken as a snapshot and written from the snapshot.
 *
 * Two contracts meet here and both were broken.
 *
 * **H11-EXTRACT-4 — the source is released before save.** The previous
 * implementation kept a second loaded `PDFDocument` alive purely so that
 * metadata could be read at the end, so "release the source before save" was a
 * variable assignment with a live object graph behind it. A snapshot fixes that
 * by construction: after {@link snapshotMetadata} returns, nothing it produced
 * refers to the source's context, dictionaries or references, so there is
 * nothing left to release.
 *
 * **M6-H7 — metadata is part of the artifact.** Carrying raw compressed bytes
 * without their stream dictionary produced an artifact whose XMP packet could
 * not be decoded: `/Filter /FlateDecode` was lost, so the bytes were deflate
 * data announced as plain XML. The operation returned READY over a corrupt
 * packet. Preservation is semantic, so the snapshot keeps the filter chain and
 * its parameters, and the readback decodes the packet rather than checking that
 * something is present.
 */
import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    decodePDFRawStream,
} from 'pdf-lib';
import type { PDFDocument, PDFRawStream } from 'pdf-lib';
import { pdfTextFromString, pdfTextObject } from './pdf-text';

/** One Info entry, described in plain values. */
export type InfoValue =
    | { kind: 'text'; value: string }
    | { kind: 'hex'; value: string }
    | { kind: 'name'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'bool'; value: boolean };

/**
 * An XMP packet, described without the source.
 *
 * `decoded` is the packet a reader would see. `raw` and `filters` keep the
 * encoded form so it can be written back byte for byte with a stream dictionary
 * that actually describes it.
 */
export interface XmpSnapshot {
    decoded: Uint8Array;
    raw: Uint8Array;
    /** The `/Filter` chain, as plain names. Empty when the stream was plain. */
    filters: string[];
    /** Whether `decoded` is a real decode or a copy of `raw`. */
    decodable: boolean;
}

export interface MetadataSnapshot {
    info: Record<string, InfoValue>;
    xmp: XmpSnapshot | null;
    /** True when the source carried an XMP packet at all. */
    hadXmp: boolean;
}

const namesOf = (value: unknown): string[] => {
    if (value instanceof PDFName) return [value.asString().replace(/^\//, '')];
    if (value instanceof PDFArray) {
        const out: string[] = [];
        for (let i = 0; i < value.size(); i += 1) {
            const entry = value.get(i);
            if (entry instanceof PDFName) out.push(entry.asString().replace(/^\//, ''));
        }
        return out;
    }
    return [];
};

const describeInfo = (value: unknown): InfoValue | null => {
    if (value instanceof PDFHexString) return { kind: 'hex', value: value.asString() };
    if (value instanceof PDFString) return { kind: 'text', value: value.asString() };
    if (value instanceof PDFName) return { kind: 'name', value: value.asString().replace(/^\//, '') };
    if (value instanceof PDFNumber) return { kind: 'number', value: value.asNumber() };
    const maybeBool = (value as { asBoolean?: () => boolean } | null)?.asBoolean;
    if (typeof maybeBool === 'function') return { kind: 'bool', value: maybeBool.call(value) };
    return null;
};

/** The plain text of an Info value, for comparison. */
export const infoText = (value: InfoValue): string => {
    if (value.kind === 'number') return String(value.value);
    if (value.kind === 'bool') return value.value ? 'true' : 'false';
    return value.value;
};

/**
 * Read everything the output will need, and hold on to nothing.
 *
 * After this returns, the snapshot contains strings, numbers, booleans and
 * copied byte arrays. It holds no `PDFDocument`, no `PDFContext`, no `PDFDict`
 * and no `PDFRef`, so the source can be dropped immediately.
 */
export function snapshotMetadata(doc: PDFDocument): MetadataSnapshot {
    const info: Record<string, InfoValue> = {};
    const infoRef = doc.context.trailerInfo.Info;
    const dict = infoRef ? doc.context.lookup(infoRef) : undefined;
    if (dict instanceof PDFDict) {
        for (const [key, raw] of dict.entries()) {
            const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
            const described = describeInfo(resolved);
            if (described) info[key.asString().replace(/^\//, '')] = described;
        }
    }

    let xmp: XmpSnapshot | null = null;
    const xmpRaw = doc.catalog.get(PDFName.of('Metadata'));
    const hadXmp = xmpRaw !== undefined;
    if (hadXmp) {
        const stream = xmpRaw instanceof PDFRef ? doc.context.lookup(xmpRaw) : xmpRaw;
        const contents = (stream as { contents?: Uint8Array } | undefined)?.contents;
        const streamDict = (stream as { dict?: unknown } | undefined)?.dict;
        if (contents instanceof Uint8Array) {
            const raw = new Uint8Array(contents.length);
            raw.set(contents);
            const filters = streamDict instanceof PDFDict
                ? namesOf(streamDict.get(PDFName.of('Filter')))
                : [];
            let decoded = raw;
            let decodable = true;
            if (filters.length > 0) {
                try {
                    const bytes = decodePDFRawStream(stream as PDFRawStream).decode();
                    decoded = new Uint8Array(bytes.length);
                    decoded.set(bytes);
                } catch {
                    decodable = false;
                }
            }
            xmp = { decoded, raw, filters, decodable };
        } else {
            xmp = { decoded: new Uint8Array(), raw: new Uint8Array(), filters: [], decodable: false };
        }
    }

    return { info, xmp, hadXmp };
}

/**
 * An Info value, written back.
 *
 * A string goes back as the token it was parsed as, through the one text writer
 * M6 has (BLK-R4-1): the snapshot holds the characters between the delimiters,
 * never a decoded string, so nothing is re-encoded and nothing can end early.
 */
const materialize = (out: PDFDocument, value: InfoValue): unknown => {
    switch (value.kind) {
        case 'hex': return pdfTextObject({ bytes: new Uint8Array(), token: { kind: 'hex', raw: value.value } });
        case 'name': return PDFName.of(value.value);
        case 'number': return out.context.obj(value.value as never);
        case 'bool': return out.context.obj(value.value as never);
        default: return pdfTextObject({ bytes: new Uint8Array(), token: { kind: 'literal', raw: value.value } });
    }
};

export interface MetadataApplication {
    carried: string[];
    dropped: string[];
    xmp: boolean;
}

/**
 * Write the snapshot onto the output.
 *
 * The whole Info dictionary is carried, custom keys included: the first
 * implementation copied a hand-picked five through pdf-lib's setters, so a
 * `/Company` key or a project code was dropped without being named.
 *
 * `/Producer` is deliberately not carried. The artifact really was written by
 * this build, and claiming the source's writer would be a false provenance claim
 * rather than preservation.
 *
 * The XMP packet is written **decoded, with no filter**. Keeping the compressed
 * bytes would mean reproducing the exact filter chain and its parameters
 * faithfully, and a packet announced as one encoding while holding another is
 * the corruption this fix exists for. A plain packet is byte-for-byte the same
 * XMP to every reader.
 */
export function applyMetadataSnapshot(
    out: PDFDocument,
    snapshot: MetadataSnapshot,
    fallbackTitle: string,
): MetadataApplication {
    const carried: string[] = [];
    const dropped: string[] = [];

    const outInfoRef = out.context.trailerInfo.Info;
    let outDict = outInfoRef ? out.context.lookup(outInfoRef) : undefined;
    if (!(outDict instanceof PDFDict)) {
        const created = out.context.obj({} as never);
        out.context.trailerInfo.Info = out.context.register(created);
        outDict = created;
    }

    for (const [key, value] of Object.entries(snapshot.info)) {
        if (key === 'Producer') {
            dropped.push(key);
            continue;
        }
        (outDict as PDFDict).set(PDFName.of(key), materialize(out, value) as never);
        carried.push(key);
    }

    if (!carried.includes('Title')) {
        // The source's filename: the person's text, so the one text writer.
        const title = pdfTextFromString(fallbackTitle);
        if (title.ok) {
            (outDict as PDFDict).set(PDFName.of('Title'), pdfTextObject(title.value));
            carried.push('Title');
        } else {
            dropped.push('Title');
        }
    }

    let xmp = false;
    if (snapshot.xmp) {
        if (!snapshot.xmp.decodable) {
            dropped.push('Metadata(XMP)');
        } else {
            const bytes = new Uint8Array(snapshot.xmp.decoded.length);
            bytes.set(snapshot.xmp.decoded);
            const stream = out.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML' });
            out.catalog.set(PDFName.of('Metadata'), out.context.register(stream));
            xmp = true;
            carried.push('Metadata(XMP)');
        }
    }

    return { carried, dropped, xmp };
}

/**
 * What the artifact kept, measured by reopening it and decoding the packet.
 *
 * The XMP comparison is on the **decoded** payload, because a packet that is
 * present and cannot be read is not preserved metadata.
 */
export function metadataGaps(
    snapshot: MetadataSnapshot,
    artifact: PDFDocument,
): string[] {
    const gaps: string[] = [];
    const artifactSnapshot = snapshotMetadata(artifact);

    for (const [key, value] of Object.entries(snapshot.info)) {
        // `/ModDate` is rewritten by any save, and `/Producer` is this build's
        // to state. Neither is a preservation failure.
        if (key === 'Producer' || key === 'ModDate') continue;
        const got = artifactSnapshot.info[key];
        if (!got || infoText(got) !== infoText(value)) gaps.push(key);
    }

    if (snapshot.hadXmp) {
        if (!artifactSnapshot.xmp || !artifactSnapshot.xmp.decodable) {
            gaps.push('Metadata(XMP)');
        } else if (snapshot.xmp?.decodable) {
            const a = snapshot.xmp.decoded;
            const b = artifactSnapshot.xmp.decoded;
            let equal = a.length === b.length;
            if (equal) {
                for (let i = 0; i < a.length; i += 1) {
                    if (a[i] !== b[i]) {
                        equal = false;
                        break;
                    }
                }
            }
            if (!equal) gaps.push('Metadata(XMP)');
        } else {
            // The source packet could not be decoded, so it cannot be preserved
            // safely and the operation must not claim it was.
            gaps.push('Metadata(XMP)');
        }
    }

    return gaps;
}
