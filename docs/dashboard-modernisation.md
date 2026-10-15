# Dashboard modernisation — audit, plan and progress

This is the owner's master prompt of October 2026: modernise every dashboard, using the supplied reference images as a **layout** guide. Mwakete's own colours, logo and fonts stay. This file is the Stage 1 audit and the running record of each stage.

## 1. Existing dashboards (audited)

| Who | Pages today | Notes |
|---|---|---|
| Retailer / wholesaler / distributor (all one "store owner" account; `StoreType` decides) | `owner/dashboard.html` plus `products`, `inventory`, `inventory-sync`, `orders`, `bookings`, `messages`, `feature` and `settings` | There was a top bar only, with no shared side navigation. The old dashboard had 3 counters, computed in the browser from the first 100 orders. |
| Platform admin | `owner/admin.html` | An owner session listed in `ADMIN_EMAILS`. One long page with a sticky jump menu covering search, listing review, order problems, header adverts, featuring payments, wholesaler verification, inventory, marketing and badges. It has no overview figures. |
| Customer | `customer-dashboard.html`, `customer-messages.html`, `my-carts.html`, `recent.html`, `order-room.html` | Profile, orders (with order rooms), bookings and marketing opt-in. There is a customer bottom nav (`bottom-nav.js`). |
| Order room (buyer, seller, admin) | `order-room.html` | Added in #98. |
| **Delivery driver** | — | **Does not exist.** There are no driver accounts, jobs, assignment, GPS or proof-of-delivery. Delivery today is the seller's own truck, ship, air cargo or Pick & Pay, recorded by the seller in the order room. |
| **Delivery admin** | — | **Does not exist**, for the same reason. |

## 2. Brand palette: the source of truth

All colours come from `:root` in `assets/css/styles.css` (lines 3–56). `assets/css/owner.css` builds on the same variables. There is no other theme file and no framework.

| Token | Value | Used for |
|---|---|---|
| `--color-purple` | `#332d63` | Primary: the store-owner top bar, buttons and active states. **The sidebar uses this.** |
| `--color-purple-light` / `-pale` / `-soft` | `#6a61b8` / `#a8a1e0` / `#e8e5f2` | Active nav item, quick-action buttons, tints |
| `--color-red` | `#ce1126` | Public site header (flag red); unread badges |
| `--color-gold` / `-soft` | `#fcd116` / `#fff7d6` | Header rule, warnings, "attention" tags |
| `--color-blue` / `-light` / `-soft` | `#003f87` / `#5b9bd5` / `#dbe7f5` | Focus ring only (deliberately blue), info tints |
| `--color-success` / `--color-danger` | `#1e7a34` / `#b3261e` | Status text and pills |
| `--color-ink` / `-muted` / `-border` / `-bg` / `-bg-alt` | `#1a1a1a` / `#5f6368` / `#dcdfe3` / `#fff` / `#f7f7f5` | Text and surfaces |
| `--radius` and `--space-1` to `--space-5` | 10px; 0.25–2.5rem | Card radii and spacing |

**What changed:** the dashboard components use only these tokens. No new palette and no colours from the reference images were added. The reference's blue maps to Mwakete's purple.

## 3. Shared pieces reused

- **Buttons and statuses:** `.btn` variants, `.status-badge` pills (`owner.css`), `.dash-section`, `.helper-text`, `.form-error`.
- **Helpers:** `startLoadingMessage`, `escapeHtml` and `formatMoney` (`helpers.js`).
- **Session guards:** `Auth.guardOwnerAuth` and `CustomerAuth`.
- **Backend:** the existing rows and actions, such as `listOwnerOrders` and `getInventory`, plus the order-room tabs.

**New shared components (Stage 2):**
- In `styles.css`: `.kpi-grid` / `.kpi-card`, `.dash-panel`, `.dash-table` (it becomes cards on phones), `.sales-chart` (an inline SVG, no library), `.dash-alerts` and `.dash-pagehead`.
- In `owner.css`: the seller shell, a sidebar plus a phone tab bar and drawer, built by `owner-nav.js` (`SellerShell`).

