# Mwakete V1 — Performance Audit

**Audit date:** 2026-09-08
**Repo commit audited:** `1b8bdf8`
**Scope:** measurement and diagnosis only. No production file was modified — see §22.

---

## 1. Executive Summary

**The headline: Mwakete V1's frontend is not slow. Its worst measured problem is not load time at all — it is a layout shift on the product page (CLS 0.85, where 0.10 is the "poor" threshold), which makes the page feel broken rather than slow.**

Measured, on a compressed transport equivalent to GitHub Pages:

| | mobile 4G | slow 3G | desktop |
|---|---|---|---|
| Homepage FCP/LCP | **376 ms** | **2 020 ms** | 76 ms |
| Store page FCP/LCP | **422 ms** | **2 328 ms** | 84 ms |
| Cold page weight | 49–63 KB | 49–63 KB | 49–63 KB |
| Repeat visit (service worker) | **128 ms, 0 KB** | — | — |

Four findings drive everything else:

1. **First paint is independent of the backend.** Holding everything else fixed and varying mocked API latency from 0 ms to 2 500 ms moved homepage FCP by 44 ms (376 → 420 ms). The shell paints from cache/HTML before any data arrives. Apps Script latency therefore delays *content*, never *first paint*.
2. **`product.html` has CLS 0.85.** One shift at ~880 ms, caused by the store-branding header growing 20 px → 44 px when store data lands, shoving `main` down 44 px. The same root cause gives `store.html` a much milder 0.047.
3. **`getCustomerInbox` runs on every single page load** — from the nav unread badge — and is **uncached**, costing **3 full-tab scans** (Conversations, Owners, Messages) per page view, for every visitor who has ever opened a chat. `checkout.html` additionally issues **6 API calls where 3 would do**, duplicating `getStorePublicInfo`, `getConversation` and `getCustomerInbox`.
4. **Compression matters more than anything else on slow connections.** Serving uncompressed, slow-3G FCP is 4 188 ms; gzipped it is 2 020 ms. GitHub Pages compresses, so the 2 020 ms figure is the representative one — but it also means the ~80 KB uncompressed stylesheet is the largest single lever left.

**Is GitHub the bottleneck? No** — see §17. There is no measured evidence for changing host, and specific evidence against it.

---

## 2. Current Architecture

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS, no framework, no build step |
| Hosting | GitHub Pages, custom domain `mwakete.com` |
| Backend | Google Apps Script Web App (`/exec`), single `doGet`/`doPost` router |
| Data | Google Sheets (13 `.gs` modules; tabs: Owners, Products, Variants, Orders, Bookings, Reviews, Conversations, Messages, Customers, CustomerSessions, CustomerCodes, Featured) |
| Images | Cloudinary + Google Drive (`lh3.googleusercontent.com`), transformed on the fly |
| Auth | Owner: token + optional 2FA. Customer: passwordless email code → session token |
| Offline/repeat | Service worker `sw.js` (`mwakete-v24`), precaches shell + customer pages |

**Third-party runtime dependencies: none.** No framework, no jQuery, no web fonts, no analytics, no tag manager, no icon library. Icons are inline SVG. This is unusual and is a significant performance asset — see §15.

---

## 3. Test Environment

| | |
|---|---|
| Browser | Chromium (Playwright-bundled, `/opt/pw-browsers/chromium`) |
| Harness | Playwright + Chrome DevTools Protocol (`Performance.getMetrics`, `Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions`) |
| Metrics source | `PerformanceObserver` (`paint`, `largest-contentful-paint`, `layout-shift`, `longtask`, `event`), Navigation & Resource Timing |
| Transport | Local Node server **with gzip and `Cache-Control: max-age=600`**, mirroring GitHub Pages. A parallel uncompressed run is retained in the CSV for contrast. |
| Backend | **Mocked** at fixed latencies (0/300/600/1200/2500 ms) so backend time can be separated from frontend time |
| Runs | 48 page loads recorded (24 gzip + 24 uncompressed), plus 7 interaction cases and 24 API-call traces |
| Date | 2026-09-08 |

### Profiles

| Profile | Viewport | CPU throttle | Network |
|---|---|---|---|
| desktop-fast | 1366×900 | none | unthrottled |
| desktop-slow | 1366×900 | none | 1.6 Mbps / 150 ms RTT |
| mobile-4g | 390×844 | 4× | 4 Mbps / 70 ms RTT |
| mobile-slow3g | 390×844 | 6× | 400 kbps / 400 ms RTT |

### ⚠️ What this environment cannot measure

The audit sandbox has **no network route to `mwakete.com` or `script.google.com`** (egress proxy denies CONNECT; verified). Consequently:

- **Real TTFB from GitHub Pages: N/A.** Local TTFB is ~0 ms and is *not* reported as a TTFB result anywhere in this document.
- **Real Apps Script execution time: N/A.** Substituted with static analysis of sheet access (§11), which is a lower bound on cost and shape, not a wall-clock time.
- **Real Google Sheets row counts and latency: N/A.**
- **Real uploaded product-photo bytes: N/A.** Remote images were stubbed with a 1×1 GIF so requests still occur and are counted, without pretending to measure real photo weight.
- **Field INP: N/A.** Lab interaction latency is measured instead (§5.4).

