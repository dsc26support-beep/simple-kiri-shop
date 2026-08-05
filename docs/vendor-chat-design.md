# Vendor-Specific Live Chat — Technical Design

**Status: draft, awaiting approval. No code has been written for this feature.**

This document designs a chat feature letting a customer message the specific vendor
whose store they're browsing, and letting that vendor reply from their dashboard. It
follows the conventions already established in [`docs/architecture.md`](./architecture.md)
and builds on two patterns already designed this session (the `Utils.gs` `getCached`/
`invalidateCache` layer and the not-yet-implemented `paginate()` helper) rather than
inventing new ones.

## 0. Constraints this design has to work within

These come directly from the existing architecture and shape every decision below:

- **No real server, no websockets, no SSE.** Apps Script Web Apps are stateless
  request/response only (`doGet`/`doPost`) — there is no way to push a message to an
  open browser tab. "Live" here means **polling**, not a true push channel.
- **Customers have no accounts.** There is no login, no verified identity, no
  session token for a customer — only `localStorage` on their device (see the cart's
  `skiri_cart_<slug>` pattern). Chat has to work within that same anonymous model.
- **Sheets-as-database, header-mapped, no indexed queries.** Every read is a full
  `sheetToObjects()` scan of a tab (`Db.gs`) — a "since timestamp" filter still costs
  a full-tab read server-side; it only shrinks the *response payload*, not the scan.
  Polling is a fundamentally more read-heavy pattern than the rest of this app's
  one-shot page loads, so this constraint matters more here than anywhere else in
  the codebase — see Section 10.
- **`MailApp` quota (~100 emails/day)** is already shared by 2FA, password resets,
  and the hourly reminder sweep — chat notifications have to be conservative with it.
- **Vendors already have real auth** (`requireAuth(token)`, ownership checks on every
  row) — the vendor side of this feature slots directly into that existing model.

## 1. Conversation model

A conversation is scoped to **(store, one anonymous customer)** — one thread per
customer per store, same "one vendor at a time" boundary the cart already enforces
(`skiri_cart_<slug>` is per-store; chat follows the identical shape).

**Identity, since customers have no account:** the first time a customer opens the
chat widget on a store, the client generates an opaque token
(`crypto.randomUUID()`, or `Utilities.getUuid()` if issued server-side on first
send — client-generated is simpler and avoids an extra round trip) and stores it in
`localStorage` as `skiri_chat_token_<slug>`, exactly mirroring the existing
`skiri_cart_<slug>` per-store-key convention. Returning to the same store in the same
browser resumes the same thread. A different browser, or clearing site data, starts
a new thread — the same accepted trade-off already made for cart/view-tracking
dedup elsewhere in this app (not tamper-proof, just a reasonable, low-friction
identity signal at this scale).

**Lifecycle:** created implicitly on the customer's first message (no separate
"start conversation" step — see API design in Section 4). A vendor can mark a
conversation `closed`; if the customer sends another message afterward, it
reopens automatically to `open`. No hard deletion — matches every other soft-delete
pattern in this codebase (archived products, deleted variants, closed stores).

**One thread, not a mailbox of topics.** A given (store, customer) pair has at most
one conversation — simplest possible model, matches the checkout/cart pattern of
"one vendor relationship at a time," and avoids needing a conversation-picker UI on
the customer side.

## 2. Message model

Messages are **append-only and immutable** — no edit, no delete. This sidesteps an
entire class of polling-consistency problems (what does another party's poll do
with an edited message it already rendered?) and matches the audit-friendly,
snapshot-style pattern already used for `Orders.ItemsJson`.

Each message belongs to exactly one conversation, has a sender side
(`customer` or `vendor` — no need for a sender name/ID beyond that, since each side
of a conversation is unambiguous), a plain-text body, and a timestamp. Message
bodies are rendered through the existing `escapeHtml()` helper (`helpers.js`) on
every render path — this is the first genuinely free-text, fully user-generated
content channel added to the frontend, so this matters more here than for the
mostly-structured data (names, addresses) escaped elsewhere today.

