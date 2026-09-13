/**
 * E1 and E2, prototyped far enough to prove they are implementable.
 *
 * Not production code and not imported by anything under `src/`. The point is
 * to answer one question with evidence rather than confidence: can an Extract
 * be made to satisfy
 *
 *     every indirect /Page object in the artifact is a member of its page tree
 *
 * while keeping the navigation that is still meaningful, and refusing the rest
 * by name.
 *
 * The measured reason this needs a prototype at all: `copyPages` does not just
 * fail to retarget a destination, it **copies the page the destination points
 * at** (`core/PDFObjectCopier.js:97-109` dispatches on type with no branch for
 * what the referent is) and registers that copy outside `/Pages`
 * (`api/PDFDocument.js:611`). Even extracting *every* page of `nav-4p` produced
 * 4 pages in the tree, 2 orphan page objects, and 0 destinations landing in the
 * document — the links resolve, and they resolve to pages no reader can reach.
 *
 * So neither policy may rely on the copied reference happening to be right.
 * Both strip internal destinations **before** the copy and, for E2, rebuild
 * them afterwards from the output's own page references.
 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFString } from 'pdf-lib';

const nameOf = (v) => (typeof v?.asString === 'function' ? v.asString() : String(v ?? ''));
const textOf = (v) => (typeof v?.decodeText === 'function' ? v.decodeText() : null);

const look = (doc, v) => {
    try {
        return doc.context.lookup(v) ?? v;
    } catch {
        return undefined;
    }
};

/**
 * Where a page can reach another page from.
 *
 * `/Annots` is the obvious route and not the only one: an article bead on a
 * page chains through `/N` to a bead whose `/P` is a different page, so a page
 * with no annotations at all can still drag one in. The `page-refs-beyond-annots`
 * fixture exists because a contract that assumed `/Annots` would have been
 * wrong and would have looked right.
 */
const PAGE_REFERENCE_SITES = ['Annots', 'B'];

