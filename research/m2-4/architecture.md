# M2-4 — browser-local Excel table reconstruction: architecture

A spike, not an implementation. It exists to answer whether M2-4 should be built, in what shape, and what it must refuse to do. Every claim below is backed by a number in [`measurements.md`](./measurements.md); the corpus is described in [`fixtures.md`](./fixtures.md); the alternatives are compared in [`decision-matrix.md`](./decision-matrix.md).

**Nothing in `src/` changed. No dependency was added. The Excel option in the UI is still disabled.**

This is the second revision. An independent review found that the first one's central number — "user-selected region: 0 false positives" — was an artefact of the harness rather than a property of the reconstructor. That is corrected here, and it changes what the recommendation rests on, though not the recommendation itself.

---

## Recommendation

> ### RECOMMEND REVISE
>
> Build M2-4 as: **the user points at a table, the reconstruction snaps to the ruled grid there, and nothing is written until the user has seen the result and confirmed it.**
>
> Preview and explicit confirmation are **not** a nicety on top. They are the only safety mechanism the evidence supports.

Three findings decide the shape, and the third is new.

**1. Full-auto extraction is not viable here.** Across 8 adversarial drawing sheets, full-page detection invents **11 tables** on 7 of them. Confidence does not separate them: two aligned columns of notes score 95, a keynote list 80, a legend 72 — overlapping the real tables. Raising the threshold rejects real schedules too.

**2. A user-drawn rectangle is workable, but only if the implementation snaps.** Handed a rectangle and told to treat it as the world, the reconstructor is fragile: a box four points off loses 90% of its cells, and a box that clips the left border loses all of them, because the table's own ruling lines fall outside it. Snapping to the enclosing ruled grid removes that dependence almost entirely — across every selection variant tested, **96% of cells on native pages**, with 1 fabricated cell instead of 17.

**3. Selecting a region does not make the answer safe.** This is the correction. When a rectangle is drawn deliberately around a title block, a legend, a keynote list or two columns of notes, **4 of 8 reach `TABLE_CONFIDENT`** — they would export with no further question asked. The selection makes the result *asked for*; it does not make it *right*.

So safety cannot come from the detector's semantics, and it cannot come from a confidence threshold. It comes from the user seeing the reconstructed grid and confirming it.

## What `TABLE_CONFIDENT` may be taken to mean

Given the above, the status names have to be honest about their scope.

`TABLE_CONFIDENT` means: **a closed grid was found, its cells are consistently filled, and the reconstruction is structurally sound.** It does *not* mean the content is a schedule. A title block, a legend and a pair of note columns all produce structurally sound grids, because structurally they are grids.

It follows that `TABLE_CONFIDENT` must not be an export gate. It is a hint about how much editing the preview will need — nothing more.

## Why the traps cannot be filtered out

An architectural sheet is *made of* table-shaped things that are not tables.

- **A title block with a divider between label and value is a closed ruled grid of label/value pairs.** Not similar to a two-column schedule — the same structure. The difference is what the box means.
- **Two aligned columns of notes, Japanese beside English, score 95** — higher than several real tables. Every geometric property of a table is present.

No geometric rule separates these from a schedule, because there is no geometric difference to find. The user, looking at the sheet, resolves it instantly. That is the whole argument for a user-directed design — and the same argument says the user must also confirm what came back.

## Rotation: supported, and it takes two steps

The first revision claimed pdf.js's viewport transform "handles rotation", and checked it by counting token centres inside the outer table box — a check that passes whether or not the grid is transposed. Measured properly, at cell level:

| step | `/Rotate 90` result |
|---|---|
| naive: display x + `item.width` | boxes land off the page |
| transform-correct token quads only | **0 of 12 cells** — the grid is the transpose |
| transform-correct quads **and** un-rotation to upright space | **12 of 12 cells, exact grid** |

