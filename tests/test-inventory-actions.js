/**
 * Seller inventory actions (Inventory.gs) on the REAL backend sources against
 * an in-memory spreadsheet: getInventory, receiveStock, adjustStock,
 * updateStockSettings, listStockMovements - validation, ledger rows, no
 * duplicate submits, and Seller A never touching Seller B's stock.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'];
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A', 'active', ''], ['own_b', 'b', 'B', 'active', 'wholesaler']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'],
    ['prod_a', 'own_a', 'Rice', 'active', 'food'], ['prod_b', 'own_b', 'Flour', 'active', 'food'], ['prod_s', 'own_a', 'Car wash', 'active', 'services']],
  Variants: [vHead,
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R1', 10, 'active', 2],
    ['v2', 'prod_a', 'own_a', '5kg', 9, '', '', 'active', ''],
    ['vb', 'prod_b', 'own_b', '25kg', 30, 'R1', 100, 'active', ''],
    ['vs', 'prod_s', 'own_a', 'Basic', 10, '', '', 'active', '']]
});
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreType: 'wholesaler' };
const v = (id) => box.__sheets.Variants.objects().find((r) => r.VariantId === id);
const ledger = () => (box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : []);

/* ---------- getInventory ---------- */
let res = box.actionGetInventory(A);
ok('lists only this seller\'s goods (not services, not other stores)', res.ok && res.items.map((i) => i.variantId).sort().join() === 'v1,v2', JSON.stringify(res.items && res.items.map((i) => i.variantId)));
const i1 = res.items.find((i) => i.variantId === 'v1');
ok('item numbers: 10 in stock, 2 held, 8 available', i1.physical === 10 && i1.reserved === 2 && i1.available === 8);
ok('summary counts tracked items and held units', res.summary.tracked === 1 && res.summary.reservedUnits === 2, JSON.stringify(res.summary));
ok('retailer gets the simple capability set', res.capabilities.suppliers === false && res.capabilities.locations === false);
ok('wholesaler gets suppliers / purchase orders', box.actionGetInventory(B).capabilities.suppliers === true);

/* ---------- receive ---------- */
res = box.actionReceiveStock(A, { variantId: 'v1', quantity: '5', supplier: 'ABC Trading', invoice: 'INV-1045', unitCost: '1.20', requestId: 'r1' });
ok('receive adds stock and sets cost', res.ok && Number(v('v1').StockQty) === 15 && Number(v('v1').CostPrice) === 1.2, JSON.stringify(res));
let last = ledger().slice(-1)[0];
ok('ledger STOCK_RECEIVED +5 with supplier and invoice', last.MovementType === 'STOCK_RECEIVED' && Number(last.Quantity) === 5 &&
  last.ReferenceId === 'INV-1045' && /ABC Trading/.test(last.Notes), JSON.stringify(last));
res = box.actionReceiveStock(A, { variantId: 'v1', quantity: '5', requestId: 'r1' });
ok('same request id again (double tap / retry) does NOT add twice', res.ok && Number(v('v1').StockQty) === 15 && ledger().length === 1);
ok('receive refuses 0, negatives and fractions', ['0', '-3', '2.5', 'abc', ''].every((q) => !box.actionReceiveStock(A, { variantId: 'v1', quantity: q }).ok));
res = box.actionReceiveStock(A, { variantId: 'v2', quantity: '7' });
ok('receiving into an untracked variety turns tracking on', res.ok && Number(v('v2').StockQty) === 7 && res.item.tracked === true);

