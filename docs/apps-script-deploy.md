# Deploying the Apps Script backend (with `clasp`)

**Why this exists.** The backend used to be deployed by hand — opening the Apps
Script editor and pasting each file in `apps-script/` one at a time. On
19 Nov 2026 one file (`Inventory.gs`) was left out of a deploy; every product
list then threw `availableOf is not defined` and the **whole storefront went
blank** while the health check still read `setupOk: true`. `clasp` pushes the
*entire* `apps-script/` folder in one command, so a file can't be left behind
again.

Two safety nets now exist together:
- **`clasp`** makes a deploy atomic (all files, every time).
- **`?action=checkSetup`** now probes `Inventory.gs` and the other core files,
  and confirms the `Products` / `Variants` / `Owners` / `Orders` /
  `Conversations` / `Messages` tabs exist — so a missing file or tab shows up as
  a `problem` in one click instead of a silent blank site.

> This backend can only be deployed from a machine where you can sign in to
> Google in a browser. It cannot be deployed from the Claude sandbox. The steps
> below are for **you** to run on your own computer.

---

## One-time setup

1. Install Node.js (18+), then clasp:
   ```bash
   npm install -g @google/clasp
   ```
2. Sign in (opens a browser; use the Google account that owns the Mwakete
   script):
   ```bash
   clasp login
   ```
   This writes `~/.clasprc.json` — your login token. **Never commit it** (it's
   already in `.gitignore`).

The repo already carries `.clasp.json`, which points at the live script:
```json
{ "scriptId": "1wfT2-QATicr5VUkNBwG0GknDTiwYytGuMgWaX-InVUvpxFDjhuUkcDXi", "rootDir": "apps-script" }
```

---

## First time only: adopt clasp without disturbing the live deployment

`clasp push` **overwrites the script's files with the repo's `apps-script/`
folder**, and it needs an `appsscript.json` manifest (the project has one; the
repo does not yet). So before the first push, capture the current project state
in a throwaway folder and reconcile — do **not** `clasp pull` into the repo
(that would overwrite your working files).

```bash
# In an EMPTY scratch folder, NOT the repo:
mkdir ~/mwakete-live-snapshot && cd ~/mwakete-live-snapshot
clasp clone 1wfT2-QATicr5VUkNBwG0GknDTiwYytGuMgWaX-InVUvpxFDjhuUkcDXi
```

Then:
1. **Diff** the snapshot's `.gs` files against the repo's `apps-script/`. They
   should match the deployed `secure1-2026-11-19` build. If anything exists only
   in the live project, copy it into the repo first — the repo is the source of
   truth that every future push sends.
2. **Copy `appsscript.json`** from the snapshot into `apps-script/appsscript.json`
   in the repo and commit it. This is the project's real manifest, including the
   web-app access settings (**Who has access: Anyone**, **Execute as: Me**).
   Capturing the real one — rather than writing a new one — means a later push
   can't accidentally change who can reach the site.
3. Commit those reconciliations. From now on the repo's `apps-script/` is exactly
   what the live script runs.

---

## Every deploy after that

```bash
# From the repo root:
clasp push           # uploads ALL of apps-script/ to the script (atomic)
```

Then publish a **new version of the existing Web App deployment** so the public
`/exec` URL stays the same:

- **Editor way (recommended):** Apps Script editor → **Deploy → Manage
  deployments → ✏️ (edit the active deployment) → Version: _New version_ →
  Deploy.**
- **CLI way:** `clasp deploy -i <DEPLOYMENT_ID>` (find the id with
  `clasp deployments`). Do **not** run a bare `clasp deploy` — that creates a
  *new* deployment with a *different* `/exec` URL, which the site isn't pointing
  at.

> Bump `APP_VERSION` in `apps-script/Code.gs` whenever the backend changes, so
> the check below proves the new build is actually live.

---

## Verify every deploy (don't skip this)

Open these in a browser (replace with your real `/exec` URL):

1. `…/exec?action=getVersion` → `{"ok":true,"version":"secure1-2026-11-19"}`
   (or whatever `APP_VERSION` you just shipped). If it shows the **old** value,
   the new version isn't live yet — redeploy.
2. `…/exec?action=checkSetup` → `{"ok":true,"setupOk":true,"problems":[], …}`.
   Any missing file or core tab appears in `problems` here.
3. `…/exec?action=listTopProducts` → `{"ok":true,"products":[…]}` (real data,
   not a `(Ref …)` error).

Then load **mwakete.com** — the storefront refreshes within ~5 minutes as the
cache rolls over (a hard refresh / incognito shows it immediately).

---

## If you ever paste by hand instead

clasp is strongly preferred, but if you must paste in the editor: paste **every**
file in `apps-script/`, then run `checkSetup` (step 2 above) **before** telling
anyone it's done. If `problems` lists a file or tab, you missed one — that is
exactly the failure this guards against.
