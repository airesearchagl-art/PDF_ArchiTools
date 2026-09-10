# M4 — comparator reliability and geometry

**Research only.** Nothing here is imported by the app, and `src/` is unchanged.
Base: `main` at `44cb82db7365e436c642f375852f22990c45a6ce`.

## The question

The comparator finds real changes and finds them quickly. It has no way of
declining. Every input produces a picture, so a picture is not evidence of
anything — and the picture for *the same drawing on a different sheet size*
looks more alarming than the picture for *a wall that moved*.

| | reported as changed |
| --- | --- |
| a wall added — a real revision | **9.6%** |
| the same drawing, A4 against A3 | **99.4%** |
| the same drawing, `/Rotate 0` against `90` | **99.3%** |
| the same drawing, a sheet 3 pt bigger | **75.9%** |

A reviewer cannot tell those apart.

Three more, found by measuring rather than by reading:

| | |
| --- | --- |
| one member fails to render | the survivor alone reads as **100% changed** |
| four documents, two saying one thing and two another | reported as a **clean match** |
| the change report's render scale | **uncapped** — an A1 at zoom 6 and 600 dpi asks for ~281 GB |

## The documents

| | |
| --- | --- |
| `baseline.md` | what ships today, measured |
| `measurements.md` | every number, with the corpus that produced it |
| `decision-matrix.md` | candidates 0/A/B/C/D and the ADOPT / REJECT / DEFER |
| `architecture.md` | the proposed design |
| `limitations.md` | what was not established |
| `evidence.json` | the machine-readable measurements |

`Observed`, `Inferred` and `Proposed` are kept apart: `baseline.md` and
`measurements.md` are observations, `architecture.md` is a proposal, and
`limitations.md` says which is which where it is not obvious.

## Reproducing

```
node scripts/m4-comparator-fixtures.mjs
node scripts/m4-comparator-research-gate.mjs
```

**179 assertions, 74 of them negative probes.** Several assert that the shipped
comparator gets something wrong; those are the findings, and a gate the baseline
passed would prove nothing. It gates the write-up, not the app, and is
deliberately **not** wired into Core CI.

No customer document is used. Every fixture is generated and none is committed.
External HTTP(S) requests: 0.

## The research recommendation

Everything below is a **recommendation**, not a decision. The policy questions
are listed under Human Decisions and belong to the Human Product Gate.

**A + B — implementation-ready**, as two responsibilities rather than two
alternatives:

- **strict validation** decides whether a comparison is meaningful at all;
- **canonical upright normalisation** handles rotation and crop origin, which
  are provable arithmetic — rendering upright takes the rotation false-change
  from 99.3% to **0 differing pixels** — and maps other members onto the
  reference by the **identity** or refuses. `READY_TO_COMPARE` means every
  mapping is rigid; there is no third case.

With: **two stages** — a plan that says whether a comparison can be made, then a
verdict that says what it found, so `CHANGE` never means "carry on"; a verdict
computed from a **canonical ink mask with no ratio floor**, before anything is
painted, so the answer is not a property of the palette; **one engine** behind
the preview, the export and the change report, which today each decide
independently what a comparison means; a spatial tolerance in millimetres under a
stated policy; a **peak** working-set budget checked against a derived,
content-independent bound and a **job-level** work budget, both evaluated before
allocation and both refusing by name rather than degrading; a comparison that can be abandoned;
structured results rather than only an image; and an export that produces no
bytes until every page is complete.

**C — a conditional follow-on, not part of this recommendation.** Human
alignment is the right way forward from a refusal and it is not researched: the
prototype records `{ x, y, rotation, scale }` without defining a coordinate
space, units, transform order, pivot, bounds or provenance, and no aligned
comparison has ever been run. If the Human Gate answers **H1** with "offer human
alignment", an **Alignment Architecture Sub-Spike is required before M4
production implementation**. The recommended M4 MVP is instead: geometry
mismatch → `GEOMETRY_MISMATCH` → fail closed, which is a complete feature on its
own.

**REJECT candidate 0** — not as an implementation but as a contract. Its single
verdict is what makes a wrong answer indistinguishable from a right one.

