# Security audit, November 2026 (Phase 1) and approved hardening plan

Date: 2026-11-16. Scope: the whole repository - website (`*.html`,
`owner/`, `pos/`, `assets/js`), backend (`apps-script/*.gs`), Sheets add-on,
Android SMS app, GitHub workflows. Read-only inspection; nothing changed yet.
The previous audit (`docs/security-audit.md`, Aug 2026) closed all its
findings; this one concentrates on what was added since (SMS, POS,
transactions, drivers, contacts, campaigns, sign-in links, welcome screen,
speed work).

## Architecture (as found)

| Part | What it is |
|---|---|
| Website | Static HTML/CSS/vanilla JS on GitHub Pages (mwakete.com). No server of its own. |
| Backend | Google Apps Script web app: `doGet` (18 public reads) and `doPost` (public writes with their own checks; 118 seller actions behind a session token, 39 of them admin-only). |
| Data | Google Sheets, reached only through the script. No SQL database. |
| Secrets | Script Properties only (Cloudinary, Resend, Facebook, Microsoft Graph, PEPPER, ...). None in the website or in Git history (pattern scan of tracked files and all history). |
| Other clients | POS app (`/pos/`, till secret / staff PIN), Android SMS app (device id + secret), Sheets add-on - all on the same backend. |
| Files | Photos to Cloudinary / Drive; driver documents to a private Drive folder. |
| CI | `android.yml` (signing secrets used on main only; PRs read-only), `sms-backend.yml`. |

## Already in place (verified in code)

- Admin = seller account whose email is in `ADMIN_EMAILS` (server-side); all 39 admin actions check it (`isOwnerAdmin`, or `txRoleOnly(ctx, ['admin'])` for transactions).
- Seller actions resolve ownership with helpers (`scOwnCampaign`, `ownVariantForStock`, ...); to be confirmed by tests in Stage 3.
- Passwords: PBKDF2-HMAC-SHA256 + secret pepper (`Passwords.gs`), legacy hashes upgraded on sign-in; lockout after 5 failures in 15 min; codes rate-limited; sign-in links single-use and expiring; stored tokens hashed.
- Uploads: magic-byte type check (JPEG/PNG/WebP/GIF) and 5 MB limit.
- POS integration inbound: HMAC signature, constant-time compare, timestamp, idempotency/duplicate protection.
- Sheets formula injection guarded in `appendRowFromObject` / `updateRowFromObject` (`sanitizeForSheetCell`).
- No session cookies, so CSRF does not apply; tokens travel in the request body.
- `npm audit`: 0 vulnerabilities (only two build tools; nothing ships to the site).

## Findings

