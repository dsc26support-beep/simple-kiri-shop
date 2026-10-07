// Import & Sync page end to end: the browser page talks to the REAL backend
// (apps-script/*.gs in the in-memory harness) through the API route, so a
// CSV goes file -> parse -> auto-matched columns -> server preview -> apply
// -> stock + ledger + history, exactly as in production but on a fake sheet.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = 'http://127.0.0.1:8099';

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'];
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'bong', 'Bong', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'], ['prod_r', 'own_a', 'bong', 'Rice', 'active', 'other', 'product']],
  Variants: [vHead, ['v1', 'prod_r', 'own_a', '1kg', 2, 'R-1', 10, 'active', 4], ['v2', 'prod_r', 'own_a', '5kg', 9, 'R-5', 5, 'active', 4]]
});
const OWNER = { OwnerId: 'own_a', StoreSlug: 'bong', StoreType: '' };
const ACTIONS = { listInventoryConnections: 'actionListInventoryConnections', previewInventoryImport: 'actionPreviewInventoryImport',
  applyInventoryImport: 'actionApplyInventoryImport', saveInventoryConnection: 'actionSaveInventoryConnection',
  listSyncJobs: 'actionListSyncJobs', exportInventoryRows: 'actionExportInventoryRows' };
const CSV = '﻿Item Code;Description;Stock Balance;Selling Price;Minimum Stock;Reorder Qty\r\n' +
  'R-1;"Rice, white";12;2.50;5;20\r\n' +
  'R-5;Rice 5kg;2;9;;\r\n' +
  'ZZ-1;"Sugar ""fine""";40;3;;\r\n\r\n';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const calls = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(a);
    let res;
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'own_a', storeName: 'Bong', storeSlug: 'bong', storeType: 'retailer' } };
    else if (ACTIONS[a]) { const b = JSON.parse(JSON.stringify(body)); delete b.action; delete b.token; res = JSON.parse(JSON.stringify(box[ACTIONS[a]](OWNER, b))); }
    else res = { ok: true };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/inventory-sync.html', { waitUntil: 'load' });
  await page.waitForSelector('.sync-source', { timeout: 6000 });

  const sources = await page.$$eval('.sync-source', (b) => b.map((x) => [x.dataset.source, x.classList.contains('is-off')]));
  ok('CSV is ready; Google Sheets / Excel / other honestly "not connected yet"', JSON.stringify(sources) === '[["csv",false],["googleSheets",true],["microsoftExcel",true],["customApi",true]]', JSON.stringify(sources));
  await page.click('.sync-source[data-source="microsoftExcel"]');
  ok('tapping a not-ready source explains the CSV way instead', /CSV/.test(await page.textContent('#sync-status')) && await page.isHidden('#sync-step-map'));
  await page.click('.sync-source[data-source="csv"]');
  ok('CSV opens the file step', await page.isVisible('#sync-step-map'));

  await page.setInputFiles('#sync-file', { name: 'till.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await page.waitForSelector('#sync-mapping .sync-map-row', { timeout: 4000 });
  ok('file read: BOM, semicolons, quotes and blank lines handled', /till\.csv: 3 item rows, 6 columns/.test(await page.textContent('#sync-file-info')), await page.textContent('#sync-file-info'));
  const guessed = await page.$$eval('#sync-mapping select', (s) => s.map((x) => x.dataset.header + '=' + x.value));
  ok('columns auto-matched (Item Code=SKU, Stock Balance=stock, Minimum Stock=low level, Reorder Qty=reorder)',
    guessed.join('|') === 'Item Code=sku|Description=productName|Stock Balance=physicalStock|Selling Price=price|Minimum Stock=reorderLevel|Reorder Qty=reorderQty', guessed.join('|'));
  ok('quoted cells with commas / "" shown correctly in the sample', /Rice, white/.test(await page.textContent('#sync-mapping')) && /Sugar "fine"/.test(await page.textContent('#sync-mapping')));

  await page.fill('#sync-save-name', 'My till');
  await page.click('#sync-preview-btn');
  await page.waitForSelector('#sync-step-preview:not(.hidden)', { timeout: 5000 });
  const tiles = await page.$$eval('#sync-preview .inv-tile', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('preview tiles from the real dry run', tiles.join('|') === '3rows read|2matched items|1stock changes|1price changes|0new products|1not matched|1conflicts|0errors', tiles.join('|'));
  const previewText = await page.textContent('#sync-preview');
  ok('changes list shows before -> after', /Rice - 1kg: stock 10 → 12, price 2 → 2.5, low-stock level blank → 5, reorder qty blank → 20/.test(previewText), previewText.slice(0, 300));
  ok('conflict explained: file says 2, 4 held by orders, left at 5', /File says 2 but 4 are held by open orders on Mwakete\. Stock left at 5/.test(previewText));
  ok('preview changed nothing yet', Number(box.__sheets.Variants.objects()[0].StockQty) === 10);

  await page.click('#sync-apply-btn');
  await page.waitForSelector('#sync-step-done:not(.hidden)', { timeout: 5000 });
  ok('apply reports what happened', /Updated 1 item\. Some rows were skipped/.test(await page.textContent('#sync-done-text')), await page.textContent('#sync-done-text'));
  const v1 = box.__sheets.Variants.objects()[0];
  ok('backend really updated: stock 12, price 2.5, low level 5', Number(v1.StockQty) === 12 && Number(v1.Price) === 2.5 && Number(v1.ReorderLevel) === 5);
  ok('ledger has the EXTERNAL_SYNC row', box.__sheets.StockMovements.objects().some((m) => m.MovementType === 'EXTERNAL_SYNC' && m.VariantId === 'v1'));
  ok('matching saved as "My till"', box.actionListInventoryConnections(OWNER).connections.some((c) => c.name === 'My till'));
  await page.waitForFunction(() => /CSV import/.test(document.getElementById('sync-history').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('history shows the run with skipped rows', /Done, some rows skipped/.test(await page.textContent('#sync-history')));

  // Second import of the same file: the saved matching is offered.
  await page.click('#sync-again-btn');
  await page.setInputFiles('#sync-file', { name: 'till.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await page.waitForSelector('#sync-mapping .sync-map-row', { timeout: 4000 });
  ok('next time, the saved matching is used', /Using your saved matching "My till"/.test(await page.textContent('#sync-mapping')));

  // Export download round-trips the columns.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sync-export-btn')]);
  const csvOut = require('fs').readFileSync(await dl.path(), 'utf8');
  ok('export downloads a CSV with the importer\'s columns', /^﻿Mwakete ID,SKU,Barcode,External ID,Product,Variety,Stock on hand,Held by orders,Available/.test(csvOut) && /v1,R-1,,,Rice,1kg,12,4,8/.test(csvOut), csvOut.slice(0, 200));
  ok('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: true }).catch(() => {});

  await browser.close();
  let f = 0; console.log('\n--- Import & Sync page (real backend in harness) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
