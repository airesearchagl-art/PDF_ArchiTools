# M2-4 measurements

Every number here was produced on this machine by the scripts named beside it, against the synthetic corpus in `fixtures.md`. Nothing is quoted from documentation or from memory. Where a measurement contradicts what one would expect, the contradiction is the finding.

Reproduce with:

```
node scripts/research-m2-4-fixtures.mjs
node scripts/research-m2-4-geometry.mjs
node scripts/research-m2-4-tables.mjs
node scripts/research-m2-4-tables.mjs --ocr-auto
node scripts/research-m2-4-xlsx-writers.mjs
node scripts/research-m2-4-performance.mjs
node scripts/research-m2-4-smoke.mjs
```

---

## 1. What the current pipeline keeps, and what it throws away

Read directly from `src/utils/pdf-textifier/`.

| stage | geometry available | what survives into the result |
|---|---|---|
| `extractNativeText()` in `extract.ts` | every `TextItem` has a full transform | `item.str` concatenated, plus `\n` where `hasEOL` is set. **All coordinates are discarded.** |
| `OcrEngine.recognisePage()` in `ocr.ts` | word boxes with confidence, inside Tesseract's block → paragraph → line tree | `flattenWords()` keeps text + bbox + confidence and **discards the line and paragraph grouping** |
| `extractTextPdf()` scanned branch | `ocr.words` is in hand | only `ocr.text` is stored; `ocr.words.length` is kept as a count and **the boxes are dropped** |
| `preprocessForOcr()` in `preprocess.ts` | returns `mapToRenderSpace` for deskewed images | used by the M1 searchable-PDF path; the text-extraction path never calls it |
| `ExtractedPage` in `types.ts` | — | `text: string`, `charCount`, `ocrWords`, `meanConfidence` |

**Consequence.** `ExtractedPage.text` is a string with no geometry attached. A table cannot be recovered from it, because the information that makes a table a table — which characters sit in which column — was thrown away one function earlier. Both pipelines already *hold* that information at the moment they discard it.

## 2. Native geometry

`scripts/research-m2-4-geometry.mjs`, pdfjs-dist 5.4.449.

A `TextItem` carries exactly: `str, dir, width, height, transform, fontName, hasEOL`. `content.styles[fontName]` carries `{ fontFamily, ascent, descent, vertical }`.

```
first item: {"str":"仕上表 / FINISH SCHEDULE","dir":"ltr","width":177.534,"height":14,
             "transform":[14,0,0,14,60,767.89],"fontName":"g_d0_f1","hasEOL":false}
```

- **Normalisation.** `pdfjsLib.Util.transform(viewport.transform, item.transform)` gives the baseline origin in display space. `viewport.transform` is `[1,0,0,-1,0,841.89]` for an upright A4 and `[0,1,1,0,0,0]` for the same page with `/Rotate 90`, whose viewport is `841.89 × 595.28`. Composing the two handles rotation without any hand-written case analysis. Measured: **17 of 21 tokens** on the rotated fixture land inside the rotated table box (the other 4 are the sheet title, which is outside it).
- **`hasEOL` is not usable as a line break.** Across the whole corpus, **0 tokens** report `hasEOL: true`. It exists on every item and is false on every item. Line structure has to come from geometry.
- **Token fragmentation is real.** `native-ruled-mixed-types` splits each cell into two drawn runs and yields 42 tokens for 20 cells. Any reconstruction has to join runs before assigning them to a cell.

## 3. Ruling lines from the vector content

Recovered from `page.getOperatorList()` without rasterising anything.

pdf.js 5.x changed the shape of `constructPath`: the arguments are `[paintOp, [flat path data], minMax]`, where the path data is a flat `[opcode, ...coords]` array — for one rectangle:

```
[0, 0,0, 1, 0,82, 1, 0.8,82, 1, 0.8,0, 4]   minMax [0, 0, 0.8, 82]
```

The decoder is checked against the `minMax` pdf.js computed for the same call: if the decoded bounding box does not match, the decode is declared wrong rather than reported. **383 of 383 paths decoded and verified across the corpus, 0 fell back to the bounding box, 0 non-axis-aligned segments.**

| fixture | horizontal | vertical |
|---|---|---|
| `native-ruled-simple` | 18 | 18 |
| `native-merged-header` | 50 | 50 |
| `adv-title-block` | 28 | 28 |
| `adv-grid-dimensions` | 118 | 118 |
| `adv-full-sheet` | 150 | 150 |
| `native-borderless-aligned` | 0 | 0 |

Vector lines are cheap and exact where they exist. **They also exist in quantity on drawing content that is not a table** — the last three rows are the problem this spike is about.

## 4. OCR geometry, and the finding that reorders the whole feature

