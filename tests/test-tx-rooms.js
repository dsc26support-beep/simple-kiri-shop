/**
 * Order rooms (Transactions.gs, Oct 2026) on the REAL backend sources
 * (gas-harness): rollout flag, the transition rules, evidence policy, file
 * checks, payment verification, delivery and collection, receipt, disputes,
 * admin decisions and exceptions, permissions and tampered ids, retries,
 * notifications, configuration and retention - plus journeys A-D from the
 * brief, end to end through checkout.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);
const FUTURE = new Date(Date.now() + 86400000 * 30).toISOString();

const ownerCols = ['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'];
const box = makeBox({
  Owners: [ownerCols,
    ['own_s', 'bong', 'Bong Store', 's@x.test', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer'],
    ['own_o', 'other', 'Other Store', 'o@x.test', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer'],
    ['own_a', 'mwakete-admin', 'Admin', 'admin@x.test', 'active', 'South Tarawa', '', '', '', 'retailer'],
    ['own_a2', 'admin-two', 'Admin Two', 'admin2@x.test', 'active', 'South Tarawa', '', '', '', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-seller', 'own_s', '', FUTURE], ['tok-other', 'own_o', '', FUTURE],
    ['tok-admin', 'own_a', '', FUTURE], ['tok-admin2', 'own_a2', '', FUTURE], ['tok-expired', 'own_s', '', '2020-01-01T00:00:00Z']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'],
    ['cus_b', 'Tia', 'b@x.test', '73000001', 'yes', '', ''], ['cus_z', 'Zed', 'z@x.test', '73000002', 'yes', '', ''],
    ['cus_sb', 'Seller as buyer', 's@x.test', '73000003', 'yes', '', '']],
  CustomerSessions: [['Token', 'CustomerId', 'CreatedAt', 'ExpiresAt'], ['ctok-b', 'cus_b', '', FUTURE], ['ctok-z', 'cus_z', '', FUTURE], ['ctok-sb', 'cus_sb', '', FUTURE]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', 'active', 0, '', ''],
    ['p_phone', 'own_s', 'bong', 'Phone', 'Smartphone', 'electronics', 'product', 'active', 1, '', ''],
    ['p_oth', 'own_o', 'other', 'Soap', 'Bar', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 1000, 'active'], ['v_phone', 'p_phone', 'own_s', 'Black', 150, '', 50, 'active'],
    ['v_oth', 'p_oth', 'own_o', 'Bar', 2, '', '', 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
    'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
box.__props.ADMIN_EMAILS = 'admin@x.test,admin2@x.test';
box.__props.SITE_BASE_URL = 'https://mwakete.example';
const SELLER = box.__sheets.Owners.objects()[0];

const clearCache = (prefix) => Object.keys(box.__cache).forEach((k) => { if (!prefix || k.indexOf(prefix) === 0) delete box.__cache[k]; });
const fresh = () => clearCache();
const as = (side, token) => (fn, body) => { clearCache('ratelimit'); return box[fn](Object.assign({ side, token }, body || {})); };
const buyer = as('buyer', 'ctok-b'), stranger = as('buyer', 'ctok-z'), seller = as('seller', 'tok-seller'), otherSeller = as('seller', 'tok-other');
const admin = as('admin', 'tok-admin'), admin2 = as('admin', 'tok-admin2');
const room = (who, orderId) => { fresh(); return who('actionGetTxRoom', { orderId }); };
const order = (opts) => {
  fresh();
  return box.actionCreateOrder(Object.assign({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
    customerEmail: 'b@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck', paymentMethod: '' }, opts || {}));
};
const status = (id) => box.__sheets.Orders.objects().find((o) => o.OrderId === id).Status;
const stateOf = (id) => (box.__sheets.TxState ? box.__sheets.TxState.objects().find((s) => s.OrderId === id) : undefined);
const stock = (vid) => box.__sheets.Variants.objects().find((v) => v.VariantId === vid);
const audits = (action) => (box.__sheets.Audit_Log ? box.__sheets.Audit_Log.objects() : []).filter((a) => !action || a.Action === action);
const mails = () => box.__mail.map((m) => ({ to: m[0], subject: m[1], body: m[2] }));

/* ---- real file bytes ---- */
function png(w, h, pad) {
  const b = Buffer.alloc(33 + (pad || 2000));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  for (let i = 33; i < b.length; i++) b[i] = (i * 7 + w) & 0xff;
  return b;
}
function jpeg(w, h) {
  const b = Buffer.alloc(3000);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(b, 0);
  b.write('JFIF', 6);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff]).copy(b, 20);
  for (let i = 40; i < b.length; i++) b[i] = (i * 13 + h) & 0xff;
  return b;
}
let fileN = 0;
const photo = () => png(800 + (++fileN), 600);
const up = (who, orderId, category, bytes, extra) => who('actionUploadTxEvidence', Object.assign({ orderId, category, dataBase64: Buffer.from(bytes).toString('base64'),
  mimeType: bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'application/pdf', name: 'IMG_1.png' }, extra || {}));
const upId = (who, orderId, category, bytes) => { const r = up(who, orderId, category, bytes || photo()); if (!r.ok) { ok('upload helper: ' + orderId + ' ' + category, false, J(r)); return 'none'; } return r.evidence.id; };
const checklistAll = (id, extra) => seller('actionTxChecklist', Object.assign({ orderId: id, checklist: { lines: [{ index: 0, ok: true }, { index: 1, ok: true }] } }, extra || {}));

/* ==================== Rollout ==================== */
let o0 = order();
ok('rooms off (default): checkout unchanged, no room created', o0.ok && !box.__sheets.TxState);
let r = room(buyer, o0.orderId);
ok('rooms off: the room cannot be opened', !r.ok && /not switched on/.test(r.error), J(r));
ok('rooms off: the seller dropdown still works as before', box.actionUpdateOrderStatus(SELLER, { orderId: o0.orderId, status: 'Paid' }).ok && status(o0.orderId) === 'Paid');
ok('rooms off: order lists say no room', box.actionListOwnerOrders(SELLER, {}).orders.every((x) => x.room === null));

