# Production Readiness Report — Mwakete at Marketplace Scale

**Target scale evaluated:** 10,000 vendors · 100,000 customers · millions of chat messages
**Current scale the app was actually built/tested for:** a small regional marketplace (tens of vendors, hundreds of customers)
**Verdict: not production-ready at the target scale on the current architecture.** The blocker isn't a bug — it's that "Google Sheets as the database" has a hard, documented ceiling that "millions of messages" sits on the wrong side of, plus several load-bearing patterns (a single script-wide write lock, full-table scans on every cache miss) that were reasonable at the scale this was designed for and become the dominant cost at the target scale. Section 6 gives the realistic ceiling of the current architecture and what it would take to move past it.

This report only covers scale/production-readiness. Security posture was already audited separately (`docs/security-audit.md`, 5 follow-up fixes applied) and isn't re-litigated here except where a finding is specifically about *scale interacting with* a security control (e.g. rate-limit cache-key cardinality).

---

## 1. Method

Read every backend file (`apps-script/*.gs`, 2,509 lines) and the frontend controllers most exercised by traffic volume (chat, directory, search, owner orders/products) end to end, cross-checked against Google's publicly documented platform ceilings for Sheets and Apps Script Web Apps. Findings below are grounded in the actual code (file:line references throughout), not general "Sheets doesn't scale" assumptions — where a number is asserted (cell counts, quota figures), the math is shown.

## 2. What "10,000 vendors / 100,000 customers / millions of messages" actually implies for this schema

| Sheet tab | Columns (from `README.md`/code) | Rows at target scale | Cells at target scale |
|---|---|---|---|
| Owners | 24 | 10,000 | 240,000 |
| Products | ~14 | ~200,000 (20/vendor avg) | ~2,800,000 |
| Variants | 7 | ~300,000 | ~2,100,000 |
| Orders | ~22 | conservatively 1M+ over the marketplace's life | 22M+ |
| **Messages** | **9** | **"millions"** (the stated target) | **9 × millions** |
| Conversations | 13 | ~100,000s | low millions |
| Sessions | 4 | unbounded without pruning (Finding 5) | grows forever |

Google Sheets' documented limit is **~10,000,000 cells per spreadsheet, across every tab combined** — not per tab. `Messages` alone, at 9 columns, hits that ceiling at ~1.1 million rows; add Orders/Products/Variants/Conversations sharing the same 10M budget and the realistic ceiling is lower still. **"Millions of messages" is not a performance problem in this architecture — it's a hard wall the spreadsheet will refuse to grow past**, at which point every write (`appendRow`) across the *entire* app — new orders, new products, new sessions, everything — starts failing, not just chat. This is Finding 1 and it is the one finding in this report that cannot be mitigated with caching, pagination, or tuning; it requires moving chat's storage off Sheets (already flagged as future work in `docs/vendor-chat-design.md` §10).

## 3. Findings, ranked by how directly each one blocks the target scale

### P0 — Architectural ceilings (no in-Sheets fix exists)

**Finding 1 — Google Sheets' ~10M-cell ceiling is smaller than "millions of messages."**
See the math above. Severity: the app stops accepting writes *anywhere* once hit, not gracefully degrades.
*Fix:* move chat (Messages + Conversations) off Sheets onto a purpose-built store (Firestore/Firebase RTDB/Supabase), keeping Sheets as the system of record for Owners/Products/Orders — already the direction `docs/vendor-chat-design.md` §10 points, just not built. This is the single largest piece of work in this report and is explicitly **not** attempted here (see §5 — "refactor only where absolutely necessary" excludes a storage-layer migration).