## 3. Database tables

Two new Sheet tabs, following `Db.gs`'s existing header-mapped convention — no code
anywhere hardcodes a column index, so these are just new tabs with a header row.

### `Conversations`

```
ConversationId | OwnerId | StoreSlug | CustomerToken | CustomerName | Status |
CreatedAt | UpdatedAt | LastMessageAt | LastMessagePreview | LastSenderType |
UnreadByVendor | UnreadByCustomer
```

- `CustomerToken` — the opaque per-browser identifier from Section 1. Combined with
  `StoreSlug`, this is effectively the customer's "credential" for this thread (see
  Section 5).
- `CustomerName` — optional, free-text, filled in the first time the customer sends
  a message (a simple name field on the chat widget, not a real identity).
- `Status` — `open` / `closed`, per Section 1.
- `LastMessageAt` / `LastMessagePreview` / `LastSenderType` — denormalized onto the
  conversation row so the vendor's inbox list (`listOwnerConversations`, Section 4)
  never needs to touch the `Messages` tab at all — same "denormalized counter"
  reasoning already used for `Products.Views`/`Owners.Visits` rather than deriving
  them from a live scan every request.
- `UnreadByVendor` / `UnreadByCustomer` — boolean flags (or small integers if an
  unread *count* is wanted later), same denormalization reasoning: cheap badge
  rendering without scanning `Messages`.

### `Messages`

```
MessageId | ConversationId | OwnerId | StoreSlug | SenderType | Body | CreatedAt
```

- `OwnerId`/`StoreSlug` are duplicated onto every message row even though they're
  derivable via `ConversationId` — this isn't new to this feature: `Variants`
  already carries `OwnerId` directly despite being derivable via `ProductId`, for
  the same reason (avoids a join just to filter/authorize a scan).

No `README.md`/Sheet-schema change is needed beyond adding these two tabs with their
header rows, matching how every prior schema addition in this project has shipped.

## 4. API endpoints

Follows the existing action-name/GET-vs-POST/public-vs-protected conventions in
`Code.gs` exactly — no new transport pattern. New backend file `apps-script/Chat.gs`,
matching the existing one-file-per-domain layout (`Auth.gs`, `Products.gs`,
`Orders.gs`, `Images.gs`, `Reminders.gs`).

### Public (customer side — unauthenticated by token, scoped by `customerToken`)

| `action` | Method | Params/body | Behavior |
|---|---|---|---|
| `sendChatMessage` | POST | `storeSlug, customerToken, customerName?, body` | Finds the `(StoreSlug, CustomerToken)` conversation or creates one (`LockService`-guarded, same pattern as `actionCreateOrder`); appends a `Messages` row; updates the conversation's `LastMessageAt`/`LastMessagePreview`/`LastSenderType`/`UnreadByVendor=true`. Returns `{conversationId, messageId, createdAt}`. |
| `getChatMessages` | GET | `storeSlug, customerToken, sinceMessageId?` | Looks up the conversation for this token; if none exists yet, returns an empty/"no conversation" state (not an error — a customer who hasn't sent a first message yet still polls this to render the widget's initial state). Returns messages after `sinceMessageId` (or all, capped, if omitted) plus `status`. Marks `UnreadByCustomer=false`. |

### Protected (vendor side — `requireAuth(token)`, ownership-checked)

| `action` | Method | Params/body | Behavior |
|---|---|---|---|
| `listOwnerConversations` | POST | `token, limit?, offset?` | Returns this owner's conversations sorted by `LastMessageAt` desc, using the same `paginate()` helper designed for the pagination-fix plan (`{items, total, hasMore}`) rather than a bespoke pattern — this list has the identical unbounded-growth shape already flagged for `listStores`/`listOwnerOrders`. |
| `getOwnerConversationMessages` | POST | `token, conversationId, sinceMessageId?` | Ownership-checked (`conversation.OwnerId === owner.OwnerId`, same check as every other owned-row action). Returns messages after the cursor. Marks `UnreadByVendor=false`. |
| `sendOwnerChatMessage` | POST | `token, conversationId, body` | Ownership-checked; appends a message; updates `LastMessage*`/`UnreadByCustomer=true`; reopens the conversation if it was `closed`. |
| `closeChatConversation` | POST | `token, conversationId` | Ownership-checked; sets `Status: closed`. |

