# Mwakete V2 — Performance Plan

Derived entirely from `MWAKETE_V1_PERFORMANCE_AUDIT.md`. Every item cites the measurement that justifies it. Nothing here has been implemented.

**Governing principle:** V1 is already fast on a good connection and excellent on repeat visits. V2's job is to fix one broken metric, remove backend work that grows with the marketplace, and cut the bytes that block first paint on a slow Kiribati connection — **without** giving back V1's biggest advantage, which is having no framework, no fonts and no third-party scripts.

---

## Tier 1 — Do these first (high value, low risk)

### 1. Reserve the store-branding header height
**Evidence:** `product.html` CLS **0.847**; single shift of 0.8532 at 879 ms, `div.store-branding-info` height 20→44 px pushing `main` from y98 to y142. `store.html` 0.047, same cause.
**Change:** give `.store-branding-info` its final height at first paint (a `min-height` covering the tagline + phone line + delivery icons row).
**Expected:** CLS → ~0 on both pages. The only measured **failing** Core Web Vital in V1.
**Effort:** hours. **Risk:** very low — one CSS rule.

### 2. Cache and defer `getCustomerInbox`
**Evidence:** traced on 11 of 12 pages; **uncached**; 3 full-tab scans including Messages, the fastest-growing table.
**Change:** (a) wrap in `getCached` keyed by customer token, 30–60 s TTL; (b) paint the badge from the last known count in `localStorage` and revalidate in the background; (c) drop the duplicate call on `customer-messages.html`.
**Expected:** removes the highest-frequency backend cost in the system. Badge appears instantly rather than after a round trip.
**Effort:** hours. **Risk:** low — a stale badge for <60 s.

### 3. De-duplicate checkout's API calls
**Evidence:** `checkout.html` issues **6** calls; `getStorePublicInfo` at +0 ms and again at +64 ms, `getConversation` and `getCustomerInbox` twice each.
**Change:** one initialiser owns store data; share the promise.
**Expected:** 6 → 3 calls on the page closest to a sale.
**Effort:** hours. **Risk:** low.

### 4. Cache the remaining uncached read paths
**Evidence:** `getTips` 4 full scans uncached; `listCustomerOrders` / `listCustomerBookings` 1 scan each, uncached.
**Change:** `getCached` with 60 s TTL, keyed per customer where relevant.
**Effort:** hours. **Risk:** low.

---

## Tier 2 — Meaningful wins, moderate effort

### 5. Split and inline critical CSS
**Evidence:** `styles.css` is **80.8 KB raw / 20.2 KB gzip**, the **only** render-blocking resource, the slowest non-API request (494 ms on throttled mobile), and one global file serving 23 pages including the owner portal.
**Change:** inline the above-the-fold rules per page area; defer the rest; stop shipping owner-portal CSS to customer pages.
**Expected:** the largest available FCP win on slow 3G. V1 slow-3G FCP is 2 020 ms; target ≤1 200 ms.
**Effort:** days. **Risk:** medium — a global stylesheet has implicit ordering dependencies. Note the audit did **not** quantify unused CSS; measure coverage first.

### 6. Bundle JavaScript per page
**Evidence:** 12 separate `<script>` tags on the heaviest pages; `helpers.js` alone 37.1 KB raw. Execution is *not* the problem (27–59 ms under 4× throttle) — the cost is 12 cold round trips.
**Change:** a minimal build step producing one bundle per page area. **Do not add a framework.**
**Expected:** requests 17–22 → ~14. Modest on 4G, more on high-latency links.
**Effort:** days — this introduces a build step where none exists, the biggest architectural change proposed.
**Risk:** medium. The service worker already makes repeat visits free, so this only helps first visits.

### 7. Responsive images
**Evidence:** `IMG_W.card = 520` for slots rendering ~173–186 CSS px; at DPR 2 that needs ~350–372 px. No `srcset` anywhere.
**Change:** add `srcset`/`sizes`; lower `card` to ~380.
**Expected:** unquantified — **real photo bytes are N/A in this audit.** Do item 9 first.
**Effort:** hours. **Risk:** low.