The pipeline as it ships returns **no text at all from inside a ruled table**.

| input | words | inside the table | mean confidence |
|---|---|---|---|
| `scanned-ruled-simple` (150 DPI) | 5 | **0** | 92 |
| the same at 300 DPI | 5 | **0** | 91 |
| the same at 400 DPI | 5 | **0** | 91 |
| the same scan at 2× resolution, rendered at 300 DPI | 6 | **0** | 78 |
| **the same table with its ruling lines removed** | 34 | **29** | 88 |

Resolution is not the cause: re-rendering carries no new detail, and a genuinely higher-resolution scan changes nothing. Removing the ruled box changes everything. So the cause is layout analysis, and a segmentation sweep locates it exactly:

| mode | `scanned-ruled-simple` | `adv-scanned-sheet` (a drawing, no table) |
|---|---|---|
| **DEFAULT (unset, as shipped)** | **5 words, conf 92** | **37 words, conf 64** |
| `SINGLE_BLOCK` (psm 6) | **5 words, conf 92** | **37 words, conf 64** |
| `AUTO` (psm 3) | 37 words, conf 91 | 23 words, conf 75 |
| `SPARSE_TEXT` (psm 11) | 36 words, conf 90 | 28 words, conf 78 |
| `SPARSE_TEXT_OSD` (psm 12) | 36 words, conf 89 | 28 words, conf 73 |
| `SINGLE_COLUMN` (psm 4) | 38 words, conf 91 | 24 words, conf 81 |

The unset default is byte-for-byte `SINGLE_BLOCK` on both pages — measured by running the unset case first and comparing, not inferred from the version number.

Two consequences, and the second is the reason this is not a one-line fix:

1. **This already affects shipped features.** Text Extraction and the searchable-PDF export lose the contents of any ruled box on a scanned page — which on an architectural drawing includes the title block and every schedule. It is a pre-existing defect, not one M2-4 introduces.
2. **No single mode is correct.** On the ruled table, the default recovers 0 of the cell text and `AUTO` recovers it all. On the drawing sheet, the default finds 37 words and `AUTO` finds 23. Choosing one segmentation for every page trades one loss for another.

## 5. Detection

`scripts/research-m2-4-tables.mjs`. 15 ground-truth tables across 14 fixtures; 8 adversarial sheets whose correct answer is zero tables. Region matching is IoU ≥ 0.5; a cell is correct when its text matches at its own row and column.

### With OCR exactly as it ships

| mode / signal | found | matched | missed | false pos | cell accuracy | text kept | exact grids |
|---|---|---|---|---|---|---|---|
| auto / geometry | 16 | 8 | 7 | 8 | **0%** | 83% | 0/8 |
| auto / ruling | 8 | 8 | 7 | 0 | 88% | 93% | 7/8 |
| auto / hybrid | 15 | 10 | 5 | 5 | 71% | 93% | 7/10 |
| region / geometry | 11 | 9 | 6 | 2 | 69% | 87% | 5/9 |
| region / ruling | 9 | 9 | 6 | 0 | 89% | 94% | 8/9 |
| **region / hybrid** | **11** | **11** | **4** | **0** | **91%** | **95%** | **10/11** |
| confirm / geometry | 3 | 1 | 14 | 2 | 0% | 83% | 0/1 |
| confirm / ruling | 6 | 6 | 9 | 0 | 100% | 100% | 6/6 |
| confirm / hybrid | 9 | 7 | 8 | 2 | 87% | 98% | 6/7 |

### With segmentation set to AUTO (research only; `ocr.ts` unchanged)

| mode / signal | found | matched | missed | false pos | cell accuracy | text kept | exact grids |
|---|---|---|---|---|---|---|---|
| auto / geometry | 20 | 12 | 3 | 8 | 0% | 76% | 0/12 |
| auto / ruling | 8 | 8 | 7 | 0 | 88% | 93% | 7/8 |
| auto / hybrid | 19 | 14 | 1 | 5 | 49% | 84% | 7/14 |
| region / ruling | 9 | 9 | 6 | 0 | 89% | 94% | 8/9 |
| **region / hybrid** | **15** | **15** | **0** | **0** | **74%** | **84%** | **10/15** |
| confirm / hybrid | 10 | 8 | 7 | 2 | 71% | 95% | 6/8 |

Recall reaches 15/15 only once the segmentation is addressed. Cell accuracy falls from 91% to 74% at the same time, because the four newly-recovered tables are the scanned ones and they are the hard ones.

### False positives, the number that decides the UX

