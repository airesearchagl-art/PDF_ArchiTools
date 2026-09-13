# Extract — proposed contract

A proposal, not an adoption. Everything marked **recommended** is a
recommendation to the Human Gate; nothing here has been implemented and no
production file was changed by this research.

## Shape

The same two-phase shape M5 adopted, for the same reason: "it produced bytes"
and "it did what you asked" are different claims, and only a type can keep them
apart.

```text
plan(source, selection)  -> ExtractPlan     nothing has been read for output yet
run(plan)                -> ExtractResult   only a READY plan reaches a runner
publish(result)          -> handed over     only a validated artifact is published
```

Refusal statuses, in the order they should be decided:

```text
UNSUPPORTED_DOCUMENT      unreadable, or a page tree that cannot be walked
ENCRYPTED                 refused by the loader; a distinct answer, not a parse error
SIGNATURE_UNSAFE          an applied signature in the source
XFA_UNSAFE                XFA the operation would drop
EMPTY_SELECTION           nothing selected — refused before save(), never after
STRUCTURE_LOSS_REQUIRES_CONFIRMATION
BROKEN_DESTINATIONS       selected pages link to pages not in the selection
OVER_OUTPUT_BUDGET        the produced artifact exceeds the ceiling
CANCELLED                 the run was superseded
```

`EMPTY_SELECTION` exists because of a measured library default: `save()` adds a
blank A4 when a document has no pages (`api/PDFDocument.js:1253-1254`). An empty
extract must be refused in planning, or the product ships a blank page and calls
it a result.

## Page order

**Observed production fact:** the current export takes
`extractPages.filter(p => p.selected)` over an array built in page order, so
click order cannot affect output order — the output is always in source page
order. This is the correct semantics and should be adopted explicitly rather
than left as an accident of the implementation, because the UI offers no
reordering and a person who ticks page 5 then page 2 means "pages 2 and 5".

**Recommended:** selected pages are exported in source page order. If arbitrary
ordering is ever wanted it is a separate feature with its own UI, not a silent
consequence of click sequence.

## Internal destinations — the contract this operation most needs

A selected page may link to a page that was not selected. The brief names three
policies; the measurements add a fourth, which is what ships today.

```text
E0  what happens now: the link is kept AND the unselected page is silently
    copied into the file as an orphan, invisible to any reader
E1  refuse the selected set, naming the pages that would break
E2  keep the set, remove the broken internal link, and report it
E3  keep the set, drop the link silently
```

**E0 is worse than E3** and is the strongest single finding of this research.
E3 loses a link; E0 loses the link's usefulness *and* ships the content of pages
the user did not choose. For an extract made to share two pages of a
confidential drawing set, that is a disclosure, not a size problem. Measured:
extracting page 1 of `nav-4p` produced a file whose page tree holds 1 page and
whose bytes hold 3.

Feasibility, both measured against the library's behaviour:

- **E1 is feasible and cheap.** Destination targets can be resolved *before*
  copying: walk the selected pages' `/Annots`, resolve each `/Dest` or `/A /D`
  to a page reference, and compare against the selection. No copy is needed to
  know the answer.
- **E2 is feasible but not free.** Removing the annotation before the copy is
  straightforward; the orphan problem then disappears with it, because nothing
  references the excluded page any more. The cost is that the operation must
  edit the page's `/Annots` on a working copy, which means the source document
  must be treated as consumable — which it already is, since `copyPages` flushes
  it (`api/PDFDocument.js:644`).

**Recommended: E2 as the default, with E1 available as a stricter setting.**
E2 preserves the user's intent (they asked for these pages) while making the
loss explicit and, critically, removing the reference that causes the orphan
copy. E1 suits a workflow where a broken cross-reference is unacceptable.
E3 is not recommended and E0 must not survive contact with M6.

Either way the contract must state: **no page outside the selection may appear
in the output, in the page tree or out of it.** That is checkable —
`orphanPageCount` in the research gate already checks it.

## Structure

| item | recommended contract |
| --- | --- |
| page content, text, vectors, images, geometry | preserved — already true, and asserted |
| annotations on kept pages | preserved |
| URI links | preserved |
| internal links | per E1/E2 above |
| named destinations | reconstruct the entries whose target is a kept page; drop the rest **and say so** |
| outlines | reconstruct items whose target is kept, keeping their order; drop the rest and say so |
| page labels | reconstruct the ranges covering kept pages; this is arithmetic on `/Nums`, not a copy |
| `/OpenAction` | keep if its target is kept, otherwise drop and report |
| AcroForm / widgets | M6-H3 — but a widget must never ship without the field tree that gives it meaning |
| XFA | M6-H4 — following M5's `refuse-if-dropped` is the consistent answer |
| attachments, `/OCProperties`, `/StructTreeRoot`, document JavaScript | M6-H9 — recommended: declare unsupported and report as a named loss, rather than pretend |
| metadata | M6-H7 — recommended: carry it, under M5's H12 contract, since Extract has exactly one source |

The pattern is deliberate: **reconstruct what can be reconstructed from the kept
pages, refuse what cannot be, and never let something survive in a form that
looks alive and is not.** An orphan widget is the clearest example of the last
one.

## Signatures

**M6-H1.** An Extract artifact is a new derived document; the source's applied
signature cannot authenticate it, and re-serialising invalidates it in any case.

```text
A  hard refuse any source carrying an applied signature
B  permit, with an explicit confirmation that the derived PDF is unsigned
```

Measured today: a signed source produces a 1,242 B ordinary-looking file with no
AcroForm and no warning — the outcome both candidates exist to prevent.

**Recommended: B**, with A available. Extracting two pages from a signed drawing
set to send to a colleague is a legitimate thing to want, and the derived file is
honestly unsigned; M5 chose refusal because its operations claimed to preserve
the document, which Extract does not. The confirmation must say plainly that the
result is not signed — reusing M5's confirmation machinery, which is per-run and
has deliberately no "always allow".

An **empty** `/Sig` field is a form control, not a signature. Measured: it reads
as unsigned. M6 must not re-derive this distinction differently from M5 H7.

## Metadata

**Recommended (M6-H7):** carry the single source document's Info and `/Metadata`
stream under M5's H12 contract — every entry including custom and indirect
values, the XMP stream cloned with its dictionary, and a typed refusal rather
than a silent partial copy. Extract has one source, so there is no ambiguity to
resolve, and M5 already owns a tested implementation of exactly this.

Load and create must pass `updateMetadata: false`; otherwise pdf-lib overwrites
`/Producer` and `/ModDate` before anything else happens.

## Ownership, publication and naming

- **Ownership (M6-H13):** a preview or export is owned by a run token; changing
  the source file, the selection, the tab, or leaving the component supersedes
  it. Measured today: two previews started together finish in the order
  `second → first`, so the slower one wins the screen.
- **Publication:** validated artifact + current ownership → download handoff →
  cleanup. The object URL must be revoked. Measured today: 5 exports created 5
  object URLs and revoked none.
- **Output ceiling (M6-H11):** the produced artifact is checked before handoff,
  not estimated.
- **Naming (M6-H14):** `extracted_<source>.pdf` overwrites on repeat and says
  nothing about which pages it contains. Recommended:
  `<source>_p1,3,5-8.pdf`, deterministic and self-describing, with the selection
  summarised rather than enumerated past a stated length.
