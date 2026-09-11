# Baseline — the five legacy Processor operations on `main@78b5bd5`

Measured, not inferred: every cell below comes from running the production
functions in `src/utils/pdf-processor.ts` unchanged (and "両方実行" composed
exactly as `PdfTools.tsx:125-129` composes it) over the synthetic corpus, then
reading the output's **structure** with PDF.js and pdf-lib. A property is
"retained" only when a reader can still extract it — never because the page
looks right. Settings are the UI defaults (`PdfTools.tsx:36-42`): layer white
at 50%, monochrome 300 dpi contrast 1.0, optimize 150 dpi, margin 80% centre.

Source for every number: `evidence.json` (`sections.baseline`), produced by
`scripts/research-gate.mjs`.

## What each operation actually does

| operation | code path | kind of output |
| --- | --- | --- |
| 半透明レイヤ追加 | `processLayer` (`pdf-processor.ts:29-55`): `PDFDocument.load` → one `drawRectangle` at (0,0, `page.getSize()`) per page → `save()` | the **source document**, re-serialised, with one extra filled path per page |
| モノクロ化 | `processMonochrome` (`:105-160`): PDF.js renders each page → `getImageData` → grey + contrast → `putImageData` → `toDataURL('image/jpeg', 0.8)` → `embedJpg` into a **new** `PDFDocument` | a new document, **one JPEG per page and nothing else** |
| 両方実行 | `PdfTools.tsx:125-129`: `processMonochrome` → `processLayer` on its bytes | Monochrome's output, re-saved with the overlay path |
| 余白生成 | `processMargin` (`:167-232`): `embedPage` of each source page into a **new** `PDFDocument`, drawn scaled into a page of `page.getSize()` | a new document whose pages each draw one Form XObject |
| 最適化 | `processOptimize` (`:61-103`): as Monochrome without the grey step, at 72/150/300 dpi | a new document of one JPEG per page |

## Preservation matrix (A4 structural fixtures)

