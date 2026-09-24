/**
 * The M6 Split / Merge gate.
 *
 * The old contract for this tool was "it produced bytes, so it worked". That is
 * exactly the contract the research found wanting: an extract that shipped the
 * content of pages nobody selected, a link that resolved and navigated nowhere,
 * a merge that dropped a file between the picker and the list and reported
 * success. So most of what this gate asserts is that the tool **refuses**, by
 * name, and before it has touched anything — and where it does produce bytes, it
 * asserts what is in them by reopening them.
 *
 * Everything is driven through the real modules in a real browser, over
 * synthetic fixtures the repository generates for itself. No network, no
 * customer document, no secret.
 *
 * Run:
 *   node scripts/make-m6-split-merge-fixtures.mjs
 *   node scripts/smoke-split-merge-reliability.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5179;
const ORIGIN = `http://localhost:${PORT}`;

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
/** A check fed input that must make it fire, so the passing ones can be believed. */
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const note = (name, detail) => console.log(`  ----  ${name}  ${detail}`);
const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * The versions M6's safety argument is bound to, re-resolved rather than read
 * off a constant in our own source. A lockfile change that moves either must
 * turn this red: the Load Boundary evidence holds for pako 2.1.0, and the whole
 * copy-path argument holds for pdf-lib 1.17.1.
 */
const require_ = createRequire(import.meta.url);
const versionOf = (spec, from) => {
    try {
        const paths = from
            ? [path.dirname(require_.resolve(`${from}/package.json`))]
            : [ROOT];
        const file = require_.resolve(`${spec}/package.json`, { paths });
        return require_(file).version;
    } catch {
        return null;
    }
};

const server = await createServer({
    root: ROOT,
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
});
await server.listen();
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(0);

const external = [];
const pageErrors = [];
const workerTargets = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* data:, blob: */ }
};
page.on('request', (r) => record(r.url()));
page.on('pageerror', (e) => pageErrors.push(e.message));
/**
 * A dedicated Worker is a property of the page, not of the browser's target
 * list: `targetcreated` with type `worker` reports service and shared workers.
 * Both are listened to, so the assertion that a Worker really ran is about the
 * thing that actually ran and the network capture still covers every kind.
 */
page.on('workercreated', (worker) => {
    workerTargets.push(worker.url());
    record(worker.url());
});
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    workerTargets.push(target.url());
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});

