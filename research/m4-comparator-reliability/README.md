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

**65 assertions, 25 of them negative probes.** Several assert that the shipped
comparator gets something wrong; those are the findings, and a gate the baseline
passed would prove nothing.

No customer document is used. Every fixture is generated and none is committed.
External HTTP(S) requests: 0.

## The recommendation

**ADOPT A + B + C, in that order**, as three responsibilities rather than three
alternatives:

- **strict validation** decides whether a comparison is meaningful at all;
- **safe normalisation** handles rotation and crop origin, which are provable
  arithmetic — rendering upright takes the rotation false-change from 99.3% to
  **0.0%**;
- **human alignment** is the way forward when the geometry genuinely differs,
  and the result carries the alignment it was made under.

With: a physical threshold in millimetres, a stated working-set budget checked
before allocation, structured results rather than only an image, and an export
that produces no bytes until every page is complete.

**REJECT candidate 0** — not as an implementation but as a contract. Its single
verdict is what makes a wrong answer indistinguishable from a right one.

**DEFER candidate D** (automatic registration), the JPEG/PNG question, and the
alignment UI.

## What is already right

Worth saying, because not everything is broken: the CropBox origin is handled
correctly today — the same visible region from origins (0,0) and (50,70)
compares at **0.0%**, because PDF.js renders from each page's own box. A larger
MediaBox around the same CropBox, likewise. No work needed there.

## Human decisions needed before implementation

These are not the spike's to settle:

1. **Geometry mismatch** — refuse outright, or offer human alignment?
2. **A missing page** — fail the whole export, or include the page marked as
   missing?
3. **Over budget** — refuse, or offer the achievable resolution for the user to
   accept? (Never a silent downgrade: an A0 asked at 600 dpi currently delivers
   227 and is named `_600dpi.pdf`.)
4. **Alignment** — should an offset, scale and rotation be saved with the
   comparison?
5. **Export format** — JPEG or PNG? Artefact cost is unmeasured.
6. **Threshold unit** — millimetres or PDF points?

## What this does not claim

The comparator is not fixed. Large-format comparison is not supported — it is
bounded, which is a different statement. Automatic alignment is neither shown to
be reliable nor shown to be unreliable; it was not run. No production
implementation should start on this document alone.
