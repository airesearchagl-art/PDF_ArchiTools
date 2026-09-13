# Preview memory

The Extract preview renders **every** page of a source at `scale: 1.5` and keeps
each one as a base64 PNG Data URL in React state, before the user has selected
anything. This is what that costs, measured in the browser by
`scripts/browser-gate.mjs` driving the production route.

## What was measured, and what it is worth

| quantity | basis | why |
| --- | --- | --- |
| retained Data URL bytes | **EXACT** | a base64 string costs what it costs; counted as UTF-16, which is how a JS engine holds it |
| peak canvas RGBA | **EXACT** | `width × height × 4` for the largest page |
| elapsed ms | MEASURED_ONLY | machine-dependent |
| `performance.memory` delta | MEASURED_ONLY | Chrome-only, quantised, moves with collection nobody controls |

No bound in this research is derived from a heap reading. Where a number has to
hold, it comes from the first two rows.

## The current strategy (P1), by page count

| source | pages | retained | peak canvas | elapsed |
| --- | --- | --- | --- | --- |
| `pages-10` | 10 | 0.8 MiB | 4.3 MiB | 252 ms |
| `pages-50` | 50 | 4.2 MiB | 4.3 MiB | 891 ms |
| `pages-100` | 100 | 8.4 MiB | 4.3 MiB | 1,728 ms |
| `pages-200` | 200 | **16.9 MiB** | 4.3 MiB | 3,393 ms |

**88,616 B retained per A4 page**, linear, with no ceiling in the code. Time is
linear too, and it is all spent before the first thumbnail appears, because the
loop fills an array and calls `setExtractPages` once at the end.

## Large format

| source | pages | retained | peak canvas |
| --- | --- | --- | --- |
| `pages-10-a1` | 10 × A1 | 5.1 MiB | **34.4 MiB** |

**538,997 B per A1 sheet — 6.2× the A4 figure** — and the peak canvas is 8× the
A4 one, because `scale: 1.5` is applied to a sheet 5.6× the area. A 100-page A1
drawing set is the ordinary case for this product's users, and it extrapolates
to roughly **51 MiB of retained thumbnails plus a 34 MiB canvas**, none of it
bounded and none of it asked for.

## The alternatives, priced on the same 100-page source

| strategy | retained | note |
| --- | --- | --- |
| **P1** all pages as Data URLs (current) | 8.4 MiB | 1,727 ms before anything is shown |
| **P2** a 12-page window | **1.0 MiB** | renders what is on screen; `page.cleanup()` and canvas release after each |
| **P3** Blob URLs for the same window | **0.4 MiB out of the JS heap, 0 B in it** | the bytes live in the blob store; each URL must be revoked |
| **P4** regenerated cache | not separately measured | P2 plus discard-and-redraw on scroll; strictly between P2 and re-rendering cost |

P2 and P3 were measured through the same render path as P1, so the comparison is
between strategies rather than between implementations.

## Cleanup semantics

| | P1 (current) | P2 | P3 |
| --- | --- | --- | --- |
| canvas released | no | yes (`width = height = 0`) | yes |
| `page.cleanup()` | no | yes | yes |
| `pdf.destroy()` | no | on unmount | on unmount |
| retained bytes released | only when React state is replaced | on scroll out | on `revokeObjectURL` |

The measured lifetime facts that go with this: across five exports the current
code created **5 object URLs and revoked 0**, and a PDF.js document opened for a
preview is still usable afterwards — it is never destroyed.

## Scroll usability and complexity

- **P1** — every thumbnail is present, so scrolling is instant once the wait is
  over; the wait is the problem, and so is the unbounded retention.
- **P2** — needs an intersection observer and a render queue; scrolling shows
  placeholders briefly. Bounded by construction.
- **P3** — same machinery as P2 plus explicit revocation. Cheapest in heap; a
  missed revoke is a leak that outlives the component, so it needs the same
  ownership discipline as publication.
- **P4** — most complex; only worth it if re-rendering proves cheaper than
  holding, which at 88 KB a page it does not obviously do.

## Recommendation for the M6 MVP

**P2, with P3's Blob URLs for the window it keeps** — a bounded window of
rendered pages, each released when it leaves, thumbnails held as Blob URLs
rather than base64 strings, and the whole cache owned by the run so that
superseding it releases everything.

The reason is not that P1 is slow. It is that P1 has **no bound at all**: the
cost is set by the document the user happens to open, and the product currently
promises nothing about it. A bounded window turns preview cost into a number the
product chooses. This is a recommendation, not an adoption — see
[`human-gate.json`](human-gate.json) M6-H12.
