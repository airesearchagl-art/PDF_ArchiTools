# Extract — proposed contract

A proposal, not an adoption. Everything marked **recommended** is a
recommendation to the Human Gate; nothing here has been implemented in
production and no production file was changed by this research. The prototypes
under `prototype/` exist to show that a contract is implementable, not to be
shipped.

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
UNSUPPORTED_FORM          form features outside the stated subset
FIELD_SPANS_SELECTION     a field whose widgets straddle kept and dropped pages
EMPTY_SELECTION           nothing selected — refused before save(), never after
STRUCTURE_LOSS_REQUIRES_CONFIRMATION
BROKEN_DESTINATIONS       E1 only: the selection would break navigation
OVER_OUTPUT_BUDGET        the produced artifact exceeds the ceiling
CANCELLED                 the run was superseded
```

`EMPTY_SELECTION` exists because of a measured library default: `save()` adds a
blank A4 when a document has no pages (`api/PDFDocument.js:1253-1254`). An empty
extract must be refused in planning, or the product ships a blank page and calls
it a result.

## The invariant

```text
every indirect /Page object in an Extract artifact
is a member of that artifact's output page tree
```

i.e. `orphanPageCount === 0`, checked **after serialization** by reopening the
bytes. Not a research measurement — a production contract, because the thing it
prevents is shipping the content of pages the user did not select.

Its companion:

```text
every surviving internal destination targets a page of that same tree
```

`dangling = 0` and `orphan-target = 0`, unless the adopted policy deliberately
removed the link, in which case the removal is reported.

## Page order

**Observed production fact:** the current export takes
`extractPages.filter(p => p.selected)` over an array built in page order, so
click order cannot affect output order — the output is always in source page
order. This is the correct semantics and should be adopted explicitly rather
than left as an accident of the implementation, because the UI offers no
reordering and a person who ticks page 5 then page 2 means "pages 2 and 5".

**Recommended:** selected pages are exported in source page order.

## Internal destinations — measured per shape

The brief named three policies. The measurements add a fourth, which is what
ships today and is worse than any of them.

```text
E0  what happens now: the link is kept AND the page it points at is copied into
    the output as an orphan — outside /Pages, invisible to a reader, in the bytes
E1  refuse the selected set, naming the pages that would break
E2  keep the set, remove or retarget the link, and report what was removed
E3  keep the set, drop the link silently
```

### What today does, one shape at a time

| case | pages in tree | orphan pages | destinations landing in the document |
| --- | --- | --- | --- |
| `/Dest` → **selected** page | 2 | **1** | **0** |
| `/Dest` → excluded page | 1 | 1 | 0 |
| `/A /GoTo /D` → **selected** page | 2 | **1** | **0** |
| `/A /GoTo /D` → excluded page | 1 | 1 | 0 |
| named destination, both kept | 2 | 0 | 0 |
| named destination → excluded page | 1 | 0 | 0 |
| cyclic destinations, one page kept | 1 | **2** | 0 |
| two pages sharing a target, target excluded | 2 | 1 | 0 |
| two pages sharing a target, target kept | 3 | **1** | 0 |
| article bead `/B` → another page | 1 | **2** | 0 |

Read the first row again: **even when the target page is selected**, the output
holds an orphan copy and no destination lands in the document. The link resolves
and navigates nowhere a reader can reach. The cause is in the library —
`copyPDFPage` clones the leaf before memoising it
(`core/PDFObjectCopier.js:43,64`), so a page reached both as a `copyPages`
argument and through a reference is copied twice, and the destination is
remapped onto the copy that never enters `/Pages`.

The last row matters for a different reason: **`/Annots` is not the only route**.
An article bead on a selected page chains through `/N` to a bead whose `/P` is
another page, and that page is copied. A contract that inspected only
annotations would have been wrong and would have looked right.

### What the prototypes show

`prototype/extract-destinations.mjs`. The order is the whole trick: strip every
internal destination from the pages being copied — **including the ones whose
target is kept**, because leaving them is what makes the copier drag a duplicate
in — then copy, then rebuild from the output's own page references.

| | today | E2 |
| --- | --- | --- |
| orphan page objects | 1–2 wherever a page reference exists | **0 in all ten cases** |
| destinations landing in the output tree | 0 | every surviving one |
| dangling destinations | 2 per affected case | **0** |
| removed links | unreported | reported by name |

Two pages addressing the same target both retarget to it (`targets: [2,2]`),
cyclic destinations resolve without looping, and named destinations whose target
survives are rebuilt while the rest are reported.

E1 refuses before copying anything — the answer is knowable from the source, so
no page needs to be touched to get it — and allows a selection that keeps its
targets. It also detects the non-annotation route during planning:
`[{"fromIndex":0,"key":"B"}]`.

**Recommended: E2 as the default, with E1 available as a stricter setting.**
E2 preserves the user's intent while making the loss explicit and, critically,
removing the reference that causes the orphan copy. E3 is not recommended, and
E0 must not survive contact with M6.

## Forms — a stated subset, or a refusal

`prototype/form-subset.mjs`. Supported field types: `/Tx`, `/Btn`, `/Ch`,
`/Sig`. A document leaves the subset — and is refused with `UNSUPPORTED_FORM` —
when it carries AcroForm `/CO`, any field `/AA`, or a document-level
`/Names /JavaScript` tree, because those can reach a field by name from
somewhere a structural rewrite does not look.

Measured:

| case | result |
| --- | --- |
| form wholly inside the selection | AcroForm rebuilt, **2 fields, values `M6-FIELD-ONE` / `M6-FIELD-TWO` preserved, 0 orphan widgets** |
| field whose widgets straddle the selection | typed refusal `FIELD_SPANS_SELECTION` |

The straddling case is a refusal rather than a best effort because half a field
is not a smaller field: the value belongs to neither half, and a widget that
renders while bound to nothing is precisely the state this contract exists to
forbid.

**Recommended:** reconstruct over the stated subset; refuse outside it. Whether
the MVP should ship reconstruction at all, or refuse forms outright and follow
with a Form Reconstruction Sub-Spike, is left open in `human-gate.json` M6-H3.

## Signatures — the appearance is the finding

**M6-H1.** An Extract artifact is a new derived document; the source's applied
signature cannot authenticate it, and re-serialising invalidates it in any case.

What the measurements add is that **removing the signature does not remove the
signature block**:

```text
before   AcroForm present, 1 signature field, 1 applied value
after    AcroForm absent, 0 signature fields, 1 orphan widget — with its /AP
render   4,325 non-white pixels of 24,300 in the source
         4,325 non-white pixels of 24,300 in the extract
