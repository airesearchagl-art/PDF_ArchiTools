import { createWorker } from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { TextifyError } from './types';
import type { OcrWord } from './types';

/**
 * Every OCR asset is served from our own origin.
 *
 * tesseract.js defaults to jsDelivr for the worker, the WASM core and the
 * language data. That would mean a third party sees a request every time
 * someone OCRs a drawing, so all three are overridden to local paths and the
 * files are committed under public/ocr/.
 */
const TESSERACT_OPTIONS = {
    workerPath: '/ocr/tesseract/worker.min.js',
    corePath: '/ocr/tesseract/',
    langPath: '/ocr/tessdata',
    gzip: false,
    workerBlobURL: false,
} as const;

/**
 * Upper bound on a single page's recognition.
 *
 * A page normally finishes in a few hundred milliseconds. This is not a
 * performance knob -- it exists because recognition can otherwise stall with no
 * error at all, leaving the UI on a spinner forever. Generous enough that a
 * genuinely slow page still completes, short enough that a stall is reported.
 */
export const PAGE_OCR_TIMEOUT_MS = 120_000;

export interface OcrPageOutput {
    words: OcrWord[];
    text: string;
    meanConfidence: number | null;
}

interface RecognisedWord {
    text?: string;
    confidence?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
}
interface RecognisedLine { words?: RecognisedWord[] }
interface RecognisedParagraph { lines?: RecognisedLine[] }
interface RecognisedBlock { paragraphs?: RecognisedParagraph[] }

/** Flatten Tesseract's block tree down to the word boxes we place. */
function flattenWords(blocks: RecognisedBlock[] | null | undefined): OcrWord[] {
    const out: OcrWord[] = [];
    for (const block of blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
            for (const line of paragraph.lines ?? []) {
                for (const word of line.words ?? []) {
                    const text = (word.text ?? '').trim();
                    if (!text || !word.bbox) continue;
                    out.push({
                        text,
                        bbox: word.bbox,
                        confidence: word.confidence ?? 0,
                    });
                }
            }
        }
    }
    return out;
}

/**
 * Hand Tesseract bytes, never the canvas itself.
 *
 * Given an HTMLCanvasElement, tesseract.js calls `canvas.toBlob()` and waits on
 * its callback with no error path and no timeout, so a callback that never
 * fires stalls the whole pipeline silently. `toDataURL` is synchronous: it
 * cannot fail to call back. It also measured ~2 ms against ~1000 ms for
 * `toBlob` on a throttled page, which is the same difference by another name.
 *
 * The cost is a base64 string in memory for the duration of the conversion.
 * That is a fair trade for removing a class of unkillable hang.
 */
function canvasToDataUrl(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/png');
}

/**
 * Owns the Tesseract worker for one run.
 *
 * Created lazily, because a document with no scanned pages should never pay for
 * loading several megabytes of WASM and language data.
 */
export class OcrEngine {
    private worker: TesseractWorker | null = null;
    private readonly langs: string;
    private readonly onPageProgress?: (progress: number) => void;

    constructor(langs: string, onPageProgress?: (progress: number) => void) {
        this.langs = langs;
        this.onPageProgress = onPageProgress;
    }

    get started(): boolean {
        return this.worker !== null;
    }

    async start(): Promise<void> {
        if (this.worker) return;
        try {
            this.worker = await createWorker(this.langs, 1, {
                ...TESSERACT_OPTIONS,
                logger: (message: { status: string; progress: number }) => {
                    if (message.status === 'recognizing text') this.onPageProgress?.(message.progress);
                },
            });
        } catch (error) {
            throw new TextifyError(
                'ocr-assets',
                'OCRエンジンの読み込みに失敗しました。',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Recognise one rendered page.
     *
     * `blocks: true` is not optional: since tesseract.js v6 every output except
     * plain text is off by default, and without it the result carries no
     * coordinates at all, which would silently produce an empty text layer.
     *
     * Bounded on purpose. If recognition does not finish, the worker is torn
     * down and the caller gets an error rather than an endless spinner.
     */
    async recognisePage(
        canvas: HTMLCanvasElement,
        timeoutMs = PAGE_OCR_TIMEOUT_MS,
    ): Promise<OcrPageOutput> {
        if (!this.worker) throw new TextifyError('ocr-page', 'OCRエンジンが起動していません。');
        const image = canvasToDataUrl(canvas);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new TextifyError(
                    'ocr-page',
                    `文字認識が ${Math.round(timeoutMs / 1000)} 秒以内に完了しませんでした。`,
                    'recognition timed out',
                    true,
                )),
                timeoutMs,
            );
        });

        try {
            const { data } = await Promise.race([
                this.worker.recognize(image, {}, { blocks: true, text: true }),
                timeout,
            ]);
            const words = flattenWords(data.blocks as RecognisedBlock[] | null);
            const meanConfidence = words.length
                ? Math.round(words.reduce((sum, w) => sum + w.confidence, 0) / words.length)
                : null;
            return { words, text: data.text ?? '', meanConfidence };
        } catch (error) {
            // A stalled recognition leaves the worker unusable, and there is no
            // way to abort one in flight, so the worker goes with it.
            if (error instanceof TextifyError && error.fatal) await this.terminate();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Tesseract exposes no way to abort a recognition in flight, so cancelling
     * means discarding the whole worker. Safe to call more than once.
     */
    async terminate(): Promise<void> {
        const worker = this.worker;
        this.worker = null;
        if (!worker) return;
        try {
            await worker.terminate();
        } catch {
            // The worker is being thrown away; a failure to shut down cleanly
            // must not mask the error that led us here.
        }
    }
}
