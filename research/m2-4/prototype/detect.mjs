/**
 * Research prototypes for finding and reconstructing tables from page tokens.
 *
 * RESEARCH ONLY. Nothing here is imported by the app, and none of it is written
 * to be production code: it exists so the M2-4 recommendation rests on measured
 * behaviour rather than on an argument about what would probably work.
 *
 * Everything operates on one page's tokens in display space (origin top-left,
 * y downwards, PDF points at scale 1) so native and OCR input are scored on
 * exactly the same terms.
 *
 * Three signals are implemented, because the choice between them is the
 * decision this spike exists to make:
 *
 *   geometry  -- rows from vertical overlap, columns from repeated left edges
 *   ruling    -- the grid implied by the page's own vector lines
 *   hybrid    -- ruling lines where the page has them, geometry where it does not
 */

const TOL = 3;

const centreY = (t) => (t.y0 + t.y1) / 2;
const height = (t) => Math.max(1, t.y1 - t.y0);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Group tokens into lines by vertical overlap.
 *
 * Overlap rather than a shared baseline: OCR boxes for the same line rarely
 * agree on a baseline to the pixel, and a rule that needs them to would split
 * one row of a scanned table into three.
 */
export function groupRows(tokens, { overlap = 0.5 } = {}) {
    const sorted = [...tokens].sort((a, b) => centreY(a) - centreY(b) || a.x0 - b.x0);
    const rows = [];
    for (const token of sorted) {
        const row = rows[rows.length - 1];
        if (row) {
            const shared = Math.min(row.y1, token.y1) - Math.max(row.y0, token.y0);
            const smaller = Math.min(row.y1 - row.y0, height(token));
            if (shared > 0 && shared / smaller >= overlap) {
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

// ---------------------------------------------------------------------------
// Signal A: text geometry
// ---------------------------------------------------------------------------

/** Cluster values that sit within `tol` of each other, keeping the mean. */
function cluster(values, tol) {
    const sorted = [...values].sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
        const last = out[out.length - 1];
        if (last && v - last.max <= tol) {
            last.values.push(v);
            last.max = v;
            last.mean = last.values.reduce((a, b) => a + b, 0) / last.values.length;
            continue;
        }
        out.push({ values: [v], max: v, mean: v });
    }
    return out;
}

/**
 * Find tables from token geometry alone.
 *
 * A candidate is a run of consecutive rows that share the same column starts.
 * "Share" is the whole question: a column is only a column if enough of the
 * rows actually begin a token there, which is what stops three lines of prose
 * that happen to start at the same margin from being read as a one-column
 * table.
 */
export function detectByGeometry(tokens, options = {}) {
    const {
        minRows = 3, minCols = 2, support = 0.6, tol = TOL,
        maxProseRatio = 0.5, minRowFill = 0.5,
    } = options;
    const rows = groupRows(tokens);
    if (rows.length < minRows) return [];

    const tables = [];
    let start = 0;
    while (start < rows.length) {
        let best = null;
        for (let end = start + minRows; end <= rows.length; end++) {
            const slice = rows.slice(start, end);
            const cand = columnsFor(slice, { support, tol });
            if (!cand || cand.columns.length < minCols) break;
            best = { start, end, ...cand, rows: slice };
        }
        if (!best) { start++; continue; }

        // A block of prose is not a table, however neatly it is aligned: if
        // most rows put everything in the first column, the "columns" are the
        // left margin and nothing else.
        const filled = best.rows.filter((r) => assignRow(r, best.columns, tol).filter(Boolean).length > 1).length;
        const proseRows = best.rows.filter((r) => r.tokens.length === 1
            && (r.tokens[0].x1 - r.tokens[0].x0) > 0.6 * (best.columns[best.columns.length - 1] - best.columns[0])).length;

        if (filled / best.rows.length >= minRowFill && proseRows / best.rows.length <= maxProseRatio) {
            tables.push(buildTable(best.rows, best.columns, { source: 'geometry', support: best.supportScore, tol }));
            start = best.end;
        } else {
            start++;
        }
    }
    return tables;
}

/** Column starts shared by enough of a block of rows to count as columns. */
function columnsFor(rows, { support, tol }) {
    const starts = [];
    for (const row of rows) for (const t of row.tokens) starts.push(t.x0);
    const clusters = cluster(starts, tol);
    const kept = clusters.filter((c) => {
        const rowsHit = rows.filter((r) => r.tokens.some((t) => Math.abs(t.x0 - c.mean) <= tol * 2)).length;
        return rowsHit / rows.length >= support;
    });
    if (kept.length === 0) return null;
    const columns = kept.map((c) => c.mean).sort((a, b) => a - b);
    const supportScore = kept.reduce((sum, c) => {
        const rowsHit = rows.filter((r) => r.tokens.some((t) => Math.abs(t.x0 - c.mean) <= tol * 2)).length;
        return sum + rowsHit / rows.length;
    }, 0) / kept.length;
    return { columns, supportScore };
}

// ---------------------------------------------------------------------------
// Signal C: ruling lines
// ---------------------------------------------------------------------------

/**
 * Build grids from the page's own vector lines.
 *
 * Lines are snapped into shared positions, then a grid is accepted only where
 * the horizontal and vertical lines actually span each other -- four lines that
 * merely exist somewhere on the page are not a table.
 */
export function detectByRuling(tokens, segments, options = {}) {
    const { tol = 2, minRows = 2, minCols = 2, minCoverage = 0.7, minFilled = 2 } = options;
    if (!segments?.length) return [];

    const hs = segments.filter((s) => s.orientation === 'h');
    const vs = segments.filter((s) => s.orientation === 'v');
    if (!hs.length || !vs.length) return [];

    const rowLines = mergeLines(hs, 'y', tol).sort((a, b) => a.pos - b.pos);
    const colLines = mergeLines(vs, 'x', tol).sort((a, b) => a.pos - b.pos);
    if (rowLines.length < 2 || colLines.length < 2) return [];

    // A cell is closed when all four of its edges are really drawn there. This
    // is the whole detector: grouping lines by how near they are cannot survive
    // a drawing border, which spans the sheet and joins everything on it into
    // one meaningless block.
    const covers = (line, from, to) => line.spans.some((s) => s.from <= from + tol * 2 && s.to >= to - tol * 2);
    const R = rowLines.length - 1;
    const C = colLines.length - 1;
    const closed = Array.from({ length: R }, () => new Array(C).fill(false));
    for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
            const x0 = colLines[j].pos;
            const x1 = colLines[j + 1].pos;
            const y0 = rowLines[i].pos;
            const y1 = rowLines[i + 1].pos;
            if (x1 - x0 < 2 || y1 - y0 < 2) continue;
            closed[i][j] = covers(rowLines[i], x0, x1) && covers(rowLines[i + 1], x0, x1)
                && covers(colLines[j], y0, y1) && covers(colLines[j + 1], y0, y1);
        }
    }

    // Connected runs of closed cells are the grids. Two schedules on one sheet
    // are two components; a title block beside a schedule is another.
    const seen = Array.from({ length: R }, () => new Array(C).fill(false));
    const tables = [];
    for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
            if (!closed[i][j] || seen[i][j]) continue;
            const stack = [[i, j]];
            const cellsIn = [];
            seen[i][j] = true;
            while (stack.length) {
                const [r, c] = stack.pop();
                cellsIn.push([r, c]);
                for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nr = r + dr;
                    const nc = c + dc;
                    if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
                    if (!closed[nr][nc] || seen[nr][nc]) continue;
                    seen[nr][nc] = true;
                    stack.push([nr, nc]);
                }
            }
            const r0 = Math.min(...cellsIn.map((p) => p[0]));
            const r1 = Math.max(...cellsIn.map((p) => p[0]));
            const c0 = Math.min(...cellsIn.map((p) => p[1]));
            const c1 = Math.max(...cellsIn.map((p) => p[1]));
            const rows = r1 - r0 + 1;
            const cols = c1 - c0 + 1;
            if (rows < minRows || cols < minCols) continue;
            // A ragged component is not a grid: an L of cells around a corner
            // would otherwise be squared off into a table that is mostly holes.
            const coverage = cellsIn.length / (rows * cols);
            if (coverage < minCoverage) continue;

            const boundsRows = rowLines.slice(r0, r1 + 2).map((l) => l.pos);
            const boundsCols = colLines.slice(c0, c1 + 2).map((l) => l.pos);
            const inside = tokens.filter((t) => {
                const cx = (t.x0 + t.x1) / 2;
                const cy = (t.y0 + t.y1) / 2;
                return cx >= boundsCols[0] - tol && cx <= boundsCols[boundsCols.length - 1] + tol
                    && cy >= boundsRows[0] - tol && cy <= boundsRows[boundsRows.length - 1] + tol;
            });
            // A grid with nothing written in it is not a table. Column-grid
            // bubbles and hatching produce closed rectangles by the dozen on a
            // real sheet, and every one of them would otherwise be a candidate.
            const built = buildTableFromGrid(inside, boundsRows, boundsCols, { source: 'ruling', coverage });
            const filled = built.grid.flat().filter((c) => c !== null && String(c).trim() !== '').length;
            if (filled < minFilled) continue;
            tables.push(built);
        }
    }
    return tables;
}

