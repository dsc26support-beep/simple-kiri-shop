# Mwakete Performance Standards — the 12-point checklist

Run this before merging **any** feature that touches a customer-facing page,
a shared asset, or the service worker. It is distilled from what the V1/V2
audits actually measured — every point has a reason and a test, not a rule of
thumb. The CI gate ([`PERFORMANCE_BUDGETS.md`](PERFORMANCE_BUDGETS.md)) enforces
the measurable ones; this list also covers the judgement calls a gate cannot.

> **Governing principle (unchanged since V1):** the site is fast because it has
> **no framework, no web fonts and no third-party scripts** on the critical
> path, and a service worker that makes repeat visits free. Every point below
> protects one of those. The job is to *keep* them, not to chase a score.

---

## The checklist

**1. Did the first-visit byte weight stay under budget?**
Run `node performance-audit/scripts/check-budgets.js`. If a page or shared asset
is over, either trim it or raise the budget *with a reason* (never silently).
Bytes are the one proven load-time lever here.

**2. No web font. Still zero.**
No Google Fonts link, no `@font-face`, no `.woff/.woff2/.ttf/.otf`, no
`as="font"` preload. A font is a new render-blocking resource on the critical
path. The gate fails the build if one appears.

**3. No new render-blocking resource.**
New `<script>` tags are `defer`/`async` or at end of body; new CSS is additive
to `styles.css`, not a second render-blocking stylesheet. `verify-perf` asserts
"no undeferred `<script src>` left".

**4. No framework, no bundler-of-the-month, no analytics/tag manager.**
V1 ships zero-dependency JS and executes it in <60 ms throttled. Adding React,
a tag manager, or an A/B tool is a measured regression against the baseline with
no upside the audit could find. If one is genuinely needed, bring measured
evidence and get owner approval first (CLAUDE.md: CEO-level decision).

**5. Any section that appears after an async load reserves its height.**
This is the site's most common CLS bug (product carousel in V2; trending-stores
carousel today). Give the container its final `min-height` — or a skeleton built
from the same box — *before* the request goes out. Confirm CLS stays < 0.1 with
`node performance-audit/scripts/cls-attribution.js` (add your page to it).

**6. Did you add the minified twin?**
If you edited a source `assets/**/*.css` or `*.js`, run `npm run build` and
commit the regenerated `.min` file. `npm run build:check` and `verify-minified`
fail if the committed build is stale — and a stale build ships old code with
nothing in the diff.

**7. Pages reference the `.min` asset, not the source.**
New `<link>`/`<script>` point at `foo.min.css` / `foo.min.js`. The source files
keep their comments; only the built twins ship.

**8. Images use the responsive pipeline.**
Render through `optimizedImageUrl()` and emit `srcset` + `sizes` for card/tile
slots (see `verify-perffixes`). Never hard-code a full-resolution Cloudinary/Drive
URL into an `<img>`. Keep `loading="lazy"` on below-the-fold images.

**9. A new backend read is cached if it is public and slow-changing; never cached
if it is personal, price, stock, or a write.**
See [`API_PERFORMANCE_AUDIT.md`](API_PERFORMANCE_AUDIT.md) for the exact
safe/unsafe lists. Caching hides backend cost; it does not remove it, and it must
never serve a stale price, stock level, or order.

**10. A new call on page load must not be render-blocking.**
Defer it until after first paint (the pattern that keeps LCP flat against backend
latency). No customer page should make more than one critical call. Check with
`node performance-audit/scripts/api-calls-per-page.js`.

**11. Did you bump the service-worker cache — but only if a precached file changed?**
If your change alters a file in `sw.js`'s `PRECACHE` list, bump `CACHE`
(`mwakete-vNNN`). If it does **not**, leave `CACHE` alone — a needless bump
re-downloads everything for every returning visitor. `verify-perf` tells you
whether a bump is owed ("no CACHE bump owed" vs a diff).

**12. Did you measure on an idle machine, and label it lab?**
Lab numbers are lab numbers. Never run a measurement during the test sweep (both
fight for CPU), and never present a lab figure as a field one. Real CWV comes
from the owner-run PageSpeed/CrUX process in
[`PERFORMANCE_MONITORING.md`](PERFORMANCE_MONITORING.md).

---

## The "explicitly do NOT do" list (carried from V2, still in force)

| Tempting change | Why not |
|---|---|
| Move off GitHub Pages | No evidence. Pages compresses, warm visits transfer 0 bytes, first paint is not backend-gated. Revisit only if field TTFB from Kiribati is shown poor. |
| Adopt React/Vue/Svelte | Zero-dependency JS already executes in <60 ms throttled; most framework baselines are worse before any app code. |
| Add a web font | New critical-path resource the audit spent its effort clearing. |
| Add analytics / tag manager | Third-party render-blocking cost is currently zero; any tag is a regression. |
| "Optimise" JS execution | Measured 27–59 ms under 4× CPU throttle. Nothing to win. |
| Rewrite the service worker | Cold 376 ms → warm 164 ms / 0 KB. The best-performing part of the system. |

If a task asks for one of these, treat it as a decision for the owner with
measured evidence attached — not an engineering default.
