# M4 baseline — what the comparator does today

Measured against `main` at `44cb82db7365e436c642f375852f22990c45a6ce`, driving the
production `src/utils/pdfDiff.ts` in a browser. Everything on this page is
**Observed** unless a line says otherwise.

The comparator works. On two revisions of the same sheet it finds the wall that
moved, and it finds it quickly. The problem is not that it fails — it is that it
does not have a way of failing. There is no input it declines, so every answer
looks like an answer.

## What it does

```
each PDF rendered on its own terms, at scale = dpi / 72
   -> canvas per document
   -> maxW = max(widths), maxH = max(heights)
   -> each canvas drawn at (0,0) on a white field of that size
   -> computeMultiPdfComposite()
   -> JPEG at quality 0.85
   -> jsPDF page sized maxW/scale x maxH/scale
```

No geometry is examined at any point. `PdfComparator.tsx:311-350`.

## The controls

A comparison that could not see a real change would make every number below
meaningless, so these come first. `changeRatio` is the share of the composite's
ink painted in a layer colour rather than the matched colour — the part the tool
is calling a change.

| | change |
| --- | --- |
| the same drawing twice | **0.0%** |
| a wall added | **9.6%** |
| a wall removed | **10.7%** |
| the whole drawing shifted 2pt | **33.8%** |

It works.

## The same drawing, reported as changed

Every row here is one drawing compared against **the same drawing**, differing
only in how the page is described.

| | change | what actually differs |
| --- | --- | --- |
| A4 vs A3 | **99.4%** | the sheet size |
| A4 vs A1 | **99.8%** | the sheet size |
| portrait vs landscape | **99.3%** | the orientation |
| A4 vs a sheet 3pt bigger | **75.9%** | one millimetre of paper |
| A4 vs the same proportions at 1.4× | **99.4%** | the scale |
| `/Rotate 0` vs `90` | **99.3%** | a number in the page dictionary |
| `/Rotate 0` vs `180` | **65.1%** | a number in the page dictionary |
| `/Rotate 0` vs `270` | **99.2%** | a number in the page dictionary |

A real revision scores 9.6%. Comparing the same drawing across two paper sizes
scores 99.4%. **A user cannot tell those apart**, and the second is the one that
looks more urgent.

The 3pt row is the uncomfortable one: 75.9% of a drawing reported as changed
because two generators disagree about A4 by a millimetre.

## The same drawing, reported correctly

Not everything is broken, and saying so matters:

| | change | why |
| --- | --- | --- |
| CropBox origin (0,0) vs (50,70), same visible region | **0.0%** | PDF.js renders from each page's own origin, so the crop origin is already removed before the comparator sees it |
| MediaBox larger, same CropBox | **0.0%** | same reason |

Crop handling needs no work. Rotation and sheet size do.

## Rotation is arithmetic

Rendering the same four pages with `getViewport({ rotation: 0 })` instead of the
page's own rotation:

| | canvases | ink differing |
| --- | --- | --- |
| `/Rotate 0` vs `90` | both 1241×1754 | **0.0%** |
| `/Rotate 0` vs `180` | both 1241×1754 | **0.0%** |
| `/Rotate 0` vs `270` | both 1241×1754 | **0.0%** |

The entire rotation problem is one argument that is not being passed. It needs
no policy, no human, and no alignment.

## A page one document does not have

Comparing page 3 of a three-page document with a two-page one:

| | |
| --- | --- |
| output produced | **yes** |
| members in it | **1 of 2** |
| what the user is told | **nothing** |

`PdfComparator.tsx:316` — `if (!pdf || p > pdf.numPages) continue;`. The page is
added to the comparison PDF from whatever is left.

A page that exists and is blank is a different statement from a page that does
not exist, and today both arrive as a page in the report with nothing to
distinguish them.

## A member that fails to render

`PdfComparator.tsx:326-328` catches a render error per layer, logs
`Skipping page ...`, and continues with the others.

