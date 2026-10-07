/**
 * Inventory import / export (InventorySync.gs) on the REAL backend against an
 * in-memory spreadsheet: mapping checks, matching priority (never by name),
 * dry-run preview, apply-exactly-what-was-previewed, reservations respected,
 * new products, sync history, seller isolation, and the export round trip.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode', 'ExternalId'];
function fresh() {
  return makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A', 'active', ''], ['own_b', 'b', 'B', 'active', 'wholesaler']],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'],
      ['prod_r', 'own_a', 'a', 'Rice', 'active', 'other', 'product'], ['prod_s', 'own_a', 'a', 'Soap', 'active', 'other', 'product'],
      ['prod_b', 'own_b', 'b', 'Flour', 'active', 'food', 'product']],
    Variants: [vHead,
      ['v_r1', 'prod_r', 'own_a', '1kg', 2, 'R-1', 10, 'active', 4, '', ''],
      ['v_r5', 'prod_r', 'own_a', '5kg', 9, 'R-5', '', 'active', '', '9300', 'EXT-55'],
      ['v_s', 'prod_s', 'own_a', 'bar', 1, 'S-1', 3, 'active', '', '', ''],
      ['v_b', 'prod_b', 'own_b', '25kg', 30, 'B-1', 100, 'active', '', '', '']]
  });
}
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreType: 'wholesaler' };
const headers = ['Item Code', 'Description', 'Stock Balance', 'Selling Price', 'Minimum Stock'];
const mapping = { 'Item Code': 'sku', 'Description': 'productName', 'Stock Balance': 'physicalStock', 'Selling Price': 'price', 'Minimum Stock': 'reorderLevel' };
let box = fresh();
const v = (id) => box.__sheets.Variants.objects().find((r) => r.VariantId === id);
const ledger = () => (box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : []);
const req = (rows, extra) => Object.assign({ type: 'csv', headers, rows, mapping }, extra || {});

/* ---------- mapping checks ---------- */
let res = box.actionPreviewInventoryImport(A, req([['R-1', 'Rice', 5, 2, 2]], { mapping: { 'Description': 'productName', 'Stock Balance': 'physicalStock' } }));
ok('mapping must include an identifier column', !res.ok && /identifies each item/.test(res.error), res.error);
res = box.actionPreviewInventoryImport(A, req([], { mapping: { 'Item Code': 'sku', 'Description': 'productName' } }));
ok('mapping must include something to update', !res.ok && /at least one column to update/.test(res.error), res.error);
res = box.actionPreviewInventoryImport(A, req([], { mapping: { 'Item Code': 'sku', 'Stock Balance': 'sku' } }));
ok('one field cannot take two columns', !res.ok && /two columns/.test(res.error), res.error);

/* ---------- preview (dry run) ---------- */
const rows = [
  ['R-1', 'Rice', 12, 2.5, 5],         // stock 10->12, price 2->2.5, level -> 5
  ['r-5', 'Rice 5kg', 7, '', ''],      // SKU match is case-insensitive; untracked -> 7
  ['S-1', 'Soap', 3, 1, ''],           // nothing changes
  ['NEW-9', 'Sugar', 40, 3, ''],       // not on Mwakete
  ['B-1', 'Flour', 1, 1, ''],          // another seller's SKU -> NOT matched
  ['X', 'Bad', 'lots', 1, ''],         // bad number
  ['', '', '', '', '']                 // blank trailing line - ignored
];
res = box.actionPreviewInventoryImport(A, req(rows));
const p = res.preview;
ok('preview counts', res.ok && p.counts.read === 6 && p.counts.existing === 3 && p.counts.stockChanges === 2 && p.counts.priceChanges === 1 &&
  p.counts.unmatched === 2 && p.counts.errors === 1 && p.counts.unchanged === 1, JSON.stringify(p && p.counts));
