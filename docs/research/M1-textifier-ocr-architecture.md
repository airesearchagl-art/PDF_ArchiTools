# M1 — PDF Textifier / OCR: Architecture Adoption Report

**Phase 0 — Existing Code / OSS Research & Architecture Adoption**

| | |
|---|---|
| Repository | `airesearchagl-art/PDF_ArchiTools` |
| Starting `main` SHA | `eeb8404238f7b6821d85dc0ccadc128656be7581` |
| Working branch | `research/textifier-ocr-architecture` |
| Research date | 2026-09-02 |
| Scope | OCR / Text Extraction / Searchable PDF (M1). Word + Excel export are M2 and out of scope. |

---

## 1. Why this report exists

The brief was explicit: **do not start from zero, and do not start OCR implementation before deciding what to reuse.** This document records what was investigated, what was proven to work, and what was decided — with the provenance needed to re-audit any single claim later.

Two classes of evidence appear below and they are deliberately labelled differently:

- **Verified locally** — run on this machine against the real installed dependencies. Reproducible.
- **Researched** — read from a canonical source (repo, LICENSE file, npm registry, official docs), with URL.

Where a research source could not confirm something, it is listed as open rather than filled in.

---

## 2. Baseline state of the repository

Confirmed before any change:

| Check | Result |
|---|---|
| `git remote` | `https://github.com/airesearchagl-art/PDF_ArchiTools.git` |
| `main` HEAD | `eeb8404238f7b6821d85dc0ccadc128656be7581` — **exactly the expected baseline, no drift** |
| Working tree | clean |
| Branches | `main` only (no pre-existing feature branches) |
| `npm ci` | success |
| `npm run lint` | **exit 1 — 31 problems (29 errors, 2 warnings), all pre-existing** |
| `npm run build` | exit 0 — bundle `1,922.74 kB` (gzip `624.65 kB`) |
| `npm test` | **no `test` script exists in `package.json`** |

`npm run lint` is a **baseline failure, not a regression.** All 29 errors are `@typescript-eslint/no-explicit-any`, spread across `PdfSplitMerge.tsx`, `PdfViewer.tsx`, `PdfTools.tsx`, `pdf-processor.ts`, `pdfDiff.ts`, and one in the M1 target file (`PdfTextifier.tsx:183`). Any future claim of "lint passes" must be measured against this, not against zero.

There is no test runner in this project. Nothing in M1 may report "tests pass" until one is actually added.

### 2.1 Current Textifier state

`src/components/PdfTextifier.tsx` is UI-only. The processing path is a mock:

```ts
const handleProcess = () => {
    setIsProcessing(true);
    setTimeout(() => { setIsProcessing(false); setIsComplete(true); }, 2000);   // mock
};
const handleDownload = () => {
    alert('Downloading converted file in ' + options.outputFormat.toUpperCase() + ' format...');   // mock
};
```

Real work already present in the file: PDF load via `pdfjsLib.getDocument`, and a first-page thumbnail via the shared `renderPageToCanvas` helper. The options model (`cleanNoise` / `mode: 'ocr' | 'extract'` / `outputFormat`) is a reasonable shape to keep.

### 2.2 Pre-existing debt found during the scan

**PDF.js worker configuration is inconsistent across the repository, and three files fetch the worker from a public CDN at runtime:**

| File | `workerSrc` |
|---|---|
| `PdfTextifier.tsx:11` | `/pdf.worker.min.mjs` (local) |
| `PdfComparator.tsx:10` | `/pdf.worker.min.mjs` (local) |
| `PdfViewer.tsx:16` | `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs` |
| `PdfSplitMerge.tsx:8` | `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs` |
| `pdf-processor.ts:5` | `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs` |

This conflicts with the project's stated privacy posture (§18 of the brief: browser-local processing). It also means those three tools break offline and depend on a third party's uptime. `public/pdf.worker.min.mjs` is already present and is **version 5.4.449, matching the installed `pdfjs-dist` exactly**, so the local path is known-good.

**This is out of M1 scope as a repository-wide fix**, but M1's own code must use the local worker, and the inconsistency is recorded here so it is not mistaken for something M1 introduced.

---

## 3. What was proven locally before choosing an architecture

Rather than accept the hypothesis in the brief on faith, the four highest-risk assumptions were tested directly against the already-installed `pdf-lib@1.17.1` and `pdfjs-dist@5.4.449`. **No new dependency was installed for any of this, and all scratch files were deleted.**

### 3.1 A true invisible text layer is achievable with pdf-lib alone — VERIFIED

