# Driver wallet — paying drivers through Mwakete

Owner-approved plan, October 2026. Phase 1 (money ledger) and phase 2 (job chat and fee agreement) are built.
Both stay invisible until `DELIVERY_PAYMENTS` covers a driver.

| | Where |
|---|---|
| Backend | `apps-script/DriverWallet.gs` |
| Tests | `tests/test-driver-wallet.js` (48), `tests/test-delivery-chat.js` (30), both on the real backend sources |
| Pages | `driver.html` (`assets/js/driver.js`) and the delivery panel of `order-room.html` (`assets/js/order-room.js`) |
| Builds on | `apps-script/Deliveries.gs`, `docs/deliveries.md` |

## What was decided (owner approved, small-startup defaults)

| Question | Decision |
|---|---|
| Who pays the fee into Mwakete | The **seller**, as today |
| Minimum payout | **$20**, paid in one batch every Friday (`DRIVER_MIN_PAYOUT`) |
| Holding customer money | **Pilot first:** South Tarawa, at most 5 approved drivers, delivery fees only. Take legal advice before going live. |
| Failed delivery, before pickup | Full refund to the seller |
| Failed delivery, after pickup | Driver is paid if the buyer was unreachable, refused, or the address was wrong. An admin decides if goods were damaged. |
| Dispute hold | **48 hours** after the buyer confirms receipt (`DRIVER_HOLD_HOURS`) |
| Commission | **0%** at launch. Gross fee and commission are already recorded on every credit. |
| Chat | A small private seller-and-driver chat per job (`DeliveryMessages` tab). I first planned to reuse the order-room timeline, but that is visible to the buyer and the driver has no access to it, so a separate small tab is safer. |
| Left out for now | Buyer-pays, automatic payouts, a payment gateway |

## How the ledger works

`DriverLedger` is **append-only**. A balance is never stored; it is always added up from the rows.
A mistake is fixed with a new `ADJUSTMENT` row that carries a reason, never by editing a row.

| Entry | Amount | Meaning |
|---|---|---|
| `CREDIT` | + | Net fee for a delivered job, once per job. Available after the hold. |
| `CLAIM` | − | The driver asked for their whole available balance. It leaves "available" at once, so it cannot be claimed twice. |
| `PAYOUT_PAID` | 0 | An admin paid that claim; the bank reference is recorded. |
| `CLAIM_REVERSED` | + | An admin gave an unpaid claim back (wrong bank details, bounced transfer). Needs a reason. |
| `ADJUSTMENT` | ± | Admin correction. Needs a reason. |

Balance fields: `total`, `available` (hold over), `pending` (inside the hold), `claimed` (owed by an admin), `paidOut`.

A double tap on **Claim** carries the same request id and returns the claim already made.

## Phase 2: job chat and fee agreement

Only for a driver covered by `DELIVERY_PAYMENTS` (everyone else works exactly as before).

1. The seller's booking fee is the first offer. The seller has agreed to it.
2. Once a driver accepts, seller and driver can message each other (up to 1000 characters, 20 a minute). **The buyer never sees the chat or the fee talk.**
3. While the job is *accepted* and the fee is not locked, either side can **propose** a new fee (above 0, up to 500). That resets the other side's agreement.
4. The other side taps **Agree** on the exact amount shown. A stale amount is refused. When both have agreed, the fee **locks**.
5. The driver cannot tap *I've collected the goods* until the fee is locked.
6. After pickup the chat stays open to talk, but the fee is fixed.

The other side gets an email at most every 10 minutes per job. Locking is recorded in the audit log (`DELIVERY_FEE_LOCKED`).

New columns on `DeliveryJobs` (`FeeProposedBy`, `FeeSellerOk`, `FeeDriverOk`, `FeeLocked`) are appended automatically to an existing sheet. New tab `DeliveryMessages`. New actions: `txJobMessage`, `txProposeFee`, `txAgreeFee`, `driverJobMessage`, `driverProposeFee`, `driverAgreeFee`.

Messages update when the page reloads or on **Refresh messages** (seller) and every 30 seconds (driver page). There is no live push.

## Script Properties

| Property | Value |
|---|---|
| `DELIVERY_PAYMENTS` | `off` (default), `pilot` or `on`. Anything else is off. |
| `DELIVERY_PAYMENTS_DRIVERS` | For `pilot`: comma-separated `DriverId`s. Only the first 5 count, and only on South Tarawa. |
| `DRIVER_MIN_PAYOUT` | Default 20. Must be 1 to 10000. |
| `DRIVER_HOLD_HOURS` | Default 48. Must be 0 to 720. |
| `DRIVER_COMMISSION_PCT` | Default 0. Must be 0 to 100. |

A bad value falls back to the default.

## Switching phase 1 on

1. Add a new file `DriverWallet` and paste `apps-script/DriverWallet.gs` (once, from phase 1).
2. Update `Deliveries.gs` and `Code.gs`, then deploy a new version.
3. `?action=getVersion` should show `wallet2-2026-10-21` (or later) and `checkSetup` should show `missingFiles: []`.
4. The front end (`driver.min.js`, `order-room.min.js`, `styles.min.css`, `sw.js`) goes live when the branch is merged and GitHub Pages rebuilds.

To try phase 2 on one driver: set `DELIVERY_PAYMENTS` = `pilot` and `DELIVERY_PAYMENTS_DRIVERS` = that driver's `DriverId` (South Tarawa only). Phase 2 only adds the chat and the fee lock; no money moves yet. Do **not** set `DELIVERY_PAYMENTS` until phase 5 has rewritten the wording below.

## Before this can go live

Mwakete currently says it **never holds money**. That sentence is in `terms.html`, `order-room.html`,
`customer-dashboard.html`, `docs/transaction-rooms.md`, `docs/deliveries.md` and the comments in
`Transactions.gs`. Phase 5 rewrites it, limited to delivery fees, and legal advice comes first.
Every later phase ships behind `DELIVERY_PAYMENTS`.

## Phases

1. **Ledger** (done).
2. **Chat and fee agreement** (done).
3. Seller pays Mwakete; an admin confirms the real bank statement; pickup details are released after.
4. Credit on buyer receipt, driver balance page and Claim, admin payout queue.
5. Wording and terms.
6. Tests across the whole flow.
