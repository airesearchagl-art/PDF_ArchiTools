/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The Drawing Set QA rules as pure functions over metadata, and the
 * reconciliation that lets a Human decision survive a re-run.
 *
 * Two things here are architecture rather than detail.
 *
 * **The rules never touch a PDF.** Everything they read is already in the
 * model: confirmed or observed field values, page facts, the manifest. That
 * makes a QA run cheap enough (benchmark/results/scale-*.json) to repeat after
 * every change instead of tracking which findings a change might have touched,
 * and it means the expensive, source-bound work -- extraction, OCR -- is the
 * only place staleness has to be *waited out*.
 *
 * **A finding is identified by what it is about, and versioned by its
 * evidence.** `findingKey` is the question ("is A-101 duplicated?");
 * `evidenceDigest` is the answer's grounds (which sheets, read from which
 * bytes, with which values). A re-run that gets the same key and the same
 * evidence has found the same finding, and its decision stands. The same key
 * with different evidence is a new statement that supersedes the old one, and
 * the old decision becomes history -- a person decided about something that is
 * no longer what is there.
 *
 * No rule says a drawing is wrong. DETERMINISTIC rules state a fact that
 * follows mechanically from the recorded values. CANDIDATE rules state that a
 * pattern holds and ask. Neither closes itself; only a person's decision does.
 */

import { sha256HexOfText } from './sha256-stream.mjs';
import { toTimestamp } from './ids.mjs';
import { BINDING, DATA_CURRENCY, REGISTER_STATUS, indexModel, setCurrency } from './currency.mjs';
import { draftQaRun } from './model-ops.mjs';

export const QA_ENGINE_VERSION = '0.1.0-research';

/**
 * How long a run of missing numbers may be and still be reported as a gap.
 *
 * A candidate parameter, and a product decision rather than a measurement:
 * drawing numbers are routinely grouped by leaving ranges empty (A-101..A-112,
 * then A-201..), and without a bound every such jump is a "gap".
 */
export const MAX_REPORTED_GAP_RUN = 5;

export const RULES = Object.freeze({
    QA01_DUPLICATE_NUMBER: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET_GROUP', input: 'metadata' },
    QA01B_DUPLICATE_NUMBER_VARIANT: { version: 1, determinism: 'CANDIDATE', scope: 'SHEET_GROUP', input: 'metadata' },
    QA02_METADATA_UNCONFIRMED: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET', input: 'sheet' },
    QA03_NUMBER_GAP: { version: 1, determinism: 'CANDIDATE', scope: 'SET', input: 'metadata' },
    QA04_SAME_NUMBER_DIFFERENT_TITLE: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET_GROUP', input: 'metadata' },
    QA05_REVISION_MISMATCH: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET_GROUP', input: 'metadata' },
    QA06_ISSUE_DATE_MISMATCH: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET_GROUP', input: 'metadata' },
    QA07_SHEET_SIZE_OUTLIER: { version: 1, determinism: 'CANDIDATE', scope: 'SHEET_GROUP', input: 'facts' },
    QA08_ORIENTATION_OUTLIER: { version: 1, determinism: 'CANDIDATE', scope: 'SHEET_GROUP', input: 'facts' },
    QA09_REGISTER_SHEET_MISMATCH: { version: 1, determinism: 'DETERMINISTIC', scope: 'SHEET', input: 'register' },
    QA10_INTEGRITY: { version: 1, determinism: 'DETERMINISTIC', scope: 'SOURCE', input: 'binding' },
});

// -- normalisation ----------------------------------------------------------

/**
 * The key two drawing numbers are *certainly* the same under.
 *
 * Trimmed, and nothing else -- exactly the existing register's `findDuplicates`
 * (src/utils/pdf-textifier/drawing-register.ts), which declines to merge
 * `A-101` and `A101` because a tool that quietly merges them has made a
 * decision the user never saw.
 */
