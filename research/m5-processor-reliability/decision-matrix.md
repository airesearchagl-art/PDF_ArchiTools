# Decision matrix

Recommendations are marked; adoption is the Human Gate's (`human-gate.json`).

## Operation class, per operation

| operation | fits STRUCTURE_PRESERVING? | fits INTENTIONAL_FLATTENING? | evidence | open |
| --- | --- | --- | --- | --- |
| Layer | **yes** — keeps everything measured except the signature (invalidated) and Producer/ModDate | no | baseline row | H7, H12, H13 |
| Monochrome | **possible** (candidate C, fail-closed) | **as built** (candidate A) | 14/14 accepted inputs grey under C with structure kept | H1, H5 |
| Both | only if Monochrome is | **as built** — inherits every Monochrome loss | baseline row: identical losses | H1 |
| Margin | **should be** — in-place keeps everything measured | no | production loses page objects; in-place keeps them | H3, H6 |
| Optimize | **possible** (O2/O3) | **as built** (O1) | O1 up to ×463 and text lost; O3 ≤ ×0.86 with structure kept | H2 |
| 図面サイズ統一 | yes (hardened) | no | 339/339 + 20/20; signature invalidated without refusal | H7 |
| 図枠一括更新 | yes (hardened) | no | 122/122 + 31/31; signature invalidated without refusal | H7 |

## Monochrome

| | A — rasterise (production) | B — colour operators | C — B + images |
| --- | --- | --- | --- |
| simplicity | simplest | moderate (lexer, planner) | moderate + image decode |
| visual correctness | grey; JPEG q0.8 artefacts | grey where it converts | grey where it converts |
| native text / OCR | lost / lost | kept / refuses (image) | kept / kept |
| vectors | lost | kept | kept |
| annotations / forms | lost / lost | kept, colours converted | kept |
| signature / XFA | removed / removed | refuse via PLAN / kept | refuse via PLAN / kept |
| metadata | lost | kept | kept |
| file size, vector A4 | 112,759 B | 1,108 B | 1,108 B |
| file size, raster A4 | 1,176,256 B | refused | 147,665 B |
| memory | 8·W·H per page; A0 @300 ≈ 1 GiB | content streams only | + one decoded image at a time |
| large drawings | 600 dpi on A1/A0 fails mid-run | resolution-free | resolution-free |
| coverage | everything renders | refuses any image | refuses unsupported classes (ICC, Indexed, 1/16-bit, JPX, JBIG2, CCITT, shading, pattern, Type3, soft mask) |
| real-drawing readiness | shipped | not claimed | **not claimed** — synthetic corpus only |
| **recommendation** | **MVP, as explicit flattening with confirmed losses** | not alone | **follow-up spike on real drawings** |

## Optimize

| | O1 flatten (production) | O2 lossless | O3 preservation levels |
| --- | --- | --- | --- |
| structure | removed | kept | kept |
| size, vector A4 @150 | ×34.60 | ×0.85 | ×0.85 |
| size, raster A4 @150 | ×0.92 | ×1.00 | ×0.46 |
| size, mixed A4 @150 | ×1.68 | ×1.00 | ×0.39 |
| can make a file larger | yes, 6 of 8 | no (here) | no (swaps an image only if smaller) |
| matches 「最適化」/「ファイルサイズを削減」 | no | partly | yes |
| **recommendation** | rename, confirm as flattening | floor of O3 | **「最適化」** |

## Margin

| | production (`embedPage`) | in-place |
| --- | --- | --- |
| text / OCR / vectors | kept (Form XObject) | kept |
| annotations / links | lost | kept, moved |
| forms / XFA | lost | kept |
| metadata | lost | kept |
| `/Rotate` | dropped; 90/270 turned, 180 upside down | kept; margin at the visible corner |
| CropBox | replaced by MediaBox | kept |
| hidden content | revealed | clipped |
| expected picture (rotate-180) | 4.6 | 2.1 |
| refusals | none (loses silently) | q/Q underflow, unknown annotation, out-of-view annotation |
| **recommendation** | | **adopt** |

## Batch

| | B1 fail whole | B2 explicit partial | B3 independent |
| --- | --- | --- | --- |
| one bad file among three | nothing | 2 files + manifest naming the failure | 2 results, 1 failure, no archive |
| user can miss a failure | no | no (manifest + UI) | no |
| today | — | **today, minus the manifest** | — |
| **recommendation** | | **B2** | |

## Orchestration

| | one PLAN/RESULT engine | per-tool engines |
| --- | --- | --- |
| signature/XFA inspection | once, `assessSource`, for all 7 | seven chances to forget (two hardened lanes already have) |
| ownership / publish | once | per tool |
| hardened lanes | unchanged behind the common inspection | unchanged |
| **recommendation** | **one engine, per-operation planners and runners** | |
