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

## Forms — simple `/Tx`, and a refusal for everything else

`prototype/form-subset.mjs`. **Supported: `/Tx` only**, and only in its simple
shape — a merged field/widget dictionary with none of `/Ff`, `/DV`, `/AA`, no
separate widget dictionaries, no inherited `/FT` or `/V`, and a `/DA` that does
not name a font living in AcroForm `/DR`.

An earlier version of this document advertised `/Tx /Btn /Ch /Sig`. The
reconstruction only ever restored `/T`, `/FT` and `/V` — it read `/Ff` without
writing it back, never touched `/DV`, never carried `/DR`, and never checked a
button's `/AS` against its `/AP`. Four type names on one type's evidence.

Measured, one fixture per shape:

| case | result |
| --- | --- |
| `form-tx-plain` | AcroForm rebuilt, value `M6-TX-VALUE` preserved, **0 orphan widgets** |
| `form-tx-ff` | `UNSUPPORTED_FORM` — `/Ff` is read and never restored |
| `form-tx-dv` | `UNSUPPORTED_FORM` — `/DV` is not restored |
| `form-dr` | `UNSUPPORTED_FORM` — the `/DA` names a `/DR` font that is not carried |
| `form-separate-widget` | `UNSUPPORTED_FORM` — the field's entries live on a dictionary the copy does not keep as a field |
| `form-hierarchical` | `UNSUPPORTED_FORM` — `/FT` and `/V` are inherited rather than carried |
| `form-checkbox` | `UNSUPPORTED_FORM` — `/AS` ↔ `/AP` consistency is unproven |
| `form-radio` | `UNSUPPORTED_FORM` — kids hold their own appearance states |
| `form-choice` | `UNSUPPORTED_FORM` — `/Opt` is not restored |
| `form-field-across-pages` | `FIELD_SPANS_SELECTION`, reported **before** the general subset refusal so the sharper reason is the one given |

The straddling case keeps its own code deliberately. Once separate widget
dictionaries became a subset refusal, a straddling field would have reported the
vaguer `UNSUPPORTED_FORM`; both statements are true and only one is useful, so
the straddle is decided first and the other reasons travel with it in the
message.

Half a field is not a smaller field: the value belongs to neither half, and a
widget that renders while bound to nothing is exactly the state this contract
exists to forbid.

**Recommended: S1-A** — reconstruct simple `/Tx`, refuse everything else.
Widening the subset means adding fixtures and post-readback proof per type, not
editing a list of names. Whether the MVP ships even this much, or refuses
AcroForm entirely and defers to a Form Reconstruction Sub-Spike, is M6-H3.

## Optional content — carried inside a stated envelope

`prototype/optional-content.mjs`. Today the catalog entry is dropped while the
page keeps the `/Properties` naming the group, so the artifact's marked content
references a configuration the document no longer has.

Groups are matched **structurally**, never by position:

```text
selected source page + /Properties key + source OCG ref
    ->  output page  + same key        + output OCG ref
```

with the resulting output refs deduplicated. An earlier version paired them by
position and reset its source cursor on every output page, so one kept page
worked and two silently swapped `ON` for `OFF`.

| case | result |
| --- | --- |
| `ocproperties` (one group, one page) | carried — 1 group, 1 on |
| `ocg-multiple` (two groups, one page) | carried — 2 groups, 1 on, 1 off |
| `ocg-two-pages-opposite` | carried — **2 groups, `on [M6-OCG-A]`, `off [M6-OCG-B]`** |
| `ocg-shared-across-pages` | carried — 1 group, referenced from both pages |
| `ocg-reordered-properties` | carried — 2 groups, keys written in opposite order on each page |
| `ocg-many-pages` | carried — 3 groups over 3 pages, 2 on, 1 off |
| `ocg-d-name` | carried — `/D /Name` reproduced |
| `ocg-basestate-on` | carried — `/BaseState /ON` reproduced |
| `ocg-order-flat` | carried — `["M6-ORD-A","M6-ORD-B","M6-ORD-C"]` |
| `ocg-order-nested` | carried — **`["M6-ORD-A",["M6-ORD-B","M6-ORD-C"]]`**, nesting intact |
| `ocg-order-labeled-nested` | carried — **`["M6-ORD-A",["label:M6-ORDER-LABEL","M6-ORD-B","M6-ORD-C"]]`** |
| `ocg-order-empty` | carried — present and **empty**, not filled in |
| `ocg-order-absent` | carried — **absent**, not invented |
| `ocg-order-malformed` | `UNSUPPORTED_OPTIONAL_CONTENT` |
| `ocmd` | `UNSUPPORTED_OPTIONAL_CONTENT` |
| `ocmd-nested` (a `/VE` expression) | `UNSUPPORTED_OPTIONAL_CONTENT` |
| `ocg-basestate-off` | `UNSUPPORTED_OPTIONAL_CONTENT` |

Every carried case is compared with its source **after reopening the artifact**,
on group count, group names, `ON`, `OFF`, `/D /Name`, `/BaseState`, **the
`/Order` structure** and page `/Properties` resolution — all equal in every one.

`/Order` is mapped **recursively, not flattened**: a group reference becomes the
mapped output reference, a nested array stays a nested array, a text label is
preserved as itself, an absent `/Order` stays absent and an empty one stays
empty. An entry that is none of those three, or one naming a group no kept page
uses, is a refusal — dropping it would change the structure the layer panel is
drawn from while leaving the same groups behind.

