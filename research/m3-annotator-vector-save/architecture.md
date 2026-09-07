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
of every candidate measured — 0.24% of pixels differing, against 0.63% for the
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
whole objects. Each leaves an object array that any candidate can write out.

The fourth — the pixel eraser — is not a deletion at all. It **adds** an object
with `isEraser: true`, and the renderer replays it with
`globalCompositeOperation = 'destination-out'` (`DrawingCanvas.tsx:223-229`), so
it subtracts from whatever was drawn before it in the array.

**A content stream cannot un-draw.** There is no operator for "remove the ink I
already put down". A vector save can compute the geometric difference between
every affected stroke and the eraser path, refuse, or fall back to pixels for
the region involved. It cannot express it directly, and the measured Level B
candidate refuses all six fixtures for exactly this.

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

## Proposed pipeline

```
   the source PDF bytes, as loaded
             |
   pdf-lib loads the document -- pages, text, vectors, images,
   annotations, form, metadata all stay as they are
             |
   for each page that has annotations:
             |
       split the objects by cause
             |
       +-------------------+---------------------------+
       | expressible       | a pixel eraser, and the   |
       | as operators      | ink it subtracts from     |
       |                   |                           |
   drawing operators    one transparent PNG covering
   on the page's         only their shared bounding box
   content stream        placed at the same spot
       |                           |
       +-------------------+-------+
                           |
              pdf-lib serialises the document
```

Nothing rewrites a page that has no annotations, and nothing rasterises a page
at all.

### Coordinates

One space, and the app already stores in it. Pointer events are divided by the
zoom on the way in (`DrawingCanvas.tsx:129-138`), so a stored coordinate is in
PDF points with the origin top-left and y downwards — the space a pdf.js
viewport at scale 1 uses. Measured across 0.5×, 1×, 2× and 6×: identical stored
coordinates, identical written coordinates, identical line widths.

Save maps that to PDF user space in two steps, both of which have to be there:

```
y flips           a content stream counts upwards from the bottom
origin moves      to the page box's own origin, not to (0,0)
```

The second step is the one that gets forgotten. `pdf-lib`'s `page.getSize()`
reports the **MediaBox** even when the CropBox is smaller, so a save path that
maps with it misplaces every mark on a cropped page — measured at (−40, +40) and
(−60, +30) on the corpus, one of which lands in the margin the crop hides.

`/Rotate` needs no transform on the way out: it is a viewer instruction, and a
content stream is written unrotated. It only has to be undone on the way *in*,
mapping what the user sees to where it lives. All four quadrants round-trip and
give four distinct answers.

### Fonts

The app's `fontFamily` is a CSS family name. It cannot be resolved to a file, so
it cannot be embedded, so **a vector text annotation is not in the font the user
picked**. The measured candidate embeds the OFL font already shipped in this
repository, which covers Japanese and ASCII, and reports the substitution.

The cost is visible: 8–12% of pixels differ on the text objects, against 0.3–0.9%
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
- a transparent raster fragment *only* for a pixel eraser and the ink it
  subtracts from, bounded to their shared box;
- measurement labels derived and written as text, because the app does not store
  them;
- fail closed on anything unsupported, naming it.

It preserves everything the overlay preserves, adds searchable annotation text
including Japanese, and on an A0 sheet costs 0.11 Mpx against the overlay's
32.14 — because it rasterises the marks rather than the paper.

**Keep Level A as the fallback path inside it.** The hybrid *is* Level A applied
to a smaller region; if a page turns out to need everything rastered, the result
is the overlay and the source is still preserved. That is a graceful degradation
rather than a second implementation.

**REVISE before implementing**: the font. Substitution is unavoidable and the
measured visual cost is real, so the implementation needs a decision on what the
user is told and whether they get a choice between "searchable text in a
substitute face" and "an exact picture of what I drew". That is a product
question this spike can inform but should not settle.

**DEFER**: Level B alone (it cannot express the app's pixel eraser); geometric
difference for the eraser (unmeasured, and complex enough to deserve its own
spike); annotations as native PDF annotation objects rather than page content;
and any editing of existing source geometry, which is a different problem
entirely and not what M3 is for.

## What this does not promise

M3 preserves a source document while adding annotations to it. It does not edit
the source document's existing content, and adopting this does not put the app
any closer to doing so.