Every number below is either measured in this environment or explicitly marked N/A. None are estimated.

---

## 4. Baseline Measurements

Cold load, gzip transport, API mocked at 600 ms. Full data in `MWAKETE_V1_PERFORMANCE_DATA.csv`.

| Page | Profile | FCP | LCP | CLS | Requests | Transferred | API calls |
|---|---|---|---|---|---|---|---|
| index.html | mobile-4g | 376 ms | 376 ms | 0 | 17 | 49 KB | 2 |
| store.html | mobile-4g | 422 ms | 422 ms | 0.047 | 22 | 63 KB | 4 |
| product.html | mobile-4g | 416 ms | **1 140 ms** | **0.847** | 20 | 62 KB | 3 |
| search.html | mobile-4g | 384 ms | 384 ms | 0 | 14 | 50 KB | 2 |
| stores.html | mobile-4g | 336 ms | 336 ms | 0 | 13 | 49 KB | 2 |
| categories.html | mobile-4g | 364 ms | 364 ms | 0 | 14 | 49 KB | 2 |
| cart.html | mobile-4g | 404 ms | 404 ms | 0 | 13 | 58 KB | 3 |
| customer-dashboard.html | mobile-4g | 344 ms | 344 ms | 0 | 10 | 43 KB | 0 / 4 auth |
| index.html | desktop-fast | 76 ms | 76 ms | 0 | 18 | 49 KB | 2 |
| index.html | desktop-slow | 608 ms | 608 ms | 0 | 18 | 49 KB | 2 |
| index.html | **slow-3G** | **2 020 ms** | 2 020 ms | 0 | 17 | 49 KB | 2 |
| store.html | **slow-3G** | **2 328 ms** | 2 328 ms | 0.047 | 22 | 63 KB | 4 |

Homepage mobile-4G FCP across three independent runs: **408 / 368 / 376 ms** (median 376). Run-to-run spread is ±20 ms, so differences under ~40 ms in this report are not meaningful.

---

## 5. Core Web Vitals

### 5.1 FCP — what delays first paint

On mobile-4G the homepage paints at **376 ms**. The critical chain is: HTML → `styles.css` (render-blocking) → paint. All JavaScript is `defer`red, so **no script blocks first paint**.

The single blocking resource is `assets/css/styles.css`: **80 827 bytes raw, 20 207 bytes gzipped (4.0× ratio)**. On slow 3G it is the largest item on the critical path and the primary reason FCP is 2 020 ms rather than a few hundred.

**FCP is not affected by the backend** (§5.5).

### 5.2 LCP — element and cause

| Page | LCP element | LCP |
|---|---|---|
| index.html | *not captured* (see note) | 376 ms |
| product.html | `h2.section-title` | 1 140 ms |
| search.html | `h1` | 384 ms |
| categories.html | `span.category-rail-label` | 364 ms |
| cart / dashboard | `h1` | 404 / 344 ms |

On the pages where LCP resolves, **LCP is text and equals FCP** — the largest element is header/section text painted with the shell.

> **Limitation:** remote photos were stubbed as 1×1 GIFs, so a real product image can never win LCP here. **In production, LCP on `index.html`, `store.html` and `product.html` is very likely a Cloudinary/Drive product photo, not text.** `index.html` and `store.html` reporting no LCP element is consistent with that — the candidate was the stubbed image. This is the single most important thing to re-measure against production (§22).

`product.html` is the exception worth noting even in the lab: its LCP is **1 140 ms against a 416 ms FCP**, a 724 ms gap caused by the reviews section rendering late — the same event that causes its CLS.

### 5.3 CLS — measured and attributed

| Page | CLS | Verdict |
|---|---|---|
| index.html | **0.000** | good |
| stores / search / categories / cart / dashboard | **0.000** | good |
| store.html | 0.047 | good (<0.1) |
| **product.html** | **0.847** | **poor (8.5× the failing threshold)** |

Attribution, from `layout-shift` entry sources:

```
product.html   0.8532 @ 879 ms
  div.store-branding-info   y 44→54   h 20→44     ← header grows when store data lands
  p#store-name-tagline      y 44→54
  main#main.page-products   y 98→142  h 108→702   ← everything below is pushed 44px
  p                         y 150→0   h 24→0

store.html     0.0470 @ 909 ms
  div.store-branding-info   y 44→54   h 20→44     ← same cause
  main#main.page-products   y 84→128  h 760→716
```

**One root cause, two pages.** `.store-branding-info` in the header has no reserved height. When `listProducts` returns (~880 ms) the store name, phone line and delivery icons are injected, the header grows 24 px, and everything below jumps.

It scores 18× worse on `product.html` because that page is nearly empty at 880 ms — `main` is 108 px tall — so the shifted region covers a far larger fraction of the viewport. `store.html` already has a tall product grid, so the same 44 px displacement is a small fraction of the page.

### 5.4 Interaction responsiveness (INP proxy)

Field INP is N/A. Lab measurement at 390 px with 4× CPU throttle, using the Event Timing API that INP is derived from:

