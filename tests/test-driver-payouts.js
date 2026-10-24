/**
 * Crediting, claiming and paying drivers (driver wallet phase 4) on the REAL
 * backend sources: credit when the order completes, the failed-delivery
 * rules, the 48 hour hold, payout details, claim at the minimum, the admin
 * payout queue, corrections, and what Mwakete should be holding.
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
box.__props.DELIVERY_JOBS = 'on';
dan('actionDriverApply', Object.assign(driverDocs(), { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true }));
eve('actionDriverApply', Object.assign(driverDocs(), { name: 'Eve', phone: '73000008', vehicle: 'car', area: 'South Tarawa', agree: true }));
const idOf = (name) => box.__sheets.Drivers.objects().find((d) => d.Name === name).DriverId;
box.actionAdminSetDriverStatus(A, { driverId: idOf('Dan'), status: 'approved' });
box.actionAdminSetDriverStatus(A, { driverId: idOf('Eve'), status: 'approved' });
dan('actionDriverSetAvailable', { available: true }); eve('actionDriverSetAvailable', { available: true });
box.__props.DELIVERY_PAYMENTS = 'pilot';
box.__props.DELIVERY_PAYMENTS_DRIVERS = idOf('Dan');
box.__props.MWAKETE_BANK_DETAILS = 'ANZ 000-111 Mwakete Ltd';
const rq = (() => { let n = 0; return () => 'req-' + (++n) + '-abcdefgh'; })();
const ledger = () => (box.__sheets.DriverLedger ? box.__sheets.DriverLedger.objects() : []);
const bal = () => box.walletBalance(idOf('Dan'));
const wal = () => dan('actionGetDriverHome', {}).wallet;
let r, list;
const HOUR = 3600000;
// Take an order all the way to "driver collected", paid for by the seller and confirmed by an admin.
const collected = (fee) => { const o = order(); ready(o); seller('actionTxRequestDriver', { orderId: o, fee, pickup: 'Back door of the Bong shop, Betio' });
  const id = job(o).JobId; dan('actionDriverAcceptJob', { jobId: id, requestId: rq() }); dan('actionDriverAgreeFee', { jobId: id, fee }); seller('actionTxAgreeFee', { orderId: o, fee });
  seller('actionTxSubmitJobPayment', { orderId: o, bankRef: 'ANZ-' + id.slice(-5), amount: fee, requestId: rq() });
  box.actionAdminConfirmJobPayment(A, { jobId: id, amountReceived: fee, checkedStatement: true });
  dan('actionDriverUpdateJob', { jobId: id, act: 'picked_up', requestId: rq() }); return { o, id }; };
const deliver = (j) => { const up = dan('actionDriverUploadProof', { jobId: j.id, mimeType: 'image/png', dataBase64: png(800, 600), requestId: rq() });
  return dan('actionDriverUpdateJob', { jobId: j.id, act: 'delivered', recipientName: 'Tia', proofId: up.proofId, requestId: rq() }); };

/* ---- nothing is credited until the order completes ---- */
const J1 = collected(10);
r = deliver(J1);
ok('the driver reporting "delivered" alone credits nothing (the buyer decides)', r.ok && ledger().length === 0 && job(J1.o).PayStatus === 'received', J(r));
ok('...the wallet is there but empty', wal() && wal().balance.total === 0 && wal().entries.length === 0);
r = buyer('actionTxConfirmReceipt', { orderId: J1.o, choice: 'ok', requestId: rq() });
ok('the buyer confirms receipt and the order completes', r.ok && r.completed === true, J(r));
ok('the driver is credited the full agreed fee, once, held 48 hours', ledger().length === 1 && ledger()[0].EntryType === 'CREDIT' && ledger()[0].Amount === 10 && job(J1.o).PayStatus === 'credited'
  && Math.abs(Date.parse(ledger()[0].AvailableAt) - Date.now() - 48 * HOUR) < 60000, J(ledger()));
