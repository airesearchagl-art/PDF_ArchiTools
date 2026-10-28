# M7 Portable Project — semantic contract v1

**Canonical pre-release contract.** M7 Architecture v1, Human Architecture Adopted 2026-10-09; published by
M7-CAN-01 (authorized 2026-10-09). `schemaVersion` 1. No user-writable format is released until M7-P4.

This is the human-readable statement of the relation and lifecycle contract of the M7 Portable Project JSON.
The CAN-01 rules derive from Human-adopted M7 Architecture v1 (2026-10-09) and the evidence
reviewed at PR #33 exact head `e541d1d43db3a73acceb3f8241ef914d59dc77d7`
(see [Sources](#sources)). **Exception:** the normative D writer/runtime rules HDR-36-01
(`editedFields`) and HDR-36-02 (terminal EXTRACTION runs) were separately **HUMAN ADOPTED
on 2026-10-10** as new CAN-02 decisions, not retroactively sourced from Architecture v1
or PR #33. The `manifestDigest` byte format clarifies the existing CAN-01 rule.
None of these changes modifies M7-P1 Production or implements Portable Project I/O.

## M7-CAN-02 — Human-adopted D rules and existing-rule byte clarification

**New normative Human decisions, explicitly adopted 2026-10-10:**
- **HDR-36-01:** the `editedFields` writer rule defined in §C, including
  `source: none`, `profile: null`, matching observation basis, canonical order,
  exact comparison, and historical non-recomputation.
- **HDR-36-02:** the terminal EXTRACTION run lifecycle in §F: fully processed
  Source observations may remain for `CANCELLED` / `FAILED` runs; uncompleted
  Source results do not publish; coverage is scoped to targeted Sheets.
  AnalysisRun is append-only in memory, with the already adopted P4
  save-time pruning exception.

**Byte-level clarification of an existing rule (not a new Meaning Delta):**
the exact sorted JSON / UTF-8 / SHA-256 serialization and test vectors for
`manifestDigest` in §F.

**Human Adoption evidence:** explicit Human authorization in the PDF ArchiTools
M7-CAN-02 review Human Gate on 2026-10-10, following Independent FULL Review
of PR #36 at `faf9d08b5d37041a90c40403f72ebb18c99997d9`.
This adoption authorizes only RF-36-01 provenance repair, not Ready, merge,
Production changes, or M7-P2-A/B implementation. The JSON Schema,
executable S/R/W validator, `schemaVersion` and pre-release safety bounds
remain unchanged. Independent **Focused Contract Re-review** of the repair
head and a separate Human Ready/merge gate are still required.

## M7-CAN-03 — Human-adopted QA D rules (2026-10-28)

**Human adopted CAN-03 R4.1 on 2026-10-28**, through the explicit approval
`M7-CAN03-R41-CONTRACT-PUBLISH-01` in the PDF ArchiTools ChatGPT conversation.
The adopted artifact is `M7-CAN03-R4.1-LIMIT-ATOMICITY.zip`, SHA-256
`c6bf864db66ecc0797ef3220a4be893dc0eb661b8f91cdff492db51c99c311cb`.
Its independent design re-review is PASS, RF-01 CLOSED, Required Fix 0. That review
is bound to the ZIP, **not to a Git commit**; no design-review commit is asserted.

The adoption covers R4-A through R4-I and R4.1-L. All are human-readable
runtime/writer **D** rules. New byte derivations, validity/currency detail,
QA evaluation/closure, Decision guards, QA coverage, atomic limit refusal and
partial-QA readiness are specified in the sections below. Changes to previously
adopted wording are distinguished explicitly:

| Decision | Adopted meaning | Kind |
|---|---|---|
| MD-1 | One `LISTED_BUT_MISSING` Finding per comparison number, citing **all live Entries** with that number across all live References | changes the former §K Subject of one Register Entry |
| MD-2, **option A** | Withdrawing all References resolves `REGISTER_NOT_CURRENT`; existing QA09 Findings become STALE until the next QA run closes them `NOT_REPRODUCED` | changes the former §K requirement to redeclare before clearing the blocker |
| MD-3 | Add `QA_RESULT_NOT_CURRENT` to the six existing §J blockers | new normative D policy |
| MD-4 | Add a Decision only to an `ACTIVE`, `CURRENT` Finding | new normative D policy |

The approval authorizes publication in a **Draft PR only**, followed by independent
Contract Review. It does **not** authorize P3/P4 implementation, Ready, merge,
manual CI, Production operations, deploy, or Notion/Vault updates. Schema,
executable S/R/W validator, `schemaVersion` and resource-bound values/statuses
are unchanged. The reviewed proposal generator is a test oracle, not Production
code or an implementation authorization. The adopted rules do not freeze QA01B
or the other deferred QA parameters.

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
  - **`editedFields` at confirmation time (D):** an ordered subset of the four canonical field keys,
    `drawingNumber`, `drawingTitle`, `revision`, `issueDate`, never duplicated. For a manually
    entered confirmation with `profile: null`, include all four. Otherwise compare each
    confirmation value against the machine observation available at confirmation time
    with the same Source fingerprint and profile basis. Include a key when the matching
    observation is missing, the observed field has `source: none` (even if both values
    are the empty string), or the confirmed value is not exactly equal to the observed
    `value`. Do not include keys with the same value and an observed `source: native`
    or `ocr`. This is a historical account of fields supplied by a person, not proof
    they checked all unchanged fields. Do not recompute it using a subsequently
    overwritten observation. It is a D writer rule, not a new S/R/W validator.
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

### CAN-03 R4-A — QA input has separate validity and binding axes (D)

Validity reads the stored basis, independently of session binding. A record is
valid only if the Sheet's Source exists and is live and its current fingerprint
equals the record's `sourceSha256`. For a profile-based record, all of the following
also hold: the Sheet has a profile assignment; its `profileId` equals the record's
`profile.profileId`; that Profile exists and is live; its `revision` equals the
record's `profileRevision`. Comparing revision alone is insufficient. A manual
confirmation with `profile: null` is unaffected by assigning, changing or removing
a Profile. This is the validity axis of the existing product currency functions;
`CURRENT` or `UNVERIFIED` there means valid, while binding remains a separate axis.

Choose one QA input for each live Sheet, in this order:

| `origin` | Condition | Values, in canonical order |
|---|---|---|
| `CONFIRMED` | valid confirmation | `confirmation.values`: `drawingNumber`, `drawingTitle`, `revision`, `issueDate` |
| `OBSERVED` | no valid confirmation, valid observation with status `READ` | the same four `observation.fields[field].value` values |
| `NONE` | otherwise | `null` |

QA01/QA09 compare only `drawingNumber`; QA02 evidence includes all four values.
Binding does not select the input: it affects Finding currency. `editedFields`,
OCR score, extraction method, `rawText` and timestamps select neither input nor
evidence. A score never constitutes confirmation.

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

### CAN-03 R4-C — one declared register across all live References (D)

A Reference is live exactly when `retiredAt` is null. An Entry is live only when
both it **and its containing Reference** are live; withdrawing a Reference need
not individually retire its Entries. A Reference is current only if its Source
exists, is live and has the Reference's fixed `sourceSha256`. Binding does not
change that validity test.

| Derived register state | Condition | Evaluation and Final effect |
|---|---|---|
| `NONE` | no live Reference, including after withdrawal of all References | no QA09 comparison; `NO_DECLARED_REGISTER`, not PASS; no register blocker |
| `NOT_CURRENT` | at least one live Reference is not current | evaluate no QA09, including no partial comparison against the remaining References; enumerate non-current References for `REGISTER_NOT_CURRENT` |
| `EVALUABLE` | at least one live Reference, all current | compare live Sheets with the union of **all live Entries of all live References** |

A current live Reference whose Entries are all retired is still EVALUABLE: it
contributes no listed numbers. Never select only the first Reference or silently
ignore another one. Sorting Source/Profile/Sheet/Reference/Entry arrays or
renumbering rows changes no key or evidence.

Partial withdrawal removes the withdrawn Reference's Entries from the union;
affected Findings become STALE until a QA run restates or closes them. ANL evidence
depends on every live Reference; LBM evidence depends only on References containing
its cited Entries. Therefore withdrawing an unrelated Reference can change ANL
evidence without changing an LBM's evidence or Decision. A stale live Reference
blocks QA09 as a whole; an unbound but otherwise current Reference does not stop
evaluation, but affects currency when it is part of a Finding's basis.

**MD-2 option A, adopted:** when all References are withdrawn, the register is NONE
immediately. Existing ACTIVE QA09 Findings are STALE before re-run; the next QA run
closes them NOT_REPRODUCED. Their Decisions remain historical. Withdrawal clears
REGISTER_NOT_CURRENT without requiring redeclaration.

## F. Analysis Run

- **Engine / version.** `kind` `EXTRACTION` or `QA`; `engine { name, version }`. An `EXTRACTION` run is
  produced by `register-extraction`, a `QA` run by `drawing-set-qa` (R `REL_RUN_KIND`).
- `outcome` `COMPLETED` / `CANCELLED` / `FAILED`; a completed run records `completedAt` (R `REL_RUN_STATE`);
  `completedAt` before `startedAt` is a warning (W).
- **Manifest basis.** `manifestDigest` is the SHA-256 of the sorted `(sourceId, sha256)` pairs of every live
  Source at the time: the run is bound to the exact set of bytes it saw, in constant space (S, D).
- **Exact `manifestDigest` bytes (D).** At run start select every live Source (`retiredAt: null`),
  even if no Sheet of that Source is selected for this run. Form the pair
  `[source.id, source.fingerprint.sha256]` for each, sort by lower-case UUID ID
  in ascending ASCII code-point order, and serialize the outer array of pairs
  using `JSON.stringify` with no additional whitespace. Hash the resulting
  UTF-8 bytes with SHA-256 and store the lower-case 64-character hex. The
  hash does not include filenames, PDF bytes, selection or run outcome.
  Deterministic reference vectors using full RFC 9562 version-4-shaped UUIDs:
  - Empty live manifest: UTF-8 `[]` →
    `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
  - Two Sources in either input order: ID `00000000-0000-4000-8000-000000000001`
    with a 64-character hex fingerprint of only `a`, and ID
    `00000000-0000-4000-8000-000000000002` with a 64-character hex
    fingerprint of only `b`. Serialize the two pairs in that ascending ID
    order with no whitespace →
    `8fdeea72a821499e08e043456eff0e02008b83fce8bad8905a34535e4727fed0`.
- **Coverage** `{ sheetsEvaluated, sheetsExcluded }` records the run scope. A rule cannot close a Finding
  whose question it could not evaluate (D); the CAN-03 QA coverage counts below do not replace the rule-specific
  closure conditions in §G. EXTRACTION coverage retains its CAN-02 meaning.
- **Derived evidence provenance.** Each observation names the run and the `sourceSha256` it read; each finding
  names its run and the `basis` of every Source it cites. Observations come only from `EXTRACTION` runs;
  findings, and their closing, only from `QA` runs (R `REL_RUN_KIND`).
- Append-only.
- **Terminal EXTRACTION runs (D).** Work in progress remains outside the canonical
  model. When an operation completes, is cancelled, or fails, append the run once
  with its terminal `outcome`, the start-time `manifestDigest`, its actual
  `coverage`, and `completedAt` where known. Valid observations from completely
  processed Sources can reference a `CANCELLED` or `FAILED` run. The run's
  terminal outcome does not itself invalidate their evidence. Unfinished
  Source results do not become partial Sheet observations.
- **EXTRACTION coverage (D).** `sheetsEvaluated` counts targeted Sheets with
  committed valid observations (including `OCR_FAILED`), while `sheetsExcluded`
  counts the other targeted Sheets, including skipped, interrupted, or refused
  ones. The sum describes that run's scope, not every Sheet in the Drawing Set;
  `COMPLETED` can still have excluded Sheets. QA-run coverage is separate.
- **Append-only versus P4 save pruning (D).** Once appended, an in-memory run is
  not rewritten or deleted merely because it has no current references.
  §A's exception applies only at M7-P4 save: an unreferenced run may be
  excluded from the saved file if no observation, finding, or finding-closing
  `runId` refers to it. A zero-observation terminal run may remain in a
  browser-local P2 session, and the P2 runtime never uses save-time pruning.

### CAN-03 R4-G — completed QA runs and coverage (D)

A QA run uses `kind: "QA"`, engine name `drawing-set-qa` and the QA engine version,
`startedAt`, `completedAt`, `outcome: "COMPLETED"`, and the unchanged §F
`manifestDigest` over all live Sources. QA coverage counts live Sheets whose QA
input origin is not NONE as `sheetsEvaluated`; the remaining live Sheets are
`sheetsExcluded`. These counts describe value-reading QA01/QA09. QA02 still
evaluates every live Sheet, including those excluded from value-reading rules.

Append the run, its new Findings, supersessions and closures **atomically**.
An interrupted operation publishes nothing. The initial P3 QA scope writes no
CANCELLED or FAILED QA run. This does not change CAN-02 terminal EXTRACTION rules.
Each new Finding's `createdAt` equals this QA run's `completedAt`; its `runId`
names this run. For a supersession, the old Finding becomes SUPERSEDED with the
new Finding's id, this run's id and this run's time. A closure becomes
NOT_REPRODUCED, with null `supersededByFindingId` and this run's id/time.

### CAN-03 R4.1-L — plan, check all bounds, then publish (D)

Before any write, compute the full planned output: one AnalysisRun with coverage,
every new or superseding Finding, every supersession and every NOT_REPRODUCED
closure. Check all the following against the existing schema bounds:

| Check | Planned value | Existing `x-limit` and candidate value |
|---|---|---|
| AnalysisRun count | all existing EXTRACTION and QA runs + 1 | `maxAnalysisRuns` 2000 |
| Finding count | all existing Findings, in every lifecycle state, + all new Findings | `maxFindings` 50000 |
| Each statement's subjects | `sheetIds.length` and `registerEntryIds.length`, separately | `maxSubjectsPerFinding` 5000 |
| Each statement's Sources | `sourceIds.length` and `basis.length`, separately | `maxSources` 5000 |
| Coverage | `sheetsEvaluated` and `sheetsExcluded`, separately | `maxSheets` 5000 |

Measure every statement, including one whose key/evidence would retain an existing
Finding. Closures do not consume another Finding slot: at the Finding bound, a
run that only closes or retains Findings is allowed if its other bounds fit.
The run bound is shared with EXTRACTION.

If **any** planned value exceeds a bound, return runtime refusal
`QA_LIMIT_EXCEEDED` and write **nothing**: no AnalysisRun (not even FAILED),
Finding, lifecycle, Decision, Sheet, Reference or Source change. In the reference
model even the clock, id counters, bindings and diagnostics are unchanged. Report
all exceeded bounds in fixed order: run count, Finding count, coverage evaluated,
coverage excluded, then statements in the §G canonical order and, within each,
sheetIds, registerEntryIds, sourceIds, basis. Each report gives the bound name,
maximum, planned count and location; for a statement also rule, reason,
comparisonKey and findingKey. The report is runtime-only, not stored.

Do not truncate or omit Entries, split an LBM, partially publish a run, delete
history to free capacity, or raise a bound. A schema-valid declaration with 5001
rows bearing one number remains a valid declaration; refuse the QA **output** if
it would require an oversized Finding, not the declaration itself. When a Sheet
carries that number there is no LBM to write and that Subject bound need not be
exceeded. The anticipated refusal can be derived before execution for display.

On refusal the latest completed QA run and all readiness inputs are unchanged;
existing blockers remain. Never present refusal as completed QA or use it as a
new completed run. Explain the actual exceeded bound, rather than repeatedly
prompting an impossible re-run. After reducing live cited Entries to the bound,
an unchanged question/evidence retains its old Finding and Decision. At the run
bound no QA or EXTRACTION run can be appended; history is not deleted.

If all checks fit, construct the complete next DrawingSet before replacing the
current one, publishing the run/Findings/lifecycle changes together. Perform the
same all-or-nothing check for Decision appends (§H). These refusal rules belong
to P3; they are not deferred to save/import in P4. Numeric bounds and their
candidate/freeze statuses remain unchanged; P4 decides their eventual values.

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
  and the values that make it true. CAN-03 fixes the exact QA01/QA02/QA09 byte derivations below as D rules
  before dependent P3 implementation; the machine S/R/W contract remains unchanged.
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

### CAN-03 R4-B — exact QA key and evidence bytes (D)

For the three rules below, `ruleVersion` is 1 and `determinism` is DETERMINISTIC.
`comparisonKey = value.trim()` using ECMAScript `String.prototype.trim` (including
U+3000): trim edges only; keep internal spaces; do not fold width, case or dashes.
Encode the following arrays with `JSON.stringify`, no additional whitespace,
UTF-8, SHA-256, lower-case 64-character hex:

```text
["m7.findingKey",1,ruleId,keyReason,...keyParts]
["m7.evidenceDigest",1,ruleId,ruleVersion,reasonOrNull,basis,sheets,entries,extra]
```

| Rule/reason | `keyReason` | `keyParts` |
|---|---|---|
| QA01_DUPLICATE_NUMBER | null | `[comparisonKey]` |
| QA02_METADATA_UNCONFIRMED | null (reason belongs in evidence, not identity) | `[sheetId]` |
| QA09_REGISTER_SHEET_MISMATCH / ACTUAL_NOT_LISTED | ACTUAL_NOT_LISTED | `[sheetId]` |
| QA09_REGISTER_SHEET_MISMATCH / LISTED_BUT_MISSING | LISTED_BUT_MISSING | `[comparisonKey]` |

Here ANL means ACTUAL_NOT_LISTED and LBM means LISTED_BUT_MISSING.

| Evidence component | QA01 | QA02 | QA09 ANL | QA09 LBM |
|---|---|---|---|---|
| reasonOrNull | null | QA02 reason | ACTUAL_NOT_LISTED | LISTED_BUT_MISSING |
| basis | cited Sheets' Sources | this Sheet's Source | this Sheet's Source and all live References' Sources | Sources of References containing the cited Entries |
| sheets | `[[sheetId,origin,rawDrawingNumber],...]` | `[[sheetId,origin,[drawingNumber,drawingTitle,revision,issueDate]]]`; values position is null for NONE | `[[sheetId,origin,rawDrawingNumber]]` | `[]` |
| entries | `[]` | `[]` | `[]` | `[[entryId,referenceId,rawDrawingNumber],...]`, all live matching Entries across all live References |
| extra | null | null | `[[referenceId,sourceSha256],...]` for all live References | the same pairs for References containing the cited Entries |

`basis` is the **unique** set of `[sourceId,currentFingerprintSha256]` pairs.
Sort basis by sourceId, sheets by sheetId, entries by entryId and extra by
referenceId, using lower-case UUID ASCII ascending order. Deduplicate the
Reference ids in extra. Values in evidence are stored values, **not trimmed**.
The four-field array always uses the canonical field order above.

Do not hash `confirmedAt`, observation `runId`, `editedFields`, OCR score,
extraction method, comment, time, row order/number, whether the set is fully
evaluable, or collection order. Do not hash Reference pageNumber, region, method,
declaredAt/updatedAt; Entry origin/title/revision/issueDate; record Profile id or
revision; observation rawText or source. Profile basis determines validity,
not evidence. QA09 compares numbers only. `extra` is always an array of pairs,
including when there is only one Reference.

### CAN-03 R4-D — statements, subjects and closing conditions (D)

| Rule | Evaluation and statement | Closing an old Finding no longer stated |
|---|---|---|
| QA02 | every live Sheet; first applicable reason below | always evaluated, including closure when the Sheet is retired |
| QA01 | live Sheets with origin not NONE and non-empty comparisonKey; one group of at least two Sheets per equal key | every cited Sheet was evaluated or is retired |
| QA09 ANL | register EVALUABLE; a live Sheet has input and non-empty comparisonKey absent from all live Entries | register EVALUABLE and its Sheet evaluated or retired; **MD-2 A:** also when register NONE |
| QA09 LBM | register EVALUABLE; a non-empty listed comparisonKey occurs on no evaluated Sheet; **MD-1:** one statement per number, citing every live matching Entry | register EVALUABLE and the number was found, or all live Sheets were evaluated, or no live Entry lists it; **MD-2 A:** also when register NONE |

QA02 reason priority: valid confirmation -> no statement; otherwise an existing
invalid confirmation -> RECONFIRM_REQUIRED; otherwise no observation -> NOT_READ;
otherwise invalid observation -> READ_IS_STALE; otherwise OCR_FAILED observation
-> OCR_FAILED; otherwise UNCONFIRMED. QA02 evidence uses the currently selected
QA input, even when its reason concerns an invalid older confirmation.

A non-EVALUABLE register produces no QA09 statement. NOT_CURRENT never closes
existing QA09 Findings. A question that could not be evaluated stays ACTIVE;
derive its currency instead. Do not persist an `incomplete` flag. Derive set
evaluability from current inputs/bindings each time (§I). Never state a findingKey
twice in one run. Canonical statement order is QA02 by Sheet id, QA01 by comparisonKey,
ANL by Sheet id, then LBM by comparisonKey. Use the reference generator's ECMAScript
string comparison (`<` / `>`); UUID ordering is ascending ASCII.

Store `sourceIds: []` for these three rules. QA01 has scope SHEET_GROUP and all
cited Sheet ids; QA02 and ANL have scope SHEET and one Sheet id; LBM has scope
REGISTER_ENTRY, no Sheet ids and all cited Entry ids. Other subject arrays are
empty; subject arrays and stored `basis` are ascending by id. Store basis as
`[{sourceId,sha256},...]` for the exact evidence basis. Params are only
`{comparisonKey}` for QA01, `{reason}` for QA02, and `{reason,comparisonKey}`
for QA09. No new saved fields are introduced.

Same key and evidence retains the Finding and its Decision. Different evidence
creates a new Finding, superseding the old one; all old Decisions remain attached
to the old Finding. Returning to an earlier evidenceDigest does not revive an
old Finding or Decision. Reconfirmation or re-extraction with the same values
alone retains evidence; changing OBSERVED to CONFIRMED changes evidence.
Any of the four QA02 values changing invalidates its prior Decision/exemption.

### CAN-03 reference vectors — complete UTF-8 input strings (D)

These are the six key vectors and four evidence vectors from the adopted R4.1
artifact. The JSON code blocks contain the complete strings to hash, with no
abbreviations or expansion symbols; hash the string, excluding the code fence
and its trailing newline. Existing §F manifestDigest vectors are unchanged.

#### findingKey — A-102

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"A-102"]
```

SHA-256: `5f6ca6605b3f4fd84ec56ddff2edf746ae44d310f4b6e5f09158a968b3874c34`.

#### findingKey — " A-102 " (trimmed)

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"A-102"]
```

SHA-256: `5f6ca6605b3f4fd84ec56ddff2edf746ae44d310f4b6e5f09158a968b3874c34`.

#### findingKey — "A-102\u3000" (ideographic space trimmed)

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"A-102"]
```

SHA-256: `5f6ca6605b3f4fd84ec56ddff2edf746ae44d310f4b6e5f09158a968b3874c34`.

#### findingKey — A 102 (internal space kept)

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"A 102"]
```

SHA-256: `d11c3bad16b1b19898cd823bd423451e9e069991367be34c64b88d313f362da1`.

#### findingKey — A102

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"A102"]
```

