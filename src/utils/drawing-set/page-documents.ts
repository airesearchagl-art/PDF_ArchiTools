/**
 * The PDF.js document holders of the whole page, made once when the app loads.
 *
 * One gate, shared by intake, the preview and title-block extraction
 * (pdf-document-gate.ts), and one preview owner registered with it. They are
 * the page's, not a workspace's: leaving 図面管理 and coming back, or starting
 * a new Drawing Set, gets new sessions but the same gate and owner. So a
 * PDF.js document that could not be destroyed -- whose worker may still be
 * running -- keeps everything from opening another until the page is
 * reloaded, which is what ends every worker. A fresh gate would forget that.
 */
import { PdfDocumentGate } from './pdf-document-gate';
import { PreviewDocumentOwner } from './preview-document';

export const PAGE_PDF_GATE = new PdfDocumentGate();
export const PAGE_PREVIEW_OWNER = new PreviewDocumentOwner({ gate: PAGE_PDF_GATE });
