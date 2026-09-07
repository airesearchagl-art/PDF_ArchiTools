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

## 1. What survives a save

Per fixture, worst verdict across its pages. `not applicable` means the fixture
had nothing of that kind to preserve, and is kept distinct from `preserved`: a
page with no form fields says nothing about whether forms survive.

| fixture | candidate | source text | source vector | rotation | crop box | output |
| --- | --- | --- | --- | --- | --- | --- |
| native | **baseline** | **lost** | **lost** | preserved | **changed** | 288 KB |
| native | overlay | preserved | preserved | preserved | preserved | 1163 KB |
| native | vector | *refused* | | | | |
| native | hybrid | preserved | preserved | preserved | preserved | 1096 KB |
| rotated | **baseline** | **lost** | **lost** | **changed** | **changed** | 371 KB |
| rotated | overlay | preserved | preserved | preserved | preserved | 1223 KB |
| rotated | hybrid | preserved | preserved | preserved | preserved | 1109 KB |
| boxes | **baseline** | **lost** | **lost** | preserved | **changed** | 274 KB |
| boxes | overlay / hybrid | preserved | preserved | preserved | preserved | 1188 / 1102 KB |
| croprot | **baseline** | **lost** | **lost** | **changed** | **changed** | 320 KB |
| croprot | overlay / hybrid | preserved | preserved | preserved | preserved | 1205 / 1109 KB |
| features | **baseline** | **lost** | **lost** | preserved | **changed** | 102 KB |
| features | overlay / hybrid | preserved | preserved | preserved | preserved | 1118 / 1091 KB |
| scanned | **baseline** | **lost** | n/a | preserved | **changed** | 150 KB |
| scanned | overlay / hybrid | preserved | n/a | preserved | preserved | 1173 / 1115 KB |
| a0 | **baseline** | **lost** | **lost** | preserved | **changed** | 430 KB |
| a0 | overlay / hybrid | preserved | preserved | preserved | preserved | 1232 / 1088 KB |

Beyond those four columns:

| | baseline | overlay | hybrid |
| --- | --- | --- | --- |
| existing annotations (4) | **lost** | preserved | preserved |
| form fields and values (2) | **2 → 0** | preserved | preserved |
| document metadata | **lost** (`title` → null) | preserved | preserved |
| invisible OCR text layer | **22 chars → 0** | 22 → 22 | 22 → 98 (source + added) |
| page count and order | preserved | preserved | preserved |

The vector-only candidate refused every fixture, for one reason, covered in §6.

## 2. Saving with nothing added

The question a save path should find easiest: open a document, add nothing,
write it out.

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

## 3. The source file is never modified

Compared **byte for byte**, on the very array handed to the candidate, against a
snapshot taken immediately before the call:

| candidate | fixtures with the input unchanged |
| --- | --- |
| baseline | 7 / 7 |
| overlay | 7 / 7 |
| vector | 7 / 7 — *including the seven it refuses* |
| hybrid | 7 / 7 |

An earlier revision compared the *length* of two different copies of the
fixture, which could not have failed. The refusal path is checked too: a save
that declines must still leave its input alone.

## 4. Coordinates: what space the app stores in

**Display space, with `/Rotate` already applied — not upright space.** An
earlier revision of this write-up said upright, and the error is invisible on
every unrotated page.

`PdfPage.tsx:74` sizes the canvas from `pageProxy.getViewport({ scale })` with
no `rotation` argument, so the viewport carries the page's own `/Rotate`.
`DrawingCanvas.tsx:129-138` then converts a pointer event with
`(clientX - rect.left) / scale` and nothing else. Dividing by the zoom removes
the zoom; nothing removes the rotation.

Zoom-independence does hold, and is measured:

| zoom | stored | PDF coordinate | a 4-pixel pen |
| --- | --- | --- | --- |
| 0.5× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 1× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 2× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |
| 6× | (137.5, 233.25) | (137.5, 608.64) | 4 pt |

So the save adapter is three steps, and the middle one is not optional:

```
stored (display, y down)  →  displayToUpright(/Rotate)  →  uprightToPdf(CropBox)
```