Every append (`sendChatMessage`, `sendOwnerChatMessage`) takes `LockService.getScriptLock()`
around the find-or-create-conversation-and-update-denorm-fields sequence — exactly
the same race-condition guard already used around every other multi-step Sheet write
in this codebase (`actionCreateOrder`, `actionRecordProductViews`, etc.).

## 5. Security

- **The `customerToken` is the entire security boundary on the customer side** —
  there is no password, no email verification behind it. This is a deliberate
  continuation of this app's existing anonymous-customer model (the same is true of
  the cart and view-tracking today), not a new weakness introduced by chat. It is
  called out explicitly here because chat is a *two-way, real-time* channel, which
  raises the stakes of that model more than a write-only view counter did:
  - Tokens are generated with `crypto.randomUUID()` (122 bits of entropy) — not
    guessable by brute force.
  - The token must never be echoed back to a *different* conversation, never listed,
    never enumerable via any endpoint.
  - Always sent over HTTPS, exactly like every other value in this app's requests.
- **Vendor side reuses the existing auth stack exactly**: `requireAuth(body.token)`
  gates every protected chat action, and every handler that touches a specific
  `conversationId` independently re-checks `conversation.OwnerId === owner.OwnerId`
  before reading or writing it — the same pattern already proven across
  `actionUpdateOrderStatus`, `actionDeleteProduct`, `actionUploadProductImage`, etc.
- **XSS**: message bodies are the first fully free-text, fully user-generated
  content in this app's data model (names/addresses are free-text too, but
  low-incentive targets; a public chat channel is a much more natural injection
  target). Every render path — customer widget and vendor inbox — must run message
  `body` through `escapeHtml()` (`helpers.js`) before inserting into the DOM. No
  `innerHTML` of raw message content, ever.
- **Abuse/spam throttling**: Apps Script has no built-in per-IP or per-token rate
  limit. Proposed minimal guard for v1 (consistent with this app's "pragmatic, not
  bulletproof" security posture — salted SHA-256 instead of bcrypt, etc.): reject
  `sendChatMessage`/`sendOwnerChatMessage` if the conversation's `LastMessageAt` is
  under ~1–2 seconds old, a cheap check against a runaway client bug or naive spam
  script. A real rate limiter (per-token request counting) is listed under Section
  10 as a future item if abuse actually becomes a problem.
- **Message length cap** (e.g. 2000 characters), enforced server-side, to bound
  Sheet cell size and payload size — mirrors the existing 5MB image-upload cap
  (`MAX_IMAGE_BYTES` in `Images.gs`) as the precedent for "cap it server-side, don't
  just trust the client's form to enforce it."

## 6. Permissions

| Actor | Can | Cannot |
|---|---|---|
| Customer | Read/write the *one* conversation tied to their own `(storeSlug, customerToken)` | List any other conversation; see any other customer's thread; act on a different store's conversation |
| Vendor | Read/write any conversation where `OwnerId` matches their own authenticated owner | Read/write another store's conversations (enforced by the same ownership check used everywhere else) |
| Admin | None in-app — matches the "no admin panel" finding in `docs/architecture.md` §10 | If moderation is ever needed, it is manual Sheet access to the `Conversations`/`Messages` tabs, same as every other manual-admin operation documented there — not a new in-app role |

## 7. Polling strategy

The single hardest constraint in this design: there is no push channel, and every
poll costs a full-tab Sheet scan server-side (Section 0). The strategy below is
built to keep that cost bounded and to be honest that this is the feature's real
scalability ceiling (Section 10), not to pretend polling is free.

- **Poll only while the chat UI is actually open.** No background polling on pages
  where the chat widget/panel is collapsed — matches this app's existing "don't do
  work the customer didn't ask for" bias (e.g., lazy-loaded images, fire-and-forget
  tracking calls).