SHA-256: `5f7da822b161170d39ed0f18f24128e83eaf917c1aec45b802995e9485ce8709`.

#### findingKey — Ａ－１０２ (full width: hint only, never the same key)

```json
["m7.findingKey",1,"QA01_DUPLICATE_NUMBER",null,"Ａ－１０２"]
```

SHA-256: `e7d38b4243757fd030350223b0177a47c8c7cc1a8d332043ecc6da57950c0a26`.

#### evidenceDigest — QA02 OBSERVED, four values

```json
["m7.evidenceDigest",1,"QA02_METADATA_UNCONFIRMED",1,"UNCONFIRMED",[["00000000-0000-4000-8000-000000000002","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]],[["00000000-0000-4000-8000-000000000012","OBSERVED",[" A-102","平面図","A","2026/10/01"]]],[],null]
```

SHA-256: `b85873368b721aa91aed8ced5d9b2fd0fbea637139cec4047d0b21e1d49e102d`.

#### evidenceDigest — QA02 NONE

```json
["m7.evidenceDigest",1,"QA02_METADATA_UNCONFIRMED",1,"NOT_READ",[["00000000-0000-4000-8000-000000000002","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]],[["00000000-0000-4000-8000-000000000013","NONE",null]],[],null]
```

SHA-256: `1aa5f43726e07830485bde434599d936ccc1d91ffb9ed315cb8793d75cd3454b`.

