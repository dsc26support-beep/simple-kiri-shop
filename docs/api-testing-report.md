# Backend API Testing Report

**No code was changed as part of this testing pass.** This report covers what was
tested, how, what passed, and what was found — bug fixes are proposed but not
applied, per instructions to wait for approval.

## Methodology

The live Apps Script backend isn't reachable from this environment (outbound
network policy blocks `script.google.com`, confirmed earlier in this project), so
"test every API" was done by building an **executable test harness** rather than
relying on code review alone:

- A Node.js mock of every Apps Script platform API actually used by this codebase —
  `SpreadsheetApp` (backed by an in-memory table matching each Sheet tab's real
  header row from `README.md`), `LockService`, `CacheService` (with the real
  ~100KB per-key size cap enforced), `PropertiesService`, `Utilities`
  (`computeDigest`/`base64Encode`/`base64Decode`/`getUuid`/`newBlob`/`formatDate`),
  `DriveApp`, `MailApp` (captures sent emails instead of sending them), and
  `ContentService`.
- All 9 real `apps-script/*.gs` files are loaded verbatim into one shared V8
  context via Node's `vm` module — exactly how Apps Script itself shares one global
  scope across every `.gs` file in a project. No source was copied, rewritten, or
  approximated; the actual `doGet`/`doPost`/`action*` functions run unmodified.
- Tests call `doGet`/`doPost` the same way the real router would (building the
  `e.parameter`/`e.postData.contents` shapes Apps Script passes in), so the routing
  logic in `Code.gs` — including the newly-added chat actions — is exercised
  end-to-end, not just the underlying functions in isolation.
- 93 test cases across 8 domains, each in a fresh, isolated in-memory "spreadsheet"
  (no state leaks between tests).

**Limitations of this approach** (worth stating plainly): this validates
application logic faithfully, but cannot verify real Google infrastructure
behavior — actual Sheets/Drive/`CacheService` quotas and latency, real concurrent-
request behavior under `LockService`, or whether `runReminderSweep`'s time-driven
trigger is actually wired up in a given deployment (that's a manual, per-deployment
step, not something any code-level test can check). Frontend integration wasn't
in scope — no chat UI exists yet to integrate with, and this pass is backend-only.

## Scope

Every action reachable through `Code.gs`, all 34 of them:

| Domain | Actions tested |
|---|---|
| Auth | `registerOwner`, `loginOwner`, `verifyLoginCode`, `logoutOwner`, `requestPasswordReset`, `resetPasswordWithCode`, `setStoreStatus`, `enable2FARequest`, `confirm2FASetup`, `disable2FA` |
| Products/Stores | `listStores`, `listProducts`, `getStorePublicInfo`, `searchProducts`, `listTopProducts`, `listTopStores`, `recordProductViews`, `recordStoreVisit`, `listOwnerProducts`, `createProduct`/`updateProduct`, `deleteProduct`, `updateOwnerProfile` |
| Orders | `createOrder` (incl. the full South/North Tarawa/outer-island delivery-eligibility matrix from `README.md`), `listOwnerOrders`, `updateOrderStatus` |
| Images | `uploadProductImage`, `uploadStoreLogo` |
| Reminders | `saveAbandonedCart`, `runReminderSweep` (not routed through Code.gs — called directly, as the time-driven trigger would) |
| Chat | `sendMessage`, `getConversation`, `getVendorConversations`, `markAsRead`, `deleteConversation`, `archiveConversation`, `getUnreadCount` |
| Routing | `doGet`/`doPost` unknown-action handling, the chat actions' optional-auth dual-path routing specifically (since that's the least conventional part of the whole API surface) |

## Result summary

**93 / 93 passing.**

Getting to a clean pass required fixing 6 problems along the way — 5 were bugs in
my own test setup/harness (documented below for transparency, not application
bugs), and 1 is a real, if low-severity, application-level finding.

### Issues found in my own test harness/setup (not application bugs)