export const exactKey = (value) => value.trim();

const DASHES = /[\u2010-\u2015\u2212\u30FC\uFF70]/gu;

/**
 * The key two drawing numbers are *possibly* the same under.
 *
 * Width (full-width / half-width), case, dash variant, spacing and invisible
 * format characters are folded. This never replaces a stored value and never
 * feeds a DETERMINISTIC rule: it only decides what QA01B asks about.
 */
export function comparisonKey(value) {
    return value
        .normalize('NFKC')
        .replace(/\p{Cf}/gu, '')
        .replace(DASHES, '-')
        .replace(/\s+/gu, '')
        .toUpperCase();
}

/** `A-101a` -> prefix `A-`, number 101, suffix `A` (on the comparison key). */
export function parseSeries(value) {
    const key = comparisonKey(value);
    const match = /^(.*?)(\d{1,9})(\D*)$/u.exec(key);
    if (!match) return null;
    return { prefix: match[1], digits: match[2], number: Number(match[2]), suffix: match[3] };
}

/**
 * A date as written on a sheet, as an ISO date when it is unambiguous.
 *
 * Only all-numeric year-month-day forms are read. An era date (`R8.10.5`) or
 * anything else is left alone and compared as text: guessing at a date is the
 * kind of quiet decision this tool does not make.
 */
export function normaliseDate(value) {
    const text = value.normalize('NFKC').trim();
    const match = /^(\d{4})\s*[./\-年]\s*(\d{1,2})\s*[./\-月]\s*(\d{1,2})\s*日?$/u.exec(text);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString().slice(0, 10);
}

// -- page geometry ------------------------------------------------------------

