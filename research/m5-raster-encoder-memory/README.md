# M5 — Raster Encoder / Memory Sub-Spike

**Research / decision PR. No production code is changed, and no dependency is
added.** Starting point: `main@78b5bd5ee676ee72621bccf9524225cd4ce8482a`.

The M5 Processor Reliability Architecture was adopted with one decision left
blocked: **H8**, the memory contract for the flattening operations. It could
not be adopted because production encodes with
`canvas.toDataURL('image/jpeg', 0.8)` — an encoder the architecture does not
own, whose output size is bounded only by the JPEG *format* (20 B/px) and whose
internal working memory is bounded by nothing at all.

> Can the Processor use a browser-local encoding path whose encoded size and
> working-memory lifetime are bounded tightly enough to support a fail-closed
> memory contract?

**Yes.** Not by bounding the encoder — by removing it.

## What was found

- **An owned image XObject (E3) has no encoder in it.** pdf-lib writes a stream
  exactly as given (`context.stream`) or deflates it with its own pinned pako
  (`context.flateStream`). The samples the page already holds go into the PDF
  as they are: **1 B/px DeviceGray, 3 B/px DeviceRGB, exact before the page is
  rendered**. Verified rather than assumed — `typedArrayFor` returns the array
  unchanged (arrays.js:9-11), `PDFRawStream` assigns it (PDFRawStream.js:10),
  and the gate reads the stored size back with `getContentsSize()`.
- **The ordering is part of the contract.** `getImageData` needs the canvas;
  nothing after it does. Releasing it before the samples are allocated takes the
  conversion live set from **11.0 B/px to 7.0**, and the page peak from 91.2 MiB
  to **66.4 MiB** at A4 300 dpi. The first round priced the readback alone and
  claimed 8 B/px for a pipeline that was using 11; both orderings are now
  modelled and the gate measures which one the code performs.
- **The deflate bound is pako's, not DEFLATE's**: `n + 5·⌈n/16383⌉ + 6`. The
  divisor is `lit_bufsize - 1`, because `_tr_tally` increments `last_lit` and
  then returns `(s.last_lit === s.lit_bufsize - 1)` — the flush comes on the
  16,383rd literal. Probed at 16,382 / 16,383 / 16,384 / 32,766 / 32,767 /
  32,768 bytes: every measured size is inside the corrected bound, and the
  previous `/16384` expression, while never violated there, was met **exactly,
  with zero slack**, at three of them. On whole pages, incompressible noise
  lands on the bound to the byte (2,175,631 B and 6,526,881 B) and uniform
  content reaches ×0.001. pako's per-call state is **ten arrays, 267,160 B** —
  not the four large buffers (262,144 B) the first round counted — and its
  16 KiB output chunks, pinned by `shrinkBuf`'s subarray, are terms too.
- **The capacity the old estimate promised survives.** Inside 512 MiB the owned
  DeviceGray path takes **30 A4 pages at 300 dpi and 123 at 150**, against the
  **0 and 6** the only fail-closed JPEG term allowed. Optimize keeps colour, so
  it carries 10 and 41.
- **Batches are smaller than either earlier model said.** Priced from JSZip's
  own path, with the sources, the accumulated chunks, the concatenated archive
  and the Blob copy all live at the handoff — the Blob is built before
  `dataArray` is cleared — a 512 MiB batch takes **61** one-page A4 @150
  DeviceGray files and **20** in DeviceRGB.
- **`FlateDecode` is not free for colour.** Pricing the readback as still
  reachable while deflate runs (nothing promises it is collected first) moves
  DeviceRGB + `FlateDecode` to **108.1 MiB** a page at A4 300 dpi, against
  66.4 MiB for the raw stream. DeviceGray is unaffected, so Monochrome keeps
  the filter and Optimize is recommended raw.
- **Reusing M4's owned PNG encoder (E2) does not close H8.** Its size is exact,
  but pdf-lib's PNG path decodes and re-expands it: peak **132.7 MiB**, twice
  E3's, for a file no smaller.
- **jsPDF 3.0.4 does contain a JPEG encoder (E4)** — `jspdf.es.js:15515`. It is
  inadmissible here on two independent grounds, neither of them absence: no
  supported path reaches it with raw pixels (not exported, not on `jsPDF.API`,
  reachable only through the GIF, BMP and WEBP plugins), and its output is built
  in an ordinary JS array one byte at a time, so its working memory is the
  engine's.
- **The encoder was never what made the drawings worse.** At the same
  resolution every candidate scores the same (1 px linework at 300 dpi: 76.3%
  of the line ink kept by production JPEG, 76.5% by the lossless owned path,
  19.5 dB both). What destroys linework is the resolution: **3.5% at 150 dpi**.
- **Base64 disappears.** Production turns J bytes into a data URL 33.4% larger
  and decodes it back; an owned path hands pdf-lib a `Uint8Array`.

## What is proposed (not adopted)

**H8-A for Monochrome, H8-B for Optimize.** Adopt the owned image XObject:
`DeviceGray` for Monochrome, `DeviceRGB` for Optimize, `FlateDecode` for file
size — it stays inside the hard contract, because every pako allocation is now
a term with a source — and no filter where the encoded size must be exact.
`MAX_RASTER_PIXELS` (128 Mi px) and `MAX_OUTPUT_BYTES` (256 MiB) stay as H9
adopted them, and no memory preset may bypass either. Two Human decisions
remain open: the contract itself, and whether a larger PDF is an acceptable
price for it.

## Evidence

The **sub-spike gate** (`scripts/research-gate.mjs`) runs locally on this
branch; its output is committed as `evidence.json`, which records
`productionBase`, `testedResearchHead`, `researchBranchAtRun`,
`workingTreeDirty` and `coreCiRunsThisGate`. Dirtiness is computed over the
research package **including untracked files**, so an uncommitted prototype
makes the run dirty and the gate fails. **Core CI** runs the existing backbone
at the exact head and does **not** run this gate.

## Files

| file | contents |
| --- | --- |
| `architecture.md` | the encoding paths, the lifetime model, and each term's basis |
| `measurements.md` | every number: orderings, streams, sizes, quality, peaks, boundaries, batches |
| `decision.md` | the H8 recommendation, in the three states the spike was allowed to end in |
| `limitations.md` | what the evidence does not show |
| `evidence.json` | the gate's output, every line classified |
| `prototype/encoders.mjs` | the candidates, their arithmetic and their term bases |
| `prototype/image-xobject.mjs` | E3 implemented, in both orderings |
| `scripts/make-fixtures.mjs` | the quality corpus (written to ignored `test-fixtures/`) |
| `scripts/harness.html` | drives production and the candidates in the browser |
| `scripts/research-gate.mjs` | the gate |

## Run

```sh
node research/m5-raster-encoder-memory/scripts/make-fixtures.mjs
node research/m5-raster-encoder-memory/scripts/research-gate.mjs
```

`ASSERT` and `PROBE` are the apparatus and exit non-zero on failure; `MEASURE`
records a number; `BASELINE-FAIL` describes production and does not fail the
gate; `HUMAN-OPEN` is never a pass.
