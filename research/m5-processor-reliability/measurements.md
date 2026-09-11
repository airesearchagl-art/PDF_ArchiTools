# Measurements

All numbers from `scripts/research-gate.mjs` against production code at
`main@78b5bd5`, run locally on this branch in headless Chrome via puppeteer,
Windows 11, recorded in `evidence.json` — not Core-CI evidence (see the end).
Timings are indicative.
Two consecutive runs classify every gate line identically; byte counts repeat
except for ±1 B in documents pdf-lib rebuilds, which carry the current time in
their Info dictionary.

## Corpus

38 synthetic PDFs from `scripts/make-fixtures.mjs` (none committed):

- content — `vector-a4`, `text-a4`, `raster-a4`, `colour-raster-a4`, `ocr-a4`
  (full-page image + `Tr 3` text), `mixed-a4`, `transparency-a4`;
- structure — `annotation-a4` (Square with /AP, Text), `link-a4` (URI),
  `form-a4` (text field with value, checked box), `signature-a4` (a /ByteRange
  covering the file, SHA-256 in /Contents), `xfa-a4`, `metadata-a4` (Info +
  XMP), `three-pages` (order markers and blocks);
- geometry — `vector-a3/a1/a0`, `landscape-a4`, `rotate-0/90/180/270` (with
  annotations), `crop-offset` (CropBox at 50,70), `mediabox-offset` (MediaBox
  at 200,300), `mediabox-larger` (content outside the CropBox), `mixed-sizes`;
- batch — `invalid` (not a PDF), `batch-ok`, `long-8`;
- added for RF-K3/K4/K6 — `internal-links` (GoTo `/XYZ`, named `/FitH`,
  `/FitR`, an outline item), `annotation-partial-crop`, `annotation-overlap`,
  `shared-image-a4-a1` / `shared-image-a1-a4`, `repeated-image`, `form-image`,
  `annot-image`, `fine-line-scan` (300 dpi one-pixel linework on paper grain).
  `form-a4` now sets an explicit `/DA` size (14 pt).

Every property a fixture claims is asserted before it is used (gate §1).

## Size

| document | source | Optimize O1 @72 | @150 (default) | @300 | O2 lossless re-save | O3 @150 (structure kept) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vector-a4 | 1,315 B | ×12.70 | ×34.60 | ×94.68 | ×0.85 | ×0.85 |
| text-a4 | 1,441 B | ×11.91 | ×32.13 | ×88.62 | ×0.85 | ×0.85, text kept |
| raster-a4 | 371,063 B | ×0.18 | ×0.92 | ×3.17 | ×1.00 | ×0.46 |
| ocr-a4 | 371,187 B | ×0.18 | ×0.92 | ×3.17 | ×1.00 | ×0.46, OCR kept |
| mixed-a4 | 51,667 B | ×0.53 | ×1.68 | ×5.06 | ×1.00 | ×0.39, text + vectors kept |
| form-a4 | 4,502 B | ×4.25 | ×11.20 | ×30.27 | ×0.73 | ×0.73, form kept |
| annotation-a4 | 2,007 B | ×10.06 | ×27.07 | ×72.74 | ×0.76 | ×0.76, annotations kept |
| vector-a1 | 1,417 B | ×49.93 | ×152.61 | ×463.52 | ×0.86 | ×0.86 |

O1 at its default makes 6 of 8 documents larger and removes all text on every
one. O3 made none larger and kept text, vectors and annotations on every one.

Monochrome (candidate A, 300 dpi): vector A4 ×86, raster A4 ×3.17. Candidates B
and C on the same vector A4: 1,108 B.

## Full-page raster cost

`canvas.width = viewport.width` truncates to whole pixels. RGBA is 4 bytes per
pixel; Monochrome additionally holds a `getImageData` copy of the same size.

| sheet | 72 dpi | 150 dpi | 300 dpi | 600 dpi |
| --- | --- | --- | --- | --- |
| A4 | 0.5 Mpx / 2 MiB | 2.2 / 8 | 8.7 / 33 | 34.8 / 133 |
| A3 | 1.0 / 4 | 4.3 / 17 | 17.4 / 66 | 69.6 / 265 |
| A1 | 4.0 / 15 | 17.4 / 66 | 69.7 / 266 | **278.7 / 1,063** |
| A0 | 8.0 / 31 | 34.9 / 133 | 139.5 / 532 | **558.0 / 2,128** |

