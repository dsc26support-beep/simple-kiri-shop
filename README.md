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
owner/messages.html        Vendor chat inbox - conversation list, search, reply, archive/delete
owner/settings.html        Store details, delivery methods, island/village, password change, 2FA on/off

assets/js/config.js       The one line every deployment edits: APPS_SCRIPT_URL
assets/js/api.js          fetch() wrapper for the Apps Script API
assets/js/cart.js         Per-store shopping cart (localStorage)
assets/js/auth.js          Store owner session/token handling
assets/js/kiribati-locations.js  Island -> village data for Settings (see caveat below)
assets/css/styles.css      Shared, mobile-first styles
assets/css/owner.css        Store owner dashboard styles

manifest.json              Web app manifest - makes the site installable as an app (PWA)
sw.js                      Service worker - offline shell + fast repeat loads
offline.html               Shown only when a page is opened with no connection
assets/js/register-sw.js   Registers sw.js (loaded on every page)

apps-script/*.gs           Google Apps Script backend source (see setup below)
```

## How this is deployed (do this once)

The front end can't talk to a Google Sheet directly — you need to create the
Sheet and deploy the Apps Script backend under your own Google account first.

1. **Create a Google Sheet** (e.g. "Mwakete DB"). Add these tabs, each
   with the exact header row shown (row 1). Leave every tab otherwise empty —
   the script appends rows as people use the site.

   **Owners**
   `OwnerId | StoreName | StoreSlug | Username | PasswordHash | PasswordSalt | Email | Phone | Messenger | ANZ_AccountName | ANZ_AccountNumber | ANZ_Branch | Teremo_Name | Teremo_Number | PaymentNotes | Status | CreatedAt | TwoFAEnabled | DeliveryTruck | DeliveryShip | DeliveryAirCargo | DeliveryPickPay | DeliveryTruckCost | DeliveryShipCost | DeliveryAirCargoCost | Island | Village | LogoUrl | LogoFileId | Visits | IdLicenseUrl | IdLicenseFileId`

   (The `ANZ_*`/`Teremo_*`/`PaymentNotes` columns are no longer used by the
   app — checkout no longer displays payment details, so Settings no longer
   reads/writes them — but they're harmless to leave in place if you already
   have this sheet set up. `Messenger` is an optional Facebook Messenger
   username/handle or full profile link, settable at registration or later
   in Settings — a bare handle is normalized into `https://m.me/<handle>`
   at render time, a pasted full URL is used as-is. It's blank by default,
   and only shown to a customer once they submit a booking request, next to
   a "Call Now" button built from `Phone` — see "Booking listings" below.
   `DeliveryTruckCost`/`DeliveryShipCost`/
   `DeliveryAirCargoCost` are per-method delivery prices — blank means "not
   set", `0` means free delivery and shows that method's icon in green.
   `DeliveryPickPay` (in-person pickup, pay at the store) has no matching
   cost column — it's always free, always shown with a green walking-person
   icon, and unlike the other three methods it doesn't check the customer's
   island/village at all — see "Delivery method eligibility" below.
   `Status` is now one of `active` / `standby` / `closed` — see "Store status"
   below. `Visits` is a running count of unique visitors who've opened that
   store's page — see "View/visit tracking" below. Leave it blank; the
   script manages it. `IdLicenseUrl`/`IdLicenseFileId` hold an optional
   vendor ID/license photo — see "Booking listings" below for how it's
   uploaded and why it's kept out of every public response.)

   **Products**
   `ProductId | OwnerId | StoreSlug | Name | Description | Category | ImageUrl | ImageFileId | ImageUrl2 | ImageFileId2 | Status | SortOrder | CreatedAt | UpdatedAt | Views`

   (`ImageUrl2`/`ImageFileId2` hold an optional second product photo — each
   product supports up to 2 photos, shown as a swipeable carousel on the
   storefront. `Views` is a running count of unique visitors who've seen
   that product's card anywhere on the site — see "View/visit tracking"
   below. Leave it blank; the script manages it. `Category` being `rentals`
   or `services` is what makes a listing a booking listing — see "Booking
   listings" below. There is no separate listing-type field; any other
   category value is a regular add-to-cart/checkout `goods` listing.)

   **Variants**
   `VariantId | ProductId | OwnerId | Label | Price | SKU | StockQty | Status`

   (For a booking listing — `Category` is `rentals` or `services` — each
   variant is a rate rather than a size/pack — e.g. `Per Night` / `Per Day` /
   `Per Trip`.)

   **Bookings** (date-range requests against a `rentals`/`services`-category
   Product — see "Booking listings" below)
   `BookingId | OwnerId | StoreSlug | ProductId | ProductName | VariantId | RateLabel | RatePrice | CustomerName | CustomerPhone | CustomerEmail | Island | Village | Notes | StartDate | EndDate | Status | CreatedAt | UpdatedAt`

   (`ProductName`/`RateLabel`/`RatePrice` are snapshotted at request time, so
   a booking keeps showing what the customer actually saw even if the
   listing is edited later. `Status` is one of `Pending` / `Confirmed` /
   `Declined` / `Cancelled`.)

   **Orders**
   `OrderId | OwnerId | StoreSlug | CustomerName | CustomerPhone | CustomerEmail | Island | Village | DeliveryAddress | DeliveryMethod | DeliveryCost | Notes | PaymentMethod | PaymentReference | ItemsJson | ItemsSummary | Subtotal | Total | Status | CreatedAt | UpdatedAt | NoEmailReminderSent`

   (`NoEmailReminderSent` is a timestamp set the one time the "call this
   customer" reminder email goes out to the store owner — see "Reminder
   emails" below. Leave it blank; the script manages it. `Island`/`Village`
   are the customer's selected delivery location; `DeliveryAddress` is just
   `Village, Island` for a human-readable single line. `DeliveryMethod` is
   `truck`/`ship`/`airCargo`, and `DeliveryCost` is what that method cost at
   order time — `Total` already includes it, `Subtotal` doesn't. See
   "Delivery method eligibility" below for how the available choices are
   worked out.)

   **Sessions**
   `Token | OwnerId | CreatedAt | ExpiresAt`

   **TwoFACodes** (one-time email codes — shared by login 2FA, 2FA setup, and password reset)
   `Token | OwnerId | Code | Purpose | CreatedAt | ExpiresAt | Attempts`

   **AbandonedCarts** (customers who typed an email at checkout but never placed the order)
   `Id | StoreSlug | OwnerId | Email | CartJson | CreatedAt | Reminded | ConvertedOrderId`

   **Conversations** and **Messages** (vendor-specific live chat — see
   `docs/vendor-chat-design.md` for the full design)
   `ConversationId | OwnerId | StoreSlug | CustomerToken | CustomerName | Status | CreatedAt | UpdatedAt | LastMessageAt | LastMessagePreview | LastSenderType | UnreadByVendor | UnreadByCustomer`
   `MessageId | ConversationId | OwnerId | StoreSlug | SenderType | Body | CreatedAt | ImageUrl | ImageFileId`

   If you already have this Sheet set up from an earlier version, just add the
   `TwoFAEnabled`, `DeliveryTruck`, `DeliveryShip`, `DeliveryAirCargo`,
   `DeliveryPickPay`, `DeliveryTruckCost`, `DeliveryShipCost`,
   `DeliveryAirCargoCost`, `Island`,
   `Village`, `LogoUrl`, `LogoFileId`, `Visits`, `IdLicenseUrl`,
   `IdLicenseFileId`, and `Messenger` columns to the end of `Owners`, add `ImageUrl2`,
   `ImageFileId2`, and `Views` to the end of `Products`, add `Island`,
   `Village`, `DeliveryMethod`, `DeliveryCost`, and `NoEmailReminderSent` to
   the end of `Orders`, add `ImageUrl` and `ImageFileId` to the end of
   `Messages` (photo attachments in chat), add the new `Bookings` tab (see
   its column list above), and add the new `TwoFACodes`, `AbandonedCarts`,
   `Conversations`, and `Messages` tabs — everything else stays the same.

   (If your `Products` tab still has a `ListingType` column from an earlier
   version of this feature, it's no longer read or written — you can leave
   it in place harmlessly or delete it. Booking-ness is now driven entirely
   by `Category` being `rentals` or `services` — see "Booking listings"
   below.)

2. **Extensions → Apps Script.** Create a `.gs` file for each file in
   `apps-script/` (`Code.gs`, `Db.gs`, `Utils.gs`, `Auth.gs`, `Products.gs`,
   `Bookings.gs`, `Orders.gs`, `Images.gs`, `Reminders.gs`, `Chat.gs`) and
   paste in the matching source from this repo. (`Chat.gs` is data-layer
   helpers only — see the Conversations/Messages note above — safe to
   include now even though nothing calls it yet.)

3. **Project Settings → Script Properties**, add:
   - `PEPPER` — a long random string (used to salt+pepper password hashes).
   - `TOKEN_EXPIRY_HOURS` — optional, defaults to `168` (7 days) if unset.
   - `MAX_CHAT_IMAGE_BYTES` — optional, caps how large a decoded chat photo
     can be. Defaults to `5242880` (5MB, the same ceiling as product photos)
     if unset — set this property to change the limit without editing code
     or redeploying.
   - `SITE_BASE_URL` — optional, e.g. `https://mwakete.com` (or
     `https://you.github.io/simple-kiri-shop` if you haven't set up a custom
     domain — no trailing slash needed either way). When set, the new-message
     notification email (see below) includes an "Open Messages" button
     linking straight to `owner/messages.html` on your live site. Leave it
     unset and the email still sends, just without the button — nothing
     breaks, there's just no link to click.

   `IMAGE_FOLDER_ID` (product/logo photos), `CHAT_IMAGE_FOLDER_ID` (chat
   photos), and `ID_LICENSE_FOLDER_ID` (vendor ID/license uploads — see
   "Booking listings" below) each get their own Drive folder, set automatically the
   first time a photo is uploaded through each path.

   **Chat: typing indicator and new-message email notifications.** Both
   sides now see a "•••" typing indicator while the other is composing a
   reply (a short-lived `CacheService` flag, refreshed every couple of
   seconds while actively typing — nothing is written to the Sheet). When a
   customer sends a message, the store's owner also gets an email
   ("New message from ... — <Store>") so they notice even with the
   dashboard closed — on a phone with that address in its mail app, this
   generally shows up as a push notification, which is the closest thing to
   real push messaging this app can offer without a dedicated mobile app or
   a paid push service. Throttled to at most one email per conversation
   every 10 minutes, so a burst of messages doesn't flood the vendor's
   inbox. Uses the same `sendAppEmail` (Resend-or-MailApp) path as every
   other email this app sends — no separate setup needed. If `SITE_BASE_URL`
   is set (see above), the email also includes a clickable "Open Messages"
   button that jumps straight to the dashboard's Messages page — otherwise
   it's a plain-text email describing where to go, same as before this
   button existed.

   **Optional — Cloudinary image hosting instead of Drive.** By default,
   product photos, store logos, and chat photos are all hosted on Google
   Drive (via the folders above) and hotlinked through a CDN-style URL. This
   works, but Drive isn't a real CDN — no availability guarantee under heavy
   traffic, no image resizing. If you'd rather host images on
   [Cloudinary](https://cloudinary.com) (they have a free tier), add all
   three of:
   - `CLOUDINARY_CLOUD_NAME` — your Cloudinary account's cloud name.
   - `CLOUDINARY_API_KEY` — from your Cloudinary dashboard's API Keys page.
   - `CLOUDINARY_API_SECRET` — same page. Treat this like a password — it's
     what lets the script sign upload/delete requests.

   All three must be set for Cloudinary to activate — with any one missing,
   every upload silently falls back to the Drive path above, exactly as if
   Cloudinary were never configured. You don't need to create an upload
   preset or configure anything else on Cloudinary's side; the script signs
   every request itself, so no "unsigned upload" setup is required.

   **Optional — Resend for transactional email instead of MailApp.** By
   default, every email this app sends (2FA codes, password reset codes,
   reminder-sweep emails) goes out via `MailApp`, using the script owner's
   own Google account — simple, zero setup, but capped around 100 emails/day
   on a free/consumer account (see the Security & operational notes below).
   If you'd rather send through [Resend](https://resend.com) (they have a
   free tier with a much higher daily cap), add both of:
   - `RESEND_API_KEY` — from your Resend dashboard's API Keys page.
   - `RESEND_FROM_EMAIL` — the sender address to send as, e.g.
     `Mwakete <noreply@yourdomain.com>`. Resend requires this to be on a
     domain you've verified with them first (unlike MailApp, it can't just
     default to your Gmail address).

   Both must be set together — with either missing, email keeps going via
   MailApp exactly as before. Even once configured, a failed Resend send
   (network error, unverified domain, etc.) automatically falls back to
   MailApp for that one email rather than losing it.

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

### Custom domain (mwakete.com)

The repo ships a `CNAME` file (`mwakete.com`) so GitHub Pages serves the site
from that domain instead of `…github.io/simple-kiri-shop`. All paths in the app
are relative, so nothing else in the code changes when the domain moves to the
root. To finish hooking it up:

> **Order matters:** set the DNS records *before* the custom domain goes live
> on GitHub, otherwise the old `…github.io` URL redirects to `mwakete.com` and
> the site is unreachable until DNS resolves.

`mwakete.com` was registered via Google Domains, which is now **Squarespace** —
so its DNS is managed in the Squarespace dashboard. Keep the domain there (no
transfer needed); you only edit DNS records. *(If you ever moved the domain's
nameservers away from Squarespace, edit DNS wherever the nameservers point
instead.)*

**A. Point DNS at GitHub Pages (in Squarespace)**

1. Sign in at **account.squarespace.com** → **Domains** → **mwakete.com** →
   **DNS** (DNS Settings).
2. **Remove anything pointing the root at Squarespace:** delete any existing
   **A record with host `@`**, and turn off any **Domain Forwarding / redirect**.
   Leave unrelated records (e.g. Google `MX`/email) alone.
3. Under **Custom Records**, add these four **A** records (host `@`), one per IP:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
   *(Optionally also four **AAAA** records, host `@`, to `2606:50c0:8000::153`,
   `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.)* These are
   GitHub's published Pages IPs — confirm against GitHub's docs if in doubt.
4. Add one **CNAME** record: host `www`, value `dsc26support-beep.github.io`
   (add a trailing dot if Squarespace requires one). Save.

**B. Point GitHub at the domain**

5. Repo → **Settings → Pages → Custom domain** = `mwakete.com` → Save, then wait
   for the green **DNS check** (DNS can take minutes–hours to propagate).
6. Tick **Enforce HTTPS** once the certificate is issued (can take up to ~24h).

**C. Update the app's email links**

7. **Apps Script** → Project Settings → Script Properties: set
   `SITE_BASE_URL = https://mwakete.com` so notification emails link to the new
   domain (no code redeploy needed).

**Troubleshooting:** if `mwakete.com` still shows a Squarespace/parking page, a
leftover `@` A record or Domain Forwarding is still set (step 2). If GitHub's DNS
check won't go green, the only `@` A records must be the four GitHub IPs above,
with no typos.

### Redeploying after a code change

Apps Script serves a **frozen snapshot of the last saved files**, so an editor
that looks up to date tells you nothing about what the live URL is running. Do
these three steps in order, every time:

1. **Save first.** Press **Ctrl+S** and wait for the save to finish. Deploying
   with unsaved edits publishes the *old* code. To confirm what is actually
   saved, open the **function dropdown** next to Run/Debug — it lists functions
   from the saved, parsed project, so a newly added function appearing there
   proves the save landed.
2. **Manage deployments → Edit (✏️) → Version: "New version" → Deploy.** This
   keeps the same `/exec` URL. Do **not** use "New deployment" — that mints a
   *different* URL, which the site never calls, so the live site keeps running
   the old code.
3. **Verify with the health probe.** Open the live URL with `?action=getVersion`:

   ```
   https://script.google.com/macros/s/…/exec?action=getVersion
   ```

   It must echo the current `APP_VERSION` from `apps-script/Code.gs`, e.g.
   `{"ok":true,"version":"phase6-2026-09-02"}`. Anything else — an old version
   string, or `Unknown action: getVersion` — means the deployment is stale and
   step 1 or 2 did not take. This action uses no auth and touches no Sheets, so
   it answers even on a half-configured project.

Bump `APP_VERSION` in `apps-script/Code.gs` whenever you change the
`apps-script/` files, so the probe stays meaningful.

### Checking the Sheet setup

The row helpers in `Db.gs` address columns purely by **header name**, and they do
it silently: writing a field whose header is missing simply drops it, and reading
it back gives `undefined`. So one mistyped header does not raise an error — it
resurfaces later as something misleading (a mistyped `Purpose` in `CustomerCodes`
makes a valid, fresh signup code report *"This code is invalid or has expired"*).

To check all of that at once, open the live URL with `?action=checkSetup`:

```
https://script.google.com/macros/s/…/exec?action=checkSetup
```

It reports, for `Customers`, `CustomerSessions`, `CustomerCodes` and `Featured`:
whether the tab exists, which required headers are **missing**, which have **stray
spaces**, and which are **unexpected**. It also flags any `.gs` file that exists but
is **empty** (a common paste mistake — the file shows in the editor, but its
functions are undefined) and whether `ADMIN_EMAILS` is set. `setupOk: true` with an
empty `problems` array means everything is wired correctly.

The action needs no auth and returns only tab names, header names and booleans —
never row contents, and never the `ADMIN_EMAILS` value.

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

## Order archiving (optional, one-time manual setup)

The `Orders` sheet only ever grows, and every read of it (the reminder
sweep above, the vendor dashboard's order list, updating an order's status)
scans the whole tab — Sheets has no server-side filtering. If your
marketplace runs long enough to build up a lot of order history, you can
opt into archiving:

1. Add a new sheet tab named exactly `OrdersArchive`.
2. Copy the header row (row 1) from the `Orders` tab into it, unchanged —
   same column names, any order. The columns don't need to match exactly
   (extra columns are fine), but every column `Orders` has must also be
   present here, or archiving skips itself rather than write incomplete
   rows.

That's the whole setup — no separate trigger, it rides the same hourly
`runReminderSweep` trigger from the section above. Once `OrdersArchive`
exists with matching headers, any order older than **~12 months** (any
status) gets moved into it and removed from the live `Orders` tab on the
next sweep. An archived order:
- Disappears from the vendor's Orders dashboard — this is intentional, not
  a bug, and there's no in-app way to view archived orders.
- Is fully preserved in `OrdersArchive`, recoverable at any time via direct
  spreadsheet access (the same "Sheet owner is the de facto admin" lever
  this app already relies on for anything not exposed in-app).

Until you create `OrdersArchive`, nothing changes — this is entirely
opt-in, and a deployment that never adds the tab behaves exactly as before.

Abandoned carts older than ~12 months are deleted outright by the same
sweep (no archive tab, no opt-in) — nothing in this app ever displays
historical abandoned-cart data to anyone, so there's nothing to preserve.

## Booking listings (rental cars, hotels, tours, services, etc.)

Alongside regular `goods` products (add to cart, checkout), a vendor can
create a booking listing simply by picking **Category → Rentals** or
**Category → Services** when adding/editing a product — there is no
separate "Listing Type" field; the category itself determines the
behavior. A booking listing skips cart/checkout entirely:

1. The customer picks a rate (a Variant, e.g. "Per Night"), a start/end date,
   and submits a booking request directly from the store page.
2. The request lands in `Bookings` as `Pending` — no email/payment is
   collected or processed automatically, same as everywhere else in this
   app.
3. The vendor sees it on the new **Bookings** page (owner dashboard nav) and
   manually **Confirms** or **Declines** it. Once Confirmed, it can later be
   **Cancelled**. No other status changes are allowed (e.g. a Declined
   booking can't be re-confirmed — the customer would need to submit a new
   request).

**No double bookings, guaranteed.** Two Confirmed bookings can never have
overlapping dates on the same listing. This isn't just a check when the
customer submits a request (multiple customers *can* have overlapping
Pending requests — the vendor picks one) — it's enforced again, inside a
`LockService` lock, at the moment the vendor clicks Confirm
(`actionUpdateBookingStatus` in `apps-script/Bookings.gs`), which re-reads
the live `Bookings` sheet and rejects the confirmation if another booking on
the same listing was just confirmed for an overlapping range. If a Pending
request already conflicts with a Confirmed one, the owner's Bookings page
flags it so the vendor knows to decline it instead.

**Today's availability status.** Every `Rentals`/`Services` listing shown to
customers (store page, search results) carries an `available` flag — an
"Available" or "Booked today" badge next to the listing name — worked out
from whether any `Confirmed` booking on that listing covers today's date
(`unavailableProductIdsToday` in `apps-script/Bookings.gs`). This is a
same-day convenience indicator only; it doesn't stop a customer requesting a
future date range, and the real guarantee against overlapping confirmations
is the lock-guarded check above, not this badge. If a store never created
the optional `Bookings` tab, every booking listing simply shows as
available rather than the page failing to load.

Booking listings are excluded from the home page "Trending Products"
carousel and store pages' "Similar Products" row, since both assume an
add-to-cart affordance a booking listing doesn't have.

**Optional vendor ID/License upload.** In Settings, a vendor can optionally
upload a photo of an ID or business license (`uploadOwnerIdLicense` action,
`apps-script/Images.gs`, mirroring the existing store-logo upload). It's
stored in its own Drive folder (`ID_LICENSE_FOLDER_ID` Script Property,
created automatically on first upload, or the `id-license` Cloudinary
subfolder if Cloudinary is configured) and in the `IdLicenseUrl`/
`IdLicenseFileId` `Owners` columns. This field is deliberately kept out of
`publicOwnerFields` (`apps-script/Auth.gs`) — the single shape every public
action uses — so it's added explicitly, only on the vendor's own
authenticated `getOwnerProfile` response, and never appears on the store
page, product listings, or anywhere a customer can see. That said, this app
has no authenticated-file-serving mechanism anywhere — the Drive fallback
path sets `ANYONE_WITH_LINK` view access like every other photo in this app
(see `uploadImage` in `apps-script/Utils.gs`) — so anyone who somehow
obtained the exact URL could still view the document. Worth the vendor
knowing before uploading a personal ID, even though the URL is never shown
or linked anywhere but their own Settings page.

## Store status (Settings → Store Status)

A store owner can pause or delete their store from Settings:
- **Active** — normal, visible in the directory/search, owner can log in.
- **Standby** (Pause Store) — hidden from customers, but the owner can still
  log in and switch it back to Active at any time.
- **Closed** (Delete Store) — hidden from customers *and* the owner is
  signed out and can no longer log in. This is a soft delete: no Sheet rows
  are ever erased, so it's reversible by editing the `Status` cell back to
  `active` directly in the Owners sheet if a store owner needs it restored.

## Delivery method eligibility

At checkout, the customer picks their Island and Village (same picker as a
store owner's own Settings, "Other" free-text included), and only sees
delivery methods they're actually allowed to choose. Eligibility is worked
out from the **store's own Island**, re-derived server-side in `Orders.gs`
so a crafted request can't unlock a method the UI hid:

Applies in every case: only methods the store has enabled (Settings →
Delivery Methods) are ever candidates, and Ship always requires a cart
subtotal of at least $500 (before delivery cost).

- **Store is in South Tarawa:**
  - Truck: to any South Tarawa customer, or a North Tarawa customer whose
    village fuzzy-matches "Buota", "Abatao", or "Tabiteuea"
    (case-insensitive, tolerates a single typo).
  - Ship: to anyone *except* South Tarawa customers.
  - Air Cargo: to anyone except South Tarawa or North Tarawa customers.
- **Store is in North Tarawa:**
  - Truck: to North Tarawa customers, *except* the same three villages
    above (a North Tarawa vendor's truck can't reach those specific
    villages, unlike a South Tarawa vendor's).
  - Ship: to South Tarawa customers only — the one route that lets a North
    Tarawa store reach off-island at all.
  - Air Cargo: never offered by a North Tarawa store.
- **Store is anywhere else** (an outer island — not South Tarawa, not North
  Tarawa):
  - Truck: only to a customer on that exact same island.
  - Ship and Air Cargo: to South Tarawa customers only.
  - No method reaches North Tarawa or a different outer island from here.

**Pick & Pay is the one exception to all of the above.** It's in-person
pickup — the customer collects the order and pays at the store directly —
so it doesn't involve a delivery route at all. Whenever a store has it
enabled (Settings → Delivery Methods), it's eligible for **any** customer
location, with no island/village check. It's also always free (there's no
cost field for it, unlike Truck/Ship/Air Cargo) and always shows with a
green walking-person icon, since "free" is never in question for it.

If zero delivery methods end up eligible, checkout shows why and the Place
Order button stays disabled until the customer's location or cart changes.

The chosen method's cost (set per-method in the store's own Settings, $0 =
free; Pick & Pay is always $0) is added to the order's `Total` server-side —
never trust a client to report its own delivery price.

## View/visit tracking (home page "Trending Products" / "Popular Stores")

The home page shows two horizontally-scrolling rows: the 20 most-viewed
products and the 20 most-visited stores, each ranked by a running counter
(`Views` on `Products`, `Visits` on `Owners`).

- A product view is counted **once per visitor per product** — the first
  time that product's card renders anywhere it can appear (a store's own
  page, search results, "Similar Products", or the trending row itself).
  Dedup is a `localStorage` set on the visitor's device (`skiri_viewed_products`),
  same lightweight approach as the cart/active-store tracking elsewhere on
  the site — clearing site data or switching browsers resets it, and it's
  not meant to be tamper-proof, just a reasonable popularity signal at this
  scale.
- A store visit is counted the same way, once per visitor per store, the
  first time `store.html` loads for that store (`skiri_visited_stores`).
- Both counters are incremented server-side (`recordProductViews`,
  `recordStoreVisit` — public, unauthenticated actions, since there's no
  customer login) under `LockService`, same pattern as other counter/write
  operations in this codebase. Product views are batched into one request
  per page load (all newly-seen product IDs at once) rather than one
  request per product.
- `listTopProducts`/`listTopStores` are public reads returning up to 20
  active products/stores sorted by their counter, descending. Items with 0
  views/visits still appear (useful on a brand-new store with little
  traffic yet) — nothing is filtered out by count, only by `Status: active`.

## Install as an app (PWA)

The site is a **Progressive Web App**: visitors can install it to their phone's
home screen and it opens full-screen with its own icon, like a native app.
Nothing extra to deploy — the moment `manifest.json`, `sw.js`, and the icon
files are live on your GitHub Pages URL, the install prompt becomes available.

There's no separate app to build, and no store account needed. The installed
app simply loads your live site, so **anything you push to GitHub Pages shows up
in the installed app instantly** — no re-packaging, no re-submitting.

**How a customer installs it:**

- **Android (Chrome):** open the site → menu (⋮) → **Install app** (or tap the
  "Add to Home screen" banner Chrome shows on its own).
- **iPhone (Safari):** open the site → **Share** button → **Add to Home
  Screen**. (iOS only supports this from Safari, not other browsers.)

**What's in the repo for this:**

- `manifest.json` — app name, icons, colors, and `display: standalone` (the
  full-screen mode). All its paths are **relative**, so it works whether the
  site is served from a domain root or a project subpath like
  `/simple-kiri-shop/`.
- `sw.js` — the service worker. It caches the static shell (HTML/CSS/JS/icons)
  for fast repeat loads and an offline fallback, but **never caches the Google
  Apps Script backend** — orders, chat, and bookings always hit the network so
  they're never stale.
- `offline.html` — a tiny standalone page shown only when someone opens a page
  with no connection.
- The brand icons come from `assets/img/app-icon-*.png` (a 192, a 512, a
  maskable 512 for Android adaptive icons, and a 180 `apple-touch-icon` for
  iOS), all generated from `assets/img/app-icon-source.svg`. To restyle the
  app icon, edit that SVG and regenerate the PNGs.
- `theme-color` (the browser/status-bar tint) is the brand purple `#332d63`,
  set both in `manifest.json` and as a `<meta>` on every page.

**Publishing to the App Store / Google Play later (optional):**

A PWA is the foundation for real store listings when you want them. The
easiest route is [PWABuilder](https://www.pwabuilder.com/) — point it at your
live URL and it generates ready-to-submit Android (`.aab`) and iOS (Xcode)
packages that just wrap this same site. Real-world prerequisites to be aware
of before that step:

- **Google Play** — a Play Console account (one-time **$25** fee). Android
  packages can be built without a Mac.
- **Apple App Store** — an Apple Developer Program membership (**$99/year**),
  and iOS packages must be built/submitted from a **Mac with Xcode**.

None of that is set up here yet — it's noted so the option is documented when
you're ready.

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
  worth knowing if the marketplace grows a lot of daily 2FA logins. Set
  `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (see the setup steps above) to send
  through Resend instead, which has a much higher quota on its free tier.
- **Island/village data is an unverified first draft.** `assets/js/kiribati-locations.js`
  (`KIRIBATI_ISLANDS`) is a best-effort list, not confirmed against an
  authoritative source — please review and correct village names per island
  before relying on it. It's a single plain object, safe to hand-edit; every
  island always gets an "Other (please specify)" option in the Settings
  dropdown regardless of what's in this file, so a vendor is never blocked
  by a missing or wrong entry while you fix it.
