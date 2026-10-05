# M7 Drawing Set Manager — Architecture Research

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**
>
> This directory is evidence for an architecture decision that has **not** been made. It is not part of the
> app, is not built by Vite, is not imported by anything under `src/`, and adds no feature and no UI. The
> schema here is a *proposal*, the limits are *candidates*, the diagrams are *proposed projections*, and the
> prototype is a research instrument. A branch carrying this directory is not a base for Production work.

| | |
|---|---|
| Task | M7 Drawing Set Manager — Architecture Research / Spike Task Packet v1 |
| Product Definition | M7 Product Definition v1 — HUMAN ADOPTED 2026-10-05 |
| App baseline | `airesearchagl-art/PDF_ArchiTools@1b5f9eda59a583a6b8fe7e07013ba38fc3053d1f` |
| Changes outside this directory | none |
| Data used | synthetic only — no customer PDF, no real project, no real file name, no path, no secret |
| Revision | Focused repair after Independent Architecture Review of `4139133` (RF-33-01, RF-33-02) — `architecture-research.md` §15 |
| Next step | Independent Focused Re-review → Human Architecture Adoption. Nothing here proceeds without both. |

## Read in this order

| Document | What it is |
|---|---|
| **`architecture-research.md`** | The findings for R1–R9, the security and privacy review, the **Architecture Recommendation (A–K)**, the proposed implementation split, and the required unresolved items. Start here. |
| `rebinding-state-machine.md` | R2: the binding states, the algorithm, the seven cases, the stale matrix. |
| `data-model.proposed.md` | R5: proposed conceptual and logical models, the optional declared Drawing Register (§2A), the contract table, lifecycles, and the Data Model Gate re-evaluation with its timing. |
| `qa-rule-matrix.md` | R8: the ten QA items as deterministic facts or candidate questions; the Final-readiness gate. |
| `reuse-audit.md` | R6: every existing engine considered, and what M7 can reach through an adapter. |
| `title-block-profile.md` | R7: profile representation, assignment, stale scope. |
| `portable-project.schema.proposed.json` | R3: the proposed schema. **Proposed, non-canonical.** |
| `benchmark/results/SUMMARY.md` | Every measurement, generated from the result files. |
| `benchmark/results/CLAIMS.md` | Every figure the documents quote, checked against those files. |
| `limitations.md` | What was not measured, and every defect found in the research's own instruments. |
| `evidence/` | Test output, the mutation-probe result, and the gate record (Production delta, build, lint). |

## Layout

```text
research/m7-drawing-set-manager/
├─ architecture-research.md            findings and recommendation
├─ *.md                                companion documents (above)
├─ portable-project.schema.proposed.json
├─ prototype/                          research-only modules; pure, no DOM, no PDF.js, no React
│  ├─ limits.proposed.mjs              candidate resource limits, each with its basis
│  ├─ bounded-json.mjs                 byte bound, UTF-8, pre-parse scan, JSON.parse
│  ├─ schema-subset.mjs                owned interpreter for the schema; fails closed
│  ├─ semantic.mjs                     identity, references, lifecycle
│  ├─ project-io.mjs                   import (all-or-nothing) and export (allow-list)
│  ├─ migrate.mjs                      old / current / future versions
│  ├─ sha256-stream.mjs                incremental SHA-256; streaming Blob fingerprint
│  ├─ ids.mjs                          UUIDs without a secure context
│  ├─ rebind.mjs                       the rebinding state machine
│  ├─ currency.mjs                     stale / unverified / current; Final readiness
│  ├─ qa-rules.mjs                     the QA rules and reconciliation
│  ├─ model-ops.mjs                    the operations that change a Project
│  ├─ register-adapter.mjs             the boundary to the existing Drawing Register
│  ├─ register-list-adapter.mjs        from the existing table engine's grid to declared register rows
│  └─ synthetic-project.mjs            seeded synthetic Drawing Sets
├─ tests/                              node:test suites, a TS-resolve hook, the mutation probe
├─ fixtures/                           small synthetic Project files and the verdict each must get
├─ benchmark/                          Node and browser benchmarks; results/ holds what they wrote
└─ evidence/                           test output and gate record
```

## Running it

Everything runs from the repository root with the Node the repository already uses (24). Nothing is
installed, nothing is fetched, and nothing outside this directory is written except temporary synthetic
files in the operating system's temp directory, which the benchmarks delete.

```sh
# the research tests
node --test "research/m7-drawing-set-manager/tests/*.test.mjs"

# show each suite a broken prototype and require it to notice (edits files in place, restores them)
node research/m7-drawing-set-manager/tests/mutation-probe.mjs

# regenerate the committed fixtures (the tests compare them with what is committed)
node research/m7-drawing-set-manager/fixtures/make-fixtures.mjs

# benchmarks -- Node
node research/m7-drawing-set-manager/benchmark/bench-scale.mjs
node research/m7-drawing-set-manager/benchmark/bench-hostile.mjs
node research/m7-drawing-set-manager/benchmark/bench-fingerprint-node.mjs

# benchmarks -- browser (Puppeteer's Chrome; serves this directory on 127.0.0.1 only)
node research/m7-drawing-set-manager/benchmark/bench-browser.mjs
#   --only=fingerprint,extra,probes,scale   to run a part

# tables and the run-independent fields, from the result files
node research/m7-drawing-set-manager/benchmark/summarise.mjs
node research/m7-drawing-set-manager/benchmark/structural.mjs

# hold every figure the documents quote to the result files
node research/m7-drawing-set-manager/benchmark/check-claims.mjs

# everything above for one committed head: tests, probes, every benchmark twice, build, lint
# (refuses to run unless the source is exactly what is committed)
node research/m7-drawing-set-manager/benchmark/collect-evidence.mjs --base=<base sha>
```

The browser benchmark writes up to about 1 GiB of synthetic files to the temp directory while it runs and
holds a 250 MiB file in memory in some cases; it refuses to start those cases with less than 2 GiB free.

## What this research does to Production

Nothing. It reads `src/` and changes none of it:

- `tests/reuse-parity.test.mjs`, `tests/sha256.test.mjs` and `benchmark/bench-fingerprint-node.mjs` **import**
  Production modules read-only, to show that the existing engines can be called as they are.
  `tests/declared-register.test.mjs` does the same for the table engine. `tests/ts-resolve-hook.mjs` is what
  lets Node resolve their extensionless relative imports and load PDF.js's own Node build where a Production
  module imports `pdfjs-dist`; it is loaded only by the tests that need it and changes no file.
- The repository's TypeScript build covers `src/` only, ESLint's rules cover `*.ts` / `*.tsx` only, and Core
  CI runs a fixed list of scripts under `scripts/`. None of them reads this directory.
  `evidence/gates.md` records the check.

## Boundaries this research kept

No Production feature; no change to the five existing tools or their UI; no version bump; no deploy; no
merge; no adopted schema; no canonical ERD; no Optimizer v2 Stage 2 work; no customer or real-project PDF;
no secret, credential or internal path in any fixture; nothing sent to a cloud, OCR or AI service.
