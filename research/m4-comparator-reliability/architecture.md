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

The proposal is that a comparison returns a result with a status:

```
MATCH               nothing found within the stated tolerance
CHANGE              differences found, and here they are
MISSING_PAGE        a member does not have this page
GEOMETRY_MISMATCH   the pages do not describe the same sheet
ALIGNMENT_REQUIRED  they could be compared with an alignment the tool will not invent
RENDER_FAILED       a member could not be read
UNSUPPORTED         the source cannot be honoured at all
CANCELLED           superseded or abandoned
```

Each carries what the user needs to act: which member, what differs, what would
resolve it. The image, when there is one, is one field of that result.

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

## Geometry

### Rotation is not a difference

`/Rotate` is an instruction to the viewer, not a property of the drawing.
Rendering with `getViewport({ rotation: 0 })` makes all four rotations of the
same page produce identical canvases: **0.0% of ink differing**, both canvases
1241×1754, on all three of 90/180/270.

This is the single largest source of false change in the baseline and it is one
argument that is not currently passed. It needs no policy.

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

Three points of tolerance — one millimetre — is the proposed limit for calling
two sheets the same. Measured: a 3pt difference produces **75.9%** false change,
so this is not a rounding artefact to absorb.

**Same aspect ratio is not the same sheet.** A4 proportions at 1.4× scored 99.4%
false change, and would pass any check based on proportions alone.

## Alignment

When geometry genuinely differs, the tool says so and offers a human alignment:
an offset, optionally a rotation and a scale. The result carries the alignment it
was made under, so a comparison is never separable from the assumption behind it.

The tool proposes nothing. An offer of "we think it is 12.4 pt across" becomes
the answer the moment it is displayed, and this is the tool that is supposed to
stop that happening.

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

## The threshold

A pixel radius means a different physical distance at every resolution:

| dpi | `threshold = 2` |
| --- | --- |
| 150 | 0.339 mm |
| 600 | 0.085 mm |

The user's contract should be **millimetres**, converted to a pixel radius from
the actual render scale. 0.5 mm becomes 1 / 3 / 6 / 12 px at 72 / 150 / 300 /
600 dpi, and the comparison means the same thing at all of them.

## The budget

The Annotator's 8 Mpx ceiling does not transfer. That bounds one transparent
fragment; a comparison holds **every layer's RGBA at once**, plus a normalising
canvas, plus the composite, plus the encoder — about five canvases for two
layers.

Proposed: bound the **working set**, at **512 MB**, computed before anything is
allocated:

```
layers x width x height x 4        the rendered canvases
+ layers x width x height x 4      the normalised copies the composite holds
+ width x height x 4               the normalising canvas
+ width x height x 4               the composite
+ width x height x 4               the encoder
```

Measured against it: A3 at 300 dpi with two layers fits at 487 MB; A1 at 300 dpi
does not, at 1951 MB; A0 at 600 dpi needs 15.6 GB. The number is a judgement
about how much one comparison may claim, not a threshold found in the data, and
it is recorded as one.

## Ink

Two functions in `pdfDiff.ts` decide what ink is, and they use different tests:
`computeMultiPdfComposite` takes the mean of the channels, `detectChangeBounds`
takes any channel. A pale yellow (255,255,140) is painted as a change by the
first and left out of the reported change area by the second.

That is an inconsistency to resolve, not an algorithm to replace. Whichever test
is chosen, both should use it. A pale grey hatch (210,210,210) is invisible to
both, which is a stated limit of the current detector rather than something this
spike proposes to change.

## Ownership and cancellation

A comparison is asynchronous, and the user can change the documents, the
visibility, the threshold or the DPI while one runs, or leave the tool entirely.

The M3 annotator settled this with a mount flag plus a generation counter,
captured at the start and re-checked immediately before anything is published.
The same shape applies here, with more things that can invalidate a run. It is
**proposed** for reuse, not measured: no cancellation behaviour was exercised in
this spike.

## What this does not promise

The comparator is not fixed, and nothing here has been implemented. Large-format
comparison is not supported by this document — it is *bounded* by it, which is a
different claim. Automatic alignment is not shown to be reliable; it is deferred
untested.

The human decisions this cannot settle are listed in `README.md`.
