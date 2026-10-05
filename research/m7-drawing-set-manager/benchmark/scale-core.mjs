/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The scale measurement itself, with nothing in it that belongs to Node or to a
 * browser, so the same code produces both sets of numbers and they can be laid
 * side by side without wondering what else differed.
 *
 * What is measured is the portable state and the QA engine -- serialising,
 * parsing, validating, evaluating, sorting, propagating -- over synthetic
 * Drawing Sets from 50 sheets to well past the candidate limit. It is not a UI
 * benchmark: nothing is rendered here.
 *
 * Every timing is the median of several runs after one that is thrown away.
 * A single run of a millisecond-scale operation mostly measures the JIT.
 */

import { BINDING, findingCurrency, finalReadiness, indexModel, setCurrency } from '../prototype/currency.mjs';
import { seededUuidSource } from '../prototype/ids.mjs';
import { CANDIDATE_LIMITS, limitsWith } from '../prototype/limits.proposed.mjs';
import { effectiveDecisions, replaceSourceFingerprint } from '../prototype/model-ops.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { comparisonKey, evaluateRules, exactKey, parseSeries, runQa } from '../prototype/qa-rules.mjs';
import { scanJsonBounds } from '../prototype/bounded-json.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';
import { buildSyntheticProject } from '../prototype/synthetic-project.mjs';

/** Limits wide enough to measure sets beyond the candidate bounds. */
export const UNBOUNDED_FOR_MEASUREMENT = limitsWith({
    maxProjectBytes: 1024 * 1024 * 1024,
    maxJsonValues: 200_000_000,
    maxSources: 1_000_000, maxSheets: 1_000_000, maxAnalysisRuns: 1_000_000,
    maxFindings: 5_000_000, maxDecisions: 5_000_000, maxSubjectsPerFinding: 1_000_000,
});

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median wall time of `fn`, after one discarded warm-up. */
function time(fn, repeats) {
    fn();
    const samples = [];
    for (let i = 0; i < repeats; i += 1) {
        const started = performance.now();
        fn();
        samples.push(performance.now() - started);
    }
    return { medianMs: median(samples), minMs: Math.min(...samples), maxMs: Math.max(...samples), repeats };
}

const round = (value, digits = 2) => Number(value.toFixed(digits));
const stat = (t) => ({ medianMs: round(t.medianMs), minMs: round(t.minMs), maxMs: round(t.maxMs), repeats: t.repeats });

/**
 * The rows a Sheet List would show, built from the model.
 *
 * This is the "model operation" side of sorting and filtering: what it costs to
 * derive, order and narrow the list, before anything is drawn.
 */
function buildRows(model) {
    const index = indexModel(model);
    const coverage = setCurrency(model, index);
    const openFindings = new Map();
    const decided = effectiveDecisions(model);
    for (const finding of model.drawingSet.findings) {
        if (finding.lifecycle.state !== 'ACTIVE' || decided.has(finding.id)) continue;
        for (const sheetId of finding.sheetIds) openFindings.set(sheetId, (openFindings.get(sheetId) ?? 0) + 1);
    }
    const rows = [];
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.retiredAt !== null) continue;
        const currency = coverage.bySheet.get(sheet.id);
        const values = currency.effective?.values;
        rows.push({
            sheetId: sheet.id,
            number: values?.drawingNumber ?? '',
            title: values?.drawingTitle ?? '',
            revision: values?.revision ?? '',
            confirmed: currency.confirmation === 'CURRENT',
            open: openFindings.get(sheet.id) ?? 0,
        });
    }
    return rows;
}

/**
 * Measure one Drawing Set shape.
 *
 * `shape` is passed to the synthetic builder; `label` names the row.
 */