/** Every destination on a page, with enough context to remove or rebuild it. */
function destinationsOnPage(doc, page, pageIndexOf) {
    const found = [];
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) return found;

    for (let i = 0; i < annots.size(); i += 1) {
        const annotRef = annots.get(i);
        const annot = look(doc, annotRef);
        if (!(annot instanceof PDFDict)) continue;

        const record = (holder, key, raw) => {
            const dest = look(doc, raw);
            if (dest instanceof PDFArray) {
                const first = dest.get(0);
                const tail = [];
                for (let k = 1; k < dest.size(); k += 1) tail.push(dest.get(k));
                found.push({
                    annotIndex: i,
                    annotRef,
                    holder,
                    key,
                    kind: 'explicit',
                    targetIndex: first instanceof PDFRef ? pageIndexOf(first) : null,
                    targetRef: first instanceof PDFRef ? first.toString() : null,
                    tail,
                });
            } else if (dest !== undefined) {
                found.push({
                    annotIndex: i,
                    annotRef,
                    holder,
                    key,
                    kind: 'named',
                    name: textOf(dest) ?? nameOf(dest),
                    targetIndex: null,
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
function namedDestinations(doc, pageIndexOf) {
    const out = [];
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (!(names instanceof PDFDict)) return out;
    const dests = names.lookup(PDFName.of('Dests'));
    if (!(dests instanceof PDFDict)) return out;
    const arr = dests.lookup(PDFName.of('Names'));
    if (!(arr instanceof PDFArray)) return out;
    for (let i = 0; i + 1 < arr.size(); i += 2) {
        const name = textOf(look(doc, arr.get(i)));
        const dest = look(doc, arr.get(i + 1));
        if (!(dest instanceof PDFArray)) continue;
        const first = dest.get(0);
        const tail = [];
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
 * Plan an extract before anything is copied.
 *
 * Everything here is decided on the source document, which is the only moment
 * the answer is knowable without having already done the damage: `copyPages`
 * flushes the source (`api/PDFDocument.js:644`) and the copy is what creates
 * the orphans.
 */
export async function planExtract(sourceBytes, selection) {
    const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const pages = doc.getPages();
    const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
    const pageIndexOf = (ref) => (byTag.has(ref.tag) ? byTag.get(ref.tag) : null);
    const kept = new Set(selection);

    const links = [];
    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;
        for (const d of destinationsOnPage(doc, page, pageIndexOf)) {
            links.push({ ...d, fromIndex: index });
        }
    }

    const named = namedDestinations(doc, pageIndexOf);

    // Page references that are not annotations at all.
    const otherSites = [];
    for (const index of selection) {
        const page = pages[index];
        if (!page) continue;
        for (const key of PAGE_REFERENCE_SITES) {
            if (key === 'Annots') continue;
            if (page.node.get(PDFName.of(key)) !== undefined) {
                otherSites.push({ fromIndex: index, key });
            }
        }
    }

    const classify = (targetIndex) => {
        if (targetIndex === null) return 'unresolved';
        return kept.has(targetIndex) ? 'in-selection' : 'out-of-selection';
    };

    const explicit = links.filter((l) => l.kind === 'explicit');
    const namedLinks = links.filter((l) => l.kind === 'named');
    const namedByName = new Map(named.map((n) => [n.name, n]));

    const breaks = explicit.filter((l) => classify(l.targetIndex) !== 'in-selection');
    const namedBreaks = namedLinks.filter((l) => {
        const entry = namedByName.get(l.name);
        return !entry || classify(entry.targetIndex) !== 'in-selection';
    });

    return {
        pageCount: pages.length,
        selection,
        explicit: explicit.map((l) => ({
            fromIndex: l.fromIndex, targetIndex: l.targetIndex, status: classify(l.targetIndex),
        })),
        named: named.map((n) => ({
            name: n.name, targetIndex: n.targetIndex, status: classify(n.targetIndex),
        })),
        namedLinks: namedLinks.map((l) => ({ fromIndex: l.fromIndex, name: l.name })),
        otherPageReferenceSites: otherSites,
        wouldBreak: breaks.length + namedBreaks.length,
        _doc: doc,
        _links: links,
        _named: named,
        _pageIndexOf: pageIndexOf,
    };
}

/**
 * E1 — refuse the selection when it would break navigation.
 *
 * Cheap, because the answer is known before a page is copied. It is the right
 * default for a workflow where a broken cross-reference is not acceptable, and
 * it needs no reconstruction machinery at all.
 */
export async function extractE1(sourceBytes, selection) {
    const plan = await planExtract(sourceBytes, selection);
    if (plan.wouldBreak > 0 || plan.otherPageReferenceSites.length > 0) {
        return {
            status: 'REFUSED',
            code: 'BROKEN_DESTINATIONS',
            reason: `選択したページから、選択に含まれないページへの参照が${plan.wouldBreak}件あります。`
                + (plan.otherPageReferenceSites.length > 0
                    ? `また、注釈以外の経路（${plan.otherPageReferenceSites.map((s) => `/${s.key}`).join(', ')}）でも他ページを参照しています。`
                    : ''),
            plan,
        };
    }
    const bytes = await extractE2(sourceBytes, selection).then((r) => r.bytes);
    return { status: 'READY', code: 'SUCCEEDED', bytes, plan };
}

/**
 * E2 — keep the selection, rebuild what can be rebuilt, report what cannot.
 *
 * The order is the whole trick:
 *
 *   1. on a working copy, strip every internal destination from the pages being
 *      copied — including the ones whose target *is* kept, because leaving them
 *      is what makes the copier drag a duplicate page in;
 *   2. copy the pages;
 *   3. rebuild the destinations that are still meaningful, pointing at the
 *      output document's own page references;
 *   4. rebuild the named destinations whose target survived;
 *   5. report everything dropped, by name.
 *
 * Step 1 is not an optimisation. Without it the artifact contains page objects
 * the user never selected.
 */
export async function extractE2(sourceBytes, selection) {
    const plan = await planExtract(sourceBytes, selection);
    const doc = plan._doc;
    const kept = new Set(selection);
    const losses = [];

    // ---- 1. strip -----------------------------------------------------------
    const rebuild = [];
    for (const link of plan._links) {
        const holderDict = link.holder;
        if (link.kind === 'named') {
            const entry = plan._named.find((n) => n.name === link.name);
            if (entry && kept.has(entry.targetIndex)) {
                rebuild.push({
                    annotRef: link.annotRef,
                    key: link.key,
                    holderIsAction: link.key === 'D',
                    targetIndex: entry.targetIndex,
                    tail: entry.tail,
                    via: `named:${link.name}`,
                });
            } else {
                losses.push({
                    kind: 'named-destination-link',
                    from: link.fromIndex,
                    name: link.name,
                    why: entry ? 'target page not selected' : 'name not found in the document',
                });
            }
            holderDict.delete(PDFName.of(link.key));
            continue;
        }

        if (link.targetIndex !== null && kept.has(link.targetIndex)) {
            rebuild.push({
                annotRef: link.annotRef,
                key: link.key,
                holderIsAction: link.key === 'D',
                targetIndex: link.targetIndex,
                tail: link.tail,
                via: 'explicit',
            });
        } else {
            losses.push({
                kind: 'internal-link',
                from: link.fromIndex,
                target: link.targetIndex,
                why: link.targetIndex === null ? 'destination did not resolve to a page' : 'target page not selected',
            });
        }
        holderDict.delete(PDFName.of(link.key));
    }

    // Page reference sites that are not annotations: removed wholesale, and
    // reported. Reconstructing an article thread across a subset of its pages
    // is a different feature, not a silent side effect of extracting.
    for (const site of plan.otherPageReferenceSites) {
        const page = doc.getPages()[site.fromIndex];
        page.node.delete(PDFName.of(site.key));
        losses.push({ kind: 'page-reference', from: site.fromIndex, key: `/${site.key}`, why: 'not reconstructable from a subset' });
    }

    // ---- 2. copy ------------------------------------------------------------
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(doc, selection);
    copied.forEach((p) => out.addPage(p));
    const outPages = out.getPages();
    const outRefOf = (sourceIndex) => outPages[selection.indexOf(sourceIndex)].ref;

    // ---- 3. rebuild explicit destinations -----------------------------------
    //
    // The copied annotation is found by its position: `copyPages` preserves the
    // order of `/Annots`, and the annotation that carried the destination is
    // the same one in the copy.
    for (const item of rebuild) {
        const fromPos = plan._links.find((l) => l.annotRef === item.annotRef);
        const outPage = outPages[selection.indexOf(fromPos.fromIndex)];
        const annots = outPage.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) continue;
        const annot = out.context.lookup(annots.get(fromPos.annotIndex));
        if (!(annot instanceof PDFDict)) continue;

        const tail = item.tail.map((t) => (t?.clone ? t.clone(out.context) : t));
        const dest = out.context.obj([outRefOf(item.targetIndex), ...tail]);
        if (item.holderIsAction) {
            annot.set(PDFName.of('A'), out.context.obj({ Type: 'Action', S: 'GoTo', D: dest }));
        } else {
            annot.set(PDFName.of('Dest'), dest);
        }
    }

    // ---- 4. rebuild the named destinations that survived ---------------------
    const survivingNames = plan._named.filter((n) => kept.has(n.targetIndex));
    for (const n of plan._named) {
        if (!kept.has(n.targetIndex)) {
            losses.push({ kind: 'named-destination', name: n.name, why: 'target page not selected' });
        }
    }
    if (survivingNames.length > 0) {
        const flat = [];
        for (const n of survivingNames) {
            const tail = n.tail.map((t) => (t?.clone ? t.clone(out.context) : t));
            flat.push(PDFString.of(n.name), out.context.obj([outRefOf(n.targetIndex), ...tail]));
        }
        out.catalog.set(PDFName.of('Names'), out.context.register(out.context.obj({
            Dests: { Names: flat },
        })));
    }

    const bytes = await out.save({ useObjectStreams: false });
    return { status: 'READY', code: 'SUCCEEDED', bytes, losses, plan, rebuilt: rebuild.length };
}
