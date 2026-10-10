# M7 canonical contract — Portable Project JSON

> **This directory is the canonical M7 Architecture v1 contract publication.**
>
> - M7 Architecture v1: **Human adopted 2026-10-09**. Data Model Gate: **Class A — ERD Recommended**
>   (effective 2026-10-09).
> - Published by **M7-CAN-01** (Human authorization 2026-10-09) from app `main` at
>   `1b5f9eda59a583a6b8fe7e07013ba38fc3053d1f`.
> - M7-P1 shipped separately on 2026-10-10 (PR #35, merge
>   `7bad6880807f3c37fbe00e06874f60ffe92acf80`, Drawing Set 0.1.0,
>   APP_VERSION 1.2.0). Its in-memory model uses this contract's adopted
>   shape, but Portable Project import/export and machine-file integration
>   are not shipped until later gates.
> - **M7-CAN-02 Human Adoption (2026-10-10):** new normative D decisions
>   HDR-36-01 (`editedFields`) and HDR-36-02 (terminal EXTRACTION partial
>   evidence and coverage) are separately Human adopted. `manifestDigest`
>   byte serialization is an existing-rule clarification, not a new decision.
>   The adoption authorizes RF-36-01 provenance repair only: **no Ready,
>   merge, Production, or M7-P2-A/B authorization**.
> - Schema and resource bounds are **pre-release**: every numeric bound marked as a candidate is not a
>   Production constant.

## Files

| File | What it is | Authority |
|---|---|---|
| `portable-project.schema.json` | the machine-readable **structural** contract (JSON Schema, draft-07 subset) | canonical |
| `portable-project.semantic.mjs` | the executable **semantic relation / lifecycle** contract: identity uniqueness, referential integrity, lifecycle consistency — what JSON Schema cannot state. It runs only on a value the schema has accepted | canonical |
| `semantic-contract.md` | the same contract for people, plus the runtime rules (rebinding, currency, QA, Final readiness) the later phases implement | canonical, human-readable |
| `contract-manifest.json` | the CAN-01 publication snapshot and CAN-02 human-contract digest/clarification scope | provenance record |

The two machine-readable files are canonical for S/R/W. The human-readable contract
also defines the runtime/writer D rules, to be independently reviewed before
dependent implementation. Mermaid diagrams are projections only. The
manifest's CAN-01 `productionRuntimeIntegration` and
`productionImplementationAuthorized` are its historical publication-time
snapshot, **not** the current M7-P1 state or approval of M7-P2.

## Authority and provenance

- **Research PR #33 is evidence only.** Its content was read at the reviewed exact head
  `e541d1d43db3a73acceb3f8241ef914d59dc77d7` (repair source `ade59261b26c180ea2930e6a23cd64e141dfc892`) with
  `git show` and published here. PR #33 was **not merged, cherry-picked or rebased onto**, and the research
  branch **must not be merged or cherry-picked for Production** or used as an implementation base.
- Vault Architecture projection:
  `obsidian-vault/01_Projects/PDF-ArchiTools/12_M7_Architecture_v1.md` (adopted in obsidian-vault
  `5e69c8cd1e9ab2412ae5d536138dae8fe7981e14`).
- **CAN-02 new adoption (separate from CAN-01):** explicit Human decision
  on 2026-10-10 after Independent FULL Review of PR #36
  (`faf9d08b5d37041a90c40403f72ebb18c99997d9`):
  HDR-36-01 and HDR-36-02 are **new normative D writer/runtime policy**,
  not rules inherited from Architecture v1 or PR #33. See PR #36's
  Human Adoption Gate record; the repair remains subject to independent
  Focused Contract Re-review and separate Ready/merge authority.

| Published | Reviewed source at `e541d1d` (git blob) | Publication change |
|---|---|---|
| `portable-project.schema.json` | `research/m7-drawing-set-manager/portable-project.schema.proposed.json` (`fa274834…`) | root `$id`, `title` and `description` only |
| `portable-project.semantic.mjs` | `research/m7-drawing-set-manager/prototype/semantic.mjs` (`151aa511…`) | the leading header comment only |
| `semantic-contract.md` (CAN-01) | derived from Architecture v1, its Human decision values, and the reviewed `data-model.proposed.md`, `architecture-research.md`, `qa-rule-matrix.md`, `rebinding-state-machine.md` | original CAN-01 publication only; HDR-36-01/02 were adopted separately in CAN-02 |

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

This CAN-01 publication did not itself authorize an implementation. P1 was separately authorized and released; CAN-02 does not authorize P2/P3/P4.

## CAN-02 Human adoption and byte-level clarification

M7-CAN-02 records the **new Human-adopted D policies** HDR-36-01
(`editedFields` writer meaning) and HDR-36-02 (terminal EXTRACTION run
partial evidence and coverage), both adopted **2026-10-10**. These policies
are not claimed to be previously adopted under CAN-01. The exact
`manifestDigest` bytes/reference vectors document an existing rule.
All additions are human-readable D rules only; machine schema and
executable S/R/W validator remain unchanged. The manifest records the
adoption decisions separately from CAN-01 publication provenance and
binds the whole revised LF UTF-8 `semantic-contract.md` in
`files["semantic-contract.md"].sha256`, alongside the original machine
file digests. The Human decision does not authorize Ready, merge, Production,
or P2-A/B implementation. Verify all recorded file hashes:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const m = JSON.parse(readFileSync("contracts/m7/contract-manifest.json", "utf8"));
for (const [file, record] of Object.entries(m.files)) {
  const got = createHash("sha256").update(readFileSync(`contracts/m7/${file}`)).digest("hex");
  if (got !== record.sha256) throw new Error(`${file}: digest mismatch`);
  console.log(file, got);
}
'
```

## Changing this contract

- **Before M7-P4 (pre-release).** No Portable Project file has shipped,
  so reviewed changes can precede the first writable format. A change to
  machine structural (S) or relation/warning (R/W) rules requires synchronized
  affected machine file(s), human contract and manifest digests. A
  **new Human-adopted D policy or a D-only clarification** with verified
  zero machine delta updates the human contract and its manifest digest,
  but cannot claim to have changed the schema or executable semantics.
  New normative D meaning requires its own explicit Human adoption.
  Either way independent review is required **before** dependent
  implementation. If a proposed change alters an existing adopted
  decision, STOP for a new Human Gate.
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