box.__props.TX_ROOMS = 'pilot'; box.__props.TX_PILOT_STORES = 'bong';
const oOther = box.actionCreateOrder({ storeSlug: 'other', items: [{ variantId: 'v_oth', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
  customerEmail: 'b@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck' });
ok('pilot: a store outside the pilot gets no room', oOther.ok && !stateOf(oOther.orderId));
r = room(buyer, o0.orderId);
ok('pilot: an older order gets a legacy room when first opened', r.ok && r.room.flow === 'legacy' && r.room.payment.state === 'verified', J(r.room && r.room.payment));
ok('legacy room: no payment or fulfilment steps offered to the seller', !room(seller, o0.orderId).room.actions.some((a) => ['verifyPayment', 'dispatch', 'checklist'].indexOf(a) !== -1));
ok('legacy room: seller still uses the dropdown', box.actionUpdateOrderStatus(SELLER, { orderId: o0.orderId, status: 'Fulfilled' }).ok);
r = seller('actionTxVerifyPayment', { orderId: o0.orderId, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25 });
ok('legacy room: payment actions are refused, nothing invented', !r.ok && /placed before order rooms/.test(r.error), J(r));

/* ==================== Journey A: delivery ==================== */
const A1 = order({ items: [{ variantId: 'v_rice', qty: 3 }, { variantId: 'v_phone', qty: 1 }] });
const a = A1.orderId;
ok('A: order placed with rooms on gets a v1 room and the payment prompt', A1.ok && stateOf(a).Flow === 'v1' && stateOf(a).PaymentState === 'pending');
r = room(buyer, a);
ok('A: buyer opens the linked room - order ref, items, quantities, status', r.ok && r.room.orderId === a && r.room.items.length === 2 && r.room.items[0].qty === 3
  && r.room.total === 215 && r.viewer === 'buyer', J(r.room));
ok('A: the buyer sees the payment prompt, not the seller-only one', r.events.some((e) => /hide sensitive banking information/.test(e.body)) && !r.events.some((e) => e.audience === 'seller'));
ok('A: buyer is not shown the seller-only payment flags or buyer contact block', r.room.paymentFlags === undefined && r.room.buyer === undefined);
ok('A: buyer next steps include sending payment and reporting a problem', r.room.actions.indexOf('submitPayment') !== -1 && r.room.actions.indexOf('openDispute') !== -1);
r = room(seller, a);
ok('A: seller sees the same room with the buyer\'s details and verify step', r.ok && r.room.buyer.name === 'Tia' && r.room.actions.indexOf('verifyPayment') !== -1);
ok('A: seller order list carries the room summary', box.actionListOwnerOrders(SELLER, {}).orders.find((x) => x.orderId === a).room.flow === 'v1');

r = buyer('actionTxSubmitPayment', { orderId: a, method: 'bank_transfer' });
ok('A: payment details need a reference or a receipt (essential)', !r.ok && r.requirement === 'payment.receipt', J(r));
const rcpt = upId(buyer, a, 'payment', png(1080, 2340));
r = buyer('actionTxSubmitPayment', { orderId: a, method: 'bank_transfer', reference: 'TRF-889', amount: 215, evidenceIds: [rcpt] });
ok('A: buyer sends payment details with a receipt', r.ok && stateOf(a).PaymentState === 'submitted', J(r));
ok('A: a screenshot does not make the order paid', status(a) === 'Pending Payment');
ok('A: the seller is emailed with a link, never the receipt', mails().some((m) => m.to === 's@x.test' && /order-room.html\?order=/.test(m.body) && !/base64|TRF-889/.test(m.body)), J(mails().slice(-1)));
r = buyer('actionTxVerifyPayment', { orderId: a, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-889', amountReceived: 215 });
ok('A: the buyer cannot verify their own payment', !r.ok && r.error === 'Not authorized' && status(a) === 'Pending Payment');
r = admin('actionTxVerifyPayment', { orderId: a, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-889', amountReceived: 215 });
ok('A: an admin cannot verify a seller\'s bank either', !r.ok && status(a) === 'Pending Payment');
r = seller('actionTxVerifyPayment', { orderId: a, result: 'verified', method: 'bank_transfer', reference: 'TRF-889', amountReceived: 215 });
ok('A: seller must say they checked their own account', !r.ok && r.requirement === 'payment.source');
r = seller('actionTxVerifyPayment', { orderId: a, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-889', amountReceived: 190 });
ok('A: an amount different from the total needs an explicit acceptance', !r.ok && r.requirement === 'payment.amount');
r = seller('actionTxVerifyPayment', { orderId: a, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-889', amountReceived: 215, requestId: 'verify-req-0001' });
ok('A: seller verifies payment after checking their account -> Paid', r.ok && status(a) === 'Paid' && stateOf(a).PaymentState === 'verified', J(r));
const vrec = box.__sheets.TxRecords.objects().find((x) => x.OrderId === a && x.Type === 'payment_verification');
ok('A: verification record holds verifier, time, method, reference, amount', vrec && vrec.ActorId === 'own_s' && /"reference":"TRF-889"/.test(vrec.DataJson) && /"checkedOwnAccount":true/.test(vrec.DataJson) && vrec.CreatedAt);
ok('A: the receipt photo is marked accepted', box.__sheets.TxEvidence.objects().find((e) => e.EvidenceId === rcpt).ReviewStatus === 'accepted');
const auditCount = audits('TX_PAYMENT_VERIFIED').length;
r = seller('actionTxVerifyPayment', { orderId: a, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-889', amountReceived: 215, requestId: 'verify-req-0001' });
ok('A: a retried verify (same requestId) replays, records nothing twice', r.ok && r.replayed && audits('TX_PAYMENT_VERIFIED').length === auditCount);

r = seller('actionTxDispatch', { orderId: a, dispatch: { date: new Date().toISOString().slice(0, 10) } });
ok('A: cannot send before checking the goods (essential)', !r.ok && r.requirement === 'checklist');
r = seller('actionTxChecklist', { orderId: a, checklist: { lines: [{ index: 0, ok: true }] } });
ok('A: every line must be ticked or a change described', !r.ok && r.requirement === 'checklist.lines');
r = checklistAll(a);
ok('A: electronics in the order -> a goods photo is required (conditional)', !r.ok && r.requirement === 'conditional.photo', J(r));
const goods = upId(seller, a, 'goods');
r = checklistAll(a, { evidenceIds: [goods], checklist: { lines: [{ index: 0, ok: true }, { index: 1, ok: true }], defects: 'Small scratch on the box' } });
ok('A: a declared defect needs a defect photo', !r.ok && r.requirement === 'defect.photo');
const defect = upId(seller, a, 'defect');
r = checklistAll(a, { evidenceIds: [goods, defect], checklist: { lines: [{ index: 0, ok: true }, { index: 1, ok: true }], defects: 'Small scratch on the box', accessories: 'Charger' } });
ok('A: checklist with goods + defect photos recorded', r.ok && stateOf(a).FulfilmentState === 'preparing', J(r));
r = buyer('actionTxChecklist', { orderId: a, checklist: { lines: [{ index: 0, ok: true }, { index: 1, ok: true }] } });
ok('A: the buyer cannot record the seller\'s checklist', !r.ok && r.error === 'Not authorized');
r = seller('actionTxDispatch', { orderId: a, dispatch: { date: '2099-01-01' } });
ok('A: a future dispatch date is refused', !r.ok && /future/.test(r.error));
const today = new Date().toISOString().slice(0, 10);
r = seller('actionTxDispatch', { orderId: a, dispatch: { date: today, provider: 'Island Freight' } });
ok('A: high-value order -> a dispatch photo is required', !r.ok && r.requirement === 'dispatch.photo', J(r));
const packed = upId(seller, a, 'dispatch');
const stockBefore = stock('v_phone');
r = seller('actionTxDispatch', { orderId: a, dispatch: { date: today, provider: 'Island Freight', tracking: '' }, evidenceIds: [packed] });
ok('A: dispatch recorded without a tracking number (none for this carrier)', r.ok && stateOf(a).FulfilmentState === 'dispatched', J(r));
ok('A: stock leaves the shelf at dispatch (reserved -> sold)', Number(stock('v_phone').StockQty) === Number(stockBefore.StockQty) - 1 && Number(stock('v_phone').ReservedQty) === Number(stockBefore.ReservedQty) - 1,
  J([stockBefore.StockQty, stockBefore.ReservedQty, stock('v_phone').StockQty, stock('v_phone').ReservedQty]));
ok('A: dispatch does not complete the order', status(a) === 'Paid');
r = room(buyer, a);
ok('A: buyer is asked to confirm receipt, and the dispatch is labelled as the seller\'s record', r.room.actions.indexOf('confirmReceipt') !== -1
  && r.events.some((e) => /does not by itself confirm delivery/.test(e.body)) && r.events.some((e) => /Have you received your order/.test(e.body)));
r = box.actionUpdateOrderStatus(SELLER, { orderId: a, status: 'Fulfilled' });
ok('A: the Orders dropdown cannot jump a room order to Fulfilled', !r.ok && /order room/.test(r.error) && status(a) === 'Paid');
r = buyer('actionTxConfirmReceipt', { orderId: a, choice: 'ok', requestId: 'receipt-req-01' });
ok('A: buyer confirms receipt -> order completed (Fulfilled)', r.ok && r.completed === true && status(a) === 'Fulfilled', J(r));
r = buyer('actionTxConfirmReceipt', { orderId: a, choice: 'not_received', note: 'changed my mind about this one' });
ok('A: the receipt answer cannot be overwritten', !r.ok && /already answered/.test(r.error));
ok('A: stock was not moved twice at completion', Number(stock('v_phone').StockQty) === Number(stockBefore.StockQty) - 1);
ok('A: audit trail has each material step', ['TX_PAYMENT_SUBMITTED', 'TX_PAYMENT_VERIFIED', 'TX_CHECKLIST_RECORDED', 'TX_DISPATCHED', 'TX_RECEIPT_CONFIRMED', 'TX_ORDER_COMPLETED']
  .every((x) => audits(x).some((y) => y.EntityId === a)));
r = buyer('actionTxOpenDispute', { orderId: a, category: 'condition', description: 'The phone screen does not turn on at all.', evidenceIds: [] });
ok('A: a problem can still be reported after confirming receipt - but needs a photo', !r.ok && r.requirement === 'dispute.photo');

/* ==================== Journey B: collection ==================== */
const B1 = order({ deliveryMethod: 'pickPay' });
const b = B1.orderId;
ok('B: collection order placed', B1.ok && stateOf(b).Flow === 'v1');
r = seller('actionTxDispatch', { orderId: b, dispatch: { date: today } });
ok('B: a collection order has no dispatch', !r.ok);
r = checklistAll(b, { checklist: { lines: [{ index: 0, ok: true }] } });
ok('B: low-value food order: checklist without a photo is allowed (photo only recommended)', r.ok && r.recommendedMissing.length === 1, J(r));
r = seller('actionTxMarkReady', { orderId: b, collection: {} });
ok('B: ready-for-collection needs instructions', !r.ok);
r = seller('actionTxMarkReady', { orderId: b, collection: { instructions: 'Collect at the Bairiki shop counter', when: 'Friday after 10am' } });
ok('B: seller marks ready for collection, buyer gets the collection prompt', r.ok && stateOf(b).FulfilmentState === 'ready_collection'
  && room(buyer, b).events.some((e) => /ready for collection/.test(e.body)), J(r));
ok('B: buyer and seller arrange it in the room', buyer('actionSendTxMessage', { orderId: b, text: 'I will come Friday at 11' }).ok
  && seller('actionSendTxMessage', { orderId: b, text: 'See you then' }).ok);
r = seller('actionTxHandover', { orderId: b, handover: { date: today } });
ok('B: handover without confirmed payment needs cash received or an explicit choice', !r.ok && r.requirement === 'payment.verified');
r = seller('actionTxHandover', { orderId: b, handover: { date: today, cashReceived: true, amount: 20, notes: 'Collected by Tia' } });
ok('B: handover with cash in hand records verification and handover', r.ok && stateOf(b).FulfilmentState === 'handed_over' && stateOf(b).PaymentState === 'verified' && status(b) === 'Paid', J(r));
ok('B: cash verification is recorded as the seller\'s, via handover', box.__sheets.TxRecords.objects().some((x) => x.OrderId === b && x.Type === 'payment_verification' && /"via":"handover"/.test(x.DataJson)));
r = buyer('actionTxConfirmReceipt', { orderId: b, choice: 'ok' });
ok('B: buyer confirms collection -> completed', r.ok && status(b) === 'Fulfilled');

const B2 = order({ deliveryMethod: 'pickPay' }).orderId;
checklistAll(B2, { checklist: { lines: [{ index: 0, ok: true }] } });
seller('actionTxMarkReady', { orderId: B2, collection: { instructions: 'At the shop' } });
r = buyer('actionTxConfirmReceipt', { orderId: B2, choice: 'ok' });
ok('B: buyer can acknowledge a collection the seller has not recorded yet', r.ok && stateOf(B2).FulfilmentState === 'handed_over' && stateOf(B2).ReceiptState === 'confirmed');
ok('B: ...but without payment confirmation the order is not completed', status(B2) === 'Pending Payment' && /waiting for payment/i.test(room(buyer, B2).room.stage), room(buyer, B2).room.stage);
seller('actionTxVerifyPayment', { orderId: B2, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 20 });
ok('B: once the seller confirms the cash, the order completes', status(B2) === 'Fulfilled');
ok('B: confirming payment after the goods left does not put stock back', box.__sheets.StockMovements.objects().filter((m) => m.ReferenceId === B2 && m.MovementType === 'ORDER_RESERVED').length === 1);

/* ==================== Journey C: disputed delivery ==================== */
const c = order().orderId;
buyer('actionTxSubmitPayment', { orderId: c, method: 'bank_transfer', reference: 'TRF-C1', amount: 25 });
seller('actionTxVerifyPayment', { orderId: c, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-C1', amountReceived: 25 });
checklistAll(c, { checklist: { lines: [{ index: 0, ok: true }] } });
r = seller('actionTxDispatch', { orderId: c, dispatch: { date: today, method: 'Truck' } });
ok('C: low-value order dispatched without a photo (recommended only)', r.ok, J(r));
r = buyer('actionTxConfirmReceipt', { orderId: c, choice: 'problem', category: 'damaged', note: 'The bag was torn and rice spilled out.' });
ok('C: damage report needs a photo', !r.ok && r.requirement === 'dispute.photo');
const dmg = upId(buyer, c, 'delivery');
r = buyer('actionTxConfirmReceipt', { orderId: c, choice: 'problem', category: 'damaged', note: 'The bag was torn and rice spilled out.', evidenceIds: [dmg] });
ok('C: buyer reports damage instead of confirming -> dispute opened', r.ok && r.disputeId && stateOf(c).OpenDisputeId === r.disputeId && stateOf(c).ReceiptState === 'problem', J(r));
const dId = r.disputeId;
ok('C: the order is not completed and is on hold', status(c) === 'Paid' && stateOf(c).Hold === 'yes');
ok('C: seller and admins are told (no evidence in email)', mails().some((m) => m.to === 's@x.test' && /problem/i.test(m.subject)) && mails().some((m) => /admin@x.test/.test(m.to)));
r = seller('actionTxCancel', { orderId: c, reason: 'Buyer is unhappy' });
ok('C: seller cannot cancel while a problem is open', !r.ok);
r = box.actionUpdateOrderStatus(SELLER, { orderId: c, status: 'Cancelled' });
ok('C: ...nor through the Orders dropdown', !r.ok && status(c) === 'Paid');
r = buyer('actionTxOpenDispute', { orderId: c, category: 'other', description: 'A second problem report for the same order.' });
ok('C: only one open problem at a time', !r.ok && /already open/.test(r.error));
const sellerPhoto = upId(seller, c, 'dispute');
r = seller('actionTxRespondDispute', { orderId: c, text: 'It was packed in a double bag, see photo.', evidenceIds: [sellerPhoto] });
ok('C: seller responds with evidence -> under review', r.ok && r.status === 'under_review');
r = buyer('actionTxRespondDispute', { orderId: c, text: 'Here is another photo', evidenceIds: [upId(buyer, c, 'dispute')] });
ok('C: buyer adds more evidence', r.ok);
r = otherSeller('actionTxRespondDispute', { orderId: c, text: 'I am another seller' });
ok('C: an unrelated seller cannot take part', !r.ok && r.error === 'Order not found');
let ar = room(admin, c);
ok('C: admin sees the consolidated view: dispute, history, evidence, both sides', ar.ok && ar.room.dispute.id === dId && ar.room.buyer && ar.events.some((e) => e.evidence.length)
  && ar.room.actions.indexOf('adminDispute') !== -1, J(ar.room && ar.room.actions));
r = admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'resolve', outcome: 'buyer', note: 'short', orderEffect: 'none' });
ok('C: a decision needs reasons', !r.ok);
r = admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'request_info', party: 'seller', note: 'Please send the carrier receipt.', disputeVersion: 1 });
ok('C: stale dispute version is refused', !r.ok && r.stale);
const dv = room(admin, c).room.dispute.version;
r = admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'request_info', party: 'seller', note: 'Please send the carrier receipt.', disputeVersion: dv });
ok('C: admin asks the seller for more information', r.ok && r.status === 'awaiting_seller');
r = seller('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'resolve', outcome: 'seller', note: 'I decide in my own favour today.', orderEffect: 'complete' });
ok('C: the seller cannot decide their own dispute', !r.ok);
r = as('admin', 'tok-seller')('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'resolve', outcome: 'seller', note: 'I decide in my own favour today.' });
ok('C: a seller calling as admin is refused and logged', !r.ok && r.error === 'Not authorized' && audits('UNAUTHORIZED_ATTEMPT').length > 0);
r = admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'resolve', outcome: 'agreed', orderEffect: 'cancel',
  note: 'Both agreed the seller replaces nothing and refunds; order cancelled.' });
ok('C: admin resolves with reasons; order cancelled; refund now due (not invented as done)', r.ok && status(c) === 'Cancelled' && stateOf(c).RefundState === 'due' && !stateOf(c).OpenDisputeId, J(r));
ok('C: the goods had left - stock is not put back automatically', box.__sheets.StockMovements.objects().filter((m) => m.ReferenceId === c && m.MovementType === 'RETURN').length === 0);
ok('C: both parties are notified of the decision', mails().filter((m) => /decided/.test(m.subject)).length >= 2);
const dRow = box.__sheets.TxDisputes.objects().find((x) => x.DisputeId === dId);
ok('C: decision, reviewer, time and history are kept', dRow.Outcome === 'agreed' && dRow.DecidedBy === 'own_a' && dRow.DecidedAt && JSON.parse(dRow.HistoryJson).length >= 4);
ok('C: (cancelled order) the receipt answer stays as it was', stateOf(c).ReceiptState === 'problem');
ok('C: no message or file was deleted', box.__sheets.TxEvidence.objects().filter((e) => e.OrderId === c && !e.DeletedAt).length === 3);
r = buyer('actionTxConfirmRefund', { orderId: c });
ok('C: buyer cannot confirm a refund the seller has not recorded', !r.ok);
r = seller('actionTxRecordRefund', { orderId: c, reference: 'RF-1' });
ok('C: seller must confirm the refund was actually sent', !r.ok);
r = seller('actionTxRecordRefund', { orderId: c, reference: 'RF-1', confirmSent: true });
ok('C: seller records the refund they sent; buyer confirms it arrived', r.ok && buyer('actionTxConfirmRefund', { orderId: c }).ok && stateOf(c).RefundState === 'received');
r = admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'reopen', note: 'New evidence came in from the carrier.' });
ok('C: admin can reopen within the reopen window', r.ok && stateOf(c).OpenDisputeId === dId);
admin('actionAdminTxDispute', { orderId: c, disputeId: dId, act: 'resolve', outcome: 'no_fault', orderEffect: 'none', note: 'Carrier confirmed the damage happened in transit.' });

const c2 = order().orderId;
buyer('actionTxSubmitPayment', { orderId: c2, method: 'bank_transfer', reference: 'TRF-C2' });
seller('actionTxVerifyPayment', { orderId: c2, result: 'verified', checkedSource: true, method: 'bank_transfer', reference: 'TRF-C2', amountReceived: 25 });
checklistAll(c2, { checklist: { lines: [{ index: 0, ok: true }] } });
seller('actionTxDispatch', { orderId: c2, dispatch: { date: today } });
r = buyer('actionTxConfirmReceipt', { orderId: c2, choice: 'not_received', note: 'Nothing has arrived after a week.' });
const d2 = r.disputeId;
r = admin('actionAdminTxDispute', { orderId: c2, disputeId: d2, act: 'resolve', outcome: 'agreed', orderEffect: 'none', note: 'Parcel found at the depot; buyer will collect it today.' });
ok('C: resolved with no change to the order -> the buyer can confirm receipt again', r.ok && stateOf(c2).ReceiptState === '' && room(buyer, c2).room.actions.indexOf('confirmReceipt') !== -1);
ok('C: ...the earlier "not received" answer stays in the records', box.__sheets.TxRecords.objects().some((x) => x.OrderId === c2 && x.Type === 'receipt' && x.Result === 'not_received')
  && box.__sheets.TxRecords.objects().some((x) => x.OrderId === c2 && x.Type === 'receipt_reopened'));
ok('C: ...and confirming now completes the order', buyer('actionTxConfirmReceipt', { orderId: c2, choice: 'ok' }).completed === true && status(c2) === 'Fulfilled');

/* ==================== Journey D: security ==================== */
const d = order().orderId;
r = stranger('actionGetTxRoom', { orderId: d });
ok('D: an unrelated signed-in customer cannot open the room', !r.ok && r.error === 'Order not found');
ok('D: ...and the attempt is logged', audits('TX_ACCESS_DENIED').some((x) => x.EntityId === d && x.ActorId === 'cus_z'));
ok('D: an unrelated seller cannot open it', otherSeller('actionGetTxRoom', { orderId: d }).error === 'Order not found');
ok('D: no session -> sign in required', box.actionGetTxRoom({ orderId: d, side: 'buyer' }).authRequired === true && box.actionGetTxRoom({ orderId: d }).authRequired === true);
ok('D: expired seller session is refused', as('seller', 'tok-expired')('actionGetTxRoom', { orderId: d }).ok === false);
ok('D: a buyer token used as a seller token is refused', as('seller', 'ctok-b')('actionGetTxRoom', { orderId: d }).ok === false);
ok('D: the seller signed in as a customer (different email) is not the buyer', as('buyer', 'ctok-sb')('actionGetTxRoom', { orderId: d }).error === 'Order not found');
r = otherSeller('actionTxVerifyPayment', { orderId: d, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25 });
ok('D: another seller cannot verify payment', !r.ok && status(d) === 'Pending Payment');
r = otherSeller('actionAdminTxException', { orderId: d, key: 'dispatch.photo', reason: 'Trying to waive a requirement' });
ok('D: a seller cannot approve an exception', !r.ok);
r = stranger('actionSendTxMessage', { orderId: d, text: 'hello' });
ok('D: stranger cannot post a message', !r.ok && box.__sheets.TxEvents.objects().every((e) => e.Body !== 'hello'));
const theirFile = upId(buyer, d, 'payment', jpeg(1200, 1600));
r = stranger('actionGetTxEvidence', { evidenceId: theirFile });
ok('D: another customer cannot download a file by its id', !r.ok && r.error === 'File not found' && audits('TX_EVIDENCE_ACCESS_DENIED').length > 0);
ok('D: another seller cannot either', otherSeller('actionGetTxEvidence', { evidenceId: theirFile }).ok === false);
r = seller('actionGetTxEvidence', { evidenceId: theirFile, variant: 'full' });
ok('D: the order\'s seller can open it - bytes come back intact', r.ok && Buffer.from(r.dataBase64, 'base64').equals(jpeg(1200, 1600)) && r.mimeType === 'image/jpeg');
ok('D: full downloads are logged', audits('TX_EVIDENCE_OPENED').some((x) => x.EntityId === theirFile && x.ActorId === 'own_s'));
ok('D: files are stored privately - never shared', Object.values(box.__drive.files).every((f) => f.sharing === null));
const otherOrder = order().orderId;
r = buyer('actionTxSubmitPayment', { orderId: otherOrder, method: 'bank_transfer', reference: 'X', evidenceIds: [theirFile] });
ok('D: a file from another order cannot be attached to this one', !r.ok && /does not belong/.test(r.error));
r = seller('actionTxChecklist', { orderId: d, checklist: { lines: [{ index: 0, ok: true }] }, evidenceIds: [theirFile] });
ok('D: the seller cannot claim the buyer\'s file as their own evidence', !r.ok && /does not belong/.test(r.error));
r = box.actionTxVerifyPayment({ side: 'seller', token: 'tok-seller', orderId: d, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25, status: 'Paid', ownerId: 'own_o' });
ok('D: extra fields (ownerId, status) are ignored - identity comes from the session', r.ok && status(d) === 'Paid' && box.__sheets.TxRecords.objects().some((x) => x.OrderId === d && x.ActorId === 'own_s' && x.Type === 'payment_verification'));
r = buyer('actionGetTxRoom', { orderId: d + "' OR 1=1" });
ok('D: a tampered order id finds nothing', !r.ok && r.error === 'Order not found');
r = admin2('actionGetTxRoom', { orderId: d });
ok('D: an admin can open any room (and the view is logged)', r.ok && audits('TX_ROOM_VIEWED_BY_ADMIN').some((x) => x.EntityId === d));
ok('D: no ordinary action deletes the audit log - only appends', typeof box.actionDeleteAuditLog === 'undefined' && !Object.keys(box).some((k) => /^action.*(Delete|Remove).*Audit/i.test(k)));

/* ==================== Files ==================== */
const f = order().orderId;
const bad = (bytes, mime, re, name) => { const x = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: Buffer.from(bytes).toString('base64'), mimeType: mime, name: 'x' }); ok(name, !x.ok && re.test(x.error), J(x)); };
bad(Buffer.from('MZ' + 'x'.repeat(200)), 'image/png', /Only photos/, 'files: an .exe renamed as a photo is refused (content checked)');
bad(Buffer.from('<html><script>alert(1)</script>' + 'x'.repeat(100)), 'image/jpeg', /Only photos/, 'files: HTML is refused');
bad(png(100, 100), 'image/jpeg', /not what its name says/, 'files: a PNG claiming to be a JPEG is refused');
bad(png(20000, 100), 'image/png', /too large/, 'files: absurd image dimensions are refused');
bad(png(10, 10), 'image/png', /too small/, 'files: a tiny image is refused');
bad(Buffer.concat([Buffer.from('%PDF-1.4\n/OpenAction << /S /JavaScript /JS (app.alert(1)) >>\n'), Buffer.alloc(200)]), 'application/pdf', /active content/, 'files: a PDF with JavaScript is refused');
bad(Buffer.alloc(6 * 1024 * 1024, 1), 'image/png', /too large/, 'files: over the size limit is refused');
r = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: 'not base64!!', mimeType: 'image/png' });
ok('files: a malformed payload is refused', !r.ok);
r = buyer('actionUploadTxEvidence', { orderId: f, category: '../../etc', dataBase64: Buffer.from(photo()).toString('base64'), mimeType: 'image/png' });
ok('files: an unknown category is refused', !r.ok);
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'), Buffer.alloc(300, 32)]);
r = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: pdf.toString('base64'), mimeType: 'application/pdf', name: '../../receipt<script>.pdf' });
ok('files: a plain PDF receipt is accepted with a safe display name', r.ok && r.evidence.name === 'receiptscript.pdf' && r.evidence.mimeType === 'application/pdf', J(r));
const fileRow = box.__sheets.TxEvidence.objects().find((e) => e.EvidenceId === r.evidence.id);
ok('files: stored under a server-made name, with size and a SHA-256 hash', box.__drive.files[fileRow.FileId].blob.getName() === fileRow.EvidenceId + '.pdf' && /^[0-9a-f]{64}$/.test(fileRow.Sha256) && Number(fileRow.SizeBytes) === pdf.length);
const same = Buffer.from(photo());
const u1 = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: same.toString('base64'), mimeType: 'image/png', requestId: 'upload-req-001' });
const u2 = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: same.toString('base64'), mimeType: 'image/png', requestId: 'upload-req-001' });
const u3 = buyer('actionUploadTxEvidence', { orderId: f, category: 'payment', dataBase64: same.toString('base64'), mimeType: 'image/png', requestId: 'upload-req-002' });
ok('files: a retried upload returns the same record, no duplicate', u1.ok && u2.replayed && u3.duplicate && u1.evidence.id === u3.evidence.id
  && box.__sheets.TxEvidence.objects().filter((e) => e.Sha256 === fileRow.Sha256 || e.EvidenceId === u1.evidence.id).length === 2, J([u1, u2, u3]));