/* ---------- adjust ---------- */
res = box.actionAdjustStock(A, { variantId: 'v1', reason: 'damaged', quantity: '3', notes: 'Wet bags' });
ok('damaged removes units, logged DAMAGED -3', res.ok && Number(v('v1').StockQty) === 12 && ledger().slice(-1)[0].MovementType === 'DAMAGED' && Number(ledger().slice(-1)[0].Quantity) === -3);
res = box.actionAdjustStock(A, { variantId: 'v1', reason: 'count', newCount: '1' });
ok('a count below held units is refused, stock unchanged', !res.ok && /2 are held by open orders/.test(res.error) && Number(v('v1').StockQty) === 12, res.error);
res = box.actionAdjustStock(A, { variantId: 'v1', reason: 'expired', quantity: '50' });
ok('cannot remove more than is in stock', !res.ok && /only have 12/.test(res.error), res.error);
res = box.actionAdjustStock(A, { variantId: 'v1', reason: 'count', newCount: '20' });
ok('count sets the exact number, logged MANUAL_ADJUSTMENT +8', res.ok && Number(v('v1').StockQty) === 20 && Number(ledger().slice(-1)[0].Quantity) === 8);
ok('the same count again is refused as no change', !box.actionAdjustStock(A, { variantId: 'v1', reason: 'count', newCount: '20' }).ok);
res = box.actionAdjustStock(A, { variantId: 'v1', reason: 'returned', quantity: '2' });
ok('customer return adds back, logged RETURN', res.ok && Number(v('v1').StockQty) === 22 && ledger().slice(-1)[0].MovementType === 'RETURN');
ok('an unknown reason is refused', !box.actionAdjustStock(A, { variantId: 'v1', reason: 'stolen', quantity: '1' }).ok);

/* ---------- settings ---------- */
res = box.actionUpdateStockSettings(A, { variantId: 'v2', sku: 'r1', reorderLevel: '3' });
ok('a SKU already used by another variety is refused (case-insensitive)', !res.ok && /already used by 1kg/.test(res.error), res.error);
res = box.actionUpdateStockSettings(A, { variantId: 'v2', sku: 'R5', barcode: '9300601', reorderLevel: '8', reorderQty: '20', costPrice: '6.5' });
ok('settings saved', res.ok && v('v2').SKU === 'R5' && String(v('v2').Barcode) === '9300601' && Number(v('v2').ReorderLevel) === 8, JSON.stringify(res));
ok('at/below the level -> low', res.item.health === 'low' && res.item.available === 7);
ok('bad numbers and barcodes are refused', !box.actionUpdateStockSettings(A, { variantId: 'v2', reorderLevel: '-1' }).ok &&
  !box.actionUpdateStockSettings(A, { variantId: 'v2', barcode: 'abc def!' }).ok);
ok('another store may reuse the same SKU (B already has R1)', box.actionUpdateStockSettings(A, { variantId: 'v1', sku: 'R1' }).ok);

/* ---------- isolation ---------- */
ok('Seller A cannot receive into Seller B\'s variety', !box.actionReceiveStock(A, { variantId: 'vb', quantity: '5' }).ok && Number(v('vb').StockQty) === 100);
ok('...nor adjust it', !box.actionAdjustStock(A, { variantId: 'vb', reason: 'count', newCount: '0' }).ok);
ok('...nor change its settings', !box.actionUpdateStockSettings(A, { variantId: 'vb', sku: 'X' }).ok);
box.actionReceiveStock(B, { variantId: 'vb', quantity: '1' });
const histA = box.actionListStockMovements(A, {});
ok('history only shows the seller\'s own movements', histA.ok && histA.movements.every((m) => m.productName === 'Rice') && histA.total === ledger().filter((m) => m.OwnerId === 'own_a').length);

/* ---------- history ---------- */
ok('history is newest first, with names', histA.movements[0].type === 'RETURN' && histA.movements[0].label === '1kg');
const only = box.actionListStockMovements(A, { variantId: 'v2' });
ok('history filters by variety', only.movements.length === 1 && only.movements[0].type === 'STOCK_RECEIVED');
const page = box.actionListStockMovements(A, { limit: 2 });
ok('history pages', page.movements.length === 2 && page.hasMore === true);

let f = 0;
console.log('\n--- inventory actions: receive / adjust / settings / history ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
