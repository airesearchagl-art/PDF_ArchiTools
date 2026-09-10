# M4 — comparator reliability, proposed architecture

**Proposed.** Nothing here is implemented; `src/` is unchanged. The measurements
this rests on are in `baseline.md` and `measurements.md`, and the candidate
comparison is in `decision-matrix.md`.

## What is wrong now

The comparator finds real changes and finds them quickly. It has no way of
declining.

Every input produces a picture, and the picture for *the same drawing on a
different sheet size* (99.4% of ink flagged) looks more alarming than the picture
for *a wall that moved* (9.6%). A reviewer has no way to tell which they are
looking at.

Four failures, all measured:

| | |
| --- | --- |
| a different sheet size or orientation | compared anyway, top-left aligned |
| a `/Rotate` difference | compared anyway, at up to 99.3% false change |
| a page one document does not have | the other document compared against nothing |
| a member that fails to render | the survivor alone, reading as 100% changed |

## What a comparison is

A comparison is an **assertion about a drawing**, not an image. The output today
is only an image, which is why nothing downstream can distinguish these cases.

It happens in **two stages**, and keeping them apart is load-bearing. A first
version of this document used one vocabulary, and `CHANGE` ended up meaning both
"the geometry is fine, carry on" and "the drawing differs" — so an identical
drawing came back as `CHANGE`, which is the kind of answer this design exists to
prevent.

**The plan** says whether the comparison can be made at all:

```
READY_TO_COMPARE    the members can be compared, and here is how
MISSING_PAGE        a member does not have this page
GEOMETRY_MISMATCH   the pages do not describe the same sheet
ALIGNMENT_REQUIRED  they could be compared with an alignment the tool will not invent
RENDER_FAILED       a member could not be read
OVER_MEMORY_BUDGET  the working set is over the ceiling
OVER_WORK_BUDGET    the work is over the ceiling
UNSUPPORTED         the request cannot be honoured at all
CANCELLED           superseded or abandoned
```

The two budget statuses are separate because the two ceilings are: an A4 at
300 dpi is comfortable on memory and, at a half-millimetre tolerance, three
billion neighbourhood reads.

**The result** says what was found, and is reachable only from a plan that was
ready and a comparison that actually ran:

```
MATCH               the change mask is empty
CHANGE              differences found, and here they are
```

Measured: identical → `READY_TO_COMPARE` → **MATCH** (0 differing pixels);
a wall added → `READY_TO_COMPARE` → **CHANGE** (9.6%); a rotation-only pair →
**MATCH** once rendered upright; a different sheet → `GEOMETRY_MISMATCH` and
**no verdict at all**.

### What the verdict is computed from

```
    each member rendered in canonical upright space
      -> canonical ink predicate            -> one ink mask per member
      -> physical spatial tolerance (mm)    -> canonical semantic change mask
      -> mask empty ? MATCH : CHANGE
      -> and only then, the picture
```

The verdict comes from the **masks**, before anything is painted. None of the
following may reach it: layer display colours, the match colour, the match
opacity, JPEG against PNG, the preview's styling. Measured on the same changed
pair under three palettes — the mask is 51 pixels in all three and the verdict
is `CHANGE` in all three, while the count taken from the painted composite reads
51, 0 and 51 depending only on which colours were chosen.

**The match floor is zero.** An earlier version of this document set it at 0.5%
of ink on the reasoning that rendering is not bit-exact. The corpus does not
support that: every control — an identical drawing, a rotation-only pair
rendered upright, a crop-origin pair, a redraw of the same sheet — comes back at
**exactly 0 differing pixels**, so a zero floor does not make MATCH unreachable.
What the floor did do was hide real revisions. Measured against a corpus of
small true changes:

| a true change to the drawing | pixels | of the ink | at a zero floor | under a 0.5% floor |
| --- | --- | --- | --- | --- |
| a light hatch added | 43 | 0.053% | **CHANGE** | MATCH |
| the pale-hatch fixture | 43 | 0.054% | **CHANGE** | MATCH |
| one digit of a dimension, 1200 → 1300 | 51 | 0.063% | **CHANGE** | MATCH |
| a 4 mm revision triangle added | 160 | 0.198% | **CHANGE** | MATCH |
| one short fine line added | 200 | 0.248% | **CHANGE** | MATCH |
| a symbol swapped, circle → square | 394 | 0.488% | **CHANGE** | MATCH |
| a wall added | 8530 | 9.640% | **CHANGE** | CHANGE |
| *nothing changed (control)* | *0* | *0.000%* | *MATCH* | *MATCH* |