ok('files: a failed upload leaves no record', box.__sheets.TxEvidence.objects().filter((e) => e.OrderId === f).length === 2);
const thumbUp = buyer('actionUploadTxEvidence', { orderId: f, category: 'goods', dataBase64: Buffer.from(png(3000, 4000)).toString('base64'), mimeType: 'image/png',
  thumbBase64: Buffer.from(jpeg(240, 320)).toString('base64') });
ok('files: a thumbnail is kept beside the original', thumbUp.ok && thumbUp.evidence.hasThumb);
r = buyer('actionGetTxEvidence', { evidenceId: thumbUp.evidence.id, variant: 'thumb' });
ok('files: the thumbnail is served for previews', r.ok && Buffer.from(r.dataBase64, 'base64').equals(jpeg(240, 320)));
box.__props.TX_ROOMS = 'on';
for (let i = 0; i < 25; i++) box.actionUploadTxEvidence({ side: 'buyer', token: 'ctok-b', orderId: f, category: 'other', dataBase64: Buffer.from(png(900 + i, 700)).toString('base64'), mimeType: 'image/png' });
r = box.actionUploadTxEvidence({ side: 'buyer', token: 'ctok-b', orderId: f, category: 'other', dataBase64: Buffer.from(png(999, 777)).toString('base64'), mimeType: 'image/png' });
ok('files: too many uploads in a short time are slowed down', !r.ok && r.rateLimited);

