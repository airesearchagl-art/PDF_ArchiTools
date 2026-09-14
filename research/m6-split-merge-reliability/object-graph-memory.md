# Object-Graph Memory Sub-Spike — B2

M6-H11 was adopted on 2026-09-14 with its memory model **UNKNOWN**: the term
that decides whether a Split or Merge fits — what a parsed pdf-lib document and
its copied object graph weigh — had not been measured or derived, so every
memory preset, M5's 512 MiB / 1 GiB / 2 GiB included, was NOT ADOPTABLE, and
the Object-Graph Memory Sub-Spike became implementation blocker B2.

This is that Sub-Spike. It does not propose a memory number. It asks which terms
of the memory a Split or Merge holds can be known **before** the work that
creates them, derives each one from pdf-lib 1.17.1's own source, and checks it
against a real copy.

Nothing here is implemented. `src/` is untouched.

## The short answer

**PARTIALLY BOUNDABLE.** Everything a copy and a plain save will create can be
counted exactly before it is created — once the source is loaded. Loading the
source cannot be bounded at all with pdf-lib 1.17.1 as it is.

```text
H11 Object-Graph Memory Conclusion

Output ceiling:
  ADOPTED / unchanged

Memory model:
  PARTIALLY BOUNDABLE

Hard structural terms available:
  before load         input bytes
  after load,         objects the copy registers, copier map entries,
  before copy         raw stream bytes the copy duplicates, largest stream,
                      unselected pages the selection reaches
                      (EXACT — equal to the real copy in all 15 shapes measured)
  Merge, before       the output graph's growth for that source
  each source         (EXACT — equal in both merges measured)
  before the plain    the output length, before its buffer is allocated
  writer allocates    (EXACT — equal in all 3 cases measured)

UNKNOWN terms:
  load itself         every object is parsed eagerly, and every object stream
                      and cross-reference stream is inflated with no cap;
                      input bytes do not bound it (33,149 B -> 33,554,457 B)
  JS heap per object  bytes a dictionary, array, map entry or copier entry
                      costs are engine properties
  retention           heap still held after every document is released
  object-stream save  the output length is known only after compression

Safe production recommendation (research recommends; the Human decides):
  - no memory preset
  - structural caps on the EXACT terms, checked after load and before copy
  - Merge one source at a time, releasing each, with the output's cumulative
    growth checked from each source's plan before that source is copied
  - release the source before save
  - keep the adopted actual-output ceiling
  - close the load boundary before implementation

Required follow-on:
  Load Boundary Sub-Spike — proposed implementation blocker B3

M5 512 MiB / 1 GiB / 2 GiB presets:
  DO NOT ADOPT
```

## How numbers are labelled

| label | meaning |
| --- | --- |
| **EXACT** | read off a document or the pinned source; the same on every run |
| **STRUCTURAL** | a relation between EXACT terms derived from the source, e.g. which byte arrays are alive at once |
| **MEASURED_ONLY** | a heap, RSS, array-buffer or collectability reading from one Node process (v24, V8); never a bound |
| **UNKNOWN** | not derivable here, and not closed by measuring one engine |
| **HARD_BOUND** | a limit a product can check before the thing it limits exists |
| **CONSERVATIVE_BOUND** | a limit known to be at least as large as the real term — none is claimed in this document |

## What pdf-lib 1.17.1 does, from its source

Cited from the installed CommonJS build, `node_modules/pdf-lib/cjs/`, which is
what runs. Extracted by a read-only pass over the files and then checked line by
line against them.

### The context and the module-level pools

- `core/PDFContext.js:27-33` — a document's objects live in one
  `indirectObjects = new Map()`, keyed by `PDFRef`.
- `core/PDFContext.js:107-109` — `enumerateIndirectObjects` copies and sorts
  every entry each time it is called.
- `core/objects/PDFRef.js:8`, `:34-43` — `PDFRef.of` interns every reference in
  a **module-level `Map`**, keyed `"N G R"`.
- `core/objects/PDFName.js:18`, `:100-108` — `PDFName.of` does the same for names.
- Neither pool is ever deleted from or cleared, and neither is weak. What they
  hold lives as long as the page or worker that loaded pdf-lib.
- `core/objects/PDFNumber.js:34` — numbers are not pooled; every
  `PDFNumber.of` is a new object.
- `api/PDFDocument.js:126-130`, `core/PDFContext.js:26-199` — neither the
  document nor its context keeps the input bytes.

