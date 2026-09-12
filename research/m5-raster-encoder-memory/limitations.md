# Limitations — what this sub-spike does not show

## Of the evidence

- **Local research gate, not Core CI.** Every number here comes from
  `scripts/research-gate.mjs`, run locally on the spike branch and committed as
  `evidence.json`, which records `productionBase`, `testedResearchHead`,
  `researchBranchAtRun`, `workingTreeDirty` and `coreCiRunsThisGate`. Core CI at
  the exact head runs the existing backbone and does **not** run this gate.
- **Dirtiness is scoped to the research package, and counts untracked files.**
  The first round's check used `--untracked-files=no`, which called the tree
  clean while the entire uncommitted spike sat in it. It now runs
  `git status --porcelain -- research/m5-raster-encoder-memory`, so a new,
  never-committed prototype makes the run dirty and the gate says so. Untracked
  files *elsewhere* in the repository are outside that scope by design.
  **One file is excluded, deliberately and visibly: `evidence.json` itself.**
  The gate writes it at the end of every run and it is committed afterwards as
  an evidence-only child commit, so counting it would make the second of two
  consecutive runs dirty by construction and no run could ever be clean. The
  exclusion covers the gate's own output and nothing else — every prototype,
  script, fixture generator and document still counts.
- **Synthetic corpus only.** A vector drawing, a drawing with dimension
  strings, hairline hatching, one-pixel linework on grain, a greyscale scan, a
  colour scan, photographic gradients. Real CAD and scanner output carries ICC
  colour spaces, shadings, patterns, Type 3 fonts, soft masks and
  JBIG2/CCITT/JPX imagery that none of this reproduces.
- **Memory is modelled from source, not weighed in the heap.** What the gate
  *verifies* is the checkable half: the canvas dimensions, the conversion live
  set (measured in the prototype and predicted exactly by the model), the bytes
  the PDF object actually carries (`PDFRawStream.getContentsSize()`), and the
  archive a real JSZip run produces. The conservative terms — PDF.js scratch,
  the browser's Blob copy — are not observed in the heap. A term being EXACT is
  a statement about pinned code, not a measurement of V8.
- **One machine, one browser build.** The canvas-allocation probe and every
  timing come from a single headless Chrome. The raster ceiling stays a
  *policy* below what that machine refused, paired with a runtime probe.
- **The production encoder is characterised, never bounded.** Its sizes are
  observations of one encoder on one corpus, and remain performance evidence.
  The only fail-closed statement about it is the JPEG format's own 20 B/px, and
  nothing bounds its internal working memory.

## Of the models

- **The DEFLATE bound is pako's, not the format's.** It is
  `n + 5·⌈n/16384⌉ + 6`, derived from pako 1.0.11's own block lifecycle —
  `_tr_flush_block` falls back to a stored block whenever `stored_len + 4 ≤
  opt_lenb` (trees.js:1073-1131), and a block is flushed at the latest when
  `lit_bufsize` = 16,384 literals have accumulated. A different deflater, or a
  different `memLevel`, would need the bound re-derived. The *typical* sizes are
  pako's too and would change with any other implementation.
- **pako's retained output is larger than its output.** `shrinkBuf` returns
  `buf.subarray(0, size)` without copying (common.js:34-38), so every
  accumulated chunk pins a full 16 KiB buffer; `flattenChunks` then allocates
  the result while all of them are still live (common.js:54-72). The model
  prices that, but it is a property of this pako, not of DEFLATE.
- **The V8 array factor is used only to show engine dependence.** E4's
  `byteout` is priced at 8 bytes per element to demonstrate that the term is the
  engine's; that number is not a bound and is never used as one. Any term priced
  with it is UNKNOWN by construction.
- **E3's exactness is about the stream, not the file.** The sample count is
  exact and known before rendering; the finished PDF also carries its object
  structure, and `MAX_OUTPUT_BYTES` is enforced on the artifact produced.
- **E3 is a prototype.** It writes an image XObject and draws it over the page.
  It does not address colour management (a `DeviceGray`/`DeviceRGB` stream
  carries no ICC profile), `Decode` arrays, or 1- and 16-bit output.
- **E2 was measured through pdf-lib's own PNG path**, the only way the Processor
  could use it without writing an embedder. M4 uses jsPDF and does not pay
  pdf-lib's decode.
- **E4 was investigated, not dismissed.** jsPDF 3.0.4 does bundle a
  `JPEGEncoder`. It is inadmissible here on two independent grounds — no
  supported path reaches it with raw pixels, and its output representation is an
  ordinary JS array — and *not* because no encoder exists. Whether a bounded
  JPEG encoder could be adopted remains a dependency decision for a Human Gate.
- **The batch model assumes JSZip's defaults.** `compression: "STORE"` and
  `streamFiles: false` (object.js:320-321). Turning compression on would put
  pako in the archive path too, and the model would need its terms.
- **Quality is judged from luminance** at a fixed resolution: ink kept, ink
  invented, PSNR. That is a proxy for legibility, not a reading of a drawing by
  someone who knows what it is for.
- **No cancellation, ownership or batch *behaviour* is exercised.** The batch
  numbers price the adopted B2 policy; one real archive is built to check the
  STORE assumption, not to test the policy.

## Of the scope

- **No production code changed.** `src/` is untouched; the M4 PNG encoder was
  imported and read, never modified.
- **No dependency was added or removed.**
- The sub-spike answers H8 only. H2b/O3 stays deferred, and nothing here
  reopens a decision the Human Adoption Gate closed.
