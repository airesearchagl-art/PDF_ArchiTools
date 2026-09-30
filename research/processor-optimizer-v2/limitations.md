# Limitations and instrument defects

In the order they were found. Nothing is rewritten after the fact.

## Scope of the evidence

1. **Node, not the browser.** The optimizer prototype, pdf-lib, pako, zlib and
   pdf.js (legacy build) run in Node 24. The production Processor modules are
   the real ones (esbuild bundle of `src/utils/processor` and
   `src/utils/comparator`, unmodified). Browser heap behaviour, Blob storage and
   GC timing differ; all RSS figures are **MeasuredOnly**. The admission policy
   proposed in the report rests on arithmetic, not on these measurements.
2. **Synthetic corpus only.** No customer or real-project PDF was used. The
   primary fixture (f01) is built the way the pre-v2 Comparator wrote its file
   (one raw DeviceRGB image per page + a verdict line), from the production
   Comparator engine's own composite; it is 261,547,235 bytes against the
   261,549,245 bytes the old writer produced in PR #28 for the same drawings.
   Real third-party PDFs will contain constructs this corpus does not
   (JBIG2/CCITT scans, Separation/DeviceN, Lab, 16-bit ICC, inline images,
   OCGs, Type3 fonts, broken xrefs, incremental updates).
3. **The Acrobat pair is unresolved.** The Human will provide the real
   before/after files later. `harness/inspect-images.mjs` answers the question
   locally, read-only, without the files entering the repository.
4. **The lossy candidates use Skia's JPEG encoder** (@napi-rs/canvas), not a
   browser's `canvas.toBlob`; chroma subsampling and quantisation tables may
   differ. The drawing metrics (ink recall, colour-mark recall, false ink) are
   proxies for "a reviewer can still read this", not a substitute for review.
5. **Compressed sizes depend on the deflate implementation.** node:zlib level 9
   and pako level 9 are the same algorithm with different sizes by a few
   percent; the owned bounded DEFLATE (fixed Huffman only) is markedly weaker
   on photographic and anti-aliased content. The recommendation does not rely
   on any particular ratio: a replacement is kept only when it is smaller.
6. **pdf-lib's parse cost** (stream copies + per-object overhead) was measured
   on this corpus only. The per-object constant in `model.mjs` is twice the
   largest observed, a conservative placeholder until measured on real files.
7. **Not measured:** encrypted PDFs (refused today and still refused), applied
   signatures (refused, unchanged), XFA, very large object counts (thousands of
   pages), images inside annotation appearance streams, inline images, Type3
   glyph images, JBIG2/CCITT/JPX decoding, a batch/ZIP run of optimize.

## Instrument defects found (and what was done)

1. The first corpus run stopped at f07 on a string Helvetica cannot encode
   (my fixture text); the manifest written at the end of that run was lost, so
   f01-f06 had no independent hashes in the first exploratory matrix. The
   corpus was regenerated (byte-identical) and the manifest completed.
2. Importing the Processor sets pdf.js's worker to the browser path; in Node the
   fake worker then failed. The harness points pdf.js at the legacy worker file
   after importing production.
3. pdf.js puts per-document object ids into operator arguments (`g_d0_f1`,
   `img_p0_1`, and `g_d2_img_…` for images it shares across pages), so two
   loads of identical content never produced identical operator signatures.
   They are normalised before comparison. (The first normalisation lost its
   backslashes in a shell heredoc and matched nothing; rewritten with the Edit
   tool.)
4. **The verifier's text and vector checks were vacuous on some pages.** pdf.js
   was opened with `stopAtErrors` and no `standardFontDataUrl`; wherever a page
   referenced a font pdf.js could not load, the content stream stopped, so
   text and later operators were absent from *both* sides and compared equal.
   Found by `verify-selftest.mjs` (a text change went undetected). Fixed by
   passing the installed standard-font data and by requiring each fixture's
   known text (`expectText` in the manifest) to be read from the source before
   any comparison counts. Every result from the exploratory matrix `m0`
   predates this fix and is not cited for text/vector preservation.
5. The self-test then showed the fixture itself was malformed: f10 wrote
   `/F1` into its content stream, but pdf-lib's `newFontDictionary` returns a
   unique key, so the font was unresolvable. Corpus fixed to use the returned
   key.
6. `evidence/matrix-m0.jsonl` and the first `model.json` are exploratory and
   are not committed as evidence; the committed evidence comes from gate runs
   on the committed head.