### Loading

- `core/parser/PDFParser.js:39-72` — `parseDocument` walks the file from start
  to end.
- `:125-159`, `:187-225` — every indirect object found is parsed and assigned
  immediately.
- `:226-256` — the xref table is parsed and then not used to locate objects.
- **No size or count cap** exists in the parser, the stream decoders, the
  writers or the context; a search for one found only a numeric-value cap
  (`core/parser/BaseParser.js:55-65`).
- `api/PDFDocumentOptions.js:6-9` — `objectsPerTick` / `parseSpeed` only decide
  when the parser yields.
- `core/parser/PDFParser.js:140-152` — an `/ObjStm` is decoded at once and its
  objects assigned; neither it nor an `/XRef` stream is kept in the context.
- `core/streams/DecodeStream.js:125-129`, `:133-145` — decoding reads to the end
  of the data into a buffer that **doubles with no upper limit**, and the old
  buffer is copied into the new one on each growth.
- `core/parser/ByteStream.js:51-53`, `core/parser/PDFObjectParser.js:197-198` —
  a raw stream's contents are `slice`d out of the input, a copy rather than a
  view, so the input buffer is not kept alive by the streams made from it.

### Streams

- `core/objects/PDFRawStream.js:8-27` — a parsed stream holds its **encoded**
  bytes; `getContentsSize` is their length.
- `core/structures/PDFFlateStream.js:13-28` — a stream pdf-lib builds itself
  compresses on first request and caches the result.

### Copying

- `api/PDFDocument.js:644` — `copyPages` flushes the source.
- `:647` — it creates **one `PDFObjectCopier` per call**, held in a local
  variable.
- `:648-655` — it copies each selected page's *node* and registers the result.
- `core/PDFObjectCopier.js:34` — `traversedObjects = new Map()`, from source
  containers and references to their destination clones and references.
- `:42-58` — a page is cloned, inherits `Resources`, `MediaBox`, `CropBox` and
  `Rotate` from its ancestors, and loses its own `/Parent`.
- `:59-96` — dictionaries, arrays and streams are cloned and every value is
  followed; no other key is skipped.
- `:97-109` — one destination reference per distinct source reference; a page
  leaf reached through one is copied as a page again (`:36`).
- `core/objects/PDFRawStream.js:17` — **stream bytes are duplicated**:
  `this.contents.slice()`.
- `core/objects/PDFDict.js:86-94`, `PDFArray.js:70-76` — clones are shallow, and
  the copier then overwrites every value with its copy. What a destination object
  can still share with its source is only a pooled `PDFRef` or `PDFName`, or a JS
  string.

### Saving

- `api/PDFDocument.js:1248` — defaults are `useObjectStreams: true`,
  `addDefaultPage: true`, `objectsPerTick: 50`.
- `:1253-1264` — `save` flushes and selects `PDFStreamWriter` or `PDFWriter`.
- `core/writers/PDFWriter.js:27-31` — the plain writer computes the total size
  first, then allocates **exactly** that many bytes.
- `core/writers/PDFStreamWriter.js:43-100` — the object-stream writer groups
  non-stream objects into chunks of 50, builds a `PDFObjectStream` per chunk and
  sizes it.
- `core/structures/PDFObjectStream.js:36-45` — sizing a chunk deflates it.
- The chunks, with their cached compressed bytes, are still referenced when the
  output buffer is allocated.

## The corpus

Generated by `scripts/make-m6-memory-fixtures.mjs` into
`test-fixtures/m6-object-graph-memory/`, apart from the main M6 corpus. Every
byte is synthetic and deterministic. The shapes come in pairs that hold one
candidate term steady while another moves.

