# M3 — annotator save, proposed architecture

Research only. Nothing here is implemented in the app, and nothing should be
until this is adopted. The prototypes under `prototype/` exist to make the
measurements in `measurements.md` possible; they are not a draft of the
production code, and they do not import the app.

## What is wrong now

The Annotator saves by photographing the screen:

```
DOM page → html2canvas → JPEG → jsPDF → a brand-new PDF
```

`src/components/PdfViewer.tsx:196-243`. The source document is never opened by
the writer. Measured on the corpus, the output of a save loses the source text,
the source vector geometry, existing annotations, form fields and their values,
document metadata, the invisible text layer of a searchable scan, and the page's
rotation and boxes. Saving a document *without adding anything* destroys it just
as thoroughly.

And it looks perfect. The baseline has the **best** whole-page visual fidelity
of every candidate measured — 0.20% of pixels differing, against 0.63% for the
best preserving one. A faithful photograph of a document that no longer exists.

That is the shape of the problem: nothing in the user interface can show it, and
nothing about the file's appearance reveals it. It is only visible by asking the
file what it still contains.

## What "vector-preserving" means here

Two questions, kept apart, because conflating them is how this gets designed
badly.

**The source must be preserved.** Its text stays extractable, its vector
geometry stays vector, its images stay its images, its annotations, form,
metadata, page boxes and rotation stay as they were. This is not negotiable and
it is what "vector-preserving" means in M3.

**The annotations may be pixels or operators.** That is a trade with real terms
on both sides, and the corpus was built to price it rather than assume it. Three
levels were compared:

- **Level A** — source preserved, annotations as a raster overlay.
- **Level B** — source preserved, annotations as drawing operators.
- **Level C** — source preserved, operators where they work, a local raster only
  where they cannot.

Level B turns out not to be reachable on its own, for a reason that is about the
app rather than about PDF. So the choice is between A and C.

## The pixel eraser is the whole difficulty

The app has four erasers and only one of them is a problem.

Three are object operations: the stroke eraser deletes whole objects, the
rectangle eraser splits strokes at their vertices, the lasso eraser deletes
whole objects. Each leaves an object array that any candidate can write.

The fourth -- the pixel eraser -- is not a deletion at all. It **adds** an
object with `isEraser: true`, and the renderer replays it with
`globalCompositeOperation = 'destination-out'` (`DrawingCanvas.tsx:223-229`), so
it subtracts from whatever was drawn before it in the array.

**A content stream cannot un-draw.** There is no operator for "remove the ink I
already put down". A vector save can compute the geometric difference between
every affected stroke and the eraser path, refuse, or fall back to pixels for
the region involved. It cannot express it directly, and the measured Level B
candidate refuses all seven fixtures for exactly this.

### Composition has to keep painter order

The obvious way to build the hybrid is two buckets -- operators here, pixels
there, write one then the other. That does not preserve stacking, and the first
revision of this design got it wrong. Given `stroke A, eraser, stroke B`, B is
on top on screen; bucketed, B is written as an operator and the fragment holding
A and the eraser is drawn afterwards, over it.

So a layer is planned as an **ordered sequence of runs**. The span from the
earliest object an eraser reaches back to, through to the last eraser, becomes
one raster fragment; whatever precedes and follows stays operators; the runs are
emitted in order. Because pdf-lib appends to the content stream in call order,
emitting runs in order preserves stacking by construction.

Everything inside the span is rasterised, **including objects no eraser
touches**. That is deliberate. Deciding which of them could be lifted out means
reasoning about overlaps between every pair, and being wrong there reorders the
user's marks. Over-including costs pixels; under-including changes the drawing.

The same asymmetry governs the bounds that decide what an eraser touches: they
must cover everything an object actually paints -- a pressure stroke's widest
segment, a glyph's real extent, a measurement's vertex dots, its labels' backing
rectangles, and a polyline's total label, which sits past its last point
entirely. Under-reporting there is what lets an eraser and its ink end up in
different layers.

With erasers scattered through a layer the span grows until it is the whole
layer, which is the documented fallback: the annotation layer becomes one
transparent image. **The source page is still never rasterised.**

### The safety boundary

The pixel eraser clears annotation ink and reveals the page underneath it. The
annotation canvas is a separate element stacked over the PDF canvas
(`PdfPage.tsx:133-162`), so the source is never touched — not by any eraser, not
at any point.

**That must stay true.** No design here removes content from a source page's
content stream because a user reached for an eraser. If a future feature needs
to hide something on the page, it is a visual mask and must be named one:
masking is not redaction, the same distinction the title-block updater already
draws.

## Which documents this will not write

Preserving the source is the non-negotiable half of M3, and some files cannot be
honoured. Every candidate re-serialises the document, which **invalidates any
signature over it**. Writing that file and reporting success would be the worst
kind of preservation failure: the document still looks signed and is not.

So the boundary is checked before anything is written, and refuses by name:

| | |
| --- | --- |
| a signature field | refused -- saving would invalidate it |
| encrypted / password-protected | refused |
| damaged beyond reading | refused, after walking every page rather than trusting that a successful `load` means a usable file |

`measurements.md` section 9 has the results. The encrypted path is code that
exists and has **not** been exercised: nothing in the dependency set can write
an encrypted PDF to test it against, and that is recorded rather than glossed.

Outlines and bookmarks are **unmeasured**, and nothing here claims they survive.

## Proposed pipeline

```
   the source PDF bytes, as loaded
             |
   pdf-lib loads the document -- pages, text, vectors, images,
   annotations, form, metadata all stay as they are
             |
   for each page that has annotations:
             |
       plan the layer as an ordered sequence of runs
             |
       +--------------------+---------------------------+
       | a run of objects   | the span an eraser reaches |
       | written as         | into: one transparent      |
       | operators          | raster fragment            |
       +--------------------+---------------------------+
             |
       emitted in painter order, so stacking survives by
       construction -- pdf-lib appends in call order
             |
       pdf-lib serialises the document
```

