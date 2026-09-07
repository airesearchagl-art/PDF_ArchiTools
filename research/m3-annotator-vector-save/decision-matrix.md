# M3 decision matrix

Four candidates, compared on what was measured rather than on what each sounds
like. Evidence references are sections of `measurements.md`.

Verdicts are **ADOPT** (build it this way), **REVISE** (right shape, one part
needs settling first) and **DEFER** (not now).

## The candidates

| | |
| --- | --- |
| **0 — current** | the whole page, including the source, flattened to JPEG in a new document. Control, not a proposal. |
| **A — raster overlay** | the source PDF preserved, the annotation layer alone laid over it as a transparent PNG. |
| **B — vector** | the source PDF preserved, annotations written as drawing operators. |
| **C — hybrid** | the source PDF preserved, the annotation layer written as an ordered sequence of runs: operators where they work, a local transparent raster for the span an eraser reaches into. |

## The comparison

| | 0 current | A overlay | B vector | **C hybrid** |
| --- | --- | --- | --- | --- |
| source vector preserved | **lost** | preserved | preserved¹ | **preserved** |
| source searchable text | **lost** | preserved | preserved¹ | **preserved** |
| source images | preserved² | preserved | preserved¹ | **preserved** |
| existing annotations | **lost** | preserved | preserved¹ | **preserved** |
| form fields + values | **2 → 0** | preserved | preserved¹ | **preserved** |
| metadata | **lost** | preserved | preserved¹ | **preserved** |
| rotation | **changed** | preserved | preserved¹ | **preserved** |
| CropBox / MediaBox | **changed** | preserved | preserved¹ | **preserved** |
| page count and order | preserved | preserved | preserved¹ | **preserved** |
| no-op save is harmless | **no** | yes | yes | **yes** |
| annotations as vector | no | no | yes¹ | **partly (7 of 10)** |
| added text searchable | no | no | yes¹ | **yes** |
| pixel-eraser fidelity | exact | **exact** | **impossible** | **exact** |
| painter order preserved | n/a | **yes** | ¹ | **yes** (9 scenarios, ≤0.7%) |
| pressure fidelity | 0.6% | **0.0%** | ¹ | **0.1%** |
| Japanese text | 2.5% | **0.4%** | ¹ | 16.3% (substitute font) |
| whole-page visual difference | **0.20%** | 0.63% | ¹ | 1.44% |
| mark lands where it was put, all quadrants | *page rewritten* | **0.4 pt** | ¹ | **0.4 pt** |
| A0 max raster | 32.14 Mpx | 32.14 Mpx | ¹ | **0.19 Mpx** |
| A0 runtime | 370 ms | 1386 ms | ¹ | **28 ms** |
| output size (native.pdf) | **288 KB** | 1163 KB | ¹ | 1096 KB |
| refuses signed / damaged sources | no | **yes** | **yes** | **yes** |
| leaves its input bytes alone | **yes** | **yes** | **yes** | **yes** |
| deterministic bytes | **no** | yes | ¹ | **yes** |
| fails closed | not exercised | not exercised | **yes** | **yes** |
| browser-only | yes | yes | yes | yes |
| new dependencies | 0 | 0 | 0 | **0** |
| implementation complexity | lowest | low | moderate | **highest** |

¹ B refused all seven fixtures, so its preservation columns are inherited from the
same pdf-lib load path as A and C rather than separately observed. Its
annotation columns are unmeasurable on this corpus.

² The baseline replaces every page with one JPEG, so an image count survives by
coincidence rather than by preservation.

---

## 1. Whether to keep rasterising the whole page

| option | verdict |
| --- | --- |
| flatten the page (current) | **rejected** |
| keep the source document | **ADOPT** |

§1, §2. The current path loses text, vectors, annotations, forms, metadata,
rotation and page boxes on every fixture, and does so even when asked to add
nothing at all.

The strongest argument for it — that it looks right — is refuted by its own
number: **0.20% whole-page difference, the best of any candidate.** It is a
faithful photograph of a destroyed document, and that combination is precisely
why nobody would notice.

## 2. Whether the annotation layer must be vector

| option | verdict |
| --- | --- |
| all annotations must be vector or it is a failure | **rejected** |
| annotations may be raster where they must be | **ADOPT** |

§5. The app's pixel eraser subtracts from ink already drawn. A content stream
has no operator for that, so an all-vector rule would either drop the eraser —
changing what the user drew — or refuse to save a document the user considers
finished. B refused all seven fixtures on exactly this.

Deciding this up front, either way, would have produced a worse design than
measuring it.

## 3. Which candidate

**ADOPT C, the hybrid.** It preserves everything A preserves — the whole source
column above is identical — and adds two things A cannot:

