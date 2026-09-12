# M2-5 drawing register — proposed architecture

Research only. Nothing here is implemented in the app, and nothing should be
until this is adopted. The prototypes under `prototype/` exist to make the
measurements in `measurements.md` possible; they are not a draft of the
production code.

## The problem, stated honestly

Given a PDF of N drawing sheets, produce a register: one row per sheet, holding
`drawing_number`, `drawing_title`, `revision` and `revision_date`, that a
person can check and then hand to somebody else as a document list.

The hard part is not reading the text. On the corpus here, 96 of 100 values are
read correctly by a fairly plain pipeline. The hard part is that **a register is a
document people act on** — they order prints from it, they check an issue
against it, they bill from it — so a row that is quietly wrong is worse than a
row that is visibly missing, and a drawing this tool silently drops does not
exist as far as the next person is concerned.

That shapes every decision below.

## The pipeline

```
   pick a representative page
             |
   user draws four field regions on it            <- a template
             |
   user names it a profile and says which pages
   it covers                                      <- the assignment
             |
   for each page:
       geometry (upright page space, /Rotate undone)
             |
       has a person assigned this page a profile?  -- no --> row with a reason
             |  yes
       per field:
           native text inside the region?
             |  yes                       |  no
           take it                     collect it for OCR
             |                              |
             |                     render the fields that need it,
             |                     un-rotated, and recognise them
             |                              |
             +--------------+---------------+
                            |
       one row: per field its raw text, a display value derived
       from it, its source, and its confidence
             |
   register: N rows for N pages, all unconfirmed
             |
   duplicate check ------> review surface: every row,
                           ordered by how much doubt there is
             |
   the user edits and confirms rows -- all of them
             |
   export as XLSX (the writer already in the app)
```

### Upright page space

Same single coordinate space M2-4 established: origin top-left, y down, PDF
points, `/Rotate` undone. Every region, token box and render rectangle lives in
it. This is not a new decision, it is the existing one, and reusing it is most
of why this spike needs no new geometry code.

### The template is placed by a person, and assigned by a person

The user picks a page, draws four rectangles, and names them. There is no
detector looking for a title block, and adding one is not proposed. A detector
would produce a fifth thing to be wrong, and section 1 of `measurements.md`
shows that even a *correct* region does not transfer between sheet sizes
reliably enough to be trusted unattended.

**Which pages a template covers is also a person's answer.** The tempting
shortcut is to key it on sheet size — same size, same block — and this corpus
refutes that on its own: pages 5, 6 and 7 are all A2, and page 7 is drawn to a
different title block. Sheet size is not what varies. The drawing office's
template is, and one issue can carry several.

So a **profile** is an explicit thing: a named template, plus the coordinate
model it transfers by. A page belongs to a profile because somebody said so —
by page or by page range — and the assignment records who confirmed it. There
is no inference step.

A page nobody has assigned is *unassigned*, not guessed. It still produces a
row, carrying `no confirmed template profile covers this page`, which is
deliberately a different reason from a template that fitted and missed: one is a
question for a person, the other is a result.

**`templateFits()` is not the gate for this**, and must not become one. It
answers a narrower question — does this rectangle still land on this page — and
it answers *true* for every A-series sheet, including the two the assignment
deliberately leaves out. Wiring it to assignment would auto-continue onto
exactly the pages this design refuses to guess at, and read 0 of 8 fields while
reporting nothing wrong. §7b.

Everything in section 7 of `measurements.md` is therefore extraction
performance *given a correct, confirmed assignment* — not evidence that the
assignment can be made automatically.

### Field regions rasterise alone

Rendering a whole A0 sheet at 300 dpi costs 558 MB of RGBA. The four field
regions together cost 22.5 MB — 4% of it. PDF.js does this natively through
`offsetX`/`offsetY` on the viewport, so the region is passed through rather
than cropped afterwards. Without this the large sheets are not merely slow,
they are a tab that dies.

**The region is rendered with `/Rotate` undone** — `getViewport({ scale,
rotation: 0 })` — so the canvas comes out in the same upright page space the
rectangles are already expressed in. Getting only the rectangle right is not
enough, and this is not a hypothetical: mapping the rectangle into display
space crops exactly the right pixels and hands OCR a title block lying on its
side. Section 5b of `measurements.md` has the numbers (0/12 fields before,
10/12 after) and the negative probe that keeps it honest.

