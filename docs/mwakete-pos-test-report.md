# Mwakete POS — acceptance test report (28 Oct 2026)

Covers the brief's section 24 tests and section 25 delivery list. Every result
below was run in the build sandbox. **Nothing here was run against the real
Apps Script runtime, a real phone, a real camera, a real printer or the real
network** — see "Not tested" at the end.

## How it was tested

| Suite | What it is | Result |
|---|---|---|
| `tests/test-pos-sync.js` | Real `.gs` code in the Node harness (in-memory sheets; lock is a no-op) | 69/69 |
| `tests/test-pos-staff.js` | Same harness: tills, staff, PINs, sessions, shifts, online orders | 37/37 |
| `tests/test-pos-native.js` | Older till tests, updated for the new payment wording | pass |
| `tests/verify-pos-app.js` | Playwright (Chromium) — the embedded till and the standalone app open side by side, both talking to the real `.gs` code through `tests/lib/pos-live-backend.js` | 48/48 |
| `tests/verify-pos-hub.js` | Playwright — existing POS/Integration hub page | 16/16 |
| Full regression | Every `tests/*.js` | see "J" |

## A. Dual-interface equivalence — implemented and tested

* Both interfaces mount the same `pos-app.js` and the same price rules
  (`pos-core.js`, generated from `PosCore.gs`). Only the session wrapper differs
  (`pos-embedded.js`, `pos-standalone.js`). *(verify-pos-app A)*
* Till and server work out the same totals (bulk prices, merged lines,
  discounts, minimum quantity). *(test-pos-sync)*
* Permissions are checked on the server for every POS action, for owner and
  staff alike (`POS_ACTION_PERMS` in `PosStaff.gs`). *(test-pos-staff)*
* Neither interface owns stock; both load from and write to Mwakete. *(B tests)*
* Feature gap: the embedded till is owner-only, so the till-registration and
  staff PIN sign-in parts exist only in the standalone app (by design).

## B. Two-way synchronisation — implemented and tested

* An embedded sale shows on the standalone till without a reload, and the
  reverse. Goods received on one show on the other. *(verify-pos-app B)*
* A price change reaches the other till; the earlier sale keeps its price.
* A dashboard stock adjustment reaches the tills (`Inventory.gs` hook).
* Updates are small change records (absolute stock values), not a full
  catalogue download. Two connected tills tested; more is the same code path.

## C. Event recovery — implemented and tested

* Each till saves its change cursor in IndexedDB, in the same transaction as
  the changes it applied.
* A gap, a cursor ahead of the server, or a nonsense cursor makes the till
  reload its catalogue — never a silent skip. *(test-pos-sync, verify-pos-app C)*
* A failed change-log write still bumps the counter, so it shows as a gap and
  the tills reload: a lost notice cannot lose a stock change.
* Change log kept 14 days (`trimPosChanges`, needs a daily trigger — see guide).

## D. Offline operation — implemented and tested

* Offline sales are saved to IndexedDB **before** the receipt shows, which says
  "Saved on this till — not yet confirmed by Mwakete". Till receipt number
  `R-YYYYMMDD-CODE-n`.
* Local stock drops at once; Mwakete is not changed until upload.
* Waiting sales survive an app restart and a catalogue reload.
* Back online: uploaded once each, marked "made offline", original time kept.
* Lost answer: the till says "awaiting answer", not success or failure; the
  same reference sent again creates no second sale. *(verify-pos-app D2)*
* Sign-out, session expiry and till revocation never delete waiting sales.

## E. Concurrent sales and reconciliation — implemented and tested

* Two tills sell the last item offline: both sales kept, stock stops at 0
  (not negative, not "last till wins"), an "oversold" case is opened and shows
  in Reviews. Online, the same oversell is refused before anything is sold.
* Offline sale at an old price or over the discount limit: the sale stands as
  paid, with a case. No per-till offline stock allowance (owner decision).

## F. Inventory and pricing — implemented and tested (scanning: partly)

* Keyboard-type scanners (USB, and Bluetooth in keyboard mode): tested with
  typed key bursts in Chromium. `0093000017` kept as text with leading zeros.
* Camera scanning: written (BarcodeDetector, else ZXing 0.21.3), **not tested**
  on a real camera.
* Retail/wholesale toggle uses the same bulk-tier rule as the website;
  minimum quantity checked on both sides. Package conversions: **not
  implemented** (no pack/unit data in the catalogue today).
* Price overrides and credit sales need Manager or owner; refused for cashiers
  on the server.
* Receiving and adjustments go through the existing `StockMovements` ledger,
  with who/which till; a repeat of the same operation is ignored even hours later
  (durable `[op:…]` tag). Offline stock counts are refused (they would
  overwrite sales made since).
* Refunds (optional restock) and same-day voids: Manager/owner, audited; a
  voided sale cannot be refunded.

## G. Payments — implemented and tested (no integrations)

* Cash: short money refused, change correct. Shift expected cash = float +
  cash sales − cash refunds/voids ± cash moves (EFTPOS not counted).
* EFTPOS: recorded as paid from the bank terminal; labelled "not connected".
  **No EFTPOS integration exists.**
* IB and MPaisa stay "pending verification" until a Manager/owner confirms or
  marks failed. Nothing auto-confirms, and the till has no screenshot upload.
