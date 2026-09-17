/**
 * Internal destinations: E1 and E2. Adopted M6-H5.
 *
 * The measured reason this module exists. `copyPages` does not merely fail to
 * retarget a destination — it **copies the page the destination points at**.
 * The copier dispatches on type with no branch for what a referent is
 * (`core/PDFObjectCopier.js:36-41`), so a link's `/Dest [ 12 0 R /XYZ ... ]` is
 * an array holding a reference, the reference is dereferenced, the referent is a
 * `PDFPageLeaf`, and the first rung of the ladder copies the whole page. That
 * copy is registered but never inserted into `/Pages`
 * (`api/PDFDocument.js:611`), so it is an orphan: invisible to a reader,
 * present in the bytes.
 *
 * It happens **even when the target page is selected**. `copyPDFPage` clones the
 * leaf before memoising it (`:43`, `:64`), so a page reached both as an argument
 * and through a reference is copied twice, and the destination is remapped onto
 * the copy that never enters the tree. A link that resolves and navigates
 * nowhere is the worst of the outcomes, because nothing reports it.
 *
 * So the order is the whole trick, and step 1 is not an optimisation:
 *
 *   1. strip every internal destination from the pages being copied —
 *      **including the ones whose target is kept**, because leaving them is what
 *      makes the copier drag a duplicate in;
 *   2. copy;
 *   3. rebuild what is still meaningful, from the output's own page references;
 *   4. report what was dropped, by name.
 *
 * And `/Annots` is not the only way out of a page. An article bead in `/B`
 * chains through `/N` to a bead whose `/P` is a different page, so a page with
 * no link annotations at all can still drag one in. A contract that enumerated
 * annotations would have been wrong and would have looked right.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { LossRecord } from './contracts';

const nameOf = (v: unknown): string => {
    const asString = (v as { asString?: () => string } | null)?.asString;
    return typeof asString === 'function' ? asString.call(v) : '';
};

const textOf = (v: unknown): string | null => {
    const decode = (v as { decodeText?: () => string } | null)?.decodeText;
    return typeof decode === 'function' ? decode.call(v) : null;
};

function look(doc: PDFDocument, value: unknown): unknown {
    try {
        if (value instanceof PDFRef) return doc.context.lookup(value);
        return value;
    } catch {
        return undefined;
    }
}

/**
 * Where a page can reach another page from.
 *
 * `/Annots` is handled by the destination walk below. `/B` is the route the
 * `page-refs-beyond-annots` measurement found, and it is removed wholesale
 * rather than reconstructed: rebuilding an article thread across a subset of its
 * pages is a different feature, not a silent side effect of extracting.
 */
const NON_ANNOT_PAGE_REFERENCE_KEYS = ['B'] as const;

type LinkKind = 'explicit' | 'named';

interface FoundLink {
    fromIndex: number;
    annotIndex: number;
    annotRef: PDFRef | null;
    /** The dictionary the destination key lives on: the annotation or its action. */
    holder: PDFDict;
    /** `Dest` on an annotation, or `D` on a `/GoTo` action. */
    key: 'Dest' | 'D';
    kind: LinkKind;
    targetIndex: number | null;
    /** The destination array's tail — the zoom or fit parameters. */
    tail: unknown[];
    name?: string;
}

interface NamedDestination {
    name: string;
    targetIndex: number | null;
    tail: unknown[];
}

export interface DestinationPlan {
    pageCount: number;
    selection: number[];
    links: FoundLink[];
    named: NamedDestination[];
    /** Page reference sites that are not annotations, per page. */
    otherSites: { fromIndex: number; key: string }[];
    /** How many links would break under E1. */
    wouldBreak: number;
}