## 5. Does a mark end up where the user put it?

The arithmetic in §4 and the quadrant round-trip below prove that a function
inverts itself. They cannot prove that the save path calls it, or calls it the
right way round. So: place a mark at a known point in *display* space, save it,
reopen the file, render the page in display orientation, and find the mark.

Distance from where it was put, per quadrant:

| fixture | candidate | `/Rotate 0` | 90 | 180 | 270 |
| --- | --- | --- | --- | --- | --- |
| rotated | overlay | 0.4 pt | 0.4 pt | 0.4 pt | 0.4 pt |
| rotated | hybrid | 0.4 pt | 0.4 pt | 0.4 pt | 0.4 pt |
| croprot | overlay | 0.4 pt | 0.4 pt | 0.4 pt | 0.4 pt |
| croprot | hybrid | 0.4 pt | 0.4 pt | 0.4 pt | 0.4 pt |
| rotated | **baseline** | *the page is rewritten to 893×1263 capture pixels, and every page comes back at `/Rotate 0`* | | | |

`croprot` carries a CropBox origin of (50, 70) **and** a rotation on the same
page, which neither `boxes.pdf` nor `rotated.pdf` can catch on its own.

**This probe found a real bug that the arithmetic passed straight over.** The
overlay's image placement had a hand-written formula per quadrant with the
rotation negated. It put the mark **863 points** out at `/Rotate 90` and off the
page entirely at 270, while every standalone transform test reported success.

It survived a first look because the fragment it was tested with was nearly
square, and a square hides a swapped width and height. The marker is now
deliberately oblong, and the placement is derived from the page mapping — the
image's bottom-left corner is the display rectangle's bottom-left, and its
rotation is the page's own — rather than written out four times.

### The quadrant arithmetic, for completeness

| `/Rotate` | displayed size | upright | PDF coordinate | round-trips | on the page |
| --- | --- | --- | --- | --- | --- |
| 0 | 595.28 × 841.89 | (40, 40) | (40, 801.89) | yes | yes |
| 90 | 841.89 × 595.28 | (40, 801.89) | (40, 40) | yes | yes |
| 180 | 595.28 × 841.89 | (555.28, 801.89) | (555.28, 40) | yes | yes |
| 270 | 841.89 × 595.28 | (555.28, 40) | (555.28, 801.89) | yes | yes |

Four distinct answers, which matters: a mapping returning the same coordinate
for every quadrant would round-trip just as happily and be wrong.

### Page boxes

| page | CropBox | `getSize()` | correct top-left | naive top-left | off by |
| --- | --- | --- | --- | --- | --- |
| 1 | 0,0 595×842 | 595×842 | (0, 841.89) | (0, 841.89) | — |
| 2 | 40,40 515×762 | **595×842** | (40, 801.89) | (0, 841.89) | (−40, +40) |
| 3 | 60,90 515×722 | **595×842** | (60, 811.89) | (0, 841.89) | (−60, +30) |

**`pdf-lib`'s `page.getSize()` reports the MediaBox even when the CropBox is
smaller.** On `boxes.pdf` page 2 the naive mapping puts a mark 40 points into
the margin the crop exists to hide.

## 6. What a content stream cannot do

The vector-only candidate refused all seven fixtures. One object is responsible:

```
stroke-eraser-mark: a pixel eraser subtracts from ink already drawn,
                    and a content stream cannot un-draw
```

Not a gap in the implementation. The pixel eraser is an ordinary object in the
array replayed with `globalCompositeOperation = 'destination-out'`
(`DrawingCanvas.tsx:223-229`). PDF has no operator for that.

The same set without the eraser saves as **64 drawing operators**.

The other three erasers need no such treatment:

| eraser | what it does to state |
| --- | --- |
| pixel (`eraser`) | **adds** a stroke with `isEraser: true`; deletes nothing |
| stroke (`stroke-eraser`) | deletes whole strokes and measurements within 10 units |
| rectangle (`rect-eraser`) | **splits** strokes at vertices; deletes measurements and text |
| lasso (`lasso-eraser`) | deletes whole objects, text included |