Six of the seven true changes on that corpus were converted into matches by the
floor. A drawing office would have been told a reissued sheet was unchanged.

Render variance, where it exists, is a *spatial* disagreement of a pixel or two
along a line, and the tolerance for it is the physical radius in millimetres,
applied to the mask. That is not free either, and the number is the user's:
0.5 mm at 150 dpi erases the changed digit entirely (51 → 0 pixels). A share of
the page cannot tell a hairline everywhere from a wall in one place; a stated
distance can, and it can be argued about in units a drawing office already uses.

The research recommendation is **no ratio floor at all**, and it is **fixed at
zero for the M4 MVP** rather than left as a setting: the corpus shows a floor
has no control it is needed for and six revisions it hides. What replaces it is
the spatial tolerance below, which is a stated distance under a stated policy
(**H6**) rather than a share of the page.

Each status carries what the user needs to act: which member, what differs, what
would resolve it. The image, when there is one, is one field of the result.

## The pipeline

```
   the requested members and pages
             |
   for each page: is every member present?        -> MISSING_PAGE
             |
   do the pages describe the same visible sheet?
      rotation only        -> render upright, continue
      crop origin only     -> already removed by rendering, continue
      sheet size differs   -> GEOMETRY_MISMATCH / ALIGNMENT_REQUIRED
             |
   what does the requested DPI cost?
      over budget          -> refuse, or offer what fits (human decision)
             |
   render every member                            -> RENDER_FAILED
             |
   composite, with the threshold converted from mm
             |
   all pages complete
             |
   the comparison PDF
             |
   download
```

Nothing is downloaded until every page is finished. A partial comparison that
looks complete is the failure this design exists to prevent, and it is worse
than no comparison at all.

## One engine, three presentations

The tool has three user-facing paths — the preview, the full comparison PDF, and
the change report — and today each decides for itself what a comparison means.
They do not agree:

| | render scale | capped |
| --- | --- | --- |
| preview (`PdfComparator.tsx:147`) | `scale * (dpi / 72)` | yes |
| export (`:255`) | `dpi / 72` | yes |
| change report (`:416`) | `scale * (dpi / 72)` | **no** |

`generateChangeReport` has no `MAX_DIM` or `MAX_AREA` anywhere in it. An A1 at
zoom 6 and 600 dpi asks it for **10,035 Mpx — about 281 GB** — where the export
would have capped the same request. They also disagree about a missing page in
three different ways (`:173`, `:316`, `:437`).

So: **one planner and one comparison, three presentations.**

```
prepareComparisonJob(members, pages, settings)
   -> validate members and pages
   -> resolve geometry, and normalise upright
   -> resolve the effective DPI against the budget
   -> bound the work
   -> render every required member
   -> compare
   -> ComparisonPageResult per page
```

The preview, the export and the change report all consume that result. They may
**render** it differently — a preview on screen, a page in a PDF, a cropped
detail with a caption. None of them may independently:

- skip a missing page
- choose a geometry
- cap a DPI
- decide what counts as ink
- compute a different threshold
- swallow a render failure
- recompute what a change is

**An acceptance requirement for the implementation**, recorded now so it is not
discovered later: for the same sources and settings, the preview, the export and
the change report must report the **same status**. A missing page, a render
failure, a geometry mismatch and an over-budget request must each produce the
same status in all three. That is a production gate for the implementation PR,
not something this research PR executes.

## More than two members

The tool has four slots and the shipped rule is *any other layer*: a pixel is
matched when any other member has ink near it. With two members that is
agreement. With four it is not, and the failure is silent:

| | reported by the shipped rule |
| --- | --- |
| A and B put a wall in one place, C and D in another | **MATCH** |
| a reference and three documents that each differ from it | **MATCH** |

