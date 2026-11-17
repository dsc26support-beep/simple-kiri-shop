# Mwakete Performance Baseline — refreshed

**Commit:** `546b3cd` (post #168 six speed fixes, #171 CSP) · **Date:** 2026-11-16
**Data:** `performance-audit/data/system-baseline-gzip.json` (+ `system-api-per-page.json`, `system-asset-coverage.json`)
**Harness:** `performance-audit/scripts/` on headless Chromium, gzip server on :8100, backend mocked at 600 ms.

> **This is the entry point for Mwakete's permanent performance system.** It
> refreshes — it does **not** replace — the measured history:
> [`MWAKETE_V1_PERFORMANCE_AUDIT.md`](../MWAKETE_V1_PERFORMANCE_AUDIT.md) (the
> 685-line original audit), [`MWAKETE_V2_PERFORMANCE_PLAN.md`](../MWAKETE_V2_PERFORMANCE_PLAN.md),
> [`V2_BASELINE.md`](V2_BASELINE.md), [`V2_PERFORMANCE_RESULTS.md`](V2_PERFORMANCE_RESULTS.md)
> and [`API_PERFORMANCE_AUDIT.md`](API_PERFORMANCE_AUDIT.md). Those remain the
> record of commit `39cd862`; this is the record of `546b3cd`.
>
> The rest of the system: [`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md) ·
> [`PERFORMANCE_STANDARDS.md`](PERFORMANCE_STANDARDS.md) ·
> [`PERFORMANCE_MONITORING.md`](PERFORMANCE_MONITORING.md) ·
> [`PERFORMANCE_TEST_REPORT.md`](PERFORMANCE_TEST_REPORT.md) ·
> [`PERFORMANCE_DEPLOYMENT_GUIDE.md`](PERFORMANCE_DEPLOYMENT_GUIDE.md) ·
> [`PERFORMANCE_ROLLBACK_GUIDE.md`](PERFORMANCE_ROLLBACK_GUIDE.md).

---

## ⚠️ Lab, not field — read this first

Every number in this document is **laboratory** measurement:

- Headless Chromium against a **local** gzip server (`127.0.0.1:8100`), not GitHub Pages.
- The Apps Script backend is **mocked at a fixed 600 ms** so backend time is separated from frontend time.
- Product photos are a 1-pixel stand-in (real Cloudinary/Drive photos are cross-origin and unreachable from the sandbox).
- Network and CPU are **emulated** (mobile-4g = 390×844, 4× CPU, 4 Mbps/70 ms; mobile-slow3g = 6× CPU, 400 kbps/400 ms).

So `document TTFB here is localhost TTFB` and says nothing about GitHub Pages
from Kiribati. What the harness measures **truthfully** is everything the
browser does with the bytes: parse, execution, layout, paint, request count,
transferred weight, CLS, and how those respond to throttling.

**Field numbers** — real LCP/INP/CLS at the 75th percentile from real devices —
can only be collected by the owner, because this sandbox has no outbound web
(`curl` to mwakete.com returns `000`). That process is in
[`PERFORMANCE_MONITORING.md`](PERFORMANCE_MONITORING.md). **Never present a lab
number as a field number.**

---

## Headline

| What | Measured (lab) | Verdict |
|---|---|---|
| Warm repeat visit (SW), index | **164 ms / 0 KB transferred** | Excellent — unchanged |
| First paint, index, mobile-4g | ~400–540 ms | Fast |
| First paint, index, **slow-3G** | **2392 ms** | The Kiribati-relevant figure; improved from V2 baseline's 2620 ms |
| Backend-latency sensitivity | **flat** (0→2500 ms API ⇒ LCP 396–408 ms) | Load is asset-bound, not backend-bound — still true |
| Worst CLS | **index 0.0385** (new) | Under the 0.1 "good" bar, but a regression from ~0 — see below |
| `getCustomerInbox` on cold load | **gone from every page** (#168) | The old "most-called action" no longer runs at page load |

The V1 verdict still holds: **the frontend is not slow.** The single most
valuable lever remains **bytes shipped on the first visit**, which is exactly
what the new CI gate guards.

---

## Core Web Vitals + weight — gzipped, 600 ms mocked API

| Page | Profile | FCP | **LCP** | **CLS** | Req | **KB** | API |
|---|---|---|---|---|---|---|---|
| index | mobile-4g | 404–536 | **404–536** | **0.0385** | 24 | 66 | 3 |
| store | mobile-4g | 412–468 | **412–468** | 0.0134 | 27–28 | 77 | 4 |
| product | mobile-4g | 420 | **852** | 0 | 26 | 80 | 3 |
| stores | mobile-4g | 344 | **344** | 0.0001 | 16 | 58 | 1 |
| categories | mobile-4g | 420 | **420** | 0.0001 | 18 | 63 | 3 |
| categories?q=rice | mobile-4g | 416 | **416** | 0 | 18 | 63 | 3 |
| cart | mobile-4g | 380 | **380** | 0 | 15 | 62 | 0 |
| customer-dashboard | mobile-4g | 320 | **508** | 0.0077 | 19 | 84 | 1 |
| **index** | **mobile-slow3g** | 2392 | **2392** | 0.0385 | 24 | 66 | 3 |
| **store** | **mobile-slow3g** | 2520 | **2520** | 0.0134 | 27 | 77 | 4 |
| index | desktop-slow | 660 | 660 | 0.0252 | 24 | 66 | 3 |
| index | desktop-fast | 76 | 76 | 0.0252 | 24 | 66 | 3 |
| index **[warm SW]** | mobile-4g | 164 | **164** | 0.0385 | 23 | **0** | 5 |
| store **[warm SW]** | mobile-4g | 180 | **180** | 0.0134 | 25 | **0** | 6 |
| index **[logged-in]** | mobile-4g | 364 | **364** | 0.0385 | 24 | 66 | 3 |

**INP is not measured here** — it needs real interaction and is a field metric.
Long-task time (an INP proxy) is small: 55–180 ms on mobile-4g, 0 on desktop.
Measure INP in the field (PERFORMANCE_MONITORING.md).

### Backend-latency sweep (index, mobile-4g) — unchanged conclusion

| Mocked API latency | 0 | 300 | 600 | 1200 | 2500 ms |
|---|---|---|---|---|---|
| **LCP** | 404 | 408 | 396 | 404 | 404 ms |

LCP is flat. A 2.5-second backend costs nothing at first paint. **Apps Script
optimisation will not move page load** (it is still worth doing for API
responsiveness, quota and cost — but never sold as a load-time win).

---

## Deterministic asset weight (what the CI gate measures)

Gzipped (level 9), from `node performance-audit/scripts/check-budgets.js --report`.
This is the *static* first-visit transfer (HTML + local CSS/JS it references) —
fully deterministic, which is why the primary CI gate uses it.

| | gzip | note |
|---|---|---|
| `assets/css/styles.min.css` | **25.4 KB** | render-blocking, ~all pages; was 10.2 KB at V2 Phase 2 — features added since |
| `assets/css/owner.min.css` | 12.7 KB | owner portal only |
| `assets/js/helpers.min.js` | 13.4 KB | most pages; was 8.7 KB at V2 Phase 2 |

| Page | HTML | CSS | JS | **Total** | static req |
|---|---|---|---|---|---|
| index | 4.7 | 24.8 | 34.4 | **64.0 KB** | 18 |
| store | 6.2 | 24.8 | 45.8 | **76.9 KB** | 21 |
| product | 5.2 | 24.8 | 48.9 | **79.0 KB** | 21 |
| categories | 3.5 | 24.8 | 33.3 | **61.6 KB** | 14 |
| stores | 3.2 | 24.8 | 28.9 | **56.9 KB** | 14 |
| cart | 3.9 | 24.8 | 32.7 | **61.4 KB** | 15 |
| checkout | 6.0 | 24.8 | 40.4 | **71.2 KB** | 18 |
| customer-dashboard | 4.9 | 24.8 | 35.5 | **65.2 KB** | 17 |

The static-weight request count (HTML + local assets) is lower than the browser
request count in the CWV table above, which also counts API JSON, images and the
favicon. They measure different things on purpose.

---

## Which V1/V2 findings are now resolved — verified in code + tests

Verified against current source and the passing regression suites, not assumed:

| Finding (origin) | Status at `546b3cd` | Evidence |
|---|---|---|
| Store-branding header CLS **0.847** (V1) | **Resolved** | `.store-branding-info { min-height: 68px }`; `verify-perffixes`: "header height reserved 68→68", product CLS 0 |
| Similar-products / reviews carousel CLS (V2) | **Resolved** | `.related-card--skeleton` reserves the shelf before the async load |
| `getCustomerInbox` uncached, on 11/12 pages (V1) | **Resolved, twice over** | Cached 20 s server-side (`Chat.gs:121`), early-exit client-side (`bottom-nav.js:102`); **#168 removed it from every cold page load** (`system-api-per-page.json` shows 0 inbox calls on cold loads) |
| Checkout 6 duplicate API calls (V1/V2) | **Resolved** | `verify-perffixes`: "checkout total API calls cut from 6 → 2", `getStorePublicInfo`/`getConversation` de-duped |
| Render-blocking CSS comments (V2) | **Resolved** | Pages load `.min` assets; `build:check` + `verify-minified` enforce it |
| No responsive images (V1/V2 item 7) | **Shipped** | `verify-perffixes`: store/browse cards emit `srcset` with 200/400/520 w + `sizes` |
| Product page read whole catalogue (V2/API) | **Improved** | `getProduct` one-product answer added in #168; `listProducts` now deferred, not critical |

### One new regression to record (honest)

**`index` CLS rose from ~0.0001 (V2 baseline) to 0.0385.** It is a single,
deterministic shift at ~736 ms:

```
0.0385 @ 736ms  div#trending-stores-list.logo-carousel  h8 -> h94
                section.trending-products  y378 -> y430  (pushed down 52px)
```

The homepage "trending stores" logo carousel has no reserved height; when store
logos arrive it grows 8 → 94 px and pushes the products shelf below it down
52 px. This is the **exact pattern** V2 Phase 1 fixed for the product carousel,
and the fix is the same one-line kind: reserve `min-height` on
`#trending-stores-list`. It is still under the 0.1 "good" threshold, so it is
**documented as the top deferred candidate**, not silently fixed in this
system-building phase. See [`PERFORMANCE_IMPLEMENTATION_PLAN.md`](PERFORMANCE_IMPLEMENTATION_PLAN.md).

---

## What could NOT be measured from the sandbox (be honest)

- **Real field CWV** (LCP/INP/CLS, 75th percentile, real devices) — no outbound web. Owner-run; see PERFORMANCE_MONITORING.md.
- **Production TTFB from Kiribati** — localhost TTFB only.
- **Real delivered photo bytes / real-photo LCP** — photos are a 1 px stand-in here.
- **Apps Script execution time / cold-start** — backend is mocked; read it from the Apps Script Executions log.
- **A real Lighthouse / PageSpeed score** — not produced here, and none is claimed anywhere in this system.
- **`asset-coverage` used-byte %** — the coverage script tracks `styles.css`/`helpers.js` but pages now load the `.min` twins, so it reported all-blank this run (a harness-maintenance item noted in PERFORMANCE_TEST_REPORT.md). It feeds the *deferred* CSS-splitting decision, so it does not block this phase.

---

## How to refresh this baseline

```bash
npm ci
npm run build && npm run build:check
node performance-audit/scripts/gzip-server.js &          # :8100
AUDIT_BASE=http://127.0.0.1:8100 AUDIT_OUT=system-baseline-gzip \
  node performance-audit/scripts/measure.js               # CWV + weight, all profiles
AUDIT_BASE=http://127.0.0.1:8100 \
  node performance-audit/scripts/api-calls-per-page.js     # API calls per page
node performance-audit/scripts/check-budgets.js --report   # deterministic weight
```
Run on an **idle** machine — the V2 results record a contaminated measurement
taken while the test sweep was running; a knowingly contaminated measurement is
worse than none.
