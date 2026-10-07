# Mwakete Inventory & Stock Sync — developer guide

> Mwakete adapts to the business. The business does not have to rebuild its
> workflow around Mwakete.

Inventory is not a separate application. It is built into the existing
Mwakete stack — static GitHub Pages frontend, Google Apps Script backend,
Google Sheets as the database — and reuses the existing seller login,
products, variants and orders.

| Concern | Where |
|---|---|
| Stock model, ledger, order stock, seller stock actions | `apps-script/Inventory.gs` |
| Connectors, field mapping, preview → apply, Google Sheets, conflicts, schedule | `apps-script/InventorySync.gs` |
| Locations, transfers, suppliers, reports | `apps-script/InventoryLocations.gs` |
| Business types, Food rule, admin monitoring | `apps-script/Admin.gs` (`storeTypeOf`, `isBulkSeller`, `canListFood`, `actionAdminInventoryOverview`) |
| Seller pages | `owner/inventory.html` + `assets/js/owner-inventory.js`, `owner/inventory-sync.html` + `assets/js/owner-inventory-sync.js`, `owner/inventory-help.html` |
| Admin | `owner/admin.html` → *Inventory & sync* |
| Tests | `tests/test-inventory-*.js` (real `.gs` on an in-memory sheet via `tests/lib/gas-harness.js`), `tests/verify-inventory-*.js` (browser, pages against the real backend) |

---

## 1. Inventory model

A **variety** (one `Variants` row, e.g. *Rice – 25kg*) is the stock record.
Its existing `VariantId` is the stable **Mwakete ID** (`var_…`); its product is `prod_…`.

| Column | Meaning |
|---|---|
| `StockQty` | **Physical** stock on hand — the total across all locations. Blank = not tracked (unlimited), as before. |
| `ReservedQty` | Units held by open orders. |
| `SKU`, `Barcode`, `ExternalId` | Identifiers used for matching (SKU unique per store). |
| `ReorderLevel`, `ReorderQty` | Low-stock warning level and usual reorder amount. Mwakete never orders stock itself. |
| `CostPrice` | For stock value and reports. |
| `LastSyncedAt` | Last time an import/sync touched it. |

`available = max(0, StockQty − ReservedQty)` — this is what shoppers can buy
(`publicVariantFields.stockQty`). Health: **🟢 in stock · 🟡 low (available ≤ ReorderLevel) · 🔴 out · not tracked**.

The spec's universal fields map like this: `productId`→ProductId, `sku`→SKU,
`barcode`→Barcode, `productName`→Products.Name, `unit`/`variety`→Label,
`price`→Price, `cost`→CostPrice, `physicalStock`→StockQty,
`reservedStock`→ReservedQty, `availableStock`→computed, `reorderLevel`,
`reorderQuantity`, `externalProductId`→ExternalId, `locationId`→LocationStock,
`lastExternalUpdate`→LastSyncedAt, `lastMwaketeUpdate`→ledger.

All new columns/tabs were approved by the owner and are added **additively**
(`ensureColumn` / created on first use). Nothing existing moves or is deleted.

## 2. Stock ledger (`StockMovements`)

Every change to `StockQty` or `ReservedQty` writes a row:
`MovementId, OwnerId, ProductId, VariantId, LocationId, Quantity, MovementType,
PreviousStock, NewStock, PreviousReserved, NewReserved, Source, ReferenceId,
UserId, Notes, CreatedAt`.

Types: `INITIAL_STOCK, STOCK_RECEIVED, SALE, ORDER_RESERVED, ORDER_RELEASED,
RETURN, DAMAGED, EXPIRED, MANUAL_ADJUSTMENT, STOCK_TRANSFER, EXTERNAL_SYNC,
SYNC_CORRECTION`. `PreviousStock/NewStock` are the variety's **total**, except
on `STOCK_TRANSFER` rows, where they are that **location's** quantity.
`recordStockMovements` writes all rows of one change in a single sheet write.

## 3. Orders

Owner decision: **reserve, then deduct**.

| Order status | Stock state | Effect |
|---|---|---|
| placed (Pending Payment / Paid) | reserved | `ReservedQty += q` — `ORDER_RESERVED` |
| Fulfilled | sold | `StockQty −= q`, `ReservedQty −= q` — `SALE` |
| Cancelled (open) | released | `ReservedQty −= q` — `ORDER_RELEASED` |
| Cancelled (after Fulfilled) | released | `StockQty += q` — `RETURN` |

`planOrderStockChange` is a pure state machine; checkout and
`actionUpdateOrderStatus` apply it **inside the script lock**, together with
the order row, so two customers can never take the last unit and a status
never changes without its stock. Re-opening a cancelled order is refused if
the stock has gone. Orders placed before inventory existed have no ledger
rows and count as already deducted (cancelling one now returns its stock — this
fixed an old bug where cancellations lost stock).

