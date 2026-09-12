# Limitations — what this sub-spike does not show

## Of the evidence

- **Local research gate, not Core CI.** Every number here comes from
  `scripts/research-gate.mjs`, run locally on the spike branch and committed as
  `evidence.json`, whose `productionBase`, `researchHeadAtRun`,
  `researchBranchAtRun`, `workingTreeDirty` and `coreCiRunsThisGate` say where
  it ran. Core CI at the exact head runs the existing backbone and does **not**
  run this gate.
- **Synthetic corpus only.** The contents are generated: a vector drawing, a
  drawing with dimension strings, hairline hatching, one-pixel linework on
  grain, a greyscale scan, a colour scan, photographic gradients. Real CAD and
  scanner output carries ICC colour spaces, shadings, patterns, Type 3 fonts,
  soft masks and JBIG2/CCITT/JPX imagery that none of this reproduces. How the
  candidates behave on real drawings is **unmeasured**.
- **Memory is modelled, not weighed.** The browser heap is not instrumented.
  What the gate validates is the *checkable* half: the canvas dimensions, the
  data URL length, the stream byte counts and the output size, each against the
  arithmetic that predicted it. The terms that are conservative upper bounds
  (PDF.js scratch, the publish copy, the archive) are not observed in the heap,
  and a term being exact in the model is a statement about the code, not a
  measurement of V8.
- **One machine, one browser build.** The canvas-allocation probe and every
  timing come from a single headless Chrome on one machine. The raster ceiling
  stays a *policy* below what that machine refused, paired with a runtime
  probe; it is not a portable measurement of every supported browser.
- **The production encoder is characterised, never bounded.** Its sizes here
  are observations of one encoder on one corpus. They remain performance
  evidence; the only fail-closed statement about it is the JPEG format's own
  20 B/px, and nothing in this spike bounds its internal working memory. That
  is the finding, not a gap to be closed by measuring harder.
- **DEFLATE is bounded by its format, not by pako.** `flateStream` uses the
  pako pinned inside pdf-lib. The bound used here is DEFLATE's stored-block
  worst case, which no conforming encoder can exceed; the *typical* sizes are
  pako's and would change with another deflater.

## Of the candidates

- **E3 is a prototype, not an implementation.** It writes an image XObject and
  draws it over the page. It does not address colour management (a `DeviceGray`
  or `DeviceRGB` stream carries no ICC profile), `Decode` arrays, 1-bit or
  16-bit output, or anything the page needs beyond the image itself.
- **E3's exactness is about the stream, not the file.** The sample count is
  exact and known before rendering; the finished PDF also carries its object
  structure, and `MAX_OUTPUT_BYTES` is enforced on the artifact that was
  actually produced.
- **E2 was measured through pdf-lib's own PNG path**, which is the only way the
  Processor could use it without writing an embedder. A different embedder
  (jsPDF's, or one this repository wrote) would have a different profile; M4
  uses jsPDF and does not pay pdf-lib's decode.
- **E4 was rejected on a fact, not measured.** No pinned dependency contains a
  JPEG encoder. Whether a bounded JPEG encoder could be written or adopted is a
  dependency decision for a Human Gate, and it is not answered here.
- **Quality is judged from luminance** at a fixed resolution: ink kept, ink
  invented, PSNR. That is a proxy for legibility, not a reading of a drawing by
  someone who knows what it is for.
- **No cancellation, ownership or batch behaviour is exercised.** The batch
  numbers are the adopted B2 policy priced, not a batch run.

## Of the scope

- **No production code changed.** `src/` is untouched; the M4 PNG encoder was
  imported and read, never modified.
- **No dependency was added or removed.**
- The sub-spike answers H8 only. H2b/O3 stays deferred, and nothing here
  reopens a decision the Human Adoption Gate closed.
