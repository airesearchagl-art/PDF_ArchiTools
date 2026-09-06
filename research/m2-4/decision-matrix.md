# M2-4 decision matrix

Four independent choices. Each row is scored from [`measurements.md`](./measurements.md); nothing here is an impression.

Legend: **++** measured strong · **+** measured adequate · **~** measured mixed · **−** measured weak · **−−** measured unusable · **n/m** not measured

> **Corrected from the first revision.** The "user-selected region" column previously showed 0 false positives. That figure came from selecting the ground-truth box, which does not exist on a page with no table — so no false positive was possible. It has been replaced by measured selection variants and by explicit adversarial selections.

---

## 1. Detection UX

| | A. full-page automatic | B. user-selected region | C. auto candidates + confirmation |
|---|---|---|---|
| false tables on 8 drawing sheets | **11** on 7 sheets (−−) | not applicable — the user chooses (see §2) | 5, with 14 held (~) |
| tables found (shipped OCR) | 13 of 18 | 18 of 18 selectable | 12 of 18 |
| cell accuracy | 63% (~) | **96% native / 32% scanned** (++/−) | 80% (+) |
| title block rejected | no (−−) | **no — the user can select one** (−) | no, and it clears the gate (−−) |
| aligned note columns rejected | no, confidence 95 (−−) | **no, confidence 95** (−) | no (−−) |
| user effort | none (++) | one drag per table (−) | one review per candidate (~) |
| effort on a 30-sheet set with 2 schedules | none, plus 30+ wrong tables to delete (−−) | 2 drags (+) | 30 sheets of candidates to review (−−) |
| per-region OCR segmentation possible | no (−) | **yes** (++) | partly (~) |
| failure mode when wrong | silent: a plausible spreadsheet of drawing furniture (−−) | **visible, but only if a preview is shown** (+) | silent for whatever clears the gate (−) |

**B**, with the explicit condition that a preview and confirmation follow it. B is not safe on its own: an explicit selection around a title block, a legend, a keynote list or two note columns still reaches `TABLE_CONFIDENT` in **4 of 8** cases. What B buys is that the user *asked* for that region and is looking at it — which only helps if they are then shown what came back.

A is not a tuning problem: the false positives score 95, 80, 72 and 72, overlapping the real tables.

## 2. Selection policy — the choice that matters most

Sixteen deterministic selection variants per table, plus over- and under-selection.

| | strict clipping | snap to page grids | **assist (snap, else strict)** |
|---|---|---|---|
| oracle box | 173/229 (76%) | 137/229 (60%) | **173/229 (76%)** (++) |
| robustness family (162) | 1057/2061 (51%) (−) | 1233/2061 (60%) (~) | **1514/2061 (73%)** (++) |
| under-selection (90) | 390/1145 (34%) (−−) | 685/1145 (60%) (~) | **792/1145 (69%)** (+) |
| over-selection (36) | 298/458 (65%) (+) | 274/458 (60%) (~) | **298/458 (65%)** (+) |
| box shifted 4 pt right | **24/229 (10%)** (−−) | 137/229 (60%) | **161/229 (70%)** (+) |
| box clipping the left border | **0/229 (0%)** (−−) | 137/229 (60%) | 137/229 (60%) (~) |
| box 1 pt inside every edge | 118/229 (52%) (−) | 137/229 (60%) | **173/229 (76%)** (++) |
| fabricated cells, robustness family | 17 (~) | **108** (−−) | **1** (++) |
| native pages, all variants | 65% (~) | 85% (+) | **96%** (++) |
| borderless tables | works when the box is right (+) | **fails — nothing to snap to** (−−) | works (+) |

**Assist.** Snap to an enclosing ruled grid when the selection sits on one, fall back to reading inside the rectangle when it does not. Strict alone makes the feature depend on the user's aim to within a couple of points; snap alone cannot see a borderless table and fabricates freely.

## 3. Geometry signal

