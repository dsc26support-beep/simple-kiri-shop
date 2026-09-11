# V2 Performance Baseline

**Commit:** `39cd8627aea5ddd15b13365569f7da631f608f07`
**Tag:** `v1-pre-v2-baseline` — restore with `git checkout v1-pre-v2-baseline`
**Branch:** `claude/kiribati-shoppers-landing-bpvk5q`
**Working tree at capture:** clean
**Date:** 2026-09-10

Raw data: `performance-audit/data/v2-baseline.json` (uncompressed) and
`performance-audit/data/v2-baseline-gzip.json` (compressed — **the realistic
one**). Captured with the existing harness in `performance-audit/scripts/`.

This file **adds to** the existing performance records. It does not replace
`docs/production-readiness-report.md` or `docs/chat-performance-optimizations.md`.


> **Superseded on one point.** `search.html` was removed after this was
> written; `categories.html` absorbed browsing and site-wide search. The
> measurements below are still an accurate record of commit `39cd862` and are
> deliberately left as they were taken.

---

## How to read these numbers honestly

**Use the gzipped table.** GitHub Pages serves compressed, and compression
roughly halves LCP here (index on slow-3G: 5452 ms uncompressed → **2620 ms**
gzipped). The uncompressed run is kept only to show what compression is worth.

**Document TTFB is localhost TTFB** and says nothing about GitHub Pages. What
the harness measures truthfully is everything the browser does with the bytes:
parse, execution, layout, paint, request count, transferred weight, and how
those respond to CPU and network throttling.

**The backend is mocked at a configurable latency**, so backend time is
separated from frontend time rather than guessed at.

Profiles: `mobile-4g` = 390×844, 4× CPU throttle, 4 Mbps/70 ms.
`mobile-slow3g` = 390×844, 6× CPU, 400 kbps/400 ms. `desktop-slow` = 1.6 Mbps/150 ms.

---

## Baseline — gzipped, 600 ms mocked API latency

| Page | Profile | FCP | **LCP** | **CLS** | Req | **KB** | API calls | Long tasks |
|---|---|---|---|---|---|---|---|---|
| index | mobile-4g | 496 | **496** | 0.0001 | 17 | 67 | 2 | 256 ms |
| store | mobile-4g | 500 | **500** | 0.0001 | 23 | 84 | 6 | 249 ms |
| product | mobile-4g | 464 | **464** | **0.0727** | 23 | 84 | 5 | 170 ms |
| search | mobile-4g | 468 | **468** | **0.0359** | 15 | 78 | 2 | 214 ms |
| categories | mobile-4g | 452 | **452** | 0.0001 | 15 | 67 | 3 | 172 ms |
| cart | mobile-4g | 468 | **468** | 0 | 14 | 78 | 0 | 158 ms |
| stores | mobile-4g | 348 | **348** | 0 | 13 | 66 | 1 | 58 ms |
| customer-dashboard | mobile-4g | 420 | **420** | 0 | 10 | 60 | 0 | 53 ms |
| **index** | **mobile-slow3g** | 2620 | **2620** | 0 | 17 | 67 | 2 | 265 ms |
| **store** | **mobile-slow3g** | 2896 | **2896** | 0.0001 | 23 | 84 | 6 | 337 ms |
| index | desktop-slow | 696 | 696 | 0 | 18 | 67 | 2 | 0 |
| index | desktop-fast | 96 | 96 | 0 | 18 | 67 | 2 | 0 |
| index **[warm]** | mobile-4g | 168 | **168** | 0.0001 | 16 | **0** | 3 | 54 ms |
| store **[warm]** | mobile-4g | 232 | **232** | 0.0001 | 21 | **0** | 10 | 223 ms |

### The three numbers that matter

1. **Slow-3G first visit: 2620 ms (index) / 2896 ms (store).** This is the
   Kiribati-relevant figure and the one worth moving.
2. **Warm repeat visit: 168 ms and 0 KB transferred.** The service worker is
   already doing its job extremely well. Repeat visits are not the problem.
3. **Product-page CLS 0.0727.** Under the 0.1 target, but the highest on the
   site, and *worse than it was this morning* — see below.

---

## Finding 1 — page load is asset-bound, not backend-bound

Backend latency was swept from 0 ms to 2500 ms on `index.html`, mobile-4g:

| Mocked API latency | 0 ms | 300 ms | 600 ms | 1200 ms | 2500 ms |
|---|---|---|---|---|---|
| **LCP** | 432 | 436 | 456 | 440 | **432** |

**LCP is flat.** A 2.5-second backend costs nothing at first paint, because
the page renders its shell and fills content in afterwards.

**Consequence for the plan: Apps Script optimisation will not improve page
load.** It is still worth doing — for API responsiveness once the shell is up,
for quota headroom, and for cost — but it must not be sold as a load-time win.
The load-time lever is **bytes**.

## Finding 2 — two files are three-quarters of every page

