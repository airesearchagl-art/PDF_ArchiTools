# B3 — Load Boundary Sub-Spike

Research only. Nothing under `src/` changed, no dependency was added, and the
boundary described here is a prototype (`prototype/load-boundary.mjs`), not
production code.

**Result: A — CLOSED: hard pre-load boundary proven**, for pdf-lib 1.17.1, on
the evidence below and within the limits stated at the end. The production
load-boundary architecture is HUMAN-OPEN. M6 implementation has not started, and
this document does not authorise it.

## How this blocker came to exist

B3 was not known when the M6 decisions were adopted. It was found, in this order:

1. **M6-H11 at adoption (2026-09-14).** The dominant memory term — what a parsed
   pdf-lib document and its copied object graph weigh — was UNKNOWN, and every
   memory preset, M5's included, NOT ADOPTABLE. The Object-Graph Memory
   Sub-Spike became blocker B2.
2. **B2 (closed 2026-09-15): PARTIALLY BOUNDABLE.** Everything a copy and a
   plain save create could be counted before it exists — once the source is
   loaded. The load itself could not be bounded: pdf-lib parses every object and
   inflates every object stream and cross-reference stream as it meets them,
   with no cap and no hook. `mem-k-objstm-inflation` took 33,149 input bytes to
   33,554,457 decoded bytes, and no term available before the load said so.
   See [`object-graph-memory.md`](object-graph-memory.md).
3. **B3 discovered.** B2 proposed the load boundary as a new blocker. The Human
   accepted it on 2026-09-15 as a mandatory pre-implementation blocker, with a
   defence order — a pre-parse hard boundary first, a disposable Worker second —
   and ruled that a Worker alone does not close it.
4. **B3 result (2026-09-16).** This document.

## What pdf-lib 1.17.1's load expands

From pdf-lib's CommonJS build, as cited in the prototype and the oracle:

| expansion | where | what bounds it today |
| --- | --- | --- |
| every object stream and cross-reference stream is decoded when the parser meets it, into a buffer that doubles | `core/parser/ByteStream.js:58-60`, called only from `core/parser/PDFObjectStreamParser.js:14` and `core/parser/PDFXRefStreamParser.js:14` | nothing |
| a cross-reference stream builds one entry per declared object — `/Size`, or the counts in `/Index` — whatever its decoded bytes hold | `core/parser/PDFXRefStreamParser.js:53-85` | nothing |
| an object stream's offsets are not checked for order or overlap, so one decoded region can be parsed as many objects | `core/parser/PDFObjectStreamParser.js:36-65` | nothing |
| whether a stream is decoded is decided by `dict.lookup('Type')`, which resolves an indirect `/Type` and decodes `#xx` escapes (uppercase only) | `core/objects/PDFName.js:9-10` | — |
| unparseable bytes are skipped until the next object header | the document parser's `skipJibberish` | — |
| the encryption check runs only after all of the above | `PDFDocument` construction | — |

Every filter decoder pdf-lib has is constructed in one place,
`core/streams/decode.js:18-37`. That is what lets an oracle watch the whole
decode surface of a load from two patch points (below).

Today's route loads first and asks nothing. The gate reproduces it on purpose —
18 BASELINE-FAIL rows, among them:

```text
L1   object stream                33,216 B file   33,554,432 B decoded
L2b  xref stream, /Size 1,000,000      8 B decoded 1,000,000 entries built   peak RSS +243 MiB (MEASURED_ONLY)
L17  forty offsets onto one array  100,242 B decoded 4,000,080 B parsed as objects
L18  encrypted trailer            33,554,432 B decoded, then the encryption refusal
K    mem-k-objstm-inflation       33,554,457 B decoded — into a 67,108,864 B buffer
```

## The boundary

`inspectLoadBoundary(bytes, limits)` runs before `PDFDocument.load` is called,
never calls pdf-lib, and answers `PASS` or `REFUSE` with a typed code and the
**stage** that refused. The stages run in this order:

| stage | what it does | refuses with |
| --- | --- | --- |
| input | raw byte ceiling | `INPUT_TOO_LARGE` |
| raw-name-scan | any name in the raw bytes that decodes, case-blind, to `Encrypt` | `ENCRYPTED` |
| walk | a linear walk following pdf-lib's tokenizer: stream keyword variants, the dictionary loop condition, `true`/`false`/`null` without a delimiter check, string escapes, the indirect-reference lookahead, xref table lines; anything pdf-lib would only reach by skipping or recovering; an indirect `/Type` on any stream; a decode candidate with `/Type` twice, or whose names pdf-lib and a case-blind decode read differently; too many decode candidates; nesting past its own depth limit | `MALFORMED_SYNTAX`, `UNEXPECTED_BYTES`, `NO_HEADER`, `INDIRECT_TYPE_ON_STREAM`, `DUPLICATE_KEY_ON_DECODE_STREAM`, `AMBIGUOUS_NAME_ESCAPE`, `TOO_MANY_DECODE_STREAMS`, `NESTING_DEPTH` |
| attribution | every raw name that could decode to `ObjStm` or `XRef` is the direct `/Type` of a stream the walk found | `UNATTRIBUTED_DECODE_TYPE_NAME` |
| declared-values | per candidate: a direct `/Length` that lands on `endstream`; no filter or one `FlateDecode`; direct integer `/Size`, `/W`, `/Index`, `/N`, `/First`; declared xref entries and object-stream objects within caps | `AMBIGUOUS_STREAM_LENGTH`, `UNSUPPORTED_FILTER`, `AMBIGUOUS_DECLARED_VALUE`, `XREF_ENTRY_CAP`, `OBJECT_STREAM_OBJECT_CAP` |
| decode | bounded inflate, per stream and cumulatively | `DECODED_BYTES_PER_STREAM`, `DECODED_BYTES_TOTAL`, `DECODE_ERROR` |
| decoded-content | an object stream's decoded bytes name no `ObjStm`, `XRef` or `Encrypt`; its objects start in increasing order and end before the next begins; none is a stream | `DECODE_TYPE_NAME_IN_DECODED_CONTENT`, `OVERLAPPING_OBJECT_STREAM_OFFSETS`, `STREAM_IN_OBJECT_STREAM` |

Anything else the boundary did not expect, its own exceptions included, is
`INSPECTION_FAILED` — a refusal, never a pass.

**The raw name scan is a superset detector, not a proof.** It can refuse a
document that holds nothing dangerous — L19's `/Title` string mentions
`/ObjStm`, and is refused — and that is counted as compatibility cost. It never
shows on its own that a document is safe: PASS needs every stage.

### L16 and L16b: which stage refuses

The walk runs before attribution, and attribution before any decode, so the
stage that refuses a document is part of what it proves.