ok('inside the hold it is pending, not available', wal().balance.pending === 10 && wal().balance.available === 0 && !wal().canClaim);
ok('the driver is told they earned it', box.__mail.some((m) => m[0] === 'd@x.test' && /You earned/.test(m[1])));
ok('crediting again (e.g. completion re-run) changes nothing', (box.deliveryOnOrderCompleted(box.__sheets.Orders.objects().find((o) => o.OrderId === J1.o)), ledger().length === 1));

/* ---- a job Mwakete never confirmed payment for is never credited ---- */
box.__props.DELIVERY_PAYMENTS = 'off';
const U = order(); ready(U); seller('actionTxRequestDriver', { orderId: U, fee: 5, pickup: 'Back door of the Bong shop' });
dan('actionDriverAcceptJob', { jobId: job(U).JobId, requestId: rq() }); dan('actionDriverUpdateJob', { jobId: job(U).JobId, act: 'picked_up', requestId: rq() }); deliver({ id: job(U).JobId });
buyer('actionTxConfirmReceipt', { orderId: U, choice: 'ok', requestId: rq() });
ok('wallet off: the order completes and nothing is credited (the old way: the seller pays the driver)', status(U) === 'Fulfilled' && ledger().length === 1);
box.__props.DELIVERY_PAYMENTS = 'pilot';

/* ---- failed deliveries after collecting ---- */
const F1 = collected(4);
dan('actionDriverUpdateJob', { jobId: F1.id, act: 'failed', reason: 'no_one_home', note: 'Nobody there all day', requestId: rq() });
ok('nobody home: the driver is paid for the trip', job(F1.o).PayStatus === 'credited' && ledger().filter((e) => e.JobId === F1.id).length === 1 && ledger().find((e) => e.JobId === F1.id).Amount === 4);
for (const [reason, label] of [['refused', 'refused'], ['unreachable', 'buyer unreachable'], ['wrong_address', 'wrong address']]) {
  const X = collected(2); dan('actionDriverUpdateJob', { jobId: X.id, act: 'failed', reason, note: 'Note about ' + label, requestId: rq() });
  ok(`${label}: the driver is paid`, job(X.o).PayStatus === 'credited');
}
const D1 = collected(6);
dan('actionDriverUpdateJob', { jobId: D1.id, act: 'failed', reason: 'damaged', note: 'Box was crushed on the way', requestId: rq() });
ok('damaged goods: nobody is paid yet, an admin must decide', job(D1.o).PayStatus === 'review' && !ledger().some((e) => e.JobId === D1.id));
list = box.actionAdminListDeliveries(A, { status: 'payments' });
ok('...it appears in the admin list as "to decide"', list.counts.toDecide === 1 && list.jobs.some((j) => j.jobId === D1.id && j.payStatus === 'review'));
ok('a seller cannot decide; the decision needs a clear outcome and a reason', !box.actionAdminResolveJobPayment(S, { jobId: D1.id, outcome: 'pay_driver', note: 'because' }).ok
  && !box.actionAdminResolveJobPayment(A, { jobId: D1.id, outcome: 'maybe', note: 'because of this' }).ok && !box.actionAdminResolveJobPayment(A, { jobId: D1.id, outcome: 'pay_driver', note: 'no' }).ok);
r = box.actionAdminResolveJobPayment(A, { jobId: D1.id, outcome: 'refund_seller', note: 'Driver was careless, seller refunded' });
ok('admin refunds the seller: refund due, driver not paid', r.ok && job(D1.o).PayStatus === 'refund_due' && !ledger().some((e) => e.JobId === D1.id), J(job(D1.o)));
ok('deciding twice is refused', !box.actionAdminResolveJobPayment(A, { jobId: D1.id, outcome: 'pay_driver', note: 'second thoughts here' }).ok);
const D2 = collected(7);
dan('actionDriverUpdateJob', { jobId: D2.id, act: 'failed', reason: 'other', note: 'Road was flooded and closed', requestId: rq() });
r = box.actionAdminResolveJobPayment(A, { jobId: D2.id, outcome: 'pay_driver', note: 'Road closure, not the driver\'s fault' });
ok('admin pays the driver instead: credited', r.ok && job(D2.o).PayStatus === 'credited' && ledger().some((e) => e.JobId === D2.id && e.Amount === 7), J(r));

