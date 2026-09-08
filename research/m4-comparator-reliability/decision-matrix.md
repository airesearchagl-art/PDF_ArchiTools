# M4 decision matrix

Every number is from `evidence.json`, produced by
`scripts/m4-comparator-research-gate.mjs`. **Observed** unless marked otherwise.

## The candidates

| | |
| --- | --- |
| **0 — baseline** | what ships. Render each page on its own terms, size the field to the largest, draw each at the top-left, composite. No geometry examined. |
| **A — strict geometry** | compare only when the pages describe the same visible sheet; refuse by name otherwise. |
| **B — reference normalisation** | slot 1 is the reference; map others into its display plane where the mapping is rigid. Refuse where a rescale would be needed. |
| **C — human alignment** | when geometry cannot be settled by arithmetic, ask for an offset rather than guessing, and carry it on the result. |
| **D — automatic registration** | correlate the images and align by the best fit. **Not implemented** — see below. |

## What each says

| case | 0 | A | B | C |
| --- | --- | --- | --- | --- |
| the same drawing twice | CHANGE | CHANGE | CHANGE | CHANGE |
| a wall added | CHANGE | CHANGE | CHANGE | CHANGE |
| `/Rotate 0` vs `90` | CHANGE | CHANGE | CHANGE | CHANGE |
| crop origin (0,0) vs (50,70) | CHANGE | CHANGE | CHANGE | CHANGE |
| MediaBox larger, same CropBox | CHANGE | CHANGE | CHANGE | CHANGE |
| A4 vs A3, same drawing | CHANGE | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| portrait vs landscape | CHANGE | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| A4 vs a sheet 3pt bigger | CHANGE | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| same aspect, 1.4× | CHANGE | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| page 3 absent from one | CHANGE (1 member) | **MISSING_PAGE** | MISSING_PAGE | MISSING_PAGE |
| page 3 present but blank | CHANGE | CHANGE | CHANGE | CHANGE |
| one member fails to render | CHANGE (1 member) | **RENDER_FAILED** | RENDER_FAILED | RENDER_FAILED |

Candidate 0 has one verdict. It has no state for *I should not answer this*.

## The comparison

| | 0 | A | B | C |
| --- | --- | --- | --- | --- |
| false change on a same-size pair | **0.0%** | 0.0% | 0.0% | 0.0% |
| false change on A4 vs A3 | **99.4%** | refused | refused | refused, then human |
| false change on `/Rotate 0` vs `90` | **99.3%** | **0.0%** ¹ | **0.0%** ¹ | 0.0% ¹ |
| true change captured (wall added) | 9.6% | 9.6% | 9.6% | 9.6% |
| refuses when it should | **never** | yes (4/4) | yes (4/4) | asks (4/4) |
| distinguishes blank from missing | **no** | **yes** | yes | yes |
| survives a failed member | **produces 100% change** | refuses | refuses | refuses |
| human action needed | none | on 4 of 9 cases | on 4 of 9 | on 4 of 9, with a way forward |
| runtime, A4 150 dpi | 88 ms | 88 ms ² | 88 ms ² | 88 ms ² |
| peak working set, A1 150 dpi | 488 MB | 488 MB ² | 488 MB ² | 488 MB ² |
| deterministic | yes | yes | yes | yes |
| implementation complexity | shipped | low | moderate | moderate + UI |

¹ Once the pages are rendered upright, which costs nothing: measured at 0.0% of
ink differing across all three rotations, both canvases 1241×1754.

² The geometry policies decide *whether* to compare, not how. Where they compare,
the cost is the baseline's cost.

## 1. What to do about geometry

| option | verdict |
| --- | --- |
| compare anything, align top-left | **REJECT** — this is the defect |
| stretch a drawing onto another's sheet | **REJECT** — changes every length on it |
| refuse anything not provably the same sheet | **ADOPT** as the default |
| let a human supply the alignment | **ADOPT** as the way forward from a refusal |
| guess the alignment automatically | **DEFER** — see section 5 |

## 2. Rotation

| option | verdict |
| --- | --- |
| treat `/Rotate` as a difference | **REJECT** — it is a viewer instruction, not a drawing |
| render upright and compare | **ADOPT** |

Measured: 0.0% differing on all three rotations. This is a missing argument, not
a policy question, and it accounts for three of the eight false-change rows in
the baseline.

## 3. A page one document does not have

