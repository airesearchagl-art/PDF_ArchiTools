/**
 * Phase 1 architecture spike — searchable PDF pipeline.
 *
 * This is a SPIKE, not the M1 implementation. It exists to prove the adopted
 * architecture end to end in a real browser before any of it is built properly
 * into src/. It is deliberately one file with no error recovery, no UI, and no
 * abstraction beyond what the proof needs.
 *
 * Pipeline:
 *   PDF -> per-page classify (text-native vs scanned)
 *       -> scanned pages: render -> OCR -> word boxes
 *       -> boxes mapped to PDF user space via viewport.convertToPdfPoint
 *       -> invisible text (Tr 3) appended to the ORIGINAL page with pdf-lib
 *       -> save
 *
 * Nothing leaves the browser. All OCR assets are served from this origin.
 */
import * as pdfjsLib from 'pdfjs-dist';
import {
  PDFDocument,
  pushGraphicsState, popGraphicsState,
  beginText, endText, showText, setFontAndSize, setTextMatrix,
  setCharacterSqueeze, setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createWorker } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

/** Self-hosted OCR assets. No CDN, no third-party request. */
const TESS_OPTS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/',
  langPath: '/tessdata',
  gzip: false,
  workerBlobURL: false,
};

const OCR_DPI = 150;
/** OCRmyPDF insets by 12.5% and only counts text in the interior region. */
const MARGIN_RATIO = 0.125;

/**
 * Decide whether a page already carries usable text.
 *
 * Deliberately margin-aware: a scanned page often still has a page number or a
 * header stamped on it, and counting that as "this page has text" would wrongly
 * suppress OCR for the whole sheet.
 */
export async function classifyPage(page) {
  const [x0, y0, x1, y1] = page.view;
  const w = x1 - x0, h = y1 - y0;
  const ix0 = x0 + w * MARGIN_RATIO, ix1 = x1 - w * MARGIN_RATIO;
  const iy0 = y0 + h * MARGIN_RATIO, iy1 = y1 - h * MARGIN_RATIO;

  const tc = await page.getTextContent();
  let allChars = 0, interiorChars = 0;
  for (const item of tc.items) {
    const n = (item.str || '').replace(/\s/g, '').length;
    if (!n) continue;
    allChars += n;
    // Intersect the item's BOX with the interior region, not just its origin.
    // A body line can start left of the margin inset and still cross the whole
    // page; testing only the start point misreads that as marginal text.
    const bx0 = item.transform[4];
    const by0 = item.transform[5];
    const bx1 = bx0 + (item.width ?? 0);
    const by1 = by0 + (item.height ?? 0);
    const intersects = bx1 >= ix0 && bx0 <= ix1 && by1 >= iy0 && by0 <= iy1;
    if (intersects) interiorChars += n;
  }

  const ops = await page.getOperatorList();
  const O = pdfjsLib.OPS;
  let imageOps = 0;
  for (const fn of ops.fnArray) {
    if (fn === O.paintImageXObject || fn === O.paintJpegXObject || fn === O.paintInlineImageXObject) imageOps++;
  }

  return {
    kind: interiorChars > 0 ? 'text-native' : 'scanned',
    allChars, interiorChars, imageOps,
  };
}

/** Render a page to a canvas at OCR_DPI. */
async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport };
}

/**
 * Optional cleaning of the OCR INPUT ONLY.
 *
 * OCRmyPDF separates --clean from --clean-final for a reason: the image the OCR
 * engine reads and the image the user keeps are different artifacts. This only
 * ever touches the copy handed to Tesseract; the output PDF still shows the
 * untouched original page.
 */
function cleanForOcr(canvas, contrast = 1.4) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let v = (gray - 128) * contrast + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Flatten tesseract's block tree to word-level boxes. */
function wordsFromBlocks(blocks) {
  const out = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const t = (word.text || '').trim();
          if (t) out.push({ text: t, bbox: word.bbox, confidence: word.confidence });
        }
      }
    }
  }
  return out;
}

/**
 * Place OCR words onto a page as invisible text.
 *
 * Boxes arrive in canvas pixels. convertToPdfPoint is the exact inverse of the
 * render transform, so it is correct under page rotation and a non-zero-origin
 * MediaBox, where the naive pageHeight - y formula is not.
 */
