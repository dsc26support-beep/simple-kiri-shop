# Deploying Mwakete

A checklist with the links in it, so a redeploy is copy-paste rather than
remembering. The *reasoning* behind each step lives in
[README.md → Redeploying after a code change](README.md#redeploying-after-a-code-change);
this page is the short version you actually follow.

**The frontend needs nothing.** GitHub Pages publishes `main` automatically, so
merging a PR ships every HTML/CSS/JS change. Only `apps-script/*.gs` changes
need the steps below.

---

## 1. Which files changed?

Only paste the files that actually changed — pasting all thirteen is slower and
gives more chances to paste into the wrong tab.

To see them for a given change:

```
git diff --name-only <previous-tag-or-sha> main -- apps-script/
```

Raw links for every backend file (open, Ctrl+A, Ctrl+C):

| File | Raw link |
|---|---|
| `Code.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Code.gs |
| `Db.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Db.gs |
| `Utils.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Utils.gs |
| `Auth.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Auth.gs |
| `Products.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Products.gs |
| `Orders.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Orders.gs |
| `Bookings.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Bookings.gs |
| `Chat.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Chat.gs |
| `Customers.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Customers.gs |
| `Reviews.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Reviews.gs |
| `Admin.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Admin.gs |
| `Images.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Images.gs |
| `Reminders.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Reminders.gs |
| `Featuring.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Featuring.gs — **new file**: in the editor click **+ → Script**, name it `Featuring`, paste. Paid featuring's screenshot check also needs the Drive API service (**Services → Drive API → Add**, unless it's already listed) and the `documents` scope — see *Manifest* below. Without either, every payment goes to admin review. |
| `Inventory.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Inventory.gs — **new file**: **+ → Script**, name it `Inventory`, paste. Stock reservations, the stock-movement ledger and order stock changes. Adds 7 columns to `Variants` and a `StockMovements` tab on first use (owner-approved, additive). |
| `InventorySync.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/InventorySync.gs — **new file**: **+ → Script**, name it `InventorySync`, paste. Import / export, field mapping and sync history. Creates `InventoryConnections` and `SyncJobs` tabs on first use (owner-approved). |
| `InventoryLocations.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/InventoryLocations.gs — **new file**: **+ → Script**, name it `InventoryLocations`, paste. Locations, transfers, suppliers and stock reports for wholesalers and distributors. Creates `Locations`, `LocationStock`, `StockTransfers` and `Suppliers` tabs on first use (owner-approved). |
| `Marketing.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/Marketing.gs — **new file**: **+ → Script**, name it `Marketing`, paste. Marketing settings, consent, email template and admin actions. |
| `MarketingEngine.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/MarketingEngine.gs — **new file**: **+ → Script**, name it `MarketingEngine`, paste. Then run **`setupSheets`** once (creates `Campaigns`, `CampaignEvents`, `MarketingPreferences` — owner-approved, new tabs only) and add an **hourly trigger for `runMarketingSweep`**. Off until `MARKETING_ENABLED = true`; dry run until `MARKETING_DRY_RUN = false`. Full steps: [docs/marketing-engine.md](docs/marketing-engine.md#enabling-it). |
| `ListingRules.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/ListingRules.gs — **new file**: **+ → Script**, name it `ListingRules`, paste. The listing checks (name / description / category). **Every product save needs it** - `checkSetup` reports it if missing. |
| `ListingReview.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/ListingReview.gs — **new file**: **+ → Script**, name it `ListingReview`, paste. Category register, review queue, audit log. Creates `Categories`, `Product_Review_Queue`, `Audit_Log` tabs and 4 `Products` columns on first use (additive). Details: [docs/listing-review.md](docs/listing-review.md). |
| `ProductOptions.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/ProductOptions.gs — **new file**: **+ → Script**, name it `ProductOptions`, paste. Option / combination rules. **Every product save needs it.** |
| `ProductVariants.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/ProductVariants.gs — **new file**: **+ → Script**, name it `ProductVariants`, paste. Saving products with options, photos per option. Adds `ProductType`, `OptionsJson` (Products) and `OptionValuesJson`, `ImagesJson`, `CreatedAt`, `UpdatedAt` (Variants) on first use (additive). Details: [docs/product-options.md](docs/product-options.md). |
| `HeaderAds.gs` | https://raw.githubusercontent.com/dsc26support-beep/simple-kiri-shop/main/apps-script/HeaderAds.gs — **new file**: **+ → Script**, name it `HeaderAds`, paste. Homepage header adverts (admin-set). Creates a `HeaderAds` tab on first save. Details: [docs/header-adverts.md](docs/header-adverts.md). |

Browse them all: https://github.com/dsc26support-beep/simple-kiri-shop/tree/main/apps-script

**Inventory - Google Sheets linking (one-time):** in Apps Script → ⚙️ Project Settings → **Script properties**, add
`MWAKETE_SHARE_EMAIL` = the Google account this script runs as (the one sellers will share their sheets with).
Until it is set, sellers see Google Sheets as "Not connected yet". Automatic hourly syncs ride the existing
hourly `runReminderSweep` trigger - nothing new to add.


### Manifest (`appsscript.json`) — check once, and after any service/scope change

The project lists its permissions explicitly (`oauthScopes`), so a service the
code uses but the manifest doesn't list fails **silently at runtime**, not at
save. Paid featuring's receipt check reads the OCR'd text with `DocumentApp`,
which needs the `documents` scope; without it every payment quietly falls
back to admin review.

To see it: ⚙️ **Project Settings → Show "appsscript.json" manifest file in
editor**. It should read:

```json
{
  "timeZone": "Pacific/Tarawa",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/meetings.space.created"
  ],
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Drive",
        "version": "v3",
        "serviceId": "drive"
      }
    ]
  }
}
```

Two traps seen on the featuring deploy:

- **"Found a service identifier used more than once: Drive"** — Drive was
  already enabled, and adding it again via Services listed it twice. Keep
  exactly one `drive` entry (remove the other under **Services → ⋮ → Remove**,
  or delete it from the JSON).
- **"Unsaved changes" / the manifest won't save** — deleting a block by hand
  left the JSON broken (a trailing comma, or a missing `]` / `}` at the end).
  Paste the whole file above instead of patching it.

**After adding a scope, approve it once before deploying:** pick `doGet` in the
function dropdown and press **Run** — the one exception to "don't press Run"
below. Google asks you to allow the new permission; click **Allow**. The run
itself then errors (there is no request to answer) — ignore that; the approval
was the point, and `doGet` only reads. Skip this and the deployed web app can
fail on the new permission.

---

## 2. Paste and save

Open the editor: **https://script.google.com**

For each changed file: select the matching tab, Ctrl+A, paste, then **Ctrl+S**
and wait for the save to finish.

> **Do not press Run.** Run executes whichever function the dropdown happens to
> have selected, with no arguments. With `Db.gs` open that is `getSheet()`,
> which throws `Sheet tab not found: undefined` — an alarming error that means
> nothing about your deployment. Nothing here is meant to be run by hand except
> `setupSheets`, and that is only for creating missing tabs.

---

## 3. Deploy

**Deploy → Manage deployments → ✏️ (pencil) → Version dropdown → "New version" → Deploy**

Two traps, both of which look like success:

- **Leaving the Version dropdown alone** silently redeploys the *old* version.
  Changing it to "New version" is the step that matters.
- **"New deployment"** mints a *different* `/exec` URL that the site never
  calls, so the live site keeps running the old code.

---

## 4. Verify — never skip this

https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec?action=getVersion

It must echo the `APP_VERSION` currently in
[`apps-script/Code.gs`](https://github.com/dsc26support-beep/simple-kiri-shop/blob/main/apps-script/Code.gs)
— check the two match. An older string, or `Unknown action: getVersion`, means
step 2 or 3 did not take.

This probe needs no auth and reads no Sheets, so it answers even on a
half-configured project.

Wider health check: append `?action=checkSetup` instead — it reports missing
tabs and headers without exposing any row data.

---

## Quick reference

| | |
|---|---|
| Live site | https://mwakete.com |
| Repo | https://github.com/dsc26support-beep/simple-kiri-shop |
| Apps Script editor | https://script.google.com |
| Version probe | [`?action=getVersion`](https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec?action=getVersion) |
| Setup probe | [`?action=checkSetup`](https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec?action=checkSetup) |

The `/exec` URL above is the live one, and is also in
[`assets/js/config.js`](https://github.com/dsc26support-beep/simple-kiri-shop/blob/main/assets/js/config.js).
It is a public endpoint, not a secret — it is in the frontend of every page.

---

## Notes for whoever changes the code

- **Bump `APP_VERSION`** in `Code.gs` with any `.gs` change, or the probe in
  step 4 cannot tell a successful deploy from a failed one. The test suite
  enforces this: if any `.gs` differs from `main`, `APP_VERSION` must differ too.
- **Bump `CACHE`** in `sw.js` when HTML, CSS or JS changes. The service worker
  serves the shell stale-while-revalidate, so without a bump an installed device
  shows the change one navigation late.
- **Frontend and backend deploy independently.** A frontend change is live on
  merge; a backend change waits for the steps above. Write frontend code so it
  degrades sensibly against a not-yet-redeployed backend rather than breaking —
  see `unreadCountOf()` in `customer-messages.js` for the pattern.

## Featuring payments - Script Properties (all optional)

Set under **Project Settings → Script Properties** in Apps Script. No redeploy
is needed after changing one. Leave a property unset to use its default.

| Property | Default | What it does |
|---|---|---|
| `FEATURE_AUTO_APPROVE_MAX` | `20` | A single payment above this ($) always waits for an admin. `0` = every payment waits. |
| `FEATURE_STORE_WEEKLY_AUTO_MAX` | `20` | Most an established store (3+ paid featurings) can have auto-approved in 7 days. Above it, waits for an admin. |
| `FEATURE_NEW_STORE_WEEKLY_AUTO_MAX` | `5` | The same limit for a store with fewer than 3 paid featurings. |
| `FEATURE_START_DELAY_HOURS` | `2` | Hours between automatic approval and the featuring starting. `0` = start at once. |
| `FEATURE_MAX_PAYMENT_AGE_HOURS` | `72` | Receipts dated older than this are rejected. |
| `FEATURE_MIN_IMAGE_BYTES` | `15000` | Smaller uploads are refused as blank or cropped. |

What the automatic check refuses or holds, and why, is described at the top of
`apps-script/Featuring.gs`. Every decision is written to the purchase's
`OcrNotes` cell (e.g. `receiptNo:false ... (no receipt number read)`).

### Bank matching (Oct 2026)

| Property | Default | What it does |
|---|---|---|
| `FEATURE_BANK_MATCH_DAYS` | `7` | Auto-approved paid featuring stops this many days after it starts unless ticked "Seen in bank" in Admin. |
| `FEATURE_BANK_REMINDER_EMAILS` | the `ADMIN_EMAILS` list | Who gets the reminder emails 2 days and 1 day before, and the "stopped" notice (comma-separated). Set by the owner in Script Properties. |

Runs inside the existing hourly reminders trigger - no new trigger to set up.

## Listing checks - Script Properties (optional)

| Property | Default | What it does |
|---|---|---|
| `LISTING_REVIEW_NOTIFY` | off | `true` = email `ADMIN_EMAILS` about every new listing-review case. |

Everything else about the listing checks is in [docs/listing-review.md](docs/listing-review.md).

## Product options - Script Properties (optional)

| Property | Default | What it does |
|---|---|---|
| `PRODUCT_OPTION_TYPES_MAX` | 3 | Option types per product (1-5). |
| `PRODUCT_OPTION_VALUES_MAX` | 20 | Values per option (1-50). |
| `PRODUCT_VARIANTS_MAX` | 100 | Combinations per product (1-250). |
| `VARIANT_IMAGES_MAX` | 4 | Photos per combination (0-10; 0 = off). |