Every pixel finds a partner, so a genuine disagreement comes back clean.

Two contracts are implemented and measured, and the choice between them is a
product question rather than a technical one, so it goes to the Human Gate
(**H9**):

| | | |
| --- | --- | --- |
| **A — two members only** | three or more refused as `UNSUPPORTED`. The smallest honest contract. | measured |
| **B — reference pairs** | each non-reference member compared against slot 1 independently; MATCH only when every pair matches. Catches both failing cases above — measured at 19.3% per pair for the two-against-two set. | measured |
| **C — all-member consensus** | a location matches only when every member agrees. Stricter. | **DEFER — separate research required** |

Consensus is described here and implemented nowhere. Nothing is known about what
it does with a blank member, a member the other documents do not have, or a
member that failed to render, and those are exactly the cases where a stricter
rule behaves least like its description. Offering it beside two contracts that
*have* been run against the corpus would make it look equally ready, so
`planMultiMember` refuses it at every member count rather than returning a plan.
Making it selectable means first running a prototype against, at minimum: four
identical members, three the same and one changed, two against two, a reference
against three different documents, one blank member, one missing member, and one
member that failed to render.

What is not viable is the current rule, because it can be cancelled.

## Geometry

### Rotation is not a difference

`/Rotate` is an instruction to the viewer, not a property of the drawing.
Rendering with `getViewport({ rotation: 0 })` makes all four rotations of the
same page produce identical canvases: **0.0% of ink differing**, both canvases
1241×1754, on all three of 90/180/270.

This is the single largest source of false change in the baseline and it is one
argument that is not currently passed. It needs no policy.

### Every comparison happens in canonical upright space, and only rigidly

```
    source PDF geometry
      -> inspect the physical visible box    (CropBox, else MediaBox; /Rotate ignored)
      -> normalise rotation to upright       (getViewport({ scale, rotation: 0 }))
      -> compare canonical upright geometry
      -> produce only a rigid mapping, or refuse
```

There are two cases and no third. Either the visible boxes are the same sheet
within the stated 1 pt, and the mapping is the **identity** — upright, from each
page's own origin, scale 1 — or they are not the same sheet and there is no
mapping at all.

That is not a preference; the alternative was measured and it is wrong. An
earlier version of the reference-normalisation candidate computed a scale from
the pages' *display* dimensions. For an A4 at `/Rotate 0` against the same A4 at
`/Rotate 90` that gives:

```
x = 0.707   y = 1.414   uniform = false   rigid = false
```

— an anisotropic stretch across two pages that are the same piece of paper — and
the plan returned `READY_TO_COMPARE` regardless. Rendering upright removes the
quarter turn *before* any mapping is computed, so the stretch never arises.

The invariant, checked rather than asserted:

```
status == READY_TO_COMPARE  =>  every mapping.rigid == true
                            and every |scaleX - scaleY| == 0
                            and every renderRotation == 0
```

Measured on all eight required pairs — `/Rotate` 0 against 0, 90, 180 and 270;
crop origin alone; and crop origin combined with each of the three rotations.
Every one is `READY_TO_COMPARE` with a rigid identity mapping, and every one
reaches **MATCH with 0 differing pixels** when the comparison is actually run.
The display-plane mapping would have been anisotropic on four of them (0.707 /
1.414 for the rotations, 0.668 / 1.497 for the cropped ones). A different
physical sheet still reaches `GEOMETRY_MISMATCH`.

### The crop origin is already handled

PDF.js renders from each page's own visible box, so a CropBox at (50,70) and one
at (0,0) covering the same region produce the same canvas: **0.0% differing**,
measured. A larger MediaBox around the same CropBox likewise. No work needed —
and saying so matters as much as naming what is broken.

### Sheet size is a question, not an arithmetic problem

A drawing reissued from A1 to A3 is at a different scale. Matching the extents
would compare a 1:50 plan with a 1:100 one and call the difference a change.
Scaling one onto the other changes every length on it — in a tool whose users
measure things.

So a different physical sheet is **refused**, with the sizes named, and the user
is offered alignment rather than a silent guess.

**One point** is the tolerance for calling two sheets the same, applied to width
and height independently.

