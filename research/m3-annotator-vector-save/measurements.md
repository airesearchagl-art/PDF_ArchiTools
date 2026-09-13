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
| `unreadable-form.pdf` | **refused** — `form-unreadable` | refused before anything is written |
| `features.pdf` (2 ordinary form fields) | supported | 1,117,436 bytes |

Every candidate re-serialises the document, which invalidates a signature over
it. Producing that file and reporting success is the worst kind of preservation
failure: the document still looks signed and is not.

`damaged.pdf` needed more than a successful `load`. pdf-lib parsed it far enough
to return a document, and the save then failed in the middle with
`Cannot read properties of undefined` — the worst place to find out and the
least useful thing to say. The assessment now walks every page and reads its
boxes before anything is produced, and refuses with a reason.

### Not being able to check is not a pass

The first version of this assessment wrapped the form inspection in
`catch { /* a form we cannot read is not evidence of a signature */ }` and
carried on. The comment was true and the behaviour was the opposite of it: a
document whose AcroForm cannot be read came back **supported**, which converts
*we could not check* into *there is nothing to check*.

| | before | now |
| --- | --- | --- |
| form inspection throws | swallowed, document accepted | **refused**, `form-unreadable` |
| how a signature is recognised | constructor name only | constructor name, **`/FT /Sig` from the dictionary**, and **`/SigFlags`** |
| pages inspected | first | **every page** |

Reading `/FT` directly matters because a constructor name is a property of the
library build, not of the document: a field that pdf-lib does not classify as a
signature is still a signature if its dictionary says `/Sig`. `/SigFlags` on the
AcroForm catches a document that declares signatures without an intact field
list.

The refusal names the document rather than an internal property:

```
このPDFのフォーム情報を読み取れなかったため、電子署名の有無を確認できませんでした。
確認できない状態では保存しません。
```

A document with an ordinary AcroForm is still accepted — `features.pdf`, two
form fields, saves normally — so this is not a blanket refusal of forms.

### The path needed a document that actually fires it

The first version of this evidence did not have one. The probe read
`signed.pdf`'s refusal code and accepted any of `form-unreadable`, `signed`,
`unreadable` or `encrypted` — and `signed.pdf` returns `signed`, so the check
passed without the form-unreadable path ever running. Code with no document to
exercise it is not evidence that the code works.

`unreadable-form.pdf` is built for it, and has to satisfy three conditions in
order:

| | must |
| --- | --- |
| `PDFDocument.load` | **succeed** — otherwise it refuses as `unreadable` and proves nothing |
| walking every page's boxes | **succeed** — same |
| inspecting the AcroForm | **fail** — the condition under test |

An `/AcroForm` whose `/Fields` array holds a number instead of a field
dictionary does exactly that: the file parses, the page tree is intact, and
pdf-lib throws `Expected instance of PDFDict, but got instance of PDFNumber` the
moment anything walks the fields.

| | result |
| --- | --- |
| `assessSource` | `supported: false`, `code: form-unreadable` |
| the page-readable check | passes — this is not the damaged path in disguise |
| `saveHybrid` | **refused, no output bytes** |
| the message | 電子署名の有無を確認できないため保存しない旨。raw exception ではない |

The four boundary conditions now fire on four different documents —
`signed` / `unreadable` / `form-unreadable`, against two accepted controls — so
none of them is standing in for another.

**The gate was checked against itself here.** Restoring the old
`catch { /* swallow */ }` makes this probe fail.

Making it fail closed had an immediate benefit beyond the measurement: the
`catch {}` had also been swallowing a real `ReferenceError` in the inspection
code, which surfaced the moment the swallow was removed. A silent catch hides
its own bugs as readily as the document's.

**Encryption is unmeasured.** The refusal path exists in the code; nothing in
the dependency set can write an encrypted PDF to test it against.

## 10. The largest sheet

`a0.pdf`, one 2384x3370pt page. What each candidate has to hold in memory at
once, at the 2x scale the design uses:

| | largest raster | live RGBA | runtime | output |
| --- | --- | --- | --- | --- |
| baseline (today) | 32.14 Mpx | 129 MB | 428 ms | 441 KB |
| A, whole-page overlay | 32.14 Mpx needed | 129 MB | — | **refused** |
| B, vector only | — | — | — | refused (pixel eraser) |
| C, hybrid | **0.19 Mpx** | 0.8 MB | 44 ms | 1114 KB |