| dimension | Layer | Monochrome | Both | Margin | Optimize |
| --- | --- | --- | --- | --- | --- |
| page count | 3 → 3 | 3 → 3 | 3 → 3 | 3 → 3 | 3 → 3 |
| page order | preserved (text) | preserved (pixels — text gone) | preserved (pixels) | preserved (text) | preserved (pixels) |
| visible geometry | unchanged | unchanged (rotation baked into pixels) | unchanged | intentionally scaled — **and rotated sheets come back turned** | unchanged (baked) |
| MediaBox | unchanged | = visible box at origin | = visible box | = source MediaBox size at origin | = visible box |
| CropBox | unchanged | = new MediaBox | = new MediaBox | **= MediaBox (crop discarded)** | = new MediaBox |
| `/Rotate` | kept | 90 → 0 (baked) | 90 → 0 | **90/180/270 → 0, content not rotated** | 90 → 0 (baked) |
| native text | extractable | **lost** | **lost** | extractable (inside a Form XObject) | **lost** |
| OCR text layer | extractable | **lost** | **lost** | extractable | **lost** |
| vectors | retained | **lost** (0 path operators) | **lost** (only the overlay's 5 remain) | retained (in a Form XObject) | **lost** |
| source raster | same bytes | re-encoded JPEG | re-encoded | same bytes | re-encoded JPEG |
| annotations | retained | **lost** | **lost** | **lost** | **lost** |
| links | retained | **lost** | **lost** | **lost** | **lost** |
| AcroForm / value | retained with value | **lost** | **lost** | **lost** | **lost** |
| signature | **invalidated, silently** (digest mismatch) | removed | removed | removed | removed |
| XFA | retained | **removed** | **removed** | **removed** | **removed** |
| metadata | Title/Author/XMP kept; **Producer, ModDate rewritten** | **all lost** (Title null) | **all lost** | **all lost** | **all lost** |
| hidden (outside-CropBox) content | stays hidden | stays hidden | stays hidden | **revealed** (1.7% of the page) | stays hidden |
| output size, vector A4 | 1,315 → 1,537 B | → 112,759 B (×86) | → 113,113 B | → 2,085 B | → 45,504 B (×35) |
| output size, raster A4 | 371,063 → 371,244 B | → 1,176,256 B (×3.2) | → 1,176,609 B | → 371,463 B | → 340,428 B (×0.92) |
| peak raster | none | canvas + readback, 8·W·H per page | as Monochrome | none | canvas, 4·W·H per page |
| external HTTP(S) | 0 | 0 | 0 | 0 | 0 |
| failure output | none (exception) | none | none | none | none |

Signature "invalidated" is the fixture's structural proxy: its `/ByteRange` covers
the whole file and `/Contents` holds the SHA-256 of that range; after Layer the
signature dictionary is still there but the file it covered is not.

## Baseline defects (FAIL → root cause → proposed architecture)

Each is printed by the gate as `BASELINE-FAIL` with the measured detail.

1. **Monochrome / Both / Optimize replace searchable text, the OCR layer and
   every vector with one JPEG per page, and report 「done」.** Root cause: the
   pipeline is render → JPEG → new document; nothing of the source crosses over
   except pixels. → Architecture: classify as `INTENTIONAL_FLATTENING`, PLAN
   `STRUCTURE_LOSS_REQUIRES_CONFIRMATION` naming each loss; or a
   structure-preserving candidate (Monochrome C, Optimize O3). *H1, H2, H5.*
2. **The same three drop annotations, links, forms, the signature, XFA and all
   metadata without saying so.** Same root cause. → every output item is
   accounted for in the PLAN; a loss is refused or confirmed, never silent.
   *H5, H6, H7, H12.*
3. **「最適化」 makes vector documents 11–153× larger at its default, up to 463×.** A vector A4 at the
   default 150 dpi goes from 1,315 B to 45,504 B; an A1 to 216 KB. Root cause:
   the operation is a rasterisation, not an optimisation. *H2.*
4. **Margin leaves every page-level and document-level object behind**
   (annotations, links, widgets, AcroForm, XFA, metadata). Root cause:
   `embedPage` carries a content stream and its resources into a new document,
   nothing else. → in-place transform (`prototype/margin-inplace.mjs`). *H3, H6.*
5. **Margin drops `/Rotate`**: a `/Rotate 90` sheet comes back portrait with its
   content turned; `/Rotate 180` comes back upside down. Root cause: the new page
   has no rotation and draws the source unrotated.
6. **Margin discards the CropBox** (crop at (50,70) becomes the whole MediaBox)
   **and reveals content the CropBox hid.** Root cause: the new page is sized
   from `getSize()` (MediaBox) and the embedded page's bounding box is the
   MediaBox.
7. **Layer invalidates a signature silently** and **rewrites Producer/ModDate**
   (`PDFDocument.load` defaults to `updateMetadata: true`).
8. **Layer's overlay misses the sheet when the MediaBox does not start at
   (0,0)**: it reached 39% of the ink on `mediabox-offset` against 100% on an
   ordinary page. Root cause: the rectangle is drawn at (0,0) with the page's
   width and height. *H13.*
9. **Monochrome at 600 dpi (offered) on an A1 fails after the work has
   started**, with `Offset is outside the bounds of the DataView`: the browser
   will not allocate the 279-Mpx canvas, `toDataURL` returns `"data:,"`, and
   pdf-lib fails decoding it. No preflight. *H8, H9.*
10. **A batch the user navigated away from still downloads** its ZIP after the
    Processor has unmounted. Root cause: no generation/ownership in
    `startProcessing`. *H10.*
11. **A setting changed during a run is neither applied nor locked**: the panel
    shows 150 dpi, the file written is 300 dpi, and its row says done. *H10.*
12. **Hardened lanes: a signed document is processed and its signature
    invalidated without a refusal**, and both lanes rewrite Producer/ModDate.
    Recorded as compatibility notes; neither lane is redesigned here. *H7, H12.*

## What already holds

- Every per-file function is **atomic**: an unreadable file or a failure on
  page 2 of 3 throws and returns no bytes.
- A single failed file downloads nothing; the file rows name which file failed.
- Page count and order are preserved by all five.
- Layer keeps text, the OCR layer, vectors, raster bytes, annotations, links,
  form values and XFA. Margin keeps text, OCR and vectors as operators.
- No operation made an external request.