Nothing rewrites a page that has no annotations, and nothing rasterises a page
at all.

### Coordinates

**Stored coordinates are in display space, not upright space.** This document
said the opposite in its first revision, and the error is the kind that hides:
it is invisible on every unrotated page.

The chain is short. `PdfPage.tsx:74` sizes the canvas from
`pageProxy.getViewport({ scale })` with no `rotation` argument, so the viewport
carries the page's own `/Rotate`. `DrawingCanvas.tsx:129-138` then converts a
pointer event with `(clientX - rect.left) / scale` and nothing else. Dividing by
the zoom removes the zoom; nothing removes the rotation.

So a stored coordinate is **zoom-independent** -- confirmed at 0.5x, 1x, 2x and
6x -- and **expressed in the rotated frame the user was looking at**.

A save path therefore has three steps, and the middle one is not optional:

```
stored (display space, y down, /Rotate applied)
   -> displayToUpright(/Rotate)      undo the rotation
   -> upright page space
   -> uprightToPdf(CropBox)          flip y, add the crop origin
   -> PDF user space
```

The second step is the one that gets forgotten, because a fixture at
`/Rotate 0` cannot tell you it is missing. The third is the one done with the
wrong box: `pdf-lib`'s `page.getSize()` reports the **MediaBox** even when the
CropBox is smaller, so mapping with it misplaces every mark on a cropped page --
measured at (-40, +40) and (-60, +30) points.

`/Rotate` needs no transform on the way *out*: it is a viewer instruction, and a
content stream is written unrotated.

**This must be proved end to end, not by arithmetic.** A round-trip test shows
that a function inverts itself; it cannot show that the save path calls it, or
calls it the right way round. Placing a mark, saving, reopening and looking for
it found a real bug in the overlay's image placement that the arithmetic test
passed straight over -- 863 points out at `/Rotate 90`, and off the page
entirely at 270. See `measurements.md` section 5.

### Fonts

The app's `fontFamily` is a CSS family name. It cannot be resolved to a file, so
it cannot be embedded, so **a vector text annotation is not in the font the user
picked**. The measured candidate embeds the OFL font already shipped in this
repository, which covers Japanese and ASCII, and reports the substitution.

The cost is visible: 9–16% of pixels differ on the text objects, against 0.3–0.9%
for the raster overlay. That is the price of searchable text and it should be
stated to the user, not absorbed. What must never be claimed is that a chosen
family was preserved.

### Failing

Fail closed, and fail whole. A save that cannot express something stops with the
object named and the reason given; it does not drop the mark and return a file
that looks complete. Measured: a pixel eraser under Level B refuses with the
object id and an explanation, and a `NaN` coordinate is refused by pdf-lib's own
type check rather than written as a broken operator.

The conditions that must fail closed: an unsupported annotation type, a
coordinate that is not a finite number, a page index with no matching source
page, a font that cannot be embedded, a raster fragment larger than a stated
bound, and a source document that failed to load.

### Lifecycle

Not implemented in the prototype — a research script has no UI to leak from —
but the production implementation inherits the pattern the Excel and register
exporters already use, and this is where it would apply:

- a generation per kind of async job (page render, save), with stale results
  discarded rather than published;
- busy ownership by name, so a superseded save cannot clear a newer one's flag;
- the output Blob URL owned by a ref and revoked directly on unmount, because
  React does not run state updaters for a component that is going away;
- cancellation checked between pages, since a save is a per-page loop;
- `page.cleanup()` after each page, and no `PDFDocumentProxy.destroy()` on a
  document the component does not own.

## Recommendation

**ADOPT Level C — the hybrid** for the M3 MVP:

- the source PDF loaded and preserved, never rasterised;
- annotations written as drawing operators, in one coordinate space, with the
  CropBox origin honoured;
- the layer planned as an ordered sequence of runs, so stacking survives, with
  a transparent raster fragment for the span an eraser reaches into and
  conservative painted bounds deciding what that span is;
- a support boundary that refuses signed, encrypted and unreadable documents by
  name, before anything is written;
- measurement labels derived and written as text, because the app does not store
  them;
- fail closed on anything unsupported, naming it.

It preserves everything the overlay preserves, adds searchable annotation text
including Japanese, and on an A0 sheet costs 0.19 Mpx against the overlay's
32.14 — because it rasterises the marks rather than the paper.

**Keep Level A as the fallback path inside it.** The hybrid *is* Level A applied
to a smaller region; if a page turns out to need everything rastered, the result
is the overlay and the source is still preserved. That is a graceful degradation
rather than a second implementation.

**REVISE before implementing**: the font. Substitution is unavoidable, and the
measured cost is **glyph shape, not misplacement** -- searching for the vertical
offset that would minimise the difference improves it by a tenth of a percent,
and for one string not at all, so the placement arithmetic is right and the
faces simply differ. What the user is told, and whether they are offered a
choice between "searchable text in a substitute face" and "an exact picture of
what I drew", is a product question this spike can inform but should not settle.

**DEFER**: Level B alone (it cannot express the app's pixel eraser); geometric
difference for the eraser (unmeasured, and complex enough to deserve its own
spike); annotations as native PDF annotation objects rather than page content;
and any editing of existing source geometry, which is a different problem
entirely and not what M3 is for.

## What this does not promise

M3 preserves a source document while adding annotations to it. It does not edit
the source document's existing content, and adopting this does not put the app
any closer to doing so.
