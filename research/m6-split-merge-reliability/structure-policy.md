# What pdf-lib actually does, and what that forces M6 to decide

Separated from the matrices on purpose. The matrices say *what happened*; this
says *why*, from pinned library source. Every claim carries a `file:line` in
`node_modules/pdf-lib/cjs/` at the version this repository pins, **pdf-lib
1.17.1**. Nothing here is a recommendation; the recommendations are in
[`extract-contract.md`](extract-contract.md), [`merge-contract.md`](merge-contract.md)
and [`human-gate.json`](human-gate.json).

## The copy path

`copyPages` is four meaningful lines (`api/PDFDocument.js:636-660`):

```js
yield srcDoc.flush();                                          // :644
copier = PDFObjectCopier.for(srcDoc.context, this.context);    // :647
copiedPage = copier.copy(srcPage.node);                        // :652
ref = this.context.register(copiedPage);                       // :653
```

Three consequences follow, and all three matter to M6.

**1. Copying mutates the source.** `:644` flushes the *source* document before
reading it (`flush` at `:1201-1224` writes fonts, images, embedded pages and
files into the source context). An operation the user thinks of as reading
changes the thing it reads. Any M6 contract that re-uses a loaded source
document after a copy is building on a document that is no longer what it was.

**2. The copier has no idea what it is copying.** The dispatch is a type ladder
(`core/PDFObjectCopier.js:36-41`):

```js
object instanceof PDFPageLeaf ? copyPDFPage(object)
  : object instanceof PDFDict  ? copyPDFDict(object)
  : object instanceof PDFArray ? copyPDFArray(object)
    : object instanceof PDFStream ? copyPDFStream(object)
      : object instanceof PDFRef ? copyPDFIndirectObject(object)
        : object.clone()
```

There is **no branch for what a reference points at**. So a link annotation's
`/Dest [ 12 0 R /XYZ … ]` is an array containing a ref; the ref is dereferenced
(`:102`), the referent is a `PDFPageLeaf` (the parser makes it one at
`core/parser/PDFObjectParser.js:164-166`), and the first rung of the ladder
copies the whole page. That page is registered in the target but never inserted
into `/Pages` — `insertLeafNode` is only called by `addPage`/`insertPage`
(`api/PDFDocument.js:611`) — so it is an orphan: invisible to a reader, present
in the bytes. There is no termination condition, so the chain continues through
whatever those pages reference.

Measured: extracting page 1 of `nav-4p` produced **1 page in the tree and 2
orphan page objects**. Extracting all four produced 4 in the tree and still 2
orphans, because `copyPDFPage` clones the leaf before memoising it (`:43`, `:64`),
so a page reached both as an argument and through a reference is copied twice.

That double-copy is also why a destination to a page that **was** selected still
fails: the reference is remapped onto the copy reached through it, and that copy
is the one that never enters `/Pages`. Measured on `dest-direct-2p` with both
pages kept — 2 pages in the tree, 1 orphan, **0 destinations landing in the
document**. A link that resolves and navigates nowhere is the worst of the three
possible outcomes, because nothing reports it.

**And `/Annots` is not the only way out of a page.** A page's `/B` array holds
article beads, and a bead chains through `/N` to a bead whose `/P` is a
different page. Measured on `page-refs-beyond-annots`: extracting page 1, which
has no link annotations at all, produced **2 orphan page objects**. Any contract
that enumerated annotations to find page references would have been wrong, and
would have passed its own tests.

**3. A reference whose referent is missing becomes a real dangling reference.**
`core/PDFObjectCopier.js:97-109`:

```js
var newRef = _this.dest.nextRef();
_this.traversedObjects.set(ref, newRef);
var dereferencedValue = _this.src.lookup(ref);
if (dereferencedValue) { ... _this.dest.assign(newRef, cloned); }
return _this.traversedObjects.get(ref);
```

If the lookup is falsy the new reference is still returned, and nothing is ever
assigned to it. The output then contains a reference to an object number that
does not exist.

## Inheritable attributes

`copyPDFPage` folds exactly four keys down onto the copied leaf and then deletes
`/Parent` (`core/PDFObjectCopier.js:42-58`), with the list at
`core/structures/PDFPageLeaf.js:185-190`:

```js
PDFPageLeaf.InheritableEntries = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
```

Existing keys on the leaf are not overwritten (`:51`), and `/Parent` is removed
so the donor's whole page tree is not dragged along (`:54-55`). **Anything else
a page inherited from an ancestor `Pages` node is lost with the parent.**
Measured: `Rotate` and `CropBox` declared on the page tree survived intact.

## What is not copied at all

`copyPages` touches `srcPage.node` and nothing else. Across the whole `cjs`
build:

| structure | status in pdf-lib 1.17.1 |
| --- | --- |
| `/AcroForm` | modelled (`core/structures/PDFCatalog.js:16-33`) but never read by any copy path |
| `/Names` | written only when *this* document embeds a file or script (`api/PDFEmbeddedFile.js:34-45`, `api/PDFJavaScript.js:35-46`); a source's tree is never read |
| `/Dests` | identifier does not appear anywhere |
| `/Outlines` | not implemented |
| `/PageLabels` | not implemented |
| `/StructTreeRoot` | not implemented |
| `/OCProperties` | not implemented |
| `/Metadata` (XMP) | not implemented; only trailer `/Info` is handled |
| `/OpenAction` | not implemented |
| embedded files | write-only path |

