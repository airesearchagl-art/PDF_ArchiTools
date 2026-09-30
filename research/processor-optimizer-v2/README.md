# Processor Optimizer v2 — image-aware PDF optimization research

Architecture research only. **Nothing under `src/` is modified.** Production
Processor and Comparator modules are imported unmodified through an esbuild
bundle (`harness/prod-entry.ts`).

- Report (Human Gate): [`report.md`](report.md)
- Limitations / instrument defects: [`limitations.md`](limitations.md)
- Evidence: [`evidence/`](evidence/) (`gate-*.json`, `matrix-*.jsonl`, `model.json`, `selftest-*.json`)

## Layout

| Step | Script | Output |
|---|---|---|
| Production bundle | `harness/prod-entry.ts` (pdfjs-dist aliased to its legacy build for Node) | `out/prod.mjs` |
| Synthetic corpus, 11 fixtures incl. the 261 MB old-Comparator-like A1 x 5 | `corpus/make-corpus.mjs` | `out/corpus/*.pdf`, `manifest.json` (independent sample hashes + expected text) |
| Optimizer prototype (census, R1 / R2 / LEAVE / opt-in LOSSY, pdf-lib or chunked writer) | `harness/optimizer.mjs` | — |
| Independent reopen (pdf.js + pdf-lib): pages, boxes, rotation, operator stream, text, annotations, fields, metadata, every image's decoded samples | `harness/verify.mjs` | — |
| The verifier must catch nine deliberate breaks | `harness/verify-selftest.mjs` | `evidence/selftest-*.json` |
| One (fixture, candidate) per process, RSS sampled | `harness/run.mjs`, `harness/run-matrix.mjs` | `out/results/**`, `evidence/matrix-*.jsonl` |
| Current arithmetic (production functions) + proposed memory policies | `harness/model.mjs` | `evidence/model.json` |
| All of the above, clean, Structural vs MeasuredOnly | `harness/gate.mjs --run gN` / `--compare g1 g2` | `evidence/gate-*.json` |
| Image census of **any** PDF, locally, read-only (for the Acrobat pair) | `harness/inspect-images.mjs <file.pdf>` | stdout only |

Run from this directory with the repository's `node_modules` (Node 24):

```sh
node harness/gate.mjs --run g1
node harness/gate.mjs --run g2
node harness/gate.mjs --compare g1 g2
```

A gate takes about 8 minutes and a few GB of RAM. Everything under `out/` is
generated and git-ignored.

## The Acrobat pair

When the real before/after files are available, run on each, locally:

```sh
node research/processor-optimizer-v2/harness/inspect-images.mjs <file.pdf>
```

It reads the file, prints each image's size, effective ppi, colour space,
bits, filter chain and bytes, and writes nothing. Do not copy the files into
this repository.
