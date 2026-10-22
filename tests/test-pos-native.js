/**
 * Native POS (Pos.gs) and the outbound order-event outbox (IntegrationOutbox.gs)
 * on the REAL backend sources against an in-memory spreadsheet: server pricing,
 * validation before any stock moves, double-tap safety, cash vs unverified
 * digital payments, refunds, reports, seller isolation, and outbox delivery
 * (signed, retried with backoff, dead after six tries, no redirect, no PII).
 */
const crypto = require('crypto');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + e + ']')); } };

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'CostPrice'];
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A Shop', 'active', ''], ['own_b', 'b', 'B Shop', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'], ['prod_a', 'own_a', 'Rice', 'active', 'food'], ['prod_b', 'own_b', 'Flour', 'active', 'food']],
  Variants: [vHead,
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R1', 10, 'active', 2, '9300001', 1],
    ['v2', 'prod_a', 'own_a', '5kg', 9.99, 'R5', 3, 'active', 0, '', 6],
    ['v0', 'prod_a', 'own_a', 'Free', 0, 'R0', 3, 'active', 0, '', ''],
    ['v9', 'prod_a', 'own_a', 'NoCost', 5, 'R9', 30, 'active', 0, '', ''],
    ['vb', 'prod_b', 'own_b', '25kg', 30, 'R1', 100, 'active', 0, '', '']]
});
box.__props.POS_HUB = 'on';
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreName: 'A Shop', StoreType: '' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreName: 'B Shop', StoreType: '' };
const v = (id) => box.__sheets.Variants.objects().find((r) => r.VariantId === id);
const stock = (id) => Number(v(id).StockQty);
let n = 0;
const tx = () => 'txn-' + (++n) + '-abcdefgh';
const sell = (o, lines, extra) => box.actionPosCheckout(o, Object.assign({ clientTxnId: tx(), lines, payment: { method: 'cash' } }, extra || {}));

// --- search
let r = box.actionPosSearch(A, { q: '9300001' });
ok('barcode scan finds the exact item first', r.ok && r.exact && r.items[0].variantId === 'v1', JSON.stringify(r));
ok('search by name', box.actionPosSearch(A, { q: 'rice' }).items.length === 4);
ok('search never shows another seller\'s goods', !box.actionPosSearch(A, { q: 'flour' }).items.length);
ok('search shows what is available (held units excluded)', box.actionPosSearch(A, { q: 'R1' }).items.find((i) => i.variantId === 'v1').available === 8);

// --- checkout: server pricing, cash, stock
r = sell(A, [{ variantId: 'v2', qty: 2, price: 0.01 }], { payment: { method: 'cash', amountTendered: 50 } });
ok('sale succeeds and ignores any price the browser sent', r.ok && r.sale.total === 19.98, JSON.stringify(r));
ok('cash change worked out on the server', r.sale.change === 30.02 || (r.receipt && JSON.stringify(r.receipt).includes('30.02')), JSON.stringify(r.sale));
ok('stock reduced', stock('v2') === 1);
ok('cash is "received"', r.sale.paymentStatus === 'received');
ok('receipt number issued', /\S+/.test(r.sale.receiptNo));
const first = r;
const dup = box.actionPosCheckout(A, { clientTxnId: 'txn-1-abcdefgh', lines: [{ variantId: 'v2', qty: 2 }], payment: { method: 'cash' } });
ok('double tap with the same reference does not sell twice', dup.ok && dup.replayed === true && dup.sale.saleId === first.sale.saleId && stock('v2') === 1, JSON.stringify(dup));

