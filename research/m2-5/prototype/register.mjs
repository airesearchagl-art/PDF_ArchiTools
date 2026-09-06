/**
 * The register itself: one candidate row per page, and the checks over them.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * Two rules shape everything below.
 *
 * **Every page gets a row.** A page whose OCR failed, whose field was blank, or
 * whose template did not fit still produces a row -- with empty values and a
 * reason. Dropping it would silently shorten the register, and a register that
 * is quietly missing a sheet is worse than one that says it does not know.
 *
 * **A row is a candidate until a person says otherwise.** Confidence never
 * promotes a row. It only decides what a reviewer is shown first.
 */

export const FIELDS = ['drawing_number', 'drawing_title', 'revision', 'revision_date'];

/**
 * Why a row needs a human before it can be trusted.
 *
 * These are the queue's sort keys, not a verdict on correctness: a row with no
 * reasons at all is still unconfirmed.
 */
export const REVIEW_REASONS = {
    TEMPLATE_DID_NOT_FIT: 'the template does not fit this page',
    NO_TEXT_IN_FIELD: 'a field came back empty',
    LOW_CONFIDENCE: 'OCR reported low confidence',
    OCR_FAILED: 'the field could not be recognised',
    DUPLICATE_NUMBER: 'this drawing number appears on another page',
    GAP_NEIGHBOUR: 'a number appears to be missing next to this one',
    PARSE_FAILED: 'the value does not match the expected shape',
};

/** Below this, a field is queued for review. Never used to accept anything. */
export const LOW_CONFIDENCE = 70;

/**
 * The display value taken from raw extracted text.
 *
 * A title-block cell holds its label above its value, so the raw text of the
 * drawing-number cell is "figure-number-label\nA-101". Taking the last line is
 * the best simple rule measured, and it is wrong often enough that it must stay
 * a *view* of the raw text rather than a replacement for it.
 */
export function displayValue(rawText) {
    const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    return lines.length ? lines[lines.length - 1] : '';
}

function emptyField() {
    return {
        rawText: '', value: '', source: 'none', confidence: null, reviewReasons: [],
    };
}

export function emptyRow(pageNumber) {
    return {
        pageNumber,
        fields: Object.fromEntries(FIELDS.map((f) => [f, emptyField()])),
        // A convenience mirror of fields[f].value, so the register-level checks
        // can read a row without reaching through the provenance. It is derived,
        // never authoritative: fields[f] is where the truth lives.
        drawing_number: '',
        drawing_title: '',
        revision: '',
        revision_date: '',
        extractionSource: 'none',
        confidence: {},
        reviewReasons: [],
        reviewStatus: 'unconfirmed',
    };
}

/**
 * Build one row from whatever the extraction produced.
 *
 * `fields` maps a field name to `{ rawText, source, confidence }`. A field that
 * is missing entirely is not an error here; it becomes an empty value and a
 * reason, which is the whole point.
 *
 * Three things are kept per field and none of them can be reconstructed later,
 * which is why they are kept rather than summarised:
 *
 *   rawText     exactly what came out of the page. Never overwritten, never
 *               trimmed. It is what a reviewer has to be shown when the value
 *               looks wrong, because the value is a guess made from it.
 *   source      native or ocr, per field. A row-level summary cannot express a
 *               page whose drawing number is vector text over a raster sheet,
 *               and that page is exactly the one that needs saying.
 *   confidence  the reader's own score for its own output, per field. One
 *               number for four values cannot say which value to look at.
 */
export function buildRow({ pageNumber, fields = {}, templateFitted = true, deriveValue = displayValue }) {
    const row = emptyRow(pageNumber);
    const sources = new Set();

    for (const field of FIELDS) {
        const found = fields[field];
        const rawText = (found?.rawText ?? found?.text ?? '').trim();
        const value = deriveValue(rawText);
        const entry = row.fields[field];
        entry.rawText = rawText;
        entry.value = value;
        entry.source = found?.source ?? 'none';
        entry.confidence = typeof found?.confidence === 'number' ? found.confidence : null;

        row[field] = value;
        if (found?.source) sources.add(found.source);
        if (typeof found?.confidence === 'number') row.confidence[field] = found.confidence;

        if (!templateFitted) continue;
        if (rawText === '') {
            entry.reviewReasons.push(`${REVIEW_REASONS.NO_TEXT_IN_FIELD} (${field})`);
            row.reviewReasons.push(`${REVIEW_REASONS.NO_TEXT_IN_FIELD} (${field})`);
        } else if (entry.confidence !== null && entry.confidence < LOW_CONFIDENCE) {
            const reason = `${REVIEW_REASONS.LOW_CONFIDENCE} (${field}, ${Math.round(entry.confidence)})`;
            entry.reviewReasons.push(reason);
            row.reviewReasons.push(reason);
        }
    }

    if (!templateFitted) {
        row.reviewReasons.unshift(REVIEW_REASONS.TEMPLATE_DID_NOT_FIT);
        row.extractionSource = 'template-mismatch';
        return row;
    }

    row.extractionSource = sources.size === 0 ? 'none'
        : sources.size === 1 ? [...sources][0]
            : 'mixed';
    return row;
}

