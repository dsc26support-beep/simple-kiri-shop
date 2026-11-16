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

## Stage 3 — access-control test suite (16 Nov 2026)

Owner asked for a penetration test "through Strix". Strix is an *active* agent
(it fires live exploit payloads and needs Docker + a paid LLM key); it can't run
from the build sandbox (no Docker, no outbound network to mwakete.com) and
pointing it at the live Google backend would mean destructive tests on
production data. Owner chose the planned safe alternative instead: the Stage-3
access-control suite, which covers the same classes (BOLA/IDOR, privilege
escalation, brute force, replay, injection, error leakage) against the real
backend via the gas-harness, driven through the real `doPost`/`doGet` router.

`tests/test-security-stage3.js` (36 checks), covering:

- **Vertical escalation:** all **53** admin-gated actions (every `admin*` plus
  the non-prefixed admin-only ones — featuring review, badge config,
  wholesale/store trust, review cases, the marketing engine) refuse a real
  non-admin seller token **and** an anonymous caller; a customer token is
  refused by seller and admin actions; control: the real admin is allowed in.
- **Horizontal / IDOR / BOLA:** seller B cannot read or change seller A's
  campaign, product (update/delete), order status or variant stock by passing
  A's id; each paired with an A-owns-A control, and a check that A's rows are
  left untouched.
- **Listing isolation:** B's product, order and inventory lists never contain
  A's rows.
- **Unauthenticated + no leak:** protected actions refuse missing and garbage
  tokens and leak no sheet/stack/exception text.
- **Brute force:** repeated wrong customer passwords lock out without revealing
  whether the email exists; the code path is rate-capped.
- **Replay:** a used sign-in code cannot be reused; a logged-out session token
  is dead at once.
- **Formula injection end to end:** a seller naming a product `=HYPERLINK(...)`
  has it stored as text.

Result: 36/36. No access-control hole found. The sweep is the valuable part —
it fails if a missing `isOwnerAdmin` check ever lands on any admin action.

## Stage 2 — Content Security Policy on every page (16 Nov 2026)

Closes finding 1 ("No CSP on any of 45 pages", High): the safety net if an XSS
bug ever slips past the escaping, so an injected `<script>` cannot run and
read the session token out of browser storage.

### What shipped

- A `<meta http-equiv="Content-Security-Policy">` on **all 45 served pages**,
  injected right after `<meta charset>` (before the first script it governs).
  GitHub Pages cannot send HTTP headers, so the policy travels in the page.
- One build step, `tools/build-csp.js`, writes it, in the same marker +
  `--check` style as the other build tools. It runs **last** in `npm run build`
  (after `build-early.js`, so it hashes the final bytes of the generated
  early-fetch block). `npm run build:check` fails CI if any page's tag is stale.
- The policy is **identical on every page** (the union of all inline-script
  hashes), so it is easy to audit and caches like any other shell byte.
- The Sheets add-on sidebar (`sheets-addon/Sidebar.html`) is deliberately left
  out: it is served inside Google's HtmlService sandbox, not from mwakete.com,
  and has its own CSP.

### The policy

```
default-src 'self';
base-uri 'self';
object-src 'none';
script-src 'self' <14 SHA-256 inline hashes>
           https://accounts.google.com https://connect.facebook.net https://cdn.jsdelivr.net;
style-src  'self' 'unsafe-inline';
img-src    'self' data: blob: https://res.cloudinary.com https://*.googleusercontent.com https://drive.google.com;
font-src   'self' data:;
connect-src 'self' https://script.google.com https://script.googleusercontent.com
            https://accounts.google.com https://cdn.jsdelivr.net
            https://connect.facebook.net https://graph.facebook.com https://www.facebook.com;
frame-src  https://accounts.google.com https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com;
worker-src 'self'; manifest-src 'self'; form-action 'self'; upgrade-insecure-requests
```

Why each third party is allowed, and in which directive (all verified in code):

| Feature | Directive(s) | Host(s) |
|---|---|---|
| Google sign-in (GSI, `google-signin.js`) | script, connect, frame | `accounts.google.com` |
| Facebook sign-in (`facebook-signin.js`) | script, connect, frame | `connect.facebook.net`, `*.facebook.com` |
| Face check + POS scanner (`driver-face.js`, `pos-camera.js`) | script, connect | `cdn.jsdelivr.net` (face-api SRI-pinned; ZXING; model weights) |
| Apps Script backend (`config.js` `/exec`) | connect | `script.google.com` **and** `script.googleusercontent.com` (the `/exec` call 302-redirects to the usercontent host — both are required) |
| Product / logo photos | img | `res.cloudinary.com` |
| Google avatars & Drive-hosted images | img | `*.googleusercontent.com`, `drive.google.com` |
| Service worker, manifest, in-site forms | worker, manifest, form-action | `'self'` |