- **Page Visibility API.** Pause polling entirely when
  `document.visibilityState !== 'visible'` (tab backgrounded, phone locked, app
  switched away) — resume immediately on `visibilitychange` back to visible. This
  matters more here than anywhere else in the app given the mobile, data-cost-aware
  audience already reflected in decisions like client-side image compression before
  upload.
- **Adaptive interval with backoff:** start at ~3s while the panel is open and
  actively exchanging messages; back off geometrically (3s → 5s → 10s → cap at 30s)
  after each poll that returns zero new messages; reset immediately to 3s the
  moment a new message arrives (from either poll direction) or the local user sends
  one. This keeps an idle-but-open conversation cheap while staying responsive
  during an actual back-and-forth.
- **Incremental fetch via `sinceMessageId`.** Every poll after the first passes the
  last-seen message ID, so the response only contains new messages — this bounds
  *payload size and client render cost* to the delta, though (per Section 0) it does
  **not** reduce the server-side Sheet-scan cost under the current `Db.gs` model.
  That asymmetry is the feature's core scaling risk — see Section 10.
- **Vendor-side badge polling is separate and much slower**: while the vendor is
  *not* in the messages view (e.g., on `owner/dashboard.html` or elsewhere in the
  dashboard), a lightweight, infrequent poll (e.g., every 60s) just checks for any
  `UnreadByVendor` conversation to drive a nav badge — never the full message-fetch
  polling loop, which only runs inside the actual conversation view.

## 8. Notifications

No true push is possible from this stack (Section 0), so notification design is
about in-page signals plus the existing email channel, not a new infrastructure
layer:

- **In-page unread badges**, driven by the slow background poll from Section 7:
  a badge on the floating chat button (customer side) and a badge on the owner
  dashboard's nav (vendor side, next to a new "Messages" link).
- **Email, reused from the existing `sendAppEmail` helper (`Utils.gs`)** — the same
  function already used for 2FA codes, password resets, and the reminder sweep.
  Given the shared ~100/day `MailApp` quota already flagged as a constraint, chat
  emails must be conservative:
  - Email the vendor once per conversation when it's **first created** (a new
    customer started chatting) — not on every message.
  - For an *ongoing* conversation the vendor hasn't checked in a while, fold a
    "you have unread chat messages" line into the existing hourly
    `runReminderSweep` digest (`Reminders.gs`) rather than adding a second,
    independent per-message email trigger — reuses infrastructure that's already
    running instead of adding a new one.
  - No email to the customer at all in v1 — the customer only has a browser tab,
    not a verified email (their `customerName` field is optional free text, not a
    contact address), so there's nothing reliable to email them at.
- **Browser Web Push** (real OS-level push notifications) is technically possible
  for a static site via a service worker + the Push API, but requires a push
  delivery service Apps Script cannot provide on its own — this is listed under
  Section 10 as a deferred, larger architectural addition, not part of v1.

## 9. Mobile support

- The chat widget follows the site's existing floating-action-button pattern
  (`.floating-action-btn` in `styles.css`, already used for the cart/continue-
  shopping/back-to-cart buttons) — a floating button that opens a slide-up panel,
  not a separate page navigation away from product browsing. This keeps chat
  consistent with the rest of the mobile-first UI rather than introducing a new
  interaction pattern.
- Page Visibility-aware polling (Section 7) is the main mobile-specific concern:
  without it, a chat panel left open in a backgrounded tab would silently drain
  battery and mobile data indefinitely.
- The vendor's new `owner/messages.html` page reuses `owner.css`'s existing
  responsive dashboard layout — no new stylesheet needed.
