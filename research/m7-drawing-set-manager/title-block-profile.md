# Title Block Profile (R7)

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**
> A proposal for Independent Architecture Review. Nothing here is adopted.
> Prototype: `TitleBlockProfile` in `portable-project.schema.proposed.json`, `prototype/register-adapter.mjs`.
> Tests: `tests/reuse-parity.test.mjs`, `tests/stale.test.mjs`.

M7 has to hold several Title Block Profiles in one Drawing Set and keep them across sessions. The existing
Drawing Register already defines what a profile *is*. The first constraint on any M7 model is that it does
not contradict that.

## 1. What the existing Drawing Register fixes

Read from `src/utils/pdf-textifier/drawing-register-types.ts`, `drawing-register-geometry.ts`,
`drawing-register-template.ts` and `table-geometry.ts`, and executed by `tests/reuse-parity.test.mjs`.

| Aspect | Existing semantics |
|---|---|
| **Coordinate space** | *Upright page space*: "origin top-left of the page as it would be without its `/Rotate`, y downwards, PDF points at scale 1". One space for rectangles and for the tokens found in them, "because a rectangle drawn in one space and a token found in another do not describe the same field". |
| **Units** | Absolute PDF points. **Not** fractions. |
| **Page rotation** | Stored rectangles are already upright. A rectangle drawn on a rotated page is un-rotated when it is drawn (`toUprightRect`); tokens are un-rotated when they are read; a region is rendered for OCR at `rotation: 0`, because rendering through `/Rotate` crops the right pixels and hands the recogniser text lying on its side. |
| **Which box** | The register does not read `CropBox` or `MediaBox`. It takes the page from PDF.js's scale-1 viewport, whose box is PDF.js's `page.view` — the **visible box** (the CropBox within the MediaBox). So the origin is the visible box's top-left corner. |
| **Page size** | `uprightWidth` / `uprightHeight`: the viewport's size with a quarter turn undone. |
| **Moving to another page size** | A `TransferModel` chosen **by a person**: `normalised` (the title block is a fraction of the sheet and grows with the paper) or `corner-anchored` (a fixed physical size at a fixed distance from the **bottom-right** corner). Two conventions exist "and neither can be inferred": "each model reads its own convention almost completely and the other one almost not at all." Both are clamped to the page. |
| **Fields** | Exactly four, all required: `drawing_number`, `drawing_title`, `revision`, `revision_date`. "Not extensible in this release." A profile missing one cannot be created. |
| **Assignment** | Per page, by a person, with the moment recorded (`PageAssignment { pageNumber, profileId, confirmedAt }`): "An assignment nobody made is the thing this structure exists to prevent." |
| **Change** | One counter for the whole arrangement (`sourceRevision`). Any change to any profile or assignment makes every row read under the old arrangement unexportable. |

The title-block **updater** (`src/utils/title-block-updater.ts`) uses a *different* rectangle — fractions of
the **displayed** page, after `/Rotate`. It is a writer, not a reader, and it is not the semantics M7
follows (see `reuse-audit.md`, candidate 11).

## 2. Candidates compared

How should a profile's rectangles be persisted?

| | A. Upright points + reference page + transfer model | B. Normalised fractions only | C. Corner offsets only | D. Fractions of the displayed page |
|---|---|---|---|---|
| **What is stored** | the four rectangles as drawn, the size of the page they were drawn on, and the model | each edge as 0…1 of the page | distance from a corner and a size, in points | the updater's `NormalizedRect` |
| **`normalised` transfer** | exact | exact | **cannot express** | exact only at one rotation |
| **`corner-anchored` transfer** | exact | **cannot express** — the physical size is gone | exact | cannot express |
| **Same as the engine's `TemplateProfile`** | **yes — field for field** | no; a conversion each way | no | no; a different space |
| **Page rotation** | independent of `/Rotate` | independent | independent | **depends on `/Rotate`** — the same sheet rotated needs a different rectangle |
| **Round trip through the file** | bit-exact (tested) | loses the reference size | loses the reference size | — |
| **Contradicts the Drawing Register** | **no** | yes — it drops a model a person chose | yes | yes |