let exitCode = 1;
try {
    await page.goto(`${ORIGIN}/scripts/smoke-split-merge-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m6Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m6[f](...a), fn, args);

    const constants = await call('constants');

    // ---- 1. the pre-parse Load Boundary ------------------------------------
    //
    // H11-B3-1: PDFDocument.load() may be called only on input that PASSes.
    // Every refusal below is decided before a parse, and names its stage.
    console.log('\n=== 1. pre-parse Load Boundary ===');

    for (const name of ['hand-built-minimal', 'objstm-ok', 'nav-4p', 'merge-a']) {
        const v = await call('boundary', name);
        check(`${name} passes the boundary`, v.verdict === 'PASS',
            v.verdict === 'REFUSE' ? `${v.code} @${v.stage}: ${v.reason}` : `${v.stats.stagesCompleted.length} stages`);
    }

    const refusals = [
        ['no-header', 'NO_HEADER'],
        ['encrypted', 'ENCRYPTED'],
        ['unexpected-bytes', 'UNEXPECTED_BYTES'],
        ['indirect-type-on-stream', 'INDIRECT_TYPE_ON_STREAM'],
        ['ambiguous-name-escape', 'AMBIGUOUS_NAME_ESCAPE'],
        ['ambiguous-stream-length', 'AMBIGUOUS_STREAM_LENGTH'],
    ];
    for (const [name, code] of refusals) {
        const v = await call('boundary', name);
        check(`${name} is refused as ${code}`, v.verdict === 'REFUSE' && v.code === code,
            `${v.verdict} ${v.code ?? ''} @${v.stage}`);
    }

    // The decode caps, at the boundary and one byte either side of it.
    const bomb = await call('boundary', 'decode-bomb-small', { maxDecodedBytesPerStream: 1024 });
    check('a decode bomb is refused before it is materialised',
        bomb.verdict === 'REFUSE' && bomb.code === 'DECODED_BYTES_PER_STREAM',
        `${bomb.code} materialised ${fmt(bomb.stats.refusedDecode?.materialized ?? 0)} B of `
        + `${fmt(bomb.stats.refusedDecode?.inputBytes ?? 0)} B input`);
    check('the refused decode stopped at the cap plus at most one chunk',
        (bomb.stats.refusedDecode?.materialized ?? Infinity)
            <= 1024 + constants.policy.loadBoundary.inflateChunkBytes,
        `materialised ${fmt(bomb.stats.refusedDecode?.materialized ?? 0)} B, `
        + `cap 1,024 + chunk ${fmt(constants.policy.loadBoundary.inflateChunkBytes)}`);

    const okDecode = await call('boundary', 'objstm-ok');
    const exactCap = okDecode.stats.maxStreamDecodedBytes;
    const atCap = await call('boundary', 'objstm-ok', { maxDecodedBytesPerStream: exactCap });
    const underCap = await call('boundary', 'objstm-ok', { maxDecodedBytesPerStream: exactCap - 1 });
    check(`the exact decoded length (${fmt(exactCap)} B) passes at the cap`, atCap.verdict === 'PASS',
        `${atCap.code ?? ''}`);
    probe('one byte under the cap refuses',
        underCap.verdict === 'REFUSE' && underCap.code === 'DECODED_BYTES_PER_STREAM',
        `${underCap.verdict} ${underCap.code ?? ''}`);

    const cumulative = await call('boundary', 'objstm-ok', { maxDecodedBytesTotal: 1 });
    check('the cumulative decode cap refuses as DECODED_BYTES_TOTAL',
        cumulative.verdict === 'REFUSE' && cumulative.code === 'DECODED_BYTES_TOTAL',
        `${cumulative.code}`);

    const xrefBomb = await call('boundary', 'xref-entry-bomb');
    check('a declared xref-entry bomb is refused',
        xrefBomb.verdict === 'REFUSE' && xrefBomb.code === 'XREF_ENTRY_CAP', `${xrefBomb.code}`);
    const objstmBomb = await call('boundary', 'objstm-object-bomb');
    check('an object-stream object bomb is refused',
        objstmBomb.verdict === 'REFUSE' && objstmBomb.code === 'OBJECT_STREAM_OBJECT_CAP',
        `${objstmBomb.code}`);
    const tooBig = await call('boundary', 'nav-4p', { maxInputBytes: 16 });
    check('the raw input ceiling refuses before anything is read',
        tooBig.verdict === 'REFUSE' && tooBig.code === 'INPUT_TOO_LARGE'
            && tooBig.stats.stagesCompleted.length === 0,
        `${tooBig.code}, stages ${tooBig.stats.stagesCompleted.length}`);

    // A limit that cannot refuse is not a limit.
    for (const patch of [
        { loadBoundary: { ...constants.policy.loadBoundary, maxNestingDepth: Infinity } },
        { loadBoundary: { ...constants.policy.loadBoundary, maxInputBytes: -1 } },
        { structural: { ...constants.policy.structural, maxCopiedObjects: 0 } },
    ]) {
        const key = Object.keys(patch)[0];
        const r = await call('policyRejects', patch);
        check(`an unenforceable ${key} limit is rejected`, r.rejected === true, r.message ?? '');
    }

    // ---- 2. the invariant this milestone exists for -------------------------
    console.log('\n=== 2. orphanPageCount === 0 ===');

    const baseline = await call('baseline', 'nav-4p', [0]);
    check('BASELINE reproduces the defect: today\'s copy leaves an orphan page',
        baseline.orphanPageCount > 0,
        `orphan ${baseline.orphanPageCount}, dangling ${baseline.danglingDestinations}`);

    for (const [name, selection] of [
        ['nav-4p', [0]],
        ['nav-4p', [0, 2]],
        ['nav-4p', [0, 1, 2, 3]],
        ['nav-goto', [0]],
        ['bead-beyond-annots', [0]],
        ['named-destination', [0]],
        ['named-destination', [0, 1]],
    ]) {
        const r = await call('extract', name, selection);
        const ok = r.status === 'READY'
            && r.readback.orphanPageCount === 0
            && r.readback.danglingDestinations === 0
            && r.readback.pageCount === selection.length;
        check(`${name} [${selection.join(',')}] holds the invariant`, ok,
            r.status === 'READY'
                ? `pages ${r.readback.pageCount}, orphan ${r.readback.orphanPageCount}, dangling ${r.readback.danglingDestinations}`
                : `${r.status}: ${r.reason}`);
    }

    const e1 = await call('extract', 'nav-4p', [0], { destinationPolicy: 'E1' });
    check('E1 refuses a selection that would break navigation',
        e1.status === 'BROKEN_DESTINATIONS', `${e1.status}`);
    const e1ok = await call('extract', 'nav-4p', [0, 1, 2, 3], { destinationPolicy: 'E1' });
    check('E1 allows a selection that keeps its targets', e1ok.status === 'READY', `${e1ok.status}`);

    const empty = await call('extract', 'nav-4p', []);
    check('an empty selection is refused in planning, never after save()',
        empty.status === 'EMPTY_SELECTION', `${empty.status}`);

    // ---- 3. A5 — the planned graph is the copied graph ----------------------
    //
    // Promoted to an implementation acceptance criterion. A structural cap is
    // only a safety argument if the graph that was counted is the graph that was
    // copied.
    console.log('\n=== 3. A5: plan == actual copy, after E2 ===');

    for (const [name, selection] of [
        ['nav-4p', [0]],
        ['nav-4p', [0, 2]],
        ['nav-4p', [0, 1, 2, 3]],
        ['merge-a', [0, 1, 2]],
        ['named-destination', [0]],
        ['bead-beyond-annots', [0]],
    ]) {
        const r = await call('planVersusCopy', name, selection);
        const objectsEqual = r.predicted.destinationObjects === r.registeredObjects;
        const bytesEqual = r.predicted.streamBytes === r.registeredStreamBytes;
        check(`${name} [${selection.join(',')}] plan equals the real copy`,
            objectsEqual && bytesEqual && r.comparison.agrees,
            `objects ${r.predicted.destinationObjects} vs ${r.registeredObjects}, `
            + `streamBytes ${fmt(r.predicted.streamBytes)} vs ${fmt(r.registeredStreamBytes)}`);
    }

    const a5 = await call('extract', 'nav-4p', [0, 2]);
    check('the run reports both counts and they agree',
        a5.planned && a5.actual
            && a5.planned.destinationObjects === a5.actual.destinationObjects,
        `planned ${a5.planned?.destinationObjects}, actual ${a5.actual?.destinationObjects}`);

    // ---- 4. structural caps, checked before the copy ------------------------
    console.log('\n=== 4. structural caps, before copyPages ===');

    const capped = await call('extract', 'merge-a', [0, 1, 2], {
        policyOverrides: { structural: { maxCopiedObjects: 2 } },
    });
    check('an over-cap Extract is refused, and nothing is produced',
        capped.status === 'OVER_STRUCTURAL_CAP' && capped.outputBytes === null,
        `${capped.status}: ${capped.reason}`);
    check('the refusal names the term and the cap',
        capped.detail?.term === 'destinationObjects' && capped.detail?.cap === 2,
        JSON.stringify(capped.detail));

    const ceiling = await call('extract', 'merge-a', [0], {
        policyOverrides: { output: { maxOutputBytes: 32 } },
    });
    check('the actual-output ceiling refuses the artifact',
        ceiling.status === 'OVER_OUTPUT_BUDGET' && ceiling.outputBytes === null, `${ceiling.status}`);

    // ---- 5. signatures, XFA, forms ------------------------------------------
    console.log('\n=== 5. signatures, XFA and the /Tx subset ===');

    const signedFacts = await call('facts', 'signature-applied');
    check('an applied signature is seen as applied',
        signedFacts.hasSignatureField && signedFacts.hasAppliedSignature,
        signedFacts.signatureFieldNames.join(','));
    const emptySigFacts = await call('facts', 'signature-field-empty');
    check('an EMPTY signature field is a form control, not a signature',
        emptySigFacts.hasSignatureField && !emptySigFacts.hasAppliedSignature, '');

    const signedExtract = await call('extract', 'signature-applied', [0], {
        confirmedLosses: ['tagging', 'attachments'],
    });
    check('Extract of a signed source produces an unsigned derivative with no orphan widget',
        signedExtract.status === 'READY' && signedExtract.readback.orphanWidgets === 0,
        `${signedExtract.status}, orphan widgets ${signedExtract.readback?.orphanWidgets}`);

    const signedIntake = await call('intake', ['signature-applied']);
    check('Merge refuses a signed source (the asymmetry is deliberate)',
        signedIntake[0].result === 'SIGNATURE_UNSAFE', signedIntake[0].result);
    const emptySigIntake = await call('intake', ['signature-field-empty']);
    check('Merge accepts an empty signature field',
        emptySigIntake[0].result === 'ACCEPTED', emptySigIntake[0].result);

    const xfaExtract = await call('extract', 'xfa', [0]);
    check('XFA is refused', xfaExtract.status === 'XFA_UNSAFE', `${xfaExtract.status}`);

    const txForm = await call('form', 'form-tx-plain', [0]);
    check('a simple merged /Tx is inside the subset',
        txForm.plan === 'CARRY' && txForm.outsideSubset.length === 0,
        txForm.outsideSubset.join(', '));
    const txExtract = await call('extract', 'form-tx-plain', [0]);
    check('a /Tx field survives the extract with no orphan widget',
        txExtract.status === 'READY' && txExtract.readback.orphanWidgets === 0,
        `${txExtract.status}`);

    for (const [name, code] of [['form-tx-ff', 'UNSUPPORTED_FORM'], ['form-choice', 'UNSUPPORTED_FORM']]) {
        const r = await call('extract', name, [0]);
        check(`${name} is refused as ${code}`, r.status === code, `${r.status}`);
    }
    const straddle = await call('extract', 'form-field-across-pages', [0]);
    check('a field straddling the selection reports the sharper reason',
        straddle.status === 'FIELD_SPANS_SELECTION', `${straddle.status}`);

    // ---- 6. optional content, including B1's soft-mask path -----------------
    console.log('\n=== 6. optional content ===');

    const ocgOk = await call('extract', 'ocg-supported', [0]);
    check('a supported direct-/OCG envelope is carried', ocgOk.status === 'READY', `${ocgOk.status}`);
    const ocmdRefused = await call('extract', 'ocmd', [0]);
    check('an /OCMD is refused',
        ocmdRefused.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${ocmdRefused.status}`);

    const smaskGroup = await call('optionalContent', 'ocg-extgstate-smask', [0]);
    check('B1: a group behind /ExtGState /SMask /G is found and refused',
        smaskGroup.plan === 'REFUSE'
            && smaskGroup.unsupported.some((u) => u.includes('SMask') && u.includes('/G')),
        smaskGroup.unsupported.join(' | '));
    const smaskExtract = await call('extract', 'ocg-extgstate-smask', [0]);
    check('B1: and the extract refuses rather than shipping READY',
        smaskExtract.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${smaskExtract.status}`);

    for (const name of ['smask-clean', 'smask-none']) {
        const r = await call('extract', name, [0]);
        check(`${name} stays READY — a soft mask is not itself a reason to refuse`,
            r.status === 'READY', `${r.status}`);
    }

    // ---- 7. JavaScript: two counts at zero ----------------------------------
    console.log('\n=== 7. JavaScript ===');

    for (const name of ['js-annot-a', 'js-next-chain']) {
        const before = await call('javascript', name);
        const after = await call('extract', name, [0]);
        check(`${name} carries JavaScript before, and none after`,
            before.reachable > 0
                && after.status === 'READY'
                && after.readback.reachableJavaScript === 0
                && after.readback.artifactWideJavaScript === 0,
            `before reachable ${before.reachable}/table ${before.artifactWide}; `
            + `after reachable ${after.readback?.reachableJavaScript}/table ${after.readback?.artifactWideJavaScript}`);
    }
    probe('a /Next chain is walked, not stopped at the array',
        (await call('javascript', 'js-next-chain')).reachable > 0,
        `${(await call('javascript', 'js-next-chain')).reachable} found`);

    // ---- 8. tagging and attachments -----------------------------------------
    console.log('\n=== 8. tagging and attachments ===');

    const taggedPlan = await call('plan', 'tagged', [0]);
    check('a tagged source asks for confirmation before it is stripped',
        taggedPlan.status === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION'
            && taggedPlan.requiresConfirmation.includes('tagging'),
        `${taggedPlan.status} ${taggedPlan.requiresConfirmation.join(',')}`);
    const taggedArtifact = await call('artifactStructure', 'tagged', [0]);
    check('every tagging remnant is gone, /StructParents included',
        taggedArtifact.structTreeRoot === false && taggedArtifact.structParents === 0,
        JSON.stringify({ root: taggedArtifact.structTreeRoot, parents: taggedArtifact.structParents }));

    const attachPlan = await call('plan', 'with-attachment', [0]);
    check('an attachment is named and confirmed before removal',
        attachPlan.requiresConfirmation.includes('attachments')
            && attachPlan.losses.some((l) => l.kind === 'attachments' && (l.what ?? '').includes('note.txt')),
        JSON.stringify(attachPlan.losses.map((l) => `${l.kind}:${l.what ?? ''}`)));
    const attachArtifact = await call('artifactStructure', 'with-attachment', [0]);
    check('no /Filespec survives in the artifact', attachArtifact.filespecs === 0,
        `${attachArtifact.filespecs}`);

    // ---- 9. Merge: intake, order, lifetime, caps ----------------------------
    console.log('\n=== 9. Merge ===');

    const intake = await call('intake',
        ['merge-a', 'merge-b', 'xfa', 'signature-applied', 'no-header'],
        { 'no-header': 'application/pdf' });
    const byName = Object.fromEntries(intake.map((r) => [r.name, r.result]));
    check('every input carries a typed result, including the ones that fail',
        intake.length === 5 && Object.values(byName).every(Boolean), JSON.stringify(byName));
    check('an input that is not a PDF is reported, not silently dropped',
        (await call('intake', ['merge-a'], { 'merge-a': 'text/plain' }))[0].result === 'UNSUPPORTED', '');

    const merged = await call('merge', ['merge-a', 'merge-b']);
    check('a merge produces every page of every accepted source',
        merged.status === 'READY' && merged.readback.pageCount === 5,
        `${merged.status}, ${merged.readback?.pageCount} pages`);
    check('the merged artifact holds the invariants',
        merged.readback?.orphanPageCount === 0
            && merged.readback?.danglingDestinations === 0
            && merged.readback?.artifactWideJavaScript === 0,
        JSON.stringify(merged.readback));

    const ab = await call('merge', ['merge-a', 'merge-b']);
    const ba = await call('merge', ['merge-b', 'merge-a']);
    check('file-list order decides page order, and the name follows the first source',
        ab.outputName === 'merged_2files_merge-a.pdf' && ba.outputName === 'merged_2files_merge-b.pdf',
        `${ab.outputName} / ${ba.outputName}`);

    const partial = await call('merge', ['merge-a', 'xfa', 'merge-b']);
    check('an explicit partial merge names the omitted source',
        partial.status === 'READY'
            && partial.intake.some((r) => r.name === 'xfa.pdf' && r.result === 'XFA_UNSAFE')
            && partial.readback.pageCount === 5,
        `${partial.readback?.pageCount} pages, `
        + partial.intake.map((r) => `${r.name}=${r.result}`).join(' '));

    const mergeCap = await call('merge', ['merge-a', 'merge-b'], {
        policyOverrides: { structural: { maxCumulativeCopiedObjects: 4 } },
    });
    check('a cumulative structural cap refuses before the copy that would exceed it',
        mergeCap.status === 'OVER_STRUCTURAL_CAP' && mergeCap.outputBytes === null,
        `${mergeCap.status}: ${mergeCap.reason}`);

    const collide = await call('merge', ['merge-collide-1', 'merge-collide-2']);
    check('a duplicate field name is renamed per source, and the rename is reported',
        collide.status === 'READY' && collide.renamedFields.length > 0,
        JSON.stringify(collide.renamedFields));
    const collideRefuse = await call('merge', ['merge-collide-1', 'merge-collide-2'],
        { collisionPolicy: 'refuse' });
    check('the refuse policy is available and names the colliding field',
        collideRefuse.status === 'DUPLICATE_FIELD_NAMES', `${collideRefuse.status}`);

    // ---- 10. names -----------------------------------------------------------
    console.log('\n=== 10. deterministic, self-describing names ===');

    const names = await call('names', 'drawing.pdf', [0, 2, 4, 5, 6, 7], ['first.pdf', 'second.pdf']);
    check('an Extract name lists the pages it contains',
        names.extract === 'drawing_p1,3,5-8.pdf', names.extract);
    check('a Merge name says how many files and which was first',
        names.merge === 'merged_2files_first.pdf', names.merge);
    probe('the same selection twice produces the same name',
        (await call('names', 'drawing.pdf', [0, 2, 4, 5, 6, 7], ['first.pdf'])).extract === names.extract, '');

    // ---- 11. the disposable Worker ------------------------------------------
    console.log('\n=== 11. the disposable Worker ===');

    check('the environment reports a Worker', constants.workerAvailable === true, '');
    const viaWorker = await call('extractViaWorker', 'nav-4p', [0]);
    check('an Extract driven through the Worker holds the same invariants',
        viaWorker.status === 'READY'
            && viaWorker.readback.orphanPageCount === 0
            && viaWorker.readback.danglingDestinations === 0,
        `${viaWorker.status}, ${viaWorker.outputBytes} B`);
    const mergeWorker = await call('mergeViaWorker', ['merge-a', 'merge-b']);
    check('a Merge driven through the Worker holds the same invariants',
        mergeWorker.status === 'READY' && mergeWorker.readback.orphanPageCount === 0,
        `${mergeWorker.status}, ${mergeWorker.outputBytes} B`);
    check('a Worker was actually created for the run',
        workerTargets.length > 0, `${workerTargets.length} worker target(s)`);

    const cancelled = await call('extractCancelled', 'merge-a', [0, 1, 2]);
    check('a cancelled run publishes nothing, and says so rather than hanging',
        cancelled.published === false && cancelled.status === 'CANCELLED',
        `${cancelled.status}, published ${cancelled.published}`);

    // ---- 12. the version contract -------------------------------------------
    console.log('\n=== 12. the versions this safety argument is bound to ===');

    const pdfLib = versionOf('pdf-lib');
    const pako = versionOf('pako');
    const pakoUnderPdfLib = versionOf('pako', 'pdf-lib');
    check('pdf-lib is 1.17.1, the version the copy-path argument is bound to',
        pdfLib === '1.17.1', String(pdfLib));
    check('pako is 2.1.0, the version the bounded inflate evidence is bound to',
        pako === '2.1.0', String(pako));
    note('pako as pdf-lib resolves it', `${pakoUnderPdfLib} — unchanged by M6's direct dependency`);
    check('the shipped policy is still marked provisional, pending B4',
        constants.policy.provisional === true && constants.policy.origin === 'PROVISIONAL_PRE_B4',
        `${constants.policy.origin}`);

    // ---- 13. BLK-1: artifact-wide JavaScript, measured independently --------
    //
    // Every check below reads the artifact with the gate's own walker and looks
    // for the marker in the serialized bytes. The production scanner reported
    // zero for all three of these while the script was in the file, so asking it
    // again would prove nothing.
    console.log('\n=== 13. BLK-1 artifact-wide JavaScript ===');

    for (const [fixture, marker, selection] of [
        ['rem-js-detached-next', 'M6JS_DETACHED_NEXT', [0, 1]],
        ['rem-js-fileattachment-aa', 'M6JS_FILEATTACH_AA', [0]],
        ['rem-js-detached-parent-field', 'M6JS_DETACHED_FIELD', [0]],
    ]) {
        const r = await call('extractAndInspect', fixture, selection, marker);
        check(`${fixture}: no JavaScript survives, by independent inspection`,
            r.status === 'READY'
            && r.independent?.javascript === 0
            && r.markerInBytes === false,
            `${r.status}, independent js ${r.independent?.javascript}, marker in bytes ${r.markerInBytes}`);
        check(`${fixture}: the production readback agrees with the independent one`,
            r.production?.artifactWideJavaScript === r.independent?.javascript,
            `production ${r.production?.artifactWideJavaScript} vs independent ${r.independent?.javascript}`);
    }

    // ---- 14. BLK-2: the attachment payload is gone --------------------------
    console.log('\n=== 14. BLK-2 attachment payload ===');

    const att = await call('extractAndInspect', 'rem-js-fileattachment-aa', [0],
        'M6ATTACHMENT_PAYLOAD_MARKER');
    check('the embedded payload is absent from the serialized bytes',
        att.markerInBytes === false, `marker in bytes ${att.markerInBytes}`);
    check('no FileAttachment annotation, Filespec /EF or EmbeddedFile survives',
        att.independent?.fileAttachmentAnnots === 0
        && att.independent?.filespecsWithEF === 0
        && att.independent?.embeddedFileStreams === 0,
        JSON.stringify({
            annots: att.independent?.fileAttachmentAnnots,
            filespecs: att.independent?.filespecsWithEF,
            streams: att.independent?.embeddedFileStreams,
        }));
    check('the attachment is named in the losses, so a confirmation can show it',
        (att.losses ?? []).some((l) => l.kind === 'attachments' && (l.what ?? '').includes('secret-notes.txt')),
        JSON.stringify((att.losses ?? []).map((l) => `${l.kind}:${l.what ?? ''}`)));

    const attMerge = await call('mergeAndInspect', ['rem-js-fileattachment-aa', 'merge-b'],
        'M6ATTACHMENT_PAYLOAD_MARKER');
    check('a Merge carries no attachment payload either',
        attMerge.status === 'READY'
        && attMerge.markerInBytes === false
        && attMerge.independent?.embeddedFileStreams === 0,
        `${attMerge.status}, marker ${attMerge.markerInBytes}`);

    // ---- 15. M6-H5A: source-page references on every route ----------------
    console.log('\n=== 15. M6-H5A source-page reference closure ===');

    for (const fixture of [
        'rem-pageref-annot-p',
        'rem-pageref-annot-aa',
        'rem-pageref-page-aa',
        'rem-pageref-recursive-next',
    ]) {
        const r = await call('extractAndInspect', fixture, [0], null);
        check(`${fixture}: no source-page reference survives`,
            r.status === 'READY'
            && r.independent?.strayPageRefs === 0
            && r.independent?.orphanPages === 0,
            `${r.status}, stray ${r.independent?.strayPageRefs}, orphan ${r.independent?.orphanPages}`);
    }

    // A widget `/AA` is outside the adopted `/Tx` envelope (M6-H3 lists `/AA`
    // among the entries the reconstruction does not restore), so the contract's
    // answer is a typed refusal rather than a carried document. Asserting READY
    // here would have been asserting that the envelope leaks.
    const widgetAa = await call('extractAndInspect', 'rem-pageref-widget-aa', [0], null);
    check('rem-pageref-widget-aa: refused as UNSUPPORTED_FORM, so nothing is carried',
        widgetAa.status === 'UNSUPPORTED_FORM' && widgetAa.independent === null,
        `${widgetAa.status}`);
    const keptBoth = await call('extractAndInspect', 'rem-pageref-annot-p', [0, 1], null);
    check('rem-pageref-annot-p with both pages kept still holds the invariant',
        keptBoth.status === 'READY' && keptBoth.independent?.strayPageRefs === 0,
        `${keptBoth.status}, stray ${keptBoth.independent?.strayPageRefs}`);

    const mergeRefs = await call('mergeAndInspect', ['rem-pageref-annot-p', 'merge-b'], null);
    check('a Merge rebuilds page references against the merged output',
        mergeRefs.status === 'READY' && mergeRefs.independent?.strayPageRefs === 0,
        `${mergeRefs.status}, stray ${mergeRefs.independent?.strayPageRefs}`);

    // ---- 16. M6-H9b-A: inherited resources ----------------------------------
    console.log('\n=== 16. M6-H9b-A inherited resources ===');

    const inhProps = await call('optionalContent', 'rem-inherited-properties', [0]);
    check('optional content in an INHERITED /Properties is found',
        inhProps.present === true && inhProps.groups.includes('M6-INHERITED-LAYER'),
        JSON.stringify({ present: inhProps.present, groups: inhProps.groups }));
    const inhPropsExtract = await call('extract', 'rem-inherited-properties', [0]);
    check('and the extract carries it rather than reporting none',
        inhPropsExtract.status === 'READY', `${inhPropsExtract.status}`);

    for (const [fixture, why] of [
        ['rem-inherited-xobject-oc', 'an inherited /XObject carrying /OC'],
        ['rem-inherited-smask-g', 'an inherited /ExtGState /SMask /G naming a group'],
    ]) {
        const found = await call('optionalContent', fixture, [0]);
        const extracted = await call('extract', fixture, [0]);
        check(`${why} is found and refused, not blind READY`,
            found.unsupported.length > 0
            && extracted.status === 'UNSUPPORTED_OPTIONAL_CONTENT',
            `${extracted.status}: ${found.unsupported.join(' | ')}`);
    }

    // ---- 17. RF-6: inherited field type and signature ------------------------
    console.log('\n=== 17. RF-6 inherited /FT and /V ===');

    const inhSig = await call('signatureFacts', 'rem-inherited-sig-field');
    check('an inherited /FT /Sig is seen as a signature field',
        inhSig.hasSignatureField === true && inhSig.hasAppliedSignature === false,
        JSON.stringify(inhSig));
    const inhApplied = await call('signatureFacts', 'rem-inherited-sig-applied');
    check('an inherited applied signature is seen as applied',
        inhApplied.hasSignatureField === true && inhApplied.hasAppliedSignature === true,
        JSON.stringify(inhApplied));

    const inhAppliedIntake = await call('intake', ['rem-inherited-sig-applied']);
    check('Merge refuses an inherited applied signature as SIGNATURE_UNSAFE',
        inhAppliedIntake[0].result === 'SIGNATURE_UNSAFE',
        `${inhAppliedIntake[0].result}`);
    const inhAppliedExtract = await call('extractAndInspect', 'rem-inherited-sig-applied', [0], null);
    check('Extract removes it and leaves no orphan widget',
        inhAppliedExtract.status === 'READY'
        && inhAppliedExtract.production?.orphanWidgets === 0,
        `${inhAppliedExtract.status}, orphan widgets ${inhAppliedExtract.production?.orphanWidgets}`);

    // RF-F: an unsigned field is not an applied signature. Asserting the
    // wrong label here would have encoded the wrong terminology into the gate.
    const emptySigMerge = await call('mergeAndInspect', ['rem-inherited-sig-field', 'merge-b'], null);
    check('an empty signature field is removed, and named as an EMPTY one',
        emptySigMerge.status === 'READY'
        && (emptySigMerge.losses ?? []).some((l) => l.kind === 'empty-signature-field')
        && !(emptySigMerge.losses ?? []).some((l) => l.kind === 'applied-signature'),
        `${emptySigMerge.status}, losses `
        + JSON.stringify((emptySigMerge.losses ?? []).map((l) => l.kind)));

    const emptySigExtract = await call('extractAndInspect', 'rem-inherited-sig-field', [0], null);
    check('Extract discloses the empty signature removal too',
        emptySigExtract.status === 'READY'
        && (emptySigExtract.losses ?? []).some((l) => l.kind === 'empty-signature-field'),
        `${emptySigExtract.status}, losses `
        + JSON.stringify((emptySigExtract.losses ?? []).map((l) => l.kind)));

    // ---- 18. RF-8: metadata ---------------------------------------------------
    console.log('\n=== 18. RF-8 metadata ===');

    const meta = await call('extractMetadata', 'rem-metadata-rich', [0]);
    check('the standard Info keys survive',
        meta.info?.Title === 'M6_TITLE_MARKER' && meta.info?.Author === 'M6_AUTHOR_MARKER',
        JSON.stringify(meta.info));
    check('custom Info keys survive too',
        meta.info?.Company === 'M6_COMPANY_MARKER' && meta.info?.M6Custom === 'M6_CUSTOM_MARKER',
        JSON.stringify({ Company: meta.info?.Company, M6Custom: meta.info?.M6Custom }));
    check('the XMP packet is carried, and is in the bytes',
        meta.hasXmp === true && meta.xmpMarkerInBytes === true,
        `xmp ${meta.hasXmp}, marker ${meta.xmpMarkerInBytes}`);

    // ---- 19. tagging remnants below the catalog -------------------------------
    console.log('\n=== 19. tagging remnants ===');

    const tags = await call('extractAndInspect', 'rem-tagging-remnants', [0], null);
    check('every defined tagging remnant is zero, annotations and XObjects included',
        tags.status === 'READY' && tags.independent?.taggingRemnants === 0,
        JSON.stringify({
            status: tags.status,
            root: tags.independent?.structTreeRoot,
            markInfo: tags.independent?.markInfo,
            structParents: tags.independent?.structParents,
            structParent: tags.independent?.structParent,
        }));

    // ---- 20. RF-1: Encrypt, spelled every way ---------------------------------
    console.log('\n=== 20. RF-1 escaped /Encrypt ===');

    for (const fixture of [
        'rem-encrypt-plain',
        'rem-encrypt-partly-escaped',
        'rem-encrypt-fully-escaped',
        'rem-encrypt-lowercase-escaped',
    ]) {
        const v = await call('boundary', fixture);
        check(`${fixture} is refused as ENCRYPTED`,
            v.verdict === 'REFUSE' && v.code === 'ENCRYPTED',
            `${v.verdict} ${v.code ?? ''} @${v.stage}`);
    }

    // ---- 21. RF-3 and RF-4: Merge revalidation and optional content -----------
    console.log('\n=== 21. RF-3 / RF-4 Merge envelope ===');

    // M6-H10 adopted explicit partial intake: a source outside an adopted
    // envelope is excluded and named, and the merge still produces what it can.
    // The whole batch failing would be a different contract, and a source
    // vanishing from the list would be the defect this milestone exists for.
    for (const [fixture, expected] of [
        ['form-choice', 'UNSUPPORTED_FORM'],
        ['form-tx-ff', 'UNSUPPORTED_FORM'],
        ['ocmd', 'UNSUPPORTED_OPTIONAL_CONTENT'],
        ['ocg-extgstate-smask', 'UNSUPPORTED_OPTIONAL_CONTENT'],
    ]) {
        const r = await call('mergeAndInspect', ['merge-a', fixture], null);
        const row = (r.intake ?? []).find((x) => x.name === `${fixture}.pdf`);
        check(`a Merge source with ${fixture} is excluded as ${expected}, and named`,
            r.status === 'READY' && row?.result === expected,
            `${r.status}, ${fixture} = ${row?.result}`);
    }

    // And the backstop: `runMerge` revalidates from the bytes, so intake facts
    // that are stale or untrue cannot carry an unsupported source through.
    const bypassed = await call('mergeWithFalseIntake', ['merge-a', 'form-choice']);
    check('false SAFE intake facts do not bypass the worker revalidation',
        bypassed.status === 'UNSUPPORTED_FORM' && bypassed.bytes === null,
        `${bypassed.status}: ${(bypassed.reason ?? '').slice(0, 60)}`);

    const ocgMerge = await call('mergeAndInspect', ['rem-merge-ocg-a', 'rem-merge-ocg-b'], null);
    check('a Merge of two supported OCG sources carries coherent optional content',
        ocgMerge.status === 'READY'
        && ocgMerge.optionalContent?.present === true
        && ocgMerge.optionalContent?.unsupported.length === 0
        && ocgMerge.optionalContent?.groups.includes('M6-MERGE-LAYER-A')
        && ocgMerge.optionalContent?.groups.includes('M6-MERGE-LAYER-B'),
        `${ocgMerge.status}, groups `
        + JSON.stringify(ocgMerge.optionalContent?.groups));

    // ---- 22. BLK-4: no silent merge omission ----------------------------------
    console.log('\n=== 22. BLK-4 no silent omission ===');

    const undecided = await call('mergeUndecided', ['merge-a', 'merge-b']);
    check('an undecided requested source fails the plan closed',
        undecided.planStatus !== 'READY' && undecided.bytes === null,
        `${undecided.planStatus}: ${(undecided.reason ?? '').slice(0, 70)}`);
    check('and the refusal names the file it could not decide',
        (undecided.reason ?? '').includes('merge-b.pdf'), undecided.reason ?? '');

    // ---- 23. BLK-1R: JavaScript that never says it is JavaScript ------------
    //
    // A Rendition action carries its script in `/JS` and its `/S` says
    // `/Rendition`. The reachable scanner asked about `/S` and answered zero.
    // The chain variants put the same carrier behind a run of indirect objects,
    // so a scan whose reach depends on traversal depth fails at some length.
    console.log('\n=== 23. BLK-1R subtype-independent JavaScript ===');

    for (const [fixture, marker] of [
        ['r3-rendition-js', 'M6R3_RENDITION_SHALLOW'],
        ['r3-rendition-js-chain-126', 'M6R3_RENDITION_126'],
        ['r3-rendition-js-chain-127', 'M6R3_RENDITION_127'],
        ['r3-rendition-js-chain-128', 'M6R3_RENDITION_128'],
        ['r3-rendition-js-chain-129', 'M6R3_RENDITION_129'],
        ['r3-rendition-js-chain-130', 'M6R3_RENDITION_130'],
    ]) {
        const r = await call('extractAndInspect', fixture, [0], marker);
        check(`${fixture}: no script survives, by independent walk and by bytes`,
            r.status === 'READY'
            && r.independent?.javascript === 0
            && r.markerInBytes === false,
            `${r.status}, independent js ${r.independent?.javascript}, `
            + `marker ${r.markerInBytes}`);
    }
    const renditionMerge = await call('mergeAndInspect',
        ['r3-rendition-js', 'merge-b'], 'M6R3_RENDITION_SHALLOW');
    check('a Merge carries no Rendition script either',
        renditionMerge.status === 'READY'
        && renditionMerge.independent?.javascript === 0
        && renditionMerge.markerInBytes === false,
        `${renditionMerge.status}, js ${renditionMerge.independent?.javascript}, `
        + `marker ${renditionMerge.markerInBytes}`);

    // ---- 24. BLK-2R: an attachment that never says it is one ----------------
    //
    // `/EF` is what makes a payload an embedded file. `/Type /Filespec` is how
    // a well-behaved producer labels it, and is not a precondition.
    console.log('\n=== 24. BLK-2R semantic attachment detection ===');

    for (const [fixture, marker] of [
        ['r3-typeless-ef', 'M6R3_TYPELESS_SHALLOW'],
        ['r3-typeless-ef-deep', 'M6R3_TYPELESS_DEEP'],
        ['r3-explicit-filespec', 'M6R3_EXPLICIT_PAYLOAD'],
    ]) {
        const r = await call('extractAndInspect', fixture, [0], marker);
        check(`${fixture}: no /EF carrier and no payload left in the bytes`,
            r.status === 'READY'
            && r.independent?.efCarriers === 0
            && r.independent?.embeddedFileStreams === 0
            && r.markerInBytes === false,
            `${r.status}, carriers ${r.independent?.efCarriers}, `
            + `streams ${r.independent?.embeddedFileStreams}, marker ${r.markerInBytes}`);
        check(`${fixture}: and the removal is disclosed`,
            (r.losses ?? []).some((l) => l.kind === 'attachments'),
            JSON.stringify((r.losses ?? []).map((l) => l.kind)));
    }
    const efMerge = await call('mergeAndInspect',
        ['r3-typeless-ef', 'merge-b'], 'M6R3_TYPELESS_SHALLOW');
    check('a Merge carries no undeclared payload either',
        efMerge.status === 'READY'
        && efMerge.independent?.efCarriers === 0
        && efMerge.markerInBytes === false,
        `${efMerge.status}, carriers ${efMerge.independent?.efCarriers}, `
        + `marker ${efMerge.markerInBytes}`);

    // ---- 25. a census ends COMPLETE or REFUSED ------------------------------
    //
    // The adopted clarification, tested as behaviour rather than as a comment:
    // there is no state in which a scan gives up and the count reads zero.
    console.log('\n=== 25. complete-or-refuse census ===');

    const shallow = await call('censusDeepDirect', 8);
    check('a census within budget completes and finds the script',
        shallow.censusComplete === true
        && shallow.countComplete === true
        && shallow.count === 1,
        `complete ${shallow.censusComplete}, count ${shallow.count}`);
    /**
     * Round 10 changed what happens next, and the change is the point. This
     * fixture hangs its action off the catalog's `/M6Deep` — a key no action
     * position uses — so finding the script is no longer authority to take the
     * object apart. The census still completes and still counts it; the scrub
     * declines, and says which of the two reasons it is.
     */
    check('and a complete census is still not authority to scrub what it found',
        shallow.scrubComplete === false && shallow.scrubUnsafe === true,
        `scrubComplete ${shallow.scrubComplete}, unsafe ${shallow.scrubUnsafe}, `
        + `reason ${String(shallow.scrubReason).slice(0, 80)}`);

    const starved = await call('censusDeepDirect', shallow.maxDirectDepth + 64);
    check('a census past its budget refuses instead of reporting zero',
        starved.censusComplete === false
        && starved.countComplete === false
        && starved.count === null,
        `complete ${starved.censusComplete}, count ${starved.count}`);
    check('and the refusal reaches the scrubber, which does not claim success',
        starved.scrubComplete === false && starved.scrubbed === null,
        `scrubComplete ${starved.scrubComplete}, scrubbed ${starved.scrubbed}`);
    note('census refusal', String(starved.censusReason));

    // ---- 26. RF-A: safety facts are re-derived from the bytes ---------------
    console.log('\n=== 26. RF-A authoritative revalidation ===');

    for (const fixture of [
        'r3-xfa-empty-fields', 'r3-xfa-missing-fields', 'r3-xfa-malformed-fields',
    ]) {
        const intakeRow = (await call('intake', [fixture]))[0];
        const extracted = await call('extract', fixture, [0]);
        check(`${fixture}: XFA is found without depending on a valid /Fields`,
            intakeRow.result === 'XFA_UNSAFE' && extracted.status === 'XFA_UNSAFE',
            `intake ${intakeRow.result}, extract ${extracted.status}`);
    }
    const badForm = (await call('intake', ['r3-malformed-acroform']))[0];
    const badFormExtract = await call('extract', 'r3-malformed-acroform', [0]);
    check('a malformed AcroForm fails closed, and says it is the form',
        badForm.result === 'UNSUPPORTED_FORM'
        && badFormExtract.status === 'UNSUPPORTED_FORM',
        `intake ${badForm.result}, extract ${badFormExtract.status}`);

    for (const [fixture, expected] of [
        ['signature-applied', 'SIGNATURE_UNSAFE'],
        ['r3-xfa-empty-fields', 'XFA_UNSAFE'],
        ['r3-xfa-missing-fields', 'XFA_UNSAFE'],
        ['r3-malformed-acroform', 'UNSUPPORTED_FORM'],
        ['form-choice', 'UNSUPPORTED_FORM'],
    ]) {
        const r = await call('mergeWithFalseIntake', ['merge-a', fixture]);
        check(`an ACCEPTED record for ${fixture} does not get past the run`,
            r.status === expected && r.bytes === null,
            `${r.status}, bytes ${r.bytes}`);
    }

    // ---- 27. RF-B: Merge rebuilds its destinations --------------------------
    console.log('\n=== 27. RF-B Merge destination reconstruction ===');

    for (const [names, label] of [
        [['nav-4p', 'merge-b'], 'a link source placed first'],
        [['merge-b', 'nav-4p'], 'the same source at a page offset'],
        [['nav-goto', 'merge-b'], 'a /GoTo action'],
        [['named-destination', 'merge-b'], 'a named destination'],
    ]) {
        const r = await call('mergeAndInspect', names, null);
        check(`${label}: nothing points outside the merged page tree`,
            r.status === 'READY'
            && r.independent?.strayPageRefs === 0
            && r.independent?.orphanPages === 0
            && r.production?.danglingDestinations === 0,
            `${r.status}, stray ${r.independent?.strayPageRefs}, `
            + `orphans ${r.independent?.orphanPages}, `
            + `dangling ${r.production?.danglingDestinations}`);
    }
    const nameClash = await call('mergeAndInspect',
        ['named-destination', 'named-destination'], null);
    check('a named-destination collision is refused, not quietly resolved',
        nameClash.status === 'DUPLICATE_NAMED_DESTINATIONS',
        `${nameClash.status}`);

    // ---- 28. RF-D: a compressed XMP packet stays readable -------------------
    console.log('\n=== 28. RF-D compressed metadata ===');

    const xmp = await call('metadataRoundTrip', 'r3-xmp-flate', [0]);
    check('the source packet really is compressed, and decodes',
        (xmp.sourceFilters ?? []).includes('FlateDecode')
        && xmp.sourceDecodable === true,
        `${JSON.stringify(xmp.sourceFilters)}, decodable ${xmp.sourceDecodable}`);
    check('the artifact packet decodes to the same XMP',
        xmp.status === 'READY'
        && xmp.artifactDecodable === true
        && xmp.xmpEqual === true
        && xmp.markerInDecoded === true,
        `${xmp.status}, decodable ${xmp.artifactDecodable}, `
        + `equal ${xmp.xmpEqual}, marker ${xmp.markerInDecoded}`);
    check('and no metadata gap is left to report',
        (xmp.gaps ?? []).length === 0, JSON.stringify(xmp.gaps));

    // ---- 29. RF-H: the page-reference invariant refuses before the copy -----
    console.log('\n=== 29. RF-H pre-copy invariant ===');

    const popup = await call('extractCountingCopies', 'r3-popup-crosspage', [0]);
    check('a cross-page /Popup is refused, and copyPages never ran',
        popup.status !== 'READY' && popup.copyPagesCalls === 0,
        `${popup.status}, copyPages ${popup.copyPagesCalls}x`);
    const ordinary = await call('extractCountingCopies', 'nav-4p', [0]);
    check('and an ordinary document still reaches the copy',
        ordinary.status === 'READY' && ordinary.copyPagesCalls > 0,
        `${ordinary.status}, copyPages ${ordinary.copyPagesCalls}x`);
    const thread = await call('extractAndInspect', 'r3-thread', [0], null);
    check('a /Thread bead chain is removed, disclosed, and leaves nothing stray',
        thread.status === 'READY'
        && thread.independent?.strayPageRefs === 0
        && (thread.losses ?? []).some((l) => l.kind === 'article-threads'),
        `${thread.status}, stray ${thread.independent?.strayPageRefs}, losses `
        + JSON.stringify((thread.losses ?? []).map((l) => l.kind)));

    // ---- 30. RF-F and RF-G: losses named for what they are ------------------
    console.log('\n=== 30. RF-F / RF-G loss labels ===');

    const emptySig = await call('extractAndInspect', 'signature-field-empty', [0], null);
    check('an unsigned signature field is dropped as itself, not as a form failure',
        emptySig.status === 'READY'
        && (emptySig.losses ?? []).some((l) => l.kind === 'empty-signature-field'),
        `${emptySig.status}, `
        + JSON.stringify((emptySig.losses ?? []).map((l) => l.kind)));
    const emptySigOnMerge = await call('mergeAndInspect',
        ['signature-field-empty', 'merge-b'], null);
    check('and the same on the Merge route',
        emptySigOnMerge.status === 'READY'
        && (emptySigOnMerge.losses ?? []).some((l) => l.kind === 'empty-signature-field'),
        `${emptySigOnMerge.status}, `
        + JSON.stringify((emptySigOnMerge.losses ?? []).map((l) => l.kind)));

    for (const fixture of ['ocmd', 'ocg-extgstate-smask']) {
        const r = await call('mergeAndInspect', ['merge-a', fixture], null);
        const labelled = (r.losses ?? []).filter((l) => l.kind === 'excluded-source');
        check(`${fixture} is reported as an excluded source, not a broken link`,
            r.status === 'READY'
            && labelled.some((l) => (l.what ?? '').includes(fixture)),
            JSON.stringify((r.losses ?? []).map((l) => `${l.kind}:${l.what ?? ''}`)));
    }

    // ---- 31. RF-I: every loss the plan named reaches the result -------------
    console.log('\n=== 31. RF-I planned losses survive to the result ===');

    const deferred = await call('extractAndInspect', 'r3-deferred-structures', [0], null);
    const deferredKinds = (deferred.losses ?? []).map((l) => l.kind);
    check('outlines and page labels are disclosed on a successful Extract',
        deferred.status === 'READY'
        && deferredKinds.includes('outlines')
        && deferredKinds.includes('page-labels'),
        `${deferred.status}, ${JSON.stringify(deferredKinds)}`);
    const deferredMerge = await call('mergeAndInspect',
        ['r3-deferred-structures', 'merge-b'], null);
    const mergeKinds = (deferredMerge.losses ?? []).map((l) => l.kind);
    check('and on a successful Merge',
        deferredMerge.status === 'READY'
        && mergeKinds.includes('outlines')
        && mergeKinds.includes('page-labels'),
        `${deferredMerge.status}, ${JSON.stringify(mergeKinds)}`);

    const manyPlan = await call('plan', 'r3-many-losses', [0]);
    check('a document with many losses needs both confirmations before it runs',
        manyPlan.status === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION'
        && (manyPlan.requiresConfirmation ?? []).includes('attachments')
        && (manyPlan.requiresConfirmation ?? []).includes('tagging'),
        `${manyPlan.status}, `
        + JSON.stringify(manyPlan.requiresConfirmation));
    const manyRun = await call('extractAndInspect', 'r3-many-losses', [0], null);
    const ranKeys = new Set((manyRun.losses ?? []).map((l) => `${l.kind}|${l.what ?? ''}`));
    const dropped = (manyPlan.losses ?? [])
        .filter((l) => !ranKeys.has(`${l.kind}|${l.what ?? ''}`));
    check('and no loss the plan named disappears from the result',
        manyRun.status === 'READY' && dropped.length === 0,
        `${manyRun.status}, planned ${(manyPlan.losses ?? []).length}, dropped `
        + JSON.stringify(dropped.map((l) => `${l.kind}:${l.what ?? ''}`)));
    check('the attachment is among them, by name',
        (manyRun.losses ?? []).some((l) => l.kind === 'attachments'
            && (l.what ?? '').includes('secret-notes.txt')),
        JSON.stringify((manyRun.losses ?? [])
            .filter((l) => l.kind === 'attachments').map((l) => l.what)));

    // ---- 32. optional-content configuration fidelity ------------------------
    //
    // Two sources can each be individually supported and still not have one
    // coherent default configuration between them. Picking one silently would
    // hide a layer in the other.
    console.log('\n=== 32. optional-content configuration fidelity ===');

    const ocAgree = await call('mergeAndInspect', ['r3-oc-name-a', 'r3-oc-name-same'], null);
    check('two sources whose default configurations agree merge, keeping both groups',
        ocAgree.status === 'READY'
        && (ocAgree.optionalContent?.groups ?? []).includes('M6-OC-A')
        && (ocAgree.optionalContent?.groups ?? []).includes('M6-OC-C'),
        `${ocAgree.status}, `
        + JSON.stringify(ocAgree.optionalContent?.groups));
    const ocName = await call('mergeAndInspect', ['r3-oc-name-a', 'r3-oc-name-b'], null);
    check('a disagreeing /D /Name is refused rather than one being chosen',
        ocName.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${ocName.status}`);
    const ocOrder = await call('mergeAndInspect', ['r3-oc-order', 'r3-oc-no-order'], null);
    check('an ordered source plus an unordered one is refused',
        ocOrder.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${ocOrder.status}`);
    const ocBase = await call('mergeAndInspect', ['r3-oc-order', 'r3-oc-basestate-on'], null);
    check('a /BaseState the sources agree on is carried, not dropped',
        ocBase.status === 'READY'
        && (ocBase.optionalContent?.groups ?? []).length === 2,
        `${ocBase.status}, `
        + JSON.stringify(ocBase.optionalContent?.groups));

    // ---- 33. a Merge confirmation that actually blocks ----------------------
    console.log('\n=== 33. Merge confirmation semantics ===');

    const unconfirmed = await call('mergeUnconfirmed', ['with-attachment', 'merge-b']);
    check('a confirmation-required Merge does not proceed unconfirmed',
        (unconfirmed.requiresConfirmation ?? []).length > 0
        && unconfirmed.status === 'CONFIRMATION_REQUIRED'
        && unconfirmed.bytes === null,
        `requires ${JSON.stringify(unconfirmed.requiresConfirmation)}, `
        + `${unconfirmed.status}, bytes ${unconfirmed.bytes}`);
    check('and the refusal carries the losses it is asking about',
        (unconfirmed.losses ?? []).some((l) => l.kind === 'attachments'),
        JSON.stringify((unconfirmed.losses ?? []).map((l) => l.kind)));
    const confirmed = await call('mergeAndInspect', ['with-attachment', 'merge-b'], null);
    check('and it proceeds once those losses are confirmed',
        confirmed.status === 'READY'
        && confirmed.independent?.efCarriers === 0,
        `${confirmed.status}, carriers ${confirmed.independent?.efCarriers}`);

    // ---- 35. RF-R3-5: the named-destination reader ends COMPLETE or REFUSED --
    //
    // Two standard shapes were invisible to it, and invisible read as absent:
    // a `/Kids` name tree, which is how any document with more than a handful
    // of names is written, and a `<< /D [...] >>` destination dictionary. With
    // the target page still in the selection, both disappeared from the output
    // with no loss recorded and the operation READY.
    console.log('\n=== 35. RF-R3-5 named destinations ===');

    const ndAll = [0, 1, 2];
    for (const shape of ['flat', 'dict', 'kids', 'kids-deep']) {
        const kept = await call('extractNamedDestinations', `r4-nd-${shape}`, ndAll);
        const names = (kept.names ?? []).map((n) => n.name);
        check(`r4-nd-${shape}: the named destination survives when its target does`,
            kept.status === 'READY'
            && names.includes('M6R4_SEC')
            && (kept.names ?? []).some((n) => n.name === 'M6R4_SEC' && n.targetIndex === 2),
            `${kept.status}, ${JSON.stringify(kept.names)}`);
        check(`r4-nd-${shape}: and it is not reported as a loss`,
            (kept.losses ?? []).every((l) => l.kind !== 'named-destinations'),
            JSON.stringify((kept.losses ?? []).map((l) => l.kind)));
    }

    // Both names in the two-level tree, so the walk reaches the second branch.
    const ndDeep = await call('extractNamedDestinations', 'r4-nd-kids-deep', ndAll);
    check('r4-nd-kids-deep: every leaf of the tree was read',
        (ndDeep.names ?? []).map((n) => n.name).sort().join(',') === 'M6R4_SEC,M6R4_TAIL',
        JSON.stringify((ndDeep.names ?? []).map((n) => n.name)));

    for (const shape of ['flat', 'dict', 'kids', 'kids-deep']) {
        const dropped = await call('extractNamedDestinations', `r4-nd-${shape}`, [0]);
        check(`r4-nd-${shape}: an excluded target is an explicit loss, not an absence`,
            dropped.status === 'READY'
            && (dropped.losses ?? []).some(
                (l) => l.kind === 'named-destinations' && l.what === 'M6R4_SEC',
            ),
            `${dropped.status}, ${JSON.stringify((dropped.losses ?? []).map((l) => `${l.kind}:${l.what}`))}`);
    }

    for (const shape of ['kids-cycle', 'kids-malformed', 'names-malformed', 'dict-invalid']) {
        const refused = await call('extractNamedDestinations', `r4-nd-${shape}`, ndAll);
        check(`r4-nd-${shape}: a tree that cannot be read is refused, never empty`,
            refused.status === 'UNREADABLE_DESTINATIONS',
            `${refused.status}: ${refused.reason}`);
    }
    // The refusals have to be about structures that are there. A `null` slot is
    // the specification's way of writing an empty one, and an ordinary document
    // that uses it must still go through.
    const nullSlots = await call('extractNamedDestinations', 'r4-nd-null-slots', ndAll);
    check('a null /Annots slot and a null /Kids entry are empty, not unreadable',
        nullSlots.status === 'READY'
        && (nullSlots.names ?? []).some((n) => n.name === 'M6R4_SEC' && n.targetIndex === 2),
        `${nullSlots.status}, ${JSON.stringify(nullSlots.names ?? nullSlots.reason)}`);

    const annotsMalformed = await call('extractNamedDestinations', 'r4-annots-malformed', [0, 1]);
    check('r4-annots-malformed: an /Annots that is present and unreadable is refused',
        annotsMalformed.status === 'UNREADABLE_DESTINATIONS',
        `${annotsMalformed.status}: ${annotsMalformed.reason}`);
    // On the Merge route a source this contract cannot handle is excluded and
    // named rather than failing the whole run (M6-H10, RF-G). What must not
    // happen is the third thing: merging it as though it had no annotations.
    const annotsMerge = await call('mergeNamedDestinations', ['r4-annots-malformed', 'merge-b']);
    const annotsExcluded = (annotsMerge.intake ?? [])
        .some((r) => r.name === 'r4-annots-malformed.pdf' && r.result !== 'ACCEPTED');
    check('and a Merge excludes it by name rather than merging it as annotation-free',
        annotsMerge.status !== 'READY'
        || (annotsExcluded
            && (annotsMerge.losses ?? []).some(
                (l) => l.kind === 'excluded-source' && l.what === 'r4-annots-malformed.pdf',
            )),
        `${annotsMerge.status}, intake `
        + `${JSON.stringify((annotsMerge.intake ?? []).map((r) => `${r.name}:${r.result}`))}, `
        + `losses ${JSON.stringify((annotsMerge.losses ?? []).map((l) => `${l.kind}:${l.what}`))}`);

    const ndMerge = await call('mergeNamedDestinations', ['r4-nd-kids', 'merge-b']);
    check('a Merge carries a name-tree destination into the output',
        ndMerge.status === 'READY'
        && (ndMerge.names ?? []).some((n) => n.name === 'M6R4_SEC' && n.targetIndex === 2),
        `${ndMerge.status}, ${JSON.stringify(ndMerge.names)}`);
    const ndMergeRefused = await call('mergeNamedDestinations', ['r4-nd-kids-cycle', 'merge-b']);
    check('and a Merge refuses a name tree it cannot read',
        ndMergeRefused.status === 'UNREADABLE_DESTINATIONS',
        `${ndMergeRefused.status}: ${ndMergeRefused.reason}`);

    // The other half of the reconstruction contract: what it does when it
    // cannot apply what it planned. Every fixture produces an empty list, so
    // this drives it past that on purpose.
    const unapplied = await call('rebuildUnapplied');
    check('a reconstruction that cannot be applied says so rather than counting it',
        unapplied.rebuilt === 0
        && unapplied.unapplied.length === 2
        && unapplied.controlUnapplied.length === 0,
        `rebuilt ${unapplied.rebuilt}, unapplied ${JSON.stringify(unapplied.unapplied)}, `
        + `control ${JSON.stringify(unapplied.controlUnapplied)}`);

    // ---- 36. RF-R3-1: optional-content configuration survives a Merge -------
    //
    // Measured before the fix: two sources agreeing on `/D /Name (Config A)`
    // merged to a `/D` holding neither name. Not a silent winner — both were
    // discarded, READY, with nothing reported.
    console.log('\n=== 36. RF-R3-1 optional-content configuration ===');

    const ocSourceA = await call('sourceOptionalContentConfig', 'r3-oc-name-a');
    check('the sources really do declare the configuration under test',
        ocSourceA.name === 'Config A' && ocSourceA.order === 1,
        JSON.stringify(ocSourceA));

    const ocOne = await call('mergeOptionalContentConfig', ['r3-oc-name-a']);
    check('one source keeps its /D /Name',
        ocOne.status === 'READY' && ocOne.config?.name === 'Config A',
        `${ocOne.status}, ${JSON.stringify(ocOne.config)}`);

    const ocTwo = await call('mergeOptionalContentConfig', ['r3-oc-name-a', 'r3-oc-name-same']);
    check('two sources that agree on /D /Name keep it',
        ocTwo.status === 'READY' && ocTwo.config?.name === 'Config A',
        `${ocTwo.status}, ${JSON.stringify(ocTwo.config)}`);
    check('and both groups are still listed and ordered',
        (ocTwo.config?.groups ?? []).includes('M6-OC-A')
        && (ocTwo.config?.groups ?? []).includes('M6-OC-C')
        && ocTwo.config?.order === 2,
        JSON.stringify(ocTwo.config));

    const ocThree = await call('mergeOptionalContentConfig',
        ['r3-oc-name-a', 'r3-oc-name-same', 'r4-oc-name-c']);
    check('three agreeing sources keep it too',
        ocThree.status === 'READY'
        && ocThree.config?.name === 'Config A'
        && (ocThree.config?.groups ?? []).length === 3,
        `${ocThree.status}, ${JSON.stringify(ocThree.config)}`);

    const ocBaseMerged = await call('mergeOptionalContentConfig',
        ['r3-oc-basestate-on', 'r4-oc-basestate-b']);
    check('an agreed /BaseState is carried into the output, not dropped',
        ocBaseMerged.status === 'READY' && ocBaseMerged.config?.baseState === '/ON',
        `${ocBaseMerged.status}, ${JSON.stringify(ocBaseMerged.config)}`);

    const ocNameOnly = await call('mergeOptionalContentConfig',
        ['r3-oc-name-a', 'r4-oc-plain']);
    check('a named source merged with an unnamed one keeps the name',
        ocNameOnly.status === 'READY' && ocNameOnly.config?.name === 'Config A',
        `${ocNameOnly.status}, ${JSON.stringify(ocNameOnly.config)}`);

    const ocConflict = await call('mergeOptionalContentConfig', ['r3-oc-name-a', 'r3-oc-name-b']);
    check('a disagreeing /D /Name is still refused rather than resolved',
        ocConflict.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${ocConflict.status}`);
    const ocOrderMix = await call('mergeOptionalContentConfig', ['r3-oc-order', 'r3-oc-no-order']);
    check('and an ordered source plus an unordered one is still refused',
        ocOrderMix.status === 'UNSUPPORTED_OPTIONAL_CONTENT', `${ocOrderMix.status}`);

    // ---- 37. RF-R3-2: the confirmation sees a typeless /EF ------------------
    //
    // The removal path found these; the path that decides whether to ask did
    // not, because it asked about `/Type`. So a Merge deleted an attachment
    // nobody had been asked about and named it afterwards.
    console.log('\n=== 37. RF-R3-2 typeless attachment confirmation ===');

    for (const fixture of ['r4-typeless-ef', 'r4-typeless-ef-deep', 'r3-typeless-ef']) {
        const facts = await call('attachmentFacts', fixture);
        check(`${fixture}: intake sees the attachment the artifact really holds`,
            facts.hasAttachments === true
            && facts.attachmentsComplete === true
            && facts.independent?.efCarriers > 0,
            `hasAttachments ${facts.hasAttachments}, complete ${facts.attachmentsComplete}, `
            + `independent /EF ${facts.independent?.efCarriers}`);
        const unconfirmed = await call('mergeUnconfirmed', [fixture, 'merge-b']);
        check(`${fixture}: a Merge will not proceed without the confirmation`,
            (unconfirmed.requiresConfirmation ?? []).includes('attachments')
            && unconfirmed.status === 'CONFIRMATION_REQUIRED'
            && unconfirmed.bytes === null,
            `requires ${JSON.stringify(unconfirmed.requiresConfirmation)}, `
            + `${unconfirmed.status}, bytes ${unconfirmed.bytes}`);
        check(`${fixture}: and the refusal names the file it is asking about`,
            (unconfirmed.losses ?? []).some((l) => l.kind === 'attachments'),
            JSON.stringify((unconfirmed.losses ?? []).map((l) => `${l.kind}:${l.what}`)));
    }
    const typelessConfirmed = await call('mergeAndInspect',
        ['r4-typeless-ef', 'merge-b'], 'M6R4_TYPELESS_SHALLOW');
    check('once confirmed, the payload is gone from the bytes',
        typelessConfirmed.status === 'READY'
        && typelessConfirmed.independent?.efCarriers === 0
        && typelessConfirmed.markerInBytes === false,
        `${typelessConfirmed.status}, carriers ${typelessConfirmed.independent?.efCarriers}, `
        + `marker ${typelessConfirmed.markerInBytes}`);

    // ---- 38. RF-R3-3: a confirmation belongs to the plan it was given for ---
    //
    // A bare list of agreed loss kinds outlived the plan: confirm A and B, add
    // C, click once, and C's attachment was deleted having never been shown.
    console.log('\n=== 38. RF-R3-3 confirmation is bound to its plan ===');

    const stale = {};
    for (const mutate of ['none', 'add', 'remove', 'reorder']) {
        stale[mutate] = await call('mergeStaleConfirmation',
            ['r3-explicit-filespec', 'merge-b'], mutate);
    }
    check('an unchanged plan honours its own confirmation',
        stale.none.fingerprintChanged === false && stale.none.status === 'READY',
        `${stale.none.status}, changed ${stale.none.fingerprintChanged}`);
    for (const mutate of ['add', 'remove', 'reorder']) {
        const r = stale[mutate];
        check(`a confirmation does not survive ${mutate}`,
            r.fingerprintChanged === true
            && (r.requiresConfirmation.length === 0
                ? r.status === 'READY'
                : r.status === 'CONFIRMATION_REQUIRED' && r.bytes === null),
            `changed ${r.fingerprintChanged}, requires `
            + `${JSON.stringify(r.requiresConfirmation)}, ${r.status}, bytes ${r.bytes}`);
    }

    // =========================================================================
    // Round 5. Every text assertion below is made by PDF.js — which shares no
    // code with the writer — on the source and on the artifact, against the
    // text the fixture meant. The fourth review's point was that a pdf-lib
    // writer read back by pdf-lib hid its own defect.
    // =========================================================================

    const FORM_TEXT = {
        '氏名': '山田 太郎',
        '〨〩ぜ名': '〨〩ぜ値',
        '(1) first': '(1) first',
        'close)paren': 'a)b',
        'open(paren': 'a(b',
        'back\\slash': 'C:\\dir\\file',
        'Größe': '•ﬁ€é',
        '𠮷野家': '𠮷野家 定食',
        'ctl\u0007name': 'a\tb\u0001c',
        multiline: 'l1\r\nl2',
        empty: '',
        utf8bom: '日本語',
        octA_x: 'v01',
    };
    const ND_TEXT = {
        M6R5_ASCII: 1, 'a(b)c\\d': 2, '•A': 3, '目次': 1, '〨ぜ': 2, M6R5_P: 3,
        M6R5_PA: 1, M6R5_PB: 2, '目次2': 3, M6R5_ESC: 1, M6R5OCT: 2, M6R5_HEX: 3,
    };
    const valuesOf = (fields) => Object.fromEntries(
        Object.entries(fields ?? {}).map(([name, widgets]) => [name, widgets.map((w) => w.value)]),
    );
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** The syntax contract every READY round-5 artifact is held to (2.6). */
    const syntaxHolds = (r) => r.status === 'READY'
        && r.boundary === 'PASS'
        && r.pdfjsError === null
        && r.output !== null;
    const syntaxDetail = (r) => `${r.status}, boundary ${r.boundary} ${r.boundaryCode ?? ''}, `
        + `pdf.js ${r.pdfjsError ?? 'opened'}`;

    // ---- 39. BLK-R4-1: the oracle can see the defect ------------------------
    console.log('\n=== 39. BLK-R4-1 the oracle, fed the old writer ===');
    const oracle = await call('oracleProbe');
    const oracleFields = valuesOf(oracle.fields);
    probe('PDF.js does not read the old writer\'s output as what was meant',
        !(oracleFields['〨〩ぜ名'] && oracleFields['〨〩ぜ名'][0] === 'a)b'),
        JSON.stringify(oracle.fields ?? oracle.error));

    // ---- 40. BLK-R4-1: form text --------------------------------------------
    console.log('\n=== 40. BLK-R4-1 form text ===');
    const formSource = await call('fidelityExtract', 'r5-form-text', [0]);
    const sourceFields = valuesOf(formSource.sources[0].fields);
    check('the source really holds every case, as PDF.js reads it',
        Object.entries(FORM_TEXT).every(([t, v]) => sameJson(sourceFields[t], [v])),
        JSON.stringify(sourceFields));
    check('Extract: the artifact is a document (READY, Load Boundary PASS, PDF.js opens it)',
        syntaxHolds(formSource), syntaxDetail(formSource));
    const extractFields = valuesOf(formSource.output?.fields);
    for (const [t, v] of Object.entries(FORM_TEXT)) {
        check(`Extract: field ${JSON.stringify(t)} keeps its name and value ${JSON.stringify(v)}`,
            sameJson(extractFields[t], [v]),
            `got ${JSON.stringify(extractFields[t])}`);
    }
    check('Extract: no field appears that the source did not have',
        Object.keys(extractFields).sort().join('|') === Object.keys(FORM_TEXT).sort().join('|'),
        JSON.stringify(Object.keys(extractFields)));

    const formMerge = await call('fidelityMerge', ['r5-form-text', 'merge-b']);
    check('Merge: the artifact is a document', syntaxHolds(formMerge), syntaxDetail(formMerge));
    const mergeFields = valuesOf(formMerge.output?.fields);
    check('Merge: every name and value is the text the source showed',
        Object.entries(FORM_TEXT).every(([t, v]) => sameJson(mergeFields[t], [v])),
        JSON.stringify(mergeFields));

    // The constructed path: the same form twice. Every name collides, and the
    // adopted rename policy prefixes each copy's colliding names with its
    // position — so all of them are rebuilt from their text as
    // `source1.<name>` and `source2.<name>`.
    const formTwice = await call('fidelityMerge', ['r5-form-text', 'r5-form-text']);
    const twiceFields = valuesOf(formTwice.output?.fields);
    check('Merge rename: the artifact is a document', syntaxHolds(formTwice), syntaxDetail(formTwice));
    for (const prefix of ['source1', 'source2']) {
        check(`Merge rename: every ${prefix} field is its source name, prefixed, with its value`,
            Object.entries(FORM_TEXT).every(([t, v]) => sameJson(twiceFields[`${prefix}.${t}`], [v])),
            JSON.stringify(Object.keys(twiceFields).filter((k) => k.startsWith(`${prefix}.`))));
    }
    check('Merge rename: nothing else appears, and every rename is reported',
        Object.keys(twiceFields).length === 2 * Object.keys(FORM_TEXT).length
        && (formTwice.renamedFields ?? []).length === 2 * Object.keys(FORM_TEXT).length,
        `${Object.keys(twiceFields).length} fields, ${(formTwice.renamedFields ?? []).length} renamed`);

    for (const [fixture, label] of [
        ['r5-form-bad-utf16', 'a value that is malformed UTF-16'],
        ['r5-form-v-stream', 'a value that is a stream'],
    ]) {
        const r = await call('extract', fixture, [0]);
        check(`Extract refuses ${label} rather than rebuilding it empty`,
            r.status === 'UNSUPPORTED_FORM' && r.outputBytes === null,
            `${r.status}: ${(r.reason ?? '').slice(0, 90)}`);
        const m = await call('fidelityMerge', [fixture, 'merge-b']);
        check(`Merge excludes a source with ${label}, by name`,
            (m.intake ?? []).some((i) => i.name === `${fixture}.pdf` && i.result === 'UNSUPPORTED_FORM'),
            JSON.stringify(m.intake));
    }

    // ---- 41. BLK-R4-1: named-destination text and order ---------------------
    console.log('\n=== 41. BLK-R4-1 named-destination text and name-tree order ===');
    const ndSource = await call('fidelityExtract', 'r5-nd-text', [0, 1, 2, 3]);
    check('the source really defines every key, as PDF.js reads it',
        Object.entries(ND_TEXT).every(([name, page]) => ndSource.sources[0].destinations[name] === page),
        JSON.stringify(ndSource.sources[0].destinations));
    check('Extract: the artifact is a document', syntaxHolds(ndSource), syntaxDetail(ndSource));
    check('Extract: every name resolves, by its text, to its page',
        Object.entries(ND_TEXT).every(([name, page]) => ndSource.output?.destinations[name] === page)
        && Object.keys(ndSource.output?.destinations ?? {}).length === Object.keys(ND_TEXT).length,
        JSON.stringify(ndSource.output?.destinations));
    check('Extract: the rebuilt /Names is in byte order (read by this gate)',
        ndSource.leavesAscending === true && ndSource.keyCount === Object.keys(ND_TEXT).length,
        `ascending ${ndSource.leavesAscending}, ${ndSource.keyCount} keys`);
    check('Extract: PDF.js finds every key by its RAW BYTES — its binary search, not its fallback',
        ndSource.rawLookups.length === Object.keys(ND_TEXT).length
        && ndSource.rawLookups.every((l) => l.page !== null),
        JSON.stringify(ndSource.rawLookups.filter((l) => l.page === null).map((l) => l.raw)));
    check('Extract: every link reaches the page its name named',
        sameJson(ndSource.output?.links.map((l) => l.target), [1, 1, 2, 1]),
        JSON.stringify(ndSource.output?.links));

    const ndPartial = await call('fidelityExtract', 'r5-nd-text', [0, 1]);
    const keptNames = Object.entries(ND_TEXT).filter(([, p]) => p === 1).map(([n]) => n).sort();
    const lostNames = Object.entries(ND_TEXT).filter(([, p]) => p !== 1).map(([n]) => n).sort();
    check('Extract of pages 1–2: the names targeting kept pages survive by their text',
        syntaxHolds(ndPartial)
        && sameJson(Object.keys(ndPartial.output?.destinations ?? {}).sort(), keptNames),
        JSON.stringify(ndPartial.output?.destinations));
    check('and every other name is an explicit loss, named by its text',
        sameJson(ndPartial.losses.filter((l) => l.kind === 'named-destinations').map((l) => l.what).sort(),
            lostNames),
        JSON.stringify(ndPartial.losses.filter((l) => l.kind === 'named-destinations')));

    const ndTextMerge = await call('fidelityMerge', ['merge-b', 'r5-nd-text']);
    check('Merge after a 2-page source: every name resolves to its shifted page',
        syntaxHolds(ndTextMerge)
        && Object.entries(ND_TEXT).every(([name, page]) => ndTextMerge.output?.destinations[name] === page + 2),
        JSON.stringify(ndTextMerge.output?.destinations));
    check('Merge: /Names in byte order, every key found by raw bytes',
        ndTextMerge.leavesAscending === true
        && ndTextMerge.rawLookups.length === Object.keys(ND_TEXT).length
        && ndTextMerge.rawLookups.every((l) => l.page !== null),
        `ascending ${ndTextMerge.leavesAscending}, `
        + JSON.stringify(ndTextMerge.rawLookups.filter((l) => l.page === null).map((l) => l.raw)));

    // ---- 42. BLK-R4-1: optional-content configuration name -------------------
    console.log('\n=== 42. BLK-R4-1 optional-content /D /Name and /Order labels ===');
    const OC_NAMES = {
        'r5-oc-name-jp': 'レイヤー設定',
        'r5-oc-name-parens': '(A) cfg',
        'r5-oc-name-backslash': 'C:\\cfg',
        'r5-oc-name-highbyte': '•Cfg',
        'r5-oc-name-ascii': 'Config Plain',
        'r5-oc-name-utf16lit': '〨〩ぜ',
    };
    for (const [fixture, text] of Object.entries(OC_NAMES)) {
        const e = await call('fidelityExtract', fixture, [0]);
        check(`${fixture}: Extract keeps /D /Name ${JSON.stringify(text)} (source reads the same)`,
            syntaxHolds(e) && e.sources[0].oc?.name === text && e.output?.oc?.name === text,
            `${syntaxDetail(e)}, source ${JSON.stringify(e.sources[0].oc?.name)}, `
            + `output ${JSON.stringify(e.output?.oc?.name)}`);
        const m = await call('fidelityMerge', [fixture, fixture]);
        check(`${fixture}: a Merge of two agreeing copies keeps it`,
            syntaxHolds(m) && m.output?.oc?.name === text,
            `${syntaxDetail(m)}, ${JSON.stringify(m.output?.oc?.name)}`);
    }
    const orderLabel = await call('fidelityExtract', 'r5-oc-order-label', [0]);
    const labelOf = (order) => (order ?? []).find((e) => e && typeof e === 'object' && 'name' in e)?.name ?? null;
    check('an /Order label is carried as the text it was',
        syntaxHolds(orderLabel)
        && labelOf(orderLabel.sources[0].oc?.order) === '設計図'
        && labelOf(orderLabel.output?.oc?.order) === '設計図',
        `${syntaxDetail(orderLabel)}, ${JSON.stringify(orderLabel.output?.oc?.order)}`);
    for (const fixture of ['r5-oc-name-bad', 'r5-oc-name-notstring']) {
        const r = await call('extract', fixture, [0]);
        check(`${fixture}: a /D /Name that is there and unreadable is refused, not dropped`,
            r.status === 'UNSUPPORTED_OPTIONAL_CONTENT' && r.outputBytes === null,
            `${r.status}: ${(r.reason ?? '').slice(0, 90)}`);
    }

    // ---- 43. RF-R4-2: the catalog's own /Dests -------------------------------
    console.log('\n=== 43. RF-R4-2 legacy catalog /Dests ===');
    const LEGACY = {
        'r5-legacy-array': { names: { M6R5_LEG: 2 }, links: [2] },
        'r5-legacy-dict': { names: { M6R5_LEGD: 2 }, links: [2] },
        'r5-legacy-escaped': { names: { 'M6R5 LEG': 2 }, links: [2] },
        'r5-legacy-plus-tree': { names: { M6R5_L1: 1, M6R5_T1: 2 }, links: [1, 2] },
    };
    for (const [fixture, want] of Object.entries(LEGACY)) {
        const e = await call('fidelityExtract', fixture, [0, 1, 2]);
        check(`${fixture}: PDF.js reads the source's names`,
            Object.entries(want.names).every(([n, p]) => e.sources[0].destinations[n] === p),
            JSON.stringify(e.sources[0].destinations));
        check(`${fixture}: Extract keeps every name at its page, and its links`,
            syntaxHolds(e)
            && Object.entries(want.names).every(([n, p]) => e.output?.destinations[n] === p)
            && sameJson(e.output?.links.map((l) => l.target), want.links)
            && e.rawLookups.every((l) => l.page !== null),
            `${syntaxDetail(e)}, ${JSON.stringify(e.output?.destinations)}, `
            + `links ${JSON.stringify(e.output?.links)}`);
        const dropped = await call('fidelityExtract', fixture, [0]);
        const lostHere = Object.keys(want.names).sort();
        check(`${fixture}: an excluded target is an explicit loss, named`,
            dropped.status === 'READY'
            && sameJson(dropped.losses.filter((l) => l.kind === 'named-destinations').map((l) => l.what).sort(),
                lostHere),
            JSON.stringify(dropped.losses));
        const m = await call('fidelityMerge', [fixture, 'merge-b']);
        check(`${fixture}: Merge keeps every name at its page`,
            syntaxHolds(m) && Object.entries(want.names).every(([n, p]) => m.output?.destinations[n] === p),
            `${syntaxDetail(m)}, ${JSON.stringify(m.output?.destinations)}`);
    }
    for (const fixture of ['r5-legacy-malformed', 'r5-legacy-bad-value', 'r5-legacy-hash-lower', 'r5-legacy-nonascii']) {
        const e = await call('extract', fixture, [0, 1, 2]);
        check(`${fixture}: Extract refuses rather than reading it as none`,
            e.status === 'UNREADABLE_DESTINATIONS', `${e.status}: ${(e.reason ?? '').slice(0, 90)}`);
        const m = await call('fidelityMerge', [fixture, 'merge-b']);
        check(`${fixture}: and so does Merge`,
            m.status === 'UNREADABLE_DESTINATIONS', `${m.status}: ${(m.reason ?? '').slice(0, 90)}`);
    }

    // ---- 44. RF-R4-3: one name, two definitions -----------------------------
    console.log('\n=== 44. RF-R4-3 duplicate named destinations ===');
    for (const shape of ['same-leaf', 'same-target', 'kids', 'legacy-tree', 'encoding', 'hex-literal', 'dict-wrapped']) {
        const e = await call('extract', `r5-dup-${shape}`, [0, 1, 2]);
        check(`r5-dup-${shape}: Extract refuses the duplicate`,
            e.status === 'DUPLICATE_NAMED_DESTINATIONS' && e.outputBytes === null,
            `${e.status}: ${(e.reason ?? '').slice(0, 90)}`);
        const m = await call('fidelityMerge', [`r5-dup-${shape}`, 'merge-b']);
        check(`r5-dup-${shape}: Merge refuses it too`,
            m.status === 'DUPLICATE_NAMED_DESTINATIONS', `${m.status}: ${(m.reason ?? '').slice(0, 90)}`);
    }

    // ---- 45. RF-R4-4: signatures behind unreadable ancestry ------------------
    console.log('\n=== 45. RF-R4-4 signature classification ===');
    const invariantProbe = await call('signatureInvariantProbe', 'r5-sig-direct-v');
    probe('the readback invariant fires on a signed document',
        invariantProbe.signatureRemnants > 0 && invariantProbe.invariant === 'signatureRemnants === 0',
        JSON.stringify(invariantProbe));

    const SIG = {
        'r5-sig-inherited': { extract: 'READY', merge: 'SIGNATURE_UNSAFE', applied: true },
        'r5-sig-inherited-kid-field': { extract: 'UNSUPPORTED_FORM', merge: 'SIGNATURE_UNSAFE' },
        'r5-sig-direct-v': { extract: 'READY', merge: 'SIGNATURE_UNSAFE', applied: true },
        'r5-sig-parent-cycle': { extract: 'UNSUPPORTED_FORM', merge: 'SIGNATURE_UNSAFE' },
        'r5-sig-parent-dangling': { extract: 'UNSUPPORTED_FORM', merge: 'SIGNATURE_UNSAFE' },
        'r5-sig-parent-wrong-type': { extract: 'UNSUPPORTED_FORM', merge: 'SIGNATURE_UNSAFE' },
        'r5-sig-missing-ft': { extract: 'UNSUPPORTED_FORM', merge: 'SIGNATURE_UNSAFE' },
        'r5-sig-orphan-widget': { extract: 'READY', merge: 'SIGNATURE_UNSAFE', applied: true },
        'r5-sig-unclassifiable': { extract: 'UNSUPPORTED_FORM', merge: 'UNSUPPORTED_FORM' },
        'r5-sig-empty': { extract: 'READY', merge: 'ACCEPTED', empty: true },
        'r5-tx-control': { extract: 'READY', merge: 'ACCEPTED' },
    };
    const zeroSignature = (g) => g && g.byteRange === 0 && g.typeSig === 0 && g.ftSig === 0
        && g.dictValues === 0 && g.appearanceMarker === false && g.payloadMarker === false;
    for (const [fixture, want] of Object.entries(SIG)) {
        const facts = await call('signatureFacts', fixture);
        if (want.applied || want.merge === 'SIGNATURE_UNSAFE') {
            check(`${fixture}: the facts see an applied signature`,
                facts.hasAppliedSignature === true, JSON.stringify(facts));
        }
        const e = await call('signatureExtract', fixture);
        check(`${fixture}: Extract is ${want.extract}`,
            e.status === want.extract, `${e.status}: ${(e.reason ?? '').slice(0, 90)}`);
        if (e.status === 'READY') {
            check(`${fixture}: the derivative carries no signature field, value, byte range or appearance`,
                e.production === 0 && zeroSignature(e.gate) && e.boundary === 'PASS',
                `production ${e.production}, gate ${JSON.stringify(e.gate)}, boundary ${e.boundary}`);
        }
        if (want.applied) {
            check(`${fixture}: and says the applied signature was removed, never "unsigned"`,
                e.losses.some((l) => l.kind === 'applied-signature')
                && !e.losses.some((l) => l.kind === 'empty-signature-field'),
                JSON.stringify(e.losses.map((l) => `${l.kind}:${l.what}`)));
        }
        if (want.empty) {
            check(`${fixture}: an unsigned field is disclosed as unsigned`,
                e.losses.some((l) => l.kind === 'empty-signature-field')
                && !e.losses.some((l) => l.kind === 'applied-signature'),
                JSON.stringify(e.losses.map((l) => `${l.kind}:${l.what}`)));
        }
        const m = await call('signatureMerge', fixture);
        const sourceResult = m.intake.find((i) => i.name === `${fixture}.pdf`)?.result;
        check(`${fixture}: Merge intake is ${want.merge}`,
            sourceResult === want.merge, JSON.stringify(m.intake));
        if (want.merge !== 'ACCEPTED') {
            check(`${fixture}: and a forged ACCEPTED record is refused by the run`,
                m.forgedStatus === want.merge && m.forgedBytes === null,
                `${m.forgedStatus}, bytes ${m.forgedBytes}`);
        }
        if (m.status === 'READY') {
            check(`${fixture}: the merged artifact carries no signature remnant`,
                m.production === 0 && zeroSignature(m.gate),
                `production ${m.production}, gate ${JSON.stringify(m.gate)}`);
        }
    }

    // ---- 46. RF-R4-5: the bytes, not the message, decide ---------------------
    console.log('\n=== 46. RF-R4-5 worker actual-byte confirmation authority ===');
    const parity = await call('digestParity');
    check('the content digest agrees with Web Crypto on every sample, in both implementations',
        parity.disagreements.length === 0, `${parity.samples} samples, ${JSON.stringify(parity.disagreements)}`);
    for (const viaWorker of [false, true]) {
        const where = viaWorker ? 'worker' : 'module';
        for (const scenario of ['attachment-appears', 'attachment-forged', 'tagging-appears', 'tagging-forged', 'content-swap']) {
            const r = await call('runtimeAuthority', scenario, viaWorker);
            check(`${where}: ${scenario} cannot run under the stale plan`,
                r.status === 'PLAN_RUNTIME_MISMATCH' && r.bytes === null,
                `${r.status}, bytes ${r.bytes}, mismatches ${JSON.stringify(r.mismatches)}`);
        }
        const control = await call('runtimeAuthority', 'unchanged', viaWorker);
        check(`${where}: unchanged bytes still merge under their own confirmation`,
            control.status === 'READY' && control.payloadA === false,
            `${control.status}, payload ${control.payloadA}`);
    }

    // ---- 47. RF-R4-6: the confirmation names the attachment ------------------
    console.log('\n=== 47. RF-R4-6 attachment identity before confirmation ===');
    const DISCLOSE = [
        [['r5-att-secret', 'merge-b'], ['r5-att-secret.pdf — secret-notes.txt'], ['M6R5_SECRET_PAYLOAD']],
        [['r5-att-unicode', 'merge-b'], ['r5-att-unicode.pdf — 図面メモ.txt'], ['M6R5_UNICODE_PAYLOAD']],
        [['r5-att-multi', 'merge-b'],
            ['r5-att-multi.pdf — a.txt', 'r5-att-multi.pdf — b.txt', 'r5-att-multi.pdf — c.txt'],
            ['M6R5_MULTI_A', 'M6R5_MULTI_B', 'M6R5_MULTI_C']],
        [['r5-att-unnamed', 'merge-b'], ['r5-att-unnamed.pdf — 名前のない添付ファイル'], ['M6R5_UNNAMED_PAYLOAD']],
    ];
    for (const [names, expected, markers] of DISCLOSE) {
        const d = await call('mergeDisclosure', names, markers);
        check(`${names[0]}: the confirmation names source and attachment before consent`,
            d.requires.includes('attachments') && sameJson([...d.gated].sort(), [...expected].sort()),
            JSON.stringify(d.gated));
        check(`${names[0]}: after consent the payload is gone`,
            d.status === 'READY' && Object.values(d.markers).every((present) => present === false),
            `${d.status}, ${JSON.stringify(d.markers)}`);
    }
    const unicodePlan = await call('plan', 'r5-att-unicode', [0]);
    check('Extract names the Unicode filename (/UF before /F) too',
        (unicodePlan.losses ?? []).some((l) => l.kind === 'attachments' && l.what === '図面メモ.txt'),
        JSON.stringify(unicodePlan.losses));

    // ---- 48. BLK-R4-1: Info strings, carried and constructed -----------------
    //
    // The same class, on the metadata path: M1 decoded the first source's Info
    // with pdf-lib, which reads a PDF 2.0 UTF-8 string as PDFDocEncoding, and
    // wrote the mojibake back through a setter. M4 and Extract's fallback title
    // write the person's filenames, and now go through the one text writer.
    console.log('\n=== 48. BLK-R4-1 Info strings ===');
    const INFO = { Title: '図面タイトル', Author: '(A) b\\c', Subject: '件名テスト', Creator: '•C' };
    const infoExtract = await call('fidelityExtract', 'r5-info-text', [0]);
    check('the source really holds the Info strings, as PDF.js reads them',
        sameJson(infoExtract.sources[0].info, INFO), JSON.stringify(infoExtract.sources[0].info));
    check('Extract carries every Info string as the text it was',
        syntaxHolds(infoExtract) && sameJson(infoExtract.output?.info, INFO),
        `${syntaxDetail(infoExtract)}, ${JSON.stringify(infoExtract.output?.info)}`);
    const infoM1 = await call('fidelityMerge', ['r5-info-text', 'merge-b'], { metadataPolicy: 'M1' });
    check('Merge M1 carries the first source\'s Info strings as the text they were',
        syntaxHolds(infoM1) && sameJson(infoM1.output?.info, INFO),
        `${syntaxDetail(infoM1)}, ${JSON.stringify(infoM1.output?.info)}`);
    const infoM1Fallback = await call('fidelityMerge', ['merge-b', 'r5-info-text'], { metadataPolicy: 'M1' });
    check('Merge M1 with an untitled first source titles it by its filename',
        syntaxHolds(infoM1Fallback) && infoM1Fallback.output?.info?.Title === 'merge-b.pdf',
        `${syntaxDetail(infoM1Fallback)}, ${JSON.stringify(infoM1Fallback.output?.info)}`);
    const infoM4 = await call('fidelityMerge', ['r5-info-text', 'merge-b'], { metadataPolicy: 'M4' });
    check('Merge M4 writes its provenance as the text it means',
        syntaxHolds(infoM4)
        && infoM4.output?.info?.Title === '2件のPDFを統合'
        && infoM4.output?.info?.Subject === '統合元: r5-info-text.pdf / merge-b.pdf'
        && infoM4.output?.info?.Creator === 'PDF ArchiTools — PDF統合',
        `${syntaxDetail(infoM4)}, ${JSON.stringify(infoM4.output?.info)}`);

    // ---- 49. RF-R5-1 the reconstruction plan survives a removal --------------
    //
    // A plan named an annotation by its position in `/Annots`; sanitization then
    // took another entry out of that array and every later position moved. The
    // shape that reaches it is ordinary — a widget carrying `/P` — and no
    // earlier fixture had one, because pdf-lib does not write `/P`.
    //
    // So the assertion is not the status. It is that the annotation which
    // survived is the one the plan was about, read by PDF.js, with its link
    // still reaching the page it named and its `/P` pointing into the output's
    // own page tree.
    console.log('\n=== 49. RF-R5-1 annotation plan stability ===');
    {
        const SHAPES = [
            { name: 'r6-sig-empty-p', keeps: [], note: 'an empty signature field carrying /P' },
            { name: 'r6-sig-applied-p', keeps: [], note: 'an applied signature carrying /P' },
            { name: 'r6-sig-then-link-p', keeps: [{ subtype: 'Link', target: 1 }], note: 'a link after the removed widget' },
            { name: 'r6-sig-then-tx-p', keeps: [{ subtype: 'Widget', fieldName: 'r6.kept' }], note: 'a text field after the removed widget' },
            { name: 'r6-sig-multi-then-link', keeps: [{ subtype: 'Link', target: 1 }], note: 'two removed widgets before a link' },
            { name: 'r6-link-then-sig', keeps: [{ subtype: 'Link', target: 1 }], note: 'a link before the removed widget' },
            { name: 'r6-annot-direct', keeps: [{ subtype: 'Link', target: 1 }], note: 'a link written directly into /Annots' },
        ];
        for (const shape of SHAPES) {
            const r = await call('annotPlanStability', shape.name, [0, 1], ['applied-signature']);
            const first = r.annots?.[0] ?? null;
            const kept = (first ?? []).map((a) => a.subtype);
            const wanted = shape.keeps.map((k) => k.subtype);
            const targetsOk = shape.keeps.every((k, i) => {
                const got = first?.[i];
                if (!got || got.subtype !== k.subtype) return false;
                if (k.target !== undefined && got.target !== k.target) return false;
                if (k.fieldName !== undefined && got.fieldName !== k.fieldName) return false;
                return true;
            });
            check(`${shape.name}: READY, and ${shape.note} is still the annotation the plan named`,
                r.status === 'READY'
                && r.boundary === 'PASS'
                && r.signatureRemnants === 0
                && r.payloadMarker === false
                && JSON.stringify(kept) === JSON.stringify(wanted)
                && targetsOk,
                `${r.status} boundary=${r.boundary} sigRemnants=${r.signatureRemnants} payload=${r.payloadMarker} `
                + `annots=${JSON.stringify(first)} unapplied=${JSON.stringify(r.unapplied)}`);
            check(`${shape.name}: every /P in the artifact points into its own page tree`,
                r.pageRefs !== null && r.pageRefs.dangling === 0 && r.unreachableObjects === 0,
                `${JSON.stringify(r.pageRefs)} unreachable=${r.unreachableObjects}`);
        }

        const control = await call('annotPlanStability', 'r6-annots-control', [0, 1], []);
        check('r6-annots-control: with nothing removed, both annotations survive unchanged',
            control.status === 'READY'
            && JSON.stringify((control.annots?.[0] ?? []).map((a) => a.subtype)) === '["Link","Widget"]'
            && control.annots?.[0]?.[0]?.target === 1
            && control.annots?.[0]?.[1]?.fieldName === 'r6.kept'
            && control.pageRefs?.dangling === 0,
            `${control.status} ${JSON.stringify(control.annots?.[0])}`);

        // The Merge door: the attachment annotation is removed after both plans.
        const merged = await call('annotPlanStabilityMerge',
            ['r6-att-annot-then-link', 'merge-b'], 'R6ATTACHPAYLOAD');
        check('Merge: a file-attachment annotation removed after planning does not move the link',
            merged.status === 'READY'
            && merged.annots?.[0]?.length === 1
            && merged.annots[0][0].subtype === 'Link'
            && merged.annots[0][0].target === 1
            && merged.pageRefs?.dangling === 0
            && merged.payloadMarker === false,
            `${merged.status} annots=${JSON.stringify(merged.annots?.[0])} `
            + `pageRefs=${JSON.stringify(merged.pageRefs)} payload=${merged.payloadMarker} `
            + `unapplied=${JSON.stringify(merged.unapplied)}`);
    }

    // ---- 50. RF-R5-2 a `/DA` that is there and cannot be read ----------------
    //
    // It was read as absent, which skipped the `/DR` dependency check — so a
    // field whose appearance needs a resource this reconstruction drops came
    // back READY. `/DA` is content-stream syntax, so the question is whether its
    // **bytes** read: `r6-da-hexbytes` is a readable byte string that happens to
    // look like UTF-16 and is not a refusal, which is what keeps this from being
    // a rule about text.
    console.log('\n=== 50. RF-R5-2 field /DA, present and unreadable ===');
    {
        const REFUSES = [
            ['r6-da-octal', 'an octal escape wider than a byte'],
            ['r6-da-name', 'a name object'],
            ['r6-da-number', 'a number'],
            ['r6-da-indirect-number', 'an indirect number'],
            ['r6-da-stream', 'a stream'],
        ];
        for (const [name, what] of REFUSES) {
            const r = await call('daEnvelope', name);
            check(`${name}: /DA that is ${what} is refused, not read as absent`,
                r.status === 'UNSUPPORTED_FORM'
                && r.bytes === false
                && r.intake === 'UNSUPPORTED_FORM'
                && r.outsideSubset.some((s) => s.includes('/DA')),
                `${r.status} intake=${r.intake} outside=${JSON.stringify(r.outsideSubset)}`);
        }
        const valid = await call('daEnvelope', 'r6-da-valid');
        check('r6-da-valid: a readable /DA naming a /DR font keeps the envelope it had',
            valid.status === 'UNSUPPORTED_FORM'
            && valid.outsideSubset.some((s) => s.includes('names /R6F from AcroForm /DR')),
            `${valid.status} ${JSON.stringify(valid.outsideSubset)}`);
        const absent = await call('daEnvelope', 'r6-da-absent');
        check('r6-da-absent: no /DA is still no /DA, and still supported',
            absent.status === 'READY' && absent.intake === 'ACCEPTED' && absent.outsideSubset.length === 0,
            `${absent.status} intake=${absent.intake} ${JSON.stringify(absent.outsideSubset)}`);
        const hexBytes = await call('daEnvelope', 'r6-da-hexbytes');
        check('r6-da-hexbytes: a /DA whose bytes read is not a refusal (it is syntax, not prose)',
            hexBytes.status === 'READY' && hexBytes.outsideSubset.length === 0,
            `${hexBytes.status} ${JSON.stringify(hexBytes.outsideSubset)}`);

        // The same anti-pattern, in the two readers next door.
        const dr = await call('daEnvelope', 'r6-dr-notdict');
        check('r6-dr-notdict: a /DR that cannot be listed is said so, not treated as empty',
            dr.status === 'UNSUPPORTED_FORM'
            && dr.outsideSubset.some((s) => s.includes('/DR is not a dictionary')),
            `${dr.status} ${JSON.stringify(dr.outsideSubset)}`);
        const kids = await call('daEnvelope', 'r6-kids-notarray');
        check('r6-kids-notarray: a /Kids that cannot be read is not a terminal field',
            kids.bytes === false && kids.readable === false,
            `${kids.status} readable=${kids.readable} ${JSON.stringify(kids.outsideSubset)}`);
    }

    // ---- 51. RF-R5-3 the remnant backstop reaches what the classifier does ----
    //
    // The artifact invariant claimed `signatureRemnants === 0` on a narrower
    // evidence set than `classifyField` decides an applied signature by. Aligned
    // now — and `/Contents` is context-aware, because a page's `/Contents` is its
    // content stream. Each fixture carries exactly one kind of evidence; two
    // carry `/Contents` where `/Contents` is ordinary.
    console.log('\n=== 51. RF-R5-3 signature remnant semantics ===');
    {
        const EVIDENCE = [
            ['r6-rem-ft-sig', 1, '/FT /Sig'],
            ['r6-rem-type-sig', 1, '/Type /Sig'],
            ['r6-rem-doctimestamp', 1, '/Type /DocTimeStamp'],
            ['r6-rem-byterange', 1, '/ByteRange'],
            ['r6-rem-contents-value', 1, 'a field value carrying /Contents'],
            ['r6-rem-widget-inherited', 2, 'a widget whose /FT /Sig is inherited'],
        ];
        for (const [name, want, what] of EVIDENCE) {
            const r = await call('signatureRemnantLayer', name);
            check(`${name}: ${what} is counted, by production and by this gate`,
                r.productionComplete === true
                && r.production === want
                && r.readbackRemnants === want
                && r.gate.count === want,
                `production=${r.production} readback=${r.readbackRemnants} gate=${r.gate.count} `
                + `reasons=${JSON.stringify(r.gate.reasons)}`);
        }
        for (const [name, what] of [
            ['r6-rem-page-contents', "a page's own /Contents"],
            ['r6-rem-dict-contents', 'an ordinary dictionary /Contents'],
            ['r6-rem-clean', 'an ordinary text field'],
        ]) {
            const r = await call('signatureRemnantLayer', name);
            check(`${name}: ${what} is not a signature (no false positive)`,
                r.productionComplete === true && r.production === 0
                && r.readbackRemnants === 0 && r.gate.count === 0,
                `production=${r.production} readback=${r.readbackRemnants} gate=${r.gate.count} `
                + `reasons=${JSON.stringify(r.gate.reasons)}`);
        }
        const refused = await call('signatureRemnantLayer', 'r6-rem-widget-dangling');
        probe('the remnant census refuses rather than counting zero it cannot prove',
            refused.productionComplete === false
            && refused.production === null
            && refused.readbackCensusComplete === false,
            `complete=${refused.productionComplete} reason=${refused.productionReason} `
            + `readback=${refused.readbackRemnants} censusComplete=${refused.readbackCensusComplete}`);
    }

    // ---- 52. R7-1 indirect stream /Length ------------------------------------
    //
    // A real published drawing reached readback with 18 unreachable objects,
    // every one of them a number a copied stream's `/Length` pointed at before
    // `save()` rewrote the key direct. The oracle below reads the written bytes
    // itself rather than believing the writer.
    console.log('\n=== 52. R7-1 indirect stream /Length ===');
    {
        const cases = [
            ['r7-len-indirect', [0], 1],
            ['r7-len-indirect-many', [0, 1, 2, 3, 4], 5],
            ['r7-len-mixed', [0, 1, 2, 3], 4],
            ['r7-len-stale', [0], 1],
            ['r7-len-shared', [0], 1],
        ];
        for (const [fixture, selection, pages] of cases) {
            const r = await call('r7Length', fixture, selection);
            check(`${fixture}: the fixture really declares /Length by reference`,
                r.sourceSerialized.indirectLengths > 0,
                `source indirect /Length ${r.sourceSerialized.indirectLengths}`);
            check(`${fixture}: READY with nothing left unreferenced`,
                r.status === 'READY' && r.unreachable === 0 && r.pageCount === pages,
                `${r.status} unreachable=${r.unreachable} pages=${r.pageCount}`);
            check(`${fixture}: no /Length survives as a reference in the artifact`,
                r.serialized.indirectLengths === 0, `${r.serialized.indirectLengths}`);
            check(`${fixture}: every serialized /Length equals its own stream bytes`,
                r.serialized.lengthMismatches === 0,
                `${r.serialized.lengthMismatches} mismatch(es) over ${r.serialized.streams} stream(s)`);
            check(`${fixture}: pdf.js opens the artifact`,
                r.pdfjs.ok && r.pdfjs.pages === pages, `${r.pdfjs.ok} pages=${r.pdfjs.pages}`);
        }

        // The direct control: unchanged behaviour, and it never had the defect.
        const direct = await call('r7Length', 'r7-len-direct', [0]);
        check('r7-len-direct: a direct /Length is unchanged and still READY',
            direct.status === 'READY' && direct.unreachable === 0
            && direct.sourceSerialized.indirectLengths === 0
            && direct.serialized.lengthMismatches === 0,
            `${direct.status} unreachable=${direct.unreachable}`);

        // The safety control: a number a second legitimate key still points at
        // must survive the sweep through that other reference.
        const shared = await call('r7Length', 'r7-len-shared', [0]);
        check('r7-len-shared: a length object another key still needs is kept',
            shared.userUnitLive === true, `userUnit live=${shared.userUnitLive}`);

        const merged = await call('r7MergeLength', ['r7-len-indirect', 'r7-len-indirect-many']);
        check('Merge: indirect lengths across sources leave no orphan either',
            merged.run === 'READY' && merged.unreachable === 0
            && merged.serialized.indirectLengths === 0
            && merged.serialized.lengthMismatches === 0,
            `${merged.run} unreachable=${merged.unreachable} pages=${merged.pageCount}`);
    }

    // ---- 53. R7-2 the narrow optional-content envelope -----------------------
    //
    // Adopted OC-A (a form XObject's `/OC` naming a registered group), OC-B (a
    // one-group `/OCMD`, canonicalized to that group), OC-C (`/D /AS`) and
    // OC-D (an empty `/D /RBGroups`). Every supported shape here has a refused
    // neighbour, and the artifact is asked what it says about itself.
    console.log('\n=== 53. R7-2 optional content: OC-A / OC-B / OC-C / OC-D ===');
    {
        const supported = [
            ['r7-oc-form-on', 'OC-A: a form /OC naming a registered group is carried'],
            ['r7-oc-form-off', 'OC-A: and carried when the group is off by default'],
            ['r7-oc-form-nested', 'OC-A: a nested form /OC is found and carried'],
            ['r7-ocmd-simple', 'OC-B: a one-group /OCMD with no /P and no /VE is carried'],
            ['r7-as-view', 'OC-C: /AS /View is preserved'],
            ['r7-as-print', 'OC-C: /AS /Print is preserved'],
            ['r7-as-export', 'OC-C: /AS /Export is preserved'],
            ['r7-as-multi', 'OC-C: several valid /AS entries are preserved'],
            ['r7-rb-empty', 'OC-D: an empty /RBGroups is preserved as empty'],
        ];
        for (const [fixture, what] of supported) {
            const r = await call('r7Oc', fixture, [0]);
            check(`${what}`,
                r.plan === 'READY' && r.run === 'READY' && r.unreachable === 0,
                `plan=${r.plan} run=${r.run} unreachable=${r.unreachable} `
                + `${r.reason ?? ''}${r.runReason ?? ''}${(r.unsupported || []).join(' | ')}`);
            if (r.output) {
                check(`${fixture}: the artifact registers the group its /OC names`,
                    r.output.ocProperties === true && r.output.outGroups >= 1
                    && r.output.danglingOc === 0,
                    `groups=${r.output.outGroups} ocOnForms=${r.output.ocOnForms} `
                    + `dangling=${r.output.danglingOc}`);
                check(`${fixture}: no /AS entry names a group the artifact lacks`,
                    r.output.asDangling === 0, `${r.output.asDangling}`);
                check(`${fixture}: pdf.js opens the artifact`,
                    r.pdfjs.ok === true, `${r.pdfjs.error ?? 'ok'}`);
            }
        }

        // OC-B specifically: the membership dictionary is gone, replaced by the
        // group, so the output's supported shapes stay the ones this reader can
        // prove rather than gaining an OCMD envelope.
        const ocmd = await call('r7Oc', 'r7-ocmd-simple', [0]);
        check('OC-B: the /OCMD is canonicalized away, leaving the group itself',
            ocmd.viaOcmd === 1 && ocmd.output.ocmdSurvivors === 0 && ocmd.output.outGroups === 1,
            `viaOcmd=${ocmd.viaOcmd} survivors=${ocmd.output.ocmdSurvivors} groups=${ocmd.output.outGroups}`);

        const asMulti = await call('r7Oc', 'r7-as-multi', [0]);
        check('OC-C: both /AS entries reach the artifact, order kept',
            asMulti.output.asEntries === 2, `${asMulti.output.asEntries}`);
        const rbEmpty = await call('r7Oc', 'r7-rb-empty', [0]);
        check('OC-D: /RBGroups is written back as the empty array, not omitted',
            rbEmpty.output.rbGroups === 0, `rbGroups=${rbEmpty.output.rbGroups}`);

        const refused = [
            ['r7-oc-unregistered', 'does not register', 'OC-A: an unregistered group stays refused'],
            ['r7-oc-dangling', 'which is not in the document', 'OC-A: a dangling /OC stays refused'],
            ['r7-oc-image', '/Image', 'OC-A: /OC on a non-form XObject stays refused'],
            ['r7-oc-annot', 'annotation 0 /OC', 'an annotation /OC stays refused'],
            ['r7-ocmd-ve', '/VE', 'OC-B: an /OCMD with /VE stays refused'],
            ['r7-ocmd-p', '/P', 'OC-B: an /OCMD with /P stays refused'],
            ['r7-ocmd-two', 'naming 2 groups', 'OC-B: an /OCMD with two groups stays refused'],
            ['r7-ocmd-malformed', 'not a reference to a group', 'OC-B: a malformed /OCGs stays refused'],
            ['r7-as-unmapped', 'no selected page uses', 'OC-C: /AS naming an unused group is refused'],
            ['r7-as-bad-category', '/Category', 'OC-C: a malformed /Category is refused'],
            ['r7-as-bad-event', '/Event', 'OC-C: an unsupported /Event is refused'],
            ['r7-as-extra-key', '/Intent', 'OC-C: an extra semantic key is refused'],
            ['r7-rb-nonempty', '/RBGroups with', 'OC-D: a non-empty /RBGroups stays refused'],
        ];
        for (const [fixture, fragment, what] of refused) {
            const r = await call('r7Oc', fixture, [0]);
            const said = (r.unsupported || []).join(' | ');
            check(what,
                r.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && said.includes(fragment),
                `${r.plan}: ${said.slice(0, 120)}`);
        }

        // The visibility oracle. This is the one that matters: the measured
        // failure was a copied `/OC` surviving into an artifact with no
        // `/OCProperties`, so pdf.js knew no groups, answered "visible" to
        // everything, and drew a layer the author had turned off.
        const on = await call('r7Visibility', 'r7-oc-form-on', [0]);
        check('visibility: a default-ON layer is painted in source and artifact alike',
            on.before.painted === true && on.after.painted === true
            && on.after.groupCount === 1,
            `before=${on.before.painted} after=${on.after.painted} groups=${on.after.groupCount}`);
        const off = await call('r7Visibility', 'r7-oc-form-off', [0]);
        check('visibility: a default-OFF layer stays hidden in the artifact',
            off.before.painted === false && off.after.painted === false
            && off.after.groupCount === 1,
            `before=${off.before.painted} after=${off.after.painted} `
            + `groups=${off.after.groupCount} pixel=${JSON.stringify(off.after.pixel)}`);
        probe('the OFF fixture would show the defect if /OCProperties were dropped',
            off.before.painted === false && off.after.groupCount > 0,
            `pdf.js sees ${off.after.groupCount} group(s) in the artifact`);
    }

    // ---- 54. BLK-R7-A: one object, more than one resource edge ---------------
    //
    // The walker answered "have I seen this object" before it answered "what
    // does `/OC` mean on this edge", so a form first met through a `/Pattern`
    // or a Type 3 `/CharProcs` was marked and its later `/XObject` edge
    // returned before reading `/OC`. Neither carried nor refused, the group
    // stayed out of `/OCProperties` while the copied `/OC` stayed live, and a
    // layer the author had switched **off** drew in the artifact. Every fixture
    // below is default-OFF, so the old behaviour is a visible flip.
    console.log('\n=== 54. BLK-R7-A edge-local /OC classification ===');
    {
        const carried = [
            ['r8-alias-pattern', [0], 'a form aliased into /Pattern is still classified through /XObject'],
            ['r8-alias-charprocs', [0], 'a form aliased into a Type 3 /CharProcs is still classified'],
            ['r8-alias-xobject-first', [0], 'the valid edge first is unchanged'],
            ['r8-alias-two-keys', [0], 'one form under two /XObject keys'],
            ['r8-alias-two-pages', [0, 1], 'one form used by two pages'],
            ['r8-alias-nested', [0], 'a nested form that is also a /Pattern alias'],
            ['r8-alias-cycle', [0], 'a resource graph that loops'],
        ];
        for (const [fixture, selection, title] of carried) {
            const r = await call('r7Oc', fixture, selection);
            check(`${fixture}: ${title}`,
                r.plan === 'READY' && r.run === 'READY' && r.unreachable === 0,
                `plan ${r.plan} run ${r.run} unreachable ${r.unreachable} `
                + `${(r.unsupported || []).join(' | ')}`);
            if (!r.output) continue;
            check(`${fixture}: the edge was found, not skipped`,
                r.usages >= 1, `usages=${r.usages}`);
            check(`${fixture}: the artifact registers the group its /OC names`,
                r.output.ocProperties === true && r.output.outGroups >= 1
                && r.output.danglingOc === 0,
                `ocProperties=${r.output.ocProperties} groups=${r.output.outGroups} `
                + `dangling=${r.output.danglingOc}`);
            check(`${fixture}: however many edges name it, one group is registered`,
                r.output.outGroups === 1, `outGroups=${r.output.outGroups} usages=${r.usages}`);
            check(`${fixture}: the output census agrees the artifact holds together`,
                r.oc !== null && r.oc.danglingUses === 0 && r.oc.unregisteredUses === 0
                && r.oc.ocmdSurvivors === 0 && r.oc.configErrors === 0,
                JSON.stringify(r.oc));
        }

        // The soft mask's `/G` is an `/OC` position nothing has shown how to
        // rebuild, so finding it on every edge means finding it, not carrying it.
        const smask = await call('r7Oc', 'r8-alias-smask', [0]);
        const saidSmask = (smask.unsupported || []).join(' | ');
        check('r8-alias-smask: an /OC reached only through a soft mask still fails closed',
            smask.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && saidSmask.includes('/SMask /G /OC'),
            `${smask.plan} :: ${saidSmask}`);
        check('r8-alias-smask: and publishes nothing', smask.run === null, `run=${smask.run}`);

        // The whole point, measured where it shows: on the page.
        for (const fixture of ['r8-alias-pattern', 'r8-alias-charprocs', 'r8-alias-nested']) {
            const v = await call('r7Visibility', fixture, [0]);
            check(`${fixture}: the switched-off layer is hidden in source and artifact alike`,
                v.before.painted === false && v.after !== null && v.after.painted === false
                && v.after.groupCount === 1,
                `before=${v.before.painted} after=${v.after && v.after.painted} `
                + `groups=${v.after && v.after.groupCount} pixel=${JSON.stringify(v.after && v.after.pixel)}`);
        }
        const aliasProbe = await call('r7Visibility', 'r8-alias-pattern', [0]);
        probe('the alias fixture really does hide its layer to begin with',
            aliasProbe.before.painted === false && aliasProbe.before.groupCount === 1,
            `source groups=${aliasProbe.before.groupCount} painted=${aliasProbe.before.painted}`);
    }

    // ---- 55. BLK-R7-B: a page property must name a registered group ----------
    //
    // A group the source leaves out of `/OCProperties /OCGs` has no
    // configuration in the source — a viewer that cannot find it draws the
    // content. Carrying it, registering it in the output and then applying the
    // source's `/D /OFF` to it gave the layer a meaning the source never had,
    // and content the author could see disappeared from the artifact.
    console.log('\n=== 55. BLK-R7-B page /Properties source registration ===');
    {
        for (const [fixture, title] of [
            ['r8-props-registered-on', 'a registered group, on'],
            ['r8-props-registered-off', 'a registered group, off'],
        ]) {
            const r = await call('r7Oc', fixture, [0]);
            check(`${fixture}: ${title} is carried as before`,
                r.plan === 'READY' && r.run === 'READY' && r.unreachable === 0,
                `${r.plan}/${r.run} ${(r.unsupported || []).join(' | ')}`);
            if (r.output) {
                check(`${fixture}: the artifact registers exactly the source's group`,
                    r.output.ocProperties === true && r.output.outGroups === 1,
                    `groups=${r.output.outGroups}`);
            }
            const v = await call('r7Visibility', fixture, [0]);
            check(`${fixture}: source and artifact show the same thing`,
                v.after !== null && v.before.painted === v.after.painted,
                `before=${v.before.painted} after=${v.after && v.after.painted}`);
        }

        for (const [fixture, fragment, title] of [
            ['r8-props-unregistered-on', 'does not register', 'an unregistered group, on'],
            ['r8-props-unregistered-off', 'does not register', 'an unregistered group, off'],
            ['r8-props-dangling', 'is not a dictionary', 'a property that points at nothing'],
            ['r8-props-wrongtype', 'is /Annot', 'a property that is not a group'],
            ['r8-props-direct', 'directly rather than by reference', 'a group written inline'],
        ]) {
            const r = await call('r7Oc', fixture, [0]);
            const said = (r.unsupported || []).join(' | ');
            check(`${fixture}: ${title} is refused, and says why`,
                r.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && said.includes(fragment),
                `${r.plan} :: ${said}`);
            check(`${fixture}: and publishes nothing`, r.run === null, `run=${r.run}`);
        }
    }

    // ---- 56. RF-R8-1: the artifact proves its own optional content -----------
    //
    // Discovery decides what may be carried; this decides whether what was
    // carried holds together, over every indirect object rather than over the
    // resource graph. A future missed edge must not be able to become READY
    // plus a live `/OC` plus an incomplete `/OCProperties` ever again — so the
    // documents below are artifact shapes this tool would never write, handed
    // straight to the census.
    console.log('\n=== 56. RF-R8-1 artifact-wide optional content invariant ===');
    {
        const clean = [
            ['r8-art-none', 'an artifact with no optional content at all'],
            ['r8-art-ok', 'an artifact whose /OC names a registered group'],
            ['r8-art-control', 'keys that merely begin like /OC are not /OC'],
        ];
        for (const [fixture, title] of clean) {
            const r = await call('r8Census', fixture);
            check(`${fixture}: ${title} passes`,
                r.complete === true && r.invariant === null
                && r.value.danglingUses === 0 && r.value.unregisteredUses === 0
                && r.value.ocmdSurvivors === 0 && r.value.configErrors === 0,
                `complete=${r.complete} invariant=${r.invariant} ${JSON.stringify(r.value)}`);
        }
        check('r8-art-ok: the census saw the use it should have seen',
            (await call('r8Census', 'r8-art-ok')).value.uses === 1);
        check('r8-art-control: an unrelated key is not counted as a use',
            (await call('r8Census', 'r8-art-control')).value.uses === 0);

        const violations = [
            ['r8-art-no-ocprops', 'optionalContentUnregisteredUses === 0',
                'a live /OC with no /OCProperties at all — BLK-R7-A’s own output'],
            ['r8-art-unregistered', 'optionalContentUnregisteredUses === 0',
                'a live /OC naming a group the artifact does not register'],
            ['r8-art-dangling', 'optionalContentDanglingUses === 0',
                'a live /OC naming nothing'],
            ['r8-art-ocmd', 'optionalContentOcmdSurvivors === 0',
                'a membership dictionary that survived into the output'],
            ['r8-art-on-unregistered', 'optionalContentConfigErrors === 0',
                '/ON naming a group the artifact does not register'],
            ['r8-art-off-unregistered', 'optionalContentConfigErrors === 0',
                '/OFF naming a group the artifact does not register'],
            ['r8-art-order-unregistered', 'optionalContentConfigErrors === 0',
                '/Order naming a group the artifact does not register'],
            ['r8-art-as-unregistered', 'optionalContentConfigErrors === 0',
                '/AS naming a group the artifact does not register'],
            ['r8-art-rbgroups', 'optionalContentConfigErrors === 0',
                'a non-empty /RBGroups, which this output never writes'],
        ];
        for (const [fixture, invariant, title] of violations) {
            const r = await call('r8Census', fixture);
            check(`${fixture}: ${title} is refused`,
                r.complete === true && r.invariant === invariant,
                `complete=${r.complete} invariant=${r.invariant} ${JSON.stringify(r.value)}`);
            check(`${fixture}: the refusal names what it found`,
                r.invariantReason !== null && r.value.detail.length > 0,
                JSON.stringify(r.value && r.value.detail));
        }

        // A configuration the proof needs and cannot read is a refusal, not a
        // clean count. There is no truncated-then-zero state here either.
        const malformed = await call('r8Census', 'r8-art-malformed');
        check('r8-art-malformed: an unreadable configuration refuses rather than counts',
            malformed.complete === false && malformed.censusComplete === false
            && malformed.invariant === 'every artifact census is complete',
            `complete=${malformed.complete} invariant=${malformed.invariant} ${malformed.reason}`);

        // The two scopes discovery cannot reach: nesting below an object's own
        // keys, and an object no page walk visits at all.
        const nested = await call('r8Census', 'r8-art-nested-oc');
        check('r8-art-nested-oc: an /OC nested in a direct dictionary is found',
            nested.complete === true && nested.value.uses === 1
            && nested.value.unregisteredUses === 1,
            JSON.stringify(nested.value));
        const detached = await call('r8Census', 'r8-art-detached-oc');
        check('r8-art-detached-oc: an /OC on an object no page reaches is found',
            detached.complete === true && detached.value.uses === 1
            && detached.value.unregisteredUses === 1,
            JSON.stringify(detached.value));

        // The gate's own reader, sharing no code with the census it checks.
        for (const [fixture, expectDangling] of [['r8-art-no-ocprops', 1], ['r8-art-ok', 0]]) {
            const r = await call('r8Census', fixture);
            check(`${fixture}: the raw reader and the census agree`,
                r.raw.danglingOc === expectDangling,
                `raw danglingOc=${r.raw.danglingOc} census unregistered=${r.value && r.value.unregisteredUses}`);
        }

        probe('the backstop would have caught BLK-R7-A before the walker was fixed',
            (await call('r8Census', 'r8-art-no-ocprops')).invariant
                === 'optionalContentUnregisteredUses === 0');
    }

    // ---- 57. BLK-R8R-1: `/EF` is evidence, not authority to delete ----------
    //
    // The remover used to treat any dictionary with `/EF` as a file
    // specification and delete everything an `/EF` named, then every reference
    // to it. READY, under a confirmation that named only "an attachment": a
    // switched-off layer drawn, a drawing gone, a page blank. Every expectation
    // below is read off the picture pdf.js paints and the gate's own walkers,
    // not only off the status.
    console.log('\n=== 57. BLK-R8R-1 attachment semantic safety ===');
    {
        const LAYER = [{ x: 100, y: 100 }];
        const unsafe = [
            ['r9-v1-ocg-ef', 'an optional-content group that carries /EF', 'M6R9_V1_PAYLOAD'],
            ['r9-v2-form-oc-ocg-ef', 'the group a form /OC names, carrying /EF', 'M6R9_V2_PAYLOAD'],
            ['r9-v5-ocprops-direct-ef', 'a direct /OCProperties carrying /EF', 'M6R9_V5_PAYLOAD'],
            ['r9-v6-ocprops-indirect-ef', 'an indirect /OCProperties carrying /EF', 'M6R9_V6_PAYLOAD'],
            ['r9-v7-ocprops-ef-form', '/OCProperties with /EF over a form /OC', 'M6R9_V7_PAYLOAD'],
            ['r9-w1-ef-form', 'an /EF /F naming the form the page draws', null],
            ['r9-w2-ef-contents', "an /EF /F naming the page's own content stream", null],
            ['r9-w5-shared-nonattachment', 'a payload page private data also names', 'M6R9_W5_PAYLOAD'],
        ];
        for (const [fixture, title] of unsafe) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            check(`${fixture}: ${title} is refused in planning, before any confirmation`,
                r.plan === 'UNSAFE_ATTACHMENT_STRUCTURE' && r.requires.length === 0,
                `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: and Extract publishes nothing`,
                r.run === 'UNSAFE_ATTACHMENT_STRUCTURE' && r.bytes === null,
                `run=${r.run} bytes=${r.bytes}`);
            const why = (r.planDetail && r.planDetail.unsafe) || [];
            check(`${fixture}: the refusal names what it would have destroyed`,
                why.length > 0, JSON.stringify(why).slice(0, 180));
        }
        // What the source looks like, so "no output" is compared with something.
        for (const [fixture, expected] of [
            ['r9-v1-ocg-ef', 'white'], ['r9-v5-ocprops-direct-ef', 'white'], ['r9-w1-ef-form', 'blue'],
        ]) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            probe(`${fixture}: the source really ${expected === 'white' ? 'hides' : 'draws'} what the old remover changed`,
                r.before[0] === expected, `source=${r.before[0]}`);
        }

        // Merge: the source is refused at intake by name (M6-H10), and nothing
        // of it reaches the output — not its layer, not its payload.
        for (const [fixture, marker] of [
            ['r9-v1-ocg-ef', 'M6R9_V1_PAYLOAD'], ['r9-v5-ocprops-direct-ef', 'M6R9_V5_PAYLOAD'],
            ['r9-v6-ocprops-indirect-ef', 'M6R9_V6_PAYLOAD'], ['r9-v7-ocprops-ef-form', 'M6R9_V7_PAYLOAD'],
            ['r9-w1-ef-form', null], ['r9-w2-ef-contents', null],
        ]) {
            const m = await call('r9Merge', [fixture, 'merge-b'], null, marker ? [marker] : []);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: Merge intake refuses the source by name`,
                verdict && verdict.result === 'UNSAFE_ATTACHMENT_STRUCTURE', JSON.stringify(m.intake));
            // `merge-b` carries no optional content and no payload, so any layer
            // or payload in the output could only have come from the refused one.
            check(`${fixture}: and the source is not in what the Merge writes`,
                !m.order.includes(fixture)
                && (m.bytes === null || (m.audit.ocKeys === 0 && m.audit.propsOc === 0
                    && m.audit.registered === 0 && (!marker || m.markers[marker] === false))),
                `run=${m.run} pages=${m.pages} order=${m.order.join(',')} audit=${JSON.stringify(m.audit)}`);
            const alone = await call('r9Merge', [fixture], null, []);
            check(`${fixture}: a Merge of that source alone produces nothing`,
                alone.bytes === null, `plan=${alone.plan} run=${alone.run}`);
        }

        // Controls: the attachment shapes this contract always removed stay
        // removable, and removing them changes nothing a reader sees.
        const controls = [
            ['r9-w0-valid', 'an ordinary /EmbeddedFiles attachment', 'M6R9_W0_PAYLOAD'],
            ['r9-w3-typeless-tree', 'a typeless file specification the tree proves', 'M6R9_W3_PAYLOAD'],
            ['r9-w4-shared-payload', 'one payload, two attachment specifications', 'M6R9_W4_PAYLOAD'],
            ['r9-w6-indirect-annots', 'a file-attachment annotation in an indirect /Annots', 'M6R9_W6_PAYLOAD'],
        ];
        for (const [fixture, title, marker] of controls) {
            const r = await call('r9Extract', fixture, [0], LAYER, [marker]);
            check(`${fixture}: ${title} still asks for the attachment confirmation`,
                r.plan === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION' && r.requires.includes('attachments'),
                `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: once confirmed it is READY and the payload is gone from the bytes`,
                r.run === 'READY' && r.markers[marker] === false && r.sourceMarkers[marker] === true,
                `run=${r.run} marker=${JSON.stringify(r.markers)}`);
            check(`${fixture}: no /EF, payload or file-attachment annotation survives`,
                r.independent && r.independent.efCarriers === 0 && r.independent.embeddedFileStreams === 0
                && r.independent.fileAttachmentAnnots === 0,
                JSON.stringify(r.independent && {
                    ef: r.independent.efCarriers, payload: r.independent.embeddedFileStreams,
                    annots: r.independent.fileAttachmentAnnots,
                }));
            check(`${fixture}: and the page draws exactly what the source drew`,
                r.after && r.after[0] === r.before[0] && r.before[0] === 'blue',
                `before=${r.before} after=${r.after}`);
        }
        const merged = await call('r9Merge', ['r9-w0-valid', 'merge-b'], null, ['M6R9_W0_PAYLOAD']);
        check('r9-w0-valid: Merge still removes a proven attachment after confirmation',
            merged.run === 'READY' && merged.markers.M6R9_W0_PAYLOAD === false
            && merged.independent.efCarriers === 0,
            `run=${merged.run} markers=${JSON.stringify(merged.markers)}`);
    }

    // ---- 58. RF-R9-1: a sanitizer may not change the optional content -------
    //
    // An artifact that holds together can still be the wrong one. Signature
    // removal deleting an object that was also the switched-off group left the
    // old Extract carrying nothing — READY, the layer drawn. The fix compares
    // the source's optional-content semantics before and after every
    // destructive step, and refuses on any difference.
    console.log('\n=== 58. RF-R9-1 source optional-content semantic equality ===');
    {
        const LAYER = [{ x: 100, y: 100 }];
        for (const fixture of ['r9-h1-sig-ocg-marked', 'r9-h2-sig-ocg-form']) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            check(`${fixture}: Extract refuses when sanitization changes the optional content`,
                r.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && r.run === 'UNSUPPORTED_OPTIONAL_CONTENT'
                && r.bytes === null,
                `plan=${r.plan} run=${r.run}`);
            check(`${fixture}: and says it was the sanitization that did it`,
                r.planDetail && r.planDetail.stage === 'after-sanitization',
                JSON.stringify(r.planDetail));
            probe(`${fixture}: the source hides the layer the old Extract drew`,
                r.before[0] === 'white', `source=${r.before[0]}`);
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            check(`${fixture}: Merge refuses it after sanitizing the source, before any copy`,
                m.run === 'UNSUPPORTED_OPTIONAL_CONTENT' && m.bytes === null
                && m.runDetail && m.runDetail.stage === 'after-sanitization',
                `run=${m.run} detail=${JSON.stringify(m.runDetail)}`);
        }

        // The comparator itself, on real before/after readings of one document.
        const mutations = [
            ['r9-onoff-off', 'drop-off', 'off'],
            ['r9-onoff-neither', 'add-on', 'on'],
            ['r9-onoff-off', 'drop-property', 'pageProperties'],
            ['r9-onoff-off', 'rename-group', 'groups'],
            ['r9-onoff-off', 'basestate', 'baseState'],
            ['r9-v7-ocprops-ef-form', 'drop-form-oc', 'xobjectUsages'],
        ];
        for (const [fixture, mutation, field] of mutations) {
            const r = await call('r9OcVerify', fixture, mutation);
            check(`comparator: ${mutation} is a mismatch, and names ${field}`,
                r.verdict && r.verdict.status === 'PLAN_RUNTIME_MISMATCH'
                && r.verdict.detail.changed.includes(field),
                JSON.stringify(r.verdict));
        }
        const unchanged = await call('r9OcVerify', 'r9-onoff-off', 'none');
        check('comparator: an untouched document is equal to itself, deterministically',
            unchanged.verdict === null && unchanged.deterministic === true, JSON.stringify(unchanged));

        // Controls: documents whose sanitization touches nothing optional stay READY.
        for (const fixture of ['r9-onoff-off', 'r9-w0-valid']) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            check(`${fixture}: an unchanged configuration passes the comparison`,
                r.run === 'READY' && r.after[0] === r.before[0], `run=${r.run} before=${r.before} after=${r.after}`);
        }
    }

    // ---- 59. RF-R9-2: one group in /ON and /OFF ----------------------------
    //
    // Human decision: outside the support envelope. Neither side is chosen,
    // pdf.js's own winner (/OFF) is not relied on, and nothing is normalised.
    console.log('\n=== 59. RF-R9-2 /ON-/OFF overlap ===');
    {
        const LAYER = [{ x: 100, y: 100 }];
        for (const [fixture, expected] of [
            ['r9-onoff-on', 'blue'], ['r9-onoff-off', 'white'], ['r9-onoff-neither', 'blue'],
            ['r9-onoff-dup-on', 'blue'], ['r9-onoff-dup-off', 'white'],
        ]) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            check(`${fixture}: carried, and the layer looks the same`,
                r.run === 'READY' && r.before[0] === expected && r.after[0] === expected,
                `run=${r.run} before=${r.before} after=${r.after}`);
            check(`${fixture}: the artifact lists no group in both /ON and /OFF`,
                r.audit && r.audit.onOffOverlap === 0, JSON.stringify(r.audit));
        }
        for (const fixture of ['r9-onoff-both', 'r9-onoff-multi']) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            const d = await call('r9Describe', fixture, [0]);
            check(`${fixture}: a group in both /ON and /OFF is refused`,
                r.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && r.run === 'UNSUPPORTED_OPTIONAL_CONTENT'
                && r.bytes === null,
                `plan=${r.plan} run=${r.run}`);
            check(`${fixture}: and the reason is the overlap, not something else`,
                d.unsupported.some((u) => u.includes('/D /ON and /D /OFF both list')),
                d.unsupported.join(' | '));
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            check(`${fixture}: Merge refuses the source at intake`,
                m.intake.find((i) => i.name === fixture).result === 'UNSUPPORTED_OPTIONAL_CONTENT',
                JSON.stringify(m.intake));
        }
        const artifact = await call('r9Census', 'r9-art-p13-onoff-overlap');
        check('r9-art-p13-onoff-overlap: an artifact with the overlap is a configuration violation',
            artifact.invariant === 'optionalContentConfigErrors === 0' && artifact.audit.onOffOverlap === 1,
            `invariant=${artifact.invariant} audit=${JSON.stringify(artifact.audit)}`);
    }

    // ---- 60. RF-R8R-1: the marked-content channel and the full envelope -----
    //
    // `/OC /MC0 BDC` names its group through `/Properties` and holds no `/OC`
    // key, so the Round 8 census never saw it. And a census that checks only
    // references lets a configuration this tool never writes through.
    console.log('\n=== 60. RF-R8R-1 artifact /Properties channel and envelope ===');
    {
        const cases = [
            ['r9-art-p1-props-registered', null, 'a page property naming a registered group'],
            ['r9-art-p2-props-unregistered', 'optionalContentUnregisteredUses === 0', 'a page property naming an unregistered group'],
            ['r9-art-p3-props-dangling', 'optionalContentDanglingUses === 0', 'a page property naming nothing'],
            ['r9-art-p4-props-ocmd', 'optionalContentOcmdSurvivors === 0', 'a page property naming a membership dictionary'],
            ['r9-art-p5-prefix-props-direct', 'optionalContentUnregisteredUses === 0', "b76bda8's real r8-props-direct artifact"],
            ['r9-art-p6-props-ordinary', null, 'an ordinary, non-optional property list'],
            ['r9-art-p7-as-event', 'optionalContentConfigErrors === 0', 'an /AS event this output never writes'],
            ['r9-art-p8-as-category', 'optionalContentConfigErrors === 0', 'an /AS category that is not a name'],
            ['r9-art-p9-as-extra-key', 'optionalContentConfigErrors === 0', 'an /AS entry with an extra key'],
            ['r9-art-p10-basestate-off', 'optionalContentConfigErrors === 0', 'a /BaseState other than /ON'],
            ['r9-art-p11-configs', 'optionalContentConfigErrors === 0', 'an /OCProperties /Configs'],
            ['r9-art-p12-locked', 'optionalContentConfigErrors === 0', 'a /D /Locked'],
            ['r9-art-envelope-ok', null, 'the whole supported envelope at once'],
        ];
        for (const [fixture, invariant, title] of cases) {
            const r = await call('r9Census', fixture);
            check(`${fixture}: ${title} ${invariant ? 'is refused' : 'passes'}`,
                r.complete === true && r.invariant === invariant,
                `invariant=${r.invariant} value=${JSON.stringify(r.value)}`);
        }
        // The gate's own audit agrees, field by field.
        const audit = async (fixture) => (await call('r9Census', fixture)).audit;
        check('raw audit: the unregistered page property is unregistered', (await audit('r9-art-p2-props-unregistered')).propsBad === 1);
        check('raw audit: the dangling page property dangles', (await audit('r9-art-p3-props-dangling')).propsDangling === 1);
        check('raw audit: the membership dictionary is one', (await audit('r9-art-p4-props-ocmd')).propsOcmd === 1);
        check("raw audit: b76bda8's artifact names a group written directly", (await audit('r9-art-p5-prefix-props-direct')).propsBad === 1);
        check('raw audit: the ordinary property list is not optional content', (await audit('r9-art-p6-props-ordinary')).propsOc === 0);
        check('raw audit: the bad /AS entries are bad', (await audit('r9-art-p7-as-event')).asBad === 1
            && (await audit('r9-art-p8-as-category')).asBad === 1 && (await audit('r9-art-p9-as-extra-key')).asBad === 1);
        check('raw audit: /BaseState, /Configs and /Locked are outside the envelope',
            (await audit('r9-art-p10-basestate-off')).baseStateBad === true
            && (await audit('r9-art-p11-configs')).ocPropsExtraKeys.includes('/Configs')
            && (await audit('r9-art-p12-locked')).dExtraKeys.includes('/Locked'));
        const p2 = await call('r9Census', 'r9-art-p2-props-unregistered');
        probe('the unregistered page property really draws the layer the census refuses',
            p2.raster[0] === 'blue', `raster=${p2.raster}`);
        const p1 = await call('r9Census', 'r9-art-p1-props-registered');
        check('r9-art-p1-props-registered: the census counts the marked-content use it passed',
            p1.value.propertyUses === 1 && p1.raster[0] === 'white', `value=${JSON.stringify(p1.value)} raster=${p1.raster}`);
    }

    // ---- 61. RF-R8R-2: a node analysis is reused only where it is context-free
    //
    // A shared parent's CHILD carrying `/OC` is refused under a scope-only role
    // and carried under `/XObject`. Expanding the parent once, for whoever came
    // first, let a key order turn the refusal into READY. Now each order must
    // give the same answer, for the same reason.
    console.log('\n=== 61. RF-R8R-2 context-sensitive nested walk ===');
    {
        const LAYER = [{ x: 100, y: 100 }];
        for (const role of ['pattern', 'charprocs', 'smask']) {
            const a = await call('r9Extract', `r9-nest-${role}-alias-first`, [0], LAYER);
            const b = await call('r9Extract', `r9-nest-${role}-xobject-first`, [0], LAYER);
            const da = await call('r9Describe', `r9-nest-${role}-alias-first`, [0]);
            const db = await call('r9Describe', `r9-nest-${role}-xobject-first`, [0]);
            const reason = (d) => d.unsupported.some((u) => /\/XObject \/C1 \/OC$/.test(u));
            check(`${role}: both dictionary orders give the same answer`,
                a.plan === b.plan && a.run === b.run && a.bytes === b.bytes,
                `alias-first=${a.plan}/${a.run} xobject-first=${b.plan}/${b.run}`);
            check(`${role}: the answer is the refusal, in both orders, with no bytes`,
                a.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && b.plan === 'UNSUPPORTED_OPTIONAL_CONTENT'
                && a.bytes === null && b.bytes === null);
            check(`${role}: for the same reason — the child's /OC under a scope-only role`,
                reason(da) && reason(db), `${da.unsupported.join(' | ')} || ${db.unsupported.join(' | ')}`);
        }

        // Shared parents whose every alias must stay right.
        const CXT = [{ x: 15, y: 15 }, { x: 50, y: 50 }, { x: 115, y: 115 }, { x: 150, y: 150 }];
        const cxt = [
            ['r9-cxt1-shared-parent', ['red', 'white', 'red', 'white'], 'a shared parent under /A and /B, layer off'],
            ['r9-cxt1-shared-parent-on', ['red', 'blue', 'red', 'blue'], 'the same, layer on'],
            ['r9-cxt3-same-names', ['red', 'white', 'red', 'blue'], 'one child name under two parents, two groups'],
        ];
        for (const [fixture, expected, title] of cxt) {
            const r = await call('r9Extract', fixture, [0], CXT);
            check(`${fixture}: ${title} is carried`, r.run === 'READY', `run=${r.run}`);
            check(`${fixture}: every alias draws what the source draws`,
                JSON.stringify(r.before) === JSON.stringify(expected)
                && JSON.stringify(r.after) === JSON.stringify(expected),
                `before=${r.before} after=${r.after}`);
            check(`${fixture}: every group the artifact uses is registered`,
                r.audit.ocBad === 0 && r.audit.ocKeys >= 1, JSON.stringify(r.audit));
        }
        const pages = await call('r9Extract', 'r9-cxt2-two-pages', [0, 1],
            [{ page: 1, x: 50, y: 50 }, { page: 2, x: 50, y: 50 }]);
        check('r9-cxt2-two-pages: one shared parent on two pages stays hidden on both',
            pages.run === 'READY' && JSON.stringify(pages.after) === JSON.stringify(['white', 'white']),
            `run=${pages.run} after=${pages.after}`);
        const scopeA = await call('r9Extract', 'r9-cxt4-scope-alias-alias-first', [0], CXT);
        const scopeB = await call('r9Extract', 'r9-cxt4-scope-alias-xobject-first', [0], CXT);
        check('r9-cxt4: a scope-only alias beside two valid ones refuses in both orders',
            scopeA.plan === 'UNSUPPORTED_OPTIONAL_CONTENT' && scopeB.plan === 'UNSUPPORTED_OPTIONAL_CONTENT'
            && scopeA.bytes === null && scopeB.bytes === null,
            `a=${scopeA.plan} b=${scopeB.plan}`);
        const cycle = await call('r9Extract', 'r9-cxt5-cycle', [0], LAYER);
        const cycleUses = await call('r9Describe', 'r9-cxt5-cycle', [0]);
        check('r9-cxt5-cycle: a looping graph completes, and the layer stays hidden',
            cycle.run === 'READY' && cycle.after[0] === 'white' && cycle.audit.ocBad === 0,
            `run=${cycle.run} after=${cycle.after}`);
        check('r9-cxt5-cycle: every usage names the one source form it found',
            cycleUses.usages.length > 0 && new Set(cycleUses.usages.map((u) => u.formRef)).size === 1,
            JSON.stringify(cycleUses.usages));
    }

    // ---- 62. Round 9 / J: `/JS` is evidence, not authority to empty ---------
    //
    // The JavaScript counterpart of BLK-R8R-1, found while closing it: a form
    // XObject a page draws, carrying a stray `/JS`, had its stream dictionary
    // emptied by the scrub — READY, drawing gone, nothing reported.
    console.log('\n=== 62. Round 9 JavaScript carrier safety ===');
    {
        const LAYER = [{ x: 100, y: 100 }];
        for (const [fixture, title] of [
            ['r9-j1-ocg-js', 'a group carrying /JS'],
            ['r9-j2-form-js', 'a drawn form XObject carrying /JS'],
            ['r9-j3-page-js', 'a page carrying /S /JavaScript'],
        ]) {
            const r = await call('r9Extract', fixture, [0], LAYER);
            check(`${fixture}: ${title} is refused rather than emptied`,
                r.run === 'UNSAFE_JAVASCRIPT_STRUCTURE' && r.bytes === null,
                `plan=${r.plan} run=${r.run}`);
            // Round 10 moved this refusal from the run to intake (RF-R10-1),
            // so the Merge now excludes the source by name under the adopted
            // H10 partial-merge rule rather than failing after the copy. The
            // assertion is the stronger one either way: the unsafe source is
            // named, and nothing of it is in what the Merge writes.
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: and the Merge refuses the source at intake, by name`,
                Boolean(verdict) && verdict.result === 'UNSAFE_JAVASCRIPT_STRUCTURE',
                `intake=${verdict ? verdict.result : 'missing'}`);
            check(`${fixture}: and the source is not in what the Merge writes`,
                !m.order.includes(fixture), `order=${m.order.join(',')}`);
        }
        const j2 = await call('r9Extract', 'r9-j2-form-js', [0], LAYER);
        probe('r9-j2-form-js: the source draws the form the old scrub erased', j2.before[0] === 'blue');
    }

    // ---- 63. BLK-R9R-1: a carrier is proven an action, not assumed to be one -
    //
    // Round 9 asked what contradicted "action" — a stream, a `/Type` that is not
    // `/Action`, a `/Subtype`. Most PDF dictionaries declare none of those, so
    // the class stayed open: a typeless graphics state, a typeless transparency
    // group and an ordinary marked-content property list each carried a stray
    // `/JS`, each was deleted as "the script", and each left its reference
    // behind. Measured at 0a30302: READY, losses empty, and the page drew
    // differently. The question is now positive — what says it IS an action —
    // and it is asked of the carrier's own shape and of every reference that
    // reaches it.
    console.log('\n=== 63. Round 10 JavaScript carrier ownership ===');
    {
        const SQUARE = [{ x: 100, y: 100 }];

        // ---- the carriers the old test let through, and the boundary it caught
        for (const [fixture, title] of [
            ['r10-k4-extgstate-js', 'a typeless graphics state carrying /JS'],
            ['r10-k5-group-js', 'a typeless transparency group carrying /JS'],
            ['r10-k6-props-js', 'an ordinary property list carrying /JS'],
            ['r10-k14-extgstate-typed-js', 'a declared graphics state carrying /JS'],
        ]) {
            const r = await call('r9Extract', fixture, [0], SQUARE);
            check(`${fixture}: ${title} is refused, before any confirmation`,
                r.plan === 'UNSAFE_JAVASCRIPT_STRUCTURE' && r.requires.length === 0,
                `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: and Extract publishes nothing`,
                r.run === 'UNSAFE_JAVASCRIPT_STRUCTURE' && r.bytes === null, `run=${r.run}`);
            const named = (r.planDetail?.unsafe ?? []).join(' | ');
            check(`${fixture}: the refusal names what it would have taken apart`,
                named.includes('carries JavaScript') || named.includes('is also reached from'), named.slice(0, 120));
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: Merge refuses the source at intake, by name`,
                Boolean(verdict) && verdict.result === 'UNSAFE_JAVASCRIPT_STRUCTURE',
                `intake=${verdict ? verdict.result : 'missing'}`);
            check(`${fixture}: and the source is not in what the Merge writes`,
                !m.order.includes(fixture), `order=${m.order.join(',')}`);
        }

        // ---- the same documents with the stray key removed -------------------
        const k4c = await call('r9Extract', 'r10-k4c-extgstate-clean', [0], SQUARE);
        probe('r10-k4c: the source really paints the square through the graphics state',
            k4c.before[0] !== 'blue', `before=${k4c.before[0]}`);
        check('r10-k4c-extgstate-clean: READY, and the square is painted exactly as it was',
            k4c.run === 'READY' && JSON.stringify(k4c.after) === JSON.stringify(k4c.before),
            `run=${k4c.run} before=${k4c.before?.join(',')} after=${k4c.after?.join(',')}`);
        check('r10-k4c-extgstate-clean: and the artifact carries no JavaScript',
            k4c.independent.javascript === 0, `js=${k4c.independent?.javascript}`);

        const k5c = await call('r9Extract', 'r10-k5c-group-clean', [0], SQUARE, ['/Transparency']);
        check('r10-k5c-group-clean: READY, with the transparency group still in the bytes',
            k5c.run === 'READY' && k5c.markers['/Transparency'] === true,
            `run=${k5c.run} group=${k5c.markers?.['/Transparency']}`);
        check('r10-k5c-group-clean: the square is painted exactly as it was',
            JSON.stringify(k5c.after) === JSON.stringify(k5c.before),
            `before=${k5c.before?.join(',')} after=${k5c.after?.join(',')}`);
        check('r10-k5c-group-clean: and the artifact carries no JavaScript',
            k5c.independent.javascript === 0, `js=${k5c.independent?.javascript}`);

        const k6c = await call('r9Extract', 'r10-k6c-props-clean', [0], SQUARE, ['M6R10_PLIST']);
        check('r10-k6c-props-clean: READY, with the property list still in the bytes',
            k6c.run === 'READY' && k6c.markers.M6R10_PLIST === true,
            `run=${k6c.run} list=${k6c.markers?.M6R10_PLIST}`);
        check('r10-k6c-props-clean: the square is painted exactly as it was',
            JSON.stringify(k6c.after) === JSON.stringify(k6c.before),
            `before=${k6c.before?.join(',')} after=${k6c.after?.join(',')}`);
        check('r10-k6c-props-clean: no optional-content use is invented for it',
            k6c.audit.propsOc === 0 && k6c.independent.javascript === 0,
            `propsOc=${k6c.audit?.propsOc} js=${k6c.independent?.javascript}`);

        // ---- ownership: who is allowed to point at an action ------------------
        const k7 = await call('r9Extract', 'r10-k7-shared-action', [0], SQUARE, ['M6R10_SHARED']);
        check('r10-k7-shared-action: an action named by two action slots is still removed',
            k7.run === 'READY' && k7.markers.M6R10_SHARED === false,
            `run=${k7.run} script=${k7.markers?.M6R10_SHARED}`);
        check('r10-k7-shared-action: and the page draws exactly what the source drew',
            JSON.stringify(k7.after) === JSON.stringify(k7.before) && k7.independent.javascript === 0,
            `before=${k7.before?.join(',')} after=${k7.after?.join(',')} js=${k7.independent?.javascript}`);

        const k8 = await call('r9Extract', 'r10-k8-mixed-owner', [0], SQUARE);
        check('r10-k8-mixed-owner: an action a drawing resource also names is refused',
            k8.plan === 'UNSAFE_JAVASCRIPT_STRUCTURE' && k8.bytes === null, `plan=${k8.plan} run=${k8.run}`);
        check('r10-k8-mixed-owner: and the refusal names the reference that is not an action',
            (k8.planDetail?.unsafe ?? []).join(' ').includes('is also reached from'),
            (k8.planDetail?.unsafe ?? []).join(' ').slice(0, 120));

        const k13 = await call('r9Extract', 'r10-k13-detached-typeless', [0], SQUARE);
        check('r10-k13-detached-typeless: having no inbound reference is not proof of being an action',
            k13.plan === 'UNSAFE_JAVASCRIPT_STRUCTURE' && k13.bytes === null,
            `plan=${k13.plan} run=${k13.run}`);

        // ---- BLK-1R: every supported position still removes its script --------
        for (const [fixture, marker, title] of [
            ['r10-k9-names-js', 'M6R10_NAMETREE', 'the document script name tree'],
            ['r10-k10-aa-js', 'M6R10_AA', "an annotation's /AA"],
            ['r10-k11-next-js', 'M6R10_NEXT', "an action's /Next"],
            ['r10-k12-detached-action', 'M6R10_DETACHED', 'a detached action nothing points at'],
        ]) {
            const r = await call('r9Extract', fixture, [0], SQUARE, [marker]);
            check(`${fixture}: ${title} is still a supported removal`,
                r.run === 'READY' && r.markers[marker] === false,
                `run=${r.run} script=${r.markers?.[marker]}`);
            check(`${fixture}: the artifact carries no JavaScript by either count`,
                r.independent.javascript === 0, `js=${r.independent?.javascript}`);
            check(`${fixture}: and the page draws exactly what the source drew`,
                JSON.stringify(r.after) === JSON.stringify(r.before),
                `before=${r.before?.join(',')} after=${r.after?.join(',')}`);
        }

        // ---- RF-R10-1: the refusal arrives before the confirmation ------------
        const k15 = await call('r9Extract', 'r10-k15-js-and-attachment', [0], SQUARE,
            ['M6R10_ATTACHMENT_PAYLOAD']);
        probe('r10-k15: the source really holds the attachment a confirmation would name',
            k15.sourceMarkers.M6R10_ATTACHMENT_PAYLOAD === true);
        check('r10-k15-js-and-attachment: nobody is asked to agree to the attachment loss',
            k15.plan === 'UNSAFE_JAVASCRIPT_STRUCTURE' && k15.requires.length === 0,
            `plan=${k15.plan} requires=${k15.requires.join(',')}`);
        check('r10-k15-js-and-attachment: and nothing is written',
            k15.run === 'UNSAFE_JAVASCRIPT_STRUCTURE' && k15.bytes === null, `run=${k15.run}`);
        const k15m = await call('r9Merge', ['r10-k15-js-and-attachment', 'merge-b'], null, []);
        const k15v = k15m.intake.find((i) => i.name === 'r10-k15-js-and-attachment');
        check('r10-k15-js-and-attachment: Merge names it at intake rather than after a confirmation',
            Boolean(k15v) && k15v.result === 'UNSAFE_JAVASCRIPT_STRUCTURE',
            `intake=${k15v ? k15v.result : 'missing'}`);
    }

    // ---- 64. BLK-R10R-1: a holder and an edge authorize; a name does not -----
    //
    // Round 10 asked what establishes that a dictionary is an action, and took
    // two things for proof that are not: that it carries `/S`, and that the key
    // holding a reference to it is *named* `/A`, `/Next` or `/OpenAction`. A
    // resource may be called "A". Measured at 7dea89b: READY, losses empty,
    // reachableJavaScript 0 — and `setGState` gone from the drawing.
    //
    // Every subject below is the same document as its control with one stray key
    // added, so a refusal is never mistaken for a fix that simply refuses
    // anything with a resource called "A". Each is read by PDF.js and by the
    // gate's own walk, neither of which ever consulted the sanitizer.
    console.log('\n=== 64. Round 11 JavaScript holder and edge authorization ===');
    {
        const SQUARE = [{ x: 100, y: 100 }];
        const JS = 'UNSAFE_JAVASCRIPT_STRUCTURE';

        /** Refused at planning as unsafe JavaScript, by Extract and by Merge. */
        const refuse = async (fixture, title, needle, marker) => {
            const r = await call('r11Artifact', fixture, [0], SQUARE, marker ? [marker] : []);
            if (marker) {
                probe(`${fixture}: the source really holds the script the refusal is about`,
                    r.sourceMarkers[marker] === true);
            }
            check(`${fixture}: ${title} is refused as unsafe JavaScript, before anything is asked`,
                r.plan === JS && r.requires.length === 0, `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: and Extract publishes nothing`,
                r.run === JS && r.bytes === null, `run=${r.run}`);
            const named = (r.planDetail?.unsafe ?? []).join(' | ');
            check(`${fixture}: and the refusal says what it would have taken apart`,
                named.includes(needle), named.slice(0, 160));
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: Merge refuses the source at intake, by name`,
                Boolean(verdict) && verdict.result === JS, `intake=${verdict ? verdict.result : 'missing'}`);
            check(`${fixture}: and the source is not in what the Merge writes`,
                !m.order.includes(fixture), `order=${m.order.join(',')}`);
        };

        /** READY, the script gone, and the drawing exactly what the source drew. */
        const passes = async (fixture, title, marker) => {
            const r = await call('r11Artifact', fixture, [0], SQUARE, [marker]);
            check(`${fixture}: ${title} is READY`, r.plan === 'READY' && r.run === 'READY',
                `plan=${r.plan} run=${r.run}`);
            check(`${fixture}: and the script is not in the artifact`,
                r.markers?.[marker] === false && r.independent?.javascript === 0,
                `marker=${r.markers?.[marker]} js=${r.independent?.javascript}`);
            check(`${fixture}: and PDF.js draws the operators the source drew`,
                JSON.stringify(r.ops) === JSON.stringify(r.sourceOps),
                `${(r.sourceOps ?? []).length} -> ${(r.ops ?? []).length} operators`);
            check(`${fixture}: and the square is painted exactly as it was`,
                JSON.stringify(r.after) === JSON.stringify(r.before),
                `before=${r.before?.join(',')} after=${r.after?.join(',')}`);
            check(`${fixture}: and no reference in the artifact names nothing`,
                r.dangling === 0, `dangling=${r.dangling}`);
        };

        // ---- the reviewer's exact adversarial family -------------------------
        for (const [fixture, title, marker] of [
            ['r11-p2-extgstate-name-a', 'a graphics state registered under the resource name /A', 'M6R11_P2'],
            ['r11-p4-extgstate-direct-name-a', 'the same graphics state written directly under /A', 'M6R11_P4'],
            ['r11-p1-props-name-a', 'a property list named /A', 'M6R11_P1'],
            ['r11-p1b-props-name-next', 'a property list named /Next', 'M6R11_P1B'],
            ['r11-p5-props-name-openaction', 'a property list named /OpenAction', 'M6R11_P5'],
        ]) {
            await refuse(fixture, title, 'is not an action position', marker);
        }
        // Not the optional-content invariant, and not the last thing to notice:
        // the run is refused for the JavaScript reason, which is the sentence
        // that is true.
        const p1 = await call('r11Artifact', 'r11-p1-props-name-a', [0], SQUARE, []);
        check('r11-p1: it is not left for the optional-content invariant to find a missing layer',
            p1.run !== 'INVARIANT_VIOLATED' && p1.plan === JS, `plan=${p1.plan} run=${p1.run}`);

        // ---- the controls: the same documents, the stray key removed ---------
        const gs = await call('r11Artifact', 'r11-p2c-extgstate-name-a-clean', [0], SQUARE, []);
        probe('r11-p2c: the source really draws through the graphics state',
            gs.sourceOps.includes('setGState') && gs.before[0] !== 'blue',
            `ops=${gs.sourceOps.join(',')} before=${gs.before?.[0]}`);
        for (const [fixture, title, category, name] of [
            ['r11-p2c-extgstate-name-a-clean', 'a graphics state named /A', 'ExtGState', 'A'],
            ['r11-p4c-extgstate-direct-name-a-clean', 'a direct graphics state named /A', 'ExtGState', 'A'],
            ['r11-p1c-props-name-a-clean', 'a property list named /A', 'Properties', 'A'],
            ['r11-p1bc-props-name-next-clean', 'a property list named /Next', 'Properties', 'Next'],
            ['r11-p5c-props-name-openaction-clean', 'a property list named /OpenAction', 'Properties', 'OpenAction'],
        ]) {
            const r = await call('r11Artifact', fixture, [0], SQUARE, ['M6R11_PLIST']);
            check(`${fixture}: ${title} is not refused merely for its name`,
                r.plan === 'READY' && r.run === 'READY', `plan=${r.plan} run=${r.run}`);
            check(`${fixture}: and PDF.js draws the operators the source drew`,
                JSON.stringify(r.ops) === JSON.stringify(r.sourceOps),
                `${(r.sourceOps ?? []).join(',')} -> ${(r.ops ?? []).join(',')}`);
            check(`${fixture}: and the square is painted exactly as it was`,
                JSON.stringify(r.after) === JSON.stringify(r.before),
                `before=${r.before?.join(',')} after=${r.after?.join(',')}`);
            check(`${fixture}: and /${category} /${name} still resolves to a dictionary`,
                r.resources?.[category]?.[name] === 'dict'
                && r.sourceResources?.[category]?.[name] === 'dict',
                JSON.stringify(r.resources?.[category]));
            check(`${fixture}: and no reference in the artifact names nothing`,
                r.dangling === 0, `dangling=${r.dangling}`);
        }

        // ---- the holder matrix: one child, byte for byte, every holder -------
        for (const [fixture, marker, title] of [
            ['r11-h-a-real-openaction', 'M6R11_HA', "the catalog's /OpenAction"],
            ['r11-h-c-real-annot-a', 'M6R11_HC', "a page annotation's /A"],
            ['r11-h-e-real-aa', 'M6R11_HE', "an annotation's /AA event"],
            ['r11-h-g-proven-next', 'M6R11_HG', "a proven action's /Next"],
            ['r11-h-g2-goto-next-rebuilt', 'M6R11_HG2', "an internal GoTo's /Next, which the rebuild orphans"],
            ['r11-h-i-names-value', 'M6R11_HI', 'a value slot of the /Names /JavaScript tree'],
        ]) {
            await passes(fixture, `the action held by ${title}`, marker);
        }
        for (const [fixture, marker, title] of [
            ['r11-h-b-private-openaction', 'M6R11_HB', "an arbitrary dictionary's /OpenAction"],
            ['r11-h-d-resource-name-a', 'M6R11_HD', 'a property list named /A'],
            ['r11-h-d2-extgstate-name-a', 'M6R11_HD2', 'a graphics state named /A'],
            ['r11-h-f-private-aa', 'M6R11_HF', "an arbitrary dictionary's /AA"],
            ['r11-h-h-nonaction-next', 'M6R11_HH', "an unproven dictionary's /Next"],
            ['r11-h-h2-private-next', 'M6R11_HH2', "an arbitrary dictionary's /Next"],
            ['r11-h-j-names-key-slot', 'M6R11_HJ', 'a name slot of the /Names /JavaScript array'],
            ['r11-h-k-unrelated-names-tree', 'M6R11_HK', 'a name tree that is not the JavaScript one'],
        ]) {
            await refuse(fixture, `the same child held by ${title}`, 'is not an action position', marker);
        }

        // ---- shared ownership, and one key name in two holders ---------------
        await refuse('r11-s-annot-a-and-extgstate-a',
            'an action held by a real annotation /A and by /ExtGState /A', 'is not an action position',
            'M6R11_S1');
        await passes('r11-s-three-action-edges', 'an action held by three action positions', 'M6R11_S2');
        // A holder nothing reaches is not a reason to refuse; one the page reaches is.
        await passes('r11-s-dead-holder-ignored',
            'an action also named by an object nothing reaches', 'M6R11_S3');

        // ---- `/S` is a closed vocabulary -------------------------------------
        await passes('r11-t-javascript', 'a JavaScript action', 'M6R11_T1');
        await passes('r11-t-rendition', 'a Rendition action carrying /JS', 'M6R11_T2');
        await passes('r11-t-chain-recognised',
            'a script reached through URI, Named and Hide actions', 'M6R11_T9');
        for (const [fixture, marker, title, needle] of [
            ['r11-t-unknown-s', 'M6R11_T3', 'an unknown /S', 'is not an action type'],
            ['r11-t-missing-s', 'M6R11_T4', 'a /Type /Action with no /S', 'carries no /S'],
            ['r11-t-not-a-name-s', 'M6R11_T5', 'an /S that is a string', 'carries no /S'],
            ['r11-t-type-action-unknown-s', 'M6R11_T6', '/Type /Action with an unknown /S', 'is not an action type'],
            ['r11-t-type-action-no-script-s', 'M6R11_T7', 'a recognised action with no script to carry', 'no script to carry'],
            ['r11-t-transparency-s', 'M6R11_T8', 'a transparency group subtype', 'is not an action type'],
            ['r11-t-chain-unrecognised-link', 'M6R11_T10', 'a script behind a link whose /S is not an action', 'is not an action position'],
        ]) {
            await refuse(fixture, title, needle, marker);
        }

        // ---- Outline items are not a position the action scan walks ----------
        //
        // Not a new Human decision: nothing in the current scan reaches an outline
        // item's `/A`, so a script there is not proven to be at an action position.
        // Fail closed, and say so. Round 10 read the key's name and accepted it.
        await refuse('r11-o-outline-a-js', "a script in an outline item's /A", 'is not an action position',
            'M6R11_O1');
        const oc = await call('r11Artifact', 'r11-oc-outline-clean', [0], SQUARE, []);
        check('r11-oc-outline-clean: the same outline without the script is READY',
            oc.plan === 'READY' && oc.run === 'READY', `plan=${oc.plan} run=${oc.run}`);
    }

    // ---- 65. RF-R10R-1: one JavaScript safety answer, asked at planning -----
    //
    // The sanitizer asked two questions — was the action scan complete, and is
    // every carrier proven — and planning asked one. So an action structure the
    // scan could not read to the end planned READY, or asked for the attachment
    // to be agreed to, and was refused as UNSCANNABLE_ACTIONS after the answer had
    // been given. A Merge refused every source, not the one that was the problem.
    console.log('\n=== 65. Round 11 planning asks what the sanitizer asks ===');
    {
        const SQUARE = [{ x: 100, y: 100 }];
        const UNSCAN = 'UNSCANNABLE_ACTIONS';
        const PAYLOAD = 'M6R11_ATTACHMENT_PAYLOAD';

        for (const [fixture, title, needle] of [
            ['r11-q9-att-annot-a-42', "an annotation's /A that is the number 42", 'A is neither an action nor a destination'],
            ['r11-r1-att-annot-aa-42', "an annotation's /AA event that is the number 42", 'neither an action nor a destination'],
            ['r11-r2-att-page-aa-42', "a page's /AA event that is the number 42", 'neither an action nor a destination'],
            ['r11-r3-att-annot-a-name', "an annotation's /A that is a name", 'neither an action nor a destination'],
            ['r11-r4-att-annot-a-dangling', "an annotation's /A that names nothing", 'neither an action nor a destination'],
            ['r11-r6-att-next-name', 'an action whose /Next is a name', 'neither an action nor a destination'],
            ['r11-r7-att-annot-a-stream', "an annotation's /A that is a stream", 'neither an action nor a destination'],
            ['r11-q11-att-next-list-42', 'a /Next list whose second member is the number 42', 'neither an action nor a destination'],
        ]) {
            const r = await call('r9Extract', fixture, [0], SQUARE, [PAYLOAD]);
            probe(`${fixture}: the source really holds the attachment a confirmation would name`,
                r.sourceMarkers[PAYLOAD] === true);
            check(`${fixture}: ${title} is refused at planning, and nobody is asked about the attachment`,
                r.plan === UNSCAN && r.requires.length === 0, `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: and nothing is written`,
                r.run === UNSCAN && r.bytes === null, `run=${r.run}`);
            const named = (r.planDetail?.incomplete ?? []).join(' | ');
            check(`${fixture}: and the refusal says which position could not be read`,
                named.includes(needle), named.slice(0, 160));

            // Merge: this source is excluded, by name, at intake — under the
            // adopted H10 rule — and the source beside it is merged.
            const m = await call('r9Merge', [fixture, 'merge-b'], null, [PAYLOAD]);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: Merge names the source at intake, as unscannable`,
                Boolean(verdict) && verdict.result === UNSCAN, `intake=${verdict ? verdict.result : 'missing'}`);
            check(`${fixture}: and the other source is merged without it, and without a confirmation`,
                m.run === 'READY' && m.order.join(',') === 'merge-b' && m.bytes !== null,
                `run=${m.run} order=${m.order.join(',')}`);
            check(`${fixture}: and none of the excluded source is in what the Merge writes`,
                m.markers?.[PAYLOAD] === false, `payload=${m.markers?.[PAYLOAD]}`);
            const alone = await call('r9Merge', [fixture], null, []);
            check(`${fixture}: a Merge of nothing else writes nothing`,
                alone.bytes === null && alone.order.length === 0 && alone.run !== 'READY',
                `run=${alone.run} order=${alone.order.length}`);
        }

        // The same defect with nothing to confirm: planning used to say READY.
        for (const fixture of ['r11-eq9-annot-a-42', 'r11-eq9b-annot-a-dangling']) {
            const r = await call('r9Extract', fixture, [0], SQUARE, []);
            check(`${fixture}: with no attachment, planning still does not say READY`,
                r.plan === UNSCAN && r.run === UNSCAN && r.bytes === null,
                `plan=${r.plan} run=${r.run}`);
            const m = await call('r9Merge', [fixture, 'merge-b'], null, []);
            const verdict = m.intake.find((i) => i.name === fixture);
            check(`${fixture}: and Merge excludes it at intake instead of refusing every source`,
                verdict?.result === UNSCAN && m.run === 'READY' && m.order.join(',') === 'merge-b',
                `intake=${verdict?.result} run=${m.run}`);
        }

        // ---- the hard refusal comes before every question ---------------------
        for (const [fixture, expected, title] of [
            ['r11-c-unsafe-only', 'UNSAFE_JAVASCRIPT_STRUCTURE', 'unsafe JavaScript alone'],
            ['r11-c-unscannable-only', UNSCAN, 'unscannable JavaScript alone'],
            ['r11-c-unsafe-att', 'UNSAFE_JAVASCRIPT_STRUCTURE', 'unsafe JavaScript and an attachment'],
            ['r11-c-unscannable-att', UNSCAN, 'unscannable JavaScript and an attachment'],
            ['r11-c-unsafe-tag', 'UNSAFE_JAVASCRIPT_STRUCTURE', 'unsafe JavaScript and tagging'],
            ['r11-c-unscannable-tag', UNSCAN, 'unscannable JavaScript and tagging'],
            ['r11-c-unsafe-att-tag', 'UNSAFE_JAVASCRIPT_STRUCTURE', 'unsafe JavaScript, an attachment and tagging'],
            ['r11-c-unscannable-att-tag', UNSCAN, 'unscannable JavaScript, an attachment and tagging'],
            ['r11-c-both-att', UNSCAN, 'both kinds of JavaScript refusal and an attachment'],
        ]) {
            const r = await call('r9Extract', fixture, [0], SQUARE, []);
            check(`${fixture}: ${title} is a hard refusal first, and asks nothing`,
                r.plan === expected && r.requires.length === 0, `plan=${r.plan} requires=${r.requires.join(',')}`);
            check(`${fixture}: and nothing is written`, r.bytes === null && r.run === expected, `run=${r.run}`);
        }
        // The controls: the ordinary losses are still asked about, once.
        const attOnly = await call('r9Extract', 'r11-c-att-only', [0], SQUARE, [PAYLOAD]);
        check('r11-c-att-only: an ordinary attachment still gets its confirmation',
            attOnly.plan === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION'
            && attOnly.requires.join(',') === 'attachments', `plan=${attOnly.plan} requires=${attOnly.requires}`);
        check('r11-c-att-only: and once agreed to it is READY, without the payload',
            attOnly.run === 'READY' && attOnly.markers?.[PAYLOAD] === false, `run=${attOnly.run}`);
        const tagOnly = await call('r9Extract', 'r11-c-tag-only', [0], SQUARE, []);
        check('r11-c-tag-only: tagging still gets its confirmation',
            tagOnly.plan === 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION'
            && tagOnly.requires.join(',') === 'tagging', `plan=${tagOnly.plan} requires=${tagOnly.requires}`);

        // ---- planning and the sanitizer, asked of one unmodified source --------
        //
        // The source facts planning reads, the shared assessment, `sanitizeJavaScript`
        // and `scrubAllJavaScript` are four askers of one question. On a source
        // nothing has touched, none of them may answer differently.
        const EXPECTED = {
            SAFE: { sanitize: 'READY', scrub: 'OK' },
            UNSAFE_STRUCTURE: { sanitize: 'UNSAFE', scrub: 'UNSAFE' },
            UNSCANNABLE: { sanitize: 'REFUSED', scrub: 'INCOMPLETE' },
        };
        const matrix = [
            // a valid script, wherever it may be
            ['r10-k7-shared-action', 'SAFE'], ['r10-k9-names-js', 'SAFE'], ['r10-k10-aa-js', 'SAFE'],
            ['r10-k11-next-js', 'SAFE'], ['r10-k12-detached-action', 'SAFE'],
            ['r11-h-a-real-openaction', 'SAFE'], ['r11-h-c-real-annot-a', 'SAFE'], ['r11-h-e-real-aa', 'SAFE'],
            ['r11-h-g-proven-next', 'SAFE'], ['r11-h-g2-goto-next-rebuilt', 'SAFE'],
            ['r11-s-dead-holder-ignored', 'SAFE'], ['r11-h-i-names-value', 'SAFE'], ['r11-t-javascript', 'SAFE'],
            ['r11-t-rendition', 'SAFE'], ['r11-t-chain-recognised', 'SAFE'], ['r11-s-three-action-edges', 'SAFE'],
            ['rem-js-detached-parent-field', 'SAFE'],
            // no script at all, whatever the resources are called
            ['r11-p2c-extgstate-name-a-clean', 'SAFE'], ['r11-p1c-props-name-a-clean', 'SAFE'],
            // not proven to be an action
            ['r10-k4-extgstate-js', 'UNSAFE_STRUCTURE'], ['r10-k5-group-js', 'UNSAFE_STRUCTURE'],
            ['r10-k6-props-js', 'UNSAFE_STRUCTURE'], ['r10-k8-mixed-owner', 'UNSAFE_STRUCTURE'],
            ['r10-k13-detached-typeless', 'UNSAFE_STRUCTURE'], ['r10-k14-extgstate-typed-js', 'UNSAFE_STRUCTURE'],
            ['r11-p2-extgstate-name-a', 'UNSAFE_STRUCTURE'], ['r11-p4-extgstate-direct-name-a', 'UNSAFE_STRUCTURE'],
            ['r11-p1-props-name-a', 'UNSAFE_STRUCTURE'], ['r11-p1b-props-name-next', 'UNSAFE_STRUCTURE'],
            ['r11-p5-props-name-openaction', 'UNSAFE_STRUCTURE'],
            ['r11-h-b-private-openaction', 'UNSAFE_STRUCTURE'], ['r11-h-d-resource-name-a', 'UNSAFE_STRUCTURE'],
            ['r11-h-f-private-aa', 'UNSAFE_STRUCTURE'], ['r11-h-h-nonaction-next', 'UNSAFE_STRUCTURE'],
            ['r11-h-j-names-key-slot', 'UNSAFE_STRUCTURE'], ['r11-h-k-unrelated-names-tree', 'UNSAFE_STRUCTURE'],
            ['r11-s-annot-a-and-extgstate-a', 'UNSAFE_STRUCTURE'], ['r11-t-unknown-s', 'UNSAFE_STRUCTURE'],
            ['r11-t-missing-s', 'UNSAFE_STRUCTURE'], ['r11-o-outline-a-js', 'UNSAFE_STRUCTURE'],
            // an action structure that cannot be read to the end
            ['r11-q9-att-annot-a-42', 'UNSCANNABLE'], ['r11-eq9-annot-a-42', 'UNSCANNABLE'],
            ['r11-r1-att-annot-aa-42', 'UNSCANNABLE'], ['r11-r2-att-page-aa-42', 'UNSCANNABLE'],
            ['r11-r3-att-annot-a-name', 'UNSCANNABLE'], ['r11-r4-att-annot-a-dangling', 'UNSCANNABLE'],
            ['r11-r6-att-next-name', 'UNSCANNABLE'], ['r11-r7-att-annot-a-stream', 'UNSCANNABLE'],
            ['r11-q11-att-next-list-42', 'UNSCANNABLE'],
        ];
        for (const [fixture, kind] of matrix) {
            const a = await call('r11Assess', fixture);
            check(`${fixture}: planning, the assessment, the sanitizer and the scrub all say ${kind}`,
                a.facts === kind && a.assessed === kind
                && a.sanitize === EXPECTED[kind].sanitize && a.scrub === EXPECTED[kind].scrub,
                JSON.stringify(a));
        }
    }

    // ---- 66. RF-R11R-1: Merge asks what the run asks about actions ------------
    //
    // Two readers of an action's structure decide whether a source can be copied.
    // The JavaScript assessment asks what a script hides behind, and Merge asked
    // it at intake. The other follows each action to the pages it points at —
    // closeSourcePageRefs — and Merge asked it only when it ran. A source that
    // satisfied the first and not the second was accepted, planned READY, agreed
    // to (an attachment, say), and then stopped the whole Merge with
    // UNSCANNABLE_ACTIONS: the safe sources with it, after the answer had been
    // given. The changelog said the file alone would be left out. This section
    // measures that it is — by what the first plan presents, not by the outcome —
    // and that the two readers count a /Next hop the same way.
    console.log('\n=== 66. Round 12 Merge asks what the run asks about actions ===');
    {
        const UNSCAN = 'UNSCANNABLE_ACTIONS';
        const PAYLOAD = 'M6R12_ATTACHMENT_PAYLOAD';
        const bound = constants.mechanismBounds.maxActionDepth;
        const partner = await call('r12Merge', ['merge-b'], []);
        const partnerPages = partner.pages;
        check('merge-b merges alone, so the other sources can be measured against its page count',
            partner.run === 'READY' && Number.isInteger(partnerPages) && partnerPages > 0, `pages=${partnerPages}`);
        check('the action-chain bound is a positive whole number, and the sweep below is derived from it',
            Number.isInteger(bound) && bound > 0, `maxActionDepth=${bound}`);

        // ---- an /AA that names nothing --------------------------------------
        for (const [fixture, title, hasAttachment, hasTagging] of [
            ['r12-a-annot-dangling-aa-att', "an annotation's /AA that names nothing, and an attachment", true, false],
            ['r12-b-page-dangling-aa-att', "a page's /AA that names nothing, and an attachment", true, false],
            ['r12-c-annot-dangling-aa-att-tag', "an annotation's /AA that names nothing, an attachment and tagging", true, true],
            ['r12-c-annot-dangling-aa-tag', "an annotation's /AA that names nothing, and tagging", false, true],
            ['r12-c-annot-dangling-aa', "an annotation's /AA that names nothing", false, false],
            ['r12-c-page-dangling-aa', "a page's /AA that names nothing", false, false],
            ['r12-c-widget-dangling-aa', "a form widget's /AA that names nothing", false, false],
        ]) {
            const r = await call('r12Readability', fixture);
            // The negative probes: the two facts that made this a defect. The
            // reader Merge did not ask refuses it, and the reader Merge did ask
            // accepts it — so a Merge that asked only the latter was wrong.
            probe(`${fixture}: the reader Merge used to ask only at run time refuses it`,
                r.readability === UNSCAN, `readability=${r.readability} ${(r.unreadable ?? []).join(' | ').slice(0, 100)}`);
            probe(`${fixture}: and the JavaScript assessment Merge already asked at intake accepts it`,
                r.js === 'SAFE', `js=${r.js}`);

            const m = await call('r12Merge', [fixture, 'merge-b'], [PAYLOAD]);
            const verdict = m.intake.find((i) => i.id === fixture);
            if (hasAttachment) {
                probe(`${fixture}: the source really holds the attachment a confirmation would name`,
                    m.sourceMarkers[fixture][PAYLOAD] === true);
            }
            check(`${fixture}: Merge refuses the source at intake, by name, as unscannable`,
                verdict?.result === UNSCAN && verdict.name === `${fixture}.pdf`,
                `intake=${verdict?.result} name=${verdict?.name}`);
            check(`${fixture}: and the intake says which structure could not be read`,
                (verdict?.reason ?? '').includes('/AA'), (verdict?.reason ?? '').slice(0, 140));
            check(`${fixture}: and the source beside it is accepted`,
                m.intake.find((i) => i.id === 'merge-b')?.result === 'ACCEPTED');
            check(`${fixture}: and the first plan asks about nothing`,
                m.first.requires.length === 0, `requires=${m.first.requires.join(',')}`);
            check(`${fixture}: and none of the excluded source's losses is presented`,
                !m.first.losses.some((l) => ['attachments', 'tagging'].includes(l.kind)
                    && (l.what ?? '').includes(fixture)),
                m.first.losses.map((l) => `${l.kind}:${l.what}`).join(' | ').slice(0, 160));
            check(`${fixture}: and the source is named as left out`,
                m.first.losses.some((l) => l.kind === 'excluded-source' && (l.what ?? '').includes(fixture)),
                m.first.losses.map((l) => l.kind).join(','));
            check(`${fixture}: and the Merge writes the other source alone`,
                m.run === 'READY' && m.order.join(',') === 'merge-b' && m.pages === partnerPages,
                `run=${m.run} order=${m.order.join(',')} pages=${m.pages}`);
            check(`${fixture}: and nothing of the excluded source is in what it writes`,
                m.markers?.[PAYLOAD] === false && m.independent?.javascript === 0
                && m.independent?.embeddedFileStreams === 0 && m.independent?.structTreeRoot === false,
                JSON.stringify(m.markers));
            const alone = await call('r12Merge', [fixture], []);
            check(`${fixture}: a Merge of nothing else writes nothing, by the adopted no-accepted-source result`,
                alone.bytes === null && alone.order.length === 0 && alone.run === 'EMPTY_SELECTION',
                `run=${alone.run} order=${alone.order.length}`);
            if (fixture !== 'r12-c-widget-dangling-aa') {
                const e = await call('r9Extract', fixture, [0], null, []);
                check(`${fixture}: Extract still refuses it at planning, and asks nothing`,
                    e.plan === UNSCAN && e.requires.length === 0 && e.bytes === null,
                    `plan=${e.plan} requires=${e.requires.join(',')}`);
            }
        }

        // ---- a /Next chain of an exact length --------------------------------
        //
        // Round 12A: the /Next array is a representation and not a hop, so a chain
        // written as lists has the direct chain's boundary and no other — 32 hops
        // read, 33 refused. The x fixtures walk it in every spelling.
        for (const [fixture, title] of [
            ['r12-d-next-15', '15 hops'],
            ['r12-d-next-16', '16 hops — one past what the second reader used to allow'],
            ['r12-d-next-17', '17 hops'],
            ['r12-e-next-31', '31 hops'],
            ['r12-e-next-32', `${bound} hops — the bound, inclusive`],
            ['r12-x-next-array-15', '15 hops through /Next arrays'],
            ['r12-x-next-array-16', '16 hops through /Next arrays — what the container used to leave as the limit'],
            ['r12-x-next-array-17', '17 hops through /Next arrays — one past what the container used to allow'],
            ['r12-x-next-array-31', '31 hops through /Next arrays'],
            ['r12-x-next-array-32', `${bound} hops through /Next arrays — the bound, inclusive, as for a direct chain`],
            ['r12-x-next-array-indirect-32', `${bound} hops through /Next arrays held by objects of their own`],
            ['r12-x-next-inline-32', `${bound} hops with every /Next written as the action itself`],
            ['r12-x-next-array-wide-last-32', `${bound} hops through /Next lists of three, the chain last: siblings are not a queue`],
            ['r12-x-next-array-wide-first-32', `${bound} hops through /Next lists of three, the chain first`],
            ['r12-v-direct-action', 'a direct action'],
            ['r12-v-indirect-action', 'an indirect action'],
            ['r12-v-next-array', 'a /Next list of two actions'],
            ['r12-v-aa-valid', 'an /AA event with an action'],
        ]) {
            const r = await call('r12Readability', fixture);
            check(`${fixture}: ${title} is read to the end by both readers`,
                r.js === 'SAFE' && r.readability === 'READABLE', `js=${r.js} readability=${r.readability}`);
            check(`${fixture}: and Extract plans it`, r.extract === 'READY', `extract=${r.extract}`);
            const m = await call('r12Merge', [fixture, 'merge-b'], []);
            check(`${fixture}: and Merge accepts it at intake and writes both sources`,
                m.intake.every((i) => i.result === 'ACCEPTED') && m.run === 'READY'
                && m.pages === partnerPages + 1 && m.first.requires.length === 0,
                `intake=${m.intake.map((i) => i.result).join(',')} run=${m.run} pages=${m.pages}`);
        }
        for (const [fixture, title] of [
            ['r12-f-next-33', `${bound + 1} hops — one over the bound`],
            ['r12-x-next-array-33', `${bound + 1} hops through /Next arrays — one over the bound, as for a direct chain`],
            ['r12-x-next-array-34', `${bound + 2} hops through /Next arrays`],
            ['r12-x-next-array-33-js', `${bound + 1} hops through /Next arrays, ending in a script`],
            ['r12-x-next-array-indirect-33', `${bound + 1} hops through /Next arrays held by objects of their own`],
            ['r12-x-next-inline-33', `${bound + 1} hops with every /Next written as the action itself`],
            ['r12-x-next-array-wide-last-33', `${bound + 1} hops through /Next lists of three, the chain last`],
            ['r12-x-next-array-wide-first-33', `${bound + 1} hops through /Next lists of three, the chain first`],
            ['r12-f-next-33-js', `${bound + 1} hops, ending in a script`],
            ['r12-g-next-array-bad-member', 'a /Next list with a member that is not an action'],
            ['r12-g-next-array-nested', 'a /Next list inside a /Next list — not a shape the depth correction widens'],
            ['r12-h-next-cycle', 'a chain that comes back to where it started'],
            ['r12-h-next-self', 'an action whose /Next is itself'],
            ['r12-h-next-cycle-array', 'a chain of /Next lists that comes back to where it started'],
            ['r12-h-next-self-array', 'an action whose /Next lists itself'],
        ]) {
            const r = await call('r12Readability', fixture);
            check(`${fixture}: ${title} is refused by at least one reader, and Extract says so at planning`,
                (r.js === 'UNSCANNABLE' || r.readability === UNSCAN) && r.extract === UNSCAN && r.requires.length === 0,
                `js=${r.js} readability=${r.readability} extract=${r.extract}`);
            const m = await call('r12Merge', [fixture, 'merge-b'], []);
            const verdict = m.intake.find((i) => i.id === fixture);
            check(`${fixture}: and Merge excludes it at intake with the typed result, and writes the other source`,
                verdict?.result === UNSCAN && m.run === 'READY' && m.order.join(',') === 'merge-b'
                && m.pages === partnerPages,
                `intake=${verdict?.result} run=${m.run} pages=${m.pages}`);
        }
        for (const fixture of [
            'r12-f-next-33', 'r12-x-next-array-33', 'r12-x-next-array-34', 'r12-x-next-array-indirect-33',
            'r12-x-next-inline-33', 'r12-x-next-array-wide-last-33', 'r12-x-next-array-wide-first-33',
            'r12-h-next-cycle-array', 'r12-h-next-self-array',
        ]) {
            const r = await call('r12Readability', fixture);
            check(`${fixture}: both readers refuse it — the second no longer refuses less, or more, than the first`,
                r.js === 'UNSCANNABLE' && r.readability === UNSCAN, `js=${r.js} readability=${r.readability}`);
        }
        // A list inside a list is refused by the JavaScript assessment, which is what
        // Extract's plan and Merge's intake ask first; the depth correction leaves
        // that where it was. The destinations reader steps over a member that is not
        // an action, exactly as it did before, and it is not asked to be the one that
        // refuses this shape.
        {
            const r = await call('r12Readability', 'r12-g-next-array-nested');
            check('r12-g-next-array-nested: the JavaScript assessment refuses a list inside a list, and so do Extract and intake',
                r.js === 'UNSCANNABLE' && r.extract === UNSCAN && r.requires.length === 0,
                `js=${r.js} readability=${r.readability} extract=${r.extract}`);
        }

        // ---- the confirmation that is still asked, and the one that is not -----
        {
            const seen = await call('r12Merge', ['r12-d-next-17-att', 'merge-b'], [PAYLOAD]);
            check('r12-d-next-17-att: a valid 17-hop chain and an attachment is accepted, and the attachment is asked about',
                seen.intake.every((i) => i.result === 'ACCEPTED') && seen.first.requires.includes('attachments'),
                `intake=${seen.intake.map((i) => i.result).join(',')} requires=${seen.first.requires.join(',')}`);
            check('r12-d-next-17-att: and once agreed to, it merges — it used to stop the whole Merge',
                seen.run === 'READY' && seen.pages === partnerPages + 1 && seen.markers?.[PAYLOAD] === false,
                `run=${seen.run} pages=${seen.pages} payload=${seen.markers?.[PAYLOAD]}`);
            const over = await call('r12Merge', ['r12-f-next-33-att', 'merge-b'], [PAYLOAD]);
            check('r12-f-next-33-att: one hop over the bound is excluded before the attachment is asked about',
                over.intake.find((i) => i.id === 'r12-f-next-33-att')?.result === UNSCAN
                && over.first.requires.length === 0
                && !over.first.losses.some((l) => l.kind === 'attachments')
                && over.run === 'READY' && over.pages === partnerPages && over.markers?.[PAYLOAD] === false,
                `requires=${over.first.requires.join(',')} run=${over.run} pages=${over.pages}`);
            // The same two questions for a chain written as /Next lists (Round 12A):
            // 17 hops used to be refused here and is a valid source with an ordinary
            // confirmation; 33 is still excluded before anything is asked.
            const seenList = await call('r12Merge', ['r12-x-next-array-17-att', 'merge-b'], [PAYLOAD]);
            check('r12-x-next-array-17-att: a valid 17-hop chain of /Next lists and an attachment is accepted, and the attachment is asked about',
                seenList.intake.every((i) => i.result === 'ACCEPTED') && seenList.first.requires.includes('attachments'),
                `intake=${seenList.intake.map((i) => i.result).join(',')} requires=${seenList.first.requires.join(',')}`);
            check('r12-x-next-array-17-att: and once agreed to, it merges, with the attachment gone',
                seenList.run === 'READY' && seenList.pages === partnerPages + 1 && seenList.markers?.[PAYLOAD] === false
                && seenList.independent?.javascript === 0,
                `run=${seenList.run} pages=${seenList.pages} payload=${seenList.markers?.[PAYLOAD]}`);
            const overList = await call('r12Merge', ['r12-x-next-array-33-att', 'merge-b'], [PAYLOAD]);
            check('r12-x-next-array-33-att: one hop over the bound, as /Next lists, is excluded before the attachment is asked about',
                overList.intake.find((i) => i.id === 'r12-x-next-array-33-att')?.result === UNSCAN
                && overList.first.requires.length === 0
                && !overList.first.losses.some((l) => l.kind === 'attachments')
                && overList.run === 'READY' && overList.pages === partnerPages && overList.markers?.[PAYLOAD] === false,
                `requires=${overList.first.requires.join(',')} run=${overList.run} pages=${overList.pages}`);
            for (const fixture of [
                'r12-g-next-array-bad-member-att', 'r12-h-next-cycle-att',
                'r12-g-next-array-nested-att', 'r12-h-next-cycle-array-att',
            ]) {
                const m = await call('r12Merge', [fixture, 'merge-b'], [PAYLOAD]);
                check(`${fixture}: an unreadable chain and an attachment is excluded before anything is asked`,
                    m.intake.find((i) => i.id === fixture)?.result === UNSCAN && m.first.requires.length === 0
                    && m.run === 'READY' && m.pages === partnerPages && m.markers?.[PAYLOAD] === false,
                    `requires=${m.first.requires.join(',')} run=${m.run}`);
            }
        }

        // ---- a script at the end of a chain is removed at the bound --------------
        for (const [fixture, marker, title] of [
            ['r12-e-next-32-js', 'M6R12_E32', `a script ${bound} hops down a chain`],
            ['r12-x-next-array-16-js', 'M6R12_X16', 'a script 16 hops down a chain of /Next arrays'],
            ['r12-x-next-array-32-js', 'M6R12_X32', `a script ${bound} hops down a chain of /Next arrays — the bound, as for a direct chain`],
            ['r12-v-next-array-js', 'M6R12_V1', 'a script in a /Next list'],
        ]) {
            const e = await call('r9Extract', fixture, [0], null, [marker]);
            probe(`${fixture}: the source really holds the script`, e.sourceMarkers[marker] === true);
            check(`${fixture}: Extract writes ${title} without it`,
                e.run === 'READY' && e.markers[marker] === false && e.independent.javascript === 0,
                `run=${e.run} javascript=${e.independent?.javascript}`);
            const m = await call('r12Merge', [fixture, 'merge-b'], [marker]);
            check(`${fixture}: and so does Merge`,
                m.run === 'READY' && m.pages === partnerPages + 1 && m.markers[marker] === false
                && m.independent.javascript === 0,
                `run=${m.run} javascript=${m.independent?.javascript}`);
        }

        // ---- the sweep: every length, both shapes, every reader and every step ---
        //
        // The bound is not a claim about the fixtures above. For every length from
        // nothing to well past the bound, in every spelling of /Next, ending in a
        // URI or in a script, the JavaScript assessment, the readability, Extract's
        // plan, Merge's intake and the run all give the same answer, and the answer
        // changes exactly where the bound says it does: `bound` hops, inclusive, for
        // a direct /Next and for every /Next list alike. The list is a
        // representation and not a hop (Round 12A); before it, a list's bound was
        // half of that.
        const SHAPES = ['direct', 'inline', 'array', 'array-indirect', 'array-wide-last', 'array-wide-first'];
        const swept = {};
        for (const shape of SHAPES) {
            for (const endJs of [false, true]) {
                const off = [];
                let read = 0;
                const results = [];
                for (let hops = 0; hops <= bound + 8; hops += 1) {
                    const expected = hops <= bound;
                    const s = await call('r12Sweep', shape, hops, endJs);
                    results.push(s);
                    const agrees = (s.js === 'SAFE') === expected
                        && (s.readability === 'READABLE') === expected
                        && s.extract === (expected ? 'READY' : UNSCAN)
                        && s.intake === (expected ? 'ACCEPTED' : UNSCAN)
                        && s.run === 'READY'
                        && s.after?.pages === partnerPages + (expected ? 1 : 0)
                        && s.after?.javascript === 0;
                    if (expected && agrees) read += 1;
                    if (!agrees) off.push(`${hops}:${JSON.stringify(s)}`);
                }
                swept[`${shape}:${endJs}`] = results;
                check(`sweep: ${shape} /Next chains ending in ${endJs ? 'a script' : 'a URI'}, 0..${bound + 8} hops — `
                    + `both readers, Extract, Merge intake and the run agree, and the bound is ${bound} hops, inclusive`,
                    off.length === 0 && read === bound + 1,
                    off.length === 0 ? `${read} lengths read` : off.slice(0, 2).join(' | ').slice(0, 300));
            }
        }

        // ---- direct and list: the same answer at every length -----------------------
        //
        // Not only that each spelling meets the bound, but that no spelling answers
        // differently from the direct chain about anything — a reader that counted
        // the container would differ from it at exactly the lengths where it
        // counted. The wide shapes add siblings beside the chain: a sibling is one
        // hop below the list that holds it, and it is no hop for another sibling,
        // so a list of three costs what a list of one does.
        for (const shape of SHAPES.filter((s) => s !== 'direct')) {
            for (const endJs of [false, true]) {
                const direct = swept[`direct:${endJs}`];
                const differs = [];
                swept[`${shape}:${endJs}`].forEach((s, hops) => {
                    if (JSON.stringify(s) !== JSON.stringify(direct[hops])) differs.push(hops);
                });
                check(`parity: ${shape} /Next chains ending in ${endJs ? 'a script' : 'a URI'} answer exactly as direct ones do, at every length 0..${bound + 8}`,
                    differs.length === 0, `differs at ${differs.join(',')}`);
            }
        }
        // The lengths that matter, named: nothing, one, either side of what a list
        // used to cost, either side of the bound, and past it.
        for (const hops of [0, 1, 15, 16, 17, 31, 32, 33, 34]) {
            const expected = hops <= bound;
            const cells = [];
            for (const endJs of [false, true]) {
                for (const shape of ['direct', 'array']) cells.push([shape, endJs, swept[`${shape}:${endJs}`][hops]]);
            }
            const wrong = cells.filter(([, , s]) => !(
                (s.js === 'SAFE') === expected && (s.readability === 'READABLE') === expected
                && s.extract === (expected ? 'READY' : UNSCAN) && s.intake === (expected ? 'ACCEPTED' : UNSCAN)
                && s.run === 'READY' && s.after?.pages === partnerPages + (expected ? 1 : 0) && s.after?.javascript === 0));
            const unequal = ['false', 'true'].filter((e) => JSON.stringify(swept[`direct:${e}`][hops]) !== JSON.stringify(swept[`array:${e}`][hops]));
            check(`matrix: ${hops} hops — direct and /Next list give one answer at every reader and step, and it is ${expected ? 'read to the end' : UNSCAN}`,
                wrong.length === 0 && unequal.length === 0,
                `wrong=${wrong.map(([sh, e]) => `${sh}${e ? '-js' : ''}`).join(',')} unequal=${unequal.join(',')}`);
        }
        // A list inside a list is not an action graph, and correcting the depth did
        // not make it one: it is refused at every length, next to the boundary too.
        {
            const off = [];
            for (const hops of [1, 2, 16, 17, 32, 33]) {
                const s = await call('r12Sweep', 'nested-array', hops, false);
                if (!(s.js === 'UNSCANNABLE' && s.extract === UNSCAN && s.intake === UNSCAN
                    && s.run === 'READY' && s.after?.pages === partnerPages)) off.push(`${hops}:${JSON.stringify(s)}`);
            }
            check('control: a /Next list inside a /Next list is refused at 1, 2, 16, 17, 32 and 33 hops, by the JavaScript assessment, Extract and intake',
                off.length === 0, off.slice(0, 2).join(' | ').slice(0, 300));
        }

        // ---- the run-time backstop, and the invariant it now has nothing to disagree about
        //
        // Every fixture there is, one at a time beside a source that is fine: what
        // intake accepted, the run must not then refuse as UNSCANNABLE_ACTIONS. The
        // check is meaningful only if the sweep saw both kinds of source.
        const everything = fs.readdirSync(path.join(ROOT, 'test-fixtures', 'm6-split-merge-production'))
            .filter((f) => f.endsWith('.pdf')).map((f) => f.slice(0, -4)).sort();
        let accepted = 0;
        let refusedUnscannable = 0;
        const stopped = [];
        for (const name of everything) {
            const p = await call('r12Parity', name);
            if (p.intake === 'ACCEPTED') {
                accepted += 1;
                if (p.run === UNSCAN) stopped.push(name);
            }
            if (p.intake === UNSCAN) refusedUnscannable += 1;
        }
        check(`parity: of every fixture there is (${everything.length}), none that Merge accepted at intake stops the run as ${UNSCAN}`,
            stopped.length === 0 && everything.length >= 407, stopped.join(', ') || `${accepted} accepted`);
        probe('parity: the sweep is not vacuous — it met sources Merge accepted and sources it refused as unscannable',
            accepted >= 100 && refusedUnscannable >= 10, `accepted=${accepted} unscannable=${refusedUnscannable}`);

        // The backstop is still there: bytes that are not the bytes intake saw.
        const control = await call('r12Swap', 'merge-b', 'merge-b');
        probe('backstop: the swap harness is not refusing everything — the same bytes run', control.run === 'READY', `run=${control.run}`);
        for (const fixture of ['r12-c-annot-dangling-aa', 'r12-f-next-33']) {
            const swapped = await call('r12Swap', 'merge-b', fixture);
            check(`backstop: ${fixture}, handed to the run in place of what intake saw, is still refused`,
                swapped.bytes === null && [UNSCAN, 'PLAN_RUNTIME_MISMATCH'].includes(swapped.run),
                `run=${swapped.run}`);
        }
    }

    // ---- 34. local only ------------------------------------------------------
    console.log('\n=== 34. local only ===');
    check('no request left the machine', external.length === 0, external.join(', '));
    check('no page error during the run', pageErrors.length === 0, pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.name}`);
    }
    exitCode = failed.length === 0 ? 0 : 1;
} finally {
    await browser.close();
    await server.close();
}
process.exit(exitCode);
