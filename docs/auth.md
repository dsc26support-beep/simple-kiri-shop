# Mwakete authentication, shopper accounts and seller onboarding (Oct 2026)

This document covers the 14 deliverables of the authentication master prompt. Facebook and Google
setup steps are in [auth-meta-setup.md](auth-meta-setup.md).

The owner made four decisions, and this work follows them:

| Question | Decision |
|---|---|
| Passwords | **Password first, code as backup.** New accounts set a password. "Email me a code instead" stays, both as a fallback and as the forgot-password route. Existing shoppers keep using codes until they set a password. |
| Sellers | **New sellers apply; existing sellers keep their login.** The path is: shopper account → apply to open a store → an admin approves → the store opens. Existing stores and their usernames and passwords are unchanged. |
| Facebook | **Built, but off until set up.** The button is hidden and the server refuses Facebook until the App ID and secret exist. |
| Buyer phone | **Delivery only.** Required for truck, ship and air cargo. Optional for Pick up & pay. |

## 1. Architecture summary

```
Browser (GitHub Pages, vanilla JS)            Apps Script (Code.gs doPost - ONE dispatcher)
---------------------------------            ---------------------------------------------
customer-login.html / customer-login.js  -->  Customers.gs        passwords, codes, links, sessions
google-signin.js  (Google Identity)      -->  CustomerOAuth.gs    verify Google ID token (aud/iss/exp/sub/email_verified)
facebook-signin.js (Meta SDK, lazy)      -->  FacebookAuth.gs     debug_token + /me with appsecret_proof
                                              CustomerIdentities.gs  ProviderIdentities: link rules, no auto-merge
customer-dashboard.html + customer-security.js  sign-in methods, link/unlink, confirm email, sign out everywhere
owner/login.html (Register Store tab)    -->  Auth.gs actionRegisterOwner = a seller APPLICATION
owner/admin.html + admin-seller-apps.js  -->  SellerApplications.gs  admin-only approve/reject/suspend/reinstate
                                              Passwords.gs        PBKDF2-HMAC-SHA256 for sellers + shoppers
```

**Shopper accounts**

- A shopper signs in with one of: an email and password; a 6-digit code
  emailed to them; a one-time link in that email; Google; or Facebook.
- Shopper sessions are bearer tokens kept in `localStorage`, as before.
  Cookies cannot be used, because the backend is on another domain
  (`script.google.com`).
- The server stores only a hash of each session token.

**Identities**

- Google and Facebook identities are separate rows in `ProviderIdentities`,
  keyed by the provider's user id. Email is never used to match.
- If a provider's email matches an existing account, nothing is merged
  automatically. The shopper first proves that account (password or code)
  while holding a short-lived `providerLinkToken`. Only then is the identity
  linked, and only to that account.

**Email trust**

- Google's email counts as confirmed, because Google's checked
  `email_verified` claim says so.
- Facebook's email does **not** count as confirmed. It waits in
  `PendingEmail` until Mwakete's own code confirms it. Until then the account
  can browse but cannot order, book or message.

**Sellers**

- A seller is still an `Owners` row with its own username and password, and
  optional 2FA.
- New rows carry `ApprovalStatus` and the `CustomerId` of the shopper account
  that applied.
- `ownerCanLogIn` and `isStoreBrowsable` both require approval. A blank
  status counts as approved, which covers every existing store.
- The store email is always the shopper account's **confirmed** email. That
  also closes an old hole: anyone could register a store under an unused
  `ADMIN_EMAILS` address and become an admin.

## 2. Files changed

**Backend (Apps Script)**