**DEFER candidate D** (automatic registration), **all-member consensus** as a
multi-member contract, the JPEG/PNG question, and the alignment UI.

## What is already right

Worth saying, because not everything is broken: the CropBox origin is handled
correctly today — the same visible region from origins (0,0) and (50,70)
compares at **0.0%**, because PDF.js renders from each page's own box. A larger
MediaBox around the same CropBox, likewise. No work needed there.

## Human decisions needed before implementation

These are not the spike's to settle.

| | | |
| --- | --- | --- |
| **H1** | geometry mismatch | refuse outright, or offer human alignment? **Answering "offer alignment" requires an Alignment Architecture Sub-Spike before M4 production implementation** — the transform contract does not exist yet, and no aligned comparison has been run. |
| **H2** | a missing page | fail the whole export, or include the page marked as missing? |
| **H3** | over budget | refuse, or offer the achievable resolution to accept? Never a silent downgrade — an A0 asked at 600 dpi currently delivers 227 and is named `_600dpi.pdf`. |
| **H4** | alignment | should an offset, scale and rotation be saved with the comparison? |
| **H5** | export format | JPEG or PNG? Artefact cost unmeasured. The memory bound is derived from **PNG**, which has a provable worst case; JPEG has none, which is a reason to prefer PNG and is offered as such. If JPEG is chosen the allowance must be re-derived for it. Separately, the research recommends `canvas.toBlob` over `toDataURL` either way: base64 in the peak working set costs 464 MB against 278 MB on an A3 at 300 dpi. |
| **H6** | the spatial tolerance policy | Not just a unit. A spatial tolerance can suppress a true change — measured at all four supported resolutions, a dimension changed from 1200 to 1300 becomes a MATCH at **0.2 mm at 72 dpi** and at 0.3 mm at 150 — so the policy has to settle **unit** (proposed mm), **default** (proposed **0 mm**), **minimum** (0, always available), **maximum** (proposed **0.15 mm**: the *minimum* safe bound across 72/150/300/450 dpi, not what the middle of the range would allow), **step** (proposed 0.05 mm), whether a non-zero value is an **explicit opt-in** (proposed yes), and the **disclosure** shown with it — which must not say "ignores small shifts", because measured it also erases a changed digit and a swapped symbol. A DPI-dependent maximum is rejected: the same number in the same box would mean different things depending on another setting. |
| **H7** | the working-set budget | **512 MiB is a recommendation, not a measurement.** The measurements establish the shape of the cost, not where the line goes. Requires approval; never silently exceeded. |
| **H8** | the ink predicate | the two shipped functions disagree — mean of channels versus any channel — and a pale yellow falls between them. One definition must serve the composite, the change bounds, the verdict and the change report. Whether the pale-grey hatch stays invisible is part of the same choice. |
| **H9** | more than two members | **A: two-only** (measured) or **B: reference-pairs** (measured)? **C: all-member consensus — DEFER, requires separate research**; it is described and implemented nowhere, so it is refused rather than offered. The shipped any-other-layer rule reports a two-against-two disagreement as a clean match, so it is not among the options either. |
| **H10** | the work ceiling, **for the whole job** | **`MAX_COMPARISON_WORK_UNITS = 12,000,000,000` is a recommendation, not a measurement.** One ceiling on the total, not one per page: the export and the change report run over ranges, and five A4 pages that each pass comfortably are 14.79e9 units together and refused. Calibrated from one observation on one machine, projecting to roughly 55 seconds for the operation. User-visible, because it refuses comparisons. Requires approval; never silently degraded to fit. |

One decision each. **The MATCH ratio floor is not on this list**: the research
recommends none, and it is **fixed at zero for the M4 MVP** rather than offered
as a setting. There is no control on the corpus that needs one — every control
reaches 0 differing pixels — and six of seven true changes were hidden by the
0.5% floor that was there. The setting that does this job, in a unit a user can
reason about, is the spatial tolerance under H6.

## What this does not claim

The comparator is not fixed. Large-format comparison is not supported — it is
bounded, which is a different statement. Automatic alignment is neither shown to
be reliable nor shown to be unreliable; it was not run. No production
implementation should start on this document alone.
