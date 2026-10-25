/**
 * M7-ADV-VERIFY-01, the screen's half (ADV-37-01), run by
 * scripts/smoke-m7-p1-ui.mjs against the built app after the M7-P2-B2 UI
 * checks, from an empty Drawing Set, and leaving it empty again. Test only.
 *
 *   T-C2-UI            the C2 page (embedded Adobe-Japan1, no ToUnicode): the
 *                      plausible wrong text is shown as read from the PDF's
 *                      text, unconfirmed, beside the original drawing's crop;
 *                      confirmed as read (editedFields []) and, corrected, as
 *                      edited;
 *   T-ENTER-NO-CONFIRM Enter and Space in the value inputs confirm nothing; the
 *                      confirm button still works from the keyboard;
 *   T-STALE-LIST       a confirmation made stale (the profile revised): the
 *                      list row's badge, and what the row's number says;
 *   T-OCRFAILED-UI     a raster page whose recognition cannot run (the OCR
 *                      assets withheld by the test): how the panel and the
 *                      result say so; and OCR available again afterwards.
 *
 * Checks gate. A FINDING has its criterion fixed here and is reported PASS
 * or FAIL; a FAIL is a defect candidate for the report, not relaxed and not
 * made to pass by changing the product. Synthetic fixtures only.
 */
const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];

