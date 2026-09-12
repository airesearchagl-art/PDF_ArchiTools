# The H8 decision

The sub-spike was allowed to end in exactly three states. This is the one it
reached, and what the other two would have meant.

## Outcome: **H8-A for Monochrome, H8-B for Optimize**

A bounded path exists, it is available today with no new dependency, and it
costs Monochrome nothing in single-file capacity. Optimize keeps colour and so
carries a smaller product limit, and the batch limits are smaller again,
because the batch is priced from JSZip's own code with the Blob handoff
overlapping everything it holds.

### Recommended encoder

**An owned image XObject (E3), written by pdf-lib itself**, with the canvas
released before the samples are allocated.

| operation | colour space | filter | encoded size |
| --- | --- | --- | --- |
| モノクロ化 / 両方実行 | `DeviceGray` | `FlateDecode` | ≤ `n + 5·⌈n/16383⌉ + 6` on 1 B/px |
| 最適化 | `DeviceRGB` | **no filter** recommended | **exactly** 3 B/px |
| either, where the size must be known before rendering | as above | none | **exactly** 1 or 3 B/px |

`context.stream` keeps the very array it is handed — `typedArrayFor` returns a
`Uint8Array` unchanged (arrays.js:9-11), `PDFRawStream` assigns it
(PDFRawStream.js:10) — and the gate reads the stored size back from the object
with `getContentsSize()`.

**Why the recommendation now splits on the filter.** Pricing the readback as
live while deflate runs (nothing promises it is collected first) moves
DeviceRGB with `FlateDecode` from 74.9 MiB to **108.1 MiB** per A4 page at
300 dpi, and its peak from the readback to the deflate step. DeviceGray is
unaffected — its samples are a third the size, so the readback still dominates
at 66.4 MiB. So Monochrome keeps `FlateDecode` and its file-size saving for
free; Optimize pays 42 MiB a page for it and should take the raw stream unless
the Human Gate decides the smaller file is worth the higher peak.

### The memory contract

| | |
| --- | --- |
| `MAX_OPERATION_MEMORY` | **512 MiB default**, explicit **1 GiB** and **2 GiB** |
| `MAX_RASTER_PIXELS` | 128 Mi px (134,217,728) + the runtime canvas probe — H9, unchanged |
| `MAX_OUTPUT_BYTES` | 256 MiB, enforced on the finished artifact — unchanged |
| basis of every term | EXACT, SOURCE_DERIVED_BOUND or CONSERVATIVE_BOUND. **No UNKNOWN, no MEASURED_ONLY.** |

**Per page**, A4 at 300 dpi: **66.4 MiB** (8.0 B/px) at the readback for
DeviceGray raw and flate and DeviceRGB raw; **108.1 MiB** (13.0 B/px) at the
deflate step for DeviceRGB with FlateDecode.

**Per file**: every page's stream is held until `save()`, then the output
buffer on top. **Per batch (B2)**: the sources, the accumulated ZIP chunks, the
concatenated archive and the Blob copy are all live at the handoff — so the
ceiling must cover the **job**.

### Boundaries

Single file, inside 512 MiB:

| | A4 @300 | A4 @150 |
| --- | --- | --- |
| **DeviceGray, raw or flate** | **30** (31st refused) | **123** (124th) |
| **DeviceRGB, raw or flate** | **10** (11th) | **41** (42nd) |

B2 batch of one-page A4 @150 files:

| | 512 MiB | 1 GiB | 2 GiB |
| --- | --- | --- | --- |
| **DeviceGray** | **61** (62nd refused) | 123 | 123 |
| **DeviceRGB** | **20** (21st) | 41 | 41 |

Every first-over case at 512 MiB is `OVER_MEMORY_BUDGET`, by name, before any
raster is allocated. At 1 GiB and 2 GiB the numbers stop moving because
`MAX_OUTPUT_BYTES` binds instead: a larger memory preset is not a way to
process more files.

For comparison, the path that blocked H8 allowed **0** pages at 300 dpi and 6
at 150 under its only fail-closed term, and *estimated* 30 and 123 under a
measurement that could not be adopted.

## What the other two outcomes would have been

- **H8-A everywhere** would have required the colour path to match the old
  estimate. It does not: `DeviceRGB` is three bytes per pixel, so Optimize takes
  10 pages at 300 dpi where the estimate implied 30, and 20 files in a 512 MiB
  batch where it implied 123.
- **H8-C, still blocked**, was a live possibility, and two candidates failed
  before E3 worked:
  - **E2**, reusing M4's exact stored-PNG encoder, does not close H8: pdf-lib's
    PNG path decodes and re-expands what the encoder made exact (peak
    132.7 MiB, twice E3's, for a file no smaller).
  - **E4**, jsPDF 3.0.4's bundled `JPEGEncoder`, **does exist** — and is still
    inadmissible, on two independent grounds: no supported path reaches it with
    raw pixels (not exported; only the GIF, BMP and WEBP plugins call it, each
    with an encoded image file), and its output is built in an ordinary JS array
    one byte at a time, so its working memory is the engine's.

## What the Human Gate still decides

1. **H8** — adopt the contract above, with Optimize's smaller limits and the
   batch limits that pricing the whole job produces.
2. **H8-file-size** — whether a larger PDF is an acceptable price, now with a
   second edge: for Optimize, `FlateDecode` also costs 42 MiB of peak per page.
   Measured at 150 dpi on the grey scan: production JPEG **0.3 MiB**, owned
   DeviceGray `FlateDecode` **1.1 MiB**, owned DeviceGray raw **2.1 MiB**.

Neither is adopted here. Both are recorded with the numbers they turn on.

## What this does not decide

H2b/O3 stays deferred. The operation classes, the H7 policy, B2, ownership and
the orchestration were adopted at the M5 gate and are untouched. No production
code changed, and no dependency was added.