The UI offers Monochrome at 150/300/600 and Optimize at 72/150/300.

**Canvas limit, probed without drawing a page:** A1 @300 (70 Mpx) and A0 @300
(139 Mpx) allocate; A1 @600 (279 Mpx) and A0 @600 (558 Mpx) do not, and
`toDataURL` on them returns `"data:,"`. Production then throws `Offset is
outside the bounds of the DataView` from pdf-lib — after rendering has begun.

**Per-page peak from the code** (canvas + Monochrome's readback + the JPEG +
its base64 data URL at one byte per character + the bytes pdf-lib keeps):

| run (measured) | time | JPEG | output | per-page peak |
| --- | ---: | ---: | ---: | ---: |
| Optimize A1 @150 | 0.2 s | 0.22 MB | 0.22 MB | ≈ 67 MiB |
| Monochrome A1 @150 | 0.3 s | 0.20 MB | 0.20 MB | ≈ 133 MiB |
| Optimize A0 @150 | 0.3 s | 0.36 MB | 0.36 MB | ≈ 134 MiB |
| Monochrome A1 @300 | 0.9 s | 0.62 MB | 0.62 MB | ≈ 534 MiB |

Calculated, not run: **Monochrome A0 @300 — the default resolution on the
largest sheet — ≈ 1,064 MiB of RGBA per page before the JPEG.** Every page's
JPEG is kept by pdf-lib until `save()`, which then copies all of them into the
output; a batch keeps every output in JSZip until the archive is generated.
The JPEGs here are small because the drawings are mostly white; a dense scan
is an order of magnitude larger.

## Batch (the real UI, 半透明レイヤ追加)

| input | rows | download |
| --- | --- | --- |
| ok, **invalid**, ok | done, error, done | `processed_files.zip` [2 PDFs] |
| **invalid**, ok, ok | error, done, done | `processed_files.zip` [2 PDFs] |
| ok, ok, **invalid** | done, done, error | `processed_files.zip` [2 PDFs] |
| invalid, invalid | error, error | none |
| invalid | error | none |
| ok | done | `batch-ok_overlay.pdf` |
| ok, ok | done, done | `processed_files.zip` [2 PDFs] |

The archive from a partly failed batch carries no record of the failure.

## Lifecycle (the real UI, モノクロ化)

- **Navigate away mid-batch:** the Processor unmounts; `processed_files.zip`
  still arrives afterwards.
- **Change DPI mid-run:** the control stays enabled; the panel ends showing
  150 dpi; the file written is 2,480 px wide (300 dpi); its row says done.
- **Add a file mid-run:** accepted by the input; stays `idle`, excluded from
  the archive, no notice.
- **Remove a file / switch tool mid-run:** both disabled.
- **Contrast and margin controls** use the same closure as DPI (same code
  path); not separately exercised.

## Monochrome candidates (chroma = share of pixels with a hue, before → after)

| document | A (production) | B (colour operators) | C (B + images) |
| --- | --- | --- | --- |
| vector-a4 | 0.036 → 0, 112,759 B, vectors lost | 0.036 → 0, 1,108 B, vectors kept | same as B |
| transparency-a4 | 0.214 → 0, 72,012 B, text lost | 0.214 → 0, 972 B, text kept | same as B |
| annotation-a4 | annotations lost | annotations kept, /AP, /C converted | same as B |
| form-a4 | form lost | form kept (24 colour edits, 4 annotation colours) | same as B |
| raster-a4 | re-encoded, 1,176,256 B | **refused** (draws an image) | grey Flate, 147,665 B |
| ocr-a4 | OCR lost | **refused** | OCR kept, 147,779 B |
| colour-raster-a4 | text lost | **refused** | 1.000 → 0.000, text kept |
| production Optimize output (DCT) | — | **refused** | 0.023 → 0.000 |

## Margin: expected picture

The expected output is computed independently: the source's own rendering
shrunk by 80% into the chosen corner of the visible page. Mean absolute
difference, 0–255, lower is closer:

