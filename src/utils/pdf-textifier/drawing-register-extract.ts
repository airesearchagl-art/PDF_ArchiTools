/**
 * Reading a register out of a document.
 *
 * One pass over the pages. For each page the profile a person assigned decides
 * where the fields are; for each field, its own native text decides whether it
 * needs recognising. A page with no assigned profile is not skipped and not
 * guessed at -- it produces a row saying so.
 *
 * The source decision is per field and not per page, and the difference is not
 * academic. A raster sheet whose drawing number was left as vector text
 * classifies as *not scanned*, so a page-level switch reads that one field,
 * leaves three empty, and reports nothing unusual.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SelectionRect } from './table-types';
import type {
    ExtractionStats, RegisterExtractionResult, RegisterFieldName, RegisterRow, TemplateProfile,
} from './drawing-register-types';
import { REGISTER_FIELDS } from './drawing-register-types';
import type { AssignmentSet } from './drawing-register-template';
import { applyProfile } from './drawing-register-template';
import { analyseRegisterPage, tokensToRawText } from './drawing-register-geometry';
import type { RegisterOcrEngine } from './drawing-register-ocr';
import { annotateRegister, buildRow } from './drawing-register';
import type { FieldExtraction } from './drawing-register';

export interface ExtractOptions {
    doc: PDFDocumentProxy;
    profiles: Map<string, TemplateProfile>;
    assignments: AssignmentSet;
    ocr: RegisterOcrEngine;
    /**
     * The arrangement of profiles and assignments these rows are read under.
     *
     * Stamped onto every row, so a register can be told apart from the one that
     * would be produced now. See `RegisterRow.sourceRevision`.
     */
    sourceRevision?: number;
    dpi?: number;
    /** Polled between pages; true abandons the run without publishing. */
    shouldCancel?: () => boolean;
    onProgress?: (pageNumber: number, total: number) => void;
}

/**
 * Extract one candidate row per page.
 *
 * Throws `cancelled` if `shouldCancel` goes true, so a caller can distinguish
 * an abandoned run from a failed one and publish neither.
 */
export async function extractRegister(options: ExtractOptions): Promise<RegisterExtractionResult> {
    const {
        doc, profiles, assignments, ocr, dpi, sourceRevision = 0,
        shouldCancel = () => false, onProgress,
    } = options;
    const started = Date.now();
    const total = doc.numPages;
    const rows: RegisterRow[] = [];
    const stats: ExtractionStats = {
        pages: total, assignedPages: 0, unassignedPages: 0,
        ocrCalls: 0, ocrPixels: 0, maxRegionPixels: 0, ms: 0,
    };

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
        if (shouldCancel()) throw new Error('cancelled');
        onProgress?.(pageNumber, total);

        const assignment = assignments.get(pageNumber);
        const profile = assignment ? profiles.get(assignment.profileId) ?? null : null;

        // No profile, or a profile that has since been deleted. Either way this
        // page is not run through some other template that happens to exist.
        if (!profile) {
            stats.unassignedPages += 1;
            rows.push(buildRow({ pageNumber, profileAssigned: false, sourceRevision }));
            continue;
        }
        stats.assignedPages += 1;

        const geometry = await analyseRegisterPage(doc, pageNumber);
        if (shouldCancel()) throw new Error('cancelled');

        const regions = applyProfile(profile, geometry);
        const fields: Partial<Record<RegisterFieldName, FieldExtraction>> = {};
        const needsOcr: Partial<Record<RegisterFieldName, SelectionRect>> = {};

        for (const name of REGISTER_FIELDS) {
            const rawText = tokensToRawText(geometry.tokens, regions[name]);
            if (rawText !== '') {
                fields[name] = { rawText, source: 'native' };
            } else {
                needsOcr[name] = regions[name];
            }
        }

        let ocrFailed = false;
        if (Object.keys(needsOcr).length > 0) {
            const page = await doc.getPage(pageNumber);
            try {
                await ocr.start();
                const run = await ocr.recogniseFields(page, needsOcr, { dpi });
                stats.ocrCalls += run.calls;
                stats.ocrPixels += run.pixels;
                stats.maxRegionPixels = Math.max(stats.maxRegionPixels, run.pixels);
                for (const name of Object.keys(needsOcr) as RegisterFieldName[]) {
                    const found = run.fields[name];
                    fields[name] = {
                        rawText: found?.rawText ?? '',
                        source: 'ocr',
                        ocrScore: found?.score ?? null,
                        wordCount: found?.wordCount ?? null,
                    };
                }
            } catch (error) {
                // A page that could not be recognised still gets its row. The
                // failure is the row's reason, not a reason to lose the page.
                ocrFailed = true;
                for (const name of Object.keys(needsOcr) as RegisterFieldName[]) {
                    fields[name] = { rawText: '', source: 'none' };
                }
                if (import.meta.env?.DEV) console.warn(`page ${pageNumber}: OCR failed`, error);
            } finally {
                page.cleanup();
            }
        }

        if (shouldCancel()) throw new Error('cancelled');
        rows.push(buildRow({ pageNumber, profileId: profile.id, fields, ocrFailed, sourceRevision }));
    }

    stats.ms = Date.now() - started;
    return { rows: annotateRegister(rows), stats, sourceRevision };
}
