# M4 Comparator — large-set Output Writer research

Architecture research only. **Nothing under `src/` is modified.** The harness
imports the production comparator modules unmodified through an esbuild bundle
(`harness/prod-entry.ts`), so every verdict, composite and preflight figure here
is production's own.

- Report (Human Gate): [`report.md`](report.md)
- Limitations / instrument defects: [`limitations.md`](limitations.md)
- Evidence: [`evidence/`](evidence/)

## What is generated, and where

Everything bulky goes to `out/` (git-ignored): the synthetic corpus, the
stage-1 composites and masks (≈ 6 GB at 450 dpi), and every candidate PDF.
No customer or real-project document is used or committed.

| Step | Script | Output |
|---|---|---|
| Production bundle | `harness/prod-entry.ts` (esbuild; jsPDF aliased to the browser ES build the app ships) | `out/prod.mjs` |
| Synthetic A1 corpus, 2 × 5 pages | `corpus/make-a1-corpus.mjs` (puppeteer Chrome `page.pdf`, then pdf-lib) | `out/corpus/a1-set-{A,B}.pdf` |
| Stage 1: render + production kernel (`inkMask`, `dilateMask`, `pairChangeMask`, `verdictFor`, `changeBounds`, `paintPair`) | `harness/prepare.mjs --dpi N [--tolerance-mm T]` | `out/composites/<tag>/pN/{composite.rgba,ref.mask,oth.mask,meta.json}` |
| Today's preflight over the A1 frames | `harness/budget-matrix.mjs` | `evidence/budget-matrix.json` |
| Stage 2: one writer × one DPI per process, maxRSS + sampled RSS, then independent reopen | `harness/write.mjs`, driven by `harness/run-matrix.mjs` | `out/pdf/<tag>/*.pdf`, `evidence/matrix-<run>.jsonl` |
| Candidate writer prototype | `harness/pdf-writer.mjs`, `harness/encoders.mjs` | — |
| Reopen oracle (pdf-lib + pdf.js, pixel-exact) | `harness/verify.mjs` | inside the matrix lines |
| Deflate worst case + proposed two-layer budget | `harness/model.mjs` | `evidence/model.json` |
| Real Chrome: A1 canvases, CompressionStream, PDF viewer | `harness/chrome-check.mjs` | `evidence/chrome-check.json`, `out/chrome/*.png` |
| All of the above, clean, with Structural / MeasuredOnly split | `harness/gate.mjs --run gN` | `evidence/gate-gN.json` |
| Compare two gate runs' Structural fields | `harness/gate.mjs --compare g1 g2` | exit 0 when identical |
| RF-01: owned bounded DEFLATE (safety-authoritative encoder) | `harness/owned-deflate.mjs` | — |
| RF-01: owned-bound budget model (OWNED / PRODUCTION / PLATFORM / MEASURED) | `harness/rf01-model.mjs` | `evidence/rf01-model.json` |
| RF-02: production engine, 2/3/4 members, notices, mixed sheets, teed to jsPDF | `corpus/make-rf02-corpus.mjs`, `harness/rf02.mjs` | `evidence/rf02-<run>.json` |
| RF focused gate (reuses SHA-bound composites after checking them) | `harness/rf-gate.mjs --run rfN` / `--compare rf1 rf2` | `evidence/rf-gate-<run>.json`, `evidence/rf01-<run>.jsonl` |
| Image census of **any** PDF, locally, read-only | `harness/inspect-images.mjs <file.pdf>` | stdout only |

Run from this directory, with the repository's `node_modules` available
(Node 24, the pinned puppeteer Chrome):

```sh
node harness/gate.mjs --run g1
node harness/gate.mjs --run g2
node harness/gate.mjs --compare g1 g2
```

A full gate takes roughly 15 minutes and peaks at a few GB of RAM (the 450 dpi
current-writer cell alone holds ~3 GB).

## Checking what Acrobat did — without sharing the file

`inspect-images.mjs` lists every image in a PDF: pixel size, effective ppi,
colour space, bits, filter chain and bytes. Run it locally on the Acrobat-
compressed real document and the uncompressed original; nothing leaves the
machine and nothing is written. Downsampling shows as ppi below the export
DPI; lossy recompression as `DCTDecode` / `JPXDecode` / `JBIG2Decode`;
lossless as `FlateDecode`.
