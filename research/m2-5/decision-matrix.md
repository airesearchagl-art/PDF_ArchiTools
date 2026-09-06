# M2-5 decision matrix

Each row is a decision the implementation would have to make, the options that
were actually measured, and what the measurement says. Evidence references are
sections of `measurements.md`.

Verdicts are **ADOPT** (build it this way), **REVISE** (the shape is right, one
part needs changing first) and **DEFER** (do not build it yet).

---

## 1. Finding the title block

| option | measured | cost |
| --- | --- | --- |
| detect it automatically | not built | a fifth thing that can be wrong |
| user draws the regions once | §1 | one placement per document |

**ADOPT: user draws it.** No detector was built, and this is not an omission —
§1 shows that even a correct region does not transfer between sheet sizes
reliably, so a detector would inherit that problem *and* add its own. The
placement is a few seconds; a wrong detection that nobody notices is not.

## 2. Transferring the template to other sheet sizes

| model | block scales with sheet | block of fixed size |
| --- | --- | --- |
| absolute points | 0/8 | 0/8 |
| normalised to page | **7/8** | 1/8 |
| corner-anchored | 0/8 | **8/8** |

**REVISE.** There is no winner. Both conventions are real, each model handles
one and fails the other, and `templateFits()` returns true in every case
because A-series sheets share an aspect ratio — so the mismatch is not even
detectable from geometry.

The revision: apply the template, then show the proposed regions on the first
page of each new sheet size and ask the user to confirm or redraw. Normalised
is the better default to *propose* (it matches the more common convention on
this corpus), but it must not be applied unattended.

Choosing a model silently is the single most dangerous option on this page: it
produces four empty fields on half a drawing set, and empty fields look like a
page problem rather than a template problem.

## 3. Rasterising for OCR

| option | A0 cost | verdict |
| --- | --- | --- |
| full page at 300 dpi | 139.5 Mpx, 558 MB | not viable |
| the field regions only | 5.63 Mpx, 22.5 MB | 4.03% of the page |

**ADOPT: regions only**, through the PDF.js viewport's `offsetX`/`offsetY`.
This is not a performance tuning decision; the full-page path does not survive
A0 in a browser tab. §2.

## 4. OCR segmentation mode

| mode | fields read |
| --- | --- |
| `SINGLE_BLOCK` | 8/8 |
| `AUTO` | 4/8 |

**ADOPT: `SINGLE_BLOCK`.** §3. Note the PSM values are **strings** in the
installed Tesseract.js; passing a number falls back to the default without
error. The M2-4 spike found `AUTO` unhelpful on full pages and this spike finds
`SINGLE_BLOCK` better on crops — both are right, about different inputs.

## 5. One OCR call per field, or one for the block

| | calls | pixels | time | accuracy |
| --- | --- | --- | --- | --- |
| per field | 4/page | 2.08 Mpx | 214 ms | 8/8 |
| union region | 1/page | 2.99 Mpx | 204 ms | 8/8 |

**ADOPT: per field.** §4. The measurement is a tie, so the decision is made on
what each produces rather than what each costs: per-field calls yield a
confidence and a reason for each value, which is what the review queue sorts
on. The union call cannot say which of four values to look at.

## 6. Native or OCR

| option | aggregate | page 12 (mixed sheet) |
| --- | --- | --- |
| page-level switch | 85/88 | 1 of 4 fields, no warning |
| field-level | 85/88 | 4 of 4 fields |

**ADOPT: field-level.** §5, §7. The aggregate is a tie because the corpus has
one mixed page; that page is the entire argument. A page-level switch fails it
silently, which is the failure mode this design exists to avoid.

Record the source per field regardless. Page 20 — a raster sheet carrying
somebody else's OCR text layer — is indistinguishable from authored text, so
"native" cannot mean "trustworthy".

## 7. Label and value in the same cell

| policy | exact | contains |
| --- | --- | --- |
| whole region verbatim | 5/87 | 85/87 |
| last line | 64/87 | 85/87 |
| trim the label by matching | 54/88 end to end | — |