## 4. Data available, and the gaps

**Available, now summarised server-side by `Dashboards.gs` `getSellerDashboard`:**
- orders today and yesterday;
- confirmed sales (Paid or Fulfilled only);
- 7- or 30-day series;
- pending payment;
- open order-room problems and unread room activity;
- low and out-of-stock items (`ReorderLevel`);
- active and held products;
- pending bookings and listing cases waiting on the seller;
- wholesale facts: verification, units on hand, locations.

All days are Kiribati calendar days (UTC+12).

**Gaps:** these don't exist in the backend. They are documented and not faked.

- **Wholesale price tiers and minimum order quantities.** No schema exists for them. The smallest extension is a `PriceTiersJson` field on a variant, validated in `ProductVariants.gs`, with prices applied in `actionCreateOrder`. This changes order pricing, so it needs owner approval.
- **Commissions and payouts.** Mwakete does not take payments, so there is nothing to show.
- **Drivers and delivery administration.** This needs a new account type, job assignment, location sharing and proof of delivery: a new subsystem and a product decision (see §6).
- **Customer favourites ("saved products").** `my-carts.html` holds saved carts on the device; there is no account-level favourites list.
- **Reorder.** Possible from order items via the existing cart. Planned for Stage 5.

## 5. Risks

- **Pinned tests.** Many existing browser tests pin owner and customer page markup. Stage 2 kept every ID they use (store toggle, quick links, badges, admin link), and the badges test now mocks the one summary call.
- **Admin page bulk.** `admin.html` is large; Stage 4 adds an overview on top rather than rewriting the sections.
- **Low bandwidth.** The dashboard makes **one** summary request instead of three list requests, and the chart is a few hundred bytes of SVG.

## 6. Stages

| Stage | Scope | Status |
|---|---|---|
| 1 | Audit (this file) | Done |
| 2 | Shared components; seller sidebar on computers, tab bar and drawer on phones, on every owner page including admin | Done in this PR |
| 3 | Retailer, wholesaler and distributor dashboard: real KPIs, sales chart, recent orders, attention list, quick actions, wholesale panel | Done in this PR |
| 4 | Admin overview at the top of `owner/admin.html`: orders, confirmed sales, stores, customers, a work queue, top stores with CSV export, recent orders and stock alerts. Uses one `getAdminOverview` endpoint. | Done (see §8) |
| 5 | Customer dashboard: summary cards, "needs you" from order rooms, Buy again, shortcuts | Done (see §9) |
| 6 | Driver and delivery admin | **Waiting for an owner decision.** No delivery backend exists. |
| 7–8 | Accessibility, performance, regression and deploy prep for each stage | Continuous |

## 7. Stage 2–3 record

**Files:**
- `apps-script/Dashboards.gs` (new)
- `apps-script/Code.gs` (route, `checkSetup` probe, `APP_VERSION`)
- `owner/dashboard.html`, `assets/js/owner-dashboard.js`
- `assets/js/owner-nav.js` (`SellerShell`)
- `owner/admin.html` (loads `owner-nav`)
- `assets/css/styles.css`, `assets/css/owner.css`
- `tests/test-seller-dashboard.js` (new), `tests/verify-seller-dashboard.js` (new)
- `tests/verify-badges.js`, `tests/test-checksetup.js` (updated)

**Preserved:**
- the store open/closed toggle;
- the quick links and their badges;
- the admin link for admins;
- the wholesale-pending notice;
- every owner page's top bar, logout and links.

**Deploy:**
1. Add `Dashboards.gs` and update `Code.gs`.
2. Deploy a new version.
3. Check `?action=getVersion`, which should show `dashboards1-2026-10-15`.
4. Check `?action=checkSetup`: `missingFiles` should be `[]`.

The dashboard shows a "could not be loaded — Try again" state until the backend is deployed. Nothing else on the page depends on it.

**Rollback:** revert the merge commit and redeploy the previous Apps Script version. No data is written by this stage.

## 8. Stage 4 record: admin overview

