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

The encoded size can only be *observed* — a finite sweep of fixtures is
performance evidence, not a bound — and the encoder's working memory is bounded
by nothing. The only fail-closed statement available is the JPEG format's own
worst case, **20 B/px** (ITU-T T.81), under which one A4 page at 300 dpi peaks
at **553.0 MiB** and 512 MiB holds no page at all.

## 2. The candidates

| | what it is | outcome |
| --- | --- | --- |
| **E1** | `toDataURL` → base64 → `embedJpg` (production) | baseline. Peak 553.0 MiB (66.7 B/px) under the format bound; **UNKNOWN** term present |
| **E2** | M4's owned stored-PNG encoder → `embedPng` | **does not close H8**: peak 132.7 MiB (16.0 B/px) |
| **E3** | the samples written straight into an image XObject | **recommended** |
| **E4** | jsPDF 3.0.4's bundled `JPEGEncoder` | **exists, and is inadmissible** — for two reasons, neither of them absence |

**E2's failure is instructive.** The encoder is owned and its output exact —
`pngStoredSize`, verified against production to the byte at three sizes. The
*embedding* is not: `PngEmbedder` → `utils/png.js` → `@pdf-lib/upng` copies the
PNG, inflates it, expands it to RGBA (`UPNG.js:48`), copies that frame again
(`png.js:48`), splits it into a 3 B/px `rgbChannel` and a 1 B/px `alphaChannel`
(`png.js:21-22`), and only then deflates. Owning the encoder bought exactness
that is spent before the bytes reach the document.

**E4 exists and was investigated.** `jspdf.es.js:15515` defines a complete
baseline JPEG encoder. It is inadmissible here for two independent reasons:

- **no supported path reaches it with raw pixels.** The bundle exports only
  `AcroForm*`, `GState`, `ShadingPattern`, `TilingPattern` and `jsPDF`
  (line 24183); the encoder is module-internal and is called only by
  `processGIF89A` (16067), `processBMP` (16354) and `processWEBP` (20194) —
  each of which takes an *encoded image file*. `processRGBA`, the one that
  takes canvas pixels, does not use it (20241-20272). Checked at runtime, not
  inferred: not exported, not on `jsPDF.API`, not on an instance.
- **its output cannot be bounded in memory.** `byteout = []` is an ordinary JS
  array pushed one byte at a time (15529, 15651) and converted with
  `new Uint8Array(byteout)` at the end (16016), alongside two
  `new Array(65535)` lookup tables (15525-15526). The heap cost and the growth
  policy are the engine's. Priced at V8's 8 bytes per element *to show the
  dependence, never as a bound*, one A4 page at 300 dpi reaches 1,493 MiB.

## 3. E3 — an image XObject this architecture owns

```js
const dict = { Type: 'XObject', Subtype: 'Image', Width, Height,
               BitsPerComponent: 8, ColorSpace: 'DeviceGray' };   // or DeviceRGB
const ref = doc.context.register(doc.context.stream(samples, dict));   // no filter
const name = page.node.newXObject('Img', ref);
page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0),
                   drawObject(name), popGraphicsState());
```

There is no encoder and no decoder in that path, and no copy: `typedArrayFor`
returns a `Uint8Array` unchanged (arrays.js:9-11) and `PDFRawStream` assigns it
to `contents` (PDFRawStream.js:10). The gate confirms it by identity, and reads
the stored size back with `getContentsSize()` rather than assuming the samples'
length.

| | per pixel | basis |
| --- | --- | --- |
| DeviceGray, no filter | **1 B** | exact, known before the page is rendered |
| DeviceRGB, no filter | **3 B** | exact |
| either, `flateStream` | ≤ the bound in §5 | source-derived from pako 1.0.11 |

## 4. The ordering is part of the design

`getImageData` needs the canvas; nothing after it does. Measured on A4 at
300 dpi in DeviceRGB, with the model predicting both figures exactly:

| | live while the samples are made | page peak |
| --- | --- | --- |
| canvas held to the end | 91.2 MiB — **11.0 B/px** | 91.2 MiB |
| canvas released first | 58.1 MiB — **7.0 B/px** | **66.4 MiB** |

The first version of this prototype held the canvas and the model priced the
readback alone, so it claimed 8 B/px for a pipeline that was using 11. Both
orderings are now modelled, the prototype performs the released one, and the
gate proves which.

## 5. What the deflater actually costs

`context.flateStream` calls the pako **1.0.11** that pdf-lib resolves from its
own `node_modules` — not the 2.1.0 hoisted at the top of the tree. Three terms,
all from that source:

