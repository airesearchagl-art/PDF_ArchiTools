/**
 * Saving annotations without destroying the document they are on.
 *
 * The old path captured each page with html2canvas and rebuilt the file out of
 * JPEGs. Everything the source carried — its searchable text, its vector
 * geometry, its images, its existing annotations, its form fields and their
 * values, its metadata, its rotation, its page boxes, an OCR layer's invisible
 * text — was gone from the output, and the result looked fine.
 *
 * So the source document is the thing being written to, not the thing being
 * replaced. pdf-lib loads it, the annotations go on as drawing operators, and
 * the one thing operators cannot express — a pixel eraser, which subtracts
 * pixels a content stream has no way to un-draw — goes into a bounded
 * transparent image covering only the marks it touches.
 *
 * Fail closed and fail whole: anything unwritable stops the save with a reason,
 * before a single byte is produced. A partial file that looks complete is the
 * worst outcome available here, because nothing downstream can tell it apart
 * from a good one.
 */
import fontkit from '@pdf-lib/fontkit';
import type {
    PageSnapshot, SaveResult, RasteredTextReport, SaveAnnotation,
} from './types';
import { AnnotatorSaveError } from './types';
import { assessSource } from './source-assessment';
import { prepareSaveJob } from './job';
import { planComposition, runBounds, checkRasterBudget } from './composition';
import { renderAnnotations, releaseCanvas } from './render';
import { loadAnnotationFont, unsupportedGlyphs } from './font';
import { pageMapper, drawObjectVector, placeDisplayImage, embedFragment } from './writer';

export { MAX_RASTER_PIXELS } from './composition';
export { AnnotatorSaveError } from './types';
export type {
    SaveResult, PageSnapshot, LayerSnapshot, SaveAnnotation, SaveProblem, SaveErrorCode,
} from './types';

/** The resolution a raster fragment is drawn at, in pixels per point. */
const FRAGMENT_SCALE = 2;

/** Margin around a fragment, so a round cap at the edge is not clipped. */
const FRAGMENT_PAD = 4;

export interface SaveOptions {
    /** The source PDF, exactly as uploaded. Never modified. */
    sourceBytes: Uint8Array;
    /** Visible layers only, bottom first, for the pages that have annotations. */
    pages: PageSnapshot[];
}

/**
 * Produce the annotated PDF.
 *
 * Throws `AnnotatorSaveError` — never returns a partial document.
 */
export async function saveAnnotatedPdf({ sourceBytes, pages }: SaveOptions): Promise<SaveResult> {
    const started = performance.now();

    // Before anything else, and before a single operator: a document that
    // cannot be honoured is refused rather than written badly.
    const verdict = await assessSource(sourceBytes);
    if (!verdict.supported || !verdict.doc) {
        throw new AnnotatorSaveError(verdict.problems);
    }
    const doc = verdict.doc;
    const job = prepareSaveJob(pages, doc.getPageCount());

    // Nothing to add. Returning a copy of the source rather than re-serialising
    // it means a no-op save cannot perturb the document at all — but only after
    // the support boundary above, which a no-op does not get to skip.
    if (job.annotationCount === 0) {
        return {
            bytes: sourceBytes.slice(),
            fontSubstituted: false,
            rasteredTextObjects: [],
            rasterFragments: 0,
            maxRasterPixels: 0,
            visibleLayerCount: job.visibleLayerCount,
            annotationCount: 0,
            unchangedCopy: true,
            ms: Math.round(performance.now() - started),
        };
    }

    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await loadAnnotationFont(), { subset: true });
    const docPages = doc.getPages();

    const rasteredTextObjects: RasteredTextReport[] = [];
    let rasterFragments = 0;
    let maxRasterPixels = 0;
    let wroteVectorText = false;

    for (let i = 0; i < docPages.length; i++) {
        const layers = job.layersForPage(i + 1);
        if (layers.length === 0) continue;
        const page = docPages[i];
        const map = pageMapper(page);

        // Layers are planned one at a time and never flattened together.
        //
        // Each layer is its own canvas in the app, and `destination-out` only
        // reaches the canvas it is drawn on. Flattening the visible layers into
        // one list before planning would hand an upper layer's pixel eraser the
        // power to cut holes in the layers beneath it — marks the user can see
        // on screen would be missing from the file.
        //
        // Layers are emitted bottom-first, so a later visible layer lands above
        // an earlier one in the PDF exactly as it does on screen.
        for (const layer of layers) {
            if (layer.objects.length === 0) continue;

            // A character the embedded font cannot draw is the same kind of
            // problem as a pixel eraser: not expressible as operators. So it
            // takes the same route — that one text object goes to pixels — and
            // the loss of searchability is reported rather than hidden.
            const glyphFallback = (obj: SaveAnnotation): boolean => {
                if (obj.type !== 'text') return false;
                const missing = unsupportedGlyphs(font, obj.text);
                if (missing.length === 0) return false;
                rasteredTextObjects.push({
                    page: i + 1, layerId: layer.layerId, objectId: obj.id, missing,
                });
                return true;
            };

            const plan = planComposition(layer.objects, { mustRaster: glyphFallback });

            for (const run of plan.runs) {
                if (run.kind === 'vector') {
                    for (const obj of run.objects) {
                        drawObjectVector(page, obj, map, font);
                        if (obj.type === 'text' || obj.type === 'measure') wroteVectorText = true;
                    }
                    continue;
                }

                const bounds = runBounds(run.objects, FRAGMENT_PAD);
                if (!bounds) continue;
                // Arithmetic first. A fragment that would be too large is
                // refused before anything is allocated, which is the point of
                // the check: allocating and then measuring means the allocation
                // being guarded against has already happened.
                const budget = checkRasterBudget(bounds, FRAGMENT_SCALE, {
                    page: i + 1, layerId: layer.layerId,
                });
                maxRasterPixels = Math.max(maxRasterPixels, budget.pixels);

                const canvas = document.createElement('canvas');
                canvas.width = budget.width;
                canvas.height = budget.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) throw new Error('注釈の画像化に失敗しました。');
                renderAnnotations(ctx, run.objects, {
                    scale: FRAGMENT_SCALE,
                    offset: { x: bounds.x, y: bounds.y },
                });
                const image = await embedFragment(doc, canvas);
                releaseCanvas(canvas);
                placeDisplayImage(page, image, map, bounds);
                rasterFragments += 1;
            }
        }
    }

    // Only now, with every page written, is anything produced.
    const bytes = await doc.save({ useObjectStreams: false });

    return {
        bytes,
        fontSubstituted: wroteVectorText,
        rasteredTextObjects,
        rasterFragments,
        maxRasterPixels,
        visibleLayerCount: job.visibleLayerCount,
        annotationCount: job.annotationCount,
        unchangedCopy: false,
        ms: Math.round(performance.now() - started),
    };
}

/** `drawing.pdf` -> `drawing_annotated.pdf`. The original is never overwritten. */
export function annotatedFilename(sourceName: string): string {
    const trimmed = (sourceName || 'document.pdf').trim();
    const dot = trimmed.lastIndexOf('.');
    const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
    return `${stem}_annotated.pdf`;
}