r = box.actionUploadTxEvidence({ side: 'buyer', orderId: f, category: 'payment', dataBase64: 'x'.repeat(100), mimeType: 'image/png' });
ok('files: without a session, the upload is refused before the file is read', !r.ok && r.authRequired === true);
const g1 = order().orderId, g2 = order().orderId;
r = buyer('actionSendTxMessage', { orderId: g1, text: 'first order', requestId: 'shared-req-0001' });
const r2 = buyer('actionSendTxMessage', { orderId: g2, text: 'second order', requestId: 'shared-req-0001' });
ok('retries: the same requestId on another order is a new request, not a replay', r.ok && r2.ok && !r2.replayed
  && box.__sheets.TxEvents.objects().some((e) => e.OrderId === g2 && e.Body === 'second order'));

/* ==================== Payment flags ==================== */
const p1 = order().orderId, p2 = order().orderId;
const shot = png(1080, 2000);
buyer('actionTxSubmitPayment', { orderId: p1, method: 'bank_transfer', reference: 'SAME-REF', evidenceIds: [upId(buyer, p1, 'payment', shot)] });
r = buyer('actionTxSubmitPayment', { orderId: p2, method: 'bank_transfer', reference: 'same-ref', amount: 3, evidenceIds: [upId(buyer, p2, 'payment', shot)] });
ok('payment: reused receipt, reused reference and a wrong amount are flagged', r.ok && r.flags === 3, J(r));
let sv = room(seller, p2);
ok('payment: flags are shown to the seller as things to check', sv.room.paymentFlags.join() === 'amount_differs,receipt_used_on_other_order,reference_used_on_other_order'
  && sv.events.some((e) => /check carefully/.test(e.body)));