function mergeLines(segments, axis, tol) {
    const key = axis === 'y' ? (s) => (s.y0 + s.y1) / 2 : (s) => (s.x0 + s.x1) / 2;
    const extent = axis === 'y' ? (s) => ({ from: s.x0, to: s.x1 }) : (s) => ({ from: s.y0, to: s.y1 });
    const sorted = [...segments].sort((a, b) => key(a) - key(b));
    const lines = [];
    for (const s of sorted) {
        const last = lines[lines.length - 1];
        if (last && key(s) - last.pos <= tol) {
            last.spans.push(extent(s));
            last.pos = (last.pos * last.n + key(s)) / (last.n + 1);
            last.n++;
            continue;
        }
        lines.push({ pos: key(s), n: 1, spans: [extent(s)] });
    }
    // Overlapping spans on one line become one span, so "does this line reach
    // that crossing" is a single test rather than a scan.
    for (const line of lines) {
        line.spans.sort((a, b) => a.from - b.from);
        const merged = [];
        for (const span of line.spans) {
            const last = merged[merged.length - 1];
            if (last && span.from <= last.to + tol) { last.to = Math.max(last.to, span.to); continue; }
            merged.push({ ...span });
        }
        line.spans = merged;
    }
    return lines;
}

// ---------------------------------------------------------------------------
// Signal D: hybrid
// ---------------------------------------------------------------------------

