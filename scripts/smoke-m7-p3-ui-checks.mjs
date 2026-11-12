/**
 * M7-P3 UI sections of the M7 UI gate (scripts/smoke-m7-p1-ui.mjs runs them after the P2-B2 and ADV sections):
 * the QA view of the built app, driven as a person would, with synthetic PDFs only -- run QA, record Review
 * Decisions and see their history, type a drawing register on its page, correct and withdraw its rows, withdraw
 * it, run QA again -- and what the screen never says: a pass, a completed final check, a refused run as a run.
 * Leaves a new, empty Drawing Set behind, as it found one.
 */
const PASS_WORDS = /PASS|合格|完了|問題なし/;
const OVERCLAIM = /確認済み|正しい|承認|検証済み/;

export async function runP3UiChecks(ctx) {
    const { page, check, probe, note, section, settle, upload, waitIdle, root, fixture } = ctx;
    const text = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
    const count = (selector) => page.evaluate((s) => document.querySelectorAll(s).length, selector);
    const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-ds-finding]')].map((c) => ({
        id: c.dataset.dsFinding, rule: c.dataset.dsFindingRule, reason: c.dataset.dsFindingReason, lifecycle: c.dataset.dsFindingLifecycle,
        currency: c.dataset.dsFindingCurrency, effective: c.dataset.dsFindingEffective, decisions: c.querySelectorAll('[data-ds-decision]').length,
        form: Boolean(c.querySelector('[data-ds-decision-form]')), blocked: Boolean(c.querySelector('[data-ds-decision-blocked]')), text: c.textContent,
    })));
    const readiness = () => page.evaluate(() => {
        const r = document.querySelector('[data-ds-qa-readiness]');
        return r ? {
            status: r.dataset.dsReadinessStatus, text: r.textContent,
            blockers: [...r.querySelectorAll('[data-ds-blocker]')].map((b) => b.dataset.dsBlocker),
            notEvaluated: [...r.querySelectorAll('[data-ds-not-evaluated]')].map((n) => n.dataset.dsNotEvaluated),
        } : null;
    });
    const run = async () => {
        const before = await page.evaluate(() => document.querySelector('[data-ds-qa-result]')?.textContent ?? '');
        await page.click('[data-ds-qa-run]');
        await page.waitForFunction((b) => {
            const r = document.querySelector('[data-ds-qa-result]');
            return r && r.textContent !== b;
        }, { polling: 50 }, before);
        return page.evaluate(() => ({ kind: document.querySelector('[data-ds-qa-result]').dataset.dsQaResult, text: document.querySelector('[data-ds-qa-result]').textContent }));
    };
    const showQa = async () => {
        await page.click('[data-ds-view-tab="qa"]');
        await page.waitForSelector('[data-ds-qa]');
    };
    const showPages = async () => {
        await page.click('[data-ds-view-tab="pages"]');
        await page.waitForFunction(() => document.querySelector('[data-ds-view]')?.dataset.dsView === 'pages' && !document.querySelector('[data-ds-qa]'), { polling: 50 });
    };
    const valueOf = (selector) => page.$eval(selector, (el) => el.value);
    const setValue = (selector, value) => page.$eval(selector, (input, v) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    /** A Decision form as the screen shows it: the outcome chosen (if any) and the comment typed. */
    const formOf = (findingId) => page.evaluate((id) => {
        const card = document.querySelector(`[data-ds-finding="${id}"]`);
        return card ? {
            outcome: card.querySelector('[data-ds-decision-outcome-input]:checked')?.value ?? null,
            comment: card.querySelector('[data-ds-decision-comment-input]')?.value ?? null,
        } : null;
    }, findingId);

    // ------------------------------------------------------------------
    section('9l. M7-P3: QA on the screen');
    await upload(fixture('p1-native-a'), fixture('p1-second-c'));
    await waitIdle();
    const loaded = await root();
    note('Sheets taken in for the QA screen', `${loaded.sheets} Sheets in ${loaded.sources} files`);
    await showQa();
    const fresh = await readiness();
    check('the QA view: the final check is said to be unavailable, and no QA has run yet',
        fresh.status === 'FINAL_UNAVAILABLE' && fresh.text.includes('最終確認（Final QA Report）には未対応です') && fresh.text.includes('QA をまだ実行していません'), fresh.text.slice(0, 160));
    check('...the register is not compared, said so (NO_DECLARED_REGISTER), not passed', fresh.notEvaluated.includes('NO_DECLARED_REGISTER'));
    const first = await run();
    check('QA を実行: the results are applied, with what changed', first.kind === 'applied' && first.text.includes('反映しました'), first.text);
    let list = await cards();
    const qa02 = list.filter((c) => c.rule === 'QA02_METADATA_UNCONFIRMED');
    check('a QA02 Finding (まだ読み取っていません) for every Sheet, each CURRENT with a Decision form',
        qa02.length === loaded.sheets && qa02.every((c) => c.currency === 'CURRENT' && c.form && c.reason === 'NOT_READ' && c.text.includes('まだ読み取っていません')), `${qa02.length} of ${loaded.sheets}`);
    const afterFirst = await readiness();
    check('readiness after the run: the unreviewed Findings and the unconfirmed pages are listed; still FINAL_UNAVAILABLE',
        afterFirst.status === 'FINAL_UNAVAILABLE' && afterFirst.blockers.includes('FINDINGS_UNREVIEWED') && afterFirst.blockers.includes('METADATA_NOT_CONFIRMED')
        && !afterFirst.blockers.includes('QA_RESULT_NOT_CURRENT'), afterFirst.blockers.join(','));
    probe('the readiness area never reads as a pass (no PASS, 合格, 完了, 問題なし)', !PASS_WORDS.test(afterFirst.text), afterFirst.text.slice(0, 200));

    // Two Decisions on the first QA02 Finding: HOLD with a two-line comment, then ACTION_REQUIRED.
    const target = qa02[0].id;
    const decide = async (outcome, comment) => {
        const at = `[data-ds-finding="${target}"]`;
        await page.click(`${at} [data-ds-decision-outcome-input="${outcome}"]`);
        if (comment) await page.type(`${at} [data-ds-decision-comment-input]`, comment);
        const before = await count(`${at} [data-ds-decision]`);
        await page.click(`${at} [data-ds-decision-submit]`);
        await page.waitForFunction((s, n) => document.querySelectorAll(`${s} [data-ds-decision]`).length > n, { polling: 50 }, at, before);
    };
    await decide('HOLD', '要確認\n2 行目');
    const held = (await cards()).find((c) => c.id === target);
    const heldReadiness = await readiness();
    check('a Decision recorded: the card shows 保留 in effect and its history (one entry, the comment as written, both lines)',
        held.effective === 'HOLD' && held.decisions === 1 && held.text.includes('要確認\n2 行目'), JSON.stringify({ effective: held.effective, decisions: held.decisions }));
    check('...and HOLD blocks the final check (FINDINGS_ON_HOLD)', heldReadiness.blockers.includes('FINDINGS_ON_HOLD'), heldReadiness.blockers.join(','));
    await decide('ACTION_REQUIRED', '');
    const twice = (await cards()).find((c) => c.id === target);
    const twiceReadiness = await readiness();
    check('a second Decision: both kept in order, 要対応 now in effect, FINDINGS_ON_HOLD gone',
        twice.effective === 'ACTION_REQUIRED' && twice.decisions === 2 && !twiceReadiness.blockers.includes('FINDINGS_ON_HOLD'),
        JSON.stringify({ effective: twice.effective, decisions: twice.decisions, blockers: twiceReadiness.blockers }));
    const sequence = await page.evaluate((id) => [...document.querySelectorAll(`[data-ds-finding="${id}"] [data-ds-decision]`)].map((d) => `${d.dataset.dsDecision}:${d.dataset.dsDecisionOutcome}`), target);
    check('the history reads 1: HOLD, 2: ACTION_REQUIRED', sequence.join(',') === '1:HOLD,2:ACTION_REQUIRED', sequence.join(','));

    // A Decision chosen and typed but not recorded, on another Finding: to the page view and back.
    const pending = qa02[1].id;
    const typed = '記録前のコメント\n2 行目も残る';
    await page.click(`[data-ds-finding="${pending}"] [data-ds-decision-outcome-input="INTENTIONAL"]`);
    await page.type(`[data-ds-finding="${pending}"] [data-ds-decision-comment-input]`, typed);
    await showPages();
    await showQa();
    const kept = await formOf(pending);
    check('a Decision not yet recorded survives ページ表示 and back: the outcome chosen and the comment as typed',
        kept?.outcome === 'INTENTIONAL' && kept.comment === typed, JSON.stringify(kept));
    check('...and nothing was recorded by the round trip', (await cards()).find((c) => c.id === pending)?.decisions === 0);
    await page.click(`[data-ds-finding="${pending}"] [data-ds-decision-submit]`);
    await page.waitForFunction((id) => document.querySelectorAll(`[data-ds-finding="${id}"] [data-ds-decision]`).length === 1, { polling: 50 }, pending);
    const recordedKept = (await cards()).find((c) => c.id === pending);
    await showPages();
    await showQa();
    const afterRecord = await formOf(pending);
    check('recorded, the Decision is the one typed, and the form starts over (still empty after another round trip)',
        recordedKept.effective === 'INTENTIONAL' && recordedKept.text.includes(typed) && afterRecord?.outcome === null && afterRecord.comment === '',
        JSON.stringify({ effective: recordedKept.effective, afterRecord }));

    // ------------------------------------------------------------------
    section('9m. M7-P3: a drawing register typed on its page');
    await page.click('[data-ds-view-tab="pages"]');
    await page.waitForSelector('[data-ds-register-declare-here]');
    await page.click('[data-ds-register-declare-here]');
    await page.waitForSelector('[data-ds-register-declare]');
    const declarePanel = await page.evaluate(() => ({ viewer: Boolean(document.querySelector('[data-ds-viewer]')), confirmation: Boolean(document.querySelector('[data-ds-confirmation-panel]')) }));
    check('declaring opens under the page itself, in place of the confirmation panel', declarePanel.viewer && !declarePanel.confirmation, JSON.stringify(declarePanel));
    await page.type('[data-ds-register-input="1:drawingNumber"]', 'A-001');
    await page.type('[data-ds-register-input="1:drawingTitle"]', '配置図');
    await page.type('[data-ds-register-input="3:drawingNumber"]', 'A-002');
    await page.type('[data-ds-register-input="4:drawingTitle"]', '番号なし');
    await page.click('[data-ds-register-add-rows]');
    await page.type('[data-ds-register-input="7:drawingNumber"]', 'A-009');
    const typedRows = async () => page.evaluate(() => [...document.querySelectorAll('[data-ds-register-input]')].filter((i) => i.value !== '').map((i) => `${i.dataset.dsRegisterInput}=${i.value}`).join(' '));
    const beforeTrip = await typedRows();
    await showQa();
    await showPages();
    await page.waitForSelector('[data-ds-register-declare]');
    const afterTrip = await typedRows();
    const tripRows = await count('[data-ds-register-input-row]');
    check('rows typed but not declared survive QA・図面一覧 and back: every value in its row, the added rows too',
        afterTrip === beforeTrip && afterTrip === '1:drawingNumber=A-001 1:drawingTitle=配置図 3:drawingNumber=A-002 4:drawingTitle=番号なし 7:drawingNumber=A-009' && tripRows === 10,
        `${afterTrip} (${tripRows} rows)`);
    await setValue('[data-ds-register-input="7:drawingNumber"]', '');
    await page.click('[data-ds-register-declare-submit]');
    await page.waitForSelector('[data-ds-register-declare-refused]');
    const refusedDeclare = await text('[data-ds-register-declare-refused]');
    probe('a typed row with a title but no number is refused, naming the row as typed (入力欄の 4 行目)', refusedDeclare.includes('図面番号') && refusedDeclare.includes('入力欄の 4 行目'), refusedDeclare);
    await page.$eval('[data-ds-register-input="4:drawingTitle"]', (input) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('[data-ds-register-declare-submit]');
    await page.waitForFunction(() => !document.querySelector('[data-ds-register-declare]'), { polling: 50 });
    const declaredNotice = await text('[data-ds-notice]');
    check('declared: the notice says 2 rows and that QA will compare them', declaredNotice?.includes('2 行') && declaredNotice.includes('QA を実行すると'), declaredNotice);
    await showQa();
    const registerRows = await page.evaluate(() => [...document.querySelectorAll('[data-ds-register-row]')].map((r) => `${r.dataset.dsRegisterRow}:${r.dataset.dsRegisterRowLive}:${r.textContent}`));
    check('the register shows its two typed rows, numbered 1 and 2', registerRows.length === 2 && registerRows[0].startsWith('1:true:1A-001配置図') && registerRows[1].startsWith('2:true:2A-002'), registerRows.join(' | '));
    const stale = await readiness();
    check('readiness asks for QA again (内容が変わりました) and names the pages with no number as outside the comparison',
        stale.blockers.includes('QA_RESULT_NOT_CURRENT') && stale.text.includes('QA を実行した後に内容が変わりました') && stale.notEvaluated.includes('SHEETS_WITHOUT_QA_INPUT'), stale.text.slice(0, 200));
    const second = await run();
    list = await cards();
    const lbm = list.filter((c) => c.reason === 'LISTED_BUT_MISSING' && c.lifecycle === 'ACTIVE');
    check('the run: one LISTED_BUT_MISSING for each typed number (no page carries them), UNVERIFIED -- no page has a number to compare -- so no Decision form',
        second.kind === 'applied' && lbm.length === 2 && lbm.every((c) => c.currency === 'UNVERIFIED' && !c.form && c.blocked), JSON.stringify(lbm.map((c) => [c.currency, c.form])));

    await page.click('[data-ds-register-row="2"] [data-ds-register-edit]');
    await page.waitForSelector('[data-ds-register-edit-input="drawingNumber"]');
    await setValue('[data-ds-register-edit-input="drawingNumber"]', 'A-003');
    await setValue('[data-ds-register-edit-input="drawingTitle"]', '平面図');
    await showPages();
    await showQa();
    const editKept = await page.evaluate(() => {
        const row = document.querySelector('[data-ds-register-row="2"]');
        return { number: row?.querySelector('[data-ds-register-edit-input="drawingNumber"]')?.value ?? null, title: row?.querySelector('[data-ds-register-edit-input="drawingTitle"]')?.value ?? null };
    });
    check('a row correction not yet applied survives ページ表示 and back, still open on its row', editKept.number === 'A-003' && editKept.title === '平面図', JSON.stringify(editKept));
    await page.click('[data-ds-register-edit-save]');
    await page.waitForFunction(() => document.querySelector('[data-ds-register-row="2"]')?.textContent.includes('A-003'), { polling: 50 });
    await showPages();
    await showQa();
    check('applied, the correction is over: after another round trip no row is open for correction',
        (await count('[data-ds-register-edit-input]')) === 0 && (await text('[data-ds-register-row="2"]')).includes('平面図'));
    list = await cards();
    check('a row corrected in place (A-002 -> A-003): the LBM Finding for A-002 is now STALE until QA runs again',
        list.some((c) => c.reason === 'LISTED_BUT_MISSING' && c.lifecycle === 'ACTIVE' && c.text.includes('A-002') && c.currency === 'STALE'));
    await page.click('[data-ds-register-row="1"] [data-ds-register-retire-row]');
    await page.waitForFunction(() => document.querySelector('[data-ds-register-row="1"]')?.dataset.dsRegisterRowLive === 'false', { polling: 50 });
    check('a row withdrawn stays in the register, marked 取り下げ済み', (await text('[data-ds-register-row="1"]')).includes('取り下げ済み'));
    await page.click('[data-ds-register-withdraw]');
    await page.waitForSelector('[data-ds-register-withdraw-yes]');
    await page.click('[data-ds-register-withdraw-yes]');
    await page.waitForFunction(() => !document.querySelector('[data-ds-register-ref]'), { polling: 50 });
    const withdrawn = await readiness();
    check('the register withdrawn: nothing to compare (NO_DECLARED_REGISTER), and no register blocks the final check',
        withdrawn.notEvaluated.includes('NO_DECLARED_REGISTER') && !withdrawn.blockers.includes('REGISTER_NOT_CURRENT'), withdrawn.notEvaluated.join(','));
    const third = await run();
    list = await cards();
    check('the next run closes the register\'s Findings (none left ACTIVE); the decided QA02 Finding is still ACTIVE with both Decisions',
        third.kind === 'applied' && !list.some((c) => c.rule === 'QA09_REGISTER_SHEET_MISMATCH' && c.lifecycle === 'ACTIVE')
        && list.find((c) => c.id === target)?.decisions === 2, third.text);
    await page.click('[data-ds-finding-history-toggle]');
    await page.waitForFunction(() => document.querySelector('[data-ds-finding-history] [data-ds-finding]'), { polling: 50 });
    const history = await page.evaluate(() => [...document.querySelectorAll('[data-ds-finding-history] [data-ds-finding]')].map((c) => c.dataset.dsFindingLifecycle));
    check('the history shows the closed and superseded Findings, never deleted', history.length >= 2 && history.every((s) => s === 'NOT_REPRODUCED' || s === 'SUPERSEDED'), history.join(','));
    const panel = await text('[data-ds-qa]');
    probe('the QA screen claims nothing about the drawings (no 確認済み, 正しい, 承認, 検証済み) and never says a check is complete (完了)', !OVERCLAIM.test(panel) && !/完了/.test(panel), '');
    probe('no save, download or export appeared with QA (P4)', await page.evaluate(() => document.querySelectorAll('[data-ds-root] a[download], [data-ds-root] a[href^="blob:"]').length === 0
        && ![...document.querySelectorAll('[data-ds-root] button')].some((b) => /ダウンロード|書き出|Save|Download|Export/i.test(b.textContent))));

    await page.click('[data-ds-view-tab="pages"]');
    await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered', { timeout: 60_000, polling: 100 }).catch(() => { });
    const back = await page.evaluate(() => ({ view: document.querySelector('[data-ds-view]')?.dataset.dsView, render: document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState ?? null, qa: Boolean(document.querySelector('[data-ds-qa]')) }));
    check('back on the page view, the page is drawn again and the QA view is gone', back.view === 'pages' && back.render === 'rendered' && !back.qa, JSON.stringify(back));
    await page.click('[data-ds-register-declare-here]');
    await page.waitForSelector('[data-ds-register-declare]');
    await page.type('[data-ds-register-input="1:drawingNumber"]', 'Z-999');
    await page.click('[data-ds-register-declare-cancel]');
    await page.waitForFunction(() => !document.querySelector('[data-ds-register-declare]'), { polling: 50 });
    await page.click('[data-ds-register-declare-here]');
    await page.waitForSelector('[data-ds-register-declare]');
    const restarted = await typedRows();
    check('a declaration given up (やめる) keeps nothing: declaring again starts with empty rows', restarted === '', restarted);
    await page.click('[data-ds-register-declare-cancel]');
    await page.waitForFunction(() => !document.querySelector('[data-ds-register-declare]'), { polling: 50 });
    await page.click('[data-ds-reset]');
    await page.waitForSelector('[data-ds-confirm="reset"]');
    await page.click('[data-ds-confirm-yes]');
    await page.waitForSelector('[data-ds-empty]');
    await settle(200);
    check('a new Drawing Set leaves no QA, Finding or register behind', (await root()).sources === 0 && !(await page.$('[data-ds-qa]')));
}
