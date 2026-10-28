# Mwakete POS — Stage Zero architecture report

Owner brief: "MASTER BUILD PROMPT — MWAKETE POS" (28 Oct 2026). This report is
the inspection the brief asks for before any code changes. It records what
already exists, what is missing, the risks, and the plan.

## 1. The stack as it really is

| Layer | What it is | What that means for the POS |
|---|---|---|
| Frontend | Static site on GitHub Pages (`mwakete.com`), vanilla JS, no framework, no bundler (`npm run build` only minifies). | The embedded and standalone POS can share plain JS modules directly — no second framework. |
| Backend | One Google Apps Script web app (`apps-script/*.gs`), single `doPost` dispatcher in `Code.gs`. | Every server rule lives in `.gs`. Deploys are manual (owner pastes files, new version, checks `?action=getVersion`). |
| Database | One Google Sheet. Tabs are tables; `sheetToObjects`, `appendRowFromObject`, `updateRowFromObject`. | **No real transactions.** Atomicity comes from `LockService` (one global script lock) plus validate-everything-before-writing. |
| Auth | Store owner session tokens (`Sessions` tab, `Auth.gs`); shopper accounts separate (`Customers.gs`). | **No staff accounts exist.** Every seller action is "the owner". |
| Push to browsers | None. Chat uses adaptive polling. Apps Script web apps **cannot** hold WebSockets or Server-Sent Events. | Real-time sync must be versioned polling. Sub-second propagation is **not achievable** on this platform (one Apps Script call alone takes ~0.5–3 s). |
| PWA | `manifest.json` (scope `.`), `sw.js` (versioned cache, network-first pages). | A standalone POS can be a second, separately scoped PWA on the same origin. |
| Tests | Node harness running the real `.gs` against an in-memory sheet (`tests/lib/gas-harness.js`, lock is a no-op), Playwright page tests. | New backend logic gets harness tests; UI gets Playwright tests. Concurrency is only simulated. |

## 2. What already exists and will be reused (not rebuilt)

* **Native POS** (`Pos.gs`, `owner/pos.html`, `owner-pos.js`), behind Script Property `POS_HUB`:
  search/scan (keyboard-wedge scanners), cart, **server-side pricing**, discount cap,
  tax-inclusive receipts, cash change, refunds with optional restock, reports,
  `clientTxnId` idempotency checked inside the lock, validate-all-then-move-stock.
  Tabs `PosSales`, `PosSaleLines`, `PosPayments`, `PosRefunds`, `PosSettings`.
* **One inventory** (`Inventory.gs`): `Variants.StockQty` physical, `ReservedQty`
  held for online orders, `Barcode`, `SKU`, `CostPrice`, `ReorderLevel`; the
  `StockMovements` ledger (every change is a row with before/after, source, user,
  reference). `applyStockDelta` (`IntegrationHub.gs`) is the single delta path.
* **Receiving, adjustments, movement history** (`receiveStock`, `adjustStock`,
  `listStockMovements`) with `requestId` replay protection; owner Inventory page.
* **Locations, transfers, suppliers** (`InventoryLocations.gs`, bulk sellers).
* **Wholesale tiers** (`ProductOptions.gs`, flag `WHOLESALE_TIERS`): bulk prices
  and minimum order per variant — one rule set, copied to the browser at build.
* **Online orders** stay in `Orders` with their own queue (`owner/orders.html`).
* **Integration hub** for external tills (signed push, mappings, reconciliation).
* Audit log (`Audit_Log`), formula-injection guard, owner/store isolation by `OwnerId`.

## 3. Gaps against the brief

