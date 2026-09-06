# M2-5 measurements

Everything below was measured on the synthetic set described in
`fixtures.md`, on this machine, with the scripts named beside each section.
Numbers that are not reproduced by re-running those scripts are defects in this
document; `scripts/research-m2-5-gate.mjs` re-asserts the load-bearing ones so
that a change turns into a failing gate rather than a stale paragraph.

```
node scripts/research-m2-5-fixtures.mjs
node scripts/research-m2-5-probe.mjs
node scripts/research-m2-5-register.mjs
node scripts/research-m2-5-export-application.mjs    # needs Microsoft Excel
node scripts/research-m2-5-gate.mjs
```

## 1. Where the title block is, across sheet sizes

`scripts/research-m2-5-probe.mjs` — a template is built from page 1 (A3,
layout A) and applied to every other page under three coordinate models:

- **absolute** — the region in PDF points, unchanged.
- **normalised** — the region as a fraction of the page, rescaled.
- **corner-anchored** — the region's offset from the bottom-right corner in
  points, preserved; the size preserved too.

Fields read (out of 4 per page), counting only pages that carry native text:

| group | pages | absolute | normalised | corner-anchored |
| --- | --- | --- | --- | --- |
| A3, layout A — the template's own group | 17 | 45/45 | 45/45 | 45/45 |
| bigger sheet, block scales with it | 6 | 0/8 | **7/8** | 0/8 |
| A2/A1, layout A, block of fixed physical size | 2 | 0/8 | 1/8 | **8/8** |
| A2, layout B | 1 | 0/4 | 0/4 | 0/4 |

Two things follow, and they matter more than the individual counts.

**No single model reads both scaling conventions.** Normalised wins where the
block scales with the sheet; corner-anchored wins where it does not. Each is
near-total on its own group and near-useless on the other. Any architecture
that picks one model up front is choosing which half of a real drawing set it
cannot read.

**A different layout defeats all three**, which is expected and is the point of
having layout B in the set: 0/4 is what a template that does not fit should
score.

**`templateFits()` does not catch it.** The prototype's own fit check returns
true for all 25 pages, because every A-series sheet shares the same aspect
ratio — the check it performs is real but it is not sufficient, and treating it
as a guard would be worse than having no guard at all. See `limitations.md`.

## 2. Rasterising only the region

`scripts/research-m2-5-probe.mjs`, at 300 dpi, RGBA:

| sheet | full page | title-block region | region as % of page |
| --- | --- | --- | --- |
| A3 | 17.4 Mpx (69.6 MB) | 0.76 Mpx (3.0 MB) | 4.38% |
| A1 | 69.7 Mpx (278.8 MB) | 2.86 Mpx (11.5 MB) | 4.11% |
| A0 | 139.5 Mpx (558.1 MB) | 5.63 Mpx (22.5 MB) | 4.03% |

The A0 figure is the one that decides this: 558 MB of RGBA in a browser tab, to
read four fields that occupy 4% of it. Region rendering is not an optimisation
here, it is what makes A0 possible at all. PDF.js supports it directly through
the viewport's `offsetX`/`offsetY`, so this costs no new code beyond passing
the region through.

## 3. Segmentation mode

`scripts/research-m2-5-probe.mjs`. The installed Tesseract.js exposes 14 PSM
options, and **their values are strings**, not numbers — read from the
installed package rather than remembered, because passing a number silently
produces the default. `AUTO` is `"3"`; the default when nothing is passed is
`SINGLE_BLOCK`.

**The denominator, stated as a rule rather than a slice.** An earlier version of
this measurement ran over "the first three scanned pages", one of which was
drawn to layout B — a page the profile-A template does not address at all, so
every mode scored zero on it and the comparison absorbed a number that had
nothing to do with segmentation. The rule is now in the code and asserted by the
gate:

> every scanned page the profile-A template actually addresses
> (`kind === scanned && layout === A && the block scales with the sheet`)

which is pages 9, 10, 16, 17, 23, 24 and 25 — **7 pages × 4 fields = 28 field
readings per mode**, and it covers all four rotations rather than only
`/Rotate 0`.

| mode | per-field OCR | union OCR |
| --- | --- | --- |
| `SINGLE_BLOCK` | **25/28** | **26/28** |
| `SPARSE_TEXT` | 11/28 | 13/28 |
| `AUTO` | 13/28 | 8/28 |
| `SINGLE_LINE` | 10/28 | 0/28 |
| `SINGLE_WORD` | 6/28 | 0/28 |

