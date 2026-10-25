/**
 * M7-ADV-VERIFY-01: the verification ADV-37-01 / ADV-37-03 still lacked, run by
 * scripts/smoke-m7-p1.mjs after the M7-P2-B2 sections, in the same browser and
 * against the same Vite dev server, through the same harness
 * (smoke-m7-p2b2-harness.html). Test only: nothing here changes the product,
 * the contract, the Version or the recogniser's cacheMethod.
 *
 * ADV-37-03, the paths a cancel takes, told apart:
 *   - RT  control: a real recognition of the raster title block, timed, and
 *         whether the Worker reports 'recognizing text' while it works;
 *   - R1  cancelled while a recognition is truly under way -- the Worker has
 *         reported recognising (0 < progress < 1) and has not answered;
 *   - R1L the same, the abandoned recognition given a short bound so what it
 *         does afterwards can be watched within the run;
 *   - R2P / R2S cancelled between two OCR pages of one Source / between two
 *         Sources;
 *   - R3T / R3N cancelled during a recognition while terminate() throws / never
 *         settles with the Worker's "closed" withheld;
 *   - ST:load / ST:loadLanguage / ST:initialize / ST:recognize cancelled at each
 *         stage of the recogniser's start, and during recognition.
 * For each: the Worker's end, the lock let go, anything done later, partial
 * results, and the region canvas -- each its own check.
 *
 * ADV-37-01: a confirmation through the readings after it (same basis, a
 * cancelled one, a failed one). The screen's half is in
 * smoke-m7-adv-verify-ui-checks.mjs.
 *
 * Gates are checks: they fail the run. A property an adopted decision does not
 * state, but which this verification set out to establish (the region canvas
 * let go by the time the lock is), is a FINDING: its criterion is fixed here,
 * its result is reported as PASS or FAIL, and a FAIL is a defect candidate for
 * the report -- it is not relaxed and not made to pass. Times are measurements
 * on this machine, never a target met.
 *
 * The evidence of the run is written to test-fixtures/m7-adv-verify/ (git-ignored).
 */
import fs from 'node:fs';
import path from 'node:path';