#### evidenceDigest — QA09 ANL, two References

```json
["m7.evidenceDigest",1,"QA09_REGISTER_SHEET_MISMATCH",1,"ACTUAL_NOT_LISTED",[["00000000-0000-4000-8000-000000000001","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],["00000000-0000-4000-8000-000000000002","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],["00000000-0000-4000-8000-000000000003","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]],[["00000000-0000-4000-8000-000000000014","OBSERVED","A-105"]],[],[["00000000-0000-4000-8000-000000000020","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],["00000000-0000-4000-8000-000000000040","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]]]
```

SHA-256: `a158a2121d049e3ce53a4c37c5c36321eecf19a8ff54eb8f0a2c8c61eed47fa2`.

#### evidenceDigest — QA09 LBM, same number in two References

```json
["m7.evidenceDigest",1,"QA09_REGISTER_SHEET_MISMATCH",1,"LISTED_BUT_MISSING",[["00000000-0000-4000-8000-000000000001","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],["00000000-0000-4000-8000-000000000003","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]],[],[["00000000-0000-4000-8000-000000000023","00000000-0000-4000-8000-000000000020","A-104"],["00000000-0000-4000-8000-000000000042","00000000-0000-4000-8000-000000000040","A-104 "]],[["00000000-0000-4000-8000-000000000020","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],["00000000-0000-4000-8000-000000000040","dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]]]
```

