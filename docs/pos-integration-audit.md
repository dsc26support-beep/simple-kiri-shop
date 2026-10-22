# POS integration audit

Audit date: 22 October 2026. Done against `main` at `602acb8` by reading the
code and tracing the execution paths, not by trusting file names or comments.
Everything below is verified from the source unless it says otherwise.

## 1. Short answer to the audit questions

| # | Question | Finding |
|---|---|---|
| 1 | Does Mwakete connect to external POS software? | **No.** There is no connector to any named POS product (Square, Loyverse, Shopify POS, Lightspeed, Odoo, others). |
| 2 | Which providers and operations are genuinely implemented? | Only two **data sources**: a CSV file and a Google Sheet the seller shares with Mwakete. Both are row-based stock lists, not POS systems. Excel/OneDrive and "Other system (API)" exist as slots that report "not configured" and do nothing. |
| 3 | Is sync only inside Mwakete, or does it exchange data externally? | It exchanges data with the seller's **Google Sheet** (read, and write-back of stock). CSV is read-only (and export is a file download). |
| 4 | Inbound and outbound? | Inbound: CSV, Sheets. Outbound: stock written back to a Sheet (`writeStock`) in `export` and `twoWay` modes. **No outbound events or order export exist.** |
| 5 | Event-driven, scheduled, manual? | Manual (preview → apply, *Sync now*) and **scheduled** (hourly via `runReminderSweep`, Sheets only). **No event-driven path: there is no webhook receiver of any kind.** |
| 6 | How are products matched? | Mwakete variant ID → external ID → SKU → barcode, case-insensitive, **never by name**, only inside the signed-in seller's own varieties. Identifiers are filled only where blank. The match is recomputed on every run: **there is no persisted, verified, provider-scoped mapping table**. |
| 7 | Conflicts, duplicates, failures? | Conflicts: two-way stock conflicts go to `SyncConflicts` for the seller to decide; counts below reserved stock are never applied. Duplicates: duplicate rows in one import are rejected; double submits are guarded by a plan token and a per-form request id. Failures: recorded as `FAILED` on `SyncJobs` and on the connection with a plain message. There is no retry/backoff, no dead-letter queue and no per-event ledger. |
| 8 | Are credentials securely stored? | Google Sheets stores **no credentials** (the seller shares the sheet, only the sheet ID/tab/mapping are saved). Nothing else is stored. There is **no per-seller secret store yet**: the documented Excel plan puts refresh tokens in Script Properties keyed by connection. |
| 9 | Can the existing sync be extended safely? | **Yes.** It is well structured (connector registry → mapping → plan → preview → apply under the lock → ledger → `SyncJobs`). It should be extended, not replaced. See §5 for the one gap: it is *snapshot*-based (absolute quantities), which cannot represent a POS sale. |
| 10 | Is a native Mwakete POS present? | **No.** No POS screen, no walk-in sale record, no receipt, no cashier concept. The only mentions of "pos" in the code are unrelated words. |

## 2. Capability classification

