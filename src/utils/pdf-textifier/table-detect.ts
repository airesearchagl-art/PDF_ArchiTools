/**
 * Find the grid the user pointed at.
 *
 * Two signals, in a fixed order. Ruling lines first, because where a page draws
 * its own cell boundaries they are exact and cheap. Token geometry second, for
 * a table with no lines at all -- bounded, because it is the expensive one.
 *
 * The user's rectangle says *which* grid, not where its edges are. A rectangle
 * drawn a few points off a ruled table would otherwise cut the table's own
 * borders away, leaving its cells unclosed and the grid gone; snapping to the
 * enclosing grid is what makes an ordinary imprecise drag work.
 */
import type {
    PageGeometry, RulingSegment, SelectionRect, TableToken,
} from './table-types';
import { rectOverlap, segmentsInRect, tokensInRect } from './table-geometry';

/** Ruling positions this close together are the same line. */
const LINE_TOLERANCE = 2;
/** A cell smaller than this is the inside of a line, not a cell. */
const MIN_CELL = 2;
/** A grid needs at least this share of its cells actually closed. */
const MIN_COVERAGE = 0.7;
/** A grid with less text than this is a lattice, not a table. */
const MIN_FILLED_CELLS = 2;
/** A snapped grid has to be the one the user pointed at. */
export const SNAP_OVERLAP = 0.5;
/** Two candidates this close in overlap are not distinguishable. */
export const AMBIGUITY_MARGIN = 0.15;

/**
 * Default bound on the geometry fallback.
 *
 * Measured in the architecture spike: the unbounded route takes about two
 * seconds for twenty thousand tokens, on the main thread. This keeps a
 * selection's work to a fraction of that. A selection past the bound is
 * refused, never truncated -- half a table reconstructed in silence is worse
 * than being told the selection is too dense.
 */
export const MAX_GEOMETRY_TOKENS = 5000;

/** Rows are grouped after every batch of this many tokens, then the loop yields. */
const YIELD_EVERY = 500;

export interface RawGrid {
    source: 'ruling' | 'geometry';
    rowBounds: number[];
    colBounds: number[];
    tokens: TableToken[];
    bbox: SelectionRect;
    /** Closed-cell coverage for a ruled grid; column support for geometry. */
    quality: number;
}

const centreY = (t: TableToken) => (t.y0 + t.y1) / 2;
const tokenHeight = (t: TableToken) => Math.max(1, t.y1 - t.y0);

/** Let the browser breathe. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

// ---------------------------------------------------------------------------
// Ruling lines
// ---------------------------------------------------------------------------

interface MergedLine {
    pos: number;
    spans: { from: number; to: number }[];
}

function mergeLines(segments: RulingSegment[], axis: 'x' | 'y'): MergedLine[] {
    const key = axis === 'y'
        ? (s: RulingSegment) => (s.y0 + s.y1) / 2
        : (s: RulingSegment) => (s.x0 + s.x1) / 2;
    const extent = axis === 'y'
        ? (s: RulingSegment) => ({ from: s.x0, to: s.x1 })
        : (s: RulingSegment) => ({ from: s.y0, to: s.y1 });

    const sorted = [...segments].sort((a, b) => key(a) - key(b));
    const lines: (MergedLine & { n: number })[] = [];
    for (const s of sorted) {
        const last = lines[lines.length - 1];
        if (last && key(s) - last.pos <= LINE_TOLERANCE) {
            last.spans.push(extent(s));
            last.pos = (last.pos * last.n + key(s)) / (last.n + 1);
            last.n++;
            continue;
        }
        lines.push({ pos: key(s), n: 1, spans: [extent(s)] });
    }
    for (const line of lines) {
        line.spans.sort((a, b) => a.from - b.from);
        const merged: { from: number; to: number }[] = [];
        for (const span of line.spans) {
            const last = merged[merged.length - 1];
            if (last && span.from <= last.to + LINE_TOLERANCE) {
                last.to = Math.max(last.to, span.to);
                continue;
            }
            merged.push({ ...span });
        }
        line.spans = merged;
    }
    return lines.map(({ pos, spans }) => ({ pos, spans }));
}

/**
 * Grids implied by the page's own lines.
 *
 * A cell counts when all four of its edges are really drawn. Grouping lines by
 * how near they are cannot survive a drawing border, which spans the sheet and
 * would join everything on it into one meaningless block; connected runs of
 * closed cells do.
 */
