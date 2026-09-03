# M1 architecture spike — OCR to searchable PDF

**This is not the M1 implementation.** It exists to prove the architecture in
[`docs/research/M1-textifier-ocr-architecture.md`](../docs/research/M1-textifier-ocr-architecture.md)
end to end in a real browser before any of it is built into `src/`. Nothing here
is imported by the app, and the app bundle is unchanged by it.

## Run it

```powershell
npm install
node spike/fetch-assets.mjs      # ~18 MB of font + WASM + traineddata (not in git)
node spike/make-fixtures.mjs     # synthetic fixtures, no real customer PDFs
node spike/run-spike.mjs         # boots Vite, drives Chrome, checks acceptance
```

`run-spike.mjs` exits non-zero if any acceptance check fails, so it works as a
gate. Results land in `spike/out/spike-results.json`.

## What each file does

| File | Purpose |
|---|---|
| `fetch-assets.mjs` | Downloads M PLUS 1p (OFL-1.1) and `jpn`/`eng` traineddata (Apache-2.0) from canonical upstreams; copies the Tesseract worker + LSTM cores out of `node_modules` so they match the installed version. |
| `make-fixtures.mjs` | Generates the five synthetic fixtures. "Scanned" pages are real rasters rendered in Chrome and embedded as a page's only content, so they genuinely contain no text objects. |
| `pipeline.js` | The spike pipeline: classify → render → OCR → map coordinates → write invisible text → save. |
| `spike.html` | Browser harness. Also contains the measurements: pixel-diff appearance comparison and a real DOM text selection over a PDF.js text layer. |
| `run-spike.mjs` | Boots the project's own Vite dev server, drives `spike.html` in headless Chrome, prints and records the acceptance results. |
| `probe-font-subset.mjs` | Answers the `@pdf-lib/fontkit` CJK subsetting question empirically. |

## Assets are not committed

`spike/assets/`, `spike/fixtures/`, `spike/out/*.pdf`, `public/tessdata/` and
`public/tesseract/` are gitignored — about 18 MB in total, all reproducible from
the scripts above. Only `spike-results.json` is kept, as machine-checkable
evidence.

## Two things worth knowing before reusing this code

**The M1 font policy is `subset: false`. Do not reuse `subset: true`.**

An earlier version of this file recommended `subset: true` for the OCR layer.
That recommendation is withdrawn. `spike/pipeline.js` uses `subset: false`, and
`run-spike.mjs` has an acceptance check that reads the file and fails if the
policy is ever changed back.

What was actually measured, kept because it is real evidence:
`@pdf-lib/fontkit@1.1.1` has a known CJK subsetting bug, and `subset: true`
**damages visible Japanese glyphs** — 1.8% of pixels differ from an unsubsetted
embed, with a maximum channel delta of 765, i.e. glyphs dropping out entirely. It
leaves the cmap and advance widths intact, so on the earlier spike the invisible
layer's text still round-tripped through extraction, and the embedded font fell
from ~1 MB to ~4.6 KB.

That historical result stands, but it is **not** the basis for M1. M1 is
correctness-first: it embeds with `subset: false` rather than relying on a known
font-corruption bug staying harmless because nothing draws the glyphs. The cost
is accepted and visible in the artifacts — `scanned-ja-en.pdf` output grows from
32,520 to 1,097,296 bytes, because the full 1.68 MB font is embedded.

Reducing that size is a legitimate future task (pre-subsetting the font
ourselves, or the `pdf-fontkit` fork), but it is not done by flipping this flag.

**Coordinates go through `viewport.convertToPdfPoint`, not arithmetic.** It is
the exact inverse of the render transform and stays correct under page rotation
and a non-zero-origin MediaBox, where `pageHeight - y / scale` does not.
