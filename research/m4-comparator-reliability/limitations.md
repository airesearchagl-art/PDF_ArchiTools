# M4 limitations

What this spike did not establish. Listed rather than left for a reviewer to
notice.

## The corpus is synthetic, and one drawing

Thirty-one fixtures, all variations of a single generated plan: a border, a
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

## The worst case is measured, but only on one shape

A non-matching pair is now in the corpus: 1.56 us per ink pixel against 0.59 us
when the drawings match, at radius 3. That is the effect isolated, and isolating
it required normalising by ink pixel — the adversarial pair is the *sparser*
drawing, so wall-clock page times would have credited it for having less to do.

What is still missing is the shape of the worst case beyond this one pair. The
dense fixtures are short horizontal strokes; a drawing dense in a different way —
fine hatch, dense text, a photographic underlay — could behave differently, and
the ink fraction here (1.7-1.9%) is low for a busy construction sheet.

The `pixels x radius squared x members` upper bound in `architecture.md` is
arithmetic, not measured at scale: no comparison near the proposed budget was run
to completion, deliberately.

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

The ownership section in `architecture.md` reuses M3's shape — a mount flag and a
generation counter — and no cancellation, supersession or unmount behaviour was
exercised here. It is a proposal by analogy.

One thing about it *is* established, by reading the code rather than by
measurement: the composite is a synchronous double loop with no yield point, so a
comparison in progress cannot observe a cancellation flag at all. Ownership stops
a stale result being *published*; it does not make a long comparison stop.
Whether the loop is chunked, replaced with a bounded lookup, or bounded before it
starts is an open architecture decision that this spike does not settle.

## The multi-member contract is measured, not chosen

Four-member sets are measured — a two-against-two split is reported as a clean
match by the shipped rule, and caught by reference-pairs — but which contract to
adopt is a product question listed as H9. All-member consensus is described and
**not measured**: no consensus implementation was run against the corpus.

The 3- and 4-way fixtures are the same plan with the wall in one of two places. A
real four-way revision set would differ in more ways than that.

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

## Ink detection is described, not fixed

The two functions disagree, and one colour that demonstrates it was found. What
the *right* ink test is — for antialiased CAD linework, for coloured layers, for
hatch — is not answered here. A pale grey hatch is invisible to both, which is
recorded as a current limit rather than proposed as acceptable.

## The three pipelines were compared on paper, not driven

The divergence between the preview, the export and the change report is
established from their source and from arithmetic on their scale formulas.
**None of the three was driven through the real UI in this spike**, so the 281 GB
figure for the change report is what it would *ask for* — not something that was
allocated, and not a failure that was observed. The parity requirement in
`architecture.md` is written as a production gate precisely because it was not
executed here.

## One machine, one browser

Headless Chromium on one laptop. Every millisecond figure is that machine.

## What this does not claim

The comparator is not fixed. Large-format comparison is not supported — it is
*bounded*, which is a different statement. Automatic alignment is not shown to be
unreliable either; it is untested. Nothing here has been implemented in `src/`.
