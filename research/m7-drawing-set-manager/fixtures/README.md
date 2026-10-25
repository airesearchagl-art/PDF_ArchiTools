# Fixtures

> **RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL.**

Small synthetic Portable Project JSON files, and the verdict the importer must give each.

- **Everything here is synthetic.** The Projects are built from a seed by `prototype/synthetic-project.mjs`;
  the invalid ones are that output with one thing broken. There is no customer drawing, no real project, no
  real file name, no path and no secret in any of them. The one fixture that contains `<script>`, a URL and
  a Windows path (`valid/inert-hostile-text.project.json`) contains them as *made-up text in a comment*, to
  show that such text is accepted as text.
- **They are generated, not written.** `make-fixtures.mjs` is the only source. `tests/fixtures.test.mjs`
  regenerates every file and compares it with what is committed, so a fixture cannot drift from its
  generator.
- **`expected.json`** says, for each file, why it exists and what the importer must answer: `ACCEPTED`
  (with the warnings it must carry) or `REJECTED` at a named stage with a named code.
- **Only small fixtures are committed.** The large adversarial inputs — megabytes of string, millions of
  values, a million levels of nesting — are generated inside the tests and benchmarks and never written to
  disk.

| Directory | Contents |
|---|---|
| `valid/` | a minimal Project; a 12-sheet Project part-way through review; a Drawing Set with a **declared Drawing Register** (and both kinds of QA09 finding); hostile-looking free text; a timestamp ten years ahead (accepted, with warnings) |
| `invalid/` | one file per refusal: truncated, trailing comma, duplicate key, nesting too deep, `1e400`, future version, foreign file, unknown field, missing field, malformed SHA-256, Windows and UNC paths as a file name, unknown enum, over-long comment, duplicate ids, dangling source / sheet / finding / register-entry ids, a register row that names no drawing, a register carrying page text, a decision on other evidence, an impossible timestamp, a lifecycle contradiction |

The files are indented for reading. The exporter writes compact JSON; the importer accepts both.