| | fixture | file bytes | what it holds |
| --- | --- | --- | --- |
| A | `mem-a-small-vector` | 854 | one page of text and vector |
| B1 | `mem-b1-many-objects` | 1,876,490 | 20,000 small dictionaries reachable from one page, plain |
| B2 | `mem-b2-many-objects-objstm` | 336,526 | the same graph, packed into object streams |
| C | `mem-c-few-large-streams` | 1,261,446 | three incompressible image streams — about B1's size |
| D | `mem-d-shared-refs` | 427,302 | fifty pages drawing one shared 400 KB image |
| E | `mem-e-deep-cycle` | 36,673 | 201 nested forms whose innermost reaches the outermost |
| F | `mem-f-1000-pages` | 503,388 | one thousand plain pages |
| G1 | `mem-g1-large-image-raw` | 9,001,068 | one 3000 × 3000 gray image, incompressible, raw |
| G2 | `mem-g2-large-image-flate` | 9,853 | the same dimensions, a flat field under FlateDecode |
| I | `mem-i-linked-heavy-pages` | 4,908,863 | ten 490 KB pages; page 1 links to pages 2–10 |
| J | `mem-j-distinct-names` | 1,896,489 | 20,000 dictionaries, each keyed by a distinct name |
| K | `mem-k-objstm-inflation` | 33,149 | an object stream that inflates to 33,554,457 B |

## Q1 — what an indirect object costs

**The byte terms are EXACT; the object terms are counts whose size is UNKNOWN.**

What the source fixes:

- A loaded object is one `Map` entry keyed by an interned `PDFRef`.
- A dictionary is a JS `Map` of interned `PDFName` keys to objects.
- An array is a JS array; a number is a fresh `PDFNumber`; a string is a JS
  string.
- A stream is a dictionary plus a `Uint8Array` of its **encoded** bytes.

Measured structurally:

- G1 and G2 decode to the same 9 MB image. pdf-lib holds 9,000,000 B for one and
  8,770 B for the other: it holds what the file encodes, not what the image
  decodes to.
- The copy path never decodes a raw stream. So the stream term of a document is
  exactly the sum of its raw stream contents, and a walk of the graph reads it
  without allocating anything.

What the source does not fix is the heap cost of the rest.

- **MEASURED_ONLY:** loading B1's 20,006 objects moved `heapUsed` by +12.7 MiB
  in one Node process.
- That is not "N bytes per object". B1's dictionaries all have the same three
  entries, a real drawing's do not, and a browser's engine lays objects out as it
  chooses.

Object counts can be capped. Heap bytes per object cannot be promised.

## Q2 — what the copier holds, and when it lets go

**One map per call; source, destination and map are all alive during the copy;
after it, the destination no longer needs the source.**

- `copyPages` makes one `PDFObjectCopier` and drops it when the call returns.
- While it runs, three things are alive together:
  - the source graph, which it reads;
  - the destination graph it builds;
  - its `traversedObjects` map — one entry per distinct reference plus one per
    container cloned (B1, one page: 40,013 entries);
  - and, because stream bytes are duplicated, both copies of every reachable
    raw stream.
- Once it returns, a destination object can share with its source only a pooled
  `PDFRef`, a pooled `PDFName` or a JS string. Nothing in the destination holds
  the source document or its context.

**MEASURED_ONLY:** a `WeakRef` to the source was cleared by a full collection
after release in every Extract case and after every source in both merges.
Collectability is an observation about one collector, not a guarantee, but it
agrees with the source.

## Q3 — can the reachable graph be bounded before copying?

**Yes, exactly — after load.**

`prototype/object-graph-memory.mjs` `reachableGraph` walks a source the way the
copier does, without cloning:

- selected pages as nodes;
- inherited attributes applied and `/Parent` dropped;
- every other value followed;
- references deduped and page leaves reached through them counted;
- an explicit stack and a visited set.

It was compared with the copy it predicts in fifteen shapes, and every count was
equal, object for object and stream byte for stream byte:

| case | objects predicted = copied | stream bytes predicted = copied |
| --- | --- | --- |
| B1, page 1 | 20,003 | 173 |
| C, page 1 | 6 | 1,260,199 |
| D, all 50 pages | 102 | 409,765 |
| E, page 1 (cycle) | 204 | 2,395 |
| F, all 1,000 pages | 2,001 | 173,325 |
| G1, page 1 | 4 | 9,000,193 |
| I, page 1 | 40 | 4,901,945 |
| I, page 10 | 4 | 490,196 |

The other seven cases are in the evidence.

What does **not** bound the graph, each shown by a probe:

- **Page count.** Pages 1 and 10 of I are one page each. Page 1 reaches 40
  objects, 4,901,945 B and nine unselected pages through its links; page 10
  reaches 4 objects and 490,196 B.
- **File size.**
  - B1 (1,876,490 B) holds 20,003 objects to copy, while C (1,261,446 B) holds 6.
  - B1 and B2 hold the same 20,003 objects in files 5.6× apart.
