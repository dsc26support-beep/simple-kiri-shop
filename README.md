# Simple Kiri Shop

A multi-vendor online marketplace for Kiribati shoppers. Multiple store owners each
register, log in, and manage their own products (with photos taken straight from
their phone). Customers browse a store, add product varieties to a cart, and check
out — payment is **manual**: each store's own **ANZ** bank transfer and **Teremo**
details are shown at checkout, the customer pays outside the site, and the order
sits as "Pending Payment" until the store owner confirms it.

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
checkout.html              Customer details, ANZ/Teremo instructions, places the order

owner/login.html         Store owner login + registration
owner/dashboard.html      Store owner summary
owner/products.html       Product + variety management, phone photo upload
owner/orders.html          Order list and status updates
owner/settings.html        Store details, payment info, password change

assets/js/config.js       The one line every deployment edits: APPS_SCRIPT_URL
assets/js/api.js          fetch() wrapper for the Apps Script API
assets/js/cart.js         Per-store shopping cart (localStorage)
assets/js/auth.js          Store owner session/token handling
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
   `OwnerId | StoreName | StoreSlug | Username | PasswordHash | PasswordSalt | Email | Phone | ANZ_AccountName | ANZ_AccountNumber | ANZ_Branch | Teremo_Name | Teremo_Number | PaymentNotes | Status | CreatedAt`

   **Products**
   `ProductId | OwnerId | StoreSlug | Name | Description | Category | ImageUrl | ImageFileId | Status | SortOrder | CreatedAt | UpdatedAt`

   **Variants**
   `VariantId | ProductId | OwnerId | Label | Price | SKU | StockQty | Status`

   **Orders**
   `OrderId | OwnerId | StoreSlug | CustomerName | CustomerPhone | CustomerEmail | DeliveryAddress | Notes | PaymentMethod | PaymentReference | ItemsJson | ItemsSummary | Subtotal | Total | Status | CreatedAt | UpdatedAt`

   **Sessions**
   `Token | OwnerId | CreatedAt | ExpiresAt`

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
