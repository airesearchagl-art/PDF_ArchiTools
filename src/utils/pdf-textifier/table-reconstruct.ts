/**
 * Turn a grid's boundaries and the tokens inside it into cells.
 *
 * Two refusals are built in, and both matter more than any accuracy number:
 *
 *   A blank cell stays blank. A cell left empty in a schedule is information,
 *   and filling it in is inventing data in the one place nobody re-checks.
 *
 *   Merged cells are never inferred. A wide token can be a span or a long
 *   value, and nothing in the geometry distinguishes them, so the reconstruction
 *   reports the rectangular grid it can actually see.
 */
import type {
    PageGeometry, SelectionRect, TableCandidate, TableReconstructOptions, TableStatus, TableToken,
} from './table-types';
import {
    MAX_GEOMETRY_TOKENS, findGeometryGrid, selectionContents, snapToRuledGrid,
} from './table-detect';
import type { RawGrid } from './table-detect';

/** Above this a grid is structurally sound; below it, it wants a closer look. */
const CONFIDENT_SCORE = 70;

/**
 * Place every token in the cell its centre falls into.
 *
 * How the tokens inside one cell are joined is the part worth being careful
 * about. A PDF splits one written line into several runs -- kerning, a font
 * change, anything -- and those have to come back as one string with nothing
 * between them. But a cell can also hold two *lines*, and those are separated
 * by a newline the writer put there. Joining both cases the same way silently
 * runs a two-line note together into one, which reads as a single sentence that
 * was never written.
 *
 * So tokens are grouped by line inside the cell first: runs that overlap
 * vertically are one line and are concatenated; separate lines are joined with
 * a newline.
 */
function fillGrid(grid: RawGrid): string[][] {
    const rows = grid.rowBounds.length - 1;
    const cols = grid.colBounds.length - 1;
    const buckets: TableToken[][][] = Array.from({ length: rows },
        () => Array.from({ length: cols }, () => [] as TableToken[]));

    for (const token of grid.tokens) {
        if (token.text.trim() === '') continue;
        const cx = (token.x0 + token.x1) / 2;
        const cy = (token.y0 + token.y1) / 2;
        let r = -1;
        let c = -1;
        for (let i = 0; i < rows; i++) if (cy >= grid.rowBounds[i] && cy <= grid.rowBounds[i + 1]) r = i;
        for (let j = 0; j < cols; j++) if (cx >= grid.colBounds[j] && cx <= grid.colBounds[j + 1]) c = j;
        if (r < 0 || c < 0) continue;
        buckets[r][c].push(token);
    }

    return buckets.map((row) => row.map((tokens) => {
        if (!tokens.length) return '';
        const ordered = [...tokens].sort((a, b) => {
            const ay = (a.y0 + a.y1) / 2;
            const by = (b.y0 + b.y1) / 2;
            return Math.abs(ay - by) > 1 ? ay - by : a.x0 - b.x0;
        });
        const lines: TableToken[][] = [];
        for (const token of ordered) {
            const line = lines[lines.length - 1];
            const last = line?.[line.length - 1];
            const shared = last ? Math.min(last.y1, token.y1) - Math.max(last.y0, token.y0) : 0;
            const smaller = last ? Math.min(last.y1 - last.y0, token.y1 - token.y0) : 0;
            if (line && smaller > 0 && shared / smaller >= 0.5) line.push(token);
            else lines.push([token]);
        }
        return lines.map((line) => line.map((t) => t.text).join('')).join('\n');
    }));
}

/**
 * How well the grid holds together. Structure only.
 *
 * Deliberately crude: fill rate, how evenly the rows are filled, and the
 * signal's own quality. It says nothing about whether the contents are a
 * schedule, and it is never a reason to skip confirmation -- a title block and
 * two columns of notes both score well, because structurally they are grids.
 */
function structureScore(cells: string[][], quality: number): number {
    const flat = cells.flat();
    if (!flat.length) return 0;
    const filled = flat.filter((c) => c.trim() !== '').length;
    const fill = filled / flat.length;
    const perRow = cells.map((r) => r.filter((c) => c.trim() !== '').length);
    const spread = perRow.length ? Math.min(...perRow) / Math.max(1, Math.max(...perRow)) : 0;
    return Math.round(100 * (0.45 * fill + 0.3 * spread + 0.25 * quality));
}

const empty = (status: TableStatus, message: string, stats: TableCandidate['stats']): TableCandidate => ({
    status,
    source: null,
    rows: 0,
    cols: 0,
    grid: [],
    bbox: { left: 0, top: 0, right: 0, bottom: 0 },
    structureScore: 0,
    message,
    stats,
});