**Finding 2 — Every cache-miss read of a growing table is a full-table scan, and the biggest table is the one with the highest read frequency.**
`Db.gs`'s `sheetToObjects()` (`apps-script/Db.gs:20`) always does `sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()` — the entire used range, every time, with no server-side filtering (Sheets has no query/index API). `Chat.gs:243-249`'s `getConversationMessagesRaw` calls this on the **entire `Messages` tab** (every store's every conversation) and filters to one conversation *in memory*, on every cache miss. At "millions of messages," a single cache-miss read risks Apps Script's 6-minute per-execution timeout outright, well before it risks merely being "slow." The 10s/8s TTL caching added in the chat-performance pass (`docs/chat-performance-optimizations.md`) bounds how *often* this scan runs, but does nothing about how *expensive* one scan is once the table is large — caching a slow thing just makes it slow less often, not fast.
*Fix:* requires Finding 1's storage migration (a real datastore lets you query "messages where conversationId = X" without touching unrelated rows). No fix is possible while Messages stays a single flat Sheet tab.

**Finding 3 — `LockService.getScriptLock()` is script-wide, not per-resource, and nearly every write path takes it.**
Apps Script's `LockService` offers exactly three lock scopes — script, user, document — none finer than "the whole script." 15 call sites across `Auth.gs`, `Products.gs`, `Orders.gs`, `Chat.gs`, `Code.gs` (confirmed by grep) all call `LockService.getScriptLock()`, including ones with no data overlap at all: a customer checking out at Store A, a different customer sending a chat message to Store B, and a vendor updating a product at Store C all serialize through the **same mutex**, each waiting up to `lock.waitLock(30000)` (30 seconds) if contended. At 100,000 customers this is the sharpest concurrency bottleneck in the app — not because the code is wrong (it correctly prevents races), but because Apps Script gives no way to lock only the row/table actually being touched.
*Fix:* also requires Finding 1's migration — a real datastore's row/document-level transactions replace the need for one global mutex. Cannot be meaningfully improved while every mutating action shares one Sheet-backed spreadsheet.

### P1 — Real capacity ceilings on Apps Script itself

**Finding 4 — Apps Script Web App execution quotas are per-script, not scalable by adding more vendors/servers.**
Google's published Apps Script quotas (consumer Google account): ~30 simultaneous script executions, ~90 minutes of total trigger/script runtime per day, and a hard 6-minute cap per single execution. There is no "add more capacity" lever — this is a ceiling on the *entire deployment*, shared by all 10,000 vendors and 100,000 customers at once, not per-tenant. Even after the chat polling-backoff work (5-20s/8-30s adaptive intervals, `docs/chat-performance-optimizations.md`), thousands of customers with an open chat panel will still collectively generate enough concurrent polls to saturate the ~30-simultaneous-execution ceiling during peak hours, independent of anything server-side code can do.
*Fix:* a Google Workspace account raises these ceilings (6 hrs/day runtime instead of ~90 min, higher quotas generally) but does not remove the shared, single-deployment nature of the constraint. True horizontal scaling requires moving off Apps Script Web Apps as the API layer — out of scope here, flagged for awareness.

**Finding 5 — `Sessions` grows forever by default; `requireAuth` scans it on every authenticated request.** *(Fixed in this pass — see §5.)*
`pruneExpiredSessions()` (`apps-script/Auth.gs:320`) existed, fully implemented and tested-ready, but was never wired to anything — its own comment called it "optional," and `docs/architecture.md` documented it as "written trigger-ready, not currently wired." Meanwhile `requireAuth` (`Auth.gs:117`) calls `findRowBySecret` on `Sessions` on *every single protected-action request from every vendor* — an O(n) scan over a table with no upper bound. At 10,000 vendors each accumulating sessions across devices over a 7-day expiry window with nothing ever removing expired rows, this table only grows, and every authenticated request gets slower as it does.

**Finding 6 — `actionSearchProducts` was the highest-traffic customer-facing action and the only list/search action with no caching.** *(Fixed in this pass — see §5.)*
`listStores`, `listProducts`, `listTopProducts`, and `listTopStores` (`Products.gs`) were all already wrapped in `getCached(...)`. `actionSearchProducts` — hit by every homepage search box keystroke-submit and every category button click from all 100,000 customers — did three full-table scans (`Owners`, `Variants`, `Products`) on every single call, live, with no caching at all. At ~200,000 products across 10,000 vendors this was the single most expensive uncached hot path in the app.

**Finding 7 — No archiving/retention on any append-only table.**
`Orders`, `Messages` (Finding 1), `AbandonedCarts`, and `TwoFACodes`/`Sessions` (partially, see Finding 5) only ever grow. `runReminderSweep` (`Reminders.gs:79`, runs hourly forever per the README's own setup instructions) scans the **entire historical `Orders` and `AbandonedCarts` tables every hour**, for the lifetime of the marketplace, even though only rows from the last ~1-2 hours are ever actually due for a reminder. Cost grows linearly with total historical order volume, forever, with no time-bounded window.
*Fix (not done — see §5 scope):* archive orders older than N months to a separate spreadsheet/export, or at minimum have `runReminderSweep` stop scanning rows past a bounded lookback window (e.g. skip anything with `CreatedAt` more than 48 hours old — cheap, safe, but changes behavior/requires a decision on the exact window, so left as a recommendation rather than implemented unilaterally).

**Finding 8 — Product/logo images are hotlinked from Google Drive, not served from a CDN.**
`Images.gs` and `Chat.gs`'s chat-image upload both serve images via `lh3.googleusercontent.com/d/<fileId>` links. This works today but Drive is a file-storage product, not a CDN — it carries its own per-file download-quota behavior under heavy simultaneous access and has no SLA for high-traffic hotlinking. At 100,000 customers browsing product photos, this is a real availability risk under load, distinct from and in addition to the Sheets/Apps Script constraints above.
*Fix:* out of scope for this pass (would mean introducing an actual CDN/object-storage layer); flagged for the roadmap.

**Finding 9 — `MailApp`'s ~100-email/day quota, already flagged in the README as a "small scale" caveat, is far below what 10,000 vendors implies.**
2FA login codes, password resets, and reminder-sweep emails all share this one quota. Even a small fraction of 10,000 vendors using 2FA daily exceeds 100 sends/day trivially — this was already documented as a known constraint at "small scale," but the target scale in this review makes it a near-certainty on day one, not a someday concern.
*Fix:* out of scope (requires an external transactional email provider); flagged for the roadmap.

### P2 — Real but lower-severity at this scale (fix is UI work, not backend risk)

**Finding 10 — Several list views are unpaginated and render everything in one shot.**
- `stores.html`/`directory.js` (`assets/js/directory.js:19`) fetches and renders **every** active store in one DOM pass — at 10,000 vendors, a 10,000-node render on every visit to the store directory.
- `owner/orders.html`/`owner-orders.js` (`assets/js/owner-orders.js:23,32-64`) fetches a vendor's **entire** order history on every page load and does a full `innerHTML` re-render of the whole list after every single status-dropdown change — for a long-lived high-volume vendor this is a growing, unbounded per-page-load download and re-render.
- `owner/products.html`/`owner-products.js` has the same unbounded-fetch shape for a vendor's product catalog (lower severity — catalogs are naturally smaller than order history).

None of these will *break* at 10,000 vendors (a 10,000-item JSON payload and DOM render is slow and janky, not fatal), but they're real UX/perf regressions worth fixing before launch at this scale. Not fixed in this pass — each requires a `limit`/`offset` API change *and* a "Load more" UI addition, which is real feature work, not a minimal safe refactor (see §5 scope decision).

**Finding 11 — Chat's anonymous rate limiting is keyed on client-controlled identifiers (already documented, restated here for the scale context).**
`chatRateLimitIdentity` (`Code.gs:48`) keys on `customerToken`, a client-generated `localStorage` UUID with no server issuance — trivially reset by clearing storage or opening a private window. This was already an accepted trade-off in the security-audit work (no caller IP is available to Apps Script Web Apps at all), restated here only because "millions of messages" raises the stakes on it: it stops naive flooding, not a deliberate script targeting the marketplace at scale.

## 4. What's already solid at this scale (confirmed, not just assumed)

- **Every write that needs atomicity already takes a lock** (Finding 3 is about the lock's *scope*, not its *absence* — there is no missing-lock race condition anywhere reviewed).
- **Authorization/ownership checks are consistently applied** — every owned-row action re-validates `OwnerId` against the authenticated token before mutating (`actionUpdateOrderStatus`, `actionDeleteProduct`, `resolveChatRequest`'s vendor path, etc.) — this pattern doesn't degrade at scale, it's O(1) per request regardless of vendor count.
- **Order pricing is always server-derived**, never trusted from the client — irrelevant to scale but worth noting nothing here needs revisiting as volume grows.
- **The chat-performance pass already shipped real mitigations** (caching, pagination, adaptive polling backoff, write-skipping) that measurably reduce *how often* the expensive operations in Findings 2-4 run, even though they can't change *how expensive* any single one is. That work was necessary but not sufficient — this report is explicit that it bought headroom, not a scale-proof architecture.
- **Input validation, length caps, and rate limiting are already comprehensive** (from the prior security-fix pass) and don't need scale-specific rework — `capLength`/`rateLimitHit` are O(1) regardless of table size.

## 5. What was actually refactored in this pass, and why nothing bigger was touched

Per the instruction to refactor only where absolutely necessary, exactly two changes were made — both small, safe, behavior-preserving-at-the-margins, and directly justified by a finding above:

1. **`pruneExpiredSessions()` wired into the existing hourly `runReminderSweep()`** (`apps-script/Reminders.gs`) — closes Finding 5. This was a one-line addition to a function that already runs on an hourly trigger every deployment is instructed to set up (`README.md`), calling code that already existed, fully written, and now covered by a new regression test (`Reminders: ... > runReminderSweep also prunes expired sessions`). Zero new failure modes: worst case if something were wrong, an already-expired session simply survives one more hour, exactly like before this change.
2. **`actionSearchProducts` wrapped in `getCached(...)`** (`apps-script/Products.gs`) — closes Finding 6, bringing it in line with its four sibling read actions that were already cached. Uses the exact same TTL-only staleness trade-off already accepted for `v1:topProducts`/`v1:topStores` (60s, no explicit invalidation — the query-keyed cache space is unbounded the way the fixed list-action keys aren't, so entries just expire on their own TTL). Two new regression tests confirm both the caching behavior and that different queries don't collide in the cache.

Both changes are `node --check`-clean and the full backend suite passes (150/150 — 147 pre-existing + 3 new).

**Everything else in §3 is a recommendation, not a change made here**, because each one is either:
- a genuine architecture migration (Findings 1-3 — moving chat off Sheets, which no in-place refactor can substitute for), or
- a deliberate scope/behavior decision that isn't mine to make unilaterally (Finding 7's archiving window, Finding 10's pagination UX, Finding 8's CDN choice, Finding 9's email provider), or
- already a known, previously-accepted trade-off restated for context (Finding 11).

Implementing any of those now would be scope creep against "refactor only where absolutely necessary" — they're listed so the roadmap in §6 is concrete, not so they get silently built into this pass.

## 6. Roadmap and realistic ceiling

**Roughly what the current architecture can sustain**, extrapolating from the findings above rather than guessing: comfortably hundreds of vendors, low tens of thousands of customers, and — the binding constraint — **chat message volume in the hundreds of thousands, not millions**, before Finding 1's cell ceiling and Finding 2's scan-time both become critical. Everything else in this app (Products/Orders/Owners) has more headroom than Messages does, because nothing else grows as fast as a live-chat message log does.

**To actually reach 10,000 vendors / 100,000 customers / millions of messages, in priority order:**
1. Move `Conversations`/`Messages` off Sheets onto a real datastore (Finding 1/2/3). This is the one change that's load-bearing for every number in the target scale — it removes the cell ceiling, makes per-conversation reads O(1)-ish instead of full-table scans, and enables row-level transactions instead of one script-wide lock for chat specifically.
2. Move the Owners/Products/Orders read path off live Sheets scans onto an indexed store, or accept Sheets for those (they're much smaller than Messages) but add real archiving for `Orders`/`AbandonedCarts` (Finding 7) so the reminder sweep's cost stops growing forever.
3. Move off Apps Script Web Apps as the API layer, or at minimum move to Google Workspace to raise the execution-quota ceilings (Finding 4) — necessary regardless of the datastore choice, since the ~30-simultaneous-execution and ~90-min/day runtime ceilings apply to the whole deployment no matter what's behind it.
4. Add a real CDN/object storage for images (Finding 8) and an external transactional email provider (Finding 9) — both straightforward swaps once the deployment isn't Apps Script-only.
5. Add pagination UI to the directory, owner orders, and owner products views (Finding 10) — pure frontend/API-shape work, no architecture dependency, can happen any time.

None of steps 1-3 are small — they are, collectively, a second architecture for this app's data layer. That is the honest answer to "can this reach 10k/100k/millions": not on the current Sheets+Apps Script foundation, no matter how much the application code on top of it is tuned.
