# Limitations and instrument defects

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**

What this research did not establish, and every place its own instruments were found to be wrong. Both lists
are here so that neither has to be discovered by a reviewer.

## 1. What was not measured or not examined

### Browser and machine

| Limitation | Consequence |
|---|---|
| **One browser.** Every browser figure is Chrome for Testing 143, headless. No Firefox, Safari, Edge or mobile browser was run. *(Review advisory: sufficient for this Research Gate; Production M7-P1 and M7-P4 must each define their target browsers and a smoke test on them.)* | Recommendation B's facts — that `digest()` blocks its calling thread, that it is no faster than the JS hash, that a BYOB reader with `min` works — are facts about this build. The design does not depend on them being universal: streaming is correct everywhere `Blob.slice` exists, and the BYOB path is feature-detected with the slice path as its fallback. |
| **One machine**: Core Ultra 9 285K, 24 logical CPUs, 63 GiB RAM (about 7 GiB free during the runs), Windows 11. | Absolute times are optimistic for a typical office machine. The ratios between methods are what the recommendation rests on. |
| **Headless.** A visible tab competing for memory, a throttled background tab, or a low-memory device was not tested. | The peak-memory comparison (≈ 87 MiB against ≈ 570 MiB at 250 MiB) should hold in direction; its margins were not tested under pressure. |
| **Warm file cache.** The synthetic files had just been written when they were read. | Read times are a best case. A cold disk, a network share or a synced folder was not measured. |
| **No single file above 250 MiB.** | Not required by the Task Packet, and above the candidate per-Source cap (256 MiB). |
| **Why `crypto.subtle.digest()` blocked its calling thread, and why it ran at about a sixth of OpenSSL's speed on the same CPU, was not investigated.** | The observation is reported as an observation. |
| Memory is the renderer's peak working set. The browser process's own peak is in the result files; the two are not summed. | Peaks of different processes need not coincide. |

### What was run and what was not

| Limitation | Consequence |
|---|---|
| **No PDF was opened anywhere in this research.** The fingerprint benchmark hashes random bytes. The reuse-parity tests call the engines' *pure* functions. `extractRegister` was **not** driven end to end through the adapter in a browser. | The "adapter only" verdict for extraction rests on a read of its signature and on the existing headless harness, plus pure-function parity — not on a run. It should be the first thing M7-P2 proves. |
| **Extraction and OCR cost at scale was not measured.** | §10 of the main document says so: the portable state is shown *not* to be the bottleneck; what the bottleneck costs is the existing engines' and was not re-measured. |
| **Nothing was rendered** except a plain-DOM table as a lower bound. | The need for list virtualisation is argued from a lower bound, not from a React measurement. |
| **Synthetic Projects.** Findings per sheet, comment lengths and history depth are the generator's, not a real review's. | The size per sheet (≈ 1.8–2.2 kB) and the limits derived from it could be off for a heavily annotated Project. The 62.5 MiB "largest accepted" case is there to bound that. |
| **Real title-block text was not sampled.** | The string-length limits are placeholders (Unresolved U-6). |
| **No fuzzing.** The hostile inputs are a list a person wrote. | The scan and the interpreter have been shown specific attacks, not a search. *(Review advisory: the scanner and the interpreter are security-sensitive; fuzz, property-based and differential testing of the Production versions is required before M7-P4 ships.)* |
| **The differential check against ajv covers 26 mutations of one document**, not the keyword space. | It shows agreement on the constructs the schema uses, where it was tried. |
| **Migration was exercised with a synthetic predecessor.** There is no real version 0. | The mechanism is tested; no real migration is. |
| **`/UserUnit`** was not examined in the register path. | A page with a user unit other than 1 may be measured wrongly; the Comparator refuses such pages. |
| **Whether M6's Load Boundary must gate M7's PDF.js reads** was not examined (Unresolved U-7). | Open. |
| **The scale matrix ran on a page thread**, not in a Worker. | Whether import should move to a Worker is argued from that number, not from a Worker measurement. |
| **Node heap figures are not browser figures.** The same four million empty objects retained ≈ 256 MiB in Node and ≈ 104 MiB in Chrome. | Each is reported under its own heading and they are never combined. |
| **Tamper-evidence was not designed** (Unresolved U-14). | A forged Human decision cannot be told from a real one. |

