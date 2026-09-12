# Human Adoption record — M5 Processor Reliability Architecture

The Human Product Gate closed on the architecture proposed in this package. The
decisions are recorded here **as given**, not re-interpreted, re-argued or
re-scoped by this repository.

```text
M5 Architecture Adoption = PASS / CLOSED

H8 = ADOPTED / CLOSED

H2b / O3 = DEFER
```

| decision | question (`human-gate.json`) | outcome |
| --- | --- | --- |
| **H1** | Monochrome: rasterisation or a structure-preserving implementation | **adopted** |
| **H2a** | what 「最適化」 promises | **adopted** |
| **H2b** | O3's lossy contract | **DEFER** |
| **H3** | Margin: which source structure must survive | **adopted** |
| **H4** | batch failure policy | **adopted** |
| **H5** | searchable text / OCR loss | **adopted** |
| **H6** | annotations and forms | **adopted** |
| **H7** | signatures and XFA | **adopted: applied-only + XFA refuse-if-dropped** |
| **H8** | memory for the flattening operations | **ADOPTED / CLOSED** — by the Raster Encoder / Memory Sub-Spike (PR #24) |
| **H9** | raster resolution and the raster ceiling | **adopted** |
| **H10** | cancellation, ownership, atomic output | **adopted** |
| **H11** | common Processor orchestration | **adopted** |
| **H12** | metadata | **adopted** |
| **H13a** | layer extent | **adopted** |
| **H13b** | layer stacking | **adopted** |

```text
14 ADOPTED
1 DEFERRED — H2b
0 BLOCKED
```

## What the adopted wording refers to

Only to identify the adopted items inside this package — no decision is
widened, narrowed or re-read here:

- **H7 `applied-only`** is the policy of that name in
  `prototype/source-facts.mjs`: an *applied* signature (a `/Sig` field whose
  `/V` holds a signature dictionary) is refused for every operation; an empty
  `/Sig` field is a form field and belongs to the operation's form contract
  (H6); `/SigFlags` alone refuses nothing.
- **XFA `refuse-if-dropped`** is that same policy's XFA rule: refuse where the
  operation drops XFA (Monochrome A, Optimize O1) and plan READY where it does
  not (Layer, Margin in-place, Mono C, O2/O3, both hardened lanes).
- **H8 ADOPTED / CLOSED**, by the Raster Encoder / Memory Sub-Spike (PR #24).
  Two encoding paths are adopted, both owned full-page image XObjects written
  by pdf-lib itself, with **the canvas backing store released after
  `getImageData` and before sample allocation**:

  **H8-A — Monochrome**

  ```text
  Owned full-page image XObject
  DeviceGray
  FlateDecode
  canvas backing store released after getImageData and before sample allocation
  ```

  **H8-B — bounded RGB flattening path**

  ```text
  Owned full-page image XObject
  DeviceRGB
  raw / no filter by default
  ```

  **H8-B does not redefine 「最適化」.** H2a stands unchanged — 「最適化」 is the
  O2 lossless floor — and H2b / O3 remains DEFER. The RGB path is an adopted
  low-level bounded primitive, available to a future explicitly-flattening
  feature if one is approved later.

  **Budgets**

  ```text
  MAX_OPERATION_MEMORY:
    default 512 MiB
    explicit 1 GiB / 2 GiB

  MAX_RASTER_PIXELS:
    134,217,728
    + runtime canvas allocation probe

  MAX_OUTPUT_BYTES:
    256 MiB

  silent DPI downgrade:
    prohibited
  ```

  **Batch.** B2 memory is whole-job memory. The 512 MiB conservative boundaries
  from the adopted evidence, for one-page A4 at 150 dpi:

  ```text
  DeviceGray B2:
  61 files accepted
  62nd first-over

  DeviceRGB B2:
  20 files accepted
  21st first-over
  ```

  These are **architecture/model boundaries, not a guarantee of total browser
  heap availability**.

  **File size.** The Gate adopts: *for Monochrome, the larger file size of the
  owned DeviceGray + FlateDecode path is acceptable in exchange for a
  fail-closed memory contract.* The 256 MiB artifact ceiling remains.
- **H9 adopted** is `MAX_RASTER_PIXELS` 134,217,728 (128 Mi px) plus a runtime
  canvas-allocation probe, and `MAX_OUTPUT_BYTES` 256 MiB enforced on the
  finished artifact. These stand independently of H8: no memory preset may
  bypass either.

## State

- Recorded on the research branch; **PR #23 stays Draft** and unmerged, as the
  historical decision record.
- `src/` is unchanged **by this package**. The production implementation follows
  on its own branch from `main@78b5bd5ee676ee72621bccf9524225cd4ce8482a`; this
  PR is not a prerequisite for it and is not merged to enable it.
- The Raster Encoder / Memory Sub-Spike (`research/m5-raster-encoder-memory/`,
  PR #24) is closed: its evidence-only reviewed head is
  `6b373e5ace3fc57e1684c24368eecf2fee2c236f`, tested from source
  `54374aa64e23b542d1f1955298c66c5d4d2d9c32`.
- Nothing remains blocked. The one open decision is **H2b / O3**, deferred.
