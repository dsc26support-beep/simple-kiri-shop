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
