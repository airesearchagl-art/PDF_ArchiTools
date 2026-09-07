/**
 * Recognising the fields of a title block.
 *
 * One call per page, over the region that covers the fields still needing it,
 * with the recognised words placed back into the field they fall in. The
 * alternative -- one call per field -- was measured against this and is not
 * better: same accuracy, four times the calls, no faster, and it does not
 * produce anything the union path cannot. Words are attributed by where they
 * are, so each field still gets its own text, word count and score.
 *
 * A per-field pass is kept available, but only as something a person asks for.
 * There is no threshold at which this module switches to it on its own,
 * because no such threshold has been measured, and inventing one would mean
 * quietly changing how a page was read on the strength of a guess.
 */

import type * as pdfjsLib from 'pdfjs-dist';
import type { OcrWord } from './types';
import type { SelectionRect } from './table-types';
import type { RegisterFieldName } from './drawing-register-types';
import { OcrEngine } from './ocr';
import { renderRegion, releaseRegion, REGISTER_DPI } from './drawing-register-geometry';
import { unionRect } from './drawing-register-template';

/**
 * A title-block field is one block of text, and saying so helps.
 *
 * Tesseract's page segmentation modes are string values, not numbers; passing
 * a number is silently ignored and you get the default back. `'6'` is
 * `SINGLE_BLOCK`.
 *
 * This is set only on the engine this module owns. The OCR and text-extraction
 * pipelines keep the default they have always had.
 */
export const REGISTER_PAGE_SEG_MODE = '6';

/** What recognition produced for one field. */
export interface RecognisedField {
    rawText: string;
    wordCount: number;
    /** Mean of the words' own scores, 0-100, or null when nothing landed here. */
    score: number | null;
}

export interface RegionRecognition {
    fields: Partial<Record<RegisterFieldName, RecognisedField>>;
    /** Words that fell outside every field rectangle. Reported, not discarded. */
    unplaced: string[];
    pixels: number;
    ms: number;
    calls: number;
}

/**
 * An OCR engine owned by the drawing register.
 *
 * Separate from the pipelines' engines on purpose: it is configured with a
 * segmentation mode they do not use, and an engine is a worker, so sharing one
 * would mean sharing that setting. One worker serves a whole extraction run
 * and is terminated when the run's owner goes away.
 */
export class RegisterOcrEngine {
    private engine: OcrEngine | null = null;
    private readonly langs: string;

    constructor(langs = 'jpn+eng') {
        this.langs = langs;
    }

    get started(): boolean {
        return this.engine?.started === true;
    }

    async start(): Promise<void> {
        if (this.engine) return;
        const engine = new OcrEngine(this.langs, undefined, {
            pageSegMode: REGISTER_PAGE_SEG_MODE,
        });
        await engine.start();
        this.engine = engine;
    }

    /** Safe to call more than once, and safe to call on a run that never started. */
    async terminate(): Promise<void> {
        const engine = this.engine;
        this.engine = null;
        if (engine) await engine.terminate();
    }

    private require(): OcrEngine {
        if (!this.engine) throw new Error('文字認識エンジンが起動していません。');
        return this.engine;
    }