* Reports split by method and status; voids left out of gross; refunds shown.

## H. Security — implemented and tested

* Every query is scoped by store (`OwnerId`); cross-store reads, confirms,
  voids and edits are refused. *(both harness suites)*
* Roles enforced on the server; a cashier calling void directly is refused.
* Till secret and staff sessions are stored hashed; PINs with PBKDF2;
  5 wrong PINs lock that person for 15 minutes; 20 tries per 15 minutes per till.
* A revoked till's sessions end at once and it cannot sign anyone in.
* Cost prices are not sent to roles that may not see them (checked in the
  cashier's IndexedDB too).
* Frontend holds no secrets: only the public Apps Script URL. The till secret
  is per device, created by the owner's session.
* POS, till and staff changes are written to `Audit_Log`.

## I. Synchronisation performance — measured; target **not met**

* Environment: Playwright Chromium, both tills on one machine, backend is the
  real `.gs` code run in-process (no Apps Script, no internet). Polling every
  3 s while active (12 s quieter, 45 s idle, paused when hidden).
* Measured from the backend accepting a change to it showing on the other till:
  **8 updates, median ≈ 2.94 s, 95th percentile ≈ 2.95 s.**
* Recovery: gap → catalogue reload tested; offline → reconnect upload tested.
* **The sub-second target was not met** and cannot be on this backend: Apps
  Script web apps cannot push (no WebSockets/SSE), so tills poll. On the real
  service each call also takes about 0.5–3 s, so real-world delay will be
  higher than measured here. The till shows its own measured delay in Sync
  Centre. This is a measurement under the stated conditions, not a guarantee.

## J. Build and regression

* No type checker or linter is set up in this project; `node --check` syntax
  check run on all new/changed JS and `.gs` files: clean.
* `npm run build:check`: clean (93 built files match source).
* No database migration tool exists; new sheets/columns are created on first use
  (additive only).
* PWA checks: `verify-pwa`, `verify-manifest`, plus the installability and
  offline checks inside `verify-pos-app`.
* Full regression: REGRESSION_RESULT

## Status matrix

| Area | Status |
|---|---|
| Embedded till, standalone PWA, shared rules | Implemented and tested |
| Change log, cursors, gap recovery | Implemented and tested |
| Offline sales queue, idempotent upload, lost-answer handling | Implemented and tested |
| Offline oversell → review case | Implemented and tested |
| Staff PIN, roles, till registration/revocation | Implemented and tested |
| Shifts and cash drawer | Implemented and tested (online only) |
| Refunds, voids, price edits, show/hide products | Implemented and tested (online only) |
| Goods received / damage while offline | Implemented and tested |
| Reports, Sync Centre, Reviews, online orders view | Implemented, tested in part (the screens open and show data; not every number cross-checked in the browser) |
| Receipts and printing | Implemented; browser print only, **no real printer tested** |
| Camera scanning | Implemented, **not tested** on a real camera |
| Wholesale price mode | Implemented and tested |
| Package/unit conversions | **Not implemented** (no data for it yet) |
| Per-till offline allowances | **Not implemented** (owner decision) |
| EFTPOS / IB / MPaisa integrations | **Not implemented** — manual recording only |
| Native APK | **Not built** — installable PWA only |
| Sub-second sync | **Not met** (≈3 s measured locally) |
| Change-log trimming | Implemented; **needs a daily trigger** set by the owner |
| Real Apps Script deploy | **Blocked** on the owner's manual deploy and `getVersion` check |

## Not tested

Real Apps Script runtime (quotas, lock waits, real concurrency), real network
and latency, real phones and installs, the camera and ZXing download, Bluetooth
scanners in non-keyboard modes, printing, Safari/iOS storage eviction.

## Files and services

* **New backend:** `apps-script/PosCore.gs`, `PosSync.gs`, `PosStaff.gs`.
* **Changed backend:** `Pos.gs`, `Inventory.gs`, `Products.gs`, `Code.gs`
  (`APP_VERSION` `pos4-2026-10-28`).
* **New sheets (made on first use):** `PosChanges`, `PosCases`, `PosDevices`,
  `PosStaff`, `PosSessions`, `PosShifts`; new columns on `PosSales`,
  `PosSaleLines`, `PosPayments`. Script Properties `POSSEQ_<ownerId>` (counter).
* **Frontend:** `assets/js/pos-core.js` (generated), `pos-db.js`, `pos-sync.js`,
  `pos-app.js`, `pos-camera.js`, `pos-embedded.js`, `pos-standalone.js`,
  `assets/css/pos.css`; `owner/pos.html`, `owner/pos-app.html`,
  `pos/index.html`, `pos/manifest.webmanifest`, `pos/sw.js`; root `sw.js`
  (keeps the till's cache). Removed: `assets/js/owner-pos.js`.
* **Outside service:** ZXing (MIT) from jsDelivr, loaded only when the camera
  opens on a browser without a built-in barcode reader. No paid service.
* **Tests:** `tests/test-pos-sync.js`, `tests/test-pos-staff.js`,
  `tests/verify-pos-app.js`, `tests/lib/pos-live-backend.js`; updated
  `test-pos-native.js`, `verify-pos-hub.js`, `tests/lib/gas-harness.js`.