---

## Tier 3 — Structural, for scale rather than today

### 8. Plan the data layer's exit from whole-tab scans
**Evidence:** `getHomePageData` 5 full scans, `listProducts`/`searchProducts` 4, `getCustomerInbox` 3. Cost is O(whole marketplace) per request, not O(answer). Caching hides this today; it does not remove it.
**Options, in ascending order of change:**
- Keep Sheets, add a denormalised "index" tab written on mutation, so reads touch one narrow tab.
- Keep Apps Script, move hot data to a proper key-value or document store.
- Move the API off Apps Script entirely.
**Recommendation:** **do not decide this until item 9 is done.** The audit can prove the *shape* is unscalable; it cannot prove it is *currently* slow, because Apps Script execution time is N/A.
**Effort:** weeks.

---

## Tier 0 — Measure before building any of Tier 2 or 3

### 9. Close the four measurement gaps
The audit could not reach production. These four numbers should be collected **before** committing to the expensive items:

| Gap | How | Why it matters |
|---|---|---|
| **Real LCP element and time** | Production run with real photos | Lab LCP is a floor — a real product photo very likely becomes LCP. Changes the whole image priority. |
| **Production TTFB from Kiribati** | A real connection in Tarawa | The **only** thing that could justify changing host. |
| **Apps Script execution time** | Apps Script Executions log — `getCustomerInbox`, `getHomePageData`, and a cold start | Decides whether Tier 3 is urgent or theoretical. |
| **Delivered photo bytes** | Production network panel | Decides whether item 7 is worth doing. |

**Effort:** hours. **This is the highest-value item in the entire plan** — it is the difference between an evidence-based V2 and an assumed one.

---

## Explicitly NOT recommended

| Proposal | Why not |
|---|---|
| **Move off GitHub Pages** | No evidence. GitHub already compresses (measured: halves slow-3G FCP); repeat visits transfer 0 bytes; first paint is not backend-gated. Revisit **only** if item 9 shows poor production TTFB. |
| **Adopt React/Vue/Svelte** | V1 ships 24.8–39.9 KB gzip of JS with zero dependencies and executes it in under 60 ms throttled. Most framework baselines are worse before any app code. |
| **Add a web font** | V1 has none. A font is a new render-blocking or FOUT-causing resource on the critical path this audit spent its effort clearing. |
| **Add analytics/tag manager** | Third-party render-blocking cost is currently **zero**. Any tag is a regression against the measured baseline. |
| **Optimise JavaScript execution** | Measured 27–59 ms under 4× CPU throttle. There is nothing to win. |
| **Compress or convert the bundled images** | 171 KB of PWA icons, of which **549 bytes** are on the load path. No runtime benefit. (`app-icon-ios-1024.png`, 131 KB, appears unreferenced — repo hygiene, not performance.) |
| **Rewrite the service worker** | Cold 376 ms / 49 KB → warm **128 ms / 0 KB**. It is the best-performing part of the system. |

---

## Expected outcome

| Metric | V1 measured | V2 target | Confidence |
|---|---|---|---|
| CLS, `product.html` | **0.847** | ≤0.05 | **High** — cause identified precisely |
| API calls, checkout | 6 | 3 | **High** — duplicates traced |
| Backend work per page view | 3 uncached scans | ~0 (cached) | **High** — static analysis |
| FCP, slow 3G | 2 020 ms | ≤1 200 ms | **Medium** — depends on unmeasured unused-CSS share |
| Requests, cold | 17–22 | ≤14 | **Medium** — needs a build step |
| LCP, real photos | **N/A** | — | **None** — must be measured first |
| Production TTFB | **N/A** | — | **None** — must be measured first |

**No overall percentage improvement is claimed.** The audit can quantify the frontend precisely and the backend's *shape* but not its *speed*, and the single largest unknown — real photo weight and its effect on LCP — is unmeasured. Tier 1 is worth doing on current evidence alone. Tier 2 and 3 should follow item 9, not precede it.
