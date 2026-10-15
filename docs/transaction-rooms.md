# Order rooms — transaction messages, evidence and problem reports

Owner request, October 2026. Backend: `apps-script/Transactions.gs`.
Page: `order-room.html` with `assets/js/order-room.js`.
Admin: the "Order problems" section of `owner/admin.html`, driven by `assets/js/admin-tx.js`.
Tests:
- `tests/test-tx-rooms.js`: backend, 181 checks.
- `tests/verify-tx-room.js`: the browser pages running against the real backend, 46 checks.

Every order gets a private **order room** where the buyer and seller:
- talk about that order,
- add photos and receipts,
- record payment, packing, dispatch, collection and receipt,
- report problems.

Mwakete admins review those problems.

**What Mwakete is not.** Payment is arranged directly between the buyer and the seller, and Mwakete never holds the money. Nothing here is escrow, insurance or a guarantee.
- A screenshot is what the buyer *says* they paid. Only the seller, looking at their own account (or the cash in their hand), confirms the money arrived.
- A dispatch record is what the seller *says* they sent. Only the buyer confirms it arrived.

---

## A. Architecture

### How a room is linked to an order

A room is keyed by the order's own `OrderId`. Nobody types an order number to get in.

**Who can open a room.** Each person is identified by a session the server checks on every request:

| Side | Who | Check |
|---|---|---|
| buyer | signed-in customer | `requireCustomerAuth`, and the verified email equals `Orders.CustomerEmail`. This is the same rule "My orders" already uses. |
| seller | store owner | `requireAuth`, and `OwnerId` equals `Orders.OwnerId`. |
| admin | owner session listed in `ADMIN_EMAILS` | `isOwnerAdmin`. Can read any room. Can never make decisions on an order where they are the buyer or the seller. |

- **What `side` does.** The page sends `side=buyer|seller|admin`. That only tells the server which session table to check; the page can never choose who it is.
- **Wrong order.** "Order not found" is the same answer whether the order is missing or belongs to someone else, and the attempt is logged (`TX_ACCESS_DENIED`).
- **Guest checkouts.** Checkout requires an email. A guest buyer creates an account or signs in with that same email to open the room, and the link brings them back to the room afterwards.

### Data: new tabs only (created on first use)

None of these tabs touch Orders except through its existing `Status` column.

| Tab | Holds |
|---|---|
| `TxState` | One row per room: `Flow` (v1/legacy), `PaymentState`, `FulfilmentState`, `ReceiptState`, `RefundState`, `OpenDisputeId`, `Hold`, `Version` (stale-edit check), `LastSeq` and read marks. |
| `TxEvents` | The timeline: messages, automatic prompts and step records. `Audience` limits a prompt to one side or to admins. |
| `TxEvidence` | One row per file: who added it, its category and stage, the private Drive file id, an optional thumbnail id, the type and size checked by the server, its dimensions, a SHA-256 hash, review status and retention state. |
| `TxRecords` | Append-only facts: payment submissions and verifications, checklists, ready, dispatch, delivered (as reported by the seller), handover, receipt answers, refunds, exceptions and corrections. A correction is a new row that points to the row it supersedes (`SupersedesId`); nothing is overwritten. |
| `TxDisputes` | Problem reports: category, description, status, outcome, reasons, `DecidedBy`/`DecidedAt`, `HistoryJson` and `Version`. |
| `TxConfig` | Admin settings (see C). |
| `Audit_Log` | This existing log also receives every material action (`TX_*` actions). |

### Order status

`Orders.Status` remains the single order status that everything else reads (Pending Payment / Paid / Fulfilled / Cancelled). The sub-states live in `TxState`, so payment, fulfilment, receipt and problems stay separate.

| Event | Effect |
|---|---|
| Seller verifies payment | `Status` becomes Paid. The buyer's screenshot alone never does this. |
| Goods dispatched or handed over | Stock moves from reserved to sold (Inventory.gs). Status stays the same. |
| Buyer confirms receipt, payment is verified, and no problem is open | `Status` becomes Fulfilled ("Completed"). |
| Cancelled | `Status` becomes Cancelled. If the goods had not yet left, the reservation is released. If they had, stock is *not* put back automatically. |

A buyer who stays silent is never treated as having confirmed. The only other way to complete an order is an admin exception with written reasons.

### The transition rules

There is one server function per step, and each checks its role, the starting state, the evidence and the reasons:

