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

/**
 * A destination's parameters, as plain values.
 *
 * H11-EXTRACT-4 requires the source to be released before `save`, and a
 * rebuild record that held the source's own `PDFName` and `PDFNumber` objects
 * kept the source context alive through the whole save — the release was a
 * variable assignment with a live object graph behind it. So the tail is
 * described rather than carried: a name becomes a string, a number becomes a
 * number, and the output's objects are built from those.
 */
export type DestParam =
    | { kind: 'name'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'null' };

const describeParam = (value: unknown): DestParam => {
    const asString = (value as { asString?: () => string } | null)?.asString;
    if (typeof asString === 'function') {
        return { kind: 'name', value: asString.call(value).replace(/^\//, '') };
    }
    const asNumber = (value as { asNumber?: () => number } | null)?.asNumber;
    if (typeof asNumber === 'function') return { kind: 'number', value: asNumber.call(value) };
    if (typeof value === 'number') return { kind: 'number', value };
    return { kind: 'null' };
};

const describeTail = (values: unknown[]): DestParam[] => values.map(describeParam);

const materializeTail = (out: PDFDocument, tail: DestParam[]): unknown[] => tail.map((t) => {
    if (t.kind === 'name') return PDFName.of(t.value);
    if (t.kind === 'number') return out.context.obj(t.value as never);
    return out.context.obj(null as never);
});

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
    /** Plain values, so nothing here keeps the source document alive. */
    tail: DestParam[];
}

/** A named destination that survived, described in plain values. */
export interface SurvivingName {
    name: string;
    targetIndex: number;
    tail: DestParam[];
}

export interface StripOutcome {
    rebuild: DestinationRebuild[];
    /** Named destinations whose target survived, to be written to the output. */
    survivingNames: SurvivingName[];
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
                    tail: describeTail(entry.tail),
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
                tail: describeTail(link.tail),
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

    const survivingNames: SurvivingName[] = plan.named
        .filter((n) => n.targetIndex !== null && kept.has(n.targetIndex))
        .map((n) => ({
            name: n.name,
            targetIndex: n.targetIndex as number,
            tail: describeTail(n.tail),
        }));
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

        const dest = out.context.obj([target, ...materializeTail(out, item.tail)] as never[]);
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
            flat.push(
                PDFString.of(n.name),
                out.context.obj([target, ...materializeTail(out, n.tail)] as never[]),
            );
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
 * Every place a page reference can hide, walked before the copy. M6-H5A.
 *
 * `/Dest` was never the only route, and the Independent Review found the rest:
 * an annotation's own `/P` back-pointer, an `/AA` on an annotation, a widget or
 * a page, and a `/GoTo` reached through a recursive `/Next` chain. Each carries
 * a reference to a page of the **source**, and a source-page reference in an
 * output document means nothing a reader can follow — while the copier, which
 * has no branch for what a reference points at, will happily drag the whole page
 * in behind it.
 *
 * So the rule is uniform: a source-page reference is stripped before the graph
 * is counted, and rebuilt afterwards only against output page references. What
 * cannot be rebuilt is reported; what cannot be understood is refused.
 */
const ACTION_CHAIN_BOUND = 32;

interface PageRefSite {
    /** The dictionary holding the key. */
    holder: PDFDict;
    key: string;
    /** Where it was found, for the loss report. */
    where: string;
    fromIndex: number;
    /** The source page index the reference resolves to, when it resolves. */
    targetIndex: number | null;
    /** `dest` when the value is a destination array, `page` for a bare `/P`. */
    shape: 'dest' | 'page';
    tail: unknown[];
}

/**
 * Walk one action, and everything chained behind it, collecting the page
 * references it holds.
 *
 * Bounded and cycle-aware. A chain that cannot be finished is reported as
 * unreadable rather than quietly truncated, because a truncated walk that found
 * nothing looks exactly like a clean one.
 */
function collectActionPageRefs(
    doc: PDFDocument,
    holder: PDFDict,
    key: string,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
    depth: number,
    seen: Set<string>,
): void {
    if (depth > ACTION_CHAIN_BOUND) {
        unreadable.push(`${where}: action chain deeper than ${ACTION_CHAIN_BOUND}`);
        return;
    }
    const raw = holder.get(PDFName.of(key));
    if (raw === undefined) return;
    if (raw instanceof PDFRef) {
        if (seen.has(raw.tag)) {
            unreadable.push(`${where}: cyclic action chain`);
            return;
        }
        seen.add(raw.tag);
    }
    const resolved = look(doc, raw);

    if (resolved instanceof PDFArray) {
        // Under `/Next` an array is a list of actions; under a destination key
        // it is the destination itself. Only the key says which.
        if (key === 'Next') {
            for (let i = 0; i < resolved.size(); i += 1) {
                const item = look(doc, resolved.get(i));
                if (!(item instanceof PDFDict)) continue;
                collectFromActionDict(
                    doc, item, `${where} /Next[${i}]`, fromIndex, pageIndexOf,
                    out, unreadable, depth + 1, new Set(seen),
                );
            }
        }
        return;
    }
    if (!(resolved instanceof PDFDict)) return;
    collectFromActionDict(
        doc, resolved, where, fromIndex, pageIndexOf, out, unreadable, depth + 1, seen,
    );
}

function collectFromActionDict(
    doc: PDFDocument,
    action: PDFDict,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
    depth: number,
    seen: Set<string>,
): void {
    if (depth > ACTION_CHAIN_BOUND) {
        unreadable.push(`${where}: action chain deeper than ${ACTION_CHAIN_BOUND}`);
        return;
    }
    if (nameOf(action.get(PDFName.of('S'))) === '/GoTo') {
        const raw = action.get(PDFName.of('D'));
        const dest = look(doc, raw);
        if (dest instanceof PDFArray) {
            const first = dest.get(0);
            const tail: unknown[] = [];
            for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
            if (first instanceof PDFRef) {
                out.push({
                    holder: action,
                    key: 'D',
                    where: `${where} /GoTo /D`,
                    fromIndex,
                    targetIndex: pageIndexOf(first),
                    shape: 'dest',
                    tail,
                });
            }
        }
    }
    collectActionPageRefs(
        doc, action, 'Next', `${where} /Next`, fromIndex, pageIndexOf,
        out, unreadable, depth + 1, seen,
    );
}

/** Every entry of an additional-actions dictionary, walked for page references. */
function collectAdditionalActions(
    doc: PDFDocument,
    owner: PDFDict,
    where: string,
    fromIndex: number,
    pageIndexOf: (ref: PDFRef) => number | null,
    out: PageRefSite[],
    unreadable: string[],
): void {
    const raw = owner.get(PDFName.of('AA'));
    if (raw === undefined) return;
    const aa = look(doc, raw);
    if (!(aa instanceof PDFDict)) {
        unreadable.push(`${where} /AA is not a dictionary`);
        return;
    }
    for (const [key] of aa.entries()) {
        collectActionPageRefs(
            doc, aa, key.asString().replace(/^\//, ''),
            `${where} /AA ${key.asString()}`, fromIndex, pageIndexOf,
            out, unreadable, 0, new Set(),
        );
    }
}

/**
 * Every source-page reference reachable from the kept pages, on every route
 * M6-H5A names.
 */
export function collectSourcePageRefs(
    doc: PDFDocument,
    selection: number[],
): { sites: PageRefSite[]; unreadable: string[] } {
    const pages = doc.getPages();
    const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
    const pageIndexOf = (ref: PDFRef): number | null => byTag.get(ref.tag) ?? null;
    const sites: PageRefSite[] = [];
    const unreadable: string[] = [];

    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;

        // The page's own additional actions.
        collectAdditionalActions(
            doc, page.node, `page ${index}`, index, pageIndexOf, sites, unreadable,
        );

        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            const where = `page ${index} annotation ${i}`;

            // An annotation's `/P` names the page it belongs to. In a copy it
            // names a page of the source, whether or not that page was kept.
            const parentRaw = annot.get(PDFName.of('P'));
            if (parentRaw instanceof PDFRef) {
                sites.push({
                    holder: annot,
                    key: 'P',
                    where: `${where} /P`,
                    fromIndex: index,
                    targetIndex: pageIndexOf(parentRaw),
                    shape: 'page',
                    tail: [],
                });
            }

            collectActionPageRefs(
                doc, annot, 'A', `${where} /A`, index, pageIndexOf, sites, unreadable, 0, new Set(),
            );
            collectAdditionalActions(doc, annot, where, index, pageIndexOf, sites, unreadable);
        }
    }

    return { sites, unreadable };
}

/**
 * Plan and strip in one call, so the plan never escapes.
 *
 * `DestinationPlan` holds `PDFDict` holders from the source — that is what
 * makes the strip possible — and a caller that kept it would keep the source
 * context alive right through `save()`. Confining it here makes source
 * retention impossible by construction rather than by discipline.
 */
export function sanitizeDestinations(
    doc: PDFDocument,
    selection: number[],
): StripOutcome {
    const plan = planDestinations(doc, selection);
    return stripInternalDestinations(doc, plan, selection);
}

/** Whether E1 would refuse this selection, decided without keeping the plan. */
export function wouldBreakNavigation(
    doc: PDFDocument,
    selection: number[],
): { wouldBreak: number; otherSites: { fromIndex: number; key: string }[] } {
    const plan = planDestinations(doc, selection);
    return { wouldBreak: plan.wouldBreak, otherSites: plan.otherSites };
}

/** What M6-H5A's second pass removed, and what has to go back. */
export interface PageRefClosure {
    /** Rebuilt after the copy, against output page references. */
    rebuild: {
        fromIndex: number;
        annotIndex: number | null;
        pagePath: 'annot-P' | 'none';
        targetIndex: number;
    }[];
    losses: LossRecord[];
    /** Structures the walk could not finish. A refusal, not an absence. */
    unreadable: string[];
}

/**
 * Strip every remaining source-page reference from the pages being copied.
 *
 * Runs after {@link stripInternalDestinations}, which has already taken the
 * `/Dest` and top-level `/A /GoTo /D` shapes. What is left is exactly the set
 * M6-H5A added: `/P`, `/AA` on an annotation, a widget or a page, and a `/GoTo`
 * reached through `/Next`.
 *
 * `/P` is the only one rebuilt, because it has an output equivalent: the page
 * the annotation ends up on. An action chain that reaches a `/GoTo` is removed
 * and reported — reconstructing an arbitrary chain against a subset of pages is
 * not a shape this contract has proven.
 */
export function closeSourcePageRefs(
    doc: PDFDocument,
    selection: number[],
): PageRefClosure {
    const kept = new Set(selection);
    const { sites, unreadable } = collectSourcePageRefs(doc, selection);
    const rebuild: PageRefClosure['rebuild'] = [];
    const losses: LossRecord[] = [];

    const pages = doc.getPages();
    const annotIndexOf = (pageIndex: number, holder: PDFDict): number | null => {
        const page = pages[pageIndex];
        if (!page) return null;
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) return null;
        for (let i = 0; i < annots.size(); i += 1) {
            if (look(doc, annots.get(i)) === holder) return i;
        }
        return null;
    };

    for (const site of sites) {
        if (site.shape === 'page' && site.key === 'P') {
            const annotIndex = annotIndexOf(site.fromIndex, site.holder);
            // The annotation belongs to the page it sits on, which is kept by
            // construction — it was reached by walking that page.
            if (annotIndex !== null && kept.has(site.fromIndex)) {
                rebuild.push({
                    fromIndex: site.fromIndex,
                    annotIndex,
                    pagePath: 'annot-P',
                    targetIndex: site.fromIndex,
                });
            }
            site.holder.delete(PDFName.of('P'));
            continue;
        }

        // An action's page reference. Removed, and named.
        site.holder.delete(PDFName.of(site.key));
        losses.push({
            kind: 'internal-links',
            fromIndex: site.fromIndex,
            what: site.where,
            why: site.targetIndex === null
                ? 'ページとして解決できない参照のため削除しました。'
                : kept.has(site.targetIndex)
                    ? '対応範囲外の経路（アクション連鎖）からのページ参照のため削除しました。'
                    : 'リンク先のページが選択されていません。',
        });
    }

    return { rebuild, losses, unreadable };
}

