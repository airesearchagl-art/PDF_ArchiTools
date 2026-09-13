/**
 * Scoring for the M2-4 detection prototypes.
 *
 * RESEARCH ONLY. The numbers this produces are the evidence behind the
 * recommendation, so the definitions are written down here rather than implied
 * by whatever the code happened to compute.
 *
 *   region precision / recall  a detected table matches a real one when their
 *                              boxes overlap by IoU >= 0.5. Anything else is a
 *                              false positive, which on an adversarial page is
 *                              the number that matters most.
 *   cells                      correct / missed / wrong-cell / fabricated,
 *                              compared by text after whitespace is removed.
 *   text retention             how much of the table's text survived, and how
 *                              much of it was emitted twice.
 *   exact grid                 rows, columns and every non-empty cell right.
 */

const norm = (s) => String(s ?? '').replace(/\s+/gu, '');

export function iou(a, b) {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return 0;
    const inter = (right - left) * (bottom - top);
    const areaA = (a.right - a.left) * (a.bottom - a.top);
    const areaB = (b.right - b.left) * (b.bottom - b.top);
    return inter / (areaA + areaB - inter);
}

/** Pair detections to ground truth, best overlap first, one to one. */
export function matchTables(detected, truth, { threshold = 0.5 } = {}) {
    const pairs = [];
    for (let d = 0; d < detected.length; d++) {
        for (let t = 0; t < truth.length; t++) {
            const score = iou(detected[d].bbox, truth[t].bbox);
            if (score >= threshold) pairs.push({ d, t, score });
        }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedD = new Set();
    const usedT = new Set();
    const matched = [];
    for (const p of pairs) {
        if (usedD.has(p.d) || usedT.has(p.t)) continue;
        usedD.add(p.d); usedT.add(p.t);
        matched.push(p);
    }
    return {
        matched,
        falsePositives: detected.map((_, i) => i).filter((i) => !usedD.has(i)),
        falseNegatives: truth.map((_, i) => i).filter((i) => !usedT.has(i)),
    };
}

/**
 * Compare one reconstructed grid with the cells that were drawn.
 *
 * A ground-truth cell is looked for at its own row and column first; when the
 * detected grid is a different shape, the comparison falls back to position, so
 * a table read with one column too many is scored as wrong rather than as
 * incomparable.
 */
export function scoreCells(table, truthTable) {
    const expected = truthTable.cells.filter((c) => norm(c.text) !== '');
    const blanks = truthTable.cells.filter((c) => norm(c.text) === '');
    const grid = table.grid;
    const flat = [];
    for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
            if (norm(grid[r][c]) !== '') flat.push({ r, c, text: grid[r][c] });
        }
    }

    let correct = 0;
    let wrongCell = 0;
    let missed = 0;
    const consumed = new Set();

    for (const cell of expected) {
        const want = norm(cell.text);
        const atPlace = flat.find((f) => !consumed.has(f) && f.r === cell.row && f.c === cell.col && norm(f.text) === want);
        if (atPlace) { consumed.add(atPlace); correct++; continue; }
        const elsewhere = flat.find((f) => !consumed.has(f) && norm(f.text) === want);
        if (elsewhere) { consumed.add(elsewhere); wrongCell++; continue; }
        missed++;
    }
    const fabricated = flat.filter((f) => !consumed.has(f)).length;
    // A blank the reconstruction filled in is a fabricated value in the worst
    // possible place: it looks like data somebody entered.
    const blanksFilled = blanks.filter((c) => {
        const got = grid[c.row]?.[c.col];
        return got !== undefined && norm(got) !== '';
    }).length;

    return {
        expected: expected.length,
        correct, wrongCell, missed, fabricated,
        blanks: blanks.length,
        blanksFilled,
        exactGrid: table.rows === truthTable.rows && table.cols === truthTable.cols
            && correct === expected.length && fabricated === 0,
        rowsMatch: table.rows === truthTable.rows,
        colsMatch: table.cols === truthTable.cols,
    };
}

/** How much of the table's text came through, and how often twice. */
export function scoreText(table, truthTable) {
    const wanted = truthTable.cells.map((c) => norm(c.text)).filter(Boolean);
    const got = table.grid.flat().map(norm).filter(Boolean);
    const pool = [...got];
    let retained = 0;
    for (const w of wanted) {
        const i = pool.indexOf(w);
        if (i >= 0) { pool.splice(i, 1); retained++; }
    }
    const counts = new Map();
    for (const g of got) counts.set(g, (counts.get(g) ?? 0) + 1);
    const duplicated = [...counts.values()].filter((n) => n > 1).length;
    return {
        wanted: wanted.length,
        retained,
        retention: wanted.length ? retained / wanted.length : 1,
        duplicated,
    };
}

/** Roll one page's detections up against that page's answer key. */
export function scorePage({ detected, truthTables }) {
    const { matched, falsePositives, falseNegatives } = matchTables(detected, truthTables);
    const cells = [];
    for (const m of matched) cells.push({
        ...scoreCells(detected[m.d], truthTables[m.t]),
        ...{ text: scoreText(detected[m.d], truthTables[m.t]) },
        iou: +m.score.toFixed(3),
    });
    return {
        detected: detected.length,
        truth: truthTables.length,
        matched: matched.length,
        falsePositives: falsePositives.length,
        falseNegatives: falseNegatives.length,
        falsePositiveBoxes: falsePositives.map((i) => ({
            rows: detected[i].rows, cols: detected[i].cols,
            confidence: detected[i].confidence,
            bbox: detected[i].bbox,
        })),
        cells,
    };
}

export function totals(pages) {
    const t = {
        detected: 0, truth: 0, matched: 0, falsePositives: 0, falseNegatives: 0,
        expected: 0, correct: 0, wrongCell: 0, missed: 0, fabricated: 0,
        blanks: 0, blanksFilled: 0, exactGrid: 0, rowsMatch: 0, colsMatch: 0,
        textWanted: 0, textRetained: 0, duplicated: 0,
    };
    for (const p of pages) {
        t.detected += p.detected; t.truth += p.truth; t.matched += p.matched;
        t.falsePositives += p.falsePositives; t.falseNegatives += p.falseNegatives;
        for (const c of p.cells) {
            t.expected += c.expected; t.correct += c.correct; t.wrongCell += c.wrongCell;
            t.missed += c.missed; t.fabricated += c.fabricated;
            t.blanks += c.blanks; t.blanksFilled += c.blanksFilled;
            t.exactGrid += c.exactGrid ? 1 : 0;
            t.rowsMatch += c.rowsMatch ? 1 : 0;
            t.colsMatch += c.colsMatch ? 1 : 0;
            t.textWanted += c.text.wanted; t.textRetained += c.text.retained;
            t.duplicated += c.text.duplicated;
        }
    }
    t.precision = t.detected ? t.matched / t.detected : 1;
    t.recall = t.truth ? t.matched / t.truth : 1;
    t.cellAccuracy = t.expected ? t.correct / t.expected : 1;
    t.textRetention = t.textWanted ? t.textRetained / t.textWanted : 1;
    return t;
}
