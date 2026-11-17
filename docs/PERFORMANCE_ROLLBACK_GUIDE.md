# Mwakete Performance Rollback Guide

What to do when a performance change makes things worse — or when a budget gate
catches a regression you need to undo. Ordered from cheapest/safest to most
involved.

> **The service worker is the one thing that keeps hurting after you fix it.** A
> broken `sw.js` can serve stale content to returning visitors indefinitely. Give
> SW rollbacks the extra care flagged below.

---

## 1. Frontend rollback (the common case)

Frontend is published from `main` by GitHub Pages, so rolling back = getting
`main` back to the good state.

### Option A — revert the PR (preferred)

1. `git revert <merge-commit>` (or GitHub's **Revert** button on the PR) on a
   branch, open a PR, let the **performance gate run** on it.
2. Merge on the owner's "Merge N". Pages re-publishes the previous state
   automatically within a couple of minutes.
3. Confirm on a real device.

Reverting is preferred over force-pushing `main`: it keeps history, re-runs the
gate, and is itself reviewable.

### Option B — roll the service worker back carefully

If the reverted change touched `sw.js` or any **precached** file:

- The revert must **bump `CACHE`** to a *new* higher number (e.g. `v235 → v236`),
  **not** reuse the old one. Returning visitors are holding the bad version's
  cache; only a new version name forces them to re-fetch and lets activate-time
  cleanup drop the bad cache.
- `verify-perf` checks whether a bump is owed ("no CACHE bump owed" vs a diff) —
  run it on the revert branch.
- Expect one more warm load on the bad version before the new SW activates; that
  is unavoidable and self-heals on the next navigation.

### Option C — raise a budget instead of reverting (when the growth is fine)

If CI is red only because weight grew for a **legitimate** feature, the "rollback"
is not a revert — it is raising the specific budget in
[`performance-audit/budgets.json`](../performance-audit/budgets.json) in the same
PR, with a one-line reason. See
[`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md#how-to-change-a-budget-the-only-correct-way).
Do **not** do this to hide an accidental regression.

---

## 2. Backend rollback (`apps-script/`)

- Keep the previous `apps-script/*.gs` in git; to roll back, the **owner** copies
  the previous version into Apps Script and redeploys, then confirms
  `?action=getVersion` shows the rolled-back version.
- As with deploys, **this cannot be done or verified from the sandbox** — provide
  the owner the steps and the version to expect; never claim it is done without
  the `getVersion` confirmation.
- Not expected for performance work (no backend change in this phase).

---

## 3. Verify a rollback actually worked

1. `npm run build:check` green on the restored tree.
2. `node performance-audit/scripts/check-budgets.js` green.
3. `node performance-audit/scripts/ci-cwv.js` within ceilings.
4. On a **real device**, confirm the symptom is gone (the lab gate cannot see the
   live site).
5. Next monthly PageSpeed/CrUX reading confirms the field recovered
   (PERFORMANCE_MONITORING.md).

---

## Cloudflare (owner task — optional, with rollback)

**Status: not set up.** Cloudflare is not in front of mwakete.com today, and its
dashboard is **owner-only and unreachable from here** — nothing in this repo has
changed or can change it. This is a *recommended, optional* configuration the
owner may choose to apply later. It is written here so that if it is ever turned
on, undoing it is a known, safe step.

### What it would add (if the owner chooses to set it up)

GitHub Pages already compresses and sets a short cache lifetime, so the gains are
incremental, not transformational — the frontend is not slow (see
[`PERFORMANCE_BASELINE.md`](PERFORMANCE_BASELINE.md)). A conservative config:

| Setting | Recommended | Why | Risk |
|---|---|---|---|
| Brotli compression | On | Slightly smaller than gzip for text | None |
| Caching level | Standard | Honour Pages' cache headers | Low |
| Edge cache TTL | Respect origin | Do **not** override Pages headers | Low |
| Browser cache TTL | Respect existing | `sw.js` must stay short/no-store | **High if sw.js is cached** |
| Auto-minify | **Off** | The build already minifies; double-processing can break the cascade | Medium |
| Rocket Loader / JS rewriting | **Off** | Reorders scripts; can break the deliberate load order | **High** |
| SSL/TLS | Full (strict) | Security, not performance | Low |

### The one hard rule

**Never let any CDN cache `sw.js` for longer than the origin says, and never run
JS-rewriting (Rocket Loader) over this site.** A stale or rewritten service
worker is the failure that keeps hurting after it is "fixed".

### Rollback of a Cloudflare change (owner, dashboard)

1. If a specific toggle caused a problem, turn **that** toggle back (Auto-minify
   off, Rocket Loader off, etc.) — changes apply within seconds to a minute.
2. **Purge Everything** in the Cloudflare cache so stale edge copies are dropped.
3. Full emergency rollback: set the Cloudflare proxy to **DNS-only** (grey cloud)
   for mwakete.com — traffic then goes straight to GitHub Pages as it does today,
   taking Cloudflare out of the path entirely.
4. Confirm on a real device and at the next PageSpeed/CrUX reading.

**This section describes an owner task. No Cloudflare dashboard has been touched
by this work, and none is claimed to have been.**
