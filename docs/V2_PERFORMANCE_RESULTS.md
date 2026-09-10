# V2 Performance Results — Phase 1

**Before:** `39cd862` (tag `v1-pre-v2-baseline`) · **After:** Phase 1, three commits
**Data:** `performance-audit/data/v2-baseline-gzip.json` → `v2-phase1-gzip.json`
**Date:** 2026-09-10

Both runs: gzip server on :8100, 600 ms mocked API latency, same profiles, same
machine. Compressed, because GitHub Pages serves compressed.

---

## Headline

| | Before | After |
|---|---|---|
| **Product-page CLS** | 0.0727 | **0.0262** |
| **Search-page CLS** | 0.0359 | **0.0037** |
| LCP, every page | — | **unchanged** |
| Bytes / requests | — | **unchanged** |
| Regressions | — | **none** |
| Known-failing suites | 8 | **6** |

Both CLS figures were already under the 0.1 target. They are now well under it,
and the product page no longer carries a shift introduced during this session.

---

## CLS — the thing Phase 1 targeted

| Page | Before | After | Change |
|---|---|---|---|
| product | 0.0727 | **0.0262** | **−64%** |
| search | 0.0359 | **0.0037** | **−90%** |
| index | 0.0001 | 0.0001 | — |
| store | 0.0001 | 0.0001 | — |
| categories | 0.0001 | 0.0001 | — |
| cart | 0 | 0 | — |
| customer-dashboard | 0 | 0 | — |

Nothing moved except the two pages that were targeted. That is the intended
shape: a change that improves one page and quietly disturbs another is not an
improvement.

### Product page

The similar-products carousel (added in PR #35, this session) un-hid itself
after an async request with no reserved height, pushing everything below it
628 px — 0.0388 on its own. It now renders three placeholder cards **before**
the request goes out.

The skeleton is built from the same `.related-card` box rather than a fixed
`min-height`, because the card is a percentage of the carousel width and its
image is `aspect-ratio: 1/1`, so the row height follows the viewport — measured
at **219 px at 390 px wide, 260 px at 768 px, 272 px at 1280 px**. A pixel
value would have been right at one width and wrong at every other.

Residual 0.0262 is the empty-category case: a listing whose category holds
nothing else shows a shelf that then collapses. One shift where there was one
shift before, and the alternative was leaving grey boxes up permanently.

### Search page

`.is-reserving-space` puts `min-height: 100vh` on a list's status line so
arriving content does not push the page down. On search it backfired: the grid
is short multi-column cards that do not fill a viewport, so **releasing** the
reservation collapsed an 844 px element to one line, and that collapse was the
jump. The baseline attribution named `P#results-status` — the reserving
element itself, not the content it was protecting.

Not a new discovery: `categories.html` already carried a note recording the
same overshoot (`CLS 0.014 → 0.133`). This applies it consistently.

Tested across the cases that could have gone the other way — 4, 8, 24 and 40
results, with "Load More" both hidden and visible. Identical every time
(0.0359 with, 0.0037 without), because the measured shift is the element's own
collapse, not the grid filling below it.

**`index.html`, `store.html` and `stores.html` keep theirs.** All three measure
~0.0001, so the reservation costs them nothing, and removing it would be a
change with no evidence behind it.

---

## LCP — unchanged, and that is the expected result

| Page | Profile | Before → After |
|---|---|---|
| index | mobile-slow3g | 2620 → 2560 |
| store | mobile-slow3g | 2896 → 2948 |
| index | mobile-4g | 456 → 460 |
| product | mobile-4g | 464 → 460 |
| search | mobile-4g | 468 → 456 |
| index [warm] | mobile-4g | 168 → 212 |

Deltas scatter both ways in a ±60 ms band. **That is noise, not signal**, and
the run itself proves it: the *same* configuration (index, mobile-4g, 600 ms)
appears six times in one sweep and returns **448, 452, 456, 460, 464, 464**. So
the noise floor is roughly ±20 ms per reading, and no delta here clears it.

Phase 1 changed *when layout settles*, not *how many bytes arrive*. Transferred
weight and request counts are byte-identical to baseline: 67 KB / 17 requests
on index, 84 KB / 23 on product. **Load time was never going to move, and it
did not.** Anything claiming otherwise would be reading noise.

Per Finding 1 of `V2_BASELINE.md`, the load-time lever is bytes — `styles.css`
(28 KB gzipped, render-blocking, 22 pages) and `helpers.js` (21.5 KB, 22
pages). That is Phase 2 work.

### A measurement mistake worth recording

The first post-Phase-1 run was taken **while the 92-suite test sweep was still
running**, and both compete for CPU. It showed `categories.html` LCP going
452 → 604 on a page no Phase 1 commit touches. That file was deleted rather
than committed, and the run repeated on an idle machine. A knowingly
contaminated measurement is worse than none.

---

## Regressions

**None.** Full 92-suite sweep after Phase 1:

- **6 known-failing**, down from 8: `verify-card`, `verify-cookie`,
  `verify-emailpopup`, `verify-install` (crashes), `verify-cartfab` 13/15,
  `verify-custauth` 11/14 — plus `verify-more-colors` 27/28, which fails on
  `main` independently.
- **No new failures.** `verify-searchbtn` crashed in the sweep but passes 15/15
  twice individually — the server drop under load that `tests/README.md`
  documents.

### Two dead suites revived

Neither was failing. Both were *not executing*, while being counted as known
failures:

| Suite | Was | Now |
|---|---|---|
| `verify-fab` | timed out at 390 px waiting for a cookie banner deliberately hidden below 1024 px — it tested an overlap that can no longer happen | **9/9**, rewritten to guard the invariant that replaced it |
| `verify-searchwidth` | **syntax error** — an unterminated string on line 44; the file never loaded | **9/9** after one closing quote |

`verify-searchwidth` covers search-box width on exactly the page Phase 1
changed, so it went from guarding nothing to guarding the change.

---

## What I got wrong

I tried un-hiding the reviews section, reasoning it shows for every product
anyway so `hidden` only bought a shift. **CLS went 0.0727 → 0.1385**, over the
target. Reverted immediately rather than stacking a second change on a broken
one.

After the carousel was fixed I retried it, expecting the first failure to have
been an ordering artefact. **Worse again in both cases** — 0.0262 → 0.0798
empty, 0.0246 → 0.0715 populated. The reason: `#product-detail` is itself
rendered by JS after first paint, so a reviews block visible from the start is
one more thing for *that* render to push down. Keeping it hidden until the
product has rendered is correct. The change is in no commit.

---

## Phase 1 commits

| Commit | Change |
|---|---|
| `7c43b7b` | 91 regression suites committed — the rollback rule now has something to re-verify against |
| `ecca0be` | Skeleton reserves the similar-products shelf |
| `ac1caaa` | 100vh reservation removed from search; `verify-searchwidth` revived |

`sw.js` `CACHE` → `mwakete-v47`. **No `.gs` file touched — no Apps Script
redeploy needed.**

## Not tested

A real phone, a real network, and GitHub Pages itself. Every figure here is a
throttled headless Chromium against a local server with the backend mocked.
