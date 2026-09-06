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

Three results in the first revision of this document were wrong or overstated, and are corrected below rather than quietly replaced. They are marked **CORRECTED**.

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

### 2.1 Transform-correct token boxes — **CORRECTED**

A run's extent follows the text, not the screen. `item.transform` is `[a,b,c,d,e,f]`, where `(a,b)` is the baseline direction in user space and `(c,d)` the direction glyphs rise in — both already carrying the font size. `item.width` and `item.height` are lengths **along those two directions**. So the run occupies the parallelogram

```
P(s,t) = (e,f) + s · (a,b)/|(a,b)| + t · (c,d)/|(c,d)|     for s ∈ [0, width], t ∈ [0, height]
```

and its display box is the axis-aligned bound of that quad's four corners after `viewport.transform` is applied.

The first revision of this probe took `x0 = tx[4]` from the composed matrix and set `x1 = x0 + item.width`, which lays every run along display **x**. That is correct only while the page is upright. Measured run direction on screen, per rotation:

| `/Rotate` | viewport | viewport transform (measured) | text runs |
|---|---|---|---|
| 0 | 595.28 × 841.89 | `[1,0,0,-1,0,841.89]` | `[1,0]` → right |
| 90 | 841.89 × 595.28 | `[0,1,1,0,0,0]` | `[0,1]` → **down** |
| 180 | 595.28 × 841.89 | `[-1,0,0,1,595.28,0]` | `[-1,0]` → **left** |
| 270 | 841.89 × 595.28 | `[0,-1,-1,0,841.89,595.28]` | `[0,-1]` → **up** |

On a 90-degree page the baseline runs down the display, and a run laid out along display x lands somewhere the text never was.

Each fixture's answer key records the viewport transform it assumes, and the gate requires it to equal the one pdf.js actually produced. All four match.

### 2.2 Rotation needs a second step — **CORRECTED**

Transform-correct boxes are necessary and **not sufficient**. Rows are grouped by vertical overlap and columns by shared left edges; on a 90-degree page what the table calls a row runs down the display, so grouping in display space returns the transpose — every cell present, every cell in the wrong place.

So reconstruction happens in the page's upright space. Undoing pdf.js's `R(user)` gives, with `W` and `H` the page's own width and height:

```
  0 → (dx, dy)          90 → (dy, H − dx)
180 → (W − dx, H − dy)  270 → (W − dy, dx)
```

Measured at cell level, one logical table drawn on four pages:

| `/Rotate` | grid | cells | exact grid |
|---|---|---|---|
| 0 | 4×3 | 12/12 | yes |
| 90 | 4×3 | 12/12 | yes |
| 180 | 4×3 | 12/12 | yes |
| 270 | 4×3 | 12/12 | yes |
| 90, **skipping the un-rotation** | — | **0/12** | no |

The first revision claimed the viewport transform "handles rotation without any hand-written case analysis" and checked it by counting token centres inside the outer table box — which passes whether or not the grid is transposed. It does not hold. **Rotation is supported, and it takes both steps.**

### 2.3 Two more properties of the token stream

- **`hasEOL` is not usable as a line break.** Across the whole corpus, **0 tokens** report `hasEOL: true`. It exists on every item and is false on every item.
- **Whitespace items have height 0.** **195 of 603** native items are whitespace-only, every one with `height === 0`. Left in, each becomes a zero-height "row" and splits the row it sits in: a four-row table groups as twelve. They must be dropped before grouping.
- **Token fragmentation is real.** `native-ruled-mixed-types` splits each cell into two drawn runs and yields 42 tokens for 20 cells.

## 3. Ruling lines from the vector content

Recovered from `page.getOperatorList()` without rasterising anything.

pdf.js 5.x changed the shape of `constructPath`: the arguments are `[paintOp, [flat path data], minMax]`, where the path data is a flat `[opcode, ...coords]` array — for one rectangle:

```
[0, 0,0, 1, 0,82, 1, 0.8,82, 1, 0.8,0, 4]   minMax [0, 0, 0.8, 82]
```