- **Shared objects counted naively.** Summing D's fifty pages separately would
  say 20,009,765 B. The union, which is what the copier makes, is 409,765 B.

The limit of this answer: the walk needs the source already parsed, and parsing
is where the unbounded term is (Q4 and *Load*).

## Q4 — can the save buffer be bounded before save?

**For the plain writer, exactly. For the object-stream writer production uses,
not before compressing.**

- **Plain writer.** `PDFWriter` computes the total size before it allocates.
  `predictPlainSaveBytes` asks that question on its own. Predicted equalled
  written in all three cases: B1 1,877,000 B, C 1,261,950 B, I page 1
  4,909,178 B.
- **Object-stream writer.** `PDFStreamWriter` knows its size only after each
  chunk of fifty objects has been deflated. B1 written that way is 336,399 B.
  There is no equivalent number to ask for first, and this research has not
  established an upper bound on it — see *UNKNOWN*.
- **What is alive at the save peak (STRUCTURAL):** the destination graph, any
  cached compressed chunks, and the output buffer — plus the whole source, if the
  caller still holds it.

## Load, copy and save, phase by phase

The raw-stream bytes alive at each step of an Extract follow from the source.
Below, **I** is input bytes, **S** is the source's raw stream bytes, **R** is the
reachable stream bytes and **O** is output bytes.

```text
during load            I + S + every object/xref stream's decode buffer (unbounded)
after load             S                        (the input can be dropped)
after copyPages        S + R
at save                S + R + O                (R + O if the source is released first)
```

The gate's array-buffer readings (MEASURED_ONLY) agree with that composition:

- **G1:** array buffers +17.2 MiB after save against the input already held,
  where S + R + O − I is 18,000,386 B.
- **I, page 1:** +9.3 MiB, where S + R + O − I is 9,800,485 B.

Loading is where the shape breaks:

- **K** is 33,149 B. Its one object stream decodes to 33,554,457 B, 1,012× its
  input.
- By the first phase boundary the decode buffer has been dropped, so a
  phase-boundary sample sees nothing (`heapUsed` +0.1 MiB).
- The process's **peak** RSS rose by +80.3 MiB during that load
  (MEASURED_ONLY): the doubling buffer and its predecessor, alive together.

Heap readings for the object-heavy shapes, one run (MEASURED_ONLY):

| case | heap after load | heap after copy | peak RSS during load |
| --- | --- | --- | --- |
| B1 | +12.7 MiB | +19.6 MiB | +38.6 MiB |
| B2 | +15.5 MiB | +22.4 MiB | +42.8 MiB |
| J | +17.5 MiB | +24.4 MiB | +53.1 MiB |
| F, all pages | +3.4 MiB | +6.5 MiB | +11.2 MiB |
| K | +0.1 MiB | +0.2 MiB | +80.3 MiB |

After every reference was released and collected, heap stayed above where it
started: **B1 +13.1 MiB, J +14.2 MiB** (MEASURED_ONLY).

- The source shows one mechanism that fits: the module-level `PDFRef` and
  `PDFName` pools, which are never cleared.
- This research did not take a heap snapshot, so what the retained heap consists
  of is **UNKNOWN**.
- J's distinct names add about 1 MiB over B1's repeated ones. Most of what stays
  is not the names.

## Merge lifetime

- Production's Merge makes one output and, for each input, loads it, copies
  every page and moves on. Sequential processing is already its shape.
- **What it can release.** Each source becomes collectable once the loop lets
  go of it (MEASURED_ONLY, all five sources in two merges), and nothing in the
  output points back at it (source).
- **What it cannot release.** The output graph accumulates by design.
- **What bounds the growth.** It is known before each source is copied:
  - the output grew by exactly Σ of each source's plan — 20,012 objects and
    1,260,544 B for A + C + B1, 2,103 objects and 583,090 B for D + F;
  - so a cumulative cap can be checked source by source, before the copy that
    would exceed it.
- **Peak for source i (STRUCTURAL):** the output so far, plus source *i* loaded
  (with its load-time decode), plus its reachable bytes being duplicated.
- **Preloading every source** would hold every S at once. It adds nothing the
  sequential route needs and should be forbidden.
- **Input bytes** can be released as soon as that source has loaded.

## Extract lifetime

- A small selection is not a small graph. Page 1 of I is one page and reaches
  nine more, which is the same mechanism as the orphan pages this research
  already reproduced.