| File | What changed |
|---|---|
| `apps-script/Passwords.gs` | **New.** PBKDF2 hashing, verification, upgrade-on-login, password policy and a benchmark. |
| `apps-script/Customers.gs` | Rewritten top half: passwords, hashed codes and link tokens, hashed sessions, non-enumerating replies, resend cooldown, reset, sign out everywhere, suspension, the `AuthEvents` log. The phone rule for editing an order. |
| `apps-script/CustomerIdentities.gs` | **New.** `ProviderIdentities`, the link rules, and unlink. |
| `apps-script/CustomerOAuth.gs` | Requires `sub`; goes through `resolveProviderSignIn`. |
| `apps-script/FacebookAuth.gs` | **New.** Checks Facebook tokens and fails closed. |
| `apps-script/SellerApplications.gs` | **New.** Application view, emails, and admin review. |
| `apps-script/Auth.gs` | Seller login uses `verifyPassword` with a silent rehash; approval gates; registration becomes an application. |
| `apps-script/Products.gs` | Seller password change uses PBKDF2. |
| `apps-script/Orders.gs` | Phone is optional only for `pickPay`. |
| `apps-script/Utils.gs` | 6-digit codes come from a secure source. |
| `apps-script/Code.gs` | New actions routed; `APP_VERSION = 'auth1-2026-10-23'`. |

**Frontend**

| File | What changed |
|---|---|
| `customer-login.html`, `assets/js/customer-login.js` | Password with Show/Hide, "Forgot password?", "Email me a code instead", resend cooldown, the confirm (`?verify=`) and reset (`?reset=`) links, the link-required note, and the Facebook button. |
| `assets/js/google-signin.js` | Shared `handleProviderResult` and `providerSignInBody` (link mode). |
| `assets/js/facebook-signin.js` | **New.** Lazy-loads Meta's SDK; hidden unless `FACEBOOK_APP_ID` is set. |
| `assets/js/config.js` | `FACEBOOK_APP_ID: ''`. |
| `customer-dashboard.html`, `assets/js/customer-security.js` | **New** sections: confirm email, sign-in methods (set or change password, link or unlink Google and Facebook), sign out of all devices, and seller application status. Phone is optional in the profile. |
| `assets/js/customer-auth.js`, `assets/js/customer-dashboard.js` | Small changes to support the above. |
| `owner/login.html`, `assets/js/owner-login.js` | The Register Store tab is now an application. It needs a signed-in shopper, adds "What will you sell?", and ends on "Application sent". |
| `owner/admin.html`, `assets/js/admin-seller-apps.js` (**new**), `assets/js/admin.js` | Seller applications queue. |
| `checkout.html`, `assets/js/checkout.js` | Phone is required or optional depending on the delivery method, with the reason shown. |
| `privacy.html` (DRAFT additions), `data-deletion.html` (**new**, DRAFT) | Wording for passwords, Facebook sign-in and data deletion. |
| `assets/css/styles.css` | Styles for the new pieces. |
| `sw.js` | `CACHE` bumped to `mwakete-v193`; new scripts precached. |

**Tests**

- New: `tests/test-passwords.js`, `tests/test-auth.js`.
- Updated: `tests/verify-custauth.js`, `tests/test-guest-viewer.js`,
  `tests/test-hints-messages.js`, `tests/test-storeopen.js`,
  `tests/test-store-search.js`, `tests/test-meetings.js`,
  `tests/test-emailchange.js`, `tests/lib/gas-harness.js`, and the browser
  tests listed in section 9.

**Docs:** this file and `docs/auth-meta-setup.md`.

## 3. Implementation

### Passwords

**Hashing (`Passwords.gs`)**

- Hashes use PBKDF2-HMAC-SHA256, built exactly to RFC 8018 on top of Apps
  Script's own HMAC.
- The `PEPPER` is mixed in with an HMAC before stretching. A copy of the sheet
  alone therefore cannot be used to check guesses.
- Stored form: `pbkdf2$sha256$<rounds>$<salt>$<hash>`. The default is 4,000
  rounds, which can be changed with `PASSWORD_ITERATIONS` (allowed range
  1,000–200,000).
- Old seller hashes (a single SHA-256 with salt and pepper) still verify. On
  a seller's next successful login the hash is silently upgraded.
- Comparisons are constant-time.
- A login for an unknown account does the same amount of work as a real one
  (`burnPasswordCheck`).

**Rules**

- Minimum 8 characters, maximum 200.
- The seller's existing password-hint rules are unchanged.

### Shopper flows (all in `Customers.gs`, all public actions doing their own authentication)