- **searchable annotation text**, Japanese included, plus the measurement
  labels. A's annotations are a picture; no candidate that rasterises them can
  make them searchable, and that is inherent rather than a defect.
- **an A0 that costs 0.19 Mpx instead of 32.14**, and 28 ms instead of 1386.
  A's overlay is page-sized because a transparent layer over a page is a
  page-sized image; C rasterises the marks rather than the paper.

Its costs are real and are not hidden:

- **text looks different** — 9–16% of pixels on the text objects, against
  0.3–0.9% for A, because the font is a substitute (§8, and REVISE below);
- it is the most complex of the four, needing a split rule, two writers and a
  coordinate transform that A also needs but exercises less;
- output is larger than the raster baseline (1096 KB vs 288 KB), which
  is what keeping a document rather than a photograph of one costs.

**Keep A inside C, not beside it.** The hybrid is A applied to a smaller region.
A page that somehow needs everything rastered degrades to the overlay with the
source still preserved — one implementation, not two.

## 4. Coordinates

| option | verdict |
| --- | --- |
| store pointer pixels, convert at save | **rejected** |
| store points, convert at save (current behaviour) | **ADOPT** |

§4. The app divides by the zoom on the way in, and the measurement confirms the
whole chain: identical stored and written coordinates and identical line widths
at 0.5×, 1×, 2× and 6×.

**But the stored space is *display* space, not upright.** The canvas is sized
from a rotated viewport (`PdfPage.tsx:74`) and nothing undoes the rotation, so a
save path needs three steps and not two:

```
stored (display) → displayToUpright(/Rotate) → uprightToPdf(CropBox) → PDF
```

The first revision of this spike described the stored space as upright and drove
the candidates accordingly. It measured clean, because a transform round-trip
tests that a function inverts itself — not that the save path calls it.

**Prove it end to end.** Placing a mark, saving, reopening and finding it caught
a real bug the arithmetic passed over: the overlay's image placement was 863
points out at `/Rotate 90` and off the page at 270. Both candidates now land
within **0.4 pt on all four quadrants**, including a fixture with a crop origin
and a rotation together.

## 5. Page boxes

| option | verdict |
| --- | --- |
| map with `page.getSize()` | **rejected** |
| map with the CropBox, falling back to the MediaBox | **ADOPT** |

§4. `getSize()` reports the MediaBox even when the CropBox is smaller. Measured
error on the corpus: (−40, +40) and (−60, +30) points — the second putting a
mark into the margin the crop exists to hide.

## 6. Rotation

| option | verdict |
| --- | --- |
| write rotated coordinates | **rejected** |
| undo `/Rotate` on input, write unrotated | **ADOPT** |

§4. `/Rotate` is a viewer instruction; a content stream is written unrotated. All
four quadrants round-trip and produce four distinct answers — a mapping that
returned the same coordinate for every quadrant would round-trip just as
happily and be wrong.

## 7. Fonts for annotation text

| option | measured |
| --- | --- |
| the user's `fontFamily` | impossible — a CSS family name cannot be resolved to a file to embed |
| an embedded document font | works, covers Japanese, 9–16% pixel difference |
| raster the text instead | 0.3–0.9% difference, not searchable |

**REVISE.** Substitution is unavoidable for vector text, and its cost is
**glyph shape, not misplacement**: comparing each string at a range of vertical
offsets improves the difference by a tenth of a percent, and for one string the
best offset is zero. The placement arithmetic is right; the faces differ.

Those numbers went *up* from the first revision (8–12% → 9–16%), because the
reference renderer was corrected. It had been anchoring text at the wrong
baseline while the writer made the matching mistake, and the two partially
cancelled — a flattering accident, now gone.

What the user is told, and whether they are offered the choice between
searchable-but-different and exact-but-a-picture, is a product decision this
spike can inform and should not make.

What must never be claimed is that a chosen family was preserved.

## 8. The pixel eraser, and composition order

| option | verdict |
| --- | --- |
| drop the eraser and save the rest | **rejected** — changes what the user drew |
| refuse the whole save | correct for B, and B is not adopted |
| geometric difference | **DEFER** — unmeasured, and its own spike |
| a bounded transparent raster fragment | **ADOPT** |

§6, §7. The rule is by cause — an eraser and the ink it subtracts from are only
correct together — not by convenience.

**And the layer must be written in painter order.** A vector bucket and a raster
bucket written one after the other inverts stacking: given `stroke A, eraser,
stroke B`, B is on top on screen and underneath in the file. The first revision
of this design did exactly that. The layer is now planned as an ordered sequence
of runs and emitted in order; pdf-lib appends in call order, so stacking
survives by construction. Nine ordering scenarios measure it, all within 0.7%.