`SINGLE_BLOCK` wins on both paths and by a wide margin. This is the reverse of
what M2-4 measured for full-page table work, and the reason is the region: a
title-block field is one small block of text, which is exactly what
`SINGLE_BLOCK` is for, whereas `AUTO` spends its page analysis on a crop too
small to analyse. The M2-4 finding is not wrong; it was about a different input.

Preprocessing the crop (grayscale, contrast stretch) made **no measurable
difference** on this corpus — same fields read, same values. That is a null
result on synthetic pages with clean glyphs, and it should not be read as
evidence that preprocessing is useless on a real scan. See `limitations.md`.

## 4. One OCR call per field, or one for the whole block

Both paths were run over the whole 25-page set, end to end, under the same
field-level source policy. The only difference is how the fields that need OCR
are recognised.

| | OCR calls | pixels | wall clock | fields correct | words unplaced |
| --- | --- | --- | --- | --- | --- |
| per field | 35 | 10.81 Mpx | 2.1 s | 95/100 | — |
| union region | **9** | 14.55 Mpx | **1.6 s** | **96/100** | **0** |

**This reverses the earlier conclusion, and the earlier reasoning was wrong on
its own terms.** The first version of this spike adopted per-field recognition
on the argument that a union call "gives one number for four values, so it
cannot say which of the four to look at". That is simply false about the
implementation: the union path assigns each recognised word to the field
rectangle its centre falls in, and therefore produces a per-field text, a
per-field word count and a per-field confidence exactly as the per-field path
does. The gate asserts it.

With that argument removed, the measurement is one-sided: union is no less
accurate, uses a quarter of the calls, and finishes faster. The one real cost is
pixels — it rasterises the gaps between the fields, 14.55 Mpx against 10.81 —
and on the largest sheet that still lands far inside what a browser can hold
(section 2).

The genuine risk in the union path is not attribution *confidence* but
attribution *correctness*: a word whose centre lands on the wrong side of a
field boundary is silently filed under the wrong field. On this corpus that
never happened (0 words unplaced, and per-field values matching), but these
fields are well separated. `limitations.md` records what was not measured.

## 5. Pages that are neither native nor scanned

`scripts/research-m2-5-probe.mjs`, reusing M2-4's `classifyPage()` semantics:

| page | kind | classified `scanned` | fields with native text |
| --- | --- | --- | --- |
| 12 | raster sheet, drawing number as vector text | false | 1 of 4 (`drawing_number`) |
| 20 | raster sheet with an invisible OCR text layer | false | 4 of 4 |

Both are classified not-scanned, and for page 12 that is misleading at page
level: three of its four fields have no text to read. A page-level native/
scanned switch would extract one field and silently leave three empty.

Page 20 is the opposite trap: it has native text for all four fields, but that
text came from somebody else's OCR, so it carries that OCR's errors while
looking exactly like authored text. Nothing in the PDF distinguishes the two.
The register must therefore record where a value came from, and cannot treat
"native text was present" as "the value is correct".

## 5b. Scanned regions at every rotation

`scripts/research-m2-5-probe.mjs`. This section exists because the first version
of this spike had a hole in it, and the hole hid a real bug.

Every rotated page in the original corpus carried native text, and native
extraction reads token coordinates without rendering anything. So the
region-render-and-OCR path — the one the architecture actually proposes for
scanned sheets — had only ever been exercised at `/Rotate 0`.

Adding three scanned sheets at 90, 180 and 270 found this immediately:

| | fields read |
| --- | --- |
| rotated scanned pages, before the fix | **0/12** |
| rotated scanned pages, after the fix | **10/12** |
| the same pages rendered through the page rotation (the old code) | **0/12** |

The bug was not in the rectangle. `renderRegion` mapped the upright field
rectangle into display space and cropped exactly the right pixels — and then
handed OCR a title block lying on its side. Page 24 (`/Rotate 180`) returned
`"TST-V ll"` where the sheet says `A-151`.

That is the worst shape a bug can have here: the region is right, the text is
present, and the recognised value is rubbish, which is indistinguishable in
every aggregate from "OCR could not read this page".