| term | bytes | source |
| --- | --- | --- |
| fixed deflate state | **262,144** (window 65,536 + head 65,536 + prev 65,536 + pending_buf 65,536) | deflate.js:1376-1389 at level 6 / windowBits 15 / memLevel 8 |
| output chunks | `⌈bound/16384⌉ × 16,384` | `Deflate.push` allocates `Buf8(16384)` (deflate.js:243) and `shrinkBuf` hands on a **subarray, not a copy** (common.js:34-38), so each chunk pins its whole buffer |
| flattened result | the output | `flattenChunks` allocates it while the chunks are still live (common.js:54-72) |

**The size bound is pako's, not DEFLATE's.** `_tr_flush_block` emits a stored
block whenever `stored_len + 4 ≤ opt_lenb` (trees.js:1073-1131), so no block is
worse than stored — 5 bytes of framing over its own bytes — and a block is
flushed at the latest when `lit_bufsize` = 16,384 literals have accumulated
(deflate.js:1383). With the 2-byte zlib header and the 4-byte Adler-32:

```text
bound(n) = n + 5·⌈n / 16384⌉ + 6
```

Measured against it on 1240×1754: incompressible noise deflates to **exactly**
2,175,631 B in DeviceGray and **exactly** 6,526,881 B in DeviceRGB — the bound,
to the byte — while uniform content reaches ×0.001. A bound that the worst case
touches and the best case falls far below is the right shape.

## 6. The lifetime, term by term

| step | live | basis |
| --- | --- | --- |
| render | canvas 4·W·H | EXACT |
| readback | canvas + ImageData = 8·W·H | EXACT |
| convert | ImageData + samples (canvas already released) | EXACT |
| embed, raw | samples, kept by reference | EXACT |
| embed, flate | samples + pako state + pinned chunks + result | EXACT / SOURCE_DERIVED |
| retain until save | one stream per page | EXACT |
| save | every retained stream + the output buffer | EXACT + conservative overhead |
| publish | output × 2 | CONSERVATIVE_BOUND |

Peaks for one A4 page at 300 dpi: **66.4 MiB (8.0 B/px)** at the readback for
DeviceGray raw and flate and DeviceRGB raw; **74.9 MiB (9.0 B/px)** at the
deflate step for DeviceRGB flate.

## 7. The rule that decides admissibility

```text
no UNKNOWN term, and no term whose only basis is a measurement
```

| candidate | admissible | why not |
| --- | --- | --- |
| E1, format bound | **no** | the encoder's working memory is UNKNOWN |
| E1, measured estimate | **no** | that, and the size is MEASURED_ONLY |
| E4 (jsPDF), either model | **no** | `byteout`'s engine-dependent storage, and no public path |
| E2, E3 (all variants) | **yes** | every term exact or source-derived |

## 8. The ceilings, unchanged and independent

| ceiling | value | enforced on |
| --- | --- | --- |
| `MAX_RASTER_PIXELS` | 128 Mi px + a runtime canvas probe | the page's pixel count |
| `MAX_OPERATION_MEMORY` | 512 MiB default, explicit 1 / 2 GiB | the modelled peak |
| `MAX_OUTPUT_BYTES` | 256 MiB | the finished artifact |

Each is probed in isolation with the other two unbounded. A larger memory
preset buys past neither of the others: A1 at 600 dpi stays `OVER_RASTER_LIMIT`
at every preset and with memory unbounded, and A0 at 300 dpi stays refused at
2 GiB.

## 9. The batch, priced from JSZip's own path

`generateInternalStream` defaults to `compression: "STORE"` and
`streamFiles: false` (object.js:320-321), so nothing is deflated and what
accumulates is copies: `ZipFileWorker` buffers each file's chunks to compute
its size and CRC (ZipFileWorker.js:337-339, 365-366), `StreamHelper.accumulate`
collects every emitted chunk in `dataArray` (StreamHelper.js:79-104), and
`concat` allocates the whole archive with `new Uint8Array(totalLength)` **while
`dataArray` is still live** (StreamHelper.js:46-62). The Blob conversion itself
copies nothing — `transformTo('arraybuffer', …)` returns `input.buffer`
(utils.js:273-275) — but the Blob constructor's own copy is priced
conservatively.

A real three-file archive: sources 28,974 B, archive 29,556 B, +194 B per file
of records — STORE behaving as the model assumes.

The consequence is a **job** ceiling, not a per-file one. A model that prices
only the largest file accepts batches the full one refuses, and the gate shows
it at the exact count where that happens.

## 10. What it costs the drawing: nothing the encoder was responsible for

At a given resolution the candidates are indistinguishable (1 px linework at
300 dpi: ink kept 76.3% with production JPEG, 76.5% with the lossless owned
path, 19.5 dB both). What destroys linework is the resolution — 3.5% at
150 dpi — which is H2b and stays deferred.

## 11. What this does not decide

The encoding path only. H2b/O3 stays deferred; the operation classes, the H7
policy, B2, ownership and the orchestration were adopted and are untouched; and
whether a larger PDF is an acceptable price is the second Human decision this
spike leaves open.