/* ---- the hold, payout details and claiming ---- */
const now0 = Date.now();
ok('before the hold ends nothing can be claimed', !dan('actionDriverClaimPayout', { requestId: rq() }).ok);
r = dan('actionDriverSetPayoutDetails', { details: 'x' });
ok('payout details must be real', !r.ok);
ok('a driver outside the pilot has no wallet and cannot set details', eve('actionGetDriverHome', {}).wallet === null && !eve('actionDriverSetPayoutDetails', { details: 'ANZ Eve Driver 123456789' }).ok && !eve('actionDriverClaimPayout', { requestId: rq() }).ok);
// Time passes: move every credit's hold into the past.
const sheet = box.__sheets.DriverLedger;
const makeAvailable = () => { box.sheetToObjects(box.getSheet('DriverLedger')).forEach((e) => { if (e.EntryType === 'CREDIT') box.updateRowFromObject(box.getSheet('DriverLedger'), e.__row, { AvailableAt: new Date(Date.now() - HOUR).toISOString() }); }); };
makeAvailable();
const total = ledger().filter((e) => e.EntryType === 'CREDIT').reduce((n, e) => n + e.Amount, 0);
ok('after the hold the balance is available (' + total + ')', wal().balance.available === total && total >= 20, J(wal().balance));
r = dan('actionDriverClaimPayout', { requestId: rq() });
ok('claiming needs payout details first', !r.ok && /where to send/i.test(r.error), J(r));
r = dan('actionDriverSetPayoutDetails', { details: 'ANZ Bank, Dan Driver, account 123456789' });
ok('the driver saves where to be paid', r.ok && wal().payoutDetails === 'ANZ Bank, Dan Driver, account 123456789' && wal().canClaim, J(r));
const claimReq = rq();
r = dan('actionDriverClaimPayout', { requestId: claimReq });
ok('claim: the whole available balance is requested, admins emailed', r.ok && r.claimed === total && bal().available === 0 && bal().claimed === total && box.__mail.some((m) => /admin@x.test/.test(m[0]) && /asked to be paid/.test(m[1])), J(r));
ok('the claim keeps a copy of the payout details', ledger().find((e) => e.EntryType === 'CLAIM').Note === 'ANZ Bank, Dan Driver, account 123456789');
ok('a double tap (same request) is the same claim', (() => { const x = dan('actionDriverClaimPayout', { requestId: claimReq }); return x.ok && x.repeated && ledger().filter((e) => e.EntryType === 'CLAIM').length === 1; })());
ok('a new claim with nothing left is refused', !dan('actionDriverClaimPayout', { requestId: rq() }).ok);
ok('the wallet history shows credits and the waiting claim', wal().entries.some((e) => e.type === 'CLAIM' && e.status === 'waiting to be paid') && wal().entries.some((e) => e.type === 'CREDIT'));

/* ---- admin payout queue ---- */
let pq = box.actionAdminListPayouts(A, {});
ok('admin sees the claim with the driver\'s details', pq.ok && pq.claims.length === 1 && pq.claims[0].amount === total && /123456789/.test(pq.claims[0].details) && pq.claims[0].driverName === 'Dan', J(pq.claims));
ok('and what Mwakete should be holding', pq.holding.claimsToPay === total && pq.holding.refundsDue === 6 && pq.holding.total === total + 6, J(pq.holding));
ok('a seller cannot see or touch payouts', !box.actionAdminListPayouts(S, {}).ok && !box.actionAdminMarkPayoutPaid(S, { claimId: pq.claims[0].claimId, bankRef: 'ANZ-1' }).ok);
ok('paying needs a bank reference', !box.actionAdminMarkPayoutPaid(A, { claimId: pq.claims[0].claimId, bankRef: '' }).ok);
ok('an admin cannot pay their own driver account', (() => { const dr = box.sheetToObjects(box.getSheet('Drivers')).find((d) => d.Name === 'Dan'); box.updateRowFromObject(box.getSheet('Drivers'), dr.__row, { Email: 'admin@x.test' });
  const bad = !box.actionAdminMarkPayoutPaid(A, { claimId: pq.claims[0].claimId, bankRef: 'ANZ-77' }).ok; box.updateRowFromObject(box.getSheet('Drivers'), dr.__row, { Email: 'd@x.test' }); return bad; })());
