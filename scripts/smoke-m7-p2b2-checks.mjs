/**
 * M7-P2-B2 checks, run by scripts/smoke-m7-p1.mjs after the M7-P2-B1
 * sections, in the same browser and against the same Vite dev server.
 *
 * W0 first (the safety proof the rest stands on): the preview owner's page
 * sections and its release -- every render ended before the destruction is
 * asked for, the cleanup before it recorded as said, the release confirmed
 * only by what PDF.js reports, a page request that never answers or a
 * deadline that passes ending as RELEASE_UNCONFIRMED -- and the confirmation
 * evidence: what a handle is bound to, and that every change to any of it,
 * from inside the store or outside it, stops it confirming. Then the crop
 * limits (H-16), the rotations (SF-01), and the operation lock (B2-D02).
 *
 * The harness (smoke-m7-p2b2-harness.html) drives the Production modules
 * and returns plain data. Delays are deferreds it settles itself and the
 * release deadline is fired by hand through the owner's test seam, so no
 * outcome here depends on a timer. Everything is decided here.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, '$1');

/** Files under `dir` (recursively) whose comment-stripped text matches `pattern`, relative to ROOT. */
function filesMatching(ROOT, dir, pattern, exts = /\.(ts|tsx)$/) {
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (exts.test(entry.name) && pattern.test(strip(fs.readFileSync(p, 'utf8')))) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
    };
    walk(path.join(ROOT, dir));
    return out.sort();
}