export function findRuledGrids(tokens: TableToken[], segments: RulingSegment[]): RawGrid[] {
    if (!segments.length) return [];
    const hs = segments.filter((s) => s.orientation === 'h');
    const vs = segments.filter((s) => s.orientation === 'v');
    if (!hs.length || !vs.length) return [];

    const rowLines = mergeLines(hs, 'y').sort((a, b) => a.pos - b.pos);
    const colLines = mergeLines(vs, 'x').sort((a, b) => a.pos - b.pos);
    if (rowLines.length < 2 || colLines.length < 2) return [];

    const covers = (line: MergedLine, from: number, to: number) =>
        line.spans.some((s) => s.from <= from + LINE_TOLERANCE * 2 && s.to >= to - LINE_TOLERANCE * 2);

    const R = rowLines.length - 1;
    const C = colLines.length - 1;
    const closed: boolean[][] = Array.from({ length: R }, () => new Array<boolean>(C).fill(false));
    for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
            const x0 = colLines[j].pos;
            const x1 = colLines[j + 1].pos;
            const y0 = rowLines[i].pos;
            const y1 = rowLines[i + 1].pos;
            if (x1 - x0 < MIN_CELL || y1 - y0 < MIN_CELL) continue;
            closed[i][j] = covers(rowLines[i], x0, x1) && covers(rowLines[i + 1], x0, x1)
                && covers(colLines[j], y0, y1) && covers(colLines[j + 1], y0, y1);
        }
    }

    const seen: boolean[][] = Array.from({ length: R }, () => new Array<boolean>(C).fill(false));
    const grids: RawGrid[] = [];
    for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
            if (!closed[i][j] || seen[i][j]) continue;
            const stack: [number, number][] = [[i, j]];
            const cells: [number, number][] = [];
            seen[i][j] = true;
            while (stack.length) {
                const [r, c] = stack.pop()!;
                cells.push([r, c]);
                for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nr = r + dr;
                    const nc = c + dc;
                    if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
                    if (!closed[nr][nc] || seen[nr][nc]) continue;
                    seen[nr][nc] = true;
                    stack.push([nr, nc]);
                }
            }
            const r0 = Math.min(...cells.map((p) => p[0]));
            const r1 = Math.max(...cells.map((p) => p[0]));
            const c0 = Math.min(...cells.map((p) => p[1]));
            const c1 = Math.max(...cells.map((p) => p[1]));
            const rows = r1 - r0 + 1;
            const cols = c1 - c0 + 1;
            if (rows < 2 || cols < 2) continue;
            // A ragged component is not a grid: an L of cells round a corner
            // would otherwise be squared off into a table that is mostly holes.
            const coverage = cells.length / (rows * cols);
            if (coverage < MIN_COVERAGE) continue;

            const rowBounds = rowLines.slice(r0, r1 + 2).map((l) => l.pos);
            const colBounds = colLines.slice(c0, c1 + 2).map((l) => l.pos);
            const bbox: SelectionRect = {
                left: colBounds[0], right: colBounds[colBounds.length - 1],
                top: rowBounds[0], bottom: rowBounds[rowBounds.length - 1],
            };
            const inside = tokensInRect(tokens, bbox);
            // A grid with nothing written in it is not a table. Column-grid
            // bubbles and hatching close rectangles by the dozen on a real
            // sheet, and every one would otherwise be a candidate.
            if (inside.length < MIN_FILLED_CELLS) continue;
            grids.push({ source: 'ruling', rowBounds, colBounds, tokens: inside, bbox, quality: coverage });
        }
    }
    return grids;
}

// ---------------------------------------------------------------------------
// Token geometry
// ---------------------------------------------------------------------------

export interface TokenRow {
    y0: number;
    y1: number;
    tokens: TableToken[];
}

/**
 * Group tokens into lines by vertical overlap.
 *
 * Overlap rather than a shared baseline: boxes for the same line rarely agree
 * on a baseline to the point, and a rule that needs them to would split one row
 * of a table into three.
 */
export function groupRows(tokens: TableToken[]): TokenRow[] {
    const sorted = [...tokens]
        .filter((t) => t.text.trim() !== '')
        .sort((a, b) => centreY(a) - centreY(b) || a.x0 - b.x0);
    const rows: TokenRow[] = [];
    for (const token of sorted) {
        const row = rows[rows.length - 1];
        if (row) {
            const shared = Math.min(row.y1, token.y1) - Math.max(row.y0, token.y0);
            const smaller = Math.min(row.y1 - row.y0, tokenHeight(token));
            if (shared > 0 && smaller > 0 && shared / smaller >= 0.5) {
                row.tokens.push(token);
                row.y0 = Math.min(row.y0, token.y0);
                row.y1 = Math.max(row.y1, token.y1);
                continue;
            }
        }
        rows.push({ y0: token.y0, y1: token.y1, tokens: [token] });
    }
    for (const row of rows) row.tokens.sort((a, b) => a.x0 - b.x0);
    return rows;
}

