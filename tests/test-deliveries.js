/**
 * Drivers and delivery jobs (Deliveries.gs, Oct 2026 stage 6) on the REAL
 * backend sources: applying and approval, the job journey through the order
 * room (request -> accept -> pickup = dispatch -> delivered with proof ->
 * buyer confirms -> completed), failure, cancel, fee paid, live location
 * rules, and who may see or do what.
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

/* ---- switched off ---- */
let r = dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true });
ok('off by default: nobody can apply', !r.ok && /not open/.test(r.error));
const o0 = order(); ready(o0);
ok('off by default: no driver step in the order room', seller('actionGetTxRoom', { orderId: o0 }).room.delivery === null);
box.__props.DELIVERY_JOBS = 'on';

/* ---- applying ---- */
ok('apply needs a real local phone and the rules agreed', !dan('actionDriverApply', { name: 'Dan', phone: '12345', vehicle: 'motorbike', area: 'South Tarawa', agree: true }).ok
  && !dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa' }).ok);
ok('an area outside coverage is refused', !dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'Abaiang', agree: true }).ok);
r = dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'motorbike', area: 'South Tarawa', agree: true });
ok('a customer applies to drive -> pending, admins emailed', r.ok && r.status === 'pending' && box.__mail.some((m) => /admin@x.test/.test(m[0]) && /driver application/i.test(m[1])));
ok('one application per account', !dan('actionDriverApply', { name: 'Dan', phone: '73000009', vehicle: 'car', area: 'South Tarawa', agree: true }).ok);
eve('actionDriverApply', { name: 'Eve', phone: '73000008', vehicle: 'car', area: 'South Tarawa', agree: true });
drv('c-adm')('actionDriverApply', { name: 'Admin', phone: '73000006', vehicle: 'car', area: 'South Tarawa', agree: true });
const drivers = () => box.__sheets.Drivers.objects();
const idOf = (name) => drivers().find((d) => d.Name === name).DriverId;
ok('a pending driver sees no jobs and cannot go online', dan('actionGetDriverHome', {}).open.length === 0 && !dan('actionDriverSetAvailable', { available: true }).ok);
ok('a seller cannot approve drivers', !box.actionAdminSetDriverStatus(S, { driverId: idOf('Dan'), status: 'approved' }).ok);
ok('an admin cannot approve their own application', !box.actionAdminSetDriverStatus(A, { driverId: idOf('Admin'), status: 'approved' }).ok);
ok('rejecting needs a reason the driver sees', !box.actionAdminSetDriverStatus(A, { driverId: idOf('Eve'), status: 'rejected' }).ok);
ok('admin approves Dan and Eve', box.actionAdminSetDriverStatus(A, { driverId: idOf('Dan'), status: 'approved' }).ok && box.actionAdminSetDriverStatus(A, { driverId: idOf('Eve'), status: 'approved' }).ok);
ok('approved drivers go online', dan('actionDriverSetAvailable', { available: true }).ok && eve('actionDriverSetAvailable', { available: true }).ok);

/* ---- the journey ---- */
const a = order();
r = seller('actionTxRequestDriver', { orderId: a, fee: 5, pickup: 'Back door of the Bong shop, Betio' });
ok('cannot book a driver before the goods are checked', !r.ok && /Check the goods/.test(r.error));
ready(a);
let room = seller('actionGetTxRoom', { orderId: a }).room;
ok('the seller is offered "request a driver" once ready', room.delivery.canRequest && room.actions.indexOf('requestDriver') !== -1);
ok('...and a collection order never is', (() => { const c = order({ deliveryMethod: 'pickPay' }); ready(c); return !seller('actionGetTxRoom', { orderId: c }).room.delivery.canRequest; })());
ok('only the covered islands (default South Tarawa) can book a driver', box.deliveryCovers({ Island: 'South Tarawa' }) && !box.deliveryCovers({ Island: 'Abaiang' })
  && (box.__props.DELIVERY_AREAS = 'South Tarawa, Abaiang', box.deliveryCovers({ Island: 'Abaiang' })));