/** The ledger static gate (N-B4): which files call the ledger's mutating methods, or ask the store for it. */
export const LEDGER_CALL = /\.(present|presentVerified|settle|beginCheck|releaseRetired)\(|\bbindingLedger\(\)/;
export const LEDGER_CALLERS_ALLOWED = ['src/utils/drawing-set/currency.ts', 'src/utils/drawing-set/workspace-store.ts'];

/** The 8b825b2 owner, written where the harness can import it (N-A8). False when this checkout lacks that commit. */
function writeBaseline(ROOT) {
    const target = path.join(ROOT, 'test-fixtures', 'm7-p2b2', 'baseline-preview-document.ts');
    try {
        const text = execFileSync('git', ['show', '8b825b2fcd197c4b765e2f4f7d905ae6319e321f:src/utils/drawing-set/preview-document.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
        const rewritten = text
            .replace(/from '\.\.\/([^']+)'/g, "from '/src/utils/$1.ts'")
            .replace(/from '\.\/([^']+)'/g, "from '/src/utils/drawing-set/$1.ts'");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, rewritten);
        return true;
    } catch {
        if (fs.existsSync(target)) fs.rmSync(target);
        return false;
    }
}

export async function runP2b2Checks(ctx) {
    const { page, ROOT, ORIGIN, check, probe, note, section } = ctx;
    const baselineWritten = writeBaseline(ROOT);

    await page.goto(`${ORIGIN}/scripts/smoke-m7-p2b2-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m7p2b2Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m7p2b2[f](...a), fn, args);
    const order = (steps, ...names) => names.every((n, i) => i === 0 || steps.indexOf(n) > steps.indexOf(names[i - 1])) && names.every((n) => steps.includes(n));

    // ------------------------------------------------------------------
    section('37. W0 -- the preview owner releases in order: renders ended, page cleaned up, then the destruction (HA-A, A-D1)');
    const ow = await call('ownerRelease');
    const a1 = ow.NA1;
    check('N-A1 a crop render running at close(): the destruction is not asked for until the render has ended and the page was cleaned up',
        !a1.atClose.destroyAsked && order(a1.order, 'render-RenderingCancelledException', a1.order.find((e) => e.startsWith('cleanup')), 'destroy-asked', 'destroy-done')
        && order(a1.record.steps, 'abort', a1.record.steps.find((e) => e.startsWith('cleanup-')), 'drained', 'destroy-asked', 'destroy-resolved', 'released'), `${a1.order.join(' > ')} | ${a1.record.steps.join(' > ')}`);
    check('N-A1 ...released: every render ended (E-END), the destruction resolved with no page request unanswered (E-REL), nothing left live',
        a1.record.renderEnded && a1.record.destroy === 'resolved' && a1.record.outcome === 'released' && a1.record.pageRequestsAtRelease === 0
        && a1.counts.live === 0 && a1.unconfirmed === false && a1.deadlineDisarmed, JSON.stringify(a1.record));
    check('N-A13.2 the owner\'s cancel reaches renderRegion: it rejects with RenderingCancelledException inside the drain, and the section rejects CLOSED',
        a1.cropError === 'RenderingCancelledException' && a1.outcome.ok === false && a1.outcome.code === 'CLOSED', `${a1.cropError}; ${JSON.stringify(a1.outcome)}`);
    check('N-A13.3 the canvas renderRegion made is the one registered, and the owner zeroes it once the stopped render has ended',
        a1.canvasWasTheRendered && a1.canvasZeroed === true);
    check('N-A13.4 renderRegion asked for render() once, and drew nothing more after it was stopped', a1.ranRender === 1, String(a1.ranRender));
    note('E-PRE as PDF.js reported it for that cancelled render (recorded, not asserted)', String(a1.record.cleanupBeforeDestroy));

    const a2 = ow.NA2_never;
    check('N-A2 a page request that never settles: close() does not wait for it, and resolves',
        a2.closed === 'resolved' && a2.runCalls === 0 && a2.sectionOutcome.code === 'CLOSED', JSON.stringify({ closed: a2.closed, runCalls: a2.runCalls }));
    check('N-A2 ...the request still unanswered when PDF.js reported the document destroyed: RELEASE_UNCONFIRMED (no timeout taken as a release)',
        a2.record.failure === 'PAGE_REQUEST_PENDING' && a2.record.outcome === 'unconfirmed' && a2.record.destroy === 'resolved' && a2.record.pageRequestsAtRelease === 1 && a2.unconfirmed,
        JSON.stringify(a2.record));
    check('N-A2 ...and from then on the page gate opens nothing: preview, intake and extraction refused, with the reload message',
        a2.after.open === 'RELEASE_UNCONFIRMED' && a2.after.intake === 'RELEASE_UNCONFIRMED' && a2.after.extraction === 'RELEASE_UNCONFIRMED', JSON.stringify(a2.after));
    const a2b = ow.NA2_rejectBeforeDestroy;
    check('N-A2b the request rejected before the destruction resolved: E-REL holds, released, the gate goes on',
        a2b.record.outcome === 'released' && a2b.record.pageRequestsAtRelease === 0 && !a2b.unconfirmed && a2b.after.open === 'opened' && a2b.runCalls === 0, JSON.stringify(a2b.record));
    const a2c = ow.NA2_resolveBeforeDestroy;
    check('N-A2c the page arrived between the destruction asked for and resolved: nothing drawn from it, E-REL holds, released',
        a2c.record.outcome === 'released' && a2c.runCalls === 0 && !a2c.unconfirmed && a2c.after.open === 'opened', JSON.stringify(a2c.record));

    const a3 = ow.NA3;
    check('N-A3 sections waiting at close() are refused CLOSED and never ask for a page; only the running one did',
        a3.waitingOutcomes.every((o) => o.ok === false && o.code === 'CLOSED') && JSON.stringify(a3.pageRequests) === '[1]', JSON.stringify(a3.pageRequests));
    check('N-A3 ...while the running section has not ended, the destruction is not asked for; once it ends, it is, and the release completes',
        !a3.whileRunning.destroyAsked && a3.whileRunning.destroy === 'none' && a3.first.code === 'CLOSED' && a3.record.outcome === 'released'
        && order(a3.record.steps, 'abort', 'drained', 'destroy-asked'), `${JSON.stringify(a3.whileRunning)} | ${a3.record.steps.join(' > ')}`);
    check('N-A4 switching Source during a crop: A\'s render ended, its page cleaned up and its document destroyed before B\'s read began',
        order(ow.NA4.order, 'render-RenderingCancelledException', 'destroy-asked', 'destroy-done', 'B-read-begins') && ow.NA4.bPages > 0 && ow.NA4.record.outcome === 'released',
        ow.NA4.order.join(' > '));
    const a6 = ow.NA6;
    check('N-A6 extraction asked for during a crop: the lease is handed over only after the drain and the destruction -- no preview document live then',
        a6.atLease.ok && a6.atLease.previewLive === 0 && a6.atLease.record.outcome === 'released' && a6.section.code === 'CLOSED' && !a6.extractionActive,
        JSON.stringify({ live: a6.atLease.previewLive, steps: a6.atLease.record.steps }));
    const a7 = ow.NA7;
    check('N-A7 the destruction fails after the drain: RELEASE_UNCONFIRMED, and every later section, open, intake and extraction is refused',
        a7.record.failure === 'DESTROY_FAILED' && order(a7.record.steps, 'drained', 'destroy-asked', 'destroy-failed') && a7.sectionAfter.code === 'RELEASE_UNCONFIRMED'
        && a7.after.open === 'RELEASE_UNCONFIRMED' && a7.after.intake === 'RELEASE_UNCONFIRMED' && a7.after.extraction === 'RELEASE_UNCONFIRMED' && a7.documentsUnavailable,
        JSON.stringify(a7.record));

    const a9 = ow.NA9;
    check('N-A9 renderRegion through a section\'s page draws exactly what it draws from the real page (same size, same pixels)',
        a9.viaSection.width === a9.oracle.width && a9.viaSection.height === a9.oracle.height && a9.viaSection.digest === a9.oracle.digest,
        `${a9.viaSection.width}x${a9.viaSection.height}`);
    check('N-A13.1 renderRegion asks the section\'s page for getViewport and render, and nothing else',
        a9.accessed.length > 0 && a9.accessed.every((p) => p === 'getViewport' || p === 'render'), a9.accessed.join(','));
    probe('the section\'s page refuses anything else (cleanup, rotate, commonObjs throw), is not a thenable, and refuses to draw once its section ended (CLOSED)',
        a9.askedForCleanup === 'TypeError' && a9.askedForRotate === 'TypeError' && a9.askedForCommonObjs === 'TypeError' && a9.thenable === 'undefined' && a9.renderAfterEnd === 'CLOSED',
        JSON.stringify(a9));

    const a12 = ow.NA12;
    check('N-A12 a render that never settles after its cancel: the drain does not end, and the destruction is not asked for -- nothing times out into a release',
        !a12.beforeDeadline.closeSettled && !a12.beforeDeadline.destroyAsked && a12.beforeDeadline.record.outcome === 'pending' && a12.beforeDeadline.deadlines === 1,
        JSON.stringify(a12.beforeDeadline));
    check('N-A12 ...the deadline passes: RELEASE_UNCONFIRMED at once, close() resolves, the extraction waiting on it is refused, the destruction asked for anyway',
        a12.afterDeadline.closeSettled && a12.afterDeadline.extraction === 'RELEASE_UNCONFIRMED' && a12.afterDeadline.record.failure === 'DEADLINE'
        && a12.afterDeadline.record.outcome === 'unconfirmed' && a12.afterDeadline.unconfirmed && a12.afterDeadline.withPage === 'RELEASE_UNCONFIRMED'
        && a12.destroyAskedAfter && a12.afterDeadline.counts.releaseDeadlineExpired === 1, JSON.stringify(a12.afterDeadline.record));

    const a14 = ow.NA14_released;
    check('N-A14a page.cleanup() false before the destruction: recorded as "deferred", never counted as cleaned; released; the next Source opens normally',
        a14.record.cleanupBeforeDestroy === 'deferred' && a14.record.outcome === 'released' && !a14.unconfirmed && a14.next.startsWith('opened')
        && a14.counts.cleanupConfirmed === 0 && a14.counts.cleanupDeferred >= 1, JSON.stringify({ record: a14.record, next: a14.next }));
    const a14b = ow.NA14_destroyFails;
    check('N-A14b cleanup() false and then the destruction fails: RELEASE_UNCONFIRMED (the deferred cleanup does not count for anything)',
        a14b.record.cleanupBeforeDestroy === 'deferred' && a14b.record.failure === 'DESTROY_FAILED' && a14b.unconfirmed && a14b.next === 'RELEASE_UNCONFIRMED', JSON.stringify(a14b.record));
    const a14c = ow.NA14_pageRequestPending;
    check('N-A14c cleanup() false and a page request still unanswered when the document is destroyed: RELEASE_UNCONFIRMED',
        a14c.record.cleanupBeforeDestroy === 'deferred' && a14c.record.failure === 'PAGE_REQUEST_PENDING' && a14c.unconfirmed && a14c.next === 'RELEASE_UNCONFIRMED', JSON.stringify(a14c.record));
    note('E-PRE with PDF.js itself after a render cancelled part-way (recorded, not asserted; the release is judged after)',
        `${ow.NA14_real.record.cleanupBeforeDestroy}; outcome ${ow.NA14_real.record.outcome}`);
    check('N-A15 page.cleanup() throws: RELEASE_UNCONFIRMED even though the destruction then succeeds',
        ow.NA15.record.cleanupBeforeDestroy === 'threw' && ow.NA15.record.failure === 'CLEANUP_THREW' && ow.NA15.destroyed && ow.NA15.unconfirmed
        && ow.NA15.after.open === 'RELEASE_UNCONFIRMED', JSON.stringify(ow.NA15.record));
    check('N-A16 RenderTask.cancel() throws: RELEASE_UNCONFIRMED at once, and it stays so after the render ends and the destruction succeeds',
        ow.NA16.atCancel.unconfirmed && ow.NA16.record.failure === 'CANCEL_THREW' && ow.NA16.destroyed && ow.NA16.unconfirmed, JSON.stringify(ow.NA16.record));
    check('N-A17 the destruction\'s promise never settles: the deadline makes it RELEASE_UNCONFIRMED, close() resolves, the waiting extraction is refused',
        !ow.NA17.before.closeSettled && ow.NA17.before.destroyAsked && !ow.NA17.before.unconfirmed && ow.NA17.closeSettled && ow.NA17.extraction === 'RELEASE_UNCONFIRMED'
        && ow.NA17.record.failure === 'DEADLINE' && ow.NA17.after.open === 'RELEASE_UNCONFIRMED' && ow.NA17.after.intake === 'RELEASE_UNCONFIRMED', JSON.stringify(ow.NA17.record));
    const a18 = ow.NA18;
    check('N-A18 the release finishes after the deadline: recorded (destroy-resolved after the deadline), and nothing is given back -- still RELEASE_UNCONFIRMED',
        a18.atDeadline.unconfirmed && a18.late.record.destroy === 'resolved' && a18.late.record.failure === 'DEADLINE' && a18.late.record.outcome === 'unconfirmed'
        && order(a18.late.record.steps, 'destroy-asked', 'deadline', 'destroy-resolved') && a18.late.unconfirmed && a18.late.live === 0 && a18.after.open === 'RELEASE_UNCONFIRMED',
        a18.late.record.steps.join(' > '));
    const a19 = ow.NA19;
    check('N-A19 a release confirmed in time disarms its deadline; firing it afterwards changes nothing; the next Source opens',
        a19.atRelease.disarmed && a19.atRelease.record.outcome === 'released' && a19.afterLateFire.record.outcome === 'released' && !a19.afterLateFire.unconfirmed
        && a19.afterLateFire.expired === 0 && a19.next.startsWith('opened'), JSON.stringify(a19.afterLateFire));
    check('the deadline is 5,000 ms (N-A12, Human adopted), and the page\'s owner is the Production class', ow.deadlineMs === 5000 && ow.pageOwnerUsesDefaults);

    // N-A8: the owner as it was.
    if (baselineWritten) {
        const bl = await call('baseline');
        if (bl.available) {
            check('N-A8 (counterexample) the owner before this change asked for the destruction while the render was still running, and the page could be cleaned up only after it -- false',
                bl.atClose.destroyAsked && !bl.atClose.renderSettled && order(bl.order, 'destroy-asked', 'render-RenderingCancelledException') && bl.order.includes('viewer-cleanup:false'),
                bl.order.join(' > '));
        } else {
            note('N-A8 (counterexample) NOT RUN: the 8b825b2 owner could not be loaded', bl.reason);
        }
    } else {
        note('N-A8 (counterexample) NOT RUN: commit 8b825b2 is not in this checkout (a shallow clone)', 'run locally for the before-evidence');
    }

    const vc = await call('viewerAndCrop');
    check('N-A10 the viewer and a crop of the same document take turns: never two renders at once; the viewer redrawn during the crop waits for it',
        vc.peak === 1 && vc.whileCrop.active === 1 && vc.whileCrop.viewerState === 'loading' && vc.events.includes('start:print'), `peak ${vc.peak}; ${vc.events.join(' ')}`);
    check('N-A10 ...every render begun ended exactly once (completed, cancelled or failed), counted by the owner',
        vc.counts.renderStarted === vc.counts.renderCompleted + vc.counts.renderCancelled + vc.counts.renderFailed && vc.counts.renderFailed === 0
        && vc.counts.sectionsStarted === vc.counts.sectionsEnded, JSON.stringify(vc.counts));
    check('N-A10 ...and the document is released cleanly afterwards', vc.record.outcome === 'released' && vc.final.live === 0);
    const viewerSource = strip(fs.readFileSync(path.join(ROOT, 'src', 'components', 'drawing-set', 'ReadOnlySheetViewer.tsx'), 'utf8'));
    probe('the viewer neither fetches a page nor cleans one up itself: only through the owner\'s page sections',
        !/\.cleanup\(|getPage\(|noteRender/.test(viewerSource) && /withPage\(/.test(viewerSource));
    check('no PDF.js document or recogniser left running by the W0 runs', ow.workers.pdf.live === 0 && ow.workers.ocr.live === 0, JSON.stringify(ow.workers));

    // ------------------------------------------------------------------
    section('38. W0 -- confirmation evidence (B-alpha, HD-B-03 A+B+C): bound to what was shown, and refused when any of it moved');
    const ev = await call('evidence');
    check('a Sheet with a CURRENT observation and MATCHED File: crops of its four fields drawn and placed, evidence issued, the Sheet confirmed with its profile',
        ev.issued.ok && ev.issued.canvasesInSlots && ev.observation.currency === 'CURRENT' && ev.confirmed.ok && ev.confirmed.profile !== null
        && JSON.stringify(ev.confirmed.editedFields) === '[]', JSON.stringify({ issued: ev.issued.ok, confirmed: ev.confirmed }));
    check('N-C12 the same evidence confirms once: again -- EVIDENCE_STALE', ev.spentAgain.ok === false && ev.spentAgain.code === 'EVIDENCE_STALE', JSON.stringify(ev.spentAgain));
    check('a value a person corrected: confirmed against the observation (profile named), the corrected field in editedFields (HDR-36-01), never as manual',
        ev.corrected.ok && ev.corrected.profile !== null && JSON.stringify(ev.corrected.editedFields) === '["drawingTitle"]', JSON.stringify(ev.corrected));
    check('N-B1 the same File presented again from outside the store, then checked back to MATCHED: the generation did not move, yet the old evidence is refused (the ledger\'s stamp moved)',
        ev.NB1.presented === 'APPLIED' && ev.NB1.backTo === 'APPLIED' && ev.NB1.binding === 'MATCHED' && ev.NB1.generationMoved === false && ev.NB1.result.code === 'EVIDENCE_STALE', JSON.stringify(ev.NB1));
    check('N-B2 the File let go of from outside (releaseRetired): SOURCE_NOT_MATCHED', ev.NB2_releaseRetired.binding === 'UNBOUND' && ev.NB2_releaseRetired.result.code === 'SOURCE_NOT_MATCHED',
        JSON.stringify(ev.NB2_releaseRetired));
    check('N-B2 / N-B11 a CHANGED check settled from outside: the binding is asked first -- SOURCE_NOT_MATCHED', ev.NB2_changed.settled === 'APPLIED' && ev.NB2_changed.binding === 'CHANGED'
        && ev.NB2_changed.result.code === 'SOURCE_NOT_MATCHED', JSON.stringify(ev.NB2_changed));
    check('N-B3 the preview read the File again and a new check was settled: the old evidence is refused', ev.NB3.result.code === 'EVIDENCE_STALE', JSON.stringify(ev.NB3));
    check('N-B5 the panel hidden (display:none) and shown again: the evidence was taken back when the crops lost their size -- refused',
        ev.NB5.result.ok === false && ['CROP_NOT_SHOWN', 'EVIDENCE_STALE'].includes(ev.NB5.result.code), JSON.stringify(ev.NB5));
    check('N-B6 a crop stopped while drawing, and a crop render that fails: no evidence; nothing placed',
        !ev.NB6_cancelled.ok && ev.NB6_cancelled.code === 'EVIDENCE_STALE' && !ev.NB6_failed.ok && ev.NB6_failed.code === 'CROP_NOT_SHOWN' && ev.NB6_failed.inSlots === 0,
        JSON.stringify({ c: ev.NB6_cancelled, f: ev.NB6_failed }));
    check('N-B7 another Sheet\'s crops drawn: the first Sheet\'s evidence is taken back (one Sheet at a time) -- refused', ev.NB7.otherIssued && ev.NB7.result.code === 'EVIDENCE_STALE');
    check('N-C1 another Sheet\'s evidence for this Sheet: refused', ev.NC1?.result.code === 'EVIDENCE_STALE');
    check('N-B8 a new digest presented from outside (presentVerified): MATCHED, and the old evidence refused', ev.NB8.presented === 'APPLIED' && ev.NB8.binding === 'MATCHED'
        && ev.NB8.result.code === 'EVIDENCE_STALE', JSON.stringify(ev.NB8));
    check('N-B9 the File\'s bytes changed (CHANGED) and restored (MATCHED again): evidence from before is refused', ev.NB9.changed === 'APPLIED' && ev.NB9.bindingChanged === 'CHANGED'
        && ev.NB9.back === 'reconnected' && ev.NB9.binding === 'MATCHED' && ev.NB9.result.code === 'EVIDENCE_STALE', JSON.stringify(ev.NB9));
    check('N-B10 the ledger\'s stamp: frozen, two numbers only, a new object each call; writing to it throws and changes nothing; nothing held -- null',
        ev.NB10.frozen && JSON.stringify(ev.NB10.keys) === '["presentedAt","checkedAt"]' && ev.NB10.types.every((t) => t === 'number') && ev.NB10.distinct
        && ev.NB10.wrote === 'TypeError' && ev.NB10.unchanged && ev.NB10.none === null && ev.NB10.noFile, JSON.stringify(ev.NB10));
    check('N-C3 the Sheet read again (a new run) after the evidence: refused', ev.NC3.run === 'COMPLETED' && ev.NC3.result.ok === false, JSON.stringify(ev.NC3));
    check('N-C4 the profile revised after the evidence: refused; and the old reading is never paired with the new rectangles -- no crop drawn (OBSERVATION_NOT_CURRENT)',
        ev.NC4.revised && ev.NC4.result.code === 'EVIDENCE_STALE' && ev.NC4.prepareAfter === 'OBSERVATION_NOT_CURRENT' && ev.NC4.canvasesMade === 0 && ev.NC4.currency === 'STALE_PROFILE',
        JSON.stringify(ev.NC4));
    probe('N-C9 evidence not issued by this store: a look-alike object, one made from the prototype, another store\'s -- EVIDENCE_STALE; forging one throws',
        ev.NC9.lookalike.code === 'EVIDENCE_STALE' && ev.NC9.prototyped.code === 'EVIDENCE_STALE' && ev.NC9.anotherStores.code === 'EVIDENCE_STALE' && ev.NC9.forged === 'TypeError',
        JSON.stringify(ev.NC9));
    check('N-C10 a crop hidden (visibility) or transparent (opacity 0): CROP_NOT_SHOWN', ev.NC10_hidden.code === 'CROP_NOT_SHOWN' && ev.NC10_transparent.code === 'CROP_NOT_SHOWN',
        JSON.stringify([ev.NC10_hidden, ev.NC10_transparent]));
    check('N-C11 a crop taken out of the page after the evidence was issued: CROP_NOT_SHOWN', ev.NC11_removed.code === 'CROP_NOT_SHOWN', JSON.stringify(ev.NC11_removed));
    check('N-C13 the File withdrawn and the same bytes chosen again (another presentation, MATCHED): the old evidence is refused',
        ev.NC13.back === 'reconnected' && ev.NC13.binding === 'MATCHED' && ev.NC13.result.code === 'EVIDENCE_STALE', JSON.stringify(ev.NC13));
    check('N-C16 an OCR_FAILED reading: values typed in still need the crops (no evidence -- refused), and with them all four fields are recorded as edited',
        ev.NC16.status === 'OCR_FAILED' && ev.NC16.sources.every((x) => x === 'none') && ev.NC16.without === 'EVIDENCE_STALE' && ev.NC16.withCrop.ok
        && JSON.stringify(ev.NC16.withCrop.editedFields) === JSON.stringify(FIELDS) && ev.NC16.withCrop.profile !== null, JSON.stringify(ev.NC16));
    check('H-13 a Sheet with no profile: no crop can be drawn and nothing confirms it (CROP_NOT_AVAILABLE), with or without evidence',
        ev.cropNotAvailable.prepared === 'CROP_NOT_AVAILABLE' && ev.cropNotAvailable.direct === 'CROP_NOT_AVAILABLE', JSON.stringify(ev.cropNotAvailable));
    check('N-C8 every confirmation the store made names its profile (none is profile: null)', ev.allConfirmationsHaveProfile && ev.confirmationCount >= 3, `${ev.confirmationCount} confirmations`);
    probe('N-C5 there is no bulk confirmation on the store', ev.bulk.confirmSheets === 'undefined' && ev.bulk.confirmAll === 'undefined');

    // ------------------------------------------------------------------
    section('39. W0 -- crops: the limits (H-16) before any canvas, the rotations (SF-01), the sizes (N-R3, N-R12, N-R13)');
    const nr3 = ev.NR3;
    check('H-16 limits as adopted: 300 dpi, 8192 px a side, 4,000,000 px a field, 16,777,216 px in all',
        nr3.constants.dpi === 300 && nr3.constants.maxSidePixels === 8192 && nr3.constants.maxFieldPixels === 4000000 && nr3.constants.maxTotalPixels === 16777216);
    check('N-R3 a field past 4,000,000 px on a real Sheet: CROP_TOO_LARGE -- no canvas made, no render started, nothing placed, no evidence',
        nr3.pipeline.plan?.limit === 'field' && nr3.pipeline.code === 'CROP_TOO_LARGE' && nr3.pipeline.canvasesMade === 0 && nr3.pipeline.rendersStarted === 0 && nr3.pipeline.inSlots === 0,
        JSON.stringify(nr3.pipeline));
    check('N-R3 each limit at its edge, as planned: a side of 8209 px refused and 8192 kept; 4,010,000 px refused and 3,984,016 kept; planning makes no canvas',
        nr3.side.exceeds?.limit === 'side' && nr3.side.title[0] === 8209 && nr3.sideOk.exceeds === null && nr3.sideOk.title[0] === 8192
        && nr3.field.exceeds?.limit === 'field' && nr3.fieldOk.exceeds === null && nr3.planningMadeCanvases === 0, JSON.stringify(nr3));
    note('the total limit cannot be passed while each of four fields keeps to 4,000,000 px (4 x 4,000,000 < 16,777,216); four fields at 3,984,016 px each', `total ${nr3.fourAtLimit.total}, exceeds ${JSON.stringify(nr3.fourAtLimit.exceeds)}`);
    const rows = ev.NR12;
    check('N-R12 every rotation and CropBox offset (8 pages): crops drawn at rotation 0 are exactly the upright oracle\'s pixels, the sizes worked out beforehand',
        rows.length === 8 && rows.every((r) => !r.refused && FIELDS.every((n) => r.fields[n].sameAsOracle && r.fields[n].planned.join() === r.fields[n].drawn.join())),
        JSON.stringify(rows.map((r) => r.refused ?? r.page)));
    check('N-R12 ...turned for display by CSS only, by the page\'s own /Rotate, the frame swapped for quarter turns',
        rows.every((r) => r.rotate === r.factsRotate && r.rotate === r.pdfRotate && FIELDS.every((n) => r.fields[n].transform.includes(`rotate(${r.rotate}deg)`)
            && (r.rotate % 180 === 90 ? parseFloat(r.fields[n].frame[0]) === r.fields[n].drawn[1] * 0.5 : parseFloat(r.fields[n].frame[0]) === r.fields[n].drawn[0] * 0.5))),
        JSON.stringify(rows.map((r) => [r.page, r.rotate])));
    const inked = rows.flatMap((r) => FIELDS.map((n) => r.fields[n])).filter((f) => f.dark > 50);
    check('N-R12 ...and turned that way the crop shows what the page shows there as displayed: it agrees with the displayed region far better than turned the other way',
        inked.length >= 8 && inked.every((f) => f.likeDisplayed >= 0.8 && f.likeDisplayed > f.likeDisplayedWrongWay + 0.2),
        JSON.stringify(inked.map((f) => [Number(f.likeDisplayed.toFixed(2)), Number(f.likeDisplayedWrongWay.toFixed(2))])));
    probe('N-R13 renderRegion handed a page box other than the one planned: the sizes disagree -- CROP_NOT_SHOWN, nothing placed',
        !ev.NR13_injected.ok && ev.NR13_injected.code === 'CROP_NOT_SHOWN' && ev.NR13_injected.inSlots === 0, JSON.stringify(ev.NR13_injected));

    // ------------------------------------------------------------------
    const geometryTruth = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures', 'm7-p2a', 'manifest.json'), 'utf8')).files.find((f) => f.name === 'p2a-geometry').truth;
    const pt = await call('pointer', geometryTruth);
    const zooms = [...new Set(pt.rows.map((r) => r.cssScale.toFixed(3)))].length;
    check('T-01 / H-12 every rotation (0/90/180/270), with and without a CropBox offset, at three zooms: the viewer reports the page\'s own /Rotate and upright size',
        pt.rows.length === 24 && pt.rows.every((r) => r.viewerRotate === r.rotate && Math.abs(r.upright.width - r.uprightTruth.width) < 0.01 && Math.abs(r.upright.height - r.uprightTruth.height) < 0.01)
        && zooms >= 3, `${pt.rows.length} cases, ${zooms} scales`);
    check('H-12 ...a profile rectangle lands on screen where the generator put it on the displayed page, within 1 CSS px',
        pt.rows.every((r) => r.worstToTruth <= 1), `worst ${Math.max(...pt.rows.map((r) => r.worstToTruth)).toFixed(4)} CSS px`);
    check('H-12 ...and a drag over it comes back to the same upright rectangle, within 1 CSS px (the contract\'s 0.01 pt is a separate rule)',
        pt.rows.every((r) => r.worstRoundTrip <= 1), `worst ${Math.max(...pt.rows.map((r) => r.worstRoundTrip)).toFixed(6)} CSS px`);

    section('40. W0 -- sessions: reset and leaving while crops are drawn; an old session\'s page arriving late (N-A5, N-A11)');
    const se = await call('sessions');
    for (const how of ['reset', 'leave']) {
        const r = se[`NA5_${how}`];
        check(`N-A5 ${how} while a crop draws: the crop is stopped, no evidence, nothing placed, the document released in order`,
            r.result === 'EVIDENCE_STALE' && r.cropsInSlots === 0 && r.record.outcome === 'released' && r.record.renderEnded, JSON.stringify(r));
    }
    check('N-A11 a page request of the old session answered after reset: no evidence, nothing placed, and the new session\'s snapshot and generation do not move',
        se.NA11.result === 'EVIDENCE_STALE' && se.NA11.crops === 0 && se.NA11.afterLate.version === se.NA11.afterReset.version
        && se.NA11.afterLate.generation === se.NA11.afterReset.generation && se.NA11.sheets === 0, JSON.stringify(se.NA11));

    // ------------------------------------------------------------------
    section('41. W3 -- the operation lock (B2-D02, Operation Matrix)');
    const lk = await call('lock');
    check('the lock is taken the moment extraction is asked for, before the gate is', lk.atStart.operation?.kind === 'extraction' && lk.atStart.operation.phase === 'starting', JSON.stringify(lk.atStart));
    const locked = Object.entries(lk.during).filter(([, code]) => code !== 'OPERATION_LOCKED');
    check('N-L1 / N-L4 while extraction runs, every command that would change what it reads is refused OPERATION_LOCKED (profiles, assignment, confirmation, withdrawal, removal, checking a File, intake, a second extraction, crops)',
        locked.length === 0 && Object.keys(lk.during).length === 13, locked.length ? JSON.stringify(locked) : Object.keys(lk.during).join(','));
    check('...the model is not touched, and the page gate itself still refuses intake and extraction (EXTRACTION_ACTIVE) under the lock',
        lk.modelUntouched && lk.gateStillRefuses.intake === 'EXTRACTION_ACTIVE' && lk.gateStillRefuses.extraction === 'EXTRACTION_ACTIVE', JSON.stringify(lk.gateStillRefuses));
    check('N-L2 cancel: idempotent, shown as cancelling; the run ends CANCELLED; nothing it reports afterwards is shown; the lock is let go and the preview may open again',
        lk.cancel.cancelling === 'cancelling' && lk.cancel.report === 'CANCELLED' && lk.cancel.progressAfterCancel === 0 && lk.cancel.operationAfter === null && lk.cancel.previewEpochMoved,
        JSON.stringify(lk.cancel));
    check('...after it, commands work again; cancelling with nothing running is a no-op', lk.afterUnlock.rename === 'ok' && lk.afterUnlock.cancelNothing === null, JSON.stringify(lk.afterUnlock));
    check('N-L3 a new Drawing Set while extraction runs: unlocked at once, the new session empty; the old run lands nowhere and none of its progress is shown',
        lk.NL3.afterReset.operation === null && lk.NL3.afterReset.sheets === 0 && lk.NL3.report.applied === false && lk.NL3.report.notApplied === 'SESSION_REPLACED'
        && lk.NL3.progressAfterReset === 0 && lk.NL3.runsNow === 0, JSON.stringify(lk.NL3));
    check('N-L5 extraction that throws: the lock is let go', lk.NL5.thrown === 'simulated' && lk.NL5.operation === null && lk.NL5.renameAfter === 'ok', JSON.stringify(lk.NL5));
    check('no PDF.js document or recogniser left running', lk.workers.pdf.live === 0 && lk.workers.ocr.live === 0 && se.workers.pdf.live === 0 && ev.workers.pdf.live === 0, JSON.stringify(lk.workers));

    // ------------------------------------------------------------------
    section('42. M7-P2-B2 static gates and privacy');
    let tsc = { ok: true, output: '' };
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'scripts', 'typecheck', 'tsconfig.json')], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
        tsc = { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(0, 600) };
    }
    const gateSource = fs.readFileSync(path.join(ROOT, 'scripts', 'typecheck', 'm7-p2b2-confirmation.ts'), 'utf8');
    const expected = (gateSource.match(/@ts-expect-error/g) ?? []).length;
    check(`N-C2 / N-C5 / N-C14 static gate: the ${expected} forms that would let the screen stand in for evidence (a shown/rendered flag, a basis, a snapshot, many Sheets, a forged handle) do not compile (tsc)`,
        tsc.ok && expected >= 10, tsc.output);
    const callers = filesMatching(ROOT, 'src', LEDGER_CALL);
    check('N-B4 the ledger is changed, and handed out, only by the store and its own module', JSON.stringify(callers) === JSON.stringify(LEDGER_CALLERS_ALLOWED), callers.join(', '));
    probe('N-B4 the gate catches a violation: a component that asks the store for its ledger and presents a File',
        LEDGER_CALL.test(strip('const l = store.bindingLedger(); l.present(set, id, file);')) && !LEDGER_CALL.test(strip('// store.bindingLedger()\nconst x = 1;')));
    const seams = filesMatching(ROOT, 'src', /\b(pageSource|releaseDeadline)\b/);
    const pageDocuments = strip(fs.readFileSync(path.join(ROOT, 'src', 'utils', 'drawing-set', 'page-documents.ts'), 'utf8'));
    check('the owner\'s test seams are in the owner only; the page\'s owner is made with the gate and nothing else',
        JSON.stringify(seams) === '["src/utils/drawing-set/preview-document.ts"]' && /new PreviewDocumentOwner\(\{ gate: PAGE_PDF_GATE \}\)/.test(pageDocuments), seams.join(', '));
    const manual = filesMatching(ROOT, 'src', /basis:\s*'manual'|'manual'\s+as\b/);
    check('H-13 nothing in the app asks for a manual confirmation (`basis: \'manual\'` appears only in the pure confirmSheet\'s own module)',
        manual.every((f) => f === 'src/utils/drawing-set/metadata-confirmation.ts'), manual.join(', '));
    const componentUpdates = filesMatching(ROOT, 'src/components', /\.update\(/);
    check('N-C6 no component writes the session with update(): the screen uses commands only', componentUpdates.length === 0, componentUpdates.join(', '));
    const exporters = filesMatching(ROOT, 'src/utils/drawing-set', /toDataURL|toBlob|createObjectURL/).concat(filesMatching(ROOT, 'src/components/drawing-set', /toDataURL|toBlob|createObjectURL/));
    probe('crops are never turned into images, data URLs or object URLs (M7 code)', exporters.length === 0, exporters.join(', '));
    const storage = await call('storage');
    check('these runs wrote nothing to browser storage, left no object URL, and exported no canvas',
        storage.writes.writes === 0 && storage.local === 0 && storage.session === 0 && storage.objectUrls === 0 && storage.exports.toDataURL === 0 && storage.exports.toBlob === 0,
        JSON.stringify(storage));
}
