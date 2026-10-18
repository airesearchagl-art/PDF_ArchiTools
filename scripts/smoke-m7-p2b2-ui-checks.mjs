/**
 * M7-P2-B2 UI checks (T-11 and the UI half of T-01..T-08), run by
 * scripts/smoke-m7-p1-ui.mjs against the built app, after section 9b, from
 * an empty Drawing Set, and leaving it empty again.
 *
 * Driven as a person would: two synthetic PDFs taken in; a profile's four
 * rectangles dragged on the viewer; Sheets ticked and assigned; read; each
 * Sheet confirmed on its own against the crops of the original drawing,
 * with a value corrected; a rotated page; a Sheet with no profile; the
 * profile revised afterwards; a reading stopped part-way; a confirmation
 * withdrawn. Synthetic fixtures only; nothing may leave the machine.
 */
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
const OVERCLAIM = /確認済み|正しい|承認|検証済み/;

export async function runP2b2UiChecks(ctx) {
    const { page, ROOT, check, probe, note, section, settle, upload, waitIdle, root, viewer, p2aFixture, external } = ctx;
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures', 'm7-p2a', 'manifest.json'), 'utf8'));
    const truth = (name) => manifest.files.find((f) => f.name === name).truth;
    const register = truth('p2a-register');
    const cells = register.cells;

    const rowAt = async (index) => {
        await page.evaluate((i) => {
            const list = document.querySelector('[data-ds-sheet-list]');
            list.scrollTop = Math.max(0, i * 48 - 96);
        }, index);
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
        return row ? {
            id: row.dataset.dsSheetId,
            text: row.textContent,
            number: row.querySelector('[data-ds-sheet-number]')?.textContent ?? null,
            profile: row.querySelector('[data-ds-sheet-profile]')?.textContent ?? null,
            badge: row.querySelector('[data-ds-sheet-badge]')?.dataset.dsSheetBadge ?? null,
            badgeText: row.querySelector('[data-ds-sheet-badge]')?.textContent ?? null,
            checked: row.querySelector('[data-ds-sheet-check]')?.checked ?? null,
        } : null;
    }, index);
    const overlayGeometry = () => page.evaluate(() => {
        const o = document.querySelector('[data-ds-viewer-overlay]');
        if (!o) return null;
        const box = o.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height, scale: Number(o.dataset.dsCssScale), rotate: Number(o.dataset.dsRotate), display: o.dataset.dsDisplay };
    });
    const fieldRects = (mode) => page.evaluate((m) => Object.fromEntries([...document.querySelectorAll(`[data-ds-field-surface="${m}"] [data-ds-field-rect]`)].map((el) => {
        const box = el.getBoundingClientRect();
        return [el.dataset.dsFieldRect, { upright: el.dataset.dsUpright.split(',').map(Number), box: { left: box.left, top: box.top, width: box.width, height: box.height } }];
    })), mode);
    /** Drag an upright rectangle of a rotation-0 page onto the viewer, as a mouse would. */
    const dragRect = async (rect) => {
        // The panel under the viewer changing size redraws the page: wait until it is drawn again.
        await page.waitForFunction(() => document.querySelector('[data-ds-viewer]')?.dataset.dsRenderState === 'rendered'
            && document.querySelector('[data-ds-viewer-overlay]'), { timeout: 60_000, polling: 50 });
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
        return g;
    };
    const panel = () => page.evaluate(() => {
        const p = document.querySelector('[data-ds-confirmation-panel]');
        if (!p) return null;
        return {
            state: p.dataset.dsCropState,
            blocked: p.querySelector('[data-ds-confirmation-blocked]')?.textContent ?? null,
            methods: Object.fromEntries([...p.querySelectorAll('[data-ds-method]')].map((m, i) => [['drawingNumber', 'drawingTitle', 'revision', 'issueDate'][i], { code: m.dataset.dsMethod, text: m.textContent }])),
            values: Object.fromEntries([...p.querySelectorAll('[data-ds-value-input]')].map((el) => [el.dataset.dsValueInput, el.value])),
            entries: Object.fromEntries([...p.querySelectorAll('[data-ds-entry]')].map((el, i) => [['drawingNumber', 'drawingTitle', 'revision', 'issueDate'][i], el.dataset.dsEntry])),
            crops: [...p.querySelectorAll('[data-ds-crop-slot]')].map((slot) => {
                const canvas = slot.querySelector('canvas');
                const box = canvas?.getBoundingClientRect();
                return canvas ? { field: slot.dataset.dsCropSlot, width: canvas.width, height: canvas.height, cssWidth: box.width, cssHeight: box.height, transform: canvas.style.transform } : { field: slot.dataset.dsCropSlot, none: true };
            }),
            confirmable: Boolean(p.querySelector('[data-ds-confirm-sheet]') && !p.querySelector('[data-ds-confirm-sheet]').disabled),
            confirmed: Object.fromEntries([...p.querySelectorAll('[data-ds-confirmed-value]')].map((el) => [el.dataset.dsConfirmedValue, el.textContent])),
            badges: [...p.querySelectorAll('[data-ds-currency]')].map((b) => ({ kind: b.dataset.dsCurrency, state: b.dataset.dsCurrencyState, text: b.textContent, title: b.title })),
            text: p.textContent,
        };
    });
    const waitPanel = (state) => page.waitForFunction((s) => document.querySelector('[data-ds-confirmation-panel]')?.dataset.dsCropState === s, { timeout: 60_000, polling: 100 }, state);
    /**
     * Press このページを確定 once the crops are in place. The crops are drawn
     * again whenever the session changes (the preview's own read of a File is
     * such a change), so the button can be off for a moment after it was on;
     * a press that lands then does nothing, and is made again.
     */
    const confirmSheetNow = async (rowIndex) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            await page.waitForFunction(() => {
                const p = document.querySelector('[data-ds-confirmation-panel]');
                const button = p?.querySelector('[data-ds-confirm-sheet]');
                return p?.dataset.dsCropState === 'ready' && button && !button.disabled;
            }, { timeout: 60_000, polling: 50 });
            await page.click('[data-ds-confirm-sheet]');
            const done = await page.waitForFunction((i) => document.querySelector(`[data-ds-sheet-row][data-ds-row-index="${i}"] [data-ds-sheet-badge="CURRENT"]`),
                { timeout: 3_000, polling: 50 }, rowIndex).then(() => true, () => false);
            if (done) return attempt;
        }
        return -1;
    };
    const operation = () => page.evaluate(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation ?? '');
    const waitUnlocked = (timeout = 180_000) => page.waitForFunction(() => document.querySelector('[data-ds-root]')?.dataset.dsOperation === '', { timeout, polling: 50 });
    const exportsBefore = await page.evaluate(() => {
        // Count canvas exports and object URLs from here on.
        window.__p2b2Exports = { toDataURL: 0, toBlob: 0, createObjectURL: 0 };
        for (const name of ['toDataURL', 'toBlob']) {
            const original = HTMLCanvasElement.prototype[name];
            HTMLCanvasElement.prototype[name] = function (...args) { window.__p2b2Exports[name] += 1; return original.apply(this, args); };
        }
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (o) => { window.__p2b2Exports.createObjectURL += 1; return create(o); };
        return true;
    });
    void exportsBefore;

    // ------------------------------------------------------------------
    section('9c. M7-P2-B2: a profile drawn on the viewer (W2, T-01, H-12)');
    await upload(p2aFixture('p2a-register'), p2aFixture('p2a-geometry'));
    await waitIdle();
    const start = await root();
    check('two synthetic PDFs taken in: 7 + 8 Sheets', start.sources === 2 && start.sheets === 15, `${start.sources} / ${start.sheets}`);
    const before = await rowFacts(0);
    probe('before anything is read, no row shows a drawing number, a profile or a confirmation badge', before.number === null && before.profile === null && before.badge === null, before.text);
    const reg1 = await selectRow(0);
    const blockedFirst = await panel();
    check('with no profile the confirmation panel says why it cannot confirm, and offers no input and no crop (H-13)',
        blockedFirst.state === 'blocked' && blockedFirst.blocked.includes('プロファイルが割り当てられていない') && Object.keys(blockedFirst.values).length === 0 && blockedFirst.crops.length === 0,
        blockedFirst.blocked);
    await page.click('[data-ds-new-profile]');
    await page.waitForSelector('[data-ds-profile-editor="create"]');
    const draws = {};
    for (const field of FIELDS) {
        await page.click(`[data-ds-pick-field="${field}"]`);
        draws[field] = await dragRect(cells[field]);
    }
    const drawn = await fieldRects('draft');
    const g = draws.drawingNumber;
    const err = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const drawErrPx = Math.max(...FIELDS.map((f) => err(drawn[f].upright, [cells[f].left, cells[f].top, cells[f].right, cells[f].bottom]) * g.scale));
    check('H-12 four rectangles dragged on the page: each recorded within 1 CSS px of where the mouse went, in upright points',
        FIELDS.every((f) => drawn[f]) && drawErrPx <= 1, `${drawErrPx.toFixed(3)} CSS px at ${g.scale.toFixed(3)} px/pt`);
    const doneBeforeModel = await page.evaluate(() => document.querySelector('[data-ds-editor-done]').disabled);
    probe('no transfer model is chosen for the person: the profile cannot be made until one is', doneBeforeModel);
    await page.click('[data-ds-transfer-model="normalised"]');
    await page.type('[data-ds-profile-name]', 'P');
    await page.click('[data-ds-editor-done]');
    await page.waitForFunction(() => document.querySelectorAll('[data-ds-profile-row]').length === 1, { polling: 50 });
    const profileRow = await page.evaluate(() => document.querySelector('[data-ds-profile-row]').textContent);
    check('the profile is made (revision 1, the model chosen, no Sheets yet): nothing was assigned that the person did not name',
        profileRow.includes('P') && profileRow.includes('r1') && profileRow.includes('用紙の大きさに比例') && profileRow.includes('0ページ'), profileRow);

    // ------------------------------------------------------------------
    section('9d. M7-P2-B2: Sheets ticked and assigned, then read under the lock (W3, T-02, T-03)');
    // The geometry file's eight (one click), and register p.1 (its own box).
    await selectRow(7);
    await page.click('[data-ds-check-source]');
    await rowAt(0);
    await page.evaluate(() => {
        const box = document.querySelector('[data-ds-sheet-row][data-ds-row-index="0"] [data-ds-sheet-check]');
        if (box && !box.checked) box.click();
    });
    const chosenText = await page.evaluate(() => [...document.querySelectorAll('.ds-pane-title')].map((t) => t.textContent).find((t) => t.startsWith('ページの選択')));
    check('nine Sheets ticked: the geometry file\'s eight and register p.1', chosenText === 'ページの選択（9）', chosenText);
    await page.select('[data-ds-assign-target]', await page.evaluate(() => document.querySelector('[data-ds-profile-row]').dataset.dsProfileId));
    await page.click('[data-ds-assign]');
    await page.waitForFunction(() => document.querySelector('[data-ds-profile-row]')?.textContent.includes('9ページ'), { polling: 50 });
    const assignedRow = await rowFacts(0);
    check('assigned explicitly: the rows say which profile, and the badge reads 未確定', assignedRow.profile === 'P' && assignedRow.badge === 'NONE' && assignedRow.badgeText === '未確定',
        JSON.stringify(assignedRow));
    await page.click('[data-ds-extract]');
    const lockedAt = await page.evaluate(() => {
        const r = document.querySelector('[data-ds-root]');
        return {
            operation: r.dataset.dsOperation,
            addDisabled: document.querySelector('[data-ds-add]').disabled,
            newProfileDisabled: document.querySelector('[data-ds-new-profile]').disabled,
            assignDisabled: document.querySelector('[data-ds-assign]').disabled,
            removeDisabled: [...document.querySelectorAll('[data-ds-remove-source]')].every((b) => b.disabled),
            suspended: document.querySelector('[data-ds-viewer-suspended]')?.textContent ?? '',
            cancel: Boolean(document.querySelector('[data-ds-cancel-extraction]')),
            status: r.querySelector('[data-ds-status]').textContent,
        };
    });
    check('reading locks the screen at once: adding files, profiles, assignment and removal are off, the preview says why, and it can be stopped',
        lockedAt.operation !== '' && lockedAt.addDisabled && lockedAt.newProfileDisabled && lockedAt.assignDisabled && lockedAt.removeDisabled
        && lockedAt.suspended.includes('読み取り中') && lockedAt.cancel, JSON.stringify(lockedAt));
    await waitUnlocked();
    const result = await page.evaluate(() => document.querySelector('[data-ds-extraction-result]')?.dataset.dsExtractionResult ?? '');
    check('the reading completes and the lock is let go', result === 'COMPLETED' && await operation() === '', result);
    const readRow = await rowFacts(0);
    check('a reading alone never puts a value in the list: the row has no drawing number until a person confirms one', readRow.number === null && readRow.badge === 'NONE', JSON.stringify(readRow));

    // ------------------------------------------------------------------
    section('9e. M7-P2-B2: confirming one Sheet against the original drawing (W4, HD-B-03 A+B+C, T-05..T-08)');
    await selectRow(0);
    await waitPanel('ready');
    const ready = await panel();
    const v = register.pages[0].values;
    check('A: four crops of the original drawing are on the screen beside the values, drawn at 300 dpi and shown at half size',
        ready.crops.length === 4 && ready.crops.every((c) => !c.none && c.width > 0 && c.cssWidth > 0 && Math.abs(c.cssWidth - c.width * 0.5) <= 1), JSON.stringify(ready.crops));
    check('B: how each value was got is shown for each field (PDFの文字 here), never 手入力', FIELDS.every((f) => ready.methods[f].code === 'native' && ready.methods[f].text === 'PDFの文字')
        && !ready.text.includes('手入力'), JSON.stringify(ready.methods));
    check('...the values read are the sheet\'s own, each 読み取り値のまま', FIELDS.every((f) => ready.values[f] === v[f] && ready.entries[f] === 'as-read'), JSON.stringify(ready.values));
    const title = '[data-ds-value-input="drawingTitle"]';
    await page.click(title, { clickCount: 3 });
    await page.type(title, `${v.drawingTitle}（改）`);
    const typed = await panel();
    check('N-C15 a value corrected: its entry reads 手で入力・修正, and how it was got still reads PDFの文字',
        typed.entries.drawingTitle === 'edited' && typed.methods.drawingTitle.text === 'PDFの文字' && typed.entries.drawingNumber === 'as-read', JSON.stringify(typed.entries));
    const pressed = await confirmSheetNow(0);
    await page.waitForFunction(() => document.querySelector('[data-ds-confirmed]'), { polling: 50 });
    await waitPanel('ready');
    const done = await panel();
    note('presses of このページを確定 that landed while the crops were being drawn again (then made again)', String(pressed));
    const doneRow = await rowFacts(0);
    check('C: this Sheet only is confirmed: its row now shows the drawing number and 確定; the confirmation names the corrected field',
        doneRow.number === v.drawingNumber && doneRow.badge === 'CURRENT' && doneRow.badgeText === '確定' && done.confirmed.drawingTitle.includes(`${v.drawingTitle}（改）`)
        && done.confirmed.drawingTitle.includes('手で入力・修正'), JSON.stringify({ doneRow, confirmed: done.confirmed }));
    const otherRow = await rowFacts(7);
    check('...no other Sheet is confirmed by it (no bulk confirmation)', otherRow.number === null && otherRow.badge === 'NONE', JSON.stringify(otherRow));
    const vocabulary = [...done.badges.map((b) => b.text + b.title), doneRow.badgeText].join(' ');
    probe('the reading and confirmation badges claim nothing about the drawing: no 確認済み, 正しい, 承認 or 検証済み', !OVERCLAIM.test(vocabulary), vocabulary);

    // A rotated page: crops drawn upright, turned for display by CSS.
    await selectRow(8);
    await waitPanel('ready');
    const rotated = await panel();
    const rot = await overlayGeometry();
    check('T-01 a page with /Rotate 90: its crops are turned by CSS (rotate(90deg)), the profile\'s rectangles laid over the page as displayed',
        rot.rotate === 90 && rotated.crops.every((c) => c.transform.includes('rotate(90deg)') && Math.abs(c.cssHeight - c.width * 0.5) <= 1), JSON.stringify(rotated.crops.map((c) => c.transform)));
    const shownRects = await fieldRects('profile');
    check('...and the overlay on the rotated page lies where the page shows those fields', Object.keys(shownRects).length === 4
        && FIELDS.every((f) => shownRects[f].box.width > 0 && shownRects[f].box.height > 0), JSON.stringify(Object.keys(shownRects)));

    // A Sheet with no profile.
    await selectRow(2);
    const none = await panel();
    check('a Sheet with no profile cannot be confirmed: the reason, no input, no crop (H-13)', none.state === 'blocked' && none.blocked.includes('プロファイル') && none.crops.length === 0,
        none.blocked);

    // ------------------------------------------------------------------
    section('9f. M7-P2-B2: the profile revised afterwards, a reading stopped part-way, a confirmation withdrawn (T-08, T-02)');
    await selectRow(0);
    await waitPanel('ready');
    await page.click('[data-ds-revise-profile]');
    await page.waitForSelector('[data-ds-profile-editor="revise"]');
    const prefilled = await fieldRects('draft');
    check('revising starts from the profile\'s own rectangles on this page', FIELDS.every((f) => prefilled[f]), Object.keys(prefilled).join(','));
    await page.click('[data-ds-pick-field="revision"]');
    await dragRect({ left: 562, top: 520, right: 660, bottom: 560 });
    await page.click('[data-ds-editor-done]');
    await page.waitForFunction(() => document.querySelector('[data-ds-profile-row]')?.textContent.includes('r2'), { polling: 50 });
    const staleRow = await rowFacts(0);
    const stalePanel = await panel();
    check('after the revision the old reading is not shown against the new rectangles (no crop), and the confirmation reads 以前の確定（再確定が必要）',
        stalePanel.state === 'blocked' && stalePanel.crops.length === 0 && stalePanel.blocked.includes('読み取りをやり直して')
        && staleRow.badge === 'STALE' && staleRow.badgeText.includes('以前の確定'), JSON.stringify({ staleRow, blocked: stalePanel.blocked }));
    // Read the nine again with reading slowed, and stop part-way.
    await page.evaluate(() => { window.__dsDelayMs = 300; });
    const clicked = Date.now();
    await page.click('[data-ds-extract]');
    await page.waitForFunction(() => document.querySelector('[data-ds-extraction-progress]'), { polling: 20 });
    await settle(150);
    await page.click('[data-ds-cancel-extraction]');
    const cancelAsked = Date.now();
    await waitUnlocked(60_000);
    const unlockedAfter = Date.now() - cancelAsked;
    await page.evaluate(() => { window.__dsDelayMs = 0; });
    const stopped = await page.evaluate(() => document.querySelector('[data-ds-extraction-result]')?.dataset.dsExtractionResult ?? '');
    check('T-02 a reading stopped part-way ends CANCELLED, and the lock is let go', stopped === 'CANCELLED' && await operation() === '', stopped);
    note('T-02 from 読み取りを中止 to the lock let go (recogniser ended, document destroyed, lease given back), ms — the ~1 s target is for the Release judgement',
        `${unlockedAfter} (started ${cancelAsked - clicked} ms after the click)`);
    // Read again in full, confirm, then withdraw.
    await page.click('[data-ds-extract]');
    await waitUnlocked();
    await selectRow(0);
    const pressedAgain = await confirmSheetNow(0);
    const reconfirmed = await rowFacts(0);
    note('...and on confirming again', String(pressedAgain));
    // The crops are drawn again after a confirmation and the panel's layout moves meanwhile: wait for it, and press the button itself.
    await waitPanel('ready');
    const historyBefore = await page.evaluate(() => document.querySelector('[data-ds-confirmed]')?.textContent ?? '');
    await page.$eval('[data-ds-withdraw]', (button) => button.click());
    await page.waitForFunction(() => !document.querySelector('[data-ds-confirmed]'), { polling: 50 });
    const withdrawnRow = await rowFacts(0);
    check('re-read and confirmed again under the new revision, then withdrawn: the row goes back to 未確定, the history keeps both',
        reconfirmed.badge === 'CURRENT' && historyBefore.includes('確定の履歴 1 /') && withdrawnRow.badge === 'NONE' && withdrawnRow.number === null,
        JSON.stringify({ reconfirmed, withdrawnRow }));

    // ------------------------------------------------------------------
    section('9g. M7-P2-B2: what stays the same');
    const controls = await page.evaluate(() => {
        const el = document.querySelector('[data-ds-root]');
        const buttons = [...el.querySelectorAll('button')].map((b) => `${b.textContent} ${b.title} ${b.getAttribute('aria-label') ?? ''}`);
        const inputs = [...el.querySelectorAll('input, textarea, [contenteditable="true"]')].filter((i) => !i.matches('[data-ds-file-input]'));
        const allowed = (i) => i.matches('[data-ds-sheet-check]') || i.closest('[data-ds-profile-editor], [data-ds-confirmation-panel], [data-ds-profile-list]');
        return {
            saving: buttons.filter((t) => /保存|ダウンロード|書き出|注釈|ペン|消しゴム|テキスト追加|Save|Download|Export/i.test(t)),
            downloads: el.querySelectorAll('a[download], a[href^="blob:"]').length,
            stray: inputs.filter((i) => !allowed(i)).map((i) => i.outerHTML.slice(0, 80)),
            textLayer: el.querySelectorAll('.textLayer, .annotationLayer').length,
            qa: /QA|レビュー|保留|要対応/.test(el.textContent),
        };
    });
    probe('still no save, download or export (P4), and no QA or review (P3)', controls.saving.length === 0 && controls.downloads === 0 && !controls.qa, controls.saving.join(' | '));
    probe('inputs only where a person draws a profile, confirms a Sheet, renames a profile, or ticks Sheets; no text or annotation layer',
        controls.stray.length === 0 && controls.textLayer === 0, controls.stray.join(' | '));
    const counts = await page.evaluate(() => {
        const v = document.querySelector('[data-ds-viewer]');
        return { expired: v?.dataset.dsReleaseDeadlineExpired ?? null, unconfirmed: v?.dataset.dsReleasesUnconfirmed ?? null, gate: document.querySelector('[data-ds-root]')?.dataset.dsGateReleaseUnconfirmed };
    });
    check('the 5,000 ms release deadline never fired in these runs, and no release was left unconfirmed', counts.expired === '0' && counts.unconfirmed === '0' && counts.gate === 'false',
        JSON.stringify(counts));
    void viewer;
    const exportsAfter = await page.evaluate(() => window.__p2b2Exports);
    probe('no crop or page was turned into an image, a data URL or an object URL', exportsAfter.toDataURL === 0 && exportsAfter.toBlob === 0 && exportsAfter.createObjectURL === 0,
        JSON.stringify(exportsAfter));
    check('no request left the machine', external.length === 0, external.join(', '));

    await page.click('[data-ds-reset]');
    await page.waitForSelector('[data-ds-confirm="reset"]');
    await page.click('[data-ds-confirm-yes]');
    await page.waitForSelector('[data-ds-empty]');
    check('a new Drawing Set leaves nothing of it: no profile, no Sheet', (await root()).sources === 0);
    void reg1;
}
