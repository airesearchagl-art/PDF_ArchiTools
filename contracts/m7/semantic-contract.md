# M7 Portable Project — semantic contract v1

**Canonical pre-release contract.** M7 Architecture v1, Human Architecture Adopted 2026-10-09; published by
M7-CAN-01 (authorized 2026-10-09). `schemaVersion` 1. No user-writable format is released until M7-P4.

This is the human-readable statement of the relation and lifecycle contract of the M7 Portable Project JSON.
It is **not a new design**: every rule here comes from M7 Architecture v1 and its Human decision values, and
from the artifacts reviewed at PR #33 exact head `e541d1d43db3a73acceb3f8241ef914d59dc77d7` (see
[Sources](#sources)). Nothing in this directory is wired into the Production app yet.

## How to read it — where each rule lives

| Mark | Enforced by | When | On violation |
|---|---|---|---|
| **S** | `portable-project.schema.json` | import; export validates its own output the same way | the file is refused |
| **R** | `portable-project.semantic.mjs`, a *problem* (`REL_*`) | import, after the schema accepts | the file is refused whole |
| **W** | `portable-project.semantic.mjs`, a *warning* (`WARN_*`) | import | the file is accepted; the oddity becomes a QA10 `PROJECT_FILE_ANOMALY` finding |
| **D** | derived at runtime, never stored | M7-P1…P4 implementation (not present in the app yet) | as the rule says |

The two machine-readable files are canonical for **S**, **R** and **W**; for **D** this document, with
Architecture v1, is the contract the later phases implement. If this document and the machine-readable files
disagree, that is a defect in this document, corrected through review.

A problem is a state the app could never have written; a warning is a state it could have written under an
odd circumstance (a clock set wrong). **A file is never repaired**: there is no "skip the bad entry" path —
an import that quietly drops a dangling decision has changed a review record without anyone deciding to.

## The ten entity types

| # | Entity | Stored at | Identity | Lifecycle |
|---|---|---|---|---|
| 1 | Project | `project` | `id` | one per file |
| 2 | Drawing Set | `drawingSet` | `id` | exactly one per Project in M7; owns the seven collections |
| 3 | Source | `drawingSet.sources[]` | `id` — the slot, not the bytes | retired, never deleted |
| 4 | Title Block Profile | `drawingSet.titleBlockProfiles[]` | `id` (+ `revision`) | retired, never deleted |
| 5 | Sheet | `drawingSet.sheets[]` | `id` | retired, never deleted |
| 6 | Drawing Register Reference | `drawingSet.drawingRegisterReferences[]` | `id` | optional; fixed basis; retired, never deleted |
| 7 | Register Entry | `drawingRegisterReferences[].entries[]` | `id` | one reference for life; retired, never deleted |
| 8 | Analysis Run | `drawingSet.analysisRuns[]` | `id` | append-only |
| 9 | QA Finding | `drawingSet.findings[]` | `id`; its question is `findingKey` | immutable apart from `lifecycle` |
| 10 | Review Decision | `drawingSet.decisions[]` | `id`; `sequence` within its Finding | append-only |

The envelope around them — `format`, `schemaVersion`, `projectFileId`, `lineage`, `savedAt`, `writer` — is
not an entity. The collections are **flat and related by UUID**; the one nested collection is a register's
rows, which belong to one reference for life.

**Cardinality.** Project 1:1 Drawing Set. Drawing Set 1:N of each collection (0..N registers). Source 1:N
Sheet; Source 1:N Register Reference. Register Reference 1:N (at least one) Register Entry. Title Block
Profile 1:N Sheet (0..1 per Sheet). Analysis Run 1:N Finding. Finding N:M Sheet, N:M Source, N:M Register
Entry. Finding 1:N Review Decision. Finding 0..1 → Finding (supersession).

**Required / optional.** Every property the schema lists as `required` is present, with `null` for "not yet"
or "not stated"; there is no "absent means default" (S). The one closed object whose properties are each
optional is a Finding's `params`: a rule states only the facts it needs (S).

**Timestamps.** UTC, millisecond precision, exactly as `Date.prototype.toISOString()` writes them (S); a real
instant in the years 2000–2199 (R `REL_TIMESTAMP_INVALID`). A timestamp more than 24 h ahead of the importing
machine's clock is a warning (W `WARN_TIMESTAMP_IN_FUTURE`), and so is an order that does not add up — a
profile or register updated before it was created or declared, a run completed before it started, a decision
dated before its Finding, or anything dated after the file's `savedAt` (W `WARN_TIMESTAMP_ORDER`).

**Delete behaviour.** Nothing a person removes is deleted. A Source, Sheet, Profile, Register Reference or
Register Entry is *retired* (`retiredAt`), stays in the file and keeps every reference to it valid. A replaced
fingerprint or confirmation moves to its history list. A Finding is never removed to resolve it. The one
exception is an Analysis Run that nothing refers to any more, which carries no information and is pruned at
save (D).

---

## A. Identity

- Every entity id is a **lower-case RFC 9562 UUID** (S) **minted by the app** — never derived from content or
  from a drawing number (D).
- **One namespace for the whole file**: no id is used twice anywhere, across entity kinds — `projectFileId`,
  `project.id`, `drawingSet.id`, every collection and every register entry (R `REL_DUPLICATE_ID`).
- **`drawingNumber` is a property, never identity.** A Sheet *has* a drawing number (through its observation
  or confirmation) and so does a Register Entry; it is what QA compares, never what either *is*. Two Sheets
  carrying one number is QA01's subject, not an identity clash.
- `displayName` is a label and a rebinding hint, never identity. `sha256` is content identity evidence — what
  binds bytes to a Source, not what a Source is: a Source keeps its `id` when a person accepts new bytes.
- `projectFileId` names **one saved file**; every save mints a new one and `lineage` records the one it came
  from, so two files of one Project are ordered without trusting a clock. The first save — and only the
  first — has no previous file; a file is not saved from itself; a migration only moves forward
  (R `REL_LINEAGE`).

## B. Source

- **Fingerprint** `{ algorithm: "SHA-256", sha256, byteLength, pageCount, recordedAt }`: facts of one exact
  byte sequence. **SHA-256 is the content identity evidence** and the authoritative match (S).
- **Live duplicate content.** Among the live Sources (`retiredAt: null`) of the Drawing Set, `sha256` is
  unique (R `REL_DUPLICATE_SOURCE_CONTENT`): two live slots for one byte sequence would make every sheet of it
  a duplicate of itself and leave rebinding nothing to tell them apart by. Two selected files with the same
  bytes bind once; the spare is reported, not added (D).
- **Fingerprint history.** Accepting new bytes for a Source moves the current fingerprint to
  `fingerprintHistory` (reason `REPLACED_BY_HUMAN`, S) and installs the new one. Nothing is erased; the
  history is append-only (D).
- **`displayName`** is a bare file name: no path separator, no drive colon, no control or direction-override
  character (S), and not `.`, `..` or blank (R `REL_FILE_NAME`).
- **Runtime binding is not persisted.** `UNBOUND / MATCHED / CHANGED / MISSING / AMBIGUOUS` are runtime states
  and none is stored (D):
  - every Source is `UNBOUND` on resume, before any file is selected;
  - **SHA-256 equality is the only path to `MATCHED`**;
  - a file name can only *nominate*: one nominee is `CHANGED`, more than one is `AMBIGUOUS`; a person's
    explicit assignment can nominate but never makes `MATCHED`;
  - a pass that finds nothing and nominates nothing is `MISSING`;
  - **changed bytes become a Source's content only by an explicit Human acceptance**;
  - rebinding is per Source: one changed Source does not invalidate the Project.
- **Fingerprint at analysis.** The digest covers exactly `file.size`, and it is recomputed over the bytes an
  analysis actually loads, before PDF.js owns or detaches them; a mismatch is refused (D).
- **Retiring a Source retires what depends on it**: a live Sheet of a retired Source, or a live Register
  Reference declared from one, is refused (R `REL_RETIRED_STATE`).

## C. Sheet

- One page of one Source, with an identity of its own. `sourceId` resolves (R `REL_DANGLING_SOURCE`); a Sheet
  belongs to one Source for life.
- **Live uniqueness by source / page**: among live Sheets, `(sourceId, pageNumber)` is unique
  (R `REL_DUPLICATE_SHEET_PAGE`). `pageNumber` starts at 1 (S).
- A live Sheet whose page number is beyond its Source's `pageCount` is **not refused** — it is a QA10
  `SHEET_WITHOUT_PAGE` fact; pages no live Sheet represents are QA10 `PAGE_WITHOUT_SHEET`.
- `pageFacts` — page-box facts (upright size, `rotate`, `text-native` / `scanned`), bound to `sourceSha256`.
- **Observations vs Human confirmations** are stored side by side and never merged:
  - `observation` — what the machine read: `runId` (an `EXTRACTION` run: R `REL_DANGLING_RUN`,
    `REL_RUN_KIND`), `sourceSha256`, `profile { profileId, profileRevision }` (the profile exists:
    R `REL_DANGLING_PROFILE`; the revision is not newer than the profile's own: R `REL_PROFILE_REVISION`),
    `status` `READ` / `OCR_FAILED`, and per field `value`, `rawText`, `source` (`native` / `ocr` / `none`),
    `ocrScore`;
  - `confirmation` — what a person stands behind: `confirmedAt`, `sourceSha256`, `profile` (or `null` when
    typed with no profile involved), the four `values` (a blank a person confirmed is a value) and
    `editedFields`;
  - a correction never overwrites the machine's reading, and **a score never confirms anything** — `ocrScore`
    is a sort key read by nothing that decides (D);
  - the values a QA rule reads are the confirmation if it stands, else the observation if it stands, else
    nothing — which QA02 reports rather than guesses at (D).
- **Confirmation history.** Re-confirming or withdrawing moves the previous confirmation to
  `confirmationHistory` (reason `RECONFIRMED` / `WITHDRAWN`, S); append-only (D).
- **Changed Source** (Human decision): page *n* of the accepted new bytes is the same Sheet as page *n* of the
  old **as a continuity candidate only**. Nothing about that Sheet is trusted until it is **re-read and a
  person re-confirms it**; the old confirmation is kept, shown as "previously confirmed", and read by no QA
  rule. A shorter replacement does not retire Sheets automatically: QA10 reports `SHEET_WITHOUT_PAGE` and a
  person retires them (D).
- A live Sheet is not assigned to a retired profile (R `REL_RETIRED_STATE`).

## D. Title Block Profile

- Geometry in the existing M2-5 Drawing Register's own semantics: **upright page space** (origin top-left of
  the page as it would be without its `/Rotate`, y downwards), **PDF points** at scale 1 — as the schema's
  `Rect` defines it; the schema bounds each coordinate to 0–14400 pt (S).
- **Reference page** `{ uprightWidthPt, uprightHeightPt }`, positive (R `REL_RECT_INVALID`).
- Four field rectangles — `drawingNumber`, `drawingTitle`, `revision`, `issueDate` — each non-empty and on its
  reference page, within 0.01 pt (R `REL_RECT_INVALID`).
- **Transfer model** `normalised` or `corner-anchored` (S), chosen by a person (D).
- **Profile revision** counts every change to the geometry or the model. Observations and confirmations name
  `{ profileId, profileRevision }`; a basis newer than the profile is refused (R `REL_PROFILE_REVISION`), an
  older one is `STALE_PROFILE` (D). A profile change invalidates only the observations and confirmations that
  depend on it; a confirmation made with no profile is untouched by profile changes.
- **Per-sheet Human assignment**: `profileAssignment { profileId, confirmedAt }` (S) — a sheet belongs to a
  profile because a person said so (D); the profile exists (R `REL_DANGLING_PROFILE`). A Drawing Set may have
  several profiles.
- Retired, not deleted: observations and confirmations made under it still name it. `updatedAt` before
  `createdAt` is a warning (W `WARN_TIMESTAMP_ORDER`).

## E. Declared Drawing Register

- **Optional** — a Drawing Set may have none, and zero is the normal case.
- **Never inferred automatically. Human declared.** A register exists only because a person declared one:
  pointed at a table, mapped its columns, looked at the rows and accepted them — or typed it. A list page in
  the set, its text having been read, or the table engine being able to reconstruct it creates nothing. What
  the engine reads is a draft in the workspace until a person accepts it, and a draft is not persisted (D).
- **`DrawingRegisterReference`** (UUID): `sourceId` (resolves: R `REL_DANGLING_SOURCE`), `pageNumber`,
  `region`, `sourceSha256`, `method` (`TABLE_NATIVE` / `MANUAL`), `declaredAt`, `updatedAt`, `retiredAt`,
  `entries` (at least one).
  - **Fixed Source fingerprint basis.** `sourceSha256` is the bytes it was declared from, and it never
    changes. A reference is never re-pointed at new bytes: declared again — from new bytes or another page —
    it is a **new** reference and the old one is retired. If its Source's bytes are replaced, the reference is
    `STALE` by comparison and QA09 is not evaluated (D).
  - **`region`** is the box of the grid the table engine (M2-4) reconstructed — the origin of the rows, in
    upright PDF points — not the rectangle a person dragged. Required for `TABLE_NATIVE` (R `REL_REGISTER`);
    may be `null` for `MANUAL`; when present, a non-empty rectangle (R `REL_RECT_INVALID`).
  - A **scanned register list is declared `MANUAL`** (typed); the table engine reads native text only.
  - **External register import is outside M7 v1**: a register is always on a page of a Source.
  - A live reference declared from a retired Source is refused (R `REL_RETIRED_STATE`). `updatedAt` before
    `declaredAt` is a warning (W).
  - A list that runs over several pages is several references; QA09 compares the Sheets with all live entries
    together (D).
- **`RegisterEntry`** (UUID): `row` (unique within its reference: R `REL_REGISTER`), **`drawingNumber`
  required (S) and non-empty after trimming (R `REL_REGISTER`)**, `drawingTitle` / `revision` / `issueDate`
  **optional** (`null` when the list does not state them), `origin` (`EXTRACTED` as read, `EDITED` corrected
  by a person, `MANUAL` typed by a person), `retiredAt`.
  - A person corrects a row in place (`origin` records it) and removes a row by **retiring it, not deleting
    it**, so the findings that cited it stay resolvable.
- **Field-level rows only.** Kept: per row the four values; where the table was; which bytes, page, time and
  method; whether a row was read, corrected or typed. Not kept — and there is no property to keep it in: the
  page image or any image of the table, the page's extracted text, the tokens the engine read, the cell grid
  as a block, raw OCR text, a file path, PDF bytes, the engine's candidate or score, the column mapping.

## F. Analysis Run

- **Engine / version.** `kind` `EXTRACTION` or `QA`; `engine { name, version }`. An `EXTRACTION` run is
  produced by `register-extraction`, a `QA` run by `drawing-set-qa` (R `REL_RUN_KIND`).
- `outcome` `COMPLETED` / `CANCELLED` / `FAILED`; a completed run records `completedAt` (R `REL_RUN_STATE`);
  `completedAt` before `startedAt` is a warning (W).
- **Manifest basis.** `manifestDigest` is the SHA-256 of the sorted `(sourceId, sha256)` pairs of every live
  Source at the time: the run is bound to the exact set of bytes it saw, in constant space (S, D).
- **Coverage** `{ sheetsEvaluated, sheetsExcluded }`: a run that left sheets out cannot close a finding about
  them (D).
- **Derived evidence provenance.** Each observation names the run and the `sourceSha256` it read; each finding
  names its run and the `basis` of every Source it cites. Observations come only from `EXTRACTION` runs;
  findings, and their closing, only from `QA` runs (R `REL_RUN_KIND`).
- Append-only.

## G. QA Finding

- **Immutable statement / evidence.** One statement by one rule about its subjects. Immutable apart from
  `lifecycle`: a changed statement is a new Finding that supersedes this one.
- `runId` is a `QA` run (R `REL_DANGLING_RUN`, `REL_RUN_KIND`); `ruleId`, `ruleVersion`, `determinism`
  (`DETERMINISTIC` a fact / `CANDIDATE` a question), `scope`, `params` (a closed set of small facts) (S).
- **N:M subjects**: `sheetIds`, `sourceIds`, `registerEntryIds`. Each resolves (R `REL_DANGLING_SHEET`,
  `REL_DANGLING_SOURCE`, `REL_DANGLING_REGISTER_ENTRY`), is listed once (R `REL_FINDING_SUBJECT`), and the
  subjects fit the scope — `SHEET` exactly one Sheet, `SHEET_GROUP` at least one, `SOURCE` at least one
  Source, `REGISTER_ENTRY` at least one entry, `SET` and `PROJECT` any (R `REL_FINDING_SUBJECT`).
- **`basis`** `{ sourceId, sha256 }` for every Source it cites — directly, through a Sheet, or through a
  Register Entry's reference (R resolves; D content).
- **`findingKey`** — SHA-256 naming the question (the rule and its subject). **`evidenceDigest`** — SHA-256
  over the grounds: the rule version, the cited sheets with their fingerprints, the cited register entries,
  and the values that make it true. Their exact byte derivations belong to the QA engine and are fixed with it
  in M7-P3; this contract fixes their roles and the invariants below.
- **Lifecycle** (stored), each state with consistent fields (R `REL_FINDING_LIFECYCLE`):

  | State | Meaning | `supersededByFindingId` | `closedByRunId` / `closedAt` |
  |---|---|---|---|
  | `ACTIVE` | the latest statement of this question | `null` | `null` / `null` |
  | `SUPERSEDED` | a later run stated the same question on different evidence | the later Finding | set |
  | `NOT_REPRODUCED` | a later run that could evaluate the question no longer found it | `null` | set |

  A closing run is a `QA` run (R `REL_RUN_KIND`).
- **One `ACTIVE` Finding per `findingKey`** (R `REL_FINDING_KEY_NOT_UNIQUE`).
- **Supersession** points at an existing Finding (R `REL_DANGLING_FINDING`) with the same `findingKey` and
  `ruleId`, and every chain ends — no loop (R `REL_SUPERSEDE_CHAIN`).
- **Re-run** (D): same key and same evidence → the same Finding (nothing written; its decisions stand); same
  key, different evidence → a new Finding, the old one `SUPERSEDED`, its decisions kept as history; a run that
  could evaluate the question and did not find it → `NOT_REPRODUCED`; a run that could not evaluate it leaves
  it `ACTIVE`, its currency derived (§I). A Finding is never deleted to resolve it.
- **A finding in a file is recognised, never believed** (D). QA is re-evaluated when a Project is opened and
  the file's findings are matched with the fresh result by key and evidence; a well-formed finding the
  metadata does not support is closed by that first run. What the file contributes is identity and Human
  history, not truth. (The declared register is the one input believed as written, because a person wrote
  it.)

**Rules** (`ruleId`, all present in the schema; none says a drawing is wrong, none infers design intent, none
closes itself):

| Rule | States | Class |
|---|---|---|
| `QA01_DUPLICATE_NUMBER` | the same drawing number on two or more live Sheets (key: trimmed only) | DETERMINISTIC |
| `QA01B_DUPLICATE_NUMBER_VARIANT` | numbers written differently that agree once folded (width, case, dash, spacing) | CANDIDATE — **candidate sub-tier until P3 freeze** |
| `QA02_METADATA_UNCONFIRMED` | no person currently stands behind a sheet's metadata (`NOT_READ`, `UNCONFIRMED`, `OCR_FAILED`, `READ_IS_STALE`, `RECONFIRM_REQUIRED`) | DETERMINISTIC |
| `QA03_NUMBER_GAP` | a possible gap in a numbered series; only a run of at most **5** missing numbers is reported (**candidate until P3 freeze**) | CANDIDATE |
| `QA04_SAME_NUMBER_DIFFERENT_TITLE` | one drawing number, different titles | DETERMINISTIC |
| `QA05_REVISION_MISMATCH` | **different revisions within the same drawing number** | DETERMINISTIC |
| `QA06_ISSUE_DATE_MISMATCH` | **different issue dates within the same drawing number** | DETERMINISTIC |
| `QA07_SHEET_SIZE_OUTLIER` | sheets outside the size class held by **more than half** of the evaluated sheets; no majority, no outlier (**candidate until P3 freeze**) | CANDIDATE |
| `QA08_ORIENTATION_OUTLIER` | sheets outside the orientation held by **more than half** of the evaluated sheets; no majority, no outlier (**candidate until P3 freeze**) | CANDIDATE |
| `QA09_REGISTER_SHEET_MISMATCH` | declared Drawing Register vs actual Sheets (§K) | DETERMINISTIC |
| `QA10_INTEGRITY` | Source / Project integrity: `SOURCE_MISSING` · `SOURCE_CHANGED` · `SOURCE_AMBIGUOUS`, `PAGE_WITHOUT_SHEET`, `SHEET_WITHOUT_PAGE`, `PROJECT_FILE_ANOMALY` | DETERMINISTIC |

For QA04–QA06 a blank value is unknown, not different. QA05 / QA06 mean differences **within one drawing
number** (Human decision), not a difference from an expected revision or date. The existing engine's
`revision_date` is M7's `issueDate`, mapped in an adapter (Human decision).

## H. Review Decision

- `findingId` resolves (R `REL_DANGLING_FINDING`); a Decision belongs to one Finding for life.
- **Append-only.** A change of mind is a new Decision with the next `sequence`; the earlier one stays.
- **Sequence per Finding** is exactly 1..n — no gap, no repeat (R `REL_DECISION_SEQUENCE`). The effective
  Decision of a Finding is the one with the highest `sequence` (D).
- **`evidenceDigest` must match the Finding** (R `REL_DECISION_EVIDENCE`). A Decision is about one exact
  statement: when the evidence changes, the new Finding starts with no Decision and the old Decision stays
  attached to the old Finding as history. `decidedAt` before the Finding's `createdAt` is a warning (W).
- **Outcomes** — `ACTION_REQUIRED`, `INTENTIONAL`, `FALSE_POSITIVE`, `HOLD` (S). All four count as reviewed.
  **`HOLD` is reviewed but blocks the Final QA Report** (Human decision; §J).
- `comment`: bounded multi-line text, inert (rendered as text only).
- **The author of a Decision is not persisted in M7 MVP** (Human decision); there is no property for it.

## I. Currency / stale

- **Nothing in the file says "stale."** There is no mutable stale flag (no property exists for one). Every
  derived record names the basis it came from, and a record *is* stale when that basis no longer equals what
  is there now (D).

  | Record | Basis | Stale when |
  |---|---|---|
  | `Sheet.pageFacts` | `sourceSha256` | it is not the Source's current fingerprint |
  | `Sheet.observation` | `sourceSha256`, `profile`, `runId` | fingerprint differs (`STALE_SOURCE`); the sheet is no longer assigned that profile or its revision moved (`STALE_PROFILE`) |
  | `Sheet.confirmation` | `sourceSha256`, `profile` or `null` | the same two tests; with no profile, profile changes do not touch it |
  | `DrawingRegisterReference` | `sourceSha256` | it is not its Source's current fingerprint, or the Source is retired |
  | `Finding` | `basis[]`, `evidenceDigest` | a cited fingerprint differs; a cited Source, Sheet or Register Entry was retired; for QA09, the declared register is not current |
  | `AnalysisRun` | `manifestDigest` | informational: which exact set of bytes a run saw |
  | `ReviewDecision` | `evidenceDigest` (= its Finding's) | never stale itself: it is about one immutable statement |

- **Finding currency** is derived and never stored:

  | Currency | Meaning |
  |---|---|
  | `CURRENT` | `ACTIVE`, its basis equals the manifest, its Sources are `MATCHED` this session, and (for a set-wide rule) the whole set could be evaluated |
  | `UNVERIFIED` | `ACTIVE` and consistent with the manifest, but a cited Source is not bound, or the set is not fully evaluable |
  | `STALE` | `ACTIVE`, but stated about bytes the Source no longer has, about a retired Sheet or Register Entry, or (QA09) against a declared register no longer current or withdrawn |
  | `HISTORICAL` | not `ACTIVE` |

- **A changed Source invalidates only what depends on it**: its Sheets' page facts, observations and
  confirmations, the findings that cite it, and a register declared from it. Other Sources are untouched. A
  missing file makes nothing stale — what depends on it is `UNVERIFIED`.
- **Human history remains.** Old confirmations become re-confirmation candidates; old decisions remain
  attached to the exact Finding evidence they concerned; old fingerprints stay in `fingerprintHistory`.

## J. Final QA readiness

Final completion means **the current work is fully reviewed**, not that there are no findings. A Final QA
Report requires all of the following (D; Human-adopted values):

| Requirement | Blocker when not met |
|---|---|
| **every live Source is `MATCHED`** this session — independently of every decision | `SOURCES_NOT_MATCHED` |
| every live Sheet's current required metadata is **Human-confirmed**, unless its current QA02 finding has an effective **`INTENTIONAL`** decision | `METADATA_NOT_CONFIRMED` |
| a declared Drawing Register, if any, is current | `REGISTER_NOT_CURRENT` |
| **every `ACTIVE` finding is `CURRENT`** (none `STALE` or `UNVERIFIED`) | `FINDINGS_NOT_CURRENT` |
| **every `ACTIVE`, `CURRENT` finding has a Human decision** | `FINDINGS_UNREVIEWED` |
| no effective decision is `HOLD` — **`HOLD` = reviewed but blocks the Final QA Report** | `FINDINGS_ON_HOLD` |

The QA02 metadata exemption is **`INTENTIONAL` only**:

| QA02 finding with… | Counts as reviewed | Exempts the sheet from metadata confirmation |
|---|---|---|
| no decision | no | no |
| `INTENTIONAL` | yes | **yes** |
| `FALSE_POSITIVE` | yes | **no** — confirm the sheet instead |
| `ACTION_REQUIRED` | yes | **no** |
| `HOLD` | yes | **no** (and blocks Final) |
| the sheet is then confirmed | — (the finding is `NOT_REPRODUCED`) | the requirement is met |

The exemption is that decision, not a flag: it does not outlive the evidence it was made on. A decision on a
QA10 `SOURCE_*` finding clears that finding, never `SOURCES_NOT_MATCHED`. Beside the blockers the result
states what was **not evaluated** — `QA09 / NO_DECLARED_REGISTER` when no register is declared — so a report
never reads an unevaluated comparison as a pass.

## K. QA09 — declared Drawing Register vs actual Sheets

- Compares the **Human-declared Drawing Register (図面一覧)** with the live Sheets:

  | Reason | Statement | Subject |
  |---|---|---|
  | `LISTED_BUT_MISSING` | the declared register lists drawing number *X*, and no live Sheet carries it | one Register Entry |
  | `ACTUAL_NOT_LISTED` | a live Sheet carries drawing number *X*, and no entry of the declared register does | one Sheet |

- **The exact drawing number is the canonical comparison** (trimmed, the same key as QA01). A folded or
  full-width spelling (`Ａ－１０２` against `A-102`) is named as a **hint only** (in the finding's
  `params.values`) and is never counted as a match (Human decision).
- **No declared register → `NOT_EVALUABLE`, never `PASS`**: no finding, and the result says the set was not
  compared with a drawing list. It does not block Final — the register is optional.
- A declared register that is **not current** (its Source's bytes were replaced after it was declared) is
  not evaluated either, and that **does** block Final (`REGISTER_NOT_CURRENT`) until a person declares it
  again.
- A Sheet with an empty drawing number is outside QA09; a Sheet nobody has read is not evaluated (QA02 reports
  it). QA09 v1 compares drawing numbers only, not titles, revisions or dates.
- **`PAGE_WITHOUT_SHEET` / `SHEET_WITHOUT_PAGE` belong to QA10** (Project integrity), not to QA09: they compare
  M7's own Sheet list with a Source's pages, not with a declared register.

## L. Persistence privacy boundary

| Allowed in a Project file | Forbidden — and the schema has no property for it |
|---|---|
| field-level metadata (four title-block fields; register rows) | PDF bytes, or PDF bytes as Base64 |
| Human confirmation, correction and their history | page images; thumbnails |
| QA findings, review decisions and their history | full-page extracted text |
| provenance: fingerprints, runs, bases, profile geometry | raw OCR page text |
| **bounded title-block field `rawText`** | absolute or UNC paths |
| | `FileSystemHandle`, Blob URLs |
| | credentials, tokens |
| | PDF internal object dumps |

- **`rawText` is field-level only: at most 1000 characters per title-block field** (Human-adopted bound;
  `FieldRawText.maxLength` 1000, S) — what the extraction read inside one field rectangle, never page text and
  never OCR page output (D: what an extraction may put there).
- Every object in the schema is closed (`additionalProperties: false`), so an undeclared property — a Base64
  payload, page text, a handle — refuses the file (S). A file name cannot hold a path (S, R).
- Free text (names, titles, comments) is **inert**: rendered as text only, never as markup, a link or a path.
  Text that merely looks like a path or a URL inside a comment or a title is accepted as text.
- **Export is allow-list based**: only schema-declared fields are copied, and the result is validated as
  untrusted input before it is written. Runtime binding state, stale flags, file handles, paths, bytes,
  images, page text and the author of a decision never reach the file.

## M. Version / migration

- `format` is `pdf-architools/drawing-set-project`; `schemaVersion` is one integer with no minor version (S).
- **Pre-release (now → M7-P4).** No Portable Project file has shipped, so the contract may change **only
  through a reviewed canonical contract change** to this directory, made **before** any implementation that
  depends on it — and with **no end-user migration**. The in-memory model of P1–P3 does not drift from the
  contract and get reconciled later.
- **M7-P4 freezes `schemaVersion` 1** as the first user-writable format. After that, a change of shape is a
  new version with a migration.
- **Import** is fail-closed and all-or-nothing, in this order: file byte bound → strict UTF-8 → bounded
  pre-parse scan (bounds cost; refuses duplicate keys) → `JSON.parse` → `format` / `schemaVersion` → schema
  (S) → semantic relations and lifecycle (R / W) → a Project, or a refusal.
- An unknown field or an unknown enum value is refused. A **future `schemaVersion` is refused** before any
  schema is consulted — not even opened read-only.
- An **old `schemaVersion`** is validated against *its own* frozen schema, migrated in memory step by step,
  validated again as a current file, shown to the person as migrated, and leaves only as a **new** saved file
  whose `lineage.migratedFrom` names its origin; the old file is untouched. Every released schema version's
  schema file is kept, and **released schemas retain a migration path** unless a later Human decision changes
  that policy.

---

## Human decision values (Architecture v1)

| # | Decision | Where |
|---|---|---|
| 1 | `HOLD` is reviewed but **blocks the Final QA Report** | §H, §J |
| 2 | Revision / issue-date mismatch = different values **within the same drawing number** | §G (QA05, QA06) |
| 3 | Drawing Register: **exact drawing number** is the comparison; folded / full-width spelling is a hint only; external register import is outside M7 v1; a scanned list is a `MANUAL` declaration | §E, §K |
| 4 | Changed Source: same page number is a **continuity candidate only**; re-read and re-confirm required | §C |
| 5 | `rawText`: field-level only, **max 1000 characters per title-block field**; full-page and raw OCR page text forbidden | §L |
| 6 | Resource limits stay **candidates** unless later frozen | [Resource limits](#resource-limits) |
| 7 | M6 Load Boundary is not copied wholesale; the **256 MiB per-source ceiling** may be reused as Architecture direction; M7's own PDF.js intake gate belongs to P1 | [Resource limits](#resource-limits) |
| 8 | Existing engine `revision_date` maps to M7 `issueDate` in an adapter | §G |
| 9 | Review Decision author is **not persisted** in M7 MVP | §H |
| 10 | Released schemas **retain a migration path** unless a future Human decision changes it | §M |
| 11 | Final requires **every live Source `MATCHED`** | §J |
| 12 | QA01B, gap run 5 and outlier majority > 50 % are **candidate parameters until P3 freeze** | §G |
| 13 | **Not tamper-evident** in M7 MVP: nothing may claim signed or auditable authenticity | [Not claimed](#what-this-contract-does-not-claim) |
| 14 | Research browser evidence is sufficient for Architecture Adoption; **P1 and P4 require target-browser smoke** coverage | [Not claimed](#what-this-contract-does-not-claim) |

## Resource limits

**Adopted** (Architecture v1 §E–F; the M7-CAN-01 authorization): that every collection and every string is
bounded; the named `x-limit` mechanism that marks each bound; and fail-closed refusal of a value outside a
bound. **Not Production-frozen:** the numbers. Each value
below is a **candidate pre-release bound** unless marked otherwise; M7-P4 (and M7-P1, for the PDF intake gate)
freezes Production values, and a change before then is a reviewed contract change. None is a shipping
guarantee.

| `x-limit` (in the schema) | Value | Status |
|---|---|---|
| `maxFieldRawTextLength` | 1000 characters | **Human-adopted** (decision 5) |
| `maxSourceBytes` | 268435456 (256 MiB) | candidate in M7 — the M6-adopted per-source ceiling, which Architecture v1 lets M7 reuse; M7's own PDF.js intake gate is defined in P1 |
| `maxSheets` · `maxSources` | 5000 each | candidate |
| `maxFindings` | 50000 | candidate |
| `maxDecisions` | 100000 | candidate |
| `maxPagesPerSource` | 5000 | candidate |
| `maxSubjectsPerFinding` | 5000 | candidate |
| `maxPagePoints` | 14400 pt | candidate |
| `maxFileNameLength` | 255 | candidate |
| `maxProfiles` · `maxRegisterReferences` | 64 each | candidate (not measured) |
| `maxAnalysisRuns` | 2000 | candidate (not measured) |
| `maxFingerprintHistoryPerSource` · `maxConfirmationHistoryPerSheet` | 64 · 32 | candidate (not measured) |
| `maxRegisterEntriesPerReference` | 1000 | candidate (not measured) |
| `maxNameLength` · `maxFieldValueLength` · `maxCommentLength` | 200 · 300 · 4000 | candidate (not measured) |

The bounded pre-parse scan has its own candidate bounds, which are not schema keywords and belong to the
Production import implementation (M7-P4): `maxProjectBytes` 64 MiB, `maxNestingDepth` 16, `maxJsonValues`
4000000, `maxObjectKeys` 32, `maxKeySourceLength` 64, `maxStringSourceLength` 24000 — all candidates.

Format bounds the schema states without `x-limit` (UUID, SHA-256, timestamp, version string, reason code,
`saveSequence`, `ruleVersion`, `params` sizes) and the constants inside `portable-project.semantic.mjs` (a
future-timestamp warning beyond 24 h of clock lead; years 2000–2199; 0.01 pt rectangle tolerance; at most 20
problems and 20 warnings reported by default) are part of the structural and semantic contract as reviewed,
and change only through the same review.

## What this contract does not claim

- **Not tamper-evident.** A Project file carries no signature or hash chain; nothing built on it may imply
  signed or auditable authenticity.
- **Not wired into the app.** Validation, migration and export are specified here, not implemented in
  Production.
- **Browser coverage is not established for release.** The research measured one browser — enough for
  Architecture Adoption, not for shipping. M7-P1 and M7-P4 must define and run target-browser smoke coverage,
  and before M7-P4 ships the Production bounded scanner and schema interpreter need fuzz, property-based and
  differential testing.

## Sources

- M7 Architecture v1 — `obsidian-vault/01_Projects/PDF-ArchiTools/12_M7_Architecture_v1.md`, Human adopted
  2026-10-09 (obsidian-vault `5e69c8cd1e9ab2412ae5d536138dae8fe7981e14`), including its Human decision values.
- PR #33 exact head `e541d1d43db3a73acceb3f8241ef914d59dc77d7`, under `research/m7-drawing-set-manager/`:
  `portable-project.schema.proposed.json`, `prototype/semantic.mjs`, `data-model.proposed.md`,
  `architecture-research.md` (§4, §5, §12), `qa-rule-matrix.md`, `rebinding-state-machine.md` — read with
  `git show`; evidence only.
- The M7-CAN-01 work packet (Human authorization 2026-10-09).
