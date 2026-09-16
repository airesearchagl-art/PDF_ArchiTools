# M6 — Split / Merge Reliability Architecture Research

Architecture research only. **No production file was changed, no dependency was
touched, and nothing here is implemented.** The `src/` diff against the
production base is 0 files.

The lane is `src/components/PdfSplitMerge.tsx` — PDF抽出 (Extract) and PDF統合
(Merge). The question this research exists to answer is whether copying pages is
the same thing as splitting and merging documents. It is not, and the gap is
measured here rather than argued.

## The short version

Page **content** survives both operations intact — text, vectors, images,
`MediaBox`, `CropBox`, `/Rotate`, `/UserUnit`, and the four attributes pdf-lib
folds down from the page tree. Merge order is correct, repeated files are not
deduplicated, and rotations survive.

Everything **above** the page is dropped, silently, by both operations: the
AcroForm and its field values, XFA, named destinations, outlines, page labels,
`/OpenAction`, `/OCProperties`, `/StructTreeRoot`, embedded files, document
JavaScript, and all document metadata including the XMP packet — which is then
replaced by pdf-lib's own `/Producer` and `/ModDate`.

Four findings go further than "something was lost":

1. **Extract ships pages nobody selected.** A link on a selected page whose
   destination is a page outside the selection causes that page to be copied
   into the output as an orphan — outside `/Pages`, invisible to any reader,
   present in the bytes. Extracting page 1 of a four-page document produced a
   file holding three page objects. For an extract made to share part of a
   confidential set, that is a disclosure.
2. **Even a link to a page that *was* selected lands outside the page tree.**
   Measured per shape: `/Dest` to a selected page, both pages kept — 2 pages in
   the tree, 1 orphan, **0 destinations landing in the document**. The link
   resolves and navigates nowhere a reader can reach, and nothing reports it.
   And `/Annots` is not the only route: an article bead reaches another page
   with no link annotation involved.
3. **A signed source produces an ordinary-looking file — and it still looks
   signed.** The signature is gone; the signature *appearance* is not. Rendering
   the signature rectangle gives **4,325 non-white pixels of 24,300 in both the
   source and the extract**, pixel for pixel.
4. **Widgets survive without the form they belonged to** — they render, and they
   are bound to nothing.

All four have prototypes showing the contract is implementable: destinations
stripped before copying and rebuilt afterwards give **0 orphan pages in all ten
destination shapes**, and a form wholly inside a selection is rebuilt with its
values and **0 orphan widgets**.

None of this is a misuse of pdf-lib; the library's own doc comment says it does
not copy acroforms or outlines. The defect is that the product presents page
copying as document splitting and merging, and reports success.

## Files

| file | what it holds |
| --- | --- |
| [`baseline.md`](baseline.md) | the current implementation's routes and what they measurably do, with a FAIL → root cause → fix-direction table |
| [`source-preservation-matrix.md`](source-preservation-matrix.md) | every structure, per operation: preserved / transformed / dropped / dangling / unsupported |
| [`structure-policy.md`](structure-policy.md) | what pdf-lib 1.17.1 does, cited `file:line`, and which decisions that forces |
| [`extract-contract.md`](extract-contract.md) | proposed Extract contract, including the E1/E2/E3 destination policies |
| [`merge-contract.md`](merge-contract.md) | proposed Merge contract, including intake semantics and collisions |
| [`preview-memory.md`](preview-memory.md) | what the thumbnail preview costs, by page count and sheet size, and the alternatives priced |
| [`budget.md`](budget.md) | memory lifetimes with basis classifications, why a hard memory budget could not be closed at adoption, and what B2 changed |
| [`object-graph-memory.md`](object-graph-memory.md) | B2, the Object-Graph Memory Sub-Spike: which memory terms of a Split or Merge can be known before the work, from pdf-lib's source and a real copy — PARTIALLY BOUNDABLE |
| [`load-boundary.md`](load-boundary.md) | B3, the Load Boundary Sub-Spike: a pre-parse boundary that refuses what pdf-lib's load would expand, checked against the real load — A, hard pre-load boundary proven |
| [`limitations.md`](limitations.md) | what was not measured, caveats on what was, and the instrument defects found on the way |
| [`human-gate.json`](human-gate.json) | M6-H1 … M6-H14, each with candidates, measured consequences, a recommendation and what stays DEFER |
| `prototype/extract-destinations.mjs` | E1 and E2, prototyped far enough to prove the orphan-page invariant is reachable |
| `prototype/form-subset.mjs` | the supported form subset, its detector, Extract reconstruction and Merge collision handling |
| `prototype/object-graph-memory.mjs` | the walk that counts what `copyPages` will copy, and the plain writer's output length before it allocates |
| `prototype/load-boundary.mjs` | the staged pre-parse boundary and its bounded inflate |
| `evidence.json` | structural measurements, written by the research gate |
| `evidence-browser.json` | preview and lifetime measurements, written by the browser gate |
| `evidence-object-graph-memory.json` | object-graph structure and phase memory, written by the object-graph memory gate |
| `evidence-load-boundary.json` | boundary verdicts and stages, decode bounds, the differential oracle, the sweep, compatibility and the Worker, written by the load-boundary gate |

