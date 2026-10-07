/**
 * Locations, transfers, suppliers and reports (InventoryLocations.gs + its
 * hooks in Inventory.gs) on the REAL backend: the main location is the rest
 * of the total, transfers keep the total, receiving / counting at a location,
 * a sale that empties the main location takes the shortfall from the others
 * (logged), suppliers, reports, and retailers / other sellers locked out.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const OWNERS = [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Island', 'DeliveryPickPay'],
  ['own_d', 'd', 'D', 'active', 'distributor', 'South Tarawa', 'true'], ['own_r', 'r', 'R', 'active', '', 'South Tarawa', 'true'], ['own_w', 'w', 'W', 'active', 'wholesaler', 'South Tarawa', 'true']];
const box = makeBox({
  Owners: OWNERS,
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'],
    ['prod_d', 'own_d', 'd', 'Rice', 'active', 'food', 'product'], ['prod_r', 'own_r', 'r', 'Soap', 'active', 'home', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'CostPrice'],
    ['v1', 'prod_d', 'own_d', '25kg', 30, 'R25', 100, 'active', '', 20], ['vr', 'prod_r', 'own_r', 'bar', 1, '', 5, 'active', '', '']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village', 'DeliveryAddress', 'DeliveryMethod',
    'DeliveryCost', 'Notes', 'PaymentMethod', 'PaymentReference', 'ItemsJson', 'ItemsSummary', 'Subtotal', 'Total', 'Status', 'CreatedAt', 'UpdatedAt']],
  AbandonedCarts: [['CartId', 'StoreSlug', 'Email', 'ConvertedOrderId']]
});
const D = { OwnerId: 'own_d', StoreSlug: 'd', StoreType: 'distributor' };
const Rt = { OwnerId: 'own_r', StoreSlug: 'r', StoreType: '' };
const W = { OwnerId: 'own_w', StoreSlug: 'w', StoreType: 'wholesaler' };
const v1 = () => box.__sheets.Variants.objects().find((x) => x.VariantId === 'v1');
const split = () => Object.fromEntries(box.actionGetInventory(D).items[0].locations.map((l) => [l.name, l.qty]));
const ledger = () => box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : [];

/* ---------- access ---------- */
ok('a retailer gets no locations or suppliers', !box.actionListLocations(Rt).ok && !box.actionSaveSupplier(Rt, { name: 'X' }).ok &&
  box.actionGetInventory(Rt).capabilities.locations === false);
ok('no extra locations yet: no split shown, transfers off', !box.actionGetInventory(D).items[0].locations && box.actionGetInventory(D).capabilities.transfers === false);

/* ---------- locations ---------- */
let res = box.actionSaveLocation(D, { name: 'Bairiki warehouse', type: 'warehouse' });
const wh = res.locationId;
ok('add a warehouse', res.ok && box.actionGetInventory(D).capabilities.transfers === true);
ok('duplicate names refused', !box.actionSaveLocation(D, { name: 'bairiki WAREHOUSE' }).ok);
box.actionSaveLocation(D, { locationId: 'default', name: 'Betio shop' });
const shop2 = box.actionSaveLocation(D, { name: 'Bikenibeu shop', type: 'branch' }).locationId;
ok('main location renamed; all stock starts there', JSON.stringify(split()) === JSON.stringify({ 'Betio shop': 100, 'Bairiki warehouse': 0, 'Bikenibeu shop': 0 }), JSON.stringify(split()));

/* ---------- transfers ---------- */
res = box.actionTransferStock(D, { variantId: 'v1', fromLocationId: 'default', toLocationId: wh, quantity: 60, requestId: 't1' });
ok('transfer 60 to the warehouse: total unchanged', res.ok && Number(v1().StockQty) === 100 && JSON.stringify(split()) === JSON.stringify({ 'Betio shop': 40, 'Bairiki warehouse': 60, 'Bikenibeu shop': 0 }));
const tr = ledger().filter((m) => m.MovementType === 'STOCK_TRANSFER');
ok('both sides logged with each location\'s before/after', tr.length === 2 && Number(tr[0].Quantity) === -60 && Number(tr[0].NewStock) === 40 &&
  tr[1].LocationId === wh && Number(tr[1].NewStock) === 60 && /To Bairiki warehouse/.test(tr[0].Notes), JSON.stringify(tr));