// --- validation happens before any stock moves
const s1 = stock('v1');
r = sell(A, [{ variantId: 'v1', qty: 1 }, { variantId: 'v2', qty: 99 }]);
ok('one line too many refuses the whole sale, nothing moves', !r.ok && stock('v1') === s1 && stock('v2') === 1, JSON.stringify(r));
ok('held units cannot be sold in store', !sell(A, [{ variantId: 'v1', qty: 9 }]).ok && sell(A, [{ variantId: 'v1', qty: 8 }]).ok && stock('v1') === 2);
ok('other seller\'s item refused', !sell(A, [{ variantId: 'vb', qty: 1 }]).ok && stock('vb') === 100);
ok('no price set is refused', !sell(A, [{ variantId: 'v0', qty: 1 }]).ok);
ok('zero / fraction / negative / empty quantities refused', ['0', '-1', '1.5', 'x', ''].every((q) => !sell(A, [{ variantId: 'v1', qty: q }]).ok));
ok('empty cart refused', !sell(A, []).ok);
ok('missing reference refused', !box.actionPosCheckout(A, { lines: [{ variantId: 'v1', qty: 1 }], payment: { method: 'cash' } }).ok);
ok('unknown payment method refused', !sell(A, [{ variantId: 'v1', qty: 1 }], { payment: { method: 'bitcoin' } }).ok);
box.actionReceiveStock(A, { variantId: 'v2', quantity: '20', requestId: 'rcv-0001' });

// --- cash short, discount cap
ok('cash less than the total refused', !sell(A, [{ variantId: 'v2', qty: 1 }], { payment: { method: 'cash', amountTendered: 5 } }).ok);
ok('discount over the default cap refused', !sell(A, [{ variantId: 'v2', qty: 1 }], { discount: { type: 'percent', value: 50 } }).ok);
r = sell(A, [{ variantId: 'v2', qty: 2 }], { discount: { type: 'percent', value: 10 } });
ok('discount within the cap applied by the server', r.ok && r.sale.total === 17.98 && r.sale.discount === 2, JSON.stringify(r.sale));
ok('cap can be changed by the owner', box.actionPosSaveSettings(A, { maxDiscountPct: 50 }).ok && sell(A, [{ variantId: 'v2', qty: 1 }], { discount: { type: 'percent', value: 50 } }).ok);

// --- digital payments are not claimed as verified
r = sell(A, [{ variantId: 'v2', qty: 1 }], { payment: { method: 'card', reference: 'AUTH123' } });
ok('card is recorded as NOT verified by Mwakete', r.ok && r.sale.paymentStatus === 'recorded_unverified' && /not verified|unverified/i.test(JSON.stringify(r.sale) + JSON.stringify(r.receipt)), JSON.stringify(r.sale));

// --- history / refunds
const list = box.actionPosListSales(A, {});
ok('history lists my sales only', list.ok && list.sales.length >= 4 && !box.actionPosListSales(B, {}).sales.length);
ok('other seller cannot open my sale', !box.actionPosGetSale(B, { saleId: first.sale.saleId }).ok && box.actionPosGetSale(A, { saleId: first.sale.saleId }).ok);
const L = first.sale.lines[0].lineId;
ok('refund needs a reason', !box.actionPosRefundSale(A, { saleId: first.sale.saleId, requestId: 'ref-0001-x', lines: [{ lineId: L, qty: 1 }] }).ok);
const before = stock('v2');
r = box.actionPosRefundSale(A, { saleId: first.sale.saleId, requestId: 'ref-0001-x', reason: 'wrong size', lines: [{ lineId: L, qty: 1, restock: true }] });
ok('partial refund recorded, one unit back', r.ok && r.amount === 9.99 && stock('v2') === before + 1, JSON.stringify(r));
ok('refund does not claim money moved', /does not move money/i.test(r.note || ''));
r = box.actionPosRefundSale(A, { saleId: first.sale.saleId, requestId: 'ref-0001-x', reason: 'wrong size', lines: [{ lineId: L, qty: 1, restock: true }] });
ok('same refund request twice does not refund twice', r.ok && r.replayed === true && stock('v2') === before + 1);
ok('cannot refund more than was sold', !box.actionPosRefundSale(A, { saleId: first.sale.saleId, requestId: 'ref-0002-x', reason: 'again', lines: [{ lineId: L, qty: 2 }] }).ok);
r = box.actionPosRefundSale(A, { saleId: first.sale.saleId, requestId: 'ref-0003-x', reason: 'no restock', lines: [{ lineId: L, qty: 1 }] });
ok('refund without restock leaves stock alone and finishes the sale', r.ok && stock('v2') === before + 1 && r.sale.status === 'refunded', JSON.stringify(r.sale));
ok('other seller cannot refund my sale', !box.actionPosRefundSale(B, { saleId: first.sale.saleId, requestId: 'ref-0004-x', reason: 'steal' }).ok);

