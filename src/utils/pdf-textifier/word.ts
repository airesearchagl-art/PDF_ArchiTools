import JSZip from 'jszip';

import { TextifyError } from './types';
import type { ExtractedPage } from './types';

/**
 * Write extracted text into an editable Word document, in the browser.
 *
 * This is a text export, not a conversion. It carries the characters and the
 * page order of the PDF into a .docx someone can edit; it does not reproduce
 * the drawing. Nothing here looks at the page image, and no layout, table,
 * column, font or style is inferred -- claiming otherwise would be the easiest
 * way to make this feature untrustworthy.
 *
 * The package is the three parts a wordprocessing document actually requires
 * and nothing else. Every relationship points inside the package: no macros, no
 * templates, no remote fonts or images, nothing that would make opening the
 * file reach the network.
 */

/** Zipped as a fixed date so the same document twice is the same bytes. */
const FIXED_DATE = new Date(Date.UTC(2026, 8, 5, 0, 0, 0));

export const WORD_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="${WORD_MIME}.main+xml"/>`
    + `</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1"`
    + ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"`
    + ` Target="word/document.xml"/>`
    + `</Relationships>`;

/**
 * A4 portrait with even margins, in twentieths of a point.
 *
 * A section is where a page size has to be stated, and stating one is better
 * than leaving it to whatever the reader defaults to. It is not a claim about
 * the source: where the PDF's pages break is preserved as explicit breaks, and
 * where Word's pages break after that depends on its own fonts and spacing.
 */
const SECTION = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"`
    + ` w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;

export interface WordExportResult {
    bytes: Uint8Array;
    pageCount: number;
    paragraphCount: number;
    characterCount: number;
    /** Explicit breaks written between pages: one fewer than the page count. */
    pageBreaks: number;
    totalMs: number;
}

export interface WordExportOptions {
    /** Polled before the package is built and again once it is. */
    shouldCancel?: () => boolean;
}

/**
 * Characters XML 1.0 cannot carry, whatever they mean.
 *
 * Most control codes are simply not expressible in XML, and a lone surrogate is
 * not a character at all -- both would produce a file that no reader can open.
 * They are dropped rather than replaced, because inventing a substitute would
 * put something in the document that was never in the PDF.
 */
const isXmlChar = (cp: number): boolean =>
    cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);

/**
 * Tested by code point rather than by pattern.
 *
 * Iterating a string yields code points, so a surrogate pair arrives whole and
 * an unpaired half arrives alone -- which is exactly the distinction that has
 * to be made here. Emoji and other supplementary characters pass through
 * untouched. The string is only rebuilt when something actually has to go.
 */
function stripInvalidXmlChars(text: string): string {
    for (const ch of text) {
        if (!isXmlChar(ch.codePointAt(0) ?? 0)) {
            let out = '';
            for (const c of text) if (isXmlChar(c.codePointAt(0) ?? 0)) out += c;
            return out;
        }
    }
    return text;
}

/**
 * Escape before anything reaches the markup, never after.
 *
 * A drawing's text is full of the characters XML reserves -- `A&B`, `<NOTE>`,
 * a quoted revision -- and concatenating any of them raw is how a document
 * stops being openable, or worse, how text becomes markup.
 */
export function escapeXml(text: string): string {
    return stripInvalidXmlChars(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * One line of extracted text becomes one paragraph.
 *
 * Deliberately literal. Guessing where a paragraph really ends means guessing
 * at the layout of a page this export has decided not to interpret, and a wrong
 * guess silently rewrites the document. A blank line stays a blank paragraph so
 * the shape of the text survives.
 */
function paragraph(line: string): string {
    if (line.length === 0) return '<w:p/>';
    // xml:space="preserve" or the reader is entitled to collapse the leading
    // and trailing spaces that indentation in a drawing note depends on.
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
}

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** Lines of a page, with CRLF folded to LF so the split is predictable. */
function linesOf(text: string): string[] {
    return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Turn the pages of an extraction into a Word document.
 *
 * Takes the pages, not the joined text. The page boundaries and the empty pages
 * are the part a text file can only express by convention, and re-parsing the
 * TXT to find them again would be reconstructing information that is already
 * here.
 */
export async function buildWordDocument(
    pages: readonly ExtractedPage[],
    options: WordExportOptions = {},
): Promise<WordExportResult> {
    const { shouldCancel = () => false } = options;
    const startedAt = performance.now();

    if (shouldCancel()) throw new TextifyError('cancelled', '処理をキャンセルしました。');

    let paragraphCount = 0;
    let characterCount = 0;
    let pageBreaks = 0;
    const body: string[] = [];

    pages.forEach((page, index) => {
        if (index > 0) {
            // Between pages only. A break after the last one would leave an
            // empty page at the end of every document.
            body.push(PAGE_BREAK);
            pageBreaks++;
        }
        for (const line of linesOf(page.text ?? '')) {
            body.push(paragraph(line));
            paragraphCount++;
            characterCount += line.length;
        }
    });

    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + `<w:body>${body.join('')}${SECTION}</w:body></w:document>`;

    let bytes: Uint8Array;
    try {
        const zip = new JSZip();
        zip.file('[Content_Types].xml', CONTENT_TYPES, { date: FIXED_DATE });
        zip.file('_rels/.rels', PACKAGE_RELS, { date: FIXED_DATE });
        zip.file('word/document.xml', document, { date: FIXED_DATE });
        bytes = await zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
            mimeType: WORD_MIME,
            platform: 'DOS',
        });
    } catch (error) {
        throw new TextifyError(
            'word-output',
            'Wordファイルの生成に失敗しました。',
            error instanceof Error ? error.message : String(error),
        );
    }

    // Zipping is asynchronous, so the run may have been cancelled while it was
    // in flight. A finished document handed back after that is exactly the
    // partial result cancellation is supposed to prevent.
    if (shouldCancel()) throw new TextifyError('cancelled', '処理をキャンセルしました。');

    return {
        bytes,
        pageCount: pages.length,
        paragraphCount,
        characterCount,
        pageBreaks,
        totalMs: Math.round(performance.now() - startedAt),
    };
}
