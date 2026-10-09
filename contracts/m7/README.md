# M7 canonical contract — Portable Project JSON

> **This directory is the canonical M7 Architecture v1 contract publication.**
>
> - M7 Architecture v1: **Human adopted 2026-10-09**. Data Model Gate: **Class A — ERD Recommended**
>   (effective 2026-10-09).
> - Published by **M7-CAN-01** (Human authorization 2026-10-09) from app `main` at
>   `1b5f9eda59a583a6b8fe7e07013ba38fc3053d1f`.
> - **No Production runtime integration is here.** Nothing under `src/` imports these files; the app does not
>   read, write or validate a Portable Project yet.
> - **M7-P1 is NOT authorized by this publication.** It needs its own explicit Human authorization and a
>   fresh-main branch.
> - Schema and resource bounds are **pre-release**: every numeric bound marked as a candidate is not a
>   Production constant.

## Files

| File | What it is | Authority |
|---|---|---|
| `portable-project.schema.json` | the machine-readable **structural** contract (JSON Schema, draft-07 subset) | canonical |
| `portable-project.semantic.mjs` | the executable **semantic relation / lifecycle** contract: identity uniqueness, referential integrity, lifecycle consistency — what JSON Schema cannot state. It runs only on a value the schema has accepted | canonical |
| `semantic-contract.md` | the same contract for people, plus the runtime rules (rebinding, currency, QA, Final readiness) the later phases implement | canonical, human-readable |
| `contract-manifest.json` | the publication record: provenance, digests, status flags | record |

The two machine-readable files win over any prose or diagram. The Mermaid diagrams in the Architecture note
and in the research are **projections only**.

## Authority and provenance

- **Research PR #33 is evidence only.** Its content was read at the reviewed exact head
  `e541d1d43db3a73acceb3f8241ef914d59dc77d7` (repair source `ade59261b26c180ea2930e6a23cd64e141dfc892`) with
  `git show` and published here. PR #33 was **not merged, cherry-picked or rebased onto**, and the research
  branch **must not be merged or cherry-picked for Production** or used as an implementation base.
- Vault Architecture projection:
  `obsidian-vault/01_Projects/PDF-ArchiTools/12_M7_Architecture_v1.md` (adopted in obsidian-vault
  `5e69c8cd1e9ab2412ae5d536138dae8fe7981e14`).

| Published | Reviewed source at `e541d1d` (git blob) | Publication change |
|---|---|---|
| `portable-project.schema.json` | `research/m7-drawing-set-manager/portable-project.schema.proposed.json` (`fa274834…`) | root `$id`, `title` and `description` only |
| `portable-project.semantic.mjs` | `research/m7-drawing-set-manager/prototype/semantic.mjs` (`151aa511…`) | the leading header comment only |
| `semantic-contract.md` | derived from Architecture v1, its Human decision values, and the reviewed `data-model.proposed.md`, `architecture-research.md`, `qa-rule-matrix.md`, `rebinding-state-machine.md` | written for this publication |

### Parity with the reviewed source

- **Schema:** with the root `$id`, `title` and `description` removed, the published schema is deep-equal to
  the reviewed one, key order included; textually, only lines 3–5 differ. No nested description needed a
  change. Structural digest `2fb0b3fa58d4e514afa976f3765bebb22431def7f21214be6572a90dcd1955df`.
- **Semantic contract:** everything after the leading header comment is byte-identical to the reviewed file
  (body digest `8775a3211f624a53850b4f551284bc06e519c13bc24f99ac6a67192fa2e7cf33`); the exports, the 24
  problem codes and the 2 warning codes are the same.

To reproduce (POSIX shell, from the repository root; both lines print two equal digests, the ones recorded in
`contract-manifest.json`). Digests are of the committed bytes, which use LF line endings; the snippet
normalises a CRLF checkout first.