/** Every destination on a page, with enough context to remove or rebuild it. */
function destinationsOnPage(
    doc: PDFDocument,
    pageIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
): FoundLink[] {
    const found: FoundLink[] = [];
    const page = doc.getPages()[pageIndex];
    const annots = look(doc, page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return found;

    for (let i = 0; i < annots.size(); i += 1) {
        const annotRaw = annots.get(i);
        const annot = look(doc, annotRaw);
        if (!(annot instanceof PDFDict)) continue;

        const record = (holder: PDFDict, key: 'Dest' | 'D', raw: unknown): void => {
            const dest = look(doc, raw);
            if (dest instanceof PDFArray) {
                const first = dest.get(0);
                const tail: unknown[] = [];
                for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
                found.push({
                    fromIndex: pageIndex,
                    annotIndex: i,
                    annotRef: annotRaw instanceof PDFRef ? annotRaw : null,
                    holder,
                    key,
                    kind: 'explicit',
                    targetIndex: first instanceof PDFRef ? pageIndexOf(first) : null,
                    tail,
                });
            } else if (dest !== undefined) {
                found.push({
                    fromIndex: pageIndex,
                    annotIndex: i,
                    annotRef: annotRaw instanceof PDFRef ? annotRaw : null,
                    holder,
                    key,
                    kind: 'named',
                    targetIndex: null,
                    tail: [],
                    name: textOf(dest) ?? nameOf(dest),
                });
            }
        };

        if (annot.get(PDFName.of('Dest')) !== undefined) {
            record(annot, 'Dest', annot.get(PDFName.of('Dest')));
        }
        const action = look(doc, annot.get(PDFName.of('A')));
        if (action instanceof PDFDict && nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
            record(action, 'D', action.get(PDFName.of('D')));
        }
    }
    return found;
}

/** Named destinations, resolved to page indices. */
function namedDestinations(
    doc: PDFDocument,
    pageIndexOf: (ref: PDFRef) => number | null,
): NamedDestination[] {
    const out: NamedDestination[] = [];
    const names = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (!(names instanceof PDFDict)) return out;
    const dests = look(doc, names.get(PDFName.of('Dests')));
    if (!(dests instanceof PDFDict)) return out;
    const arr = look(doc, dests.get(PDFName.of('Names')));
    if (!(arr instanceof PDFArray)) return out;
    for (let i = 0; i + 1 < arr.size(); i += 2) {
        const name = textOf(look(doc, arr.get(i)));
        const dest = look(doc, arr.get(i + 1));
        if (!(dest instanceof PDFArray) || name === null) continue;
        const first = dest.get(0);
        const tail: unknown[] = [];
        for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
        out.push({
            name,
            targetIndex: first instanceof PDFRef ? pageIndexOf(first) : null,
            tail,
        });
    }
    return out;
}

/**
 * Plan, on the source, before anything is copied.
 *
 * This is the only moment the answer is knowable without having already done the
 * damage: `copyPages` flushes the source, and the copy is what creates the
 * orphans.
 */
export function planDestinations(doc: PDFDocument, selection: number[]): DestinationPlan {
    const pages = doc.getPages();
    const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
    const pageIndexOf = (ref: PDFRef): number | null => byTag.get(ref.tag) ?? null;
    const kept = new Set(selection);

    const links: FoundLink[] = [];
    for (const index of selection) {
        if (!pages[index]) continue;
        links.push(...destinationsOnPage(doc, index, pageIndexOf));
    }

    const named = namedDestinations(doc, pageIndexOf);
    const namedByName = new Map(named.map((n) => [n.name, n]));

    const otherSites: { fromIndex: number; key: string }[] = [];
    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;
        for (const key of NON_ANNOT_PAGE_REFERENCE_KEYS) {
            if (page.node.get(PDFName.of(key)) !== undefined) {
                otherSites.push({ fromIndex: index, key });
            }
        }
    }

    const breaks = links.filter((l) => {
        if (l.kind === 'explicit') return l.targetIndex === null || !kept.has(l.targetIndex);
        const entry = l.name !== undefined ? namedByName.get(l.name) : undefined;
        return !entry || entry.targetIndex === null || !kept.has(entry.targetIndex);
    });

    return {
        pageCount: pages.length,
        selection,
        links,
        named,
        otherSites,
        wouldBreak: breaks.length,
    };
}