/** Column starts shared by enough of the rows to count as columns. */
function inferColumns(rows: TokenRow[], tol = 3): { columns: number[]; support: number } | null {
    const starts: number[] = [];
    for (const row of rows) for (const t of row.tokens) starts.push(t.x0);
    if (!starts.length) return null;

    const sorted = [...starts].sort((a, b) => a - b);
    const clusters: { values: number[]; max: number; mean: number }[] = [];
    for (const v of sorted) {
        const last = clusters[clusters.length - 1];
        if (last && v - last.max <= tol) {
            last.values.push(v);
            last.max = v;
            last.mean = last.values.reduce((a, b) => a + b, 0) / last.values.length;
            continue;
        }
        clusters.push({ values: [v], max: v, mean: v });
    }

    const hits = (mean: number) => rows.filter((r) => r.tokens.some((t) => Math.abs(t.x0 - mean) <= tol * 2)).length;
    const kept = clusters.filter((c) => hits(c.mean) / rows.length >= 0.6);
    if (kept.length < 2) return null;
    const columns = kept.map((c) => c.mean).sort((a, b) => a - b);
    const support = kept.reduce((sum, c) => sum + hits(c.mean) / rows.length, 0) / kept.length;
    return { columns, support };
}

/**
 * A grid from token geometry alone, inside the selection.
 *
 * Bounded and interruptible. The whole search is over one selection rather than
 * a whole sheet, and the loop hands control back at each batch so a dense
 * selection cannot freeze the tab while it is being refused.
 */
export async function findGeometryGrid(
    tokens: TableToken[], rect: SelectionRect,
    options: { shouldCancel?: () => boolean } = {},
): Promise<{ grid: RawGrid | null; yields: number }> {
    const shouldCancel = options.shouldCancel ?? (() => false);
    let yields = 0;

    const rows: TokenRow[] = [];
    for (let i = 0; i < tokens.length; i += YIELD_EVERY) {
        rows.push(...groupRows(tokens.slice(i, i + YIELD_EVERY)));
        if (i + YIELD_EVERY < tokens.length) {
            await yieldToEventLoop();
            yields++;
            if (shouldCancel()) return { grid: null, yields };
        }
    }
    // Batching splits rows that straddle a batch boundary, so they are merged
    // once more over the whole set. Grouping is idempotent on already-grouped
    // rows, which is what makes the batching safe rather than approximate.
    const merged = groupRows(rows.flatMap((r) => r.tokens));
    if (merged.length < 3) return { grid: null, yields };

    if (shouldCancel()) return { grid: null, yields };
    const inferred = inferColumns(merged);
    if (!inferred) return { grid: null, yields };

    // Aligned prose is not a table. If most rows put everything in one column,
    // the "columns" are the left margin and nothing else.
    const spanning = merged.filter((r) => r.tokens.length === 1
        && (r.tokens[0].x1 - r.tokens[0].x0) > 0.6 * (inferred.columns[inferred.columns.length - 1] - inferred.columns[0])).length;
    if (spanning / merged.length > 0.5) return { grid: null, yields };

    const rowBounds = [merged[0].y0];
    for (let i = 0; i < merged.length - 1; i++) rowBounds.push((merged[i].y1 + merged[i + 1].y0) / 2);
    rowBounds.push(merged[merged.length - 1].y1);

    const colBounds = [...inferred.columns.map((c) => c - 1), rect.right];
    const bbox: SelectionRect = {
        left: colBounds[0],
        right: Math.max(...merged.flatMap((r) => r.tokens.map((t) => t.x1))),
        top: rowBounds[0],
        bottom: rowBounds[rowBounds.length - 1],
    };
    return {
        grid: {
            source: 'geometry',
            rowBounds,
            colBounds,
            tokens: merged.flatMap((r) => r.tokens),
            bbox,
            quality: inferred.support,
        },
        yields,
    };
}

// ---------------------------------------------------------------------------
// Choosing which grid the user meant
// ---------------------------------------------------------------------------

export interface SnapOutcome {
    grid: RawGrid | null;
    /** Set when the selection could not be resolved to one grid. */
    ambiguous: boolean;
    candidates: number;
}

/**
 * Pick the ruled grid a selection points at.
 *
 * The tie rule is deterministic and stated here rather than left to sort
 * order: the candidate with the highest overlap wins, and only if it leads the
 * next one by more than `AMBIGUITY_MARGIN`. Two grids a user's rectangle covers
 * about equally are not silently resolved into whichever happened to be found
 * first -- the user is asked to select more tightly.
 */
export function snapToRuledGrid(page: PageGeometry, rect: SelectionRect): SnapOutcome {
    const grids = findRuledGrids(page.tokens, page.segments)
        .map((grid) => ({ grid, overlap: rectOverlap(grid.bbox, rect) }))
        .filter((c) => c.overlap > SNAP_OVERLAP)
        .sort((a, b) => b.overlap - a.overlap);

    if (!grids.length) return { grid: null, ambiguous: false, candidates: 0 };
    if (grids.length === 1) return { grid: grids[0].grid, ambiguous: false, candidates: 1 };
    if (grids[0].overlap - grids[1].overlap <= AMBIGUITY_MARGIN) {
        return { grid: null, ambiguous: true, candidates: grids.length };
    }
    return { grid: grids[0].grid, ambiguous: false, candidates: grids.length };
}

/** Everything inside the selection, for the geometry route. */
export function selectionContents(page: PageGeometry, rect: SelectionRect) {
    return {
        tokens: tokensInRect(page.tokens, rect),
        segments: segmentsInRect(page.segments, rect),
    };
}
