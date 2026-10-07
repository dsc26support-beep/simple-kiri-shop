/**
 * Google Sheets sync (InventorySync.gs) on the REAL backend with a seller's
 * spreadsheet faked in the harness: link setup, the three modes (sheet ->
 * Mwakete, Mwakete -> sheet, two-way), conflict detection and resolution,
 * a lost share, Sync now and the hourly schedule. Nothing is silently
 * overwritten and every stock change is in the ledger.
 */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit#gid=0';
const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'];
function fresh() {
  const box = makeBox({
    Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A', 'active', ''], ['own_b', 'b', 'B', 'active', '']],
    Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'], ['prod_r', 'own_a', 'a', 'Rice', 'active', 'other', 'product']],
    Variants: [vHead, ['v1', 'prod_r', 'own_a', '1kg', 2, 'R-1', 10, 'active', ''], ['v2', 'prod_r', 'own_a', '5kg', 9, 'R-5', 5, 'active', 3]]
  }, { external: { [SHEET_ID]: { title: 'Shop stock', tabs: {
    Notes: [['ignore me']],
    Stock: [['My shop - stock list', '', ''], ['Code', 'Item', 'On hand'], ['R-1', 'Rice 1kg', 10], ['R-5', 'Rice 5kg', 5], ['Z-9', 'Other', 1]]
  } } } });
  box.__props.MWAKETE_SHARE_EMAIL = 'stock@mwakete.com';
  return box;
}
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreType: '' };
const mapping = { Code: 'sku', 'On hand': 'physicalStock' };
let box = fresh();
const ext = () => box.__external[SHEET_ID].getSheetByName('Stock');
const cell = (r, c) => ext().grid[r - 1][c - 1];
const v = (id) => box.__sheets.Variants.objects().find((x) => x.VariantId === id);
const ledger = () => (box.__sheets.StockMovements ? box.__sheets.StockMovements.objects() : []);
const settings = { url: URL, sheetName: 'Stock', headerRow: 2, autoSync: true };

/* ---------- setup ---------- */
let res = box.actionTestSheetConnection(A, { settings: { url: 'https://docs.google.com/spreadsheets/d/1ZZZZZZZZZZZZZZZZZZZZZZZZZZZ/edit' } });
ok('a sheet not shared yet: clear instructions with the share address, nothing changed', res.ok && res.connected === false &&
  /Share and add stock@mwakete\.com/.test(res.error) && /has not been changed/.test(res.error), res.error);
ok('a non-sheets link is explained', /doesn't look like a Google Sheets link/.test(box.actionTestSheetConnection(A, { settings: { url: 'hello' } }).error));
res = box.actionTestSheetConnection(A, { settings: { url: URL, sheetName: 'Stock', headerRow: 2 } });
ok('a shared sheet opens: tabs, columns (header row 2), sample, row count', res.connected && res.title === 'Shop stock' && res.tabs.join() === 'Notes,Stock' &&
  res.headers.join() === 'Code,Item,On hand' && res.rowCount === 3 && res.sample[0][0] === 'R-1', JSON.stringify(res));
box.__props.MWAKETE_SHARE_EMAIL = '';
ok('without MWAKETE_SHARE_EMAIL, Google Sheets is honestly "not connected yet"',
  box.actionListInventoryConnections(A).connectors.find((c) => c.type === 'googleSheets').configured === false && !box.actionTestSheetConnection(A, { settings }).ok);
box.__props.MWAKETE_SHARE_EMAIL = 'stock@mwakete.com';

/* ---------- mode A: sheet -> Mwakete ---------- */
res = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'Shop stock', mapping, mode: 'import', settings });
ok('connection saved with only the sheet ID (no secrets)', res.ok && res.connection.settings.spreadsheetId === SHEET_ID && res.connection.settings.sheetName === 'Stock', JSON.stringify(res));
const connId = res.connection.connectionId;
ok('Sync now refuses until the first sync has been previewed', /Preview this source once/.test(box.actionSyncNow(A, { connectionId: connId }).error));
ext().grid[2][2] = 14; // seller edits their sheet: R-1 now 14
res = box.actionPreviewInventoryImport(A, { connectionId: connId });
ok('preview reads the sheet: 1 stock change, Z-9 unmatched (line 5)', res.ok && res.preview.counts.stockChanges === 1 && res.preview.unmatched[0].line === 5, JSON.stringify(res.preview && res.preview.counts));
res = box.actionApplyInventoryImport(A, { connectionId: connId, planToken: res.preview.planToken });
ok('applied: Mwakete 1kg 10 -> 14, ledger EXTERNAL_SYNC from googleSheets', res.ok && Number(v('v1').StockQty) === 14 &&
  ledger().slice(-1)[0].Source === 'googleSheets', JSON.stringify(res));
