# M5 — Raster Encoder / Memory Sub-Spike

**Research / decision PR. No production code is changed.** Starting point:
`main@78b5bd5ee676ee72621bccf9524225cd4ce8482a`.

The M5 Processor Reliability Architecture was adopted with one decision left
blocked: **H8**, the memory contract for the flattening operations. It could
not be adopted because production encodes with
`canvas.toDataURL('image/jpeg', 0.8)` — an encoder the architecture does not
own, whose output size is bounded only by the JPEG *format* (20 B/px) and whose
internal working memory is bounded by nothing at all.

This sub-spike exists only to answer one question:

> Can the Processor use a browser-local encoding path whose encoded size and
> working-memory lifetime are bounded tightly enough to support a fail-closed
> memory contract?

**Yes.** Not by bounding the encoder — by removing it.

## What was found

- **An owned image XObject (E3) has no encoder in it.** pdf-lib writes a stream
  exactly as given (`context.stream`) or deflates it with its own pinned pako
  (`context.flateStream`). The samples the page already holds go into the PDF
  as they are: **1 B/px for DeviceGray, 3 B/px for DeviceRGB, exact before the
  page is rendered**, or bounded by DEFLATE's own stored-block worst case.
- **The peak stops being about the encoder at all.** For every E3 variant the
  peak is the render and readback — 8 B/px, exact — at **66.4 MiB** for one A4
  page at 300 dpi. Grey and colour, raw and deflated, all peak at the same
  place, because nothing after the readback is larger than it.
- **The capacity the old estimate promised survives.** Inside 512 MiB, the
  owned DeviceGray path takes **30 A4 pages at 300 dpi and 123 at 150** — the
  same as the measured estimate that could never be adopted, and against the
  **0 and 6** that the only fail-closed JPEG term allowed. Optimize keeps
  colour, so it carries 10 and 41: a smaller product limit, honestly bounded.
- **Reusing M4's owned PNG encoder (E2) does not close H8.** Its size is exact,
  but pdf-lib's PNG path spends that exactness at the door: UPNG copies the
  PNG, inflates it, expands it to RGBA, pdf-lib copies that frame again and
  splits it into RGB and alpha before deflating. Peak **132.7 MiB** — twice
  E3's — for a document no smaller.
- **The encoder was never what made the drawings worse.** At the same
  resolution every candidate scores the same (1 px linework at 300 dpi: ink
  kept 76.3% with production JPEG, 76.5% with the lossless owned path; PSNR
  19.5 dB for both). What destroys linework is the resolution: the same
  lossless path keeps **3.5% at 150 dpi and 76.5% at 300**.
- **E4 was rejected on a fact**: no pinned dependency contains a JPEG encoder.
  pdf-lib parses JPEG, pdfjs-dist decodes it, jsPDF embeds it; none writes one.
  Adopting or writing one is a dependency decision for a Human Gate.
- **The base64 step disappears.** Production turns J bytes into a data URL of
  4·⌈J/3⌉+23 characters — 33.4% larger, measured exactly — and decodes it back.
  An owned path hands pdf-lib a `Uint8Array`; no string exists.

## What is proposed (not adopted)

**H8-A for Monochrome, H8-B for Optimize.** Adopt the owned image XObject:
DeviceGray for Monochrome, DeviceRGB for Optimize, FlateDecode for the file
size and no filter where the encoded size must be exact. `MAX_RASTER_PIXELS`
(128 Mi px) and `MAX_OUTPUT_BYTES` (256 MiB) stay as H9 adopted them, and no
memory preset may bypass either. Two Human decisions remain open: the contract
itself, and whether a larger PDF is an acceptable price for it.

## Evidence

The **sub-spike gate** (`scripts/research-gate.mjs`) runs locally on this
branch; its output is committed as `evidence.json`, which records
`productionBase`, `researchHeadAtRun`, `researchBranchAtRun`,
`workingTreeDirty` and `coreCiRunsThisGate`. **Core CI** runs the existing
backbone at the exact head and does **not** run this gate.

## Files

| file | contents |
| --- | --- |
| `architecture.md` | the encoding paths, the lifetime model, and what each term's basis is |
| `measurements.md` | every number: sizes, quality, peaks, boundaries, batches |
| `decision.md` | the H8 recommendation, in the three states the spike was allowed to end in |
| `limitations.md` | what the evidence does not show |
| `evidence.json` | the gate's output, every line classified |
| `prototype/encoders.mjs` | the candidates, their exact arithmetic and their term bases |
| `prototype/image-xobject.mjs` | E3 implemented: an owned image XObject |
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
