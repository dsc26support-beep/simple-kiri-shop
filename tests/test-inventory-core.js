/**
 * Inventory core (Inventory.gs + its hooks in Orders.gs / Products.gs), run
 * end to end on the REAL backend sources against an in-memory spreadsheet
 * (tests/lib/gas-harness.js): checkout reserves, Fulfilled deducts,
 * Cancelled releases or returns, nothing oversells, every change is in the
 * StockMovements ledger, and the product form can't undercut reservations.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const OWNER = { OwnerId: 'own_1', StoreSlug: 'bong', StoreName: 'Bong', Email: '', Status: 'active', Island: 'South Tarawa', DeliveryPickPay: 'true' };
function fresh(variants) {
  const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'];
  return makeBox({
    Owners: [Object.keys(OWNER), Object.values(OWNER)],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category'], ['prod_1', 'own_1', 'bong', 'Rice', 'active', 'food']],
    Variants: [vHead].concat(variants.map((v) => vHead.map((h) => (h in v ? v[h] : '')))),
    Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress',
      'DeliveryMethod', 'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total',
      'Status', 'CreatedAt', 'UpdatedAt']],
    AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
  });
}
const V = (id, stock, extra) => Object.assign({ VariantId: id, ProductId: 'prod_1', OwnerId: 'own_1', Label: id, Price: 2, Status: 'active', StockQty: stock }, extra || {});
const order = (box, items) => box.actionCreateOrder({ storeSlug: 'bong', items, customerName: 'Tia', customerPhone: '73000000',
  island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash' });
const variant = (box, id) => box.__sheets.Variants.objects().find((v) => v.VariantId === id);
const ledger = (box) => (box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : []);
const setStatus = (box, orderId, status) => box.actionUpdateOrderStatus({ OwnerId: 'own_1' }, { orderId, status });

/* ---------- checkout reserves ---------- */
let box = fresh([V('v1', 10), V('v2', '')]);
let res = order(box, [{ variantId: 'v1', qty: 3 }, { variantId: 'v2', qty: 50 }]);
ok('order placed', res.ok, JSON.stringify(res));
let v1 = variant(box, 'v1');
ok('checkout reserves: physical stays 10, reserved 3', Number(v1.StockQty) === 10 && Number(v1.ReservedQty) === 3, JSON.stringify(v1));
ok('untracked variety is untouched and unlimited', variant(box, 'v2').StockQty === '' && !variant(box, 'v2').ReservedQty);
let L = ledger(box);
ok('ledger: one ORDER_RESERVED row for the tracked line, tied to the order',
  L.length === 1 && L[0].MovementType === 'ORDER_RESERVED' && L[0].ReferenceId === res.orderId && Number(L[0].Quantity) === 3 &&
  Number(L[0].PreviousReserved) === 0 && Number(L[0].NewReserved) === 3, JSON.stringify(L));
ok('shoppers see available (10 - 3 = 7)', box.publicVariantFields(variant(box, 'v1')).stockQty === 7);
const orderA = res.orderId;

/* ---------- no overselling ---------- */
res = order(box, [{ variantId: 'v1', qty: 8 }]);
ok('cannot order more than available (7)', !res.ok && /Only 7 left/.test(res.error), res.error);
res = order(box, [{ variantId: 'v1', qty: 4 }, { variantId: 'v1', qty: 4 }]);
ok('two lines of the same variety add up against availability', !res.ok && /Only 3 left/.test(res.error), res.error);
ok('a refused order changes nothing', Number(variant(box, 'v1').ReservedQty) === 3 && ledger(box).length === 1);
res = order(box, [{ variantId: 'v1', qty: 7 }]);
ok('exactly the available amount is fine', res.ok);
const orderB = res.orderId;
res = order(box, [{ variantId: 'v1', qty: 1 }]);
ok('then it is sold out', !res.ok && /out of stock/.test(res.error), res.error);

/* ---------- Fulfilled deducts, Cancelled releases ---------- */
ok('Paid keeps it reserved (no stock change)', setStatus(box, orderA, 'Paid').ok && Number(variant(box, 'v1').ReservedQty) === 10 && ledger(box).length === 2);
ok('Fulfilled -> physical 10->7, reserved 10->7', setStatus(box, orderA, 'Fulfilled').ok &&
  Number(variant(box, 'v1').StockQty) === 7 && Number(variant(box, 'v1').ReservedQty) === 7);
