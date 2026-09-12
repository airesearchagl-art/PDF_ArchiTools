# Measurements

Every number below is a line in `evidence.json`, produced by
`scripts/research-gate.mjs` from the committed source head it records. Sizes
and peaks that are arithmetic say so; everything else was measured in a
headless Chrome on one machine.

**Gate:** ASSERT 15/15 · PROBE 12/12 · MEASURE 117 · BASELINE-FAIL 1 ·
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

The first round priced the readback alone and so claimed 8 B/px for a pipeline
that was using 11. The prototype now releases the canvas as soon as the
readback exists, and the gate measures which ordering the code performed rather
than taking the model's word for it.

## What the PDF object actually carries

Read back from the object with `PDFRawStream.getContentsSize()`, 1240 × 1754:

| colour space | content | filter | samples | stored | ratio | bound |
| --- | --- | --- | --- | --- | --- | --- |
| DeviceGray | uniform | none | 2,174,960 | 2,174,960 | ×1.000 | 2,174,960 |
| DeviceGray | uniform | flate | 2,174,960 | **2,130** | ×0.001 | 2,175,631 |
| DeviceGray | noise | none | 2,174,960 | 2,174,960 | ×1.000 | 2,174,960 |
| DeviceGray | noise | flate | 2,174,960 | **2,175,631** | ×1.000 | **2,175,631** |
| DeviceRGB | uniform | none | 6,524,880 | 6,524,880 | ×1.000 | 6,524,880 |
| DeviceRGB | uniform | flate | 6,524,880 | **6,358** | ×0.001 | 6,526,881 |
| DeviceRGB | noise | none | 6,524,880 | 6,524,880 | ×1.000 | 6,524,880 |
| DeviceRGB | noise | flate | 6,524,880 | **6,526,881** | ×1.000 | **6,526,881** |

Two things follow. A raw stream is the samples, and pdf-lib keeps *the very
array it was handed* — checked by identity, not by size. And incompressible
content lands **exactly on** the pako-derived bound, while compressible content
reaches ×0.001: a bound the worst case touches and the best case falls far
below. A check that read `samples.length` instead would have reported the same
number for both rows of each pair.

**The deflater's own state**, allocated by every `pako.deflate` call whatever
the input: **262,144 B** = window 65,536 + head 65,536 + prev 65,536 +
pending_buf 65,536 (pako 1.0.11, deflate.js:1376-1389). Its output chunks each
pin a full 16,384 B buffer because `shrinkBuf` returns a subarray without
copying, and `flattenChunks` allocates the result while they are still live.

## The owned PNG encoder's size contract (E2)

| | encoded | per pixel |
| --- | --- | --- |
| 64 × 64 | 16,516 B | 4.032 |
| 1240 × 1754 | 8,702,418 B | 4.001 |
| 2480 × 3508 | 34,805,987 B | 4.001 |

Model, production function and bytes written agree exactly at every size.

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

## Output size, per candidate

**At 150 dpi (MiB):**

| fixture | E1 JPEG | E2 PNG→pdf-lib | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.0 | 2.1 | 0.0 | 6.2 | 0.0 |
| fine-line-a4 | 0.4 | 1.4 | 2.1 | 0.8 | 6.2 | 1.4 |
| grey-scan-a4 | 0.3 | 1.9 | 2.1 | 1.1 | 6.2 | 1.9 |
| photo-a4 | 0.1 | 1.5 | 2.1 | 1.3 | 6.2 | 5.2 |

**At 300 dpi (MiB):**

| fixture | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.1 | 8.3 | 0.0 | 24.9 | 0.1 |
| grey-scan-a4 | 1.2 | 3.0 | 8.3 | 1.4 | 24.9 | 3.0 |

## Quality

Judged at 300 dpi against the source rendered the same way — ink kept, ink
invented, PSNR.

**Flattened at 150 dpi:**

