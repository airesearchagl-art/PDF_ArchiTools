/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The existing engines, called for real, on inputs built from the M7 model.
 *
 * The reuse audit says M7 can reach these through an adapter, with no change to
 * them. A claim like that is easy to write, so this runs it: the Production
 * functions are imported read-only from `src/` and given what
 * prototype/register-adapter.mjs produces. Nothing in `src/` is modified, and
 * nothing here needs a browser -- these are the engines' pure parts.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import './ts-resolve-hook.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seededUuidSource } from '../prototype/ids.mjs';
import { addProfile, newProject } from '../prototype/model-ops.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { displayedOrientation, evaluateRules, exactKey, sizeClass } from '../prototype/qa-rules.mjs';
import { fromTemplateProfile, observationFromRow, pageFactsFrom, toTemplateProfile } from '../prototype/register-adapter.mjs';
import { smallProject } from './helpers.mjs';

const template = await import('../../../src/utils/pdf-textifier/drawing-register-template.ts');
const register = await import('../../../src/utils/pdf-textifier/drawing-register.ts');
const types = await import('../../../src/utils/pdf-textifier/drawing-register-types.ts');
const geometry = await import('../../../src/utils/comparator/geometry.ts');
const normalizer = await import('../../../src/utils/page-size-normalizer.ts');

const A1 = { uprightWidth: 2383.94, uprightHeight: 1683.78 };
const PAGES = [
    { pageNumber: 1, ...A1 },
    { pageNumber: 2, uprightWidth: 1190.55, uprightHeight: 841.89 },   // A3 landscape
    { pageNumber: 3, uprightWidth: 3370.39, uprightHeight: 2383.94 },  // A0 landscape
    { pageNumber: 4, uprightWidth: 1683.78, uprightHeight: 2383.94 },  // A1 portrait
    { pageNumber: 5, uprightWidth: 600, uprightHeight: 400 },          // smaller than the title block
];
const RECTS = {
    drawing_number: { left: 2150.25, top: 1600.5, right: 2360.75, bottom: 1640.125 },
    drawing_title: { left: 1850, top: 1600.5, right: 2140, bottom: 1640.125 },
    revision: { left: 2150.25, top: 1645, right: 2250, bottom: 1675.3333333333333 },
    revision_date: { left: 2255, top: 1645, right: 2360.75, bottom: 1675.3333333333333 },
};

test('the four fields are the same four fields, in the same order', () => {
    assert.deepEqual([...types.REGISTER_FIELDS], ['drawing_number', 'drawing_title', 'revision', 'revision_date']);
    const profile = toTemplateProfile({
        id: 'x', name: 'n', transferModel: 'normalised', createdAt: '2026-10-05T00:00:00.000Z',
        referencePage: { uprightWidthPt: 10, uprightHeightPt: 10 },
        fields: { drawingNumber: { left: 0, top: 0, right: 1, bottom: 1 }, drawingTitle: { left: 1, top: 0, right: 2, bottom: 1 }, revision: { left: 2, top: 0, right: 3, bottom: 1 }, issueDate: { left: 3, top: 0, right: 4, bottom: 1 } },
    });
    assert.deepEqual(Object.keys(profile.fields), [...types.REGISTER_FIELDS]);
    assert.equal(template.missingFields(profile.fields).length, 0);
});

test('a profile saved by M7 and loaded again places every rectangle exactly where the engine\'s own profile does', () => {
    for (const model of ['normalised', 'corner-anchored']) {
        // The engine's own object, made by the engine.
        const original = template.createProfile({ name: 'title block', model, page: PAGES[0], fields: RECTS });

        // Through M7: into the model, out to a file, back in, back to the engine's shape.
        const ids = seededUuidSource(model.length);
        const now = Date.UTC(2026, 9, 5);
        const project = newProject({ name: 'parity', now, newId: ids });
        addProfile(project, { name: original.name, now, newId: ids, ...fromTemplateProfile(original) });
        const bytes = exportProject(project, { now, newFileId: ids() }).bytes;
        const reopened = importProject(bytes, { now }).project;
        const restored = toTemplateProfile(reopened.drawingSet.titleBlockProfiles[0]);

        assert.equal(restored.model, original.model);
        assert.deepEqual(restored.fields, original.fields);
        for (const page of PAGES) {
            // Not "close": identical. The numbers go through JSON and come back the same doubles.
            assert.deepEqual(template.applyProfile(restored, page), template.applyProfile(original, page), `${model} page ${page.pageNumber}`);
        }
    }
});