/** Put `/P` back, pointing at the page the annotation actually sits on. */
export function rebuildSourcePageRefs(
    out: PDFDocument,
    closure: PageRefClosure,
    selection: number[],
): number {
    const outPages = out.getPages();
    let rebuilt = 0;
    for (const item of closure.rebuild) {
        const position = selection.indexOf(item.targetIndex);
        const page = outPages[position];
        if (!page || item.annotIndex === null) continue;
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        const annot = out.context.lookup(annots.get(item.annotIndex));
        if (!(annot instanceof PDFDict)) continue;
        annot.set(PDFName.of('P'), page.ref);
        rebuilt += 1;
    }
    return rebuilt;
}

/**
 * Source-page references surviving in an artifact.
 *
 * A page reference in an output document is legitimate only when it resolves to
 * a page of that document's own tree. Anything else — a reference to a page
 * object outside the tree, or one that resolves to nothing — is a reference the
 * copy brought across and nobody retargeted.
 */
export function countSourcePageReferences(doc: PDFDocument): number {
    const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
    let count = 0;

    const isStrayPageRef = (raw: unknown): boolean => {
        if (!(raw instanceof PDFRef)) return false;
        let target: unknown;
        try {
            target = doc.context.lookup(raw);
        } catch {
            return false;
        }
        if (!(target instanceof PDFDict)) return false;
        if (nameOf(target.get(PDFName.of('Type'))) !== '/Page') return false;
        return !inTree.has(raw.tag);
    };

    const seen = new Set<object>();
    const walkAction = (value: unknown, depth: number): void => {
        if (depth > ACTION_CHAIN_BOUND) return;
        const action = look(doc, value);
        if (!(action instanceof PDFDict)) return;
        if (seen.has(action)) return;
        seen.add(action);
        const dest = look(doc, action.get(PDFName.of('D')));
        if (dest instanceof PDFArray && isStrayPageRef(dest.get(0))) count += 1;
        const next = action.get(PDFName.of('Next'));
        const resolved = look(doc, next);
        if (resolved instanceof PDFArray) {
            for (let i = 0; i < resolved.size(); i += 1) walkAction(resolved.get(i), depth + 1);
        } else if (next !== undefined) {
            walkAction(next, depth + 1);
        }
    };

    const walkAdditional = (owner: PDFDict): void => {
        const aa = look(doc, owner.get(PDFName.of('AA')));
        if (!(aa instanceof PDFDict)) return;
        for (const [, entry] of aa.entries()) walkAction(entry, 0);
    };

    for (const page of doc.getPages()) {
        walkAdditional(page.node);
        const annots = look(doc, page.node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let i = 0; i < annots.size(); i += 1) {
            const annot = look(doc, annots.get(i));
            if (!(annot instanceof PDFDict)) continue;
            if (isStrayPageRef(annot.get(PDFName.of('P')))) count += 1;
            const dest = look(doc, annot.get(PDFName.of('Dest')));
            if (dest instanceof PDFArray && isStrayPageRef(dest.get(0))) count += 1;
            walkAction(annot.get(PDFName.of('A')), 0);
            walkAdditional(annot);
        }
    }

    return count;
}

/**
 * Count, on an artifact, what the invariants are about.
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
