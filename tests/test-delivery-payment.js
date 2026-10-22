/**
 * Seller pays Mwakete (driver wallet phase 3) on the REAL backend sources:
 * payment reference after the fee locks, the seller sending bank details,
 * an admin confirming against the real statement (or rejecting), the pickup
 * gate, details hidden from the driver until then, and refunds when a job
 * ends before the goods are collected.
 */
const { makeBox } = require('./lib/gas-harness.js');
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
dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true });
const idOf = (name) => box.__sheets.Drivers.objects().find((d) => d.Name === name).DriverId;
box.actionAdminSetDriverStatus(A, { driverId: idOf('Dan'), status: 'approved' });
dan('actionDriverSetAvailable', { available: true });
box.__props.DELIVERY_PAYMENTS = 'pilot';
box.__props.DELIVERY_PAYMENTS_DRIVERS = idOf('Dan');
const rq = (() => { let n = 0; return () => 'req-' + (++n) + '-abcdefgh'; })();
let r;
const jobRow = (id) => job(id);
const mine = (jobId) => dan('actionGetDriverHome', {}).mine.find((j) => j.jobId === jobId);
// An order with a locked fee, ready for the seller to pay.
const locked = (fee) => { const o = order(); ready(o); seller('actionTxRequestDriver', { orderId: o, fee, pickup: 'Back door of the Bong shop, Betio', notes: 'Fragile' });
  const id = job(o).JobId; dan('actionDriverAcceptJob', { jobId: id, requestId: rq() }); dan('actionDriverAgreeFee', { jobId: id, fee }); seller('actionTxAgreeFee', { orderId: o, fee }); return { o, id }; };

/* ---- locking creates the payment reference ---- */
const A1 = locked(8);
ok('when the fee locks the seller owes Mwakete: awaiting, with a reference', job(A1.o).PayStatus === 'awaiting' && /^MWK-[A-Z0-9]{8}$/.test(job(A1.o).PayRef), J(job(A1.o)));
ok('the lock message tells both sides who pays (the reference stays with the seller)', seller('actionGetTxRoom', { orderId: A1.o }).room.delivery.chat.messages.some((m) => m.by === 'system' && /pays \$?8.*to Mwakete/.test(m.body)));

/* ---- the driver sees nothing private until the money is confirmed ---- */
let dv = mine(A1.id);
ok('driver: pickup place, store phone, buyer name/phone/items and notes are hidden', dv.detailsLocked && dv.pickup === '' && dv.storePhone === '' && dv.buyerName === '' && dv.buyerPhone === '' && dv.items.length === 0 && dv.notes === '', J(dv));
ok('...but sees where it is going (village) and the payment status', /Betio/.test(dv.dropoff) && dv.chat.payment.status === 'awaiting');
ok('driver never gets the bank details, the reference or the bank reference', !JSON.stringify(dan('actionGetDriverHome', {})).includes('MWK-') && !JSON.stringify(dv).includes('ANZ'));
ok('the buyer sees no payment panel', buyer('actionGetTxRoom', { orderId: A1.o }).room.delivery.chat === null);