r = box.actionAdminMarkPayoutPaid(A, { claimId: pq.claims[0].claimId, bankRef: 'ANZ-PAYOUT-1' });
pq = box.actionAdminListPayouts(A, {});
ok('admin pays: claim leaves the queue, shows as paid out, the driver is emailed', r.ok && pq.claims.length === 0 && pq.recent[0].paidRef === 'ANZ-PAYOUT-1' && bal().paidOut === total
  && box.__mail.some((m) => m[0] === 'd@x.test' && /paid you/.test(m[1])), J(pq.recent));
ok('paying the same claim twice is refused', !box.actionAdminMarkPayoutPaid(A, { claimId: pq.recent[0].claimId, bankRef: 'ANZ-PAYOUT-2' }).ok);
ok('the driver sees it paid, with the reference', wal().entries.find((e) => e.type === 'CLAIM').status === 'paid' && wal().entries.find((e) => e.type === 'CLAIM').reference === 'ANZ-PAYOUT-1');

/* ---- reversing a claim, and corrections ---- */
const Z = collected(25);
buyer('actionTxConfirmReceipt', { orderId: (deliver(Z), Z.o), choice: 'ok', requestId: rq() });
makeAvailable();
dan('actionDriverClaimPayout', { requestId: rq() });
const open = box.actionAdminListPayouts(A, {}).claims[0];
ok('reversing needs a reason', !box.actionAdminReversePayout(A, { claimId: open.claimId, reason: 'no' }).ok);
r = box.actionAdminReversePayout(A, { claimId: open.claimId, reason: 'Account number was wrong' });
ok('a reversed claim goes back to the balance and out of the queue', r.ok && bal().available === 25 && bal().claimed === 0 && box.actionAdminListPayouts(A, {}).claims.length === 0, J(bal()));
ok('a correction needs a driver, an amount, a reason and a request id', !box.actionAdminAdjustDriverWallet(A, { driverId: 'nope', amount: 1, reason: 'a typo here', requestId: rq() }).ok
  && !box.actionAdminAdjustDriverWallet(A, { driverId: idOf('Dan'), amount: 0, reason: 'a typo here', requestId: rq() }).ok && !box.actionAdminAdjustDriverWallet(A, { driverId: idOf('Dan'), amount: -5, reason: 'x', requestId: rq() }).ok);
const adjReq = rq();
r = box.actionAdminAdjustDriverWallet(A, { driverId: idOf('Dan'), amount: -5, reason: 'Buyer dispute on the Z order', requestId: adjReq });
ok('a correction is applied once (even if sent twice) and audited', r.ok && bal().available === 20 && box.actionAdminAdjustDriverWallet(A, { driverId: idOf('Dan'), amount: -5, reason: 'Buyer dispute on the Z order', requestId: adjReq }).repeated === true && bal().available === 20
  && box.__sheets.Audit_Log.objects().some((x) => x.Action === 'DRIVER_WALLET_ADJUSTED'), J(bal()));
ok('a seller cannot adjust', !box.actionAdminAdjustDriverWallet(S, { driverId: idOf('Dan'), amount: 1, reason: 'sneaky change', requestId: rq() }).ok);

/* ---- the ledger never reaches the buyer or another driver ---- */
ok('a buyer, a seller\'s room and another driver never see wallet figures', !JSON.stringify(buyer('actionGetTxRoom', { orderId: Z.o })).includes('"balance"') && eve('actionGetDriverHome', {}).wallet === null);
ok('old sheets get the payout column added', box.__sheets.Drivers.grid[0].indexOf('PayoutDetails') !== -1);

let fails = 0;
console.log('\n--- driver wallet: credit, claim, pay ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
