# Preservation matrix

Every cell is decided by reopening the output and reading its structure
(`scripts/structure.mjs`), never by whether a page rendered. A copied page
renders identically whether or not the outline that pointed at it, the field its
widget belonged to, or the metadata that described it came with it.

Vocabulary, used strictly:

| word | meaning |
| --- | --- |
| **preserved** | found in the output, equal to the source |
| **transformed** | present but changed, and the change is stated |
| **dropped** | absent from the output |
| **dangling** | a reference survived whose referent did not |
| **unsupported** | the library offers no path, so no implementation choice exists without building one |

---

## Extract

Subsets exercised on every applicable fixture: **all pages**, **one page**,
**first + last**, **middle**. Where a target page matters, both *included* and
*excluded* were run.

### Page-level

| item | result | evidence |
| --- | --- | --- |
| page content | preserved | output pages render; markers extractable |
| searchable text | preserved | page content streams copied whole |
| OCR text layer | preserved | same path as any other text |
| vector geometry | preserved | content stream is a page entry |
| images | preserved | image XObjects reached through `/Resources` |
| MediaBox | preserved | identical before/after on `mediabox-offset` |
| CropBox | preserved | identical on `crop-offset` |
| Rotate | preserved | 0/90/180/270 all identical |
| UserUnit | preserved | value carried as a leaf entry |
| inherited page attributes | preserved | `Resources`, `MediaBox`, `CropBox`, `Rotate` are resolved onto the copied leaf (`core/PDFObjectCopier.js:42-58`, `PDFPageLeaf.js:185-190`) |
| any *other* inherited attribute | **dropped** | `/Parent` is deleted and only those four are folded down |

### Annotations and navigation

| item | result | evidence |
| --- | --- | --- |
| annotations on a kept page | preserved | `/Annots` travels as a page entry |
| URI links | preserved | no page reference involved |
| internal link to a **kept** page | preserved, retargeted | the copier remaps the reference |
| internal link to an **excluded** page | **transformed into something worse**: the link survives *and the excluded page is copied into the file as an orphan* | extracting page 1 of `nav-4p` yielded 1 page in the tree and **2 orphan page objects** |
| link whose destination was already dangling | dangling | reported as `dangling` by the structure reader |
| named destinations | **dropped** | 2 in source, 0 in output, even when all pages are extracted |
| outlines | **dropped** | 4 items in source, 0 in output |
| page labels | **dropped** | 2 ranges in source, 0 in output |
| `/OpenAction` | **dropped** | not copied |

The orphan row is the one that matters most. It is not a leak of a few bytes: a
destination chain has no termination condition in the copier, so an extract of
one page from a heavily cross-linked document can pull in an arbitrary part of
the rest of it — invisibly, because none of those pages is in `/Pages`.

### Forms and signatures

| item | result | evidence |
| --- | --- | --- |
| AcroForm | **dropped** | absent from every output |
| widgets | **transformed**: present on the page, belonging to nothing | 2 orphan widgets after extracting both pages of `form-2p` |
| field values | **dropped** | no field tree survives to hold them |
| field whose widgets straddle kept and dropped pages | **dropped**, same shape | one widget kept, no field |
| empty `/Sig` field | reads as a field, not a signature | matches M5 H7 |
| applied signature | **dropped**, silently: an ordinary 1,242 B file | no AcroForm, no warning |
| XFA | **dropped**, unreported | `xfa` fixture |

### Metadata and catalog

| item | result | evidence |
| --- | --- | --- |
| standard Info | **dropped**, then overwritten | output Info is pdf-lib's four keys |
| custom Info | **dropped** | `/Company`, `/M6Custom` gone |
| indirect Info value | **dropped** | `/M6Indirect` gone |
| unfiltered XMP | **dropped** | absent |
| Flate XMP | **dropped** | absent |
| attachments / embedded files | **dropped** | `attachment-and-js` |
| document JavaScript | **dropped** | same fixture |
| `/OCProperties` | **dropped** | `ocproperties` |
| `/StructTreeRoot` | **dropped** (the page keeps its `/StructParents`, pointing at a tree that is not there) | `structtree` |

---

## Merge

| item | result | evidence |
| --- | --- | --- |
| page order | preserved: file-list order, then each file's own page order | A+B vs B+A differ in exactly that way |
| duplicate file | merged twice, no deduplication | A+A = 6 pages |
| mixed page sizes | preserved | 595×842 and 842×1191 side by side |
| mixed rotations | preserved | 270 survives in A+B+C |
| page content, text, vectors, images | preserved | as Extract |
| link within one source | preserved, retargeted | all pages of that source are copied |
| link to another page of the same source | preserved | the referent is in the merge |
| external URI | preserved | no reference involved |
| named destination | **dropped** | 0 in output |
| duplicate named destination across sources | never arises: both are dropped | — |
| outlines | **dropped** | 0 in output |
| page labels | **dropped** | 0 in output |
| AcroForm | **dropped** | absent |
| duplicate field name across sources | never arises: **both forms are gone and 2 orphan widgets remain** | `collide-a` + `collide-b` |
| metadata | **dropped**, replaced by pdf-lib's four keys | no source's metadata survives |
| signed source | **dropped**, silently | 5-page ordinary file |
| attachments, OCG, tags, JavaScript | **dropped** | not copied |

Because pdf-lib renumbers every copied object (`core/PDFObjectCopier.js:100`,
`PDFContext.js:40-43`), **object-number collision between sources cannot occur**.
Generation numbers are not preserved; every copied object becomes generation 0.

---

## What this means for the contracts

Nothing above is a bug in `copyPages`. pdf-lib says so itself, in the doc comment
on `PDFDocument.copy()`:

> **NOTE:** This method won't copy all information over to the new document
> (acroforms, outlines, etc...).

The defect is that the product presents page copying as document splitting and
merging, and reports success. Every "dropped" row above is a decision M6 has to
take deliberately — reconstruct it, refuse the operation, or say plainly that it
is not supported — and [`human-gate.json`](human-gate.json) is where those are
put to a person rather than taken here.
