/**
 * Delivery job chat and fee agreement (driver wallet phase 2) on the REAL
 * backend sources: off for drivers the wallet does not cover; for covered
 * drivers a private seller/driver chat, propose/agree/lock, the pickup gate,
 * and that the buyer never sees any of it.
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
const rq = (() => { let n = 0; return () => 'req-' + (++n) + '-abcdefgh'; })();
let r;

/* ---- not covered: nothing changes ---- */
let a = order(); ready(a);
seller('actionTxRequestDriver', { orderId: a, fee: 5, pickup: 'Back door of the Bong shop' });
let jobA = job(a).JobId;
dan('actionDriverAcceptJob', { jobId: jobA, requestId: rq() });
ok('wallet off: no chat panel for the seller or the driver', seller('actionGetTxRoom', { orderId: a }).room.delivery.chat === null && dan('actionGetDriverHome', {}).mine[0].chat === null);
ok('wallet off: chat and fee actions are refused', !seller('actionTxJobMessage', { orderId: a, text: 'hi' }).ok && !dan('actionDriverProposeFee', { jobId: jobA, fee: 6 }).ok && !dan('actionDriverAgreeFee', { jobId: jobA, fee: 5 }).ok);
r = dan('actionDriverUpdateJob', { jobId: jobA, act: 'picked_up', requestId: rq() });
ok('wallet off: the driver collects without any fee agreement, as before', r.ok, J(r));

/* ---- covered driver (pilot, Dan only) ---- */
box.__props.DELIVERY_PAYMENTS = 'pilot';
box.__props.DELIVERY_PAYMENTS_DRIVERS = idOf('Dan');
const b = order(); ready(b);
r = seller('actionTxRequestDriver', { orderId: b, fee: 5, pickup: 'Back door of the Bong shop' });
const jobB = job(b).JobId;
ok('the seller\'s booking fee counts as the seller\'s offer', r.ok && job(b).FeeSellerOk === 'yes' && job(b).FeeProposedBy === 'seller' && job(b).FeeLocked !== 'yes');
ok('before a driver accepts there is no chat to write in', !seller('actionTxJobMessage', { orderId: b, text: 'hello' }).ok);
dan('actionDriverAcceptJob', { jobId: jobB, requestId: rq() });
let sv = seller('actionGetTxRoom', { orderId: b }).room.delivery.chat;
let dv = () => dan('actionGetDriverHome', {}).mine.find((j) => j.jobId === jobB).chat;
ok('both sides now see an open chat with the fee $5 not yet agreed', sv && dv() && sv.fee.amount === 5 && !sv.fee.locked && !dv().fee.locked && sv.canWrite && dv().canWrite, J(sv));
ok('the seller already agreed; the driver can agree, the seller cannot', dv().fee.canAgree && !sv.fee.canAgree && sv.fee.agreedByMe && !dv().fee.agreedByMe);
ok('the buyer sees no chat at all', buyer('actionGetTxRoom', { orderId: b }).room.delivery.chat === null && !JSON.stringify(buyer('actionGetTxRoom', { orderId: b })).includes('dmg_'));

/* messages */
ok('an empty message is refused', !seller('actionTxJobMessage', { orderId: b, text: '  ' }).ok);
ok('seller and driver can talk', seller('actionTxJobMessage', { orderId: b, text: 'Can you do it for $4?', requestId: rq() }).ok && dan('actionDriverJobMessage', { jobId: jobB, text: 'Make it $6, it is far', requestId: rq() }).ok);
sv = seller('actionGetTxRoom', { orderId: b }).room.delivery.chat;
ok('both messages are in order, marked mine/theirs', sv.messages.length === 2 && sv.messages[0].mine && !sv.messages[1].mine && dv().messages[1].mine, J(sv.messages));
ok('the other side is emailed once (throttled)', box.__mail.filter((m) => m[0] === 'd@x.test' && /New message about a delivery/.test(m[1])).length === 1);
ok('another driver cannot read or write this job', !eve('actionDriverJobMessage', { jobId: jobB, text: 'hi' }).ok && !JSON.stringify(eve('actionGetDriverHome', {})).includes('Make it $6'));
ok('a buyer cannot write in it', !buyer('actionTxJobMessage', { orderId: b, text: 'hi' }).ok);

