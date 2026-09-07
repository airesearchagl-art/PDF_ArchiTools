# M3 limitations

What this spike does not establish. Read this before quoting any number from
`measurements.md` in a decision.

## The corpus is synthetic, and tiny

Six documents, fourteen pages, all generated. No customer file was used. That
was the brief and it is right for a spike, but it bounds everything:

- **No real scan.** The "scanned" pages are rasterised vector text — no skew, no
  speckle, no fold, no scanner gamma.
- **No document longer than four pages**, and nothing near the size of a real
  issue. Every runtime figure is for a handful of pages.
- **No outline or bookmark tree.** `pdf-lib` has no high-level API for one, and
  building it by hand would have measured the fixture rather than the save path.
  **Outline preservation is unmeasured** for every candidate.
- **No encrypted, damaged, linearised, tagged or signed PDF.** A signature in
  particular would be invalidated by any of these candidates, and none was
  tested.
- **Two annotation subtypes and two form field types.** Widgets, appearance
  streams and field flags beyond `getText`/`isChecked` were not compared.

## The annotation set is one set

Ten objects, one of each kind the app can make, placed so that nothing overlaps.
Real annotation is dense and overlapping, and the pixel eraser's behaviour
depends on ordering in ways one non-overlapping set cannot exercise.

In particular the hybrid's split rule — an eraser takes with it the ink it
overlaps — was measured on **one eraser touching two strokes**. A page with many
erasers scattered across many strokes could pull most of the layer into the
raster fragment, at which point the hybrid degrades toward the overlay. Where
that boundary sits is **unmeasured**.

## Visual fidelity is measured against our own renderer

The reference image is the prototype's copy of `DrawingCanvas`'s draw loop, not
the app itself. It was written to match field for field, including the parts
that are accidents of the current implementation, but it is a copy. A difference
between the app and this copy would show up as fidelity that is better than
reality, in every column equally.

The comparison is also headless Chromium's rasteriser against pdf.js's. Both are
approximations of what a user's viewer will do.

## The font finding is about one font

The substitute is the OFL font already shipped for OCR. A different embedded
font would give a different pixel difference. The 8–12% figure is the cost of
*that* substitution on *these* strings; it is not a general measure of how
different vector text looks.

Emoji and characters outside the font's coverage were **not** tested. The
corpus's "unsupported glyph" case is `<`, `&` and a mix of scripts, which the
font does cover.

## Erasers were read, not exercised end to end

The eraser semantics in `measurements.md` §5 come from reading
`DrawingCanvas.tsx` and from a sample object carrying `isEraser: true`. The
research harness does not drive the actual UI, so:

- the **stroke**, **rectangle** and **lasso** erasers were not run;
- the rectangle eraser's vertex-granular split — which leaves a long segment
  crossing the rectangle untouched if both its endpoints are outside — is a
  reading of the code, not an observation;
- the stylus eraser-tip remap was not exercised at all.

Each produces an ordinary object array, so none should trouble a save path. That
is a reasoned expectation and not a measurement.

## Layers

The app has no layer concept in its object model. A layer is a separate
`DrawingCanvas` with its own object array (`PdfPage.tsx:142-162`), visibility is
`display: none` on a wrapper, and no object carries a layer id.

This spike measured a **single layer's** objects. Consequences a production
implementation has to settle, none of them measured here:

- what a save should do with a hidden layer (the current save omits it, because
  html2canvas does not capture `display: none`);
- what order layers should be written in — they all share `zIndex: 10`, so
  stacking is DOM order;
- whether a pixel eraser on one layer should affect another. It currently cannot,
  because each layer is its own canvas.

## Lifecycle is described, not built

`architecture.md` sets out generation ownership, cancellation, Blob URL
ownership and cleanup. **None of it is implemented or tested here** — a research
script has no UI to leak from. The patterns are inherited from the Excel and
register exporters, where they were measured; that they transfer is an
expectation.

## Determinism is per-run, not per-machine

Two runs, same machine, same browser. Byte-identical output for the overlay and
the hybrid means those two runs agreed. It is **not** a claim that two different
machines, browsers or library versions would agree.

## No-op saves are semantically preserving, not byte-identical

None of the preserving candidates reproduces its input byte for byte, and none
claims to. They load and re-serialise, so object numbering and stream layout
move. Anything that needs byte identity — a signature, a hash-based audit — is
not served by any candidate here, and that was not measured.

## What was deliberately not attempted

- **Editing existing source content.** M3 preserves a document while adding to
  it. Semantic editing of the content stream is a different problem.
- **Geometric difference for the pixel eraser.** Deferred; complex enough to
  deserve its own spike, and no attempt was made to estimate it.
- **Native PDF annotation objects** (as opposed to page content). Not compared.
- **Cloud or external conversion.** Excluded by the brief; no measurement taken,
  so this spike says nothing about whether they would be better.

## One thing that is not a limitation but reads like one

The unpkg worker request in `measurements.md` §12 is a **real, measured defect
in production**, not an artefact of the research setup. The research harness
makes zero external requests; the app makes one. It is pre-existing and this PR
does not touch it.
