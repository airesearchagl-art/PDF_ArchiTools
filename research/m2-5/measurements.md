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
| A3, layout A — the template's own group | 14 | 45/45 | 45/45 | 45/45 |
| A2, layout A, block scales with the sheet | 2 | 0/8 | **7/8** | 0/8 |
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
true for all 22 pages, because every A-series sheet shares the same aspect
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

On the two probed field regions (4 fields each):

| mode | fields read |
| --- | --- |
| `SINGLE_BLOCK` | 8/8 |
| `AUTO` | 4/8 |

This is the reverse of what M2-4 measured for full-page table work, and the
reason is the region: a title-block field is one small block of text, which is
exactly what `SINGLE_BLOCK` is for, whereas `AUTO` spends its page analysis on
a crop too small to analyse. The M2-4 finding is not wrong; it was about a
different input.

Preprocessing the crop (grayscale, contrast stretch) made **no measurable
difference** on this corpus — same fields read, same values. That is a null
result on synthetic pages with clean glyphs, and it should not be read as
evidence that preprocessing is useless on a real scan. See `limitations.md`.

## 4. One OCR call per field, or one for the whole block

| | calls | pixels | time | fields read |
| --- | --- | --- | --- | --- |
| per field | 4 per page | 2.08 Mpx total | 214 ms | 8/8 |
| union region | 1 per page | 2.99 Mpx total | 204 ms | 8/8 |

Identical accuracy, and the time difference is inside the noise. The union
region rasterises *more* pixels because it spans the gaps between fields.

So this is not a performance decision, and the argument that decides it is a
review one: per-field calls give a confidence figure and a failure reason
*per field*, which is what the review queue sorts on. A union call gives one
number for four values, so a page where three fields are perfect and one is
unreadable looks the same as a page that is uniformly mediocre.

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

## 6. Label and value in the same region

A title-block cell holds its label above its value, so reading the region
verbatim yields `"図面番号\nA-101"`. Across 87 field readings:

| policy | exact match | contains the expected value |
| --- | --- | --- |
| whole region, verbatim | 5/87 | 85/87 |
| last line of the region | 64/87 | 85/87 |

`contains` is identical for both, which says the text is being read correctly
in 85 cases either way; the difference is entirely in presentation. Taking the
last line is better as a default and is still wrong 23 times out of 87 — a
two-line title, a value above its label, an empty value that leaves the label
as the last line.

A third policy that trimmed the label by string matching scored **54/88** end
to end, worse than doing nothing. It is recorded here because it looked like an
obvious improvement and was not: the trim removes real content whenever the
label guess is wrong, and a wrong value is more expensive than a value with its
label attached.

## 7. End to end, 22 pages

`scripts/research-m2-5-register.mjs`:

| policy | fields correct | time |
| --- | --- | --- |
| page-level native/scanned switch | 85/88 | 1444 ms |
| field-level source selection | 85/88 | 1265 ms |
| field-level + label trimming | 54/88 | 2267 ms |

Field-level selection does not beat the page-level switch on this corpus, and
the reason is that only one page in the set (page 12) actually mixes sources.
It is not faster because it is cleverer; it is marginally faster because it
skips OCR on fields that already have text.

The case for field-level is page 12, not the aggregate: the page-level switch
gets 1 of 4 fields there and reports nothing wrong, whereas field-level reads
the one native field and sends the other three to OCR. On a corpus with one
such page that difference is invisible in the total.

## 8. One row per page

- Rows produced: **22 of 22 pages**, under every policy.
- Silent page loss: **0**. A page whose template did not fit, whose OCR failed
  or whose fields came back empty still produces a row carrying the reason.

The gate proves this can fail rather than merely observing that it did not: it
builds a row from a page with no fields and a template that did not fit, and
asserts the row exists, is empty, carries a reason, and is `unconfirmed`.

## 9. Review burden

88 values across 22 pages:

| | |
| --- | --- |
| rows flagged for review | 5 of 22 |
| rows that were wrong but **not** flagged | 0 |
| rows a reviewer had to edit | 6 of 22 |
| fields a reviewer had to edit | 23 of 88 |

The first and third lines disagree by one row, and that disagreement is the
honest finding: the flags caught every row that was *wrong*, but one row needed
an edit that no flag predicted — a value that was read correctly and still was
not what belonged in the register.

"0 unflagged-but-wrong" is a statement about this corpus of 22 synthetic pages.
It is not a claim about a hit rate on real drawings, and it must not be quoted
as one.

## 10. Duplicates and gaps

Duplicates, exact string match after trimming:

- planted `A-101` on pages 1 and 8: **found**
- false positives: **0**
- `A-101` and `A101` are *not* merged, deliberately — on a real issue they may
  be two different sheets.

Gaps are worse, and this is the sharpest negative result in the spike. Sweeping
the maximum jump that still counts as a gap, over the confirmed 22-page
register:

| max jump | candidates | true | false |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 0 |
| 2 | 2 | 1 | 1 |
| 3 | 2 | 1 | 1 |
| 5 | 2 | 1 | 1 |
| 10 | 26 | 1 | 25 |

**Every setting that finds the planted gap also invents at least one**, on a set
of 22 pages. There is no threshold that makes this check clean. A drawing set
is allowed to skip numbers — a cancelled sheet, a reserved block, a discipline
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

`scripts/research-m2-5-gate.mjs` re-asserts 44 claims, 16 of them negative
probes — checks fed input that must make them fire, so that "nothing was
reported" can be distinguished from "nothing works". It passes at the head of
this branch.
