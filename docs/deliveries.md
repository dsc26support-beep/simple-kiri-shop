# Mwakete drivers and deliveries

Stage 6 of the dashboard modernisation, October 2026. The owner said: "pick what is best for Mwakete".

| | Where |
|---|---|
| Backend | `apps-script/Deliveries.gs` |
| Pages | `driver.html` + `assets/js/driver.js`; the delivery panel in `order-room.html`; Admin → **Deliveries & drivers** (`assets/js/admin-deliveries.js`) |
| Tests | `tests/test-deliveries.js` (backend, 61 checks); `tests/verify-deliveries.js` (browser against the real backend, 24 checks) |

## What was chosen, and why

| Decision | Choice | Why it suits Mwakete |
|---|---|---|
| Who drives | Independent drivers, in South Tarawa first (`DELIVERY_AREAS`) | This is where most orders and trucks are. Outer islands can be added to the property later. |
| Driver accounts | A normal customer account that **applies** to drive; an admin **approves** them | There is no new login system, and people are vetted. |
| Who pays the driver | **The seller pays directly,** at the fee the seller offered when booking | Mwakete never holds money, which is already its rule. Checkout prices are unchanged. |
| When the driver sees the buyer | Only after accepting a job: name, phone, village and items | Personal details go only to the person doing the delivery. |
| What pickup means | The driver's "collected" **is** the order's dispatch record | One record, no double entry. Stock leaves the shelf at that moment. |
| Proof of delivery | A required photo plus the recipient's name, both stored privately with the order | The same private storage as order-room evidence. |
| Who completes the order | Still the buyer, by confirming receipt | A driver's record never completes an order on its own. |
| Live location | Opt-in, from the phone's browser GPS, at most one point every 30 seconds, only during an active job, only the last point kept and wiped when the job ends. Shown to the seller, buyer and admin as an OpenStreetMap link. | No paid map or GPS service and very little data. Private by default. |
| Failure | The driver reports a reason and a note. If the driver already has the goods, they return them to the store, and the seller can book again or send another way. | Clear and recorded. Nothing is lost. |

## How a delivery works

1. The seller confirms payment (or ticks "send before payment") and checks the goods. Then, in the order room, they tap **Request a Mwakete driver**: fee, where to collect, notes.
2. Approved drivers who are **online** in that area see the job, showing only the store, the drop-off village, the item count and the fee. They also get one short email at most every 15 minutes.
3. A driver accepts. Only one driver can win the job, and a driver can hold at most 3 active jobs. The seller and buyer see the driver's name, vehicle and phone.
4. The driver may switch on **Share my live location** for that job.
5. **I've collected the goods**: the order becomes "sent", recorded as the driver's dispatch.
6. **Delivered**, with a photo and the recipient's name, or **Couldn't deliver**, with a reason. The location is wiped either way.
7. The buyer confirms receipt in the order room, which completes the order.
8. The seller pays the driver and taps **I paid the driver**. The driver's page shows fees earned and fees marked paid.

**Cancelling.** The seller can cancel a job until the driver has the goods; after that, only an admin can. Cancelling the order cancels any job the driver hasn't collected yet.

## Admin

Admin → **Deliveries & drivers** shows:
- **Counts:** jobs waiting for a driver, on the way, failed, stuck, drivers online, and applications pending.
- **Drivers:**
  - Approve only after speaking to the person.
  - Reject or Suspend need a reason, and the driver sees it.
  - An admin can't approve their own application.
- **Jobs:** filter by Active, Failed or stuck, Delivered or All, each linked to its order room (admin view), with a live-location link while shared.
- **What counts as stuck:**
  - waiting more than 6 hours for a driver;
  - accepted more than 6 hours ago but not collected;
  - collected more than 24 hours ago but not delivered.

## Switching it on

The backend deploy is manual:
1. Add a new file `Deliveries` and paste `apps-script/Deliveries.gs`.
2. Update `Code.gs` and `Transactions.gs`, then deploy a new version.
3. `?action=getVersion` should show `deliveries1-2026-10-15` (or any later version, e.g. `bulkprices1-2026-10-15`), and `checkSetup` should show `missingFiles: []`.

Script Properties:

| Property | Value |
|---|---|
| `DELIVERY_JOBS` | `on` (default off: nothing is visible) |
| `DELIVERY_AREAS` | optional; default `South Tarawa` (comma-separated island names) |
| `TX_ROOMS` | must be on (or pilot) for the stores using drivers |

Two tabs, `Drivers` and `DeliveryJobs`, are created on first use. Nothing existing changes.

**Rollback:** set `DELIVERY_JOBS` to `off`. The driver page closes and sellers no longer see the option. Records are kept.

## Not included, on purpose

- **Driver payouts through Mwakete:** Mwakete doesn't handle money.
- **Route optimisation or turn-by-turn navigation:** drivers get a map search link for the village.
- **Background tracking when the page is closed:** browsers don't allow it without an app, and it would cost battery and data.