| Interaction | click→next paint | worst event | input delay |
|---|---|---|---|
| Homepage: category shortcut | 295 ms | 16 ms | 1 ms |
| Browse: switch category | 118 ms | 32 ms | 3 ms |
| Browse: **More…** (page next 12) | 109 ms | 32 ms | 1 ms |
| Store: add to cart | 131 ms | 56 ms | 2 ms |
| Store: open chat | 202 ms | 48 ms | 4 ms |
| Store: filter products (typing) | 404 ms | 48 ms | 4 ms |
| Stores: open a store card | 272 ms | 48 ms | 8 ms |

**Worst single event: 56 ms; worst input delay: 8 ms.** All comfortably inside the 200 ms "good INP" budget. **Interactivity is not a problem in V1.** The 404 ms on product filtering is cumulative across five keystrokes with a debounce, not one slow response.

### 5.5 TTFB

**Production TTFB: N/A — not measurable from this environment.**

What *is* measurable is that **TTFB from the backend does not gate first paint.** Homepage FCP against mocked API latency:

| API latency | 0 ms | 300 ms | 600 ms | 1 200 ms | 2 500 ms |
|---|---|---|---|---|---|
| FCP | 376 ms | 388 ms | 376 ms | 388 ms | 420 ms |
| DOMContentLoaded | 625 ms | 618 ms | 624 ms | 648 ms | 668 ms |

A **2 500 ms** backend delay costs **44 ms** of FCP. The shell is decoupled from the data. What backend latency *does* delay is the appearance of products — a real problem for perceived usefulness, but a different problem from "the site loads slowly", and it must not be conflated with hosting.

---

## 6. JavaScript Audit

| | Raw | gzip |
|---|---|---|
| All JS in repo (38 files) | 321.8 KB | 105.4 KB |
| Loaded by `index.html` (11 files) | 63.9 KB | 24.8 KB |
| Loaded by `checkout.html` (12 files, heaviest page) | 114.6 KB | 39.9 KB |
| Loaded by `store.html` (12 files) | 112.4 KB | 39.3 KB |

Measured execution, mobile-4G, 4× CPU throttle (CDP `Performance.getMetrics`):

| Page | ScriptDuration | Long tasks (total) |
|---|---|---|
| index.html | 27–31 ms | 74–204 ms |
| store.html | 33–59 ms | 156–226 ms |
| product.html | 38 ms | 142 ms |
| desktop-fast (any) | 5–9 ms | 0 ms |

**JavaScript execution is not a bottleneck.** Under 4× CPU throttling the heaviest page spends **under 60 ms** executing script. Long-task time is dominated by parse/compile of ~12 separate files plus initial render, not by application logic.

Findings:

- **No duplicate libraries, no unused frameworks, no polyfills.** Nothing is loaded that isn't the site's own code.
- **All scripts are `defer`red** — none block parsing or first paint. This is already correct.
- **12 separate `<script>` tags on the heaviest pages.** Each is a separate request. On a warm service-worker cache this costs nothing; on a cold slow-3G load it is 12 round trips that a single bundle would avoid. **No build step exists**, so this is a V2 architecture decision, not a bug.
- **`helpers.js` is 37.1 KB raw** and loaded on every page including ones that use a fraction of it. Genuinely unused-per-page JS is real but was **not quantified** — no coverage instrumentation was run. Marked as unmeasured rather than estimated.
- **Duplicate work across modules:** `getCustomerInbox` is requested by both `customer-messages.js` and `bottom-nav.js` on `customer-messages.html`, producing two identical in-flight requests (§10).

---

## 7. CSS Audit

| File | Raw | gzip | Render-blocking |
|---|---|---|---|
| `assets/css/styles.css` | 80 827 B | 20 207 B | **yes** |
| second stylesheet | ~12.4 KB | ~3.0 KB | owner pages only |
| **Total** | 93.2 KB | 23.2 KB | |

- **One stylesheet, no `@import`, no external CSS, no font CSS.** Structurally clean.
- **`styles.css` is the only render-blocking resource on the critical path**, and the single largest text asset. On slow 3G it is the main determinant of FCP.
- **It is a single global stylesheet for 23 pages.** Every page pays for every other page's rules — owner dashboard styles, chat window, checkout, reviews. Unused-CSS-per-page was **not measured** (no coverage run), so no percentage is claimed, but the structure guarantees the number is large.
- No `@font-face`, no icon font, no external stylesheet: **zero third-party CSS cost.**

---

## 8. Image Audit

### Bundled assets (in the repo)

| File | Format | Bytes | Dimensions | On load path? |
|---|---|---|---|---|
| `app-icon-ios-1024.png` | PNG | 131 846 | 1024×1024 | **No** — not referenced by HTML/CSS/manifest |
| `app-icon-android-512.png` | PNG | 26 329 | 512×512 | No — PWA manifest, install-time only |
| `app-icon-maskable-512.png` | PNG | 9 598 | 512×512 | No — manifest |
| `app-icon-192.png` | PNG | 3 233 | 192×192 | No — manifest |
| `apple-touch-icon-180.png` | PNG | 2 954 | 180×180 | No — `<link rel=apple-touch-icon>`, iOS install |
| `app-icon-source.svg` | SVG | 599 | 100×100 | No — design source |
| `favicon.svg` | SVG | **549** | 100×100 | **Yes** |
| **Total bundled** | | **171.0 KB** | | **549 B on the load path** |