export async function runAdvVerifyChecks(ctx) {
    const { page, ROOT, ORIGIN, check, note, section } = ctx;
    const findings = [];
    const finding = (name, ok, detail = '') => {
        findings.push({ name, ok, detail });
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  FINDING ${name}  ${detail}`);
    };
    if (!page.__m7BrowserOcrWorkers) {
        await page.exposeFunction('__browserOcrWorkers', () => page.workers().filter((w) => /\/ocr\//.test(w.url())).length);
        page.__m7BrowserOcrWorkers = true;
    }
    await page.goto(`${ORIGIN}/scripts/smoke-m7-p2b2-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m7p2b2Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m7p2b2[f](...a), fn, args);
    const evidence = {};
    const ocr = async (which) => {
        const out = (await call('ocrInit', which))[which];
        evidence[which] = out;
        return out;
    };
    const j = (x) => JSON.stringify(x);
    const ended = (o) => o.counts && o.counts.unconfirmed === 0;

    // ------------------------------------------------------------------
    section('44. M7-ADV-VERIFY ADV-37-03 -- a real recognition, timed (control)');
    const RT = await ocr('RT');
    const recognitions = RT.runs.flatMap((r) => r.recognitions);
    check('control: three readings of the raster title block complete, each with one real recognition answered',
        RT.runs.every((r) => r.outcome === 'COMPLETED' && r.recognitions.length === 1 && r.recognitions[0].answered === 'resolve'), j(RT.runs));
    check('...and while it works the Worker reports \'recognizing text\' with 0 < progress < 1 (what R1 waits for before it cancels)',
        recognitions.every((r) => r.inside > 0), j(recognitions.map((r) => r.inside)));
    note('control: recognition asked → answered, ms (this machine, local dev server; a measurement, not a target)', j(recognitions.map((r) => r.ms)));

    // ------------------------------------------------------------------
    section('45. M7-ADV-VERIFY ADV-37-03 -- cancelled while a recognition is truly under way (R1, R1L)');
    for (const which of ['R1', 'R1L']) {
        const o = await ocr(which);
        const a = o.atCancel;
        const u = o.afterUnlock;
        const l = o.later;
        check(`${which} at the cancel the recognition was under way: asked, not answered, the Worker had reported recognising`,
            a.answeredRecognitions < a.askedRecognitions && a.progressReports > 0 && a.lastProgress > 0 && a.lastProgress < 1 && a.phase === 'running',
            j({ sinceAskedMs: a.sinceAskedMs, lastProgress: a.lastProgress, asked: a.askedRecognitions, answered: a.answeredRecognitions }));
        check(`${which} Worker end: that Worker ended TERMINATED (its own terminate()), none unconfirmed, and the browser lists no OCR Worker`,
            u.workerEnded === 'TERMINATED' && ended(u) && u.counts.terminateFailed === 0 && u.browserAfter === 0, j({ workerEnded: u.workerEnded, browserAfter: u.browserAfter, counts: u.counts }));
        check(`${which} lock: let go only once the Worker was known ended; no operation, the extraction lease given back, no release unconfirmed`,
            u.endedBeforeUnlock && u.operation === null && !u.gate.extractionActive && !u.gate.releaseUnconfirmed, j({ endedBeforeUnlock: u.endedBeforeUnlock, gate: u.gate }));
        check(`${which} partial results: the run ends CANCELLED, the Sheet excluded CANCELLED, no observation written`,
            u.report.outcome === 'CANCELLED' && u.report.committed === 0 && u.report.excluded.includes('CANCELLED') && u.sheet.observationRunId === null,
            j({ report: u.report, sheet: u.sheet }));
        check(`${which} later: the abandoned recognition never answers, no Worker is made, the Drawing Set does not move, nothing thrown or rejected unhandled`,
            !l.recognitionAnswered && l.newWorkers === 0 && !l.versionMoved && l.sheet.observationRunId === null && l.faults.errors.length === 0 && l.faults.rejections.length === 0,
            j({ waitedMs: l.waitedMs, answered: l.recognitionAnswered, newWorkers: l.newWorkers, versionMoved: l.versionMoved, faults: l.faults }));
        check(`${which} ...every deadline ever armed, fired late, moves nothing; the next reading completes`,
            !o.afterDeadlines.versionMoved && o.afterDeadlines.counts.unconfirmed === 0 && o.next === 'COMPLETED', j({ afterDeadlines: o.afterDeadlines, next: o.next }));
        note(`${which} cancel → lock let go / → Worker known ended / → browser lists none, ms`, `${u.unlockMs} / ${u.workerEndedMs} / ${u.browserGoneMs} (cancel ${a.sinceAskedMs} ms after the recognition was asked, at progress ${a.lastProgress})`);
        const heldAtUnlock = u.regionBitmaps.filter((b) => b.width * b.height > 0);
        const heldLater = l.regionBitmaps.filter((b) => b.width * b.height > 0);
        finding(`${which} canvas: the region canvas of the abandoned recognition is let go (0×0) by the time the lock is`,
            a.regionBitmaps.length > 0 && heldAtUnlock.length === 0, j({ atCancel: a.regionBitmaps, atUnlock: u.regionBitmaps }));
        note(`${which} canvas: region bitmaps ${l.waitedMs} ms after the lock was let go`, j(heldLater));
    }

    // ------------------------------------------------------------------
    section('46. M7-ADV-VERIFY ADV-37-03 -- cancelled between pages, and between Sources (R2P, R2S)');
    const R2P = await ocr('R2P');
    check('R2P at the cancel: between page 2 and page 3 of one Source -- the first recognition answered, none in flight',
        R2P.atCancel && R2P.atCancel.answeredRecognitions === 1 && R2P.atCancel.askedRecognitions === 1 && R2P.atCancel.event.phase === 'page', j(R2P.atCancel));
    check('R2P the run ends CANCELLED; the Source was not read to its end, so neither page keeps anything (HDR-36-02); no page-3 recognition asked',
        R2P.report.outcome === 'CANCELLED' && R2P.report.committed === 0 && R2P.report.excluded.filter((c) => c === 'CANCELLED').length === 2
        && Object.values(R2P.after).every((s) => s.observationRunId === null) && R2P.laterAsked === 1, j({ report: R2P.report, after: R2P.after, laterAsked: R2P.laterAsked }));
    check('R2P the Worker ended TERMINATED, the browser lists none, the lock is let go, nothing moves later',
        R2P.workerEnded === 'TERMINATED' && R2P.browserAfter === 0 && R2P.operation === null && !R2P.gate.extractionActive && !R2P.versionMovedLater && ended(R2P), j({ workerEnded: R2P.workerEnded, counts: R2P.counts }));
    const R2S = await ocr('R2S');
    check('R2S at the cancel: the first Source (OCR) read to its end, the second just started',
        R2S.atCancel && R2S.atCancel.event.phase === 'source' && R2S.atCancel.event.sourceIndex === 1 && R2S.atCancel.answeredRecognitions === R2S.atCancel.askedRecognitions, j(R2S.atCancel));
    check('R2S the run ends CANCELLED: the first Source\'s Sheet keeps its new observation, the second\'s is excluded CANCELLED and unchanged',
        R2S.report.outcome === 'CANCELLED' && R2S.report.committed === 1 && R2S.report.excluded.includes('CANCELLED')
        && R2S.after.firstSource.observationRunId !== null && R2S.after.firstSource.observationRunId !== R2S.before.firstSource.observationRunId
        && R2S.after.secondSource.observationRunId === R2S.before.secondSource.observationRunId,
        j({ report: R2S.report, before: R2S.before, after: R2S.after }));
    check('R2S the Worker ended TERMINATED, the browser lists none, the lock is let go',
        R2S.workerEnded === 'TERMINATED' && R2S.browserAfter === 0 && R2S.operation === null && !R2S.gate.extractionActive && ended(R2S), j({ workerEnded: R2S.workerEnded, counts: R2S.counts }));
    note('R2P / R2S cancel → lock let go, ms', `${R2P.unlockMs} / ${R2S.unlockMs}`);

    // ------------------------------------------------------------------
    section('47. M7-ADV-VERIFY ADV-37-03 -- a failed end during a recognition (R3T, R3N)');
    const R3T = await ocr('R3T');
    check('R3T terminate() throws during a recognition: not counted as an end; the Worker, asked on its channel, says closed and that is its end',
        R3T.settled && R3T.workerEnded === 'CLOSED' && R3T.closedHeard && R3T.counts.terminateFailed >= 1 && R3T.counts.unconfirmed === 0, j({ workerEnded: R3T.workerEnded, counts: R3T.counts }));
    check('R3T ...the run ends CANCELLED with nothing written, the lock let go after that end, the browser lists none, OCR still available',
        R3T.report.outcome === 'CANCELLED' && R3T.report.committed === 0 && R3T.sheet.observationRunId === null && R3T.unlockMs !== null
        && R3T.workerEndedMs !== null && R3T.workerEndedMs <= R3T.unlockMs && R3T.browser === 0 && !R3T.unavailable && !R3T.gate.releaseUnconfirmed,
        j({ report: R3T.report, unlockMs: R3T.unlockMs, workerEndedMs: R3T.workerEndedMs, unavailable: R3T.unavailable }));
    note('R3T cancel → Worker known ended (CLOSED) / → lock let go, ms; recognition answers after the cancel', `${R3T.workerEndedMs} / ${R3T.unlockMs}; ${j(R3T.recognitionAnsweredAfterCancel)}`);
    const R3N = await ocr('R3N');
    check('R3N terminate() never settles and "closed" is withheld: the lock is held (cancelling) and another reading refused while the end is unknown',
        R3N.whileUnknown.phase === 'cancelling' && R3N.whileUnknown.gate.extractionActive && R3N.whileUnknown.next === 'OPERATION_LOCKED', j(R3N.whileUnknown));
    check('R3N the close deadline: the run ends CANCELLED with nothing written, the lock and lease given back, the page\'s OCR fails closed (OCR_RELEASE_UNCONFIRMED)',
        R3N.afterDeadline.settled && R3N.afterDeadline.report.outcome === 'CANCELLED' && R3N.afterDeadline.sheet.observationRunId === null && R3N.afterDeadline.operation === null
        && !R3N.afterDeadline.gate.extractionActive && R3N.afterDeadline.counts.unconfirmed === 1, j(R3N.afterDeadline));
    check('R3N terminate() completing late restores nothing: still unconfirmed, still refused', R3N.afterLate.counts.unconfirmed === 1 && R3N.afterLate.next === 'OCR_RELEASE_UNCONFIRMED', j(R3N.afterLate));

    // ------------------------------------------------------------------
    section('48. M7-ADV-VERIFY ADV-37-03 -- cancelled at each stage of the recogniser\'s start (ST)');
    for (const stage of ['load', 'loadLanguage', 'initialize', 'recognize']) {
        const o = await ocr(`ST:${stage}`);
        const caughtIn = o.caught && !o.caught.missed;
        check(`ST:${stage} the cancel landed in that stage (asked, not yet answered)`, caughtIn, j({ caught: o.caught, answeredAtCancel: o.answeredAtCancel }));
        check(`ST:${stage} ...the run ends CANCELLED with nothing written, no recognition asked after the cancel, the Worker known ended, the browser lists none, the lock let go`,
            o.report.outcome === 'CANCELLED' && o.report.committed === 0 && o.sheet.observationRunId === null && o.recognizeAskedAfterCancel === 0
            && ['TERMINATED', 'CLOSED'].includes(o.workerEnded) && o.browserAfter === 0 && o.unlockMs !== null && ended(o) && !o.unavailable && !o.gate.extractionActive,
            j({ report: o.report, workerEnded: o.workerEnded, counts: o.counts }));
        note(`ST:${stage} cancel → lock let go / → Worker known ended (${o.workerEnded}) / → browser lists none, ms`, `${o.unlockMs} / ${o.workerEndedMs} / ${o.browserGoneMs}`);
    }

    // ------------------------------------------------------------------
    section('49. M7-ADV-VERIFY ADV-37-01 -- a confirmation through the readings after it');
    const R = await call('advRetention');
    evidence.retention = R;
    check('a native Sheet confirmed with a corrected title: editedFields names it', R.confirmed.ok && j(R.confirmed.editedFields) === j(['drawingTitle']), j(R.confirmed));
    check('T-REREAD-SAME-BASIS read again under the same revision: the confirmation is the same, byte for byte (values, editedFields, confirmedAt), and stays CURRENT; the observation is new',
        R.sameBasis.report.outcome === 'COMPLETED' && R.sameBasis.after.confirmation === R.afterConfirm.confirmation && R.sameBasis.after.history === R.afterConfirm.history
        && R.sameBasis.after.confirmationCurrency === 'CURRENT' && R.sameBasis.after.observationRunId !== R.afterConfirm.observationRunId,
        j({ before: R.afterConfirm.observationRunId, after: R.sameBasis.after.observationRunId, currency: R.sameBasis.after.confirmationCurrency }));
    check('...a handle drawn before that reading is refused after it (EVIDENCE_STALE), and confirms nothing', R.keptHandle && !R.keptHandleAfter.ok && R.keptHandleAfter.code === 'EVIDENCE_STALE'
        && R.afterKeptHandle.confirmation === R.sameBasis.after.confirmation, j(R.keptHandleAfter));
    check('T-REREAD-FAIL-KEEPS a reading cancelled at its start: CANCELLED, and the observation and the confirmation are unchanged',
        R.cancelled.report.outcome === 'CANCELLED' && R.cancelled.after.observation === R.cancelled.before.observation && R.cancelled.after.confirmation === R.cancelled.before.confirmation
        && R.cancelled.after.history === R.cancelled.before.history, j(R.cancelled.report));
    check('T-REREAD-FAIL-KEEPS a reading that fails (its File not handed over, SOURCE_MISSING): the observation and the confirmation are unchanged, no confirmation made',
        R.failed.report.excluded.includes('SOURCE_MISSING') && R.failed.after.observation === R.failed.before.observation && R.failed.after.confirmation === R.failed.before.confirmation
        && R.failed.after.history === R.failed.before.history, j(R.failed.report));

    const dir = path.join(ROOT, 'test-fixtures', 'm7-adv-verify');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence.json'), `${JSON.stringify({ findings, evidence }, null, 2)}\n`);
    section('M7-ADV-VERIFY findings (criteria fixed beforehand; a FAIL is a defect candidate, reported, not a gate)');
    for (const f of findings) console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.name}`);
    note('evidence written to', path.relative(ROOT, path.join(dir, 'evidence.json')));
    return findings;
}
