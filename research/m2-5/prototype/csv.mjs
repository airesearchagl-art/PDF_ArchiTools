/**
 * Writing the register out, and the part of that which is a safety question.
 *
 * RESEARCH ONLY. Nothing here is imported by the app.
 *
 * A spreadsheet reads a cell beginning `=`, `+`, `-` or `@` as a formula. On a
 * drawing register those are not hypothetical characters: a revision really can
 * be `+3`, and a value that starts with `-` is ordinary. So the question is not
 * "can this happen" but "what should the file do when it does", and the answers
 * differ in ways that matter:
 *
 *   quoting alone does not help. `"=1+1"` is still a formula when the file is
 *   opened; CSV quoting is about delimiters, not about evaluation.
 *
 *   dropping or stripping the character makes the file safe by making it wrong.
 *   A register whose revision silently changed from `+3` to `3` is a worse
 *   outcome than a spreadsheet warning.
 *
 * Four serialisations are implemented so they can be measured against each
 * other, rather than one being asserted to be correct.
 */

export const COLUMNS = [
    'page_number',
    'drawing_number',
    'drawing_title',
    'revision',
    'revision_date',
    'review_status',
    'extraction_source',
];

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export const isFormulaLead = (value) => FORMULA_LEAD.test(String(value));

/** RFC 4180 quoting: only about delimiters, never about evaluation. */
function quote(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text) || /^\s|\s$/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

/**
 * The four candidate policies.
 *
 *   raw          quoting only. Formulas evaluate. Included as the baseline that
 *                shows quoting is not a safety measure.
 *   strip        remove the leading character. Safe, and changes the data.
 *   prefix-quote a leading apostrophe, the spreadsheet convention for "this is
 *                text". Excel hides it and treats the cell as text; other
 *                readers show it, which is the cost.
 *   tab-prefix   a leading tab inside a quoted field. Excel treats the cell as
 *                text and does not display the tab; a plain CSV reader sees a
 *                leading whitespace character.
 */
export const POLICIES = {
    raw: (value) => String(value ?? ''),
    strip: (value) => String(value ?? '').replace(FORMULA_LEAD, ''),
    'prefix-quote': (value) => {
        const text = String(value ?? '');
        return isFormulaLead(text) ? `'${text}` : text;
    },
    'tab-prefix': (value) => {
        const text = String(value ?? '');
        return isFormulaLead(text) ? `\t${text}` : text;
    },
};

/**
 * Serialise the register.
 *
 * CRLF line endings and an optional UTF-8 BOM, because the readers this file is
 * for are Japanese spreadsheets: without the BOM, Excel on Windows opens a
 * UTF-8 CSV as the system code page and every Japanese title becomes mojibake.
 * That is the whole reason the option exists, and it is measured rather than
 * assumed.
 */
export function toCsv(rows, { policy = 'prefix-quote', bom = true, eol = '\r\n' } = {}) {
    const escape = POLICIES[policy];
    if (!escape) throw new Error(`unknown policy: ${policy}`);

    const lines = [COLUMNS.join(',')];
    for (const row of rows) {
        lines.push(COLUMNS.map((column) => {
            const value = column === 'page_number' ? row.pageNumber
                : column === 'review_status' ? row.reviewStatus
                    : column === 'extraction_source' ? row.extractionSource
                        : row[column];
            return quote(escape(value ?? ''));
        }).join(','));
    }
    return `${bom ? '﻿' : ''}${lines.join(eol)}${eol}`;
}

/**
 * Read a CSV back, well enough to check what a cell now holds.
 *
 * Deliberately small: it exists to answer "did the value survive", not to be a
 * general parser.
 */
export function parseCsv(text) {
    const body = text.replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (quoted) {
            if (ch === '"') {
                if (body[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/**
 * What each policy does to a value, on the three axes that matter.
 *
 *   evaluates    would a spreadsheet treat the written cell as a formula
 *   roundTrips   does reading the file back give the original characters
 *   visible      what a person would see in the cell
 */
export function analysePolicies(values) {
    return values.map((value) => {
        const perPolicy = {};
        for (const [name, escape] of Object.entries(POLICIES)) {
            const written = escape(value);
            const csv = toCsv([{
                pageNumber: 1, drawing_number: value, drawing_title: '', revision: '',
                revision_date: '', reviewStatus: 'unconfirmed', extractionSource: 'native',
            }], { policy: name, bom: false });
            const readBack = parseCsv(csv)[1]?.[1] ?? '';
            perPolicy[name] = {
                written,
                readBack,
                evaluates: isFormulaLead(written),
                roundTrips: readBack === value,
                // What Excel shows: an apostrophe prefix is consumed as a
                // text marker, a tab is not displayed.
                visibleInExcel: name === 'prefix-quote' && written.startsWith("'") ? written.slice(1)
                    : name === 'tab-prefix' && written.startsWith('\t') ? written.slice(1)
                        : written,
            };
        }
        return { value, policies: perPolicy };
    });
}
