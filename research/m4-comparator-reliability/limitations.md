# M4 limitations

What this spike did not establish. Listed rather than left for a reviewer to
notice.

## The corpus is synthetic, and one drawing

Forty-two fixtures, drawn from two generated plans: a border, a title block, a
five-by-four grid, one labelled string and a wall that moves, plus a second base
sheet carrying a dimension string, a symbol and the small marks a revision is
actually made of.
Real construction drawings carry dimension strings, hatch, text at several
sizes, symbols, xrefs and scanned underlays, and they are produced by CAD
exporters whose output this does not imitate.

The geometry findings do not depend on the drawing — a sheet size is a sheet
size — but every *ratio* here does. "99.4% of ink flagged" is 99.4% of this
drawing's ink.

## The change set is small, and still synthetic

The corpus now carries changes at the scale a revision actually has — a digit in
a dimension edited, a symbol swapped, a short fine line, a 4 mm revision
triangle, a light hatch — alongside the walls. They are what §4f of
`measurements.md` rests on.

What is still missing: text reflowed by a font substitution, a revision cloud,
a scanned raster underlay, and anything drawn by a real CAD package rather than
by `pdf-lib`. The smallest change measured is 43 pixels at 150 dpi, and nothing
establishes that 43 pixels is the smallest change a *user* would want caught.

The 9.6% figure for "a real change" is one change on one drawing, and it is used
here only as a control — to show the detector works — not as a claim about
sensitivity.

## The baseline's false-change numbers are a proxy

The `changeRatio` in section 1 counts composite pixels whose channels are far
apart, i.e. painted in a layer colour rather than the matched colour. That is a
good proxy for "the shipped tool is calling this a change" and it is not the
same as what a user would judge. A 99.4% and a 75.9% are both "almost
everything"; the gap between them is not meaningful.

It is also **presentation-dependent**, which §4g measures rather than assumes:
give both layers the same grey and the same genuinely-changed pair counts zero.
The proposed verdict is computed from the ink masks instead, and the baseline
figures are kept in that form only because they describe what the shipped code
does.

## The worst case is measured, but only on one shape

A non-matching pair is now in the corpus: 1.09 us per ink pixel against 0.73 us
when the drawings match, at radius 3. That is the effect isolated, and isolating
it required normalising by ink pixel — the adversarial pair is the *sparser*
drawing, so wall-clock page times would have credited it for having less to do.

What is still missing is the shape of the worst case beyond this one pair. The
dense fixtures are short horizontal strokes; a drawing dense in a different way —
fine hatch, dense text, a photographic underlay — could behave differently, and
the ink fraction here (1.7-1.9%) is low for a busy construction sheet.

The work bound in `architecture.md` is arithmetic, not measured at scale: no
comparison near the proposed ceiling was run to completion, deliberately.

## H10 bounds the comparison, not the wait

The calibration measures `pairChangeMask` on masks that already exist. It
excludes PDF.js rendering, the RGBA readback, ink-mask extraction, the
task-boundary yields, painting the pair visuals, PNG encoding, container
assembly and the final artifact — several of which are, on the evidence
elsewhere in this document, larger than the comparison itself. A single A4 page
renders in tens of milliseconds and encodes in more.

So "about 22 seconds" is **comparison-kernel** time and no claim is made about
how long a person waits. If H10 is wanted as a wall-clock bound, it needs an
end-to-end calibration from render through publish, which this research has not
done.

## The work ceiling is calibrated on one number, on one machine

`MAX_COMPARISON_WORK_UNITS = 12,000,000,000` is calibrated against
`separable-dilation`, the algorithm the planner is bound to, from the worst of
five measured cost-per-unit figures and projected linearly to about 22 seconds.
Three things about that are weak, and are why it is a recommendation requiring
approval rather than a finding:

- It is one machine and one browser. A slower machine gets a proportionally
  longer worst case at the same ceiling.
- The projection is linear in work units, and nothing here measures a comparison
  anywhere near 12e9 units to check that it stays linear. Cache behaviour at
  that size is unknown.
- The judgement being asked for is **how much comparison one operation may
  claim**, made without asking anyone. It is not a judgement about how long a
  person waits: the projection covers the comparison kernel and excludes
  rendering, readback, mask extraction, yields, painting, encoding and container
  assembly. The 173-A4-page reading of the same number is the form the Human
  Gate is more likely to have an opinion about, and it carries the same
  caveat.

The *shape* of the bound is better founded than its value: it is conservative
about the ink fraction on purpose, and the radius-0 case demonstrates that the
previous shape was not a bound at all.

The second weakness is sharper than it sounds: the largest case measured is 139
million units against a ceiling of twelve billion, so the linear projection
spans a factor of 86 with nothing measured in between.

Under this algorithm the ceiling also barely binds on a single page — an A1 at
300 dpi is 5% of it, and memory refuses first. It exists for ranges, and no
range was run.

