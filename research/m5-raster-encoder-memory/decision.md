# The H8 decision

The sub-spike was allowed to end in exactly three states. This is the one it
reached, and what the other two would have meant.

## Outcome: **H8-A for Monochrome, H8-B for Optimize**

A bounded path exists, it is available today with no new dependency, and it
costs Monochrome nothing in capacity. Optimize keeps colour and therefore
carries a smaller product limit than the old estimate implied.

### Recommended encoder

**An owned image XObject (E3), written by pdf-lib itself.**

| operation | colour space | filter | encoded size |
| --- | --- | --- | --- |
| モノクロ化 / 両方実行 | `DeviceGray` | `FlateDecode` | ≤ DEFLATE's stored-block bound on 1 B/px; typically far less |
| 最適化 | `DeviceRGB` | `FlateDecode` | ≤ the same bound on 3 B/px |
| either, where the size must be known before rendering | as above | none | **exactly** 1 or 3 B/px |

No `canvas.toDataURL`, no base64 string, no PNG encoder, no PNG decoder, no
new dependency. The samples the page already holds are the stream.

### The memory contract

| | |
| --- | --- |
| `MAX_OPERATION_MEMORY` | **512 MiB default**, explicit **1 GiB** and **2 GiB** |
| `MAX_RASTER_PIXELS` | 128 Mi px (134,217,728) + the runtime canvas probe — H9, unchanged |
| `MAX_OUTPUT_BYTES` | 256 MiB, enforced on the finished artifact — unchanged |
| basis of every term | EXACT or SOURCE_DERIVED_BOUND. **No UNKNOWN term, no MEASURED_ONLY term.** |

**Per page** (A4 at 300 dpi, 2480 × 3508): canvas 4·W·H, readback 4·W·H,
samples 1 or 3 B/px, stream retained until save. Peak **66.4 MiB**, at the
readback — the encoding step is not the expensive part of the operation any
more, and is not visible in the peak at all.

**Multi-page**: every page's stream is held until `save()`, then the whole
output buffer on top of it. **Batch (B2)**: every output is held until the
archive, so the ceiling must cover the **job**, not the largest file.

### Boundaries, inside 512 MiB

| | A4 @300 | A4 @150 | one-page files, B2 batch @150 |
| --- | --- | --- | --- |
| **DeviceGray (Monochrome)** | **30** (31st refused) | **123** (124th) | **123** (124th) |
| **DeviceRGB (Optimize)** | **10** (11th) | **41** (42nd) | **41** (42nd) |

Every refusal is `OVER_MEMORY_BUDGET`, by name, before any raster is allocated.

For the same page, the path that blocked H8 allowed **0** pages at 300 dpi and
6 at 150 under its only fail-closed term, and *estimated* 30 and 123 under a
measurement that could not be adopted. The owned grey path delivers that
estimate's capacity with none of its uncertainty.

## What the other two outcomes would have been

- **H8-A everywhere** would have required the colour path to match the old
  estimate too. It does not: `DeviceRGB` is three bytes per pixel, so Optimize
  takes 10 pages at 300 dpi where the estimate implied 30. That limit is
  reported as what it is rather than softened.
- **H8-C, still blocked**, was the outcome if no owned path existed. It was a
  live possibility: the obvious candidate — reusing M4's exact stored-PNG
  encoder — **does not work**, because pdf-lib's PNG embedding decodes and
  re-expands what the encoder carefully made exact (peak 132.7 MiB, twice E3's,
  for a file no smaller). E3 exists only because pdf-lib will also write a
  stream without touching it.

## What the Human Gate still decides

1. **H8** — adopt the contract above, with Optimize's smaller limit.
2. **H8-file-size** — whether a larger PDF is an acceptable price. Measured at
   150 dpi on the grey scan: production JPEG **0.3 MiB**, owned DeviceGray with
   `FlateDecode` **1.1 MiB**, owned DeviceGray raw **2.1 MiB**. `FlateDecode`
   keeps the guarantee and most of the size; raw keeps the size exact before
   the page is rendered.

Neither is adopted here. Both are recorded with the numbers they turn on.

## What this does not decide

H2b/O3 stays deferred. The operation classes, the H7 policy, B2, ownership and
the orchestration were adopted at the M5 gate and are untouched. No production
code changed.
