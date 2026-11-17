# Mwakete Performance Monitoring

Two layers, and they measure different things. **Neither replaces the other.**

| Layer | Who runs it | What it catches | Lab or field |
|---|---|---|---|
| **CI budget gate** | Automatic, every PR | A regression in bytes shipped or Core Web Vitals, *before* it merges | **Lab** (localhost, mocked backend) |
| **Field monitoring** | The owner, monthly | How the site actually performs for real shoppers on real Kiribati connections | **Field** (real devices, 75th percentile) |

The CI gate is the guardrail; field monitoring is the ground truth. The sandbox
that builds this site has **no outbound web**, so it can *never* produce field
numbers — only the owner can, with the free Google tools below.

---

## Part 1 — The CI gate (automatic, on every pull request)

The workflow `.github/workflows/performance.yml` runs two jobs on any PR that
touches a page, an asset, `tools/`, `performance-audit/`, `sw.js`, or the
workflow itself.

### Job 1 — "Byte budgets (deterministic)"
No browser. Verifies the committed build is fresh (`build:check`), then measures
the gzipped bytes every page ships and compares to
[`performance-audit/budgets.json`](../performance-audit/budgets.json). **Never
flakes.** This is the gate that matters most.

### Job 2 — "Core Web Vitals (lab backstop)"
Headless Chromium against a local gzip server, median of 3 runs, generous
ceilings. Catches the regressions bytes alone cannot — a new render-blocking
resource or a large layout shift.

### How to read a failure

| Message | Meaning | What to do |
|---|---|---|
| `styles.min.css ... OVER by N` | A shared asset grew past budget | Trim it, or raise that asset's budget in `budgets.json` with a reason |
| `index ... total gzip X>Y` | A page's first-visit weight is over | Find what was added; trim or raise the page budget with a reason |
| `web fonts 1>0` | A web font slipped in | Remove it — the site ships no fonts (PERFORMANCE_STANDARDS.md #2) |
| `static requests X>Y` | Several new asset requests | Usually fine to bump `maxRequests` +; check nothing is un-minified or duplicated |
| `CWV GATE: ... OVER: CLS` | A new un-reserved layout shift | Reserve the section's height (PERFORMANCE_STANDARDS.md #5) |
| `CWV GATE: ... OVER: LCP` | First paint grossly slower | Look for a new render-blocking resource; this ceiling is 3× normal, so it is a real change |

**Raising a budget is allowed** — deliberately, in the same PR, with a one-line
reason. See [`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md#how-to-change-a-budget-the-only-correct-way).
Never raise one just to go green.

### Run the gate yourself before pushing

```bash
npm ci && npm run build && npm run build:check
node performance-audit/scripts/check-budgets.js          # primary, instant
node performance-audit/scripts/ci-cwv.js                 # backstop, ~1 min
```

---

## Part 2 — Field monitoring (owner, monthly) — the real numbers

Lab numbers say the code did not regress. **Field numbers say whether Kiribati
shoppers are having a fast experience.** Core Web Vitals are officially the
**75th percentile of real visits** — a number no lab can produce. Collect it with
these free Google tools. Budget ~15 minutes a month.

### 2a. PageSpeed Insights (do this one every month)

1. Go to **https://pagespeed.web.dev**
2. Enter **`https://mwakete.com`**, click **Analyse**. Repeat for
   `https://mwakete.com/stores.html` and a real product URL.
3. Read **two separate sections**:
   - **"Discover what your real users are experiencing" (CrUX field data)** —
     this is the **real** LCP, INP and CLS at the 75th percentile, if the site
     has enough traffic. **This is the number that matters.** Green = good.
   - **"Diagnose performance issues" (Lighthouse lab score)** — a lab simulation
     Google runs. Useful for hints, but it is *their* lab, not the field. Do not
     treat the 0–100 score as the real experience.
4. Record the field LCP / INP / CLS for each page in the log below.

**Targets (Core Web Vitals "good", 75th percentile):**

| Metric | Good | Needs work | Poor |
|---|---|---|---|
| **LCP** (loading) | ≤ 2.5 s | 2.5–4 s | > 4 s |
| **INP** (responsiveness) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** (visual stability) | ≤ 0.10 | 0.10–0.25 | > 0.25 |

> If CrUX says **"not enough real-world speed data"**, the site does not yet have
> the traffic volume Google needs to report field data. That is normal for a new
> or low-traffic site — rely on the lab gate and the Search Console report (2c)
> until traffic grows, and check again next month.

### 2b. A real phone on a real connection (the Kiribati reality check)

Once a month, open **mwakete.com on an actual phone** on mobile data (not
office Wi-Fi). Note anything that *feels* slow or jumps around while loading.
This is the experience the whole audit is about, and it catches things no metric
flags.

### 2c. Search Console — Core Web Vitals report (set-and-forget)

If mwakete.com is verified in **Google Search Console**
(https://search.google.com/search-console): open **Experience → Core Web
Vitals**. It trends field CWV across *all* URLs over time and emails you when a
group of pages goes "Poor". This is the best early-warning system and needs no
monthly effort once set up. (Verifying the domain is an owner task — a one-time
DNS TXT or HTML-file step.)

### 2d. Apps Script execution time (backend health, not page load)

Page load is not backend-gated (proved in the baseline), but backend time still
matters for API responsiveness, quota and cost. In the Apps Script project:
**Executions** → sort by duration. Watch `getHomePageData`, `searchProducts`
(the hot path — four sheet scans) and any cold start. If these climb as the
marketplace grows, that is the signal for the deferred Tier-3 data-layer work,
not a page-load problem.

---

## Field measurement log (fill in monthly)

| Date | Page | LCP (field) | INP (field) | CLS (field) | CrUX had data? | Notes |
|---|---|---|---|---|---|---|
| _2026-11_ | mwakete.com | _ | _ | _ | _ | first reading — baseline |
| | stores.html | | | | | |
| | a product | | | | | |

> Keep this a running log. A month-over-month trend is worth far more than any
> single reading, and it is the only record that reflects real shoppers.

---

## What this monitoring deliberately does **not** claim

- The CI gate's numbers are **lab**. They are never reported as field numbers.
- No Lighthouse/PageSpeed **score** is produced by the sandbox or this repo —
  only the owner's own PageSpeed run produces one, and even then the field (CrUX)
  section, not the lab score, is the real experience.
- Backend time is **mocked** in the gate; real Apps Script time comes from the
  Executions log only.