A's refusal is new, and it is the fragment ceiling of section 12 applied to A's
own design rather than a failure of the measurement:

```
ページ 1 の注釈を画像化するには 32.1 メガピクセル（4768x6741）が必要で、
上限の 8.0 メガピクセルを超えます。
```

A's overlay is the size of the page by construction, so on the largest sheet the
bound the architecture requires refuses the architecture's own fallback. C needs
166x fewer pixels for the same annotations on the same page, because it
rasterises the span an eraser reaches and nothing else.

This is reported rather than engineered around. Raising the bound to admit it
means admitting 129 MB of live RGBA — the cost this spike exists to stop paying.
Falling back to a whole-page raster would destroy the vector source. Scaling
down would blur the marks silently. The honest consequence is that A is not a
candidate; see decision-matrix section 3.

The baseline's number is the one to sit with: it pays 129 MB on every save
today, and produces the smallest file, because it has thrown the drawing away.

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

## 15. Annotations a save refuses rather than skips

Fail-closed was stated in the first revision and not enforced. Two routes still
returned a finished-looking file with a mark missing:

- an object type the writer did not recognise hit a `return 0` and contributed
  nothing;
- an annotation filed against a page the document does not have was never
  looked at, because both writers loop over *source pages* rather than over
  annotations.

Neither is detectable downstream. The whole job is now checked before a single
operator is written, and one problem stops all of it.

| case | what the refusal says | overlay | vector | hybrid |
| --- | --- | --- | --- | --- |
| unknown object type (`sticker`) | 未対応の注釈の種類です | refused | refused | refused |
| invalid measure subtype (`volume`) | 未対応の計測の種類です | refused | refused | refused |
| NaN in a stroke point | 線の座標に数値でない値があります | refused | refused | refused |
| NaN in a text position | 文字の座標に数値でない値があります | refused | refused | refused |
| opacity 4 | 不透明度が 0 から 1 の数値ではありません | refused | refused | refused |
| line width 0 | 線幅が正の数値ではありません | refused | refused | refused |
| page 0 | この文書に 0 ページ目はありません | refused | refused | refused |
| page N+1 | この文書に 4 ページ目はありません（全 3 ページ） | refused | refused | refused |
| fractional page (2.5) | ページ番号が整数ではありません | refused | refused | refused |

**Output bytes in every one of those rows: none.** A refusal that had already
written half a document would be no better than the silent drop.

The control matters as much as the nine: a valid job still goes through, at
1113779 B (overlay) and 1107201 B (vector, hybrid). A preflight that refuses
everything would pass all nine probes and be useless.

## 16. A character the embedded font cannot draw

Section 8 measures what substituting the *face* costs. Missing the glyph
entirely is a different failure: a custom font maps an unknown code point to
`.notdef`, which draws as nothing, so the save reports success and the character
is gone. Nothing in the output distinguishes it from a character the user never
typed.

Probed with `OK ✅ 📐 done` in the embedded document font:

| | result |
| --- | --- |
| glyphs detected as missing | `✅` `📐` |
| B, vector only | **refused** — この保存方式では表現できない注釈があります |
| C, hybrid | writes the file; that one text object goes to pixels |
| is the rastered text still extractable? | **no**, and the result says so |

C's answer is the eraser's answer: something operators cannot express goes to
pixels, scoped to the one object, and the loss of searchability is reported
rather than hidden. Nothing depends on what was drawn before a text object, so
this needs no run closure — unlike an eraser.

Where the question cannot be asked at all — a font object that does not expose
`hasGlyphForCodePoint` — every non-space character is reported as unsupported.
Not knowing is not evidence of coverage.

## 17. How large a raster fragment may be

Any design that rasterises needs a stated ceiling or it has just moved today's
memory problem somewhere less visible. Measured on the A0 fixture, at the 2x
scale the design uses, rather than borrowed from another feature:

| fragment | predicted pixels | live RGBA | wall time | result |
| --- | --- | --- | --- | --- |
| small (200x150pt) | 0.17 Mpx | 0.7 MB | 38 ms | written |
| medium (700x500pt) | 1.55 Mpx | 6.2 MB | 65 ms | written |
| large (1400x1000pt) | 5.89 Mpx | 24 MB | 303 ms | written |
| near the bound (1980x1420pt) | 7.82 Mpx | 31 MB | 333 ms | written |
| over the bound (2300x1700pt) | 8.86 Mpx | 35 MB | — | **refused** |
| whole A0 layer (2380x3360pt) | 32.68 Mpx | 131 MB | — | **refused** |

