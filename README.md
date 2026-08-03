# Simple Kiri Shop

A multi-vendor online marketplace for Kiribati shoppers. Multiple store owners each
register, log in, and manage their own products (with photos taken straight from
their phone). Customers browse a store, add product varieties to a cart, and check
out — payment is **manual and off-site**: checkout collects the buyer's details only
(no bank details are shown on the site), placing an order automatically opens an
email to the store owner with the buyer's details, the order number, and a request
for their ANZ/Teremo payment details, and the order sits as "Pending Payment" until
the store owner confirms it. Store owners still keep their ANZ/Teremo details on
file in Settings for their own reference (and for when replying to that email);
customers just never see them on the site.

There is no traditional server or database. **A Google Sheet is the CRM/database**,
and a **Google Apps Script Web App** bound to that Sheet acts as the backend JSON
API. The front end is plain HTML/CSS/JS — no framework, no build step — so it can
be hosted anywhere that serves static files (e.g. GitHub Pages).

```
Static front end (HTML/CSS/JS)  <-- fetch -->  Apps Script Web App  <-->  Google Sheet + Drive
```

## Project structure

```
index.html            Homepage: search box + shop-by-category buttons
stores.html            Full store directory (browse all stores)
search.html             Cross-store product search/category results (?q= / ?category=)
store.html               One store's product catalog (?store=slug)
cart.html                 Shopping cart for the active store
checkout.html              Customer details, places the order, auto-emails the store owner

owner/login.html         Store owner login + registration (+ 2FA code step)
owner/forgot-password.html Email-code password reset
owner/dashboard.html      Store owner summary
owner/products.html       Product + variety management, phone photo upload
owner/orders.html          Order list and status updates
owner/settings.html        Store details, delivery methods, island/village, password change, 2FA on/off

assets/js/config.js       The one line every deployment edits: APPS_SCRIPT_URL
assets/js/api.js          fetch() wrapper for the Apps Script API
assets/js/cart.js         Per-store shopping cart (localStorage)
assets/js/auth.js          Store owner session/token handling
assets/js/kiribati-locations.js  Island -> village data for Settings (see caveat below)
assets/css/styles.css      Shared, mobile-first styles
assets/css/owner.css        Store owner dashboard styles

apps-script/*.gs           Google Apps Script backend source (see setup below)
```

## How this is deployed (do this once)

The front end can't talk to a Google Sheet directly — you need to create the
Sheet and deploy the Apps Script backend under your own Google account first.

1. **Create a Google Sheet** (e.g. "Simple Kiri Shop DB"). Add these tabs, each
   with the exact header row shown (row 1). Leave every tab otherwise empty —
   the script appends rows as people use the site.

   **Owners**
   `OwnerId | StoreName | StoreSlug | Username | PasswordHash | PasswordSalt | Email | Phone | ANZ_AccountName | ANZ_AccountNumber | ANZ_Branch | Teremo_Name | Teremo_Number | PaymentNotes | Status | CreatedAt | TwoFAEnabled | DeliveryTruck | DeliveryShip | DeliveryAirCargo | Island | Village`

   (The `ANZ_*`/`Teremo_*`/`PaymentNotes` columns are no longer used by the
   app — checkout no longer displays payment details, so Settings no longer
   reads/writes them — but they're harmless to leave in place if you already
   have this sheet set up.)

   **Products**
   `ProductId | OwnerId | StoreSlug | Name | Description | Category | ImageUrl | ImageFileId | Status | SortOrder | CreatedAt | UpdatedAt`

   **Variants**
   `VariantId | ProductId | OwnerId | Label | Price | SKU | StockQty | Status`

   **Orders**
   `OrderId | OwnerId | StoreSlug | CustomerName | CustomerPhone | CustomerEmail | DeliveryAddress | Notes | PaymentMethod | PaymentReference | ItemsJson | ItemsSummary | Subtotal | Total | Status | CreatedAt | UpdatedAt`

   **Sessions**
   `Token | OwnerId | CreatedAt | ExpiresAt`

   **TwoFACodes** (one-time email codes — shared by login 2FA, 2FA setup, and password reset)
   `Token | OwnerId | Code | Purpose | CreatedAt | ExpiresAt | Attempts`

   If you already have this Sheet set up from an earlier version, just add the
   `TwoFAEnabled`, `DeliveryTruck`, `DeliveryShip`, `DeliveryAirCargo`,
   `Island`, and `Village` columns to the end of `Owners`, and add the new
   `TwoFACodes` tab — everything else stays the same.

