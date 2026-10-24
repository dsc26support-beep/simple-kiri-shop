/**
 * Driver wallet, whole-system checks (phase 6) on the REAL backend sources:
 *  - money is conserved across every way a delivery can end;
 *  - who may call what (every new action, through doPost like the real site);
 *  - nobody sees what they should not (bank details, references, payout details);
 *  - an existing sheet made before the wallet is upgraded in place;
 *  - turning the switch off never strands money or skips a payment check.
 */
const { makeBox, driverDocs } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);
const FUT = new Date(Date.now() + 9e8).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer'],
    ['own_a', 'mwakete-admin', 'Admin', 'admin@x.test', '', 'active', 'South Tarawa', '', '', '', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT], ['tok-a', 'own_a', '', FUT]],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    ['cus_b', 'Tia', 'b@x.test', '73000001', 'yes', '', ''], ['cus_d', 'Dan Driver', 'd@x.test', '73000009', 'yes', '', ''],
    ['cus_e', 'Eve Driver', 'e@x.test', '73000008', 'yes', '', ''], ['cus_n', 'New', 'n@x.test', '73000007', 'yes', '', ''],
    ['cus_adm', 'Admin as customer', 'admin@x.test', '73000006', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['c-b', 'cus_b', '', FUT], ['c-d', 'cus_d', '', FUT], ['c-e', 'cus_e', '', FUT],
    ['c-n', 'cus_n', '', FUT], ['c-adm', 'cus_adm', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p1', 'own_s', 'bong', 'Rice', '10kg', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v1', 'p1', 'own_s', '10kg', 20, '', 500, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.__props.TX_ROOMS = 'on';
const clear = () => Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
const call = (fn, body) => { clear(); return box[fn](body); };
const seller = (fn, b) => call(fn, Object.assign({ side: 'seller', token: 'tok-s' }, b));
const buyer = (fn, b) => call(fn, Object.assign({ side: 'buyer', token: 'c-b' }, b));
const admin = (fn, b) => call(fn, Object.assign({ side: 'admin', token: 'tok-a' }, b));
const drv = (tok) => (fn, b) => call(fn, Object.assign({ token: tok }, b));
const dan = drv('c-d'), eve = drv('c-e');
const [S, A] = box.__sheets.Owners.objects();
const today = new Date().toISOString().slice(0, 10);
const png = (w, h) => { const b = Buffer.alloc(2033); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); for (let i = 33; i < b.length; i++) b[i] = (i * 7 + w) & 255; return b.toString('base64'); };
const order = (extra) => { clear(); return box.actionCreateOrder(Object.assign({ storeSlug: 'bong', items: [{ variantId: 'v1', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
  customerEmail: 'b@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck' }, extra || {})).orderId; };
const ready = (id) => { seller('actionTxVerifyPayment', { orderId: id, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25 });
  seller('actionTxChecklist', { orderId: id, checklist: { lines: [{ index: 0, ok: true }] } }); seller('actionTxMarkReady', { orderId: id }); };
const job = (id) => box.__sheets.DeliveryJobs.objects().filter((j) => j.OrderId === id).slice(-1)[0];
const stateOf = (id) => box.__sheets.TxState.objects().find((s) => s.OrderId === id);
const status = (id) => box.__sheets.Orders.objects().find((o) => o.OrderId === id).Status;
const box2 = box;
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const post = (b) => { Object.keys(box.__cache).filter((k) => k.indexOf('ratelimit') === 0 || k.indexOf('v1:dlv') === 0).forEach((k) => delete box.__cache[k]);
  try { return JSON.parse(box.doPost({ postData: { contents: JSON.stringify(b) } }).s); } catch (e) { return { ok: false, error: String(e.message || e) }; } };
box.__props.DELIVERY_JOBS = 'on';
box.__props.MWAKETE_BANK_DETAILS = 'ANZ Bank, Mwakete Ltd, account 000111222';
dan('actionDriverApply', Object.assign(driverDocs(), { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true }));
eve('actionDriverApply', Object.assign(driverDocs(), { name: 'Eve', phone: '73000008', vehicle: 'car', area: 'South Tarawa', agree: true }));
const idOf = (name) => box.__sheets.Drivers.objects().find((d) => d.Name === name).DriverId;
box.actionAdminSetDriverStatus(A, { driverId: idOf('Dan'), status: 'approved' });
box.actionAdminSetDriverStatus(A, { driverId: idOf('Eve'), status: 'approved' });
dan('actionDriverSetAvailable', { available: true }); eve('actionDriverSetAvailable', { available: true });
box.__props.DELIVERY_PAYMENTS = 'pilot';
box.__props.DELIVERY_PAYMENTS_DRIVERS = idOf('Dan');
const rq = (() => { let n = 0; return () => 'req-' + (++n) + '-abcdefgh'; })();
const HOUR = 3600000;
let r;
const ledger = () => (box.__sheets.DriverLedger ? box.__sheets.DriverLedger.objects() : []);
const jobs = () => box.__sheets.DeliveryJobs.objects();
const adminCall = (fn, b) => box[fn](A, b);
const booked = (fee) => { const o = order(); ready(o); seller('actionTxRequestDriver', { orderId: o, fee, pickup: 'Back door of the Bong shop, Betio' });
  const id = job(o).JobId; dan('actionDriverAcceptJob', { jobId: id, requestId: rq() }); return { o, id, fee }; };
const locked = (fee) => { const j = booked(fee); dan('actionDriverAgreeFee', { jobId: j.id, fee }); seller('actionTxAgreeFee', { orderId: j.o, fee }); return j; };
const paid = (fee) => { const j = locked(fee); seller('actionTxSubmitJobPayment', { orderId: j.o, bankRef: 'ANZ-' + j.id.slice(-6), amount: fee, requestId: rq() });
  adminCall('actionAdminConfirmJobPayment', { jobId: j.id, amountReceived: fee, checkedStatement: true }); return j; };
const collected = (fee) => { const j = paid(fee); dan('actionDriverUpdateJob', { jobId: j.id, act: 'picked_up', requestId: rq() }); return j; };
const deliver = (j) => { const up = dan('actionDriverUploadProof', { jobId: j.id, mimeType: 'image/png', dataBase64: png(800, 600), requestId: rq() });
  return dan('actionDriverUpdateJob', { jobId: j.id, act: 'delivered', recipientName: 'Tia', proofId: up.proofId, requestId: rq() }); };
const complete = (j) => { deliver(j); return buyer('actionTxConfirmReceipt', { orderId: j.o, choice: 'ok', requestId: rq() }); };
const makeAvailable = () => box.sheetToObjects(box.getSheet('DriverLedger')).forEach((e) => { if (e.EntryType === 'CREDIT') box.updateRowFromObject(box.getSheet('DriverLedger'), e.__row, { AvailableAt: new Date(Date.now() - HOUR).toISOString() }); });
const sellerBank = () => jobs().filter((j) => ['received', 'credited', 'review', 'refund_due', 'refunded'].indexOf(j.PayStatus) !== -1).reduce((n, j) => n + Number(j.Fee), 0);

/* ======== 1. money is conserved across every ending ======== */
const S1 = collected(10); complete(S1);                                                    // completed -> driver credited 10
const S2 = collected(4); dan('actionDriverUpdateJob', { jobId: S2.id, act: 'failed', reason: 'refused', note: 'The buyer refused it', requestId: rq() });   // failed, driver paid 4
const S3 = collected(6); dan('actionDriverUpdateJob', { jobId: S3.id, act: 'failed', reason: 'damaged', note: 'Crushed on the way', requestId: rq() });      // review
adminCall('actionAdminResolveJobPayment', { jobId: S3.id, outcome: 'refund_seller', note: 'Driver was careless here' });                                  // -> refund due
const S4 = collected(7); dan('actionDriverUpdateJob', { jobId: S4.id, act: 'failed', reason: 'other', note: 'Road was closed by flooding', requestId: rq() });
adminCall('actionAdminResolveJobPayment', { jobId: S4.id, outcome: 'pay_driver', note: 'Not the driver at fault' });                                       // -> credited 7
const S5 = paid(8); seller('actionTxCancelDriverJob', { orderId: S5.o, reason: 'Seller changed their mind' });                                              // -> refund due
const S6 = paid(9); seller('actionTxCancel', { orderId: S6.o, reason: 'Order cancelled before collection' });                                               // -> refund due
const S7 = locked(5); seller('actionTxCancelDriverJob', { orderId: S7.o, reason: 'Never paid so cancelled' });                                              // owes nothing
const S8 = paid(3);                                                                                                                                         // paid, still waiting for pickup
ok('every ending lands where the rules say', [S1, S2, S3, S4, S5, S6, S7, S8].map((s) => job(s.o).PayStatus).join(',') === 'credited,credited,refund_due,credited,refund_due,refund_due,awaiting,received',
  [S1, S2, S3, S4, S5, S6, S7, S8].map((s) => job(s.o).PayStatus).join(','));
makeAvailable();
const claim1 = dan('actionDriverSetPayoutDetails', { details: 'ANZ Bank, Dan Driver, account 123456789' }) && dan('actionDriverClaimPayout', { requestId: rq() });
ok('the driver claims everything available (10 + 4 + 7 = 21)', claim1.ok && claim1.claimed === 21, J(claim1));
adminCall('actionAdminMarkJobRefunded', { jobId: S3.id, bankRef: 'ANZ-REFUND-1' });                                                                       // S3 refunded
let pq = adminCall('actionAdminListPayouts', {});
adminCall('actionAdminMarkPayoutPaid', { claimId: pq.claims[0].claimId, bankRef: 'ANZ-PAY-1' });                                                           // claim paid
const S9 = collected(12); complete(S9); makeAvailable();                                                                                                   // more credit
dan('actionDriverClaimPayout', { requestId: rq() });                                                                                                      // second claim, unpaid
const S10 = collected(2); complete(S10);                                                                                                                 // credited, in hold
adminCall('actionAdminAdjustDriverWallet', { driverId: idOf('Dan'), amount: -3, reason: 'Buyer dispute on an order', requestId: rq() });                  // correction
pq = adminCall('actionAdminListPayouts', {});
const bankIn = sellerBank();
const bankOut = jobs().filter((j) => j.PayStatus === 'refunded').reduce((n, j) => n + Number(j.Fee), 0) + ledger().filter((e) => e.EntryType === 'CLAIM').filter((c) => ledger().some((p) => p.EntryType === 'PAYOUT_PAID' && p.RefEntryId === c.EntryId)).reduce((n, c) => n - Number(c.Amount), 0);
const adjustments = ledger().filter((e) => e.EntryType === 'ADJUSTMENT').reduce((n, e) => n + Number(e.Amount), 0);
ok(`money in (${bankIn}) - money out (${bankOut}) + corrections (${adjustments}) = what Mwakete should hold (${pq.holding.total})`, Math.abs(bankIn - bankOut + adjustments - pq.holding.total) < 0.005, J(pq.holding));
ok('the holding breakdown adds up to its total', Math.abs(pq.holding.heldForOpenJobs + pq.holding.awaitingDecision + pq.holding.owedToDrivers + pq.holding.claimsToPay + pq.holding.refundsDue - pq.holding.total) < 0.005);
ok('no job is credited twice and no ledger credit lacks a job', (() => { const c = ledger().filter((e) => e.EntryType === 'CREDIT'); return new Set(c.map((e) => e.JobId)).size === c.length && c.every((e) => jobs().some((j) => j.JobId === e.JobId && j.PayStatus === 'credited')); })());
ok('every credited job has exactly one credit', jobs().filter((j) => j.PayStatus === 'credited').every((j) => ledger().filter((e) => e.JobId === j.JobId && e.EntryType === 'CREDIT').length === 1));
ok('no balance is negative', pq.drivers.every((d) => d.total >= 0 && d.available >= -0.005));

/* ======== 2. who may call what, through doPost like the real site ======== */
const NEW_TX = ['txJobMessage', 'txProposeFee', 'txAgreeFee', 'txSubmitJobPayment'];
const NEW_DRIVER = ['driverJobMessage', 'driverProposeFee', 'driverAgreeFee', 'driverSetPayoutDetails', 'driverClaimPayout'];
const NEW_ADMIN = ['adminListPayouts', 'adminMarkPayoutPaid', 'adminReversePayout', 'adminAdjustDriverWallet', 'adminResolveJobPayment', 'adminConfirmJobPayment', 'adminRejectJobPayment', 'adminMarkJobRefunded'];
const unknown = (x) => /unknown action/i.test(String(x.error || ''));
ok('every new action is routed (none is "unknown action")', NEW_TX.concat(NEW_DRIVER, NEW_ADMIN).every((a) => !unknown(post({ action: a }))), NEW_TX.concat(NEW_DRIVER, NEW_ADMIN).filter((a) => unknown(post({ action: a }))).join(','));
ok('with no sign-in every new action is refused', NEW_TX.concat(NEW_DRIVER, NEW_ADMIN).every((a) => !post({ action: a, orderId: S8.o, jobId: S8.id, side: 'seller', fee: 1, text: 'x' }).ok));
ok('a store owner who is not an admin is refused every admin action', NEW_ADMIN.every((a) => !post({ action: a, token: 'tok-s', jobId: S8.id, claimId: 'x', driverId: idOf('Dan'), amount: 1, reason: 'sneaky change', bankRef: 'ANZ-1' }).ok));
const T = booked(5); dan('actionDriverAgreeFee', { jobId: T.id, fee: 5 });
ok('another driver cannot read, message, propose or agree on Dan\'s job', !eve('actionDriverJobMessage', { jobId: T.id, text: 'hi' }).ok && !eve('actionDriverProposeFee', { jobId: T.id, fee: 9 }).ok && !eve('actionDriverAgreeFee', { jobId: T.id, fee: 5 }).ok);
ok('a buyer cannot message, propose, agree or pay on that order', ['actionTxJobMessage', 'actionTxProposeFee', 'actionTxAgreeFee', 'actionTxSubmitJobPayment'].every((fn) => !buyer(fn, { orderId: T.o, text: 'hi', fee: 5, bankRef: 'ANZ-123', amount: 5 }).ok));
ok('an admin cannot write in the chat or propose or agree for a side', ['actionTxJobMessage', 'actionTxProposeFee', 'actionTxAgreeFee', 'actionTxSubmitJobPayment'].every((fn) => !admin(fn, { orderId: T.o, text: 'hi', fee: 5, bankRef: 'ANZ-123', amount: 5 }).ok));
ok('a driver outside the pilot has no wallet and cannot set details or claim', eve('actionGetDriverHome', {}).wallet === null && !eve('actionDriverSetPayoutDetails', { details: 'ANZ Eve account 987654321' }).ok && !eve('actionDriverClaimPayout', { requestId: rq() }).ok);

/* ======== 3. nobody sees what they should not ======== */
const SECRETS = ['ANZ Bank, Mwakete Ltd', 'account 000111222', 'account 123456789'];
const leak = (label, v) => { const s = JSON.stringify(v); const hit = SECRETS.find((x) => s.indexOf(x) !== -1); ok(`${label}: no bank details or payout details`, !hit, hit || ''); };
const P = locked(6); // awaiting: seller can see Mwakete's bank details
leak('buyer\'s order room', buyer('actionGetTxRoom', { orderId: P.o }));
leak('the other driver\'s home', eve('actionGetDriverHome', {}));
ok('the buyer\'s order room has no chat, reference or fee talk', (() => { const s = JSON.stringify(buyer('actionGetTxRoom', { orderId: P.o })); return !/MWK-|"chat":\{/.test(s); })());
ok('Dan\'s own home never contains Mwakete\'s bank details or a reference', !/ANZ Bank, Mwakete|account 000111222|MWK-/.test(JSON.stringify(dan('actionGetDriverHome', {}))));
ok('the seller is shown Mwakete\'s bank details to pay into', /account 000111222/.test(JSON.stringify(seller('actionGetTxRoom', { orderId: P.o }))));
ok('Dan\'s payout details reach only Dan and admins', !/account 123456789/.test(JSON.stringify(seller('actionGetTxRoom', { orderId: S1.o }))) && /account 123456789/.test(JSON.stringify(dan('actionGetDriverHome', {}))) && /account 123456789/.test(JSON.stringify(adminCall('actionAdminListPayouts', {}))));
ok('the admin driver list does not expose payout details', !/account 123456789/.test(JSON.stringify(adminCall('actionAdminListDeliveries', { status: 'all' }))));
ok('checkSetup (public) does not leak bank details', !/account 000111222/.test(JSON.stringify(box.actionCheckSetup())));

// A driver can hold at most 3 active jobs: clear the leftovers (this also puts S8's money on the refund list).
[S8, T, P].forEach((x) => seller('actionTxCancelDriverJob', { orderId: x.o, reason: 'Tidying up the leftovers' }));
ok('the leftovers are cancelled and the driver has no active jobs', dan('actionGetDriverHome', {}).mine.length === 0, String(dan('actionGetDriverHome', {}).mine.length));

/* ======== 4. retries are safe ======== */
const Q = locked(11);
ok('(setup) the job is accepted and the fee locked', job(Q.o).Status === 'accepted' && job(Q.o).FeeLocked === 'yes');
const payReq = rq();
// A real double tap reaches the backend with its retry memory (the cache) intact; the shared helper clears it between calls.
clear();
const sendPay = () => box.actionTxSubmitJobPayment({ side: 'seller', token: 'tok-s', orderId: Q.o, bankRef: 'ANZ-RETRY-1', amount: 11, requestId: payReq });
const a1 = sendPay();
const a2 = sendPay();
ok('sending the payment twice (same request) is one payment, answered the same', a1.ok && a2.ok && a2.replayed === true && jobs().filter((j) => j.JobId === Q.id).length === 1 && job(Q.o).PayStatus === 'submitted');
adminCall('actionAdminConfirmJobPayment', { jobId: Q.id, amountReceived: 11, checkedStatement: true });
ok('confirming twice is refused', !adminCall('actionAdminConfirmJobPayment', { jobId: Q.id, amountReceived: 11, checkedStatement: true }).ok);
dan('actionDriverUpdateJob', { jobId: Q.id, act: 'picked_up', requestId: rq() });
complete(Q);
const credits = ledger().filter((e) => e.JobId === Q.id).length;
box.deliveryOnOrderCompleted(box.__sheets.Orders.objects().find((o) => o.OrderId === Q.o));
buyer('actionTxConfirmReceipt', { orderId: Q.o, choice: 'ok', requestId: rq() });
ok('completing again (or re-running the credit) never credits twice', credits === 1 && ledger().filter((e) => e.JobId === Q.id).length === 1);

/* ======== 5. turning the switch off never strands money or skips a check ======== */
const M = locked(14);
ok('(setup) the job is accepted and the fee locked', job(M.o).Status === 'accepted' && job(M.o).FeeLocked === 'yes');
seller('actionTxSubmitJobPayment', { orderId: M.o, bankRef: 'ANZ-OFF-1', amount: 14, requestId: rq() });
box.__props.DELIVERY_PAYMENTS = 'off';
let rr = dan('actionDriverUpdateJob', { jobId: M.id, act: 'picked_up', requestId: rq() });
ok('switch OFF mid-flight: a job Mwakete is waiting to be paid for still cannot be collected', !rr.ok && /not confirmed/.test(rr.error), J(rr));
ok('...an admin can still confirm it', adminCall('actionAdminConfirmJobPayment', { jobId: M.id, amountReceived: 14, checkedStatement: true }).ok);
ok('...then the driver can collect and the order still credits them on completion', dan('actionDriverUpdateJob', { jobId: M.id, act: 'picked_up', requestId: rq() }).ok && (complete(M), job(M.o).PayStatus === 'credited'));
ok('switch OFF: the driver can still see their balance and claim what they have earned', dan('actionGetDriverHome', {}).wallet !== null && dan('actionGetDriverHome', {}).wallet.balance.total > 0);
makeAvailable();
ok('...and claim it', dan('actionDriverClaimPayout', { requestId: rq() }).ok);
const N = order(); ready(N); seller('actionTxRequestDriver', { orderId: N, fee: 5, pickup: 'Back door of the Bong shop' });
dan('actionDriverAcceptJob', { jobId: job(N).JobId, requestId: rq() });
ok('switch OFF: a NEW job is on the old rules (no chat, no payment step)', (job(N).PayStatus || '') === '' && dan('actionGetDriverHome', {}).mine.find((j) => j.jobId === job(N).JobId).chat === null && dan('actionDriverUpdateJob', { jobId: job(N).JobId, act: 'picked_up', requestId: rq() }).ok);
box.__props.DELIVERY_PAYMENTS = 'pilot';

/* ======== 6. a sheet made before the wallet is upgraded in place ======== */
{
  const old = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'],
      ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer']],
    Drivers: [['DriverId', 'CustomerId', 'Name', 'Phone', 'Email', 'Vehicle', 'Area', 'Status', 'Available', 'ReviewedBy', 'ReviewedAt', 'ReviewNote', 'CreatedAt', 'UpdatedAt'],
      ['drv_old', 'cus_o', 'Olly', '73000005', 'o@x.test', 'car', 'South Tarawa', 'approved', 'yes', '', '', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']],
    DeliveryJobs: [['JobId', 'OrderId', 'OwnerId', 'StoreSlug', 'Status', 'DriverId', 'Fee', 'Pickup', 'Dropoff', 'Notes', 'FeePaid', 'FailReason', 'Sharing', 'LastLat', 'LastLng', 'LastAccuracy', 'LastLocAt', 'Version', 'CreatedAt', 'AcceptedAt', 'PickedUpAt', 'DeliveredAt', 'ClosedAt', 'UpdatedAt'],
      ['dlv_old', 'ORD-OLD', 'own_s', 'bong', 'delivered', 'drv_old', 5, 'Shop', 'Betio, South Tarawa', '', 'yes', '', '', '', '', '', '', 4, '2026-01-01T00:00:00Z', '', '', '', '', '2026-01-02T00:00:00Z']]
  });
  old.__props.DELIVERY_JOBS = 'on';
  const before = old.__sheets.DeliveryJobs.objects()[0];
  const headersBefore = old.__sheets.DeliveryJobs.grid[0].slice();
  const driverHeadersBefore = old.__sheets.Drivers.grid[0].slice();
  old.deliveryJobsSheet(); old.deliveryDriversSheet();
  const hj = old.__sheets.DeliveryJobs.grid[0], hd = old.__sheets.Drivers.grid[0];
  ok('an old DeliveryJobs sheet gets the fee and payment columns appended', ['FeeProposedBy', 'FeeSellerOk', 'FeeDriverOk', 'FeeLocked', 'PayRef', 'PayStatus', 'PayBankRef', 'PayAmount', 'PayNote', 'PaySubmittedAt', 'PayCheckedBy', 'PayCheckedAt', 'PayRefundRef'].every((h) => hj.indexOf(h) !== -1));
  ok('...and no existing column moved', headersBefore.every((h, i) => hj[i] === h) && hj.length === headersBefore.length + 13, hj.length + ' vs ' + headersBefore.length);
  ok('...and running it again adds nothing more', (old.deliveryJobsSheet(), old.__sheets.DeliveryJobs.grid[0].length === hj.length));
  ok('an old Drivers sheet gets PayoutDetails appended after every existing column', hd.indexOf('PayoutDetails') === hd.length - 1 && driverHeadersBefore.every((h, i) => hd[i] === h));
  const after = old.__sheets.DeliveryJobs.objects()[0];
  ok('the old finished job is untouched and reads as a non-wallet job', after.JobId === 'dlv_old' && after.Fee === 5 && after.FeePaid === 'yes' && (after.PayStatus || '') === '' && old.deliveryFeeChatOn(after) === false);
  ok('the old job still shows to its driver as before', old.driverJobView(after, {}, 'Bong Store').payLabel === '' && old.driverJobView(after, {}, 'Bong Store').chat === null);
}

let fails = 0;
console.log('\n--- driver wallet: whole-system checks ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
