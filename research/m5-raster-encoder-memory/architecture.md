# The proposed encoding path, and the memory contract it makes possible

Numbers: the sub-spike gate, local run on this branch, `evidence.json`.
Nothing here is adopted; `src/` is unchanged.

## 1. Why H8 was blocked

The flattening operations render a page to a canvas and then leave the
architecture entirely:

```text
canvas → toDataURL('image/jpeg', 0.8) → base64 string → pdf-lib embedJpg → PDF
                  ^^^^^^^^^^^^^^^^^^
                  not ours: size unknown, scratch unbounded
```

Two facts follow, and neither is fixable by measuring more carefully:

- the encoded size can only be *observed*. A finite sweep of fixtures is
  performance evidence, not a bound. The only fail-closed statement available
  is the JPEG format's own worst case, **20 B/px** (ITU-T T.81: per 8×8 block
  a DC coefficient of ≤ 27 bits and 63 ACs of ≤ 26 bits, doubled by 0xFF byte
  stuffing, three blocks per 64 pixels);
- the encoder's internal working memory is bounded by nothing at all. It is an
  **UNKNOWN** term, and an unknown term is not a small term.

Under the fail-closed term, 512 MiB holds **no** A4 page at 300 dpi. Under the
measured one it holds 30 — but that number could never be adopted. That gap is
what blocked H8.

## 2. The candidates

| | what it is | owned? |
| --- | --- | --- |
| **E1** | `canvas.toDataURL('image/jpeg', 0.8)` → base64 → `embedJpg` (production) | no |
| **E2** | M4's stored-PNG encoder → `embedPng` | encoder yes, embedding no |
| **E3** | the samples written straight into an image XObject | **yes, end to end** |
| **E4** | a bounded JPEG from the pinned dependencies | **does not exist** |

**E4 is rejected on a fact.** `package.json` pins `pdf-lib`, `jspdf`,
`pdfjs-dist`, `jszip`, `tesseract.js` and React. pdf-lib *parses* JPEG
(`JpegEmbedder`), pdfjs-dist *decodes* it, jsPDF *embeds* it — none writes one.
Adopting or writing an encoder is a dependency decision for a Human Gate, and
bounding an unowned encoder is exactly what failed already.

**E2 does not close H8 either**, and the reason is worth stating precisely,
because reusing M4's encoder was the obvious first idea. The encoder is owned
and its output exact — `pngStoredSize`, verified against production here to the
byte at three sizes. The *embedding* is not. pdf-lib's PNG path
(`PngEmbedder` → `utils/png.js` → `@pdf-lib/upng`) copies the PNG, inflates it,
expands it to RGBA (`UPNG.js:48`, `new Uint8Array(area * 4)`), copies that
frame again (`png.js:48`), splits it into a 3 B/px `rgbChannel` and a 1 B/px
`alphaChannel` (`png.js:21-22`), and only then deflates. The exactness bought
by owning the encoder is spent before the bytes reach the document: **132.7 MiB
peak for one A4 page at 300 dpi**, against E3's 66.4 MiB, for a file no
smaller.

## 3. E3 — an image XObject this architecture owns

pdf-lib will write a stream exactly as handed to it:

```js
const dict = { Type: 'XObject', Subtype: 'Image', Width, Height,
               BitsPerComponent: 8, ColorSpace: 'DeviceGray' };   // or DeviceRGB
const ref = doc.context.register(doc.context.stream(samples, dict));   // no filter
const name = page.node.newXObject('Img', ref);
page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0),
                   drawObject(name), popGraphicsState());
```

There is no encoder and no decoder in that path. The stream **is** the samples:

| | per pixel | basis |
| --- | --- | --- |
| DeviceGray, no filter | **1 B** | exact, known before the page is rendered |
| DeviceRGB, no filter | **3 B** | exact |
| either, `flateStream` | ≤ the same, and typically far less | source-derived: DEFLATE's stored-block worst case, which no conforming deflater can exceed |

Monochrome's output is grey, so it is a `DeviceGray` document — a quarter of
the RGBA PNG and a third of the RGB stream, exactly.

## 4. The lifetime, term by term

One page, in the order the operation performs it. `Live` is what is held at
once; the peak is the largest row.