| # | Finding | Severity |
|---|---|---|
| 1 | No Content Security Policy on any of 45 pages - the main safety net if an XSS bug slips in, and tokens live in browser storage. | High |
| 2 | ~5 places insert values into HTML without escaping, to check by hand and fix: `customer-dashboard.js:549`, `owner-settings.js:335`, `campaign-studio.js:153/167`, `admin-deliveries.js:139` (and any found while checking). | Medium until checked |
| 3 | Backend returns raw internal error text to the browser (`Code.gs` catch blocks in `doGet` / `doPost`). | Medium |
| 4 | 4 direct sheet writes bypass the formula guard: `Inventory.gs:67`, `PosSync.gs:76`, `Badges.gs:654`, `InventorySync.gs:100` (seller's own sheet). | Medium |
| 5 | face-api library loaded from jsDelivr without an integrity hash (`driver-face.js`). | Medium |
| 6 | PBKDF2 at 4,000 rounds (Apps Script speed limit) vs 600,000 recommended; pepper and raisable rounds mitigate. | Low (documented) |
| 7 | No automated secret / code scanning in GitHub; no SECURITY.md, incident-response or backup/restore guide. | Process |

## Platform limits (documented, not hidden)

- **RLS / parameterized SQL:** not applicable - no SQL database. Equivalent controls: only the script can read the sheet; formula guard on writes.
- **Tokens in localStorage:** Apps Script cannot set HttpOnly cookies, so session tokens stay in browser storage. Mitigations: strict CSP (Stage 2), expiring and revocable tokens stored as hashes.
- **CORS:** Apps Script web apps cannot be configured; harmless here because no cookies/ambient credentials are sent.
- **Security headers:** GitHub Pages cannot send HSTS, frame-ancestors or Permissions-Policy. CSP can go in a `<meta>` tag; anti-framing needs a proxy (Cloudflare, see extras).
- **Owner checks:** spreadsheet not shared publicly or by link; 2-step verification on the Google account that owns the script; GitHub Pages "Enforce HTTPS" on.

## Approved plan (owner, 16 Nov 2026)

One PR per stage, each tested (including the full regression suite) before the next.

1. **Fix what is exploitable:** findings 2, 3, 4, 5.
2. **Content Security Policy** on every page, tested page by page against Google / Facebook sign-in, Cloudinary photos, the face check, maps.
3. **Security test suite:** cross-store access, customer -> seller -> admin escalation, IDOR on every id-taking seller action, brute force, code/link replay, formula injection, stored/reflected XSS, error-detail leakage.
4. **Automation and documentation:** GitHub secret scanning + CodeQL workflow; `SECURITY.md`, incident response, backup and restore, secure deployment checklist, final status table for the 19 requirements.

Extras approved:

- **Admin sign-in code:** an emailed code at each sign-in to the admin pages (admins only).
- **Cloudflare in front of mwakete.com:** plan and exact steps only - it is a new (free) service and a DNS change, so the owner signs up and approves; the Cloudflare connector also needs authorising in claude.ai connector settings before Claude can help configure it.

## Stage 1 results (16 Nov 2026)

| # | What was found on close inspection | What changed |
|---|---|---|
| 2 | `owner-settings.js:335` (label from a constant) and `campaign-studio.js` (already escaped) were safe. Links built from data (`admin-deliveries.js` Messenger and live-location links, `header-ads.js`, `order-room.js`, `owner-orders.js`, `driver.js` map link) were HTML-escaped, but escaping does not stop a `javascript:` address. Driver document previews (`dataUrl`) went into the page unchecked. `customer-dashboard.js` put the record id into attributes unescaped. Not exploitable today (the backend already checks Messenger and advert links and generates the ids), but nothing in the page enforced it. | `safeUrl()` in `helpers.js`: only `https:`/`http:`, `tel:`, `mailto:` and in-site links pass, after removing the control characters browsers ignore (`java<tab>script:`, found by the new test); anything else becomes `#`. Used on every link built from data. `safeDataUrl()`: only base64 JPEG/PNG/WebP/GIF/PDF previews, otherwise shown as "file missing". Ids escaped. |
| 3 | `doGet`/`doPost` catch blocks, and about 30 sign-in catch blocks, sent `err.message` to the browser. | `publicErrorMessage()` (`Utils.gs`): messages written for people pass unchanged (the pages rely on them); programming errors, Google service exceptions, sheet/setup messages, addresses and very long messages become "Something went wrong on our side... (Ref xxxxxxxx)", with the full error logged under that reference (Apps Script > Executions). |
| 4 | All four writes named in the audit already went through `sanitizeForSheetCell` (or wrote numbers); the line numbers pointed at the write call. Every other write uses `appendRowFromObject` / `updateRowFromObject`. | Guard also covers a leading tab or carriage return (OWASP list). Stock write-back to a seller's sheet passes through the guard as well. |
| 5 | face-api from jsDelivr without integrity. | `sha384` Subresource Integrity on the script, hash taken from the npm package and checked against the registry's signed integrity. A changed file is refused and the face check falls back to "unsupported" (manual review). The model weights are fetched by the library itself and cannot carry SRI; self-hosting library + models is the stronger option if wanted later. |

Tests: `tests/test-security-stage1.js` (backend, 22 checks) and `tests/verify-security-stage1.js` (browser, 13 checks incl. hostile data on the admin drivers list and a tampered vs genuine face-api file).