Meet/Maps/`m.me`/`wa.me` links are top-level navigations (anchor targets), which
CSP does not restrict, so they keep working with no directive.

### script-src is strict — the whole point

No `'unsafe-inline'` and no `'unsafe-eval'` for scripts. Every inline `<script>`
block on the site (14 of them, including the per-page early-fetch block and the
first-visit redirect) is allowed by its exact **SHA-256 hash**; anything else —
an injected `<script>`, an `on*=` attribute, a `javascript:` URL — is refused by
the browser. Nonces were rejected: static hosting has no server to stamp a fresh
one per response, so a nonce would have to be constant, which is no better than
`'unsafe-inline'`.

To keep that strict policy, the only three inline event handlers on the site
(`driver-contract.html` ×2 `window.print()`, `offline.html` `location.reload()`)
were moved out of `on*=` attributes into small inline scripts wired with
`addEventListener` — which are then hashed. `offline.html` stays fully
self-contained (it is the service-worker offline fallback). The app's own code
already used `addEventListener` / property assignment everywhere and never puts
`on*=` handlers into `innerHTML`, so nothing generated at runtime depends on
inline execution; the face check uses tfjs's WebGL/CPU backend (no WASM/eval), so
no `wasm-unsafe-eval` is needed.

### Unavoidable relaxations (honest limits)

- **`style-src 'unsafe-inline'`** — kept on purpose. Nine inline `style="..."`
  attributes (across `cart`, `checkout`, `owner/admin`, `owner/settings`,
  `pos/index`) and two `<style>` blocks remain. Inline CSS **cannot execute
  script**, so this is not an XSS vector; hash/nonce for styles would mean
  refactoring every inline style for no security gain. Removing them is a future
  tidy-up, not Stage 2. (A fully strict `style-src` is the only part of a
  "perfect" CSP not achieved here, and it is the low-value part.)
- **`frame-ancestors` (anti-clickjacking) and HSTS cannot go in a `<meta>` tag.**
  They are **not faked**. Clickjacking protection and HSTS need response
  headers, i.e. the Cloudflare proxy (audit "extras", owner signs up). Until
  then the mitigations already noted stand: no session cookies, tokens in the
  request body, 2-step verification on the Google account.
- `upgrade-insecure-requests` is included as a belt-and-braces upgrade of any
  stray `http://` subresource; every resource is already `https://`.

### Tests

- `tests/verify-csp.js` (**35 checks**, headless Chromium): every served page
  has one well-formed, identical CSP tag before the first script; `script-src`
  is strict (no `unsafe-inline`/`unsafe-eval`, has `'self'` + hashes); the key
  third parties are allowed in the right directive; `frame-ancestors`/HSTS are
  **not** faked; and — using the real browser CSP engine — each page's own
  inline scripts run (hashes correct), an injected inline/external script, image
  and `fetch()` to an unknown origin are blocked, while the backend fetch and a
  Cloudinary image are not.
- `npm run build:check` gains a CSP freshness guard (edit a page, forget to
  rebuild → red).
- Service-worker cache bumped **v234 → v235** because precached HTML changed
  (the cache-bump guard in five suites would otherwise fail).
- Regression: the CSP-sensitive browser suites (sign-in, PWA/SW, POS, face
  check, early-fetch, welcome, minified-build freshness, Stage-1) were re-run
  green under the enforced policy. Known pre-existing failures (listed by the
  owner: `gis is not defined`, logout CLS, meetings-ui double-fetch, more-colors
  purple count, perf offline nav, `page.accessibility` on badges-ui/home-search,
  inventory-page timeout) are unchanged by this stage.

### Deploy / verify steps (frontend only — no backend change)

Stage 2 touches no `.gs` file, so **no `APP_VERSION` bump and no Apps Script
deploy** are needed. On merge to `main`, GitHub Pages serves the new pages.
Owner check on a phone (ideally a returning visitor, to confirm the SW update):

1. Open mwakete.com; sign in with **Google**, and with **Facebook** if enabled.
2. Browse a store and a product — **Cloudinary** photos load.
3. Driver onboarding **face check** runs (`driver.html`); POS **barcode scan**
   (`owner/pos.html`) opens the scanner.
4. Place/track an order — chat, meetings and backend calls work.
5. DevTools console shows **no CSP violation** in normal use. (The audit's
   mitigations for clickjacking/HSTS still await the Cloudflare proxy.)