ext().grid[3][2] = 8;
res = box.actionSyncNow(A, { connectionId: connId });
ok('Sync now (after the first preview) brings in the next edit', res.ok && Number(v('v2').StockQty) === 8);
ext().grid[3][2] = 1;
res = box.actionSyncNow(A, { connectionId: connId });
ok('a sheet count below held units is skipped and explained, not applied', res.ok && Number(v('v2').StockQty) === 8 && res.counts.conflicts === 1);

/* ---------- mode B: Mwakete -> sheet ---------- */
box = fresh();
res = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'S', mapping, mode: 'export', settings });
let id = res.connection.connectionId;
box.actionReceiveStock(A, { variantId: 'v1', quantity: 5 }); // Mwakete 1kg: 10 -> 15
res = box.actionPreviewInventoryImport(A, { connectionId: id });
ok('Mwakete-master preview: 1 write planned, nothing imported', res.preview.counts.writes === 1 && res.preview.writes[0].value === 15 && res.preview.writes[0].before === 10 && res.preview.counts.stockChanges === 0);
res = box.actionApplyInventoryImport(A, { connectionId: id, planToken: res.preview.planToken });
ok('applied: the sheet cell now says 15; other cells untouched', res.ok && res.written === 1 && cell(3, 3) === 15 && cell(4, 3) === 5 && cell(3, 2) === 'Rice 1kg');

/* ---------- mode C: two-way ---------- */
box = fresh();
res = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'S', mapping, mode: 'twoWay', settings });
id = res.connection.connectionId;
ext().grid[2][2] = 12; // sheet differs from Mwakete (10) on the very first sync
res = box.actionPreviewInventoryImport(A, { connectionId: id });
ok('first two-way sync: a difference is a conflict to decide, never a guess', res.preview.counts.syncConflicts === 1 && /First sync: your sheet says 12, Mwakete says 10/.test(res.preview.syncConflicts[0].message));
res = box.actionApplyInventoryImport(A, { connectionId: id, planToken: res.preview.planToken });
ok('applied with a conflict: status CONFLICT, neither side touched', res.status === 'CONFLICT' && Number(v('v1').StockQty) === 10 && cell(3, 3) === 12);
let open = box.actionListSyncConflicts(A).conflicts;
ok('the conflict is listed with both numbers', open.length === 1 && open[0].external === 12 && open[0].mwakete === 10 && open[0].name === 'Rice - 1kg');
ok('Seller B cannot see or resolve it', box.actionListSyncConflicts(B).conflicts.length === 0 && !box.actionResolveSyncConflict(B, { conflictId: open[0].conflictId, choice: 'external' }).ok);
res = box.actionResolveSyncConflict(A, { conflictId: open[0].conflictId, choice: 'external' });
ok('"Use the sheet\'s number" -> Mwakete becomes 12 (ledger-backed)', res.ok && Number(v('v1').StockQty) === 12 && ledger().slice(-1)[0].MovementType === 'EXTERNAL_SYNC');
ok('...and the conflict is closed', box.actionListSyncConflicts(A).conflicts.length === 0);
// Now agreed at 12 (1kg) and 5 (5kg). Change one side only, each way.
box.actionAdjustStock(A, { variantId: 'v1', reason: 'damaged', quantity: 2 });   // Mwakete 1kg 12 -> 10
ext().grid[3][2] = 7;                                                                // sheet 5kg 5 -> 7
res = box.actionSyncNow(A, { connectionId: id });
ok('two-way: a Mwakete-only change is written to the sheet', res.ok && cell(3, 3) === 10, JSON.stringify(res));
ok('two-way: a sheet-only change comes into Mwakete', Number(v('v2').StockQty) === 7);
// Both change the same item -> conflict, nothing overwritten.
box.actionReceiveStock(A, { variantId: 'v1', quantity: 1 });  // Mwakete 1kg 10 -> 11
ext().grid[2][2] = 9;                                           // sheet 1kg 10 -> 9
res = box.actionSyncNow(A, { connectionId: id });
open = box.actionListSyncConflicts(A).conflicts;
ok('changed in both places -> conflict, neither overwritten', res.status === 'CONFLICT' && Number(v('v1').StockQty) === 11 && cell(3, 3) === 9 &&
  open.length === 1 && open[0].external === 9 && open[0].mwakete === 11, JSON.stringify(open));