`pdf-lib` does not expose text rendering mode through `drawText()`, but it **does** export the low-level operators from its public entry point. Writing them via `page.pushOperators()` onto a page of an existing document produced this content stream (shown after Flate decompression):

```
q
BT
3 Tr                                    <- TextRenderingMode.Invisible
/SpikeF-7098480789 12 Tf
1 0 0 1 40 700 Tm                       <- text matrix = direct bbox placement
<5A5A4D41524B455220696E76...> Tj        <- hex-encoded string
ET
Q
```

Verified in the same run:

- The original page's drawing operators (`l`, `S`, and the original `Living Room` text) are **still present** — the source page was not rasterized or replaced.
- Re-opening the output with PDF.js and calling `getTextContent()` returned **both** the original text **and** the injected string → the added layer is genuinely searchable.

This closes an open question that the external research could not answer. The pdf-lib research explicitly reported it could not find any confirmation that the `pushOperators(setTextRenderingMode(...))` pattern had been used successfully for **mode 3** specifically, as opposed to the `Outline` / `FillAndOutline` modes documented in issue #763. It works.

**Provenance note for licence hygiene:** this was derived from the PDF specification and pdf-lib's own public API and proven **before** any AGPL-licensed source was read. It is not derived from `scribe.js`. See §6.

### 3.2 Text-native vs scanned page detection needs no new dependency — VERIFIED

A synthetic image-only page was built by embedding a PNG with `pdf-lib`, then both fixtures were probed with PDF.js:

| Fixture | `getTextContent()` items | chars | image-draw ops in `getOperatorList()` |
|---|---|---|---|
| text-native (`public/test-pdfs/v1.pdf`) | 2 | 39 | 0 |
| synthetic scanned (image only) | 0 | 0 | 1 |

The two page classes separate cleanly using only APIs PDF.js already provides.

### 3.3 OCR pixel → PDF point conversion is an existing API, not custom maths — VERIFIED

This was the assumption most likely to cause silent misalignment. PDF.js's `PageViewport` exposes `convertToPdfPoint()`, the exact inverse of the render transform. Round-trip tested at 180 DPI equivalent (`scale 2.5`) across every legal page rotation:

| `/Rotate` | canvas | user (50,500) → px | → back to user | exact |
|---|---|---|---|---|
| 0 | 1000×1500 | (125.0, 250.0) | (50.00, 500.00) | ✅ |
| 90 | 1500×1000 | (1250.0, 125.0) | (50.00, 500.00) | ✅ |
| 180 | 1000×1500 | (875.0, 1250.0) | (50.00, 500.00) | ✅ |
| 270 | 1500×1000 | (250.0, 875.0) | (50.00, 500.00) | ✅ |

Also measured: page rotation and a non-zero-origin MediaBox are both **already baked into `viewport.transform`**, while `getTextContent()` item coordinates stay in unrotated user space. The naive formula `y_pdf = pageHeight − y_px / scale` is therefore **wrong** for rotated pages and offset MediaBoxes; `convertToPdfPoint` is correct for all of them.

Known remaining detail: on a rotated page the text matrix must also carry the rotation, or the invisible run will be axis-aligned while the visible glyphs are not — selection would be offset. This is an implementation detail, not an architectural risk.

### 3.4 Per-word width fitting works — VERIFIED (with a caveat worth recording)

OCRmyPDF aligns invisible text to the scan by horizontally scaling each word to its measured bounding box. The PDF operator for this is `Tz`, exposed by pdf-lib as `setCharacterSqueeze`. Measured:

| `Tz` | measured advance | expected | match |
|---|---|---|---|
| 50 % | 37.35 pt | 37.35 pt | ✅ |
| 150 % | 112.04 pt | 112.04 pt | ✅ |
| 303.07 % | 226.36 pt | 226.36 pt | ✅ |

A first attempt appeared to fail (226.36 pt against a 220 pt target). The cause was **not** `Tz`: pdf-lib measured Helvetica at 72.59 pt and PDF.js measured the same string at 74.69 pt — a factor of 1.0289 disagreement in **standard-font** metrics, worsened in Node because `standardFontDataUrl` was not supplied.

The implementation consequence is concrete: **measure widths with the same font object that gets embedded.** For Japanese we embed a real font and measure it through pdf-lib, which is self-consistent, so the scale factor is exact. The standard-14 metrics gap does not apply to the Japanese path.

---

## 4. Candidate Matrix

