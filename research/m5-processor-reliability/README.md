# M5 — Processor Reliability Architecture Spike

**Research / decision PR. No production code is changed.** Starting point:
`main@78b5bd5ee676ee72621bccf9524225cd4ce8482a`.

The Processor (PDF加工) has seven operations. Two — 図面サイズ統一 and
図枠一括更新 — already have independent gates and are only checked here for
compatibility. The other five — 半透明レイヤ追加, モノクロ化, 両方実行, 余白生成,
最適化 — are measured as they are on `main`, and an architecture is proposed
for them.

## What was found

- **Monochrome, Both and Optimize flatten every page to a JPEG** and report
  「done」: searchable text, the OCR layer, vectors, annotations, links, forms,
  the signature, XFA and all metadata are gone, and nothing says so.
- **「最適化」 makes vector drawings 12–463× larger** and unsearchable.
- **Margin keeps the drawing but not the document**: annotations, links,
  forms, XFA and metadata are left behind, rotated sheets come back turned, the
  CropBox is discarded and hidden content is revealed.
- **Layer keeps the structure** but silently invalidates signatures, rewrites
  metadata, and misses part of the sheet when the MediaBox is not at (0,0).
- **600 dpi on A1/A0 is offered and cannot be allocated**; it fails after the
  work has started. A0 at the default 300 dpi needs ≈ 1 GiB of RGBA per page.
- **A batch with a failed file ships a ZIP of the rest with no record of the
  failure; a batch the user navigated away from still downloads; a setting
  changed mid-run is neither applied nor locked.**
- The hardened lanes' gates pass unchanged; both also invalidate a signed
  document without refusing it.

## What is proposed (not adopted)

Two operation classes; one PLAN → RESULT orchestration reusing the existing
read-only `assessSource`; a raster preflight for flattening operations;
ownership and a single publish; an explicit batch policy. Per operation:
Monochrome keeps rasterising for the MVP as an explicit, confirmed flattening,
with a structure-preserving candidate (C) for a follow-up spike; 「最適化」
means structure-preserving optimisation (O3), not flattening; Margin
transforms in place. Thirteen Human decisions remain open.

## Files

| file | contents |
| --- | --- |
| `baseline.md` | what each operation does, the preservation matrix, the baseline defects with root causes |
| `measurements.md` | every number: sizes, raster cost, canvas limit, batch, lifecycle, candidates |
| `architecture.md` | the proposed architecture, operation by operation |
| `decision-matrix.md` | candidate comparisons and recommendations |
| `limitations.md` | what the evidence and prototypes do not show |
| `human-gate.json` | H1–H13, with recommendations, all open |
| `evidence.json` | the gate's output: every line, classified, and the compact matrices |
| `prototype/inspect.mjs` | the read-only structural inspector |
| `prototype/mono-structure.mjs` | Monochrome candidates B and C |
| `prototype/margin-inplace.mjs` | Margin in place |
| `prototype/optimize-structure.mjs` | Optimize O3 |
| `prototype/job.mjs` | PLAN/RESULT, ownership, batch policies |
| `scripts/make-fixtures.mjs` | the synthetic corpus (written to ignored `test-fixtures/`) |
| `scripts/harness.html` | drives production functions and prototypes in the browser |
| `scripts/research-gate.mjs` | the gate |

## Run

```sh
node research/m5-processor-reliability/scripts/make-fixtures.mjs
node research/m5-processor-reliability/scripts/research-gate.mjs
```

The gate prints five kinds of line — `ASSERT` and `PROBE` (the apparatus; any
failure exits non-zero), `MEASURE`, `BASELINE-FAIL` (production behaviour, with
root cause and proposed architecture; these describe `main` and do not fail the
gate), and `HUMAN-OPEN` (never a pass). It drives the real Processor UI for
the batch and lifecycle measurements and writes `evidence.json`.