ok('payment: ...and never to the buyer', room(buyer, p2).room.paymentFlags === undefined && !room(buyer, p2).events.some((e) => /check carefully/.test(e.body)));
r = seller('actionTxVerifyPayment', { orderId: p2, result: 'rejected', reason: 'No' });
ok('payment: declining needs a reason the buyer can act on', !r.ok);
r = seller('actionTxVerifyPayment', { orderId: p2, result: 'rejected', reason: 'Nothing has arrived in my account yet.' });
ok('payment: seller declines with a reason; buyer can send again', r.ok && stateOf(p2).PaymentState === 'rejected' && room(buyer, p2).room.actions.indexOf('submitPayment') !== -1);

/* ==================== Cancel, exceptions, admin tools ==================== */
const k = order().orderId;
r = seller('actionTxCancel', { orderId: k, reason: 'x' });
ok('cancel: needs a reason', !r.ok);
const reservedBefore = Number(stock('v_rice').ReservedQty);
r = seller('actionTxCancel', { orderId: k, reason: 'Out of stock after all' });
ok('cancel: seller cancels before sending, reservation released', r.ok && status(k) === 'Cancelled' && Number(stock('v_rice').ReservedQty) === reservedBefore - 1 && !r.refundDue);
const E1 = order({ items: [{ variantId: 'v_phone', qty: 2 }] }); ok('exception order placed', E1.ok, J(E1)); const e1 = E1.orderId;
seller('actionTxVerifyPayment', { orderId: e1, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 305 });
r = checklistAll(e1, { checklist: { lines: [{ index: 0, ok: true }] } });
ok('exception: blocked without the required goods photo', !r.ok && r.requirement === 'conditional.photo');
r = admin('actionAdminTxException', { orderId: e1, key: 'payment.verified', reason: 'Trying to skip payment verification here' });
ok('exception: payment verification can never be waived', !r.ok && /cannot be waived/.test(r.error));
r = admin('actionAdminTxException', { orderId: e1, key: 'conditional.photo', reason: 'short' });
ok('exception: needs a proper reason', !r.ok);
r = admin('actionAdminTxException', { orderId: e1, key: 'conditional.photo', reason: 'Seller camera broken; buyer agreed in the room to proceed.' });
ok('exception: admin waives exactly one requirement, audited', r.ok && audits('TX_EXCEPTION_GRANTED').some((x) => x.EntityId === e1));
r = checklistAll(e1, { checklist: { lines: [{ index: 0, ok: true }] } });
ok('exception: the waived step now goes through', r.ok, J(r));
r = otherSeller('actionTxDispatch', { orderId: e1, dispatch: { date: today } });
ok('exception: it does not let anyone else act on the order', !r.ok && r.error === 'Order not found');
r = seller('actionTxDispatch', { orderId: e1, dispatch: { date: today } });
ok('exception: ...nor waive a different requirement (dispatch photo still needed)', !r.ok && r.requirement === 'dispatch.photo');
r = admin('actionAdminTxComplete', { orderId: e1, reason: 'Buyer unreachable for two weeks after delivery was shown.' });
ok('admin complete: refused before the goods are sent', !r.ok);
seller('actionTxDispatch', { orderId: e1, dispatch: { date: today }, evidenceIds: [upId(seller, e1, 'dispatch')] });
r = admin('actionAdminTxComplete', { orderId: e1, reason: 'short' });
ok('admin complete: needs reasons', !r.ok);
r = admin('actionAdminTxComplete', { orderId: e1, reason: 'Buyer unreachable for two weeks after delivery was shown.' });
ok('admin complete: documented exception completes the order', r.ok && status(e1) === 'Fulfilled' && audits('TX_ADMIN_COMPLETED').length === 1);
const sbOrder = box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 1 }], customerName: 'Admin', customerPhone: '73000009',
  customerEmail: 'admin@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck' }).orderId;
