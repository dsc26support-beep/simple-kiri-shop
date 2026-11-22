# Mwakete Performance Implementation Plan — forward

Short pointer + the current forward plan. The detailed, evidence-cited plan is
[`MWAKETE_V2_PERFORMANCE_PLAN.md`](../MWAKETE_V2_PERFORMANCE_PLAN.md) (its tiers
still stand); this records what is **done**, what is **deferred**, and the gate
that now protects every future change.

---

## Phase 1 — the permanent system (this work, `546b3cd`)

**Done.** Not an optimization phase — it builds the guardrails so optimizations
(and ordinary feature work) cannot silently regress performance:

- Refreshed lab baseline → [`PERFORMANCE_BASELINE.md`](PERFORMANCE_BASELINE.md).
- Measured budgets → [`performance-audit/budgets.json`](../performance-audit/budgets.json) + [`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md).
- CI budget gate (deterministic bytes + CWV backstop) → `.github/workflows/performance.yml`,
  `performance-audit/scripts/check-budgets.js`, `ci-cwv.js`.
- Standards, monitoring, deploy/rollback docs, test report.

No application code, CSS, JS, HTML, or `.gs` changed. No service-worker cache
bump owed.

---

## Deferred candidates — in priority order, each gated on measured need + approval

Per CLAUDE.md (smallest safe change; present changes for approval) and V2's
Tier-0 rule (measure before building the expensive items):

### Candidate 1 — reserve the trending-stores carousel height — ✅ SHIPPED (index CLS → 0)
- **Why:** `index` CLS regressed to **0.0385** — a single shift where
  `#trending-stores-list` grows 8→94 px and pushes `.trending-products` down 52 px
  (PERFORMANCE_BASELINE, attributed).
- **Change shipped:** `#trending-stores-list { min-height: 94px }` in `styles.css`
  (sw cache v235→v236, styles.min.css is precached).
- **Step 1 (#177, 17 Nov):** `#trending-stores-list { min-height: 94px }` reserved
  the carousel — index CLS **0.0385 → 0.0249**. Removed the dominant carousel-
  *growth* shift, but left a ~20 px residual from the "Loading" status line above
  collapsing as it cleared (a size reservation can't fix that).
- **Step 2 (18 Nov):** the overlay — the status is wrapped with the carousel in
  `.logo-carousel-frame` and positioned **out of flow** (absolute over the reserved
  area), so clearing it moves nothing. **Index CLS 0.0249 → 0.0000** (0 shifts).
  Loaded-state heading→carousel gap unchanged (20 px); "Loading" shows inside the
  carousel area during load. sw cache v236→v237 (styles.min.css + index.html are
  precached). verify-perf 27/28 (known offline-nav), verify-perffixes 27/27, budget
  gate green. **Homepage CLS is now zero.**

### Candidate 2 — split / trim `styles.min.css` *(medium risk, needs data first)*
- **Why:** 25.4 KB gzip, the only render-blocking file, grew 2.5× since Phase 2.
- **Blocked on:** updating `asset-coverage.js` to track the `.min` filenames so
  real unused-CSS share is known (it reported blank this run). "Split the CSS"
  without coverage is guesswork, and a global stylesheet has implicit ordering
  dependencies (this branch hit that trap twice in V2).
- **Risk:** medium. **Effort:** days. Defer until coverage data + owner approval.

### Candidate 3 — per-page JS bundling *(medium risk)*
- **Why:** 14–21 small files per page; the cost is cold round trips, not execution
  (27–59 ms throttled).
- **Caveat:** the service worker already makes repeat visits free, so this helps
  only first visits. Defer; weigh against complexity.

### Candidate 4 — scope `productRatingIndex` to matched product ids *(backend)*
- **Why:** trims the `searchProducts` hot path from 4 sheet scans to 3.
- **Caveat:** backend cost only — will **not** move page load. Manual deploy +
  `getVersion`. Defer until the Apps Script Executions log shows it climbing.

### Candidate 5 — the data-layer's exit from whole-tab scans *(structural)*
- Per V2 Tier 3: do not decide until field TTFB + Apps Script execution time are
  measured (PERFORMANCE_MONITORING.md). Weeks of work; for scale, not today.

---

## The rule for all future performance work

1. **Measure first** (lab via the harness; field via the owner-run PageSpeed/CrUX
   process). No expensive change without a number behind it.
2. **Smallest safe change**, preserving theme/architecture (CLAUDE.md).
3. **The gate must stay green** — or a budget is raised deliberately, with a
   reason, in the same PR.
4. **Present risky changes for approval** before implementing; never sneak a
   backend change into a frontend PR.
5. **Lab stays labelled lab.** Field numbers come only from the owner's tools.
