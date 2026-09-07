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
| annotations as vector | no | no | yes¹ | **partly (6 of 10)** |
| added text searchable | no | no | yes¹ | **yes** |
| pixel-eraser fidelity | exact | **exact** | **impossible** | **exact** |
| painter order preserved | n/a | **yes** | ¹ | **yes** (9 scenarios, ≤0.7%) |
| pressure fidelity | 0.6% | **0.0%** | ¹ | **0.1%** |
| Japanese text | 2.5% | **0.4%** | ¹ | 16.3% (substitute font) |
| whole-page visual difference | **0.20%** | 0.63% | ¹ | 1.44% |
| mark lands where it was put, all quadrants | *page rewritten* | **0.4 pt** | ¹ | **0.4 pt** |
| A0 max raster | 32.14 Mpx | **refused³** | ¹ | **0.19 Mpx** |
| A0 runtime | 368 ms | **n/a³** | ¹ | **47 ms** |
| output size (native.pdf) | **288 KB** | 1163 KB | ¹ | 1096 KB |
| refuses signed / damaged sources | no | **yes** | **yes** | **yes** |
| leaves its input bytes alone | **yes** | **yes** | **yes** | **yes** |
| deterministic bytes | **no** | yes | ¹ | **yes** |
| fails closed | not exercised | **yes** | **yes** | **yes** |
| refuses an unsaveable annotation before writing | no | **yes** (9/9) | **yes** (9/9) | **yes** (9/9) |
| a character the font lacks | silently absent | drawn as pixels | **refused** | **drawn as pixels, reported** |
| raster fragment ceiling | none | 8 Mpx, page-sized ⇒ **fails on A0** | n/a | **8 Mpx, per fragment** |
| browser-only | yes | yes | yes | yes |
| new dependencies | 0 | 0 | 0 | **0** |
| implementation complexity | lowest | low | moderate | **highest** |

¹ B refused all seven fixtures, so its preservation columns are inherited from the
same pdf-lib load path as A and C rather than separately observed. Its
annotation columns are unmeasurable on this corpus.

² The baseline replaces every page with one JPEG, so an image count survives by
coincidence rather than by preservation.

³ Not a defect in the measurement -- it is the raster ceiling of section 12
applied to A's own design. A's overlay is page-sized by construction, so on an
A0 it needs 32.1 Mpx against a bound of 8.0, and is refused before allocating
anything. C needs 0.19 Mpx on the same page. See section 3.

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

### What the raster ceiling did to candidate A

Deciding the fragment bound (section 12) settled this question harder than the
fidelity numbers did. A's overlay is one image the size of the page, so the
bound applies to the whole page:

| | pixels needed on the A0 | against a bound of 8.0 Mpx |
|---|---|---|
| A, whole-page overlay | 32.1 Mpx (4768x6741) | **refused** |
| C, per-run fragments | 0.19 Mpx | 166x under |

A cannot save the largest sheet this product exists to handle. That is not a
tuning problem: raising the bound to admit an A0 overlay means admitting 129 MB
of live RGBA, which is the cost the current save path already pays and this
spike exists to stop paying. Nor is scaling the overlay down an option -- it
would quietly blur the user's marks with no way for them to know.

So A survives only as a description of C's worst case, on pages small enough
for a whole-layer fragment to fit under the bound. It is not a candidate.

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

### A character the font cannot draw

Substituting the face has a measured cost. Missing the glyph entirely does not:
a custom font maps an unknown code point to `.notdef`, which draws as nothing,
so a save can swallow an emoji and report success. Asking fontkit before writing
is the only way to know.

| option | verdict |
| --- | --- |
| write it and let `.notdef` happen | **rejected** -- silent loss |
| refuse the save | B's behaviour; correct for a vector-only design |
| **send that one text object to pixels** | **ADOPT** for C |

It is the same problem as the eraser -- something operators cannot express --
so it takes the same route, and the same reporting: that text object is no
longer extractable, and the result says so rather than leaving it looking
searchable. Probed with `OK ✅ 📐 done`: both symbols detected as missing, B
refuses, C rasters the one object and carries on. §measurements 16.

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

### Not being able to check is not a pass

The first version caught a failure to read the AcroForm and carried on, which
silently turns *we could not check for a signature* into *there is no
signature*. A document whose form structure is unreadable is exactly the kind
this design must not write.

| option | verdict |
| --- | --- |
| unreadable form ⇒ assume unsigned | **rejected** |
| unreadable form ⇒ refuse, saying why | **ADOPT** |