SHA-256: `3527e8bde89d2e9abf07e20c509ef8241c64e9008acbd8db7aa3ffb738438478`.

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

### CAN-03 R4-F and R4.1-L — Decision writer guards (D)

**MD-4, adopted:** append only to an ACTIVE Finding whose derived currency is
CURRENT. Refuse a missing Finding (`NO_SUCH_FINDING`), an inactive one
(`FINDING_NOT_ACTIVE`), or STALE/UNVERIFIED (`FINDING_NOT_CURRENT`), without writing.
Then check existing Decision count + 1 against `maxDecisions` (100000). Overflow
returns runtime `DECISION_LIMIT_EXCEEDED` and writes nothing, including no id
allocation or clock tick in the reference model. Check the collection total,
not just this Finding's next sequence. Refusal remains required independently
of the MD-4 guard. Do not truncate or delete Decision history to free capacity.

A new Decision has an app-minted UUID, its Finding id, next contiguous per-Finding
sequence, outcome and inert comment, `decidedAt` at or after the Finding's
`createdAt`, and a copy of that Finding's evidenceDigest. No author is saved.
For Final readiness only ACTIVE Findings' effective Decisions are considered;
HOLD on a closed/superseded Finding is history and does not block Final.

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
  | `CURRENT` | `ACTIVE`, the current state restates the same question on the same evidence, cited Sources are MATCHED, and the LBM whole-set condition below holds |
  | `UNVERIFIED` | ACTIVE, not STALE, but a cited Source is not MATCHED or the LBM set is not fully evaluable |
  | `STALE` | ACTIVE, but its subject/basis moved, QA09 register is not EVALUABLE, or the current state would not restate the same key and evidence |
  | `HISTORICAL` | not `ACTIVE` |