| fixture | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb flate |
| --- | --- | --- | --- | --- | --- |
| drawing-a4 | 83.9%, 22.9 dB | 83.9%, 22.9 | 83.9%, 22.9 | 83.9%, 22.9 | 83.9%, 22.9 |
| hatch-a4 | 47.3%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 | 47.6%, 13.6 |
| fine-line-a4 | 8.8%, 15.9 | 3.5%, 15.9 | **3.5%**, 15.9 | 3.5%, 15.9 | 3.5%, 15.9 |
| grey-scan-a4 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 | 90.1%, 20.5 |
| colour-scan-a4 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.6 | 100.0%, 37.8 |
| photo-a4 | 99.5%, 43.5 | 99.6%, 43.6 | 99.7%, 43.8 | 99.7%, 43.8 | 99.5%, 44.2 |

**Flattened at 300 dpi:**

| fixture | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb flate |
| --- | --- | --- | --- | --- | --- |
| drawing-a4 | 89.7%, 28.4 dB | 89.7%, 28.4 | 89.7%, 28.4 | 89.7%, 28.4 | 89.7%, 28.4 |
| fine-line-a4 | 76.3%, 19.5 | 76.4%, 19.5 | **76.5%**, 19.5 | 76.5%, 19.5 | 76.4%, 19.5 |

At a given resolution the candidates are indistinguishable. The same lossless
owned path keeps **3.5% of the line ink at 150 dpi and 76.5% at 300**. (JPEG's
8.8% at 150 is ringing counted as ink: spurious ink 0.6% against 0.1%.)

## The memory model, per candidate

One A4 page at 300 dpi (2480 × 3508 = 8.70 Mpx), canvas released first:

| candidate | peak | per pixel | at step | stream | admissible |
| --- | --- | --- | --- | --- | --- |
| E1 JPEG, format bound | **553.0 MiB** | 66.7 | embed | 20.000 B/px | **no** — encoder working memory UNKNOWN |
| E1 JPEG, measured estimate | 85.7 MiB | 10.3 | encode | 1.000 B/px | **no** — that, plus MEASURED_ONLY size |
| E2 owned PNG → pdf-lib | 132.7 MiB | 16.0 | decode | 4.001 B/px | yes |
| **E3 DeviceGray, raw** | **66.4 MiB** | **8.0** | readback | **1.000 B/px** | yes |
| **E3 DeviceGray, flate** | **66.4 MiB** | 8.0 | readback | 1.000 B/px | yes |
| **E3 DeviceRGB, raw** | **66.4 MiB** | 8.0 | readback | **3.000 B/px** | yes |
| **E3 DeviceRGB, flate** | 74.9 MiB | 9.0 | deflate | 3.001 B/px | yes |
| E4 jsPDF, format bound | 1,493.0 MiB | 180.0 | convert | 20.000 B/px | **no** — `byteout`, the lookup arrays, and no public path |
| E4 jsPDF, measured estimate | 100.5 MiB | 12.1 | encode | 1.000 B/px | **no** — same |

## E4 — jsPDF 3.0.4's bundled encoder, checked at runtime

Exports: `AcroForm`, `AcroFormAppearance`, `AcroFormButton`,
`AcroFormCheckBox`, `AcroFormChoiceField`, `AcroFormComboBox`,
`AcroFormEditBox`, `AcroFormListBox`, `AcroFormPasswordField`,
`AcroFormPushButton`, `AcroFormRadioButton`, `AcroFormTextField`, `GState`,
`ShadingPattern`, `TilingPattern`, `default`, `jsPDF`.

`JPEGEncoder` exported: **false**. On `jsPDF.API`: **false**. On an instance:
**false**. Plugins that call it: `processGIF89A`, `processBMP`, `processWEBP` —
each takes an encoded image file. `processRGBA`, the one that takes canvas
pixels, exists and does not use it.

## Boundaries

Single file, inside 512 MiB:

