/**
 * What a PDF still is, read back out of its own bytes.
 *
 * The M6 question is not "does the page render" — a copied page renders whether
 * or not the outline that pointed at it, the field its widget belonged to, the
 * named destination that addressed it or the metadata that described it came
 * with it. So every preservation claim in this research is decided by reopening
 * the output and reading its structure, and this module is the only place that
 * reading happens. If a matrix cell says `preserved`, it says so because one of
 * these functions found the thing.
 *
 * Deliberately pdf-lib only: no rendering, no text extraction. Those need a
 * browser and belong to the harness. What is here is the catalog- and
 * page-level structure that page copying is most likely to lose quietly.
 *
 * Nothing in this file is production code, and nothing under `src/` imports it.
 */
import {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFRawStream,
    decodePDFRawStream,
} from 'pdf-lib';

const nameOf = (v) => (typeof v?.asString === 'function' ? v.asString() : String(v ?? ''));
const textOf = (v) => (typeof v?.decodeText === 'function' ? v.decodeText() : (v === undefined ? null : String(v)));
const numOf = (v) => (typeof v?.asNumber === 'function' ? v.asNumber() : null);

const look = (doc, v) => {
    try {
        return doc.context.lookup(v) ?? v;
    } catch {
        return undefined;
    }
};

/**
 * Where a destination actually lands.
 *
 * A destination's first element is a reference to a page object. After a copy
 * it is one of three things, and they are not the same answer: the page is in
 * this document (`pageIndex`), the reference survived but points at something
 * that is not a page here (`dangling`), or the destination was rewritten to a
 * name or a number instead.
 */
function describeDest(doc, raw, pageRefs) {
    const dest = look(doc, raw);
    if (dest === undefined) return { kind: null, target: 'unreadable' };
    if (dest instanceof PDFArray) {
        const first = dest.get(0);
        const kind = nameOf(dest.get(1));
        const values = [];
        for (let i = 2; i < dest.size(); i += 1) values.push(numOf(look(doc, dest.get(i))));
        if (first instanceof PDFRef) {
            const index = pageRefs.findIndex((r) => r.tag === first.tag);
            return {
                kind,
                values,
                target: index >= 0 ? 'in-document' : 'dangling',
                pageIndex: index >= 0 ? index : null,
                ref: first.toString(),
            };
        }
        const asNumber = numOf(look(doc, first));
        return {
            kind, values, target: asNumber === null ? 'unknown' : 'page-number', pageIndex: asNumber,
        };
    }
    // A named destination used as an action target.
    const asText = textOf(dest);
    return { kind: null, target: 'named', name: asText };
}