| Capability | Status | Evidence |
|---|---|---|
| Stock model: `StockQty`, `ReservedQty`, available = `max(0, StockQty − ReservedQty)` | Implemented and verified | `Inventory.gs`; `tests/test-inventory-core.js` |
| Append-only stock ledger (`StockMovements`) with previous/new totals, source, reference | Implemented and verified | `recordStockMovements`; movement types include `SALE`, `RETURN`, `EXTERNAL_SYNC`, `SYNC_CORRECTION` |
| Order stock: reserve → deduct on Fulfilled → release / return on Cancelled, inside the script lock | Implemented and verified | `planOrderStockChange`, `actionCreateOrder` (lock at `Orders.gs:222`), tests |
| Server-side pricing (`Variants.Price`, bulk tiers) at checkout | Implemented and verified | `actionCreateOrder` ignores any client price |
| Checkout retry safety (`requestId` cached inside the lock) | Implemented and verified | `Orders.gs:206-232` |
| Locations, transfers, `LocationStock`, suppliers | Implemented and verified | `InventoryLocations.gs`. **Only for wholesalers/distributors** (`requireBulkSeller`); a retailer has no extra outlets. |
| CSV import (preview → apply), export | Implemented and verified | `InventorySync.gs`, `tests/test-inventory-csv.js` |
| Google Sheets source, preview/apply, two-way, conflicts, schedule | Implemented and verified (against an in-memory sheet) | `tests/verify-inventory-sync.js`. **Not exercised against Google's real APIs in this repo's tests.** |
| Held-stock rule (a count below reserved is never applied) | Implemented and verified | `buildImportPlan` |
| Excel / OneDrive | Missing (slot only) | `readRows` returns an error |
| Direct API / custom system | Missing (slot only) | `configured: false` |
| Webhook receiver, signature check, replay protection | **Missing** | no such action in `Code.gs` |
| Outbound events / order export to an external system | **Missing** | documented as "design (not built)" in `inventory-sync.md` §10 |
| Persisted product mapping (provider + account scoped, verified, auditable) | **Missing** | matching is recomputed each run |
| Per-event idempotency ledger | **Missing** | only a plan token and request-id cache |
| Retry with backoff, dead-letter / manual-review queue | **Missing** | failures are recorded, nothing retries them |
| External physical-sale ingestion (deltas) | **Missing** | the engine only applies absolute stock snapshots |
| Refund/return reconciliation against an external sale | **Missing** | `RETURN` exists only for cancelling a fulfilled online order |
| Payment truthfulness for in-person sales (cash vs digital, verified vs not) | **Missing** for POS. For online orders, payment is confirmed by the seller after checking their own account (`txVerifyPayment`); this is documented and sound. | `Transactions.gs` |
| Staff roles (cashier / manager) | **Missing.** The only identity is the store-owner session (`requireAuth`); there are no staff accounts. | `Auth.gs` |
| Native POS | **Missing** | none |
| Seller-facing sync page | Implemented | `owner/inventory-sync.html`, `assets/js/owner-inventory-sync.js` |
| Admin monitoring | Implemented | `adminInventoryOverview` |
| Scheduled jobs | Implemented (hourly `runReminderSweep` includes `runScheduledInventorySyncs`; 6-hourly badges; cache warming) | `Reminders.gs`, `InventorySync.gs` |

## 3. Source of truth (traced, not assumed)

- **Products / variants:** `Products` and `Variants` sheets. The stock record is a `Variants` row; its `VariantId` is the stable Mwakete ID.
- **Stock:** `Variants.StockQty` is the **total physical stock**; `ReservedQty` is held by open orders. Extra locations hold part of the total in `LocationStock`; the main location is `StockQty − Σ LocationStock`.
- **Reservations:** `ReservedQty`, changed only by `planOrderStockChange` / `applyOrderStatusStock`, always with a ledger row.
- **Orders:** the `Orders` sheet plus `TxState`/`TxEvents` order rooms. Statuses are `Pending Payment`, `Paid`, `Fulfilled`, `Cancelled`. Every order row is an *online* order: it has a customer account, delivery fields, an order room, invoices, badges, reviews and buyer notifications attached.
- **Payments:** online payment is arranged directly between buyer and seller; the seller verifies it against their own account. Mwakete holds no money for goods (only delivery fees for drivers, see `docs/driver-wallet.md`).
- **Permissions:** an owner session (`requireAuth`) and `owner.OwnerId` filtering on every inventory action; `isOwnerAdmin` for admins. Every inventory action is in `PROTECTED_POST_ACTIONS`.

## 4. Constraints of the platform (these shape the design)