The decoder is checked against the `minMax` pdf.js computed for the same call: if the decoded bounding box does not match, the decode is declared wrong rather than reported. **All decoded paths across the corpus matched, 0 fell back to the bounding box, 0 non-axis-aligned segments.**

| fixture | horizontal | vertical |
|---|---|---|
| `native-ruled-simple` | 18 | 18 |
| `native-merged-header` | 50 | 50 |
| `adv-title-block` | 28 | 28 |
| `adv-grid-dimensions` | 118 | 118 |
| `adv-full-sheet` | 150 | 150 |
| `native-borderless-aligned` | 0 | 0 |

Vector lines are cheap and exact where they exist. **They also exist in quantity on drawing content that is not a table** — the last three rows are the problem this spike is about.

## 4. OCR geometry

On the tested ruled-table fixtures, the pipeline as it ships returns **no text from inside the table**.

| input | words | inside the table | mean confidence |
|---|---|---|---|
| `scanned-ruled-simple` (150 DPI) | 5 | **0** | 92 |
| the same at 300 DPI | 5 | **0** | 91 |
| the same at 400 DPI | 5 | **0** | 91 |
| the same scan at 2× resolution, rendered at 300 DPI | 6 | **0** | 78 |
| **the same table with its ruling lines removed** | 34 | **29** | 88 |

Resolution is not the cause: re-rendering carries no new detail, and a genuinely higher-resolution scan changes nothing. Removing the ruled box changes everything. A segmentation sweep locates it:

| mode | `scanned-ruled-simple` | `adv-scanned-sheet` (a drawing, no table) |
|---|---|---|
| **DEFAULT (unset, as shipped)** | **5 words, conf 92** | **37 words, conf 64** |
| `SINGLE_BLOCK` (psm 6) | **5 words, conf 92** | **37 words, conf 64** |
| `AUTO` (psm 3) | 37 words, conf 91 | 23 words, conf 75 |
| `SPARSE_TEXT` (psm 11) | 36 words, conf 90 | 28 words, conf 78 |
| `SPARSE_TEXT_OSD` (psm 12) | 36 words, conf 89 | 28 words, conf 73 |
| `SINGLE_COLUMN` (psm 4) | 38 words, conf 91 | 24 words, conf 81 |

### 4.1 How strongly "the default is SINGLE_BLOCK" is evidenced — **CORRECTED**

The first revision called the default "byte-for-byte SINGLE_BLOCK" while comparing only word count and mean confidence. The comparison is now the **whole token stream** — text, box to a tenth of a point, and confidence, in order, hashed:

```
DEFAULT       sha256 386855193ee8…
SINGLE_BLOCK  sha256 386855193ee8…   identical
AUTO          sha256 1a6d8a173eff…   different, so the comparison can fail
```

`ocr.ts` does not set `tessedit_pageseg_mode`, and tesseract.js's documented default is `PSM.SINGLE_BLOCK`. The local measurement corroborates that on these fixtures; it does not establish it for every input.

### 4.2 What may and may not be claimed

- **May:** on the tested synthetic ruled-table fixtures, ruled-table content is lost under the current segmentation.
- **May:** the same content is recovered when segmentation is set explicitly.
- **May not:** that *every* ruled box or *every* schedule in every real drawing is affected. This corpus is synthetic and small.
- **May:** that this affects shipped features, not only M2-4 — Text Extraction and the searchable-PDF export take the same path.
- **May:** that no single mode wins everywhere. On the ruled table the default recovers 0 cell words and `AUTO` recovers them all; on the drawing sheet the default finds 37 and `AUTO` finds 23.

## 5. Detection

`scripts/research-m2-4-tables.mjs`. 18 ground-truth tables across 17 fixtures; 8 adversarial sheets whose correct answer is zero tables. Region matching is IoU ≥ 0.5; a cell is correct when its text matches at its own row and column.

Reported in four sections that must not be read as one.

> **CORRECTED.** The first revision reported a single "region mode" figure of **0 false positives**. That was an artefact of the harness: region mode selected the ground-truth box, and on a page with no table there was no box to select, so no false positive was possible. It measured the scaffolding, not the reconstructor. Everything below replaces it.

