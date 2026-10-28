# Mwakete POS — deploy, install and recovery guide

The till has two faces that run the same code (`assets/js/pos-app.js` and the
shared price rules `pos-core.js`) against the same Apps Script backend:

* **Embedded** — `mwakete.com/owner/pos.html`, inside the seller dashboard.
  Store owner only.
* **Standalone** — `mwakete.com/pos/`, an installable app (PWA) with its own
  manifest, service worker (`/pos/sw.js`, scope `/pos/`) and offline store.
  Store owner, or staff by PIN on a till the owner registered.

Neither keeps its own stock. Mwakete's `Variants` sheet is the only stock;
each till keeps a copy in IndexedDB that it updates from the change log.

## 1. Deploy the backend (manual — owner)

Apps Script deploys cannot be done or checked from the build sandbox.

1. Open the Apps Script project.
2. **Add** these files (File → New → Script, same names):
   `PosCore.gs`, `PosSync.gs`, `PosStaff.gs`.
3. **Replace** the contents of: `Pos.gs`, `Inventory.gs`, `Products.gs`, `Code.gs`.
4. Save, then **Deploy → Manage deployments → Edit → New version → Deploy**.
5. Check: open `<web app URL>?action=getVersion` — it must show
   `"version":"pos4-2026-10-28"`. If it shows anything else the new version is
   not live yet.
6. To switch the till on for all approved stores: **Project Settings → Script
   Properties → `POS_HUB` = `on`**. With it off, every POS action answers
   "not switched on" and nothing changes for stores.
7. Optional (recommended): **Triggers → Add trigger → `trimPosChanges`,
   time-driven, daily**. It removes change-log rows older than 14 days
   (Script Property `POS_CHANGES_KEEP_DAYS` changes that). A till that is
   offline longer than that simply reloads its catalogue when it returns.

New sheets (`PosChanges`, `PosCases`, `PosDevices`, `PosStaff`,
`PosSessions`, `PosShifts`) and new columns on the existing `Pos*` sheets are
created automatically on first use. Nothing is deleted or renamed.

The frontend deploys with the GitHub Pages merge; nothing else to do.

## 2. Install the standalone app

* **Android (Chrome):** open `mwakete.com/pos/`, then menu (⋮) →
  **Install app** (or **Add to Home screen**).
* **Computer (Chrome or Edge):** open `mwakete.com/pos/`, then the install icon
  in the address bar, or menu → **Install Mwakete POS**.
* **iPhone/iPad (Safari):** Share → **Add to Home Screen**. Works, but Safari
  may clear site data of apps not opened for weeks — sync before leaving it.

There is no APK. Updates arrive by themselves: the app checks for a new version
each time it opens online.

## 3. Set up a till for staff

1. The owner opens the app on the till device and signs in (same seller sign-in).
2. **Settings → This device as a till** → name it → **Use this device as a till**.
   The till's secret is kept on that device only; the server stores a hash.
3. **Settings → Staff** → add each person with a role and a 4–6 digit PIN.
   Roles: Manager, Cashier, Inventory, Reports.
4. **Hand over to staff** signs the owner out on that device. Staff then pick
   their name and type their PIN. A staff session lasts 12 hours and works
   only on that till.

Staff sign-in needs a connection. Once signed in, the till keeps selling if the
connection drops.

## 4. Payments

| Method | Status at the till | Notes |
|---|---|---|
| Cash | Paid | Change worked out; counts towards the drawer. |
| EFTPOS | Paid | Recorded from the bank terminal. **Not connected** to any bank — the cashier confirms the terminal said approved. |
| IB (internet banking) | Pending verification | A Manager or the owner confirms it in **Payments** once the money is seen, or marks it failed. A screenshot never confirms it. |
| MPaisa | Pending verification | Same as IB. |

## 5. Recovery and diagnostics

Open **Sync Centre** on the till. It shows: waiting sales and stock changes,
failed items with the reason, last successful sync, the change cursor, and
measured update times. **Sync now** sends everything waiting; **Send again** retries one failed item;
**Check unconfirmed sales** asks Mwakete which uncertain sales it already has.

| Problem | What to do |
|---|---|
| "Saved on this till" receipts | Normal when offline. They upload by themselves when back online; nothing to re-enter. |
| A sale is "awaiting answer" | The answer was lost. Press **Check unconfirmed sales** — the same sale is never recorded twice. |
| Something failed to upload | Sync Centre shows why (for example a sale over 30 days old). Ask the owner; the sale is kept on the till. |
| Stock looks wrong on one till | Sync Centre → **Reload catalogue**. Waiting sales are kept and still counted. |
| "Oversold" or "price differs" in Reviews | An offline sale happened that Mwakete could not fully match (last item sold twice, old price). The sale stands; a Manager or the owner checks the shelf and closes the case with what was done. |
| Till was revoked / staff session expired | Waiting sales are **not** deleted. The owner signs in on that device to send them. |
| Browser data | **Do not clear site data** for mwakete.com while anything is waiting — that deletes the unsent sales. The app warns before signing out with sales waiting. |

## 6. Online-only actions

These need a connection and say so if tried offline: staff sign-in, shift
open/close and cash moves, voids, refunds, price and product edits, stock
counts (an offline count would overwrite sales made since), confirming IB and
MPaisa. Sales, goods received and damage/loss adjustments work offline and
upload later.
