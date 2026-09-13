# Proposed architecture — reliable Processor contracts

**Status: proposal for the Human Adoption Gate. Nothing here is adopted.**
Every recommendation cites the measurement it rests on (`baseline.md`,
`measurements.md`); every open choice is a Human decision (`human-gate.json`).

Evidence strength: every number here comes from the **M5 research gate run
locally on this branch** and committed as `evidence.json`. Core CI runs the
existing backbone at the exact head; it does not run this gate.

## 1. Two operation classes — the distinction fits

| class | contract | operations today |
| --- | --- | --- |
| `STRUCTURE_PRESERVING_TRANSFORM` | the source document is the output document; only the named change is made; everything else survives, or the run is refused | Layer, 図面サイズ統一, 図枠一括更新, **Margin in-place**, **Monochrome C**, **Optimize O2** (and O3 within its lossy contract, H2b) |
| `INTENTIONAL_FLATTENING_TRANSFORM` | a new document of page images; every loss named in the PLAN and confirmed per run; inside the Raster Budget | Monochrome A, Optimize O1, Both |

Both inherits every Monochrome loss (measured), so its contract is
Monochrome's. Production Margin (`embedPage`) fits neither: it keeps the
drawing and loses the document without saying so.

## 2. Facts first, policy second (RF-K1)

`prototype/source-facts.mjs`:

```text
SourceFacts  (read-only; never a verdict)
  readable, loadError, encrypted
  pageCount, pagesValid, pageError
  hasAcroForm, hasXfa, sigFlags
  fieldCount, signatureFields [{name, signed}]
  formInspectionState  no-form | read | unreadable

planOperation(facts, operation, policy) → PLAN status
```

The reading reuses M3's dictionary-level approach (load with
`updateMetadata: false`, read `/AcroForm` and `/XFA` from the catalog) and
walks the field tree as dictionaries too, so **`getForm()` is never called** —
measured: trapped to throw while facts are read, and never reached, while M3's
`assessSource` does reach it on an ordinary form. `assessSource`'s `supported`
remains the Annotator's verdict (XFA → refused, no document); the Processor
does not inherit it.

What each operation does to a document is itself data (`OPERATION_EFFECTS`:
re-serialises, keeps XFA, keeps forms), held against the measurements by the
gate. H7's candidate policies are data too:

**A signature field is not a signature.** The facts keep three things apart:
`signatureFields[]` with a `signed` flag each, `hasSignatureField`,
`hasAppliedSignature`, and `/SigFlags` as its own fact. Only a `/Sig` field
whose `/V` holds a signature dictionary is an applied signature, and only that
is what re-serialising destroys. An *empty* signature field is a form field:
measured, Layer keeps it and Monochrome removes it with the rest of the form.

| policy | signature | XFA |
| --- | --- | --- |
| `applied-only` (recommended) | refuse an **applied** signature; an empty field falls to the operation's form contract | refuse only the operations that drop it |
| `any-signature-infrastructure` | refuse any `/Sig` field or `/SigFlags`, signed or not | refuse only the operations that drop it |
| `annotator-equivalent` | refuse any signature infrastructure | refuse always |
| `confirm-if-dropped` | refuse an applied signature | a flattening may drop XFA, confirmed |

Every candidate refuses an *applied* signature for every operation — every
operation re-serialises, so no signature survives (measured for Layer and both
hardened lanes). They differ on the empty field: under `applied-only` it plans
`READY` for Layer and Margin in-place and
`STRUCTURE_LOSS_REQUIRES_CONFIRMATION` for Monochrome A (the form is among the
losses); under `any-signature-infrastructure` every operation refuses it.
On XFA: under `applied-only`, Layer, Margin in-place, Monochrome C, Optimize
O2/O3 and both hardened lanes plan `READY`, and Monochrome A / Optimize O1
plan `XFA_UNSAFE`.

## 3. PLAN → RESULT

```text
PLAN   (before any output byte)
  READY
  UNSUPPORTED_DOCUMENT · ENCRYPTED · SIGNATURE_UNSAFE · XFA_UNSAFE
  UNSUPPORTED_CONTENT                  a structure-preserving planner met a construct it cannot transform
  STRUCTURE_LOSS_REQUIRES_CONFIRMATION a flattening, with its losses listed
  OVER_RASTER_LIMIT · OVER_MEMORY_BUDGET · OVER_OUTPUT_BUDGET
  CANCELLED

FileResult   SUCCEEDED (one artifact) | FAILED (none) | CANCELLED (none)
BatchResult  SUCCEEDED | PARTIAL | FAILED | CANCELLED
```

Invariant: **cannot safely process ≠ successful output.** Exceptions stay
inside runners; the user sees a PLAN or a result. (Today every refusal —
including the hardened lanes' coded ones — becomes a message string,
`PdfTools.tsx:152-156`.)

## 4. Batches (RF-K2)