The job-level accumulation is arithmetic as well. **No multi-page job was
actually run** — not 173 pages, not an export range, not a change report over a
document. What is established is that the sum is computed, that pages which
cannot be compared stay in the plan, and that a job whose pages individually
pass can be refused. Whether five pages take five times as long in practice is
not measured, and page-to-page variation in ink fraction means it probably does
not.

## The budget is a judgement, not a discovered threshold

512 MiB is chosen, not found. Where to draw the line is a decision about how much
memory one comparison may claim on a machine nobody has specified.

Nothing over the budget was allocated, so the failure mode past it is
**calculated, not observed**. Whether a browser fails cleanly or takes the tab
with it at 2 GB is untested here, and deliberately so.

## The phase memory model is arithmetic, and it models a design

The peak working set is computed from the page size, the member count and the
tolerance. **No comparison was run and watched to see whether the peak it
actually reaches matches the model.** The model is a statement about which
buffers the proposed implementation is allowed to keep alive, and an
implementation that keeps one more is not covered by it.

Two of its terms are firmer than the rest. The presentation phase rests on
`compositeFromMasks` being byte-identical to the shipped compositor, which is
asserted over 34.8 MB of output; and the encoded-output term is exact for the
owned encoder, asserted by encoding and by decoding back. Everything else — that a canvas is released
before the next member is rendered, that the reference mask survives all the
pairs and nothing else does — is a contract the implementation has to honour,
not a behaviour that was observed.

Garbage collection is also not instantaneous. The model assumes a released
buffer stops counting immediately; a real heap may hold two while it catches up.

## The spool path is prototyped, and it is not implementation-ready

What the prototype does establish: browser-local staging with no new dependency
and no external service; bounded chunks on the way in **and** on the way back
out; nothing published after a cancellation; nothing published after a
supersession; run-scoped namespaces so two tabs cannot delete each other's
staged output; and ownership-aware cleanup.

What it does not, which is why the spool path is **conditional on an Output
Writer Sub-Spike** rather than ready to build:

- **no comparison PDF was assembled from a spool.** The parts are concatenated
  into one file to prove the lifecycle. A container has structure, and `jsPDF`
  as used today builds the whole document in memory, so a bounded streaming
  writer is a requirement this research states rather than a component it built.
- no reopen validation: nothing checked page count, dimensions or orientation
  on a produced artifact, because there is no produced artifact to check.
- storage quota is checked as arithmetic against a reported estimate, not
  against a browser that actually refused a write. `navigator.storage.estimate`
  is advisory and may be quantised; a quota that says 1.2 TB is not a promise.
- no crash or tab-close was simulated. The recovery rule — reclaim only
  namespaces no live run claims — is stated and unit-checked, not exercised
  against a real abandoned run.
- the spool is written and read on the main thread in the prototype.

The 4 MiB write chunk and the 4 MiB publish chunk are chosen, not derived.

## The RAM-bounded MVP is small, and that is the trade

The recommended M4 sink is the memory-resident container, because it is the one
that can be built now. Under the owned encoder's exact 4.001 bytes per pixel
that accepts **7 A4 pages at 300 dpi with two members** before the output
ceiling refuses — two pages of a four-member comparison. A drawing set is
larger than that.

This is the H5 decision arriving in H11's clothing: the exact bound and the
small job are the same choice. A compressing encoder would accept hundreds of
pages and give up the exact size guarantee. Neither option is free and the
research does not pick between them.

## Ownership is proposed; scheduling is measured, integration is not

The ownership section in `architecture.md` reuses M3's shape — a mount flag and a
generation counter. In the prototype that shape works: a run superseded
mid-flight returns `publishable: false` and no result.

What is measured is the *scheduling contract*: given the same cancellation, a
synchronous driver ran to completion in 23 ms without ever seeing it and
published a verdict, while a driver that yields to a task boundary between bands
stopped at band 4 of 18 with nothing to publish. That is the difference between
"there is a decision point" and "something can reach it", and the previous round
had only established the first.

What is **not** measured:

- nothing ran inside a Web Worker, over `postMessage`;
- no real UI supersession was exercised — no unmount, no document swap, no
  layer toggled, no threshold moved, against a comparison that was running;
- the yield is `setTimeout(…, 0)` on the main thread, which is a task boundary
  but not the scheduling a production worker loop would use.

The production implementation gate has to exercise the real thing.

## The pairwise presentation is measured as pixel counts, not as a design

§4h establishes that a reference-pairs result painted pair by pair shows the
disagreement the any-other-member composite hides, and that the pixels shown
match the pixels the verdict counted. It does **not** establish how three pair
visuals should be presented to a person: side by side, stacked, switchable, or
one at a time with the differing members listed. That is interface design and no
interface was built or shown to anyone.

Nor does it establish what happens with the *pages* of a multi-member
comparison, or how a pair visual is exported — the export is one image per page
today, and three pairs are three images.

