# Memory and output budget

M5 adopted a hard memory contract because its operation had one: a raster of
known size, encoded by a path this codebase owns, with every term EXACT or
derived from a pinned source. **Split and Merge do not have that shape**, and
this document says so rather than reusing M5's numbers because they are familiar.

Basis vocabulary, as adopted in M5:

```text
EXACT                 computed from the input, not observed
SOURCE_DERIVED_BOUND  derived from pinned library source
CONSERVATIVE_BOUND    a stated over-estimate, enforced
MEASURED_ONLY         observed on one machine; not a bound
UNKNOWN               no basis
```

**An adopted hard budget may contain no UNKNOWN and no MEASURED_ONLY term.**

---

## Extract — lifetime

| term | basis | note |
| --- | --- | --- |
| source bytes | EXACT | `File.arrayBuffer()`, held for the whole export |
| **parsed source document** | **UNKNOWN** | pdf-lib builds an object graph whose size is a function of the document's structure, not of its byte length. A 2 MB file of one scanned image and a 2 MB file of a million vector operators do not cost the same |
| copied page object graph | **UNKNOWN** | deep copy of everything each page reaches, including — measured — pages nobody selected |
| target document | UNKNOWN | same reason |
| save buffer | SOURCE_DERIVED_BOUND *given* the target graph | `save()` serialises into one buffer |
| Blob/download handoff | EXACT given the save buffer | the Blob is a copy |
| preview state retained concurrently | **EXACT** | 88,616 B per A4 page, 538,997 B per A1 sheet, measured |

## Merge — lifetime

| term | basis | note |
| --- | --- | --- |
| retained source file bytes | EXACT | every `File` stays in the list |
| one parsed source at a time | UNKNOWN | the loop loads, copies, and drops each source |
| target document growing across sources | UNKNOWN | accumulates every copied graph |
| copied object graphs | UNKNOWN | as Extract |
| save buffer | SOURCE_DERIVED_BOUND given the target | one buffer |
| Blob handoff | EXACT given the save buffer | |

Measured, for scale rather than as a bound: merging three sources totalling
6,445 B produced 3,462 B — **smaller than its inputs**, because shared resources
are copied once and pdf-lib writes object streams. Output size is not a function
of input size in either direction.

---

## The honest conclusion

**A hard memory budget cannot be closed for M6 from what is in the repository
today.** The dominant term — what a parsed pdf-lib document and its copied
object graph weigh — is UNKNOWN, and it is not a small correction: it is the
term that decides whether a job fits.

M5 faced the same wall at H8 and did not invent a bound; it blocked the
hypothesis and ran a sub-spike that removed the unbounded thing (the browser
encoder) rather than estimating it. The same discipline applies here, so this
research does **not** propose a memory preset for Split/Merge, and recommends
against adopting M5's presets for it on the grounds that they are already
written down.

### Required sub-spike, if a hard budget is wanted

```text
M6 Object-Graph Memory Sub-Spike
```

It would have to answer, from pinned source rather than from measurement:

1. what `PDFContext.indirectObjects` costs per object for the object kinds a
   real drawing contains, with the per-entry overhead derived from pdf-lib's own
   structures;
2. what `PDFObjectCopier` retains while copying, including `traversedObjects`;
3. whether a page's reachable graph can be **bounded before copying** — the
   destination-chasing behaviour measured here means it cannot be bounded by
   page count alone;
4. whether `save()`'s buffer can be bounded from the graph without serialising.

Until that exists, any memory preset offered for Split/Merge would be a number
with an UNKNOWN inside it, which is the thing M5 RF-L2 forbade.

---

## What *can* be closed today: the output ceiling

The artifact's size is not a prediction. It is a number that exists before
anything is published, and checking it needs no model at all.

Measured: the ceiling admits an artifact at its own size and refuses it one byte
lower — 3,462 B admitted at 3,462 B, refused at 3,461 B. That probe uses a
boundary taken from an archive that really exists rather than a figure chosen in
advance, after a first version guessed 4,096 B against a 3,462 B artifact and
asserted that a file under the ceiling was over it.

**Today no such check exists**: `handleExtractExport` and `handleMergeExport` go
from `save()` straight to a Blob and a click without looking at the size.

Recommendation: adopt an actual-artifact ceiling for M6 — the same *shape* as
M5's `checkActualOutput`, applied to the produced PDF before the download
handoff. Whether the **value** should be M5's 256 MiB shared across tools or an
independently gated M6 number is [`human-gate.json`](human-gate.json) M6-H11;
this research recommends sharing the constant and gating it once, because a user
cannot be expected to learn a different ceiling per tool, while noting that
Split/Merge outputs and Processor outputs have different size distributions.

### Preview budget, which *can* be bounded — in the terms the product controls

Unlike the document graph, the preview's cost is driven by quantities the
product chooses rather than by the document's structure. A bounded window of `N`
pages holds at most

```text
N × (encoded bytes per thumbnail)      retained payload   EXACT, measured per sheet size
peak canvas RGBA for the largest page  w × h × 4          EXACT
```

Both are enforceable: the product picks `N`, the thumbnail dimensions, and the
canvas ceiling.

**This is not a bound on total browser heap, and must not be written as one.**
The JS engine's string and object bookkeeping, PDF.js's retained state, and the
browser's decoded-image cache for displayed thumbnails are UNKNOWN terms this
research did not close. What can be stated is that the retained payload and the
largest single allocation stop being a function of whatever document the user
opened — which is the property P1 lacks entirely, and the reason the
recommendation stands.