| step | live | basis of the new term |
| --- | --- | --- |
| render | canvas 4·W·H | EXACT |
| readback | canvas + ImageData 4·W·H | EXACT |
| convert | readback + samples (1 or 3 B/px) | EXACT |
| embed | samples (`stream`), or samples + deflated (`flateStream`) | EXACT / SOURCE_DERIVED_BOUND |
| retain until save | one stream per page | EXACT |
| save | every retained stream + the whole output buffer | EXACT, + conservative overhead |
| publish | output × 2 (the Blob copy) | CONSERVATIVE_BOUND |

**The peak is the readback — 8 B/px — for every E3 variant**: 66.4 MiB for one
A4 page at 300 dpi, grey or colour, raw or deflated. The encoding step is no
longer the expensive part of the operation; it is no longer even visible in the
peak.

For comparison, on the same page: E1 peaks at **553.0 MiB** under the format
bound (at `embed`, where the data URL, the decoded JPEG and the embedder's copy
are all live) and at 66.4 MiB under the measured estimate — which cannot be
adopted; E2 peaks at **132.7 MiB** at `decode`.

## 5. The rule that decides admissibility

```text
an adopted memory contract may contain no UNKNOWN term, and no term whose only
basis is a measurement
```

Applied mechanically by `admissibleForHardContract`, not argued case by case:

| candidate | admissible | why not |
| --- | --- | --- |
| E1, format bound | **no** | the encoder's working memory is UNKNOWN |
| E1, measured estimate | **no** | that, and the size is MEASURED_ONLY |
| E2, E3 (all variants) | **yes** | every term exact or source-derived |

This is also why the spike does not report a "tighter" JPEG bound: a smaller
number with the same basis is the same unadoptable thing.

## 6. The ceilings, unchanged and independent

H9 stays exactly as adopted. Three ceilings, checked in order, each independent
— the gate probes each in isolation, with the other two unbounded:

| ceiling | value | enforced on |
| --- | --- | --- |
| `MAX_RASTER_PIXELS` | 128 Mi px (134,217,728) + a runtime canvas probe | the page's pixel count |
| `MAX_OPERATION_MEMORY` | 512 MiB default, explicit 1 / 2 GiB | the modelled peak |
| `MAX_OUTPUT_BYTES` | 256 MiB | the finished artifact, whose size is measured |

A larger memory preset buys past neither of the others: A1 at 600 dpi stays
`OVER_RASTER_LIMIT` at every preset and with memory unbounded, and A0 at 300
dpi stays refused at 2 GiB. The canvas probe remains, because the ceiling is a
portable *policy* below what one machine refused (A1 at 300 dpi, 70 Mpx,
allocates here; A1 at 600, 279 Mpx, does not).

## 7. What the contract costs the product

Inside the 512 MiB default:

| | A4 @300 | A4 @150 | one-page files in a B2 batch @150 |
| --- | --- | --- | --- |
| E1, fail-closed | **0 pages** | 6 | 6 |
| E1, measured estimate (unadoptable) | 30 | 123 | 123 |
| E2 | 10 | 41 | 41 |
| **E3 DeviceGray (Monochrome)** | **30** | **123** | **123** |
| **E3 DeviceRGB (Optimize)** | **10** | **41** | **41** |

So the grey path gives back exactly the capacity the estimate promised, with
every term exact — **H8-A** for Monochrome. Optimize keeps colour and carries a
third of it — **H8-B**: a smaller product limit, honestly bounded, and not to
be traded back for a weaker guarantee.

## 8. What it costs the drawing: nothing the encoder was responsible for

Judged at 300 dpi against the source rendered the same way:

| content | production JPEG | owned lossless |
| --- | --- | --- |
| drawing with dimension strings @300 | ink kept 89.7%, PSNR 28.4 dB | 89.7%, 28.4 dB |
| 1 px linework @300 | 76.3%, 19.5 dB | 76.5%, 19.5 dB |
| 1 px linework @150 | — | **3.5%** |

At a given resolution the encoder choice is very nearly invisible. What
destroys linework is the resolution, which is H2b's problem and stays deferred.

## 9. The batch

Under the adopted B2 policy every successful output is held until the archive
is built, so the batch ceiling is the whole job, not the largest file:
`held = Σ outputs`, then the archive on top of it. The gate prices it per
candidate; the recommendation is one **job** ceiling covering both, since a
per-file ceiling cannot see the accumulation that actually fails.

## 10. What this does not decide

The encoding path only. H2b/O3 stays deferred; the operation classes, the H7
policy, B2, ownership and the orchestration were adopted and are untouched;
and whether a larger PDF is an acceptable price for an exact contract is the
second Human decision this spike leaves open.
