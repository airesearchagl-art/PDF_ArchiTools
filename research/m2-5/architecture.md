# M2-5 drawing register — proposed architecture

Research only. Nothing here is implemented in the app, and nothing should be
until this is adopted. The prototypes under `prototype/` exist to make the
measurements in `measurements.md` possible; they are not a draft of the
production code.

## The problem, stated honestly

Given a PDF of N drawing sheets, produce a register: one row per sheet, holding
`drawing_number`, `drawing_title`, `revision` and `revision_date`, that a
person can check and then hand to somebody else as a document list.

The hard part is not reading the text. On the corpus here, 85 of 88 values are
read correctly by the naive approach. The hard part is that **a register is a
document people act on** — they order prints from it, they check an issue
against it, they bill from it — so a row that is quietly wrong is worse than a
row that is visibly missing, and a drawing this tool silently drops does not
exist as far as the next person is concerned.

That shapes every decision below.

## The pipeline

```
   pick a representative page
             |
   user draws four field regions on it            <- the template
             |
   for each page:
       geometry (upright page space, /Rotate undone)
             |
       does the template fit this page?  --- no --> row with a reason
             |  yes
       per field:
           native text inside the region?
             |  yes                       |  no
           take it                     render just that region, OCR it
             |                              |
             +--------------+---------------+
                            |
             one row, with per-field source and confidence
             |
   register: N rows for N pages, all unconfirmed
             |
   duplicate check ------> review queue, ordered by doubt
             |
   the user edits and confirms rows
             |
   export as XLSX (the writer already in the app)
```

### Upright page space

Same single coordinate space M2-4 established: origin top-left, y down, PDF
points, `/Rotate` undone. Every region, token box and render rectangle lives in
it. This is not a new decision, it is the existing one, and reusing it is most
of why this spike needs no new geometry code.

### The template is placed by a person, not inferred

The user picks a page, draws four rectangles, and names them. There is no
detector looking for a title block, and adding one is not proposed. A detector
would produce a fifth thing to be wrong, and section 1 of `measurements.md`
shows that even a *correct* region does not transfer between sheet sizes
reliably enough to be trusted unattended.

### Field regions rasterise alone

Rendering a whole A0 sheet at 300 dpi costs 558 MB of RGBA. The four field
regions together cost 22.5 MB — 4% of it. PDF.js does this natively through
`offsetX`/`offsetY` on the viewport, so the region is passed through rather
than cropped afterwards. Without this the large sheets are not merely slow,
they are a tab that dies.

### Source is chosen per field, not per page

Page 12 in the corpus is a raster sheet with the drawing number left as vector
text. It classifies as *not scanned*, so a page-level native/scanned switch
reads one field, leaves three empty and reports nothing unusual. Choosing per
field reads the one native value and sends the other three to OCR.

On the aggregate this wins nothing (85/88 either way) — it wins on the page
that a page-level switch handles silently and wrongly.

Each field records where its value came from: `native`, `ocr`, or a page-level
`mixed`. That record is not decoration. Page 20 shows why: a sheet carrying
somebody else's OCR text layer looks exactly like authored text, so "this was
native" cannot be read as "this is right", and a later check that treats a
value as authoritative needs to know which it was.

### OCR: one call per field, `SINGLE_BLOCK`, local

`SINGLE_BLOCK` reads 8/8 of the probed fields where `AUTO` reads 4/8. This is
the opposite of M2-4's full-page finding and it is not a contradiction: a
cropped field is a single block of text, which is what the mode is named for.

Per-field calls cost the same time as one union call (214 ms vs 204 ms) and the
same accuracy. They are chosen for a different reason: they yield a confidence
figure and a failure reason **per field**, which is what the review queue needs
to order. One number for four values cannot say which of the four to look at.

Tesseract.js runs from `public/tesseract/` and `public/tessdata/` in this
repository, in one shared worker. External requests during OCR: 0. There is no
OCR service, no AI API and no cloud conversion in this design, and the probe
asserts it rather than asserting it in prose.

