/**
 * Shared types for the PDF Textifier OCR pipeline.
 */

/** How a single page was classified before any OCR work was decided. */
export type PageKind = 'text-native' | 'scanned';

export interface PageClassification {
    pageNumber: number;
    kind: PageKind;
    /** Characters found anywhere on the page. */
    allChars: number;
    /** Characters found inside the content region, ignoring the margins. */
    interiorChars: number;
    /** How many image-drawing operators the page issues. */
    imageOps: number;
}

/** One recognised word, in the pixel space of the canvas that was OCR'd. */
export interface OcrWord {
    text: string;
    /** Pixel bounding box on the rendered canvas. */
    bbox: { x0: number; y0: number; x1: number; y1: number };
    /** Tesseract confidence, 0-100. */
    confidence: number;
}

export interface PageResult {
    pageNumber: number;
    kind: PageKind;
    /** Words recognised on this page. Always 0 for a text-native page. */
    ocrWords: number;
    /** Invisible runs actually written onto the page. */
    placed: number;
    /** Mean OCR confidence, or null when the page was not OCR'd. */
    meanConfidence: number | null;
    /** Recognised text, kept short for display. */
    textSample: string;
    ms: number;
    /** Present only when preprocessing ran for this page. */
    preprocess?: PagePreprocessInfo;
    /** Set when this page failed but the document as a whole continued. */
    error?: string;
}

export type ProgressPhase =
    | 'loading'
    | 'classifying'
    | 'ocr-init'
    /** Reading text a page already carries, in Text Extraction. */
    | 'extracting'
    | 'ocr-page'
    | 'writing'
    | 'done'
    | 'cancelled';

export interface ProgressEvent {
    phase: ProgressPhase;
    /** 1-based page currently being handled, when the phase is per-page. */
    page?: number;
    totalPages?: number;
    /** 0-1 within the current page's recognition, when Tesseract reports it. */
    pageProgress?: number;
    message: string;
}

export interface TextifyResult {
    bytes: Uint8Array;
    pages: PageResult[];
    /** True when the run stopped early because the caller cancelled. */
    cancelled: boolean;
    /** True when a Japanese font was actually embedded. */
    fontEmbedded: boolean;
    inputBytes: number;
    outputBytes: number;
    totalMs: number;
}

/**
 * Failure kinds the UI needs to tell apart. A bare "something went wrong" is
 * not actionable: a password-protected file, a missing OCR asset and a broken
 * page are three different problems for the person holding the PDF.
 */
export type TextifyErrorCode =
    | 'pdf-load'
    | 'pdf-encrypted'
    | 'ocr-assets'
    | 'ocr-page'
    /** A text-native page whose own text could not be read. */
    | 'text-extract'
    | 'output'
    | 'cancelled';

export class TextifyError extends Error {
    readonly code: TextifyErrorCode;
    readonly detail?: string;
    /** True when the run cannot continue, e.g. the OCR worker had to be killed. */
    readonly fatal: boolean;

    constructor(code: TextifyErrorCode, message: string, detail?: string, fatal = false) {
        super(message);
        this.name = 'TextifyError';
        this.code = code;
        this.detail = detail;
        this.fatal = fatal;
    }
}

export interface TextifyOptions {
    /** Tesseract language string. Defaults to 'jpn+eng'. */
    langs?: string;
    /** DPI used to rasterise a scanned page for OCR. Defaults to 150. */
    dpi?: number;
    /**
     * Clean-up applied to the OCR image only, never to the document produced.
     * Both flags default to false, so a run says exactly what it did.
     */
    preprocess?: { deskew?: boolean; noiseReduction?: boolean };
    onProgress?: (event: ProgressEvent) => void;
    /** Polled at every page boundary. Returning true stops the run. */
    shouldCancel?: () => boolean;
}

/** What preprocessing did to one page, for the caller to report or assert on. */
export interface PagePreprocessInfo {
    deskewApplied: boolean;
    /** Degrees of skew found. 0 when nothing was applied. */
    detectedAngle: number;
    deskewConfidence: number;
    noiseReductionApplied: boolean;
    removedSpecks: number;
    processingMs: number;
}

/** One page of a Text Extraction run, in the order the PDF has it. */
export interface ExtractedPage {
    pageNumber: number;
    kind: PageKind;
    /** The page's text. Empty when the page genuinely carries none. */
    text: string;
    charCount: number;
    /** Words recognised on this page. Always 0 for a text-native page. */
    ocrWords: number;
    /** Mean OCR confidence, or null when the page was not OCR'd. */
    meanConfidence: number | null;
    ms: number;
    /** Present only when preprocessing ran for this page. */
    preprocess?: PagePreprocessInfo;
}

export interface TextExtractionResult {
    /** The whole document as UTF-8 plain text, page headers included. */
    text: string;
    pages: ExtractedPage[];
    totalChars: number;
    totalMs: number;
    /** True when the OCR engine was actually started for this run. */
    ocrUsed: boolean;
}
