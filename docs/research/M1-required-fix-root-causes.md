# M1 OCR Architecture — Required Fix root causes

Records why the previous evidence run was BLOCKED, what actually caused each
failure, and what the harness now does differently. Research scope only; no
production `src/` file is touched.

| | |
|---|---|
| Branch | `research/textifier-ocr-architecture` |
| Base commit for this fix | `684ed57b29c55b31845b6903dd36fc84bb013f8e` |
| Font policy | `subset: false`, unchanged and now asserted by the spike |

---

## 1. The harness destroyed its own root cause

Both runners collapsed a thrown value into `String(error?.stack || error)`.

That is why the only failure ever committed to this repository reads:

```json
"fatalError": "Error\n    at BaseExceptionClosure (.../pdfjs-dist.js:334:30)\n    at .../pdfjs-dist.js:337:3"
```

PDF.js exceptions derive from `BaseException`, which puts the reason on
`message` and often on `details`. The stack bottoms out in the closure that
constructs those classes, so the saved string names neither the operation nor
the reason. **The underlying cause of that particular CI failure is not
recoverable from the evidence, because the evidence discarded it.**

Worth stating plainly: the string `Invalid \`workerSrc\` type` appears **nowhere**
in this repository's recorded evidence. Every committed version of
`spike/out/paddleocr-comparison.json` was checked; there is exactly one, and it
carries the `BaseExceptionClosure` stack above. `@paddleocr/paddleocr-js` was
also checked and never assigns `GlobalWorkerOptions.workerSrc` at all. That
error message could not be confirmed against any artifact in the repo, so it is
not treated as an established fact here.

**Fix:** `spike/evidence.js` `describeError()` captures `name`, `message`,
`details`, `stack`, `stage`, any other own properties, and the `cause` chain.
Every call site now records a stage, so a failure says where it happened.

The fix paid for itself immediately: the very next run surfaced a `cause` chain
naming `ProtocolError: Runtime.callFunctionOn timed out` — see §3.

---

## 2. Why `original_spike_exit = 1` while the committed artifact showed 13/13

These two facts were not in conflict; the artifact was simply not from that run.

`spike/out/spike-results.json` is **byte-identical** between `246393a` and
`684ed57` (blob `f1457f7eea1953247394a5f7dddb9bffede46dbd` in both). The CI run
at `684ed57` never wrote it.

The mechanism:

1. The old driver wrote its results file only at the very end, after the
   acceptance block.
2. A fixture that failed was stored as `{ error }`, but the first acceptance
   check read `tn.report.pages.every(...)` with no guard. On a failed
   text-native fixture that is a `TypeError` on `undefined`.
3. The driver died there, before `fs.writeFileSync`, and exited non-zero.
4. The stale file from the previous commit — produced in the `subset: true` era —
   survived on disk and was re-committed by the workflow's `git add -A`.

So the committed "13/13 PASS" was never evidence for `subset: false`.

**Fix:** `spike/run-spike.mjs` now overwrites the results file with an
`in-progress` marker *before* the server starts, wraps everything in
try/catch/finally, reads every check defensively, records `__driverError` and a
`__gate` verdict, and always writes the file before exiting with the gate's
result.

---

## 3. Why the PaddleOCR comparison could not run

Four separate problems, each hidden behind the previous one. All are Vite/harness
integration issues; none is a defect in PaddleOCR.js itself.

**3.1 Vite's dependency pre-bundler drops the worker asset.** PaddleOCR.js ships
its Web Worker as a sibling file, `dist/assets/worker-entry-C9UNuyOJ.js`. The
optimizer rewrites the package entry into `node_modules/.vite/deps/` but does not
carry that asset across, so the worker URL 404s and the library reports only
`OCR worker failed.` Vite itself says so in the server log:

> The file does not exist at ".../node_modules/.vite/deps/assets/worker-entry-C9UNuyOJ.js"
> which is in the optimize deps directory. Try adding it to `optimizeDeps.exclude`.

**3.2 Puppeteer's `protocolTimeout` fires before the hard wall.** PaddleOCR's
WASM initialisation blocks the page's main thread long enough that CDP calls go
unanswered, and puppeteer's 180 s default kills `waitForFunction` before the
600 s hard wall is reached. Two competing limits; the shorter one won and told us
nothing. Set to `0` so the hard wall is the single bound.

**3.3 Excluding the package broke CJS interop.** All four of PaddleOCR's runtime
dependencies (`clipper-lib`, `@techstark/opencv-js`, `js-yaml`,
`onnxruntime-web`) are CommonJS. Excluding the parent from pre-bundling also
skips the CJS-to-ESM interop they depend on, so the page died at load with
`The requested module '/node_modules/clipper-lib/clipper.js' does not provide an
export named 'default'`. Fixed by excluding only the package and listing its
dependencies in `optimizeDeps.include`.