### The declared Drawing Register (added after RF-33-02)

| Limitation | Consequence |
|---|---|
| **No real drawing list was read.** The table engine was run on a *synthetic* list page — tokens and ruling lines built by the test — not on a PDF. `analysePageGeometry`, which needs a PDF.js document, was not run. | That the engine turns a real 図面一覧 into a usable grid is not shown here. Real lists have merged cells, wrapped titles, repeated headings on continuation pages and sub-headings between groups; the engine never infers merged cells and has no notion of a heading row. It should be the first thing proved when the register is implemented. |
| The engine was loaded in Node with `pdfjs-dist` resolved to PDF.js's `legacy` build. | The pure reconstruction is the Production code; the PDF.js build beside it is not the one the app bundles. Nothing in the path that was run uses PDF.js. |
| **A scanned list page cannot be read** (the engine is native-text only). | A register is declared from a scanned list by typing it. For a long list that is real work, and OCR of a list page is not designed. |
| **Correspondence is the exact drawing number.** | A list typed in full-width against title blocks in half-width produces a finding on each side for every drawing. The findings name the near spelling, but the volume could be large (Unresolved U-3 (a)). |
| QA09 compares numbers only. | A row's title, revision and date are stored and not compared with the Sheet's (Unresolved U-2). |
| A register must be on a page of a Source in the set. | A list supplied separately (a spreadsheet, another PDF not in the set) has nowhere to be declared from (Unresolved U-3 (b)). |
| The two register limits (64 references, 1 000 rows each) have no measurement behind them. | Placeholders (Unresolved U-6). |
| How a person maps columns and skips heading rows is described, not designed. | It is workspace design for M7-P3. |

## 2. Instrument defects found

In the order they were found. Each was a case of the research's own tooling or first design being wrong;
none is hidden by the final results.

1. **Escapes decoded while files were being written.** The escape for U+2028 (LINE SEPARATOR) and several other escapes in regular
   expressions were turned into the literal characters by the authoring tool. A literal line separator ends a
   regular-expression literal, so `prototype/model-ops.mjs` failed to load (`SyntaxError`) on its first
   import. The files were re-escaped; the tests now build such characters from code points
   (`tests/helpers.mjs`, `CHAR`) so no test depends on how its source was written.
2. **Three wrong predictions in the first import tests.** (a) UTF-16 input is valid UTF-8 (every other byte
   NUL) and is refused by the scan as `INVALID_JSON`, not as `NOT_AN_OBJECT`. (b) Injecting a small
   `maxSheets` also bounds the two coverage counters tied to it, so the refusal lists three problems, not
   one — the over-long array itself is still reported once and not walked. (c) A timestamp with a
   `+09:00` offset is refused on length before pattern. The tests were corrected to the behaviour; the
   behaviour was not changed to fit the tests.
3. **Run records grew the file.** The first design listed every Source's fingerprint on every Analysis Run:
   about 650 KB per run with one PDF per sheet at 5000 sheets (5000 × ≈ 130 bytes). Replaced by one
   `manifestDigest`. Separately, a QA run was recorded even when it changed nothing, so re-evaluating after
   every edit grew the file; a run is now kept only if a finding refers to it
   (`tests/roundtrip.test.mjs`).
4. **`node --test <directory>` ran nothing useful** on this Node. The documented command uses a glob:
   `node --test "research/m7-drawing-set-manager/tests/*.test.mjs"`.
5. **The paper-size mirror was wrong at the boundary.** The prototype's copy of `detectPaperSize` compared
   in millimetres; Production compares in points. `tests/reuse-parity.test.mjs` failed on its first run:
   for a page exactly 5 mm short of A0 on both edges the copy said `OTHER` and Production said `A0`. The
   copy now uses the same arithmetic, and the recommendation is to have no copy.