Carried: page `/Properties` entries resolving to plain `/OCG` dictionaries, with
a `/D` whose keys stay within `Order`, `ON`, `OFF`, `Name`, `BaseState` — and
which are **reproduced**, not merely tolerated. Refused: `/OCMD` in any form, a
`/VE` visibility expression, a `/BaseState` other than `/ON`, or any other `/D`
key. An `/OCMD` decides visibility from a set of groups and optionally a nested
boolean expression; carrying part of that evaluation would silently change what
the reader sees.

### The envelope is a detector, not a hope

A contract that refuses "anything outside the handled shapes" is only true if
the unhandled shapes can be **found**. Optional content attaches itself in more
places than a catalog `/OCProperties` and a page's `/Properties`, and none of
these was previously inspected at all:

| shape | result |
| --- | --- |
| `ocg-configs` — `/OCProperties /Configs`, an alternate configuration | **refused** — one configuration is rebuilt; a second has never been shown to be |
| `annot-oc` — an annotation whose `/OC` puts it in a group | **refused** |
| `xobject-oc` — a form XObject whose `/OC` puts it in a group | **refused** |
| `malformed-ocproperties` — `/OCGs` a dictionary, `/D` a number | **refused** — unreadable is not the same as absent |

Attachments are detected whether or not the catalog declares optional content:
an annotation carrying `/OC` in a document with no `/OCProperties` is itself a
structure this reader does not understand.

### `/Order` labels have a position

A text label titles a section of the layer panel, and the only position this
research has shown it can be reproduced in is **the first element of a nested
array**.

| shape | result |
| --- | --- |
| `[A, ["LABEL", B, C]]` | **carried**, structure and label intact |
| `["BAD-LABEL", A, B, C]` — top level | **refused** |
| `[A, [B, "BAD-LABEL", C]]` — part-way through | **refused** |
| `/Order` naming a group no kept page uses | **refused** |

The last row had been a sentence in this document with no fixture behind it.
It has one now — `ocg-order-unused-group`, where page 2 holds a group `/Order`
names and extracting page 1 leaves it unmappable.

## JavaScript — sanitized, and proven by reopening the file

`prototype/javascript-scan.mjs`. The contract is *no JavaScript action survives
a sanitized result*, not *the sites we happened to inspect were clean*.

Scanner scope: catalog `/OpenAction`, catalog `/AA`, catalog
`/Names /JavaScript` including `/Kids`, page `/AA`, annotation `/A` and every
`/AA` sub-entry, AcroForm fields walked through `/Kids`, and `/Next` on every
action found. Bounded at depth 32 with a per-chain cycle set; a document the
scanner cannot finish inspecting is `UNSCANNABLE_ACTIONS`, not a quiet pass.

**An array means different things in different places, and only the key holding
it says which**: a destination under `/OpenAction`, `/Dest` or `/D`; a list of
actions under `/Next`, every element of which is walked. An earlier version
treated every array as a destination and stopped, so JavaScript inside a
`/Next` array was never visited and the document passed.

Seven fixtures, one per site. Each is found in the source and **absent from the
sanitized output, measured by reopening it — 0 remaining across all seven.**
A document with no JavaScript scans 0 and completes, and an action reachable by
two routes through the same holder is counted once (1 action from 2 visits).

Then every `/Next` shape the specification allows:

| shape | found | after readback |
| --- | --- | --- |
| `/Next` as a dictionary | 1 | **0** |
| `/Next` as an array | 1 | **0** |
| `/Next` array whose second element is JavaScript | 1 | **0** |
| JavaScript two `/Next` links down | 1 | **0** |
| one action referenced from two annotations | 2 sites, 2 removed | **0** |
| a cyclic action graph | — | **`UNSCANNABLE_ACTIONS`** |

The shared-action row counts two because the references live on two different
annotations; removing the action means removing both, and the readback confirms
it. The cycle is refused rather than passed, which is the point of bounding the
walk at all.

### Removing a reference is not removing an object

Deleting the key that points at an action detaches it. Whether it removes the
action from the file is a different question — and the one this research has
already been bitten by once, with pages `copyPages` copied and never inserted
into `/Pages`.

An action held as an **indirect object** stays registered in the document's
object table after the key pointing at it is deleted, and pdf-lib writes
everything registered, reachable or not. So a sanitized artifact is measured
twice: what a reader can reach, and what the object table holds.

| case | in the object table after the copy | after sanitizing |
| --- | --- | --- |
| annotation `/A` → indirect action | **1** | 0 |
| annotation `/AA` → indirect action | **1** | 0 |
| `/Next` → indirect action | **1** | 0 |
| two indirect `/Next` links down | **1** | 0 |
| one indirect action referenced twice | **1** | 0 |
| `/Next` array holding a direct action | 0 | 0 |
| a direct action on `/A` | 0 | 0 |

**Five of the seven put a JavaScript action into the artifact at all.** The
other two hold their actions as direct dictionaries inside the annotation, so
they never become separate objects. Every JavaScript action dictionary in the
table is scrubbed of its entries and then deleted, and the artifact-wide count
after reopening is **0 in all seven**.

The contract is therefore both counts at zero. A sanitizer that only detaches
references satisfies the first and not the second, and "no reachable
JavaScript" would have been a true sentence about a file that still carried the
script.

Two of the seven reach zero because `copyPages` never copies catalog-level
structure, not because the sanitizer removed anything. The mechanism is recorded
per site rather than summarised — see `limitations.md`.

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
