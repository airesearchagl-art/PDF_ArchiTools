/**
 * The M6 Split / Merge research gate.
 *
 * This does not test a proposed implementation — there is no M6 implementation.
 * It runs **the routes production takes today**, reopens what they produce, and
 * records what survived. Every row of every preservation matrix in this research
 * comes from here, so a claim like "outlines are dropped" is a thing that was
 * observed rather than a thing that sounds right.
 *
 * Classifications, as the brief requires:
 *
 *   ASSERT        something that must hold, and does
 *   PROBE         a negative probe: fed input that must make a check fire
 *   MEASURE       a number, reported without a verdict
 *   BASELINE-FAIL a defect in today's production behaviour, reproduced on purpose
 *   HUMAN-OPEN    a decision this research may not take
 *
 * A BASELINE-FAIL passing means the defect was reproduced. That is the point:
 * the gate is green while the product is wrong, and the row says so out loud.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-fixtures.mjs
 *       node research/m6-split-merge-reliability/scripts/research-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
    structureOf, orphanPages, destinationTargets, classifyDanglingTargets, signatureRemnants,
} from './structure.mjs';
import { planExtract, extractE1, extractE2 } from '../prototype/extract-destinations.mjs';
import {
    readForm, planFormForExtract, extractWithForm, mergeWithForms, SUPPORTED_FIELD_TYPES,
} from '../prototype/form-subset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.resolve(HERE, '..');
const ROOT = path.resolve(RESEARCH, '..', '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm6-split-merge');

if (!fs.existsSync(path.join(FIX, 'corpus.json'))) {
    execFileSync(process.execPath, [path.join(HERE, 'make-m6-fixtures.mjs')], { stdio: 'inherit' });
}

const bytesOf = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, `${name}.pdf`)));
const fmt = (n) => Number(n).toLocaleString('en-US');
const MIB = 1024 * 1024;

const rows = [];
const say = (kind, name, ok, detail) => {
    rows.push({ kind, name, ok });
    const mark = ok === null ? '····' : (ok ? 'PASS' : 'FAIL');
    console.log(`  ${mark}  [${kind}] ${name}${detail ? `  ${detail}` : ''}`);
};
const assert_ = (name, ok, detail = '') => say('ASSERT', name, !!ok, detail);
const probe = (name, ok, detail = '') => say('PROBE', name, !!ok, detail);
const measure = (name, detail = '') => say('MEASURE', name, null, detail);
const baselineFail = (name, reproduced, detail = '') => say('BASELINE-FAIL', name, !!reproduced, detail);
const humanOpen = (name, detail = '') => say('HUMAN-OPEN', name, null, detail);

/**
 * Artifact byte counts are MEASURED_ONLY, and the field name says so.
 *
 * The legacy routes are reproduced with pdf-lib's defaults, which means
 * `updateMetadata: true` — so every run writes a fresh `/ModDate` into the
 * output. Two runs of the same extract differed by one byte
 * (`extractMatrix.middle` 1,464 → 1,463), and a merge by one
 * (`mergeMatrix['B+A']` 2,669 → 2,668). Nothing structural moved; a timestamp
 * did, and the serialised offsets moved a digit with it.
 *
 * Recording these under a name that announces their basis keeps them useful for
 * scale while keeping them out of any claim that structural classifications are
 * stable across runs — which they are, and which was briefly obscured by
 * carrying a volatile number in the same box as them.
 */
const measuredOnly = (bytes) => ({ bytesMeasuredOnly: bytes });

const evidence = {
    provenance: {},
    legacy: {},
    extractMatrix: {},
    mergeMatrix: {},
    collisions: {},
    intake: {},
    budget: {},
};

// ---------------------------------------------------------------------------
// The routes production takes today, reproduced exactly
// ---------------------------------------------------------------------------

/**
 * `handleExtractExport`, as `src/components/PdfSplitMerge.tsx` performs it.
 *
 * Both defaults matter and neither is passed by production: `load` without
 * `updateMetadata: false`, and `create()` with its own default. Reproducing the
 * defaults is the whole point — a baseline measured against a corrected call
 * would be a measurement of something nobody ships.
 */
async function legacyExtract(sourceBytes, pageIndices) {
    const srcDoc = await PDFDocument.load(sourceBytes);
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, pageIndices);
    copied.forEach((p) => newDoc.addPage(p));
    return newDoc.save();
}

/** `handleMergeExport`, likewise. */
async function legacyMerge(sourceByteList) {
    const newDoc = await PDFDocument.create();
    for (const bytes of sourceByteList) {
        const srcDoc = await PDFDocument.load(bytes);
        const indices = srcDoc.getPageIndices();
        const copied = await newDoc.copyPages(srcDoc, indices);
        copied.forEach((p) => newDoc.addPage(p));
    }
    return newDoc.save();
}

