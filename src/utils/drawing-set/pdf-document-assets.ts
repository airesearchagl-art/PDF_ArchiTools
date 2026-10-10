/**
 * The PDF.js data files M7 opens its documents with, served from this origin.
 *
 * Without them PDF.js reads some pages wrongly, and not visibly so:
 *  - a font that needs one of its built-in CMaps -- a Japanese CID font with
 *    a predefined encoding such as UniJIS-UCS2-H, or an Adobe-Japan1 font
 *    with no ToUnicode map -- is swapped whole for one that draws nothing and
 *    yields no text. The text is then missing from the page a person looks at
 *    and from what is read, together, so a reading cannot be checked against
 *    the page;
 *  - a JPX (JPEG 2000) image cannot be decoded at all, so a scan compressed
 *    that way renders blank and recognition finds nothing on it.
 *
 * The files are copies of the installed pdfjs-dist's own (scripts/
 * setup-pdfjs-assets.mjs), under public/pdfjs/, checked byte for byte against
 * it by the M7 foundation gate. There is deliberately no CDN fallback: a file
 * that is missing fails, it is never fetched from somebody else's server.
 *
 * M7-P2-A uses these for the extraction document only. The intake and the
 * preview documents of M7-P1 move onto the same files in M7-P2-B, so that all
 * three read a page the same way.
 */
export const PDFJS_ASSET_ROOT = '/pdfjs/';

export interface PdfDocumentAssets {
    cMapUrl: string;
    cMapPacked: true;
    standardFontDataUrl: string;
    wasmUrl: string;
}

export function m7PdfDocumentAssets(): PdfDocumentAssets {
    return {
        cMapUrl: `${PDFJS_ASSET_ROOT}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSET_ROOT}standard_fonts/`,
        wasmUrl: `${PDFJS_ASSET_ROOT}wasm/`,
    };
}