`prototype/job.mjs`, around the unchanged production functions:

| | B1 fail whole | B2 explicit partial | B3 independent jobs |
| --- | --- | --- | --- |
| ownership | one batch owner | one batch owner | one owner per file, under a batch owner |
| publication | one archive of every file, or nothing | one archive of the successes + manifest | one artifact per success, no archive |
| download timing | once, after the last file | once, after the last file | as soon as each file succeeds |
| cancellation | whole batch | whole batch | per file; the batch cancels what is not yet published |
| failure propagation | first failure stops; later files CANCELLED unrun | none | none |
| manifest | none (nothing published) | every file: PLAN, FileResult, reason — in the archive and on screen | none |
| early publish | no | no | yes |

Measured on `[ok, invalid, text, signed]`: B1 `FAILED`, 2 files started, 0
published; B2 `PARTIAL`, 1 archive of 2 + a manifest naming
`UNSUPPORTED_DOCUMENT` and `SIGNATURE_UNSAFE`; B3 `PARTIAL`, 2 downloads, each
before the next file started. B3 with one file cancelled by its own owner: that
file `CANCELLED`, the other two published. Whole batch superseded mid-run: B1
and B2 publish nothing; B3 has published only the file that finished first. An
aggregate single-publish run fed to the B3 conformance check is rejected
(`1 publishes for 2 successes; publishes an archive`).

## 5. The Raster Budget for flattening operations (RF-K5, corrected by RF-L2)

`prototype/raster-budget.mjs`. Three ceilings, checked in order, each
independent; an explicit memory preset never moves the other two; nothing
lowers the DPI.

| ceiling | status | recommended |
| --- | --- | --- |
| `MAX_RASTER_PIXELS` per page | **adoptable (H9)** — computed from pixel counts alone | **128 Mi px (134.2 Mpx)** + a runtime canvas-allocation probe |
| `MAX_OPERATION_MEMORY` | **BLOCKED (H8)** — see below | 512 MiB / 1 GiB / 2 GiB remain *candidates*, not guarantees |
| `MAX_OUTPUT_BYTES` | adoptable as a **post-hoc** check on the finished artifact (its size is measured, not predicted) | **256 MiB** |

The raster ceiling is a portable *policy* below what one machine allocated
(139 Mpx yes, 279 Mpx no) — not that machine's limit.