**Bundled images contribute 549 bytes to a page load.** The 171 KB total is misleading: it is almost entirely PWA install icons that are never fetched during browsing. `app-icon-ios-1024.png` (131 KB, 77 % of the total) appears to be referenced by nothing at all — dead weight in the repo, but **zero** runtime cost.

### Remote photo pipeline

Already well-built:

- `optimizedImageUrl()` inserts **`f_auto,q_auto`** on Cloudinary (automatic WebP/AVIF where the browser supports it) and a **`=w<N>`** suffix on Google Drive photos.
- Width caps: `{ logo: 160, thumb: 160, card: 520, chat: 440 }`.
- **All 11 JS-emitted `<img>` tags use `loading="lazy"`**; none are eager.
- Service worker caches photos **cache-first** in a separate, size-capped bucket (`mwakete-img-v1`, 80 entries) — safe because every uploaded photo has a unique URL.

Findings:

- **No `srcset` / `<picture>` anywhere.** One width is requested for all devices and pixel ratios.
- **`card: 520` over-fetches.** Browse tiles render ~173 CSS px wide (three across at 390 px) and store cards ~186 px. At DPR 2 that needs ~350–372 px; 520 is ~1.4–1.5× larger than required on the most common device class.
- **Actual photo bytes in production: N/A** — Cloudinary is unreachable from the audit environment. Given `f_auto,q_auto` plus width caps, per-image weight is *likely* modest, but this is the largest unmeasured quantity in the audit and should be the first thing checked against production.

**Percentage of initial page weight caused by images: ~1 %** (549 B of 49 KB) **for bundled assets.** Including real product photos this figure is unknown and probably dominant — see §22.

---

## 9. Network Audit

Homepage, mobile-4G, cold, gzip transport: **17 requests, 49 KB transferred.**

| Type | Count | Transferred (gzip) |
|---|---|---|
| CSS | 1 | 20.2 KB |
| JS | 11 | ~19 KB |
| Images | 2 | ~0.8 KB (stubbed) |
| API (fetch) | 2 | <1 KB |
| Other (manifest, favicon) | 2 | ~0.8 KB |

### Top requests by duration (homepage, mobile-4G, uncompressed run — durations are transport-dependent)

| Duration | Transferred | Type | Resource |
|---|---|---|---|
| 618 ms | ~0 KB | fetch | `getCustomerInbox` (mocked at 600 ms) |
| 607 ms | ~0 KB | fetch | `getHomePageData` (mocked at 600 ms) |
| 494 ms | 79.2 KB | link | **`assets/css/styles.css`** |
| 383 ms | 6.6 KB | script | `register-sw.js` |
| 382 ms | 6.7 KB | script | `bottom-nav.js` |
| 361 ms | 2.7 KB | script | `header-cart.js` |
| 292 ms | ~0 KB | img | Cloudinary photo (stubbed) |
| 280 ms | 37.1 KB | script | **`helpers.js`** |
| 263 ms | 2.7 KB | script | `home-nav.js` |
| 258 ms | 2.6 KB | script | `customer-auth.js` |

With gzip these fall roughly 4× for text assets; the ordering is unchanged. **`styles.css` and `helpers.js` are the two largest single downloads.**

Findings:

- **No render-blocking third-party request exists.** Nothing external is on the critical path.
- **Two `preconnect` hints per page** (`script.google.com`, `script.googleusercontent.com`) plus two for image CDNs. The second Apps Script preconnect assumes `/exec` 302-redirects to `script.googleusercontent.com`; **this was not verifiable from the audit environment** and, if wrong, is a wasted connection on every page.
- **Duplicate requests found — see §10.**
- Compression is the dominant network lever: 148 KB → 49 KB, slow-3G FCP 4 188 ms → 2 020 ms.

---

## 10. API Audit

API calls issued during initial page load (traced, both logged-out and logged-in):

| Page | Calls | Actions (offset from first) |
|---|---|---|
| index.html | 2 | `getHomePageData` +0, `getCustomerInbox` +613 |
| store.html | 4 | `listProducts` +0, `getConversation` +615, `getCustomerInbox` +616, `recordStoreVisit` +617 |
| product.html | 3 | `listProducts` +0, `getConversation` +619, `getCustomerInbox` +620 |
| search.html | 2 | `searchProducts` +0, `getCustomerInbox` +619 |
| stores.html | 2 | `listStores` +0, `getCustomerInbox` +617 |
| categories.html | 2 | `searchProducts` +0, `getCustomerInbox` +617 |
| cart.html | 3 | `getStorePublicInfo` +0, `getConversation` +619, `getCustomerInbox` +619 |
| **checkout.html** | **6** | `getStorePublicInfo` +0, `getCustomerInbox` +1, `getConversation` +14, **`getStorePublicInfo` +64**, **`getConversation` +688**, **`getCustomerInbox` +688** |
| customer-dashboard.html | 0 / **4** auth | `getCustomerProfile`, `getCustomerInbox`, `listCustomerOrders`, `listCustomerBookings` |
| **customer-messages.html** | **2** | **`getCustomerInbox` +0, `getCustomerInbox` +17** |
| customer-tips.html | 2 | `getTips` +0, `getCustomerInbox` +23 |
| my-carts.html | 1 | `getCustomerInbox` +0 |

