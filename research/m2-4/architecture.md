# M2-4 — browser-local Excel table reconstruction: architecture

A spike, not an implementation. It exists to answer whether M2-4 should be built, in what shape, and what it must refuse to do. Every claim below is backed by a number in [`measurements.md`](./measurements.md); the corpus it was measured on is described in [`fixtures.md`](./fixtures.md); the comparison of the alternatives is in [`decision-matrix.md`](./decision-matrix.md).

**Nothing in `src/` changed. No dependency was added. The Excel option in the UI is still disabled.**

---

## Recommendation

> ### RECOMMEND REVISE
>
> Build M2-4, but not as "press Excel and get every table in the document". Build it as **the user points at a table and gets that table**, with the reconstruction refusing to answer when it is not sure.

The measurements do not support full-page automatic extraction on architectural drawings, and they do support user-directed reconstruction. The difference between the two is not a matter of tuning:

| | full-page automatic | user-selected region |
|---|---|---|
| false tables on 8 drawing sheets | **10** | **0** |
| cell accuracy on native tables | 0–71% | **91%** |
| exact grids | 7 of 10 | **10 of 11** |

A confidence gate narrows the gap (10 → 3 false positives) without closing it, and it costs recall: 7 real candidates were held back on the same run.

## Why full-auto fails here, and why it is not a threshold problem

An architectural sheet is *made of* table-shaped things that are not tables. The corpus contains eight of them, and the detector's output on two is worth stating plainly:

- **A title block with a divider between label and value is a closed ruled grid of label/value pairs.** It is not merely similar to a two-column schedule — it is the same structure. It was detected at confidence 81 by the geometry route and again by the ruling route. No geometric rule can separate them, because there is no geometric difference to find. The difference is what the box *means*.
- **Two aligned columns of notes, Japanese beside English, scored confidence 95** — higher than several real tables. They are the most table-shaped thing on the sheet and are not a table at all.

A column grid, a legend, a keynote list and a dimension string are all similarly shaped. Raising the threshold until these are rejected also rejects real schedules; the two populations are not separable by the features available.

The user, looking at the sheet, resolves all of this in one gesture. That is the architecture: **let the user supply the one piece of information the geometry does not contain.**

## What has to be fixed before scanned pages work at all

The pipeline as it ships **returns no text from inside a ruled table on a scanned page**. Zero words, at every resolution tested. The same table with its ruling lines removed is read normally (29 words inside the table).

The cause is measured, not guessed: `tesseract.js` leaves segmentation at its default, and that default behaves byte-for-byte as `SINGLE_BLOCK` (psm 6). Setting `AUTO` recovers the cell text (5 words → 37).

Two things follow.

1. **This is a pre-existing defect in shipped features**, not something M2-4 introduces. Text Extraction and the searchable-PDF export lose the contents of every ruled box on a scanned page — on an architectural drawing that means the title block and every schedule. It should be raised and fixed on its own terms, separately from M2-4, and it is out of this spike's scope to change.
2. **There is no single correct segmentation.** On the ruled table the default finds 0 of the cell words and `AUTO` finds them all; on a drawing sheet the default finds 37 words and `AUTO` finds 23. Choosing one mode for every page trades one loss for another. A per-region choice is available in the user-directed architecture and is not available in the full-page one — which is a second, independent reason the recommendation points the same way.

Until it is addressed, **M2-4 on scanned pages cannot work**. With it addressed, scanned reconstruction is possible but weaker than native: 2–10 of 12 cells exact, against 12 of 12 for the same table drawn natively.

## Proposed shape

```
PDF
 └─ page classification                     (exists: classify.ts)
     ├─ native → tokens with geometry       (exists, then discarded: extract.ts)
     └─ scanned → render, preprocess, OCR   (exists, boxes then discarded: ocr.ts)
 └─ user selects a region on one page       NEW — the load-bearing step
 └─ ruling lines inside the region          NEW — from getOperatorList()
 └─ grid reconstruction                     NEW
 └─ status: confident / needs confirmation / unsupported
 └─ preview grid, editable before export    NEW
 └─ workbook model → .xlsx                  NEW — JSZip, no new dependency
```

Two properties of the existing code make this cheaper than it looks, and one makes it more expensive.

**Cheaper.** Both pipelines already compute the geometry and then throw it away — `extractNativeText()` keeps `item.str` and drops the transform; the scanned branch keeps `ocr.text` and drops `ocr.words`. Nothing new has to be extracted; something already extracted has to stop being discarded. And `preprocess.ts` already returns `mapToRenderSpace`, which is what puts deskewed OCR boxes back into page space — it is simply not called by the text-extraction path today.

**More expensive.** `ExtractedPage.text` is a plain string. An architecture that tries to find tables in *that* cannot work, and this is the one design that must be ruled out explicitly: the information a table is made of has already been destroyed by the time that string exists. Table reconstruction has to branch earlier, from tokens, not later, from text.

