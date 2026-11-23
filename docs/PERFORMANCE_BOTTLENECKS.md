# Mwakete Performance Bottlenecks — current

Short pointer to the measured bottlenecks, refreshed at `546b3cd`. Full analysis
lives in [`V2_BASELINE.md`](V2_BASELINE.md) and
[`API_PERFORMANCE_AUDIT.md`](API_PERFORMANCE_AUDIT.md); this is the current
ranked view.

Ranked by what each would actually buy — **measured, lab**. Remember the proven
fact: **page load is asset-bound, not backend-bound** (LCP is flat from 0 to
2500 ms of backend latency). So backend items are for responsiveness/quota/cost,
never load time.

| # | Bottleneck | Evidence (lab, `546b3cd`) | Lever | Status |
|---|---|---|---|---|
| 1 | **`styles.min.css` is the one render-blocking file**, now **25.4 KB gzip** (was 10.2 KB at V2 Phase 2), on ~every page | PERFORMANCE_BASELINE weight table | First-paint bytes on slow-3G | Watched by the gate; splitting is deferred (needs coverage data — see below) |
| 2 | **`index` CLS** — trending-stores carousel not height-reserved | single shift @736ms, `#trending-stores-list` 8→94px | `min-height` + out-of-flow status | ✅ **Fixed → CLS 0** (#177 reserve 0.0385→0.0249; overlay 0.0249→0.0000) (PERFORMANCE_IMPLEMENTATION_PLAN.md) |
| 3 | **Per-page JS is 29–50 KB gzip across 14–21 files** | weight table | Round trips on high-latency links | Watched by the gate; bundling deferred (helps only first visits; SW makes repeats free) |
| 4 | **`searchProducts` hot path = 4 full sheet scans** (Owners, Products, Variants, Reviews) | API_PERFORMANCE_AUDIT | Backend cost (not load) | Deferred; cached 60 s; scope `productRatingIndex` to matched ids first |
| 5 | **`store`/`product` are the heaviest pages** (77–80 KB, 26–28 requests) | PERFORMANCE_BASELINE | Metered-data cost | Watched by the gate |

## Already resolved — do not re-report as bottlenecks

Verified in code + passing tests (see PERFORMANCE_BASELINE "which findings are
resolved"): store-branding CLS 0.847, product/reviews carousel CLS,
`getCustomerInbox` cost (now off every cold load), checkout 6→2 calls,
render-blocking CSS comments, missing responsive images. These were real
bottlenecks; they are fixed.

## The measurement gaps that gate the expensive fixes

Items 1 and 3 (CSS splitting, JS bundling) are **deferred until measured need is
shown**, because:

- The `asset-coverage` tool needs updating for the `.min` filenames before it can
  say how much CSS is actually unused (it reported blank this run — see
  PERFORMANCE_TEST_REPORT). Without that, "split the CSS" is guesswork.
- The real load-time question — production TTFB and real-photo LCP from Kiribati —
  is a **field** measurement only the owner can take (PERFORMANCE_MONITORING.md).

Per V2's Tier-0 rule: collect those numbers before committing to the expensive,
higher-risk items.