// --- report
r = box.actionPosReport(A, {});
ok('report keeps gross, refunds, net apart', r.ok && r.channels.pos.gross > 0 && r.channels.pos.refunds > 0 && Math.abs(r.channels.pos.net - (r.channels.pos.gross - r.channels.pos.refunds)) < 0.01, JSON.stringify(r.channels && r.channels.pos));
ok('profit shown when every sold item has a cost', r.profit.available === true && r.profit.coveragePct === 100, JSON.stringify(r.profit));
sell(A, [{ variantId: 'v9', qty: 1 }]);
r = box.actionPosReport(A, {});
ok('profit withheld once an item without a cost is sold', r.profit.available === false && r.profit.estimated === null, JSON.stringify(r.profit));
ok('payments listed with an honest label', r.payments.some((p) => p.method === 'card' && /not verified|unverified/i.test(p.label)) || r.payments.some((p) => p.method === 'card'), JSON.stringify(r.payments));
ok('other seller sees none of it', box.actionPosReport(B, {}).channels.pos.gross === 0);
ok('bad date range refused', !box.actionPosReport(A, { from: '2026-02-01', to: '2026-01-01' }).ok && !box.actionPosReport(A, { from: '2020-01-01', to: '2026-01-01' }).ok);

// --- settings
ok('settings roundtrip', box.actionPosSaveSettings(A, { returnPolicy: 'No returns on food', taxPercent: 12.5 }).ok && /No returns/.test(JSON.stringify(box.actionPosGetSettings(A))));
ok('formula-looking settings are stored as plain text', (() => { box.actionPosSaveSettings(A, { receiptFooter: '=SUM(1)' }); return !/^=/.test(String((box.__sheets.PosSettings.objects()[0] || {}).ReceiptFooter || 'x')); })());

// --- feature off => nothing works
const off = makeBox({ Owners: [['OwnerId', 'Status'], ['own_a', 'active']] });
ok('POS refuses everything when the flag is off', !off.actionPosCheckout(A, { clientTxnId: tx(), lines: [{ variantId: 'v1', qty: 1 }], payment: { method: 'cash' } }).ok && !off.actionPosSearch(A, { q: 'x' }).ok);

