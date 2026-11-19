# Incident response runbook — Mwakete

Date: 2026-11-17. Owner-run. This is a practical, small-team plan, written for
the people who actually run Mwakete, not a corporate SOC. Keep a copy somewhere
reachable **off** the site (phone notes / printed), because an incident may be
the site or the Google account itself.

## Who does what

Mwakete is a one/two-person operation. In an incident the **owner** is incident
lead and makes every call that changes production (deploys, revoking access,
rotating secrets). Claude (this engineering assistant) can prepare fixes, code
and exact steps on request, but **cannot deploy the Apps Script backend or change
Google/GitHub account settings** — those are manual owner actions, by design
(see `CLAUDE.md`).

## The system, in one picture (what an attacker could reach)

| Layer | Where it lives | If compromised |
|---|---|---|
| Frontend | Static files on GitHub Pages (this repo → `main`) | Defacement / malicious JS served to users |
| Backend | One Google Apps Script web app (`doGet`/`doPost`) | Full data access, acting as the app |
| Data | Google Sheets (+ Drive for photos/driver docs) | Customer/seller/order data exposure |
| Secrets | Apps Script **Script Properties** (PEPPER, Cloudinary, Resend, Facebook app secret, Microsoft Graph, ADMIN_EMAILS, ...) | Password-hash pepper, email/image/SMS sending abuse |
| Identity | The **Google account** that owns the script + Sheet; the **GitHub account** that owns the repo | Everything above |
| Other clients | POS app, Android SMS app, Sheets add-on (own secrets) | Narrow, per-client abuse |

The single most important accounts to protect are the **Google account** (owns
the backend, data and secrets) and the **GitHub account** (owns the code that is
served). Both must have 2-step verification on. If either is compromised, treat
it as a Critical incident below.

## Severity (decide fast, then act)

- **Critical** — live data exposed or being exfiltrated; the Google or GitHub
  account is compromised; malicious code is being served from mwakete.com; a
  secret (pepper, API key) is confirmed leaked.
- **High** — a real vulnerability with a working exploit but no confirmed
  abuse yet; a single account (one seller/admin) compromised.
- **Medium / Low** — limited abuse (spam, rank-gaming), or a reported issue not
  yet confirmed exploitable.

## The six steps

### 1. Detect & record
Note the time, what you saw, and how you found out (a report via `SECURITY.md`,
a CodeQL/secret-scan alert in the repo's **Security** tab, a strange Sheet row,
Apps Script **Executions** errors, an abuse complaint). Start a dated note and
keep every piece of evidence (screenshots, the reporter's email, the offending
row/URL). Do **not** start deleting things yet — you will need the evidence.

### 2. Triage
Pick a severity. Decide the one question that matters: **is data or the account
actively at risk right now?** If yes → contain immediately (step 3). If it is a
reported-but-unproven issue, reproduce it in a test account first.

### 3. Contain (stop the bleeding)
Choose by incident type:

- **Leaked secret (pepper / API key / app secret):** rotate it. In the Apps
  Script project → **Project Settings → Script properties**, replace the value,
  then redeploy if needed. For a leaked **PEPPER**, note that existing password
  hashes were computed with it; rotating it forces password resets (see
  `apps-script/Passwords.gs` — legacy hashes upgrade on next sign-in). For
  Cloudinary/Resend/Facebook/Graph keys, rotate in that vendor's console and
  update the Script Property. Then check the repo (**secret-scan** workflow /
  Security tab) in case it was committed.
- **Compromised seller/admin account:** the owner can revoke that user's
  sessions — tokens are stored hashed and are revocable/expiring; invalidating
  them (or rotating the token-signing inputs) logs the attacker out. Reset the
  account's password. For an **admin**, also confirm `ADMIN_EMAILS` still lists
  only the right people.
- **Malicious code served from mwakete.com (GitHub compromised):** this is
  Critical. Secure the GitHub account first (change password, review sessions &
  OAuth apps, confirm 2FA), then `git log`/compare `main` against a known-good
  commit, revert the bad commit, and push. GitHub Pages re-serves within
  minutes. The strict CSP (Stage 2) limits what injected code could do, but do
  not rely on it — remove the code.
- **Data exposure via an over-shared Sheet/Drive folder:** in Google Drive, set
  the Sheet and the driver-documents folder back to **private** (not "anyone
  with the link"). Confirm no public link remains. The spreadsheet should never
  be shared publicly — only the script reads it.
- **Spam / abuse (messages, views, carts):** the backend already rate-limits and
  throttles these (Aug audit findings 3-5). If a specific actor is abusing, that
  path is capped; capture the pattern and tighten the cap if needed.
- **Backend outage / quota exhaustion:** check Apps Script **Executions** and
  the Google quota. If an endpoint is being hammered, the quota resets daily;
  consider temporarily disabling the abused action behind its flag.

If you cannot contain safely and data is actively leaking, the last resort is to
take the backend offline: in the Apps Script deployment, switch access off or
deploy a version that returns a maintenance message. The static site stays up.

### 4. Eradicate
Remove the root cause, not just the symptom: ship the code fix (open a PR, run
the test suite, merge, deploy per `docs/secure-deployment-checklist.md`),
rotate every secret that could have been exposed, and remove any attacker
foothold (extra admin email, rogue OAuth app, added collaborator).

### 5. Recover
Restore any lost or tampered data from backup (`docs/backup-restore.md`),
confirm the fix with the relevant test suite and a manual check on a phone, and
watch Executions / the Security tab for recurrence. Re-enable anything you
disabled only once you are confident.

### 6. Review (within a week)
Write a short post-incident note in this repo's history or `docs/`: what
happened, the timeline, what fixed it, and one or two concrete changes to stop a
repeat (a new test, a tighter cap, a rotated key, a doc update). Add a
regression test where one would have caught it.

## Standing hardening that limits blast radius (already in place)

- 2-step verification on the Google and GitHub accounts (owner-confirmed).
- Secrets only in Script Properties, never in the repo; CI secret scanning +
  CodeQL (Stage 4) and, when enabled, GitHub push protection.
- Session tokens hashed, expiring and revocable; strong password hashing with a
  pepper; sign-in lockout and code rate-limits.
- Strict Content-Security-Policy on every page (Stage 2) as the XSS safety net.
- Access-control test suite (Stage 3) guarding the admin gate and store isolation.

## Quick contacts / consoles

- Apps Script project (backend, Script Properties, Executions): script.google.com
- Google Drive (the Sheet + driver-docs folder sharing): drive.google.com
- GitHub repo security alerts: the repository's **Security** tab
- Vendor consoles for key rotation: Cloudinary, Resend, Facebook for Developers,
  Microsoft Azure (Graph).
