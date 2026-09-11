# Decision matrix

Recommendations are marked; adoption is the Human Gate's (`human-gate.json`).
All numbers: M5 research gate, local branch run, `evidence.json`.

## Operation class, per operation

| operation | STRUCTURE_PRESERVING? | INTENTIONAL_FLATTENING? | evidence | open |
| --- | --- | --- | --- | --- |
| Layer | **yes** — keeps everything measured except the signature (invalidated) and Producer/ModDate | no | baseline row | H7, H12, H13a/b |
| Monochrome | **possible** (C, fail-closed) | **as built** (A) | C: 14/14 accepted inputs grey, structure kept | H1, H5 |
| Both | only if Monochrome is | **as built** — inherits every Monochrome loss | identical losses | H1 |
| Margin | **in-place, within its stated contract** | no | production loses page objects; in-place carries them or refuses | H3, H6 |
| Optimize | O2 yes; O3 within a lossy contract | **as built** (O1) | O1 up to ×463, text lost | H2a, H2b |
| 図面サイズ統一 / 図枠一括更新 | yes (hardened) | no | 339/339, 20/20, 122/122, 31/31; signature invalidated without refusal | H7 |

## Facts and policy (H7)

| operation → policy | annotator-equivalent | **refuse-if-dropped** | confirm-if-dropped |
| --- | --- | --- | --- |
| signed document, any operation | SIGNATURE_UNSAFE | SIGNATURE_UNSAFE | SIGNATURE_UNSAFE |
| XFA, Layer / Margin in-place / Mono C / O2 / O3 / hardened lanes | XFA_UNSAFE | **READY** | READY |
| XFA, Monochrome A / Optimize O1 | XFA_UNSAFE | **XFA_UNSAFE** | STRUCTURE_LOSS_REQUIRES_CONFIRMATION |
| ordinary form, flattening | STRUCTURE_LOSS_REQUIRES_CONFIRMATION | same | same |

## Monochrome

| | A — rasterise (production) | B — colour operators | C — B + images |
| --- | --- | --- | --- |
| native text / OCR | lost / lost | kept / refuses (image) | kept / kept |
| vectors, annotations, forms, metadata | lost | kept | kept |
| signature / XFA | removed / removed | per H7 / kept | per H7 / kept |
| size, vector A4 | 112,759 B | 1,108 B | 1,108 B |
| size, raster A4 | 1,176,256 B | refused | 147,665 B |
| memory | Raster Budget (A1@300 needs 1 GiB) | content streams | + one decoded image at a time |
| coverage | everything renders | refuses any image | refuses unsupported classes |
| real-drawing readiness | shipped | not claimed | **not claimed** |
| **recommendation** | **MVP, explicit confirmed flattening inside the Raster Budget** | not alone | **follow-up spike on real drawings** |

## Optimize

| | O1 flatten (production) | O2 lossless | O3 preservation levels |
| --- | --- | --- | --- |
| structure | removed | kept | kept |
| raster pixels | all re-rendered | untouched | recompressed (lossy) where smaller |
| size, vector A4 @150 | ×34.60 | ×0.85 | ×0.85 |
| size, mixed A4 @150 | ×1.68 | ×1.00 | ×0.39 |
| can grow a file | yes | no | no (swaps only when smaller) |
| shared-image planning | n/a | n/a | all uses, page-order independent; uncertain → not downsampled |
| fine-line scan @150 (line ink kept) | 22% | 100% | 26% (q0.8), 23% (q0.92) |
| fine-line scan @300 (line ink kept) | — | 100% | 100% at ×0.33 (q0.8), ×0.51 (q0.92) |
| **recommendation** | rename, confirm as flattening | **what 「最適化」 can promise now** | **pending H2b** (never below source resolution without a choice; q ≥ 0.8) |

## Margin

| | production (`embedPage`) | in-place |
| --- | --- | --- |
| text / OCR / vectors | kept (Form XObject) | kept |
| annotations / links | lost | kept, moved |
| internal destinations (XYZ, FitR, named, outline) | lost with their links | moved with their target page, exact |
| partly clipped annotation | lost (with the rest) | **refused** before any change |
| widgets | lost | kept; `/DA` and border scaled (regenerated text ×0.78, not ×1.00) |
| forms / XFA / metadata | lost | kept |
| `/Rotate` / CropBox | dropped / discarded | kept / kept |
| hidden content | revealed | clipped |
| **recommendation** | | **adopt, with the stated refusals** |

## Batch

| | B1 fail whole | **B2 explicit partial** | B3 independent |
| --- | --- | --- | --- |
| `[ok, invalid, text, signed]` | FAILED, 0 published | PARTIAL, 1 archive of 2 + manifest | PARTIAL, 2 downloads as they finish |
| superseded mid-batch | nothing | nothing | only what already finished |
| a failure can be missed | no | no (manifest + UI) | no (per-file state) |
| **recommendation** | | **B2** | |

## Raster Budget (H8, H9)

| | 64 Mi px | **128 Mi px** | 256 Mi px |
| --- | --- | --- | --- |
| admits (raster only) | up to A3@300, A1@150, A0@150 | + A3@600, A1@300 | + A0@300 |
| refuses | A3@600, A1@300, A0@300, all @600 on A1/A0 | A0@300, A1/A0@600 | A1/A0@600 |
| **recommendation** | | **policy ceiling + runtime allocation probe** | above one machine's measured success, too close to its failure |

Memory: **512 MiB default, explicit 1 GiB / 2 GiB**; output **256 MiB**.

## Layer stacking (H13b)

| | below annotations (production) | above annotations |
| --- | --- | --- |
| how | rectangle in the content stream | one more annotation, painted last |
| annotations faded | no (`[0,0,255]` stays) | yes (`[128,128,255]`) |
| flattening / rewriting | none | none |
| side effect | none | the layer is an annotation (selectable, deletable, printed by /F) |
| **recommendation** | **below, stated in the UI** | only if accepted as an annotation |

## Orchestration

| | one PLAN/RESULT engine | per-tool engines |
| --- | --- | --- |
| facts and H7 policy | once, SourceFacts, for all 7 | seven chances to forget (two lanes already have) |
| Raster Budget, ownership, batch, publish | once | per tool |
| hardened lanes | unchanged behind the facts step | unchanged |
| **recommendation** | **one engine, per-operation planners and runners** | |