Not three. A 3 pt difference — about a millimetre — produces **75.9%** false
change, so it is emphatically not a rounding artefact to absorb. A point is
about a third of a millimetre.

Probed either side: A4 + 0.99 pt is `READY_TO_COMPARE`, A4 + 1.01 pt is
`GEOMETRY_MISMATCH`, A4 + 3.00 pt is `GEOMETRY_MISMATCH`.

**Same aspect ratio is not the same sheet.** A4 proportions at 1.4× scored 99.4%
false change, and would pass any check based on proportions alone.

## Alignment

Half of this is settled and half of it is not, and the halves have to be kept
apart.

**Settled: the refusal.** When geometry genuinely differs the tool says so by
name, and does not guess. The tool proposes nothing — an offer of "we think it
is 12.4 pt across" becomes the answer the moment it is displayed, and this is
the tool that is supposed to stop that happening.

**Not settled: what happens next.** Letting a person supply an offset, a
rotation and a scale is a good answer to that refusal, and it is not a
researched one. The prototype records `{ x, y, rotation, scale }`; it does not
define it. None of the following exists yet:

| | |
| --- | --- |
| coordinate space | reference upright space, source page space, or canvas pixels? |
| units | points, millimetres, or pixels at some resolution? |
| transform order | translate-then-rotate-then-scale, or another order? |
| rotation pivot | page origin, box centre, or a point the user picks? |
| scaling | uniform only, or may the axes differ — and if they may, every length on the drawing changes |
| bounds and validation | what is a rejectable alignment, and what does rejecting it say? |
| CropBox / upright interaction | the alignment composes with the normalisation above; in which order? |
| memory and work after alignment | both estimates are computed from a frame the alignment may change |
| provenance | how the alignment is carried on a saved result, so a comparison is never separable from it |
| evidence | no aligned comparison has been run end to end, so no aligned MATCH or CHANGE has ever been produced |

So `candidateHumanAlignment` returns `ALIGNMENT_REQUIRED` when there is no
alignment, and — deliberately changed from the previous round — **refuses**
rather than returning `READY_TO_COMPARE` when one is supplied. A plan may not
claim a comparison it has no contract for. That is the same rule the Candidate B
fix above rests on, applied to the same kind of unearned readiness.

**If the Human Gate answers H1 with "offer human alignment", an Alignment
Architecture Sub-Spike is required before M4 production implementation**, and it
must settle every row of that table with evidence, including an actual aligned
comparison that reaches a verdict and back.

**The recommended M4 MVP does not include it.** Geometry mismatch →
`GEOMETRY_MISMATCH` → fail closed. That is a complete, honest feature on its
own: it never reports its own coordinate handling as a design change, which is
the defect this whole spike exists for. Alignment is the follow-on that makes a
refusal recoverable, and it is worth doing properly rather than early.

**Automatic registration is deferred and was not measured.** The corpus carries a
border, a title block, a repeating grid and a repeated label on purpose: they are
what architectural sheets have, and they are what makes a correlation peak strong
in the wrong place. Confidence in a registration is confidence about the grid.

## Failing

Fail closed, and fail whole.

| | |
| --- | --- |
| a member has no such page | the page is reported as `MISSING_PAGE`, distinctly from a page that exists and is blank |
| a member fails to render | the page has no result, and the export produces no bytes |
| the geometry does not match | refused by name, with what differs |
| the budget is exceeded | refused, or the achievable resolution offered — never silently reduced |

The render-failure case is the one the measurement changed. Continuing with the
survivors does not degrade to a partial answer: with one layer left, nothing
matches, so **the whole drawing is painted as changed**. The current behaviour
produces the most alarming possible wrong answer, silently.

## Resolution

The requested DPI is a contract. Today it is not:

| | asked | delivered |
| --- | --- | --- |
| A1 | 600 dpi | **321 dpi** |
| A0 | 300 dpi | **227 dpi** |
| A0 | 600 dpi | **227 dpi** |

...and the file is named `comparison_<name>_600dpi.pdf` either way. The filename
asserts what the cap removed, and an A0 at 300 and at 600 are the same file.

