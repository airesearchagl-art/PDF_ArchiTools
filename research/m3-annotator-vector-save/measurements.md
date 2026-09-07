# M3 measurements

Everything below was measured on the synthetic corpus in `fixtures.md`, on this
machine, with `scripts/research-m3-probe.mjs`.
`scripts/research-m3-gate.mjs` re-asserts the load-bearing numbers, so a
measurement that stops holding becomes a failing gate rather than a paragraph
that quietly goes stale.

```
node scripts/research-m3-fixtures.mjs
node scripts/research-m3-probe.mjs
node scripts/research-m3-gate.mjs
```

## 0. The save path as it stands today

Read from `src/components/PdfViewer.tsx:196-243` rather than assumed:

```
document.querySelectorAll('.pdf-page-container')   // whatever is in the DOM
  → html2canvas(pageEl, { scale: 2 })              // one picture per page
  → canvas.toDataURL('image/jpeg', 0.85)           // lossy, and no alpha
  → new jsPDF({ unit: 'px' })                      // a brand-new document
  → pdf.addPage([imgWidth, imgHeight])             // sized in capture pixels
  → pdf.addImage(imgData, 'JPEG', 0, 0, w, h)
```

The source document is never opened by the writer. Nothing about the original —
not a page box, not a rotation, not a character — reaches the output except as
pixels.

Three consequences follow directly from the code and are confirmed by
measurement below: the output page is sized in *capture pixels* rather than
source points; the page list comes from the DOM rather than the document; and
the annotation layer is flattened together with the page it sits on.

## 1. What survives a save

Per fixture, worst verdict across its pages. `not applicable` means the fixture
had nothing of that kind to preserve — kept distinct from `preserved`, because
a page with no form fields says nothing about whether forms survive.

| fixture | candidate | source text | source vector | rotation | crop box | output |
| --- | --- | --- | --- | --- | --- | --- |
| native | **baseline** | **lost** | **lost** | preserved | **changed** | 290 KB |
| native | overlay | preserved | preserved | preserved | preserved | 1164 KB |
| native | vector | *refused* | | | | |
| native | hybrid | preserved | preserved | preserved | preserved | 1090 KB |
| rotated | **baseline** | **lost** | **lost** | **changed** | **changed** | 378 KB |
| rotated | overlay | preserved | preserved | preserved | preserved | 1233 KB |
| rotated | hybrid | preserved | preserved | preserved | preserved | 1097 KB |
| boxes | **baseline** | **lost** | **lost** | preserved | **changed** | 278 KB |
| boxes | overlay | preserved | preserved | preserved | preserved | 1190 KB |
| boxes | hybrid | preserved | preserved | preserved | preserved | 1093 KB |
| features | **baseline** | **lost** | **lost** | preserved | **changed** | 103 KB |
| features | overlay | preserved | preserved | preserved | preserved | 1118 KB |
| features | hybrid | preserved | preserved | preserved | preserved | 1088 KB |
| scanned | **baseline** | **lost** | n/a | preserved | **changed** | 153 KB |
| scanned | overlay | preserved | n/a | preserved | preserved | 1175 KB |
| scanned | hybrid | preserved | n/a | preserved | preserved | 1109 KB |
| a0 | **baseline** | **lost** | **lost** | preserved | **changed** | 430 KB |
| a0 | overlay | preserved | preserved | preserved | preserved | 1232 KB |
| a0 | hybrid | preserved | preserved | preserved | preserved | 1085 KB |

Beyond the four columns above:

| | baseline | overlay | hybrid |
| --- | --- | --- | --- |
| existing annotations (4) | **lost** | preserved | preserved |
| form fields and their values (2) | **2 → 0** | 2 → 2, values intact | 2 → 2, values intact |
| document metadata | **lost** (`title` becomes null) | preserved | preserved |
| invisible OCR text layer | **22 chars → 0** | 22 → 22 | 22 → 98 (source + added) |
| page count and order | preserved | preserved | preserved |
| source bytes modified | no | no | no |

The vector-only candidate refused every fixture, for one reason, covered in §5.

## 2. Saving with nothing added

The question a save path should find easiest: open a document, add no
annotations, write it out.

| candidate | pages | characters | path ops | bytes |
| --- | --- | --- | --- | --- |
| **baseline** | 3 → 3 | **155 → 0** | **21 → 0** | 1,066,458 → 221,432 |
| overlay | 3 → 3 | 155 → 155 | 21 → 21 | → 1,104,158 |
| vector | 3 → 3 | 155 → 155 | 21 → 21 | → 1,105,878 |
| hybrid | 3 → 3 | 155 → 155 | 21 → 21 | → 1,105,878 |

The baseline destroys a document it was asked to change in no way at all.

