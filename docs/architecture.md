# Mwakete — Architecture Reference

A multi-vendor online marketplace for Kiribati shoppers. This document is a technical
reference for anyone (human or AI) picking up development on this codebase — how the
pieces fit together, where things live, and how data flows through the system.

For deployment steps, Script Properties, and operational caveats, see the root
[`README.md`](../README.md) — this document focuses on architecture, not setup.

## Table of contents

1. [System overview](#1-system-overview)
2. [Folder structure](#2-folder-structure)
3. [Frontend architecture](#3-frontend-architecture)
4. [Backend architecture](#4-backend-architecture)
5. [API documentation](#5-api-documentation)
6. [Database structure](#6-database-structure)
7. [Authentication flow](#7-authentication-flow)
8. [Vendor workflow](#8-vendor-workflow)
9. [Customer workflow](#9-customer-workflow)
10. [Admin workflow](#10-admin-workflow)

---

## 1. System overview

Multiple store owners each register, log in, and manage their own storefront —
products, photos (taken straight from a phone), delivery methods, and orders.
Customers browse a store, add product varieties to a cart, and check out. Payment is
**manual and off-site**: no bank details are shown on the site; placing an order
automatically opens an email to the store owner with the buyer's details and a
request for payment instructions, and the order sits as "Pending Payment" until the
owner confirms it.

There is no traditional server or database. **A Google Sheet is the CRM/database**,
and a **Google Apps Script Web App** bound to that Sheet acts as the backend JSON
API. The front end is plain HTML/CSS/JS — no framework, no build step — so it can be
hosted anywhere that serves static files (e.g. GitHub Pages).

```
Static front end (HTML/CSS/JS)  <-- fetch -->  Apps Script Web App  <-->  Google Sheet + Drive
```

### Constraints that shape everything else

- **No build step, no framework, no npm dependencies.** Every page is plain HTML
  with `<script>` tags; every script is a plain `.js` file loaded directly by the
  browser. This is a deliberate, self-contained/offline-friendly design choice, not
  an oversight — there is nothing to `npm install` and nothing to compile.
- **Sheets-as-database.** All persistent data lives in one Google Sheet. Every tab's
  row 1 is a header row that the backend maps by name (see
  [`Db.gs`](#db-gs)) — no file anywhere hardcodes a column index, so adding a column
  never requires a code change elsewhere.
- **The `{ok:true/false}` envelope.** Apps Script Web Apps always return HTTP 200
  regardless of outcome, so every backend response carries an explicit `ok` field
  and the frontend branches on that field, never on HTTP status.
- **CORS avoidance via `text/plain`.** Apps Script Web Apps handle simple GET/POST
  requests but cannot handle a CORS preflight (`OPTIONS`) request. Every POST body
  is sent as `text/plain` — a CORS-safelisted content type — specifically to avoid
  triggering a preflight. Auth tokens travel inside the JSON body, never as an
  `Authorization` header, for the same reason.
- **No customer accounts.** Customers are always anonymous. Their only "identity" is
  per-browser `localStorage` (cart, dedup sets for view/visit tracking, a saved
  checkout profile).

---

## 2. Folder structure

```
/                       Customer-facing HTML pages, repo root
  index.html              Home page: search box, category buttons, trending carousels
  stores.html             Full store directory (browse all active stores)
  store.html              One store's product catalog (?store=slug)
  search.html             Cross-store product search / category results (?q= / ?category=)
  cart.html               Shopping cart for the customer's active store
  checkout.html           Customer details, places the order, auto-emails the store owner

/owner/                 Store-owner (vendor) dashboard pages
  login.html               Login (+ 2FA challenge) and registration
  forgot-password.html     Email-code password reset
  dashboard.html            Store owner summary (product/order metrics)
  products.html              Product + variant management, phone photo upload
  orders.html                 Order list and status updates
  settings.html                Store profile, delivery methods, location, logo, password, 2FA, store status

/assets/js/             Frontend JavaScript (20 files, no ES modules - see Section 3)
/assets/css/            styles.css (customer-facing) + owner.css (dashboard)
/assets/img/            Logo, favicon, and app-icon assets

/apps-script/           Google Apps Script backend source, version-controlled here but
                         deployed by pasting into the Apps Script editor (see Section 4)
  Code.gs                  doGet/doPost router
  Db.gs                     Generic header-mapped Sheet access
  Utils.gs                  Shared helpers, response envelope, caching layer
  Auth.gs                   Registration, login, sessions, 2FA, password reset
  Products.gs                Store directory, product/variant CRUD, owner profile
  Bookings.gs                  Booking-listing requests + confirm/decline lifecycle
  Orders.gs                   Order creation and management, delivery eligibility
  Images.gs                    Product photo / store logo upload to Drive
  Reminders.gs                  Abandoned-cart and no-email-order reminder sweeps

/docs/                  This document
README.md               Schema, deployment steps, and documented feature/behavior nuances
```

No `src/`, no build output, no `package.json` — the repository *is* the deployable
static site as-is; only `apps-script/*.gs` requires a manual step (pasting into the
Apps Script editor) to go live.

---

## 3. Frontend architecture

Static HTML/CSS/JS. 13 HTML pages: 6 customer-facing at the repo root, 7 vendor-facing
under `owner/`.

### Script loading model

There are no ES modules. Everything communicates through global scope, so the
`<script>` tag order in each HTML file *is* the dependency graph — nothing enforces
it beyond convention. Every page loads the same four scripts first, in this fixed
order, before its own page-specific scripts:

```
config.js  ->  api.js  ->  helpers.js  ->  cookie-consent.js  ->  (page-specific scripts)
```

- **`config.js`** — the one file every deployment edits: `APP_CONFIG.APPS_SCRIPT_URL`,
  currency symbol, site name.
- **`api.js`** — the `Api` object, the sole transport to the backend (`Api.get`,
  `Api.post`). See Section 5.
- **`helpers.js`** — shared formatting/escaping/rendering utilities used by nearly
  every page: `formatMoney`, `escapeHtml`, fuzzy word-matching
  (`levenshteinDistance`, `wordsAreEquivalent`, `namesShareEquivalentWord`,
  mirrored server-side for delivery-eligibility and product-similarity checks),
  `renderBrowseProductCard`, `renderDeliveryIcons`, `renderLogoCarouselItem`,
  `compressImage` (client-side photo downscaling before upload), `wirePasswordToggle`,
  view/visit tracking (`recordProductViewsOnce`, `recordStoreVisitOnce`).
- **`cookie-consent.js`** — self-contained consent banner, no dependencies.

### Shared "module" objects

Not real ES modules — IIFE-wrapped globals exposing a small public method surface:

| Object | File | Purpose |
|---|---|---|
| `Api` | `api.js` | `get(action, params)` / `post(action, payload)` — the only way any page talks to the backend |
| `Auth` | `auth.js` | Owner session: `saveSession`, `getToken`, `getOwner`, `clearSession`, `logout`, `guardOwnerAuth()` (redirect-if-not-logged-in guard used at the top of every owner page) |
| `Cart` | `cart.js` | Per-store-slug shopping cart in `localStorage`: `getCart`, `addItem`, `updateQty`, `removeItem`, `clearCart`, `getTotal`, `getItemCount` |

### Page controllers

Each page has exactly one controller script owning its `DOMContentLoaded` init and
all event wiring: `home.js`, `directory.js`, `store.js`, `search.js`, `cart-page.js`,
`checkout.js`, `owner-login.js`, `owner-forgot-password.js`, `owner-dashboard.js`,
`owner-products.js`, `owner-orders.js`, `owner-settings.js`, plus `owner-nav.js`
(shared logout-link wiring across every owner page) and `product-card.js`
(`renderProductCard`, the add-to-cart card used on `store.html`).

### Styling and state

Two stylesheets — `styles.css` (customer-facing, mobile-first, CSS custom properties
for design tokens) and `owner.css` (dashboard). All client persistence is
`localStorage`: per-store cart (`skiri_cart_<slug>`), owner session token + profile,
active-store slug, viewed-product/visited-store dedup sets, saved checkout profile,
cookie-consent flag.

---

## 4. Backend architecture

8 `.gs` files bound to one Google Sheet, deployed as an Apps Script Web App. Every
response is `{ok:true, ...}` or `{ok:false, error}`.

<a id="db-gs"></a>
- **`Code.gs`** — the router. `doGet(e)` handles public reads via a small `switch` on
  `params.action`. `doPost(e)` parses the JSON body, checks `action` against
  `PUBLIC_POST_ACTIONS` (no auth) or `PROTECTED_POST_ACTIONS` (calls
  `requireAuth(body.token)` first, from `Auth.gs`), then dispatches to the matching
  `action*` handler function.
- **`Db.gs`** — generic, header-mapped Sheet access used by every other file:
  `getSheet(name)`, `getHeaders(sheet)`, `sheetToObjects(sheet)` (reads all data rows
  into `{header: value}` objects plus a `__row` for later updates),
  `findRowById(sheet, idField, idValue)`, `appendRowFromObject(sheet, obj)`,
  `updateRowFromObject(sheet, rowNumber, obj)`. No file anywhere hardcodes a column
  index — the schema is whatever row 1 says it is.
- **`Utils.gs`** — response envelope (`ok`/`fail`/`jsonOut`), ID/token generation
  (`newId`, `generateOrderRef`, `generateToken`, `generate6DigitCode`), `slugify`,
  `nowIso`, `parsePostBody`, fuzzy-match helpers (`levenshteinDistance`,
  `wordsAreEquivalent` — mirrored client-side in `helpers.js`), `sendAppEmail`
  (wraps `MailApp`, swallows failures), and a `CacheService`-backed read-through
  cache (`getCached(key, ttlSeconds, producerFn)`, `invalidateCache(keys)`) used by
  the heaviest public read actions in `Products.gs`.
- **`Auth.gs`** — registration, login, optional email 2FA, session issuance/validation
  (`requireAuth`), password reset, store status (active/standby/closed).
- **`Products.gs`** — store directory, product/variant CRUD, owner profile updates,
  view/visit counters, cross-store search, and the cached public read actions
  (`listStores`, `listProducts`, `getStorePublicInfo`, `listTopProducts`,
  `listTopStores`).
- **`Bookings.gs`** — booking-listing requests (`isBookingCategory(Category)`, true for
  `rentals`/`services`) and their confirm/decline lifecycle. The no-double-booking
  guarantee lives here: `actionUpdateBookingStatus` re-checks for an overlapping
  already-`Confirmed` booking on the same listing inside a `LockService` lock before
  allowing a confirm to go through — the same lock-guarded check-then-write pattern
  `Orders.gs` uses for its own price/stock re-validation. Also owns
  `unavailableProductIdsToday()`, the today-availability lookup `Products.gs` calls
  to attach an `available` flag to booking listings in public responses.
- **`Orders.gs`** — order creation (server-recomputed pricing, `LockService`-guarded,
  authoritative delivery-eligibility re-check) and owner order management.
- **`Images.gs`** — product photo (up to 2 per product), store logo, and optional
  vendor ID/license photo upload to Drive; every endpoint here requires a valid
  owner token, or the Drive folder becomes open anonymous file hosting.
- **`Reminders.gs`** — abandoned-cart capture (`saveAbandonedCart`) and the hourly
  `runReminderSweep()` sweep. This function is **not** reachable through
  `Code.gs`'s router — it only runs if manually wired to a time-driven trigger in
  the Apps Script editor (see [README.md](../README.md#reminder-emails-one-time-manual-setup)).

### Deployment model

`apps-script/*.gs` in this repo is version control only. Getting a change live means:
edit the file here, copy it into the matching file in the Apps Script editor, then
**create a new deployment version** (Deploy → Manage deployments → Edit → New
version) — saving the script alone does not update the live `/exec` URL.

---

## 5. API documentation

All requests go through one URL: `APP_CONFIG.APPS_SCRIPT_URL` (ending in `/exec`).
GET is used for public, unauthenticated reads; every mutation and every
protected/owner action is POST. Protected actions carry a session token inside the
POST body (`body.token`), validated by `requireAuth()` before the handler runs.

### Public GET (`doGet` switch, query-string params)

| `action` | Handler | File |
|---|---|---|
| `listStores` | `actionListStores()` | Products.gs |
| `listProducts` | `actionListProducts(params)` | Products.gs |
| `getStorePublicInfo` | `actionGetStorePublicInfo(params)` | Products.gs |
| `searchProducts` | `actionSearchProducts(params)` | Products.gs |
| `listTopProducts` | `actionListTopProducts()` | Products.gs |
| `listTopStores` | `actionListTopStores()` | Products.gs |

### Public POST (`PUBLIC_POST_ACTIONS`, no token required)

| `action` | Handler | File |
|---|---|---|
| `registerOwner` | `actionRegisterOwner(body)` | Auth.gs |
| `loginOwner` | `actionLoginOwner(body)` | Auth.gs |
| `createOrder` | `actionCreateOrder(body)` | Orders.gs |
| `createBookingRequest` | `actionCreateBookingRequest(body)` | Bookings.gs |
| `verifyLoginCode` | `actionVerifyLoginCode(body)` | Auth.gs |
| `requestPasswordReset` | `actionRequestPasswordReset(body)` | Auth.gs |
| `resetPasswordWithCode` | `actionResetPasswordWithCode(body)` | Auth.gs |
| `saveAbandonedCart` | `actionSaveAbandonedCart(body)` | Reminders.gs |
| `recordProductViews` | `actionRecordProductViews(body)` | Products.gs |
| `recordStoreVisit` | `actionRecordStoreVisit(body)` | Products.gs |
| `logoutOwner` | `actionLogoutOwner(body)` | Auth.gs |

### Protected POST (`PROTECTED_POST_ACTIONS`, requires `requireAuth(body.token)`)

| `action` | Handler | File |
|---|---|---|
| `getOwnerProfile` | `actionGetOwnerProfile(owner)` | Products.gs |
| `updateOwnerProfile` | `actionUpdateOwnerProfile(owner, body)` | Products.gs |
| `listOwnerProducts` | `actionListOwnerProducts(owner)` | Products.gs |
| `createProduct` / `updateProduct` | `actionCreateOrUpdateProduct(owner, body)` | Products.gs |
| `deleteProduct` | `actionDeleteProduct(owner, body)` | Products.gs |
| `uploadProductImage` | `actionUploadProductImage(owner, body)` | Images.gs |
| `uploadStoreLogo` | `actionUploadStoreLogo(owner, body)` | Images.gs |
| `listOwnerOrders` | `actionListOwnerOrders(owner)` | Orders.gs |
| `updateOrderStatus` | `actionUpdateOrderStatus(owner, body)` | Orders.gs |
| `listOwnerBookings` | `actionListOwnerBookings(owner, body)` | Bookings.gs |
| `updateBookingStatus` | `actionUpdateBookingStatus(owner, body)` | Bookings.gs |
| `setStoreStatus` | `actionSetStoreStatus(owner, body)` | Auth.gs |
| `enable2FARequest` | `actionEnable2FARequest(owner)` | Auth.gs |
| `confirm2FASetup` | `actionConfirm2FASetup(owner, body)` | Auth.gs |
| `disable2FA` | `actionDisable2FA(owner)` | Auth.gs |

Every protected handler that touches a specific row (a product, an order, the
owner's own profile) independently re-checks that the row's `OwnerId` matches the
authenticated caller — a valid token for one store can never read or modify another
store's data by guessing an ID.

Not reachable through `Code.gs` at all: `runReminderSweep()` (time-driven trigger
only) and `pruneExpiredSessions()` (written trigger-ready, not currently wired).

---

## 6. Database structure

The Google Sheet is the entire database. Every tab's row 1 is the header row that
`Db.gs` maps by name — the lists below are current as of this document, but the
authoritative, always-current schema (including migration notes for existing
deployments) lives in
[`README.md`](../README.md#how-this-is-deployed-do-this-once).

| Tab | Columns |
|---|---|
| **Owners** | `OwnerId, StoreName, StoreSlug, Username, PasswordHash, PasswordSalt, Email, Phone, ANZ_AccountName, ANZ_AccountNumber, ANZ_Branch, Teremo_Name, Teremo_Number, PaymentNotes, Status, CreatedAt, TwoFAEnabled, DeliveryTruck, DeliveryShip, DeliveryAirCargo, DeliveryPickPay, DeliveryTruckCost, DeliveryShipCost, DeliveryAirCargoCost, Island, Village, LogoUrl, LogoFileId, Visits, IdLicenseUrl, IdLicenseFileId` |
| **Products** | `ProductId, OwnerId, StoreSlug, Name, Description, Category, ImageUrl, ImageFileId, ImageUrl2, ImageFileId2, Status, SortOrder, CreatedAt, UpdatedAt, Views` |
| **Variants** | `VariantId, ProductId, OwnerId, Label, Price, SKU, StockQty, Status` |
| **Bookings** | `BookingId, OwnerId, StoreSlug, ProductId, ProductName, VariantId, RateLabel, RatePrice, CustomerName, CustomerPhone, CustomerEmail, Island, Village, Notes, StartDate, EndDate, Status, CreatedAt, UpdatedAt` |
| **Orders** | `OrderId, OwnerId, StoreSlug, CustomerName, CustomerPhone, CustomerEmail, Island, Village, DeliveryAddress, DeliveryMethod, DeliveryCost, Notes, PaymentMethod, PaymentReference, ItemsJson, ItemsSummary, Subtotal, Total, Status, CreatedAt, UpdatedAt, NoEmailReminderSent` |
| **Sessions** | `Token, OwnerId, CreatedAt, ExpiresAt` |
| **TwoFACodes** | `Token, OwnerId, Code, Purpose, CreatedAt, ExpiresAt, Attempts` |
| **AbandonedCarts** | `Id, StoreSlug, OwnerId, Email, CartJson, CreatedAt, Reminded, ConvertedOrderId` |

Notes:
- The `ANZ_*`/`Teremo_*`/`PaymentNotes` columns on Owners are no longer read or
  written by the app (checkout no longer displays payment details) but are left in
  place harmlessly on existing deployments.
- `Products.Views` and `Owners.Visits` are running counters driving the home page's
  Trending Products / Popular Stores carousels — see Section 9.
- `Orders.ItemsJson` is an immutable snapshot of exactly what was bought and at what
  price, recomputed server-side at order time — never trust the client's submitted
  price.
- `Products.Category` being `rentals` or `services` (`isBookingCategory()` in
  `Products.gs`) splits the catalog into two demand paths — there's no separate
  listing-type field. Any other category is a `goods` listing: `Variants` +
  cart/checkout as always. A `rentals`/`services` listing (rental cars, hotels,
  tours, professional services) still uses `Variants` as its rate options, but
  customers submit a date-range request into `Bookings` instead — no cart, no
  checkout. `Bookings.ProductName`/`RateLabel`/`RatePrice` are snapshotted the same
  way `Orders.ItemsJson` is, for the same reason. Public responses for a
  `rentals`/`services` listing also carry an `available` boolean, derived from
  whether a `Confirmed` booking on that listing covers today (see
  `unavailableProductIdsToday()` in `Bookings.gs`).
- `Owners.IdLicenseUrl`/`IdLicenseFileId` hold an optional vendor ID/license photo
  (`uploadOwnerIdLicense` action, `Images.gs`). Deliberately excluded from
  `publicOwnerFields()` (`Auth.gs`) — the shared shape every public action returns —
  and instead added explicitly only on the vendor's own authenticated
  `getOwnerProfile` response, so it never reaches a customer-facing page.
- Soft deletes throughout: a product's `Status` becomes `archived` (never removed), a
  variant dropped from an edit becomes `Status: deleted`, and a store's `Status`
  moves through `active` / `standby` / `closed` — no row is ever hard-deleted by the
  application.

---

## 7. Authentication flow

Applies to store owners only — there is no customer authentication (see Section 9).

1. **Register** (`actionRegisterOwner`) — validates store name/username/password/
   email/phone, rejects duplicate username/email/phone, hashes the password
   (SHA-256 + a random salt + a server-side `PEPPER` Script Property — Apps Script
   has no bcrypt/argon2), generates a unique `StoreSlug`, writes an `Owners` row, and
   immediately issues a session token (auto-login after registering).
2. **Login** (`actionLoginOwner`) — looks up by username, hashes the submitted
   password against a real-or-dummy salt (timing-safe against username
   enumeration). If the owner has 2FA disabled, issues a session token directly. If
   enabled, emails a 6-digit code instead and returns
   `{twoFactorRequired:true, pendingToken}`.
3. **2FA** (`actionVerifyLoginCode`, `TwoFACodes` tab) — 10-minute code expiry,
   5-attempt lockout. The same `issueTwoFACode`/`consumeTwoFACode` logic is shared
   across login 2FA, 2FA setup, and password reset.
4. **Sessions** (`Sessions` tab) — `issueSession` writes a `Token`/`OwnerId`/
   `CreatedAt`/`ExpiresAt` row (`TOKEN_EXPIRY_HOURS` Script Property, default 168h /
   7 days). `requireAuth(token)`, called by `Code.gs` before any protected handler,
   checks the token exists, isn't expired, and that `ownerCanLogIn(owner)` — status
   is `active` or `standby`, not `closed`.
5. **Client-side** — `auth.js`'s `Auth` module keeps the token + owner profile in
   `localStorage`. `Auth.guardOwnerAuth()`, called at the top of every owner page's
   init, redirects to login if there's no token and re-validates against the
   backend (`getOwnerProfile`) rather than trusting a possibly-stale local copy.
6. **Password reset** (`actionRequestPasswordReset` / `actionResetPasswordWithCode`)
   — an emailed 6-digit code (not a clickable link), same `TwoFACodes` mechanism. A
   successful reset revokes all of that owner's existing sessions
   (`revokeAllSessions`).
7. **Logout** (`actionLogoutOwner`) — deletes the `Sessions` row server-side; the
   client clears `localStorage` regardless of the response.

---

## 8. Vendor workflow

Each vendor is one `Owners` row, identified internally by `OwnerId` and publicly by
`StoreSlug` (e.g. `store.html?store=slug`). Every protected action re-derives the
owner from the session token and cross-checks that the row being touched belongs to
that `OwnerId` before allowing a read or write.

1. `owner/login.html` — register or log in (see Section 7).
2. `owner/dashboard.html` — guarded landing page; shows active-product count, total
   order count, and pending-order count (computed client-side today from the full
   `listOwnerProducts`/`listOwnerOrders` responses).
3. `owner/products.html` — add/edit/archive products, manage per-product variants
   (label + price), upload up to 2 photos per product (client-compressed via
   `compressImage` before upload). Saving a product sends the **entire current
   `variants[]` array**; the backend diffs it against existing rows — a matched
   `VariantId` updates in place, an unmatched incoming one inserts, and an existing
   variant missing from the array gets soft-deleted (`Status: deleted`). Archiving a
   product sets `Status: archived` rather than removing the row.
4. `owner/orders.html` — lists this owner's orders newest-first, lets the owner
   update each order's `Status` (`Pending Payment` → `Paid` → `Fulfilled`, or
   `Cancelled`).
4b. `owner/bookings.html` — for `Rentals`/`Services`-category listings only (Section 3
   note on `isBookingCategory()`). Lists booking requests newest-first; the owner confirms or
   declines a `Pending` one, or cancels a `Confirmed` one — no other transition is
   allowed (unlike Orders' any-status-to-any-status update, this is enforced
   server-side via an explicit transition table). Confirming re-checks, inside a
   `LockService` lock, that no other `Confirmed` booking on the same listing
   overlaps these dates — see `actionUpdateBookingStatus` in `Bookings.gs`. A
   `Pending` row already conflicting with a `Confirmed` one is flagged
   (`overlapsConfirmed`) so the owner knows to decline it.
5. `owner/settings.html` — store name/contact, delivery methods (Truck/Ship/Air
   Cargo, each independently toggleable with its own price, plus Pick & Pay -
   in-person pickup, always free, no price field, eligible regardless of the
   customer's island/village since it's not a delivery route), island/village
   location, store logo, an optional ID/license photo upload (never shown to
   customers — see Section 6's `IdLicenseUrl` note), password change, 2FA
   enable/disable, and store status.

**Store status** is a 3-state soft-delete, set from Settings:
- **active** — normal, visible to customers, owner can log in.
- **standby** ("Pause Store") — hidden from customers, owner can still log in and
  reactivate at any time.
- **closed** ("Delete Store") — hidden from customers *and* the owner is signed out
  and can no longer log in. Reversible only by hand-editing the `Status` cell
  directly in the Sheet (see Section 10).

---

## 9. Customer workflow

No accounts. A customer's entire "identity" is `localStorage` on their own device.

1. **Browse** — `index.html` (search box + trending carousels) → `stores.html`
   (full directory) or `search.html` (query/category results) → `store.html?store=slug`.
2. **Cart** — per-store-slug in `localStorage` (`skiri_cart_<slug>`), so a customer
   can hold separate in-progress carts for different vendors simultaneously.
   Checkout is always exactly one vendor at a time, since each is paid separately.
3. **Checkout** (`checkout.html`) — collects name/phone/email(optional)/island/
   village/delivery method/notes. Delivery-method eligibility is computed **twice**:
   client-side (`checkout.js`, for immediate UI feedback on which radios to show)
   and again authoritatively server-side (`Orders.gs`'s
   `computeEligibleDeliveryMethods`, re-run on submit so a tampered request can't
   unlock a method the UI hid). Pricing is always recomputed server-side from live
   `Variants` rows — a client-submitted price is never trusted.
4. **No online payment** — placing an order (`createOrder`) auto-opens a `mailto:`
   link to the vendor with a plain-text order summary. A Copy Summary fallback
   covers browsers with no mail client configured; a separate fallback screen
   covers the case where the `createOrder` request itself fails.
5. **Abandoned carts** — if a customer types an email at checkout but never
   completes the order, `saveAbandonedCart` silently records it. The hourly
   `runReminderSweep` trigger emails a one-time "you left something in your cart"
   reminder after an hour (see Section 10 for the manual trigger setup this
   depends on).
6. **View/visit tracking** — product views and store visits are counted once per
   visitor (deduped via a `localStorage` set), batched into one POST per page load,
   and drive the home page's Trending Products / Popular Stores carousels
   (`listTopProducts` / `listTopStores`, top 20 by count).
7. **Booking listings** (`Category` is `rentals` or `services` — `isBookingCategory()`
   in `Products.gs`) skip steps 2-4 above entirely — no cart, no checkout. On
   `store.html`, such a listing renders a rate picker, a start/end date pair, an
   "Available"/"Booked today" badge (from the `available` field — see Section 6),
   and a "Request Booking" button instead of qty/Add to Cart; submitting calls
   `createBookingRequest` directly. The request is rejected up front if it overlaps a
   booking already `Confirmed` for that listing, but two customers *can* both have
   overlapping `Pending` requests — the vendor resolves that by confirming one
   (Section 8, step 4b). **No double bookings is a hard guarantee, not just a
   request-time check**: it's enforced again inside a `LockService` lock at the
   moment a `Pending` booking is confirmed, which is the only point two requests
   could otherwise race each other into both being Confirmed.

---

## 10. Admin workflow

**There is no admin panel, admin login, or admin API in this application.** The
closest equivalent — the de facto "admin" role — is whoever owns the underlying
Google Sheet and Apps Script project. That access is entirely manual and happens
outside the web app, directly in Google's own tools:

- **Direct Sheet access** — the Sheet owner can read, filter, and edit every row
  across every tab (Owners, Products, Variants, Orders, etc.) directly in Google
  Sheets. Per the security notes in `README.md`, this access should be limited to
  the Sheet's actual owner — sharing it with vendors would expose every other
  vendor's customer PII and (legacy) payment fields to each other.
- **Reversing a soft delete** — since the app never hard-deletes a row (see the
  soft-delete notes in Section 6), restoring a `closed` store, an `archived`
  product, or a `deleted` variant is a manual edit: change the cell's `Status` value
  back by hand directly in the Sheet.
- **One-time Script Properties setup** — `PEPPER` (password hashing salt-pepper,
  must never change once vendors have registered), `TOKEN_EXPIRY_HOURS` (optional,
  defaults to 168), `IMAGE_FOLDER_ID` (set automatically on first photo upload).
  Managed from the Apps Script editor's Project Settings, not from any in-app UI.
- **Wiring the reminder sweep** — `Reminders.gs`'s `runReminderSweep()` (abandoned-
  cart and no-email-order reminders, see Section 9) does nothing on its own; it only
  runs if the Sheet owner manually adds an hourly time-driven trigger in the Apps
  Script editor's Triggers page. This is a one-time setup step, documented in
  `README.md`.
- **Redeploying after a code change** — any edit to a file under `apps-script/`
  requires the Sheet owner to paste the change into the Apps Script editor and
  create a new deployment version; the previous version keeps serving traffic until
  that happens.
- **Backups** — the Sheet is the sole system of record, with no other backup layer;
  `README.md` recommends the Sheet owner periodically use File → Download as a
  manual backup.

If an in-app admin role (a dashboard for managing all vendors, moderating listings,
etc.) is ever needed, it does not exist today and would be new work — not a
rename or extension of anything currently in the codebase.