### Findings

**F1 — `getCustomerInbox` fires on every page in the site.** It backs the nav unread badge. It is **uncached** and costs **3 full-tab scans** (Conversations, Owners, Messages). Every page view by any visitor who has ever opened a chat pays for a full scan of the Messages table.

**F2 — `checkout.html` makes 6 calls where 3 suffice.** `getStorePublicInfo` twice (+0 ms and +64 ms), `getConversation` twice, `getCustomerInbox` twice. Two independent modules initialise the same data.

**F3 — `customer-messages.html` requests `getCustomerInbox` twice**, 17 ms apart — once from the page, once from the nav badge. Two identical in-flight requests, each 3 full scans.

**F4 — the second wave is serialised behind the first.** On `store.html` the first call starts at +0 and the next three at +615 ms — they are deliberately deferred until the critical request resolves (`whenIdle`). Good for FCP, but it means the *complete* page is two backend round trips deep, not one.

**F5 — logging in adds 4 calls on the dashboard and 0 elsewhere.** Authentication does not slow public browsing. `getCustomerProfile` and `getCustomerInbox` fire immediately; `listCustomerOrders` and `listCustomerBookings` wait for them, adding a second round trip.

**Per-call timings: N/A** — the backend was mocked. Response sizes for real data: N/A.

---

## 11. Apps Script Audit

**Execution time: N/A — not measurable from this environment.** What follows is static analysis of the real `.gs` source: how many **full-tab reads** each action performs. This is the right unit because `Db.gs`'s `sheetToObjects(getSheet(tab))` pulls **every row of a tab** into memory — Sheets has no server-side query, so "find one row" is a whole-table scan and cost grows with the tab, not the answer.

| Action | Full scans | Tabs scanned | Writes | Cached | Lock |
|---|---|---|---|---|---|
| **getHomePageData** | **5** | Owners ×2, Variants, Products, Reviews | 0 | yes (300 s) | no |
| **getTips** | **4** | Featured, Owners, Variants, Products | 0 | **no** | no |
| listProducts | 4 | Products, Variants, Owners, Reviews | 0 | yes (60 s) | no |
| searchProducts | 4 | Owners, Variants, Products, Reviews | 0 | yes (60 s) | no |
| createOrder | 3 | Variants, Products, Owners | 3 | no | yes |
| createBookingRequest | 3 | Products, Variants, Owners | 2 | no | yes |
| getConversation | 3 | Owners, Conversations, Messages | 3 | yes (10 s) | no |
| **getCustomerInbox** | **3** | Conversations, Owners, Messages | 0 | **no** | no |
| sendMessage | 2 | Owners, Conversations | 4 | no | yes |
| listOwnerProducts | 2 | Products, Variants | 0 | no | no |
| getStorePublicInfo | 1 | Owners | 0 | yes (60 s) | no |
| listStores | 1 | Owners | 0 | yes (60 s) | no |
| listCustomerOrders | 1 | Orders | 0 | **no** | no |
| listCustomerBookings | 1 | Bookings | 0 | **no** | no |
| listOwnerOrders / listOwnerBookings | 1 | Orders / Bookings | 0 | no | no |
| submitReview | 1 | Orders | 2 | no | yes |

*(Full table for all 55 actions: `performance-audit/data/appsscript.json`.)*

### Findings

- **The two hottest read paths are cached.** `getHomePageData` (5 scans) is cached 300 s, `listProducts`/`searchProducts` (4 scans) 60 s. With any concurrent traffic most homepage hits are cache hits. This is the single best thing about the current backend.
- **`getCustomerInbox` is the worst uncached path**: 3 full scans including **Messages**, the fastest-growing table in the system, executed **on every page view** (F1). It has no cache and no reason not to have one.
- **`getTips` performs 4 full scans uncached.**
- `listCustomerOrders` / `listCustomerBookings` scan Orders / Bookings entirely to find one customer's rows — inherent to Sheets, but uncached and unbounded.
- **`LockService` is used correctly** where it matters (order/booking creation, auth mutations, review submission) and absent from read paths, which is right.
- **Cache TTLs:** topProducts/topStores 300 s; listStores, searchProducts, storeInfo, listProducts 60 s; chat messages 10 s, conversations 8 s.
- **Apps Script cold start** (an idle Web App spinning up) is a known multi-second cost and is **N/A — unmeasurable here.** It is a plausible contributor to the "sometimes very slow" user experience and should be measured in production.

---

## 12. Google Sheets Audit

**Row counts, tab sizes and operation latency: N/A — the spreadsheet is unreachable from this environment.** Structural findings from source:

- **12 tabs** across one spreadsheet.
- **`Db.gs` reads whole tabs by design.** `sheetToObjects()` calls `getDataRange().getValues()` equivalent semantics — every row, every column, into memory, then filters in JavaScript.
- **There is no per-row read anywhere on the hot paths.** `findRowById`/`findRowBySecret` exist and are used for auth and single-record lookups, which is good, but the product/store/chat read paths all scan.
- **Growth characteristic:** homepage cost is O(Owners + Products + Variants + Reviews); chat badge cost is O(Conversations + Owners + Messages) **per page view**. Both grow with total marketplace size, not with what the shopper asked for. **This is the structural scaling risk in V1** — it is invisible at today's data volume and becomes the dominant cost as Messages and Products grow.
- **Writes are row-append or single-row-update** (`appendRowFromObject`, `updateRowFromObject`) — no cell-by-cell loops found. Writes are not a concern.
- `ensureColumn()` appends a header rather than rewriting row 1 — safe and cheap.

---

## 13. Caching Audit

| Layer | Present? | Detail |
|---|---|---|
| Service worker | **Yes, strong** | `mwakete-v24`; precaches shell + every customer page and script; stale-while-revalidate for navigations and static assets; cache-first for photos in a capped bucket; API responses **never** cached (correct) |
| HTTP caching | Yes (host default) | GitHub Pages `max-age`; mirrored in the audit harness |
| Apps Script `CacheService` | Partial | See §11 — hottest read paths cached 60–300 s; **`getCustomerInbox`, `getTips`, `listCustomerOrders`, `listCustomerBookings` uncached** |
| `localStorage` | Yes | Cart per store, active store, chat tokens, inbox read-marks, cookie consent, customer session |
| `sessionStorage` | Not used | |
| In-memory | Per-request only | `makeStoreNameResolver()`, `ownerCache` inside a single call |

**Measured impact of the service worker — the strongest result in this audit:**

| | Cold | Warm | Change |
|---|---|---|---|
| index.html FCP | 376 ms | **128 ms** | **−66 %** |
| index.html transferred | 49 KB | **0 KB** | **−100 %** |
| store.html FCP | 422 ms | **144 ms** | −66 % |
| store.html transferred | 63 KB | **0 KB** | −100 % |

A returning visitor downloads **nothing** for the shell. Repeat-visit performance is already excellent and needs no work.

**What should be cached but isn't:** `getCustomerInbox` (highest value by far — every page, 3 scans), `getTips`, and the customer's own orders/bookings lists.

---

## 14. Mobile Audit

Mobile is the priority for Kiribati users, so slow-3G is the number that matters.

| Metric | mobile-4G | slow-3G | Assessment |
|---|---|---|---|
| Homepage FCP/LCP | 376 ms | **2 020 ms** | acceptable / poor |
| Store FCP/LCP | 422 ms | **2 328 ms** | acceptable / poor |
| Page weight | 49–63 KB | 49–63 KB | good |
| Requests | 13–22 | 13–22 | acceptable |
| Script execution | 27–59 ms | 39–65 ms | good |
| Long tasks | 74–226 ms | 266–345 ms | acceptable |
| Worst interaction event | 56 ms | not measured | good |
| CLS (product page) | **0.847** | **0.847** | **poor** |

**The biggest mobile bottleneck is bytes on the critical path, and within that, `styles.css`.** At 400 kbps, 49 KB of shell is ~1 s of pure transfer before anything can paint; the render-blocking stylesheet is the largest single item.

**Second is CLS on the product page** — 0.847 is a worse experience on mobile, where the 44 px jump is a larger share of the viewport and can move a tap target under a finger.

**CPU is not a mobile bottleneck.** Even at 6× throttle, script execution stays under 65 ms.

---

## 15. Third-Party Audit

| Origin | Purpose | Blocks render? | Required? |
|---|---|---|---|
| `res.cloudinary.com` | Product/store photos | No — `loading="lazy"`, preconnected | Yes |
| `lh3.googleusercontent.com` | Drive-hosted photos | No — lazy, preconnected | Yes |
| `script.google.com` | Apps Script API | No — `defer`red fetch after paint | Yes |
| `script.googleusercontent.com` | Assumed `/exec` redirect target | No | **Unverified** |
| `m.me` | Messenger deep link | No — user-initiated | Yes |
| `www.w3.org` | SVG namespace string | No — not a request | n/a |

**There are no third-party fonts, analytics, tag managers, A/B tools, chat widgets or JavaScript libraries.** Total third-party render-blocking cost: **zero**.

This is a genuine architectural strength and is unusual. **Any V2 that introduces a framework, a font, or an analytics tag will make first paint worse than V1 unless deliberately budgeted for.**

The only actionable item: the `script.googleusercontent.com` preconnect is unverified. If `/exec` does not in fact redirect there, it is a wasted DNS+TLS handshake on every page.

---

## 16. Bottleneck Ranking

### P0 — Critical

**P0-1. `product.html` layout shift, CLS 0.847**
*Evidence:* single shift of 0.8532 at 879 ms; `div.store-branding-info` h 20→44, `main` y 98→142.
*Impact:* 8.5× the "poor" threshold. Content moves under the user's finger ~0.9 s in.
*Cause:* store-branding header has no reserved height until store data arrives.
*V2 fix:* reserve the header's final height in CSS at first paint.
*Benefit:* CLS → ~0 on product and store pages.
*Difficulty:* **Low** — a CSS `min-height`.

### P1 — High

