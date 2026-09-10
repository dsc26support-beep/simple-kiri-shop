# API Performance Audit

**Commit:** `39cd862` (tag `v1-pre-v2-baseline`) · **Date:** 2026-09-10

Sources: `performance-audit/data/api-per-page.json` and
`v2-baseline-gzip.json`, both re-run at this commit, plus a read of every
public action in `apps-script/`.

**Response sizes are from mocked payloads** (12 products, 12 stores). They show
the *shape* of each response, not production volume. Backend read counts are
from source and are exact.


> **Superseded on one point.** `search.html` was removed after this was
> written; `categories.html` absorbed browsing and site-wide search. The
> measurements below are still an accurate record of commit `39cd862` and are
> deliberately left as they were taken.

---

## Read this first — two rows that look like bugs and are not

**`/search.html` calling `searchProducts` twice.** The harness mocks **empty**
results for every action. An empty search is exactly the condition that makes
smart-search discovery issue one category query. With real data that matches,
discovery never runs — `verify-smartsearch` asserts "a working search makes
exactly ONE backend request". Not a duplicate.

**`/checkout.html [logged-in]` showing 6 calls, with `getStorePublicInfo`
twice.** Not reproducible in isolation: a clean single-page checkout load makes
exactly **one**. `api.js` de-duplicates identical in-flight GETs by URL, and it
was built for this precise case. The harness runs pages sequentially in one
browser context, so this is most likely request bleed from the previous page.
**Isolate before acting.** Recorded here so a future reader does not "fix" a
non-bug.

---

## Per page — initial load

`*` = POST. Offset is from the first call.

| Page | Calls | Sequence | API bytes |
|---|---|---|---|
| `/index.html` | 2 | `getHomePageData` +0ms · `getCustomerInbox*` +622ms | 14,374 |
| `/store.html` | 4 | `listProducts` +0ms · `getConversation*` +624ms · `getCustomerInbox*` +625ms · `recordStoreVisit*` +626ms | 23,442 |
| `/product.html` | 3 | `listProducts` +0ms · `getConversation*` +620ms · `getCustomerInbox*` +621ms | 8,751 |
| `/search.html?q=` | 2 (+1 only when empty) | `searchProducts` +0ms · [`searchProducts` discovery] · `getCustomerInbox*` | 11,576 |
| `/categories.html` | 3 | `getTips` +0ms · `searchProducts` +1ms · `getCustomerInbox*` +621ms | 11,597 |
| `/stores.html` | 2 | `listStores` +0ms · `getCustomerInbox*` +610ms | 2,863 |
| `/cart.html` | 3 | `getStorePublicInfo` +0ms · `getConversation*` +621ms · `getCustomerInbox*` +622ms | 0 |
| `/checkout.html` | 3 | `getStorePublicInfo` +0ms · `getConversation*` +627ms · `getCustomerInbox*` +628ms | 0 |
| `/customer-dashboard.html` | 1 → 4 auth | `getCustomerProfile*` · `getCustomerInbox*` · `listCustomerOrders*` · `listCustomerBookings*` | 0 |
| `/customer-messages.html` | 1 | `getCustomerInbox*` | — |
| `/my-carts.html` | 1 | `getCustomerInbox*` | — |
| `/customer-tips.html` | 2 | `getTips` +0ms · `getCustomerInbox*` +18ms | — |

**No page makes more than one critical (render-blocking) call.** Everything at
~+620 ms is deferred work that starts after the page has painted — which is
why backend latency does not move LCP (see `V2_BASELINE.md`, Finding 1).

---

## Per action

| Action | When | Critical? | Sheets read | Cache | Cacheable further? |
|---|---|---|---|---|---|
| `getHomePageData` | homepage load | **yes** | 0 direct — two cached helpers | ✓ | Already cached both sides |
| `listProducts` | store + product page | **yes** | Products, Variants — **2** | 60 s | Yes — semi-static |
| `searchProducts` | search, categories, discovery | **yes** | Owners, Products, Variants, Reviews — **4** | 60 s | Yes for category browse; **no** for a query |
| `listStores` | store directory | **yes** | Owners — **1** | 60 s | Yes — changes rarely |
| `getStorePublicInfo` | cart, checkout, chat | **yes** | 0 direct | 300 s | Already |
| `getTips` | tips, categories | no | — | ✓ | Yes — editorial |
| `getCustomerInbox` | any page, **only if the shopper has chat tokens** | no | Conversations — **1** | 20 s | No — unread counts must be fresh |
| `getConversation` | chat open | no | Conversations, Messages | ✓ | No |
| `recordStoreVisit` | store page | no | write | — | n/a — a write |
| `getCustomerProfile` | dashboard | **yes** (that page) | Customers | — | No — personal |
| `listCustomerOrders` / `listCustomerBookings` | dashboard | **yes** (that page) | Orders / Bookings | — | **Never** |

### The hot path

`actionSearchProducts` is the most expensive read in the system: **four full
sheet scans** (Owners, Products, Variants, and Reviews via
`productRatingIndex`), cached 60 s. It backs the search page, the category
browse page, and smart-search discovery.

`productRatingIndex()` (`Reviews.gs`) reads the **entire** Reviews sheet and
folds it to per-product averages on every cache miss — regardless of how many
products the query actually matched.

---

## Caching rules to carry into Phase 1

**Safe to cache harder** — public, slow-changing, no personal data:
`listStores`, `listProducts`, `getTips`, `getStorePublicInfo`, the category
taxonomy (already a client-side constant).

**Must stay fresh** — a stale answer here is a wrong answer:
`listCustomerOrders`, `listCustomerBookings`, `getCustomerProfile`,
`getConversation`, `getCustomerInbox`, booking availability, and **anything
touching price or stock**. Cart contents are `localStorage`, never cached
server-side.

**Never cache:** order creation, booking creation, auth, or any write.

---

## Observations, ranked by what they would actually buy

1. **`productRatingIndex` reads all Reviews on every `searchProducts` cache
   miss.** Scoping it to matched product ids would cut the hot path from four
   full scans to three. *Backend cost only — will not move LCP.*
2. **`getHomePageData` returns 14,374 bytes** for a first screen showing a
   handful of items. Worth checking whether the payload carries fields the
   homepage never renders. *Saves bytes on the one page every visitor hits.*
3. **`listProducts` on the product page returns the store's entire catalogue**
   to render one product. That is deliberate — it also feeds "similar
   products" and the chat header without extra calls — but on a large store it
   is the biggest single response on the page.
4. **`store.html` makes 4 calls and moves 23,442 bytes**, the most of any page.
   Three are deferred, so it does not hurt LCP, but it is the heaviest page for
   a shopper on metered data.
5. **Seven `getCached` call sites pass no explicit TTL.** Worth an audit for
   intent, not because a bug is known.

None of these are load-time wins. Per Finding 1 in `V2_BASELINE.md`, the
load-time lever is **bytes shipped**, not backend time.