**Every term carries its basis** (`measurements.md`): exact (canvas, readback,
data URL, single-file publish), source-derived upper bound (pdf-lib's retained
JPEG and save buffer; the JPEG *format's* 20 B/px), conservative upper bound
(PDF.js scratch, source-image decode, source bytes, Both's Layer phase, JSZip),
measured performance (the 1.0 B/px planning ratio) and **unknown** (the browser
JPEG encoder's internal working memory).

**Why H8 cannot be adopted now (RF-L2).** Production encodes with
`canvas.toDataURL('image/jpeg', 0.8)`. That encoder is not owned by this
architecture: no finite sweep of fixtures can bound its output, and nothing
here bounds its scratch. So the research keeps two models apart and never lets
one stand in for the other:

- the **planning** model (measured ratio) says 512 MiB takes 30 A4 pages at
  300 dpi — an estimate, useful for what a run will probably cost;
- the **hard** model (format bound) says it takes **none** — one A4 page at
  300 dpi is already 619 MiB — and 6 pages at 150 dpi.

Neither is a memory guarantee while the encoder's own working set is unknown.
**H8 is therefore BLOCKED pending a Raster Encoder / Memory Sub-Spike.** The
way out is Route A: an encoding path whose size and working memory follow from
its implementation — the repository already owns one, M4's stored-PNG encoder,
whose encoded size is exact by construction, at a file-size cost this research
has not weighed. Until then 512 MiB stays a candidate, and every "planning" number
is labelled an estimate.

**What is unaffected:** the raster ceiling and the canvas probe (H9) — pixel
counts, measured identically in both models (134.19 Mpx accepted, 134.31
refused) — and the independence of the ceilings: in both models a larger memory
budget buys past neither the raster ceiling nor the output ceiling.

## 6. Monochrome

| candidate | measured |
| --- | --- |
| **A** production (rasterise) | grey; removes text, OCR, vectors, annotations, links, forms, signature fields, XFA, metadata; ×86 on a vector page |
| **B** colour operators only | grey and keeps everything where it converts; refuses every page that draws an image |
| **C** B + exact grey re-encoding of decodable images | grey on all 14 inputs it accepted (incl. a saturated image 1.000 → 0.000 and production's own JPEG output); keeps text, OCR, vectors, annotations, forms, metadata |

C is a coherent, fail-closed contract on the synthetic corpus; its refusal rate
on real drawings is unmeasured. **Recommended:** MVP keeps A as an explicit,
confirmed flattening inside the Raster Budget; C is a follow-up spike on real
drawings. H1.

## 7. Optimize (RF-K3)

| meaning | contract | measured |
| --- | --- | --- |
| **O1** production | every page a JPEG | text and structure removed; vector documents ×11–153 at the default, up to ×463 |
| **O2** lossless | re-save, nothing decoded | ×0.73–1.00; everything kept; never larger |
| **O3** preservation levels | O2 + recompress decodable images, planned across every use, only when smaller | structure kept; ×0.39–0.86 on the corpus; **changes raster pixels** |

**Planning across every use.** O3 walks every content stream with its
graphics-state stack and every Form XObject under its `/Matrix`, records the
size each image is drawn at, and keeps enough pixels for its most demanding
use. Measured: the same image drawn full-page on A4 and A1 gets the same plan in
either page order (3000×4243 kept); inside a Form drawn at A4 and A1 scale, the
same; repeated on one page, the full-page use decides (1240×1754). A use the
walk cannot size (an annotation appearance, an underflowed stack, a degenerate
matrix, an image never drawn) makes the image uncertain, and an uncertain image
is never downsampled. The first-encounter planner it replaces produced
1240×1754 for an A1 use needing 3508 px — page-order dependent.

**The lossy contract is a Human decision (H2b).** On a 300 dpi scan of
one-pixel linework: any resample to 150 dpi — JPEG or lossless — keeps only
22–26% of the line ink; JPEG q0.8 at the scan's own resolution keeps 100% at
×0.33 (PSNR 33.7 dB). **Recommended:** O2 is what 「最適化」 can promise now;
O3 only once H2b fixes target-DPI semantics (never below the source without an
explicit choice), quality (≥ 0.8) and skip-versus-recompress. H2a, H2b.

## 8. Margin (RF-K4)

In place: one `cm` scaling the content toward the chosen corner of the
visible page, a clip that keeps hidden content hidden, and — the exact
supported contract:

| carried | refused before any change |
| --- | --- |
| annotation `/Rect`, `QuadPoints`, `Vertices`, `L`, `CL`, `InkList`, `/RD` | an annotation not wholly inside the visible page |
| link `/Dest` and GoTo `/D` arrays — XYZ, Fit, FitH, FitV, FitR, FitB, FitBH, FitBV — through the matrix of the page they point to | a destination of any other type, or into no page of this document |
| the `/Names /Dests` tree, `/Dests`, outline items | structure destinations (`/SD`), `/GoToE` |
| widget `/DA` font size and `/BS /W`, field-level and form-level `/DA` | content whose q/Q nesting underflows; unknown annotation types |
| `/Rotate`, CropBox, resources, AcroForm, XFA, Info, XMP — untouched | |

Measured: `[p2 /XYZ 100 700]` → `[p2 /XYZ 139.53 644.19]` exactly as the
target page's matrix gives; the named `/FitH 500` → 484.19 as PDF.js resolves
it; the outline item and a `/FitR` likewise. A Square annotation half outside
the CropBox is refused; the same page without it transforms. A widget's text is
×0.78 of its source height in its stored appearance and ×0.78 again when a
viewer regenerates it from the scaled `/DA` — unscaled it would be ×1.00 in a
box ×0.8. Remote destinations (`/GoToR`) point into another file and are left
unchanged. H3, H6.

## 9. Layer (RF-K6)

- **Extent (H13a):** draw over the visible page in its own coordinates;
  production misses 61% of the ink when the MediaBox is not at (0,0).
- **Stacking (H13b):** production puts the layer in the content stream, so
  every annotation sits above it, unfaded (measured: an opaque blue annotation
  stays `[0,0,255]`). "Above" is achievable without flattening only as one more
  annotation, painted last (measured: the blue fades to `[128,128,255]`, the
  original annotation is kept) — the layer is then itself an annotation.
  **Recommended:** below, stated in the UI.

## 10. Signatures, XFA, metadata, local-only

- An **applied** signature → refuse, every operation (§2); an **empty** `/Sig`
  field is a form field and is handled by the operation's form contract (§2,
  H6). XFA → per the adopted H7 policy.
- Every pdf-lib-default load rewrites Producer/ModDate; rebuilt documents drop
  Title, Author and XMP. H12.
- Zero external HTTP(S) in every measurement; same-origin PDF.js worker; no new
  dependency — pdf-lib, PDF.js, the browser's canvas and `createImageBitmap`.

## 11. The hardened lanes inside it

`normalizePageSize` and `updateTitleBlocks` enter unchanged: per-file functions
with typed thrown errors mapped to `FileResult.FAILED` with their code. The
orchestration only *adds* the SourceFacts step (today both invalidate an
applied signature without refusing), ownership, the batch policy and a single
publish.
Their own guarantees — annotation-exposure refusal, orientation refusal, vector
preservation, `/Rotate`, the title-block Human workflow — stay where they are;
their gates pass unchanged (339, 20, 122, 31).
