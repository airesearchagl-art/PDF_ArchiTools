# M4 decision matrix

Every number is from `evidence.json`, produced by
`scripts/m4-comparator-research-gate.mjs`. **Observed** unless marked otherwise.

## The candidates

| | |
| --- | --- |
| **0 — baseline** | what ships. Render each page on its own terms, size the field to the largest, draw each at the top-left, composite. No geometry examined. |
| **A — strict geometry** | compare only when the pages describe the same visible sheet; refuse by name otherwise. |
| **B — canonical upright normalisation** | render every member upright from its own visible box; map others onto slot 1 by the **identity** or not at all. Refuse where a rescale would be needed. |
| **C — human alignment** | when geometry cannot be settled by arithmetic, ask for an offset rather than guessing, and carry it on the result. **The refusal half is researched; the transform contract is not** — see below. |
| **D — automatic registration** | correlate the images and align by the best fit. **Not implemented** — see below. |

## Two stages

A plan says whether a comparison can be made; a verdict says what it found. The
first version of this matrix used `CHANGE` for both, so an identical drawing came
back as `CHANGE` — which is the kind of answer this spike exists to stop.

**Plan** (all four candidates):

| case | 0 | A | B | C |
| --- | --- | --- | --- | --- |
| the same drawing twice | READY | READY | READY | READY |
| a wall added | READY | READY | READY | READY |
| `/Rotate 0` vs `90` | READY | READY | READY | READY |
| crop origin (0,0) vs (50,70) | READY | READY | READY | READY |
| MediaBox larger, same CropBox | READY | READY | READY | READY |
| A4 vs A3, same drawing | READY | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| portrait vs landscape | READY | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| A4 vs a sheet 3pt bigger | READY | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| same aspect, 1.4× | READY | **GEOMETRY_MISMATCH** | **GEOMETRY_MISMATCH** | **ALIGNMENT_REQUIRED** |
| page 3 absent from one | READY (1 member) | **MISSING_PAGE** | MISSING_PAGE | MISSING_PAGE |
| page 3 present but blank | READY | READY | READY | READY |
| one member fails to render | READY (1 member) | **RENDER_FAILED** | RENDER_FAILED | RENDER_FAILED |

**Verdict**, reached only from a plan that was ready:

| case | verdict | differing pixels |
| --- | --- | --- |
| the same drawing twice | **MATCH** | 0 |
| a wall added | **CHANGE** | 8530 (9.6%) |
| rotation only, rendered upright | **MATCH** | 0 |
| crop origin only | **MATCH** | 0 |
| one digit of a dimension changed | **CHANGE** | 51 (0.063%) |
| a different sheet | never reached | — |

The verdict is taken from the change mask with **no ratio floor at all**. Every
control reaches 0 differing pixels, so a floor is not needed to make MATCH
reachable, and the 0.5% floor used in the previous round converted six of seven
small true changes into matches. See §6b.

Candidate 0 has one plan status and no verdict stage at all. It has no state for
*I should not answer this*.

Candidate C now has one fewer, deliberately: supplying an alignment returns
`UNSUPPORTED`, not `READY`, because recording `{ x, y, rotation, scale }` is not
the same as defining it. See §5b.

## The comparison

| | 0 | A | B | C |
| --- | --- | --- | --- | --- |
| false change on a same-size pair | **0.0%** | 0.0% | 0.0% | 0.0% |
| false change on A4 vs A3 | **99.4%** | refused | refused | refused; alignment deferred |
| false change on `/Rotate 0` vs `90` | **99.3%** | **0.0%** ¹ | **0.0%** ¹ | 0.0% ¹ |
| true change captured (wall added) | 9.6% | 9.6% | 9.6% | 9.6% |
| refuses when it should | **never** | yes (4/4) | yes (4/4) | asks (4/4) |
| distinguishes blank from missing | **no** | **yes** | yes | yes |
| survives a failed member | **produces 100% change** | refuses | refuses | refuses |
| human action needed | none | on 4 of 9 cases | on 4 of 9 | on 4 of 9; the way forward is not yet specified |
| runtime, A4 150 dpi | 88 ms | 88 ms ² | 88 ms ² | 88 ms ² |
| peak working set, A1 150 dpi | 488 MB | 488 MB ² | 488 MB ² | 488 MB ² |
| deterministic | yes | yes | yes | yes |
| implementation complexity | shipped | low | moderate | moderate + UI + a sub-spike |

