/**
 * M7-P2-B1 checks, run by scripts/smoke-m7-p1.mjs after the M7-P2-A sections,
 * in the same browser and against the same Vite dev server.
 *
 * The harness (smoke-m7-p2b1-harness.html) drives the Production modules this
 * PR changes or adds -- the verified-evidence ledger (ADV-37-04), the session
 * store with its one PDF.js gate, P1 intake and preview with M7's PDF.js data
 * files (HD-B-04), re-presenting a Source's bytes (HD-B-05) and the profile
 * mutation probes F1-F7 (ADV-37-02) -- with real files, real PDF.js and the
 * real recogniser, and returns plain data. Everything is decided here.
 *
 * It also runs the static gate (scripts/typecheck): the forms that would let a
 * claim stand in for a read must not compile.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);

export async function runP2b1Checks(ctx) {
    const { page, ROOT, ORIGIN, check, probe, note, section, assetRequests } = ctx;
    const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures', dir, 'manifest.json'), 'utf8'));
    const p1 = manifest('m7-p1');
    const p2a = manifest('m7-p2a');
    const truth = (name) => p2a.files.find((f) => f.name === name).truth;
    const truths = { geometry: truth('p2a-geometry'), register: truth('p2a-register'), cmap: truth('p2a-cmap'), jpx: truth('p2a-jpx') };
    const p1Sha = (name) => p1.files.find((f) => f.name === name).sha256;

    await page.goto(`${ORIGIN}/scripts/smoke-m7-p2b1-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m7p2b1Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m7p2b1[f](...a), fn, args);

    // ------------------------------------------------------------------
    section('29. Verified evidence (ADV-37-04): intake issues it, and only a real read binds');
    const ev = await call('evidence');
    check('intake hands out the digest of the read it made: the File it read, this session, node:crypto\'s SHA-256, frozen',
        ev.candidate.kind === 'candidate' && ev.candidate.sha256 === p1Sha('p1-native-a') && ev.candidate.candidateSha === ev.candidate.sha256
        && ev.candidate.fileIsTheOneRead && ev.candidate.scopeIsTheSession && ev.candidate.fieldsMatchRecord, JSON.stringify(ev.candidate));
    check('the committed Source is bound by that digest: MATCHED, the File read is the File held, and nothing was read a second time',
        ev.adopted === 'APPLIED' && ev.bindingAfterAdoption === 'MATCHED' && ev.heldIsTheOneRead && ev.readsToBind === 1, `${ev.readsToBind} fingerprint read(s)`);
    probe('one intake read binds once: the same digest again -- FILE_REPLACED (a File was presented since it was read); in a fresh ledger -- EVIDENCE_SPENT',
        ev.sameEvidenceAgain === 'FILE_REPLACED' && ev.sameEvidenceOtherLedger === 'EVIDENCE_SPENT', `${ev.sameEvidenceAgain} / ${ev.sameEvidenceOtherLedger}`);
    check('the same bytes chosen again under another name: a duplicate of that Source, with the digest of the File just read, after one read and no PDF.js',
        ev.duplicate.kind === 'duplicate' && ev.duplicate.existingIsTheSource && ev.duplicate.fileIsTheCopy && ev.duplicate.sha256 === p1Sha('p1-native-a') && ev.duplicate.reads === 1);
    check('a withdrawn File regained by that digest: MATCHED again, the File chosen held, the model not touched (same Source, no fingerprint history)',
        ev.withdrawn === 'UNBOUND' && ev.represented === 'APPLIED' && ev.afterRepresent.binding === 'MATCHED' && ev.afterRepresent.heldIsTheCopy
        && ev.afterRepresent.modelUntouched && ev.afterRepresent.sources === 1 && ev.afterRepresent.history === 0, JSON.stringify(ev.afterRepresent));
    probe('other bytes never become the Source\'s File: FINGERPRINT_DIFFERS, nothing presented, the binding and the File held unchanged',
        ev.otherBytes === 'FINGERPRINT_DIFFERS' && ev.afterOtherBytes.binding === 'MATCHED' && ev.afterOtherBytes.heldStill);
    check('a different PDF under the same name is taken in as P1 always took it: a new Source (candidate)', ev.sameNameOtherBytes === 'candidate');
    probe('hand-made evidence for intake\'s path: a digest-shaped object, a frozen look-alike -- NOT_VERIFIED', ev.handMade === 'NOT_VERIFIED' && ev.frozenLookalike === 'NOT_VERIFIED');
    probe('a read older than the latest presentation does not override it: FILE_REPLACED', ev.olderThanPresentation === 'FILE_REPLACED', ev.olderThanPresentation);
    probe('another session\'s read, even of the same bytes for a Source with the same fingerprint, and a set of another session: SESSION_REPLACED',
        ev.anotherSessionsRead === 'SESSION_REPLACED' && ev.intoAnotherSessionsSet === 'SESSION_REPLACED');
    probe('a retired Source takes no File: SOURCE_NOT_LIVE', ev.retired === 'SOURCE_NOT_LIVE');
    check('a refused or cancelled intake hands no digest out', ev.refused.kind === 'refused' && ev.refused.code === 'PAGE_COUNT_LIMIT' && !ev.refused.evidence
        && ev.cancelled.kind === 'cancelled' && !ev.cancelled.evidence);
    check('every fingerprint Worker ended', ev.workers.live === 0, `started ${ev.workers.started}`);

    // ------------------------------------------------------------------
    section('30. One writer: the session store -- intake, re-presentation (HD-B-05), preview checks, removal, reset, leaving');
    const st = await call('store');
    check('three files through the store: three Sources, each MATCHED by its own intake read, one read each, the gate held for each',
        st.accepted.every((r) => r.kind === 'accepted') && st.readsForThree === 3 && Object.values(st.bindingsAfterIntake).every((b) => b === 'MATCHED')
        && st.gateAfterIntake.intakesStarted === 3 && st.gateAfterIntake.intakesRefused === 0, JSON.stringify(st.bindingsAfterIntake));
    check('the model holds no binding, no ledger and no File', st.modelHasNoBinding);
    check('a preview read is a check of the File: MATCHED stays MATCHED', st.previewA === 'opened:4' && st.previewT === 'opened:3' && Object.values(st.afterPreviews).every((b) => b === 'MATCHED'));
    check('MISSING: a File that can no longer be read -- the preview says so, and the Source\'s binding becomes MISSING; the others stay MATCHED',
        st.previewTGone === 'READ_FAILED' && st.afterGone['p2a-transfer.pdf'] === 'MISSING' && st.afterGone['p1-native-a.pdf'] === 'MATCHED' && st.afterGone['p2a-geometry.pdf'] === 'MATCHED',
        JSON.stringify(st.afterGone));
    const rc = st.reconnect;
    check('the right bytes chosen again reconnect the same Source: no Source added, same Source ID and Sheets, same fingerprint, no history, the model not even rewritten',
        rc.result.kind === 'reconnected' && rc.sameSource && rc.sheetsSame && rc.sources === 3 && rc.history === 0 && rc.fingerprintSame && rc.modelUntouched, JSON.stringify(rc));
    check('...MATCHED again by the intake\'s own read (one read, nothing re-hashed for the binding); the File chosen is the one held; the preview opens again',
        rc.bindings['p2a-transfer.pdf'] === 'MATCHED' && rc.held && rc.reads === 1 && st.previewTAfter === 'opened:3');
    check('when the Source is MATCHED already, the same bytes are the spare: reported as a duplicate, not added, the File held unchanged (P1 behaviour)',
        st.spare.result.kind === 'duplicate' && st.spare.heldStill && st.spare.sources === 3);
    check('CHANGED: the File now holds other bytes of the same size -- the preview refuses it, the binding is CHANGED; the right bytes again reconnect it',
        st.previewG === 'opened:8' && st.previewGChanged === 'SOURCE_CHANGED' && st.afterChanged['p2a-geometry.pdf'] === 'CHANGED'
        && st.reconnectG.kind === 'reconnected' && st.afterReconnectG['p2a-geometry.pdf'] === 'MATCHED', `${st.previewGChanged}; ${JSON.stringify(st.afterChanged)}`);
    check('other bytes under an existing name are a new Source, as before; the existing one untouched',
        st.otherBytesSameName.result.kind === 'accepted' && st.otherBytesSameName.sources === 4 && st.otherBytesSameName.bindings['p2a-geometry.pdf'] === 'MATCHED');
    check('a Source removed while its preview is still reading: the read stops, reports nothing, and the File is let go',
        st.removedMidRead.removed && st.removedMidRead.preview === 'CLOSED' && st.removedMidRead.binding === 'ABSENT' && st.removedMidRead.heldAfter, JSON.stringify(st.removedMidRead));
    check('a new Drawing Set while a file is being read: the old read publishes nothing; a new ledger, holding nothing',
        st.resetMidIntake.result.kind === 'cancelled' && st.resetMidIntake.sources === 0 && st.resetMidIntake.bindings === 0 && st.resetMidIntake.newLedger && st.resetMidIntake.heldOld === null,
        JSON.stringify(st.resetMidIntake));
    check('leaving while a file is being read: nothing published; a store made afterwards on the same page gate (a remount) takes files in',
        st.leftMidIntake.result.kind === 'cancelled' && st.leftMidIntake.sources === 0 && st.remount.kind === 'accepted' && st.remountBindings['p1-native-a.pdf'] === 'MATCHED');
    check('at most two PDF.js documents at once (one intake, one preview), and none left open', st.pdfPeak <= 2 && st.workersAfter.pdf === 0 && st.workersAfter.fingerprint === 0,
        `peak ${st.pdfPeak}, live ${st.workersAfter.pdf}`);

    // ------------------------------------------------------------------
    section('31. One PDF.js gate for intake, preview and extraction');
    const ex = await call('exclusive', truths);
    check('intake holds the gate from start to end: extraction asked meanwhile is refused (INTAKE_ACTIVE); intake leaves no document behind; then extraction runs',
        ex.duringIntake.extract.code === 'INTAKE_ACTIVE' && ex.intake.kind === 'accepted' && ex.pdfLeftByIntake === 0 && ex.afterIntake.outcome === 'COMPLETED', JSON.stringify(ex.duringIntake));
    // M7-P2-B2 puts the store's operation lock in front of the gate: intake and a second extraction are now refused
    // by the store first (OPERATION_LOCKED), and the page gate still refuses both on its own (EXTRACTION_ACTIVE).
    check('while extraction runs: intake refused (the store\'s lock, OPERATION_LOCKED), the preview refused for any Source (EXTRACTION_ACTIVE), a second extraction refused (OPERATION_LOCKED)',
        ex.during.intake.code === 'OPERATION_LOCKED' && ex.during.preview === 'EXTRACTION_ACTIVE' && ex.during.previewOther === 'EXTRACTION_ACTIVE'
        && ex.during.nested.code === 'OPERATION_LOCKED', JSON.stringify(ex.during));
    check('...and under that lock the page gate itself still refuses intake and extraction (EXTRACTION_ACTIVE)',
        ex.during.gateIntake === 'EXTRACTION_ACTIVE' && ex.during.gateExtraction === 'EXTRACTION_ACTIVE', JSON.stringify({ i: ex.during.gateIntake, e: ex.during.gateExtraction }));
    const firstStart = ex.events.indexOf('pdf-start');
    check('the open preview is destroyed before the extraction document starts; never more than one PDF.js document while extracting',
        ex.events[0] === 'pdf-end' && firstStart > 0 && ex.extractionPeak === 1 && ex.during.pdfLive === 1, ex.events.join(' > '));
    check('the run completes and its checks of both Files are settled into the session (APPLIED)', ex.run.report.outcome === 'COMPLETED' && ex.run.settled?.R === 'APPLIED' && ex.run.settled?.G === 'APPLIED',
        JSON.stringify(ex.run));
    check('afterwards the preview opens again', ex.previewAfter.startsWith('opened'));
    check('a new Drawing Set while extraction waits on the recogniser: the run lands nowhere (SESSION_REPLACED), the new session has no run, nothing settled',
        ex.resetMidExtraction.report.applied === false && ex.resetMidExtraction.report.notApplied === 'SESSION_REPLACED' && ex.resetMidExtraction.runsNow === 0 && ex.resetMidExtraction.settled,
        JSON.stringify(ex.resetMidExtraction));
    check('leaving while extraction waits: the run lands nowhere, the session left untouched, nothing settled',
        ex.leaveMidExtraction.report.applied === false && ex.leaveMidExtraction.sameSetAsBefore && ex.leaveMidExtraction.observed === 0 && ex.leaveMidExtraction.settled,
        JSON.stringify(ex.leaveMidExtraction));
    check('every PDF.js document, recogniser and fingerprint Worker of these runs ended', ex.workersAfter.pdf === 0 && ex.workersAfter.ocr === 0 && ex.workersAfter.fingerprint === 0,
        JSON.stringify(ex.workersAfter));

    // ------------------------------------------------------------------
    section('31b. Ordering and queueing: a check is as new as its read; intakes take turns on the page gate');
    const od = await call('ordering');
    check('a preview read that waited for an earlier document is ordered by when it read: a check made meanwhile found MATCHED, the File then became unreadable, and the preview\'s later read is taken -- MISSING',
        od.checkWhileWaiting === 'APPLIED' && od.bindingAfterThatCheck === 'MATCHED' && od.preview === 'READ_FAILED' && od.bindingAfterPreview === 'MISSING', JSON.stringify(od));
    check('three intakes asked for at once on the store run one after another (no two reads overlap), all taken in',
        od.concurrent.results.every((r) => r.kind === 'accepted') && od.concurrent.overlaps === false, JSON.stringify(od.concurrent));
    check('a store mounted again on the same gate waits until the old store\'s abandoned intake has finished before it reads anything',
        od.remountQueue.abandoned.kind === 'cancelled' && od.remountQueue.next.kind === 'accepted' && od.remountQueue.waited, JSON.stringify(od.remountQueue));
    probe('a store that was left opens no preview, checked or not (CLOSED)', od.previewAfterLeave === 'CLOSED', od.previewAfterLeave);
    check('the Source with the same bytes removed while a file is read: no live Source has them when they are known, so the file is a new Source (not a duplicate of one that is gone)',
        od.duplicateRemoved.kind === 'accepted' && od.sourcesAfter === 1, JSON.stringify(od.duplicateRemoved));
    check('nothing left open', od.workersAfter.pdf === 0 && od.workersAfter.fingerprint === 0, JSON.stringify(od.workersAfter));

    // ------------------------------------------------------------------
    section('32. A destruction PDF.js reports as failed: nothing opens again, whatever is reset or mounted again');
    const df = await call('destroyFailure');
    check('the preview\'s document could not be destroyed: the page gate knows (RELEASE_UNCONFIRMED)', df.opened === 'opened:4' && df.unconfirmed === true);
    check('...then intake, the preview and extraction are all refused (RELEASE_UNCONFIRMED)',
        df.intake.code === 'RELEASE_UNCONFIRMED' && df.preview === 'RELEASE_UNCONFIRMED' && df.extract.code === 'RELEASE_UNCONFIRMED', JSON.stringify({ i: df.intake, p: df.preview, e: df.extract }));
    probe('a new Drawing Set, a store mounted again on the page gate, a fresh preview owner on it: still refused', df.afterReset.code === 'RELEASE_UNCONFIRMED'
        && df.afterRemount.code === 'RELEASE_UNCONFIRMED' && df.freshOwner === 'RELEASE_UNCONFIRMED');
    check('...and no getDocument() reached PDF.js after the failure', df.getDocsAfterFailure === 0, String(df.getDocsAfterFailure));
    check('intake\'s own document could not be destroyed: the Source it read stands, the gate knows, and nothing opens after it',
        df.intakeWhoseDocumentStays.kind === 'accepted' && df.unconfirmed2 === true && df.intake2.code === 'RELEASE_UNCONFIRMED' && df.preview2 === 'RELEASE_UNCONFIRMED' && df.getDocsAfterFailure2 === 0);
    check('what the injected failures left behind was released by hand', df.leakReleased === 0, String(df.leakReleased));

    // ------------------------------------------------------------------
    section('33. ADV-37-02: the model changed while a run reads (F1-F7)');
    const mu = await call('mutations', truths);
    const codes = (rows, from, to) => rows.slice(from, to).map((r) => (r.committed ? 'C' : r.excluded ?? '-'));
    const all = (rows, from, to, want) => codes(rows, from, to).every((c) => c === want);
    const line = (f) => `a ${codes(f.a, 0, 8).join(',')} | b ${codes(f.b, 0, 3).join(',')} | ${JSON.stringify(f.report.coverage)}`;
    const coverageAdds = (f) => f.report.coverage.sheetsEvaluated === [...f.a, ...f.b.slice(1)].filter((r) => r.committed).length
        && f.report.coverage.sheetsEvaluated + f.report.coverage.sheetsExcluded === 10;
    const F = mu;
    check('F1 profile revised mid-run: its Sheets only are left out (CHANGED_DURING_RUN); the other profile\'s readings land; a1\'s earlier reading is kept (now STALE_PROFILE), b1\'s stays CURRENT',
        F.F1.mutated && all(F.F1.a, 0, 4, 'CHANGED_DURING_RUN') && all(F.F1.a, 4, 8, 'C') && all(F.F1.b, 1, 3, 'C') && F.F1.a1Kept && F.F1.a1Currency === 'STALE_PROFILE'
        && F.F1.b1Kept && F.F1.b1Currency === 'CURRENT' && coverageAdds(F.F1), line(F.F1));
    check('F2 a Sheet reassigned mid-run: that Sheet only, CHANGED_DURING_RUN', F.F2.mutated && codes(F.F2.a, 4, 5)[0] === 'CHANGED_DURING_RUN'
        && all(F.F2.a, 0, 4, 'C') && all(F.F2.a, 5, 8, 'C') && all(F.F2.b, 1, 3, 'C') && coverageAdds(F.F2), line(F.F2));
    check('F3 a Sheet unassigned mid-run: that Sheet only, left out', F.F3.mutated && codes(F.F3.a, 5, 6)[0] === 'CHANGED_DURING_RUN'
        && all(F.F3.a, 0, 5, 'C') && all(F.F3.a, 6, 8, 'C') && all(F.F3.b, 1, 3, 'C') && coverageAdds(F.F3), line(F.F3));
    check('F4 a profile retired mid-run: every Sheet it covered is left out; the other profile\'s land', F.F4.mutated && all(F.F4.a, 0, 4, 'C')
        && all(F.F4.a, 4, 8, 'CHANGED_DURING_RUN') && all(F.F4.b, 1, 3, 'CHANGED_DURING_RUN') && F.F4.profiles.find((p) => p.name === 'Q')?.retired && coverageAdds(F.F4), line(F.F4));
    check('F5 A -> B -> A mid-run: back on the same profile at the same revision, the reading is committed (the contract\'s basis is profile and revision)',
        F.F5.mutated.there && F.F5.mutated.back && all(F.F5.a, 0, 8, 'C') && all(F.F5.b, 1, 3, 'C') && F.F5.assignments.a1 === 'P' && coverageAdds(F.F5), line(F.F5));
    check('F6 a profile renamed mid-run: the revision does not move, every reading lands, and the new name stays',
        F.F6.mutated && all(F.F6.a, 0, 8, 'C') && all(F.F6.b, 1, 3, 'C') && F.F6.profiles.some((p) => p.name === 'P（改名）' && p.revision === 1) && coverageAdds(F.F6), line(F.F6));
    const f7 = F.F7;
    check('F7 no lost update: a rename, a new profile, a reassignment and a confirmation made while the run read all survive the run landing, and every targeted reading lands',
        f7.mutated.renamed && f7.mutated.created && f7.mutated.reassigned && f7.mutated.confirmed && all(f7.a, 0, 8, 'C') && all(f7.b, 1, 3, 'C')
        && f7.profiles.some((p) => p.name === 'Q（改名）') && f7.profiles.some((p) => p.name === 'R') && f7.assignments.b1 === f7.extra.third
        && f7.b1Confirmation === 'B-手入力' && f7.runs === 2 && coverageAdds(f7), `${line(f7)}; ${JSON.stringify(f7.profiles)}`);
    check('each probe appended its run once', Object.values(F).filter((f) => f.runs !== undefined).every((f) => f.runs === 2));
    check('no PDF.js document or recogniser left running', F.workersAfter.pdf === 0 && F.workersAfter.ocr === 0);

    // ------------------------------------------------------------------
    section('34. M7\'s PDF.js data files in P1 intake and preview (HD-B-04): before and after, on the same pages');
    const assetsFrom = assetRequests.length;
    const as = await call('assets', truths);
    const fetched = assetRequests.slice(assetsFrom);
    const changes = Object.fromEntries(Object.entries(as.facts).map(([name, f]) => [name, f.changed]));
    note('page facts that changed (before: no data files, as P1 intake opened documents; after: Production intake now)', JSON.stringify(changes));
    check('the only page facts that change are C1 and C2 of the CMap fixture, from no text to text -- the change HD-B-04 accepted',
        Object.entries(changes).every(([name, c]) => (name === 'p2a-cmap' ? c?.length === 2 : c?.length === 0))
        && JSON.stringify(changes['p2a-cmap'].map((c) => [c.page, c.from.kind, c.to.kind])) === '[[1,"scanned","text-native"],[2,"scanned","text-native"]]'
        && changes['p2a-cmap'].every((c) => c.from.uprightWidthPt === c.to.uprightWidthPt && c.from.uprightHeightPt === c.to.uprightHeightPt && c.from.rotate === c.to.rotate));
    check('Production intake records exactly what the data files read, page by page, for every fixture', Object.values(as.facts).every((f) => JSON.stringify(f.after) === JSON.stringify(f.reference)));
    check('no page lost or added, and every paper size unchanged', Object.values(as.facts).every((f) => f.after && f.after.length === f.before.length
        && f.after.every((a, i) => a.uprightWidthPt === f.before[i].uprightWidthPt && a.uprightHeightPt === f.before[i].uprightHeightPt)));
    check('/Rotate 0/90/180/270 and CropBox offsets: upright sizes and rotation exactly as the generator built them', as.rotation.length === 8
        && as.rotation.every((r) => r.rotate && r.width && r.height) && as.rotation.filter((r) => r.offset).length === 4, JSON.stringify(as.rotation));
    const cm = as.draw.cmap.rows;
    check('preview C2 (embedded, Adobe-Japan1, no ToUnicode): nothing drawn before, drawn now, as the data-file reference draws it',
        sum(cm[1].before) === 0 && sum(cm[1].preview) > 0 && JSON.stringify(cm[1].preview) === JSON.stringify(cm[1].reference), `${sum(cm[1].before)} -> ${sum(cm[1].preview)}`);
    check('preview C3 (with ToUnicode) and C4 (standard fonts): drawn the same before and now', [2, 3].every((i) => sum(cm[i].preview) > 0
        && JSON.stringify(cm[i].preview) === JSON.stringify(cm[i].before) && JSON.stringify(cm[i].preview) === JSON.stringify(cm[i].reference)));
    note('preview C1 (non-embedded CID font: drawn only with a CJK system font, measured not asserted)', `before ${sum(cm[0].before)}, now ${sum(cm[0].preview)}, reference ${sum(cm[0].reference)}`);
    check('preview C1 is drawn exactly as the data-file reference draws it', JSON.stringify(cm[0].preview) === JSON.stringify(cm[0].reference));
    const jp = as.draw.jpx.rows;
    check('preview JPX scan: blank before, drawn now like its PNG twin (within 2%); the PNG twin unchanged',
        sum(jp[0].before) === 0 && Math.abs(sum(jp[0].preview) - sum(jp[1].preview)) <= 0.02 * sum(jp[1].preview) && JSON.stringify(jp[1].preview) === JSON.stringify(jp[1].before),
        `${sum(jp[0].before)} -> ${sum(jp[0].preview)} vs PNG ${sum(jp[1].preview)}`);
    probe('drawn right is not read right: C2\'s title from the text layer is still not the sheet\'s (ADV-37-01 stays open; a person must compare)',
        as.c2.outcome === 'COMPLETED' && as.c2.title?.source === 'native' && as.c2.title.value !== '' && as.c2.title.value !== truths.cmap.pages[1].values.drawingTitle,
        JSON.stringify(as.c2.title?.value));
    const dirs = [...new Set(fetched.map((u) => u.replace(/^https?:\/\/[^/]+/, '').split('/').slice(0, 3).join('/')))];
    check('intake and preview fetched CMaps, standard fonts and the JPX decoder from this origin under /pdfjs/, nowhere else',
        fetched.some((u) => u.includes('/pdfjs/cmaps/')) && fetched.some((u) => u.includes('/pdfjs/standard_fonts/')) && fetched.some((u) => u.includes('/pdfjs/wasm/'))
        && fetched.every((u) => u.startsWith(`${ORIGIN}/pdfjs/`)), dirs.join(' '));
    note('timing (ms): Production intake, and the same page-facts inventory without / with the data files', JSON.stringify(as.timing));
    note('timing (ms): preview open, and render per page now / without the data files', JSON.stringify({
        cmap: { open: as.draw.cmap.openMs, render: cm.map((r) => [r.renderMs, r.beforeRenderMs]) },
        jpx: { open: as.draw.jpx.openMs, render: jp.map((r) => [r.renderMs, r.beforeRenderMs]) },
    }));
    check('no PDF.js document, recogniser or fingerprint Worker left running', as.workersAfter.pdf === 0 && as.workersAfter.ocr === 0 && as.workersAfter.fingerprint === 0);

    // ------------------------------------------------------------------
    section('35. M7-P2-B1 static gate and privacy');
    let tsc = { ok: true, output: '' };
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'scripts', 'typecheck', 'tsconfig.json')], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
        tsc = { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(0, 600) };
    }
    const typecheckSource = fs.readFileSync(path.join(ROOT, 'scripts', 'typecheck', 'm7-p2b1-evidence.ts'), 'utf8');
    const expected = (typecheckSource.match(/@ts-expect-error/g) ?? []).length;
    check(`static gate: the ${expected} forms that would let a claim stand in for a read do not compile, and the session's ledger does (tsc)`, tsc.ok && expected >= 10, tsc.output);
    const storage = await call('storage');
    check('this harness wrote nothing to localStorage, sessionStorage, IndexedDB or the Cache API, and none holds anything',
        storage.writes.writes === 0 && storage.databases.length === 0 && storage.cacheNames.length === 0 && storage.local === 0 && storage.session === 0, JSON.stringify(storage.writes.calls));
    check('no object URL left behind', storage.objectUrls === 0, String(storage.objectUrls));
    const strip = (t) => t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    const intakeCode = strip(fs.readFileSync(path.join(ROOT, 'src', 'utils', 'drawing-set', 'source-intake.ts'), 'utf8'));
    probe('intake still renders no page: it reads page boxes and native text only (no full-page rasterization)', !/\.render\(|getViewport|canvas/i.test(intakeCode));
    const src = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'drawing-set', 'file-evidence.ts'), 'utf8');
    probe('file-evidence.ts exports no way to issue a digest but reading a File', !/export\s+(async\s+)?function\s+(mint|issue|make|create|forge)/i.test(src)
        && (src.match(/issued\.set\(/g) ?? []).length === 1 && /export async function readFileDigest/.test(src));
}
