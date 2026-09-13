# Measurements

Every number below is a line in `evidence.json`, produced by
`scripts/research-gate.mjs` from the committed source head it records. Sizes
and peaks that are arithmetic say so; everything else was measured in a
headless Chrome on one machine.

**Gate:** ASSERT 16/16 · PROBE 14/14 · MEASURE 139 · BASELINE-FAIL 1 ·
HUMAN-OPEN 2 · external HTTP(S) 0 · page errors 0.

## The corpus

Ten synthetic documents (`scripts/make-fixtures.mjs`, written to ignored
`test-fixtures/m5-encoder/`): a coloured vector drawing, native text, a drawing
with thin witness lines and small dimension strings, hairline hatching, 300 dpi
one-pixel linework on paper grain, a greyscale scan, a colour scan,
photographic gradients, four vector pages, and an A3 sheet.

## What is live while the samples are made

A4 at 300 dpi, DeviceRGB, measured in the prototype and predicted exactly by
the model in both orderings:

| | live at conversion | per pixel | page peak |
| --- | --- | --- | --- |
| canvas held to the end | 91.2 MiB | **11.0 B/px** | 91.2 MiB |
| canvas released first | 58.1 MiB | **7.0 B/px** | **66.4 MiB** |

## What the PDF object actually carries

Read back with `PDFRawStream.getContentsSize()`, 1240 × 1754:

| colour space | content | filter | samples | stored | bound |
| --- | --- | --- | --- | --- | --- |
| DeviceGray | uniform | none | 2,174,960 | 2,174,960 | 2,174,960 |
| DeviceGray | uniform | flate | 2,174,960 | **2,130** (×0.001) | 2,175,631 |
| DeviceGray | noise | flate | 2,174,960 | **2,175,631** | **2,175,631** |
| DeviceRGB | uniform | flate | 6,524,880 | **6,358** (×0.001) | 6,526,881 |
| DeviceRGB | noise | flate | 6,524,880 | **6,526,881** | **6,526,881** |

A raw stream is the samples, and pdf-lib keeps *the very array it was handed* —
checked by identity. A check reading `samples.length` would report the same
number for both rows of each pair, so the substitution is caught.

## The deflate bound, probed at the block boundary

The divisor is `lit_bufsize - 1` = **16,383**, not `lit_bufsize`: `_tr_tally`
increments `last_lit` and then returns `(s.last_lit === s.lit_bufsize - 1)`
(trees.js:1171, 1211), so the flush is requested on the 16,383rd literal.

```text
bound(n) = n + 5·⌈n / 16383⌉ + 6
```

Probed on incompressible input at and around the boundary:

| n | stored | corrected bound | previous `/16384` bound |
| --- | --- | --- | --- |
| 16,382 | 16,393 | 16,393 | 16,393 |
| 16,383 | 16,394 | 16,394 | 16,394 |
| **16,384** | **16,395** | 16,400 | **16,395** |
| 32,766 | 32,782 | 32,782 | 32,782 |
| **32,767** | **32,783** | 32,788 | **32,783** |
| **32,768** | **32,784** | 32,789 | **32,784** |

Stated precisely: **the previous expression was not violated anywhere in the
probed range — but at three of the six sizes it was met exactly, with zero
slack.** The corrected divisor is adopted because it is what the pinned source
says, not because a fixture broke the old one; it is never smaller than the old
bound, and larger exactly where a block boundary can fall. The same sizes as
uniform content compress to 39–54 B, so the probe exercises both ends of the
same code path.

## The deflate state, per call

Ten arrays, not four (deflate.js:1195-1221, 1376-1389):

| array | bytes | array | bytes |
| --- | --- | --- | --- |
| `window` | 65,536 | `dyn_dtree` | 244 |
| `head` | 65,536 | `bl_tree` | 156 |
| `prev` | 65,536 | `bl_count` | 32 |
| `pending_buf` | 65,536 | `heap` | 1,146 |
| `dyn_ltree` | 2,292 | `depth` | 1,146 |

**Total 267,160 B.** The previous round called the four large buffers
(262,144 B) "the pako state"; they are most of it, not all of it.

On top of that, per deflate: the output chunks, each pinning a full 16,384 B
buffer because `shrinkBuf` returns a subarray without copying
(common.js:34-38), and the `flattenChunks` result, allocated while those chunks
are still live (common.js:54-72).

## The owned PNG encoder's size contract (E2)

| | encoded | per pixel |
| --- | --- | --- |
| 64 × 64 | 16,516 B | 4.032 |
| 1240 × 1754 | 8,702,418 B | 4.001 |
| 2480 × 3508 | 34,805,987 B | 4.001 |