```sh
R=e541d1d43db3a73acceb3f8241ef914d59dc77d7
P=research/m7-drawing-set-manager
T=$(mktemp -d)
git fetch origin "$R"
git show "$R:$P/portable-project.schema.proposed.json" > "$T/schema.json"
git show "$R:$P/prototype/semantic.mjs" > "$T/semantic.mjs"
T="$T" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const shape = (f) => { const o = JSON.parse(readFileSync(f, "utf8")); delete o.$id; delete o.title; delete o.description; return sha(JSON.stringify(o)); };
const body = (f) => { const t = readFileSync(f, "utf8").replace(/\r\n/g, "\n"); return sha(t.slice(t.indexOf("*/") + 2)); };
const t = process.env.T;
console.log(shape(t + "/schema.json"), shape("contracts/m7/portable-project.schema.json"));
console.log(body(t + "/semantic.mjs"), body("contracts/m7/portable-project.semantic.mjs"));
'
```

## The model in one line each

Ten durable entity types, in one JSON document whose Drawing Set holds seven flat collections related by UUID
(`semantic-contract.md` has the rules):

1. **Project** · 2. **Drawing Set** · 3. **Source** · 4. **Title Block Profile** · 5. **Sheet** ·
6. **Drawing Register Reference** · 7. **Register Entry** · 8. **Analysis Run** · 9. **QA Finding** ·
10. **Review Decision**

## Status of the numbers

Adopted: every collection and string is bounded, each bound is named by `x-limit`, and a value outside a bound
is refused (fail-closed). **Not adopted as Production constants:** the numeric values — Project file 64 MiB,
nesting depth 16, 5000 Sheets, 5000 Sources, 50000 Findings, 100000 Decisions and the string / count limits
are **candidate pre-release bounds**, not shipping guarantees. The one separately adopted value is
`maxFieldRawTextLength` = 1000 characters per title-block field. The 256 MiB per-Source ceiling is M6's adopted
value, which Architecture v1 lets M7 reuse; M7's own PDF.js intake gate is defined in M7-P1. Production values
are frozen by M7-P4 (and M7-P1 for the PDF intake gate).

## Where it is used — the M7 split

| Phase | Scope | Uses this contract |
|---|---|---|
| **M7-P1** Workspace + Source foundation | sixth workspace, PDF selection, fingerprint Worker, Source Manifest and Sheet inventory in memory, page facts, Sheet List, read-only viewer | in memory: Source, Sheet, fingerprints |
| **M7-P2** Title Block Profiles + register metadata | profiles and assignment, M2-5 extraction adapter, Human confirmation and history, profile / source currency | Profile, observation, confirmation, currency |
| **M7-P3** QA + Human review | QA engine, declared Drawing Register (M2-4 adapter or manual), QA09, append-only decisions, Final-readiness gate | Finding, Decision, register, Final readiness |
| **M7-P4** Portable Project save / resume | user-writable format, bounded import, allow-list export, rebinding flows, migration framework, Final QA Report | the whole file; freezes `schemaVersion` 1 and the limits |

None of these phases is authorized by this publication.

## Changing this contract

- **Before M7-P4 (pre-release).** No Portable Project file has shipped, so the contract may change without an
  end-user migration — but **only through a reviewed change to this directory, made before any
  implementation that depends on it**. A change updates the schema, the semantic contract and
  `semantic-contract.md` together, and the manifest's digests.
- **At and after M7-P4.** `schemaVersion` 1 is frozen; a change of shape is a new version with a migration,
  and every released schema version's schema file is kept.
- The first Production M7 implementation PR declares `data_model_impact: NEW`.

## Release advisories carried from Architecture v1

- M7-P1 and M7-P4: define and run **target-browser smoke** coverage (the research measured one browser).
- M7-P2: first end-to-end browser proof of `extractRegister` through the M7 adapter.
- M7-P3: freeze the candidate Product parameters (QA01B, gap run 5, outlier majority > 50 %).
- M7-P4: fuzz, property-based and differential tests of the bounded scanner and schema interpreter; freeze
  the resource limits; first schema version release.
- A Project file is **not tamper-evident**; nothing may imply signed or auditable authenticity.
- An automatic Vercel Preview on a PR push is platform behaviour, not a Production deployment.