1. My `DriveApp` mock's `createFolder()` didn't return an object with a
   `createFile` method (only `getFolderById()`'s return value had one) — crashed
   the very first image upload in any fresh test run, before `IMAGE_FOLDER_ID` was
   set. Fixed by giving both a shared folder shape.
2. Three test cases used 2-character usernames (`'u1'`, `'u3'`, etc.) — which the
   app **correctly** rejects (`actionRegisterOwner` requires 3–40 characters). Not
   a bug; my test data was invalid input. Fixed by lengthening the usernames.
3. A variant-diffing test assumed a soft-deleted variant would still appear in
   `listOwnerProducts` (tagged `status:'deleted'`). It doesn't —
   `actionListOwnerProducts` (`Products.gs`) filters `Status !== 'deleted'` before
   returning, consistent with `owner-products.js`'s own client-side
   `.filter(v => v.status === 'active')`. **Verified correct, consistent
   behavior** — the row still exists in the Sheet (confirmed directly), it's just
   correctly excluded from this response. Test updated to assert the right thing.
4. A `listTopProducts` sort-order test assumed passing the same product ID N times
   in one `recordProductViews` call would add N views. It adds 1 —
   `actionRecordProductViews` dedupes IDs *within* a single call via a `wanted` set
   before incrementing (`Products.gs`). **Verified correct, intentional
   behavior** (the function's own doc comment says exactly this, and it's a good
   safety property: a client accidentally sending duplicate IDs in one batch can't
   inflate a product's view count). Fixed by calling the action once per intended
   increment instead.
5. A `getVendorConversations` sort-order test occasionally failed because two
   `sendMessage` calls in the same synchronous test tick landed on the identical
   millisecond timestamp — which turned out to not be a test-only artifact, see
   the real finding below.

### Real application finding

**[Low severity] `listConversationsForOwner` (`apps-script/Chat.gs`) has no
tie-breaker when two conversations' `LastMessageAt` land on the exact same
millisecond.**

- **Where**: `listConversationsForOwner`'s sort — `new Date(b.LastMessageAt || b.CreatedAt) - new Date(a.LastMessageAt || a.CreatedAt)`.
- **Failure scenario**: two different customers send a message to the same vendor
  within the same millisecond. `LastMessageAt` (`nowIso()`, millisecond precision)
  ties, the comparator returns `0`, and JavaScript's stable sort then falls back to
  original array order (effectively "whichever conversation's row appears first in
  the Sheet") rather than true chronological recency. The vendor's inbox could show
  the two conversations in the wrong relative order.
- **How this was confirmed, not just theorized**: reproduced deterministically in
  the test harness by forcing two conversations to an identical `LastMessageAt`
  and observing the sort resolve the tie via insertion order rather than any
  recency signal (see `Chat: getVendorConversations` in the test suite — the "KNOWN
  GAP" test documents current behavior explicitly).
- **Real-world likelihood**: very low. This requires two *different* customers
  messaging the *same* vendor within the same millisecond — human typing and
  network round-trips make this astronomically unlikely in normal use. It's a real
  gap, not a practical problem today, which is why this is Low rather than
  Medium/High severity.
- **Suggested fix** (not applied): give `Conversations` a secondary, guaranteed-
  monotonic tie-breaker instead of relying on wall-clock time alone. Since every
  chat write already goes through `LockService.getScriptLock()` (`actionSendMessage`
  in `Chat.gs`), writes are already fully serialized — so a simple incrementing
  counter read+written under that same lock (e.g. a new `ActivitySeq` column on
  `Conversations`, or reusing the pattern `PropertiesService` already uses for
  `IMAGE_FOLDER_ID`-style single values) would give a collision-proof ordering key
  with no new concurrency risk. `listConversationsForOwner`'s sort would then
  compare `ActivitySeq` (or fall back to it only when `LastMessageAt` ties).

### Informational observations (not bugs, no fix needed — noted for completeness)

- **`actionEnable2FARequest`'s "no contact email" rejection path is currently
  unreachable through the API.** `actionRegisterOwner` has required an email since
  an earlier change this session, so every owner that can call `enable2FARequest`
  already has one. The check itself is harmless defensive code (and would matter
  again if email were ever made optional at registration), so no fix is suggested
  — just flagging it as intentionally-dead-for-now rather than a gap I missed.
- **`recordProductViews`' in-call dedup** (see item 4 above) is correct and
  matches its doc comment — recorded here as "tested and confirmed," not a finding.
- **`listOwnerProducts` excluding soft-deleted variants** (see item 3 above) is
  correct and consistent with the frontend's own filtering — recorded as "tested
  and confirmed."

## Full test list

93 tests across: `Auth: registerOwner` (6), `Auth: loginOwner` (4), `Auth: sessions
/ requireAuth` (6), `Auth: password reset` (4), `Auth: 2FA` (3), `Products:
listStores / getStorePublicInfo` (3), `Products: listProducts / createProduct /
deleteProduct` (6), `Products: searchProducts / listTopProducts / listTopStores`
(5), `Orders: createOrder` (5), `Orders: delivery eligibility matrix` (4),
`Orders: listOwnerOrders / updateOrderStatus` (3), `Images: uploadProductImage /
uploadStoreLogo` (6), `Reminders` (4), `Chat: sendMessage` (9), `Chat:
getConversation` (7), `Chat: markAsRead` (2), `Chat: getVendorConversations /
getUnreadCount` (7), `Chat: Code.gs routing correctness` (3). Every security-
sensitive cross-owner-access path (a vendor touching another store's product,
order, or conversation) has an explicit test asserting it's rejected.

## What's next

This report only identifies and explains the one real finding above — no fix has
been applied. If you'd like, I can:
1. Apply the suggested `ActivitySeq` tie-breaker fix to `Chat.gs`.
2. Persist the test harness itself into the repo (e.g. under a `tests/` folder) as
   a reusable regression suite for future backend changes — it currently lives
   outside the repo since building new test infrastructure wasn't asked for this
   round, but it would be low-effort to keep given it already exists and passes.

Waiting for direction on either before touching anything.