/** Both places a document may keep named destinations. */
function namedDestinations(doc, pageRefs) {
    const out = [];
    const collectFlat = (arr) => {
        if (!(arr instanceof PDFArray)) return;
        for (let i = 0; i + 1 < arr.size(); i += 2) {
            const name = textOf(look(doc, arr.get(i)));
            out.push({ name, dest: describeDest(doc, arr.get(i + 1), pageRefs) });
        }
    };
    const walkTree = (node, depth) => {
        if (!(node instanceof PDFDict) || depth > 32) return;
        collectFlat(node.lookup(PDFName.of('Names')));
        const kids = node.lookup(PDFName.of('Kids'));
        if (kids instanceof PDFArray) {
            for (let i = 0; i < kids.size(); i += 1) walkTree(look(doc, kids.get(i)), depth + 1);
        }
    };

    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict) walkTree(names.lookup(PDFName.of('Dests')), 0);

    // The pre-1.2 form: a plain dictionary under the catalog.
    const legacy = doc.catalog.lookup(PDFName.of('Dests'));
    if (legacy instanceof PDFDict) {
        for (const [key, value] of legacy.entries()) {
            out.push({ name: key.asString().replace(/^\//, ''), dest: describeDest(doc, value, pageRefs) });
        }
    }
    return out;
}

/** Outline titles and where each one points, in document order. */
function outlines(doc, pageRefs) {
    const root = doc.catalog.lookup(PDFName.of('Outlines'));
    if (!(root instanceof PDFDict)) return null;
    const items = [];
    const seen = new Set();
    let cursor = root.get(PDFName.of('First'));
    for (let i = 0; i < 256 && cursor !== undefined; i += 1) {
        if (cursor instanceof PDFRef) {
            if (seen.has(cursor.tag)) break;
            seen.add(cursor.tag);
        }
        const item = look(doc, cursor);
        if (!(item instanceof PDFDict)) break;
        const action = look(doc, item.get(PDFName.of('A')));
        const dest = item.get(PDFName.of('Dest')) !== undefined
            ? describeDest(doc, item.get(PDFName.of('Dest')), pageRefs)
            : (action instanceof PDFDict
                ? describeDest(doc, action.get(PDFName.of('D')), pageRefs)
                : null);
        items.push({ title: textOf(look(doc, item.get(PDFName.of('Title')))), dest });
        cursor = item.get(PDFName.of('Next'));
    }
    return { count: numOf(look(doc, root.get(PDFName.of('Count')))), items };
}

/** The /PageLabels number tree, flattened to the pairs it declares. */
function pageLabels(doc) {
    const labels = doc.catalog.lookup(PDFName.of('PageLabels'));
    if (!(labels instanceof PDFDict)) return null;
    const nums = labels.lookup(PDFName.of('Nums'));
    if (!(nums instanceof PDFArray)) return { entries: [] };
    const entries = [];
    for (let i = 0; i + 1 < nums.size(); i += 2) {
        const at = numOf(look(doc, nums.get(i)));
        const spec = look(doc, nums.get(i + 1));
        entries.push({
            from: at,
            style: spec instanceof PDFDict ? nameOf(spec.get(PDFName.of('S'))) : null,
            prefix: spec instanceof PDFDict ? textOf(look(doc, spec.get(PDFName.of('P')))) : null,
            start: spec instanceof PDFDict ? numOf(look(doc, spec.get(PDFName.of('St')))) : null,
        });
    }
    return { entries };
}

/**
 * The AcroForm field tree, and — the part a page copy breaks — which page each
 * widget is actually on.
 *
 * A widget that is still in the file but on no page, or a page annotation that
 * is no longer reachable from any field, is the shape of "it looks like a form
 * and is not one". Both are reported rather than summarised away.
 */
function form(doc, pageRefs, annotRefsByPage) {
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    const out = {
        present: acro instanceof PDFDict,
        xfa: acro instanceof PDFDict && acro.get(PDFName.of('XFA')) !== undefined,
        sigFlags: acro instanceof PDFDict ? numOf(look(doc, acro.get(PDFName.of('SigFlags')))) : null,
        needAppearances: acro instanceof PDFDict && acro.get(PDFName.of('NeedAppearances')) !== undefined,
        fields: [],
        orphanWidgets: [],
        fieldsReadable: true,
    };

    const pageOfWidget = (ref) => {
        if (!(ref instanceof PDFRef)) return null;
        for (let i = 0; i < annotRefsByPage.length; i += 1) {
            if (annotRefsByPage[i].some((e) => e.tag === ref.tag)) return i;
        }
        return null;
    };

    const claimed = new Set();
    const walk = (entries, inheritedName, depth) => {
        if (depth > 32) {
            out.fieldsReadable = false;
            return;
        }
        for (const raw of entries) {
            const ref = raw instanceof PDFRef ? raw : null;
            const field = look(doc, raw);
            if (!(field instanceof PDFDict)) {
                out.fieldsReadable = false;
                continue;
            }
            const partial = textOf(look(doc, field.get(PDFName.of('T'))));
            const full = inheritedName && partial ? `${inheritedName}.${partial}` : (partial || inheritedName);
            const kidsRaw = field.get(PDFName.of('Kids'));
            const kids = kidsRaw === undefined ? null : look(doc, kidsRaw);
            const childFields = [];
            const widgets = [];
            if (kids instanceof PDFArray) {
                for (let i = 0; i < kids.size(); i += 1) {
                    const kidRaw = kids.get(i);
                    const kid = look(doc, kidRaw);
                    if (!(kid instanceof PDFDict)) continue;
                    const isField = ['T', 'FT', 'V', 'DV', 'Ff', 'Kids']
                        .some((k) => kid.get(PDFName.of(k)) !== undefined);
                    if (isField) childFields.push(kidRaw);
                    else widgets.push(kidRaw);
                }
            }
            if (childFields.length > 0) {
                walk(childFields, full, depth + 1);
                continue;
            }
            // A merged field/widget has no Kids and is its own annotation.
            const widgetRefs = widgets.length > 0 ? widgets : (ref ? [ref] : []);
            for (const w of widgetRefs) if (w instanceof PDFRef) claimed.add(w.tag);
            out.fields.push({
                name: full,
                ft: nameOf(look(doc, field.get(PDFName.of('FT')))),
                value: textOf(look(doc, field.get(PDFName.of('V')))),
                signed: look(doc, field.get(PDFName.of('V'))) instanceof PDFDict,
                da: textOf(look(doc, field.get(PDFName.of('DA')))),
                widgetPages: widgetRefs.map((w) => pageOfWidget(w)),
            });
        }
    };

    if (acro instanceof PDFDict) {
        const fields = acro.lookup(PDFName.of('Fields'));
        if (fields instanceof PDFArray) {
            const entries = [];
            for (let i = 0; i < fields.size(); i += 1) entries.push(fields.get(i));
            walk(entries, '', 0);
        } else if (acro.get(PDFName.of('Fields')) !== undefined) {
            out.fieldsReadable = false;
        }
    }

    // Widgets drawn on a page that no field in the tree claims.
    //
    // This scan runs whether or not the document has an AcroForm, and that is
    // the whole reason it exists: the case worth detecting is a page copied
    // away from the form it belonged to, where there is no field tree left to
    // claim anything. An earlier version returned early when `/AcroForm` was
    // missing, so it reported zero orphans in exactly the situation it was
    // written to catch.
    annotRefsByPage.forEach((entries, pageIndex) => {
        for (const entry of entries) {
            if (claimed.has(entry.tag)) continue;
            const annot = look(doc, entry.ref);
            if (annot instanceof PDFDict && nameOf(annot.get(PDFName.of('Subtype'))) === '/Widget') {
                out.orphanWidgets.push({
                    pageIndex,
                    ref: entry.tag,
                    fieldName: textOf(look(doc, annot.get(PDFName.of('T')))),
                    value: textOf(look(doc, annot.get(PDFName.of('V')))),
                    hasParent: annot.get(PDFName.of('Parent')) !== undefined,
                });
            }
        }
    });
    return out;
}

/** Info entries and the XMP packet, read the way M5's H12 contract reads them. */
function metadata(doc) {
    const out = { info: [], xmp: null };
    try {
        const infoRef = doc.context.trailerInfo?.Info;
        const info = infoRef === undefined ? null : look(doc, infoRef);
        if (info instanceof PDFDict) {
            for (const [key, raw] of info.entries()) {
                const indirect = raw instanceof PDFRef;
                const value = indirect ? look(doc, raw) : raw;
                out.info.push({
                    key: key.asString(),
                    indirect,
                    resolved: value !== undefined,
                    value: value === undefined ? null : (textOf(value) ?? String(value)),
                });
            }
        }
    } catch (error) {
        out.infoError = String(error?.message ?? error);
    }

    const stream = doc.catalog.lookup(PDFName.of('Metadata'));
    if (stream instanceof PDFRawStream) {
        let decoded = null;
        try {
            decoded = new TextDecoder('utf-8').decode(decodePDFRawStream(stream).decode());
        } catch (error) {
            decoded = `DECODE FAILED: ${String(error?.message ?? error)}`;
        }
        out.xmp = {
            filter: nameOf(stream.dict.get(PDFName.of('Filter'))),
            storedBytes: stream.getContentsSize(),
            startsWithXpacket: decoded.trimStart().startsWith('<?xpacket'),
            marker: /dc:title="([^"]*)"/.exec(decoded)?.[1] ?? null,
        };
    } else if (doc.catalog.get(PDFName.of('Metadata')) !== undefined) {
        out.xmp = { filter: null, unreadable: true };
    }
    return out;
}