delete box.__props.DELIVERY_AREAS;
ok('the fee must be 0-500 and pickup described', !seller('actionTxRequestDriver', { orderId: a, fee: 900, pickup: 'Back door' }).ok && !seller('actionTxRequestDriver', { orderId: a, fee: 5, pickup: '' }).ok);
ok('a buyer cannot book a driver', !buyer('actionTxRequestDriver', { orderId: a, fee: 5, pickup: 'Back door of the shop' }).ok);
r = seller('actionTxRequestDriver', { orderId: a, fee: 5, pickup: 'Back door of the Bong shop, Betio', notes: 'Fragile' });
ok('seller books a driver; the buyer is told what the driver will see', r.ok && job(a).Status === 'open'
  && buyer('actionGetTxRoom', { orderId: a }).events.some((e) => /driver accepts, they will see your name, phone and village/.test(e.body)));
ok('online drivers in the area are emailed', box.__mail.some((m) => m[0] === 'd@x.test' && /New delivery job/.test(m[1])));
ok('only one active job per order', !seller('actionTxRequestDriver', { orderId: a, fee: 5, pickup: 'Back door of the Bong shop' }).ok);
ok('while a driver is booked, the seller\'s own "record sending" is refused', !seller('actionTxDispatch', { orderId: a, dispatch: { date: today } }).ok);
let home = dan('actionGetDriverHome', {});
const listed = home.open.find((x) => x.orderId === undefined && x.fee === 5);
ok('drivers see the job with area and fee, but NOT the buyer\'s name or phone', home.open.length >= 1 && !JSON.stringify(home.open).includes('73000001') && !JSON.stringify(home.open).includes('Tia')
  && /Betio, South Tarawa/.test(home.open[0].dropoffArea), J(home.open));
const jobId = job(a).JobId;
ok('an offline driver does not see open jobs', (eve('actionDriverSetAvailable', { available: false }), eve('actionGetDriverHome', {}).open.length === 0));
eve('actionDriverSetAvailable', { available: true });
r = dan('actionDriverAcceptJob', { jobId });
ok('Dan accepts', r.ok && job(a).Status === 'accepted' && job(a).DriverId === idOf('Dan'));
r = eve('actionDriverAcceptJob', { jobId });
ok('Eve cannot take the same job', !r.ok && /already taken/.test(r.error));
ok('Eve cannot act on Dan\'s job', !eve('actionDriverUpdateJob', { jobId, act: 'picked_up' }).ok && !eve('actionDriverShareLocation', { jobId, share: true, lat: 1.35, lng: 172.93 }).ok);
home = dan('actionGetDriverHome', {});
ok('after accepting, Dan sees the buyer\'s name, phone, items and pickup notes', home.mine[0].buyerPhone === '73000001' && home.mine[0].buyerName === 'Tia'
  && home.mine[0].pickup.includes('Back door') && home.mine[0].items[0] === '1 × Rice - 10kg', J(home.mine[0]));
room = buyer('actionGetTxRoom', { orderId: a }).room;
ok('the buyer sees the driver\'s name and phone, not the fee', room.delivery.driverName === 'Dan' && room.delivery.driverPhone === '73000009' && room.delivery.fee === undefined);

/* ---- live location ---- */
ok('a bad location is refused', !dan('actionDriverShareLocation', { jobId, share: true, lat: 999, lng: 1 }).ok);
r = dan('actionDriverShareLocation', { jobId, share: true, lat: 1.3521, lng: 172.9784, accuracy: 12 });
ok('Dan shares his location (opt-in)', r.ok && r.sharing && job(a).LastLat === '1.35210');
ok('repeat points within 25s are throttled, not stored', dan('actionDriverShareLocation', { jobId, share: true, lat: 1.4, lng: 172.9 }).throttled === true && job(a).LastLat === '1.35210');
room = seller('actionGetTxRoom', { orderId: a }).room;
ok('seller and buyer see a free map link to the last point', /openstreetmap\.org\/\?mlat=1\.35210&mlon=172\.97840/.test(room.delivery.location.link)
  && !!buyer('actionGetTxRoom', { orderId: a }).room.delivery.location);