test('the two transfer models still mean what the engine says they mean', () => {
    const rect = RECTS.drawing_number;
    const a3 = PAGES[1];
    const normalised = template.transferRect(rect, A1, a3, 'normalised');
    assert.ok(Math.abs(normalised.left / a3.uprightWidth - rect.left / A1.uprightWidth) < 1e-12, 'a fraction of the sheet');
    const anchored = template.transferRect(rect, A1, a3, 'corner-anchored');
    assert.ok(Math.abs((a3.uprightWidth - anchored.right) - (A1.uprightWidth - rect.right)) < 1e-9, 'a fixed distance from the bottom-right corner');
    assert.ok(Math.abs((anchored.right - anchored.left) - (rect.right - rect.left)) < 1e-9, 'a fixed size');
});

test('M7 page facts are the engine\'s upright size and the Comparator\'s physical size', () => {
    for (const view of [[0, 0, 2383.94, 1683.78], [10, 20, 1200.55, 861.89], [0, 0, 1683.78, 2383.94], [-50, -50, 550, 350]]) {
        for (const rotate of [0, 90, 180, 270, -90, 450]) {
            const facts = pageFactsFrom(view, rotate, 'text-native');
            const reference = geometry.pageGeometry(view, rotate);
            assert.equal(facts.rotate, reference.rotate);
            assert.equal(facts.uprightWidthPt, reference.physical.width);
            assert.equal(facts.uprightHeightPt, reference.physical.height);
            // The register derives upright size from the scale-1 viewport (the display size), un-swapped.
            const quarter = reference.rotate % 180 === 90;
            assert.equal(facts.uprightWidthPt, quarter ? reference.displayHeight : reference.displayWidth);
            // Orientation as displayed, by the page-size normaliser's rule (square counts as landscape).
            assert.equal(displayedOrientation(facts), reference.displayWidth >= reference.displayHeight ? 'landscape' : 'portrait');
        }
    }
});

test('the size class is the page-size normaliser\'s detectPaperSize, on every size tried', () => {
    const mm = (value) => normalizer.mmToPt(value);
    let compared = 0;
    for (const key of normalizer.PAPER_SIZE_KEYS) {
        const { short, long } = normalizer.PAPER_SIZES_MM[key];
        for (const dShort of [-6, -5, -4.9, 0, 4.9, 5, 6]) {
            for (const dLong of [-6, -5, 0, 5, 6]) {
                for (const [w, h] of [[mm(short + dShort), mm(long + dLong)], [mm(long + dLong), mm(short + dShort)]]) {
                    assert.equal(sizeClass(w, h), normalizer.detectPaperSize(w, h) ?? 'OTHER', `${key} ${dShort} ${dLong}`);
                    compared += 1;
                }
            }
        }
    }
    let seed = 12345;
    for (let i = 0; i < 2000; i += 1) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; const w = 100 + (seed % 3400);
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; const h = 100 + (seed % 3400);
        assert.equal(sizeClass(w, h), normalizer.detectPaperSize(w, h) ?? 'OTHER');
        compared += 1;
    }
    assert.ok(compared > 2300);
    // AutoCAD's A1, the case the normaliser's tolerance exists for.
    assert.equal(sizeClass(2383.94, 1683.78), 'A1');
    assert.equal(normalizer.DETECT_TOLERANCE_MM, 5);
});