¹ Once the pages are rendered upright, which costs nothing: measured at 0.0% of
ink differing across all three rotations, both canvases 1241×1754.

² The geometry policies decide *whether* to compare, not how. Where they compare,
the cost is the baseline's cost.

## 1. What to do about geometry

| option | verdict |
| --- | --- |
| compare anything, align top-left | **REJECT** — this is the defect |
| stretch a drawing onto another's sheet | **REJECT** — changes every length on it |
| refuse anything not provably the same sheet | **ADOPT** as the default, and as the whole of the recommended M4 MVP |
| let a human supply the alignment | **DEFER** — the right way forward from a refusal, and not yet researched; see §5b |
| guess the alignment automatically | **DEFER** — see section 5 |

## 1b. What a mapping may be

| option | verdict |
| --- | --- |
| a scale computed from the pages' display dimensions | **REJECT** — measured at x = 0.707, y = 1.414 on a quarter turn of the same sheet, and returned as ready anyway |
| a uniform scale, where the pages are proportional | **REJECT** — same proportions are not the same paper; 1.4× scored 99.4% false change |
| render upright, then map by the identity or refuse | **ADOPT** |

`READY_TO_COMPARE` from Candidate B means every mapping is rigid, every
`|scaleX - scaleY|` is exactly 0, and every render rotation is 0. Measured on all
eight required pairs — `/Rotate` 0 against 0/90/180/270, crop origin alone, and
crop origin combined with each rotation — every one accepted with an identity
mapping and every one reaching MATCH at 0 differing pixels. A different physical
sheet still reaches `GEOMETRY_MISMATCH`.

## 2. Rotation

| option | verdict |
| --- | --- |
| treat `/Rotate` as a difference | **REJECT** — it is a viewer instruction, not a drawing |
| render upright and compare | **ADOPT** |

Measured: 0.0% differing on all three rotations. This is a missing argument, not
a policy question, and it accounts for three of the eight false-change rows in
the baseline.

## 3. A page one document does not have

| option | verdict |
| --- | --- |
| skip it | **REJECT** — the report silently loses a page, or shows one document as if it were two |
| fail the whole export | **DEFER** — a human decision; see `architecture.md` |
| include it, marked as missing | **ADOPT** as the recommendation |

Whichever is chosen, `MISSING_PAGE` must be a distinct outcome from a page that
exists and is blank. Measured: the strict policy separates them (`MISSING_PAGE`
vs `CHANGE`); the baseline does not.

## 4. A member that fails to render

| option | verdict |
| --- | --- |
| continue with the survivors | **REJECT** |
| refuse the page, and the export | **ADOPT** |

The measurement is what settles this. A surviving member alone reads as
**100.0% changed**, because its ink has nothing to match against. The current
behaviour does not degrade to a partial answer; it produces the most alarming
possible wrong one.

## 4b. What "matched" means with more than two members

The shipped rule is *any other layer*, and it does not survive four members.

| | any-other-layer | reference-pairs |
| --- | --- | --- |
| four identical | MATCH | MATCH |
| three the same, one changed | CHANGE | CHANGE |
| **two against two** | **MATCH** | **CHANGE** |
| **reference and three different** | **MATCH** | **CHANGE** |

Two agreeing pairs cancel: every pixel finds a partner and a disagreement about
where a wall goes is reported as a clean match.

