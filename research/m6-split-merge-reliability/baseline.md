# The legacy baseline, measured

What `src/components/PdfSplitMerge.tsx` does today, at production base
`544a3baf6c7dcee02090dc90058735e377a08ea8`. Nothing here is inferred from the UI
copy: every row is either a line of the component or a number the research gate
produced by running the component's own route.

Two sources of fact are kept apart on purpose:

- **observed production fact** — read off `PdfSplitMerge.tsx`;
- **measured** — produced by `scripts/research-gate.mjs` (node, structural) or
  `scripts/browser-gate.mjs` (browser, memory and lifetime), which reproduce the
  production route verbatim, defaults included.

A third kind, **pdf-lib behaviour**, is cited with `file:line` from
`node_modules/pdf-lib/cjs/` and belongs to [`structure-policy.md`](structure-policy.md).

---

## Extract — the route

```text
File
→ arrayBuffer()
→ configurePdfWorker()
→ pdfjsLib.getDocument({ data })
→ for every page: getViewport({ scale: 1.5 }) → canvas → render → canvas.toDataURL()
→ setExtractPages(all of them)

selected page numbers
→ PDFDocument.load(await file.arrayBuffer())        // defaults
→ PDFDocument.create()                              // defaults
→ copyPages(src, indices) → addPage each
→ save()
→ new Blob([...])
→ URL.createObjectURL(blob)
→ link.click()
```

Observed production fact, line by line: `PdfSplitMerge.tsx:51` opens the
document, `:55-72` renders **every** page before anything is selected, `:69`
turns each one into a base64 PNG Data URL, `:73` retains them all in React
state. There is no `page.cleanup()`, no `pdf.destroy()`, and no release of the
canvas. `:97-98` loads the source and creates the target with pdf-lib's
defaults. `:109` creates an object URL and nothing ever revokes it. `:76` and
`:114` report failure with `alert()`.

### Extract — what the gate measured

Source `nav-4p`: 4 pages, 4 links, 2 named destinations, 4 outline items, page
labels, an `/OpenAction`.

| extracted | pages in tree | orphan page objects | links | named dests | outlines | page labels |
| --- | --- | --- | --- | --- | --- | --- |
| all four | 4 | **2** | 4 | 0 | 0 | 0 |
| page 1 | 1 | **2** | 4 | 0 | 0 | 0 |
| first + last | 2 | **2** | 4 | 0 | 0 | 0 |
| middle two | 2 | 0 | 0 | 0 | 0 | 0 |

Read the second row first. **Extracting one page produced a file containing
three page objects**: the one that was asked for, plus two that a link on it
referenced. They are not in `/Pages`, so no reader will ever show them; they are
in the file, so every byte of them ships. The last row is the same fact from the
other side — pages 2 and 3 carry no annotations, so nothing was dragged in.

Metadata after any extract:

```text
/Producer, /ModDate, /Creator, /CreationDate     ← all four written by pdf-lib
```

Everything the source carried is gone. Measured on `meta-rich`: lost `/Title`,
`/Author`, `/Subject`, `/Keywords`, `/Company`, `/M6Custom`, `/M6Indirect`, and
the XMP packet with them.

Structures present in the source and absent from the output, every time:
named destinations, outlines, page labels, `/OpenAction`, `/AcroForm`, XFA,
`/OCProperties`, `/StructTreeRoot`, embedded files, document JavaScript.

Page-level geometry, by contrast, survives intact: `/Rotate` 0/90/180/270,
`CropBox`, a `MediaBox` with a non-zero origin, `/UserUnit`, and geometry
inherited from the page tree rather than declared on the leaf — all identical
before and after.

Signatures and forms:

| case | result |
| --- | --- |
| applied signature (`sig-applied`) | a 1,242 B file, no AcroForm, **no warning of any kind** |
| empty `/Sig` field | reads as a field, not as a signature — the M5 H7 distinction still holds |
| ordinary form, both pages kept | AcroForm gone; **2 widgets left on the pages with no field to belong to** |
| one field, widgets on two pages, one page kept | same shape: a widget with no form |
| XFA | absent from the output, unreported |

---

## Merge — the route

```text
each File
→ if (file.type !== 'application/pdf') continue          // silent
→ getDocument(...) only to read numPages
→ catch (e) { console.error(...) }                       // silent
→ push to the UI list

ordered list
→ PDFDocument.create()
→ for each source: PDFDocument.load() → copyPages(all) → addPage each
→ save() → Blob → object URL → click
```

Observed production fact: `:128` drops anything whose MIME type is not
`application/pdf` without a word, `:139-141` catches a failed load and logs it to
a console the user is not looking at. In both cases the file simply never
appears in the list. The PDF.js document opened at `:132` to read a page count
is never destroyed. `:179` names every output `merged_document.pdf`.

### Merge — what the gate measured

