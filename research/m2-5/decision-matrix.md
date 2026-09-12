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

## 2. Deciding which template applies to which page

Two questions get confused here, so they are separated.

**(a) Which profile is this page?**

| option | measured | verdict |
| --- | --- | --- |
| key it on sheet size | pages 5, 6, 7 are all A2; page 7 is a different layout | **rejected** |
| gate it on `templateFits()` | says true for the unassigned pages; auto-continuing reads **0/8** fields | **rejected** |
| a person assigns pages or ranges to a named profile | §7b | **ADOPT** |

Sheet size does not identify the template — the drawing office's does, and one
issue carries several. `templateFits()` answers a narrower question (does this
rectangle still land on this page) and answers it *true* for every A-series
sheet, so wiring it to assignment auto-continues onto exactly the pages that
need asking about, silently.

A page nobody has assigned is unassigned, not guessed: it still produces a row,
carrying `no confirmed template profile covers this page` — deliberately a
different reason from a template that fitted and missed.

**(b) Given the profile, how does the region transfer to another sheet size?**

| model | block scales with sheet | block of fixed size |
| --- | --- | --- |
| absolute points | 0/8 | 0/8 |
| normalised to page | **7/8** | 1/8 |
| corner-anchored | 0/8 | **8/8** |

**REVISE.** No winner. Both conventions are real, each model handles one and
fails the other. The model is therefore recorded *on the profile*, as part of
what a person confirms, rather than inferred per page. Normalised is the better
default to propose; it must not be applied unattended.

Everything in §7 is extraction performance **given a correct, confirmed
assignment**. It is not evidence that (a) can be automated, and it should not be
quoted as though it were.

## 3. Rasterising for OCR

| option | A0 cost | verdict |
| --- | --- | --- |
| full page at 300 dpi | 139.5 Mpx, 558 MB | not viable |
| the field regions only | 5.63 Mpx, 22.5 MB | 4.03% of the page |

**ADOPT: regions only**, through the PDF.js viewport's `offsetX`/`offsetY`,
**rendered with `/Rotate` undone** (`rotation: 0`). This is not a performance
tuning decision; the full-page path does not survive A0 in a browser tab. §2.

Rendering the region in display space instead is not a lesser option, it is a
bug: the crop is correct and the glyphs come out sideways, so OCR returns
rubbish that is indistinguishable from an unreadable page. Rotated scanned
sheets read **0/12** fields that way and **10/12** un-rotated. §5b.

## 4. OCR segmentation mode

Over a stated denominator — every scanned page the profile-A template actually
addresses, which is 7 pages × 4 fields = **28 readings per mode**, covering all
four rotations:

| mode | per-field OCR | union OCR |
| --- | --- | --- |
| `SINGLE_BLOCK` | **25/28** | **26/28** |
| `AUTO` | 13/28 | 8/28 |
| `SPARSE_TEXT` | 11/28 | 13/28 |
| `SINGLE_LINE` | 10/28 | 0/28 |
| `SINGLE_WORD` | 6/28 | 0/28 |

**ADOPT: `SINGLE_BLOCK`.** §3. The denominator is a rule in the code, not a
slice: an earlier version measured "the first three scanned pages", one of which
was layout B and therefore not a segmentation measurement at all. The gate
asserts the rule.

Note the PSM values are **strings** in the installed Tesseract.js; passing a
number falls back to the default without error. The M2-4 spike found `AUTO`
unhelpful on full pages and this spike finds `SINGLE_BLOCK` better on crops —
both are right, about different inputs.

## 5. One OCR call per field, or one for the block

Both run end to end over the whole 25-page set, under the same field-level
source policy:

| | calls | pixels | wall clock | fields correct | words unplaced |
| --- | --- | --- | --- | --- | --- |
| per field | 35 | 10.81 Mpx | 2.1 s | 95/100 | — |
| **union region** | **9** | 14.55 Mpx | **1.6 s** | **96/100** | **0** |

**ADOPT: the union region.** §4. This reverses the earlier entry in this table,
and the earlier entry was not merely outvoted — its reasoning was false. It
claimed a union call "cannot say which of four values to look at". The union
path assigns each word to the field rectangle its centre falls in and produces a
per-field text, word count and confidence, exactly as per-field recognition
does. The gate asserts that every OCR-sourced field from the union path carries
its own confidence.

With that gone, nothing supports per-field: union is no less accurate, uses a
quarter of the calls and finishes faster. The trade is pixels — it rasterises
the gaps between fields.

Keep per-field recognition available as a fallback. The risk union carries is
attribution *correctness*: a word whose centre lands the wrong side of a
boundary is filed under the wrong field silently. Zero occurrences here, on a
corpus whose fields are well separated, and no measurement of how close is too
close.

## 6. Native or OCR

| option | aggregate | page 12 (mixed sheet) |
| --- | --- | --- |
| page-level switch | 93/100 | 1 of 4 fields, no warning |
| field-level | 95/100 | 3 of 4 fields |

**ADOPT: field-level.** §5, §7. Two fields separate them overall and three on
page 12, which is where the argument lives: a page-level switch reads one field
there, leaves three empty and reports nothing unusual.

The comparison is only meaningful because the page-level policy is now really
page-level. It previously fell back to OCR on an empty field, which is
field-level behaviour under a page-level name, and made the two indistinguishable.