- **A changed Source invalidates only what depends on it**: its Sheets' page facts, observations and
  confirmations, the findings that cite it, and a register declared from it. Other Sources are untouched. A
  missing file makes nothing stale — what depends on it is `UNVERIFIED`.
- **Human history remains.** Old confirmations become re-confirmation candidates; old decisions remain
  attached to the exact Finding evidence they concerned; old fingerprints stay in `fingerprintHistory`.

### CAN-03 R4-E — Finding currency precedence (D)

Use only stored Finding lifecycle, ruleId, sheetIds, registerEntryIds, basis,
findingKey, evidenceDigest and params.reason/comparisonKey, plus the current
DrawingSet and runtime bindings. Never parse diagnostic input strings or read
an unsaved comparisonKey. Apply the following in order:

1. Not ACTIVE -> HISTORICAL.
2. STALE if any cited Source is absent/retired or has a different fingerprint;
   any cited Sheet is absent/retired; any cited Entry or its Reference is not live;
   QA09's register state is not EVALUABLE; or a run now would not state the same
   findingKey with the same evidenceDigest. Reason, validity, origin, raw value
   and cited-Entry changes participate through the current statement/evidence.
3. Otherwise UNVERIFIED if any basis Source is not MATCHED, or an LBM's set is not
   fully evaluable. The LBM set is fully evaluable only when every current live
   Sheet has origin other than NONE and that Sheet's Source is MATCHED.