None of the three preserving candidates is byte-identical to its input, and none
claims to be. They load and re-serialise, so object numbering and stream layout
move. **Semantic preservation and byte identity are different claims**, and only
the first is being made.

## 3. Coordinates: zoom

The stored model is already in PDF points — `DrawingCanvas.tsx:129-138` divides
pointer pixels by the zoom on the way in — so this asks whether the whole chain
through to a written coordinate holds up.

| zoom | stored | PDF coordinate | a 4-pixel pen |
| --- | --- | --- | --- |
| 0.5× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 1× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 2× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 6× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |

Identical at every zoom, position and width alike.

This is a property of the object model, not of any candidate — and the baseline
throws it away regardless, because it captures the DOM at whatever zoom the user
is at, so the output page size and resolution depend on it.

## 4. Coordinates: rotation and page boxes

All four quadrants, one point 40 pt in from the top-left of the *displayed* page:

| `/Rotate` | displayed size | upright | PDF coordinate | round-trips | on the page |
| --- | --- | --- | --- | --- | --- |
| 0 | 595.28 × 841.89 | (40, 40) | (40, 801.89) | yes | yes |
| 90 | 841.89 × 595.28 | (40, 801.89) | (40, 40) | yes | yes |
| 180 | 595.28 × 841.89 | (555.28, 801.89) | (555.28, 40) | yes | yes |
| 270 | 841.89 × 595.28 | (555.28, 40) | (555.28, 801.89) | yes | yes |

Four different answers, which is the point: a mapping that returned the same
coordinate for every quadrant would round-trip just as happily and be wrong.

Page boxes, and the trap:

| page | CropBox | `getSize()` | correct top-left | naive top-left | off by |
| --- | --- | --- | --- | --- | --- |
| 1 | 0,0 595×842 | 595×842 | (0, 841.89) | (0, 841.89) | — |
| 2 | 40,40 515×762 | **595×842** | (40, 801.89) | (0, 841.89) | (−40, +40) |
| 3 | 60,90 515×722 | **595×842** | (60, 811.89) | (0, 841.89) | (−60, +30) |

**`pdf-lib`'s `page.getSize()` reports the MediaBox even when the CropBox is
smaller.** A save path that maps annotations with it puts every mark on a
cropped page in the wrong place — and on `boxes.pdf` page 2, 40 points down is
into the margin the crop hides.

## 5. What a content stream cannot do

The vector-only candidate refused all six fixtures. One object is responsible:

```
stroke-eraser-mark: a pixel eraser subtracts from ink already drawn,
                    and a content stream cannot un-draw
```

This is not a gap in the implementation. The app's pixel eraser is not a
deletion: it is an ordinary object in the array, replayed with
`globalCompositeOperation = 'destination-out'` (`DrawingCanvas.tsx:223-229`), so
it removes pixels from whatever was drawn before it. PDF has no operator for
that. A vector save can compute the geometric difference, refuse, or fall back
to pixels; it cannot express it.

The same set without the eraser saves successfully as **53 drawing operators**.

The other three erasers need no such treatment, because they are object
operations and nothing else:

| eraser | what it does to state |
| --- | --- |
| pixel (`eraser`) | **adds** a stroke with `isEraser: true`; deletes nothing |
| stroke (`stroke-eraser`) | deletes whole strokes and measurements within 10 units |
| rectangle (`rect-eraser`) | **splits** strokes at vertices; deletes measurements and text |
| lasso (`lasso-eraser`) | deletes whole objects, text included |

Three of the four leave an object array that any candidate can write. Only the
pixel eraser needs pixels.

**None of them touches the source PDF.** The annotation canvas is a separate
element stacked over the page canvas (`PdfPage.tsx:133-162`), so
`destination-out` clears annotation ink and reveals the drawing underneath. It
is not redaction, it cannot remove anything from the source, and no candidate
here treats it as though it could.

## 6. What the hybrid sends where

| | objects |
| --- | --- |
| written as operators | `stroke-pressure`, `text-ascii`, `text-japanese`, `text-mixed`, `measure-line`, `measure-poly`, `measure-area` |
| written as pixels | `stroke-plain`, `stroke-alpha`, `stroke-eraser-mark` |

Three of ten. The rule is by cause, not convenience: the eraser and the ink it
subtracts from are only correct together, so they go into one transparent
fragment covering their shared bounding box. Everything else is operators.

Measurement labels are computed, not stored — the app derives them at draw time
(`DrawingCanvas.tsx:296-362`) — so a save path must derive them too:

```
measure-line   67.01 mm
measure-poly   30.80 mm | 34.74 mm | Σ 65.54 mm
measure-area   1791.32 mm²
```

A candidate that forgets keeps the lines and loses the numbers, which looks like
success.

## 7. Searchable annotation text