**REVISE.** §6. Last-line is the best simple rule and is wrong 23 times in 87.
The clever trim made things worse than doing nothing, because it deletes real
content whenever the label guess misses.

Ship the split as a *display* default over text the reviewer always sees in
full. Never store only the trimmed value.

## 8. Rows for pages that failed

| option | verdict |
| --- | --- |
| drop the page | **rejected** |
| row with empty values and a reason | **ADOPT** |

§8. 22 rows for 22 pages under every policy; silent page loss 0. The gate
proves the check can fire by building a row from a page with nothing on it.

There is no trade-off here to weigh. A register that is missing a sheet is
wrong in the way nobody checks for.

## 9. What confirms a row

| option | verdict |
| --- | --- |
| confidence above a threshold | **rejected** |
| a person confirms it | **ADOPT** |

§9. Rows confirmed without a human: 0, by construction. Confidence orders the
queue; it never promotes.

Review burden on this corpus: 5 of 22 rows flagged, 0 rows wrong but unflagged,
6 of 22 rows and 23 of 88 fields actually edited. The gap between "5 flagged"
and "6 edited" is real and is not a bug — one row needed an edit that no flag
could have predicted.

## 10. Duplicate drawing numbers

| option | result |
| --- | --- |
| exact match after trimming | found the planted duplicate, 0 false |
| fuzzy (`A-101` ≈ `A101`) | not adopted |

**ADOPT: exact match.** §10. Fuzzy matching would merge two sheets that a real
issue may well distinguish. Report what is certainly the same; ask about the
rest.

## 11. Missing-number (gap) inference

| max jump | candidates | true | false |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 0 |
| 2 | 2 | 1 | 1 |
| 5 | 2 | 1 | 1 |
| 10 | 26 | 1 | 25 |

**DEFER.** §10. Every setting that finds the planted gap also invents at least
one, on 22 pages. There is no threshold that makes this clean, because the
premise is false: drawing sets skip numbers legitimately.

Two rules were built and do work, and they are worth keeping *if* this is ever
revisited: an unreadable number stands the whole check down (the missing number
may be the one that was misread), while a different numbering scheme read
straight off the page disables only its own prefix. Both are proved by negative
probes rather than by absence of output.

## 12. Export format

| export | evaluates | altered | destroyed | intact |
| --- | --- | --- | --- | --- |
| CSV raw | 3 | 2 | 0 | 7/12 |
| CSV strip `= + - @` | 0 | 7 | **1** | 4/12 |
| CSV prefix `'` | 0 | 8 | 0 | 4/12 |
| CSV prefix tab | 0 | 8 | 0 | 4/12 |
| **XLSX, existing writer** | **0** | **0** | **0** | **12/12** |

**ADOPT: XLSX through the writer already in the app. No CSV.**

§11, verified in Microsoft Excel 16.0 on this machine, not by our own parser.
The decisive line is not injection, it is `001` → `1` under *every* CSV policy
including raw: CSV has no types, and the register's primary key is a drawing
number. The strip policy additionally empties a lone `-` — destroying a
legitimate "no revision yet" in the name of safety, which is the trade the
brief rules out.

New dependencies: 0. The writer, JSZip and its deterministic packaging are
already shipped and already gated.

## 13. Where OCR runs

| option | verdict |
| --- | --- |
| local Tesseract.js from this repo | **ADOPT** |
| any external OCR service | not considered |
| any AI API | not considered |
| any cloud conversion | not considered |

§12. External requests during OCR: 0. Assets: 4, all local. The last three rows
were excluded by the brief and no measurement was taken for them.

---

## Summary

| | |
| --- | --- |
| **ADOPT** | user-placed template; upright page space; region-only rasterising; `SINGLE_BLOCK`; per-field OCR; field-level source with the source recorded; one row per page; candidate-until-confirmed; exact-match duplicates; XLSX through the existing writer; local OCR |
| **REVISE** | template transfer between sheet sizes (confirm per size, do not auto-pick); label/value split (display default only) |
| **DEFER** | gap inference; OCR preprocessing; any field beyond the four |