4. Otherwise CURRENT.

Recompute whole-set evaluability: adding/unreading a Sheet or losing binding can
turn LBM UNVERIFIED; retiring the only unread Sheet can make it CURRENT without
changing evidence. STALE precedes UNVERIFIED. No derived state is saved.

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
| no ACTIVE Finding has an effective `HOLD` — **HOLD = reviewed but blocks Final while ACTIVE** | `FINDINGS_ON_HOLD` |
| **CAN-03 MD-3:** completed QA exists on the current manifest and every current statement has an ACTIVE Finding with the same key/evidence | `QA_RESULT_NOT_CURRENT` |

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

### CAN-03 R4-H — current QA result and partial-rule boundary (D)

Preserve all six pre-existing blockers above. A QA02 exemption requires its
Finding to be **ACTIVE and CURRENT** and its effective Decision INTENTIONAL.
No other outcome exempts confirmation; exemption ends when evidence changes.

**MD-3, adopted:** add QA_RESULT_NOT_CURRENT if any of the following holds:
no completed QA run (`NO_QA_RUN`); the latest appended completed QA run's
manifestDigest differs from the current §F digest (`MANIFEST_CHANGED`); or a
statement a run would make now has no ACTIVE Finding with the same findingKey
and evidenceDigest (`UNSTATED`). A refused run adds no completion or freshness.
This checks current statement equivalence; it is not a timestamp-only test and
does not claim a new run is required for every edit that leaves results equal.

