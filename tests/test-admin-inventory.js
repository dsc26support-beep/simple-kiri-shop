/**
 * Admin "Inventory & sync" overview (Admin.gs) on the REAL backend, built
 * from real activity in the harness: a retailer, wholesaler and distributor,
 * stock tracking, a CSV import, a Google Sheet that later loses its share,
 * and an open two-way conflict. Admin-only; no sheet IDs leak.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'],
    ['own_a', 'a', 'Ana Shop', 'active', '', 'a@x.com'], ['own_w', 'w', 'Wholesale Co', 'active', 'wholesaler', 'w@x.com'],
    ['own_d', 'd', 'Dist Co', 'active', 'distributor', 'd@x.com'], ['own_x', 'x', 'Closed', 'closed', '', 'x@x.com'], ['own_admin', 'adm', 'Admin', 'active', '', 'boss@mwakete.com']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'], ['prod_a', 'own_a', 'a', 'Rice', 'active', 'other', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'],
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R-1', 10, 'active', ''], ['v2', 'prod_a', 'own_a', '5kg', 9, 'R-5', 5, 'active', '']]
}, { external: { [SHEET_ID]: { title: 'S', tabs: { Stock: [['Code', 'On hand'], ['R-1', 12], ['R-5', 5]] } } } });
box.__props.MWAKETE_SHARE_EMAIL = 'stock@mwakete.com';
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '' };
const ADMIN = { OwnerId: 'own_admin', Email: 'boss@mwakete.com' };

// Activity: a CSV import, a two-way sheet with a first-sync conflict, then the share is lost.
let r = box.actionPreviewInventoryImport(A, { type: 'csv', headers: ['SKU', 'Qty'], rows: [['R-5', 6]], mapping: { SKU: 'sku', Qty: 'physicalStock' } });
box.actionApplyInventoryImport(A, { type: 'csv', headers: ['SKU', 'Qty'], rows: [['R-5', 6]], mapping: { SKU: 'sku', Qty: 'physicalStock' }, planToken: r.preview.planToken });
const conn = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'Ana stock', mapping: { Code: 'sku', 'On hand': 'physicalStock' }, mode: 'twoWay', settings: { url: SHEET_ID, sheetName: 'Stock', autoSync: true } });
r = box.actionPreviewInventoryImport(A, { connectionId: conn.connection.connectionId });
box.actionApplyInventoryImport(A, { connectionId: conn.connection.connectionId, planToken: r.preview.planToken });
delete box.__external[SHEET_ID];
box.actionSyncNow(A, { connectionId: conn.connection.connectionId });

const res = box.actionAdminInventoryOverview(ADMIN);
const o = res.overview;
ok('admin only', !box.actionAdminInventoryOverview(A).ok && res.ok, JSON.stringify(box.actionAdminInventoryOverview(A)));
ok('business types (closed stores not counted)', o.businessTypes.retailer === 2 && o.businessTypes.wholesaler === 1 && o.businessTypes.distributor === 1, JSON.stringify(o.businessTypes));
ok('stores tracking stock / with a connection', o.trackingStock === 1 && o.connectedBusinesses === 1);
ok('connections by type, and the failing one', o.connections.total === 1 && o.connections.byType.googleSheets === 1 && o.connections.failing === 1, JSON.stringify(o.connections));
ok('open conflicts counted (both items differ on the first two-way sync)', o.openConflicts === 2, o.openConflicts);
ok('items synced counted', o.productsSynced >= 1);
ok('last successful sync is the CSV / first sheet run', !!o.lastSuccessfulSync);
ok('failing connection names the store and gives the plain error', o.failingConnections[0].store === 'Ana Shop' && /share/i.test(o.failingConnections[0].error), JSON.stringify(o.failingConnections));
ok('recent failures listed', o.recentFailures.length === 1 && o.recentFailures[0].type === 'googleSheets');
ok('no sheet ID anywhere in the overview', !JSON.stringify(o).includes(SHEET_ID));

let f = 0;
console.log('\n--- admin inventory & sync overview ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