**3.4 The stall was undiagnosable.** When the page never finished, the artifact
said only "hard wall exceeded". The page now publishes `__PADDLE_STAGE__`, a
timestamped `__PADDLE_LOG__`, and `__PADDLE_PARTIAL__` as soon as the Tesseract
half completes; the driver recovers all three on a stall, racing the probe
against a 15 s timeout because a blocked main thread cannot answer at all.

All of this is configured **in the research driver**, via Vite's Node API.
`vite.config.ts` is untouched.

---

## 4. Two evidence defects that made past runs untrustworthy

**4.1 A semantic failure could report success.** The comparison driver ended in
`setTimeout(() => process.exit(0), 500)` inside `finally`, so a run whose own
artifact recorded a fatal error still exited 0 — which is exactly how
`paddle_compare_exit = 0` came to sit next to a failed comparison. Both runners
now compute an explicit gate and exit with its verdict. Failure evidence is still
written first, every time.

**4.2 External network traffic was measured wrongly, in both directions.**

Requests were classified as external by `!url.startsWith('http://127.0.0.1:5198')`.
That counted `data:` URIs — how bundlers inline WASM — as external traffic, and
because the whole URL was kept as evidence, one artifact reached **9.7 MB** of
inlined base64. The same artifact is now 14 KB.

The more serious half is the opposite error: puppeteer's page-level `response`
event does **not** see traffic started inside a Web Worker, and PaddleOCR loads
its models from inside its worker. Every previous run therefore recorded
`externalRequestCount: 0` while real downloads were happening. The driver now
attaches a CDP session to worker targets.

With the corrected measurement:

| Engine | External requests | Bytes | Hosts |
|---|---|---|---|
| Tesseract.js | **0** | 0 | — (all assets self-hosted) |
| PaddleOCR.js | **4** | **26,292,987** | `paddle-model-ecology.bj.bcebos.com`, `cdn.jsdelivr.net` |

PaddleOCR.js fetches `PP-OCRv5_mobile_det_onnx_infer.tar` (4.84 MB) and
`PP-OCRv5_mobile_rec_onnx_infer.tar` (16.7 MB) from Baidu object storage, plus
the ONNX Runtime WASM (4.73 MB) from jsDelivr, at run time. This is a material
input to the engine decision and is recorded here, not judged.

---

## 5. Result after the fix

Same synthetic fixtures, real headless Chrome, bounded runtime.

**Searchable-PDF spike — 14/14 checks, exit 0**, with `subset: false` throughout.
Text-native pages are classified and skipped without the OCR engine ever
initialising; Japanese, English, mixed and 3-page scanned documents all produce
searchable, selectable output; appearance is unchanged at **0 differing pixels
out of 1,127,859**; cancellation stops after 1 of 3 pages. A fourteenth check was
added that reads `spike/pipeline.js` and fails if the font policy is not
`subset: false`, so a silent revert cannot pass.

The cost of `subset: false` is visible and should be carried into the M1
decision: output grew from 32,520 to 1,097,296 bytes on `scanned-ja-en.pdf`,
because the full 1.68 MB font is embedded rather than subset.

**Engine comparison — gate PASS, exit 0.**

| | Tesseract.js 7.0.0 | PaddleOCR.js 0.4.2 |
|---|---|---|
| Init | 148 ms | 4,319 ms |
| Japanese | 308 ms, 27 words, score 89 | 1,764 ms, 4 items, score 0.964 |
| English | 119 ms, 15 words, score 91 | 1,544 ms, 4 items, score 0.989 |
| Mixed ja+en | 118 ms, 20 words, score 93 | 1,517 ms, 4 items, score 0.963 |
| Expected tokens found | 3/3 | 3/3 |
| Geometry | word-level bbox, normalizable | line-level polygon + bbox, normalizable |
| Lifecycle | `terminate()`, no cancel API | `dispose()`, no cancel API, worker mode |
| External network | 0 | 4 requests, 26.3 MB |

Both engines read all three fixtures correctly. PaddleOCR scores higher and
returns line polygons; Tesseract is an order of magnitude faster, returns the
word-level boxes an invisible text layer wants, and needs no network. Neither
exposes an in-flight cancel API.

## 6. Known limits of this evidence

- Produced locally on Windows, not in CI. The CI-specific failure at `684ed57`
  cannot be reproduced because the evidence that would identify it was discarded
  by the old harness (§1).
- Fixtures are clean synthetic renders. Nothing here says how either engine
  behaves on a real, noisy architectural drawing.
- PaddleOCR's 4-item, line-level output was not evaluated for suitability as an
  invisible text layer; only that coordinates are present and normalizable.
