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

Browse them all: https://github.com/dsc26support-beep/simple-kiri-shop/tree/main/apps-script

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