test('QA01 reports exactly the groups the register\'s own findDuplicates reports', () => {
    const numbers = ['A-101', 'A-102', ' A-101 ', 'A101', 'Ａ－１０１', 'a-101', '', '', 'S-01', 'S-01', 'S-01', 'A-102'];
    // The engine's side: rows built by the engine, duplicates found by the engine.
    const rows = numbers.map((number, i) => register.buildRow({
        pageNumber: i + 1, profileId: 'profile-1',
        fields: { drawing_number: { rawText: number, source: 'native' }, drawing_title: { rawText: 't', source: 'native' }, revision: { rawText: 'A', source: 'native' }, revision_date: { rawText: 'd', source: 'native' } },
    }));
    const engineGroups = register.findDuplicates(rows).map((g) => [g.number, g.pages]).sort();

    // M7's side: the same rows as observations in a model, through the adapter.
    const { model, bindings } = smallProject({ sheets: numbers.length, pagesPerSource: numbers.length, confirmedShare: 0, decidedShare: 0, duplicateEvery: 0, gapEvery: 0, variantEvery: 0, outlierEvery: 0 });
    const sheets = model.drawingSet.sheets;
    sheets.forEach((sheet, i) => {
        const observed = observationFromRow(rows[i], { ocrFailedReason: types.REVIEW_REASONS.OCR_FAILED });
        sheet.observation.fields = observed.fields;
        sheet.observation.status = observed.status;
    });
    const pageOf = new Map(sheets.map((s) => [s.id, s.pageNumber]));
    const m7Groups = evaluateRules(model, bindings).drafts
        .filter((d) => d.ruleId === 'QA01_DUPLICATE_NUMBER')
        .map((d) => [d.params.number, d.sheetIds.map((id) => pageOf.get(id)).sort((a, b) => a - b)])
        .sort();

    assert.deepEqual(m7Groups, engineGroups);
    assert.deepEqual(engineGroups, [['A-101', [1, 3]], ['A-102', [2, 12]], ['S-01', [9, 10, 11]]]);
    // The key is the same function of the value on both sides.
    for (const number of numbers) assert.equal(exactKey(number), number.trim());
});

test('an engine row becomes an M7 observation without the engine knowing', () => {
    const read = register.buildRow({
        pageNumber: 7, profileId: 'profile-1',
        fields: {
            drawing_number: { rawText: '図面番号\nA-101', source: 'native' },
            drawing_title: { rawText: '図面名称\n1階平面図', source: 'ocr', ocrScore: 64, wordCount: 3 },
            revision: { rawText: '', source: 'none' },
            revision_date: { rawText: '日付\n2026.10.05', source: 'ocr', ocrScore: 91, wordCount: 2 },
        },
    });
    const observed = observationFromRow(read, { ocrFailedReason: types.REVIEW_REASONS.OCR_FAILED });
    assert.equal(observed.status, 'READ');
    assert.deepEqual(observed.fields.drawingNumber, { value: 'A-101', rawText: '図面番号\nA-101', source: 'native', ocrScore: null });
    assert.deepEqual(observed.fields.drawingTitle, { value: '1階平面図', rawText: '図面名称\n1階平面図', source: 'ocr', ocrScore: 64 });
    assert.deepEqual(observed.fields.revision, { value: '', rawText: '', source: 'none', ocrScore: null });
    assert.equal(observed.fields.issueDate.value, '2026.10.05');
    // The value is the engine's own display rule, not a second opinion.
    assert.equal(observed.fields.drawingTitle.value, register.displayValue('図面名称\n1階平面図'));

    const failed = register.buildRow({ pageNumber: 8, profileId: 'profile-1', ocrFailed: true, fields: {} });
    assert.equal(observationFromRow(failed, { ocrFailedReason: types.REVIEW_REASONS.OCR_FAILED }).status, 'OCR_FAILED');

    // A row for a page nobody assigned a profile to is not an observation at all:
    // M7 keeps that as "no assignment", which is a question, not a reading.
    const unassigned = register.buildRow({ pageNumber: 9, profileAssigned: false });
    assert.equal(unassigned.extraction, 'unassigned');
});

test('the engine has one arrangement counter; M7\'s per-profile revision is a refinement of it, not a contradiction', () => {
    // In the engine, a row read under an older arrangement is refused at export.
    const row = register.buildRow({ pageNumber: 1, profileId: 'profile-1', sourceRevision: 3, fields: { drawing_number: { rawText: 'A-1', source: 'native' }, drawing_title: { rawText: 't', source: 'native' }, revision: { rawText: 'A', source: 'native' }, revision_date: { rawText: 'd', source: 'native' } } });
    const confirmed = register.confirmRow(row);
    assert.equal(register.exportReadiness([confirmed], 1, 3).ready, true);
    const stale = register.exportReadiness([confirmed], 1, 4);
    assert.equal(stale.ready, false);
    assert.deepEqual(stale.stalePages, [1]);
    // M7 states the same rule per profile: tests/stale.test.mjs shows a profile
    // change making that profile's sheets STALE_PROFILE and no others.
});