ok('preview changed NOTHING', Number(v('v_r1').StockQty) === 10 && v('v_r5').StockQty === '' && ledger().length === 0 && !box.__sheets.SyncJobs);
ok('another seller\'s SKU is never matched (Seller A cannot touch B)', p.unmatched.some((u) => u.key === 'B-1'));
ok('the bad number is reported with its line', p.errors[0].line === 7 && /Stock on hand "lots"/.test(p.errors[0].message), JSON.stringify(p.errors));
ok('preview shows before -> after', JSON.stringify(p.updates[0].before) === JSON.stringify({ StockQty: 10, Price: 2, ReorderLevel: null }) &&
  p.updates[0].set.StockQty === 12, JSON.stringify(p.updates[0]));

/* ---------- apply ---------- */
res = box.actionApplyInventoryImport(A, req(rows, { planToken: 'wrong' }));
ok('apply without the previewed token is refused, nothing changes', !res.ok && /preview again/.test(res.error) && Number(v('v_r1').StockQty) === 10);
res = box.actionApplyInventoryImport(A, req(rows, { planToken: p.planToken }));
ok('apply with the previewed token works', res.ok && res.status === 'PARTIAL_SUCCESS' && res.updated === 2, JSON.stringify(res));
ok('stock + price + level written', Number(v('v_r1').StockQty) === 12 && Number(v('v_r1').Price) === 2.5 && Number(v('v_r1').ReorderLevel) === 5);
ok('untracked variety starts tracking at the file\'s count', Number(v('v_r5').StockQty) === 7);
ok('reservations untouched by import (still 4 held)', Number(v('v_r1').ReservedQty) === 4);
const L = ledger();
ok('every stock change is in the ledger as EXTERNAL_SYNC tied to the sync', L.length === 2 && L.every((m) => m.MovementType === 'EXTERNAL_SYNC' && m.ReferenceId === res.syncId), JSON.stringify(L));
const job = box.actionListSyncJobs(A, {}).jobs[0];
ok('sync history records the run', job.syncId === res.syncId && job.read === 6 && job.updated === 2 && job.failed === 1 && job.status === 'PARTIAL_SUCCESS', JSON.stringify(job));
ok('...and Seller B sees none of it', box.actionListSyncJobs(B, {}).jobs.length === 0);

/* ---------- conflicts with open orders ---------- */
res = box.actionPreviewInventoryImport(A, req([['R-1', 'Rice', 2, '', '']]));
ok('a count below held units is a conflict, not a change', res.preview.counts.conflicts === 1 && res.preview.counts.stockChanges === 0 &&
  /4 are held by open orders/.test(res.preview.conflicts[0].message), JSON.stringify(res.preview.conflicts));

/* ---------- matching priority ---------- */
res = box.actionPreviewInventoryImport(A, { type: 'csv', headers: ['Mwakete ID', 'SKU', 'Qty'], rows: [['v_s', 'R-1', 9]],
  mapping: { 'Mwakete ID': 'mwaketeId', 'SKU': 'sku', 'Qty': 'physicalStock' } });
ok('Mwakete ID beats SKU', res.preview.updates[0].name === 'Soap - bar' && res.preview.updates[0].matchedBy === 'mwaketeId');
res = box.actionPreviewInventoryImport(A, { type: 'csv', headers: ['Ext', 'Barcode', 'Qty'], rows: [['EXT-55', 'nope', 1], ['', '9300', 2]],
  mapping: { 'Ext': 'externalId', 'Barcode': 'barcode', 'Qty': 'physicalStock' } });
ok('external ID and barcode both match; the same item twice is an error', res.preview.updates.length === 1 && res.preview.updates[0].matchedBy === 'externalId' &&
  /Same item as line 2/.test(res.preview.errors[0].message), JSON.stringify(res.preview));
res = box.actionPreviewInventoryImport(A, { type: 'csv', headers: ['Name', 'Qty', 'SKU'], rows: [['Rice', 1, 'zzz']],
  mapping: { 'Name': 'productName', 'Qty': 'physicalStock', 'SKU': 'sku' } });
ok('never matched by name alone', res.preview.counts.existing === 0 && res.preview.counts.unmatched === 1);