All four of 0°, 90°, 180° and 270° then reconstruct identically (4×3, 12/12, exact). Each answer key records the viewport transform it assumes and the gate holds it to the one pdf.js produced.

**Rotated pages are supported in the MVP**, provided both steps are implemented. Rotated *text inside a cell* is not in scope.

## What must be fixed before scanned pages work at all

On the tested ruled-table fixtures, the pipeline **returns no text from inside the table** — 0 words at every resolution. The same table with its ruling lines removed reads normally (29 words). `ocr.ts` does not set `tessedit_pageseg_mode`; tesseract.js's documented default is `SINGLE_BLOCK`, and locally the unset default produces a **token stream identical by digest** to `SINGLE_BLOCK`, while `AUTO` recovers the cell text (5 words → 37).

Bounded honestly: this is measured on synthetic ruled-table fixtures. It is not established that every ruled box in every real drawing is affected. What is established is that ruled-table content *can* be lost under the current segmentation, and that the same path is used by shipped features — Text Extraction and the searchable-PDF export.

Two consequences:

1. **It is a pre-existing defect, not one M2-4 introduces.** It should be raised and fixed on its own terms. This spike does not change `ocr.ts`; the sweep runs on a research-only worker.
2. **No single segmentation is correct.** The default loses the table; `AUTO` loses a third of the drawing sheet. A per-region choice exists in the user-directed design and does not exist in the full-page one.

Even unblocked, scanned reconstruction is weak: **32% of cells** across selection variants with `AUTO`, against **96%** for native. **Scanned pages stay out of the MVP.**

## Existing architecture: what is kept and what is thrown away

| stage | geometry in hand | what survives |
|---|---|---|
| `extractNativeText()` | every `TextItem` has a full transform | `item.str` concatenated. **All coordinates discarded.** |
| `OcrEngine.recognisePage()` | word boxes in a block/paragraph/line tree | text + bbox + confidence; **line grouping discarded** |
| `extractTextPdf()` scanned branch | `ocr.words` is right there | only `ocr.text`; **the boxes are dropped** |
| `preprocessForOcr()` | returns `mapToRenderSpace` | used by the M1 searchable-PDF path, never by text extraction |

**Both pipelines already compute the geometry and then discard it.** Nothing new has to be extracted; something already extracted has to stop being thrown away.

The corollary rules out one design explicitly: **an architecture that recovers tables from `ExtractedPage.text` cannot work.** That string has no geometry, and the information that makes a table a table was destroyed one function earlier.

Two token-stream properties any implementation must handle, both measured: `hasEOL` is false on every item in the corpus, so line structure must come from geometry; and **195 of 603 native items are whitespace-only with `height === 0`** — left in, each becomes a zero-height row and a four-row table groups as twelve.

## Proposed shape

```
PDF
 └─ page classification                      (exists: classify.ts)
     ├─ native → tokens with geometry        (exists, then discarded: extract.ts)
     └─ scanned → render, preprocess, OCR    (exists, boxes discarded — and blocked)
 └─ un-rotate to the page's upright space    NEW — required, not optional
 └─ user drags a rectangle over one table    NEW — says WHICH table
 └─ snap to the enclosing ruled grid         NEW — the robustness comes from here
 └─ grid reconstruction
 └─ status: structural confidence only
 └─ PREVIEW, edit, explicit confirmation     NEW — the only safety mechanism
 └─ workbook model → .xlsx                   NEW — JSZip, no new dependency
```

## Fail-safe model

The default must not be "produce a spreadsheet anyway". A spreadsheet looks authoritative in a way a wrong text file does not: nobody re-reads a cell to check whether a row was invented.

| status | when | what happens |
|---|---|---|
| `TABLE_CONFIDENT` | a closed grid, consistently filled | previewed, **still requires confirmation** |
| `TABLE_NEEDS_CONFIRMATION` | structure found, boundaries unstable or spans ambiguous | previewed, marked, requires confirmation |
| `NO_TABLE` | nothing table-shaped in the selection | said plainly |
| `UNSUPPORTED_LAYOUT` | fewer than two rows or columns, overlapping tokens, a selection spanning table and drawing | said plainly, with the reason |

