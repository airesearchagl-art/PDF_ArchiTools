# Human Adoption record — M5 Processor Reliability Architecture

The Human Product Gate closed on the architecture proposed in this package. The
decisions are recorded here **as given**, not re-interpreted, re-argued or
re-scoped by this repository.

```text
M5 Architecture Adoption = PASS

H8 = BLOCKED
  pending Raster Encoder / Memory Sub-Spike

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
| **H8** | memory for the flattening operations | **BLOCKED pending this sub-spike** |
| **H9** | raster resolution and the raster ceiling | **adopted** |
| **H10** | cancellation, ownership, atomic output | **adopted** |
| **H11** | common Processor orchestration | **adopted** |
| **H12** | metadata | **adopted** |
| **H13a** | layer extent | **adopted** |
| **H13b** | layer stacking | **adopted** |

Thirteen adopted, one deferred (H2b), one blocked (H8).

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
- **H8 BLOCKED** leaves `MAX_OPERATION_MEMORY` unadopted. 512 MiB / 1 GiB /
  2 GiB remain candidates, not guarantees, and every "planning" number in
  `measurements.md` stays an estimate until the Raster Encoder / Memory
  Sub-Spike closes it.
- **H9 adopted** is `MAX_RASTER_PIXELS` 134,217,728 (128 Mi px) plus a runtime
  canvas-allocation probe, and `MAX_OUTPUT_BYTES` 256 MiB enforced on the
  finished artifact. These stand independently of H8: no memory preset may
  bypass either.

## State

- Recorded on the research branch; **PR #23 stays Draft**.
- No production implementation follows from this record. `src/` is unchanged.
- The open work is the **Raster Encoder / Memory Sub-Spike**
  (`research/m5-raster-encoder-memory/`), which exists only to close H8.
