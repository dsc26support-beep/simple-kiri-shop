# POS Integration Hub, Inventory Sync & Native POS — final implementation report

Branch `claude/pos-integration` (draft PR). Not merged, not deployed, no production data or credentials touched.

## What was built
* **Audit** — [pos-integration-audit.md](pos-integration-audit.md).
* **Hub backend** (`IntegrationHub.gs`): signed push receiver; connections (create / rotate / pause / resume / disconnect); secret shown once; mappings (exact ID/SKU/barcode, never name); sales, refunds, stock counts; idempotency, replay and echo protection; oversell / below-reserved flags; reconciliation actions (retry, use theirs, keep mine, acknowledge).
* **Outbox** (`IntegrationOutbox.gs`): order.created/paid/cancelled/completed to the seller's https URL, signed, retried with backoff, dead after six tries, no redirects, no PII by default.
* **Native POS** (`Pos.gs`): search/scan, cart, server pricing, discount cap, cash change, recorded (unverified) card/mobile payments, receipts, refunds with optional restock, reports with channels kept apart, honest profit rule, settings.
* **UI**: `owner/integrations.html`, `owner/pos.html` (+ JS, CSS, menu links only when `POS_HUB` is on).
* **Existing code touched, behaviour unchanged when off**: `Code.gs` (routes, version `pos1-2026-10-22`), `Auth.gs` (`posHub` flag), `Inventory.gs`/`Orders.gs` (outbox hooks), `InventorySync.gs` (`pushApi` connector), `Reminders.gs` (outbox sweep).
* **Docs**: architecture, setup, troubleshooting, runbook, migration, config template, DEPLOY.md and inventory-sync.md updates.

## Verified (run in this sandbox)
| Check | Result |
|---|---|
| `tests/test-pos-hub.js` (signature, replay, idempotency, stale time, mapping, oversell, refunds, versions, pause/rotate/disconnect, seller isolation, no secret leakage) | 48/48 |
| `tests/test-pos-native.js` (pricing, validation-before-stock, double tap, cash/card honesty, refunds, reports, last unit across tills, outbox retries/dead/4xx/timeout, URL safety, isolation) | 60/60 |
| `tests/verify-pos-hub.js` (real pages in Chromium against the real backend; scan → sell → receipt → refund; wizard; connected only after a signed ping; match → retry; off message; offline; no sideways scroll; no page errors) | 30/30 |
| Full `tests/test-*.js` regression (existing inventory, orders, wallet, auth, store suites) | all pass; four suites needed deliberate updates (APP_VERSION bump, owner field `posHub`, a hard-coded version prefix) |
| `npm run build:check` | 80 built files match |

Bugs the tests found and that are fixed: a body field named `action` overwrote the API routing key (retry/acknowledge would have failed in production); the matching list rendered before inventory loaded; a report crash without an Orders tab; SKU-only items could not be mapped; per-connection rate limit applied to forged attempts; version compare was textual ("9" > "10").

## NOT verified — be aware
* **Nothing ran against a real Google Sheet or the real Apps Script runtime.** The harness runs the real `.gs` in Node against an in-memory sheet; the lock is a no-op, so true concurrent execution is not tested (one-at-a-time ordering is).
* **No real provider was connected.** Square, Loyverse, Shopify POS, Lightspeed and Odoo connectors do **not** exist; header-signed webhooks need a relay that has not been built (see architecture).
* Outbound delivery was tested with a stubbed `UrlFetchApp`, not a live HTTPS endpoint; DNS-rebinding/SSRF is mitigated by name checks only (Apps Script gives no IP control).
* Real clock/time-zone behaviour of reports (`POS_TZ_OFFSET_HOURS`) not checked on the live script. No load test beyond bounded batch sizes.
* Printing was styled (print CSS) but not tested on a printer. Barcode scanners are assumed to behave as keyboards (type + Enter).
* No offline checkout (by design), no staff accounts (owner-only till), no card terminal or payment verification.
* **Not deployed.** Backend deploy is manual: follow DEPLOY.md and confirm `?action=getVersion` shows `pos1-2026-10-22` — this is unconfirmed until the owner does it.

## Remaining external prerequisites
Owner: back up the sheet; paste the 3 new + 6 changed `.gs` files; set `POS_HUB=on` for a trial; test one connection with a signed ping from a real system. For named providers: an account/credentials for each plus the relay. For wider use: legal/tax advice on holding sales records and receipts, and a staff-roles design if more than the owner will use the till.
