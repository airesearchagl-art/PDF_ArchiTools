/**
 * A minimal SpreadsheetML workbook, written by hand.
 *
 * RESEARCH ONLY. The question this answers is narrow: can the app produce an
 * editable .xlsx with the JSZip it already depends on, and how much OOXML does
 * that actually take once Japanese text, blank cells, merged cells and more
 * than one sheet are in scope. M2-3 answered the same question for .docx with
 * three parts, and assuming a spreadsheet is the same size of problem is
 * exactly the assumption a spike is supposed to test.
 *
 * The zipping is injected rather than imported so this one module can be
 * measured in Node and in a browser without a second copy of it existing.
 */

/** Excel reserves five characters, and a schedule really does contain them. */
export function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Characters XML 1.0 cannot carry at all.
 *
 * Same rule as the Word export: control characters and lone surrogates are
 * removed by code point, because a single one of them makes the whole file
 * unopenable rather than slightly wrong.
 */
export function stripInvalidXmlChars(value) {
    let out = '';
    for (const ch of String(value)) {
        const cp = ch.codePointAt(0);
        const ok = cp === 0x9 || cp === 0xa || cp === 0xd
            || (cp >= 0x20 && cp <= 0xd7ff)
            || (cp >= 0xe000 && cp <= 0xfffd)
            || (cp >= 0x10000 && cp <= 0x10ffff);
        if (ok) out += ch;
    }
    return out;
}

/** A1, B1, ... Z1, AA1: the column letters Excel addresses cells by. */
export function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

/**
 * How a cell's text becomes a cell's value.
 *
 *   string      every value stays text
 *   conservative  a plain integer or decimal becomes a number; anything with a
 *                 leading zero, a separator or a unit stays text
 *   aggressive    anything that parses as a number becomes one
 *
 * The middle one exists because of what a drawing actually contains: "001" is a
 * mark number, "1:100" is a scale, "2026.09" is a month and "D13@200" is
 * reinforcement. Turning any of those into a number is not a formatting
 * question, it is data loss.
 */
export function typeValue(text, mode = 'conservative') {
    const raw = String(text ?? '');
    if (raw === '') return { kind: 'blank' };
    if (mode === 'string') return { kind: 'string', value: raw };
    if (mode === 'aggressive') {
        const n = Number(raw.replace(/,/g, ''));
        if (raw.trim() !== '' && Number.isFinite(n)) return { kind: 'number', value: n };
        return { kind: 'string', value: raw };
    }
    // Conservative: a number is a number only when nothing about the string
    // suggests it is an identifier.
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw) && raw.length <= 15) {
        return { kind: 'number', value: Number(raw) };
    }
    return { kind: 'string', value: raw };
}

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/**
 * Build every part of the package.
 *
 * `sheets` is [{ name, rows: string[][], merges: [{ r0, c0, r1, c1 }] }].
 * Strings are written inline rather than through a shared-strings table: one
 * part fewer, no index to keep consistent, and nothing to get wrong when a
 * value appears twice.
 */
export function buildWorkbookParts(sheets, { typing = 'conservative' } = {}) {
    const parts = new Map();
    const counts = { cells: 0, blanks: 0, numbers: 0, strings: 0, merges: 0 };

    const sheetFiles = sheets.map((_, i) => `worksheets/sheet${i + 1}.xml`);

    parts.set('[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<Types xmlns="${CT}">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + sheetFiles.map((f) => `<Override PartName="/xl/${f}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + `</Types>`);

    parts.set('_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<Relationships xmlns="${REL}">`
        + `<Relationship Id="rId1" Type="${DOCREL}/officeDocument" Target="xl/workbook.xml"/>`
        + `</Relationships>`);

    parts.set('xl/workbook.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<workbook xmlns="${MAIN}" xmlns:r="${DOCREL}">`
        + `<sheets>`
        + sheets.map((s, i) => `<sheet name="${escapeXml(stripInvalidXmlChars(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + `</sheets></workbook>`);

    parts.set('xl/_rels/workbook.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<Relationships xmlns="${REL}">`
        + sheetFiles.map((f, i) => `<Relationship Id="rId${i + 1}" Type="${DOCREL}/worksheet" Target="${f}"/>`).join('')
        + `</Relationships>`);

    sheets.forEach((sheet, index) => {
        const rows = sheet.rows.map((row, r) => {
            const cells = row.map((value, c) => {
                const typed = typeValue(stripInvalidXmlChars(value ?? ''), typing);
                const ref = `${columnName(c)}${r + 1}`;
                if (typed.kind === 'blank') {
                    counts.blanks++;
                    // A blank cell is written out, not skipped: the columns
                    // after it must keep their addresses, and a cell that is
                    // deliberately empty is information in a schedule.
                    return `<c r="${ref}"/>`;
                }
                counts.cells++;
                if (typed.kind === 'number') {
                    counts.numbers++;
                    return `<c r="${ref}"><v>${typed.value}</v></c>`;
                }
                counts.strings++;
                return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(typed.value)}</t></is></c>`;
            }).join('');
            return `<row r="${r + 1}">${cells}</row>`;
        }).join('');

        const merges = sheet.merges ?? [];
        counts.merges += merges.length;
        // The schema is a sequence: mergeCells has to follow sheetData, and an
        // empty <mergeCells count="0"/> is itself invalid.
        const mergeXml = merges.length
            ? `<mergeCells count="${merges.length}">${merges.map((m) =>
                `<mergeCell ref="${columnName(m.c0)}${m.r0 + 1}:${columnName(m.c1)}${m.r1 + 1}"/>`).join('')}</mergeCells>`
            : '';

        parts.set(`xl/${sheetFiles[index]}`,
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
            + `<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData>${mergeXml}</worksheet>`);
    });

    return { parts, counts };
}

/** Fixed timestamp and platform, so the same workbook is the same bytes. */
export const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

export async function zipWorkbook(JSZip, parts) {
    const zip = new JSZip();
    for (const [name, content] of parts) {
        zip.file(name, content, { date: FIXED_DATE, createFolders: false });
    }
    return zip.generateAsync({
        type: typeof window === 'undefined' ? 'nodebuffer' : 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'DOS',
    });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