## 4. Business types and capabilities

One engine, progressive screens. `storeTypeOf(owner)` → `retailer` (default,
and every older store) · `wholesaler` · `distributor` (multi-location).
`isBulkSeller` = wholesaler or distributor: Food & Groceries, the verification
call, and the advanced tools. `getInventory` returns `capabilities`:

| Capability | Retailer | Wholesaler / Distributor |
|---|---|---|
| Stock, receive, adjust, history, low stock, reports, import / sync | ✓ | ✓ |
| Suppliers, locations | — | ✓ |
| Transfers | — | ✓ once a second location exists |
| Purchase orders | not built (needs an unapproved tab) | |

## 5. Locations and transfers

The **total stays on `Variants.StockQty`** (so orders, reservations, shoppers
and sync are unchanged). Extra places hold part of it in `LocationStock`; the
main location is the rest: `main = StockQty − Σ LocationStock`. A one-shop
retailer needs no set-up. Transfers keep the total and log both sides
(`StockTransfers` + two `STOCK_TRANSFER` ledger rows). Receive / count / damage
can target a location. If the total falls below what the other locations hold
(e.g. a sale when the main location is empty), `rebalanceLocationStock` takes
the shortfall from them, largest first, and logs it (`Source: rebalance`).
A location can be closed only when empty.

## 6. Connector architecture

```
source ──connector.readRows()──▶ {headers, rows}
       ──saved field mapping──▶ records {fields, errors, line}
       ──buildImportPlan()────▶ plan {updates, writes, newProducts, conflicts, syncConflicts, unmatched, errors}
       ──preview (dry run) ───▶ seller confirms ──apply (re-plan + token check)──▶ changes + ledger + SyncJobs
```

`INVENTORY_CONNECTORS[type]` implements: `label`, `configured()`, `canWrite`,
`readRows(conn, input)`, optional `writeStock(conn, writes, stockHeader)`. The
engine never knows which source it is reading. The spec's
`connect/disconnect/testConnection` map to `saveInventoryConnection`,
`deleteInventoryConnection`, `testSheetConnection`;
`readProducts/readInventory` to `readRows`; `writeInventory` to `writeStock`.

| Connector | Status |
|---|---|
| `csv` | **Working.** Parsed in the browser (BOM, quotes, `,` `;` tab), rows posted. Export downloads the same columns, so files round-trip. |
| `googleSheets` | **Working** once `MWAKETE_SHARE_EMAIL` is set (Script Property). The seller shares their sheet with that account; only the sheet ID, tab, header row and mapping are stored. |
| `microsoftExcel` | **Not configured** — see §9. Shows as "Not connected yet". |
| `customApi` | **Not configured** — see §10. |

## 7. Field mapping and matching

A mapping is `{ "Their column": "mwaketeField" }` with fields `mwaketeId,
externalId, sku, barcode, productName, variantLabel, physicalStock, price,
costPrice, reorderLevel, reorderQty`. It must include one identifier and one
thing to update. The page guesses common names ("Item Code" → SKU,
"Stock Balance" → stock on hand, "Minimum Stock" → low-stock level) and saved
mappings are reused when the columns match.

**Matching priority:** Mwakete ID → external ID → SKU → barcode
(case-insensitive). **Never by name.** Only the signed-in seller's own varieties
are candidates. Identifiers are filled in only where blank, never overwritten.
Validation rejects non-numbers, negatives, fractions for whole quantities,
prices ≤ 0, duplicate rows for one item, files over 2,000 rows, and more than
200 new products per import. Unmatched rows are skipped unless the seller
chose "add as new products" (with a category; Food rule applies).

## 8. Synchronisation, preview and conflicts

**Modes:** `import` (their system is master — the default), `export` (Mwakete
is master; writes stock into their sheet), `twoWay`.

* **First sync is always a preview.** Nothing changes until the seller presses
  Apply. Apply rebuilds the plan under the lock and compares
  `importPlanToken`; if anything moved since the preview (an order, an edit)
  it refuses with "preview again".
* **Held stock:** a count below `ReservedQty` is never applied — it's reported
  as a conflict and the stock is left alone.
* **Two-way:** each connection keeps `SnapshotJson` — the number both sides
  agreed on at the last sync. Only Mwakete changed → write to the sheet. Only
  the sheet changed → import. **Both changed (or first sync and they differ) →
  `SyncConflicts` row; nothing is overwritten.** The seller chooses
  *Your sheet: 48 / Mwakete: 45 / Leave both*. Choosing moves the snapshot and
  runs a normal sync (so a value that moved again is caught, not overwritten).
  The same disagreement is never raised twice; "leave" isn't re-raised while
  the numbers stay the same.