| Brief requirement | Today | Plan |
|---|---|---|
| Standalone installable app | Embedded page only | New PWA at `mwakete.com/pos/` with its own manifest (scope `/pos/`), service worker and IndexedDB store. |
| Offline sales | Deliberately online-only | Durable IndexedDB sale + queue; server accepts late, idempotent uploads with original time and an `offline` flag. |
| Change cursor / recovery | None | New `PosChanges` log: per-store increasing `Seq`, written in the same locked section as every stock/price change; `posChanges(since)` returns missed changes or `resync: true`. |
| Shared domain logic | Server only | `assets/js/pos-core.js` used by both interfaces; server keeps the final say. Parity tests run the same cases through both. |
| Payment methods Cash / EFTPOS / IB / MPaisa + statuses | cash / card / mobile / other; received / recorded | New method set (old values still readable); statuses unpaid, partially paid, paid, pending verification, failed, refunded. IB/MPaisa default to pending verification; owner confirms. |
| Voids | Refunds only | Authorised void (same day, restock), linked record; sale rows never edited. |
| Offline oversell | n/a | Physical sale is a fact: stock floors at 0, shortfall recorded as a reconciliation case for review — never last-write-wins. |
| Wholesale prices at the till | Normal price only | Apply the same bulk-tier rule (`ProductOptions.gs`) when the store has tiers. |
| Staff roles, devices | Owner only | `PosStaff` + `PosDevices`: roles Owner, Manager, Cashier, Inventory Manager, Reports; device registration and revocation; enforced in `Code.gs` before each POS action. **Sign-in method needs an owner decision (below).** |
| Cashier shifts | None | Open float, cash in/out, expected vs counted, variance, audit. |
| Camera barcode | Keyboard scanners only | Native `BarcodeDetector` where present, else ZXing (free, MIT, loaded only when the camera opens). Barcodes stay strings (leading zeros kept). |
| Sync Centre | Inventory-sync page (CSV/Sheets) only | New Sync Centre in the POS app: pending count, last sync, errors, conflicts, cursor, retry. |

## 4. Risks

* **No database transactions.** A failure between two sheet writes inside the lock
  can leave a sale without its movement. Mitigation: validate everything first,
  write the sale row last, and a repair check that finds sales whose movements
  are missing. Documented, not hidden.
* **One global script lock, 30 simultaneous executions, daily quotas.** Polling
  every device every second would exhaust Apps Script. Polls are cheap (a cached
  "latest Seq" check answers "nothing new" without reading sheets) and adaptive
  (fast after activity, slower when idle, paused when hidden).
* **Sheet growth.** `PosChanges` is trimmed: clients that fall behind the oldest
  kept change are told to resync (full reload of their catalogue), not given a gap.
* **Browser storage can be cleared.** The app warns while sales are unsynced and
  on sign-out; nothing pending is deleted by sign-out, expiry or revocation.
* **Not a native APK.** An installable PWA (Android Chrome, desktop Chrome/Edge).
  No APK will be claimed.
* **Sub-second sync target cannot be met on Apps Script.** It will be measured and
  reported honestly.

## 5. Plan (separate PRs, each tested before the next)

1. Backend sync foundation — change log + cursor endpoint, offline/late sale upload,
   new payment methods and statuses, voids, reconciliation cases, wholesale tiers.
2. Shared `pos-core.js` + embedded till moved onto it.
3. Standalone PWA `/pos/` — checkout, inventory workspace, Sync Centre, offline queue.
4. Staff roles, devices, shifts, reports, camera scanning, online-order queue view.
5. Acceptance tests (section 24), latency measurement, docs, deploy steps.

All of it stays behind `POS_HUB`, so nothing changes for stores until it is switched on.

## 6. Owner decisions (28 Oct 2026)

* **Staff sign-in:** the owner signs in once on each till and registers it; staff use a
  4–6 digit PIN with a role. The server checks device + PIN session + role on every action.
* **Offline oversell:** allowed (the sale happened); stock stops at 0 and a review case is
  created for the owner. No per-till offline allowances.
* **Roll-out:** every approved store, once `POS_HUB` is on.
* **Payments:** Cash = paid. EFTPOS = paid, recorded from the bank terminal (no
  integration). IB and MPaisa = pending verification until a manager or the owner
  confirms (or marks it failed).
