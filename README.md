# Mwakete

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

1. **Create a Google Sheet** (e.g. "Mwakete DB"). Add these tabs, each
   with the exact header row shown (row 1). Leave every tab otherwise empty —
   the script appends rows as people use the site.

   **Owners**
   `OwnerId | StoreName | StoreSlug | Username | PasswordHash | PasswordSalt | Email | Phone | ANZ_AccountName | ANZ_AccountNumber | ANZ_Branch | Teremo_Name | Teremo_Number | PaymentNotes | Status | CreatedAt | TwoFAEnabled | DeliveryTruck | DeliveryShip | DeliveryAirCargo | DeliveryTruckCost | DeliveryShipCost | DeliveryAirCargoCost | Island | Village | LogoUrl | LogoFileId`

   (The `ANZ_*`/`Teremo_*`/`PaymentNotes` columns are no longer used by the
   app — checkout no longer displays payment details, so Settings no longer
   reads/writes them — but they're harmless to leave in place if you already
   have this sheet set up. `DeliveryTruckCost`/`DeliveryShipCost`/
   `DeliveryAirCargoCost` are per-method delivery prices — blank means "not
   set", `0` means free delivery and shows that method's icon in green.
   `Status` is now one of `active` / `standby` / `closed` — see "Store status"
   below.)

   **Products**
   `ProductId | OwnerId | StoreSlug | Name | Description | Category | ImageUrl | ImageFileId | ImageUrl2 | ImageFileId2 | Status | SortOrder | CreatedAt | UpdatedAt`

   (`ImageUrl2`/`ImageFileId2` hold an optional second product photo — each
   product supports up to 2 photos, shown as swappable thumbnails on the
   storefront.)

   **Variants**
   `VariantId | ProductId | OwnerId | Label | Price | SKU | StockQty | Status`

   **Orders**
   `OrderId | OwnerId | StoreSlug | CustomerName | CustomerPhone | CustomerEmail | DeliveryAddress | Notes | PaymentMethod | PaymentReference | ItemsJson | ItemsSummary | Subtotal | Total | Status | CreatedAt | UpdatedAt | NoEmailReminderSent`

   (`NoEmailReminderSent` is a timestamp set the one time the "call this
   customer" reminder email goes out to the store owner — see "Reminder
   emails" below. Leave it blank; the script manages it.)

   **Sessions**
   `Token | OwnerId | CreatedAt | ExpiresAt`

   **TwoFACodes** (one-time email codes — shared by login 2FA, 2FA setup, and password reset)
   `Token | OwnerId | Code | Purpose | CreatedAt | ExpiresAt | Attempts`

   **AbandonedCarts** (customers who typed an email at checkout but never placed the order)
   `Id | StoreSlug | OwnerId | Email | CartJson | CreatedAt | Reminded | ConvertedOrderId`

   If you already have this Sheet set up from an earlier version, just add the
   `TwoFAEnabled`, `DeliveryTruck`, `DeliveryShip`, `DeliveryAirCargo`,
   `DeliveryTruckCost`, `DeliveryShipCost`, `DeliveryAirCargoCost`, `Island`,
   `Village`, `LogoUrl`, and `LogoFileId` columns to the end of `Owners`, add
   `ImageUrl2` and `ImageFileId2` to the end of `Products`, add
   `NoEmailReminderSent` to the end of `Orders`, and add the new
   `TwoFACodes` and `AbandonedCarts` tabs — everything else stays the same.

2. **Extensions → Apps Script.** Create a `.gs` file for each file in
   `apps-script/` (`Code.gs`, `Db.gs`, `Utils.gs`, `Auth.gs`, `Products.gs`,
   `Orders.gs`, `Images.gs`, `Reminders.gs`) and paste in the matching source
   from this repo.

3. **Project Settings → Script Properties**, add:
   - `PEPPER` — a long random string (used to salt+pepper password hashes).
   - `TOKEN_EXPIRY_HOURS` — optional, defaults to `168` (7 days) if unset.

   `IMAGE_FOLDER_ID` is set automatically the first time a photo is uploaded
   (a "Mwakete Product Images" Drive folder is created for you).

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

## Reminder emails (one-time manual setup)

Two follow-up emails need a scheduled sweep, and Apps Script has no cron —
you wire this up once by hand:

1. In the Apps Script editor, open the **Triggers** page (clock icon on the
   left sidebar).
2. **Add Trigger** → function `runReminderSweep` → event source
   **Time-driven** → **Hour timer** → every hour → Save.

That's it — from then on, once an hour the script checks for:
- **Abandoned carts**: a customer typed an email at checkout but never
  placed the order, and it's been over an hour — they get a "you left
  something in your cart" email.
- **No-email orders**: an order came in with no customer email on file and
  is still Pending Payment after an hour — the **store owner** gets an
  email reminding them to call/WhatsApp the customer's phone directly,
  since there's no way to auto-reach them.

Each reminder only ever fires once per cart/order (tracked via `Reminded` in
`AbandonedCarts` and `NoEmailReminderSent` in `Orders`).

## Store status (Settings → Store Status)

A store owner can pause or delete their store from Settings:
- **Active** — normal, visible in the directory/search, owner can log in.
- **Standby** (Pause Store) — hidden from customers, but the owner can still
  log in and switch it back to Active at any time.
- **Closed** (Delete Store) — hidden from customers *and* the owner is
  signed out and can no longer log in. This is a soft delete: no Sheet rows
  are ever erased, so it's reversible by editing the `Status` cell back to
  `active` directly in the Owners sheet if a store owner needs it restored.

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
- Product photo (up to 2 per product) and store logo uploads are capped at
  5MB and compressed client-side before upload; both endpoints require a
  valid store-owner token so they can't be used as open anonymous file
  hosting.
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