Beside blockers always enumerate what was not evaluated: every unimplemented
rule as NOT_IMPLEMENTED; QA09 with NO_DECLARED_REGISTER or REGISTER_NOT_CURRENT;
and input-less Sheets for QA01 and, when the register is EVALUABLE, QA09 as
SHEETS_WITHOUT_QA_INPUT. The latter is information, not another blocker: QA02
and METADATA_NOT_CONFIRMED handle those Sheets, including any INTENTIONAL
exemption. Do not portray an unevaluated Sheet as compared.

Derive status in order: **FINAL_UNAVAILABLE** if any rule is unimplemented;
otherwise **BLOCKED** if blockers exist; otherwise READY. For the initial
QA01/QA02/QA09 scope, QA01B, QA03–QA08 and QA10 remain unimplemented, so status
is always FINAL_UNAVAILABLE. A partial QA result is never all-rules PASS, an
all-rules completion, or a Final QA Report. Defining this boundary does not
authorize the initial P3 implementation or Final output.

## K. QA09 — declared Drawing Register vs actual Sheets

- Compares the **Human-declared Drawing Register (図面一覧)** with the live Sheets:

  | Reason | Statement | Subject |
  |---|---|---|
  | `LISTED_BUT_MISSING` | the declared register lists drawing number *X*, and no evaluated live Sheet carries it | **CAN-03 MD-1:** all live Entries listing X across all live References; one Finding per comparisonKey |
  | `ACTUAL_NOT_LISTED` | a live Sheet carries drawing number *X*, and no entry of the declared register does | one Sheet |