```

Pixel for pixel. A reader opening the derived file sees a signed-looking
document that carries no signature.

```text
A  hard refuse any source carrying an applied signature
B  allow the unsigned derivative, but remove the signature widget and its /AP
C  allow, with a persistent artifact-level unsigned-derivative indication
```

**Recommended: B.** The earlier version of this research recommended allowing
the derivative with a confirmation and said nothing about the appearance, which
the measurement now shows is the part that matters to whoever opens the file.
C is a reasonable addition to B rather than an alternative; A stays correct for
anyone who does not want derived copies of signed documents at all.

An **empty** `/Sig` field is a form control, not a signature. Measured: it reads
as unsigned. M6 must not re-derive this distinction differently from M5 H7.

## Structure, item by item

| item | recommended contract |
| --- | --- |
| page content, text, vectors, images, geometry | preserved — already true, and asserted |
| annotations on kept pages | preserved |
| URI links | preserved |
| internal links | E2 above |
| named destinations | reconstruct entries whose target is kept, report the rest — **prototyped** |
| outlines | reconstruct items whose target is kept — *not prototyped*; see M6-H6 |
| page labels | reconstruct ranges covering kept pages — *not prototyped*; see M6-H6 |
| `/OpenAction` | retarget when its target is kept, drop and report otherwise |
| AcroForm / widgets | the subset above |
| XFA | refuse, following M5 |
| `/StructTreeRoot` | strip every remnant including the page's `/StructParents`, and report the accessibility loss — M6-H9a |
| `/OCProperties` | carry the configuration for groups the kept pages reference — M6-H9b |
| document JavaScript | sanitize and report — M6-H9c |
| attachments | remove with explicit confirmation — M6-H9d |
| metadata | carry it, under M5's H12 contract — M6-H7 |

## Ownership, publication and naming

- **Ownership (M6-H13):** a preview or export is owned by a run token; changing
  the source file, the selection, the tab, or leaving the component supersedes
  it. Measured today: two previews started together finish `second → first`, so
  the slower one wins the screen.
- **Publication:** validated artifact + current ownership → download handoff →
  cleanup. The object URL must be revoked. Measured today: 5 exports created 5
  object URLs and revoked none.
- **Output ceiling (M6-H11):** the produced artifact is checked before handoff,
  not estimated.
- **Naming (M6-H14):** `extracted_<source>.pdf` overwrites on repeat and says
  nothing about which pages it contains. Recommended:
  `<source>_p1,3,5-8.pdf`, deterministic and self-describing.