ok('the same request again moves nothing more', box.actionTransferStock(D, { variantId: 'v1', fromLocationId: 'default', toLocationId: wh, quantity: 60, requestId: 't1' }).ok && split()['Bairiki warehouse'] === 60);
ok('cannot move more than a location has', /only has 60/.test(box.actionTransferStock(D, { variantId: 'v1', fromLocationId: wh, toLocationId: shop2, quantity: 61 }).error));
ok('same location twice refused', !box.actionTransferStock(D, { variantId: 'v1', fromLocationId: wh, toLocationId: wh, quantity: 1 }).ok);
box.actionTransferStock(D, { variantId: 'v1', fromLocationId: wh, toLocationId: shop2, quantity: 10 });
ok('warehouse -> branch', JSON.stringify(split()) === JSON.stringify({ 'Betio shop': 40, 'Bairiki warehouse': 50, 'Bikenibeu shop': 10 }));
ok('Seller W cannot move Seller D\'s stock or use D\'s location', !box.actionTransferStock(W, { variantId: 'v1', fromLocationId: 'default', toLocationId: wh, quantity: 1 }).ok);

/* ---------- receive / count at a location ---------- */
const sup = box.actionSaveSupplier(D, { name: 'ABC Trading', phone: '7300 1234' });
ok('supplier added (and duplicates refused)', sup.ok && !box.actionSaveSupplier(D, { name: 'abc trading' }).ok && box.actionListSuppliers(D).suppliers.length === 1);
res = box.actionReceiveStock(D, { variantId: 'v1', quantity: 25, supplier: 'ABC Trading', locationId: wh });
ok('receive into the warehouse: total +25, warehouse +25', res.ok && Number(v1().StockQty) === 125 && split()['Bairiki warehouse'] === 75 && split()['Betio shop'] === 40);
ok('...ledger row carries the location', ledger().slice(-1)[0].LocationId === wh && ledger().slice(-1)[0].MovementType === 'STOCK_RECEIVED');
res = box.actionAdjustStock(D, { variantId: 'v1', reason: 'count', newCount: 70, locationId: wh });
ok('count at the warehouse (75 -> 70): total -5', res.ok && Number(v1().StockQty) === 120 && split()['Bairiki warehouse'] === 70 && split()['Betio shop'] === 40);
res = box.actionAdjustStock(D, { variantId: 'v1', reason: 'damaged', quantity: 11, locationId: shop2 });
ok('cannot remove more than that location holds', !res.ok && /only have 10 there/.test(res.error), res.error);

/* ---------- a sale that empties the main location ---------- */
// Total 120 = shop 40 + warehouse 70 + branch 10. Sell 45: more than the shop holds.
res = box.actionCreateOrder({ storeSlug: 'd', items: [{ variantId: 'v1', qty: 45 }], customerName: 'T', customerPhone: '73000000', island: 'South Tarawa', village: 'Betio', deliveryMethod: 'pickPay', paymentMethod: 'cash' });
ok('order placed against the total', res.ok, JSON.stringify(res));
box.actionUpdateOrderStatus({ OwnerId: 'own_d' }, { orderId: res.orderId, status: 'Fulfilled' });
const s = split();
ok('fulfilled: total 75; the 5-unit shortfall came from the largest other location', Number(v1().StockQty) === 75 && s['Betio shop'] === 0 &&
  s['Bairiki warehouse'] === 65 && s['Bikenibeu shop'] === 10, JSON.stringify(s));
ok('...and that is logged, not silent', ledger().some((m) => m.Source === 'rebalance' && Number(m.Quantity) === -5 && m.LocationId === wh));

/* ---------- archive + reports ---------- */
ok('a location with stock can\'t be closed', /still holds 10 units/.test(box.actionArchiveLocation(D, { locationId: shop2 }).error));
box.actionTransferStock(D, { variantId: 'v1', fromLocationId: shop2, toLocationId: 'default', quantity: 10 });
ok('an emptied location can be closed; the main one never', box.actionArchiveLocation(D, { locationId: shop2 }).ok && !box.actionArchiveLocation(D, { locationId: 'default' }).ok);
const locs = box.actionListLocations(D).locations;
ok('location list: units and stock value per place', locs.length === 2 && locs[0].name === 'Betio shop' && locs[0].units === 10 && locs[1].units === 65 && locs[1].value === 1300, JSON.stringify(locs));
const rep = box.actionInventoryReport(D, { days: 30 }).report;
ok('report: received by supplier, sold, by location', rep.received === 25 && rep.sold === 45 && rep.bySupplier[0].supplier === 'ABC Trading' &&
  rep.topSellers[0].units === 45 && rep.byLocation.length === 2, JSON.stringify(rep));
ok('a retailer\'s report has no location section', !box.actionInventoryReport(Rt, {}).report.byLocation);
ok('supplier can be archived (kept for history)', box.actionArchiveSupplier(D, { supplierId: sup.supplierId }).ok && box.actionListSuppliers(D).suppliers.length === 0);

let f = 0;
console.log('\n--- locations, transfers, suppliers, reports ---');
for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e !== '' && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