**Recommendation: A.** It is the only candidate that expresses both transfer models, and it is the engine's
own representation, so the adapter between M7 and the engine is a renaming and nothing else. This is also
the Task Packet's rule for R7 — prefer the model that does not contradict the register's geometry.

"Normalised coordinates" are therefore **not the stored form**. They are what the `normalised` transfer
model *computes* when it moves a rectangle to another page size. Storing only the fractions would silently
turn every `corner-anchored` profile into a `normalised` one.

### Evidence

`tests/reuse-parity.test.mjs`, "a profile saved by M7 and loaded again places every rectangle exactly where
the engine's own profile does": a `TemplateProfile` is made by the engine's `createProfile`, converted to an
M7 profile, written to a Project file, read back, converted back, and handed to the engine's `applyProfile`
on five pages — A1 landscape, A3 landscape, A0 landscape, A1 portrait, and a page smaller than the title
block. The rectangles must be **identical**, for both transfer models. They are: the numbers go through JSON
and come back as the same doubles.

## 3. Proposed model

```jsonc
// TitleBlockProfile -- PROPOSED / NON-CANONICAL
{
  "id": "…uuid…",
  "name": "A1 title block",
  "revision": 3,                       // +1 on every change to what the profile reads
  "transferModel": "corner-anchored",  // or "normalised"; chosen by a person, never inferred
  "referencePage": { "uprightWidthPt": 2383.94, "uprightHeightPt": 1683.78 },
  "fields": {                          // upright page space, PDF points, origin top-left, y down
    "drawingNumber": { "left": 2150, "top": 1600, "right": 2360, "bottom": 1640 },
    "drawingTitle":  { "left": 1850, "top": 1600, "right": 2140, "bottom": 1640 },
    "revision":      { "left": 2150, "top": 1645, "right": 2250, "bottom": 1675 },
    "issueDate":     { "left": 2255, "top": 1645, "right": 2360, "bottom": 1675 }
  },
  "createdAt": "…", "updatedAt": "…",
  "retiredAt": null                    // a removed profile is retired, not deleted
}
```

| Question | Proposal |
|---|---|
| **Normalised coordinates** | Not stored. Computed by the `normalised` transfer from the stored points and the reference page. |
| **Coordinate space** | The register's upright page space, unchanged. |
| **Page rotation** | Not part of a profile. Rectangles are upright; `/Rotate` is a fact of each *sheet* (`pageFacts.rotate`). |
| **CropBox / MediaBox** | The visible box, as PDF.js reports it — the register's own choice. A profile does not name a box. If a later version of a PDF changes its CropBox, the rectangles shift with it; that is a Source change and stales what was read (R2). |
| **Portrait / landscape** | Not part of a profile either; it follows from the upright size. One profile does not serve both orientations of a title block — that is what several profiles are for. |
| **Validity** | Every rectangle is non-empty and lies on its reference page (`REL_RECT_INVALID`); coordinates are finite and within 0…14 400 pt. |
| **Field definitions** | The engine's four, all required: `drawingNumber` ↔ `drawing_number`, `drawingTitle` ↔ `drawing_title`, `revision` ↔ `revision`, `issueDate` ↔ `revision_date`. |

**`issueDate` and `revision_date`.** The Task Packet names the fourth field `issueDate`; the engine's fourth
field is `revision_date`, shown on screen as `日付` ("date"). The proposal maps one to the other because
they are the same rectangle on the sheet. Whether a title block's single date *means* an issue date or a
revision date is not something a rectangle knows. See Unresolved U-8.

## 4. Assignment