/**
 * Rows sharing a drawing number.
 *
 * Exact string equality after trimming, and nothing else. `A-101` and `A101`
 * are not declared the same drawing: on a real issue they may well be two
 * different sheets, and guessing costs more than asking.
 */
export function findDuplicates(rows) {
    const seen = new Map();
    for (const row of rows) {
        const key = row.drawing_number.trim();
        if (key === '') continue;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(row.pageNumber);
    }
    return [...seen.entries()]
        .filter(([, pages]) => pages.length > 1)
        .map(([number, pages]) => ({ number, pages }));
}

/**
 * Numbers of the form PREFIX + SEPARATOR + fixed-width digits.
 *
 * Strict on purpose. Anything the pattern does not match is not coerced into
 * it; it simply is not a member of a run, and its presence is what switches gap
 * inference off for that prefix.
 */
const NUMBER_PATTERN = /^([A-Za-z]{1,4})([-_ ]?)(\d{2,4})$/;

export function parseDrawingNumber(value) {
    const match = NUMBER_PATTERN.exec(value.trim());
    if (!match) return null;
    return { prefix: match[1].toUpperCase(), separator: match[2], digits: match[3], width: match[3].length, value: Number(match[3]) };
}

/**
 * Numbers that look missing from an otherwise regular run.
 *
 * The result is deliberately called a *candidate*. A drawing set is allowed to
 * skip numbers -- a sheet gets cancelled, a block is reserved -- so this can
 * only ever say "the numbering suggests something between these two", never
 * "a drawing is missing".
 *
 * Inference is switched off for a prefix as soon as that prefix carries a
 * number the strict pattern does not match, or numbers of differing width.
 * A run with `A-101`, `A-1A` and `DETAIL-A` in it is not a run.
 */
export function findGapCandidates(rows, { maxRunGap = 10 } = {}) {
    const byPrefix = new Map();
    const disabled = new Map();
    const unreadable = [];
    const otherScheme = [];

    for (const row of rows) {
        const raw = row.drawing_number.trim();
        const fromOcr = row.extractionSource === 'ocr' || row.extractionSource === 'mixed';

        if (raw === '') {
            unreadable.push({ pageNumber: row.pageNumber, value: '', why: 'empty' });
            continue;
        }
        const parsed = parseDrawingNumber(raw);
        if (!parsed) {
            // Two very different situations look the same here, and treating
            // them the same makes the check either useless or dangerous.
            //
            //   unreadable      a recognised value that does not parse is most
            //                   likely a misread, and the number it should have
            //                   been might be the one that looks missing. Gap
            //                   inference stands down entirely.
            //   another scheme  a value read straight from the page that simply
            //                   is not PREFIX-NNN -- DETAIL-A, SK-01 -- is not
            //                   a failure. It is excluded from runs, and only
            //                   its own prefix is switched off.
            if (fromOcr) {
                unreadable.push({ pageNumber: row.pageNumber, value: raw, why: 'recognised but does not parse' });
            } else {
                otherScheme.push({ pageNumber: row.pageNumber, value: raw });
                const looksPrefixed = /^([A-Za-z]{1,4})[-_ ]?/.exec(raw);
                if (looksPrefixed) disabled.set(looksPrefixed[1].toUpperCase(), raw);
            }
            continue;
        }
        if (!byPrefix.has(parsed.prefix)) byPrefix.set(parsed.prefix, []);
        byPrefix.get(parsed.prefix).push({ ...parsed, pageNumber: row.pageNumber });
    }

    // A number that could not be read might be the very number that looks
    // missing. Inferring a gap while some rows are unreadable manufactures
    // absences out of the reader's own failures, so the whole check stands
    // down until every number has been read -- which in practice means after
    // review, not before it.
    if (unreadable.length) {
        return {
            candidates: [],
            skipped: [{
                prefix: '(all)',
                reason: `${unreadable.length} row(s) have a drawing number that could not be read`
                    + ` -- gap inference is held back until they are resolved`,
                pages: unreadable.map((u) => u.pageNumber),
            }],
            unreadable,
            otherScheme,
        };
    }

    const candidates = [];
    const skipped = [];
    for (const [prefix, entries] of byPrefix) {
        if (disabled.has(prefix)) {
            skipped.push({ prefix, reason: `mixed numbering scheme (${disabled.get(prefix)})` });
            continue;
        }
        const widths = new Set(entries.map((e) => e.width));
        if (widths.size > 1) {
            skipped.push({ prefix, reason: `inconsistent digit width (${[...widths].join(', ')})` });
            continue;
        }
        if (entries.length < 3) {
            skipped.push({ prefix, reason: `too few numbers to call it a run (${entries.length})` });
            continue;
        }
        const values = [...new Set(entries.map((e) => e.value))].sort((a, b) => a - b);
        for (let i = 0; i < values.length - 1; i++) {
            const from = values[i];
            const to = values[i + 1];
            if (to - from <= 1) continue;
            if (to - from > maxRunGap) {
                skipped.push({ prefix, reason: `jump of ${to - from} is a new block, not a gap` });
                continue;
            }
            for (let missing = from + 1; missing < to; missing++) {
                const sample = entries[0];
                candidates.push({
                    prefix,
                    number: `${prefix}${sample.separator}${String(missing).padStart(sample.width, '0')}`,
                    between: [
                        `${prefix}${sample.separator}${String(from).padStart(sample.width, '0')}`,
                        `${prefix}${sample.separator}${String(to).padStart(sample.width, '0')}`,
                    ],
                });
            }
        }
    }
    return { candidates, skipped, unreadable, otherScheme };
}

