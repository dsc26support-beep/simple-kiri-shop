# Tests

~90 suites: mostly headless-browser suites (`verify-*.js`) plus ~13 pure-Node
backend suites (`test-*.js`). Three that drove `search.html` were deleted when
that page was removed; `verify-cls.js` and `verify-minified.js` were added.

They are committed **verbatim**, exactly as they were passing at
`v1-pre-v2-baseline` (`39cd862`). Not reformatted, not made portable — see
[Environment assumptions](#environment-assumptions). Preserving them unchanged
was the point: they are the regression net for the V2 work, and rewriting 91
files while committing them would have meant the net changed at the same moment
it became the thing being relied on.

## Why this directory exists

Until now these lived only in an ephemeral container scratchpad. `git ls-files`
found zero test files, which meant the V2 plan's rollback rule — *"if a change
introduces a regression, revert it first"* — had nothing to re-verify against.

## Running them

Two servers, then any suite:

```sh
python3 -m http.server 8099 &                      # plain static
node performance-audit/scripts/gzip-server.js &    # compressed, port 8100
node tests/verify-checkout.js
```

Most suites use :8099. `verify-homepage`, `verify-perf` and `verify-perffixes`
use :8100 because they measure transfer size, which only means something
compressed.

All of them:

```sh
for f in tests/verify-*.js tests/test-*.js; do
  printf '%-32s %s\n' "$(basename "$f" .js)" \
    "$(timeout 120 node "$f" 2>&1 | grep -E '^[0-9]+/[0-9]+ passed|^ALL PASS' | tail -1)"
done
```

Each prints `PASS`/`FAIL` per assertion, then `N/M passed`, and exits non-zero
on any failure. (`verify-continue.js` prints `ALL PASS` instead — hence the
second pattern above.)

**The servers drop under load.** A full sweep produces `CRASH` rows that pass
when re-run alone. Always re-run a failure individually before believing it.

## `verify-minified.js` — run this one before every push

Added in Phase 2, when the asset build landed. Pages load generated `.min` files
while the sources keep their comments, which introduces one hazard that did not
exist before: **edit a source, forget `npm run build`, and the site keeps serving
the old code.** Nothing about that failure is visible by reading the diff.

This suite closes it, on three fronts:

1. **Freshness** — re-minifies every source and byte-compares against what is
   committed. A stale build fails here instead of shipping.
2. **Wiring** — no page may load a source asset that has a built twin, and every
   `.min` file a page references must exist. A typo 404s a stylesheet.
3. **Equivalence** — renders 15 pages twice, once with the source CSS and once
   with the minified CSS swapped in at the network layer, and compares **every
   element's computed style** across 43 layout, box, type and colour properties.
   That is ~1,700 elements per run. Byte-comparing can prove the build is
   current; only this can show the minifier did not change what a rule means.

```sh
node tests/verify-minified.js
```

## Environment assumptions

Committed as-is, so two absolute paths are baked in:

| Assumption | Where |
|---|---|
| Repo is at `/home/user/simple-kiri-shop/` | 37 suites |
| Playwright at `/opt/node22/lib/node_modules/playwright` | every `verify-*` |
| Chromium at `/opt/pw-browsers/chromium` | every `verify-*` |

Elsewhere, either symlink those paths or make them configurable — the latter is
a mechanical change worth doing on its own, with a full sweep before and after,
rather than folded into this commit.

## Known-failing at this baseline

Seven suites fail for reasons predating the V2 work. A change is judged against
**this** list, not against zero. Full detail in
`docs/V2_REGRESSION_CHECKLIST.md`.

| Suite | State |
|---|---|
| `verify-card` | crash |
| `verify-cartfab` | 13/15 |
| `verify-cookie` | crash |
| `verify-custauth` | 11/14 |
| `verify-emailpopup` | crash |
| `verify-install` | crash |
| `verify-searchwidth` | crash |
| `verify-more-colors` | 27/28 — stale expected tile count, confirmed against `origin/main` |

## What they cover

`docs/V2_REGRESSION_CHECKLIST.md` maps every must-keep-working feature to the
suite covering it, and marks the rows that have **no** automated cover —
password reset, booking conflicts, ownership checks, rate limiting.

## A note on the guards

Several suites assert things that are easy to break silently while "tidying":

- `test-publicstore.js` holds a **byte-identical tripwire** on
  `publicOwnerFields` — the public payload cannot gain or lose a field without
  a deliberate decision.
- `test-taxonomy.js` compares the category list in `helpers.js` against
  `CATEGORY_IDS` in `Products.gs`. They must stay identical, in order.
- Several carry `APP_VERSION` / `CACHE` guards that fire only when a `.gs` or
  asset actually differs from `origin/main` — written conditionally on purpose,
  because unconditional versions fired falsely on every frontend-only branch.