/** What has to be put back after the copy, and where. */
export interface DestinationRebuild {
    fromIndex: number;
    annotIndex: number;
    holderIsAction: boolean;
    targetIndex: number;
    tail: unknown[];
}

export interface StripOutcome {
    rebuild: DestinationRebuild[];
    /** Named destinations whose target survived, to be written to the output. */
    survivingNames: NamedDestination[];
    losses: LossRecord[];
}

/**
 * Strip every internal destination from the pages being copied, on a working
 * copy of the source.
 *
 * Including the ones whose target is kept. That is the step that removes the
 * reference the copier would otherwise follow into another page, and it is why
 * the artifact ends up with `orphanPageCount === 0` instead of one or two page
 * objects nobody asked for.
 */
export function stripInternalDestinations(
    doc: PDFDocument,
    plan: DestinationPlan,
    selection: number[],
): StripOutcome {
    const kept = new Set(selection);
    const rebuild: DestinationRebuild[] = [];
    const losses: LossRecord[] = [];
    const namedByName = new Map(plan.named.map((n) => [n.name, n]));

    for (const link of plan.links) {
        if (link.kind === 'named') {
            const entry = link.name !== undefined ? namedByName.get(link.name) : undefined;
            if (entry && entry.targetIndex !== null && kept.has(entry.targetIndex)) {
                rebuild.push({
                    fromIndex: link.fromIndex,
                    annotIndex: link.annotIndex,
                    holderIsAction: link.key === 'D',
                    targetIndex: entry.targetIndex,
                    tail: entry.tail,
                });
            } else {
                losses.push({
                    kind: 'internal-links',
                    fromIndex: link.fromIndex,
                    what: link.name,
                    why: entry
                        ? 'ジャンプ先のページが選択されていません。'
                        : 'この名前のジャンプ先が文書内に見つかりません。',
                });
            }
            link.holder.delete(PDFName.of(link.key));
            continue;
        }

        if (link.targetIndex !== null && kept.has(link.targetIndex)) {
            rebuild.push({
                fromIndex: link.fromIndex,
                annotIndex: link.annotIndex,
                holderIsAction: link.key === 'D',
                targetIndex: link.targetIndex,
                tail: link.tail,
            });
        } else {
            losses.push({
                kind: 'internal-links',
                fromIndex: link.fromIndex,
                what: link.targetIndex === null ? undefined : `p.${link.targetIndex + 1}`,
                why: link.targetIndex === null
                    ? 'リンク先がページとして解決できませんでした。'
                    : 'リンク先のページが選択されていません。',
            });
        }
        link.holder.delete(PDFName.of(link.key));
    }

    // Page reference sites that are not annotations: removed wholesale, and
    // reported by name.
    for (const site of plan.otherSites) {
        const page = doc.getPages()[site.fromIndex];
        page.node.delete(PDFName.of(site.key));
        losses.push({
            kind: 'article-threads',
            fromIndex: site.fromIndex,
            what: `/${site.key}`,
            why: '選択したページだけでは記事スレッドを再構成できません。',
        });
    }

    const survivingNames = plan.named.filter(
        (n) => n.targetIndex !== null && kept.has(n.targetIndex),
    );
    for (const n of plan.named) {
        if (n.targetIndex === null || !kept.has(n.targetIndex)) {
            losses.push({
                kind: 'named-destinations',
                what: n.name,
                why: 'ジャンプ先のページが選択されていません。',
            });
        }
    }

    return { rebuild, survivingNames, losses };
}

/**
 * Put the destinations back, pointing at the output's own page references.
 *
 * The copied annotation is found by its position: `copyPages` preserves the
 * order of `/Annots`, so the annotation that carried the destination is the same
 * one in the copy.
 */