fresh();
r = admin('actionAdminTxComplete', { orderId: sbOrder, reason: 'I bought this and want it completed now.' });
ok('admin who is the buyer cannot decide on their own order', !r.ok && /party/.test(r.error));
ok('admin who is a party gets no decision actions in the room', room(admin, sbOrder).room.actions.indexOf('adminComplete') === -1);
r = admin('actionAdminTxRedactEvidence', { orderId: d, evidenceId: theirFile, reason: 'Shows the full account number' });
ok('redact: the file is removed, the record stays', r.ok && box.__drive.files[box.__sheets.TxEvidence.objects().find((e) => e.EvidenceId === theirFile).FileId].trashed
  && !seller('actionGetTxEvidence', { evidenceId: theirFile }).ok && box.__sheets.TxEvidence.objects().find((e) => e.EvidenceId === theirFile).Sha256);
r = admin('actionAdminTxNote', { orderId: d, text: 'Checked: looks fine' });
ok('admin notes are visible only to admins', r.ok && !room(seller, d).events.some((e) => /Checked: looks fine/.test(e.body)) && room(admin, d).events.some((e) => /Checked: looks fine/.test(e.body)));

/* ==================== Messages, stale data, read marks ==================== */
const m = order().orderId;
r = buyer('actionSendTxMessage', { orderId: m, text: '=HYPERLINK("http://evil") <img src=x onerror=alert(1)>' });
ok('messages: stored as text (escaped by the page) and safe in the sheet', r.ok && box.__sheets.TxEvents.objects().find((e) => e.EventId === r.eventId).Body.charAt(0) === "'");
ok('messages: empty text refused', !buyer('actionSendTxMessage', { orderId: m, text: '   ' }).ok);
const v = room(seller, m).room.version;
buyer('actionTxSubmitPayment', { orderId: m, method: 'cash', note: 'Will pay at the shop', reference: 'cash' });
r = seller('actionTxVerifyPayment', { orderId: m, version: v, result: 'verified', checkedSource: true, method: 'cash', amountReceived: 25 });
ok('stale: acting on an out-of-date view is refused', !r.ok && r.stale);
ok('unread: the seller list shows new activity, cleared when opened', box.actionListOwnerOrders(SELLER, {}).orders.find((x) => x.orderId === m).room.unread > 0
  && (room(seller, m), box.actionListOwnerOrders(SELLER, {}).orders.find((x) => x.orderId === m).room.unread === 0));
