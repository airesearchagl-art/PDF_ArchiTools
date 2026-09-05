# M2-4 decision matrix

Three independent choices. Each row is scored from [`measurements.md`](./measurements.md); nothing here is an impression.

Legend: **++** measured strong · **+** measured adequate · **~** measured mixed · **−** measured weak · **−−** measured unusable · **n/m** not measured

---

## 1. Detection UX

| | A. full-page automatic | B. user-selected region | C. automatic candidates + confirmation |
|---|---|---|---|
| false tables on 8 drawing sheets | **10** (−−) | **0** (++) | **3**, with 7 held back (~) |
| tables found (shipped OCR) | 10 of 15 | 11 of 15 | 7 of 15 |
| tables found (segmentation fixed) | 14 of 15 | **15 of 15** | 8 of 15 |
| cell accuracy | 71% (~) | **91%** (++) | 87% (+) |
| exact grids | 7 of 10 | **10 of 11** | 6 of 7 |
| title block rejected | no (−−) | n/a — never selected (++) | no, confidence 81 (−) |
| aligned note columns rejected | no, confidence 95 (−−) | n/a (++) | no (−−) |
| user effort | none (++) | one drag per table (−) | one review per candidate (~) |
| effort on a 30-sheet set with 2 schedules | none, plus 30+ wrong tables to delete (−−) | 2 drags (+) | 30 sheets of candidates to review (−−) |
| per-region OCR segmentation possible | no (−) | **yes** (++) | partly (~) |
| failure mode when wrong | silent: a plausible spreadsheet of drawing furniture (−−) | visible: the user sees what they selected (++) | silent for what passes the gate (−) |

**B**, with C available later as an assist *inside* a chosen page. A is not a tuning problem: a ruled title block and a two-column schedule are the same structure, and the confidence scores of the false positives (95, 81, 73, 69) overlap the real ones.

## 2. Geometry signal

| | text geometry | ruling lines | hybrid |
|---|---|---|---|
| cell accuracy, full page | **0%** (−−) | 88% (+) | 71% (~) |
| cell accuracy, in a region | 69% (~) | 89% (+) | **91%** (++) |
| tables found in a region | 9 of 15 | 9 of 15 | **11 of 15** |
| borderless tables | **the only signal that finds them** (++) | cannot (−−) | inherits (++) |
| ruled tables | ~ | **exact** (++) | **exact** (++) |
| false positives on drawings | 10 (−−) | **1** (+) | 10 (−−) |
| cost at 20,000 tokens | **2,105 ms** (−−) | **123 ms** (++) | bounded by geometry (−) |
| available on a scanned page | yes (+) | no — no vector content (−−) | degrades to geometry (~) |
| implementation risk | thresholds everywhere (−) | decoding `constructPath`, verified 383/383 (+) | both (~) |

**Hybrid, ruling-first.** Ruling lines are exact where they exist and cheap; geometry is the only route to a borderless table and must be bounded before it is used. On scanned pages only geometry is available, which is a second reason scanned accuracy is lower.

Raster line detection (OpenCV or equivalent) was **not measured**: it is only needed for scanned pages, which are blocked by the segmentation defect regardless, and it would mean a new dependency this spike is not permitted to adopt. It stays open.

## 3. XLSX writer

| | A. hand-written OOXML + JSZip | B. SheetJS (`xlsx`) | C. ExcelJS |
|---|---|---|---|
| new dependency | **none** (++) | 7.5 MB, 7 deps (−) | 21.8 MB, 9 deps (−−) |
| version measured | — | 0.18.5 | 4.4.0 |
| licence | — | Apache-2.0 | MIT |
| npm listing last modified | — | 2026-07-17 | 2024-12-20 |
| output size, same workbook | **2,537 B** (++) | 18,601 B (~) | 7,691 B (+) |
| parts to maintain | 5 + 1 per sheet (~) | none (++) | none (++) |
| Japanese text and sheet names | **verified** (++) | assumed (n/m) | assumed (n/m) |
| merged cells | **verified, 3 read back** (++) | supported (n/m) | supported (n/m) |
| blank cells preserved | **verified** (++) | n/m | n/m |
| newline inside a cell | **verified** (++) | n/m | n/m |
| multiple sheets | **verified, 2** (++) | supported (n/m) | supported (n/m) |
| numbers vs identifiers | **verified: 12 numeric, 001 text** (++) | n/m | n/m |
| number formats, styling | **not supported** (−) | supported (++) | supported (++) |
| formulas | not supported (−) | supported (++) | supported (++) |
| deterministic output | **verified identical** (++) | n/m | n/m |
| macros / external relationships | **none, asserted** (++) | n/m | n/m |
| verified by an independent parser | **SheetJS and ExcelJS both open it** (++) | — | — |
| opened in Microsoft Excel | **no — not available here** | no | no |

**A.** It costs nothing, produces the smallest file, and is the only one of the three whose behaviour on this project's actual content has been measured rather than assumed. Its real limitation is formatting: without a styles part, `18500.50` displays as `18500.5`. String-first values make that moot for the MVP.

## 4. Value typing

| | everything as text | conservative numeric | aggressive |
|---|---|---|---|
| round-trip failures, 13 drawing values | **0** (++) | 1 (+) | 4 (−−) |
| values actually wrong | 0 | 0 | 1 (`1,200` → `1200`) |
| `001` survives | **yes** | yes | **no** → `1` |
| `1:100`, `D13@200`, `150A` survive | yes | yes | yes |
| `18500.50` survives | **yes** | no → `18500.5` | no |
| arithmetic works in Excel without retyping | no (−) | yes (+) | yes (+) |

**String-first for the MVP.** A drawing is full of identifiers that look like numbers, and a schedule read into Excel is usually re-keyed into a formula anyway. Conservative typing is a reasonable second release, behind a number-format part.

---

## Combined recommendation

**REVISE.** User-selected region · hybrid ruling-first geometry · hand-written OOXML · string-first values · fail-safe by default · scanned pages deferred until the OCR segmentation defect is fixed and re-measured.