Proposed: compute the cost before rendering, and if it does not fit, either
refuse or tell the user what will fit and let them accept it. Never deliver a
different resolution under the requested name.

## The threshold, and the policy it needs

A pixel radius means a different physical distance at every resolution:

| dpi | `threshold = 2` |
| --- | --- |
| 150 | 0.339 mm |
| 600 | 0.085 mm |

The user's contract should be **millimetres**, converted to a pixel radius from
the actual render scale. 0.5 mm becomes 1 / 3 / 6 / 12 px at 72 / 150 / 300 /
600 dpi.

A unit is not the whole of the decision, though, and treating it as one would
put back what removing the ratio floor took out. **The spatial tolerance can
suppress a true semantic change.** Measured, changed pixels for a dimension
string reading 1200 against one reading 1300:

| | 0 | 0.05 | 0.1 | 0.15 | 0.2 | 0.25 | 0.3 | 0.4 | 0.5 mm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 150 dpi | 51 | 51 | 14 | 14 | 14 | 14 | **0** | **0** | **0** |
| 300 dpi | 186 | 96 | 96 | 49 | 49 | 18 | 1 | **0** | **0** |

At 0.3 mm the two dimensions agree. That is not a rendering detail with a unit
attached; it is a setting that turns a revised drawing into an unrevised one, so
**H6** is a policy rather than a choice of unit:

| | proposed | why |
| --- | --- | --- |
| unit | mm | the drawing office's unit; a pixel radius means a different distance at every DPI |
| **default** | **0 mm** | a comparison nobody configured must report every difference it can see |
| minimum | 0 mm | and zero is always available, at every resolution |
| **maximum** | **0.25 mm** | the largest setting at which the smallest measured true change is still reported, at 150 **and** 300 dpi. One step past it the changed digit is already invisible at 150 dpi |
| step | 0.05 mm | fine enough to be useful; see the caveat below |
| opt-in | explicit | a non-zero tolerance is something the user chose, not something the tool assumed |
| disclosure | required | see below |

**The wording matters and is part of the contract.** "Ignores small shifts" is
not what this does — measured, it also makes a changed digit and a swapped
symbol match. The disclosure has to say that a non-zero tolerance may report a
changed dimension or symbol as unchanged.

**A caveat the policy has to carry:** millimetres are converted to a *whole*
pixel radius, so the same setting is not exactly the same distance at every
resolution. 0.05 mm rounds to 0 px at 150 dpi and 1 px at 300 dpi, which is why
the digit survives 0.05 mm at 150 dpi untouched and loses half its differing
pixels at 300 dpi. Below about 0.1 mm the setting is finer than the render, and
the policy should say so rather than imply a precision it does not have.

The implementation gate carries one assertion from this: **at the default
settings, a dimension changed from 1200 to 1300 reports CHANGE.**

## The cost of comparing

The composite loops the neighbourhood for every ink pixel, so the work is
roughly `ink x (2r+1)² x members`. Two things make that sharper than the earlier
numbers suggested.

`hasNeighborInAny` returns as soon as it finds ink, so **a matching drawing gets
a discount that a non-matching one does not**. Per ink pixel at radius 3:

| | |
| --- | --- |
| the drawings match | **0.59 µs** |
| the drawings do not | **1.56 µs** |

**2.6×**, and the non-matching case is the one the tool exists for. Every earlier
cost figure was taken on matching drawings and is a floor.

And a physical threshold grows the radius with the resolution, so the worst case
grows with it: the same non-matching pair costs 43 ms at 150 dpi with radius 3
and 207 ms at 300 dpi with radius 6.

Two things follow, and both are needed.

### A stated work bound

Evaluated before rendering, alongside the memory budget, and separate from it.
An A4 at 300 dpi is 234 MB of working set — comfortable — and, at a
half-millimetre tolerance, three billion neighbourhood reads. Passing one
ceiling says nothing about the other.

`pixels x radius² x members` was proposed for this and **is not an upper bound
on anything**. At radius 0 it is zero, and a radius-0 comparison still reads
every pixel of every member. It also leaves the multi-member contract out, so
four members under reference-pairs cost the same as two.