| Candidate | OCR | PDF Input | Searchable PDF | Browser | Japanese | License | Decision |
|---|---|---|---|---|---|---|---|
| **pdfjs-dist 5.4.449** (already in repo) | ✗ | ✅ render + text extract | ✗ | ✅ | ✅ (reads) | Apache-2.0 | **reuse_existing** |
| **pdf-lib 1.17.1** (already in repo) | ✗ | ✅ load/preserve | ✅ *(verified §3.1)* | ✅ | ⚠ needs embedded font | MIT | **reuse_existing** |
| **Tesseract.js 7.0.0** | ✅ | ✗ | ✗ | ✅ WASM | ✅ `jpn`/`jpn_vert` | Apache-2.0 | **adopt_dependency** |
| **@pdf-lib/fontkit 1.1.1** | ✗ | ✗ | ✅ enables font embed | ✅ | ⚠ subset bug | MIT | **adopt_dependency** (conditional) |
| **M PLUS 1p / Noto Sans JP** | — | — | ✅ supplies cmap+widths | ✅ | ✅ | OFL-1.1 | **adopt_asset** (choice open) |
| **scribe.js 0.15.0** | ✅ | ✅ | ✅ | ✅ | ⚠ untested | **AGPL-3.0** | **reference_pattern** |
| **scribeocr GUI** | ✅ | ✅ | ✅ | ✅ | ⚠ | **AGPL-3.0** | **reference_pattern** |
| **OCRmyPDF 17.11.0** | ✅ | ✅ | ✅ | ✗ Python | ✅ | MPL-2.0 | **reference_pattern** |
| **tesseract-wasm** | ✅ | ✗ | ✗ | ✅ | ? | BSD-2-Clause | **defer** (fallback engine) |
| **ocrs** | ✅ | ✗ | ✗ | ✅ | ✗ **Latin only** | Apache-2.0 | **reject** |
| **transformers.js + manga-ocr** | ✅ | ✗ | ✗ | ✅ | ✅ strong | Apache-2.0 | **reject** (no bboxes) |
| **PaddleOCR browser/ONNX ports** | ✅ | ✗ | ✗ | ⚠ | ⚠ | Apache-2.0 | **reject** (no maintained JA browser pkg) |
| **jsPDF 3.0.4** (already in repo) | ✗ | ✗ | ✗ | ✅ | ⚠ | MIT | **keep for fixtures only** |
| **Cloud OCR APIs** | ✅ | ✅ | ✅ | ✅ | ✅ | — | **reject** (§18 privacy) |
| **hocr2pdf / hocrjs** | ✗ | — | ✗ | ⚠ | ✗ | various | **reject** (dead / not PDF output) |

---

## 5. Findings that changed the plan

### 5.1 scribe.js is the closest existing implementation — and it is AGPL-3.0

