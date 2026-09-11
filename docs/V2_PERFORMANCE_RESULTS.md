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

---

# V2 Performance Results — Phase 2

**Before:** Phase 1 · **After:** Phase 2, two commits
**Data:** `performance-audit/data/v2-phase1-gzip.json` → `v2-phase2-gzip.json`
**Date:** 2026-09-10

Same gzip server on :8100, same 600 ms mocked API latency, same profiles, same
machine, idle. Compressed, because GitHub Pages serves compressed.

---

## Headline

| Page | Profile | Phase 1 | **Phase 2** | Change |
|---|---|---|---|---|
| index | **mobile-slow3g** | 2560 ms / 67 KB | **1484 ms / 31 KB** | **−42%** |
| store | **mobile-slow3g** | 2948 ms / 84 KB | **1612 ms / 39 KB** | **−45%** |
| index | mobile-4g | 460 ms / 67 KB | **312 ms / 31 KB** | −32% |
| store | mobile-4g | 476 ms / 84 KB | **320 ms / 39 KB** | −33% |
| product | mobile-4g | 460 ms / 85 KB | **296 ms / 40 KB** | −36% |
| categories | mobile-4g | 428 ms / 67 KB | **288 ms / 34 KB** | −33% |
| stores | mobile-4g | 344 ms / 66 KB | **280 ms / 29 KB** | −19% |
| index **[warm]** | mobile-4g | 212 ms / 0 KB | **96 ms / 0 KB** | −55% |

**The slow-3G figure is the one that matters.** A first-time visitor on the kind
of connection this site is built for now paints in about 1.5 seconds instead of
2.6. That is the largest single improvement in the V2 work.

### This is not noise, and here is the proof

Phase 1 correctly refused to claim an LCP win, because its deltas sat inside the
measurement's own scatter. Phase 2's do not. The same configuration — index,
mobile-4g, 600 ms — appears **eight times in this one sweep** and returns:

```
288  292  296  300  304  304  312  312
```

A ±12 ms band. The baseline range for that same configuration was 448–464 ms.
The two ranges do not overlap, and the gap is roughly six times the noise floor.

---

## What changed

One thing: the pages stopped shipping their comments.

38% of `styles.css` and 47% of `helpers.js` was comment text. Gzip does not hide
it — measured across the tree, comments cost **69.7 KB gzipped**, and about
29 KB of that landed on the homepage alone.

| Asset | Phase 1 gzipped | Phase 2 gzipped |
|---|---|---|
| `assets/css/styles.css` | 28,725 | **10,214** |
| `assets/js/helpers.js` | 21,280 | **8,707** |
| whole tree, 40 files | 160,580 | **103,643** |

The comments are worth keeping, so the **sources keep every one of them** and
the pages load generated `.min` copies. `tools/build-assets.js` produces them;
`npm run build` runs it.

### Deliberately not done

**No code transformation.** terser runs `compress: false, mangle: false`;
clean-css runs at level 1. Mangling would rename globals other modules reach for
by name (`Cart`, `Api`, `Helpers`), and clean-css level 2 merges and reorders
rules — which can change the cascade where two selectors have equal specificity,
a trap this branch hit twice. The whole win is comments and whitespace; neither
transformation was worth the risk for a few hundred more bytes.

**`sw.js` is not built.** A broken service worker is the one failure on this site
that keeps hurting after it is fixed, because it can serve stale content to
returning visitors indefinitely. Leaving it alone costs 2 KB gzipped.

---

## The new hazard, and what closes it

A committed build can go stale: edit a source, forget `npm run build`, and the
site quietly serves the old code with **nothing visible in the diff**.

`tests/verify-minified.js` (18/18) closes it on three fronts:

1. **Freshness** — re-minifies every source and byte-compares what is committed.
2. **Wiring** — no page may load a source asset that has a built twin; every
   `.min` file a page references must exist.
3. **Equivalence** — renders 15 pages twice, source CSS against minified CSS
   swapped in at the network layer, comparing **every element's computed style**
   across 43 layout, box, type and colour properties. About 1,700 elements per
   run. Byte-comparing can only prove the build is current; this is what shows
   the minifier did not change what a rule *means*.

---

## Regressions

**None in the product.** The sweep flagged six suites; every one was a test
naming a source file, and every invariant they guard was verified to still hold
before a test was touched.

One of them looked like a real behaviour failure. `verify-perf` stubs
`**/assets/js/store.js` to an empty body to prove the chat window falls back to
its own fetch when no page publishes store info. With the page loading
`store.min.js` the glob stopped matching, so the real script ran, published
`__storeInfoPromise`, and the fallback never fired. A naming problem wearing a
behaviour problem's clothes.

All six now match `/foo(\.min)?\.js/` — asserting that the **module** is
precached or loaded, not which build of it. Pinning the new name would have made
them fail if the build were ever turned off.

`verify-grey` crashed in the sweep and passes 9/9 alone: the server drop under
load that `tests/README.md` documents.

---

## A measurement I threw away

The first Phase 2 run passed `AUDIT_OUT` a full path when the script wants a
bare name. It built the output path twice over, crashed on the write — which
happens *before* the table is printed — and produced nothing. Re-run correctly
rather than reconstructed from the partial output.

## Not tested

A real phone, a real network, or GitHub Pages itself. Every figure here is
throttled headless Chromium against a local server with the backend mocked.
