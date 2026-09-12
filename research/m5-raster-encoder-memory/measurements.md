# Measurements

Every number below is a line in `evidence.json`, produced by
`scripts/research-gate.mjs` on this branch. Sizes and peaks that are arithmetic
say so; everything else was measured in a headless Chrome on one machine.

**Gate:** ASSERT 11/11 · PROBE 11/11 · MEASURE 94 · BASELINE-FAIL 1 ·
HUMAN-OPEN 2 · external HTTP(S) 0 · page errors 0.

## The corpus

Ten synthetic documents (`scripts/make-fixtures.mjs`, written to ignored
`test-fixtures/m5-encoder/`): a coloured vector drawing, native text, a drawing
with thin witness lines and small dimension strings, hairline hatching, 300 dpi
one-pixel linework on paper grain, a greyscale scan, a colour scan,
photographic gradients, four vector pages, and an A3 sheet.

## The owned PNG encoder's size contract (E2)

| | encoded | per pixel |
| --- | --- | --- |
| 64 × 64 | 16,516 B | 4.032 |
| 1240 × 1754 | 8,702,418 B | 4.001 |
| 2480 × 3508 | 34,805,987 B | 4.001 |

The model, the production function (`src/utils/comparator/png.ts`) and the
bytes actually written agree exactly, at every size.

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

**At 150 dpi:**

| fixture | E1 JPEG | E2 PNG→pdf-lib | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.0 | 2.1 | 0.0 | 6.2 | 0.0 |
| fine-line-a4 | 0.4 | 1.4 | 2.1 | 0.8 | 6.2 | 1.4 |
| grey-scan-a4 | 0.3 | 1.9 | 2.1 | 1.1 | 6.2 | 1.9 |
| photo-a4 | 0.1 | 1.5 | 2.1 | 1.3 | 6.2 | 5.2 |

**At 300 dpi:**

| fixture | E1 JPEG | E2 | E3 gray raw | E3 gray flate | E3 rgb raw | E3 rgb flate |
| --- | --- | --- | --- | --- | --- | --- |
| drawing-a4 | 0.1 | 0.1 | 8.3 | 0.0 | 24.9 | 0.1 |
| grey-scan-a4 | 1.2 | 3.0 | 8.3 | 1.4 | 24.9 | 3.0 |

(MiB.) The raw streams are exactly 1 and 3 B/px and do not depend on the
content at all — that is the point of them. `FlateDecode` costs the exactness
and recovers most of the size: on a line drawing it is smaller than the JPEG;
on photographic content it is several times larger.

## Quality

Judged at 300 dpi against the source rendered the same way: how much of the
source's ink is still ink, how much ink appeared that was not there, and PSNR.

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

At a given resolution the candidates are indistinguishable — the encoder was
never what was damaging the drawings. The same lossless owned path keeps
**3.5% of the line ink at 150 dpi and 76.5% at 300**. (JPEG's 8.8% at 150 dpi
is not better preservation: its ringing darkens pixels around the lost lines,
which the ink measure counts and the spurious-ink measure shows, 0.6% against
0.1%.)

## The memory model, per candidate

One A4 page at 300 dpi (2480 × 3508 = 8.70 Mpx):

| candidate | peak | at step | stream | admissible for a hard contract |
| --- | --- | --- | --- | --- |
| E1 JPEG, format bound | **553.0 MiB** | embed | 20.000 B/px | **no** — the encoder's working memory is UNKNOWN |
| E1 JPEG, measured estimate | 66.4 MiB | readback | 1.000 B/px | **no** — that, and the size is MEASURED_ONLY |
| E2 owned PNG → pdf-lib | **132.7 MiB** | decode | 4.001 B/px | yes |
| **E3 DeviceGray, raw** | **66.4 MiB** | readback | **1.000 B/px** | yes |
| **E3 DeviceGray, flate** | **66.4 MiB** | readback | 1.000 B/px | yes |
| **E3 DeviceRGB, raw** | **66.4 MiB** | readback | **3.000 B/px** | yes |
| **E3 DeviceRGB, flate** | **66.4 MiB** | readback | 3.000 B/px | yes |

Every E3 variant peaks at the readback — canvas plus `ImageData`, 8 B/px,
exact. Nothing after it is larger, so the encoding step has left the peak
entirely.

## Boundaries, inside the 512 MiB default

| candidate | A4 @300 | A4 @150 | one-page files, B2 batch @150 |
| --- | --- | --- | --- |
| E1, fail-closed | **0** (1st refused) | 6 (7th) | 6 (7th) |
| E1, estimate (unadoptable) | 30 (31st) | 123 (124th) | 123 (124th) |
| E2 | 10 (11th) | 41 (42nd) | 41 (42nd) |
| **E3 DeviceGray** | **30** (31st) | **123** (124th) | **123** (124th) |
| **E3 DeviceRGB** | **10** (11th) | **41** (42nd) | **41** (42nd) |

Every first-over case is refused `OVER_MEMORY_BUDGET`, by name, before any
raster is allocated.

## The ceilings stay independent

- **raster first-over** — A1 at 600 dpi is refused `OVER_RASTER_LIMIT` at
  512 MiB, 1 GiB, 2 GiB *and* with memory unbounded;
- **output first-over** — with memory and pixels unbounded, the first page
  count past 256 MiB of output is refused `OVER_OUTPUT_BUDGET`;
- **memory first-over** — with the other two unbounded, the memory ceiling is
  the one that fires;
- **an explicit preset moves nothing but memory** — A0 at 300 dpi stays
  `OVER_RASTER_LIMIT` at the largest preset.

**Canvas probe** (one machine): A4@300 (9 Mpx) allocates, A1@300 (70 Mpx)
allocates, A1@600 (279 Mpx) does not. The 128 Mi px policy sits below that
boundary rather than on it.

## Base64 versus binary

Production turns a 64,952 B JPEG into a data URL of **86,627 characters** —
`4·⌈J/3⌉+23` predicted it exactly, **33.4% larger** than the bytes — and then
decodes it back. An owned path hands pdf-lib a `Uint8Array` of samples; no
string is created at any point.

## Negative probes

Eleven, all passing. The ones that carry the argument:

- an **unknown encoder scratch prevents a hard contract**, whatever the numbers
  look like: both JPEG models are refused, one for the UNKNOWN term and one for
  that plus a MEASURED_ONLY size;
- a **measured compression ratio cannot masquerade as a hard bound**: the
  planning model is 486.6 MiB cheaper on the same page and is refused for it;
- a **partial model cannot claim READY**: pricing one page of a 40-page job at
  300 dpi says READY where the complete model — which knows every page is held
  until `save()` — refuses `OVER_MEMORY_BUDGET`;
- a **deflated stream stays under DEFLATE's own stored-block bound**, which
  holds by derivation; the measurement is a sanity check on it.

## Determinism, and what still moves

Two consecutive runs: every line's kind, name and verdict identical, every
total identical, and **every owned candidate's byte counts identical**. Six
`MEASURE` details moved, all of them the production baseline: four differ only
in timings, and two also in size — `colour-scan-a4` @300 at 706,163 / 706,164 B
and `photo-a4` @300 at 400,036 / 400,037 B. That is the same browser JPEG
encoder failing to repeat itself byte for byte on one machine, which M5 first
recorded and which is the whole reason a measurement of it cannot become a
bound.

## Provenance

`evidence.json` records `productionBase`, `researchHeadAtRun`,
`researchBranchAtRun`, `workingTreeDirty` and `coreCiRunsThisGate: false`. This
is local research evidence. **Core CI** runs the existing backbone at the exact
head and does not run this gate; the two are reported separately.