### Every page produces a row

A page whose template does not fit, whose OCR fails, or whose fields come back
empty still produces a row — with empty values and a reason. There is no path
that removes a page from the register.

This is the one rule in the design with no trade-off attached. A register
missing a sheet is not a degraded register, it is a wrong one, and it is wrong
in the way nobody checks for.

### A row is a candidate until a person confirms it

Confidence never promotes a row. It orders the queue and nothing else. A row
with four high-confidence native values and no flags at all is still
`unconfirmed` until somebody says otherwise, and the gate asserts exactly that.

Confirmation records what was extracted alongside what was edited, so a later
reader can see which values a person actually changed.

**On the word "confidence".** The number Tesseract reports is its own score for
its own output. It is not a probability that the value is correct, it is not
calibrated against anything, and it must not be presented to a user as either.
In the queue it is a sort key, and the UI should say what it is: *how sure the
reader was*, not *how likely this is right*.

### Duplicates yes, gaps no

Duplicate drawing numbers are found by exact string match after trimming, and
that found the planted duplicate with zero false positives. `A-101` and `A101`
are deliberately not merged — on a real issue those may be two different
sheets, and guessing costs more than asking.

**Gap inference is not proposed for production.** Section 10 of
`measurements.md` shows every threshold that finds the planted gap also invents
at least one false candidate, on a set of 22 pages; the loose default invents
25. A drawing set is *allowed* to skip numbers. See `decision-matrix.md`.

### Export

XLSX, through `src/utils/pdf-textifier/excel.ts` — the writer M2-4 already
shipped and already gates. Every cell is written as an inline string, so `001`
stays `001`, `=1+1` stays text, and nothing evaluates. Verified by opening the
file in Microsoft Excel 16.0: 12 of 12 values intact.

CSV is not proposed, and not because of formula injection alone. `001` becomes
`1` under **every** CSV policy including the raw one, because CSV carries no
type information. For a register keyed on the drawing number that is
disqualifying on its own. The four safety policies each then damage ordinary
values further, and one of them silently empties a legitimate `-`.

New dependencies: **0**. Everything above is PDF.js, Tesseract.js, JSZip and
the geometry and workbook code already in the repository.

## Recommendation

**ADOPT** the shape above:

- user-placed template, upright page space, region-only rasterising
- per-field source selection with the source recorded
- per-field OCR at `SINGLE_BLOCK`, local, no service
- one row per page with no silent loss
- candidate-until-confirmed, confidence as a sort key only
- duplicate detection by exact match
- XLSX export through the existing writer; no CSV

**REVISE** two pieces before implementing them:

1. **How the template transfers between sheet sizes.** No coordinate model
   works for both conventions in the corpus: normalised reads the sheets whose
   title block scales, corner-anchored reads the sheets whose block is a fixed
   physical size, and each fails the other. `templateFits()` does not detect
   the mismatch because A-series sheets share an aspect ratio. The revision is
   to stop trying to pick automatically: apply the template, show the user the
   proposed regions on the first page of each new sheet size, and have them
   confirm or redraw. One extra confirmation per sheet size, in exchange for
   not being confidently wrong on half a set.

2. **Label and value in one cell.** Taking the last line of the region is the
   best simple policy measured (64/87 exact against 5/87 verbatim) and is still
   wrong 23 times in 87. The trimming policy that looked obviously better made
   it *worse* (54/88 end to end). The revision is to treat the split as a
   presentation default that the review UI always shows in full, never as a
   transformation applied before the user sees the text.

**DEFER**:

- **Gap inference.** Not shippable on this evidence. Revisit only with a real
  drawing set to calibrate against, and only if a user asks for it.
- **Image preprocessing before OCR.** Measured no difference on synthetic
  pages, which is a null result on clean glyphs rather than evidence it does
  not help. Decide it against real scans.
- **Anything beyond the four fields.** Scale, discipline, sheet counts and the
  rest are not in this measurement and should not be inferred from it.