1. **Apps Script web apps cannot read HTTP request headers** in `doPost`. Providers that sign webhooks in a header (for example Square's `x-square-hmacsha256-signature`) **cannot be verified directly** by this backend. A direct named-provider webhook needs a small relay that moves the signature into the request body. This is a genuine external prerequisite and is not worked around here.
2. **One global script lock.** Every stock-changing path takes `LockService.getScriptLock()` for up to 30 s. Slow external I/O inside the lock makes checkout wait.
3. **6-minute execution limit** per run; time-driven triggers cannot be sub-hourly in this project's existing pattern (`runReminderSweep` is hourly).
4. **Google Sheets is the database:** no transactions, so multi-step work needs a recoverable state machine.
5. **Per-seller secrets:** Script Properties are the only server-side secret store. Practical limit 9 KB per value, about 500 KB total.
6. **No outbound IP allow-listing**, and `UrlFetchApp` can reach any public URL, so any seller-supplied URL must be validated against SSRF.

## 5. Defects and gaps found

| # | Finding | Severity | Decision |
|---|---|---|---|
| D1 | The engine applies **absolute snapshots** (`StockQty = value`). A POS sale is a *delta* ("sold 3"). Treating a sale as a snapshot would overwrite concurrent online reservations and other outlets. | Design gap | Add a delta path (`SALE` / `RETURN` ledger rows) beside the snapshot path. Snapshots stay for CSV/Sheets only. |
| D2 | Sync **holds the global script lock while reading and writing the seller's Google Sheet** (`actionSyncNow`, `runScheduledInventorySyncs`). | Medium | Not changed (it works and is tested). New providers must fetch **outside** the lock and then re-plan and apply inside it, as `actionApplyInventoryImport` already does with its plan token. Documented. |
| D3 | No persisted mapping, so a changed SKU in the seller's system silently changes what a row matches, and nothing records who mapped what. | Gap | Add an auditable provider/account-scoped mapping table. Existing matching stays as the suggestion step. |
| D4 | No per-event ledger, so there is nothing to make a webhook or retry idempotent, and no activity log below the job level. | Gap | Add an event ledger keyed on provider + account + event id. |
| D5 | Outbound writes (`writeStock`) are not idempotent across retries and have no echo suppression for event-style providers. | Gap | Origin/correlation ids on every outbound and inbound event; echoes recorded as `echo` and not applied. |
| D6 | Locations exist only for wholesalers/distributors, so a retailer cannot represent two shops. | Limit | Keep. POS outlets map to existing locations for bulk sellers; retailers have one outlet. Documented, not widened. |
| D7 | No staff accounts, so cashier/manager roles cannot be enforced server-side. | Limit | A POS is **owner-only** in this release. Adding staff would need a new account type and login flow, which would be a second authentication mechanism. Documented as the next step, not faked with a hidden-button role check. |
| D8 | Any "online order" row triggers order rooms, emails, invoices, badges and statistics. | Design constraint | Walk-in POS sales must **not** be written into `Orders`. See §6. |

No security defect was found in the existing inventory actions: every one is
behind the owner session and filters by `OwnerId`, and inputs are validated
server-side.

## 6. Implementation decisions

1. **Extend, do not replace.** The existing connector registry, mapping, plan,
   preview/apply, `SyncJobs`, `SyncConflicts`, ledger and schedule stay as they
   are and are reused. New provider types are added to the same registry, and
   each declares its capabilities.
2. **Additive tables only** (created on first use, header-mapped, repeatable):
   `IntegrationMappings`, `IntegrationEvents`, `ExternalSales`,
   `IntegrationOutbox`. Existing sheets get no changed columns.
3. **One inventory model.** Every stock change, from an external sale, a
   return or the native POS, goes through `recordStockMovements`, adjusting
   `Variants.StockQty` under the script lock. There is no second balance.
4. **Physical sales are facts.** An external or native sale is applied as a
   delta. If it takes physical stock below what open orders have reserved, the
   sale is still recorded (the goods have left) and an **attention item** is
   raised for the seller. It is never silently dropped or silently hidden.
5. **Native POS sales live in their own record** (`PosSales`, `PosSaleLines`,
   `PosPayments`), not in `Orders`, because `Orders` rows are online orders with
   buyer-facing consequences (D8). Reports combine both. Stock still moves
   through the shared ledger.
6. **Honest payment status for in-person sales.** Cash is recorded as received
   by the seller. A card or mobile-money payment is recorded as
   **"recorded by the seller, not verified by Mwakete"** unless a provider
   confirmation exists. No screenshot or typed reference is ever treated as proof.
7. **Direct provider connections are pending**, and are shown as pending. The
   one working real-time integration is the **signed Mwakete push API**: any
   POS or middleware that can send JSON can post sales, returns and stock
   changes, with an HMAC signature, a timestamp window and replay protection
   (signature in the body because of constraint 1). Named providers (Square,
   Loyverse, Shopify POS, Lightspeed, Odoo) need an account/credentials to
   test and, for header-signed webhooks, a relay. Their feasibility notes are in
   `docs/pos-integration-architecture.md`.
8. **Offline checkout is not built.** The POS requires a live backend
   connection before a sale is committed.
9. **Feature flag.** A Script Property `POS_HUB` (`off` by default) controls the
   whole feature. Existing inventory features behave exactly as before.
10. **Secrets.** A signature check needs the server to know the secret, so a
    hash alone is not enough. The per-connection push-API secret is generated
    server-side, shown to the seller **once**, and kept only in **Script
    Properties** (`POSSECRET_<connectionId>`), never in a sheet cell. The sheet
    keeps only a short non-reversible key id so the seller can recognise it.
    No list action returns the secret, and logs never contain it. Rotating or
    disconnecting deletes the property. Script Properties are readable by
    people who can edit the Apps Script project, so project access is part of
    the security model (documented in the setup guide).