A work unit is **one pixel read**. Per compared group:

```
    pixels x sourceMembers                                     every pixel, once
  + pixels x sourceMembers x comparedOtherMembers x (2r+1)²      the neighbourhood
```

and the groups come from the contract, not from the member count: two-only is
one group, reference-pairs over four members is three, and consensus has no
derived bound at all because no implementation of it has been measured. If H9
selects a different contract, the bound is derived for that contract before it
ships.

The second term is conservative by design. The shipped loop runs the
neighbourhood only on ink and exits on the first ink it finds, so a sparse
drawing costs a fraction of this — 0.9% of the measured A4 is ink. But the ink
fraction is not knowable before rendering, and a scanned dark sheet can be ink
nearly everywhere. A bound that holds only for sparse drawings is not a bound.

The ceiling: **`MAX_COMPARISON_WORK_UNITS = 12,000,000,000` — a recommendation
requiring human approval, not a measured threshold.** It is user-visible,
because it refuses comparisons. Where it comes from: the highest measured cost
per work unit on the corpus is the A4 300 dpi radius-0 pair, 158 ms for
34,789,440 units — 4.5 × 10⁻⁶ ms per unit, and the case where the bound is
*tightest*, so it is the pessimistic calibration. Twelve billion units at that
rate projects to about **55 seconds** on the measured machine.

| at a 0.5 mm tolerance, two members | work units | |
| --- | --- | --- |
| A4 at 300 dpi | 2,957,102,400 | within |
| A3 at 300 dpi | 5,917,083,920 | within |
| A4 at 300 dpi, four members, reference-pairs | 8,871,307,200 | within |
| A1 at 300 dpi | 23,694,575,520 | **refused** |
| A0 at 600 dpi | 698,586,380,184 | **refused** |

Over the ceiling is a **typed refusal** — `OVER_WORK_BUDGET`, naming the numbers
— never a quieter comparison. Reducing the DPI or the tolerance to fit would be
the silent-downgrade failure the export path already has, where an A0 asked for
at 600 dpi delivers 227 and is still named `_600dpi.pdf`. Every estimate records
the requested and the effective settings together so that a downgrade could not
happen unremarked. Arithmetic that would leave the safe-integer range is a
refusal too, rather than a number that has quietly lost its low bits.

Fifty-five seconds is a long time to wait, which is why this is a ceiling on
*refusal* rather than a target: a job under it must be interruptible, and one
over it is refused before a canvas is allocated. The number is a judgement about
how much of a person's afternoon one comparison may claim, and the machine it
was calibrated on is one machine. Human Gate **H10**.

### A comparison that can be abandoned

The composite as written is a synchronous double loop with no yield point and no
way to observe a cancellation flag, so **cancellation alone does not solve
this** — a long comparison cannot currently be stopped, only waited out. This is
an architecture decision to make **before** implementation, not something to
discover in it.

**Recommended: a separable dilation, run in bands.** Both halves were
prototyped and measured.

*Separable dilation.* "Matched if the other member has ink within `radius`" over
a square box is a dilation, and a dilation over a square is separable: any-in-
the-box is any-in-the-row-span followed by any-in-the-column-span. Two passes
over the pixels regardless of how wide the box is. Measured to produce the
**identical** change mask as the nested loop at every radius tried, so it is not
an approximation. And it changes the bound rather than only the runtime: the
same A1 at 0.5 mm is 23,694,575,520 units scanning and 557,519,424 units
dilating — refused under one algorithm and comfortably within the ceiling under
the other.

It is not free, and the measurement says so plainly: on a sparse drawing the
nested scan is *faster*, because it exits on the first ink it finds — 4 ms
against 23 ms on the 0.9%-ink A4. The dilation's cost is O(pixels) whatever the
drawing does. What it buys is that its cost is a property of the *sheet* rather
than of the *drawing*, which is what a ceiling checked before rendering needs.
On the case a bound has to cover — ink everywhere, matching nothing — the scan
grows 25 ms → 65 ms as the box goes from 9 to 49 while the dilation stays at
28 ms.