| option | verdict |
| --- | --- |
| any other layer (today) | **REJECT** — measured to hide a two-against-two disagreement |
| **A — two members only**, three or more refused | implemented and measured; viable, smallest contract |
| **B — reference pairs** — each member against slot 1, MATCH only if all pairs match | implemented and measured; **recommended** |
| **C — all-member consensus** — a location matches only when every member agrees | **DEFER — requires separate research.** Not selectable in this round. |

Measured: reference-pairs catches both failing cases, with the two-against-two
pairs at `identical: 0.0%`, `wall-at-y: 19.3%`, `wall-at-y-copy: 19.3%`.

Consensus is described in `architecture.md` and implemented nowhere. Listing it
beside two contracts that have been run against the corpus would present it as
equally ready to build, and it is not: nothing is known about what it does with
a blank member, a member the other documents do not have, or a member that
failed to render — the cases where a stricter rule diverges most from its own
description. `planMultiMember` therefore refuses it at every member count rather
than returning a plan, which the gate asserts.

Making it selectable means first running a prototype against, at minimum: four
identical members; three the same and one changed; two against two; a reference
against three different documents; one blank member; one missing member; one
member that failed to render.

### The picture, not only the verdict

| option | verdict |
| --- | --- |
| reference-pairs verdict, any-other-member picture | **REJECT** — measured: two-against-two reports CHANGE over a picture showing **0 changed pixels** |
| one visual per pair, each painted by the two-member rule | **ADOPT** — 0 / 17,060 / 17,060 px on the same set, and it names which member differs |
| pairs produced serially | **ADOPT** — and the memory model's presentation phase depends on it |

A correct structured status over a misleading picture is not an improvement on
the shipped behaviour; it is the same wrong answer with a label the user cannot
see. On *reference and three different* the old rule likewise shows 0 px where
the three pair visuals show 8,530 / 8,530 / 17,060.

**The choice between A and B is a product decision, not a technical one** —
reference-pairs answers "how does each drawing differ from the reference",
consensus answers "do they all agree" — so it goes to the Human Gate as **H9**
rather than being settled here, with C marked as deferred rather than offered.

## 4c. One engine for three paths

Preview, the full export and the change report each decide independently what a
comparison means, and they do not agree.

| | render scale | capped |
| --- | --- | --- |
| preview | `scale * (dpi / 72)` | yes |
| export | `dpi / 72` | yes |
| change report | `scale * (dpi / 72)` | **no** |

An A1 at zoom 6 and 600 dpi asks the change report for **10,035 Mpx, ~281 GB**.
They also disagree about a missing page three different ways.

| option | verdict |
| --- | --- |
| three independent pipelines | **REJECT** |
| one planner and one comparison, three presentations | **ADOPT** |

The three paths may render a result differently. None of them may independently
skip a missing page, choose a geometry, cap a DPI, decide what ink is, compute a
threshold, swallow a render failure, or recompute what a change is.

## 4d. The cost of a physical threshold

| option | verdict |
| --- | --- |
| no work bound | **REJECT** — the search is O(ink x radius² x members) with no ceiling |
| `pixels x radius² x members` as the bound | **REJECT** — zero at radius 0, and leaves the contract out |
| `pixels x sourceMembers x (1 + comparedOtherMembers x (2r+1)²)`, summed over the contract's groups | **ADOPT** |
| a work ceiling in units, with no algorithm named | **REJECT** — the same A1 is 23.7e9 units scanning and 0.56e9 dilating; a unit means nothing until the algorithm is fixed |
| `algorithm` required, no default, planner bound to `separable-dilation` | **ADOPT** |
| `MAX_COMPARISON_WORK_UNITS = 12,000,000,000`, checked before allocation, **calibrated against that algorithm** | **ADOPT as a recommendation requiring human approval** — H10 |
| the ceiling applied **per page** | **REJECT** — the export and the change report run over ranges; a hundred pages that each pass are a hundred times the work |
| the ceiling applied to the **whole job**, summed over every requested page and pair | **ADOPT** — measured under the selected algorithm: an A4 page at 300 dpi and 0.5 mm is 69,578,880 units and **173 of them are 12,037,146,240 together, which is refused** |
| a page that cannot be compared dropped from the estimate | **REJECT** — it makes the job look cheaper by not mentioning it |
| that page kept in the plan at zero work, with the reason | **ADOPT** |
| silently reducing DPI or tolerance to fit | **REJECT** — this is the `_600dpi.pdf` failure again |
| a typed `OVER_WORK_BUDGET` refusal that names the numbers | **ADOPT** |
| separable dilation, so the bound does not carry `(2r+1)²` | **ADOPT** as the comparison algorithm |
| banded execution with a generation check between bands | **ADOPT** alongside it |
| a synchronous driver over those bands | **REJECT** — measured: the decision point exists and nothing can reach it |
| yield to a task boundary between bands, then read cancellation and ownership | **ADOPT** as the scheduling contract |