2. **Extensions → Apps Script.** Create a `.gs` file for each file in
   `apps-script/` (`Code.gs`, `Db.gs`, `Utils.gs`, `Auth.gs`, `Products.gs`,
   `Orders.gs`, `Images.gs`) and paste in the matching source from this repo.

3. **Project Settings → Script Properties**, add:
   - `PEPPER` — a long random string (used to salt+pepper password hashes).
   - `TOKEN_EXPIRY_HOURS` — optional, defaults to `168` (7 days) if unset.

   `IMAGE_FOLDER_ID` is set automatically the first time a photo is uploaded
   (a "Simple Kiri Shop Product Images" Drive folder is created for you).

4. **Deploy → New deployment → type "Web app".**
   - Execute as: **Me**
   - Who has access: **Anyone**
   (Not "Anyone with Google account" — customers and store owners don't need a
   Google login.)

   Deploy, authorize the requested Sheets/Drive scopes, then copy the URL
   ending in `/exec`.

5. Paste that URL into `assets/js/config.js` as `APPS_SCRIPT_URL`.

6. **Sanity check before wiring up the UI** — open
   `<your exec URL>?action=listStores` directly in a browser. You should see
   `{"ok":true,"stores":[]}`.

7. Host the static files (repo root works as-is for GitHub Pages, or drag the
   folder into Netlify — no build step).

8. Visit `owner/login.html` and register the first store to seed real data.

**Whenever you edit the Apps Script code**, you must create a new deployment
version (Manage deployments → Edit → New version) — saving the script alone
does not update the live `/exec` URL.

**The first time you deploy after adding the 2FA/password-reset code**, Apps
Script will prompt you to re-authorize an additional permission (sending
email as you, via `MailApp`) — this is expected, since login codes and reset
codes are emailed from the script owner's own Google account.

## Security & operational notes

- **Password hashing** is salted SHA-256 plus a server-side pepper, since Apps
  Script has no bcrypt/argon2/scrypt. This is a pragmatic tradeoff for a small
  regional marketplace, not a bank-grade KDF.
- **The exec URL is a public, unauthenticated-by-default API.** Every
  protected action checks the caller's token *and* that the row being changed
  belongs to that token's owner — so one store owner can't read or edit
  another's products or orders by guessing an ID.
- **Order prices are always recomputed server-side** from the live `Variants`
  rows, and the order reference is generated server-side — a customer's
  browser is never trusted with pricing.
- **Sheets-as-database has limits**: Apps Script executions cap around 6
  minutes and Sheets has practical size ceilings. Fine at small scale; worth
  revisiting (e.g. archiving old orders) if the marketplace grows a lot.
- **Only the Sheet's owner should have direct spreadsheet access.** Store
  owners should only interact through the dashboard — sharing the raw Sheet
  with multiple vendors would expose every other vendor's customers and
  payment details.
- **Back up the Sheet periodically** (File → Download) — it's the sole system
  of record, with no other backup layer.
- Product photo uploads are capped at 4MB and compressed client-side before
  upload; the upload endpoint requires a valid store-owner token so it can't
  be used as open anonymous file hosting.
- **2FA is an emailed 6-digit code**, not an authenticator app (TOTP) — simpler
  to run reliably on Apps Script, but it means login security is only as
  strong as the owner's email account, and depends on `MailApp` actually
  delivering. Codes expire after 10 minutes and lock out after 5 wrong
  attempts. It's opt-in per store owner (toggle in Settings), and requires a
  contact email on file.
- **Password reset** works the same way (an emailed 6-digit code, not a
  clickable link), and resetting a password revokes all of that owner's
  existing login sessions.
- **Email sending quota**: `MailApp` on a free/consumer Google account is
  capped around 100 emails/day. Fine at small scale (login codes + resets);
  worth knowing if the marketplace grows a lot of daily 2FA logins.
- **Island/village data is an unverified first draft.** `assets/js/kiribati-locations.js`
  (`KIRIBATI_ISLANDS`) is a best-effort list, not confirmed against an
  authoritative source — please review and correct village names per island
  before relying on it. It's a single plain object, safe to hand-edit; every
  island always gets an "Other (please specify)" option in the Settings
  dropdown regardless of what's in this file, so a vendor is never blocked
  by a missing or wrong entry while you fix it.