| Action | Behaviour |
|---|---|
| `registerCustomer` | Name, email and password; phone is optional. Emails a code plus a confirm link. **Same reply whether the email is new or taken.** If it is taken, the owner of that address gets an "you already have an account" email instead of a code. |
| `verifyCustomerEmail` | Takes a typed code, or `linkToken` from the email link. Creates the confirmed account and signs in. |
| `customerPasswordLogin` | Always replies "Email or password is incorrect" on failure. Lockout is keyed on `cust:<email>`, using the seller lockout mechanism. Upgrades old hashes. |
| `loginCustomer` / `verifyCustomerLogin` | "Email me a code". Non-enumerating: an unknown address gets a short "no account" note instead of a code. |
| `requestCustomerPasswordReset` / `resetCustomerPassword` | Works by code, or by the link in the email. A reset revokes **all** sessions, then signs in this device. |
| `checkCustomerLink` | Checks a reset link before showing the form, without using it up. |
| `resendCustomerCode` | 60-second cooldown per request, plus the existing per-email send limit. |
| `requestCustomerEmailVerification` | For accounts whose email is not confirmed yet (Facebook). |
| `logoutAllCustomerSessions` | "Sign out of all devices". |
| `unlinkProvider` | Always keeps at least one way to sign in. |
| `getSellerApplication` | The shopper's seller application status, for My Account. |

**Tokens**

- Codes, link tokens and session tokens are stored only as `h1:` + SHA-256.
  Rows written before this change still match.
- The pending provider link is cached under `providerlink:` + hash, expires
  after 15 minutes, and can be used once.
- On the browser side, the inline head script removes `?verify=` and
  `?reset=` from the address bar **before anything else runs**, and the page
  sends `Referrer-Policy: no-referrer`.

**Account states**

- `Customers.Status = suspended`: every signed-in call is refused, and the
  shopper cannot sign in.
- `EmailVerified = 'false'`: the shopper can browse their profile but cannot
  order, book or message (`VERIFY_EMAIL_FIRST`). Only an explicit `'false'`
  blocks. Every existing row is unaffected.

### Google and Facebook

**Rules (`CustomerIdentities.gs` header)**

1. An identity seen before signs in to its account.
2. A matching email means **link required**: the shopper proves the account
   first.
3. Linking from the account page attaches the identity to the signed-in
   account.
4. Otherwise a new account is made. Google's email is confirmed; Facebook's
   email is pending.
5. Unlinking always leaves a way back in.
6. These identities never grant seller or admin rights.

**Facebook token check (`FacebookAuth.gs`)**

- `debug_token` must report `is_valid`, our `app_id`, type `USER`, a
  `user_id`, and a future `expires_at`.
- `/me` is then called with `appsecret_proof`, and its `id` must match.
- Rate limits: 300 checks per 15 minutes across the site, and 10 per user.

### Sellers (`Auth.gs` and `SellerApplications.gs`)

**Applying**

- `registerOwner` needs `customerToken`, from a shopper account with a
  confirmed email. Otherwise it returns `customerAccountRequired`.
- New required field: `about` ("What will you sell?").
- The store email is taken from the shopper account.
- A store is created `pending`, with no session. The applicant and the admins
  are emailed.
- One application per shopper account. A rejected applicant can apply again;
  the same row is reused.
- An applicant whose confirmed email is in `ADMIN_EMAILS` is approved at once
  (the first admin has nobody to approve them).

**Login**

- A pending, rejected or suspended store gets a clear message, but only after
  the correct password.

**Admin review**

- `adminListSellerApplications` and `adminReviewSellerApplication`
  (approve | reject | suspend | reinstate). Each call checks `isOwnerAdmin` on
  the server.
- Rejecting or suspending requires a reason, which is emailed to the seller.
- Suspending revokes the store's sessions.
- An admin store cannot be suspended or rejected.
- Every decision is logged to `AuthEvents`.

### Checkout

The phone is required unless the delivery method is `pickPay`. This applies
both in the browser and on the server (`Orders.gs`, and edits through
`updateCustomerOrder`). The seller's order email says
"(not given - Pick up & pay)" when there is no phone.

## 4. Schema changes (all additive — created automatically on first use)