Measured, per ink pixel at radius 3: **0.59 µs** when the drawings match against
**1.56 µs** when they do not. Every earlier cost figure was taken on matching
drawings and is a floor.

A physical threshold grows the radius with the DPI, so the worst case grows with
it too: 43 ms at 150 dpi / radius 3 against 207 ms at 300 dpi / radius 6 on the
same non-matching pair.

**The previous bound was not one.** `pixels x radius² x members` is zero at
radius 0, and a radius-0 comparison still reads every pixel of every member; it
also omits the multi-member contract, so four members under reference-pairs
costed the same as two. The shape adopted above is in units of one pixel read,
takes its groups from the contract — two-only is one group, reference-pairs over
four members is three, consensus has no derived bound at all — and is
conservative about the ink fraction, which is not knowable before rendering.

Where 12e9 comes from, **under the selected algorithm**: the worst measured cost
per unit over five sizes and radii is 1.9e-6 ms — an A1 at 150 dpi, 139,393,888
units in 263 ms. 12e9 units at that rate is about **23 seconds** for the whole
job of **comparison-kernel** time — what `pairChangeMask` costs on masks that
already exist, not what a user waits.

In work a person can picture: **about 173 A4 pages at 300 dpi and 0.5 mm**, at
69,578,880 units each. Under this algorithm no *single* sheet in the corpus
reaches the ceiling — an A1 at 300 dpi is 5% of it — so on one page the memory
budget refuses first, and the work ceiling exists for ranges.

Because it can refuse a comparison a user asked for, it is user-visible, and it
goes to the Human Gate as **H10** the way the 512 MiB working set goes as H7 —
with the conversion attached: each further A4 page at 300 dpi is 69,578,880
units, about 0.13 seconds. If real drawing sets run past ~170 sheets, the number
should go up.

**Cancellation alone does not solve this.** The composite is a synchronous double
loop that cannot observe a cancellation flag or yield to the event loop, so a
long comparison is not abandonable as written. Both halves of the replacement
are now prototyped and measured: the separable dilation produces the *identical*
change mask at every radius tried while removing `(2r+1)²` from the bound
(23,694,575,520 units against 557,519,424 for the same A1), and banded execution
ran a 1241×1754 comparison in 18 bands with the same mask as the direct form. It
is not free — on a sparse drawing the nested scan is faster (4 ms against 23 ms)
because it exits on the first ink it finds — but its cost is a property of the
sheet rather than of the drawing, which is what a ceiling checked before
rendering needs. On ink that matches nothing, the scan goes 25 ms → 65 ms as the
box widens from 9 to 49 while the dilation stays at 28 ms.

**Bands are only half of it.** A decision point between bands is worth nothing
if nothing can reach it. Given the *same* cancellation, scheduled from a timer:
the synchronous driver ran to completion in 23 ms, never saw it, and published a
verdict; the driver that yields to a task boundary between bands stopped at band
4 of 18 with `publishable: false` and no result. A run superseded by a newer
generation does the same. That is the scheduling contract, and it is why "banded"
on its own was not enough to claim abandonability.