*Bands.* Every phase runs over a band of rows or columns and returns control
between bands. The banded result is identical to the direct one, and a cancelled
comparison returns `CANCELLED` and nothing else — half a change mask is not a
smaller change; it is a different drawing.

Bands alone are only half of it, and the half that is easy to mistake for the
whole. A decision point between bands is worth nothing if nothing can reach it:
a driver that never returns to the event loop leaves every click, settings
change and `postMessage` sitting in a queue until it has finished. A Web Worker
does not fix that by itself — one long synchronous message handler cannot
process the next message either.

**The production scheduling contract:**

```
    process one bounded band
      -> yield to a task boundary          queued work is delivered here
      -> read cancellation / generation    updated by that queued work
      -> verify ownership
      -> continue, or stop with no result
```

Measured, with the *same* cancellation scheduled from a timer against both
drivers on the same comparison:

| | | |
| --- | --- | --- |
| uncancelled, banded, asynchronous | `READY_TO_COMPARE` in 18 bands | the same mask as the direct computation |
| **synchronous driver** | ran to completion in 23 ms | the timer never fired; **the cancellation was never seen and a verdict was published** |
| **asynchronous driver** | `CANCELLED` at band 4 of 18 | the same cancellation, observed at a band boundary |
| superseded by a newer generation | `CANCELLED` | `publishable: false`, no result |

The yield is `setTimeout(…, 0)` rather than a microtask, deliberately: a
microtask drains before the task queue is touched, so awaiting one proves
nothing. Timers are one task source served in order, so a cancellation scheduled
before the yield is guaranteed to have run by the time it resolves.

Ownership is re-read between bands **and** immediately before publishing, since
a run can be superseded by the last thing that happened while its final band was
running.

Whatever is chosen, the ownership rule from M3 still applies on top: a run that
has been superseded publishes nothing.

## The budget

The Annotator's 8 Mpx ceiling does not transfer. That bounds one transparent
fragment; a comparison holds several full-page buffers at once.

Proposed: bound the **peak working set**, at **512 MiB** — a **recommendation
requiring human approval**, not a measured threshold — computed before anything
is allocated.

### The shipped pipeline holds every layer's RGBA at once

```
layers x width x height x 4        the rendered canvases
+ layers x width x height x 4      the normalised copies the composite holds
+ width x height x 4               the normalising canvas
+ width x height x 4               the composite
+ width x height x 4               the encoder
```

That is the right model for the **baseline**, and it is what the baseline
measurements in `measurements.md` §10 are taken against: A3 at 300 dpi with two
layers is 487 MB, A1 at 300 dpi is 1951 MB, A0 at 600 dpi is 15.6 GB.

### The proposed pipeline does not

Keeping that model while adopting the mask architecture would have left the
budget claim resting on buffers the design no longer allocates — and omitting
the masks, the dilation scratch and the change mask, which it does. So the model
is rebuilt around the phases, and the ceiling is checked against the **peak**:

```
peakWorkingSet = max over phases of (buffers live during that phase)
```

| phase | live |
| --- | --- |
| 1 render | one member's canvas (4/px), the pixels read back from it (4/px), the masks of the members already done (1/px each) |
| 2 mask extraction | that readback (4/px), every member's mask (1/px each) |
| 3 dilation | the masks, the reference's dilation, the other member's dilation, one scratch band, two running-sum indices |
| 4 comparison | the masks, two dilations, the semantic change mask |
| 5 presentation | the masks, every member's dilation, the composite (4/px), the encoder's bitmap (4/px), the data URL |

Two parts of that are a **contract**, not an implementation detail, because a
different choice gives a different peak:

- members are rendered **serially**, so only one member's canvas and readback
  are ever live;
- under `reference-pairs` the pairs are processed **serially**, and the
  reference's mask and dilation are computed once and reused across every pair.

The load-bearing fact is phase 5. `compositeFromMasks` is asserted **byte-for-
byte identical** to the shipped compositor — over 34.8 MB of output across two
and four members, with and without a neighbourhood radius, and with a partly
transparent match colour — because the shipped compositor starts each pixel
white and multiplies in a *flat* colour wherever the ink predicate is true. It
never reads the source pixel's intensity. So no member's RGBA survives phase 2,
and four bytes per pixel per member stop being co-resident with anything.