| Sheet | Change |
|---|---|
| `Customers` | + `PasswordHash`, `PendingEmail`, `AuthProvider` (added by code via `ensureColumn`). `Status` is read if present; add the header by hand if you want to suspend shoppers. |
| `CustomerSessions` | No new columns. New tokens are stored as `h1:<sha256>`; old raw tokens still work until they expire. |
| `CustomerCodes` | + `PasswordHash`, `LinkHash`, `CustomerId`. `Token` is stored hashed. |
| `Owners` | + `ApprovalStatus`, `CustomerId`, `AppliedAt`, `ReviewedAt`, `ReviewedBy`, `ReviewNote`, `ApplicationNote`. |
| `ProviderIdentities` | **New sheet**: `CustomerId`, `Provider`, `ProviderUserId` (`id:` + id, so long numbers are never rounded), `Email`, `CreatedAt`, `LastUsedAt`. |
| `AuthEvents` | **New sheet**: `At`, `Event`, `SubjectId`, `Detail`. Never stores a password, code or token. |

Nothing is renamed, reordered or deleted. Existing values are never rewritten
in bulk.

## 5. Migration procedure

1. **Back up first:** in the Mwakete spreadsheet, File → Make a copy. Name it
   `Mwakete backup before auth1 (2026-10-23)`.
2. Deploy the backend (section 8). No migration script is needed:
   - Columns and sheets appear the first time they are used.
   - Existing stores read as approved.
   - Existing shoppers keep signing in with codes, and can set a password
     from My Account → Sign-in & security, or with "Forgot password?".
   - Shoppers who already used Google keep signing in. Their `GoogleSub` is
     copied into `ProviderIdentities` the first time they use it. The
     `GoogleSub` column is left in place.
   - Seller hashes upgrade silently as each seller logs in.
3. Optional: add a `Status` header to `Customers` if you ever need to suspend
   a shopper. Type `suspended` in that shopper's row.

## 6. Script Properties

| Property | Required? | Notes |
|---|---|---|
| `PEPPER` | **Yes (already set)** | Never change it: every password depends on it. |
| `SITE_BASE_URL` | Strongly recommended (likely already set) | `https://mwakete.com`. Without it, emails carry codes but no links. |
| `ADMIN_EMAILS` | Already set | Who may review seller applications. |
| `GOOGLE_CLIENT_ID` | Already set | Unchanged. |
| `PASSWORD_ITERATIONS` | Optional | Default 4000. Run `benchmarkPasswordHashing()` from the editor and pick the largest value that keeps a sign-in under about 1 second. |
| `FACEBOOK_APP_ID` | For Facebook | Public. Also goes in `config.js`. |
| `FACEBOOK_APP_SECRET` | For Facebook | **Private.** Script Properties only. |
| `FACEBOOK_GRAPH_VERSION` | Optional | e.g. `v23.0`. |

## 7. Meta and Google setup

See [auth-meta-setup.md](auth-meta-setup.md). These steps are for the owner.
Nothing in them costs money.

## 8. Deployment instructions

Claude cannot deploy Apps Script from its sandbox. These steps are manual.

1. Make the spreadsheet backup (section 5).
2. Open the Apps Script project:
   - **New files** — add each one exactly as it is in the repository:
     `Passwords.gs`, `CustomerIdentities.gs`, `FacebookAuth.gs`,
     `SellerApplications.gs`.
   - **Changed files** — replace these with the repository versions:
     `Customers.gs`, `CustomerOAuth.gs`, `Auth.gs`, `Products.gs`,
     `Orders.gs`, `Utils.gs`, `Code.gs`.
3. Save. Then go to **Deploy → Manage deployments**, edit the existing web
   app deployment, set **Version: New version**, and click **Deploy**. Keep
   the same `/exec` URL.
4. Check the deployment by opening
   `https://script.google.com/macros/s/AKfycby70Y4gCJtA5g2-4hKjdKoAxSJG22T0Tm_9bgup4fmPyid8YVdoYr23BbkB6Nh-kaSn/exec?action=getVersion`.
   It must answer `"version":"auth1-2026-10-23"`.
5. Merge the frontend PR. GitHub Pages publishes it. Phones pick it up through
   the service worker (`mwakete-v193`).