### 5.1 Full-auto baseline — nothing asked of the user

| signal | found | matched | missed | FP | cell accuracy | exact | FP on 8 drawing sheets |
|---|---|---|---|---|---|---|---|
| geometry | 18 | 10 | 8 | 8 | 1% | 0 | **11** (7 sheets) |
| ruling | 11 | 11 | 7 | 0 | 74% | 8 | **1** (1 sheet) |
| hybrid | 18 | 13 | 5 | 5 | 63% | 8 | **11** (7 sheets) |

With segmentation set to AUTO, ruling reaches 11/11 matched at **100% cell accuracy**, still missing the 7 borderless and scanned-borderless tables it cannot see.

### 5.2 Oracle region baseline — a ceiling, and nothing else

Handing the reconstructor the exact answer box: **173/229 cells (76%), 14 exact grids, 0 fabricated, 0 blanks filled.** With AUTO segmentation, 190/229 (83%).

This is an upper bound on reconstruction quality. It says nothing about what a user would get, and it cannot produce a false positive on a page with no table, because there is nothing to hand over.

### 5.3 User-selection robustness — the same tables, selected imperfectly

Sixteen deterministic variants per table. All offsets fixed and documented in `prototype/selection.mjs`: expand +4/+12/+24 pt, shrink −2/−4 pt, shift ±4 pt in x and y, over-selection +60/+120 pt, and under-selection cutting off the left border, the right border, the first row, the last row, or one point inside every edge.

Three selection policies, because the choice between them matters more than the detector does:

- **strict** — the rectangle is the world; tokens and ruling lines are clipped to it.
- **snap** — find the grids on the page, take the one the user pointed at.
- **assist** — snap to an enclosing ruled grid when the selection sits on one; otherwise read strictly inside the rectangle.

| family | n | strict | snap | assist |
|---|---|---|---|---|
| oracle | 18 | 173/229 (76%) | 137/229 (60%) | **173/229 (76%)** |
| robustness | 162 | 1057/2061 (51%) | 1233/2061 (60%) | **1514/2061 (73%)** |
| under-selection | 90 | 390/1145 (34%) | 685/1145 (60%) | **792/1145 (69%)** |
| over-selection | 36 | 298/458 (65%) | 274/458 (60%) | **298/458 (65%)** |

Per variant, cells correct out of 229:

| selection | strict | snap | assist |
|---|---|---|---|
| expand +4 | 173 (76%) | 137 (60%) | **173 (76%)** |
| expand +12 | 173 (76%) | 137 (60%) | **173 (76%)** |
| expand +24 | 161 (70%) | 137 (60%) | 161 (70%) |
| shrink −2 | 118 (52%) | 137 (60%) | **173 (76%)** |
| shrink −4 | 118 (52%) | 137 (60%) | **173 (76%)** |
| shift x +4 | **24 (10%)** | 137 (60%) | 161 (70%) |
| shift x −4 | 129 (56%) | 137 (60%) | 169 (74%) |
| shift y +4 | **24 (10%)** | 137 (60%) | 161 (70%) |
| shift y −4 | 137 (60%) | 137 (60%) | 170 (74%) |
| over +60 | 149 (65%) | 137 (60%) | 149 (65%) |
| over +120 | 149 (65%) | 137 (60%) | 149 (65%) |
| omit left border | **0 (0%)** | 137 (60%) | 137 (60%) |
| omit right border | 126 (55%) | 137 (60%) | 166 (72%) |
| omit first row | **12 (5%)** | 137 (60%) | 149 (65%) |
| omit last row | 134 (59%) | 137 (60%) | 167 (73%) |
| clip 1 pt inside | 118 (52%) | 137 (60%) | **173 (76%)** |

Two conclusions, neither visible while the oracle stood in for a user.

**Strict clipping is unusable.** A box four points to the right of the table loses 90% of its cells; a box that misses the left border loses all of them. The cause is not subtle: the table's own ruling lines fall outside the rectangle, so its cells are no longer closed and the ruled grid is gone.