ok('ledger SALE -3', ledger(box).slice(-1)[0].MovementType === 'SALE' && Number(ledger(box).slice(-1)[0].Quantity) === -3);
ok('Cancelled (open order) -> reservation released, physical unchanged', setStatus(box, orderB, 'Cancelled').ok &&
  Number(variant(box, 'v1').StockQty) === 7 && Number(variant(box, 'v1').ReservedQty) === 0 && ledger(box).slice(-1)[0].MovementType === 'ORDER_RELEASED');
ok('cancelling twice does nothing more', setStatus(box, orderB, 'Cancelled').ok && Number(variant(box, 'v1').ReservedQty) === 0);
ok('Cancelled after Fulfilled = RETURN, physical back up', setStatus(box, orderA, 'Cancelled').ok &&
  Number(variant(box, 'v1').StockQty) === 10 && ledger(box).slice(-1)[0].MovementType === 'RETURN');

/* ---------- reopening checks availability ---------- */
res = order(box, [{ variantId: 'v1', qty: 9 }]);
ok('new order takes 9 of 10', res.ok);
const blocked = setStatus(box, orderB, 'Paid'); // orderB wants 7 back, only 1 available
ok('reopening a cancelled order is refused when stock is gone', !blocked.ok && /Only 1/.test(blocked.error), blocked.error);
ok('...and its status stays Cancelled', box.__sheets.Orders.objects().find((o) => o.OrderId === orderB).Status === 'Cancelled');

/* ---------- orders from before inventory existed ---------- */
box = fresh([V('v1', 5)]);
box.__sheets.Orders.appendRow(['ORD-OLD', 'own_1', 'bong', 'Old', '7300', '', 'South Tarawa', 'Betio', '', 'pickPay', 0, '', 'cash', 'ORD-OLD',
  JSON.stringify([{ productId: 'prod_1', variantId: 'v1', label: 'Rice', qty: 2, unitPrice: 2, lineTotal: 4 }]), '', 4, 4, 'Pending Payment', '', '']);
ok('legacy order: Fulfilled does NOT deduct again (stock was taken at checkout)', setStatus(box, 'ORD-OLD', 'Fulfilled').ok && Number(variant(box, 'v1').StockQty) === 5);
box.__sheets.Orders.grid[1][18] = 'Pending Payment';
ok('legacy order: Cancelled gives the stock back (the old bug)', setStatus(box, 'ORD-OLD', 'Cancelled').ok && Number(variant(box, 'v1').StockQty) === 7, variant(box, 'v1').StockQty);

/* ---------- product form ---------- */
box = fresh([V('v1', 10)]);
order(box, [{ variantId: 'v1', qty: 4 }]);
const owner = Object.assign({}, OWNER, { StoreType: 'wholesaler' });
const save = (stock) => box.actionCreateOrUpdateProduct(owner, { productId: 'prod_1', name: 'Rice', category: 'food', description: '',
  variants: [{ variantId: 'v1', label: 'v1', price: 2, stockQty: stock }] });
res = save(3);
ok('product form cannot set stock below reserved (4)', !res.ok && /4 of v1 are held by open orders/.test(res.error), res.error);
ok('...and nothing was written', Number(variant(box, 'v1').StockQty) === 10 && ledger(box).length === 1);
res = save(25);
ok('raising stock on the form works', res.ok && Number(variant(box, 'v1').StockQty) === 25, JSON.stringify(res));
const adj = ledger(box).slice(-1)[0];
ok('...and is logged as MANUAL_ADJUSTMENT +15 (10 -> 25)', adj.MovementType === 'MANUAL_ADJUSTMENT' && Number(adj.Quantity) === 15 &&
  Number(adj.PreviousStock) === 10 && Number(adj.NewStock) === 25, JSON.stringify(adj));
ok('saving without a stock change adds no ledger row', save(25).ok && ledger(box).length === 2);

/* ---------- pure helpers ---------- */
ok('health: low at/below reorder level', box.stockHealthOf({ StockQty: 5, ReservedQty: 0, ReorderLevel: 5 }) === 'low');
ok('health: out when nothing available', box.stockHealthOf({ StockQty: 5, ReservedQty: 5 }) === 'out');
ok('health: untracked', box.stockHealthOf({ StockQty: '' }) === 'untracked');
ok('available never negative', box.availableOf({ StockQty: 2, ReservedQty: 9 }) === 0);

let f = 0;
console.log('\n--- inventory core: reserve / deduct / release + ledger ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