Measured, at a 0.5 mm tolerance with two members:

| | peak | at | |
| --- | --- | --- | --- |
| A4 at 300 dpi | 106 MB | presentation | within |
| A3 at 300 dpi | **211 MB** | presentation | within |
| A2 at 300 dpi | 423 MB | presentation | within |
| A1 at 300 dpi | 847 MB | presentation | **refused** |
| A1 at 300 dpi, four members | 1125 MB | presentation | **refused** |
| A0 at 600 dpi | 6779 MB | presentation | **refused** |

The A3 case is the one that had to be re-derived rather than carried over: under
the shipped model it was 487 MB, just inside the ceiling, and simply adding the
four mask buffers to that number would have pushed it to about 557 MB and out.
Under the model that matches the selected architecture it is 211 MB, because the
two layer canvases and two normalised copies it used to hold are gone. The
previous round's "within 512 MiB" claim was not wrong about A3; it was resting
on the wrong pipeline.

A tolerance of zero allocates no dilation buffers at all: 10.15 bytes per pixel
against 12.15 at 0.5 mm.

### The export

`toDataURL` returns a string, so what is held is base64 text. Measured on real
composites: 0.025–0.050 bytes per pixel across JPEG and PNG, at two sheet sizes
and on both a sparse and a dense drawing. The model allows **0.15** — about
three times the worst measurement — and the gate asserts that no measurement
exceeds the allowance, so the assumption checks itself.

Which format ships is **H5**. The planner budgets the more expensive of the two
until that is answered, so no budget claim depends on the open decision.

The 512 MiB itself is a judgement about how much one comparison may claim, not a
threshold found in the data, and it is recorded as one: **H7**.

## Ink

Two functions in `pdfDiff.ts` decide what ink is, and they use different tests:
`computeMultiPdfComposite` takes the mean of the channels, `detectChangeBounds`
takes any channel. A pale yellow (255,255,140) is painted as a change by the
first and left out of the reported change area by the second.

That is an inconsistency to resolve, not an algorithm to replace, and **which
test is right is a semantic choice for the Human Gate (H8)** rather than
something this spike settles.

Whichever is chosen, one definition must serve all four consumers: the visual
composite, the change detection and its bounds, the MATCH/CHANGE verdict, and the
change report. Two definitions is how a colour ends up painted as a change and
left out of the reported change area at the same time.

A pale grey hatch (210,210,210) is invisible to both. That may be consciously
accepted, but it should be accepted rather than inherited.

## Ownership and cancellation

A comparison is asynchronous, and the user can change the documents, the
visibility, the threshold or the DPI while one runs, or leave the tool entirely.

The M3 annotator settled this with a mount flag plus a generation counter,
captured at the start and re-checked immediately before anything is published.
The same shape applies here, with more things that can invalidate a run.

What is measured, and what is not:

| | |
| --- | --- |
| band/chunk structure | **measured** — 18 bands over a 1241×1754 comparison, same mask as the direct form |
| the attachment point for a cancellation | **measured** — a decision point between every pair of bands |
| **asynchronous scheduling** | **measured** — a cancellation scheduled from a separate task is observed at band 4 of 18, while the same cancellation against a synchronous driver is never seen at all |
| generation/ownership, in the prototype | **measured** — a run superseded mid-flight returns `publishable: false` and no result |
| generation/ownership, against the real UI | **not measured** — no unmount, no document swap, no settings change was exercised |
| inside a Worker, over `postMessage` | **not measured** — the prototype yields on the main thread |

So: the *scheduling contract* is established and the *integration* is not. The
production implementation gate must exercise real supersession — a document
changed, a layer toggled, the threshold moved, the tab left — against a
comparison that is actually running. Without bands there is nowhere for any of
that to attach, which is why the algorithm choice above is a prerequisite for
cancellation rather than an optimisation of it.

## What this does not promise

The comparator is not fixed, and nothing here has been implemented. Large-format
comparison is not supported by this document — it is *bounded* by it, which is a
different claim. Automatic alignment is not shown to be reliable; it is deferred
untested.

The human decisions this cannot settle are listed in `README.md`.