function drawInvisibleWords(page, fontRef, font, words, viewport) {
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let placed = 0;

  for (const { text, bbox } of words) {
    const [px0, py0, px1, py1] = [bbox.x0, bbox.y0, bbox.x1, bbox.y1];
    // Bottom-left and top-right of the box, in PDF user space.
    const [ux0, uy1] = viewport.convertToPdfPoint(px0, py0);
    const [ux1, uy0] = viewport.convertToPdfPoint(px1, py1);
    const boxW = Math.abs(ux1 - ux0);
    const boxH = Math.abs(uy1 - uy0);
    if (boxW <= 0 || boxH <= 0) continue;

    // Font size from the box height; width then corrected with Tz so the
    // invisible run spans exactly the box the OCR engine reported.
    const size = boxH;
    let encoded;
    try { encoded = font.encodeText(text); } catch { continue; }
    const natural = font.widthOfTextAtSize(text, size);
    if (!(natural > 0)) continue;
    const squeeze = (boxW / natural) * 100;

    ops.push(
      setFontAndSize(fontRef, size),
      setCharacterSqueeze(squeeze),
      setTextMatrix(1, 0, 0, 1, Math.min(ux0, ux1), Math.min(uy0, uy1)),
      showText(encoded),
    );
    placed++;
  }

  ops.push(endText(), popGraphicsState());
  if (placed > 0) page.pushOperators(...ops);
  return placed;
}

/**
 * Run the whole pipeline over one PDF.
 *
 * @param {ArrayBuffer} pdfBytes
 * @param {object} opts  { langs, clean, onProgress, shouldCancel }
 */
export async function makeSearchablePdf(pdfBytes, opts = {}) {
  const {
    langs = 'jpn+eng',
    clean = true,
    onProgress = () => {},
    shouldCancel = () => false,
  } = opts;

  const t0 = performance.now();
  const report = { pages: [], langs, cancelled: false, timings: {} };

  // pdf.js reads a copy; pdf-lib gets its own, because pdf.js detaches buffers.
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes.slice(0)) }).promise;
  const out = await PDFDocument.load(pdfBytes.slice(0));
  out.registerFontkit(fontkit);

  const fontBytes = await (await fetch('/spike/assets/MPLUS1p-Regular.ttf')).arrayBuffer();
  // subset:true was measured here but is not production-safe evidence by itself, and the distinction is measured, not
  // assumed. @pdf-lib/fontkit@1.1.1 has a known CJK subsetting bug; the spike
  // confirmed it damages VISIBLE Japanese glyphs (1.8% of pixels differ against
  // an unsubsetted embed). But it leaves the cmap and advance widths intact, so
  // text still round-trips exactly -- and a Tr 3 layer never draws an outline.
  // M1 uses subset:false. The known subset:true path must not be used for visible CJK.
  const font = await out.embedFont(fontBytes, { subset: false });

  let worker = null;
  const ensureWorker = async () => {
    if (worker) return worker;
    const tw = performance.now();
    onProgress({ phase: 'ocr-init', detail: 'loading OCR engine' });
    worker = await createWorker(langs, 1, {
      ...TESS_OPTS,
      logger: (m) => onProgress({ phase: 'ocr', status: m.status, progress: m.progress }),
    });
    report.timings.ocrInitMs = Math.round(performance.now() - tw);
    return worker;
  };

  const scale = OCR_DPI / 72;
  const outPages = out.getPages();

  for (let i = 1; i <= doc.numPages; i++) {
    if (shouldCancel()) { report.cancelled = true; break; }

    const page = await doc.getPage(i);
    const cls = await classifyPage(page);
    const entry = { page: i, ...cls, ocrWords: 0, placed: 0, ms: 0 };
    const tp = performance.now();

    if (cls.kind === 'scanned') {
      const { canvas, viewport } = await renderPage(page, scale);
      if (clean) cleanForOcr(canvas);

      const w = await ensureWorker();
      onProgress({ phase: 'ocr-page', page: i, of: doc.numPages });
      const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });

      const words = wordsFromBlocks(data.blocks);
      entry.ocrWords = words.length;
      entry.text = (data.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      entry.meanConfidence = words.length
        ? Math.round(words.reduce((a, b) => a + (b.confidence ?? 0), 0) / words.length)
        : null;

      const fontRef = outPages[i - 1].node.newFontDictionary('OcrF', font.ref);
      entry.placed = drawInvisibleWords(outPages[i - 1], fontRef, font, words, viewport);

      canvas.width = 0; canvas.height = 0;   // release the backing store
    }

    page.cleanup();
    entry.ms = Math.round(performance.now() - tp);
    report.pages.push(entry);
  }

  if (worker) await worker.terminate();

  const bytes = await out.save();
  report.timings.totalMs = Math.round(performance.now() - t0);
  report.inputBytes = pdfBytes.byteLength;
  report.outputBytes = bytes.length;
  return { bytes, report };
}

/** Read back the text of a generated PDF, to prove it is searchable. */
export async function extractText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str).join(''));
  }
  return pages;
}
