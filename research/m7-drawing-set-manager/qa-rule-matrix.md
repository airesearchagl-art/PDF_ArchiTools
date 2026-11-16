# Drawing Set QA rule matrix (R8)

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**
> A proposal for Independent Architecture Review. Nothing here is adopted.
> Prototype: `prototype/qa-rules.mjs`, `prototype/currency.mjs`. Tests: `tests/qa-rules.test.mjs`,
> `tests/declared-register.test.mjs`, `tests/final-readiness.test.mjs`, `tests/reuse-parity.test.mjs`.
>
> Revised after Independent Architecture Review of `4139133`: **RF-33-01** (only `INTENTIONAL` lifts the
> metadata-confirmation requirement) and **RF-33-02** (QA09 is a Human-declared Drawing Register against the
> actual Sheets; the Sheet-list / page-inventory check moved to QA10). §7 records what changed.

The ten QA items of Product Definition v1, sorted into what a machine can state and what it can only ask.

## 1. What "deterministic" and "candidate" mean here

| Class | The rule's statement is… | Example |
|---|---|---|
| **DETERMINISTIC** | a fact that follows mechanically from the recorded values. No threshold, no model of what a drawing set "should" look like. Anyone given the same values reaches the same statement. | "these three sheets carry the drawing number `A-101`" |
| **CANDIDATE** | that a pattern holds, under a stated heuristic. It is a question, and the answer may well be "that is intended". | "`A-103` is absent between `A-102` and `A-104`" |

Two things this classification does **not** say:

- **Neither class says a drawing is wrong.** A duplicate number is a fact; whether it is a mistake is a
  person's decision. No rule infers design intent, and none closes itself. This is the boundary the Task
  Packet draws ("設計内容の正否をAIが推測する機能へ広げない"), and every rule below stays inside it.
- **Deterministic is about the rule, not about its inputs.** A deterministic rule over a value that only the
  OCR has read is a true statement about an unconfirmed value. The two axes are separate:

| | Inputs all Human-confirmed | Some input only machine-observed |
|---|---|---|
| **DETERMINISTIC rule** | a fact about confirmed values | a fact about values nobody has stood behind yet |
| **CANDIDATE rule** | a question about confirmed values | a question about unconfirmed values |

Whether a finding's inputs are confirmed is **derived** from the sheets it cites, not stored on it, so it
cannot go out of date. A Final QA Report needs every sheet's metadata confirmed anyway (§4), so at Final
every finding is in the left-hand column.

## 2. Human-confirmed values and machine-observed values

One rule for every QA rule that reads sheet metadata (`sheetCurrency` in `prototype/currency.mjs`):

1. If the sheet's **confirmation** stands (same bytes, same profile arrangement) → read the confirmed values.
2. Else if its **observation** stands and was read successfully → read the observed values.
3. Else the sheet has **no effective values**. It is read by no metadata rule and is reported by QA02.

The machine's reading is never overwritten by a correction and a score never promotes it — both are the
existing Drawing Register's rules (`drawing-register-types.ts`: "A row is a candidate until a person says
otherwise. Confidence never promotes a row").

The **declared Drawing Register** (QA09) is Human-declared by construction: it exists only because a person
pointed at a list and accepted its rows. There is no "machine-observed register" state in the model.

## 3. The matrix

`Scope` is what a finding is about. `Dependency` is what its truth depends on, which decides when it can be
closed and when it is unverified (§5).