/**
 * Reconstruct whatever the user's rectangle points at.
 *
 * Ruled grids first: the rectangle picks one, and the grid's own edges are
 * used, so a drag that misses by a few points still reads the whole table.
 * Only when no ruled grid is there does the token geometry run, restricted to
 * the selection and bounded.
 */
export async function reconstructSelection(
    page: PageGeometry,
    selection: SelectionRect,
    options: TableReconstructOptions = {},
): Promise<TableCandidate> {
    const startedAt = performance.now();
    const maxTokens = options.maxGeometryTokens ?? MAX_GEOMETRY_TOKENS;
    const shouldCancel = options.shouldCancel ?? (() => false);

    const { tokens, segments } = selectionContents(page, selection);
    const baseStats = {
        tokensInSelection: tokens.length,
        segmentsConsidered: segments.length,
        yields: 0,
        ms: 0,
    };
    const finish = (stats: TableCandidate['stats']) => ({ ...stats, ms: Math.round(performance.now() - startedAt) });

    if (page.scanned) {
        return empty('UNSUPPORTED_LAYOUT',
            'このページは画像PDFのため、現在のExcel表抽出には対応していません。',
            finish(baseStats));
    }

    const snapped = snapToRuledGrid(page, selection);
    if (snapped.ambiguous) {
        return empty('AMBIGUOUS_SELECTION',
            '複数の表構造候補が含まれています。範囲を狭めて選択してください。',
            finish(baseStats));
    }

    let grid: RawGrid | null = snapped.grid;
    let yields = 0;

    if (!grid) {
        // No ruled grid to snap to, so the selection itself is the boundary.
        if (tokens.length === 0) {
            return empty('NO_GRID',
                '選択範囲から表構造を取得できませんでした。範囲を選び直してください。',
                finish(baseStats));
        }
        if (tokens.length > maxTokens) {
            // Refused, not truncated: a partial grid would look like a whole one.
            return empty('TOO_DENSE',
                `選択範囲の文字数が多すぎます（${tokens.length} 件）。範囲を狭めて選択してください。`,
                finish(baseStats));
        }
        const found = await findGeometryGrid(tokens, selection, { shouldCancel });
        grid = found.grid;
        yields = found.yields;
        if (shouldCancel()) {
            return empty('NO_GRID', '処理を中止しました。', finish({ ...baseStats, yields }));
        }
    }

    if (!grid) {
        return empty('NO_GRID',
            '選択範囲から表構造を取得できませんでした。範囲を選び直してください。',
            finish({ ...baseStats, yields }));
    }

    const cells = fillGrid(grid);
    const rows = cells.length;
    const cols = cells[0]?.length ?? 0;
    if (rows < 2 || cols < 2) {
        return empty('UNSUPPORTED_LAYOUT',
            '行または列が足りないため、表として扱えません。',
            finish({ ...baseStats, yields }));
    }

    const score = structureScore(cells, grid.quality);
    return {
        status: score >= CONFIDENT_SCORE ? 'GRID_CONFIDENT' : 'GRID_NEEDS_REVIEW',
        source: grid.source,
        rows,
        cols,
        grid: cells,
        bbox: grid.bbox,
        structureScore: score,
        stats: finish({ ...baseStats, yields }),
    };
}

/**
 * Worksheet names Excel will accept, and that stay the same on every run.
 *
 * Excel refuses an empty name, anything past 31 characters and the characters
 * below, and it refuses two sheets with the same name. Derived from the page
 * and the table's position in the list rather than from anything the user
 * types, so a workbook cannot fail to open because of a name.
 */
export function sheetNameFor(pageNumber: number, index: number, taken: string[] = []): string {
    const base = `Page_${pageNumber}_Table_${index + 1}`.replace(/[[\]:*?/\\]/g, '_').slice(0, 31);
    if (!taken.includes(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const suffix = `_${n}`;
        const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
        if (!taken.includes(candidate)) return candidate;
    }
    return base.slice(0, 31);
}

/** What the user is told about a status, in one place so the UI and the gates agree. */
export const STATUS_LABEL: Record<TableStatus, string> = {
    GRID_CONFIDENT: '構造の整合性: 高',
    GRID_NEEDS_REVIEW: '構造の整合性: 要確認',
    NO_GRID: '表構造なし',
    UNSUPPORTED_LAYOUT: '未対応のレイアウト',
    AMBIGUOUS_SELECTION: '候補が複数',
    TOO_DENSE: '選択範囲が過密',
};