| mode / signal | false positives on 8 adversarial sheets | sheets affected | held for confirmation |
|---|---|---|---|
| auto / geometry | 10 | 7 | 0 |
| auto / ruling | **1** | 1 | 0 |
| auto / hybrid | 10 | 7 | 0 |
| region / any | **0** | 0 | 0 |
| confirm / geometry | 4 | 4 | 6 |
| confirm / ruling | **0** | 0 | 1 |
| confirm / hybrid | 3 | 3 | 7 |

What the full-auto hybrid detector reports on drawing content:

```
adv-full-sheet          3x4  conf 58     adv-legend         6x4  conf 69
adv-full-sheet         21x2  conf 65     adv-note-columns   5x2  conf 95
adv-full-sheet          3x2  conf 69     adv-scanned-sheet  3x3  conf 62
adv-full-sheet          4x2  conf 100    adv-title-block    5x3  conf 81
adv-grid-dimensions    3x10  conf 38     adv-keynote-list   7x3  conf 73
```

Two of these deserve naming:

- **`adv-note-columns` at confidence 95** — two independent columns of prose, one Japanese and one English, aligned because they are laid out side by side. Every geometric property of a table is present. It is not a table.
- **`adv-title-block` at confidence 81, and detected by the ruling signal too** — a title block with a divider between label and value is a closed ruled grid of label/value pairs. It is structurally identical to a two-column schedule. **No geometric rule separates them**, because there is no geometric difference; the difference is what the box means.

### Per-fixture, region mode

| fixture | source | cells correct (shipped OCR) | cells correct (AUTO) |
|---|---|---|---|
| `native-ruled-simple` | native | 12/12 | 12/12 |
| `native-ruled-mixed-types` | native | 20/20 | 20/20 |
| `native-borderless-aligned` | native | 12/12 | 12/12 |
| `native-blank-cells` | native | 13/13 | 13/13 |
| `native-multiline-cell` | native | 8/8 | 8/8 |
| `native-merged-header` | native | 13/13 | 13/13 |
| `native-sparse-table` | native | 11/11 | 11/11 |
| `mixed-table-and-drawing` | native | 12/12 | 12/12 |
| `scanned-borderless-simple` | OCR | 12/12 | 12/12 |
| `scanned-ruled-simple` | OCR | **no tokens** | 10/12 |
| `scanned-ruled-hires` | OCR | **no tokens** | 4/12 |
| `scanned-skew-noisy-table` | OCR | **no tokens** | 2/12 |

Native is exact. Scanned is not, even with the segmentation fixed: the words come back, but Japanese word segmentation splits them differently from the source, so exact cell text matches 2–10 of 12. Skew and noise cost the most.

### Blanks and merges

- `native-blank-cells` has **3 deliberately empty cells**; the reconstruction filled in **0** of them.
- `native-merged-header` has **3 spans**; the prototype reports **0** and reconstructs the surrounding cells from the ruled grid. It does not guess, because a wide token can be a span or a long value and there is no way to tell them apart from geometry.

## 6. Writing the workbook

`scripts/research-m2-4-xlsx-writers.mjs`.

### A. Hand-written OOXML with the JSZip already in `package.json`

**Six parts for a two-sheet workbook** — five, plus one per additional sheet:

```
[Content_Types].xml   _rels/.rels   xl/workbook.xml
xl/_rels/workbook.xml.rels   xl/worksheets/sheet1.xml   xl/worksheets/sheet2.xml
```

That is twice the M2-3 `.docx` package, and the difference is structural rather than incidental: a workbook has a second relationship layer, because sheets are parts that the workbook part points at by relationship ID. Strings are written as `inlineStr`, which removes the shared-strings part and the index that would have to stay consistent with it.

- **2,537 bytes** for 38 cells across 2 sheets, **byte-identical across runs** (`sha256 de04b50ac6b2f9fd…`), fixed zip date and `platform: 'DOS'`.
- Every part is well-formed with balanced tags; **no macro part, no `TargetMode="External"` relationship**.

There is no Excel and no LibreOffice on this machine, so **the package has not been opened in Microsoft Excel** and this spike does not claim it has. It was verified instead by two independent parsers installed in a throwaway directory:

| check | SheetJS | ExcelJS |
|---|---|---|
| opens the package | yes, 2 sheets | yes, 2 worksheets |
| Japanese sheet name `仕上表` | preserved | preserved |
| Japanese cell text `室名` | preserved | preserved |
| merged header | 3 merges reported | — |
| newline inside a cell | — | `"床仕上げは施工前に\n監理者の承認を得ること"` |
| `12` | number (`t: n`) | — |
| `001` | **string** (`t: s`), leading zero intact | — |

### B, C. The libraries

Read from the npm registry on 2026-09-06 and from the installed trees.

