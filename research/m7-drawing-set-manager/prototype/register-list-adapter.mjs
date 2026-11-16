/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * From a table a person pointed at to the rows of a declared Drawing Register.
 *
 * The existing table engine (M2-4, `src/utils/pdf-textifier/table-*.ts`) already
 * does the hard part: given a page's geometry and a rectangle a person drew, it
 * returns a `TableCandidate` whose `grid` is the table's cells as text. What it
 * does not know -- and must not guess -- is what the columns *mean*. A drawing
 * list, a legend and a door schedule are the same thing to it: a grid.
 *
 * So this adapter adds exactly one piece of knowledge, and a person supplies it:
 * which column is the drawing number, and optionally which are the title, the
 * revision and the date, and how many rows at the top are headings. The output
 * is field-level rows and nothing else. The page's other text, the tokens the
 * engine read, the candidate's cell grid as a whole -- none of it is carried
 * past here, which is the persistence boundary of the Product Definition
 * applied at the point where table text enters the model.
 *
 * Nothing in this file imports the engine, so it loads on its own;
 * tests/declared-register.test.mjs runs the real `reconstructSelection` and
 * hands its result to this.
 */

import { sanitizeSingleLine } from './model-ops.mjs';

/** The engine's statuses under which a grid may be offered for declaration at all. */
const USABLE_STATUS = new Set(['GRID_CONFIDENT', 'GRID_NEEDS_REVIEW']);

/** A cell as one line: the engine joins a multi-line cell with line breaks. */
const cell = (grid, row, column) => {
    if (column === null || column === undefined) return null;
    const value = grid[row]?.[column];
    return sanitizeSingleLine(String(value ?? '').replace(/\s*\n\s*/g, ' '), 300);
};

/**
 * Turn a reconstructed grid into candidate register rows.
 *
 * `columns` is the person's mapping: `{ drawingNumber, drawingTitle?, revision?,
 * issueDate? }`, each a zero-based column index (or null / absent). `skipRows`
 * is how many leading rows are headings.
 *
 * A row whose drawing-number cell is empty is not turned into an entry and is
 * not dropped quietly either: it is returned in `skipped` with its grid row, so
 * the workspace can show the person exactly which rows will not be in the
 * register before they declare it.
 */
export function rowsFromTableGrid(grid, { columns, skipRows = 0 }) {
    if (!Array.isArray(grid)) throw new TypeError('rowsFromTableGrid expects the candidate grid');
    if (!Number.isInteger(columns?.drawingNumber) || columns.drawingNumber < 0) throw new RangeError('a drawing-number column must be chosen');
    const rows = [];
    const skipped = [];
    for (let r = skipRows; r < grid.length; r += 1) {
        const drawingNumber = cell(grid, r, columns.drawingNumber);
        if (drawingNumber === '') { skipped.push({ gridRow: r + 1, reason: 'EMPTY_NUMBER' }); continue; }
        const optional = (column) => { const value = cell(grid, r, column); return value === null || value === '' ? null : value; };
        rows.push({
            gridRow: r + 1,
            drawingNumber,
            drawingTitle: optional(columns.drawingTitle),
            revision: optional(columns.revision),
            issueDate: optional(columns.issueDate),
            origin: 'EXTRACTED',
        });
    }
    return { rows, skipped };
}

/**
 * The same, from the engine's `TableCandidate`.
 *
 * A candidate that is not a grid is refused with the engine's own status -- a
 * scanned page (`UNSUPPORTED_LAYOUT`: the engine reads native text only), a
 * selection with nothing table-shaped in it, one that covers two tables. In
 * those cases the person declares the register by typing it (`method: MANUAL`)
 * or selects again; nothing is inferred from a page the engine could not read.
 */
export function rowsFromTableCandidate(candidate, mapping) {
    if (!USABLE_STATUS.has(candidate.status)) return { ok: false, code: candidate.status };
    const { rows, skipped } = rowsFromTableGrid(candidate.grid, mapping);
    if (rows.length === 0) return { ok: false, code: 'NO_ROWS' };
    return { ok: true, rows, skipped, region: { ...candidate.bbox }, structureStatus: candidate.status };
}
