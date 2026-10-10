/**
 * Which rows of a fixed-height list are worth putting in the DOM.
 *
 * The Sheet List has to stay usable at the contract's 5000 Sheets, and 5000
 * row elements is not usable. Only the rows in view, plus a small overscan on
 * each side, are rendered, so the number of row elements depends on the height
 * of the list, never on how many Sheets there are. Pure, so it is tested on its
 * own (scripts/smoke-m7-p1.mjs) as well as through the UI.
 */

export interface VirtualWindowInput {
    rowCount: number;
    rowHeight: number;
    scrollTop: number;
    viewportHeight: number;
    overscan: number;
}

export interface VirtualWindow {
    /** First row to render. */
    start: number;
    /** One past the last row to render. */
    end: number;
    /** Height of the whole list, so the scrollbar is honest. */
    totalHeight: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
    const rowCount = Math.max(0, Math.floor(input.rowCount));
    const rowHeight = Math.max(1, input.rowHeight);
    const overscan = Math.max(0, Math.floor(input.overscan));
    const totalHeight = rowCount * rowHeight;
    if (rowCount === 0) return { start: 0, end: 0, totalHeight };
    const viewportHeight = Math.max(0, input.viewportHeight);
    const scrollTop = clamp(input.scrollTop, 0, Math.max(0, totalHeight - viewportHeight));
    const first = Math.floor(scrollTop / rowHeight);
    const visible = Math.ceil(viewportHeight / rowHeight) + 1;
    return {
        start: clamp(first - overscan, 0, rowCount),
        end: clamp(first + visible + overscan, 0, rowCount),
        totalHeight,
    };
}

/** The most rows the window can ever hold for a viewport of this height. */
export const maxWindowRows = (viewportHeight: number, rowHeight: number, overscan: number): number =>
    Math.ceil(Math.max(0, viewportHeight) / Math.max(1, rowHeight)) + 1 + 2 * Math.max(0, Math.floor(overscan));

/** The scroll position that brings row `index` fully into view, moving as little as possible. */
export function scrollTopToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number): number {
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < scrollTop) return top;
    if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
    return scrollTop;
}
