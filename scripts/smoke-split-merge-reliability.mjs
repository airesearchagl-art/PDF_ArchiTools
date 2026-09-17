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

    const emptySigMerge = await call('mergeAndInspect', ['rem-inherited-sig-field', 'merge-b'], null);
    check('an empty signature field is removed, and the loss is named',
        emptySigMerge.status === 'READY'
        && (emptySigMerge.losses ?? []).some((l) => l.kind === 'applied-signature'),
        `${emptySigMerge.status}, losses `
        + JSON.stringify((emptySigMerge.losses ?? []).map((l) => l.kind)));

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

    // ---- 23. local only ------------------------------------------------------
    console.log('\n=== 23. local only ===');
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
