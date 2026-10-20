/**
 * Order references are unique (Utils.gs generateOrderRef + Orders.gs), on the
 * REAL backend sources. SKS-<store>-<yyyyMMdd>-<4 random digits> used to be
 * drawn with no check, so two orders for one store on one day could share a
 * reference (about 1 in 20 days at 30 orders a day) and every lookup by
 * OrderId then found the older one - the cause of test-tx-rooms failing now
 * and then. A clashing number is now drawn again inside the checkout lock.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const ORDER_COLS = ['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
  'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt'];
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

const make = (orders) => makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'Island', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', 'active', 'South Tarawa', 'true', 'true', 5, 'retailer']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p_rice', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'], ['v_rice', 'p_rice', 'own_s', '10kg', 20, '', 100000, 'active']],
  Orders: [ORDER_COLS].concat(orders || []),
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
const place = (box) => {
  Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
  return box.actionCreateOrder({ storeSlug: 'bong', items: [{ variantId: 'v_rice', qty: 1 }], customerName: 'Tia', customerPhone: '73000001',
    customerEmail: 'b@x.test', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'truck', paymentMethod: '' });
};
const row = (id) => [id, 'own_s', 'bong', 'Old', '73000009', 'old@x.test', 'South Tarawa', 'Betio', '', 'truck', 5, '', '', id, '[]', '', 20, 25, 'Paid', '', ''];

/* ---------- the reference itself ---------- */
let box = make();
const ref = box.generateOrderRef('bong');
ok('format unchanged: SKS-<store>-<yyyyMMdd>-<4 digits>', new RegExp('^SKS-bong-' + today + '-\\d{4}$').test(ref), ref);
let tries = 0;
const second = box.generateOrderRef('bong', () => ++tries < 4);
ok('a taken reference is drawn again until a free one comes up', tries === 4 && /^SKS-bong-\d{8}-\d{4}$/.test(second), tries + ' ' + second);
const crowded = box.generateOrderRef('bong', (r) => /^SKS-bong-\d{8}-\d{4}$/.test(r));
ok('after 20 clashes in a row it adds two digits rather than fail', /^SKS-bong-\d{8}-\d{4}-\d{2}$/.test(crowded), crowded);

/* ---------- through checkout ---------- */
box = make();
const ids = new Set();
for (let i = 0; i < 150; i++) { const r = place(box); if (r.ok) ids.add(r.orderId); }
ok('150 orders for one store in one day all get different references', ids.size === 150, ids.size);

// Every 4-digit reference for today already used except 9999: a new order must
// still get a reference no other order has.
const full = [];
for (let n = 1000; n <= 9998; n++) full.push(row('SKS-bong-' + today + '-' + n));
box = make(full);
const r = place(box);
const all = box.__sheets.Orders.objects().map((o) => o.OrderId);
ok('even on a day when nearly every number is taken, the new order\'s reference is unique',
  r.ok && all.filter((id) => id === r.orderId).length === 1, r.orderId);
ok('...and the order is found by its own reference, not an older one', box.__sheets.Orders.objects().find((o) => o.OrderId === r.orderId).CustomerName === 'Tia');

let fails = 0;
console.log('\n--- order references ---');
for (const [st, n, x] of R) { if (st === 'FAIL') fails++; console.log(`${st}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
