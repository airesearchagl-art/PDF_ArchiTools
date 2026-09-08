# M4 limitations

What this spike did not establish. Listed rather than left for a reviewer to
notice.

## The corpus is synthetic, and one drawing

Twenty-four fixtures, all variations of a single generated plan: a border, a
title block, a five-by-four grid, one labelled string, and a wall that moves.
Real construction drawings carry dimension strings, hatch, text at several
sizes, symbols, xrefs and scanned underlays, and they are produced by CAD
exporters whose output this does not imitate.

The geometry findings do not depend on the drawing — a sheet size is a sheet
size — but every *ratio* here does. "99.4% of ink flagged" is 99.4% of this
drawing's ink.

## The change set is three changes

A wall added, a wall removed, the whole drawing shifted 2 pt. Nothing that
matters in practice and is hard to see: a dimension string edited, a symbol
swapped, a revision cloud, text reflowed by a font substitution.

The 9.6% figure for "a real change" is one change on one drawing, and it is used
here only as a control — to show the detector works — not as a claim about
sensitivity.

## The false-change numbers are a proxy

`changeRatio` counts composite pixels whose channels are far apart, i.e. painted
in a layer colour rather than the matched colour. That is a good proxy for "the
tool is calling this a change" and it is not the same as what a user would judge.
A 99.4% and a 75.9% are both "almost everything"; the gap between them is not
meaningful.

## The worst case for the threshold cost was not measured

Radius 4 measured *faster* than radius 2 (55 ms against 48), because
`hasNeighborInAny` returns on the first ink it finds and a wider box finds one
sooner. That makes the measured cost a best case: on a drawing where the marks
mostly do **not** match — the case the tool exists for — the search runs to
completion every time and the cost should grow with the box area.

That case was not constructed. The cost figures in `measurements.md` 9 should be
read as a floor.

## The budget is a judgement, not a discovered threshold

512 MB is chosen, not found. What the measurements establish is the *shape* of
the cost — layers x pixels x 4 bytes, about five canvases over for two layers —
and that an A1 at 300 dpi needs 1.95 GB while passing the existing canvas caps.
Where to draw the line is a decision about how much memory one comparison may
claim on a machine nobody has specified.

Nothing over the budget was allocated, so the failure mode past it is
**calculated, not observed**. Whether a browser fails cleanly or takes the tab
with it at 2 GB is untested here, and deliberately so.

## Cancellation and ownership are proposed, not measured

Section on ownership in `architecture.md` reuses M3's shape — a mount flag and a
generation counter — and no cancellation, supersession or unmount behaviour was
exercised in this spike. It is a proposal by analogy.

## Automatic registration was not implemented or measured

Deliberately. It is listed as DEFER on the grounds that a repeating grid, a
repeated title block and a common border are strong features that can align
confidently in the wrong place. That is an argument, not a measurement, and it
should be stated as such: **no registration algorithm was run against this
corpus**.

## JPEG artefacts were not measured

The export is JPEG at quality 0.85. Whether that degrades change evidence — a
hairline that survives at PNG and does not at JPEG — was not tested, and the
JPEG/PNG question is left open rather than answered.

## The comparison PDF was not reopened

The brief asks for the exported comparison to be reopened and checked for page
count, dimensions, orientation and renderability. This spike measured the
compositing and the geometry, not the jsPDF assembly, so **that check was not
run**. It belongs in the implementation's gate.

## Preview and export were not compared against each other

Preview uses `scale * (dpi / 72)`; export uses `dpi / 72`
(`PdfComparator.tsx:147` and `:255`). Both were read; only the export path was
measured. Whether the two produce the same verdict at the same settings is
unmeasured.

## Ink detection is described, not fixed

The two functions disagree, and one colour that demonstrates it was found. What
the *right* ink test is — for antialiased CAD linework, for coloured layers, for
hatch — is not answered here. A pale grey hatch is invisible to both, which is
recorded as a current limit rather than proposed as acceptable.

## Only two members were compared

The tool supports four slots. Everything measured here is two layers, except the
memory arithmetic, which extends to four by calculation. Three- and four-way
comparisons have their own question — what "matched" means when only some
members agree — and it was not examined.

## One machine, one browser

Headless Chromium on one laptop. Every millisecond figure is that machine.

## What this does not claim

The comparator is not fixed. Large-format comparison is not supported — it is
*bounded*, which is a different statement. Automatic alignment is not shown to be
unreliable either; it is untested. Nothing here has been implemented in `src/`.