## E1 — production, as the baseline

`processMonochrome`, unchanged, at the UI's defaults:

| fixture | @150 | @300 |
| --- | --- | --- |
| drawing-a4 | 53,575 B | 139,656 B |
| hatch-a4 | 329,543 B | 1,192,094 B |
| fine-line-a4 | 374,984 B | 1,449,989 B |
| grey-scan-a4 | 328,191 B | 1,237,587 B |
| colour-scan-a4 | 124,785 B | 706,163 B |
| photo-a4 | 65,895 B | 400,036 B |

## Output size, per candidate (MiB)

| fixture @150 | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.0 | 2.1 | 0.0 | 6.2 | 0.0 |
| fine-line-a4 | 0.4 | 1.4 | 2.1 | 0.8 | 6.2 | 1.4 |
| grey-scan-a4 | 0.3 | 1.9 | 2.1 | 1.1 | 6.2 | 1.9 |
| photo-a4 | 0.1 | 1.5 | 2.1 | 1.3 | 6.2 | 5.2 |

| fixture @300 | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.1 | 8.3 | 0.0 | 24.9 | 0.1 |
| grey-scan-a4 | 1.2 | 3.0 | 8.3 | 1.4 | 24.9 | 3.0 |

## Quality

Judged at 300 dpi against the source rendered the same way.

| flattened @150 | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb flate |
| --- | --- | --- | --- | --- | --- |
| drawing-a4 | 83.9%, 22.9 dB | 83.9%, 22.9 | 83.9%, 22.9 | 83.9%, 22.9 | 83.9%, 22.9 |
| hatch-a4 | 47.3%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 |
| fine-line-a4 | 8.8%, 15.9 | 3.5%, 15.9 | **3.5%**, 15.9 | 3.5%, 15.9 | 3.5%, 15.9 |
| grey-scan-a4 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 |
| colour-scan-a4 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.8 |
| photo-a4 | 99.5%, 43.5 | 99.6%, 43.6 | 99.7%, 43.8 | 99.7%, 43.8 | 99.5%, 44.2 |

| flattened @300 | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb flate |
| --- | --- | --- | --- | --- | --- |
| drawing-a4 | 89.7%, 28.4 dB | 89.7%, 28.4 | 89.7%, 28.4 | 89.7%, 28.4 | 89.7%, 28.4 |
| fine-line-a4 | 76.3%, 19.5 | 76.4%, 19.5 | **76.5%**, 19.5 | 76.5%, 19.5 | 76.4%, 19.5 |

## The memory model, per candidate

One A4 page at 300 dpi (2480 × 3508 = 8.70 Mpx), canvas released first, and —
for the deflating variants — the readback priced as still reachable while
deflate runs:

| candidate | peak | per pixel | at step | stream | admissible |
| --- | --- | --- | --- | --- | --- |
| E1 JPEG, format bound | **553.0 MiB** | 66.7 | embed | 20.000 B/px | **no** |
| E1 JPEG, measured estimate | 85.7 MiB | 10.3 | encode | 1.000 B/px | **no** |
| E2 owned PNG → pdf-lib | 132.7 MiB | 16.0 | decode | 4.001 B/px | yes |
| **E3 DeviceGray, raw** | **66.4 MiB** | **8.0** | readback | 1.000 B/px | yes |
| **E3 DeviceGray, flate** | **66.4 MiB** | 8.0 | readback | 1.000 B/px | yes |
| **E3 DeviceRGB, raw** | **66.4 MiB** | 8.0 | readback | 3.000 B/px | yes |
| **E3 DeviceRGB, flate** | **108.1 MiB** | 13.0 | **deflate** | 3.001 B/px | yes |
| E4 jsPDF, format bound | 1,493.0 MiB | 180.0 | convert | 20.000 B/px | **no** |
| E4 jsPDF, measured estimate | 100.5 MiB | 12.1 | encode | 1.000 B/px | **no** |

Pricing the readback as live moved DeviceRGB with FlateDecode from 74.9 MiB to
**108.1 MiB** and its peak from the readback to the deflate step. DeviceGray
flate is unaffected — its samples are a third the size, so the readback still
dominates.

## E4 — jsPDF 3.0.4's bundled encoder, checked at runtime

Exports: `AcroForm*`, `GState`, `ShadingPattern`, `TilingPattern`, `default`,
`jsPDF`. `JPEGEncoder` exported: **false**; on `jsPDF.API`: **false**; on an
instance: **false**. Plugins that call it: `processGIF89A`, `processBMP`,
`processWEBP` — each takes an encoded image file. `processRGBA`, the one that
takes canvas pixels, exists and does not use it.

