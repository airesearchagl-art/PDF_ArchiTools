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
- **「最適化」 makes vector drawings 11–153× larger at its default** (up to
  463×) and unsearchable.
- **Margin keeps the drawing but not the document**: annotations, links (and
  where they point), forms, XFA and metadata are left behind, rotated sheets
  come back turned, the CropBox is discarded and hidden content is revealed.
- **Layer keeps the structure** but silently invalidates signatures, rewrites
  metadata, misses part of the sheet when the MediaBox is not at (0,0), and sits
  below every annotation.
- **600 dpi on A1/A0 is offered and cannot be allocated**; it fails after the
  work has started.
- **A partly failed batch ships a ZIP of the rest with no record of the
  failure; a batch the user navigated away from still downloads; a setting
  changed mid-run is neither applied nor locked.**
- The hardened lanes' gates pass unchanged; both invalidate a signed document
  without refusing it.

## What is proposed (not adopted)

Two operation classes. One PLAN → RESULT orchestration that reads **source
facts** once (M3's dictionary-level reading, never `getForm()`) and applies an
**H7 policy** chosen by the Human Gate. `FileResult` and `BatchResult` kept
apart, with B1/B2/B3 defined and prototyped as defined. A closed **Raster
Budget** for the flattening operations (raster, memory and output ceilings with
concrete candidates, validated against production). Per operation: Monochrome
keeps rasterising for the MVP as an explicit, confirmed flattening (candidate C
for a follow-up spike); 「最適化」 promises O2 now and O3 only once its lossy
contract is decided; Margin transforms in place with a stated supported/refused
contract. Fifteen Human decisions remain open.

## Evidence

The **M5 research gate** (`scripts/research-gate.mjs`) is run locally on this
branch; its output is committed as `evidence.json`. **Core CI** runs the
existing backbone at the exact head and does not run this gate. The two are
reported separately.

## Files

| file | contents |
| --- | --- |
| `baseline.md` | what each operation does, the preservation matrix, the baseline defects with root causes |
| `measurements.md` | every number: sizes, raster cost and budget, canvas limit, batches, lifecycle, candidates, RF-K results |
| `architecture.md` | the proposed architecture |
| `decision-matrix.md` | candidate comparisons and recommendations |
| `limitations.md` | what the evidence and prototypes do not show |
| `human-gate.json` | H1–H13 (H2 and H13 split into a/b), recommendations, all open |
| `evidence.json` | the gate's output: every line, classified, and the compact matrices |
| `prototype/inspect.mjs` | the read-only structural inspector |
| `prototype/source-facts.mjs` | SourceFacts, operation effects, H7 candidate policies, `planOperation` |
| `prototype/job.mjs` | PLAN, FileResult, BatchResult, B1/B2/B3, ownership |
| `prototype/raster-budget.mjs` | the Raster Budget model and its limit candidates |
| `prototype/mono-structure.mjs` | Monochrome candidates B and C |
| `prototype/margin-inplace.mjs` | Margin in place, with destinations and widgets |
| `prototype/optimize-structure.mjs` | Optimize O3, planned across every use |
| `prototype/layer-stacking.mjs` | the overlay-above-annotations candidate |
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
gate), and `HUMAN-OPEN` (never a pass).
