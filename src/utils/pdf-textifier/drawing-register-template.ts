/**
 * Template profiles, and which pages they cover.
 *
 * The tempting shortcut is to key a template on sheet size -- same size, same
 * title block. Real drawing sets refute it: one issue carries several offices'
 * templates, and two sheets of the same size routinely carry different blocks.
 * So a profile is assigned to pages by a person, explicitly, and a page nobody
 * has assigned is *unassigned* rather than guessed.
 *
 * Nothing in this module infers an assignment. There is no fit score that
 * promotes a page into a profile, no "the only profile we have" fallback, and
 * no sheet-size match. Those all look helpful and all fail the same way: they
 * produce four empty fields on pages that never belonged to the template, and
 * empty fields read as a page problem rather than a template problem.
 */

import type { SelectionRect } from './table-types';
import type {
    PageAssignment, RegisterFieldName, TemplateProfile, TransferModel,
} from './drawing-register-types';
import { REGISTER_FIELDS } from './drawing-register-types';

/** A page's upright size, which is all a transfer needs to know about it. */
export interface UprightPage {
    pageNumber: number;
    uprightWidth: number;
    uprightHeight: number;
}

/**
 * Every field rectangle a profile needs, or the ones still missing.
 *
 * A profile with three of four rectangles cannot read a register row, so it
 * cannot be saved. Returning the missing names rather than a boolean lets the
 * UI say which one is outstanding.
 */
export function missingFields(
    fields: Partial<Record<RegisterFieldName, SelectionRect>>,
): RegisterFieldName[] {
    return REGISTER_FIELDS.filter((name) => {
        const rect = fields[name];
        return !rect || rect.right <= rect.left || rect.bottom <= rect.top;
    });
}

let profileSeq = 0;

/**
 * Build a profile from rectangles drawn on one page.
 *
 * Throws when a rectangle is missing. This is a programming error rather than
 * a user error -- the UI is expected to have called `missingFields` first --
 * and failing loudly is better than saving a profile that cannot work.
 */
export function createProfile(options: {
    name: string;
    model: TransferModel;
    page: UprightPage;
    fields: Partial<Record<RegisterFieldName, SelectionRect>>;
}): TemplateProfile {
    const missing = missingFields(options.fields);
    if (missing.length > 0) {
        throw new Error(`プロファイルには4つの領域がすべて必要です（不足: ${missing.join(', ')}）`);
    }
    profileSeq += 1;
    return {
        id: `profile-${profileSeq}`,
        name: options.name.trim() || `プロファイル ${profileSeq}`,
        model: options.model,
        sourcePage: {
            pageNumber: options.page.pageNumber,
            uprightWidth: options.page.uprightWidth,
            uprightHeight: options.page.uprightHeight,
        },
        fields: Object.fromEntries(
            REGISTER_FIELDS.map((name) => [name, { ...options.fields[name]! }]),
        ) as Record<RegisterFieldName, SelectionRect>,
        createdAt: Date.now(),
    };
}

/**
 * Move one rectangle from the profile's page onto another page.
 *
 * `normalised` keeps the rectangle's position and size as fractions of the
 * sheet. `corner-anchored` keeps its distance from the bottom-right corner and
 * its size in points, which is what a fixed-size title block does.
 *
 * Both are clamped to the page. A rectangle that would fall off the sheet is
 * not evidence of anything except a template that does not belong here, and
 * the extraction will report empty fields for it -- which is the correct
 * outcome, arrived at honestly.
 */
export function transferRect(
    rect: SelectionRect,
    from: { uprightWidth: number; uprightHeight: number },
    to: { uprightWidth: number; uprightHeight: number },
    model: TransferModel,
): SelectionRect {
    let moved: SelectionRect;
    if (model === 'normalised') {
        const sx = to.uprightWidth / from.uprightWidth;
        const sy = to.uprightHeight / from.uprightHeight;
        moved = {
            left: rect.left * sx,
            right: rect.right * sx,
            top: rect.top * sy,
            bottom: rect.bottom * sy,
        };
    } else {
        const rightGap = from.uprightWidth - rect.right;
        const bottomGap = from.uprightHeight - rect.bottom;
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        const right = to.uprightWidth - rightGap;
        const bottom = to.uprightHeight - bottomGap;
        moved = { left: right - width, right, top: bottom - height, bottom };
    }
    return {
        left: Math.max(0, Math.min(moved.left, to.uprightWidth)),
        right: Math.max(0, Math.min(moved.right, to.uprightWidth)),
        top: Math.max(0, Math.min(moved.top, to.uprightHeight)),
        bottom: Math.max(0, Math.min(moved.bottom, to.uprightHeight)),
    };
}

