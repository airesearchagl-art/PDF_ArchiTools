/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The boundary between the existing Drawing Register engine and an M7 model,
 * written out as the pure mappings it would consist of.
 *
 * This is the "adapter only" claim of reuse-audit.md made concrete. The engine
 * (`src/utils/pdf-textifier/drawing-register*.ts`) is not changed and not
 * wrapped in anything clever: its inputs are built from M7 records by the
 * functions below, and its output rows are turned into M7 observations by the
 * others. tests/reuse-parity.test.mjs runs the real engine functions on what
 * these produce.
 *
 * Three things differ between the two sides, and the adapter is exactly those
 * three things:
 *
 *   names       `drawingNumber` here, `drawing_number` there; `issueDate` here
 *               is the engine's `revision_date` (labelled 日付 on screen).
 *   identity    the engine addresses a page by number inside one document and a
 *               profile by a per-page-load `profile-N`; M7 addresses a Sheet
 *               and a Profile by UUID.
 *   arrangement the engine has one `sourceRevision` counter for the whole
 *               arrangement; M7 has a revision per profile, so a change to one
 *               profile does not invalidate another's sheets.
 *
 * Nothing here imports the engine, so this file loads on its own.
 */

import { FIELD_NAMES, REGISTER_FIELD_BY_NAME, sanitizeMultiLine, sanitizeSingleLine } from './model-ops.mjs';

/** An M7 TitleBlockProfile as the engine's `TemplateProfile`. */
export function toTemplateProfile(profile) {
    return {
        id: profile.id,
        name: profile.name,
        model: profile.transferModel,
        // The engine needs the reference page's size to transfer from. The page
        // number is display-only there and is not kept by M7.
        sourcePage: { pageNumber: 1, uprightWidth: profile.referencePage.uprightWidthPt, uprightHeight: profile.referencePage.uprightHeightPt },
        fields: Object.fromEntries(FIELD_NAMES.map((name) => [REGISTER_FIELD_BY_NAME[name], { ...profile.fields[name] }])),
        createdAt: Date.parse(profile.createdAt),
    };
}

/** The engine's `TemplateProfile` as the geometry of an M7 TitleBlockProfile. */
export function fromTemplateProfile(template) {
    return {
        transferModel: template.model,
        referencePage: { uprightWidthPt: template.sourcePage.uprightWidth, uprightHeightPt: template.sourcePage.uprightHeight },
        fields: Object.fromEntries(FIELD_NAMES.map((name) => [name, { ...template.fields[REGISTER_FIELD_BY_NAME[name]] }])),
    };
}

/**
 * The page facts M7 keeps, from what PDF.js reports for a page.
 *
 * `view` is PDF.js's visible box (the CropBox within the MediaBox) and `rotate`
 * its /Rotate. The upright size is the box's own width and height -- the same
 * `uprightWidth` / `uprightHeight` the register's `analyseRegisterPage` derives
 * from the scale-1 viewport, and the `physical` size of the Comparator's
 * `pageGeometry`.
 */
export function pageFactsFrom(view, rotate, kind) {
    const [x0, y0, x1, y1] = view;
    return {
        uprightWidthPt: Math.abs(x1 - x0),
        uprightHeightPt: Math.abs(y1 - y0),
        rotate: (((Math.round(rotate / 90) * 90) % 360) + 360) % 360,
        kind,
    };
}

/**
 * One engine `RegisterRow` as the `fields` and `status` of an M7 observation.
 *
 * `ocrFailedReason` is the engine's `REVIEW_REASONS.OCR_FAILED`: the row says
 * recognition failed by carrying that reason, and it is passed in rather than
 * copied here so the two cannot drift.
 *
 * The engine's `rawText` is evidence and is stored as it arrives, with one
 * exception that is not optional: the storable text domain. A control
 * character or an over-long excerpt cannot be written, so it is not.
 */
export function observationFromRow(row, { ocrFailedReason }) {
    return {
        status: row.reviewReasons.includes(ocrFailedReason) ? 'OCR_FAILED' : 'READ',
        fields: Object.fromEntries(FIELD_NAMES.map((name) => {
            const field = row.fields[REGISTER_FIELD_BY_NAME[name]];
            return [name, {
                value: sanitizeSingleLine(field.value, 300),
                rawText: sanitizeMultiLine(field.rawText, 1000),
                source: field.source,
                ocrScore: field.ocrScore,
            }];
        })),
    };
}

/**
 * The sheets of ONE source, as the engine's per-document inputs.
 *
 * The engine extracts one PDF at a time, so an extraction over a Drawing Set is
 * one call per bound Source. Returns the profile map and the page assignments
 * that call needs, and the way back from a page number to a Sheet.
 */
export function engineInputsForSource(model, sourceId) {
    const profiles = new Map(model.drawingSet.titleBlockProfiles.map((p) => [p.id, toTemplateProfile(p)]));
    const assignments = [];
    const sheetByPage = new Map();
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.sourceId !== sourceId || sheet.retiredAt !== null) continue;
        sheetByPage.set(sheet.pageNumber, sheet);
        if (sheet.profileAssignment) {
            assignments.push({ pageNumber: sheet.pageNumber, profileId: sheet.profileAssignment.profileId, confirmedAt: Date.parse(sheet.profileAssignment.confirmedAt) });
        }
    }
    return { profiles, assignments, sheetByPage };
}