/**
 * Everything above, for one document.
 *
 * `loadError` rather than a throw: an unreadable source is a fact about it, and
 * the intake contract this research is meant to define has to be able to say
 * *which* kind of unreadable it was.
 */
export async function structureOf(bytes, { ignoreEncryption = true } = {}) {
    const out = {
        bytes: bytes.length,
        loadError: null,
        encrypted: false,
        pageCount: 0,
        pages: [],
        annots: [],
        links: [],
        namedDests: [],
        outlines: null,
        pageLabels: null,
        form: null,
        metadata: null,
        catalogKeys: [],
        openAction: null,
        embeddedFiles: [],
        hasJavaScript: false,
        ocgs: null,
        structTree: false,
    };

    let doc;
    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption });
    } catch (error) {
        const message = String(error?.message ?? error);
        out.loadError = message;
        out.encrypted = /encrypt/i.test(message);
        return out;
    }
    out.encrypted = doc.isEncrypted;

    let pages;
    try {
        pages = doc.getPages();
    } catch (error) {
        out.loadError = String(error?.message ?? error);
        return out;
    }
    out.pageCount = pages.length;
    const pageRefs = pages.map((p) => p.ref);

    const annotRefsByPage = [];
    pages.forEach((page, index) => {
        const media = page.getMediaBox();
        const crop = page.getCropBox();
        out.pages.push({
            index,
            media: [media.x, media.y, media.width, media.height],
            crop: [crop.x, crop.y, crop.width, crop.height],
            rotate: page.getRotation().angle,
            userUnit: numOf(look(doc, page.node.get(PDFName.of('UserUnit')))),
            structParents: numOf(look(doc, page.node.get(PDFName.of('StructParents')))),
            hasResources: page.node.get(PDFName.of('Resources')) !== undefined,
        });

        const tags = [];
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots instanceof PDFArray) {
            for (let i = 0; i < annots.size(); i += 1) {
                const raw = annots.get(i);
                if (raw instanceof PDFRef) tags.push({ tag: raw.tag, ref: raw });
                const annot = look(doc, raw);
                if (!(annot instanceof PDFDict)) continue;
                const subtype = nameOf(annot.get(PDFName.of('Subtype')));
                out.annots.push({ pageIndex: index, subtype });
                if (subtype !== '/Link') continue;
                const action = look(doc, annot.get(PDFName.of('A')));
                let uri = null;
                let dest = null;
                if (annot.get(PDFName.of('Dest')) !== undefined) {
                    dest = describeDest(doc, annot.get(PDFName.of('Dest')), pageRefs);
                } else if (action instanceof PDFDict) {
                    const s = nameOf(action.get(PDFName.of('S')));
                    if (s === '/URI') uri = textOf(look(doc, action.get(PDFName.of('URI'))));
                    if (s === '/GoTo') dest = describeDest(doc, action.get(PDFName.of('D')), pageRefs);
                }
                out.links.push({ pageIndex: index, uri, dest });
            }
        }
        annotRefsByPage.push(tags);
    });

    out.namedDests = namedDestinations(doc, pageRefs);
    out.outlines = outlines(doc, pageRefs);
    out.pageLabels = pageLabels(doc);
    out.form = form(doc, pageRefs, annotRefsByPage);
    out.metadata = metadata(doc);

    for (const [key] of doc.catalog.entries()) out.catalogKeys.push(key.asString());
    if (doc.catalog.get(PDFName.of('OpenAction')) !== undefined) {
        out.openAction = describeDest(doc, doc.catalog.get(PDFName.of('OpenAction')), pageRefs);
    }

    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict) {
        const files = names.lookup(PDFName.of('EmbeddedFiles'));
        if (files instanceof PDFDict) {
            const arr = files.lookup(PDFName.of('Names'));
            if (arr instanceof PDFArray) {
                for (let i = 0; i + 1 < arr.size(); i += 2) {
                    out.embeddedFiles.push(textOf(look(doc, arr.get(i))));
                }
            }
        }
        out.hasJavaScript = names.get(PDFName.of('JavaScript')) !== undefined;
    }

    const oc = doc.catalog.lookup(PDFName.of('OCProperties'));
    if (oc instanceof PDFDict) {
        const groups = oc.lookup(PDFName.of('OCGs'));
        out.ocgs = { count: groups instanceof PDFArray ? groups.size() : 0 };
    }
    out.structTree = doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined;

    return out;
}

/** The page markers, in the order the document actually holds them. */
export const pageOrderMarkers = (structure) => structure.pages.map((p) => p.index);