/* ---- seller sends payment details ---- */
let sp = () => seller('actionGetTxRoom', { orderId: A1.o }).room.delivery.chat.payment;
ok('bank details not set up: the seller is told, and cannot submit', sp().bankMissing && !sp().canSubmit && !seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ123', amount: 8 }).ok);
box.__props.MWAKETE_BANK_DETAILS = 'ANZ 000-111 Mwakete Ltd';
ok('once set, the seller (only) sees the bank details and reference', sp().canSubmit && sp().bankDetails === 'ANZ 000-111 Mwakete Ltd' && sp().reference === job(A1.o).PayRef);
ok('a buyer cannot submit; the driver cannot submit', !buyer('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ123', amount: 8 }).ok);
ok('a bank reference is needed', !seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ab', amount: 8 }).ok);
ok('the amount must be exactly the agreed fee', !seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ123', amount: 7 }).ok && !seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ123', amount: 9 }).ok);
r = seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ-7788', amount: 8, requestId: rq() });
ok('seller submits: status submitted, admins emailed', r.ok && job(A1.o).PayStatus === 'submitted' && job(A1.o).PayBankRef === 'ANZ-7788' && box.__mail.some((m) => /admin@x.test/.test(m[0]) && /needs checking/.test(m[1])), J(r));
ok('submitting twice is refused', !seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ-7788', amount: 8 }).ok);
r = dan('actionDriverUpdateJob', { jobId: A1.id, act: 'picked_up', requestId: rq() });
ok('the driver still cannot collect while it is only submitted', !r.ok && /not confirmed/.test(r.error), J(r));

/* ---- admin confirm / reject ---- */
const adminBox = (fn, b) => box[fn](A, b);
ok('a seller cannot confirm', !box.actionAdminConfirmJobPayment(S, { jobId: A1.id, amountReceived: 8, checkedStatement: true }).ok);
ok('confirming needs "I checked the real bank statement"', !adminBox('actionAdminConfirmJobPayment', { jobId: A1.id, amountReceived: 8 }).ok);
ok('less than the fee cannot be confirmed', !adminBox('actionAdminConfirmJobPayment', { jobId: A1.id, amountReceived: 5, checkedStatement: true }).ok);
ok('an admin cannot confirm for their own store', (() => { const x = box.sheetToObjects(box.getSheet('Owners'))[0]; const old = x.Email; box.updateRowFromObject(box.getSheet('Owners'), x.__row, { Email: 'admin@x.test' });
  const bad = !adminBox('actionAdminConfirmJobPayment', { jobId: A1.id, amountReceived: 8, checkedStatement: true }).ok; box.updateRowFromObject(box.getSheet('Owners'), x.__row, { Email: old }); return bad; })());
ok('rejecting needs a reason the seller sees', !adminBox('actionAdminRejectJobPayment', { jobId: A1.id, reason: 'no' }).ok);
r = adminBox('actionAdminRejectJobPayment', { jobId: A1.id, reason: 'Nothing arrived with that reference' });
ok('rejected: seller sees why and may send it again', r.ok && sp().status === 'rejected' && /Nothing arrived/.test(sp().note) && sp().canSubmit, J(sp()));
ok('...and the seller is emailed', box.__mail.some((m) => m[0] === 's@x.test' && /could not match/.test(m[1])));
ok('rejecting a payment that is not submitted is refused', !adminBox('actionAdminRejectJobPayment', { jobId: A1.id, reason: 'Nothing arrived again' }).ok);
ok('resubmitting works', seller('actionTxSubmitJobPayment', { orderId: A1.o, bankRef: 'ANZ-9900', amount: 8, requestId: rq() }).ok && job(A1.o).PayStatus === 'submitted');
r = adminBox('actionAdminConfirmJobPayment', { jobId: A1.id, amountReceived: 8.5, checkedStatement: true });
ok('confirmed (a little extra is noted for return by hand)', r.ok && job(A1.o).PayStatus === 'received' && /more than the fee/.test(job(A1.o).PayNote) && job(A1.o).PayCheckedBy === 'own_a', J(r));
ok('the audit log records submit-less steps: reject then confirm', ['DELIVERY_PAYMENT_REJECTED', 'DELIVERY_PAYMENT_CONFIRMED'].every((a) => box.__sheets.Audit_Log.objects().some((x) => x.Action === a && x.EntityId === A1.id)));
ok('confirming twice is refused', !adminBox('actionAdminConfirmJobPayment', { jobId: A1.id, amountReceived: 8, checkedStatement: true }).ok);
ok('the driver is emailed that they can collect', box.__mail.some((m) => m[0] === 'd@x.test' && /You can collect/.test(m[1])));
dv = mine(A1.id);
ok('driver now sees pickup, store phone and the buyer', !dv.detailsLocked && /Back door/.test(dv.pickup) && dv.storePhone !== '' && dv.buyerName === 'Tia' && dv.buyerPhone === '73000001' && dv.items.length === 1 && dv.notes === 'Fragile', J(dv));
r = dan('actionDriverUpdateJob', { jobId: A1.id, act: 'picked_up', requestId: rq() });
ok('and can collect', r.ok, J(r));

/* ---- admin list ---- */
const B1 = locked(6);
seller('actionTxSubmitJobPayment', { orderId: B1.o, bankRef: 'ANZ-1111', amount: 6, requestId: rq() });
let list = box.actionAdminListDeliveries(A, { status: 'payments' });
ok('admin list: payments to check are counted and listed with the references, bank details flagged as set', list.counts.paymentsToCheck === 1 && list.bankDetailsSet && list.jobs.length === 1
  && list.jobs[0].payRef === job(B1.o).PayRef && list.jobs[0].payBankRef === 'ANZ-1111' && list.jobs[0].payAmount === 6, J(list.jobs));
ok('a seller cannot list or act', !box.actionAdminListDeliveries(S, {}).ok && !box.actionAdminMarkJobRefunded(S, { jobId: B1.id, bankRef: 'ANZ-222' }).ok);

/* ---- refunds when the job ends before collection ---- */
adminBox('actionAdminConfirmJobPayment', { jobId: B1.id, amountReceived: 6, checkedStatement: true });
r = seller('actionTxCancelDriverJob', { orderId: B1.o, reason: 'Changed my mind about delivery' });
ok('seller cancels after paying: Mwakete now owes the seller a refund', r.ok && job(B1.o).PayStatus === 'refund_due' && box.actionAdminListDeliveries(A, {}).counts.refundsDue === 1, J(job(B1.o)));
ok('refund needs a bank reference', !adminBox('actionAdminMarkJobRefunded', { jobId: B1.id, bankRef: '' }).ok);
ok('admin returns it and records the reference', adminBox('actionAdminMarkJobRefunded', { jobId: B1.id, bankRef: 'ANZ-REF-1' }).ok && job(B1.o).PayStatus === 'refunded' && job(B1.o).PayRefundRef === 'ANZ-REF-1' && box.__mail.some((m) => m[0] === 's@x.test' && /refunded/.test(m[1])));
ok('refunding twice is refused', !adminBox('actionAdminMarkJobRefunded', { jobId: B1.id, bankRef: 'ANZ-REF-2' }).ok);

const C1 = locked(7);
seller('actionTxSubmitJobPayment', { orderId: C1.o, bankRef: 'ANZ-3333', amount: 7, requestId: rq() });
adminBox('actionAdminConfirmJobPayment', { jobId: C1.id, amountReceived: 7, checkedStatement: true });
seller('actionTxCancel', { orderId: C1.o, reason: 'Buyer cancelled the order' });
ok('the order cancelled before collection also makes the refund due', job(C1.o).Status === 'cancelled' && job(C1.o).PayStatus === 'refund_due', J(job(C1.o)));

const D1 = locked(9);
ok('a job cancelled before the seller paid owes nothing', (seller('actionTxCancelDriverJob', { orderId: D1.o, reason: 'No longer needed here' }), job(D1.o).PayStatus === 'awaiting'));

const E1 = locked(4);
seller('actionTxSubmitJobPayment', { orderId: E1.o, bankRef: 'ANZ-4444', amount: 4, requestId: rq() });
adminBox('actionAdminConfirmJobPayment', { jobId: E1.id, amountReceived: 4, checkedStatement: true });
dan('actionDriverUpdateJob', { jobId: E1.id, act: 'failed', reason: 'wrong_address', note: 'Could not find the house', requestId: rq() });
ok('driver reports failure before collecting: refund due', job(E1.o).Status === 'failed' && job(E1.o).PayStatus === 'refund_due', J(job(E1.o)));

const F1 = locked(3);
seller('actionTxSubmitJobPayment', { orderId: F1.o, bankRef: 'ANZ-5555', amount: 3, requestId: rq() });
adminBox('actionAdminConfirmJobPayment', { jobId: F1.id, amountReceived: 3, checkedStatement: true });
dan('actionDriverUpdateJob', { jobId: F1.id, act: 'picked_up', requestId: rq() });
dan('actionDriverUpdateJob', { jobId: F1.id, act: 'failed', reason: 'refused', note: 'The buyer refused it', requestId: rq() });
ok('failure AFTER collecting never auto-refunds the seller (phase 4: the driver is paid for a refused delivery)', job(F1.o).Status === 'failed' && job(F1.o).PayStatus === 'credited', J(job(F1.o)));

/* ---- wallet off: untouched ---- */
box.__props.DELIVERY_PAYMENTS = 'off';
const G1 = order(); ready(G1); seller('actionTxRequestDriver', { orderId: G1, fee: 5, pickup: 'Back door of the Bong shop' });
dan('actionDriverAcceptJob', { jobId: job(G1).JobId, requestId: rq() });
ok('wallet off: no payment status, details visible, driver collects freely', (job(G1).PayStatus || '') === '' && !mine(job(G1).JobId).detailsLocked && dan('actionDriverUpdateJob', { jobId: job(G1).JobId, act: 'picked_up', requestId: rq() }).ok);
ok('old sheets get the payment columns added', ['PayRef', 'PayStatus', 'PayBankRef', 'PayAmount', 'PayNote', 'PaySubmittedAt', 'PayCheckedBy', 'PayCheckedAt', 'PayRefundRef'].every((h) => box.__sheets.DeliveryJobs.grid[0].indexOf(h) !== -1));

let fails = 0;
console.log('\n--- seller pays Mwakete ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