- **L16** hides the name `/ObjStm` inside a clean object stream and points a
  later stream's `/Type` at it. No raw byte spells the name. It is refused at
  **walk**, by the indirect-`/Type` rule — stages completed `input →
  raw-name-scan`, nothing decoded. The decoded-content scan would also have
  caught the name, but never runs. An earlier draft of the fixtures expected
  that scan to refuse L16; the stage order says otherwise, and the expectation
  was corrected (limitations.md #23).
- **L16b** puts the same name in the same place with nothing pointing at it.
  The walk and attribution let it through — one raw `ObjStm` name, and it is the
  object stream's own direct `/Type` — the stream is decoded, and only
  **decoded-content** refuses it. pdf-lib would load it and decode 12 B; the
  refusal is conservative, on purpose.

### The decode hard bound

Decoding does not inflate and then measure. pako hands its output out one
chunk (16,384 B) at a time from inside `push`; the first chunk that takes the
running total past the limit throws out of `push`, so decoding stops there and
the rest of the input is never read. At most *limit + one chunk* decoded bytes
ever exist.

```text
decoder alone, 4 MiB cap
  exactly the cap       4,194,304 B decoded in 256 chunks          allowed
  cap + 1               4,194,305 B materialised                   refused
  32 MiB stream         4,210,688 B materialised in 257 chunks;    refused
                        4,097 of 32,624 input bytes read

whole documents
  L11   one stream of exactly 4,194,304 B                          PASS
  L12   one stream of 4,194,305 B                                  DECODED_BYTES_PER_STREAM @ decode, 4,194,305 B materialised
  L11c  two streams, 8,388,608 B together (the cumulative cap)     PASS
  L12c  three streams, each under the per-stream cap, 8,388,609 B  DECODED_BYTES_TOTAL @ decode — 8,388,568 B accepted,
                                                                   the last stream limited to the 40 B that remained
```

Every inflation bomb among the fixtures — L1, L2, L3, L4, L5b, L15 and K — was
abandoned before its compressed input was read to the end: L1 after 4,125 of
32,654 bytes, L4 after 4,126 of 16,347, L3's third stream after 2,089 of 3,095.

### The boundary's own bounds

Across all 36 shapes and all 419 corpus documents: no decode materialised more
than 4,210,688 B (the cap plus one chunk); no chunk exceeded 16,384 B; no decoded
object stream was kept beyond 4,194,304 B; no document made the boundary parse
more values than it has raw plus decoded bytes; and arrays nested 80 deep are
refused at its own depth limit of 64, with a typed code, before its recursion
goes further.

## The differential oracle

`scripts/load-boundary-oracle.mjs` patches pdf-lib where its load decodes or
expands — `ByteStream.fromPDFRawStream`, `decodePDFRawStream`,
`DecodeStream.ensureBuffer` and `PDFXRefStreamParser.parseEntries` — records what
passes through, and calls the real `PDFDocument.load`.

The invariant is one-directional:

```text
boundary PASS  ⇒  pdf-lib's decoded bytes, largest stream, decode calls and xref entries
                  ≤ what the boundary counted  ≤  the hard caps
```

The converse — pdf-lib can read it, so the boundary should pass it — is not
required. A conservative refusal is a compatibility number, not a failure.

- **Isolation.** Each of the 36 fixtures (35 generated and B2's K) ran in a
  process of its own, so a bomb, a hang or an excessive decode could not reach
  another case. The 419 corpus documents ran in one process, except the two the
  boundary refused as possible bombs, which ran alone.
- **No result is not safe.** A document with no result line — the process
  failed, hung past its timeout, or ran out of memory — counts as a failure.
  36 of 36 fixture runs and 419 of 419 corpus runs returned a result.
- **The oracle is not blind.** It saw L9's two ordinary decodes, L1's
  33,554,432 B, and L2b's 1,000,000 entries.
- **One route.** In every load observed — fixtures, mutants and corpus — every
  call to pdf-lib's filter decoder came through the load decode the oracle
  counts. No decode reached pdf-lib by another path.

```text
fixtures passed by the boundary     9    undercounted 0
fixtures that must be refused       27   passed 0
mutants passed by the boundary      135  undercounted 0
corpus documents passed             411  undercounted 0
```

pdf-lib's decode buffer is not the decoded length: it grows by doubling.
L11's 4,194,304 B landed in a 4,194,304 B buffer; K's 33,554,457 B needed a
67,108,864 B one. That is an allocation pattern observed in two loads, recorded
here and not turned into a limit.

**L21 shows the ambiguity rule is not theoretical.** Its object stream spells
`/Filter` as `/Fi#6cter`. pdf-lib decodes only uppercase `#xx`, so to it the
stream has no filter, and it takes all 46 stored bytes; a case-blind reader
would see `FlateDecode` and count 35. A boundary that resolved the name instead
of refusing it would have counted less than pdf-lib decoded. The draft boundary
did exactly that (limitations.md #24).

## Parser-shape sweep

576 deterministic mutants — 48 truncations, 96 single-byte substitutions and 48
single-byte insertions of each of L9, L5 and L4b — went through the boundary.
Every one it passed went through the real load, in one process.

```text
PASS 135 · MALFORMED_SYNTAX 340 · UNEXPECTED_BYTES 49 · DECODE_ERROR 28 · AMBIGUOUS_STREAM_LENGTH 15
NO_HEADER 4 · UNSUPPORTED_FILTER 3 · AMBIGUOUS_DECLARED_VALUE 1 · UNATTRIBUTED_DECODE_TYPE_NAME 1

passed 135 → oracle results 135 → undercounted 0, off route 0
```

pdf-lib failed to load 12 of the 135 the boundary passed. That is allowed: a
PASS promises a bounded load, not a successful one.

## Compatibility

The repository's other fixture corpora — 419 documents, every one synthetic.
No real drawing was available, so this is not a compatibility claim about real
drawings.

```text
PASS                              411
MALFORMED_SYNTAX @ walk             2   annotator-save/damaged.pdf, m3/damaged.pdf
NO_HEADER @ walk                    2   m6-split-merge/invalid.pdf, processor/invalid.pdf
UNEXPECTED_BYTES @ walk             1   m5-processor/invalid.pdf
ENCRYPTED @ raw-name-scan           1   m6-split-merge/encrypted.pdf
TOO_MANY_DECODE_STREAMS @ walk      1   m6-object-graph-memory/mem-b2-many-objects-objstm.pdf
DECODED_BYTES_PER_STREAM @ decode   1   m6-object-graph-memory/mem-k-objstm-inflation.pdf
```

pdf-lib also fails on six of the eight refused. Of the two it loads, K goes past
the caps; `mem-b2-many-objects-objstm.pdf` stays within them, and is the corpus's
one conservative refusal — more than 64 object streams, under the research
limit. Among the fixtures, seven refusals are conservative in the same sense:
L8, L8b, L12, L16b, L19, L21 and L23.

The limits are research test values chosen to put the boundary cases where a
gate reaches them — 64 MiB input, 4 MiB per stream, 8 MiB in total, 64 decode
streams, 100,000 xref entries, 10,000 objects per object stream, depth 64. They
are not product values and not memory figures.

## B2 composed behind B3

Bound the load, then load, plan the copy from the loaded graph, copy, and write —
each stage using only a term the stage before made available:

```text
L9    PASS → load → planned 3 objects = copied 3 → output under the ceiling
L10   PASS → load → planned 3 = copied 3 → under the ceiling
L11c  PASS (8,388,608 B decoded) → load → planned 1 = copied 1 → under the ceiling
K     REFUSE DECODED_BYTES_PER_STREAM → pdf-lib's load never called
```

## The Worker: defence in depth, not closure

The browser half ran in headless Chromium with the boundary inside a disposable
module Worker. None of its rows count toward closure.

| check | result |
| --- | --- |
| input by transfer | 1,668 B sent, 0 B left on the page, 1,668 B received |
| output by transfer | 797 B returned, 0 B left in the Worker |
| after `terminate()` | 0 answers |
| cancel a load in progress | started, not ended, terminated; 0 messages after |
| budget counted from the load's start | typed `TIMEOUT`; 0 late messages |
| failures | caught → `LOAD_FAILED`; synchronous uncaught throw → `WORKER_ERROR`; unhandled rejection → `UNHANDLED_REJECTION` |
| refusal inside the Worker | L1 `DECODED_BYTES_PER_STREAM @ decode` and L16b `DECODE_TYPE_NAME_IN_DECODED_CONTENT @ decoded-content`, both before any load started; L10 loaded and returned |
| external HTTP(S) | 0 |

Two observations matter beyond the rows:

- **An unhandled rejection is silence.** Raised inside a Worker, it fires no
  `error` event on the Worker object — 0 events measured. Without the Worker's
  own `unhandledrejection` listener, the page learns nothing, and only a timeout
  would notice. The first harness hit exactly this (limitations.md #25).
- **Nothing measures or caps a Worker's memory here.**
  `performance.measureUserAgentSpecificMemory` was undefined and the page was
  not cross-origin isolated. No API sets a per-Worker ceiling.

Responsiveness (MEASURED_ONLY, one run): during L13's slow load the page's own
10 ms timer was held off for up to 175 ms on the main thread and 12 ms with the
load in a Worker. That is responsiveness, not a memory bound.

So the Human's ruling stands on evidence: a Worker contains a failure after the
fact and keeps the page responsive, but it bounds nothing. The boundary does.

## Decision

The six conditions for **A**, each met by node-half rows only:

| condition | rows | met |
| --- | --- | --- |
| every dangerous shape refused before `PDFDocument.load` | 18 | yes |
| the boundary itself bounded: decode, chunk, retention, parse work | 9 | yes |
| load-time decode surface covered, and the oracle not blind | 6 | yes |
| differential oracle: known false negatives 0 | 4 | yes |
| exact boundary: cap allowed, cap + 1 refused, per stream and cumulatively | 6 | yes |
| ambiguous or unsupported syntax refused, never guessed at | 11 | yes |

B — new architecture required — is not supported: a hard pre-load boundary was
built on the current pdf-lib route and held against every shape and document
tried. C — evidence insufficient — would need a condition above unmet, or a
known false negative, and there is neither.

**B3: A — CLOSED: hard pre-load boundary proven.** What that means, and does
not:

- It is proven for **pdf-lib 1.17.1**, the pinned version. The walk follows that
  version's tokenizer, and a pdf-lib change reopens the question.
- "Known false negatives 0" is a statement about 36 shapes, 135 passed mutants
  and 411 passed corpus documents. It is not a proof that no input exists on
  which the boundary under-counts.
- It bounds the load's **structural** expansion — input bytes, decoded bytes per
  stream and in total, declared xref entries, objects per object stream, parse
  work — before the load. It does not turn B2's UNKNOWN heap bytes per object
  into a number, and it makes no memory preset adoptable.
- It is a prototype with research limits. Its compatibility on real drawings is
  unmeasured.

## HUMAN-OPEN

- Whether a pre-parse boundary is adopted as M6's load contract.
- The limit values.
- The decoder. pako 2.1.0 is resolved here only transitively (through
  `jspdf → fast-png`); it is not a declared dependency. A decoder whose chunking
  is not source-derived would need its own bound proved.
- Where it runs — main thread or Worker — and whether the Worker is kept as
  defence in depth.
- Whether strict-syntax refusals are acceptable for real drawings, which this
  research could not measure.

## Running it

```bash
node research/m6-split-merge-reliability/scripts/make-m6-load-boundary-fixtures.mjs
node research/m6-split-merge-reliability/scripts/load-boundary-gate.mjs
```

The generator writes 35 fixtures and `corpus.json` to
`test-fixtures/m6-load-boundary/`, which is ignored; the gate writes mutants to
`sweep/` beneath it and its evidence to `evidence-load-boundary.json`. Core CI
does not run it.

```text
load-boundary gate   ASSERT 49  PROBE 31  MEASURE 14  BASELINE-FAIL 18  HUMAN-OPEN 1   98/98
                     node half 90/90 · browser half 8/8 · external HTTP(S) 0
```