**P1-1. `getCustomerInbox` on every page, uncached, 3 full scans**
*Evidence:* traced on 11 of 12 pages; §11 shows 3 scans incl. Messages, no `getCached`.
*Impact:* not measurable in wall-clock here, but it is the highest-frequency × highest-cost backend path in the system, and the one that degrades fastest as Messages grows.
*V2 fix:* cache per customer token (a 30–60 s TTL matches the badge's usefulness); serve the badge from `localStorage` first and revalidate.
*Difficulty:* **Low.**

**P1-2. Render-blocking `styles.css` — 80.8 KB raw / 20.2 KB gzip, one file for 23 pages**
*Evidence:* the only render-blocking resource; slowest non-API request; slow-3G FCP 2 020 ms.
*V2 fix:* inline critical CSS; split per-page or per-area; drop owner-portal CSS from customer pages.
*Difficulty:* **Medium.**

**P1-3. Uncompressed transport would double slow-3G time**
*Evidence:* slow-3G FCP 4 188 ms uncompressed vs 2 020 ms gzipped.
*Status:* GitHub Pages **does** compress, so this is currently fine. Recorded so that any V2 host change is verified to preserve it — this is the largest single measured lever in the audit.
*Difficulty:* **Low (verification only).**

### P2 — Medium

**P2-1. `checkout.html` issues 6 API calls where 3 suffice** — duplicate `getStorePublicInfo`, `getConversation`, `getCustomerInbox`. *Low difficulty.*
**P2-2. `customer-messages.html` requests `getCustomerInbox` twice, 17 ms apart.** *Low.*
**P2-3. 12 separate script files on the heaviest pages** — 12 cold round trips, no bundling. *Medium (needs a build step).*
**P2-4. `IMG_W.card = 520` for ~173–186 px slots** — ~1.4–1.5× over-fetch at DPR 2; no `srcset`. *Low.*
**P2-5. `getTips` — 4 full scans, uncached.** *Low.*

### P3 — Low

**P3-1. `app-icon-ios-1024.png` (131 KB) referenced by nothing** — zero runtime cost, repo weight only.
**P3-2. `script.googleusercontent.com` preconnect unverified** — possibly a wasted handshake per page.
**P3-3. `helpers.js` (37 KB) loaded whole on every page** — unused-per-page fraction unmeasured.

---

## 17. GitHub Hosting Assessment

### Is GitHub the bottleneck? **NO.**

Evidence:

1. **Nothing GitHub serves is slow in a way a different host would fix.** The site is 17 requests and 49 KB gzipped. That is a small static payload; any competent static host delivers it comparably.
2. **GitHub Pages already does the thing that matters most — compression.** Measured: gzip halves slow-3G FCP (4 188 → 2 020 ms). A host swap cannot beat "already compressed".
3. **First paint is not backend-gated** (2 500 ms of backend latency costs 44 ms of FCP), so the "slow site" complaint cannot be attributed to delivery at all.
4. **Repeat visits transfer 0 bytes** — the service worker means the host is not even contacted for the shell.
5. **The largest single asset is the site's own stylesheet**, which no host change improves.

**Caveat — the one thing that could implicate hosting, unmeasured:** GitHub Pages has no edge presence near Kiribati, so real TTFB and TLS handshake time from Tarawa are unknown and **N/A** in this audit. If a production measurement from a Kiribati connection shows TTFB in the high hundreds of milliseconds, a CDN with better Pacific coverage becomes a *defensible* option. **Until that measurement exists, there is no evidence for moving hosts, and moving would be a change made on assumption — exactly what this audit is meant to prevent.**

**Recommendation: do not move off GitHub Pages in V2 on current evidence.** Measure production TTFB from a Kiribati connection first; revisit only if that number is poor.

---

## 18. V1 Performance Scorecard

Measured values: mobile-4G / desktop-fast, cold, gzip, API mocked at 600 ms.

| Metric | Desktop | Mobile (4G) | Mobile (slow 3G) | Target | Status |
|---|---|---|---|---|---|
| FCP | 76 ms | 376 ms | 2 020 ms | <1 800 ms mobile | ✅ 4G / ❌ 3G |
| LCP | 76 ms | 376 ms | 2 020 ms | <2 500 ms | ✅ (but see §5.2 caveat) |
| CLS — most pages | 0 | 0 | 0 | <0.1 | ✅ |
| CLS — `product.html` | 0.031 | **0.847** | **0.847** | <0.1 | ❌ **fail** |
| INP (lab proxy) | not throttled | 56 ms worst event | N/A | <200 ms | ✅ |
| TTFB | **N/A** | **N/A** | **N/A** | <800 ms | **unmeasurable** |
| Initial page weight | 49 KB | 49–63 KB | 49–63 KB | <150 KB | ✅ |
| JavaScript (gzip, per page) | 24.8–39.9 KB | same | same | <100 KB | ✅ |
| Image weight (bundled) | 549 B | 549 B | 549 B | — | ✅ |
| Image weight (real photos) | **N/A** | **N/A** | **N/A** | — | **unmeasurable** |
| Network requests | 17–22 | 13–22 | 13–22 | <30 | ✅ |
| API latency | **N/A** | **N/A** | **N/A** | <500 ms | **unmeasurable** |
| Apps Script execution | **N/A** | **N/A** | **N/A** | <1 000 ms | **unmeasurable** |
| Sheets ops per request | 5 (homepage, cache miss) | same | same | ≤2 | ❌ structural |
| Repeat visit FCP | — | **128 ms, 0 KB** | — | <500 ms | ✅ excellent |

---

## 19. V2 Performance Targets

Targets are derived from measured V1 values, not chosen arbitrarily. Mobile on a slow connection is the governing case.

| Metric | V1 measured | V2 target | Rationale |
|---|---|---|---|
| FCP, slow 3G | 2 020 ms | **≤1 200 ms** | Achievable by cutting critical CSS; the 49 KB shell is already small |
| FCP, mobile 4G | 376 ms | **≤300 ms** | Modest; V1 is already good |
| LCP, slow 3G | 2 020 ms | **≤2 000 ms** | Must be re-baselined against real photos first (§5.2) |
| **CLS, all pages** | 0.847 worst | **≤0.05** | A reserved header height alone should achieve this |
| INP | 56 ms worst event | **≤200 ms** | Hold the line; do not regress |
| Critical CSS | 20.2 KB gzip, blocking | **≤8 KB inlined** | Rest deferred |
| Initial JS, gzip | 24.8–39.9 KB | **≤35 KB** | Keep; do not add a framework |
| Requests, cold | 13–22 | **≤14** | Bundling recovers ~8 |
| API calls on load | 2–6 | **≤2** | Fix P2-1/P2-2; batch the badge |
| Sheets full scans / request | up to 5 | **≤2** | Requires indexing or a different store |
| Repeat-visit FCP | 128 ms | **≤150 ms** | Already met — protect it |

**Explicit non-target:** do not pursue a lower page weight by moving to a JavaScript framework. V1's 49 KB with zero dependencies is better than most framework baselines.

---

## 20. Recommended V2 Architecture Changes

Ordered by measured value per unit of effort. Detail in `MWAKETE_V2_PERFORMANCE_PLAN.md`.

1. Reserve the store-branding header height (fixes P0-1).
2. Cache `getCustomerInbox`; render the badge from `localStorage` first.
3. Split/inline critical CSS.
4. De-duplicate checkout and messages API calls.
5. Bundle JS per page (introduces a build step — the largest architectural decision here).
6. Add `srcset` and lower `IMG_W.card`.
7. Cache `getTips`, `listCustomerOrders`, `listCustomerBookings`.
8. Measure production TTFB, Apps Script execution and real photo weight **before** any further architectural change.
9. Plan the data layer's exit from whole-tab scans — the one change that does not scale away on its own.
10. Keep: no framework, no fonts, no analytics, `defer`red scripts, the service worker.

---

## 21. Evidence

| Artefact | Contents |
|---|---|
| `MWAKETE_V1_PERFORMANCE_DATA.csv` | 48 page-load runs, 24 columns |
| `performance-audit/data/inventory.json` | Every file, size, gzip size, per-page script/style/image graph |
| `performance-audit/data/appsscript.json` | All 55 actions: full scans, tabs, writes, cache, lock |
| `performance-audit/data/measurements-gzip.json` | Primary runs (representative transport) |
| `performance-audit/data/measurements.json` | Uncompressed contrast runs |
| `performance-audit/data/cls-attribution.json` | Per-shift element attribution |
| `performance-audit/data/interactions.json` | 7 interaction cases, Event Timing |
| `performance-audit/data/api-per-page.json` | API traces, logged-in and logged-out |
| `performance-audit/scripts/*.js` | Every script used, re-runnable |

Reproduce: `node performance-audit/scripts/gzip-server.js` then `AUDIT_BASE=http://127.0.0.1:8100 node performance-audit/scripts/measure.js`.

---

## 22. Limitations

**These matter for how much weight to put on each conclusion.**

1. **No production access.** `mwakete.com` and `script.google.com` are both unreachable from the audit sandbox (egress denied). Every conclusion about hosting latency, backend execution time, Sheets latency and real photo weight is therefore either N/A or static analysis.
2. **The backend was mocked.** Backend latency was *simulated* to isolate frontend cost. This proves first paint is decoupled from the backend; it says nothing about how slow the real backend is.
3. **Product photos were stubbed as 1×1 GIFs.** Real photos almost certainly become the LCP element on the homepage, store and product pages. **The LCP figures in this report are therefore a floor, not a prediction.** This is the most important gap.
4. **Unused CSS and JS were not quantified.** No coverage instrumentation was run, so no percentage is claimed.
5. **Local transport, not GitHub Pages.** Compression and cache headers were mirrored, but not TLS, HTTP/2 multiplexing, or geographic distance.
6. **Lab INP proxy, not field INP.** Real INP requires field data from real users.
7. **Sheets row counts unknown.** The scaling argument in §12 is structural, derived from code, not from observed table sizes.
8. **Single browser.** Chromium only; no Safari/iOS measurement, which matters given the PWA install path.

### Priority for closing the gaps

1. Real LCP with real photos, from production.
2. Production TTFB from a Kiribati connection — the only thing that could implicate hosting.
3. Apps Script execution time from the Executions log, especially `getCustomerInbox` and a cold start.
4. Actual Cloudinary/Drive delivered photo bytes.