| | (a) Per sheet, materialised | (b) Source-level default | (c) Stored page ranges |
|---|---|---|---|
| **Stored as** | `Sheet.profileAssignment { profileId, confirmedAt }` | a `profileId` on the Source, plus per-sheet overrides | `{ sourceId, fromPage, toPage, profileId }[]` |
| **Same as the engine** | **yes** — `PageAssignment` | no | no (the engine parses a range once, at assignment time) |
| **When a Source gains pages** | new sheets are unassigned until a person assigns them | new sheets **silently inherit** a profile | new sheets inherit, or fall off the end of a range |
| **Overlap / precedence rules** | none possible | default vs override | ranges can overlap; needs a rule |
| **Validation** | one foreign key per sheet | two levels | interval logic |
| **"An assignment nobody made"** | cannot happen | **can happen** | **can happen** |

**Recommendation: (a).** Source-level assignment and page-range assignment are **operations in the
workspace** ("assign this profile to every sheet of this Source", "to pages 3–40"), and what they *write* is
one assignment per sheet, each with the moment a person made it. The engine's `parsePageRange` and
`AssignmentSet.assign` (which returns conflicts instead of overwriting) are reusable for those operations.

A materialised assignment costs about 100 bytes per sheet in the file, out of the roughly 1.8–2.2 kB per
sheet measured overall (`benchmark/results/SUMMARY.md`).

**Several profiles per Drawing Set** are a flat `titleBlockProfiles[]` (candidate bound: 64). A sheet has
zero or one. A sheet with none can still be confirmed by typing its values, and such a confirmation records
`profile: null`.

## 5. What a profile change makes stale

The engine has one arrangement counter, so a change to any profile invalidates every row. M7 refines the
*scope* of that rule without weakening it: **each profile carries its own `revision`**, and every
observation and confirmation records the `profileId` and `profileRevision` it was made under.

| Change | `revision` | Stale | Not stale |
|---|---|---|---|
| A field rectangle moved or resized | +1 | observations and profile-based confirmations of **sheets assigned to that profile** | other profiles' sheets; page facts; confirmations made with no profile |
| Transfer model changed | +1 | same | same |
| Reference page changed | +1 | same | same |
| Profile renamed | — | nothing | everything |
| A sheet moved to another profile | — | that **one sheet's** observation and profile-based confirmation | every other sheet |
| Profile retired | — | its sheets become unassigned, hence stale as above | the profile stays in the file; history still resolves |

`tests/stale.test.mjs` checks each row ("PROFILE_GEOMETRY_CHANGED…", "SHEET_REASSIGNED…", "a retired
profile…"). The engine's rule is preserved in substance: a value read under an arrangement that no longer
exists is never used, and a confirmation of such a value is not trusted until a person makes it again. The
last test in `tests/reuse-parity.test.mjs` shows the engine's own `exportReadiness` refusing a row read
under an older `sourceRevision`.

A confirmation is asked for again after a profile change **because of what it was a confirmation of**. A
person who accepted the machine's proposal confirmed a reading taken through rectangles that have since been
judged wrong enough to change. The value is kept and shown — it is very likely still right — but nobody has
confirmed it against the new reading. A confirmation typed with no profile involved is a person's own reading
of the sheet, and no profile change can reach it.

## 6. Limits of this proposal

| Limitation | Why it is left |
|---|---|
| `corner-anchored` anchors to the **upright bottom-right** corner only. A fixed-size title block along another edge is not expressed exactly across page sizes. | It is the engine's semantics. A choice of anchor corner would be an engine change, not an M7 schema decision. |
| A profile needs all four rectangles. A title block with no revision cell still needs a rectangle for it. | Same: the engine requires all four. |
| `/UserUnit` was not examined in the register path. The Comparator refuses a page whose `userUnit` is not 1. | Not measured here — recorded in `limitations.md`. |
| The profile is not bound to a Source's bytes. | Deliberately: a profile describes a title block layout, and applies to any sheet a person assigns it to. What was *read* with it is bound to bytes. |