## 5b. Candidate C, and what it would take to build it

**The refusal is researched. The transform is not.**

| option | verdict |
| --- | --- |
| refuse a geometry mismatch and stop | **ADOPT** as the M4 MVP |
| refuse, and offer a human alignment | **DEFER** — right direction, no contract yet |
| return `READY_TO_COMPARE` once an alignment object is supplied | **REJECT** — recording `{ x, y, rotation, scale }` is not defining it |

`candidateHumanAlignment` now returns `UNSUPPORTED` rather than `READY` when an
alignment is supplied, which is a deliberate change from the previous round. It
is the same rule as §1b: a plan may not claim a comparison it has no contract
for. The alignment is kept on the result as `recordedAlignment`, with
`appliedAlignment: null`, so the distinction is legible rather than implied.

**If the Human Gate answers H1 with "offer human alignment", an Alignment
Architecture Sub-Spike is required before M4 production implementation.** It must
settle, with evidence: coordinate space; units; transform order; rotation pivot;
uniform against non-uniform scaling; bounds; validation; the interaction with
CropBox and with upright normalisation; what the memory and work estimates
become after an alignment; how the alignment is saved as provenance; and an
actual aligned comparison that reaches MATCH and CHANGE and back.

**Recommended instead, for M4:** geometry mismatch → `GEOMETRY_MISMATCH` → fail
closed. That is a complete feature on its own — it stops the tool reporting its
own coordinate handling as a design change — and it does not require the
sub-spike to ship.

## 5. Automatic registration

**DEFER, and not measured.** Deliberately: the corpus is built with a border, a
title block, a repeating grid and a repeated label, because those are what
architectural sheets carry — and they are exactly the features that make a
correlation peak strong in the wrong place. A registration confident to 99% on a
grid is confident about the grid.

Adopting it would also mean adopting the thing this whole spike is about: an
answer the user cannot check. It is a candidate for a later spike with its own
evidence, not something to fold into this one.

## 6. The threshold

| option | verdict |
| --- | --- |
| pixel radius (today) | **REJECT** — 0.339 mm at 150 dpi, 0.085 mm at 600 |
| millimetres, converted per render | **ADOPT** |
| PDF points | acceptable; mm is the drawing office's unit |
| a unit, and no further policy | **REJECT** — the setting can hide a revision, so it needs one |

Measured: 0.5 mm converts to 1 / 3 / 6 / 12 px at 72 / 150 / 300 / 600 dpi.

The unit is the smaller half of this decision. A spatial tolerance suppresses
true semantic changes, measured on a dimension string reading 1200 against one
reading 1300, at **every resolution the Comparator offers**:

| | 0 | 0.05 | 0.1 | 0.15 | 0.2 | 0.25 | 0.3 | 0.4 | 0.5 mm | safe to |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **72 dpi** | 10 | 10 | 10 | 10 | **0** | **0** | **0** | **0** | **0** | **0.15 mm** |
| 150 dpi | 51 | 51 | 14 | 14 | 14 | 14 | **0** | **0** | **0** | 0.25 mm |
| 300 dpi | 186 | 96 | 96 | 49 | 49 | 18 | 1 | **0** | **0** | 0.3 mm |
| 450 dpi | 401 | 248 | 166 | 113 | 73 | 73 | 38 | **0** | **0** | 0.3 mm |

So **H6 is a Spatial Tolerance Policy**, not a choice of unit:

| | proposed | |
| --- | --- | --- |
| unit | mm | **ADOPT** |
| default | **0 mm** | **ADOPT** — an unconfigured comparison reports every difference it can see |
| minimum | 0 mm, always available | **ADOPT** |
| maximum | **0.15 mm** | **ADOPT** — the *minimum* safe bound across all four supported resolutions |
| a DPI-dependent maximum | | **REJECT** — the same number in the same box would mean different things depending on another setting |
| step | 0.05 mm | **ADOPT**, with the caveat below |
| non-zero tolerance | explicit opt-in | **ADOPT** |
| disclosure when non-zero | required | **ADOPT** — it must not say "ignores small shifts"; measured, it also erases a changed digit and a swapped symbol |