| fixture | production centre | in-place centre |
| --- | ---: | ---: |
| text-a4 | 2.4 | 2.4 |
| rotate-90 / 270 | page shape differs (portrait, turned) | 2.4 / 2.5 |
| rotate-180 | 4.6 (upside down) | 2.1 |
| crop-offset | 8.4 | 2.0 |
| mediabox-larger | page shape differs, hidden content 1.7% | 2.0, hidden 0% |

## Source facts and H7 (RF-K1)

`readSourceFacts` on the corpus: `signature-a4` → one signature field, signed;
`xfa-a4` → AcroForm with XFA, 0 fields; `form-a4` → 2 fields, form read; the
non-PDF → loaded by pdf-lib's lenient parser, pages invalid (M3 calls it
unreadable at the same stage). `getForm()` trapped to throw while facts are
read: **0 calls**; the same trap counts 1 call from M3's `assessSource` on an
ordinary form. The planner's operation-effects table matches the measured XFA
and form outcomes of all 8 operations it covers. Policy matrix: see
`decision-matrix.md`.

## Batch policies (RF-K2)

| run | BatchResult | published | files |
| --- | --- | --- | --- |
| B1 `[ok, invalid, text, signed]` | FAILED | 0 | ok SUCCEEDED, invalid FAILED, text/signed CANCELLED (not run) |
| B2 same | PARTIAL | 1 archive [ok, text] + manifest | invalid `UNSUPPORTED_DOCUMENT`, signed `SIGNATURE_UNSAFE` named |
| B3 same | PARTIAL | 2 files, each before the next started | as B2, no archive |
| B3, `long-8` cancelled by its own owner | PARTIAL | 2 | ok, text SUCCEEDED; long-8 CANCELLED |
| B1 / B2 superseded during `long-8` | CANCELLED | 0 / 0 | |
| B3 superseded during `long-8` | CANCELLED | 1 (ok, finished first) | |
| aggregate single publish checked as B3 | — | — | rejected: 1 publish for 2 successes; an archive |

## Margin semantics (RF-K4)