/* propose / agree / lock */
ok('a fee must be above 0 and up to 500', !dan('actionDriverProposeFee', { jobId: jobB, fee: 0 }).ok && !dan('actionDriverProposeFee', { jobId: jobB, fee: 501 }).ok && !dan('actionDriverProposeFee', { jobId: jobB, fee: 'abc' }).ok);
r = dan('actionDriverProposeFee', { jobId: jobB, fee: 6 });
ok('the driver proposes $6: it resets the seller\'s agreement', r.ok && job(b).Fee === 6 && job(b).FeeSellerOk === '' && job(b).FeeDriverOk === 'yes' && job(b).FeeProposedBy === 'driver', J(job(b)));
ok('the proposer cannot agree to their own offer', !dan('actionDriverAgreeFee', { jobId: jobB, fee: 6 }).ok);
r = dan('actionDriverUpdateJob', { jobId: jobB, act: 'picked_up', requestId: rq() });
ok('the driver cannot collect before the fee is locked', !r.ok && /Agree the delivery fee/.test(r.error), J(r));
ok('agreeing to a stale amount is refused', (() => { const x = seller('actionTxAgreeFee', { orderId: b, fee: 5 }); return !x.ok && x.stale; })());
ok('a buyer cannot agree', !buyer('actionTxAgreeFee', { orderId: b, fee: 6 }).ok);
r = seller('actionTxAgreeFee', { orderId: b, fee: 6, requestId: rq() });
ok('the seller agrees to $6: the fee locks', r.ok && r.locked && job(b).FeeLocked === 'yes' && job(b).Fee === 6, J(r));
ok('system lines record the proposal and the lock', seller('actionGetTxRoom', { orderId: b }).room.delivery.chat.messages.some((m) => m.by === 'system' && /locked/.test(m.body)));
ok('a locked fee cannot be proposed again', !seller('actionTxProposeFee', { orderId: b, fee: 3 }).ok && !dan('actionDriverProposeFee', { jobId: jobB, fee: 9 }).ok && job(b).Fee === 6);
ok('the audit log records the lock', box.__sheets.Audit_Log.objects().some((x) => x.Action === 'DELIVERY_FEE_LOCKED' && x.EntityId === jobB));
// Phase 3: collecting also needs Mwakete to have confirmed the seller's payment.
box.__props.MWAKETE_BANK_DETAILS = 'ANZ 000-111 Mwakete Ltd';
seller('actionTxSubmitJobPayment', { orderId: b, bankRef: 'ANZ123456', amount: 6, requestId: rq() });
box.actionAdminConfirmJobPayment(A, { jobId: jobB, amountReceived: 6, checkedStatement: true });
r = dan('actionDriverUpdateJob', { jobId: jobB, act: 'picked_up', requestId: rq() });
ok('now the driver can collect', r.ok, J(r));
ok('after pickup the chat stays open to talk but the fee is fixed', dv().canWrite && !dv().fee.canPropose && dan('actionDriverJobMessage', { jobId: jobB, text: 'On my way', requestId: rq() }).ok);

/* the seller can propose too, and the driver agrees */
const c = order(); ready(c);
seller('actionTxRequestDriver', { orderId: c, fee: 5, pickup: 'Back door of the Bong shop' });
dan('actionDriverAcceptJob', { jobId: job(c).JobId, requestId: rq() });
r = seller('actionTxProposeFee', { orderId: c, fee: 4.5 });
ok('the seller proposes $4.50, the driver agrees, it locks', r.ok && dan('actionDriverAgreeFee', { jobId: job(c).JobId, fee: 4.5 }).locked === true && job(c).Fee === 4.5);
const wrongSide = order(); ready(wrongSide);
seller('actionTxRequestDriver', { orderId: wrongSide, fee: 5, pickup: 'Back door of the Bong shop' });
ok('the seller cannot "agree" to their own offer', (dan('actionDriverAcceptJob', { jobId: job(wrongSide).JobId, requestId: rq() }), !seller('actionTxAgreeFee', { orderId: wrongSide, fee: 5 }).ok));

/* a driver the pilot does not cover is unaffected even when others are */
const d2 = order(); ready(d2);
seller('actionTxRequestDriver', { orderId: d2, fee: 5, pickup: 'Back door of the Bong shop' });
eve('actionDriverAcceptJob', { jobId: job(d2).JobId, requestId: rq() });
ok('Eve (not in the pilot) has no chat and may collect freely', eve('actionGetDriverHome', {}).mine[0].chat === null && eve('actionDriverUpdateJob', { jobId: job(d2).JobId, act: 'picked_up', requestId: rq() }).ok);
ok('old sheets get the new columns added', ['FeeProposedBy', 'FeeSellerOk', 'FeeDriverOk', 'FeeLocked'].every((h) => box.__sheets.DeliveryJobs.grid[0].indexOf(h) !== -1));

let fails = 0;
console.log('\n--- job chat and fee agreement ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