export function detectHybrid(tokens, segments, options = {}) {
    const ruled = detectByRuling(tokens, segments, options);
    if (ruled.length) {
        // Ruling lines found a grid. Anything outside every grid still gets the
        // geometry treatment, so a borderless table beside a ruled one is not
        // lost because its neighbour had lines.
        const outside = tokens.filter((t) => !ruled.some((tb) => within(t, tb.bbox)));
        return [...ruled, ...detectByGeometry(outside, options)];
    }
    return detectByGeometry(tokens, options);
}

const within = (t, b) => {
    const cx = (t.x0 + t.x1) / 2;
    const cy = (t.y0 + t.y1) / 2;
    return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
};

// ---------------------------------------------------------------------------
// Cell assignment
// ---------------------------------------------------------------------------

function assignRow(row, columns, tol) {
    const cells = new Array(columns.length).fill(null);
    for (const token of row.tokens) {
        let col = 0;
        for (let i = 0; i < columns.length; i++) if (token.x0 >= columns[i] - tol * 2) col = i;
        cells[col] = cells[col] ? `${cells[col]}${token.text}` : token.text;
    }
    return cells;
}

function buildTable(rows, columns, meta) {
    const grid = rows.map((row) => assignRow(row, columns, meta.tol ?? TOL));
    const left = columns[0];
    const right = Math.max(...rows.flatMap((r) => r.tokens.map((t) => t.x1)));
    return {
        ...meta,
        rows: rows.length,
        cols: columns.length,
        bbox: { left, top: rows[0].y0, right, bottom: rows[rows.length - 1].y1 },
        grid,
        columns,
        rowBands: rows.map((r) => ({ y0: r.y0, y1: r.y1 })),
        // Merged cells are never invented from geometry alone: a wide token can
        // be a span or a long value, and this prototype refuses to guess.
        spans: [],
        confidence: confidenceOf(grid, meta),
    };
}