* **History:** `SyncJobs` per run — read / created / updated / skipped /
  failed / conflicts, status `PENDING, RUNNING, SUCCESS, PARTIAL_SUCCESS,
  FAILED, CONFLICT`, and a summary of what was skipped.
* **Schedule:** `runScheduledInventorySyncs()` runs from the existing hourly
  `runReminderSweep` trigger for Google Sheets sources with automatic sync on,
  after their first previewed sync, oldest first, stopping before Apps
  Script's 6-minute limit.
* **Failures** (lost share, renamed column, tab gone) are recorded as `FAILED`
  with a plain-words message on the connection, and Mwakete stock is left
  unchanged. The seller sees it on the Sync Center card; admins see it too.
* **Duplicate submits:** stock actions carry a per-form `requestId` and the
  server answers a repeat from cache (`inventoryReplay`); imports are guarded
  by the plan token.

## 9. Microsoft Excel / OneDrive (not configured)

The connector slot exists (`microsoftExcel`) and reports **not configured**
until set up. It is not pretended to work. To build it:

1. **Owner decision (new account):** register a free app in Microsoft Entra ID
   (portal.azure.com → App registrations). Supported accounts: *personal and
   work/school*. Redirect URI: the Apps Script web-app URL (`…/exec`).
2. Delegated Graph permissions: `Files.ReadWrite`, `offline_access`, `User.Read`.
3. Store `MS_GRAPH_CLIENT_ID` and `MS_GRAPH_CLIENT_SECRET` as **Script
   Properties** (never in frontend code or the Sheet).
4. Per seller: OAuth authorization-code flow → refresh token stored in
   Script Properties keyed by connection (`MSTOKEN_<connectionId>`), never in a
   sheet cell.
5. `readRows`: `GET /me/drive/items/{id}/workbook/worksheets/{name}/usedRange(valuesOnly=true)`.
   `writeStock`: `PATCH …/range(address='C5')` per changed cell (or a batched
   `$batch` call). `UrlFetchApp` is already in the manifest scopes.

Until then sellers use **File → Save As → CSV** and the CSV importer.

## 10. Custom API / webhooks (future)

Standard Mwakete inventory record (JSON), the same shape the importer
understands:

```json
{ "items": [ { "mwaketeId": "var_…", "externalId": "POS-1001", "sku": "R-25",
  "barcode": "9300601…", "physicalStock": 120, "price": 30, "costPrice": 20,
  "reorderLevel": 10 } ] }
```

Design (not built): a POST action `inventoryPush` taking `{ connectionId,
apiKey, items }`. The key is shown to the seller once and only its SHA-256 is
stored on the connection; requests without a matching key are rejected
(Apps Script web apps can't read headers, so the key travels in the body over
HTTPS). It reuses `buildImportPlan` with `mode: 'import'`, honours held stock,
writes `EXTERNAL_SYNC` rows and a `SyncJobs` entry, and is rate-limited per
connection. Outbound events (`inventory.updated`, `order.created`,
`order.cancelled`, `order.completed`) would be POSTed to a seller URL signed
with an HMAC secret. Both need an owner decision before building.

## 11. Security

* Every action is behind the existing owner session (`PROTECTED_POST_ACTIONS`)
  and filters by `owner.OwnerId` — **Seller A can never read or change Seller
  B's stock, history, sources or conflicts** (tested in each suite).
* Admin monitoring requires `isOwnerAdmin` and shows no sheet IDs or links.
* No credentials are stored for Google Sheets (sharing, not keys). Future
  Microsoft/API secrets go in Script Properties, never sheet cells or frontend.
* Inputs are validated server-side; CSV export prefixes `= + - @` cells so a
  spreadsheet won't run them as formulas.

## 12. Deployment

See `DEPLOY.md`. New script files: `Inventory`, `InventorySync`,
`InventoryLocations` (each **+ → Script**). Set the Script Property
`MWAKETE_SHARE_EMAIL` for Google Sheets. Verify with `?action=getVersion`.
Tabs are created on first use.

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Checkout fails with "… is not defined" | `Inventory.gs` wasn't added before deploying. Add it, deploy a new version. |
| Google Sheets shows "Not connected yet" | `MWAKETE_SHARE_EMAIL` not set. |
| "Mwakete can't open that sheet yet" | The seller hasn't shared it with that address (Editor for write-back). |
| A sheet count isn't applied | It's below units held by open orders — shown as a conflict; fulfil/cancel orders first. |
| "Your stock changed since the preview" | An order or edit happened between preview and apply. Preview again. |
| Automatic sync not running | The hourly `runReminderSweep` trigger is missing, or the source never had its first previewed sync. |
| Location shows less than expected after a sale | A sale emptied the main location and the shortfall came from another — see the `rebalance` rows in Stock history. |
