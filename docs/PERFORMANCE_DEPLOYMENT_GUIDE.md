# Mwakete Performance Deployment Guide

How a performance change reaches shoppers, and the checks at each stage. This is
the performance-specific view; the full deploy procedure is in
[`DEPLOY.md`](../DEPLOY.md) — this does not duplicate it.

There are **three** places code or config can live, with very different deploy
mechanics and very different risk:

| Layer | How it deploys | Who | Verifiable from sandbox? |
|---|---|---|---|
| **Frontend** (HTML/CSS/JS, `sw.js`) | Auto — GitHub Pages publishes `main` | Merge a PR | Partly (lab gate yes; live site no) |
| **Backend** (`apps-script/*.gs`) | **Manual** — copy into Apps Script, redeploy | Owner | **No** — always give steps + `?action=getVersion` |
| **Edge** (Cloudflare caching/compression) | Dashboard — **not set up** | Owner only | No — see [`PERFORMANCE_ROLLBACK_GUIDE.md`](PERFORMANCE_ROLLBACK_GUIDE.md) and below |

---

## 1. Frontend performance changes (the common case)

Frontend changes (assets, pages, service worker) **auto-publish**: when a PR
merges to `main`, GitHub Pages rebuilds and serves mwakete.com within a couple of
minutes. There is no deploy button and no backend step.

### Pre-merge checklist

1. `npm ci && npm run build && npm run build:check` — committed build is fresh.
2. `node performance-audit/scripts/check-budgets.js` — **green** (or budget
   raised in the same PR with a reason).
3. The **CI gate passes** on the PR (both jobs — see PERFORMANCE_MONITORING.md).
4. Run the [12-point checklist](PERFORMANCE_STANDARDS.md), especially:
   - Service-worker cache bumped **only if** a precached file changed
     (`verify-perf` tells you if a bump is owed).
   - New async sections reserve their height (no new CLS).
   - New images use the responsive pipeline.
5. Regression suites relevant to the change pass (`verify-perf`,
   `verify-perffixes`, `verify-minified`, `test-cache-speed`).

### After merge

- Pages publishes automatically. Confirm on a real device.
- **If `sw.js` `CACHE` was bumped**, returning visitors get the new version on
  their *next* load after the SW activates; the old cache is cleaned at activate
  time. A warm visit may serve the previous version once before updating — this
  is expected and is why a needless bump is wasteful (PERFORMANCE_STANDARDS.md #11).
- Record the real field effect next month via PageSpeed/CrUX — never claim a
  field improvement from the lab gate.

---

## 2. Backend performance changes (`apps-script/`)

**No backend change is expected for a frontend-performance PR, and none was made
in this system-building phase.** If one ever is needed (e.g. a new cache TTL or a
narrowed sheet read):

- It **cannot** be deployed or verified from this sandbox — there is no network
  path to `script.google.com`.
- Always hand the owner the **deploy steps** and the
  **`?action=getVersion`** check, and **never claim a deploy landed** without the
  owner confirming that version string. (CLAUDE.md, standing constraint.)
- Bump `APP_VERSION` in the backend when backend behaviour changes; follow
  [`DEPLOY.md`](../DEPLOY.md) for the exact steps.
- Remember the measured fact: **backend time does not move page load** (LCP is
  flat against backend latency). A backend change is for API responsiveness,
  quota or cost — never sold as a load-time win.

---

## 3. Edge / CDN (Cloudflare) — owner-only, not set up

Cloudflare is **not currently in front of mwakete.com**, and the DNS/hosting
dashboards are reachable **only by the owner** — nothing here can inspect or
change them. The recommended (optional) configuration, with its own rollback, is
documented as an **owner task** in
[`PERFORMANCE_ROLLBACK_GUIDE.md`](PERFORMANCE_ROLLBACK_GUIDE.md#cloudflare-owner-task--optional).
**No dashboard has been changed, and none is claimed to have been.**

---

## Deploy risk ladder (what needs approval)

From CLAUDE.md, still in force:

- **Auto-publish a frontend PR to `main`** — hard-to-reverse (it is live
  immediately). Merge only on the owner's explicit "Merge N".
- **Backend redeploy** — manual, owner-run, verified by `getVersion`.
- **Cloudflare / DNS** — CEO-level + owner-only; always ask first.

The CI gate blocking a PR is a *safety feature*, not a deploy blocker to route
around: a red gate means real weight or CWV regressed, or a budget needs a
documented bump.