/** Fold the register-level checks back into the rows that they concern. */
export function annotateRegister(rows) {
    const duplicates = findDuplicates(rows);
    const gaps = findGapCandidates(rows);

    const duplicatePages = new Set(duplicates.flatMap((d) => d.pages));
    for (const row of rows) {
        if (duplicatePages.has(row.pageNumber)) {
            row.reviewReasons.push(REVIEW_REASONS.DUPLICATE_NUMBER);
        }
    }
    return { rows, duplicates, gaps };
}

/**
 * What a reviewer sees first.
 *
 * Sorted by how much doubt there is, not by how likely the row is to be wrong:
 * the two are not the same thing, and this ordering only claims the first.
 */
export function reviewQueue(rows) {
    return [...rows]
        .map((row) => ({
            pageNumber: row.pageNumber,
            reasons: row.reviewReasons,
            lowestConfidence: Object.values(row.confidence).length
                ? Math.min(...Object.values(row.confidence))
                : null,
        }))
        .filter((r) => r.reasons.length > 0)
        .sort((a, b) => b.reasons.length - a.reasons.length
            || (a.lowestConfidence ?? 101) - (b.lowestConfidence ?? 101)
            || a.pageNumber - b.pageNumber);
}

/**
 * A row a person has looked at and accepted.
 *
 * Takes the edited values, not the extracted ones, and records that a human was
 * involved. There is no path from `buildRow` to here that does not pass through
 * a caller supplying edits.
 */
export function confirmRow(row, edits = {}) {
    const fields = {};
    for (const field of FIELDS) {
        const entry = row.fields[field];
        const finalValue = (edits[field] ?? entry.value).trim();
        fields[field] = {
            ...entry,
            // rawText is deliberately carried through untouched. A confirmed
            // row that no longer knows what was on the page cannot be audited,
            // and "the human agreed" is not the same record as "this is what
            // the sheet said".
            rawText: entry.rawText,
            proposedValue: entry.value,
            value: finalValue,
            editedByHuman: finalValue !== entry.value,
        };
    }
    return {
        ...row,
        fields,
        ...Object.fromEntries(FIELDS.map((f) => [f, fields[f].value])),
        reviewStatus: 'confirmed',
        confirmedFrom: {
            raw: Object.fromEntries(FIELDS.map((f) => [f, row.fields[f].rawText])),
            proposed: Object.fromEntries(FIELDS.map((f) => [f, row.fields[f].value])),
            final: Object.fromEntries(FIELDS.map((f) => [f, fields[f].value])),
            extracted: Object.fromEntries(FIELDS.map((f) => [f, row.fields[f].value])),
            edited: FIELDS.filter((f) => fields[f].editedByHuman),
        },
    };
}