6. **The sort benchmark sorted nearly-sorted input.** The synthetic rows arrive almost in order; the first
   run reported 0.7 ms for 5000 rows. The input is now shuffled (3–9 ms).
7. **A wide object went through the scan.** In the first run of `bench-hostile.mjs`, an object with
   2 000 000 distinct keys (23.7 MiB) stayed under every limit: the pipeline reached `JSON.parse`, took
   **1 960.6 ms** and peaked at **618.1 MiB** before the schema refused it. `maxObjectKeys` was added;
   the same input is now refused by the scan in about 10 ms without being parsed.
8. **A meaningless heartbeat.** The browser scale run wrapped the whole synchronous matrix in the
   page-thread heartbeat and reported an 18-second "gap" — the length of the matrix. Removed; the question
   is asked per operation instead (`importOnMainThread`).
9. **A fixture tripped its own check.** `invalid/comment-too-long.json` was 4 001 repetitions of one
   letter, which the "no long encoded run" check of `tests/fixtures.test.mjs` correctly refused to have in
   a committed fixture. The fixture's text was changed; the check was not.
10. **A probe did not say why it failed.** The insecure-context run first recorded only that the Worker's
    one-shot method did not produce a digest. It now records the Worker's reply (`failed`).
11. **Quoting between Node and PowerShell.** The operating-system memory query is passed with
    `-EncodedCommand` so that no quoting rule sits between the benchmark and the query.
12. **The prose drifted from the evidence.** The documents were written with figures rounded from an
    earlier run. The first evidence collection (from source head `1425e0c`) passed every gate and still left
    several of those figures outside what their wording claimed for the run being committed -- the
    page-thread block written as "≈ 780 ms" measured 823 ms, the two one-shot timings had swapped order, the
    20 000-sheet open written as "≈ 390 ms" measured 451 ms. None changed a conclusion; all were wrong as
    written. `benchmark/check-claims.mjs` was added, the figures were restated, and the evidence was collected
    again from the corrected head. The checker was shown an edited sentence and a moved measurement and
    failed on both.
13. **And then the checker caught one more.** The collection from the corrected head (`7c4f665`) passed
    everything except one claim of 179: sorting 20 000 rows, written "≈ 33 ms", measured 42.1 ms. Across four
    runs that figure had been 30.7, 34.3, 35.3 and 42.1 ms -- three repeats of a short operation on the page
    thread -- so "≈ 33 ms" was more precise than the measurement. The same review found five other
    figures sitting at the edge of what their wording allowed (a cancellation latency of exactly 35 ms against
    "≈ 25 ms", which is a point picked from what is really "anywhere up to one chunk"). Those are now stated
    as the ranges or bounds they are, and the evidence was collected a third time.

14. **Two things the research got wrong, found by Independent Architecture Review of `4139133`.** Not
    defects of an instrument: defects of the proposal, recorded in the same list because they were just as
    invisible to the tests that existed.
    - **RF-33-01.** `FALSE_POSITIVE` on a QA02 finding lifted the metadata-confirmation requirement. The
      suite passed with it, because a test asserted that behaviour. Only `INTENTIONAL` lifts it now.
    - **RF-33-02.** QA09 had been given a meaning that needed no new input — M7's Sheet list against the PDF
      page inventory — and the intended one (a Human-declared Drawing Register against the actual Sheets)
      had been filed as unresolved. The page-inventory check is kept, under QA10.
15. **A wrong prediction about the table engine.** The first declared-register test expected a synthetic
    list with blank cells to come back `GRID_CONFIDENT`; the engine says `GRID_NEEDS_REVIEW`. The test was
    corrected to the engine's behaviour, which is the more useful fact: a real list is routinely "needs
    review" structurally, and the adapter passes both statuses on to a person.