### Source is chosen per field, not per page

Page 12 in the corpus is a raster sheet with the drawing number left as vector
text. It classifies as *not scanned*, so a page-level native/scanned switch
reads one field, leaves three empty and reports nothing unusual. Choosing per
field reads the one native value and sends the other three to OCR.

On the aggregate this is worth two fields (95/100 against 93/100). It is worth
three on page 12 alone, which is where the argument actually lives: a
page-level switch handles that page silently and wrongly.

Each field records where its value came from: `native`, `ocr`, or a page-level
`mixed`. That record is not decoration. Page 20 shows why: a sheet carrying
somebody else's OCR text layer looks exactly like authored text, so "this was
native" cannot be read as "this is right", and a later check that treats a
value as authoritative needs to know which it was.

### OCR: one call for the block, `SINGLE_BLOCK`, local

`SINGLE_BLOCK` reads 25 of 28 field readings where `AUTO` reads 13. This is the
opposite of M2-4's full-page finding and it is not a contradiction: a cropped
field is a single block of text, which is what the mode is named for.

**The fields that need OCR are recognised in one pass over their bounding
region, not one pass each.** This reverses what an earlier version of this
document proposed, and the reason it was proposed was wrong rather than merely
outvoted: it claimed a union call "gives one number for four values, so it
cannot say which of the four to look at". The union path assigns each
recognised word to the field rectangle its centre falls in, so it produces a
per-field text, word count and confidence exactly as per-field recognition
does. With that claim removed, the measurement is one-sided — 96/100 against
95/100, 9 calls against 35, 1.6 s against 2.1 s.

The cost is pixels: the union region spans the gaps between fields, 14.55 Mpx
against 10.81 across the set. On the largest sheet that is still far inside
what a browser can hold.

The real risk in this path is attribution *correctness* rather than attribution
at all — a word whose centre falls on the wrong side of a boundary is filed
under the wrong field, silently. It did not happen here (0 words unplaced, and
per-field values matching), on a corpus whose fields are well separated. An
implementation should keep the per-field fallback available for blocks whose
cells nearly touch, and `limitations.md` records that the threshold is
unmeasured.

Tesseract.js runs from `public/tesseract/` and `public/tessdata/` in this
repository, in one shared worker. External requests during OCR: 0. There is no
OCR service, no AI API and no cloud conversion in this design, and the probe
asserts it rather than asserting it in prose.

### What a row holds

Per field, and not summarised to the row:

| | |
| --- | --- |
| `rawText` | exactly what came off the page, never trimmed or overwritten |
| `value` | the display value derived from it, by default its last line |
| `source` | `native` or `ocr`, for that field |
| `confidence` | the reader's own score for that field, or null |
| `reviewReasons` | why this field needs a look |

Each of these is unreconstructible after the fact, which is why it is kept.

A row-level `extractionSource` still exists as a summary and is not sufficient
on its own: page 12 is `mixed`, and only the fields say *which* value came from
where. The gate asserts that the mixed page keeps distinct per-field sources
through to the register.

**What `rawText` means, precisely.** It is the text the extraction layer
produced for this field, before any display transformation — not the PDF byte
stream, and not Tesseract's internal structure. Both of those are the extraction
layer's business, and the boundary is where a field becomes a string.

Whitespace normalisation is allowed *at that boundary* and nowhere after it. The
native reader groups tokens into lines and joins them; the OCR readers group
words into lines and join those; whatever that step emits is the raw text, by
definition. From the moment it reaches a candidate row it does not change again
— not trimmed, not re-normalised, not replaced.

`rawText` is kept because the value is a guess made from it. When a reviewer
sees a wrong drawing number, the question is always "what did the sheet actually
say", and a row that has thrown that away cannot answer. The display rule is
applied as a *view*: changing it changes `value` and cannot change `rawText`,
which the gate proves by pushing a value with leading and trailing whitespace
through both display rules and through confirmation.

Confirmation records `raw`, `proposed` and `final` for every field, plus which
fields a person actually changed. "The human agreed" and "this is what the
sheet said" are different records, and an audit needs both.

### Every page produces a row

A page whose template does not fit, whose OCR fails, or whose fields come back
empty still produces a row — with empty values and a reason. There is no path
that removes a page from the register.