Three refusals the prototype implements and the measurements confirm:

- **Blank cells stay blank.** 3 deliberately empty cells, 0 filled in.
- **Merged cells are never invented.** 3 spans in the source, 0 claimed.
- **Values are not reinterpreted.** String-first: 0 of 13 drawing values fail to round-trip, against 4 of 13 under aggressive typing.

## Writer

**Hand-written OOXML, zipped with the JSZip already in `package.json`. No new dependency.**

Six parts for a two-sheet workbook, 2,537 bytes, byte-identical across runs, opened successfully by **three** independent parsers — SheetJS CE 0.20.3, SheetJS 0.18.5 and ExcelJS 4.4.0 — with Japanese sheet names, Japanese cell text, merged ranges, embedded newlines, blank cells and `001`-as-text all intact.

The candidate comparison was refreshed against the project's own distribution rather than the npm registry. **SheetJS CE 0.20.3** (Apache-2.0, 8.1 MB, **zero runtime dependencies**, ESM entry, browser build) is a materially better package than the npm `xlsx@0.18.5` the first revision measured (7 dependencies). It is still 8 MB of library to write a 2.5 KB file, and the hand-written writer passes every content check CE does.

**Recommendation unchanged: adopt no dependency.** If number formats, styling or formulas later become requirements, revisit against the then-current CE release.

**Not verified in Microsoft Excel.** There is no Excel and no LibreOffice on this machine. Three parsers accepting the bytes is good evidence and is not the same claim.

## Proposed MVP

1. User opens PDFテキスト化, picks a page, drags a rectangle over a table.
2. The page is un-rotated; the selection snaps to the enclosing ruled grid if there is one.
3. The grid is shown as an editable preview with its status.
4. **The user confirms.** Nothing is written before that, whatever the status says.
5. One `.xlsx`, one sheet per confirmed table, string-first values, blanks preserved, merges not invented.

## Explicitly unsupported in the MVP

- Whole-document automatic table extraction.
- Export without preview and confirmation.
- Merged-cell inference.
- Number, date and currency typing (values are text).
- Styling, column widths, formulas.
- Tables split across pages.
- Rotated **text** inside a cell (a rotated *page* is supported).
- Scanned pages, **until the segmentation defect is fixed** — and even then, at 32% measured cell accuracy, they need their own decision.

## Key risks

1. **The preview and confirmation UI is the feature.** Reconstruction is milliseconds; selection, preview, editing and confirmation is a piece of work in its own right and is not costed here.
2. **Users will select things that are not schedules**, and 4 of 8 such selections currently look confident. The preview must present the reconstruction as a proposal, never as a result.
3. **The segmentation defect gates scanned pages** and is a pre-existing bug in shipped features.
4. **Scanned accuracy may not be acceptable even once unblocked** — 32%.
5. **The geometry route does not scale** — 2.1 s for 20,000 tokens. Needed only for borderless tables; needs a bound and an in-page yield.
6. **A spreadsheet carries more authority than a text file.** Every wrong cell is a defect that looks like data.

## Required human decisions

1. Accept **REVISE**: user-selected region, snap-to-grid, and mandatory preview and confirmation.
2. Accept that `TABLE_CONFIDENT` is a structural statement and **cannot** be an export gate.
3. Decide whether the OCR segmentation defect is fixed first, separately, as a bug in M2-1/M2-2.
4. Decide whether scanned pages are in the MVP at all, given 32%.
5. Confirm **string-first values**, accepting that `12` arrives in Excel as text.
6. Confirm **no new dependency** (SheetJS CE 0.20.3 was re-evaluated and is not recommended).
7. Decide whether Microsoft Excel verification is required before release, and on whose machine.