**72 dpi is what sets the ceiling.** A millimetre is fewer pixels there and the
mark is smaller, so the digit is gone by 0.2 mm. A maximum of 0.25 mm — which
sweeping only 150 and 300 dpi would have justified — would have shipped a
setting that hides a revision at the resolution most likely to be left on for a
quick check.

Two things the policy has to carry rather than leave implied. Millimetres round
to whole pixels: 0.05 mm is 0 px at 72 and 150 dpi and 1 px at 300 and 450, so
below about 0.1 mm the setting is finer than the render at the lower half of the
range. And the implementation gate carries one assertion from all of this: **at
the default settings, 1200 → 1300 reports CHANGE — at 72, 150, 300 and 450
dpi.**

## 6b. What MATCH is allowed to rest on

| option | verdict |
| --- | --- |
| a change count taken from the painted composite | **REJECT** — makes the verdict a property of the palette |
| a canonical ink mask plus a physical spatial tolerance | **ADOPT** — the verdict is computed before anything is painted |
| a 0.5% global ratio floor | **REJECT** — unmeasured, and measured to hide real revisions |
| no ratio floor at all | **ADOPT**, and **fixed at zero for the M4 MVP** rather than left as a setting |
| a ratio floor as a configurable option | **REJECT for M4** — there is no control it is needed for and six revisions it hides; the spatial tolerance under H6 is the setting that does this job, in a unit a user can reason about |

The floor introduced in the previous round was justified on the grounds that a
zero floor would make MATCH unreachable. The corpus does not support that: every
control — identical, rotation-only rendered upright, crop-origin, and a redraw
of the same sheet — reaches **exactly 0 differing pixels**.

What the floor did do was hide true changes. Of seven genuine changes on the
small-change corpus, six fall under 0.5% of the ink:

| | pixels | of the ink | zero floor | 0.5% floor |
| --- | --- | --- | --- | --- |
| a light hatch added | 43 | 0.053% | **CHANGE** | MATCH |
| the pale-hatch fixture | 43 | 0.054% | **CHANGE** | MATCH |
| one digit of a dimension | 51 | 0.063% | **CHANGE** | MATCH |
| a 4 mm revision triangle | 160 | 0.198% | **CHANGE** | MATCH |
| one short fine line | 200 | 0.248% | **CHANGE** | MATCH |
| a symbol swapped | 394 | 0.488% | **CHANGE** | MATCH |
| a wall added | 8530 | 9.640% | **CHANGE** | CHANGE |

Render variance is a *spatial* disagreement of a pixel or two along a line, and
the tolerance for it is the physical radius in millimetres applied to the mask,
not a share of the page applied to the total. That is not free either — 0.5 mm
at 150 dpi erases the changed digit outright, 51 pixels to 0 — which is exactly
why the number belongs to the user in units a drawing office already uses.

Presentation independence is asserted rather than assumed: the same changed pair
under three palettes gives a 51-pixel mask and `CHANGE` in all three, while the
count taken from the painted composite reads 51, 0 and 51 depending only on the
colours chosen.

## 7. Requested resolution

| option | verdict |
| --- | --- |
| cap silently, keep the filename | **REJECT** — an A0 asked at 600 dpi delivers 227 and is named `_600dpi.pdf` |
| refuse over budget | **ADOPT** as the floor |
| offer the achievable resolution and let the user accept it | **ADOPT** as the recommendation, subject to a human decision |

Never a silent downgrade. Measured: A0 at 300 dpi and at 600 dpi both deliver
227 dpi and are named differently.

## 8. The render budget