let page = room(buyer, m);
const lastSeq = page.room.lastSeq;
seller('actionSendTxMessage', { orderId: m, text: 'Thanks' });
r = buyer('actionGetTxRoom', { orderId: m, sinceSeq: lastSeq });
ok('paging: polling with sinceSeq returns only the new entry', r.ok && r.events.length === 1 && r.events[0].body === 'Thanks' && r.events[0].byLabel === 'Seller');
for (let i = 0; i < 50; i++) seller('actionSendTxMessage', { orderId: m, text: 'msg ' + i });
page = room(buyer, m);
ok('paging: first load is capped, older history is paged', page.events.length === 40 && page.hasMoreBefore);
r = buyer('actionGetTxRoom', { orderId: m, beforeSeq: page.events[0].seq, limit: 40 });
ok('paging: beforeSeq loads older entries', r.ok && r.events.length > 0 && r.events[r.events.length - 1].seq < page.events[0].seq);
const cur = room(buyer, m).room;
r = buyer('actionGetTxRoom', { orderId: m, sinceSeq: cur.lastSeq, version: cur.version });
ok('polling: nothing new -> a tiny "unchanged" answer', r.ok && r.unchanged === true && !r.room && JSON.stringify(r).length < 80, J(r));
let before = box.__mail.length;
for (let i = 0; i < 3; i++) buyer('actionSendTxMessage', { orderId: m, text: 'again ' + i });
ok('notify: a burst of messages sends one email, not one each', box.__mail.length - before === 1);

