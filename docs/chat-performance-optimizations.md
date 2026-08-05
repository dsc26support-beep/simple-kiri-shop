# Chat System Performance Optimizations

Date: 2026-08-05
Scope: `apps-script/Chat.gs`, `apps-script/Code.gs`, `assets/js/chat-window.js`, `assets/js/owner-messages.js`, `store.html`/`cart.html`/`checkout.html`, `owner/messages.html`, `assets/css/styles.css`, `assets/css/owner.css`.

Every optimization below is documented against exactly what it touches, why, and any trade-off accepted along the way — this file is the single source of truth for "what changed and why" so a future reader doesn't have to reconstruct the reasoning from the diff alone.

## Summary — one optimization can serve more than one goal

| Optimization | Reduces executions | Batches writes | Lazy loading | Pagination | Caching | Mobile |
|---|---|---|---|---|---|---|
| Adaptive polling backoff | ✅ | | | | | ✅ |
| Skip no-op "mark read" writes | ✅ | ✅ | | | | |
| Messages-per-conversation cache | ✅ | | | | ✅ | |
| Conversations-per-owner cache | ✅ | | | | ✅ | |
| Message history pagination (`limit`/`beforeMessageId`) | | | ✅ | ✅ | | ✅ |
| Conversation list pagination (`limit`/`offset`) | | | | ✅ | | ✅ |
| Chat image `loading="lazy"` | | | ✅ | | | ✅ |

---

## 1. Reduce Apps Script executions

### Adaptive polling backoff

**Problem**: both the customer chat window and the vendor dashboard polled at a fixed interval (6s customer, 6s/8s vendor detail/list) the entire time a panel was open, regardless of whether anything was actually happening. An idle, already-read conversation left open for ten minutes cost the same number of executions as an actively-typing one.

**Fix**: every poll loop now starts at a fast interval right after activity and geometrically backs off (×1.5 per empty poll) up to a cap, resetting to fast the moment something happens:

| Loop | File | Min | Max | Resets to min on |
|---|---|---|---|---|
| Customer conversation poll | `chat-window.js` (`CHAT_POLL_MIN_MS`/`MAX_MS`) | 5s | 20s | a new message arrives via poll, or the customer sends one |
| Vendor conversation-detail poll | `owner-messages.js` (`CONVERSATION_POLL_MIN_MS`/`MAX_MS`) | 5s | 20s | a new message arrives via poll, or the vendor sends a reply |
| Vendor conversation-list poll | `owner-messages.js` (`LIST_POLL_MIN_MS`/`MAX_MS`) | 8s | 30s | the conversation count changes (new conversation, one dropped) |

The list poll keeps a slower floor/ceiling than the detail poll, preserving the original design's intent (a new conversation arriving is less time-sensitive than a reply inside one already open) while now also backing off further during genuinely idle stretches.

**Implementation note**: `setInterval` can't have its delay changed between ticks, so both files switched from `setInterval` to a self-rescheduling `setTimeout` (`scheduleNextPoll`/`pollTick` in `chat-window.js`; `conversationPollTick`/`listPollTick` in `owner-messages.js`). Each tick decides the *next* delay based on whether that tick found anything new, then reschedules itself.

**Verified**: a Playwright timing test (ephemeral, deleted after use) confirmed poll gaps growing 5000ms → ~7508ms (5000×1.5) across two consecutive empty polls, versus a fixed interval which would have fired a third poll in the same window.

### (Also reduces executions) Caching and write-batching

The two items below are filed under their own headings (§2 "Batch writes", §5 "Caching") since they're each a distinct technique, but both directly reduce the *cost* of an execution that does happen — caching avoids a full-table Sheet scan on a cache hit, and write-skipping avoids a Sheet write. Listed here too since "fewer/cheaper executions" is the umbrella goal both serve.

---

## 2. Batch writes