/** Millimetres to points, written exactly as the normaliser writes it. */
const mmToPt = (mm) => (mm * 72) / 25.4;
const A_SERIES_PT = [['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297]]
    .map(([name, short, long]) => [name, mmToPt(short), mmToPt(long)]);
const DETECT_TOLERANCE_PT = mmToPt(5);

/**
 * The A-series class of a page, or OTHER.
 *
 * A mirror of `detectPaperSize` in src/utils/page-size-normalizer.ts: same
 * table, same 5 mm tolerance, short and long edge compared so orientation does
 * not matter -- and the same arithmetic, in points. That last part is not
 * pedantry. The first version of this mirror compared in millimetres, and
 * tests/reuse-parity.test.mjs caught it disagreeing with the normaliser for a
 * page exactly 5 mm off A0. A re-implementation drifts at the boundary; the
 * recommendation is that Production M7 imports `detectPaperSize` and has no
 * mirror at all. This one exists only so the module loads in a browser
 * benchmark without a TypeScript step.
 */
export function sizeClass(widthPt, heightPt) {
    const short = Math.min(widthPt, heightPt);
    const long = Math.max(widthPt, heightPt);
    for (const [name, s, l] of A_SERIES_PT) {
        if (Math.abs(short - s) <= DETECT_TOLERANCE_PT && Math.abs(long - l) <= DETECT_TOLERANCE_PT) return name;
    }
    return 'OTHER';
}

/** Orientation as displayed, i.e. after /Rotate. A square page is landscape, as in the normaliser. */
export function displayedOrientation(facts) {
    const quarter = facts.rotate % 180 === 90;
    const width = quarter ? facts.uprightHeightPt : facts.uprightWidthPt;
    const height = quarter ? facts.uprightWidthPt : facts.uprightHeightPt;
    return width >= height ? 'landscape' : 'portrait';
}

// -- drafts -----------------------------------------------------------------

const digest = (parts) => sha256HexOfText(JSON.stringify(parts));

/**
 * Evaluate every rule over the model as it stands.
 *
 * Returns drafts -- findings without identity or lifecycle -- plus which sheets
 * each kind of rule could see. Nothing is written; `reconcile` does that.
 */
/*
 * `importWarnings` are the warnings the importer returned for this Project.
 * They are known only at open, so a session keeps them and passes them to
 * every run. A run that is not given them (`undefined`) has not looked at
 * the project file and must not close a finding about it; a run given an
 * empty list has looked and found nothing.
 */
export function evaluateRules(model, bindings, { importWarnings, maxGapRun = MAX_REPORTED_GAP_RUN } = {}) {
    const index = indexModel(model);
    const coverage = setCurrency(model, index);
    const drafts = [];

    const shaOf = (sheet) => index.sources.get(sheet.sourceId).fingerprint.sha256;
    const draft = (ruleId, { sheets = [], sources = [], registerEntries = [], scope, key, evidence, params }) => {
        const rule = RULES[ruleId];
        const orderedSheets = [...sheets].sort((a, b) => (a.id < b.id ? -1 : 1));
        const basisSources = new Map();
        for (const sheet of orderedSheets) basisSources.set(sheet.sourceId, shaOf(sheet));
        for (const source of sources) basisSources.set(source.id, source.fingerprint.sha256);
        // A register entry is cited through the Source its register was declared from.
        const orderedEntries = [...registerEntries].sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
        for (const { reference } of orderedEntries) basisSources.set(reference.sourceId, index.sources.get(reference.sourceId).fingerprint.sha256);
        const basis = [...basisSources].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([sourceId, sha256]) => ({ sourceId, sha256 }));
        drafts.push({
            ruleId, ruleVersion: rule.version, determinism: rule.determinism, scope: scope ?? rule.scope,
            sheetIds: orderedSheets.map((s) => s.id),
            sourceIds: [...sources].map((s) => s.id).sort(),
            registerEntryIds: orderedEntries.map((item) => item.entry.id),
            findingKey: digest([ruleId, ...key]),
            // The grounds: the rule's version, what it cites, the bytes each cited
            // sheet was read from, and the values that make the statement true.
            evidenceDigest: digest([ruleId, rule.version, orderedSheets.map((s) => [s.id, shaOf(s)]), orderedEntries.map((item) => item.entry.id), basis, evidence]),
            basis, params,
        });
    };

    // Rows the metadata rules may read: live sheets whose values still stand.
    const rows = [];
    const factRows = [];
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.retiredAt !== null) continue;
        const currency = coverage.bySheet.get(sheet.id);
        if (currency.effective) rows.push({ sheet, values: currency.effective.values });
        if (currency.pageFacts === DATA_CURRENCY.CURRENT) factRows.push({ sheet, facts: sheet.pageFacts });

        // QA02: one finding per sheet whose metadata no person currently stands behind.
        if (currency.confirmation !== DATA_CURRENCY.CURRENT) {
            let reason = 'NOT_READ';
            if (currency.confirmation !== DATA_CURRENCY.NONE) reason = 'RECONFIRM_REQUIRED';
            else if (currency.observation === DATA_CURRENCY.CURRENT) reason = sheet.observation.status === 'OCR_FAILED' ? 'OCR_FAILED' : 'UNCONFIRMED';
            else if (currency.observation !== DATA_CURRENCY.NONE) reason = 'READ_IS_STALE';
            draft('QA02_METADATA_UNCONFIRMED', { sheets: [sheet], key: [sheet.id], evidence: [reason], params: { reason } });
        }
    }

    // QA01 / QA04 / QA05 / QA06: groups sharing an exact drawing number.
    const byExact = new Map();
    const byComparison = new Map();
    for (const row of rows) {
        const exact = exactKey(row.values.drawingNumber);
        if (exact === '') continue;
        if (!byExact.has(exact)) byExact.set(exact, []);
        byExact.get(exact).push(row);
        const folded = comparisonKey(exact);
        if (!byComparison.has(folded)) byComparison.set(folded, new Map());
        const variants = byComparison.get(folded);
        if (!variants.has(exact)) variants.set(exact, []);
        variants.get(exact).push(row);
    }

    const distinct = (group, read) => [...new Set(group.map(read).filter((v) => v !== ''))].sort();
    for (const [number, group] of byExact) {
        if (group.length < 2) continue;
        const sheets = group.map((r) => r.sheet);
        draft('QA01_DUPLICATE_NUMBER', { sheets, key: [number], evidence: [number], params: { number, count: group.length } });

        const titles = distinct(group, (r) => r.values.drawingTitle.trim());
        if (titles.length > 1) {
            draft('QA04_SAME_NUMBER_DIFFERENT_TITLE', { sheets, key: [number], evidence: [number, titles], params: { number, values: titles.slice(0, 64) } });
        }
        const revisions = distinct(group, (r) => r.values.revision.trim());
        if (revisions.length > 1) {
            draft('QA05_REVISION_MISMATCH', { sheets, key: [number], evidence: [number, revisions], params: { number, values: revisions.slice(0, 64) } });
        }
        // Two spellings of one unambiguous date are one date.
        const dates = distinct(group, (r) => normaliseDate(r.values.issueDate) ?? r.values.issueDate.trim());
        if (dates.length > 1) {
            draft('QA06_ISSUE_DATE_MISMATCH', { sheets, key: [number], evidence: [number, dates], params: { number, values: dates.slice(0, 64) } });
        }
    }

    // QA01B: the same number once width, case, dashes and spacing are folded --
    // but written differently, so QA01 cannot have reported the whole group.
    for (const [folded, variants] of byComparison) {
        if (variants.size < 2) continue;
        const sheets = [...variants.values()].flat().map((r) => r.sheet);
        const spellings = [...variants.keys()].sort();
        draft('QA01B_DUPLICATE_NUMBER_VARIANT', {
            sheets, key: [folded], evidence: [folded, spellings],
            params: { comparisonKey: folded.slice(0, 300), values: spellings.slice(0, 64), count: sheets.length },
        });
    }

    // QA03: within one series (same text before and after the number), short runs
    // of missing integers between two numbers that are present.
    const series = new Map();
    for (const row of rows) {
        const parsed = parseSeries(row.values.drawingNumber);
        if (!parsed) continue;
        const id = `${parsed.prefix}\u0000${parsed.suffix}`;
        if (!series.has(id)) series.set(id, { prefix: parsed.prefix, suffix: parsed.suffix, members: new Map() });
        const members = series.get(id).members;
        if (!members.has(parsed.number)) members.set(parsed.number, { digits: parsed.digits, rows: [] });
        members.get(parsed.number).rows.push(row);
    }
    for (const { prefix, suffix, members } of series.values()) {
        if (members.size < 2) continue;
        const numbers = [...members.keys()].sort((a, b) => a - b);
        for (let i = 1; i < numbers.length; i += 1) {
            const below = numbers[i - 1];
            const above = numbers[i];
            const missing = above - below - 1;
            if (missing < 1 || missing > maxGapRun) continue;
            const width = members.get(below).digits.length;
            const label = (n) => `${prefix}${String(n).padStart(width, '0')}${suffix}`;
            const neighbours = [...members.get(below).rows, ...members.get(above).rows].map((r) => r.sheet);
            draft('QA03_NUMBER_GAP', {
                sheets: neighbours,
                key: [prefix, suffix, below + 1, above - 1],
                evidence: [prefix, suffix, below, above],
                params: { seriesPrefix: prefix.slice(0, 300), rangeFrom: label(below + 1).slice(0, 300), rangeTo: label(above - 1).slice(0, 300), count: missing },
            });
        }
    }

    // QA07 / QA08: sheets outside a class that more than half the set shares.
    // With no majority there is no outlier, and nothing is reported.
    const outliers = (ruleId, classify, paramNames) => {
        const classes = new Map();
        for (const row of factRows) {
            const name = classify(row.facts);
            if (!classes.has(name)) classes.set(name, []);
            classes.get(name).push(row.sheet);
        }
        let majority = null;
        for (const [name, sheets] of classes) if (sheets.length * 2 > factRows.length) majority = name;
        if (majority === null) return;
        for (const [name, sheets] of classes) {
            if (name === majority) continue;
            draft(ruleId, {
                sheets, key: [name], evidence: [name, majority],
                params: { [paramNames[0]]: name, [paramNames[1]]: majority, count: sheets.length, majorityCount: classes.get(majority).length },
            });
        }
    };
    outliers('QA07_SHEET_SIZE_OUTLIER', (f) => sizeClass(f.uprightWidthPt, f.uprightHeightPt), ['sizeClass', 'majoritySizeClass']);
    outliers('QA08_ORIENTATION_OUTLIER', displayedOrientation, ['orientation', 'majorityOrientation']);

    // QA09: a Drawing Register a person DECLARED, against the sheets that are
    // actually here. Nothing is inferred. With no declared register there is
    // nothing to compare with and the rule states nothing -- which is "not
    // evaluable", not "no mismatch". Correspondence is the exact drawing number,
    // the same key QA01 uses; a spelling that would match once folded is offered
    // as a hint and never counted as a match.
    const register = coverage.register;
    if (register.status === REGISTER_STATUS.CURRENT) {
        const listed = new Map();
        const listedSpellings = new Map();
        for (const item of register.liveEntries) {
            const exact = exactKey(item.entry.drawingNumber);
            if (!listed.has(exact)) listed.set(exact, []);
            listed.get(exact).push(item);
            const folded = comparisonKey(exact);
            if (!listedSpellings.has(folded)) listedSpellings.set(folded, new Set());
            listedSpellings.get(folded).add(exact);
        }
        const registerBasis = register.references.map((r) => [r.id, r.sourceSha256]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        const hint = (spellings) => (spellings.length > 0 ? { values: spellings.slice(0, 64) } : {});

        for (const [exact, items] of listed) {
            if (byExact.has(exact)) continue;
            const near = [...(byComparison.get(comparisonKey(exact))?.keys() ?? [])].sort();
            for (const item of items) {
                draft('QA09_REGISTER_SHEET_MISMATCH', {
                    registerEntries: [item], scope: 'REGISTER_ENTRY',
                    key: ['LISTED_BUT_MISSING', item.entry.id], evidence: ['LISTED_BUT_MISSING', exact],
                    params: { reason: 'LISTED_BUT_MISSING', number: exact, ...hint(near) },
                });
            }
        }
        for (const [exact, group] of byExact) {
            if (listed.has(exact)) continue;
            const near = [...(listedSpellings.get(comparisonKey(exact)) ?? [])].sort();
            for (const row of group) {
                draft('QA09_REGISTER_SHEET_MISMATCH', {
                    sheets: [row.sheet], scope: 'SHEET',
                    key: ['ACTUAL_NOT_LISTED', row.sheet.id], evidence: ['ACTUAL_NOT_LISTED', exact, registerBasis],
                    params: { reason: 'ACTUAL_NOT_LISTED', number: exact, ...hint(near) },
                });
            }
        }
    }

    // QA10 (manifest): M7's own Sheet list against the pages each Source
    // actually has. An integrity fact about the Project's bookkeeping, not a
    // statement about the drawings -- which is why it is not QA09.
    const pagesBySource = new Map();
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.retiredAt !== null) continue;
        if (!pagesBySource.has(sheet.sourceId)) pagesBySource.set(sheet.sourceId, []);
        pagesBySource.get(sheet.sourceId).push(sheet);
    }
    for (const source of model.drawingSet.sources) {
        if (source.retiredAt !== null) continue;
        const sheets = pagesBySource.get(source.id) ?? [];
        const pageCount = source.fingerprint.pageCount;
        const registered = new Set(sheets.map((s) => s.pageNumber));
        const orphaned = sheets.filter((s) => s.pageNumber > pageCount);
        let unregistered = 0;
        for (let page = 1; page <= pageCount; page += 1) if (!registered.has(page)) unregistered += 1;
        if (orphaned.length > 0) {
            draft('QA10_INTEGRITY', {
                sheets: orphaned, sources: [source], key: [source.id, 'SHEET_WITHOUT_PAGE'],
                evidence: [pageCount, orphaned.map((s) => s.pageNumber).sort((a, b) => a - b)],
                params: { reason: 'SHEET_WITHOUT_PAGE', count: orphaned.length },
            });
        }
        if (unregistered > 0) {
            draft('QA10_INTEGRITY', {
                sources: [source], key: [source.id, 'PAGE_WITHOUT_SHEET'], evidence: [pageCount, unregistered],
                params: { reason: 'PAGE_WITHOUT_SHEET', count: unregistered },
            });
        }
    }

    // QA10: Source and Project integrity. A Source that has not been looked for
    // yet (UNBOUND) is not an abnormality and is not evaluated.
    const bindingEvaluated = new Set();
    for (const source of model.drawingSet.sources) {
        if (source.retiredAt !== null) continue;
        const state = bindings?.get(source.id) ?? BINDING.UNBOUND;
        if (state === BINDING.UNBOUND) continue;
        bindingEvaluated.add(source.id);
        if (state !== BINDING.MATCHED) {
            const reason = `SOURCE_${state}`;
            draft('QA10_INTEGRITY', { sources: [source], key: [source.id, reason], evidence: [reason], params: { reason } });
        }
    }
    if (importWarnings !== undefined && importWarnings.length > 0) {
        const codes = [...new Set(importWarnings.map((w) => w.code))].sort();
        drafts.push({
            ruleId: 'QA10_INTEGRITY', ruleVersion: RULES.QA10_INTEGRITY.version, determinism: 'DETERMINISTIC', scope: 'PROJECT',
            sheetIds: [], sourceIds: [], registerEntryIds: [],
            findingKey: digest(['QA10_INTEGRITY', 'PROJECT_FILE']),
            evidenceDigest: digest(['QA10_INTEGRITY', RULES.QA10_INTEGRITY.version, codes]),
            basis: [], params: { reason: 'PROJECT_FILE_ANOMALY', count: importWarnings.length },
        });
    }

    return {
        drafts,
        coverage,
        evaluated: {
            metadataSheets: new Set(rows.map((r) => r.sheet.id)),
            factSheets: new Set(factRows.map((r) => r.sheet.id)),
            bindingSources: bindingEvaluated,
            projectFile: importWarnings !== undefined,
            register: register.status,
        },
    };
}