| candidate | `REVISION A` | `確認済み` | a `NN.NN mm` label |
| --- | --- | --- | --- |
| baseline | no | no | no |
| overlay | no | no | no |
| **hybrid** | **yes** | **yes** | **yes** |

The overlay's annotations are a picture; that is inherent, not a defect of this
implementation. Only a candidate that writes text as text produces text anyone
can search for, and the hybrid is the only one here that does.

## 8. How close each output looks

Per tool, the fraction of pixels in that object's own bounding box that differ
from what the annotator showed. One aggregate number would report "mostly fine"
while a whole tool was missing.

| tool | baseline | overlay | hybrid |
| --- | --- | --- | --- |
| `stroke-plain` | 0.6% | **0.0%** | **0.0%** |
| `stroke-alpha` | 0.0% | **0.0%** | **0.0%** |
| `stroke-pressure` | 0.6% | **0.0%** | 0.9% |
| `stroke-eraser-mark` | 0.4% | **0.0%** | **0.0%** |
| `text-ascii` | 0.2% | 0.3% | **10.5%** |
| `text-japanese` | 2.8% | 0.4% | **12.1%** |
| `text-mixed` | 0.7% | 0.9% | **8.0%** |
| `measure-line` | 1.3% | 0.6% | 2.9% |
| `measure-poly` | 2.4% | 0.4% | 4.8% |
| `measure-area` | 0.1% | 0.4% | 3.7% |
| **whole page** | **0.24%** | 0.63% | 1.40% |

Two things to take from this.

**The baseline has the best whole-page fidelity of the three and preserves
nothing.** It is a faithful photograph of a document it has destroyed. Any
argument that reads visual fidelity as evidence of preservation is refuted by
this row, and it is why §1 exists.

**The hybrid's text differs because the font is a substitute.** The canvas draws
in whatever `fontFamily` the UI chose — a CSS family name — and the PDF embeds
the OFL font shipped in this repository, because a CSS name cannot be resolved
to a file to embed. Those are different typefaces, so the glyphs do not line up.
That is the honest cost of searchable text, and it is reported rather than
absorbed: see `limitations.md`.

## 9. The largest sheet

An A0 at the current capture scale of 2×:

| | max raster | RGBA | output | time |
| --- | --- | --- | --- | --- |
| a full page at 2× | 32.14 Mpx | 128.6 MB | — | — |
| **baseline** | 32.14 Mpx | 128.6 MB | 430 KB | 305 ms |
| **overlay** | 32.14 Mpx | 128.6 MB | 1232 KB | 1230 ms |
| vector | — | — | *refused* | — |
| **hybrid** | **0.11 Mpx** | **0.5 MB** | 1085 KB | **26 ms** |

The overlay preserves everything and still pays the full page in pixels,
because a page-sized transparent layer is a page-sized image. That is a real
finding against the simplest preserving option, and the reason the hybrid is
worth its extra complexity: **292× fewer pixels and 47× faster on the same
sheet**, because it rasterises the marks rather than the paper.

## 10. The same input twice

| candidate | same bytes | same content |
| --- | --- | --- |
| baseline | **no** | yes |
| overlay | yes | yes |
| vector | *refused* | |
| hybrid | yes | yes |

The baseline's output differs byte for byte between runs while rendering
identically — JPEG encoding and jsPDF's own metadata. Deterministic semantics,
non-deterministic bytes, and worth separating: only the first is a correctness
property.

## 11. Failing

| asked to | result |
| --- | --- |
| write a pixel eraser as operators | refused, with the object named and the reason given |
| write the same set without one | 53 operators, 1,113,327 bytes |
| write a stroke whose first point is `NaN` | refused — `` `options.start.x` must be of type `number`, but was actually of type `NaN` `` |

Both refusals stop the whole save. Neither drops the offending mark and returns
a file that looks complete, which is the outcome this design most needs to
avoid.

## 12. Network

| | external HTTP(S) requests |
| --- | --- |
| the research harness | **0** |
| **the Annotator, in a production build** | **1** |

The one is real and is measured, not inferred. Loading a PDF in the Annotator
fetches:

```
https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs
```

`src/components/PdfViewer.tsx:16` assigns `GlobalWorkerOptions.workerSrc` to
unpkg at module scope. A local worker is already shipped at
`public/pdf.worker.min.mjs`, and `src/utils/pdf-worker-source.ts` already exists
to point at it — the Annotator simply does not call it.

This is **pre-existing production debt**, not something this spike introduced,
and this is a research PR: it is reported here and left alone. See
`decision-matrix.md` for where it should be fixed.

## 13. The gate

`scripts/research-m3-gate.mjs` re-asserts **88 claims, 25 of them negative
probes** — including the unusual one that the current save path must *fail*
preservation. A comparison in which every candidate passes proves nothing about
any of them.
