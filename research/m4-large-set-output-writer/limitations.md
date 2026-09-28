# Limitations and instrument defects

Kept in the order they were found. Nothing here is rewritten after the fact.

## Scope limits of the evidence

1. **Rendering is Node, not the browser.** Stage 1 renders with pdf.js (legacy
   build) on `@napi-rs/canvas` (Skia). The comparison functions are production's
   own, unmodified, but anti-aliasing at stroke edges can differ from Chrome's
   canvas, so ink masks — and therefore the exact compressed sizes — are
   representative of, not identical to, what the app would produce from the same
   PDFs. The *architecture* conclusions do not depend on this: the composite is
   a 9-state function of the masks for any input (engine.ts:163-204), and the
   worst case is covered by the Deflate bound, not by a measured ratio.
2. **Memory is Node RSS, MeasuredOnly.** Writer-own peaks come from a sampler
   thread polling RSS every 2 ms over the write window (`write.mjs --sink-only`).
   Browser renderer memory, Blob storage (which lives in the browser process)
   and GC timing differ. The proposed preflight therefore uses arithmetic bounds
   (`model.mjs`), never these measurements.
3. **The synthetic corpus is not a real drawing set.** Chrome's `page.pdf`
   rounds the sheet to 2385.12 × 1684.08 pt (+0.05 % over ISO A1; A1 within
   ±2 mm). Real sheets can carry scanned underlays or hatch-heavy areas that
   compress less; that raises actual bytes toward — never above — the per-page
   bound (≈ 0.5 byte/px + Deflate overhead).
4. **Acrobat was not available** and no real document was used, so how Acrobat
   reached ~2 MB is not reproduced here. `harness/inspect-images.mjs` answers it
   locally on the real file; until someone runs it, the report treats Acrobat's
   method as unknown.
5. **JPEG was encoded by Skia (`@napi-rs/canvas`)**, not by a browser's
   `canvas.toBlob('image/jpeg')`; subsampling defaults may differ. The metric
   ("change recall": composite change pixels whose decoded colour classifies to
   the same palette class) is a proxy for "a reviewer can still see this mark".
   The conclusion rests on the size of the gap (recall 0–79 %, and larger files
   than lossless), not on its exact value.
6. **Chrome PDF viewer check is load + screenshot**, not a pixel oracle. The
   pixel oracle is pdf.js (`verify.mjs`). Acrobat was not run; the candidate uses
   only PDF 1.2/1.3-era constructs (Image XObject, `/Indexed /DeviceRGB`,
   `/FlateDecode`, `/Predictor 15`, Type1 Helvetica).
7. **Title text.** The prototype writes the verdict line in Helvetica/WinAnsi and
   replaces non-Latin-1 characters with `?`. Today's jsPDF path has the same
   standard-font limitation (artifacts.ts:112-120 notes jsPDF has no Japanese
   glyphs); how today's path renders a Japanese file name in that line was not
   measured.
8. **Not measured:** the Change Report (only reasoned about); the preview (not
   touched by the proposal); tolerance other than 0 and 0.15 mm (the latter at
   150 dpi only); more than two members; the current writer at 450 dpi beyond
   one page (it needs ~2.7 GB for one).
9. **`COMPRESSOR_STATE` = 4 MiB** in `model.mjs` is a conservative constant for
   window, hash tables and band buffers; CompressionStream's internal state in a
   browser is not observable from script.

## Instrument defects found (and what was done)

1. Chrome ignored named `@page` rules in `page.pdf()` and printed Letter pages →
   one print per sheet at an explicit size, merged with pdf-lib.
2. Node resolves `jspdf` to its CJS node build, whose default export has no
   `version`, so production's container check (artifacts.ts:164-170) refused it
   → the bundle aliases `jspdf` to `dist/jspdf.es.min.js`, the build the browser
   actually loads.
3. The first exploratory matrix (`r1`) was still spawning cells while
   `write.mjs` was edited → discarded; nothing from it is cited.
4. `process.resourceUsage().maxRSS` is a process high-water mark, so file-read
   transients hid the writer's own peak → `--sink-only` preloads inputs and a
   worker thread samples RSS during the write window only.
5. `chrome-check.mjs` built its CompressionStream test buffer with a fractional
   length → `Math.ceil`.
6. A shell wait loop keyed on `ps` does not see Windows node processes → waits
   key on the evidence file instead.
7. `inspect-images.mjs` attributes an image to every page whose Resources
   reference it; jsPDF shares one Resources dictionary, so for jsPDF files the
   page list is a superset → stated in the tool's output.
8. The first dedicated gate run (`g0`) passed before the `idx4m-cs-up` candidate
   existed; adding it changed the source, so the first run was repeated (`g0b`)
   before any document was synced.
9. `npx eslint .` walks the git-ignored `out/` and reported 13 findings, all in
   the generated bundle (`out/prod.mjs`): eslint directives vendored inside
   jsPDF's dependencies naming plugins this repo does not load. The bundle is
   now built with `--minify-whitespace` (comments dropped, identifiers kept);
   lint delta against the baseline is 0 and tracked research files have 0
   findings. This changed only the gate's bundle step after `g0b`; the final
   validation runs are from the committed head.
