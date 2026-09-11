# Proposed architecture — reliable Processor contracts

**Status: proposal for the Human Adoption Gate. Nothing here is adopted.**
Every recommendation cites the measurement it rests on (`baseline.md`,
`measurements.md`); every open choice is a Human decision (`human-gate.json`).

## 1. Two operation classes — the distinction fits

The research asked whether the Processor's operations fall into a
structure-preserving class and an intentionally flattening class. Measured,
they do, and cleanly:

| class | contract | operations today |
| --- | --- | --- |
| `STRUCTURE_PRESERVING_TRANSFORM` | the source document is the output document; only the named change is made; everything else — text, OCR, vectors, raster bytes, annotations, links, forms, XFA, boxes, `/Rotate`, metadata — survives or the run is refused | Layer (already, modulo signature/metadata), 図面サイズ統一, 図枠一括更新, **Margin (proposed in-place)**, **Monochrome C**, **Optimize O2/O3** |
| `INTENTIONAL_FLATTENING_TRANSFORM` | a new document of page images; every loss is named in the PLAN and confirmed per run | Monochrome A, Optimize O1, Both (inherits Monochrome's losses — measured) |

A flattening operation is not wrong. A flattening operation that reports
「done」 without naming what it removed is (baseline defects 1–2).

**Both** is not a third class: it is Monochrome's contract followed by Layer's.
Measured, it inherits every Monochrome loss and adds Layer's re-save, so its
contract is Monochrome's.

## 2. One PLAN → RESULT orchestration

Prototype: `prototype/job.mjs`, exercised in gate §8 around the unchanged
production `processLayer`.

```text
PLAN   (decided before any output byte exists)
  READY
  UNSUPPORTED_DOCUMENT      unreadable, no pages
  ENCRYPTED
  SIGNATURE_UNSAFE          the operation re-serialises a signed document
  XFA_UNSAFE                the operation would drop or cannot keep XFA
  UNSUPPORTED_CONTENT       a structure-preserving planner met a construct it
                            cannot transform (shading, pattern, ICC, Type3, …)
  STRUCTURE_LOSS_REQUIRES_CONFIRMATION
                            a flattening operation, with the list of losses
  OVER_RASTER_LIMIT         a page's raster exceeds the browser canvas limit
  OVER_MEMORY_BUDGET        the raster pipeline's peak exceeds the budget
  CANCELLED

RESULT (decided after)
  SUCCEEDED  → exactly one artifact
  FAILED     → no artifact, typed reason
  CANCELLED  → no artifact
```

Invariant: **cannot safely process ≠ successful output.** Exceptions remain an
implementation detail inside a runner; what the user sees is a typed PLAN or
RESULT. (Today every refusal, including the hardened lanes' coded ones, is
reduced to a message string in a catch — `PdfTools.tsx:152-156`.)

### Source inspection — reuse, do not reinvent

The existing M3 `assessSource` (`src/utils/annotator-save/source-assessment.ts`)
is read-only (measured again here: looking does not create an AcroForm), refuses
signed documents and XFA, and already distinguishes encrypted, unreadable and
form-unreadable. It is the common PLAN step for every Processor operation; no
new, weaker inspection is proposed. What each class does with its verdict is
H7.

### Raster preflight — for flattening operations only

Per page, before the first render: pixel dimensions at the requested DPI
against the **measured** canvas limit (A1/A0 @600 dpi do not allocate), and the
pipeline's per-page peak (canvas + readback + JPEG + data URL + retained JPEG)
plus the accumulated output against a memory budget. Refuse with the numbers;
never lower the DPI to make it fit. The constants are to be measured for this
pipeline (H8/H9); M4's are not reused.

### Ownership and publish

The F1-B/M4 owner token: captured when a run starts, re-read at every file
boundary and immediately before the single publish. Unmount, a settings change
and a file-list change supersede. The existing per-file functions cannot be
interrupted mid-file (none yields), so a superseded file finishes computing and
is discarded at the boundary — measured in the prototype: a batch superseded
during its first file publishes nothing; the same batch not superseded
publishes once.

### Batch

Three policies, all prototyped and measured; the choice is H4:

- **B1** fail whole — any failure, no artifact;
- **B2** explicit partial — successes ship with a manifest naming each failure
  and its typed reason (e.g. `invalid.pdf: UNSUPPORTED_DOCUMENT`,
  `signature-a4.pdf: SIGNATURE_UNSAFE`), in the archive and on screen;
- **B3** independent jobs — no archive, per-file results.

Today's behaviour is B2 without the manifest.

### The hardened lanes inside it

`normalizePageSize` and `updateTitleBlocks` enter unchanged: they are per-file
functions with typed thrown errors (`PageSizeNormalizeError`, `TitleBlockError`)
that map to `RESULT.FAILED` with their code. The orchestration adds, and only
adds:

- the common source inspection — today both lanes invalidate a signature
  without refusing (measured);
- ownership and a single publish;
- the batch policy.

It removes nothing either lane guarantees: annotation-exposure refusal,
orientation refusal, vector preservation, `/Rotate` handling and the
title-block Human workflow (representative page, measured orientation,
readiness) stay where they are. Their own gates pass unchanged (339, 20, 122,
31). An architecture that required weakening any of this would be rejected;
none does.

## 3. Monochrome

| candidate | what it is | measured |
| --- | --- | --- |
| **A** production | render → grey pixels → JPEG → new document | grey; removes text, OCR, vectors, annotations, links, forms, signature, XFA, metadata; ×86 on a vector page; A0 @300 ≈ 1 GiB RGBA per page; 600 dpi on A1/A0 fails mid-run |
| **B** colour operators | rewrite `rg/RG/k/K/g/G/cs/CS/sc/scn` in every content stream, Form XObject and annotation appearance; refuse anything else | grey, and keeps text, vectors, annotations, links, forms, metadata, boxes; 1,108 B on the vector page; **refuses every page that draws an image** |
| **C** hybrid | B plus exact re-encoding of Flate/DCT 8-bit DeviceRGB/Gray images as grey Flate; refuse other image classes | grey on all 14 inputs it accepted, including a saturated image (1.000 → 0.000) and production's own JPEG output; keeps the OCR layer; raster A4 147,665 B vs A's 1,176,256 B |

B alone is not a contract: on any document with an image it refuses, and
leaving the image in colour would be a partial conversion reported as
success. **C is a coherent contract** — fail-closed, total planning before any
write — on the synthetic corpus. What is not shown is how often real drawings
hit its refusals (ICC colour spaces, shadings, patterns, Type3 fonts, soft
masks, JBIG2/CCITT/JPX, 1-bit and 16-bit images). See `limitations.md`.

**Recommended (not adopted):** M5 MVP keeps A, but as an explicit
`INTENTIONAL_FLATTENING` operation with a confirmed loss list and a raster
preflight; C is taken forward as a follow-up spike measured on real drawings.
H1.

## 4. Optimize

| meaning | contract | measured |
| --- | --- | --- |
| **O1** flatten (production) | every page becomes a JPEG at 72/150/300 dpi | text and structure removed on every document; 6 of 8 larger at the default, up to ×153; ×0.18–0.92 only on image-heavy pages |
| **O2** lossless | re-save with object streams; nothing decoded | ×0.73–1.00; everything kept; never larger here |
| **O3** preservation levels | O2 + recompress large decodable images to the target DPI as JPEG, only when smaller; keep everything else | ×0.39–0.86; text, OCR, vectors, annotations, forms kept on every document; never larger here |

「最適化」 today is O1. A user reading 「解像度を調整してファイルサイズを削減します」
does not expect a vector drawing to become 35× larger and unsearchable.
**Recommended:** the name and the contract must agree — O1 renamed and
confirmed as flattening, and 「最適化」 meaning O3 (with O2 as its floor). H2.

## 5. Margin

| candidate | measured |
| --- | --- |
| **production** `embedPage` into a new document | keeps text, OCR, vectors, raster bytes (as a Form XObject); loses annotations, links, widgets, AcroForm, XFA, metadata; drops `/Rotate` (90/270 come back portrait and turned, 180 upside down); replaces the CropBox with the MediaBox; reveals hidden content |
| **in-place** `cm` wrapper + clip + annotation coordinate transform (`prototype/margin-inplace.mjs`) | keeps every measured property — text, OCR, annotations (moved), links, form value, XFA, metadata, `/Rotate`, CropBox; hidden content stays hidden; matches the independently computed expected picture on every rotation and crop fixture (mean difference 1.9–2.5) |

The in-place candidate refuses what it cannot do safely: content whose q/Q
nesting underflows, annotation types it does not know how to move, and
annotations outside the visible page that the scale would bring into view.
"Looks like vectors" is not "keeps the document": production's output renders
almost identically on an unrotated page and still has lost every page-level
object. **Recommended:** in-place. H3, H6.

## 6. Signatures, XFA, metadata

- Every Processor operation re-serialises. A signed document therefore cannot
  be processed without invalidating the signature (measured for Layer and both
  hardened lanes) or removing it (the flattening operations and Margin).
  Refuse before any byte exists, via `assessSource`. H7.
- XFA survives a plain pdf-lib load/save (Layer, both hardened lanes, the
  in-place candidates — none calls `getForm()`), and is dropped by every
  operation that builds a new document. H7.
- Every operation that loads with pdf-lib defaults rewrites Producer and
  ModDate; the rebuilding ones drop Title, Author and XMP entirely. H12.

## 7. Local only

Every measurement ran with zero external HTTP(S) requests, workers included;
PDF.js' worker is same-origin. Nothing proposed here needs a service, a CDN or
a new dependency: the prototypes use pdf-lib (its own Flate) and PDF.js as
already installed, and the browser's canvas and `createImageBitmap`.