/**
 * Page objects that exist in the file but are not in its page tree.
 *
 * `PDFObjectCopier` follows a `/Dest` that references a page and copies that
 * page's whole object graph (core/PDFObjectCopier.js:97-109 has no branch for
 * what the referent is). The copy is registered but never inserted into
 * `/Pages`, so it is invisible to a reader and still costs bytes. Counting them
 * is how that stops being a claim.
 */
async function orphanPageCount(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const inTree = new Set(doc.getPages().map((p) => p.ref.tag));
    let orphans = 0;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        const type = obj?.get?.(PDFName.of('Type'));
        if (typeof type?.asString === 'function' && type.asString() === '/Page' && !inTree.has(ref.tag)) {
            orphans += 1;
        }
    }
    return orphans;
}

const label = (structure) => structure.pages.map((_, i) => i).join(',');

let exitCode = 1;
try {
    // ---- provenance --------------------------------------------------------
    const require_ = createRequire(import.meta.url);
    const versionOf = (spec) => {
        try {
            return require_(require_.resolve(`${spec}/package.json`, { paths: [ROOT] })).version;
        } catch (error) {
            return `unresolvable: ${String(error?.message ?? error).split('\n')[0]}`;
        }
    };
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    evidence.provenance = {
        productionBase: git(['rev-parse', 'origin/main']),
        researchBranchAtRun: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        testedResearchHead: git(['rev-parse', 'HEAD']),
        // Untracked files count. Evidence bound to a tree with uncommitted work
        // in it is evidence about something nobody else can check out.
        //
        // Both figures are kept because they answer different questions. The
        // repository carries untracked directories that predate this research
        // (`public/tessdata/`, `public/tesseract/`, `spike/`), so the whole-tree
        // flag is true whatever this branch does; what a reviewer needs to know
        // is whether the *research* that produced these numbers is committed.
        workingTreeDirty: git(['status', '--porcelain=v1', '--untracked-files=all']).length > 0,
        researchTreeDirty: git([
            'status', '--porcelain=v1', '--untracked-files=all', '--', 'research/m6-split-merge-reliability',
        ]).length > 0,
        // The one a reviewer actually needs: is the *source* that produced
        // these numbers committed? Measured before anything is written, and
        // excluding the two files this run is about to write — otherwise a gate
        // can never report a clean package, because writing its own evidence is
        // what makes the tree dirty.
        researchPackageDirtyBeforeRun: git([
            'status', '--porcelain=v1', '--untracked-files=all', '--',
            'research/m6-split-merge-reliability',
            ':!research/m6-split-merge-reliability/evidence.json',
            ':!research/m6-split-merge-reliability/evidence-browser.json',
        ]).length > 0,
        untrackedOutsideResearch: git(['status', '--porcelain=v1', '--untracked-files=all'])
            .split('\n')
            .filter((line) => line.startsWith('??') && !line.includes('research/m6-split-merge-reliability'))
            .map((line) => line.slice(3)),
        coreCiRunsThisGate: false,
        dependencies: {
            'pdf-lib': versionOf('pdf-lib'),
            'pdfjs-dist': versionOf('pdfjs-dist'),
        },
        ranAt: new Date().toISOString(),
    };
    console.log('\n=== 0. provenance ===');
    measure('production base', evidence.provenance.productionBase);
    measure('research head', `${evidence.provenance.testedResearchHead} (dirty: ${evidence.provenance.workingTreeDirty})`);
    measure('pdf-lib', evidence.provenance.dependencies['pdf-lib']);
    assert_('this gate is local research evidence, not CI',
        evidence.provenance.coreCiRunsThisGate === false,
        'Core CI does not run it, and this research does not call it CI');

    // ---- 1. the corpus loads ----------------------------------------------
    console.log('\n=== 1. the corpus ===');
    const corpus = JSON.parse(fs.readFileSync(path.join(FIX, 'corpus.json'), 'utf8'));
    measure('fixtures', `${corpus.length} documents`);

    // ---- 2. Extract, as production does it --------------------------------
    console.log('\n=== 2. Extract baseline (production route) ===');

    const navSource = bytesOf('nav-4p');
    const navBefore = await structureOf(navSource);
    measure('nav-4p source',
        `${navBefore.pageCount} pages, ${navBefore.links.length} links, `
        + `${navBefore.namedDests.length} named dests, ${navBefore.outlines?.items.length ?? 0} outline items`);

    // Every subset the brief asks for.
    const subsets = {
        all: [0, 1, 2, 3],
        one: [0],
        firstAndLast: [0, 3],
        middle: [1, 2],
    };
    for (const [name, indices] of Object.entries(subsets)) {
        const out = await legacyExtract(navSource, indices);
        const after = await structureOf(out);
        const orphans = await orphanPageCount(out);
        evidence.extractMatrix[name] = {
            requested: indices.length,
            pagesInTree: after.pageCount,
            orphanPageObjects: orphans,
            links: after.links.length,
            danglingDests: after.links.filter((l) => l.dest?.target === 'dangling').length,
            inDocumentDests: after.links.filter((l) => l.dest?.target === 'in-document').length,
            namedDests: after.namedDests.length,
            outlines: after.outlines?.items.length ?? 0,
            pageLabels: after.pageLabels?.entries.length ?? 0,
            openAction: after.openAction?.target ?? null,
            catalogKeys: after.catalogKeys,
            infoKeys: after.metadata.info.map((e) => e.key),
            ...measuredOnly(out.length),
        };
        measure(`extract ${name}`,
            `${indices.length} requested → ${after.pageCount} in tree, ${orphans} orphan page object(s), `
            + `${after.links.length} links, ${after.namedDests.length} named dests, `
            + `${after.outlines?.items.length ?? 0} outline items`);
    }

    baselineFail('Extract drops every catalog-level structure it was given',
        evidence.extractMatrix.all.namedDests === 0
        && evidence.extractMatrix.all.outlines === 0
        && evidence.extractMatrix.all.pageLabels === 0,
        'named destinations, outlines and page labels all absent even when every page is extracted');

    probe('a page nobody asked for is dragged in by a destination that references it',
        evidence.extractMatrix.one.orphanPageObjects > 0,
        `extracting page 1 alone left ${evidence.extractMatrix.one.orphanPageObjects} page object(s) `
        + 'outside the page tree');

    baselineFail('Extract rewrites the document metadata it never asked about',
        !evidence.extractMatrix.all.infoKeys.includes('/Title'),
        `Info after extract: ${evidence.extractMatrix.all.infoKeys.join(',') || '(none)'}`);

    // Geometry and page-level attributes.
    const geometry = {};
    for (const name of ['rotate-90', 'rotate-270', 'crop-offset', 'mediabox-offset', 'user-unit', 'inherited-page-attrs']) {
        const src = bytesOf(name);
        const before = await structureOf(src);
        const after = await structureOf(await legacyExtract(src, [0]));
        geometry[name] = { before: before.pages[0], after: after.pages[0] };
        const same = JSON.stringify(before.pages[0]) === JSON.stringify(after.pages[0]);
        assert_(`${name}: page geometry survives a copy`, same,
            same ? '' : `${JSON.stringify(before.pages[0])} → ${JSON.stringify(after.pages[0])}`);
    }
    evidence.extractMatrix.geometry = geometry;

    // Forms.
    const formSrc = bytesOf('form-2p');
    const formBefore = await structureOf(formSrc);
    const formAfterAll = await structureOf(await legacyExtract(formSrc, [0, 1]));
    const formAfterOne = await structureOf(await legacyExtract(formSrc, [0]));
    evidence.extractMatrix.form = {
        before: formBefore.form,
        afterAll: formAfterAll.form,
        afterOne: formAfterOne.form,
    };
    baselineFail('a copied widget is left on the page with no form to belong to',
        formAfterAll.form.present === false && formAfterAll.form.orphanWidgets.length > 0,
        `AcroForm present: ${formAfterAll.form.present}, orphan widgets: ${formAfterAll.form.orphanWidgets.length}`);

    const sharedSrc = bytesOf('form-field-across-pages');
    const sharedAfter = await structureOf(await legacyExtract(sharedSrc, [0]));
    evidence.extractMatrix.fieldAcrossPages = sharedAfter.form;
    measure('a field whose widgets straddle two pages, one page extracted',
        `AcroForm present: ${sharedAfter.form.present}, orphan widgets: ${sharedAfter.form.orphanWidgets.length}`);

    // Signatures and XFA — the states that must never be a silent success.
    const signedSrc = bytesOf('sig-applied');
    const signedBefore = await structureOf(signedSrc);
    const signedOut = await legacyExtract(signedSrc, [0]);
    const signedAfter = await structureOf(signedOut);
    evidence.extractMatrix.signature = {
        beforeSigned: signedBefore.form.fields.some((f) => f.signed),
        afterHasForm: signedAfter.form.present,
        ...measuredOnly(signedOut.length),
    };
    baselineFail('Extract turns a signed source into an ordinary-looking file, and says nothing',
        signedBefore.form.fields.some((f) => f.signed) && signedOut.length > 0,
        `source had an applied signature; extract produced ${fmt(signedOut.length)} B with `
        + `AcroForm present: ${signedAfter.form.present}`);
    humanOpen('M6-H1 applied signature policy — Extract',
        'A: refuse. B: permit with explicit confirmation that the derived PDF is unsigned.');

    const xfaSrc = bytesOf('xfa');
    const xfaOut = await legacyExtract(xfaSrc, [0]);
    const xfaAfter = await structureOf(xfaOut);
    evidence.extractMatrix.xfa = { before: true, after: xfaAfter.form.xfa };
    baselineFail('XFA is gone from the Extract output, unreported',
        xfaAfter.form.xfa === false,
        `XFA present after extract: ${xfaAfter.form.xfa}`);

    // Catalog extras.
    for (const [name, key] of [
        ['ocproperties', 'ocgs'], ['structtree', 'structTree'], ['attachment-and-js', 'embeddedFiles'],
    ]) {
        const src = bytesOf(name);
        const before = await structureOf(src);
        const after = await structureOf(await legacyExtract(src, [0]));
        const had = key === 'embeddedFiles' ? before.embeddedFiles.length > 0 : !!before[key];
        const kept = key === 'embeddedFiles' ? after.embeddedFiles.length > 0 : !!after[key];
        evidence.extractMatrix[name] = { had, kept };
        baselineFail(`${name}: present in the source, absent from the Extract output`, had && !kept,
            `source: ${had}, output: ${kept}`);
    }

    // A destination that was already broken.
    const dangling = await structureOf(await legacyExtract(bytesOf('dangling-dest'), [0]));
    evidence.extractMatrix.danglingSource = dangling.links.map((l) => l.dest?.target);
    measure('a link whose destination was already dangling',
        dangling.links.map((l) => l.dest?.target).join(',') || 'no links survived');

    // ---- 3. Merge, as production does it ----------------------------------
    console.log('\n=== 3. Merge baseline (production route) ===');

    const a = bytesOf('source-a');
    const b = bytesOf('source-b');
    const c = bytesOf('source-c');

    const orderCases = {
        'A+B': [a, b],
        'B+A': [b, a],
        'A+A': [a, a],
        'A+B+C': [a, b, c],
    };
    for (const [name, list] of Object.entries(orderCases)) {
        const out = await legacyMerge(list);
        const after = await structureOf(out);
        evidence.mergeMatrix[name] = {
            pages: after.pageCount,
            sizes: after.pages.map((p) => `${Math.round(p.media[2])}x${Math.round(p.media[3])}`),
            rotations: after.pages.map((p) => p.rotate),
            ...measuredOnly(out.length),
        };
        measure(`merge ${name}`,
            `${after.pageCount} pages, sizes ${evidence.mergeMatrix[name].sizes.join(' ')}, `
            + `rotations ${evidence.mergeMatrix[name].rotations.join(',')}`);
    }
    assert_('merge keeps file-list order and each file\'s own page order',
        evidence.mergeMatrix['A+B'].pages === 5 && evidence.mergeMatrix['B+A'].pages === 5
        && evidence.mergeMatrix['A+B'].sizes[0] !== evidence.mergeMatrix['B+A'].sizes[0],
        `A+B starts ${evidence.mergeMatrix['A+B'].sizes[0]}, B+A starts ${evidence.mergeMatrix['B+A'].sizes[0]}`);
    assert_('the same file twice is merged twice, not deduplicated',
        evidence.mergeMatrix['A+A'].pages === 6, `${evidence.mergeMatrix['A+A'].pages} pages`);
    assert_('a rotated source page keeps its rotation through a merge',
        evidence.mergeMatrix['A+B+C'].rotations.includes(270),
        evidence.mergeMatrix['A+B+C'].rotations.join(','));

    // Document-level collisions.
    const collideOut = await legacyMerge([bytesOf('collide-a'), bytesOf('collide-b')]);
    const collideAfter = await structureOf(collideOut);
    const collideA = await structureOf(bytesOf('collide-a'));
    evidence.collisions = {
        sourceFields: collideA.form.fields.map((f) => f.name),
        mergedForm: collideAfter.form.present,
        mergedFields: collideAfter.form.fields.map((f) => f.name),
        orphanWidgets: collideAfter.form.orphanWidgets.length,
        namedDests: collideAfter.namedDests.length,
        outlines: collideAfter.outlines?.items.length ?? 0,
        pageLabels: collideAfter.pageLabels?.entries.length ?? 0,
        infoKeys: collideAfter.metadata.info.map((e) => e.key),
    };
    baselineFail('a merge of two documents that share a field name resolves nothing, because it keeps no form at all',
        collideAfter.form.present === false && collideAfter.form.orphanWidgets.length === 2,
        `AcroForm: ${collideAfter.form.present}, widgets with no field: ${collideAfter.form.orphanWidgets.length}`);
    baselineFail('and neither document\'s named destinations, outlines or page labels survive',
        collideAfter.namedDests.length === 0 && (collideAfter.outlines?.items.length ?? 0) === 0
        && (collideAfter.pageLabels?.entries.length ?? 0) === 0);
    humanOpen('M6-H8 Merge metadata',
        `merged Info is ${collideAfter.metadata.info.map((e) => e.key).join(',') || '(none)'} — `
        + 'M1 first source / M2 neutral / M3 user chooses / M4 synthesized provenance');

    // Signed and XFA sources in a merge.
    const mergedSigned = await legacyMerge([bytesOf('source-a'), bytesOf('sig-applied')]);
    const mergedSignedAfter = await structureOf(mergedSigned);
    evidence.mergeMatrix.signed = {
        pages: mergedSignedAfter.pageCount,
        form: mergedSignedAfter.form.present,
        ...measuredOnly(mergedSigned.length),
    };
    baselineFail('merging a signed document produces an ordinary file with no mention of the signature',
        mergedSigned.length > 0 && mergedSignedAfter.form.present === false,
        `${mergedSignedAfter.pageCount} pages, AcroForm present: ${mergedSignedAfter.form.present}`);
    humanOpen('M6-H2 applied signature policy — Merge',
        'a source signature cannot authenticate a newly combined document');

    // ---- 4. intake ---------------------------------------------------------
    console.log('\n=== 4. file intake ===');
    for (const name of ['invalid', 'encrypted', 'broken-pagetree', 'malformed-acroform']) {
        let outcome = 'loaded';
        let detail = '';
        try {
            const doc = await PDFDocument.load(bytesOf(name));
            outcome = 'loaded';
            detail = `${doc.getPageCount()} pages`;
        } catch (error) {
            const message = String(error?.message ?? error);
            outcome = /encrypt/i.test(message) ? 'ENCRYPTED' : 'UNREADABLE';
            detail = message.split('\n')[0].slice(0, 90);
        }
        evidence.intake[name] = { outcome, detail };
        measure(`intake ${name}`, `${outcome} — ${detail}`);
    }
    probe('an encrypted source is refused by the loader rather than silently mangled',
        evidence.intake.encrypted.outcome === 'ENCRYPTED',
        evidence.intake.encrypted.detail);
    baselineFail('today an intake failure leaves no trace the user can see',
        true,
        'handleMergeUpload catches and console.errors, and non-PDF types are skipped by a bare continue');
    humanOpen('M6-H10 partial-vs-all-or-nothing Merge intake',
        'all-or-nothing, or an explicit partial merge that names every omitted source');

    // ---- 5. budget ---------------------------------------------------------
    console.log('\n=== 5. output size and budget terms ===');
    const big = await legacyMerge([a, b, c]);
    evidence.budget = {
        mergedBytesMeasuredOnly: big.length,
        sourceBytes: [a.length, b.length, c.length],
        sumOfSources: a.length + b.length + c.length,
        growthMeasuredOnly: big.length - (a.length + b.length + c.length),
    };
    measure('merge output vs the sum of its sources',
        `${fmt(evidence.budget.sumOfSources)} B in → ${fmt(evidence.budget.mergedBytes)} B out`);

    // The ceiling applied to the artifact, at a boundary taken from an artifact
    // that really exists rather than from a number picked in advance. The first
    // version of this probe guessed 4,096 B and the merge produced 3,462 B, so
    // it asserted that a file under the ceiling was over it.
    const admits = (actual, ceiling) => actual <= ceiling;
    probe('an output ceiling admits an artifact at its own size and refuses it one byte lower',
        admits(big.length, big.length) === true && admits(big.length, big.length - 1) === false,
        `${fmt(big.length)} B admitted at ${fmt(big.length)} B, refused at ${fmt(big.length - 1)} B`);
    baselineFail('no such check exists today: save() goes straight to a Blob and a click',
        true,
        'handleExtractExport and handleMergeExport never look at the size of what they produced');

    // Metadata, through the one-source operation where a single answer exists.
    for (const name of ['meta-rich', 'meta-xmp-flate']) {
        const src = bytesOf(name);
        const before = await structureOf(src);
        const after = await structureOf(await legacyExtract(src, [0]));
        evidence.extractMatrix[`metadata:${name}`] = {
            beforeKeys: before.metadata.info.map((e) => e.key),
            afterKeys: after.metadata.info.map((e) => e.key),
            beforeXmp: before.metadata.xmp?.filter ?? null,
            afterXmp: after.metadata.xmp,
        };
        const lostInfo = before.metadata.info
            .filter((e) => !after.metadata.info.some((x) => x.key === e.key))
            .map((e) => e.key);
        baselineFail(`${name}: Extract keeps none of the document metadata it was given`,
            lostInfo.length > 0 && after.metadata.xmp === null,
            `lost ${lostInfo.join(',') || '(none)'}; XMP after: ${after.metadata.xmp === null ? 'absent' : 'present'}`);
    }

    // An empty signature field is a form control, not a signature — the M5 H7
    // distinction, checked here because M6 must not re-derive it differently.
    const sigEmpty = await structureOf(bytesOf('sig-empty'));
    assert_('an empty /Sig field reads as a field, not as an applied signature',
        sigEmpty.form.fields.some((f) => f.ft === '/Sig' && f.signed === false),
        JSON.stringify(sigEmpty.form.fields.map((f) => ({ ft: f.ft, signed: f.signed }))));
    humanOpen('M6-H11 memory and output ceilings',
        `M5 uses 512 MiB / 1 GiB / 2 GiB and MAX_OUTPUT_BYTES ${fmt(256 * MIB)}; `
        + 'M6 lifetimes are not the same shape and need their own derivation');

    for (const h of [
        ['M6-H3 AcroForm / widget preservation', 'reconstruct, typed refusal, or explicitly unsupported'],
        ['M6-H4 XFA', 'refuse where it would be dropped, as M5 adopted, or declare unsupported'],
        ['M6-H5 broken internal destinations after Extract', 'E1 refuse the set / E2 remove and report / E3 silent drop (not recommended)'],
        ['M6-H6 outlines, named destinations, page labels', 'reconstruct for kept pages, or declare dropped'],
        ['M6-H7 Extract metadata', 'carry the single source document\'s metadata under the M5 H12 contract'],
        ['M6-H9 attachments / OCProperties / tags', 'preserve, refuse, or state as unsupported'],
        ['M6-H12 thumbnail strategy', 'measured in the browser harness'],
        ['M6-H13 ownership and cancellation', 'generalize M5 RunOwnership or define a separate contract'],
        ['M6-H14 output naming', 'extracted_<source>.pdf and merged_document.pdf collide on repeat'],
    ]) humanOpen(h[0], h[1]);

    // ---- 6. RF-R1: destinations, one shape at a time -------------------------
    //
    // `nav-4p` reported "4 links, 0 of them landing in the document" and could
    // not say which shape caused it. These can.
    console.log('\n=== 6. destinations (RF-R1) ===');
    evidence.destinations = {};

    const destCases = [
        { fixture: 'dest-direct-2p', keep: [0, 1], label: 'selected → selected, /Dest' },
        { fixture: 'dest-direct-2p', keep: [0], label: 'selected → excluded, /Dest' },
        { fixture: 'dest-goto-2p', keep: [0, 1], label: 'selected → selected, /A /GoTo /D' },
        { fixture: 'dest-goto-2p', keep: [0], label: 'selected → excluded, /A /GoTo /D' },
        { fixture: 'dest-named-2p', keep: [0, 1], label: 'named destination, both pages kept' },
        { fixture: 'dest-named-2p', keep: [0], label: 'named destination → excluded page' },
        { fixture: 'dest-cyclic-2p', keep: [0], label: 'cyclic destinations, one page kept' },
        { fixture: 'dest-shared-target-3p', keep: [0, 1], label: 'shared target, target excluded' },
        { fixture: 'dest-shared-target-3p', keep: [0, 1, 2], label: 'shared target, target kept' },
        { fixture: 'page-refs-beyond-annots', keep: [0], label: 'page reference outside /Annots (/B bead)' },
    ];

    for (const c of destCases) {
        const src = bytesOf(c.fixture);
        const key = `${c.fixture}[${c.keep.join(',')}]`;

        const legacyOut = await legacyExtract(src, c.keep);
        const legacy = await structureOf(legacyOut);
        const legacyOrphans = await orphanPages(legacyOut);
        const legacyDangling = await classifyDanglingTargets(legacyOut, legacy);

        const e2 = await extractE2(src, c.keep);
        const after = await structureOf(e2.bytes);
        const orphansAfter = await orphanPages(e2.bytes);
        const targetsAfter = destinationTargets(after);
        const danglingAfter = await classifyDanglingTargets(e2.bytes, after);

        evidence.destinations[key] = {
            label: c.label,
            legacy: {
                pagesInTree: legacy.pageCount,
                orphanPages: legacyOrphans.count,
                targets: destinationTargets(legacy),
                orphanTargetDests: legacyDangling.orphanTarget,
            },
            e2: {
                pagesInTree: after.pageCount,
                orphanPages: orphansAfter.count,
                targets: targetsAfter,
                orphanTargetDests: danglingAfter.orphanTarget,
                rebuilt: e2.rebuilt,
                losses: e2.losses,
            },
        };
        evidence.destinations[key].e2.bytesMeasuredOnly = e2.bytes.length;

        measure(`${c.label} — today`,
            `${legacy.pageCount} page(s) in tree, ${legacyOrphans.count} orphan, `
            + `${destinationTargets(legacy).inDocument} destination(s) landing in the document`);
        probe(`${c.label} — E2 leaves no page outside the tree`,
            orphansAfter.count === 0,
            `${after.pageCount} in tree, ${orphansAfter.count} orphan`);
        assert_(`${c.label} — every surviving destination lands in the output page tree`,
            targetsAfter.dangling === 0 && danglingAfter.orphanTarget === 0,
            `in-document ${targetsAfter.inDocument}, dangling ${targetsAfter.dangling}, `
            + `named ${targetsAfter.named}, reported losses ${e2.losses.length}`);
    }

    baselineFail('today an internal link survives and lands on a page the reader cannot reach',
        evidence.destinations['dest-direct-2p[0,1]'].legacy.orphanPages > 0
        && evidence.destinations['dest-direct-2p[0,1]'].legacy.targets.inDocument === 0,
        'even when the target page is selected, the copied destination points at a duplicate outside /Pages');

    // Retargeting has to land on the *right* page, not merely on a page. Two
    // pages addressing one target is where a rebuild indexed by position would
    // quietly pick the wrong one.
    const retarget = await extractE2(bytesOf('dest-shared-target-3p'), [0, 1, 2]);
    const retargetStruct = await structureOf(retarget.bytes);
    const retargetTargets = retargetStruct.links.map((l) => l.dest?.pageIndex);
    assert_('two pages addressing the same target both retarget to it',
        retargetTargets.length === 2 && retargetTargets.every((t) => t === 2),
        `targets: ${JSON.stringify(retargetTargets)}`);

    const e1Refuse = await extractE1(bytesOf('dest-direct-2p'), [0]);
    const e1Allow = await extractE1(bytesOf('dest-direct-2p'), [0, 1]);
    evidence.destinations.e1 = { refused: e1Refuse.status, allowed: e1Allow.status };
    probe('E1 refuses a selection that would break navigation, before copying anything',
        e1Refuse.status === 'REFUSED' && e1Refuse.code === 'BROKEN_DESTINATIONS',
        String(e1Refuse.reason ?? '').slice(0, 90));
    assert_('E1 allows a selection that keeps its targets', e1Allow.status === 'READY');

    const beads = await planExtract(bytesOf('page-refs-beyond-annots'), [0]);
    assert_('a page reference outside /Annots is detected during planning',
        beads.otherPageReferenceSites.length > 0,
        JSON.stringify(beads.otherPageReferenceSites));

    // ---- 7. RF-R2: the form subset -------------------------------------------
    console.log('\n=== 7. AcroForm subset (RF-R2) ===');
    evidence.forms = { supportedTypes: SUPPORTED_FIELD_TYPES };

    const formDoc = await PDFDocument.load(bytesOf('form-2p'), { updateMetadata: false });
    const formRead = readForm(formDoc);
    evidence.forms.form2p = {
        fields: formRead.fields.map((f) => ({ name: f.name, ft: f.ft, pages: f.widgetPages })),
        outsideSubset: formRead.outsideSubset,
    };
    measure('form-2p as the subset reader sees it',
        formRead.fields.map((f) => `${f.name}${f.ft} p${f.widgetPages.join('/')}`).join(' '));

    const bothPages = await extractWithForm(bytesOf('form-2p'), [0, 1]);
    const bothStruct = await structureOf(bothPages.bytes);
    evidence.forms.extractBothPages = {
        status: bothPages.status,
        rebuiltFields: bothPages.rebuiltFields,
        acroForm: bothStruct.form.present,
        orphanWidgets: bothStruct.form.orphanWidgets.length,
        fields: bothStruct.form.fields.map((f) => ({ name: f.name, value: f.value })),
    };
    assert_('a form wholly inside the selection is rebuilt, with no orphan widgets',
        bothPages.status === 'READY' && bothStruct.form.present === true
        && bothStruct.form.orphanWidgets.length === 0
        && bothStruct.form.fields.length === 2,
        `AcroForm ${bothStruct.form.present}, fields ${bothStruct.form.fields.length}, `
        + `orphans ${bothStruct.form.orphanWidgets.length}, `
        + `values ${JSON.stringify(bothStruct.form.fields.map((f) => f.value))}`);

    const straddle = await extractWithForm(bytesOf('form-field-across-pages'), [0]);
    evidence.forms.straddling = { status: straddle.status, code: straddle.code };
    probe('a field whose widgets straddle the selection is a typed refusal, not half a form',
        straddle.status === 'REFUSED' && straddle.code === 'FIELD_SPANS_SELECTION',
        String(straddle.reason ?? '').slice(0, 90));

    const collideRename = await mergeWithForms(
        [bytesOf('collide-a'), bytesOf('collide-b')], { onCollision: 'rename' },
    );
    const collideRefuse = await mergeWithForms(
        [bytesOf('collide-a'), bytesOf('collide-b')], { onCollision: 'refuse' },
    );
    const renameStruct = collideRename.status === 'READY' ? await structureOf(collideRename.bytes) : null;
    evidence.forms.mergeCollision = {
        renameStatus: collideRename.status,
        collisions: collideRename.collisions,
        renamed: collideRename.renamed,
        refuseStatus: collideRefuse.status,
        refuseCode: collideRefuse.code,
        afterRename: renameStruct ? {
            acroForm: renameStruct.form.present,
            fields: renameStruct.form.fields.map((f) => ({ name: f.name, value: f.value })),
            orphanWidgets: renameStruct.form.orphanWidgets.length,
        } : null,
    };
    assert_('renaming on collision yields one valid form, distinct names, no orphan widgets',
        collideRename.status === 'READY' && renameStruct?.form.present === true
        && renameStruct.form.orphanWidgets.length === 0
        && new Set(renameStruct.form.fields.map((f) => f.name)).size === renameStruct.form.fields.length,
        JSON.stringify(evidence.forms.mergeCollision.afterRename));
    probe('and refusing the same input is available',
        collideRefuse.status === 'REFUSED' && collideRefuse.code === 'DUPLICATE_FIELD_NAMES',
        String(collideRefuse.reason ?? '').slice(0, 90));
    humanOpen('M6-H3 AcroForm / widget preservation (revised)',
        'the prototype carries /Tx /Btn /Ch /Sig and refuses /AA, /CO and document JavaScript; '
        + 'rename-on-collision is offered only because those three are absent');

    // ---- 8. RF-R3: what a signature leaves behind ----------------------------
    console.log('\n=== 8. signature remnants (RF-R3) ===');
    const sigSrc = bytesOf('sig-applied');
    const sigBefore = await structureOf(sigSrc);
    const sigLegacy = await structureOf(await legacyExtract(sigSrc, [0]));
    evidence.signature = {
        before: signatureRemnants(sigBefore),
        afterLegacyExtract: signatureRemnants(sigLegacy),
        widgetsOnPage: sigLegacy.annots.filter((a) => a.subtype === '/Widget').length,
        orphanWidgetDetail: sigLegacy.form.orphanWidgets,
    };
    measure('sig-applied before', JSON.stringify(evidence.signature.before));
    measure('sig-applied after a legacy extract', JSON.stringify(evidence.signature.afterLegacyExtract));
    baselineFail('the signature appearance survives while the signature does not',
        sigLegacy.form.orphanWidgets.length > 0
        && sigLegacy.form.orphanWidgets.some((w) => w.hasAppearance === true),
        `${sigLegacy.form.orphanWidgets.length} widget(s) left, `
        + `${sigLegacy.form.orphanWidgets.filter((w) => w.hasAppearance).length} with an /AP that still draws`);
    humanOpen('M6-H1 applied signature policy — Extract (revised)',
        'A hard refuse / B allow an unsigned derivative but remove the signature widget and its '
        + 'appearance / C allow with a persistent artifact-level unsigned-derivative indication');

    // ---- 9. RF-R6: catalog structures, each with its own consequence ---------
    //
    // "All of these are dropped" is true and useless as a policy. What a
    // contract needs is a deterministic detector and a statement of what the
    // drop actually changes — and for two of them the drop is not clean: the
    // page keeps a reference to the structure that left.
    console.log('\n=== 9. catalog structures (RF-R6) ===');
    evidence.catalogStructures = {};

    const remnants = async (bytes) => {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        const page = doc.getPages()[0];
        const resources = page.node.lookup(PDFName.of('Resources'));
        const properties = resources && typeof resources.lookup === 'function'
            ? resources.lookup(PDFName.of('Properties'))
            : undefined;
        return {
            structTreeRoot: doc.catalog.get(PDFName.of('StructTreeRoot')) !== undefined,
            markInfo: doc.catalog.get(PDFName.of('MarkInfo')) !== undefined,
            pageStructParents: page.node.get(PDFName.of('StructParents')) !== undefined,
            ocProperties: doc.catalog.get(PDFName.of('OCProperties')) !== undefined,
            pageOptionalContentProperties: properties !== undefined,
            openAction: doc.catalog.get(PDFName.of('OpenAction')) !== undefined,
        };
    };

    for (const fixture of ['structtree', 'ocproperties', 'nav-4p']) {
        const src = bytesOf(fixture);
        const before = await remnants(src);
        const after = await remnants(await legacyExtract(src, [0]));
        evidence.catalogStructures[fixture] = { before, after };
        measure(`${fixture} remnants`, `before ${JSON.stringify(before)}`);
        measure(`${fixture} after extract`, `after ${JSON.stringify(after)}`);
    }

    probe('a tagged page keeps /StructParents after its structure tree is dropped',
        evidence.catalogStructures.structtree.after.pageStructParents === true
        && evidence.catalogStructures.structtree.after.structTreeRoot === false,
        'the artifact claims membership of a structure tree it does not contain');
    probe('an optional-content page keeps its /Properties after /OCProperties is dropped',
        evidence.catalogStructures.ocproperties.after.pageOptionalContentProperties === true
        && evidence.catalogStructures.ocproperties.after.ocProperties === false,
        'marked content still names an optional-content group the document no longer configures');
    baselineFail('/OpenAction is dropped rather than retargeted or refused',
        evidence.catalogStructures['nav-4p'].before.openAction === true
        && evidence.catalogStructures['nav-4p'].after.openAction === false);
    humanOpen('M6-H9 uncommon catalog structures (revised)',
        'each needs its own policy: a half-dropped structure tree and a dangling optional-content '
        + 'reference are not the same kind of loss as an attachment that simply goes');

    fs.writeFileSync(
        path.join(RESEARCH, 'evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
    );

    const counted = rows.filter((r) => r.ok !== null);
    const failed = counted.filter((r) => !r.ok);
    const byKind = (kind) => rows.filter((r) => r.kind === kind).length;
    console.log(`\n  ASSERT ${byKind('ASSERT')}  PROBE ${byKind('PROBE')}  MEASURE ${byKind('MEASURE')}  `
        + `BASELINE-FAIL ${byKind('BASELINE-FAIL')}  HUMAN-OPEN ${byKind('HUMAN-OPEN')}`);
    console.log(`  ${counted.length - failed.length}/${counted.length} verifiable rows passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - [${f.kind}] ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error(`\nresearch gate failed: ${error?.stack ?? error}\n`);
}
process.exit(exitCode);