/* ==================== Config ==================== */
r = box.actionAdminSaveTxConfig(SELLER, { values: { 'checklist.photo': 'off' } });
ok('config: sellers cannot change settings', !r.ok);
r = box.actionAdminSaveTxConfig(box.__sheets.Owners.objects()[2], { values: { 'limits.maxFileMB': 500 } });
ok('config: out-of-range values refused', !r.ok);
r = box.actionAdminSaveTxConfig(box.__sheets.Owners.objects()[2], { values: { 'exceptions.allowed': 'payment.verified' } });
ok('config: payment verification cannot be made waivable', !r.ok);
r = box.actionAdminSaveTxConfig(box.__sheets.Owners.objects()[2], { values: { 'prompt.payment': 'Send <b>money</b>' } });
ok('config: markup in prompts refused', !r.ok);
r = box.actionAdminSaveTxConfig(box.__sheets.Owners.objects()[2], { values: { 'checklist.photo': 'required', 'prompt.payment': 'Please send your receipt here. Hide account numbers.' } });
ok('config: admin saves settings, each change audited with old and new values', r.ok && audits('TX_CONFIG_CHANGED').filter((x) => x.EntityId === 'checklist.photo' && /recommended/.test(x.PreviousStateSummary)).length === 1);
const n1 = order().orderId;
ok('config: the new prompt is used for new orders', room(buyer, n1).events.some((e) => e.body === 'Please send your receipt here. Hide account numbers.'));
r = checklistAll(n1, { checklist: { lines: [{ index: 0, ok: true }] } });
ok('config: goods photo now required for every order', !r.ok && r.requirement === 'checklist.photo');
const cfgView = box.actionAdminGetTxConfig(box.__sheets.Owners.objects()[2]);
ok('config: admin can read every setting with its default', cfgView.ok && cfgView.settings.length === Object.keys(box.TX_CONFIG_SPEC).length && cfgView.mode === 'on');

/* ==================== Admin list, retention ==================== */
const list = box.actionAdminListTxDisputes(box.__sheets.Owners.objects()[2], { status: 'all' });
ok('admin list: disputes with order and store', list.ok && list.disputes.some((x) => x.orderId === c && x.storeName === 'Bong Store'));
ok('admin list: sellers cannot list disputes', !box.actionAdminListTxDisputes(SELLER, {}).ok);
const day = 86400000;
const st = (o) => ({ Hold: '', UpdatedAt: new Date(Date.now() - o * day).toISOString(), RefundState: '' });
const cfg = box.txConfig();
ok('retention: completed order past the period -> files may go', box.txRetentionEligible({ Status: 'Fulfilled' }, st(400), [], cfg, Date.now()));
ok('retention: within the period -> kept', !box.txRetentionEligible({ Status: 'Fulfilled' }, st(10), [], cfg, Date.now()));
ok('retention: an open order is never swept', !box.txRetentionEligible({ Status: 'Paid' }, st(900), [], cfg, Date.now()));
ok('retention: an open problem keeps everything', !box.txRetentionEligible({ Status: 'Fulfilled' }, st(900), [{ Status: 'under_review' }], cfg, Date.now()));
ok('retention: a hold keeps everything', !box.txRetentionEligible({ Status: 'Fulfilled' }, Object.assign(st(900), { Hold: 'yes' }), [], cfg, Date.now()));
ok('retention: disputed orders are kept longer', !box.txRetentionEligible({ Status: 'Fulfilled' }, st(400), [{ Status: 'resolved', DecidedAt: new Date(Date.now() - 400 * day).toISOString() }], cfg, Date.now()));
ok('retention: refund still due -> kept', !box.txRetentionEligible({ Status: 'Cancelled' }, Object.assign(st(900), { RefundState: 'due' }), [], cfg, Date.now()));
const sweep = box.sweepTxRetention(Date.now() + 800 * day);
const aRow = box.__sheets.TxEvidence.objects().find((e) => e.EvidenceId === rcpt);
ok('retention: the sweep removes files of finished orders and keeps the metadata', sweep.deleted > 0 && aRow.DeletedAt && aRow.Retention === 'expired' && aRow.Sha256
  && box.__drive.files[aRow.FileId].trashed, J(sweep));
ok('retention: files on unfinished orders survive the sweep', box.__sheets.TxEvidence.objects().filter((e) => e.OrderId === f && !e.DeletedAt).length > 0);

/* ==================== Rollback ==================== */
const rb = order().orderId;
box.__props.TX_ROOMS = 'off';
ok('rollback: with rooms off, a room order is managed from the dropdown again (nothing stuck)', box.actionUpdateOrderStatus(SELLER, { orderId: rb, status: 'Paid' }).ok && status(rb) === 'Paid');
ok('rollback: ...and its room is closed, its records kept', !room(buyer, rb).ok && !!stateOf(rb));
box.__props.TX_ROOMS = 'on';

/* ==================== Setup ==================== */
const setup = box.actionCheckSetup();
ok('checkSetup probes Transactions.gs', setup.missingFiles.indexOf('Transactions.gs') === -1);
ok('customer order list carries the room summary', box.actionListCustomerOrders({ token: 'ctok-b' }).orders.some((x) => x.room && x.room.flow === 'v1'));

let fails = 0;
console.log('\n--- order rooms ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