- **No native app exists today**, and this design doesn't require one — "mobile
  support" here means a responsive web widget with visibility-aware polling, not
  native push. A future PWA manifest + service worker (not present in the repo
  today, confirmed in `docs/architecture.md`'s folder structure) would be a
  prerequisite for real Web Push and is listed under Section 10 as a bigger,
  separate future step, not required to ship v1 chat.

## 10. Future scalability

Ordered roughly by "how soon this would actually bite":

1. **The polling-cost/Sheets-scan mismatch is the feature's real ceiling.** Every
   poll — customer or vendor — still costs a full `Messages`-tab scan server-side
   even with a `sinceMessageId` cursor narrowing the *response* (Section 0/7). This
   is a fundamentally more continuous read load than the rest of the app's one-shot
   page loads, and will hit Apps Script's daily execution/quota ceilings sooner
   than any other part of the system as chat adoption grows. Natural next steps, in
   order of effort:
   - Add a `getCached`/`invalidateCache`-style short-TTL cache (`Utils.gs`) for
     "recent messages in conversation X," invalidated on new message — same pattern
     already built for the read-heavy list actions.
   - If that's not enough: move chat specifically off Sheets onto a purpose-built
     realtime store (Firebase Realtime Database/Firestore, or Supabase Realtime) —
     a scoped hybrid architecture (Sheets stays the system of record for
     Owners/Products/Orders; only chat moves), not a rewrite of the whole backend.
2. **True real-time delivery** (websockets/SSE instead of polling) is impossible on
   Apps Script Web Apps by design — only reachable via the same hybrid-backend
   move described above. Not required for v1; polling with the adaptive interval
   in Section 7 is deliberately "live enough" without it.
3. **Web Push notifications** — real OS-level push requires a service worker + a
   push delivery service; deferred pending a PWA manifest/service worworker
   addition to the repo (currently absent) — a separate, larger project.
4. **Moderation/abuse tooling** — blocking a customer token, muting a conversation,
   basic profanity filtering — none of this exists in v1; today's only lever is the
   manual Sheet access already documented as this app's de facto admin model
   (`docs/architecture.md` §10).
5. **Rich content** (photo attachments in chat) — out of scope for v1 (text-only);
   would reuse the existing `Images.gs` Drive-upload pattern if added later, same
   as product photos and store logos.
6. **Per-token rate limiting**, beyond the minimal 1–2 second same-conversation
   throttle in Section 5 — only worth building if spam actually becomes a problem
   at this app's scale.

## 11. New files this design implies (not created yet)

For reference when implementation is approved — nothing below has been written:

- `apps-script/Chat.gs` — new backend file (`sendChatMessage`, `getChatMessages`,
  `listOwnerConversations`, `getOwnerConversationMessages`, `sendOwnerChatMessage`,
  `closeChatConversation`), following the existing one-file-per-domain convention.
- `apps-script/Code.gs` — register the new actions in `PUBLIC_POST_ACTIONS`/
  `PROTECTED_POST_ACTIONS` and the `doGet`/`doPost` switches, same as every prior
  new-action addition.
- `assets/js/chat-widget.js` — customer-side floating button + panel, loaded on
  `store.html` (and possibly `cart.html`/`checkout.html` later, matching how the
  floating cart button already appears across those pages).
- `owner/messages.html` + `assets/js/owner-messages.js` — new vendor dashboard page,
  following the existing `owner/*.html` + `Auth.guardOwnerAuth()` pattern.
- `assets/css/styles.css` / `assets/css/owner.css` — new rules for the chat panel,
  reusing existing tokens/classes (`.floating-action-btn`, design-token custom
  properties) rather than a new design language.
- `README.md` — new `Conversations`/`Messages` Sheet tabs added to the deployment
  schema section, same as every prior schema change.

---

**This is a design document only. No `.gs`, `.js`, `.html`, or `.css` file has been
modified or created for the chat feature itself. Awaiting approval before any
implementation begins.**
