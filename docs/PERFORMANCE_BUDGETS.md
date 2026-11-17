# Mwakete Performance Budgets

**Source of truth:** [`performance-audit/budgets.json`](../performance-audit/budgets.json)
**Enforced by:** `performance-audit/scripts/check-budgets.js` (primary) and
`ci-cwv.js` (backstop), on every pull request — see
[`PERFORMANCE_MONITORING.md`](PERFORMANCE_MONITORING.md).
**Set from:** the measured baseline at `546b3cd` ([`PERFORMANCE_BASELINE.md`](PERFORMANCE_BASELINE.md)) + small headroom.

These are **not arbitrary limits.** Every budget is the real measured value plus
a little room, so the gate fails on a genuine regression — not on a rounding
error, and not on growth the team already accepted.

---

## The budgets

All byte values are **gzipped** (level 9), the way GitHub Pages serves text.

### Shared assets (loaded by most/all pages)

| Asset | Measured | **Budget** | Headroom |
|---|---|---|---|
| `assets/css/styles.min.css` | 25.4 KB | **29 KB** | ~14% |
| `assets/css/owner.min.css` | 12.7 KB | **15 KB** | ~16% |
| `assets/js/helpers.min.js` | 13.4 KB | **16 KB** | ~16% |

### Per page — first-visit static transfer (HTML + local CSS/JS)

| Page | Measured total | **maxTotalGzip** | Measured JS | **maxInitialJsGzip** | **maxRequests** |
|---|---|---|---|---|---|
| index | 64.0 KB | **74 KB** | 34.4 KB | **40 KB** | 21 |
| store | 76.9 KB | **88 KB** | 45.8 KB | **52 KB** | 24 |
| product | 79.0 KB | **90 KB** | 48.9 KB | **56 KB** | 24 |
| categories | 61.6 KB | **71 KB** | 33.3 KB | **39 KB** | 17 |
| stores | 56.9 KB | **66 KB** | 28.9 KB | **34 KB** | 17 |
| cart | 61.4 KB | **71 KB** | 32.7 KB | **38 KB** | 18 |
| checkout | 71.2 KB | **82 KB** | 40.4 KB | **47 KB** | 21 |
| customer-dashboard | 65.2 KB | **75 KB** | 35.5 KB | **41 KB** | 20 |

### Hard rules

- **Web fonts = 0.** `fontsMustBeZero: true`. The site ships no web font and must
  not start — a font is a new render-blocking (or FOUT-causing) resource on the
  critical path this whole audit worked to clear. The gate flags any Google
  Fonts link, `.woff/.woff2/.ttf/.otf`, or `as="font"` preload.
- **No render-blocking third-party `<script src>`** on customer pages. The CSP
  (`tests/verify-csp.js`) already constrains which external hosts are even
  allowed; the byte gate counts only local assets.

### Core Web Vitals ceilings (backstop gate, lab)

| Page | Measured LCP | **maxLcpMs** | Measured CLS | **maxCls** |
|---|---|---|---|---|
| index | ~404 | **1500** | 0.0385 | **0.10** |
| store | ~416 | **1500** | 0.0134 | **0.10** |
| product | ~1456 | **2000** | 0 | **0.10** |

CWV ceilings sit **well above** measured lab values on purpose: they are a
backstop that only a gross regression trips (a new render-blocking resource, or
a large un-reserved layout shift), and they are checked as the **median of 3
runs** so ordinary lab noise never flaps them. `0.10` is the Core Web Vitals
"good" boundary for CLS.

---

## The headroom policy

| Budget kind | Headroom | Why |
|---|---|---|
| Shared asset gzip | ~15% | Shared files grow as features land; a tighter cap would flag normal work |
| Per-page total / initial-JS gzip | ~12% | The real levers; tight enough to catch a new heavy dependency |
| Static request count | +3 | A few new small modules are normal; a jump of 4+ is worth a look |
| Web fonts | 0 (hard) | A regression against the measured baseline with no upside here |
| CWV LCP ceiling | ≥ 3× measured (index/store), ~1.4× (product) | Backstop only; must never flap on shared-runner noise |
| CWV CLS ceiling | 0.10 | The Core Web Vitals "good" bar |

---

## How to change a budget (the only correct way)

Budgets are meant to move **deliberately**, in the same PR that changes the weight:

1. **If growth is intentional and justified** (a real feature), raise the specific
   budget in `performance-audit/budgets.json` **in the same PR**, with a one-line
   reason in the PR description. The gate's failure message says exactly this.
2. **If growth is accidental** (a stray dependency, an un-minified file, a
   duplicated asset), fix the cause — do not raise the budget.
3. **After a real reduction**, lower the budget to lock the win in, so it cannot
   silently regress later.

Never raise a budget just to make CI green. The number is the measured truth plus
headroom; if the truth changed, say why.

### Re-deriving all budgets from a fresh baseline

```bash
node performance-audit/scripts/check-budgets.js --json   # current measured bytes
```
Add the documented headroom to each value and update `budgets.json`. Then run the
gate (`node performance-audit/scripts/check-budgets.js`) to confirm it passes,
and `node performance-audit/scripts/ci-cwv.js --report` for the CWV medians.

---

## What is deliberately **not** budgeted

- **Real photo bytes / API payload bytes** — not deterministic from source, and
  the sandbox cannot measure real photos. The API response *shape* is tracked in
  [`API_PERFORMANCE_AUDIT.md`](API_PERFORMANCE_AUDIT.md) and
  `system-api-per-page.json`; real bytes belong to field monitoring.
- **Backend / Apps Script time** — mocked here; irrelevant to page-load budgets
  (the latency sweep proves LCP is flat against it). Watch it in the Apps Script
  Executions log, not this gate.
- **Render time / long tasks** — small and noisy in lab; the CWV ceilings cover
  gross regressions. Measure INP in the field.