6. Smoke test as in section 13. A new store must be approved from
   **owner/admin.html → Seller applications**.

**Order matters:** deploy the backend before, or at the same moment as,
merging the frontend. The new sign-in page calls actions that the old backend
does not know (`customerPasswordLogin` and others).

## 9. Test results

- Backend: every `tests/test-*.js` runs the real `.gs` files in the harness.
- Browser: Playwright against a local server, with the Apps Script calls
  mocked.

New and updated tests:

| Test | Result | Covers |
|---|---|---|
| `test-passwords.js` | 24/24 | RFC 7914 vectors (1 and 80,000 rounds); matches Node's `pbkdf2Sync`; pepper; round-count limits; legacy hashes; rehash; policy; codes |
| `test-auth.js` | 69/69 | Sign-up, code and link confirmation, hashed storage, resend cooldown, enumeration (sign-up, codes, reset), password login and lockout, reset by link (single use, revokes sessions), suspension, sign out everywhere, Google legacy and link-required and new accounts, Facebook (fails closed, wrong app, invalid, expired, PAGE token, id mismatch, unconfirmed email, appsecret_proof, link-required), seller applications (needs an account, pending, store email from the account, no login, hidden, non-admin refused, admin auto-approve, approve, reject needs a reason, suspend revokes sessions, admin store protected, reinstate, audit log without secrets) |
| `test-guest-viewer.js` | 23/23 | + a delivery order needs a phone; Pick up & pay does not |
| `verify-custauth.js` (browser) | 33/33 | Password sign-in, Show/Hide, ready-reveal, code fallback, forgot password (code and link), token removed from the URL, no-referrer, confirm link, link-required, no Facebook button while unset |

**Full-suite result:** see the PR description, which has the final counts
from the full run.

**Not tested end to end, and why:**

- Real Google and Facebook tokens, real email delivery, and the live Apps
  Script deployment. These cannot be reached from the sandbox.
- The Facebook flow is tested against a faithful stub of Meta's documented
  responses, not against Meta itself. **Do not treat Facebook sign-in as
  working until the step 5 tests in `auth-meta-setup.md` pass.**

## 10. Security review

**Fixed or added**

- **Admin takeover hole closed.** Before this change, registering a store
  with an unused `ADMIN_EMAILS` address granted admin rights. The store email
  now comes only from a confirmed shopper account.
- **Password storage.** PBKDF2 with salt and pepper, upgraded on login. Before
  this, a seller password was a single SHA-256.
- **Secrets at rest.** Session tokens, codes and link tokens are stored
  hashed, so a leaked sheet does not contain live tokens.
- **No account enumeration** on shopper sign-up, code sign-in and reset.
  Password sign-in gives one generic error. Seller registration must still
  say "username taken", as before.
- **Brute force.** Per-email password lockout; code attempt limit (existing);
  per-email send limit; 60-second resend cooldown; Facebook rate limits.
- **No automatic account merge by email.** An attacker with a Facebook
  account that claims someone's email cannot take over that person's
  Mwakete account.
- **Facebook token audience** is checked (`app_id`), as Google's `aud` is.
  The secret stays server-side; requests use `appsecret_proof`.
- **Seller approval is enforced on the server,** in `ownerCanLogIn`,
  `requireAuth` and `isStoreBrowsable`, not only in the UI. Admin actions
  check `isOwnerAdmin` on the server.
- **Links.** Tokens are removed from the URL before scripts run, and the page
  uses `no-referrer`.
- **Logs** (`AuthEvents`, `Logger`) never contain passwords, codes or tokens.
  Facebook network errors do not log the URL.

**Known limits, stated honestly**

- 4,000 PBKDF2 rounds is far below a dedicated server's 600,000, because Apps
  Script is slow. The pepper and the adjustable round count make up part of
  the gap. Raise `PASSWORD_ITERATIONS` after benchmarking.
- Sessions are bearer tokens in `localStorage`, unchanged from before. A
  cross-site scripting bug would expose them. The site uses `textContent` and
  `escapeHtml`, but this is still a risk.
