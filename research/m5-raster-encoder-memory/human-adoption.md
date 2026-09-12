# Human Adoption record — H8

The Independent H8 Sub-Spike Review closed. The decisions are recorded here
**as given**, not re-argued or re-scoped by this repository.

```text
Independent H8 Sub-Spike Review = PASS

H8 Human Gate = CLOSED

Adopted:
- Monochrome = DeviceGray + FlateDecode
- bounded RGB flattening = DeviceRGB raw
- 512 MiB default
- explicit 1 / 2 GiB presets
- H9 ceilings unchanged
- B2 whole-job accounting
- file-size tradeoff accepted for Monochrome

H2b / O3 remains DEFER
```

## What the adopted names refer to

Only to identify the adopted items inside this package — nothing is widened or
narrowed here:

- **Monochrome = DeviceGray + FlateDecode** is the E3 path in
  `prototype/image-xobject.mjs`: render, `getImageData`, release the canvas
  backing store, convert to `DeviceGray` samples, write an owned full-page
  image XObject through `context.flateStream`. Its bound is the pinned-pako one
  in `prototype/encoders.mjs`: `n + 5·⌈n/16383⌉ + 6`, with the ten-array
  per-call state of 267,160 B and the readback priced live across the deflate.
- **Bounded RGB flattening = DeviceRGB raw** is the same path with
  `context.stream` and no filter — exactly 3 B/px, known before the page is
  rendered.
- **B2 whole-job accounting** is `batchPlan()`: the sources, the accumulated
  ZIP chunks, the concatenated archive and the Blob copy are all live at the
  handoff.
- **H9 ceilings unchanged**: `MAX_RASTER_PIXELS` 134,217,728 plus the runtime
  canvas-allocation probe, and `MAX_OUTPUT_BYTES` 256 MiB on the finished
  artifact. No silent DPI downgrade.

## One place where the Gate scoped this differently from the research

`decision.md` recommended the `DeviceRGB` path **for 「最適化」**. The Human Gate
adopted it only as a **bounded low-level flattening primitive**, available to a
future explicitly-flattening feature if one is approved. It does **not** define
「最適化」:

```text
H2a  「最適化」 = O2 lossless floor   (unchanged)
H2b / O3                    = DEFER  (unchanged)
```

Where `decision.md` reads as a recommendation for 「最適化」, the Gate's scoping
above governs. No measurement, probe or evidence line is altered by this record.

## Evidence this adoption rests on

| | |
| --- | --- |
| tested source head | `54374aa64e23b542d1f1955298c66c5d4d2d9c32` |
| evidence-only reviewed head | `6b373e5ace3fc57e1684c24368eecf2fee2c236f` |
| gate | ASSERT 16/16 · PROBE 14/14 · MEASURE 139 · BASELINE-FAIL 1 · HUMAN-OPEN 2 |

Both heads stay as historical evidence. This file is **Human-Adoption
documentation only**; it changes no prototype, script, measurement or evidence,
and `src/` remains untouched by this package.

## What follows

The production implementation happens on its own branch from
`main@78b5bd5ee676ee72621bccf9524225cd4ce8482a`. This PR stays Draft and open as
the decision record for H8.