**Problem**: `actionGetConversation` marks the conversation read for whichever side is calling, as a side effect, on *every single call* — including every poll. `markConversationReadByVendor`/`markConversationReadByCustomer` used to write `UnreadByVendor: 'false'` (or the customer equivalent) unconditionally, even when the conversation was already read. With adaptive polling now firing anywhere from every 5s (active) to every 30s (idle), that's a redundant Sheet write on every poll cycle after the first, forever, for as long as a panel stays open on an already-read thread.

**Fix** (`apps-script/Chat.gs`):

```js
function markConversationReadByVendor(conversationId) {
  var conversation = getConversationById(conversationId);
  if (!conversation) return;
  if (String(conversation.UnreadByVendor) === 'false') return; // already read - skip the write entirely
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { UnreadByVendor: 'false' });
  invalidateCache([chatConversationsCacheKey(conversation.OwnerId)]);
}
```

Same pattern for `markConversationReadByCustomer` (no cache invalidation needed there — see §5's note on why `UnreadByCustomer` isn't part of any cached list).

**Verified directly, not just inferred**: the test harness (`harness.js`) was instrumented with a `writeCounts` object that increments on every `setValues`/`appendRow`/`deleteRow` call, keyed by sheet name. A new test (`Chat: performance optimizations > markAsRead / getConversation skip the Conversations write once already read`) asserts the *exact* write count: one write on the first read (the real true→false transition), then five more `getConversation` polls with **zero** additional Conversations writes, then exactly one more write after a genuinely new message arrives. This is a real, counted proof of the optimization working, not a timing-based inference.

---

## 3. Lazy loading

### Chat photo lazy loading

Every `<img>` created for a chat message (both `chat-window.js`'s `appendMessage` and `owner-messages.js`'s `appendConversationMessage`) now sets `img.loading = 'lazy'`. A long conversation history with several photos no longer downloads every image up front — the browser defers off-screen images until they're scrolled into view. This matters specifically for this app's audience (this repo's home page/README already frame Kiribati mobile data as a first-class constraint), and it's the same technique already used for product photos elsewhere in the codebase (`product-card.js`), just newly applied to chat.

### Message history is loaded lazily by default

Before this change, opening a conversation fetched its *entire* message history in one response, unbounded. Now the initial load only fetches the most recent page (see §4) — the rest of the history is fetched on demand, only if the customer or vendor actually asks for it via "Load earlier messages". This is lazy loading in the more general sense: nothing beyond what's likely to be looked at is fetched until it's requested.

---

## 4. Pagination

### Message history — initial page + "load earlier"

**Backend** (`apps-script/Chat.gs`):

- `listMessagesForConversation(conversationId, opts)` now takes `{ sinceMessageId, beforeMessageId, limit }` instead of a bare `sinceMessageId`:
  - `sinceMessageId` (the existing polling-delta cursor) stays **unbounded** — a real gap between two polls a few seconds apart is always small, and truncating it would silently drop a message from the live view.
  - `beforeMessageId` + `limit`: up to `limit` messages immediately before that message — "load earlier history," paging backward.
  - Neither: the most recent `limit` messages — the initial-load page (`DEFAULT_MESSAGE_PAGE_SIZE = 50`, capped at `MAX_MESSAGE_PAGE_SIZE = 100` if a caller asks for more).
  - Returns `{ messages, hasMoreBefore }`.
- `actionGetConversation` passes `body.beforeMessageId`/`body.limit` through and returns `hasMoreBefore` in its response.

**Frontend**: both `chat-window.js` and `owner-messages.js` track the earliest rendered message (`oldestMessageId`/`activeOldestMessageId`) and the earliest rendered DOM bubble (used as the insertion anchor), and show a "Load earlier messages" button (`#chat-load-earlier-btn` / `#conversation-load-earlier-btn`) whenever `hasMoreBefore` is true. Clicking it fetches the previous page and **prepends** it above the current earliest bubble, preserving scroll position:

```js
const scrollHeightBefore = body.scrollHeight;
const scrollTopBefore = body.scrollTop;
// ...insert older messages above the current oldest bubble...
body.scrollTop = scrollTopBefore + (body.scrollHeight - scrollHeightBefore);
```

Without this, prepending content above the visible area would otherwise yank the scroll position down by the inserted height — a jarring jump right as the customer/vendor is trying to read older messages.

### Vendor conversation list — `limit`/`offset`/`total`/`hasMore`

**Backend**: `actionGetVendorConversations(owner, body)` now accepts `limit`/`offset` (`DEFAULT_CONVERSATION_PAGE_SIZE = 20`, capped at `MAX_CONVERSATION_PAGE_SIZE = 100`) and returns `{ conversations, total, hasMore }` instead of the full unpaginated list.

**Frontend** (`owner-messages.js`): a "Load More" button (`#conversation-list-load-more`) appears below the list whenever `hasMore` is true. Clicking it re-fetches with `limit = currently-loaded-count + CONVERSATION_LIST_PAGE_SIZE` at `offset: 0` — a "grow the page" request rather than a true offset cursor. This was a deliberate choice: the underlying order can change between requests (a new message re-sorts a conversation to the top), so a classic offset-based "next page" could skip or duplicate rows across two calls if the order shifted in between. Re-requesting "however many are visible, plus one more page" from the top is simpler and immune to that reordering hazard.

The **list poll** (background refresh, not a user click) uses the same mechanism in reverse: it always re-requests exactly `limit = ownerConversations.length` (however many are *currently* shown), so a routine background refresh never silently grows or shrinks what's on screen — only an explicit "Load More" click does that.

---

## 5. Caching

**Problem**: `Db.gs`'s `sheetToObjects()` always does a full-range read of an entire Sheet tab — there's no way to ask Sheets for "just the rows matching X." `listMessagesForConversation` was reading and filtering the **entire Messages tab across every store's every conversation** on every single `getConversation` call, and `listConversationsForOwner` was doing the same full-table scan of Conversations on every inbox poll. Both get more expensive as the app's data grows, and both were being re-run identically on every poll even when nothing had changed since the last one.

**Fix**: both now go through the existing `getCached`/`invalidateCache` pattern already used for the storefront's read-heavy list endpoints (`Products.gs`'s `actionListStores` etc.), extended to chat:

- `getConversationMessagesRaw(conversationId)` — every message in one conversation, oldest-first, cached under `v1:chat:messages:<conversationId>` for `CHAT_MESSAGES_CACHE_TTL_SECONDS = 10`.
- `listConversationsForOwner(ownerId)` — every conversation for one owner, cached under `v1:chat:conversations:<ownerId>` for `CHAT_CONVERSATIONS_CACHE_TTL_SECONDS = 8`.

Both cache the **full, unsliced** array; pagination (§4) slices *after* the cache read, so one cached value serves every page/poll requesting different windows of the same data — the same "cache the whole thing, slice per-request" pattern already established for the storefront's `actionListStores`.

**Invalidation** — every write that changes what a cached read would return invalidates immediately, never waiting out the TTL:

| Write | Invalidates |
|---|---|
| `appendMessage` (new message, text or image) | that conversation's messages cache, **and** the owner's conversations cache (last-message preview/unread flags changed) |
| `markConversationReadByVendor` (only when it actually writes — see §2) | the owner's conversations cache |
| `setConversationStatus` (archive/delete) | the owner's conversations cache |

`markConversationReadByCustomer` deliberately does **not** invalidate anything — `UnreadByCustomer` isn't surfaced anywhere in the vendor-facing UI this cache feeds, so there's nothing that could go stale.

**Staleness window accepted**: up to 8-10 seconds, always shorter than every poll interval in the frontend (§1), and always invalidated immediately on write regardless — so the TTL only ever matters for absorbing *repeat reads between two genuine writes* (e.g. a vendor and customer both polling around the same quiet moment), never for how fresh a just-sent message looks.

