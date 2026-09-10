# V2 Regression Checklist

**Baseline commit:** `39cd862` — tagged **`v1-pre-v2-baseline`**.
Restore with `git checkout v1-pre-v2-baseline`.

This is the list an optimisation has to survive. Nothing ships in Phase 1 or
later that breaks a line here.

---

## The suites now live in `tests/`

**Resolved in Phase 1** (`7c43b7b`). When this checklist was first written the
91 suites existed only in an ephemeral container scratchpad and `git ls-files`
found zero test files — meaning §27's rollback rule had nothing to re-verify
against. They are now committed verbatim in `tests/`, with `tests/README.md`
covering how to run them and the two absolute paths they still assume.

---

## `search.html` is gone — what that changed here

The search page was removed after this checklist was written; `categories.html`
absorbed both browsing and site-wide search. **No row was dropped** — C3 still
has to hold, it is just tested on a different page:

| Row | Was covered by | Now |
|---|---|---|
| C1 | `verify-hero-gaps` — its whole subject was the search page's hero | `verify-order` (homepage section order and spacing) |
| C3 | `verify-search` — drove `search.html` directly | `verify-browse` (site-wide search on the browse page) |

`verify-search`, `verify-filters-layout` and `verify-hero-gaps` were deleted
because the page they drove no longer exists, not because they stopped passing.
`?type=` deep links still resolve — `categories.js` reads the parameter and
passes it to `searchProducts`, which is what smart-search discovery links build.

---

## How to use this

For each change:

1. Identify which rows it could plausibly touch.
2. Run the named suites **before** the change — record the numbers.
3. Make **one** change.
4. Run them again. Any drop is a regression: **revert first, investigate
   after** (§27). Do not stack a second change on a broken one.
5. Rows marked **MANUAL** have no automated cover. They need a human, or a new
   suite written before the area is touched.

---

## Customer

| # | Must keep working | Covered by |
|---|---|---|
| C1 | Homepage renders products, stores, category strip | `verify-homepage`, `verify-order` |
| C2 | Site navigation + bottom nav on every page | `verify-nav2`, `verify-tipsnav` |
| C3 | Search returns results for an exact term | `verify-browse`, `verify-searchbtn`, `verify-searchbtn2` |
| C4 | Smart search suggests categories when nothing matches, in English and te taetae ni Kiribati | `verify-smartsearch` (117 assertions) |
| C5 | Category browsing; rail and product pane scroll independently | `verify-categories`, `verify-panescroll`, `verify-browse` |
| C6 | Store directory and store pages | `verify-publicstore`, `test-publicstore`, `verify-storeheader` |
| C7 | Product cards link to their product page | `verify-cardlink`, `verify-cardloc`, `verify-card` |
| C8 | Product detail renders; variants selectable | `verify-products`, `verify-variety` |
| C9 | Similar-products carousel; excludes the current product | `verify-fabdrag` |
| C9b | Product-page layout stays stable while the carousel loads (CLS budget 0.05) | `verify-cls` |
| C10 | Cart add / update / remove; per-store carts | `verify-cart-overlay`, `verify-mycarts`, `verify-cartstores` |
| C11 | Checkout: delivery choice, totals, order placement | `verify-checkout`, `verify-order`, `verify-delivery` |
| C12 | "Back to Cart" under Place Order | `verify-backtocart` |
| C13 | Customer signup / login / logout | `verify-custauth`, `verify-chat-signin` |
| C14 | Customer dashboard, order history, bookings | `verify-dash`, `verify-dash3`, `verify-myorders`, `test-myorders` |
| C15 | Reviews render; collapsed section opens | `verify-reviews`, `verify-reviewsfold`, `verify-chevron`, `test-reviews` |
| C16 | Customer↔store chat; unread badges | `verify-messages`, `verify-inbox`, `verify-inbox2`, `test-inboxcount` |
| C17 | Chat FAB: **a tap opens the chat**, a drag moves it | `verify-fabdrag` |
| C18 | Tips page | `verify-tipsnav` |

## Vendor

| # | Must keep working | Covered by |
|---|---|---|
| V1 | Vendor registration, incl. required Messenger profile | `verify-messenger` |
| V2 | Vendor login + 2FA | `verify-authchannel-ui`, `test-authchannel` |
| V3 | Password reset | **MANUAL** |
| V4 | Deleted-store message on login | `verify-deletedmsg` |
| V5 | Dashboard loads; quick links resolve | `verify-dash`, `verify-dash3` |
| V6 | Store settings save (phone, logo, delivery, payment) | `verify-contact`, `test-contact`, `verify-logo` |
| V7 | Product create / edit / delete | `verify-products`, `verify-typeopts` |
| V8 | Variants and pricing | `verify-variety`, `test-costwrite` |
| V9 | Orders list | `test-orders-email` |
| V10 | Bookings list, conflict handling | **MANUAL** |
| V11 | Vendor messaging | `verify-messages` |
| V12 | Open/Closed toggle | `verify-storeopen`, `test-storeopen` |
| V13 | Admin page | `verify-admin` |