**Snapping fixes it, and it is what an implementation would do anyway.** Under `assist` the selection identifies *which* table, not where its edges are. Fabricated cells across the robustness family fall from 17 (strict) and 108 (snap) to **1** (assist).

By source, assist policy, across every selection variant:

| | shipped OCR | segmentation AUTO |
|---|---|---|
| native pages | **2627/2737 (96%)** | **2627/2737 (96%)** |
| scanned pages | 150/1156 (13%) | 368/1156 (32%) |

On native pages the reconstruction is effectively insensitive to how the box is drawn. On scanned pages it is poor whatever the box.

### 5.4 Adversarial explicit selection — a box drawn around something that is not a schedule

A user can drag a rectangle around a title block. The honest question is what happens then, and the answer is not "the detector knows better".

| fixture | grid | confidence | status |
|---|---|---|---|
| `adv-full-sheet` | 10×2 | 72 | **TABLE_CONFIDENT** |
| `adv-keynote-list` | 7×2 | 80 | **TABLE_CONFIDENT** |
| `adv-legend` | 6×3 | 72 | **TABLE_CONFIDENT** |
| `adv-note-columns` | 5×2 | **95** | **TABLE_CONFIDENT** |
| `adv-title-block` | 6×2 | 63 | TABLE_NEEDS_CONFIRMATION |
| `adv-grid-dimensions` | 3×6 | 44 | TABLE_NEEDS_CONFIRMATION |
| `adv-scanned-sheet` | 3×3 | 62 | TABLE_NEEDS_CONFIRMATION |
| `adv-room-labels` | — | — | NO_TABLE |

**4 of 8 reach TABLE_CONFIDENT.** Selecting a region does not make the result safe; it only makes the result *asked for*. Two aligned columns of notes score 95 — higher than several real tables — and a legend and a keynote list both clear a confidence gate.

The safety of this feature therefore does not come from detector semantics. It comes from the user seeing what was reconstructed and confirming it before anything is written. That is the load-bearing conclusion of this spike.

### 5.5 Per fixture, assist policy, oracle box

| fixture | source | shipped OCR | AUTO |
|---|---|---|---|
| `native-ruled-simple` | native | 12/12 | 12/12 |
| `native-ruled-mixed-types` | native | 20/20 | 20/20 |
| `native-borderless-aligned` | native | 12/12 | 12/12 |
| `native-blank-cells` | native | 13/13 | 13/13 |
| `native-multiline-cell` | native | 8/8 | 8/8 |
| `native-merged-header` | native | 13/13 | 13/13 |
| `native-sparse-table` | native | 11/11 | 11/11 |
| `native-rotate-000 / 090 / 180 / 270` | native | 12/12 each | 12/12 each |
| `mixed-table-and-drawing` | native | 12/12 | 12/12 |
| `scanned-borderless-simple` | OCR | 12/12 | 12/12 |
| `scanned-ruled-simple` | OCR | **0/12** | 10/12 |
| `scanned-ruled-hires` | OCR | **0/12** | 4/12 |
| `scanned-skew-noisy-table` | OCR | **0/12** | 2/12 |

### 5.6 Blanks and merges

- `native-blank-cells` has **3 deliberately empty cells**; the reconstruction filled in **0**.
- `native-merged-header` has **3 spans**; the prototype reports **0** and reconstructs the surrounding cells from the ruled grid. It does not guess, because a wide token can be a span or a long value and geometry cannot tell them apart.

## 6. Writing the workbook

`scripts/research-m2-4-xlsx-writers.mjs`.

### A. Hand-written OOXML with the JSZip already in `package.json`

**Six parts for a two-sheet workbook** — five, plus one per additional sheet:

```
[Content_Types].xml   _rels/.rels   xl/workbook.xml
xl/_rels/workbook.xml.rels   xl/worksheets/sheet1.xml   xl/worksheets/sheet2.xml
```

Twice the M2-3 `.docx` package, and the difference is structural: a workbook has a second relationship layer, because sheets are parts the workbook part points at by relationship ID. Strings are written as `inlineStr`, which removes the shared-strings part and the index that would have to stay consistent with it.