**Backend.** `Dashboards.gs` `actionGetAdminOverview` is admin-only (`isOwnerAdmin`). A seller who calls it is refused and the attempt is logged. It is read-only and covers the 7 or 30 days chosen.

It counts:
- **Orders and confirmed sales**, today vs yesterday, plus the daily series. Paid and Fulfilled orders only; the admin's own test store is left out.
- **Active stores:** active and standby, split into retailer, wholesaler and distributor, plus new stores in the period.
- **Customer accounts,** and new accounts in the period.
- **Waiting for an admin:**
  - featuring payments to review;
  - approved featuring payments not yet ticked "seen in bank";
  - open listing cases;
  - open order problems;
  - refunds due;
  - wholesaler or distributor stores waiting for a verification call;
  - orders unpaid for more than 3 days.
- **Top 8 stores** by confirmed sales.
- **The 8 newest orders:** reference, store, total, status and a problem flag. **No customer names, phones, emails or addresses** are included; admin search is where to look a person up.
- **Stock alerts** across live listings.

**Frontend.**
- "Overview" is now the first section of `owner/admin.html` and the first item in the section menu. It is drawn by `assets/js/admin-overview.js`.
- Each work-queue line links to its admin section.
- The top-stores table can be downloaded as CSV. The CSV is built in the page, and cells are protected against spreadsheet formulas.
- A failed load shows "Try again" with no figures.
- `assets/js/dash-ui.js` now holds the chart, the vs-yesterday wording, status pills and the CSV export, shared by both dashboards.

**Not shown,** because Mwakete doesn't have them, and the page says so:
- commissions and payouts (buyers pay sellers directly);
- delivery monitoring (stage 6 decision).

**Fix found while testing.** The screen-reader table behind each chart widened the page on 320px phones. It is now wrapped in a hidden container, on both dashboards.

**Tests:**
- `tests/test-admin-overview.js`: 14/14
- `tests/verify-admin-overview.js` (browser against the real backend): 14/14

**Deploy:**
1. Update `Dashboards.gs` and `Code.gs`, then deploy a new version.
2. `?action=getVersion` should show `adminoverview1-2026-10-15`.

## 9. Stage 5 record: customer dashboard

The changes to `customer-dashboard.html` add to what was there; the profile, orders, bookings and marketing opt-in all stay as they were.

**New on the page:**
- **Greeting:** "Hello, ‹first name›".
- **Four summary cards:**
  - **Active orders,** which filters the list below when tapped.
  - **Need you,** which counts orders where the order room is waiting for the buyer to send payment details, confirm receipt or confirm a refund. Tapping it filters the list.
  - **Completed** orders.
  - **Saved carts on this device.**
- **Every figure comes from the order list the page already loads,** so there is no extra request. The box reserves its height up front, so the orders below never move when the numbers arrive.
- **On each order row:** "Needs you: …" in plain words, next to the order-room link.
- **Buy again** on completed and cancelled orders. It puts the same items back in that store's cart on this device and opens the cart. Prices and stock are checked again on the server at checkout, so an old price is never charged.
- **Shortcuts:** Browse stores, My carts, Recents, Help & support.
- **A plain note** that payment goes directly to each store, and that the order room is the place to send payment details, confirm receipt or report a problem.

**Backend.** The buyer's order list now carries `room.todo` (`submitPayment`, `confirmReceipt`, `confirmRefund` or empty). It is worked out in `txSummariesFor` with the same `txNextActions` rules the room itself uses.

**Not built (gaps):**
- **Account-level favourites:** carts on the device are what exists today.
- **Saved delivery addresses:** checkout remembers the last address on the device only.
- **Separate receipts page:** the order room shows the full order summary.

**Tests:**
- `tests/verify-customer-dashboard.js`: 15/15, in the browser against the real backend. It covers:
  - the counts, and that another customer's orders never appear;
  - the filters;
  - Buy again;
  - no sideways scroll from 320 to 768px;
  - no layout shift when the numbers arrive.

**Deploy:**
1. Update `Transactions.gs` and `Code.gs`, then deploy a new version.
2. `?action=getVersion` should show `customerdash1-2026-10-15`.