Gzipped, as served:

| Asset | Raw | **Gzipped** | Loaded by |
|---|---|---|---|
| `assets/css/styles.css` | 105,908 | **28,354** | 22 of 23 pages, render-blocking |
| `assets/js/helpers.js` | 60,110 | **21,525** | 22 of 23 pages |
| `assets/js/bottom-nav.js` | 9,075 | 3,387 | most pages |
| `assets/js/register-sw.js` | 6,453 | 2,559 | all pages |
| `assets/js/api.js` | 3,924 | 1,749 | all pages |

`styles.css` + `helpers.js` alone ≈ **50 KB of the 67 KB** index page. On
slow-3G (≈50 KB/s) that is roughly a second of transfer before anything else.

Whole-tree totals: **39 JS modules, 398,330 bytes raw**; 2 stylesheets,
120,553 bytes raw. Pages load 10–13 scripts each.

## Finding 3 — product-page CLS regressed today, by my own change

The stored V1 attribution recorded **CLS 0.853** on the product page, blamed on
`div.store-branding-info`. **That is stale.** At `39cd862` the store branding no
longer shifts at all — earlier reservation work fixed it.

Current attribution (`performance-audit/scripts/cls-attribution.js`):

```
/product.html  CLS=0.0727 (3 shifts)
  0.0388 @ 1013ms  p.view-store-row  y182 -> y810
  0.0337 @ 1810ms  details#reviews-section y745 -> 0 | p.view-store-row y810 -> 0
  0.0001 @  349ms  p.view-store-row  y178 -> y182
```

Both large shifts are **sections revealed after an async load with no reserved
height**:

- `#related-section` (`product-page.js:155`) — the similar-products carousel
  added in PR #35 **today**. `.related-section` sets margins only, no
  `min-height`. When it un-hides, everything below it jumps 628 px.
- `#reviews-section` (`product-page.js:279`) — same pattern.

Search shows the same shape at 0.0359, from its discovery block.

This is a self-inflicted regression from this session and it is the clearest
Phase 1 candidate: reserve height for both, which is a CSS-only change.

## Finding 4 — things already optimised, which must not be re-claimed

Verified by inspection, not assumed:

- **Image optimisation exists.** `optimizedImageUrl()` (`helpers.js:395`)
  rewrites Cloudinary URLs to `f_auto,q_auto,c_limit,w_<n>` and Google Drive
  `lh3` URLs to `=w<n>`. `loading="lazy"` is at 11 render sites.
- **Request de-duplication exists.** `api.js` coalesces identical in-flight
  requests — every GET by URL, and seven read POSTs by name. Writes are never
  coalesced.
- **The service worker is sound.** Versioned cache (`mwakete-v45`), a precache
  list, activate-time cleanup of old versions. Warm loads transfer 0 bytes.
- **Render-blocking scripts: one.** A deliberate inline script in `stores.html`
  that reserves cart-row height before first paint.
- **`getCustomerInbox` is not the site-wide cost it appears to be.** It exits
  early on both client (`bottom-nav.js:100`) and server (`Chat.gs:119`) when the
  shopper has no chat tokens, is cached 20 s, and reads one sheet. It shows on
  every page in the harness only because the harness seeds chat tokens.

## Finding 5 — backend read cost (for context, not for load time)

| Action | Full sheets read | Cached |
|---|---|---|
| `actionSearchProducts` | Owners, Products, Variants, + Reviews via `productRatingIndex` — **4** | 60 s |
| `actionListProducts` | Products, Variants — **2** | 60 s |
| `actionListStores` | Owners — **1** | 60 s |
| `actionGetCustomerInbox` | Conversations — **1** | 20 s |
| `actionGetHomePageData` | 0 direct — delegates to two cached helpers | ✓ |

Cache TTLs in use: 60 s (×4), 300 s (×2), 20 s (×1). Seven `getCached` call
sites pass no explicit TTL.

---

## Harness caveats — read before acting on the API table

Two rows in the API audit look like bugs and are not:

- **`/search.html?q=rice` shows `searchProducts` twice.** The harness mocks
  **empty** results for every action, so the first search returns nothing and
  smart-search discovery correctly issues one category query. With real data
  that matches, discovery never runs — asserted by `verify-smartsearch`
  ("a working search makes exactly ONE backend request").
- **`/checkout.html [logged-in]` shows 6 calls with `getStorePublicInfo`
  twice.** I could not reproduce this in an isolated single-page load, which
  makes exactly one such call. The de-duplication in `api.js` covers it. The
  harness runs pages sequentially in one context, so this is most likely bleed
  from the previous page. **Needs isolation before anyone "fixes" it.**

## Environment

Node 22, Playwright Chromium at `/opt/pw-browsers/chromium`. Static server on
:8099 (uncompressed) and `performance-audit/scripts/gzip-server.js` on :8100.
Sandbox has no network access to Google or mwakete.com, so all backend
responses are mocked.