## Marketplace rules

| # | Must keep working | Covered by |
|---|---|---|
| M1 | Delivery methods and fees; "to be negotiated" when unset | `verify-delivery`, `verify-shipnote`, `verify-feemode` |
| M2 | Order creation and validation | `verify-order`, `test-orders-email` |
| M3 | Booking date conflicts | **MANUAL** |
| M4 | Featured / sponsored labelled, admin-set only | `verify-handicrafts`, `verify-categories` |
| M5 | Category taxonomy in sync front↔back | `test-taxonomy`, `verify-handicrafts` |
| M6 | Image upload | `verify-img` |
| M7 | Sheet/tab setup | `test-setupsheets`, `test-checksetup` |

## Security — no optimisation may weaken any of these

| # | Must keep working | Covered by |
|---|---|---|
| S1 | Vendor auth; session tokens expire | `test-authchannel`, `verify-authchannel-ui` |
| S2 | **Ownership checks** — a vendor cannot touch another's data | **MANUAL** — see `docs/security-audit.md` |
| S3 | **Server-side pricing** — cart totals never trusted from the browser | `test-costwrite`, `verify-order` |
| S4 | Server-side validation on public endpoints | `test-orders-email` |
| S5 | Public payload leaks nothing private | `test-publicstore` (byte-identical tripwire on `publicOwnerFields`) |
| S6 | Password hashing + salt | **MANUAL** |
| S7 | Rate limiting | **MANUAL** |
| S8 | Customer data not exposed cross-store | `test-publicstore`, `verify-inbox` |

## PWA / offline

| # | Must keep working | Covered by |
|---|---|---|
| P1 | Service worker installs; versioned cache; old caches cleaned | `verify-pwa`, `verify-manifest` |
| P2 | Offline page reachable | `verify-pwa` |
| P3 | A release invalidates stale assets — `CACHE` bumped on any change | `verify-perf`, `verify-perffixes`, and the per-suite CACHE guards |
| P4 | Install prompt; never overlaps the cookie notice | `verify-install`, `verify-fab`, `verify-cookie`, `verify-cookie2` |

---

## Known-failing at baseline — do not "fix" by accident, do not count as new

Six suites fail for reasons that predate this work. A change is judged against
**this** list, not against zero:

| Suite | State |
|---|---|
| `verify-card` | crash |
| `verify-cartfab` | 13/15 |
| `verify-cookie` | crash |
| `verify-custauth` | 11/14 |
| `verify-emailpopup` | crash |
| `verify-install` | crash |
| `verify-more-colors` | 27/28 — stale expected tile count, verified against `origin/main` |

**Two suites have left this list, and neither was actually failing — both were
not executing** while being counted as known failures:

- `verify-fab` had been timing out at 390px waiting for a cookie banner that is
  deliberately hidden below 1024px, testing an overlap that can no longer
  happen. Rewritten to guard the invariant that replaced it — **9/9**.
- `verify-searchwidth` was a **syntax error**: an unterminated string on line 44
  meant the file never loaded. One closing quote later — **9/9**. It covers
  search-box width on exactly the page Phase 1 changed.

The list is **six**, not eight.

---

## Files that must NOT be modified during the performance phase

| Path | Why |
|---|---|
| `apps-script/Auth.gs` | vendor auth, 2FA, password hashing. Any edit is a security change, not a performance one |
| `apps-script/Orders.gs` | server-side pricing and order validation (§S3, §S4) |
| `apps-script/Customers.gs` | customer accounts and sessions |
| `apps-script/Bookings.gs` | booking conflict logic, and the least test-covered area |
| `assets/js/checkout.js` — pricing paths | totals must stay server-authoritative |
| `docs/production-readiness-report.md`, `docs/chat-performance-optimizations.md`, `docs/security-audit.md` | existing records; V2 adds files, never overwrites these |

Performance work in these files is possible later, but it is its own change
with its own review — never bundled into an optimisation commit.

## Files that can safely be optimised

`assets/css/styles.css`, `assets/js/helpers.js`, the per-page JS modules, the
HTML `<head>` blocks, `sw.js`, and the read-only public actions in
`apps-script/Products.gs` (`actionListProducts`, `actionSearchProducts`,
`actionListStores`) — provided the response shape is unchanged, since
`test-publicstore` pins it.