The span is **deliberately over-inclusive**: an object no eraser touches is
still rasterised if it sits between the first affected object and the last
eraser. Deciding otherwise means reasoning about overlaps between every pair,
and being wrong there reorders the user's marks. The bounds used to decide what
an eraser touches must likewise cover everything an object paints — a pressure
stroke's widest segment, a glyph's real extent, vertex dots, label backing
rectangles, and a polyline's total label, which sits past its last point.

**Safety**: this is annotation ink only. No candidate removes anything from a
source page's content stream, and none may. If a future feature needs to hide
page content, it is a visual mask and must be called one; masking is not
redaction.

## 8b. Which source documents to accept

| document | verdict |
| --- | --- |
| ordinary | **ADOPT** — save it |
| carrying a signature | **refuse**, by name |
| encrypted / password-protected | **refuse** |
| damaged beyond reading | **refuse**, before writing anything |

§9. Every candidate re-serialises the document, which invalidates a signature
over it. Producing that file and reporting success is the worst kind of
preservation failure: it still looks signed and is not.

A successful `load` is not enough to accept a file. pdf-lib parsed the damaged
fixture far enough to return a document, and the save then failed mid-way with
`Cannot read properties of undefined`. The assessment now walks every page
before anything is produced.

**Encryption is unmeasured** — the refusal path exists, and nothing in the
dependency set can write an encrypted PDF to exercise it against. Outlines and
bookmarks are unmeasured too, and no candidate claims them.

## 9. Failure behaviour

| option | verdict |
| --- | --- |
| drop what cannot be written, return a file | **rejected** |
| stop, naming the object and the reason | **ADOPT** |

§11. A partial save that looks complete is the worst outcome available here,
because nothing downstream can tell it apart from a good one.

## 10. Dependencies

| | |
| --- | --- |
| `pdf-lib` | already a dependency; loads, preserves and writes. Does everything C needs. |
| `pdf.js` | already a dependency; rendering and inspection. |
| `jsPDF` | already a dependency; used only by the current baseline. C does not need it. |
| `html2canvas` | already a dependency; used only by the current baseline. C does not need it. |
| anything new | **not required** |

**New dependencies: 0.** No library was added, and none is proposed. If the
deferred geometric-difference work is ever taken up it may need one, and that is
a question for that spike with its own licence, bundle and maintenance columns.

Adopting C would leave `html2canvas` and `jsPDF` used by the Comparator but no
longer by the Annotator's save. Whether to remove them is an implementation-scope
question, not an architecture one.

## 11. The unpkg worker

Not a candidate question, but found while measuring and too important to leave
in a footnote.

**Loading a PDF in the Annotator makes one external request**, measured on a
production build:

```
https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs
```

`PdfViewer.tsx:16` assigns the worker to unpkg at module scope. A local worker
already ships at `public/pdf.worker.min.mjs` and `src/utils/pdf-worker-source.ts`
already exists to point at it; the Annotator does not call it.

This is **pre-existing production debt** and this is a research PR, so it is
reported and not touched. Two ways to close it:

| option | |
| --- | --- |
| fold it into the M3 implementation | it is one call in the same file M3 will already be changing |
| a separate small fix, before or beside M3 | it is a privacy fix with no architectural content, and it need not wait for an architecture decision |

**Recommended: a separate fix.** It should not have to wait for M3 to be
adopted, and it is not conditional on any of this.

---

## Summary

| | |
| --- | --- |
| **ADOPT** | Candidate **C**, the hybrid: source preserved via pdf-lib; the annotation layer planned as an ordered sequence of runs so stacking survives; operators where they work and a bounded transparent raster for the span an eraser reaches into, with conservative painted bounds; coordinates converted **display → upright → PDF**, against the CropBox; measurement labels derived and written as text; a support boundary that refuses signed, encrypted and unreadable sources by name; fail closed and whole. Candidate **A** retained as the degradation path inside it. |
| **REVISE** | the annotation font: substitution is unavoidable, its cost is measured, and what the user is told — or offered — is a product decision. |
| **DEFER** | Candidate B alone; geometric difference for the eraser; annotations as native PDF annotation objects; any editing of existing source content. |
| **SEPARATE** | the unpkg worker request in `PdfViewer.tsx:16` — a privacy fix that should not wait for this. |

## What the first review changed

| entry | was | now |
| --- | --- | --- |
| 4. coordinates | stored space described as *upright* | **display** space; a three-step adapter, proved end to end rather than by arithmetic |
| 8. eraser | a vector bucket and a raster bucket | an **ordered sequence of runs**, because buckets invert stacking |
| 7. font | 8–12%, cause unattributed | 9–16%, and separated: **glyph shape, not misplacement** |
| 8b. sources | absent | signed / encrypted / damaged **refused by name** |
| evidence | source-mutation checked by length | checked **byte for byte**, refusal path included |