| case | pages | order |
| --- | --- | --- |
| A + B | 5 | A1 A2 A3 B1 B2 — file-list order, then each file's own page order |
| B + A | 5 | B1 B2 A1 A2 A3 |
| A + A | 6 | the same file twice, not deduplicated |
| A + B + C | 7 | rotation 270 preserved on C's first page |

Order and page geometry are correct, and that is worth saying plainly: the parts
of Merge that work, work.

What does not survive is everything above the page. Merging two documents that
each declare the field `shared.field`, the named destination `M6-SHARED-DEST`,
an outline and page labels produced:

```text
AcroForm            absent
widgets on pages    2, belonging to no field
named destinations  0
outline items       0
page labels         0
Info                /Producer /ModDate /Creator /CreationDate
```

So the collision question — which of two identical field names wins — never
arises in today's build, because the form both names lived in is gone. That is
not a resolution. It is a loss that looks like one.

Merging a signed source produced a 5-page file with no AcroForm and no mention
of the signature.

---

## Intake

| fixture | `PDFDocument.load` |
| --- | --- |
| `invalid` | throws — `No PDF header found` |
| `encrypted` | throws — `…is encrypted` |
| `broken-pagetree` (`/Count 7`, a kid that is not there) | **loads, reports 1 page** |
| `malformed-acroform` (`/Fields` is a dictionary) | **loads, reports 1 page** |

Two of the four hostile fixtures load without complaint, so an intake contract
cannot be "whatever the loader accepts is fine".

---

## Preview memory, measured in the browser

Production's route: `scale: 1.5`, one canvas per page, `toDataURL()`, all
retained.

| source | pages | retained Data URLs | peak canvas | elapsed |
| --- | --- | --- | --- | --- |
| `pages-10` | 10 | 0.8 MiB | 4.3 MiB | 252 ms |
| `pages-50` | 50 | 4.2 MiB | 4.3 MiB | 891 ms |
| `pages-100` | 100 | 8.4 MiB | 4.3 MiB | 1,728 ms |
| `pages-200` | 200 | **16.9 MiB** | 4.3 MiB | 3,393 ms |
| `pages-10-a1` | 10 × A1 | 5.1 MiB | **34.4 MiB** | 594 ms |

**88,616 B retained per A4 page; 538,997 B per A1 sheet — 6.2× — and no ceiling
anywhere in the code.** Heap deltas were also recorded and are marked advisory:
`performance.memory` is Chrome-only and quantised, so no bound is derived from
it. The retained string length is the deterministic figure.

## Lifetime

| question | answer |
| --- | --- |
| object URLs across 5 exports | **5 created, 0 revoked** |
| PDF.js document after a preview | still usable, i.e. never destroyed |
| two previews started together | finish order `second → first` — **the slower first source overwrites the faster second one** |

The last row is the shape of the ownership problem rather than production's
exact re-entry path: the harness starts both renders deliberately, whereas
production re-enters `handleExtractUpload` when a second file is chosen. What it
shows is that nothing in the component decides which run owns the screen, so the
last writer wins.

External HTTP(S) during all of it: **0**.

---

## FAIL → Root Cause → Fix direction

| # | FAIL | Root cause | Fix direction |
| --- | --- | --- | --- |
| B1 | A page nobody selected is copied into the output | `PDFObjectCopier` follows a `/Dest` page reference with no branch for what the referent is (`core/PDFObjectCopier.js:97-109`) | decide the destination policy **before** copying; see [`extract-contract.md`](extract-contract.md) |
| B2 | Every catalog-level structure is dropped | `copyPages` touches only the page leaf; pdf-lib copies no document-level structure at all | an explicit structure policy per item: reconstruct, refuse, or state as unsupported |
| B3 | Source metadata replaced by pdf-lib's own | `load`/`create` default to `updateMetadata: true` (`api/PDFDocument.js:121,144`) | `updateMetadata: false` plus the M5 H12 carry-or-refuse contract |
| B4 | A signed source produces an ordinary-looking file | nothing inspects the source | M6-H1 / M6-H2 |
| B5 | Widgets survive with no field tree | the annotation travels with the page; the AcroForm does not | M6-H3 |
| B6 | An unloadable or non-PDF input vanishes silently | `continue` and `catch`+`console.error` | typed per-input results; M6-H10 |
| B7 | Nothing bounds preview memory | every page rendered and retained up front | M6-H12 |
| B8 | Object URLs accumulate | no `revokeObjectURL` | atomic publication with cleanup |
| B9 | PDF.js documents are left open | no `destroy()`/`cleanup()` | lifetime owned by the preview contract |
| B10 | The last run to finish wins the screen | no ownership token | M6-H13 |
| B11 | Nothing checks the produced artifact's size | `save()` → Blob → click | an actual-artifact ceiling; M6-H11 |
| B12 | Every merge is `merged_document.pdf` | fixed string (`:179`) | M6-H14 |