| candidate | A4 @300 | A4 @150 |
| --- | --- | --- |
| E1, fail-closed | **0** (1st refused) | 6 (7th) |
| E1, estimate (unadoptable) | 30 (31st) | 123 (124th) |
| E2 | 10 (11th) | 41 (42nd) |
| **E3 DeviceGray** | **30** (31st) | **123** (124th) |
| **E3 DeviceRGB** | **10** (11th) | **41** (42nd) |
| E4, fail-closed | **0** (1st) | 3 (4th) |
| E4, estimate | 30 (31st) | 123 (124th) |

B2 batch, one-page A4 @150 files, priced from JSZip's own path:

| candidate | 512 MiB | 1 GiB | 2 GiB |
| --- | --- | --- | --- |
| E1, fail-closed | 4 (5th refused) | 6 | 6 |
| E1, estimate | 82 (83rd) | 123 | 123 |
| E2 | 27 (28th) | 41 | 41 |
| **E3 DeviceGray** | **82** (83rd) | 123 | 123 |
| **E3 DeviceRGB** | **27** (28th) | 41 | 41 |
| E4, fail-closed | 3 (4th) | 6 | 6 |

Every first-over case at 512 MiB is `OVER_MEMORY_BUDGET`. At 1 GiB and 2 GiB
the numbers stop moving because `MAX_OUTPUT_BYTES` binds instead — a larger
memory preset is not a way to process more files.

**The batch terms**, for 12 one-page A4 @300 DeviceRGB files: output PDFs held
as sources 298.6 MiB (EXACT); `ZipFileWorker.contentBuffer`, one file at a
time, 24.9 MiB (CONSERVATIVE); `StreamHelper` `dataArray` 298.6 MiB
(SOURCE_DERIVED); the `concat` result, allocated while `dataArray` is live,
298.6 MiB (SOURCE_DERIVED); the arraybuffer view 0 (EXACT — `input.buffer`, no
copy); the Blob copy 298.6 MiB (CONSERVATIVE).

**A real archive**: 3 files, sources 28,974 B, archive 29,556 B, +194 B per
file of records — STORE behaving as the model assumes.

## The ceilings stay independent

- **raster first-over** — A1 at 600 dpi is refused `OVER_RASTER_LIMIT` at
  512 MiB, 1 GiB, 2 GiB *and* with memory unbounded;
- **output first-over** — with memory and pixels unbounded, the first page
  count past 256 MiB of output is refused `OVER_OUTPUT_BUDGET`;
- **memory first-over** — with the other two unbounded, the memory ceiling
  fires;
- **an explicit preset moves nothing but memory** — A0 at 300 dpi stays
  `OVER_RASTER_LIMIT` at the largest preset.

**Canvas probe** (one machine): A4@300 (9 Mpx) allocates, A1@300 (70 Mpx)
allocates, A1@600 (279 Mpx) does not.

## Negative probes

Twelve, all passing. The ones that carry the argument:

- **the first round's model fails against the ordering the first round's code
  performed** — holding the canvas costs 11.0 B/px at conversion, not 8;
- **the measurement is of the compressed stream, not of the samples** — noise
  and uniform content differ by three orders of magnitude through the same
  code path, so a substitution of `samples.length` is caught;
- **incompressible content stays inside the bound** rather than merely inside
  the samples — it lands on it exactly;
- **an unknown encoder scratch prevents a hard contract**, and **a measured
  compression ratio cannot masquerade as a hard bound**;
- **a partial model cannot claim READY** — pricing one page of a multi-page job
  admits what the complete model refuses;
- **the simplified batch model claims READY where the source-derived one
  refuses**, at the exact file count the simplified model would have allowed;
- raster / memory / output first-over, each isolated with the other two
  unbounded, and an explicit preset moving nothing but memory.

## Provenance

`evidence.json` records `productionBase`, `testedResearchHead`,
`researchBranchAtRun`, `workingTreeDirty` and `coreCiRunsThisGate: false`.
Dirtiness is computed over `research/m5-raster-encoder-memory` **including
untracked files**, so an uncommitted prototype makes the run dirty and the gate
fails rather than recording a clean tree that never existed. This is local
research evidence; **Core CI** runs the existing backbone at the exact head and
does not run this gate.