res = box.actionSyncNow(A, { connectionId: id });
ok('syncing again does not duplicate the same open conflict', box.actionListSyncConflicts(A).conflicts.length === 1);
res = box.actionResolveSyncConflict(A, { conflictId: open[0].conflictId, choice: 'mwakete' });
ok('"Use Mwakete\'s number" -> the sheet becomes 11', res.ok && cell(3, 3) === 11 && Number(v('v1').StockQty) === 11);
// Keep existing: set aside, not re-raised while the numbers stay the same.
box.actionReceiveStock(A, { variantId: 'v1', quantity: 1 }); ext().grid[2][2] = 3;
box.actionSyncNow(A, { connectionId: id });
open = box.actionListSyncConflicts(A).conflicts;
box.actionResolveSyncConflict(A, { conflictId: open[0].conflictId, choice: 'keep' });
box.actionSyncNow(A, { connectionId: id });
ok('"Keep as is" sets it aside; the same numbers are not raised again', box.actionListSyncConflicts(A).conflicts.length === 0 && Number(v('v1').StockQty) === 12 && cell(3, 3) === 3);

/* ---------- failures + schedule ---------- */
delete box.__external[SHEET_ID]; // seller removed the share
res = box.actionSyncNow(A, { connectionId: id });
const lastJob = box.actionListSyncJobs(A, {}).jobs[0];
ok('lost access: friendly error, stock unchanged, FAILED in history, error on the source', !res.ok && /has not been changed/.test(res.error) &&
  Number(v('v1').StockQty) === 12 && lastJob.status === 'FAILED' && /share/i.test(box.actionListInventoryConnections(A).connections[0].lastError), JSON.stringify(lastJob));
box = fresh();
res = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'S', mapping, mode: 'import', settings });
id = res.connection.connectionId;
let pv = box.actionPreviewInventoryImport(A, { connectionId: id });
box.actionApplyInventoryImport(A, { connectionId: id, planToken: pv.preview.planToken });
ext().grid[2][2] = 33;
ok('the hourly sweep runs auto-sync sources', box.runScheduledInventorySyncs() === 1 && Number(v('v1').StockQty) === 33);
ok('the schedule never runs a source before its first previewed sync', (() => {
  const b2 = fresh();
  b2.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'S', mapping, mode: 'import', settings });
  return b2.runScheduledInventorySyncs() === 0;
})());
ok('next sync time is shown (last + 1 hour)', !!box.actionListInventoryConnections(A).connections[0].nextSyncAt);
ok('a read-only connector cannot be set to write back', !box.actionSaveInventoryConnection(A, { type: 'csv', name: 'x', mapping, mode: 'twoWay' }).ok);

let f = 0;
console.log('\n--- Google Sheets sync: modes, conflicts, schedule ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