/** Every field rectangle of a profile, placed on one page. */
export function applyProfile(
    profile: TemplateProfile, page: UprightPage,
): Record<RegisterFieldName, SelectionRect> {
    return Object.fromEntries(REGISTER_FIELDS.map((name) => [
        name,
        transferRect(profile.fields[name], profile.sourcePage, page, profile.model),
    ])) as Record<RegisterFieldName, SelectionRect>;
}

/**
 * The smallest rectangle covering several, with a little air around it.
 *
 * Used to render one image for all the fields that need recognising, instead
 * of one image each.
 */
export function unionRect(rects: SelectionRect[], pad = 6): SelectionRect | null {
    if (rects.length === 0) return null;
    const union = rects.reduce((acc, r) => ({
        left: Math.min(acc.left, r.left),
        top: Math.min(acc.top, r.top),
        right: Math.max(acc.right, r.right),
        bottom: Math.max(acc.bottom, r.bottom),
    }));
    return {
        left: Math.max(0, union.left - pad),
        top: Math.max(0, union.top - pad),
        right: union.right + pad,
        bottom: union.bottom + pad,
    };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Which pages a person has put under which profile.
 *
 * A plain map, deliberately. There is no resolution logic to hide a default
 * in: a page is in the map or it is not, and not being in it is an answer the
 * caller has to handle.
 */
export class AssignmentSet {
    private readonly byPage = new Map<number, PageAssignment>();

    /** Assign pages to a profile. Existing assignments are returned, not overwritten. */
    assign(pageNumbers: number[], profileId: string): { assigned: number[]; conflicts: PageAssignment[] } {
        const assigned: number[] = [];
        const conflicts: PageAssignment[] = [];
        for (const pageNumber of pageNumbers) {
            const existing = this.byPage.get(pageNumber);
            if (existing && existing.profileId !== profileId) {
                conflicts.push(existing);
                continue;
            }
            this.byPage.set(pageNumber, { pageNumber, profileId, confirmedAt: Date.now() });
            assigned.push(pageNumber);
        }
        return { assigned, conflicts };
    }

    /**
     * Move pages to a profile even though they already belong to another.
     *
     * Separate from `assign` on purpose: reassigning is a decision, and a
     * silent overwrite would let a range selection quietly re-key pages the
     * user had already answered for.
     */
    reassign(pageNumbers: number[], profileId: string): number[] {
        for (const pageNumber of pageNumbers) {
            this.byPage.set(pageNumber, { pageNumber, profileId, confirmedAt: Date.now() });
        }
        return [...pageNumbers];
    }

    clear(pageNumbers: number[]): void {
        for (const pageNumber of pageNumbers) this.byPage.delete(pageNumber);
    }

    /** Drop every assignment to a profile, for when the profile is deleted. */
    clearProfile(profileId: string): number[] {
        const dropped: number[] = [];
        for (const [pageNumber, assignment] of this.byPage) {
            if (assignment.profileId === profileId) {
                this.byPage.delete(pageNumber);
                dropped.push(pageNumber);
            }
        }
        return dropped;
    }

    /**
     * The assignment for a page, or null.
     *
     * Null is a real answer. It does not mean "use the only profile there is",
     * and it does not mean "use the one whose rectangles happen to fit".
     */
    get(pageNumber: number): PageAssignment | null {
        return this.byPage.get(pageNumber) ?? null;
    }

    unassigned(pageCount: number): number[] {
        const out: number[] = [];
        for (let page = 1; page <= pageCount; page++) {
            if (!this.byPage.has(page)) out.push(page);
        }
        return out;
    }

    entries(): PageAssignment[] {
        return [...this.byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
    }

    get size(): number {
        return this.byPage.size;
    }
}

/**
 * Parse a page range like "1-3, 7, 10-12".
 *
 * Out-of-range and unparsable parts are reported rather than dropped, so the
 * UI can say "12 is past the end of this document" instead of silently
 * assigning eleven pages when the user asked for twelve.
 */
export function parsePageRange(input: string, pageCount: number): { pages: number[]; errors: string[] } {
    const pages = new Set<number>();
    const errors: string[] = [];
    for (const part of input.split(/[,、\s]+/).filter(Boolean)) {
        const range = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(part);
        const single = /^(\d+)$/.exec(part);
        if (range) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            if (from < 1 || to > pageCount || from > to) {
                errors.push(`${part} はこの文書のページ範囲（1-${pageCount}）から外れています`);
                continue;
            }
            for (let page = from; page <= to; page++) pages.add(page);
        } else if (single) {
            const page = Number(single[1]);
            if (page < 1 || page > pageCount) {
                errors.push(`${part} はこの文書のページ範囲（1-${pageCount}）から外れています`);
                continue;
            }
            pages.add(page);
        } else {
            errors.push(`${part} を数字またはページ範囲として読み取れませんでした`);
        }
    }
    return { pages: [...pages].sort((a, b) => a - b), errors };
}
