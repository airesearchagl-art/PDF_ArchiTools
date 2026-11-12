/**
 * TEST ONLY. The two scenarios of the CAN-03 R4.1 vectors -- R3's 13 steps and the 7 steps over several
 * register references -- step for step as scripts/m7-p3-oracle/can03-r41-generator.mjs writes them
 * (scenarioR3Regression, scenarioMultiReference), on whichever model `M` is given: the generator itself, or the
 * adapter that answers with the Production QA engine (m7-p3-oracle-adapter.mjs). The fixture steps are the
 * generator's builders in both cases; every QA run, Decision, currency and readiness is M's.
 *
 * Replayed on the generator, the result must equal the pack's vectors byte for byte: that is what makes this
 * replay a faithful copy of the scenarios, and smoke-m7-p3-qa.mjs checks it before it trusts the comparison.
 *
 * One property of the vectors is reproduced on purpose. The generator records each step's Findings as views
 * holding the Finding object itself (`stored`), changes a Finding's lifecycle in place when a later run
 * supersedes or closes it, and writes the document at the end -- so every step's `stored` shows the Finding as
 * it is at the end of the scenario. The Production engine never changes a Finding in place; `stored` is
 * therefore taken from the final Drawing Set by id, which is what the vectors hold.
 */
export function replayScenarios(M) {
    return { r3Regression: scenarioR3Regression(M), multiReference: scenarioMultiReference(M) };
}

const viewFinding = (M, s, f) => ({
    id: f.id,
    ruleId: f.ruleId,
    reason: f.params.reason ?? null,
    lifecycle: f.lifecycle.state,
    supersededBy: f.lifecycle.supersededByFindingId,
    currency: M.findingCurrency(s, f),
    findingKey: f.findingKey,
    evidenceDigest: f.evidenceDigest,
    keyInput: s.aux[f.id]?.keyInput ?? null,
    evidenceInput: s.aux[f.id]?.evidenceInput ?? null,
    effectiveDecision: M.effectiveDecision(s, f),
    decisions: M.decisionsOf(s, f.id).map((d) => ({ findingId: d.findingId, sequence: d.sequence, outcome: d.outcome, evidenceDigest: d.evidenceDigest })),
    stored: f.id,
});

function recorder(M, s) {
    const steps = [];
    const record = (name, note) => {
        const r = M.runQa(s);
        if (!r.ok) throw new Error(`QA run refused at ${name}: ${JSON.stringify(r.exceeded)}`);
        steps.push({
            step: steps.length + 1, name, note, qaRun: r.run, register: r.register,
            findings: s.ds.findings.map((f) => viewFinding(M, s, f)), readinessP3: M.readiness(s),
        });
        return r;
    };
    const QA01 = 'QA01_DUPLICATE_NUMBER';
    const of = (rule, reason = null, k = null) => s.ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === rule
        && (reason === null || f.params.reason === reason) && (k === null || f.params.comparisonKey === k || f.sheetIds.includes(k)));
    const must = (result) => { if (!result.ok) throw new Error(`decision refused: ${result.refusal}`); return result; };
    /** The vectors' `stored`: each Finding as the final Drawing Set holds it (see the header). */
    const finish = () => {
        const byId = new Map(s.ds.findings.map((f) => [f.id, f]));
        for (const step of steps) for (const view of step.findings) view.stored = byId.get(view.stored);
        return { steps, session: s };
    };
    return { steps, record, of, must, finish, QA01 };
}

