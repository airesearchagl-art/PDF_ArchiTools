/**
 * Write a workbook, in the browser, with the JSZip the app already has.
 *
 * Deliberately minimal. Six parts for a two-sheet workbook and no more: no
 * shared-strings table to keep an index consistent with, no styles, no macros,
 * no external relationships, no formulas. Nothing in the file reaches outside
 * itself.
 *
 * **Every value is written as text.** A drawing is full of identifiers that
 * look like numbers -- 001 is a mark number, 1:100 is a scale, 2026.09 is a
 * month, D13@200 is reinforcement -- and a spreadsheet that helpfully reads
 * those as numbers has changed the drawing. `12` is written as text too, which
 * is intentional: the rule is worth more than the convenience of one cell.
 */
import JSZip from 'jszip';

import type { ConfirmedTable } from './table-types';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Fixed timestamp, so the same tables produce the same bytes.
 *
 * JSZip stamps the current time into every entry otherwise, which would make
 * two identical exports differ and leave a gate with nothing to assert.
 */
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** The five characters XML reserves, which a schedule really does contain. */
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Characters XML 1.0 cannot carry at all.
 *
 * Walked by code point rather than matched by a regular expression: a lone
 * surrogate has to be judged as a code point, and one control character makes
 * the whole workbook unopenable rather than slightly wrong.
 */
export function stripInvalidXmlChars(value: string): string {
    let out = '';
    for (const ch of value) {
        const cp = ch.codePointAt(0) ?? 0;
        const ok = cp === 0x9 || cp === 0xa || cp === 0xd
            || (cp >= 0x20 && cp <= 0xd7ff)
            || (cp >= 0xe000 && cp <= 0xfffd)
            || (cp >= 0x10000 && cp <= 0x10ffff);
        if (ok) out += ch;
    }
    return out;
}

/** A1, B1 … Z1, AA1: how Excel addresses a column. */
export function columnName(index: number): string {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

export interface WorkbookResult {
    bytes: Uint8Array;
    sheetCount: number;
    cellCount: number;
    blankCount: number;
}

export interface WorkbookOptions {
    /** Polled before and after zipping. */
    shouldCancel?: () => boolean;
}

/** Everything the package needs, as name → contents. */
export function buildWorkbookParts(tables: ConfirmedTable[]): {
    parts: Map<string, string>;
    cellCount: number;
    blankCount: number;
} {
    const parts = new Map<string, string>();
    const sheetFiles = tables.map((_, i) => `worksheets/sheet${i + 1}.xml`);
    let cellCount = 0;
    let blankCount = 0;

    parts.set('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<Types xmlns="${CONTENT_TYPES}">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheetFiles.map((f) => `<Override PartName="/xl/${f}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>');

    parts.set('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<Relationships xmlns="${PACKAGE_RELS}">`
        + `<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/>`
        + '</Relationships>');

    parts.set('xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<workbook xmlns="${SPREADSHEET}" xmlns:r="${DOC_RELS}"><sheets>`
        + tables.map((t, i) => `<sheet name="${escapeXml(stripInvalidXmlChars(t.sheetName))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>');

    parts.set('xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<Relationships xmlns="${PACKAGE_RELS}">`
        + sheetFiles.map((f, i) => `<Relationship Id="rId${i + 1}" Type="${DOC_RELS}/worksheet" Target="${f}"/>`).join('')
        + '</Relationships>');

    tables.forEach((table, index) => {
        const rows = table.grid.map((row, r) => {
            const cells = row.map((value, c) => {
                const ref = `${columnName(c)}${r + 1}`;
                const text = stripInvalidXmlChars(value ?? '');
                if (text === '') {
                    blankCount++;
                    // Written, not skipped. A blank cell holds its address, so
                    // the columns after it stay where they are -- and a cell
                    // left empty in a schedule is information in itself.
                    return `<c r="${ref}"/>`;
                }
                cellCount++;
                return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
            }).join('');
            return `<row r="${r + 1}">${cells}</row>`;
        }).join('');

        // No mergeCells element anywhere: merges are not inferred, so none are
        // written. What the preview showed is what the workbook contains.
        parts.set(`xl/${sheetFiles[index]}`,
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + `<worksheet xmlns="${SPREADSHEET}"><sheetData>${rows}</sheetData></worksheet>`);
    });

    return { parts, cellCount, blankCount };
}

/**
 * Build the workbook.
 *
 * Only ever called with tables the user has confirmed. There is no path from a
 * reconstruction to a file that does not pass through a person looking at it.
 */
export async function buildWorkbook(
    tables: ConfirmedTable[], options: WorkbookOptions = {},
): Promise<WorkbookResult> {
    const shouldCancel = options.shouldCancel ?? (() => false);
    if (tables.length === 0) {
        throw new Error('確定された表がありません。');
    }
    if (shouldCancel()) throw new Error('cancelled');

    const { parts, cellCount, blankCount } = buildWorkbookParts(tables);
    const zip = new JSZip();
    for (const [name, content] of parts) {
        zip.file(name, content, { date: FIXED_DATE, createFolders: false });
    }
    const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'DOS',
    });
    if (shouldCancel()) throw new Error('cancelled');

    return { bytes, sheetCount: tables.length, cellCount, blankCount };
}

/**
 * What the download is called.
 *
 * `_tables` rather than `_extracted`: the file holds the tables the user chose
 * and confirmed, not every table in the PDF, and the name should not suggest
 * otherwise.
 */
export function workbookFileName(sourceName: string): string {
    return `${sourceName.replace(/\.pdf$/i, '')}_tables.xlsx`;
}