Facts are kept apart from opinions on purpose. `baseline.md`,
`source-preservation-matrix.md` and `structure-policy.md` contain only observed
production facts, pdf-lib behaviour and prototype results. The two contract
files and `human-gate.json` contain recommendations, and say so.

## Running the gates

```bash
node research/m6-split-merge-reliability/scripts/make-m6-fixtures.mjs
node research/m6-split-merge-reliability/scripts/research-gate.mjs     # node, structural
node research/m6-split-merge-reliability/scripts/browser-gate.mjs      # browser, memory and lifetime
node research/m6-split-merge-reliability/scripts/make-m6-memory-fixtures.mjs
node research/m6-split-merge-reliability/scripts/object-graph-memory-gate.mjs   # node, object-graph memory (B2)
node research/m6-split-merge-reliability/scripts/make-m6-load-boundary-fixtures.mjs
node research/m6-split-merge-reliability/scripts/load-boundary-gate.mjs         # node + browser, load boundary (B3)
```

Fixtures are written to `test-fixtures/m6-split-merge/`,
`test-fixtures/m6-object-graph-memory/` and `test-fixtures/m6-load-boundary/`,
all already ignored, so running the gates leaves the working tree clean.

Row kinds, as the brief defines them:

```text
ASSERT         must hold, and does
PROBE          a negative probe: input that must make a check fire
MEASURE        a number, reported without a verdict
BASELINE-FAIL  a defect in today's production behaviour, reproduced on purpose
HUMAN-OPEN     a decision this research may not take
```

A BASELINE-FAIL passing means the defect was **reproduced**. The gate is green
while the product is wrong, and each row says which.

Latest run:

```text
research gate   ASSERT 59  PROBE 82  MEASURE 60  BASELINE-FAIL 18  HUMAN-OPEN 25  159/159
browser gate    ASSERT  3  PROBE  1  MEASURE 12  BASELINE-FAIL  5  HUMAN-OPEN  3      9/9
memory gate     ASSERT 25  PROBE  4  MEASURE 21  BASELINE-FAIL  2  HUMAN-OPEN  1    31/31
load boundary   ASSERT 49  PROBE 31  MEASURE 14  BASELINE-FAIL 18  HUMAN-OPEN  1    98/98
external HTTP(S) during document work: 0
```

**These gates are local research evidence.** Core CI does not run them, and
nothing in this research calls them CI.

## What this research does not do

It takes no Human decision. Every recommendation in `human-gate.json` is a
recommendation, including the two that say "do not adopt yet" — the memory
budget, which contains an UNKNOWN that would have to be closed by an
Object-Graph Memory Sub-Spike before any preset could honestly be offered, and
the uncommon catalog structures, which pdf-lib does not implement at all.

B2 has since run that Sub-Spike. It classified the memory model PARTIALLY
BOUNDABLE, kept every preset DO NOT ADOPT, and proposed the load boundary it
could not close as blocker B3 — see [`object-graph-memory.md`](object-graph-memory.md).

The Human accepted B3 as a mandatory pre-implementation blocker, and B3 has
since run the Load Boundary Sub-Spike. A staged pre-parse boundary refused every
dangerous shape before pdf-lib's load, stayed within its own bounds, and was
never passed a document on which the real load decoded more than it counted.
B3 is closed as A — hard pre-load boundary proven, for pdf-lib 1.17.1. That
bounds the load's structure, not its heap bytes, and no preset became adoptable.
Adopting the boundary as M6's load contract was left to the Human. On
2026-09-16 the Human adopted it as M6's mandatory load contract, with a
disposable Worker as secondary defence, pako 2.1.0 as the decoder and the proof
bound to pdf-lib 1.17.1 — but did not adopt the research test limits as product
values. That product load policy, and how much conservative refusal real
drawings can bear, is blocker B4: it blocks Ready, release and production
enablement, not implementation. Implementation has not started, and waits on a
Final Independent Architecture Re-Review — see [`load-boundary.md`](load-boundary.md).
