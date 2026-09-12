# The H8 decision

The sub-spike was allowed to end in exactly three states. This is the one it
reached, and what the other two would have meant.

## Outcome: **H8-A for Monochrome, H8-B for Optimize**

A bounded path exists, it is available today with no new dependency, and it
costs Monochrome nothing in single-file capacity. Optimize keeps colour and so
carries a smaller product limit, and every batch limit is smaller than the
first round claimed, because the batch is now priced from JSZip's own code.

### Recommended encoder

**An owned image XObject (E3), written by pdf-lib itself**, with the canvas
released before the samples are allocated.

| operation | colour space | filter | encoded size |
| --- | --- | --- | --- |
| モノクロ化 / 両方実行 | `DeviceGray` | `FlateDecode` | ≤ `n + 5·⌈n/16384⌉ + 6` on 1 B/px, derived from pako 1.0.11 |
| 最適化 | `DeviceRGB` | `FlateDecode` | ≤ the same bound on 3 B/px |
| either, where the size must be known before rendering | as above | none | **exactly** 1 or 3 B/px |

No `canvas.toDataURL`, no base64, no PNG encoder, no PNG decoder, no new
dependency. `context.stream` keeps the very array it is handed — verified, not
assumed: `typedArrayFor` returns a `Uint8Array` unchanged (arrays.js:9-11) and
`PDFRawStream` assigns it (PDFRawStream.js:10), and the gate reads the stored
size back from the object with `getContentsSize()`.

**FlateDecode stays inside the hard contract.** Every one of pako's
allocations is now a term with a source: the fixed deflate state is 262,144 B
(window 65,536 + head 65,536 + prev 65,536 + pending_buf 65,536, deflate.js:
1376-1389), the output chunks each pin a full 16 KiB buffer because `shrinkBuf`
returns a subarray without copying (common.js:34-38), and `flattenChunks`
allocates the result while those chunks are still live (common.js:54-72).

### The ordering is part of the contract, not an implementation detail

`getImageData` needs the canvas; nothing after it does. Releasing the canvas
the moment the readback exists is worth, measured on A4 at 300 dpi in
DeviceRGB:

| | live at conversion | page peak |
| --- | --- | --- |
| canvas held to the end (the first prototype) | 91.2 MiB — **11.0 B/px** | 91.2 MiB |
| canvas released first | 58.1 MiB — **7.0 B/px** | **66.4 MiB** (the readback) |

The model predicts both exactly. An implementation that forgets the release
does not get this contract's numbers.

### The memory contract

| | |
| --- | --- |
| `MAX_OPERATION_MEMORY` | **512 MiB default**, explicit **1 GiB** and **2 GiB** |
| `MAX_RASTER_PIXELS` | 128 Mi px (134,217,728) + the runtime canvas probe — H9, unchanged |
| `MAX_OUTPUT_BYTES` | 256 MiB, enforced on the finished artifact — unchanged |
| basis of every term | EXACT or SOURCE_DERIVED_BOUND. **No UNKNOWN, no MEASURED_ONLY.** |

**Per page**, A4 at 300 dpi: peak **66.4 MiB** (8.0 B/px) at the readback for
DeviceGray raw and flate and for DeviceRGB raw; **74.9 MiB** (9.0 B/px) for
DeviceRGB with FlateDecode, where the deflate step is the peak instead.

**Per file**: every page's stream is held until `save()`, then the output
buffer on top. **Per batch (B2)**: every output PDF is held as a ZIP source,
JSZip accumulates every emitted chunk in `dataArray`, and `concat` allocates
the whole archive while that array is still live — so the ceiling must cover
the **job**.

### Boundaries

Single file, inside 512 MiB:

| | A4 @300 | A4 @150 |
| --- | --- | --- |
| **DeviceGray, raw or flate** | **30** (31st refused) | **123** (124th) |
| **DeviceRGB, raw or flate** | **10** (11th) | **41** (42nd) |

B2 batch of one-page A4 @150 files:

| | 512 MiB | 1 GiB | 2 GiB |
| --- | --- | --- | --- |
| **DeviceGray** | **82** (83rd refused) | 123 | 123 |
| **DeviceRGB** | **27** (28th) | 41 | 41 |

Every first-over case at 512 MiB is `OVER_MEMORY_BUDGET`, by name, before any
raster is allocated. At 1 GiB and 2 GiB the numbers stop moving because
`MAX_OUTPUT_BYTES` binds instead: a larger memory preset is not a way to
process more files.

For comparison, the path that blocked H8 allowed **0** pages at 300 dpi and 6
at 150 under its only fail-closed term, and *estimated* 30 and 123 under a
measurement that could not be adopted. The owned grey path delivers that
estimate's single-file capacity with none of its uncertainty.

## What the other two outcomes would have been

- **H8-A everywhere** would have required the colour path to match the old
  estimate too. It does not: `DeviceRGB` is three bytes per pixel, so Optimize
  takes 10 pages at 300 dpi where the estimate implied 30. That limit is
  reported as what it is rather than softened.
- **H8-C, still blocked**, was a live possibility, and two candidates failed
  before E3 worked:
  - **E2**, reusing M4's exact stored-PNG encoder, does not close H8: pdf-lib's
    PNG path decodes and re-expands what the encoder carefully made exact
    (peak 132.7 MiB, twice E3's, for a file no smaller).
  - **E4**, jsPDF 3.0.4's bundled `JPEGEncoder`, **does exist** — and is still
    inadmissible, on two independent grounds: no supported path reaches it with
    raw pixels (it is not exported, and only the GIF, BMP and WEBP plugins call
    it, each with an encoded image file), and its output is built in an
    ordinary JS array one byte at a time, so its working memory is the engine's.

## What the Human Gate still decides

1. **H8** — adopt the contract above, with Optimize's smaller limit and the
   batch limits that pricing the whole job produces.
2. **H8-file-size** — whether a larger PDF is an acceptable price. Measured at
   150 dpi on the grey scan: production JPEG **0.3 MiB**, owned DeviceGray with
   `FlateDecode` **1.1 MiB**, owned DeviceGray raw **2.1 MiB**.

Neither is adopted here. Both are recorded with the numbers they turn on.

## What this does not decide

H2b/O3 stays deferred. The operation classes, the H7 policy, B2, ownership and
the orchestration were adopted at the M5 gate and are untouched. No production
code changed, and no dependency was added.