| option | verdict |
| --- | --- |
| reuse the Annotator's 8 Mpx | **REJECT** — that bounds one fragment; this holds several full-page buffers |
| bound one canvas | **REJECT** — understates a 2-layer comparison ~5× |
| bound the whole working set | **ADOPT** |
| model the *shipped* pipeline's buffers | **REJECT for the proposal** — right for the baseline, wrong for the architecture that was selected |
| model the selected pipeline phase by phase, and bound `max(phase)` | **ADOPT** |

Proposed: **512 MiB** (536,870,912 bytes), checked before the first canvas is
allocated.

The shipped pipeline holds every layer's RGBA at once, which is what the
baseline table in `measurements.md` §10 measures: A3 at 300 dpi with two layers
is 487 MB, A1 at 300 dpi is 1951 MB, A0 at 600 dpi is 15.6 GB.

The proposed pipeline does not, and modelling it as though it did would have
left the claim resting on buffers it no longer allocates while omitting the
masks it does. Five phases, `peak = max(phase)`:

| phase | live |
| --- | --- |
| 1 render | one member's canvas (4/px) + its readback (4/px) + masks already extracted (1/px each) |
| 2 mask extraction | the readback (4/px) + every mask (1/px each) |
| 3 dilation | masks + reference dilation + other dilation + one scratch band + two indices |
| 4 comparison | masks + two dilations + the change mask |
| 5 presentation | masks + every dilation + composite (4/px) + encoder bitmap (4/px) + data URL |

Members serial; under reference-pairs, pairs serial with the reference mask and
its dilation computed once and reused. Both are part of the contract — a
parallel implementation has a different peak.

Phase 5 is load-bearing and is asserted rather than assumed: `compositeFromMasks`
is **byte-identical** to the shipped compositor across 34.8 MB of output, at two
and four members, with and without a radius, and with a partly transparent match
colour. So no member's RGBA survives phase 2.

### The encoded output

| option | verdict |
| --- | --- |
| a measured compression ratio (0.15 B/px) as the allowance | **REJECT** — a ratio an unseen drawing can exceed cannot gate a fail-closed budget |
| a stored-block formula applied to `canvas.toBlob` | **REJECT** — the browser owns the DEFLATE strategy, block layout, IDAT chunking and internal scratch, and exposes none of them |
| an **owned** encoder with a stated contract | **ADOPT** — RGBA8, filter 0, stored blocks of 65,535 bytes, IDAT chunks of 1 MiB; output size **exact**, not bounded |
| a base64 data URL in the peak | **REJECT** — 4/3 the bytes at two bytes per character, co-resident with the bytes |
| handing back a `Blob` over the encoded bytes | **ADOPT** — and the budget is taken on it |
| carrying the PNG contract over to JPEG unexamined | **REJECT** — JPEG has no comparable provable worst case; a further reason to prefer PNG, fed to **H5** |

Measured: 8,709,434 bytes predicted and written, on three composites at two
sizes, each decoded back by the browser to identical pixels. 4.001 B/px, with
4,965 bytes of scratch because the encoder streams. The price is the file size —
the browser's PNG made 0.031 B/px — and that trade goes to **H5** rather than
being inherited.

The measured browser ratios remain in the evidence as **performance** evidence.
They are not the safety proof, and what a browser emits says nothing about what
it allocates while emitting it.

### What that permits

Measured at 0.5 mm with two members:

| | peak | |
| --- | --- | --- |
| A4 300 dpi | 139 MB | within |
| A3 300 dpi | **278 MB** | within |
| A2 300 dpi | **557 MB** | **refused** |
| A1 300 dpi | 1115 MB | **refused** |
| A1 300 dpi, four members | 1255 MB | **refused** |
| A0 600 dpi | 8928 MB | **refused** |

Two rows moved when the compression assumption came out, and both are why it
came out. A3 is 278 MB rather than 211 MB — still within, but on a margin that
is derived rather than borrowed from the fixtures. **A2 at 300 dpi is now
refused at 557 MB**, where the ratio-based model called it 423 MB and admitted a
job it could not be sure of holding.