The fix is to render with `/Rotate` undone — `getViewport({ scale, rotation: 0 })`
— so the canvas comes out in the same upright page space the rectangles are
already expressed in. The rotation map is then not needed for rendering at all,
which is the outcome you would want from a design that claims one coordinate
space.

The last row of the table is the negative probe, and it is the reason the other
rows can be believed: rendering the same regions the old way reads **nothing**,
on every rotated page.

## 6. Label and value in the same region

A title-block cell holds its label above its value, so reading the region
verbatim yields `"図面番号\nA-101"`. Across 99 field readings that have an
expected value:

| policy | exact match | contains the expected value |
| --- | --- | --- |
| whole region, verbatim | 5/99 | 96/99 |
| **last line of the region** | **96/99** | 96/99 |

Taking the last line is now as good as the extraction gets: every value that was
read at all is presented correctly.

That is a change from the earlier figure of 64/87, and the cause is worth
recording because it was a defect in the measurement rather than an improvement
in the rule. Both OCR paths used to flatten their output into a single line
(`text.replace(/\s+/g, ' ')`), so an OCR-sourced field had no last line to
take — the rule worked on native fields and did nothing at all on OCR ones.
Grouping recognised words into lines by vertical overlap, exactly as the native
reader already did, makes the two paths the same shape and the rule applies to
both.

The third policy — approximating "ask the user to draw only the value area" by
trimming the top 45% off each rectangle — scored **12/100**, against 95/100 for
the same pipeline on whole cells. A mechanical trim is not a stand-in for a
user-drawn region: it cuts into the value itself whenever the label is shorter
than the guess. What that measures is the crudeness of the proxy, not the merit
of the idea.

## 7. End to end, 25 pages

`scripts/research-m2-5-probe.mjs`. Four runs over the whole set. The policies
differ on two independent axes — how the *source* is chosen, and how OCR is
*called* — so they are stated separately:

| policy | source decided | OCR path | fields correct | wall clock | OCR calls | pixels |
| --- | --- | --- | --- | --- | --- | --- |
| page-level | per page | per field | 93/100 | 2.1 s | 32 | 10.39 Mpx |
| field-level | per field | per field | 95/100 | 2.1 s | 35 | 10.81 Mpx |
| **field-level** | per field | **union** | **96/100** | **1.6 s** | **9** | 14.55 Mpx |
| field-level, value-only regions | per field | per field | 12/100 | 3.6 s | 88 | 10.97 Mpx |

**The page-level policy is now genuinely page-level.** The first version of this
comparison called one policy "page-level" and then, on a native-classified page,
sent any *empty* field to OCR anyway — which is field-level behaviour wearing a
page-level label, and it made the two policies score identically because they
largely were the same policy. A page-level policy has concluded the page has a
text layer; it reads every field from that layer and an empty field stays empty.

With the distinction made properly, the difference appears where it should:

| on page 12 — a raster sheet whose drawing number is vector text | fields read | sources chosen |
| --- | --- | --- |
| page-level | 1/4 | native, native, native, native |
| field-level | 3/4 | native, ocr, ocr, ocr |

Two of the 100 fields separate the policies in aggregate, and all of the
argument is on this one page: the page-level switch reads one field, leaves
three empty, and reports nothing unusual.

## 8. One row per page

- Rows produced: **25 of 25 pages**, under every policy.
- Silent page loss: **0**. A page whose template did not fit, whose OCR failed
  or whose fields came back empty still produces a row carrying the reason.

The gate proves this can fail rather than merely observing that it did not: it
builds a row from a page with no fields and a template that did not fit, and
asserts the row exists, is empty, carries a reason, and is `unconfirmed`.

## 9. Review burden

100 values across 25 pages:

| | |
| --- | --- |
| rows flagged for review | 5 of 25 |
| rows that were wrong but **not** flagged | **1** (page 25) |
| rows a reviewer had to edit | 3 of 25 (pages 12, 17, 25) |
| fields a reviewer had to edit | 3 of 100 |

The second line is the one that matters, and it is worse than this document
previously claimed. An earlier version reported zero rows wrong-but-unflagged;
that was true of a corpus that did not yet contain a page capable of producing
one. Page 25 is a rotated scanned sheet where OCR returned a wrong value *with
high confidence*, so no flag fired.

