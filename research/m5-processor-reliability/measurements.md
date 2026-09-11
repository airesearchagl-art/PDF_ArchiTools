# Measurements

All numbers from `scripts/research-gate.mjs` on `main@78b5bd5`, headless Chrome
via puppeteer, Windows 11, recorded in `evidence.json`. Timings are indicative.
Two consecutive runs classify every gate line identically; byte counts repeat
except for ±1 B in documents pdf-lib rebuilds, which carry the current time in
their Info dictionary.

## Corpus

29 synthetic PDFs from `scripts/make-fixtures.mjs` (none committed):

- content — `vector-a4`, `text-a4`, `raster-a4`, `colour-raster-a4`, `ocr-a4`
  (full-page image + `Tr 3` text), `mixed-a4`, `transparency-a4`;
- structure — `annotation-a4` (Square with /AP, Text), `link-a4` (URI),
  `form-a4` (text field with value, checked box), `signature-a4` (a /ByteRange
  covering the file, SHA-256 in /Contents), `xfa-a4`, `metadata-a4` (Info +
  XMP), `three-pages` (order markers and blocks);
- geometry — `vector-a3/a1/a0`, `landscape-a4`, `rotate-0/90/180/270` (with
  annotations), `crop-offset` (CropBox at 50,70), `mediabox-offset` (MediaBox
  at 200,300), `mediabox-larger` (content outside the CropBox), `mixed-sizes`;
- batch — `invalid` (not a PDF), `batch-ok`, `long-8`.

Every property a fixture claims is asserted before it is used (gate §1).

## Size

| document | source | Optimize O1 @72 | @150 (default) | @300 | O2 lossless re-save | O3 @150 (structure kept) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vector-a4 | 1,315 B | ×12.70 | ×34.60 | ×94.68 | ×0.85 | ×0.85 |
| text-a4 | 1,441 B | ×11.91 | ×32.13 | ×88.62 | ×0.85 | ×0.85, text kept |
| raster-a4 | 371,063 B | ×0.18 | ×0.92 | ×3.17 | ×1.00 | ×0.46 |
| ocr-a4 | 371,187 B | ×0.18 | ×0.92 | ×3.17 | ×1.00 | ×0.46, OCR kept |
| mixed-a4 | 51,667 B | ×0.53 | ×1.68 | ×5.06 | ×1.00 | ×0.39, text + vectors kept |
| form-a4 | 4,501 B | ×4.40 | ×11.78 | ×31.38 | ×0.73 | ×0.73, form kept |
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

## Hardened lanes

Existing gates, unchanged: `smoke-page-size-normalizer` 339/339,
`smoke-production-size-normalizer` 20/20, `smoke-title-block-updater` 122/122,
`smoke-titleblock-ui` 31/31. Against this corpus: both keep XFA and form
values; both invalidate the signature fixture without a refusal; both rewrite
Producer and ModDate.

## Gate totals

ASSERT 22/22, PROBE 11/11, MEASURE 70, BASELINE-FAIL 18, HUMAN-OPEN 13;
external HTTP(S) 0; page errors 0. Console errors: PdfTools' own
`console.error` for the deliberately invalid inputs, and one same-origin
`/favicon.ico` 404.
