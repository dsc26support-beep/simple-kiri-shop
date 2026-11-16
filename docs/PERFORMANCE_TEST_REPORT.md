# Mwakete Performance Test Report

**Commit:** `546b3cd` · **Date:** 2026-11-16 · **All numbers below are real
output** from this session's runs, lab (localhost, mocked backend). Nothing is
estimated or reconstructed.

This report records: (1) what the new CI gate checks and proof it both passes and
catches a regression, (2) the regression-suite pass counts, and (3) the
before→after against the V2 baseline.

---

## 1. The CI gate — demonstrated pass **and** demonstrated catch

### Primary gate — `check-budgets.js` (deterministic, no browser)

**Passes at HEAD:**

```
Asset gzip budgets (what every page loads):
  css/styles.min.css    24.8K  budget 28.3K  ok
  css/owner.min.css     12.7K  budget 14.6K  ok
  js/helpers.min.js     13.4K  budget 15.6K  ok
Per-page first-visit static transfer (HTML + local CSS/JS, gzipped):
  index    64.0K / budget 72.3K  ok      store    76.9K / 85.9K  ok
  product  79.0K / 87.9K  ok      ...all 8 pages ok, 0 web fonts
✅ All performance budgets met.    (exit 0)
```

**Catches a synthetic oversize bundle** — ~40 KB of CSS appended to
`styles.min.css`, gate re-run:

```
  css/styles.min.css    29.8K  budget 28.3K  OVER by 1.4K
❌ PERFORMANCE BUDGET BREACH — 1 item(s) over budget.    (exit 1)
```

(The file was restored immediately afterwards; the working tree is clean.)

### Backstop gate — `ci-cwv.js` (headless Chromium, median of 3, lab)

**Passes at HEAD:**

```
Core Web Vitals — lab, median of 3, mobile-4g, 600ms mocked API
  page       LCP(med)  ceil   CLS(med)  ceil   status
  index         408    1500    0.0385   0.1    ok   [runs lcp 448/392/408]
  store         424    1500    0.0134   0.1    ok   [runs lcp 424/396/428]
  product      1444    2000    0        0.1    ok   [runs lcp 1452/1428/1444]
✅ Core Web Vitals within lab ceilings.    (exit 0)
```

The per-run figures in brackets show the stability the median relies on
(index LCP 392–448, CLS identical every run) — this is why generous ceilings +
median-of-3 do not flap on lab noise. It would fail if CLS crossed 0.10 (a new
un-reserved shift) or LCP crossed the ceiling (a new render-blocking resource).

### The workflow

`.github/workflows/performance.yml` runs both gates on every PR touching pages,
assets, `tools/`, `performance-audit/`, `sw.js` or the workflow. Valid YAML
(parsed). The CWV job installs Playwright Chromium in CI (the scripts resolve
Playwright from either the sandbox global path or `node_modules`, so they run in
both places). No live-site calls anywhere.

---

## 2. Regression suites — real pass counts

Run against the committed build, servers up (plain :8099, gzip :8100):

| Suite | Result | Notes |
|---|---|---|
| `test-cache-speed` | **14 / 14** | backend cache: big-value splitting + cache warming |
| `verify-perffixes` | **27 / 27** | all V2 Phase 1 fixes intact: product CLS 0, header reserved 68→68, checkout 6→2, `srcset` ×3, badge last-known-count, read-coalescing |
| `verify-perf` | **27 / 28** | the 1 failure is the **known pre-existing** "offline navigation to an unvisited page" (listed in the mandate as not-to-chase); also confirmed **"no CACHE bump owed — v235→v235"** |
| `build` / `build:check` | **pass** | 98 built files match source; CSP on 45 pages; build is idempotent (no source changed) |

Known pre-existing failures that also fail on `main` were **not chased** (per the
mandate): `gis is not defined`, logout CLS, meetings-ui fetched twice,
more-colors purple, perf offline nav, badges-ui/home-search (page.accessibility
missing), inventory-page timeout.

This phase changed **no application code** — only docs, the
`performance-audit/` harness scripts, `budgets.json`, and the new workflow — so
no site functionality or security behaviour could be affected, and no
service-worker cache bump is owed.

---

## 3. Before → after (V2 baseline `39cd862` → `546b3cd`), lab, gzipped, mobile-4g

| Metric | V2 baseline | **Now** | Read |
|---|---|---|---|
| index LCP | 496 | ~404–536 | flat (noise band) |
| index slow-3G | 2620 | **2392** | slightly better |
| index warm (SW) | 168 / 0 KB | **164 / 0 KB** | unchanged, still excellent |
| index weight | 67 KB | **66 KB** | flat |
| index **CLS** | 0.0001 | **0.0385** | ⚠️ regression — trending-stores carousel, see below |
| product LCP | 464 | 852* | LCP element renders post-API (lab, mocked) |
| product CLS | 0.0727 | **0** | fixed (was the worst on the site) |
| store weight | 84 KB | **77 KB** | lighter |
| `getCustomerInbox` on cold load | 11/12 pages | **0 pages** | removed by #168 |
| checkout API calls | 6 | **2** | de-duped (#168 / V2) |
| `styles.min.css` gzip | 10.2 KB | **25.4 KB** | grew with features (owner header, security UI, welcome, header ads) |
| `helpers.min.js` gzip | 8.7 KB | **13.4 KB** | grew with features |

\* product LCP is mock-shape-sensitive in lab (852 ms in the full sweep, ~1456 ms
in the CWV subset whose mock returns a single product then defers `listProducts`).
Real product LCP is a field measurement — the product photo, not the mocked
1 px stand-in.

### The one regression, attributed precisely

```
index CLS 0.0385 — single shift @ 736ms
  #trending-stores-list (logo carousel)  height 8 -> 94 px
  → section.trending-products  pushed down 52 px
```

The homepage trending-stores logo carousel does not reserve its height; when
store logos arrive it grows and pushes the products shelf down. Same pattern V2
Phase 1 fixed for the product carousel; same one-line fix (reserve `min-height`).
Still under the 0.10 "good" bar, so it is **documented as the top deferred
candidate** (PERFORMANCE_IMPLEMENTATION_PLAN.md) rather than changed in this
system-building phase. The CWV gate's 0.10 CLS ceiling will catch it if it ever
grows past "good".

---

## 4. Honest limits of this report

Every number here is **lab** — headless Chromium, localhost gzip server, backend
mocked at 600 ms, photos a 1 px stand-in, network/CPU emulated. It is a faithful
record of how the browser handles the bytes, and a reliable regression signal. It
is **not** field data and says nothing about real GitHub Pages TTFB from
Kiribati. No Lighthouse/PageSpeed score was produced. Field CWV (75th percentile)
is the owner-run process in [`PERFORMANCE_MONITORING.md`](PERFORMANCE_MONITORING.md).