| | SheetJS (`xlsx`) | ExcelJS (`exceljs`) |
|---|---|---|
| version on npm | **0.18.5** | **4.4.0** |
| licence | Apache-2.0 | MIT |
| unpacked | 7,499,035 bytes | 21,825,509 bytes |
| runtime dependencies | 7 (`adler-32`, `cfb`, `codepage`, `crc-32`, `ssf`, `wmf`, …) | 9 (`archiver`, `dayjs`, `fast-csv`, `jszip`, `readable-stream`, `saxes`, …) |
| releases on npm | 108, `latest` = 0.18.5 | 166, newest published 4.4.1-prerelease.0 |
| npm listing last modified | 2026-07-17 | 2024-12-20 |
| browser build declared | yes | yes |
| deprecated on npm | no | no |

Installing both pulls **44,067,654 bytes across 88 top-level packages**.

Output size for the identical workbook: **hand-written 2,537 / ExcelJS 7,691 / SheetJS 18,601 bytes**.

Two open items a human should resolve before any adoption: the npm `latest` for `xlsx` is 0.18.5 while the project publishes from its own distribution channel — **whether the npm listing is the current supported artefact was not established here**; and ExcelJS's newest npm publication is a prerelease, with the last stable dated 2024-12-20.

### Value typing

13 strings taken from what a drawing actually contains. A cell "round-trips" when it still shows what the drawing showed.

| value | string | conservative | aggressive |
|---|---|---|---|
| `001` | text | text | num 1 — **identifier lost** |
| `1-2` | text | text | text |
| `2026.09` | text | num 2026.09 | num 2026.09 |
| `1:100` | text | text | text |
| `150A` | text | text | text |
| `D13@200` | text | text | text |
| `12` | text | num 12 | num 12 |
| `18500.50` | text | num 18500.5 — **trailing zero lost** | num 18500.5 |
| `0.5` | text | num 0.5 | num 0.5 |
| `2026.09.01` | text | text | text |
| `+3` | text | text | num 3 — **sign lost** |
| `1,200` | text | text | num 1200 — **value wrong** |
| `１２３` | text | text | text |

**Round-trip failures: string 0/13, conservative 1/13, aggressive 4/13.** Of those, the number itself is wrong in 1 case (aggressive, `1,200`). Restoring any of them needs an explicit number-format part, which this package does not write.

## 7. Cost

`scripts/research-m2-4-performance.mjs`. Reconstruction measured on synthesised token grids, so the new work is separated from the recognition the app already does.

| case | pages | tokens | ruling | geometry | build | zip | bytes | heap |
|---|---|---|---|---|---|---|---|---|
| small 10×5 | 1 | 50 | 0.6 ms | 0.9 ms | 0.4 ms | 5.7 ms | 1,833 | 2.5 MB |
| medium 100×10 | 1 | 1,000 | 2.3 ms | 9.5 ms | 0.7 ms | 5.0 ms | 5,407 | — |
| **large 1000×20** | 1 | 20,000 | **122.9 ms** | **2,104.6 ms** | 6.0 ms | 24.6 ms | 72,715 | 7.0 MB |
| multipage 40×8 | 20 | 6,400 | 5.7 ms | 12.4 ms | 1.5 ms | 11.9 ms | 34,528 | — |
| token-heavy 400×25 | 1 | 10,000 | 9.6 ms | 296.2 ms | 2.3 ms | 10.9 ms | 37,329 | 2.8 MB |

Recognition, for comparison, from the same corpus: **203–351 ms per scanned page at 150 DPI**, 583 ms at 300 DPI, 1,022 ms at 400 DPI.

- On a **scanned** document, reconstruction is a rounding error against OCR.
- On a **native** document, reconstruction is the whole cost, and by the ruling route it is small.
- **The geometry route does not scale.** 20,000 tokens takes 2.1 seconds on the main thread, because the prototype re-scores a growing block of rows for every row it adds. That is a property of this prototype rather than a law, but any implementation of the geometry route needs a bound on candidate growth and a yield *inside* the page, not only between pages.

## 8. Determinism

- Fixtures: generated twice, **44/44 files byte-identical** (22 PDFs + 22 answer keys).
- Detection results: run twice over the same token dumps, **identical** (`sha256 4dddab60f3a8e410…`).
- Workbook: built twice, **identical bytes** (`sha256 de04b50ac6b2f9fd…`).

## 9. Network

The browser probe records every request, including from inside the OCR worker via CDP. **External HTTP(S) requests: 0.** Every OCR asset is same-origin under `/ocr/`.

The npm registry was contacted by `research-m2-4-xlsx-writers.mjs` to read package metadata and install two candidates into a temporary directory. That is a research-time lookup on this machine; it says nothing about the runtime, which made no external request at all.