| option | verdict |
| --- | --- |
| skip it | **REJECT** — the report silently loses a page, or shows one document as if it were two |
| fail the whole export | **DEFER** — a human decision; see `architecture.md` |
| include it, marked as missing | **ADOPT** as the recommendation |

Whichever is chosen, `MISSING_PAGE` must be a distinct outcome from a page that
exists and is blank. Measured: the strict policy separates them (`MISSING_PAGE`
vs `CHANGE`); the baseline does not.

## 4. A member that fails to render

| option | verdict |
| --- | --- |
| continue with the survivors | **REJECT** |
| refuse the page, and the export | **ADOPT** |

The measurement is what settles this. A surviving member alone reads as
**100.0% changed**, because its ink has nothing to match against. The current
behaviour does not degrade to a partial answer; it produces the most alarming
possible wrong one.

## 5. Automatic registration

**DEFER, and not measured.** Deliberately: the corpus is built with a border, a
title block, a repeating grid and a repeated label, because those are what
architectural sheets carry — and they are exactly the features that make a
correlation peak strong in the wrong place. A registration confident to 99% on a
grid is confident about the grid.

Adopting it would also mean adopting the thing this whole spike is about: an
answer the user cannot check. It is a candidate for a later spike with its own
evidence, not something to fold into this one.

## 6. The threshold

| option | verdict |
| --- | --- |
| pixel radius (today) | **REJECT** — 0.339 mm at 150 dpi, 0.085 mm at 600 |
| millimetres, converted per render | **ADOPT** |
| PDF points | acceptable; mm is the drawing office's unit |

Measured: 0.5 mm converts to 1 / 3 / 6 / 12 px at 72 / 150 / 300 / 600 dpi. The
setting stays the same and the comparison means the same thing.

## 7. Requested resolution

| option | verdict |
| --- | --- |
| cap silently, keep the filename | **REJECT** — an A0 asked at 600 dpi delivers 227 and is named `_600dpi.pdf` |
| refuse over budget | **ADOPT** as the floor |
| offer the achievable resolution and let the user accept it | **ADOPT** as the recommendation, subject to a human decision |

Never a silent downgrade. Measured: A0 at 300 dpi and at 600 dpi both deliver
227 dpi and are named differently.

## 8. The render budget

| option | verdict |
| --- | --- |
| reuse the Annotator's 8 Mpx | **REJECT** — that bounds one fragment; this holds every layer at once |
| bound one canvas | **REJECT** — understates a 2-layer comparison ~5× |
| bound the whole working set | **ADOPT** |

Proposed: **512 MB**, checked before allocation. Measured against it:

| | pixels | working set | |
| --- | --- | --- | --- |
| A4 300 dpi, 2 layers | 8.7 Mpx | 244 MB | within |
| A3 300 dpi, 2 layers | 17.4 Mpx | 487 MB | within |
| A1 300 dpi, 2 layers | 69.7 Mpx | 1951 MB | **over** |
| A1 300 dpi, 4 layers | 69.7 Mpx | 3066 MB | **over** |
| A0 600 dpi, 2 layers | 558 Mpx | 15623 MB | **over** |

The number is a judgement about how much memory one comparison may claim, not a
threshold discovered in the data, and it is written down as one. What the data
does establish is the *shape*: the cost is layers × pixels × 4 bytes, several
times over.

## 9. Export format

| option | verdict |
| --- | --- |
| JPEG (today) | **DEFER** — see `limitations.md`; artefact cost unmeasured |
| PNG | **DEFER** — lossless, larger |

Not settled here. The comparison output is a report rather than a preserved
source document, so vector preservation is not required of it — but whether
JPEG artefacts degrade the change evidence was not measured, and is listed as an
open question rather than answered.

## Summary

| | |
| --- | --- |
| **ADOPT** | **A + B + C in that order.** Strict validation decides whether a comparison is meaningful; safe normalisation handles rotation and crop origin, which are provable; human alignment is the way forward when geometry genuinely differs. Plus: upright rendering, a physical threshold in millimetres, a stated working-set budget checked before allocation, structured results rather than only a picture, and atomic export. |
| **REJECT** | **Candidate 0.** Not as an implementation detail — as a contract. Its single verdict is what makes a wrong answer indistinguishable from a right one. |
| **DEFER** | **Candidate D** (automatic registration), the JPEG/PNG question, and the alignment UI. |

## What this does not claim

The comparator is not fixed. Nothing here has been implemented in `src/`. What
has been established is that four named failures are real and reproducible, that
three of them are settled by arithmetic rather than by policy, and that the
fourth needs a human decision that is listed in `architecture.md`.