This is the honest shape of confidence-based flagging: it catches the reader
being unsure. It cannot catch the reader being confidently wrong, and no
threshold makes it able to. That is an argument for the review step existing at
all, not for tuning the threshold.

## 10. Duplicates and gaps

Duplicates, exact string match after trimming:

- planted `A-101` on pages 1 and 8: **found**
- false positives: **0**
- `A-101` and `A101` are *not* merged, deliberately — on a real issue they may
  be two different sheets.

Gaps are worse, and this is the sharpest negative result in the spike. Sweeping
the maximum jump that still counts as a gap, over the confirmed 25-page
register:

| max jump | candidates | true | false |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 0 |
| 2 | 2 | 1 | 1 |
| 3 | 2 | 1 | 1 |
| 5 | 2 | 1 | 1 |
| 10 | 34 | 1 | **33** |

**Every setting that finds the planted gap also invents at least one**, on a set
of 25 pages. There is no threshold that makes this check clean. A drawing set is
allowed to skip numbers — a cancelled sheet, a reserved block, a discipline
boundary — so absence of a number is not evidence of a missing drawing.

Two rules do reduce the damage, and both are proved by negative probes:

- **An unreadable number stands the whole check down.** If any drawing number
  could not be read, the number that looks missing might be that one. The probe
  adds a misread `A-1O7` to a clean run and asserts the candidate count drops
  to zero.
- **A different scheme read straight off the page does not.** `DETAIL-A` is not
  a failure to read, it is a different convention, so it disables inference for
  its own prefix only. The probe asserts the `A-` run still reports its gap.

## 11. Export: what a spreadsheet actually does with the values

`scripts/research-m2-5-export-application.mjs`, **Microsoft Excel 16.0 on this
machine, through COM**. Twelve values were written under four CSV policies and
through the workbook writer already in `src/utils/pdf-textifier/excel.ts`, then
each file was opened and each cell read back.

| export | evaluated as a formula | shown differently | destroyed | intact |
| --- | --- | --- | --- | --- |
| CSV, raw | 3 | 2 | 0 | 7 |
| CSV, strip leading `= + - @` | 0 | 7 | 1 | 4 |
| CSV, prefix with `'` | 0 | 8 | 0 | 4 |
| CSV, prefix with a tab | 0 | 8 | 0 | 4 |
| **XLSX, the app's own writer** | **0** | **0** | **0** | **12/12** |

The individual failures are worth naming:

- Raw CSV: `=1+1` becomes `2`, `=SUM(A1:A9)` becomes `36`, and `+81-3-1234` —
  a phone number — is rewritten by Excel as the formula `=81-3-1234` and shown
  as `-1156`.
- Strip: a lone `-`, a perfectly ordinary "no revision yet", becomes an
  **empty cell**. The value is destroyed to make it safe, which is precisely
  the trade the brief forbids.
- Prefix with `'`: the apostrophe is *visible* in the cell. Excel's text-prefix
  convention applies to typed input, not to a character sitting in a CSV field,
  so `=1+1` displays as `'=1+1` — a wrong value that looks deliberate.
- Prefix with a tab: same, with an invisible character instead of a visible one,
  which is worse for anyone who later compares the column against another list.
- **`001` becomes `1` under every CSV policy**, including raw. CSV carries no
  type information, so a drawing number with leading zeros cannot survive it at
  all. For a register whose primary key is the drawing number, that alone
  disqualifies CSV.

The XLSX writer already in the app loses none of them, because it writes every
cell as an inline string: `=1+1` stays text, `001` stays `001`, the multiline
value keeps its line break, and nothing evaluates. New dependencies for this:
**0** — the writer, JSZip and the deterministic packaging are all already
shipped and already gated by M2-4's smoke tests.

## 12. No network, no service

`scripts/research-m2-5-probe.mjs` records every request the page makes:

| | |
| --- | --- |
| external HTTP(S) requests during OCR | **0** |
| OCR assets loaded | 4, all from `/tesseract/` and `/tessdata/` in this repo |
| page errors | 0 |
| OCR workers created | 1, shared; 139–154 ms to start |

External OCR service calls: 0. AI API calls: 0. Cloud conversion: 0.

## 13. The gate

`scripts/research-m2-5-gate.mjs` re-asserts 72 claims, 25 of them negative
probes — checks fed input that must make them fire, so that "nothing was
reported" can be distinguished from "nothing works". It passes at the head of
this branch.
