# M3 fixtures

Nine synthetic PDFs, nineteen pages. Each carries something a save path can
lose, or something it should refuse, so that "the source is preserved" is a
measurement rather than a claim.

No customer document and no real project drawing is used anywhere. The generator
is `scripts/research-m3-fixtures.mjs`; it writes into `test-fixtures/m3/`, which
is gitignored, and it is deterministic — a number that moves between two runs is
a change in the code.

```
node scripts/research-m3-fixtures.mjs
```

## What is in the corpus

| file | pages | what it is there to catch |
| --- | --- | --- |
| `native.pdf` | 3 | vector geometry and real text, mixed page sizes (A4, A3, A4); page 3 is left un-annotated |
| `rotated.pdf` | 4 | `/Rotate` 0, 90, 180, 270 with identical content |
| `boxes.pdf` | 3 | MediaBox = CropBox; a CropBox smaller than the sheet; a CropBox whose origin is **not** (0,0) |
| `features.pdf` | 1 | two existing annotations (Square, Text), two AcroForm fields with values, metadata |
| `scanned.pdf` | 2 | an image-only page, and an image page under an invisible text layer |
| `a0.pdf` | 1 | one A0 sheet, for the rasterisation bound |
| `croprot.pdf` | 4 | a CropBox origin of (50, 70) **and** all four rotations — each alone is already covered, and a save path that fixes one and forgets the other passes both of those |
| `signed.pdf` | 1 | an AcroForm signature field, for the refusal path |
| `damaged.pdf` | 3 | `native.pdf` with its cross-reference region overwritten |

Measured before anything touches them:

| file | characters | path operators | images | annotations | form fields |
| --- | --- | --- | --- | --- | --- |
| native | 155 | 21 | 0 | 0 | 0 |
| rotated | 193 | 28 | 0 | 0 | 0 |
| boxes | 153 | 21 | 0 | 0 | 0 |
| features | 56 | 10 | 0 | 4 | 2 |
| scanned | 22 | 0 | 2 | 0 | 0 |
| a0 | 47 | 7 | 0 | 0 | 0 |

Both a character count and a path-operator count are recorded for every page,
because they fail separately. A save can keep the look of the lines and lose
every letter, and the whole spike is about telling those two apart.

The text is deliberately in two alphabets — `A-101 GROUND FLOOR PLAN` and
`A-101 建築平面図` — so that "text survived" cannot be satisfied by ASCII alone.

`boxes.pdf` page 2 also carries the words `HIDDEN BY CROPBOX` drawn outside the
crop. It is in the file and not on screen; a save that flattens what is visible
loses it, and a save that maps coordinates wrongly puts a mark on top of it.

## The annotations

One set, applied to every page except where a fixture wants a bare one. Defined
in `prototype/model.mjs`, mirroring `src/components/DrawingCanvas.tsx` field for
field:

| id | what it exercises |
| --- | --- |
| `stroke-plain` | an ordinary pen stroke |
| `stroke-alpha` | opacity 0.4 — alpha is its own preservation question |
| `stroke-pressure` | 12 segments, each a different width from per-point pressure |
| `stroke-eraser-mark` | the pixel eraser, crossing `stroke-plain` |
| `text-ascii` | `REVISION A` |
| `text-japanese` | `確認済み 2026年9月` |
| `text-mixed` | `A-101 図面 <check> & ok` — Japanese, ASCII and characters XML must escape |
| `measure-line` | a measurement line and its computed label |
| `measure-poly` | a polyline, per-segment labels and a total |
| `measure-area` | a polygon, a 30% fill and an area label |

Nothing overlaps anything else. A fidelity comparison of overlapping marks
cannot say which one went wrong.

Positions are in points from the top-left, inside the tightest CropBox in the
corpus, so the same set is meaningful on every fixture.

`signed.pdf` carries a signature *field*, not a real signature: enough to
exercise detection, which is what the boundary needs. Producing a genuinely
signed document would need a certificate and a signing implementation, and would
measure those rather than the refusal.

## What the corpus does not contain

- No outline/bookmark tree. `pdf-lib` has no high-level API for one and building
  it by hand would have measured the fixture rather than the save path.
- No encrypted or linearised or tagged PDF. There is a damaged one, but no
  encrypted one: nothing in the dependency set can write encryption, so the
  refusal path for it is code that exists and has not been exercised.
- No page whose title block is rotated relative to its sheet.
- No document over 4 pages, and nothing near the size of a real issue.
- No real scan: the "scanned" pages are rasterised vector text, with none of the
  skew, speckle or gamma of paper that has been through a machine.