| | text geometry | ruling lines | hybrid |
|---|---|---|---|
| cell accuracy, full page | 1% (−−) | 74% (+) | 63% (~) |
| cell accuracy, assist selection | — | — | **96% native** (++) |
| borderless tables | **the only signal that finds them** (++) | cannot (−−) | inherits (++) |
| ruled tables | ~ | **exact** (++) | **exact** (++) |
| false positives on drawings | 11 (−−) | **1** (+) | 11 (−−) |
| cost at 20,000 tokens | **2,105 ms** (−−) | **123 ms** (++) | bounded by geometry (−) |
| available on a scanned page | yes (+) | no — no vector content (−−) | degrades to geometry (~) |
| rotation | needs un-rotation (measured: 0/12 without, 12/12 with) | same | same |
| implementation risk | thresholds everywhere (−) | decoding `constructPath`, self-verified against pdf.js's own minMax (+) | both (~) |

**Hybrid, ruling-first.** Ruling lines are exact where they exist and cheap; geometry is the only route to a borderless table and must be bounded before use.

Raster line detection (OpenCV or equivalent) was **not measured**: it is only needed for scanned pages, which are blocked regardless, and it would mean a new dependency this spike cannot adopt. It stays open.

## 4. XLSX writer — refreshed against the official distribution

| | A. hand-written + JSZip | B. SheetJS CE 0.20.3 (official CDN) | B′. SheetJS 0.18.5 (npm, legacy) | C. ExcelJS 4.4.0 |
|---|---|---|---|---|
| new dependency | **none** (++) | 8.1 MB (−) | 7.5 MB (−) | 21.8 MB (−−) |
| runtime dependencies | — | **0** (+) | 7 (−) | 9 (−−) |
| licence | — | Apache-2.0 | Apache-2.0 | MIT |
| currency | — | **current CE release** | npm `latest`, superseded | last stable 2024-12-20 |
| output, same workbook | **2,537 B** (++) | 18,601 B (~) | 18,601 B (~) | 7,691 B (+) |
| parts to maintain | 5 + 1 per sheet (~) | none (++) | none (++) | none (++) |
| Japanese text and sheet names | **verified** (++) | verified as a reader (++) | verified as a reader (++) | verified as a reader (++) |
| merged cells | **verified, 3 read back** (++) | verified (++) | verified (++) | n/m |
| blank cells preserved | **verified** (++) | **verified absent, not a value** (++) | n/m | n/m |
| newline inside a cell | **verified** (++) | verified (++) | n/m | verified (++) |
| numbers vs identifiers | **verified: 12 numeric, 001 text** (++) | verified (++) | verified (++) | n/m |
| number formats, styling, formulas | **not supported** (−) | supported (++) | supported (++) | supported (++) |
| deterministic output | **verified identical** (++) | n/m | n/m | n/m |
| macros / external relationships | **none, asserted** (++) | n/m | n/m | n/m |
| opened in Microsoft Excel | **no — not available here** | no | no | no |

**A.** It costs nothing, produces the smallest file, and is the only one whose behaviour on this project's actual content has been measured rather than assumed. Refreshing SheetJS to the current CE release improved the candidate materially — zero runtime dependencies rather than seven — and did not change the conclusion: it is 8 MB of library to write a 2.5 KB file that already passes every check.

A's real limitation is formatting: with no styles part, `18500.50` displays as `18500.5`. String-first values make that moot for the MVP.

## 5. Value typing

| | everything as text | conservative numeric | aggressive |
|---|---|---|---|
| round-trip failures, 13 drawing values | **0** (++) | 1 (+) | 4 (−−) |
| values actually wrong | 0 | 0 | 1 (`1,200` → `1200`) |
| `001` survives | **yes** | yes | **no** → `1` |
| `1:100`, `D13@200`, `150A` survive | yes | yes | yes |
| `18500.50` survives | **yes** | no → `18500.5` | no |
| arithmetic works without retyping | no (−) | yes (+) | yes (+) |

**String-first for the MVP.** A drawing is full of identifiers that look like numbers. Conservative typing is a reasonable second release, behind a number-format part.

---

## Combined recommendation

**REVISE.** User-selected region · **assist selection policy (snap to the enclosing ruled grid)** · hybrid ruling-first geometry · un-rotation before reconstruction · **mandatory preview and explicit confirmation, because `TABLE_CONFIDENT` is a structural statement and 4 of 8 adversarial selections reach it** · hand-written OOXML with JSZip · string-first values · scanned pages deferred until the OCR segmentation defect is fixed and re-measured.