**None of them touches the source PDF.** The annotation canvas is a separate
element stacked over the page canvas (`PdfPage.tsx:133-162`), so
`destination-out` clears annotation ink and reveals the drawing underneath. It
is not redaction, it cannot remove anything from the source, and no candidate
treats it as though it could.

## 7. Does the saved layer stack the way the canvas does?

Preservation checks cannot see a z-order inversion: every scenario below would
pass all of §1. So each is rendered as the app would render it, saved, reopened,
and compared over the marks' own bounding box.

| scenario | hybrid | the runs it produced |
| --- | --- | --- |
| before, eraser, after | 0.50% | `raster:A+E` → `vector:B` |
| affected and unaffected interleaved | 0.53% | `raster:A+far+E` → `vector:B` |
| multiple erasers | 0.68% | `raster:A+E1+B+E2` → `vector:C` |
| pressure stroke, edge erased | 0.56% | `raster:P+E` |
| text partially erased | 0.68% | `raster:T+E` |
| measurement line label erased | 0.53% | `raster:M+E` |
| poly labels erased | 0.49% | `raster:M+E` |
| area fill and label erased | 0.55% | `raster:M+E` |
| overlapping annotations, no eraser | 6.19% | `vector:A+B+T` |

The last row is the all-vector case and carries text, so it pays the font
substitution of §8; every other row is within 0.7%.

**An earlier revision of the hybrid failed this by construction.** It sorted
objects into a vector bucket and a raster bucket and wrote all of one then all
of the other. Given `stroke A, eraser, stroke B`, B is on top on screen; bucketed,
B was written as an operator and the fragment holding A and the eraser was drawn
over it. The first row above is that exact case, and the run list shows the fix:
the fragment first, the later stroke after it.

Two properties worth naming:

- `affected and unaffected interleaved` puts `far` — which no eraser touches —
  inside the raster span, because it sits between the first affected object and
  the last eraser. **Deliberately conservative**: deciding otherwise means
  reasoning about overlaps between every pair, and being wrong there reorders
  the user's marks.
- `overlapping annotations, no eraser` stays entirely vector. The fallback fires
  on cause, not on suspicion.

## 8. How close each output looks

Per tool, the fraction of pixels in that object's own bounding box that differ
from what the annotator showed.

| tool | baseline | overlay | hybrid |
| --- | --- | --- | --- |
| `stroke-plain` | 0.6% | **0.0%** | **0.0%** |
| `stroke-alpha` | 0.0% | **0.0%** | **0.0%** |
| `stroke-pressure` | 0.6% | **0.0%** | **0.1%** |
| `stroke-eraser-mark` | 0.4% | **0.0%** | **0.0%** |
| `text-ascii` | 0.2% | 0.3% | **9.4%** |
| `text-japanese` | 2.5% | 0.4% | **16.3%** |
| `text-mixed` | 1.0% | 0.9% | **10.3%** |
| `measure-line` | 1.2% | 0.6% | 4.9% |
| `measure-poly` | 0.8% | 0.5% | 3.7% |
| `measure-area` | 0.1% | 0.4% | 3.6% |
| **whole page** | **0.20%** | 0.63% | 1.44% |

**The baseline has the best whole-page fidelity of the three and preserves
nothing.** It is a faithful photograph of a document it has destroyed. Any
argument that reads visual fidelity as evidence of preservation is refuted by
that row, and it is why §1 exists.

### The reference renderer had to be corrected first

These numbers replace an earlier set that was measuring the wrong thing. The
research mirror of the app's draw loop differed from the app in ways that all
touched text and measurements:

| | the app | the earlier mirror |
| --- | --- | --- |
| text anchor | `textBaseline = 'top'` | `'alphabetic'` |
| area measurement | stroke, then fill | fill, then stroke |
| poly / area vertices | dots, radius 3 | absent |
| line label | 12px, centred, box at `y − 14` | approximated |
| poly segment label | 10px, grey `#555`, at `y + 4` | wrong font, wrong colour, wrong offset |
| poly total label | `bold 12px`, `"Total: …"`, left-aligned | `"Σ …"`, centred |