function scenarioR3Regression(M) {
    const { U, HEX, V } = M;
    const SRC1 = U(1), SRC2 = U(2), SH11 = U(11), SH12 = U(12), SH13 = U(13);
    const P1 = U(31), P2 = U(32), REG = U(20), E21 = U(21), E22 = U(22);
    const QA02 = 'QA02_METADATA_UNCONFIRMED', QA09 = 'QA09_REGISTER_SHEET_MISMATCH';
    const s = M.newSession();
    M.addSource(s, { id: SRC1, sha256: HEX('a') });
    M.addSource(s, { id: SRC2, sha256: HEX('b') });
    M.addProfile(s, { id: P1 });
    M.addProfile(s, { id: P2 });
    M.addSheet(s, { id: SH11, sourceId: SRC1, pageNumber: 1, profileId: P1 });
    M.addSheet(s, { id: SH12, sourceId: SRC2, pageNumber: 1, profileId: P2 });
    M.addSheet(s, { id: SH13, sourceId: SRC2, pageNumber: 2, profileId: P1 });
    M.read(s, SH11, V('A-102', '配置図', 'A', '2026/10/01'));
    M.confirm(s, SH11, V('A-102', '配置図', 'A', '2026/10/01'));
    M.read(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01'));
    const { record, of, must, finish, QA01 } = recorder(M, s);
    record('1 initial', 'QA01 on A-102 (confirmed + observed); QA02 S12 UNCONFIRMED, S13 NOT_READ; no register: QA09 not evaluated');
    must(M.decide(s, of(QA01).id, 'INTENTIONAL'));
    must(M.decide(s, of(QA02, 'UNCONFIRMED').id, 'HOLD'));
    M.confirm(s, SH11, V('A-102', '配置図', 'A', '2026/10/01'));
    record('2 re-confirm same value', 'confirmedAt is not evidence: same QA01 finding, INTENTIONAL stands');
    M.read(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01'));
    record('3 same-value re-extraction', 'runId is not evidence: same QA01 / QA02 findings, decisions stand');
    M.confirm(s, SH12, V(' A-102', '平面図', 'A', '2026/10/01'));
    record('4 S12 confirmed', 'QA01 superseded (decision stays with the old finding); QA02 S12 NOT_REPRODUCED');
    M.withdraw(s, SH12);
    record('5 S12 confirmation withdrawn', 'QA01 superseded again; its evidence equals step 1\'s, but it is a new finding with no decision; QA02 S12 UNCONFIRMED again (new finding)');
    M.reviseProfile(s, P2);
    record('6 S12 profile revised', 'S12 has no QA input: QA01 not evaluable for it, finding stays ACTIVE and STALE; QA02 S12 READ_IS_STALE supersedes UNCONFIRMED');
    M.read(s, SH12, V('A-102', '平面図', 'A', '2026/10/01'));
    record('7 S12 re-read under r2', 'QA01 restated on new evidence (value no longer has the leading space) -> superseded');
    M.declareRegister(s, { id: REG, sourceId: SRC1, entries: [{ id: E21, number: 'A-102' }, { id: E22, number: 'A-104' }] });
    record('8 register declared', 'QA09 LISTED_BUT_MISSING A-104 stated, UNVERIFIED (S13 unread); no ACTUAL_NOT_LISTED');
    M.read(s, SH13, null, { status: 'OCR_FAILED' });
    record('9 S13 OCR_FAILED', 'QA02 S13 OCR_FAILED supersedes NOT_READ; QA09 A-104 stays UNVERIFIED');
    M.read(s, SH13, V('A-105', '立面図', 'A', '2026/10/01'));
    record('10 S13 read A-105', 'QA09 A-104 same finding, now CURRENT; ACTUAL_NOT_LISTED S13 stated on an observed value');
    must(M.decide(s, of(QA09, 'ACTUAL_NOT_LISTED').id, 'ACTION_REQUIRED'));
    M.confirm(s, SH13, V('A-104', '立面図', 'A', '2026/10/01'));
    record('11 S13 confirmed A-104', 'both QA09 findings NOT_REPRODUCED (evaluated, no longer stated)');
    M.replaceSourceBytes(s, SRC1, HEX('c'));
    record('12 register Source replaced', 'QA09 not evaluable (REGISTER_NOT_CURRENT); S11 confirmation stale too -> QA01 not evaluable for S11, QA02 S11 RECONFIRM_REQUIRED');
    M.setBinding(s, SRC2, 'MISSING');
    record('13 Source 2 unbound', 'validity and binding apart: QA02 findings on Source 2 sheets UNVERIFIED');
    return finish();
}

function scenarioMultiReference(M) {
    const { U } = M;
    const SRC3 = U(3), R1 = U(20), R2 = U(40), R3REF = U(60);
    const E_R2 = { A103: U(41), A104: U(42) }, E_R3 = { A103: U(61) };
    const QA09 = 'QA09_REGISTER_SHEET_MISMATCH';
    const s = M.mrStart();
    const { record, of, must, finish } = recorder(M, s);
    record('MR1 two references', 'one register over R1 + R2: A-103 is listed (R2) so no ACTUAL_NOT_LISTED for S13; ANL S14 (A-105); one LBM A-104 citing E23 (R1) and E42 (R2, "A-104 " trimmed); QA02 S13 / S14 UNCONFIRMED');
    must(M.decide(s, of(QA09, 'ACTUAL_NOT_LISTED').id, 'ACTION_REQUIRED'));
    must(M.decide(s, of(QA09, 'LISTED_BUT_MISSING').id, 'INTENTIONAL'));
    s.ds.drawingRegisterReferences.reverse();
    for (const r of s.ds.drawingRegisterReferences) { r.entries.reverse(); r.entries.forEach((e, i) => { e.row = i + 1; }); }
    record('MR2 references and rows reordered', 'same keys, same evidence, same findings; decisions stand');
    M.retireEntry(s, E_R2.A104);
    const lbm = of(QA09, 'LISTED_BUT_MISSING');
    const beforeRerun = M.findingCurrency(s, lbm);
    record('MR3 R2 row A-104 retired', `before the run: LBM A-104 ${beforeRerun} (a cited entry retired); the run restates it citing E23 only -> new finding, INTENTIONAL stays with the old one`);
    M.setBinding(s, SRC3, 'MISSING');
    record('MR4 R2 Source not bound', 'QA09 still evaluated (validity and binding apart); ANL S14 UNVERIFIED (its basis has every reference Source); LBM A-104 cites R1 only -> CURRENT');
    M.setBinding(s, SRC3, 'MATCHED');
    M.replaceSourceBytes(s, SRC3, M.HEX('e'));
    record('MR5 R2 Source bytes replaced', 'R2 not current -> the register is not current: QA09 not evaluated, nothing closed, every QA09 finding STALE (R1-only LBM too); REGISTER_NOT_CURRENT');
    M.retireReference(s, R2);
    M.declareRegister(s, { id: R3REF, sourceId: SRC3, pageNumber: 1, entries: [{ id: E_R3.A103, number: 'A-103' }] });
    record('MR6 R2 declared again from the new bytes (R3)', 'register EVALUABLE over R1 + R3: ANL S14 restated on another reference set -> new finding; LBM A-104 (R1 only) same evidence -> same finding');
    M.retireReference(s, R1);
    M.retireReference(s, R3REF);
    const qa09Before = s.ds.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && f.ruleId === QA09).map((f) => M.findingCurrency(s, f));
    record('MR7 every reference withdrawn', `before the run: QA09 findings ${qa09Before.join(' / ')}; the run closes them NOT_REPRODUCED (R4 MD-2); QA09 NOT_EVALUABLE (NO_DECLARED_REGISTER), not a blocker`);
    return finish();
}