## Boundaries

Single file, inside 512 MiB — unchanged by the corrections:

| candidate | A4 @300 | A4 @150 |
| --- | --- | --- |
| E1, fail-closed | **0** (1st refused) | 6 (7th) |
| E1, estimate (unadoptable) | 30 (31st) | 123 (124th) |
| E2 | 10 (11th) | 41 (42nd) |
| **E3 DeviceGray, raw and flate** | **30** (31st) | **123** (124th) |
| **E3 DeviceRGB, raw and flate** | **10** (11th) | **41** (42nd) |
| E4, fail-closed | **0** (1st) | 3 (4th) |

B2 batch, one-page A4 @150 files, priced from JSZip's own path with the Blob
handoff overlapping the sources, the chunks and the concatenated archive:

| candidate | 512 MiB | 1 GiB | 2 GiB |
| --- | --- | --- | --- |
| E1, fail-closed | 3 (4th refused) | 6 | 6 |
| E1, estimate | 61 (62nd) | 123 | 123 |
| E2 | 20 (21st) | 41 | 41 |
| **E3 DeviceGray** | **61** (62nd) | 123 | 123 |
| **E3 DeviceRGB** | **20** (21st) | 41 | 41 |
| E4, fail-closed | 3 (4th) | 6 | 6 |

Every first-over case at 512 MiB is `OVER_MEMORY_BUDGET`. At 1 GiB and 2 GiB
the numbers stop moving because `MAX_OUTPUT_BYTES` binds instead.

**The batch terms**, for 10 one-page A4 @300 DeviceRGB files: sources
248.8 MiB (EXACT); `ZipFileWorker.contentBuffer` 24.9 MiB (CONSERVATIVE);
`StreamHelper` `dataArray` 248.9 MiB (SOURCE_DERIVED); the `concat` result
248.9 MiB (SOURCE_DERIVED); the arraybuffer view 0 (EXACT — `input.buffer`);
the Blob copy 248.9 MiB (CONSERVATIVE), built before `dataArray` is cleared.

**A real archive**: 3 files, sources 28,971 B, archive 29,553 B, +194 B per
file of records — STORE behaving as the model assumes.

## The ceilings stay independent

- **raster first-over** — A1 @600 refused `OVER_RASTER_LIMIT` at 512 MiB, 1 GiB,
  2 GiB *and* with memory unbounded;
- **output first-over** — with memory and pixels unbounded, the first page count
  past 256 MiB of output is refused `OVER_OUTPUT_BUDGET`;
- **memory first-over** — with the other two unbounded, the memory ceiling fires;
- **an explicit preset moves nothing but memory** — A0 @300 stays
  `OVER_RASTER_LIMIT` at the largest preset.

**Canvas probe** (one machine): A4@300 (9 Mpx) allocates, A1@300 (70 Mpx)
allocates, A1@600 (279 Mpx) does not.

## Negative probes

Fourteen, all passing. The ones that carry the argument:

- **the first round's model fails against the ordering its own code performed** —
  holding the canvas costs 11.0 B/px at conversion, not 8;
- **the divisor had to be `lit_bufsize - 1`** — the two bounds differ exactly at
  block boundaries, and every probed size stays inside the corrected one;
- **the measurement is of the compressed stream, not of the samples** — noise and
  uniform differ by three orders of magnitude through the same path;
- **incompressible content stays inside the bound** rather than merely inside the
  samples;
- **an unknown encoder scratch prevents a hard contract**, and **a measured
  compression ratio cannot masquerade as a hard bound**;
- **a partial model cannot claim READY** — pricing one page of a multi-page job
  admits what the complete model refuses;
- **the simplified batch model claims READY where the source-derived one
  refuses** — 10 one-page A4 @300 files: 497.7 MiB against 995.4 MiB;
- **the previous batch model claims READY where the overlapping one refuses** —
  6 files: 447.9 MiB (sources + 2 × archive) against 597.3 MiB (sources +
  chunks + concat + Blob copy, all live at the handoff);
- raster / memory / output first-over, each isolated with the other two
  unbounded.

## Provenance

`evidence.json` records `productionBase`, `testedResearchHead`,
`researchBranchAtRun`, `workingTreeDirty` and `coreCiRunsThisGate: false`.
Dirtiness covers `research/m5-raster-encoder-memory` **including untracked
files**, excluding only the gate's own output. This is local research evidence;
**Core CI** runs the existing backbone at the exact head and does not run this
gate.