The cost is smooth: roughly four bytes of live canvas per pixel, with the PNG
encode dominating the runtime. There is no knee to find — the curve stays smooth
right up to the point where the allocation is itself the problem. So the bound
is a judgement about how much memory one save may claim, not a discovered
threshold, and it is written down as such.

**MAX_RASTER_PIXELS = 8,000,000.** 32 MB of live RGBA, a third of a second to
encode, a quarter of what one A0 page at 2x costs, and about forty times the
largest fragment any annotation set in this corpus actually produced.

The check runs on the arithmetic:

```
calculate the painted bounds of the run
  -> multiply by the render scale
  -> compare with MAX_RASTER_PIXELS
  -> over: throw, naming page and size, before any canvas exists
```

Ordering is the point. Checking after `canvas.width = ...` means the allocation
being guarded against has already happened. Verified on the arithmetic alone,
to the pixel:

| | result |
| --- | --- |
| `MAX_RASTER_PIXELS - 1` | accepted |
| `MAX_RASTER_PIXELS` exactly | **accepted** — the bound is inclusive, and says so |
| `MAX_RASTER_PIXELS + 1` | **refused** |

A bound only ever tested from below is not a bound, and one tested only at
±40,000 does not say where the line is.

The refusal names the page and the size the fragment would have needed —
`page 1, 3460x2560` — because "too large" with no number is not actionable.

Three behaviours deliberately absent, each of which would make the ceiling
meaningless:

- **no fallback to rasterising the source page.** That destroys exactly what is
  being preserved.
- **no silent scale-down.** The user's marks would come back blurrier with
  nothing to tell them.
- **no post-allocation check.** See above.

The consequence for candidate A is section 10.

## 18. The page key a job is validated under

Section 15's preflight closed the silent-drop path and left one open, in the
same shape.

Preflight resolved a page key with `Number(key)`. The writers resolved one with
`objects[i + 1]`, which stringifies. Those two agree on `"2"` and disagree on
every other spelling of the same number:

| key | `Number(key)` | integer? | in range? | preflight | what `objects[2]` finds |
| --- | --- | --- | --- | --- | --- |
| `"2"` | 2 | yes | yes | pass | the annotation |
| `"02"` | 2 | yes | yes | **pass** | **nothing** |
| `"2e0"` | 2 | yes | yes | **pass** | **nothing** |
| `"+2"` | 2 | yes | yes | **pass** | **nothing** |
| `" 2"` | 2 | yes | yes | **pass** | **nothing** |

A job validated against page 2 and written against no page. The file comes back
complete, the preflight comes back clean, and the mark is gone — which is
exactly what section 15 exists to prevent.

Fixing it as a stricter key check alone would leave the second seam: whatever
the caller mutates between the check and the write is what gets written, so the
bytes would correspond to no validated state.

Both are closed at one boundary. `prepareSaveJob()` validates, requires each key
to be the canonical decimal form of its own number, resolves keys once into a
`Map` keyed by number, deep-copies the annotations, and returns a frozen job.
Writers take the job and never see the caller's object.

| | result |
| --- | --- |
| `"02"`, `"2e0"`, `"+2"`, `" 2"` | **refused**, no output bytes |
| `"2"` (control) | saved, 1107202 bytes, 12 operators — the mark reaches the page |
| caller mutates a field after the check | snapshot line width 4, caller's 999 |
| caller pushes an object in afterwards | snapshot holds 1, caller holds 2 |
| caller adds a whole page afterwards | not in the snapshot |
| a save racing a mutation | **refused**, no bytes |

The last row is one of the two outcomes the design permits — write the validated
snapshot, or detect the mutation and refuse. What it must never do is write
content that was never validated, and it does not.

Normalising `"02"` to page 2 would close the identity gap just as well. Refusing
is chosen for the MVP because a caller emitting `"02"` has a bug, and accepting
it quietly hides that.

**The gate was checked against itself here.** Reverting the canonical-key check
makes all four probes fail with `IT PRODUCED 1107202 BYTES` — a saved file with
the annotation dropped, which is the defect in its original form.

## 19. The gate

`scripts/research-m3-gate.mjs` re-asserts **165 claims, 56 of them negative
probes** — including the unusual one that the current save path must *fail*
preservation. A comparison in which every candidate passes proves nothing about
any of them.