/* ---------- new products ---------- */
const newRows = [['NEW-9', 'Sugar', 40, 3, ''], ['NEW-10', 'Sugar', 5, 12, ''], ['NEW-11', 'Salt', '', 0, '']];
res = box.actionPreviewInventoryImport(A, req(newRows, { createNew: true }));
ok('creating new products needs a category', !res.ok && /category/.test(res.error));
res = box.actionPreviewInventoryImport(A, req(newRows, { createNew: true, category: 'food' }));
ok('a retailer cannot create Food & Groceries products by import', !res.ok && /wholesaler/.test(res.error));
res = box.actionPreviewInventoryImport(A, req(newRows, { createNew: true, category: 'home' }));
ok('new rows grouped by name; a row with no price is not created', res.preview.counts.newProducts === 1 && res.preview.newProducts[0].varieties === 2 && res.preview.counts.unmatched === 1, JSON.stringify(res.preview));
const before = box.__sheets.Products.objects().length;
res = box.actionApplyInventoryImport(A, req(newRows, { createNew: true, category: 'home', planToken: res.preview.planToken }));
const sugar = box.__sheets.Products.objects().find((x) => x.Name === 'Sugar');
const sugarVars = box.__sheets.Variants.objects().filter((x) => sugar && x.ProductId === sugar.ProductId);
ok('new product created with its varieties, SKUs, prices and stock', res.ok && box.__sheets.Products.objects().length === before + 1 && sugar.OwnerId === 'own_a' &&
  sugar.Category === 'home' && sugarVars.length === 2 && sugarVars.map((x) => x.SKU).sort().join() === 'NEW-10,NEW-9' && Number(sugarVars.find((x) => x.SKU === 'NEW-9').StockQty) === 40);
ok('new stock logged as INITIAL_STOCK', ledger().filter((m) => m.MovementType === 'INITIAL_STOCK').length === 2);

/* ---------- export round trip ---------- */
const ex = box.actionExportInventoryRows(A);
ok('export lists only this seller\'s items, with held and available', ex.ok && ex.rows.length === 5 && !ex.rows.some((r) => r[0] === 'v_b') &&
  JSON.stringify(ex.rows.find((r) => r[0] === 'v_r1').slice(6, 9)) === '[12,4,8]', JSON.stringify(ex.rows));
const edited = ex.rows.map((r) => r.slice());
edited.find((r) => r[0] === 'v_s')[6] = 30;
res = box.actionPreviewInventoryImport(A, { type: 'csv', headers: ex.headers, rows: edited, mapping: ex.mapping });
ok('the exported file imports straight back: only the edited cell changes', res.ok && res.preview.counts.existing === 5 && res.preview.counts.stockChanges === 1 &&
  res.preview.updates.length === 1 && res.preview.updates[0].name === 'Soap - bar', JSON.stringify(res.preview && res.preview.counts));

/* ---------- connectors ---------- */
const cs = box.actionListInventoryConnections(A);
const types = Object.fromEntries(cs.connectors.map((c) => [c.type, c.configured]));
ok('CSV ready; Excel/OneDrive and API honestly not configured', types.csv === true && types.microsoftExcel === false && types.customApi === false, JSON.stringify(types));
res = box.actionPreviewInventoryImport(A, { type: 'microsoftExcel', headers: [], rows: [], mapping });
ok('a not-configured connector refuses with a clear message', !res.ok && /not connected to Mwakete yet/.test(res.error));
res = box.actionSaveInventoryConnection(A, { type: 'csv', name: 'My POS export', mapping });
ok('a mapping can be saved and listed for next time', res.ok && box.actionListInventoryConnections(A).connections[0].mapping['Stock Balance'] === 'physicalStock');
ok('...but not by another seller', box.actionListInventoryConnections(B).connections.length === 0 &&
  !box.actionDeleteInventoryConnection(B, { connectionId: res.connection.connectionId }).ok);

let f = 0;
console.log('\n--- inventory import / export (CSV) ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
