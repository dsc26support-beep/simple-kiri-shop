# Backup and restore — Mwakete

Date: 2026-11-17. Owner-run. What to copy, how often, and how to put it back.
All of Mwakete's state lives in a few Google-owned places plus this GitHub repo;
none of it is on a server we run, so "backup" here means **copying Google data**
and **knowing the repo is the source of truth for code.**

## What has to be backed up (and what does not)

| Thing | Where it lives | Backup needed? | How |
|---|---|---|---|
| **The data** (owners, products, orders, messages, sessions, drivers, ...) | Google **Sheet** | **Yes — this is the irreplaceable part** | Timed Drive copy + periodic export (below) |
| Uploaded photos & driver documents | Google **Drive** folders | Yes (lighter) | Drive copy / export; originals also on Cloudinary for product images |
| **Secrets** (PEPPER, Cloudinary, Resend, Facebook, Graph, ADMIN_EMAILS, ...) | Apps Script **Script Properties** | **Yes — record the names + values somewhere safe and OFFLINE** | Manual list in a password manager |
| Backend code | `apps-script/*.gs` in this repo | Already versioned | Git history is the backup |
| Frontend code | this repo (served by GitHub Pages) | Already versioned | Git history is the backup |
| Android app signing key | GitHub Actions secrets (if set up) | Yes, if you ever signed a release | Keep the keystore + passwords offline |

The **code** needs no separate backup — Git is the backup, and GitHub keeps it.
The **Sheet** is the one thing that, if lost or corrupted, cannot be regenerated.
Treat it accordingly.

## How to back up the Sheet (the important one)

Two layers, because they fail differently:

1. **Automatic version history (already on).** Google Sheets keeps full version
   history (**File → Version history**). This covers "someone/something changed
   or deleted rows" — you can roll a tab back in place. It does **not** cover the
   file being deleted or the account being lost.

2. **Periodic independent copies (do this).** On a schedule you keep:
   - In Drive, **make a copy** of the Sheet named with the date
     (`Mwakete data — backup YYYY-MM-DD`), and/or
     **File → Download → Microsoft Excel (.xlsx)** and keep the file somewhere
     **outside** the same Google account (a second account, a computer, external
     storage). A copy that lives only in the same account dies with the account.
   - Suggested cadence: **weekly**, and always **right before any backend deploy**
     (the deploy checklist calls for this too). Keep the last several; delete very
     old ones.

   This can be automated later with an Apps Script time-trigger that copies the
   Sheet to a backup folder, but a manual weekly copy is enough to start and has
   no moving parts to break.

## How to back up the secrets

In the Apps Script project → **Project Settings → Script properties**, write down
every property **name and value** and store them in a password manager (or a
sealed offline note). You cannot read some of them back out of the system later,
and a lost **PEPPER** means every stored password hash becomes unverifiable.
Update this list whenever a secret is added or rotated.

## How to back up uploaded files

Product photos are also on Cloudinary (each has a unique URL), so the Sheet's
links plus Cloudinary are effectively two copies. **Driver documents** live only
in a private Drive folder — include that folder in a periodic Drive copy, because
there is no second copy elsewhere.

## Restore — putting it back

**Lost or corrupted data (rows changed/deleted, bad import):**
1. First try **File → Version history** and restore the Sheet to a point before
   the damage. This is the fastest and keeps the same file/links.
2. If the file itself is gone or unusable, open your latest dated backup copy (or
   re-upload the `.xlsx`), and **point the Apps Script project at it**: the script
   references the spreadsheet by ID, so either copy the data back into the
   original Sheet, or update the script's spreadsheet ID / binding to the restored
   file, then run `checkSetup` (see below) to confirm the tabs/columns are right.

**Lost secrets (new Google account, or properties cleared):**
Re-enter every Script Property from your offline list. If **PEPPER** was lost and
cannot be recovered, set a new one and expect users to reset passwords (legacy
hashes upgrade on next sign-in; see `apps-script/Passwords.gs`).

**Lost code (unlikely — it is in Git):**
Re-clone this repo. For the frontend, GitHub Pages serves `main`. For the backend,
re-paste `apps-script/*.gs` into a fresh Apps Script project per `DEPLOY.md`.

## After any restore — verify

- Run the backend **`?action=getVersion`** check and **`checkSetup`** (the setup
  self-check) and confirm they are clean — the same checks the deploy process uses
  (`docs/secure-deployment-checklist.md`, `DEPLOY.md`).
- Open mwakete.com on a phone and confirm sign-in, a store, a product and the
  cart work, and that photos load.
- Spot-check a few recent orders/messages against what you remember, to confirm
  you restored the right (recent) copy.

## Test the backup (at least once)

A backup you have never restored is a guess. At least once, **copy the Sheet to a
test file, open it, and confirm the data is all there** and that you know how to
point the script at it. Re-check after any big schema change.