| | before | in-place | expected (target page's matrix) | production |
| --- | --- | --- | --- | --- |
| link `/Dest` | `[p2 XYZ 100 700 0]` | `[p2 XYZ 139.53 644.19 0]` | 139.53, 644.19 | lost |
| link GoTo named → tree | `[p2 FitH 500]` | `[p2 FitH 484.19]` (PDF.js resolves 484.19) | 484.19 | lost |
| link GoTo `/FitR` | `[p1 FitR 100 100 300 300]` | `[p1 FitR 139.53 164.19 299.53 324.19]` | same | lost |
| outline item | `[p2 XYZ 50 400 null]` | `[p2 XYZ 99.53 404.19 null]` | 99.53, 404.19 | lost |

Partly clipped Square: **refused** ("not wholly inside the visible page");
the same page without it: transformed. Widget text height (PDF.js, points):
source 10.25 → in-place 8.00 (stored appearance) → 8.00 regenerated from the
scaled `/DA` (14 → 11.2 pt); regenerated from an unscaled `/DA` it would be
10.25 in a box ×0.8. Field value kept.

## Layer stacking (RF-K6)

Opaque blue annotation under white 50%: before `[0,0,255]`; production
`[0,0,255]` (layer below, annotation unfaded); overlay-as-last-annotation
`[128,128,255]` (above), original annotation kept, one annotation added.

## O3 planning (RF-K3)

| fixture | uses (px needed at 150 dpi) | all-uses | first-use (replaced) |
| --- | --- | --- | --- |
| shared-image-a4-a1 | p1 1241×1754, p2 3508×4967 | 3000×4243 kept | **1240×1754** |
| shared-image-a1-a4 | p1 3508×4967, p2 1241×1754 | 3000×4243 kept | 3000×4243 |
| repeated-image | 209×294, 1241×1754 on p1 | 1240×1754 | 1240×1754 |
| form-image | p1 1241×1754, p2 3508×4962 (via Form) | 3000×4243 kept | **1240×1754** |
| annot-image | none (annotation appearance) — uncertain | not downsampled | not reached |

## O3 lossy quality (RF-K3)

`fine-line-scan`, 300 dpi, one-pixel lines on paper grain, 7,856,445 B.
Rendered at 300 dpi against the source:

| variant | size | line ink kept | spurious ink | PSNR |
| --- | ---: | ---: | ---: | ---: |
| O1 production @150 | ×0.086 | 22.1% | 12.4% | 12.4 dB |
| O2 lossless | ×1.000 | 100% | 0% | ∞ |
| O3 JPEG q0.8 @150 | ×0.086 | 26.3% | 7.4% | 14.6 dB |
| O3 JPEG q0.92 @150 | ×0.127 | 23.0% | 4.1% | 14.7 dB |
| O3 JPEG q0.8 @300 | ×0.331 | 100% | 0% | 33.7 dB |
| O3 JPEG q0.92 @300 | ×0.514 | 100% | 0% | 38.4 dB |
| O3 lossless resample @150 | ×0.230 | 21.7% | 2.8% | 14.7 dB |

What removes linework is the resample below the scan's resolution, lossless or
not; JPEG at the native resolution keeps every line.

## Raster Budget (RF-K5)

**JPEG worst case** at q0.8 (1024² and 2480×3508): uniform RGB noise 0.635,
grey noise 0.582, **binary RGB noise 0.783**, binary grey 0.678, checkerboard
0.196, colour checkerboard 0.102 B/px. Bound 1.0 B/px (≥ 1.25 × 0.783),
re-measured and probed every run.

**Validation against production** (7 runs, 16 pages: Monochrome text/raster
A4 @300, Optimize mixed A4 @150, Monochrome `long-8` @150, Both @150, Optimize
A1 @150, Optimize mixed sizes @72): every canvas exactly the planned W×H; every
data URL exactly 4·⌈J/3⌉+23 characters; every JPEG and every output under its
bound (e.g. Monochrome raster A4 @300: 1,176,256 ≤ 8,707,600 B).

**Per sheet and offered DPI** (single page, `MAX_RASTER_PIXELS` 128 Mi):

| sheet | Monochrome/Both 150 · 300 · 600 | Optimize 72 · 150 · 300 |
| --- | --- | --- |
| A4 | 24 · 94 · 376 MiB — all READY at 512 | 4 · 15 · 61 MiB — READY |
| A3 | 47 · 188 · 752 MiB — 600 needs 1 GiB | 7 · 30 · 122 MiB — READY |
| A1 | 188 · **753 MiB (needs 1 GiB)** · raster-refused | 28 · 122 · 487 MiB — READY |
| A0 | 377 · raster-refused · raster-refused | 56 · 244 MiB · raster-refused |

**Boundaries:** raster ceiling — 134.19 Mpx accepted, 134.31 Mpx refused
(memory unbounded to isolate it); A4 @300 Monochrome — 30 pages accepted
(498 MiB), 31 refused `OVER_MEMORY_BUDGET` (514 MiB), and at 1 GiB and 2 GiB
the 31st is refused by `OVER_OUTPUT_BUDGET` (257 MiB); one-page A4 @150
Optimize batch — 49 files accepted (510 MiB), 50 refused (521 MiB), accepted
at 1 GiB. A1 @600 at 2 GiB and A0 @600 at unbounded memory: `OVER_RASTER_LIMIT`.

**Raster-limit candidates** admit (raster only): 64 Mi — through A3@300,
A1@150, A0@150; 128 Mi — plus A3@600 and A1@300; 256 Mi — plus A0@300.

## Hardened lanes

Existing gates, unchanged: `smoke-page-size-normalizer` 339/339,
`smoke-production-size-normalizer` 20/20, `smoke-title-block-updater` 122/122,
`smoke-titleblock-ui` 31/31. Against this corpus: both keep XFA and form
values; both invalidate the signature fixture without a refusal; both rewrite
Producer and ModDate.

## Gate totals, and what kind of evidence they are

**M5 research gate (local branch run, committed as `evidence.json`):**
ASSERT 27/27, PROBE 32/32, MEASURE 119, BASELINE-FAIL 18, HUMAN-OPEN 15;
external HTTP(S) 0; page errors 0. Console errors: PdfTools' own
`console.error` for the deliberately invalid inputs, and one same-origin
`/favicon.ico` 404.

**Core CI (exact head):** the existing backbone only. `core-ci.yml` does not
run the M5 research gate, so none of the numbers above are Core-CI evidence.