- `selectedPages × constant` is not a memory model.
- The walker's `pageLeavesReached` sees those pages before the copy. H5's
  adopted E2 contract strips destinations before copying, which removes that
  route; the walker then counts what is left.
- After the copy, the source is no longer needed. Releasing it before `save`
  takes S out of the save peak.

## Terms that can be bounded

| term | known | class | how |
| --- | --- | --- | --- |
| input bytes | before load | EXACT, HARD_BOUND | the file's length |
| objects the copy registers | after load, before copy | EXACT, HARD_BOUND | `reachableGraph.destinationObjects` |
| copier map entries | after load, before copy | EXACT, HARD_BOUND | `reachableGraph.copierEntries` |
| stream bytes the copy duplicates | after load, before copy | EXACT, HARD_BOUND | `reachableGraph.streamBytes` |
| largest single stream | after load, before copy | EXACT, HARD_BOUND | `reachableGraph.maxStreamBytes` |
| unselected pages reached | after load, before copy | EXACT | `reachableGraph.pageLeavesReached` |
| source objects and stream bytes | after load | EXACT | the source context |
| Merge output growth per source | before that source's copy | EXACT, HARD_BOUND | Σ plans |
| plain-writer output length | before its buffer | EXACT, HARD_BOUND | `PDFWriter.computeBufferSize` |
| actual output length | after save | EXACT, adopted ceiling | unchanged |

Every HARD_BOUND above bounds a **count or a byte total**. None bounds heap
bytes, which is why none becomes a memory preset.

## UNKNOWN

- **The load.** pdf-lib parses every object and inflates every object stream
  and cross-reference stream before returning, with no cap and no hook to stop
  it. No term available before load bounds what it allocates; input bytes do not
  (K: 1,012×). This is the term an adversarial document controls, and the one no
  structural cap after load can reach.
- **Heap bytes per object, per map entry, per copier entry.** An engine
  property. One Node process measured; a browser's engine was not.
- **What stays after release.** Heap held once every document is gone (B1
  +13.1 MiB); the pools are a mechanism that fits, not a measured cause.
- **Object-stream output length before compression**, and any upper bound on it.
- **Browser heap limits, GC timing and array-buffer accounting**, none of which
  a Node measurement transfers to.

## Architecture candidates for the load boundary

These are candidates for the Human, not decisions.

| | candidate | what it closes | what it leaves |
| --- | --- | --- | --- |
| A | conservative input-byte and object-count limits in the MVP | large inputs | an input-byte limit does not bound decoded bytes (K), and an object count is known only after the parse it would limit |
| B | incremental / spooled writer sub-spike | the save buffer | the load |
| C | browser-capability-dependent refusal | nothing hard; it reads a MEASURED_ONLY environment | every UNKNOWN |
| D | no memory preset; strict structural caps only | copy and save, exactly | the load |
| L1 | a pre-parse pass that inflates each object and xref stream with a hard stop, before pdf-lib sees the bytes | load-time decode | a second parser to keep honest |
| L2 | each operation in a disposable worker, terminated afterwards | retention across operations, blast radius | not a bound on the operation itself |

D covers everything this Sub-Spike could count. Nothing on the list closes the
load except L1, which does not exist yet. That is what makes it a blocker.

## Proposed blocker B3 — the load boundary

M6 implementation should not start until a Load Boundary Sub-Spike shows how a
document is refused before pdf-lib's eager parse and uncapped decode can
allocate without limit, and proves that refusal against at least K.

This is proposed by B2 and recorded as OPEN pending Human confirmation. It is
not a decision this research takes.

## What this Sub-Spike does not claim

- No memory preset, and no heap figure used as a limit.
- Nothing about a browser engine: every MEASURED_ONLY number is one Node (V8)
  process.
- Nothing about real drawings beyond what the synthetic shapes isolate.
- No upper bound on object-stream output, and no conservative bound of any kind.
- Seven of the fifteen walker comparisons are not tabled above; they are in
  `evidence-object-graph-memory.json` with the same equality.

## Running it

```bash
node research/m6-split-merge-reliability/scripts/make-m6-memory-fixtures.mjs
node research/m6-split-merge-reliability/scripts/object-graph-memory-gate.mjs
```

Each case runs in a child process started with `--expose-gc`
(`scripts/object-graph-memory-phase.mjs`). The gate writes
`evidence-object-graph-memory.json`. Core CI does not run it.
