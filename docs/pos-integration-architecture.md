# POS Integration Hub — architecture

Status: built on branch `claude/pos-integration`, tested against an in-memory spreadsheet only. **Off by default** (Script Property `POS_HUB`). Read the audit first: [pos-integration-audit.md](pos-integration-audit.md).

## One system, extended

There is still one inventory (`Variants.StockQty` physical, `ReservedQty` held, available = max(0, stock − held)), one ledger (`StockMovements`), one order table (`Orders`) and one sync engine (`InventorySync.gs`). Nothing was duplicated.

| Piece | File | What it adds |
|---|---|---|
| Delta path | `IntegrationHub.gs` `applyStockDelta` | The one function that applies a sale / return as a quantity change on the existing ledger, under the existing script lock. Used by the native POS and by connected systems. |
| Push receiver | `IntegrationHub.gs` `actionPosPush` | Public, signed endpoint for sales, refunds, stock counts and pings. |
| Mappings | `IntegrationMappings` tab | External item → one of the seller's own variants. |
| Event ledger | `IntegrationEvents` tab | Every message in or out: status, idempotency key, before/after, reconciliation state. |
| External sales | `ExternalSales` tab | Sales reported by connected systems (kept out of `Orders`). |
| Outbox | `IntegrationOutbox.gs` | Online order events (created / paid / cancelled / completed) to the seller's HTTPS address. |
| Native POS | `Pos.gs` | Tills: search/scan, cart, server pricing, cash and recorded digital payments, receipts, refunds, reports. Tabs `PosSales`, `PosSaleLines`, `PosPayments`, `PosRefunds`, `PosSettings`. |
| Connector | `InventorySync.gs` `pushApi` | Registers the push connector beside CSV and Google Sheets; the old Import & Sync page ignores it. |
| UI | `owner/integrations.html`, `owner/pos.html` | Hub and till. Menu links appear only when the flag is on. |

## Data flow

```
Till/shop system --signed JSON--> doPost(action=posPush)
   verify connection + HMAC + 5-min window -> rate limit -> lock
   -> duplicate? echo? -> normalise (whitelist) -> resolve items (mapping > external id > SKU > unique barcode; never name)
   -> all lines matched? -> applyStockDelta (SALE/RETURN, fact: floor 0, flag oversell) -> IntegrationEvents / ExternalSales
Online order (Orders.gs / Inventory.gs) --enqueue (1 row)--> IntegrationOutbox --hourly or "send now"--> seller HTTPS URL (signed, idempotency key)
Native POS --posCheckout--> validate everything -> applyStockDelta(fact:false) -> PosSales/Lines/Payments
```

## Rules that hold everywhere

* **A physical sale is a fact.** It is applied even if Mwakete's number was wrong; stock floors at 0 and an *attention* item is raised if it was oversold or went below what online orders hold. Nothing is silently dropped.
* **A stock count is not a movement.** It is compared and queued for the seller (use theirs / keep mine).
* **All-or-nothing sales.** One unmatched line holds the whole sale; no stock moves until mapped and retried.
* **No name matching.** Exact external ID, SKU or barcode only.
* **`Orders` is never written by a POS sale**, so a till cannot mark an online order paid or cancelled.
* **Echo suppression.** A message that looks like Mwakete's own change coming back is recorded and ignored.
* **Native POS inside the lock:** `clientTxnId` and `requestId` idempotency checked inside the lock; all lines validated before any stock moves; prices, discount cap, tax and change computed on the server.
* **Money honesty.** Cash is "received". Card / mobile are "recorded by the seller, not verified by Mwakete". Refunds are records; Mwakete moves no money.

## Security

Auth: seller actions use the owner session and always filter by `OwnerId`. Webhook: HMAC-SHA256 over `connectionId.timestamp.payload`, constant-time compare, 5-minute window, per-event idempotency, unknown connection and bad signature indistinguishable, global limiter for bad attempts and a per-connection limiter for good ones, payload size and line caps. Secrets: Script Properties `POSSECRET_<id>`, shown once, never returned or logged, deleted on disconnect, rotation invalidates the old one. Outbound: https only, public domain names only (no IPs, credentials, odd ports, internal suffixes), no redirects, response body never kept, customer contact details off unless enabled. Every change is in the audit log. Sheet writes pass through the existing formula-injection guard.

## Platform limits (and what they mean)

* Apps Script cannot read request headers, so the signature travels in the JSON body. A provider that signs a header (Square, Shopify, Loyverse, Lightspeed) needs a small relay that verifies the provider's signature and re-signs in our format. **Not built.**
* One global script lock and a 6-minute limit: batches are bounded; outbound calls run outside the lock.
* POST to a web app answers via a 302; senders must follow it.
* Script Properties are the only secret store.

## Named providers — feasibility (nothing here is connected)

| Provider | Realistic path | Blocker |
|---|---|---|
| Square | Webhooks (`X-Square-Hmacsha256-Signature` header) + Orders/Inventory API | Relay for the header; Square account and OAuth app |
| Loyverse | Webhooks + API token | Relay; account |
| Shopify POS | Shopify webhooks (HMAC header) | Relay; app credentials |
| Lightspeed | OAuth API / webhooks | Relay; developer account |
| Odoo | JSON-RPC / webhook automation, can sign in body | Instance to test against |
| Anything else | Use the generic signed push | none |

## Not built

Staff accounts and roles (the till is owner-only; a design is in the audit), offline checkout (deliberately online-only), card terminals, tax reporting beyond a receipt line, provider connectors above, a push (rather than hourly) outbox.