| Step | Who | From | Needs |
|---|---|---|---|
| `txSubmitPayment` | buyer | payment pending / submitted / rejected | A method, plus a reference *or* a receipt (configurable). Flags differences: amount ≠ total, the same receipt image on another order, the same reference on another order. Flags are shown to the seller and admins only, never as an accusation. |
| `txVerifyPayment` | **seller only** (an admin cannot see the seller's bank) | not yet verified | The result. To verify: "I checked my own account" ticked, the method, a reference (except for cash), and the amount. A different amount needs an explicit acceptance and a reason. Declining needs a reason. |
| `txChecklist` | seller | before the goods leave | Every line ticked, or an agreed change described. Photo rules (C). A noted defect needs a defect photo. |
| `txMarkReady` | seller | after the checklist | For collection: instructions. |
| `txDispatch` | seller, delivery | preparing / ready | A date (not in the future), the method, and optionally the carrier and tracking. The tracking number is *not* required. Photo rules. If payment is not verified, the seller must tick "send before payment is confirmed". |
| `txMarkDelivered` | seller | dispatched | Labelled "seller reports delivered". |
| `txHandover` | seller, collection | preparing / ready | A date. Either "cash received" (which records the payment verification) or "hand over before payment". Photo optional by default. |
| `txConfirmReceipt` | buyer | after dispatch or handover (collection: also when ready) | ok / problem / partial / not received / unable. Recorded once. Any answer except ok or unable opens a problem report. |
| `txOpenDispute`, `txRespondDispute` | buyer or seller | — | A category the party is allowed to report and a description of at least 15 characters. A photo is required for damaged, wrong-item and not-as-described problems. The person who reported it may withdraw it. |
| `txCancel` | seller before the goods leave with no open problem; an admin at any time (not a party) | — | A reason. If payment had been verified, the refund becomes due. |
| `txRecordRefund`, `txConfirmRefund` | seller, then buyer | refund due / sent | The seller confirms the refund was actually sent; the buyer confirms it arrived. |
| `adminTxDispute` | admin, not a party | — | Start review / request information / propose / resolve (outcome, reasons of at least 15 characters, and the order effect: none, cancel or complete) / reopen within the configured number of days. |
| `adminTxException` | admin, not a party | — | Waives *one* requirement on the list in `exceptions.allowed`, with a reason. Identity, ownership and payment verification are never waivable. |
| `adminTxCorrectReceipt`, `adminTxComplete`, `adminTxHold`, `adminTxNote`, `adminTxRedactEvidence` | admin | — | A reason. Every one is audited. |

**Protections on every write:**
- the script lock;
- retry safety: the same `requestId` within 10 minutes replays the first answer, so a dropped connection never records a step twice;
- an optional `version` check that refuses an edit made from an out-of-date view.

**Fields the page cannot set.** The page cannot set a status, a user id, a payment result or a timestamp directly. Extra fields in a request are ignored, and the general Orders-page dropdown cannot change a room order (`txGuardLegacyStatusChange`).

**Problems.** Opening a problem puts the order on hold:
- it cannot be completed or cancelled by the seller, and the dropdown is locked;
- nothing is deleted;
- the other party and the admins are told.

When an admin resolves it with "no change to the order", or the reporter withdraws it, a "problem / not received" receipt answer is set aside (it stays in the records), so the buyer can confirm receipt once things are sorted.

### Evidence: how files are stored and served

**Upload checks.** `uploadTxEvidence` checks the file on the server:
- **Type from the bytes, not the name:** JPEG, PNG and WebP only, plus PDF if allowed in the settings. The browser's claimed type must match.
- **Limits:** size (5 MB by default) and image dimensions (32 px to 10,000 px).
- **PDFs:** refused if they contain JavaScript, actions or embedded files.
- **Volume:** a per-order file limit, and at most 20 uploads per 10 minutes per person.

**Saving.**
- **Private files.** The file goes to a Drive folder that is never shared ("Mwakete Order Evidence (private)") under a name the server makes up: `<evidenceId>.<ext>`.
- **One record.** A file is recorded only after it is saved, and the same file sent again on the same order returns the first record instead of a duplicate.

**Serving.** `getTxEvidence` returns the file only after the same access check as the room. The unguessable id alone is not enough.
- Full-size opens are logged, and every admin open is logged.
- Thumbnails are not logged.

**Phone side.**
- Photos are re-saved as JPEG at up to 2560 px. This keeps detail clear while cutting size, and removes the location data that camera photos carry.
- Screenshots under 1.5 MB are kept as they are, so receipt text stays sharp.
- A 320 px thumbnail is sent with each photo, and previews load thumbnails only.
- Each file shows Waiting → Preparing → Uploading → Saved (only after the server confirms) or Not uploaded (Retry/Remove). A retry reuses the same `requestId`.

### Notifications

Email goes through the existing `sendAppEmail` (Resend if configured, otherwise MailApp). It is sent after the lock is released, de-duplicated per event, and messages are throttled to one email per 10 minutes per order and recipient.

Emails carry only a link to the signed-in room, never a receipt, photo or address. In the app, order lists show the room stage, an unread count and a problem marker. No SMS or paid service is used.

### Low bandwidth

- The first load is capped at 40 timeline entries; older ones load on request.
- Polling runs every 20 s only while the page is visible, and answers `{unchanged:true}` (about 60 bytes) when nothing happened.
- Event lists are cached for 15 s server-side and cleared on every write.
- Messages that fail show **Not sent** with Retry. Drafts are kept only in `sessionStorage` for that tab. Nothing about orders is written to `localStorage`.
- The service worker never caches the Apps Script origin, and `order-room.html` is marked `noindex`.

---

## B. Setup, deployment and rollback

**Nothing changes until you switch it on.** With `TX_ROOMS` unset, checkout, the Orders page and the customer account behave exactly as before; the tests prove this.

### Deploy the backend (manual, as always)

1. In the Apps Script editor, add a new file `Transactions.gs` and paste `apps-script/Transactions.gs`.
2. Replace `Code.gs`, `Orders.gs` and `Customers.gs` with the repository versions.
3. Save, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**.
4. Open `<exec URL>?action=getVersion`. It must show `orderrooms1-2026-10-15`.
5. Open `<exec URL>?action=checkSetup`. `missingFiles` must be `[]`.
6. **Permissions.** Evidence files use Drive (`DriveApp`), which the project already uses for product photos. If Google asks for authorisation when you first run something, approve it.

No sheet needs creating by hand: the `Tx*` tabs appear on first use.

### Script Properties

| Property | Value | Purpose |
|---|---|---|
| `TX_ROOMS` | `off` (default), `pilot` or `on` | Rollout switch |
| `TX_PILOT_STORES` | e.g. `bong,teaube` | Stores in the pilot |
| `SITE_BASE_URL` | e.g. `https://mwakete.com` | Links in notification emails (already used by chat) |
| `ADMIN_EMAILS` | existing | Who can review problems |

### Safe rollout

1. Set `TX_ROOMS=pilot` and `TX_PILOT_STORES=` one friendly store. Place a test order and walk through it:
   - buyer: payment details;
   - seller: verify, checklist, dispatch;
   - buyer: confirm.
2. Report a test problem and resolve it from the admin page.
3. Add stores, then set `TX_ROOMS=on`.

**What happens to existing orders.**
- Orders placed while rooms are on get the full workflow (`Flow v1`).
- Older orders get a *legacy* room when it is first opened. It has messages, photos, receipt confirmation and problem reports, but payment and status stay with the seller's Orders dropdown, and **nothing is invented** for them: no evidence, no verification.

### Retention (optional daily trigger)

In the Apps Script editor, go to **Triggers → Add trigger → `sweepTxRetention` → Time-driven → Day timer**. It deletes the *files* of finished orders after `retention.days` (365) or, for disputed orders, `retention.disputeDays` (730) after the decision. It keeps the records and hashes, and it never touches an order that has an open problem, a hold, or a refund still due.

### Rollback

Set `TX_ROOMS=off`.
- Rooms close.
- Every order, including room orders, is managed from the Orders dropdown again, so nothing is stuck.
- All records stay in the `Tx*` tabs.

To roll back the code itself, redeploy the previous version from **Manage deployments**. The frontend rollback is reverting the merge commit.

---

## C. Administrator guide

- **Reviewing problems.**
  1. Open Admin → **Order problems** and choose Open / Resolved / All. Each entry links to its room in admin view (`order-room.html?…&as=admin`).
  2. In the room you see the summary, the buyer's details, payment and dispatch records, every photo (tap to open full size; this is logged) and the whole conversation.
  3. Use **Review problem**:
     - **Start review**
     - **Ask for more information** (choose buyer or seller)
     - **Propose a resolution**
     - **Record the decision:** outcome, reasons, and what happens to the order (no change / cancel / complete).
  4. The buyer and seller are emailed a link.
- **Refunds.** Mwakete cannot send or reverse money. A refund is recorded when the seller says they sent it, and confirmed when the buyer says it arrived.
- **If you are a party.** Your own orders show "you are a party", and the decision buttons are hidden; another admin must decide.
- **Exceptions.** **Waive a requirement** lifts one listed requirement (for example `conditional.photo`) for this order, with your reason. It cannot waive identity, ownership or payment verification.
- **Other tools:**
  - **Complete without buyer:** only after the goods were sent and payment was verified, with no open problem.
  - **Correct receipt answer:** the old answer stays in the history.
  - **Hold files:** keeps the files past retention.
  - **Admin note:** visible to admins only.
  - **Remove file:** for a receipt showing a full account number, for example. The record stays and the content goes.
- **Settings.** Admin → Order problems → **Order room settings**:
  - photo levels for the checklist, dispatch and handover (required / recommended / off);
  - categories that must have a goods photo (default: electronics, solar, jewellery, kitchenware);
  - the order value that needs photos (default $200);
  - problem types that need a photo;
  - waivable requirements;
  - file size and count limits, and whether PDFs are allowed;
  - retention days and the reopen window;
  - email on/off;
  - the wording of every automatic message.

  Every change is validated and recorded in the audit log with its old and new value.
- **Audit.** The existing audit log view (`listAuditLog`) shows `TX_*` entries. Filter by order reference.

---

## D. Buyer and seller guide

**Buyers**
- Open the order from **My account → Order room** and sign in with the email you used at checkout.
- **Paid?** Tap **Send payment details**: how you paid, the reference, and a screenshot. **Hide** full account numbers and balances first. Your order shows *Paid* only when the seller confirms the money reached their account; a screenshot alone is not proof.
- When the order arrives (or you collect it), tap **Confirm receipt**. If anything is missing, damaged or different, choose that option instead and add photos. Don't confirm while a problem remains. Confirming does not stop you reporting a problem you find later.
- Keep messages about the order in the room. Messages sent elsewhere may not be available to Mwakete if there is a problem.

**Sellers**
- Orders → **Open order room**. A new order's status is managed here, not with the dropdown.
- **Check payment** only after looking at your own bank, wallet or cash. Tick "I checked my own account". If you can't find it, decline with a reason.
- **Check goods against the order** before sending: tick each item, note accessories, defects and packaging, and add photos of the *actual goods*, not catalogue pictures. Some categories and high-value orders require a photo; a noted defect needs a defect photo.
- **Record sending**: the date, method, carrier and a tracking number if there is one, plus a photo when asked. For collection: **Ready for collection** (where and when), then **Record handover**; tick "cash received" if paid in cash.
- If you cancel after being paid, return the money and tap **Record refund sent**.

---

## E. Test report (October 2026)

| Suite | Result |
|---|---|
| `tests/test-tx-rooms.js` (backend, real sources) | 181/181 |
| `tests/verify-tx-room.js` (browser + real backend: journeys A, B, C and D) | 46/46 |
| Full existing suite (all 164 files before this change) | see the PR description |

**Security scenarios verified:**
- unauthenticated access, expired sessions, and a customer token used as a seller token;
- cross-buyer and cross-seller rooms and files;
- the seller signed in as a customer with a different email;
- a buyer verifying their own payment; an admin verifying a seller's payment; another seller verifying;
- a seller calling admin actions (logged); an admin deciding their own order;
- forged status and owner fields; tampered order ids; another order's file attached; a buyer's file claimed by the seller;
- an executable renamed as a photo, HTML, a mismatched type, oversized files and dimensions, a PDF with JavaScript, malformed base64, and a path in the file name;
- formula injection in messages; rate limits; stale versions; duplicate requests;
- no endpoint deletes audit records; files are never shared publicly.

**Known limits**
- **Malware scanning.** No scanner is available to Apps Script. Instead, only image and PDF bytes are accepted, active PDFs are refused, and files are never served to anyone but the parties.
- **Payment provider.** None is integrated, so payment is verified manually by the seller.
- **Delivery provider.** None is integrated, so delivery updates are labelled with who reported them.
- **Large timelines.** Sheets are read whole; past roughly 50,000 timeline rows, archive old `TxEvents` rows.
- **Untested against Google.** The Drive and email calls ran against in-memory stand-ins in tests; the live deploy check above confirms them.
- **No legal assessment.** No legal or compliance assessment has been made. The retention periods are defaults for the owner to decide.