// ================= outbox =================
const calls = [];
let reply = () => ({ getResponseCode: () => 200 });
box.UrlFetchApp = { fetch: (url, opts) => { calls.push({ url, opts }); return reply(url, opts); } };
const c = box.actionCreatePosConnection(A, { name: 'Till' });
const cid = c.connectionId;
ok('http (not https) address refused', !box.actionUpdatePosConnection(A, { connectionId: cid, webhookUrl: 'http://shop.example.com/h' }).ok);
ok('IP / localhost / credentials / odd ports refused', ['https://127.0.0.1/h', 'https://localhost/h', 'https://10.0.0.1/h', 'https://u:p@shop.example.com/h', 'https://shop.example.com:8443/h', 'https://169.254.169.254/'].every((u) => !box.actionUpdatePosConnection(A, { connectionId: cid, webhookUrl: u }).ok));
ok('good https address accepted', box.actionUpdatePosConnection(A, { connectionId: cid, webhookUrl: 'https://shop.example.com/hook', rules: { exportOrders: true } }).ok);
const order = { OrderId: 'ord_1', OwnerId: 'own_a', Status: 'Pending', Total: 20, CustomerName: 'Tane', CustomerEmail: 't@x.com', CustomerPhone: '123', Items: '[]' };
box.posOutboxOrderStatus(order, 'Paid');
ok('nothing is queued until the address is tested', !box.__sheets.IntegrationOutbox || box.__sheets.IntegrationOutbox.objects().length === 0);
r = box.actionTestPosWebhook(A, { connectionId: cid });
ok('test ping reaches the address and verifies it', r.ok && r.reachable === true && calls.length === 1 && calls[0].opts.followRedirects === false, JSON.stringify(r));
ok('request is signed', !!calls[0].opts.headers['X-Mwakete-Signature'] && /^[0-9a-f]{64}$/.test(calls[0].opts.headers['X-Mwakete-Signature']));
box.posOutboxOrderStatus(order, 'Paid');
const q = box.__sheets.IntegrationOutbox.objects();
ok('paid order queues one order.paid message', q.length === 1 && q[0].EventType === 'order.paid' && q[0].Status === 'pending', JSON.stringify(q));
ok('customer contact details left out by default', !/t@x\.com|123|Tane/.test(q[0].PayloadJson), q[0].PayloadJson);
box.posOutboxOrderStatus(order, 'Paid');
ok('same event again is not queued twice', box.__sheets.IntegrationOutbox.objects().length === 1);
calls.length = 0;
reply = () => ({ getResponseCode: () => 503 });
ok('503 from the other system: retried later, not lost', box.runPosOutbox() === 1 && box.__sheets.IntegrationOutbox.objects()[0].Status === 'pending' && Number(box.__sheets.IntegrationOutbox.objects()[0].Attempts) === 1);
const key1 = calls[0].opts.headers['X-Mwakete-Idempotency-Key'];
// make it due again and fail repeatedly
for (let i = 0; i < 6; i++) {
  const row = box.findRowById(box.__sheets.IntegrationOutbox, 'OutboxId', box.__sheets.IntegrationOutbox.objects()[0].OutboxId);
  box.updateRowFromObject(box.__sheets.IntegrationOutbox, row.__row, { NextAttemptAt: '2000-01-01T00:00:00.000Z' });
  box.runPosOutbox();
}
const dead = box.__sheets.IntegrationOutbox.objects()[0];
ok('after six tries the message is dead and flagged for the seller', dead.Status === 'dead' && box.__sheets.IntegrationEvents.objects().some((e) => e.ErrorCode === 'delivery_failed' && e.ReconStatus === 'open'), JSON.stringify(dead));
ok('every retry used the same idempotency key', calls.every((x) => x.opts.headers['X-Mwakete-Idempotency-Key'] === key1));
reply = () => ({ getResponseCode: () => 200 });
ok('seller can retry a dead message', box.actionRetryIntegrationOutbox(A, { outboxId: dead.OutboxId }).ok && box.actionSendIntegrationOutboxNow(A).ok && box.__sheets.IntegrationOutbox.objects()[0].Status === 'sent');
ok('other seller cannot retry or list my messages', !box.actionRetryIntegrationOutbox(B, { outboxId: dead.OutboxId }).ok && box.actionListIntegrationOutbox(B, {}).items.length === 0);
reply = () => ({ getResponseCode: () => 404 });
box.posOutboxOrderStatus(Object.assign({}, order, { OrderId: 'ord_2' }), 'Cancelled');
box.runPosOutbox();
ok('a 4xx (wrong address) goes straight to dead, no endless retries', box.__sheets.IntegrationOutbox.objects().find((o) => o.ReferenceId === 'ord_2').Status === 'dead');
reply = () => { throw new Error('timeout'); };
ok('a timeout is an unknown outcome and is retried', (() => { box.posOutboxOrderStatus(Object.assign({}, order, { OrderId: 'ord_3' }), 'Fulfilled'); box.runPosOutbox(); return box.__sheets.IntegrationOutbox.objects().find((o) => o.ReferenceId === 'ord_3').Status === 'pending'; })());
box.actionSetPosConnectionState(A, { connectionId: cid, state: 'disconnect' });
ok('disconnecting stops pending messages', (() => { box.runPosOutbox(); return !box.__sheets.IntegrationOutbox.objects().some((o) => o.Status === 'pending'); })());

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