For contrast, the shipped model puts A3 at 487 MB — inside the ceiling, counting
the wrong buffers; adding the four mask buffers to that figure would have given
about 557 MB and refused it. Neither number described the architecture that was
chosen.

### Where the finished bytes live

The phase model bounds a page, not the operation: nothing is published until
every page succeeds, and reference-pairs makes *n − 1* visuals per source page.

| option | verdict |
| --- | --- |
| retain every finished visual in RAM until the save | **REJECT** — measured: 5 pages × 4 members is 1044 MB at publish while each page peaks at 157 MB |
| hand them over as base64 data URLs, which is what ships | **REJECT** — the same job becomes 1914 MB; `jsPDF.addImage` is handed one per page |
| encode, append to a browser-local sink, release | **ADOPT** — the publish phase holds one 4 MiB chunk for 5 pages or for 200 |
| assemble and publish only after every page succeeds | **ADOPT** |
| an explicit `MAX_OUTPUT_BYTES` with fail-closed preflight | acceptable **only** if the container must stay memory-resident, which `jsPDF` today forces |
| a new external or cloud service | **REJECT** — out of scope and out of the trust boundary |

Measured atomicity, on three-page runs: completed publishes a 6.0 MB artifact;
cancelled midway leaves **2 of 3 pages staged and no artifact**; superseded
before publish leaves **3 of 3 staged and no artifact**. The spool is discarded
in every case.

The artifact shape is stated rather than incidental — one source page becomes
*n − 1* pair results in slot order, each naming its members, identically in the
preview, the comparison PDF and the change report.

Which sink ships decides how large a drawing set the tool accepts, so it is a
product decision: **H11**.

The 512 MiB itself is a judgement about how much memory one comparison may
claim, not a threshold discovered in the data, and it is written down as one:
**H7**.

## 9. Export format

| option | verdict |
| --- | --- |
| JPEG (today) | **DEFER** — see `limitations.md`; artefact cost unmeasured |
| PNG | **DEFER** — lossless, larger |

Not settled here. The comparison output is a report rather than a preserved
source document, so vector preservation is not required of it — but whether
JPEG artefacts degrade the change evidence was not measured, and is listed as an
open question rather than answered.

## Summary

Every ADOPT below is a **research recommendation**, not a decision. Where the
choice is a product question — geometry-mismatch behaviour, missing-page policy,
over-budget behaviour, alignment persistence, export format, threshold unit, the
512 MiB working set, the work ceiling, the ink predicate, and the multi-member
contract — the Human Gate chooses, and `README.md` lists them.

| | |
| --- | --- |
| **RESEARCH RECOMMENDATION** | **A + B.** Strict validation decides whether a comparison is meaningful; canonical upright normalisation handles rotation and crop origin, which are provable, and maps by the identity or refuses. Plus: upright rendering, a verdict computed from a canonical ink mask with no ratio floor, a physical threshold in millimetres, a working-set budget and a work budget both checked before allocation, a comparison that can be abandoned, structured results rather than only a picture, and atomic export. This is a complete feature: it stops the tool reporting its own coordinate handling as a design change. |
| **CONDITIONAL FOLLOW-ON** | **Candidate C** (human alignment). Recommended *only* if the Human Gate answers H1 with "offer human alignment", and then only after an Alignment Architecture Sub-Spike settles the transform contract — see §5b. Not implementation-ready in this round. |
| **REJECT** | **Candidate 0.** Not as an implementation detail — as a contract. Its single verdict is what makes a wrong answer indistinguishable from a right one. |
| **DEFER** | **Candidate D** (automatic registration), **all-member consensus** (§4b), the JPEG/PNG question, and the alignment UI. |

## What this does not claim

The comparator is not fixed. Nothing here has been implemented in `src/`. What
has been established is that four named failures are real and reproducible, that
three of them are settled by arithmetic rather than by policy, and that the
fourth needs a human decision that is listed in `architecture.md`.