/**
 * Could this run have re-stated this finding, had it still been true?
 *
 * A finding is closed as NOT_REPRODUCED only when the answer is yes. A run that
 * could not see a finding's subject -- its sheet is waiting to be re-read --
 * has learned nothing about it, and closing it would turn "we did not look"
 * into "it is gone".
 */
function couldEvaluate(finding, evaluation, index) {
    const { evaluated, coverage } = evaluation;
    const liveSubjects = finding.sheetIds.filter((id) => index.sheets.get(id)?.retiredAt === null);
    const input = RULES[finding.ruleId].input;
    if (input === 'register') {
        // No declared register: the rule no longer applies, and what it once said is closed --
        // with nothing declared there is no QA09 finding, which is not a pass either.
        if (evaluated.register === REGISTER_STATUS.NOT_DESIGNATED) return true;
        // A register that is not current was not compared with anything.
        if (evaluated.register !== REGISTER_STATUS.CURRENT) return false;
        return liveSubjects.every((id) => evaluated.metadataSheets.has(id));
    }
    if (input === 'metadata') {
        if (finding.ruleId === 'QA03_NUMBER_GAP' && !coverage.metadataComplete) return false;
        return liveSubjects.every((id) => evaluated.metadataSheets.has(id));
    }
    if (input === 'facts') return coverage.factsComplete;
    if (input === 'binding') {
        if (finding.scope === 'PROJECT') return evaluated.projectFile;
        // The Sheet list against the page inventory needs only the manifest.
        if (finding.params.reason === 'PAGE_WITHOUT_SHEET' || finding.params.reason === 'SHEET_WITHOUT_PAGE') return true;
        return finding.sourceIds.every((id) => evaluated.bindingSources.has(id) || index.sources.get(id)?.retiredAt !== null);
    }
    return true; // a 'sheet' rule sees every live sheet
}