ok('a stranger customer cannot see the job or its location', call('actionGetTxRoom', { side: 'buyer', token: 'c-n', orderId: a }).error === 'Order not found');

/* ---- pickup, delivery, completion ---- */
r = dan('actionDriverUpdateJob', { jobId, act: 'delivered', recipientName: 'Tia' });
ok('cannot deliver before pickup', !r.ok);
r = dan('actionDriverUpdateJob', { jobId, act: 'picked_up', note: 'Collected 2pm' });
ok('pickup is the order\'s dispatch record (by the driver), stock leaves the shelf', r.ok && stateOf(a).FulfilmentState === 'dispatched'
  && box.__sheets.TxRecords.objects().some((x) => x.OrderId === a && x.Type === 'dispatch' && x.ActorType === 'driver'), J(r));
ok('the room shows it as the driver, and the buyer is asked to confirm when it arrives', buyer('actionGetTxRoom', { orderId: a }).events.some((e) => e.byLabel === 'Driver' && /collected the goods/.test(e.body)));
ok('the seller cannot cancel once the driver has the goods', !seller('actionTxCancelDriverJob', { orderId: a, reason: 'Changed my mind' }).ok);
r = dan('actionDriverUpdateJob', { jobId, act: 'delivered', recipientName: 'Tia' });
ok('delivery needs a proof photo', !r.ok && r.requirement === 'delivery.photo');
ok('a buyer cannot upload "driver proof"', !call('actionDriverUploadProof', { token: 'c-b', jobId, dataBase64: png(800, 600), mimeType: 'image/png' }).ok);
const proof = dan('actionDriverUploadProof', { jobId, dataBase64: png(800, 600), mimeType: 'image/png' });
ok('Dan uploads a proof photo, stored privately', proof.ok && Object.values(box.__drive.files).every((f) => f.sharing === null));
ok('Eve cannot use Dan\'s proof', !eve('actionDriverUpdateJob', { jobId, act: 'delivered', recipientName: 'Tia', proofId: proof.proofId }).ok);
r = dan('actionDriverUpdateJob', { jobId, act: 'delivered', recipientName: 'Tia', proofId: proof.proofId });
ok('delivered with proof and recipient -> job closed, location wiped', r.ok && job(a).Status === 'delivered' && job(a).LastLat === '' && job(a).Sharing === '');
ok('the driver\'s record does NOT complete the order', status(a) === 'Paid' && stateOf(a).FulfilmentState === 'delivered');
ok('the seller and buyer see the proof photo in the room', seller('actionGetTxRoom', { orderId: a }).events.some((e) => e.byLabel === 'Driver' && e.evidence.length === 1));
ok('the buyer can open the proof photo', buyer('actionGetTxEvidence', { evidenceId: proof.proofId }).ok);
r = buyer('actionTxConfirmReceipt', { orderId: a, choice: 'ok' });
ok('buyer confirms -> order completed', r.ok && status(a) === 'Fulfilled');
home = dan('actionGetDriverHome', {});
ok('Dan\'s history and earnings: 1 delivered, $5 fee, not yet marked paid; buyer phone no longer shown', home.earnings.delivered === 1 && home.earnings.fees === 5 && home.earnings.feesPaid === 0
  && home.history[0].buyerPhone === '', J(home.earnings));
ok('marking the driver paid needs a confirmation', !seller('actionTxMarkDriverPaid', { orderId: a }).ok);
ok('seller marks the driver paid', seller('actionTxMarkDriverPaid', { orderId: a, confirmPaid: true }).ok && dan('actionGetDriverHome', {}).earnings.feesPaid === 5);

