# Limitations and instrument defects

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**

What this research did not establish, and every place its own instruments were found to be wrong. Both lists
are here so that neither has to be discovered by a reviewer.

## 1. What was not measured or not examined

### Browser and machine

| Limitation | Consequence |
|---|---|
| **One browser.** Every browser figure is Chrome for Testing 143, headless. No Firefox, Safari, Edge or mobile browser was run. | Recommendation B's facts — that `digest()` blocks its calling thread, that it is no faster than the JS hash, that a BYOB reader with `min` works — are facts about this build. The design does not depend on them being universal: streaming is correct everywhere `Blob.slice` exists, and the BYOB path is feature-detected with the slice path as its fallback. |
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
| **No fuzzing.** The hostile inputs are a list a person wrote. | The scan and the interpreter have been shown specific attacks, not a search. A fuzzer over the import pipeline belongs in the Production implementation. |
| **The differential check against ajv covers 26 mutations of one document**, not the keyword space. | It shows agreement on the constructs the schema uses, where it was tried. |
| **Migration was exercised with a synthetic predecessor.** There is no real version 0. | The mechanism is tested; no real migration is. |
| **`/UserUnit`** was not examined in the register path. | A page with a user unit other than 1 may be measured wrongly; the Comparator refuses such pages. |
| **Whether M6's Load Boundary must gate M7's PDF.js reads** was not examined (Unresolved U-7). | Open. |
| **The scale matrix ran on a page thread**, not in a Worker. | Whether import should move to a Worker is argued from that number, not from a Worker measurement. |
| **Node heap figures are not browser figures.** The same four million empty objects retained ≈ 256 MiB in Node and ≈ 104 MiB in Chrome. | Each is reported under its own heading and they are never combined. |
| **Tamper-evidence was not designed** (Unresolved U-14). | A forged Human decision cannot be told from a real one. |

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
   run reported 0.7 ms for 5000 rows. The input is now shuffled (≈ 5 ms).
7. **A wide object went through the scan.** In the first run of `bench-hostile.mjs`, an object with
   2 000 000 distinct keys (23.7 MiB) stayed under every limit: the pipeline reached `JSON.parse`, took
   **1 960.6 ms** and peaked at **618.1 MiB** before the schema refused it. `maxObjectKeys` was added;
   the same input is now refused by the scan in ≈ 9 ms without being parsed.
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

## 3. What a second run may and may not change

`benchmark/results/structural.json` holds the fields that must be identical on every run — file sizes,
JSON value counts, finding counts, refusal stages and codes, which digests agreed, what each context
exposes — and the check that the Node and browser scale runs produced the same bytes. Times, MiB per second
and memory are *measured-only*: they are reported, rounded in the prose, and never compared for equality.