**Deliberately not cached**: `getConversationById`/`findConversation` (the single-conversation lookups `resolveChatRequest` uses to figure out *which* conversation a request is about) stay uncached, doing a fresh scan every call. This was a considered trade-off, not an oversight: caching the single-conversation resolution path would mean the conversation object returned in every response could be tied to whichever cache entry existed at request time, and reasoning correctly about staleness there (is `__row` still valid, could `status` be stale mid-request) is meaningfully more complex than the two list-shaped caches above for comparatively little benefit, since this lookup only runs once per request rather than being the N×poll cost the list reads are. Keeping every request's own "which conversation, in what state" resolution fresh was judged worth the extra scan.

**Verified**: `Chat: performance optimizations` test group includes explicit regression tests that a message sent immediately after a cache-populating read is visible on the very next `getConversation` call, and that archiving/deleting a conversation is reflected on the very next `getVendorConversations` call — proving the cache never serves stale data across a write, not just asserting it exists.

---

## 6. Optimize mobile performance

This app's stated audience (Kiribati shoppers, largely on mobile data) makes bandwidth and battery genuinely first-order concerns, not just a nice-to-have. Every optimization above contributes:

- **Adaptive polling** (§1) directly reduces the number of network round-trips and radio wake-ups on a phone over the lifetime of an open chat panel — an idle conversation left open drops from a request every 6-8s to one every 20-30s.
- **Message pagination** (§4) means opening a long-running conversation on a slow connection no longer downloads its entire history before showing anything — just the most recent ~50 messages, with the rest available on demand.
- **Lazy-loaded images** (§3) mean a long conversation with several photos doesn't download all of them up front — only the ones actually scrolled into view, same technique already used for product photos.
- **Caching** (§5) and **write-batching** (§2) reduce Apps Script's own response latency (a cache hit and a skipped write are both faster than a full Sheet scan/write), which matters more on a slow mobile connection where every extra round-trip-second is felt directly.

No separate mobile-specific code path was needed — every change above benefits mobile and desktop identically, which is preferable to a forked implementation.

---

## Verification

- **Backend**: `node --check` on every edited `.gs` file. The harness-based test suite (kept outside the repo, not committed) grew from 137 to 147 tests — 10 new tests covering message-page-size/`hasMoreBefore` correctness, `beforeMessageId` paging, the `sinceMessageId` polling path staying unbounded (regression), cache-invalidation correctness (a new message is visible on the very next read; archive/delete is reflected on the very next list read), the exact write-count proof of the batching optimization, and conversation-list `limit`/`offset`/`total`/`hasMore` correctness. Full suite re-run 3× consecutively, 147/147 passing each time (no flakiness).
- **Frontend**: a Playwright script (ephemeral, deleted after use) covering both the customer widget and the vendor dashboard confirmed: chat images carry `loading="lazy"`; the "Load earlier messages" button appears exactly when `hasMoreBefore` is true, fetches the correct `beforeMessageId`, prepends messages in the right (oldest-first) order, and hides itself once history is exhausted; the vendor's "Load More" button requests the correct grown `limit` and renders the expanded list; and adaptive polling's gap between consecutive empty polls grew from 5000ms to ~7508ms (the expected ×1.5 backoff), confirmably fewer requests than a fixed interval would have produced in the same window.

## What's next (not done, not required, noted for completeness)

- A true rolling/moving-window cache invalidation for cross-store aggregate views (e.g. a platform-wide "recent chat activity" dashboard) doesn't exist because no such feature exists yet — nothing to optimize.
- Per-conversation single-row caching (`getConversationById`) was considered and deliberately not implemented — see §5's note.
- The chat rate limiter (from the earlier security follow-up, `Code.gs`'s `checkChatRateLimit`) and this pass's polling backoff are complementary but independent: the rate limiter caps how fast messages can be *sent*, this pass caps how often the client *asks* for updates. Both were tuned without needing to touch the other.