Record the source per field regardless. Page 20 — a raster sheet carrying
somebody else's OCR text layer — is indistinguishable from authored text, so
"native" cannot mean "trustworthy".

## 7. Label and value in the same cell

| policy | exact | contains |
| --- | --- | --- |
| whole region verbatim | 5/99 | 96/99 |
| **last line** | **96/99** | 96/99 |
| trim the top 45% off the rectangle | 12/100 end to end | — |

**ADOPT, as a display default only.** §6. Last-line now presents every value
that was read at all.

The earlier figure was 64/87, and the gap was a defect in the measurement rather
than in the rule: both OCR paths flattened their output to one line, so an
OCR-sourced field had no last line to take. Grouping recognised words into lines
by vertical overlap — as the native reader already did — makes both paths the
same shape.

The condition is not optional: the split is a **view** over the raw text, and
`rawText` is kept per field and shown in review.

`rawText` means the extraction layer's output for that field, before any display
transformation — not the byte stream, not Tesseract's internals. Whitespace
normalisation belongs at that boundary (grouping tokens or words into lines) and
nowhere after it. An earlier version of this document promised "never trimmed"
while `buildRow()` trimmed on the way in; the contract and the code now agree.
The gate pushes a value with leading and trailing whitespace through both
display rules and through confirmation and asserts the stored raw text is
byte-identical every time.

The 12/100 row is a mechanical trim standing in for "ask the user to draw the
value area". It measures the crudeness of the proxy, not the idea.

## 8. Rows for pages that failed

| option | verdict |
| --- | --- |
| drop the page | **rejected** |
| row with empty values and a reason | **ADOPT** |

§8. 25 rows for 25 pages under every policy; silent page loss 0. The gate
proves the check can fire by building a row from a page with nothing on it.

There is no trade-off here to weigh. A register that is missing a sheet is
wrong in the way nobody checks for.

## 9. What confirms a row, and what a reviewer is shown

| option | verdict |
| --- | --- |
| confidence above a threshold | **rejected** |
| a person confirms it | **ADOPT** |

| review surface | verdict |
| --- | --- |
| the flagged rows | **rejected** |
| every row, ordered by doubt | **ADOPT** |

§9. Rows confirmed without a human: 0, by construction. Confidence orders the
surface; it never promotes.

**The surface holds all 25 rows, not the 5 flagged ones.** An earlier version
returned only rows carrying a reason, which turns "nothing flagged" into
"nothing to check" — and page 25 is wrong while carrying no flag at all,
because OCR misread it *confidently*. It would have been unreachable. It now
sits sixth of twenty-five, first among the unflagged, because its confidence is
the lowest of them.

A flagged subset still exists as an ordering aid for a UI that wants to lead
with the doubtful rows. It is not a work list, and nothing treats an empty one
as done.

| | |
| --- | --- |
| rows requiring human confirmation | **25 of 25** |
| of those, carrying a flag | 5 |
| rows wrong and unflagged | **1** (page 25) |
| rows actually edited | 3 |
| fields actually edited | 3 of 100 |

Confidence flagging catches an unsure reader and cannot catch a confidently
wrong one. That is an argument for the review step existing, not for tuning the
threshold.

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
| 10 | 34 | 1 | 33 |

**DEFER.** §10. Every setting that finds the planted gap also invents at least
one, on 25 pages. There is no threshold that makes this clean, because the
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
| **ADOPT** | user-placed template **and human-confirmed profile assignment** (`templateFits()` barred from deciding it); upright page space; region-only rasterising **with `/Rotate` undone**; `SINGLE_BLOCK`; **union OCR with per-field attribution** (per-field kept as a fallback); field-level source recorded per field; **per-field raw text, value, source and confidence kept through confirmation**; last line as a display default over raw text always shown; one row per page, including unassigned pages; candidate-until-confirmed with **every row on the review surface**; exact-match duplicates; XLSX through the existing writer; local OCR |
| **REVISE** | how a profile is *proposed* for a page nobody has assigned — propose and ask, never auto-pick |
| **DEFER** | gap inference; OCR preprocessing; any field beyond the four |

## What changed after review

| entry | was | now | why |
| --- | --- | --- | --- |
| 5. OCR call shape | per field | **union region** | the stated reason for per-field was false; union is no less accurate, a quarter of the calls, faster |
| 6. native or OCR | "a tie, 85/88 either way" | 93/100 vs 95/100 | the page-level comparator was doing field-level work, so the two were never compared |
| 7. label/value | REVISE, 64/87 | **ADOPT as a display default**, 96/99 | OCR output was being flattened to one line, so the rule could not apply to it |
| 3. rasterising | regions only | regions only, **un-rotated** | rotated scanned sheets were never exercised; they read 0/12 until fixed |
| 9. review burden | 0 wrong-but-unflagged | **1** | the corpus did not previously contain a page that could produce one |

## What changed after the second review

| entry | was | now | why |
| --- | --- | --- | --- |
| 9. review surface | the flagged rows | **every row** | the one row that is wrong and unflagged was unreachable |
| 2. template assignment | keyed on sheet size | **human-confirmed profile**, by page or range | two layouts share A2 in this corpus, and `templateFits()` says yes to both |
| 7. `rawText` | "never trimmed", while `buildRow()` trimmed | contract stated precisely, implementation matches | the promise and the code disagreed |
