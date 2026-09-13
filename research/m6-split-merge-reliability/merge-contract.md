# Merge — proposed contract

A proposal, not an adoption.

## Shape

```text
intake(files)        -> IntakeResult per input      before anything is merged
plan(ordered list)   -> MergePlan                   nothing has been copied yet
run(plan)            -> MergeResult
publish(result)      -> handed over
```

## Intake — the part that is silently wrong today

**Observed production fact:** `handleMergeUpload` skips anything whose MIME type
is not `application/pdf` with a bare `continue` (`PdfSplitMerge.tsx:128`) and
swallows a failed load with `console.error` (`:139-141`). In both cases the file
never appears in the list, and the user is told nothing. Five files chosen, four
merged, and the result is presented as an ordinary success.

Every input must therefore carry an explicit result:

```text
ACCEPTED
UNSUPPORTED        not a PDF
UNREADABLE         the loader refused it
ENCRYPTED          distinct from unreadable, because the remedy is different
SIGNATURE_UNSAFE   an applied signature in the source
XFA_UNSAFE         XFA that the merge would drop
CANCELLED          the run was superseded before this file was reached
```

Measured intake behaviour, so the classification is not hypothetical:

| fixture | `PDFDocument.load` |
| --- | --- |
| `invalid` | throws — `No PDF header found` → UNREADABLE |
| `encrypted` | throws — `…is encrypted` → ENCRYPTED |
| `broken-pagetree` | **loads, reports 1 page** |
| `malformed-acroform` | **loads, reports 1 page** |

The last two matter: intake cannot be "whatever the loader accepts". A document
whose `/Count` disagrees with its `/Kids` loads cleanly and will fail later, so
the page tree has to be walked during intake, exactly as M5's `SourceFacts` walks
one before planning.

### All-or-nothing, or explicit partial? (M6-H10)

```text
A  all-or-nothing: any non-ACCEPTED input refuses the whole merge
B  explicit partial: merge what can be merged, and state what was omitted
```

**Recommended: B, with A's honesty.** M5 adopted the same shape for its batch
(H4/B2): produce what can be produced, and ship a manifest naming every input,
what happened to it, and under which code. A merge has an advantage the batch
does not — the omission is visible in the result itself, because the pages are
missing — but "visible if you count the pages" is not telling someone. The
result must name every omitted source in the UI, and the run must be refusable
before it starts.

What must never happen is today's behaviour: an input that disappears between
the file picker and the list.

## Order

Measured, with per-page markers:

| case | pages | order |
| --- | --- | --- |
| A + B | 5 | A1 A2 A3 B1 B2 |
| B + A | 5 | B1 B2 A1 A2 A3 |
| A + A | 6 | the same file twice, no deduplication |
| A + B + C | 7 | C's 270° rotation preserved |

**Recommended:** adopt exactly this — file-list order, then each file's own page
order. No sorting by filename, no deduplication of repeated files, no
normalisation of page size or rotation. All four are already true and should be
stated rather than left to chance.

## Structure and collisions

Measured on two documents that deliberately share a field name, a named
destination, an outline title and page labels:

```text
AcroForm            absent
widgets on pages    2, belonging to no field
named destinations  0
outline items       0
page labels         0
Info                /Producer /ModDate /Creator /CreationDate
```

So **the collision never arises today, because everything that could collide is
dropped first.** That is not a resolution; it is a loss shaped like one. Object
numbers, the collision people expect, genuinely cannot collide — pdf-lib
renumbers every copied object (`core/PDFObjectCopier.js:100`).

| item | recommended contract |
| --- | --- |
| page content and geometry | preserved — already true |
| links within one source | preserved and retargeted — already true, because every page of that source is copied |
| external URIs | preserved |
| named destinations | reconstruct with a per-source prefix on collision; report the renaming |
| outlines | reconstruct as one outline per source, titled by source filename, preserving each source's items beneath it |
| page labels | reconstruct as concatenated ranges; where sources disagree, prefix by source |
| AcroForm / duplicate field names | M6-H3. A merged form with two fields called `shared.field` is ambiguous by construction: one value would overwrite the other. Recommended: rename on collision (`<source>.shared.field`) and report, or refuse — never ship two widgets bound to one name |
| XFA | M6-H4 — recommended: refuse a source carrying XFA, following M5 |
| attachments, OCG, tags, JavaScript | M6-H9 — recommended: declare unsupported and name the loss |

## Metadata (M6-H8)

Merge has several sources and therefore no self-evident answer. The candidates,
with what the measurements say about each:

```text
M1  first source's metadata
M2  neutral, newly-derived metadata
M3  the user chooses which source's metadata to keep
M4  synthesized provenance: derived metadata that names the sources
```

Today the answer is none of them: the output carries pdf-lib's four keys, which
is M2 by accident and without saying so.

**Recommended: M4, with M1 available.** A merged document is a new document, and
the honest metadata for it is metadata that says so — a title derived from the
operation, and a record of which files it was built from. M1 is the right choice
when a merge is really "append appendices to this drawing", which is a common
shape for this product's users, so it should be offered rather than assumed. M3
adds a decision to every merge for a benefit M1 already covers. M2 is what
happens now and tells the user nothing.

Whatever is chosen, it must be *chosen*: `updateMetadata: false` on load and
create, then the policy applied deliberately.

## Signatures (M6-H2)

A source signature cannot authenticate a newly combined document, and no
candidate preserves it. Measured today: merging a signed source produced a
5-page ordinary file with no mention of the signature.

```text
A  refuse any source carrying an applied signature
B  permit with explicit confirmation that the merged PDF is unsigned
```

**Recommended: A for Merge**, unlike Extract. The asymmetry is deliberate and
worth stating: an extract of a signed document is plausibly still "part of that
document", and the person can reasonably accept an unsigned derivative. A merge
mixes a signed document into other people's content, and the combined artifact
carries the signed document's appearance without its guarantee. Refusing is the
answer that cannot be misread, and the empty `/Sig` case remains permitted
because an unsigned signature field is a form control.

## Ownership, publication and naming

- **Ownership (M6-H13):** adding, removing or reordering a source, switching
  tab, leaving the component, or starting another merge supersedes the run in
  flight. Nothing superseded may publish.
- **Publication:** validated artifact + current ownership → handoff → revoke.
- **Naming (M6-H14):** every merge is `merged_document.pdf` today, so a second
  merge overwrites the first in the download folder. Recommended:
  `merged_<n>files_<firstSourceName>.pdf`, or a name derived from the sources.