The vector writer had a matching error — it treated the stored `y` as a
typographic baseline when it is the *top* of the glyph box — and the two
partially cancelled. Correcting both moved the text numbers **up**, from 8–12%
to 9–16%, because a flattering cancellation went away.

### Which is not the same as being misplaced

The remaining difference could be glyph shape or it could be vertical
misplacement. Comparing each text object at a range of vertical offsets
separates them:

| object | as placed | best offset | at that offset |
| --- | --- | --- | --- |
| `text-ascii` | 9.4% | −8 pt | 9.3% |
| `text-japanese` | 16.3% | +5 pt | 16.1% |
| `text-mixed` | 10.3% | **0 pt** | 10.3% |

No shift rescues it — the best improvement is a tenth of a percent, and one
string is already at its optimum. **The placement arithmetic is right; the faces
simply differ.** That is the irreducible cost of searchable text, and it is what
the REVISE in `decision-matrix.md` is about.

## 9. Documents this design refuses

| document | assessed | saving it |
| --- | --- | --- |
| `native.pdf` | supported | 1,115,994 bytes |
| `signed.pdf` | **refused** — `signed` | `電子署名付きPDFは、保存すると署名が無効になるため、現在は処理できません。` |
| `damaged.pdf` | **refused** — `unreadable` | refused before anything is written |

Every candidate re-serialises the document, which invalidates a signature over
it. Producing that file and reporting success is the worst kind of preservation
failure: the document still looks signed and is not.

`damaged.pdf` needed more than a successful `load`. pdf-lib parsed it far enough
to return a document, and the save then failed in the middle with
`Cannot read properties of undefined` — the worst place to find out and the
least useful thing to say. The assessment now walks every page and reads its
boxes before anything is produced, and refuses with a reason.

**Encryption is unmeasured.** The refusal path exists in the code; nothing in
the dependency set can write an encrypted PDF to test it against.

## 10. The largest sheet

An A0 at the current capture scale of 2×:

| | max raster | RGBA | output | time |
| --- | --- | --- | --- | --- |
| a full page at 2× | 32.14 Mpx | 129 MB | — | — |
| **baseline** | 32.14 Mpx | 128.6 MB | 430 KB | 370 ms |
| **overlay** | 32.14 Mpx | 128.6 MB | 1232 KB | 1386 ms |
| vector | — | — | *refused* | — |
| **hybrid** | **0.19 Mpx** | **0.8 MB** | 1088 KB | **28 ms** |

The overlay preserves everything and still pays the whole page in pixels,
because a page-sized transparent layer is a page-sized image. That is a real
finding against the simplest preserving option, and the reason the hybrid earns
its extra complexity: **169× fewer pixels and 49× faster** on the same sheet.

## 11. The same input twice

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

## 12. Failing

| asked to | result |
| --- | --- |
| write a pixel eraser as operators | refused, with the object named and the reason given |
| write the same set without one | 64 operators, 1,114,219 bytes |
| write a stroke whose first point is `NaN` | refused — `` `options.start.x` must be of type `number`, but was actually of type `NaN` `` |
| save a signed document | refused, by name |
| save a damaged document | refused, before writing |

Every refusal stops the whole save. None drops the offending item and returns a
file that looks complete, which is the outcome this design most needs to avoid.

## 13. Network

| | external HTTP(S) requests |
| --- | --- |
| the research harness | **0** |
| **the Annotator, in a production build** | **1** |

The one is measured, not inferred. Loading a PDF in the Annotator fetches:

```
https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs
```

`src/components/PdfViewer.tsx:16` assigns `GlobalWorkerOptions.workerSrc` to
unpkg at module scope. A local worker already ships at
`public/pdf.worker.min.mjs`, and `src/utils/pdf-worker-source.ts` already exists
to point at it — the Annotator simply does not call it.

**Pre-existing production debt**, not introduced by this spike, and this is a
research PR: reported here and left alone. See `decision-matrix.md`.

## 14. The gate

`scripts/research-m3-gate.mjs` re-asserts **121 claims, 32 of them negative
probes** — including the unusual one that the current save path must *fail*
preservation. A comparison in which every candidate passes proves nothing about
any of them.