export function rebuildDestinations(
    out: PDFDocument,
    outcome: StripOutcome,
    selection: number[],
): number {
    const outPages = out.getPages();
    const outRefOf = (sourceIndex: number): PDFRef | null => {
        const position = selection.indexOf(sourceIndex);
        return position >= 0 && outPages[position] ? outPages[position].ref : null;
    };

    let rebuilt = 0;

    for (const item of outcome.rebuild) {
        const position = selection.indexOf(item.fromIndex);
        const outPage = outPages[position];
        if (!outPage) continue;
        const annots = outPage.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        const annot = out.context.lookup(annots.get(item.annotIndex));
        if (!(annot instanceof PDFDict)) continue;

        const target = outRefOf(item.targetIndex);
        if (!target) continue;

        const tail = item.tail.map((t) => {
            const clone = (t as { clone?: (ctx: unknown) => unknown } | null)?.clone;
            return typeof clone === 'function' ? clone.call(t, out.context) : t;
        });
        const dest = out.context.obj([target, ...tail] as never[]);
        if (item.holderIsAction) {
            annot.set(
                PDFName.of('A'),
                out.context.obj({ Type: 'Action', S: 'GoTo', D: dest } as never),
            );
        } else {
            annot.set(PDFName.of('Dest'), dest);
        }
        rebuilt += 1;
    }

    // Named destinations whose target survived. M6-H6 adopted reconstructing
    // these and deferred outlines and page labels.
    if (outcome.survivingNames.length > 0) {
        const flat: unknown[] = [];
        for (const n of outcome.survivingNames) {
            if (n.targetIndex === null) continue;
            const target = outRefOf(n.targetIndex);
            if (!target) continue;
            const tail = n.tail.map((t) => {
                const clone = (t as { clone?: (ctx: unknown) => unknown } | null)?.clone;
                return typeof clone === 'function' ? clone.call(t, out.context) : t;
            });
            flat.push(PDFString.of(n.name), out.context.obj([target, ...tail] as never[]));
        }
        if (flat.length > 0) {
            out.catalog.set(
                PDFName.of('Names'),
                out.context.register(out.context.obj({ Dests: { Names: flat } } as never)),
            );
        }
    }

    return rebuilt;
}

/**
 * Count, on an artifact, the two things the invariant is about.
 *
 * `orphanPageCount` is indirect `/Page` objects outside the output page tree.
 * `danglingDestinations` is surviving internal destinations that do not target a
 * page of that tree. Both are measured by reopening the bytes, not by trusting
 * what the run believes it did.
 */
export function measureDestinationInvariants(doc: PDFDocument): {
    orphanPageCount: number;
    danglingDestinations: number;
} {
    const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
    let orphanPageCount = 0;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        if (nameOf(obj.get(PDFName.of('Type'))) !== '/Page') continue;
        if (!inTree.has(ref.tag)) orphanPageCount += 1;
    }

    let danglingDestinations = 0;
    const checkDest = (raw: unknown): void => {
        const dest = look(doc, raw);
        if (!(dest instanceof PDFArray)) return;
        const first = dest.get(0);
        if (!(first instanceof PDFRef)) return;
        if (!inTree.has(first.tag)) danglingDestinations += 1;
    };

    for (const page of doc.getPages()) {
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (annot.get(PDFName.of('Dest')) !== undefined) checkDest(annot.get(PDFName.of('Dest')));
            const action = look(doc, annot.get(PDFName.of('A')));
            if (action instanceof PDFDict && nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
                checkDest(action.get(PDFName.of('D')));
            }
        }
    }

    const names = look(doc, doc.catalog.get(PDFName.of('Names')));
    if (names instanceof PDFDict) {
        const dests = look(doc, names.get(PDFName.of('Dests')));
        if (dests instanceof PDFDict) {
            const arr = look(doc, dests.get(PDFName.of('Names')));
            if (arr instanceof PDFArray) {
                for (let i = 1; i < arr.size(); i += 2) checkDest(arr.get(i));
            }
        }
    }

    return { orphanPageCount, danglingDestinations };
}
