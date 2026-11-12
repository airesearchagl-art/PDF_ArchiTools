/**
 * M7-P3 sections of the foundation gate (scripts/smoke-m7-p1.mjs runs them after the P2 and ADV sections, in the
 * same browser): the session store's QA, Review Decision and typed-register commands driven through the
 * Production store over synthetic PDFs actually taken in and read; the session they leave, against the canonical
 * schema and semantic contract; a refused QA run on the QA screen; and the QA screen at 5000 Sheets (times
 * recorded, no threshold). The oracle comparison (vectors, counterexamples) is scripts/smoke-m7-p3-qa.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Words the readiness area never uses: a partial QA result is not a pass, nor the final check. */
const PASS_WORDS = /PASS|合格|完了|問題なし/;
/** What a refused run never says. */
const RAN_WORDS = /QA を実行しました|QAを実行しました|完了/;
const OVERCLAIM = /確認済み|正しい|承認|検証済み/;

export async function runP3Checks(ctx) {
    const { page, ROOT, ORIGIN, check, probe, note, section, validate, envelope, schema, checkRelations } = ctx;
    await page.goto(`${ORIGIN}/scripts/smoke-m7-p3-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m7p3Ready === true, { timeout: 300000 });
    const call = (fn, ...args) => page.evaluate((f, a) => window.__m7p3[f](...a), fn, args);
    const blocker = (view, code) => view.blockers.find((b) => b.code === code) ?? null;

    // ------------------------------------------------------------------
    section('50. M7-P3: QA through the session store');
    const f = await call('flow');
    check('the synthetic Sources are taken in and read (EXTRACTION COMPLETED)', f.extraction === 'COMPLETED', `${f.extraction}, ${f.sheets} Sheets`);
    check('before any QA run: readiness says NO_QA_RUN, and the status is FINAL_UNAVAILABLE',
        f.before.status === 'FINAL_UNAVAILABLE' && blocker(f.before, 'QA_RESULT_NOT_CURRENT')?.subjects.join(',') === 'NO_QA_RUN', JSON.stringify(f.before.blockers));
    check('the assessment is kept while nothing changes (the same object twice)', f.memoSame);
    check('a QA run is written: engine drawing-set-qa, coverage of the live Sheets', f.first.ok && f.first.engine.name === 'drawing-set-qa' && f.first.coverage.sheetsEvaluated + f.first.coverage.sheetsExcluded === f.sheets,
        JSON.stringify(f.first));
    check('after it: a QA02 Finding for every unconfirmed Sheet, and QA_RESULT_NOT_CURRENT gone',
        f.afterFirst.active.filter((x) => x.rule === 'QA02_METADATA_UNCONFIRMED').length === f.sheets && !blocker(f.afterFirst, 'QA_RESULT_NOT_CURRENT'), JSON.stringify(f.afterFirst.blockers));
    check('the decided QA02 Finding is CURRENT (its File held and matched this session)', f.qa02Currency === 'CURRENT', f.qa02Currency);
    check('two Decisions on it: sequence 1 and 2, the Finding\'s evidence copied, CRLF made LF and the tab kept; HOLD then ACTION_REQUIRED, the latter in effect',
        f.decisions.d1.sequence === 1 && f.decisions.d1.evidence && f.decisions.d1.comment === '一行目\n二行目\tタブ' && f.decisions.d2.sequence === 2 && f.decisions.effective === 'ACTION_REQUIRED',
        JSON.stringify(f.decisions));
    probe('a comment with a NUL is refused (COMMENT_INVALID), an outcome outside the four (OUTCOME_INVALID), and neither writes',
        f.decisions.bad === 'COMMENT_INVALID' && f.decisions.badOutcome === 'OUTCOME_INVALID' && f.decisions.unchangedByRefusals, JSON.stringify(f.decisions));
    check('typed confirmations with one number (" Z-001" trimmed) make a change QA_RESULT_NOT_CURRENT names (UNSTATED)', f.qa01Before.includes('UNSTATED'), f.qa01Before.join(','));
    check('the next run: QA01 Z-001 over the two Sheets; their QA02 Findings closed',
        f.afterSecond.active.some((x) => x.rule === 'QA01_DUPLICATE_NUMBER' && x.key === 'Z-001' && x.sheets.length === 2) && f.second.closed >= 2, JSON.stringify(f.second));
    check('the decided QA02 Finding is NOT_REPRODUCED, its two Decisions kept as history', f.decidedQa02Now.lifecycle === 'NOT_REPRODUCED' && f.decidedQa02Now.decisionsKept === 2, JSON.stringify(f.decidedQa02Now));
    probe('a Decision on a closed Finding is refused (FINDING_NOT_ACTIVE)', f.decideOnClosed === 'FINDING_NOT_ACTIVE', f.decideOnClosed);
    check('a typed register declared from a page of a live Source: the register is EVALUABLE, and QA_RESULT_NOT_CURRENT asks for a run (UNSTATED)',
        f.declared === 'ok' && f.afterDeclare.register === 'EVALUABLE' && blocker(f.afterDeclare, 'QA_RESULT_NOT_CURRENT')?.subjects.includes('UNSTATED'), JSON.stringify(f.afterDeclare.blockers));
    check('the run after it: LISTED_BUT_MISSING Z-404 citing its one row; no ACTUAL_NOT_LISTED for the Z-001 Sheets',
        f.afterThird.active.some((x) => x.reason === 'LISTED_BUT_MISSING' && x.key === 'Z-404' && x.entries === 1)
        && !f.afterThird.active.some((x) => x.reason === 'ACTUAL_NOT_LISTED' && x.key === 'Z-001'), JSON.stringify(f.afterThird.active.filter((x) => x.rule === 'QA09_REGISTER_SHEET_MISMATCH').map((x) => [x.reason, x.key])));
    check('a corrected row keeps its id and row number, takes the new values and stays MANUAL', f.edit.ok && f.edit.id && f.edit.row === 2 && f.edit.number === 'Z-405' && f.edit.title === '詳細図' && f.edit.origin === 'MANUAL', JSON.stringify(f.edit));
    probe('a row corrected to a blank number is refused (NUMBER_REQUIRED); a page past the Source\'s last (PAGE_OUT_OF_RANGE)', f.editBlank === 'NUMBER_REQUIRED' && f.declareBad === 'PAGE_OUT_OF_RANGE', `${f.editBlank} / ${f.declareBad}`);
    check('...and the corrected row makes the LBM Finding STALE until the next run', f.afterEditView.active.find((x) => x.reason === 'LISTED_BUT_MISSING' && x.key === 'Z-404')?.currency === 'STALE');
    probe('while extraction holds the lock: QA, Decisions and every register command are refused (OPERATION_LOCKED), and the session does not move',
        f.locked.operation === 'extraction' && ['runQa', 'decide', 'declare', 'edit', 'retireRow', 'retireRef'].every((k) => f.locked[k] === 'OPERATION_LOCKED') && f.locked.unchanged && f.unlocked,
        JSON.stringify(f.locked));
    check('a File gone missing: the Source blocks Final and its Sheets\' Findings are UNVERIFIED; back again, CURRENT again (the assessment follows the binding)',
        f.binding.missing.binding === 'MISSING' && f.binding.missing.sourcesBlocker >= 1 && f.binding.missing.currencies.length > 0 && f.binding.missing.currencies.every((c) => c === 'UNVERIFIED')
        && f.binding.back.binding === 'MATCHED' && f.binding.back.sourcesBlocker === 0 && f.binding.back.currencies.every((c) => c === 'CURRENT'), JSON.stringify(f.binding));
    check('removing the register\'s Source retires the register at the same instant; the register is NONE', f.removed.ok && f.removed.referenceRetired && f.removed.register === 'NONE', JSON.stringify(f.removed));
    check('the next run closes the QA09 Findings NOT_REPRODUCED (MD-2 A)', f.fourth.ok && f.fourth.qa09Closed, JSON.stringify(f.fourth));
    check('the Decision bound: at 99999 Decisions one more is recorded (100000)', f.decisionBound.atBound === 'ok:100000', String(f.decisionBound.atBound));
    probe('...the next is refused (DECISION_LIMIT_EXCEEDED, maxDecisions 100000, planned 100001) and nothing moves',
        f.decisionBound.past.code === 'DECISION_LIMIT_EXCEEDED' && f.decisionBound.past.exceeded?.[0]?.limit === 'maxDecisions' && f.decisionBound.past.exceeded?.[0]?.planned === 100001
        && f.decisionBound.unchanged && f.decisionBound.past.message.includes('100000'), JSON.stringify(f.decisionBound.past).slice(0, 300));

    // ------------------------------------------------------------------
    section('51. M7-P3: the session the store left, against the contract');
    const file = envelope(f.session);
    const errors = validate(schema, file);
    const relations = checkRelations(file, { now: Date.now() });
    check('the session (QA runs, Findings in every state, 100000 Decisions, a retired register) is valid against portable-project.schema.json', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('...and passes portable-project.semantic.mjs with no problem and no warning', relations.problems.length === 0 && relations.warnings.length === 0,
        JSON.stringify({ problems: relations.problems.slice(0, 3), warnings: relations.warnings.slice(0, 3) }));
    check('nothing runtime was stored: no key or evidence input, no currency, no readiness on any Finding', f.session.drawingSet.findings.every((x) => !('keyInput' in x) && !('currency' in x) && !('readiness' in x)));

    // ------------------------------------------------------------------
    section('52. M7-P3: a refused QA run on the QA screen');
    const r = await call('refusalScreen');
    check('5001 typed rows naming A-900 over six registers are a valid declaration (the sixth is accepted)', r.sixth);
    check('before running, the screen says the run would be refused, naming A-900, 5001 rows and the 5000 bound',
        r.before.prediction?.includes('A-900') && r.before.prediction.includes('5001') && r.before.prediction.includes('5000'), r.before.prediction);
    check('the readiness area: FINAL_UNAVAILABLE, the final check said to be unavailable', r.before.status === 'FINAL_UNAVAILABLE' && r.before.readiness.includes('最終確認（Final QA Report）には未対応です'));
    probe('the readiness area never reads as a pass (no PASS, 合格, 完了, 問題なし)', !PASS_WORDS.test(r.before.readiness), r.before.readiness.slice(0, 200));
    check('running it: refused on the screen, naming maxSubjectsPerFinding, saying the results did not change',
        r.refused.kind === 'refused' && r.refused.exceeded.join(',') === 'maxSubjectsPerFinding' && r.refused.text.includes('反映できませんでした') && r.refused.text.includes('結果は変わっていません'), r.refused.text);
    probe('...and nothing was written (no run, no Finding, the store did not publish)', r.refused.unchanged);
    probe('a refused run is never presented as a run (no "QA を実行しました", no 完了)', !RAN_WORDS.test(r.refused.text), r.refused.text);
    check('one register withdrawn: 5000 rows fit, the run is accepted and its LBM cites all 5000; the prediction is gone',
        r.accepted.kind === 'applied' && r.accepted.lbmRows === 5000 && r.accepted.prediction === null, JSON.stringify(r.accepted));
    probe('the QA screen claims nothing about the drawings (no 確認済み, 正しい, 承認, 検証済み)', !OVERCLAIM.test(r.refused.panel), '');

    // ------------------------------------------------------------------
    section('53. M7-P3: the QA screen at 5000 Sheets, and with a large register partly withdrawn (times recorded, no threshold)');
    const p = await call('screen5000');
    note('5000 Sheets, 50 Sources, 5 typed registers x 1000 rows: declaring them through the store', `${p.declareMs.toFixed(0)} ms`);
    note('first render of the QA screen (assessment included)', `${p.firstRenderMs.toFixed(0)} ms`);
    note('QA を実行 -> run, assessment and render (synchronous)', `${p.runRenderMs.toFixed(0)} ms; to the next frame ${p.runPaintMs.toFixed(0)} ms`);
    note('...Findings written by that run / shown on the screen', `${p.afterRun.findings} written, ${p.afterRun.active} ACTIVE, ${p.afterRun.cards} cards rendered (50 per group)`);
    note('re-run with nothing changed', `${p.rerunRenderMs.toFixed(0)} ms, Findings ${p.findingsAfterRerun}`);
    note('"さらに表示" on a group', `${p.moreMs.toFixed(0)} ms, ${p.cardsAfterMore} cards`);
    note('bindings in this measurement', 'UNBOUND: no File is held for the seeded Sources, so no Finding is CURRENT and no Decision form is drawn');
    check('the 5000-Sheet run is applied on the screen and a re-run with nothing changed writes nothing',
        p.afterRun.result === 'applied' && p.afterRun.findings > 0 && p.findingsAfterRerun === p.afterRun.findings, JSON.stringify(p.afterRun).slice(0, 200));
    check('the screen draws at most 50 cards per group, not every Finding', p.afterRun.cards <= 4 * 50 && p.afterRun.active > p.afterRun.cards, `${p.afterRun.cards} of ${p.afterRun.active}`);
    check('the readiness area at 5000 Sheets: FINAL_UNAVAILABLE, nothing that reads as a pass', p.afterRun.status === 'FINAL_UNAVAILABLE' && !PASS_WORDS.test(p.afterRun.readiness));

    // Part of a large register withdrawn: 24 of 48 registers, 24000 LISTED_BUT_MISSING to close, 24000 rows kept.
    const w = await call('screenWithdraw');
    note('1000 Sheets, 48 typed registers x 1000 rows: QA を実行, run and render', `${w.firstRunMs.toFixed(0)} ms, ${w.before} ACTIVE`);
    const parts = (x) => `store ${x.commandMs.toFixed(0)} ms, assessment ${x.assessMs.toFixed(0)} ms, render ${x.renderMs.toFixed(0)} ms (to the next frame ${x.paintMs.toFixed(0)} ms)`;
    note('one register withdrawn', parts(w.one));
    note('the other 23 withdrawn', `${parts(w.rest)}; register rows drawn after: ${w.rowsShown}`);
    note('QA を実行 after the withdrawal: run, assessment and render', `${w.runMs.toFixed(0)} ms, ${w.closed} closed, ${w.open} ACTIVE`);
    check('on the screen, the run after 24 of 48 registers are withdrawn closes the 24000 numbers only they listed, and only those',
        w.result === 'applied' && w.before === 47000 && w.closed === 24000 && w.closedAllM && w.open === 23000 && w.openAllKeptL && w.shownActive === 23000,
        JSON.stringify({ result: w.result, before: w.before, closed: w.closed, closedAllM: w.closedAllM, open: w.open, openAllKeptL: w.openAllKeptL, shown: w.shownActive }));

    // ------------------------------------------------------------------
    section('54. M7-P3: what the source holds to');
    const srcFiles = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(full);
        }
    };
    walk(path.join(ROOT, 'src'));
    const read = (file) => fs.readFileSync(file, 'utf8');
    const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
    const importsOf = (source) => [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const oracleUse = srcFiles.filter((file) => importsOf(read(file)).some((spec) => /m7-p3-oracle|can03|scripts\//.test(spec)));
    probe('no source file imports the CAN-03 oracle or anything under scripts/ (it is a test oracle only)', oracleUse.length === 0, oracleUse.map(rel).join(', '));
    const engine = read(path.join(ROOT, 'src', 'utils', 'drawing-set', 'qa-engine.ts'));
    probe('the QA engine imports nothing outside src/utils/drawing-set (no node:crypto, no oracle)', importsOf(engine).every((spec) => spec.startsWith('./')), importsOf(engine).join(', '));
    const paramLiterals = [...engine.matchAll(/params:\s*(\{[^}]*\})/g)].map((m) => m[1]);
    probe('the QA engine writes no params.values hint (R4-I): every params it writes holds reason and comparisonKey only',
        paramLiterals.length >= 3 && paramLiterals.every((literal) => /^\{\s*(reason|comparisonKey)\b/.test(literal) && !/\bvalues\b/.test(literal)) && !/params\.values/.test(engine), paramLiterals.join(' | '));
    probe('the QA engine stores no runtime field on a Finding (no keyInput / evidenceInput / currency in what runQa builds)',
        !/finding:\s*\{[^}]*\b(keyInput|evidenceInput|currency)\b/s.test(engine));
    const labels = read(path.join(ROOT, 'src', 'components', 'drawing-set', 'qa-labels.ts'));
    const readinessTexts = ['FINAL_UNAVAILABLE_TEXT', 'BLOCKERS_HEAD_TEXT', 'NO_BLOCKERS_TEXT', 'QA_NOT_RUN_TEXT', 'QA_RESULT_NOT_CURRENT_TEXT']
        .map((name) => labels.match(new RegExp(`export const ${name} = '([^']*)'`))?.[1] ?? null);
    check('the readiness texts are all present', readinessTexts.every((t) => t !== null), readinessTexts.join(' / '));
    probe('no readiness text reads as a pass (PASS, 合格, 完了, 問題なし), and only the unavailability names the Final QA Report',
        readinessTexts.every((t) => !PASS_WORDS.test(t ?? '')) && readinessTexts.filter((t) => (t ?? '').includes('Final QA Report')).length === 1);
}
