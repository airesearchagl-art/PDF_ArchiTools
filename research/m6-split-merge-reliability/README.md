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

Three findings go further than "something was lost":

1. **Extract ships pages nobody selected.** A link on a selected page whose
   destination is a page outside the selection causes that page to be copied
   into the output as an orphan — outside `/Pages`, invisible to any reader,
   present in the bytes. Extracting page 1 of a four-page document produced a
   file holding three page objects. For an extract made to share part of a
   confidential set, that is a disclosure.
2. **A signed source produces an ordinary-looking file with no warning.**
3. **Widgets survive without the form they belonged to** — they render, and they
   are bound to nothing.

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
| [`budget.md`](budget.md) | memory lifetimes with basis classifications, and why a hard memory budget cannot be closed today |
| [`limitations.md`](limitations.md) | what was not measured, caveats on what was, and the instrument defects found on the way |
| [`human-gate.json`](human-gate.json) | M6-H1 … M6-H14, each with candidates, measured consequences, a recommendation and what stays DEFER |
| `evidence.json` | structural measurements, written by the research gate |
| `evidence-browser.json` | preview and lifetime measurements, written by the browser gate |

Facts are kept apart from opinions on purpose. `baseline.md`,
`source-preservation-matrix.md` and `structure-policy.md` contain only observed
production facts, pdf-lib behaviour and prototype results. The two contract
files and `human-gate.json` contain recommendations, and say so.

## Running the gates

```bash
node research/m6-split-merge-reliability/scripts/make-m6-fixtures.mjs
node research/m6-split-merge-reliability/scripts/research-gate.mjs     # node, structural
node research/m6-split-merge-reliability/scripts/browser-gate.mjs      # browser, memory and lifetime
```

Fixtures are written to `test-fixtures/m6-split-merge/`, which is already
ignored, so running the gates leaves the working tree clean.

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
research gate   ASSERT 11  PROBE 3  MEASURE 20  BASELINE-FAIL 15  HUMAN-OPEN 14   29/29
browser gate    ASSERT  3  PROBE 1  MEASURE 11  BASELINE-FAIL  4  HUMAN-OPEN  2     8/8
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