/**
 * Write a QA run into the model.
 *
 *   same key, same evidence      the finding stands; nothing is written
 *   same key, different evidence a new finding; the old one is SUPERSEDED
 *   key not stated, evaluable    the old finding is NOT_REPRODUCED
 *   key not stated, not evaluable the old finding is left ACTIVE (and is STALE)
 *
 * Decisions are never touched. They belong to the finding they were made about.
 */
export function reconcile(model, evaluation, { now, newId, engineVersion = QA_ENGINE_VERSION }) {
    const index = indexModel(model);
    const liveCount = [...index.sheets.values()].filter((s) => s.retiredAt === null).length;
    const run = draftQaRun(model, {
        engineVersion, now, newId,
        coverage: { sheetsEvaluated: evaluation.evaluated.metadataSheets.size, sheetsExcluded: liveCount - evaluation.evaluated.metadataSheets.size },
    });
    const at = toTimestamp(now);
    const active = new Map();
    for (const finding of model.drawingSet.findings) if (finding.lifecycle.state === 'ACTIVE') active.set(finding.findingKey, finding);

    const summary = { kept: 0, created: 0, superseded: 0, notReproduced: 0, leftStale: 0 };
    const stated = new Set();
    for (const draft of evaluation.drafts) {
        stated.add(draft.findingKey);
        const previous = active.get(draft.findingKey);
        if (previous && previous.evidenceDigest === draft.evidenceDigest) { summary.kept += 1; continue; }
        const finding = {
            id: newId(), runId: run.id,
            ruleId: draft.ruleId, ruleVersion: draft.ruleVersion, determinism: draft.determinism, scope: draft.scope,
            sheetIds: draft.sheetIds, sourceIds: draft.sourceIds, registerEntryIds: draft.registerEntryIds,
            findingKey: draft.findingKey, evidenceDigest: draft.evidenceDigest,
            basis: draft.basis, params: draft.params, createdAt: at,
            lifecycle: { state: 'ACTIVE', supersededByFindingId: null, closedByRunId: null, closedAt: null },
        };
        model.drawingSet.findings.push(finding);
        summary.created += 1;
        if (previous) {
            previous.lifecycle = { state: 'SUPERSEDED', supersededByFindingId: finding.id, closedByRunId: run.id, closedAt: at };
            summary.superseded += 1;
        }
    }
    for (const [key, finding] of active) {
        if (stated.has(key)) continue;
        if (couldEvaluate(finding, evaluation, index)) {
            finding.lifecycle = { state: 'NOT_REPRODUCED', supersededByFindingId: null, closedByRunId: run.id, closedAt: at };
            summary.notReproduced += 1;
        } else summary.leftStale += 1;
    }
    // A run that changed nothing is referred to by nothing, so it is not kept:
    // re-evaluating after every edit must not grow the file.
    const changed = summary.created + summary.notReproduced > 0;
    if (changed) model.drawingSet.analysisRuns.push(run);
    return { run: changed ? run : null, summary };
}

/** Evaluate and reconcile in one step: what the app does after every change. */
export function runQa(model, bindings, options) {
    const evaluation = evaluateRules(model, bindings, options);
    return { ...reconcile(model, evaluation, options), evaluation };
}