## Fail-safe model

The default must not be "produce a spreadsheet anyway". A spreadsheet looks authoritative in a way a wrong text file does not: nobody re-reads a cell to check whether a row was invented.

| status | when | what the user gets |
|---|---|---|
| `TABLE_CONFIDENT` | closed ruled grid, cells filled consistently | the grid, previewed before export |
| `TABLE_NEEDS_CONFIRMATION` | structure found but column boundaries unstable, or ambiguous spans | the grid, marked, not exportable until confirmed |
| `NO_TABLE` | nothing table-shaped in the selection | told so, plainly |
| `UNSUPPORTED_LAYOUT` | fewer than two rows or columns; overlapping tokens; a selection spanning table and drawing | told so, and told why |

Three refusals the prototype already implements and the measurements confirm:

- **Blank cells stay blank.** 3 deliberately empty cells in the corpus, 0 filled in. A cell left empty in a schedule is information.
- **Merged cells are never invented.** The merged-header fixture has 3 spans; the prototype claims 0 and reconstructs the rest from the ruled grid. A wide token can be a span or a long value, and nothing in the geometry distinguishes them.
- **Values are not reinterpreted.** String-first: 0 of 13 drawing values fail to round-trip. Conservative numeric typing loses 1 (`18500.50` → `18500.5`); aggressive typing loses 4, including `1,200` → `1200` and `001` → `1`. On a drawing, `001` is a mark number and `1:100` is a scale.

## Writer

**Hand-written OOXML, zipped with the JSZip already in `package.json`. No new dependency.**

Six parts for a two-sheet workbook, 2,537 bytes, byte-identical across runs, and opened successfully by two independent parsers (SheetJS and ExcelJS) with Japanese sheet names, Japanese cell text, merged ranges, embedded newlines and `001`-as-text all intact.

It is worth being clear that this is a bigger package than the `.docx` M2-3 writes — six parts against three, with a second relationship layer, because worksheets are parts the workbook points at by relationship ID. Assuming a spreadsheet is the same size of problem as a document is exactly the assumption that needed testing; it is not, and it is still small.

Adding SheetJS (7.5 MB unpacked, 7 dependencies) or ExcelJS (21.8 MB, 9 dependencies) buys formatting, formulas and styling that a first release does not need, and costs a dependency in a browser bundle for a feature whose whole value is that nothing leaves the machine. **Neither is recommended for adoption.** If styling or number formats later become requirements, the decision should be revisited against the then-current versions rather than these.

**Not verified in Microsoft Excel.** There is no Excel and no LibreOffice on this machine. Two parsers accepting the bytes is good evidence and is not the same claim.

## Proposed MVP

1. User opens PDF加工 → PDFテキスト化, chooses a page, drags a rectangle over a table.
2. Ruling lines and tokens inside the rectangle reconstruct a grid.
3. The grid is shown as a preview, with its status.
4. `TABLE_CONFIDENT` → export. `TABLE_NEEDS_CONFIRMATION` → the user confirms or adjusts first.
5. One `.xlsx`, one sheet per confirmed table, string-first values, blanks preserved, merges not invented.

## Explicitly unsupported in the MVP

- Whole-document automatic table extraction.
- Merged-cell inference.
- Number, date and currency typing (values are text).
- Styling, column widths, formulas.
- Tables split across pages, or spanning a page break.
- Rotated **text** inside a cell (a rotated *page* is handled by the viewport transform).
- Scanned pages, **until the segmentation defect is fixed**; and even then, at measured accuracy well below native.

## Key risks

1. **The segmentation defect gates half the feature** and is a pre-existing bug in shipped code. M2-4 should not be started before it is decided who fixes it and when.
2. **Scanned accuracy may not be acceptable even once unblocked** — 2 of 12 cells exact on a skewed, noisy sheet. A scanned-page MVP may have to be deferred on its own evidence.
3. **A preview UI is most of the work.** The reconstruction is milliseconds; the selection, preview, confirmation and edit surface is a feature in its own right and is not costed here.
4. **The geometry route does not scale** — 2.1 s for 20,000 tokens on the main thread. If borderless tables are in scope, it needs a bound on candidate growth and a yield inside the page.
5. **A spreadsheet carries more authority than a text file.** Every wrong cell is a defect that looks like data.

## Required human decisions

1. Accept **REVISE**, and with it that M2-4 asks the user to select a region rather than doing it silently.
2. Decide whether the OCR segmentation defect is fixed first, separately, as a bug in M2-1/M2-2.
3. Decide whether scanned pages are in the MVP at all, given the measured accuracy.
4. Confirm **string-first values**, accepting that `12` arrives in Excel as text.
5. Confirm **no new dependency**, i.e. the hand-written writer.
6. Decide whether Microsoft Excel verification is required before release, and on whose machine.