function buildTableFromGrid(tokens, rowBounds, colBounds, meta) {
    const rows = rowBounds.length - 1;
    const cols = colBounds.length - 1;
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
    for (const t of tokens) {
        const cx = (t.x0 + t.x1) / 2;
        const cy = (t.y0 + t.y1) / 2;
        let r = -1; let c = -1;
        for (let i = 0; i < rows; i++) if (cy >= rowBounds[i] && cy <= rowBounds[i + 1]) r = i;
        for (let j = 0; j < cols; j++) if (cx >= colBounds[j] && cx <= colBounds[j + 1]) c = j;
        if (r < 0 || c < 0) continue;
        grid[r][c] = grid[r][c] ? `${grid[r][c]}${t.text}` : t.text;
    }
    return {
        ...meta,
        rows, cols,
        bbox: { left: colBounds[0], top: rowBounds[0], right: colBounds[cols], bottom: rowBounds[rows] },
        grid,
        columns: colBounds.slice(0, cols),
        rowBands: Array.from({ length: rows }, (_, i) => ({ y0: rowBounds[i], y1: rowBounds[i + 1] })),
        spans: [],
        confidence: confidenceOf(grid, meta),
    };
}

/**
 * How much this candidate deserves to be believed.
 *
 * Deliberately crude and deliberately conservative: fill rate and column
 * consistency, nothing that could be tuned until every fixture passes. A
 * candidate below the threshold is not a failure, it is a candidate that has to
 * be shown to somebody.
 */
function confidenceOf(grid, meta) {
    const cells = grid.flat();
    const filled = cells.filter((c) => c !== null && c !== '').length;
    const fill = cells.length ? filled / cells.length : 0;
    const perRow = grid.map((r) => r.filter((c) => c !== null && c !== '').length);
    const spread = perRow.length ? Math.min(...perRow) / Math.max(1, Math.max(...perRow)) : 0;
    const base = meta.source === 'ruling' ? (meta.coverage ?? 0) : (meta.support ?? 0);
    return Math.round(100 * (0.45 * fill + 0.3 * spread + 0.25 * base));
}

/**
 * Fail-safe status. The whole point of M2-4 is that "produce a spreadsheet
 * anyway" must not be the default when the structure is not clear.
 */
export function statusFor(table, { confident = 70, confirm = 40 } = {}) {
    if (table.rows < 2 || table.cols < 2) return 'UNSUPPORTED_LAYOUT';
    if (table.confidence >= confident) return 'TABLE_CONFIDENT';
    if (table.confidence >= confirm) return 'TABLE_NEEDS_CONFIRMATION';
    return 'NO_TABLE';
}

export const STRATEGIES = {
    geometry: (tokens, segments, options) => detectByGeometry(tokens, options),
    ruling: (tokens, segments, options) => detectByRuling(tokens, segments, options),
    hybrid: (tokens, segments, options) => detectHybrid(tokens, segments, options),
};
