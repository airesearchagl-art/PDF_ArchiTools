/**
 * The rectangles a user might actually drag.
 *
 * RESEARCH ONLY.
 *
 * The first version of this spike measured "region mode" by handing the
 * reconstructor the ground-truth bounding box. That is an oracle: it is the
 * right answer, drawn to the point. Worse, on a page with no table there was no
 * truth box to hand over, so nothing was selected and no false positive was
 * possible -- the zero it reported was arithmetic, not evidence.
 *
 * So selections are generated here instead, deterministically, in four
 * families:
 *
 *   oracle        the exact truth box, kept as a baseline and labelled as one
 *   robustness    the same box missed by a little, the way a hand misses
 *   over          a box that swallows neighbouring drawing content
 *   under         a box that cuts the table's own edges off
 *   adversarial   a box drawn deliberately around something that is not a
 *                 schedule, because a user can do that and the reconstructor
 *                 has to have an answer
 *
 * Every offset is a fixed number of points, chosen once and written down, so a
 * rerun measures the algorithm rather than the run.
 */

/** Points. Small enough to be a slip of the hand, large enough to matter. */
export const NUDGE = 4;
export const OFFSETS = {
    expand: [4, 12, 24],
    shrink: [2, 4],
    shift: [4],
    over: [60, 120],
};

const grow = (b, d) => ({ left: b.left - d, top: b.top - d, right: b.right + d, bottom: b.bottom + d });
const move = (b, dx, dy) => ({ left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy });

/**
 * Column and row pitch for a table, used to cut exactly half a cell off an
 * edge. Native answer keys carry the real boundaries; a scanned one does not,
 * so the table is divided evenly instead. Both are deterministic.
 */
function pitch(table) {
    const cols = table.colX && table.colX.length > 1
        ? { first: table.colX[1] - table.colX[0], last: table.colX[table.colX.length - 1] - table.colX[table.colX.length - 2] }
        : { first: (table.bbox.right - table.bbox.left) / table.cols, last: (table.bbox.right - table.bbox.left) / table.cols };
    const rows = table.rowY && table.rowY.length > 1
        ? { first: table.rowY[1] - table.rowY[0], last: table.rowY[table.rowY.length - 1] - table.rowY[table.rowY.length - 2] }
        : { first: (table.bbox.bottom - table.bbox.top) / table.rows, last: (table.bbox.bottom - table.bbox.top) / table.rows };
    return { cols, rows };
}

/** Every selection to try for one real table. */
export function selectionsForTable(table) {
    const b = table.bbox;
    const p = pitch(table);
    const out = [
        { name: 'oracle', family: 'oracle', bbox: { ...b }, note: 'the exact truth box: a baseline, not a user' },
    ];

    for (const d of OFFSETS.expand) {
        out.push({ name: `expand+${d}`, family: 'robustness', bbox: grow(b, d), note: `all edges out by ${d} pt` });
    }
    for (const d of OFFSETS.shrink) {
        out.push({ name: `shrink-${d}`, family: 'robustness', bbox: grow(b, -d), note: `all edges in by ${d} pt` });
    }
    for (const d of OFFSETS.shift) {
        out.push({ name: `shiftX+${d}`, family: 'robustness', bbox: move(b, d, 0), note: `whole box right by ${d} pt` });
        out.push({ name: `shiftX-${d}`, family: 'robustness', bbox: move(b, -d, 0), note: `whole box left by ${d} pt` });
        out.push({ name: `shiftY+${d}`, family: 'robustness', bbox: move(b, 0, d), note: `whole box down by ${d} pt` });
        out.push({ name: `shiftY-${d}`, family: 'robustness', bbox: move(b, 0, -d), note: `whole box up by ${d} pt` });
    }

    for (const d of OFFSETS.over) {
        out.push({ name: `over+${d}`, family: 'over', bbox: grow(b, d), note: `${d} pt of whatever is around the table` });
    }

    out.push({
        name: 'omit-left', family: 'under',
        bbox: { ...b, left: b.left + p.cols.first * 0.5 },
        note: 'left border and half the first column cut off',
    });
    out.push({
        name: 'omit-right', family: 'under',
        bbox: { ...b, right: b.right - p.cols.last * 0.5 },
        note: 'right border and half the last column cut off',
    });
    out.push({
        name: 'omit-first-row', family: 'under',
        bbox: { ...b, top: b.top + p.rows.first * 0.5 },
        note: 'top edge and half the header row cut off',
    });
    out.push({
        name: 'omit-last-row', family: 'under',
        bbox: { ...b, bottom: b.bottom - p.rows.last * 0.5 },
        note: 'bottom edge and half the last row cut off',
    });
    out.push({
        name: 'clip-text', family: 'under',
        bbox: grow(b, -1),
        note: 'one point inside every border, clipping glyphs that sit against it',
    });

    return out;
}

/**
 * A page with no table still has to be selectable.
 *
 * The user can drag a box around a title block, and the honest question is what
 * happens then -- not whether the algorithm somehow knows better. The box is
 * the bounding box of everything written on the page, padded, which for these
 * single-purpose fixtures is the trap itself.
 */
export function selectionForPage(tokens, { pad = 6 } = {}) {
    if (!tokens.length) return null;
    return {
        name: 'whole-content', family: 'adversarial',
        bbox: {
            left: Math.min(...tokens.map((t) => t.x0)) - pad,
            top: Math.min(...tokens.map((t) => t.y0)) - pad,
            right: Math.max(...tokens.map((t) => t.x1)) + pad,
            bottom: Math.max(...tokens.map((t) => t.y1)) + pad,
        },
        note: 'everything on the page, as a user would enclose it',
    };
}

/** Tokens whose centre falls inside the selection. */
export function tokensIn(tokens, bbox) {
    return tokens.filter((t) => {
        const cx = (t.x0 + t.x1) / 2;
        const cy = (t.y0 + t.y1) / 2;
        return cx >= bbox.left && cx <= bbox.right && cy >= bbox.top && cy <= bbox.bottom;
    });
}

/**
 * Ruling segments that touch the selection, clipped to it.
 *
 * Clipped rather than merely filtered: a border line running the width of the
 * sheet must not drag the whole sheet's geometry into a selection the user drew
 * around one table.
 */
export function segmentsIn(segments, bbox) {
    const out = [];
    for (const s of segments) {
        if (s.x1 < bbox.left || s.x0 > bbox.right || s.y1 < bbox.top || s.y0 > bbox.bottom) continue;
        const x0 = Math.max(s.x0, bbox.left);
        const x1 = Math.min(s.x1, bbox.right);
        const y0 = Math.max(s.y0, bbox.top);
        const y1 = Math.min(s.y1, bbox.bottom);
        if (x1 < x0 || y1 < y0) continue;
        out.push({ ...s, x0, x1, y0, y1, length: Math.max(x1 - x0, y1 - y0) });
    }
    return out;
}