    /**
     * Recognise several fields of one page in a single pass.
     *
     * The rectangles are in upright page space. The region rendered is their
     * union plus a little air; the words come back in canvas pixels and are
     * mapped to upright points before being assigned, so this never has to
     * think about the page's rotation -- the canvas is already upright.
     */
    async recogniseFields(
        page: pdfjsLib.PDFPageProxy,
        rects: Partial<Record<RegisterFieldName, SelectionRect>>,
        options: { dpi?: number; rotation?: number } = {},
    ): Promise<RegionRecognition> {
        const entries = Object.entries(rects) as [RegisterFieldName, SelectionRect][];
        if (entries.length === 0) {
            return { fields: {}, unplaced: [], pixels: 0, ms: 0, calls: 0 };
        }

        const union = unionRect(entries.map(([, rect]) => rect));
        if (!union) return { fields: {}, unplaced: [], pixels: 0, ms: 0, calls: 0 };

        const started = performance.now();
        const region = await renderRegion(page, union, {
            dpi: options.dpi ?? REGISTER_DPI,
            rotation: options.rotation ?? 0,
        });
        let output;
        try {
            output = await this.require().recognisePage(region.canvas);
        } finally {
            releaseRegion(region.canvas);
        }

        const placed = new Map<RegisterFieldName, OcrWord[]>(entries.map(([name]) => [name, []]));
        const unplaced: string[] = [];
        for (const word of output.words) {
            // Canvas pixels -> upright points. The canvas was rendered upright,
            // so this is a shift and a scale with no rotation in it.
            const x = region.rect.left + ((word.bbox.x0 + word.bbox.x1) / 2) / region.scale;
            const y = region.rect.top + ((word.bbox.y0 + word.bbox.y1) / 2) / region.scale;
            const hit = entries.find(([, rect]) =>
                x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
            if (hit) placed.get(hit[0])!.push(word);
            else unplaced.push(word.text);
        }

        const fields: Partial<Record<RegisterFieldName, RecognisedField>> = {};
        for (const [name, words] of placed) {
            fields[name] = {
                rawText: wordsToRawText(words),
                wordCount: words.length,
                score: words.length
                    ? Math.round(words.reduce((sum, w) => sum + w.confidence, 0) / words.length)
                    : null,
            };
        }

        return {
            fields, unplaced,
            pixels: region.pixels,
            ms: Math.round(performance.now() - started),
            calls: 1,
        };
    }

    /**
     * Recognise each field on its own.
     *
     * Offered only where a person has asked for it after seeing the union
     * result. It is not a fallback this module chooses: there is no measured
     * rule for when one is better, and switching on a guess would change the
     * reading of a page for reasons nobody could inspect.
     */
    async recogniseFieldsSeparately(
        page: pdfjsLib.PDFPageProxy,
        rects: Partial<Record<RegisterFieldName, SelectionRect>>,
        options: { dpi?: number } = {},
    ): Promise<RegionRecognition> {
        const entries = Object.entries(rects) as [RegisterFieldName, SelectionRect][];
        const fields: Partial<Record<RegisterFieldName, RecognisedField>> = {};
        const started = performance.now();
        let pixels = 0;
        let calls = 0;

        for (const [name, rect] of entries) {
            const region = await renderRegion(page, rect, { dpi: options.dpi ?? REGISTER_DPI });
            pixels += region.pixels;
            let output;
            try {
                output = await this.require().recognisePage(region.canvas);
                calls += 1;
            } finally {
                releaseRegion(region.canvas);
            }
            fields[name] = {
                rawText: wordsToRawText(output.words),
                wordCount: output.words.length,
                score: output.meanConfidence,
            };
        }

        return { fields, unplaced: [], pixels, ms: Math.round(performance.now() - started), calls };
    }
}

/**
 * Recognised words, grouped into lines and joined.
 *
 * This is the extraction boundary for a recognised field: what comes out here
 * is the field's raw text, and nothing downstream normalises it further. The
 * grouping matters because the label sits on its own line above the value, and
 * a single flat string throws away the only thing that separates them.
 */
export function wordsToRawText(words: OcrWord[]): string {
    const ordered = [...words].sort((a, b) => {
        const ay = (a.bbox.y0 + a.bbox.y1) / 2;
        const by = (b.bbox.y0 + b.bbox.y1) / 2;
        return Math.abs(ay - by) > 6 ? ay - by : a.bbox.x0 - b.bbox.x0;
    });

    const lines: OcrWord[][] = [];
    for (const word of ordered) {
        const line = lines[lines.length - 1];
        const last = line?.[line.length - 1];
        const shared = last ? Math.min(last.bbox.y1, word.bbox.y1) - Math.max(last.bbox.y0, word.bbox.y0) : 0;
        const smaller = last ? Math.min(last.bbox.y1 - last.bbox.y0, word.bbox.y1 - word.bbox.y0) : 0;
        if (line && smaller > 0 && shared / smaller >= 0.5) line.push(word);
        else lines.push([word]);
    }
    return lines
        .map((line) => line.map((word) => word.text).join(' ').replace(/\s+/gu, ' ').trim())
        .filter((line) => line !== '')
        .join('\n');
}
