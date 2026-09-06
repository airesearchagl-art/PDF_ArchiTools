# M2-5 fixtures

Every page in this spike is generated. No customer drawing, no real project
file, and nothing that came off a scanner in an office was used or is described
here. The generator is `scripts/research-m2-5-fixtures.mjs`; it writes 25 pages
into `test-fixtures/m2-5/drawing-set.pdf` alongside `drawing-set.truth.json`,
which records what each page is supposed to say.

Regenerate with:

```
node scripts/research-m2-5-fixtures.mjs
```

The generator is deterministic. Given the same script it produces the same
bytes: fixed dates, no randomness, no timestamps in the content stream. A
measurement that moves between two runs is a real change in the code, not
noise in the corpus.

## What the set contains

| | pages |
| --- | --- |
| native text | 15 |
| scanned (image only) | 8 |
| raster sheet, drawing number as vector text | 1 |
| raster sheet with an invisible OCR text layer | 1 |

| sheet size | pages | page size (pt) |
| --- | --- | --- |
| A3 | 17 | 841.89 × 1190.55 |
| A2 | 5 | 1190.55 × 1683.78 |
| A1 | 2 | 1683.78 × 2383.94 |
| A0 | 1 | 2383.94 × 3370.39 |

Rotations 0, 90, 180 and 270 all appear, set through `/Rotate` rather than by
rotating the content, because that is how the drawings that reach this app are
made and because it is the case that broke the M2-4 geometry work.

**Three of the rotated pages are scanned** (23, 24, 25), and they exist because
of a hole the first version of this corpus had: every rotated page carried
native text, so the region-render-and-OCR path had only ever run at `/Rotate 0`.
A wrong rotation would have rendered a correctly-cropped, sideways title block
and returned rubbish text, which reads in every measurement as "OCR could not
read this page". Adding them found exactly that bug -- see `measurements.md`
section 5.

## The two title-block layouts

**Layout A** is the common one: the block sits in the bottom-right corner, with
`drawing_number`, `drawing_title`, `revision` and `revision_date` stacked in a
fixed order, each cell holding a label above its value.

**Layout B** is deliberately different — the block runs along the bottom edge,
the fields sit side by side, and the labels are to the left of the values
rather than above them. It exists so that "the template does not fit" is
something the measurements can actually observe rather than assume.

## The two scaling behaviours

This is the part of the corpus I got wrong the first time and had to rebuild,
so it is worth stating plainly.

Originally every title block was expressed as a fraction of the sheet, so a
block on an A0 sheet was 2.8 times the size of the same block on A3. That is
one real convention, but it is not the only one, and a corpus that contains
only that convention hands the measurement to whichever coordinate model
happens to be normalised. The result looked decisive and meant nothing.

The set now contains both:

- **proportional** (20 pages) — the block scales with the sheet.
- **fixed physical size** (2 pages, 21 and 22) — the block is the same number
  of millimetres on A2 and A1 as it is on A3, anchored to the bottom-right
  corner. This is the other real convention, and it is common on issued sets
  where the title block is a stamp of fixed size.

Two pages is thin. It is enough to show that the two conventions pull in
opposite directions, which is the finding; it is not enough to estimate how
often either occurs in a real office, and `limitations.md` says so.

## Planted facts

Some of the content is planted so that the register-level checks have something
true to find:

| what | where |
| --- | --- |
| duplicate drawing number `A-101` | pages 1 and 8 |
| missing number `A-103` in an otherwise regular run | between pages carrying `A-102` and `A-104` |
| a value that is not `PREFIX-NNN` | the `DETAIL-A` sheet, page 19 |
| a blank revision | page 6, `S-202` |
| scanned sheets at `/Rotate` 90, 180, 270 | pages 23, 24, 25 |
| values a spreadsheet reads as formulas | page 18, `=1+1` / `@ABC 仮設計画` / `+3` / `-1` |

The duplicate and the gap are the only two the checks are supposed to find. Any
third thing a check reports is a false positive, and the measurements count it
as one.

## OCR assets

The scanned pages are read with Tesseract.js from `public/tesseract/` and
`public/tessdata/` in this repository. Those directories are untracked build
inputs, not part of this change. The probes assert that OCR made zero external
requests; see `measurements.md`.