pdf-lib states this itself, in the doc comment on `PDFDocument.copy()`
(`api/PDFDocument.js:670-671`):

> **NOTE:** This method won't copy all information over to the new document
> (acroforms, outlines, etc...).

So none of the dropped rows in the matrix is a misuse of the library. They are
the library's stated scope, and the product's mistake is presenting page copying
as document splitting and reporting success.

## Metadata defaults

`updateMetadata` defaults to **true** on both `load` (`api/PDFDocument.js:121`)
and `create` (`:144`), and the constructor acts on it (`:59-60` → `:1335-1345`):

```js
this.setProducer(pdfLib);
this.setModificationDate(now);
if (!info.get(PDFName.of('Creator')))      this.setCreator(pdfLib);
if (!info.get(PDFName.of('CreationDate'))) this.setCreationDate(now);
```

`/Producer` and `/ModDate` are **always** overwritten. Production passes neither
option, which is why every Extract and Merge output carries exactly
`/Producer, /ModDate, /Creator, /CreationDate` and nothing of the source's.

`save()` has no metadata option at all (`:1241-1268`), but it does have
`addDefaultPage`, default **true** (`:1253-1254`): saving a document with zero
pages silently adds a blank A4. An M6 Extract that ends up with no pages would
produce a one-page blank PDF rather than an error.

## Object numbering

Every copied indirect object is renumbered (`core/PDFObjectCopier.js:100` →
`core/PDFContext.js:40-43`), so **two sources' object numbers cannot collide in
a merge**. This is worth stating because it is the collision people expect and
it does not happen. What does not survive is the generation number: every copied
object becomes generation 0.

## Resource scopes, and where optional content can be named from

`copyPages` copies what a page node reaches, and a page node reaches more than
its own `/Resources`. For optional content, what matters is which reachable
objects **open a resource scope of their own**: marked content names a group
through the `/Properties` of whichever scope its content stream draws in, so a
group can be named from well below the page.

| resource | opens its own scope | an `/OC` attachment point | walked by the prototype | fixture |
| --- | --- | --- | --- | --- |
| page `/Resources` | the page's | — | yes — its `/Properties` is the carried set | `ocproperties` and the carried corpus |
| form XObject | yes, `/Resources` | yes | yes, recursively | `xobject-oc`, `ocg-form-properties`, `ocg-nested-form-xobject`, `resource-cycle`, `resource-depth-exceeded` |
| image XObject | no | yes | `/OC` checked | none below the page |
| annotation | no | yes | `/OC` checked | `annot-oc` |
| annotation `/AP` stream | yes, `/Resources` — it is a form XObject | yes | yes | `ocg-annotation-appearance-properties` (an `/N` stream; no state dictionary) |
| tiling pattern | yes, `/Resources` | no | yes | `ocg-pattern-properties` |
| shading pattern | no | no | reached; nothing to open | none |
| Type 3 font | yes, `/Resources`, used by `/CharProcs` | no | yes, and a `/CharProcs` stream's own `/Resources` | `ocg-type3-properties` (font `/Resources` only) |
| other font types | no | no | passed over | the corpus's Helvetica |
| `/ExtGState` | not itself — **but `/SMask /G` is a form XObject with its own `/Resources`** | no | **no** | `ocg-extgstate-smask` — extracts READY with a group behind it |
| `/ColorSpace` | no | no | no | none |
| `/Shading` | no | no | no | none |

Two pdf-lib behaviours shape how such a walk has to be written, both observed on
this corpus:

- **A dangling reference looks up to `undefined`, not to an error.**
  `ocg-dangling-ocgs-ref` holds `9997 0 R`; `context.lookup` on it returns
  `undefined` without throwing. A helper that falls back to the reference when
  the lookup is `undefined` hands back something that reads as a value, which is
  how a missing object passes for a present one.
- **Generated resource names are stable by accident.** `PDFPageLeaf.newXObject`
  goes through `PDFDict.uniqueKey` (`core/objects/PDFDict.js:77-85`) to
  `PDFContext.addRandomSuffix` (`core/PDFContext.js:193-196`), which draws from
  the context's own RNG. Every new document observed here received the same
  suffix, and regenerating the corpus reproduced the same bytes — so names were
  stable across runs, but because of how the library seeds its RNG, not because
  anything promises it. The fixtures in this round use fixed names instead.

## The decisions this forces

| observation | decision it forces |
| --- | --- |
| destinations drag pages in, unbounded | M6-H5: what happens to an internal link whose target is not in the selection |
| no document-level structure is copied | M6-H3, M6-H4, M6-H6, M6-H9 |
| optional content can be named from resource scopes below the page | M6-H9b: how far detection must reach, and whether the `/ExtGState` soft-mask path is closed or stated as a limit |
| metadata defaults overwrite | M6-H7, M6-H8 |
| `flush()` mutates the source | the plan/run split must not assume a source survives a copy unchanged |
| `addDefaultPage` on empty save | an empty selection must be refused before `save()`, not after |
| the graph's size is a function of structure | [`budget.md`](budget.md): no hard memory bound without a sub-spike |