- Old raw shopper session tokens stay valid until they expire (at most 60
  days). After that, every session is hashed.
- Seller (`Sessions`) tokens are still stored raw. This is not changed here,
  to keep the change small. Recommended as a follow-up.
- Until an old seller hash is upgraded, a wrong-password check on it takes
  less time than a PBKDF2 check. That difference leaks only that the account
  is a legacy one.
- Shopper suspension is a manual sheet edit (`Customers.Status`). There is no
  admin UI for it yet.

## 11. External human tasks (owner)

1. Back up the spreadsheet, deploy the backend, and run the `?action=getVersion`
   check (sections 5 and 8).
2. Review the DRAFT wording in `privacy.html` and `data-deletion.html`. Both
   promise deletion by email within 30 days, so someone must handle those
   emails.
3. Facebook: create the Meta app, set the Script Properties and the
   `config.js` id, and test (`auth-meta-setup.md`). Until then, Facebook stays
   off.
4. Optional: run `benchmarkPasswordHashing()` and set `PASSWORD_ITERATIONS`.
5. Approve new seller applications in owner/admin.html, ideally within 2
   working days (the form promises this).

## 12. Rollback plan

**Backend**

- Manage deployments → edit → choose the previous version → Deploy.
- `?action=getVersion` then returns `pos1-2026-10-22`.

**Frontend**

- Revert the PR on `main`. The service worker cache name changes again on the
  revert.

**Data left behind is harmless to the old code** (it ignores the extra columns
and sheets), with two exceptions to handle before rolling back:

1. **Pending, rejected or suspended stores.** The old code has no approval
   check, so these would become live. Before rolling back, filter `Owners` by
   `ApprovalStatus` and set `Status` to `closed` on every row that is not
   `approved` or blank.
2. **Sellers whose password was upgraded to PBKDF2.** This covers any seller
   who logged in, registered or changed their password after the deploy. The
   old code cannot check those hashes, so those sellers would need "Forgot
   password?" on the seller login. That flow writes an old-style hash and
   works.

Shoppers lose nothing: code sign-in works in both versions. Passwords simply
stop being used.

## 13. Acceptance checklist

- [ ] `?action=getVersion` → `auth1-2026-10-23`
- [ ] New shopper: Create Account with a password → code email arrives (code
      and link) → confirmed → My Account
- [ ] Same email again on Create Account → the same "check your email" screen;
      the inbox gets "You already have a Mwakete account"
- [ ] Sign in with the password; a wrong password says "Email or password is
      incorrect"
- [ ] "Email me a code instead" signs in
- [ ] "Forgot password?" by link → new password works; signed out on the other
      device
- [ ] Existing Google shopper still signs in with Google
- [ ] Google with the email of an existing password account → asked to sign
      in once → then Google is linked (My Account shows Google: On)
- [ ] My Account: set or change the password, unlink and link Google, sign out
      of all devices
- [ ] Existing seller logs in exactly as before
- [ ] New seller: Register Store needs a shopper sign-in → apply → "Application
      sent" → cannot log in yet → the admin sees it under Seller applications
      → Approve → the seller logs in and the store is visible
- [ ] Admin: reject needs a reason; suspend signs the seller out and hides the
      store; reinstate brings it back
- [ ] Checkout: truck, ship or air cargo without a phone → refused with the
      reason; Pick up & pay without a phone → order placed
- [ ] Facebook button not shown (until set up)

## 14. Not implemented, and why

- **Facebook sign-in is not live.** It needs the owner to create the Meta app,
  which is a commitment made in Mwakete's name. The code is ready and fails
  closed.
- **Admin UI to suspend shoppers.** Shopper suspension works on the server
  (`Customers.Status`) but is set by hand in the sheet. It was left out to
  keep this change smaller.
- **Account self-deletion button.** Deletion is by email request
  (`data-deletion.html`). An automated delete would need decisions about
  order records sellers still need.
- **Hashing seller (`Sessions`) tokens.** Left as is to avoid touching every
  seller session in one release. Recommended next.
- **Phone verification by SMS.** It would need a paid SMS provider, and per
  the standing rules anything with a cost needs approval first. Phones are
  format-checked only, as before.