export async function runAdvVerifyUiChecks(ctx) {
    const { page, ROOT, check, note, section, settle, upload, waitIdle, root, p2aFixture, external } = ctx;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures', 'm7-p2a', 'manifest.json'), 'utf8'));
    const truth = (name) => manifest.files.find((f) => f.name === name).truth;
    const cmap = truth('p2a-cmap');
    const cells = cmap.cells;
    const c2 = cmap.pages.find((p) => p.case === 'C2').values;
    const findings = [];
    const finding = (name, ok, detail = '') => {
        findings.push({ name, ok, detail });
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  FINDING ${name}  ${detail}`);
    };
    const j = (x) => JSON.stringify(x);

    const rowAt = async (index) => {
        await page.evaluate((i) => { document.querySelector('[data-ds-sheet-list]').scrollTop = Math.max(0, i * 48 - 96); }, index);
        await page.waitForFunction((i) => Boolean(document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"]`)), { polling: 50 }, index);
    };
    const selectRow = async (index) => {
        await rowAt(index);
        const id = await page.evaluate((i) => {
            const row = document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"]`);
            row.click();
            return row.dataset.dsSheetId;
        }, index);
        await page.waitForFunction((sheetId) => {
            const v = document.querySelector('[data-ds-viewer]');
            return v?.dataset.dsRenderState === 'rendered' && v.querySelector('canvas')?.dataset.dsRenderedSheet === sheetId;
        }, { timeout: 60_000, polling: 100 }, id);
        return id;
    };
    const rowFacts = (index) => page.evaluate((i) => {
        const row = document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"]`);
        const number = row?.querySelector('[data-ds-sheet-number]');
        const badge = row?.querySelector('[data-ds-sheet-badge]');
        return row ? { id: row.dataset.dsSheetId, number: number?.textContent ?? null, numberTitle: number?.title ?? null, badge: badge?.dataset.dsSheetBadge ?? null, badgeText: badge?.textContent ?? null, badgeTitle: badge?.title ?? null } : null;
    }, index);
    const ensureChecked = async (index, on) => {
        await rowAt(index);
        await page.evaluate((i, want) => {
            const box = document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"] [data-ds-sheet-check]`);
            if (box && box.checked !== want) box.click();
        }, index, on);
    };
    const overlayGeometry = () => page.evaluate(() => {
        const o = document.querySelector('[data-ds-viewer-overlay]');
        if (!o) return null;
        const box = o.getBoundingClientRect();
        return { left: box.left, top: box.top, scale: Number(o.dataset.dsCssScale) };
    });
    const dragRect = async (rect) => {
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered' && document.querySelector('[data-ds-viewer-overlay]'), { timeout: 60_000, polling: 50 });
        const g = await overlayGeometry();
        const x0 = g.left + rect.left * g.scale;
        const y0 = g.top + rect.top * g.scale;
        const x1 = g.left + rect.right * g.scale;
        const y1 = g.top + rect.bottom * g.scale;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
        await page.mouse.move(x1, y1, { steps: 4 });
        await page.mouse.up();
        await settle(50);
    };
    const panel = () => page.evaluate((fields) => {
        const p = document.querySelector('[data-ds-confirmation-panel]');
        if (!p) return null;
        return {
            state: p.dataset.dsCropState,
            methods: Object.fromEntries([...p.querySelectorAll('[data-ds-method]')].map((m, i) => [fields[i], { code: m.dataset.dsMethod, text: m.textContent }])),
            values: Object.fromEntries([...p.querySelectorAll('[data-ds-value-input]')].map((el) => [el.dataset.dsValueInput, el.value])),
            entries: Object.fromEntries([...p.querySelectorAll('[data-ds-entry]')].map((el, i) => [fields[i], el.dataset.dsEntry])),
            crops: [...p.querySelectorAll('[data-ds-crop-slot]')].map((slot) => {
                const canvas = slot.querySelector('canvas');
                return canvas ? { field: slot.dataset.dsCropSlot, width: canvas.width, height: canvas.height } : { field: slot.dataset.dsCropSlot, none: true };
            }),
            confirmed: Object.fromEntries([...p.querySelectorAll('[data-ds-confirmed-value]')].map((el) => [el.dataset.dsConfirmedValue, el.textContent])),
            hasConfirmed: Boolean(p.querySelector('[data-ds-confirmed]')),
            badges: [...p.querySelectorAll('[data-ds-currency]')].map((b) => ({ kind: b.dataset.dsCurrency, state: b.dataset.dsCurrencyState, text: b.textContent })),
            text: p.textContent,
        };
    }, FIELDS);
    const waitPanel = (state) => page.waitForFunction((s) => document.querySelector('[data-ds-confirmation-panel]')?.dataset.dsCropState === s, { timeout: 60_000, polling: 100 }, state);
    const waitConfirmable = () => page.waitForFunction(() => {
        const p = document.querySelector('[data-ds-confirmation-panel]');
        const button = p?.querySelector('[data-ds-confirm-sheet]');
        return p?.dataset.dsCropState === 'ready' && button && !button.disabled;
    }, { timeout: 60_000, polling: 50 });
    /** Press このページを確定 (by click, or by Enter on the focused button); made again if it landed while the crops were redrawn. */
    const confirmNow = async (rowIndex, how) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            await waitConfirmable();
            if (how === 'keyboard') {
                await page.focus('[data-ds-confirm-sheet]');
                await page.keyboard.press('Enter');
            } else await page.click('[data-ds-confirm-sheet]');
            const done = await page.waitForFunction((i) => document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"] [data-ds-sheet-badge="CURRENT"]`),
                { timeout: 3_000, polling: 50 }, rowIndex).then(() => true, () => false);
            if (done) return attempt;
        }
        return -1;
    };
    const setValue = async (field, value) => {
        const selector = `[data-ds-value-input="${field}"]`;
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        if (value) await page.type(selector, value);
    };
    const waitUnlocked = (timeout = 180_000) => page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation === '', { timeout, polling: 50 });
    const extractChecked = async () => {
        await page.click('[data-ds-extract]');
        await page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation !== '' || document.querySelector('[data-ds-extraction-result]'), { polling: 20 });
        await waitUnlocked();
        return page.evaluate(() => {
            const r = document.querySelector('[data-ds-extraction-result]');
            return r ? { state: r.dataset.dsExtractionResult, ocrFailed: Number(r.dataset.dsExtractionOcrFailed), text: r.textContent.trim() } : null;
        });
    };

    // ------------------------------------------------------------------
    section('9h. M7-ADV-VERIFY ADV-37-01: the C2 page through the screen (T-C2-UI)');
    await upload(p2aFixture('p2a-cmap'), p2aFixture('p2a-register'));
    await waitIdle();
    const start = await root();
    check('two synthetic PDFs taken in: the CMap file (4) and the register (7)', start.sources === 2 && start.sheets === 11, `${start.sources} / ${start.sheets}`);
    const C2_ROW = 1;
    const RASTER_ROW = 5;
    await selectRow(C2_ROW);
    await page.click('[data-ds-new-profile]');
    await page.waitForSelector('[data-ds-profile-editor="create"]');
    for (const field of FIELDS) {
        await page.click(`[data-ds-pick-field="${field}"]`);
        await dragRect(cells[field]);
    }
    await page.click('[data-ds-transfer-model="normalised"]');
    await page.type('[data-ds-profile-name]', 'C');
    await page.click('[data-ds-editor-done]');
    await page.waitForFunction(() => document.querySelectorAll('[data-ds-profile-row]').length === 1, { polling: 50 });
    await ensureChecked(C2_ROW, true);
    await page.select('[data-ds-assign-target]', await page.evaluate(() => document.querySelector('[data-ds-profile-row]').dataset.dsProfileId));
    await page.click('[data-ds-assign]');
    await page.waitForFunction(() => document.querySelector('[data-ds-profile-row]')?.textContent.includes('1ページ'), { polling: 50 });
    const read = await extractChecked();
    check('the C2 page is read (COMPLETED)', read?.state === 'COMPLETED', j(read));
    await selectRow(C2_ROW);
    await waitPanel('ready');
    const shown = await panel();
    note('T-C2-UI the values read from the C2 page, as shown (truth: the generator\'s values)', j({ shown: shown.values, truth: c2 }));
    check('T-C2-UI the title is read from the PDF\'s text (PDFの文字) and is not the drawing\'s own 構造図: the plausible wrong text of ADV-37-01, shown as read',
        shown.methods.drawingTitle.code === 'native' && shown.methods.drawingTitle.text === 'PDFの文字' && shown.values.drawingTitle !== c2.drawingTitle && shown.values.drawingTitle.length > 0,
        j({ method: shown.methods.drawingTitle, value: shown.values.drawingTitle }));
    check('T-C2-UI ...every field 読み取り値のまま, every crop of the original drawing drawn beside it, and the row 未確定 (no confirmation)',
        FIELDS.every((f) => shown.entries[f] === 'as-read') && shown.crops.length === 4 && shown.crops.every((c) => !c.none && c.width > 0 && c.height > 0)
        && !shown.hasConfirmed && (await rowFacts(C2_ROW)).badge === 'NONE', j({ entries: shown.entries, crops: shown.crops, row: await rowFacts(C2_ROW) }));

    // ------------------------------------------------------------------
    section('9i. M7-ADV-VERIFY: Enter and Space in the inputs confirm nothing (T-ENTER-NO-CONFIRM)');
    for (const field of FIELDS) {
        await page.focus(`[data-ds-value-input="${field}"]`);
        await page.keyboard.press('Enter');
    }
    await page.focus('[data-ds-value-input="drawingTitle"]');
    await page.keyboard.press('Space');
    await settle(500);
    const afterKeys = await panel();
    const rowAfterKeys = await rowFacts(C2_ROW);
    check('T-ENTER-NO-CONFIRM Enter in each of the four inputs, and Space in one: no confirmation; the row still 未確定; the Space typed into the value (an edit, not a confirm)',
        !afterKeys.hasConfirmed && rowAfterKeys.badge === 'NONE' && afterKeys.values.drawingTitle.endsWith(' ') && afterKeys.entries.drawingTitle === 'edited',
        j({ hasConfirmed: afterKeys.hasConfirmed, row: rowAfterKeys, title: afterKeys.values.drawingTitle, entry: afterKeys.entries.drawingTitle }));
    await setValue('drawingTitle', shown.values.drawingTitle);
    const restored = await panel();
    check('...the value typed back as read: 読み取り値のまま again', restored.entries.drawingTitle === 'as-read' && restored.values.drawingTitle === shown.values.drawingTitle, j(restored.entries));
    const pressedByKey = await confirmNow(C2_ROW, 'keyboard');
    await page.waitForFunction(() => document.querySelector('[data-ds-confirmed]'), { timeout: 10_000, polling: 50 }).catch(() => { });
    const asRead = await panel();
    const asReadRow = await rowFacts(C2_ROW);
    check('the confirm button itself still works from the keyboard (focused, Enter): this Sheet confirmed',
        pressedByKey >= 0 && asRead.hasConfirmed && asReadRow.badge === 'CURRENT', j({ pressedByKey, row: asReadRow }));
    check('T-C2-UI confirmed as read: the wrong title is the confirmed value, with no field marked 手で入力・修正 (editedFields []), and the row shows the confirmed number',
        asRead.confirmed.drawingTitle?.includes(shown.values.drawingTitle) && !Object.values(asRead.confirmed).some((t) => t.includes('手で入力・修正'))
        && asReadRow.number === (shown.values.drawingNumber || '（空欄）'), j({ confirmed: asRead.confirmed, row: asReadRow }));
    await waitPanel('ready');
    await setValue('drawingTitle', c2.drawingTitle);
    const pressedCorrected = await (async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            await waitConfirmable();
            await page.click('[data-ds-confirm-sheet]');
            const done = await page.waitForFunction((want) => [...document.querySelectorAll('[data-ds-confirmed-value="drawingTitle"]')].some((el) => el.textContent.includes(want)),
                { timeout: 3_000, polling: 50 }, c2.drawingTitle).then(() => true, () => false);
            if (done) return attempt;
        }
        return -1;
    })();
    const corrected = await panel();
    check('T-C2-UI corrected to 構造図 and confirmed again: the title confirmed as 構造図, marked 手で入力・修正; the earlier confirmation kept in the history',
        pressedCorrected >= 0 && corrected.confirmed.drawingTitle.includes(c2.drawingTitle) && corrected.confirmed.drawingTitle.includes('手で入力・修正') && corrected.text.includes('確定の履歴 1 /'),
        j({ confirmed: corrected.confirmed }));

    // ------------------------------------------------------------------
    section('9j. M7-ADV-VERIFY: a stale confirmation in the list (T-STALE-LIST)');
    await page.click('[data-ds-revise-profile]');
    await page.waitForSelector('[data-ds-profile-editor="revise"]');
    await page.click('[data-ds-pick-field="revision"]');
    await dragRect({ left: cells.revision.left + 2, top: cells.revision.top, right: cells.revision.right, bottom: cells.revision.bottom });
    await page.click('[data-ds-editor-done]');
    await page.waitForFunction(() => document.querySelector('[data-ds-profile-row]')?.textContent.includes('r2'), { polling: 50 });
    const stale = await rowFacts(C2_ROW);
    note('T-STALE-LIST the row of the now stale confirmation, as shown', j(stale));
    check('T-STALE-LIST the row\'s badge is the stale one (以前の確定), not 確定', stale.badge === 'STALE' && stale.badgeText.includes('以前の確定') && stale.badgeText !== '確定', j(stale));
    // M7-ADV-REPAIR-01: a FINDING (FAIL) in M7-ADV-VERIFY-01, a gate once repaired.
    check('T-STALE-LIST the number a stale confirmation keeps in the list is titled as the previous confirmation\'s (以前の確定の図面番号（再確定が必要）), not as a current confirmed number',
        stale.number === (c2.drawingNumber) && stale.numberTitle === '以前の確定の図面番号（再確定が必要）', j({ number: stale.number, numberTitle: stale.numberTitle }));
    check('...while a current confirmation\'s number is still titled 確定した図面番号', asReadRow.numberTitle === '確定した図面番号', j({ numberTitle: asReadRow.numberTitle }));

    // ------------------------------------------------------------------
    section('9k. M7-ADV-VERIFY: a raster page whose recognition cannot run (T-OCRFAILED-UI)');
    await ensureChecked(C2_ROW, false);
    await ensureChecked(RASTER_ROW, true);
    await page.select('[data-ds-assign-target]', await page.evaluate(() => document.querySelector('[data-ds-profile-row]').dataset.dsProfileId));
    await page.click('[data-ds-assign]');
    await page.waitForFunction(() => document.querySelector('[data-ds-profile-row]')?.textContent.includes('2ページ'), { polling: 50 });
    // The recogniser's language data withheld by the test (the request fails), so no recognition can run.
    const withheld = [];
    await page.setRequestInterception(true);
    const block = (request) => {
        if (/\/ocr\/tessdata\//.test(request.url())) {
            withheld.push(request.url().replace(/^.*\/ocr\//, '/ocr/'));
            request.abort('failed');
        } else request.continue();
    };
    page.on('request', block);
    // The worker's own requests are not the page's: block them on the Worker's target too.
    const cdp = await page.createCDPSession();
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/ocr/tessdata/*' }] });
    cdp.on('Fetch.requestPaused', (e) => {
        withheld.push(e.request.url.replace(/^.*\/ocr\//, '/ocr/'));
        cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }).catch(() => { });
    });
    const failedRead = await extractChecked();
    page.off('request', block);
    await page.setRequestInterception(false);
    await cdp.send('Fetch.disable').catch(() => { });
    await cdp.detach().catch(() => { });
    note('T-OCRFAILED-UI requests withheld by the test', j([...new Set(withheld)]));
    note('T-OCRFAILED-UI the result, as shown', j(failedRead));
    await selectRow(RASTER_ROW);
    await waitPanel('ready').catch(() => { });
    const failedPanel = await panel();
    const failedRow = await rowFacts(RASTER_ROW);
    note('T-OCRFAILED-UI the panel for the raster page, as shown', j({ state: failedPanel?.state, methods: failedPanel?.methods, values: failedPanel?.values, entries: failedPanel?.entries, badges: failedPanel?.badges, row: failedRow }));
    check('T-OCRFAILED-UI with the language data withheld, no recognition runs: the result says the reading failed for it (an OCR failure counted, or the run not completed)',
        withheld.length > 0 && failedRead !== null && (failedRead.ocrFailed >= 1 || failedRead.state !== 'COMPLETED'), j(failedRead));
    check('T-OCRFAILED-UI ...nothing on the screen calls a value read: no field shows PDFの文字 or OCR, none is filled in from a reading, and the row is not confirmed',
        failedPanel !== null && FIELDS.every((f) => !failedPanel.methods[f] || failedPanel.methods[f].code === 'none' || failedPanel.methods[f].code === undefined)
        && FIELDS.every((f) => !failedPanel.values[f]) && failedRow.badge !== 'CURRENT', j({ methods: failedPanel?.methods, values: failedPanel?.values, row: failedRow }));
    finding('T-OCRFAILED-UI every field of the page whose recognition failed reads 読み取れず, and the result line names the OCR failure',
        failedPanel !== null && FIELDS.every((f) => failedPanel.methods[f]?.text === '読み取れず') && failedRead.ocrFailed >= 1 && /文字認識|OCR/.test(failedRead.text), j({ methods: failedPanel?.methods, result: failedRead }));
    const again = await extractChecked();
    note('T-OCRFAILED-UI with the language data no longer withheld, the next reading', j(again));
    check('...the language data no longer withheld: the next reading of the raster page completes', again?.state === 'COMPLETED' && again.ocrFailed === 0, j(again));
    check('no request left the machine', external.length === 0, external.join(', '));

    await page.click('[data-ds-reset]');
    await page.waitForSelector('[data-ds-confirm="reset"]');
    await page.click('[data-ds-confirm-yes]');
    await page.waitForSelector('[data-ds-empty]');
    check('a new Drawing Set leaves nothing of it', (await root()).sources === 0);
    section('M7-ADV-VERIFY UI findings (criteria fixed beforehand; a FAIL is a defect candidate, reported, not a gate)');
    for (const f of findings) console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.name}`);
    const dir = path.join(ROOT, 'test-fixtures', 'm7-adv-verify');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui-findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
    return findings;
}