This is the one rule in the design with no trade-off attached. A register
missing a sheet is not a degraded register, it is a wrong one, and it is wrong
in the way nobody checks for.

### A row is a candidate until a person confirms it

Confidence never promotes a row. It orders the surface and nothing else. A row
with four high-confidence native values and no flags at all is still
`unconfirmed` until somebody says otherwise, and the gate asserts exactly that.

**The review surface holds every row.** Not the flagged ones — all of them. An
earlier version of this prototype returned only rows carrying a reason, which
quietly turned "nothing flagged" into "nothing to check", and page 25 of the
corpus is a row that is wrong and carries no flag because OCR misread it
*confidently*. That row would have been unreachable from the surface a person
works from.

An attention queue — the flagged subset — exists as an ordering aid for a UI
that wants to lead with the doubtful rows. It is not a work list: emptying it
finishes nothing, and no part of the model treats it as done. The gate asserts
the surface has one entry per input page, that page 25 is on it, and that
filtering by flags would drop page 25.

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
at least one false candidate, on a set of 25 pages; the loose default invents
33. A drawing set is *allowed* to skip numbers. See `decision-matrix.md`.

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

- user-placed template **and human-confirmed profile assignment**, upright page
  space, region-only rasterising **with `/Rotate` undone**
- per-field source selection, with the source recorded per field
- OCR over the union of the fields that need it, at `SINGLE_BLOCK`, local, no
  service — with words attributed back to fields, and the per-field path kept
  as a fallback for tight blocks
- a candidate row that keeps raw text, display value, source and confidence per
  field, and keeps raw text through confirmation
- the last line of a region as the *display* default, over raw text the
  reviewer always sees in full
- one row per page with no silent loss, including pages with no assigned profile
- candidate-until-confirmed, confidence as a sort key only, **every row on the
  review surface**
- duplicate detection by exact match
- XLSX export through the existing writer; no CSV

**REVISE** one piece before implementing it:

**How a profile is proposed for a page a person has not yet assigned.** No
coordinate model works for both scaling conventions in the corpus: normalised
reads the sheets whose title block scales, corner-anchored reads the sheets
whose block is a fixed physical size, and each fails the other. Sheet size does
not identify the profile either — two layouts share A2 here. And
`templateFits()` cannot detect any of it.

The revision is to stop trying to decide automatically at all: apply the
assignment a person has made, and for any page outside it, show the proposed
regions and ask. Normalised is the better default to *propose* on a new sheet
size, and it must never be applied unattended. One confirmation per profile, in
exchange for not being confidently wrong on half a set.

**DEFER**:

- **Gap inference.** Not shippable on this evidence. Revisit only with a real
  drawing set to calibrate against, and only if a user asks for it.
- **Image preprocessing before OCR.** Measured no difference on synthetic
  pages, which is a null result on clean glyphs rather than evidence it does
  not help. Decide it against real scans.
- **Anything beyond the four fields.** Scale, discipline, sheet counts and the
  rest are not in this measurement and should not be inferred from it.

## What review changed

This spike was reviewed and four findings came back, all of them real:

1. The "page-level" comparator was quietly doing field-level work, so the two
   policies were never actually compared. Fixed; they now differ by two fields
   overall and by three on the page that matters.
2. The end-to-end run measured the union OCR path while the document proposed
   the per-field one, and the stated reason for preferring per-field was false.
   Both paths are now measured end to end, and the recommendation is reversed.
3. The scanned region-render-and-OCR path had only ever run at `/Rotate 0`.
   Adding rotated scanned sheets found a real bug: correct crop, sideways
   glyphs, unreadable output.
4. The candidate model collapsed provenance to the row and kept only the
   transformed value. It now keeps raw text, source and confidence per field,
   through confirmation.

### Second review

Three more findings, all real:

5. `reviewQueue()` returned only flagged rows, so the one row that is wrong
   *and unflagged* could not be reached from the review surface. The surface
   now holds every row; the flagged subset is an ordering aid.
6. Template assignment was keyed on sheet size, which this corpus refutes on
   its own — two layouts share A2. Assignment is now an explicit,
   human-confirmed profile, `templateFits()` is barred from deciding it, and
   the end-to-end numbers are documented as holding *given* a correct
   assignment.
7. The architecture said `rawText` was never trimmed while `buildRow()` trimmed
   it. The contract is now stated precisely — the extraction layer's output,
   before display transformation — and the implementation matches it.
