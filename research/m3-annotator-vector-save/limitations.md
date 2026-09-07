# M3 limitations

What this spike does not establish. Read this before quoting any number from
`measurements.md` in a decision.

## The corpus is synthetic, and tiny

Nine documents, nineteen pages, all generated. No customer file was used. That
was the brief and it is right for a spike, but it bounds everything:

- **No real scan.** The "scanned" pages are rasterised vector text — no skew, no
  speckle, no fold, no scanner gamma.
- **No document longer than four pages**, and nothing near the size of a real
  issue. Every runtime figure is for a handful of pages.
- **No outline or bookmark tree.** `pdf-lib` has no high-level API for one, and
  building it by hand would have measured the fixture rather than the save path.
  **Outline preservation is unmeasured** for every candidate.
- **No encrypted, linearised or tagged PDF.** A damaged one and one carrying a
  signature field are now in the corpus and are refused by name; **encryption is
  not**. The refusal path for it exists in the code and has never run, because
  nothing in the dependency set can write an encrypted PDF to test it against.
- **The signature fixture is a signature *field*, not a signature.** It exercises
  detection, which is what the boundary needs. Whether a genuinely signed
  document behaves the same on load is untested.
- **Two annotation subtypes and two form field types.** Widgets, appearance
  streams and field flags beyond `getText`/`isChecked` were not compared.

## The annotation set is one set

Ten objects, one of each kind the app can make, placed so that nothing overlaps.
Real annotation is dense and overlapping, and the pixel eraser's behaviour
depends on ordering in ways one non-overlapping set cannot exercise.

In particular the hybrid's span rule was measured on nine constructed ordering
scenarios, the largest of which has **two erasers among five objects**. A page
with many erasers scattered across many strokes pulls the span open until it is
the whole layer, at which point the hybrid degrades to the overlay — which is
the designed fallback, but **where that crossover sits in practice is
unmeasured**, and so is what it costs on a large sheet.

## Visual fidelity is measured against our own renderer

The reference image is the prototype's copy of `DrawingCanvas`'s draw loop, not
the app itself. **This copy has already been wrong once**, in six separate ways
at once — the wrong text baseline, area fill and stroke in the wrong order,
missing vertex dots, and three label styles that did not match — and the
resulting numbers understated the cost of vector text because the writer made a
matching mistake that partially cancelled it.

It has been corrected against `DrawingCanvas.tsx` line by line, but it is still
a copy, and a copy can drift again. Every fidelity number in `measurements.md`
is only as good as that correspondence.

The comparison is also headless Chromium's rasteriser against pdf.js's. Both are
approximations of what a user's viewer will do.

## The font finding is about one font

The substitute is the OFL font already shipped for OCR. A different embedded
font would give a different pixel difference. The 9–16% figure is the cost of
*that* substitution on *these* strings; it is not a general measure of how
different vector text looks.

It **is** attributable, at least: comparing each string at a range of vertical
offsets shows the difference is glyph shape rather than misplacement. That
separation holds for these three strings and was not tested on others.

Emoji and characters outside the font's coverage were **not** tested. The
corpus's "unsupported glyph" case is `<`, `&` and a mix of scripts, which the
font does cover.

## Three of the four erasers were read, not exercised

The pixel eraser is now exercised properly: nine ordering scenarios drive it
through both candidates and compare the result against what the canvas draws.
The other three are still only read from `DrawingCanvas.tsx`. The research
harness does not drive the actual UI, so:

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

## The end-to-end placement probe is one mark

`measurements.md` §5 places a single oblong mark near one corner and finds it
again. That is enough to catch a wrong quadrant formula — it caught one — but it
does not exercise marks near the far corners, marks that straddle a crop
boundary, or a page whose CropBox is larger than its MediaBox.

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
- **Any bound on the raster fragment's size.** The hybrid rasterises whatever
  span an eraser reaches, with no ceiling. A pathological layer could ask for a
  very large fragment, and nothing here measures or limits that.
- **Native PDF annotation objects** (as opposed to page content). Not compared.
- **Cloud or external conversion.** Excluded by the brief; no measurement taken,
  so this spike says nothing about whether they would be better.

## One thing that is not a limitation but reads like one

The unpkg worker request in `measurements.md` §13 is a **real, measured defect
in production**, not an artefact of the research setup. The research harness
makes zero external requests; the app makes one. It is pre-existing and this PR
does not touch it.