## The spatial tolerance ceiling comes from one fixture

`maximum: 0.15 mm` is the **minimum** across 72, 150, 300 and 450 dpi of the
largest setting at which the *dimension-digit* fixture is still reported as
changed. Sweeping all four resolutions is what caught it: 150 and 300 dpi alone
would have justified 0.25 mm, and 72 dpi loses the change at 0.2 mm.

It is still one change, drawn at one size, in one font, on a sheet this corpus
generated. A smaller mark — a hairline leader, a 2 mm symbol, text at 1.8 mm cap
height — would move the number, and nothing here establishes that 0.15 mm is
safe for marks the corpus does not contain. The ceiling is a floor under the
problem, not a proof about drawings in general.

## The encoder is owned, which moves the limitation rather than removing it

`pngStoredSize` is exact for `encodePngStored` — asserted by encoding real
composites and comparing lengths, and by decoding them back losslessly. What it
is **not** is a statement about `canvas.toBlob`: the browser's encoder owns its
DEFLATE strategy, block layout, IDAT chunking and internal scratch, and this
architecture would no longer use it.

That is a real cost, stated rather than buried: stored blocks do not compress,
so the output is **4.001 B/px against the browser's 0.031** — roughly 130 times
larger. A comparison PDF of a long drawing set would be very large. Whether that
trade is acceptable is a product decision (**H5**) and this research does not
make it.

**JPEG has no comparable provable worst case here.** If H5 chooses JPEG, the
allowance has to be re-derived for whatever encoder produces it.

The encoder itself is a research prototype: correct on the sizes tested and not
hardened. It has no interlace, no palette, no 16-bit path, and no defence
against a caller passing mismatched dimensions.

## The multi-member contract is measured, not chosen

Four-member sets are measured — a two-against-two split is reported as a clean
match by the shipped rule, and caught by reference-pairs — but which of the two
implemented contracts to adopt is a product question listed as H9.

All-member consensus is described and **not measured**: no consensus
implementation was run against the corpus. It is therefore refused by
`planMultiMember` rather than offered, which is a change from the previous round
— an option nobody has run should not sit in a table beside two that have been.
Making it selectable means first measuring it against four identical members,
three the same and one changed, two against two, a reference against three
different documents, one blank member, one missing member, and one member that
failed to render.

The 3- and 4-way fixtures are the same plan with the wall in one of two places. A
real four-way revision set would differ in more ways than that.

## Human alignment has no transform contract

Candidate C's refusal is researched. Its transform is not: the prototype records
`{ x, y, rotation, scale }` and defines none of it — coordinate space, units,
transform order, rotation pivot, whether scaling may be non-uniform, bounds,
validation, how it composes with CropBox and upright normalisation, what the
memory and work estimates become afterwards, or how it is saved as provenance.
**No aligned comparison has been run end to end**, so no aligned MATCH or CHANGE
exists anywhere in this evidence.

Supplying an alignment therefore returns `UNSUPPORTED` rather than
`READY_TO_COMPARE`, changed from the previous round. If the Human Gate answers
H1 with "offer human alignment", an Alignment Architecture Sub-Spike is required
before M4 production implementation.

## Automatic registration was not implemented or measured

Deliberately. It is listed as DEFER on the grounds that a repeating grid, a
repeated title block and a common border are strong features that can align
confidently in the wrong place. That is an argument, not a measurement, and it
should be stated as such: **no registration algorithm was run against this
corpus**.

## JPEG artefacts were not measured

The export is JPEG at quality 0.85. Whether that degrades change evidence — a
hairline that survives at PNG and does not at JPEG — was not tested, and the
JPEG/PNG question is left open rather than answered.

## The comparison PDF was not reopened

The brief asks for the exported comparison to be reopened and checked for page
count, dimensions, orientation and renderability. This spike measured the
compositing and the geometry, not the jsPDF assembly, so **that check was not
run**. It belongs in the implementation's gate.

## Ink detection is described, not fixed

The two functions disagree, and one colour that demonstrates it was found. What
the *right* ink test is — for antialiased CAD linework, for coloured layers, for
hatch — is not answered here. A pale grey hatch is invisible to both, which is
recorded as a current limit rather than proposed as acceptable.

## The three pipelines were compared on paper, not driven

The divergence between the preview, the export and the change report is
established from their source and from arithmetic on their scale formulas.
**None of the three was driven through the real UI in this spike**, so the 281 GB
figure for the change report is what it would *ask for* — not something that was
allocated, and not a failure that was observed. The parity requirement in
`architecture.md` is written as a production gate precisely because it was not
executed here.

## One machine, one browser

Headless Chromium on one laptop. Every millisecond figure is that machine.

## What this does not claim

The comparator is not fixed. Large-format comparison is not supported — it is
*bounded*, which is a different statement. Automatic alignment is not shown to be
unreliable either; it is untested. Nothing here has been implemented in `src/`.
