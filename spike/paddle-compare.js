import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { describeError } from './evidence.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

/**
 * Where execution currently is, so a thrown error can say which step failed.
 * The previous version saved only `String(error.stack)`, which for a PDF.js
 * BaseException bottoms out at `BaseExceptionClosure` and names neither the
 * failing stage nor the actual reason.
 */
let currentStage = 'startup';
// Published on window so the driver can still say WHERE a run got stuck when the
// page never finishes. A bare "hard wall exceeded" is not a diagnosis.
window.__PADDLE_LOG__ = [];
const setStage = (stage) => {
  currentStage = stage;
  window.__PADDLE_STAGE__ = stage;
  window.__PADDLE_LOG__.push({ t: Math.round(performance.now()), stage });
  return stage;
};
setStage('startup');

const TESS_OPTS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/',
  langPath: '/tessdata',
  gzip: false,
  workerBlobURL: false,
};

const PADDLE_INIT_TIMEOUT_MS = 90_000;
const PADDLE_PREDICT_TIMEOUT_MS = 60_000;

const FIXTURES = [
  { name: 'scanned-ja.pdf', expected: ['建築', '図面'] },
  { name: 'scanned-en.pdf', expected: ['Architectural', 'Drawing'] },
  { name: 'scanned-ja-en.pdf', expected: ['建築', 'Architectural'] },
];

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function flattenTesseractWords(blocks) {
  const out = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          if (!word?.text?.trim()) continue;
          out.push({
            text: word.text.trim(),
            score: word.confidence ?? null,
            box: word.bbox ? {
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
            } : null,
          });
        }
      }
    }
  }
  return out;
}