- **The exact drawing number is the canonical comparison** (trimmed, the same key as QA01). A folded or
  full-width spelling (`Ａ－１０２` against `A-102`) is never counted as a match (Human decision).
  **CAN-03 R4-I:** the initial P3 scope emits no such hints and does not write `params.values`;
  introducing hints is deferred to a separate QA01B decision, including their evidence dependencies.
- **No declared register → `NOT_EVALUABLE`, never `PASS`**: no finding, and the result says the set was not
  compared with a drawing list. It does not block Final — the register is optional.
- A declared register that is **not current** (its Source's bytes were replaced after it was declared) is
  not evaluated either, and that **does** block Final (`REGISTER_NOT_CURRENT`) until a person redeclares
  from current bytes **or withdraws the non-current References** (CAN-03 MD-2 option A). Evaluate no
  partial subset while any live Reference is not current. Withdrawing all References gives NONE; the
  next QA closes existing QA09 Findings NOT_REPRODUCED, preserving their Decision history.
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

### CAN-03 R4-I — runtime-only QA data (D)

Key/evidence input strings are diagnostics and test-vector data only: do not save
them or use them to derive currency, closing or readiness. Do not save derived
Finding currency, register state, set-wide evaluability, readiness, binding or
limit-refusal results. Use only existing schema fields, including the specified
params.reason/comparisonKey; no extra storage field is introduced. The closed
schema refuses additional saved properties. The initial P3 scope emits no
params.values hints; a future QA01B decision must settle hints and their evidence.

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

**CAN-03 R4.1-L application (D):** §F and §H apply the already adopted
fail-closed principle to planned QA output and Decision appends before any write.
Overflow refuses the entire operation without history deletion or partial output.
This changes neither the values nor the statuses in the table below.

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
- **M7-CAN-02 Human Adoption Gate — 2026-10-10:** new normative D decisions
  HDR-36-01 and HDR-36-02 adopted explicitly after PR #36 Independent FULL
  Review at `faf9d08b5d37041a90c40403f72ebb18c99997d9`. This is a
  new decision source, **not** part of the 2026-10-09 Architecture adoption or
  PR #33 research evidence. The `manifestDigest` bytes are a clarification
  of an already adopted rule. Adoption does not authorize merge or P2.

- **M7-CAN-03 Human adoption — 2026-10-28:** explicit approval in this PDF ArchiTools
  conversation under `M7-CAN03-R41-CONTRACT-PUBLISH-01`; CAN-03 R4.1 artifact
  `M7-CAN03-R4.1-LIMIT-ATOMICITY.zip`, SHA-256
  `c6bf864db66ecc0797ef3220a4be893dc0eb661b8f91cdff492db51c99c311cb`.
  Independent design re-review PASS / RF-01 CLOSED / Required Fix 0 binds that ZIP,
  not a commit. MD-1, MD-2 option A, MD-3 and MD-4 are explicitly adopted.
  Publication only: independent Contract Review of the publication head remains
  required before any dependent implementation; P3/P4 and Ready/merge/deploy
  are not authorized. No approval URL or additional approval id is asserted.