Confirmed four independent ways (raw `LICENSE` text, GitHub's SPDX detector, `package.json`, npm registry metadata) for **both** `scribeocr/scribe.js` and `scribeocr/scribeocr`.

A browser application ships its JavaScript and WASM to the user's machine to execute. That is conveying the work, so AGPL's copyleft would reach PDF ArchiTools itself. **It cannot be adopted as a dependency for a non-AGPL product.**

A commercial-licence option was asserted by a search engine's summary but appears in **no** primary source — not the READMEs, not the README's full commit history, not npm metadata, not the live app. It is recorded as a Human Decision item, not as a fact.

The consolation is real, though: scribe.js's `js/export/pdf/writePdfText.js` emits `3 Tr` — **the same mechanism proven in §3.1**. The most mature browser implementation of this problem independently validates the chosen approach.

### 5.2 There is no maintained, permissively-licensed JS library for the OCR → searchable-PDF step

This was the survey's most decision-relevant result. Tesseract.js's own documentation states it does not support PDF output and points users at scribe.js. Of everything surveyed, only three candidates were browser-native *and* produced a real invisible text layer, and the only mature one is AGPL. The alternatives are a Node-only tool abandoned since ~2015 (`hocr2pdf`), an HTML overlay that emits no PDF (`hocrjs`), and two small single-author hobby projects.

**Therefore the invisible-text-layer writer is genuinely `build_custom`.** That is not a preference; it is what the ecosystem offers. §3.1 shows the cost is low, because pdf-lib already exposes every operator required.

### 5.3 Tesseract.js is the only viable browser OCR engine for Japanese with bounding boxes

Every alternative failed a hard requirement: `ocrs` recognises Latin only; `manga-ocr` via transformers.js is Japanese-strong but recognition-only with **no bounding boxes**; PaddleOCR has no officially maintained browser package covering Japanese. Tesseract.js 7.0.0 (Apache-2.0, released 2025-12-15) provides Japanese, word/line/symbol bboxes, confidence, workers, and a scheduler.

Three engine facts that must shape the implementation:

1. **Since v6, all output except `text` is disabled by default.** Bounding boxes require explicitly passing `output: { blocks: true }`. Omitting it silently yields no coordinates.
2. **For Japanese, Tesseract emits roughly one "word" per character** (issue #413, closed won't-fix — CJK has no inter-word spaces). For an *invisible* layer this is acceptable and arguably better, since each character gets its own box, but the writer must not assume space-delimited words.
3. **There is no mid-recognition cancel** — only `terminate()` on the whole worker. UI cancellation is therefore coarse: abandon the worker and rebuild it.

### 5.4 The Japanese font is the real open risk, not the OCR

`@pdf-lib/fontkit@1.1.1` is a stale fork of fontkit ~1.7.x and **corrupts CJK fonts when `subset: true`** (pdf-lib issue #1232, still open). The reported root cause is two upstream bugs fixed in fontkit 1.8/1.9 but never pulled in:

- **TrueType** — silent partial glyph loss via the `loca` table.
- **CID-keyed CFF** (Noto Sans CJK, Source Han Sans) — the CFF header `offSize` byte is written as `27`, outside the legal range 1–4, so the *entire embedded font is rejected* by FreeType/poppler.

The second bug hits exactly the fonts one would reach for first. Confirmed workarounds: `subset: false` (correct but very large output), pre-subset the font ourselves, or replace `@pdf-lib/fontkit` with the community `pdf-fontkit@1.8.9`.

Font sizes measured from canonical repositories:

| Font | Size | Format | License |
|---|---|---|---|
| **M PLUS 1p Regular** | **1,758,688 B (~1.68 MiB)** — static single weight | TrueType | OFL-1.1 |
| Noto Sans JP | 9,589,900 B (~9.15 MiB) — variable, all weights | TrueType | OFL-1.1 |
| M PLUS 2 | 4,201,608 B (~4.0 MiB) — variable | TrueType | OFL-1.1 |
| Noto Serif JP | 13,574,352 B (~12.95 MiB) — variable | TrueType | OFL-1.1 |
| Source Han Sans JP | ~27 MB zipped, 7 weights | CID-keyed CFF | OFL-1.1 |

**M PLUS 1p Regular is the leading candidate**: smallest by a wide margin, a genuine single-weight static file, TrueType rather than CID-keyed CFF (so it avoids the *fatal* fontkit bug and only risks the milder one), and OFL-1.1.

Explicitly excluded: **MS Gothic, Yu Gothic, Meiryo** — Windows-bundled, vendor-copyrighted, redistribution not granted. These must never be committed.

**One promising avenue, unresolved:** because `Tr 3` skips both fill and stroke, an invisible layer needs only a correct **cmap** and correct **advance widths** — never the glyph outlines. Real OCR tooling exploits this; Tesseract ships a *glyphless* font of about 572 bytes for exactly this purpose. If that worked here it would collapse a ~1.7 MB asset to under a kilobyte. **However**, pdf-lib issue #1398 reports `font.encodeText()` returning all-zero glyph IDs for the `hocr-tools` glyphless font, producing garbled copy-paste output. It is recorded as a high-value experiment for the spike, not as a plan.

### 5.5 Design decisions worth copying from OCRmyPDF (MPL-2.0)

- **Text-native detection must be margin-aware.** OCRmyPDF's `_page_has_text()` does not ask "does this page contain text" — it insets by `margin_ratio = 0.125` and only counts text intersecting the interior region, so page numbers, headers, and watermarks on an otherwise-scanned page do not suppress OCR. This is strictly better than the raw character count used in §3.2 and should be adopted.
- **Never silently guess when a page already has text.** OCRmyPDF's default is to *abort* and make the caller choose (`skip` / `redo` / `force`), because the failure mode is a double text layer or a corrupted born-digital page.
- **The image OCR reads and the image the human keeps are two different artifacts.** `--clean` cleans only the OCR input; the visible page is untouched unless `--clean-final` is passed, because the cleaning tool can reposition text. The Textifier's existing `cleanNoise` toggle should default to the OCR-input-only meaning.
- **Per-page resilience over whole-document failure** — per-page timeout, skip oversized pages, continue on soft render errors.
- Its own docs flag `--clean`/unpaper as the risky step while treating deskew / rotate / remove-background as lower-risk. That is a useful signal for what to defer.

---

## 6. Licence hygiene for the AGPL reference

`scribe.js` and `scribeocr` are consulted as **architecture references only**. To keep that boundary auditable:

- No source file from either repository is copied, adapted, or translated into this project.
- The `3 Tr` mechanism was proven from the PDF specification and pdf-lib's public API (§3.1) **before** any scribe.js source was read. The convergence is independent, not derivative.
- What is taken from `scribeocr` is limited to non-copyrightable interface ideas — routing progress through one callback keyed by message type, and suppressing per-page UI refresh during batch runs.
- OCRmyPDF is MPL-2.0 (relicensed from GPLv3 in 2020) and is Python, so it is likewise consulted for design only.

---

## 7. Final Architecture

```text
Overall:
  Hybrid — reuse the repository's existing PDF stack, adopt exactly one OCR engine,
  build the integration layer that no permissively-licensed library provides.

Reuse existing:
  pdfjs-dist 5.4.449   page rendering, getTextContent, getOperatorList,
                       viewport.convertToPdfPoint (coordinate inverse)
  pdf-lib 1.17.1       load existing PDF without rasterizing, pushOperators
                       (Tr 3 + Tz + Tm), save to Uint8Array
  renderPageToCanvas   src/utils/pdfDiff.ts — page -> canvas, already uses
                       willReadFrequently, correct for getImageData
  processMonochrome    src/utils/pdf-processor.ts — grayscale + contrast over
                       ImageData; the existing preprocessing primitive
  processOptimize      src/utils/pdf-processor.ts — the DPI <-> PDF-point
                       convention (scale = dpi/72, size = px * 72/dpi)
  public/pdf.worker.min.mjs   local worker, already version-matched at 5.4.449

Adopt dependency:
  tesseract.js ^7.0.0        Apache-2.0. Self-hosted worker + core + traineddata,
                             no CDN. output: { blocks: true } for bboxes.
  @pdf-lib/fontkit ^1.1.1    MIT. Conditional — see Human Decision on the CJK
                             subsetting bug; pdf-fontkit@1.8.9 is the fallback.
  Japanese font asset        OFL-1.1. M PLUS 1p Regular leading (1.68 MiB).

Adapt module:
  (none — no third-party source is copied into this repository)

Reference pattern:
  OCRmyPDF     MPL-2.0  margin-aware text detection, skip/redo/force semantics,
                        clean vs clean-final separation, per-word width fitting,
                        per-page failure isolation
  scribe.js    AGPL-3.0 READ-ONLY. Confirms 3 Tr. No code reuse.
  scribeocr    AGPL-3.0 READ-ONLY. Progress-by-message-type, batch UI suppression.

Build custom:
  1. Page classifier          text-native vs scanned, margin-aware (PDF.js only)
  2. OCR orchestration        worker lifecycle, per-page scheduling, progress,
                              terminate-based cancellation
  3. Coordinate normalizer    thin wrapper over viewport.convertToPdfPoint,
                              rotation-aware text matrix
  4. Invisible layer writer   pdf-lib operators: Tr 3, Tm placement, Tz width fit
  5. Font strategy            embed + measure with one font object; subset policy

Rejected:
  scribe.js as a dependency   AGPL-3.0 copyleft reaches a browser-shipped app
  ocrs                        Latin script only
  transformers.js + manga-ocr no bounding boxes (recognition only)
  PaddleOCR browser ports     no maintained official Japanese browser package
  cloud OCR APIs              violates the browser-local privacy requirement
  hocr2pdf / hocrjs           abandoned / does not emit PDF
  jsPDF for output            cannot preserve an existing PDF; fixtures only

Human Decision:
  H1  Japanese font: which font, and committed to the repo (~1.7 MiB) vs
      fetched on demand? Affects offline behaviour and repo size.
  H2  @pdf-lib/fontkit vs pdf-fontkit, given the open CJK subsetting bug.
  H3  Self-hosting ~5.8 MiB of Tesseract assets (core WASM ~3.73 MiB +
      jpn traineddata ~1.94 MiB) — required for the no-CDN privacy posture,
      but it lands in the deployed bundle. Cached in IndexedDB after first run.
  H4  pdf-lib 1.17.1 is dormant (last commit 2021-11-12, 316 open issues).
      Stay, or move to a maintained fork (@cantoo/pdf-lib, @pdfme/pdf-lib)?
  H5  scribe.js commercial licence — unverified. Only relevant if the AGPL
      reference-only boundary is ever revisited.
```

### 7.1 Resulting pipeline

```text
PDF file (never leaves the browser)
   |
   +-- pdf-lib: PDFDocument.load          keep the original document intact
   |
   +-- PDF.js: per page
   |      getTextContent + getOperatorList -> margin-aware classifier
   |         |
   |         +-- text-native  -> reuse embedded text, no OCR
   |         |
   |         +-- scanned      -> render at chosen DPI (renderPageToCanvas)
   |                             -> optional OCR-input-only cleaning
   |                             -> tesseract.js  { blocks: true }
   |                             -> boxes + confidence in canvas pixels
   |                                   |
   |                                   +-- viewport.convertToPdfPoint
   |                                        -> PDF user space
   |
   +-- pdf-lib: per page, per box
   |      pushOperators( BT, 3 Tr, Tf, Tz, Tm, Tj, ET )
   |
   +-- save() -> Uint8Array -> Blob -> browser download
```

The original page content is never replaced — the invisible layer is appended on top of it, which is why appearance is preserved by construction rather than by careful re-rendering.

---

## 8. Deliberately out of scope for M1

Word export, Excel export, table reconstruction, deskew, full noise reduction, OCR accuracy tuning, Annotator / Comparator / Processor / Split-Merge changes, README rewrite, version unification, and the repository-wide PDF.js worker CDN cleanup described in §2.2.

---

## 9. Research provenance

| Source | Canonical URL | Version / commit | License |
|---|---|---|---|
| PDF ArchiTools | https://github.com/airesearchagl-art/PDF_ArchiTools | `eeb8404` | — |
| Mozilla PDF.js | https://github.com/mozilla/pdf.js | `pdfjs-dist` 5.4.449 (installed) | Apache-2.0 |
| pdf-lib | https://github.com/Hopding/pdf-lib | 1.17.1, published 2021-11-07 | MIT |
| @pdf-lib/fontkit | https://github.com/Hopding/fontkit | 1.1.1, published 2020-11-28 | MIT (per npm; no repo LICENSE file) |
| Tesseract.js | https://github.com/naptha/tesseract.js | 7.0.0, released 2025-12-15 | Apache-2.0 |
| tesseract.js-core | https://www.npmjs.com/package/tesseract.js-core | 7.0.0 | Apache-2.0 |
| tessdata (`jpn`) | https://github.com/tesseract-ocr/tessdata_fast | `jpn` 2.36 MB, `jpn_vert` 2.90 MB | Apache-2.0 |
| scribe.js | https://github.com/scribeocr/scribe.js | v0.15.0, npm `scribe.js-ocr` | **AGPL-3.0** |
| scribeocr | https://github.com/scribeocr/scribeocr | `80ef03b` | **AGPL-3.0** |
| OCRmyPDF | https://github.com/ocrmypdf/OCRmyPDF | 17.11.0, 2026-08-28 | MPL-2.0 |
| tesseract-wasm | https://github.com/robertknight/tesseract-wasm | — | BSD-2-Clause |
| ocrs | https://github.com/robertknight/ocrs | `ocrs-cli` 0.13.0 | Apache-2.0 |
| M PLUS 1p | https://github.com/google/fonts/tree/main/ofl/mplus1p | Regular 1,758,688 B | OFL-1.1 |
| Noto Sans JP | https://github.com/google/fonts/tree/main/ofl/notosansjp | variable 9,589,900 B | OFL-1.1 |

### 9.1 Open questions carried forward

These were **not** resolved and must not be treated as settled:

1. Whether a scribe.js commercial licence exists (no primary source found).
2. Japanese OCR quality via Tesseract for real architectural drawings — untested. Note that scribe.js's own test fixtures contain only `eng.traineddata`, so its Japanese path is untested upstream too.
3. The licence of the `naptha/tessdata` mirror that Tesseract.js fetches from by default. Upstream `tesseract-ocr/tessdata_*` is Apache-2.0; the re-packaged mirror carries no separate statement. Self-hosting from upstream sidesteps this entirely and is the recommended path regardless.
4. Whether the ~572-byte glyphless-font technique can work with pdf-lib (issue #1398 suggests not, without a workaround).
5. Whether the 2021 Vite `browser`-field bundling bug affecting tesseract.js still reproduces on Vite 7.
6. Exact per-page recovery semantics of OCRmyPDF's `--skip-big` / `--continue-on-soft-render-error`.