16. **The mutation probe caught its own gaps.** After the repair, one probe could not be applied (its
    anchor had been edited away) and one was *missed*: removing the rule that a live register cannot hang
    off a retired Source failed no test. The probe script counts both as failures. The anchor was fixed and
    a test added (`tests/declared-register.test.mjs`, "a file whose declared register does not hold
    together…").

17. **The evidence collector refused its own output.** Its first step requires the source to be exactly a
    commit, ignoring the two output directories. It read `git status --porcelain` through a helper that
    trims the whole output — which removes the leading space of the first line (` M path`), so that one
    path lost its first character and no longer matched an output directory. The collection from
    `76ca72b` stopped there, before measuring anything: it failed closed. Earlier collections had not
    shown it because their first status line did not begin with a space (the output files were untracked,
    or unchanged). The status is now read untrimmed, and the collection was run again from the commit
    that fixes it.

18. **A collection in which a benchmark did not finish, and what the collector then got wrong.** In the
    collection from `28ef6eb`, the second pass of `bench-browser.mjs` ended with Windows status
    `0xC0000409` (exit 3221226505) and nothing on stderr, during the fingerprint cases, before it had
    written a result. The collector recorded the exit and failed, as it should. Run on its own from the
    same commit, the same script completed. Looked at some twenty minutes later, the machine had about
    6 GiB of commit headroom, other applications holding the rest; **the cause was not established**, and
    no claim is made that it was memory. Two faults of the collector showed: it kept none of the benchmark's output, so
    there was nothing to diagnose from; and because the first pass's browser results were still on
    disk, the "identical across the two passes" line was computed for them against themselves — true,
    and empty. The collector now removes the last gate record when it starts and the result files before
    each pass, prints the output of a benchmark that does not finish, and stops there, writing nothing.
    It does not retry. The evidence committed is from a later, whole collection; `evidence/gates.md`
    records every exit of it.

19. **After the repair: a collection lost with its session, an overstatement, and one more claim.**
    - The collection from `f72f0c3` stopped in the second pass of `bench-browser.mjs` (after the
      fingerprint cases, before the probes) when the session running it ended. No process was left and no
      output was kept, so nothing is concluded from it.
    - A read-only check of the documents against the repair found `reuse-audit.md` and
      `data-model.proposed.md` saying the table engine was "run for real" beside a chain that begins with
      `analysePageGeometry`, which was not run (§1 above). Both now name the part that was:
      `reconstructSelection`, on a synthetic list page.
    - The collection from `ff1b9e9` passed everything except one claim of 191: reading 250 MiB, written
      "0.1–0.25 s", measured 352.8 ms in the first of three repeats (126.4 and 134.2 ms in the other two;
      169.2, 162.8 and 146.1 ms in the collection from `ecc38e7`). A range drawn from earlier runs was
      narrower than the measurement. What the sentence is for -- the read leaves the thread free and the
      digest does not -- is unchanged. It is now stated as the bound it is, "under 0.5 s", and the evidence
      was collected again.

## 3. What a second run may and may not change

Because the prose rounds and a second run moves, `benchmark/check-claims.mjs` holds every figure the
documents quote from a benchmark to the result files committed beside them: the quoted words must still be in
the document, and the measured value must be within what they allow. `collect-evidence.mjs` runs it. It exists
because the first evidence run did exactly that: several figures written after an earlier run (the page-thread
block "≈ 780 ms" against a measured 823 ms, among others) had drifted outside what their wording claimed.

`benchmark/results/structural.json` holds the fields that must be identical on every run — file sizes,
JSON value counts, finding counts, refusal stages and codes, which digests agreed, what each context
exposes — and the check that the Node and browser scale runs produced the same bytes. Times, MiB per second
and memory are *measured-only*: they are reported, rounded in the prose, and never compared for equality.

## 4. Platform behaviour observed

Pushing the research branch to its pull request caused the repository's Vercel integration to build a
**Preview** automatically (GitHub records a deployment by `vercel[bot]`, environment `Preview`, for the
reviewed head `4139133`). That is the platform's behaviour for a pushed branch with a pull request; it is
not a Production deployment and nothing was deployed by hand. Separately, a local build of this branch is
byte-identical to a local build of the base commit (`evidence/gates.md`): the research directory is not
part of the app. It is recorded here so that the Preview is not mistaken for a release, and so that
nobody looks for one.