| # | Product Definition item | Rule id | Class | Required inputs | Normalisation | Scope | Dependency |
|---|---|---|---|---|---|---|---|
| 1 | drawing-number duplicate | `QA01_DUPLICATE_NUMBER` | **DETERMINISTIC** | effective `drawingNumber` of ≥ 2 sheets | trim only | sheet group | the member sheets |
| 1 | — the same number written differently | `QA01B_DUPLICATE_NUMBER_VARIANT` | CANDIDATE | effective `drawingNumber` | NFKC, case, dash variants, spacing, invisible format characters folded | sheet group | the member sheets |
| 2 | title-block unread / metadata unconfirmed | `QA02_METADATA_UNCONFIRMED` | **DETERMINISTIC** | the sheet's confirmation and observation state | none | one sheet | that sheet |
| 3 | possible drawing-number gap | `QA03_NUMBER_GAP` | CANDIDATE | effective `drawingNumber` of every sheet | comparison key, then split into prefix / number / suffix | set | **the whole set** |
| 4 | same number / different title | `QA04_SAME_NUMBER_DIFFERENT_TITLE` | **DETERMINISTIC** | a QA01 group; effective `drawingTitle` | trim; blank is unknown, not different | sheet group | the member sheets |
| 5 | revision mismatch | `QA05_REVISION_MISMATCH` | **DETERMINISTIC** | a QA01 group; effective `revision` | trim; blank is unknown | sheet group | the member sheets |
| 6 | issue-date mismatch | `QA06_ISSUE_DATE_MISMATCH` | **DETERMINISTIC** | a QA01 group; effective `issueDate` | unambiguous numeric dates to ISO; anything else compared as text; blank is unknown | sheet group | the member sheets |
| 7 | sheet-size outlier | `QA07_SHEET_SIZE_OUTLIER` | CANDIDATE | page facts of every sheet | A-series class, 5 mm tolerance (the normaliser's `detectPaperSize`) | sheet group | **the whole set** |
| 8 | orientation outlier | `QA08_ORIENTATION_OUTLIER` | CANDIDATE | page facts of every sheet | orientation as displayed (after `/Rotate`); square counts as landscape | sheet group | **the whole set** |
| 9 | drawing-register vs actual-sheet mismatch | `QA09_REGISTER_SHEET_MISMATCH` | **DETERMINISTIC** | a **declared Drawing Register**; effective `drawingNumber` of every sheet | trim only (a folded spelling is a hint, never a match) | one register entry, or one sheet | **the declared register as a whole**, and the whole set |
| 10 | Source / Project integrity abnormality | `QA10_INTEGRITY` | **DETERMINISTIC** | runtime binding state; import warnings; the manifest (Sheets vs each Source's page count) | none | one Source, or the Project | binding state this session; the manifest |

### Per-rule detail

#### QA01 — duplicate drawing number · DETERMINISTIC
- **States:** "these *n* sheets have the drawing number *X*." One finding per number, citing every member.
- **Normalisation:** `trim()` and nothing else — the existing `findDuplicates`
  (`src/utils/pdf-textifier/drawing-register.ts`), which declines to merge `A-101` and `A101` because "a
  tool that quietly merges them has made a decision the user never saw". `tests/reuse-parity.test.mjs` runs
  the Production function and the prototype on the same twelve numbers and requires identical groups.
- **Empty numbers** are never duplicates of each other.
- **False-positive risk:** low as a fact. Legitimately repeated numbers exist (a key plan on several sheets,
  a superseded sheet left in on purpose) — that is `INTENTIONAL`, not a wrong finding.
- **Bulk review:** per group. A group is one decision.
- **Stale trigger:** a member's Source replaced. **Superseded when** membership or a member's value changes.

#### QA01B — the same number, written differently · CANDIDATE
- **States:** "these sheets' numbers are equal once width, case, dashes and spacing are folded, and are not
  written identically." `Ａ－１０１` and `A-101`; `a-101` and `A-101`; a Unicode hyphen (U+2010) and `-`.
- **Why it is separate from QA01:** folding is a judgement about which differences do not matter. The fold
  is deliberately narrow — it never inserts a missing hyphen (`A101` stays apart) and never strips a leading
  zero. It only decides what this rule *asks about*; it never feeds a DETERMINISTIC rule or changes a value.
- **False-positive risk:** moderate. **Bulk review:** per group.
- **Status:** a sub-tier this research adds to item 1. If the Human Gate does not want it, removing it
  changes nothing else. See Unresolved U-13.

#### QA02 — title block unread / metadata unconfirmed · DETERMINISTIC
- **States:** "no person currently stands behind this sheet's metadata", with the reason:
  `NOT_READ` · `UNCONFIRMED` · `OCR_FAILED` · `READ_IS_STALE` · `RECONFIRM_REQUIRED`.
- **Resolved by doing the work, not by a decision:** confirming the sheet makes the next run stop stating
  the finding (`NOT_REPRODUCED`). Nobody "closes" it.
- **Exactly one decision lifts the metadata-confirmation requirement: `INTENTIONAL`** — a person deciding,
  on the record, that metadata is intentionally not applicable for this sheet (a cover sheet with no title
  block). The exemption is that decision; it is not a flag, and it does not outlive the evidence it was made
  on (replace the Source and it is history).
- **`FALSE_POSITIVE` does not lift it.** QA02 is a deterministic statement of a fact, so it cannot be
  "false" while the sheet is unconfirmed. If a person believes the finding is wrong, the answer is to
  correct the underlying state — confirm the sheet — after which the next run does not reproduce QA02 at
  all. Letting `FALSE_POSITIVE` clear the blocker would let a Final report go out over metadata nobody
  confirmed and nobody declared unnecessary. *(RF-33-01. The research's first proposal allowed it.)*
- **`ACTION_REQUIRED` and `HOLD` do not lift it:** they say the work is still to do.
- **False-positive risk:** none as a fact. **Bulk review:** yes — this is the rule that most needs it (a
  fresh 5000-sheet set has 5000 of these).

| QA02 finding with… | Counts as reviewed | Lifts `METADATA_NOT_CONFIRMED` for that sheet |
|---|---|---|
| no decision | no | no |
| `INTENTIONAL` | yes | **yes** |
| `FALSE_POSITIVE` | yes | **no** — confirm the sheet instead |
| `ACTION_REQUIRED` | yes | no |
| `HOLD` | yes (U-1) | no |
| the sheet is then confirmed | — (the finding is `NOT_REPRODUCED`) | the requirement is met |

#### QA03 — possible drawing-number gap · CANDIDATE
- **States:** "within the series *prefix…suffix*, the numbers *a+1 … b-1* are absent between *a* and *b*,
  which are present." One finding per missing run; the two neighbours are the cited evidence.
- **Series:** the comparison key split as `prefix` + digits + `suffix` (`A-101a` → `A-`, 101, `A`). Sheets
  are grouped by (prefix, suffix); numbers that do not end in digits-then-non-digits take no part.
- **Bound:** only runs of at most `MAX_REPORTED_GAP_RUN` (= 5, a **candidate product parameter**) missing
  numbers are reported, so `A-112 → A-201` is a new group, not a gap of 88.
- **False-positive risk: high.** Numbering schemes skip on purpose. This is the rule most likely to be
  answered `INTENTIONAL` in bulk, and a set that turns out to be all noise is a reason to switch the rule
  off per Project (not designed here).
- **Bulk review:** yes. **Set-wide:** adding or removing any sheet can create or remove a gap.

#### QA04 / QA05 / QA06 — same number, different title / revision / issue date · DETERMINISTIC
- **State:** "the sheets numbered *X* carry these *k* different titles (revisions, dates)."
- **Emitted in addition to QA01** for the same group, because they say different things: QA01 alone is "the
  same sheet twice"; QA04 is "two drawings share a number"; QA05 is "two revisions of one drawing are both in
  the set" — the superseded-sheet-left-in case, which is the commonest real one.
- **Blank is unknown, not different.** A sheet whose title could not be read does not make a title
  mismatch.
- **QA06 date comparison:** two spellings of one unambiguous date are one date (`2026.10.05`, `2026/10/5`,
  `２０２６．１０．５`, `2026年10月5日`). An era date (`R8.10.5`) or anything else is **not interpreted**; it is
  compared as text. Guessing a date is a quiet decision this tool does not make.
- **False-positive risk:** low as facts.
- **These are the proposed *MVP* semantics, and they are narrower than the item names might suggest.**
  "Revision mismatch" could also mean "differs from the revision this issue is supposed to be". That needs
  an expectation **declared by a person** — and the declared Drawing Register (QA09) is now a place such an
  expectation could come from, since a register row may carry a revision and a date. Comparing a sheet's
  revision or date with its register row is **not designed here**; inferring an expectation from the
  majority would be exactly the guess the Task Packet rules out. See Unresolved U-2.

#### QA07 / QA08 — sheet-size / orientation outlier · CANDIDATE
- **State:** "these *k* sheets are *A3* (portrait) while *m* of the set's sheets are *A1* (landscape)."
  One finding per minority class.
- **Majority:** a class held by **more than half** of the evaluated sheets. With no majority there is no
  outlier and nothing is reported — a set that is genuinely mixed is not flagged sheet by sheet.
- **Size class:** `detectPaperSize` (A0–A4, short and long edge within 5 mm), else `OTHER`.
  **Orientation:** as displayed, i.e. after `/Rotate`; a square page is landscape — both from
  `src/utils/page-size-normalizer.ts`. `tests/reuse-parity.test.mjs` compares the prototype against the
  Production function on 2 350 sizes, including every A-size at ±5 mm; it caught the prototype's first
  mirror disagreeing at exactly 5 mm, which is why the recommendation is to import the function, not copy it.
- **Inputs are page boxes**, not recognition: the visible box (CropBox within MediaBox). No OCR involved.
- **False-positive risk:** moderate (A3 detail sheets in an A1 set are normal). **Bulk review:** the group is
  one decision.

#### QA09 — declared Drawing Register vs actual Sheets · DETERMINISTIC
*(RF-33-02. The research's first proposal used this item for M7's own Sheet list against the PDF page
inventory. That check is kept — as QA10 — and QA09 has the meaning the M7 discussion intended.)*

- **What is compared:** a **Drawing Register a person declared** (図面一覧) with the **live Sheets** of the
  Drawing Set. The register is optional and is never inferred: a person designates the list — which page of
  which Source, where on the page — and accepts its rows (`data-model.proposed.md` §2A).
- **States, exactly two things:**

  | Reason | Statement | Scope / cites |
  |---|---|---|
  | `LISTED_BUT_MISSING` | "the declared register lists drawing number *X*, and no live Sheet carries it" | one register entry |
  | `ACTUAL_NOT_LISTED` | "a live Sheet carries drawing number *X*, and no entry of the declared register does" | one Sheet |

- **Correspondence** is the drawing number under `trim()` — the same exact key as QA01. When the other side
  holds a number that would match once folded (`Ａ－１０２` against `A-102`), the finding names that spelling
  as a **hint** (`params.values`); it is never counted as a match. A register typed in full-width against
  title blocks in half-width therefore produces findings on both sides, each pointing at the other, and a
  person corrects whichever is wrong. Whether folded spellings should correspond is Unresolved U-3.
- **A Sheet with an empty drawing number is outside QA09** (it has nothing to be listed under), and a Sheet
  nobody has read is not evaluated at all — QA02 reports it.
- **If no Drawing Register is declared, QA09 is `NOT_EVALUABLE`: no finding — and not a pass.** The
  Final-readiness result carries `notEvaluable: [{ QA09, NO_DECLARED_REGISTER }]` so that a report says "the
  set was not compared with a drawing list", never "no mismatch". It does not block Final: the register is
  optional.
- **If a declared register is no longer current** (its Source's bytes were replaced after it was declared),
  QA09 is not evaluated either — nothing is compared with a list nobody has declared against the new bytes —
  and **that does block Final** (`REGISTER_NOT_CURRENT`): a person asked for this comparison and it cannot be
  made until the register is declared again.
- **Several references are one register.** A list that runs over several pages is several
  `DrawingRegisterReference`s; QA09 compares the Sheets with all live entries together.
- **False-positive risk:** none as facts under the exact key; the *noise* risk is spelling differences
  between a list and the title blocks (above), and a register read from a table whose heading row was taken
  as an entry — which a person removes (the row is retired, and the finding is closed, not deleted).
- **Bulk review:** yes, for both reasons (a set under issue is routinely missing listed sheets).
- **Not designed here:** comparing a Sheet's *title, revision or date* with its register row; a register
  that does not come from a page of a Source in the set (an external list); OCR of a scanned list page (the
  existing table engine reads native text only — a scanned list is declared by typing it, `method: MANUAL`).

#### QA10 — Source / Project integrity · DETERMINISTIC
- **States:**

  | Reason | Statement | Needs |
  |---|---|---|
  | `SOURCE_MISSING` · `SOURCE_CHANGED` · `SOURCE_AMBIGUOUS` | this Source is not the bytes the Project remembers | this session's binding |
  | `PAGE_WITHOUT_SHEET` | the PDF has pages no live Sheet represents | the manifest only |
  | `SHEET_WITHOUT_PAGE` | a live Sheet's page number is beyond its Source's page count — what a shorter replacement leaves behind | the manifest only |
  | `PROJECT_FILE_ANOMALY` | an accepted file carried warnings (a timestamp in the future, an order that does not add up) | the import warnings |

- **`PAGE_WITHOUT_SHEET` and `SHEET_WITHOUT_PAGE` are bookkeeping**, not statements about the drawings: M7's
  own Sheet list no longer agrees with the page inventory of a Source. That is a Project-integrity fact,
  which is why it belongs here and not under QA09. *(RF-33-02.)*
- **`UNBOUND` is not an abnormality.** A Source nobody has looked for yet is not evaluated, and a finding
  from an earlier session is not closed by a run that did not re-check it.
- **A decision does not waive a missing Source.** Final requires every Source `MATCHED` independently of any
  decision here (§4). `PROJECT_FILE_ANOMALY` can be decided like any finding — a wrong clock is permanent in
  the file, and it must be possible to say so and move on.
- **Bulk review:** no; each is resolved in the model (bind the Source, add or retire Sheets).

## 4. Effect on the Final QA condition

Completion is **"no unreviewed current finding"**, not "no findings" (adopted contract M). The proposed
gate (`finalReadiness`, `prototype/currency.mjs`; `tests/final-readiness.test.mjs`):

| Blocker | Condition |
|---|---|
| `SOURCES_NOT_MATCHED` | a live Source is not `MATCHED` this session — **independently of every decision** |
| `METADATA_NOT_CONFIRMED` | a live sheet has no standing confirmation, and its current QA02 finding does not carry an effective **`INTENTIONAL`** decision |
| `REGISTER_NOT_CURRENT` | a declared Drawing Register was declared from bytes its Source no longer has |
| `FINDINGS_NOT_CURRENT` | an `ACTIVE` finding is `STALE` or `UNVERIFIED` |
| `FINDINGS_UNREVIEWED` | an `ACTIVE`, `CURRENT` finding has no decision |
| `FINDINGS_ON_HOLD` | *(only if the Human Gate chooses so)* an effective decision is `HOLD` |

And beside the blockers, **what was not evaluated**:

| `notEvaluable` | Meaning | Blocks Final |
|---|---|---|
| `QA09` / `NO_DECLARED_REGISTER` | no register was declared; the set was not compared with a drawing list | no — the register is optional — but the report must say so |
| `QA09` / `DECLARED_REGISTER_NOT_CURRENT` | a register is declared and is stale | yes, through `REGISTER_NOT_CURRENT` |

| Rule | Blocks Final while undecided | Decision can clear it | Notes |
|---|---|---|---|
| QA01, QA01B, QA03–QA08 | yes | any of the four outcomes | `ACTION_REQUIRED` is a review: the report lists it as open work |
| QA02 | yes | a decision makes it *reviewed*; **only `INTENTIONAL` clears the metadata blocker** | otherwise confirm the sheet |
| QA09 | yes | any outcome | usually `ACTION_REQUIRED` (a listed sheet not yet issued) or `INTENTIONAL` |
| QA10 `SOURCE_*` | yes | a decision clears the finding, **not** `SOURCES_NOT_MATCHED` | |
| QA10 `PAGE_WITHOUT_SHEET` / `SHEET_WITHOUT_PAGE` | yes | any outcome | usually resolved in the model instead |
| QA10 `PROJECT_FILE_ANOMALY` | yes | any outcome | |

**`HOLD`.** By the letter of the adopted contract `HOLD` is one of the four Human outcomes, so a held finding
is reviewed and the default follows the letter. Whether a report with held findings may be called *Final*
is a product question; the prototype makes it one option (`holdBlocksFinal`). See Unresolved U-1.

## 5. Stale triggers and closing rules

A finding is identified by its **key** (the question) and versioned by its **evidence** (the grounds: the
rule's version, the sheets and register entries it cites, the fingerprint each was read from, and the values
that make it true).

| On the next run… | Result |
|---|---|
| same key, same evidence | the same finding; nothing is written; its decision stands |
| same key, different evidence | a new finding; the old one `SUPERSEDED`; its decision becomes history |
| key not stated, and the run **could** evaluate it | the old finding `NOT_REPRODUCED` |
| key not stated, and the run **could not** evaluate it | left `ACTIVE`; it is `STALE` or `UNVERIFIED` |

"Could evaluate", by dependency:

| Dependency | Rules | A run can close a finding only if… |
|---|---|---|
| the member sheets | QA01, QA01B, QA04–QA06 | every cited live sheet has effective values |
| the whole set — metadata | QA03 | **every** live sheet has effective values |
| the whole set — page facts | QA07, QA08 | **every** live sheet has current page facts |
| one sheet | QA02 | always |
| the declared register | QA09 | the register is **current** (and the cited sheet has effective values) — **or no register is declared any more**, in which case the rule no longer applies and its findings are closed |
| the manifest | QA10 `PAGE_WITHOUT_SHEET` / `SHEET_WITHOUT_PAGE` | always |
| binding state | QA10 `SOURCE_*` | that Source's binding was evaluated (it is not `UNBOUND`) |
| the import warnings | QA10 `PROJECT_FILE_ANOMALY` | the run was given the import warnings |

QA09 in particular:

| Change | What happens to QA09 |
|---|---|
| A person corrects a register row, or a sheet's number | re-evaluated; a finding the correction resolves is `NOT_REPRODUCED` |
| A person retires a row (a heading read as an entry) | the finding citing it is `STALE` until the next run, then `NOT_REPRODUCED`; the row stays in the file |
| The register's Source is replaced | the register is `STALE`; QA09 is not evaluated; its findings stay `ACTIVE` and are `STALE`; Final is blocked |
| The register is declared again | a **new** reference and new entries; the old reference is retired; old findings are closed, new ones are unreviewed; old decisions are history |
| The register is withdrawn | its findings are `NOT_REPRODUCED` on the next run; QA09 is `NOT_EVALUABLE` again |
| A sheet has not been read | `LISTED_BUT_MISSING` findings are `UNVERIFIED` — the unread sheet might be the one |

So one replaced Source makes the findings that *cite* it `STALE`, makes the set-wide candidates
`UNVERIFIED` until the set is whole again, and leaves every other finding — and every decision — exactly as
it was (`tests/stale.test.mjs`).

## 6. Cost

Every rule reads only what is already in the model. Evaluating all of them over 5000 sheets took
≈ 27 ms on a page thread in Chrome and ≈ 26 ms in Node; with nothing confirmed (5 607 findings) ≈ 62 ms and
≈ 46 ms (`benchmark/results/SUMMARY.md` §4–5). With a declared register of 4 898 rows the same evaluation
took under 60 ms. That is what allows "re-evaluate after every change" in place of dependency tracking for
metadata edits, and why a re-evaluation that changes nothing writes nothing — no run record, no growth of
the file (`tests/roundtrip.test.mjs`).

## 7. What Independent Architecture Review changed

| Finding | The first proposal (`4139133`) | Now |
|---|---|---|
| **RF-33-01** | `INTENTIONAL` **or `FALSE_POSITIVE`** on a QA02 finding exempted the sheet from "required metadata confirmed" | only `INTENTIONAL` does; a QA02 that is believed wrong is answered by confirming the sheet |
| **RF-33-02** | QA09 compared M7's own Sheet list with each Source's page count (`PAGE_WITHOUT_SHEET`, `SHEET_WITHOUT_PAGE`) | QA09 compares a Human-declared Drawing Register with the actual Sheets (`LISTED_BUT_MISSING`, `ACTUAL_NOT_LISTED`); the page-inventory check is QA10 |