/* ---- failure and cancel ---- */
const b = order(); ready(b);
seller('actionTxRequestDriver', { orderId: b, fee: 4, pickup: 'Front counter, Bong shop' });
const jb = job(b).JobId;
eve('actionDriverAcceptJob', { jobId: jb });
eve('actionDriverUpdateJob', { jobId: jb, act: 'picked_up' });
ok('a failure needs a reason and a note', !eve('actionDriverUpdateJob', { jobId: jb, act: 'failed', reason: 'no_one_home' }).ok);
r = eve('actionDriverUpdateJob', { jobId: jb, act: 'failed', reason: 'no_one_home', note: 'Knocked twice, phone off' });
ok('failed delivery recorded; seller and buyer told; goods returning', r.ok && job(b).Status === 'failed'
  && seller('actionGetTxRoom', { orderId: b }).events.some((e) => /Delivery failed - Nobody there/.test(e.body) && /bring the goods back/.test(e.body)));
ok('the order is not completed or cancelled by a failure', status(b) === 'Paid');
const list = box.actionAdminListDeliveries(A, { status: 'problems' });
ok('admin sees failed deliveries under problems', list.ok && list.jobs.some((j) => j.orderId === b && j.status === 'failed') && list.counts.failed === 1, J(list.counts));
ok('sellers cannot see the deliveries admin list', !box.actionAdminListDeliveries(S, {}).ok);
const c = order(); ready(c);
seller('actionTxRequestDriver', { orderId: c, fee: 3, pickup: 'Front counter, Bong shop' });
ok('the seller can cancel an open job (with a reason)', seller('actionTxCancelDriverJob', { orderId: c, reason: 'Sending it myself' }).ok && job(c).Status === 'cancelled');
ok('then send it the normal way', seller('actionTxDispatch', { orderId: c, dispatch: { date: today } }).ok);
const d = order(); ready(d);
seller('actionTxRequestDriver', { orderId: d, fee: 3, pickup: 'Front counter, Bong shop' });
dan('actionDriverAcceptJob', { jobId: job(d).JobId });
seller('actionTxCancel', { orderId: d, reason: 'Buyer changed their mind' });
ok('cancelling the order cancels a job the driver has not collected', job(d).Status === 'cancelled' && status(d) === 'Cancelled');
ok('a suspended driver can no longer act', box.actionAdminSetDriverStatus(A, { driverId: idOf('Dan'), status: 'suspended', reason: 'Late twice' }).ok
  && !dan('actionDriverSetAvailable', { available: true }).ok && dan('actionGetDriverHome', {}).driver.note === 'Late twice');
ok('every driver step is in the audit log', ['DRIVER_APPLIED', 'DRIVER_APPROVED', 'DELIVERY_REQUESTED', 'DELIVERY_ACCEPTED', 'DELIVERY_PICKED_UP', 'DELIVERY_DELIVERED', 'DELIVERY_FAILED', 'DELIVERY_FEE_PAID', 'DRIVER_SUSPENDED']
  .every((x) => box.__sheets.Audit_Log.objects().some((y) => y.Action === x)));
{ const keep = box.__props.DELIVERY_JOBS;
  ok('customer order list says drivers are open (dashboard shows "Drive with Mwakete")', box.actionListCustomerOrders({ token: 'c-b' }).driversOpen === true);
  box.__props.DELIVERY_JOBS = 'off';
  ok('...and closed straight away when switched off, even with the list cached', box.actionListCustomerOrders({ token: 'c-b' }).driversOpen === false);
  box.__props.DELIVERY_JOBS = keep; }
ok('checkSetup probes Deliveries.gs', box.actionCheckSetup().missingFiles.indexOf('Deliveries.gs') === -1);

let fails = 0;
console.log('\n--- drivers and deliveries ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
