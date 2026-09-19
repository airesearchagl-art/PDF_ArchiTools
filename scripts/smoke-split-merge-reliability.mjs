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
        && shallow.count === 1
        && shallow.scrubbed === 1,
        `complete ${shallow.censusComplete}, count ${shallow.count}, `
        + `scrubbed ${shallow.scrubbed}`);

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