function polyPoints(poly) {
  if (!Array.isArray(poly)) return [];
  if (poly.length && Array.isArray(poly[0])) {
    return poly.map((p) => ({ x: Number(p[0]), y: Number(p[1]) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  if (poly.length && typeof poly[0] === 'object') {
    return poly.map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  if (poly.length >= 8 && typeof poly[0] === 'number') {
    const out = [];
    for (let i = 0; i + 1 < poly.length; i += 2) out.push({ x: Number(poly[i]), y: Number(poly[i + 1]) });
    return out.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  return [];
}

function normalizePaddleItems(items) {
  return (items ?? []).map((item) => {
    const points = polyPoints(item.poly);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const box = points.length ? {
      x0: Math.min(...xs), y0: Math.min(...ys),
      x1: Math.max(...xs), y1: Math.max(...ys),
    } : null;
    return {
      text: item.text ?? '',
      score: item.score ?? null,
      poly: points,
      box,
    };
  });
}

async function renderFixture(name) {
  setStage(`renderFixture:fetch:${name}`);
  const res = await fetch(`/spike/fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture fetch failed ${name}: ${res.status} ${res.statusText}`);
  const bytes = await res.arrayBuffer();

  setStage(`renderFixture:pdfjs-getDocument:${name}`);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;

  setStage(`renderFixture:getPage:${name}`);
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 150 / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  setStage(`renderFixture:render:${name}`);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return { canvas, viewport };
}

function quality(text, expected) {
  const joined = text.replace(/\s+/g, ' ').trim();
  return {
    containsExpected: expected.every((token) => joined.includes(token)),
    expected,
    sample: joined.slice(0, 500),
  };
}

async function runTesseract(rendered) {
  const started = performance.now();
  // Contained on purpose: if Tesseract fails, the Paddle half of the comparison
  // is still worth collecting, and the gate can see exactly which engine broke.
  try {
    setStage('tesseract:createWorker');
    const worker = await createWorker('jpn+eng', 1, { ...TESS_OPTS });
    const initMs = Math.round(performance.now() - started);
    const outputs = {};
    for (const fixture of FIXTURES) {
      setStage(`tesseract:recognize:${fixture.name}`);
      const t0 = performance.now();
      const { data } = await worker.recognize(rendered[fixture.name].canvas, {}, { blocks: true, text: true });
      const words = flattenTesseractWords(data.blocks);
      outputs[fixture.name] = {
        ms: Math.round(performance.now() - t0),
        text: data.text ?? '',
        wordCount: words.length,
        meanScore: words.length ? Math.round(words.reduce((a, b) => a + (b.score ?? 0), 0) / words.length) : null,
        boxesAvailable: words.length > 0 && words.every((w) => w.box && Object.values(w.box).every(Number.isFinite)),
        coordinateNormalizable: words.length > 0 && words.every((w) => w.box && Object.values(w.box).every(Number.isFinite)),
        quality: quality(data.text ?? '', fixture.expected),
      };
    }
    setStage('tesseract:terminate');
    await worker.terminate();
    return {
      engine: 'tesseract.js',
      version: '7.0.0',
      initMs,
      lifecycle: { terminate: true, explicitCancelApi: false, cancellationMode: 'terminate worker / page boundary' },
      outputs,
    };
  } catch (error) {
    return {
      engine: 'tesseract.js',
      version: '7.0.0',
      error: describeError(error, currentStage),
      initAttemptMs: Math.round(performance.now() - started),
    };
  }
}

async function runPaddle(rendered) {
  const started = performance.now();
  let ocr;
  try {
    setStage('paddle:create');
    ocr = await withTimeout(PaddleOCR.create({
      lang: 'japan',
      ocrVersion: 'PP-OCRv5',
      worker: true,
      ortOptions: {
        backend: 'wasm',
        numThreads: 1,
        simd: true,
      },
    }), PADDLE_INIT_TIMEOUT_MS, 'PaddleOCR.create');
    const initMs = Math.round(performance.now() - started);
    const summary = typeof ocr.getInitializationSummary === 'function' ? ocr.getInitializationSummary() : null;
    const outputs = {};
    for (const fixture of FIXTURES) {
      setStage(`paddle:predict:${fixture.name}`);
      const t0 = performance.now();
      const prediction = await withTimeout(
        ocr.predict(rendered[fixture.name].canvas),
        PADDLE_PREDICT_TIMEOUT_MS,
        `PaddleOCR.predict ${fixture.name}`,
      );
      const [result] = prediction;
      const items = normalizePaddleItems(result?.items);
      const text = items.map((i) => i.text).join(' ');
      outputs[fixture.name] = {
        ms: Math.round(performance.now() - t0),
        text,
        itemCount: items.length,
        meanScore: items.length ? Number((items.reduce((a, b) => a + Number(b.score ?? 0), 0) / items.length).toFixed(4)) : null,
        polyAvailable: items.length > 0 && items.every((i) => i.poly.length >= 4),
        boxesAvailable: items.length > 0 && items.every((i) => i.box && Object.values(i.box).every(Number.isFinite)),
        coordinateNormalizable: items.length > 0 && items.every((i) => i.box && Object.values(i.box).every(Number.isFinite)),
        metrics: result?.metrics ?? null,
        runtime: result?.runtime ?? null,
        quality: quality(text, fixture.expected),
      };
    }
    const lifecycle = {
      dispose: typeof ocr.dispose === 'function',
      explicitCancelApi: typeof ocr.cancel === 'function' || typeof ocr.abort === 'function',
      cancellationMode: 'no documented cancel/abort API; dispose is lifecycle cleanup, in-flight cancellation not claimed',
      workerMode: true,
    };
    if (typeof ocr.dispose === 'function') await ocr.dispose();
    return {
      engine: '@paddleocr/paddleocr-js',
      version: '0.4.2',
      initMs,
      summary,
      lifecycle,
      outputs,
    };
  } catch (error) {
    const captured = describeError(error, currentStage);
    try { if (ocr && typeof ocr.dispose === 'function') await ocr.dispose(); } catch { /* disposal is best effort */ }
    return {
      engine: '@paddleocr/paddleocr-js',
      version: '0.4.2',
      error: captured,
      initAttemptMs: Math.round(performance.now() - started),
      timeoutPolicy: { initMs: PADDLE_INIT_TIMEOUT_MS, predictMs: PADDLE_PREDICT_TIMEOUT_MS },
    };
  }
}

async function main() {
  const rendered = {};
  for (const fixture of FIXTURES) rendered[fixture.name] = await renderFixture(fixture.name);

  const tesseract = await runTesseract(rendered);
  // Publish immediately: if Paddle then hangs, the Tesseract half is still
  // recoverable evidence rather than being lost with the run.
  window.__PADDLE_PARTIAL__ = { tesseract };

  const paddle = await runPaddle(rendered);

  setStage('teardown');
  for (const item of Object.values(rendered)) {
    item.canvas.width = 0;
    item.canvas.height = 0;
  }

  const paddleOutputs = paddle.outputs ? Object.values(paddle.outputs) : [];
  const tesseractOutputs = tesseract.outputs ? Object.values(tesseract.outputs) : [];
  const result = {
    date: new Date().toISOString(),
    fixtures: FIXTURES.map((f) => f.name),
    tesseract,
    paddle,
    checks: {
      tesseractInitialized: !tesseract.error,
      tesseractAllFixtures: tesseractOutputs.length === FIXTURES.length,
      paddleInitialized: !paddle.error,
      paddleJapanese: Boolean(paddle.outputs?.['scanned-ja.pdf']?.quality?.containsExpected),
      paddleEnglish: Boolean(paddle.outputs?.['scanned-en.pdf']?.quality?.containsExpected),
      paddleMixed: Boolean(paddle.outputs?.['scanned-ja-en.pdf']?.quality?.containsExpected),
      paddlePolys: paddleOutputs.length === FIXTURES.length && paddleOutputs.every((o) => o.polyAvailable),
      paddleCoordinateNormalizable: paddleOutputs.length === FIXTURES.length && paddleOutputs.every((o) => o.coordinateNormalizable),
      paddleWorkerMode: Boolean(paddle.lifecycle?.workerMode),
      paddleDispose: Boolean(paddle.lifecycle?.dispose),
    },
  };

  window.__PADDLE_COMPARE_RESULT__ = result;
  window.__PADDLE_COMPARE_DONE__ = true;
  document.querySelector('#status').textContent = JSON.stringify(result, null, 2);
}

main().catch((error) => {
  // Structured, and attributed to the stage that actually failed. The driver
  // reads this object; it must be diagnosable without re-running the harness.
  const captured = describeError(error, currentStage);
  window.__PADDLE_COMPARE_RESULT__ = { fatalError: captured, stage: currentStage };
  window.__PADDLE_COMPARE_DONE__ = true;
  document.querySelector('#status').textContent = JSON.stringify(captured, null, 2);
});