- **2,537 bytes** for 38 cells across 2 sheets, **byte-identical across runs** (`sha256 de04b50ac6b2f9fd…`), fixed zip date and `platform: 'DOS'`.
- Every part is well-formed with balanced tags; **no macro part, no `TargetMode="External"` relationship**.

There is no Excel and no LibreOffice on this machine, so **the package has not been opened in Microsoft Excel** and this spike does not claim it has. It was verified instead by three independent parsers installed in a throwaway directory:

| check | SheetJS CE 0.20.3 | SheetJS 0.18.5 (npm) | ExcelJS 4.4.0 |
|---|---|---|---|
| opens the package | 2 sheets | 2 sheets | 2 worksheets |
| Japanese sheet name `仕上表` | preserved | preserved | preserved |
| Japanese cell text `室名` | preserved | preserved | preserved |
| merged header | 3 merges | 3 merges | — |
| newline inside a cell | preserved | — | preserved |
| blank cell | reads back absent, not as a value | — | — |
| `12` / `001` | number / **string** | number / **string** | — |

### B, C. The candidate libraries — **CORRECTED**

The first revision measured only the npm registry artefact and reported `xlsx@0.18.5` as the SheetJS candidate. **SheetJS is not distributed through npm any more**: the registry still resolves `xlsx` and its `latest` is 0.18.5, but the project publishes Community Edition from its own host. Both are now measured and both are labelled.

| | **SheetJS CE (official CDN)** | SheetJS npm (legacy) | ExcelJS (npm) |
|---|---|---|---|
| version | **0.20.3** | 0.18.5 | 4.4.0 |
| source | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` | npm `latest` | npm `latest` |
| licence | Apache-2.0 | Apache-2.0 | MIT |
| on disk | 8,076,339 bytes | 7,499,035 bytes | 21,825,509 bytes |
| runtime dependencies | **0** | 7 (`adler-32`, `cfb`, `codepage`, `crc-32`, `ssf`, `wmf`, …) | 9 (`archiver`, `dayjs`, `fast-csv`, `jszip`, `readable-stream`, `saxes`, …) |
| browser build | yes | yes | yes |
| ESM entry | `xlsx.mjs` | — | — |
| npm listing last modified | n/a | 2026-07-17 | 2024-12-20 |
| releases on npm | n/a | 108, `latest` 0.18.5 | 166, newest published 4.4.1-prerelease.0 |
| deprecated on npm | n/a | no | no |
| output, same workbook | 18,601 bytes | 18,601 bytes | 7,691 bytes |

Hand-written output for the same workbook: **2,537 bytes**.

CE 0.20.3 is a materially better package than the npm artefact — same licence, **no runtime dependencies at all**, an ESM entry point and a browser build. It is still 8 MB of library to write a 2.5 KB file with, and the hand-written writer already passes every content check CE does.

### Value typing

13 strings taken from what a drawing contains. A cell "round-trips" when it still shows what the drawing showed.

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

**Round-trip failures: string 0/13, conservative 1/13, aggressive 4/13.** Of those, the number itself is wrong in 1 case. Restoring any of them needs an explicit number-format part, which this package does not write.

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
- **The geometry route does not scale.** 20,000 tokens takes 2.1 seconds on the main thread, because the prototype re-scores a growing block of rows for every row it adds. A property of this prototype rather than a law, but any implementation of the geometry route needs a bound on candidate growth and a yield *inside* the page.

## 8. Determinism

- Fixtures: generated twice, **byte-identical** across the whole corpus.
- Detection results: run twice over the same token dumps, **identical**.
- Workbook: built twice, **identical bytes** (`sha256 de04b50ac6b2f9fd…`).

## 9. Network

The browser probe records every request, including from inside the OCR worker via CDP. **External HTTP(S) requests: 0.** Every OCR asset is same-origin under `/ocr/`.

`research-m2-4-xlsx-writers.mjs` contacted the npm registry for package metadata and installed two candidates into a temporary directory, and fetched the SheetJS CE tarball from `cdn.sheetjs.com`. Those are research-time lookups on this machine; they say nothing about the runtime, which made no external request at all.