| | |
| --- | --- |
| output produced | **yes** |
| members in it | **1 of 2** |
| what it looks like | **100.0% changed** |

That last number is worse than expected before measuring it. With one layer
left, no ink has anything to match against, so **every mark on the drawing is
painted as a change**. A failed render produces a comparison that says the
entire sheet was revised — against 9.6% when both members render.

## A requested DPI, and the one delivered

`PdfComparator.tsx:271-272` caps at `MAX_DIM = 12000` and `MAX_AREA = 80000000`,
reducing the scale and writing a `console.warn`.

| sheet | asked | delivered | pixels |
| --- | --- | --- | --- |
| A4 | 600 dpi | 600 dpi | 34.8 Mpx |
| A3 | 600 dpi | 600 dpi | 69.6 Mpx |
| A1 | 600 dpi | **321 dpi** | 80.0 Mpx |
| A0 | 300 dpi | **227 dpi** | 80.0 Mpx |
| A0 | 600 dpi | **227 dpi** | 80.0 Mpx |

The file is still named `comparison_<name>_600dpi.pdf` (`PdfComparator.tsx:389`).
**The filename asserts a resolution the cap removed**, and nothing else in the
output records that it happened. An A0 requested at 600 dpi and at 300 dpi
produce byte-comparable output at the same 227 dpi.

## What a comparison costs

Two layers, threshold 0, measured:

| | canvas | total | composite | working set |
| --- | --- | --- | --- | --- |
| A4 150 dpi | 1240×1754 | 88 ms | 25 ms | 61 MB |
| A3 150 dpi | 1753×2480 | 183 ms | 73 ms | 122 MB |
| A1 150 dpi | 3507×4966 | 628 ms | 251 ms | 488 MB |

The working set is not one canvas. Every layer's RGBA is held at once, plus a
normalising canvas, plus the composite, plus the encoder — about **5 canvases
for a two-layer comparison**, which is why the Annotator's 8 Mpx per-fragment
ceiling does not transfer.

A neighbourhood threshold costs roughly twice an exact one (25 ms → 48 ms at
radius 2). It does **not** grow with the area of the box: radius 4 measured
55 ms against radius 2's 48 ms, where the box is 3.2× larger. `hasNeighborInAny`
returns as soon as it finds ink, so a wider search finds a match sooner on a
drawing where most marks do match. The worst case is a drawing where they do
not — which is the case the tool exists for.

## The threshold means different things at different resolutions

The threshold is a pixel radius:

| dpi | `threshold = 2` means |
| --- | --- |
| 72 | 0.706 mm |
| 150 | 0.339 mm |
| 300 | 0.169 mm |
| 600 | 0.085 mm |

A tolerance calibrated at 150 dpi is a quarter of that tolerance at 600.

## Two functions disagree about what ink is

`computeMultiPdfComposite` uses the **mean** of the channels
(`pdfDiff.ts:57-60`). `detectChangeBounds` uses **any** channel
(`pdfDiff.ts:190-193`). Measured:

| | rgb | composite | change bounds |
| --- | --- | --- | --- |
| black | 0,0,0 | ink | ink |
| mid grey | 140,140,140 | ink | ink |
| CAD cyan | 0,158,217 | ink | ink |
| CAD yellow | 255,225,0 | ink | ink |
| **pale yellow** | **255,255,140** | **not ink** | **ink** |
| pale grey | 210,210,210 | not ink | not ink |
| white | 255,255,255 | not ink | not ink |

A pale yellow line is painted as a change by one function and left out of the
reported change area by the other. Neither is wrong on its own; they are not the
same test.

A pale grey hatch (210,210,210) is invisible to both, so a hatch change is not
detected at all.

## Determinism

The same comparison twice: 8530 change pixels both times, identical bounds.

## What was not measured

Listed in `limitations.md`, not glossed here.