export function measureShape(label, shape, { repeats = 5, limits = UNBOUNDED_FOR_MEASUREMENT } = {}) {
    const buildStarted = performance.now();
    const { model, bindings, now, newId } = buildSyntheticProject(shape);
    const buildMs = performance.now() - buildStarted;
    const set = model.drawingSet;
    const ids = seededUuidSource(1);
    const fileId = ids();

    // -- save ---------------------------------------------------------------
    const exported = exportProject(model, { now, newFileId: fileId, limits });
    const exportTime = time(() => exportProject(model, { now, newFileId: fileId, limits }), repeats);
    const stringifyTime = time(() => JSON.stringify(exported.document), repeats);
    const prettyBytes = new TextEncoder().encode(JSON.stringify(exported.document, null, 2)).length;

    // -- open ---------------------------------------------------------------
    const stages = { decodeMs: [], scanMs: [], parseMs: [], schemaMs: [], relationsMs: [] };
    let verdict;
    const importTime = time(() => {
        verdict = importProject(exported.bytes, { now: now + 1000, limits });
        for (const key of Object.keys(stages)) stages[key].push(verdict.timings[key]);
    }, repeats);
    if (verdict.status !== 'ACCEPTED') throw new Error(`${label}: import refused ${verdict.stage}/${verdict.code}`);
    // Drop the warm-up sample from each stage, like the totals.
    const stageMedians = Object.fromEntries(Object.entries(stages).map(([key, samples]) => [key, round(median(samples.slice(1)))]));
    const scanStats = scanJsonBounds(exported.text, limits).stats;

    // -- QA -----------------------------------------------------------------
    const evaluateTime = time(() => evaluateRules(model, bindings), repeats);
    const reconcileTime = time(() => runQa(model, bindings, { now: now + 2000, newId }), repeats);

    // The two detections the Task Packet names, isolated from the rest of a run.
    const numbers = buildRows(model).map((row) => row.number);
    const duplicateTime = time(() => {
        const groups = new Map();
        for (const number of numbers) {
            const key = exactKey(number);
            if (key === '') continue;
            groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        let duplicated = 0;
        for (const count of groups.values()) if (count > 1) duplicated += 1;
        return duplicated;
    }, repeats);
    const gapTime = time(() => {
        const series = new Map();
        for (const number of numbers) {
            const parsed = parseSeries(number);
            if (!parsed) continue;
            const id = `${parsed.prefix}|${parsed.suffix}`;
            if (!series.has(id)) series.set(id, new Set());
            series.get(id).add(parsed.number);
        }
        let gaps = 0;
        for (const members of series.values()) {
            const sorted = [...members].sort((a, b) => a - b);
            for (let i = 1; i < sorted.length; i += 1) if (sorted[i] - sorted[i - 1] > 1) gaps += 1;
        }
        return gaps;
    }, repeats);
    const variantKeyTime = time(() => { for (const number of numbers) comparisonKey(number); }, repeats);

    // -- list model ---------------------------------------------------------
    const rowsTime = time(() => buildRows(model), repeats);
    const rows = buildRows(model);
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    // Shuffled first: the synthetic rows arrive almost in order, and an
    // adaptive sort on nearly-sorted input measures nothing.
    const shuffled = [...rows];
    let seed = 987654321;
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sortTime = time(() => [...shuffled].sort((a, b) => collator.compare(a.number, b.number)), repeats);
    const needle = '平面';
    const filterTextTime = time(() => rows.filter((row) => row.title.includes(needle) || row.number.includes(needle)), repeats);
    const filterOpenTime = time(() => rows.filter((row) => row.open > 0 || !row.confirmed), repeats);

    // -- stale propagation --------------------------------------------------
    const currencyTime = time(() => {
        const index = indexModel(model);
        const coverage = setCurrency(model, index);
        let current = 0;
        for (const finding of set.findings) if (findingCurrency(finding, index, bindings, coverage).currency === 'CURRENT') current += 1;
        return current;
    }, repeats);
    const readinessTime = time(() => finalReadiness(model, bindings, { effectiveDecisions: effectiveDecisions(model) }), repeats);

    // One source replaced: how much goes stale, and what it costs to find out.
    const clone = JSON.parse(exported.text);
    const first = clone.drawingSet.sources[0];
    replaceSourceFingerprint(clone, first.id, { sha256: sha256HexOfText('replaced'), byteLength: 1, pageCount: first.fingerprint.pageCount, now: now + 3000, newId });
    const cloneBindings = new Map(clone.drawingSet.sources.map((s) => [s.id, BINDING.MATCHED]));
    let staleSheets = 0;
    let staleFindings = 0;
    const afterReplaceTime = time(() => {
        const index = indexModel(clone);
        const coverage = setCurrency(clone, index);
        staleSheets = 0;
        staleFindings = 0;
        for (const currency of coverage.bySheet.values()) if (currency.observation === 'STALE_SOURCE') staleSheets += 1;
        for (const finding of clone.drawingSet.findings) if (findingCurrency(finding, index, cloneBindings, coverage).currency === 'STALE') staleFindings += 1;
    }, repeats);

    const active = set.findings.filter((f) => f.lifecycle.state === 'ACTIVE').length;
    return {
        label,
        shape: { sheets: set.sheets.length, sources: set.sources.length, findings: set.findings.length, activeFindings: active, decisions: set.decisions.length, runs: set.analysisRuns.length },
        size: {
            compactBytes: exported.bytes.length,
            prettyBytes,
            bytesPerSheet: Math.round(exported.bytes.length / set.sheets.length),
            jsonValues: scanStats.values, maxDepth: scanStats.maxDepth,
        },
        buildMs: round(buildMs),
        save: { exportTotal: stat(exportTime), jsonStringifyOnly: stat(stringifyTime) },
        open: { importTotal: stat(importTime), stageMedians },
        qa: {
            evaluateAllRules: stat(evaluateTime), evaluateAndReconcileNoChange: stat(reconcileTime),
            duplicateNumberDetectionOnly: stat(duplicateTime), gapDetectionOnly: stat(gapTime), comparisonKeyAll: stat(variantKeyTime),
        },
        list: { buildRows: stat(rowsTime), sortByNumber: stat(sortTime), filterByText: stat(filterTextTime), filterNeedsAttention: stat(filterOpenTime) },
        stale: {
            currencyOfEverything: stat(currencyTime), finalReadiness: stat(readinessTime),
            afterOneSourceReplaced: { ...stat(afterReplaceTime), staleSheets, staleFindings, totalSheets: set.sheets.length, totalFindings: set.findings.length },
        },
    };
}

/** The matrix: the five sizes of the Task Packet, two awkward shapes, and two beyond the limit. */
export const SCALE_MATRIX = [
    ['50 sheets', { sheets: 50 }, 9],
    ['200 sheets', { sheets: 200 }, 9],
    ['500 sheets', { sheets: 500 }, 7],
    ['1000 sheets', { sheets: 1000 }, 7],
    ['5000 sheets', { sheets: 5000 }, 5],
    ['5000 sheets, one PDF per sheet', { sheets: 5000, pagesPerSource: 1 }, 5],
    ['5000 sheets, nothing confirmed or decided', { sheets: 5000, confirmedShare: 0, decidedShare: 0 }, 5],
    ['10000 sheets (beyond candidate limit)', { sheets: 10000 }, 3],
    ['20000 sheets (beyond candidate limit)', { sheets: 20000 }, 3],
];

export function runScaleMatrix(onRow) {
    const rows = [];
    for (const [label, shape, repeats] of SCALE_MATRIX) {
        const row = measureShape(label, shape, { repeats });
        rows.push(row);
        onRow?.(row);
    }
    return { candidateLimits: { maxSheets: CANDIDATE_LIMITS.maxSheets, maxProjectBytes: CANDIDATE_LIMITS.maxProjectBytes }, rows };
}