Inspection also no longer rests on a constructor name alone: each field's `/FT`
is read from the dictionary, and `/SigFlags` on the AcroForm is checked, so a
signature survives a build that names its classes differently. Every page is
walked, not just the first. §measurements 9.

## 9. Failure behaviour

| option | verdict |
| --- | --- |
| drop what cannot be written, return a file | **rejected** |
| stop, naming the object and the reason | **ADOPT** |

§11. A partial save that looks complete is the worst outcome available here,
because nothing downstream can tell it apart from a good one.

The first version of that decision was written but not enforced. Two routes
still produced a finished-looking file with a mark missing: an object type the
writer did not recognise fell through a `return 0`, and an annotation filed
against a page the document does not have was never visited at all, because the
writers loop over source pages rather than over annotations.

| option | verdict |
| --- | --- |
| validate as each object is written | **rejected** -- earlier objects are already in the file |
| validate the whole job before writing anything | **ADOPT** |

The whole set is checked first and a single problem stops all of it, so a
refusal produces no bytes rather than a truncated document. Returning the list
of problems rather than throwing on the first lets the UI show all of them at
once. Nine invalid cases, each refused by all three writers with no output:
unknown object type, invalid measure subtype, NaN in a stroke, NaN in a text
position, opacity outside 0–1, zero line width, page 0, page N+1, fractional
page. §measurements 15.

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

## 12. How large a raster fragment may be

A design that rasterises anything needs a stated ceiling, or it has simply moved
the current save path's memory problem somewhere less visible. The number was
measured on the A0 fixture rather than borrowed from elsewhere in the product.

| fragment | pixels | live RGBA | encode | result |
| --- | --- | --- | --- | --- |
| small | 0.17 Mpx | 0.7 MB | 38 ms | written |
| medium | 1.55 Mpx | 6 MB | 65 ms | written |
| large | 5.89 Mpx | 24 MB | 303 ms | written |
| just under the bound | 7.82 Mpx | 31 MB | 333 ms | written |
| just over the bound | 8.86 Mpx | 35 MB | — | **refused** |
| whole A0 annotation layer | 32.7 Mpx | 131 MB | — | **refused** |

| option | verdict |
| --- | --- |
| no ceiling | **rejected** -- this is the current defect, relocated |
| reuse the 80 Mpx figure another feature uses | **rejected** -- different cost shape, and unmeasured here |
| **8 Mpx per fragment** | **ADOPT** |

8 Mpx is 32 MB of live RGBA and encodes in about a third of a second on this
machine. The cost is smooth right up to it, it is a quarter of what one A0 page
at 2x would take, and it is roughly forty times the largest fragment any
annotation set in this corpus actually produced (0.19 Mpx).

Three things it deliberately is not:

- **not a page bound.** It bounds one fragment. A layer that needs more is
  refused; the source page is never rasterised as a consolation, because that
  would destroy exactly what this design exists to preserve.
- **not a scale-down.** Shrinking the fragment to fit would silently blur the
  user's marks, and they would have no way to know it happened.
- **not checked after allocation.** The arithmetic runs on the bounds; the
  canvas is created only if it passes. Checking afterwards means the allocation
  being guarded against has already happened.

The consequence for candidate A is in section 3: it is the reason A stops being
a candidate.

## Summary

| | |
| --- | --- |
| **ADOPT** | Candidate **C**, the hybrid: source preserved via pdf-lib; the annotation layer planned as an ordered sequence of runs so stacking survives; operators where they work and a bounded transparent raster for the span an eraser reaches into, with conservative painted bounds; coordinates converted **display → upright → PDF**, against the CropBox; measurement labels derived and written as text; a support boundary that refuses signed, encrypted and unreadable sources by name; fail closed and whole. Candidate **A** is *not* retained as a standalone candidate: under the 8 Mpx fragment ceiling its page-sized overlay cannot save an A0 at all. It survives only as the description of C's worst case on pages small enough to fit. |
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

## What the second review changed

| entry | was | now |
| --- | --- | --- |
| 9. failure | fail-closed stated, not enforced | **preflight before any bytes**; 9 invalid cases refused by all three writers |
| 7. font | substitution cost only | a **missing glyph** is detected and rastered, not written as `.notdef` |
| 12. raster | no stated ceiling | **8 Mpx per fragment**, measured, checked before allocation |
| 3. candidates | A retained as a fallback | A **refused on A0** by the ceiling its own design implies |
| 8b. sources | unreadable form ⇒ carry on | unreadable form ⇒ **refuse**; `/FT /Sig` and `/SigFlags` read directly |
| hybrid split | 3 of 10 raster / 7 vector | **4 raster / 6 vector**, in ordered runs |
